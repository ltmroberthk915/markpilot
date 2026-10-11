/** 探针 · R9 F 门（Shift+End 塌 marker 定点复现，H2-挂起复审 §4 坐标，E9 §F 先测后定）。
 *
 *  形状 a（标题序列塌缩）：`## 标题行五个字`，起点=标题文本节点 offset 1（「题」字左侧），
 *    序列 Home → Shift+End → Shift+Home 三键真键，每步读 anchor/focus（节点类型/层级/
 *    offset）+ 选区文本 + 高亮 rect + 2x 截图。
 *    红 = 末步选区文本塌成只有 "##"（或纯 #/空白，无标题正文），或 focus 0×0/元素级。
 *  形状 b（孤岛段行端解析）：`前后 $x=1$ 后续`，起点=岛前正文文本 offset 0（「前」字首），
 *    一键 Shift+End。红 = focus 元素级/0×0/落在 marker 或岛内，或高亮 rect 盖不到正文尾。
 *
 *  通道纪律：定位起点用固定坐标（H2 备好），三键/一键全部 CDP 真键（组合键=修饰键真实
 *  按下再抬起）；每步先断言焦点在编辑器。判读标记：红实线=focus 落点、琥珀虚线=行尾应有
 *  的 focus 位、青虚线=anchor。
 *
 *  用法：node scripts/acceptance/probe-r9-extend.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-r9-extend');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');
const IF = hi.IF, S = hi.SURFACE;

const DOC = ['# R9F Shift+End 塌缩复现', '',
  '## 标题行五个字', '',
  '前后 $x=1$ 后续', '',
  '收尾段：两行隔开。', ''].join('\n');

// ─── 页内工具 ────────────────────────────────────────────────────────────────
const MARK_INSTALL = `(() => { const w = ${IF}; const d = w.document;
  w.__r9f = { mark(list) { const old = d.getElementById('__r9f_marks'); if (old) old.remove();
    if (!list || !list.length) return 0;
    const layer = d.createElement('div'); layer.id = '__r9f_marks';
    layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    for (const it of list) { if (!it) continue; const el = d.createElement('div');
      if (it.type === 'line') el.style.cssText = 'position:fixed;pointer-events:none;left:' + Math.round(it.x) + 'px;top:' + Math.round(it.y) + 'px;width:2px;height:' + Math.max(2, it.h || 20) + 'px;background:' + it.color;
      else el.style.cssText = 'position:fixed;pointer-events:none;left:' + Math.round(it.x) + 'px;top:' + Math.round(it.y) + 'px;width:' + Math.round(it.w || 4) + 'px;height:' + Math.round(it.h || 20) + 'px;border:1.5px dashed ' + it.color;
      if (it.label) { const t = d.createElement('div'); t.textContent = it.label;
        t.style.cssText = 'position:fixed;pointer-events:none;font:11px/1.2 monospace;white-space:nowrap;left:' + (Math.round(it.x) + 4) + 'px;top:' + (Math.round(it.y) - 14) + 'px;color:' + it.color; layer.appendChild(t); }
      layer.appendChild(el); }
    d.body.appendChild(layer); return list.length; },
    unmark() { const old = d.getElementById('__r9f_marks'); if (old) old.remove(); return 1; } };
  return { ok: true }; })()`;

/** 选区事实：anchor/focus 节点形状（text/element、marker 层）+ 选文 + 高亮 rect。 */
const SEL_READ = `(() => { const w = ${IF}; const d = w.document; const s = w.getSelection();
  if (!s || !s.rangeCount) return { 无选区: true };
  const r = s.getRangeAt(0);
  const layerOf = n => { let at = n; while (at && at.nodeType === 1) {
    if (at.classList && at.classList.contains('vditor-ir__marker')) return 'marker';
    if (at.classList && (at.classList.contains('vditor-ir__node') || at.classList.contains('inline-node'))) return '岛';
    at = at.parentElement; } return '正文'; };
  const desc = n => !n ? null : { 类型: n.nodeType === 3 ? 'text' : 'element', 名: n.nodeName,
    层: n.nodeType === 1 ? layerOf(n) : layerOf(n.parentElement),
    文: n.nodeType === 3 ? JSON.stringify(String(n.textContent).slice(0, 24)) : null };
  const rects = [...r.getClientRects()].map(c => ({ x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height) }));
  return { 折叠: r.collapsed, 选文: JSON.stringify(s.toString()),
    anchor: { ...desc(s.anchorNode), off: s.anchorOffset },
    focus: { ...desc(s.focusNode), off: s.focusOffset },
    高亮rect数: rects.length, 高亮rects: rects.slice(0, 8),
    高亮总宽: rects.reduce((a, c) => a + c.w, 0) }; })()`;

