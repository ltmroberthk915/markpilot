// Electron 主进程入口：多窗口、菜单、单实例、IPC 装配、会话恢复
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell, clipboard, nativeImage, screen } = require('electron');
const { startServer } = require('./server');
const { installResourceAuth } = require('./resource-auth');
const {DocumentExporter, FORMATS} = require('./export');
const { AppState } = require('./state');
const { Workspace, listDir, isMdFile } = require('./tree');
const { DocController } = require('./doc');
const { findLaunchPaths, isNewFileLaunch, FileOpenQueue } = require('./file-open');
const {JumpListController,launcherFor,commandLine}=require('./jump-list');
const {newMarkdown}=require('./new-document');
const diagnostics = require('./diagnostics');
const { checkForUpdates, scheduleStartupCheck } = require('./updater');

const APP_ROOT = path.join(__dirname, '..');
const RENDERER_ROOT = path.join(APP_ROOT, 'renderer');
const SHELL_ROOT = path.join(APP_ROOT, 'shell');
const PRELOAD = path.join(APP_ROOT, 'preload', 'preload.js');
const PREFERRED_PORT = 48190;
const NEW_DOCUMENT=Object.freeze({type:'new-md'});
// 一次打开这么多文件就先问一句：一个文件一个窗口，几十个窗口会瞬间吃满内存。
const MANY_WINDOWS = 5;
// v2.0.19：「关于」「帮助」统一到自有内容。此前界面上的两个「关于」里，⋮ 菜单那个
// 讲的是 Vditor 这个开源库本身（还带 b3log.org / ld246.com 外链），「帮助」跳的也是
// Vditor 文档站。渲染内核的 MIT 署名按许可要求保留，但不作为产品介绍。
const REPO_URL = 'https://github.com/ltmroberthk915/markpilot';
// 「关于」的渠道标注（app-info 的返回值之一）：安装版就是正式渠道，不标注；源码直跑的
// 开发实例标「开发版」，让版本号能区分界面来自哪个形态。此前 app-info 的处理器引用了
// 一个从未定义的 distributionChannel()，每次调用都抛 ReferenceError，渲染层「关于」
// 取不到任何信息，版本行整行被藏掉——这就是「关于里看不到版本号」的根因。
const distributionChannel = () => (app.isPackaged ? '' : '开发版');
const aboutDetail = () => [
  '面向中文写作的 Markdown 编辑器：中西文混排、公式与源码双向定位、超大文档不卡。',
  '',
  `仓库：${REPO_URL}`,
  '开源组件：Vditor 3.11.1（MIT 许可，渲染内核）',
].join('\n');

let resourceAuth;
let jumpList,launcher;
let serverPort = 0;

// ---------- 2.1.0 多窗口：窗口注册表 ----------
// 一个窗口一份 {win, doc, exporter, workspace, queue}。原来全局单例的 global.win /
// global.doc / global.workspace 改成「当前聚焦窗口」的访问器，所以菜单与 IPC 里
// 「作用于当前文档」的写法不用重写；但**跨窗口才是重点**：tree-*、export-*、boot
// 这些必须按 event.sender 找到发起窗口，否则 B 窗口重命名会改到 A 窗口的文档。
// 渲染层（extension-src/render）与外壳页（app/shell）一行未改：每个窗口各自加载
// 一份 /shell 页、各自一个编辑器 iframe，现有的 init→open 握手续用。
const windows = new Map(); // webContents.id -> rec
let primaryRec = null;
let lastFocusedRec = null;
// quitting：「应用正在退出」的标记，由 before-quit 置位。关窗处理器用它区分
// "用户关掉一个窗口"（从会话里去掉）与"应用退出"（会话要留着）——见 createWindow 里的 keepSession。
let quitChecking = false, quitConfirmed = false, quitting = false;
const pendingLaunch = []; // app ready 之前的打开请求（命令行/二次启动都可能）

function recs() { return [...windows.values()].filter(r => !r.win.isDestroyed()); }
function recOf(contents) { return contents ? windows.get(contents.id) || null : null; }
function recOfEvent(event) { return recOf(event?.sender); }

/** 「打开诊断日志」：把日志文件交给系统的默认程序打开。没有日志说明至今没记到错误。 */
function openDiagnosticsLog() {
  const file = diagnostics.file();
  if (!file || !diagnostics.exists()) {
    dialog.showMessageBox(focusedRec()?.win, {type: 'info', title: '诊断日志',
      message: '还没有诊断日志', detail: '目前没有记录到任何错误。', buttons: ['确定']});
    return;
  }
  shell.openPath(file).then(error => { if (error) console.error('打开诊断日志失败', error); })
    .catch(error => console.error('打开诊断日志失败', error));
}

/** 「复制诊断信息」：版本 + 平台 + 日志尾部，直接进剪贴板，用户能粘给任何人。 */
function copyDiagnostics() {
  const header = ['MarkPilot 诊断信息',
    '版本 ' + app.getVersion(),
    process.platform + ' ' + process.arch,
    'Electron ' + (process.versions.electron || ''),
    ''].join('\n');
  clipboard.writeText(header + (diagnostics.tail() || '（日志为空）'));
}

/** 渲染进程崩溃后的恢复。文档正文一直在主进程里（DocController.current.text），所以
 *  "重新载入编辑器"就能把它拿回来——但要**告知用户**：静默不处理的话，用户看到的是一个白框，
 *  除了重开应用没有别的办法，而重开还可能丢掉未保存的编辑。 */
function recoverFromRendererCrash(win, details) {
  if (!win || win.isDestroyed()) return;
  const rec = recOf(win.webContents);
  dialog.showMessageBox(win, {
    type: 'warning',
    title: '编辑区已崩溃',
    message: '编辑区崩溃了（原因：' + ((details && details.reason) || '未知') + '）',
    detail: '文档内容保存在主进程里，不会因为这次崩溃丢失。重新载入编辑器即可继续。\n'
      + '崩溃前正在输入、尚未提交的那几个字可能需要重新输入。',
    buttons: ['重新载入编辑器', '稍后'],
    defaultId: 0, cancelId: 1,
  }).then(pick => {
    if (pick.response !== 0 || win.isDestroyed()) return;
    try { rec?.doc?.loadInShell(); } catch (error) { console.error('重新载入编辑器失败', error); }
  }).catch(error => console.error('崩溃提示框失败', error));
}
function focusedRec() {
  // 正在销毁的窗口读 webContents 会抛 "Object has been destroyed"：退出流程里
  // 窗口的 focus/closed 事件交错触发过（实测被这条打中，主进程弹错误框打断退出）。
  // 这里一律当作「没有聚焦窗口」往后退。
  let rec = null;
  try {
    const win = BrowserWindow.getFocusedWindow();
    if (win && !win.isDestroyed()) rec = recOf(win.webContents);
  } catch { rec = null; }
  if (rec && !rec.win.isDestroyed()) return rec;
  if (lastFocusedRec && !lastFocusedRec.win.isDestroyed()) return lastFocusedRec;
  if (primaryRec && !primaryRec.win.isDestroyed()) return primaryRec;
  return recs()[0] || null;
}
// 还停在欢迎页的空窗口：打开文件时优先填进去，避免每点一下都多出一个窗口。
// preferred 是发起这次打开的窗口（外壳点文件树/最近列表的那个），它自己空着就先用它。
// 判据里必须包含「外壳已经 boot 过」（rec.queue.started）：刚 createWindow 出来、还没
// 装载的窗口 doc.file 同样是 null，把它当空窗口复用会让一次多选/多拖的第二个文件被塞进
// 同一个新窗口，最后只剩一个窗口装着最后一个文件——正是用户报的「开一个顶掉一个」。
function emptyRec(preferred) {
  const reusable = rec => !!rec && !rec.closing && rec.queue?.started && !rec.doc.file && !rec.boot?.file;
  if (reusable(preferred)) return preferred;
  const focused = focusedRec();
  if (reusable(focused)) return focused;
  return recs().find(reusable) || null;
}
Object.defineProperty(global, 'win', {configurable: true, get: () => focusedRec()?.win || null});
Object.defineProperty(global, 'doc', {configurable: true, get: () => focusedRec()?.doc || null});
Object.defineProperty(global, 'workspace', {configurable: true, get: () => focusedRec()?.workspace || null});
Object.defineProperty(global, 'windows', {configurable: true, get: () => recs()});

