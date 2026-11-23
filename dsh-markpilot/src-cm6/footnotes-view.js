import { EditorSelection, Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap } from '@codemirror/view';
import { markdownLanguage } from '@codemirror/lang-markdown';
import footnotes from './footnotes.cjs';
import { markdownContext } from './markdown-context.js';
import { analyzePublic } from './public-markdown.js';

const { collectFootnotes, hasStructuralChars, resolveBackTarget } = footnotes;

/* 与引擎同一个已配置 parser（main.js 的 markdownLanguage），只交给 footnotes.cjs
   取 InlineCode / CodeBlock / FencedCode / CommentBlock 区间；本模块不另建 Markdown
   解析器。collectFootnotes 在文档无 "[^" 时早退，不会调用 parser.parse。 */
const FOOTNOTE_CODE_PARSER = markdownLanguage.parser;

/**
 * footnotes-view.js — CM6 编辑面的脚注投影与双向导航。
 *
 * 设计边界：
 *   · 正文永远是源文本；这里只加 Decoration，不改一行源码；
 *   · 引用未解析（没有对应定义）时不生成任何活链接，保留原文；
 *   · 引用被光标/选区碰到时显示源码（可改标签）；定义被碰到时显示 `[^label]:` 源码；
 *   · 点正文上标跳到**实际定义**（定义在文中就跳文中，新增脚注默认写在文末）；
 *     定义左侧有独立小返回按钮，按“本次触发的那一处引用”回跳（重复引用不会串位）；
 *   · 位置随文档变化映射；换文档（setState）时状态字段重建，不会沿用上一份文档的落点。
 *
 * 性能：footnoteStateField 只在“结构字符 / 结构区间 / 行首缩进区 / 容器重建 / 注释边界”
 * 变化时全量重扫；普通正文（行中）打字只做 O(脚注数) 的位置映射，并在改动落入定义正文时
 * 只重算那一条的 text。
 *   · 文档没有 "[^" 时直接返回空索引：不 toString 之后的全量分析、不扫行内标记、不碰 parser；
 *   · 文档有 "[^" 但没有 "<!--" 时只用 parser 的 FencedCode/CommentBlock 区间，不跑 analyzePublic；
 *   · 只有同时含 "[^" 与 "<!--" 时，才调用 analyzePublic 取真正的 comments（含 closed），
 *     并复用它算好的 code 区间；注释里的 ``` / [^x] 与单行/块/引用容器注释都由该真源统一决定。
 * 围栏真源是 Lezer `FencedCode`（容器隐式闭合、CRLF、反缩进都正确），
 * 不再把 markdownContext.scanFenceLines 当脚注 opaque 的第二份真源。
 * 投影侧按 inlineMarksField 的数组 identity 缓存排序/合并后的阻挡区间（选区变化零重建），
 * 每个引用二分查询；引用表直接读 note.refs；无定义/无引用时直接返回空投影。
 */

const STATS = { scans: 0, maps: 0, lastScanMs: 0, lastMapMs: 0, lastDocLength: 0 };
const noteBody = raw => String(raw).split(/\r\n?|\n/)
  .map((line, index) => index === 0 ? line : (line[0] === '\t' ? line.slice(1) : line.replace(/^ {1,4}/, '')))
  .join('\n');

function structuralRanges(index) {
  const ranges = [];
  for (const ref of index.refs) ranges.push({ from: ref.from, to: ref.to });
  for (const note of index.notes) ranges.push({ from: note.markerFrom, to: note.markerTo });
  return ranges;
}

/** 一次取齐“注释 + 代码”真源（只有出现 "<!--" 才解析；closed 由 analyzePublic 给出，
 *  不在这里用“range 末尾像不像 -->”二次猜语法）。返回 code 非空时调用方不再 parse。 */
function analyzeDocument(text) {
  if (text.indexOf('<!--') === -1) return { comments: [], code: null };
  try {
    const analysis = analyzePublic(text);
    return {
      comments: (analysis.comments || []).map(c => ({
        from: c.from,
        to: c.to,
        block: !!c.block,
        closed: c.closed !== false,
      })),
      code: [...(analysis.code || [])],
    };
  } catch { return { comments: null, code: null, failed: true }; }
}

/** 生产索引输入：有 analyzePublic 的 code 时不再 parse；否则交给 parser（FencedCode 权威）。
 *  两者都标 authoritative：footnotes.cjs 会跳过旧围栏自扫（旧自扫不认注释/容器/CRLF）。
 *  解析失败时 comments=null（不把“失败空数组”当成“没有注释”）。 */
function contextFor(text) {
  const { comments, code } = analyzeDocument(text);
  if (code) return { code, comments, authoritative: true };
  return comments === null
    ? { parser: FOOTNOTE_CODE_PARSER, authoritative: true }
    : { parser: FOOTNOTE_CODE_PARSER, comments, authoritative: true };
}

function emptyIndex() {
  return { refs: [], notes: [], _structural: [], _comments: [], _hasOpener: false };
}

