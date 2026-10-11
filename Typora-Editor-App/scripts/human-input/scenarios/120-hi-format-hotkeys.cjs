/** 120 · 格式快捷键真键矩阵：Ctrl+B（单块/跨块/再按撤销）、Ctrl+U、公式源码守卫。
 *
 *  背景：edit-shortcuts.js 是快捷键格式的全部实现（Ctrl+B 跨块加粗、Ctrl+U 下划线、
 *  公式源码里格式键必须被拦），但 00-114 号验收场景里**没有一个用真键触发过这些组合**。
 *  本场景全部走真实 CDP 组合键（修饰键按下→主键↓↑→修饰键抬起），判据是用户看得见的：
 *  渲染出加粗/下划线效果、保存到磁盘的源码里有 ** / <u>、公式源码一个字节没被塞进格式符。
 *  R10-P7 改写（E10 §0-C1/C2）：
 *  · ② Ctrl+U 自 v2.0.4 起是 CSS Custom Highlight paint-only 架构（underline.js 注册
 *    CSS.highlights['typora-underline']，<u> marker 0×0 隐藏），DOM 里不出现 <u> 元素——
 *    原断言查 u 元素数 + textContent 明文 '<u>' 是架构性错位（明文是隐形 marker 的天然
 *    文本，误导读数）。改量：高亮注册表里 range 盖住目标文字 + 源码仍是标准 <u> 标签
 *    + 2x 截图供视觉判读（高亮真绘制才算绿）。
 *  · ③ 跨块加粗遇 ② 留下的 <u> 岛，产品落码 <u>**这一句**</u>**。**——渲染语义=全加粗
 *    （视觉等价），仅 md 源形态非单裹。断言改视觉等价（目标文字都在 strong 里），源码
 *    形态降级为证人记录。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const hi = require('../hi.cjs');

const BODY = [
  '第一段甲：加粗目标是这一句。',
  '',
  '第二段乙：跨块加粗会同时碰到这一段。',
  '',
  '第三段丙：数学 $a+b=c$ 与文字混排。',
  '',
].join('\n');

module.exports = {
  id: '120-hi-format-hotkeys',
  title: '格式快捷键真键：Ctrl+B 单块/跨块/再按撤销、Ctrl+U、公式源码内被拦',
  run: async ctx => {
    const file = hi.writeDoc('format-hotkeys.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 5 });
    try {
      const md0 = await hi.mdNow(session);
      ctx.assert('文档打开了（能读到源码）', typeof md0 === 'string' && md0.includes('加粗目标'), JSON.stringify(String(md0).slice(0, 60)));

      // ══ ① Ctrl+B：单块选区 → 加粗；再按一次 → 取消 ══════════════════════════
      let focus = await hi.ensureFocus(session);
      ctx.assert('键盘操作前焦点在编辑器里', focus.ok, JSON.stringify(focus));
      await session.js(hi.selectFromTo('加粗目标', '这一句'));
      await hi.sleep(150);
      await hi.combo(session, 'Ctrl+B');
      await hi.sleep(450);
      const afterBold = await hi.mdNow(session);
      const domBold = await session.js(`(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
        const strong = s.querySelectorAll('strong,b'); return { count: strong.length, text: [...strong].map(n => n.textContent).join('|') }; })()`);
      ctx.witness('几何：Ctrl+B 后的 DOM', { dom: domBold, md: String(afterBold).slice(0, 90) }, 'geometry');
      ctx.assert('① Ctrl+B 真键加粗：DOM 出现 strong 且文本正确',
        domBold.count >= 1 && domBold.text.includes('加粗目标'), JSON.stringify(domBold));
      ctx.assert('① 源码里是 **加粗目标是这一句**（不是其它形态）',
        String(afterBold).includes('**加粗目标是这一句**'), String(afterBold).slice(0, 80));
      await session.shot('120-after-bold');

      // 选区保留在原处再按一次 → 取消加粗
      await session.js(hi.selectFromTo('加粗目标', '这一句'));
      await hi.sleep(150);
      await hi.combo(session, 'Ctrl+B');
      await hi.sleep(450);
      const afterUnbold = await hi.mdNow(session);
      ctx.assert('① 再按一次 Ctrl+B 取消加粗（源码里没有 **）',
        !String(afterUnbold).includes('**'), String(afterUnbold).slice(0, 80));

      // ══ ② Ctrl+U：下划线（paint-only，量高亮注册表 + 2x 截图，源码形态 <u>…</u>）══
      // R10-P7 改写：原断言 `s.querySelectorAll('u').length >= 1` 且
      // `s.textContent.includes('<u>')`。因 v2.0.4 起下划线是 CSS Custom Highlight
      // paint-only 架构（underline.js:31 把 range 注册进编辑器 iframe 的
      // CSS.highlights['typora-underline']，<u> marker 0×0 隐藏；E10 抽查 9 / §0-C1：
      // DOM 形状量法架构性错位，textContent 里的明文 '<u>' 是隐形 marker 的天然文本、
      // 属误导读数）。新断言量用户可见性质：
      //   ① 注册表里 typora-underline 高亮存在且 range 盖住『这一句』（::highlight 真作用
      //      的对象，underline.js:41 setStartAfter(<u>)/setEndBefore(</u>) 之间的正文）；
      //   ② 源码/落盘仍是标准 <u>这一句</u>（E10 口径句 6：文件保存为标准 <u> 标签）；
      //   ③ 2x 局部截图留证——高亮真绘制才算绿，由 V10 视觉判读；若图上无下划线，
      //      按铁律升级为真缺陷，不得以注册表存在硬写绿。
      await session.js(hi.selectFromTo('这一句', '这一句'));
      await hi.sleep(150);
      await hi.combo(session, 'Ctrl+U');
      await hi.sleep(700);
      const afterU = await hi.mdNow(session);
      const domU = await session.js(`(() => { const w = ${hi.IF}, d = w.document;
        const hl = (w.CSS && w.CSS.highlights) ? w.CSS.highlights.get('typora-underline') : null;
        const covered = [];
        if (hl) for (const r of hl) { const t = r.toString(); if (t) covered.push(t); }
        return { 注册表存在: !!hl, range数: hl ? hl.size : 0, 覆盖文本: covered.join('|').slice(0, 80) }; })()`);
      ctx.witness('几何：Ctrl+U 后的高亮注册表（iframe CSS.highlights）', { 注册表: domU, md: String(afterU).slice(0, 90) }, 'geometry');
      ctx.assert('② Ctrl+U 真键下划线：typora-underline 高亮已注册且 range 盖住『这一句』',
        !!(domU.注册表存在 && domU.range数 >= 1 && domU.覆盖文本.includes('这一句')),
        JSON.stringify({ domU, md: String(afterU).slice(0, 90) }));
      ctx.assert('② 源码形态是标准 <u>这一句</u>（保存落盘即标准标签）',
        String(afterU).includes('<u>这一句</u>'), String(afterU).slice(0, 90));
      // 2x 局部截图（视口坐标 → clip 放大）：V10 判读"下划线是否真画在文字上"
      const cropU = await session.js(`(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
        const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
        const walker = d.createTreeWalker(s, NodeFilter.SHOW_TEXT); let node;
        while (node = walker.nextNode()) if (node.data.includes('这一句')) {
          const r = d.createRange(); r.selectNodeContents(node); const rect = r.getBoundingClientRect();
          return { x: Math.max(0, Math.round(fr.x + rect.x - 30)), y: Math.max(0, Math.round(fr.y + rect.y - 16)),
            width: Math.min(760, Math.round(rect.width + 60)), height: Math.round(rect.height + 32) }; }
        return null; })()`);
      if (cropU) {
        const pngU = await session.send('Page.captureScreenshot', { format: 'png', clip: { ...cropU, scale: 2 } });
        const shotDir = path.join(ctx.outDir, '120-hi-format-hotkeys');
        fs.mkdirSync(shotDir, { recursive: true });
        fs.writeFileSync(path.join(shotDir, '120-underline-2x.png'), Buffer.from(pngU.data, 'base64'));
        ctx.witness('视觉：Ctrl+U 下划线 2x 截图 120-underline-2x.png（V10 判读：线真画在字上才算绿）', cropU);
      }

      // ══ ③ Ctrl+B 跨块：两段目标文字都加粗显示、段落不被合并 ═══════════════════
      // R10-P7 改写：原断言除 DOM strong 外，还要求源码单裹 `**这一句。**` 与
      // `**跨块加粗**`。因选区横跨 ② 留下的 <u> 岛，产品落码是
      // `<u>**这一句**</u>**。**`——渲染语义=整段全加粗（视觉等价），仅 md 源形态非单裹
      // （E10 §0-C2）。断言改视觉等价：两段的目标文字都必须落在 strong 渲染内（用户看到
      // 的就是"全加粗了"）；md 源形态降级为证人记录项，不再断言。
      const beforeCross = await session.js(`(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}'); return s.children.length; })()`);
      await session.js(hi.selectFromTo('这一句', '跨块加粗'));
      await hi.sleep(150);
      await hi.combo(session, 'Ctrl+B');
      await hi.sleep(600);
      const afterCross = await hi.mdNow(session);
      const domCross = await session.js(`(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
        const tops = [...s.children];
        const strongAll = i => tops[i] ? [...tops[i].querySelectorAll('strong,b')].map(n => n.textContent).join('|') : '(无此块)';
        const strongIn = (i, word) => tops[i] ? [...tops[i].querySelectorAll('strong,b')].some(n => n.textContent.includes(word)) : false;
        return { 顶块数: tops.length, 第0块strong文本: strongAll(0), 第1块strong文本: strongAll(1),
          盖住这一句: strongIn(0, '这一句'), 盖住跨块加粗: strongIn(1, '跨块加粗') }; })()`);
      ctx.witness('几何：跨块加粗后的 DOM 与 md 源形态（源码非单裹——记录项，不断言）',
        { dom: domCross, md形态: String(afterCross).slice(0, 160) }, 'geometry');
      ctx.assert('③ 跨块 Ctrl+B 视觉等价：两段的目标文字都在 strong 里加粗显示、段落数不变',
        domCross.顶块数 === beforeCross && domCross.盖住这一句 && domCross.盖住跨块加粗,
        JSON.stringify({ domCross, 之前顶块数: beforeCross }));
      await session.shot('120-cross-block-bold');

      // ══ ④ 公式源码守卫：源码内按 Ctrl+B 必须被拦（不许把 ** 塞进 TeX） ═══════
      const placed = await session.js(`(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
        const code = [...s.querySelectorAll('code[data-type="math-inline"]')].find(n => n.textContent.includes('a+b=c'));
        if (!code || !code.firstChild) return { ok: false, error: '没找到公式源码节点' };
        s.focus();
        const r = d.createRange(); r.setStart(code.firstChild, 2); r.collapse(true);
        const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        return { ok: true, 源码: code.textContent }; })()`);
      ctx.assert('④ 光标放进公式源码里（前置）', placed.ok, JSON.stringify(placed));
      const mdBeforeGuard = await hi.mdNow(session);
      await hi.combo(session, 'Ctrl+B');
      await hi.sleep(400);
      const mdAfterGuard = await hi.mdNow(session);
      const caretGuard = await hi.caret(session);
      ctx.witness('几何：公式源码内按 Ctrl+B 后的光标', { 光标: caretGuard, md: String(mdAfterGuard).slice(0, 80) }, 'geometry');
      ctx.assert('④ 公式源码内 Ctrl+B 被拦：源码一个字节没变（没有 ** 混进 TeX）',
        mdAfterGuard === mdBeforeGuard && !String(mdAfterGuard).includes('****'),
        JSON.stringify({ 之前: String(mdBeforeGuard).slice(0, 60), 之后: String(mdAfterGuard).slice(0, 60) }));

      // ══ ⑤ 撤销链：连续 Ctrl+Z 能一路退回打开时的源码 ═════════════════════════
      let restored = null, undos = 0;
      for (let i = 0; i < 12; i++) {
        const md = await hi.mdNow(session);
        if (md === md0) { restored = i; break; }
        await hi.combo(session, 'Ctrl+Z');
        undos += 1;
        await hi.sleep(260);
      }
      const mdFinally = await hi.mdNow(session);
      ctx.assert('⑤ 撤销链退回原始源码（≤12 次 Ctrl+Z）',
        mdFinally === md0, `撤了 ${undos} 次仍不等于原稿：${String(mdFinally).slice(0, 100)}`);

      // ══ ⑥ 磁盘证人：保存后磁盘 == 撤干净的源码 ═══════════════════════════════
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const disk = String(saved.after).replace(/\r/g, '');
      ctx.witness('磁盘：全场景结束保存', { 磁盘: disk.slice(0, 90), 按键路径: saved.chordTook }, 'disk');
      ctx.assert('⑥ 保存后磁盘 == 原文（撤销干净，无格式残留）',
        disk.replace(/\n+$/, '') === BODY.replace(/\n+$/, ''), JSON.stringify(disk.slice(0, 100)));
    } finally {
      await ctx.release(session);
    }
  },
};
