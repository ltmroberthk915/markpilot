/**
 * public-markdown.js — 编辑态 / 导出态共用的 HTML 注释文法区间与公开快照。
 *
 * 对外签名（唯一契约）：
 *   commentRanges(source, options?) -> ReadonlyArray<{ from, to, block, closed }>
 *   analyzePublic(source, options?) -> { comments, code }
 *   publicMarkdown(source, options?) -> string
 *
 * 范围口径：UTF-16 code unit，0-based，from 含 / to 不含；to 指向 `-->` 最后一个字符之后。
 *   · 跨行注释是**一条**连续区间（不是逐行多个）；
 *   · block:true 表示按块级处理（保留其换行、可跨行）；closed 表示是否以 `-->` 收尾；
 *   · 行首（0-3 空格，含引用前缀）未闭合的 `<!--` 按 CommonMark HTML block 延伸到文末，
 *     closed:false；行内未闭合的 `<!--` **不是注释**，保持字面；
 *   · 空注释 `<!---->` 与 HTMLBlock 内部的 `<!-- ... -->` 由配对补扫纳入；
 *   · 代码（InlineCode 含跨行 / FencedCode / CodeBlock 含缩进）、数学（opts.mathRanges
 *     或保守默认扫描）、`\<!--` 转义、front-matter 内的 `<!--` 一律不是注释。
 *     mathRanges 必须是**源文**偏移；一旦提供即覆盖默认数学扫描（调用方负责覆盖 inline
 *     与 display 两种数学），因此编辑端传 mathSpansField.spans，导出端传自己的数学真源。
 *
 * 公开快照不是等长字符串：真注释被删除；顶层 block 注释保留行结构（换行），
 * 引用/列表前缀内的多行 block 注释折叠，否则 `-->` 后的尾文会掉出容器。
 * 因此调用方必须把 publicMarkdown 的结果当成**新文档**。编辑态必须用 commentRanges
 * 的源偏移做 Decoration，绝不能拿公开快照的偏移去映射 Decoration。选区裁剪必须先用
 * commentRanges 把端点推离/扩展到注释边界，再对完整源文调用 publicMarkdown；不能用
 * 原始偏移直接切公开快照。表格分行/分块同理：用全文 commentRanges 的源坐标裁剪，
 * 不要对行片段重新解析来判注释；行内代码/围栏字面在裁剪中保持原字节。
 *
 * 替换护栏（防止删除注释本身制造新语义）：
 *   1. 行内两侧都是非空白字符时补一个空格，避免 `*<!--x-->*` 合成 `**`；
 *   2. 注释落在行首/引用/列表前缀之后时，把后续可见文字的前导空格压到最多 3 格，
 *      避免合出 4 空格缩进代码；
 *   3. 同一位置若后续文字会新起块级语法（# / > / 列表 / 围栏 / hr / setext / 表格 /
 *      $$ / HTML block / 链接引用定义 / 有序列表定界符），在**公开渲染模式**下加 `\`
 *      转义；`mode:"text"` 只删除不加转义（纯文本不按 Markdown 重新解析）。
 *
 * 依赖：@lezer/markdown（与 @codemirror/lang-markdown 同一语法家族，GFM 配置）。
 * 无 DOM / 无 CM6 / 无编辑器状态；无 `<!--` 时零解析快速退出。
 */

import { Text } from '@codemirror/state';
import { scanSingleDollarMath } from './single-dollar-math.js';
import { parser as lezerParser, GFM } from '@lezer/markdown';
import { frontMatterSyntax, sourceFrontMatter } from './frontmatter.js';

const mdParser = lezerParser.configure([GFM, frontMatterSyntax]);