const launchNew = isNewFileLaunch(process.argv, {isPackaged:app.isPackaged});
const launchFiles = launchNew ? [] : findLaunchPaths(process.argv, {isPackaged: app.isPackaged, appPath: app.getAppPath()});
if (launchNew) pendingLaunch.push({newFile: true});
else if (launchFiles.length) pendingLaunch.push({targets: launchFiles});
// Electron may reorder/add argv entries when forwarding a second instance.
// Pass the resolved paths as structured data to preserve the original request.
const gotLock = app.requestSingleInstanceLock({filesToOpen: launchFiles, newFile:launchNew});
if (!gotLock) {
  app.quit();
} else {
  main().catch((e) => { console.error(e); app.exit(1); });
}

async function main() {
  // v2.0.8 品牌重命名：数据目录固定小写 %APPDATA%\markpilot。productName
  // 改为 MarkPilot 后 Electron 默认会落到 %APPDATA%\MarkPilot（大写）；
  // 仅在检测到"默认目录特征"时重定向，绝不碰测试 runner 预先设置的
  // 隔离 profile。旧目录由 state.js 的 legacy 迁移链自动接管 state.json。
  {
    const currentName = path.basename(app.getPath('userData')).toLowerCase();
    if (currentName === 'electron' || currentName === 'markpilot' || currentName === 'marcopilot') {
      const target = path.join(app.getPath('appData'), 'markpilot');
      // API Key 保险库不在 state.js 的 legacy 链里，随目录改名一并搬迁
      // （存在性检查保证幂等，只搬一次）。
      const legacyVault = path.join(app.getPath('appData'), 'marcopilot', 'completion-secrets.json');
      const targetVault = path.join(target, 'completion-secrets.json');
      app.setPath('userData', target);
      try {
        if (fs.existsSync(legacyVault) && !fs.existsSync(targetVault)) {
          fs.mkdirSync(target, { recursive: true });
          fs.copyFileSync(legacyVault, targetVault);
        }
      } catch { /* 保险库搬不动时按空库冷启动 */ }
    }
  }
  // 二次启动：每个文件开一个窗口；没有文件参数就聚焦最近用过的窗口
  app.on('second-instance', (_e, argv, workingDirectory, data) => {
    if(data?.newFile===true)requestOpen({newFile:true});
    else if (Array.isArray(data?.filesToOpen) && data.filesToOpen.length) requestOpen({targets: data.filesToOpen});
    else if (data && typeof data.fileToOpen === 'string' && data.fileToOpen) requestOpen({targets: [data.fileToOpen]});
    else handleArgv(argv, workingDirectory);
    const rec = focusedRec();
    if (rec) focusWindow(rec);
  });

  await app.whenReady();
  launcher=launcherFor(app);
  app.setAppUserModelId(launcher.id);
  // 诊断日志尽早装上：启动期出错最多，而打包后的用户手上没有任何可以交出来的东西。
  diagnostics.install({ userData: app.getPath('userData') });

  const { port, token } = await startServer({
    rendererRoot: RENDERER_ROOT,
    shellRoot: SHELL_ROOT,
    port: PREFERRED_PORT,
  });
  serverPort = port;
  resourceAuth = installResourceAuth(session.defaultSession, {port, token});

  // renderer 中 file:/// 图片会被 js/util.js 改写成 vscode-cdn 伪域名，重定向回本地服务
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['https://*.vscode-cdn.net/*'] },
    (details, callback) => {
      try {
        const u = new URL(details.url);
        const rest = u.pathname.replace(/^\//, ''); // 保持已编码形态，服务端解码一次
        if (rest) {
          callback({ redirectURL: `http://127.0.0.1:${port}/ws-file/${rest}` });
          return;
        }
      } catch { /* ignore */ }
      callback({});
    }
  );

  global.state = new AppState({onRecentChange: recent => {
    for (const rec of recs()) if (!rec.win.isDestroyed()) rec.win.webContents.send('recent-changed', recent);
    jumpList?.changed();
  }});
  // W7（一次性）：丢弃旧口径的窗口几何。旧 bounds / windows[].bounds 存的是「外框读回值」，
  // 在 150% 缩放下每次保存/恢复系统性 +4x4，累积量已无从反推用户的真实尺寸；「校正进
  // 工作区」只能挡越界、挡不住虚胖，直接归零回默认尺寸更诚实。新口径 clientBounds 从此
  // 稳定（保存/恢复同为 GetClientRect）。clientBoundsReset=2 是版本标记，防与未来迁移撞车。
  if (global.state.get('clientBoundsReset') !== 2) {
    global.state.set('bounds', null);
    global.state.set('clientBounds', null);
    const savedWindows = global.state.get('windows');
    if (Array.isArray(savedWindows)) {
      global.state.set('windows', savedWindows.map(item => item && typeof item === 'object'
        ? { ...item, bounds: null, client: null } : item));
    }
    global.state.set('clientBoundsReset', 2);
  }
  // 偏好损坏的提示**不在这里弹**：此刻还没有窗口，弹窗没有归属，验收用的对话框桩也还没装上。
  // 挪到窗口建好之后（见 main() 末尾），原始错误已经记在 global.state.loadError 里。
  jumpList=new JumpListController({app,state:global.state,launcher});jumpList.changed();
  let finishingJumpList=false;
  // 退出标记：只要开始退出（含"关掉最后一个窗口"触发的那次），关窗处理器就不再把窗口从会话里摘掉。
  app.on('before-quit', () => { quitting = true; });
  app.on('before-quit',event=>{
    if(!jumpList.needsFlush)return;
    event.preventDefault();if(finishingJumpList)return;finishingJumpList=true;
    jumpList.flush().catch(error=>console.error('Jump List:',error.message)).finally(()=>{finishingJumpList=false;app.quit();});
  });
  // 退出：先逐个窗口确认未保存（用户点取消就中止整个退出，已确认窗口的内容不丢），
  // 全部通过后给每个窗口打 closing 再走一次 app.quit()——那一轮各窗口的 close
  // 处理器不再弹框。与上面 jumpList 的 before-quit 用 quitChecking/quitConfirmed
  // 两个标记隔离，避免两个处理器互相打断成死循环。
  app.on('before-quit', event => {
    if (quitConfirmed) return;
    // R10 confirmDiscard（门2）：下面的脏窗口过滤同样看不见 200ms 去抖窗内的键入
    // （change 未推、dirty=false），「全部干净」直接放行退出会把那一拍丢掉。先挂起退出、
    // 逐窗口把渲染层活值落账（flushEditorText，失败/超时静默降级），再按落账后的脏态走
    // 既有确认循环。quitChecking/quitConfirmed 既有互锁不动；真干净时一样静默退出（负门），
    // 只是退出多一个两拍流程（挂起→落账→app.quit 二次放行）。
    event.preventDefault();
    if (quitChecking) return;
    quitChecking = true;
    (async () => {
      await Promise.all(recs().map(rec => rec.doc.current
        ? rec.doc.flushEditorText(rec.doc.current).catch(() => {}) : Promise.resolve()));
      const dirty = recs().filter(rec => rec.doc.dirty || rec.doc.current?.savePromise);
      for (const rec of dirty) {
        if (!(await rec.doc.confirmDiscard())) { quitChecking = false; return; }
      }
      quitConfirmed = true;
      for (const rec of recs()) rec.closing = true;
      persistWindows();
      global.state.saveNow();
      app.quit();
    })().catch(error => { console.error('quit confirm:', error.message); quitChecking = false; });
  });
  app.once('will-quit',()=>jumpList.dispose());

  // 渲染进程（编辑器 iframe）消息 → 发起消息那个窗口的文档控制器。只注册一次：
  // 以前这行在 createWindow 内部，多窗口下会重复注册、后一个窗口抢走所有消息。
  ipcMain.on('ed-msg', (event, message) => {
    const rec = recOfEvent(event);
    if (!rec) return;
    rec.doc.handleRendererMsg(event, message).catch((err) => console.error('ed-msg:', err));
  });

  registerIpc();

  // 打开入口：命令行文件 → 每文件一个窗口；没有则恢复上次的窗口；都没有就开欢迎窗口
  if (!pendingLaunch.length) restoreWindows();
  for (const item of pendingLaunch.splice(0)) {
    if (item.newFile) createWindow({newFile: true});
    else openPaths(item.targets).catch(reportOpenError);
  }
  if (!recs().length) createWindow({ws: global.state.get('lastWs') || null, maximized: !!global.state.get('maximized')});
  // 偏好文件损坏时**不再静默重置**：state.js 已经把现场另存了一份，这里告诉用户一声。
  // 不告诉的话，用户看到的是"最近打开、滚动位置、展开节点、偏好全没了"，而且
  // autoSave / snapshots 被悄悄翻回开启也无人知情。
  // 放在窗口建好之后：有窗口可挂、且主进程已经跑起来（对话框桩也就位了）。
  if (global.state.loadError) {
    dialog.showMessageBox(focusedRec()?.win || null, {
      type: 'warning',
      title: '偏好设置未能读取',
      message: '偏好设置文件损坏，已恢复为默认值',
      detail: `原因：${global.state.loadError}\n原文件已备份为：\n${global.state.corruptBackup || '(备份失败)'}\n\n`
        + '最近打开、滚动位置、展开节点与界面偏好会回到默认值；文档本身没有受影响。',
      buttons: ['确定'],
    }).catch(error => console.error('偏好损坏提示失败', error.message));
  }
  // 菜单在**窗口建好之后**再装：菜单项要从真实文档读状态（自动保存/本地快照的勾选、
  // 以及「切换补全模型…」这类只在本机开启 AI 补全时出现的项）。放在建窗口之前会读到
  // 空窗口，勾选值只能退化成硬编码默认值，和实际设置不一致（实测：设置里是关、菜单上
  // 却是勾着的，于是「点一下菜单」这种操作什么都改不到）。
  buildMenu();
  updateFileMenu();
  // 启动 3 秒后静默查一次更新：失败无声；仅有新版时用系统通知提醒一次，不打断输入。
  scheduleStartupCheck(() => focusedRec()?.win || null);
}

