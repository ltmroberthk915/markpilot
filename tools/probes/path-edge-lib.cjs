/** family=path-edge · 探针共用库（第三波·路径异常族）
 *
 *  纪律落点：
 *   · 错-4：启动/找页/快照**不另写一份** —— 直接 require 已验证的 `file-ops-real-lib.cjs`
 *           （它内部又 require `_probe-common.cjs` 做 sha16 尺子卡）。这里只加"路径异常"
 *           特有的夹具能力：junction / ACL 拒写 / 映射网络盘 / subst / 端口挑选。
 *   · 错-7：一组相关读数**一次 evaluate 拿全**（peSnap 里把 docInfo/MRU/菜单模型/提示条一起取）。
 *   · 错-8：现象与推断矛盾时读壳层一手事实 `userData/main-debug.log`（F.shellLog）。
 *   · 错-13：本族**不触碰系统剪贴板**（"复制绝对路径"属别的族），故无跨进程抢占问题。
 *
 *  被测产物固定：`<repo>/MarkPilot-CM6/dist/win-unpacked/MarkPilot.exe`
 *  （⚠️ 注释里也**不要写真实盘符路径** —— 可移植性判据会把它算作"写死路径" ✗，用 `<repo>` 占位 ✓）
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

const net = require('node:net');
const { execFileSync } = require('node:child_process');

const F = require(path.join(__dirname, 'file-ops-real-lib.cjs'));
const COMMON = require(path.join(__dirname, '_probe-common.cjs'));

const EXE = F.EXE_DEFAULT;
const ROOT = path.join(__MP_WORK, 'path-edge');
const SHOT_ROOT = path.join(ROOT, 'shots');

/** 挑一个真的空着的端口（别的族可能同时在跑，固定区间会撞） */
function pickPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/* ── 夹具能力（全部只动 .mp-verify 下的东西）────────────────────────────── */

