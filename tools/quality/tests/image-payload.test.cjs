'use strict';
/*
 * remediation-363/payload-guard.test.cjs - headless node:test suite executing the ACTUAL
 * dsh-markpilot/src-cm6/image-payload.js guard (protectImagePayloads, embeddedImages,
 * safeImagePayloadPosition, ProtectedImagePayloadWidget.eq, createImagePayloadProjection)
 * through the ACTUAL createRegionIndex (src-cm6/region-index.js) and the ACTUAL production
 * recognizer functions extracted from src-cm6/main.js via acorn (maintained table-capacity
 * pattern): scanImageMarks + imgAttrs + mpHtmlUnescape; inlineCodeRanges. The only fixture
 * policy is line selection (which lines get scanned) mirroring the production caller.
 * One-instance rule: @codemirror/state + @codemirror/view are imported from the exact dist
 * URLs that src-cm6 resolves to. No browser/build/app.
 * Run: node --test .mp-verify/remediation-363/payload-guard.test.cjs
 */
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url'), { test } = require('node:test'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../../..'), url = p => pathToFileURL(path.join(ROOT, p)).href;
const STATE_URL = url('dsh-markpilot/node_modules/@codemirror/state/dist/index.js');
const VIEW_URL = url('dsh-markpilot/node_modules/@codemirror/view/dist/index.js');

function extractRecognizer() { // acorn slice of real functions from main.js (table-capacity pattern)
  const source = fs.readFileSync(path.join(ROOT, 'dsh-markpilot/src-cm6/main.js'), 'utf8');
  const ast = require(path.join(ROOT,'tools/quality/node_modules/acorn')).parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const names = ['MP_ENTITIES', 'mpHtmlUnescape', 'imgAttrs', 'scanImageMarks'];
  const code = names.map(name => {
    let n = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id?.name === name);
    if (!n) n = ast.body.find(n => n.type === 'VariableDeclaration' && n.declarations.some(d => d.id?.name === name));
    assert(n, 'main.js defines ' + name);
    return source.slice(n.start, n.end);
  }).join('\n');
  return Function('scope', 'with(scope){' + code + ';return {scanImageMarks,imgAttrs};}')({});
}
const RECOG = extractRecognizer();
let codeRanges;

