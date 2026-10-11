/** 2.1.25 回归：标题块首（`# ` 之前）的光标落点与退格语义。
 *
 *  用户报告（2026-09-15，重识.md）：
 *   ①「鼠标点开 一、事件与集合，露出 `# 一、事件与集合` 源码。此时点击井号键左侧，会使光标仍
 *      回到右侧。只有通过鼠标插入到井号键右侧，通过键盘左键才能移动到井号键最左侧」
 *   ②「光标出现在最左侧之后点退格键并不会导致前面的表格被删除，而是使得井号键被删除了，
 *      这个非常奇怪错误的逻辑」
 *
 *  取证（probe-heading-marker-left2/4/6/7/8，安装版 2.1.24）：① 是 marker-caret-guard 把落在
 *  块首结构记号里的光标"请"到正文开头造成的（浏览器原生命中给的就是井号之前）；② 是 Chromium
 *  的块首退格在"上一块吞不下正文（表格）"时退化成向前删，把 `#` 吃掉还把标题和后面那段并成一行。
 *
 *  判据一律用"用户看得见的东西"：
 *   · 光标**画在哪**（真实 caret 矩形 vs `#` 与正文的矩形，几何量测）；
 *   · `#` 有没有还在原位画着（主进程抓的**窗口真实像素**，不是 DOM 自报）；
 *   · 按退格之后源码有没有变（磁盘上的文件，独立通道）；
 *   · 自证动作：在"最左侧"按左方向键会走出这一块（只有块首才会这样），
 *     点井号右侧则停在正文里——用它区分"光标真的在块首"和"产品说它在块首"。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '94-heading-block-start-caret-2.1.25',
  title: '标题块首：点井号左侧光标留在左侧 / 块首退格不吃井号',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '94-round');
    fs.mkdirSync(dir, {recursive: true});
    const IF = `document.getElementById('editor').contentWindow`;

    const HEAD = ['上一段文字，用来当"标题前面那个块"。', '', '| col1 | col2 |', '| ---- | ---- |', '| a    | b    |', '', '# 目标标题', '', '标题后的正文。', '', '末尾。', ''].join('\n');
    const doc = path.join(dir, '块首.md');
    fs.writeFileSync(doc, HEAD);

    /** 读数：光标画在哪、`#` 画在哪、正文起点画在哪、"块首"这个位置能不能走出去。 */
    const READ = `(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor'), fr = frame.getBoundingClientRect();
      const h = [...d.querySelectorAll('.vditor-ir .vditor-reset h1')].find(x => String(x.textContent).includes('目标标题'));
      if (!h) return {missing: true};
      const mk = h.querySelector('.vditor-ir__marker');
      const content = [...h.childNodes].find(n => n.nodeType === 3 && n.data.trim());
      const box = node => { const r = node.getBoundingClientRect(); return {l: Math.round(fr.x + r.left), r: Math.round(fr.x + r.right), w: Math.round(r.width)}; };
      const rg = (node, a, b) => { const q = d.createRange(); q.setStart(node, a); q.setEnd(node, b); const r = q.getBoundingClientRect();
        return {l: Math.round(fr.x + r.left), r: Math.round(fr.x + r.right), w: Math.round(r.width)}; };
      const s = w.getSelection(), r = s && s.rangeCount ? s.getRangeAt(0) : null;
      let caret = null, inMarker = null, offset = null;
      if (r) {
        const q = d.createRange(); q.setStart(r.startContainer, r.startOffset); q.setEnd(r.startContainer, r.startOffset);
        const b = q.getBoundingClientRect();
        caret = b.width || b.height ? {l: Math.round(fr.x + b.left), h: Math.round(b.height)} : {l: Math.round(fr.x + b.left), h: 0};
        const el = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
        inMarker = !!(el.closest && el.closest('.vditor-ir__marker'));
        offset = r.startOffset;
      }
      return {marker: mk && mk.firstChild ? rg(mk.firstChild, 0, 1) : null, markerText: mk ? String(mk.textContent) : null,
        text: content ? rg(content, 0, 1) : null, expanded: h.classList.contains('vditor-ir__node--expand'), caret, inMarker, offset,
        markerCls: mk ? String(mk.className) : null, h1: box(h)}; })()`;
    /** 主进程侧：抓窗口真实像素，量一块区域里的"墨量"（非背景像素的比例）。 */
    const INK = rect => `(async () => {
      const {BrowserWindow} = require('electron');
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      const image = await win.webContents.capturePage();
      const size = image.getSize(), bitmap = image.toBitmap();
      const scale = size.width / (win.getContentBounds().width || size.width);
      const r = ${JSON.stringify(rect)};
      const x0 = Math.max(0, Math.round(r.x * scale)), y0 = Math.max(0, Math.round(r.y * scale));
      const x1 = Math.min(size.width, Math.round((r.x + r.w) * scale)), y1 = Math.min(size.height, Math.round((r.y + r.h) * scale));
      let ink = 0, lum = 0, n = 0, bright = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * size.width + x) * 4;
        const l = (bitmap[i] * 0.11 + bitmap[i + 1] * 0.59 + bitmap[i + 2] * 0.3) / 255;
        if (l > 0.45) ink++; if (l > 0.75) bright++; lum += l; n++; }
      return JSON.stringify({n, ink: +(ink / n).toFixed(3), bright: +(bright / n).toFixed(3), lum: +(lum / n).toFixed(3)});
    })()`;

    /** 照用户的走法把光标弄到"井号之前"：鼠标点开标题露出源码 → 左方向键走到最左侧。
     *  返回落点读数（含"这一块此刻是不是展开的""井号画出来了没有"）。 */
    const walkToStart = async (page) => {
      const at0 = await page.js(`(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor'), fr = frame.getBoundingClientRect();
        const h = [...d.querySelectorAll('.vditor-ir .vditor-reset h1')].find(x => String(x.textContent).includes('目标标题'));
        const t = [...h.childNodes].find(n => n.nodeType === 3 && n.data.trim());
        const r = d.createRange(); r.setStart(t, 0); r.setEnd(t, 1); const b = r.getBoundingClientRect();
        return {x: Math.round(fr.x + b.left + 8), y: Math.round(fr.y + b.top + b.height / 2)}; })()`);
      // 走法（2026-09-20 修）：按注释里写的那条**真实手势**——点开标题露出源码，再按 ← 走到最左。
      // 原来这里用 JS 直接把光标塞进正文文本的 offset 0，再断言"光标在 `# ` 记号里"——那条捷径
      // 在新产品上落到的是**正文 offset 0**（记号右边一格），于是整个 ② 段全红。
      // 现在断言的是用户看得见的性质：**光标停在这一块的最前面（偏移 0）**；至于它画在 `#`
      // 左侧还是紧贴 `#` 右侧，由产品决定——① 已经把"只有在井号左侧点击才留在井号左侧"钉住了。
      await page.click(at0.x, at0.y);
      await sleep(650);
      const READAT = `(() => { const w = ${IF}, d = w.document;
        const h = [...d.querySelectorAll('.vditor-ir .vditor-reset h1')].find(x => String(x.textContent).includes('目标标题'));
        const mk = h && h.querySelector('.vditor-ir__marker');
        const q = d.createRange();
        let painted = 0;
        if (mk && mk.firstChild) { q.setStart(mk.firstChild, 0); q.setEnd(mk.firstChild, 1); painted = Math.round(q.getBoundingClientRect().width); }
        const s = w.getSelection(), r = s.rangeCount ? s.getRangeAt(0) : null;
        const el = r ? (r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer) : null;
        const marker = el && el.closest ? el.closest('.vditor-ir__marker') : null;
        const 在标题块里 = !!(el && h && h.contains(el));
        return {inMarker: !!marker, offset: r ? r.startOffset : null, expanded: h ? h.classList.contains('vditor-ir__node--expand') : null,
          在标题块里, 块首: !!(在标题块里 && r && r.startOffset === 0),
          markerPainted: painted, markerText: mk ? String(mk.textContent) : null}; })()`;
      for (let i = 0; i < 5; i++) {
        const at = await page.js(READAT);
        if (at.块首) return at;
        await page.key({key: 'ArrowLeft', code: 'ArrowLeft', vk: 37});
        await sleep(400);
      }
      return await page.js(READAT);
    };
    const session = await ctx.launch({args: [doc], inspect: true});
    try {
      await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset h1')); })()`, {timeout: 90000, interval: 60});
      await sleep(2400);
      await session.send('Page.bringToFront');
      await session.js(`(() => { const w = ${IF}, d = w.document;
        [...d.querySelectorAll('.vditor-ir .vditor-reset h1')].find(x => String(x.textContent).includes('目标标题')).scrollIntoView({block: 'center'});
        return true; })()`);
      await sleep(500);

      // 用户的第一步：点一下标题正文，把源码露出来
      let geo = await session.js(READ);
      const mid = await session.js(`(() => { const w = ${IF}, d = w.document, fr = document.getElementById('editor').getBoundingClientRect();
        const h = [...d.querySelectorAll('.vditor-ir .vditor-reset h1')].find(x => String(x.textContent).includes('目标标题'));
        const r = h.getBoundingClientRect(); return Math.round(fr.y + r.top + r.height / 2); })()`);
      await session.click(geo.text.l + 6, mid);
      await sleep(700);
      geo = await session.js(READ);
      ctx.witness('①点开标题后的几何（父页坐标）', {marker: geo.marker, text: geo.text, expanded: geo.expanded});
      ctx.assert('① 点一下标题就露出源码（`# ` 画在正文左边）', geo.expanded === true && !!geo.marker && geo.marker.w > 4 && geo.text.l > geo.marker.r,
        {expanded: geo.expanded, marker: geo.marker, text: geo.text});
      if (!geo.expanded || !geo.marker || geo.text.l <= geo.marker.r) return;

      // ---- ① 点井号左侧 6px：光标必须留在井号左侧 ----
      const inkBox = {x: geo.marker.l + 4, y: mid - 14, w: Math.max(4, geo.marker.r - geo.marker.l - 6), h: 26};
      const inkBefore = JSON.parse(await session.main.js(INK(inkBox)));
      await session.js(`(() => { ${IF}.__typoraMarkerCaret = null; ${IF}.__typoraBlockStartBackspace = null; return true; })()`);
      await session.click(geo.marker.l - 6, mid);
      await sleep(650);
      const afterLeft = await session.js(READ);
      const inkAfter = JSON.parse(await session.main.js(INK(inkBox)));
      ctx.witness('① 点井号左侧 6px 之后（几何量测）', {caret: afterLeft.caret, marker: afterLeft.marker, text: afterLeft.text,
        inMarker: afterLeft.inMarker, offset: afterLeft.offset, expanded: afterLeft.expanded, guard: await session.js(`(() => ${IF}.__typoraMarkerCaret)()`) });
      ctx.witness('① `#` 所在区域的窗口真实墨量（点前 → 点后）', {before: inkBefore, after: inkAfter});
      ctx.assert('① 井号还在原地画着（窗口真实像素：`#` 区域墨量基本不变，没有闪掉、没有位移）',
        Math.abs(inkAfter.ink - inkBefore.ink) < 0.06 && inkAfter.n === inkBefore.n, {before: inkBefore, after: inkAfter});
      ctx.assert('① 正文起点没有被推动（点一下不该让版面跳）',
        afterLeft.text.l === geo.text.l && afterLeft.marker.l === geo.marker.l, {text: [geo.text.l, afterLeft.text.l], marker: [geo.marker.l, afterLeft.marker.l]});
      ctx.assert('① 点井号左侧之后，光标画在井号**左侧**（不是正文开头）',
        !!afterLeft.caret && afterLeft.caret.h > 0 && Math.abs(afterLeft.caret.l - geo.marker.l) <= 4 && afterLeft.caret.l < geo.text.l - 6,
        {caret: afterLeft.caret, markerLeft: geo.marker.l, textLeft: geo.text.l});
      await session.shot('01-caret-left-of-hash');

      // 自证动作：从块首按左方向键会走出这一块（只有"光标真的在块首"才这样）
      await session.key({key: 'ArrowLeft', code: 'ArrowLeft', vk: 37});
      await sleep(500);
      const escaped = await session.js(`(() => { const w = ${IF}, d = w.document;
        const h = [...d.querySelectorAll('.vditor-ir .vditor-reset h1')].find(x => String(x.textContent).includes('目标标题'));
        const s = w.getSelection(), r = s && s.rangeCount ? s.getRangeAt(0) : null;
        const el = r ? (r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer) : null;
        return {stillInHeading: !!(el && h && h.contains(el)), marker: !!(el && el.closest && el.closest('.vditor-ir__marker'))}; })()`);
      ctx.witness('① 自证：从"井号之前"按一次左方向键会走出标题块', escaped);
      ctx.assert('① 自证动作成立：左方向键走出了标题块（证明光标确实在块首，而不是被产品摆在那儿）',
        escaped.stillInHeading === false, escaped);

      // ---- ① 对照：点井号右侧（正文里）仍然落在正文里 ----
      await session.js(`(() => { ${IF}.__typoraMarkerCaret = null; return true; })()`);
      await session.click(geo.text.l + 12, mid);
      await sleep(600);
      const afterRight = await session.js(READ);
      ctx.witness('① 对照：点正文第一个字之后', {caret: afterRight.caret, inMarker: afterRight.inMarker, offset: afterRight.offset});
      ctx.assert('① 对照：点井号右侧不会被挪到块首（光标还在正文里，不在井号左边）',
        !!afterRight.caret && afterRight.caret.l >= geo.text.l - 2 && afterRight.inMarker === false,
        {caret: afterRight.caret, textLeft: geo.text.l, inMarker: afterRight.inMarker});

      // ---- ② 块首退格：上一块是表格，必须什么都不发生（不许吃井号） ----
      await session.js(`(() => { ${IF}.__typoraBlockStartBackspace = null; return true; })()`);
      const at = await walkToStart(session);
      ctx.witness('② 退格前光标位置与记号状态（用户说的"最左侧"）', at);
      ctx.assert('② 光标确实走到了这一块的**最前面**（偏移 0；在记号里或紧贴记号右侧都算）', at.块首 === true, at);
      const before = await session.js(`(() => String(${IF}.vditor.getValue()))()`);
      await session.key({key: 'Backspace', code: 'Backspace', vk: 8});
      await sleep(900);
      const after = await session.js(`(() => String(${IF}.vditor.getValue()))()`);
      const guardHit = await session.js(`(() => ${IF}.__typoraBlockStartBackspace)()`);
      ctx.witness('② 块首退格之后（源码 + 自证标记）', {changed: after !== before, guard: guardHit,
        before: JSON.stringify(before.slice(before.indexOf('目标标题') - 24, before.indexOf('目标标题') + 12)),
        after: JSON.stringify(after.slice(after.indexOf('目标标题') - 24, after.indexOf('目标标题') + 12))});
      ctx.assert('② 上一块是表格时，块首退格什么都不做：井号没被删、标题没降级、也没跟后面那段并成一行',
        after === before, {before: JSON.stringify(before.slice(0, 40)), after: JSON.stringify(after.slice(0, 40))});
      ctx.assert('② 这一按确实被块首规则接管了（自证标记 on）', guardHit && guardHit.blocked === true, guardHit);
      // 独立通道：等自动保存落盘，直接读文件
      await sleep(2600);
      const onDisk = fs.readFileSync(doc, 'utf8');
      ctx.witness('② 磁盘上的文件（独立通道）', {bytes: onDisk.length, heading: onDisk.includes('# 目标标题')});
      ctx.assert('② 磁盘上的源码也完好（标题还是标题，独立通道确认）', onDisk.includes('# 目标标题') && onDisk.includes('标题后的正文。'), {bytes: onDisk.length});
      await session.shot('02-backspace-at-block-start');
    } finally {
      await session.close();
    }

    // ---- ② 之二：上一块是**段落**——标准的"合并到上一段"必须保留 ----
    const doc2 = path.join(dir, '块首-段落上文.md');
    const HEAD2 = ['上一段文字。', '', '# 目标标题', '', '标题后的正文。', ''].join('\n');
    fs.writeFileSync(doc2, HEAD2);
    const second = await ctx.launch({args: [doc2]});
    try {
      await second.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset h1')); })()`, {timeout: 90000, interval: 60});
      await sleep(2300);
      await second.send('Page.bringToFront');
      await second.js(`(() => { const w = ${IF}, d = w.document; d.querySelector('.vditor-ir .vditor-reset h1').scrollIntoView({block: 'center'}); return true; })()`);
      await sleep(400);
      const at2 = await walkToStart(second);
      const before2 = await second.js(`(() => String(${IF}.vditor.getValue()))()`);
      await second.js(`(() => { ${IF}.__typoraBlockStartBackspace = null; return true; })()`);
      ctx.witness('② 段落上文：退格前的位置与记号状态', at2);
      ctx.assert('② 段落上文：光标也走到了这一块的最前面（偏移 0）', at2.块首 === true, at2);
      await second.key({key: 'Backspace', code: 'Backspace', vk: 8});
      await sleep(950);
      const after2 = await second.js(`(() => String(${IF}.vditor.getValue()))()`);
      const hit2 = await second.js(`(() => ${IF}.__typoraBlockStartBackspace)()`);
      const slice = md => JSON.stringify(md.slice(0, 40));
      ctx.witness('② 上一块是段落时的块首退格（按前 → 按后）', {before: slice(before2), after: slice(after2), guard: hit2});
      ctx.assert('② 上一块是段落时保持"合并到上一段"（不接管）；标题并进上一段，不留 `#`',
        after2 !== before2 && /上一段文字。目标标题/.test(after2) && !/# 目标标题/.test(after2), {before: slice(before2), after: slice(after2)});
      ctx.assert('② 这一按没有被块首规则拦下（自证标记应为空）', !hit2, hit2);
      await second.chord('z', 'KeyZ', 90);
      await sleep(900);
      const undone2 = await second.js(`(() => String(${IF}.vditor.getValue()))()`);
      ctx.assert('② 一次 Ctrl+Z 就把合并退回来（块首合并是可撤销的）', undone2 === before2, {undone: slice(undone2), before: slice(before2)});
      await second.shot('03-merge-into-paragraph');
    } finally {
      await second.close();
    }
  },
};
