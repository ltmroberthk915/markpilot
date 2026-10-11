// 伪装 VS Code webview 环境，让 renderer/js/vscode.js 原样工作：
// - acquireVsCodeApi().postMessage -> ipcRenderer.send('ed-msg')
// - 主进程推送 -> window MessageEvent（vscode.js 的 receive 直接消费）
// 另给外壳页暴露 hostApi（invoke 风格）。
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('acquireVsCodeApi', () => ({
  postMessage: (message) => { ipcRenderer.send('ed-msg', message); },
}));

// 上面这个兼容层会让 renderer/js/vscode.js 把**桌面版**也判成"VS Code webview"
// （window.__vscodeHost = true），而 zoom.js 正是用这个标志决定要不要装"桌面版专属"的
// Ctrl+= / Ctrl+- / Ctrl+0——实测桌面版里这三个快捷键全哑（比例徽章一直 100%，只有
// Ctrl+滚轮能动）。这里补一个明确的宿主标志，让 vscode.js 能把"桌面外壳"和"真的在
// VS Code 里"分开（VSIX 里没有这个标志，行为不变）。
contextBridge.exposeInMainWorld('markpilotDesktop', true);

contextBridge.exposeInMainWorld('hostApi', {
  invoke: (cmd, args) => ipcRenderer.invoke('shell:' + cmd, args),
  onPush: (channel, cb) => {
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
});

ipcRenderer.on('ed-push', (_e, payload) => {
  window.dispatchEvent(new MessageEvent('message', { data: payload }));
});
