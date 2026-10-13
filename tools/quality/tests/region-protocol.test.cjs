#!/usr/bin/env node
/* Model tests for the region protocol modules.
 * Imports PRODUCTION modules (region-index/region-session/container-presentation/
 * markdown-context/render-lifecycle) plus installed @codemirror state/commands via file URLs.
 * The image producer below is a test-only recognition adapter (independent regex oracle),
 * NOT a copy of product scanImageMarks. No DOM, no app, no builds.
 * A literal source oracle and production history commands verify the protocol. */
'use strict';
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..', '..');
const SRC = path.join(ROOT, 'dsh-markpilot', 'src-cm6');
const CM = (p) => pathToFileURL(path.join(ROOT, 'dsh-markpilot', 'node_modules', '@codemirror', p)).href;
const LOCAL = (f) => pathToFileURL(path.join(SRC, f)).href;

let seed = 20261013; // fixed-seed LCG: reproducible insertion/edit coordinates
const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
let pass = 0, fail = 0; const fails = [];
const ok = (cond, name, detail) => { if (cond) pass++; else { fail++; fails.push(name + (detail ? ' :: ' + detail : '')); } };

async function main() {
  const { EditorState, StateField, Transaction } = await import(CM('state/dist/index.js'));
  const { history, undo, redo, undoDepth, redoDepth } = await import(CM('commands/dist/index.js'));
  const { createRegionIndex, regionAt, regionsBetween } = await import(LOCAL('region-index.js'));
  const { createRegionSession, activateRegion, retireRegion, expandRegionPayload } = await import(LOCAL('region-session.js'));
  const { containerContext } = await import(LOCAL('container-presentation.js'));
  const { scanFencedBlocks, blockAt } = await import(LOCAL('markdown-context.js'));
  const { createRenderLifecycle } = await import(LOCAL('render-lifecycle.js'));

  // Test-only producer: exact regex recognizer for ![alt](url) with literal ranges.
  // Independent algorithm (regex walk) vs product manual jump-scan: serves as oracle.
  const scanImages = (doc) => {
    const rows = [];
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i), t = line.text;
      const re = /!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g;
      for (let m; (m = re.exec(t)); ) {
        const from = line.from + m.index;
        const pFrom = from + m[0].indexOf('(') + 1;
        rows.push({ kind: 'image', form: 'markdown', from, to: from + m[0].length,
          editFrom: from + 2, payload: [pFrom, pFrom + m[2].length], content: [m[2], m[1]],
          context: containerContext(doc, from, null) });
      }
    }
    return rows;
  };
  const producer = StateField.define({
    create: (s) => scanImages(s.doc),
    update: (v, tr) => (tr.docChanged ? scanImages(tr.state.doc) : v),
  });

  const index = createRegionIndex((s) => s.field(producer), [producer]);
  const session = createRegionSession(index);
  const makeState = (doc) => EditorState.create({ doc, extensions: [history(), producer, index, session] });
  const LIT = '![alt](u1.png)';

  // T1 selection-only: identical index value, no version bump.
  {
    let st = makeState('para\n\n' + LIT + '\ntail');
    st = st.update({ selection: { anchor: 2 } }).state;
    const before = st.field(index);
    st = st.update({ selection: { anchor: 1, head: 4 }, userEvent: 'select.pointer' }).state;
    ok(st.field(index) === before, 'T1 selection-only keeps index identity');
    ok(st.field(index).version === before.version, 'T1 version stable');
  }

  // T2 seeded insertions above (plain/CJK/surrogate) map identity; oracle re-derives ranges.
  {
    const pieces = ['x', '汉字', '🎉', 'ab🎉cd', '\n'];
    for (let k = 0; k < 24; k++) {
      const ins = pieces[rnd(pieces.length)], at = rnd(6);
      let st = makeState('para\n\n' + LIT + '\ntail');
      const id0 = st.field(index).regions[0].id;
      st = st.update({ changes: { from: at, insert: ins } }).state;
      const oracle = 'para\n\n'.slice(0, at) + ins + 'para\n\n'.slice(at) + LIT + '\ntail';
      const r = st.field(index).regions[0];
      ok(st.doc.toString() === oracle && r.id === id0, 'T2 id survives insertion ' + k, ins);
      ok(r.from === oracle.indexOf(LIT) && r.to === r.from + LIT.length, 'T2 mapped range equals oracle ' + k);
    }
  }

  // T3 alt/url edits keep id + session, revision advances; pointer-leave retires.
  {
    let st = makeState(LIT + '\ntail');
    const id0 = st.field(index).regions[0].id;
    const altFrom = LIT.indexOf('alt');
    st = st.update({ effects: activateRegion.of({ id: id0 }), selection: { anchor: altFrom } }).state;
    ok(st.field(session).imageId === id0, 'T3 activation');
    st = st.update({ changes: { from: altFrom, to: altFrom + 3, insert: 'ALT' }, userEvent: 'input.type' }).state;
    let r = st.field(index).regions[0];
    ok(st.doc.toString() === '![ALT](u1.png)\ntail' && r.id === id0 && r.revision === 1, 'T3 alt edit: id kept, revision 1');
    ok(st.field(session).imageId === id0, 'T3 session survives alt edit');
    const oneAt = st.doc.toString().indexOf('u1') + 1;
    st = st.update({ changes: { from: oneAt, to: oneAt + 1, insert: '9' }, userEvent: 'input.type' }).state;
    r = st.field(index).regions[0];
    ok(r.id === id0 && r.revision === 2 && st.field(session).imageId === id0, 'T3 url edit: id+session kept, revision 2');
    ok(r.contextVersion === 0, 'T3 context stable');
    st = st.update({ selection: { anchor: st.doc.length }, userEvent: 'select.pointer' }).state;
    ok(st.field(session).imageId === null, 'T3 pointer leave (tail line, outside region) retires');
  }

  // T3b quote-prefix edit: id kept, context rebinds (depth 1 -> 2), contextVersion +1.
  {
    let st = makeState('> ' + LIT);
    const id0 = st.field(index).regions[0].id;
    st = st.update({ changes: { from: 0, insert: '> ' }, userEvent: 'input.type' }).state;
    const r = st.field(index).regions[0];
    ok(r.id === id0 && r.contextVersion === 1 && r.context.depth === 2, 'T3b prefix edit rebinds context', JSON.stringify({ cv: r.contextVersion, d: r.context.depth }));
  }

  // T4 boundary loss and duplicate ambiguity retire; whole-duplicate removal keeps survivor.
  {
    let st = makeState(LIT);
    const id0 = st.field(index).regions[0].id;
    st = st.update({ effects: activateRegion.of({ id: id0 }), selection: { anchor: 5 } }).state;
    st = st.update({ changes: { from: 13, to: 14, insert: '' }, userEvent: 'delete.forward' }).state;
    ok(st.field(index).regions.length === 0 && st.field(session).imageId === null, 'T4 delimiter loss retires session');
    const dup = '![a](u.png)';
    let s2 = makeState(dup + dup);
    s2 = s2.update({ effects: activateRegion.of({ id: s2.field(index).regions[1].id }), selection: { anchor: 12 } }).state;
    const id1 = s2.field(index).regions[1].id;
    s2 = s2.update({ changes: { from: 0, to: 11, insert: '' }, userEvent: 'delete.cut' }).state;
    const rs = s2.field(index).regions;
    ok(rs.length === 1 && rs[0].id === id1 && rs[0].from === 0, 'T4 survivor keeps identity');
    ok(s2.field(session).imageId === id1, 'T4 session follows survivor');
    let s3 = makeState(dup + dup);
    s3 = s3.update({ effects: activateRegion.of({ id: s3.field(index).regions[0].id }), selection: { anchor: 5 } }).state;
    s3 = s3.update({ changes: { from: 4, to: 18, insert: '' }, userEvent: 'delete.cut' }).state;
    ok(s3.field(index).regions.length === 0 && s3.field(session).imageId === null, 'T4 spanning collapse retires (ambiguity path)');
  }

  // T5 activate/expand/reclick/retire never touch history depth.
  {
    let st = makeState(LIT);
    const id0 = st.field(index).regions[0].id;
    const d0 = undoDepth(st);
    st = st.update({ effects: [activateRegion.of({ id: id0 }), expandRegionPayload.of(id0)],
      selection: { anchor: 5 }, annotations: Transaction.addToHistory.of(false) }).state;
    st = st.update({ effects: activateRegion.of({ id: id0 }), annotations: Transaction.addToHistory.of(false) }).state;
    ok(st.field(session).imageId === id0 && st.field(session).expanded, 'T5 activate+expand applied, re-activate idempotent');
    st = st.update({ effects: retireRegion.of({ id: id0 }), annotations: Transaction.addToHistory.of(false) }).state;
    ok(undoDepth(st) === d0 && st.field(session).imageId === null, 'T5 zero undo depth from effects');
  }

  // T6 REAL history undo/redo (installed commands consume {state, dispatch} only,
  // verified at @codemirror/commands dist cmd():285-298) + continued edits: one doc, id/session preserved.
  {
    const base = 'head\n\n' + LIT + '\ntail';
    let st = makeState(base);
    const r0 = st.field(index).regions[0];
    const target = { get state() { return st; }, dispatch(tr) { st = tr.state; } };
    const altFrom = base.indexOf('alt');
    st = st.update({ effects: activateRegion.of({ id: r0.id }), selection: { anchor: altFrom },
      annotations: Transaction.addToHistory.of(false) }).state;
    st = st.update({ changes: { from: altFrom, to: altFrom + 3, insert: 'photo' }, userEvent: 'input.type' }).state;
    ok(undoDepth(st) === 1, 'T6 exactly one history entry for the edit');
    ok(undo(target) === true && redoDepth(st) === 1, 'T6 real undo consumed the event');
    ok(st.doc.toString() === base, 'T6 undo restored full source bytes');
    ok(st.field(session).imageId === r0.id, 'T6 session survives real undo (history restores inner selection)');
    ok(redo(target) === true && undoDepth(st) === 1, 'T6 real redo restored the edit');
    const oneAt = st.doc.toString().indexOf('u1') + 1;
    st = st.update({ changes: { from: oneAt, to: oneAt + 1, insert: 'X' }, userEvent: 'input.type' }).state;
    ok(st.doc.toString() === 'head\n\n![photo](uX.png)\ntail', 'T6 continued edit: doc equals string-built oracle');
    const r1 = st.field(index).regions[0];
    ok(r1.id === r0.id && st.field(session).imageId === r0.id, 'T6 one source, id/session continuous');
  }

  // T7 container semantics: TeX '>' literal, code-body '>' literal, code list contract.
  {
    const d = EditorState.create({ doc: '> $x>0$\n> > $a$\n- plain\n```\n> not quote\n- not list\n```\n' }).doc;
    ok(containerContext(d, d.line(1).from).depth === 1, 'T7 TeX > not quote depth');
    ok(containerContext(d, d.line(2).from).depth === 2, 'T7 nested quote depth');
    const blocks = scanFencedBlocks(d);
    const code = blockAt(blocks, d.line(5).from);
    ok(!!code && code.depth === 0 && containerContext(d, d.line(5).from, code).depth === 0, 'T7 fence body > stays literal');
    const c6 = containerContext(d, d.line(6).from, code);
    ok(c6.depth === 0 && !c6.path.some((p) => p.kind === 'list'), 'T7 code body must not gain list path');
  }

  // T8 render lifecycle: lease validity across revision change, remount, region loss.
  {
    let st = makeState(LIT);
    const altFrom = LIT.indexOf('alt');
    const node = { isConnected: true };
    const view = { state: st, dom: { contains: () => true }, requestMeasure() {} };
    const lc = createRenderLifecycle(index);
    const lease = lc.mount(view, st.field(index).regions[0], node);
    ok(lease.valid() && lease.publish(() => {}) === true, 'T8 fresh lease valid');
    st = st.update({ changes: { from: altFrom, to: altFrom + 3, insert: 'ALT' } }).state; view.state = st;
    ok(st.field(index).regions.length === 1, 'T8 edit kept the region (revision path, not loss)');
    ok(!lease.valid() && lease.publish(() => { throw new Error('late'); }) === false, 'T8 revision change invalidates + rejects late publish');
    const lease2 = lc.mount(view, st.field(index).regions[0], node);
    ok(lease2 !== lease && !lease.valid(), 'T8 remount releases prior lease');
    st = st.update({ changes: { from: 0, to: st.doc.length, insert: 'plain' } }).state; view.state = st;
    ok(!lease2.valid(), 'T8 region loss invalidates');
  }

  // T9 query helpers sanity (indexed hit, inclusive vs strict).
  {
    const st = makeState('a ' + LIT + ' b');
    const idx = st.field(index);
    ok(regionAt(idx, 2, 'image') && regionAt(idx, 16, 'image'), 'T9 inclusive endpoints hit');
    ok(regionAt(idx, 2, 'image', false) === null && !!regionAt(idx, 9, 'image', false), 'T9 strict interior only');
    ok(regionsBetween(idx, 0, 20, 'image').length === 1 && regionsBetween(idx, 0, 1, 'image').length === 0, 'T9 regionsBetween');
  }

  assert.equal(fail, 0, fails.join('\n'));
  assert(pass >= 82, 'all seeded and history invariants executed');
}
test('region identities, directed ranges, native history, and mount publication survive real ChangeSets', main);