const CODE_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock']);
const COMMENT_NODES = new Set(['Comment', 'CommentBlock']);
const EMPTY_COMMENT = /<!---->/g;
const HTML_BLOCK_OPEN = /^<(?:[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|\/[A-Za-z][A-Za-z0-9-]*\s*>|!|\?)/;

/**
 * HTML 标签自身的区间（`<tag ...>` / `</tag>` / `<!...>` / `<?...>`）。
 * 原始 HTML 只有在**标签外**的 `<!--` 才是真注释；标签内（包括引号属性、
 * 未闭合标签、`<div <!--x--> >` 这种畸形写法）一律保持字面。
 */
function htmlTagRanges(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    let j = lt + 1;
    if (text[j] === '/' || text[j] === '!' || text[j] === '?') j++;
    if (!/[A-Za-z]/.test(text[j] || '')) {
      i = lt + 1;
      continue;
    }
    let k = j;
    while (k < text.length) {
      const ch = text[k];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        k++;
        while (k < text.length && text[k] !== quote) k++;
        if (k < text.length) k++;
        continue;
      }
      if (ch === '>') {
        k++;
        break;
      }
      k++;
    }
    out.push({ from: lt, to: Math.min(k, text.length) });
    i = Math.max(k, lt + 1);
  }
  return out;
}

/** script/style/textarea/title 的正文是原始文本，里面的 `<!--` 不是 HTML 注释。
 *  tagRanges 用来排除“引号属性里出现的 <script> 字样”——那不是真的原始文本标签。 */
function rawTextRanges(text, tagRanges = []) {
  const out = [];
  const re = /<(script|style|textarea|title)\b[^>]*>/gi;
  let match;
  while ((match = re.exec(text))) {
    const start = match.index;
    if (tagRanges.some((range) => start > range.from && start < range.to)) continue;
    const tag = match[1].toLowerCase();
    const close = text.toLowerCase().indexOf('</' + tag, re.lastIndex);
    if (close < 0) {
      out.push({ from: re.lastIndex, to: text.length });
      break;
    }
    out.push({ from: re.lastIndex, to: close });
    re.lastIndex = close + 1;
  }
  return out;
}

function freezeRanges(ranges) {
  for (const range of ranges) Object.freeze(range);
  return Object.freeze(ranges);
}

function clampRange(range, length) {
  const from = Math.max(0, Math.min(length, range.from | 0));
  const to = Math.max(0, Math.min(length, range.to | 0));
  return to > from ? { ...range, from, to } : null;
}

function sortRanges(ranges) {
  return ranges.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** 合并重叠/包含区间；相邻但不相交的保留（范围语义不丢端点）。 */
function normalizeRanges(ranges, length) {
  const valid = [];
  for (const range of ranges) {
    const clamped = clampRange(range, length);
    if (clamped) valid.push(clamped);
  }
  sortRanges(valid);
  const out = [];
  for (const range of valid) {
    const last = out[out.length - 1];
    if (last && range.from < last.to) {
      const previousTo = last.to;
      last.to = Math.max(last.to, range.to);
      if (last.to > previousTo) last.closed = range.closed;
      last.block = last.block || range.block;
    } else out.push({ ...range });
  }
  return out;
}

function overlapsAny(ranges, from, to) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid];
    if (range.to <= from) low = mid + 1;
    else if (range.from >= to) high = mid - 1;
    else return true;
  }
  return false;
}

function insideAny(ranges, pos) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid];
    if (pos < range.from) high = mid - 1;
    else if (pos >= range.to) low = mid + 1;
    else return true;
  }
  return false;
}

function isEscaped(source, index) {
  let count = 0;
  for (let i = index - 1; i >= 0 && source.charCodeAt(i) === 92; i--) count++;
  return (count & 1) === 1;
}

function frontMatterRange(source) {
  const match = sourceFrontMatter.exec(source);
  return match ? { from: 0, to: match[0].length } : null;
}

function quoteOffset(text) {
  let offset = 0;
  for (;;) {
    const match = /^ {0,3}>[ \t]?/.exec(text.slice(offset));
    if (!match) return offset;
    offset += match[0].length;
  }
}

/**
 * 保守的数学区间：只在调用方没有给 mathRanges 时使用。
 * 产品编辑态应传 mathSpansField.spans；导出端可传自己的数学真源。
 * 这里覆盖 `$$` 块、单行紧贴 `$…$`、以及 `$\begin{…}` 跨行公式。
 */
