import { EditorSelection, Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap } from '@codemirror/view';
import footnotes from './footnotes.cjs';

const { collectFootnotes, hasStructuralChars, isFootnoteOpaque, isFootnoteTailOpaque, resolveBackTarget } = footnotes;

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
 * 性能：footnoteStateField 只在“结构字符 / 结构区间”变化时全量重扫；普通打字只做
 * O(脚注数) 的位置映射，并在改动落入定义正文时只重算那一条的 text。
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

function makeIndex(text) {
  const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const index = collectFootnotes(text);
  index._structural = structuralRanges(index);
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

function needsFullScan(tr, index) {
  let scan = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (scan) return;
    const deleted = tr.startState.doc.sliceString(fromA, toA);
    if (hasStructuralChars(deleted) || hasStructuralChars(inserted.toString())) { scan = true; return; }
    const empty = fromA === toA;
    for (const range of index._structural) {
      if (fromA < range.to && toA > range.from) { scan = true; return; }
      if (empty && fromA > range.from && fromA < range.to) { scan = true; return; }
    }
    // 定义标记的边界（冒号/空白处）也按结构处理，避免把新字吃进被替换的标记区间。
    for (const note of index.notes) {
      if (empty && fromA >= note.markerFrom && fromA <= note.textFrom) { scan = true; return; }
    }
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
  return { ...value, notes, refs, _structural: structuralRanges({ refs, notes }) };
}

const footnoteStateField = StateField.define({
  create(state) { return makeIndex(state.doc.toString()); },
  update(value, tr) {
    if (!tr.docChanged) return value;
    if (needsFullScan(tr, value)) return makeIndex(tr.state.doc.toString());
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

function refsFor(index, note) {
  return index.refs.filter(ref => ref.resolved && ref.noteId === note.noteId);
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

function insertFootnote(view, tableField = null) {
  if (!view || view.state.readOnly) return { ok: false, reason: 'readonly' };
  const head = view.state.selection.main.head;
  const text = view.state.doc.toString();
  if (isFootnoteOpaque(text, head)) return { ok: false, reason: 'opaque' };
  if (isFootnoteTailOpaque(text)) return { ok: false, reason: 'tail-opaque' };
  const tables = tableField ? (view.state.field(tableField, false) || []) : [];
  if (tables.some(table => head >= table.from && head <= table.to)) return { ok: false, reason: 'table' };
  const index = view.state.field(footnoteStateField, false) || collectFootnotes(text);
  const label = chooseLabel(index);
  const refText = '[^' + label + ']';
  const doc = view.state.doc;
  const tail = doc.length >= 2 ? doc.sliceString(doc.length - 2) : '';
  const suffix = doc.length === 0 ? '[^' + label + ']: '
    : tail === '\n\n' ? '[^' + label + ']: '
      : doc.sliceString(doc.length - 1) === '\n' ? '\n[^' + label + ']: '
        : '\n\n[^' + label + ']: ';
  const changes = doc.length === head
    ? [{ from: head, insert: refText + suffix }]
    : [{ from: head, insert: refText }, { from: doc.length, insert: suffix }];
  const textStart = doc.length + refText.length + suffix.length;
  view.dispatch({
    changes,
    selection: EditorSelection.cursor(Math.min(textStart, doc.length + refText.length + suffix.length)),
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

function createDecorations(deps) {
  const dependencyList = [footnoteStateField, footnoteNavField, 'selection'];
  if (deps.tableDataField) dependencyList.push(deps.tableDataField);
  if (deps.inlineMarksField) dependencyList.push(deps.inlineMarksField);
  return EditorView.decorations.compute(dependencyList, state => {
    const index = state.field(footnoteStateField, false);
    if (!index) return Decoration.none;
    const tables = deps.tableDataField ? (state.field(deps.tableDataField, false) || []) : [];
    const inline = deps.inlineMarksField ? (state.field(deps.inlineMarksField, false) || []) : [];
    const nav = state.field(footnoteNavField, false);
    const inTable = pos => tables.some(table => pos >= table.from && pos <= table.to);
    const blocked = ref => inline.some(mark => {
      if (mark.image || mark.comment) return ref.from < mark.to && ref.to > mark.from;
      return (mark.hides || []).some(([from, to]) => ref.from < to && ref.to > from);
    });
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
    for (const ref of index.refs) {
      if (!ref.resolved || selectionTouches(state, ref.from, ref.to)) continue;
      if (inTable(ref.from) || blocked(ref)) continue;
      out.push(Decoration.replace({ widget: new FootnoteRefWidget(ref) }).range(ref.from, ref.to));
    }
    return Decoration.set(out, true);
  });
}

export function createFootnotesExtension(deps = {}) {
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
