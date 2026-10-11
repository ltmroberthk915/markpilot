/** table-daily 族**共用尺子**（AGENTS 错-4：同功能的实现只许一份）
 *
 *  纪律落地：
 *   · 错-7①：一组相关读数**一次 evaluate 拿全** —— snap() 是唯一读数入口；
 *   · 错-7③：不关页面/窗口；收场只用 taskkill（主进程事实）；
 *   · 错-1：探针先打尺子卡（产物 sha16 + 夹具 sha16），MP_EXPECT_EXE 设了就拦；
 *   · 输入一律真实通道：page.mouse / page.keyboard（CDP Input.*），剪贴板用 OS 剪贴板 + 真 Ctrl+V。
 *
 *  【并发实测·2026-10-10】本仓此刻有十几个探针族并行跑同一个 exe。实测 09:04:11 有**外部
 *  taskkill /IM MarkPilot.exe**（同分钟另一个族的 window-states/crash.txt 记下同一条
 *  "Target page, context or browser has been closed"）⇒ 本 lib 提供 alive() / reboot()：
 *  页面被外部杀掉时**换 profile 重启**并把夹具写回 pristine，用例可继续；reboot 次数进读数。
 *
 *  用法（三行接入）：
 *    const L = require('./table-daily-lib.cjs');
 *    const S = await L.boot({ probe: 'table-daily-keys.cjs', dir: 'keys', exe: process.argv[2], docText });
 *    ... await S.guard('K1', async () => { ... }) ... await S.finish(0);
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

const OUT = path.join(__MP_WORK, 'table-daily-out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isClosedErr = (e) => /has been closed|Target closed|Session closed|browser has been closed|Connection closed/i.test(String((e && e.message) || e));

/** 端口必须**真空闲**：固定端口若被残留/别腿实例占着，connectOverCDP 会连到别人窗口（本仓踩过）。 */
function pickPort() {
  const used = new Set();
  try {
    const out = execSync('netstat -ano -p tcp', { windowsHide: true, encoding: 'utf8' });
    for (const m of out.matchAll(/:(\d+)\s+\S+\s+LISTENING/gi)) used.add(Number(m[1]));
  } catch { /* 拿不到 netstat 就退回随机 */ }
  for (let i = 0; i < 400; i++) {
    const p = 13600 + ((process.pid * 7 + i * 13) % 1200);
    if (!used.has(p)) return p;
  }
  return 13600 + (process.pid % 1200);
}

/** 每次 evaluate 都带超时的包装：CDP 会话被拆时给出**明确**失败，而不是静默 undefined。 */
async function ev(page, fn, arg) {
  const r = await Promise.race([
    page.evaluate(fn, arg).then((v) => ({ v }), (e) => ({ err: String((e && e.message) || e).slice(0, 140) })),
    sleep(8000).then(() => ({ err: 'evaluate 超时 8s' })),
  ]);
  if (r.err) throw new Error('evaluate 失败：' + r.err);
  return r.v;
}

/* ── 一次性读数（唯一入口）────────────────────────────────────────────────
 *  所有字段在**同一个函数**里取完再返回：禁止跨 evaluate 拼装（错-7①）。 */