// ---------- 窗口 ----------
// W7：恢复用客户区尺寸的钳制与校验。宽高必须落进目标显示器的工作区：太小是数据坏了，
// 太大是带着历史漂移或换了小屏。四舍五入到整数 DIP。返回 null 表示没有可用值（回落默认）。
function sanitizeClientSize(saved) {
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return null;
  const probe = {
    x: Number.isFinite(saved.x) ? saved.x : 0,
    y: Number.isFinite(saved.y) ? saved.y : 0,
    width: Math.max(1, Math.round(saved.width)),
    height: Math.max(1, Math.round(saved.height)),
  };
  const area = screen.getDisplayMatching(probe).workArea;
  return {
    width: Math.min(Math.max(probe.width, WINDOW_MIN_WIDTH), area.width),
    height: Math.min(Math.max(probe.height, WINDOW_MIN_HEIGHT_FLOOR), area.height),
  };
}
function createWindow(options = {}) {
  // maximized 只由「会话恢复」与「启动时的欢迎窗口」显式传入；从打开文件/新建窗口
  // 拉起来的窗口一律按上一次的普通尺寸开窗。否则用户最大化过一个窗口之后，之后每开
  // 一个文件都是最大化，想开个小窗对比着看都做不到（Chrome / VS Code 也是这个行为）。
  const { file = null, ws = null, bounds = null, client = null, maximized = false, newFile = false } = options;
  const saved = bounds || global.state.get('bounds');
  // W7：尺寸真值改为「客户区」口径（保存/恢复都走 GetClientRect，不经过 Electron 的
  // 外框 frame 换算）。外框 saved 只用于定位，构造时的 width/height 仅为 pre-show 占位，
  // show 之后由下面的 enforceClientSize 断言校正。旧口径（保存 getNormalBounds 读回值）
  // 在 150% 缩放下读回 frame=18x40、创建却按 14x36 实现，每次启动 +4x4 棘轮。
  const savedClient = sanitizeClientSize(client || global.state.get('clientBounds'));
  const win = new BrowserWindow({
    width: saved ? saved.width : 1180,
    height: saved ? saved.height : 800,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    show: false,
    title: 'MarkPilot',
    icon: path.join(APP_ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true, // preload 进入编辑器 iframe
      spellcheck: false,
    },
  });
  // webContents 在窗口销毁后不可再访问（'closed' 里读 win.webContents 会抛
  // "Object has been destroyed"，主进程会弹出错误框并把进程卡住），所以 id 一次抓牢。
  const contentsId = win.webContents.id;
  const rec = {
    id: contentsId,
    win,
    doc: null,
    exporter: null,
    // 工作区是按根共享 watch 的（tree.js 的 watchHub），所以这里每窗口一个实例不会
    // 变成每窗口一个递归 watcher。
    workspace: new Workspace(root => { if (!win.isDestroyed()) win.webContents.send('tree-changed', { root }); }),
    queue: null,
    boot: { file, ws, newFile, maximized: !!maximized },
    closing: false,
    checkingClose: false,
  };
  windows.set(contentsId, rec);
  if (!primaryRec) primaryRec = rec;
  lastFocusedRec = rec;
  // 每个窗口一份打开队列：等这个窗口的外壳注册好 doc-load 监听再装载，避免
  // 「先推 doc-load、外壳还没监听」这个竞态（与 2.0.x 单窗口时同一套机制）。
  rec.queue = new FileOpenQueue(target => target?.type === 'new-md' ? createMarkdownFile(rec) : openPathSmart(target, {rec}));
  installWindowGuards(rec);
  rec.doc = new DocController({
    win,
    state: global.state,
    serverPort,
    onFileChange: () => { updateFileMenu(); persistWindows(); },
    workspaceRoot: () => rec.workspace.root,
    onPreferenceChange: (name, value) => broadcastPreference(name, value, rec),
  });
  rec.exporter = new DocumentExporter({win, doc: rec.doc, resourceAuth, rendererRoot: RENDERER_ROOT, shellRoot: SHELL_ROOT});

  win.loadURL(`http://127.0.0.1:${serverPort}/shell`);
  // W7：show 后校正客户区尺寸。断言式——永远写同一个持久值、从不把读回值写回，结构上
  // 不可能棘轮：60ms 一档校正 DWM 实现后的 frame 偏差；1200ms 终检兜住晚到的布局约束
  // （工具栏最小高度等，届时以最小值为准属正确行为）。±1px 视为 DIP/物理取整噪声放过。
  if (savedClient) {
    const enforceClientSize = () => {
      if (win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return;
      const live = win.getContentBounds();
      if (Math.abs(live.width - savedClient.width) > 1 || Math.abs(live.height - savedClient.height) > 1) {
        win.setContentBounds({ x: live.x, y: live.y, width: savedClient.width, height: savedClient.height });
      }
    };
    win.once('ready-to-show', () => { const t = setTimeout(enforceClientSize, 60); t.unref?.(); });
    const t2 = setTimeout(enforceClientSize, 1200); t2.unref?.();
  }
  return rec;
}

function installWindowGuards(rec) {
  const { win } = rec;
  resourceAuth.allow(win.webContents);
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  // 渲染进程的错误与崩溃也进同一份日志。它们是"用户看到白屏"的主要原因，而此前主进程完全
  // 不知情——页面里只有验收用的 __acc 记录，打包后的用户取不到。
  diagnostics.attach(win.webContents, {onGone: details => recoverFromRendererCrash(win, details)});
  // 鼠标侧键（X1/X2）在 Windows 上是 WM_APPCOMMAND，Electron 以 app-command 送进来。
  // 编辑面把每份文档都装进 #editor iframe，而每次 f.src = url 都会压一条会话历史，
  // 于是「后退」会把这个 iframe 导航回上一个文档页甚至空白页——用户实测表现为
  // 「整个页面消失，再点前进才拉回来」（2.0.18 反馈）。本应用没有浏览器式历史语义，
  // 一律吞掉，不做任何转发。多窗口下每个窗口都要装，不能只装第一个。
  win.webContents.on('app-command', (event, command) => {
    if (command === 'browser-backward' || command === 'browser-forward') event.preventDefault();
  });
  win.webContents.on('before-input-event', (event, input) => {
    // Alt+←/→ 是同一件事的键盘形态：不少鼠标驱动的侧键就是映射成这两个组合键的。
    if (input.type === 'keyDown' && input.alt && !input.control && !input.meta &&
        (input.key === 'Left' || input.key === 'Right')) {
      event.preventDefault();
      return;
    }
    if (input.type !== 'keyDown' || input.isComposing || input.shift ||
        !input.alt || !(input.control || input.meta) || input.key.toLowerCase() !== 'b') return;
    event.preventDefault();
    if (!input.isAutoRepeat) win.webContents.send('sidebar-toggle', {});
  });
  // 主框架永远不许离开本应用自己的源：拖入的 URL、页面里漏网的链接、系统级导航都在
  // 这里拦下。loadURL（打开外壳）不触发 will-navigate，所以启动路径不受影响。
  win.webContents.on('will-navigate', (event, url) => {
    try { if (new URL(url).origin === resourceAuth.origin) return; } catch { /* 非法 URL 一并拦 */ }
    event.preventDefault();
  });
  if(process.platform==='win32'&&app.isPackaged)win.setAppDetails({appId:launcher.id,relaunchCommand:commandLine([launcher.program,...launcher.args]),relaunchDisplayName:'MarkPilot',appIconPath:launcher.program,appIconIndex:0});
  // 窗口正在销毁时不再更新菜单/焦点记录（销毁中的 focus 事件什么都读不到）
  win.on('focus',()=>{ if(win.isDestroyed())return; lastFocusedRec=rec; jumpList?.focus(); updateFileMenu(); });
  if (rec.boot.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  // 窗口尺寸位置记忆（防抖）。bounds/maximized 是「下一个新窗口的默认值」，
  // 每个窗口自己的位置则记在会话记录里，重开时逐个还原。
  let saveBoundsTimer = null;
  // W7：这个窗口「已落账」的客户区尺寸。clientBounds 只吸收大于 4px 的变化（用户级
  // 调整）；≤4px 一律当换算噪声放过、不落账——任何残余的每启动 ±4 系统偏差都无法再
  // 逐次写进持久层，棘轮在保存侧被关死。位置恢复继续用外框 bounds（外框定位往返稳定）。
  let persistedClient = global.state.get('clientBounds') || null;
  const saveBounds = () => {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMinimized()) return;
      global.state.set('maximized', win.isMaximized());
      if (!win.isMaximized() && !win.isFullScreen()) {
        global.state.set('bounds', win.getNormalBounds());
        const live = win.getContentBounds();
        if (!persistedClient || Math.abs(live.width - persistedClient.width) > 4
            || Math.abs(live.height - persistedClient.height) > 4) {
          persistedClient = { x: live.x, y: live.y, width: live.width, height: live.height };
          global.state.set('clientBounds', persistedClient);
        }
      }
      persistWindows();
    }, 500);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // 关闭前处理未保存修改
  //
  // 会话记录（state.windows）的两条截然不同的语义，之前混在一起，导致**正常退出会清空会话**：
  //   · 用户关掉**若干个窗口中的一个**（还有别的窗口在）→ 这个窗口从会话里去掉，下次不再恢复；
  //   · 用户**退出应用**（文件→退出 / 关掉最后一个窗口）→ 会话必须原样留着，下次才回得来。
  // 旧代码对每个窗口一律 detachRec()，而退出时所有窗口都会走一遍 close，于是列表被逐条清空
  // （实测 probe-session-restore.cjs：正常退出后 state.windows 从 2 条变 0 条，重启只剩欢迎页；
  // 强杀反而能恢复——因为没走 close 处理器）。判据就是下面这两个条件。
  //
  // 但"用户关掉一个窗口"与"用户逐个把窗口全关掉（= 就是退出应用）"在关掉**第一个**窗口的
  // 当下长得一模一样，所以不能立刻把窗口从会话里删掉——那正是用户报的"开两个文件窗口 → 直接
  // 关掉应用 → 再打开，只有第一个文件回来"（逐个点 X 时每个窗口都被摘掉，最后只留下最后一个，
  // 而"哪一个活到最后"纯属偶然）。做法：先挂起（pendingDrops，带 5 秒宽限），宽限期到点应用
  // 还活着 → 确认这是"只关掉一个"，真正落盘删除；宽限期内应用退出了 → 全部撤销，一起回来。
  // 退出开始（quitting 或这是最后一个窗口）的那一刻把名单**冻结**：此后窗口一个个销毁会让
  // recs() 越缩越短，不冻的话写出去的就是半份名单（最后那个 'closed' 会写空）。
  const keepSession = () => quitting || recs().length <= 1;
  // 冻结名单的同时把宽限计时器停掉：退出可能要几秒（逐个窗口确认未保存），
  // 这期间定时器一响就会把刚挂起的窗口真正删掉——那正是"要一起回来"的那一个。
  const freezeSession = () => {
    if (!exitSession) exitSession = recs().map(sessionEntry);
    for (const item of pendingDrops) clearTimeout(item.timer);
  };
  win.on('close', (e) => {
    if (rec.closing) { if (!keepSession()) detachRec(rec); else { freezeSession(); persistWindows(); } global.state.saveNow(); return; }
    if(rec.checkingClose){e.preventDefault();return;}
    // R10 confirmDiscard（门1）：下面的脏判据（rec.doc.dirty）看不见渲染层 200ms 去抖窗内
    // 刚键入的文本（change 未推、dirty=false）——「看着干净」就同步放行关闭，那一拍键入
    // 静默丢失。所以先挂起关闭，把渲染层活值落账（flushEditorText，失败/超时按已知 dirty
    // 降级），再重估脏态：脏则走既有 checkingClose/confirmDiscard 流程，净则按原净路径
    // 收尾（closing/keepSession/persistWindows/saveNow + destroy）。rec.closing 与
    // checkingClose 的既有语义一字不动；干净文档不弹框（负门），只多一次 ms 级拉值。
    e.preventDefault();
    rec.checkingClose=true;
    (async () => {
      try { if (rec.doc.current) await rec.doc.flushEditorText(rec.doc.current); } catch { /* 按已知 dirty 继续 */ }
      if (rec.doc.dirty || rec.doc.current?.savePromise) {
        const ok = await rec.doc.confirmDiscard().catch(error => { console.error('close confirm:', error && error.message); return false; });
        rec.checkingClose=false;
        if (!ok) return;
      } else {
        rec.checkingClose=false;
      }
      rec.closing = true;
      if (!keepSession()) detachRec(rec); else { freezeSession(); persistWindows(); }
      global.state.saveNow();
      if (!win.isDestroyed()) win.destroy();
    })();
  });
  // 窗口已经销毁：从注册表里拿掉，但**不要**再算一次会话名单。退出流程走到这里时
  // recs() 可能已经是空的，现算会把会话写成空表（旧代码就是这行配合 400ms 防抖落盘，
  // 时机稍晚就把整份名单抹掉——这也是"只回来一个/一个都不回来"飘忽不定的来源）。
  // MW3：同时退订这个窗口的工作区递归 watch（tree.js 的 watchHub 按根引用计数，最后
  // 一个退订才真正关 watcher）。不退的话窗口全关后递归 watcher 仍挂在磁盘上空转，每次
  // 磁盘变更还会继续打点。文档自己的文件 watcher 由 DocController 的 closed 处理器关。
  win.on('closed', () => {
    try { rec.workspace.closeWatch(); } catch { /* 已销毁/未订阅 */ }
    windows.delete(rec.id);
  });
}

