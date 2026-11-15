'use strict';
/**
 * footnotes.cjs — Markdown 脚注的唯一纯解析/索引层（无 DOM、无 CM6、无第三方依赖）。
 *
 * 这是编辑端（CM6 投影/跳转）与导出端（PDF/HTML）共用的同一份语法真源：
 * 谁能成为脚注、偏移在哪、编号是多少、DOM id 是什么，只在这里算一次。
 *
 * 契约（主控 2026-11-13 定版；2026-11-14 literal-foot 增补可选第二参 codeInput）：
 *   collectFootnotes(markdown, codeInput?) -> {
 *     refs:  [{ from, to, label, number, refId, noteId, resolved, occurrence, ordinal }],
 *     notes: [{ label, number, noteId, from, to, text, refs: [...],
 *               markerFrom, markerTo, textFrom, textTo, referenced }],
 *   }
 *
 * 偏移口径：UTF-16 code unit，0-based，end-exclusive，与 CM6 的 doc 偏移逐字一致。
 *   · ref.from/to 包住整个引用标记 `[^label]`；
 *   · note.from/to 包住整个定义（`[^label]:` + 正文 + 合法续行），不含最后一行行尾换行；
 *   · note.markerFrom..markerTo 是 `[^label]:`；note.textFrom..textTo 是正文（不含标记后空白）。
 *
 * 编号口径：按**第一次被引用**的顺序 1..N；重复引用共用同一编号。只有定义、从未被引用的
 * 脚注排在所有被引用脚注之后继续编号（referenced=false）。notes 数组按编号升序。
 *
 * DOM id：只用 ASCII 前缀 + 纯数字，绝不拼接用户标签（中文/重复/特殊字符都不会进 id）：
 *   noteId = `mp-fn-note-<number>`
 *   refId  = `mp-fn-ref-<number>-<occurrence>`；未解析引用 = `mp-fn-ref-u-<ordinal>`
 * 同一份文档的解析结果确定（同输入同 id），编辑后按当前编号重新生成。
 *
 * 隔离规则（与编辑端既有代码/数学隔离同口径）：
 *   · 围栏代码块（``` / ~~~，0-3 空格缩进）整块不识别；
 *   · 行内代码（长度匹配的反引号 run）、行内/块公式（$…$、$$…$$、多行 $$ 块）不识别；
 *   · 跨行 InlineCode 与 4 空格/Tab 缩进 CodeBlock 由调用方传入的 parser 区间补齐（见下）；
 *   · 反斜杠转义（\[^x]）不识别；HTML 注释与普通链接目标不识别；
 *   · 定义必须是行首（0-3 空格）的 `[^label]:`，代码/数学/链接目标里的不算；
 *   · 未解析的引用保持原文，不生成活链接（resolved=false, noteId=null, number=0）。
 *
 * codeInput（可选，第二参）—— 本模块**不导入**任何 Markdown 解析器，绝不自搓第二份：
 *   · 传 @lezer/markdown 的 parser 树（Tree，含 InlineCode / CodeBlock / FencedCode /
 *     CommentBlock 节点）；FencedCode 带容器隐式闭合/反缩进/CRLF 语义，CommentBlock 带
 *     closed（节点区间内能否找到 `-->`）。这是生产围栏/块注释的首选真源。
 *   · 或传 { parser } / { tree } / { code: [...] }（analyzePublic 的返回值）；
 *   · 或直接传 [{ from, to, kind }] 数组。kind 为 'CodeBlock' 时区间会补齐到整行
 *     （parser 的 CodeBlock 只含内容，不含 4 空格缩进；定义判定看 line.from，必须补）。
 *   · 或传 { code?, comments?, fences?, authoritative? }：
 *       comments —— analyzePublic(source).comments 的真 HTML 注释区间
 *                   [{ from, to, block, closed }]；closed:false 表示未闭合块注释。
 *       fences   —— 兼容入口：[{ from, to, closeFrom, startLine, endLine }] 围栏块。
 *       authoritative:true —— 表示 code/comments 是完整真源：本模块跳过旧围栏自扫
 *                   （旧自扫不认注释/容器/CRLF，会吞到 EOF，2→3 修的就是这条）。
 *     注释**不进入数学 static**：数学扫描先算，注释只进行内 skip 与最终 opaque 合并，
 *     避免一个注释行把 `$$` 块截断后又重新开到 EOF。
 *   没有 codeInput 时仍是原来的 standalone 语义；有 codeInput 时只在文档含 "[^" 后才消费它。
 *   本模块内部只在**有序、互不重叠**的区间表上调用 rangeAt/touches：多阶段扫描各维护一张
 *   单调表，查询时逐表二分，不再把未排序区间喂给 rangeAt（旧实现的隐患）。
 *
 * 增量：编辑器不应在每次按键都调用本函数。编辑端只在该层之上做“结构字符/结构区间”闸门，
 * 普通打字只映射既有区间；本模块保持纯函数，便于 Node 单测与 PDF 端直接 require。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MarkPilotFootnotes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_LABEL_LENGTH = 512;
  const STRUCTURAL_CHARS = /[\[\]\^:`$\\~()<>\n\r]/;

  function isEscaped(text, index) {
    let count = 0;
    for (let i = index - 1; i >= 0 && text.charCodeAt(i) === 92; i--) count++;
    return (count & 1) === 1;
  }

  /** 行表：to 不含行尾；eol 记录原文是 \n、\r\n 还是 EOF。 */
  function splitLines(text) {
    const lines = [];
    let from = 0;
    for (;;) {
      const nl = text.indexOf('\n', from);
      if (nl === -1) {
        let to = text.length;
        if (to > from && text.charCodeAt(to - 1) === 13) to--;
        lines.push({ from, to, text: text.slice(from, to), eol: 0 });
        break;
      }
      let to = nl;
      if (to > from && text.charCodeAt(to - 1) === 13) to--;
      lines.push({ from, to, text: text.slice(from, to), eol: nl + 1 - to });
      from = nl + 1;
      if (from === text.length) {
        lines.push({ from, to: from, text: '', eol: 0 });
        break;
      }
    }
    return lines;
  }

  function pushRange(ranges, from, to) {
    if (!(to > from)) return;
    ranges.push({ from, to });
  }

  function mergeRanges(ranges) {
    if (!ranges.length) return ranges;
    ranges.sort((a, b) => a.from - b.from || a.to - b.to);
    const out = [ranges[0]];
    for (let i = 1; i < ranges.length; i++) {
      const cur = ranges[i], last = out[out.length - 1];
      if (cur.from <= last.to) last.to = Math.max(last.to, cur.to);
      else out.push(cur);
    }
    return out;
  }

  function rangeAt(ranges, pos) {
    let low = 0, high = ranges.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const r = ranges[mid];
      if (pos < r.from) high = mid - 1;
      else if (pos >= r.to) low = mid + 1;
      else return r;
    }
    return null;
  }

  function touches(ranges, from, to) {
    // ranges are sorted and non-overlapping
    let low = 0, high = ranges.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const r = ranges[mid];
      if (to <= r.from) high = mid - 1;
      else if (from >= r.to) low = mid + 1;
      else return true;
    }
    return false;
  }

  /* 多张表各自有序 ⇒ 逐表二分。任何一张表在增删时都必须保持 from 升序、互不重叠；
     这样 rangeAt/touches 的二分前提在扫描全过程成立（旧实现把后扫描到的早期区间
     push 到既有后期区间之后，二进制查找会漏命中）。 */
  function rangeAtAny(lists, pos) {
    for (let i = 0; i < lists.length; i++) {
      const hit = rangeAt(lists[i], pos);
      if (hit) return hit;
    }
    return null;
  }

  function touchesAny(lists, from, to) {
    for (let i = 0; i < lists.length; i++) if (touches(lists[i], from, to)) return true;
    return false;
  }

  /** 行号二分；pos 落在换行间隙时归到前一行（parser 的 CodeBlock.to 可能停在行尾）。 */
  function lineIndexOf(lines, pos) {
    if (!lines.length) return -1;
    let low = 0, high = lines.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const line = lines[mid];
      if (pos < line.from) high = mid - 1;
      else if (pos > line.to) low = mid + 1;
      else return mid;
    }
    return Math.max(0, Math.min(lines.length - 1, low - 1));
  }

  /** 从调用方已有的 @lezer/markdown Tree 取 InlineCode / CodeBlock / FencedCode /
   *  CommentBlock 节点区间。FencedCode/CommentBlock 带 closed 元数据：
   *   · FencedCode：最后一个 CodeMark 与第一个不同位置 ⇒ 有闭合围栏（空围栏只有一个）；
   *   · CommentBlock：节点区间内找到 `-->` ⇒ 闭合；否则到节点末尾（文末或容器末）。 */
  function treeCodeRanges(tree, text) {
    const ranges = [];
    tree.iterate({
      enter(ref) {
        const name = ref.name;
        if (name === 'FencedCode') {
          let first = null, last = null;
          for (let child = ref.node.firstChild; child; child = child.nextSibling) {
            if (child.name !== 'CodeMark') continue;
            if (!first) first = child;
            last = child;
          }
          ranges.push({ from: ref.from, to: ref.to, kind: name, closed: !!(first && last && last.from > first.from) });
          return false;
        }
        if (name === 'CommentBlock') {
          const close = text.indexOf('-->', ref.from + 4);
          const closed = close >= 0 && close + 3 <= ref.to;
          ranges.push({ from: ref.from, to: closed ? close + 3 : ref.to, kind: name, closed });
          return false;
        }
        if (name !== 'InlineCode' && name !== 'CodeBlock') return undefined;
        ranges.push({ from: ref.from, to: ref.to, kind: name });
        return false;
      },
    });
    return ranges;
  }

  /** 兼容 Tree / {tree} / {parser} / {code:[...]} / 区间数组；不认识的形态按空处理。 */
  function extractCodeRanges(input, text) {
    if (!input) return [];
    if (Array.isArray(input)) return input;
    if (Array.isArray(input.code)) return input.code;
    if (typeof input.parse === 'function') return treeCodeRanges(input.parse(text), text);
    if (typeof input.iterate === 'function') return treeCodeRanges(input, text);
    if (input.tree) return extractCodeRanges(input.tree, text);
    if (input.parser) return extractCodeRanges(input.parser, text);
    return [];
  }

  /**
   * 把已提取的节点区间归一成有序 opaque 表。CodeBlock 的 parser 节点只含缩进后的内容，
   * 而定义判定看 line.from ⇒ 补齐到整行；InlineCode 保持 parser 原区间（跨行也准确）。
   * FencedCode 扩到首行行首/末行行尾；CommentBlock 只扩起点到行首，终点停在 `-->` 末
   * （不能扩到行尾，否则 `<!--x-->tail` 的 tail 会被误吞）。
   *
   * 【定义续行区别】脚注定义 `[^a]: note` 在 CommonMark 里是 LinkReference，紧随的
   * 4 空格行会被 parser 当成 IndentedCode/CodeBlock；但在脚注文法里它是定义续行。
   * 这类 CodeBlock 必须从 opaque 中剔除，否则续行会被当代码：isFootnoteOpaque 误报、
   * 定义正文/续行渲染分叉。判据只在 parser CodeBlock 的上一行链上找脚注定义标记。
   */
  function parserOpaqueRanges(raw, text, lines, details = null) {
    if (!raw.length) return [];
    const ranges = [];
    const tailEnd = text.replace(/[\r\n]+$/, '').length;
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      if (!item || !Number.isInteger(item.from) || !Number.isInteger(item.to)) continue;
      let from = Math.max(0, Math.min(text.length, item.from));
      let to = Math.max(0, Math.min(text.length, item.to));
      if (to <= from) continue;
      if (item.kind === 'FencedCode' || item.kind === 'CommentBlock') {
        const first = lineIndexOf(lines, from);
        if (first >= 0) from = lines[first].from;
        if (item.kind === 'FencedCode') {
          const last = lineIndexOf(lines, to - 1);
          if (last >= 0) to = lines[last].to;
        }
        if (details) {
          if (item.kind === 'FencedCode' && item.closed === false && to >= tailEnd) details.unclosedFence = true;
          if (item.kind === 'CommentBlock' && item.closed === false && to >= tailEnd) details.unclosedComment = true;
        }
      } else if (item.kind === 'CodeBlock') {
        const first = lineIndexOf(lines, from);
        const last = lineIndexOf(lines, to - 1);
        if (first >= 0 && isFootnoteContinuationBlock(lines, first)) continue;
        if (first >= 0) from = lines[first].from;
        if (last >= 0) to = lines[last].to;
      }
      pushRange(ranges, from, to);
    }
    return mergeRanges(ranges);
  }

  /** CodeBlock 的第一行是否其实落在某条脚注定义的续行链上。 */
  function isFootnoteContinuationBlock(lines, firstLineIndex) {
    if (firstLineIndex < 0 || firstLineIndex >= lines.length) return false;
    // 第一行本身必须是定义续行（4 空格/Tab 起手）；引用区里的 `>     code`
    // 不是定义续行，不能被误剔除。
    if (!isContinuation(lines[firstLineIndex].text)) return false;
    let n = firstLineIndex - 1;
    while (n >= 0) {
      const text = lines[n].text;
      if (text.trim() === '' || isContinuation(text)) { n--; continue; }
      break;
    }
    return n >= 0 && /^( {0,3})\[\^[^\]\r\n]+\]:/.test(lines[n].text);
  }

  function fenceAt(content) {
    const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(content || '');
    if (!m) return null;
    if (m[2][0] === '`' && m[3].includes('`')) return null;
    return { char: m[2][0], len: m[2].length, info: m[3].trim() };
  }

  /** 引用前缀（`> `、`> > `…）的长度；围栏/公式可能写在引用里。 */
  function quoteOffset(text) {
    let off = 0;
    for (;;) {
      const m = /^ {0,3}>[ \t]?/.exec(text.slice(off));
      if (!m) return off;
      off += m[0].length;
    }
  }

  function frontMatterEnd(text) {
    const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    return m ? m[0].length : 0;
  }

  /**
   * 多行 $$ 块：行首（0-3 空格，可带引用前缀）$$，本行没有闭合的 $$，到含 $$ 的行收尾。
   * staticRanges 必须已排序；本函数只把新数学区间按行序追加到 mathRanges（同样单调），
   * 查询时对两张表分别二分。
   */
  function scanDisplayMathBlocks(lines, staticRanges, mathRanges, details) {
    const lists = [staticRanges, mathRanges];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (touchesAny(lists, line.from, line.to)) continue;
      const q = quoteOffset(line.text);
      const body = line.text.slice(q);
      const m = /^( {0,3})\$\$/.exec(body);
      if (!m) continue;
      const after = body.slice(m[0].length);
      let closeOnSame = -1;
      for (let k = 0; k < after.length; k++) {
        if (after[k] === '\\') { k++; continue; }
        if (after.startsWith('$$', k)) { closeOnSame = k; break; }
      }
      if (closeOnSame !== -1) continue;
      let closed = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const row = lines[j];
        if (touchesAny(lists, row.from, row.to)) { closed = j; break; }
        const rq = quoteOffset(row.text);
        let found = -1;
        for (let k = rq; k + 1 < row.text.length; k++) {
          if (row.text[k] === '\\') { k++; continue; }
          if (row.text.startsWith('$$', k)) { found = k; break; }
        }
        if (found !== -1) { closed = j; break; }
      }
      const to = closed === -1 ? (lines.length ? lines[lines.length - 1].to : line.to) : lines[closed].to;
      pushRange(mathRanges, line.from, to);
      if (closed === -1) {
        if (details) details.unclosedMath = true;
        break;
      }
      i = closed;
    }
  }

  /**
   * 行内隔离扫描（代码/公式/链接目标/HTML 注释与标签）。
   * staticRanges/mathRanges 已排序；本函数从左到右扫描，新区间天然按 from 升序追加到
   * inlineRanges，因此三张表始终各自有序，rangeAtAny 的二分前提成立。
   * comments 为**权威注释区间**（analyzePublic/parser CommentBlock）时：
   *   · 注释区间进入 skip 列表，逐字符跳过；
   *   · 关闭旧 `<!-- … -->` 配对分支 —— 行内未闭合 `<!--` 是字面量，不能拿后面的
   *     `-->` 去配对（否则会把注释外的正文/定义整段吞掉，R7）。
   * comments=null 表示没有权威注释（standalone），保留旧配对作兼容。
   */
  function scanInlineOpaque(text, staticRanges, mathRanges, inlineRanges, comments = null) {
    const len = text.length;
    const lists = comments ? [staticRanges, mathRanges, inlineRanges, comments] : [staticRanges, mathRanges, inlineRanges];
    const add = (from, to) => pushRange(inlineRanges, from, to);
    let i = 0;
    while (i < len) {
      const hit = rangeAtAny(lists, i);
      if (hit) { i = hit.to; continue; }
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') {
        let n = 1;
        while (i + n < len && text[i + n] === '`') n++;
        let j = i + n;
        let closed = -1;
        while (j < len) {
          if (text[j] === '`') {
            let m = 1;
            while (j + m < len && text[j + m] === '`') m++;
            if (m === n) { closed = j; break; }
            j += m;
            continue;
          }
          if (text[j] === '\n' || text[j] === '\r') break;
          j++;
        }
        if (closed !== -1) { add(i, closed + n); i = closed + n; }
        else i += n;
        continue;
      }
      if (ch === '$') {
        const width = text[i + 1] === '$' ? 2 : 1;
        let j = i + width;
        let closed = -1;
        while (j < len) {
          const c = text[j];
          if (c === '\n' || c === '\r') break;
          if (c === '\\') { j += 2; continue; }
          if (c === '$') {
            if (width === 2) {
              if (text[j + 1] === '$') { closed = j; break; }
              j++;
              continue;
            }
            if (text[j + 1] !== '$') { closed = j; break; }
            // 单个 $ 遇到 $$：引擎把第一个 $ 当闭合；保留同款语义。
            closed = j;
            break;
          }
          j++;
        }
        if (closed !== -1 && text.slice(i + width, closed).trim()) {
          add(i, closed + width);
          i = closed + width;
          continue;
        }
        i += width;
        continue;
      }
      if (ch === '<') {
        if (comments === null && text.startsWith('<!--', i)) {
          const end = text.indexOf('-->', i + 4);
          if (end !== -1) { add(i, end + 3); i = end + 3; continue; }
        }
        const gt = text.indexOf('>', i + 1);
        if (gt !== -1 && gt - i <= 512 && !/[\r\n]/.test(text.slice(i, gt))) {
          const body = text.slice(i + 1, gt);
          if (/^\/?[A-Za-z][\w:.-]*(?:\s[^<>]*)?\/?$/.test(body) ||
              /^(?:https?|mailto|tel):/i.test(body) ||
              /^[^\s<>@]+@[^\s<>@]+$/.test(body)) {
            add(i, gt + 1);
            i = gt + 1;
            continue;
          }
        }
        i++;
        continue;
      }
      if (ch === '!' && text[i + 1] === '[') {
        const end = linkEnd(text, i + 1);
        if (end) { add(i, end.to); i = end.to; continue; }
      }
      if (ch === '[') {
        const end = linkEnd(text, i);
        if (end) {
          add(end.destFrom, end.to);
          i = end.to;
          continue;
        }
      }
      i++;
    }
  }

  /** 解析 `[label](dest)`；返回整体终点与目标区间。嵌套方括号/圆括号按 CommonMark 平衡。 */
  function linkEnd(text, open) {
    let depth = 1, i = open + 1;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') { i++; continue; }
      if (c === '\n' || c === '\r') return null;
      if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0 || text[i + 1] !== '(') return null;
    let paren = 1, j = i + 2;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === '\\') { j++; continue; }
      if (c === '(') paren++;
      else if (c === ')') {
        paren--;
        if (paren === 0) break;
      }
    }
    if (paren !== 0) return null;
    return { destFrom: i + 2, to: j + 1 };
  }

  function clampPos(value, length) {
    if (!Number.isInteger(value)) return null;
    return Math.max(0, Math.min(length, value));
  }

  /** 调用方（analyzePublic）给的真 HTML 注释区间：有序、合并；closed:false 表示未闭合。 */
  function normalizeCommentRanges(input, length) {
    if (!Array.isArray(input)) return null;
    const ranges = [];
    for (const item of input) {
      if (!item) continue;
      const from = clampPos(item.from, length), to = clampPos(item.to, length);
      if (from === null || to === null || to <= from) continue;
      ranges.push({ from, to, block: !!item.block, closed: item.closed !== false });
    }
    ranges.sort((a, b) => a.from - b.from || a.to - b.to);
    const out = [];
    for (const range of ranges) {
      const last = out[out.length - 1];
      if (last && range.from <= last.to) {
        if (range.to > last.to) {
          last.to = range.to;
          last.closed = range.closed;
        } else if (!range.closed) last.closed = false;
        last.block = last.block || range.block;
      } else out.push(range);
    }
    return out;
  }

  /** 调用方（markdown-context.scanFenceLines）给的权威围栏块；容器隐式闭合已在那边处理。 */
  function normalizeFenceBlocks(input, length) {
    if (!Array.isArray(input)) return null;
    const out = [];
    for (const item of input) {
      if (!item) continue;
      const from = clampPos(item.from, length), to = clampPos(item.to, length);
      if (from === null || to === null || to <= from) continue;
      out.push({
        from,
        to,
        closeFrom: item.closeFrom == null ? null : clampPos(item.closeFrom, length),
        startLine: item.startLine,
        endLine: item.endLine,
        /* scanFenceLines 的容器前缀（quote/list）；undefined 表示调用方没给（按顶层处理）。 */
        prefix: Array.isArray(item.prefix) ? item.prefix.map(p => ({ kind: p.kind, width: p.width })) : null,
      });
    }
    out.sort((a, b) => a.from - b.from || a.to - b.to);
    return out;
  }

  /** 调用方给的是不是**完整权威** code 输入（parser/tree/显式 authoritative 标志）。
   *  只有完整权威才允许跳过旧围栏自扫；裸 code 区间数组可能是局部结果，仍走 fallback。 */
  function hasAuthoritativeCode(input) {
    if (!input || typeof input !== 'object') return false;
    if (input.authoritative === true) return true;
    return typeof input.parse === 'function' || typeof input.iterate === 'function' ||
      !!input.tree || !!input.parser;
  }

  function computeOpaque(text, lines, details = null, codeInput = null) {
    const base = [];
    const fmEnd = frontMatterEnd(text);
    if (fmEnd > 0) pushRange(base, 0, fmEnd);

    const commentsInput = !!(codeInput && Array.isArray(codeInput.comments));
    const comments = normalizeCommentRanges(codeInput && codeInput.comments, text.length);
    const fences = normalizeFenceBlocks(codeInput && codeInput.fences, text.length);
    const rawCode = extractCodeRanges(codeInput, text);
    const authoritative = hasAuthoritativeCode(codeInput) || fences !== null;
    const hasFencedCode = rawCode.some(item => item && item.kind === 'FencedCode');

    if (fences) {
      /* 显式围栏块（兼容入口）：容器隐式闭合由调用方算好，直接消费。 */
      for (const block of fences) pushRange(base, block.from, block.to);
      if (details) {
        const lastLineFrom = text.lastIndexOf('\n') + 1;
        const last = fences.length ? fences[fences.length - 1] : null;
        details.unclosedFence = !!last && last.closeFrom == null && last.to >= lastLineFrom &&
          (!last.prefix || last.prefix.length === 0);
      }
    } else if (!authoritative && !hasFencedCode) {
      /* standalone 语义（无权威 code、也没有 FencedCode 区间）：保留旧自扫。
         有 parser/tree/显式 authoritative 时**绝不**跑这段：手工区间会开到 EOF，
         覆盖权威 FencedCode 并且不认注释（R5/B14 的假围栏）。 */
      let open = null;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.from < fmEnd) continue;
        const q = quoteOffset(line.text);
        const body = line.text.slice(q);
        if (open) {
          const f = fenceAt(body);
          if (f && f.char === open.char && f.len >= open.len && !f.info) {
            pushRange(base, open.from, line.to);
            open = null;
          }
          continue;
        }
        const f = fenceAt(body);
        if (f) open = { ...f, from: line.from };
      }
      if (open) {
        pushRange(base, open.from, text.length);
        if (details) details.unclosedFence = true;
      }
    }

    /* 三类区间分开走（不要合成一张 static）：
       · 围栏 / parser code —— 进 static，数学扫描要在这类区间处收尾；
       · 注释（analyzePublic + parser CommentBlock）—— **不进 static**（否则数学会在注释行
         被截断、后面的 $$ 重新开到 EOF），只进行内 skip 与最终 opaque 合并；
       · 链接定义目标段 —— 进 static。 */
    const parserCodeItems = [], parserFenceItems = [], parserCommentItems = [];
    for (const item of rawCode) {
      if (!item) continue;
      if (item.kind === 'CommentBlock') parserCommentItems.push(item);
      else if (item.kind === 'FencedCode') parserFenceItems.push(item);
      else parserCodeItems.push(item);
    }
    const parserCodeRanges = parserOpaqueRanges(parserCodeItems, text, lines, details);
    const parserFenceRanges = parserOpaqueRanges(parserFenceItems, text, lines, details);
    const parserCommentRanges = parserOpaqueRanges(parserCommentItems, text, lines, details);

    let structuralRanges = mergeRanges(base);
    if (parserCodeRanges.length) structuralRanges = mergeRanges(structuralRanges.concat(parserCodeRanges));
    if (parserFenceRanges.length) structuralRanges = mergeRanges(structuralRanges.concat(parserFenceRanges));

    // 普通链接引用定义的“目标段”也不参与脚注扫描（[foo]: https://…/[^x]）
    const linkRanges = [];
    const linkLists = [structuralRanges, linkRanges];
    for (const line of lines) {
      if (rangeAtAny(linkLists, line.from)) continue;
      const m = /^( {0,3})\[([^\]\r\n]+)\]:[ \t]*(\S.*)$/.exec(line.text);
      if (!m || m[2].startsWith('^')) continue;
      const destFrom = line.from + m[1].length + m[2].length + 4; // [ + label + ]:
      pushRange(linkRanges, destFrom, line.to);
    }

    /* 从这里开始所有表都必须有序；注释在数学扫描**之后**才并入。 */
    let staticRanges = mergeRanges(structuralRanges.concat(linkRanges));
    const opaqueComments = mergeRanges((comments || []).concat(parserCommentRanges));

    if (details) {
      details.unclosedComment = !!details.unclosedComment ||
        (commentsInput && !!comments && comments.some(c => !c.closed && !text.slice(c.to).trim()));
    }

    // 多行 $$ 块（只跳过 front-matter/围栏/parser code/链接定义；注释不参与）
    const mathRanges = [];
    scanDisplayMathBlocks(lines, staticRanges, mathRanges, details);

    // 行内：代码 / 公式 / 链接目标 / HTML 注释与标签；权威注释进 skip 且关闭旧 <!-- 配对
    const inlineRanges = [];
    const commentSkip = (commentsInput || parserCommentRanges.length) ? opaqueComments : null;
    scanInlineOpaque(text, staticRanges, mathRanges, inlineRanges, commentSkip);
    return mergeRanges(staticRanges.concat(mathRanges, inlineRanges, opaqueComments));
  }

  function isContinuation(text) {
    // GFM：定义正文的续行至少缩进 4 空格（或一个制表符）。2-3 空格的普通段落
    // 不能被吞进上一条定义（“缩进不吞下一普通段”）。
    return /^(?: {4,}|\t)/.test(text);
  }

  function stripContinuation(text) {
    if (text[0] === '\t') return text.slice(1);
    return text.replace(/^ {1,4}/, '');
  }

  function normalizeNoteBody(raw) {
    const parts = String(raw).split(/\r\n?|\n/);
    return parts.map((line, index) => index === 0 ? line : stripContinuation(line)).join('\n');
  }

  function findDefinitions(text, lines, opaque) {
    const notes = [];
    /* 每条定义的完整区间（含重复定义）都从引用扫描中排除：
       · 不支持定义内嵌套角标 ⇒ 不给永远不会以“活链接”展示的引用编号；
       · 重复定义保留原文（不生成 note、不隐藏标记），也不从中解析引用。 */
    const blocked = [];
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 只按“标记起点是否落在代码/数学/HTML 等隔离区”判断；定义正文里可以正常含
      // 行内代码、公式、链接（它们只影响正文渲染，不影响这条定义是否成立）。
      if (rangeAt(opaque, line.from) || rangeAt(opaque, line.from + 1)) continue;
      const m = /^( {0,3})\[\^([^\]\r\n]+)\]:[ \t]?(.*)$/.exec(line.text);
      if (!m) continue;
      const label = m[2];
      if (!label.trim() || label.length > MAX_LABEL_LENGTH) continue;
      const from = line.from + m[1].length;
      if (rangeAt(opaque, from)) continue;
      const markerTo = from + 2 + label.length + 2; // [^ + label + ]:

      let last = i;
      let j = i + 1;
      while (j < lines.length) {
        const row = lines[j];
        if (row.text.trim() === '') {
          let k = j + 1;
          while (k < lines.length && lines[k].text.trim() === '') k++;
          if (k < lines.length && isContinuation(lines[k].text)) {
            last = k;
            j = k + 1;
            continue;
          }
          break;
        }
        if (isContinuation(row.text)) { last = j; j++; continue; }
        break;
      }
      const textFrom = markerTo + (text[markerTo] === ' ' || text[markerTo] === '\t' ? 1 : 0);
      const to = lines[last].to;
      blocked.push({ from, to });
      i = last;
      if (seen.has(label)) continue; // 重复定义：保留原文，不生成 note
      seen.add(label);
      const raw = text.slice(textFrom, to);
      notes.push({
        label,
        from,
        to,
        markerFrom: from,
        markerTo,
        textFrom,
        textTo: to,
        text: normalizeNoteBody(raw),
      });
    }
    return { notes, blocked };
  }

  function findRefs(text, opaque, blocked) {
    const refs = [];
    const excluded = mergeRanges(blocked.slice());
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch !== '[' || text[i + 1] !== '^') { i++; continue; }
      if (rangeAt(opaque, i) || rangeAt(excluded, i)) { i++; continue; }
      if (i > 0 && text[i - 1] === '!') { i++; continue; }
      const close = text.indexOf(']', i + 2);
      if (close === -1) break;
      if (rangeAt(opaque, close)) { i = close + 1; continue; }
      const label = text.slice(i + 2, close);
      if (!label || label.length > MAX_LABEL_LENGTH || /[\[\]\r\n]/.test(label) || !label.trim()) {
        i++;
        continue;
      }
      const next = text[close + 1];
      if (next === '(' || next === '[') { i = close + 1; continue; }
      if (next === ':') {
        const lineStart = text.lastIndexOf('\n', i) + 1;
        if (/^ {0,3}$/.test(text.slice(lineStart, i))) { i = close + 1; continue; }
      }
      refs.push({ from: i, to: close + 1, label });
      i = close + 1;
    }
    return refs;
  }

  function collectFootnotes(markdown, codeInput = null) {
    const text = String(markdown == null ? '' : markdown);
    /* 【长稿快路径】没有 "[^" 就必然没有脚注引用或定义；直接返回，不进入隔离扫描。
       普通长文（尤其含大量公式）的打开/换行/括号输入因此不付全稿 O(n) 的代价。
       有脚注的文档仍走下面的完整解析，正确性不受影响。 */
    if (text.indexOf('[^') === -1) return { refs: [], notes: [] };
    const lines = splitLines(text);
    const opaque = computeOpaque(text, lines, null, codeInput);
    const found = findDefinitions(text, lines, opaque);
    const rawNotes = found.notes;
    const rawRefs = findRefs(text, opaque, found.blocked);

    const byLabel = new Map();
    for (const note of rawNotes) if (!byLabel.has(note.label)) byLabel.set(note.label, note);

    let nextNumber = 0;
    const refs = [];
    for (let ordinal = 1; ordinal <= rawRefs.length; ordinal++) {
      const raw = rawRefs[ordinal - 1];
      const note = byLabel.get(raw.label) || null;
      if (!note) {
        refs.push({
          from: raw.from, to: raw.to, label: raw.label,
          number: 0, noteId: null, refId: 'mp-fn-ref-u-' + ordinal,
          resolved: false, occurrence: 0, ordinal,
        });
        continue;
      }
      if (!note.number) {
        note.number = ++nextNumber;
        note.noteId = 'mp-fn-note-' + note.number;
        note.occurrence = 0;
        note.refs = [];
      }
      note.occurrence++;
      const ref = {
        from: raw.from, to: raw.to, label: raw.label,
        number: note.number, noteId: note.noteId,
        refId: 'mp-fn-ref-' + note.number + '-' + note.occurrence,
        resolved: true, occurrence: note.occurrence, ordinal,
      };
      note.refs.push(ref);
      refs.push(ref);
    }

    const notes = rawNotes.map(note => {
      if (!note.number) {
        note.number = ++nextNumber;
        note.noteId = 'mp-fn-note-' + note.number;
        note.refs = [];
      }
      return {
        label: note.label,
        number: note.number,
        noteId: note.noteId,
        from: note.from,
        to: note.to,
        text: note.text,
        refs: note.refs,
        markerFrom: note.markerFrom,
        markerTo: note.markerTo,
        textFrom: note.textFrom,
        textTo: note.textTo,
        referenced: note.refs.length > 0,
      };
    }).sort((a, b) => a.number - b.number || a.from - b.from);

    return { refs, notes };
  }

  function isFootnoteOpaque(markdown, pos, codeInput = null) {
    const text = String(markdown == null ? '' : markdown);
    if (!Number.isFinite(pos) || pos < 0 || pos > text.length) return true;
    const lines = splitLines(text);
    return !!rangeAt(computeOpaque(text, lines, null, codeInput), pos);
  }

  /** 文档末尾是否还在未闭合的围栏/多行公式/HTML 注释里（新增脚注定义不能写进去）。
   *  返回逐项原因，供编辑器给出“注释”与“代码/公式”两种不同反馈。 */
  function footnoteTailReasons(markdown, codeInput = null) {
    const text = String(markdown == null ? '' : markdown);
    if (!text) return { fence: false, math: false, comment: false };
    const details = {};
    computeOpaque(text, splitLines(text), details, codeInput);
    return {
      fence: !!details.unclosedFence,
      math: !!details.unclosedMath,
      comment: !!details.unclosedComment,
    };
  }

  function isFootnoteTailOpaque(markdown, codeInput = null) {
    const reasons = footnoteTailReasons(markdown, codeInput);
    return !!(reasons.fence || reasons.math || reasons.comment);
  }

  function hasStructuralChars(value) {
    return STRUCTURAL_CHARS.test(String(value == null ? '' : value));
  }

  /**
   * 回链目标解析（纯函数；编辑器与单测共用，PDF 不需要）。
   * 主判据是 label + CM 映射后的精确 [from,to]；refId/noteId 由“编号+出现序号”生成，
   * 跳转后若前文增删脚注会重排，拿它们当身份会回错位置。
   * - 精确命中 ⇒ target；
   * - 同 label 但精确位置已不存在 ⇒ target=null, reason='target-gone'（调用方不得静默改跳）；
   * - 无状态（直接点定义）或状态属于别的脚注 ⇒ 显式回该 label 的第一处。
   */
  function resolveBackTarget(index, nav, note) {
    const refs = ((index && index.refs) || []).filter(ref => ref.resolved && ref.label === note.label);
    if (!refs.length) return { target: null, reason: 'no-refs' };
    if (nav && nav.label === note.label) {
      const exact = refs.find(ref => ref.from === nav.refFrom && ref.to === nav.refTo) || null;
      return exact ? { target: exact, reason: null } : { target: null, reason: 'target-gone' };
    }
    return { target: refs[0], reason: null };
  }

  return { collectFootnotes, isFootnoteOpaque, isFootnoteTailOpaque, footnoteTailReasons, hasStructuralChars, resolveBackTarget };
});
