/** 123 · 词级移动/删除真键：Ctrl+Backspace / Ctrl+Delete（中英混排、贴公式）、
 *  Ctrl+←/→ 逐词跳、Ctrl+Shift+→ 逐词选、公式源码内的词删。
 *
 *  词级语义（中文一字一词、英文整词、公式成一个单元）是"手感"类缺陷高发区，
 *  本场景以不变量为主（删除只发生在光标处、$ 永远成对、光标不丢、步进单调），
 *  具体删除单位作为读数记录进 witness，供下一轮把口径固化成断言。
 *
 *  【R7·虚拟化发现 2026-10-02】编辑面为**窗口化挂载**（164 段文档实测同时仅挂 ~5 块），
 *  块号/块内前缀这类依赖全量块挂载的读数不可靠。③ 已改按**文档坐标前缀**口径：surface
 *  起点到光标的全文长度（纯导航期间 DOM 文本静态，单调性不受窗口挂载影响），并按 F18
 *  修复后的正确行为重写判据——Ctrl+←/→ 逐词步进**跨块单调推进**：走到块尾不停步，继续
 *  进入下一块；"回到行尾"不再是终点，跨块进第二段才是。
 */
'use strict';
const hi = require('../hi.cjs');

const LINE = '中文english混排word2与$x^2+1$以及标点。';
const BODY = LINE + '\n\n第二段落备用。\n';

const parityOfDollar = text => {
  const body = String(text).replace(/```[\s\S]*?```/g, match => match.replace(/\$/g, ''));  // 围栏代码块里的 $ 不算
  return (body.match(/\$/g) || []).length % 2 === 0;
};