// 窗口离开注册表：从会话里去掉，避免下次启动又把它恢复出来。
// 去掉是**挂起**的（见 createWindow 里 close 处那段说明）：5 秒内如果应用退出了，
// 这次"去掉"作废——用户其实是逐个关窗口把应用关掉，窗口要一起回来。
const SESSION_DROP_GRACE_MS = 5000;
let pendingDrops = [];   // [{entry, timer}] 宽限期内待定的"用户关掉的窗口"
let exitSession = null;  // 退出流程开始时的会话快照（此后不再按 recs() 现算）
function sessionEntry(rec) {
  return {
    file: rec.doc?.file || rec.boot?.file || null,
    ws: rec.workspace.root || null,
    bounds: rec.win.isDestroyed() || rec.win.isMinimized() ? null : rec.win.getNormalBounds(),
    // W7：会话恢复同客户区口径（与主 bounds 一致的理由：外框读回含 frame 偏差）。
    client: rec.win.isDestroyed() || rec.win.isMinimized() ? null : rec.win.getContentBounds(),
    maximized: !rec.win.isDestroyed() && rec.win.isMaximized(),
  };
}
// 窗口离开注册表：从注册表与"当前聚焦"里立刻摘掉（界面上它确实没了），但会话名单
// 只是**挂起**删除：宽限期到点、应用还活着 → 落盘删掉；宽限期内应用退出 → 撤销。
function detachRec(rec) {
  const entry = rec.win.isDestroyed() ? null : sessionEntry(rec);
  windows.delete(rec.id);
  if (primaryRec === rec) primaryRec = recs()[0] || null;
  if (lastFocusedRec === rec) lastFocusedRec = null;
  if (entry) {
    const timer = setTimeout(() => {
      if (exitSession) return;   // 应用正在退出：这次"去掉"作废，名字要留在名单里
      pendingDrops = pendingDrops.filter(item => item.entry !== entry);
      persistWindows();
      global.state?.saveNow();
    }, SESSION_DROP_GRACE_MS);
    if (timer.unref) timer.unref();
    pendingDrops.push({entry, timer});
  }
  persistWindows();
  updateFileMenu();
}

