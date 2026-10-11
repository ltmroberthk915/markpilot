/** 2.1.15 回归：图片删除的两条（用户 2026-09-14 第 6 轮 ④⑤）。
 *
 *  ④ 「这个图片选中删除之后，要去两次 CTRL+Z 才能回退」
 *  ⑤ 「若图片上方已经超出了页面上边缘，也就是说文字仅出现在图片下方时，删除它，要求图片下方的
 *      文字位置不动，而上方内容下移。这个先判断好不好实现，它的镜像情况就是图片出现在下方，
 *      删除后肯定目前是下方文字向上移动是没问题的」
 *
 *  取证（scripts/acceptance/probe-img4.cjs，真产物）：一次"点选图片 + Delete"里
 *  `undo.addToUndoStack` 被调 5 次、其中 **2 次真的入栈**；第二条的 markdown 与上一条完全相同
 *  ——因为 Vditor 的历史快照是**带光标位置**的（`addToUndoStack` 内部先 `addCaret`），
 *  "点选图片"这种纯光标移动也算一次差异。用户按 Ctrl+Z 时先撞上这条"什么也不发生"的历史，
 *  看起来就是要按两次。
 *  修法（render/js/media-tools.js）：`beginDocumentEdit` 与 `commitImageEdit` 里那两处补历史
 *  改成 `pushHistoryIfChanged()`——拿历史快照换算出的 markdown 和当前 markdown 比，一样就不推。
 *
 *  ⑤ 的判据（几何）：图片盒 top 在可视区上沿之上时，删除后把滚动位置整体上移"被删掉的高度"
 *  （图片独占的那一整块），于是下方文字停在原地、上方内容下移进视野。图片整体在视口里时
 *  保持旧行为（下方文字上移一格）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const TALL = [1167, 1264];      // 用户那张截图的尺寸（比验收窗口还高）

module.exports = {
  id: '87-image-delete-undo-scroll-2.1.15',
  title: '图片删除：一次 Ctrl+Z 就回来；图片顶边出上沿时下方文字不动',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const fixtures = require('../fixtures.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '87-round');
    fs.mkdirSync(dir, {recursive: true});
    const IF = `document.getElementById('editor').contentWindow`;

    fs.writeFileSync(path.join(dir, 'tall.png'), fixtures.png(TALL[0], TALL[1], [220, 60, 60]));
    fs.writeFileSync(path.join(dir, 'small.png'), fixtures.png(120, 80, [60, 200, 110]));
    const tallTag = `<img src="tall.png" alt="image" data-typora-align="center" width="813" data-typora-scale="75" />`;
    const smallTag = `<img src="small.png" alt="image" data-typora-align="center" width="120" />`;
    const file = path.join(dir, '图片删除.md');
    const above = Array.from({length: 10}, (_, i) => `上文第 ${i + 1} 段。`);
    const markers = Array.from({length: 14}, (_, i) => `标记${String(i + 1).padStart(2, '0')}段。`);
    const fixture = ['# 图片删除：一次撤销 / 下方文字不动', '',
      ...above.flatMap(x => [x, '']),
      tallTag, '',
      ...markers.flatMap(x => [x, '']),
      '收尾段落。', ''].join('\n');
    fs.writeFileSync(file, fixture);
    const before = fs.readFileSync(file);

    const session = await ctx.launch({args: [file]});
    try {
      const ready = await session.until(`(() => { const w = ${IF}, doc = w && w.document; if (!doc) return false;
        const imgs = [...doc.querySelectorAll('.vditor-ir img')];
        return imgs.length >= 1 && imgs.every(n => n.complete && n.naturalWidth > 0); })()`, {timeout: 60000, interval: 80});
      ctx.assert('图片加载完成（有真实尺寸才谈得上几何）', ready, 'timeout 60s');
      if (!ready) return;
      await sleep(900);

      const HELP = `w.__i87 = (() => { const doc = w.document;
        // 真正的滚动容器是 .vditor-ir 里那个 pre.vditor-reset（实测 probe-scroll.cjs：
        // 只有它的 scrollHeight > clientHeight；.vditor-ir 自己是 overflow:visible）
        w.__scroller = () => doc.querySelector('.vditor-ir .vditor-reset');
        w.__paraTop = text => { const p = [...doc.querySelectorAll('.vditor-ir .vditor-reset p')].find(x => x.textContent.indexOf(text) >= 0);
          return p ? Math.round(p.getBoundingClientRect().top) : null; };
        w.__mark = () => ({A: w.__paraTop('标记01段'), B: w.__paraTop('标记02段'), C: w.__paraTop('标记03段'),
          scroll: Math.round(w.__scroller().scrollTop)});
        w.__stack = () => { const api = w.vditor, ir = api.vditor.undo.ir; return ir.undoStack.length; };
        w.__imgPoint = () => { const frame = w.frameElement, img = doc.querySelector('.vditor-ir img');
          if (!img || !frame) return null;
          const r = img.getBoundingClientRect(), fr = frame.getBoundingClientRect();
          const y0 = Math.max(r.top, 0), y1 = Math.min(r.bottom, w.innerHeight);
          const x0 = Math.max(r.left, 4), x1 = Math.min(r.right, w.innerWidth - 4);
          for (const fy of [0.5, 0.35, 0.65, 0.2, 0.8]) for (const fx of [0.5, 0.3, 0.7]) {
            const x = Math.round(fr.x + x0 + (x1 - x0) * fx), y = Math.round(fr.y + y0 + (y1 - y0) * fy);
            if (doc.elementFromPoint(x - fr.x, y - fr.y) === img) return {x: x, y: y, imgBox: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]};
          }
          return null; };
        // 把图片滚成"只剩下半截看得见、下方文字也看得见"：图片底边落在视口 45% 处
        w.__scrollToTail = () => { const root = w.__scroller(), img = doc.querySelector('.vditor-ir img');
          const view = root.getBoundingClientRect(), r = img.getBoundingClientRect();
          root.scrollTop += Math.round(r.bottom - (view.top + w.innerHeight * 0.45));
          return Math.round(root.scrollTop); };
        return true; })();`;
      await session.js(`(() => { const w = ${IF}; ${HELP} return true; })()`);

      // ---------- 前提：把图片滚成"顶边已在页面上沿之上、下方文字也看得见" ----------
      const scrolledTo = await session.js(`(() => { const w = ${IF}; return w.__i87 ? w.__scrollToTail() : null; })()`);

      await sleep(800);
      const geo = await session.js(`(() => { const w = ${IF}, img = w.document.querySelector('.vditor-ir img');
        const r = img.getBoundingClientRect();
        return {imgTop: Math.round(r.top), imgBottom: Math.round(r.bottom),
          imgH: Math.round(r.height), viewH: w.innerHeight, marks: w.__i87 ? w.__mark() : null}; })()`);
      ctx.witness('删除前的几何：图片盒 + 各标记段的屏幕位置', geo);
      ctx.assert('前提成立：图片顶边确实已经在页面上沿之上（用户报告的那个情形）',
        geo.imgTop < 0, {imgTop: geo.imgTop, imgH: geo.imgH, viewH: geo.viewH});
      ctx.assert('前提成立：图片下方的文字确实看得见（否则这条断言没意义）',
        geo.marks && geo.marks.A !== null && geo.marks.A > 0 && geo.marks.A < geo.viewH, geo.marks);

      const stackBefore = await session.js(`(() => { const w = ${IF}; return w.__i87 ? w.__stack() : null; })()`);
      // 诊断用：被删高度的几种算法 + 内容总高，和实测位移对照（用户口径要的是"下方文字不动"）
      const heights = await session.js(`(() => { const w = ${IF}, doc = w.document, root = w.__scroller(), img = doc.querySelector('.vditor-ir img');
        let block = img; while (block.parentElement && block.parentElement !== root) block = block.parentElement;
        const owner = block && block !== img ? block.getBoundingClientRect() : null;
        return {imgH: Math.round(img.getBoundingClientRect().height),
          ownerTag: block ? block.tagName + '.' + String(block.className).slice(0, 24) : null,
          ownerH: owner ? Math.round(owner.height) : null,
          ownerTextEmpty: block && block !== img ? !(block.textContent || '').trim() : true,
          scrollHeight: root.scrollHeight, scrollTop: Math.round(root.scrollTop)}; })()`);
      ctx.witness('诊断：被删高度的几种算法', heights);
      const point = await session.js(`(() => { const w = ${IF}; return w.__i87 ? w.__imgPoint() : null; })()`);
      ctx.witness('点选图片用的落点（挑一个没被浮动工具栏盖住的点）', point);
      if (!point) { ctx.assert('量到一个能点到图片本体的落点', false, 'no-point'); return; }
      await session.click(point.x, point.y);
      await sleep(500);
      const picked = await session.js(`(() => { const w = ${IF}; return w.document.querySelectorAll('.vditor-ir img.typora-img-selected').length; })()`);
      ctx.assert('图片被点选中（产品的选中态）', picked === 1, {selected: picked});

      await session.key({key: 'Delete', code: 'Delete', vk: 46});
      await sleep(1800);
      const afterDel = await session.js(`(() => { const w = ${IF}, doc = w.document;
        return {imgs: doc.querySelectorAll('.vditor-ir img').length, stack: w.__i87 ? w.__stack() : null, marks: w.__mark()}; })()`);
      const sh = await session.js(`(() => { const w = ${IF}; return w.__scroller().scrollHeight; })()`);
      ctx.witness('Delete 之后：图片数 / 撤销栈长度 / 各标记段的屏幕位置', afterDel);
      ctx.witness('诊断：删除后的内容总高（与删除前的差值 = 实测被删高度）', {before: heights.scrollHeight, after: sh, removed: heights.scrollHeight - sh});
      ctx.assert('图片被删掉了', afterDel.imgs === 0, afterDel);
      ctx.assert('④ **一次用户动作只推一条历史**（撤销栈只涨 1）',
        afterDel.stack === stackBefore + 1, {before: stackBefore, after: afterDel.stack});

      // ⑤ 下方文字位置不动
      const moved = ['A', 'B', 'C'].map(k => ({mark: k, from: geo.marks[k], to: afterDel.marks[k],
        delta: afterDel.marks[k] === null || geo.marks[k] === null ? null : afterDel.marks[k] - geo.marks[k]}));
      ctx.witness('⑤ 图片下方各标记段的位移（期望 ≈ 0：下方文字原地不动）', moved);
      ctx.assert('⑤ 删掉"顶边已出上沿"的图片：下方文字位置不动（每段位移 ≤ 3px）',
        moved.every(m => m.delta !== null && Math.abs(m.delta) <= 3), JSON.stringify(moved));
      const scrolled = afterDel.marks.scroll - geo.marks.scroll;
      ctx.assert('⑤ 自证：视口确实整体上移了（上方内容因此下移进视野），不是"什么都没发生"',
        scrolled < -20, {scrollBefore: geo.marks.scroll, scrollAfter: afterDel.marks.scroll, delta: scrolled});

      // ④ 一次 Ctrl+Z 就把图片拿回来
      await session.key({key: 'Z', code: 'KeyZ', vk: 90, modifiers: harness.MOD.ctrl});
      await sleep(1600);
      const undone = await session.js(`(() => { const w = ${IF}, doc = w.document, api = w.vditor;
        return {imgs: doc.querySelectorAll('.vditor-ir img').length,
          loaded: [...doc.querySelectorAll('.vditor-ir img')].filter(n => n.complete && n.naturalWidth > 0).length,
          stack: w.__i87 ? w.__stack() : null, md: String(api.getValue())}; })()`);
      const original = fs.readFileSync(file, 'utf8');
      const origMd = await session.js(`(() => { const w = ${IF}; return String(w.vditor.getValue()); })()`);
      ctx.witness('④ 一次 Ctrl+Z 之后的图片数与撤销栈', {imgs: undone.imgs, loaded: undone.loaded, stack: undone.stack});
      ctx.assert('④ **恰好一次** Ctrl+Z 就把图片拿回来（用户报的"要两次"）',
        undone.imgs === 1 && undone.loaded === 1, undone);
      ctx.assert('④ 撤销之后撤销栈回到删除前的长度（没有留下"按下去什么也不发生"的历史）',
        undone.stack === stackBefore, {before: stackBefore, after: undone.stack});

      await session.shot('after-undo');
      await sleep(2400);
      const onDisk = fs.readFileSync(file);
      ctx.witness('磁盘上的源文件与原始内容比对（独立通道）', {bytes: onDisk.length, identical: onDisk.equals(before)});
      ctx.assert('撤销一次之后磁盘上的文件与原始逐字节一致', onDisk.equals(before), {before: before.length, after: onDisk.length});

      // ---------- B 组：镜像情形（图片整体在视口里）保持旧行为 ----------
      const file2 = path.join(dir, '图片删除-镜像.md');
      fs.writeFileSync(file2, ['# 镜像：小图整体可见', '',
        '上文。', '', smallTag, '', '图后第一段。', '', '图后第二段。', ''].join('\n'));
      const second = await ctx.launch({args: [file2]});
      try {
        const ok2 = await second.until(`(() => { const w = ${IF}, doc = w && w.document; if (!doc) return false;
          const imgs = [...doc.querySelectorAll('.vditor-ir img')];
          return imgs.length >= 1 && imgs.every(n => n.complete && n.naturalWidth > 0); })()`, {timeout: 60000, interval: 80});
        ctx.assert('B：小图加载完成', ok2, 'timeout 60s');
        if (ok2) {
          await sleep(800);
          await second.js(`(() => { const w = ${IF}; ${HELP} return true; })()`);
          const g2 = await second.js(`(() => { const w = ${IF}, img = w.document.querySelector('.vditor-ir img');
            const r = img.getBoundingClientRect();
            return {imgTop: Math.round(r.top), imgBottom: Math.round(r.bottom), marks: w.__mark()}; })()`);
          const p2 = await second.js(`(() => { const w = ${IF}; return w.__i87 ? w.__imgPoint() : null; })()`);
          if (p2) {
            await second.click(p2.x, p2.y);
            await sleep(500);
            await second.key({key: 'Delete', code: 'Delete', vk: 46});
            await sleep(1600);
            const a2 = await second.js(`(() => { const w = ${IF}, doc = w.document;
              return {imgs: doc.querySelectorAll('.vditor-ir img').length, marks: w.__mark()}; })()`);
            ctx.witness('B：镜像情形（图片整体在视口里）删除前后的几何', {before: g2, after: a2});
            ctx.assert('B：图片整体在视口里时，删除**不**改动滚动位置（旧行为原样保留）',
              a2.marks.scroll === g2.marks.scroll, {before: g2.marks.scroll, after: a2.marks.scroll});
            ctx.assert('B：删除成功', a2.imgs === 0, a2);
          }
        }
      } finally {
        await second.close();
      }
    } finally {
      await session.close();
    }
  },
};
