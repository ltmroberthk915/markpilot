/** 纵向移动的目标列 + 块公式的拖拽选中（用户 2026-09-18 报告的三件事里有两条落在这里）。
 *
 *  用户原话：
 *    ① "上方向键移动的时候还是会跳过 inline math 跑到更前一行"；
 *    ② "上键移动后再下键回来, 光标位置首位不闭合, 逻辑混乱"；
 *    ③ "光标/长按 shift 键+方向键拖拽选中 block math 仍然失败 交互有问题"。
 *
 *  修法与证据（探针 `probe-vertical-roundtrip.cjs` 的 A–F 六组读数）：
 *    · 连续按 ↑/↓ 期间保持**目标列**（goalX），并且"从公式源码里出去"这一下由我们接管
 *      ——不接管时浏览器在"展开态公式"那一行的几何上算落点，列会丢（起点列 0 → 上去再
 *      下来变成列 2），展开态还会让下一次移动少算一行（①的"跑到更前一行"）。
 *    · 鼠标拖拽跨过块公式：原生选区整个跳过块（实测只剩 `"\n下段"`），现在把夹在中间
 *      的块整条并进选区、并挂 REVEAL 显示源码；REVEAL 后的样式要**先逼一次布局**再设端点，
 *      收回逻辑也要保住"源码被选区盖住"的块——否则刚建好的选区会被浏览器悄悄收窄。
 *
 *  判据都是用户看得见的东西：光标落在哪一行/哪一列（几何）、选区里有没有块公式的源码、
 *  块公式的源码有没有显示出来、以及**文档一个字节都没被改**（磁盘独立读）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const edge = require('../edge-helpers.cjs');
const harness = require('../harness.cjs');

const SURFACE = '.vditor-ir .vditor-reset';
const IF = `document.getElementById('editor').contentWindow`;

const READ = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  const blocks = [...surface.children];
  const s = w.getSelection();
  if (!s.rangeCount) return {none: true};
  const r = s.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const block = at.closest('p,li,h1,h2,h3,h4,h5,h6,div');
  const box = r.getBoundingClientRect();
  const blockBox = block ? block.getBoundingClientRect() : null;
  return {块: blocks.indexOf(block), 块文本: String(block?.textContent || '').replace(/\\s+/g, ' ').slice(0, 16),
    层: at.closest('code[data-type]') ? '源码' : at.closest('.vditor-ir__preview') ? '预览' : at.closest('[data-type$="-marker"]') ? '围栏' : '正文',
    容器: r.startContainer.nodeType === 3 ? 'TEXT' : r.startContainer.nodeName, 偏移: r.startOffset,
    光标x: Math.round(box.left), 块顶: blockBox ? Math.round(blockBox.top) : null,
    选区: JSON.stringify(s.toString()).slice(0, 60), 选区长度: s.toString().length, 塌: r.collapsed}; })()`;

/** 把光标放到"某一块里第一处有内容的文字"的指定位置。 */
const placeIn = (index, offset) => `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  const block = surface.children[${index}];
  if (!block) return {ok: false, error: '没有第 ${index} 块'};
  const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  let text = null;
  while (walker.nextNode()) { if (walker.currentNode.data.replace(/[\\s\\u200b]/g, '')) { text = walker.currentNode; break; } }
  if (!text) return {ok: false, error: '这一块没有文字'};
  surface.focus();
  const r = d.createRange(); r.setStart(text, ${offset}); r.collapse(true);
  const s = w.getSelection(); s.removeAllRanges(); s.addRange(r);
  return {ok: true}; })()`;

