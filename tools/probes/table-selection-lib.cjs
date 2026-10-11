/** table-selection 族**共用尺子/夹具**（第二波：真实用户日常操作普查）
 *
 *  族范围：表格选择层级（格/行/列/整表）—— 如何选中（拖拽/点击边栏）、选中后复制/剪切/删除/粘贴、
 *          Tab 与方向键在层级间切换、层级态下打字是否被拦。
 *
 *  纪律落地：
 *   · 启动范式**照抄**现有探针（table-daily-lib.cjs 那一套）：spawn(exe,[doc,--remote-debugging-port,
 *     --user-data-dir]) + MP_DEBUG=1 + delete ELECTRON_RUN_AS_NODE + playwright-core connectOverCDP。
 *     （错-4 只禁"同一件尺子有两份实现"；这里的尺子卡/断言仍走唯一的 _probe-common.cjs。）
 *   · 错-7① 一组相关读数**一次 evaluate 拿全** ⇒ snap() 是唯一读数入口，返回一个完整对象。
 *   · 错-7③ 不关页面/窗口；收场只用 taskkill /PID <本进程pid> /T /F。
 *   · 错-1 启动即打尺子卡（产物 sha16）并断言 MP_EXPECT_EXE。
 *   · 输入一律真实通道：page.mouse / page.keyboard（CDP Input.*）。
 *   · 环境事实（本机锁屏）：系统剪贴板对所有进程不可用 ⇒ 跨进程剪贴板类用例一律判"环境阻断"。
 *     但**事件层**（copy/cut/paste 事件里的 clipboardData）是本页自己的对象，**可以**读 —— 两条尺子
 *     必须分开写清（事件层 = 产品给了什么；系统剪贴板 = 环境阻断）。
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

const OUT = path.join(__MP_WORK, 'table-selection-out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isClosedErr = (e) => /has been closed|Target closed|Session closed|browser has been closed|Connection closed/i.test(String((e && e.message) || e));

/** 端口必须**真空闲**（固定端口被别腿实例占着时 connectOverCDP 会连到别人的窗口）。
 *  基址取 16900–17699：与 table-daily(13600–14799)/math-daily(15740) 错开，避免并行族互撞。 */
function pickPort() {
  const used = new Set();
  try {
    const out = execSync('netstat -ano -p tcp', { windowsHide: true, encoding: 'utf8' });
    for (const m of out.matchAll(/:(\d+)\s+\S+\s+LISTENING/gi)) used.add(Number(m[1]));
  } catch { /* 拿不到 netstat 就退回随机 */ }
  for (let i = 0; i < 400; i++) {
    const p = 16900 + ((process.pid * 11 + i * 17) % 800);
    if (!used.has(p)) return p;
  }
  return 16900 + (process.pid % 800);
}

async function ev(page, fn, arg) {
  const r = await Promise.race([
    page.evaluate(fn, arg).then((v) => ({ v }), (e) => ({ err: String((e && e.message) || e).slice(0, 160) })),
    sleep(8000).then(() => ({ err: 'evaluate 超时 8s' })),
  ]);
  if (r.err) throw new Error('evaluate 失败：' + r.err);
  return r.v;
}

/* ── 唯一读数入口：**同一个函数**里把选择层级相关的可见状态一次取全 ─────────────
 *  判据口径（AGENTS §交互验收总规则四-1/错-10）：读**用户能看见的最终状态**——
 *   · 层级态：widget DOM 上的 .mp-sel-row / .mp-sel-col / .mp-sel-table（正文源码行被 block widget
 *     整行替换，原生选区在屏幕上不可见 ⇒ DOM class 才是用户眼睛看到的那个东西）；
 *   · CM 选区区间 / 文档文本 / 覆盖层 / 活动元素 / 提示条。
 *  ❌ 不读"我调用了什么函数"，也绝不跨 evaluate 拼装。 */