function snapFn() {
  const v = window.mpEngine._view();
  const doc = v.state.doc.toString();
  const sel = v.state.selection.main;
  const hl = v.state.doc.lineAt(sel.head);
  const edit = document.querySelector('.mp-row .mp-cell-editing');
  const ovBox = document.querySelector('.mp-cell-overlay');
  const ovText = document.querySelector('.mp-cell-overlay-text');
  const toast = document.querySelector('.mp-toast');
  const dsel = window.getSelection();
  const rows = [...document.querySelectorAll('.mp-row')].map((t, i) => {
    const cs = [...t.querySelectorAll('th,td')];
    const first = cs[0];
    return {
      i, kind: t.querySelector('th') ? 'th' : 'td',
      n: cs.length,
      rowFrom: first && first.dataset ? Number(first.dataset.mpRow) : null,
      cells: cs.map((c) => String(c.textContent == null ? '' : c.textContent).trim().slice(0, 24)),
      phantom: cs.filter((c) => c.dataset && c.dataset.mpPhantom === '1').length,
    };
  });
  const ovVisible = !!(ovBox && ovBox.style.display !== 'none');
  const lineOf = (pos) => { try { const l = v.state.doc.lineAt(pos); return { n: l.number, from: l.from, text: l.text }; } catch { return null; } };
  return {
    doc,
    docLen: doc.length,
    docLines: v.state.doc.lines,
    head: sel.head, anchor: sel.anchor, emptySel: sel.empty,
    selText: v.state.doc.sliceString(Math.min(sel.anchor, sel.head), Math.max(sel.anchor, sel.head)),
    headLine: hl.number, headCol: sel.head - hl.from, headText: hl.text,
    headLineIsTable: /^\s*>*\s*\|/.test(hl.text),
    active: edit ? {
      rowFrom: Number(edit.dataset.mpRow), col: Number(edit.dataset.mpCol),
      lineNo: lineOf(Number(edit.dataset.mpRow)) ? lineOf(Number(edit.dataset.mpRow)).n : null,
      srcText: lineOf(Number(edit.dataset.mpRow)) ? lineOf(Number(edit.dataset.mpRow)).text : null,
      domText: edit.innerHTML,
    } : null,
    overlay: { visible: ovVisible, text: ovText ? ovText.textContent : null },
    focus: document.activeElement ? String(document.activeElement.className || document.activeElement.tagName).slice(0, 40) : null,
    hasFocus: document.hasFocus(),
    domSel: dsel ? { text: String(dsel.toString()).slice(0, 24), collapsed: dsel.isCollapsed, off: dsel.anchorOffset, inOverlay: !!(ovText && dsel.anchorNode && ovText.contains(dsel.anchorNode)) } : null,
    toast: toast && toast.style.display !== 'none' && String(toast.textContent || '').trim() ? String(toast.textContent).trim() : null,
    rows,
    rowCount: rows.length,
    tables: [...document.querySelectorAll('.mp-table-wrap')].length,
    /* 【2026-10-10 复跑加固】粘贴事件的**载荷**＝本次 Ctrl+V 真正交付给产品的内容（粘贴事件的 clipboardData
       是原子读数：它读的就是按键那一瞬的系统剪贴板）。多族并行时系统剪贴板会被邻族抢占，只有带上它才能
       证明"这一发粘贴粘的确实是我要粘的东西"。同一次 evaluate 里取，避免与终态读数错位（错-7①）。 */
    pasteLog: (window.__pasteLog || []).slice(-4),
  };
}