// 工具栏最多占可视高度的 TOOLBAR_MAX_SHARE，据此换算窗口最小高度。工具栏的高度是
// **换行后实测**的值（窗口越窄它越高），所以这个最小高度会随宽度一起变：渲染层每次布局
// 变化都把「工具栏高度 + 量它的视口高度」一起报上来，这里就重算一次。
// 用渲染层给的视口高度（= 内容区减去状态栏）而不是窗口内容区，是为了和上面自动收纳用的
// 那条比值线严格同一个分母：这样「工具栏 ≤ 视口 80%」是精确成立的，不会因为状态栏那
// 二十来像素而实际占到 87%。上下都留了护栏：
//   · 不高于屏幕工作区（小屏上别把窗口顶出屏幕，那样更没法用）
//   · 不低于 320px（避免工具栏很矮时把最小高度压到没有意义的数值）
//   · 同时给一个最小宽度，免得窗口被压得极窄、工具栏换行到十几行
const TOOLBAR_MAX_SHARE = 0.8;
const WINDOW_MIN_HEIGHT_FLOOR = 320;
const WINDOW_MIN_WIDTH = 420;
function applyToolbarMinimum(rec, toolbarHeight, viewportHeight) {
  if (!rec || rec.win.isDestroyed()) return;
  if (!Number.isFinite(toolbarHeight) || toolbarHeight <= 0) return;
  const win = rec.win;
  const [, contentHeight] = win.getContentSize();
  const [, outerHeight] = win.getSize();
  // 窗口外框到渲染层视口的固定开销 = 标题栏/边框（外框−内容区）+ 状态栏（内容区−视口）。
  // 这两个都是固定高度，所以用当前窗口量出来的值去算目标高度是成立的。
  const inset = Number.isFinite(viewportHeight) && viewportHeight > 0
    ? Math.max(0, outerHeight - viewportHeight)
    : Math.max(0, outerHeight - contentHeight); // 老渲染层没带视口时的保守回退
  const needed = Math.ceil(toolbarHeight / TOOLBAR_MAX_SHARE) + inset;
  const workArea = screen.getPrimaryDisplay().workAreaSize.height;
  const minHeight = Math.max(WINDOW_MIN_HEIGHT_FLOOR, Math.min(needed, workArea - 40));
  const [, currentMinHeight] = win.getMinimumSize();
  const [currentMinWidth] = win.getMinimumSize();
  const minWidth = Math.max(WINDOW_MIN_WIDTH, currentMinWidth || 0);
  if (minHeight === currentMinHeight && minWidth === currentMinWidth) return;
  win.setMinimumSize(minWidth, minHeight);
}

function persistWindows() {
  if (!global.state) return;
  // 名单来源：退出流程里用**冻结**的那份（窗口正在一个个销毁，现算会越算越短）；
  // 平时按当前窗口现算，再加上宽限期内待定的那几个（它们可能马上要作废）。
  const live = exitSession || recs().map(sessionEntry);
  global.state.set('windows', live.concat(pendingDrops.map(item => item.entry)));
}

function restoreWindows() {
  const saved = global.state.get('windows');
  const list = Array.isArray(saved) ? saved : [];
  // MW2：会话里同一文件出现两份时只恢复一份（历史版本的"另存为撞他窗已开文件"曾把
  // 两份写进会话）。同一文件两个窗口会互相当外部变更，恢复几份都是坏状态；openPaths
  // 的打开规则同款——已在某窗口打开的文件不再开第二份。
  const seenFiles = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const file = typeof item.file === 'string' && fs.existsSync(item.file) ? item.file : null;
    const ws = typeof item.ws === 'string' && fs.existsSync(item.ws) ? item.ws : null;
    if (!file && !ws) continue;
    if (file) {
      const key = file.toLowerCase();
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);
    }
    createWindow({file, ws, bounds: item.bounds || null, client: item.client || null, maximized: !!item.maximized});
  }
}

function focusWindow(rec) {
  if (!rec || rec.win.isDestroyed()) return;
  lastFocusedRec = rec;
  if (rec.win.isMinimized()) rec.win.restore();
  rec.win.focus();
  updateFileMenu();
}

// app ready 之前收到的打开请求先存着，等窗口系统就绪再处理
function requestOpen(request) {
  if (!app.isReady() || !serverPort) { pendingLaunch.push(request); return; }
  if (request.newFile) createWindow({newFile: true});
  else openPaths(request.targets).catch(reportOpenError);
}

