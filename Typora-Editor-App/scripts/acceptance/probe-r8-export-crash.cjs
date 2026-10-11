/** R8 · 「大文件导出死机」GUI 复现取证探针（取证员 B 专用）。
 *
 *  背景：用户报 696KB md（9609 行 / 1601 表格行 / 21 配图）导出 PDF「电脑死机崩溃」。
 *  本探针在 dev 版（electron.exe + app/main/main.js，铁律：全机唯一 dev 实例）上
 *  复现并量化资源失控——**边导出边采样**，不是导完才断言：
 *
 *    · 20s 一轮全量采样：tasklist 全部 electron 进程内存 + PowerShell CIM 定位 dev 进程树
 *      （本机 wmic 已被移除，用 Get-CimInstance 替代）+ Electron appMetrics/getOSProcessId
 *      精确分角色（shell 主窗渲染 vs export worker 渲染）；
 *    · 4s 一轮轻量采样：导出对话框阶段文本（真实 DOM #export-message）+ exporter
 *      job 状态 + shell 页 CDP 往返耗时（>5s 视为假死，>8s 判无响应）；
 *    · export worker（/shell/export.html 隐藏窗）也接 CDP：块数 / innerText 长度 /
 *      performance.memory / 往返耗时——正是资源失控的头号嫌疑进程；
 *    · 【安全红线】dev 渲染进程 RSS > 3.5GB → 只杀那个 PID（认准 dev 进程树内的
 *      electron.exe）；UI 连续 3 分钟假死且零进展 → 杀整棵 dev 树。绝不碰用户自己的
 *      MarkPilot.exe / 任何不在 dev 树里的进程。
 *
 *  触发链路全部走真实产品路径：菜单「文件 > 导出 > PDF 文档…」（clickMenu 等价于
 *  用户点击同一 menu item 的 click 处理器 → rec.exporter.run(format)，与工具栏按钮
 *  弹出的原生菜单同一条代码）；保存对话框用 harness 的主进程 dialog 替身（只替身
 *  「用户选了哪个路径」，其后 getValue→worker→prepareExport→finishExport→printToPDF
 *  →落盘全是真产品代码）。
 *
 *  素材：E:/MarkPilot/.zcode-tmp/r8-export/doc/银行笔试题库-重排版.md（只读使用）。
 *  产物：截图与 timeline-*.json 落 .perf/probe-r8-export/。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const harness = require('./harness.cjs');

const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_ARGS = [path.join(harness.project, 'app/main/main.js')];
const OUT = path.join(harness.project, '.perf/probe-r8-export');
const OUTDIR = 'E:/MarkPilot/.zcode-tmp/r8-export/out';
const PS = harness.POWERSHELL;
const sleep = harness.sleep;

const RSS_LIMIT_MB = 3500;        // 红线一：dev 渲染进程 RSS 上限
const FREEZE_LIMIT_MS = 180000;   // 红线二：UI 假死 + 零进展 连续时长上限
const TICK_MS = Number(process.env.R8_TICK_MS) || 4000;   // 轻量轮询（阶段文本 / 健康 / worker RTT）
const STRIDE = 5;                 // 每 5 个 tick 一轮全量（R8_STRIDE 可覆盖）
const FAST = process.env.R8_FAST === '1';   // 旧开关：8s 一轮全量（验收轮用 R8_TICK_MS/R8_STRIDE 显式控制）
// 验收轮参数化：R8_DOC 换文档（小文档回归）、R8_BASE 换产物名、R8_SKIP_MENU 跳过菜单取证
const DOC = process.env.R8_DOC || 'E:/MarkPilot/.zcode-tmp/r8-export/doc/银行笔试题库-重排版.md';
const READY_NEEDLE = ((fs.readFileSync(DOC, 'utf8').match(/^#\s+(.+)$/m) || [])[1] || '').slice(0, 10);
const PING_TIMEOUT = 8000;        // 单次 CDP 往返判定上限
const HARD_CAP_MS = 30 * 60000;   // 单格式探针硬上限

// ---------- Windows 侧工具（.ps1 一律纯 ASCII，铁律 38） ----------
function writePs1(file, lines) { fs.writeFileSync(file, lines.join('\r\n'), 'ascii'); }
function psRun(file, args) {
  return execFileSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
    { windowsHide: true, encoding: 'utf8', timeout: 20000 });
}
function psJson(script, args, tmp) {
  try { psRun(script, args); return JSON.parse(fs.readFileSync(tmp, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return null; }
}
function psRunInline(command) {
  return execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
}
/** tasklist /FI "IMAGENAME eq electron.exe" /FO CSV —— 任务书指定口径。 */
function tasklistElectron() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/FO', 'CSV'], { encoding: 'utf8' });
    return out.split(/\r?\n/).filter(l => l.includes('"electron.exe"')).map(l => {
      const c = l.trim().replace(/^"|"$/g, '').split('","');
      return { pid: Number(c[1]), memK: Number((c[4] || '0').replace(/[^\d]/g, '')) };
    });
  } catch { return []; }
}

