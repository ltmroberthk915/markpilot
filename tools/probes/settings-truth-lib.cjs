/** settings-truth 族（设置真源与迁移）共用尺子
 *
 *  为什么有这个小文件（AGENTS 错-4：同一件事不许有第二份实现）：
 *   · 启动范式只实现一次：直接 require startup-and-menus-lib.cjs 的 spawnApp/connect
 *     （spawn 产物 + 随机端口 + 独立 --user-data-dir + MP_DEBUG=1 + 删 ELECTRON_RUN_AS_NODE + connectOverCDP）；
 *   · 「一组相关读数必须一次 evaluate 拿全」（错-7 第 1 条）固化成一个 SNAP()；
 *   · 多窗口枚举/身份闸门/真源文件回读只实现一次：require session-truth-lib.cjs（本仓已验证的那一支）；
 *   · 产物一致性断言走 _probe-common.cjs（不许再写第二份 sha16）。
 *
 *  口径：只读产品目录；读写只在 .mp-verify 下。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const L = require(path.join(__dirname, 'startup-and-menus-lib.cjs'));
const STL = require(path.join(__dirname, 'session-truth-lib.cjs'));
const RULER = require(path.join(__dirname, '_probe-common.cjs'));

const sleep = L.sleep;
/** 本次探针实际用到的共享尺子指纹（读数写清"用哪把尺子"——错-3 第 2 条） */
function rulerPins() {
  return {
    'startup-and-menus-lib.cjs': RULER.sha16(path.join(__dirname, 'startup-and-menus-lib.cjs')),
    'session-truth-lib.cjs': RULER.sha16(path.join(__dirname, 'session-truth-lib.cjs')),
    '_probe-common.cjs': RULER.sha16(path.join(__dirname, '_probe-common.cjs')),
    'settings-truth-lib.cjs': RULER.sha16(__filename),
  };
}

/* ── 一次性读数（错-7 第 1 条：一组相关读数必须在**同一个 evaluate** 里取完）─────────
 *  分三层：
 *   ① 渲染侧：localStorage 全量、:root 变量（inline + computed）、面板 DOM（引擎已经渲染好的结果，
 *      不自己推断）、编辑器文档、matchMedia(prefers-color-scheme)；
 *   ② 壳层（主进程一手真源）：setting:get / theme:get / doc:info / recent:list / debug:sessions / health；
 *   ③ 全局：页面标题、焦点、活动元素。
 *  面板那一段是"读引擎已经算好并暴露出来的结果"（错-15）：滑杆 value、读数标签、勾选态都直接读 DOM。 */