function makeIndex(state) {
  const text = state.doc.toString();
  /* 【零脚注快路径】没有 "[^" 就没有引用/定义；先早退，避免为提取 comments 扫全篇
     inlineMarks / 调 analyzePublic。换行/冒号等结构字符不再让长文付全量分析。 */
  if (text.indexOf('[^') === -1) {
    STATS.scans++;
    STATS.lastDocLength = text.length;
    return emptyIndex();
  }
  const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const context = contextFor(text);
  const index = collectFootnotes(text, context);
  index._structural = structuralRanges(index);
  index._comments = (context.comments || []).map(c => ({ ...c }));
  index._hasOpener = true;
  STATS.scans++;
  STATS.lastScanMs = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started) * 1000) / 1000;
  STATS.lastDocLength = text.length;
  return index;
}

function insideOrTouching(ranges, from, to, emptyAt) {
  for (const range of ranges) {
    if (from < range.to && to > range.from) return true;
    if (emptyAt && from > range.from && from < range.to) return true;
  }
  return false;
}

/* 行首/行类型判据：只比较改动前后这一行的“空白 / 定义起点 / 续行起点”是否发生过渡。
   普通正文在行首打字不改变这些状态 ⇒ 仍走 mapIndex。 */
const NON_BLANK = /\S/;
const DEFINITION_START = /^( {0,3})\[\^[^\]\r\n]+\]:/;
const CONTINUATION_START = /^(?: {4,}|\t)/;
const QUOTE_PREFIX = /^ {0,3}>[ \t]?/;
// front-matter 的 `---` 围栏不是结构字符，但会让其中的定义整段变成 opaque；改动围栏必须重扫。
const FRONT_MATTER_FENCE = /^(?:\uFEFF?---|\.\.\.)[ \t]*$/;

/** 行首（可带引用前缀）是否进入 4 空格/Tab 缩进代码区。
 *  parser 的 CodeBlock 只看块级上下文；这里只回答“这一行是否带代码缩进”，
 *  用来在缩进跨过 4 空格的第一时间让脚注索引失效。 */
function codeIndent(text) {
  let off = 0;
  for (;;) {
    const match = QUOTE_PREFIX.exec(text.slice(off));
    if (!match) break;
    off += match[0].length;
  }
  return CONTINUATION_START.test(text.slice(off));
}

const LIST_PREFIX = /^( {0,3})(?:[-+*]|\d{1,9}[.)])(?:[ \t]+)/;

/** 这一行去掉引用/列表前缀后的内容是否以 `<!--` 起手（块注释的“行首态”）。
 *  单行注释与块注释都由 analyzePublic 决定边界；这里只用来在“行首被普通字占掉，
 *  块注释退化成行内字面”的第一时间让脚注索引失效。 */
function commentBlockStart(text) {
  let off = 0;
  for (;;) {
    const match = QUOTE_PREFIX.exec(text.slice(off));
    if (!match) break;
    off += match[0].length;
  }
  const list = LIST_PREFIX.exec(text.slice(off));
  if (list) off += list[0].length;
  off += /^ {0,3}/.exec(text.slice(off))[0].length;
  return text.slice(off).startsWith('<!--');
}

/** 行首容器几何：引用深度 + 0-3 空格缩进 + 列表 marker 宽度。
 *  `- `→`1. `、列表围栏 1→2 空格、引用深度变化都会改变围栏/注释归属，
 *  这些字符本身不在 STRUCTURAL_CHARS 里，必须单独触发全扫（F4/F5/F6/R13）。 */
function containerShape(text) {
  let off = 0, quote = 0;
  for (;;) {
    const match = QUOTE_PREFIX.exec(text.slice(off));
    if (!match) break;
    off += match[0].length;
    quote++;
  }
  const spaces = /^ */.exec(text.slice(off))[0].length;
  const list = LIST_PREFIX.exec(text.slice(off));
  return quote + '|' + spaces + '|' + (list ? list[0].length : 0);
}

function lineRole(text) {
  if (!NON_BLANK.test(text)) return { blank: true, definition: false, continuation: false };
  return {
    blank: false,
    definition: DEFINITION_START.test(text),
    continuation: CONTINUATION_START.test(text),
  };
}

function previousNonBlankLine(doc, number) {
  for (let n = number - 1; n >= 1; n--) {
    const line = doc.line(n);
    if (NON_BLANK.test(line.text)) return line;
  }
  return null;
}

function nextNonBlankLine(doc, number) {
  for (let n = number + 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (NON_BLANK.test(line.text)) return line;
  }
  return null;
}

/** 改动前后同一行的行类型是否发生“会改变脚注定义/续行”的过渡。
 *  空行只有在“上一条非空行是定义/续行，且下方还存在续行”时才会改变定义范围；
 *  普通段落的第一个字（Home 后打字）不命中。 */
