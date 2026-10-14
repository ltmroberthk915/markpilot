// MarkPilot — Electron 主进程（壳层）。
// 纪律：**引擎一行不改**——渲染进程加载的是 dsh-markpilot 的 CM6 bundle（scripts/sync-engine.mjs 只读同步），
// 壳只负责：窗口 / 文件读写（原子、保留 BOM 与行尾）/ 菜单 / 主题 / 外改探测 / 最近文件。
'use strict';
/* nativeImage 是「图片进剪贴板」的前置：普查实测漏了它 ⇒ 图片右键「复制图片」必然失败
   （nativeImage is not defined 被 try/catch 吞成 {ok:false}，用户看到"复制图片失败"）。 */
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme, net, clipboard, nativeImage } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
// 「导出为文件夹」的落盘实现：图片逐张复制进 assets/、HTML 分块流式写入（实现在 export-folder.js，纯 Node 可单测）
const exporter = require('./export-folder');
// 「导出为 PDF」的打印层：从磁盘上的本地 HTML 打印（隐藏窗口 + printToPDF + 分片写盘），实现在 export-pdf.js
const pdfExporter = require('./export-pdf');
const { DocumentStore, createSession, failure } = require('./shell/document-store');
const documents = new DocumentStore({
  prepareSaveAs: context => require('./shell/save-as-assets').prepareSaveAsAssets(context),
  // Deterministic receipt/race regressions; absent from normal launches.
  beforeReplace: async () => {
    const ms = process.env.MP_TEST_HOOKS === '1' ? Math.min(2000, Math.max(0, Number(process.env.MP_TEST_SAVE_DELAY_MS) || 0)) : 0;
    if (ms) await new Promise(resolve => setTimeout(resolve, ms));
  },
});

/* 【载入前禁写·2026-10-09】settings.json 在 `loadSettings()` 之前**不许被写**。
 *  起因：改名迁移把老设置拷进新 userData 后，`loadSettings()` 读到的却是应用默认值
 *  （诊断留痕：`settings:load {"bytes":332,"theme":"system","keys":["theme","recent","winBounds"]}`）——
 *  说明有写入者在载入之前用默认值把迁移来的文件覆盖掉了。逐点找写入者容易漏，
 *  改用**状态守卫**根治：载入完成前 `saveSettings()` 直接返回（并留痕一条，便于以后追）。
 *  这一条与"迁移"是配套的：只做迁移、不挡提前写盘，迁移就白做。 */
let settingsLoaded = false;

/* ── 【改名迁移·2026-10-09】产品名从 "MarkPilot CM6" 改成 "MarkPilot" ────────────────
 *  Electron 的 userData 目录是 `%APPDATA%\<产品名>` ⇒ 改名后从 `MarkPilot CM6` 变成 `MarkPilot`，
 *  老用户的 settings.json / recents.json 留在旧目录里——**不迁移就等于"设置全丢"**。
 *  策略（保守）：新目录里**没有** settings.json 而旧目录**有** ⇒ 整目录拷一次；
 *  **旧目录原样保留**（新版万一有问题，退回旧版本设置还在）。
 *  失败一律放行启动：迁移是便利，不是启动的前提。
 *  这一句必须在上面的 `SETTINGS` 常量**之前**执行（那个常量一取就定死了路径）。 */
(function migrateUserDataFromCm6() {
  try {
    const fsSync = require('node:fs');
    const newDir = app.getPath('userData');
    /* 源目录：默认 `%APPDATA%\MarkPilot CM6`。`MP_MIGRATE_FROM` 是**测试缝**——
       因为 Windows 上 Electron 的 `appData` 走 shell API、**不认 APPDATA 环境变量**，
       探针没法用改环境变量的方式隔离源目录（实测：改了 APPDATA 仍读到真实旧目录，
       于是"隔离测试"变成了"拿真实数据测"，期望值当然是错的）。 */
    const oldDir = process.env.MP_MIGRATE_FROM || path.join(app.getPath('appData'), 'MarkPilot CM6');
    if (path.resolve(oldDir) === path.resolve(newDir)) return;
    const settingsNew = path.join(newDir, 'settings.json');
    const settingsOld = path.join(oldDir, 'settings.json');
    if (fsSync.existsSync(settingsNew) || !fsSync.existsSync(settingsOld)) return;
    fsSync.mkdirSync(newDir, { recursive: true });
    fsSync.cpSync(oldDir, newDir, { recursive: true, force: false, errorOnExist: false });
    // 留一条可核对的痕：迁移从哪来、什么时候、**拷完之后 settings.json 是多少字节**
    // （最后这项是关键证据：若 loadSettings 读到的字节数与此不同，就说明"拷贝成功但被谁改写了"）
    let copiedSettingsBytes = -1;
    try { copiedSettingsBytes = fsSync.statSync(path.join(newDir, 'settings.json')).size; } catch { }
    fsSync.writeFileSync(path.join(newDir, 'migrated-from-cm6.txt'),
      `migrated from: ${oldDir}\nat: ${new Date().toISOString()}\ncopiedSettingsBytes: ${copiedSettingsBytes}\n`, 'utf8');
  } catch { /* 迁移失败不挡启动 */ }
})();

const SETTINGS = path.join(app.getPath('userData'), 'settings.json');
/** 应用图标（窗口/任务栏/关于框都用它；便携版内层 exe 资源改不了，窗口图标是最稳的一层）。 */
const APP_ICON = path.join(__dirname, 'build', 'icon.ico');

/* ── Windows 应用标识（AppUserModelID）──────────────────────────────────────
 * 安装版由 NSIS 写进开始菜单快捷方式、便携版与开发态没有快捷方式 ⇒ 三处必须自己落同一个 ID：
 * Windows 靠它把「最近使用的文档」与任务栏跳转列表算到这个应用名下（addRecentDocument 的前提），
 * 否则 shell 只能拿 exe 路径猜身份，同一个应用在不同形态下会变成好几个名字。
 * 取值与 build.appId 一致（package.json）。 */
const APP_USER_MODEL_ID = 'app.personal.markpilot.cm6';
function mpSetAppUserModelId() {
  try { app.setAppUserModelId(APP_USER_MODEL_ID); }
  catch (e) { dbg('aumid:set-failed', String(e && e.message || e)); }
  return APP_USER_MODEL_ID;
}

/* ── 最近打开（自持久化 MRU，最多 10 条）─────────────────────────────────────
 * 独立落一个 recents.json：它就是"文件 → 最近打开"的唯一真源（设置文件里不再留副本），
 * 验收脚本可以直接读盘对账「顺序 + 内容」，不必猜它藏在哪个字段里。
 * 口令（绝对路径、Windows 大小写不敏感去重、置顶、上限 10、菜单模型）在 shell/recents.js，
 * 那边是纯 Node、可单测；这里只负责"何时落盘、何时重建菜单、何时通知系统"。
 * 升级迁移：3.0.5 及更早把最近打开藏在 settings.json 的 recent 字段里，首启搬过来。 */
const recents = require('./shell/recents');
const RECENTS_FILE = path.join(app.getPath('userData'), 'recents.json');
const RECENT_LIMIT = recents.LIMIT;
const mpPathKey = recents.key;
const mpSaveRecents = (list) => recents.save(RECENTS_FILE, list);
/** 读清单 + 把"该落盘"的情况落一次（旧字段迁移 / 首次建文件）。 */
function mpLoadRecents() {
  const legacy = Array.isArray(state.settings.recent) ? state.settings.recent : [];
  const r = recents.load({ file: RECENTS_FILE, legacy });
  if (r.migrated || r.source === 'empty') {
    try { mpSaveRecents(r.list); }
    catch (e) { dbg('recents:init-save-failed', e.message); }
  }
  dbg('recents:loaded', { source: r.source, count: r.list.length });
  return r.list;
}
/** 记录/置顶一条：路径不存在不记（避免"打开过又删掉"的幽灵条目一进菜单就报错）。 */
function pushRecent(filePath) {
  const cur = Array.isArray(state.settings.recentFiles) ? state.settings.recentFiles : [];
  const r = recents.push(cur, filePath, null, RECENT_LIMIT);
  if (r.skipped) dbg('recent:skip', r.skipped, String(filePath));
  if (r.changed) {
    state.settings.recentFiles = r.list;
    try { mpSaveRecents(r.list); } catch (e) { dbg('recent:save-failed', e.message); }
  }
  if (r.skipped === 'missing') { buildMenu(); return; }   // 死条目照旧灰着，但要重建菜单
  // ① Windows「最近使用的文档」：Recent 文件夹里的 .lnk + 任务栏 Jump List 的"最近"一节
  try { app.addRecentDocument(r.list[0]); dbg('recent:addRecentDocument', r.list[0]); }
  catch (e) { dbg('recent:addRecentDocument-failed', e.message); }
  buildMenu();
}
/** 「清除最近记录」：应用内清单、系统 Recent 列表、以及设置文件里的旧副本一起清干净。 */
function clearRecent() {
  const n = Array.isArray(state.settings.recentFiles) ? state.settings.recentFiles.length : 0;
  state.settings.recentFiles = recents.clear().list;
  try { mpSaveRecents([]); } catch (e) { dbg('recent:clear-save-failed', e.message); }
  try { app.clearRecentDocuments(); } catch (e) { dbg('recent:clear-system-failed', e.message); }
  // 3.0.5 的旧副本（迁移来源）也清掉：留着的话下次启动会把已清除的条目又搬回来
  if (Array.isArray(state.settings.recent) && state.settings.recent.length) {
    state.settings.recent = [];
    saveSettings();
  }
  dbg('recent:cleared', n);
  buildMenu();
  if (win && !win.isDestroyed()) win.webContents.send('recent', { files: [] });
  return { ok: true, cleared: n };
}
/** 系统级的「最近」一节：只对真正注册过身份的安装版有意义（便携版没有开始菜单快捷方式，
 *  shell 会返回错误码 —— 如实记进日志，不抛给用户）。 */
function mpSyncJumpList() {
  try {
    const r = app.setJumpList([{ type: 'recent' }]);
    dbg('jumplist:set', { result: r, packaged: app.isPackaged });
    return r;
  } catch (e) { dbg('jumplist:set-failed', String(e && e.message || e)); return String(e && e.message || e); }
}

/** 诊断日志（仅当 MP_DEBUG=1 时写盘）：IPC 与文件流程的每一步都留痕，避免"猜时序"。 */
const DBG = !!process.env.MP_DEBUG;
const DBG_FILE = path.join(app.getPath('userData'), 'main-debug.log');
function dbg(...parts) {
  if (!DBG) return;
  try {
    fs.mkdirSync(path.dirname(DBG_FILE), { recursive: true });
    fs.appendFileSync(DBG_FILE, `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`);
  } catch { }
}

/** Application preferences are shared; each window owns its document session. */
const state = { ...createSession(), unresponsiveAt: 0, unresponsiveCount: 0, unresponsiveTotalMs: 0,
  settings: { theme: 'system', recent: [], recentFiles: [], winBounds: null, restoreLast: true, autosaveEnabled: false, autosaveIntervalMs: 30000 } };
const sessions = new Map();
function registerSession(wc, session) { sessions.set(wc.id, session); }
function unregisterSession(wc) { if (wc) sessions.delete(wc.id); }
function sessionOf(wc) {
  const S = wc && !wc.isDestroyed() && sessions.get(wc.id);
  if (!S) throw failure('MP_SESSION_CLOSED', '发起文档操作的窗口已关闭');
  return S;
}
function windowOf(e) {
  const W = e?.sender && BrowserWindow.fromWebContents(e.sender);
  if (!W || W.isDestroyed()) throw failure('MP_SESSION_CLOSED', '发起文档操作的窗口已关闭');
  sessionOf(e.sender); return W;
}
function activeWindow(candidate) {
  const W = candidate || BrowserWindow.getFocusedWindow() || win;
  return W && !W.isDestroyed() && sessions.has(W.webContents.id) ? W : null;
}
function sendTo(W, channel, payload) {
  if (!W || W.isDestroyed() || W.webContents.isDestroyed()) return false;
  W.webContents.send(channel, payload); return true;
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS, 'utf8');
    const parsed = JSON.parse(raw);
    Object.assign(state.settings, parsed);
    settingsLoaded = true;                                   // 从这里起 saveSettings 才允许写盘
    /* 【诊断·2026-10-09】把"读的是哪个文件、多大、读出了什么键"记一行。
       起因：改名迁移时报"设置没活下来"，而只看最终 settings.json 分不清
       "没读到文件"、"读到了但被覆盖"、"读到了但键名不对"——这三种修法完全不同。 */
    dbg('settings:load', { file: SETTINGS, bytes: raw.length, mtimeMs: (() => { try { return fs.statSync(SETTINGS).mtimeMs; } catch { return null; } })(), theme: state.settings.theme, keys: Object.keys(parsed).slice(0, 8) });
  } catch (e) {
    settingsLoaded = true;                                   // 首次运行：文件不存在也算"载入完成"
    dbg('settings:load-failed', { file: SETTINGS, error: String((e && e.message) || e) });
  }
}
/* 【设置真源·S3·基线·2026-10-10】原来这里是 `let lastSettingsWrite = null;` ✗ —— 它只在"本进程
   成功写入过"之后才被赋值 ⇒ **本会话第一次运行时写入**（例如用户改一项设置）时它还是 null
   ⇒ "运行期被外部改过"判不出来 ⇒ 覆盖前**不备份**（实测复现：手改 theme 后被抹成 system 且零备份 ✗）。
   现在**在模块初始化时就种下基线**（此刻磁盘上那份就是用户可能手改的起点）⇒ 之后任何一次写入
   只要发现 mtime/size 变了，就会先备份再覆盖 ✓。文件不存在时保持 null（首次写入不算外部改动 ✓）。 */
let lastSettingsWrite = (() => { try { return fs.statSync(SETTINGS); } catch { return null; } })();
function saveSettings() {
  /* 载入完成前一律不写（见文件头"载入前禁写"）：否则默认值会覆盖刚迁移进来的老设置。
     留痕一条，方便以后追"到底是谁想提前写"。 */
  if (!settingsLoaded) { dbg('settings:save-blocked', { stack: String(new Error().stack || '').split('\n').slice(1, 4).join(' | ') }); return; }
  try {
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
    /* 【设置真源·S3·2026-10-10（settings-truth 族）】运行期手改 settings.json：应用不重读（实测
       `settings:load` 计数 2→2 ✗），而**关窗时**这一次 saveSettings 会把内存整份写回 ⇒ 用户手改的
       字节被**静默抹掉** ✗。这里在覆盖之前先比对磁盘：盘上那份若与我们上次写入的记录不符 ⇒
       ①壳层留痕；②把**盘上那份**先另存为 `settings.json.bak-<时间戳>` 再覆盖 ⇒ 手改不会被无声吞掉。
       正常路径（没有外部改动）零额外开销、不产生备份文件。 */
    let external = false;
    try {
      const stNow = fs.statSync(SETTINGS);
      external = !!(lastSettingsWrite && (stNow.mtimeMs !== lastSettingsWrite.mtimeMs || stNow.size !== lastSettingsWrite.size));
    } catch { external = false; }        // 文件不存在（首次写入）不算外部改动
    if (external) {
      dbg('settings:external-change', { note: '覆盖前先备份', mtimeMs: Date.now() });
      try { fs.copyFileSync(SETTINGS, SETTINGS + '.bak-' + Date.now()); } catch { /* 备份失败不阻断保存 */ }
    }
    /* 【设置真源·S2·2026-10-10（settings-truth 族）】`recentFiles` 只是 `recents.json` 的**镜像**
       （启动时被 `mpLoadRecents()` 整段替换，main.js 里那句 `state.settings.recentFiles = mpLoadRecents()`），
       而 `recent` 是 3.0.5 及更早的旧键（只在迁移时读一次）⇒ 这两个字段写进 settings.json 只会让人
       以为"手改能生效"（普查实测：手改 `recentFiles` 等于没写 ✗）。二者**不再落盘** ⇒ 文件里不再有
       "看着能改、其实无效"的字段；运行时内存镜像与菜单模型不受影响（照旧由 recents.json 驱动）。 */
    const { recentFiles: _deadRecentFiles, recent: _deadRecent, ...persistable } = state.settings;
    fs.writeFileSync(SETTINGS, JSON.stringify(persistable, null, 2), 'utf8');
    try { lastSettingsWrite = fs.statSync(SETTINGS); } catch { /* 记录失败不影响保存结果 */ }
  } catch (e) {
    /* 【数据丢失修复·2026-10-10（corrupt-config A7）】原来是静默吞掉失败且**无返回值** ⇒
       只读 settings.json 时面板改设置"回执成功、磁盘没变、零提示"（OS 拒绝写入，用户以为存住了）。
       现在把失败**返回给调用者**并留痕，由 IPC 如实回报 ⇒ 用户看得见。 */
    dbg('settings:save-failed', { error: String((e && e.message) || e).slice(0, 160) });
    return { ok: false, error: String((e && e.message) || e) };
  }
  return { ok: true };
}

