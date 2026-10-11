/** 2.1.28：标题级别角标（H1..H6）的左侧留空在窄窗口下消失。
 *
 *  用户转述 issue 提出者（B 站）的说法：窗口缩窄到一定程度后，标题级别角标左侧的留空没了，
 *  右侧留空照旧。根因（在真实 DOM 上量出来的）：角标不是我们画的，是 vditor 的
 *  `.vditor-ir .vditor-reset > h1:before`——`float:left; margin-left:-29px`，挂在**内容盒
 *  左侧 29px 之外**。而 v2.0.6 起阅读版心的左右垫边同宽 `max(28px, (100vw-1280px)/2)`：
 *  窗口一窄到版心不再留白（编辑器宽度 ≤1336），垫边退到 28px < 29px，角标被顶出滚动容器
 *  左缘、只剩 1px 露在边上，左边的空白等于没有了；右边 28px 照旧——正是用户看到的样子。
 *
 *  判据不看源码，看**窗口真实像素**：在写作区左边那条 46px 里逐列数"墨"，找出第一列有墨的
 *  位置。修好后角标画在离内容盒左缘 17px 处（= 46-29），所以第一列有墨 ≈17px；修之前 ≈0px。
 *  这条 A/B 对得上：旧产物上必然失败，新产物上必然通过。
 *
 *  素材现场生成，不碰受保护素材。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '98-heading-badge-left-gutter-2.1.28',
  title: '窄窗口下标题级别角标（H1..H6）必须留住左侧留空',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '98-round');
    fs.mkdirSync(dir, {recursive: true});
    const IF = `document.getElementById('editor').contentWindow`;
    const file = path.join(dir, '角标留空.md');
    fs.writeFileSync(file, ['# 一级标题', '', '首段正文。', '', '## 二级标题', '', '第二段。', ''].join('\n'));

    // inspect: true 才拿得到主进程通道（窗口尺寸 / capturePage 的真实像素）
    const session = await ctx.launch({args: [file], inspect: true});
    try {
      await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset h1')); })()`, {timeout: 120000, interval: 60});
      await sleep(2200);
      await session.send('Page.bringToFront');
      const work = JSON.parse(await session.main.js(`JSON.stringify(require('electron').screen.getPrimaryDisplay().workAreaSize)`));
      // 先量一次"宽窗口"（版心两侧都还有留白）：用来钉住"宽窗口观感一点没变"
      const wide = Math.max(900, Math.min(work.width - 60, 1700));
      const WIDTHS = [wide, 1200, 900, 700, 560, 460];

      /** 写作区左边 46px 的逐列墨量。背景取该区域最左两列的均值——深色/浅色主题都成立。
       *  这是**窗口真实像素**通道（webContents.capturePage），不是产品自报。 */
      const PROFILE = region => `(async () => {
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
        const cols = [];
        for (let x = x0; x < x1; x++) { let ink = 0; for (let y = y0; y < y1; y++) if (Math.abs(lum((y * size.width + x) * 4) - bg) > 0.08) ink++; cols.push(ink); }
        return JSON.stringify({bg: +bg.toFixed(3), scale: +scale.toFixed(3), cols}); })()`;

      /** 量当前几何：垫边、内容盒、角标标称悬挂位置、以及那 46px 的墨量剖面。 */
      const GEOMETRY = `(() => { const frame = document.getElementById('editor'), w = ${IF}, d = w.document;
        const fr = frame.getBoundingClientRect();
        const reset = d.querySelector('.vditor-ir .vditor-reset');
        const h1 = reset.querySelector('h1');
        const cs = w.getComputedStyle(reset), hs = w.getComputedStyle(h1, '::before');
        const rr = reset.getBoundingClientRect(), hr = h1.getBoundingClientRect();
        return JSON.stringify({page: {frameLeft: Math.round(fr.left), frameTop: Math.round(fr.top)},
          resetLeft: Math.round(rr.left), resetTop: Math.round(rr.top),
          h1Top: Math.round(hr.top), h1Height: Math.round(hr.height),
          padLeft: Math.round(parseFloat(cs.paddingLeft)), padRight: Math.round(parseFloat(cs.paddingRight)),
          contentLeft: Math.round(rr.left + parseFloat(cs.paddingLeft)),
          contentRight: Math.round(rr.right - parseFloat(cs.paddingRight)),
          badgeHang: parseFloat(hs.marginLeft), badgeFloat: hs.float, badgeContent: hs.content,
          h1TextLeft: Math.round(hr.left), sw: reset.scrollWidth, cw: reset.clientWidth}); })()`;

      const rows = [];
      for (const width of WIDTHS) {
        await session.main.js(`(() => { const {BrowserWindow} = require('electron');
          const win = BrowserWindow.getAllWindows()[0];
          win.setBounds({x: 60, y: 60, width: ${width}, height: 780}); return 1; })()`);
        await sleep(900);
        const geo = JSON.parse(await session.js(GEOMETRY));
        const band = {x: geo.page.frameLeft + geo.resetLeft, y: geo.page.frameTop + geo.h1Top, w: 46, h: geo.h1Height};
        const shot = JSON.parse(await session.main.js(PROFILE(band)));
        const scale = shot.scale || 1;
        const firstInk = shot.cols.findIndex(count => count >= 2);
        const row = {width, padLeft: geo.padLeft, padRight: geo.padRight, contentLeft: geo.contentLeft,
          contentRight: geo.contentRight, badgeHang: geo.badgeHang, badgeFloat: geo.badgeFloat,
          badgeContent: geo.badgeContent, badgeLeft: geo.padLeft + geo.badgeHang,
          firstInkPx: firstInk < 0 ? null : Math.round((firstInk / scale) * 10) / 10, bg: shot.bg,
          centered: geo.padLeft === geo.padRight, h1TextLeft: geo.h1TextLeft, resetLeft: geo.resetLeft,
          overflow: geo.sw > geo.cw};
        rows.push(row);
        console.log(`窗口 ${width}：左垫 ${row.padLeft} 右垫 ${row.padRight} 角标标称左缘 ${row.badgeLeft}px · 像素上第一列有墨 ${row.firstInkPx}px · 背景亮度 ${row.bg} · 角标 ${geo.badgeFloat} ${geo.badgeHang} ${geo.badgeContent}`);
        if (width === WIDTHS[0] || width === 900) {
          const clip = {x: Math.max(0, Math.round(band.x - 6)), y: Math.max(0, Math.round(band.y - 4)),
            width: 200, height: Math.max(24, Math.round(band.h + 8)), scale: 4};
          try {
            const png = await session.send('Page.captureScreenshot', {format: 'png', clip});
            fs.writeFileSync(path.join(dir, `放大-左边-${width}.png`), Buffer.from(png.data, 'base64'));
          } catch (error) { console.log('放大截图失败（只是证据，不影响判据）', JSON.stringify(clip), String(error && error.message)); }
        }
      }
      ctx.witness('① 各宽度下的垫边、角标标称位置与窗口真实像素剖面的第一列墨', rows);

      const narrow = rows.filter(row => !row.centered);
      ctx.assert('① 角标确实是 vditor 画的外挂浮标（float:left; margin-left:-29px）——不是我们自己的元素',
        rows.every(row => row.badgeFloat === 'left' && row.badgeHang === -29), rows[0]);
      ctx.assert('① 每档宽度下角标都在滚动容器内留出左边空白（第一列有墨 ≥10px，且 ≤32px 说明量到的就是角标）',
        rows.every(row => row.firstInkPx !== null && row.firstInkPx >= 10 && row.firstInkPx <= 32),
        rows.map(row => `${row.width}:${row.firstInkPx}`).join(' '));
      ctx.assert('① 窄窗口（版心不留白，编辑器 ≤1336）下左垫边 ≥ 角标悬挂 29px + 呼吸位',
        narrow.length > 0 && narrow.every(row => row.padLeft >= 37), narrow.map(row => `${row.width}:${row.padLeft}`).join(' '));
      ctx.assert('① 窄窗口下右边垫边保持原样 28px（用户说右侧是正常的，不该被一起改）',
        narrow.every(row => row.padRight === 28), narrow.map(row => `${row.width}:${row.padRight}`).join(' '));
      ctx.assert('① 宽窗口（版心两侧都还有留白）下左右垫边仍然相等 = 版心居中，观感与 v2.0.6 完全一致',
        rows.filter(row => row.centered).length >= 1 && rows.filter(row => row.centered).every(row => row.padLeft === row.padRight),
        rows.filter(row => row.centered).map(row => `${row.width}:${row.padLeft}/${row.padRight}`).join(' '));
      ctx.assert('① 每档宽度下正文都没有横向溢出（角标不该把内容挤到要横滚）',
        rows.every(row => !row.overflow), rows.map(row => `${row.width}:${row.overflow}`).join(' '));
      ctx.assert('① 正文左缘 = 左垫边（角标画在垫边里，不挤正文）',
        rows.every(row => row.h1TextLeft - row.resetLeft === row.padLeft),
        rows.map(row => `${row.width}:${row.h1TextLeft - row.resetLeft}`).join(' '));
    } finally {
      await session.close();
    }

    // ---------- ② 产物级：源与开发树一致（EXE 与 VSIX 吃的是同一份 CSS） ----------
    const source = 'E:/MarkPilot/Typora-Editor/extension-src/render/css/typography.css';
    const shared = path.join(harness.project, 'app/renderer/css/typography.css');
    const text = fs.existsSync(source) ? fs.readFileSync(source, 'utf8') : '';
    const copy = fs.existsSync(shared) ? fs.readFileSync(shared, 'utf8') : '';
    ctx.witness('② 两份 typography.css（源 vs 开发树）', {source: text.length, shared: copy.length, same: text === copy});
    ctx.assert('② 源与开发树逐字节一致，且左垫边下限写死为 ≥46px',
      !!text && text === copy && /padding-left:\s*max\(46px/.test(text) && /padding-right:\s*max\(28px/.test(text),
      {same: text === copy, left: /padding-left:\s*max\(46px/.test(text), right: /padding-right:\s*max\(28px/.test(text)});
  },
};
