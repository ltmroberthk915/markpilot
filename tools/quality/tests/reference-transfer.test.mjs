// reference-transfer.test.mjs — semantic tests for cross-note relative
// Markdown link/reference relocation (public, repo-native).
//
//   node tools/quality/tests/reference-transfer.test.mjs
//
// Verdict goes to stdout only, so runs against frozen sources never dirty the
// tree; set MP_TEST_RESULT_DIR to additionally receive a result JSON there.
// Resolves the engine module and the shell receipt module relative to the
// repository root (walking up from this file), so it runs in a clean checkout
// with no .mp-verify tree. When imported as a module it exposes
// runSuite({engineDir, shellFile, log}) for embedding. Arms:
//   A1  probe-equivalent cross-note transfer (judge semantics)
//   A2  same-directory paste is a byte-identical no-op
//   A3  remote / mailto / fragment-only never relocate
//   A4  footnote labels are never resource references
//   A5  fenced-code definitions do not bind
//   A6  collapsed and shorthand reference forms inline-ize
//   A7  label folding (case/whitespace); first legal definition wins
//   A8  a definition inside the selection relocates its destination
//   A9  definition titles survive inline-ization
//   A10 inline link query strings survive; & is entity-escaped
//   A11 math spans and inline code never contribute usages
//   A12 multiple selection ranges share one ticket
//   A13 image regions (relative-image contract) still relocate
//   A14 oversized selections refuse explicitly ('unavailable')
//   A15 shell receipt validation (head/title, stale reads)
//   A16 clipboard flavor transport keeps text/plain intact
//   A17 DSH bridge: local receipt only, no IPC, no cross-frame owner
//   A18 code-span membership judged on the full document line
//   A19 a usage beside a code span still relocates
//   A20 definitions inside multi-line $$…$$ do not shadow
//   A21 mid-line definition-looking prefixes stay prose
//   A22 definition lines truncated by the selection stay put
//   A23 usages straddling the selection edge stay verbatim
//   A24 the document is scanned for definitions only when labels pend
//   A25 blockquote definitions (`> [key]: dest`) bind like plain ones
//   A26 a definition traveling with the selection keeps reference usages
//   A27 quoted fenced definitions never bind (region truth)
//   A28 fenced definitions inside the selection stay literal (no regions)
//   A29 conflicting incoming definitions are renamed, usages follow
//   A30 non-conflicting incoming definitions stay verbatim
//   A31 inline-ized titles keep quote/paren characters (no percent text)
//   A32 judge-equivalent definitions-travel paste (visual/reference-definitions.cjs)
//   A33 same-folder sibling paste keeps every identity (visual/reference-same-folder.cjs)
//   A34 same-file paste never reconciles labels
//   A35 remote/mailto definitions inline their exact original URI (images http(s) only)
//   A36 fragment-bound usages point at the source note
//   A37 unsupported external definitions (file:, data:, javascript:, UNC,
//       control characters) are never auto-inlined
//   A38 image-mark fragments, code-span image text and remote marks stay plain
//   A39 genuinely complete links in the same shape do register (new semantics)
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';

const sha = s => crypto.createHash('sha256').update(s, 'utf16le').digest('hex');

// Independent resolver, ported from the judge probe. Resource identity is
// decided after URI decoding + fs.realpathSync, never by comparing literal
// percent-encoded or raw text.
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function reference(text, label, folder) {
  const re = new RegExp('!?\\[' + escapeRe(label) + '\\](?:\\(([^)]+)\\)|\\[([^\\]]*)\\])', 'u');
  const m = text.match(re);
  if (!m) throw new Error('missing link ' + label);
  let dest = m[1];
  if (dest == null) {
    const key = (m[2] || label).toLowerCase();
    const def = [...text.matchAll(/^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm)].find(x => x[1].toLowerCase() === key);
    if (!def) throw new Error('missing definition ' + key);
    dest = def[2];
  }
  const idx = dest.indexOf('#');
  return {file: fs.realpathSync(path.resolve(folder,
    decodeURIComponent(idx < 0 ? dest : dest.slice(0, idx)).replaceAll('/ ', '/'))),
    fragment: idx < 0 ? '' : dest.slice(idx)};
}
const svg = (n, c) => `<svg width="${n}" height="30" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${c}"/></svg>`;
const makeState = (text, spy) => {
  const lines = [];
  let from = 0;
  for (const t of text.split('\n')) { lines.push({from, to: from + t.length, text: t}); from += t.length + 1; }
  return {sliceDoc: (from, to) => text.slice(from, to),
    doc: {
      length: text.length,
      lineAt: pos => lines.find(l => pos >= l.from && pos <= l.to) || lines[lines.length - 1],
      iterLines: function* () { if (spy) spy.iterated = (spy.iterated || 0) + 1; for (const l of lines) yield l.text; },
    }};
};
const makeIndex = ({code = [], math = [], image = []} = {}) => ({byKind: new Map(
  [['code', code], ['mermaid', []], ['math', math], ['image', image]])});

const line = 'PROOF ![图][fig] [参考讲义][book] [定理](lesson.md#lemma) 和 `![样例][fig]` END';
const srcText = line + '\n\n[fig]: graph.svg\n[book]: lesson.md#lemma\n';
const dstText = '粘贴位置\n\n已有：![原目标图][fig]。\n\n[fig]: graph.svg\n[book]: lesson.md#lemma\n';

