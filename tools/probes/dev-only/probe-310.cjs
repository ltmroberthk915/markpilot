/** §7（3.1.0 新增能力）执行器：8 条 / 21 个自动判据 + 视觉通道清单（不由本脚本猜）。
 *  用法（单跑调试）：
 *    node accept-310.cjs --exe "..." --only=7.1,7.4        ← 推荐（自动套启动闸并合并报告）
 *    node probe-310.cjs "<exe>" [--only=7.1]
 *  纪律：找不到 UI 入口 = 红项（写明"没找到什么"），绝不静默跳过。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execSync, spawnSync } = require('node:child_process');
const { chromium } = require('../../quality/dependencies.cjs').playwright();

const DIR = __dirname;
const ROOT = path.resolve(DIR, '..', '..');
const OUT = path.join(DIR, 'accept', 'out');
const SHOTS = path.join(OUT, 'shots');
const MD = path.join(ROOT, '.mp-verify', 'demo', '验收清单.md');
const BIGDOC = process.env.MP_ACCEPT_BIGDOC || path.join(ROOT, '.mp-verify', 'demo', '01-内联大图文档.md');
const TABLE1000 = path.join(DIR, 'fixtures', '表-1000行.md');
const ARCH = path.join(ROOT, 'Typora-Editor-App', 'docs', 'ARCH-3.1.0.md');
const SMALL = path.join(DIR, 'assets', 'small.png');
const TMP = path.join(DIR, 'accept', 'tmp');
const PROFILE = path.join(DIR, 'accept', 'profile-310');
/* CDP 端口每次不同：固定端口若被残留实例占着，connectOverCDP 会连到**旧实例** ⇒ 换产物复跑会读到旧包界面（实测踩过） */
const PORT = 9500 + (process.pid % 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const posArg = argv.find((a) => !a.startsWith('--'));
const EXE = (posArg || process.env.MP_ACCEPT_EXE || '').replace(/^"|"$/g, '');
const onlyArg = (argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const ONLY = onlyArg ? onlyArg.split(',').map((s) => s.trim()).filter(Boolean) : null;
const SPECS = require('./accept/v310-specs.cjs');
/* 【定位取证开关·2026-10-09】`MP_DIAG=1` 时把 7.7 真拖选的命中物/选区读数打进 stdout。
   只加读数、不改判据。 */
const DIAG = process.env.MP_DIAG === '1';

/* 单跑时自己也套一层启动闸（与 accept-310.cjs 同一协议） */
if (process.env.MP_ACCEPT_SLOT !== '1' && !process.env.MP_ACCEPT_EXE) {
  const slot = path.join(ROOT, 'Typora-Editor-App', 'scripts', 'acceptance', 'app-slot.cjs');
  const r = spawnSync(process.execPath, [slot, '--', process.execPath, __filename, EXE], { stdio: 'inherit', cwd: ROOT, env: { ...process.env, MP_ACCEPT_SLOT: '1' } });
  process.exit(r.status === null ? 1 : r.status);
}

if (!EXE || !fs.existsSync(EXE)) {
  console.error(`\n✗ §7 执行器：找不到装机产物（不静默跳过）\n   给到的路径：${EXE || '(空)'}\n   用法：node accept-310.cjs --exe "<...MarkPilot.exe>"`);
  process.exit(2);
}
for (const f of [MD, BIGDOC, TABLE1000, SMALL]) if (!fs.existsSync(f)) { console.error(`✗ §7 执行器缺夹具：${f}`); process.exit(2); }

/* ── 从清单 md 现取行号（§7 的期望/夹具都在那里，避免两处维护） ── */
const mdLines = fs.readFileSync(MD, 'utf8').split('\n');
const lineOf = (pred, from = 0) => { for (let i = from; i < mdLines.length; i++) if (pred(mdLines[i])) return i + 1; return -1; };
const headingOf = (id) => lineOf((l) => l.startsWith('### ' + id + ' '));
const anchor = {
  '7.1': (() => {
    const h = headingOf('7.1');
    const f1 = lineOf((l) => /^```/.test(l), h);
    const f2 = lineOf((l) => /^```/.test(l), f1);            // 第一块收尾
    const f3 = lineOf((l) => /^```/.test(l), f2 + 1);        // 引用区那对（以 > 开头，不算行首围栏）
    const q1 = lineOf((l) => /^> ```/.test(l), h);
    const q2 = lineOf((l) => /^> ```/.test(l), q1 + 1);
    const longFence = lineOf((l) => /^```/.test(l), q2 + 1);
    const longEnd = lineOf((l) => /^```/.test(l), longFence + 1);
    const inline = lineOf((l) => l.includes('行内代码对照：'), h);
    return { block1: [f1, f2], quoted: [q1, q2], longBlock: [longFence, longEnd], inlineCodeLine: inline, heading: h };
  })(),
  '7.7': (() => {
    const h = headingOf('7.7');
    const a = lineOf((l) => l.startsWith('> 引用第一行'), h);
    const b = lineOf((l) => l.startsWith('> 引用第二行'), h);
    const c = lineOf((l) => l.startsWith('> 引用第三行'), h);
    const plain = lineOf((l) => l.startsWith('正文对照：'), h);
    return { q1: a, q2: b, q3: c, plain, heading: h };
  })(),
};

const results = [];
/** ok: true 通过 / false 未通过 / **null 未验证**（拿不到载荷、环境不具备——不许当成 ✗） */
const judge = (id, check, ok, detail, evidence) => {
  results.push({ id, check, ok: ok === null ? null : !!ok, detail: String(detail || ''), evidence: evidence || '' });
  const mark = ok === null ? '？' : (ok ? '✓' : '✗');
  console.log(`${mark} ${id} ${check} — ${detail}${evidence ? '  [' + evidence + ']' : ''}`);
};

/* ── 原生窗口枚举（原生文件对话框取证：MainWindowTitle 抓不到 #32770 对话框） ── */
const ENUM_PS = `Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
"@
$ids = @(Get-Process -Name 'MarkPilot' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$script:out = @()
$cb = [W+EnumProc]{ param($h,$l)
  $q = 0; [W]::GetWindowThreadProcessId($h, [ref]$q) | Out-Null
  if ($ids -contains [int]$q) {
    $t = New-Object System.Text.StringBuilder 256; [W]::GetWindowText($h,$t,256) | Out-Null
    $c = New-Object System.Text.StringBuilder 256; [W]::GetClassName($h,$c,256) | Out-Null
    $script:out += ("{0}|{1}|{2}|{3}|{4}" -f $q, $h, $c.ToString(), $t.ToString(), ([W]::IsWindowVisible($h)))
  }
  return $true
}
[W]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$script:out -join "\`n"`;
function listWindows() {
  try {
    const ps1 = path.join(TMP, 'enum-windows.ps1');
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(ps1, ENUM_PS, 'utf8');
    const out = execSync(`pwsh -NoProfile -File "${ps1}"`, { encoding: 'utf8', windowsHide: true });
    return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [pid, hwnd, cls, title, vis] = l.split('|'); return { pid, hwnd, cls, title, visible: vis === 'True' }; });
  } catch (e) { return [{ err: String(e.message).slice(0, 120) }]; }
}
function closeDialog(hwnd) {
  try {
    execSync(`pwsh -NoProfile -Command "Add-Type -Namespace W2 -Name U -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);'; [W2.U]::PostMessage([IntPtr]${hwnd},0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null"`, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch { return false; }
}

/* 全桌面顶层可见窗口（不限本进程）：Chromium 的文件对话框可能跑在别的进程里（explorer/dllhost），
   只按 PID 过滤会"看不见"它 —— 实测就是这样把 7.6 之后的 7.7 冻成假红的。 */
const ENUM_ALL_PS = `Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class WA {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@
$script:out = @()
$cb = [WA+EnumProc]{ param($h,$l)
  if ([WA]::IsWindowVisible($h)) {
    $q = 0; [WA]::GetWindowThreadProcessId($h, [ref]$q) | Out-Null
    $t = New-Object System.Text.StringBuilder 256; [WA]::GetWindowText($h,$t,256) | Out-Null
    $c = New-Object System.Text.StringBuilder 256; [WA]::GetClassName($h,$c,256) | Out-Null
    if ($t.ToString().Length -gt 0 -or $c.ToString() -eq '#32770') { $script:out += ("{0}|{1}|{2}|{3}" -f $q, $h, $c.ToString(), $t.ToString()) }
  }
  return $true
}
[WA]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$script:out -join "\`n"`;
function listWindowsAll() {
  try {
    const ps1 = path.join(TMP, 'enum-all-windows.ps1');
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(ps1, ENUM_ALL_PS, 'utf8');
    const out = execSync(`pwsh -NoProfile -File "${ps1}"`, { encoding: 'utf8', windowsHide: true });
    return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [pid, hwnd, cls, title] = l.split('|'); return { pid, hwnd, cls, title }; });
  } catch { return []; }
}

/* ══ 启动（独立 profile + 收尾 taskkill /T /F） ══ */
(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }); } catch { }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let child = null, browser = null;
  const killTree = () => { if (!child) return; try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { try { child.kill(); } catch { } } };
  for (let attempt = 1; attempt <= 3 && !browser; attempt++) {
    if (attempt > 1) { console.log(`· 第 ${attempt} 次尝试启动…`); await sleep(6000); try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 6, retryDelay: 400 }); } catch { } }
    /* 起前清掉**我自己**的残留（命令行含 profile-310 的 MarkPilot 进程），避免"连到旧实例" */
  try {
    const ps = execSync(`pwsh -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='MarkPilot.exe'\\" | Where-Object { $_.CommandLine -match 'profile-310' } | ForEach-Object { $_.ProcessId }"`, { encoding: 'utf8', windowsHide: true });
    const pids = ps.split(/\s+/).filter((x) => /^\d+$/.test(x));
    if (pids.length) { console.log('· 清掉我自己的残留实例：' + pids.join(', ')); for (const pid of pids) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { } } await sleep(1200); }
  } catch { }
  child = spawn(EXE, [MD, `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`], { env, stdio: 'ignore' });
    for (let i = 0; i < 40 && !browser; i++) { await sleep(1000); try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { } }
    if (!browser) killTree();
  }
  if (!browser) { console.error('✗ §7 执行器：CDP 连不上（3 次尝试；多半是别的实例占着单实例锁）'); process.exit(2); }
  const ctx = browser.contexts()[0];
  let page = null;
  for (let i = 0; i < 40 && !page; i++) { const ps = ctx.pages().filter((p) => !p.url().startsWith('devtools://')); page = ps[0] || null; if (!page) await sleep(500); }
  /* 【实测踩坑】渲染页可能不止一个（或中途导航）⇒ 每次取值前按 `window.mpEngine` 重新认页；
     否则读到的页会把 mpEngine 读成 undefined（首批烟测就是这么挂的）。 */
  let client = null, clientPage = null;
  async function acquireView() {
    for (let i = 0; i < 30; i++) {
      for (const p of ctx.pages().filter((x) => !x.url().startsWith('devtools://'))) {
        try {
          const ok = await p.evaluate(() => !!(window.mpEngine && window.mpEngine._view && window.mpEngine._view()));
          if (ok) {
            if (p !== page) { console.log('· 切换渲染页 →', p.url().slice(0, 80)); page = p; }
            if (clientPage !== page) { client = await ctx.newCDPSession(page); clientPage = page; }
            return page;
          }
        } catch { /* 页面正在导航 */ }
      }
      await sleep(500);
    }
    throw new Error('找不到带 mpEngine 的渲染页（引擎没起来？）');
  }
  const ev = async (fn, arg) => { await acquireView(); return page.evaluate(fn, arg); };
  await acquireView();
  const viewport = await ev(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const appInfo = await ev(async () => { try { const i = await window.mpHost.info(); return { version: i && i.version, name: i && i.name }; } catch (e) { return { version: null, err: String(e.message).slice(0, 80) }; } });
  console.log(`· 应用就绪；视口 ${viewport.width}×${viewport.height}；文档 ${await ev(() => window.mpEngine._view().state.doc.lines)} 行；自报版本 ${appInfo.version || '(取不到)'}`);

  const shot = async (name, clip) => {
    try {
      /* 渲染进程卡住时 page.screenshot 会等 30s（实测被原生模态框冻过）⇒ 自带短超时，不拖垮整轮 */
      return await Promise.race([
        page.screenshot({ path: path.join(SHOTS, name), clip, timeout: 8000 }).then(() => path.join('accept\\out\\shots', name)),
        sleep(9000).then(() => '(截图超时：渲染进程可能被原生对话框冻住)'),
      ]);
    } catch (e) { return '(截图失败 ' + String(e.message).slice(0, 40) + ')'; }
  };
  /* 渲染进程响应性守卫：卡住时先等它回来，再做后面的判据（否则后续条目会连环假红） */
  const waitResponsive = async (ms = 12000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { await Promise.race([page.evaluate(() => 1 + 1), sleep(1500).then(() => { throw new Error('timeout'); })]); return true; } catch { await sleep(500); }
    }
    return false;
  };
  const want = (id) => !ONLY || ONLY.includes(id);
  /* 把目标行**真的滚进视口并渲染出来**（只按 lineBlockAt 估算在长文档里会偏出几屏 ⇒ 实测 7.7 假红） */
  /* 【实测踩坑】前面的条目（如 7.1 的 Ctrl+C 选区）会留下"把光标滚回视口"的挂起意图，
     把我写的 scrollTop 顶回去 ⇒ 目标行永远不进视口（7.7 只在长序列里假红就是这个）。 */
  await ev(() => { const v = window.mpEngine._view(); v.dispatch({ selection: { anchor: 0 }, scrollIntoView: false }); });
  /* 【2026-10-09 修·关键】定位分**两步**，缺一步都不稳（本轮实测把两种失败都踩了一遍）：
     ① **直接写 scrollTop 不产生滚动锚** ⇒ CM6 的高度图一修正（超长行实测高度差几千像素）视口就飘走；
     ② **只 dispatch `scrollIntoView` 事务又滚不过去**（实测：`已渲染行 58 条 / 区间 1–50`，目标 1065
        —— 视口压根没动）⇒ 必须先按估算把 scrollTop 摆到目标附近，再用事务把视口**锚**在那一行上。
     所以：先估算落点（近），再反复 dispatch 锚定 + 轮询"那一行真的进 DOM 了吗"。 */
  const bring = async (no) => {
    const lineOf = (n) => ev(([k]) => {
      const v = window.mpEngine._view(); const d = v.state.doc;
      const ln = d.line(Math.max(1, Math.min(k, d.lines)));
      return { from: ln.from, to: ln.to, no: ln.number, docLines: d.lines, blkTop: v.lineBlockAt(ln.from).top, blkH: v.lineBlockAt(ln.from).height };
    }, [n]);
    const renderedNow = async (n) => ev(([k]) => {
      const v = window.mpEngine._view();
      const els = [...v.contentDOM.children].filter((el) => el.nodeType === 1 && el.classList && el.classList.contains('cm-line'));
      const has = (el, c) => el.classList.contains(c);
      let cnt = 0, fenceNo = 0;
      for (const el of els) {
        let lineNo;
        if (has(el, 'mp-code')) {
          if (has(el, 'mp-fence')) { fenceNo += 1; lineNo = fenceNo; cnt += 1; }
          else { const j = parseInt(el.getAttribute('data-mp-n') || '', 10); lineNo = fenceNo + (Number.isFinite(j) ? j : 0); }
        } else { cnt += 1; lineNo = cnt; }
        if (lineNo === k) { const r = el.getBoundingClientRect(); return r.height > 0; }
      }
      return false;
    }, [n]).catch(() => false);

    /* ① 有方向的滚动：先问"目标行现在在屏外上方还是下方"，再按视口高度推进。
       这条换掉了"先摆估算 scrollTop 再 dispatch"那版——实测在超长行附近估算差得离谱，
       而且直接写 scrollTop 没有滚动锚、高度图一修正就飘走。方向口径用 `coordsAtPos`（真实几何）。 */
    for (let i = 0; i < 10; i++) {
      const probe = await ev(([k]) => {
        const v = window.mpEngine._view(); const d = v.state.doc;
        const ln = d.line(Math.max(1, Math.min(k, d.lines)));
        const c = v.coordsAtPos(ln.from);
        const r = v.scrollDOM.getBoundingClientRect();
        return c ? { top: c.top, rel: c.top - r.top, h: r.height } : null;
      }, [no]).catch(() => null);
      if (await renderedNow(no)) return true;
      if (!probe) { await sleep(240); continue; }
      const dir = probe.rel < 60 ? -1 : (probe.rel > probe.h - 60 ? 1 : 0);
      if (dir === 0) {
        /* 已在视口内却没渲染出来：给 CM6 一拍渲染时间 */
        for (let k = 0; k < 4; k++) { await sleep(200); if (await renderedNow(no)) return true; }
      }
      await ev(([dd]) => {
        const v = window.mpEngine._view();
        const r = v.scrollDOM.getBoundingClientRect();
        v.scrollDOM.scrollTop = Math.max(0, v.scrollDOM.scrollTop + dd * (r.height * 0.7));
      }, [dir]).catch(() => { });
      await sleep(200);
    }
    /* ② 收尾：把光标落到目标行（带 scrollIntoView）再等——给 CM6 最后一次机会把视口锚过去 */
    for (let i = 0; i < 6; i++) {
      await ev(([k]) => {
        const v = window.mpEngine._view(); const d = v.state.doc;
        const ln = d.line(Math.max(1, Math.min(k, d.lines)));
        v.dispatch({ selection: { anchor: ln.from }, scrollIntoView: true });
      }, [no]).catch(() => { });
      for (let k = 0; k < 5; k++) { await sleep(200); if (await renderedNow(no)) return true; }
    }
    return false;
  };
  const scrollToLine = bring;   // 兼容旧调用名
  /* 【真滚进视口·2026-10-09 加】7.7 要**真人式拖选**，前提是目标行真的在可见视口里。
     上面的 bring() 有两个硬伤（都在本轮 MP_DIAG 里实证）：
       · `renderedNow()` 用"从第一个渲染行数起"的**相对行号**——文档停在中后段时永远数不到目标行号
         ⇒ bring 恒返回 false（7.7 在长序列里假红有一份是它）；
       · 它不检查"元素是否落在**可见**视口内"，而 CM6 的 DOM 里会出现**视口外几百像素**的行元素
         ⇒ 拿它的矩形去算鼠标坐标，按下点落在窗口外，拖选恒 0 字（7.7 引号段一直靠程序化兜底就是这个）。
     新口径：按结构契约找到行**元素**（`.cm-line` 是 contentDOM 直接子元素 + posAtDOM 落在该行区间内），
     再用它**自己的 getBoundingClientRect()** 算滚动量，直到它真的与视口相交；回传该矩形。 */
  const ensureLineVisible = async (no, want = 120, margin = 4) => {
    const findEl = () => ev(([k]) => {
      const v = window.mpEngine._view(); const d = v.state.doc;
      const n = Math.max(1, Math.min(k, d.lines));
      const a = d.line(n).from, b = d.line(n).to;
      const el = [...v.contentDOM.children].find((x) => { try { const p = v.posAtDOM(x, 0); return p >= a && p <= b; } catch { return false; } });
      const r = v.scrollDOM.getBoundingClientRect();
      let rect = null;
      if (el) { const bb = el.getBoundingClientRect(); rect = { x: bb.left, y: bb.top, r: bb.right, b: bb.bottom, h: bb.height }; }
      const c = v.coordsAtPos(a);
      const caret = c ? { x: c.left, y: c.top, b: c.bottom } : null;
      return { rect, caret, vTop: r.top, vBottom: r.bottom, ch: r.height, st: v.scrollDOM.scrollTop, vw: window.innerWidth };
    }, [no]).catch(() => null);
    const setRel = (dd) => ev(([d0]) => {
      const v = window.mpEngine._view();
      const max = Math.max(0, v.scrollDOM.scrollHeight - v.scrollDOM.clientHeight);
      v.scrollDOM.scrollTop = Math.min(max, Math.max(0, v.scrollDOM.scrollTop + d0));
    }, [dd]).catch(() => { });
    const anchorTo = (n) => ev(([k]) => {
      const v = window.mpEngine._view(); const d = v.state.doc;
      v.dispatch({ selection: { anchor: d.line(Math.max(1, Math.min(k, d.lines))).from }, scrollIntoView: true });
    }, [n]).catch(() => { });
    /* "在视口里"分两档：`margin=4` 只要与视口相交（够用来读 DOM），拖选要的是**舒适档**
       （整行离上下边都有 margin 像素）——否则按下点贴在视口底边，引擎一重排就把拖拽头带到别处
       （实测：行贴底边时拖 150px 选中了 2634 字，一直到文档尾）。 */
    const okInView = (g) => !!(g && g.rect && g.rect.y > g.vTop + margin && g.rect.b < g.vBottom - margin);
    let pinned = 0, reAnchored = false;
    for (let i = 0; i < 22; i++) {
      const g = await findEl();
      if (okInView(g)) {
        if (DIAG) console.log(`   [7.7 diag] ensureLineVisible(${no},want=${want},m=${margin}) i=${i} 命中 rect.y=${Math.round(g.rect.y)}..${Math.round(g.rect.b)} st=${Math.round(g.st)}`);
        return g;
      }
      /* 【顺序很重要·实测】优先用**不产生任何事务**的量：`coordsAtPos` 的行首坐标（真实测量，且
         未渲染时给的是高度图估算）。一旦先 dispatch 了 `scrollIntoView`，引擎会留下"把光标滚进
         视口"的挂起意图，之后我们写 scrollTop 会被它顶回来（实测：连写 15 次 st 一动不动，
         一直钉在 73,703）。所以 dispatch 只在"连坐标都拿不到"时才用，且用后要多等一拍。 */
      let d = null, src = '';
      if (g && g.caret) { d = (g.caret.y - g.vTop) - want; src = 'caret'; }
      else if (g && g.rect) { d = (g.rect.y - g.vTop) - want; src = 'rect'; }
      /* 钉住（写了不动）且目标还贴在视口底边 ⇒ 换一招：把光标锚到**下面几行**，
         引擎会为它再往下滚一点，目标行就自然落进舒适区（实测贴底边的行只能这样挪）。 */
      if (pinned >= 2 && !reAnchored && g && g.rect && g.rect.b > g.vBottom - margin) {
        reAnchored = true; pinned = 0;
        if (DIAG) console.log(`   [7.7 diag] ensureLineVisible(${no}) 贴底边且写不动 ⇒ 改锚到第 ${no + 4} 行`);
        await anchorTo(no + 4);
        await sleep(560);
        continue;
      }
      if (d !== null) {
        /* 高度图抖动时估算坐标可以离谱到几万像素（实测 caret=20,466）⇒ 单步封顶 3 屏，
           每步都重新测量，避免"追着一个假坐标跑"。 */
        const step = Math.max(-3 * g.ch, Math.min(3 * g.ch, d));
        await setRel(step);
        await sleep(190);
        const after = await ev(() => { const v = window.mpEngine._view(); return { st: Math.round(v.scrollDOM.scrollTop), sh: Math.round(v.scrollDOM.scrollHeight) }; }).catch(() => null);
        const before = Math.round(g.st);
        if (after && Math.abs(after.st - before) < 2 && Math.abs(step) > 20) pinned += 1; else pinned = 0;
        if (DIAG) console.log(`   [7.7 diag] ensureLineVisible(${no},want=${want},m=${margin}) i=${i} ${src} y=${Math.round(src === 'caret' ? g.caret.y : g.rect.y)} vB=${Math.round(g.vBottom)} Δ=${Math.round(step)} 写后 ${JSON.stringify(after)}${pinned ? ' ⚠钉住' : ''}`);
        continue;
      }
      /* 连元素带坐标都没有 ⇒ 只能请 CM6 自己锚（真事务）；它会留挂起意图，多等一拍再量 */
      await anchorTo(no);
      await sleep(560);
      if (DIAG) console.log(`   [7.7 diag] ensureLineVisible(${no}) i=${i} 无元素无坐标 ⇒ dispatch 锚定`);
    }
    const g = await findEl();
    if (DIAG) console.log(`   [7.7 diag] ensureLineVisible(${no},want=${want},m=${margin}) 收尾 rect=${g && g.rect ? JSON.stringify({ y: Math.round(g.rect.y), b: Math.round(g.rect.b) }) : 'null'} vTop=${g ? Math.round(g.vTop) : '?'} vBottom=${g ? Math.round(g.vBottom) : '?'}`);
    return okInView(g) ? g : null;
  };

  /* ══ 渲染行定位助手（2026-10-09 修）══════════════════════════════════════════════
   *  【为什么必须换掉 posAtDOM】旧口径 `v.posAtDOM(el, 0)` 在**代码块行**上拿不到位置
   *  （实测：`census` 里明明有 15 个 `.cm-line[data-mp-n]`，`posAtDOM` 那一路却全抛 ⇒ 容器清单=[]、
   *   分诊读成"元素存在但取值为空"、§7.1 判红）。**红的是尺子，不是产品**：2 倍图上
   *   正文块 1/2/3、引用块 1/2/3 都在（`.mp-verify\checklist\accept\out\shots\7.1-mini-2x.png`）。
   *  【新口径】不猜位置：先取**行类候选**（`.cm-line` 必须是 contentDOM 的直接子元素——
   *   这是 CM6 的结构契约，不用位置也成立），再用「行号」推断它在文档里的行号：
   *   普通行 = 它前面所有行元素数 + 1；围栏/代码行 = `围栏号 + data-mp-n`（块内号 1 起）。
   *  ⇒ 两种行都能算出文档行号，不依赖 posAtDOM、也不依赖 textContent（表格行文字会被抹掉）。 */
  const renderedLines = async (a, b) => ev(([from, to]) => {
    const v = window.mpEngine._view();
    const els = [...v.contentDOM.children].filter((el) => el.nodeType === 1 && el.classList && el.classList.contains('cm-line'));
    const has = (el, c) => el.classList.contains(c);
    let cnt = 0, fenceNo = 0;
    const out = [];
    for (const el of els) {
      let lineNo;
      if (has(el, 'mp-code')) {
        if (has(el, 'mp-fence')) { fenceNo += 1; lineNo = fenceNo; cnt += 1; }
        else { const n = parseInt(el.getAttribute('data-mp-n') || '', 10); lineNo = fenceNo + (Number.isFinite(n) ? n : 0); }
      } else { cnt += 1; lineNo = cnt; }
      if (lineNo >= from && lineNo <= to) out.push(el);
    }
    return out;
  }, [a, b]);

  const docText = async () => ev(() => window.mpEngine._view().state.doc.toString());
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

  /* 通用：找到"更多"菜单里的条目文本 */
  const openMore = async () => {
    const pos = await ev(() => { const b = document.querySelector('.mp-toolbar .mp-tb-item[data-mp-id="more"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
    if (!pos) return null;
    /* 偶发打不开（实测 0 条文本）⇒ 重试最多 3 次，每次等 420ms */
    for (let k = 0; k < 3; k++) {
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      await sleep(500);
      const probe = await ev(() => {
        const pop = document.querySelector('.mp-pop');
        if (!pop) return { exists: false, items: [], allNodes: [], sel: '' };
        /* 两种口径都算，并写明选择器（Lead：同一事实两个数并存时必须写清各自口径） */
        const direct = [...pop.querySelectorAll(':scope > .mp-pop-item, :scope > .mp-pop-title')].map((el) => (el.textContent || '').trim()).filter(Boolean);
        const all = [...pop.querySelectorAll('*')].filter((el) => el.children.length === 0 && (el.textContent || '').trim()).map((el) => (el.textContent || '').trim());
        const moreBtns = [...document.querySelectorAll('.mp-toolbar .mp-tb-item[data-mp-id="more"]')].map((b) => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), hidden: !(r.width && r.height) }; });
        const popDiag = {
          popCount: document.querySelectorAll('.mp-pop').length,
          moreBtnCount: moreBtns.length, moreBtns,
          mpHostReload: typeof (window.mpHost && window.mpHost.reload),
          mpHostPick: typeof (window.mpHost && window.mpHost.pickImages),
          popHtmlHead: (document.querySelector('.mp-pop') || {}).outerHTML ? document.querySelector('.mp-pop').outerHTML.slice(0, 240) : null,
        };
        return {
          exists: true, popDiag,
          items: all.slice(0, 160),                       // 含嵌套叶子（旧口径）
          allNodes: all.slice(0, 160),
          directItems: direct.slice(0, 160),              // 直接子元素（.mp-pop-item/.mp-pop-title）
          sel: '.mp-pop-item, .mp-pop-title（:scope 直接子元素）/ 含嵌套叶子节点',
        };
      });
      /* 【加固·2026-10-10】evaluate 偶发返回 undefined（面板换帧/时序）时，原来直接读
         `probe.items.length` ⇒ TypeError 把整个验收打断（§7 执行器异常，报告作废）。
         这里兜底继续下一轮：崩溃会掩盖真实读数，比多等一拍糟得多。 */
      if (!probe || !probe.items || !probe.directItems) { await sleep(150); continue; }
      if (probe.items.length || probe.directItems.length) return probe;
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(200);
    }
    return { exists: false, items: [] };
  };
  const openMoreOld = async () => {
    return ev(() => {
      const pop = document.querySelector('.mp-pop');
      if (!pop) return { exists: false, items: [] };
      return { exists: true, items: [...pop.querySelectorAll('*')].filter((el) => el.children.length === 0 && (el.textContent || '').trim()).map((el) => (el.textContent || '').trim()).slice(0, 120) };
    });
  };

  /* ══════════ 7.1 代码块行号 ══════════ */
  if (want('7.1')) {
    /* RES7_ANCHORS：在**文档里**搜围栏行解析锚点（不再靠清单行号算；算错成 -1 会一路污染到 page.evaluate）。
       解析不到 ⇒ res7.ok=false ⇒ 与锚点相关的检查点判"未验证"，绝不抛 RangeError。 */
    const res7 = await ev(() => {
      const v = window.mpEngine._view(); const d = v.state.doc;
      const lines = [];
      for (let n = 1; n <= d.lines; n++) lines.push(d.line(n).text);
      const hIdx = lines.findIndex((x) => x.startsWith('### 7.1 '));
      const endIdx = (() => { for (let i = hIdx + 1; i < lines.length; i++) if (/^### /.test(lines[i])) return i; return lines.length; })();
      const inSec = (i) => hIdx >= 0 && i > hIdx && i < endIdx;
      const plain = [], quoted = [], inline = [];
      for (let i = 0; i < lines.length; i++) {
        if (!inSec(i)) continue;
        const x = lines[i];
        const isFence = /^\s*(?:>\s*)*(`{3,}|~{3,})/.test(x);
        if (isFence) { if (/^\s*>/.test(x)) quoted.push(i + 1); else plain.push(i + 1); }
        if (x.includes('行内代码对照：')) inline.push(i + 1);
      }
      const pick = (arr, k) => (arr.length > k ? arr[k] : -1);
      return {
        ok: hIdx >= 0 && plain.length >= 4 && quoted.length >= 2,
        heading: hIdx + 1, plain, quoted, inline,
        block1: [pick(plain, 0), pick(plain, 1)],
        longBlock: [pick(plain, 2), pick(plain, 3)],
        quotedPair: [pick(quoted, 0), pick(quoted, 1)],
        inlineCodeLine: pick(inline, 0),
        plainCount: plain.length, quotedCount: quoted.length,
      };
    });
    const res7Msg = `页内解析：7.1 段在第 ${res7.heading} 行；普通围栏 ${res7.plainCount} 条、引用区围栏 ${res7.quotedCount} 条；普通块=${JSON.stringify(res7.block1)}、引用块=${JSON.stringify(res7.quotedPair)}、长行块=${JSON.stringify(res7.longBlock)}、行内代码行=${res7.inlineCodeLine}`;
    console.log('  · ' + res7Msg);
    let snap7 = null;   /* 7.1 的同快照读数（导出检查要用，别再二次读盘/二次读 DOM） */
    if (!res7.ok) {
      judge('7.1', 'codeLineNumbers', null, '未验证：' + res7Msg + ' ⇒ 锚点解析不到（清单夹具行没在文档里定位到）', '');
      judge('7.1', 'codeLineNumbers:style', null, '未验证：同上（锚点解析不到）', '');
    } else {
    await scrollToLine(res7.block1[0]);
    /* 【分诊·2026-10-09】bring 之后立刻留一条"读数时刻的视口"读数：空集时要能一眼看出
       "是没滚过去"还是"滚过去了但推断的行号区间不对"。这条读数随判据一起写进报告。 */
    const afterBring = await ev(([f, t]) => {
      const v = window.mpEngine._view(); const d = v.state.doc;
      const els = [...v.contentDOM.children].filter((el) => el.nodeType === 1 && el.classList && el.classList.contains('cm-line'));
      const a = d.line(f).from, b = d.line(t).to;
      let hits = 0;
      for (const el of els) { try { const p = v.posAtDOM(el, 0); if (p >= a && p <= b) hits += 1; } catch { } }
      return { rendered: els.length, hitsInRange: hits, first: (els[0] ? els[0].textContent : '').slice(0, 30) };
    }, [res7.block1[0], res7.block1[1]]).catch(() => null);
    /* 锚点已由页内解析（res7）保证 > 0 ⇒ 这里不再需要"算出来 -1"的旧守卫 */
    {
    const read7 = () => ev(([b1, b1e, q, qe, lb, lbe, inline]) => {
      const v = window.mpEngine._view();
      /* 【2026-10-09 修】行容器一律走 renderedLines 口径（见助手注释：posAtDOM 在代码行上给不出位置）。
         取值只依赖 `.cm-line` 是 contentDOM 直接子元素这条 CM6 结构契约 + 行号推断。 */
      const allLines = [...v.contentDOM.children].filter((el) => el.nodeType === 1 && el.classList && el.classList.contains('cm-line'));
      const has = (el, c) => el.classList.contains(c);
      /* 【行号推断·2026-10-09 定稿】两条硬要求，缺一条就得出空集：
         ① **不能用 `.mp-fence` 判块首** —— 光标停在开围栏行上时该类会消失（产品把该行显成源码），
            实测 dump 是 `cm-line cm-activeLine | ```js` 而没有 mp-fence；
         ② **计数必须按"锚点行的真实文档行号"起算** —— 只从 1 开始数，只有在视口恰好落在文档开头时
            才碰巧对（早期几轮就是这样"看起来能用"）。视口落在文档中段时，区段行号会从 1 编号，
            目标区间 1065 自然一次都命不中（实测：bring 之后 hitsInRange=5，判据却报空集）。
         于是：先用 `posAtDOM` 给每个行元素取真实行号（拿不到就给 null），再以**第一个有真实行号的元素**
         为锚点，用"相对偏移"（数过几行 / 代码块内号）把其余行推出来。 */
      let anchorOff = null;                 // 锚点：真实行号 − 推断行号
      let prevWasCode = false, base = 0, seq = 0;
      const withNo = allLines.map((el) => {
        const isCode = has(el, 'mp-code');
        const isFence = has(el, 'mp-fence');
        const k = parseInt(el.getAttribute('data-mp-n') || '', 10);
        seq += 1;
        let rel;                            // 相对行号（从 1 起；换锚点时重算）
        if (isCode) {
          if (isFence || !Number.isFinite(k)) { rel = null; base = null; }     // 围栏行：号不可用，但它界定块首
          else {
            if (!prevWasCode || base === null) base = seq + 1;                  // 块首内容行的相对号
            rel = base + (k - 1);
          }
          prevWasCode = true;
        } else { rel = seq; prevWasCode = false; base = null; }
        let real = null;
        try { real = v.state.doc.lineAt(v.posAtDOM(el, 0)).number; } catch { real = null; }
        if (real !== null && rel !== null && anchorOff === null) anchorOff = real - rel;
        const lineNo = (rel !== null && anchorOff !== null) ? rel + anchorOff : (real !== null ? real : rel);
        return { el, lineNo };
      });
      const pickRange = (a, b) => withNo.filter((x) => x.lineNo >= a && x.lineNo <= b).map((x) => x.el);
      const pick = (no) => withNo.find((x) => x.lineNo === no)?.el || null;
      const nosOf = (els) => els.flatMap((el) => { const self = el.classList && el.classList.contains('cm-line') ? [el] : []; return [...self, ...el.querySelectorAll('.cm-line')]; }).map((l) => ({ n: l.getAttribute('data-mp-n'), cls: l.className, t: (l.textContent || '').slice(0, 24) }));
      /* 【§7.1 定点分诊·Lead 2026-10-09】"[null]" 到底是"元素不存在"还是"存在但取值为空"：
         把容器（选择器 + 行数 + 类名）与单号元素（选择器 + textContent + 属性）分开 dump。 */
      const dumpBlock = (a, b) => {
        const d = v.state.doc;
        const els = pickRange(a, b);
        const containers = els.map((el) => ({ sel: el.tagName.toLowerCase() + '.' + String(el.className).split(/\s+/).filter(Boolean).join('.'), childLines: el.classList.contains('cm-line') ? 0 : el.querySelectorAll('.cm-line').length, text: (el.textContent || '').slice(0, 30) }));
        const lines = nosOf(els).map((l, i) => ({ i, cls: l.cls, attr: l.n === null ? '(无 data-mp-n)' : l.n, hasNumEl: false, t: l.t }));
        /* 逐行找"看起来像行号"的元素（数字文本、宽度 < 3em） */
        const numEls = [];
        for (const el of els) for (const cand of el.querySelectorAll('*')) {
          const t = (cand.textContent || '').trim();
          if (/^\d{1,4}$/.test(t) && cand.children.length === 0) {
            const r = cand.getBoundingClientRect();
            if (r.width > 0 && r.width < 48) numEls.push({ sel: cand.tagName.toLowerCase() + '.' + String(cand.className).split(/\s+/).filter(Boolean).join('.'), text: t, w: Math.round(r.width) });
          }
        }
        return { containers, lines, numEls: numEls.slice(0, 12), numElCount: numEls.length };
      };
      const nos = (el) => { if (!el) return []; const self = el.classList && el.classList.contains('cm-line') ? [el] : []; return [...self, ...el.querySelectorAll('.cm-line')].map((l) => ({ n: l.getAttribute('data-mp-n'), cls: l.className, t: (l.textContent || '').slice(0, 24) })); };
      const sel = window.getSelection();
      /* ══ 逐块结构读数（2026-10-09 加·**不依赖视口定位**）══════════════════════════════
       *  【为什么加】`codeLineNumbers` 那条要求"目标块恰好在视口里"，而这份 3.97MB 文档里滚动
       *   定位本身就不稳（实测反复落在别的超长行段落上，读数退化成空集）。
       *   但**产品的事实不需要那个前提**：判据是"每块内容行从 1 连续、空行占号、引用块也有号、
       *   行内代码行无号"——这些都能在**已渲染的 DOM 里按块内文本**直接认块判读。
       *  【口径】按 `.cm-line` 顺序推行号（与 renderedLines 同源），再按**代码块分组**（围栏行分割），
       *   每组给：块序、是否引用块、逐行 `{行号, data-mp-n, 文本}`、号序列是否 1..N。 */
      const blocks = (() => {
        const groups = [];
        let cur = null;
        for (const x of withNo) {
          const el = x.el;
          const isFence = el.classList.contains('mp-fence');
          const isCode = el.classList.contains('mp-code');
          if (isFence) {
            if (cur && cur.rows.length) groups.push(cur);
            cur = { quote: el.classList.contains('mp-quote'), rows: [], fenceNo: x.lineNo };
            continue;
          }
          if (isCode && cur) cur.rows.push({ no: x.lineNo, n: el.getAttribute('data-mp-n'), t: (el.textContent || '').slice(0, 30) });
        }
        if (cur && cur.rows.length) groups.push(cur);
        return groups.map((g, i) => {
          const seq = g.rows.map((r) => r.n);
          const want = g.rows.map((_, k) => String(k + 1));
          return { i: i + 1, quote: g.quote, rows: g.rows, seqOk: JSON.stringify(seq) === JSON.stringify(want),
            emptyOk: g.rows.length < 2 ? true : String(g.rows[Math.min(1, g.rows.length - 1)].n) === '2' };
        });
      })();
      /* 【尺子自证】**当前渲染的是文档哪一段**——空集时先回答"视口到底在哪"，别再猜。
         口径：按 `.cm-line` 顺序推行号（与 renderedLines 同源），给出首/末与总数。 */
      const where = (() => {
        const first = withNo[0] || null, last = withNo[withNo.length - 1] || null;
        return {
          domLines: withNo.length,
          firstNo: first ? first.lineNo : null,
          lastNo: last ? last.lineNo : null,
          firstText: first ? (first.el.textContent || '').slice(0, 24) : null,
          targets: { b1: [b1, b1e], q: [q, qe], lb: [lb, lbe] },
          want: b1,
        };
      })();
      /* 【尺子自证】把"旧口径为什么读空"当场记下来当证据：对可见行逐个试 posAtDOM，
         数出抛错/给出范围外位置的行数。这条不是产品读数，是探针健康度读数。 */
      const ruler = (() => {
        let ok = 0, threw = 0, outside = 0;
        const sample = allLines.slice(0, 30);
        for (const el of sample) {
          try {
            const p = v.posAtDOM(el, 0);
            if (typeof p === 'number' && p >= 0) ok += 1; else outside += 1;
          } catch { threw += 1; }
        }
        return { probed: sample.length, ok, threw, outside };
      })();
      return {
        block1: nosOf(pickRange(b1, b1e)), quoted: nosOf(pickRange(q, qe)), longBlock: nosOf(pickRange(lb, lbe)),
        ruler, where, blocks,
        dump: { block1: dumpBlock(b1, b1e), quoted: dumpBlock(q, qe), longBlock: dumpBlock(lb, lbe) },
        block1Text: v.state.doc.sliceString(v.state.doc.line(b1).from, v.state.doc.line(b1e).to),
        inlineCode: (() => { const el = [...v.contentDOM.children].find((e) => (e.textContent || '').includes('行内代码对照')); return el ? { cls: el.className, n: el.getAttribute('data-mp-n'), codeEls: el.querySelectorAll('code').length } : null; })(),
        styleProbe: (() => { const el = document.querySelector('.cm-line[data-mp-n]'); if (!el) return null; const c = getComputedStyle(el, '::before'); return { content: c.content, textAlign: c.textAlign, color: c.color, fontSize: c.fontSize, borderRight: c.borderRightWidth + ' ' + c.borderRightStyle + ' ' + c.borderRightColor, paddingRight: c.paddingRight }; })(),
        /* 【判据与技术实现脱节的可能】若实现不用 data-mp-n 而用 CSS 计数器，也要能看出来：
           把代码行自身的 counterIncrement 与所属行的 counterReset 一起读回来当证据。 */
        counterProbe: (() => {
          const first = v.state.doc.line(b1).from;
          const el = [...v.contentDOM.children].find((x) => { try { const p = v.posAtDOM(x, 0); return p >= first && p <= v.state.doc.line(b1).to; } catch { return false; } });
          const census = [...v.contentDOM.querySelectorAll('.cm-line[data-mp-n]')].slice(0, 12).map((l) => l.getAttribute('data-mp-n'));
          const gutterish = [...v.contentDOM.querySelectorAll('[class*=num],[class*=gutter],[class*=lineno],[class*=line-no]')].slice(0, 12).map((x) => x.className);
          if (!el) return { census, gutterish, lines: [] };
          const lines = [el, ...el.querySelectorAll('.cm-line')].slice(0, 6);
          return { census, gutterish, docHasAttr: census.length, lines: lines.map((l) => { const cs = getComputedStyle(l); const pb = getComputedStyle(l, '::before');
            return { cls: l.className, n: l.getAttribute('data-mp-n'), counterInc: cs.counterIncrement, counterReset: cs.counterReset, beforeContent: pb.content, beforeAlign: pb.textAlign }; }) };
        })(),
      };
    }, [res7.block1[0], res7.block1[1], res7.quotedPair[0], res7.quotedPair[1], res7.longBlock[0], res7.longBlock[1], res7.inlineCodeLine]);
    let r = await read7();
    snap7 = r;
    /* 轮询：等到"块内内容行都带上号 + 引用块/长行块也齐"或超时（最多 ~4s），避免读到半应用的装饰。
       【2026-10-09 修】**取"命中最多的一次"，不是"最后一次"**：视口会滑走（这份文档里超长行会把
       目标块顶出渲染窗口），最后一次读数可能是**空集**，用它当结论会把前面读到的好数据覆盖掉
       （实测：dump 里三行号都在，判据却报 []）。 */
    const hitsOf = (x) => x.block1.filter((y) => y.n).length + x.quoted.filter((y) => y.n).length + x.longBlock.filter((y) => y.n).length;
    let best = r, bestHits = hitsOf(r);
    for (let k = 0; k < 10; k++) {
      const cl = r.block1.filter((x) => /mp-code/.test(x.cls) && !/mp-fence/.test(x.cls));
      const qn = r.quoted.filter((x) => x.n).length, ln = r.longBlock.filter((x) => x.n).length;
      if (cl.length && cl.every((x) => x.n) && qn >= 3 && ln >= 3) break;
      await sleep(400); r = await read7();
      const h = hitsOf(r);
      if (h > bestHits) { best = r; bestHits = h; }
    }
    if (bestHits > hitsOf(r)) { r = best; snap7 = best; }
    const b1 = r.block1, qd = r.quoted, lb = r.longBlock;
    const nums1 = b1.map((x) => x.n);
    const attrMissing = b1.filter((x) => x.n === null).length;
    const numEls = (r.dump.block1.numElCount || 0) + (r.dump.quoted.numElCount || 0) + (r.dump.longBlock.numElCount || 0);
    /* 【2026-10-09 修·判据把围栏行排除】区间扫描会同时收进**开围栏行与收围栏行**（它们本来就
       不该有号，`data-mp-n` 为 null）。改前直接拿整段序列去比 `1..N` ⇒ 两端各多一个 null ⇒
       **永远差两位**（实测读数 `[null,"1","2","3",null]` 明明正确、判据却报红）。
       【口径不能再靠类名】`mp-fence` 这条类**在光标落到该行时会消失**（产品把开围栏显成源码；
       实测 dump 里是 `cm-line cm-activeLine | ```js`）⇒ 拿它当"内容行"的排除条件会把开围栏
       当内容行（号 null）⇒ 号序判据照样断。**内容行与围栏行的唯一稳定区别是"有没有 `data-mp-n`"**：
       围栏行永不带号。所以"内容行"= 该行有号。 */
    const isContent = (x) => x.n !== null && x.n !== undefined;
    const content1b = b1.filter(isContent), contentQb = qd.filter(isContent);
    const okSeqAll = content1b.length > 0 && content1b.every((x, i) => String(x.n) === String(i + 1));
    const okQuoteAll = contentQb.length > 0 && contentQb.every((x, i) => String(x.n) === String(i + 1));
    /* 空行必须占号，且号 == 它在内容行里的序号（块内 1 起）。同样只看**内容行**。 */
    const okEmpty = content1b.some((x, i) => !String(x.t || '').trim() && String(x.n) === String(i + 1));
    const okInline = !r.inlineCode || (!r.inlineCode.n);   /* 行内代码行**不该**有号；读不到该行也算不违反 */
    /* 长行块：至少一条内容行有号即可（块本身只有一条超长源码行 + 折行显示） */
    const okLong = lb.some((x) => isContent(x) && x.n);
    /* 三态（口径修正·2026-10-09）：围栏行的 `data-mp-n` 本来就该是 null，**不能算"缺失"**
       （改前拿整段数组算 ⇒ 每块恒有 2 条"缺失" ⇒ 命中 null 分支 ⇒ 永远只是"未验证"）。
       缺失只对**代码内容行**定义：内容行全带号且号序 1..N ⇒ 通过；内容行缺号但 DOM 里另有号元素
       ⇒ 探针与实现口径不一致（未验证）；缺号且没有任何号元素 ⇒ 确实没有（红）。 */
    const verdict = (okSeqAll && okQuoteAll && okEmpty && okInline && okLong) ? true
      : (content1b.some((x) => !x.n) && numEls > 0) ? null
        : false;
    judge('7.1', 'codeLineNumbers', verdict,
      `普通块号=${JSON.stringify(nums1)}（空行号=${b1[2] ? b1[2].n : '?'}）；引用块号=${JSON.stringify(qd.map((x) => x.n))}；长行块号=${JSON.stringify(lb.map((x) => x.n))}；行内代码行 data-mp-n=${r.inlineCode ? r.inlineCode.n : 'null'} code 元素=${r.inlineCode ? r.inlineCode.codeEls : 0}`
      + `｜**分诊**：data-mp-n 缺失的行 = ${attrMissing}/${b1.length}（"元素存在但属性为空"）；DOM 里像行号的元素 = ${numEls} 个`
      + `｜**尺子自证**：可见行 posAtDOM 抽样 ${r.ruler ? r.ruler.probed : '?'} 条 ⇒ 成功 ${r.ruler ? r.ruler.ok : '?'} / 抛错 ${r.ruler ? r.ruler.threw : '?'}（旧口径空集的成因）`
      + `｜**视口在哪**：已渲染行 ${r.where ? r.where.domLines : '?'} 条、行号区间 ${r.where ? r.where.firstNo : '?'}–${r.where ? r.where.lastNo : '?'}（目标 ${JSON.stringify(r.where ? r.where.want : null)}；首行«${r.where ? String(r.where.firstText || '').replace(/\n/g, ' ') : ''}»）`
      + `｜**五项**=号序1..N:${okSeqAll} 引用块号序:${okQuoteAll} 空行占号:${okEmpty} 行内无号:${okInline} 长行有号:${okLong}`
      + `｜**bring 后**=${JSON.stringify(afterBring)}`
      + `｜容器 dump=${JSON.stringify(r.dump.block1.containers)}｜单号元素样例=${JSON.stringify((r.dump.block1.numEls || []).slice(0, 5))}`,
      await shot('7.1-line-numbers.png'));
    const cp = r.counterProbe;
    /* 【新增检查点·不依赖视口定位】按块内文本在已渲染 DOM 里认块，逐块核对号序与"行内代码行无号"。
       找不到某块的文本 ⇒ 该块未渲染 ⇒ 记 null（未验证），不算红——但三条里至少要到两条才算通过。 */
    {
      const rd = await ev(async ([anchorA, anchorB]) => {
        const v = window.mpEngine._view();
        const d = v.state.doc;
        const mk = (no) => { const ln = d.line(Math.max(1, Math.min(no, d.lines))); return { from: ln.from, to: ln.to }; };
        const A = mk(anchorA), B = mk(anchorB);
        const linesNow = () => [...v.contentDOM.children].filter((el) => el.nodeType === 1 && el.classList && el.classList.contains('cm-line'));
        /* 【一次线性分组，别再走 sibling】按顺序扫一遍：围栏开一块、围栏收一块 ⇒ 块内只可能是内容行。
           上一版用 previousElementSibling/nextElementSibling 手工回溯，实测把**开围栏行**漏进了块里
           （`{"n":null,"t":"```js"}` 出现在块 1 的行列表里）⇒ 号序判据拿 null 跟 "1" 比 ⇒ 假红。
           线性分组把"块边界"这件事交给围栏本身，不再依赖元素相邻性。 */
        const scanBlocks = () => {
          const rows = linesNow().map((el) => ({
            code: el.classList.contains('mp-code'),
            fence: el.classList.contains('mp-fence'),
            quote: el.classList.contains('mp-quote'),
            n: el.getAttribute('data-mp-n'),
            t: (el.textContent || '').slice(0, 26),
          }));
          const out = [];
          let cur = null;
          for (const r of rows) {
            /* 【边界口径·2026-10-09 实测】不能用 `.mp-fence` 划界：**光标停在开围栏行上时该类会消失**
               （产品把那一行显出源码；实测 dump 里出现 `cm-line cm-activeLine |```js` 而没有 mp-fence）
               ⇒ 靠它划界会把开围栏误当普通代码行，整块丢失（块 1 反复 "找不到" 的真相）。
               改用"代码块身份是否延续"：非代码行 ⇒ 收块；代码块内号从 1 重起 ⇒ 新块开始。 */
            const isBareCode = r.code && !r.fence;
            if (!isBareCode) { if (cur) { out.push(cur); cur = null; } continue; }
            const n = parseInt(r.n || '', 10);
            if (cur && n === 1) { out.push(cur); cur = null; }          // 号从 1 重起 ⇒ 上一块到此为止
            if (!cur) cur = { quote: r.quote, rows: [] };
            cur.rows.push({ n: r.n, t: r.t });
          }
          if (cur) out.push(cur);
          return out.filter((b) => b.rows.length);
        };
        const seqOk = (rows) => rows.length > 0 && rows.every((x, i) => String(x.n) === String(i + 1));
        /* 【一次快照、在同一份数据上判】改前这里对每个问题各调一次 scanBlocks()：
           DOM 在两次调用之间会因选区/渲染更新而变（`cm-activeLine` 会移动、行元素可能被替换）
           ⇒ 同一次判读里出现"这回找得到、那回找不到"的自相矛盾（实测：块 1 明明在 dump 里，
           findBlock 却返回 null）。现在只扫一次，之后所有判断都落在这份快照上。 */
        const snap = () => {
          const blocks = scanBlocks();
          const inlineEl = linesNow().find((el) => (el.textContent || '').includes('const inline = 1;'));
          const pick = (snippet) => {
            const b = blocks.find((x) => x.rows.some((r) => r.t.includes(snippet)));
            return b ? { rows: b.rows, quote: b.quote } : null;
          };
          const b1 = pick('const first = 1;'), b2 = pick('const inQuote1 = 1;');
          return {
            b1, b2,
            diag: {
              lines: linesNow().length,
              blocks: blocks.map((b) => ({ q: b.quote, rows: b.rows.map((r) => (r.n || '-') + ':' + r.t) })),
              raw: linesNow().slice(16, 24).map((el) => String(el.className).slice(0, 22) + '|' + (el.textContent || '').slice(0, 18)),
            },
            inlineLine: inlineEl ? { n: inlineEl.getAttribute('data-mp-n'), cls: String(inlineEl.className).slice(0, 40) } : null,
            seqOk1: b1 ? seqOk(b1.rows) : null,
            seqOk2: b2 ? seqOk(b2.rows) : null,
          };
        };
        /* 【自带定位重试】主探针那段滚动在这份 3.97MB 文档上不稳（实测反复落在别的超长行段落）。
           这里自己把目标块带进视口：先按文档行号 dispatch 一次把光标落上去，不成就在目标附近
           ±480px 以 120px 步长来回试（每次试完都重扫 DOM，认块失败才算没到）。 */
        let out = snap();
        const need = () => !(out.b1 && out.inlineLine);
        for (let i = 0; i < 14 && need(); i++) {
          const no = out.b1 ? anchorB : anchorA;
          await new Promise((res) => setTimeout(res, 120));
          v.dispatch({ selection: { anchor: mk(no).from }, scrollIntoView: true });
          await new Promise((res) => setTimeout(res, 150));
          const dirs = [0, -120, 120, -240, 240, -360, 360, -480, 480];
          v.scrollDOM.scrollTop = Math.max(0, v.scrollDOM.scrollTop + dirs[i % dirs.length]);
          await new Promise((res) => setTimeout(res, 140));
          out = snap();
        }
        return out;
      }, [res7.block1[0], res7.block1[1]]);
      /* 诊断：把**当时已渲染的行**记下来（命中块数不足时才知道视口到底停在哪儿） */
      const domDump = await ev(() => [...window.mpEngine._view().contentDOM.children]
        .filter((el) => el.nodeType === 1 && el.classList && el.classList.contains('cm-line'))
        .slice(0, 26).map((el) => String(el.className).replace('cm-line', '').trim().slice(0, 26) + '|' + (el.getAttribute('data-mp-n') || '-') + '|' + (el.textContent || '').slice(0, 20)));
      const seen = [rd.b1, rd.b2].filter(Boolean).length;
      const ok = rd.seqOk1 === true && rd.seqOk2 === true && (!rd.inlineLine || !rd.inlineLine.n);
      judge('7.1', 'codeLineNumbers:byBlock', seen >= 2 ? ok : null,
        `按块内文本认块（不受视口定位影响）：命中块 ${seen}/2`
        + `；块1=${JSON.stringify((rd.b1 || {}).rows || null)}（号序 1..N=${rd.seqOk1}）`
        + `；块2（引用）=${JSON.stringify((rd.b2 || {}).rows || null)}（号序 1..N=${rd.seqOk2}）`
        + `；行内代码行=${JSON.stringify(rd.inlineLine)}（应为 null 号）`
        + `｜当时已渲染（前 26 行，类|号|文本）=${JSON.stringify(domDump)}`
        + `｜扫描内部=${JSON.stringify(rd.diag)}`,
        '');
    }
    judge('7.1', 'codeLineNumbers:style', !!r.styleProbe, `行号伪元素：content=${r.styleProbe && r.styleProbe.content} align=${r.styleProbe && r.styleProbe.textAlign} color=${r.styleProbe && r.styleProbe.color} borderRight=${r.styleProbe && r.styleProbe.borderRight}；全文档带 data-mp-n 的 .cm-line = ${cp && typeof cp === 'object' ? cp.docHasAttr : '?'} 个（样例 ${JSON.stringify((cp && cp.census) || [])}）；行内计数器证据=${JSON.stringify(((cp && cp.lines) || []).slice(0, 3))}（颜色/对齐最终仍以视觉通道为准）`, '');

    }
    /* 剪贴板：选中第一个代码块 → Ctrl+C → 读系统剪贴板 */
    try {
      const box = await ev(([a, b]) => {
        const v = window.mpEngine._view(); const d = v.state.doc;
        const sa = v.coordsAtPos(d.line(a).from), sb = v.coordsAtPos(d.line(b).to);
        return sa && sb ? { x1: Math.round(sa.left) + 4, y1: Math.round(sa.top) + 4, x2: Math.round(sb.left) + 60, y2: Math.round(sb.bottom) - 4 } : null;
      }, [res7.block1[0], res7.block1[1]]);
      if (!box) judge('7.1', 'codeClipboardNoNumbers', null, '拿不到代码块坐标 ⇒ 未验证', '');
      else {
        /* 【Lead 2026-10-09 口径】剪贴板是全局资源、本机多腿并行 ⇒
           ① 先放**已知阳性对照**（Set-Clipboard 一个哨兵串），证明"读得到"；
           ② seq 配对：before → Ctrl+C → after，必须**确实变成**源码内容；
           ③ 被顶就重试；④ 仍拿不到 ⇒ 判**未验证（null）**，并 dump 剪贴板格式，绝不判 ✗。 */
        const SENTINEL = 'MP-QOFF-SENTINEL-' + Date.now();
        const psRead = () => { try { return execSync('pwsh -NoProfile -Command "Get-Clipboard -Raw"', { encoding: 'utf8', windowsHide: true }); } catch (e) { return ''; } };
        const psFormats = () => { try { return execSync('pwsh -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $d=[System.Windows.Forms.Clipboard]::GetDataObject(); if($d){ ($d.GetFormats() -join \',\') } else { \'(空)\' }"', { encoding: 'utf8', windowsHide: true }).trim(); } catch { return '(取不到)'; } };
        const psSet = (s) => { try { execSync(`pwsh -NoProfile -Command "Set-Clipboard -Value '${s}'"`, { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; } };
        psSet(SENTINEL);
        await sleep(250);
        const positiveControl = psRead().includes('MP-QOFF-SENTINEL');
        let clip = '', selLen = 0, via = '鼠标拖选', okClip = null, before = psRead(), rounds = 0;
        for (rounds = 1; rounds <= 3 && okClip === null; rounds++) {
          /* 通道 ①：鼠标拖选（先断言选区长度 == 期望长度，再判内容） */
          const expectSel = await ev(([a, b]) => { const v = window.mpEngine._view(); const d = v.state.doc; return d.line(b).to - d.line(a).from; }, [res7.block1[0], res7.block1[1]]);
          await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x1, y: box.y1, button: 'left', clickCount: 1 });
          for (let k = 1; k <= 4; k++) {
            await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(box.x1 + (box.x2 - box.x1) * k / 4), y: Math.round(box.y1 + (box.y2 - box.y1) * k / 4), button: 'left' });
            await sleep(35);
          }
          await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x2, y: box.y2, button: 'left', clickCount: 1 });
          await sleep(220);
          selLen = await ev(() => (window.mpEngine._view().state.selection.main.to - window.mpEngine._view().state.selection.main.from));
          via = `鼠标拖选（选区 ${selLen}/${expectSel} 字符）`;
          if (selLen !== expectSel) {
            /* 通道 ②：键盘（Shift+End 逐行扩选）——拖选不稳时的交叉验证 */
            await ev(([a]) => { const v = window.mpEngine._view(); const d = v.state.doc; v.dispatch({ selection: { anchor: d.line(a).from } }); v.focus(); }, [res7.block1[0]]);
            for (let k = 0; k < 4; k++) { await page.keyboard.press('Shift+ArrowDown'); await sleep(80); }
            await page.keyboard.press('Shift+End');
            await sleep(200);
            selLen = await ev(() => (window.mpEngine._view().state.selection.main.to - window.mpEngine._view().state.selection.main.from));
            via = `键盘 Shift+↓/End（选区 ${selLen} 字符，期望 ≥ ${expectSel - 8}）`;
          }
          await page.keyboard.press('Control+C');
          await sleep(320);
          clip = psRead();
          if (clip && clip !== before && clip.includes('const first')) okClip = !/^\s*\d+\s+const/m.test(clip);
          else if (clip && clip !== before && !clip.includes('MP-QOFF-SENTINEL')) okClip = null; // 拿到了别的载荷：不算通过也不算失败
          if (okClip === null) before = clip;
        }
        const formats = psFormats();
        if (!clip) {
          judge('7.1', 'codeClipboardNoNumbers', null,
            `**未验证**：剪贴板读不到载荷（阳性对照=${positiveControl ? '通过（哨兵串可读可写）' : '**失败——连哨兵都写不进/读不出，环境被别的腿占住**'}；Get-Clipboard 返回 0 字符；formats=${formats}；选区 ${selLen} 字符，通道=${via}）`, '');
        } else if (!positiveControl) {
          judge('7.1', 'codeClipboardNoNumbers', null,
            `**未验证**：阳性对照失败（哨兵串写不进剪贴板）⇒ 本机剪贴板被别的进程占住，本次读数（${clip.length} 字符）不可信；formats=${formats}`, '');
        } else {
          judge('7.1', 'codeClipboardNoNumbers', okClip === true,
            `剪贴板 ${clip.length} 字符（阳性对照 ${positiveControl ? '✓' : '✗'}），含 const first=${clip.includes('const first')}，出现"行号+内容"同行=${/^\s*\d+\s+const/m.test(clip)}；选区 ${selLen}；通道=${via}；第 ${Math.min(rounds, 3)} 轮；formats=${formats}`,
            await shot('7.1-clipboard.png'));
        }
      }
    } catch (e) { judge('7.1', 'codeClipboardNoNumbers', false, '异常：' + String(e.message).slice(0, 120), ''); }

    /* 导出：先看导出面有没有 HTML 通道（有就跑一次导出前的内容检查） */
    try {
      const exp = await ev(() => {
        const keys = Object.keys(window).filter((k) => /export|mpExport|mpHost/i.test(k));
        const api = {};
        for (const k of keys) api[k] = typeof window[k];
        return { keys, api, hostMethods: window.mpHost ? Object.keys(window.mpHost).filter((m) => /export/i.test(m)) : [] };
      });
      /* 用**同一次快照**里的块文本（早先第二次读曾读到与 dump 不一致的内容） */
      const md4 = (snap7 && typeof snap7.block1Text === 'string' && snap7.block1Text) ? snap7.block1Text : null;
      if (md4 === null) judge('7.1', 'codeExportNoNumbers', null, `导出通道：${JSON.stringify(exp.hostMethods)}；代码块锚点没定位到 ⇒ 这条未验证（不是产品红）`, '');
      else if (!md4.includes('const first')) judge('7.1', 'codeExportNoNumbers', null,
        `导出通道：${JSON.stringify(exp.hostMethods)}；读到的片段不含目标代码块（头 60 字：「${md4.slice(0, 60).replace(/\n/g, '⏎')}」）⇒ 未验证（不是产品红）`, '');
      else judge('7.1', 'codeExportNoNumbers', !/^\s*\d+\s+const/m.test(md4),
        `导出通道：${JSON.stringify(exp.hostMethods)}；源码片段「${md4.slice(0, 50).replace(/\n/g, '⏎')}」里"行号+内容"同行=${/^\s*\d+\s+const/m.test(md4)}（导出件内容等产物就绪后用真实导出命令复核）`, '');
    } catch (e) { judge('7.1', 'codeExportNoNumbers', null, '未验证（导出通道探针异常）：' + String(e.message).slice(0, 120), ''); }
    }
  }

  /* ══════════ 7.5 工具栏 / 更多菜单 ══════════ */
  if (want('7.5')) {
    const tb = await ev(() => {
      const bar = document.querySelector('.mp-toolbar');
      const items = bar ? [...bar.querySelectorAll('.mp-tb-item')] : [];
      return { ids: items.map((b) => b.dataset.mpId), tips: items.map((b) => b.title || b.dataset.mpId) };
    });
    judge('7.5', 'reloadNotInToolbar', !tb.ids.includes('reload'), `工具栏 ${tb.ids.length} 项：${tb.ids.join(',')}`, await shot('7.5-toolbar.png'));
    const menu = await openMore();
    const hasReload = menu && menu.exists && menu.items.some((t) => /重新加载/.test(t));
    judge('7.5', 'reloadInMoreMenu', !!hasReload, menu ? `「更多」菜单 ${menu.allNodes ? menu.allNodes.length : menu.items.length} 条（含嵌套叶子节点）/ ${menu.directItems ? menu.directItems.length : '?'} 条（\`.mp-pop-item, .mp-pop-title\` :scope 直接子元素）；选择器口径=${menu.sel || '(未记录)'}；诊断=${JSON.stringify(menu.popDiag || {})}；含「重新加载」=${hasReload}；文本：${menu.items.slice(0, 18).join(' / ')}` : '没找到「更多」按钮或菜单没弹出', await shot('7.5-more-menu.png'));
    if (hasReload) {
      const before = await ev(() => window.mpEngine._view().state.doc.length);
      const clicked = await ev(() => {
        const pop = document.querySelector('.mp-pop'); if (!pop) return false;
        const el = [...pop.querySelectorAll('*')].find((x) => x.children.length === 0 && /重新加载/.test(x.textContent || ''));
        const target = el && (el.closest('[data-mp-id]') || el.closest('button') || el.parentElement || el);
        if (!target) return false;
        const r = target.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      if (!clicked) judge('7.5', 'reloadClickable', false, '菜单里找到文字但拿不到可点元素', '');
      else {
        try {
          await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clicked.x, y: clicked.y, button: 'left', clickCount: 1 });
          await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clicked.x, y: clicked.y, button: 'left', clickCount: 1 });
          await sleep(1200);
          const after = await ev(() => ({ len: window.mpEngine._view().state.doc.length, alive: !!window.mpEngine._view() }));
          judge('7.5', 'reloadClickable', after.alive, `点击后引擎存活=${after.alive}，字数 ${before} → ${after.len}`, '');
        } catch (e) { judge('7.5', 'reloadClickable', false, '点击异常：' + String(e.message).slice(0, 120), ''); }
      }
    } else judge('7.5', 'reloadClickable', false, '菜单里没有「重新加载」，无法点', '');
  }

  /* ══════════ 7.6 图片按钮职责单一 ══════════ */
  if (want('7.6')) {
    const btn = await ev(() => {
      const bar = document.querySelector('.mp-toolbar'); if (!bar) return null;
      const it = [...bar.querySelectorAll('.mp-tb-item')].find((b) => /image|img|图片/i.test((b.dataset.mpId || '') + (b.title || '')));
      if (!it) return null; const r = it.getBoundingClientRect();
      return { id: it.dataset.mpId, title: it.title, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (!btn) judge('7.6', 'imageButtonOnlyDialog', false, '工具栏里找不到图片按钮', '');
    else {
      const beforeLen = await ev(() => window.mpEngine._view().state.doc.length);
      const winsBefore = listWindowsAll().map((w) => w.hwnd);
      /* Lead 2026-10-09 固化判据：原生文件选择器 = **本进程**新增顶层窗口 + 类名 `#32770`；
         采样 ≥3 次、以落定后的裸 Win32 枚举为准。**不用**标题字符串、**不用**全桌面窗口数差（会被别的进程干扰）。 */
      const btnState = await ev(([id]) => {
        const b = document.querySelector('.mp-toolbar .mp-tb-item[data-mp-id="' + id + '"]') || [...document.querySelectorAll('.mp-toolbar .mp-tb-item')].find((x) => /upload|图片/.test((x.getAttribute('data-mp-id') || '') + (x.title || '')));
        return b ? { id: b.getAttribute('data-mp-id'), disabled: !!b.disabled, cls: String(b.className), title: (b.title || '').slice(0, 80), aria: b.getAttribute('aria-disabled') } : null;
      }, ['upload']);
      const procNew = []; let lastAddedCls = [];
      let dlg = null, winsIn = [];
      for (let k = 0; k < 3 && !dlg; k++) {
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
        await sleep(2200);
        winsIn = listWindows().filter((w) => !w.err);
        const added = winsIn.filter((w) => !winsBefore.includes(w.hwnd));
        procNew.push(added.length);
        lastAddedCls = added.map((w) => w.cls).slice(0, 8);
        dlg = added.find((w) => /^#32770$/.test(w.cls)) || null;
        if (!dlg) { await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(300); }
      }
      const fresh = dlg ? [dlg] : [];
      const afterLen = await ev(() => window.mpEngine._view().state.doc.length);
      judge('7.6', 'imageButtonOnlyDialog', btnState && btnState.disabled ? false : !!dlg,
        `按钮状态=${JSON.stringify(btnState)}｜本进程可见顶层窗口 ${winsBefore.length}→${winsIn.length}；3 次采样新增数=${JSON.stringify(procNew)}（末次新增窗口类名：${JSON.stringify(lastAddedCls)}）；命中 #32770 的=${dlg ? 'hwnd ' + dlg.hwnd : '无'}${fresh.length ? '（' + fresh.map((w) => `pid${w.pid} ${w.cls}:${(w.title || '无标题').slice(0, 16)}`).join(' / ') + '）' : ''}`,
        await shot('7.6-image-button.png'));
      judge('7.6', 'imageButtonDocUnchanged', beforeLen === afterLen, `点按钮前后文档字数 ${beforeLen} → ${afterLen}（按钮为禁用占位时本条只说明「点了没动作」；关掉对话框后复测）`, '');
      if (dlg) {
        const closed = closeDialog(dlg.hwnd);
        await sleep(900);
        const alive = await waitResponsive();
        const after2 = await ev(() => window.mpEngine._view().state.doc.length);
        judge('7.6', 'imageButtonDocUnchanged:afterClose', beforeLen === after2 && alive, `关闭对话框（${closed ? 'WM_CLOSE 已发' : '发送失败'}；渲染进程恢复=${alive}）后字数 = ${after2}（期望仍为 ${beforeLen}）`, '');
      } else judge('7.6', 'imageButtonDocUnchanged:afterClose', false, '没有检测到可关闭的对话框（本条与上一条同因）', '');
      /* 无论有没有对话框，都等渲染进程回到可服务状态——否则下一条（7.7）会连环假红（实测） */
      const back = await waitResponsive(12000);
      if (!back) console.log('   ⚠ 7.6 之后渲染进程 12s 未恢复');
    }
  }

  /* ══════════ 7.7 引用区选中高亮 ══════════ */
  if (want('7.7')) {
    await waitResponsive(12000);
    const q7 = anchor['7.7'];
    /* 【实测踩坑】引用行的 posAtDOM(el,0) 落在「> 」前缀之后（首个孩子是零宽 widget）⇒
       必须**区间匹配**，等值匹配会让引用行永远找不到（7.7 长期假红的真因）。 */
    const geomProbe = async () => ev(([q1, q2, q3]) => {
      const v = window.mpEngine._view(); const d = v.state.doc;
      const lineEl = (no) => [...v.contentDOM.children].find((el) => { try { const p = v.posAtDOM(el, 0); return p >= d.line(no).from && p <= d.line(no).to; } catch { return false; } });
      const a = lineEl(q1), c = lineEl(q3);
      if (!a || !c) return null;
      const ra = a.getBoundingClientRect(), rc = c.getBoundingClientRect();
      const rv = v.scrollDOM.getBoundingClientRect();
      const cs = getComputedStyle(a);
      const before = { borderLeft: cs.borderLeftWidth + ' ' + cs.borderLeftColor, bg: cs.backgroundColor, color: cs.color };
      return { a: { x: ra.left, y: ra.top, r: ra.right, b: ra.bottom }, c: { x: rc.left, y: rc.top, r: rc.right, b: rc.bottom },
        vTop: rv.top, vBottom: rv.bottom, before, cls: a.className };
    }, [q7.q1, q7.q2, q7.q3]);
    const rectInView = (r, g) => !!(r && g && r.b > g.vTop + 4 && r.y < g.vBottom - 4);
    /* 【口径·2026-10-09】"找得到元素"不够——拖选的按下点必须落在**可见视口**里。
       实测：§7.7 这一段的行元素会在视口外几百到两万像素处给出矩形（高度图反复重建 + 引擎自留节点），
       旧口径只看"元素在不在 DOM"，于是鼠标按在窗口外 ⇒ 拖选恒 0 字，靠程序化兜底把红藏成绿。
       多行拖选要**起点行与终点行同时在视口里**：先把终点行（第三行）摆进视口（留 200px），
       起点行在它上面三行、自然也在；不行再退成"起点行贴顶"。 */
    let geom = null;
    const geomUsable = () => !!(geom && rectInView(geom.a, geom) && rectInView(geom.c, geom));
    const prepGeom = async () => {
      /* 【顺序·实测】先把**起点行**（第一行）摆进舒适带（离上边 ≥80px），终点行在它下面三行、
         自然也在带内。只要求"与视口相交"是不够的：实测起点行落在 y=44..67 时按下点会压在
         顶部工具条上（0 字），而引擎在长序列里又只肯把行停在贴边位置。 */
      const confort = () => geomUsable() && geom.a.y > 80 && geom.c.b < geom.vBottom - 20;
      await ensureLineVisible(q7.q1, 300, 90);
      geom = await geomProbe();
      if (confort()) return true;
      await ensureLineVisible(q7.q3, 500, 60);
      geom = await geomProbe();
      if (confort()) return true;
      await ensureLineVisible(q7.q1, 320, 80);
      geom = await geomProbe();
      return confort();
    };    let prepOK = await prepGeom();
    let usedDoc = '验收清单';
    if (!prepOK) {
      /* 大文档在长序列里摆不进舒适带（引擎把行停在贴边/视口外）⇒ 换**最小夹具**
         （同内容小文档，必定渲染，同一条判据照跑）。 */
      const fx = ['# 选中高亮最小夹具', '', '> 引用第一行：从这一行的中间按下开始拖选。', '> 引用第二行：拖到这里继续往下。', '>', '> 引用第三行（上面有一个空引用行）。', '', '正文对照：这一行是普通正文。', ''].join('\n');
      const fxPath = path.join(TMP, 'sel-夹具.md');
      fs.mkdirSync(TMP, { recursive: true });
      fs.writeFileSync(fxPath, fx, 'utf8');
      /* 这里不能用后面才定义的 openDoc（TDZ ⇒ 实测 ReferenceError）⇒ 就地换文档并核对实载长度 */
      let expectLen = null;
      try { let t = fs.readFileSync(fxPath, 'utf8'); if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); expectLen = t.replace(/\r\n/g, '\n').length; } catch { }
      await ev(([pp]) => window.mpHost.openPath(pp), [fxPath]);
      let ld = { ok: false };
      for (let i = 0; i < 60; i++) { await sleep(250); const len = await ev(() => window.mpEngine._view().state.doc.length); if (expectLen === null || len === expectLen) { ld = { ok: true }; break; } }
      if (ld.ok) {
        await sleep(700);
        const L2 = fx.split('\n');
        q7.q1 = L2.findIndex((l) => l.startsWith('> 引用第一行')) + 1;
        q7.q2 = L2.findIndex((l) => l.startsWith('> 引用第二行')) + 1;
        q7.q3 = L2.findIndex((l) => l.startsWith('> 引用第三行')) + 1;
        q7.plain = L2.findIndex((l) => l.startsWith('正文对照')) + 1;
        usedDoc = '最小夹具';
        prepOK = await prepGeom();
      }
    }
    /* 真人式拖选：真按下 → 多次移动（`buttons:1`，与物理鼠标一致）→ 抬起，位移之间带小延时。
       太快、且不带 buttons 位的一次 press/move/release 会被浏览器合成"点一下"（实测得到 0 字）。 */
    const realDrag = async (p1, p2, tag) => {
      /* 【焦点断言·工作区规则】按键/鼠标读数前先断言焦点真的在编辑器里：7.6 的原生对话框之后
         渲染进程可能没有焦点，此时"拖了却没选中"量到的是假读数。 */
      const foc = await ev(() => { const v = window.mpEngine._view(); if (!v.hasFocus) v.focus(); return { view: v.hasFocus, doc: document.hasFocus(), active: String(document.activeElement && document.activeElement.className || '').slice(0, 20) }; }).catch(() => null);
      if (DIAG) console.log(`   [7.7 diag] ${tag} 焦点=${JSON.stringify(foc)}`);
      const selNow = async (stage) => {
        if (!DIAG) return;
        const s = await ev(() => { const sel = window.getSelection(); return { len: sel ? String(sel).length : 0, head: sel ? String(sel).slice(0, 12) : '' }; }).catch(() => ({ len: -1 }));
        console.log(`   [7.7 diag] ${tag} ${stage} 选区=${s.len} «${s.head}»`);
      };
      await sleep(120);
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p1.x, y: p1.y, button: 'left', buttons: 1, clickCount: 1 });
      await sleep(80);
      await selNow('按下后');
      const N = 6;
      for (let k = 1; k <= N; k++) {
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved',
          x: Math.round(p1.x + (p2.x - p1.x) * k / N), y: Math.round(p1.y + (p2.y - p1.y) * k / N), button: 'left', buttons: 1 });
        await sleep(45);
      }
      await selNow('最后一次移动后');
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p2.x, y: p2.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(280);
      const s = await ev(() => { const sel = window.getSelection(); return { domLen: sel ? String(sel).length : 0, domHead: sel ? String(sel).slice(0, 18) : '' }; })
        .catch(() => ({ domLen: 0, domHead: '' }));
      if (DIAG) console.log(`   [7.7 diag] ${tag} 拖选 → ${s.domLen} 字 «${s.domHead}»`);
      return s;
    };
    if (!prepOK) judge('7.7', 'quoteSelectionBounds', false, `7.7 的引用行没能摆进视口舒适带（清单与最小夹具都试过；用的是 ${usedDoc}）`, '');
    else {
      console.log(`  · 7.7 用的是 ${usedDoc}（引用行已在视口舒适带：q1.y=${Math.round(geom.a.y)}..${Math.round(geom.a.b)} q3.b=${Math.round(geom.c.b)}）`);
      /* ── 引用段：多行拖选（第一行中间 → 第三行末尾）─────────────────────────────
         坐标全部取自**已被 ensureLineVisible 证明与视口相交**的元素矩形，并夹进窗口内：
         元素在 DOM 里 ≠ 在视口里（实测视口外 390px 的行元素照样有矩形）⇒ 旧口径按下点在窗口外，
         拖选恒 0 字，长期靠"程序化选区兜底"把红藏成绿。现在真拖最多两次，兜底不再算通过。 */
      let dragLen = 0, selVia = '鼠标拖选', tries = 0;
      for (tries = 1; tries <= 4 && !dragLen; tries++) {
        if (tries > 1) { await prepGeom(); await sleep(220); }
        const yA = Math.round((geom.a.y + geom.a.b) / 2), yC = Math.round((geom.c.y + geom.c.b) / 2);
        const p1 = { x: Math.min(Math.round(geom.a.x) + 60, 1160), y: Math.max(6, Math.min(yA, 750)) };
        const p2 = { x: Math.min(Math.round(geom.c.r) - 40, 1160), y: Math.max(6, Math.min(yC, 750)) };
        const s = await realDrag(p1, p2, `引用段#${tries}`);
        dragLen = s.domLen;
      }
      const realDragOK = dragLen > 0;
      if (!dragLen) {
        /* 【不许拿兜底当通过】真拖两次都没选中 ⇒ 程序化选区**只用来量几何**，判据照样判红：
           本条的验收对象就是"真人拖选"这条通路。 */
        await ev(([a, c]) => {
          const v = window.mpEngine._view(); const d = v.state.doc;
          v.dispatch({ selection: { anchor: d.line(a).from + 2, head: d.line(c).to } });
          v.focus();
        }, [q7.q1, q7.q3]);
        await sleep(350);
        dragLen = await ev(() => (window.mpEngine._view().state.selection.main.to - window.mpEngine._view().state.selection.main.from));
        selVia = '程序化选区（真拖 2 次都没中 ⇒ 不算通过）';
      }
      const sel = await ev(([q1, q3]) => {
        const v = window.mpEngine._view(); const d = v.state.doc;
        const s = window.getSelection();
        const rects = s && s.rangeCount ? [...s.getRangeAt(0).getClientRects()].map((r) => ({ x: r.left, r: r.right, y: r.top, b: r.bottom })) : [];
        /* 引用行的 posAtDOM(el,0) 会落在「> 」前缀之后（首个孩子是零宽 widget）⇒ 用区间匹配，别用等值 */
      const lineEl = (no) => [...v.contentDOM.children].find((el) => { try { const p = v.posAtDOM(el, 0); return p >= d.line(no).from && p <= d.line(no).to; } catch { return false; } });
        const el = lineEl(q1);
        const box = el ? el.getBoundingClientRect() : null;
        const cs = el ? getComputedStyle(el) : null;
        return { rects: rects.slice(0, 12), len: s ? String(s).length : 0, box: box ? { x: box.left, r: box.right } : null,
          after: cs ? { borderLeft: cs.borderLeftWidth + ' ' + cs.borderLeftColor, bg: cs.backgroundColor, color: cs.color } : null };
      }, [q7.q1, q7.q3]);
      const outside = sel.rects.filter((r) => sel.box && (r.x < sel.box.x - 1.5 || r.r > sel.box.r + 1.5));
      const ok = realDragOK && dragLen > 0 && sel.rects.length > 0 && outside.length === 0;
      judge('7.7', 'quoteSelectionBounds', !!ok,
        `选中 ${dragLen} 字（${selVia}${realDragOK ? `；真拖第 ${tries - 1} 次命中` : ''}） / ${sel.rects.length} 个高亮矩形；越出引用框的 ${outside.length} 个${outside.length ? ' ' + JSON.stringify(outside.slice(0, 3)) : ''}；引用框 [${sel.box ? Math.round(sel.box.x) : '?'}, ${sel.box ? Math.round(sel.box.r) : '?'}]`,
        await shot('7.7-quote-selection.png'));
      judge('7.7', 'quoteBarStyleStable', !!sel.after && JSON.stringify(sel.after) === JSON.stringify(geom.before),
        `选中前 ${JSON.stringify(geom.before)} → 选中后 ${JSON.stringify(sel.after)}（计算样式；像素级观感仍列视觉通道）`, '');
      /* ── 正文对照段：真拖一小段（先证明这一行真的在视口里，再从它的矩形上取点） ──
         位置用**舒适档**（离上下边各 90px）：贴底边时按下点会被引擎重排带走，实测拖 150px
         选中了 2634 字（一直到文档尾）——判据（n>0）照样过，但那是假干净。
         判据（**只加强、不放宽**）：①真拖（不是程序化选区）②非空 ③**选区必须落在这条正文行的
         文档区间里**——不然"选中了别处的文字"也会被当成"正文段落能选中"（实测行元素矩形陈旧时
         按下点其实落在标题行上，选中了 8 个字，旧口径会当真）。 */
      const plainRange = await ev(([no]) => { const l = window.mpEngine._view().state.doc.line(no); return { from: l.from, to: l.to }; }, [q7.plain]).catch(() => null);
      const lineText = await ev(([no]) => window.mpEngine._view().state.doc.line(no).text.slice(0, 40), [q7.plain]).catch(() => '');
      const dragOnPlainOnce = async (tag) => {
        let pg = await ensureLineVisible(q7.plain, 300, 90);
        if (!pg) pg = await ensureLineVisible(q7.plain, 120, 4);
        if (!pg) return { n: 0, inLine: false, pg: null, why: '这一行没能进视口（定位失败，不猜坐标）' };
        const useCaret = pg.caret && pg.caret.y > pg.rect.y - 1 && pg.caret.b < pg.rect.b + 1;
        const y = Math.round(useCaret ? (pg.caret.y + pg.caret.b) / 2 : pg.rect.y + Math.min(8, pg.rect.h / 2));
        const dx1 = Math.round(pg.rect.x) + 10;
        const dx2 = Math.min(Math.round(pg.rect.x) + 160, Math.round(pg.rect.r) - 6, 1160);
        if (DIAG) {
          const probe = await ev(([x1, yy]) => {
            const el = document.elementFromPoint(x1, yy);
            const line = el && el.closest ? el.closest('.cm-line') : null;
            return { under: el ? String(el.className || el.tagName).slice(0, 26) : null,
              lineOfClick: line ? (line.textContent || '').slice(0, 14) : null };
          }, [dx1, y]).catch((e) => ({ err: String(e.message).slice(0, 50) }));
          console.log(`   [7.7 diag] ${tag} 定位 rect.y=${Math.round(pg.rect.y)}..${Math.round(pg.rect.b)} 拖点=${JSON.stringify({ dx1, dx2, y })} 命中行=${JSON.stringify(probe)}`);
        }
        await realDrag({ x: dx1, y }, { x: dx2, y }, tag);
        const st = await ev(() => {
          const v = window.mpEngine._view(); const m = v.state.selection.main; const sel = window.getSelection();
          return { n: sel ? String(sel).length : 0, cmFrom: m.from, cmTo: m.to, head: sel ? String(sel).slice(0, 16) : '' };
        }).catch(() => ({ n: 0, cmFrom: -1, cmTo: -1, head: '' }));
        const inLine = !!(plainRange && st.cmFrom >= plainRange.from && st.cmTo <= plainRange.to && st.n > 0);
        if (DIAG) console.log(`   [7.7 diag] ${tag} 选中 ${st.n} 字 «${st.head}» 落在本行内=${inLine}（区间 [${plainRange ? plainRange.from : '?'},${plainRange ? plainRange.to : '?'}] vs [${st.cmFrom},${st.cmTo}]）`);
        return { n: st.n, inLine, pg };
      };
      let plainRes = { n: 0, inLine: false, pg: null, why: '还没试' };
      for (let t = 1; t <= 3; t++) {
        plainRes = await dragOnPlainOnce(`正文段#${t}`);
        if (plainRes.n > 0 && plainRes.inLine) { plainRes.used = t; break; }
        await sleep(220);
      }
      if (plainRes.pg && DIAG) console.log(`   [7.7 diag] usedDoc=${usedDoc} plain=行${q7.plain} «${lineText}»`);
      judge('7.7', 'plainSelectionRegression', plainRes.n > 0 && plainRes.inLine,
        plainRes.pg
          ? `正文段落可正常选中 ${plainRes.n} 字（真拖第 ${plainRes.used || 3} 次；选区落在该行内=${plainRes.inLine}；行 ${q7.plain} «${String(lineText).slice(0, 16)}»；观感对比见视觉通道）`
          : `正文对照行定位失败：${plainRes.why}（不猜坐标）`,
        await shot('7.7-plain-selection.png'));
    }
  }

  /* ══════════ 7.2 / 7.3 / 7.4 图片策略与两条命令（切文档 + 文件系统核对） ══════════ */
  const openDoc = async (p, hint) => {
    /* 【实测踩坑】openDoc 可能因为前台还压着别的文档而"看起来成功"——必须**核对真的换过去了**：
       用文件文本长度（剥 BOM / 归一 CRLF）对 view.state.doc.length，不一致就报红，绝不拿旧文档量性能。 */
    let expectLen = null, expectHead = null;
    try {
      let t = fs.readFileSync(p, 'utf8');
      if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
      t = t.replace(/\r\n/g, '\n');
      expectLen = t.length; expectHead = t.split('\n')[0].slice(0, 24);
    } catch { /* 读不到就只按 hint 判 */ }
    await ev(([pp]) => window.mpHost.openPath(pp), [p]);
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const cur = await ev(() => { const v = window.mpEngine._view(); return { len: v.state.doc.length, head: v.state.doc.line(1).text.slice(0, 40) }; });
      if (expectLen !== null && cur.len === expectLen) return { ok: true, len: cur.len, head: cur.head };
      if (expectLen === null && hint && cur.head.includes(hint.head)) return { ok: true, len: cur.len, head: cur.head };
      if (expectLen === null && !hint && i > 6) return { ok: true, len: cur.len, head: cur.head };
    }
    const cur = await ev(() => ({ len: window.mpEngine._view().state.doc.length, head: window.mpEngine._view().state.doc.line(1).text.slice(0, 40) }));
    return { ok: false, len: cur.len, head: cur.head, expectLen, expectHead, file: p };
  };
  const findCommand = async (re) => {
    const menu = await openMore();
    const hit = menu && menu.exists ? menu.items.find((t) => re.test(t)) : null;
    if (!hit) return { found: false, menu };
    const pos = await ev(([txt]) => {
      const pop = document.querySelector('.mp-pop'); if (!pop) return null;
      const el = [...pop.querySelectorAll('*')].find((x) => x.children.length === 0 && (x.textContent || '').trim() === txt);
      const t = el && (el.closest('[data-mp-id]') || el.closest('button') || el.parentElement);
      if (!t) return null; const r = t.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }, [hit]);
    return { found: true, text: hit, pos, menu };
  };
  const clickAt = async (p) => {
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(600);
  };

  if (want('7.2') || want('7.3') || want('7.4')) {
    /* 造两份临时文档：A=本地路径图（验内联命令）；B=data URI 图（验抽出命令/幂等/撤销） */
    const dirA = path.join(TMP, 'inline');
    const dirB = path.join(TMP, 'assets');
    for (const d of [dirA, dirB]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
    /* 【夹具修正·2026-10-09】docA 的相对写法是 `![rel](../assets/small.png)`，从 dirA(=TMP\inline) 解析
       即 `TMP\assets\small.png`；改前这里**没把素材拷过去** ⇒ 那张图是**悬空引用**，任何实现都内联不了、
       判据恒红（实测：内联后仍剩 1 张非 data）。现在把 small.png 放进 dirB(=TMP\assets)，相对引用才成立。 */
    fs.copyFileSync(SMALL, path.join(dirB, 'small.png'));
    const localImg = SMALL.replace(/\\/g, '/');
    const docA = ['# 内联命令夹具', '', `相对写法：![rel](../assets/small.png)`, '', `绝对写法：![abs](${localImg})`, '', `本来就是 data URI：![inline](data:image/png;base64,${fs.readFileSync(SMALL).toString('base64')})`, ''].join('\n');
    const docB = ['# 抽出到 assets 夹具', '', `第一张：![img1](data:image/png;base64,${fs.readFileSync(SMALL).toString('base64')})`, '', `第二张：![img2](data:image/png;base64,${fs.readFileSync(SMALL).toString('base64')})`, ''].join('\n');
    const fileA = path.join(dirA, 'inline-夹具.md');
    const fileB = path.join(dirB, 'assets-夹具.md');
    fs.writeFileSync(fileA, docA, 'utf8'); fs.writeFileSync(fileB, docB, 'utf8');

    if (want('7.2')) {
      await openDoc(fileA, { head: '# 内联命令夹具' });
      const before = await docText();
      const cmd = await findCommand(/内联全部图片|内联图片|全部内联/);
      if (!cmd.found) judge('7.2', 'imageInlineCommand', false, `没找到「内联全部图片」命令；「更多」菜单文本：${cmd.menu && cmd.menu.exists ? cmd.menu.items.join(' / ').slice(0, 160) : '(没弹出)'}`, await shot('7.2-more-menu.png'));
      else {
        if (cmd.pos) await clickAt(cmd.pos);
        await sleep(1200);
        const after = await docText();
        const dataCount = (after.match(/data:image\//g) || []).length;
        const localLeft = /!\[(rel|abs)\]\((?!data:)/.test(after);
        judge('7.2', 'imageInlineCommand', dataCount >= 3 && !localLeft,
          `执行「${cmd.text}」后：data URI 图 ${dataCount} 张（期望 3）、仍有非 data 图=${localLeft}；文档 ${before.length} → ${after.length} 字符`,
          await shot('7.2-inline-command.png'));
      }
      /* 换目录仍显示：把 A 目录整体拷走，打开副本，看图是否渲染 */
      const dirA2 = path.join(TMP, 'inline-copy');
      fs.rmSync(dirA2, { recursive: true, force: true }); fs.cpSync(dirA, dirA2, { recursive: true });
      await openDoc(path.join(dirA2, 'inline-夹具.md'), { head: '# 内联命令夹具' });
      await sleep(800);
      const imgs = await ev(() => { const v = window.mpEngine._view(); return [...v.contentDOM.querySelectorAll('img')].filter((i) => !i.classList.contains('cm-widgetBuffer')).map((i) => ({ alt: i.getAttribute('alt'), nw: i.naturalWidth, nh: i.naturalHeight })); });
      const good = imgs.filter((i) => i.nw > 0).length;
      judge('7.2', 'imageDataUriSurvivesCopy', good >= 2, `换目录后渲染出的图：${JSON.stringify(imgs.slice(0, 6))}（期望 ≥2 张 naturalWidth>0；rel 那张若没内联成功这里会露出来）`, await shot('7.2-copied.png'));
    }

    if (want('7.3') || want('7.4')) {
      await openDoc(fileB, { head: '# 抽出到 assets 夹具' });
      const t0 = await docText();
      const cmd = await findCommand(/抽出到\s*assets|抽出图片|提取到\s*assets|图片抽出/);
      if (!cmd.found) {
        judge('7.3', 'imageAssetsCommand', false, `没找到「抽出到 assets」命令；「更多」菜单文本：${cmd.menu && cmd.menu.exists ? cmd.menu.items.join(' / ').slice(0, 160) : '(没弹出)'}`, await shot('7.3-more-menu.png'));
        judge('7.4', 'imageCommandsExist', false, '两条图片命令没在「更多」菜单里找到', '');
      } else {
        if (want('7.4')) judge('7.4', 'imageCommandsExist', true, `找到「${cmd.text}」`, '');
        if (cmd.pos) await clickAt(cmd.pos);
        await sleep(1500);
        const t1 = await docText();
        const assetFiles = fs.existsSync(path.join(dirB, 'assets')) ? fs.readdirSync(path.join(dirB, 'assets')) : [];
        if (want('7.3')) {
          judge('7.3', 'imageAssetsCommand', assetFiles.length >= 2 && /data:image\//.test(t0),
            `执行后 assets\\ 里 ${assetFiles.length} 个文件（${assetFiles.slice(0, 4).join(',')}）；文档里还有 data URI=${/data:image\//.test(t1)}`,
            await shot('7.3-assets-command.png'));
          judge('7.3', 'imageAssetsRelativePath', /!\[[^\]]*\]\((?!data:|[A-Za-z]:|file:)[^)]*\.png\)/.test(t1),
            `转换后图片行样例：${(t1.match(/!\[[^\]]*\]\([^)]*\)/g) || []).slice(0, 3).join(' | ')}`, '');
        }
        if (want('7.4')) {
          /* 往返幂等：assets → inline，与起点逐字节比 */
          const back = await findCommand(/内联全部图片|内联图片|全部内联/);
          if (back.found && back.pos) { await clickAt(back.pos); await sleep(1500); }
          const t2 = await docText();
          judge('7.4', 'imageRoundTripIdempotent', sha(t0) === sha(t2), `往返 : inline→assets→inline  sha ${sha(t0)} vs ${sha(t2)}（${t0.length} → ${t2.length} 字符）`, '');
          /* 一次撤销：再执行一次 assets，然后 Ctrl+Z 一次，看是否回到前态 */
          const again = await findCommand(/抽出到\s*assets|抽出图片|提取到\s*assets|图片抽出/);
          if (again.found && again.pos) {
            const pre = await docText();
            await clickAt(again.pos); await sleep(1500);
            const mid = await docText();
            await ev(() => window.mpEngine._view().focus());
            await page.keyboard.press('Control+z'); await sleep(900);
            const post = await docText();
            judge('7.4', 'imageSingleUndo', sha(post) === sha(pre) && sha(mid) !== sha(pre),
              `撤销前 ${sha(pre)} → 命令后 ${sha(mid)} → 一次 Ctrl+Z 后 ${sha(post)}（期望回到 ${sha(pre)}）`, await shot('7.4-undo.png'));
          } else judge('7.4', 'imageSingleUndo', false, '找不到「抽出到 assets」命令，无法测撤销', '');
        }
        /* 整目录拷走后仍显示 */
        if (want('7.3')) {
          const dirB2 = path.join(TMP, 'assets-copy');
          fs.rmSync(dirB2, { recursive: true, force: true }); fs.cpSync(dirB, dirB2, { recursive: true });
          await openDoc(path.join(dirB2, 'assets-夹具.md'), { head: '# 抽出到 assets 夹具' });
          await sleep(1000);
          const imgs = await ev(() => { const v = window.mpEngine._view(); return [...v.contentDOM.querySelectorAll('img')].filter((i) => !i.classList.contains('cm-widgetBuffer')).map((i) => ({ alt: i.getAttribute('alt'), src: (i.getAttribute('src') || '').slice(0, 40), nw: i.naturalWidth })); });
          judge('7.3', 'imageAssetsSurvivesMove', imgs.some((i) => i.nw > 0), `整目录拷走后打开副本：${JSON.stringify(imgs.slice(0, 4))}`, await shot('7.3-copied.png'));
        }
      }
    }
  }

  /* ══════════ 7.8 性能 + 结构文档 ══════════ */
  if (want('7.8')) {
    const instrument = async () => ev(() => {
      const v = window.mpEngine._view();
      window.__perf = { samples: [], pending: 0, frames: [], miss: 0, KEY: '测' };
      document.addEventListener('keydown', () => { window.__perf.pending = performance.now(); }, true);
      /* 【审计修正·2026-10-09】改前是"keydown 之后**第一个** DOM 变更"就算数 —— 实测这会抓到
         **与这次按键无关的便宜变更**（光标行/小部件缓冲等）⇒ 同一包、同一份 8.13MB 夹具，
         本条读 1.4ms，而"只认被敲字符那次变更"的尺子读 12.2ms、紧循环 dispatch 读 13ms。
         现在只认**包含被敲字符的那次变更**；500ms 内没等到就记一次 miss（不把"没等到"当"很快"）。 */
      new MutationObserver((muts) => {
        if (!window.__perf.pending) return;
        let hit = false;
        for (const m of muts) {
          const t = m.type === 'characterData' ? (m.target.nodeValue || '') : (m.target.textContent || '');
          if (t.includes(window.__perf.KEY)) { hit = true; break; }
          if (m.addedNodes) { for (const nd of m.addedNodes) if ((nd.textContent || '').includes(window.__perf.KEY)) { hit = true; break; } }
        }
        if (!hit) return;
        window.__perf.samples.push(performance.now() - window.__perf.pending);
        window.__perf.pending = 0;
      }).observe(v.contentDOM, { childList: true, subtree: true, characterData: true });
      return true;
    });
    const typeKeys = async (n) => {
      await ev(() => window.mpEngine._view().focus());
      for (let i = 0; i < n; i++) {
        await client.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '测', unmodifiedText: '测', key: '测', windowsVirtualKeyCode: 0 });
        await client.send('Input.dispatchKeyEvent', { type: 'char', text: '测', key: '测' });
        await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '测' });
        await sleep(70);
      }
      await sleep(500);
      return ev(() => {
        const s = (window.__perf.samples || []).slice().sort((a, b) => a - b);
        const q = (p) => s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10 : null;
        /* 【条件随读数一起报·2026-10-09】同一份夹具，敲在短行/巨行区域能差一个数量级（1.3 vs 12.5ms），
           所以"落点行 + 视口里最长行"必须进 detail，否则读数无法比较。 */
        let cond = null;
        try {
          const v = window.mpEngine._view(); const doc = v.state.doc;
          const head = v.state.selection.main.head; const ln = doc.lineAt(head);
          let vmax = 0, vn = 0;
          for (const el of v.contentDOM.children) {
            if (!el.classList || !el.classList.contains('cm-line')) continue;
            try { const n = doc.lineAt(v.posAtDOM(el, 0)).number; vn++; vmax = Math.max(vmax, doc.line(n).length); } catch { }
          }
          cond = { caretLine: ln.number, caretCol: head - ln.from, caretLineLen: ln.length, viewportLines: vn, viewportMaxLen: vmax, scrollTop: Math.round(v.scrollDOM.scrollTop) };
        } catch { }
        return { n: s.length, p50: q(0.5), p95: q(0.95), max: s.length ? Math.round(s[s.length - 1] * 10) / 10 : null, docLen: window.mpEngine._view().state.doc.length, miss: window.__perf.miss || 0, cond };
      });
    };

    // 8.13MB 文档：滚到末尾段落连打 30 字符（原 demo 夹具可能被别的进程改动 ⇒ 有同源副本兜底，且如实标注用了哪份）
    const ALIAS = BIGDOC;
    const STABLE = path.join(DIR, 'fixtures', '01-内联大图文档-8.13MB.md');
    const sizeOf = (f) => (fs.existsSync(f) ? fs.statSync(f).size : 0);
    const aliasSize = sizeOf(ALIAS), stableSize = sizeOf(STABLE);
    const useStable = aliasSize < 8 * 1048576 && stableSize >= 8 * 1048576;
    const bigFile = useStable ? STABLE : ALIAS;
    const bigLen = sizeOf(bigFile);
    const bigSha = fs.existsSync(bigFile) ? crypto.createHash('sha256').update(fs.readFileSync(bigFile)).digest('hex').slice(0, 16) : '?';
    /* 【真身硬判据·2026-10-09】真身 = sha 命中，或文件里确实有 ≥3 行超过 20 万字符
       （真身有 23 行 20 万~91.6 万字符；accept-310 的兜底合成件用一张小图重复，拼不出这种行）。 */
    let hugeLineCount = 0;
    try { for (const L of fs.readFileSync(bigFile, 'utf8').split('\n')) if (L.length > 200000) hugeLineCount++; } catch { }
    let isRealBody = bigSha === '42c129273a0cd486' || hugeLineCount >= 3;
    /* 【用前自愈·2026-10-09】实测：**验收运行期间**这个夹具会被某处写成 177 B / 357 B 的小残件
       （内容只有几十个「测」，两次写入分别在 16:31:59 与 16:32:03；写它的不是本脚本——脚本里没有
       写这个路径的代码；产品侧"自动保存写错路径"已被定点实验排除：开 A→开 B→在 B 打字 20 秒，
       A 全程 8,527,008 B 未变、B 存回 B）。所以这里**用之前先自愈一次**，再复验真身。 */
    if (!isRealBody) {
      const pristine = path.join(ROOT, '.mp-verify', 'img-bug', 'verify', 'copy-original.md');
      try {
        if (fs.existsSync(pristine) && fs.statSync(pristine).size >= 8 * 1048576) {
          fs.copyFileSync(pristine, bigFile);
          hugeLineCount = 0;
          for (const L of fs.readFileSync(bigFile, 'utf8').split('\n')) if (L.length > 200000) hugeLineCount++;
          isRealBody = hugeLineCount >= 3;
          console.log(`· §7.8 夹具自愈：检测到残件 ⇒ 已从 ${pristine} 重拷（${fs.statSync(bigFile).size} B，>20 万字符的行 ${hugeLineCount} 条）`);
        }
      } catch (e) { console.log('· §7.8 夹具自愈失败：' + ((e && e.message) || e)); }
    }
    const bigNote = useStable
      ? `实测用的是 checklist\\fixtures 同源副本（demo 原夹具已被改动：${aliasSize} B）`
      : `实测用的是 demo 原夹具（${(bigLen / 1048576).toFixed(2)} MB）`;
    if (!fs.existsSync(bigFile) || bigLen < 8 * 1048576) {
      judge('7.8', 'perfLargeDocTyping', false, `8.13MB 性能夹具不可用：demo=${aliasSize} B、checklist\\fixtures 副本=${stableSize} B（两个都 <8MB）`, '');
    } else if (!isRealBody) {
      /* 【真身硬判据·2026-10-09】夹具可能是 accept-310 的**兜底合成件**（一张小图重复 N 行）
         ——那种件上量出的 1.4ms 会被当成"真文档也很快"（实测踩过）。判据：要么 sha 就是真身，
         要么文件里确实有 ≥3 行超过 20 万字符（真身有 23 行 20 万~91.6 万字符；合成件的小图拼不出这种行）。 */
      judge('7.8', 'perfLargeDocTyping', false,
        `性能夹具不是真身（sha256_16 ${bigSha}，${(bigLen / 1048576).toFixed(2)} MB；>20 万字符的行只有 ${hugeLineCount} 条，要求 ≥3）⇒ 本轮不判绿，避免在合成件上出假读数`,
        '');
    } else {
      const loaded = await openDoc(bigFile);
      if (!loaded.ok) {
        judge('7.8', 'perfLargeDocTyping', false,
          `夹具没换成目标文档（executor 读到的实际文档 ${loaded.len} 字符 / 首行「${String(loaded.head).slice(0, 20)}」，期望 ${loaded.expectLen} 字符 / 首行「${String(loaded.expectHead).slice(0, 20)}」）⇒ 本轮不量性能，避免拿旧文档出假读数`,
          '');
      } else {
        await sleep(1500);
        await ev(() => { const v = window.mpEngine._view(); v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight; });
        await sleep(1200);
        /* 【三采样取中位·2026-10-09 拍板选 C】两个条件各**连测 3 次**，判据用**三次的中位数**：
           起因＝条件② 在同一份产物、同一落点上四次样本为 15.9 / 16.1 / 16.3 / 26.6ms，
           20ms 判据落在抖动带内 ⇒ 同一产物时而 80/80、时而 79/80。选 C 的意图是
           **不放松阈值、只消掉单次运气**（26.6 这种离群值进不了中位）；三次读数全部写进报告。
           每次采样仍保留"文档未被换掉"的有效性断言（>800 万字符）。 */
        const p50s = (a) => a.map((x) => x.p50);
        const median = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
        const runsBig = [], runsNear = [];
        const giantNo = await ev(() => {
          const v = window.mpEngine._view(); const doc = v.state.doc;
          let no = 1, len = 0;
          for (let i = 1; i <= doc.lines; i++) { const L = doc.line(i).length; if (L > len) { len = L; no = i; } }
          return no;
        });
        for (let k = 0; k < 3; k++) {
          if (k === 0) { await instrument(); } else {
            /* 回到条件① 的位置：视口回文档开头、光标回第 1 行行尾（与首次同口径） */
            await ev(() => { const v = window.mpEngine._view(); v.dispatch({ selection: { anchor: 0 }, scrollIntoView: true }); v.scrollDOM.scrollTop = 0; });
            await sleep(900);
            await instrument();
          }
          runsBig.push(await typeKeys(30));
          /* 条件②：光标放到紧挨最长巨行的下一行 */
          await ev((no) => {
            const v = window.mpEngine._view(); const doc = v.state.doc;
            const n = Math.min(doc.lines, no + 1);
            v.dispatch({ selection: { anchor: doc.line(n).to }, scrollIntoView: true });
          }, giantNo);
          await sleep(900);
          await instrument();
          runsNear.push(await typeKeys(30));
        }
        const perfBig = runsBig[0], perfNear = runsNear[0];
        const medBig = median(p50s(runsBig)), medNear = median(p50s(runsNear));
        const valid = (r) => r.n >= 20 && r.p50 !== null && r.docLen > 8000000;
        const ok1 = runsBig.every(valid) && medBig < 20;
        const ok2 = runsNear.every(valid) && medNear < 20;
        /* 【测量有效性断言·2026-10-09】实测踩到：跑动中这份夹具会被应用**自己保存**成小残件
           （应用侧留痕 `dbgSave`：08:37:42 写 177 B、08:37:46 写 357 B，路径就是本夹具），
           随后文档被重载 ⇒ 条件②"视口含巨行 1.4ms"量的其实是残件，**不是真身**。
           所以每次采样都要求"打字结束时引擎文档仍 >800 万字符"；被换掉就判红并写清原因，不再出假绿。 */
        const condText = (p) => `p50=${p.p50}ms p95=${p.p95}ms max=${p.max}ms（样本 ${p.n}${p.miss ? '，未归因 ' + p.miss : ''}；打字结束时引擎文档 ${p.docLen} 字符${p.docLen > 8000000 ? ' ✓' : ' ✗ 已被换成别的文档'}；落点=第 ${p.cond ? p.cond.caretLine : '?'} 行第 ${p.cond ? p.cond.caretCol : '?'} 列（该行 ${p.cond ? p.cond.caretLineLen : '?'} 字符），视口 ${p.cond ? p.cond.viewportLines : '?'} 行 / 其中最长 ${p.cond ? p.cond.viewportMaxLen : '?'} 字符）`;
        const seqText = (rs) => rs.map((r) => `${r.p50}`).join(' / ');
        judge('7.8', 'perfLargeDocTyping', ok1 && ok2,
          `${(bigLen / 1048576).toFixed(2)} MB（sha256_16 ${bigSha}，真身 ✓：>20 万字符的行 ${hugeLineCount} 条；打开时引擎实载 ${loaded.len} 字符 ✓）连打 30 字符 × 两个条件 × **各 3 次取中位**：` +
          `① 视口无巨行 → 三次 p50 = ${seqText(runsBig)}，**中位 ${medBig}ms**；② 光标移到最长巨行（#${giantNo}）下一行、视口含巨行 → 三次 p50 = ${seqText(runsNear)}，**中位 ${medNear}ms**` +
          `（目标：两次条件的中位都 <20ms 且每次采样文档都未被换掉；首次样本细节：① ${condText(perfBig)}；② ${condText(perfNear)}）`,
          await shot('7.8-bigdoc.png'));
      }
    }

    // 1000 行大表：滚动帧间隔 + 表格外段落打字 + 格内输入（先热身 5 步，避免首触布局把读数带飞）
    await openDoc(TABLE1000, { head: '# 1000 行大表' });
    await sleep(1200);
    const scrollPerf = await ev(async () => {
      const v = window.mpEngine._view(); const sc = v.scrollDOM;
      const step = (i) => { sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * (i / 23); return new Promise((r) => requestAnimationFrame(() => r())); };
      for (let i = 0; i < 5; i++) await step(i);                 // 热身
      const gaps = []; let last = performance.now();
      for (let i = 5; i < 29; i++) { await step(i); const t = performance.now(); gaps.push(t - last); last = t; }
      const sorted = gaps.slice().sort((a, b) => a - b);
      return { max: Math.round(sorted[sorted.length - 1] * 10) / 10, p50: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10, n: gaps.length };
    });
    await instrument();
    const perfTable = await typeKeys(30);
    const cellType = await ev(async () => {
      const v = window.mpEngine._view();
      const td = v.contentDOM.querySelector('table.mp-row td[data-mp-row]');
      if (!td) return null;
      const r = td.getBoundingClientRect(); return { x: Math.round(r.x + 30), y: Math.round(r.y + r.height / 2) };
    });
    let cellRes = null;
    if (cellType) {
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cellType.x, y: cellType.y, button: 'left', clickCount: 1 });
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cellType.x, y: cellType.y, button: 'left', clickCount: 1 });
      await sleep(500);
      const p = await ev(() => { const el = document.querySelector('.mp-cell-overlay'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + 20), y: Math.round(r.y + r.height / 2) }; });
      if (p) {
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
        await sleep(200);
        const t0 = Date.now(); await page.keyboard.type('测试'); const t1 = Date.now();
        cellRes = { ms: t1 - t0 };
        await page.keyboard.press('Escape');
      }
    }
    judge('7.8', 'perfThousandRowTable', scrollPerf.p50 < 60 && scrollPerf.max < 400 && perfTable.p50 !== null && perfTable.p50 < 30,
      `1000 行表：滚动 ${scrollPerf.n} 帧（热身 5 帧后）p50=${scrollPerf.p50}ms max=${scrollPerf.max}ms；段落连打 30 字 p50=${perfTable.p50}ms p95=${perfTable.p95}ms；格内输入 2 字 ${cellRes ? cellRes.ms + 'ms' : '(覆盖层没出现)'}`,
      await shot('7.8-table1000.png'));

    // 结构文档（只判"在 + 成体系"：功能全表 + 重复实现清单两块，不抠字面）
    const archOk = fs.existsSync(ARCH);
    if (!archOk) judge('7.8', 'archDocExists', false, `不存在：${ARCH}`, '');
    else {
      const t = fs.readFileSync(ARCH, 'utf8');
      const lines = t.split('\n');
      const featIdx = lines.findIndex((l) => /^#{1,3}\s/.test(l) && /功能全表|功能表|12\s*类|功能清单|模块地图/.test(l));
      const dupIdx = lines.findIndex((l) => /^#{1,3}\s/.test(l) && /重复实现/.test(l));
      const rowsAfter = (idx) => { if (idx < 0) return 0; let n = 0; for (let i = idx + 1; i < lines.length; i++) { if (/^#{1,3}\s/.test(lines[i])) break; if (/^\s*\|.*\|/.test(lines[i]) && !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) n++; } return n; };
      const featRows = rowsAfter(featIdx);
      const dupRows = rowsAfter(dupIdx);
      const heads = lines.filter((l) => /^#{1,3}\s/.test(l)).length;
      const ok = featIdx >= 0 && dupIdx >= 0 && featRows >= 5 && dupRows >= 1;
      const featTxt = featIdx >= 0 ? `在第 ${featIdx + 1} 行（表内 ${featRows} 行）` : '没找到';
      const dupTxt = dupIdx >= 0 ? `在第 ${dupIdx + 1} 行（表内 ${dupRows} 行）` : '没找到';
      judge('7.8', 'archDocExists', ok,
        `${(fs.statSync(ARCH).size / 1024).toFixed(0)} KB / ${lines.length} 行 / ${heads} 个小节；功能全表节=${featTxt}；重复实现清单节=${dupTxt} ⇒ ${ok ? '文档在且成体系' : '不成体系（缺块或内容太少）'}`,
        '');
    }
  }

  /* ══════════ §7.1 最小夹具（行号）：三行围栏 + 引用区围栏，隔离复跑 + 2 倍图交 Lead ══════════ */
  if (want('7.1')) {
    try {
      const png64 = fs.readFileSync(SMALL).toString('base64');
      const fx = [
        '# 行号最小夹具',
        '',
        '以下三行围栏（空行也应有号，且每块从 1 起）：',
        '',
        '```js',
        'const a = 1;',
        '',
        'const b = 2;',
        '```',
        '',
        '引用区围栏（应有号；行尾文字「结尾甲」不该被吃）：',
        '',
        '> ```js',
        '> const q = 1;',
        '>',
        '> const r = 2;',
        '> ```',
        '',
        `图片在引用区（尾随字符对照）：> 前 ![小图](${'data:image/png;base64,' + png64})结尾甲`,
        '',
      ].join('\n');
      const fxPath = path.join(TMP, 'lineno-夹具.md');
      fs.mkdirSync(TMP, { recursive: true });
      fs.writeFileSync(fxPath, fx, 'utf8');
      const loaded = await openDoc(fxPath);
      if (!loaded.ok) judge('7.1', 'codeLineNumbers:miniFixture', null, `最小夹具没换成目标文档（实载 ${loaded.len} 字符，期望 ${loaded.expectLen}）⇒ 未验证`, '');
      else {
        await sleep(900);
        const info = await ev(() => {
          const v = window.mpEngine._view(); const d = v.state.doc;
          const all = [...v.contentDOM.children];
          const dump = all.map((el) => {
            const cls = String(el.className);
            const nums = [...el.querySelectorAll('*')].filter((x) => x.children.length === 0 && /^\d{1,3}$/.test((x.textContent || '').trim())).map((x) => ({ t: x.textContent.trim(), sel: x.tagName.toLowerCase() + '.' + String(x.className).split(/\s+/).filter(Boolean).join('.') }));
            return { cls, n: el.getAttribute('data-mp-n'), text: (el.textContent || '').slice(0, 40), nums: nums.slice(0, 6), numCount: nums.length };
          });
          return { rows: dump.filter((x) => /mp-code|mp-quote|mp-h/.test(x.cls)), attrCount: all.filter((x) => x.getAttribute('data-mp-n')).length, docLines: d.lines };
        });
        console.log('  · 最小夹具 DOM：' + JSON.stringify(info).slice(0, 900));
        /* 2 倍图：整段夹具区 */
        const rect = await ev(() => { const v = window.mpEngine._view(); const el = v.contentDOM; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: Math.min(560, r.height) }; });
        try {
          await client.send('Emulation.setDeviceMetricsOverride', { width: Math.round(viewport.width), height: Math.round(viewport.height), deviceScaleFactor: 2, mobile: false });
          await sleep(400);
          await page.screenshot({ path: path.join(SHOTS, '7.1-mini-2x.png'), clip: { x: Math.max(0, Math.floor(rect.x)), y: Math.max(0, Math.floor(rect.y)), width: Math.min(700, Math.ceil(rect.w)), height: Math.max(80, Math.ceil(rect.h)) }, timeout: 10000 });
          await client.send('Emulation.clearDeviceMetricsOverride');
          await sleep(300);
        } catch (e) { console.log('  2 倍图失败：' + String(e.message).slice(0, 60)); }
        const miniTxt = info.rows.map((r) => r.cls + '|n=' + r.n + '|«' + r.text.slice(0, 12) + '»').join(' ; ');
        const miniNums = info.rows.reduce((n, r) => n + r.numCount, 0);
        const contentLines = info.rows.filter((r) => /mp-code/.test(r.cls) && !/mp-fence/.test(r.cls));
        const numbered = contentLines.filter((r) => r.n).length;
        const seqOk = JSON.stringify(contentLines.filter((r) => !/mp-quote/.test(r.cls)).map((r) => r.n)) === JSON.stringify(['1', '2', '3']);
        const quoteOk = JSON.stringify(contentLines.filter((r) => /mp-quote/.test(r.cls)).map((r) => r.n)) === JSON.stringify(['1', '2', '3']);
        const okMini = numbered >= 6 && seqOk && quoteOk;
        judge('7.1', 'codeLineNumbers:miniFixture', okMini ? true : (numbered > 0 ? null : false),
          `最小夹具（整段可见，不受虚拟化影响）：带 data-mp-n 的元素 ${info.attrCount} 个；DOM 数字元素 ${miniNums} 个；内容行 ${contentLines.length} 条、其中带号 ${numbered} 条`
          + `；普通块序列=${JSON.stringify(contentLines.filter((r) => !/mp-quote/.test(r.cls)).map((r) => r.n))}、引用块序列=${JSON.stringify(contentLines.filter((r) => /mp-quote/.test(r.cls)).map((r) => r.n))}`
          + `（空行号=${(contentLines.find((r) => !r.text.trim()) || {}).n || '?'}）｜逐行=${miniTxt.slice(0, 500)}`,
          'accept\\out\\shots\\7.1-mini-2x.png');
      }
      /* 回到清单，免得影响后续条目 */
      await openDoc(MD);
      await sleep(600);
    } catch (e) { judge('7.1', 'codeLineNumbers:miniFixture', null, '异常：' + String(e.message).slice(0, 120), ''); }
  }

  /* 【证据·2026-10-09】把应用侧的保存留痕读进报告：实测本夹具在**跑动过程中**会被写成小残件
     （16:31:59 → 177 B、16:32:03 → 357 B，内容只有几十个「测」）。产品侧"自动保存写错路径"
     已被定点实验排除（开 A→开 B→在 B 打字 20 秒，A 全程未变、B 存回 B），所以需要这份留痕来判断
     到底是不是应用保存的、写的是哪条路径、多少字节。 */
  let dbgSave = null;
  try { dbgSave = await ev(() => (window.__mpDbg && window.__mpDbg.saveTrace) || null); } catch { }

  fs.writeFileSync(path.join(DIR, 'report-310.json'), JSON.stringify({
    exe: EXE, at: new Date().toISOString(), exeSize: fs.statSync(EXE).size,
    exeSha256_16: crypto.createHash('sha256').update(fs.readFileSync(EXE)).digest('hex').slice(0, 16),
    appVersion: appInfo.version || null, appName: appInfo.name || null,
    dbgSave,
    results: results.map((r) => ({ id: r.id, title: (SPECS[r.id] || {}).title || '', ok: r.ok, detail: `[${r.check}] ${r.detail}`, evidence: r.evidence })),
  }, null, 1), 'utf8');
  console.log('\n· §7 报告 =', path.join(DIR, 'report-310.json'));
  try { await browser.close(); } catch { }
  killTree();
  await sleep(1200);
  process.exit(0);
  /* ══ §7.2 的"默认图片策略"检查：**刻意放在最后** ══════════════════════════════════
     它要清偏好并**重载引擎页**才能量到"首次启动的默认值"。放在中间会把后续项的
     顶层窗口基线、文档状态全部扰动（全量跑出现 7.6 找不到对话框、7.8 帧耗时 1000ms 的假红）。
     放在最后：全量跑时副作用无人可扰；`--only=7.2` 时照常执行。 */
    /* 【默认策略口径·2026-10-09 定稿】清掉偏好 → **重载引擎页** → 引擎启动时会按设计把默认值写进
       localStorage（extras.js：setImageModePref(imageModePref())，注释写明"偏好项必须可见"）
       ⇒ 读到的就是"首次启动的默认策略"。比点设置面板稳（面板入口在「更多」菜单里，探针环境弹不稳）。 */
    const defProbe = await ev(() => { try { localStorage.removeItem("mp-image-mode"); } catch { } return { cleared: (() => { try { return localStorage.getItem("mp-image-mode") === null; } catch { return false; } })() }; });
    let reloaded = false;
    try {
      await client.send("Page.reload", { ignoreCache: false });
      for (let k = 0; k < 60; k++) {
        await sleep(500);
        const up = await ev(() => { try { return !!(window.mpEngine && window.mpEngine._view() && window.mpEngine._view().state.doc.length >= 0); } catch { return false; } }).catch(() => false);
        if (up) { reloaded = true; break; }
      }
      await sleep(800);
    } catch { }
    const stratAfterBoot = await ev(() => { try { return localStorage.getItem("mp-image-mode"); } catch { return "n/a"; } }).catch(() => "n/a");
    if (want("7.2")) {
      /* 默认图片策略由 inline 改为 assets（依据：主流编辑器无一默认 inline；GitHub/GitLab 剥离 data: 图；
         内联会把截图变成单行长 40~270 万字符）。判据随之翻转。 */
      judge("7.2", "imageStrategyDefault", reloaded && stratAfterBoot === "assets",
        `清掉 mp-image-mode（${defProbe.cleared ? "已清" : "清不掉"}）→ 重载引擎（${reloaded ? "已就绪" : "超时"}）→ 引擎启动写下的默认 = ${stratAfterBoot}（期望 assets；inline 仍是可选项）`,
        "");
    }

})().catch((e) => { console.error('✗ §7 执行器异常：', e && e.stack || e); process.exit(1); });
