import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { Tree, TreeBuffer, NodeProp, TreeFragment } from '@lezer/common';
import { createAsyncMarkdown } from '../../../../dsh-markpilot/src-cm6/async-markdown.js';
import { createRawTreeCodec, copyPendingPrefix } from '../../../../dsh-markpilot/src-cm6/worker-tree-codec.js';

export function run() {
  const parser = markdownLanguage.parser, codec = createRawTreeCodec({ Tree, TreeBuffer, NodeProp });
  const text = '**stable**\n\n' + 'plain paragraph abcdefghijklmnopqrstuvwxyz\n'.repeat(12000) + '\n**tail**\n';
  const raw = parser.parse(text), wire = codec.encode(raw, parser.nodeSet);
  const docType = raw.type, initialFragments = TreeFragment.addTree(raw);
  const first = copyPendingPrefix({ fragments: initialFragments, changedFrom: text.length - 3,
    inputLength: text.length + 1, documentType: docType, Tree, TreeBuffer });
  assert(first.stop < text.length);
  assert(first.tree.toString().includes('StrongEmphasis'));
  assert.equal(first.tree.resolveInner(text.indexOf('tail') + 1, 1).name, 'Paragraph', 'cross-boundary inline token is discarded');
  // No returned node or buffer may alias the raw cache that MixedParse protects.
  const objects = new Set();
  const collect = node => { objects.add(node); if (node instanceof TreeBuffer) objects.add(node.buffer); else node.children.forEach(collect); };
  collect(raw);
  const independent = node => { assert(!objects.has(node)); if (node instanceof TreeBuffer) assert(!objects.has(node.buffer)); else node.children.forEach(independent); };
  independent(first.tree);
  assert.deepEqual(codec.encode(raw, parser.nodeSet), wire, 'raw cache remains exact');

  // Exercise actual buffered records and every possible boundary, including an
  // inline span crossing the cut. The codec validates subtree end indices.
  const small = parser.parse('> quote **strong** and *em*\n> next `code`\n\n- one\n- two\n');
  let cuts = 0;
  for (let cut = 1; cut < small.length; cut++) {
    const p = copyPendingPrefix({ fragments: TreeFragment.addTree(small), changedFrom: cut,
      inputLength: small.length + 1, documentType: small.type, Tree, TreeBuffer });
    codec.decode(codec.encode(p.tree, parser.nodeSet), parser.nodeSet); cuts++;
  }
  for (const bad of [new TreeFragment(1, raw.length, raw, 0, false, true),
    new TreeFragment(0, raw.length, raw, 1, false, true), new TreeFragment(0, raw.length, raw, 0, true, true)]) {
    assert.equal(copyPendingPrefix({ fragments: [bad], changedFrom: text.length,
      inputLength: text.length, documentType: docType, Tree, TreeBuffer }).stop, 0);
  }

  const previousWorker = globalThis.Worker, startParse = parser.startParse;
  let nativeCalls = 0;
  globalThis.Worker = class {};
  parser.startParse = function (...args) { nativeCalls++; return startParse.apply(this, args); };
  try {
    const async = createAsyncMarkdown(markdownLanguage), field = async.extension[0];
    let state = EditorState.create({ doc: text, extensions: [async.extension, async.language] });
    const current = state.field(field);
    current.fragments = initialFragments; current.wire = wire; current.status = 'ready';
    state = state.update({ changes: { from: text.length, insert: '-' } }).state;
    assert.equal(nativeCalls, 0, 'pending prefix never starts a synchronous native parse');
    assert.equal(syntaxTreeAvailable(state), false, 'official suffix skip keeps whole syntax unavailable');
    assert(syntaxTree(state).toString().includes('StrongEmphasis'), 'known prefix formatting survives');
    assert(async.inspect(state).prefixFallback <= 2, 'no fixed-stoppedAt busy loop');
    state = state.update({ changes: { from: 2000, to: 2001, insert: 'Z' } }).state;
    const beforeLast = state.field(field).fragments[0]?.to || 0;
    assert(beforeLast > 0, 'the negative control must retain a nonempty prefix');
    state = state.update({ changes: { from: state.doc.length, insert: 'Q' } }).state;
    const pending = state.field(field), safe = copyPendingPrefix({ fragments: pending.fragments,
      changedFrom: pending.changedFrom, inputLength: state.doc.length, documentType: docType, Tree, TreeBuffer });
    assert(safe.stop <= beforeLast && safe.stop <= 2000, 'later edit cannot revive an earlier unparsed gap');
    assert.equal(syntaxTreeAvailable(state), false);
    assert.equal(nativeCalls, 0);
    assert(async.inspect(state).prefixFallback <= 6, 'each edit completes one bounded prefix publication');
    const marked = '- item\n<div>html</div>\n' + 'ordinary\n'.repeat(18000);
    let replaced = EditorState.create({ doc: marked, extensions: [async.extension, async.language] });
    assert(replaced.field(field).mayContainer && replaced.field(field).mayHTML);
    // A partial deletion must keep the conservative flags for content elsewhere.
    replaced = replaced.update({ changes: { from: 0, to: 1 } }).state;
    assert(replaced.field(field).mayContainer && replaced.field(field).mayHTML);
    replaced = replaced.update({ changes: { from: 0, to: replaced.doc.length, insert: text } }).state;
    assert.equal(replaced.field(field).mayContainer, false, 'whole replacement clears an obsolete list/quote command requirement');
    assert.equal(replaced.field(field).mayHTML, false, 'whole replacement clears an obsolete HTML command requirement');
    replaced = replaced.update({ changes: { from: 0, to: replaced.doc.length, insert: marked } }).state;
    assert(replaced.field(field).mayContainer && replaced.field(field).mayHTML, 'new actual markup still requires native command semantics');
    return { bufferedCuts: cuts, nativeCalls, prefixFallback: async.inspect(state).prefixFallback, rawUnchanged: true };
  } finally { parser.startParse = startParse; if (previousWorker === undefined) delete globalThis.Worker; else globalThis.Worker = previousWorker; }
}