const SNAP = async () => {
  const H = window.mpHost || {};
  const root = document.documentElement;
  const out = { at: Date.now(), url: location.href, title: document.title };
  const ls = {};
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); } } catch (e) { out.lsErr = String((e && e.message) || e); }
  out.ls = ls;
  const VARS = ['--mp-page-width', '--mp-zoom', '--mp-island-scale', '--mp-float-alpha', '--mp-float-blur',
    '--mp-outline-alpha', '--mp-outline-blur', '--mp-table-bar-alpha', '--mp-context-menu-alpha',
    '--mp-surface-alpha', '--mp-surface-blur'];
  const inline = {}, computed = {}; const cs = getComputedStyle(root);
  for (const k of VARS) { inline[k] = root.style.getPropertyValue(k); computed[k] = cs.getPropertyValue(k).trim(); }
  out.varsInline = inline; out.varsComputed = computed;
  out.dataset = { ...root.dataset };
  out.clientWidth = root.clientWidth;
  out.innerWidth = window.innerWidth;
  out.geom = { screenX: window.screenX, screenY: window.screenY, outerWidth: window.outerWidth, outerHeight: window.outerHeight, innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio };
  out.mmDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  out.hasFocus = document.hasFocus();
  out.active = (() => { const a = document.activeElement; return a ? String(a.id || a.className || a.tagName) : null; })();
  /* 注意：这里只放可序列化的数据（evaluate 的返回值要过序列化；函数属性会被丢掉） */
  const R = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  out.content = R('.cm-content');
  out.editorRect = R('.cm-editor');
  out.zoomComputed = (() => { const el = document.querySelector('.cm-editor'); return el ? getComputedStyle(el).zoom : null; })();
  const v = (window.mpEngine && typeof window.mpEngine._view === 'function') ? window.mpEngine._view() : null;
  out.editor = v ? { len: v.state.doc.length, head: String(v.state.doc.toString()).slice(0, 60) } : null;
  /* 引擎**已经算好并回显**的调色板状态（错-15：别自己推断"现在是深还是浅"）：
     themeApply() 里写了 root.dataset.editorTheme / root.dataset.mode，并暴露 window.mpTheme.current()。 */
  out.palette = {
    attrEditorTheme: (root.dataset && root.dataset.editorTheme) || null,
    attrMode: (root.dataset && root.dataset.mode) || null,
    mpThemeCurrent: (window.mpTheme && typeof window.mpTheme.current === 'function') ? window.mpTheme.current() : null,
  };
  const d = document.querySelector('.mp-dlg');
  out.panel = d ? {
    title: (d.querySelector('h3') || {}).textContent || null,
    scrollTop: d.scrollTop, scrollH: d.scrollHeight, clientH: d.clientHeight,
    sliders: [...d.querySelectorAll('input.mp-rng')].map((el) => {
      const td = el.closest('td');
      const n = td ? td.querySelector('.mp-num') : null;
      return { s: el.dataset.s || null, i: el.dataset.i || null, p: el.dataset.p || null, value: el.value, min: el.min, max: el.max, label: n ? n.textContent : null };
    }),
    restoreLast: (() => { const el = d.querySelector('#mp-restore-last'); return el ? el.checked : null; })(),
    statusbar: (() => { const el = d.querySelector('#mp-pref-statusbar'); return el ? el.checked : null; })(),
    outlineMode: (() => { const el = d.querySelector('input[name="mp-outline-mode"]:checked'); return el ? el.value : null; })(),
    imagePref: (() => { const el = d.querySelector('input[name="mp-image-pref"]:checked'); return el ? el.value : null; })(),
    typoPref: (() => { const el = d.querySelector('input[name="mp-typo-pref"]:checked'); return el ? el.value : null; })(),
  } : null;
  out.popCount = document.querySelectorAll('.mp-pop').length;
  const safe = async (fn) => { try { return await fn(); } catch (e) { return { __err: String((e && e.message) || e) }; } };
  out.sessions = await safe(() => H.debugSessions());
  out.doc = await safe(() => H.docInfo());
  out.recentList = await safe(() => H.recentList());
  out.themeGet = await safe(() => H.themeGet());
  out.settingRestoreLast = await safe(() => H.settingGet('restoreLast'));
  out.settingRecentFiles = await safe(() => H.settingGet('recentFiles'));
  out.settingTheme = await safe(() => H.settingGet('theme'));
  out.settingWinBounds = await safe(() => H.settingGet('winBounds'));
  out.settingUnknown = await safe(() => H.settingGet('legacyUnknownKey'));
  out.health = await safe(() => H.health());
  return out;
};
const snapAll = (page) => page.evaluate(SNAP);
/** 单键读数（面板滑杆的当前值 / 标签 —— 只读引擎渲染出来的结果） */
const readOne = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const td = el.closest('td'); const n = td ? td.querySelector('.mp-num') : null;
  const r = el.getBoundingClientRect();
  return { sel: s, value: el.value, checked: el.checked === undefined ? null : el.checked, label: n ? n.textContent : null,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
}, sel);

