// dsh-selection.js — 选中文段 → 插入 DSH 对话（换皮套壳的核心新功能）。
//
// 设计边界（ARCHITECTURE §7 / Astra 规则）：
//   · 单一权威：Markdown 源码只从引擎的 CM6 EditorState 读（window.mpEngine._view()），
//     不从 DOM 反推；DOM 只用来定位浮按钮（像素位置不是内容）。
//   · 投影只读：本文件**绝不** dispatch / 改 state / 改选区 / 改历史；只读 state.selection.ranges
//     与 state.doc.sliceString(from, to)。选区文本是文档源码（公式/表格/代码原样保真）。
//   · 不抢不重试：选区变化用 document.selectionchange + requestAnimationFrame 合并；
//     没有 setInterval、没有轮询、没有 0/45/150ms 定时器。唯一的 setTimeout 是"已插入"徽标
//     1.4s 后复位（一次性 UI 反馈，不是状态修复）。
//   · 不新增第二份文档缓存：payload 在点击那一刻现读现发，截图/文本不落盘。
//   · 硬上限：选区源码 > 262144 字符（256 KiB）**不发送**、不截断，改走 bridge toast
//     「选区过大（xxx KB），请缩小范围后再插入」。上限只保护父窗口的 composer/消息通道，
//     不改变"发送时一定与引擎选区逐字符一致"的契约（宁可拒绝，不可静默截断）。
//
// 上行协议（v1）：{ __dshmd:true, dir:'up', type:'insert-to-chat', content:{ text, meta } }
//   text        = 选区 Markdown 源码（多选区用 "\n\n" 连接；不截断）
//   meta.ranges = [{from,to,length}...]（CM6 文档位置，升序由引擎保证）
//   meta.length = text.length；meta.count = 选区段数；meta.source = 'cm6'
//
// 交互：
//   · 选区非空 → 选区末端附近出现 fixed 浮按钮「插入对话」；上方放不下自动落下方；
//   · 点击（mousedown preventDefault 保选区）或 Ctrl/Cmd+Shift+Enter → 发 insert-to-chat；
//   · 发送后按钮短暂显示「已插入」；父窗口若回 toast，由 dsh-bridge 统一显示（引擎 toast 层）；
//   · Escape / 选区塌陷 / 点击别处 → 隐藏；滚动/缩放 → rAF 重定位（离屏则隐藏）。
(function () {
  'use strict';
  if (window.__dshSelectionInstalled) return;
  window.__dshSelectionInstalled = true;

  var BTN_ID = 'dsh-md-insert';
  var BTN_LABEL = '插入对话';
  var BTN_INSERTED = '已插入';
  var INSERTED_RESET_MS = 1400;
  var MAX_INSERT_CHARS = 262144;   // 256 KiB：超过则拒绝并提示，绝不静默截断

  var btn = null;
  var labelEl = null;
  var rafId = 0;
  var resetTimer = null;
  var lastTransform = '';

  // 自证计数器（验收/性能证据从这里取；只读快照，不影响行为）。
  var stats = window.__dshSelStats = {
    selectionchange: 0,   // 原始 selectionchange 次数
    rafScheduled: 0,      // 被 rAF 合并的调度次数
    rafRuns: 0,           // 实际执行的 rAF 次数
    shown: 0,             // 按钮显示次数
    hidden: 0,            // 按钮隐藏次数
    emits: 0,             // insert-to-chat 发送次数
    mouse: 0,             // 点击路径次数
    keyboard: 0,          // 快捷键路径次数
    oversize: 0,          // 因超过 256 KiB 硬上限被拒绝的次数（未发送）
    lastOversizeLength: 0,
    lastTextLength: 0,
    lastRangeCount: 0,
    viewMissing: 0,       // 取不到引擎 state 的次数（诊断用）
  };

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

  /**
   * 从 CM6 EditorState 读当前选区。返回 null = 没有可插入内容。
   * 只用公开字段：state.selection.ranges / state.doc.sliceString —— 不触碰 region 内部字段，
   * 也不做"渲染文本 vs 源码"的二次推断。
   */
  function readSelection() {
    var view = getView();
    if (!view) return null;
    try {
      var ranges = view.state.selection.ranges || [];
      var parts = [];
      var metas = [];
      for (var i = 0; i < ranges.length; i += 1) {
        var range = ranges[i];
        var from = Math.min(range.from, range.to);
        var to = Math.max(range.from, range.to);
        if (to <= from) continue;
        var text = view.state.doc.sliceString(from, to);
        if (!text) continue;
        parts.push(text);
        metas.push({ from: from, to: to, length: text.length });
      }
      if (!metas.length) return null;
      var joined = parts.join('\n\n');
      return { view: view, text: joined, ranges: metas, length: joined.length };
    } catch (error) {
      return null;
    }
  }

  function ensureButton() {
    if (btn && btn.isConnected) return btn;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = BTN_ID;
    btn.setAttribute('data-on', '0');
    btn.setAttribute('aria-label', '将选中的 Markdown 源码插入对话（Ctrl/Cmd+Shift+Enter）');
    btn.title = '插入对话（Ctrl/Cmd+Shift+Enter）';
    var icon = document.createElement('span');
    icon.className = 'dsh-md-insert-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '＋';
    labelEl = document.createElement('span');
    labelEl.className = 'dsh-md-insert-label';
    labelEl.textContent = BTN_LABEL;
    btn.appendChild(icon);
    btn.appendChild(labelEl);

    // mousedown preventDefault：不转移焦点、不塌陷选区（点击浮按钮的第一硬要求）。
    btn.addEventListener('mousedown', function (event) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
    });
    btn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      stats.mouse += 1;
      emitInsert('click');
    });
    btn.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      stats.keyboard += 1;
      emitInsert('keyboard');
    });

    document.body.appendChild(btn);
    return btn;
  }

  function hide() {
    if (!btn) return;
    if (btn.getAttribute('data-on') === '1') stats.hidden += 1;
    btn.setAttribute('data-on', '0');
    lastTransform = '';
  }

  function restoreLabel() {
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
    if (btn) btn.setAttribute('data-state', '');
    if (labelEl) labelEl.textContent = BTN_LABEL;
  }

  function flashInserted() {
    ensureButton();
    if (resetTimer) clearTimeout(resetTimer);
    btn.setAttribute('data-state', 'inserted');
    labelEl.textContent = BTN_INSERTED;
    resetTimer = setTimeout(function () {
      resetTimer = null;
      if (!btn) return;
      btn.setAttribute('data-state', '');
      labelEl.textContent = BTN_LABEL;
    }, INSERTED_RESET_MS);
  }

  /**
   * 选区锚点：取最后一段选区的末端（用户拖选的落点）。
   * 多行选区用末端更贴近"刚选完的位置"；末端不可见/无坐标时回落到首端。
   */
  function anchorRect(view, ranges) {
    var rect = null;
    try {
      var last = ranges[ranges.length - 1];
      rect = view.coordsAtPos(last.to, 1) || view.coordsAtPos(last.from, -1);
      if (!rect) {
        var first = ranges[0];
        rect = view.coordsAtPos(first.from, -1) || view.coordsAtPos(first.to, 1);
      }
    } catch (error) {
      rect = null;
    }
    return rect;
  }

  function showAt(rect) {
    var button = ensureButton();
    var wasVisible = button.getAttribute('data-on') === '1';
    button.setAttribute('data-on', '1');
    if (!wasVisible) stats.shown += 1;

    var bw = button.offsetWidth || 96;
    var bh = button.offsetHeight || 30;
    var gap = 8;
    var margin = 8;
    var top = rect.top - bh - gap;
    if (top < margin) {
      // 边缘避让：上方放不下 → 放到选区下方；下方也放不下 → 钳到视口内最低可用位。
      var below = rect.bottom + gap;
      top = (below + bh <= window.innerHeight - margin) ? below : Math.max(margin, window.innerHeight - bh - margin);
    }
    var anchorX = Number.isFinite(rect.right) ? rect.right : rect.left;
    var left = anchorX - bw;
    left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - bw - margin));

    var transform = 'translate3d(' + Math.round(left) + 'px,' + Math.round(top) + 'px,0)';
    if (transform !== lastTransform) {
      button.style.transform = transform;
      lastTransform = transform;
    }
  }

  function update() {
    var selection = readSelection();
    if (!selection) { hide(); return; }
    // IME 组字期间 DOM 选区与 CM6 state 可能不同步：不弹按钮，避免抢组字。
    try { if (selection.view.composing) { hide(); return; } } catch (error) { /* 字段不存在 */ }
    var rect = anchorRect(selection.view, selection.ranges);
    if (!rect) { hide(); return; }
    // 锚点完全在视口外（滚走了）→ 先隐藏；滚回来时 scroll 事件会重新调度。
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
      hide();
      return;
    }
    showAt(rect);
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

  /**
   * 超过 256 KiB 硬上限：拒绝发送，走桥的 toast（不静默截断、不闪"已插入"）。
   * 为什么拒绝而不是截断：插入到 DSH composer 的文本必须就是用户选中的源码；
   * 截断会让"选区"与"插入内容"失去同一性，比拒绝更坏（Astra：契约优先于便利）。
   */
  function notifyOversize(length) {
    var kb = Math.ceil(length / 1024);
    var message = '选区过大（' + kb + ' KB），请缩小范围后再插入';
    try {
      if (window.__dshBridge && typeof window.__dshBridge.toast === 'function') window.__dshBridge.toast(message);
      else if (window.mpExtras && typeof window.mpExtras.toast === 'function') window.mpExtras.toast(message);
      else console.warn('[dsh-selection] ' + message);
    } catch (error) { /* 提示失败也不改变"拒绝发送"的语义 */ }
  }

  function emitInsert(source) {
    var selection = readSelection();
    if (!selection) { hide(); return false; }
    if (selection.text.length > MAX_INSERT_CHARS) {
      stats.oversize += 1;
      stats.lastOversizeLength = selection.text.length;
      notifyOversize(selection.text.length);
      return false;
    }
    var payload = {
      text: selection.text,
      meta: {
        ranges: selection.ranges,
        length: selection.text.length,
        count: selection.ranges.length,
        source: 'cm6',
      },
    };
    var envelope = { __dshmd: true, dir: 'up', type: 'insert-to-chat', content: payload };
    try {
      // 走桥的 emit = 与引擎同一条 transport；桥未安装时直发父窗口（独立打开/单测）。
      if (window.handler && typeof window.handler.emit === 'function') window.handler.emit('insert-to-chat', payload);
      else window.parent.postMessage(envelope, '*');
    } catch (error) {
      hide();
      return false;
    }
    stats.emits += 1;
    stats.lastTextLength = payload.text.length;
    stats.lastRangeCount = selection.ranges.length;
    flashInserted();
    // 发送后保持按钮位置（选区未变），点击别处/Escape 再隐藏。
    var rect = anchorRect(selection.view, selection.ranges);
    if (rect) showAt(rect);
    return true;
  }

  // ── 事件：只读、事件驱动、rAF 合并 ─────────────────────────────
  document.addEventListener('selectionchange', function () {
    stats.selectionchange += 1;
    schedule();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      // 不抢 Escape 的默认行为（引擎可能用它退出图片/公式会话），只收起自己的浮按钮。
      hide();
      return;
    }
    if (event.key !== 'Enter' || !event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
    if (event.isComposing) return;
    var selection = readSelection();
    if (!selection) return;              // 没选区就不劫持按键，交给引擎/宿主
    event.preventDefault();
    event.stopPropagation();
    stats.keyboard += 1;
    emitInsert('keyboard');
  }, true);

  document.addEventListener('pointerdown', function (event) {
    if (!btn || btn.getAttribute('data-on') !== '1') return;
    if (event.target === btn || btn.contains(event.target)) return;
    hide();
  }, true);

  // 滚动发生在 .cm-scroller 内部（不冒泡），capture 监听兜住；与 window resize 一起 rAF 合并。
  document.addEventListener('scroll', function () {
    if (btn && btn.getAttribute('data-on') === '1') schedule();
  }, true);
  window.addEventListener('resize', function () {
    if (btn && btn.getAttribute('data-on') === '1') schedule();
  }, { passive: true });

  // 父窗口确认插入后可能回 toast（dsh-bridge 负责显示）；这里只把按钮状态复位，
  // 避免"已插入"与父窗口失败提示同时出现时按钮仍停在成功态。
  window.addEventListener('dshmd:toast', function () { restoreLabel(); });

  // 诊断口（只读）：Electron 验收读 stats / 直接触发一次 update 以确认幂等。
  window.__dshSelDebug = {
    stats: stats,
    maxChars: MAX_INSERT_CHARS,
    read: readSelection,
    update: update,
    hide: hide,
    button: function () { return btn; },
  };

  // 首帧若已有选区（例如宿主恢复选区后重载），补一次。
  schedule();
})();