/** 把光标放到「标题文本节点 offset」或「孤岛段首文本节点 offset」（固定坐标，setup 用 JS）。 */
const PLACE = (blockMarker, textIncludes, offset) => `(() => { const w = ${IF}; const d = w.document;
  const root = d.querySelector(${JSON.stringify(S)});
  const block = [...root.children].find(b => b.textContent.includes(${JSON.stringify(blockMarker)}));
  if (!block) return { ok: false, 错: '找不到块' };
  const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node = null;
  while (walker.nextNode()) { const n = walker.currentNode;
    if (n.parentElement.closest('.vditor-ir__marker')) continue;
    if (String(n.textContent).includes(${JSON.stringify(textIncludes)})) { node = n; break; }
    if (!node) node = n; }
  if (!node) return { ok: false, 错: '找不到文本节点' };
  const r = d.createRange(); r.setStart(node, Math.min(${Number(offset)}, node.textContent.length)); r.collapse(true);
  const s = w.getSelection(); s.removeAllRanges(); s.addRange(r);
  const caret = r.getClientRects()[0] || (node.parentElement && node.parentElement.getBoundingClientRect());
  return { ok: true, 节点文: String(node.textContent), rect: caret ? { x: Math.round(caret.x), y: Math.round(caret.y) } : null }; })()`;

/** focus 竖线矩形（折叠时用父元素 rect 兜底）。 */
const CARET_RECT = `(() => { const w = ${IF}; const d = w.document; const s = w.getSelection();
  if (!s || !s.rangeCount) return null; const r = s.getRangeAt(0).cloneRange(); r.collapse(false);
  let rect = r.getClientRects()[0];
  if (!rect) { const n = s.focusNode; const el = n.nodeType === 1 ? n : n.parentElement;
    const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), h: Math.round(b.height), 隐形: b.width === 0 && b.height === 0 }; }
  return { x: Math.round(rect.x), y: Math.round(rect.y), h: Math.round(rect.height), 隐形: false }; })()`;