/* ── 窗口几何（两把尺子，都不许抛错）────────────────────────────────────────
 *  ① 渲染侧 window.outerWidth/outerHeight/screenX/screenY：Chromium 自报的**真实窗口几何**
 *     （本仓 outline-modes.cjs 已用它做过窗口尺寸验收，是已验证通道）；
 *  ② CDP Browser.getWindowForTarget：**本产物这版 Electron 没有 Browser 域**（实测报
 *     "wasn't found"）⇒ 只当"有没有"的事实记一笔，有就交叉印证，没有不致命。
 *  【踩过的坑】第一版把 ② 当硬读数并在阶段里抛错 ⇒ 那一阶段后面全没跑、实例也没回收，
 *  下一个阶段撞上单实例锁（新进程 code=0 直接退出）⇒ 连锁假红。所以这里绝不抛。 */
async function windowGeom(ctx, page) {
  const renderer = await page.evaluate(() => ({
    screenX: window.screenX, screenY: window.screenY,
    outerWidth: window.outerWidth, outerHeight: window.outerHeight,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
  }));
  let cdp = { ok: false, err: null };
  try {
    const s = await ctx.newCDPSession(page);
    try { const w = await s.send('Browser.getWindowForTarget'); cdp = { ok: true, windowId: w.windowId, bounds: w.bounds }; }
    finally { try { await s.detach(); } catch { /* 忽略 */ } }
  } catch (e) { cdp = { ok: false, err: String((e && e.message) || e).slice(0, 140) }; }
  return { renderer, cdp };
}

/* ── 设置面板：真实鼠标输入（page.mouse），不用 JS 造事件 ───────────────────── */
async function openSettingsPanel(page) {
  const mb = await readOne(page, '.mp-toolbar .mp-tb-item[data-mp-id="more"]');
  if (!mb) throw new Error('找不到「更多」按钮（.mp-tb-item[data-mp-id=more]）');
  const cx = mb.rect.x + mb.rect.w / 2, cy = mb.rect.y + mb.rect.h / 2;
  await page.mouse.move(cx, cy); await sleep(90);
  await page.mouse.down(); await sleep(60); await page.mouse.up();
  await sleep(500);
  const item = await page.evaluate(() => {
    for (const p of document.querySelectorAll('.mp-pop')) {
      for (const d of p.querySelectorAll('.mp-pop-item')) {
        const t = (d.textContent || '').trim();
        if (t === '设置' || t.startsWith('设置')) { const b = d.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, text: t }; }
      }
    }
    return null;
  });
  if (!item) throw new Error('弹层里找不到「设置」项');
  await page.mouse.move(item.x, item.y); await sleep(90);
  await page.mouse.down(); await sleep(60); await page.mouse.up();
  await sleep(600);
  const st = await page.evaluate(() => {
    const d = document.querySelector('.mp-dlg');
    if (!d) return null;
    return { title: (d.querySelector('h3') || {}).textContent || null,
      surfaces: d.querySelectorAll('input.mp-rng[data-s]').length,
      layout: d.querySelectorAll('input.mp-rng[data-p]').length,
      restoreLast: !!d.querySelector('#mp-restore-last'),
      scrollH: d.scrollHeight, clientH: d.clientHeight };
  });
  /* 断言"拿到的不是默认回退值"（错-7 第 2 条）：面板必须真的挂上。
     【口径】表面滑杆 8 条（data-s）+ 版式滑杆 3 条（data-p）+ 「启动」复选 1 个。
     第一版误写成"data-s 必须 11"（把两类混成一条）⇒ 面板明明开着却判失败，是尺子错、不是产品错。 */
  if (!st || st.surfaces !== 8 || st.layout !== 3 || !st.restoreLast) throw new Error('设置面板没打开或形态不对（期望 表面滑杆 8 + 版式滑杆 3 + 启动复选 1）：' + JSON.stringify(st));
  return { clickedMore: { cx, cy }, clickedItem: item, panel: st };
}