function selSnapFn() {
  const v = window.mpEngine && window.mpEngine._view ? window.mpEngine._view() : null;
  if (!v) return { err: 'no view' };
  const st = v.state;
  const doc = st.doc.toString();
  const sel = st.selection.main;
  const hlLine = st.doc.lineAt(sel.head);
  const wrap = document.querySelector('.mp-table-wrap');
  const rowEl = document.querySelector('tr.mp-sel-row');
  const colEl = document.querySelector('td.mp-sel-col, th.mp-sel-col');
  const overlay = document.querySelector('.mp-cell-overlay');
  const ovText = document.querySelector('.mp-cell-overlay-text');
  const editCell = document.querySelector('.mp-row .mp-cell-editing');
  const active = document.activeElement;
  const dsel = window.getSelection();
  const rows = [...document.querySelectorAll('.mp-row')].map((t, i) => {
    const cs = [...t.querySelectorAll('th,td')];
    return {
      i, kind: t.querySelector('th') ? 'th' : 'td', cls: String(t.className || ''),
      selCol: cs.filter((c) => c.classList.contains('mp-sel-col')).length,
      cells: cs.map((c) => String(c.textContent == null ? '' : c.textContent).trim().slice(0, 14)),
      rowFrom: cs[0] ? Number(cs[0].dataset.mpRow) : null,
    };
  });
  return {
    doc, docLen: doc.length, docLines: st.doc.lines,
    selFrom: sel.from, selTo: sel.to, selEmpty: sel.empty, head: sel.head,
    selText: st.doc.sliceString(Math.min(sel.anchor, sel.head), Math.max(sel.anchor, sel.head)),
    headLine: hlLine.number, headCol: sel.head - hlLine.from, headText: hlLine.text,
    headIsTable: /^\s*>*\s*\|/.test(hlLine.text),
    /* 用户眼睛看的层级高亮 */
    hl: {
      table: document.querySelectorAll('.mp-table-wrap.mp-sel-table').length,
      tableOutline: wrap ? getComputedStyle(wrap).outlineStyle + '/' + getComputedStyle(wrap).outlineWidth : null,
      row: document.querySelectorAll('tr.mp-sel-row').length,
      rowText: rowEl ? String(rowEl.textContent || '').trim() : null,
      col: document.querySelectorAll('td.mp-sel-col, th.mp-sel-col').length,
      colText: colEl ? String(colEl.textContent || '').trim() : null,
      rowBg: rowEl ? getComputedStyle(rowEl.querySelector('th,td')).backgroundColor : null,
      colBg: colEl ? getComputedStyle(colEl).backgroundColor : null,
    },
    rows, rowCount: rows.length, tables: document.querySelectorAll('.mp-table-wrap').length,
    overlay: { present: !!overlay, visible: !!(overlay && overlay.style.display !== 'none'), text: ovText ? ovText.textContent : null },
    activeCellDom: editCell ? { rowFrom: Number(editCell.dataset.mpRow), col: Number(editCell.dataset.mpCol), text: String(editCell.textContent || '') } : null,
    focus: active ? String(active.className || active.tagName).slice(0, 44) : null,
    focusInEditor: !!(active && active.closest && (active.closest('.cm-editor') || active.classList.contains('mp-cell-overlay-text'))),
    hasFocus: document.hasFocus(),
    domSel: dsel ? { text: String(dsel.toString()).slice(0, 80), collapsed: dsel.isCollapsed, inOverlay: !!(ovText && dsel.anchorNode && ovText.contains(dsel.anchorNode)) } : null,
    toasts: [...document.querySelectorAll('.mp-toast')].filter((t) => t.style.display !== 'none' && String(t.textContent || '').trim()).map((t) => String(t.textContent).trim()).slice(0, 3),
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

  const log = []; sink = log;
  const errs = [], cerrs = [];
  const state = { child: null, browser: null, page: null, profile: null, boots: 0, port: null, killed: 0 };

  async function launch() {
    state.boots++;
    const profile = path.join(DIR, state.boots === 1 ? 'profile' : 'profile-r' + state.boots);
    fs.rmSync(profile, { recursive: true, force: true });
    fs.mkdirSync(profile, { recursive: true });
    state.profile = profile;
    const PORT = pickPort(); state.port = PORT;
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
        const ok = await p.evaluate(() => { try { return !!(window.mpEngine && window.mpEngine._view && window.mpEngine._view()); } catch { return false; } }).catch(() => false);
        if (ok) { page = p; break; }
      }
      if (!page) await sleep(500);
    }
    if (!page) throw new Error('找不到引擎页');
    state.page = page;
    page.on('pageerror', (e) => errs.push(String((e && e.message) || e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') cerrs.push(String(m.text()).slice(0, 200)); });
    /* 事件层取证（**产品给了什么**，与系统剪贴板无关）：
       copy/cut/paste 的 clipboardData 是**本页自己的对象**；
       CM6 的处理器挂在 contentDOM（冒泡），覆盖层的挂在 overlay div（冒泡）
       ⇒ document 上的**冒泡**监听在它们之后跑，读到的是最终值。 */
    await page.evaluate(() => {
      window.__selCopyLog = []; window.__selPasteLog = [];
      const grab = (e, kind) => {
        const cb = e.clipboardData;
        const rec = { kind, prevented: !!e.defaultPrevented, types: cb ? [...cb.types] : null, target: String((e.target && e.target.className) || '').slice(0, 40), domSel: String(window.getSelection() || '').slice(0, 60) };
        try { rec.plain = cb ? String(cb.getData('text/plain')) : null; } catch (err) { rec.plainErr = String(err).slice(0, 40); }
        try { rec.html = cb ? String(cb.getData('text/html')) : null; } catch (err) { rec.htmlErr = String(err).slice(0, 40); }
        if (kind === 'paste') window.__selPasteLog.push(rec); else window.__selCopyLog.push(rec);
      };
      document.addEventListener('copy', (e) => grab(e, 'copy'), false);
      document.addEventListener('cut', (e) => grab(e, 'cut'), false);
      document.addEventListener('paste', (e) => grab(e, 'paste'), false);
    }).catch(() => { });
    await sleep(2500);
  }

  const killChild = () => { try { execSync(`taskkill /PID ${state.child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { } };

  await launch();

  const api = {
    DOC, DIR, SHOTS, errs, cerrs, log, sleep,
    get page() { return state.page; },
    get child() { return state.child; },
    get profile() { return state.profile; },
    get boots() { return state.boots; },
    kill: killChild,
    ev: (fn, arg) => ev(state.page, fn, arg),
    snap: () => ev(state.page, selSnapFn),
    alive: async () => ev(state.page, () => 1).then(() => true, () => false),
    reboot: async (why) => {
      log.push({ case: 'REBOOT', why: String(why || '').slice(0, 160), at: new Date().toISOString(), boots: state.boots + 1 });
      console.log('[REBOOT] ' + String(why || '').slice(0, 160));
      killChild(); await sleep(2000);
      fs.writeFileSync(DOC, docText, 'utf8');
      await launch();
      return { rebooted: true, boots: state.boots };
    },
    guard: async (id, fn) => {
      try {
        if (!(await api.alive())) await api.reboot(id + ' 用例前页面已关闭');
        return await fn();
      } catch (e) {
        if (!isClosedErr(e) && await api.alive().catch(() => false)) throw e;
        state.killed++;
        await api.reboot(id + ' 用例中页面被关闭：' + String((e && e.message) || e).slice(0, 120));
        return await fn();
      }
    },
    /** 夹具自证：读数不是默认回退值（文档里有夹具锚文、表格渲染行数够） */
    assertFixture: async (expect) => {
      const s = await api.snap();
      const ok = s.doc && s.doc.includes(expect.line) && s.docLen > 0 && (!expect.minRows || s.rowCount >= expect.minRows);
      if (!ok) throw new Error('读数像回退值：' + JSON.stringify({ docLen: s.docLen, rowCount: s.rowCount, doc: String(s.doc).slice(0, 40) }));
      return s;
    },
    /* ── 真实鼠标 ── */
    cellXY: (rowIdx, colIdx) => ev(state.page, ({ r, c }) => {
      const t = document.querySelectorAll('.mp-row')[r];
      if (!t) return null;
      const cell = t.querySelectorAll('th,td')[c];
      if (!cell) return null;
      const b = cell.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: Math.round(b.width), h: Math.round(b.height), rowFrom: Number(cell.dataset.mpRow), col: Number(cell.dataset.mpCol), text: String(cell.textContent || '').trim() };
    }, { r: rowIdx, c: colIdx }),
    clickCell: async (rowIdx, colIdx, ms = 500) => {
      const xy = await api.cellXY(rowIdx, colIdx);
      if (!xy) throw new Error('找不到渲染格 ' + rowIdx + '/' + colIdx);
      await state.page.mouse.click(xy.x, xy.y);
      await sleep(ms);
      return xy;
    },
    /* ── 真实键盘 ── */
    key: async (k, ms = 420) => { await state.page.keyboard.press(k); await sleep(ms); },
    type: async (t, ms = 600) => { await state.page.keyboard.type(t); await sleep(ms); },
    /** 真实点一下**表外段落**（把 CM 选区从"全选"里拉出来；点格不落 CM 选区 ⇒ 全选状态下
     *  只点格子的话，cycleTableSelection 第一句"已是全文档 ⇒ return false"会让阶梯彻底卡死）。 */
    clickDocLine: async (lineNo, ms = 460) => {
      const p = await ev(state.page, (n) => {
        const v = window.mpEngine._view();
        const l = v.state.doc.line(n);
        const c = v.coordsAtPos(l.from);
        return c ? { x: Math.round(c.left + 3), y: Math.round((c.top + c.bottom) / 2), from: l.from, text: l.text } : null;
      }, lineNo);
      if (!p) throw new Error('第 ' + lineNo + ' 行取不到坐标');
      await state.page.mouse.click(p.x, p.y);
      await sleep(ms);
      return p;
    },
    /* ── 递进到某个层级（**只用真实输入，且每一步都确定**）──
     *  ① 点表外段落（把 CM 选区从全选/别处拉出来）
     *  ② 点目标格（覆盖层起来）
     *  ③ Ctrl+E ⇒ **确定**落在"格"级（selectCellText 不看当前层级，是确定性入口）
     *  ④ 再按 n-1 次 Ctrl+A ⇒ 行/列/整表
     *  返回 {trail, s, level}；调用方**必须**用 level 自证台阶到位，不许假定"按了 3 次就是列级"。 */
    toLevel: async (kind, opt) => {
      const rowIdx = (opt && opt.rowIdx) != null ? opt.rowIdx : 1;
      const colIdx = (opt && opt.colIdx) != null ? opt.colIdx : 1;
      const para = await api.clickDocLine(3);
      const clicked = await api.clickCell(rowIdx, colIdx);
      const trail = [];
      let s = await api.snap();
      const docFirst = s.doc;                       // 逐拍比"文档有没有被这些选择动作改掉"
      const rec = (step) => trail.push({
        step, 层级: levelOf(s), 选区: [s.selFrom, s.selTo], 选区文本: s.selText.slice(0, 24),
        行高亮: s.hl.row, 列高亮: s.hl.col, 整表高亮: s.hl.table,
        覆盖层: s.overlay.visible, DOM选区: s.domSel && s.domSel.text, 焦点: s.focus,
        文档未变: s.doc === docFirst,
      });
      rec('点格后');
      await api.key('Control+e', 520); s = await api.snap(); rec('Ctrl+E(格)');
      const n = { cell: 1, row: 2, col: 3, table: 4 }[kind];
      for (let i = 2; i <= n; i++) { await api.key('Control+a', 480); s = await api.snap(); rec('Ctrl+A#' + (i - 1)); }
      return { clicked, para, trail, s, level: levelOf(s) };
    },
    copyLog: () => ev(state.page, () => { const l = window.__selCopyLog || []; window.__selCopyLog = []; return l; }),
    pasteLog: () => ev(state.page, () => { const l = window.__selPasteLog || []; window.__selPasteLog = []; return l; }),
    /* ── 系统剪贴板（**环境事实**尺子，独立于产品）── */
    psGetClip: () => {
      const f = path.join(DIR, 'clip-read.txt');
      try {
        execSync(`pwsh -NoProfile -Command "[IO.File]::WriteAllText('${f.replace(/\\/g, '/')}', [string](Get-Clipboard -Raw))"`, { windowsHide: true, stdio: 'ignore' });
        return fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
      } catch (e) { return 'ERR:' + String((e && e.message) || e).slice(0, 60); }
    },
    /** 系统剪贴板可用性自检：写→读→clip.exe 三条一起量（锁屏环境下应全部失败） */
    clipDiag: () => {
      const ps1 = path.join(DIR, 'clip-diag.ps1');
      const out = path.join(DIR, 'clip-diag.json');
      fs.writeFileSync(ps1, [
        '$out = $args[0]',
        '$o = [ordered]@{}',
        "try { Set-Clipboard -Value 'MPSEL-XYZ' -ErrorAction Stop; $o.set = 'ok' } catch { $o.set = 'fail' }",
        'try { $v = Get-Clipboard -Raw -ErrorAction Stop; $o.read_ok = $true; $o.read_len = ([string]$v).Length; $o.read_val = ([string]$v) } catch { $o.read_ok = $false; $o.read_err = [string]$_.Exception.Message }',
        "$tmp = Join-Path ([IO.Path]::GetTempPath()) 'mpsel-clip-in.txt'",
        "'MPSEL-XYZ' | Out-File -FilePath $tmp -Encoding ascii",
        '$null = cmd /c "clip.exe < `"$tmp`"" 2>&1',
        '$o.clipexe_exit = $LASTEXITCODE',
        '[IO.File]::WriteAllText($out, ($o | ConvertTo-Json -Compress))',
      ].join('\r\n'), 'utf8');
      try { execSync(`pwsh -NoProfile -File "${ps1}" "${out}"`, { windowsHide: true, stdio: 'ignore' }); } catch { }
      try { return JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) { return { err: String((e && e.message) || e) }; }
    },
    shot: async (name, sel) => {
      const file = path.join(SHOTS, name + '.png');
      try {
        let clip;
        if (sel) {
          const b = await ev(state.page, (s) => {
            const el = document.querySelector(s);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.max(0, Math.floor(r.left - 70)), y: Math.max(0, Math.floor(r.top - 34)), width: Math.ceil(r.width + 140), height: Math.ceil(r.height + 68) };
          }, sel);
          if (b) clip = b;
        }
        await state.page.screenshot({ path: file, clip });
        return file;
      } catch (e) { return 'ERR ' + String((e && e.message) || e).slice(0, 60); }
    },
    dbgTail: (n = 12) => {
      try {
        const f = path.join(state.profile, 'main-debug.log');
        if (!fs.existsSync(f)) return ['(无 main-debug.log)'];
        return fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).slice(-n);
      } catch (e) { return ['(读日志失败 ' + String((e && e.message) || e) + ')']; }
    },
    finish: async (code = 0) => {
      fs.writeFileSync(path.join(DIR, 'result.json'), JSON.stringify({ log, errs, cerrs, boots: state.boots, 外部中断次数: state.killed }, null, 1), 'utf8');
      console.log('落盘：' + path.join(DIR, 'result.json'));
      try { await state.browser.close(); } catch { }
      killChild();
      process.exit(code);
    },
  };
  return api;
}