/** 目录联接：不需要管理员（符号链接才需要）。Node 的 'junction' 类型正好。 */
function mkJunction(link, target) {
  fs.rmSync(link, { recursive: false, force: true });
  fs.symlinkSync(target, link, 'junction');
  return { link, target, readlink: fs.readlinkSync(link) };
}
/** 这个目录项是不是重解析点（junction/symlink）——用 lstat 判，不要用 stat（会穿透） */
function isReparsePoint(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** 目录拒写（ACL deny WD,AD 给当前用户）—— 只读**目录**，比 +R 属性更接近"只读目录里另存为" */
function denyWriteDir(dir) {
  const user = process.env.USERDOMAIN + '\\' + process.env.USERNAME;
  execFileSync('icacls', [dir, '/deny', user + ':(WD,AD)'], { encoding: 'utf8', windowsHide: true });
  return { dir, user, applied: true };
}
function allowWriteDir(dir) {
  const user = process.env.USERDOMAIN + '\\' + process.env.USERNAME;
  try { execFileSync('icacls', [dir, '/remove:d', user], { encoding: 'utf8', windowsHide: true, timeout: 15000 }); } catch { /* 尽力 */ }
  return { dir, released: true };
}
/** 自证"这个目录真的写不进去"（判据不能只靠 icacls 退出码） */
function proveDirReadOnly(dir) {
  const probe = path.join(dir, '.pe-write-probe.tmp');
  try { fs.writeFileSync(probe, 'x'); fs.rmSync(probe, { force: true }); return { denied: false, note: '居然写进去了 ⇒ 拒写没生效' }; }
  catch (e) { return { denied: true, code: e.code || null, message: String(e.message || e).slice(0, 120) }; }
}

/** 真·网络盘：把本机共享映射成驱动器号（DriveType=4，ProviderName=\\localhost\E$） */
function netUse(drive, unc) {
  const out = execFileSync('net', ['use', drive, unc], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { drive, unc, out: String(out).trim() };
}
function netDelete(drive) {
  try { return { out: String(execFileSync('net', ['use', drive, '/delete', '/y'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })).trim() }; }
  catch (e) { return { err: String((e && e.message) || e).slice(0, 120) }; }
}
/** 驱动器号在不在（主进程之外的一手事实） */
function driveAlive(drive) {
  try { return fs.existsSync(drive + '\\'); } catch { return false; }
}

/** 虚拟盘（subst）：另一种"盘符消失"形态，留作对照臂 */
function substAdd(drive, dir) {
  const out = execFileSync('subst', [drive, dir], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return { drive, dir, out: String(out).trim() };
}
function substDel(drive) {
  try { return { out: String(execFileSync('subst', [drive, '/d'], { encoding: 'utf8', windowsHide: true, timeout: 15000 })).trim() }; }
  catch (e) { return { err: String((e && e.message) || e).slice(0, 120) }; }
}

/* ── 读数：一组相关读数一次 evaluate 拿全（错-7）────────────────────────── */

/** 文档/MRU/菜单模型/提示条/标题 —— 全在一次 evaluate 里取完，禁止跨调用拼装。 */
async function peSnap(page, tmo = 25000) {
  const t0 = Date.now();
  const r = await F.T(page.evaluate(async () => {
    const o = {};
    try {
      const v = (window.mpEngine && window.mpEngine._view) ? window.mpEngine._view() : null;
      if (v) {
        const txt = v.state.doc.toString();
        o.docLen = txt.length; o.docHead = txt.slice(0, 80);
        o.viewFocus = !!v.hasFocus;
      } else { o.docLen = null; o.noView = true; }
    } catch (e) { o.viewErr = String((e && e.message) || e).slice(0, 100); }
    o.title = document.title;
    o.hasFocus = document.hasFocus();
    o.activeEl = document.activeElement ? (document.activeElement.tagName + '.' + String(document.activeElement.className || '').slice(0, 36)) : null;
    o.docDir = (typeof window.__mpDocDir === 'undefined') ? null : window.__mpDocDir;
    o.baseURI = document.baseURI;
    const b = document.getElementById('mp-banner');
    if (b) {
      const btns = [...b.querySelectorAll('button')];
      o.banner = {
        shown: b.style.display !== 'none',
        text: (b.firstChild && b.firstChild.nodeType === 3) ? b.firstChild.data : b.textContent,
        full: b.textContent,
        buttons: btns.map((x) => x.textContent),
      };
    } else o.banner = null;
    o.host = await window.mpHost.docInfo().catch((e) => ({ __err: String((e && e.message) || e).slice(0, 100) }));
    o.mru = await window.mpHost.recentList().catch((e) => ({ __err: String((e && e.message) || e).slice(0, 100) }));
    o.mruMenu = await window.mpHost.recentTestMenuList().catch((e) => ({ __err: String((e && e.message) || e).slice(0, 100) }));
    o.fileMenu = await window.mpHost.recentTestFileMenu().catch((e) => ({ __err: String((e && e.message) || e).slice(0, 100) }));
    return o;
  }), tmo, 'peSnap');
  if (r && r.__timeout) return { __timeout: r.__timeout, ms: Date.now() - t0 };
  return { ...r, ms: Date.now() - t0 };
}

/** 只取 MRU 的紧凑视图（打印/判据用） */
const mruBrief = (s) => (s && s.mru && Array.isArray(s.mru.files))
  ? s.mru.files.map((f) => ({ i: f.index, name: f.name, alive: f.alive, path: f.path }))
  : (s && s.mru);

/** 真实输入：点进正文并断言焦点真在编辑面里（错-10：读最终状态，不读"我调用了什么"） */
async function focusBodyAndType(page, needle, text) {
  const box = await F.clickBody(page, needle);
  const before = await F.T(page.evaluate(() => {
    const ae = document.activeElement;
    const inContent = !!(ae && ae.closest && ae.closest('.cm-content'));
    let vf = null; try { const v = window.mpEngine._view(); vf = !!v.hasFocus; } catch { /* 忽略 */ }
    return { activeEl: ae ? ae.tagName + '.' + String(ae.className || '').slice(0, 30) : null, inContent, viewFocus: vf, hasFocus: document.hasFocus() };
  }), 8000, 'focusChk');
  await page.keyboard.type(text);
  await F.sleep(120);
  return { box, before, typed: text };
}

/* ── 落盘/证据 ───────────────────────────────────────────────────────── */

function writeReport(probe, obj) {
  fs.mkdirSync(ROOT, { recursive: true });
  const f = path.join(ROOT, probe.replace(/\.cjs$/, '') + '.json');
  fs.writeFileSync(f, JSON.stringify(obj, null, 1), 'utf8');
  console.log('\n[报告] ' + f);
  return f;
}
function shot(page, name) {
  fs.mkdirSync(SHOT_ROOT, { recursive: true });
  const f = path.join(SHOT_ROOT, name);
  return page.screenshot({ path: f }).then(() => f).catch(() => null);
}

/** 路径体检：长度/段数/是否 UNC/是否含非 ASCII —— 读数里要能看见"这条路径到底长什么样" */
function pathFacts(p) {
  const s = String(p);
  return {
    path: s, chars: s.length,
    lenUnits: (() => { let w = 0; for (const ch of s) w += ch.codePointAt(0) > 0xffff ? 2 : 1; return w; })(),
    isUNC: s.startsWith('\\\\'), drive: /^[A-Za-z]:/.test(s) ? s.slice(0, 2) : null,
    segments: s.split(/[\\/]+/).filter(Boolean).length,
    nonAscii: /[^\x00-\x7f]/.test(s), emoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(s),
    hasQuote: /['"]/.test(s), hasSpace: / /.test(s),
  };
}

/* ── 通用回合：打开 → 真打字 → 去抖自动保存 → 另存为 → 再打字 ────────────────
 *  E1~E4 共用**同一份实现**（错-4：不许有第二份），各案例只换路径与通道。
 *  · 打开通道二选一：`argv`（启动参数，与双击文件同一条路）或 `openPath`（壳层 IPC，
 *    与"文件→打开…"选中后的落点同一条路）——两条都记账，不混为一谈。
 *  · 每个阶段一组读数一次 peSnap 拿全；磁盘侧用独立 fs 读（一手事实）。
 *  返回 { readings, page, app, ... }，调用方负责 kill。
 */
async function runCycle({ id, openDoc, saveAsTarget, openVia = 'openPath', dir, mark = 'M1', extraEnv = {}, extraWait = 0, blank = false }) {
  const profile = path.join(dir, 'profile');
  const shots = path.join(dir, 'shots');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(shots, { recursive: true });
  /* 【隔离·实测踩到】main.js 的 migrateUserDataFromCm6 会把 `%APPDATA%\MarkPilot CM6`
   *  整目录拷进任何**没有 settings.json** 的 profile ⇒ 探针会继承真实用户（以及别的族）
   *  的 MRU/设置，甚至让 restoreLast 在"空文档"臂里自动打开上一次的文件（实测：臂 A 的
   *  filePath 竟是 img-bug 族留下的 copy-original.md）。这里预置两个文件把入口堵死：
   *   · settings.json 存在 ⇒ 迁移直接 return（main.js:44）
   *   · recents.json = [] ⇒ MRU 从空开始，读数只含本族打开的路径
   *  mpLoadRecents 读 recents.json（它才是真源）⇒ 空数组即可。 */
  fs.writeFileSync(path.join(profile, 'settings.json'),
    JSON.stringify({ theme: 'system', recent: [], recentFiles: [], winBounds: null, restoreLast: false }, null, 2), 'utf8');
  fs.writeFileSync(path.join(profile, 'recents.json'), '[]', 'utf8');
  const port = await pickPort();
  const R = { id, openDoc, saveAsTarget, openVia, profile, port, stages: {}, errs: [], shell: {}, isolation: { settingsSeeded: true, recentsSeeded: [], restoreLast: false, migratedTxt: null } };
  const readDisk = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return { __err: e.code || String(e.message).slice(0, 60) }; } };

  const argv = openVia === 'argv' ? [openDoc] : [];
  const app = await F.launch({
    exe: EXE, args: argv, port, profile,
    env: { MP_TEST_SAVE_AS: saveAsTarget, ...extraEnv },
  });
  R.launchArgs = app.launchArgs;
  let page = null;
  try {
    page = await F.findPage(app.browser, (!blank && openVia === 'argv') ? { expectFile: path.basename(openDoc) } : {});
    page.on('pageerror', (e) => R.errs.push('pageerror: ' + String((e && e.message) || e).slice(0, 200)));
    page.on('crash', () => R.errs.push('PAGE_CRASH'));
    await F.sleep(2200);

    /* ── 0) 打开 ── */
    R.stages.openChannel = blank ? '(空文档：不带文件启动)' : openVia;
    if (blank) {
      const sB = await peSnap(page);
      R.stages.afterOpen = sB;
      R.openHit = { got: sB && sB.host && sB.host.filePath, expect: null, equal: (sB && sB.host && sB.host.filePath) == null, note: '空文档：filePath 应为 null' };
      R.stages.openDisk = null;
    } else if (openVia === 'openPath') {
      const t0 = Date.now();
      R.openResult = await F.T(page.evaluate((p) => window.mpHost.openPath(p), openDoc), 120000, 'openPath');
      R.openMs = Date.now() - t0;
      await F.sleep(1800);
    } else {
      R.openMs = null;
    }
    const s0 = await peSnap(page);
    R.stages.afterOpen = s0;
    const got = s0 && s0.host && s0.host.filePath;
    R.openHit = { got: got || null, expect: openDoc, equal: !!got && String(got).toLowerCase() === String(openDoc).toLowerCase() };
    R.stages.openDisk = readDisk(openDoc);
    /* argv 那条没打开成功 ⇒ **另记一笔** openPath 通道的读数（两条通道分开记账，不混） */
    if (openVia === 'argv' && !R.openHit.equal) {
      const t0b = Date.now();
      R.argvFailedThenOpenPath = await F.T(page.evaluate((p) => window.mpHost.openPath(p), openDoc), 120000, 'openPath2');
      R.argvFailedThenOpenPathMs = Date.now() - t0b;
      await F.sleep(1800);
      const s0b = await peSnap(page);
      R.stages.afterOpenPathFallback = s0b;
      const g2 = s0b && s0b.host && s0b.host.filePath;
      R.openHitFallback = { got: g2 || null, expect: openDoc, equal: !!g2 && String(g2).toLowerCase() === String(openDoc).toLowerCase() };
      R.openMs = R.argvFailedThenOpenPathMs;
    }

    /* ── 1) 真打字 → 去抖自动保存 ── */
    R.stages.focus = await focusBodyAndType(page, null, mark);
    await F.sleep(2600 + extraWait);
    const s1 = await peSnap(page);
    R.stages.afterType = s1;
    R.stages.diskAfterType = blank ? null : readDisk(openDoc);
    R.stages.typeOk = blank ? null : (typeof R.stages.diskAfterType === 'string' && R.stages.diskAfterType.includes(mark));

    /* ── 2) 另存为（菜单项自己的 click；目标路径来自 MP_TEST_SAVE_AS，不弹原生框）── */
    const t1 = Date.now();
    R.saveAsClick = await F.T(page.evaluate(() => window.mpHost.recentTestMenuClick('menu-save-as')), 15000, 'menu-save-as');
    await F.sleep(3000 + extraWait);
    R.saveAsMs = Date.now() - t1;
    const s2 = await peSnap(page);
    R.stages.afterSaveAs = s2;
    R.stages.saveAsDisk = readDisk(saveAsTarget);
    R.stages.saveAsOk = typeof R.stages.saveAsDisk === 'string' && R.stages.saveAsDisk.includes(mark);

    /* ── 3) 再打一笔 → 应写进**新**路径（证明切换彻底）── */
    R.stages.focus2 = await focusBodyAndType(page, null, mark + '2');
    await F.sleep(2600 + extraWait);
    const s3 = await peSnap(page);
    R.stages.afterType2 = s3;
    R.stages.saveAsDisk2 = readDisk(saveAsTarget);
    R.stages.openDiskFinal = blank ? null : readDisk(openDoc);
    R.stages.type2WroteNew = typeof R.stages.saveAsDisk2 === 'string' && R.stages.saveAsDisk2.includes(mark + '2');

    R.shot = await shot(page, id + '-after-saveas.png');
    R.shell = F.shellLog(profile, 'file:save|pickSaveAs|openPath|doc:saved|writeDoc|restore-last|recents:loaded', 14);
    /* 隔离自证：迁移痕必须**不存在**（存在就说明预置没生效、读数可能被真实用户数据污染） */
    try {
      const mig = path.join(profile, 'migrated-from-cm6.txt');
      R.isolation.migratedTxt = fs.existsSync(mig) ? fs.readFileSync(mig, 'utf8').slice(0, 200) : null;
      R.isolation.ok = !fs.existsSync(mig) && fs.readFileSync(path.join(profile, 'recents.json'), 'utf8').trim().startsWith('[');
    } catch (e) { R.isolation.ok = false; R.isolation.err = String(e.message).slice(0, 80); }
  } catch (e) {
    R.errs.push('THROW: ' + String((e && e.message) || e).slice(0, 200));
  } finally {
    if (app) F.kill(app);
  }
  R.alive = false;
  return R;
}

/** 被测产物锁定值（本轮开工时实测 sha256 前 16 位）——不符即 exit(9)，拒绝出数 */
const EXPECT_EXE = '2f0f4f630d9cf257';

/** 尺子卡 + 产物断言（错-1）。每个探针**第一行**就该调它。 */
function rulerEdge(probe) {
  const card = COMMON.rulerCard({ probe, exe: EXE, extra: { family: 'path-edge', expectExe: EXPECT_EXE } });
  COMMON.assertExe(EXE, EXPECT_EXE);
  return card;
}

/** 清理**本族自己**的残留进程：判据是命令行里带本族 profile 根（path-edge），
 *  绝不按进程名杀 —— 别的族（实测 a11y-keyboard）正在同时跑，误杀会把别人的腿打断。 */
function killStaleMine() {
  const { execFileSync } = require('node:child_process');
  let list = [];
  try {
    const out = execFileSync('pwsh', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='MarkPilot.exe'\" | Where-Object { $_.CommandLine -like '*\\.mp-verify\\path-edge*' } | ForEach-Object { $_.ProcessId }"],
      { encoding: 'utf8', windowsHide: true, timeout: 25000 });
    list = String(out).split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n));
  } catch { /* 拿不到就当没有 */ }
  for (const pid of list) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* 尽力 */ } }
  if (list.length) console.log('[清理] 杀掉本族残留进程 ' + list.length + ' 个：' + list.join(','));
  return list;
}

