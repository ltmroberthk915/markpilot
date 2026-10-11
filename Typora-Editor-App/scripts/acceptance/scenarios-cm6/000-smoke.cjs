/** 000-smoke —— CM6 基建冒烟（Tier-1 引擎档，r20 移植 P0 基建验收门）。
 *
 *  守什么：探针层（probe.cjs）/宿主页（host/index.html）/runner（--target=dsh-web）
 *  三件套本身能开出一条可判定的验收路——后续 P0 全部场景踩在这条路上。
 *
 *  判据（用户可见）：
 *    1) 宿主页经桥协议 open 注入的文档在编辑面逐字节就位（getValue === DOC）；
 *    2) 中立块模型把 标题/空行/段落(行内公式)/列表/块公式围栏 分型正确、行域正确；
 *    3) 光标程序化落位 → 读数（行/列/前缀/折叠/矩形）；真实按键（CDP Input）推进一列；
 *    4) 选区播种 → 读数文本=源码切片、非折叠、矩形非空；
 *    5) 投影在位（行内公式 $a+b=c$ 有 widget、tex 正确）——N1 族的探针先导。
 *
 *  通道纪律：程序化落位只做前置；动作（ArrowRight）走 CDP Input.dispatchKeyEvent
 *  （hi.press 原语零改动复用）；按键前焦点闸门必过。
 *
 *  突变点：把 probe.placeAt 的 dispatch 注掉 → 断言 3 红；把宿主页 open 下行注掉
 *  → 断言 1 红（engine 永不 boot，readyExpr 超时）。
 *
 *  证人：geometry（光标矩形 + 选区矩形，页级坐标，独立于产品自报）。
 *  素材：现场生成（Tier-1 无保存链，磁盘类断言一律 Tier-2——本场景磁盘无关）。
 */
'use strict';
const { mkProbe } = require('../harness-cm6/probe.cjs');
const hi = require('../../human-input/hi.cjs');

const DOC = [
  '# 一级标题甲',
  '',
  '段落一行，含行内公式 $a+b=c$ 在中间。',
  '',
  '- 列表项一',
  '- 列表项二',
  '- 列表项三',
  '',
  '$$',
  'E = m c^2',
  '$$',
  '',
  '## 收尾标题乙',
].join('\n');

const WANT_TYPES = ['heading', 'blank', 'para', 'blank', 'list', 'blank', 'mathblock', 'blank', 'heading'];