function lineStructureTransition(tr, fromA, fromB) {
  const beforeDoc = tr.startState.doc;
  const afterDoc = tr.state.doc;
  const beforeLine = beforeDoc.lineAt(Math.min(fromA, beforeDoc.length));
  const afterLine = afterDoc.lineAt(Math.min(fromB, afterDoc.length));
  if (FRONT_MATTER_FENCE.test(beforeLine.text) || FRONT_MATTER_FENCE.test(afterLine.text)) return true;
  if (commentBlockStart(beforeLine.text) !== commentBlockStart(afterLine.text)) return true;
  if (containerShape(beforeLine.text) !== containerShape(afterLine.text)) return true;
  const beforeRole = lineRole(beforeLine.text);
  const afterRole = lineRole(afterLine.text);
  if (beforeRole.definition !== afterRole.definition) return true;
  /* 新增/取消 4 空格（或 Tab）缩进代码：脚注文法是否把这一行当 CodeBlock 会变。
     这一条必须独立于“上方是否定义/续行”——顶层的 `    [^x]` 也可被缩进出/缩进没。
     跨行 InlineCode 的新增/取消由反引号/换行（hasStructuralChars）负责，二者合起来
     覆盖“code 区间变了但 refs/notes 位置未相交”的增量失效。 */
  if (codeIndent(beforeLine.text) !== codeIndent(afterLine.text)) return true;
  const continuationChanged = beforeRole.continuation !== afterRole.continuation;
  const blankChanged = beforeRole.blank !== afterRole.blank;
  if (!continuationChanged && !blankChanged) return false;
  const prev = previousNonBlankLine(beforeDoc, beforeLine.number);
  const prevRole = prev ? lineRole(prev.text) : null;
  // 续行只向上附着：上方没有定义/续行时，ordinary↔continuation 不改变任何脚注。
  if (continuationChanged) return !!(prevRole && (prevRole.definition || prevRole.continuation));
  // 空行过渡：只有“上方是定义/续行且下方还存在续行”时才会改变定义范围。
  if (!prevRole || (!prevRole.definition && !prevRole.continuation)) return false;
  const next = nextNonBlankLine(afterDoc, afterLine.number);
  return !!next && lineRole(next.text).continuation;
}

function needsFullScan(tr, index) {
  /* 【零脚注快路径】当前索引里从未出现过 "[^"：只有改动缝里真的拼出 "[^"（插入或删除
     后相邻）才需要重建。换行/冒号/括号等普通结构输入不再触发整篇 toString + 注释提取。 */
  if (!index._hasOpener) {
    let maybeFootnote = false;
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      if (maybeFootnote) return;
      if (inserted.toString().includes('[^')) { maybeFootnote = true; return; }
      const doc = tr.state.doc;
      const from = Math.max(0, fromB - 1);
      const to = Math.min(doc.length, toB + 1);
      if (doc.sliceString(from, to).includes('[^')) maybeFootnote = true;
    });
    if (!maybeFootnote) return false;
  }
  /* 容器/围栏结构这一笔真的重建了 ⇒ opaque 可能整体变化（引用/列表隐式闭合、围栏开合）。
     markdownContext 的增量闸门已经把“会不会重建”算好，这里直接消费，不重复判断。 */
  if (tr.state.field(markdownContext, false)?.rebuilt) return true;
  let scan = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (scan) return;
    const deleted = tr.startState.doc.sliceString(fromA, toA);
    const added = inserted.toString();
    // 结构字符：能新建/删除结构（`[`/`]`/`^`/`:`/换行…）。
    if (hasStructuralChars(deleted) || hasStructuralChars(added)) { scan = true; return; }
    /* 注释边界：在 `<!--` 所在行的行首之前插入普通字（如行首补一个 x）会让块注释变成
       行内字面，但字符本身不是结构字符；注释两端/行首附近的改动一律重扫。正文内部打字
       不触发（注释里的脚注本来就不参与编号）。 */
    for (const comment of index._comments || []) {
      const lineFrom = tr.startState.doc.lineAt(Math.min(comment.from, tr.startState.doc.length)).from;
      if (fromA <= comment.from && toA >= lineFrom) { scan = true; return; }
      if (fromA <= comment.to && toA >= Math.max(comment.from, comment.to - 3)) { scan = true; return; }
    }
    const empty = fromA === toA;
    for (const range of index._structural) {
      if (fromA < range.to && toA > range.from) { scan = true; return; }
      if (empty && fromA > range.from && fromA < range.to) { scan = true; return; }
    }
    // 定义标记的边界（冒号后的可选空白 / 正文起点）也按结构处理：任何改动只要与
    // [markerTo, textFrom] 这段边界相交，就可能让 mapIndex 的 textFrom 与 fresh 错位。
    for (const note of index.notes) {
      if (fromA <= note.textFrom && toA >= note.markerTo) { scan = true; return; }
    }
    // 行首缩进/空行/行类型过渡：3↔4、Tab↔空格、定义↔段落、续行增删、空行接续行。
    // 普通字在行首（Home 后打字）不改变这些状态 ⇒ 不重扫，继续只做映射。
    if (lineStructureTransition(tr, fromA, fromB)) scan = true;
  });
  return scan;
}

