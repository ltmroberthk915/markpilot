/** 128 · 键盘长按连发（autoRepeat）：↓/↑ 长按的目标列、→ 长按穿越公式、
 *  Backspace 长按逐字删、Shift+→ 长按逐字选。
 *
 *  真人"按住不放"会产生 autoRepeat 的连发 keydown；harness 的 session.key 是
 *  down+up 原子对，此前所有场景都发不出"按住"。本场景用 rawKeyDown+autoRepeat
 *  连发再 keyUp，专抓连发路径上的状态机 bug（目标列丢失、连删越界、选区回缩）。
 */
'use strict';
const hi = require('../hi.cjs');

const LINES = Array.from({ length: 16 }, (_, i) => `L${String(i + 1).padStart(2, '0')} 甲乙丙丁戊己庚辛壬癸`);
const MATH_LINE = 'M01 前文$x+y=z$后文尾巴长一点点的字';
const ASCII_LINE = 'A01 englishlineabcdefghijkmnopqrstuvwxyz尾巴';
const LAST_LINE = 'L99 收尾专用尾巴文字有长度';
const BODY = [...LINES, MATH_LINE, ASCII_LINE, LAST_LINE].join('\n\n') + '\n';
const LAST_INDEX = LINES.length + 2; // 0..15 行，16 数学行，17 ASCII 行，18 最后行

