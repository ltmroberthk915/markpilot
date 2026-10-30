// dsh-bridge.js — MarkPilot CM6 renderer 在 DSH 右侧栏 iframe 里的宿主桥（协议 v1）。
//
// 契约：
//   上行 iframe → 父窗口：{ __dshmd:true, dir:'up',   type, content }
//   下行 父窗口 → iframe：{ __dshmd:true, dir:'down', type, content }
//   上行类型：bridge-ready | init | change | text | insert-to-chat | host-invoke | openLink
//   下行类型：open | setValue | requestText | theme | toast | host-result
//
// 为什么桥必须早于 cm6/app.js 加载：引擎在脚本尾部同步调用 window.handler.on("open"…)/
// .on("setValue"…)/.on("requestText"…) 注册下行处理，并在同一尾巴里 emit("init")。桥晚到
// 会让 open 落在没有监听者的窗口里（实测坑），所以 index.html 把本文件放在 app.js 之前。
//
// 单一权威：本桥**不缓存文档/选区/历史**，只做传输与皮肤级主题/提示；open/setValue/
// requestText 原样转交引擎既有 handler。change/text 由引擎自己的 post() 直接发给父窗口，
// 本桥不重复转发（否则父窗口收到两份脏标）。
//
// 皮肤级事件（theme/toast）不走 window.handler 的事件表（那是引擎的单监听表，后注册会
// 覆盖先注册），改用 window 上的 CustomEvent：dshmd:theme / dshmd:toast。
(function () {
  'use strict';
  if (window.__dshBridgeInstalled) return;
  window.__dshBridgeInstalled = true;

  // 与旧 vscode/vditor 壳同形的宿主判定位；engine 不读这两个标志，留给同仓旧渲染器兼容。
  window.__dshHost = true;
  window.__vscodeHost = false;

  var THEME_DARK = { bg: '#2E3440', fg: '#C3C7CF' };   // engine TELARI.dark 的首帧兜底色
  var THEME_LIGHT = { bg: '#FAF9F6', fg: '#31312F' };  // engine TELARI.light
  var WATCHDOG_MS = 2000;
  var WATCHDOG_MAX_TICKS = 30;   // 60s 后停：宿主若始终不回 open，继续发只是噪音

  var handlers = Object.create(null);   // type -> [fn]（引擎每型一个，这里多监听也不互相踩）
  var hostPending = new Map();          // hostApi.invoke 的 RPC 等待表
  var hostSequence = 0;
  var toastTimer = null;
  var watchdog = null;
  var watchdogTicks = 0;
  var handshakeSatisfied = false;
  var pendingThemeApply = false;
  var themeDark = null;

  function send(type, content) {
    try {
      window.parent.postMessage({ __dshmd: true, dir: 'up', type: type, content: content }, '*');
    } catch (error) { /* 父窗口不在（独立打开）时静默 */ }
  }

  function emitSkin(type, detail) {
    try { window.dispatchEvent(new CustomEvent('dshmd:' + type, { detail: detail })); } catch (error) { /* 老内核无 CustomEvent */ }
  }

  function normalizeDark(content) {
    if (typeof content === 'boolean') return content;
    if (typeof content === 'string') return content !== 'light';
    if (content && typeof content === 'object') {
      if (typeof content.dark === 'boolean') return content.dark;
      if (typeof content.theme === 'string') return content.theme !== 'light';
      if (typeof content.mode === 'string') return content.mode !== 'light';
    }
    return true; // 缺省深色：与 engine 默认 telari-dark 一致
  }

  /**
   * 宿主主题 → 引擎主题。
   * 实测约束（engine applyEditorTheme 的单一写者纪律）：--mp-* 归 engine 主题登记表
   * window.mpTheme；本桥不直接写 palette 变量，只做三件事：
   *   ① 写 localStorage 偏好（让下次启动的首帧与 boot 末次 applyEditorTheme 就用对配色）；
   *   ② 若 window.mpEngine 已就绪，调用既有 setTheme()（登记表存在时它会写变量+持久化+dataset）；
   *   ③ 给皮自己的按钮/提示挂 data-dsh-theme（CSS 作用域，不参与引擎调色板）。
   * 注意 engine 在模块加载时已跑过一次 applyEditorTheme（boot 前）；因此偏好写入必须发生在
   * boot 之前才叫"首帧正确"，boot 之后则靠 setTheme() 立即生效。两路都走，幂等。
   */
  function applyHostTheme(dark) {
    themeDark = !!dark;
    var root = document.documentElement;
    try { root.dataset.dshTheme = dark ? 'dark' : 'light'; } catch (error) { /* 无 root */ }
    try { root.style.colorScheme = dark ? 'dark' : 'light'; } catch (error) { /* 忽略 */ }
    var palette = dark ? THEME_DARK : THEME_LIGHT;
    try {
      root.style.setProperty('--mp-bg', palette.bg);
      root.style.setProperty('--mp-fg', palette.fg);
    } catch (error) { /* 忽略 */ }
    try {
      localStorage.setItem('dshmd-theme', dark ? 'dark' : 'light');
      localStorage.setItem('editor-theme', dark ? 'telari-dark' : 'telari-light');
    } catch (error) { /* 无存储 */ }
    var engine = window.mpEngine;
    if (engine && typeof engine.setTheme === 'function') {
      try { engine.setTheme(dark ? 'telari-dark' : 'telari-light'); } catch (error) { /* 主题未注册时忽略 */ }
      pendingThemeApply = false;
    } else {
      pendingThemeApply = true;   // open/boot 之后补一次（引擎 boot 结束才会创建 window.mpEngine）
    }
    emitSkin('theme', { dark: !!dark });
  }

  // boot 完成（= 引擎已处理过 down open）后补应用一次挂起的主题。
  function maybeApplyPendingTheme() {
    if (!pendingThemeApply || themeDark === null) return;
    var engine = window.mpEngine;
    if (!engine || typeof engine.setTheme !== 'function') return;
    try { engine.setTheme(themeDark ? 'telari-dark' : 'telari-light'); } catch (error) { /* 忽略 */ }
    pendingThemeApply = false;
  }

  function showToast(content) {
    var text = typeof content === 'string' ? content
      : (content && typeof content.text === 'string' ? content.text : (content == null ? '' : String(content)));
    if (!text) return;
    // 引擎自带 toast 层（mpExtras.toast）：有就用它，观感/层级与产品一致。
    try {
      if (window.mpExtras && typeof window.mpExtras.toast === 'function') {
        window.mpExtras.toast(text);
        return;
      }
    } catch (error) { /* 引擎 toast 失败则回落 */ }
    var el = document.getElementById('dsh-md-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dsh-md-toast';
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = text;
    el.setAttribute('data-on', '1');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastTimer = null;
      var node = document.getElementById('dsh-md-toast');
      if (node) node.setAttribute('data-on', '0');
    }, 2600);
  }

  function armWatchdog() {
    if (watchdog || handshakeSatisfied) return;
    watchdogTicks = 0;
    watchdog = setInterval(function () {
      watchdogTicks += 1;
      if (handshakeSatisfied || watchdogTicks > WATCHDOG_MAX_TICKS) {
        stopWatchdog();
        return;
      }
      // 引擎重发 init：宿主对重复 init 幂等（maybeBoot 有 opened/booting 闸），
      // boot 失败也能借它自愈重试。这是握手自愈，不是轮询文档状态。
      send('init', { again: true });
    }, WATCHDOG_MS);
  }

  function stopWatchdog() {
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.__dshmd !== true || data.dir !== 'down') return;
    var type = data.type;
    var content = data.content;

    if (type === 'host-result') {
      if (content && hostPending.has(content.id)) {
        var pending = hostPending.get(content.id);
        hostPending.delete(content.id);
        if (content.error) pending.reject(new Error(String(content.error)));
        else pending.resolve(content.result);
      }
      return;
    }
    if (type === 'theme') { applyHostTheme(normalizeDark(content)); return; }
    if (type === 'toast') { showToast(content); emitSkin('toast', { text: typeof content === 'string' ? content : '' }); return; }

    if (type === 'open' || type === 'setValue') {
      handshakeSatisfied = true;
      stopWatchdog();
    }

    var list = handlers[type];
    if (list) {
      for (var i = 0; i < list.length; i += 1) {
        try { list[i](content); } catch (error) {
          // 引擎 handler 抛错不许拖垮桥：留给宿主控制台一条可检索的日志。
          try { console.error('[dsh-bridge] handler failed:', type, error); } catch (ignored) { /* 无 console */ }
        }
      }
    }
    if (type === 'open') {
      // 引擎 boot() 是同步的：handler 返回时 window.mpEngine 已创建。
      // 用微任务而不是 0ms 定时器：不新增宏任务，也不抢渲染帧。
      queueMicrotask(maybeApplyPendingTheme);
    }
  });

  var bridge = {
    on: function (type, fn) {
      if (typeof fn !== 'function') return bridge;
      (handlers[type] || (handlers[type] = [])).push(fn);
      return bridge;
    },
    emit: function (type, content) {
      if (type === 'init') armWatchdog();
      send(type, content);
      return bridge;
    },
  };
  window.handler = bridge;
  window.vscodeEvent = bridge;

  // 宿主能力调用（协议 v1 的 host-invoke 上行；父窗口以 host-result 应答）。
  // 引擎当前不消费 hostApi，保留为宿主演进位；超时兜底避免永久挂起。
  window.hostApi = {
    invoke: function (cmd, args) {
      if (cmd === 'toolbar-height') return Promise.resolve(null);
      if (cmd === 'app-info') return Promise.resolve({ name: 'dsh-markdown-typora for DSH', version: '0.1.0', host: 'dsh' });
      return new Promise(function (resolve, reject) {
        var id = 'dshhost-' + (++hostSequence);
        var timer = setTimeout(function () {
          hostPending.delete(id);
          reject(new Error('宿主未响应：' + cmd));
        }, 10000);
        hostPending.set(id, {
          resolve: function (value) { clearTimeout(timer); resolve(value); },
          reject: function (error) { clearTimeout(timer); reject(error); },
        });
        send('host-invoke', { id: id, cmd: cmd, args: args });
      });
    },
  };

  // 诊断/取证位（只读快照；dsh-selection 与 Electron 验收都从这里读）。
  window.__dshBridge = {
    send: send,
    applyHostTheme: applyHostTheme,
    toast: showToast,
    theme: function () { return { dark: themeDark, pending: pendingThemeApply }; },
    watchdog: function () { return { armed: !!watchdog, ticks: watchdogTicks, satisfied: handshakeSatisfied }; },
    lastTheme: function () { try { return localStorage.getItem('dshmd-theme'); } catch (error) { return null; } },
  };

  // 首帧：若上一次宿主主题已知，直接上屏（避免深色宿主闪白/浅色宿主闪黑）。
  try {
    var saved = localStorage.getItem('dshmd-theme');
    if (saved === 'dark' || saved === 'light') applyHostTheme(saved === 'dark');
  } catch (error) { /* 无存储：等父窗口下发的 theme */ }

  // 通知父窗口桥已就绪（父页面据此判断可以开始握手/下发 theme）。
  send('bridge-ready', { href: location.href });
})();