export async function runSuite({engineDir, shellFile, log = () => {}} = {}) {
  assert.ok(engineDir, 'engineDir (the dsh-markpilot tree) is required');
  assert.ok(shellFile, 'shellFile (clipboard-image-source.cjs) is required');
  const patched = await import(pathToFileURL(path.join(engineDir, 'src-cm6', 'image-transfer.js')).href);
  const require = createRequire(import.meta.url);
  const shell = require(shellFile);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ref-sem-'));
  function fixture(name) {
    const root = path.join(tmp, name);
    const a = path.join(root, '讲义'), b = path.join(root, '总结');
    fs.mkdirSync(a, {recursive: true}); fs.mkdirSync(b, {recursive: true});
    fs.writeFileSync(path.join(a, 'graph.svg'), svg(53, 'red'));
    fs.writeFileSync(path.join(b, 'graph.svg'), svg(27, 'blue'));
    fs.writeFileSync(path.join(a, 'lesson.md'), '# Lemma\n\nred lesson');
    fs.writeFileSync(path.join(b, 'lesson.md'), '# Lemma\n\nblue lesson');
    return {root, a, b, srcFile: path.join(a, 'proof.md'), dstFile: path.join(b, 'summary.md')};
  }
  let hostCalls = 0;
  function installHost({srcFile, shell: shellMod = shell, recoverFile}) {
    globalThis.window = globalThis.window || {};
    window.__mpDocDir = path.dirname(srcFile);
    window.__dshHost = false;
    delete window.__dshBridge;
    const recoverAt = recoverFile || srcFile;
    window.mpHost = {
      rememberImageSource: (token, payload, plain) => {
        hostCalls++;
        return shellMod.rememberImageSource(srcFile, {...payload, hash: sha(plain)});
      },
      recoverImageSource: (id, plain) => shellMod.recoverImageSource(recoverAt, id, plain.length, sha(plain)),
      eventClipboardIntent: () => 'intent-token',
    };
  }
  const cross = f => installHost({...f, recoverFile: f.dstFile});

  const results = [];
  const arm = (name, run) => { try { run(); results.push({name, ok: true}); }
    catch (e) { results.push({name, ok: false, error: String(e && e.stack || e).split('\n').slice(0, 4).join('\n')}); } };

  arm('A1 probe-equivalent cross-note transfer', () => {
    const f = fixture('probe');
    fs.writeFileSync(f.srcFile, srcText); fs.writeFileSync(f.dstFile, dstText);
    cross(f);
    const id = patched.sourceImageTicket(makeState(srcText), makeIndex(), [{from: 0, to: line.length}], 'tok');
    assert.ok(id && id !== 'unavailable', 'ticket id: ' + id);
    const moved = patched.readImageTransfer(id, line);
    assert.ok(moved && moved.text !== line, 'text was relocated');
    assert.ok(moved.text.includes('`![样例][fig]`'), 'code span literal untouched');
    const dst = dstText.replace('粘贴位置', moved.text);
    assert.equal(reference(dst, '图', f.b).file, fs.realpathSync(path.join(f.a, 'graph.svg')));
    assert.equal(reference(dst, '图', f.b).fragment, '');
    for (const k of ['参考讲义', '定理']) {
      assert.equal(reference(dst, k, f.b).file, fs.realpathSync(path.join(f.a, 'lesson.md')));
      assert.equal(reference(dst, k, f.b).fragment, '#lemma');
    }
    assert.equal(reference(dst, '原目标图', f.b).file, fs.realpathSync(path.join(f.b, 'graph.svg')));
  });

  arm('A2 same-dir is a no-op', () => {
    const f = fixture('samedir');
    installHost(f);
    const id = patched.sourceImageTicket(makeState(srcText), makeIndex(), [{from: 0, to: line.length}], 'tok');
    const moved = patched.readImageTransfer(id, line);
    assert.ok(moved, 'receipt resolves');
    assert.equal(moved.text, line, 'no changes for the same file');
    assert.equal(moved.crossDocument, false, 'same actual file is not cross-document');
  });

  arm('A3 inline remote mailto fragment-only links untouched', () => {
    const f = fixture('remote');
    const text = 'D [x](https://e.com/y) E [z](#anchor) F';
    cross(f);
    const id = patched.sourceImageTicket(makeState(text + '\n'), makeIndex(), [{from: 0, to: text.length}], 'tok');
    assert.equal(id, null, 'self-contained links never change');
  });

  arm('A4 footnotes untouched', () => {
    const f = fixture('footnote');
    const text = '见[^1]与[^说明]。\n\n[^1]: 这是注释正文\n[^说明]: 另一条注释\n';
    cross(f);
    const id = patched.sourceImageTicket(makeState(text), makeIndex(), [{from: 0, to: text.length}], 'tok');
    assert.equal(id, null, 'no ticket: footnotes are not references');
  });

  arm('A5 fenced definition does not bind', () => {
    const f = fixture('fenced');
    const first = '用 ![图][fig] 点题。';
    const doc = first + '\n```\n[fig]: fence-evil.svg\n```\n\n[fig]: graph.svg\n';
    const open = doc.indexOf('```'), close = doc.indexOf('```', open + 3) + 3;
    installHost({...f, recoverFile: f.dstFile});
    const id = patched.sourceImageTicket(makeState(doc), makeIndex({code: [{from: open, to: close}]}),
      [{from: 0, to: first.length}], 'tok');
    const moved = patched.readImageTransfer(id, first);
    assert.ok(moved && moved.text !== first, 'usage relocated');
    assert.ok(!moved.text.includes('fence-evil'), 'fenced definition ignored');
    assert.equal(reference(moved.text, '图', f.b).file, fs.realpathSync(path.join(f.a, 'graph.svg')));
  });

  arm('A6 collapsed and shorthand forms', () => {
    const f = fixture('forms');
    const text = '![图][] 然后 ![图] 再 [参考讲义][]';
    const doc = text + '\n\n[图]: graph.svg\n[参考讲义]: lesson.md#lemma\n';
    cross(f);
    const id = patched.sourceImageTicket(makeState(doc), makeIndex(), [{from: 0, to: text.length}], 'tok');
    const moved = patched.readImageTransfer(id, text);
    assert.ok(moved && moved.text !== text, 'relocated');
    assert.equal(reference(moved.text, '图', f.b).file, fs.realpathSync(path.join(f.a, 'graph.svg')));
    assert.equal(reference(moved.text, '参考讲义', f.b).file, fs.realpathSync(path.join(f.a, 'lesson.md')));
  });

  arm('A7 case/whitespace folding, first definition', () => {
    const f = fixture('fold');
    const text = '![图][FIG] 和 [参 考][a b]';
    const doc = text + '\n\n[FIG]: graph.svg\n[fig]: wrong.svg\n[A  B]: lesson.md#lemma\n';
    cross(f);
    const id = patched.sourceImageTicket(makeState(doc), makeIndex(), [{from: 0, to: text.length}], 'tok');
    const moved = patched.readImageTransfer(id, text);
    assert.ok(moved && moved.text !== text, 'relocated');
    assert.ok(!moved.text.includes('wrong.svg'), 'first legal definition wins');
    assert.equal(reference(moved.text, '图', f.b).file, fs.realpathSync(path.join(f.a, 'graph.svg')));
    assert.equal(reference(moved.text, '参 考', f.b).file, fs.realpathSync(path.join(f.a, 'lesson.md')));
  });

  arm('A8 definition inside selection relocated', () => {
    const f = fixture('defsel');
    const text = '引 ![图][fig]\n\n[fig]: graph.svg\n';
    cross(f);
    const id = patched.sourceImageTicket(makeState(text), makeIndex(), [{from: 0, to: text.length}], 'tok');
    assert.ok(id && id !== 'unavailable', 'ticket minted');
    const moved = patched.readImageTransfer(id, text);
    assert.ok(moved && moved.text !== text, 'relocated');
    assert.match(moved.text, /\[fig\]: \.\.\//, 'definition destination rewritten');
    assert.equal(reference(moved.text, '图', f.b).file, fs.realpathSync(path.join(f.a, 'graph.svg')));
  });

  arm('A9 title preserved', () => {
    const f = fixture('title');
    const text = '[参考讲义][book]';
    const doc = text + '\n\n[book]: lesson.md#lemma "讲义标题"\n';
    cross(f);
    const id = patched.sourceImageTicket(makeState(doc), makeIndex(), [{from: 0, to: text.length}], 'tok');
    const moved = patched.readImageTransfer(id, text);
    assert.ok(moved && moved.text !== text, 'relocated');
    assert.ok(moved.text.includes('"讲义标题"'), 'title kept: ' + moved.text);
    assert.ok(moved.text.includes('#lemma'), 'fragment kept');
  });

  arm('A10 query preserved', () => {
    const f = fixture('query');
    const text = '[查](lesson.md?x=1&y=2#q)';
    cross(f);
    const id = patched.sourceImageTicket(makeState(text + '\n'), makeIndex(), [{from: 0, to: text.length}], 'tok');
    const moved = patched.readImageTransfer(id, text);
    assert.ok(moved && moved.text !== text, 'relocated');
    assert.ok(moved.text.includes('?x=1&amp;y=2#q'), 'query+fragment kept: ' + moved.text);
  });

  arm('A11 math and code spans skipped', () => {
    const f = fixture('mathcode');
    const text = '$![图][fig]$ 和 `![图][fig]`';
    const doc = text + '\n\n[fig]: graph.svg\n';
    cross(f);
    const id = patched.sourceImageTicket(makeState(doc), makeIndex({math: [{from: 0, to: 12}]}),
      [{from: 0, to: text.length}], 'tok');
    assert.equal(id, null, 'no ticket: protected contexts only');
  });

  arm('A12 multi-range offsets', () => {
    const f = fixture('multirange');
    const l1 = '一 ![图][fig]', l2 = '二 [参考讲义][book]';
    const doc = l1 + '\n\n中間\n\n' + l2 + '\n\n[fig]: graph.svg\n[book]: lesson.md#lemma\n';
    const r1 = {from: 0, to: l1.length};
    const r2 = {from: doc.indexOf(l2), to: doc.indexOf(l2) + l2.length};
    cross(f);
    const id = patched.sourceImageTicket(makeState(doc), makeIndex(), [r1, r2], 'tok');
    const plain = [l1, l2].join('\n');
    const moved = patched.readImageTransfer(id, plain);
    assert.ok(moved && moved.text !== plain, 'relocated');
    const [m1, m2] = moved.text.split('\n');
    assert.equal(reference(m1, '图', f.b).file, fs.realpathSync(path.join(f.a, 'graph.svg')));
    assert.equal(reference(m2, '参考讲义', f.b).file, fs.realpathSync(path.join(f.a, 'lesson.md')));
  });

  arm('A13 image region regression guard', () => {
    const f = fixture('imgregion');
    const text = '![图](graph.svg)';
    const payloadFrom = text.indexOf('graph.svg');
    const index = makeIndex({image: [{from: 0, to: text.length,
      data: {image: {src: 'graph.svg'}, payload: [payloadFrom, payloadFrom + 'graph.svg'.length]}}]});
    cross(f);
    const id = patched.sourceImageTicket(makeState(text + '\n'), index, [{from: 0, to: text.length}], 'tok');
    const moved = patched.readImageTransfer(id, text);
    assert.ok(moved && moved.text !== text, 'image payload relocated');
    assert.equal(reference(moved.text, '图', f.b).file, fs.realpathSync(path.join(f.a, 'graph.svg')));
  });

  arm('A14 budget refusal', () => {
    const f = fixture('budget');
    const text = Array.from({length: 4100}, (_, i) => `[t${i}](r${i}.md)`).join(' ');
    cross(f);
    const id = patched.sourceImageTicket(makeState(text + '\n'), makeIndex(), [{from: 0, to: text.length}], 'tok');
    assert.equal(id, 'unavailable');
  });

  arm('A15 shell validation', () => {
    const f = fixture('shellval');
    const mk = refs => ({length: 12, hash: sha('x'.repeat(12)), refs, linewise: false});
    const base = {from: 0, to: 8, raw: '[图][fig]', target: 'graph.svg', head: '[图]'};
    assert.ok(shell.rememberImageSource(f.srcFile, mk([base])), 'valid reference ref accepted');
    assert.equal(shell.rememberImageSource(f.srcFile, mk([{...base, head: '[别的]'}])), null, 'head must prefix raw');
    assert.equal(shell.rememberImageSource(f.srcFile, mk([{...base, head: 'a\nb'}])), null, 'no newline in head');
    assert.equal(shell.rememberImageSource(f.srcFile, mk([{...base, title: 'a"b\nc'}])), null, 'no newline in title');
    assert.equal(shell.rememberImageSource(f.srcFile, mk([{...base, head: 'x'.repeat(1025)}])), null, 'head length cap');
    const id = shell.rememberImageSource(f.srcFile, mk([{...base, title: '标题'}]));
    assert.ok(id, 'valid titled ref remembered');
    assert.equal(shell.recoverImageSource(f.dstFile, id, 12, sha('y'.repeat(12))), null, 'hash mismatch rejected');
    assert.ok(shell.rememberImageSource(f.srcFile,
      mk([{from: 0, to: 9, raw: 'graph.svg', target: 'graph.svg'}])), 'plain destination ref accepted without head');
    // Paired verbatim allowlist: http(s) links/images and mailto links only.
    const vb = {from: 0, to: 6, raw: '[x][k]', target: 'https://e.com/y', head: '[x]', verbatim: true};
    const vbi = {from: 0, to: 7, raw: '![x][k]', target: 'https://e.com/i.png', head: '![x]', verbatim: true};
    assert.ok(shell.rememberImageSource(f.srcFile, mk([vb])), 'https link verbatim accepted');
    assert.ok(shell.rememberImageSource(f.srcFile, mk([{...vb, target: 'mailto:a@b.c'}])), 'mailto link verbatim accepted');
    assert.ok(shell.rememberImageSource(f.srcFile, mk([vbi])), 'https image verbatim accepted');
    assert.equal(shell.rememberImageSource(f.srcFile, mk([{...vb, target: 'file:///C:/x'}])), null, 'file: refused');
    assert.equal(shell.rememberImageSource(f.srcFile, mk([{...vb, target: 'javascript:alert(1)'}])), null, 'javascript: refused');
    assert.equal(shell.rememberImageSource(f.srcFile, mk([{...vb, target: 'data:text/plain,hi'}])), null, 'data: refused');
    assert.equal(shell.rememberImageSource(f.srcFile, mk([{...vb, target: '\\\\srv\\share\\x.md'}])), null, 'UNC refused');
    assert.equal(shell.rememberImageSource(f.srcFile, mk([{...vb, target: 'https://e.com/\u0001'}])), null, 'control characters refused');
    assert.equal(shell.rememberImageSource(f.srcFile, mk([{...vbi, target: 'mailto:a@b.c'}])), null, 'mailto image refused');
    assert.equal(shell.rememberImageSource(f.srcFile, mk([{...vb, head: null, verbatim: true}])), null, 'verbatim requires a usage head');
  });

  arm('A16 clipboard flavor', () => {
    const f = fixture('flavor');
    cross(f);
    const store = {};
    const cd = {types: ['text/plain'], setData(k, v) { store[k] = v; }, getData: k => store[k] || ''};
    const ev = {isTrusted: true, type: 'copy', defaultPrevented: true, clipboardData: cd};
    const state = {...makeState(srcText), selection: {ranges: [{from: 0, to: line.length, empty: false}]}};
    const id = patched.beginNativeImageTransfer(ev, state, makeIndex());
    assert.ok(id && id !== 'unavailable', 'ticket from event: ' + id);
    patched.finishNativeImageTransfer(ev);
    assert.equal(store[patched.imageTransferFlavor], id, 'opaque id on the custom flavor');
    assert.equal(store['text/html'], undefined, 'desktop keeps the plain native representation');
  });

  arm('A17 dsh bridge boundary', () => {
    const f = fixture('bridge');
    globalThis.window = globalThis.window || {};
    window.__mpDocDir = path.dirname(f.srcFile);
    window.__dshHost = true;
    window.__dshBridge = {protocolState: () => ({docToken: 'A'}), docBase: () => 'file:///a/'};
    window.mpHost = {rememberImageSource: () => { throw new Error('bridge must not IPC'); }};
    const before = hostCalls;
    const id = patched.sourceImageTicket(makeState(srcText), makeIndex(), [{from: 0, to: line.length}], 'tok');
    assert.ok(typeof id === 'string' && id.startsWith('dsh-'), 'local id: ' + id);
    assert.equal(hostCalls, before, 'no receipt payload sent to the host');
    const same = patched.readImageTransfer(id, line);
    assert.ok(same && same.text === line, 'same-owner paste unchanged');
    window.__dshBridge = {protocolState: () => ({docToken: 'B'}), docBase: () => 'file:///b/'};
    assert.equal(patched.readImageTransfer(id, line), null, 'cross-frame owner refused');
  });

  arm('A18 code-span inner selection', () => {
    const f = fixture('codeinner');
    const inner = '[示例](lesson.md#fake)';
    const doc = '讲解 `' + inner + '` 收尾\n';
    cross(f);
    const from = doc.indexOf(inner);
    const id = patched.sourceImageTicket(makeState(doc), makeIndex(), [{from, to: from + inner.length}], 'tok');
    assert.equal(id, null, 'code example not mistaken for a resource');
  });

  arm('A19 neighbor of code span relocates', () => {
    const f = fixture('codeneighbor');
    const text = '前 ![图][fig] 后 `x [y](lesson.md#fake) z` 尾';
    const doc = text + '\n\n[fig]: graph.svg\n';
    cross(f);
    const id = patched.sourceImageTicket(makeState(doc), makeIndex(), [{from: 0, to: text.length}], 'tok');
    const moved = patched.readImageTransfer(id, text);
    assert.ok(moved && moved.text !== text, 'usage relocated');
    assert.ok(moved.text.includes('`x [y](lesson.md#fake) z`'), 'code span verbatim');
    assert.equal(reference(moved.text, '图', f.b).file, fs.realpathSync(path.join(f.a, 'graph.svg')));
  });

  arm('A20 display-math definition ignored', () => {
    const f = fixture('mathdef');
    const head = '用 ![图][fig]。';
    const doc = head + '\n$$\n[fig]: fake-math.svg\n$$\n\n[fig]: graph.svg\n';
    const open = doc.indexOf('$$'), close = doc.indexOf('$$', open + 2) + 2;
    cross(f);
    const id = patched.sourceImageTicket(makeState(doc), makeIndex({math: [{from: open, to: close}]}),
      [{from: 0, to: head.length}], 'tok');
    const moved = patched.readImageTransfer(id, head);
    assert.ok(moved && moved.text !== head, 'usage relocated');
    assert.ok(!moved.text.includes('fake-math'), 'math-block definition does not shadow');
    assert.equal(reference(moved.text, '图', f.b).file, fs.realpathSync(path.join(f.a, 'graph.svg')));
  });

  arm('A21 mid-line definition context', () => {
    const f = fixture('middef');
    const sliceText = '[fig]: graph.svg';
    const doc = '文字 ' + sliceText + '\n';
    cross(f);
    const from = doc.indexOf(sliceText);
    const id = patched.sourceImageTicket(makeState(doc), makeIndex(), [{from, to: from + sliceText.length}], 'tok');
    assert.equal(id, null, 'partial-line prefix is not a definition');
  });

  arm('A22 definition tail cut', () => {
    const f = fixture('deftail');
    const doc = '[fig]: graph.svg 尾巴\n';
    cross(f);
    const id = patched.sourceImageTicket(makeState(doc), makeIndex(), [{from: 0, to: '[fig]: graph.svg'.length}], 'tok');
    assert.equal(id, null, 'incomplete definition line is not relocated');
  });

  arm('A23 straddling usage tail', () => {
    const f = fixture('tail');
    const slice = '甲 [图]';
    const doc = slice + '(graph.svg) 乙\n\n[图]: graph.svg\n';
    cross(f);
    const id = patched.sourceImageTicket(makeState(doc), makeIndex(), [{from: 0, to: slice.length}], 'tok');
    assert.equal(id, null, 'shorthand continuing outside the selection untouched');
  });

  arm('A24 definitions scanned only when needed', () => {
    const f = fixture('scanwhen');
    cross(f);
    const spy = {};
    assert.equal(patched.sourceImageTicket(makeState('平凡文字没有括号\n', spy), makeIndex(),
      [{from: 0, to: 8}], 'tok'), null);
    assert.equal(spy.iterated || 0, 0, 'no document scan for plain text');
    const spy2 = {};
    const id = patched.sourceImageTicket(makeState(srcText, spy2), makeIndex(), [{from: 0, to: line.length}], 'tok');
    assert.ok(id && id !== 'unavailable', 'ticket minted');
    assert.ok((spy2.iterated || 0) > 0, 'document scanned once labels pend');
  });

  arm('A25 blockquote definition binds', () => {
    const f = fixture('quotedef');
    const text = '用 ![图][fig]。';
    const doc = text + '\n\n> [fig]: graph.svg\n';
    cross(f);
    const id = patched.sourceImageTicket(makeState(doc), makeIndex(), [{from: 0, to: text.length}], 'tok');
    const moved = patched.readImageTransfer(id, text);
    assert.ok(moved && moved.text !== text, 'relocated');
    assert.equal(reference(moved.text, '图', f.b).file, fs.realpathSync(path.join(f.a, 'graph.svg')));
  });

  arm('A26 traveling definition keeps reference usages', () => {
    const f = fixture('quotetravel');
    const text = '> 见 [参考][book]\n> [book]: lesson.md#lemma';
    const doc = text + '\n';
    cross(f);
    const id = patched.sourceImageTicket(makeState(doc), makeIndex(), [{from: 0, to: text.length}], 'tok');
    const moved = patched.readImageTransfer(id, text);
    assert.ok(moved && moved.text !== text, 'destination relocated');
    const lines = moved.text.split('\n');
    assert.ok(lines[0].includes('[参考][book]'), 'usage stays reference-form');
    assert.match(lines[1], /^> \[book\]: \.\.\//, 'quote prefix kept, destination rewritten');
  });

  arm('A27 quoted fenced definition ignored', () => {
    const f = fixture('quotefence');
    const head = '用 ![图][fig]。';
    const doc = head + '\n\n> ```\n> [fig]: qfence-evil.svg\n> ```\n\n[fig]: graph.svg\n';
    const open = doc.indexOf('> ```'), close = doc.indexOf('> ```', open + 6) + 5;
    cross(f);
    const id = patched.sourceImageTicket(makeState(doc), makeIndex({code: [{from: open, to: close}]}),
      [{from: 0, to: head.length}], 'tok');
    const moved = patched.readImageTransfer(id, head);
    assert.ok(moved && moved.text !== head, 'usage relocated');
    assert.ok(!moved.text.includes('qfence-evil'), 'quoted fenced definition ignored');
    assert.equal(reference(moved.text, '图', f.b).file, fs.realpathSync(path.join(f.a, 'graph.svg')));
  });

  arm('A28 fenced definition inside selection stays literal', () => {
    const f = fixture('slicefence');
    const text = '```\n[fig]: fence-evil.svg\n```';
    const doc = text + '\n\n[fig]: graph.svg\n';
    cross(f);
    const id = patched.sourceImageTicket(makeState(doc), makeIndex(), [{from: 0, to: text.length}], 'tok');
    assert.equal(id, null, 'fenced content inside the selection is never a definition');
  });

  arm('A29 conflicting incoming definition renamed', () => {
    const f = fixture('collide');
    const pasted = '[x][fig] 引用\n\n[fig]: https://example.com/r.png\n';
    const destDoc = '已有 [y][fig]。\n\n[fig]: graph.svg\n';
    const settled = patched.reconcilePastedDefinitions(pasted, destDoc, [{from: 0, to: 0}]);
    assert.notEqual(settled, pasted, 'conflict reconciled');
    assert.match(settled, /\[fig-1\]: https:\/\/example\.com\/r\.png/, 'incoming definition renamed');
    assert.ok(settled.includes('[x][fig-1]'), 'usage follows the renamed definition');
    assert.ok(settled.includes('[y][fig]') === false, 'pasted text has no destination usages');
    const text = settled + '\n' + destDoc;
    assert.equal(reference(text, 'y', f.b).file, fs.realpathSync(path.join(f.b, 'graph.svg')),
      'destination usage keeps its own definition');
  });

  arm('A30 non-conflicting incoming definitions stay verbatim', () => {
    const f = fixture('noconflict');
    const pasted = '[x][solo]\n\n[solo]: graph.svg\n';
    const destDoc = '别的 [y][fig]。\n\n[fig]: graph.svg\n';
    assert.equal(patched.reconcilePastedDefinitions(pasted, destDoc, []), pasted);
  });

  arm('A31 inline titles keep quote characters', () => {
    const f = fixture('quotetitle');
    const text = 'A [t1][dq] B [t2][sq] C [t3][par]';
    const doc = text + '\n\n[dq]: lesson.md#lemma \'含"双"引号\'\n[sq]: lesson.md#lemma "it\'s"\n[par]: lesson.md#lemma "a(b)"\n';
    cross(f);
    const id = patched.sourceImageTicket(makeState(doc), makeIndex(), [{from: 0, to: text.length}], 'tok');
    const moved = patched.readImageTransfer(id, text);
    assert.ok(moved && moved.text !== text, 'relocated');
    assert.ok(moved.text.includes("'含\"双\"引号'"), 'double quotes kept via single-quote delimiters');
    assert.ok(moved.text.includes('"it\'s"'), 'apostrophe kept via double-quote delimiters');
    assert.ok(moved.text.includes('"a\\(b\\)"'), 'parens backslash-escaped');
    assert.ok(!/%2[28]/.test(moved.text), 'no percent-encoded title characters');
  });

  arm('A32 judge-equivalent definitions-travel paste', () => {
    const f = fixture('deffull');
    const original = '搬来的 ![搬来图][fig] 和 [搬来讲义][book]。\n\n[fig]: graph.svg \'标题 "前" (后)\'\n\n> [book]: lesson.md#lemma\n\n';
    const dest = '已有 ![原图][fig] 和 [原讲义][book]。\n\n[fig]: graph.svg\n[book]: lesson.md#local\n';
    fs.writeFileSync(path.join(f.a, 'source.md'), original);
    fs.writeFileSync(path.join(f.b, 'target.md'), dest);
    cross(f);
    const id = patched.sourceImageTicket(makeState(original), makeIndex(), [{from: 0, to: original.length}], 'tok');
    assert.ok(id && id !== 'unavailable', 'ticket minted');
    const moved = patched.readImageTransfer(id, original);
    assert.ok(moved && moved.text !== original, 'destinations relocated');
    const settled = patched.reconcilePastedDefinitions(moved.text, dest, [{from: 0, to: 0}]);
    const text = settled + dest;
    // refer() ported verbatim from visual/reference-definitions.cjs.
    const refer = (label, folder) => {
      const m = new RegExp('!?\\[' + label + '\\](?:\\(([^\\s)]+)([^\\n]*)|\\[([^\\]]+)\\])', 'u').exec(text);
      assert.ok(m, 'literal link found: ' + label);
      let uri = m[1], suffix = m[2] || '';
      if (!uri) {
        const def = text.split('\n').map(s => /^\s*(?:>\s*)?\[([^\]]+)\]:\s*(\S+)(.*)$/.exec(s))
          .find(d => d && d[1].toLowerCase() === m[3].toLowerCase());
        assert.ok(def, label + ' has a definition');
        uri = def[2]; suffix = def[3];
      }
      const i = uri.indexOf('#');
      return {file: fs.realpathSync(path.resolve(folder, decodeURIComponent(i < 0 ? uri : uri.slice(0, i)))),
        fragment: i < 0 ? '' : uri.slice(i),
        title: suffix.trim().replace(/\)$/, '').trim().replace(/^["']|["']$/g, '').replace(/\\(["'()\\])/g, '$1')};
    };
    assert.equal(refer('原图', f.b).file, fs.realpathSync(path.join(f.b, 'graph.svg')),
      'existing destination image still resolves to its own file');
    assert.equal(refer('原讲义', f.b).file, fs.realpathSync(path.join(f.b, 'lesson.md')));
    assert.equal(refer('原讲义', f.b).fragment, '#local', 'existing fragment untouched');
    assert.equal(refer('搬来图', f.b).file, fs.realpathSync(path.join(f.a, 'graph.svg')));
    assert.equal(refer('搬来图', f.b).title, '标题 "前" (后)', 'title characters survive');
    assert.equal(refer('搬来讲义', f.b).file, fs.realpathSync(path.join(f.a, 'lesson.md')));
    assert.equal(refer('搬来讲义', f.b).fragment, '#lemma');
  });

  arm('A33 same-folder sibling paste matches the GUI judge', () => {
    const root = path.join(tmp, 'samesib');
    fs.mkdirSync(root, {recursive: true});
    for (const c of ['red', 'blue'])
      fs.writeFileSync(path.join(root, c + '.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="' + c + '"/></svg>');
    const fromFile = path.join(root, 'original.md'), toFile = path.join(root, 'summary.md');
    const move = 'MOVE ![本图][pic] [网站][web] [邮件地址][mail] [来源小节][frag]';
    const from = move + '\n\n# lemma\n\n[pic]: red.svg\n[web]: https://source.invalid/lecture?q=1#a\n[mail]: mailto:author@example.invalid\n[frag]: #lemma\n';
    const to = '目标的 ![原图][pic] [原网][web] [原邮][mail] [原节][frag]。\n\n[pic]: blue.svg\n[web]: https://dest.invalid/old\n[mail]: mailto:other@example.invalid\n[frag]: #local\n';
    fs.writeFileSync(fromFile, from); fs.writeFileSync(toFile, to);
    installHost({srcFile: fromFile, recoverFile: toFile});
    const id = patched.sourceImageTicket(makeState(from), makeIndex(), [{from: 0, to: move.length}], 'tok');
    assert.ok(id && id !== 'unavailable', 'ticket minted');
    const moved = patched.readImageTransfer(id, move);
    assert.ok(moved && moved.text !== move, 'usages relocated');
    assert.equal(moved.crossDocument, true, 'same folder is a different document');
    const text = moved.text + '\n\n' + to;
    // address() ported from visual/reference-same-folder.cjs.
    const address = label => {
      const m = new RegExp('!?\\[' + label + '\\](?:\\(([^\\s)]+)|\\[([^\\]]+)\\])').exec(text);
      assert.ok(m, label);
      let url = m[1];
      if (!url) {
        const d = text.split('\n').map(l => /^\s*(?:>\s*)?\[([^\]]+)\]:\s*(\S+)/.exec(l))
          .find(d => d && d[1].toLowerCase() === m[2].toLowerCase());
        assert.ok(d, label + ' definition');
        url = d[2];
      }
      return new URL(url, pathToFileURL(toFile)).href;
    };
    const wanted = [pathToFileURL(path.join(root, 'red.svg')).href, 'https://source.invalid/lecture?q=1#a',
      'mailto:author@example.invalid', pathToFileURL(fromFile).href + '#lemma',
      pathToFileURL(path.join(root, 'blue.svg')).href, 'https://dest.invalid/old',
      'mailto:other@example.invalid', pathToFileURL(toFile).href + '#local'];
    const names = ['本图', '网站', '邮件地址', '来源小节', '原图', '原网', '原邮', '原节'];
    for (let i = 0; i < names.length; i++)
      assert.equal(address(names[i]), wanted[i], names[i] + ' keeps its original resource identity');
  });

  arm('A34 same-file paste never reconciles labels', () => {
    const f = fixture('samefile2');
    fs.writeFileSync(f.srcFile, '引 ![图][fig]\n\n[fig]: graph.svg\n');
    installHost(f);
    const text = '引 ![图][fig]\n\n[fig]: graph.svg\n';
    const id = patched.sourceImageTicket(makeState(text), makeIndex(), [{from: 0, to: text.length}], 'tok');
    const moved = patched.readImageTransfer(id, text);
    assert.ok(moved, 'receipt resolves');
    assert.equal(moved.text, text, 'same actual file keeps everything verbatim');
    assert.equal(moved.crossDocument, false, 'no cross-document reconciliation');
  });

  arm('A35 remote and mailto definitions inline verbatim', () => {
    const f = fixture('remoteuse');
    const text = 'A [r][rel] B [m][mail] C ![pic][img] D ![m][mimg]';
    const doc = text + '\n\n[rel]: https://example.com/y.png\n[mail]: mailto:a@b.c\n[img]: http://example.com/i.png\n[mimg]: mailto:x@y.z\n';
    cross(f);
    const id = patched.sourceImageTicket(makeState(doc), makeIndex(), [{from: 0, to: text.length}], 'tok');
    const moved = patched.readImageTransfer(id, text);
    assert.ok(moved && moved.text !== text, 'relocated');
    assert.ok(moved.text.includes('[r](https://example.com/y.png)'), 'verbatim https link: ' + moved.text);
    assert.ok(moved.text.includes('[m](mailto:a@b.c)'), 'verbatim mailto link');
    assert.ok(moved.text.includes('![pic](http://example.com/i.png)'), 'verbatim http image (displayable protocol)');
    assert.ok(moved.text.includes('![m][mimg]'), 'mailto image stays reference-form');
  });

  arm('A36 fragment-bound usage points at the source note', () => {
    const f = fixture('fraguse');
    fs.writeFileSync(f.srcFile, 'x');
    const text = '见 [fn][note]';
    const doc = text + '\n\n[note]: #lemma\n';
    cross(f);
    const id = patched.sourceImageTicket(makeState(doc), makeIndex(), [{from: 0, to: text.length}], 'tok');
    const moved = patched.readImageTransfer(id, text);
    assert.ok(moved && moved.text !== text, 'relocated');
    const r = reference(moved.text, 'fn', f.b);
    assert.equal(r.file, fs.realpathSync(f.srcFile), 'anchor keeps its source note');
    assert.equal(r.fragment, '#lemma');
  });

  arm('A37 unsupported external definitions are not auto-inlined', () => {
    const f = fixture('unsup');
    const text = 'A [f][lf] B [d][ld] C [j][lj] D [u][lu] E [c][lc]';
    const doc = text + '\n\n[lf]: file:///C:/x.md\n[ld]: data:text/plain,hi\n[lj]: javascript:alert(1)\n[lu]: \\\\srv\\share\\x.md\n[lc]: https://e.com/\u0001x\n';
    cross(f);
    const id = patched.sourceImageTicket(makeState(doc), makeIndex(), [{from: 0, to: text.length}], 'tok');
    assert.equal(id, null, 'no auto-inline for file:/data:/javascript:/UNC/control characters');
  });

  // The pre-existing image contract: tokens are parsed from full original
  // lines and admitted only when completely inside the selection, so a slice
  // starting at the second character of an image mark — which happens to read
  // like a complete `[a](fig.png)` link — stays plain, and engine-indexed
  // remote marks never register.
  arm('A38 image-mark fragments and remote marks stay plain', () => {
    const f = fixture('imgfrag');
    cross(f);
    const text = 'prefix ![a](fig.png)\n`![a](fig.png)`';
    const from = text.indexOf('!'), to = text.indexOf(')') + 1, a = text.indexOf('fig.png');
    const region = {from, to, data: {from, to, image: {src: 'fig.png'}, form: 'markdown', payload: [a, a + 7]}};
    const index = makeIndex({image: [region]});
    const state = makeState(text);
    assert.ok(patched.sourceImageTicket(state, index, [{from, to}], 'tok'), 'full known mark issues a ticket');
    assert.equal(patched.sourceImageTicket(state, index, [{from: from + 1, to}], 'tok'), null,
      'a partial cut reading like [a](fig.png) stays plain');
    assert.equal(patched.sourceImageTicket(state, index, [{from: text.indexOf('`'), to: text.length}], 'tok'), null,
      'code-span image text stays plain');
    region.data.image.src = 'https://example.test/f.png';
    assert.equal(patched.sourceImageTicket(state, index, [{from, to}], 'tok'), null, 'remote marks stay plain');
  });

  // The deliberate new semantics: the same document shape with a genuinely
  // complete plain link registers and relocates. The legacy suite never
  // asserted links-plain; this positive counter-example documents the change.
  arm('A39 complete links in the same shape do register', () => {
    const f = fixture('linkshape');
    const text = 'prefix [a](notes.md) tail';
    const from = text.indexOf('[', 7), to = text.indexOf(')') + 1;
    cross(f);
    const id = patched.sourceImageTicket(makeState(text + '\n'), makeIndex(), [{from, to}], 'tok');
    assert.ok(id && id !== 'unavailable', 'a genuinely complete link registers');
    const moved = patched.readImageTransfer(id, '[a](notes.md)');
    assert.ok(moved && moved.text !== '[a](notes.md)', 'relocated');
  });

  for (const r of results) log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + (r.ok ? '' : '\n      ' + r.error));
  try { fs.rmSync(tmp, {recursive: true, force: true}); } catch { /* evidence stays in temp */ }
  return {passed: results.every(r => r.ok), total: results.length,
    failed: results.filter(r => !r.ok).map(r => r.name), arms: results};
}

