const vscode =
  typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;
// v2.0.7：宿主标识。模块与经典脚本作用域不同（const vscode 不上 window），
// zoom.js 等模块需要这个显式标志判断是否在 VSIX/webview 里。
// v2.1.6：桌面 EXE 的 preload 会**故意**提供 acquireVsCodeApi 兼容层（就是为了让本文件
// 原样工作），于是窗口里也有 acquireVsCodeApi，这里曾经把桌面版一并判成 webview ——
// 而 zoom.js 用这个标志决定要不要装"桌面版专属"的 Ctrl+= / Ctrl+- / Ctrl+0，结果桌面版
// 三个快捷键全哑（实测徽章恒为 100%，只有 Ctrl+滚轮有效）。桌面 preload 另挂
// `markpilotDesktop` 标志，用它把两者区分开；VSIX 里没有该标志，行为不变。
window.__vscodeHost = !!vscode && !window.markpilotDesktop;
const postMessage = (message) => {
  if (vscode) {
    vscode.postMessage(message);
  }
};

// index.js sends init after its open listener is registered. Sending another
// init here races module loading and can create two live Vditor instances.

let events = {};
// hostApi RPC 的等待表（只在 VSIX 里用；桌面版 preload 直接提供真 hostApi）。
const hostPending = new Map();
function receive({ data }) {
  if (!data) {
    return;
  }
  if (data.type === "host-result" && data.content && hostPending.has(data.content.id)) {
    const pending = hostPending.get(data.content.id);
    hostPending.delete(data.content.id);
    if (data.content.error) pending.reject(new Error(data.content.error));
    else pending.resolve(data.content.result);
    return;
  }
  if (events[data.type]) {
    events[data.type](data.content);
  }
}
window.addEventListener("message", receive);

const getVscodeEvent = () => {
  return {
    on(event, data) {
      events[event] = data;
      return this;
    },
    emit(event, data) {
      postMessage({ type: event, content: data });
    },
  };
};
window.vscodeEvent = getVscodeEvent();
window.handler = getVscodeEvent();

function addCss(css) {
  const style = document.createElement("style");
  style.innerText = css;
  document.documentElement.appendChild(style);
}

window.addThemeCss = function () {
  addCss(`
    *{
        background-color: var(--vscode-editor-background) !important;
        color: var(--vscode-editor-foreground) !important;
    }
    *{
        border-color: var(--vscode-quickInputTitle-background) !important;
    }
    `);
};

function isCompose(e) {
  return e.metaKey || e.ctrlKey;
}
// v2.0.7 起内容缩放由 js/zoom.js 统一接管（Ctrl+滚轮 + 桌面 Ctrl+=/-/0 +
// 右下角比例徽章）；旧的 zoomElement 只改 .vditor-content 行内 zoom 且无
// 状态/无上限，已删除。

// v2.0.19：F12 -> developerTool 的隐藏入口已移除。它会在用户毫无预期时弹出一个
// 独立的开发者工具窗口，而桌面版另有「视图」菜单里的正规入口；主进程里对应的
// developerTool 消息分支也一并删除。
window.addEventListener("keydown", (e) => {
  if (isCompose(e) && e.code === "KeyV") {
    // e.preventDefault();
  }  // vscode的bug, hebrew(希伯来语)键盘会粘贴两次
});

// 判宿主必须用 __vscodeHost，不能判 vscode 本体（zoom.js:83 的同款先例）：
// 桌面 EXE 的 preload 也提供 acquireVsCodeApi 兼容层（见顶部 v2.1.6 注释），
// `if (vscode)` 会把桌面版一并判成 webview 并注入上面这套 * !important 覆盖——
// 而 EXE 里 --vscode-* 变量未定义，IACVT 让 color/background-color/border-color
// 全部坍成 unset，主题的链接色、引用底条等非 important 规则被整体顶掉。
// __vscodeHost 只有真 VSIX webview 才为 true（!!vscode && !markpilotDesktop），
// 桌面版不再注入；VSIX 里行为不变。
if (window.__vscodeHost) {
  window.addThemeCss();
}

// hostApi 兼容层（第 5 轮 B2）：渲染层与桌面版共享的代码用 window.hostApi.invoke
// 调宿主能力（clipboard-read-text / clipboard-write-text / open-external /
// app-info）。桌面版由 preload 在脚本运行前注入真 hostApi；VSIX webview 没有这层，
// 于是在这里补一个 shim：把 invoke 翻译成 host-invoke 消息发给扩展宿主，扩展宿主
// 应答 host-result（markdownEditorProvider.js 的 host-invoke 分支）。两个桌面专属
// 命令本地消化，不走宿主往返：
//   · export-menu——桌面版弹原生导出菜单；VSIX 直接走 office-export 通道（与
//     toolbar.js 的 else 分支同一去向），否则装了 shim 后导出按钮会变成死键；
//   · toolbar-height——桌面主进程记工具栏高度用，VSIX 无消费者。
// 注意判 __vscodeHost 而不是 vscode：桌面 preload 也提供 acquireVsCodeApi 兼容层，
// 且它在脚本运行前就挂好了真 hostApi，这里的 !window.hostApi 兜底保证绝不覆盖。
if (window.__vscodeHost && !window.hostApi) {
  let hostSequence = 0;
  window.hostApi = {
    invoke(cmd, args) {
      if (cmd === "export-menu") {
        window.handler.emit("office-export", { text: window.vditor?.getValue?.() ?? "" });
        return Promise.resolve(true);
      }
      if (cmd === "toolbar-height") return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        const id = "hostapi-" + (++hostSequence);
        const timer = setTimeout(() => {
          hostPending.delete(id);
          reject(new Error("宿主未响应：" + cmd));
        }, 15000);
        hostPending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        postMessage({ type: "host-invoke", content: { id, cmd, args } });
      });
    },
  };
}