/** 建夹具前先清场：杀本族残留 → 再删目录（否则 profile 里的 Chromium 文件被占用 ⇒ EPERM） */
function freshDir(dir) {
  killStaleMine();
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); return { dir, ms: Date.now() - t0 }; }
    catch (e) { if (i === 9) { console.log('[清理] 删不掉 ' + dir + '：' + e.code + '（继续跑，夹具改用新目录）'); return { dir, err: e.code }; } }
  }
}

/** 兜底：探针进程无论怎么退出（异常/被 Ctrl-C），都不给下一次留占用 profile 的残进程。
 *  只杀本族（命令行含 path-edge）——见 killStaleMine 的说明。 */
process.on('exit', () => { try { killStaleMine(); } catch { /* 尽力 */ } });

/* ── 形态回合：一个路径形态一次跑全"打开/保存/另存为/标题/MRU" ────────────────
 *  顺序是**刻意**的（e2/e2b 已证明：会话一旦有 diskMtime，另存为到**新路径**必被守卫拦下）：
 *    ① 空文档（diskMtime=0）→ 另存为到**异常形态目标** ⇒ 走的是**真实写盘路**，量得到该形态本身的行为
 *    ② 再打一笔 ⇒ 自动保存应写进①的新路径（证明会话确实切过去了）
 *    ③ openPath(异常形态源文件) ⇒ 量"打开/标题/文件位置/MRU"
 *    ④ 再打一笔 ⇒ 自动保存应写进③的源文件
 *  这样"形态效应"与"守卫缺陷"在同一支里被分开，不会互相顶替。
 */
