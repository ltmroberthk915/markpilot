/** 探针 · R9 K2 门 Typora 实机对照（G-K2-3，E9 §B 判据）。
 *
 *  Typora 装机：D:\Users\ltmroberthk\AppData\Local\Programs\Typora\Typora.exe。
 *  通道：CDP over pipe（skill #46 实测——Typora 收下 --remote-debugging-port 但不监听，
 *  --remote-debugging-pipe 正常；fd3 写/fd4 读，\0 分隔）。独立端口不犯铁律 3。
 *
 *  三场景（与修复组同题）：
 *   ① TSV 2×2 → 2×2 跨格选区（真拖拽 甲1→乙2）；
 *   ② 单格文本 → 跨格选区；
 *   ③ TSV 2×2 → 单格光标（现有行为对照）。
 *  记录：拖选事实（anchor/focus 是否跨格）、粘贴后表形（行列/格文）、Ctrl+S 后磁盘 md。
 *  只取证不评判——差异点记 LOG 挂 R10（E9 §B「不静默分叉」）。
 *
 *  用法：node scripts/acceptance/probe-r9-typora.cjs [--only=s1,s2,s3]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const harness = require('./harness.cjs');
const peer = require('../peer-cdp.cjs');

const OUT = path.join(harness.project, '.perf/probe-r9-typora');
const EXE = 'D:/Users/ltmroberthk/AppData/Local/Programs/Typora/Typora.exe';
const ROOM = 'E:/MarkPilot/.zcode-tmp/r9/typora-cmp';

const DOC = ['# Typora 对照', '',
  '| K2甲 | K2乙 | K2丙 |', '| --- | --- | --- |',
  '| 甲1 | 乙1 | 丙1 |', '| 甲2 | 乙2 | 丙2 |', '| 甲3 | 乙3 | 丙3 |', ''].join('\n');

// Typora 的编辑面：#write（contenteditable）。表格事实按 Typora DOM 读取。
const FACTS = `(() => { const root = document.querySelector('#write'); if (!root) return { none: true };
  const table = root.querySelector('table'); if (!table) return { 表格数: 0 };
  const sel = getSelection();
  const cellOf = n => { const at = n && (n.nodeType === 3 ? n.parentElement : n); const c = at && at.closest && at.closest('td,th'); return c ? (c.cellIndex + ',' + c.parentElement.rowIndex) : null; };
  return { 行数: table.rows.length,
    每行格数: [...table.rows].map(r => r.cells.length),
    跨格: [...table.querySelectorAll('td,th')].filter(c => (c.colSpan || 1) > 1 || (c.rowSpan || 1) > 1).length,
    格文: [...table.rows].map(r => [...r.cells].map(c => String(c.textContent).slice(0, 16))),
    选区: sel && sel.rangeCount ? { 折叠: sel.isCollapsed, 选文: String(sel.toString()).slice(0, 40), anchor格: cellOf(sel.anchorNode), focus格: cellOf(sel.focusNode) } : null }; })()`;

const cellsExpr = `(() => { const table = document.querySelector('#write table'); if (!table) return null;
  const out = {}; for (const [name, row, col] of [['甲1', 1, 0], ['乙1', 1, 1], ['甲2', 2, 0], ['乙2', 2, 1]]) {
    const r = table.rows[row].cells[col].getBoundingClientRect();
    out[name] = { x: Math.round(r.x + r.width / 2), y: Math.round(r.top + r.height / 2) }; }
  return out; })()`;

async function drag(session, from, to) {
  // Typora 实测（dbg-drag/dbg-shift，2026-10-03）：拖拽在 Typora 表格里不扩选区（全程折叠），
  // 点击 + Shift+点击能建立跨格选区——跨格场景用后者（同为真实输入通道的组合）。
  await session.sendSession('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  await session.sendSession('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x, y: from.y, button: 'left', buttons: 0, clickCount: 1 });
  await harness.sleep(300);
  await session.sendSession('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, modifiers: 8 });
  await session.sendSession('Input.dispatchMouseEvent', { type: 'mousePressed', x: to.x, y: to.y, button: 'left', buttons: 1, clickCount: 1, modifiers: 8 });
  await session.sendSession('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, modifiers: 8 });
  await session.sendSession('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, modifiers: 0 });
  await harness.sleep(400);
}
async function comboCtrlV(session) {
  await session.sendSession('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 });
  await session.sendSession('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: 2 });
  await session.sendSession('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: 2 });
  await session.sendSession('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 });
}
async function comboCtrlS(session) {
  await session.sendSession('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 });
  await session.sendSession('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83, modifiers: 2 });
  await session.sendSession('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83, modifiers: 2 });
  await session.sendSession('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 });
}

(async () => {
  if (process.argv.includes('--fresh')) fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(ROOM, { recursive: true });
  const log = [];
  const report = (name, verdict, detail) => { const line = 'R9TP ' + name + ' ' + verdict + ' ' + JSON.stringify(detail); console.log(line); log.push(line); };
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  const want = n => !only.length || only.includes(n);
  const saved = harness.saveClipboard(OUT);
  let session = null;
  try {
    const scenarios = ['s1', 's2', 's3'].filter(want);
    if (!scenarios.length) throw new Error('没有要跑的场景');
    for (const sc of scenarios) {
      const file = path.join(ROOM, 'cmp-' + sc + '.md');
      fs.writeFileSync(file, DOC, 'utf8');
      session = await peer.launch({ exe: EXE, args: [file], label: 'probe-r9-typora-' + sc, outDir: OUT, killImage: 'Typora.exe' });
      await session.until(`(() => !!document.querySelector('#write table'))()`, { timeout: 30000 });
      await harness.sleep(1200);
      // 表格滚进视口
      await session.eval(`document.querySelector('#write table').scrollIntoView({block:'center'}); 1`);
      await harness.sleep(400);
      const cells = (await session.eval(cellsExpr)).value;
      if (!cells || !cells.甲1) throw new Error('格坐标没取到');

      if (sc === 's1' || sc === 's2') {
        await drag(session, cells.甲1, cells.乙2);
        const selFacts = ((await session.eval(FACTS)).value||{}).选区;
        await session.shot(sc + '-拖选后-full');
        if (sc === 's1') harness.writeClipboard(OUT, 'P11\tP12\nP21\tP22');
        else harness.writeClipboard(OUT, 'XYZ单格');
      } else {
        await session.sendSession('Input.dispatchMouseEvent', { type: 'mousePressed', x: cells.甲1.x, y: cells.甲1.y, button: 'left', buttons: 1, clickCount: 1 });
        await session.sendSession('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cells.甲1.x, y: cells.甲1.y, button: 'left', buttons: 0, clickCount: 1 });
        await harness.sleep(300);
        harness.writeClipboard(OUT, 'P11\tP12\nP21\tP22');
        await session.shot(sc + '-单格光标-full');
      }
      const before = (await session.eval(FACTS)).value;
      await comboCtrlV(session);
      await harness.sleep(1000);
      const after = (await session.eval(FACTS)).value;
      await session.shot(sc + '-粘贴后-full');
      await comboCtrlS(session);
      await harness.sleep(1200);
      const md = fs.readFileSync(file, 'utf8');
      report(sc, 'EVIDENCE', {
        场景: sc === 's1' ? 'TSV2x2→2x2跨格选区' : sc === 's2' ? '单格文本→跨格选区' : 'TSV2x2→单格光标',
        粘贴前: before, 粘贴后: after,
        磁盘表行: (md.match(/^\|.*$/gm) || []),
      });
      await session.close(); session = null;
      await harness.sleep(1500);
    }
  } catch (error) {
    report('probe', 'FAIL', { 异常: String(error && error.message || error).slice(0, 300) });
  } finally {
    if (session) { try { await session.close(); } catch {} }
    try { harness.restoreClipboard(OUT, saved.__file); } catch (error) { console.log('剪贴板还原失败：' + error.message); }
    fs.appendFileSync(path.join(OUT, 'trace.txt'), log.join('\n') + '\n', 'utf8');
  }
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('probe-r9-typora 失败：', error); process.exit(1); });