function defaultMathRanges(source, codeRanges) {
  const lines = [];
  let base = 0;
  for (const text of source.split('\n')) {
    lines.push({ from: base, to: base + text.length, text });
    base += text.length + 1;
  }
  const display = [];
  const lineTouchesCode = (line) => overlapsAny(codeRanges, line.from, line.to);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (lineTouchesCode(line) || insideAny(display, line.from)) continue;
    const q = quoteOffset(line.text);
    const body = line.text.slice(q);
    const open = /^( {0,3})\$\$/.exec(body);
    if (!open) continue;
    const start = line.from + q + open[1].length;
    const after = body.slice(open[0].length);
    const sameLine = after.indexOf('$$');
    if (sameLine >= 0) {
      display.push({ from: start, to: start + open[0].length - open[1].length + sameLine + 2 });
      continue;
    }
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lineTouchesCode(lines[j])) break;
      const close = lines[j].text.indexOf('$$');
      if (close >= 0) {
        end = lines[j].from + close + 2;
        break;
      }
    }
    if (end < 0) {
      display.push({ from: start, to: source.length });
      break;
    }
    display.push({ from: start, to: end });
  }

  display.push(...scanSingleDollarMath(Text.of(source.split('\n')), [...codeRanges.filter(r => r.kind !== 'InlineCode'), ...display]));

  const math = normalizeRanges(display, source.length);
  for (const line of lines) {
    if (!line.text.includes('$')) continue;
    let i = 0;
    while (i < line.text.length) {
      const pos = line.from + i;
      if (insideAny(math, pos) || insideAny(codeRanges, pos)) {
        i++;
        continue;
      }
      const ch = line.text[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch !== '$') {
        i++;
        continue;
      }
      const next = line.text[i + 1];
      if (next === '$' || next === undefined || /\s/.test(next)) {
        i++;
        continue;
      }
      let close = -1;
      for (let j = i + 1; j < line.text.length; j++) {
        if (line.text[j] === '\\') {
          j++;
          continue;
        }
        if (line.text[j] === '$' && !/\s/.test(line.text[j - 1])) {
          close = j;
          break;
        }
      }
      if (close < 0) {
        i++;
        continue;
      }
      math.push({ from: pos, to: line.from + close + 1 });
      i = close + 1;
    }
  }
  return math;
}

/**
 * @param {string} source
 * @param {{ mathRanges?: Array<{from:number,to:number}> }} [options]
 * @returns {{ comments: ReadonlyArray<{from:number,to:number,block:boolean,closed:boolean}>,
 *             code: ReadonlyArray<{from:number,to:number,kind:string}>,
 *             tables: ReadonlyArray<{from:number,to:number}> }}
 */