function mapIndex(value, tr) {
  const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const map = (pos, assoc) => tr.changes.mapPos(pos, assoc);
  const notes = value.notes.map(note => {
    const next = {
      ...note,
      from: map(note.from, 1),
      to: map(note.to, 1),
      markerFrom: map(note.markerFrom, 1),
      markerTo: map(note.markerTo, 1),
      textFrom: map(note.textFrom, 1),
      textTo: map(note.textTo, 1),
      refs: [],
    };
    return next;
  });
  const refs = value.refs.map(ref => ({
    ...ref,
    from: map(ref.from, 1),
    to: map(ref.to, -1),
  }));
  const byNote = new Map();
  for (const ref of refs) {
    if (!ref.noteId) continue;
    if (!byNote.has(ref.noteId)) byNote.set(ref.noteId, []);
    byNote.get(ref.noteId).push(ref);
  }
  for (const note of notes) note.refs = byNote.get(note.noteId) || [];

  const affected = new Set();
  tr.changes.iterChanges((fromA, toA) => {
    for (let i = 0; i < value.notes.length; i++) {
      const note = value.notes[i];
      if ((fromA < note.textTo && toA > note.textFrom) ||
          (fromA === toA && fromA >= note.textFrom && fromA <= note.textTo)) affected.add(i);
    }
  });
  for (const i of affected) {
    const note = notes[i];
    note.text = noteBody(tr.state.doc.sliceString(note.textFrom, note.textTo));
  }

  STATS.maps++;
  STATS.lastMapMs = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started) * 1000) / 1000;
  STATS.lastDocLength = tr.state.doc.length;
  return {
    ...value,
    notes,
    refs,
    _structural: structuralRanges({ refs, notes }),
    _comments: (value._comments || []).map(c => ({ ...c, from: map(c.from, 1), to: map(c.to, -1) })),
  };
}

const footnoteStateField = StateField.define({
  create(state) { return makeIndex(state); },
  update(value, tr) {
    if (!tr.docChanged) return value;
    if (needsFullScan(tr, value)) return makeIndex(tr.state);
    return mapIndex(value, tr);
  },
});

const setFootnoteNav = StateEffect.define();
const footnoteNavField = StateField.define({
  create() { return null; },
  update(value, tr) {
    let next = value;
    if (tr.docChanged && next) {
      next = { ...next, refFrom: tr.changes.mapPos(next.refFrom, 1), refTo: tr.changes.mapPos(next.refTo, -1) };
    }
    for (const effect of tr.effects) if (effect.is(setFootnoteNav)) next = effect.value;
    return next;
  },
});

function selectionTouches(state, from, to) {
  return state.selection.ranges.some(range => range.from <= to && range.to >= from);
}

function noteFor(index, labelOrId) {
  return index.notes.find(note => note.noteId === labelOrId) ||
    index.notes.find(note => note.label === labelOrId) || null;
}

/** collectFootnotes / mapIndex 都会维护 note.refs；旧的整表 filter 在 160×160 时
 *  每次投影要扫 25600 次引用。直接读 note.refs 只跟该注的引用数成正比。 */
function refsFor(index, note) {
  return note.refs || [];
}

function goToNote(view, ref) {
  const index = view.state.field(footnoteStateField, false);
  if (!index) return false;
  const note = noteFor(index, ref.noteId) || noteFor(index, ref.label);
  if (!note) return false;
  const target = Math.max(0, Math.min(note.textFrom, view.state.doc.length));
  view.dispatch({
    selection: EditorSelection.cursor(target),
    effects: setFootnoteNav.of({
      label: note.label, noteId: note.noteId, number: note.number,
      refId: ref.refId, refFrom: ref.from, refTo: ref.to, occurrence: ref.occurrence,
    }),
    scrollIntoView: true,
    userEvent: 'select.pointer',
  });
  view.focus();
  return true;
}

/** 回链目标解析由 footnotes.cjs 提供纯函数实现（单测直接覆盖“重排/删除/无状态”三分支）。 */
export { resolveBackTarget };

function goBack(view, note) {
  const index = view.state.field(footnoteStateField, false);
  if (!index) return { ok: false, reason: 'no-view' };
  const nav = view.state.field(footnoteNavField, false);
  const resolved = resolveBackTarget(index, nav, note);
  if (!resolved.target) {
    if (resolved.reason === 'target-gone') view.dispatch({ effects: setFootnoteNav.of(null) });
    return { ok: false, reason: resolved.reason };
  }
  const target = resolved.target;
  view.dispatch({
    selection: EditorSelection.cursor(target.from),
    effects: setFootnoteNav.of({
      label: note.label, noteId: note.noteId, number: note.number,
      refId: target.refId, refFrom: target.from, refTo: target.to, occurrence: target.occurrence,
    }),
    scrollIntoView: true,
    userEvent: 'select.pointer',
  });
  view.focus();
  return { ok: true, ref: target };
}

