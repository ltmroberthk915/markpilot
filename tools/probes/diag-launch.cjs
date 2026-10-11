/** 启动诊断：只为看清"装机版起不来"的原因（stdout/stderr 全开 + 退出码 + 端口探测）。
 *  用法：node app-slot.cjs -- node diag-launch.cjs */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
const { chromium } = require('../quality/dependencies.cjs').playwright();

const ROOT = path.resolve(__dirname, '..', '..');
const EXE = path.join(ROOT, 'MarkPilot-CM6', 'dist', 'win-unpacked', 'MarkPilot.exe');
const DOC = path.join(ROOT, '.mp-verify', 'demo', '验收清单.md');
const PROFILE = path.join(__dirname, 'profile-diag');
const PORT = 9594;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  console.log('· 现存 MarkPilot 进程（启动前）：');
  try { console.log(execSync('powershell -NoProfile -Command "Get-Process -Name \'MarkPilot CM6\' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"', { encoding: 'utf8', windowsHide: true }).trim() || '  （无）'); } catch { }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  env.ELECTRON_ENABLE_LOGGING = '1';
  const child = spawn(EXE, [DOC, `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`], { env, stdio: 'inherit' });
  let exited = null;
  child.on('exit', (code, sig) => { exited = { code, sig }; console.log(`· 子进程退出：code=${code} sig=${sig}（${Date.now() - t0} ms）`); });
  child.on('error', (e) => console.log('· spawn error:', e.message));
  const t0 = Date.now();
  let cdp = null;
  for (let i = 0; i < 12 && !cdp && !exited; i++) {
    await sleep(1000);
    try { cdp = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { }
  }
  // 探针式取证：DevTools 端点到底有没有在听？窗口有没有起来？默认 profile 有没有日志？
  try {
    const ns = execSync(`netstat -ano -p tcp | findstr :${PORT}`, { encoding: 'utf8', windowsHide: true }).trim();
    console.log('· netstat ' + PORT + ' =\n' + (ns || '  （无监听）'));
  } catch { console.log('· netstat ' + PORT + ' = （无监听）'); }
  try {
    const r = execSync(`powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri http://127.0.0.1:${PORT}/json/version -TimeoutSec 4 -UseBasicParsing).Content } catch { 'ERR ' + $_.Exception.Message }"`, { encoding: 'utf8', windowsHide: true }).trim();
    console.log('· /json/version =', r.slice(0, 220));
  } catch (e) { console.log('· /json/version 取不到'); }
  try {
    const w = execSync('powershell -NoProfile -Command "Get-Process -Name \'MarkPilot CM6\' -ErrorAction SilentlyContinue | Select-Object Id,MainWindowTitle | Format-Table -AutoSize | Out-String"', { encoding: 'utf8', windowsHide: true }).trim();
    console.log('· 进程与窗口标题 =\n' + w);
  } catch { }
  const defProf = path.join(process.env.APPDATA || '', 'markpilot-cm6');
  console.log('· 默认 userData(' + defProf + ') 存在 =', fs.existsSync(defProf), fs.existsSync(defProf) ? fs.readdirSync(defProf).slice(0, 10).join(', ') : '');
  if (fs.existsSync(path.join(defProf, 'main-debug.log'))) {
    console.log('· 默认 profile main-debug.log 尾部：');
    console.log(fs.readFileSync(path.join(defProf, 'main-debug.log'), 'utf8').split('\n').slice(-12).join('\n'));
  }
  console.log(`· ${Date.now() - t0} ms：CDP = ${cdp ? '已连上' : '未连上'}；子进程 ${exited ? '已退出 ' + JSON.stringify(exited) : '仍在运行'}`);
  if (cdp) {
    const pages = cdp.contexts()[0].pages().map((p) => p.url());
    console.log('· 页面 =', JSON.stringify(pages));
    await cdp.close();
  }
  console.log('· profile 目录内容 =', fs.existsSync(PROFILE) ? fs.readdirSync(PROFILE).slice(0, 12).join(', ') : '(不存在)');
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { try { child.kill(); } catch { } }
  await sleep(1200);
  process.exit(0);
})();
