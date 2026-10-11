/** 探针 · R9 验收 K2 门（跨格矩形粘贴，E9 §B 硬判据 1-5 + G-K2-2）。
 *
 *  场景：3×3 表（甲乙丙列 × 3 数据行）→ 真鼠标拖出 2×2 跨格选区（甲1→乙2 正向、
 *  乙2→甲1 反向各一轮）→ 独立进程写系统剪贴板 2×2 TSV → 真组合键 Ctrl+V → 真键 Ctrl+S。
 *  硬判据（E9 §B，无论 Typora 对照结果如何必须成立）：
 *   1. 磁盘 md 表行无字面 TAB（cat -A 口径无 ^I）；
 *   2. 粘贴矩形之外既有格逐字保真（丙1/丙3/甲3/乙3 不丢不改）；
 *   3. 行数只随 growTable 变（2×2 粘 2×2 → 仍 4 行）；
 *   4. round-trip：重开文档表形与粘贴后 DOM 一致；
 *   5. 跨格选区粘贴不进原生线性删路径（判据 1+2+3 的合集即其行为学证据）。
 *  反向拖拽轮验证「粘贴网格左上角对齐选区 min 角」（Excel 语义，不随拖拽方向变）。
 *
 *  用法：node scripts/acceptance/probe-r9-k2.cjs [--only=fwd,rev] [--mutant]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const MUTANT = process.argv.includes('--mutant');
const OUT = path.join(harness.project, '.perf/probe-r9-k2');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');

const DOC = ['# R9K2 跨格粘贴验收', '',
  '| K2甲 | K2乙 | K2丙 |', '| --- | --- | --- |',
  '| 甲1 | 乙1 | 丙1 |', '| 甲2 | 乙2 | 丙2 |', '| 甲3 | 乙3 | 丙3 |', ''].join('\n');

const IF = hi.IF, S = hi.SURFACE;
const TABLE_FACTS = `(() => { const w = ${IF}; const root = w.document.querySelector(${JSON.stringify(S)}); if (!root) return { none: true };
  const table = root.querySelector('table'); if (!table) return { 表格数: 0 };
  return { 行数: table.rows.length,
    每行格数: [...table.rows].map(row => row.cells.length),
    跨格: [...table.querySelectorAll('td,th')].filter(c => (c.colSpan || 1) > 1 || (c.rowSpan || 1) > 1).length,
    格文: [...table.rows].map(row => [...row.cells].map(c => String(c.textContent).slice(0, 16))) }; })()`;
const SEL_FACTS = `(() => { const s = ${IF}.getSelection(); if (!s || !s.rangeCount) return { 无选区: true };
  const cellOf = n => { const at = n.nodeType === 3 ? n.parentElement : n; const c = at && at.closest && at.closest('td,th'); return c ? (c.cellIndex + ',' + c.parentElement.rowIndex) : null; };
  return { 折叠: s.getRangeAt(0).collapsed, 选文: s.toString().slice(0, 40), anchor格: cellOf(s.anchorNode), focus格: cellOf(s.focusNode) }; })()`;

async function keySave(session, file, { timeout = 8000 } = {}) {
  const before = fs.readFileSync(file, 'utf8');
  await hi.combo(session, 'Ctrl+S');
  const started = Date.now();
  while (Date.now() - started < timeout) {
    await harness.sleep(120);
    if (fs.readFileSync(file, 'utf8') !== before) return { saved: true, waitedMs: Date.now() - started };
  }
  return { saved: false, waitedMs: Date.now() - started };
}

/** 一轮：拖选 → 粘贴 → 表格事实 → 存盘 → 磁盘判据。direction='fwd'(甲1→乙2) | 'rev'(乙2→甲1)。 */
async function round(ctx, docName, direction, report) {
  const file = path.join(OUT, docName);
  fs.writeFileSync(file, DOC, 'utf8');
  let session = null;
  try {
    session = await hi.openDoc(ctx, file, { minBlocks: 3, settleMs: 1800, timeout: 120000, inspect: true });
    await session.main.js(`global.doc.setSetting('autoSave', false)`);
    await hi.ensureFocus(session);
    await session.js(`(() => { const root = ${IF}.document.querySelector(${JSON.stringify(S)});
      root.querySelector('table').scrollIntoView({ block: 'center', behavior: 'instant' }); return true; })()`);
    await harness.sleep(300);
    const cells = await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow;
      const root = w.document.querySelector(${JSON.stringify(S)}); const table = root.querySelector('table');
      const fr = frame.getBoundingClientRect(); const out = {};
      for (const [name, row, col] of [['甲1', 1, 0], ['乙1', 1, 1], ['甲2', 2, 0], ['乙2', 2, 1], ['丙1', 1, 2]]) {
        const r = table.rows[row].cells[col].getBoundingClientRect();
        out[name] = { x: Math.round(fr.x + r.x + r.width / 2), y: Math.round(fr.y + r.top + r.height / 2) }; }
      return out; })()`);
    const from = direction === 'fwd' ? cells.甲1 : cells.乙2;
    const to = direction === 'fwd' ? cells.乙2 : cells.甲1;
    await hi.drag(session, from, to, { steps: 10, interval: 35 });
    const sel = await session.js(SEL_FACTS);
    if (!sel || sel.折叠 || !sel.anchor格 || !sel.focus格) throw new Error('2×2 拖选没成立：' + JSON.stringify(sel));

    harness.writeClipboard(OUT, 'P11\tP12\nP21\tP22');
    const focusOK = await session.js(hi.FOCUS);
    if (!(focusOK && focusOK.ok)) throw new Error('粘贴前焦点不在编辑器');
    await session.shot('K2-' + direction + '-拖选后-full');
    await hi.combo(session, 'Ctrl+V');
    await harness.sleep(900);
    const facts = await session.js(TABLE_FACTS);
    await session.shot('K2-' + direction + '-粘贴后-full');
    const save = await keySave(session, file);
    await harness.sleep(400);
    const md = fs.readFileSync(file, 'utf8');
    const tableLines = (md.match(/^\|.*$/gm) || []);
    const literalTabs = tableLines.filter(line => line.includes('\t'));

    // 硬判据
    const texts = facts.格文 || [];
    const shapeOK = facts.行数 === 4 && (facts.每行格数 || []).join() === '3,3,3,3' && !(facts.跨格);
    const rectOK = /P11/.test(texts[1]?.[0] || '') && /P12/.test(texts[1]?.[1] || '')
      && /P21/.test(texts[2]?.[0] || '') && /P22/.test(texts[2]?.[1] || '');
    const outsideOK = /K2丙/.test(texts[0]?.[2] || '') && /丙1/.test(texts[1]?.[2] || '')
      && /丙2/.test(texts[2]?.[2] || '') && /甲3/.test(texts[3]?.[0] || '') && /乙3/.test(texts[3]?.[1] || '') && /丙3/.test(texts[3]?.[2] || '');
    const diskOK = save.saved && !literalTabs.length && tableLines.length >= 5 && /P11/.test(md) && /丙1/.test(md);

    // round-trip：重开比对
    await session.close(); session = null;
    session = await hi.openDoc(ctx, file, { minBlocks: 3, settleMs: 1800, timeout: 120000 });
    const facts2 = await session.js(TABLE_FACTS);
    const roundTripOK = JSON.stringify(facts2.格文) === JSON.stringify(facts.格文) && facts2.行数 === facts.行数;

    const all = shapeOK && rectOK && outsideOK && diskOK && roundTripOK;
    report('K2-' + direction, all === !MUTANT ? 'PASS' : 'FAIL', {
      拖选: sel, 粘贴后表: facts, 存盘: save, 磁盘表行: tableLines, 字面TAB行数: literalTabs.length,
      重开表: facts2, 判据: { shapeOK, rectOK, outsideOK, diskOK, roundTripOK },
      口径: '硬判据1-5：无^I/矩形外保真/行数不变/round-trip/不进线性删路径' + (MUTANT ? '（突变模式期望红）' : ''),
    });
    return all;
  } finally {
    if (session) { try { await session.close(); } catch {} }
  }
}

(async () => {
  if (process.argv.includes('--fresh')) fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const log = [];
  const report = (name, verdict, detail) => { const line = 'R9K2 ' + name + ' ' + verdict + ' ' + JSON.stringify(detail); console.log(line); log.push(line); };
  const saved = harness.saveClipboard(OUT);
  const ctx = {
    launch: options => harness.launch({ exe: EXE, appArgs: [APP_MAIN], label: 'probe-r9-k2', outDir: OUT, timeout: 180000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  const want = name => !only.length || only.includes(name);
  let pass = 0, fail = 0;
  try {
    if (want('fwd')) { (await round(ctx, 'r9-k2-fwd.md', 'fwd', report)) !== MUTANT ? pass++ : fail++; }
    if (want('rev')) { (await round(ctx, 'r9-k2-rev.md', 'rev', report)) !== MUTANT ? pass++ : fail++; }
  } finally {
    try { harness.restoreClipboard(OUT, saved.__file); } catch (error) { console.log('剪贴板还原失败：' + error.message); }
    fs.appendFileSync(path.join(OUT, 'trace.txt'), log.join('\n') + '\n', 'utf8');
  }
  console.log('=== K2 汇总：PASS ' + pass + ' / FAIL ' + fail + (MUTANT ? '（突变）' : '（绿轮）') + ' ===');
  process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error('probe-r9-k2 失败：', error); process.exit(1); });
