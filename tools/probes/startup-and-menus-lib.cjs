/** startup-and-menus 族共用夹具（AGENTS 错-4：同一件事只许一份实现）
 *
 *  提供：spawnApp（独立 profile + 随机调试端口 + MP_DEBUG=1 + delete ELECTRON_RUN_AS_NODE）
 *        connect（playwright-core connectOverCDP，40×1s 重试）
 *        enginePage（找带 mpEngine/mpHost 的那一页）
 *        logTail / logSince（主进程一手事实：userData\main-debug.log）
 *        state（一次 evaluate 拿全的渲染侧读数，禁止跨调用拼装）
 *        injectKey（主进程 webContents.sendInputEvent —— 官方挂点 recent:test-send-key）
 *        winList（EnumWindows 按 PID 列顶层窗口：主窗口与原生对话框都在里面）
 *
 *  【为什么键盘必须有两把尺子】主进程 main.js 里写明并实测过：CDP 注入的键在 Electron 里
 *  **既不触发加速键、也不落 before-input-event**。所以「加速键到底响没响」只能问主进程那条注入路径；
 *  本族把两条都量一遍并把差异写进结论，不拿 CDP 的绿/红冒充加速键的绿/红。
 *
 *  口径：只读（不写产品目录），读写只在 .mp-verify 下。
 */
'use strict';
const path = require('node:path');
/* ── 自适应头（公开快照专用，自动注入 ✓）──────────────────────────────────
   开发态：本文件在 <repo>/.mp-verify/checklist/；公开快照：<repo>/tools/probes/ ✓
   ⇒ 两种情况下"上溯两级"都是仓库根 ✓，工作目录若不存在就建在**系统临时目录**里 ✓
   （这样别人 clone 下来能直接跑，不会写进仓库 ✗）。可用 MP_WORK / MP_EXE 覆盖 ✓。 */
const __MP_OS = require('node:os');
const __MP_REPO = path.resolve(__dirname, '..', '..');
const __MP_WORK = process.env.MP_WORK || path.join(__MP_OS.tmpdir(), 'markpilot-verify');
const __MP_EXE = process.env.MP_EXE || path.join(__MP_REPO, 'MarkPilot-CM6', 'dist', 'win-unpacked', 'MarkPilot.exe');
try { require('node:fs').mkdirSync(__MP_WORK, { recursive: true }); } catch { /* 建不了就由调用方报错 */ }
const fs = require('node:fs');

const { spawn, execSync, execFileSync } = require('node:child_process');
const { chromium } = require('../quality/dependencies.cjs').playwright();

const EXE = process.argv[2] || __MP_EXE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从 user-data-dir 里读 Chromium 实际写的调试端口（比"猜一个端口然后连"稳） */
function devtoolsPort(profileDir, timeoutMs = 60000) {
  const f = path.join(profileDir, 'DevToolsActivePort');
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      try {
        const line = fs.readFileSync(f, 'utf8').split(/\r?\n/)[0].trim();
        if (/^\d+$/.test(line)) return resolve(Number(line));
      } catch { }
      if (Date.now() - t0 > timeoutMs) return resolve(null);
      setTimeout(tick, 250);
    };
    tick();
  });
}

/** CDP HTTP 端点是否真的通（不是"端口文件写了没有"）——/json/version 200 才算通。
 *  【为什么必须要这一条】实测过一次：DevToolsActivePort 已写、端口却没在监听（Chromium 先写文件后建
 *  listener 的竞态）。只看文件就会立刻去连，然后拿到一个"连不上"的假读数。 */
async function cdpUp(port, timeoutMs = 800) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