// Reader = production recognizer per scanned line; line selection mirrors the production
// caller (fenced lines are not scanned - caller-level policy in main.js).
function makeReader() {
  return state => {
    const rows = [];
    let fenced = false;
    for (let n = 1; n <= state.doc.lines; n++) {
      const line = state.doc.line(n);
      if (/^\s*(```|~~~)/.test(line.text)) { fenced = !fenced; continue; }
      if (fenced) continue;
      const code = codeRanges(line.text);
      const marks = RECOG.scanImageMarks(line, line.text, (a,b) => !code.some(([x,y])=>a<y&&b>x), () => {}, 0);
      for (const mk of marks) rows.push({ kind: 'image', form: mk.form, from: mk.from, to: mk.to, payload: mk.payload,
        editFrom: mk.editFrom, data: { image: mk.image }, content: line.text.slice(mk.from - line.from, mk.to - line.from),
        sourceOwned: false, context: { key: 'img:' + mk.from } });
    }
    return rows;
  };
}

const SHORT = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
const LONG = 'data:image/png;base64,' + 'iVBORw0KGgoAAAANSUhEUg'.repeat(40);
const PCT = "data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27/%3E";
const MIXED = 'DATA:IMAGE/PNG;BASE64,iVBORw0KGgoAAAANSUhEUg';
const QUOTED1 = 'data:image/webp;base64,UklGRhIAAABXRUJQVlA4TAY';
const TBL = 'data:image/gif;base64,TBLGIF';

async function load() {
  codeRanges = (await import(url('dsh-markpilot/src-cm6/edit-plan.js'))).inlineCodeRanges;
  const cm = await import(STATE_URL);
  await import(VIEW_URL); // verify the one-instance view module loads headless alongside the guard
  const { createRegionIndex } = await import(url('dsh-markpilot/src-cm6/region-index.js'));
  const guard = await import(url('dsh-markpilot/src-cm6/image-payload.js'));
  return { cm, createRegionIndex, guard };
}
const build = async (mods, doc, extra = []) => {
  const index = mods.createRegionIndex(makeReader(), []);
  const state = mods.cm.EditorState.create({ doc, extensions: [index, mods.guard.protectImagePayloads(index), ...extra] });
  return { index, state };
};
const attempt = async (doc, spec) => {
  const mods = await load(), b = await build(mods, doc);
  const before = b.state.doc.toString();
  const tr = b.state.update(spec);
  return { mods, index: b.index, regions: mods.guard.embeddedImages(b.state, b.index), before, after: tr.state.doc.toString() };
};
const span = (doc, src) => { const i = doc.indexOf(src); assert(i >= 0, 'fixture src present'); return [i, i + src.length]; };
const regionOf = (regions, src) => { const r = regions.find(r => r?.data?.image?.src === src); assert(r, 'region for ' + src); return r; };

test('real recognizer: md/html/length/percent/case/table/code-span variants; external and fenced excluded', async () => {
  const mods = await load();
  const doc = [
    'para ![alt short](' + SHORT + ') mid',
    '<img src="' + LONG + '" alt="a" width="80">',
    "<img src='" + QUOTED1 + "'>",
    'pct ![svg](' + PCT + ') end',
    'mixed ![m](' + MIXED + ') end',
    '| h | media |',
    '| --- | --- |',
    '| row | ![t](' + TBL + ') |',
    'span `code ![x](data:image/gif;base64,INSPAN)` end',
    'ext ![open](https://example.com/a.png) done',
    '```',
    'fenced ![x](data:image/gif;base64,INSIDEFENCE) nope',
    '```',
  ].join('\n');
  const b = await build(mods, doc);
  const embedded = mods.guard.embeddedImages(b.state, b.index);
  assert.deepEqual(embedded.map(r => r.data.image.src), [SHORT, LONG, QUOTED1, PCT, MIXED, TBL], 'six guarded payloads');
  const html = regionOf(embedded, LONG);
  assert.equal(doc.slice(html.to - 1, html.to), '>', 'html region spans attributes through the closing bracket (real imgAttrs tag range)');
  assert.equal(doc.slice(html.payload[0], html.payload[1]), LONG, 'payload bounds equal exactly the src value');
  const all = b.state.field(b.index).byKind.get('image') || [];
  assert(all.some(r => r.data.image.src === 'https://example.com/a.png') && !embedded.some(r=>r.data.image.src.startsWith('https:')), 'external image remains outside protected data');
  assert(!all.some(r => (r.data.image.src || '').includes('INSIDEFENCE')), 'fenced line not scanned (caller policy)');
  assert(!all.some(r => (r.data.image.src || '').includes('INSPAN')), 'real inCodeSpan excludes code spans');
});

test('insert at either closed payload endpoint and any partial overlap is rejected atomically', async () => {
  const doc = 'a ![alt](' + SHORT + ') b\n<img src="' + LONG + '" alt="z">\n';
  for (const src of [SHORT, LONG]) {
    const [s, e] = span(doc, src);
    for (const [from, to] of [[s, s], [e, e], [s + 2, s + 5]]) {
      const r = await attempt(doc, { changes: from === to ? { from, insert: 'X' } : { from, to, insert: '' } });
      assert.equal(r.after, doc, 'rejected: ' + (from === to ? 'insert@' + from : 'overlap[' + from + ',' + to + ')') + ' on ' + src.slice(0, 24));
    }
  }
});

test('metadata outside the payload stays editable; external and fenced payloads are plain text', async () => {
  const doc = '![ALT](' + SHORT + ') tail';
  const altAt = doc.indexOf('ALT');
  const alt = await attempt(doc, { changes: { from: altAt, to: altAt + 3, insert: 'NEW' } });
  assert.equal(alt.after, doc.replace('ALT', 'NEW'), 'alt metadata edit allowed');
  const tailAt = doc.indexOf(' tail') + 1;
  const tail = await attempt(doc, { changes: { from: tailAt, insert: 'Q' } });
  assert.equal(tail.after, doc.slice(0, tailAt) + 'Q' + doc.slice(tailAt), 'suffix metadata edit allowed');
  const ext = await attempt('![o](https://example.com/x.png)', { changes: { from: 8, to: 11, insert: 'ZZZ' } });
  assert.notEqual(ext.after, '![o](https://example.com/x.png)', 'external URL bytes are not guarded');
  const fdoc = '```\n![f](data:image/gif;base64,FENC)\n```';
  const p = fdoc.indexOf('FENC') + 1;
  const fenced = await attempt(fdoc, { changes: { from: p, to: p + 1, insert: 'Y' } });
  assert.equal(fenced.after, fdoc.slice(0, p) + 'Y' + fdoc.slice(p + 1), 'fenced data URI is plain editable code');
});

test('deleting image syntax ( ![ , html src quote, enclosing fence ) rejects orphaned attachment bytes', async () => {
  const md = 'x ![alt](' + SHORT + ') y';
  const bang = md.indexOf('![');
  const r1 = await attempt(md, { changes: { from: bang, to: bang + 2, insert: '' } });
  assert.equal(r1.after, md, 'deleting ![ rejects');
  const html = '<img src="' + LONG + '">';
  const q = html.indexOf('"', html.indexOf(LONG) + LONG.length);
  const r2 = await attempt(html, { changes: { from: q, to: q + 1, insert: '' } });
  assert.equal(r2.after, html, 'deleting the closing html src quote rejects');
  const fencedBelow = '![f](' + TBL + ') tail\n```\ncode\n```';
  const r3 = await attempt(fencedBelow, { changes: { from: 0, insert: '```\n' } });
  assert.equal(r3.after, fencedBelow, 'a fence inserted before the image (enclosing edit) rejects');
});

test('whole-image delete/replace is allowed; undo/redo transactions pass through', async () => {
  const doc = 'a ![alt](' + SHORT + ') b\nalso <img src="' + QUOTED1 + '">\n';
  const mods = await load(), b = await build(mods, doc);
  const md = regionOf(mods.guard.embeddedImages(b.state, b.index), SHORT);
  const del = b.state.update({ changes: { from: md.from, to: md.to, insert: '' } });
  assert.equal(del.state.doc.toString(), doc.slice(0, md.from) + doc.slice(md.to), 'whole-image delete allowed');
  const rep = b.state.update({ changes: { from: md.from, to: md.to, insert: '![new](data:image/gif;base64,REPLACED)' } });
  assert.equal(rep.state.doc.toString(), doc.slice(0, md.from) + '![new](data:image/gif;base64,REPLACED)' + doc.slice(md.to), 'whole-image replace allowed');
  const [s, e] = span(doc, QUOTED1);
  const undo = b.state.update({ changes: { from: s + 1, to: s + 2, insert: '' }, userEvent: 'undo' });
  assert.equal(undo.state.doc.toString(), doc.slice(0, s + 1) + doc.slice(s + 2), 'undo user-event passes through the guard');
  const redo = b.state.update({ changes: { from: s + 1, insert: 'K' }, userEvent: 'redo' });
  assert.equal(redo.state.doc.toString(), doc.slice(0, s + 1) + 'K' + doc.slice(s + 1), 'redo user-event passes through the guard');
});

test('mixed allowed+forbidden multichange is rejected atomically (no partial application)', async () => {
  const doc = '![ALT](' + SHORT + ') tail <img src="' + LONG + '">';
  const [s] = span(doc, SHORT);
  const r = await attempt(doc, { changes: [{ from: doc.indexOf('ALT'), insert: 'Z' }, { from: s + 3, to: s + 4, insert: '' }] });
  assert.equal(r.after, doc, 'forbidden member rejects the whole edit, allowed member included');
  const r2 = await attempt(doc, { changes: [{ from: doc.indexOf(' tail'), insert: 'W' }, { from: s, to: s + 1, insert: '' }] });
  assert.equal(r2.after, doc, 'payload-touching member plus allowed members still fully rejected');
});

test('safeImagePayloadPosition maps caret out of payloads, keeps foreign positions', async () => {
  const mods = await load();
  const doc = 'a ![alt](' + SHORT + ') b';
  const b = await build(mods, doc);
  const regions = mods.guard.embeddedImages(b.state, b.index);
  const [s, e] = span(doc, SHORT), r = regionOf(regions, SHORT);
  assert.equal(mods.guard.safeImagePayloadPosition(regions, s + 5), r.editFrom, 'inside payload clamps to the editable anchor');
  assert.equal(mods.guard.safeImagePayloadPosition(regions, s), r.editFrom, 'payload start clamps too');
  assert.equal(mods.guard.safeImagePayloadPosition(regions, e), r.editFrom, 'payload end clamps too');
  assert.equal(mods.guard.safeImagePayloadPosition(regions, 1), 1, 'position outside any payload is untouched');
});

test('projection hides exactly every payload span (no prefix/suffix), widget identity stable', async () => {
  const mods = await load();
  const doc = '![a](' + SHORT + ') x <img src="' + LONG + '">\n| ![t](' + TBL + ') | c |\n';
  const index = mods.createRegionIndex(makeReader(), []);
  let mirror = mods.cm.EditorState.create({ doc, extensions: [index] });
  const field = mods.guard.createImagePayloadProjection(() => mods.guard.embeddedImages(mirror, index));
  const state = mods.cm.EditorState.create({ doc, extensions: [index, field] });
  const step = spec => { mirror = mirror.update(spec).state; return state.update(spec).state; };
  const collect = (st, set) => { const out = []; for (let cu = set.iter(0, st.doc.length); cu.value; cu.next()) out.push([cu.from, cu.to, cu.value]); return out; };
  const payloads = mods.guard.embeddedImages(state, index).map(r => r.payload).sort((a, b) => a[0] - b[0]);
  assert.equal(payloads.length, 3, 'three embedded payloads projected');
  const seen = collect(state, state.field(field));
  assert.equal(seen.length, 3, 'one decoration per payload, nothing more');
  for (const [from, to, deco] of seen) {
    assert(payloads.some(([s, e]) => s === from && e === to), 'decoration bounds equal a payload exactly');
    const w = deco.widget;
    assert(w && w.length === to - from && w.label, 'replace decoration carries the protected widget with payload length');
    const twin = new mods.guard.ProtectedImagePayloadWidget({ id: w.id, payload: [from, to], data: { image: { src: doc.slice(from, to) } } });
    assert(w.eq(twin), 'widget eq accepts same id/length/label');
    assert(!w.eq(new mods.guard.ProtectedImagePayloadWidget({ id: w.id, payload: [from, to - 1], data: { image: { src: doc.slice(from, to - 1) } } })), 'widget eq rejects different length');
  }
  const edited = step({ selection: { anchor: doc.indexOf('![a]') + 4 } });
  assert.equal(edited.field(field), state.field(field), 'selection-only step reuses the identical decoration set');
  const shifted = step({ changes: { from: 0, insert: 'HEAD\n' } });
  const after = collect(shifted, shifted.field(field)).map(([from,to])=>[from,to]);
  const shiftedPayloads = mods.guard.embeddedImages(shifted, index).map(r => r.payload).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(after, shiftedPayloads, 'doc change re-projects every payload at its mapped position');
});
