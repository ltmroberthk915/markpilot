/** 2.1.25：桌面端工具栏与浮层的两处收口。
 *
 *  ① 桌面 EXE 不再提供「使用vscode默认编辑器」这个出口（用户令 2026-09-15：桌面端不该把文件交给
 *     另一个程序去编辑，那等于要在桌面侧维护第二套编辑内核的入口）。VSIX 里保留——在那里它就是
 *     "回到 VS Code 自己的文本编辑器"，同一个宿主内的正常动作。判据：真 DOM 里读工具栏所有按钮的
 *     提示文字（不是 grep 源码）；再对**产物**里的 toolbar.js 做静态确认（VSIX 侧那一份必须还在）。
 *
 *  ② 工具栏的悬停菜单（编辑模式/标题…）在 Vditor 里点开就一直挂着：只有"再点一次同一个按钮"或
 *     "点别的按钮"才收，指针移开不动它（用户反馈 GitHub issue #1：「悬浮控件会持续停留，没有及时
 *     消失」，截图里菜单正盖在正文上）。判据：真鼠标点开 → 菜单可见；指针移进正文 → 菜单消失。
 *
 *  素材现场生成，不碰受保护素材。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '95-toolbar-and-floating-panels-2.1.25',
  title: '桌面端工具栏：去掉 VS Code 出口 / 浮层菜单指针移开即收',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '95-round');
    fs.mkdirSync(dir, {recursive: true});
    const IF = `document.getElementById('editor').contentWindow`;
    const file = path.join(dir, '工具栏.md');
    fs.writeFileSync(file, ['# 工具栏验收', '', '正文一段，用来让指针有个"离开工具栏"的去处。', '', '```js', 'const a = 1;', '```', ''].join('\n'));

    const session = await ctx.launch({args: [file]});
    try {
      await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-toolbar__item button')); })()`, {timeout: 90000, interval: 60});
      await sleep(2300);
      await session.send('Page.bringToFront');

      // ---------- ① 桌面端工具栏里不许有"跳到 VS Code"这个出口 ----------
      const TIPS = `(() => { const w = ${IF}, d = w.document;
        const bar = d.querySelector('.vditor-toolbar');
        if (!bar) return {none: true};
        const items = [...bar.querySelectorAll('.vditor-toolbar__item')];
        const rows = items.map(item => {
          const btn = item.querySelector('button');
          return {type: btn ? String(btn.dataset.type || '') : null,
            tip: String(item.getAttribute('data-tip') || btn?.getAttribute('data-tip') || '').trim(),
            title: String(btn?.getAttribute('title') || '').trim(),
            aria: String(btn?.getAttribute('aria-label') || '').trim(),
            iconPath: String(item.querySelector('svg path')?.getAttribute('d') || '').slice(0, 24)};
        });
        return {count: items.length, rows, text: String(bar.textContent).replace(/\\s+/g, ' ').slice(0, 200),
          hasVSCodeIcon: !!bar.querySelector('svg[viewBox="-11.9 -2 1003.9 995.6"]')}; })()`;
      const tips = await session.js(TIPS);
      ctx.witness('① 工具栏全部按钮（真 DOM 读出的提示文字）', tips);
      const vscodeHit = (tips.rows || []).filter(row => /vscode/i.test(row.tip + row.title + row.aria));
      ctx.assert('① 桌面端工具栏里没有「使用vscode默认编辑器」这个按钮（提示文字里没有 vscode）',
        !tips.none && vscodeHit.length === 0, {count: tips.count, hits: vscodeHit});
      ctx.assert('① 桌面端工具栏里没有那个 VS Code 图标（按 svg viewBox 认，不认文字）',
        tips.hasVSCodeIcon === false, {hasVSCodeIcon: tips.hasVSCodeIcon});
      ctx.assert('① 工具栏本身还在（不是整个工具栏都没了）', (tips.count || 0) >= 15, {count: tips.count});

      // ---------- ② 悬停菜单：点开 → 指针移进正文 → 必须收起来 ----------
      const modeAt = await session.js(`(() => { const w = ${IF}, frame = document.getElementById('editor'), fr = frame.getBoundingClientRect();
        const btn = [...w.document.querySelectorAll('.vditor-toolbar__item button')].find(b => b.dataset.type === 'edit-mode');
        if (!btn) return null; const r = btn.getBoundingClientRect();
        return {x: Math.round(fr.x + r.left + r.width / 2), y: Math.round(fr.y + r.top + r.height / 2)}; })()`);
      ctx.witness('② 编辑模式按钮的屏幕坐标', modeAt);
      if (!modeAt) { ctx.assert('② 找得到"编辑模式"按钮', false, null); return; }
      const FLOATS = `(() => { const w = ${IF}, d = w.document;
        const open = [];
        for (const node of d.querySelectorAll('.vditor-hint, .vditor-panel, .vditor-emojis')) {
          const cs = w.getComputedStyle(node), r = node.getBoundingClientRect();
          if (cs.display === 'none' || cs.visibility === 'hidden' || !r.height) continue;
          open.push({cls: String(node.className).slice(0, 40), text: String(node.textContent).trim().slice(0, 20), x: Math.round(r.left), y: Math.round(r.top)});
        }
        return open; })()`;
      await session.move(modeAt.x, modeAt.y);
      await sleep(120);
      await session.click(modeAt.x, modeAt.y);
      await sleep(700);
      const opened = await session.js(FLOATS);
      ctx.witness('② 点开「编辑模式」之后的浮层', opened);
      ctx.assert('② 点开编辑模式确实弹出菜单（这一步同时是下一条的前提）', opened.length > 0, opened);
      // 指针移进正文（离工具栏远远的）
      await session.move(modeAt.x - 300, modeAt.y + 320);
      await sleep(800);
      const after = await session.js(FLOATS);
      ctx.witness('② 指针移进正文 800ms 之后的浮层', after);
      ctx.assert('② 指针一离开工具栏，悬停菜单立刻收起来（不再压在正文上）', after.length === 0, after);
      await session.shot('02-after-pointer-left');

      // 独立证人：把菜单打开时的窗口像素与收起后的像素比一比（菜单压在正文上时那块区域一定有变化）
      if (session.main) {
        const REGION = `(async () => {
          const {BrowserWindow} = require('electron');
          const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
          const image = await win.webContents.capturePage();
          const size = image.getSize(), bitmap = image.toBitmap();
          const scale = size.width / (win.getContentBounds().width || size.width);
          const r = ${JSON.stringify({x: modeAt.x - 200, y: modeAt.y + 40, w: 380, h: 110})};
          const x0 = Math.max(0, Math.round(r.x * scale)), y0 = Math.max(0, Math.round(r.y * scale));
          const x1 = Math.min(size.width, Math.round((r.x + r.w) * scale)), y1 = Math.min(size.height, Math.round((r.y + r.h) * scale));
          let ink = 0, n = 0;
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * size.width + x) * 4;
            const l = (bitmap[i] * 0.11 + bitmap[i + 1] * 0.59 + bitmap[i + 2] * 0.3) / 255; if (l > 0.45) ink++; n++; }
          return JSON.stringify({n, ink: +(ink / n).toFixed(3)});
        })()`;
        const closedInk = JSON.parse(await session.main.js(REGION));
        await session.move(modeAt.x, modeAt.y);
        await sleep(120);
        await session.click(modeAt.x, modeAt.y);
        await sleep(700);
        const openInk = JSON.parse(await session.main.js(REGION));
        await session.move(modeAt.x - 300, modeAt.y + 320);
        await sleep(800);
        const backInk = JSON.parse(await session.main.js(REGION));
        ctx.witness('② 菜单区域窗口真实像素墨量（关上 → 打开 → 再关上）', {closed: closedInk, open: openInk, back: backInk});
        ctx.assert('② 窗口真实像素同样说明菜单真的没了（再关上之后与关上时一致，且与打开时不同）',
          Math.abs(backInk.ink - closedInk.ink) < 0.02 && Math.abs(openInk.ink - closedInk.ink) > 0.005,
          {closed: closedInk, open: openInk, back: backInk});
      }
    } finally {
      await session.close();
    }

    // ---------- ③ 产物级：VSIX 侧那一份必须**保留**这个出口（桌面端去掉不等于把它一起删了） ----------
    const vsixSource = 'E:/MarkPilot/Typora-Editor/extension-src/render/js/toolbar.js';
    const shared = path.join(harness.project, 'app/renderer/js/toolbar.js');
    const source = fs.existsSync(vsixSource) ? fs.readFileSync(vsixSource, 'utf8') : '';
    const copy = fs.existsSync(shared) ? fs.readFileSync(shared, 'utf8') : '';
    ctx.witness('③ toolbar.js 的两份副本（源 vs 开发树）', {source: source.length, shared: copy.length, same: source === copy});
    ctx.assert('③ 源与开发树里的 toolbar.js 逐字节一致（同一份代码同时供 EXE 与 VSIX）',
      !!source && source === copy, {source: source.length, shared: copy.length});
    ctx.assert('③ 出口由宿主标志门控（`window.__vscodeHost` 才带这段），不是被整段删掉——VSIX 里必须还在',
      /window\.__vscodeHost \? \[\{[\s\S]{0,400}?tip: "使用vscode默认编辑器"/.test(source) && /handler\.emit\("editInVSCode"\)/.test(source),
      {gated: /window\.__vscodeHost \? \[\{/.test(source), kept: /tip: "使用vscode默认编辑器"/.test(source)});
  },
};