// ---------- 打开规则（2.1.0 多窗口的核心行为） ----------
// 一个文件一个窗口：已经在某个窗口打开的文件只聚焦那个窗口（同一文件两个窗口会
// 各自监视对方保存、互相当成外部变更，所以不给第二份）；**发起这次打开的那个窗口**
// 还停在欢迎页就填进去；否则新开一个窗口。目录则是切换发起窗口的工作区。
// rec 由调用方给出（外壳 IPC 传 event.sender 对应的窗口：用户在哪个窗口点的，动作
// 就属于哪个窗口；菜单/命令行则传聚焦窗口或 null）。
async function openPaths(paths, options = {}) {
  const list = [...new Set((paths || []).filter(p => typeof p === 'string' && p).map(p => path.resolve(p)))];
  if (!list.length) return false;
  const files = [], dirs = [], missing = [];
  for (const p of list) {
    let stat = null;
    try { stat = fs.statSync(p); } catch { /* 不存在 */ }
    if (!stat) missing.push(p);
    else if (stat.isDirectory()) dirs.push(p);
    else files.push(p);
  }
  if (missing.length && !options.quiet) reportOpenError(new Error('文件不存在：' + missing[0]));
  if (dirs.length) {
    const rec = options.rec || focusedRec() || createWindow({});
    openWorkspace(dirs[0], rec);
    return true;
  }
  if (!files.length) return false;
  if (files.length > MANY_WINDOWS && !options.quiet && !(await confirmManyWindows(files.length))) return false;
  for (const file of files) {
    const existing = recs().find(rec => rec.doc.file && rec.doc.file.toLowerCase() === file.toLowerCase());
    if (existing) { focusWindow(existing); continue; }
    const empty = emptyRec(options.rec);
    if (empty) { await empty.queue.request(file); continue; }
    createWindow({file});
  }
  return true;
}

