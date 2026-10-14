import { ViewPlugin } from '@codemirror/view';

export function scrollViewportBounds(sc, zoom) {
  const rect = sc.getBoundingClientRect();
  return {
    top: Math.max(0, rect.top + sc.clientTop * zoom),
    bottom: Math.min(innerHeight, rect.top + (sc.clientTop + sc.clientHeight) * zoom),
  };
}

export function createViewportIntent(indexField, zoomOf) {
  const records = new WeakMap(), measureKey = {};
  const record = view => { let r = records.get(view); if (!r) records.set(view, r = { serial: 0, anchor: null }); return r; };
  function cancel(view) { const r = record(view); r.serial++; r.anchor = null; }
  function anchorImage(view, id, top) {
    const r = record(view), index = view.state.field(indexField);
    const intent = r.anchor = { serial: ++r.serial, epoch: index.epoch, id, top };
    view.requestMeasure({ key: measureKey,
      read(v) {
        if (r.anchor !== intent || v.state.field(indexField).epoch !== intent.epoch) return null;
        const wrapper = [...v.dom.querySelectorAll('.mp-img[data-mp-region]')].find(n => n.dataset.mpRegion === id);
        const image = wrapper?.querySelector('img:not(.mp-img-pending)') || wrapper;
        if (!image) return null;
        const sc = v.scrollDOM, box = image.getBoundingClientRect();
        const caret = v.coordsAtPos(v.state.selection.main.head), z = zoomOf(sc);
        let delta = box.top - intent.top;
        // At viewport edges the caret must remain reachable. Apply only the
        // minimum additional movement; the image anchor has priority otherwise.
        if (caret) {
          const bounds = scrollViewportBounds(sc, z), top = bounds.top + 4, bottom = bounds.bottom - 4;
          if (bottom > top) {
            if (caret.top - delta < top) delta = caret.top - top;
            else if (caret.bottom - delta > bottom) delta = caret.bottom - bottom;
          }
        }
        return { delta: delta / z, scrollTop: sc.scrollTop, max: Math.max(0, sc.scrollHeight - sc.clientHeight) };
      },
      write(value, v) {
        if (r.anchor !== intent || !value) return;
        r.anchor = null;
        v.scrollDOM.scrollTop = Math.max(0, Math.min(value.max, value.scrollTop + value.delta));
      },
    });
  }
  function preserveScroll(view, scrollTop) {
    const r = record(view), serial = ++r.serial, epoch = view.state.field(indexField).epoch;
    r.anchor = null;
    view.requestMeasure({ key: measureKey,
      read: v => v.state.field(indexField).epoch === epoch ? Math.max(0, v.scrollDOM.scrollHeight - v.scrollDOM.clientHeight) : null,
      write(max, v) { if (max !== null && r.serial === serial) v.scrollDOM.scrollTop = Math.min(scrollTop, max); },
    });
  }
  const extension = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.cancel = event => { if (event.isTrusted) cancel(view); };
      view.scrollDOM.addEventListener('wheel', this.cancel, { passive: true, capture: true });
      view.dom.addEventListener('keydown', this.cancel, true);
      view.dom.addEventListener('pointerdown', this.cancel, true);
      view.dom.addEventListener('beforeinput', this.cancel, true);
    }
    update(u) {
      if (u.startState.field(indexField).epoch !== u.state.field(indexField).epoch) cancel(u.view);
      if (u.docChanged) cancel(u.view);
    }
    destroy() {
      const v = this.view;
      v.scrollDOM.removeEventListener('wheel', this.cancel, true);
      for (const t of ['keydown', 'pointerdown', 'beforeinput']) v.dom.removeEventListener(t, this.cancel, true);
      records.delete(v);
    }
  });
  return { extension, cancel, anchorImage, preserveScroll, serial: view => record(view).serial };
}
