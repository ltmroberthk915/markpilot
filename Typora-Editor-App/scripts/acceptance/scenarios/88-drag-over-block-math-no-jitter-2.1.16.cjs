/** 2.1.16 回归：从下往上拖拽选中、经过 `$$…$$` 块公式时**不许抖**。
 *
 *  用户（2026-09-14 第 7 轮）：「从下往上拉动拖拽选中，一旦经过 $$…$$，出现高频抖动仍未解决」。
 *  2.1.11 修过一次，但修的是**行内**公式（拖拽期间只从视觉上压回渲染态 + `.typora-ir-pointer`）；
 *  块公式没盖到。
 *
 *  取证（scripts/acceptance/probe-jitter.cjs，逐拍 40ms 采块盒几何 + class 翻转 + 端点）：
 *    修前（向上拖）：块公式 `--expand` 翻转 4 次，块盒高度在 **91 ↔ 118** 之间来回
 *    ——差的 27px 正是**源码行**那一条——下面的文字整段跟着位移，指针底下的内容变了、
 *    拖拽端点落到别处，于是再翻一次，来回打转（用户看到的"高频抖动"）。
 *    修法（js/math-edit.js 的 refreshMathEditing）：鼠标按着（`.typora-ir-pointer`）期间
 *    **不展开块公式**，版面全程停在折叠态；松手后 pointer 类摘掉、照旧恢复。
 *    实测修后：翻转 0 次、高度全程 91、顶层块位置只有 1 种取值。
 *
 *  这个场景把"拖拽全程零布局变化"钉成断言，并要求自证"这次拖拽真的选中了东西、真的经过了块公式"。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '88-drag-over-block-math-no-jitter-2.1.16',
  title: '向上拖拽经过块公式：全程零布局变化（不再高频抖动）',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '88-round');
    fs.mkdirSync(dir, {recursive: true});
    const IF = `document.getElementById('editor').contentWindow`;

    const file = path.join(dir, '拖拽抖动.md');
    fs.writeFileSync(file, ['# 拖拽抖动', '',
      '上面第一段：用来做向上拖拽的终点，字要够多。', '',
      '上面第二段：再来一段文字。', '',
      '$$', 'a+b=c', '$$', '',
      '下面第一段：从这里起手往上拖，会经过上面那条块公式，字也要够多。', '',
      '下面第二段：正文。', ''].join('\n'));

    const session = await ctx.launch({args: [file]});
    try {
      const ready = await session.until(`(() => { const w = ${IF}, doc = w && w.document; if (!doc) return false;
        const leaf = [...doc.querySelectorAll('.vditor-ir__preview [data-typora-source-start]')]
          .filter(n => !n.querySelector('[data-typora-source-start]')).find(n => n.getBoundingClientRect().width > 1);
        return !!leaf && !!doc.querySelector('.vditor-ir .vditor-ir__node[data-type="math-block"]'); })()`,
        {timeout: 60000, interval: 80});
      ctx.assert('块公式渲染出了可点的字形（有真几何才谈得上"抖不抖"）', ready, 'timeout 60s');
      if (!ready) return;
      await sleep(1200);

      // 采样器：拖拽期间每 40ms 记一拍（块盒几何 + class 翻转 + 端点 + DOM 变动数）
      await session.js(`(() => { const w = ${IF}, doc = w.document;
        const root = () => doc.querySelector('.vditor-ir .vditor-reset');
        const block = () => doc.querySelector('.vditor-ir .vditor-ir__node[data-type="math-block"]');
        const nm = n => n ? (n.nodeType === 3 ? 'TEXT' : n.tagName) : null;
        const obs = new MutationObserver(records => { if (w.__j && w.__j.on) w.__j.muts += records.length; });
        obs.observe(doc.querySelector('.vditor-ir .vditor-reset'), {subtree: true, attributes: true, childList: true});
        w.__j = {on: false, ticks: [], muts: 0};
        w.__tick = () => { if (!w.__j.on) return;
          const b = block(), r = b ? b.getBoundingClientRect() : null;
          const sel = w.getSelection(), rg = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
          w.__j.ticks.push({t: Math.round(w.performance.now()),
            top: r ? Math.round(r.top) : null, h: r ? Math.round(r.height) : null,
            expand: b ? b.className.indexOf('--expand') >= 0 : null,
            layout: [...root().children].slice(0, 8).map(n => Math.round(n.getBoundingClientRect().top)).join(','),
            anchor: rg ? nm(rg.startContainer) + '@' + rg.startOffset : null,
            focus: rg ? nm(rg.endContainer) + '@' + rg.endOffset : null,
            collapsed: rg ? rg.collapsed : null});
        };
        w.__start = () => { w.__j = {on: true, ticks: [], muts: 0}; return true; };
        w.__stop = () => { w.__j.on = false; return w.__j; };
        w.__sample = () => w.__j.ticks.length;
        clearInterval(w.__jt); w.__jt = setInterval(() => w.__tick(), 40);
        return true; })()`);

      const geom = await session.js(`(() => { const w = ${IF}, doc = w.document, fr = w.frameElement.getBoundingClientRect();
        const root = doc.querySelector('.vditor-ir .vditor-reset');
        const ps = [...root.querySelectorAll('p')];
        const upper = ps.find(p => p.textContent.indexOf('上面第一段') >= 0);
        const lower = ps.find(p => p.textContent.indexOf('下面第一段') >= 0);
        const block = doc.querySelector('.vditor-ir .vditor-ir__node[data-type="math-block"]');
        const at = (node, frac) => { const r = node.getBoundingClientRect();
          return {x: Math.round(fr.x + r.left + r.width * frac), y: Math.round(fr.y + r.top + r.height / 2)}; };
        return {start: at(lower, 0.7), end: at(upper, 0.2), blockBox: (r => ({top: Math.round(r.top), h: Math.round(r.height), bottom: Math.round(r.bottom)}))(block.getBoundingClientRect()),
          upperTop: Math.round(upper.getBoundingClientRect().top), lowerTop: Math.round(lower.getBoundingClientRect().top)}; })()`);
      ctx.witness('起手/终点/块公式的几何', geom);
      ctx.assert('起手点在块公式**下方**、终点在它**上方**（这一拖必然经过块公式）',
        geom.start.y > geom.blockBox.bottom && geom.end.y < geom.blockBox.top,
        {起手: geom.start, 终点: geom.end, 块: geom.blockBox});

      const drag = async (from, to, steps = 14) => {
        await session.js(`(() => { const w = ${IF}; w.__start(); return true; })()`);
        await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: from.x, y: from.y, buttons: 0});
        await sleep(80);
        await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1});
        await sleep(100);
        for (let i = 1; i <= steps; i++) {
          await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', button: 'left', buttons: 1,
            x: Math.round(from.x + (to.x - from.x) * i / steps), y: Math.round(from.y + (to.y - from.y) * i / steps)});
          await sleep(45);
        }
        await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1});
        await sleep(450);
        return session.js(`(() => { const w = ${IF}; return w.__stop(); })()`);
      };
      const summary = d => ({
        拍数: d.ticks.length, DOM变动: d.muts,
        expand翻转: d.ticks.reduce((n, t, i) => n + (i && d.ticks[i - 1].expand !== t.expand ? 1 : 0), 0),
        块盒高度取值: [...new Set(d.ticks.map(t => t.h))],
        块盒top取值: [...new Set(d.ticks.map(t => t.top))],
        顶层块布局取值: [...new Set(d.ticks.map(t => t.layout))].length,
        末拍选区: d.ticks.length ? {anchor: d.ticks[d.ticks.length - 1].anchor, focus: d.ticks[d.ticks.length - 1].focus,
          collapsed: d.ticks[d.ticks.length - 1].collapsed} : null,
      });

      const up = summary(await drag(geom.start, geom.end));
      ctx.witness('A：从下往上拖（经过块公式）逐拍汇总', up);
      ctx.assert('自证：拖拽期间确实采到了多拍、而且真的选中了东西（不是"什么都没发生"）',
        up.拍数 >= 6 && up.末拍选区 && up.末拍选区.collapsed === false, up);
      ctx.assert('A：拖拽全程块公式盒子**高度不变**（抖动的直接判据：源码行被插进版面就会变）',
        up.块盒高度取值.length === 1, {高度取值: up.块盒高度取值});
      ctx.assert('A：拖拽全程块公式 top 不变、下面的文字整段不动',
        up.块盒top取值.length === 1 && up.顶层块布局取值 === 1, {top取值: up.块盒top取值, 布局取值: up.顶层块布局取值});
      ctx.assert('A：拖拽期间块公式一次都没被翻转成源码（--expand 翻转 0 次）',
        up.expand翻转 === 0, {翻转: up.expand翻转});

      await session.js(`(() => { const w = ${IF}; w.getSelection().removeAllRanges(); return true; })()`);
      await sleep(600);
      const down = summary(await drag(geom.end, geom.start));
      ctx.witness('B：对照——从上往下拖', down);
      ctx.assert('B：向下拖同样零布局变化（两个方向都不许抖）',
        down.块盒高度取值.length === 1 && down.块盒top取值.length === 1 && down.expand翻转 === 0, down);

      await session.shot('after-drag');
    } finally {
      await session.close();
    }
  },
};
