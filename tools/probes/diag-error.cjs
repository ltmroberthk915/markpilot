/** 只回答一个问题：我这台 win-unpacked 装机版现在起不来，到底报什么错？
 *  用法：node app-slot.cjs -- node diag-error.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
const { chromium } = require('C:/Windows/System32/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..', '..');
const EXE = path.join(ROOT, 'MarkPilot-CM6', 'dist', 'win-unpacked', 'MarkPilot.exe');
const DOC = path.join(ROOT, '.mp-verify', 'demo', '验收清单.md');
const PROFILE = path.join(__dirname, 'profile-err');
const PORT = 9595;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [DOC, `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`], { env, stdio: 'ignore' });
  let exited = null;
  child.on('exit', (c, s) => { exited = { c, s }; });
  let cdp = null;
  for (let i = 0; i < 12 && !cdp && !exited; i++) { await sleep(1000); try { cdp = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { } }
  console.log(`· CDP=${cdp ? 'ok' : 'fail'}  子进程=${exited ? JSON.stringify(exited) : 'alive'}  pid=${child.pid}`);
  const dump = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$procs = Get-CimInstance Win32_Process -Filter "Name='MarkPilot.exe'" | Where-Object { $_.CommandLine -like '*profile-err*' -and $_.CommandLine -notlike '*--type=*' }
foreach ($p in $procs) {
  $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  "=== pid $($p.ProcessId) title '$($proc.MainWindowTitle)' ==="
  try {
    $el = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
    if ($el) {
      $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($k in $kids) { if ($k.Current.Name) { "   " + $k.Current.Name } }
    }
  } catch { "   UIA: $($_.Exception.Message)" }
}`;
  fs.writeFileSync(path.join(__dirname, 'uia-err.ps1'), dump, 'utf8');
  try { console.log(execSync(`pwsh -NoProfile -File "${path.join(__dirname, 'uia-err.ps1')}"`, { encoding: 'utf8', windowsHide: true })); } catch (e) { console.log('UIA dump 失败', e.message); }
  try { console.log(execSync(`pwsh -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='MarkPilot.exe'\\" | Where-Object { $_.CommandLine -like '*profile-err*' } | Select-Object ProcessId,CommandLine | Format-List | Out-String"`, { encoding: 'utf8', windowsHide: true }).slice(0, 900)); } catch { }
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { try { child.kill(); } catch { } }
  if (cdp) { try { await cdp.close(); } catch { } }
  await sleep(800);
  process.exit(0);
})();