export function analyzePublic(source, options = {}) {
  const text = String(source == null ? '' : source);
  const empty = Object.freeze({
    comments: freezeRanges([]),
    code: freezeRanges([]),
    tables: freezeRanges([]),
  });
  if (text.indexOf('<!--') < 0) return empty; // 无注释快速退出：零 parser 调用

  const tree = mdParser.parse(text);
  const code = [];
  const comments = [];
  const htmlBlocks = [];
  const tables = [];

  tree.iterate({
    enter(node) {
      if (CODE_NODES.has(node.name)) {
        code.push({ from: node.from, to: node.to, kind: node.name });
        return false;
      }
      if (node.name === 'Table') {
        tables.push({ from: node.from, to: node.to });
        return undefined;
      }
      if (COMMENT_NODES.has(node.name)) {
        const block = node.name === 'CommentBlock';
        let to = node.to;
        let closed = true;
        if (block) {
          /* CommentBlock 的语法区间包含 `-->` 所在整行的剩余文字；公开快照只删除注释本身，
             不能把同一行 `-->` 之后用户仍看得见的文字一起吞掉。 */
          const close = text.indexOf('-->', node.from + 4);
          if (close >= 0 && close + 3 <= node.to) to = close + 3;
          else closed = false;
        }
        comments.push({
          from: node.from,
          to,
          block,
          closed,
        });
        /* CommentBlock 同行后续：parser 把整行都算进 CommentBlock，`<!-- A --> PUBLIC <!-- B -->`
           里的 B 不会作为子节点出现。对 `-->` 之后的剩余片段再走一次同一套文法，只保留
           **已闭合** 注释（行内未闭合按字面）；这样 B 不会漏，代码/字符串/属性里的 `<!--` 也不误删。 */
        if (block && closed && to < node.to) {
          const rest = text.slice(to, node.to);
          if (rest.includes('<!--')) {
            let localOptions;
            if (Array.isArray(options.mathRanges)) {
              const localMath = [];
              for (const range of options.mathRanges) {
                const from = Math.max(range.from, to) - to;
                const end = Math.min(range.to, node.to) - to;
                if (end > from) localMath.push({ from: from + 1, to: end + 1 });
              }
              localOptions = { mathRanges: localMath };
            }
            /* 前缀一个中性字符：剩余片段在原行中是**行内**文本，不是新行首。
               否则 `<!--A--><!--B 未闭合 <!--C-->` 的剩余片段会被当成从行首开始的
               CommentBlock，未闭合的 B 一路吞到 C，C 就漏掉。 */
            const probe = 'x' + rest;
            const nested = analyzePublic(probe, localOptions).comments;
            for (const range of nested) {
              if (!range.closed || range.from < 1) continue;
              comments.push({
                from: to + range.from - 1,
                to: to + range.to - 1,
                block: range.block,
                closed: true,
              });
            }
          }
        }
        return false;
      }
      if (node.name === 'HTMLBlock') {
        htmlBlocks.push({ from: node.from, to: node.to });
        return false;
      }
      return undefined;
    },
  });

  const normalizedCode = normalizeRanges(code, text.length);
  const opaque = [];
  const frontMatter = frontMatterRange(text);
  if (frontMatter) opaque.push(frontMatter);
  if (Array.isArray(options.mathRanges)) {
    for (const range of options.mathRanges) {
      const clamped = clampRange(range, text.length);
      if (clamped) opaque.push(clamped);
    }
  } else {
    for (const range of defaultMathRanges(text, normalizedCode)) {
      const clamped = clampRange(range, text.length);
      if (clamped) opaque.push(clamped);
    }
  }
  const normalizedOpaque = normalizeRanges(opaque, text.length);
  /* inline HTMLTag / raw text 的标签内也不识别注释（parser 对空注释不产出 Comment）。 */
  const inlineTags = htmlTagRanges(text);
  const inlineIgnored = normalizeRanges([
    ...inlineTags,
    ...rawTextRanges(text, inlineTags),
  ], text.length);

  // HTMLBlock 内部的注释不在语法树里单列（parser 把整块当一个 HTMLBlock）。
  for (const block of htmlBlocks) {
    const slice = text.slice(block.from, block.to);
    const tags = htmlTagRanges(slice);
    const ignored = normalizeRanges([
      ...tags,
      ...rawTextRanges(slice, tags),
    ], slice.length);
    /* 不用 matchAll：被忽略区域里的第一个 `<!--` 可能一路匹配到后面真注释的 `-->`，
       把真注释吞掉（实机：`<script>"<!--"</script><!--secret-->` 里 secret 丢失）。
       改成“遇到忽略区的 `<!--` 只跳过这 4 个字符”，继续找下一个 opener。 */
    let pos = 0;
    while (pos < slice.length) {
      const open = slice.indexOf('<!--', pos);
      if (open < 0) break;
      if (insideAny(ignored, open)) {
        pos = open + 4;
        continue;
      }
      const close = slice.indexOf('-->', open + 4);
      if (close < 0) break;
      comments.push({
        from: block.from + open,
        to: block.from + close + 3,
        block: true,
        closed: true,
      });
      pos = close + 3;
    }
  }

  // parser 不把空注释 `<!---->` 当 Comment（实测），用配对补扫；换行注释同理兜底。
  for (const match of text.matchAll(EMPTY_COMMENT)) {
    const from = match.index;
    const to = from + match[0].length;
    if (isEscaped(text, from)) continue;
    if (insideAny(normalizedCode, from) || insideAny(normalizedOpaque, from)) continue;
    if (insideAny(inlineIgnored, from)) continue;
    if (comments.some((range) => from >= range.from && from < range.to)) continue;
    comments.push({ from, to, block: false, closed: true });
  }

  const kept = [];
  for (const range of comments) {
    const clamped = clampRange(range, text.length);
    if (!clamped) continue;
    if (insideAny(normalizedCode, clamped.from)) continue; // 代码里的 `<!--` 必须保持字面
    if (insideAny(normalizedOpaque, clamped.from)) continue; // 数学 / front-matter 同理
    kept.push({ ...range, ...clamped });
  }

  return Object.freeze({
    comments: freezeRanges(normalizeRanges(kept, text.length)),
    code: freezeRanges(normalizedCode.map((range) => Object.freeze(range))),
    tables: freezeRanges(normalizeRanges(tables, text.length)),
  });
}