module.exports = {
  id: '000-smoke',
  title: 'CM6 探针冒烟（Tier-1：宿主页注入→光标/块/选区三读数）',
  packs: ['core'],
  engines: ['cm6'],
  tier: 1,

  async run(ctx) {
    const started = Date.now();
    const session = await ctx.launch({ text: DOC });
    const P = mkProbe('cm6', { frame: session.engineFrameExpr() });

    // ── 1) 引擎 boot + 文档就位 ──
    const ready = await session.until(P.readyExpr(DOC.length), { timeout: 20000, interval: 80 });
    ctx.assert('引擎 boot 且文档长度就位（宿主页桥 open）', ready, `readyExpr(${DOC.length})`);
    await hi.sleep(300); // KaTeX 投影渲染安定
    const value = await P.getValue(session);
    ctx.assert('getValue === 注入文档（逐字节）', value === DOC, JSON.stringify({ got: value && value.length, want: DOC.length }));
    ctx.witness('注入文档经产品桥 open 通道到位（产品自报，非独立）', { len: DOC.length, bytes: value === DOC });

    // ── 2) 中立块模型 ──
    const bs = await P.blocks(session);
    const types = (bs.blocks || []).map(b => b.type);
    ctx.assert('块分型序列正确（标题/空行/段落/列表/块公式）', JSON.stringify(types) === JSON.stringify(WANT_TYPES), types.join(','));
    const markers = { h1: bs.blocks[0].marker, li: bs.blocks[4].marker, h2: bs.blocks[8].marker };
    ctx.assert('块标记（# / - / ##）', markers.h1 === '#' && markers.li === '-' && markers.h2 === '##', JSON.stringify(markers));
    const mb = bs.blocks[6];
    ctx.assert('块公式围栏行域 = 行 9..11', mb.firstLine === 9 && mb.lastLine === 11 && mb.lineFrom < mb.lineTo, JSON.stringify({ first: mb.firstLine, last: mb.lastLine }));

    // ── 3) 光标：落位 → 读数 → 真实按键 ──
    const gate = await P.ensureFocus(session);
    ctx.assert('焦点闸门（帧 document.hasFocus + view.hasFocus + contentDOM）', gate.ok, JSON.stringify(gate));
    const placed = await P.placeAt(session, { block: 2, offset: 4 }); // 段落块（行 3）列 4
    ctx.assert('程序化落位：段落块列 4（mpEngine._view 前置）', placed.ok && placed.line === 3 && placed.col === 4, JSON.stringify(placed));
    const c1 = await P.getCursor(session);
    ctx.assert('光标读数：行 3 / 列 4 / 前缀=段落一行 / 折叠', c1.line === 3 && c1.col === 4 && c1.prefix20 === '段落一行' && c1.collapsed === true,
      JSON.stringify({ line: c1.line, col: c1.col, prefix20: c1.prefix20, collapsed: c1.collapsed }));
    ctx.assert('光标矩形非 0×0（.cm-cursor 页级几何）', !!(c1.visibleRect && c1.visibleRect.h > 4 && c1.visibleRect.y >= 0), JSON.stringify(c1.visibleRect));
    ctx.witness('光标矩形（页级坐标，几何证人）', c1.visibleRect, 'geometry');
    await hi.press(session, 'ArrowRight'); // CDP Input.dispatchKeyEvent 真实输入
    const gate2 = await P.focusGate(session);
    const c2 = await P.getCursor(session);
    ctx.assert('真实按键 ArrowRight：列 4→5（真实输入通道生效）', gate2.ok && c2.col === 5 && c2.line === 3,
      JSON.stringify({ gateOk: gate2.ok, line: c2.line, col: c2.col }));

    // ── 4) 选区：播种 → 读数 ──
    const seeded = await P.selectText(session, '段落一行', '行内公式');
    ctx.assert('选区播种成功（前缀定位）', seeded.ok && seeded.text === '段落一行，含行内公式', JSON.stringify(seeded).slice(0, 160));
    const s1 = await P.getSelection(session);
    ctx.assert('选区读数：文本=源码切片、非折叠、anchor<head', s1.text === '段落一行，含行内公式' && !s1.collapsed && s1.anchor < s1.head,
      JSON.stringify({ len: s1.text.length, collapsed: s1.collapsed, anchor: s1.anchor, head: s1.head }));
    ctx.assert('选区矩形非空（.cm-selectionBackground 页级几何）', s1.rects.length >= 1 && s1.rects[0].w > 10, JSON.stringify(s1.rects));
    ctx.witness('选区矩形（.cm-selectionBackground 页级几何，独立通道）', s1.rects, 'geometry');

    // ── 5) 投影在位（N1 族先导）+ 桥契约回程腿 ──
    const inlineAt = DOC.indexOf('$a+b=c$');
    const proj = await P.projectionState(session, inlineAt + 3);
    ctx.assert('行内公式投影在位：widget 存在、tex 正确、未让位', proj.ok && proj.hasWidget && proj.span && proj.span.tex === 'a+b=c' && !proj.revealed,
      JSON.stringify({ hasWidget: proj.hasWidget, tex: proj.span && proj.span.tex, revealed: proj.revealed }));
    const host = await session.js('window.__mpHost');
    ctx.assert('桥契约：init 已收、open 已发、boot 判定', host.booted && host.sent.open >= 1 && host.received.init >= 1,
      JSON.stringify({ booted: host.booted, open: host.sent.open, init: host.received.init }));
    await session.js(`(() => { document.getElementById('mp-frame').contentWindow.postMessage({ __dshmp: true, dir: 'down', type: 'requestText', content: {} }, '*'); return true; })()`);
    const pulled = await session.until(`(() => { const h = window.__mpHost; return !!(h && typeof h.lastText === 'string' && h.lastText.length >= ${DOC.length}); })()`, { timeout: 5000 });
    const lastText = await session.js('window.__mpHost.lastText');
    ctx.assert('桥契约：requestText→text 回程逐字节', pulled && lastText === DOC, `lastText.len=${lastText && lastText.length}`);

    // ── 收尾：截图取证 + 台账 ──
    const shot = await session.shot('smoke-page');
    ctx.log('截图：' + shot);
    ctx.log('bundle 指纹：' + JSON.stringify(session.bundle));
    ctx.metric('cm6-smoke-round-ms', Date.now() - started, { unit: 'ms', note: 'launch→三读数+桥回程全过（P0 从零起建的第一条台账）' });
  },
};
