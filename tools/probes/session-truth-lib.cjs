/** session-truth 族（会话与 MRU 真源）共用尺子
 *
 *  为什么有这个小文件（AGENTS 错-4：同一件事不许有第二份实现）：
 *   · 启动范式（spawn 产物 + 随机 CDP 端口 + 独立 --user-data-dir + MP_DEBUG=1 + 删 ELECTRON_RUN_AS_NODE
 *     + playwright-core connectOverCDP）在本族只实现一次；
 *   · "一组相关读数一次 evaluate 拿全"（错-7 第 1 条）也在这里固化成一个 snap()，探针不得跨调用拼装；
 *   · "断言不是默认回退值"（错-7 第 2 条）做成 guardBoot()：产物自报的 MRU 真源文件必须落在**本次的
 *     profile** 里，否则说明 CDP 连到了别的实例 ⇒ 直接拒绝出数。
 *
 *  产物一致性断言走 _probe-common.cjs（不许再写第二份 sha16）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync, execSync } = require('node:child_process');
const { chromium } = require('../quality/dependencies.cjs').playwright();
const RULER = require(path.join(__dirname, '_probe-common.cjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 结束自己起的进程树（纪律 1：自己起的进程结束前全部 taskkill）。 */
function killTree(pid) {
  if (!pid) return;
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { /* 已经没了 */ }
}

/** 主进程一手事实（纪律 4）：某个 PID 现在还在不在。 */
function pidAlive(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return new RegExp(`"${pid}"`).test(out);
  } catch { return false; }
}

/** 主进程一手事实：全机同名进程（对照用，判断"是不是我的实例"）。 */
function nameProcs(exe) {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${path.basename(exe)}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^"/.test(l)).map((l) => {
      const c = l.split('","').map((s) => s.replace(/^"|"$/g, ''));
      return { name: c[0], pid: Number(c[1]), mem: c[4] };
    });
  } catch { return []; }
}

/** 主进程一手事实：**只属于我的**进程（按命令行里的 profile 路径过滤）。
 *  为什么不能按进程名数：本机同时有多条腿在跑同一个产物（实测同名的 MarkPilot.exe 有 20 个），
 *  按名字数"残留"会把别人的腿算成我的残留。 */
function profileProcs(profile) {
  try {
    const q = `Get-CimInstance Win32_Process -Filter "Name='MarkPilot.exe'" | Where-Object { $_.CommandLine -like '*${String(profile).replace(/'/g, "''")}*' } | ForEach-Object { "$($_.ProcessId)" }`;
    const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', q], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    return out.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number);
  } catch { return []; }
}