function revealSource(view, ref) {
  const target = Math.max(0, Math.min(ref.from, view.state.doc.length));
  view.dispatch({
    selection: EditorSelection.cursor(target),
    scrollIntoView: true,
    userEvent: 'select.pointer',
  });
  view.focus();
  return true;
}

function noteAt(index, pos) {
  return index.notes.find(note => pos >= note.from && pos <= note.to) || null;
}

function refAt(index, pos) {
  return index.refs.find(ref => ref.resolved && pos >= ref.from && pos <= ref.to) || null;
}

function footnoteJump(view) {
  const index = view.state.field(footnoteStateField, false);
  if (!index) return false;
  const head = view.state.selection.main.head;
  const ref = refAt(index, head);
  if (ref) return goToNote(view, ref);
  const note = noteAt(index, head);
  if (note) return goBack(view, note).ok === true;
  return false;
}

function chooseLabel(index) {
  const used = new Set();
  for (const ref of index.refs) used.add(ref.label);
  for (const note of index.notes) used.add(note.label);
  let n = 1;
  while (used.has(String(n))) n++;
  return String(n);
}

function eolOf(source) {
  const nl = source.indexOf('\n');
  if (nl <= 0) return '\n';
  return source.charCodeAt(nl - 1) === 13 ? '\r\n' : '\n';
}

function applyChanges(source, changes) {
  let out = source;
  for (const change of [...changes].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, change.from) + change.insert + out.slice(change.from);
  }
  return out;
}

/**
 * 插入脚注的纯决策层（不碰 view，便于 Node 回归）。
 * 不再用“尾注释/尾围栏 → 先拒绝”这种前置条件（同一个 closed:false 在顶层与引用容器里
 * 结论相反），而是按拟定 changes 生成 **post 文本**，用同一轨解析检查：
 *   · 新 ref 在 refStart 处存在且 resolved；
 *   · 新定义在 post 末尾被识别成同一条 note（noteId 相同）；
 *   · 原有 note 的 label 全部还在（直接 insert 不得破坏相邻定义）。
 * 任何一项不成立就不返回 changes ⇒ 调用方 0 dispatch，原文/选区全不动。
 * 成功只 dispatch 这一份 changes，selection=post.length，一次 undo 回原文。
 */
export function planFootnoteInsertion(text, head, label, options = null) {
  const source = String(text == null ? '' : text);
  const pos = Math.max(0, Math.min(source.length, Number.isFinite(head) ? head : 0));
  const eol = eolOf(source);
  const marker = '[^' + label + ']';
  const defText = marker + ': ';
  const atEnd = pos === source.length;

  let changes;
  if (atEnd) {
    /* head 在文末：ref 后**总是**补一个空行再写定义。否则 `Hello\n\n` + head=len 会拼出
       `[^1][^1]: `（R9）、空文档同样（R10）。 */
    changes = [{ from: pos, insert: marker + eol + eol + defText }];
  } else {
    const endsBlank = source.endsWith(eol + eol);
    const endsEol = source.endsWith(eol);
    const suffix = endsBlank ? defText : endsEol ? eol + defText : eol + eol + defText;
    changes = [{ from: pos, insert: marker }, { from: source.length, insert: suffix }];
  }

  const planned = applyChanges(source, changes);
  const refStart = pos;
  const refEnd = pos + marker.length;
  const defStart = planned.length - defText.length;

  let index;
  try {
    const analysis = analyzeDocument(planned);
    index = analysis.code
      ? collectFootnotes(planned, { code: analysis.code, comments: analysis.comments, authoritative: true })
      : collectFootnotes(planned, analysis.comments === null
        ? { parser: FOOTNOTE_CODE_PARSER, authoritative: true }
        : { parser: FOOTNOTE_CODE_PARSER, comments: analysis.comments, authoritative: true });
  } catch { return { ok: false, reason: 'verify-failed' }; }

  const ref = index.refs.find(item => item.label === label && item.from === refStart && item.to === refEnd) || null;
  if (!ref) return { ok: false, reason: 'ref-hidden' };
  const note = index.notes.find(item => item.label === label && item.from === defStart) || null;
  if (!note) return { ok: false, reason: 'def-hidden' };
  if (!ref.resolved || ref.noteId !== note.noteId) return { ok: false, reason: 'def-hidden' };
  const existingLabels = options && Array.isArray(options.existingLabels) ? options.existingLabels : null;
  if (existingLabels) {
    for (const existing of existingLabels) {
      if (!index.notes.some(item => item.label === existing)) return { ok: false, reason: 'def-hidden' };
    }
  }
  return { ok: true, label, changes, cursor: planned.length };
}