/** 让目标元素落进 .mp-dlg 的可视区（真实滚轮；面板是 overflow:auto 的滚动容器）。 */
async function ensureVisible(page, sel) {
  for (let i = 0; i < 10; i++) {
    const st = await page.evaluate((s) => {
      const el = document.querySelector(s); if (!el) return { missing: true };
      const d = document.querySelector('.mp-dlg'); if (!d) return { noDlg: true };
      const r = el.getBoundingClientRect(), dr = d.getBoundingClientRect();
      return { r: { x: r.x, y: r.y, w: r.width, h: r.height }, dr: { x: dr.x, y: dr.y, w: dr.width, h: dr.height },
        visible: r.top >= dr.top + 2 && r.bottom <= dr.bottom - 2 };
    }, sel);
    if (st.missing) throw new Error('面板里没有元素：' + sel);
    if (st.noDlg) throw new Error('面板不在场：' + sel);
    if (st.visible) return st;
    const below = st.r.y + st.r.h > st.dr.y + st.dr.h;
    const delta = below ? Math.min(320, (st.r.y + st.r.h) - (st.dr.y + st.dr.h) + 28) : -Math.min(320, (st.dr.y - st.r.y) + 28);
    await page.mouse.move(st.dr.x + st.dr.w / 2, st.dr.y + st.dr.h / 2); await sleep(70);
    await page.mouse.wheel(0, delta); await sleep(240);
  }
  throw new Error('滚不到可视区：' + sel);
}

/** 真实鼠标点击（按下-抬起分离，贴近真人） */
async function realClick(page, sel, { gap = 80 } = {}) {
  const st = await ensureVisible(page, sel);
  const before = await readOne(page, sel);
  const cx = st.r.x + st.r.w / 2, cy = st.r.y + st.r.h / 2;
  await page.mouse.move(cx, cy); await sleep(gap);
  await page.mouse.down(); await sleep(55); await page.mouse.up(); await sleep(260);
  return { cx, cy, before };
}

/** 真实拖动 range 滑杆（按下 → 多次移动 → 抬起；input 事件在拖动中逐次触发） */
async function dragSlider(page, sel, frac) {
  const st = await ensureVisible(page, sel);
  const y = st.r.y + st.r.h / 2;
  const x0 = st.r.x + 3, x1 = st.r.x + st.r.w - 3;
  const target = x0 + (x1 - x0) * Math.max(0, Math.min(1, frac));
  await page.mouse.move(x0, y); await sleep(70);
  await page.mouse.down(); await sleep(60);
  for (let i = 1; i <= 6; i++) { await page.mouse.move(x0 + (target - x0) * i / 6, y); await sleep(45); }
  await page.mouse.up(); await sleep(260);
  return await readOne(page, sel);
}
const closePanel = async (page) => page.evaluate(() => { const d = document.querySelector('.mp-dlg'); if (d) { const c = d.querySelector('.close'); if (c) c.click(); } return !document.querySelector('.mp-dlg'); });

/* ── 启动 / 关窗（只按自己的 PID 与 profile 收进程树）──────────────────────── */
/** 本次探针起过的实例（纪律 1：自己起的进程结束前全部 taskkill——阶段抛错也要收干净）。 */
const live = new Set();
/** 每个实例收尾时把页面错误/崩溃读数留一份（app 对象在收尾后就没了，报告要能追）。 */
const history = [];
function snapshotErrs(app, why) {
  try {
    history.push({ profile: path.basename(app.profile), why,
      counts: { pageerrors: (app.pageerrors || []).length, consoleErrors: (app.consoleErrors || []).length, crashes: (app.crashes || []).length },
      pageerrors: (app.pageerrors || []).slice(0, 5), consoleErrors: (app.consoleErrors || []).slice(0, 5), crashes: (app.crashes || []).slice(0, 5) });
  } catch { /* 忽略 */ }
}
const errTotals = () => history.reduce((a, h) => ({ pageerrors: a.pageerrors + h.counts.pageerrors, consoleErrors: a.consoleErrors + h.counts.consoleErrors, crashes: a.crashes + h.counts.crashes }), { pageerrors: 0, consoleErrors: 0, crashes: 0 });
async function launch({ exe, profile, keep = false, argv = [], env = {}, settings = null } = {}) {
  /* 单实例锁前置断言：同一 profile 还有活着的实例时，新进程会 requestSingleInstanceLock 失败、code=0 直接退出。
     那种"起不来"看起来像产品缺陷，其实是探针自己把门锁上了 ⇒ 这里直接报清楚。 */
  const stale = [...live].filter((a) => a.profile === profile && (() => { try { return L.alive(L.mainPidFor(profile)); } catch { return false; } })());
  if (stale.length) throw new Error(`同一 profile 还有活着的实例（单实例锁会把新进程挡掉）：${profile} pid=${L.pidsForProfile(profile).join(',')} ⇒ 先 closeApp/cleanupAll`);
  const app = await L.spawnApp({ exe, profile, uniqueProfile: false, keepProfile: !!keep, argv, extraEnv: env, settings });
  app.pageerrors = []; app.consoleErrors = []; app.crashes = []; app.killedBy = null;
  live.add(app);
  const { browser, ctx, page } = await L.connect(app);
  app.browser = browser; app.ctx = ctx; app.page = page;
  /* 页面错误/崩溃留痕复用 session-truth-lib 里那份已验证实现（错-4：不写第二份）。 */
  app.pages = await STL.enginePages(app);
  if (!app.pages.length) throw new Error('连上了 CDP 但一页引擎页都没有');
  app.mainPid = L.mainPidFor(app.profile);
  return app;
}

