/** autosave-crash-recovery 族的共用底座（AGENTS 错-4：同一件事只许一份实现）
 *
 *  这里集中：启动范式（spawn + 随机 CDP 端口 + 独立 profile + MP_DEBUG=1 + 删 ELECTRON_RUN_AS_NODE）、
 *  引擎页发现、一次 evaluate 拿全的一组读数、原生窗口读数/截图/点击的调用封装、收尾 taskkill。
 *
 *  启动范式与仓库既有探针一致（probe-close-window.cjs / probe-file-ops-native.cjs）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync, execSync } = require('node:child_process');
const { chromium } = require('C:/Windows/System32/node_modules/playwright-core');

const WINPS = path.join(__dirname, 'autosave-crash-recovery-win.ps1');
const PWSH = 'C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe';
const MARKER = 'MPAUTO-2026-10-10-A';       // 原生尺子版本标记（C# 侧每条窗口读数带它）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ── 原生窗口尺子（每次调用独立进程；读数只走文件，不走管道）────────────────── */
function winOps(pid, ops, tag, dir) {
  const jobFile = path.join(dir, `job-${tag}.json`);
  const outFile = path.join(dir, `out-${tag}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ pid, out: outFile.replace(/\\/g, '/'), ops }), 'utf8');
  let lastErr = '';
  for (let i = 0; i < 3; i++) {
    fs.rmSync(outFile, { force: true });
    try {
      execFileSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WINPS, '-Job', jobFile],
        { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: 60000 });
    } catch (e) { lastErr = String((e && e.stderr) || (e && e.message) || e).slice(0, 400); continue; }
    if (!fs.existsSync(outFile)) { lastErr = 'no-out-file'; continue; }
    try { return { ok: true, steps: JSON.parse(fs.readFileSync(outFile, 'utf8')).steps, err: '' }; }
    catch (e) { lastErr = 'parse:' + e.message; }
  }
  return { ok: false, steps: [], err: lastErr };
}
/** 该 pid 的顶层窗口（含 UIA 行）；只取本轮产物 */
const listWindows = (pid, tag, dir) => {
  const r = winOps(pid, [{ kind: 'list' }], tag, dir);
  const w = r.ok && r.steps[0] ? r.steps[0].windows || [] : [];
  return { ok: r.ok && w.length > 0, windows: w, err: r.err, marker: w.length ? MARKER : null };
};
/** 找主窗口：MarkPilot 的主窗类是 Chrome_WidgetWin_1，标题形如 "<name> — MarkPilot"（脏时前缀 ●） */
const findMainWindow = (windows) => windows.filter((w) => w.vis && /Chrome_WidgetWin_1/.test(w.cls || '') && /—\s*MarkPilot\s*$/.test(w.title || ''))[0] || null;
const findDialogs = (windows) => windows.filter((w) => w.vis && w.cls === '#32770');
const shot = (pid, pngAbs, tag, dir) => winOps(pid, [{ kind: 'shot', path: pngAbs.replace(/\\/g, '/') }], tag, dir).steps[0] || null;
const winShot = (pid, pngAbs, cls, tag, dir) => winOps(pid, [{ kind: 'winshot', cls, path: pngAbs.replace(/\\/g, '/') }], tag, dir).steps[0] || null;
const clickDialogButton = (pid, text, tag, dir) => winOps(pid, [{ kind: 'click', text }], tag, dir).steps[0] || null;
const closeWindowByHwnd = (pid, hwnd, tag, dir) =>
  winOps(pid, [{ kind: 'close-hwnd', hwnd }], tag, dir).steps[0] || null;

/** ── 产品启动/连接 ───────────────────────────────────────────────────────── */
async function launch(exe, docPath, { dir, port, env: extraEnv = {}, flags = [] } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MP_DEBUG: '1', ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [docPath, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...flags].filter(Boolean);
  const child = spawn(exe, args, { env, stdio: 'ignore' });
  return { child, pid: child.pid, port, profile, args };
}
function killTree(pid) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { } }

/** 只用 tasklist 判活（不许用渲染侧超时反推） */
function aliveNames() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq MarkPilot.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    return [...out.matchAll(/"(MarkPilot\.exe)","(\d+)"/g)].map((m) => Number(m[2]));
  } catch { return []; }
}

async function connect(port, { tries = 45, gapMs = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(gapMs); }
  }
  return null;
}
async function enginePage(browser, { tries = 60, gapMs = 500 } = {}) {
  const ctx = browser.contexts()[0];
  for (let i = 0; i < tries; i++) {
    for (const p of ctx.pages().filter((x) => !x.url().startsWith('devtools://'))) {
      const ok = await p.evaluate(() => { try { return !!(window.mpEngine && window.mpHost); } catch { return false; } }).catch(() => false);
      if (ok) return p;
    }
    await sleep(gapMs);
  }
  return null;
}
/** 一次 evaluate 拿全：内容 / 脏标 / 标题 / 提示条 / saveTrace / 字数 —— 禁止跨调用拼装 */
const snapshot = (page) => page.evaluate(() => {
  const v = window.mpEngine._view();
  const text = v.state.doc.toString();
  const banner = document.getElementById('mp-banner');
  const d = window.__mpDbg || {};
  const trace = d.saveTrace || [];
  return {
    docLen: text.length,
    tail: text.slice(-24),
    docTitle: document.title,
    dirtyDom: document.title.startsWith('\u25cf'),
    bannerShown: !!(banner && banner.style.display && banner.style.display !== 'none'),
    bannerText: banner ? String(banner.textContent || '').slice(0, 140) : null,
    bannerButtons: banner ? [...banner.querySelectorAll('button')].map((b) => b.textContent) : [],
    saveTraceTail: trace.slice(-6),
    hasFocus: document.hasFocus(),
    activeInEditor: !!(document.activeElement && (document.activeElement.closest ? document.activeElement.closest('.cm-editor') : null)),
    ups: (d.ups || []).slice(-6),
  };
});
/** 原生窗口标题（主窗）：一手证据，判脏标与窗口是否还在 */
const nativeTitle = async (pid, tag, dir, mainHwnd) => {
  const r = listWindows(pid, tag, dir);
  const w = r.windows.filter((x) => x.hwnd === mainHwnd)[0] || findMainWindow(r.windows);
  return { ok: r.ok, hwnd: w ? w.hwnd : null, title: w ? w.title : null, allMain: r.windows.filter((x) => /Chrome_WidgetWin_1/.test(x.cls || '')).map((x) => x.title), err: r.err };
};
/** 真实点击编辑器正文里的一行（CDP 鼠标；工具栏按钮才要求真实鼠标，正文同理走真实通道） */
async function clickBodyLine(page, containsText) {
  const box = await page.evaluate((needle) => {
    const els = [...document.querySelectorAll('.cm-line')];
    const el = els.find((e) => (e.textContent || '').includes(needle)) || els[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.right - 12), y: Math.round(r.y + r.height / 2) };
  }, containsText);
  if (!box) return null;
  await page.mouse.click(box.x, box.y);
  await sleep(120);
  return box;
}

module.exports = {
  WINPS, PWSH, MARKER, sleep,
  winOps, listWindows, findMainWindow, findDialogs, shot, winShot, clickDialogButton, closeWindowByHwnd,
  launch, killTree, aliveNames, connect, enginePage, snapshot, nativeTitle, clickBodyLine,
};