async function runShapeCycle({ id, shapeOpenDoc, shapeSaveAsTarget, dir, label, preSaveAs = null, tmoMs = 120000, extraEnv = {} }) {
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'settings.json'),
    JSON.stringify({ theme: 'system', recent: [], recentFiles: [], winBounds: null, restoreLast: false }, null, 2), 'utf8');
  fs.writeFileSync(path.join(profile, 'recents.json'), '[]', 'utf8');
  const port = await pickPort();
  const R = { id, label, shapeOpenDoc, shapeSaveAsTarget, profile, port, stages: {}, errs: [], pathFacts: { open: pathFacts(shapeOpenDoc), saveAs: pathFacts(shapeSaveAsTarget) } };
  const readDisk = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return { __err: e.code || String(e.message).slice(0, 60) }; } };

  const app = await F.launch({ exe: EXE, args: [], port, profile, env: { MP_TEST_SAVE_AS: shapeSaveAsTarget, ...extraEnv } });
  R.launchArgs = app.launchArgs;
  try {
    const page = await F.findPage(app.browser, {});
    page.on('pageerror', (e) => R.errs.push('pageerror: ' + String((e && e.message) || e).slice(0, 200)));
    page.on('crash', () => R.errs.push('PAGE_CRASH'));
    await F.sleep(2200);
    R.stages.boot = await peSnap(page);
    R.blankOk = (R.stages.boot.host && R.stages.boot.host.filePath) == null && !!R.stages.boot.mru && (R.stages.boot.mru.files || []).length === 0;

    /* ① 空文档 → 另存为到异常目标（真实写盘） */
    R.stages.focus1 = await focusBodyAndType(page, null, 'P1');
    await F.sleep(900);
    if (typeof preSaveAs === 'function') R.preSaveAs = await preSaveAs();   // 必须在点另存为**之前**（例：给目标目录上拒绝写 ACL）
    R.saveAsClick = await F.T(page.evaluate(() => window.mpHost.recentTestMenuClick('menu-save-as')), 15000, 'menu-save-as');
    await F.sleep(3500);
    R.stages.diskTarget = readDisk(shapeSaveAsTarget);
    R.stages.saveAsOk = typeof R.stages.diskTarget === 'string' && R.stages.diskTarget.includes('P1');
    const s2 = await peSnap(page, tmoMs);
    R.stages.afterSaveAs = s2;
    R.saveAsHost = s2 && s2.host && s2.host.filePath;
    R.saveAsHostMatches = !!R.saveAsHost && String(R.saveAsHost).toLowerCase() === String(shapeSaveAsTarget).toLowerCase();

    /* ② 再打一笔 → 自动保存应进新路径 */
    R.stages.focus2 = await focusBodyAndType(page, null, 'P2');
    await F.sleep(2800);
    R.stages.diskTarget2 = readDisk(shapeSaveAsTarget);
    R.stages.type2ToNew = typeof R.stages.diskTarget2 === 'string' && R.stages.diskTarget2.includes('P2');

    /* ③ 打开异常形态源文件 */
    const t0 = Date.now();
    R.openResult = await F.T(page.evaluate((p) => window.mpHost.openPath(p), shapeOpenDoc), tmoMs, 'openPath');
    R.openMs = Date.now() - t0;
    await F.sleep(2000);
    const s3 = await peSnap(page, tmoMs);
    R.stages.afterOpen = s3;
    R.openHit = { got: (s3 && s3.host && s3.host.filePath) || null, expect: shapeOpenDoc, equal: !!(s3 && s3.host && s3.host.filePath) && String(s3.host.filePath).toLowerCase() === String(shapeOpenDoc).toLowerCase() };

    /* ④ 再打一笔 → 自动保存应进源文件 */
    R.stages.focus3 = await focusBodyAndType(page, null, 'P3');
    await F.sleep(2800);
    R.stages.diskSource = readDisk(shapeOpenDoc);
    R.stages.type3ToSource = typeof R.stages.diskSource === 'string' && R.stages.diskSource.includes('P3');

    R.shot = await shot(page, id + '-final.png');
    R.shell = F.shellLog(profile, 'file:save|pickSaveAs|openPath|doc:saved|writeDoc|doc:path', 16);
    R.isolation = { migratedTxtExists: fs.existsSync(path.join(profile, 'migrated-from-cm6.txt')) };
  } catch (e) {
    R.errs.push('THROW: ' + String((e && e.stack) || e).slice(0, 300));
  } finally { F.kill(app); }
  return R;
}

