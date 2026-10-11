/** 2.1.16 回归：图片紧跟在块公式之后时，删除也只要**一次** Ctrl+Z。
 *
 *  用户（2026-09-14 第 7 轮）：「④ 图片删除要两次 Ctrl+Z 没修好」。
 *  2.1.15 修的是"点选图片这个纯光标移动被记成一条空历史"（我们自己的两处补历史点）；
 *  这一条是**第二种机制**，在**用户原文档**上才复现（scripts/acceptance/probe-img7.cjs）：
 *
 *    在 `1-重识概率论.md` 里把图片插到"紧跟第 196 行那条块公式"的位置，一次 Delete 推了**两条**：
 *      t=43635 栈 1→2 **推入** ← commitImageEdit（真正的删除补丁，mdLen 仍是 15256）
 *      t=43798 栈 2→3 **推入** ← index.min.js（`setValue` 之后 Vditor **自己的去抖 push**）
 *    第二条的 markdown 与第一条完全相同——但 Vditor 的历史快照是 HTML 层的：公式重排 /
 *    reconcile 挪节点会让快照不同、于是补丁非空。用户按第一次 Ctrl+Z 时撞上的就是它。
 *
 *  修法（js/typora-patches.js 的 undo/redo 包装）：**空步不吃按键**——撤销/重做时走完一步，如果
 *  markdown 一个字都没变、栈里还有更早的补丁，就接着再走一步（最多 3 步）。这条只动手势、
 *  不碰历史记录：拦在入栈那一侧会误伤"markdown 相同但结构不同"的合法撤销步
 *（渲染层套件的 ir math / wysiwyg list 撤销断言就是这么红的，已实测）。
 *  实测修后：一次 Ctrl+Z 就把图片拿回来。
 *
 *  这个场景造的就是那个几何：**图片紧跟在一条块公式之后**（这也是用户文档里的排布）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '89-image-after-block-math-one-undo-2.1.16',
  title: '图片紧跟块公式：删除后第一次 Ctrl+Z 就把图片拿回来',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const fixtures = require('../fixtures.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '89-round');
    fs.mkdirSync(dir, {recursive: true});
    const IF = `document.getElementById('editor').contentWindow`;

    fs.writeFileSync(path.join(dir, 'tall.png'), fixtures.png(1167, 1264, [220, 60, 60]));
    const file = path.join(dir, '公式后紧跟图片.md');
    const fixture = ['# 公式后紧跟图片', '',
      '上面一段正文。', '',
      '$$', '1=\\lim_{n\\to\\infty}\\int f_n\\,d\\mu\\neq\\int\\Big(\\lim_{n\\to\\infty}f_n\\Big)d\\mu=0,', '$$', '',
      '<img src="tall.png" alt="image" data-typora-align="center" width="813" data-typora-scale="75" />', '',
      '下面一段正文。', ''].join('\n');
    fs.writeFileSync(file, fixture);
    const before = fs.readFileSync(file);

    const session = await ctx.launch({args: [file]});
    try {
      const ready = await session.until(`(() => { const w = ${IF}, doc = w && w.document; if (!doc) return false;
        const imgs = [...doc.querySelectorAll('.vditor-ir img')];
        const leaf = [...doc.querySelectorAll('.vditor-ir__preview [data-typora-source-start]')]
          .filter(n => !n.querySelector('[data-typora-source-start]')).find(n => n.getBoundingClientRect().width > 1);
        return imgs.length >= 1 && imgs.every(n => n.complete) && !!leaf; })()`, {timeout: 60000, interval: 80});
      ctx.assert('图片与块公式都就位（这是复现所需的几何）', ready, 'timeout 60s');
      if (!ready) return;
      await sleep(1200);

      const STACK = `(() => { const w = ${IF}; return w.vditor.vditor.undo.ir.undoStack.length; })()`;
      const stackStart = await session.js(STACK);
      const point = await session.js(`(() => { const w = ${IF}, doc = w.document, frame = w.frameElement, img = doc.querySelector('.vditor-ir img');
        if (!img) return null; img.scrollIntoView({block: 'center'});
        const r = img.getBoundingClientRect(), fr = frame.getBoundingClientRect();
        const y0 = Math.max(r.top, 4), y1 = Math.min(r.bottom, w.innerHeight - 4);
        const x0 = Math.max(r.left, 4), x1 = Math.min(r.right, w.innerWidth - 4);
        for (const fy of [0.5, 0.35, 0.65]) for (const fx of [0.5, 0.3]) {
          const x = Math.round(fr.x + x0 + (x1 - x0) * fx), y = Math.round(fr.y + y0 + (y1 - y0) * fy);
          if (doc.elementFromPoint(x - fr.x, y - fr.y) === img) return {x: x, y: y};
        }
        return null; })()`);
      if (!point) { ctx.assert('量到一个能点到图片本体的落点', false, 'no-point'); return; }
      await session.click(point.x, point.y);
      await sleep(600);
      const picked = await session.js(`(() => { const w = ${IF}; return w.document.querySelectorAll('.vditor-ir img.typora-img-selected').length; })()`);
      ctx.assert('图片被点选中', picked === 1, {selected: picked});
      const stackBefore = await session.js(STACK);

      await session.key({key: 'Delete', code: 'Delete', vk: 46});
      await sleep(1800);
      const afterDel = await session.js(`(() => { const w = ${IF}, api = w.vditor;
        return {stack: w.vditor.vditor.undo.ir.undoStack.length, imgs: w.document.querySelectorAll('.vditor-ir img').length,
          mdLen: String(api.getValue()).length}; })()`);
      ctx.witness('删除前后：撤销栈长度 / 图片数 / markdown 长度', {stackBefore: stackBefore, stackStart: stackStart, after: afterDel});
      ctx.assert('图片被删掉了', afterDel.imgs === 0, afterDel);
      // 栈里可能多一条"markdown 没变"的空补丁（Vditor 自己在 setValue 之后的去抖 push）——
      // 修法不是拦它入栈（那会误伤"markdown 相同但结构不同"的合法撤销步，渲染层套件有断言），
      // 而是**撤销时跳过空步**。所以这里断言的是用户看得见的那条契约，而不是栈长：
      ctx.witness('④ 删除后的栈增量（空补丁可能让它是 2，但**不许**因此多要一次 Ctrl+Z）',
        {增量: afterDel.stack - stackBefore});

      await session.key({key: 'Z', code: 'KeyZ', vk: 90, modifiers: harness.MOD.ctrl});
      await sleep(1700);
      const undone = await session.js(`(() => { const w = ${IF}, api = w.vditor;
        return {stack: w.vditor.vditor.undo.ir.undoStack.length, imgs: w.document.querySelectorAll('.vditor-ir img').length,
          loaded: [...w.document.querySelectorAll('.vditor-ir img')].filter(n => n.complete && n.naturalWidth > 0).length,
          md: String(api.getValue())}; })()`);
      ctx.witness('④ 一次 Ctrl+Z 之后', {stack: undone.stack, imgs: undone.imgs, loaded: undone.loaded});
      ctx.assert('④ **第一次** Ctrl+Z 就把图片拿回来（用户报的"要两次"）',
        undone.imgs === 1 && undone.loaded === 1, undone);
      ctx.assert('④ 撤销之后撤销栈回到删除前（没有留下"按下去什么也不发生"的历史）',
        undone.stack === stackBefore, {before: stackBefore, after: undone.stack});

      await sleep(2400);
      const onDisk = fs.readFileSync(file);
      ctx.witness('磁盘上的源文件与原始内容比对（独立通道）', {bytes: onDisk.length, identical: onDisk.equals(before)});
      ctx.assert('一次撤销之后磁盘上的文件与原始逐字节一致', onDisk.equals(before), {before: before.length, after: onDisk.length});
      await session.shot('after-undo');
    } finally {
      await session.close();
    }
  },
};
