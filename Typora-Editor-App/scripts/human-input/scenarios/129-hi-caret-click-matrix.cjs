/** 129 · 光标点击精确矩阵：混排行逐字符点击（中文字形要求精确、英文字形容差 ±1）、
 *  行尾右侧空白、块左缘、标题井号区、相邻公式夹缝。
 *
 *  独立口径：期望落点不看产品逻辑，只按"点在哪个字形的左缘，光标就该落在这个字
 *  之前"用逐字符 Range 盒几何算出来；实际落点用"块内全文前缀"比较，两端同源、
 *  逐字符可比。中文是宽字形，必须分毫不差；英文窄字形允许 ±1 个字符。
 */
'use strict';
const hi = require('../hi.cjs');

const BODY = [
  '# 点击矩阵标题',
  '',
  '甲乙丙丁english戊己庚辛$x+y=z$壬癸子丑$a-b=c$寅卯辰巳午未申酉戌亥尾巴。',
  '',
].join('\n');

/** 块内公式源码节点的边界（在全文拼接里的 abs 偏移），用来算"夹缝落点"的合法集合。 */
const MATH_BOUNDS = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
  const block = s.children[1]; if (!block) return null;
  const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node; let abs = 0; const bounds = [];
  while (node = walker.nextNode()) {
    const inMath = !!(node.parentElement && node.parentElement.closest('code[data-type]'));
    if (inMath) bounds.push({ 前: abs, 后: abs + node.data.length, 源码: node.data });
    abs += node.data.length;
  }
  return { 全文长: abs, bounds }; })()`;

module.exports = {
  id: '129-hi-caret-click-matrix',
  title: '点击矩阵：逐字点击落点精确（中文零误差/英文±1）、行尾空白钳行尾、块左缘、公式夹缝不落源码中间',
  run: async ctx => {
    const file = hi.writeDoc('caret-click-matrix.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 2 });
    try {
      const md0 = String(await hi.mdNow(session));
      ctx.assert('文档打开', md0.includes('甲乙丙丁'), md0.slice(0, 40));
      const focus = await hi.ensureFocus(session);
      ctx.assert('焦点在编辑器', focus.ok, JSON.stringify(focus));

      const chars = await session.js(hi.CHARS_OF(1));
      ctx.assert('拿到逐字符盒（前置）', chars && chars.ok && chars.chars.length > 20, JSON.stringify(chars && chars.chars && chars.chars.length));
      const cjk = chars.chars.filter(entry => /[^\x00-\x7F]/.test(entry.ch));
      const ascii = chars.chars.filter(entry => /[a-z]/.test(entry.ch));
      ctx.witness('几何：混排行的字符盒样本', { 总数: chars.chars.length, 中文: cjk.length, 英文: ascii.length }, 'geometry');

      // ══ ① 中文宽字形：点左缘 +1px，前缀必须分毫不差 ═══════════════════════════
      let cjkBad = [];
      const cjkSample = cjk.filter((_, i) => i % 2 === 0).slice(0, 12);
      for (const entry of cjkSample) {
        await session.click(entry.left + 1, entry.y);
        await hi.sleep(140);
        const prefix = await hi.caretPrefix(session);
        const expected = chars.text.slice(0, entry.abs);
        if (prefix !== expected) cjkBad.push({ 字: entry.ch, 期望前缀长: expected.length, 实际前缀长: prefix === null ? -1 : prefix.length, 实际尾: prefix === null ? '(丢)' : prefix.slice(-6) });
      }
      ctx.assert('① 中文 12 处点击全部精确（前缀零误差）', cjkBad.length === 0, JSON.stringify(cjkBad.slice(0, 4)));

      // ══ ② 英文窄字形：点左缘，允许 ±1 字符 ═════════════════════════════════════
      let asciiBad = [];
      for (const entry of ascii.slice(0, 5)) {
        await session.click(entry.left + 1, entry.y);
        await hi.sleep(140);
        const prefix = await hi.caretPrefix(session);
        if (prefix === null || Math.abs(prefix.length - entry.abs) > 1) asciiBad.push({ 字: entry.ch, 期望: entry.abs, 实际: prefix === null ? -1 : prefix.length });
      }
      ctx.assert('② 英文 5 处点击落点 ≤±1 字符', asciiBad.length === 0, JSON.stringify(asciiBad));
      await session.shot('129-click-matrix');

      // ══ ③ 行尾右侧空白：钳到行尾（不进下一块/不进公式源码） ═════════════════════
      const lastChar = chars.chars[chars.chars.length - 1];
      await session.click(lastChar.right + 30, lastChar.y);
      await hi.sleep(250);
      let prefix = await hi.caretPrefix(session);
      let info = await hi.caret(session);
      ctx.witness('几何：行尾右侧空白点击', { 前缀长: prefix ? prefix.length : -1, 块: info.块 }, 'geometry');
      ctx.assert('③ 行尾空白点击钳到本块行尾', prefix === chars.text && info.块 === 1,
        JSON.stringify({ 实际前缀长: prefix ? prefix.length : -1, 期望: chars.text.length, 块: info.块 }));

      // ══ ④ 块左缘（正文左边的空白）：钳到块首 ════════════════════════════════════
      const firstChar = chars.chars[0];
      await session.click(firstChar.left - 8, firstChar.y);
      await hi.sleep(250);
      prefix = await hi.caretPrefix(session);
      info = await hi.caret(session);
      ctx.witness('几何：块左缘点击', { 前缀长: prefix ? prefix.length : -1, 块: info.块, 层: info.层 }, 'geometry');
      ctx.assert('④ 块左缘点击钳到块首（前缀 ≤2、光标不丢）', info.ok && prefix !== null && prefix.length <= 2,
        JSON.stringify({ 前缀长: prefix ? prefix.length : -1, info }));

      // ══ ⑤ 标题井号区左侧：光标落标题文字首 ══════════════════════════════════════
      const headChars = await session.js(hi.CHARS_OF(0));
      if (headChars.ok && headChars.chars.length) {
        const first = headChars.chars[0];
        await session.click(first.left - 6, first.y);
        await hi.sleep(250);
        const headPrefix = await hi.caretPrefix(session);
        const headInfo = await hi.caret(session);
        ctx.witness('几何：标题左缘点击', { 前缀长: headPrefix ? headPrefix.length : -1, 块: headInfo.块 }, 'geometry');
        ctx.assert('⑤ 标题左缘点击光标落标题文字首（不消失、不跳正文）',
          headInfo.ok && headInfo.块 === 0 && headPrefix !== null && headPrefix.length <= 1, JSON.stringify(headInfo));
      }

      // ══ ⑥ 贴公式右缘 +1px：只能落在"源码末尾 / 紧邻其后的正文首字"两个边界 ═══════
      const bounds = await session.js(MATH_BOUNDS);
      if (bounds && bounds.bounds.length >= 1) {
        const edge = await session.js(`(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
          const block = d.querySelector('${hi.SURFACE}').children[1];
          const preview = block.querySelector('.vditor-ir__preview');
          if (!preview) return { ok: false };
          const r = preview.getBoundingClientRect();
          return { ok: true, x: Math.round(fr.x + r.right) + 1, y: Math.round(fr.y + r.top + r.height / 2), 右缘: Math.round(r.right) }; })()`);
        if (edge.ok) {
          await session.click(edge.x, edge.y);
          await hi.sleep(250);
          const edgePrefix = await hi.caretPrefix(session);
          // 合法集合：公式源码末尾（展开时光标落源码尾）+ 紧邻公式的第一个正文首字（几何上找右缘 +6px 内的首个正文字符）
          const nextPlain = chars.chars.find(entry => entry.left >= edge.右缘 - 3 && entry.left <= edge.右缘 + 40);
          const legal = new Set([bounds.bounds[0].后]);
          if (nextPlain) legal.add(nextPlain.abs);
          ctx.witness('几何：贴公式右缘点击', { 点: edge.x, 右缘: edge.右缘, 前缀长: edgePrefix ? edgePrefix.length : -1, 合法: [...legal] }, 'geometry');
          ctx.assert('⑥ 贴右缘点击落在边界（源码尾或紧邻正文首字），不落进源码中间',
            edgePrefix !== null && legal.has(edgePrefix.length),
            JSON.stringify({ 实际前缀长: edgePrefix ? edgePrefix.length : -1, 合法: [...legal] }));
        } else {
          ctx.log('⑥ 没读到公式预览盒：' + JSON.stringify(edge));
        }
      } else {
        ctx.log('⑥ 没读到公式边界：' + JSON.stringify(bounds));
      }

      // ══ ⑦ 磁盘证人：全程零编辑 ══════════════════════════════════════════════════
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const disk = String(saved.after).replace(/\r/g, '');
      ctx.witness('磁盘：点击全程零编辑', { 磁盘长: disk.length }, 'disk');
      ctx.assert('⑦ 磁盘 == 原文', disk.replace(/\n+$/, '') === BODY.replace(/\n+$/, ''), disk.slice(0, 50));
    } finally {
      await ctx.release(session);
    }
  },
};