function insertFootnote(view, tableField = null) {
  if (!view || view.state.readOnly) return { ok: false, reason: 'readonly' };
  const head = view.state.selection.main.head;
  const text = view.state.doc.toString();
  const tables = tableField ? (view.state.field(tableField, false) || []) : [];
  if (tables.some(table => head >= table.from && head <= table.to)) return { ok: false, reason: 'table' };
  const index = view.state.field(footnoteStateField, false) || collectFootnotes(text, contextFor(text));
  const label = chooseLabel(index);
  const plan = planFootnoteInsertion(text, head, label, {
    existingLabels: index.notes.map(note => note.label),
  });
  if (!plan.ok) return plan;
  view.dispatch({
    changes: plan.changes,
    selection: EditorSelection.cursor(plan.cursor),
    scrollIntoView: true,
    userEvent: 'input',
  });
  view.focus();
  return { ok: true, label };
}

function footnoteAction(view, tableField = null) {
  const index = view.state.field(footnoteStateField, false);
  if (!index) return { ok: false, reason: 'no-view' };
  const head = view.state.selection.main.head;
  const ref = refAt(index, head);
  if (ref) return { ok: goToNote(view, ref), kind: 'note' };
  const note = noteAt(index, head);
  if (note) {
    const result = goBack(view, note);
    return { ok: result.ok, kind: 'back', reason: result.reason };
  }
  return { ...insertFootnote(view, tableField), kind: 'insert' };
}

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById('mp-fn-style')) return;
  const style = document.createElement('style');
  style.id = 'mp-fn-style';
  style.textContent = [
    '.mp-fn-def{background:color-mix(in srgb,var(--mp-quoteBg,#f3f3f3) 55%,transparent);color:var(--mp-fg);}',
    '.mp-fn-def-mark{display:inline-flex;align-items:center;gap:4px;margin-right:6px;pointer-events:none;font-size:.78em;vertical-align:baseline;user-select:none;}',
    '.mp-fn-num{display:inline-flex;align-items:center;justify-content:center;min-width:1.35em;height:1.35em;padding:0 .25em;border-radius:999px;background:var(--mp-primary,#3b82f6);color:var(--mp-bg,#fff);font:600 .9em/1 var(--mp-font-latin,system-ui,sans-serif);}',
    '.mp-fn-back{pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;width:1.45em;height:1.45em;padding:0;border:1px solid var(--mp-border,#ccc);border-radius:4px;background:var(--mp-capsule,#eee);color:var(--mp-fg,#222);font:500 .9em/1 system-ui,sans-serif;cursor:pointer;}',
    '.mp-fn-back:hover{border-color:var(--mp-primary,#3b82f6);color:var(--mp-primary,#3b82f6);}',
    '.mp-fn-back:disabled{opacity:.4;cursor:default;}',
    '.mp-fn-back-only{display:inline-flex;align-items:center;pointer-events:none;margin-right:4px;vertical-align:baseline;}',
    '.mp-fn-ref{display:inline;border:0;background:transparent;color:var(--mp-primary,#3b82f6);font:inherit;font-size:.72em;line-height:1;vertical-align:super;padding:0 1px;margin:0 1px;border-radius:3px;cursor:pointer;}',
    '.mp-fn-ref:hover{background:color-mix(in srgb,var(--mp-primary,#3b82f6) 14%,transparent);}',
    '.mp-fn-ref:focus-visible,.mp-fn-back:focus-visible{outline:2px solid var(--mp-primary,#3b82f6);outline-offset:1px;}',
  ].join('\n');
  document.head.appendChild(style);
}

class FootnoteRefWidget extends WidgetType {
  constructor(ref) { super(); this.ref = ref; }
  eq(other) {
    const a = this.ref, b = other.ref;
    return a.refId === b.refId && a.number === b.number && a.label === b.label &&
      a.from === b.from && a.to === b.to && a.noteId === b.noteId;
  }
  toDOM(view) {
    const ref = this.ref;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mp-fn-ref';
    button.contentEditable = 'false';
    button.tabIndex = 0;
    button.textContent = String(ref.number);
    button.title = '脚注 ' + ref.number + '：' + ref.label + '（点击跳到定义，Alt+点击编辑源码）';
    button.setAttribute('aria-label', '脚注 ' + ref.number + '：' + ref.label);
    button.setAttribute('aria-keyshortcuts', 'Control+Alt+Enter');
    button.dataset.mpFnRef = ref.refId;
    button.dataset.mpFnN = String(ref.number);
    button.dataset.mpFnFrom = String(ref.from);
    button.dataset.mpFnTo = String(ref.to);
    button.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (event.altKey) revealSource(view, ref);
      else goToNote(view, ref);
    });
    button.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      goToNote(view, ref);
    });
    return button;
  }
  ignoreEvent() { return true; }
}

