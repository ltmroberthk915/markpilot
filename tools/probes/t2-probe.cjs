/* task-2 复核探针（⑦ Ctrl+Enter 光标落点 / ⑧ 格内 Ctrl+Shift+E 行内公式）
 * 真 CDP 输入（playwright keyboard ⇒ Input.dispatchKeyEvent），不造 JS 事件。
 * 身份门：端口每次不同 + 页内事实（app.asar + mpEngine + 工具栏项数）。
 * 用法：node t2-probe.cjs <exe路径> <tag>
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('../quality/dependencies.cjs').playwright();   // 与其它探针同一处解析（本仓没有本地 playwright-core）

const EXE = process.argv[2];
const TAG = process.argv[3] || 'run';
const PORT = 9500 + (process.pid % 400);
const ROOT = path.join(__dirname, '..', 't2-verify');
const FIX = path.join(ROOT, 'fix');
const UD = path.join(ROOT, 'profile-' + TAG);
const DOC = path.join(FIX, 't2.md');
const OUT = path.join(ROOT, 't2-' + TAG + '.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { tag: TAG, port: PORT, identity: {}, cases: {}, notes: [] };

function write() { fs.mkdirSync(ROOT, { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(res, null, 2), 'utf8'); }
function pick(o, keys) { const r = {}; for (const k of keys) r[k] = o ? o[k] : null; return r; }
/** 把文档 offset 换算成 1-based 行列 */
function lineCol(text, off) {
  const before = text.slice(0, off);
  const line = before.split('\n').length;
  const col = off - (before.lastIndexOf('\n') + 1) + 1;
  return { line, col };
}