/** 点标题栏的 X（WM_CLOSE，进程外消息）→ 等进程自行退出；不退才 taskkill（纪律：关窗后不用渲染侧超时反推）。 */
async function closeApp(app, { title = 'MarkPilot', timeoutMs = 25000 } = {}) {
  const pid = L.mainPidFor(app.profile);
  const r = L.closeMainWindow(pid, title);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (!L.alive(pid)) break; await sleep(400); }
  const exited = !L.alive(pid);
  if (!exited) { app.killedBy = 'taskkill'; app.kill(); await sleep(900); }
  snapshotErrs(app, 'closeApp');
  live.delete(app);
  return { pid, close: r, exited, waitedMs: Date.now() - t0, killedBy: app.killedBy, pidsAfter: L.pidsForProfile(app.profile) };
}

/** 只关**一个**窗口（按标题子串，走同一支已验证的 WM_CLOSE 通道），等它从进程外窗口清单里消失。
 *  【为什么不能复用 closeApp】多窗口下 closeApp 等的是**整个进程**退出；A 还开着时它会一直等到超时再 taskkill，
 *  于是"关 B 看 A"这类用例会把两个窗口一起收掉。 */
async function closeWindowByTitle(app, title, { timeoutMs = 15000 } = {}) {
  const pid = L.mainPidFor(app.profile);
  const titlesBefore = L.myWindows(app.profile).map((w) => w.title);
  const r = L.closeMainWindow(pid, title);
  const t0 = Date.now();
  let titlesAfter = titlesBefore;
  while (Date.now() - t0 < timeoutMs) {
    titlesAfter = L.myWindows(app.profile).map((w) => w.title);
    if (!titlesAfter.some((t) => t.includes(title))) break;
    await sleep(350);
  }
  return { pid, close: r, titlesBefore, titlesAfter, gone: !titlesAfter.some((t) => t.includes(title)), waitedMs: Date.now() - t0 };
}

/** 兜底回收：任何阶段抛错后立刻把还活着的实例收掉。
 *  【为什么必须有】实测教训：某阶段在 windowBounds 上抛错 ⇒ 后续清理没跑 ⇒ 残留实例握着 profile 的
 *  单实例锁 ⇒ 下一阶段"重启"时新进程 requestSingleInstanceLock 失败、code=0 立即退出
 *  ⇒ 后面每一阶段都报"起不来"，看起来像产品缺陷，其实是探针自己把门锁上了。 */
async function cleanupAll(reason = '') {
  const killed = [];
  for (const app of [...live]) {
    try {
      const pid = L.mainPidFor(app.profile);
      if (pid && L.alive(pid)) { app.kill(); killed.push({ profile: path.basename(app.profile), pid, reason }); await sleep(700); }
      snapshotErrs(app, 'cleanupAll:' + reason);
    } catch { /* 忽略 */ }
    live.delete(app);
  }
  return killed;
}

