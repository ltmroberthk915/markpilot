/** family=file-ops-real · 探针共用库（错-4：同一件事只许有一份实现）
 *
 *  纪律落点：
 *   · 错-1：启动即打印尺子卡（产物 sha16 由 _probe-common.cjs 断言，期望值从 MP_EXPECT_EXE 来）
 *   · 错-7：一组相关读数用**一次** evaluate 取全（snap()），跨调用不许拼装
 *   · 错-7：找页时断言 docInfo().filePath 命中夹具（证明"拿到的不是默认回退值"）
 *   · 错-8：现象与推断矛盾时读壳层一手事实（userData/main-debug.log 的 dbg 行）
 *
 *  用法（统一套路）：
 *    const L = require('./file-ops-real-lib.cjs');
 *    L.ruler('file-ops-real-p1.cjs');                 // 打印 + 断言产物 sha16
 *    const app = await L.launch({ exe, args, env, port, profile });
 *    const page = await L.findPage(app.browser, { expectFile: 'x.md' });
 *    const s = await L.snap(page);                    // 一次拿全
 *    await L.kill(app);
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

const COMMON = require(path.join(__dirname, '_probe-common.cjs'));
const EXE_DEFAULT = __MP_EXE;
const ROOT = path.join(__MP_WORK, 'file-ops-real');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 给任何 promise 加超时（不让探针挂在模态/无响应上） */
const T = (pr, ms, tag) => Promise.race([pr, new Promise((r) => setTimeout(() => r({ __timeout: tag }), ms))]);

function ruler(probe, exe) {
  const card = COMMON.rulerCard({ probe, exe: exe || EXE_DEFAULT });
  COMMON.assertExe(exe || EXE_DEFAULT);
  return card;
}