async function readDoc(filePath, S) {
  const doc = await documents.load(S, filePath); pushRecent(doc.filePath); return doc;
}
async function writeDoc(filePath, text, S, metadata) {
  return documents.save(S, { ...metadata, filePath, text });
}
let win = null;
const send = (channel, payload, W = activeWindow()) => sendTo(W, channel, payload);

/* 【S5 折中·2026-10-10（用户批准 ✓）】`send` 只发给**一个**窗口 ✗ ⇒ 改设置时其它已开窗口**不刷新** ✗
   （实测同一份设置下 A `zoom=1` 版心 525px ／ B `zoom=1.5` 版心 351px ✗）。这里补一个**广播**助手 ✓：
   全局观感类设置改完后发给**所有**窗口 ✓；视图类（缩放/滚动）**不广播** ✗ ⇒ 各窗口保持独立 ✓（折中 ✓）。 */
const sendAll = (channel, payload) => {
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send(channel, payload); } catch { /* 忽略单个窗口失败 */ }
  }
};

/** 「文件 → 最近打开」子菜单：最多 10 条，置顶者在前。
 *  文件被删/改名 ⇒ 该条**灰掉**（` (文件不存在)`），不弹错误框、也不静默消失
 *  ——用户看得见"它曾经在、现在没了"，而不是菜单莫名其妙少一项。 */
function recentMenuItems() {
  return recents.menuModel(state.settings.recentFiles || [], (p) => fs.statSync(p).isFile())
    .map((m) => (m.type === 'separator'
      ? { type: 'separator' }
      : {
        id: m.id, label: m.label, sublabel: m.sublabel, enabled: m.enabled,
        click: m.path ? () => { void openDocument(m.path); } : () => clearRecent(),
      }));
}

/* 真链路测试挂点：把菜单项自己的 click 记下来，验收脚本才能"按这个菜单项"而不是另写一条打开路径。
 * 只在 MP_TEST_HOOKS=1 时经 IPC 暴露（见下面的 recent:test-menu-click）。 */
const menuItemClicks = new Map();

/* ── 「文件位置」的路径显示宽度（task-15）──────────────────────────────────────
 * 【为什么要有这个常量】原生菜单**会为了放得下 label 而把自己撑宽**：实测把 122 字符的目录原样塞进
 * label，弹出的「文件」菜单从 465px 被撑到 **800px**（`before-longpath-menu.png`），既突兀、
 * 又会把「复制文件绝对路径」等项挤向屏幕边缘。Windows 原生菜单没有"缩略路径"这回事，
 * 所以**在壳层就把显示用的路径压到预算内**。
 * 【预算怎么定的】实测两档菜单宽度：短路径 465px / 未保存态 385px；减去图标与内边距，文字区约 **380px**。
 * 13px 字号下拉丁约 7px/字、中文约 13px/字 ⇒ 380/7 ≈ 54 个"拉丁字符宽"。取 **46** 留余量
 * （不逼近边缘，避免再被裁）。
 * 【只影响显示】复制值、`state.filePath`、外改探测一律仍用**完整绝对路径**（截断只发生在 label 文本上）。 */
const PATH_DISPLAY_BUDGET = 46;
const MP_ELLIPSIS = '\u2026';                     // …（单个字符；不要用 "..." 白占三位）
/** 路径的"显示宽度"：CJK/全角按 2 计，其余按 1 计 —— 中文路径不能按字符数算（会把菜单挤爆）。 */
function mpPathDisplayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6) ? 2 : 1;
  }
  return w;
}
/** 长路径压成**中段省略号**：保留 `盘符/根` + 末尾 1~2 段目录（例：`E:\MarkPilot\…\file-menu\fixture`）。
 *  · **短路不动**：整条已放得下、或**只剩最后一两段**时原样返回 —— 绝不出现 `E:\…\b` 这种
 *    "把有用的层次全抹掉"的形态（判据 3 明令禁止）；
 *  · **文件名不进 label**：它继续走 sublabel，这里只处理目录（判据 1）；
 *  · 保留的尾段优先取**末尾两段**（信息量最大），两段都放不下才退到一段。
 *  返回 { text, shortened, full }：`text` 是给菜单看的，`full` 永远是完整目录（复制/探测用它）。 */
function mpShortenDirForMenu(dir, budget = PATH_DISPLAY_BUDGET) {
  const full = String(dir || '');
  if (!full) return { text: '', shortened: false, full };
  if (mpPathDisplayWidth(full) <= budget) return { text: full, shortened: false, full };
  const sepIdx = Math.max(full.lastIndexOf('\\'), full.lastIndexOf('/'));
  if (sepIdx <= 0) return { text: full, shortened: false, full };          // 没有可省的层次
  const sep = full[sepIdx];
  const tail1 = full.slice(sepIdx + 1);                                    // 最后一段（目录名）
  /* 【根怎么取——这里踩过一次】根必须是**路径最前面那个锚**，不是"最后一段分隔符之前"：
   * 早先写成 `head.lastIndexOf(sep)`，对 `E:\a\b\c\d` 会得到 `root = "E:\a\b\"`，
   * 于是 `root + … + 尾段` 比原路径还长（实测 width=82 > 预算 46，L2/L5 变红）。
   * 正确口径：① 盘符形态（`E:` + 分隔符）取盘符；② UNC（`\\server\share\…`）取到 share；③ 其余取开头。 */
  const drv = /^([A-Za-z]:)[\\/]/.exec(full);
  let root, afterRoot;
  if (drv) { root = `${drv[1]}${sep}`; afterRoot = full.slice(drv[0].length); }
  else {
    const unc = /^(\\\\[^\\/]+[\\/][^\\/]+)[\\/]/.exec(full);
    if (unc) { root = `${unc[1]}${sep}`; afterRoot = full.slice(unc[0].length); }
    else { const i = full.search(/[\\/]/); root = i >= 0 ? full.slice(0, i + 1) : ''; afterRoot = i >= 0 ? full.slice(i + 1) : full; }
  }
  const segs = afterRoot.split(/[\\/]+/).filter(Boolean);
  const tail2 = segs.length >= 2 ? `${segs[segs.length - 2]}${sep}${segs[segs.length - 1]}` : tail1;   // 末尾两段
  const text2 = `${root}${MP_ELLIPSIS}${sep}${tail2}`;
  if (mpPathDisplayWidth(text2) <= budget) return { text: text2, shortened: true, full, keptSegments: 2 };
  const text1 = `${root}${MP_ELLIPSIS}${sep}${tail1}`;
  if (mpPathDisplayWidth(text1) <= budget) return { text: text1, shortened: true, full, keptSegments: 1 };
  // 连"根 + … + 最后一段"都放不下：按显示宽度硬砍尾段，但**保住根**（至少还看得出在哪个盘）
  const room = Math.max(4, budget - mpPathDisplayWidth(root) - mpPathDisplayWidth(MP_ELLIPSIS) - 1);
  let cut = '';
  for (const ch of tail1) { if (mpPathDisplayWidth(cut + ch) > room) break; cut += ch; }
  return { text: `${root}${MP_ELLIPSIS}${sep}${cut}`, shortened: true, full, keptSegments: 1, cut: true };
}

/* ── 「文件位置」与「复制文件绝对路径」（3.0.9 · 用户点名）──────────────────────
 * 【为什么要有 fileMenuModel 这个纯函数】菜单文案必须跟着当前文档走，而"当前文档"在主进程里
 * 只有一个真源 `state.filePath`。把"从路径算文案"抽成纯函数，一是**可单测**（不必起 Electron），
 * 二是让菜单项、测试挂点、加速键 click 三条路读**同一个来源**——不会出现"菜单显示 A、复制到 B"。
 * 【绝不能做的事】没有路径时**不许**退回窗口标题（那可能是"未命名"/"新建 Markdown 文档.md"），
 * 更不许复制空串：没有路径就是没有路径，文案与行为都要如实。 */
function fileMenuModel(filePath) {
  const p = typeof filePath === 'string' && filePath.trim() ? filePath : null;
  if (!p) {
    return {
      hasPath: false, dir: null, path: null,
      locationLabel: '文件位置：未保存（尚未指定文件）',
      copyLabel: '复制文件绝对路径（未保存，不可复制）',
      revealLabel: '在资源管理器中显示（未保存，不可用）',
    };
  }
  const abs = path.resolve(p);
  const dir = path.dirname(abs);
  const name = path.basename(abs);
  /* 显示用目录可能是**中段省略**过的（长路径）；`dir`/`path` 始终是完整值：
   * 复制、外改探测、`在资源管理器中显示` 一律用完整值 —— 截断只发生在菜单文案上。 */
  const shown = mpShortenDirForMenu(dir);
  return {
    hasPath: true, dir, path: abs,
    dirShown: shown.text, dirShortened: !!shown.shortened,
    locationLabel: `文件位置：${shown.text}`,
    locationSublabel: name,
    copyLabel: '复制文件绝对路径',
    revealLabel: '在资源管理器中显示',
  };
}
/** 菜单项的 label/enabled 一律从这里取（唯一来源）。 */
function currentFileMenuModel(W = activeWindow()) { return fileMenuModel(W ? sessionOf(W.webContents).filePath : null); }

/** 把「文件位置」这几项**就地**刷成当前文档的值。
 *  【为什么不能只靠 buildMenu 重建】实测：清空路径（Ctrl+N / 关闭文件）后**没有**任何东西重建菜单，
 *  「文件位置」还显示着上一份文档的目录（读数见 probe 的 stale 记录）。而 `menu-will-show` 在
 *  Windows 上对**应用菜单**并不可靠（它是弹窗/上下文菜单那一类事件）——所以这里做两件事：
 *  ① 主动就地改这两项的 label/enabled（不重建整个菜单，代价小、也不会打断正在打开的菜单）；
 *  ② 交给调用方决定要不要顺带 buildMenu()（用于「最近打开」那种整表变化的场景）。
 *  返回值是这次刷进去的模型，便于测试挂点直接断言"菜单上写的 == 状态里的"。 */
function refreshFileMenuItems() {
  const m = currentFileMenuModel();
  try {
    const menu = Menu.getApplicationMenu();
    if (menu) {
      const find = (items, id) => {
        for (const it of items || []) { if (it.id === id) return it; if (it.submenu) { const h = find(it.submenu.items, id); if (h) return h; } }
        return null;
      };
      const loc = find(menu.items, 'menu-file-location');
      if (loc) { loc.label = m.locationLabel; loc.sublabel = m.locationSublabel || ''; }
      const copy = find(menu.items, 'menu-copy-file-path');
      if (copy) copy.label = m.copyLabel;
      const reveal = find(menu.items, 'menu-reveal-in-explorer');
      if (reveal) { reveal.label = m.revealLabel; reveal.enabled = m.hasPath; }
    }
  } catch (e) { dbg('menu:refresh-failed', String((e && e.message) || e)); }
  return m;
}
/** 路径一变就叫一次：标题 + 「文件位置」两项 + 菜单挂点都跟着走。 */
/* 【文件多开·第 2 步·批 B0】参数化：默认值 = 原来的全局 state/win ⇒ **所有既有调用点原样可用**
   （单窗口行为逐字节不变）；批 B 的写入类处理器改成传自己窗口的会话后，
   「改哪个窗口的状态就刷哪个窗口的标题」才成立。菜单仍是应用级（refreshFileMenuItems/buildMenu 不动）。 */
function syncPathUi(S, W) {
  updateTitle(S, W);
  refreshFileMenuItems();
  // 「在资源管理器中显示」的 enabled 也随路径变；buildMenu 会把 menuItemClicks 重新登记一遍，
  // 保证测试挂点点到的永远是**当前生效的那份菜单**里的项。
  try { buildMenu(); } catch (e) { dbg('menu:sync-build-failed', String((e && e.message) || e)); }
}

/** 「复制文件绝对路径」：**主进程**写剪贴板。
 *  为什么不让渲染进程写：引擎有自己的剪贴板出口（复制图片/富文本），渲染侧一写就会与它抢焦点与内容；
 *  壳层要的只是"把路径放进去"，在拥有窗口的主进程里做最干净、也不经过任何页面脚本。
 *  没有路径时**不写**，给出可读原因（对话框），返回 'no-path' 让判据能区分"没复制"和"复制了空串"。 */
function copyCurrentFilePath(W = activeWindow()) {
  const m = currentFileMenuModel(W);
  if (!m.hasPath) {
    dbg('menu:copy-path:no-path');
    if (process.env.MP_TEST_NO_DIALOG !== '1') {
      dialog.showMessageBox(W, { type: 'info', title: '复制文件绝对路径', message: '当前文档还没有保存', detail: '请先保存（Ctrl+S）或另存为，再复制它的绝对路径。' }).catch(() => { });
    }
    return 'no-path';
  }
  try {
    clipboard.writeText(m.path);
    dbg('menu:copy-path', m.path);
    return m.path;
  } catch (e) {
    dbg('menu:copy-path:failed', String((e && e.message) || e));
    return `error:${(e && e.message) || e}`;
  }
}

