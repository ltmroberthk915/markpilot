// DSH shell: preserve rendered tables when focus moves to the host.
// Public engine APIs own cell commits, reading mode and command restoration.
(function () {
  'use strict';
  var SLOT = '__dshInteraction';
  var previous = window[SLOT];
  if (previous && previous.owner === 'dsh-interaction' && previous.dispose) previous.dispose();
  else if (previous) return;

  var lease = null, dead = false, parentDocument = null, readingObserver = null;
  var stats = { acquired: 0, released: 0, refused: 0, foreign: 0, stale: 0, last: 'idle' };
  var removers = [];
  function listen(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    removers.push(function () { target.removeEventListener(type, fn, options); });
  }
  function current() {
    try {
      var engine = window.mpEngine;
      if (!engine || typeof engine._view !== 'function' || typeof engine.documentSession !== 'function'
          || typeof engine.setReadingMode !== 'function') return null;
      var view = engine._view(), session = engine.documentSession();
      return view && view.state && view.dom && view.dom.isConnected && session
        ? { engine: engine, view: view, epoch: session.epoch } : null;
    } catch (error) { return null; }
  }
  function composing(context) {
    try { return !!(context.view.composing || context.view.compositionStarted
      || (context.engine.isComposing && context.engine.isComposing())); }
    catch (error) { return true; }
  }
  function readingIntent() {
    try {
      var stored = window.localStorage.getItem('mp-reading');
      var attribute = document.documentElement.getAttribute('data-mp-reading');
      return { signature: JSON.stringify([stored, attribute]), reading: stored === '1' || attribute === '1' };
    } catch (error) { return null; }
  }
  function sameOwner(context, held) {
    return context && context.engine === held.engine && context.view === held.view && context.epoch === held.epoch;
  }
  function drop(reason, counter) {
    lease = null;
    if (counter) stats[counter]++;
    stats.last = reason;
  }
  function release(reason) {
    if (!lease) return true;
    var held = lease, context = current(), intent = readingIntent();
    if (!sameOwner(context, held)) { drop('stale:' + reason, 'stale'); return false; }
    if (!context.view.state.readOnly) { drop('already-writable:' + reason); return true; }
    // A visible/persisted reading-mode change is another owner's intent.
    // Do not turn their real reading mode off, even if the value equals ours.
    if (!intent || intent.reading || intent.signature !== held.intent) {
      drop('foreign-reading:' + reason, 'foreign'); return false;
    }
    if (composing(context)) { stats.last = 'composition:' + reason; return false; }
    try {
      if (context.engine.setReadingMode(false) !== true || context.view.state.readOnly) {
        stats.last = 'release-refused:' + reason; return false;
      }
      if (lease === held) drop('released:' + reason, 'released');
      return true;
    } catch (error) { stats.last = 'release-error:' + reason; return false; }
  }
  function acquire(event) {
    if (dead || lease || !event || !event.isTrusted || event.button !== 0 || event.isPrimary === false
        || event.defaultPrevented || !document.hasFocus()
        || !window.frameElement || !window.frameElement.isConnected) return;
    var context = current(), intent = readingIntent();
    if (!context || !intent || intent.reading || context.view.state.readOnly || composing(context)) return;
    var editor = document.activeElement, cell;
    try { cell = context.engine.__cellLayout && context.engine.__cellLayout(); } catch (error) { return; }
    if (!editor || !editor.matches || !editor.matches('.mp-cell-overlay-text') || !editor.isConnected
        || editor.ownerDocument !== document || !cell || !cell.active || !cell.owner
        || cell.active.rowFrom !== cell.owner.rowFrom || cell.active.col !== cell.owner.col
        || cell.owner.epoch !== context.epoch || !context.engine.commands
        || typeof context.engine.commands.capture !== 'function'
        || typeof context.engine.commands.suspend !== 'function') return;
    var ticket;
    try { ticket = context.engine.commands.capture(); } catch (error) { stats.refused++; return; }
    var after = current();
    if (!ticket || !ticket.owner || ticket.owner.kind !== 'cell' || !sameOwner(after, context)
        || after.view.state.readOnly || composing(after) || document.activeElement !== editor
        || !document.hasFocus() || ticket.doc !== after.view.state.doc) {
      stats.refused++; stats.last = 'capture-refused'; return;
    }
    // Keep the normal command owner before reading mode closes cell editing.
    // Native toolbar commands can then restore their owner when invoked.
    try { after.engine.commands.suspend(); } catch (error) { stats.refused++; return; }
    if (!sameOwner(current(), after) || after.view.state.readOnly || composing(after)
        || document.activeElement !== editor || !document.hasFocus()) { stats.refused++; return; }
    var finalCell, finalIntent = readingIntent();
    try { finalCell = after.engine.__cellLayout(); } catch (error) { stats.refused++; return; }
    if (!finalCell || !finalCell.active || !finalCell.owner || finalCell.owner.epoch !== after.epoch
        || finalCell.active.rowFrom !== cell.active.rowFrom || finalCell.active.col !== cell.active.col
        || finalCell.owner.rowFrom !== finalCell.active.rowFrom || finalCell.owner.col !== finalCell.active.col
        || !finalIntent || finalIntent.reading || finalIntent.signature !== intent.signature) {
      stats.refused++; stats.last = 'cell-changed-during-capture'; return;
    }
    // Capture has flushed the cell. Do not retain the entire document/ticket
    // while the user works in chat; the core keeps the normal selection state.
    var held = { engine: after.engine, view: after.view, epoch: after.epoch, intent: intent.signature };
    try {
      if (after.engine.setReadingMode(true) !== true || !after.view.state.readOnly) {
        stats.refused++; stats.last = 'preview-refused'; return;
      }
      lease = held; stats.acquired++; stats.last = 'acquired';
    } catch (error) { stats.refused++; stats.last = 'preview-error'; }
  }
  function onMouseDown(event) {
    if (!dead && event.isTrusted) release('child-mousedown');
  }
  function onControlPointerDown(event) {
    if (dead || !lease || !event.isTrusted) return;
    var target = event.target;
    if (!target || !target.closest || target.closest('.mp-row th,.mp-row td')) return;
    // Native tablebar buttons run on pointerdown and may suppress mousedown.
    // Restore before those explicit controls; keep body cell hits unchanged.
    if (target.closest('.mp-toolbar,.mp-table-bar,.mp-tools,.mp-pop,.mp-menu,.mp-dialog,.mp-dlg,.cm-search,.cm-panel,#mp-banner,button,input,textarea,select,[role="button"]')) {
      release('child-control-pointerdown');
    }
  }
  function onKeyDown(event) {
    if (!dead && lease && event.isTrusted && !event.isComposing && event.keyCode !== 229 && document.hasFocus()) {
      release('child-keydown');
    }
  }
  function onKeyUp(event) {
    // Tab may start in the parent, with only keyup delivered inside this frame.
    if (!dead && lease && event.isTrusted && event.key === 'Tab' && document.hasFocus()) release('child-tab-return');
  }
  function beforeDocumentChange() { return release('before-document-change'); }
  function beforeCommand(kind) {
    return /^(write|template|wrap|symbol|number)$/.test(String(kind || '')) ? release('before-command:' + kind) : true;
  }
  function onReadingIntent() {
    if (!lease) return;
    var intent = readingIntent();
    if (!intent || intent.reading || intent.signature !== lease.intent) drop('reading-intent-changed', 'foreign');
  }
  function dispose() {
    if (dead) return;
    release('dispose');
    dead = true; lease = null;
    while (removers.length) { try { removers.pop()(); } catch (error) {} }
    if (readingObserver) readingObserver.disconnect();
    readingObserver = null; parentDocument = null;
    if (window[SLOT] === api) delete window[SLOT];
  }
  var api = {
    owner: 'dsh-interaction', version: '1.0.0',
    beforeDocumentChange: beforeDocumentChange, beforeCommand: beforeCommand,
    release: function () { return release('explicit'); }, dispose: dispose,
    snapshot: function () { return { active: !!lease, stats: Object.assign({}, stats) }; }
  };
  window[SLOT] = api;
  try {
    if (window.parent === window || !window.frameElement || !window.frameElement.isConnected) { dispose(); return; }
    parentDocument = window.parent.document;
    listen(parentDocument, 'pointerdown', acquire, true);
    listen(document, 'pointerdown', onControlPointerDown, true);
    listen(document, 'mousedown', onMouseDown, true);
    listen(document, 'keydown', onKeyDown, true);
    listen(document, 'keyup', onKeyUp, true);
    listen(window, 'storage', function (event) { if (event.key === 'mp-reading') onReadingIntent(); }, false);
    listen(window, 'pagehide', dispose, { once: true });
    if (typeof MutationObserver === 'function') {
      readingObserver = new MutationObserver(onReadingIntent);
      readingObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mp-reading'] });
    }
  } catch (error) { dispose(); }
})();
