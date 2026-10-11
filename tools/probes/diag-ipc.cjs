/** 装机版主进程 IPC 面体检：打包 3.0.5 的 main.js 在顶层 `ipcMain.handle('file:saveAs')`
 *  与 `watchIpc('file:saveAs')` 各注册一次 ⇒ 若真抛错，**其后**注册的通道（file:save / file:stat …）
 *  会全部缺失（保存会静默失败）。这个脚本直接问渲染进程要答案。
 *  用法：node app-slot.cjs -- node diag-ipc.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
const { chromium } = require('C:/Windows/System32/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..', '..');
const EXE = path.join(ROOT, 'MarkPilot-CM6', 'dist', 'win-unpacked', 'MarkPilot.exe');
const DOC = path.join(ROOT, '.mp-verify', 'demo', '验收清单.md');
const PROFILE = path.join(__dirname, 'profile-ipc');
const PORT = 9596;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch { }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let child = null, browser = null;
  for (let attempt = 1; attempt <= 3 && !browser; attempt++) {
    if (attempt > 1) { await sleep(6000); try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { } }
    child = spawn(EXE, [DOC, `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`], { env, stdio: 'ignore' });
    for (let i = 0; i < 30 && !browser; i++) { await sleep(1000); try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { } }
  }
  if (!browser) { console.log('✗ 连不上（别的实例占着单实例）'); process.exit(2); }
  const ctx = browser.contexts()[0];
  let page = null;
  for (let i = 0; i < 40 && !page; i++) { const ps = ctx.pages().filter((p) => !p.url().startsWith('devtools://')); page = ps[0] || null; if (!page) await sleep(500); }
  for (let i = 0; i < 60; i++) { const ok = await page.evaluate(() => !!(window.mpEngine && window.mpEngine._view && window.mpEngine._view())).catch(() => false); if (ok) break; await sleep(500); }
  console.log('· 页面 URL =', page.url());
  console.log('· 窗口尺寸 =', JSON.stringify(page.viewportSize()));

  // 主进程错误对话框（UIA 读文本）
  const dump = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$procs = Get-CimInstance Win32_Process -Filter "Name='MarkPilot.exe'" | Where-Object { $_.CommandLine -like '*profile-ipc*' -and $_.CommandLine -notlike '*--type=*' }
foreach ($p in $procs) {
  $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  "MAIN pid=$($p.ProcessId) title='$($proc.MainWindowTitle)'"
  $all = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  try {
    $el = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
    if ($el) { foreach ($k in $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { if ($k.Current.Name) { "   " + $k.Current.Name } } }
  } catch { }
}`;
  fs.writeFileSync(path.join(__dirname, 'uia-ipc.ps1'), dump, 'utf8');
  try { console.log(execSync(`pwsh -NoProfile -File "${path.join(__dirname, 'uia-ipc.ps1')}"`, { encoding: 'utf8', windowsHide: true })); } catch (e) { console.log('UIA 失败', e.message.slice(0, 80)); }

  const probeIpc = await page.evaluate(async (doc) => {
    const out = { hasMpHost: typeof window.mpHost, keys: window.mpHost ? Object.keys(window.mpHost).slice(0, 24) : [] };
    const call = async (name, fn) => { try { const r = await fn(); out[name] = { ok: true, val: JSON.stringify(r).slice(0, 160) }; } catch (e) { out[name] = { ok: false, err: String(e && e.message).slice(0, 200) }; } };
    if (window.mpHost) {
      await call('info', () => window.mpHost.info());
      await call('health', () => window.mpHost.health());
      await call('stat', () => window.mpHost.stat(doc));
      await call('exists', () => window.mpHost.exists(doc));
    }
    return out;
  }, DOC);
  console.log('· IPC 体检 =', JSON.stringify(probeIpc, null, 1));
  const readState = await page.evaluate(() => ({ title: document.title, mpEngine: !!window.mpEngine, docLen: window.mpEngine && window.mpEngine._view() ? window.mpEngine._view().state.doc.length : null }));
  console.log('· 渲染面 =', JSON.stringify(readState));

  try { await browser.close(); } catch { }
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { }
  await sleep(1000);
  process.exit(0);
})();
