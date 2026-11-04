import {ViewPlugin} from '@codemirror/view';

// Remember intent, not geometry. Wheel and pointer handlers never force a
// layout or walk the note, and the next reveal samples the current viewport.
const points = new WeakMap(), corrections = new WeakMap();
const imageRevealMeasureKey = {};
export const imageReadingPoint = ViewPlugin.fromClass(class {
  constructor(view) {
    this.stop = new AbortController();
    const opts = {capture:true, passive:true, signal:this.stop.signal};
    const remember = event => {
      if (!event.isTrusted) return;
      const previous = points.get(view);
      if (previous?.x !== event.clientX || previous?.y !== event.clientY)
        points.set(view, {x:event.clientX,y:event.clientY});
    };
    for (const type of ['pointermove','pointerdown','wheel']) view.scrollDOM.addEventListener(type, remember, opts);
    // A reveal can retarget the stationary pointer from one descendant to
    // another. Only leaving the scroller itself retires the reading point.
    view.scrollDOM.addEventListener('pointerleave', event => {
      if (event.isTrusted && event.target === view.scrollDOM &&
          !(event.relatedTarget?.nodeType && view.scrollDOM.contains(event.relatedTarget))) points.delete(view);
    }, {passive:true, signal:this.stop.signal});
    view.dom.addEventListener('keydown', event => { if (event.isTrusted) points.set(view, 'caret'); }, opts);
  }
  destroy() { this.stop.abort(); }
});

// Keep the first visible text anchor across all image reveals in this measure.
// CM updates its height map and applies its own scroll compensation after
// requestMeasure.write. Only its remaining displacement belongs to this code.
export function beforeImageReveal(view, image, intentSerial) {
  const sc = view?.scrollDOM;
  if (!sc || !image.isConnected || sc.scrollTop <= 0 || !sc.offsetHeight ||
      view.composing || view.compositionStarted || corrections.get(view)?.valid()) return null;
  const box = sc.getBoundingClientRect(), mark = image.getBoundingClientRect();
  if (mark.bottom <= box.top || mark.top >= box.bottom) return null;
  const doc = image.ownerDocument;
  let point = points.get(view);
  // Choose the focused caret only after keyboard intent; an old offscreen
  // document selection must not pull a reader away from a different page.
  let range;
  if (point === 'caret') {
    const selection = doc.getSelection();
    if (view.hasFocus && selection?.rangeCount === 1 && view.contentDOM.contains(selection.focusNode)) {
      range = doc.createRange();
      range.setStart(selection.focusNode,selection.focusOffset);range.collapse(true);
      const rect = range.getBoundingClientRect();
      if (!(rect.height && rect.top >= box.top && rect.bottom <= box.bottom)) range = null;
    }
    point = null;
  }
  if (!range) {
    if (!point || point.x < box.left || point.x >= box.right || point.y < box.top || point.y >= box.bottom)
      point = {x:box.left + box.width * .5, y:box.top + box.height * .5};
    // Leave a reader above or on the picture where they are.
    if (point.y <= mark.bottom) return null;
    const hit = doc.elementFromPoint(point.x, point.y);
    if (!hit || !view.contentDOM.contains(hit) || hit.closest('.mp-img,.mp-inline-float,.mp-row,.cm-tooltip,.cm-gutters')) return null;
    range = doc.caretRangeFromPoint?.(point.x, point.y);
    if (!range) {
      const caret = doc.caretPositionFromPoint?.(point.x, point.y);
      if (!caret) return null;
      range = doc.createRange();range.setStart(caret.offsetNode, caret.offset);range.collapse(true);
    }
  }
  const node = range?.startContainer;
  const line = (node?.nodeType === 3 ? node.parentElement : node)?.closest?.('.cm-line');
  if (!line || !view.contentDOM.contains(line) || !view.contentDOM.contains(node)) return null;
  const before = range.getBoundingClientRect();
  if (!before.height || before.top < mark.bottom || before.top < box.top || before.bottom > box.bottom) return null;
  const scale = box.height / sc.offsetHeight;
  if (!(scale > 0 && Number.isFinite(scale))) return null;
  const stateDoc = view.state.doc, selection = view.state.selection, serial = intentSerial(view);
  const pointer = points.get(view), scrollTop = sc.scrollTop;
  const ticket = { valid: () => view.dom.isConnected && view.state.doc === stateDoc &&
    view.state.selection.eq(selection) && intentSerial(view) === serial && points.get(view) === pointer &&
    !view.composing && !view.compositionStarted && node.isConnected && view.contentDOM.contains(node) };
  return () => {
    if (!ticket.valid()) return;
    corrections.set(view, ticket);
    view.requestMeasure({
      key: imageRevealMeasureKey,
      // Before CM's own compensation, a changed offset can come from inertia,
      // dragging a scrollbar or another scroll owner. Let that action win.
      read: () => ticket.valid() && Math.abs(sc.scrollTop - scrollTop) < 1,
      write: eligible => queueMicrotask(() => {
        if (corrections.get(view) !== ticket) return;
        corrections.delete(view);
        if (!eligible || !ticket.valid()) return;
        const after = range.getBoundingClientRect();
        const dy = (after.top - before.top) / scale;
        if (after.height && Math.abs(dy) > .5) sc.scrollTop += dy;
      }),
    });
  };
}