async function boot({ probe, dir, exe, docText }) {
  const DIR = path.join(OUT, dir);
  const DOC = path.join(DIR, 'doc.md');
  const SHOTS = path.join(DIR, 'shots');
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(DOC, docText, 'utf8');
  RULER.rulerCard({ probe, exe, doc: DOC, extra: { out: DIR } });
  RULER.assertExe(exe);

  const log = [];
  sink = log;                       // L.log() 的落点（否则 result.json 会是空壳 —— 实测踩过）
  const errs = [], cerrs = [];
  const state = { child: null, browser: null, ctx: null, page: null, profile: null, boots: 0, port: null, killedExternally: 0 };

  /** 起一个实例并连上 CDP（每次 reboot 换一个 profile 目录，避免残留 lockfile） */
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
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => { });
    let page = null;
    for (let i = 0; i < 90 && !page; i++) {
      for (const p of ctx.pages().filter((x) => !x.url().startsWith('devtools://'))) {
        const ok = await p.evaluate(() => { try { return !!(window.mpEngine && window.mpExtras); } catch { return false; } }).catch(() => false);
        if (ok) { page = p; break; }
      }
      if (!page) await sleep(500);
    }
    if (!page) throw new Error('找不到引擎页');
    state.page = page;
    page.on('pageerror', (e) => errs.push(String((e && e.message) || e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') cerrs.push(String(m.text()).slice(0, 200)); });
    await page.evaluate(() => {
      window.__pasteLog = [];
      document.addEventListener('paste', (e) => {
        window.__pasteLog.push({
          prevented: e.defaultPrevented,
          plain: String(e.clipboardData ? e.clipboardData.getData('text/plain') : '').slice(0, 60),
          html: !!(e.clipboardData && e.clipboardData.getData('text/html')),
        });
      }, true);
    }).catch(() => { });
    await sleep(2500);
  }

  const killChild = () => { try { execSync(`taskkill /PID ${state.child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { } };

  await launch();

  const api = {
    DOC, DIR, SHOTS, errs, cerrs, log, sleep,
    get page() { return state.page; },
    get ctx() { return state.ctx; },
    get child() { return state.child; },
    get profile() { return state.profile; },
    get boots() { return state.boots; },
    kill: killChild,
    ev: (fn, arg) => ev(state.page, fn, arg),
    snap: () => ev(state.page, snapFn),
    alive: async () => { const r = await ev(state.page, () => 1).then(() => true, () => false); return r; },
    /** 页面被外部杀掉时重启（换 profile；夹具写回 pristine），返回 {rebooted, boots} */
    reboot: async (why) => {
      log.push({ case: 'REBOOT', why: String(why || '').slice(0, 160), at: new Date().toISOString(), boots: state.boots + 1 });
      console.log('[REBOOT] ' + String(why || '').slice(0, 160));
      killChild();
      await sleep(2000);
      fs.writeFileSync(DOC, docText, 'utf8');       // 夹具复位（autosave 可能已改过盘上文件）
      await launch();
      return { rebooted: true, boots: state.boots };
    },
    /** 用例护栏：页面死了就重启并**重跑一次**该用例；两次都死就记为"外部中断未验证" */
    guard: async (id, fn) => {
      try {
        if (!(await api.alive())) await api.reboot(id + ' 用例前页面已关闭');
        return await fn();
      } catch (e) {
        if (!isClosedErr(e) && !(await api.alive().catch(() => false))) { /* 落到下面的重启分支 */ }
        else if (!isClosedErr(e)) throw e;
        state.killedExternally++;
        await api.reboot(id + ' 用例中页面被关闭：' + String((e && e.message) || e).slice(0, 120));
        return await fn();       // 重跑一次（reboot 后夹具已是 pristine）
      }
    },
    /** 幂等断言：读数里必须是"真夹具"而不是回退值（expect.minRows 只有表格族夹具才给） */
    assertFixture: async (expect) => {
      const s = await ev(state.page, snapFn);
      const ok = s.doc.includes(expect.line) && s.docLen > 0 && (!expect.minRows || s.rowCount >= expect.minRows);
      if (!ok) throw new Error('读数像回退值：' + JSON.stringify({ docLen: s.docLen, rowCount: s.rowCount, head: s.head, doc: s.doc.slice(0, 40) }));
      return s;
    },
    cellXY: async (rowIdx, colIdx) => ev(state.page, ({ r, c }) => {
      const t = document.querySelectorAll('.mp-row')[r];
      if (!t) return null;
      const cell = t.querySelectorAll('th,td')[c];
      if (!cell) return null;
      const b = cell.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: Math.round(b.width), h: Math.round(b.height), rowFrom: Number(cell.dataset.mpRow), col: Number(cell.dataset.mpCol), text: String(cell.textContent || '').trim() };
    }, { r: rowIdx, c: colIdx }),
    clickCell: async (rowIdx, colIdx) => {
      const xy = await api.cellXY(rowIdx, colIdx);
      if (!xy) throw new Error('找不到渲染格 ' + rowIdx + '/' + colIdx);
      await state.page.mouse.click(xy.x, xy.y);
      await sleep(500);
      return xy;
    },
    pointAtDocPos: async (pos) => ev(state.page, (p) => {
      const v = window.mpEngine._view();
      const c = v.coordsAtPos(Math.max(0, Math.min(p, v.state.doc.length)));
      if (!c) return null;
      return { x: Math.round(c.left + 4), y: Math.round((c.top + c.bottom) / 2) };
    }, pos),
    clickDocLine: async (lineNo) => {
      const p = await ev(state.page, (n) => {
        const v = window.mpEngine._view();
        const l = v.state.doc.line(n);
        const c = v.coordsAtPos(l.from);
        return c ? { x: Math.round(c.left + 3), y: Math.round((c.top + c.bottom) / 2), from: l.from, text: l.text } : null;
      }, lineNo);
      if (!p) throw new Error('第 ' + lineNo + ' 行取不到坐标');
      await state.page.mouse.click(p.x, p.y);
      await sleep(450);
      return p;
    },
    /** 剪贴板写入：走**壳层主进程**（Electron clipboard，与产品自己的「复制表格」同一条通道）。
     *  ⚠️ 实测（本族 P1 正对照）：`navigator.clipboard.writeText` 在本机 Electron 上**静默失败**
     *  （回读为空、随后的 Ctrl+V 是空粘贴）⇒ 渲染侧那条路不能当写入通道，只能当只读尺子。 */
    clipWrite: async (text, html) => {
      const w = await ev(state.page, async ({ t, h }) => {
        const hp = window.mpHost;
        if (!hp || typeof hp.writeClipboard !== 'function') return { ok: false, why: 'no mpHost.writeClipboard' };
        try { const r = await hp.writeClipboard(h ? { text: t, html: h } : { text: t }); return { ok: !(r && r.ok === false), ret: r === undefined ? null : r }; }
        catch (e) { return { ok: false, why: String((e && e.message) || e).slice(0, 80) }; }
      }, { t: text, h: html || null });
      await sleep(200);
      const back = api.psGetClip();                                  // 尺子②：系统剪贴板（主进程外）
      const pageBack = await ev(state.page, async () => String(await navigator.clipboard.readText().catch(() => '')).slice(0, 80)).catch(() => '');
      const got = String(back || '');
      /* 【2026-10-10 复跑加固】判据仍是**严格相等**（下面 match），只补两条**诊断**字段，
         免得把"尺子伪影"误读成"剪贴板坏了"、或反过来：
          · 回读为空   —— 真·剪贴板不可用（会话锁屏时实测就是这种：写入返回 ok，回读长度 0）；
          · 规范化后相等 —— 仅把行尾 CRLF/CR 归一、去掉一个尾部换行再比；**不参与 match**。
          （教训：`& pwsh ... | Out-String` 这种回读会把行尾统一成 CRLF 并补尾换行 ⇒ 看着"不匹配"，
           其实剪贴板是好的。本 lib 用 [IO.File]::WriteAllText(Get-Clipboard -Raw) 直接落文件，无此伪影。） */
      const norm = (s) => String(s).replace(/\r\n?/g, '\n').replace(/\n$/, '');
      return {
        ...w, 系统剪贴板: got.slice(0, 60), 渲染侧回读: pageBack.slice(0, 60),
        match: got === text, want: text.slice(0, 60),
        尺子: 'file:Get-Clipboard -Raw（独立 pwsh 进程落文件，无 Out-String 伪影）',
        回读为空: got === '',
        回读长度: got.length, 写入长度: String(text).length,
        规范化后相等: norm(got) === norm(text),
      };
    },
    /** 主进程外尺子：PowerShell 读**系统剪贴板**（回读自证用） */
    psGetClip: () => {
      const f = path.join(DIR, 'clip-read.txt');
      try {
        execSync(`pwsh -NoProfile -Command "[IO.File]::WriteAllText('${f.replace(/\\/g, '/')}', (Get-Clipboard -Raw))"`, { windowsHide: true, stdio: 'ignore' });
        return fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
      } catch { return ''; }
    },
    clipRead: () => Promise.resolve(api.psGetClip()).then((t) => String(t || '').slice(0, 120)),
    /** 快速预检：**渲染侧**读剪贴板（一次 CDP 往返，约 10~30ms，比 spawn pwsh 快两个数量级）
     *  —— 用来在"按键前一瞬"确认剪贴板里还是我写的那份。写通道不能用它（实测静默失败），读通道实测可靠。 */
    clipPeek: () => ev(state.page, async () => {
      try { return String(await navigator.clipboard.readText()).slice(0, 80); }
      catch (e) { return '__ERR ' + String((e && e.message) || e).slice(0, 60); }
    }),
    /** 装弹＝写 + 独立进程回读**自证**，最多试 tries 次（邻族抢占剪贴板时重写） */
    clipArm: async (text, html, tries = 3) => {
      let last = null;
      for (let i = 1; i <= tries; i++) {
        last = await api.clipWrite(text, html);
        last.装弹第几次 = i;
        if (last.match) return last;
        await sleep(150);
      }
      return last;
    },
    /** 带**污染自证**的真实 Ctrl+V（剪贴板＝会话级全局资源，多族并行会互相抢占）
     *
     *  本轮实测教训：邻族 `list-continuation-rerun/clip-selfproof.cjs`（03:48:32Z）把哨兵
     *  `MPCLIP-SENTINEL-中文行1\r\n中文行2\ttab&"quote"` 写进系统剪贴板，正压在我 W1 的 Ctrl+V（约 03:48:35Z）上，
     *  于是"我按的 Ctrl+V"粘进去的是**别人的哨兵** —— 若无载荷校验，这会直接被我读成"产品粘贴行为异常"。
     *
     *  协议（每一步都留读数）：
     *    click → arm(写+独立回读自证) → peek(按键前一瞬快读) → Ctrl+V
     *      → snap(**一次 evaluate**：终态 + 本次 paste 事件载荷) → 断言载荷 == 预期文本
     *  载荷不符 ⇒ 本次观测被污染：撤销还原（并断言回到夹具原状）后重试；全试完仍不符 ⇒ 判「未验证」，
     *  **不拿被污染的发次当产品行为**。返回 ok=true 的那一发才是可用读数。 */
    pasteProof: async ({ expect, click, docBase, html, attempts = 4, settle = 900 }) => {
      const nz = (x) => String(x == null ? '' : x).replace(/\r\n?/g, '\n').replace(/\n$/, '');
      const tried = [];
      for (let i = 1; i <= attempts; i++) {
        await click();
        const arm = await api.clipArm(expect, html || null);
        const pre = await api.clipPeek();
        await api.key('Control+v', settle);
        const s = await ev(state.page, snapFn);
        const pl = (s.pasteLog || []);
        const lastEv = pl.length ? pl[pl.length - 1] : null;
        const payload = lastEv ? lastEv.plain : '';
        const ok = nz(payload) === nz(expect);
        const row = {
          第几次: i,
          装弹: { ok: arm.ok, match: arm.match, 回读: arm.系统剪贴板, 回读为空: arm.回读为空, 装弹第几次: arm.装弹第几次 },
          按键前一瞬: String(pre == null ? '' : pre).slice(0, 44),
          载荷: String(payload).slice(0, 44),
          prevented: lastEv ? lastEv.prevented : null,
          载荷相符: ok,
        };
        tried.push(row);
        if (ok) return { ok: true, 尝试: tried, snap: s, prevented: row.prevented, 首次即中: i === 1 };
        await api.key('Control+z', 700);
        const back = await ev(state.page, snapFn);
        row.还原回夹具原状 = back.doc === docBase;
        if (back.doc !== docBase) { row.中止 = '污染后无法还原为夹具原状 ⇒ 停止重试（不拿脏状态继续）'; return { ok: false, 尝试: tried, snap: back }; }
        await sleep(200);
      }
      return { ok: false, 尝试: tried, 全部被污染: true };
    },
    pasteLog: () => ev(state.page, () => { const l = window.__pasteLog || []; window.__pasteLog = []; return l; }),
    /** 真实按键（简写，保证走 page.keyboard） */
    key: async (k, ms = 420) => { await state.page.keyboard.press(k); await sleep(ms); },
    type: async (t, ms = 600) => { await state.page.keyboard.type(t); await sleep(ms); },
    shot: async (name, sel) => {
      const file = path.join(SHOTS, name + '.png');
      try {
        let clip = undefined;
        if (sel) {
          const b = await ev(state.page, (s) => {
            const el = document.querySelector(s);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.max(0, Math.floor(r.left - 60)), y: Math.max(0, Math.floor(r.top - 30)), width: Math.ceil(r.width + 120), height: Math.ceil(r.height + 60) };
          }, sel);
          if (b) clip = b;
        }
        await state.page.screenshot({ path: file, clip });
        return file;
      } catch (e) { return 'ERR ' + String((e && e.message) || e).slice(0, 60); }
    },
    /** 主进程事实：MP_DEBUG=1 的壳层 trace 尾巴（现象与推断矛盾时的第一手证据） */
    dbgTail: (n = 12) => {
      try {
        const f = path.join(state.profile, 'main-debug.log');
        if (!fs.existsSync(f)) return ['(无 main-debug.log)'];
        return fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).slice(-n);
      } catch (e) { return ['(读日志失败 ' + String((e && e.message) || e) + ')']; }
    },
    finish: async (code = 0) => {
      fs.writeFileSync(path.join(DIR, 'result.json'), JSON.stringify({ log, errs, cerrs, boots: state.boots, 外部中断次数: state.killedExternally }, null, 1), 'utf8');
      console.log('落盘：' + path.join(DIR, 'result.json'));
      try { await state.browser.close(); } catch { }
      killChild();
      process.exit(code);
    },
  };
  return api;
}

/** 用例条目落点：既打印一行，也进 **当前 boot 的 log 数组**（result.json 的正文）。
 *  ⚠️ 第一版只打印不入数组 ⇒ 所有 result.json 都是空壳，只有 tee 出来的 .log 有读数。 */
let sink = null;
function log(caseId, data) {
  const row = { case: caseId, ...data };
  if (sink) sink.push(row);
  console.log('[' + caseId + '] ' + JSON.stringify(data));
  return row;
}

module.exports = { boot, log, sleep, snapFn, OUT, isClosedErr };