/**
 * 只读的注释区间函数；返回数组与元素均被 Object.freeze。
 * @param {string} source
 * @param {{ mathRanges?: Array<{from:number,to:number}> }} [options]
 */
export function commentRanges(source, options = {}) {
  return analyzePublic(source, options).comments;
}

/* ── 公开快照 ───────────────────────────────────────────────────────────── */

const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
const HTML_PUNCT = new Set(['<', '>', '/', '=', '"', "'"]);

/** 块注释在顶层才保留行结构；在引用/列表前缀内要折叠，否则尾文会掉出容器。 */
function keepNewlines(text) {
  let out = '';
  for (const ch of text) if (ch === '\n' || ch === '\r') out += ch;
  return out;
}

function containerPrefix(out) {
  const line = out.slice(out.lastIndexOf('\n') + 1);
  return /^(?: {0,3}>| {0,3}[-+*][ \t]| {0,3}\d{1,9}[.)][ \t])/.test(line);
}

function mergeStripRanges(source, comments) {
  const merged = [];
  for (const range of comments) {
    const last = merged[merged.length - 1];
    const gap = last ? source.slice(last.to, range.from) : '';
    if (last && (range.from <= last.to || /^[ \t]*$/.test(gap))) {
      last.to = Math.max(last.to, range.to);
      last.block = last.block || range.block;
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

/** 当前输出行是否只剩「最多 3 空格 + 引用/列表标记 + 空白」；cols 是标记后的前导空格数。 */
function blockState(out) {
  const line = out.slice(out.lastIndexOf('\n') + 1);
  let i = 0;
  let sawMarker = false;
  let cols = 0;

  for (;;) {
    let j = i;
    let lead = 0;
    while (line[j] === ' ' && lead < 4) {
      j++;
      lead++;
    }
    if (line[j] !== '>') break;
    j++;
    if (line[j] === ' ' || line[j] === '\t') j++;
    let spaces = 0;
    while (line[j] === ' ' || line[j] === '\t') {
      spaces += line[j] === '\t' ? 4 : 1;
      j++;
    }
    i = j;
    cols = spaces;
    sawMarker = true;
  }

  let j = i;
  let lead = 0;
  while (line[j] === ' ' && lead < 4) {
    j++;
    lead++;
  }
  const list = /^([-+*]|\d{1,9}[.)])([ \t]+)/.exec(line.slice(j));
  if (list) {
    i = j + list[0].length;
    let spaces = list[2].length;
    while (line[i] === ' ' || line[i] === '\t') {
      spaces += line[i] === '\t' ? 4 : 1;
      i++;
    }
    cols = spaces;
    sawMarker = true;
  }

  const rest = line.slice(i);
  if (!/^[ \t]*$/.test(rest)) return { block: false, cols: 0 };
  let tail = 0;
  for (const ch of rest) tail += ch === '\t' ? 4 - ((cols + tail) % 4) : 1;
  return { block: true, cols: sawMarker ? cols + tail : i + tail };
}

function blockEscapeIndices(text) {
  let match;
  if ((match = /^(-{3,}|\*{3,}|_{3,})[ \t]*$/.exec(text))) {
    const out = [];
    for (let i = 0; i < match[1].length; i++) out.push(i);
    return out;
  }
  if ((match = /^(=+|-+)[ \t]*$/.exec(text))) {
    const out = [];
    for (let i = 0; i < match[1].length; i++) out.push(i);
    return out;
  }
  if (/^(?:[-*_][ \t]*){3,}$/.test(text)) return [0]; // 带空格的 hr：- - - / * * * / _ _ _
  if ((match = /^(`{3,}|~{3,})/.exec(text))) {
    const out = [];
    for (let i = 0; i < match[1].length; i++) out.push(i);
    return out;
  }
  if (text.startsWith('$$')) return [0, 1];
  if ((match = /^(\d{1,9})([.)])(?:[ \t]|$)/.exec(text))) return [match[1].length];
  if (/^#{1,6}(?:[ \t]|$)/.test(text)) return [0];
  if (text[0] === '>') return [0];
  if (/^[-+*](?:[ \t]|$)/.test(text)) return [0];
  if (HTML_BLOCK_OPEN.test(text)) return [0];
  if (text[0] === '|') return [0];
  if (/^\[[^\]\n]+\]:/.test(text)) return [0];
  return [];
}

function escapeAt(text, indices) {
  let out = '';
  let last = 0;
  for (const index of indices) {
    out += text.slice(last, index) + '\\';
    last = index;
  }
  return out + text.slice(last);
}

/**
 * 把注释删除后紧邻的可见片段接上。只处理该片段的第一行：行首补位/块级转义。
 * 片段内部后面的行是原文，不动。
 */
function appendGuarded(out, text, mode) {
  if (!text) return out;
  if (mode === 'text') return out + text;
  const state = blockState(out);
  if (!state.block) return out + text;

  const nl = text.search(/[\r\n]/);
  const head = nl < 0 ? text : text.slice(0, nl);
  const tail = nl < 0 ? '' : text.slice(nl);

  let i = 0;
  let cols = state.cols;
  while (i < head.length) {
    const ch = head[i];
    if (ch !== ' ' && ch !== '\t') break;
    const advance = ch === '\t' ? 4 - (cols % 4) : 1;
    if (cols + advance <= 3) {
      out += ch;
      cols += advance;
    }
    i++;
  }
  if (i >= head.length) return out + tail;

  const rest = head.slice(i);
  return out + escapeAt(rest, blockEscapeIndices(rest)) + tail;
}

/** 表格行内的注释：保留未转义 `|`，否则导出列数会与编辑器表格结构不一致。 */
function keepTablePipes(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '|') {
      i++; // 转义管道不参与列切分，随注释一起删除，避免反过来制造分隔符
      continue;
    }
    if (ch === '|') out += '|';
    else if (ch === '\n' || ch === '\r') out += ch;
  }
  return out;
}

function stripComments(source, comments, mode, tables = []) {
  const ranges = mergeStripRanges(source, comments);
  let out = '';
  let pos = 0;
  let guardNext = false;

  for (const range of ranges) {
    const from = Math.max(pos, range.from);
    const to = Math.max(from, range.to);
    if (to <= pos) continue;

    const before = source.slice(pos, from);
    out = guardNext ? appendGuarded(out, before, mode) : out + before;
    guardNext = false;

    const prev = out.length ? out[out.length - 1] : '';
    const next = source[to] || '';
    if (prev && next && !isSpace(prev) && !isSpace(next) &&
        !HTML_PUNCT.has(prev) && !HTML_PUNCT.has(next)) out += ' ';

    const inTable = !range.block && insideAny(tables, from);
    if (inTable) out += keepTablePipes(source.slice(from, to));
    else if (range.block && !containerPrefix(out)) out += keepNewlines(source.slice(from, to));
    pos = to;
    guardNext = blockState(out).block;
  }

  const tail = source.slice(pos);
  return guardNext ? appendGuarded(out, tail, mode) : out + tail;
}

/**
 * 公开快照：删除真注释，保留代码/数学/转义与行结构。
 * 结果长度通常小于 source；调用方必须当成新文档。
 * @param {string} source
 * @param {{ mathRanges?: Array<{from:number,to:number}>, mode?: 'render'|'text' }} [options]
 * @returns {string}
 */
export function publicMarkdown(source, options = {}) {
  const text = String(source == null ? '' : source);
  if (text.indexOf('<!--') < 0) return text; // 无注释快速退出
  const analysis = analyzePublic(text, options);
  if (!analysis.comments.length) return text;
  return stripComments(text, analysis.comments, options.mode === 'text' ? 'text' : 'render', analysis.tables);
}