/** 启动一次实例并连上 CDP。argv 传空数组＝"命令行没带文件"（「打开上次的文件」那条路）。 */
async function launch({ exe, profile, port, argv = [], env = {} }) {
  const e = { ...process.env, MP_DEBUG: '1', MP_TEST_HOOKS: '1', MP_TEST_NO_DIALOG: '1', ...env };
  delete e.ELECTRON_RUN_AS_NODE;
  const args = [...argv, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`];
  const child = spawn(exe, args, { env: e, stdio: 'ignore' });
  let browser = null;
  for (let i = 0; i < 60 && !browser; i++) { await sleep(1000); try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { /* 再等 */ } }
  if (!browser) { killTree(child.pid); throw new Error(`CDP 连不上 127.0.0.1:${port}`); }
  return { child, browser, port, profile, args, pageerrors: [], consoleErrors: [], crashes: [] };
}

/** 活着的"引擎页"（mpEngine + mpHost 双就位）。 */
async function enginePages(app) {
  const out = [];
  let ctxs = [];
  try { ctxs = app.browser.contexts(); } catch { return out; }
  for (const ctx of ctxs) {
    for (const p of ctx.pages()) {
      if (p.url().startsWith('devtools://')) continue;
      try { if (p.isClosed()) continue; } catch { continue; }
      const ok = await p.evaluate(() => { try { return !!(window.mpEngine && window.mpHost); } catch { return false; } }).catch(() => false);
      if (ok) { attach(app, p); out.push(p); }
    }
  }
  return out;
}

const attached = new WeakSet();
/** 页错误/崩溃留痕（每页只挂一次）。 */
function attach(app, page) {
  if (attached.has(page)) return;
  attached.add(page);
  try { page.on('pageerror', (e) => app.pageerrors.push({ url: page.url(), msg: String((e && e.message) || e).slice(0, 300) })); } catch { }
  try { page.on('console', (m) => { if (m.type() === 'error') app.consoleErrors.push({ url: page.url(), msg: String(m.text()).slice(0, 300) }); }); } catch { }
  try { page.on('crash', () => app.crashes.push({ at: Date.now(), url: page.url() })); } catch { }
}

/** 等引擎页出现（n 个）并返回；关窗/关页后必须重新取（纪律 4）。 */
async function waitPages(app, n = 1, tries = 60, gap = 500) {
  for (let i = 0; i < tries; i++) {
    const ps = await enginePages(app);
    if (ps.length >= n) return ps;
    await sleep(gap);
  }
  return await enginePages(app);
}

const pickPage = async (app) => (await waitPages(app, 1))[0] || null;

/** ── 核心读数：一组相互关联的事实**一次 evaluate 拿全**（错-7 第 1 条）──
 *  含：本页会话身份、本页文档、MRU（真源文件路径 + 每条 alive）、
 *  最近打开菜单的**实时项**、可挂点 id 全表、restoreLast 设置、健康读数、编辑器文档头。 */
async function snap(page) {
  return await page.evaluate(async () => {
    const H = window.mpHost;
    const out = { at: Date.now(), url: location.href };
    out.sessions = await H.debugSessions();
    out.doc = await H.docInfo();
    out.mru = await H.recentList();
    out.menu = await H.recentTestMenuList();
    out.restoreLast = await H.settingGet('restoreLast');
    out.health = await H.health();
    const v = (window.mpEngine && typeof window.mpEngine._view === 'function') ? window.mpEngine._view() : null;
    out.editor = v ? { len: v.state.doc.length, head: String(v.state.doc.toString()).slice(0, 48) } : null;
    out.title = document.title;
    const a = document.activeElement;
    out.activeEl = a ? String(a.className || a.tagName || '') : null;
    return out;
  });
}

/** 把引擎已经算好的菜单项读成"人看得见的一行"（错-15：读引擎算好的结果，不自己推断）。 */
const menuLines = (s) => ((s.menu && s.menu.items) || []).map((it) => it.type === 'separator' ? '——' : `${it.label}${it.enabled === false ? '(灰)' : ''}`);
const mruPaths = (s) => (((s.mru || {}).files) || []).map((f) => f.path);
const mruAlive = (s) => (((s.mru || {}).files) || []).map((f) => (f.alive ? '+' : '-'));
const baseName = (p) => (p ? path.basename(String(p)) : null);

/** 真源落盘对账：recents.json 就是 MRU 的唯一真源（main.js 注释写明"验收脚本可以直接读盘对账"）。 */
function readRecentsFile(app) {
  const f = path.join(app.profile, 'recents.json');
  try { return { file: f, exists: true, list: JSON.parse(fs.readFileSync(f, 'utf8')) }; }
  catch (e) { return { file: f, exists: fs.existsSync(f), list: null, err: String((e && e.message) || e).slice(0, 80) }; }
}
function readSettingsFile(app) {
  const f = path.join(app.profile, 'settings.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function readDebugLog(app) {
  try { return fs.readFileSync(path.join(app.profile, 'main-debug.log'), 'utf8'); } catch { return ''; }
}
function logLines(app, re) {
  return readDebugLog(app).split(/\r?\n/).filter((l) => re.test(l));
}
function logSize(app) { try { return fs.statSync(path.join(app.profile, 'main-debug.log')).size; } catch { return 0; } }
function logSince(app, size) {
  try { const t = fs.readFileSync(path.join(app.profile, 'main-debug.log'), 'utf8'); return t.slice(size).split(/\r?\n/).filter(Boolean); } catch { return []; }
}

/** 一手证据：日志里**最后一条** `ready {...}`（它带 argv/userData/recents）。
 *  用途见 guardBoot③：证明"我现在连的这个实例，就是刚写下 ready 的那个进程"——
 *  否则 boot N 可能根本没起来，而我连到的是**上一个还活着的实例**（单实例锁会让新进程直接退出）。 */
function lastReady(app) {
  /* 锚点必须是"时间戳后面紧跟 ready"：写成 /\bready \{/ 会连 `Z doc:ready {` 一起命中，
     而 doc:ready 的载荷是 {wcId,has,isPrimary,path}、没有 argv ⇒ 出处闸门第一次跑就自己读空了。 */
  const lines = logLines(app, /\d{2}:\d{2}:\d{2}\.\d{3}Z ready \{/);
  const l = lines[lines.length - 1];
  if (!l) return null;
  try { return JSON.parse(l.slice(l.indexOf('{'))); } catch { return null; }
}

/** ── 身份闸门（错-7 第 2 条：断言拿到的不是默认回退值）──
 *  ① 产物自报的 MRU 真源文件必须落在**本次 profile** 里（连错实例时会指向别人的 userData）——这条立即判定；
 *  ② 挂点表里必须有 menu-close-window。挂点表由 buildMenu() 填，而 buildMenu() 在 whenReady 里才跑
 *     ⇒ 刚连上 CDP（uptime 约 1s）时可能还没填 ⇒ 这里轮询到就绪（最多 25s），并把 id 表打出来。
 *     【不许要求 menu-clear-recent 在开机时就在】shell/recents.js 的 menuModel() 在 MRU 为空时
 *     **只返回那一条灰的「（暂无记录）」**（连分隔符与「清除最近记录」都不生成）⇒ 空 MRU 启动时
 *     这个 id 本来就不该存在。第一版闸门把"它必须在"写成前提，于是每次空基线启动都被自己的尺子拦下
 *     （实测：uptime 26.6s、7 个挂点，日志里 recents:loaded source=empty count=0）。判据改读引擎
 *     真正算出来的东西：菜单里有没有那条「（暂无记录）」。 */
async function guardBoot(app, page, where) {
  const want = path.join(app.profile, 'recents.json');
  const need = ['menu-close-window'];
  let s = await snap(page);
  const got = (s.mru && s.mru.file) || null;
  if (!(got && got.toLowerCase() === want.toLowerCase())) {
    console.error(`✗ 身份闸门·${where}：MRU 真源=${got} 期望=${want} ⇒ 疑似连到了别的实例，拒绝出数。`);
    killTree(app.child && app.child.pid);
    process.exit(9);
  }
  let ids = (s.menu && s.menu.ids) || [];
  let lastKey = '';
  for (let i = 0; i < 50 && !need.every((k) => ids.includes(k)); i++) {
    const key = ids.join(',');
    if (key !== lastKey) { console.log(`[身份闸门·${where}] 等挂点就绪… uptimeMs=${s.health && s.health.uptimeMs} ids(${ids.length})=${key}`); lastKey = key; }
    await sleep(500);
    s = await snap(page);
    ids = (s.menu && s.menu.ids) || [];
  }
  const ok = need.every((k) => ids.includes(k));
  console.log(`[身份闸门·${where}] ${ok ? '✓' : '✗'} MRU真源=${got} 期望=${want} | 挂点=${ids.length}个 [${ids.join(',')}] | 最近打开子菜单=[${((s.menu && s.menu.items) || []).map((i) => i.label).join(' | ')}] | uptimeMs=${s.health && s.health.uptimeMs}`);
  /* ③ 出处闸门：日志里最后一条 ready 必须就是**本次启动**（argv 里的调试端口对得上）。
     少了这条，就分不清"boot N 真的起来了"与"boot N 被单实例锁弹回、我连到的还是上一个实例"。 */
  const rd = lastReady(app);
  const rdPort = rd && (rd.argv || []).find((a) => String(a).startsWith('--remote-debugging-port='));
  const provOk = !!rd && rdPort === `--remote-debugging-port=${app.port}` && String(rd.userData || '').toLowerCase() === app.profile.toLowerCase();
  console.log(`[身份闸门·${where}·出处] ${provOk ? '✓' : '✗'} 日志末条 ready: port=${rdPort} userData=${rd && rd.userData} recents=${((rd && rd.recents) || []).length}条`);
  if (!ok || !provOk) {
    console.error(`✗ 闸门未过（挂点=${ok} 出处=${provOk}）⇒ 拒绝出数。`);
    killTree(app.child && app.child.pid);
    process.exit(9);
  }
  return s;
}

/** 等到"文档换成了期望的绝对路径"（逐字符）——openPath 是异步推送，必须等落地再读。 */
async function waitDoc(app, page, wantPath, tries = 40, gap = 250) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await snap(page).catch(() => null);
    const got = last && last.doc && last.doc.filePath;
    if (wantPath === null ? !got : (got && got.toLowerCase() === String(wantPath).toLowerCase())) return last;
    await sleep(gap);
  }
  return last;
}

module.exports = {
  sleep, killTree, pidAlive, nameProcs, profileProcs, launch, enginePages, waitPages, pickPage, snap,
  menuLines, mruPaths, mruAlive, baseName,
  readRecentsFile, readSettingsFile, readDebugLog, logLines, logSize, logSince, lastReady,
  guardBoot, waitDoc, RULER,
};
