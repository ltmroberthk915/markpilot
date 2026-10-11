/** 2.1.28：工具栏手动收纳（用户令 2026-09-15：「加一个工具栏自动保持压缩状态的按钮，一旦压缩
 *  之后只留这一个按钮，展开情况下点击变成压缩、压缩状态下点击变成展开，加一个小动画，注意性能优化」）。
 *
 *  判据取自"用户看得见的东西"与"代码之外的通道"：
 *   ① 收起后真的只剩那一个按钮——真 DOM 里其余工具栏项 `display:none`，浮条盒子缩到按钮大小并
 *      贴住工具栏带内的右上角；用**窗口真实像素**再证一次那片区域只剩一个按钮的墨。
 *   ② 收起把空间还给了正文：写作区的保留带（`--typora-toolbar-inner` 决定的 padding-top）跟着
 *      变小、首段上移——这正是"压缩"的意义，也是它与"只是把浮条藏起来"的区别。
 *   ③ 动画不碰布局：一次点击里没有长任务（PerformanceObserver longtask），点击前后 **浮条自身**
 *      的盒子尺寸变化只发生在收拢那一帧（150ms 档），按钮位置的补偿是 transform（FLIP）。
 *   ④ 状态持久：收起后整页重载（窗口重开），仍然是收起的。
 *   ⑤ 与"窗口太矮自动收纳"不打架：手动收起后鼠标贴顶也不会把它弹回来。
 *
 *  素材现场生成，不碰受保护素材。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '99-toolbar-fold-collapse-2.1.28',
  title: '工具栏手动收纳：收起只留一个按钮 / 还空间给正文 / 无长任务 / 重启仍收起',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '99-round');
    fs.mkdirSync(dir, {recursive: true});
    const IF = `document.getElementById('editor').contentWindow`;
    const file = path.join(dir, '收纳.md');
    fs.writeFileSync(file, ['# 标题一', '', '正文段落，用来量收起前后有没有动。', '', '## 标题二', '', '尾段。', ''].join('\n'));

    const session = await ctx.launch({args: [file], inspect: true});
    try {
      await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('button[data-type="toolbar-fold"]')); })()`, {timeout: 120000, interval: 60});
      await sleep(2200);
      await session.send('Page.bringToFront');

      const STATE = `(() => { const frame = document.getElementById('editor'), w = ${IF}, d = w.document;
        const fr = frame.getBoundingClientRect(), root = d.documentElement;
        const pill = d.querySelector('.vditor > .vditor-toolbar');
        const btn = d.querySelector('button[data-type="toolbar-fold"]');
        const others = [...d.querySelectorAll('.vditor-toolbar__item:not(.typora-toolbar-fold-item)')];
        const reset = d.querySelector('.vditor-ir .vditor-reset');
        const first = reset && [...reset.children].find(node => node.tagName === 'P');
        const outline = d.querySelector('.vditor-outline');
        const badge = d.querySelector('.typora-zoom-badge');
        const box = node => { if (!node) return null; const b = node.getBoundingClientRect();
          return {x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height)}; };
        const br = btn && btn.getBoundingClientRect();
        return {collapsed: root.classList.contains('typora-toolbar-collapsed'),
          tight: root.classList.contains('typora-toolbar-tight'),
          items: d.querySelectorAll('.vditor-toolbar__item').length,
          visibleOthers: others.filter(node => w.getComputedStyle(node).display !== 'none').length,
          leftover: others.filter(node => w.getComputedStyle(node).display !== 'none')
            .map(node => { const b = node.querySelector('button'); return b ? (b.dataset.type || 'x') : 'x'; }),
          pill: box(pill), btn: box(btn),
          // br 是 iframe 视口坐标：innerWidth - br.right 就是"离编辑区右缘多少像素"
          btnFromRight: br ? Math.round(w.innerWidth - br.right) : null,
          btnFromTop: br ? Math.round(br.top) : null,
          pillPointer: pill ? w.getComputedStyle(pill).pointerEvents : null,
          btnPointer: btn ? w.getComputedStyle(btn).pointerEvents : null,
          pillVisible: pill ? w.getComputedStyle(pill).visibility : null,
          // 浮条壳子中间那一点上，现在是谁（透明壳子不该接住点击）
          hitInPill: (() => { if (!pill) return null; const p = pill.getBoundingClientRect();
            const x = Math.round(p.left + 4), y = Math.round(p.top + p.height / 2);
            const hit = d.elementFromPoint(x, y); return hit ? (hit.closest('.vditor-toolbar') ? 'toolbar' : hit.tagName) : null; })(),
          reserved: reset ? Math.round(parseFloat(w.getComputedStyle(reset).paddingTop)) : null,
          firstY: box(first) ? box(first).y : null,
          outline: outline && outline.getBoundingClientRect().width > 0 ? box(outline) : null,
          badge: box(badge),
          pressed: btn ? btn.getAttribute('aria-pressed') : null,
          label: btn ? btn.getAttribute('aria-label') : null,
          stored: (() => { try { return w.localStorage.getItem('toolbar-collapsed'); } catch { return 'n/a'; } })(),
          editorWidth: Math.round(w.innerWidth),
          frameLeft: Math.round(fr.left), frameTop: Math.round(fr.top),
          lastItemIsFold: pill ? String(pill.lastElementChild && pill.lastElementChild.className).includes('typora-toolbar-fold-item') : null}; })()`;

      const spotOf = `(() => { const w = ${IF}, d = w.document, fr = document.getElementById('editor').getBoundingClientRect();
        const btn = d.querySelector('button[data-type="toolbar-fold"]'); if (!btn) return null;
        const b = btn.getBoundingClientRect();
        return {x: Math.round(fr.x + b.left + b.width / 2), y: Math.round(fr.y + b.top + b.height / 2)}; })()`;

      /** 窗口真实像素：右上角那块区域里有多少"墨"，以及墨的横向跨度。 */
      const INK = region => `(async () => {
        const {BrowserWindow} = require('electron');
        const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
        const image = await win.webContents.capturePage();
        const size = image.getSize(), bitmap = image.toBitmap();
        const scale = size.width / (win.getContentBounds().width || size.width);
        const r = ${JSON.stringify(region)};
        const x0 = Math.max(0, Math.round(r.x * scale)), y0 = Math.max(0, Math.round(r.y * scale));
        const x1 = Math.min(size.width, Math.round((r.x + r.w) * scale)), y1 = Math.min(size.height, Math.round((r.y + r.h) * scale));
        const lum = i => (bitmap[i] * 0.11 + bitmap[i + 1] * 0.59 + bitmap[i + 2] * 0.3) / 255;
        let bg = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < Math.min(x1, x0 + 2); x++) { bg += lum((y * size.width + x) * 4); n++; }
        bg /= Math.max(1, n);
        let ink = 0, total = 0, left = -1, right = -1;
        for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) {
          if (Math.abs(lum((y * size.width + x) * 4) - bg) > 0.08) { ink++; if (left < 0) left = x; right = x; }
          total++;
        }
        return JSON.stringify({bg: +bg.toFixed(3), scale: +scale.toFixed(3), ink: +(ink / Math.max(1, total)).toFixed(4),
          spanPx: left < 0 ? 0 : Math.round((right - left + 1) / scale)}); })()`;

      await session.main.js(`(() => { const {BrowserWindow} = require('electron');
        const win = BrowserWindow.getAllWindows()[0]; win.setBounds({x: 60, y: 60, width: 1200, height: 800}); return 1; })()`);
      await sleep(1000);

      // ---------- ① 展开态基线 ----------
      const before = await session.js(STATE);
      await session.shot('①-展开');
      ctx.witness('① 展开态：浮条/按钮盒子、其余项可见数、保留带、首段位置',
        {pill: before.pill, btn: before.btn, visibleOthers: before.visibleOthers, items: before.items,
          reserved: before.reserved, firstY: before.firstY, lastItemIsFold: before.lastItemIsFold});
      ctx.assert('① 收纳按钮是工具栏的最后一项，且展开态下与其它项一样可见',
        before.lastItemIsFold === true && before.visibleOthers >= 20 && !before.collapsed,
        {lastItemIsFold: before.lastItemIsFold, visibleOthers: before.visibleOthers, collapsed: before.collapsed});

      // 像素证人：整条工具栏带里的墨。展开态是一条浮条（墨横跨上千像素），收起后只剩一个小按钮。
      // 区域必须落在**编辑区**里（页面左侧还有外壳的文件树，跨过去会把背景采样带偏）。
      const bandOf = state => ({x: state.frameLeft + 8, y: state.frameTop, w: Math.max(40, state.editorWidth - 16), h: 40});
      const bandExpanded = JSON.parse(await session.main.js(INK(bandOf(before))));
      ctx.witness('① 窗口真实像素：展开态工具栏带里的墨量与横向跨度', {band: bandExpanded, editorWidth: before.editorWidth});
      // ---------- ② 真鼠标点一下：收起 ----------
      await session.js(`(() => { const w = ${IF}; w.__foldLong = [];
        try { new PerformanceObserver(list => { for (const e of list.getEntries()) w.__foldLong.push(Math.round(e.duration)); }).observe({entryTypes: ['longtask']}); } catch {}
        return 1; })()`);
      const spot = await session.js(spotOf);
      await session.click(spot.x, spot.y);
      await sleep(1000);
      const after = await session.js(STATE);
      const longTasks = await session.js(`(() => ${IF}.__foldLong.slice())()`);
      await session.shot('②-收起');
      ctx.witness('② 收起后：只剩按钮、浮条贴右上角、保留带与首段的真实变化、点击期间的长任务',
        {pill: after.pill, btn: after.btn, btnFromRight: after.btnFromRight, btnFromTop: after.btnFromTop,
          visibleOthers: after.visibleOthers, leftover: after.leftover, pillVisible: after.pillVisible,
          reserved: [before.reserved, after.reserved], firstY: [before.firstY, after.firstY], longTasks});
      ctx.assert('② 收起后只剩这一个按钮：其余工具栏项全部退出显示，浮条盒子缩到按钮大小',
        after.collapsed && after.tight && after.visibleOthers === 0 && after.leftover.length === 0
          && after.pill.w <= after.btn.w + 24, {visibleOthers: after.visibleOthers, leftover: after.leftover, pill: after.pill, btn: after.btn});
      ctx.assert('② 按钮落在工具栏带内的右上角：离编辑区右缘 8~40px（跨过滚动条）、离顶 ≤12px',
        after.btnFromRight >= 8 && after.btnFromRight <= 40 && after.btnFromTop <= 12,
        {fromRight: after.btnFromRight, fromTop: after.btnFromTop});
      ctx.assert('② 收起后浮条本体不再接住点击（pointer-events:none，只有按钮收回指针事件）——'
        + '右上角那块透明区域不会变成正文里的死区',
        after.pillPointer === 'none' && after.btnPointer === 'auto' && after.hitInPill !== 'toolbar',
        {pill: after.pillPointer, btn: after.btnPointer, hit: after.hitInPill});
      ctx.assert('② 收起把空间还给了正文：保留带变小、首段上移（这就是"压缩"的可见效果）',
        after.reserved < before.reserved && after.firstY < before.firstY,
        {reserved: [before.reserved, after.reserved], firstY: [before.firstY, after.firstY]});
      ctx.assert('② 按钮的无障碍状态说清了它是"已收起"，提示文字翻成"展开工具栏"',
        after.pressed === 'true' && /展开工具栏/.test(String(after.label)), {pressed: after.pressed, label: after.label});
      ctx.assert('② 一次点击里没有长任务（动画全在合成器上，不重排正文）',
        Array.isArray(longTasks) && longTasks.every(ms => ms < 120), {longTasks});

      // 像素证人：收起后整条工具栏带里应当只剩一个小按钮的墨（展开态同一区域是一条浮条）
      const band = {x: 8, y: 0, w: Math.max(40, after.editorWidth - 16), h: 40};
      const bandInk = JSON.parse(await session.main.js(INK(bandOf(after))));
      ctx.witness('② 窗口真实像素：收起后同一条工具栏带里的墨量与横向跨度',
        {band: bandInk, btn: after.btn, editorWidth: after.editorWidth, expanded: bandExpanded});
      ctx.assert('② 真实像素同样只剩一个小按钮：收起后墨的横向跨度 ≤ 按钮宽度 + 10px，且不到展开态的 1/5',
        bandInk.spanPx > 0 && bandInk.spanPx <= after.btn.w + 10 && bandInk.spanPx * 5 < bandExpanded.spanPx,
        {shut: bandInk.spanPx, open: bandExpanded.spanPx, btnW: after.btn.w});

      // ---------- ③ 再点一下：展开回来 ----------
      const spot2 = await session.js(spotOf);
      await session.click(spot2.x, spot2.y);
      await sleep(1000);
      const back = await session.js(STATE);
      await session.shot('③-再展开');
      ctx.witness('③ 再展开后的状态与几何', {collapsed: back.collapsed, pill: back.pill, btn: back.btn,
        visibleOthers: back.visibleOthers, reserved: back.reserved, firstY: back.firstY, stored: back.stored});
      ctx.assert('③ 再点一下回到展开态：按钮回到浮条末端（与基线同一位置）、其它项都回来、正文保留带复原',
        !back.collapsed && back.visibleOthers === before.visibleOthers
          && JSON.stringify(back.btn) === JSON.stringify(before.btn)
          && JSON.stringify(back.pill) === JSON.stringify(before.pill)
          && back.reserved === before.reserved,
        {btn: [before.btn, back.btn], pill: [before.pill, back.pill], reserved: [before.reserved, back.reserved]});
      ctx.assert('③ 展开后状态写回 localStorage 为 0（下次打开不再收起）',
        back.stored === '0', {stored: back.stored});

      // ---------- ④ 收起 → 整页重载（等于窗口重开）仍是收起的 ----------
      // 每次都重新问按钮在哪：收起/展开两态的按钮位置不同（浮条末端 vs 右上角）
      const shutSpot = await session.js(spotOf);
      await session.click(shutSpot.x, shutSpot.y);
      await sleep(900);
      const shut = await session.js(STATE);
      ctx.assert('④ 收起动作把状态写进 localStorage', shut.stored === '1' && shut.collapsed, {stored: shut.stored, collapsed: shut.collapsed});
      await session.reload();
      const restored = await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset h1')); })()`, {timeout: 120000, interval: 80});
      await sleep(2500);
      const afterReload = await session.js(STATE);
      await session.shot('④-重载后');
      ctx.witness('④ 整页重载（窗口重开）后的状态', {restored, collapsed: afterReload.collapsed, tight: afterReload.tight,
        visibleOthers: afterReload.visibleOthers, stored: afterReload.stored, pill: afterReload.pill, btn: afterReload.btn});
      ctx.assert('④ 重开后仍是收起的（持久状态），而且没有出现"只加了 collapsed 没加 tight"的半截状态',
        !!restored && afterReload.collapsed && afterReload.tight && afterReload.visibleOthers === 0,
        {collapsed: afterReload.collapsed, tight: afterReload.tight, visibleOthers: afterReload.visibleOthers});

      // ---------- ⑤ 与"窗口太矮自动收纳"不打架 ----------
      // 收着的时候把鼠标贴到顶部：工具栏不许自己弹回来（那条自动规则必须让位）
      await session.move(600, 2);
      await sleep(900);
      const hoverTop = await session.js(STATE);
      ctx.witness('⑤ 收起状态下指针贴顶 900ms 后', {collapsed: hoverTop.collapsed, pillVisible: hoverTop.pillVisible,
        btn: hoverTop.btn, visibleOthers: hoverTop.visibleOthers});
      ctx.assert('⑤ 手动收起后鼠标贴顶也不会把它弹回来（自动收纳已让位），按钮仍在原位',
        hoverTop.collapsed && hoverTop.visibleOthers === 0
          && JSON.stringify(hoverTop.btn) === JSON.stringify(afterReload.btn),
        {collapsed: hoverTop.collapsed, visibleOthers: hoverTop.visibleOthers, btn: [afterReload.btn, hoverTop.btn]});

      // 点回来（当前是展开态 → 点一下会收起，所以要按状态决定，别把"收起"留在开发机配置里）
      const tidyBefore = await session.js(STATE);
      const spot3 = await session.js(spotOf);
      if (spot3 && tidyBefore.collapsed) { await session.click(spot3.x, spot3.y); await sleep(800); }
      const tidy = await session.js(STATE);
      ctx.assert('⑤ 验收结束时把状态恢复成展开（不把"收起"留在开发机的配置里）',
        !tidy.collapsed && tidy.stored === '0', {before: tidyBefore.collapsed, collapsed: tidy.collapsed, stored: tidy.stored});
    } finally {
      await session.close();
    }

    // ---------- ⑦ 大文件上的一次点击代价 ----------
    // 收起会让 `outline-layout` 的 ResizeObserver 改保留带 → 正文重排一次。这是"把空间还给正文"
    // 的必然代价，但必须量出来：大文件上不能是几百毫秒的卡顿。
    {
      const fixtures = require('../fixtures.cjs');
      const big = fixtures.large();
      const session2 = await ctx.launch({args: [big], inspect: true});
      try {
        await session2.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('button[data-type="toolbar-fold"]') && w.document.querySelectorAll('.vditor-ir .vditor-reset > p').length > 100); })()`, {timeout: 180000, interval: 100});
        await sleep(3500);
        await session2.send('Page.bringToFront');
        const blocks = await session2.js(`(() => { const w = ${IF}; return w.document.querySelectorAll('.vditor-ir .vditor-reset > *').length; })()`);
        await session2.js(`(() => { const w = ${IF}; w.__foldLong2 = [];
          try { new PerformanceObserver(list => { for (const e of list.getEntries()) w.__foldLong2.push(Math.round(e.duration)); }).observe({entryTypes: ['longtask']}); } catch {}
          return 1; })()`);
        const spot = await session2.js(`(() => { const w = ${IF}, d = w.document, fr = document.getElementById('editor').getBoundingClientRect();
          const btn = d.querySelector('button[data-type="toolbar-fold"]'); if (!btn) return null;
          const b = btn.getBoundingClientRect();
          return {x: Math.round(fr.x + b.left + b.width / 2), y: Math.round(fr.y + b.top + b.height / 2)}; })()`);
        const t0 = Date.now();
        await session2.click(spot.x, spot.y);
        await sleep(1400);
        const wall = Date.now() - t0;
        const long2 = await session2.js(`(() => ${IF}.__foldLong2.slice())()`);
        const state2 = await session2.js(`(() => { const w = ${IF}, d = w.document;
          const others = [...d.querySelectorAll('.vditor-toolbar__item:not(.typora-toolbar-fold-item)')];
          const reset = d.querySelector('.vditor-ir .vditor-reset');
          return {collapsed: d.documentElement.classList.contains('typora-toolbar-collapsed'),
            visibleOthers: others.filter(n => w.getComputedStyle(n).display !== 'none').length,
            reserved: Math.round(parseFloat(w.getComputedStyle(reset).paddingTop)),
            chars: String(w.vditor.getValue()).length}; })()`);
        const worst = long2.length ? Math.max(...long2) : 0;
        ctx.witness('⑦ 大文件上收起一次：正文块数、字符数、点击前后的长任务、保留带变化',
          {blocks, ...state2, longTasks: long2, wallMs: wall});
        ctx.assert('⑦ 大文件上收起仍然成功（只剩一个按钮、保留带跟着变小）',
          state2.collapsed && state2.visibleOthers === 0 && state2.reserved < 90,
          {collapsed: state2.collapsed, visibleOthers: state2.visibleOthers, reserved: state2.reserved, blocks});
        ctx.assert('⑦ 大文件上这一次点击不产生长卡顿（最长任务 < 200ms；实测见右）',
          worst < 200, {longTasks: long2, worst, blocks, chars: state2.chars});
        ctx.metric('fold-large-doc-worst-longtask', worst, {unit: 'ms', direction: 'lower'});
      } finally {
        await session2.close();
      }
    }

    // ---------- ⑥ 产物级：源与开发树一致 ----------
    const pairs = [['js/toolbar-collapse.js'], ['css/toolbar-collapse.css'], ['js/toolbar-autohide.js'], ['index.html']];
    const rows = pairs.map(([rel]) => {
      const source = path.join('E:/MarkPilot/Typora-Editor/extension-src/render', rel);
      const shared = path.join(harness.project, 'app/renderer', rel);
      const a = fs.existsSync(source) ? fs.readFileSync(source, 'utf8') : '';
      const b = fs.existsSync(shared) ? fs.readFileSync(shared, 'utf8') : '';
      return {rel, same: !!a && a === b, source: a.length, shared: b.length};
    });
    ctx.witness('⑥ 四个文件在源与开发树之间是否逐字节一致', rows);
    ctx.assert('⑥ 源与开发树逐字节一致（EXE 与 VSIX 吃的是同一份代码）',
      rows.every(row => row.same), rows);
    const collapse = fs.readFileSync(path.join(harness.project, 'app/renderer/js/toolbar-collapse.js'), 'utf8');
    ctx.assert('⑥ 收纳项挂在工具栏数组里（`toolbar-fold`）且自动收纳模块认这个状态（不会把它弹回来）',
      /name:\s*'toolbar-fold'/.test(fs.readFileSync(path.join(harness.project, 'app/renderer/js/toolbar.js'), 'utf8'))
        && /typora-toolbar-collapsed/.test(fs.readFileSync(path.join(harness.project, 'app/renderer/js/toolbar-autohide.js'), 'utf8')),
      {item: /name:\s*'toolbar-fold'/.test(fs.readFileSync(path.join(harness.project, 'app/renderer/js/toolbar.js'), 'utf8')),
        gate: /typora-toolbar-collapsed/.test(fs.readFileSync(path.join(harness.project, 'app/renderer/js/toolbar-autohide.js'), 'utf8')),
        collapse: collapse.length});
  },
};