/** 层级判定（**只看用户能看见的东西**）：优先 DOM 高亮类，其次 CM 选区形态。
 *  返回 'none' | 'cell' | 'row' | 'col' | 'table' | 'doc' | 'src'（表内源码行但没有层级高亮） */
function levelOf(s) {
  if (!s || s.err) return 'err';
  if (s.hl && s.hl.table) return 'table';
  if (s.hl && s.hl.row) return 'row';
  if (s.hl && s.hl.col) return 'col';
  if (s.domSel && !s.domSel.collapsed && s.domSel.inOverlay) return 'cell';
  if (s.selEmpty === false && s.doc && s.selFrom === 0 && s.selTo === s.docLen) return 'doc';
  if (!s.selEmpty && s.headIsTable) return 'src';
  return 'none';
}

let sink = null;
function log(caseId, data) {
  const row = { case: caseId, ...data };
  if (sink) sink.push(row);
  console.log('[' + caseId + '] ' + JSON.stringify(data));
  return row;
}
/** 读数裁剪：只留判据需要的字段，避免 report 里塞满噪声 */
const brief = (s) => s && !s.err ? {
  文档: s.doc, 文档行数: s.docLines, 选区: [s.selFrom, s.selTo], 选区文本: s.selText,
  光标: { 行: s.headLine, 列: s.headCol, 在表行: s.headIsTable }, 层级: levelOf(s),
  高亮: { 行: s.hl.row, 列: s.hl.col, 整表: s.hl.table }, 覆盖层: s.overlay.visible,
  活动格: s.activeCellDom, 焦点: s.focus, 焦点在编辑面: s.focusInEditor, 窗口有焦点: s.hasFocus,
  DOM选区: s.domSel, 提示: s.toasts,
} : { 读数失败: s && s.err };

module.exports = { boot, log, sleep, levelOf, brief, selSnapFn, OUT };