async function launch({ exe = EXE_DEFAULT, args = [], env = {}, port, profile, cwd }) {
  fs.mkdirSync(profile, { recursive: true });
  const e = { ...process.env, MP_DEBUG: '1', MP_TEST_HOOKS: '1', MP_TEST_NO_DIALOG: '1', ...env };
  delete e.ELECTRON_RUN_AS_NODE;
  const all = [...args, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`];
  const child = spawn(exe, all, { env: e, stdio: 'ignore', cwd: cwd || undefined });
  const app = { child, pid: child.pid, port, profile, exe, browser: null, launchArgs: all };
  for (let i = 0; i < 45 && !app.browser; i++) {
    await sleep(1000);
    try { app.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { /* 再等 */ }
  }
  if (!app.browser) throw new Error('CDP 连不上（port=' + port + '）');
  return app;
}

/** 找引擎页；给了 expectFile 就**断言**它就是夹具（错-7：不是默认回退值） */
async function findPage(browser, { expectFile = null, timeoutMs = 45000 } = {}) {
  const ctx = browser.contexts()[0];
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    for (const p of ctx.pages().filter((x) => !x.url().startsWith('devtools://'))) {
      const ok = await T(p.evaluate(async () => {
        try {
          const info = await window.mpHost.docInfo().catch(() => null);
          return { engine: !!(window.mpEngine && window.mpHost), file: info && info.filePath, name: info && info.name };
        } catch { return { engine: false }; }
      }), 5000, 'probe').catch(() => null);
      if (ok && ok.engine) {
        last = ok;
        if (!expectFile) return p;
        if (String(ok.file || '').replace(/\\/g, '/').toLowerCase().endsWith(String(expectFile).toLowerCase())) return p;
      }
    }
    await sleep(500);
  }
  throw new Error('找不到引擎页' + (expectFile ? `，或 docInfo 未命中夹具 ${expectFile}（最后读数 ${JSON.stringify(last)}）` : ''));
}

/** 【一次拿全】与文件操作相关的一切：文档文本/长度、标题、提示条、宿主路径、目录、保存轨迹、焦点 */
async function snap(page) {
  return await T(page.evaluate(async () => {
    let view = null, docText = null, viewFocus = null, sel = null;
    try {
      view = window.mpEngine && window.mpEngine._view ? window.mpEngine._view() : null;
      if (view) { docText = view.state.doc.toString(); viewFocus = !!view.hasFocus; sel = { a: view.state.selection.main.anchor, h: view.state.selection.main.head }; }
    } catch { /* 忽略 */ }
    const b = document.getElementById('mp-banner');
    let banner = null;
    if (b) {
      const btn = [...b.querySelectorAll('button')];
      banner = {
        display: b.style.display, shown: b.style.display !== 'none',
        text: (b.firstChild && b.firstChild.nodeType === 3) ? b.firstChild.data : b.textContent,
        buttons: btn.map((x) => x.textContent),
        rects: btn.map((x) => { const r = x.getBoundingClientRect(); return { label: x.textContent, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }; }),
      };
    }
    const info = await window.mpHost.docInfo().catch(() => null);
    let dbg = null;
    try { dbg = { saveTrace: ((window.__mpDbg && window.__mpDbg.saveTrace) || []).slice(-10), ups: ((window.__mpDbg && window.__mpDbg.ups) || []).slice(-6) }; } catch { /* 忽略 */ }
    return {
      docLen: docText === null ? null : docText.length, docText, title: document.title,
      banner, host: info, docDir: (typeof window.__mpDocDir === 'undefined' ? null : window.__mpDocDir),
      hasFocus: document.hasFocus(), viewFocus, sel,
      activeEl: document.activeElement ? (document.activeElement.tagName + (document.activeElement.className ? '.' + String(document.activeElement.className).slice(0, 40) : '')) : null,
      dbg,
    };
  }), 8000, 'snap');
}

/** 真实鼠标：点进正文（点含 needle 的那一行），并把光标送到行尾 —— 打字前的"人先点一下" */
async function clickBody(page, needle, { end = true } = {}) {
  const box = await T(page.evaluate((n) => {
    const lines = [...document.querySelectorAll('.cm-line')];
    const el = (n ? lines.find((e) => (e.textContent || '').includes(n)) : null) || lines[Math.min(1, lines.length - 1)] || lines[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + Math.min(40, Math.max(8, r.width / 3))), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) };
  }, needle || null), 6000, 'clickBody');
  if (!box) throw new Error('找不到可点的正文行');
  await page.mouse.click(box.x, box.y);
  await sleep(150);
  if (end) { await page.keyboard.press('End'); await sleep(80); }
  return box;
}

/** 真实鼠标：点提示条上的按钮（按文案找） */
async function clickBannerButton(page, label) {
  const s = await snap(page);
  const want = s.banner && s.banner.rects ? s.banner.rects.find((r) => (r.label || '').includes(label)) : null;
  if (!want) return { ok: false, reason: '提示条上没有「' + label + '」按钮', banner: s.banner && s.banner.text };
  await page.mouse.click(want.x, want.y);
  return { ok: true, clicked: want };
}

const readDisk = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const readBuf = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
const statOf = (p) => { try { const s = fs.statSync(p); return { size: s.size, mtimeMs: s.mtimeMs, mode: '0o' + (s.mode & 0o777).toString(8) }; } catch { return null; } };
/** 目录清单（找 .mp-tmp 残留 / 看另存为产物） */
const listDir = (d) => { try { return fs.readdirSync(d).map((n) => ({ name: n, size: statOf(path.join(d, n)) ? statOf(path.join(d, n)).size : -1 })); } catch { return null; } };

/** 壳层一手事实：MP_DEBUG=1 时 userData/main-debug.log 里的 dbg 行（错-8） */
function shellLog(profile, pattern, tail = 8) {
  const f = path.join(profile, 'main-debug.log');
  if (!fs.existsSync(f)) return { exists: false, hits: [] };
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean);
  const re = pattern ? new RegExp(pattern) : null;
  const hits = lines.filter((l) => (re ? re.test(l) : true));
  return { exists: true, total: lines.length, hits: hits.length, matched: hits.slice(-tail), tail: lines.slice(-tail) };
}

function alive(pid) {
  try { const out = execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, { encoding: 'utf8', windowsHide: true }); return /MarkPilot/i.test(out); }
  catch { return false; }
}
function kill(app) {
  try { if (app && app.browser) app.browser.close().catch(() => { }); } catch { /* 忽略 */ }
  try { if (app && app.child && app.child.pid) execSync(`taskkill /PID ${app.child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { /* 忽略 */ }
}
function killPid(pid) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { /* 忽略 */ } }

/** 原生顶层窗口枚举（只读，用来"看见"原生对话框/标题栏；CDP 拍不到非客户区） */
function winList(ps1, pidFilter = 0) {
  try { return JSON.parse(execFileSync('pwsh', ['-NoProfile', '-File', ps1, 'list', String(pidFilter)], { encoding: 'utf8', windowsHide: true, timeout: 25000 }).trim() || '[]'); }
  catch (e) { return [{ err: String((e && e.message) || e).slice(0, 80) }]; }
}

module.exports = { EXE_DEFAULT, ROOT, COMMON, sleep, T, ruler, launch, findPage, snap, clickBody, clickBannerButton, readDisk, readBuf, statOf, listDir, shellLog, alive, kill, killPid, winList };
