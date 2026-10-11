// preload：把壳能力以最小面积暴露给渲染进程（contextIsolation 开启，无 nodeIntegration）。
'use strict';
const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

contextBridge.exposeInMainWorld('mpHost', {
  info: () => ipcRenderer.invoke('app:info'),
  health: () => ipcRenderer.invoke('app:health'),
  currentDoc: () => ipcRenderer.invoke('doc:current'),
  docReady: () => ipcRenderer.invoke('doc:ready'),
  open: () => ipcRenderer.invoke('file:open'),
  openPath: (p) => ipcRenderer.invoke('file:openPath', p),
  save: (filePath, text) => ipcRenderer.invoke('file:save', { filePath, text }),
  saveAs: () => ipcRenderer.invoke('file:saveAs'),
  reload: () => ipcRenderer.invoke('file:reload'),   // 「重新加载文件内容」：壳侧重读磁盘（不 pushRecent；脏文档先确认，默认取消）
  stat: (p) => ipcRenderer.invoke('file:stat', p),
  exists: (p) => ipcRenderer.invoke('file:exists', p),
  // 读本地文件为 base64（导出公式排版内联 KaTeX 字体用；本地资源走宿主通道，不走 URL 请求）
  // 3.1.0 起返回值补 `mime`（按扩展名判）与 `path`（绝对路径回显）；`ok/base64/bytes` 字段不变
  readFileBase64: (p) => ipcRenderer.invoke('file:readBase64', p),
  /* ── 图片策略（3.1.0，接口与引擎侧书面敲定）─────────────────────────────────
   *  pickImages      选图（原生多选文件框）⇒ 绝对路径列表；取消 ⇒ {ok:false,canceled:true}
   *  saveImageToAssets  srcPath **或** base64 二选一 ⇒ 落 <文档目录>\assets\ ⇒ 相对路径
   *                    （重名去重由引擎定规则、此处执行：同名同字节⇒复用；同名不同字节⇒-1/-2）
   *  base64ToFile    纯 base64（"抽出到 assets"用）⇒ 临时文件（userData\image-cache）
   *  downloadImageToCache  从浏览器打开：**主进程代取**（渲染进程零网络，connect-src 保持 'none'）
   *                    ⇒ {ok, cachePath, absPath, mime, bytes, fromCache}；同 URL 命中缓存不重复下载
   *  失败一律 {ok:false, error(可读中文), code} —— 不抛异常、不弹模态框、不静默 */
  pickImages: (opts) => ipcRenderer.invoke('image:pick', opts || {}),
  saveImageToAssets: (opts) => ipcRenderer.invoke('image:saveToAssets', opts || {}),
  base64ToFile: (opts) => ipcRenderer.invoke('image:base64ToFile', opts || {}),
  downloadImageToCache: (opts) => ipcRenderer.invoke('image:download', opts || {}),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  /* 导出后的「打开所在文件夹」：打开资源管理器并选中该文件（壳层负责存在性回退）。 */
  showItem: (targetPath) => ipcRenderer.invoke('shell:showItem', targetPath),
  /* 剪贴板写入（主进程执行）：表格/富文本复制走这条，避免渲染进程手势/权限导致的静默失败。 */
  writeClipboard: (payload) => ipcRenderer.invoke('clipboard:write', payload || {}),
  /* 通用设置读写（壳层白名单）：设置面板的开关走这条。 */
  debugSessions: () => ipcRenderer.invoke('debug:sessions'),
  /* 【只读调试口·S4①·2026-10-10】主进程侧的原生主题真源（{source, dark}）—— 渲染侧的 matchMedia
     会被本应用自身的 CSS color-scheme 干扰（实测 theme:'dark' 的 profile 里仍报 false ✗），
     复核"启动时 theme 是否落到 nativeTheme"必须读这个口。只读、零副作用。 */
  debugNativeTheme: () => ipcRenderer.invoke('debug:native-theme'),
  /* 【文件多开】在新窗口里打开一个文件（不传则用当前文件）。 */
  openInNewWindow: (filePath) => ipcRenderer.invoke('win:openInNewWindow', filePath),
  settingGet: (key) => ipcRenderer.invoke('setting:get', key),
  settingSet: (key, value) => ipcRenderer.invoke('setting:set', { key, value }),
  /* 图片右键：图片进剪贴板 / 另存为（都在主进程做，渲染侧不碰文件系统）。 */
  writeImage: (src) => ipcRenderer.invoke('clipboard:writeImage', { src }),
  /* 系统剪贴板里有没有位图：验收判定「复制图片」是否真的生效（渲染侧读不到位图口味）。 */
  clipboardHasImage: () => ipcRenderer.invoke('clipboard:hasImage'),
  saveImageAs: (payload) => ipcRenderer.invoke('image:saveAs', payload || {}),
  /* 右键菜单的「粘贴」：交给主进程执行（渲染进程的 execCommand('paste') 在 Electron 里不可靠）。 */
  paste: () => ipcRenderer.invoke('edit:paste'),
  themeGet: () => ipcRenderer.invoke('theme:get'),
  themeSet: (mode) => ipcRenderer.invoke('theme:set', mode),
  /* Typora 社区主题：选一个 .css（默认落在 Typora 的主题目录）⇒ 读回全文交给渲染侧改写与注入。
     读文件必须走壳层（渲染进程零文件权限）；主题里的相对 url() 由渲染侧的改写层中和掉，不会去打 404。 */
  pickThemeCss: () => ipcRenderer.invoke('theme:pickCss'),
  docDirty: (dirty) => ipcRenderer.invoke('doc:dirty', dirty),
  docPath: (filePath) => ipcRenderer.invoke('doc:path', filePath),
  docSaved: (filePath) => ipcRenderer.invoke('doc:saved', { filePath }),
  outsideChange: (filePath) => ipcRenderer.invoke('doc:outside-change', { filePath }),
  // 当前文档路径（导出为文件夹时用来解析相对图片路径）
  docInfo: () => ipcRenderer.invoke('doc:info'),
  // 「文件 → 最近打开」：清单 / 清空（打开与置顶走既有的 openPath，不另开一条路）
  recentList: () => ipcRenderer.invoke('recent:list'),
  recentClear: () => ipcRenderer.invoke('recent:clear'),
  // 真链路测试挂点：只有主进程以 MP_TEST_HOOKS=1 启动时才存在（否则主进程直接回错误）
  recentTestMenuClick: (id, force) => ipcRenderer.invoke('recent:test-menu-click', id, !!force),
  recentTestMenuList: () => ipcRenderer.invoke('recent:test-menu-list'),
  // 3.0.9：文件菜单读数（「文件位置」等项的实时 label/enabled）与"复制绝对路径"的真点击挂点
  recentTestFileMenu: () => ipcRenderer.invoke('recent:test-file-menu'),
  recentTestCopyPath: () => ipcRenderer.invoke('recent:test-copy-path'),
  // 取证用：把当前生效的「文件」子菜单用 Electron 菜单 API 原样弹出来（原生菜单 CDP 拍不到）
  recentTestPopupFileMenu: () => ipcRenderer.invoke('recent:test-popup-file-menu'),
  // 诊断用：从主进程注入一次按键（CDP 注入的键进不了 Electron 的加速键体系，只能从主进程这条问）
  recentTestSendKey: (p) => ipcRenderer.invoke('recent:test-send-key', p || {}),
  // 导出为文件夹：选目录 → 逐张复制图片 → HTML 分块流式落盘
  exportPickFolder: (opts) => ipcRenderer.invoke('export:pickFolder', opts || {}),
  exportPrepareAssets: (opts) => ipcRenderer.invoke('export:prepareAssets', opts || {}),
  exportBeginHtml: (opts) => ipcRenderer.invoke('export:beginHtml', opts || {}),
  exportAppendHtml: (opts) => ipcRenderer.invoke('export:appendHtml', opts || {}),
  exportFinishHtml: (opts) => ipcRenderer.invoke('export:finishHtml', opts || {}),
  exportAbortHtml: (opts) => ipcRenderer.invoke('export:abortHtml', opts || {}),
  // 导出为 PDF：复用上面那条「导出为文件夹」流程写出的本地 HTML，再由壳层从磁盘打印。
  // 【固定给引擎侧的名字】导出 PDF 就调这一个：mpHost.exportPdf() —— 内部自动完成
  // 选目标 → staging → 请渲染侧写 HTML（走 export:make-html）→ printToPDF → 分片写盘 → 清理。
  exportPdf: (opts) => ipcRenderer.invoke('export:pdf', opts || {}),
  exportPdfCancel: () => ipcRenderer.invoke('export:pdfCancel'),
  htmlDone: (o) => ipcRenderer.invoke('export:htmlDone', o || {}),
  onExportMakeHtml: (cb) => ipcRenderer.on('export:make-html', (_e, p) => cb(p)),
  onExportProgress: (cb) => ipcRenderer.on('export:progress', (_e, p) => cb(p)),
  // 拖入文件的真实路径（Electron ≥32：File 对象不再带 path，必须走 webUtils）
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
  // 缩放：壳层职责，引擎不掺和（与 2.x 的 Ctrl+= / - / 0 语义一致）
  zoomIn: () => { webFrame.setZoomLevel(Math.min(4, webFrame.getZoomLevel() + 0.5)); return webFrame.getZoomLevel(); },
  zoomOut: () => { webFrame.setZoomLevel(Math.max(-3, webFrame.getZoomLevel() - 0.5)); return webFrame.getZoomLevel(); },
  zoomReset: () => { webFrame.setZoomLevel(0); return 0; },
  // 全屏切换（工具栏「全屏」按钮）：壳层负责，返回新状态供渲染侧提示
  toggleFullscreen: () => ipcRenderer.invoke('win:fullscreen'),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
  onDoc: (cb) => ipcRenderer.on('doc', (_e, payload) => cb(payload)),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, payload) => cb(payload)),
});
