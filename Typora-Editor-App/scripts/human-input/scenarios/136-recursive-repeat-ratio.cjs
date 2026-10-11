/** 136 ·【递归 F4】长按连发丢步的量化台账：键 × 间隔的丢步率。
 *
 *  反哺自 FINDINGS F4：autoRepeat 连发约 24% 被吞（↓ 17 发只走 13 行、目标列不丢）。
 *  本场景把"丢步"变成可跟踪数字：四种键（↓ / → / Backspace / Shift+→）× 两档间隔
 *  （30ms/60ms）各连发一组，算每组的生效比例进 metric 台账。修复前它是红的
 *  （反哺网），修复后同一张表变绿，退化立刻再见红灯。
 */
'use strict';
const hi = require('../hi.cjs');

const LINES = Array.from({ length: 16 }, (_, i) => `L${String(i + 1).padStart(2, '0')} 甲乙丙丁戊己庚辛壬癸`);
const ASCII_LINE = 'A01 englishlineabcdefghijkmnopqrstuvwxyz尾巴';
const LAST_LINE = 'L99 收尾专用尾巴文字有长度';
const BODY = [...LINES, ASCII_LINE, LAST_LINE].join('\n\n') + '\n';
const ASCII_INDEX = LINES.length;      // 16
const LAST_INDEX = LINES.length + 1;   // 17

module.exports = {
  id: '136-recursive-repeat-ratio',
  title: '【递归F4】连发生效比例台账：↓/→/Backspace/Shift+→ × 30/60ms，丢步率 >10% 即红',
  run: async ctx => {
    const file = hi.writeDoc('repeat-ratio.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 17 });
    try {
      const focus = await hi.ensureFocus(session);
      ctx.assert('焦点在编辑器', focus.ok, JSON.stringify(focus));
      const table = [];

      // ↓：块号位移 / 连发次数（两档间隔）
      //
      // 口径校正（2026-09-23）：**"生效/连发"不能当判据**——素材只有 18 块，从块 2 往下
      // 最多走 15 步，17 发里必然有 1-2 发落在文末（原地不动是对的）。修复前它红是因为
      // **卡在中途**（终点块 15 = L16 行，正是 F4 病象：可视区到底不带滚动）；
      // 修复后应当一路走到文档末块。判据改写成"走到末块 + 光标与目标列不丢"，
      // 生效比例仍进台账当回归读数。
      for (const interval of [60, 30]) {
        await session.js(hi.placeCaretAt(2, 4));
        await hi.sleep(150);
        const 出发 = await hi.caret(session);
        await hi.hold(session, 'ArrowDown', { times: 17, interval });
        await hi.sleep(400);
        const info = await hi.caret(session);
        const effective = Math.max(0, info.块 - 2);
        const ratio = effective / 17;
        table.push({ 键: '↓', 间隔: interval, 连发: 17, 生效: effective, 比例: +ratio.toFixed(2), 终点: `块${info.块}` });
        ctx.metric(`hi.136.连发生效.↓@${interval}ms`, ratio * 100, { unit: '%' });
        ctx.assert(`【递归F4】↓@${interval}ms 连发 17 次一路走到文档末块（不再卡在中途）`,
          info.ok && info.块 === LAST_INDEX, JSON.stringify({ ...table.at(-1), 期望块: LAST_INDEX }));
        ctx.assert(`【递归F4】↓@${interval}ms 连发到底光标不丢、目标列不丢`,
          info.ok && Math.abs(info.x - 出发.x) <= 5, JSON.stringify({ ...table.at(-1), 出发x: 出发.x, 到底x: info.x }));
      }

      // →：长 ASCII 行内前缀位移 / 连发次数
      for (const interval of [60, 30]) {
        await session.js(hi.placeCaretAt(ASCII_INDEX, 0));
        await hi.sleep(150);
        await hi.hold(session, 'ArrowRight', { times: 25, interval });
        await hi.sleep(400);
        const prefix = await hi.caretPrefix(session);
        const effective = prefix === null ? 0 : Math.min(prefix.length, ASCII_LINE.length);
        const ratio = effective / 25;
        table.push({ 键: '→', 间隔: interval, 连发: 25, 生效: effective, 比例: +ratio.toFixed(2) });
        ctx.metric(`hi.136.连发生效.→@${interval}ms`, ratio * 100, { unit: '%' });
        ctx.assert(`【递归F4】→@${interval}ms 连发 25 次生效 ≥90%（不早跳出本行）`, ratio >= 0.9, JSON.stringify(table.at(-1)));
      }

      // Backspace：删掉的字符数 / 连发次数
      await session.js(hi.placeCaretAt(LAST_INDEX, 12));
      await hi.sleep(150);
      const before = await hi.caretPrefix(session);
      await hi.hold(session, 'Backspace', { times: 8, interval: 70 });
      await hi.sleep(400);
      const after = await hi.caretPrefix(session);
      const effectiveDel = before && after ? Math.max(0, before.length - after.length) : 0;
      const ratioDel = effectiveDel / 8;
      table.push({ 键: 'Backspace', 间隔: 70, 连发: 8, 生效: effectiveDel, 比例: +ratioDel.toFixed(2) });
      ctx.metric('hi.136.连发生效.Backspace@70ms', ratioDel * 100, { unit: '%' });
      ctx.assert('【递归F4】Backspace@70ms 连发 8 次恰删 8 字（≥90%）', ratioDel >= 0.9, JSON.stringify(table.at(-1)));

      // Shift+→：选区长度 / 连发次数
      await session.js(hi.placeCaretAt(ASCII_INDEX, 0));
      await hi.sleep(150);
      await hi.hold(session, 'ArrowRight', { times: 12, interval: 60, modifiers: hi.MOD.shift });
      await hi.sleep(400);
      const sel = await hi.caret(session);
      const ratioSel = Math.min(sel.选区长, 12) / 12;
      table.push({ 键: 'Shift+→', 间隔: 60, 连发: 12, 生效: sel.选区长, 比例: +ratioSel.toFixed(2) });
      ctx.metric('hi.136.连发生效.Shift→@60ms', ratioSel * 100, { unit: '%' });
      ctx.assert('【递归F4】Shift+→@60ms 连发 12 次选区恰 12 字（≥90%）', ratioSel >= 0.9, JSON.stringify(table.at(-1)));

      ctx.witness('几何：连发生效比例全表', table, 'geometry');
      // 收尾：撤销链回原稿 + 磁盘
      for (let i = 0; i < 10; i++) { await hi.combo(session, 'Ctrl+Z'); await hi.sleep(240); }
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const diskOk = String(saved.after).replace(/\r/g, '').replace(/\n+$/, '') === BODY.replace(/\n+$/, '');
      ctx.witness('磁盘：撤销后保存', { 长度: String(saved.after).length }, 'disk');
      ctx.assert('收尾：撤销链回原稿、磁盘字节不变', diskOk, String(saved.after).slice(0, 50));
    } finally {
      await ctx.release(session);
    }
  },
};
