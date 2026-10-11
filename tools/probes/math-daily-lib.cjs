/** math-daily 族**共用尺子**（AGENTS 错-4：同功能的实现只许一份）
 *
 *  纪律落地：
 *   · 错-7①：一组相关读数**一次 evaluate 拿全** —— snap() 是唯一读数入口（文档+选区+DOM+光标矩形+浮层+每行）；
 *   · 错-7③：不关页面/窗口；收场只用 taskkill（主进程事实）；页面被外部杀掉时 reboot 换 profile 重来；
 *   · 错-1：探针先打尺子卡（产物 sha16 + 夹具 sha16），MP_EXPECT_EXE 设了就拦，不符 exit(9)；
 *   · 输入一律真实通道：page.mouse / page.keyboard（CDP Input.*），拖拽＝按下→多次移动→抬起。
 *   · 判据读**最终状态**（doc / anchor-head / 光标矩形 / DOM 文本 / 焦点），不读"我调用了什么"。
 *
 *  用法（三行接入）：
 *    const L = require('./math-daily-lib.cjs');
 *    const S = await L.boot({ probe: 'math-daily-r1.cjs', dir: 'r1', exe: process.argv[2] });
 *    ... await S.guard('A1', async () => { ... }) ... await S.finish(0);
 */
'use strict';
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
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
const { chromium } = require('C:/Windows/System32/node_modules/playwright-core');
const RULER = require(path.join(__dirname, '_probe-common.cjs'));