async function confirmManyWindows(count) {
  const rec = focusedRec();
  const { response } = await dialog.showMessageBox(rec?.win, {
    type: 'question',
    title: '打开多个文件',
    message: `将打开 ${count} 个文件`,
    detail: `每个文件一个独立窗口（共 ${count} 个新窗口），继续？`,
    buttons: ['继续打开', '取消'],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
}

// 在指定窗口里打开文件（替换该窗口当前文档）；没给窗口就用聚焦窗口。
// 若无工作区则把文件所在目录设为工作区（Typora 行为）。
async function openPathSmart(p, {rec = null, ...options} = {}) {
  const st = fs.statSync(p);
  if (st.isDirectory()) return openWorkspace(p, rec || focusedRec());
  const target = rec || focusedRec();
  if (!target) return false;
  const opened = await target.doc.openFile(p, options);
  if (opened && (!target.workspace.root || !isInWorkspace(p, target))) openWorkspace(path.dirname(p), target);
  return opened;
}

async function createMarkdownFile(rec) {
  rec = rec || focusedRec() || createWindow({});
  const candidates=[rec.doc?.file&&path.dirname(rec.doc.file),rec.workspace?.root,global.state.get('lastWs'),app.getPath('documents')];
  const directory=candidates.find(dir=>{try{return dir&&fs.statSync(dir).isDirectory();}catch{return false;}})||app.getPath('home');
  return newMarkdown({win:rec.win,dialog,doc:rec.doc,directory,open:(file,options)=>openPathSmart(file,{rec,...options})});
}

function isInWorkspace(p, rec) {
  const root = (rec || focusedRec())?.workspace.root;
  if (!root) return false;
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function openWorkspace(dir, rec) {
  rec = rec || focusedRec() || createWindow({});
  dir = path.resolve(dir);
  if (rec.workspace.open(dir)) {
    global.state.set('lastWs', dir);
    global.state.pushRecent('recentFolders', dir);
    if (!rec.win.isDestroyed()) rec.win.webContents.send('ws-open', { root: dir });
    persistWindows();
    return true;
  }
  return false;
}

// 全局偏好（主题/阅读配色/快捷键）在 state 里存一份，一个窗口改了要让别的窗口跟上，
// 否则后台窗口还停在旧配色上。
function broadcastPreference(name, value, origin) {
  const channel = name === 'theme' ? 'theme-changed' : name === 'palette' ? 'palette-changed' : 'shortcuts-changed';
  for (const rec of recs()) {
    if (rec === origin || rec.win.isDestroyed()) continue;
    if (name === 'theme') rec.win.webContents.send('editor-theme', value);
    rec.doc.push(channel, value);
  }
}

// ---------- 命令行参数 ----------
function handleArgv(argv, cwd) {
  if(isNewFileLaunch(argv,{isPackaged:app.isPackaged})){requestOpen({newFile:true});return;}
  const targets = findLaunchPaths(argv, {isPackaged: app.isPackaged, appPath: app.getAppPath(), cwd});
  if (targets.length) requestOpen({targets});
}

function reportOpenError(error) {
  console.error('open file:', error);
  const rec = focusedRec();
  if (rec && !rec.win.isDestroyed()) {
    dialog.showMessageBoxSync(rec.win, {type: 'error', message: '无法打开文件', detail: error.message});
  }
}

// ---------- 菜单 ----------
function buildMenu() {
  const send = (channel, payload) => {
    const rec = focusedRec();
    if (rec && !rec.win.isDestroyed()) rec.win.webContents.send(channel, payload);
  };
  const settings = focusedRec()?.doc?.settings() || {autoSave:true,snapshots:true};
  const template = [
    {
      label: '文件(&F)',
      submenu: [
        { id:'new-markdown',label:'新建 Markdown 文件…',accelerator:'CmdOrCtrl+N',click:()=>createMarkdownFile().catch(reportOpenError) },
        { label:'新建窗口',accelerator:'CmdOrCtrl+Shift+N',click:()=>createWindow({ws:focusedRec()?.workspace.root||null}) },
        { label: '打开文件…', accelerator: 'CmdOrCtrl+O', click: () => chooseFile() },
        { label:'在此窗口打开文件…',click:()=>chooseFile(focusedRec(),{here:true}) },
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+Shift+O', click: () => chooseFolder() },
        { label: '最近打开…', accelerator: 'CmdOrCtrl+Alt+O', click: () => send('recent-open', {}) },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => { global.doc?.save(); } },
        { label:'另存为…',accelerator:'CmdOrCtrl+Shift+S',click:()=>global.doc?.saveAs() },
        { id:'auto-save', label:'自动保存', type:'checkbox', checked:settings.autoSave, click:item=>global.doc?.setSetting('autoSave',item.checked) },
        { id:'local-snapshots', label:'本地快照', type:'checkbox', checked:settings.snapshots, click:item=>global.doc?.setSetting('snapshots',item.checked) },
        { id:'version-history', label:'版本历史…', enabled:false, click:()=>send('snapshots-open',{file:global.doc?.file}) },
        {id:'file-export',label:'导出',enabled:false,submenu:exportMenuItems()},
        { type: 'separator' },
        { id: 'file-reveal', label: '打开文件所在文件夹', enabled: false, click: () => { if (global.doc?.file) shell.showItemInFolder(global.doc.file); } },
        { id: 'file-copy-path', label: '复制绝对路径', enabled: false, click: () => { if (global.doc?.file) return clipboard.writeText(global.doc.file); } },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口', accelerator: 'CmdOrCtrl+W' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑(&E)',
      submenu: [
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { label: '查找…', accelerator: 'CmdOrCtrl+F', click: () => global.doc?.push('find',false) },
        { label: '替换…', accelerator: 'CmdOrCtrl+H', click: () => global.doc?.push('find',true) },
        { label: '快捷键设置…', click: () => send('shortcut-settings', {}) },
        ...(global.doc?.completions.apiEnabled ? [
          { type: 'separator' },
          { label: '切换补全模型…', click: () => global.doc?.completions.pickProfile() },
          { label: 'AI 补全设置…', click: () => global.doc?.completions.configure() },
        ] : []),
      ],
    },
    {
      label: '查看(&V)',
      submenu: [
        { label: '主题（含 Konayuki）…', click: () => global.doc?.push('theme-settings', {}) },
        {
          label: '侧边栏',
          accelerator: 'CmdOrCtrl+Alt+B',
          click: () => send('sidebar-toggle', {}),
        },
        { role: 'toggleDevTools', label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I' },
        { role: 'reload', label: '重新加载界面', accelerator: 'CmdOrCtrl+R' },
        { type: 'separator' },
        // v2.0.7：不再用 Electron 的 resetZoom/zoomIn/zoomOut role——zoomIn 的
        // 加速键是 Ctrl+Plus（需 Shift），Windows 上按 Ctrl+= 永远不触发（用户
        // 报告"减号能缩、加号恢复不了"）。改为推送渲染层统一的内容缩放；键盘
        // 由渲染层接管（Ctrl+= / Ctrl+- / Ctrl+0），工具栏不再跟着缩放。
        { label: '放大（Ctrl+=）', click: () => global.doc?.push('zoom', { delta: 5 }) },
        { label: '缩小（Ctrl+-）', click: () => global.doc?.push('zoom', { delta: -5 }) },
        { label: '实际大小（Ctrl+0）', click: () => global.doc?.push('zoom', { set: 100 }) },
        { label: '缩放…', click: () => global.doc?.push('zoom', { open: true }) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏', accelerator: 'F11' },
      ],
    },
    {
      label: '帮助(&H)',
      submenu: [
        {
          id: 'help-about',
          label: '关于',
          click: () => {
            dialog.showMessageBox(focusedRec()?.win, {
              type: 'info',
              title: '关于 MarkPilot',
              // 版本号放进标题行（大字号），一眼可见；详情区只放描述与出处。
              message: `MarkPilot v${app.getVersion()}`,
              detail: aboutDetail(),
              buttons: ['确定'],
            });
          },
        },
        { label: '检查更新…', click: () => checkForUpdates(focusedRec()?.win, { interactive: true }).catch(error => console.error('检查更新:', error)) },
        { label: 'GitHub 仓库（帮助 / 反馈）', click: () => shell.openExternal(REPO_URL) },
        { type: 'separator' },
        { id: 'help-open-log', label: '打开诊断日志', click: () => openDiagnosticsLog() },
        { id: 'help-copy-log', label: '复制诊断信息', click: () => copyDiagnostics() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  updateFileMenu();
}

// 菜单项是否可用跟着**聚焦窗口**的文档走：Windows 的应用菜单是全局的，切窗口时
// 必须刷新，否则会出现「文档已经打开、菜单项还灰着」。
function updateFileMenu() {
  const menu = Menu.getApplicationMenu();
  const file = focusedRec()?.doc?.file || null;
  for (const id of ['file-reveal', 'file-copy-path','version-history','file-export']) {
    const item = menu?.getMenuItemById(id);
    if (item) item.enabled = !!file;
  }
}

function exportMenuItems() {
  return Object.entries(FORMATS).map(([format,label])=>({id:'export-'+format,label:label+'…',click:()=>{
    const rec = focusedRec();
    if (rec) rec.exporter.run(format);
  }}));
}

// ---------- 文件/文件夹选择 ----------
function showOpenDialog(rec) {
  const files = dialog.showOpenDialogSync(rec?.win, {
    title: '打开 Markdown 文件',
    properties: ['openFile','multiSelections'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] }, { name: '所有文件', extensions: ['*'] }],
  });
  return files || [];
}

// 「打开文件…」：多选时每个文件一个窗口；已在别的窗口打开的直接聚焦
// here=true 是菜单「在此窗口打开文件…」：**第一个文件在本窗口替换当前文档**
// （未保存会有确认框），其余文件仍按"一个文件一个窗口"处理。以前这个菜单项只把
// 聚焦窗口当"可复用的空窗口"传进去，实际效果和「打开文件…」一模一样——永远开新窗口，
// 与菜单项的承诺不符，也让"不想开新窗口"这条唯一入口失效（实测 probe-menu-battery M5）。
function chooseFile(rec, { here = false } = {}) {
  const target = rec || focusedRec();
  const files = showOpenDialog(target);
  if (!files.length) return;
  if (here && target && !target.win.isDestroyed()) {
    openPathSmart(files[0], { rec: target })
      .then(ok => (ok && files.length > 1) ? openPaths(files.slice(1)) : ok)
      .catch(reportOpenError);
    return;
  }
  openPaths(files).catch(reportOpenError);
}

function chooseFolder(rec) {
  const dirs = dialog.showOpenDialogSync((rec || focusedRec())?.win, {
    title: '打开文件夹',
    properties: ['openDirectory'],
  });
  if (dirs && dirs[0]) openWorkspace(dirs[0], rec || focusedRec());
}

// ---------- 外壳 IPC ----------
function registerIpc() {
  const h = (name, handler) => ipcMain.handle('shell:' + name, handler);
  h('new-file',event=>createMarkdownFile(recOfEvent(event)));
  const exportHandler = fn => (event,args) => {
    const rec = recOfEvent(event);
    const frame = event.senderFrame;
    if(!rec||!frame) throw new Error('不受信任的导出请求');
    const url = new URL(frame.url);
    if(url.origin !== resourceAuth.origin || !(url.pathname === '/shell' || url.pathname.startsWith('/doc/'))) throw new Error('不受信任的导出页面');
    return fn(args, rec);
  };
  h('export-menu',exportHandler((_args,rec)=>{Menu.buildFromTemplate(exportMenuItems()).popup({window:rec.win});return true;}));
  h('export',exportHandler((args,rec)=>rec.exporter.run(args?.format)));
  h('export-cancel',exportHandler((_args,rec)=>{rec.exporter.cancel();return true;}));
  h('export-open',exportHandler((args,rec)=>rec.exporter.openResult(args?.reveal)));
  // 渲染层「关于」弹窗只向宿主取产品信息（版本号绝不写死在界面里）。
  h('app-info',exportHandler(()=>({name:'MarkPilot',version:app.getVersion(),channel:distributionChannel()})));

  // 外壳启动时一次性取回本窗口的会话
  h('boot', async (event) => {
    const rec = recOfEvent(event);
    if (!rec) throw new Error('未知窗口的启动请求');
    const st = global.state;
    const reloading = rec.queue.started;
    await rec.queue.start(async () => {
      const {file, ws, newFile} = rec.boot || {};
      if (ws && fs.existsSync(ws)) openWorkspace(ws, rec);
      if (newFile) await createMarkdownFile(rec);
      else if (file && fs.existsSync(file)) await openPathSmart(file, {rec});
    });
    // A reloaded shell has new listeners; reattach the in-memory document without
    // rereading the file or discarding unsaved edits.
    if (reloading) rec.doc.loadInShell();
    persistWindows();
    return {
      port: serverPort,
      ws: rec.workspace.root,
      file: rec.doc.file,
      window: rec.id,
      ...st.recent(),
      sidebar: st.get('sidebar'),
      editorTheme: st.get('editorTheme'),
      expanded: st.get('expanded'),
    };
  });

  // 「打开」系列的语义：可能开新窗口（见 openPaths）。外壳点文件树、最近列表、
  // 拖入都用这个；返回值里 ok 决定外壳是否刷新高亮。
  h('open-file', async (event, { path: p }) => { const rec = recOfEvent(event); const ok = await openPaths([p], {rec}).catch(reportOpenError); return { ok: !!ok, file: rec?.doc.file || null }; });
  h('open-paths', async (event, { paths }) => { const ok = await openPaths(paths || [], {rec: recOfEvent(event)}).catch(reportOpenError); return { ok: !!ok }; });
  h('open-folder', async (event, { path: p }) => ({ ok: openWorkspace(p, recOfEvent(event) || focusedRec()) }));
  h('open-path', async (event, { path: p }) => {
    try { return { ok: await openPaths([p], {rec: recOfEvent(event)}) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  // 「在此窗口打开」：不动别的窗口，直接替换发起窗口的文档（也让自动化测试有确定入口）
  h('open-in-window', async (event, { path: p, newFile } = {}) => {
    const rec = recOfEvent(event) || focusedRec();
    if (!rec) throw new Error('未知窗口');
    if (newFile) return { ok: await createMarkdownFile(rec), file: rec.doc.file, window: rec.id };
    try { return { ok: !!await rec.queue.request(p), file: rec.doc.file, window: rec.id }; }
    catch (error) { return { ok: false, error: error.message, file: rec.doc.file, window: rec.id }; }
  });
  h('new-window', async (_e, { path: p = null, ws = null, newFile = false } = {}) => {
    const rec = createWindow({file: p, ws, newFile: !!newFile});
    return { id: rec.id };
  });
  h('windows-list', () => {
    const focused = BrowserWindow.getFocusedWindow();
    return recs().map(rec => ({
      id: rec.id,
      file: rec.doc.file,
      ws: rec.workspace.root,
      title: rec.win.getTitle(),
      dirty: rec.doc.dirty,
      focused: rec.win === focused,
      bounds: rec.win.getBounds(),
      maximized: rec.win.isMaximized(),
    }));
  });
  h('focus-window', (_e, { id }) => { const rec = recs().find(r => r.id === id); if (rec) focusWindow(rec); return !!rec; });
  h('close-window', async (event, { id } = {}) => {
    const rec = id ? recs().find(r => r.id === id) : recOfEvent(event);
    if (!rec) return false;
    rec.win.close();
    return true;
  });
  h('open-system', (_e, { path: p }) => { shell.openPath(p); return true; });
  h('choose-folder', (event) => { chooseFolder(recOfEvent(event)); return true; });
  h('choose-file', (event) => { chooseFile(recOfEvent(event)); return true; });

  h('tree-list', async (_e, { dir }) => ({ entries: await listDir(dir) }));
  h('tree-create', async (event, { parentDir, name, isDir }) => {
    const rec = recOfEvent(event);
    const created = await rec.workspace.createEntry(parentDir, name, !!isDir);
    return { path: created };
  });
  h('tree-rename', async (event, { from, name }) => {
    const rec = recOfEvent(event) || focusedRec();
    // MW1：重命名波及的可能是**任何**窗口打开的文档（A 窗在文件树里改名 B 窗正开着的
    // 文件）。只通知发起窗口的话，B 会把这份文档当成"外部失联"，Ctrl+S 还会在旧路径
    // 重建一份陈旧副本。先把所有窗口的在途保存等落定（保存与改名竞态会写空盘），再对
    // 全部窗口广播；onFileRenamed 自带路径匹配守卫，波及不到的窗口是空操作。
    for (const item of recs()) await item.doc.finishSave();
    const to = await rec.workspace.rename(from, name);
    global.state.updateRecentPath(from, to);
    for (const item of recs()) item.doc.onFileRenamed(from, to);
    persistWindows();
    return { path: to };
  });
  h('tree-delete', async (event, { path: p }) => {
    const rec = recOfEvent(event) || focusedRec();
    // MW1：删除同理——删除波及的文档要在所有窗口里标记失联，不只是发起窗口。
    for (const item of recs()) await item.doc.finishSave();
    await rec.workspace.trash(p);
    global.state.updateRecentPath(p, null);
    for (const item of recs()) item.doc.onFileDeleted(p);
    if (rec.workspace.root && !fs.existsSync(rec.workspace.root)) {
      global.state.set('lastWs', null);
    }
    return { ok: true };
  });
  h('tree-reveal', (event, { path: p }) => { (recOfEvent(event) || focusedRec()).workspace.reveal(p); return true; });
  // 删除确认。以前外壳用的是 `window.confirm()`——实测（probe-confirm.cjs）在 Electron 外壳页里
  // 它**恒返回 false 且什么都不弹**，于是文件树的「删除（回收站）」点了永远没反应（用户的日常操作）。
  // 改走主进程原生确认框：与"未保存修改""外部修改冲突"同一套，且自动化验收能脚本化回答。
  h('confirm-trash', (event, { name } = {}) => {
    const rec = recOfEvent(event) || focusedRec();
    const choice = dialog.showMessageBoxSync(rec?.win, {
      type: 'warning',
      title: '删除文件',
      message: `删除「${String(name || '').slice(0, 120)}」？`,
      detail: '移入回收站，可以恢复。',
      buttons: ['删除', '取消'],
      defaultId: 1,
      cancelId: 1,
    });
    return { ok: choice === 0 };
  });
  h('tree-copy', async (_e, { path: p }) => { await clipboard.writeText(path.resolve(p)); return true; });
  h('clipboard-write-text', async (_e, { text }) => {
    if (typeof text !== 'string' || text.length > 5000000) throw new Error('剪贴板文本过大');
    await clipboard.writeText(text); return true;
  });
  h('clipboard-read-text', () => clipboard.readText());

  h('save', async (event) => (recOfEvent(event) || focusedRec()).doc.save());
  const historyFile=(event,value)=>{
    const rec = recOfEvent(event) || focusedRec();
    const file = rec.doc.file;
    if(!file||value&&path.resolve(value).toLowerCase()!==path.resolve(file).toLowerCase())throw new Error('当前文件已切换，请重新打开版本历史');
    return {rec, file};
  };
  const historyHandler=fn=>async(event,args={})=>{try{const {rec,file}=historyFile(event,args.file);return await fn(rec,file,args);}catch(error){return{error:error.message};}};
  h('snapshots-list',historyHandler(async(rec,file,{id})=>id
    ? {file,id,...await rec.doc.snapshots.preview(file,id)}
    : {file,enabled:rec.doc.settings().snapshots,items:await rec.doc.snapshots.list(file)}));
  h('snapshots-restore',historyHandler(async(rec,file,{id})=>({path:await rec.doc.snapshots.restore(file,id)})));
  h('snapshots-reveal',historyHandler(async(rec,file)=>{const dir=await rec.doc.snapshots.reveal(file),error=await shell.openPath(dir);if(error)throw new Error(error);return{path:dir};}));

  h('recent-get', () => global.state.recent());
  h('shortcuts-get', () => global.state.get('editorShortcuts') || {});
  h('shortcuts-set', (event, value) => {
    if (!value || !['math', 'quote', 'code'].every(key => typeof value[key] === 'string' && value[key].length <= 80)) throw new Error('无效的快捷键设置');
    const shortcuts = {math: value.math, quote: value.quote, code: value.code,underline:typeof value.underline==='string'?value.underline:'Ctrl+U'};
    global.state.set('editorShortcuts', shortcuts);
    // 快捷键是全局偏好：所有窗口（含发起窗口）都要拿到新值
    broadcastPreference('shortcuts', shortcuts, null);
    return true;
  });

  h('state-set', (_e, { key, value }) => { global.state.set(key, value); return true; });
  h('sidebar-set', (_e, partial) => {
    const cur = global.state.get('sidebar');
    global.state.set('sidebar', { ...cur, ...partial });
    return true;
  });
  h('expanded-set', (_e, expanded) => { global.state.set('expanded', expanded); return true; });

  h('open-external', (_e, { url }) => { shell.openExternal(url); return true; });
  // 工具栏高度 → 窗口最小高度。渲染层每次布局后把**实测**的工具栏高度与量它的视口高度
  // 报上来（两者都随宽度换行而变），这里换算成最小高度：工具栏最多占视口高度的 80%。这样
  // 窗口再也不能被压到比工具栏还矮（实测过 116% 那种，正文一行都放不下），而 35% 以上
  // 仍然会自动收纳。
  h('toolbar-height', (event, { height, viewport } = {}) => {
    const rec = recOfEvent(event);
    if (!rec) return false;
    applyToolbarMinimum(rec, Number(height), Number(viewport));
    return true;
  });
}