async function frameOf(session) {
  return await session.js(`(() => { const f = document.getElementById('editor'); const r = f.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
}
const inIF = expression => `(() => { const w = ${IF}; return (${expression}); })()`;

/** 截图：整幅 + anchor 附近 2x（clip 顶层视口坐标）。 */
async function shots(session, frame, anchorVy, name) {
  try {
    const clip = { x: Math.max(0, frame.x + 60), y: Math.max(0, anchorVy - 60), width: Math.min(700, frame.w - 80), height: 200, scale: 2 };
    const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(OUT, name + '-2x.png'), Buffer.from(shot.data, 'base64'));
    await session.shot(name + '-full');
  } catch (error) { console.log('  （截图失败 ' + name + '）'); }
}

async function step(session, frame, label) {
  const sel = await session.js(SEL_READ);
  const caret = await session.js(CARET_RECT);
  // 画标记：红实线=focus 落点；青虚线=anchor；（琥珀虚线=行尾应有位——仅在末步画）
  const marks = [];
  if (caret && !caret.隐形) marks.push({ type: 'line', x: caret.x, y: caret.y, h: caret.h || 20, color: 'red', label: 'focus' });
  if (sel && sel.高亮rects && sel.高亮rects.length) {
    const first = sel.高亮rects[0];
    marks.push({ type: 'box', x: first.x, y: first.y, w: Math.max(6, first.w), h: first.h || 20, color: 'cyan', label: 'anchor侧' });
  }
  await session.js(inIF(`w.__r9f.mark(${JSON.stringify(marks)})`));
  await shots(session, frame, (caret && !caret.隐形) ? caret.y : (sel && sel.高亮rects && sel.高亮rects[0] ? sel.高亮rects[0].y : 200), label);
  await session.js(inIF('w.__r9f.unmark()'));
  return { sel, caret };
}

// ─── 形状 a ──────────────────────────────────────────────────────────────────
async function shapeA(session) {
  const frame = await frameOf(session);
  await hi.ensureFocus(session);
  const placed = await session.js(PLACE('标题行五个字', '标题行五个字', 1));
  if (!placed || !placed.ok) return { verdict: 'FAIL', detail: { 错: '定位失败', placed } };
  await harness.sleep(250);
  const focusOK = await session.js(hi.FOCUS);
  if (!(focusOK && focusOK.ok)) return { verdict: 'FAIL', detail: { 错: '焦点不在编辑器' } };
  const trace = { 起点: placed };
  trace.afterPlace = await step(session, frame, 'A0-起点');

  await hi.press(session, 'Home', { vk: 36 });
  await harness.sleep(300);
  trace.afterHome = await step(session, frame, 'A1-Home后');

  await hi.combo(session, 'Shift+End');
  await harness.sleep(300);
  trace.afterShiftEnd = await step(session, frame, 'A2-ShiftEnd后');

  await hi.combo(session, 'Shift+Home');
  await harness.sleep(300);
  trace.afterShiftHome = await step(session, frame, 'A3-ShiftHome后');

  const fin = trace.afterShiftHome.sel;
  const midSel = trace.afterShiftEnd.sel;
  // 绿判据（Typora 习惯 + E9 §三）：①Shift+End 中拍必须扩出标题正文（不得塌空/塌进标记）；
  // ②末拍 focus 不在 marker 层、光标可见——Home→Shift+End→Shift+Home 的 Typora 终态=
  // 折叠在行首（正文起点），折叠本身不是缺陷；塌进 "## "（focus 层=marker）才是。
  const midOK = midSel && !midSel.折叠 && /标题|行|五|个|字/.test(String(midSel.选文 || ''));
  const endBad = !fin || fin.focus.层 === 'marker' || fin.focus.类型 !== 'text' || (trace.afterShiftHome.caret && trace.afterShiftHome.caret.隐形);
  const red = !midOK || endBad;
  return { verdict: red ? 'RED' : 'GREEN', detail: {
    轨迹: {
      Home后: { 选文: trace.afterHome.sel && trace.afterHome.sel.选文, focus: trace.afterHome.sel && trace.afterHome.sel.focus },
      ShiftEnd后: { 选文: trace.afterShiftEnd.sel && trace.afterShiftEnd.sel.选文, anchor: trace.afterShiftEnd.sel && trace.afterShiftEnd.sel.anchor, focus: trace.afterShiftEnd.sel && trace.afterShiftEnd.sel.focus, 高亮总宽: trace.afterShiftEnd.sel && trace.afterShiftEnd.sel.高亮总宽 },
      ShiftHome后: { 选文: fin && fin.选文, anchor: fin && fin.anchor, focus: fin && fin.focus, 高亮rect数: fin && fin.高亮rect数 },
    },
    红判据: { 中拍扩展无效: !midOK, 末拍focus塌进marker或坏位: endBad },
    定性: red ? '复现：Shift+End 扩展被吞 / 选区塌进 marker 层 / focus 落坏位' : '过门：中拍扩出标题正文、末拍 focus 在正文（Typora 终态=折叠行首）',
  } };
}

// ─── 形状 b ──────────────────────────────────────────────────────────────────
async function shapeB(session) {
  const frame = await frameOf(session);
  await hi.ensureFocus(session);
  const placed = await session.js(PLACE('后续', '前后', 0));
  if (!placed || !placed.ok) return { verdict: 'FAIL', detail: { 错: '定位失败', placed } };
  await harness.sleep(250);
  const focusOK = await session.js(hi.FOCUS);
  if (!(focusOK && focusOK.ok)) return { verdict: 'FAIL', detail: { 错: '焦点不在编辑器' } };
  const trace = { 起点: placed };
  trace.afterPlace = await step(session, frame, 'B0-起点');

  await hi.combo(session, 'Shift+End');
  await harness.sleep(300);
  trace.afterShiftEnd = await step(session, frame, 'B1-ShiftEnd后');

  const fin = trace.afterShiftEnd.sel;
  // 红判据：focus 元素级/0×0/marker 或岛内；或高亮盖不到「后续」正文尾。
  const focus = fin && fin.focus;
  const focusBad = !fin || !focus || focus.类型 !== 'text' || (trace.afterShiftEnd.caret && trace.afterShiftEnd.caret.隐形);
  const coversEnd = fin && /前后|后续/.test(String(fin.选文 || '')) && String(fin.选文 || '').includes('后续');
  const red = focusBad || !coversEnd;
  return { verdict: red ? 'RED' : 'GREEN', detail: {
    轨迹: {
      ShiftEnd后: { 选文: fin && fin.选文, anchor: fin && fin.anchor, focus, 高亮总宽: fin && fin.高亮总宽, 高亮rects: fin && fin.高亮rects },
      caret: trace.afterShiftEnd.caret,
    },
    红判据: { focus坏位: focusBad, 高亮缺正文尾: !coversEnd },
    定性: red ? '复现：行端在孤岛附近解析进坏位/高亮塌陷' : '不复现：focus 在正文文本、高亮盖到正文尾',
  } };
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────
(async () => {
  if (process.argv.includes('--fresh')) fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const log = [];
  const report = (name, verdict, detail) => {
    const line = 'R9EXT ' + name + ' ' + verdict + ' ' + JSON.stringify(detail);
    console.log(line); log.push(line);
  };
  const file = path.join(OUT, 'r9-extend.md');
  fs.writeFileSync(file, DOC, 'utf8');
  const ctx = {
    launch: options => harness.launch({ exe: EXE, appArgs: [APP_MAIN], label: 'probe-r9-extend', outDir: OUT, timeout: 120000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  let session = null;
  try {
    session = await hi.openDoc(ctx, file, { minBlocks: 4, settleMs: 1800, timeout: 100000 });
    const installed = await session.js(MARK_INSTALL);
    if (!installed || !installed.ok) throw new Error('页内工具装载失败');
    let out = await shapeA(session); report('F-a-标题塌缩', out.verdict, out.detail);
    out = await shapeB(session); report('F-b-孤岛行端', out.verdict, out.detail);
  } catch (error) {
    report('probe', 'FAIL', { 异常: String(error && error.message || error).slice(0, 400) });
  } finally {
    if (session) { try { await ctx.release(session); } catch {} }
    fs.appendFileSync(path.join(OUT, 'trace.txt'), log.join('\n') + '\n', 'utf8');
  }
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
  process.exitCode = log.some(l => l.includes(' FAIL ')) ? 1 : 0;
})().catch(error => { console.error('probe-r9-extend 失败：', error); process.exit(1); });
