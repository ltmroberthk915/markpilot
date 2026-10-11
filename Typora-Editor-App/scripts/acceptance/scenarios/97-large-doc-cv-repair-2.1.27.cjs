/** 2.1.27 回归：大文档里撤销之后，离屏渲染跳过（content-visibility）的估算值必须补回来。
 *
 *  缺陷（2026-09-16 实测，见 docs/LOG-2.1.25-2.1.26.md 第九节）：撤销是 HTML 快照恢复，
 *  走回"CV 启用之前"那份快照时会把整篇的内联 `contain-intrinsic-size` 一起换掉；新元素既没有
 *  内联值、浏览器也没记住高度，跳过块退回 large-doc.css 的兜底 320px ⇒ 总高 8 倍膨胀且不自愈
 *  （1843 块：75,745 → 606,128 px）。判据用**每个块平均占多少像素**把它与兜底签名分开：
 *  真实约 41px/块，坏掉时约 329px/块（≈320px 兜底），阈值取 100px/块。
 *
 *  A/B：安装版 2.1.26（未修）应在本场景的撤销那几条上失败；dev 树（已修）应全绿。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '97-large-doc-cv-repair-2.1.27',
  title: '大文档：撤销后 CV 估算值补回（总高不再 8 倍膨胀）',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const fixtures = require('../fixtures.cjs');
    const sleep = harness.sleep;
    const IF = `document.getElementById('editor').contentWindow`;

    const READ = `(() => { const w = ${IF}, d = w.document;
      const root = d.querySelector('.vditor-ir .vditor-reset');
      if (!root) return {missing: true};
      const blocks = root.children.length;
      let intrinsic = 0;
      for (const block of root.children) if (block.style.containIntrinsicSize) intrinsic++;
      const cv = w.__typoraCv || {enabled: false, repairs: []};   // 守卫把状态挂在**编辑器 iframe** 的 window 上，别读成外壳页的
      return {blocks, intrinsic, height: root.scrollHeight, pxPerBlock: +(root.scrollHeight / Math.max(1, blocks)).toFixed(1),
        cvOn: root.classList.contains('typora-cv'), enabled: cv.enabled,
        repairs: cv.repairs.slice(-6), repairCount: cv.repairs.length,
        pending: w.__typoraMathStats?.pending ?? null, katex: root.querySelectorAll('.katex').length,
        chars: String(w.vditor.getValue()).length}; })()`;

    const session = await ctx.launch({args: [fixtures.largeTailMath()]});
    try {
      await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelectorAll('.vditor-ir .vditor-reset p').length > 1500); })()`, {timeout: 120000, interval: 100});
      // 等 CV 挂上 + 公式队列排空（启用条件之一就是队列空）
      const engaged = await session.until(`(() => { const w = ${IF};
        const root = w.document.querySelector('.vditor-ir .vditor-reset');
        return !!(root && root.classList.contains('typora-cv')); })()`, {timeout: 90000, interval: 250});
      await sleep(1500);
      const start = await session.js(READ);
      ctx.witness('① 打开后：CV 已挂上时的几何', {blocks: start.blocks, intrinsic: start.intrinsic, height: start.height, pxPerBlock: start.pxPerBlock, cvOn: start.cvOn, chars: start.chars, reported: start.enabled});
      ctx.assert('① 大文档（>1500 块）上离屏跳过已启用（按 DOM 上的类判，不依赖本版新增的记账字段）',
        engaged && start.cvOn === true, {cvOn: start.cvOn, blocks: start.blocks});
      ctx.assert('① 每个顶层块的内联估算值都写好了（>=95% 的块）',
        start.intrinsic >= start.blocks * 0.95, {intrinsic: start.intrinsic, blocks: start.blocks});
      ctx.assert('① 总高是"真实高度"的量级（每个块 <100px，未掉进 320px 兜底签名）',
        start.pxPerBlock < 100, {pxPerBlock: start.pxPerBlock, height: start.height, blocks: start.blocks});

      // 光标放到文末最后一个可编辑段落（与场景 72 同一手法）
      const arm = `(() => { const w = ${IF}, d = w.document;
        const surface = d.querySelector('.vditor-ir .vditor-reset');
        const blocks = [...surface.children].filter(node => /^(P|H[1-6]|LI|BLOCKQUOTE)$/.test(node.tagName));
        const target = blocks[blocks.length - 1];
        const walker = d.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
          acceptNode: text => (text.data.trim().length && !text.parentElement.closest('.vditor-ir__preview')) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
        let node = null, last = null;
        while ((node = walker.nextNode())) last = node;
        if (!last) return {ok: false};
        const range = d.createRange(); range.setStart(last, last.data.length); range.collapse(false);
        const selection = w.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        surface.focus({preventScroll: true}); return {ok: true}; })()`;
      await session.js(arm);

      // ---- ② 正常打字：只重建被编辑的那一块，总高不该变 ----
      for (let i = 0; i < 5; i++) { await session.type('v'); await sleep(150); }
      await sleep(1200);
      const typed = await session.js(READ);
      ctx.witness('② 连打 5 个字之后', {intrinsic: typed.intrinsic, blocks: typed.blocks, height: typed.height, pxPerBlock: typed.pxPerBlock, repairs: typed.repairs});
      ctx.assert('② 打字只影响被重建的少数块，总高仍在真实量级（<100px/块）',
        typed.pxPerBlock < 100 && typed.intrinsic >= typed.blocks * 0.9, {pxPerBlock: typed.pxPerBlock, intrinsic: typed.intrinsic, blocks: typed.blocks});

      // ---- ③ 连撤（走回 CV 启用之前的快照）：估算值必须被补回来 ----
      for (let i = 0; i < 8; i++) { await session.chord('z', 'KeyZ', 90); await sleep(140); }
      await sleep(2500);                        // 修复走 rIC（120ms 去抖 + 最多 1.5s 兜底）
      const undone = await session.js(READ);
      const fullRepairs = (undone.repairs || []).filter(row => String(row.mode).startsWith('full'));
      ctx.witness('③ 连撤 8 次之后：修复记录与几何', {intrinsic: undone.intrinsic, blocks: undone.blocks, height: undone.height,
        pxPerBlock: undone.pxPerBlock, repairCount: undone.repairCount, repairs: undone.repairs, chars: undone.chars});
      ctx.assert('③ 撤销之后估算值被补回（>=95% 的块又有内联值了）',
        undone.intrinsic >= undone.blocks * 0.95, {intrinsic: undone.intrinsic, blocks: undone.blocks});
      ctx.assert('③ 撤销之后总高仍在真实量级（不再 8 倍膨胀到 320px/块）',
        undone.pxPerBlock < 100, {pxPerBlock: undone.pxPerBlock, height: undone.height, blocks: undone.blocks});
      ctx.assert('③ 撤销之后总高与打字前相差在 5% 内（校准生效，不是随便补一个值）',
        Math.abs(undone.height - typed.height) / Math.max(1, typed.height) < 0.05, {before: typed.height, after: undone.height});
      ctx.assert('③ 这次修复走的是"全量补回"那一档（缓存铺回或摘 CV 重量），并记下了耗时', fullRepairs.length >= 1 && fullRepairs.at(-1).ms >= 0,
        {fullRepairs: fullRepairs.slice(-2)});

      // ---- ④ 幂等：修完之后继续编辑，不该反复触发全量重量 ----
      const countBefore = undone.repairCount;
      await session.js(arm);
      for (let i = 0; i < 3; i++) { await session.type('w'); await sleep(200); }
      await sleep(1800);
      const after = await session.js(READ);
      const newFull = (after.repairs || []).filter(row => String(row.mode).startsWith('full')).length;
      ctx.witness('④ 修完之后再打字', {repairCount: after.repairCount, added: after.repairCount - countBefore, fullTotal: newFull, lastRepairs: after.repairs, pxPerBlock: after.pxPerBlock, intrinsic: after.intrinsic});
      // 每敲一个字都会把被重建的那一块按 'few' 补回来（1ms 级），这是预期行为；
      // 这条要拦的是"继续编辑又触发全量补回"——那说明补回没补干净。
      ctx.assert('④ 修完之后继续编辑：总高仍正常，且不再触发全量补回（编辑只走 1ms 级的少量补）',
        after.pxPerBlock < 100 && newFull <= (undone.repairs || []).filter(row => String(row.mode).startsWith('full')).length,
        {added: after.repairCount - countBefore, fullBefore: undone.repairs.length, fullAfter: after.repairs.length, pxPerBlock: after.pxPerBlock, repairs: after.repairs});
      ctx.assert('④ 编辑本身没被修复影响（撤销后长度回到原值，再打 3 个字就 +3）',
        after.chars === undone.chars + 3, {chars: after.chars, expected: undone.chars + 3, undoneChars: undone.chars});
      await session.shot('after-repair');
    } finally {
      await session.close();
    }
  },
};