// ---------- 会话小助手（照抄 probe-r5-export.cjs 的成熟件） ----------
const editorReady = title => `(() => { const f = document.getElementById('editor'); const w = f && f.contentWindow;
  const root = w && w.document && w.document.querySelector('.vditor-ir .vditor-reset');
  return !!(root && root.textContent.includes(${JSON.stringify(title)})); })()`;
const frameEval = (s, code) => s.js(`(() => { const f = document.getElementById('editor'); const w = f && f.contentWindow;
  if (!w || !w.document || !w.document.body) return null;
  return (function (document, window) { ${code} })(w.document, w); })()`);
const framePoint = (s, expr) => s.js(`(() => { const f = document.getElementById('editor'); const w = f && f.contentWindow;
  if (!w) return null; const p = (function (document, window) { ${expr} })(w.document, w);
  if (!p || p.x === undefined) return null;
  const fr = f.getBoundingClientRect(); return { x: Math.round(fr.x + p.x), y: Math.round(fr.y + p.y) }; })()`);

// ---------- 页面探针表达式 ----------
const SHELL_PROBE = `(() => {
  const dlgMsg = document.querySelector('#export-message');
  const dlgEl = document.getElementById('export-dialog');
  const frame = document.getElementById('editor');
  const ed = frame && frame.contentWindow;
  const mem = x => (x && x.performance && x.performance.memory) ? {
    usedMB: Math.round(x.performance.memory.usedJSHeapSize / 1048576),
    totalMB: Math.round(x.performance.memory.totalJSHeapSize / 1048576) } : null;
  let edTextLen = null;
  try { if (ed && ed.document && ed.document.body) edTextLen = ed.document.body.innerText.length; } catch (e) {}
  return JSON.stringify({ ts: Date.now(), dialog: dlgMsg ? String(dlgMsg.textContent).trim() : null,
    dialogOpen: !!(dlgEl && dlgEl.open), topMem: mem(window), edMem: ed ? mem(ed) : null, edTextLen });
})()`;
const WORKER_PROBE = `(() => {
  const art = document.getElementById('content');
  const mem = performance.memory ? { usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
    totalMB: Math.round(performance.memory.totalJSHeapSize / 1048576) } : null;
  return JSON.stringify({ ts: Date.now(), blocks: art ? art.children.length : null,
    katex: document.querySelectorAll('.katex').length, imgs: document.querySelectorAll('img').length,
    kp: window.__kpStats ? { applied: window.__kpStats.applied, lines: window.__kpStats.lines } : null,
    mem, textLen: document.body ? document.body.innerText.length : null, ready: document.readyState });
})()`;
const EXPORTER_JS = `(() => { try {
  const rec = global.windows && global.windows[0]; const e = rec && rec.exporter;
  if (!e) return JSON.stringify({ job: false, noExporter: true });
  return JSON.stringify({ job: !!e.job, committing: !!(e.job && e.job.committing),
    timedOut: !!(e.job && e.job.timedOut), last: e.last || null });
} catch (err) { return JSON.stringify({ err: String(err && err.message || err) }); } })()`;
const WINROLES_JS = `(() => { try { const { BrowserWindow } = require('electron');
  return JSON.stringify(BrowserWindow.getAllWindows().map(w => { try {
    return { id: w.id, osPid: w.webContents.getOSProcessId(), url: w.webContents.getURL(), visible: w.isVisible() };
  } catch (e) { return { id: w.id, err: String(e && e.message || e) }; } }));
} catch (e) { return '[]'; } })()`;
const METRICS_JS = `(() => { try {
  return JSON.stringify(require('electron').app.getAppMetrics().map(m => ({
    pid: m.pid !== undefined ? m.pid : null, osPid: m.osPid !== undefined ? m.osPid : null,
    type: m.type, cpuPct: m.cpu ? Math.round(m.cpu.percent) : null,
    wsKB: m.memory ? m.memory.workingSetSize : null, privKB: m.memory ? m.memory.privateBytes : null })));
} catch (e) { return '[]'; } })()`;

