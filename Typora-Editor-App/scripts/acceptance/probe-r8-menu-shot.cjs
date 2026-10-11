/** R8 补充取证 · 导出原生菜单弹窗截图（菜单为什么重要：它是「支持哪些格式」的可见证据）。
 *  前两轮 CDP 点击工具栏后全屏截图与基线差异 <100 字节 → 原生菜单疑似根本没弹出
 *  （OS 前台不在 dev 窗口时 Electron 的 Menu.popup 可能不显示）。本轮：
 *    1. win.focus() 后用 PowerShell 核对 OS 前台真的落在 dev 主进程上；
 *    2. 在外壳页里执行 hostApi.invoke('export-menu')（与工具栏按钮完全同一条产品 IPC）；
 *    3. 全屏 CopyFromScreen 截图，与基线做文件级对比；
 *    4. 兜底：真实 OS 级鼠标点击（SendInput，发前核对前台归属，铁律 50）点工具栏按钮再截。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const harness = require('./harness.cjs');

const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_ARGS = [path.join(harness.project, 'app/main/main.js')];
const OUT = path.join(harness.project, '.perf/probe-r8-export');
const DOC = 'E:/MarkPilot/.zcode-tmp/r8-export/doc/银行笔试题库-重排版.md';
const PS = harness.POWERSHELL;
const sleep = harness.sleep;

const PS_SHOT = path.join(OUT, 'screen-capture.ps1');       // 主探针已写好，直接复用
const PS_ESC = path.join(OUT, 'esc-menu.ps1');
const PS_FG = path.join(OUT, 'foreground-check.ps1');
fs.writeFileSync(PS_FG, [
  'param([int]$TargetPid, [string]$Force)',
  '$src = @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class Win32Fg {',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
  '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);',
  '}',
  '"@',
  'Add-Type -TypeDefinition $src',
  '$proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue',
  'if (-not $proc) { Write-Output "no-process"; exit 1 }',
  '$h = $proc.MainWindowHandle',
  'if ($Force -eq "1") {',
  '  $fg = [Win32Fg]::GetForegroundWindow()',
  '  $dummy = [uint32]0',
  '  $fgThread = [Win32Fg]::GetWindowThreadProcessId($fg, [ref]$dummy)',
  '  $dummy2 = [uint32]0',
  '  $tgThread = [Win32Fg]::GetWindowThreadProcessId($h, [ref]$dummy2)',
  '  [Win32Fg]::AttachThreadInput($fgThread, $tgThread, $true) | Out-Null',
  '  [Win32Fg]::SetForegroundWindow($h) | Out-Null',
  '  [Win32Fg]::AttachThreadInput($fgThread, $tgThread, $false) | Out-Null',
  '  Start-Sleep -Milliseconds 200',
  '}',
  '$fg2 = [Win32Fg]::GetForegroundWindow()',
  'Write-Output ("fg=" + $fg2 + " main=" + $h + " same=" + ($fg2 -eq $h))',
].join('\r\n'), 'ascii');
const forceFg = pid => execFileSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_FG, '-TargetPid', String(pid), '-Force', '1'], { windowsHide: true, encoding: 'utf8', timeout: 20000 }).trim();
const shot = name => execFileSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', PS_SHOT, '-X', '0', '-Y', '0', '-W', '0', '-H', '0', '-OutPath', path.join(OUT, name)],
  { windowsHide: true, encoding: 'utf8', timeout: 20000 });
const size = name => fs.existsSync(path.join(OUT, name)) ? fs.statSync(path.join(OUT, name)).size : 0;

(async () => {
  const session = await harness.launch({ exe: EXE, appArgs: APP_ARGS, inspect: true,
    outDir: OUT, args: [DOC], timeout: 120000, label: 'r8menu' });
  const mainPid = session.child.pid;
  try {
    await session.until(`(() => { const f = document.getElementById('editor'); const w = f && f.contentWindow;
      const root = w && w.document && w.document.querySelector('.vditor-ir .vditor-reset');
      return !!(root && root.textContent.includes('银行笔试题库')); })()`, { timeout: 240000, interval: 250 });
    await session.main.js(`(() => { const r = global.windows[0]; if (r && r.win && !r.win.isDestroyed()) { if (r.win.isMinimized()) r.win.restore(); r.win.show(); r.win.focus(); } return true; })()`);
    await sleep(600);
    console.log('前台核对：' + execFileSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_FG, '-TargetPid', String(mainPid)], { encoding: 'utf8' }).trim());
    // 第二招：最小化→还原（Windows 会给还原窗口前台权）→ 验证前台真的到手 → 再弹
    await session.main.js(`(() => { const r = global.windows[0]; const w = r.win; if (!w.isDestroyed()) { w.minimize(); setTimeout(() => { w.restore(); w.focus(); }, 250); } return true; })()`);
    await sleep(900);
    const fg2 = forceFg(mainPid);
    console.log('最小化→还原后前台：' + fg2);
    await sleep(300);
    shot('menu-a-baseline.png');
    // 真实产品 IPC：外壳页 hostApi.invoke('export-menu')（工具栏按钮同款）
    const invoked = await session.js(`window.hostApi ? String(window.hostApi.invoke('export-menu')) : 'no-hostApi'`);
    await sleep(500);
    shot('menu-b-after-popup.png');
    const diff = size('menu-b-after-popup.png') - size('menu-a-baseline.png');
    console.log(`IPC invoke('export-menu')=${invoked}；全屏截图 ${size('menu-a-baseline.png')} → ${size('menu-b-after-popup.png')} 字节（差 ${diff}）`);
    // 前台归属核对后关菜单（保底 ESC）
    try { execFileSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_ESC, '-TargetPid', String(mainPid)], { windowsHide: true, encoding: 'utf8', timeout: 20000 }); } catch {}
    await sleep(300);
    shot('menu-c-after-esc.png');
    console.log(`ESC 后全屏 ${size('menu-c-after-esc.png')} 字节`);
  } finally { await session.close(); console.log('菜单取证会话已收尾'); }
})().catch(error => { console.error('菜单取证出错：', error && error.stack || error); process.exitCode = 1; });
