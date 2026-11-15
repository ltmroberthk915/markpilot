/*
 * Viewport reading anchor for the MarkPilot CM6 engine.
 *
 * The anchor is deliberately source based:
 *   { line: 1-based source line, ch: 0-based offset in that line,
 *     fraction: 0..1 of the line's visual box crossed by the viewport top }
 *
 * No document text and no "scroll percentage" is stored.  Restoring an anchor
 * only scrolls; it never dispatches a selection, focus change or doc change.
 * Capture is armed by the host only after the document is ready; a real wheel,
 * pointer or navigation-key intent is required before a position is emitted,
 * so opening a document at scrollTop 0 cannot overwrite the saved position.
 *
 * The module is deliberately free of CodeMirror imports: the engine passes the
 * scrollIntoView effect, which keeps the anchor math testable with a fake view.
 */

export function normalizeReadingAnchor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const line = value.line;
  const ch = value.ch;
  const fraction = value.fraction;
  if (typeof line !== 'number' || typeof ch !== 'number' || typeof fraction !== 'number') return null;
  if (!Number.isSafeInteger(line) || line < 1 || line > 100000000) return null;
  if (!Number.isSafeInteger(ch) || ch < 0 || ch > 10000000) return null;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
  return { line, ch, fraction: Math.round(fraction * 1e6) / 1e6 };
}