/** 一次 evaluate：提示条几何 + **浏览器自己算出的命中原素** + 文档文本（错-7 一次拿全；错-15 读引擎算好的结果）
 *  `elementFromPoint(cx,cy)` 就是真实点击会打到的那个元素——不自己推 z-order。 */
async function hitMap(page, tmoMs = 20000) {
  return await F.T(page.evaluate(() => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) }; };
    const desc = (el) => {
      if (!el) return null;
      const b = el.closest ? el.closest('button') : null;
      return {
        tag: el.tagName, cls: String(el.className || '').slice(0, 60), id: el.id || null,
        text: String(el.textContent || '').trim().slice(0, 24),
        closestButton: b ? { title: b.title || null, aria: b.getAttribute('aria-label'), text: String(b.textContent || '').trim().slice(0, 20), cls: String(b.className || '').slice(0, 40) } : null,
      };
    };
    const banner = document.getElementById('mp-banner');
    const toolbar = document.querySelector('.mp-toolbar');
    const btns = banner ? [...banner.querySelectorAll('button')] : [];
    const tbtns = toolbar ? [...toolbar.querySelectorAll('button')] : [];
    let docText = null; try { docText = window.mpEngine._view().state.doc.toString(); } catch { /* 忽略 */ }
    return {
      docLen: docText === null ? null : docText.length, docText,
      bannerRect: banner ? rect(banner) : null,
      toolbarRect: toolbar ? rect(toolbar) : null,
      bannerButtons: btns.map((b) => { const r = b.getBoundingClientRect(); const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2); return { label: String(b.textContent || '').trim(), ...rect(b), hit: desc(document.elementFromPoint(cx, cy)) }; }),
      toolbarButtons: tbtns.map((b) => ({ title: b.title || null, cls: String(b.className || '').slice(0, 30), ...rect(b) })),
      bannerShown: banner ? banner.style.display !== 'none' : false,
      bannerText: banner ? (banner.firstChild && banner.firstChild.nodeType === 3 ? banner.firstChild.data : banner.textContent) : null,
    };
  }), tmoMs, 'hitMap');
}

module.exports = {
  ...F, F, COMMON, EXE, ROOT, SHOT_ROOT, pickPort, runCycle, runShapeCycle, EXPECT_EXE, rulerEdge,
  killStaleMine, freshDir, hitMap,
  mkJunction, isReparsePoint, denyWriteDir, allowWriteDir, proveDirReadOnly,
  netUse, netDelete, driveAlive, substAdd, substDel,
  peSnap, mruBrief, focusBodyAndType, writeReport, shot, pathFacts,
};