const listTargets = port => new Promise(resolve => {
  const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 3000 }, res => {
    let body = ''; res.on('data', c => { body += c; });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve([]); } });
  });
  req.on('timeout', () => { req.destroy(); resolve([]); });
  req.on('error', () => resolve([]));
});
function connectWorker(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let seq = 0; const pending = new Map();
    ws.onmessage = ev => { const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id);
        m.error ? r.reject(new Error(m.error.message)) : r.resolve(m.result); } };
    ws.onopen = () => resolve({
      send: (method, params = {}, timeoutMs = PING_TIMEOUT) => new Promise((res, rej) => {
        const id = ++seq; const timer = setTimeout(() => { pending.delete(id); rej(new Error('timeout')); }, timeoutMs);
        pending.set(id, { resolve: v => { clearTimeout(timer); res(v); }, reject: e => { clearTimeout(timer); rej(e); } });
        try { ws.send(JSON.stringify({ id, method, params })); } catch (e) { clearTimeout(timer); pending.delete(id); rej(e); }
      }),
      close: () => { try { ws.close(); } catch {} },
    });
    ws.onerror = () => reject(new Error('worker websocket 连接失败'));
  });
}
function computeTree(cim, rootPid) {
  const set = new Set([rootPid]);
  if (!cim) return set;
  const list = Array.isArray(cim) ? cim : [cim];
  const byParent = new Map();
  for (const p of list) { if (!p || !p.ProcessId) continue; const arr = byParent.get(p.ParentProcessId) || []; arr.push(p.ProcessId); byParent.set(p.ParentProcessId, arr); }
  const stack = [rootPid];
  while (stack.length) { const pid = stack.pop(); for (const c of (byParent.get(pid) || [])) if (!set.has(c)) { set.add(c); stack.push(c); } }
  return set;
}
function resolveRoles(winRoles, metrics) {
  const roles = new Map();
  for (const w of winRoles || []) {
    if (!w || !w.osPid) continue;
    roles.set(w.osPid, String(w.url).includes('/shell/export.html') ? 'export-worker'
      : (String(w.url).includes('/shell') ? 'shell-window' : 'window:' + String(w.url).slice(0, 40)));
  }
  for (const m of metrics || []) { const pid = m.osPid ?? m.pid; if (pid && !roles.has(pid)) roles.set(pid, String(m.type)); }
  return roles;
}
const mb = v => Math.round(v / 1048576);

