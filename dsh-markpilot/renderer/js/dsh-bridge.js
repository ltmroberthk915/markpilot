// dsh-bridge：MarkPilot renderer 在 DSH 右侧栏 iframe 里的宿主桥。
//
// 契约与 Typora-Editor-App 的 js/vscode.js 完全同形（window.handler 的 on/emit、
// 消息形状 {type, content}），只把 transport 从 acquireVsCodeApi/ipcRenderer 换成
// window.parent.postMessage —— 编辑器代码一行不改即可在 DSH 里跑。
//
// 宿主判定：__dshHost = true。__vscodeHost 保持 false（不注入 VSIX 的
// --vscode-* CSS 覆盖）；markpilotDesktop 不设（zoom.js 会据此装桌面专属
// Ctrl+=/-/0，DSH 里由 DSH 自己的快捷键层管，这里只留 Ctrl+滚轮缩放）。
window.__dshHost = true;
window.__vscodeHost = false;

(function () {
  if (window.__dshBridgeInstalled) return;
  window.__dshBridgeInstalled = true;

  var events = {};
  // hostApi RPC 等待表（与 vscode.js 的 hostPending 同构）。
  var hostPending = new Map();
  var hostSequence = 0;

  function send(type, content) {
    try {
      window.parent.postMessage({ __dshmp: true, dir: 'up', type: type, content: content }, '*');
    } catch (e) { /* 父窗口不在时静默 */ }
  }

  window.addEventListener('message', function (e) {
    var data = e.data;
    if (!data || data.__dshmp !== true || data.dir !== 'down') return;
    if (data.type === 'host-result' && data.content && hostPending.has(data.content.id)) {
      var pending = hostPending.get(data.content.id);
      hostPending.delete(data.content.id);
      if (data.content.error) pending.reject(new Error(data.content.error));
      else pending.resolve(data.content.result);
      return;
    }
    var fn = events[data.type];
    if (fn) fn(data.content);
  });

  var bridge = {
    on: function (event, fn) {
      events[event] = fn;
      return this;
    },
    emit: function (event, data) {
      send(event, data);
    },
  };
  window.handler = bridge;
  window.vscodeEvent = bridge;

  // hostApi 兼容层：clipboard 优先走宿主（父页面同源剪贴板），失败回落 iframe 内
  // navigator.clipboard；open-external 转发给父窗口处理；app-info 静态应答。
  window.hostApi = {
    invoke: function (cmd, args) {
      if (cmd === 'export-menu') {
        // 与 vscode.js 同一处置：导出菜单在无原生菜单的宿主里退化为 office-export 通道。
        send('office-export', { text: window.vditor && window.vditor.getValue ? window.vditor.getValue() : '' });
        return Promise.resolve(true);
      }
      if (cmd === 'toolbar-height') return Promise.resolve(null);
      if (cmd === 'app-info') {
        return Promise.resolve({ name: 'MarkPilot for DSH', version: '0.1.0', host: 'dsh' });
      }
      return new Promise(function (resolve, reject) {
        var id = 'dshhost-' + (++hostSequence);
        var timer = setTimeout(function () {
          hostPending.delete(id);
          reject(new Error('宿主未响应：' + cmd));
        }, 15000);
        hostPending.set(id, {
          resolve: function (value) { clearTimeout(timer); resolve(value); },
          reject: function (error) { clearTimeout(timer); reject(error); },
        });
        send('host-invoke', { id: id, cmd: cmd, args: args });
      });
    },
  };

  // 通知父窗口桥已就绪（父页面据此判断可以先发 open）。
  send('bridge-ready', { href: location.href });

  // 握手看门狗（自愈架构，双引擎共用）：渲染器 emit("init") 后若宿主的 open 在注册窗口被丢，
  // 每 2s 代发一次 init，直到收到任意下行 open/setValue——把「丢失即死」的竞态类整体消灭。
  // 宿主对重复 init 幂等（maybeBoot 有 opened/booting 闸），boot 失败还能借它自愈重试。
  var handshakeArmed = false;
  var watchdog = null;
  var armWatchdog = function () {
    if (watchdog) return;
    handshakeArmed = true;
    watchdog = setInterval(function () { send('init', { again: true }); }, 2000);
  };
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.__dshmp !== true || d.dir !== 'down') return;
    if (d.type === 'open' || d.type === 'setValue') {
      if (watchdog) { clearInterval(watchdog); watchdog = null; }
    }
  });
  // 渲染器 emit("init") 时武装看门狗：包装 emit，截获 init 事件。
  var origEmit = bridge.emit;
  bridge.emit = function (event, data) {
    if (event === 'init') armWatchdog();
    return origEmit.call(this, event, data);
  };
})();