/* ── 真源文件读写（.mp-verify 下）────────────────────────────────────────── */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { __err: String((e && e.message) || e) }; } }
function writeJson(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8'); return fs.statSync(file).size; }
const settingsPath = (profile) => path.join(profile, 'settings.json');
const recentsPath = (profile) => path.join(profile, 'recents.json');
function logOf(app) { return L.logAll(app); }
/** 本进程那一段日志（main-debug.log 是 appendFileSync 累积的，跨多次启动会串台）。
 *  【踩过的坑·两次】
 *  ① 第一版用"整份日志里有没有 settings:load"判"这次是不是首次运行"——前面几次启动的行还在，
 *    于是判据必然假红/假绿。口径：启动**之前**取字节偏移（logMark），启动之后只读这一段。
 *  ② 第二版对"全新 profile"也照取偏移：spawnApp(keep:false) 会先**删掉整个 profile**（连带旧日志），
 *    于是偏移量大于新日志长度 ⇒ slice 出来是空串 ⇒ 首启那几条判据全假红。
 *    口径：keep:false ⇒ 日志从 0 开始；keep:true ⇒ 才用当前文件大小当偏移。 */
function logMark(profile, keep = true) { if (!keep) return 0; try { return fs.statSync(path.join(profile, 'main-debug.log')).size; } catch { return 0; } }
function logSince(profile, mark) {
  try { const buf = fs.readFileSync(path.join(profile, 'main-debug.log')); return buf.slice(Math.min(mark, buf.length)).toString('utf8'); }
  catch { return ''; }
}
function logLinesOf(app, re) { return logOf(app).split(/\r?\n/).filter((l) => re.test(l)); }
function countOf(app, re) { return logLinesOf(app, re).length; }

/** 打开"第二窗口"（= 在资源管理器里再双击一个 .md：单实例锁把 argv 交给首实例的 second-instance）
 *  这一支照抄 startup-and-menus-probe-1.cjs 的**已验证通道**，只加落盘（错-14）。 */
async function openSecondWindow(app, docPath) {
  const before = L.winListAll(app.mainPid).map((w) => `${w.pid}:${w.cls}|${w.title}`);
  const env = { ...process.env, MP_DEBUG: '1', MP_TEST_HOOKS: '1', MP_MIGRATE_FROM: path.join(app.profile, '__no-such-legacy-profile__') };
  delete env.ELECTRON_RUN_AS_NODE;
  const c2 = spawn(app.exe, [docPath, `--user-data-dir=${app.profile}`], { env, stdio: 'ignore' });
  const wait = await L.waitMyWindow(app.profile, new RegExp(path.basename(docPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), { timeoutMs: 15000 });
  const pages = await STL.waitPages(app, 2, 40, 500);
  return { spawnedPid: c2.pid, wait, pages, winsBefore: before, winsAfter: L.winListAll(app.mainPid).map((w) => `${w.pid}:${w.cls}|${w.title}`) };
}

/** 把两个引擎页按"壳层自报的文档名"分派到 A/B（读 debugSessions/docInfo 的**壳层真源**，不靠标题猜）。 */
async function tagPages(pages) {
  const tagged = {};
  for (const p of pages) {
    const s = await snapAll(p);
    const name = s.doc && s.doc.name;
    tagged[name || ('page-' + (s.sessions && s.sessions.mine))] = { page: p, snap: s };
  }
  return tagged;
}

module.exports = {
  L, STL, RULER, sleep, rulerPins, SNAP, snapAll, readOne, windowGeom,
  openSettingsPanel, ensureVisible, realClick, dragSlider, closePanel,
  launch, closeApp, closeWindowByTitle, cleanupAll, live, history, errTotals,
  readJson, writeJson, settingsPath, recentsPath,
  logOf, logLinesOf, countOf, logMark, logSince, openSecondWindow, tagPages,
};