/** 启动一份被测产物。opts.extraEnv 覆盖/追加环境变量（默认 MP_DEBUG=1 + MP_TEST_HOOKS=1）。
 *
 *  【错-1 同族：读过一次假读数】固定 profile 路径 + `rmSync` 有个致命组合：若**另一个**实例
 *  （别人的探针 / 上一轮没死透的进程）正持有该 profile，Windows 删不掉，`rmSync` 会**静默留下**
 *  上一轮的 `DevToolsActivePort`；这时新进程还没写端口，而读端已经拿到**上一轮的端口号**（实测 9343），
 *  于是"端口文件写了、端口却没监听"，整轮读数全废。
 *  因此这里的三道硬性：
 *    ① profile 路径**每次运行唯一**（pid + 时间戳），从根上排除串台；
 *    ② 启动前**断言** profile 为空、`DevToolsActivePort` 不存在；删不掉就抛（宁可不跑，也不出假数）；
 *    ③ 端口成立的条件是 **"json/version" 真的 200**，不是"文件里写了数字"。 */
async function spawnApp({ exe = EXE, profile, argv = [], extraEnv = {}, cwd, readyTimeoutMs = 30000, uniqueProfile = true, settings = null, keepProfile = false } = {}) {
  const runProfile = uniqueProfile && !/-r\d+$/.test(profile)
    ? `${profile}-r${process.pid}${Date.now().toString(36).slice(-4)}`
    : profile;
  /* keepProfile=true：**保留** profile 原样重启（"关掉再打开"这类用例必须走这条）。
     【踩过的坑】默认路径会先 `rmSync` 再 mkdir —— 对"重启"用例来说这等于把上一轮写好的
     settings.json / recents.json 全删掉，于是 restoreLast 那类判据永远读到空 MRU
     （本轮实测：探针自己把前提删了，还以为是产品的缺陷）。 */
  if (!keepProfile) {
    // ② 前置断言：删干净才允许启动
    for (let i = 0; i < 6; i++) {
      try { fs.rmSync(runProfile, { recursive: true, force: true }); } catch (e) { if (i === 5) throw new Error(`profile 删不掉（被别的进程占用？）：${runProfile} ⇒ ${e.message}`); }
      if (!fs.existsSync(runProfile)) break;
      await sleep(400);
    }
    fs.mkdirSync(runProfile, { recursive: true });
    const leftovers = fs.readdirSync(runProfile);
    if (leftovers.length) throw new Error(`profile 没清干净（残留 ${leftovers.slice(0, 4).join(',')}）⇒ 拒绝用它会串到上一轮的端口：${runProfile}`);
    if (fs.existsSync(path.join(runProfile, 'DevToolsActivePort'))) throw new Error('清干净的 profile 里仍有 DevToolsActivePort ⇒ 拒绝启动');
    /* settings 预置：必须在启动**之前**写（启动后主进程会读它并可能覆写）。 */
    if (settings) fs.writeFileSync(path.join(runProfile, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
  } else {
    fs.mkdirSync(runProfile, { recursive: true });
    if (settings) fs.writeFileSync(path.join(runProfile, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
    if (fs.existsSync(path.join(runProfile, 'DevToolsActivePort'))) { try { fs.rmSync(path.join(runProfile, 'DevToolsActivePort'), { force: true }); } catch { } }
  }

  /* 【错-1 同族：吃过一次大亏】产品在启动期有一条「改名迁移」：新 userData 里**没有** settings.json
   *  而 `%APPDATA%\MarkPilot CM6` 存在 ⇒ 把**真实旧 profile 整目录拷进新 profile**（main.js:32-54）。
   *  后果（实测）：独立 profile 里凭空出现真实的 `main-debug.log`、`lockfile`、`settings.json`，
   *  甚至一个**上一轮的 `DevToolsActivePort`（端口 9343）**——于是探针读到"端口文件写好了"、
   *  实际那个端口根本没在监听，整轮读数作废。
   *  解法用产品自己留的测试缝 `MP_MIGRATE_FROM`（main.js 注释里写明它就是给探针用的）：
   *  指到一个**不存在**的目录 ⇒ 迁移源为空 ⇒ 不迁移（`fsSync.existsSync(settingsOld)` 为假直接返回）。
   *  这既不动产品代码，也不碰真实用户数据。 */
  const env = {
    ...process.env, MP_DEBUG: '1', MP_TEST_HOOKS: '1',
    MP_MIGRATE_FROM: path.join(runProfile, '__no-such-legacy-profile__'),
    ...extraEnv,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  /* 【端口怎么定：不许再靠 DevToolsActivePort】实测（diag5 A/B）：
   *   `--user-data-dir` 放在 `--remote-debugging-port` **前面**时，Chromium **根本不写**
   *   `DevToolsActivePort` 文件（端口照样监听）；而文件里若残留上一轮的值，读端就会拿到一个
   *   早就没人监听的端口 ⇒ "端口文件写了、端口却没监听"的假读数。所以改成：
   *   自己选一个端口 → 命令行显式给 → 用 **HTTP 探活**确认这个端口真的在服务（并回读 Browser 版本）。 */
  const port = pickPort();
  const args = [...argv, `--user-data-dir=${runProfile}`, `--remote-debugging-port=${port}`];
  const child = spawn(exe, args, { env, stdio: 'ignore', cwd: cwd || undefined });
  const app = {
    child, port, profile: runProfile, argv, env: extraEnv, cwd, exe, requestedPort: port,
    logFile: path.join(runProfile, 'main-debug.log'),
    exit: null, exitAt: null, attempts: 0,
    /* 【纪律】清理只按自己的 PID 收进程树。绝不 /IM 或按启动时间批量杀（见 killTree 注释）。 */
    kill: () => killTree(child.pid),
  };
  child.on('exit', (code, sig) => { app.exit = { code, sig, at: Date.now() }; app.exitAt = Date.now(); });
  const t0 = Date.now();
  while (Date.now() - t0 < readyTimeoutMs) {
    if (app.exit) throw new Error(`进程已退出（code=${app.exit.code}）⇒ 起不来；argv=${JSON.stringify(argv)}`);
    app.attempts++;
    if (await cdpUp(port)) { app.version = await cdpVersion(port); return app; }
    await sleep(250);
  }
  app.kill();
  try {
    const files = fs.readdirSync(runProfile);
    const lg = (() => { try { return fs.readFileSync(path.join(runProfile, 'main-debug.log'), 'utf8').split(/\r?\n/).slice(-3).join(' ⏎ '); } catch { return '(无日志)'; } })();
    throw new Error(`等不到可用的 CDP 端点（profile=${runProfile}，端口 ${port}，${Math.round((Date.now() - t0) / 1000)}s，轮询 ${app.attempts} 次）`
      + `\n  profile 内容=${files.slice(0, 12).join(',')}（共 ${files.length}）`
      + `\n  日志尾=${lg}`);
  } catch (e) { if (String(e.message).startsWith('等不到')) throw e; throw new Error(`等不到可用的 CDP 端点（profile=${runProfile}，端口 ${port}）：${e.message}`); }
}

/** connectOverCDP + 等引擎页出现（mpEngine + mpHost 双就位）。
 *  【为什么要"换端口重起"】一旦 CDP 会话被拆过（关窗/关页），Chromium 可能不再接受新的 CDP 连接，
 *  用它继续量只会得到超时假读数（错-7 现象③）。这里的口径是：连不上就换一个新端口重起一份，重试。 */
async function connect(app, { engineTimeoutMs = 60000, reconnectTries = 3 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= reconnectTries; attempt++) {
    if (attempt > 1) {
      app.kill(); await sleep(1200);
      const fresh = await spawnApp({ exe: app.exe || EXE, profile: app.profile, argv: app.argv || [], extraEnv: app.env || {}, cwd: app.cwd, uniqueProfile: false, keepProfile: true });
      app.child = fresh.child; app.port = fresh.port; app.exit = null;
      app.kill = fresh.kill;
      app.reconnected = (app.reconnected || 0) + 1;
    }
    let browser = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 30000 && !browser) {
      if (!(await cdpUp(app.port, 700))) { await sleep(700); continue; }
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${app.port}`, { timeout: 8000 }); }
      catch (e) { lastErr = e; await sleep(900); }
    }
    if (!browser) continue;
    const ctx = browser.contexts()[0];
    const deadline = Date.now() + engineTimeoutMs;
    while (Date.now() < deadline) {
      for (const p of ctx.pages().filter((x) => !x.url().startsWith('devtools://'))) {
        const ok = await p.evaluate(() => { try { return !!(window.mpEngine && window.mpHost); } catch { return false; } }).catch(() => false);
        if (ok) return { browser, ctx, page: p, attempt };
      }
      await sleep(500);
    }
    await browser.close().catch(() => { });
  }
  throw new Error(`CDP 连不上/找不到引擎页（重试 ${reconnectTries} 次；最后错误 ${lastErr && lastErr.message}；端口 ${app.port}）`);
}

/** CDP 端口挑选：按 pid+mtime 散列到 9620..9979，先排除本机正在监听的端口。
 *  同时探多个候选（并行子进程各挑各的），重复概率极低；真要撞上，探活会失败并报错而不出假数。 */
function pickPort() {
  let used = new Set();
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const l of out.split(/\r?\n/)) { const m = /:(\d+)\s+.*LISTENING/i.exec(l); if (m) used.add(Number(m[1])); }
  } catch { }
  const seed = (process.pid * 2654435761 + Date.now()) >>> 0;
  for (let i = 0; i < 240; i++) {
    const p = 9620 + ((seed + i * 7) % 360);
    if (!used.has(p)) return p;
  }
  return 9620 + (seed % 360);
}

/** 回读这份 CDP 端点的身份（用于证明"连上的是被测产物"，不是别的 Chromium） */
async function cdpVersion(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    const j = await r.json();
    return { browser: j.Browser, ua: (j['User-Agent'] || '').slice(0, 60) };
  } catch { return null; }
}

/** 主进程一手事实：读 userData\main-debug.log。since=字节偏移 ⇒ 只返回新行。 */
function logSince(app, since = 0) {
  let buf;
  try { buf = fs.readFileSync(app.logFile); } catch { return { lines: [], size: 0, text: '' }; }
  const text = buf.slice(Math.min(since, buf.length)).toString('utf8');
  return { lines: text.split(/\r?\n/).filter(Boolean), size: buf.length, text };
}
const logSize = (app) => { try { return fs.statSync(app.logFile).size; } catch { return 0; } };
const logAll = (app) => { try { return fs.readFileSync(app.logFile, 'utf8'); } catch { return ''; } };

/** 等主进程写出它的启动事实行 `ready {…}` 并**解析成对象**（返回 {line, json}）。
 *  【为什么要等 + 为什么解析而不是正则】主进程用 appendFileSync 逐行追加，探针读的是同一个文件；
 *  固定 sleep 会撞上"还没落盘"的窗口（本轮实测：同一份日志一次读得到、一次读不到，害得启动判据三连假红）。
 *  口径：等到 `ready` 行出现**且日志字节数连续两轮不变**为止；解析失败就返回 json:null 如实记账。 */
async function waitReady(app, { timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  let line = '', lastSz = -1;
  while (Date.now() - t0 < timeoutMs) {
    const sz = logSize(app);
    line = logAll(app).split(/\r?\n/).find((l) => / ready \{/.test(l)) || '';
    if (line && sz === lastSz) break;
    lastSz = sz;
    await sleep(250);
  }
  let json = null;
  try { json = JSON.parse(line.slice(line.indexOf('{'))); } catch { json = null; }
  return { line, json, waitedMs: Date.now() - t0 };
}

/** 渲染侧一次拿全的读数（AGENTS 错-7：禁止跨 evaluate 拼装） */
const READ_STATE = () => {
  const out = { ok: false };
  try {
    const v = window.mpEngine && window.mpEngine._view && window.mpEngine._view();
    out.ok = !!v;
    out.title = document.title;
    out.hasFocus = document.hasFocus();
    out.active = (() => { const a = document.activeElement; return a ? (a.className || a.tagName) : null; })();
    out.docLen = v ? v.state.doc.length : -1;
    out.docHead = v ? v.state.doc.toString().slice(0, 120) : null;
    out.selFrom = v ? v.state.selection.main.from : -1;
    out.mpHref = (() => { try { return document.querySelector('base') ? document.querySelector('base').getAttribute('href') : null; } catch { return null; } })();
    out.docDir = (() => { try { return window.__mpDocDir || null; } catch { return null; } })();
    out.dbg = (() => { try { const d = window.__mpDbg || {}; return { init: d.init || 0, docEvents: d.docEvents || 0, saveTraceLen: (d.saveTrace || []).length, saveTrace: (d.saveTrace || []).slice(-6) }; } catch { return null; } })();
    out.banner = (() => { try { const b = document.getElementById('mp-banner'); return b && b.style.display !== 'none' ? (b.textContent || '').slice(0, 160) : null; } catch { return null; } })();
    out.confirmTrap = window.__mpConfirmTrap ? window.__mpConfirmTrap.slice(-6) : null;
    out.rendererDirty = (() => { try { return /^●/.test(document.title); } catch { return null; } })();
  } catch (e) { out.err = String((e && e.message) || e); }
  return out;
};
const readState = (page) => page.evaluate(READ_STATE);

/** 主进程注入按键（官方挂点；返回 focused/focusWaitedMs —— 失焦时必须当成"这次不算数"） */
async function injectKey(page, payload) {
  return page.evaluate((p) => window.mpHost.recentTestSendKey(p), payload);
}
const K = {
  n: { keyCode: 'N', modifiers: ['control'] },
  o: { keyCode: 'O', modifiers: ['control'] },
  s: { keyCode: 'S', modifiers: ['control'] },
  shiftS: { keyCode: 'S', modifiers: ['control', 'shift'] },
  w: { keyCode: 'W', modifiers: ['control'] },
};

/** 前台自证：Ctrl+Shift+L（视图→切换主题）**真的改变了界面**才说明窗口拿到了窗口级加速键。
 *  【为什么不用 isFocused()】实测它会撒谎：wasFocused=false 却报了 focused=true，而同一次注入
 *  的 Ctrl+O 根本没弹出原生框 ⇒ "拿到前台"这件事必须有**可观测效果**才算数。
 *  本函数切两次（切走再切回），不留副作用，返回 {ok, seq}。 */
async function proveForeground(page) {
  const themeId = () => page.evaluate(() => { try { return document.documentElement.getAttribute('data-mp-theme') || localStorage.getItem('editor-theme') || null; } catch { return null; } });
  const seq = [await themeId()];
  const inj = [];
  for (let i = 0; i < 2; i++) {
    inj.push(await injectKey(page, { keyCode: 'L', modifiers: ['control', 'shift'] }).catch((e) => ({ ok: false, error: String(e.message || e) })));
    await sleep(1200);
    seq.push(await themeId());
  }
  const ok = !!seq[0] && seq[0] !== seq[1] && seq[1] !== seq[2];
  return { ok, seq, inj, restored: seq[0] === seq[2] };
}

/** EnumWindows 按 PID 列顶层窗口：主窗口与原生对话框（类名 #32770）都在里面。
 *  这是"原生对话框到底出没出"的**进程外**读数，不靠渲染侧超时反推。
 *  实现落在 startup-and-menus-dlg.ps1（同一个文件同时提供 list / close，避免两份实现漂移）。 */
/** 跑 pwsh 并**按 utf8 解码**（不指定 encoding 时 Node 用系统代码页 GBK 解，中文标题会全体乱码） */
function runPwsh(args, timeout = 20000) {
  const r = execFileSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return Buffer.isBuffer(r) ? r.toString('utf8') : String(r);
}

function psWinList(pid, mode = 'all') {
  const script = path.join(__dirname, 'startup-and-menus-dlg.ps1');
  try {
    const out = runPwsh(['-File', script, mode, '-TargetPid', String(pid)]);
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter((s) => !/^Write|^Parser|^\s*\+|^\s*\|/.test(s)).map((line) => {
      const parts = line.split('|');
      return { raw: line, line, hwnd: parts[0] || '', cls: parts[1] || '', vis: parts[2] || '', title: parts.slice(3).join('|') };
    });
  } catch (e) { return [{ raw: 'ERR:' + String((e && e.message) || e).slice(0, 120), line: 'ERR', cls: '', title: '' }]; }
}

/* ── 原生对话框（#32770）────────────────────────────────────────────────────────
 *  【为什么必须有这一条】Electron 的 `dialog.showOpenDialog/showSaveDialog` 是**原生模态框**：
 *  它挂在主进程的 await 上，渲染侧那次 invoke **永不 resolve**；只要框还开着，之后任何
 *  `page.evaluate` 都会超时（实测整轮探针就这样静默挂死）。
 *  ⇒ 关框只能从**进程外**做：PostMessage(WM_CLOSE) 打到**我自己 PID** 的那个 #32770 窗口上
 *  （等价于点「取消」）。绝不按类名/标题批量关——同机有别的探针在跑同名产物。
 *  【通道口径】这一步是"替用户点取消"，不是被测行为本身；被测结论只用到"框确实弹出过"。 */
function dlgRaw(pid) { return psWinList(pid, 'all').map((x) => x.raw); }
/** 本应用的全部顶层窗口（类名+可见性+标题），进程外读数 */
const winListAll = (pid) => psWinList(pid, 'all');
/** 只列原生对话框（类名 #32770） */
const winList = (pid) => psWinList(pid, 'list').map((x) => x.raw);
const dlgList = (pid) => psWinList(pid, 'list');
const dlgCount = (pid) => dlgList(pid).length;

/** 外部关框（WM_CLOSE）：返回关掉几个 + 关后残余。pid 可以是**窗口所属的主进程 id**
 *  （用 mainPidFor(profile) 取，别用 spawn 返回的 child.pid —— 那个是启动器，窗口在它的子进程上）。 */
function closeDialogs(pid) {  const script = path.join(__dirname, 'startup-and-menus-dlg.ps1');
  let closed = null, hit = '';
  try {
    const out = runPwsh(['-File', script, 'close', '-TargetPid', String(pid)]);
    const m = /closed=(.*)/.exec(out);
    if (m) { hit = m[1].trim(); closed = hit ? hit.split(' ; ').length : 0; }
  } catch (e) { closed = 'ERR:' + String((e && e.message) || e).slice(0, 80); }
  return { closed, hit, rest: dlgList(pid) };
}

/** 关**主窗口**（= 点标题栏的 X）：只按"我自己的 PID + 标题含 title + 任意类名"匹配。
 *  用途：脏文档关窗提示必须由**真·关窗消息**触发（渲染侧没挂 beforeunload，Ctrl+W 也不关窗）。 */
function closeMainWindow(pid, title = 'MarkPilot') {
  const script = path.join(__dirname, 'startup-and-menus-dlg.ps1');
  try {
    const out = runPwsh(['-File', script, 'close', '-TargetPid', String(pid), '-Scope', 'any', '-Title', title]);
    const m = /closed=(.*)/.exec(out);
    return { hit: m ? m[1].trim() : null, ok: !!m && m[1].trim().length > 0 };
  } catch (e) { return { hit: 'ERR:' + String((e && e.message) || e).slice(0, 100), ok: false }; }
}

/** 等 #32770 出现：返回 {seenMs, wins, closed}；没有就如实报"没等到"。
 *  【为什么要 canRetry】窗口级加速键要求窗口真的在前台；`isFocused()` 会撒谎（实测：wasFocused=false
 *  而 focused=true、按键却没触发加速键）。所以等待期间**反复补发**注入，直到框出现或超时——
 *  它补的是"真的拿到前台"这个前提，不是绕过判据（框没出现就照实报 seen:false）。
 *  【keepAlive 口径】"取消/放弃保存"是个既成事实，**文档状态由产品决定、不由我决定**：
 *  实测在原生框上按 Esc 时，Electron 照样把 saveAsFlow/closeFile 走完（保存链路里出现 doc:path:write）。
 *  所以我只做"有没有框、框还在不在"的事实记录，不对文档状态下判据——否则会把产品行为误报成缺陷。 */
async function waitAndCloseDialog(pid, { timeoutMs = 8000, keepOpen = false, pollMs = 350, canRetry = null, keepAlive = false } = {}) {
  const t0 = Date.now();
  let wins = [];
  let attempts = 0;
  while (Date.now() - t0 < timeoutMs) {
    wins = dlgList(pid);
    if (wins.length) break;
    if (Date.now() - t0 > attempts * Math.max(1200, pollMs * 4) && attempts < 4) {
      attempts++;
      if (typeof canRetry === 'function') { try { await canRetry(attempts); } catch { } }
    }
    await sleep(pollMs);
  }
  const seenMs = wins.length ? Date.now() - t0 : null;
  if (keepOpen || !wins.length) return { seen: wins.length > 0, seenMs, wins, close: null, rest: wins, attempts };
  const close = closeDialogs(pid);
  if (keepAlive) return { seen: true, seenMs, wins, close: close.closed, rest: close.rest, attempts, keptAlive: true };
  return { seen: true, seenMs, wins, close: close.closed, rest: close.rest, attempts };
}

/** 进程是否还活着（不靠渲染侧超时反推） */
function alive(pid) {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return /MarkPilot\.exe/i.test(out);
  } catch { return false; }
}
const anyMarkPilot = () => {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq MarkPilot.exe" /NH /FO CSV', { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).filter((l) => /MarkPilot\.exe/i.test(l)).length;
  } catch { return -1; }
};
/* 【纪律·2026-10-10 本会话踩过】清理只能用**自己那个 PID 的进程树**（taskkill /PID x /T /F）。
 *  绝不许按进程名或"启动时间在最近 N 分钟内"批量杀：本机同时有别的探针在跑同名的被测产物，
 *  按时间过滤会把别人的实例一起收掉（本轮实际误杀过 13 个非自有进程）。 */
const killTree = (pid) => { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; } };

/** 把所有 MP TEST 弹窗陷阱装好：记录 window.confirm/alert 的调用并**自动回指定答案**。
 *  为什么要这层：confirm 会**阻塞渲染线程**，evaluate 会一起超时（错-7 现象③ 的同族）。
 *  装陷阱 = 把"弹了没弹、弹了几次"变成可读读数，而不是靠超时反推。 */
async function installDialogTrap(page, answers) {
  await page.evaluate((ans) => {
    window.__mpConfirmTrap = [];
    if (!window.__mpDialogPatched) {
      window.__mpDialogPatched = true;
      const oConfirm = window.confirm.bind(window);
      const oAlert = window.alert.bind(window);
      const oPrompt = window.prompt.bind(window);
      window.__mpConfirmReplies = [];
      window.confirm = (m) => { window.__mpConfirmTrap.push({ kind: 'confirm', m: String(m) }); const a = window.__mpConfirmReplies.length ? window.__mpConfirmReplies.shift() : true; return a; };
      window.alert = (m) => { window.__mpConfirmTrap.push({ kind: 'alert', m: String(m) }); };
      window.prompt = (m) => { window.__mpConfirmTrap.push({ kind: 'prompt', m: String(m) }); return null; };
      window.__mpOrig = { confirm: oConfirm, alert: oAlert, prompt: oPrompt };
    }
    window.__mpConfirmReplies = Array.isArray(ans) ? ans.slice() : [];
  }, answers || []);
}
const takeDialogTrap = async (page) => page.evaluate(() => { const t = window.__mpConfirmTrap || []; window.__mpConfirmTrap = []; return t; });
const restoreDialogs = async (page) => page.evaluate(() => {
  if (window.__mpOrig) { window.confirm = window.__mpOrig.confirm; window.alert = window.__mpOrig.alert; window.prompt = window.__mpOrig.prompt; window.__mpDialogPatched = false; }
});

/** 判据小工具：把"期望 vs 实得"写成一行，避免散文 */
function chk(name, got, want, extra) {
  const ok = typeof want === 'function' ? !!want(got) : JSON.stringify(got) === JSON.stringify(want);
  return { name, ok, got, want: typeof want === 'function' ? String(want) : want, ...(extra ? { extra } : {}) };
}

/** 一次运行内**固定**的 profile 路径：先删干净，再交给调用方（多个用例需要"同一个 profile 重启"，
 *  这时必须用稳定路径 + uniqueProfile:false，否则重启就落到另一个目录上，重启语义全丢）。 */
function stableProfile(dir, name) {
  const p = path.join(dir, name);
  for (let i = 0; i < 6; i++) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { }
    if (!fs.existsSync(p)) break;
    execSync('cmd /c ping -n 2 127.0.0.1 >nul', { stdio: 'ignore', windowsHide: true });
  }
  if (fs.existsSync(p)) throw new Error(`stableProfile 删不掉：${p}`);
  return p;
}

/** 按 `--user-data-dir` 精确找出**属于某个 profile 的进程 id**。
 *  【为什么必须有】同机有别的探针在跑同名产物，`tasklist` 只能给名字；而"窗口标题"也不唯一
 *  （实测撞过一次：另一个实例的窗口标题同样是 "K-按键.md — MarkPilot"）。命令行里的 user-data-dir
 *  是唯一能把进程判给我自己的依据。 */
function pidsForProfile(profile) {
  const want = String(profile).toLowerCase();
  try {
    const out = runPwsh(['-NoProfile'.replace('-NoProfile', '-Command'), `
      $r = @()
      foreach ($p in Get-Process MarkPilot -ErrorAction SilentlyContinue) {
        $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction SilentlyContinue).CommandLine
        if ($cl -and $cl.ToLower().Contains('${want.replace(/'/g, "''")}')) { $r += $p.Id }
      }
      $r -join ','
    `]);
    return out.trim().split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  } catch { return []; }
}
/** 只在"我自己的那些 pid"里找窗口：返回 [{pid, hwnd, cls, vis, title}] */
const myWindows = (profile) => pidsForProfile(profile).flatMap((pid) => winListAll(pid).map((w) => ({ pid, ...w })));
/** 我自己的主窗口（类名非 #32770、标题含 MarkPilot） */
const myMainWindow = (profile) => myWindows(profile).find((w) => w.cls !== '#32770' && /MarkPilot/.test(w.title)) || null;
/** 我自己的原生对话框 */
const myDialogs = (profile) => myWindows(profile).filter((w) => w.cls === '#32770');
/** 我的窗口所在的那个主进程 id（有窗口的第一个 pid）；没有窗口时回落 null。
 *  【踩过的坑】`spawn()` 返回的 pid 是**启动器进程**，Windows 上 Electron 会再起一个子进程承载窗口；
 *  用 spawn 的 pid 去 EnumWindows 会一个窗口都找不到（本轮实测：winList 恒空），
 *  而"关主窗口"却因为参数解析问题恰好打到了别的实例上。一律用本函数取 pid。 */
function mainPidFor(profile) {
  const pids = pidsForProfile(profile);
  for (const p of pids) if (winListAll(p).some((w) => /MarkPilot/.test(w.title))) return p;
  return pids[0] || null;
}

/** 等"我自己的某个窗口标题里出现 want"（进程外读数；文件打开是异步的，固定 sleep 会假红） */
async function waitMyWindow(profile, want, { timeoutMs = 8000 } = {}) {
  const t0 = Date.now();
  let wins = [];
  const re = want instanceof RegExp ? want : new RegExp(String(want));
  while (Date.now() - t0 < timeoutMs) {
    wins = myWindows(profile);
    const hit = wins.find((w) => re.test(w.title));
    if (hit) return { ok: true, hit, wins, waitedMs: Date.now() - t0 };
    await sleep(400);
  }
  return { ok: false, hit: null, wins, waitedMs: Date.now() - t0 };
}

module.exports = {
  EXE, sleep, devtoolsPort, spawnApp, connect, logSince, logSize, logAll, stableProfile, waitReady,
  readState, READ_STATE, injectKey, K, proveForeground, winList, alive, anyMarkPilot, killTree,
  installDialogTrap, takeDialogTrap, restoreDialogs, chk, cdpUp, cdpVersion, pickPort,
  dlgList, dlgCount, closeDialogs, waitAndCloseDialog, closeMainWindow, winListAll,
  pidsForProfile, myWindows, myMainWindow, myDialogs, mainPidFor, waitMyWindow,
};
