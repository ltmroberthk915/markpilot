// Commands borrow the real input owner's source selection. They never own text
// or history. Suspended capabilities last only until another document/owner acts.
import { undo, redo, undoDepth } from '@codemirror/commands';
export function applySourceHistory(target, kind) {
  if (kind === 'undo' && undoDepth(target.state)) target.dispatch(target.state.update({ selection: target.state.selection, userEvent: 'select' }));
  return (kind === 'redo' ? redo : undo)(target);
}
export function createCommandContext({ getView, epochOf, owner, flushOwner, resumeOwner, composing, cancelViewport }) {
  let serial = 0, suspended = null, running = 0;
  const chrome = node => !!node?.closest?.('.mp-toolbar,.mp-pop,.mp-table-bar,#mp-banner,.mp-menu');
  const native = node => !!node && /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName);
  function capture({ flush = true, allowSuspended = true } = {}) {
    const view = getView();
    if (!view || composing()) return null;
    let input = owner();
    if (allowSuspended && input.kind === 'none' && suspended && suspended.epoch === epochOf(view) && suspended.doc === view.state.doc) input = suspended.owner;
    running++;
    try { if (flush && input.kind === 'cell') flushOwner(input); }
    finally { running--; }
    return { owner: input, serial, epoch: epochOf(view), doc: view.state.doc, selection: view.state.selection, scrollTop: view.scrollDOM.scrollTop };
  }
  function valid(ticket, { source = true, intent = true } = {}) {
    const view = getView();
    return !!ticket && !!view && ticket.epoch === epochOf(view) && (!source || ticket.doc === view.state.doc) && (!intent || ticket.serial === serial);
  }
  function resume(ticket) {
    if (!document.hasFocus() || !valid(ticket, { source: false }) || ticket.owner.kind === 'native' || ticket.owner.kind === 'none') return false;
    if (native(document.activeElement)) return false;
    suspended = null;
    return resumeOwner(ticket.owner);
  }
  function run(action, { focus = 'owner' } = {}) {
    if (running) return action();
    const ticket = capture();
    if (!ticket) return false;
    const view = getView(), trace = view.__mpCommandTrace = [];
    const point = phase => trace.push({ phase, anchor: view.state.selection.main.anchor, head: view.state.selection.main.head, owner: ticket.owner.kind });
    point('captured');
    running++;
    let result;
    try { result = action(); }
    finally { running--; }
    point('executed');
    // Async commands (reload/dialogs) consume their own ticket after the await.
    if (focus === 'owner' && !result?.then) resume(ticket);
    point('resumed');
    return result;
  }
  function suspend() { const ticket = capture(); if (ticket && /^(cell|cm)$/.test(ticket.owner.kind)) suspended = ticket; }
  function changed(update) {
    if (!running && (update.docChanged || update.selectionSet)) suspended = null;
  }
  function invalidate() { serial++; suspended = null; const view = getView(); if (view) cancelViewport(view); }
  function geometryIntent() { serial++; const view = getView(); if (view) cancelViewport(view); }
  function install() {
    document.addEventListener('pointerdown', event => {
      if (!event.isTrusted) return;
      serial++;
      const view = getView(); if (view) cancelViewport(view);
      if (chrome(event.target)) suspend(); else suspended = null;
    }, true);
    document.addEventListener('keydown', event => {
      if (!event.isTrusted) return;
      serial++;
      const view = getView(); if (view) cancelViewport(view);
      if (event.key === 'Tab' || chrome(event.target)) suspend(); else suspended = null;
    }, true);
    document.addEventListener('beforeinput', event => { if (event.isTrusted) invalidate(); }, true);
    document.addEventListener('wheel', event => { if (event.isTrusted) geometryIntent(); }, { passive: true, capture: true });
    document.addEventListener('focusin', event => { if (native(event.target)) invalidate(); }, true);
    window.addEventListener('resize', geometryIntent);
  }
  return { capture, valid, resume, run, suspend, changed, invalidate, geometryIntent, install, serial: () => serial };
}
