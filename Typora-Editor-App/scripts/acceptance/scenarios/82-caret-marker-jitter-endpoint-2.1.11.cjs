/** 2.1.11 回归：用户 2026-09-14 报的四条。
 *
 *  ① 「点"数"和"。"之间，光标跑到这句话前面去了」——点完退格会**吃掉 `**` 里的星号**
 *     （`导数**。` → `导数*。`），打字/Shift+选会插出 `*X*`。查实是"按下那一刻看不见的记号
 *     接住了光标"（同一个毛病 2.1.8 就有，不是这版带出来的）。判据用**自证动作**：点完打一个
 *     字符/按一次退格，看源码里到底改了什么——不靠"光标矩形"这类间接量测（marker 的盒子
 *     位置与它实际画出来的位置不一致，量测会骗人）。
 *  ② 「向上拖拽时公式区抽搐频繁抖动，向下拉没有」——真凶是 Vditor 自己的
 *     `vditor-ir__node--expand`：拖拽中端点走进哪条公式，它就把那条公式原地换成源码，行高
 *     行宽都变，指针下的文字跟着位移，端点又落到另一条上——翻/收打转。实测向上拖时第 3、4
 *     条公式的 top 在 226↔247 反复横跳。判据：拖拽全程逐拍采四条公式的 top，**一次都不许变**。
 *  ④ 「被选中区域提示要更好；松手落点得有 caret 闪烁」——两个判据：
 *     a) 窗口真实像素：拖过之后公式盒区域的**蓝色均值**必须明显上升（不是 DOM 自报"有底纹"）；
 *     b) 松手后选区焦点端有一根可见的落点标记，位置贴住松手那一点，打字即撤。
 *  ③ 「图片选中删除后要两次 Ctrl+Z 才能拿回来」——本地反复复现不出（17 种走法都只需一次），
 *     这里把"**恰好一次**撤销就复原"钉成断言，将来谁弄成两次立刻红。
 *
 *  素材全部现场生成；不碰用户的任何文件。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '82-caret-marker-jitter-endpoint-2.1.11',
  title: '记号洞光标 / 拖拽零抖动 / 松手落点 / 图片一次撤销',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const fixtures = require('../fixtures.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '82-round');
    fs.mkdirSync(dir, {recursive: true});
    const IF = `document.getElementById('editor').contentWindow`;

    const drag = async (session, from, to, steps = 18, dwell = 55) => {
      await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: from.x, y: from.y, buttons: 0});
      await sleep(70);
      await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1});
      await sleep(80);
      for (let i = 1; i <= steps; i++) {
        await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', button: 'left', buttons: 1,
          x: Math.round(from.x + (to.x - from.x) * i / steps), y: Math.round(from.y + (to.y - from.y) * i / steps)});
        await sleep(dwell);
      }
      await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1});
      await sleep(300);
    };

    // ---------- ① 记号洞：点"数和句号之间"之后，退格/打字改的是正文还是记号 ----------
    const line = '可见**概率密度正是观测样本空间 $(\\mathbb{R}^k,\\mathcal{B})$ 上，诱导概率测度 $\\mathbb{P}_X$ 对平凡勒贝格测度 $\\mathcal{L}$ 的 Radon–Nikodym 导数**。';
    const proseFixture = path.join(dir, '报告①.md');
    fs.writeFileSync(proseFixture, ['# 概率密度', '', line, '', '末尾一段。', ''].join('\n'));
    const session = await ctx.launch({args: [proseFixture]});
    try {
      await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset p .language-math')); })()`, {timeout: 60000, interval: 50});
      await sleep(1200);
      await session.send('Page.bringToFront');

      const TEXT = `(() => { const w = ${IF}, doc = w.document;
        const p = [...doc.querySelectorAll('.vditor-ir .vditor-reset p')].find(x => x.textContent.includes('Nikodym'));
        const s = w.getSelection(), r = s && s.rangeCount ? s.getRangeAt(0) : null;
        const el = r ? (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement) : null;
        return {md: p ? p.textContent : null, caretinMarker: !!(el && el.closest && el.closest('.vditor-ir__marker')),
          caretInNode: el && el.closest && el.closest('.vditor-ir__node') ? String(el.closest('.vditor-ir__node').dataset.type || '') : ''}; })()`;
      const tail = value => String(value || '').slice(-12);
      const geo = await session.js(`(() => { const frame = document.getElementById('editor'), w = ${IF}, doc = w.document;
        const p = [...doc.querySelectorAll('.vditor-ir .vditor-reset p')].find(x => x.textContent.includes('Nikodym'));
        const fr = frame.getBoundingClientRect(), strong = p.querySelector('strong');
        let last = null; const walk = n => { for (const c of n.childNodes) { if (c.nodeType === 3 && c.data.trim()) last = c; else walk(c); } };
        walk(strong);
        const r = doc.createRange(); r.setStart(last, last.data.length - 1); r.setEnd(last, last.data.length);
        const a = r.getBoundingClientRect();
        return {x: Math.round(fr.x + a.right + 1), y: Math.round(fr.y + a.y + a.height / 2)}; })()`);

      // A1：点一下 → 退格。要删掉的正文字"数"，不是记号里的星号
      await session.click(geo.x, geo.y);
      await sleep(350);
      const afterClick = await session.js(TEXT);
      ctx.witness('① 点在"数|。"之间之后的光标落点', {tail: tail(afterClick.md), caretinMarker: afterClick.caretinMarker, nodeType: afterClick.caretInNode});
      ctx.assert('① 光标不再落进看不见的记号里（.vditor-ir__marker）', afterClick.caretinMarker === false, afterClick);
      await session.key({key: 'Backspace', code: 'Backspace', vk: 8});
      await sleep(450);
      const afterBs = await session.js(TEXT);
      ctx.witness('① 退格之后的源码尾部', tail(afterBs.md));
      ctx.assert('① 退格删掉的是正文（"数"），`**` 记号原样保留', /\*\*。$/.test(String(afterBs.md)) && /导\*\*。$/.test(String(afterBs.md)), {tail: tail(afterBs.md)});
      await session.chord('z', 'KeyZ', 90);
      await sleep(400);

      // A2：再点一次 → 打字。字符要落在正文里，不许插进 `**` 之间
      await session.click(geo.x, geo.y);
      await sleep(350);
      await session.type('X');
      await sleep(450);
      const afterType = await session.js(TEXT);
      ctx.witness('① 打字之后的源码尾部', tail(afterType.md));
      // 落点可能落在"数"的左边或右边（都在最后两个字之间，鼠标在字符边缘时两种都合理）：
      // 关键是**字符进了正文、`**` 记号完好**（记号被破坏时会出现 `*X*` 这种斜体记号）。
      ctx.assert('① 打进去的字符落在正文里、没有插坏记号（不许出现 `*X*`）',
        /导.{0,2}\*\*。$/.test(String(afterType.md)) && !/\*X\*/.test(String(afterType.md)), {tail: tail(afterType.md)});
      await session.chord('z', 'KeyZ', 90);
      await sleep(400);
      ctx.assert('① 撤销之后回到原样', /导数\*\*。$/.test(String((await session.js(TEXT)).md)), {tail: tail((await session.js(TEXT)).md)});
    } finally {
      await session.close();
    }

    // ---------- ② / ④ 拖拽零抖动 + 公式上的底纹 + 松手落点 ----------
    const mathFixture = path.join(dir, '报告②.md');
    fs.writeFileSync(mathFixture, ['# 公式段落', '',
      '> 原命题：$\\forall x P(x)$', '> 逆命题：$\\exists x Q(x)$', '> 否命题：$\\forall x \\neg P(x)$', '> 原命题的否定: $\\exists x \\neg P(x)$', '',
      '普通段落。', ''].join('\n'));
    const second = await ctx.launch({args: [mathFixture], inspect: true});
    try {
      await second.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelectorAll('.vditor-ir .language-math').length >= 4); })()`, {timeout: 60000, interval: 50});
      await sleep(1400);
      await second.send('Page.bringToFront');
      const geo = await second.js(`(() => { const frame = document.getElementById('editor'), w = ${IF}, doc = w.document;
        const fr = frame.getBoundingClientRect();
        const maths = [...doc.querySelectorAll('.vditor-ir .language-math')];
        const first = maths[0].getBoundingClientRect(), last = maths[maths.length - 1].getBoundingClientRect();
        const bq = doc.querySelector('.vditor-ir blockquote').getBoundingClientRect();
        const line = maths[1].getBoundingClientRect();
        return {start: {x: Math.round(fr.x + last.right + 3), y: Math.round(fr.y + last.top + last.height / 2)},
          end: {x: Math.round(fr.x + bq.left + 4), y: Math.round(fr.y + first.top + first.height / 2)},
          math2: {x: Math.round(fr.x + line.left), y: Math.round(fr.y + line.top - 2), w: Math.round(line.width), h: Math.round(line.height + 4)},
          paraLeft: Math.round(Math.max(0, fr.x + bq.left - 4))}; })()`);
      ctx.witness('② 拖拽起讫点与公式盒', geo);

      // 逐拍采四条公式的 top：拖拽全程一次都不许变
      await second.js(`(() => { const w = ${IF}, doc = w.document;
        w.__tops = []; w.__ptr = [];
        const maths = [...doc.querySelectorAll('.vditor-ir .language-math')];
        const root = doc.querySelector('.vditor-ir') || doc.body;
        w.__t = setInterval(() => { w.__tops.push(maths.filter(m => m.isConnected).map(m => Math.round(m.getBoundingClientRect().top)).join('|'));
          w.__ptr.push(doc.querySelectorAll('.typora-ir-pointer').length); }, 40);
        w.__obs = new MutationObserver(() => {}); return true; })()`);

      // 像素证人：主进程抓窗口真实像素，按区域算蓝色均值（拖前 / 拖后各一次）
      const REGION = rect => `(async () => {
        const {BrowserWindow} = require('electron');
        const win = BrowserWindow.getAllWindows()[0];
        const image = await win.webContents.capturePage();
        const size = image.getSize(), bitmap = image.toBitmap();
        const scale = size.width / (win.getContentBounds().width || size.width);
        const r = ${JSON.stringify(rect)};
        const x0 = Math.max(0, Math.round(r.x * scale)), y0 = Math.max(0, Math.round(r.y * scale));
        const x1 = Math.min(size.width, Math.round((r.x + r.w) * scale)), y1 = Math.min(size.height, Math.round((r.y + r.h) * scale));
        let br = 0, bg = 0, bb = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * size.width + x) * 4;
          bb += bitmap[i]; bg += bitmap[i + 1]; br += bitmap[i + 2]; n++; }
        return JSON.stringify({n, r: +(br / n).toFixed(1), g: +(bg / n).toFixed(1), b: +(bb / n).toFixed(1)});
      })()`;
      const before0 = JSON.parse(await second.main.js(REGION(geo.math2)));

      // 合成鼠标拖拽在这套基座上偶尔不被当成"拖拽中"（窗口被判隐藏/掉帧时），
      // 这时选区是塌的、像素也没变——那是**基座**没把动作送进去，不是产品的问题。
      // 所以先自证"这次拖拽真的起了选区"：起不来就重来（最多 3 次），
      // 3 次都起不来就照实判失败（产品真选不中的话仍然红）。
      let before = before0, after = before0, samples = null, picked = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        await second.js(`(() => { const w = ${IF}; w.getSelection().removeAllRanges(); return true; })()`);
        await sleep(250);
        await second.js(`(() => { const w = ${IF}, doc = w.document;
          w.__tops = []; w.__ptr = [];
          clearInterval(w.__t);
          const maths = [...doc.querySelectorAll('.vditor-ir .language-math')];
          w.__t = setInterval(() => { w.__tops.push(maths.filter(m => m.isConnected).map(m => Math.round(m.getBoundingClientRect().top)).join('|'));
            w.__ptr.push(doc.querySelectorAll('.typora-ir-pointer').length); }, 40);
          return true; })()`);
        const mark = JSON.parse(await second.main.js(REGION(geo.math2)));
        await drag(second, geo.start, geo.end, 18, 55);
        const seen = await second.js(`(() => { const w = ${IF}, s = w.getSelection(); const r = s && s.rangeCount ? s.getRangeAt(0) : null;
          return {collapsed: r ? r.collapsed : null, len: r ? r.toString().length : 0}; })()`);
        const taken = await second.js(`(() => { const w = ${IF}; clearInterval(w.__t); return {tops: w.__tops, ptr: w.__ptr}; })()`);
        ctx.log(`第 ${attempt} 次拖拽：collapsed=${seen.collapsed} 选区长度=${seen.len}`);
        if (seen.collapsed) continue;          // 基座没送进去，重来
        before = mark;
        after = JSON.parse(await second.main.js(REGION(geo.math2)));
        samples = taken;
        picked = seen;
        break;
      }
      ctx.witness('② 拖拽后的选区（自证这一步真的起了选区）', picked || {collapsed: true, len: 0});
      ctx.assert('② 真实鼠标拖拽做出了非塌选区（重试 3 次仍起不来即判失败）',
        !!picked && !picked.collapsed && picked.len > 10, picked || {collapsed: true});
      if (!picked || picked.collapsed) return;

      const seq = samples.tops;
      let changes = 0;
      for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) changes++;
      ctx.witness('② 拖拽全程四条公式的 top 采样', {samples: seq.length, uniq: [...new Set(seq)].length, first: seq[0], last: seq[seq.length - 1]});
      ctx.assert('② 向上拖拽全程公式盒子一次都没位移（用户报的"抽搐抖动"）', changes === 0 && seq.length > 8, {changes, samples: seq.length, series: seq.slice(0, 6)});
      ctx.assert('② 按下期间挂上 .typora-ir-pointer（冻结展开），松手后摘掉',
        samples.ptr.some(v => v > 0) && samples.ptr[samples.ptr.length - 1] === 0, {ptr: samples.ptr.slice(0, 4).concat(samples.ptr.slice(-3))});
      ctx.witness('④ 窗口真实像素：第二条公式区域的平均色（拖前 → 拖后）', {before, after});
      ctx.assert('④ 拖过的公式在**真实像素**上被蓝色底纹盖住（蓝通道显著抬升且以蓝为主）',
        after.b - before.b > 20 && after.b > after.r + 10, {before, after});

      const endpoint = await second.js(`(() => { const w = ${IF}, doc = w.document;
        const mark = doc.querySelector('.typora-selection-endpoint');
        // 松手那一点在**父页坐标**里，换算成编辑器 iframe 自己的视口坐标再解析光标
        const fe = w.frameElement.getBoundingClientRect();
        const at = doc.caretRangeFromPoint(${geo.end.x} - fe.left, ${geo.end.y} - fe.top) || null;
        const box = at ? at.getBoundingClientRect() : null;
        return {present: !!mark, hidden: mark ? mark.hidden : null, left: mark ? parseFloat(mark.style.left) : null,
          height: mark ? parseFloat(mark.style.height) : null, caretX: box ? Math.round(box.left) : null,
          collapsed: (w.getSelection() || {}).isCollapsed}; })()`);
      ctx.witness('④ 松手之后的落点标记', endpoint);
      ctx.assert('④ 松手落点有可见标记，且贴住松手那一点（±6px）',
        endpoint.present && endpoint.hidden === false && endpoint.height > 4 && endpoint.caretX !== null && Math.abs(endpoint.left - endpoint.caretX) <= 6, endpoint);
      await second.type('Z');
      await sleep(500);
      const gone = await second.js(`(() => { const w = ${IF}, mark = w.document.querySelector('.typora-selection-endpoint'); return mark ? mark.hidden : null; })()`);
      ctx.assert('④ 键盘一介入落点标记就撤掉（不留残影）', gone === true, {hidden: gone});
    } finally {
      await second.close();
    }

    // ---------- ③ 图片：选中删除后**恰好一次** Ctrl+Z 就要复原 ----------
    const scene = fixtures.images();
    const third = await ctx.launch({args: [scene.markdown]});
    try {
      await third.until(`(() => { const w = ${IF}; return !!(w && [...w.document.querySelectorAll('.vditor-ir img')].filter(i => i.complete && i.naturalWidth > 0).length >= 3); })()`, {timeout: 60000, interval: 50});
      await sleep(1400);
      await third.send('Page.bringToFront');
      const COUNT = `(() => { const w = ${IF}, doc = w.document;
        const imgs = [...doc.querySelectorAll('.vditor-ir img')].filter(i => !i.closest('.katex'));
        return {imgs: imgs.length, loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
          srcs: imgs.map(i => String(i.getAttribute('src')).split('/').pop())}; })()`;
      const at = await third.js(`(() => { const frame = document.getElementById('editor'), w = ${IF}, doc = w.document;
        const img = [...doc.querySelectorAll('.vditor-ir img')].filter(i => !i.closest('.katex'))[1];
        const r = img.getBoundingClientRect(), fr = frame.getBoundingClientRect();
        return {x: Math.round(fr.x + r.x + r.width / 2), y: Math.round(fr.y + r.y + r.height / 2)}; })()`);
      const before = await third.js(COUNT);
      await third.click(at.x, at.y);
      await sleep(400);
      await third.key({key: 'Delete', code: 'Delete', vk: 46});
      await sleep(700);
      const deleted = await third.js(COUNT);
      ctx.witness('③ 删除选中的图片之后', deleted);
      ctx.assert('③ Delete 确实把那一张删掉了', deleted.imgs === before.imgs - 1, {before: before.imgs, after: deleted.imgs});
      await third.chord('z', 'KeyZ', 90);
      await sleep(800);
      const undone = await third.js(COUNT);
      ctx.witness('③ 一次 Ctrl+Z 之后', undone);
      ctx.assert('③ **恰好一次** Ctrl+Z 就把图片拿回来（用户报的"要两次"）',
        undone.imgs === before.imgs && undone.loaded === before.imgs, {before: before.imgs, afterUndo: undone.imgs, loaded: undone.loaded});
      // 独立证人：等自动保存落盘，直接读磁盘上的文件
      await sleep(2600);
      const onDisk = fs.readFileSync(scene.markdown, 'utf8');
      const diskImages = (onDisk.match(/!\[[^\]]*\]\(/g) || []).length;
      ctx.witness('③ 磁盘上的文件（独立通道）', {images: diskImages, bytes: onDisk.length});
      ctx.assert('③ 磁盘上的源码也回来了（不是只在 DOM 里）', diskImages === before.imgs, {diskImages, expected: before.imgs});
      await third.shot('image-undo');
    } finally {
      await third.close();
    }

    // ---------- ③ 之二：**HTML 图片**（正文里直接写 `<img>`，用户的文档就是这种） ----------
    //  用户报告（2026-09-14 补充）：「这张图片删除之后，整个光标焦点偏移不知道跑哪里去了」。
    //  实测（在用户的真实文档上）：这种图片点选后 Vditor 会把 DOM 选区收掉（collapsed），
    //  旧守卫据此判定"不算选中"→ 放弃删除并把按键让给浏览器 → 浏览器按"删光标左边那个字"
    //  处理：图片还在，**标题里的一个字被吃掉**，光标停在标题上。这一组钉住：
    //  点选 → Delete → 图片的 `<img …>` 真的从源码里消失、别处一个字都没动、光标落在删除点、
    //  一次 Ctrl+Z 复原。
    const htmlRoom = path.join(dir, 'html-image');
    fs.mkdirSync(htmlRoom, {recursive: true});
    const htmlImage = path.join(htmlRoom, 'shot-red.png');
    fs.writeFileSync(htmlImage, fs.readFileSync(fixtures.images().images[0]));
    const htmlDoc = path.join(htmlRoom, 'HTML图片.md');
    const head = '# 标题不能被动到\n\n第一段正文，一个字都不该少。\n\n';
    const tag = `<img src="shot-red.png" alt="红块" width="120" />`;
    const foot = '\n\n图片后面的正文。\n';
    fs.writeFileSync(htmlDoc, head + tag + foot);
    const fourth = await ctx.launch({args: [htmlDoc]});
    try {
      await fourth.until(`(() => { const w = ${IF}; const i = w && w.document.querySelector('.vditor-ir .vditor-reset img');
        return !!(i && i.getBoundingClientRect().width > 20); })()`, {timeout: 60000, interval: 50});
      await sleep(1200);
      await fourth.send('Page.bringToFront');
      const READ = `(() => { const w = ${IF}, doc = w.document;
        let md = ''; try { md = String(w.vditor.getValue()); } catch (e) { md = 'ERR'; }
        const imgs = [...doc.querySelectorAll('.vditor-ir .vditor-reset img')];
        const s = w.getSelection(), r = s && s.rangeCount ? s.getRangeAt(0) : null;
        const el = r ? (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement) : null;
        return {md, bytes: md.length, htmlImgs: (md.match(/<img/gi) || []).length, domImgs: imgs.length,
          selected: imgs.filter(i => i.classList.contains('typora-img-selected')).length,
          head: md.slice(0, 24), caretAround: r && r.startContainer.nodeType === 3
            ? r.startContainer.data.slice(Math.max(0, r.startOffset - 10), r.startOffset + 10) : null}; })()`;
      const at = await fourth.js(`(() => { const frame = document.getElementById('editor'), w = ${IF}, doc = w.document;
        const i = doc.querySelector('.vditor-ir .vditor-reset img');
        const r = i.getBoundingClientRect(), fr = frame.getBoundingClientRect();
        return {x: Math.round(fr.x + r.left + r.width / 2), y: Math.round(fr.y + r.top + r.height / 2)}; })()`);
      const original = await fourth.js(READ);
      await fourth.move(at.x, at.y);
      await sleep(80);
      await fourth.click(at.x, at.y);
      await sleep(500);
      const picked = await fourth.js(READ);
      ctx.witness('③b HTML 图片点选之后', {selected: picked.selected, htmlImgs: picked.htmlImgs, bytes: picked.bytes});
      ctx.assert('③b 点选 HTML 图片能选中（产品自己的选中态）', picked.selected === 1, picked);
      await fourth.key({key: 'Delete', code: 'Delete', vk: 46});
      await sleep(900);
      const afterDel = await fourth.js(READ);
      ctx.witness('③b Delete 之后', {htmlImgs: afterDel.htmlImgs, domImgs: afterDel.domImgs, bytes: afterDel.bytes, head: afterDel.head, caretAround: afterDel.caretAround});
      ctx.assert('③b Delete 真的把这段 `<img …>` 从源码里删掉了（不是只改了一个字）',
        afterDel.htmlImgs === original.htmlImgs - 1 && afterDel.domImgs === original.domImgs - 1, 
        {before: original.htmlImgs, after: afterDel.htmlImgs});
      ctx.assert('③b 文档别处的字一个都没动（标题与上一段原样）', afterDel.head === original.head, {before: original.head, after: afterDel.head});
      ctx.assert('③b 光标落在图片原来的位置（删除点的正文里，不再跑到标题上）',
        !!afterDel.caretAround && /图片后面的正文|图片后/.test(String(afterDel.caretAround)), {caretAround: afterDel.caretAround});
      await fourth.chord('z', 'KeyZ', 90);
      await sleep(900);
      const back = await fourth.js(READ);
      ctx.assert('③b 一次 Ctrl+Z 就把 HTML 图片拿回来（源码逐字节复原）',
        back.md === original.md, {bytes: back.bytes, before: original.bytes, htmlImgs: back.htmlImgs});
      await fourth.shot('html-image-undo');
    } finally {
      await fourth.close();
    }
  },
};