function buildMenu() {
  const recents = recentMenuItems();
  const loc = currentFileMenuModel();
  const template = [
    {
      label: '文件',
      submenu: [
        { id: 'menu-new-document', label: '新建', accelerator: 'CmdOrCtrl+N', click: (_item, W) => send('menu', 'new', activeWindow(W)) },
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: (_item, W) => pickOpen(activeWindow(W)) },
        { label: '最近打开', submenu: recents },
        { type: 'separator' },
        // id 固定：真链路测试直接触发**这个菜单项自己的 click**（与用户点菜单同一条路）
        /* 【P1-5·2026-10-10 由"人类常用操作普查"查出】Ctrl+W 原来**完全无响应**：菜单模板里没有这一项、
     渲染侧也没有 beforeunload（普查用 CDP 与主进程注入两条通道各试多遍：进程存活、窗口数不变、
     文档原样）。补上标准的「关闭窗口」并给加速键 —— 加速键走主进程菜单体系派发，
     不依赖渲染侧是否持焦；`W.close()` 会走既有的关闭处理器（脏文档照旧弹三按钮框）。 */
  { id: 'menu-close-window', label: '关闭窗口', accelerator: 'CmdOrCtrl+W', click: (_item, W) => { const Wc = activeWindow(W); if (Wc) Wc.close(); } },
  { id: 'menu-save', label: '保存', accelerator: 'CmdOrCtrl+S', click: (_item, W) => send('menu', 'save', activeWindow(W)) },
        /* 【3.0.6 修掉的真缺陷】另存为必须和 Ctrl+S 一样**转给渲染进程**去执行。
         * 原实现直接在这里调 pickSaveAs()：它只问了一个目标路径、把主进程的 state.filePath 改了，
         * 渲染进程那边根本不知道 —— 文件**没落盘**、标题不变、"最近打开"也不会记；更糟的是
         * 主进程的路径已经变成新文件，下一次外改探测会拿新文件的 mtime 比旧文件，出现假"外部改动"。
         * 实测证据：按 Ctrl+Shift+S 后 main-debug.log 只有 `pickSaveAs:env`，没有 file:save/doc:saved。 */
        { id: 'menu-save-as', label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: (_item, W) => send('menu', 'saveAs', activeWindow(W)) },
    /* 【设置真源·S1·2026-10-10（settings-truth 族）】「恢复所有默认…」：用户删掉 settings.json 后
       **仍看到**工具岛透明度/版心/内容缩放/状态栏开关还在 ✗ —— 渲染侧偏好是另一套存储
       （localStorage 的 mp-pref-* / mp-surfaces / mp-reading* / editor-theme…）。这一项发命令给渲染侧，
       由 host.js 的 `case 'resetAll'` 一次清掉**全部 mp-\* 键**并重载 ⇒ 两套存储都能被一个动作覆盖。 */
    { id: 'menu-reset-all', label: '恢复所有默认…', click: (_item, W) => send('menu', 'resetAll', activeWindow(W)) },
        { type: 'separator' },
        // 导出为 PDF：壳层入口。渲染侧调 window.mpHost.exportPdf()（引擎侧的 ⋯ 菜单项以后走同一个名字）
        // （id 固定：真链路测试用主进程 CDP 触发这个原生菜单项本身，避免"截图看菜单"这种间接证据）
        { id: 'menu-export-pdf', label: '导出为 PDF…', accelerator: 'CmdOrCtrl+Shift+P', click: (_item, W) => send('menu', 'exportPdf', activeWindow(W)) },
        { type: 'separator' },
        /* ── 文件位置 / 复制文件绝对路径 / 在资源管理器中显示（3.0.9）────────────────────
         * 【动态性】菜单在启动时构建一次，而"文件位置"必须跟着**当前文档**走：这里的
         * `label/enabled` 都是 `fileMenuModel()` 在**每次 buildMenu() 时现算**的，而 buildMenu() 在
         * 打开/另存为/新建/关闭之后都会被调到（pushRecent 与 doc:saved/doc:path 链路上）。
         * 另外还有一道保险：`menu-will-show` 时重建一次，保证"菜单栏被点开的那一刻"一定是实时值。 */
        { id: 'menu-file-location', label: loc.locationLabel, enabled: false, sublabel: loc.locationSublabel || undefined },
        { id: 'menu-copy-file-path', label: loc.copyLabel, accelerator: 'CmdOrCtrl+Shift+C', enabled: true, click: (_item, W) => copyCurrentFilePath(activeWindow(W)) },
        { id: 'menu-reveal-in-explorer', label: loc.revealLabel, enabled: loc.hasPath, click: () => { const m = currentFileMenuModel(); if (m.hasPath) shell.showItemInFolder(m.path); } },
        { type: 'separator' },
        { label: '关闭文件', click: (_item, W) => send('menu', 'closeFile', activeWindow(W)) },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: (_item, W) => send('menu', 'undo', activeWindow(W)) },
        { label: '重做', accelerator: 'CmdOrCtrl+Y', click: (_item, W) => send('menu', 'redo', activeWindow(W)) },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '切换主题（深/浅）', accelerator: 'CmdOrCtrl+Shift+L', click: (_item, W) => send('menu', 'theme', activeWindow(W)) },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: (_item, W) => send('menu', 'zoomIn', activeWindow(W)) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: (_item, W) => send('menu', 'zoomOut', activeWindow(W)) },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: (_item, W) => send('menu', 'zoomReset', activeWindow(W)) },
        { type: 'separator' },
        { id: 'menu-reload-view', label: '刷新', accelerator: 'CmdOrCtrl+R', click: (_item, W) => { void reloadEditorView(W || activeWindow()); } },
        { role: 'toggleDevTools' }, { role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于 MarkPilot', click: () => dialog.showMessageBox(win, { type: 'info', title: '关于', message: `MarkPilot ${app.getVersion()}`, detail: `编辑内核：CodeMirror 6 + KaTeX\nElectron ${process.versions.electron} / Chromium ${process.versions.chrome}\nNode ${process.versions.node}` }) },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  // 挂点登记放在 setApplicationMenu 之后：登记的是**这次真正生效的那份菜单**里的项
  menuItemClicks.clear();
  const walk = (items) => {
    for (const it of items || []) {
      if (it.id && typeof it.click === 'function') menuItemClicks.set(it.id, it.click);
      if (it.submenu) walk(it.submenu.items);
    }
  };
  walk(menu.items);
  /* 保险丝：菜单栏被鼠标点开的那一刻再重建一次 —— 保证"文件位置"显示的一定是实时值，
   * 即便某条改路径的链路忘了调 buildMenu()（例如 doc:path 的边界分支）也不会显示陈旧目录。
   * 注意别在这儿无限递归：重建走的就是这个函数，若 buildMenu 再触发 menu-will-show 就死了；
   * 实测 menu-will-show 只由"菜单被打开"触发，重建本身不会打开菜单。 */
  if (!menu.__mpWillShowHooked) {
    menu.__mpWillShowHooked = true;
    menu.on('menu-will-show', () => { try { buildMenu(); } catch (e) { dbg('menu:will-show-rebuild-failed', String((e && e.message) || e)); } });
  }
}

async function pickOpen(W = activeWindow()) {
  if (!W) return { ok: false, error: '没有可用的编辑窗口' };
  const r = await dialog.showOpenDialog(W, { title: '打开 Markdown',
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'txt'] }, { name: '全部文件', extensions: ['*'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  return openDocument(r.filePaths[0]);
}
let testSaveAsIndex = 0;
async function pickSaveAs(S, W) {
  const request = documents.beginSaveAs(S);
  try {
    if (MP_TEST_HOOKS && process.env.MP_TEST_SAVE_AS_CANCEL === '1') return { ok: false, canceled: true };
    let file = process.env.MP_TEST_SAVE_AS;
    const documentId = request.documentId;
    // Only the owned quality launch may exercise deterministic dialog latency.
    if (MP_TEST_HOOKS && process.env.MP_TEST_SAVE_AS_PLAN) {
      const plans = JSON.parse(process.env.MP_TEST_SAVE_AS_PLAN), index = testSaveAsIndex++;
      const plan = Array.isArray(plans) ? plans[index] : null;
      if (plan?.filePath && typeof plan.filePath === 'string') file = plan.filePath;
      const ms = Math.min(5000,Math.max(0,Number(plan?.delayMs)||0));
      if (ms) { dbg('test:save-as-delay',{index,phase:'before-grant',ms}); await new Promise(resolve=>setTimeout(resolve,ms)); }
    }
    if (!file) {
      const r = await dialog.showSaveDialog(W, { title: '另存为', defaultPath: S.filePath || path.join(app.getPath('documents'), '未命名.md'), filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      file = r.filePath;
    }
    if (W.isDestroyed() || S.documentId !== documentId || S.saveAsRequest !== request.serial) return { ok: false, error: '选择路径期间文档或另存为操作已改变', code: 'MP_DOC_MISMATCH' };
    return await documents.grantSaveAs(S, file, request);
  } catch (e) { return { ok: false, error: e.message, code: e.code }; }
}
async function confirmReplace(S, W) {
  if (!S.dirty) return true;
  if (process.env.MP_TEST_NO_DIALOG === '1') return false;
  const r = await dialog.showMessageBox(W, { type: 'warning', buttons: ['放弃修改并打开', '取消'], defaultId: 1, cancelId: 1, message: '还有未保存的修改', detail: S.filePath || '未命名文档' });
  return r.response === 0 && !W.isDestroyed();
}

async function openPath(p, target = null) {   // 【文件多开·批 B2】target={win,session} 可指定落点；不传＝老行为
  dbg('openPath:start', p);
  const W = target?.win || activeWindow();
  if (!W) return { ok: false, error: '没有可用的编辑窗口' };
  const S = target?.session || sessionOf(W.webContents);
  if (pdfActive?.owner === W.webContents.id) return { ok: false, error: 'PDF 正在导出，请完成或取消后再打开文档', code: 'MP_EXPORT_BUSY' };
  if (!(await confirmReplace(S, W))) return { ok: false, canceled: true };
  try { dbg('openPath:target', { hasTarget: !!target, isPrimary: S === state, sessionPath: S.filePath || null, tag: S.__tag || null, wcId: (W && W.webContents) ? W.webContents.id : null }); } catch { }
  try {
    const doc = await readDoc(p, S);
    const { text, filePath } = doc;
    dbg('openPath:loaded', { filePath, len: text.length, lines: text.split('\n').length });
    try { dbg('doc:push:openPath', { to: (W && W.webContents) ? W.webContents.id : null, path: (filePath || '').split('\\').pop() || null }); } catch { }
    sendTo(W, 'doc', doc);
    syncPathUi(S, W);
    dbg('openPath:pushed');
    return { ok: true };
  } catch (e) {
    dbg('openPath:error', e.message);
    if (W && !W.isDestroyed() && process.env.MP_TEST_NO_DIALOG !== '1') {
      // 同步弹窗会把测试脚本卡住（模态框等人点）⇒ 桌面窗口在场时才弹；自动化用 MP_TEST_NO_DIALOG=1 免打扰
      dialog.showErrorBox('打开失败', `${p}\n\n${e.message}`);
    }
    // 顺手把这条死记录从 MRU 里摘掉（菜单里灰着的那一项下次重建就没了），但**不清系统 Recent**
    // ——用户可能只是把文件挪了个位置，系统列表里那条由他自己在资源管理器里处理。
    const d = recents.drop(state.settings.recentFiles || [], p, RECENT_LIMIT);
    if (d.changed) {
      state.settings.recentFiles = d.list;
      try { mpSaveRecents(d.list); } catch (err) { dbg('recent:prune-save-failed', err.message); }
      buildMenu();
    }
    return { ok: false, error: e.message };
  }
}

/* ── IPC：file:reload（「重新加载文件内容」的上行；3.1.0）────────────────────────
 * 【为什么必须有这条上行】引擎（src-cm6）没有任何读盘能力——0 处 require/process/fs，
 * 它只能通过 host.js 的 up/down 与宿主通信 ⇒ "重新读盘"只能由壳做。而既有的 file:openPath
 * **不能复用**：它走 readDoc()，而 readDoc 结尾会 pushRecent()（把当前文件再插一次 MRU），
 * 且它没有"未保存修改"的确认 ⇒ 语义是"打开"而不是"重载"。
 * 【与 openPath 的三点关键区别】
 *   ① **不 pushRecent**（重载不是"打开"，不该动最近记录，也不该重复置顶）；
 *   ② 脏文档**先确认**，默认按钮是「取消」（破坏性操作不设默认）；
 *   ③ 失败**不摘 MRU**（文件没坏、只是读不到；openPath 那条"摘死记录"的逻辑在这里是错的）。
 * 【并发】同一路径重入**复用上一次的 Promise**（见 reloads），不做任何自动重试。 */
const reloads = new Map();
async function reloadEditorView(W) {
  if (!W || W.isDestroyed()) return { ok: false, code: 'MP_SESSION_CLOSED' };
  const S = sessionOf(W.webContents), documentId = S.documentId;
  await documents.pending(S);
  if (W.isDestroyed() || documentId !== S.documentId) return { ok: false, code: 'MP_DOC_MISMATCH' };
  if (pdfActive?.owner === W.webContents.id) return { ok: false, error: 'PDF 正在导出，请完成或取消后再刷新' };
  if (S.dirty) {
    dbg('doc:reload-confirm', { wcId: W.webContents.id, documentId });
    if (process.env.MP_TEST_NO_DIALOG === '1') return { ok: false, canceled: true };
    const r = await dialog.showMessageBox(W, { type: 'warning', buttons: ['保存并刷新', '取消'], defaultId: 1, cancelId: 1, message: '还有未保存的修改', detail: '刷新前需要保存当前文档。' });
    if (r.response === 0 && !W.isDestroyed() && documentId === S.documentId) sendTo(W, 'menu', 'saveThenReload');
    return { ok: false, canceled: r.response !== 0 };
  }
  W.reload(); return { ok: true };
}
async function reloadDoc(opts, S, W) {
  const p = S.filePath;
  if (!p) return { ok: false, error: '当前文档没有路径，无法重新加载' };
  if (pdfActive?.owner === W.webContents.id) return { ok: false, error: 'PDF 正在导出，请先完成或取消', code: 'MP_EXPORT_BUSY' };
  const requestId = typeof opts.requestId === 'string' ? opts.requestId : null;
  const expected = { documentId: S.documentId, revision: S.revision, filePath: p, loadRequest: S.loadRequest };
  if (opts.documentId && (opts.documentId !== expected.documentId || opts.revision !== expected.revision || opts.filePath !== p)) return { ok: false, code: 'MP_DOC_MISMATCH', error: '文档版本已改变，重载已取消' };
  const pending = reloads.get(S);
  if (pending) return pending.requestId === requestId && pending.path === p ? pending.job : { ok: false, code: 'MP_RELOAD_BUSY', error: '正在读取当前文档' };
  const job = Promise.resolve().then(async () => {
    try {
      if (!(await confirmReplace(S, W))) return { ok: false, canceled: true, requestId };
      // Bounded test-only transport/IO delays make revision and response races
      // reproducible while retaining the actual handler and store adoption.
      const pauseForTest = async phase => {
        const key = phase === 'before-read' ? 'MP_TEST_RELOAD_READ_DELAY_MS' : 'MP_TEST_RELOAD_RESPONSE_DELAY_MS';
        const ms = process.env.MP_TEST_HOOKS === '1' ? Math.min(5000, Math.max(0, Number(process.env[key]) || 0)) : 0;
        if (!ms) return;
        dbg('test:reload-delay', { phase, requestId, filePath: p, documentId: S.documentId, ms });
        await new Promise(resolve => setTimeout(resolve, ms));
      };
      await pauseForTest('before-read');
      const doc = await documents.load(S, p, expected);
      const payload = { ...doc, loadKind: 'reload', requestId };
      await pauseForTest('after-adopt');
      syncPathUi(S, W); sendTo(W, 'doc', payload);
      return { ok: true, ...payload };
    } catch (e) { return { ok: false, error: e.message, code: e.code }; }
    finally { if (reloads.get(S)?.job === job) reloads.delete(S); }
  });
  reloads.set(S, { job, requestId, path: p }); return job;
}

/* ── 【文件多开·第 3 步·3b】会话工厂与新窗口打开 ──────────────────────────
   文档级字段单独放一个对象；应用级设置（settings/主题/缩放/最近记录）**故意不放进会话**，
   它们本来就该跨窗口共享。 */
function newSession() {
  return createSession();
}
/** 在新窗口里打开一个文件（OS 二次启动、菜单「在新窗口中打开」都走这里）。 */
async function openInNewWindow(filePath) {
  let createdWindow = null;
  try {
    const S = newSession();
    // Read before creating a renderer: an unreadable file leaves every existing
    // window intact and does not create an empty failed document.
    if (filePath) await readDoc(filePath, S);
    const W = createWindow(S);          // 3a 已参数化：窗口与会话一一对应
    createdWindow = W;
    try { S.__tag = 'newwin-' + Date.now(); dbg('newwin:session', { tag: S.__tag, isPrimary: S === state, wcId: W.webContents.id }); } catch { }
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer); W.removeListener('ready-to-show', ready); W.removeListener('closed', closed);
        W.webContents.removeListener('did-fail-load', failed);
        error ? reject(error) : resolve();
      };
      const ready = () => finish(), closed = () => finish(failure('MP_SESSION_CLOSED', '打开期间窗口已关闭'));
      const failed = (_event, code, description) => finish(failure('MP_WINDOW_LOAD', description || String(code)));
      const timer = setTimeout(() => { finish(failure('MP_WINDOW_LOAD', '编辑窗口启动超时')); if (!W.isDestroyed()) W.destroy(); }, 15000);
      W.once('ready-to-show', ready); W.once('closed', closed); W.webContents.once('did-fail-load', failed);
    });
    dbg('newwin:created', { filePath: filePath || null, sessions: sessions.size });
    return { ok: true, windowId: W.id, documentId: S.documentId };
  } catch (e) {
    if (createdWindow && !createdWindow.isDestroyed()) createdWindow.destroy();
    return { ok: false, error: String((e && e.message) || e), code: e.code };
  }
}
const documentOpens = new Map();
async function openDocument(filePath) {
  try {
    if (typeof filePath !== 'string' || !filePath) throw failure('MP_BAD_PATH', '没有指定文件路径');
    const canonical = await documents.canonical(filePath), key = documents.key(canonical);
    if (documentOpens.has(key)) return documentOpens.get(key);
    const job = (async () => {
      for (const W of BrowserWindow.getAllWindows()) {
        if (W.isDestroyed() || !sessions.has(W.webContents.id)) continue;
        const S = sessionOf(W.webContents);
        if (!S.filePath) continue;
        const identity = { documentId: S.documentId, filePath: S.filePath };
        const candidate = documents.key(await documents.canonical(identity.filePath));
        if (candidate !== key || W.isDestroyed() || S.documentId !== identity.documentId || S.filePath !== identity.filePath) continue;
        if (W.isMinimized()) W.restore(); W.show(); W.focus();
        pushRecent(S.filePath);
        return { ok: true, existing: true, windowId: W.id, documentId: S.documentId };
      }
      return openInNewWindow(canonical);
    })();
    documentOpens.set(key, job);
    try { return await job; } finally { if (documentOpens.get(key) === job) documentOpens.delete(key); }
  } catch (error) { return { ok: false, error: error.message, code: error.code }; }
}
function createWindow(session = state) {   // 【文件多开·第 3 步·3a】可指定会话；默认主会话 ⇒ 老行为
  /* 【S6·主窗口语义·2026-10-10（用户批准 ✓）】几何**只记主窗口** ✓：
     · 主窗口 ⇒ 沿用记住的几何 ✓（老行为 ✓）；
     · **非主窗口** ⇒ 用默认尺寸、**不继承**记住的位置 ✗（否则"第二个窗口把主窗口的位置顶掉"，
       看起来像 bug ✗）⇒ 由 `W.center()` 居中 ✓（本函数末尾统一处理 ✓）。 */
  const isPrimaryWin = session === state;
  const b = (isPrimaryWin && state.settings.winBounds) ? state.settings.winBounds : { width: 1180, height: 820 };
  const W = new BrowserWindow({
    width: b.width, height: b.height, x: b.x, y: b.y,
    minWidth: 640, minHeight: 420,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f2126' : '#ffffff',
    icon: APP_ICON,
    title: 'MarkPilot',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false, // 编辑器不该被后台节流（省电与本应用的"实时感"冲突）
    },
  });
  /* 【多窗口 trace·2026-10-10】每次建窗都留痕：会话是不是主会话、两个 id 各是多少。 */
  const __wcId = W.webContents ? W.webContents.id : null;
  try { dbg("newwin:trace", { winId: W.id, wcId: W.webContents.id, isPrimary: session === state, sessionPath: session.filePath || null, sessionsBefore: sessions.size }); } catch { }
  /* 【文件多开·第 1 步】主窗口会话＝全局 state（本步不改行为）；关闭时注销，避免 id 复用串台。 */
  try {
    registerSession(W.webContents, session);
    W.on("closed", () => {
  try { dbg("win:closed", { wcId: __wcId, remaining: BrowserWindow.getAllWindows().length, globalWinDestroyed: !win || win.isDestroyed(), sessionsLeft: sessions.size }); } catch { }
  /* 【多窗口·2026-10-10 实测】两条修复：
     ① 全局 win 重指到仍活着的窗口 —— 否则 send()/对话框/标题/菜单这些旧路径会打到**已销毁**的窗口；
     ② 用关窗前捕获的 id 注销会话 —— webContents 销毁后取不到 id，会话会泄漏（实测 sessionsLeft 停在 2）。 */
  try { if (!win || win.isDestroyed()) { const alive = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed()); win = alive.length ? alive[0] : win; } } catch { }
  try { if (__wcId != null) sessions.delete(__wcId); else unregisterSession(W.webContents); } catch { }
});
  } catch (e) { dbg("session:register-failed", String((e && e.message) || e)); }

  W.once('ready-to-show', () => W.show());
  W.on('focus', () => refreshFileMenuItems());
  // 键盘留痕（仅 MP_DEBUG=1）：加速键（Ctrl+Shift+S 之类）到底有没有进到窗口，只看界面看不出来。
  // 只在调试时挂，且只记按键本身，不干预事件。
  if (DBG) {
    W.webContents.on('before-input-event', (_e, input) => {
      if (/^[a-z]$/i.test(input.key || '') && (input.control || input.alt || input.meta)) {
        dbg('key', { key: input.key, control: !!input.control, shift: !!input.shift, alt: !!input.alt, type: input.type });
      }
    });
  }
  W.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 「无响应」埋点：Electron/Chromium 自己判定渲染进程卡住时会发 unresponsive，恢复时发 responsive。
  // 导出这种重活最容易触发它，所以把次数与总时长记下来，供实测报告直接引用（不靠肉眼猜"卡没卡"）。
  W.on('unresponsive', () => { state.unresponsiveAt = Date.now(); state.unresponsiveCount++; dbg('win:unresponsive'); });
  /* 【崩溃/被杀页留痕·2026-10-09】补这一条的原因：排查"8.5MB 文档滚到底渲染进程消失"时，
     现有埋点只能记"无响应"，**分不清"渲染进程真崩了"与"窗口被别人杀了/被抢锁回收了"**——
     而那次的真相恰恰是后者。有了这条，下次同类现象能一句话定性：
       reason='crashed'/'oom'/'killed'/'clean-exit' + exitCode + 当时的窗口标题（含文档名）。
     oom 是 Chromium 判定内存耗尽时给的 reason，正是我们要抓的那种。 */
  W.webContents.on('render-process-gone', (_e, details) => {
    state.renderGoneCount = (state.renderGoneCount || 0) + 1;
    state.lastRenderGone = { at: Date.now(), reason: details && details.reason, exitCode: details && details.exitCode, title: (() => { try { return W.getTitle(); } catch { return null; } })() };
    dbg('win:render-process-gone', state.lastRenderGone);
  });
  W.on('responsive', () => {
    if (!state.unresponsiveAt) return;
    const ms = Date.now() - state.unresponsiveAt;
    state.unresponsiveTotalMs += ms;
    state.unresponsiveAt = 0;
    dbg('win:responsive', { ms, count: state.unresponsiveCount });
  });
  /* 【S6·主窗口语义·2026-10-10（用户批准 ✓）】单槽只由**主窗口**写 ✓ —— 原来任何窗口的 resize/move 都写
     同一个 `winBounds` ✗ ⇒ 后动的窗口把先动的覆盖 ✗（实测 A `1000×700@40,60` → B `820×560@300,140`
     ⇒ 只剩一份 ✗）。非主窗口的几何不落盘 ✗（它每次都按默认尺寸居中 ⇒ 不需要记忆 ✓）。 */
  /* 【S6·非主窗口居中·2026-10-10（用户批准 ✓）】非主窗口用默认尺寸 ⇒ 位置也给它一个**明确**的落点：
     居中 ✓（否则落在系统默认位置，多开几个就叠在一起 ✗）。此时窗口还是 show:false ✓ ⇒ 不会看到跳动 ✓。 */
  if (!isPrimaryWin) { try { W.center(); } catch { /* 忽略 */ } }
  W.on('resize', () => { if (!W.isMaximized() && isPrimaryWin) state.settings.winBounds = W.getBounds(); });
  W.on('move', () => { if (!W.isMaximized() && isPrimaryWin) state.settings.winBounds = W.getBounds(); });
  W.on('close', async (e) => {
    const S = sessionOf(W.webContents);
    if (!S.dirty && !S.pendingSaves.size) { saveSettings(); return; }
    e.preventDefault();
    if (W.__closeWaiting) return;
    W.__closeWaiting = true;
    try {
      const documentId = S.documentId, revision = S.revision;
      await documents.pending(S);
      if (W.isDestroyed()) return;
      if (S.documentId !== documentId || S.revision !== revision) return;
      if (!S.dirty) { W.close(); return; }
      dbg('doc:close-confirm', { wcId: W.webContents.id, documentId, revision, filePath: S.filePath });
      const testResponse = MP_TEST_HOOKS && process.env.MP_TEST_CLOSE_RESPONSE;
      const r = testResponse && /^[012]$/.test(testResponse) ? { response: Number(testResponse) } : await dialog.showMessageBox(W, { type: 'warning', buttons: ['保存并退出', '不保存', '取消'], defaultId: 0, cancelId: 2, message: '还有未保存的修改', detail: S.filePath || '未命名文档' });
      if (W.isDestroyed() || S.documentId !== documentId || S.revision !== revision || r.response === 2) return;
      if (r.response === 0) {
        const intent = W.__pendingClose = { documentId, revision };
        sendTo(W, 'menu', 'save');
        setTimeout(() => { if (!W.isDestroyed() && W.__pendingClose === intent) W.__pendingClose = null; }, 8000).unref();
      } else W.destroy();
    } finally { W.__closeWaiting = false; }
  });

  /* 全局 win 保持指向"最新创建的窗口"：既有 50 处 win 引用因此无需改动；
     多窗口下凡是要精确落点的路径（openPath/doc 推送/标题）都已改成按会话取。 */
  win = W;
  return W;
}