/** Clamp a stored anchor to the current document.  A shortened document falls back to its last line. */
export function clampReadingAnchor(value, doc) {
  const anchor = normalizeReadingAnchor(value);
  if (!anchor || !doc || !Number.isSafeInteger(doc.lines) || doc.lines < 1) return null;
  const lineNumber = Math.min(anchor.line, doc.lines);
  const line = doc.line(lineNumber);
  const ch = Math.min(anchor.ch, line.length);
  return { line: lineNumber, ch, fraction: anchor.fraction, from: line.from, lineLength: line.length };
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function lineElement(view, from) {
  try {
    const at = view.domAtPos(from);
    const node = at.node.nodeType === 1 ? at.node : at.node.parentElement;
    const element = node && node.closest ? node.closest('.cm-line') : null;
    if (!element || !view.contentDOM.contains(element)) return null;
    return element;
  } catch { return null; }
}

function lineScreenBox(view, from) {
  const element = lineElement(view, from);
  if (element) {
    try {
      const rect = element.getBoundingClientRect();
      if (rect.height > 0 && rect.width > 0) return { top: rect.top, height: rect.height, source: 'line' };
    } catch { /* fall through */ }
  }
  // Block widgets (tables/mermaid) may not expose a .cm-line box.  The height
  // map is still authoritative; documentTop converts it to viewport coordinates.
  try {
    const block = view.lineBlockAt(from);
    if (block && Number.isFinite(block.top) && Number.isFinite(block.height) && block.height > 0 && Number.isFinite(view.documentTop))
      return { top: view.documentTop + block.top, height: block.height, source: 'block' };
  } catch { /* no geometry */ }
  return null;
}

/**
 * Read the anchor at the viewport's upper edge.  Returns null while the editor
 * has no measurable content (boot, hidden iframe, composition transition).
 */
export function captureReadingAnchor(view) {
  if (!view || !view.scrollDOM || !view.state || !view.state.doc) return null;
  const scroller = view.scrollDOM;
  try {
    const viewport = scroller.getBoundingClientRect();
    if (!(viewport.height > 0) || !(scroller.clientHeight > 0)) return null;
    const scale = viewport.height / scroller.offsetHeight;
    if (!Number.isFinite(scale) || scale <= 0) return null;
    const content = view.contentDOM.getBoundingClientRect();
    const x = content.left + Math.min(4, Math.max(0, content.width / 2));
    // At scrollTop 0 the scroller's top padding is outside the content; sampling
    // contentTop+1 keeps the first line measurable.  Once scrolled, the content
    // starts above the viewport and the normal top edge is used.
    const y = Math.max(viewport.top + 1, content.top + 1);
    const pos = view.posAtCoords({ x, y }) ?? view.posAtCoords({ x, y: viewport.top + Math.min(8, scroller.clientHeight / 2) });
    if (pos == null) return null;
    const doc = view.state.doc;
    const line = doc.lineAt(clamp(pos, 0, doc.length));
    const box = lineScreenBox(view, line.from);
    let fraction = 0;
    if (box) {
      fraction = clamp((y - box.top) / box.height, 0, 1);
      if (line.number === 1 && scroller.scrollTop <= 1) fraction = 0;
    }
    return { line: line.number, ch: clamp(pos - line.from, 0, line.length), fraction: Math.round(fraction * 1e6) / 1e6 };
  } catch { return null; }
}

const sameAnchor = (a, b) => !!a && !!b && a.line === b.line && a.ch === b.ch && Math.abs(a.fraction - b.fraction) < 1e-6;

/**
 * Engine-side controller.  It owns no persistence: hosts subscribe and persist
 * the emitted anchors through the shared store.
 */
export function createReadingPositionController({
  getView,
  epochOf = () => 0,
  scrollIntoView = null,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancelSchedule = handle => clearTimeout(handle),
  requestFrame = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16)),
} = {}) {
  const subscribers = new Set();
  let view = null;
  let ready = false;
  let baselineTop = 0;
  let intentSerial = 0;
  let applying = 0;
  let publishTimer = null;
  let lastPublished = null;
  let lastPublishedAt = 0;
  let notifySeq = 0;
  let lastResult = null;
  let lastUserAt = 0;

  const PUBLISH_IDLE_MS = 320;
  const PUBLISH_MIN_GAP_MS = 900;

  function currentView() {
    try { return getView ? getView() : null; } catch { return null; }
  }

  function emit(anchor, reason) {
    if (!anchor) return;
    if (lastPublished && sameAnchor(anchor, lastPublished)) return;
    lastPublished = { ...anchor };
    lastPublishedAt = now();
    const payload = { anchor: { ...anchor }, reason, seq: ++notifySeq, at: lastPublishedAt };
    lastUserAt = lastPublishedAt;
    for (const subscriber of [...subscribers]) {
      try { subscriber(payload); } catch { /* a host subscriber must never break the editor */ }
    }
  }

  function publish(reason) {
    if (!ready || applying) return;
    const active = currentView();
    if (!active) return;
    const anchor = captureReadingAnchor(active);
    if (anchor) emit(anchor, reason);
  }

  function schedulePublish() {
    if (!ready || applying || publishTimer !== null) return;
    const elapsed = now() - lastPublishedAt;
    const wait = Math.max(PUBLISH_IDLE_MS, PUBLISH_MIN_GAP_MS - elapsed);
    publishTimer = schedule(() => {
      publishTimer = null;
      publish('scroll');
    }, wait);
    if (publishTimer && typeof publishTimer.unref === 'function') publishTimer.unref();
  }

  function onScroll() {
    if (!ready || applying) return;
    const active = currentView();
    if (!active) return;
    try {
      if (intentSerial === 0 && Math.abs(active.scrollDOM.scrollTop - baselineTop) < 1) return;
    } catch { return; }
    schedulePublish();
  }

  function onIntent() {
    if (!ready) return;
    // A wheel/pointer/navigation key during a pending restore must cancel it.
    intentSerial += 1;
    if (applying) return;
    schedulePublish();
  }

  function onKeydown(event) {
    if (!event || event.isComposing) return;
    if (event.altKey || event.metaKey) return;
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) onIntent();
  }

  function detachView() {
    if (!view) return;
    try {
      view.scrollDOM.removeEventListener('scroll', onScroll);
      view.scrollDOM.removeEventListener('wheel', onIntent);
      view.scrollDOM.removeEventListener('pointerdown', onIntent, true);
      view.dom.removeEventListener('keydown', onKeydown, true);
    } catch { /* view already destroyed */ }
    view = null;
  }

  function attach(nextView) {
    if (view === nextView) return;
    detachView();
    view = nextView;
    if (!view) return;
    try {
      view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
      view.scrollDOM.addEventListener('wheel', onIntent, { passive: true });
      view.scrollDOM.addEventListener('pointerdown', onIntent, { passive: true, capture: true });
      view.dom.addEventListener('keydown', onKeydown, true);
    } catch { /* a missing scrollDOM is not fatal */ }
  }

  /** Called after the host has applied the document and (optionally) restored its anchor. */
  function arm() {
    const active = currentView();
    ready = !!active;
    intentSerial = 0;
    lastPublishedAt = 0;
    lastPublished = active ? captureReadingAnchor(active) : null;
    try { baselineTop = active ? active.scrollDOM.scrollTop : 0; } catch { baselineTop = 0; }
    return ready;
  }

  function reset() {
    ready = false;
    intentSerial = 0;
    applying = 0;
    lastPublished = null;
    lastPublishedAt = 0;
    lastUserAt = 0;
    baselineTop = 0;
    lastResult = null;
    if (publishTimer !== null) { cancelSchedule(publishTimer); publishTimer = null; }
  }

  /**
   * Restore one anchor.  The returned promise settles once the scroll has been
   * applied (or rejected) and never changes the selection or document text.
   */
  function apply(value) {
    const active = currentView();
    if (!active) return Promise.resolve({ ok: false, reason: 'not-ready' });
    if (applying) return Promise.resolve({ ok: false, reason: 'busy' });
    // A real user scroll before the swap response arrived owns the viewport.
    if (intentSerial > 0) return Promise.resolve({ ok: false, reason: 'user-active' });
    const anchor = clampReadingAnchor(value, active.state.doc);
    if (!anchor) return Promise.resolve({ ok: false, reason: 'invalid-anchor' });
    const target = { view: active, doc: active.state.doc, epoch: epochOf(active), intent: intentSerial };
    const pos = anchor.from + anchor.ch;
    applying += 1;
    let done = false;
    let finish;
    const promise = new Promise(resolve => { finish = resolve; });

    const settle = (ok, reason) => {
      if (done) return;
      done = true;
      applying = Math.max(0, applying - 1);
      if (active === currentView()) {
        try { baselineTop = active.scrollDOM.scrollTop; } catch { /* ignore */ }
        lastPublished = captureReadingAnchor(active);
        lastPublishedAt = 0;
      }
      lastResult = { ok, reason: reason || null, anchor: { ...anchor } };
      finish(lastResult);
    };

    const valid = () => {
      const current = currentView();
      return !!current && current === target.view && current.state.doc === target.doc &&
        (!epochOf || epochOf(current) === target.epoch) && target.intent === intentSerial && applying > 0;
    };

    // Source-position estimate from CM's height map; no scrollIntoView effect,
    // no selection/focus change.  The measure loop below only corrects geometry.
    try {
      const sc = active.scrollDOM;
      const rect = sc.getBoundingClientRect();
      const scale = rect.height / sc.offsetHeight;
      const block = active.lineBlockAt(pos);
      if (Number.isFinite(scale) && scale > 0 && block && Number.isFinite(block.top) && Number.isFinite(active.documentTop)) {
        const screenTop = active.documentTop + block.top;
        const targetY = rect.top + 1;
        const desired = screenTop + anchor.fraction * block.height;
        const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
        sc.scrollTop = anchor.line === 1 && anchor.ch === 0 && anchor.fraction === 0
          ? 0 : clamp(sc.scrollTop + (desired - targetY) / scale, 0, max);
      }
    } catch { /* the measure loop can still recover */ }

    let remaining = 5;
    const attempt = () => {
      if (!valid()) { settle(false, 'stale'); return; }
      const current = target.view;
      const doc = current.state.doc;
      // The document may have changed while a page was closed; re-clamp.
      if (doc !== target.doc) { settle(false, 'stale'); return; }
      current.requestMeasure({
        key: {},
        read(v) {
          if (!valid()) return null;
          const sc = v.scrollDOM;
          const rect = sc.getBoundingClientRect();
          const scale = rect.height / sc.offsetHeight;
          if (!(Number.isFinite(scale) && scale > 0)) return null;
          const box = lineScreenBox(v, anchor.from);
          if (!box) return { retry: true };
          const viewportTop = rect.top + 1;
          const desired = box.top + anchor.fraction * box.height;
          const delta = (desired - viewportTop) / scale;
          const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
          let top = clamp(sc.scrollTop + delta, 0, max);
          // An exact document start is the one anchor whose meaningful scroll
          // position is 0, not the height of the scroller's top padding.
          if (anchor.line === 1 && anchor.ch === 0 && anchor.fraction === 0) top = 0;
          if (Math.abs(top - sc.scrollTop) < 0.5) return { done: true };
          return { top };
        },
        write(value) {
          if (!valid()) { settle(false, 'stale'); return; }
          if (!value) { settle(false, 'no-geometry'); return; }
          if (value.retry) {
            if (remaining-- <= 0) settle(false, 'no-geometry');
            else requestFrame(attempt);
            return;
          }
          if (value.done) { settle(true, null); return; }
          try {
            target.view.scrollDOM.scrollTop = value.top;
          } catch {
            settle(false, 'scroll-failed');
            return;
          }
          if (remaining-- <= 0) { settle(true, null); return; }
          requestFrame(attempt);
        },
      });
    };
    requestFrame(attempt);
    return promise;
  }

  /** Final anchor for a normal close/flush; null when the user never actually moved the viewport. */
  function flush(reason = 'flush') {
    if (!ready || applying || intentSerial === 0) return null;
    const active = currentView();
    if (!active) return null;
    const anchor = captureReadingAnchor(active);
    if (!anchor) return null;
    lastPublished = { ...anchor };
    lastPublishedAt = now();
    return { anchor, reason, seq: ++notifySeq, at: lastUserAt || lastPublishedAt };
  }

  function subscribe(subscriber) {
    if (typeof subscriber !== 'function') return () => {};
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  }

  return {
    attach,
    arm,
    reset,
    apply,
    flush,
    subscribe,
    capture: () => captureReadingAnchor(currentView()),
    inspect: () => ({
      attached: !!view,
      ready,
      baselineTop,
      intentSerial,
      applying,
      lastPublished: lastPublished ? { ...lastPublished } : null,
      lastResult: lastResult ? { ...lastResult } : null,
      subscribers: subscribers.size,
    }),
    _onIntent: onIntent,
    _onScroll: onScroll,
  };
}
