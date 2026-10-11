/** 125 · 页面级导航真键：PageUp/PageDown、Home/End（软换行长行）、Ctrl+Home/End、
 *  查找面板 Ctrl+F → 输入 → Enter / Shift+Enter / F3 / Esc 全键盘链路。
 *
 *  PageUp/PageDown 与 F3 此前零覆盖。软换行行的 Home/End 落点（视觉行首还是逻辑行首）
 *  先把实际行为记录在案；硬判据是：光标不丢、块内前缀变短/变长、查找输入不打进文档。
 *
 *  【R7·虚拟化发现 2026-10-02】本场景的 164 段大文档实测：编辑面是**窗口化挂载**——滚动
 *  窗口内同时只挂 ~5 块，surface.children 的「块号」只是窗口内相对序号，不是全文档坐标。
 *  「末次块号 > 首次 + 40」这类块号跨度断言在虚拟化下永远凑不满，必然误报。② 已改按
 *  **文本锚点**口径（块文本含文首/文尾标记、「第 N 段」段号），光标所在块必在挂载窗口内，
 *  锚点读数不受窗口化影响；③ 找长行块先滚窗口再找，不依赖全量挂载。
 */
'use strict';
const hi = require('../hi.cjs');

const para = n => `第 ${n} 段：撑高度用的普通中文句子，带一点公式 $a_{${n}}$ 与英文 word${n}。`;
const BODY = [
  '# 页面导航练习',
  '',
  ...Array.from({ length: 120 }, (_, i) => para(i + 1)),
  '',
  '锚点甲：这一段的开头就是查找目标。',
  '',
  ...Array.from({ length: 40 }, (_, i) => para(200 + i)),
  '',
  '长行段落：' + '甲乙丙丁戊己庚辛壬癸'.repeat(24) + '长行到此为止。',
  '',
  '尾段：文档收尾。',
  '',
].join('\n');

const FIND_OPEN = `(() => { const w = ${hi.IF}; if (!w || !w.document) return false;
  return !!w.document.querySelector('#typora-find input[data-field="query"]'); })()`;
const SCROLL = `(() => { const w = ${hi.IF}; if (!w) return -1;
  const el = w.scrollingElement || w.document.documentElement; return Math.round(el.scrollTop); })()`;