function makeBackButton(view, note, target) {
  const hasRefs = note.refs.length > 0;
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'mp-fn-back';
  back.tabIndex = 0;
  back.textContent = '↩';
  back.disabled = !hasRefs;
  back.title = hasRefs ? '返回引用（第 ' + note.number + ' 条脚注）' : '没有引用指向这条脚注';
  back.setAttribute('aria-label', hasRefs ? '返回第 ' + note.number + ' 条脚注的引用' : '没有引用指向这条脚注');
  back.setAttribute('aria-keyshortcuts', 'Control+Alt+Enter');
  back.dataset.mpFnBack = note.noteId;
  back.dataset.mpFnTarget = (target && target.refId) || '';
  back.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
  const backOnce = () => {
    if (!hasRefs) return;
    const result = goBack(view, note);
    if (result.ok === false && result.reason === 'target-gone') {
      try { window.mpExtras?.toast?.('原来的引用已被删除，未跳转；再点一次 ↩ 可回到第一条引用'); } catch { /* 无扩展宿主时保持静默 */ }
    }
  };
  back.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    backOnce();
  });
  back.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    backOnce();
  });
  return back;
}

class FootnoteDefWidget extends WidgetType {
  constructor(note, target) { super(); this.note = note; this.target = target; }
  eq(other) {
    const a = this.note, b = other.note;
    const ta = this.target, tb = other.target;
    return a.noteId === b.noteId && a.number === b.number && a.markerFrom === b.markerFrom &&
      a.markerTo === b.markerTo && a.textFrom === b.textFrom && a.label === b.label &&
      (ta && ta.refId || '') === (tb && tb.refId || '');
  }
  toDOM(view) {
    const note = this.note;
    const wrap = document.createElement('span');
    wrap.className = 'mp-fn-def-mark';
    wrap.contentEditable = 'false';
    wrap.dataset.mpFnNote = note.noteId;
    wrap.dataset.mpFnN = String(note.number);
    const num = document.createElement('span');
    num.className = 'mp-fn-num';
    num.textContent = String(note.number);
    num.setAttribute('aria-hidden', 'true');
    wrap.appendChild(num);
    wrap.appendChild(makeBackButton(view, note, this.target));
    return wrap;
  }
  ignoreEvent() { return true; }
}

/** 光标进入定义、显示 `[^label]:` 源码时，仍保留一个独立小回链按钮；
 *  否则“跳到定义后按钮消失”，用户只能先移开光标才能返回。 */
class FootnoteBackWidget extends WidgetType {
  constructor(note, target) { super(); this.note = note; this.target = target; }
  eq(other) {
    const a = this.note, b = other.note;
    const ta = this.target, tb = other.target;
    return a.noteId === b.noteId && a.number === b.number && a.markerFrom === b.markerFrom &&
      a.textFrom === b.textFrom && a.label === b.label &&
      (ta && ta.refId || '') === (tb && tb.refId || '');
  }
  toDOM(view) {
    const wrap = document.createElement('span');
    wrap.className = 'mp-fn-back-only';
    wrap.contentEditable = 'false';
    wrap.dataset.mpFnNote = this.note.noteId;
    wrap.dataset.mpFnN = String(this.note.number);
    wrap.appendChild(makeBackButton(view, this.note, this.target));
    return wrap;
  }
  ignoreEvent() { return true; }
}

/** 与旧 blocked(ref) 的谓词逐字一致：
 *   · image / comment mark ⇒ 整个 [mark.from, mark.to]；
 *   · 其它 mark ⇒ 它的每个 hides 区间。
 *  排序后合并相接/相交区间；查询保持严格相交（端点相碰不算冲突）。 */
