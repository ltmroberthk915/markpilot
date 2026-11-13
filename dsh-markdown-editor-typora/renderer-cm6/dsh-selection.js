// dsh-selection.js — 选中浮条：只读引用 + 显式「修改此处」。
//
// MP208-UI 变更（在私有 ui 副本内）：
//   · 普通插入不再直接把路径+全文塞进 composer，而是走 DSH 官方
//     inputActions.insertQuote(text, summary)：只读引用节点、保留草稿、用户手动发送；
//   · 浮条新增「修改此处」：只发一个同次引擎快照（ranges/text/docLength/行号），
//     父窗口负责绑定路径/会话/版本并创建受限目标；它不写文档、不发消息；
//   · 快照只从 CM6 EditorState 读；DOM 只用于定位；不轮询、不缓存文档。
//
// 上行：
//   { __dshmd:true, dir:'up', type:'insert-quote'|'edit-target',
//     content:{ text, ranges:[{from,to,text}], docLength, lineStart, lineEnd,
//               lines, capturedAt, nonce, source:'cm6' } }
(function () {
  'use strict';
  if (window.__dshSelectionInstalled) return;
  window.__dshSelectionInstalled = true;

  var BTN_ID = 'dsh-md-insert';
  var EDIT_ID = 'dsh-md-edit';
  var BTN_LABEL = '引用';
  var EDIT_LABEL = '修改此处';
  var BTN_DONE = '已引用';
  var EDIT_DONE = '已创建';
  var DONE_RESET_MS = 1400;
  var MAX_INSERT_CHARS = 262144;

  var btn = null;
  var editBtn = null;
  var labelEl = null;
  var editLabelEl = null;
  var rafId = 0;
  var resetTimer = null;
  var lastTransform = null;
  var hasSelection = false;

  function intersectsViewport(rect) {
    return !!rect && rect.bottom > 0 && rect.top < window.innerHeight
      && rect.right > 0 && rect.left < window.innerWidth;
  }

  function coordsVisible(view, pos) {
    try { return view.coordsAtPos(pos, 1) || view.coordsAtPos(pos, -1) || null; }
    catch (error) { return null; }
  }

  /**
   * Anchor for a selection that may be much taller than the viewport.
   * 1) Prefer a visible end/start (last.to, last.from, first.to, first.from).
   * 2) If both ends are off-screen but the selection covers the viewport,
   *    anchor near a visible position inside the selection. This gives a stable
   *    entry for Ctrl+A / long single-line selections.
   * 3) If the viewport is completely outside the selection, return null.
   * Positions only: no text slicing, no full-document read.
   */
  function anchorRect(view, ranges) {
    if (!ranges || !ranges.length) return null;
    var last = ranges[ranges.length - 1];
    var first = ranges[0];
    var probes = [last.to, last.from, first.to, first.from];
    for (var i = 0; i < probes.length; i += 1) {
      var rect = coordsVisible(view, probes[i]);
      if (intersectsViewport(rect)) return rect;
    }
    // Both endpoints are off-screen. Only show a stable entry when the visible
    // viewport actually lies inside the selection; otherwise the user has
    // scrolled away and the bar must stay hidden.
    try {
      var scroller = view.scrollDOM;
      if (!scroller || typeof view.posAtCoords !== 'function') return null;
      var box = scroller.getBoundingClientRect();
      if (!box || box.height <= 0 || box.width <= 0) return null;
      var xs = [box.left + 24, box.right - 24];
      var ys = [box.top + Math.min(48, box.height / 2), box.top + box.height / 2, box.bottom - 24];
      for (var xi = 0; xi < xs.length; xi += 1) {
        for (var yi = 0; yi < ys.length; yi += 1) {
          var pos = view.posAtCoords({ x: xs[xi], y: ys[yi] });
          if (!Number.isSafeInteger(pos)) continue;
          var inside = false;
          for (var r = 0; r < ranges.length; r += 1) {
            if (pos >= ranges[r].from && pos <= ranges[r].to) { inside = true; break; }
          }
          if (!inside) continue;
          var at = coordsVisible(view, pos);
          if (intersectsViewport(at)) return at;
          return {
            top: ys[yi] - 10, bottom: ys[yi] + 10,
            left: xs[xi] - 8, right: xs[xi] + 8,
            width: 16, height: 20,
          };
        }
      }
    } catch (error) { /* fall through */ }
    return null;
  }

  var stats = window.__dshSelStats = {
    selectionchange: 0, rafScheduled: 0, rafRuns: 0,
    shown: 0, hidden: 0,
    quotes: 0, edits: 0, mouse: 0, keyboard: 0,
    oversize: 0, viewMissing: 0, emits: 0,
    positionReads: 0, textReads: 0,
    digestRequests: 0, digestRuns: 0, digestFailures: 0, digestMs: 0,
    lastTextLength: 0, lastRangeCount: 0, lastLineStart: 0, lastLineEnd: 0,
  };

  function core() { return window.__MP208 || null; }

  function getView() {
    try {
      var engine = window.mpEngine;
      if (!engine || typeof engine._view !== 'function') { stats.viewMissing += 1; return null; }
      var view = engine._view();
      return view && view.state ? view : null;
    } catch (error) {
      stats.viewMissing += 1;
      return null;
    }
  }

  /** Positions only: used by selectionchange/scroll; never slices the document. */
  function readPositions() {
    var view = getView();
    if (!view) return null;
    try {
      var ranges = [];
      var input = view.state.selection.ranges || [];
      for (var i = 0; i < input.length; i += 1) {
        var r = input[i];
        var from = Math.min(r.from, r.to);
        var to = Math.max(r.from, r.to);
        if (to <= from) continue;
        ranges.push({ from: from, to: to });
      }
      if (!ranges.length) return null;
      stats.positionReads += 1;
      return { view: view, ranges: ranges };
    } catch (error) { return null; }
  }

  /** Full selection only on a click/keyboard action; text is sliced here. */
  function readSelection() {
    var view = getView();
    if (!view) return null;
    var api = core();
    var envelope = api && typeof api.envelopeFromView === 'function'
      ? api.envelopeFromView(view, null)
      : null;
    if (!envelope || envelope.ok !== true) return null;
    stats.textReads += 1;
    return { view: view, envelope: envelope, text: envelope.text, ranges: envelope.ranges };
  }

  function ensureButtons() {
    if (btn && btn.isConnected && editBtn && editBtn.isConnected) return btn;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = BTN_ID;
    btn.setAttribute('data-on', '0');
    btn.setAttribute('aria-label', '插入只读引用（Ctrl/Cmd+Shift+Enter）。可预览或移除，需手动发送');
    btn.title = '插入只读引用（Ctrl/Cmd+Shift+Enter）；可预览/移除，需手动发送';
    var icon = document.createElement('span');
    icon.className = 'dsh-md-insert-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '＋';
    labelEl = document.createElement('span');
    labelEl.className = 'dsh-md-insert-label';
    labelEl.textContent = BTN_LABEL;
    btn.appendChild(icon);
    btn.appendChild(labelEl);

    editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.id = EDIT_ID;
    editBtn.setAttribute('data-on', '0');
    editBtn.setAttribute('aria-label', '为选中的这段创建受限修改目标，填写意图后放入输入框');
    editBtn.title = '修改此处：只改选中的这段；填写意图后放入输入框，不自动发送';
    editLabelEl = document.createElement('span');
    editLabelEl.className = 'dsh-md-edit-label';
    editLabelEl.textContent = EDIT_LABEL;
    editBtn.appendChild(editLabelEl);

    function keepSelection(event) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
    }
    btn.addEventListener('mousedown', keepSelection);
    editBtn.addEventListener('mousedown', keepSelection);
    btn.addEventListener('click', function (event) {
      event.preventDefault(); event.stopPropagation();
      stats.mouse += 1;
      emitQuote('click');
    });
    editBtn.addEventListener('click', function (event) {
      event.preventDefault(); event.stopPropagation();
      stats.mouse += 1;
      emitEdit('click');
    });
    btn.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); event.stopPropagation();
      stats.keyboard += 1;
      emitQuote('keyboard');
    });
    editBtn.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); event.stopPropagation();
      stats.keyboard += 1;
      emitEdit('keyboard');
    });
    document.body.appendChild(btn);
    document.body.appendChild(editBtn);
    return btn;
  }

  function hide() {
    if (btn && btn.getAttribute('data-on') === '1') stats.hidden += 1;
    if (btn) btn.setAttribute('data-on', '0');
    if (editBtn) editBtn.setAttribute('data-on', '0');
    lastTransform = null;
  }

  function restoreLabels() {
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
    if (btn) { btn.setAttribute('data-state', ''); btn.setAttribute('data-on', '1'); }
    if (editBtn) { editBtn.setAttribute('data-state', ''); editBtn.setAttribute('data-on', '1'); }
    if (labelEl) labelEl.textContent = BTN_LABEL;
    if (editLabelEl) editLabelEl.textContent = EDIT_LABEL;
  }

  function flash(kind) {
    ensureButtons();
    if (resetTimer) clearTimeout(resetTimer);
    if (kind === 'quote') {
      btn.setAttribute('data-state', 'done');
      labelEl.textContent = BTN_DONE;
    } else {
      editBtn.setAttribute('data-state', 'done');
      editLabelEl.textContent = EDIT_DONE;
    }
    resetTimer = setTimeout(function () {
      resetTimer = null;
      if (btn) { btn.setAttribute('data-state', ''); labelEl.textContent = BTN_LABEL; }
      if (editBtn) { editBtn.setAttribute('data-state', ''); editLabelEl.textContent = EDIT_LABEL; }
    }, DONE_RESET_MS);
  }

  function showAt(rect, view) {
    ensureButtons();
    var wasVisible = btn.getAttribute('data-on') === '1';
    var bw = btn.offsetWidth || 86;
    var ew = editBtn.offsetWidth || 92;
    var bh = Math.max(btn.offsetHeight || 30, editBtn.offsetHeight || 30);
    var gap = 4;
    var margin = 8;
    var total = bw + gap + ew;
    var top = rect.top - bh - 8;
    if (top < margin) {
      var below = rect.bottom + 8;
      top = (below + bh <= window.innerHeight - margin) ? below : Math.max(margin, window.innerHeight - bh - margin);
    }
    var anchorX = Number.isFinite(rect.right) ? rect.right : rect.left;
    var left = anchorX - total;
    left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - total - margin));
    var p = 'translate3d(' + Math.round(left) + 'px,' + Math.round(top) + 'px,0)';
    var e = 'translate3d(' + Math.round(left + bw + gap) + 'px,' + Math.round(top) + 'px,0)';
    if (!lastTransform || lastTransform.p !== p || lastTransform.e !== e) {
      btn.style.transform = p;
      editBtn.style.transform = e;
      lastTransform = { p: p, e: e };
    }
    btn.setAttribute('data-on', '1');
    editBtn.setAttribute('data-on', '1');
    if (!wasVisible) stats.shown += 1;
  }

  function update() {
    var positions = readPositions();
    hasSelection = !!positions;
    if (!positions) { hide(); return; }
    try { if (positions.view.composing) { hide(); return; } } catch (error) { /* 字段不存在 */ }
    var rect = anchorRect(positions.view, positions.ranges);
    if (!rect) { hide(); return; }
    if (!intersectsViewport(rect)) { hide(); return; }
    showAt(rect, positions.view);
  }

  function schedule() {
    stats.rafScheduled += 1;
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      stats.rafRuns += 1;
      update();
    });
  }

  function notify(message) {
    try {
      if (window.__dshBridge && typeof window.__dshBridge.toast === 'function') window.__dshBridge.toast(message);
      else if (window.mpExtras && typeof window.mpExtras.toast === 'function') window.mpExtras.toast(message);
      else console.warn('[dsh-selection] ' + message);
    } catch (error) { /* 提示失败不改变拒绝语义 */ }
  }

  function emit(kind) {
    var selection = readSelection();
    if (!selection) { hide(); return false; }
    if (kind === 'quote' && selection.text.length > MAX_INSERT_CHARS) {
      stats.oversize += 1;
      notify('选区过大（' + Math.ceil(selection.text.length / 1024) + ' KB），请缩小范围后再引用');
      return false;
    }
    var envelope = selection.envelope;
    function post(payload) {
      try {
        if (window.handler && typeof window.handler.emit === 'function') {
          window.handler.emit(kind === 'quote' ? 'insert-quote' : 'edit-target', payload);
        } else {
          window.parent.postMessage({ __dshmd: true, dir: 'up', type: kind === 'quote' ? 'insert-quote' : 'edit-target', content: payload }, '*');
        }
      } catch (error) {
        hide();
        return false;
      }
      stats.emits += 1;
      stats.lastTextLength = payload.text.length;
      stats.lastRangeCount = payload.ranges.length;
      stats.lastLineStart = payload.lineStart;
      stats.lastLineEnd = payload.lineEnd;
      if (kind === 'quote') stats.quotes += 1; else stats.edits += 1;
      flash(kind);
      var rect = anchorRect(selection.view, selection.ranges);
      if (rect) showAt(rect, selection.view);
      return true;
    }
    var payloadBase = {
      text: envelope.text,
      ranges: envelope.ranges,
      docLength: envelope.docLength,
      lineStart: envelope.lineStart,
      lineEnd: envelope.lineEnd,
      lines: envelope.lines,
      capturedAt: envelope.capturedAt,
      nonce: envelope.nonce,
      source: 'cm6',
    };
    if (kind === 'quote') return post(payloadBase);

    // Explicit edit capture: bind the digest to the SAME synchronous CM6 doc
    // the offsets came from. The hash is only computed on this click path;
    // selectionchange/scroll never stringifies or hashes the whole document.
    var view = selection.view;
    var docRef = view.state.doc;
    var fullText = docRef.toString();
    stats.digestRequests += 1;
    var started = Date.now();
    var norm = String(fullText).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
    var encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
    if (!encoder || typeof crypto === 'undefined' || !crypto.subtle) {
      stats.digestFailures += 1;
      notify('当前环境无法完成文档摘要，修改目标未创建；请改用只读引用');
      return false;
    }
    crypto.subtle.digest('SHA-256', encoder.encode(norm)).then(function (digest) {
      stats.digestRuns += 1;
      stats.digestMs += Date.now() - started;
      // Any document change during hashing invalidates the offsets. A selection
      // change alone does not: the captured ranges/text still describe docRef.
      if (view.state.doc !== docRef) {
        stats.digestFailures += 1;
        notify('文档在生成快照时发生变化，请重新选择后再修改');
        return;
      }
      var bytes = new Uint8Array(digest);
      var hex = '';
      for (var i = 0; i < bytes.length; i += 1) hex += ('0' + bytes[i].toString(16)).slice(-2);
      post(Object.assign({}, payloadBase, { docDigest: hex, docLength: docRef.length, docIdentity: 'cm6:' + docRef.length + ':' + hex }));
    }, function () {
      stats.digestFailures += 1;
      notify('文档摘要计算失败，修改目标未创建；请改用只读引用');
    });
    return true;
  }

  function emitQuote() { return emit('quote'); }
  function emitEdit() { return emit('edit'); }

  document.addEventListener('selectionchange', function () { stats.selectionchange += 1; schedule(); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { hide(); return; }
    if (event.key !== 'Enter' || !event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
    if (event.isComposing) return;
    var selection = readSelection();
    if (!selection) return;
    event.preventDefault(); event.stopPropagation();
    stats.keyboard += 1;
    emitQuote('keyboard');
  }, true);
  document.addEventListener('pointerdown', function (event) {
    if ((!btn || btn.getAttribute('data-on') !== '1') && (!editBtn || editBtn.getAttribute('data-on') !== '1')) return;
    if (event.target === btn || (btn && btn.contains(event.target)) || event.target === editBtn || (editBtn && editBtn.contains(event.target))) return;
    hide();
  }, true);
  document.addEventListener('scroll', function () {
    // A hidden bar may re-enter the viewport when the user scrolls back into a
    // long selection. Keep scheduling while any non-empty selection exists.
    if (hasSelection || (btn && btn.getAttribute('data-on') === '1')) schedule();
  }, true);
  window.addEventListener('resize', function () {
    if (hasSelection || (btn && btn.getAttribute('data-on') === '1')) schedule();
  }, { passive: true });
  window.addEventListener('dshmd:toast', function () { restoreLabels(); });

  window.__dshSelDebug = {
    stats: stats,
    maxChars: MAX_INSERT_CHARS,
    read: readSelection,
    update: update,
    hide: hide,
    quote: emitQuote,
    edit: emitEdit,
    buttons: function () { return { quote: btn, edit: editBtn }; },
  };
  schedule();
})();