module.exports = {
  id: '125-hi-page-nav',
  title: '页面导航真键：PageUp/Down 不丢光标、Home/End 软换行落点、Ctrl+Home/End、Ctrl+F→Enter/F3/Esc',
  run: async ctx => {
    const file = hi.writeDoc('page-nav.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 30, settleMs: 1800 });
    try {
      const md0 = String(await hi.mdNow(session));
      ctx.assert('文档打开（120+ 段）', md0.includes('第 1 段') && md0.includes('尾段'), `长度 ${md0.length}`);
      const focus = await hi.ensureFocus(session);
      ctx.assert('焦点在编辑器', focus.ok, JSON.stringify(focus));

      // ══ ① Ctrl+End → 文档最末；Ctrl+Home → 最前 ═════════════════════════════
      await hi.press(session, 'End', { modifiers: hi.MOD.ctrl });
      await hi.sleep(400);
      let info = await hi.caret(session);
      ctx.witness('几何：Ctrl+End 后光标', info, 'geometry');
      ctx.assert('① Ctrl+End 光标落在最后一块', info.块文本.includes('尾段'), JSON.stringify(info));
      const scrollBottom = await session.js(SCROLL);
      await hi.press(session, 'Home', { modifiers: hi.MOD.ctrl });
      await hi.sleep(400);
      info = await hi.caret(session);
      ctx.assert('① Ctrl+Home 光标落在第一块、块首', info.块 === 0 && info.偏移 === 0, JSON.stringify(info));

      // ══ ② PageDown×12 → 到底部区域；PageUp×14 → 回顶部区域（光标全程不丢） ══
      // 【R7】虚拟化下窗口内块号不作数（见文件头）：改用**文本锚点**——每步读光标所在块的
      // 块文本与抠出的「第 N 段」段号；文尾判据 = 末次块文本含文尾标记「尾段」或段号进底部区
      // （≥200，本文档底部 40 段编号 200-239）；纵向位移另有滚动条判据兜底（文档坐标，不受挂载影响）。
      const paraNo = t => { const m = /第\s*(\d+)\s*段/.exec(String(t || '')); return m ? Number(m[1]) : null; };
      const hops = [];
      for (let i = 0; i < 12; i++) {
        await hi.press(session, 'PageDown');
        await hi.sleep(280);
        const c = await hi.caret(session);
        if (!c.ok) { ctx.assert('② PageDown 途中光标始终在编辑器里', false, JSON.stringify(c)); break; }
        hops.push({ 块: c.块, 块文本: c.块文本, 段号: paraNo(c.块文本), y: c.y });
      }
      const last = hops.at(-1) || {}, first = hops[0] || {};
      ctx.witness('几何：PageDown×12 的文本锚点序列（窗口内块号仅作参考）', { hops, 滚动底: scrollBottom }, 'geometry');
      ctx.assert('② PageDown 连按把光标带到底部区域（末次文本锚点=文尾标记或底部段号≥200）',
        hops.length === 12 && (String(last.块文本 || '').includes('尾段') || (last.段号 ?? 0) >= 200),
        JSON.stringify(hops.map(h => h.块文本)));
      if (first.段号 != null && last.段号 != null)
        ctx.assert('② PageDown 段号锚点跨度 > 40（文本锚点版的位移判据，不依赖块挂载）',
          last.段号 - first.段号 > 40, JSON.stringify({ 首次段号: first.段号, 末次段号: last.段号 }));
      const upHops = [];
      for (let i = 0; i < 14; i++) {
        await hi.press(session, 'PageUp');
        await hi.sleep(280);
        const c = await hi.caret(session);
        if (!c.ok) { ctx.assert('② PageUp 途中光标始终在编辑器里', false, JSON.stringify(c)); break; }
        upHops.push({ 块: c.块, 块文本: c.块文本, 段号: paraNo(c.块文本), y: c.y });
      }
      const upLast = upHops.at(-1) || {};
      ctx.witness('几何：PageUp×14 的文本锚点序列', { upHops }, 'geometry');
      ctx.assert('② PageUp 连按把光标带回顶部区域（末次文本锚点=文首标题或顶部段号≤5）',
        upHops.length === 14 && (String(upLast.块文本 || '').includes('页面导航练习') || (upLast.段号 ?? 999) <= 5),
        JSON.stringify(upHops.map(h => h.块文本)));
      const scrollAfter = await session.js(SCROLL);
      ctx.assert('② 一路 PageUp 后滚动条到顶附近（比 PageDown 后小很多）',
        scrollAfter < Math.max(60, scrollBottom / 4), `滚动 ${scrollAfter} / 底部 ${scrollBottom}`);

      // ══ ③ 软换行长行：Home 落视觉行首/逻辑行首（记录）、End 回行尾 ═════════════
      // 【R7】长行段在文档 ~85% 深度，虚拟化窗口（~5 块）停在顶部时根本没挂载它：先在当前
      // 窗口按文本找，找不到就把窗口滚到底部再找一次——锚点是文本，不依赖全量挂载。
      const FIND_LONG = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
        return [...s.children].findIndex(n => n.textContent.includes('长行段落')); })()`;
      let longIndex = await session.js(FIND_LONG);
      if (longIndex < 0) {
        await session.js(`(() => { const w = ${hi.IF}; const el = w.scrollingElement || w.document.documentElement;
          el.scrollTop = el.scrollHeight; return Math.round(el.scrollTop); })()`);
        await hi.sleep(500);
        longIndex = await session.js(FIND_LONG);
      }
      ctx.assert('③ 找到长行段落（前置，窗口滚到底后按文本锚点定位）', longIndex >= 0, String(longIndex));
      if (longIndex >= 0) {
        await session.js(hi.placeCaretAt(longIndex, 120));
        await hi.sleep(200);
        const midPrefix = await hi.caretPrefix(session);
        await hi.press(session, 'Home');
        await hi.sleep(300);
        const homePrefix = await hi.caretPrefix(session);
        const homeCaret = await hi.caret(session);
        ctx.witness('几何：长行中段按 Home', { 中段前缀长: midPrefix.length, Home后前缀长: homePrefix.length, 光标x: homeCaret.x, 层: homeCaret.层 }, 'geometry');
        ctx.assert('③ Home 把光标移到本视觉行行首（前缀变短、还在同一块）',
          homePrefix.length < midPrefix.length && homeCaret.块 === longIndex, JSON.stringify({ 前: midPrefix.length, 后: homePrefix.length }));
        await hi.press(session, 'End');
        await hi.sleep(300);
        const endPrefix = await hi.caretPrefix(session);
        const endCaret = await hi.caret(session);
        ctx.witness('几何：行首按 End', { End后前缀长: endPrefix.length, 光标x: endCaret.x }, 'geometry');
        ctx.assert('③ End 把光标带回本视觉行行尾（前缀变长、同一块）',
          endPrefix.length > homePrefix.length && endCaret.块 === longIndex, JSON.stringify({ Home后: homePrefix.length, End后: endPrefix.length }));
      }

      // ══ ④ Ctrl+F → 输入 → Enter 跳匹配 → Shift+Enter / F3 → Esc 关面板 ═══════
      await hi.combo(session, 'Ctrl+F');
      const opened = await session.until(FIND_OPEN, { timeout: 6000, interval: 120 });
      ctx.assert('④ Ctrl+F 打开查找面板', opened, '面板 6 秒内没出现');
      if (opened) {
        const inputFocus = await session.js(`(() => { const w = ${hi.IF}, d = w.document;
          const input = d.querySelector('#typora-find input[data-field="query"]');
          return { 聚焦: d.activeElement === input }; })()`);
        ctx.assert('④ 查找输入框自动获得焦点', inputFocus.聚焦, JSON.stringify(inputFocus));
        await session.type('锚点甲');
        await hi.sleep(500);
        const scrollBeforeJump = await session.js(SCROLL);
        await session.enter();
        await hi.sleep(700);
        // 查找条的 Enter 把**匹配高亮/滚动**带到目标处；焦点按查找条惯例留在输入框。
        // 用户可见判据：滚动位置跳向锚点段 + 面板计数非零。
        const findState = await session.js(`(() => { const w = ${hi.IF}, d = w.document;
          const panel = d.querySelector('#typora-find');
          const output = panel ? panel.querySelector('output') : null;
          const status = panel ? panel.querySelector('[role="status"]') : null;
          return { 计数: output ? output.textContent.trim() : null, 状态: status ? status.textContent.trim().slice(0, 40) : null }; })()`);
        const scrollAfterJump = await session.js(SCROLL);
        ctx.witness('几何：查找 Enter 后的滚动与计数', { 滚动前: scrollBeforeJump, 滚动后: scrollAfterJump, findState }, 'geometry');
        ctx.assert('④ Enter 后滚动跳向匹配处（滚动位置明显变化）或计数非零',
          Math.abs(scrollAfterJump - scrollBeforeJump) > 40 || (findState.计数 && /[1-9]/.test(findState.计数)),
          JSON.stringify({ 滚动前: scrollBeforeJump, 滚动后: scrollAfterJump, findState }));
        await session.enter(true);   // Shift+Enter → 上一个
        await hi.sleep(400);
        await hi.press(session, 'F3');  // 下一个
        await hi.sleep(400);
        const docStillQuiet = String(await hi.mdNow(session)) === md0;
        ctx.assert('④ F3 再跳一次没有把查找词打进文档', docStillQuiet, '文档被改了');
        await hi.press(session, 'Escape');
        await hi.sleep(400);
        const panelGone = !(await session.js(FIND_OPEN));
        const focusBack = await hi.ensureFocus(session);
        ctx.assert('④ Esc 关闭查找面板', panelGone, '面板还在');
        ctx.assert('④ Esc 后焦点回到编辑器', focusBack.ok, JSON.stringify(focusBack));
      }
      ctx.assert('④ 查找全程没有把查找词打进文档', String(await hi.mdNow(session)) === md0,
        '文档被改了：' + String(await hi.mdNow(session)).slice(0, 60));

      // ══ ⑤ 磁盘证人：全程零编辑 ════════════════════════════════════════════════
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const disk = String(saved.after).replace(/\r/g, '');
      ctx.witness('磁盘：导航全程零编辑保存', { 磁盘长: disk.length }, 'disk');
      ctx.assert('⑤ 磁盘 == 原文（导航不改稿）',
        disk.replace(/\n+$/, '') === BODY.replace(/\n+$/, ''), `磁盘长 ${disk.length} / 原文长 ${BODY.length}`);
    } finally {
      await ctx.release(session);
    }
  },
};