function collectBlockedRanges(inline) {
  const ranges = [];
  for (let i = 0; i < inline.length; i++) {
    const mark = inline[i];
    if (mark.image || mark.comment) {
      ranges.push({ from: mark.from, to: mark.to });
      continue;
    }
    const hides = mark.hides;
    if (!hides) continue;
    for (let j = 0; j < hides.length; j++) {
      const range = hides[j];
      ranges.push({ from: range[0], to: range[1] });
    }
  }
  if (ranges.length < 2) return ranges;
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const range = ranges[i];
    const last = merged[merged.length - 1];
    if (range.from <= last.to) {
      if (range.to > last.to) last.to = range.to;
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/** 合并后区间按 from 递增且互不相交 ⇒ to 也递增。二分取最后一个 from < ref.to 的区间，
 *  它的 to 就是所有起点在 ref.to 之前的区间里最大的 to；to > ref.from 即严格相交。 */
function blockedByRanges(ranges, from, to) {
  let low = 0;
  let high = ranges.length - 1;
  let last = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (ranges[mid].from < to) {
      last = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return last >= 0 && ranges[last].to > from;
}

/** inlineMarksField 内容变化时 main.js 总会返回新数组（scan/map 都建新数组），
 *  而选区/光标变化时 update 直接返回原值 ⇒ 以数组 identity 做 WeakMap 键，
 *  正好把“拖选/移动光标”与“marks 真的变了”区分开。数组内的 mark 对象在投影侧只读。
 *  blocked() 只会在遇到 resolved 引用后调用，因此“无 resolved 引用”不会遍历 marks。 */
const EMPTY_INLINE_MARKS = [];
const blockedRangesByMarks = new WeakMap();

function blockedRangesFor(inline) {
  let ranges = blockedRangesByMarks.get(inline);
  if (ranges === undefined) {
    ranges = collectBlockedRanges(inline);
    blockedRangesByMarks.set(inline, ranges);
  }
  return ranges;
}

function createDecorations(deps) {
  const dependencyList = [footnoteStateField, footnoteNavField, 'selection'];
  if (deps.tableDataField) dependencyList.push(deps.tableDataField);
  if (deps.inlineMarksField) dependencyList.push(deps.inlineMarksField);
  return EditorView.decorations.compute(dependencyList, state => {
    const index = state.field(footnoteStateField, false);
    if (!index) return Decoration.none;
    // 没有定义就不可能有 resolved 引用（resolved 的 noteId 必来自 notes）⇒ 投影必为空。
    // 常见无脚注文档在这里直接返回：不读 table/inline 字段，也不会遍历 marks。
    if (!index.notes.length) return Decoration.none;
    const nav = state.field(footnoteNavField, false);
    const out = [];
    for (const note of index.notes) {
      const first = state.doc.lineAt(Math.min(note.from, state.doc.length));
      const last = state.doc.lineAt(Math.min(note.to, state.doc.length));
      for (let number = first.number; number <= last.number; number++) {
        out.push(Decoration.line({ class: 'mp-fn-def', attributes: { 'data-mp-fn-line': note.noteId } })
          .range(state.doc.line(number).from));
      }
      const candidates = refsFor(index, note);
      let target = null;
      if (nav && nav.noteId === note.noteId) target = candidates.find(ref => ref.refId === nav.refId) || null;
      if (!target) target = candidates[0] || null;
      if (selectionTouches(state, note.from, note.to)) {
        // 源码态（光标在定义里/选中定义）仍给出独立的 ↩，不要求用户先移开光标。
        out.push(Decoration.widget({ widget: new FootnoteBackWidget(note, target), side: -1 }).range(note.markerFrom));
        continue;
      }
      const widget = new FootnoteDefWidget(note, target);
      const end = Math.max(note.markerTo, note.textFrom);
      if (end > note.markerFrom) out.push(Decoration.replace({ widget }).range(note.markerFrom, end));
      else out.push(Decoration.widget({ widget, side: -1 }).range(note.markerFrom));
    }
    if (index.refs.length) {
      const tables = deps.tableDataField ? (state.field(deps.tableDataField, false) || []) : [];
      const inline = deps.inlineMarksField ? (state.field(deps.inlineMarksField, false) || EMPTY_INLINE_MARKS) : EMPTY_INLINE_MARKS;
      const inTable = pos => tables.some(table => pos >= table.from && pos <= table.to);
      // 阻挡区间按 marks 数组 identity 缓存：选区变化只做 WeakMap 命中，不重排/重建。
      // 必须先判 resolved；无 resolved 引用时 blocked 一次都不会调用，marks 不会被遍历。
      let blockedRanges = null;
      const blocked = ref => {
        if (blockedRanges === null) blockedRanges = blockedRangesFor(inline);
        return blockedByRanges(blockedRanges, ref.from, ref.to);
      };
      for (const ref of index.refs) {
        if (!ref.resolved || selectionTouches(state, ref.from, ref.to)) continue;
        if (inTable(ref.from) || blocked(ref)) continue;
        out.push(Decoration.replace({ widget: new FootnoteRefWidget(ref) }).range(ref.from, ref.to));
      }
    }
    return Decoration.set(out, true);
  });
}

export function createFootnotesExtension(deps = {}) {
  /* deps 只进本实例的投影闭包（tableDataField/inlineMarksField），不写模块级可变状态：
     多个 view 各自装配不同的可选依赖也不会互相覆盖。注释真源走 analyzePublic（有 "<!--" 时）。 */
  ensureStyle();
  return [
    footnoteStateField,
    footnoteNavField,
    createDecorations(deps),
    Prec.high(keymap.of([
      { key: 'Mod-Alt-Enter', run: view => footnoteJump(view) },
    ])),
  ];
}

export function footnoteIndex(view) {
  return view && view.state ? view.state.field(footnoteStateField, false) : null;
}

export function footnoteNav(view) {
  return view && view.state ? view.state.field(footnoteNavField, false) : null;
}

export function footnoteStats() { return { ...STATS }; }

export function footnoteInsert(view, tableField = null) { return insertFootnote(view, tableField); }

export function footnoteJumpAt(view) { return footnoteJump(view); }

export function footnoteMove(view, tableField = null) { return footnoteAction(view, tableField); }

export function footnoteGoTo(view, labelOrId) {
  const index = footnoteIndex(view);
  const note = index ? noteFor(index, labelOrId) : null;
  if (!note) return false;
  const refs = refsFor(index, note);
  if (!refs.length) {
    view.dispatch({ selection: EditorSelection.cursor(note.textFrom), scrollIntoView: true, userEvent: 'select.pointer' });
    view.focus();
    return true;
  }
  return goToNote(view, refs[0]);
}