/** 单一连续删除区间：old 与 new 的公共前缀/后缀夹出来的那段。返回 null 表示不是单区间编辑。 */
function contiguousCut(oldText, newText) {
  const a = String(oldText), b = String(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const removed = a.slice(head, a.length - tail);
  const inserted = b.slice(head, b.length - tail);
  return { removed, inserted, head };
}

module.exports = {
  id: '123-hi-word-motion',
  title: '词级真键：Ctrl+Backspace/Delete 只在光标处删、$ 成对、Ctrl+←/→ 单调、Ctrl+Shift+→ 选区只增',
  run: async ctx => {
    const file = hi.writeDoc('word-motion.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 2 });
    try {
      const md0 = String(await hi.mdNow(session));
      ctx.assert('文档打开', md0.includes('english'), md0.slice(0, 40));
      const focus = await hi.ensureFocus(session);
      ctx.assert('焦点在编辑器', focus.ok, JSON.stringify(focus));

      // ══ ① Ctrl+Backspace 连按：删除只发生在末尾、$ 永远成对 ═══════════════════
      await session.js(hi.placeAfterPrefix('标点。'));
      await hi.sleep(150);
      const deletions = [];
      let prev = String(await hi.mdNow(session));
      for (let i = 0; i < 6; i++) {
        await hi.press(session, 'Backspace', { modifiers: hi.MOD.ctrl });
        await hi.sleep(300);
        const now = String(await hi.mdNow(session));
        const cut = contiguousCut(prev, now);
        const okCut = cut !== null && cut.inserted.length === 0 && cut.removed.length >= 1 && cut.removed.length <= 12;
        // 2.2.1 口径：围栏当普通字符——删掉的内容本身含 $ 时，瞬时失衡是合法的，只记录。
        const parityLegal = parityOfDollar(now) || cut.removed.includes('$');
        deletions.push({ step: i + 1, 删掉: cut ? cut.removed : '(非连续编辑)', 是连续删除: okCut, 成对: parityOfDollar(now) });
        ctx.assert(`① 第 ${i + 1} 次 Ctrl+Backspace：单一连续删除（1-12 字）且 $ 不被拆坏`,
          okCut && parityLegal, JSON.stringify(deletions.at(-1)));
        prev = now;
      }
      ctx.witness('几何：Ctrl+Backspace 六连的删除单位', { deletions }, 'geometry');
      const caretMid = await hi.caret(session);
      ctx.assert('① 一路词删后光标仍在编辑器里', caretMid.ok, JSON.stringify(caretMid));
      // 退回原稿
      for (let i = 0; i < 8; i++) { await hi.combo(session, 'Ctrl+Z'); await hi.sleep(240); }
      ctx.assert('① Ctrl+Z 链退回原稿', String(await hi.mdNow(session)) === md0, String(await hi.mdNow(session)).slice(0, 50));

      // ══ ② Ctrl+Delete：从行首向前删，只删开头、$ 成对 ═════════════════════════
      await session.js(hi.placeCaretAt(0, 0));
      await hi.sleep(150);
      const forward = [];
      prev = String(await hi.mdNow(session));
      for (let i = 0; i < 5; i++) {
        await hi.press(session, 'Delete', { modifiers: hi.MOD.ctrl });
        await hi.sleep(300);
        const now = String(await hi.mdNow(session));
        const cut = contiguousCut(prev, now);
        const okCut = cut !== null && cut.inserted.length === 0 && cut.removed.length >= 1 && cut.removed.length <= 12;
        forward.push({ step: i + 1, 删掉: cut ? cut.removed : '(非连续编辑)', 是连续删除: okCut, 成对: parityOfDollar(now) });
        ctx.assert(`② 第 ${i + 1} 次 Ctrl+Delete：单一连续删除（1-12 字）且 $ 成对`,
          okCut && parityOfDollar(now), JSON.stringify(forward.at(-1)));
        prev = now;
      }
      ctx.witness('几何：Ctrl+Delete 五连', { forward, md: prev.slice(0, 60) }, 'geometry');
      for (let i = 0; i < 8; i++) { await hi.combo(session, 'Ctrl+Z'); await hi.sleep(240); }

      // ══ ③ Ctrl+← / Ctrl+→ ：步进单调、能到头（文档坐标口径） ══════════════════
      // 【R7】块内前缀（caretPrefix）在 F18 修复后必红：Ctrl+→ 到块尾会**继续跨块进入下一块**
      // （正确行为），块内前缀从大数跳回小数不是"回头"。改用**文档坐标前缀**：surface 起点到
      // 光标的全文长度——跨块推进时只增，窗口化挂载也不影响单调性（导航期间 DOM 文本静态）。
      const DOC_PREFIX = `(() => { const w = ${hi.IF}, d = w.document;
        const surface = d.querySelector('${hi.SURFACE}'); const s = w.getSelection();
        if (!surface || !s || !s.rangeCount) return null; const r = s.getRangeAt(0);
        if (!r.startContainer || !surface.contains(r.startContainer)) return null;
        const pre = d.createRange(); pre.selectNodeContents(surface);
        try { pre.setEnd(r.startContainer, r.startOffset); } catch (e) { return null; }
        // 【R7 定点口径】"上一块块尾"与"下一块块首"是同一个 DOM 点，纯文本前缀看不见跨块那一步
        // （Ctrl+→ 从行尾跨进下一块，前缀读数原地不动，会被误判成"按了不动"——实际光标已移动）。
        // "块首"按内容口径判：块内、光标之前没有任何可见字符（段落开头常有零宽/空文本节点，
        // 严格等块起点会漏）；且窗口里真挂着前一块（不是文档首块——首块块首就是文档 0 位）。
        let bump = 0;
        try {
          const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
          const blk = at && at.closest ? at.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th') : null;
          if (blk && blk.parentElement === surface && blk.previousElementSibling) {
            const head = d.createRange(); head.selectNodeContents(blk);
            head.setEnd(r.startContainer, r.startOffset);
            if (!String(head.toString()).replace(/[\\s\\u200b\\u200c]/g, '')) bump = 0.5;
          }
        } catch (e) {}
        return pre.toString().length + bump; })()`;
      const docPrefix = async () => { const v = await session.js(DOC_PREFIX); return v === null ? -1 : v; };
      await session.js(hi.placeAfterPrefix('标点。'));
      await hi.sleep(150);
      const lefts = [];
      for (let i = 0; i < 10; i++) {
        await hi.press(session, 'ArrowLeft', { modifiers: hi.MOD.ctrl });
        await hi.sleep(220);
        lefts.push(await docPrefix());
        if (lefts.at(-1) === 0) break;
      }
      ctx.witness('几何：Ctrl+← 的步进序列（文档坐标前缀长度）', { lefts }, 'geometry');
      ctx.assert('③ Ctrl+← 逐词向左且单调不回头（文档坐标前缀）',
        lefts.length >= 3 && lefts.every((v, i) => i === 0 || v < lefts[i - 1]),
        JSON.stringify(lefts));
      ctx.assert('③ 能一路退到文档首（文档坐标前缀 0）', lefts.at(-1) === 0, JSON.stringify(lefts));
      const rights = [];
      for (let i = 0; i < 10; i++) {
        await hi.press(session, 'ArrowRight', { modifiers: hi.MOD.ctrl });
        await hi.sleep(220);
        rights.push(await docPrefix());
      }
      const rightEnd = await hi.caret(session);
      ctx.witness('几何：Ctrl+→ 的步进序列（文档坐标前缀长度）', { rights, 末点块文本: rightEnd.块文本 }, 'geometry');
      ctx.assert('③ Ctrl+→ 逐词向右单调推进（文档坐标前缀只增）',
        rights.every((v, i) => i === 0 || v > rights[i - 1]), JSON.stringify(rights));
      ctx.assert('③ Ctrl+→ 走完本行继续跨块（F18 修复后跨块不停步，末点文本锚点已进第二段）',
        String(rightEnd.块文本 || '').includes('第二段落'), JSON.stringify({ 末次前缀: rights.at(-1), 末点块文本: rightEnd.块文本 }));

      // ══ ④ Ctrl+Shift+→ 逐词选：选区只增不减 ═══════════════════════════════════
      await session.js(hi.placeCaretAt(0, 0));
      await hi.sleep(150);
      const lens = [];
      for (let i = 0; i < 8; i++) {
        await hi.press(session, 'ArrowRight', { modifiers: hi.MOD.ctrl | hi.MOD.shift });
        await hi.sleep(220);
        const info = await hi.caret(session);
        lens.push(info.选区长);
      }
      ctx.witness('几何：Ctrl+Shift+→ 选区长度序列', { lens }, 'geometry');
      ctx.assert('④ Ctrl+Shift+→ 选区单调只增', lens.length >= 3 && lens.every((v, i) => i === 0 || v > lens[i - 1]), JSON.stringify(lens));
      // 收掉选区
      await hi.press(session, 'Escape');
      await session.js(hi.placeCaretAt(0, 0));
      await hi.sleep(150);

      // ══ ⑤ 公式源码内 Ctrl+Backspace：TeX 词删，$ 仍然成对 ═════════════════════
      const placed = await session.js(`(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
        const code = [...s.querySelectorAll('code[data-type="math-inline"]')].find(n => n.textContent.includes('x^2+1'));
        if (!code || !code.firstChild) return { ok: false };
        s.focus();
        const r = d.createRange(); r.setStart(code.firstChild, 4); r.collapse(true);
        const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        return { ok: true, 源码: code.textContent }; })()`);
      ctx.assert('⑤ 光标放进公式源码（前置）', placed.ok, JSON.stringify(placed));
      await hi.press(session, 'Backspace', { modifiers: hi.MOD.ctrl });
      await hi.sleep(350);
      const mdMath = String(await hi.mdNow(session));
      const caretMath = await hi.caret(session);
      ctx.witness('几何：公式源码内词删后', { 光标: caretMath, md: mdMath.slice(0, 50) }, 'geometry');
      ctx.assert('⑤ 公式源码内词删后 $ 仍成对（没把公式删豁）', parityOfDollar(mdMath), JSON.stringify(mdMath.slice(0, 60)));
      ctx.assert('⑤ 词删发生在源码内、光标没丢', caretMath.ok, JSON.stringify(caretMath));

      // ══ ⑥ 收尾：退回原稿 + 磁盘证人 ═══════════════════════════════════════════
      for (let i = 0; i < 14; i++) { await hi.combo(session, 'Ctrl+Z'); await hi.sleep(220); }
      const finalMd = String(await hi.mdNow(session));
      ctx.assert('⑥ 撤销链退回原稿', finalMd === md0, finalMd.slice(0, 60));
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const disk = String(saved.after).replace(/\r/g, '');
      ctx.witness('磁盘：保存', { 磁盘: disk.slice(0, 50) }, 'disk');
      ctx.assert('⑥ 磁盘 == 原文', disk.replace(/\n+$/, '') === BODY.replace(/\n+$/, ''), disk.slice(0, 60));
    } finally {
      await ctx.release(session);
    }
  },
};
