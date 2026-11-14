'use strict';
/**
 * footnotes.cjs — Markdown 脚注的唯一纯解析/索引层（无 DOM、无 CM6、无第三方依赖）。
 *
 * 这是编辑端（CM6 投影/跳转）与导出端（PDF/HTML）共用的同一份语法真源：
 * 谁能成为脚注、偏移在哪、编号是多少、DOM id 是什么，只在这里算一次。
 *
 * 契约（主控 2026-11-13 定版）：
 *   collectFootnotes(markdown) -> {
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
 *   · 反斜杠转义（\[^x]）不识别；HTML 注释与普通链接目标不识别；
 *   · 定义必须是行首（0-3 空格）的 `[^label]:`，代码/数学/链接目标里的不算；
 *   · 未解析的引用保持原文，不生成活链接（resolved=false, noteId=null, number=0）。
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

  /** 多行 $$ 块：行首（0-3 空格，可带引用前缀）$$，本行没有闭合的 $$，到含 $$ 的行收尾。 */
  function scanDisplayMathBlocks(lines, opaque, details) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (touches(opaque, line.from, line.to)) continue;
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
        if (touches(opaque, row.from, row.to)) { closed = j; break; }
        const rq = quoteOffset(row.text);
        let found = -1;
        for (let k = rq; k + 1 < row.text.length; k++) {
          if (row.text[k] === '\\') { k++; continue; }
          if (row.text.startsWith('$$', k)) { found = k; break; }
        }
        if (found !== -1) { closed = j; break; }
      }
      const to = closed === -1 ? (lines.length ? lines[lines.length - 1].to : line.to) : lines[closed].to;
      pushRange(opaque, line.from, to);
      if (closed === -1) {
        if (details) details.unclosedMath = true;
        break;
      }
      i = closed;
    }
  }

  function scanInlineOpaque(text, opaque) {
    const len = text.length;
    const add = (from, to) => pushRange(opaque, from, to);
    let i = 0;
    while (i < len) {
      if (rangeAt(opaque, i)) { i = rangeAt(opaque, i).to; continue; }
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
        if (text.startsWith('<!--', i)) {
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

  function computeOpaque(text, lines, details = null) {
    const opaque = [];
    const fmEnd = frontMatterEnd(text);
    if (fmEnd > 0) pushRange(opaque, 0, fmEnd);

    // 围栏代码块（0-3 空格缩进；引用前缀内的围栏同样整块隔离；front-matter 内不另起）
    let open = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.from < fmEnd) continue;
      const q = quoteOffset(line.text);
      const body = line.text.slice(q);
      if (open) {
        const f = fenceAt(body);
        if (f && f.char === open.char && f.len >= open.len && !f.info) {
          pushRange(opaque, open.from, line.to);
          open = null;
        }
        continue;
      }
      const f = fenceAt(body);
      if (f) open = { ...f, from: line.from };
    }
    if (open) {
      pushRange(opaque, open.from, text.length);
      if (details) details.unclosedFence = true;
    }

    // 普通链接引用定义的“目标段”也不参与脚注扫描（[foo]: https://…/[^x]）
    for (const line of lines) {
      if (rangeAt(opaque, line.from)) continue;
      const m = /^( {0,3})\[([^\]\r\n]+)\]:[ \t]*(\S.*)$/.exec(line.text);
      if (!m || m[2].startsWith('^')) continue;
      const destFrom = line.from + m[1].length + m[2].length + 4; // [ + label + ]:
      pushRange(opaque, destFrom, line.to);
    }

    // 多行 $$ 块（跳过 front-matter 与围栏内部）
    scanDisplayMathBlocks(lines, opaque, details);

    // 行内：代码 / 公式 / 链接目标 / HTML 注释与标签
    scanInlineOpaque(text, opaque);
    return mergeRanges(opaque);
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

  function collectFootnotes(markdown) {
    const text = String(markdown == null ? '' : markdown);
    /* 【长稿快路径】没有 "[^" 就必然没有脚注引用或定义；直接返回，不进入隔离扫描。
       普通长文（尤其含大量公式）的打开/换行/括号输入因此不付全稿 O(n) 的代价。
       有脚注的文档仍走下面的完整解析，正确性不受影响。 */
    if (text.indexOf('[^') === -1) return { refs: [], notes: [] };
    const lines = splitLines(text);
    const opaque = computeOpaque(text, lines);
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

  function isFootnoteOpaque(markdown, pos) {
    const text = String(markdown == null ? '' : markdown);
    if (!Number.isFinite(pos) || pos < 0 || pos > text.length) return true;
    const lines = splitLines(text);
    return !!rangeAt(computeOpaque(text, lines), pos);
  }

  /** 文档末尾是否还在未闭合的围栏/多行公式里（新增脚注定义不能写进去）。 */
  function isFootnoteTailOpaque(markdown) {
    const text = String(markdown == null ? '' : markdown);
    if (!text) return false;
    const details = {};
    computeOpaque(text, splitLines(text), details);
    return !!(details.unclosedFence || details.unclosedMath);
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

  return { collectFootnotes, isFootnoteOpaque, isFootnoteTailOpaque, hasStructuralChars, resolveBackTarget };
});