// 单实例 + 命令行文件
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', (_e, argv) => {
    const p = argv.find((a) => /\.(md|markdown|mdx|txt)$/i.test(a));
    /* 【文件多开·3d·2026-10-10】第二个文件**在新窗口里打开** —— 用户最初报的「打开文件把当前窗口换掉」
       就是这条路径（系统里双击另一个 .md / 命令行再启一次）。
       同时修掉一条回归：改前这里是 `if (win) { if (W.isMinimized()) W.restore(); W.focus(); }`，
       而 `W` 在本作用域不存在（3a 的区块替换范围过大把这段一起改名了）⇒ 第二次启动会抛错。 */
    if (p) { void openDocument(p); return; }
    const alive = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
    if (alive.length) { const w2 = alive[alive.length - 1]; try { if (w2.isMinimized()) w2.restore(); w2.focus(); } catch { /* 忽略 */ } }
  });
  app.whenReady().then(() => {
    // ① 身份先落（安装版/便携版/开发态三处都走这一条，取值 = build.appId）
    const aumid = mpSetAppUserModelId();
    loadSettings();
/* 【设置真源·S4①·2026-10-10（settings-truth 族）】启动时把持久化的 `theme` 应用到**原生主题**。
   此前全仓 `themeSource` 零命中 ✗ ⇒ 重启后原生主题不跟随 `theme`；而 createWindow 的
   `backgroundColor` 用的是 `nativeTheme.shouldUseDarkColors`（main.js:747）⇒ 窗口底色可能
   与用户所选明暗相反（首启那一帧尤其明显）。这里在载入设置之后立刻设一次；非法值回落 'system'。
   注：`theme` 与 `editor-theme`（引擎配色 id）是**两条独立的轴** —— 后者在用户显式选过配色后优先 ✓。 */
try {
  const _t = String(state.settings.theme || 'system');
  nativeTheme.themeSource = (_t === 'dark' || _t === 'light') ? _t : 'system';
} catch { /* 忽略：原生主题设不上不该影响启动 */ }
    // ② MRU 就位：settings.json 里 3.0.5 的旧副本在这里搬到 recents.json
    state.settings.recentFiles = mpLoadRecents();
    createWindow();
    buildMenu();
    // ③ 任务栏跳转列表：让系统"最近"一节跟着本应用的最近打开走
    const jump = mpSyncJumpList();
    const argvAll = process.argv.slice(1);
    const argvFile = argvAll.find((a) => /\.(md|markdown|mdx|txt)$/i.test(a));
    dbg('ready', { argv: argvAll, argvFile: argvFile || null, aumid, packaged: app.isPackaged, userData: app.getPath('userData'), recents: state.settings.recentFiles, jumpList: jump });
    if (argvFile) openPath(path.resolve(argvFile));
    /* 【启动打开上次的文件·2026-10-10 用户要求】命令行没带文件、且设置为开 ⇒ 打开 MRU 第一条
       **仍然存在**的文件；一条都不在就保持空白文档（不弹错、不打扰）。
       设置项在「设置 → 启动」里可关（关掉即回到"每次开空白"的老行为）。 */
    else if (state.settings.restoreLast !== false) {
      const list = Array.isArray(state.settings.recentFiles) ? state.settings.recentFiles : [];
      const cand = list.find((p) => { try { return !!p && fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } });
      dbg("restore-last", { enabled: true, picked: cand || null, tried: list.slice(0, 3) });
      if (cand) openPath(cand);
    } else {
      dbg("restore-last", { enabled: false });
    }
  });
  app.on('window-all-closed', () => app.quit());
}

/* ── IPC：渲染进程（host.js）↔ 主进程 ── */
/* 【纪律】每个通道只能注册一次。Electron 对重复注册是**抛错**，而这里在模块加载期执行
 * ⇒ 主进程加载失败、窗口一片白，连日志都来不及写（实测踩过：加看门狗时多写一行
 * `handle('file:saveAs', …)` 就这样）。所以统一走 handle()：重复时明确说出是哪个通道。 */
const ipcChannels = new Set();
function handle(channel, handler) {
  if (ipcChannels.has(channel)) throw new Error(`IPC 通道重复注册：${channel}`);
  ipcChannels.add(channel);
  ipcMain.handle(channel, handler);
}
handle('app:info', () => ({ name: 'MarkPilot', version: app.getVersion(), platform: process.platform, versions: process.versions }));
// 健康读数：实测脚本用 CDP 从渲染进程读「无响应」次数/累计时长（不靠截图猜）
handle('app:health', () => ({
  unresponsiveCount: state.unresponsiveCount,
  unresponsiveTotalMs: state.unresponsiveTotalMs + (state.unresponsiveAt ? Date.now() - state.unresponsiveAt : 0),
  unresponsiveNow: !!state.unresponsiveAt,
  /* 渲染进程崩溃/被杀留痕（见 render-process-gone 埋点的说明）：0 次 = 这一进程没崩过。 */
  renderGoneCount: state.renderGoneCount || 0,
  lastRenderGone: state.lastRenderGone || null,
  uptimeMs: Math.round(process.uptime() * 1000),
}));
// 渲染进程启动后**主动拉**当前文档：主进程的 openPath 可能早于渲染进程注册监听而把 doc 消息丢掉（实测竞态）。
/* 【文件多开·第 2 步·批 A】文档读取按**发起窗口的会话**取（sessionOf 对未注册窗口保守回落到主会话，
   所以单窗口下行为与改前逐字节一致；多窗口时各读各的）。doc:ready 的推送也改成发给**发起窗口**。 */
handle('doc:current', e => { const S = sessionOf(e.sender); return S.filePath ? documents.metadata(S) : null; });
handle('doc:ready', e => {
  const S = sessionOf(e.sender);
  if (S.filePath && !S.dirty) sendTo(windowOf(e), 'doc', documents.metadata(S));
  return documents.metadata(S);
});
handle('view:reload', e => reloadEditorView(windowOf(e)));
handle('file:cancelCloseSave', e => {
  const W = windowOf(e), hadCloseIntent = !!W.__pendingClose;
  W.__pendingClose = null;
  dbg('doc:close-save-cancelled', { wcId: e.sender.id, hadCloseIntent });
  return { ok: true };
});
handle('file:open', e => pickOpen(windowOf(e)));
handle('file:openPath', (e, p) => openPath(p, { win: windowOf(e), session: sessionOf(e.sender) }));
handle('file:openDocument', (_e, p) => openDocument(p));
handle('win:openInNewWindow', (e, p) => openInNewWindow(p === undefined ? sessionOf(e.sender).filePath : p));
handle('file:reload', (e, opts) => reloadDoc(opts || {}, sessionOf(e.sender), windowOf(e)));

/* ── IPC：最近打开（「文件 → 最近打开」的数据面）──────────────────────────────
 *   · recent:list          当前 MRU（含 alive 标记：条目还在不在磁盘上）
 *   · recent:open          按路径打开并置顶（与菜单项同一条 openPath）
 *   · recent:clear         「清除最近记录」
 *   · recent:test-menu-click  真链路测试挂点（只有 MP_TEST_HOOKS=1 才注册）：
 *                             触发**菜单项自己的 click**，不是另写一条打开路径
 */