// ---------- 主流程 ----------
(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(OUTDIR, { recursive: true });

  // 现场自备的纯 ASCII PowerShell 工具
  const PS_SNAP = path.join(OUT, 'proc-snap.ps1');   // Get-Process：CPU 秒 + WS + PM
  writePs1(PS_SNAP, [
    'param([string]$OutFile)',
    '$p = Get-Process electron -ErrorAction SilentlyContinue | Select-Object Id,CPU,@{n=\'WS\';e={[int64]$_.WorkingSet64}},@{n=\'PM\';e={[int64]$_.PrivateMemorySize64}}',
    '$p | ConvertTo-Json -Compress | Out-File -Encoding ascii -FilePath $OutFile',
  ]);
  const PS_TREE = path.join(OUT, 'proc-tree.ps1');   // CIM：PID/PPID/命令行（识别 dev 进程树）
  writePs1(PS_TREE, [
    'param([string]$OutFile)',
    '$p = Get-CimInstance Win32_Process -Filter "Name=\'electron.exe\'" | Select-Object ProcessId,ParentProcessId,@{n=\'CL\';e={ if ($_.CommandLine) { $_.CommandLine.Substring(0, [Math]::Min(200, $_.CommandLine.Length)) } else { $null } }}',
    '$p | ConvertTo-Json -Compress | Out-File -Encoding utf8 -FilePath $OutFile',
  ]);
  const PS_SHOT = path.join(OUT, 'screen-capture.ps1'); // 屏幕级截图（原生菜单 CDP 拍不到；CDP 冻结时的备胎）
  writePs1(PS_SHOT, [
    'param([int]$X, [int]$Y, [int]$W, [int]$H, [string]$OutPath)',
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type -AssemblyName System.Windows.Forms',
    'if ($W -le 0 -or $H -le 0) { $v = [System.Windows.Forms.SystemInformation]::VirtualScreen; $X = $v.X; $Y = $v.Y; $W = $v.Width; $H = $v.Height }',
    '$bmp = New-Object System.Drawing.Bitmap($W, $H)',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)))',
    '$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)',
    '$g.Dispose(); $bmp.Dispose()',
    'Write-Output ("saved " + $OutPath)',
  ]);
  const PS_ESC = path.join(OUT, 'esc-menu.ps1');     // 关原生菜单的兜底（前台归属核对后才发 ESC）
  writePs1(PS_ESC, [
    'param([int]$TargetPid)',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$src = \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\'',
    'Add-Type -MemberDefinition $src -Name Native -Namespace Win',
    '$proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue',
    'if (-not $proc) { Write-Output "no-process"; exit 1 }',
    '$fg = [Win.Native]::GetForegroundWindow()',
    'if ($fg -ne $proc.MainWindowHandle) { Write-Output ("foreground-mismatch " + $fg); exit 2 }',
    '[System.Windows.Forms.SendKeys]::SendWait("{ESC}")',
    'Write-Output "esc-sent"',
  ]);
  const snapTmp = path.join(OUT, 'proc-snap.json');
  const treeTmp = path.join(OUT, 'proc-tree.json');
  const screenShotTo = (name, rect) => {
    try { psRun(PS_SHOT, ['-X', rect ? rect.x : 0, '-Y', rect ? rect.y : 0, '-W', rect ? rect.width : 0, '-H', rect ? rect.height : 0, '-OutPath', path.join(OUT, name)]); return true; }
    catch { return false; }
  };
  const sizeOf = name => fs.existsSync(path.join(OUT, name)) ? fs.statSync(path.join(OUT, name)).size : 0;

  const baseline = tasklistElectron();
  console.log(`R8 基线：当前 electron.exe ${baseline.length} 个${baseline.length ? '（pid ' + baseline.map(p => p.pid).join(',') + '）' : '，dev 独占确认'}`);

  // ========== 启动 dev 实例并打开大文档 ==========
  const session = await harness.launch({ exe: EXE, appArgs: APP_ARGS, inspect: true,
    outDir: OUT, args: [DOC], timeout: 120000, label: 'r8export' });
  const mainPid = session.child.pid;
  console.log(`R8 dev 主进程 pid=${mainPid}（杀进程只认这棵树）`);
  const summaries = {};
  try {
    // ---- 取证 1：加载耗时 + 挂载块数 ----
    const loadStart = Date.now();
    const ready = await session.until(editorReady(READY_NEEDLE), { timeout: 240000, interval: 250 });
    const loadMs = Date.now() - loadStart;
    const wv = session.windowVisible();
    const blocks = await frameEval(session, `const root = document.querySelector('.vditor-ir .vditor-reset');
      return root ? { topBlocks: root.children.length, nodes: root.querySelectorAll('*').length } : null;`);
    const mathStats = await frameEval(session, `return window.__typoraMathStats ? { done: window.__typoraMathStats.done, pending: window.__typoraMathStats.pending } : null;`);
    const loadShell = await frameEval(session, `const m = performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : null;
      return { textLen: document.body.innerText.length, heapMB: m };`);
    let totalRAM = null, freeRAM = null;
    try {
      const ram = psRunInline('[Console]::OutputEncoding=[Text.Encoding]::UTF8; $cs = Get-CimInstance Win32_ComputerSystem; $os = Get-CimInstance Win32_OperatingSystem; Write-Output ([string]([math]::Round($cs.TotalPhysicalMemory/1GB,1)) + \';\' + [string]([math]::Round($os.FreePhysicalMemory/1MB,1)))');
      const parts = String(ram).trim().split(';'); totalRAM = parts[0]; freeRAM = parts[1];
    } catch {}
    console.log(`R8 加载：ready=${ready} 耗时=${loadMs}ms 窗口可见=${wv ? wv.spawnToVisible + 'ms' : '未取得'} 顶层块=${blocks && blocks.topBlocks} 节点=${blocks && blocks.nodes} 数学pending=${mathStats && mathStats.pending} innerText=${loadShell && loadShell.textLen} 编辑器堆=${loadShell && loadShell.heapMB}MB 整机RAM=${totalRAM}GB(空闲${freeRAM}GB)`);
    fs.writeFileSync(path.join(OUT, 'load.json'), JSON.stringify({ doc: DOC, docBytes: fs.statSync(DOC).size, ready, loadMs, windowVisible: wv, blocks, mathStats, loadShell, totalRAMGB: totalRAM, freeRAMGB: freeRAM }, null, 2));
    await session.shot('00-load-done');

    // ---- 取证 2：导出菜单截图（真实 CDP 点击工具栏「导出」按钮 → 原生菜单 → CopyFromScreen） ----
    let bounds = { x: 0, y: 0, width: 0, height: 0 };
    try { bounds = JSON.parse(await session.main.js(`JSON.stringify(global.windows[0].win.getBounds())`)); } catch {}
    const menuTree = await session.main.menu();
    const exportItems = menuTree.filter(i => i.path.startsWith('文件 > 导出')).map(i => `${i.path} [${i.enabled ? '可用' : '灰'}]`);
    console.log(`R8 菜单树里的导出项（${exportItems.length}）：${exportItems.join(' ｜ ')}`);
    if (process.env.R8_SKIP_MENU === '1') {
      console.log('R8_SKIP_MENU=1：本轮跳过菜单取证');
    } else {
    const btn = await framePoint(session, `const b = [...document.querySelectorAll('.vditor-toolbar [data-type]')]
      .find(e => String(e.dataset.type || '').includes('document-export'));
      if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
    if (btn) {
      // CDP 输入需要前台窗口（铁律 24）：先把 dev 窗口带到前台再点工具栏。
      // 红轮教训：OS 前台在提权终端宿主手里时 Menu.popup 根本不渲染（三次全屏差分≈0）。
      // 新招：最小化→还原会从 Windows 拿回前台权（restore 授予前台），再弹菜单。
      await session.main.js(`(() => { const r = global.windows[0]; if (r && r.win && !r.win.isDestroyed()) { if (r.win.isMinimized()) r.win.restore(); r.win.focus(); } return true; })()`);
      await sleep(250);
      screenShotTo('01-base-fullscreen.png', null);
      await session.click(btn.x, btn.y);
      await sleep(500);
      screenShotTo('01-export-menu-popup.png', bounds);      // 整窗区域（辅助）
      screenShotTo('01-export-menu-fullscreen.png', null);   // 全屏（菜单可能弹在光标处）
      const menuSeen = Math.abs(sizeOf('01-export-menu-fullscreen.png') - sizeOf('01-base-fullscreen.png')) > 3000;
      if (!menuSeen) {
        // 兜底二：最小化→还原拿前台权，再走与工具栏同一条 IPC 弹菜单
        await session.main.js(`(() => { const r = global.windows[0]; const w = r.win; if (!w.isDestroyed()) { w.minimize(); setTimeout(() => { w.restore(); w.focus(); }, 250); } return true; })()`);
        await sleep(900);
        await session.js(`window.hostApi ? String(window.hostApi.invoke('export-menu')) : 'no-hostApi'`);
        await sleep(500);
        screenShotTo('01-export-menu-restore-trick.png', null);
        console.log('R8 菜单兜底（最小化→还原→IPC 弹菜单）已执行，全屏截图 01-export-menu-restore-trick.png');
      }
      await session.main.js(`(() => { const w = require('electron').BrowserWindow.getFocusedWindow(); if (w) { w.blur(); return 'blurred'; } return 'no-focused'; })()`); // 失活关菜单
      await sleep(500);
      screenShotTo('01b-menu-after-dismiss.png', bounds);
      const a = fs.existsSync(path.join(OUT, '01-export-menu-fullscreen.png')) && fs.statSync(path.join(OUT, '01-export-menu-fullscreen.png')).size;
      const b0 = fs.existsSync(path.join(OUT, '01-base-fullscreen.png')) && fs.statSync(path.join(OUT, '01-base-fullscreen.png')).size;
      if (a && b0 && Math.abs(a - b0) < 3000) {              // 与基线几乎一样 → 菜单没拍到/没弹出
        console.log('R8 警示：全屏菜单截图与基线差异过小（' + b0 + '→' + a + ' 字节），菜单证据以菜单树转储 + 导出对话框为准');
      }
      // 前台归属核对后兜底 ESC（关残留菜单）
      try { psRun(PS_ESC, ['-TargetPid', String(mainPid)]); } catch {}
      await sleep(600);
    } else { console.log('R8 未找到工具栏导出按钮（跳过原生菜单截屏，菜单项清单见上）'); }
    }

    // ---- 取证 3/5：PDF（用户场景）与 HTML（对照）逐格式采样导出 ----
    const BASE = process.env.R8_BASE || path.basename(DOC, '.md');
    const formats = [
      { fmt: 'pdf', menuItem: '文件 > 导出 > PDF 文档…', target: path.join(OUTDIR, BASE + '.pdf'), prefix: '02' },
      { fmt: 'html', menuItem: '文件 > 导出 > HTML（独立网页）…', target: path.join(OUTDIR, BASE + '.html'), prefix: '05' },
    ].filter(f => !process.env.R8_FORMATS || process.env.R8_FORMATS.split(',').includes(f.fmt));
    for (const f of formats) {
      const summary = await runExportSampled(f);
      summaries[f.fmt] = summary;
      if (summary.killedPids && summary.killedPids.includes(mainPid)) {
        console.log('R8 dev 树已被红线终止，停止后续格式');
        break;
      }
      await sleep(3000);
    }
  } finally {
    try { await session.close(); } catch {}
    console.log('R8 会话已收尾（dev 实例已关闭）');
  }
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summaries, null, 2));
  console.log('R8 汇总：' + JSON.stringify(summaries));

  /** 单个格式的「边导出边采样」全流程。 */
  async function runExportSampled({ fmt, menuItem, target, prefix }) {
    console.log(`\n===== 导出 ${fmt.toUpperCase()}（真实菜单链 exporter.run('${fmt}')）=====`);
    await session.main.clearCalls();
    await session.main.script([{ dialog: 'save', file: target }]);   // 替身：用户在保存框选了 target
    let worker = null; let workerClosed = false;
    const timeline = []; const killedPids = []; const notes = []; const curve = [];
    const workerRttSamples = [];      // G4：每次 worker CDP 往返都记录（含 >1s/>2s 黑窗清单）
    let workerLatest = null;          // 最近一次 worker 内部读数（blocks/kp/mem）
    const msgAt = {};
    let lastDialog = null; let lastSig = null; let progressAt = 0;
    let frozenMs = 0; let frozenShotTaken = false; let earlyShotTaken = false; let compatShotTaken = false;
    const t0 = Date.now(); const rel = () => Date.now() - t0;
    const clicked = await session.main.clickMenu(menuItem);
    console.log(`R8[${fmt}] t=0ms 菜单触发：${clicked}`);
    progressAt = 0;
    let tick = 0; let ended = null; let lastEntry = null;
    let winBounds = null;
    try { winBounds = JSON.parse(await session.main.js(`JSON.stringify(global.windows[0].win.getBounds())`)); } catch {}

    while (Date.now() - t0 < HARD_CAP_MS) {
      tick++;
      const tickStart = Date.now(); const t = rel();
      // --- 轻量：shell 往返 + 阶段文本 + exporter 状态 ---
      let shell = null; let shellRtt = null;
      const pingStart = Date.now();
      try {
        const r = await session.send('Runtime.evaluate', { expression: SHELL_PROBE, returnByValue: true }, PING_TIMEOUT);
        shellRtt = Date.now() - pingStart;
        try { shell = JSON.parse((r.result && r.result.value) || 'null'); } catch { /* 值异常按无处理 */ }
      } catch { shellRtt = -1; }
      const dialog = shell && shell.dialog;
      if (dialog && dialog !== lastDialog) { msgAt[dialog.slice(0, 36)] = t; console.log(`R8[${fmt}] t=${(t / 1000).toFixed(1)}s 阶段→「${dialog.slice(0, 60)}」`); lastDialog = dialog; progressAt = t; }
      let exp = null;
      try { exp = JSON.parse(await session.main.js(EXPORTER_JS)); } catch { /* 主进程忙（罕见） */ }
      if (shellRtt !== null && shellRtt >= 0 && shellRtt <= 5000) frozenMs = 0; else frozenMs += TICK_MS;
      const jobDone = exp && exp.job === false && t > 2500;

      // --- worker（export.html 隐藏窗）CDP：每 tick 连一次 + 测一次往返（G4 黑窗口径） ---
      let workerRtt = null;
      if (!worker && !workerClosed) {
        const targets = await listTargets(session.port);
        const wt = targets.find(x => x.type === 'page' && String(x.url).includes('/shell/export.html') && x.webSocketDebuggerUrl);
        if (wt) { try { worker = await connectWorker(wt); notes.push(`worker 页目标出现 t=${t}ms`); } catch { /* 下轮再试 */ } }
      }
      if (worker) {
        const wStart = Date.now(); let wData = null;
        try {
          const r = await worker.send('Runtime.evaluate', { expression: WORKER_PROBE, returnByValue: true }, PING_TIMEOUT);
          workerRtt = Date.now() - wStart;
          try { wData = JSON.parse((r.result && r.result.value) || 'null'); } catch {}
        } catch { workerRtt = -1; }
        if (wData) {
          workerLatest = wData;
          const sig = JSON.stringify([wData.blocks, wData.textLen]);
          if (sig !== lastSig) { progressAt = t; lastSig = sig; }
        }
        workerRttSamples.push({ t, rttMs: workerRtt });
        if (workerRtt > 1000) console.log(`R8[${fmt}] t=${(t / 1000).toFixed(1)}s worker 往返 ${workerRtt}ms（>1s）`);
        if (workerRtt === -1 && jobDone) { worker.close(); worker = null; workerClosed = true; }
      }
      // --- G8：兼容模式对话框出现的瞬间截图存证 ---
      if (!compatShotTaken && dialog && dialog.includes('超大文档兼容模式')) {
        const n = await quickShot(`${prefix}-compat-dialog`);
        if (winBounds) screenShotTo(`${prefix}-compat-dialog-screen.png`, winBounds);
        console.log(`R8[${fmt}] t=${(t / 1000).toFixed(1)}s G8 兼容模式对话框已截（${n || 'CDP 失败，屏幕截图已存'}）`);
        compatShotTaken = true;
      }

      // --- 每 tick 的资源曲线（只问主进程 appMetrics/getOSProcessId，不打扰忙碌的渲染进程） ---
      try {
        const rolesArrT = JSON.parse((await session.main.js(WINROLES_JS)) || '[]');
        const metricsT = JSON.parse((await session.main.js(METRICS_JS)) || '[]');
        const rolesT = resolveRoles(rolesArrT, metricsT);
        const ce = { t, procs: metricsT.map(m => { const pid = m.osPid ?? m.pid;
          return { pid, role: rolesT.get(pid) || m.type, wsMB: Math.round((m.wsKB || 0) / 1024), cpuPct: m.cpuPct }; }) };
        curve.push(ce);
        for (const p of ce.procs) {   // 红线一·快速版：4s 粒度盯渲染进程 RSS
          if (p.wsMB > RSS_LIMIT_MB && /Renderer|shell-window|export-worker/.test(p.role) && !killedPids.length) {
            try { execFileSync('taskkill', ['/PID', String(p.pid), '/F'], { stdio: 'ignore' }); } catch {}
            const note = `【红线一·快速】pid ${p.pid}（${p.role}）RSS=${p.wsMB}MB > ${RSS_LIMIT_MB}MB：已复现资源失控，为保主机主动终止该 dev 渲染进程`;
            notes.push(note); killedPids.push(p.pid);
            console.log(`R8[${fmt}] ${note}`);
          }
        }
      } catch { /* 主进程暂时读不到，下个 tick 再说 */ }

      // --- 全量轮（默认 20s 一轮；R8_STRIDE/R8_FAST 可加密；结束轮也做全量） ---
      const stride = Number(process.env.R8_STRIDE) || (FAST ? 2 : STRIDE);
      if (tick % stride === 1 || jobDone) {
        const entry = { t, wall: new Date().toISOString(), shellRtt, shell, exp, procs: [], metrics: null, worker: null, notes: [] };
        try { await session.key({ key: 'F13', code: 'F13', vk: 124 }); } catch { /* 输入通道也冻着——本身就是证据 */ }
        const taskl = tasklistElectron();
        const snap = psJson(PS_SNAP, ['-OutFile', snapTmp], snapTmp);
        const cim = psJson(PS_TREE, ['-OutFile', treeTmp], treeTmp);
        const tree = computeTree(cim, mainPid);
        let rolesArr = []; let metricsArr = [];
        try { rolesArr = JSON.parse((await session.main.js(WINROLES_JS)) || '[]'); } catch {}
        try { metricsArr = JSON.parse((await session.main.js(METRICS_JS)) || '[]'); } catch {}
        const roles = resolveRoles(rolesArr, metricsArr);
        const snapList = Array.isArray(snap) ? snap : (snap ? [snap] : []);
        for (const s of snapList) {
          if (!tree.has(s.Id)) continue;                     // 只统计 dev 树内的 electron.exe
          entry.procs.push({ pid: s.Id, role: roles.get(s.Id) || 'dev-其它',
            wsMB: mb(s.WS || 0), pmMB: mb(s.PM || 0), cpuS: s.CPU });
        }
        entry.metrics = metricsArr; entry.tasklistElectron = taskl.length;
        if (workerLatest) entry.worker = { rttMs: workerRtt, ...workerLatest };
        // --- 截图节律：导出早期一张 / 假死首现一张（CDP + 屏幕双通道）/ 结束一张 ---
        if (!earlyShotTaken && t > 15000) { const n = await quickShot(`${prefix}-during-early`); if (n) earlyShotTaken = true; }
        if (!frozenShotTaken && (shellRtt === -1 || shellRtt > 5000)) {
          const n = await quickShot(`${prefix}-during-frozen`);
          if (winBounds) screenShotTo(`${prefix}-during-frozen-screen.png`, winBounds);
          console.log(`R8[${fmt}] t=${(t / 1000).toFixed(1)}s 假死首现：shellRTT=${shellRtt === -1 ? '无响应' : shellRtt + 'ms'}（CDP 截图=${n || '失败/超时'}，屏幕截图已存）`);
          frozenShotTaken = true;
        }
        // --- 红线一：dev 渲染进程 RSS ---
        for (const p of entry.procs) {
          if (p.wsMB > RSS_LIMIT_MB && /Renderer|shell-window|export-worker/.test(p.role)) {
            try { execFileSync('taskkill', ['/PID', String(p.pid), '/F'], { stdio: 'ignore' }); } catch {}
            const note = `【红线一】pid ${p.pid}（${p.role}）RSS=${p.wsMB}MB > ${RSS_LIMIT_MB}MB：已复现资源失控，为保主机主动终止该 dev 渲染进程`;
            entry.notes.push(note); notes.push(note); killedPids.push(p.pid);
            console.log(`R8[${fmt}] ${note}`);
          }
        }
        // --- 红线二：UI 连续 3 分钟假死且零进展 ---
        if (frozenMs >= FREEZE_LIMIT_MS && t - progressAt >= FREEZE_LIMIT_MS) {
          try { execFileSync('taskkill', ['/PID', String(mainPid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
          const note = `【红线二】UI 假死 ${Math.round(frozenMs / 1000)}s 且 ${Math.round((t - progressAt) / 1000)}s 零进展：已杀整棵 dev 树（pid ${mainPid}）`;
          entry.notes.push(note); notes.push(note); killedPids.push(mainPid);
          console.log(`R8[${fmt}] ${note}`);
        }
        timeline.push(entry); lastEntry = entry;
        fs.writeFileSync(path.join(OUT, `timeline-${fmt}.json`), JSON.stringify({ fmt, invokedAt: new Date(t0).toISOString(), menuItem, target, stages: msgAt, killedPids, notes, timeline, curve, workerRttSamples }, null, 2));
        const pr = entry.procs.map(p => `#${p.pid}(${p.role})${p.wsMB}MB/cpu${p.cpuS === null || p.cpuS === undefined ? '?' : p.cpuS.toFixed(1)}s`).join(' ');
        console.log(`R8[${fmt}] t=${String(Math.round(t / 1000)).padStart(3)}s shellRTT=${shellRtt === -1 ? '无响应' : shellRtt + 'ms'} workerRTT=${entry.worker ? (entry.worker.rttMs === -1 ? '无响应' : entry.worker.rttMs + 'ms') : '—'} 阶段=${dialog ? dialog.slice(0, 18) : '—'} | ${pr}`);
        if (jobDone) {
          ended = { t, dialog, exp };
          await quickShot(`${prefix}-end`);
          if (winBounds) screenShotTo(`${prefix}-end-screen.png`, winBounds);
          break;
        }
        if (killedPids.includes(mainPid)) break;
      } else {
        console.log(`R8[${fmt}] t=${String(Math.round(t / 1000)).padStart(3)}s (tick) shellRTT=${shellRtt === -1 ? '无响应' : shellRtt + 'ms'} workerRTT=${workerRtt === null ? '—' : (workerRtt === -1 ? '无响应' : workerRtt + 'ms')} 阶段=${dialog ? dialog.slice(0, 18) : '—'} job=${exp ? String(exp.job) : '?'}${exp && exp.committing ? '(committing)' : ''}`);
      }
      await sleep(Math.max(150, TICK_MS - (Date.now() - tickStart)));
    }
    if (worker) { worker.close(); worker = null; }
    // ---- 收尾统计：总耗时 / 产物 / 阶段切分 ----
    await sleep(1200);
    let fileStat = null; try { fileStat = fs.statSync(target); } catch {}
    let calls = []; try { calls = await session.main.calls(); } catch {}
    const saveCall = calls.find(c => c.kind === 'save');
    const saveAt = saveCall ? (new Date(saveCall.at).getTime() - t0) : null;    // getValue 完成时刻（对话框在 getValue 之后才弹）
    let finalDialog = ended && ended.dialog;
    try { const d = await session.js(`(() => { const m = document.querySelector('#export-message'); return m ? m.textContent.trim() : null; })()`); if (d) finalDialog = d; } catch {}
    // 结束态：展开「导出提示」warnings 面板并截图（G8 证据）
    let warningsPanel = null;
    try {
      warningsPanel = await session.js(`(() => { const d = document.querySelector('#export-dialog'); if (!d) return null;
        const det = d.querySelector('details'); if (!det) return null; det.open = true;
        return String(det.querySelector('pre').textContent).slice(0, 600); })()`);
      if (warningsPanel) { const n = await quickShot(`${prefix}-end-warnings`); if (winBounds) screenShotTo(`${prefix}-end-warnings-screen.png`, winBounds); console.log(`R8[${fmt}] warnings 面板已展开截图（${n || '失败'}）：${String(warningsPanel).slice(0, 160)}`); }
    } catch {}
    const rttOk = workerRttSamples.filter(s => s.rttMs >= 0);
    const summary = {
      fmt, menuItem, clickResult: String(clicked),
      durationMs: rel(), exportWallMs: fileStat ? Math.round(fileStat.mtimeMs - t0) : null,   // 精确墙钟：产物 mtime − 菜单触发
      wallStart: new Date(t0).toISOString(),
      finalDialog: finalDialog && finalDialog.slice(0, 200), exporterLast: ended && ended.exp && ended.exp.last,
      target, fileExists: !!fileStat, fileSizeBytes: fileStat ? fileStat.size : null,
      compatMode: { dialogSeen: compatShotTaken || String(finalDialog || '').includes('超大文档兼容模式'), warningsPanel: String(warningsPanel || '').includes('超大文档兼容模式'), kpBudgetSkipped: !!(workerLatest && workerLatest.kp && workerLatest.kp.budgetSkipped) },
      workerRtt: { samples: workerRttSamples.length, maxMs: rttOk.length ? Math.max(...rttOk.map(s => s.rttMs)) : null,
        over1s: rttOk.filter(s => s.rttMs > 1000).length, over2s: workerRttSamples.filter(s => s.rttMs === -1 || s.rttMs > 2000).map(s => ({ t: s.t, rttMs: s.rttMs })) },
      kpLast: workerLatest && workerLatest.kp || null,
      stages: { saveDialogAtMs: saveAt, ...Object.fromEntries(Object.entries(msgAt).map(([k, v]) => ['t:' + k.slice(0, 24), v])) },
      killedPids, notes, rounds: timeline.length,
      peak: peakOf(timeline),
      curvePeak: curvePeakOf(curve),
    };
    fs.writeFileSync(path.join(OUT, `summary-${fmt}.json`), JSON.stringify(summary, null, 2));
    console.log(`R8[${fmt}] 结束：${JSON.stringify(summary)}`);
    return summary;
  }

  async function quickShot(name, timeoutMs = 12000) {
    try {
      const r = await session.send('Page.captureScreenshot', { format: 'png' }, timeoutMs);
      fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
      return name + '.png';
    } catch { return null; }
  }
  function peakOf(timeline) {
    let peak = { shellWsMB: 0, workerWsMB: 0, anyWsMB: 0, workerRttMax: 0, shellRttMax: 0 };
    for (const e of timeline) {
      if (e.shellRtt !== null && e.shellRtt >= 0) peak.shellRttMax = Math.max(peak.shellRttMax, e.shellRtt);
      if (e.worker && e.worker.rttMs >= 0) peak.workerRttMax = Math.max(peak.workerRttMax, e.worker.rttMs);
      for (const p of e.procs || []) {
        peak.anyWsMB = Math.max(peak.anyWsMB, p.wsMB);
        if (p.role === 'shell-window') peak.shellWsMB = Math.max(peak.shellWsMB, p.wsMB);
        if (p.role === 'export-worker') peak.workerWsMB = Math.max(peak.workerWsMB, p.wsMB);
      }
    }
    return peak;
  }
  /** 4s 粒度曲线里的峰值（appMetrics 口径，含 worker 全生命周期）。 */
  function curvePeakOf(curve) {
    const out = { byRole: {} };
    for (const ce of curve || []) {
      for (const p of ce.procs || []) {
        const key = p.role || '?';
        out.byRole[key] = Math.max(out.byRole[key] || 0, p.wsMB);
      }
    }
    return out;
  }
})().catch(error => { console.error('R8 探针自身出错：', error && error.stack || error); process.exitCode = 1; });