module.exports = {
  id: '128-hi-keyhold-repeat',
  title: '长按连发：↓/↑ 保目标列、→ 穿公式到行尾、Backspace 恰删 N 字、Shift+→ 逐字选区只增',
  run: async ctx => {
    const file = hi.writeDoc('keyhold-repeat.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 18 });
    try {
      const md0 = String(await hi.mdNow(session));
      ctx.assert('文档打开（19 块）', md0.includes('L01 ') && md0.includes(LAST_LINE), `源码长度 ${md0.length}`);
      const focus = await hi.ensureFocus(session);
      ctx.assert('焦点在编辑器', focus.ok, JSON.stringify(focus));

      // ══ ① 长按 ↓ 到底：目标列保持 ═════════════════════════════════════════════
      const placed = await session.js(hi.placeCaretAt(2, 4));   // 第 3 行（L03），'L03 '之后
      ctx.assert('① 光标放到第 3 行列 5（前置）', placed.ok, JSON.stringify(placed));
      await hi.sleep(150);
      const startX = (await hi.caret(session)).x;
      await hi.hold(session, 'ArrowDown', { times: 17, interval: 60 });
      await hi.sleep(400);
      const bottom = await hi.caret(session);
      ctx.witness('几何：长按 ↓ 到底后的光标', { 出发x: startX, ...bottom }, 'geometry');
      ctx.assert('① 长按 ↓ 一步一步落到最后一块（没丢、没飞出）',
        bottom.ok && bottom.块 === LAST_INDEX, JSON.stringify(bottom));
      ctx.assert('① 目标列保持（到底后 x 与出发一致 ±5px）',
        Math.abs(bottom.x - startX) <= 5, `出发 x=${startX} 到底 x=${bottom.x}`);

      // ══ ② 长按 ↑ 回顶：列仍保持 ═══════════════════════════════════════════════
      // 回程发数按**实测的下行步数**取（不是写死 17）：素材 19 块，从块 2 往下 17 发里
      // 有 1-2 发落在文末原地不动，只有按实际走了多少行回程才谈得上"原路返回"
      // （2026-09-23 校正：旧口径写死 17 发，修好 F4 前后两种实现下都算不平）。
      const 下行步数 = bottom.块 - 2;
      await hi.hold(session, 'ArrowUp', { times: 下行步数, interval: 60 });
      await hi.sleep(400);
      const top = await hi.caret(session);
      ctx.witness('几何：长按 ↑ 回顶后的光标', { 下行步数, ...top }, 'geometry');
      ctx.assert('② 长按 ↑ 原路回到第 3 行（同一块、同一列）',
        top.ok && top.块 === 2 && Math.abs(top.x - startX) <= 5, JSON.stringify({ 出发x: startX, 下行步数, top }));

      // ══ ③ 长按 → 穿越行内公式到行尾 ═══════════════════════════════════════════
      await session.js(hi.placeCaretAt(LINES.length, 0));   // 数学行行首
      await hi.sleep(150);
      // 发数按"行内字符数"算不准（源码与渲染产物混在一行里），改成**真人式长按**：
      // 一直按住 → 到行尾就松手（连发流仍是 down + autoRepeat + up，只是停止条件由读数决定）。
      // 每一发都采样层次，顺带钉住"途中确实进过公式源码、没有整块跳过去"。
      const layers = [];
      await hi.keyDown(session, 'ArrowRight');
      for (let i = 0; i < 40; i++) {
        await hi.sleep(55);
        await hi.keyDown(session, 'ArrowRight', { autoRepeat: true });
        const info = await hi.caret(session);
        layers.push({ 发: i + 1, 块: info.块, 层: info.层, 偏移: info.偏移, 前缀: info.前缀 });
        if (info.ok && info.块 === LINES.length && String(info.前缀).endsWith('的字')) break;
      }
      await hi.keyUp(session, 'ArrowRight');
      await hi.sleep(400);
      const endInfo = await hi.caret(session);
      ctx.witness('几何：长按 → 逐发层次与终点', { 发数: layers.length, 途中进过源码: layers.some(l => l.层 === '源码'), 终点: endInfo }, 'geometry');
      ctx.assert('③ 长按 → 穿过公式后停在**本行行尾**（同块、正文层、没卡死在源码里）',
        endInfo.ok && endInfo.块 === LINES.length && endInfo.层 === '正文' && endInfo.前缀.endsWith('的字'),
        JSON.stringify(endInfo));
      ctx.assert('③ 长按 → 途中确实进过公式源码（是"穿过去"，不是整块跳过去）',
        layers.some(l => l.层 === '源码') && !layers.some(l => l.层 === '围栏'),
        JSON.stringify(layers.filter(l => l.层 !== '正文').slice(0, 6)));

      // ══ ④ 长按 Backspace：恰删 N 个字符，只删本行 ════════════════════════════
      await session.js(hi.placeCaretAt(LAST_INDEX, 8));
      await hi.sleep(150);
      await hi.hold(session, 'Backspace', { times: 6, interval: 70 });
      await hi.sleep(400);
      const mdDel = String(await hi.mdNow(session));
      const expectedLine = LAST_LINE.slice(0, 8 - 6) + LAST_LINE.slice(8);
      ctx.witness('几何：长按退格 6 次后的行', { 行: mdDel.split('\n').find(l => l.includes('最后')) }, 'geometry');
      ctx.assert('④ 长按 Backspace×6 恰删 6 个字符（本行变成预期形态）',
        mdDel.includes(expectedLine) && !mdDel.includes(LAST_LINE), `期望行=${expectedLine}，实际=${mdDel.split('\n').find(l => l.includes('最后'))}`);
      const othersIntact = LINES.every((line, i) => mdDel.includes(line)) && mdDel.includes(MATH_LINE) && mdDel.includes(ASCII_LINE);
      ctx.assert('④ 其它行一个字符没动', othersIntact, '有别的行被动了');
      const caretDel = await hi.caret(session);
      ctx.assert('④ 连删后光标还在编辑器里', caretDel.ok, JSON.stringify(caretDel));

      // ══ ⑤ 长按 Shift+→：逐字选区、长度恰为连发次数 ════════════════════════════
      await session.js(hi.placeCaretAt(LINES.length + 1, 0));   // ASCII 行行首
      await hi.sleep(150);
      const lens = [];
      await hi.hold(session, 'ArrowRight', { times: 10, interval: 60, modifiers: hi.MOD.shift, onEvery: { every: 2, run: async () => {
        const info = await hi.caret(session);
        lens.push(info.选区长);
      } } });
      await hi.sleep(300);
      const sel = await hi.caret(session);
      ctx.witness('几何：长按 Shift+→ 的选区长度序列', { lens, 终值: sel.选区长, 选区: sel.选区 }, 'geometry');
      ctx.assert('⑤ 长按 Shift+→×10 选区恰为 10 个字符', sel.选区长 === 10, `实际 ${sel.选区长}`);
      ctx.assert('⑤ 采样序列只增不减', lens.every((v, i) => i === 0 || v >= lens[i - 1]), JSON.stringify(lens));
      await hi.press(session, 'Escape');
      await hi.sleep(200);

      // ══ ⑥ 收尾：撤销 + 磁盘 ════════════════════════════════════════════════════
      for (let i = 0; i < 10; i++) { await hi.combo(session, 'Ctrl+Z'); await hi.sleep(240); }
      const finalMd = String(await hi.mdNow(session));
      ctx.assert('⑥ 撤销链退回原稿', finalMd === md0, finalMd.slice(0, 60));
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const disk = String(saved.after).replace(/\r/g, '');
      ctx.witness('磁盘：保存', { 磁盘长: disk.length }, 'disk');
      ctx.assert('⑥ 磁盘 == 原文', disk.replace(/\n+$/, '') === BODY.replace(/\n+$/, ''), disk.slice(0, 60));
    } finally {
      await ctx.release(session);
    }
  },
};