const MP_TEST_HOOKS = process.env.MP_TEST_HOOKS === '1';
const recentView = () => {
  const files = (state.settings.recentFiles || []).map((p, i) => {
    let alive = false; try { alive = fs.statSync(p).isFile(); } catch { alive = false; }
    return { index: i, path: p, name: path.basename(p), alive };
  });
  return { file: RECENTS_FILE, limit: RECENT_LIMIT, aumid: APP_USER_MODEL_ID, files };
};
handle('recent:list', () => recentView());
handle('recent:open', (_e, p) => openDocument(p));
handle('recent:clear', () => clearRecent());
if (MP_TEST_HOOKS) {
  dbg('test-hooks:on');
  // force=true：连"灰掉的项"也点（验证"菜单建好之后文件才被删"这条竞态：要点得动、但不许崩）
  handle('recent:test-menu-click', (e, id, force) => {
    dbg('test-menu-click', { id, force, forceType: typeof force });
    const click = menuItemClicks.get(String(id || ''));
    if (!click) return { ok: false, error: `没有这个菜单项：${id}`, ids: [...menuItemClicks.keys()] };
    const menu = Menu.getApplicationMenu();
    const find = (items, want) => {
      for (const it of items || []) {
        if (it.id === want) return it;
        if (it.submenu) { const hit = find(it.submenu.items, want); if (hit) return hit; }
      }
      return null;
    };
    const item = menu ? find(menu.items, String(id)) : null;
    if (item && item.enabled === false && !force) return { ok: false, error: '该菜单项已灰掉（不禁用模拟点击）', id: String(id), enabled: false };
    try { click(item, windowOf(e)); return { ok: true, id: String(id), forced: !!force, enabled: item ? item.enabled : null }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  /* 文件相关的菜单读数（3.0.9）：把「文件位置」等项的**实时** label/enabled 直接读出来，
   * 便于判据给"换文件前后"的逐字对比；同时把"重建菜单会不会丢掉实时性"这件事一起量到。 */
  handle('recent:test-file-menu', () => {
    const menu = Menu.getApplicationMenu();
    const find = (items, id) => {
      for (const it of items || []) {
        if (it.id === id) return it;
        if (it.submenu) { const hit = find(it.submenu.items, id); if (hit) return hit; }
      }
      return null;
    };
    const one = (id) => {
      const it = menu ? find(menu.items, id) : null;
      return it ? { id, label: it.label, enabled: it.enabled, sublabel: it.sublabel || null, accelerator: it.accelerator || null } : null;
    };
    const m = currentFileMenuModel();
    return {
      stateFilePath: state.filePath,
      /* `dir` / `path` 是**完整值**（复制与外改探测用的就是它们）；`dirShown` 是**菜单上真正显示的**
       * （长路径会被中段省略）。判据要能一次拿到两边，才能证明"显示省略了、复制仍完整"。 */
      model: {
        hasPath: m.hasPath, dir: m.dir, path: m.path,
        dirShown: m.dirShown || null, dirShortened: !!m.dirShortened,
        locationLabel: m.locationLabel, locationSublabel: m.locationSublabel || null,
      },
      items: { location: one('menu-file-location'), copy: one('menu-copy-file-path'), reveal: one('menu-reveal-in-explorer') },
    };
  });
  /* 真点击的挂点：直接调**菜单项自己的 click**（与用户点菜单同一条代码路径）。
   * 【为什么返回里要带 `clipboardText` 而不是靠 click 的返回值】实测：Electron 的
   * `menuItem.click()` 返回 `undefined`（它忽略回调的返回值）——所以"点了之后剪贴板里到底是什么"
   * 只能**自己去读**（`clipboard.readText()`），不能把 click 的返回值当成结果。 */
  handle('recent:test-copy-path', () => {
    const it = (() => {
      const menu = Menu.getApplicationMenu();
      const find = (items, id) => {
        for (const x of items || []) { if (x.id === id) return x; if (x.submenu) { const h = find(x.submenu.items, id); if (h) return h; } }
        return null;
      };
      return menu ? find(menu.items, 'menu-copy-file-path') : null;
    })();
    if (!it || typeof it.click !== 'function') return { ok: false, error: '没有找到 menu-copy-file-path 菜单项' };
    const ret = it.click();                                  // Electron 忽略返回值，这里只记录它
    const after = (() => { try { return clipboard.readText(); } catch { return null; } })();
    return { ok: true, returned: ret === undefined ? null : ret, menuEnabled: it.enabled, stateFilePath: state.filePath, clipboardText: after };
  });
  /* 把**当前生效的「文件」子菜单**原样弹出来（原生菜单，供桌面抓屏取证）。
   * 【为什么需要这条】CDP 拍不到原生菜单；Windows 上程序化打开菜单栏也不可用 —— 实测三条都被否掉：
   *   ① `sendInputEvent` 注入 Alt+F（单次与两段式）⇒ 不出现菜单弹窗（裸 Win32 找不到 #32768）；
   *   ② UI Automation 遍历窗口可访问性树 ⇒ 只有 2 个元素，没有「文件」菜单项（Electron 的菜单栏
   *      是自绘的非客户区，不在 UIA 树里）；
   *   ③ 合成鼠标点击菜单栏属于"接管鼠标"，本轮没有授权，不做。
   * 所以这里用 Electron 自己的菜单 API 弹出**同一批 MenuItem 对象**（同一个数组、同一些 click 回调），
   * 菜单上写的就是应用菜单里的实时文案。**口径**：它是"同一个子菜单的原生呈现"，
   * 不是"点了菜单栏上的文件"——判据里按这个口径记账，不冒充后者。 */
  handle('recent:test-popup-file-menu', (e, opts = {}) => {
    /* 取证用：临时把 state.filePath 换成另一个路径，好让菜单上用**这份**路径的文案（拍长路径/短路径
     * 都不必真去开文件）。只影响这一次 popup 的文案，用完立刻还原，不落盘、不碰最近记录。
     * 【判据用 `in` 不用 `!== undefined`】`page.evaluate` 传 `{ filePathOverride: null }` 时字段可能被当成
     * "缺省"而丢掉 —— 早先那版就是这么漏掉覆盖的（P5 读到的是**旧文档**的长路径标签）。"显式 null"与"没给" 必须分清。 */
    const prevPath = state.filePath;
    if (opts && 'filePathOverride' in opts) {
      state.filePath = opts.filePathOverride || null;
      try { refreshFileMenuItems(); } catch { /* 尽力而为 */ }
      dbg('test-popup:override', { to: state.filePath });
    }
    try { buildMenu(); } catch (e2) { dbg('test-popup:build-failed', String((e2 && e2.message) || e2)); }
    const appMenu = Menu.getApplicationMenu();
    const file = appMenu && appMenu.items.find((it) => it.label === '文件');
    if (!file || !file.submenu) return { ok: false, error: '没有找到「文件」子菜单' };
    const items = file.submenu.items;                      // ← 当前生效的那批 MenuItem（不是副本）
    const labels = items.map((it) => ({ id: it.id || null, label: it.label, enabled: it.enabled, type: it.type || 'normal' }));
    const w = BrowserWindow.fromWebContents(e.sender) || (win && !win.isDestroyed() ? win : BrowserWindow.getFocusedWindow());
    if (!w) return { ok: false, error: 'no-window' };
    /* 取证时把窗口挪到屏幕左上：`popup()` 在鼠标位置弹出，窗口贴右缘时菜单会被屏幕边裁掉
     * （第一轮实测：只露出一条边）。移动窗口不代表"点菜单栏"，只是给取证腾地方。 */
    if (opts.moveWindow) {
      try { w.setBounds({ x: Number(opts.x) || 60, y: Number(opts.y) || 60, width: w.getBounds().width, height: w.getBounds().height }); } catch { /* 尽力而为 */ }
    }
    const popup = Menu.buildFromTemplate(items.map((it) => (it.type === 'separator' ? { type: 'separator' } : it)));
    // Electron 的 popup 支持显式 x/y；给了就按坐标弹（取证可复现），没给就按默认（鼠标位置）
    const popts = { window: w };
    if (Number.isFinite(opts.popupX) && Number.isFinite(opts.popupY)) { popts.x = Math.round(opts.popupX); popts.y = Math.round(opts.popupY); }
    popup.popup(popts);
    dbg('test-popup-file-menu', { count: items.length, bounds: opts.moveWindow ? w.getBounds() : null, popts: { x: popts.x, y: popts.y } });
    const out = { ok: true, items: labels, bounds: w.getBounds(), popupAt: { x: popts.x || null, y: popts.y || null }, note: '用 Electron 菜单 API 弹出当前子菜单；这是"同一子菜单的原生呈现"，不是点击菜单栏' };
    if (opts && 'filePathOverride' in opts) {                 // 还原：覆盖只用于这一次弹菜单
      state.filePath = prevPath;
      try { syncPathUi(sessionOf(e.sender), w); } catch { /* 尽力而为 */ }
      out.restoredPath = prevPath;
    }
    return out;
  });
  handle('recent:test-menu-list', () => {
    const menu = Menu.getApplicationMenu();
    const find = (items, label) => {
      for (const it of items || []) {
        if (it.label === label) return it;
        if (it.submenu) { const hit = find(it.submenu.items, label); if (hit) return hit; }
      }
      return null;
    };
    const file = find(menu ? menu.items : [], '文件');
    const recent = file && file.submenu ? find(file.submenu.items, '最近打开') : null;
    const items = recent && recent.submenu ? recent.submenu.items : [];
    return {
      ids: [...menuItemClicks.keys()],
      items: items.map((it) => ({ id: it.id || null, label: it.label, enabled: it.enabled, type: it.type || 'normal' })),
      fileItems: (file && file.submenu ? file.submenu.items : []).map((it) => ({ id: it.id || null, label: it.label, enabled: it.enabled, accel: it.accelerator || null, type: it.type || 'normal' })),
    };
  });
  /* 诊断：从**主进程**注入一次按键（webContents.sendInputEvent）。
   * 用途：CDP 注入的键在 Electron 里既不触发加速键、也不落 before-input-event（实测），
   * 于是"加速键是不是好的"用 CDP 根本测不出来——只有主进程这条注入路径能把这个问题问清楚。 */
  /* 诊断：从**主进程**注入一次按键（webContents.sendInputEvent）。
   * 用途：CDP 注入的键在 Electron 里既不触发加速键、也不落 before-input-event（实测），
   * 于是"加速键是不是好的"用 CDP 根本测不出来——只有主进程这条注入路径能把这个问题问清楚。 */
  handle('recent:test-send-key', async (e, payload = {}) => {
    const w = BrowserWindow.fromWebContents(e.sender) || win;
    if (!w) return { ok: false, error: 'no-window' };
    /* 【为什么要先 focus，而且要**等到真的拿到焦点**】加速键是**窗口级**的：窗口没有系统焦点时，
     * 注入的键不触发菜单加速键，而是落进渲染进程（实测：剪贴板里出现 Chromium 自己的
     * `Chromium internal source URL` 口味 ⇒ 那次按键被页面当成普通选择复制处理了）。
     * `focus()` 是异步生效的，紧接着注入会输在时序上（实测同一份代码一次绿一次红）。
     * 真人按键本来也要求窗口在前台，所以这里等到 `isFocused()` 为真再注入——补前提，不是绕过判据。 */
    const wasFocused = w.isFocused();
    try { if (w.isMinimized()) w.restore(); w.show(); w.focus(); } catch { /* 尽力而为 */ }
    let waitedMs = 0;
    while (!w.isFocused() && waitedMs < 1500) { await new Promise((r) => setTimeout(r, 50)); waitedMs += 50; }
    const focused = w.isFocused();
    const input = { type: payload.type || 'keyDown', keyCode: payload.keyCode || 'S', modifiers: payload.modifiers || ['control', 'shift'] };
    try { w.webContents.sendInputEvent(input); w.webContents.sendInputEvent({ ...input, type: 'char' }); w.webContents.sendInputEvent({ ...input, type: 'keyUp' }); }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
    return { ok: true, input, wasFocused, focused, focusWaitedMs: waitedMs };
  });
}
// 看门狗：任何被包住的 IPC 调用超过 8 秒没回来就记一笔（含 IPC 名与已等时长）。
// 这不是业务逻辑，是**诊断留痕**：自动化里"某条通道挂着不回来"最难查（实测：原生「另存为」框
// 没人点 ⇒ 那条 invoke 永远不回 ⇒ 整轮静默挂死），日志里必须先有它。
// 【纪律】同一个通道只能注册一次：这里包了就不能再写一行 ipcMain.handle（会
// "Attempted to register a second handler" 直接让主进程加载失败、窗口一片白）。
const ipcSlowness = new Set();
function watchIpc(channel, handler) {
  ipcMain.handle(channel, async (e, ...args) => {
    const t0 = Date.now();
    const timer = setTimeout(() => { if (!ipcSlowness.has(channel)) { ipcSlowness.add(channel); dbg('ipc:slow-start', { channel, waitedMs: Date.now() - t0 }); } }, 8000);
    try { return await handler(e, ...args); }
    finally { clearTimeout(timer); if (ipcSlowness.delete(channel)) dbg('ipc:slow-end', { channel, ms: Date.now() - t0 }); }
  });
}
watchIpc('file:saveAs', e => pickSaveAs(sessionOf(e.sender), windowOf(e)));
handle('file:requestSave', e => { sendTo(windowOf(e), 'menu', 'save'); return { ok: true }; });
handle('file:save', async (e, { filePath, text, ...metadata }) => {
  try {
    if (metadata.automatic && state.settings.autosaveEnabled !== true) return { ok: false, code: 'MP_AUTOSAVE_DISABLED' };
    const S = sessionOf(e.sender);
    const owner=e.sender;
    const r = await writeDoc(filePath, text, S, { ...metadata, ownerCurrent:()=>!owner.isDestroyed()&&sessions.get(owner.id)===S });
    if (r.current) syncPathUi(S, windowOf(e));
    dbg('file:save', { filePath, bytes: r.bytes });
    return r;
  }
  catch (e) { dbg('file:save:error', { filePath, error: e.message }); return { ok: false, error: e.message, code: e.code }; }
});
handle('file:stat', async (_e, p) => { try { const st = await fsp.stat(p); return { ok: true, mtimeMs: st.mtimeMs, size: st.size }; } catch (e) { return { ok: false, error: e.message }; } });
handle('file:exists', async (_e, p) => { try { await fsp.access(p); return true; } catch { return false; } });
// 读本地文件为 base64：导出公式排版要把 KaTeX 字体内联进导出件，而 Chromium 禁 fetch(file://)
// ⇒ 本地资源一律走宿主 fs 通道（asar 感知），与「导出为文件夹」复制图片是同一条设计。
/* ── 图片策略（3.1.0）：选文件 / 读字节 / 落 assets / 从浏览器抓图 ────────────────
 * 接口与 dsh-markpilot（引擎侧）书面敲定，名字与形状不另起一套：
 *   image:pick          选图（单/多选）⇒ 绝对路径列表
 *   file:readBase64     既有通道，**补 mime**（bytes 本来就有）
 *   image:saveToAssets  srcPath 或 base64 二选一 ⇒ 落 <文档目录>\assets\ ⇒ 相对路径
 *   image:base64ToFile  纯 base64（"抽出到 assets"用）⇒ 临时文件 ⇒ 绝对路径
 *   image:download      从浏览器打开：**主进程代取**（渲染进程零网络，connect-src 保持 'none'）
 * 上限的用意：图片是二进制大件，绝不能让"整份塞进渲染进程内存"变成默认路径。
 * 失败一律**返回可读原因 + code**，不抛异常、不弹模态框、不静默。 */
const IMG_MAX_BYTES = 32 * 1024 * 1024;          // 单张硬上限 32 MiB
const IMG_EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff',
};
const imgMimeOf = (p) => IMG_EXT_MIME[String(path.extname(String(p || '')).slice(1).toLowerCase())] || 'application/octet-stream';
/** 把 fs 错误翻成人话（带 code，便于上游判类型）。 */
function imgFsError(e, p) {
  const code = (e && e.code) || null;
  const map = {
    ENOENT: '文件不存在', EACCES: '没有读取权限', EPERM: '系统拒绝了这次操作', EISDIR: '这是一个目录，不是图片',
    ENOSPC: '磁盘空间不足', EBUSY: '文件被其它程序占用', EEXIST: '目标文件已存在',
  };
  return { ok: false, error: `${map[code] || '读取失败'}：${p}${code ? `（${code}）` : ''}`, code };
}
/** 文件名净化：只留 basename，砍掉任何路径成分与危险字符（引擎给的名字不可信）。 */
function imgSafeName(name, fallback = 'image.png') {
  const base = path.basename(String(name || '')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return base && base !== '.' && base !== '..' ? base.slice(0, 120) : fallback;
}
const imgSha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
/** 原子写：临时文件 + rename（assets 里的图不该出现半截文件）。 */
async function imgAtomicWrite(target, buf) {
  const tmp = `${target}.mp-tmp-${process.pid}-${crypto.randomUUID()}`;
  try { await fsp.writeFile(tmp, buf, { flag: 'wx' }); await fsp.rename(tmp, target); }
  finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
}
/** Stage all bytes first; exclusive copy never replaces an existing asset. */
async function imgExclusiveWrite(target, buf) {
  const tmp = `${target}.mp-tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fsp.writeFile(tmp, buf, { flag: 'wx' });
    await fsp.copyFile(tmp, target, fs.constants.COPYFILE_EXCL);
  } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
}
/** 先 stat 再读：超过上限**根本不读进内存**（这是"大文件别塞内存"的落点）。 */
async function imgReadCapped(p) {
  const st = await fsp.stat(p).catch((e) => { throw Object.assign(e, { __img: imgFsError(e, p) }); });
  if (!st.isFile()) return { ok: false, error: `这是一个目录，不是图片：${p}`, code: 'EISDIR' };
  if (st.size > IMG_MAX_BYTES) {
    return { ok: false, error: `图片过大：${p} 有 ${(st.size / 1048576).toFixed(1)} MB，超过单张 ${IMG_MAX_BYTES / 1048576} MB 上限`, code: 'E_TOO_LARGE', bytes: st.size };
  }
  const buf = await fsp.readFile(p);
  return { ok: true, buf, bytes: buf.length, mime: imgMimeOf(p) };
}
/** 落盘到 <文档目录>/assets/ 并回相对路径（重名去重规则由引擎定、这里执行）：
 *  同名 + 字节相同 ⇒ 复用已有文件；同名 + 字节不同 ⇒ a-1.png、a-2.png… */
async function imgSaveToAssets({ docPath, srcPath, base64, mime, fileName } = {}) {
  if (!docPath || typeof docPath !== 'string') return { ok: false, error: '缺少 docPath（不知道文档在哪，无法决定 assets 落点）' };
  const docDir = path.dirname(path.resolve(docPath));
  const assetsDir = path.join(docDir, 'assets');
  let buf = null, from = null;
  if (srcPath && typeof srcPath === 'string') {
    const r = await imgReadCapped(srcPath).catch((e) => (e && e.__img) || { ok: false, error: String((e && e.message) || e) });
    if (!r.ok) return r;
    buf = r.buf; from = srcPath;
  } else if (typeof base64 === 'string' && base64) {
    buf = Buffer.from(base64, 'base64');
    if (!buf.length) return { ok: false, error: 'base64 解出来是空的（传入内容可能被截断）' };
    if (buf.length > IMG_MAX_BYTES) return { ok: false, error: `图片过大：${(buf.length / 1048576).toFixed(1)} MB，超过单张 ${IMG_MAX_BYTES / 1048576} MB 上限`, code: 'E_TOO_LARGE' };
    from = '(base64)';
  } else {
    return { ok: false, error: 'srcPath 与 base64 必须给一个' };
  }
  const fallbackExt = (Object.keys(IMG_EXT_MIME).find((k) => IMG_EXT_MIME[k] === mime) || 'png');
  const wantName = imgSafeName(fileName || (srcPath ? path.basename(srcPath) : `image-${Date.now()}.${fallbackExt}`), `image-${Date.now()}.${fallbackExt}`);
  const ext = path.extname(wantName);
  const stem = ext ? wantName.slice(0, -ext.length) : wantName;
  try {
    await fsp.mkdir(assetsDir, { recursive: true });
    const sha = imgSha1(buf);
    let candidate = wantName, renamed = false, reused = false;
    for (let i = 0; ; i++) {
      const target = path.join(assetsDir, candidate);
      let existing = null;
      try { existing = await fsp.readFile(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (existing === null) {
        try { await imgExclusiveWrite(target, buf); }
        catch (e) { if (e.code === 'EEXIST') { i--; continue; } throw e; }
        dbg('img:saveToAssets', { from, target, bytes: buf.length, renamed });
        return { ok: true, relPath: `assets/${encodeURIComponent(candidate).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`, absPath: target, renamed, reused: false, bytes: buf.length, mime: mime || imgMimeOf(candidate) };
      }
      if (imgSha1(existing) === sha && existing.equals(buf)) { dbg('img:saveToAssets:reuse', { from, target }); return { ok: true, relPath: `assets/${encodeURIComponent(candidate).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`, absPath: target, renamed, reused: true, bytes: buf.length, mime: mime || imgMimeOf(candidate) }; }
      if (i > 99) return { ok: false, error: `同名文件太多（试到 ${candidate}），请换个文件名` };
      candidate = `${stem}-${i + 1}${ext}`;
      renamed = true;
    }
  } catch (e) {
    const f = imgFsError(e, assetsDir);
    dbg('img:saveToAssets:error', { assetsDir, error: f.error });
    return f;
  }
}
/** 从浏览器抓图：**主进程代取**（渲染进程零网络）。同一 URL 命中本地缓存，不重复下载。 */
async function imgDownload({ url, fileNameHint } = {}) {
  let u = null;
  try { u = new URL(String(url || '')); } catch { return { ok: false, error: `不是合法的图片地址：${String(url || '').slice(0, 120)}` }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: `只支持 http/https 图片地址，收到的是 ${u.protocol}` };
  const ext = (path.extname(u.pathname).slice(1).toLowerCase() || 'png').replace(/[^a-z0-9]/g, '') || 'png';
  const slug = imgSafeName(decodeURIComponent(path.basename(u.pathname) || 'image'), `image.${ext}`).replace(/\.[^.]*$/, '') || 'image';
  const cacheDir = path.join(app.getPath('userData'), 'image-cache');
  const target = path.join(cacheDir, `${crypto.createHash('sha1').update(u.href).digest('hex').slice(0, 12)}-${slug.slice(0, 60)}.${ext}`);
  if (fs.existsSync(target)) {
    const st = fs.statSync(target);
    return { ok: true, absPath: target, cachePath: target, mime: imgMimeOf(target), bytes: st.size, fromCache: true, url: u.href };
  }
  try { await fsp.mkdir(cacheDir, { recursive: true }); } catch (e) { return imgFsError(e, cacheDir); }
  let res = null, buf = null;
  try {
    res = await net.fetch(u.href, { redirect: 'follow' });
    if (!res.ok) return { ok: false, error: `下载失败：HTTP ${res.status} ${res.statusText}（${u.href}）`, code: `HTTP_${res.status}` };
    const len = Number(res.headers.get('content-length') || 0);
    if (len > IMG_MAX_BYTES) return { ok: false, error: `图片过大：远端声明 ${(len / 1048576).toFixed(1)} MB，超过单张 ${IMG_MAX_BYTES / 1048576} MB 上限`, code: 'E_TOO_LARGE' };
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, error: `下载失败：${(e && e.message) || e}（${u.href}）`, code: (e && e.code) || 'E_NET' };
  }
  if (buf.length > IMG_MAX_BYTES) return { ok: false, error: `图片过大：${(buf.length / 1048576).toFixed(1)} MB，超过单张 ${IMG_MAX_BYTES / 1048576} MB 上限`, code: 'E_TOO_LARGE' };
  if (!buf.length) return { ok: false, error: `下载回来的内容是空的（${u.href}）` };
  try { await imgAtomicWrite(target, buf); } catch (e) { return imgFsError(e, target); }
  const declared = (res && res.headers.get('content-type') || '').split(';')[0].trim();
  dbg('img:download', { url: u.href, target, bytes: buf.length, fromCache: false });
  return { ok: true, absPath: target, cachePath: target, mime: (declared.startsWith('image/') ? declared : imgMimeOf(target)), bytes: buf.length, fromCache: false, url: u.href };
}
handle('file:readBase64', async (_e, p) => {
  try {
    if (typeof p !== 'string' || !p) return { ok: false, error: 'bad-path' };
    const st = await fsp.stat(p);                                  // 先 stat：超限就不读进内存
    if (!st.isFile()) return { ok: false, error: `不是文件：${p}`, code: 'EISDIR' };
    if (st.size > IMG_MAX_BYTES) return { ok: false, error: `文件过大：${(st.size / 1048576).toFixed(1)} MB > ${IMG_MAX_BYTES / 1048576} MB`, code: 'E_TOO_LARGE', bytes: st.size };
    const buf = await fsp.readFile(p);
    return { ok: true, base64: buf.toString('base64'), bytes: buf.length, mime: imgMimeOf(p), path: path.resolve(p) };
  } catch (e) { const f = imgFsError(e, p); return { ok: false, error: f.error, code: f.code }; }
});
/* 选图：原生多选文件框 ⇒ 绝对路径列表（顺序＝选择顺序）。
 * MP_TEST_PICK_IMAGES（`;` 分隔）在自动化里替掉原生框 —— **只影响"路径从哪来"**，
 * 后面的读字节/落盘/插入全走真链路；设了这个变量却没给值时**直接报错**，
 * 免得"以为在测预置，实际弹出原生框把整轮挂死"（这条坑本轮踩过一次）。 */
handle('image:pick', async (_e, opts = {}) => {
  const preset = process.env.MP_TEST_PICK_IMAGES;
  if (preset !== undefined) {
    const files = String(preset).split(';').map((s) => s.trim()).filter(Boolean).map((s) => path.resolve(s));
    if (!files.length) return { ok: false, error: 'MP_TEST_PICK_IMAGES 设了但没给路径（自动化里会直接失败，而不是弹原生框）' };
    dbg('image:pick:preset', files);
    return { ok: true, files, preset: true };
  }
  const r = await dialog.showOpenDialog(win, {
    title: String(opts.title || '插入图片'),
    buttonLabel: '插入',
    properties: opts.multiple === false ? ['openFile'] : ['openFile', 'multiSelections'],
    filters: [
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths.length) { dbg('image:pick:canceled'); return { ok: false, canceled: true }; }
  dbg('image:pick', r.filePaths);
  return { ok: true, files: r.filePaths };
});
// Name allocation and write receipts are serial across all editor windows.
let imageAssetsQueue = Promise.resolve();
handle('image:saveToAssets', (_e, opts = {}) => {
  const result = imageAssetsQueue.then(async () => {
    const delay = process.env.MP_TEST_HOOKS === '1' ? Math.min(5000, Math.max(0, Number(process.env.MP_TEST_IMAGE_DELAY_MS) || 0)) : 0;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    return imgSaveToAssets(opts);
  });
  imageAssetsQueue = result.catch(() => {});
  return result;
});
handle('image:base64ToFile', async (_e, { base64, mime, fileName } = {}) => {
  if (typeof base64 !== 'string' || !base64) return { ok: false, error: 'base64 为空' };
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) return { ok: false, error: 'base64 解出来是空的（传入内容可能被截断）' };
  if (buf.length > IMG_MAX_BYTES) return { ok: false, error: `图片过大：${(buf.length / 1048576).toFixed(1)} MB > ${IMG_MAX_BYTES / 1048576} MB`, code: 'E_TOO_LARGE' };
  const ext = (Object.keys(IMG_EXT_MIME).find((k) => IMG_EXT_MIME[k] === mime) || 'png');
  const dir = path.join(app.getPath('userData'), 'image-cache');
  const target = path.join(dir, `${imgSafeName(fileName || `pasted-${Date.now()}.${ext}`)}`);
  try { await fsp.mkdir(dir, { recursive: true }); await imgAtomicWrite(target, buf); }
  catch (e) { return imgFsError(e, target); }
  return { ok: true, absPath: target, tempPath: target, bytes: buf.length, mime: mime || imgMimeOf(target) };
});
handle('image:download', (_e, opts = {}) => imgDownload(opts));
// 全屏切换（工具栏「全屏」按钮）：返回新状态，渲染侧据此提示（插件形态没有这条通道，会如实提示"需要桌面版"）
handle('win:fullscreen', (e) => {
  try {
    const w = BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getFocusedWindow();
    if (!w) return { ok: false, error: 'no-window' };
    const to = !w.isFullScreen();
    w.setFullScreen(to);
    return { ok: true, fullscreen: to };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});
handle('shell:openExternal', (_e, url) => { try { shell.openExternal(String(url)); return true; } catch { return false; } });
/* 【导出后可点链接·2026-10-09 用户要求】导出完给一个能点的「打开所在文件夹」：
   showItemInFolder 会打开资源管理器并**选中该文件**（比只打开目录更好找）。
   文件若已被移走/改名，则退而打开它所在的目录；目录也没了才回错误 —— 不弹模态框、不静默。 */
/* 【剪贴板写入·2026-10-10】主进程直接写系统剪贴板：渲染进程的 navigator.clipboard 需要手势/权限，
   实测在"点 ⋮ 菜单 → 点复制项"这条路上会失败（哨兵值原样留在剪贴板里 ⇒ 用户粘到的是旧内容）。
   clipboard.write 由主进程执行，支持 text + html 两种口味，是 Electron 里最可靠的一条。 */
/* 【右键菜单·粘贴·2026-10-10】渲染进程里 execCommand("paste") 在 Electron 中不可靠（多数情况下被拒），
   右键菜单的「粘贴」必须由主进程执行。返回是否成功，失败不静默。 */
handle('edit:paste', e => {
  try {
    const w = windowOf(e);
    if (!w) return { ok: false, error: "no-window" };
    w.webContents.paste();
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
handle('edit:history', (e, cmd) => {
  if (cmd !== 'undo' && cmd !== 'redo') return { ok: false, error: 'invalid-command' };
  try {
    const w = windowOf(e);
    w.webContents[cmd]();
    return { ok: true };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});
/* 【通用设置通道·2026-10-10】渲染侧只允许改这几个键（白名单）：
   设置面板要加的开关会越来越多，但**不能**给渲染侧一个万能写入口 —— 
   state.settings 里有 recentFiles/winBounds 这类壳层自己维护的字段，被渲染侧覆盖会丢数据。 */
const SETTING_WRITABLE = new Set(['restoreLast', 'theme', 'zoom', 'fontFamily', 'fontSize', 'lineHeight', 'mathScale', 'autosaveEnabled', 'autosaveIntervalMs']);
/* 【文件多开·第 1 步】会话读数（只读）：给探针与后续步骤当验收口。 */
/* 【只读调试口·S4①·2026-10-10（settings-truth 族）】原生主题的**真源读数**（主进程侧）。
   复核"启动时 theme 是否落到 nativeTheme"必须读这里 —— 渲染侧的 `matchMedia('(prefers-color-scheme: dark)')`
   会被本应用自己的 CSS color-scheme / 渲染侧 dark 类干扰（实测：theme:'dark' 的 profile 里它仍是 false ✗）。
   只读、零副作用，与 debug:sessions 同类。 */
handle('debug:native-theme', () => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }));
handle('debug:sessions', (e) => {
  try {
    const me = e && e.sender ? e.sender.id : null;
    return {
      total: sessions.size,
      ids: [...sessions.keys()],
      mine: me,
      mineIsPrimary: me != null && sessions.get(me) === state,
      filePath: state.filePath || null,
      /* 【诊断·2026-10-10】会话表全貌：每个 webContents id 绑到哪个会话（含其 filePath、是否主会话）。
         多窗口缺陷定位用：一眼看出"新窗口是绑到了主会话，还是绑了空会话"。 */
      detail: [...sessions.entries()].map(([id, s]) => ({ id, filePath: (s && s.filePath) || null, isPrimary: s === state })),
    };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});
handle('setting:get', (_e, key) => {
  const k = String(key || ''), policy = require('./shell/save-policy').normalize(state.settings.autosaveEnabled, state.settings.autosaveIntervalMs);
  return { key: k, value: k === 'autosaveEnabled' ? policy.enabled : k === 'autosaveIntervalMs' ? policy.intervalMs : state.settings[k] };
});
handle('setting:set', (_e, payload = {}) => {
  const k = String(payload.key || '');
  if (!SETTING_WRITABLE.has(k)) return { ok: false, error: 'readonly-key', key: k };
  const existed = Object.hasOwn(state.settings, k), previous = state.settings[k];
  if (k === 'autosaveEnabled' && typeof payload.value !== 'boolean') return { ok: false, error: 'invalid-value', key: k };
  if (k === 'autosaveIntervalMs' && (!Number.isFinite(payload.value) || payload.value < 1000 || payload.value > 3600000)) return { ok: false, error: 'invalid-value', key: k };
  state.settings[k] = payload.value;
  /* 【数据丢失修复·2026-10-10（corrupt-config A7）】原来无条件 `return { ok: true }` ⇒
     只读 settings.json 时面板改设置"**回执成功、磁盘没变、零提示**"（OS 拒绝写入）。
     现在让写盘结果说话：失败即如实回报，用户看得见。 */
  const w = saveSettings();
  dbg("setting:set", { key: k, value: payload.value, wrote: !!(w && w.ok) });
  if (w && w.ok === false) {
    if (existed) state.settings[k] = previous; else delete state.settings[k];
    return { ok: false, error: 'write-failed', key: k, detail: w.error || '无法写入设置文件' };
  }
  /* 【S5 折中·2026-10-10（用户批准 ✓）】写盘成功后，**全局观感类**设置广播到所有窗口 ✓ ⇒ 其它已开窗口
     的面板/正文立即跟上 ✓（原来只有发起操作的那个窗口重算 ✗）。**`zoom` 明确排除** ✗ —— 视图类保持
     各窗口独立 ✓（折中的关键：缩放/滚动不互相干扰 ✓）。渲染侧收到后用**既有 applier** 应用 ✓
     （引擎的 `window.mpEngine.applyPrefs()` 与主题的 `themeGet/applyTheme` ✓，不新写第二份 ✗）。 */
  const GLOBAL_LOOK = new Set(['theme', 'fontFamily', 'fontSize', 'lineHeight', 'mathScale', 'autosaveEnabled', 'autosaveIntervalMs']);
  if (GLOBAL_LOOK.has(k)) { try { sendAll('setting', { key: k, value: state.settings[k], savePolicy: require('./shell/save-policy').normalize(state.settings.autosaveEnabled, state.settings.autosaveIntervalMs) }); } catch { /* 忽略 */ } }
  return { ok: true, key: k, value: payload.value };
});
/* 【图片右键·2026-10-10 用户报"图片右键没反应"】Typora 的图片右键有「复制图片 / 另存为图片」等；
   本仓此前**根本没实现**（全仓无任何图片右键菜单），所以右键图片什么都不发生。
   这里补壳层两个通道：图片进剪贴板（nativeImage）与另存为（保存对话框 + 原样落盘）。 */
/* 【尺子·2026-10-10】读系统剪贴板里有没有位图：渲染进程的 navigator.clipboard.read()
   不保证报告 OS 剪贴板的 image 口味（实测复制图片后那里只有 text/plain），
   壳层的 clipboard.readImage() 才是权威读数。 */
handle('clipboard:hasImage', () => {
  try {
    const img = clipboard.readImage();
    const size = img.isEmpty() ? { width: 0, height: 0 } : img.getSize();
    return { ok: true, hasImage: !img.isEmpty(), width: size.width, height: size.height, textLen: clipboard.readText().length };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
async function imgSourceBytes(src, docPath) {
  const value = String(src || '');
  if (!value) return { ok: false, error: '图片地址为空' };
  if (/^data:/i.test(value)) {
    const comma = value.indexOf(','), meta = value.slice(5, comma);
    if (comma < 0 || !/^image\//i.test(meta)) return { ok: false, error: '不是图片数据' };
    const data = value.slice(comma + 1);
    const buf = /;base64(?:;|$)/i.test(meta) ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data));
    if (!buf.length || buf.length > IMG_MAX_BYTES) return { ok: false, error: '图片为空或超过单张大小上限' };
    return { ok: true, buf, bytes: buf.length, mime: meta.split(';')[0] };
  }
  if (/^https?:/i.test(value)) {
    const downloaded = await imgDownload({ url: value });
    if (!downloaded.ok) return downloaded;
    return imgReadCapped(downloaded.absPath);
  }
  let file;
  if (/^file:/i.test(value)) file = fileURLToPath(value);
  else if (path.isAbsolute(value)) file = value;
  else {
    if (!docPath) return { ok: false, error: '请先保存文档，或使用完整图片地址' };
    const base = pathToFileURL(path.dirname(path.resolve(docPath)) + path.sep);
    file = fileURLToPath(new URL(value.replace(/\\/g, '/'), base));
  }
  return imgReadCapped(file);
}
// nativeImage decodes PNG/JPEG. Chromium supplies the raster for other editor
// formats such as WebP; the source file remains unchanged when saving it.
async function imgForClipboard(sender, source) {
  let image = nativeImage.createFromBuffer(source.buf);
  if (!image.isEmpty()) return image;
  const decode = async (dataURL, maxBytes) => {
    const img = new Image(); img.src = dataURL; await img.decode();
    if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 64000000) throw new Error('图片为空或像素过大');
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const png = canvas.toDataURL('image/png');
    if (png.length > maxBytes * 4 / 3 + 128) throw new Error('图片无法复制或超过大小上限');
    return png;
  };
  const dataURL = `data:${source.mime || 'image/png'};base64,${source.buf.toString('base64')}`;
  let timer;
  try {
    const png = await Promise.race([
      sender.executeJavaScript(`(${decode.toString()})(${JSON.stringify(dataURL)},${IMG_MAX_BYTES})`),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('图片解码超时')), 10000); }),
    ]);
    if (typeof png !== 'string' || !png.startsWith('data:image/png;base64,') || png.length > IMG_MAX_BYTES * 4 / 3 + 128) throw new Error('图片无法复制或超过大小上限');
    image = nativeImage.createFromBuffer(Buffer.from(png.slice(png.indexOf(',') + 1), 'base64'));
    return image;
  } finally { clearTimeout(timer); }
}
handle('clipboard:writeImage', async (e, payload = {}) => {
  try {
    const docPath = sessionOf(e.sender).filePath;
    const source = await imgSourceBytes(payload.src, docPath);
    if (!source.ok) return source;
    if (e.sender.isDestroyed()) return { ok: false, canceled: true };
    const img = await imgForClipboard(e.sender, source);
    if (e.sender.isDestroyed()) return { ok: false, canceled: true };
    if (!img || img.isEmpty()) return { ok: false, error: "bad-image" };
    clipboard.writeImage(img);
    const size = img.getSize();
    return { ok: true, width: size.width, height: size.height };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
handle('image:saveAs', async (e, payload = {}) => {
  try {
    const owner = BrowserWindow.fromWebContents(e.sender), docPath = sessionOf(e.sender).filePath;
    const suggest = imgSafeName(payload.fileName || 'image.png');
    const source = await imgSourceBytes(payload.src, docPath);
    if (!source.ok) return source;
    let r;
    if (MP_TEST_HOOKS && process.env.MP_TEST_IMAGE_SAVE_AS) r = { canceled: false, filePath: path.resolve(process.env.MP_TEST_IMAGE_SAVE_AS) };
    else if (process.env.MP_TEST_NO_DIALOG === '1') r = { canceled: true };
    else r = await dialog.showSaveDialog(owner, { title: "图片另存为", defaultPath: path.join(app.getPath("pictures"), suggest) });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    await fsp.writeFile(r.filePath, source.buf);
    return { ok: true, path: r.filePath, bytes: source.bytes };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
let clipboardWriteSerial = 0;
handle('clipboard:write', async (_e, p) => {
  try {
    const text = String((p && p.text) || '');
    const html = (p && p.html) ? String(p.html) : '';
    if (!text && !html) return { ok: false, error: "empty" };
    const delay = Number(process.env.MP_TEST_CLIPBOARD_DELAY_MS);
    if (process.env.MP_TEST_HOOKS === '1' && Number.isFinite(delay) && delay > 0 && delay <= 5000) {
      dbg('clipboardWrite:start', { seq: ++clipboardWriteSerial, ms: delay });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    if (html) clipboard.write({ text, html }); else clipboard.writeText(text);
    return { ok: true, bytes: text.length, hasHtml: !!html };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
handle('shell:showItem', (_e, p) => {
  try {
    const target = String(p || "");
    if (!target) return { ok: false, error: "no-path" };
    if (fs.existsSync(target)) { shell.showItemInFolder(target); return { ok: true, opened: "item", path: target }; }
    const dir = path.dirname(target);
    if (fs.existsSync(dir)) { void shell.openPath(dir); return { ok: true, opened: "dir", dir }; }
    return { ok: false, error: "not-found", path: target };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
handle('theme:get', () => ({ mode: state.settings.theme, dark: state.settings.theme === 'dark' || (state.settings.theme === 'system' && nativeTheme.shouldUseDarkColors) }));
handle('theme:set', (_e, mode) => {
  state.settings.theme = mode === 'dark' || mode === 'light' ? mode : 'system';
  saveSettings();
  nativeTheme.themeSource = state.settings.theme === 'system' ? 'system' : state.settings.theme;
  const dark = state.settings.theme === 'dark' || (state.settings.theme === 'system' && nativeTheme.shouldUseDarkColors);
  send('theme', { mode: state.settings.theme, dark });
  return { mode: state.settings.theme, dark };
});
/* 【Typora 社区主题·2026-10-09】选一个 .css 读回全文交给渲染侧。
   为什么默认目录指向 Typora 自己的主题目录：用户想装的通常就是他已经在 Typora 里用的那一份，
   直接停在那儿少点几次。读回上限 4MB（正常人写的主题几百 KB；再大基本是误选）。 */
handle('theme:pickCss', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择 Typora 主题 CSS',
    defaultPath: path.join(app.getPath('appData'), 'Typora', 'themes'),
    filters: [{ name: 'Typora 主题 CSS', extensions: ['css'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  const file = r.filePaths[0];
  try {
    const st = await fsp.stat(file);
    if (st.size > 4 * 1024 * 1024) return { ok: false, error: '主题文件超过 4 MB（请确认选的是 .css）' };
    const text = await fsp.readFile(file, 'utf8');
    return { ok: true, path: file, name: path.basename(file, path.extname(file)), text };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
handle('doc:dirty', (e, payload) => {
  const S = sessionOf(e.sender), W = windowOf(e);
  let accepted;
  if (typeof payload === 'boolean' && MP_TEST_HOOKS) { S.dirty = payload; accepted = true; }
  else accepted = documents.markDirty(S, payload || {});
  updateTitle(S, W); return { ok: accepted, documentId: S.documentId, revision: S.revision, dirty: S.dirty };
});
handle('doc:path', (e, filePath, metadata = {}) => {
  const S = sessionOf(e.sender), W = windowOf(e);
  if (filePath === null) {
    if (metadata.documentId !== S.documentId) return { ok: false, code: 'MP_DOC_MISMATCH' };
    if (pdfActive?.owner === e.sender.id) return { ok: false, error: 'PDF 正在导出，请完成或取消后再新建文档' };
    documents.reset(S); W.__pendingClose = null;
  } else if (filePath !== S.filePath || (metadata.documentId && metadata.documentId !== S.documentId)) return { ok: false, code: 'MP_DOC_MISMATCH' };
  syncPathUi(S, W); return { ok: true, ...documents.metadata(S) };
});
handle('doc:saved', (e, receipt = {}) => {
  const S = sessionOf(e.sender), W = windowOf(e), saved = S.lastSave;
  if (!saved || receipt.saveId !== saved.id || receipt.documentId !== S.documentId || receipt.revision !== saved.revision || receipt.filePath !== S.filePath) return false;
  syncPathUi(S, W); pushRecent(S.filePath);
  if (W.__pendingClose?.documentId === S.documentId && W.__pendingClose.revision === S.revision && !S.dirty && !S.pendingSaves.size) { W.__pendingClose = null; W.destroy(); }
  return true;
});
handle('doc:outside-change', async (e, { filePath }) => {
  try { return await documents.outsideChange(sessionOf(e.sender), filePath); }
  catch (err) { return { changed: false, error: err.message }; }
});

/* ── IPC：导出为文件夹（图片外链，不内联） ──────────────────────────────
 * 通道划分：
 *   export:pickFolder      选目标文件夹（MP_EXPORT_DIR 环境变量可跳过弹窗，供自动化/回归用）
 *   export:prepareAssets   逐张复制图片进 <dir>/assets/，边复制边回报进度；单张失败只降级那一条
 *   export:begin/append/finish/abortHtml   HTML 分块流式落盘（渲染进程不攒整篇字符串）
 */
const exportWriters = new Map();
/** 当前 PDF 导出会话（staging 目录 + 取消位 + 等渲染侧交 HTML 的承诺）；null = 没有 PDF 导出在进行 */
let pdfActive = null;
let pdfSeq = 0;
function pdfStage(e, dir, pdfSessionId) {
  const resolved = typeof dir === 'string' ? path.resolve(dir) : null;
  const rel = resolved ? path.relative(app.getPath('temp'), resolved) : '';
  const reserved = rel && !path.isAbsolute(rel) && rel.split(path.sep)[0].toLowerCase().startsWith('markpilot-pdf-');
  if (pdfSessionId === undefined && !reserved) return null;
  const s = pdfActive;
  if (!s || s.canceled || s.closing || s.owner !== e.sender.id || pdfSessionId !== s.id || !resolved || !s.dir || path.relative(s.dir, resolved) !== '') {
    throw failure('MP_EXPORT_CANCELED', 'PDF 导出已结束或取消');
  }
  return s;
}
handle('doc:info', (e) => { const S = sessionOf(e && e.sender); try { dbg('doc:info:read', { wcId: e && e.sender ? e.sender.id : null, isPrimary: S === state, path: (S.filePath || '').split('\\').pop() || null, mapSize: sessions.size }); } catch { } return { filePath: S.filePath, documentId: S.documentId, name: S.filePath ? path.basename(S.filePath) : null }; });
handle('export:pickFolder', async (e, opts = {}) => {
  const S = sessionOf(e.sender), W = windowOf(e);
  if (opts.pdfSessionId !== undefined) {
    if (!pdfActive || pdfActive.canceled || pdfActive.closing || pdfActive.owner !== e.sender.id || pdfActive.id !== opts.pdfSessionId) return { ok: false, canceled: true, code: 'MP_EXPORT_CANCELED', error: 'PDF 导出已结束或取消' };
    if (!pdfActive.dir || pdfActive.pickUsed) return { ok: false, error: 'PDF 正在导出，请稍后再导出文件夹' };
    pdfActive.pickUsed = true; return { ok: true, dir: pdfActive.dir, staging: true };
  }
  if (pdfActive?.owner === e.sender.id) return { ok: false, error: 'PDF 正在导出，请稍后再导出文件夹' };
  const envDir = process.env.MP_EXPORT_DIR;
  if (envDir) { try { await fsp.mkdir(envDir, { recursive: true }); return { ok: true, dir: envDir, auto: true }; } catch (err) { return { ok: false, error: err.message }; } }
  const base = S.filePath ? path.dirname(S.filePath) : app.getPath('documents');
  const r = await dialog.showOpenDialog(W, { title: '导出为文件夹（图片放进 assets/）', defaultPath: opts.defaultPath || base, buttonLabel: '导出到此文件夹', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled || !r.filePaths[0] ? { ok: false, canceled: true } : { ok: true, dir: r.filePaths[0] };
});
handle('export:prepareAssets', async (e, { dir, docPath, refs, concurrency, pdfSessionId } = {}) => {
  const S = sessionOf(e.sender), W = windowOf(e);
  if (!dir) return { ok: false, error: '缺少目标文件夹' };
  try {
    const stage = pdfStage(e, dir, pdfSessionId);
    const pending = exporter.prepareAssets({ dir, docPath: docPath || S.filePath, refs, concurrency, onProgress: p => sendTo(W, 'export:progress', p), ...(stage ? { isCanceled: () => stage.canceled || stage.closing } : {}) });
    stage?.assetJobs.add(pending);
    try { return await pending; } finally { stage?.assetJobs.delete(pending); }
  } catch (err) { return { ok: false, error: err.message }; }
});
function ownedWriter(e, id) { const w = exportWriters.get(id); return w?.owner === e.sender.id ? w : null; }
handle('export:beginHtml', (e, { dir, name, pdfSessionId } = {}) => {
  sessionOf(e.sender);
  try {
    const stage = pdfStage(e, dir, pdfSessionId);
    if (stage?.htmlWriterCreated) return { ok: false, error: 'PDF 的 HTML 已在生成' };
    const writer = exporter.createHtmlWriter({ dir, name });
    if (stage) { stage.htmlWriterCreated = true; stage.htmlWriter = writer; }
    exportWriters.set(writer.id, { owner: e.sender.id, writer });
    return { ok: true, id: writer.id, file: writer.file };
  } catch (err) { return { ok: false, error: err.message }; }
});
handle('export:appendHtml', async (e, { id, text } = {}) => {
  const entry = ownedWriter(e, id);
  if (!entry) return { ok: false, error: '写流不属于当前窗口或已结束' };
  try { return { ok: true, ...(await entry.writer.write(text)) }; }
  catch (err) { exportWriters.delete(id); await entry.writer.abort().catch(() => {}); return { ok: false, error: err.message }; }
});
handle('export:finishHtml', async (e, { id } = {}) => {
  const entry = ownedWriter(e, id);
  if (!entry) return { ok: false, error: '写流不属于当前窗口或已结束' };
  exportWriters.delete(id);
  try { return await entry.writer.finish(); } catch (err) { await entry.writer.abort().catch(() => {}); return { ok: false, error: err.message }; }
});
handle('export:abortHtml', async (e, { id } = {}) => {
  const entry = ownedWriter(e, id);
  if (!entry) return { ok: false, error: '写流不属于当前窗口或已结束' };
  exportWriters.delete(id); return entry.writer.abort();
});

/* ── IPC：导出为 PDF（复用文件夹版 HTML → 从磁盘上的本地 HTML 打印） ──────────────
 * 为什么不是"直出 PDF"：v2.3.3 的崩法是**整篇 HTML + 全部图片 base64 内联进渲染进程**
 * （同一份图 5–6 份内存副本，696KB 源把 worker RSS 推到 2608MB）。这里反过来：
 *   ① 主进程建 staging 目录 → 引擎跑**同一条**「导出为文件夹」流程（assets/ 相对路径 + 分块写流）
 *      ——这条路的产物已经在便携 EXE 上跑通过（606KB HTML/6.4MB 图，62–77ms）；
 *   ② 打印窗口是**独立隐藏窗口**，`loadFile` 这份本地 HTML，图片由 Chromium 从磁盘异步读；
 *   ③ `printToPDF` → Buffer → 1MB 分片流式写盘（临时文件 + rename）。
 * 渲染进程全程只经手「图片地址清单」与 256KB 的 HTML 块，不持有 base64，也不持有整篇 HTML。
 *
 * 通道：
 *   export:pdf        一次完整流程（选目标 → staging → 要 HTML → 打印 → 写盘 → 清理）；
 *                     返回 {ok,file,bytes,pages,ms,printMs,phases,html,images,gate}
 *   export:pdfCancel  置取消位：阶段边界中断、删半成品 PDF、删 staging
 *   export:htmlDone   渲染侧（host.js 用引擎的文件夹导出写完 HTML 后）回报结果
 * 下行：export:make-html（请渲染侧去写 HTML）；上行：export:progress（复用既有进度通道）
 */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** 公式 CSS 的**壳层兜底**（已实现、实测有回归，**默认不启用**；留着是给引擎侧做参考 + 单元可测）。
 *
 *  背景实测：引擎的 buildMathCss() 走 fetch 取 CSS，桌面壳是 file:// 页面，Chromium 禁止 file:// fetch
 *  ⇒ 返回空串（mathCssStat 报 `css-fetch: Failed to fetch`），导出 HTML 里只有 `.katex` 标记没有排版规则。
 *  壳层试过两条兜底路：
 *    ① 把 `url("fonts/…")` 改写成应用内 fonts/ 的绝对 file:// URL → 跨文件字体请求被 CORS 拒，
 *       而 @font-face 的 block 期内文字**不可见**，打印正好落在 block 期 ⇒ 公式整片变空白（有图为证）；
 *    ② 把 20 个 woff2 内联成 data: URL（367KB CSS）→ 同样得到"公式不可见"的渲染结果。
 *  结论：KaTeX 的 HTML 输出依赖 CSS + 字体两件套同时到位，壳层在打印窗口里补不齐（`vlist` 定位也依赖字体度量）。
 *  正确做法在引擎侧：导出时就把 KaTeX CSS 与字体（data: 或随 assets/ 一起落盘）一次做对——编辑器里本来就能排版。
 *  在没有引擎 CSS 的情况下，PDF 里公式是"KaTeX 标记的纯文本形态"：可读、不溢出（见报告视觉判读）。
 */
function mathCssFallback() {
  if (mathCssFallbackCache !== null) return mathCssFallbackCache;
  try {
    const css = fs.readFileSync(path.join(__dirname, 'renderer', 'cm6', 'app.css'), 'utf8');
    const fontDir = path.join(__dirname, 'renderer', 'cm6', 'fonts');
    mathCssFallbackCache = pdfExporter.extractKatexCss(css, { fontDir });
    dbg('mathCssFallback', { bytes: mathCssFallbackCache.length, fontDir });
  } catch (e) {
    mathCssFallbackCache = '';
    dbg('mathCssFallback:error', e.message);
  }
  return mathCssFallbackCache;
}
handle('export:pdf', async (e, opts = {}) => {
  const S = sessionOf(e.sender), W = windowOf(e), t0 = Date.now();
  if (pdfActive) return { ok: false, error: '已有一个 PDF 导出在进行中' };
  const stem = S.filePath ? path.basename(S.filePath, path.extname(S.filePath)) : '未命名';
  const session = { id: 'pdf-' + process.pid + '-' + (++pdfSeq), owner: e.sender.id, documentId: S.documentId, canceled: false, waiter: deferred(), phases: [], dir: null, assetJobs: new Set(), htmlWriter: null };
  pdfActive = session; // Reserve before the first dialog or filesystem await.
  const progress = p => sendTo(W, 'export:progress', p);
  const ownerClosed = () => { session.canceled = true; session.waiter.resolve({ ok: false, canceled: true }); };
  W.once('closed', ownerClosed);
  let dir = null, outFile = opts.outFile || process.env.MP_EXPORT_PDF || null, htmlTimer;
  const mem = pdfExporter.memorySampler(app, { intervalMs: 200 });
  const cleanupStaging = async () => {
    session.closing = true;
    if (!dir) return;
    const target = path.resolve(dir), parent = path.resolve(app.getPath('temp'));
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('markpilot-pdf-')) throw new Error('PDF 临时目录超出清理范围');
    await Promise.allSettled([...session.assetJobs]);
    if (session.htmlWriter) {
      const entry = exportWriters.get(session.htmlWriter.id);
      if (entry?.owner === session.owner && entry.writer === session.htmlWriter) exportWriters.delete(session.htmlWriter.id);
      await session.htmlWriter.abort({ remove: !process.env.MP_KEEP_STAGING });
    }
    if (process.env.MP_KEEP_STAGING) return;
    await fsp.rm(target, { recursive: true, force: true });
  };
  try {
    progress({ phase: 'pick' });
    if (!outFile) {
      const base = S.filePath ? path.dirname(S.filePath) : app.getPath('documents');
      const r = await dialog.showSaveDialog(W, { title: '导出为 PDF', defaultPath: path.join(base, stem + '.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      if (r.canceled || !r.filePath) { progress({ phase: 'canceled' }); return { ok: false, canceled: true }; }
      outFile = r.filePath;
    }
    if (session.canceled || S.documentId !== session.documentId) { progress({ phase: 'canceled' }); return { ok: false, canceled: true }; }
    outFile = path.resolve(outFile);
    const outputKey = documents.key(await documents.canonical(outFile));
    for (const doc of sessions.values()) if (doc.filePath && documents.key(await documents.canonical(doc.filePath)) === outputKey) throw failure('MP_EXPORT_TARGET', 'PDF 不能覆盖正在编辑的文档，请选择其他路径');
    await fsp.mkdir(path.dirname(outFile), { recursive: true });
    dir = await fsp.mkdtemp(path.join(app.getPath('temp'), 'markpilot-pdf-')); session.dir = dir;
    mem.start();
    // ③ 请渲染侧用**引擎自己的**文件夹导出流程把 HTML + assets/ 写到 staging
    sendTo(W, 'export:make-html', { id: session.id, documentId: session.documentId, stageDir: dir, name: stem });
    const html = await Promise.race([
      session.waiter.promise,
      new Promise(r => { htmlTimer = setTimeout(() => r({ ok: false, error: '等渲染侧生成 HTML 超时' }), pdfExporter.GATE.HTML_WAIT_MS); }),
    ]);
    if (session.canceled) { await cleanupStaging(); progress({ phase: 'canceled' }); return { ok: false, canceled: true, ms: Date.now() - t0 }; }
    if (!html || !html.ok || !html.file) {
      await cleanupStaging();
      const error = (html && html.error) || '未拿到本地 HTML（引擎的文件夹导出没写出文件）';
      dbg('export:pdf:no-html', error);
      progress({ phase: 'error', error });
      return { ok: false, error, ms: Date.now() - t0 };
    }
    const htmlStat = await fsp.stat(html.file).catch(() => null);
    if (!htmlStat || !htmlStat.size) { await cleanupStaging(); return { ok: false, error: 'staging HTML 不存在或为空' }; }
    dbg('export:pdf:html-ready', { file: html.file, bytes: htmlStat.size, mathCssBytes: (html.mathCss || '').length, ms: Date.now() - t0 });

    // ④ 打印：隐藏窗口 loadFile → 图片 decode 完 → printToPDF → 分片写盘（实现在 export-pdf.js）
    progress({ phase: 'load', file: html.file, bytes: htmlStat.size });
    // 公式 CSS：引擎给的就用引擎的；给不出来（file:// 下 fetch 失败）就用壳层从 app.css 摘的兜底
    const engineCss = typeof html.mathCss === 'string' && html.mathCss.length ? html.mathCss : '';
    // 公式 CSS：**只用引擎给的**。壳层兜底（mathCssFallback）实测有回归（公式在打印里整片不可见），默认关闭。
    const extraCss = engineCss;
    session.mathCssSource = engineCss ? 'engine' : 'none';
    dbg('export:pdf:mathCss', { source: session.mathCssSource, bytes: extraCss.length });
    const r = await pdfExporter.printLocalHtmlToPdf({
      BrowserWindow, ipcMain, htmlFile: html.file, outFile,
      extraCss,
      /* 【诊断口·2026-10-11】export-pdf.js 的 `o.css` 注释里写明"undefined=用 PRINT_CSS，''/null=不注入"，
         但主进程一直没把它透进来 ✗ ⇒ 只能改代码才能做"打印期样式"的对照臂 ✗。
         补上这一行：`opts.css` 透传 ✓（**只影响打印期注入的样式**，不动磁盘 HTML ✓；
         与 MP_PDF_SHOW / MP_KEEP_STAGING 同族，都是诊断用 ✓）。 */
      ...(opts && 'css' in opts ? { css: opts.css } : {}),
      /* 【KP 排版预算】源 Markdown 长度由渲染侧随 htmlDone 带过来（与 2.x 线同一口径：
         源 ≥300KB 或可排块 ≥1800 就整体跳过精细断行，回退 CSS 两端对齐）。取不到就传 0
         ⇒ 只由"块数"这一个闸门决定，不会因为拿不到长度而误开。 */
      sourceBytes: Number(html.sourceBytes) || 0,
      /* 诊断：把打印窗口显示出来（`MP_PDF_SHOW=1`）。正式路径永远隐藏；这一条只为视觉取证
         ——隐藏窗口无法截图，"排版到底长什么样"必须能被人看见一次。 */
      ...(process.env.MP_PDF_SHOW === '1' ? { showWindow: true } : {}),
      isCanceled: () => session.canceled,
      onPhase: (p) => { session.phases.push(p); progress({ phase: p.phase, ms: p.ms, bytes: p.bytes, done: p.done, pages: p.pages }); },
    });
    if (r.canceled) {
      await cleanupStaging();
      progress({ phase: 'canceled' });
      return { ok: false, canceled: true, ms: Date.now() - t0, phases: session.phases };
    }
    const imgPhase = session.phases.find((p) => p.phase === 'images') || {};
    const memReport = mem.stop();
    const result = {
      ok: true, file: outFile, bytes: r.bytes, pages: r.pages,
      ms: Date.now() - t0, printMs: r.ms, chunks: r.chunks,
      html: { file: html.file, bytes: htmlStat.size, relImages: r.html.relImages, dataImages: r.html.dataImages, remoteImages: r.html.remoteImages, tables: r.html.tables, mathBlocks: r.html.mathBlocks },
      images: { total: imgPhase.images, complete: imgPhase.complete, natural: imgPhase.natural, broken: imgPhase.broken, ms: imgPhase.ms },
      gate: r.gate, memory: memReport, phases: session.phases,
      kp: r.kp || null,          // Knuth–Plass 排版统计（applied/lines/blocks/budgetSkipped/error）
      /* 公式 CSS 的来源与字节数：此前这条链静默丢失 mathCss（PDF 里公式没排版），
         把这两项放进结果里，探针/报告能直接断言"引擎的公式样式确实进了打印窗口"。 */
      mathCss: { source: session.mathCssSource, bytes: extraCss.length },
    };
    dbg('export:pdf:done', { file: outFile, bytes: r.bytes, pages: r.pages, ms: result.ms, printMs: r.ms, images: result.images, memPeakMB: memReport.peakMB });
    progress({ phase: 'cleanup' });
    await cleanupStaging();
    progress({ phase: 'done', file: outFile, bytes: r.bytes, pages: r.pages, ms: result.ms });
    return result;
  } catch (err) {
    dbg('export:pdf:error', err.message);
    await cleanupStaging().catch(e => dbg('export:pdf:cleanup-error', e.message));
    progress({ phase: 'error', error: err.message });
    return { ok: false, error: err.message, code: err.code, ms: Date.now() - t0, phases: session.phases };
  } finally {
    clearTimeout(htmlTimer); W.removeListener('closed', ownerClosed);
    if (pdfActive === session) pdfActive = null;
    mem.stop();
  }
});
handle('export:pdfCancel', e => {
  if (!pdfActive) return { ok: false, error: '没有进行中的 PDF 导出' };
  if (pdfActive.owner !== e.sender.id) return { ok: false, error: 'PDF 导出不属于当前窗口' };
  pdfActive.canceled = true;
  dbg('export:pdf:cancel', { id: pdfActive.id });
  try { pdfActive.waiter.resolve({ ok: false, canceled: true }); } catch { /* 已 resolve */ }
  return { ok: true, id: pdfActive.id };
});
handle('export:htmlDone', (e, o = {}) => {
  const s = pdfActive;
  if (!s || o.id !== s.id || s.owner !== e.sender.id) return { ok: false, error: 'PDF 会话不存在（可能已结束）' };
  if (o.ok && (!s.dir || !o.file || path.dirname(path.resolve(o.file)) !== s.dir)) return { ok: false, error: 'PDF 的 HTML 不属于本次临时目录' };
  dbg('export:htmlDone', { id: o.id, ok: !!o.ok, file: o.file || null, error: o.error || null });
  /* 【★ 2026-10-09 修·丢字段】改前这里只透传 {ok,file,error,mode}，把渲染侧一起送来的
     `mathCss` 与 `sourceBytes` **静默丢掉**：
       · `mathCss` 丢了 ⇒ 打印窗口拿不到 KaTeX 类样式 ⇒ **PDF 里的公式只有结构没有排版**
         （第 1260 行读的就是 `html.mathCss`，永远读到 undefined ⇒ session.mathCssSource 恒为 'none'）；
       · `sourceBytes` 丢了 ⇒ KP 排版的"源 ≥300KB 跳过"闸门形同虚设（只剩块数闸门）。
     教训与 AGENTS 错-1/错-4 同族：**字段在管道里被静默截断**，读数看着正常、功能却少一半。
     这里改成把需要的字段显式列全（不整体透传：避免渲染侧多送的东西无声进入打印流程）。 */
  try {
    s.waiter.resolve({
      ok: !!o.ok, file: o.file || null, error: o.error || null, mode: o.mode || null,
      mathCss: typeof o.mathCss === 'string' && o.mathCss ? o.mathCss : null,
      mathCssError: o.mathCssError || null,
      sourceBytes: Number(o.sourceBytes) || 0,
    });
  } catch { /* 已 resolve */ }
  return { ok: true };
});

function updateTitle(S, W) {
  if (!W || W.isDestroyed()) return;
  const name = S.filePath ? path.basename(S.filePath) : '未命名';
  W.setTitle(`${S.dirty ? '● ' : ''}${name} — MarkPilot`);
}

nativeTheme.on('updated', () => {
  if (state.settings.theme !== 'system') return;
  send('theme', { mode: 'system', dark: nativeTheme.shouldUseDarkColors });
});