module.exports = {
  id: '110-vertical-column-and-block-select',
  title: '纵向移动保列不跳行 / 块公式可被拖拽选中',
  run: async ctx => {
    const out = ctx.outDir;
    fs.mkdirSync(out, {recursive: true});
    const file = path.join(out, 'vertical.md');
    const body = ['第一段文字', '', '第二段文字', '', '$q$', '', '第三段文字', '', '第四段文字', '',
      '$$', 'a+b=1', '$$', '', '下段文字', ''].join('\n');
    fs.writeFileSync(file, body, 'utf8');
    const session = await ctx.launch({args: [file], inspect: true});
    const press = async (key, modifiers = 0) => {
      await session.key({key, code: key, vk: harness.VK[key], modifiers});
      await harness.sleep(430);
    };
    try {
      await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector(${JSON.stringify(SURFACE)})); })()`,
        {timeout: 140000, interval: 80});
      await harness.sleep(1600);
      const before = await session.js(READ);

      // ══ ① 从下往上：进公式行、回来还是同一列 ══════════════════════════════
      const placed = await session.js(placeIn(3, 0));   // 第三段文字（纯公式行的下一段）开头；块序号：0 第一段 1 第二段 2 纯公式行 3 第三段 4 第四段 5 块公式 6 下段
      ctx.assert('① 能把光标放到纯公式行下面那一段的开头（列 0）', placed.ok, JSON.stringify(placed));
      await harness.sleep(320);
      const start = await session.js(READ);
      await press('ArrowUp');
      const up = await session.js(READ);
      ctx.witness('DOM：↑ 进纯公式行', {起点: start, 上移后: up}, 'geometry');
      ctx.assert('① ↑ 落到**那一行**（光标进公式源码），不是跳过它跑到更前面一行',
        up.块 === 2 && up.层 === '源码', JSON.stringify({起点: start.块, 上移后: {块: up.块, 层: up.层, 文本: up.块文本}}));
      await press('ArrowDown');
      const back = await session.js(READ);
      ctx.witness('DOM：↓ 回到下一段', {回来: back}, 'geometry');
      ctx.assert('② ↓ 回来后**列与出发时一致**（目标列保持，不再漂到别处）',
        back.块 === start.块 && Math.abs(back.光标x - start.光标x) <= 3,
        JSON.stringify({出发x: start.光标x, 回来x: back.光标x, 出发块: start.块, 回来块: back.块}));
      await press('ArrowUp');
      await press('ArrowDown');
      const again = await session.js(READ);
      ctx.assert('② 再往返一次仍然回到同一列（不是"第一次对、第二次乱"）',
        again.块 === start.块 && Math.abs(again.光标x - start.光标x) <= 3,
        JSON.stringify({出发x: start.光标x, 回来x: again.光标x}));

      // ══ ③ 从上往下：不许整行跳过（进公式 → 出去必须是紧邻的那一行）═════════
      await session.js(placeIn(1, 0));   // 第二段文字
      await harness.sleep(320);
      const fromTop = await session.js(READ);
      await press('ArrowDown');
      const down = await session.js(READ);
      ctx.assert('③ ↓ 从上一段进纯公式行（源码形态）',
        down.块 === 2 && down.层 === '源码', JSON.stringify({起点: fromTop.块, 下移后: {块: down.块, 层: down.层}}));
      await press('ArrowUp');
      const out = await session.js(READ);
      ctx.witness('DOM：进公式行后再 ↑ 出去', {出去后: out}, 'geometry');
      ctx.assert('③ 从公式源码里 ↑ 出去落在**紧邻的上一段**（没有跳行）',
        out.块 === fromTop.块, JSON.stringify({期望块: fromTop.块, 实际块: out.块, 文本: out.块文本}));

      // ══ ④ 块公式：鼠标拖拽跨过它必须整条选进来 ═════════════════════════════
      const drag = await session.js(`(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor');
        const surface = d.querySelector(${JSON.stringify(SURFACE)});
        const above = [...surface.children].find(node => String(node.textContent || '').includes('第四段文字'));
        const block = [...surface.children].find(node => node.dataset.type === 'math-block');
        if (!above || !block || !block.nextElementSibling) return {ok: false, error: '素材里没有"段+块公式+段"'};
        const ar = above.getBoundingClientRect(), br = block.nextElementSibling.getBoundingClientRect();
        const fr = frame.getBoundingClientRect();
        return {ok: true, from: {x: Math.round(fr.x + ar.left + ar.width - 8), y: Math.round(fr.y + ar.top + ar.height / 2)},
          to: {x: Math.round(fr.x + br.left + 30), y: Math.round(fr.y + br.top + br.height / 2)}}; })()`);
      if (drag.ok) {
        await session.click(drag.from.x, drag.from.y);
        await harness.sleep(250);
        await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: drag.from.x, y: drag.from.y, button: 'left', buttons: 1, clickCount: 1});
        for (let step = 1; step <= 8; step++) {
          await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', buttons: 1,
            x: Math.round(drag.from.x + (drag.to.x - drag.from.x) * step / 8),
            y: Math.round(drag.from.y + (drag.to.y - drag.from.y) * step / 8)});
          await harness.sleep(45);
        }
        await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: drag.to.x, y: drag.to.y, button: 'left', buttons: 0, clickCount: 1});
        await harness.sleep(500);
        const grabbed = await session.js(READ);
        const skin = await session.js(`(() => { const w = ${IF}, d = w.document;
          const surface = d.querySelector(${JSON.stringify(SURFACE)});
          const block = [...surface.children].find(node => node.dataset.type === 'math-block');
          const code = block?.querySelector('code[data-type="math-block"]');
          const box = code ? code.getBoundingClientRect() : null;
          return {挂选中类: !!block?.classList.contains('typora-ir-selected'),
            源码宽高: box ? [Math.round(box.width), Math.round(box.height)] : null}; })()`);
        await harness.sleep(400);
        const later = await session.js(READ);
        ctx.witness('DOM：拖拽跨过块公式', {拖拽后: grabbed, 皮肤: skin, 一秒后: later}, 'geometry');
        ctx.assert('④ 拖拽跨过块公式：选区里有块公式的源码（不是只选到两边的正文）',
          grabbed.选区.includes('a+b=1'), JSON.stringify({选区: grabbed.选区, 长度: grabbed.选区长度}));
        ctx.assert('④ 块公式在这个手势里**翻成源码**显示（看得出它被选中了）',
          skin.挂选中类 && skin.源码宽高 && skin.源码宽高[0] > 10 && skin.源码宽高[1] > 8,
          JSON.stringify(skin));
        ctx.assert('④ 松手一秒后选区还在（不会被浏览器悄悄收窄回去）',
          later.选区 === grabbed.选区 && later.选区.includes('a+b=1'),
          JSON.stringify({松手时: grabbed.选区, 一秒后: later.选区}));
        const saved = await edge.saveAndWait(session, file, {timeout: 8000});
        const disk = String(saved.after).replace(/\r/g, '');
        ctx.witness('磁盘：一路选中没有改过文档', {磁盘: disk.slice(0, 60)}, 'disk');
        ctx.assert('④ 全程只选中、不改文档（磁盘逐字节等于打开时）',
          disk === body, JSON.stringify({磁盘长度: disk.length, 期望长度: body.length}));
      } else {
        ctx.assert('④ 找得到"段 + 块公式 + 段"的素材', false, JSON.stringify(drag));
      }
    } finally {
      await ctx.release(session);
    }
  },
};
