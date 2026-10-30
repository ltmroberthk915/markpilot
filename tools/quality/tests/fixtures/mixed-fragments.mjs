import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { LanguageSupport, LanguageDescription, StreamLanguage, ParseContext, forceParsing, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { javascript } from '@codemirror/legacy-modes/mode/javascript';
import { Tree, TreeBuffer, NodeProp, TreeFragment } from '@lezer/common';
import { createAsyncMarkdown } from '../../../../dsh-markpilot/src-cm6/async-markdown.js';
import { createRawTreeCodec } from '../../../../dsh-markpilot/src-cm6/worker-tree-codec.js';

export function run() {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = class {};
  const codeLanguages = [LanguageDescription.of({ name: 'javascript', alias: ['js'], support: new LanguageSupport(StreamLanguage.define(javascript)) })];
  const rawParser = markdownLanguage.parser, codec = createRawTreeCodec({ Tree, TreeBuffer, NodeProp });
  const native = markdown({ base: markdownLanguage, codeLanguages }).language.parser;
  const table = '| A | B |\n| --- | --- |\n' + '| value one | value two |\n'.repeat(6000);
  const mixed = '```js\nconst answer = 42;\n```\n\n<div>html</div>\n\n';
  const results = [];
  try {
    for (const nested of [false, true]) {
      const text = (nested ? mixed : '') + table + '\n\nEND PARAGRAPH\n';
      const async = createAsyncMarkdown(markdownLanguage), field = async.extension[0];
      const support = markdown({ base: async.language, codeLanguages });
      const wrapped = async.withMixedSupport(support), calls = [];
      assert.equal(wrapped.language.data, support.language.data);
      assert.equal(wrapped.support, support.support);
      assert.equal(wrapped.language.allowsNesting, support.language.allowsNesting);
      const outerStart = wrapped.language.parser.startParse, innerStart = support.language.parser.startParse;
      let inputFragments;
      wrapped.language.parser.startParse = function (input, fragments, ranges) {
        inputFragments = fragments;
        return outerStart.call(this, input, fragments, ranges);
      };
      support.language.parser.startParse = function (input, fragments, ranges) {
        const current = ParseContext.get()?.state.field(field, false);
        calls.push({ incoming: inputFragments, outgoing: fragments, status: current?.status, forced: current?.forceNative });
        return innerStart.call(this, input, fragments, ranges);
      };
      const view = { state: EditorState.create({ doc: text, extensions: [async.extension, wrapped] }),
        dispatch(spec) { this.state = this.state.update(spec).state; } };
      const ready = () => {
        const current = view.state.field(field), source = view.state.doc.toString(), raw = rawParser.parse(source);
        current.fragments = TreeFragment.addTree(raw); current.wire = codec.encode(raw, rawParser.nodeSet); current.status = 'ready'; current.settle();
        // Finish a previously started pending parse before publishing the ready
        // revision, as the real view's parse worker does on its next turn.
        for (let turn = 0; turn < 3 && !syntaxTreeAvailable(view.state); turn++)
          assert(forceParsing(view, source.length, 10000), 'real parser publishes ready snapshot');
        assert(syntaxTreeAvailable(view.state), JSON.stringify({ nested, syntax: async.inspect(view.state), calls: calls.slice(-4).map(c => ({ status:c.status, forced:c.forced, input:c.incoming.length, output:c.outgoing.length })) }));
        assert.equal(syntaxTree(view.state).toString(), native.parse(source).toString());
      };
      ready(); calls.length = 0;
      view.dispatch({ changes: { from: view.state.doc.length, insert: 'x' } });
      const pending = calls.filter(c => c.status === 'pending' && c.incoming.length);
      assert(pending.length, 'actual edit supplies old outer fragments');
      for (const c of pending) {
        if (nested) assert(c.outgoing === c.incoming, 'mounted JS/HTML fragments remain the exact original array');
        else assert.equal(c.outgoing.length, 0, 'table snapshot drops impossible old node identity searches');
      }
      assert.equal(syntaxTreeAvailable(view.state), false, 'pending suffix remains unavailable');
      if (nested) {
        // Let the real outer parser finish its pending prefix's nested work.
        // A State update's 20 ms budget may stop before the HTML mount finishes.
        forceParsing(view, view.state.doc.length, 10000);
        assert.equal(syntaxTreeAvailable(view.state), false);
        for (const token of ['const answer', '<div>']) {
          const at = text.indexOf(token) + 1;
          const chain = tree => { const a = []; for (let n = tree.resolveInner(at, 1); n; n = n.parent) a.push([n.name,n.from,n.to]); return a; };
          assert.deepEqual(chain(syntaxTree(view.state)), chain(native.parse(view.state.doc.toString())), 'pending prefix retains nested language nodes');
        }
      }
      ready();
      calls.length = 0;
      view.dispatch({ changes: { from: view.state.doc.length, insert: 'y' } });
      view.state.field(field).forceNative = true;
      assert(forceParsing(view, view.state.doc.length, 10000));
      const forced = calls.filter(c => c.forced && c.incoming.length);
      assert(forced.length, 'forced native control enters with reusable outer fragments');
      assert(forced.every(c => c.incoming === c.outgoing), 'forced native path preserves all incoming fragments');
      assert.equal(syntaxTree(view.state).toString(), native.parse(view.state.doc.toString()).toString());
      results.push({ nested, pendingCalls: pending.length, forcedCalls: forced.length });
    }
    return results;
  } finally { if (previousWorker === undefined) delete globalThis.Worker; else globalThis.Worker = previousWorker; }
}