(async () => {
  fs.rmSync(FIX, { recursive: true, force: true });
  fs.mkdirSync(FIX, { recursive: true });
  fs.writeFileSync(DOC, [
    '# t2 复核夹具', '',
    '表外正文一行。', '',
    '| 甲 | 乙 |', '| --- | --- |', '| a1 | b1 |', '| a2 | b2 |', '',
  ].join('\n'), 'utf8');

  const env = Object.assign({}, process.env, { MP_TEST_NO_DIALOG: '1' });
  /* 【已知陷阱】ELECTRON_RUN_AS_NODE 会让这个 exe 以**纯 Node** 方式启动：
     它把 --remote-debugging-port 之类当 Node 选项 ⇒ `bad option` + 立刻 exit 9（实测踩到）。
     必须在**同一条命令的同一个 env** 里删掉它。 */
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, ['--remote-debugging-port=' + PORT, '--user-data-dir=' + UD, '--no-first-run', DOC], { env, stdio: 'ignore', detached: false });
  let browser = null;
  try {
    for (let i = 0; i < 60 && !browser; i++) {
      await sleep(500);
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT); } catch (e) { browser = null; }
    }
    if (!browser) { res.notes.push('CDP 连不上（端口 ' + PORT + '）'); write(); return; }
    const ctx = browser.contexts()[0];
    let page = null;
    for (let i = 0; i < 40 && !page; i++) {
      page = ctx.pages().find((p) => /app\.asar/.test(p.url())) || null;
      if (!page) await sleep(500);
    }
    if (!page) { res.notes.push('没有 app.asar 页面（连到的可能不是我们的应用）'); write(); return; }
    /* ── 身份门 ── */
    res.identity = await page.evaluate(() => ({
      url: location.href,
      hasEngine: typeof window.mpEngine,
      hasTableOp: typeof (window.mpExtras && window.mpExtras.tableOp),
      toolbarCount: document.querySelectorAll('.mp-toolbar .mp-tb-item').length,
      hostReload: typeof (window.mpHost && window.mpHost.reload),
    }));
    if (res.identity.toolbarCount !== 31) res.notes.push('身份门异常：工具栏项数 ' + res.identity.toolbarCount + '（期望 31）');

    const docReady = async () => {
      for (let i = 0; i < 40; i++) {
        const t = await page.evaluate(() => (window.mpEngine && window.mpEngine.getValue ? window.mpEngine.getValue() : null));
        if (t && /a1/.test(t)) return t;
        await sleep(400);
      }
      return null;
    };
    await docReady();
    const cells = async () => page.evaluate(() => Array.from(document.querySelectorAll('.mp-table-wrap [data-mp-row]')).map((e) => {
      const r = e.getBoundingClientRect();
      return { t: (e.textContent || '').trim().slice(0, 6), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), h: Math.round(r.height) };
    }));
    const sel = async () => page.evaluate(() => {
      try { return window.mpEngine.getSelection ? window.mpEngine.getSelection() : null; } catch (e) { return { err: String(e && e.message) }; }
    });
    const val = async () => page.evaluate(() => (window.mpEngine && window.mpEngine.getValue ? window.mpEngine.getValue() : null));
    const clickCell = async (idx) => {
      const cs = await cells();
      const c = cs[idx]; if (!c) return null;
      await page.mouse.move(c.x, c.y); await sleep(120);
      await page.mouse.down(); await page.mouse.up(); await sleep(450);
      return c;
    };
    const ctrlEnter = async () => { await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control'); await sleep(650); };
    const ctrlShiftE = async () => { await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('e'); await page.keyboard.up('Shift'); await page.keyboard.up('Control'); await sleep(650); };

    /* ── ⑦ 用例 1：点 a1 格 → Ctrl+Enter ── */
    const c1 = await clickCell(2);                                   // 顺序：表头甲/乙 → a1/b1 → a2/b2
    const before1 = await val();
    await ctrlEnter();
    const after1 = await val();
    const s1 = await sel();
    res.cases.ctrlEnter_fromCell = {
      clicked: c1, sel: s1,
      beforeLines: before1 ? before1.split('\n').length : null,
      afterLines: after1 ? after1.split('\n').length : null,
      caret: (after1 && s1 && Number.isFinite(s1.from)) ? lineCol(after1, s1.from) : null,
      newLineText: after1 ? after1.split('\n').find((l) => /^\|\s+\|\s+\|/.test(l)) || null : null,
    };

    /* ── ⑧ 用例 1：点 a2 格 → Ctrl+Shift+E ── */
    await clickCell(4);
    const before2 = await val();
    await ctrlShiftE();
    const after2 = await val();
    res.cases.ctrlShiftE_inCell = {
      beforeLen: before2 ? before2.length : null, afterLen: after2 ? after2.length : null,
      grew: !!(before2 && after2 && after2.length > before2.length),
      dollarCount: after2 ? (after2.match(/\$/g) || []).length : null,
      changedLine: after2 ? after2.split('\n').filter((l, i) => l !== (before2 || '').split('\n')[i]).slice(0, 2) : null,
    };

    /* ── ⑧ 对照组：表外按 Ctrl+Shift+E（应仍是导出，不许插 $） ── */
    await page.evaluate(() => { try { window.mpEngine && window.mpEngine.focus && window.mpEngine.focus(); } catch (e) { } });
    // 把光标放到表外正文行
    await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll('.cm-line')).find((e) => /表外正文一行/.test(e.textContent || ''));
      if (line) { const r = line.getBoundingClientRect(); window.__mpProbePt = { x: Math.round(r.x + 8), y: Math.round(r.y + r.height / 2) }; }
    });
    const pt = await page.evaluate(() => window.__mpProbePt || null);
    if (pt) { await page.mouse.move(pt.x, pt.y); await sleep(120); await page.mouse.down(); await page.mouse.up(); await sleep(350); }
    const before3 = await val();
    await ctrlShiftE();
    await sleep(700);
    const dlg = await page.evaluate(() => {
      const d = document.querySelector('.mp-dlg');
      const pop = document.querySelector('.mp-pop');
      return { dlgText: d ? (d.textContent || '').slice(0, 40) : null, popText: pop ? (pop.textContent || '').slice(0, 40) : null };
    });
    const after3 = await val();
    res.cases.ctrlShiftE_outsideTable = { dollarDelta: (after3 || '').match(/\$/g) ? (after3.match(/\$/g) || []).length - ((before3 || '').match(/\$/g) || []).length : 0, dlg, pop: dlg.popText };

    write();
    console.log(JSON.stringify(res, null, 2));
  } catch (e) {
    res.notes.push('异常：' + String((e && e.stack) || e).slice(0, 400));
    write();
    console.log(JSON.stringify(res, null, 2));
  } finally {
    try { if (browser) await browser.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    if (process.platform === 'win32') { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { } }
    await sleep(400);
  }
})();
