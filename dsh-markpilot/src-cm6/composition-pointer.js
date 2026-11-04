import {Transaction} from '@codemirror/state';
import {ViewPlugin} from '@codemirror/view';

// A native composition still owns its preedit text after a pointer moves
// the editor selection elsewhere. Keep the latter only for this composition.
export class CompositionPointer {
  start(epoch, selection) {
    this.epoch = epoch;
    this.from = selection.main.from;
    this.to = selection.main.to;
    this.ended = false;
    this.nativeWrite = false;
    this.pointer = null;
  }
  reset() { this.epoch = null; this.pointer = null; }
  press(selection) {
    this.nativeWrite = false;
    this.pointer = this.epoch != null && !this.ended
      ? {start:selection, target:null, released:false, writing:false} : null;
  }
  inside(selection) {
    const r = selection.main;
    return selection.ranges.length === 1 && r.empty && r.head >= this.from && r.head <= this.to;
  }
  writing() {
    this.nativeWrite = true;
    if (this.pointer?.target || this.pointer?.released) this.pointer.writing = true;
  }
  release(selection) {
    const p = this.pointer;
    if (!p) return;
    if (!p.writing || !p.target || !this.inside(selection)) p.target = selection;
    if (p.target.eq(p.start)) { this.pointer = null; return; }
    p.released = true;
  }
  update(tr, epoch) {
    if (this.epoch == null) return;
    if (epoch !== this.epoch || tr.state.readOnly ||
        tr.isUserEvent('undo') || tr.isUserEvent('redo')) { this.reset(); return; }
    const p = this.pointer;
    if (tr.docChanged) {
      let inPreedit = true;
      tr.changes.iterChangedRanges((from, to) => { if (from < this.from || to > this.to) inPreedit = false; });
      if (!inPreedit || !(tr.isUserEvent('input.type.compose') || this.nativeWrite && tr.isUserEvent('input.type'))) {
        this.reset(); return;
      }
      this.nativeWrite = false;
      this.from = tr.changes.mapPos(this.from, -1);
      this.to = tr.changes.mapPos(this.to, 1);
      if (p) {
        p.start = p.start.map(tr.changes);
        if (p.target) p.target = p.target.map(tr.changes);
      }
    }
    if (!p || !tr.selection) return;
    if (!p.released && tr.isUserEvent('select.pointer') && (!p.writing || p.moving || !this.inside(tr.newSelection))) p.target = tr.newSelection;
    else if (p.released && !tr.newSelection.eq(p.target) && !(p.writing && this.inside(tr.newSelection))) this.pointer = null;
  }
  take(epoch, selection) {
    const p = this.pointer;
    if (epoch !== this.epoch) { this.reset(); return null; }
    if (!this.ended || !p?.released) return null;
    const target = p.writing && p.target && !p.target.eq(selection) && this.inside(selection) ? p.target : null;
    this.reset();
    return target;
  }
}

export function compositionPointerSelection(epochOf) {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.track = new CompositionPointer();
      this.track.reset();
      this.stop = new AbortController();
      const doc = view.dom.ownerDocument, win = doc.defaultView, opts = {capture:true, signal:this.stop.signal};
      const source = e => view.contentDOM.contains(e.target) && !e.target.closest?.('.mp-cell-overlay-text');
      const on = (owner, name, fn, options = opts) => owner.addEventListener(name, e => { if (e.isTrusted) fn(e); }, options);
      on(doc, 'compositionstart', e => {
        this.track.reset();
        if (source(e) && view.hasFocus && !view.state.readOnly) this.track.start(epochOf(view.state), view.state.selection);
      });
      on(doc, 'mousedown', e => {
        this.track.pointer = null;
        if (e.button === 0 && source(e) && view.hasFocus) this.track.press(view.state.selection);
      });
      on(doc, 'pointerdown', () => { this.track.pointer = null; });
      on(doc, 'mousemove', e => {
        const p = this.track.pointer;
        if (!p || p.up || !(e.buttons & 1)) return;
        p.moving = true;
        queueMicrotask(() => { p.moving = false; });
      });
      on(doc, 'mouseup', e => {
        const p = this.track.pointer;
        if (e.button !== 0 || !p) return;
        p.up = true;
        // CM may finish a gesture on its own document mouseup listener.
        // Read the final directed selection after all those listeners ran.
        queueMicrotask(() => {
          if (this.track.pointer !== p) return;
          this.track.release(view.state.selection);
          if (this.track.ended) this.flush();
        });
      }, {capture:false, signal:this.stop.signal});
      on(doc, 'compositionupdate', e => { if (source(e)) this.track.writing(); });
      on(doc, 'beforeinput', e => {
        if (!source(e)) return;
        if (e.inputType === 'insertCompositionText' || e.isComposing) this.track.writing();
        else { this.flush(); this.track.pointer = null; }
      });
      doc.addEventListener('compositionend', e => {
        const p = this.track.pointer;
        if (!source(e) || this.track.epoch !== epochOf(view.state)) return;
        // EditContext may emit a non-trusted end after the trusted start,
        // click and final native composition write. This is a wake-up only.
        if (!e.isTrusted && !(p?.target && p.writing)) return;
        this.track.ended = true;
        if (e.isTrusted) this.track.writing();
        if (!p) { this.track.reset(); return; }
        // CM flushes pending native mutations after compositionend. A new
        // ordinary key/beforeinput can consume the same one-shot result first.
        clearTimeout(this.finishTimer);
        this.finishTimer = setTimeout(() => { if (this.track.pointer === p) this.flush(); }, 0);
      }, opts);
      on(doc, 'keydown', e => {
        if (!e.isComposing && e.keyCode !== 229) { this.flush(); this.track.pointer = null; }
      });
      for (const type of ['focusout','pointercancel','dragstart','contextmenu','drop'])
        on(doc, type, () => { this.track.pointer = null; });
      for (const type of ['copy','cut','paste']) on(doc, type, () => {
        this.flush();
        if (type !== 'copy') this.track.pointer = null;
      });
      on(win, 'blur', () => this.track.reset());
    }
    update(u) { for (const tr of u.transactions) this.track.update(tr, epochOf(tr.state)); }
    flush() {
      const v = this.view;
      if (!this.track.ended || v.composing || v.compositionStarted) return;
      if (!v.hasFocus || !v.dom.ownerDocument.hasFocus() || !v.dom.isConnected || v.state.readOnly || this.track.epoch !== epochOf(v.state)) { this.track.reset(); return; }
      if (this.track.pointer?.up && !this.track.pointer.released) this.track.release(v.state.selection);
      const target = this.track.take(epochOf(v.state), v.state.selection);
      if (target) v.dispatch({selection:target, userEvent:'select.pointer.composition', annotations:Transaction.addToHistory.of(false)});
    }
    destroy() { clearTimeout(this.finishTimer); this.stop.abort(); this.track.reset(); }
  });
}