const OUT = path.join(__MP_WORK, 'math-daily-out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isClosedErr = (e) => /has been closed|Target closed|Session closed|browser has been closed|Connection closed/i.test(String((e && e.message) || e));

/** 族夹具（唯一真源；各支探针都从这里取，保证跨支读数可比）。
 *  行号（1-based）固定：3=行内公式 / 5-7=单行块 / 11-16=多行块 / 18=中文紧贴行内公式 / 20=纯 ASCII 列参考行 */
const FIXTURE = () => String.raw`# 公式日常

行内公式 $E=mc^2$ 在句子里。

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

多行公式：

$$
\begin{aligned}
a &= b + c \\
d &= e + f
\end{aligned}
$$

中文紧贴$x+a$紧贴中文，后面还有字。

ABCDEFGHIJKLMNOPQRSTUVWXYZ 列参考行。
`;

/** 端口必须**真空闲**：固定端口若被残留/别腿实例占着，connectOverCDP 会连到别人窗口（本仓踩过）。 */
function pickPort() {
  const used = new Set();
  try {
    const out = execSync('netstat -ano -p tcp', { windowsHide: true, encoding: 'utf8' });
    for (const m of out.matchAll(/:(\d+)\s+\S+\s+LISTENING/gi)) used.add(Number(m[1]));
  } catch { /* 拿不到 netstat 就退回随机 */ }
  for (let i = 0; i < 400; i++) {
    const p = 14800 + ((process.pid * 11 + i * 17) % 1500);
    if (!used.has(p)) return p;
  }
  return 14800 + (process.pid % 1500);
}

async function ev(page, fn, arg) {
  const r = await Promise.race([
    page.evaluate(fn, arg).then((v) => ({ v }), (e) => ({ err: String((e && e.message) || e).slice(0, 200) })),
    sleep(9000).then(() => ({ err: 'evaluate 超时 9s' })),
  ]);
  if (r.err) throw new Error('evaluate 失败：' + r.err);
  return r.v;
}

/* ── 一次性读数（唯一入口）：同一函数里取完再返回，禁止跨 evaluate 拼装 ────────────── */
function snapFn() {
  const v = window.mpEngine._view();
  const doc = v.state.doc.toString();
  const sel = v.state.selection.main;
  const from = Math.min(sel.anchor, sel.head), to = Math.max(sel.anchor, sel.head);
  const hl = v.state.doc.lineAt(sel.head);
  const r2 = (r) => (r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null);
  const content = document.querySelector('.cm-content');
  const lines = [...document.querySelectorAll('.cm-content .cm-line')].map((el) => ({
    text: String(el.textContent || '').slice(0, 56),
    cls: String(el.className || ''),
    isMathSrc: el.classList.contains('mp-math-src'),
    nWidget: el.querySelectorAll('.mp-cm6-math, .mp-cm6-math-block, .mp-cm6-math-live-chip').length,
    rect: r2(el.getBoundingClientRect()),
  }));
  const widgets = [...document.querySelectorAll('.cm-content .mp-cm6-math, .cm-content .mp-cm6-math-block, .cm-content .mp-cm6-math-live-chip')].map((el) => ({
    cls: String(el.className || ''),
    kind: el.classList.contains('mp-cm6-math-block') ? 'block' : 'inline',
    live: el.classList.contains('mp-cm6-math-live') || el.classList.contains('mp-cm6-math-live-chip'),
    selected: el.classList.contains('mp-math-selected'),
    katex: !!el.querySelector('.katex'),
    glyph: String(el.textContent || '').replace(/\s+/g, ' ').slice(0, 40),
    rect: r2(el.getBoundingClientRect()),
  }));
  const floats = [...document.querySelectorAll('.cm-content .mp-inline-float, .cm-editor .mp-inline-float')].map((el) => ({
    display: el.classList.contains('mp-inline-float-display'),
    from: el.dataset.mpFrom || null, to: el.dataset.mpTo || null, texFrom: el.dataset.mpTexFrom || null,
    glyph: String(el.textContent || '').replace(/\s+/g, ' ').slice(0, 40),
    katex: !!el.querySelector('.katex'), rect: r2(el.getBoundingClientRect()),
  }));
  const cur = document.querySelector('.cm-cursor-primary') || document.querySelector('.cm-cursor');
  const dsel = window.getSelection();
  const sc = document.querySelector('.cm-scroller');
  const toast = document.querySelector('.mp-toast');
  let selRects = [];
  try { selRects = [...document.querySelectorAll('.cm-selectionBackground')].map((e) => r2(e.getBoundingClientRect())); } catch { /* 忽略 */ }
  return {
    doc, docLen: doc.length, docLines: v.state.doc.lines,
    anchor: sel.anchor, head: sel.head, emptySel: sel.empty,
    selFrom: from, selTo: to, selText: doc.slice(from, to),
    headLine: hl.number, headCol: sel.head - hl.from, headLineText: hl.text,
    focusInContent: !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.cm-content')),
    activeEl: document.activeElement ? String(document.activeElement.className || document.activeElement.tagName).slice(0, 48) : null,
    hasFocus: document.hasFocus(), viewHasFocus: !!v.hasFocus,
    cursorRect: r2(cur ? cur.getBoundingClientRect() : null),
    domSel: dsel ? {
      text: String(dsel.toString()).slice(0, 48), collapsed: dsel.isCollapsed,
      anchorOffset: dsel.anchorOffset, focusOffset: dsel.focusOffset, rangeCount: dsel.rangeCount,
      inContent: !!(dsel.anchorNode && content && content.contains(dsel.anchorNode)),
    } : null,
    selRects, scrollTop: sc ? Math.round(sc.scrollTop) : null,
    lines, widgets, floats, nWidgets: widgets.length, nFloats: floats.length,
    nKatex: widgets.filter((w) => w.katex).length + floats.filter((f) => f.katex).length,
    nMathSrcLine: lines.filter((l) => l.isMathSrc).length,
    toast: toast && toast.style.display !== 'none' && String(toast.textContent || '').trim() ? String(toast.textContent).trim() : null,
    composing: !!v.composing,
    /* 数学/块补全菜单（源码内键入 `\` 会弹；打开时 ↑/↓/Enter 被它吃掉 —— 源码内方向键必须先排除它） */
    complete: (() => {
      const b = document.querySelector('.mp-complete');
      if (!b || b.style.display === 'none') return null;
      const act = b.querySelector('.is-active');
      return { items: b.querySelectorAll('.mp-complete-item').length, active: act ? String(act.textContent || '').slice(0, 24) : null, rect: r2(b.getBoundingClientRect()) };
    })(),
    pageScale: document.documentElement.clientWidth,
  };
}

async function boot({ probe, dir, exe, docText }) {
  const DIR = path.join(OUT, dir);
  const DOC = path.join(DIR, 'doc.md');
  const SHOTS = path.join(DIR, 'shots');
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const TEXT = docText || FIXTURE();
  fs.writeFileSync(DOC, TEXT, 'utf8');
  RULER.rulerCard({ probe, exe, doc: DOC, extra: { out: DIR } });
  RULER.assertExe(exe);

  const log = [];
  sink = log;
  const errs = [], cerrs = [];
  const state = { child: null, browser: null, ctx: null, page: null, profile: null, boots: 0, port: null, killedExternally: 0 };

  async function launch() {
    state.boots++;
    const profile = path.join(DIR, state.boots === 1 ? 'profile' : 'profile-r' + state.boots);
    fs.rmSync(profile, { recursive: true, force: true });
    fs.mkdirSync(profile, { recursive: true });
    state.profile = profile;
    const PORT = pickPort();
    state.port = PORT;
    const env = { ...process.env, MP_DEBUG: '1' }; delete env.ELECTRON_RUN_AS_NODE;
    state.child = spawn(exe, [DOC, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], { env, stdio: 'ignore' });
    let browser = null;
    for (let i = 0; i < 60 && !browser; i++) { await sleep(1000); try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { } }
    if (!browser) throw new Error('CDP 连不上（端口 ' + PORT + '，第 ' + state.boots + ' 次启动）');
    state.browser = browser;
    const ctx = browser.contexts()[0];
    state.ctx = ctx;
    let page = null;
    for (let i = 0; i < 90 && !page; i++) {
      for (const p of ctx.pages().filter((x) => !x.url().startsWith('devtools://'))) {
        const ok = await p.evaluate(() => { try { return !!(window.mpEngine && window.mpEngine._view && window.mpEngine._view()); } catch { return false; } }).catch(() => false);
        if (ok) { page = p; break; }
      }
      if (!page) await sleep(500);
    }
    if (!page) throw new Error('找不到引擎页');
    state.page = page;
    page.on('pageerror', (e) => errs.push(String((e && e.message) || e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') cerrs.push(String(m.text()).slice(0, 200)); });
    /* 取证监听：copy 事件**冒泡到 document** 时读 clipboardData（此刻产品处理器已经写完载荷）。
       capture 相只记 defaultPrevented（capture 早于产品写入，读不到内容——两相都留，便于判读时机）。 */
    await page.evaluate(() => {
      window.__copyLog = [];
      const grab = (e) => { let p = '', h = ''; try { p = String(e.clipboardData ? e.clipboardData.getData('text/plain') : ''); } catch { } try { h = String(e.clipboardData ? e.clipboardData.getData('text/html') : ''); } catch { } return { p, h }; };
      document.addEventListener('copy', (e) => { window.__copyLog.push({ phase: 'capture', prevented: e.defaultPrevented, types: e.clipboardData ? [...e.clipboardData.types] : [] }); }, true);
      document.addEventListener('copy', (e) => { const g = grab(e); window.__copyLog.push({ phase: 'bubble', prevented: e.defaultPrevented, plain: g.p, html: g.h, types: e.clipboardData ? [...e.clipboardData.types] : [] }); }, false);
      /* 剪切是**另一个事件名**（cut）：不挂的话 Ctrl+X 的载荷永远读不到（本轮 D7 踩过） */
      document.addEventListener('cut', (e) => { const g = grab(e); window.__copyLog.push({ phase: 'cut-capture', prevented: e.defaultPrevented }); window.__cutLog = window.__cutLog || []; window.__cutLog.push({ prevented: e.defaultPrevented, plain: g.p, html: g.h, types: e.clipboardData ? [...e.clipboardData.types] : [] }); }, false);
      /* 鼠标事件轨迹（判"原生选区 vs CM 状态选区"分叉的唯一一手证据） */
      window.__mouseLog = [];
      for (const t of ['mousedown', 'mouseup', 'dblclick']) {
        document.addEventListener(t, (e) => {
          let st = '?', dom = '?';
          try { const v = window.mpEngine._view(); const s = v.state.selection.main; st = s.empty ? 'empty@' + s.head : s.from + '-' + s.to; } catch { }
          try { dom = String(window.getSelection().toString()).slice(0, 40); } catch { }
          window.__mouseLog.push({ t, x: e.clientX, y: e.clientY, state: st, dom });
        }, true);
      }
    }).catch(() => { });
    await sleep(2500);
  }

  const killChild = () => { try { execSync(`taskkill /PID ${state.child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { } };
  await launch();

  const api = {
    DOC, DIR, SHOTS, errs, cerrs, log, sleep, TEXT,
    get page() { return state.page; },
    get ctx() { return state.ctx; },
    get child() { return state.child; },
    get profile() { return state.profile; },
    get boots() { return state.boots; },
    kill: killChild,
    ev: (fn, arg) => ev(state.page, fn, arg),
    snap: () => ev(state.page, snapFn),
    alive: async () => ev(state.page, () => 1).then(() => true, () => false),
    reboot: async (why) => {
      log.push({ case: 'REBOOT', why: String(why || '').slice(0, 160), at: new Date().toISOString(), boots: state.boots + 1 });
      console.log('[REBOOT] ' + String(why || '').slice(0, 160));
      killChild();
      await sleep(2000);
      fs.writeFileSync(DOC, TEXT, 'utf8');
      await launch();
      return { rebooted: true, boots: state.boots };
    },
    guard: async (id, fn) => {
      try {
        if (!(await api.alive())) await api.reboot(id + ' 用例前页面已关闭');
        return await fn();
      } catch (e) {
        if (!isClosedErr(e)) throw e;
        state.killedExternally++;
        await api.reboot(id + ' 用例中页面被关闭：' + String((e && e.message) || e).slice(0, 120));
        return await fn();
      }
    },
    /** 幂等前置断言：读数必须是**真夹具**，不是默认回退值（否则拒出数） */
    assertFixture: async (opts = {}) => {
      const s = await ev(state.page, snapFn);
      const need = opts.marks || ['$E=mc^2$', '中文紧贴$x+a$紧贴中文', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
      const miss = need.filter((m) => !s.doc.includes(m));
      const ok = !miss.length && s.docLen === api.TEXT.length && (!opts.minWidgets || s.nWidgets >= opts.minWidgets);
      if (!ok) throw new Error('读数像回退值：' + JSON.stringify({ docLen: s.docLen, want: api.TEXT.length, miss, nWidgets: s.nWidgets, head: s.doc.slice(0, 40) }));
      return s;
    },
    /** 文档坐标 → 视口点（真实鼠标点击用） */
    posXY: (pos, dx = 0, dy = 0) => ev(state.page, ({ p, dx, dy }) => {
      const v = window.mpEngine._view();
      const q = Math.max(0, Math.min(p, v.state.doc.length));
      const c = v.coordsAtPos(q);
      if (!c) return null;
      return { x: Math.round(c.left + dx), y: Math.round((c.top + c.bottom) / 2 + dy), top: Math.round(c.top), bottom: Math.round(c.bottom) };
    }, { p: pos, dx, dy }),
    clickPos: async (pos, dx = 0, dy = 0) => {
      const xy = await api.posXY(pos, dx, dy);
      if (!xy) throw new Error('pos ' + pos + ' 取不到坐标');
      await state.page.mouse.click(xy.x, xy.y);
      await sleep(450);
      return xy;
    },
    /** 点渲染态公式 widget：selector 命中第 idx 个，按横向比例 fx 取点 */
    clickWidget: async (selector, idx = 0, fx = 0.5, fy = 0.5) => {
      const b = await ev(state.page, ({ s, i, fx, fy }) => {
        const els = [...document.querySelectorAll(s)];
        const el = els[i];
        if (!el) return { n: els.length, box: null };
        const r = el.getBoundingClientRect();
        return { n: els.length, box: { x: Math.round(r.left + r.width * fx), y: Math.round(r.top + r.height * fy), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }, cls: String(el.className) };
      }, { s: selector, i: idx, fx, fy });
      if (!b.box) throw new Error('点不到 widget：' + selector + ' 第 ' + idx + ' 个（共 ' + b.n + '）');
      await state.page.mouse.click(b.box.x, b.box.y);
      await sleep(500);
      return b;
    },
    /** 真实拖拽选区：按下 → 多次移动 → 抬起（不许一次跳） */
    dragSelect: async (fromPos, toPos, steps = 6) => {
      const a = await api.posXY(fromPos), b = await api.posXY(toPos);
      if (!a || !b) throw new Error('拖拽端点取不到坐标');
      await state.page.mouse.move(a.x, a.y);
      await state.page.mouse.down();
      for (let i = 1; i <= steps; i++) {
        await state.page.mouse.move(Math.round(a.x + (b.x - a.x) * i / steps), Math.round(a.y + (b.y - a.y) * i / steps));
        await sleep(40);
      }
      await state.page.mouse.up();
      await sleep(400);
      return { a, b };
    },
    key: async (k, ms = 260) => { await state.page.keyboard.press(k); await sleep(ms); },
    keySeq: async (keys, ms = 200) => { for (const k of keys) { await state.page.keyboard.press(k); await sleep(ms); } },
    type: async (t, ms = 450) => { await state.page.keyboard.type(t); await sleep(ms); },
    copyLog: () => ev(state.page, () => { const l = window.__copyLog || []; window.__copyLog = []; return l; }),
    cutLog: () => ev(state.page, () => { const l = window.__cutLog || []; window.__cutLog = []; return l; }),
    mouseLog: () => ev(state.page, () => { const l = window.__mouseLog || []; window.__mouseLog = []; return l; }),
    clearCopyLog: () => ev(state.page, () => { window.__copyLog = []; window.__cutLog = []; window.__mouseLog = []; return true; }),
    /** 剪贴板三级读数：① 页内 copy 事件载荷（产品写入物）② 渲染侧 navigator ③ 系统剪贴板（主进程外） */
    clipReadAll: async () => {
      const pageSide = await ev(state.page, async () => {
        let t = '', err = null;
        try { t = String(await navigator.clipboard.readText()).slice(0, 120); } catch (e) { err = String((e && e.message) || e).slice(0, 80); }
        return { text: t, err };
      }).catch((e) => ({ text: '', err: 'eval:' + String(e.message).slice(0, 40) }));
      return { 渲染侧: pageSide, 系统剪贴板: api.psGetClip().slice(0, 200) };
    },
    psGetClip: () => {
      const f = path.join(DIR, 'clip-read.txt');
      try {
        execSync(`pwsh -NoProfile -Command "try{ [IO.File]::WriteAllText('${f.replace(/\\/g, '/')}', (Get-Clipboard -Raw)) }catch{ [IO.File]::WriteAllText('${f.replace(/\\/g, '/')}', '##ERR##'+$_.Exception.Message) }"`, { windowsHide: true, stdio: 'ignore' });
        return fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
      } catch { return ''; }
    },
    shot: async (name, sel) => {
      const file = path.join(SHOTS, name + '.png');
      try {
        let clip = undefined;
        if (sel) {
          const b = await ev(state.page, (s) => {
            const el = document.querySelector(s);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.max(0, Math.floor(r.left - 40)), y: Math.max(0, Math.floor(r.top - 60)), width: Math.ceil(r.width + 80), height: Math.ceil(r.height + 120) };
          }, sel);
          if (b) clip = b;
        }
        await state.page.screenshot({ path: file, clip });
        return file;
      } catch (e) { return 'ERR ' + String((e && e.message) || e).slice(0, 60); }
    },
    /** 整屏 + 只在正文视口内裁一刀（视觉取证） */
    shotViewport: async (name) => {
      const file = path.join(SHOTS, name + '.png');
      try { await state.page.screenshot({ path: file }); return file; } catch (e) { return 'ERR ' + String((e && e.message) || e).slice(0, 60); }
    },
    /** 把某条读数里的关键坐标连同光标标记一起标出来：返回构造好的 SVG 描述（供报告用；绘制在壳外） */
    measure: (pos) => ev(state.page, (p) => {
      const v = window.mpEngine._view();
      const q = Math.max(0, Math.min(p, v.state.doc.length));
      const s = v.state.doc.lineAt(q);
      const c = v.coordsAtPos(q);
      return { pos: q, line: s.number, col: q - s.from, lineText: s.text, x: c ? Math.round(c.left) : null, y: c ? Math.round((c.top + c.bottom) / 2) : null, top: c ? Math.round(c.top) : null, bottom: c ? Math.round(c.bottom) : null };
    }, pos),
    dbgTail: (n = 14) => {
      try {
        const f = path.join(state.profile, 'main-debug.log');
        if (!fs.existsSync(f)) return ['(无 main-debug.log)'];
        return fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).slice(-n);
      } catch (e) { return ['(读日志失败 ' + String((e && e.message) || e) + ')']; }
    },
    finish: async (code = 0) => {
      fs.writeFileSync(path.join(DIR, 'result.json'), JSON.stringify({ probe, exeSha16: RULER.sha16(exe), doc: DOC, fixtureSha16: RULER.sha16(DOC), log, errs, cerrs, boots: state.boots, 外部中断次数: state.killedExternally }, null, 1), 'utf8');
      console.log('落盘：' + path.join(DIR, 'result.json'));
      try { await state.browser.close(); } catch { }
      killChild();
      process.exit(code);
    },
  };
  return api;
}

let sink = null;
function log(caseId, data) {
  const row = { case: caseId, ...data };
  if (sink) sink.push(row);
  console.log('[' + caseId + '] ' + JSON.stringify(data));
  return row;
}

module.exports = { boot, log, sleep, snapFn, OUT, isClosedErr, FIXTURE };
