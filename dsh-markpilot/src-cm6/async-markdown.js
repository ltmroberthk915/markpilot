import { StateField, Prec } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap } from '@codemirror/view';
import { Language, LanguageSupport, ParseContext, syntaxTree, syntaxTreeAvailable, forceParsing } from '@codemirror/language';
import { markdownKeymap } from '@codemirror/lang-markdown';
import { defaultKeymap, cursorGroupLeft, cursorGroupRight, deleteGroupBackward, deleteGroupForward } from '@codemirror/commands';
import { foldKeymap } from '@codemirror/language';
import { completionKeymap } from '@codemirror/autocomplete';
import { Tree, TreeBuffer, NodeProp, TreeFragment, Parser } from '@lezer/common';
import { codeBlockAt } from './markdown-context.js';
import { createRawTreeCodec, createReadyPartial, copyPendingPrefix } from './worker-tree-codec.js';

export function createAsyncMarkdown(base, { threshold = 128 * 1024 } = {}) {
  const codec = createRawTreeCodec({ Tree, TreeBuffer, NodeProp });
  const documentType = base.parser.nodeSet.types.find(type => type.name === 'Document');
  let revision = 0, armedDoc = null, armTimer = null;
  const markers = /^[ \t]*(?:>|[-+*][ \t]|\d+[.)][ \t])/m;
  const entry = (doc, before = null, changes = null) => {
    if (doc.length < threshold || typeof Worker === 'undefined') return null;
    let settle;
    const promise = new Promise(resolve => { settle = resolve; });
    const ranges = []; let changedFrom = -1;
    changes?.iterChangedRanges((fromA,toA,fromB,toB)=>{ ranges.push({fromA,toA,fromB,toB}); if (changedFrom < 0 || fromB < changedFrom) changedFrom = fromB; });
    const replaced = before && ranges.length === 1 && ranges[0].fromA === 0 && ranges[0].toA === before.doc.length;
    // A complete replacement has no remaining old markup. Keeping its old
    // flags would force every ordinary Enter through a full native parse.
    let mayContainer = !replaced && before?.mayContainer || false, mayHTML = !replaced && before?.mayHTML || false;
    if (!before || replaced) { for (const line of doc.iterLines()) { mayContainer ||= markers.test(line); mayHTML ||= line.includes('<'); if (mayContainer && mayHTML) break; } }
    else if (!mayContainer || !mayHTML) changes.iterChanges((_a, _b, from, to, inserted) => {
      const s = inserted.toString(); mayHTML ||= s.includes('<');
      mayContainer ||= markers.test(s) || markers.test(doc.lineAt(from).text) || markers.test(doc.lineAt(to).text);
    });
    return { doc, revision: ++revision, status: 'pending', promise, settle, wire: null, mayContainer, mayHTML, changedFrom,
      forceNative: !!(before && armedDoc === before.doc), fragments: before ? TreeFragment.applyChanges(before.fragments, ranges) : [] };
  };
  const field = StateField.define({
    create: state => entry(state.doc),
    update: (value, tr) => tr.docChanged ? entry(tr.state.doc, value, tr.changes) : value,
  });
  const counters = { requests: 0, resets: 0, deltas: 0, completed: 0, discarded: 0, nativeFallback: 0, prefixFallback: 0, commandFallback: 0, error: null };
  const parser = base.parser.configure({ wrap(inner, input, fragments, ranges) {
    const pending = ParseContext.get()?.state.field(field, false);
    if (!pending || ranges.length !== 1 || ranges[0].from !== 0 || ranges[0].to !== input.length || pending.doc.length !== input.length) return inner;
    if (pending.status === 'ready') return createReadyPartial({ wire: pending.wire, nodeSet: base.parser.nodeSet, codec, inputLength: input.length });
    if (pending.status === 'pending' && !pending.forceNative && pending.changedFrom > 0 && pending.fragments.length) {
      // Keep raw unchanged prefix nodes without reparsing their text. Register
      // the suffix with the official promise-based skipping parser: a fixed
      // stoppedAt would make ParseContext restart the same prefix until its
      // entire foreground/idle time budget expired. Availability remains false
      // because the suffix is absent from its valid fragments.
      counters.prefixFallback++;
      const prefix = copyPendingPrefix({ fragments: pending.fragments, changedFrom: pending.changedFrom,
        inputLength: input.length, documentType, Tree, TreeBuffer });
      const sub = ParseContext.getSkippingParser(pending.promise).startParse(input, fragments, [{ from: prefix.stop, to: input.length }]);
      return {
        get parsedPos() { return sub.parsedPos; },
        get stoppedAt() { return sub.stoppedAt; },
        stopAt(pos) { sub.stopAt(pos); },
        advance() { return sub.advance() ? prefix.tree : null; },
      };
    }
    if (pending.status === 'failed' || pending.forceNative) {
      counters.nativeFallback++;
      if (!pending.fragments.length) return inner;
      const copies = new Map();
      const fragments = pending.fragments.map(f => {
        if (!copies.has(f.tree)) copies.set(f.tree, codec.decode(codec.encode(f.tree, base.parser.nodeSet), base.parser.nodeSet));
        return new TreeFragment(f.from, f.to, copies.get(f.tree), f.offset, f.openStart, f.openEnd);
      });
      return base.parser.startParse(input, fragments, ranges);
    }
    const skip = ParseContext.getSkippingParser(pending.promise).startParse(input, fragments, ranges);
    // Keep the known outer Markdown language data, but leave all structure
    // pending. The official skip parser still marks every range unparsed.
    return {
      get parsedPos() { return skip.parsedPos; }, get stoppedAt() { return skip.stoppedAt; },
      stopAt(pos) { skip.stopAt(pos); },
      advance() { const tree = skip.advance(); return tree ? new Tree(documentType, [], [], tree.length) : null; },
    };
  } });
  const plugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view; this.worker = null; this.current = null; this.mirror = null; this.failed = false; this.closed = false; this.timer = null;
      this.send(view.state.field(field), null, null);
    }
    update(u) { if (u.docChanged) this.send(u.state.field(field), u.startState.field(field), u.changes); }
    fail(error) {
      counters.error = String(error?.message || error); this.failed = true;
      clearTimeout(this.timer); this.worker?.terminate(); this.worker = null; this.mirror = null;
      if (this.current?.status === 'pending') { this.current.status = 'failed'; this.current.settle(); }
    }
    send(next, before, changes) {
      if (this.current?.status === 'pending') { this.current.status = 'stale'; this.current.settle(); }
      this.current = next; clearTimeout(this.timer);
      if (!next) { this.worker?.terminate(); this.worker = null; this.mirror = null; return; }
      if (this.failed) { next.status = 'failed'; next.settle(); return; }
      try {
        if (!this.worker) {
          const worker = this.worker = new Worker(new URL('cm6/markdown-worker.js', location.href));
          worker.onerror = event => { if (!this.closed && this.worker === worker) this.fail(Error(event.message || 'Markdown Worker failed')); };
          worker.onmessageerror = () => { if (!this.closed && this.worker === worker) this.fail(Error('Markdown Worker message could not be decoded')); };
          worker.onmessage = ({ data }) => {
            if (this.closed || this.worker !== worker) return;
            const current = this.current;
            if (!current || data.revision !== current.revision || current.doc !== this.view.state.doc) { counters.discarded++; return; }
            if (data.type === 'error') { this.fail(Error(data.error)); return; }
            try {
              if (data.type !== 'tree' || data.length !== current.doc.length) throw Error('Markdown Worker revision/length mismatch');
              // Validate now, decode afresh for every parse: MixedParse mutates Tree nodes.
              const raw = codec.decode(data.wire, base.parser.nodeSet);
              current.fragments = TreeFragment.addTree(raw);
              current.wire = data.wire; current.status = 'ready'; clearTimeout(this.timer);
              counters.completed++; current.settle();
              // CM6 normally stops beyond the viewport. The Worker already did
              // the full parse, so publish that complete tree through the public API.
              forceParsing(this.view, current.doc.length, 20);
            } catch (error) { this.fail(error); }
          };
        }
        const delta = before && changes && this.mirror === before.revision;
        if (delta) {
          const edits = [];
          changes.iterChanges((from, to, _fromB, _toB, insert) => edits.push({ from, to, insert: insert.toString() }));
          this.worker.postMessage({ type: 'change', baseRevision: before.revision, revision: next.revision, length: next.doc.length, edits });
          counters.deltas++;
        } else {
          this.worker.postMessage({ type: 'reset', revision: next.revision, text: next.doc.toString() });
          counters.resets++;
        }
        this.mirror = next.revision; counters.requests++;
        this.timer = setTimeout(() => this.fail(Error('Markdown Worker did not finish')), 15000);
      } catch (error) { this.fail(error); }
    }
    destroy() {
      this.closed = true; clearTimeout(this.timer); this.worker?.terminate(); this.worker = null;
      clearTimeout(armTimer); armedDoc = null;
      if (this.current?.status === 'pending') { this.current.status = 'stale'; this.current.settle(); }
    }
  });
  const ensureForCommand = view => {
    const value = view.state.field(field, false);
    if (!value || syntaxTreeAvailable(view.state)) return;
    if (value.status !== 'ready') { value.forceNative = true; counters.commandFallback++; }
    forceParsing(view, view.state.doc.length, 1000);
    if (!syntaxTreeAvailable(view.state)) throw Error('Markdown command requires a complete syntax tree');
  };
  const arm = view => { const doc = view.state.doc; armedDoc = doc; clearTimeout(armTimer); armTimer = setTimeout(() => { if (armedDoc === doc) armedDoc = null; armTimer = null; }, 0); };
  const needsMarkdown = (view, key) => {
    const value = view.state.field(field, false);
    if (!value) return false;
    if (key === 'Enter') return value.mayContainer || value.mayHTML || view.state.selection.ranges.some(r => codeBlockAt(view.state, r.from) || /^ {4}|^\t/.test(view.state.doc.lineAt(r.from).text));
    return view.state.selection.ranges.some(r => {
      if (!r.empty) return false;
      const line = view.state.doc.lineAt(r.from), prefix = line.text.slice(0, r.from - line.from);
      const pair = view.state.doc.sliceString(Math.max(0, r.from-1), r.from+1);
      const markup = /^[ \t]*(?:>|[-+*][ \t]|\d+[.)][ \t])/.test(prefix) && /^[\s>\d.)\-+*\[\]xX]*$/.test(prefix);
      return markup || ['()','[]','{}','""',"''",'``'].includes(pair);
    });
  };
  const nativeKeys = Prec.high(keymap.of(markdownKeymap.map(binding => ({ ...binding,
    run: view => { if (needsMarkdown(view, binding.key)) { ensureForCommand(view); arm(view); } return binding.run(view); },
    ...(binding.shift ? { shift: view => { if (needsMarkdown(view, binding.key)) { ensureForCommand(view); arm(view); } return binding.shift(view); } } : {}),
  }))));
  const syntaxKeyNames = new Set(['Alt-ArrowLeft','Alt-ArrowRight','Mod-i','Mod-[','Mod-]','Mod-Alt-\\','Shift-Mod-\\','Mod-/','Alt-A','Mod-Enter']);
  const wordCommands = new Set([cursorGroupLeft,cursorGroupRight,deleteGroupBackward,deleteGroupForward]);
  const wordContext = view => {
    const value = view.state.field(field, false);
    return !!value && (value.mayHTML || view.state.selection.ranges.some(r => codeBlockAt(view.state, r.from) || /^ {4}|^\t/.test(view.state.doc.lineAt(r.from).text)));
  };
  // Prepare the tree, then leave execution to the original ordered keymaps.
  // In particular closeBrackets Backspace must precede deleteCharBackward.
  const prepare = (view, binding, always = false) => {
    if (always || syntaxKeyNames.has(binding.key) || (binding.key === 'Enter' || binding.key === 'Backspace') && needsMarkdown(view,binding.key) || wordCommands.has(binding.run) && wordContext(view)) {
      ensureForCommand(view); arm(view);
    }
    return false;
  };
  const syntaxKeys = keymap.of([
    ...defaultKeymap.map(binding => ({ ...binding, run: view => prepare(view,binding), ...(binding.shift ? {shift: view => prepare(view,binding)} : {}) })),
    ...foldKeymap.map(binding => ({ ...binding, run: view => prepare(view,binding,true) })),
  ]);
  const completionGuard = Prec.highest(keymap.of(completionKeymap.filter(binding => binding.key === 'Ctrl-Space').map(binding => ({ ...binding, run: view => prepare(view,binding,true) }))));
  const guardedInput = Prec.highest(EditorView.inputHandler.of((view, from, to, text) => {
    const value = view.state.field(field, false);
    if (!value || view.compositionStarted || view.state.readOnly) return false;
    const line = view.state.doc.lineAt(from), prefix = line.text.slice(0,from-line.from);
    const quote = (text === '"' || text === "'") && view.state.selection.ranges.some(range => range.empty);
    if (quote || codeBlockAt(view.state,from) || /^ {4}|^\t/.test(line.text) || (value.mayHTML && /[<>"'`{}()[\]]/.test(text)) || /<[\w:/-]*$/.test(prefix) || text === '<') {
      ensureForCommand(view); arm(view);
    }
    return false;
  }));
  const guardedPaste = EditorView.domEventHandlers({ paste(event, view) {
    if (!view.state.selection.main.empty && /^(https?:\/\/|mailto:|xmpp:|www\.)/.test(event.clipboardData?.getData('text/plain') || '')) { ensureForCommand(view); arm(view); }
    return false;
  } });
  return {
    language: new Language(base.data, parser, [], base.name), extension: [field, plugin, nativeKeys, syntaxKeys, completionGuard, guardedInput, guardedPaste],
    withMixedSupport(support) {
      const language = support.language;
      const outer = new class extends Parser {
        createParse(input, fragments, ranges) {
          const context = ParseContext.get(), current = context?.state.field(field, false);
          if (current && current.doc === context.state.doc && !current.forceNative &&
              (current.status === 'pending' || current.status === 'ready') &&
              current.doc.length === input.length && ranges.length === 1 &&
              ranges[0].from === 0 && ranges[0].to === input.length) {
            // Worker snapshots contain independent nodes, so MixedParse cannot
            // reuse their identity. Its old-fragment lookup is quadratic for a
            // wide table. Keep fragments only when they carry actual nested
            // language mounts, which can still be reused by position/parser.
            const stack = fragments.map(f => f.tree), seen = new Set();
            let mounted = false;
            while (stack.length && !mounted) {
              const tree = stack.pop();
              if (!(tree instanceof Tree) || seen.has(tree)) continue;
              seen.add(tree);
              mounted = !!tree.prop(NodeProp.mounted);
              if (!mounted) for (const child of tree.children) stack.push(child);
            }
            if (!mounted) fragments = [];
          }
          return language.parser.startParse(input, fragments, ranges);
        }
      };
      return new LanguageSupport(new Language(language.data, outer, [], language.name), support.support);
    },
    inspect(state, detailed = false) {
      const current = state.field(field, false), tree = syntaxTree(state);
      const inner = Array.isArray(detailed) ? detailed.map(pos => {
        const chain = []; for (let node = tree.resolveInner(pos, 1); node; node = node.parent) chain.push([node.name, node.from, node.to]); return chain;
      }) : undefined;
      return { ...counters, revision: current?.revision ?? null, status: current?.status ?? 'native', length: state.doc.length, treeLength: tree.length, available: syntaxTreeAvailable(state), ...(detailed === true ? { tree: tree.toString() } : {}), ...(inner ? { inner } : {}) };
    },
  };
}