// ── CLI entry: resolve the repository root relative to this file ───────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let root = here;
  for (let i = 0; i < 8 && !fs.existsSync(path.join(root, 'dsh-markpilot', 'package.json')); i++) root = path.dirname(root);
  assert.ok(fs.existsSync(path.join(root, 'dsh-markpilot', 'package.json')),
    'repository root not found: expected <root>/dsh-markpilot next to <root>/MarkPilot-CM6');
  const report = await runSuite({
    engineDir: path.join(root, 'dsh-markpilot'),
    shellFile: path.join(root, 'MarkPilot-CM6', 'shell', 'clipboard-image-source.cjs'),
    log: line => console.log(line),
  });
  // Verdict goes to stdout only: running this suite against frozen sources
  // must never dirty the tree or the next git diff. An explicit
  // MP_TEST_RESULT_DIR opts into a result file, written there and nowhere
  // near the source tree by default.
  if (process.env.MP_TEST_RESULT_DIR) {
    fs.mkdirSync(process.env.MP_TEST_RESULT_DIR, {recursive: true});
    fs.writeFileSync(path.join(process.env.MP_TEST_RESULT_DIR, 'reference-transfer-result.json'),
      JSON.stringify(report, null, 2));
  }
  console.log(report.passed ? `ALL ${report.total} ARMS GREEN` : `${report.failed.length}/${report.total} FAILED`);
  process.exitCode = report.passed ? 0 : 1;
}
