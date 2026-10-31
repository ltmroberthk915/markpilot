// dsh-bridge.js — MarkPilot CM6 renderer 在 DSH 右侧栏 iframe 里的宿主桥（协议 v1）。
//
// 契约：
//   上行 iframe → 父窗口：{ __dshmd:true, dir:'up',   type, content }
//   下行 父窗口 → iframe：{ __dshmd:true, dir:'down', type, content }
//   上行类型：bridge-ready | init | change | text | insert-to-chat | host-invoke | openLink | manual-save
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

  /* ── 文档相对路径图：把 <base> 指到宿主的本地图片路由 ─────────────────────────
   * 为什么必须由桥来做：引擎只在收到 `mp:docdir` 时才自己设 <base>，而那条通道在桌面壳里
   * 拼的是 file://；DSH 的编辑面是 **http 源**，CSP 的 img-src 不含 file:，Chromium 也不许
   * http 页面加载 file:// 子资源 ⇒ 相对路径图必然「图片加载失败」（实测就是这个现象）。
   * 桥改成等价语义：基准 = 宿主 /img/ 路由 + 文档目录，于是引擎发出的相对 src 落到同一路由。
   * 规则（与 lib/index.js 的 decodeImageRequestPath 对齐）：
   *   · 目录按 / 逐段 percent-encode 并保留分隔符 ⇒ 空格/中文/#?% 全部安全；
   *   · `../` 由浏览器按 RFC 3986 自己归一化，宿主拿到的已经是规整的绝对路径；
   *   · 没有目录（未命名文档 / 宿主没给 rootPath）⇒ 退回 ./，保持现状，不崩不抛。 */
  var IMG_ROUTE = (function () {
    try {
      var matched = /^(.*\/)renderer-cm6\/[^/]*$/.exec(location.pathname);
      if (matched) return matched[1] + 'img/';
    } catch (error) { /* 老内核没有 location.pathname */ }
    return '/dsh-markdown-typora/img/';
  })();

  function encodeLocalDir(dir) {
    return String(dir).split('/').map(function (segment) {
      return encodeURIComponent(segment).replace(/[!'()*]/g, function (ch) {
        return '%' + ch.charCodeAt(0).toString(16).toUpperCase();
      });
    }).join('/');
  }

  function applyDocBase(rootPath) {
    var dir = typeof rootPath === 'string' ? rootPath.replace(/\\/g, '/').replace(/\/+$/, '') : '';
    // 只认"盘符绝对目录"：`.` / 相对形态 / 空串一律当作没有目录（directoryOf("a.md") 会给 "."，
    // 那种情况设 base 反而会静默落到 img/./ 上）。UNC 目录暂不支持（未实测，宁可不设）。
    if (!/^[A-Za-z]:(\/|$)/.test(dir)) dir = '';
    var href = dir ? IMG_ROUTE + encodeLocalDir(dir) + '/' : './';
    try {
      // 只改写**自己**那个 base：引擎的 `base[data-mp-docbase]` 一旦出现（它插在 head.firstChild）
      // 才是树序第一个、真正生效的那个；抢着改它等于替引擎做决定，宁可让 verifyDocBase 报警。
      var base = document.querySelector('base[data-dsh-docbase]')
        || document.querySelector('base:not([data-mp-docbase])');
      if (!base) {
        base = document.createElement('base');
        base.setAttribute('data-dsh-docbase', '1');
        (document.head || document.documentElement).insertBefore(base, document.head ? document.head.firstChild : null);
      }
      if (base.getAttribute('href') !== href) base.setAttribute('href', href);
      verifyDocBase(href);
      return href;
    } catch (error) {
      return null;
    }
  }

  /* base 的**唯一写者**断言（只在异常时打一条 console.error，不抢写、不重试）：
   * HTML 规范下多个 <base> 只有树序第一个生效；引擎将来若补上 `mp:docdir` 通道，
   * 它会往 head.firstChild 插一个 file:// 的 base（main.js mpSetDocPath）抢先夺权 ⇒
   * 本桥的基准静默失效、图又裂。那属于"看起来修好了其实没有"，必须留一条可检索的证据。 */
  var baseWarned = false;
  function verifyDocBase(expected) {
    if (baseWarned) return;
    try {
      var bases = document.querySelectorAll('base');
      var actual = document.baseURI;
      var want = new URL(expected, location.href).href;
      if (actual !== want || bases.length !== 1) {
        baseWarned = true;
        try {
          console.error('[dsh-bridge] <base> 未按预期生效：base 数量=' + bases.length
            + ' 期望=' + want + ' 实际=' + actual);
        } catch (ignored) { /* 无 console */ }
      }
    } catch (error) { /* 老内核：忽略 */ }
  }

  /* 图片路由能力探测（每个 iframe 只探一次，结果缓存）。
   * 为什么要探：插件升级后宿主进程可能还是旧代码（没有 /img/ 路由）。
   * 判据用**两种宿主对同一个"合法但不存在"图片路径的不同答法**：
   *   新宿主：serveImageFile 里 stat ENOENT ⇒ 404 + text/plain（"not found"）；
   *   旧宿主：prefix 路由把未知路径落到 sendJson 兜底 ⇒ 404 + application/json。
   * ★ 必须有超时：这条探测挡在 open 派发之前，宿主若挂住（半死连接/排队），编辑面会永远空白，
   *   而看门狗在本分支已经停掉、父侧 doc.opened 也已置位 ⇒ 没有任何重试路径（错-53 的同族）。
   *   超时/网络错误一律按"本次不可用"处理（基准退回 ./，与修复前一致），且**不缓存**失败，
   *   下一次 open 还能再试；只有"明确 404+json"才缓存 false。 */
  var IMAGE_ROUTE_PROBE_MS = 2000;
  var imageRouteReady = null;
  function routeProbeFailed() {
    imageRouteReady = null;      // 断网/超时/异常都可能是瞬时的：别把 iframe 永久钉在"不可用"
    return false;
  }
  function resolveImageRoute() {
    if (typeof imageRouteReady === 'boolean') return Promise.resolve(imageRouteReady);
    if (imageRouteReady) return imageRouteReady;         // 探测进行中：复用同一个 Promise
    if (typeof fetch !== 'function' || typeof AbortController !== 'function') {
      imageRouteReady = false;
      return Promise.resolve(false);
    }
    var controller = new AbortController();
    var timer = setTimeout(function () {
      try { controller.abort(); } catch (error) { /* 老内核 */ }
    }, IMAGE_ROUTE_PROBE_MS);
    imageRouteReady = fetch(IMG_ROUTE + 'C%3A/__dshmd_probe__/probe.png', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(function (res) {
        var type = '';
        try { type = String((res.headers && res.headers.get('content-type')) || ''); } catch (error) { type = ''; }
        var ready;
        if (res && res.status === 404 && type.indexOf('text/plain') === 0) ready = true;      // 新宿主
        else if (res && res.status === 404 && type.indexOf('application/json') === 0) ready = false; // 旧宿主（确定性）
        else return routeProbeFailed();                                                       // 其它形态：本次不用，下次再试
        imageRouteReady = ready;
        return ready;
      })
      .catch(routeProbeFailed)
      .then(function (value) { clearTimeout(timer); return value; });
    return imageRouteReady;
  }

  function runHandlers(type, content) {
    var list = handlers[type];
    if (!list) return;
    for (var i = 0; i < list.length; i += 1) {
      try { list[i](content); } catch (error) {
        // 引擎 handler 抛错不许拖垮桥：留给宿主控制台一条可检索的日志。
        try { console.error('[dsh-bridge] handler failed:', type, error); } catch (ignored) { /* 无 console */ }
      }
    }
  }

  /** 最近一次 open 的链路自证（不缓存文档，只记"探测成没成、耗时、当时的 base"）。 */
  var openTrace = null;

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

    // 【顺序纪律】open 期间先摆好文档目录基准，再把文档交给引擎：
    // 引擎首次渲染就要按正确基准解析相对图片路径（见 index.html 的目录形状契约）。
    // 探测是异步的：宿主若是"还没重启成新代码"的旧版（没有 /img/ 路由），基准退回 ./，
    // 行为与修复前一致 —— 绝不出现"桥换了基准、宿主不认路"的半截状态。
    if (type === 'open') {
      handshakeSatisfied = true;
      stopWatchdog();
      var docDir = content && typeof content === 'object' ? (content.rootPath || content.docDir || '') : '';
      // 自证（错-27/错-36）：出问题时必须能分清"探测挂了"与"引擎 boot 挂了"。
      var trace = { dir: docDir, ready: null, base: null, ms: 0, startedAt: Date.now() };
      openTrace = trace;
      resolveImageRoute().then(function (ready) {
        applyDocBase(ready ? docDir : '');
        trace.ready = !!ready;
        trace.base = (function () { try { return document.baseURI; } catch (error) { return null; } })();
        runHandlers('open', content);
        trace.ms = Date.now() - trace.startedAt;
        // 引擎 boot() 是同步的：handler 返回时 window.mpEngine 已创建。
        // 用微任务而不是 0ms 定时器：不新增宏任务，也不抢渲染帧。
        queueMicrotask(maybeApplyPendingTheme);
      });
      return;
    }

    if (type === 'setValue') {
      handshakeSatisfied = true;
      stopWatchdog();
    }
    runHandlers(type, content);
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

  /* ── 手动保存（Ctrl+S / 工具栏保存）────────────────────────────────────────
   * 引擎的快捷键表把 Ctrl+S 绑到 actions.save；该动作只认 window.mpHost.__save
   * （其次 __save 缺失时才退到 docInfo()+save()/saveAs()）。DSH 皮此前从未定义
   * window.mpHost ⇒ Ctrl+S 被 keymap 吃掉后什么都不发生（不是落盘、也不是报错）。
   * 这里只加最小宿主面：__save 发一条上行 manual-save，由 lib/client.js 走
   * 与自动保存同一条版本守卫写路径；不缓存文档、不改引擎、不伪造版本。
   * 注意：只补 __save，不定义 docInfo，避免改变引擎其它宿主能力的判定。 */
  (function installManualSaveHost() {
    var host = window.mpHost;
    if (!host || (typeof host !== 'object' && typeof host !== 'function')) host = window.mpHost = {};
    if (typeof host.__save === 'function') return;
    host.__save = function () {
      send('manual-save', { source: 'ctrl-s', at: Date.now() });
      return true;
    };
  })();

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
    docBase: function () { try { return document.baseURI; } catch (error) { return null; } },
    imageRoute: function () { return IMG_ROUTE; },
    routeReady: function () { return imageRouteReady; },
    openTrace: function () { return openTrace; },
  };

  // 首帧：若上一次宿主主题已知，直接上屏（避免深色宿主闪白/浅色宿主闪黑）。
  try {
    var saved = localStorage.getItem('dshmd-theme');
    if (saved === 'dark' || saved === 'light') applyHostTheme(saved === 'dark');
  } catch (error) { /* 无存储：等父窗口下发的 theme */ }

  // 通知父窗口桥已就绪（父页面据此判断可以开始握手/下发 theme）。
  send('bridge-ready', { href: location.href });
})();
