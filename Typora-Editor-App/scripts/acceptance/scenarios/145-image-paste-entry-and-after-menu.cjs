/** 145 · 图片出源码的**用户真入口**：截图 → Ctrl+V 粘贴 → 立刻慢点两下必出源码
 *
 *  对应台账：U-070 / U-071 / U-077（F08 图片族）、A-010 / A-013；覆盖率缺口清单 §3.1 Z7
 *  「Ctrl+V 粘贴图后连点」那一行。138/140/144 用的都是**夹具里已有的图**，本条补的是
 *  用户真实入口：Windows 截图放进系统剪贴板 → 在文档里真按 Ctrl+V → 在**粘贴出来的这张图**上
 *  立刻慢点两下（700ms、clickCount 恒 1，CDP 不会自己推断双击）。
 *
 *  剪贴板通道（如实记账，别把它当成 `writeClipboard`）：
 *    · `harness.writeClipboard` 只写**文本**（clipboard.ps1 的 write 分支只有 SetText），放不了图；
 *    · 本场景走 `harness.restoreClipboard(dir, state.json)`——clipboard.ps1 的 restore 动作把
 *      `imagePath` 指向的 PNG 读成 System.Drawing.Image 放进 `DataFormats.Bitmap`，**独立
 *      PowerShell 进程写入，不经产品**；
 *    · 放完立刻用 `harness.readClipboard`（另一个独立进程）读回 `hasImage` 与像素尺寸自证；
 *    · 场景结束把用户原来的剪贴板还原（剪贴板是全系统独占资源）。
 *
 *  覆盖的手势（五通道）：组合键（真 Ctrl+V）、鼠标（粘贴后立刻慢点两下 / 点缩放角标 / 右键开合菜单）、
 *  键鼠配合（点图片右侧空白 → Enter → 打字造新行）、键盘（Esc 收起 / End 定位）、拖拽（图上起手拖出去）。
 *
 *  真实口径登记（提案里"拖动挪位"那条的落地形式）：
 *    产品的图片 mousedown 是 preventDefault + 自造选区（media-tools.js L1837–1853「图上起手的拖选」），
 *    所以图上的拖拽**不会**触发 HTML5 drag-and-drop、也不会挪位——它是"拖选"通道。本条的拖拽腿因此
 *    登记为：拖拽全程**不挪位、零改动、引用恰好一次**，拖完回来点两下仍必出源码（方向不变）。
 *
 *  突变点（把修复注掉必须变红）：
 *    · `app/renderer/js/media-tools.js` 里问题2 的第二下判据（提案记作 L1772–1776「mousedown 记
 *      这一下之前这张图是否已带可见选中框」的快照 + L2011–2020「带蓝框的这一击确定性展开」的
 *      分支；本轮在途改动后行号已漂移，认**语义**不认行号）注掉 → ①②③④ 全红（粘贴出来的这张图
 *      会退回"只有系统双击才出、点慢了永远只选中"）。
 *
 *  证人：clipboard（独立进程写/读回粘贴载荷）+ disk（粘贴出来的图片字节真的落盘、引用恰好一次）
 *        + geometry（展开态 / 选中态 / 光标层 / 图盒没被拖动挪走）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('../harness.cjs');
const hi = require('../../human-input/hi.cjs');

const PNG宽 = 240, PNG高 = 150;
const 正文 = ['# 图粘贴', '', '粘贴前正文。', ''].join('\n');

/** 一条读数：图数 / 图（展开·选中·多选·类型·中心·盒·在源码）/ 光标层 / 结构 / 正文。 */
const 读 = `(() => { const w = ${hi.IF}; const d = w && w.document; if (!d) return { ok: false };
  const s = d.querySelector('${hi.SURFACE}'); if (!s) return { ok: false };
  const frame = document.getElementById('editor').getBoundingClientRect();
  const sel = w.getSelection(); const rr = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const at = rr ? (rr.startContainer.nodeType === 3 ? rr.startContainer.parentElement : rr.startContainer) : null;
  const 图 = [...d.querySelectorAll('${hi.SURFACE} img')].map(img => {
    const owner = img.closest('.vditor-ir__node[data-type]');
    const r = img.getBoundingClientRect();
    return { 类型: owner ? owner.getAttribute('data-type') : null,
      展开: !!owner && owner.classList.contains('vditor-ir__node--expand'),
      选中: img.classList.contains('typora-img-selected'),
      多选: img.classList.contains('typora-img-multi-selected'),
      自然: img.naturalWidth + 'x' + img.naturalHeight,
      中心: { x: Math.round(frame.x + r.left + r.width / 2), y: Math.round(frame.y + r.top + r.height / 2) },
      盒: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      源码文本: (() => { const src = owner && (owner.querySelector('code[data-type]') || owner);
        const t = src ? String(src.textContent).replace(/\\s+/g, ' ').trim() : ''; return t ? t.slice(0, 400) : null; })(),
      在源码: !!(rr && at && owner && owner.contains(at) && at.closest && at.closest('code[data-type],.vditor-ir__marker')) };
  });
  let 层 = '外', 块 = -1;
  if (at && s.contains(at)) {
    层 = at.closest('code[data-type],.vditor-ir__marker') ? '源码' : (at.closest('.vditor-ir__preview') ? '岛' : '正文');
    let top = at; while (top && top.parentElement && top.parentElement !== s) top = top.parentElement;
    块 = [...s.children].indexOf(top);
  }
  return { ok: true, 图数: 图.length, 图, 层, 块, 折叠: rr ? rr.collapsed : null,
    选区: sel ? String(sel).slice(0, 60) : '',
    选区盒: rr ? (() => { const b = rr.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })() : null,
    结构: { p: s.querySelectorAll('p').length, li: s.querySelectorAll('li').length, 引用: s.querySelectorAll('blockquote').length },
    正文: String(s.textContent).replace(/\\s+/g, ' ').trim() }; })()`;

const 取点 = i => `(() => { const w = ${hi.IF}, d = w.document; const imgs = [...d.querySelectorAll('${hi.SURFACE} img')];
  const img = imgs[${i}]; if (!img) return { ok: false, 图数: imgs.length };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const frame = document.getElementById('editor').getBoundingClientRect(); const r = img.getBoundingClientRect();
  return { ok: true, x: Math.round(frame.x + r.left + r.width / 2), y: Math.round(frame.y + r.top + r.height / 2),
    右外30: { x: Math.round(frame.x + r.right + 30), y: Math.round(frame.y + r.top + r.height / 2) },
    盒: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }; })()`;

const 文本点 = 词 => `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('${词}'));
  if (!t) return { ok: false };
  const r = t.getBoundingClientRect(); return { ok: true, x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;

/** 右键菜单与缩放角标都住在**编辑器 iframe** 的文档里（media-tools.js / zoom.js 都在 iframe 侧
 *  运行，实测：外壳顶层页里查这两个选择器恒为空）——读数必须经 hi.IF 进 iframe，
 *  坐标再加 iframe 的偏移换算成顶层页坐标（CDP 派发用的是顶层坐标）。 */
const 菜单 = `(() => { const w = ${hi.IF}; const d = w && w.document; if (!d) return { 有: false, 可见: false, 项数: 0 };
  const m = d.getElementById('typora-editor-context-menu');
  // 菜单是 position:fixed 的，offsetParent 恒为 null——可见性要用 getClientRects() 判。
  return { 有: !!m, 可见: !!m && m.getClientRects().length > 0, 项数: m ? m.querySelectorAll('button').length : 0 }; })()`;
const 角标 = `(() => { const w = ${hi.IF}; const d = w && w.document; if (!d) return { ok: false };
  const frame = document.getElementById('editor').getBoundingClientRect();
  const b = d.querySelector('.typora-zoom-badge'); const p = d.querySelector('.typora-zoom-pop');
  if (!b) return { ok: false };
  const r = b.getBoundingClientRect();
  return { ok: true, x: Math.round(frame.x + r.left + r.width / 2), y: Math.round(frame.y + r.top + r.height / 2),
    文本: b.textContent, 浮层: !!p && !p.hidden, 浮层文本: p ? String(p.textContent).replace(/\\s+/g, ' ').slice(0, 30) : null }; })()`;

/** paste 事件观察器（只记录，不改产品行为）：用来把"按键有没有真的变成一次粘贴"分开记账。 */
const 装粘贴观察 = `(() => { const w = ${hi.IF}; if (!w || !w.document) return false;
  w.__accPaste = [];
  w.document.addEventListener('paste', event => { try { const d = event.clipboardData;
    w.__accPaste.push({ trusted: event.isTrusted, types: d ? [...d.types].slice(0, 6) : null,
      files: d ? d.files.length : -1, items: d ? [...d.items].map(item => item.kind + ':' + item.type).slice(0, 6) : null });
  } catch (error) { w.__accPaste.push({ err: String(error && error.message) }); } }, true);
  return true; })()`;
const 读粘贴 = `(() => { const w = ${hi.IF}; return (w && w.__accPaste) || []; })()`;

/** 拟真连点：clickCount 按 OS 双击规则给（相邻两次 ≤480ms 且位移 ≤4px 才递增，否则归 1）。 */
async function 拟真连点(session, 点, 次数, 间隔) {
  const 计数 = [];
  let count = 0, last = -1e9, lx = 0, ly = 0;
  for (let i = 0; i < 次数; i++) {
    if (i) await hi.sleep(间隔);
    const now = Date.now();
    count = (now - last <= 480 && Math.abs(点.x - lx) <= 4 && Math.abs(点.y - ly) <= 4) ? count + 1 : 1;
    last = now; lx = 点.x; ly = 点.y;
    计数.push(count);
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 点.x, y: 点.y, button: 'left', buttons: 1, clickCount: count });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 点.x, y: 点.y, button: 'left', buttons: 0, clickCount: count });
    await hi.sleep(120);
  }
  await hi.sleep(420);
  return 计数;
}

/** 磁盘上这条图片引用是不是一张真的、尺寸对得上的 PNG（data: URI 与相对路径两种形态都认）。 */
function 图片字节判定(引用, 文档) {
  const 摘要 = { 引用: String(引用).slice(0, 100), 形态: null, 字节: 0, 签名: false, 宽: 0, 高: 0, 路径: null };
  try {
    let 字节;
    if (/^data:image\/png;base64,/.test(引用)) {
      摘要.形态 = 'data-uri';
      字节 = Buffer.from(引用.replace(/^data:image\/png;base64,/, ''), 'base64');
    } else {
      if (/^https?:/i.test(引用) || /^file:/i.test(引用)) { 摘要.形态 = '外部/临时引用'; 摘要.路径 = 引用; return { ...摘要, ok: false, 原因: '存盘里落的是外部/临时引用（搬家即断链）' }; }
      摘要.形态 = '相对路径';
      摘要.路径 = path.resolve(path.dirname(文档), decodeURIComponent(引用.split('?')[0].split('#')[0]));
      if (!fs.existsSync(摘要.路径)) return { ...摘要, ok: false, 原因: '引用指向的文件不在磁盘上' };
      字节 = fs.readFileSync(摘要.路径);
    }
    摘要.字节 = 字节.length;
    摘要.签名 = 字节.length > 24 && 字节.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    摘要.宽 = 摘要.签名 ? 字节.readUInt32BE(16) : 0;
    摘要.高 = 摘要.签名 ? 字节.readUInt32BE(20) : 0;
    return { ...摘要, ok: 摘要.签名 && 摘要.宽 === PNG宽 && 摘要.高 === PNG高 };
  } catch (error) {
    return { ...摘要, ok: false, 原因: String(error.message) };
  }
}
/** 文档里的图片引用（`![alt](url)`）——"引用恰好一次"就是数它。 */
function 图片引用(text) {
  const 命中 = [];
  const 正则 = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  let m;
  while ((m = 正则.exec(String(text)))) 命中.push(m[1]);
  return 命中;
}

module.exports = {
  id: '145-image-paste-entry-and-after-menu',
  title: '图片真入口：Ctrl+V 粘贴截图后立刻慢点两下必出源码（含右键菜单开合、缩放角标、拖拽、Enter 新行之后）',
  run: async ctx => {
    fs.mkdirSync(hi.ROOM, { recursive: true });
    const 源图 = path.join(hi.ROOM, 'paste-145.png');
    fs.writeFileSync(源图, hi.fixtures.png(PNG宽, PNG高, [70, 110, 230]));

    // ── 剪贴板：先存档用户原来的内容，再把 PNG 放进系统剪贴板（独立进程，不经产品）────────
    const 剪贴板房 = path.join(ctx.outDir, 'clip-145');
    fs.mkdirSync(剪贴板房, { recursive: true });
    let 用户剪贴板 = null;
    try { 用户剪贴板 = harness.saveClipboard(剪贴板房); ctx.log('已存档用户剪贴板：' + JSON.stringify({ 文: 用户剪贴板.hasText, 图: 用户剪贴板.hasImage, 文件: 用户剪贴板.hasFiles })); }
    catch (error) { ctx.log('用户剪贴板存档失败（继续）：' + String(error.message).slice(0, 120)); }
    const 注入 = path.join(剪贴板房, 'inject-image.json');
    fs.writeFileSync(注入, JSON.stringify({ ok: true, hasText: false, text: null, hasImage: true, imagePath: 源图, hasFiles: false, files: [] }), 'utf8');
    let 读回 = null, 读回错 = null;
    try {
      harness.restoreClipboard(剪贴板房, 注入);
      读回 = harness.readClipboard(剪贴板房);
    } catch (error) { 读回错 = String(error.message).slice(0, 200); }
    ctx.assert(`① 剪贴板前置：独立进程把 ${PNG宽}×${PNG高} 的 PNG 放进系统剪贴板并读回`,
      !!读回 && 读回.hasImage === true && 读回.imageWidth === PNG宽 && 读回.imageHeight === PNG高,
      JSON.stringify({ 错: 读回错, 图: 读回 && { hasImage: 读回.hasImage, 宽: 读回.imageWidth, 高: 读回.imageHeight }, 格式: 读回 && 读回.formats }));
    ctx.witness('剪贴板：独立进程写入并读回的粘贴载荷',
      { hasImage: 读回 && 读回.hasImage, 宽: 读回 && 读回.imageWidth, 高: 读回 && 读回.imageHeight, 源图字节: fs.statSync(源图).size }, 'clipboard');

    const file = hi.writeDoc('paste-entry-145.md', 正文);
    const s = await hi.openDoc(ctx, file, { minBlocks: 2 });
    let 出源码命中 = 0;
    try {
      ctx.assert('① 会话焦点在编辑器（真实按键/粘贴前置）', (await hi.ensureFocus(s)).ok, '');
      const 文点 = await s.js(文本点('粘贴前正文'));
      ctx.assert('① 前置：文档里 0 张图（粘贴还没有发生）', 文点.ok && (await s.js(读)).图数 === 0, JSON.stringify(文点));

      // ── ② 真 Ctrl+V：图片上屏 → 立刻慢点两下必出源码 ─────────────────────────────
      await s.click(文点.x, 文点.y); await hi.sleep(260);
      await s.key({ key: 'End', code: 'End', vk: 35 }); await hi.sleep(200);   // 光标放到行尾，粘贴落在段尾
      await s.js(装粘贴观察);                       // 只记录 paste 事件载荷，不改产品行为
      // 组合键必须写**大写**主键 `Ctrl+V`：hi.combo 的 codeOf/vkOf 只认 A–Z，小写 'v' 会发出
      // windowsVirtualKeyCode=0、code='v'（Chromium 打 "unrecognized code string 'v'"），而
      // 「粘贴」是**浏览器侧**快捷键（按原生键码匹配），不是 Blink 编辑命令——vk=0 时那条通路
      // 根本不触发，页面里连一次 paste 事件都不会有（本轮实测：图数 0、page 侧零事件）。
      // `Ctrl+z`/`Ctrl+f` 那类能过，是因为它们由 Blink 编辑命令 / 产品自己的 keydown 处理。
      await hi.combo(s, 'Ctrl+V');
      let 粘 = null;
      for (let i = 0; i < 40; i++) {                 // 粘贴要经归档管线，等图元素真的出现
        await hi.sleep(300);
        粘 = await s.js(读);
        if (粘 && 粘.图数 >= 1) break;
      }
      const 粘贴事件 = await s.js(读粘贴);
      ctx.witness('剪贴板：页面收到的 paste 事件载荷（真实通道自证）', { 事件: 粘贴事件 }, 'clipboard');
      ctx.assert('② 真 Ctrl+V：粘贴的图片上屏（img 0 → 1），owner 是 img 节点、像素与剪贴板一致',
        粘 && 粘.图数 === 1 && 粘.图[0].类型 === 'img' && 粘.图[0].自然 === PNG宽 + 'x' + PNG高,
        JSON.stringify({ 图数: 粘 && 粘.图数, 图: 粘 && 粘.图[0], 粘贴事件 }));
      await s.shot('145-②粘贴完成');

      const 点 = await s.js(取点(0));
      const 两下 = await 拟真连点(s, 点, 2, 700);      // 粘贴后**立刻**慢点两下
      const 展 = await s.js(读);
      ctx.assert('② 粘贴后立刻慢点两下（700ms、clickCount 恒 1）：源码必须出来',
        展.图[0].展开 === true, JSON.stringify({ clickCount: 两下, 图: 展.图[0] }));
      ctx.assert('② 展开后光标在图片源码里（用户能直接改路径/宽度：源码是一条完整的 md 图引用）',
        展.图[0].在源码 === true && /!\[[^\]]*\]\([^)]*\)/.test(String(展.图[0].源码文本)),
        JSON.stringify({ 层: 展.层, 源码文本: 展.图[0].源码文本 }));
      if (展.图[0].展开 === true) 出源码命中 += 1;
      await s.shot('145-②慢点两下-出源码');
      ctx.witness('几何：粘贴出来的图片两下之后的展开态与光标层',
        { clickCount: 两下, 展开: 展.图[0].展开, 在源码: 展.图[0].在源码, 层: 展.层, 源码文本: 展.图[0].源码文本 }, 'geometry');

      await s.key({ key: 'Escape', code: 'Escape', vk: 27 }); await hi.sleep(420);
      ctx.assert('② 护栏：Esc 收起粘贴图的源码', (await s.js(读)).图[0].展开 === false, '');

      // ── ③ 落盘：引用恰好一条，且引用指向的字节真是那张 240×150 PNG ────────────────
      const 存1 = await hi.edge.saveAndWait(s, file, { timeout: 9000 });
      const 盘1 = String(存1.after).replace(/\r/g, '');
      const 引用1 = 图片引用(盘1);
      const 判1 = 引用1.length ? 图片字节判定(引用1[0], file) : { ok: false, 原因: '磁盘上没有图片引用' };
      ctx.assert('③ 存盘：磁盘上图片引用恰好一条（粘贴只插入一次、没有重复引用）',
        引用1.length === 1, JSON.stringify({ 条数: 引用1.length, 盘: 盘1.slice(0, 160) }));
      ctx.assert(`③ 存盘：引用指向的字节是一张 ${PNG宽}×${PNG高} 的真 PNG（图片没丢、没变成坏引用）`,
        判1.ok === true, JSON.stringify(判1));
      ctx.witness('磁盘：Ctrl+V 之后落盘的图片引用与字节', { 引用: 引用1, 判定: 判1, 盘首: 盘1.slice(0, 120) }, 'disk');

      // ── ④ 右键菜单开→关之后，慢点两下仍必出 ──────────────────────────────────────
      const 点2 = await s.js(取点(0));
      await s.click(点2.x, 点2.y, { button: 'right' }); await hi.sleep(600);
      const 开 = await s.js(菜单);
      ctx.assert('④ 右键图片：产品自己的右键菜单弹出来了（用户看得见）', 开.有 === true && 开.可见 === true && 开.项数 > 0, JSON.stringify(开));
      const 开时 = await s.js(读);
      ctx.assert('④ 右键只开菜单：图片没有被选中、也没有被展开',
        开时.图[0].选中 === false && 开时.图[0].展开 === false, JSON.stringify(开时.图[0]));
      await s.key({ key: 'Escape', code: 'Escape', vk: 27 }); await hi.sleep(500);
      const 关 = await s.js(菜单);
      ctx.assert('④ Esc 关掉右键菜单（菜单真的从页面上消失）', 关.有 === false, JSON.stringify(关));
      const 点3 = await s.js(取点(0));
      const 两下3 = await 拟真连点(s, 点3, 2, 700);
      const 展3 = await s.js(读);
      ctx.assert('④ 菜单开→关之后，慢点两下仍然必出源码、光标进源码',
        展3.图[0].展开 === true && 展3.图[0].在源码 === true,
        JSON.stringify({ clickCount: 两下3, 图: 展3.图[0], 层: 展3.层 }));
      if (展3.图[0].展开 === true) 出源码命中 += 1;
      await s.shot('145-④菜单开合之后-仍出源码');

      // ── ⑤ 键鼠配合：点图片右侧空白 → Enter 造新行 → 打字 → 磁盘上引用仍恰好一条 ────
      await s.key({ key: 'Escape', code: 'Escape', vk: 27 }); await hi.sleep(380);   // 先回到折叠态
      const 点4 = await s.js(取点(0));
      await s.click(点4.右外30.x, 点4.右外30.y); await hi.sleep(420);
      await s.key({ key: 'Enter', code: 'Enter', vk: 13, text: '\r' }); await hi.sleep(420);
      await s.type('Z'); await hi.sleep(420);
      const 存2 = await hi.edge.saveAndWait(s, file, { timeout: 9000 });
      const 盘2 = String(存2.after).replace(/\r/g, '');
      const 引用2 = 图片引用(盘2);
      ctx.assert('⑤ 点图右侧空白 + Enter + 打字：新行 Z 自成一段落在磁盘上（回车真的新起一行）',
        /^Z$/m.test(盘2), JSON.stringify(盘2.slice(-80)));
      ctx.assert('⑤ 打字之后磁盘上图片引用仍恰好一条、粘贴前的正文逐字还在',
        引用2.length === 1 && 盘2.includes('粘贴前正文。'), JSON.stringify({ 条数: 引用2.length, 盘: 盘2.slice(0, 200) }));
      ctx.witness('磁盘：Enter 造新行之后的文档', { 盘: 盘2.replace(/\n/g, '\\n').slice(0, 220), 引用条数: 引用2.length }, 'disk');

      // ── ⑥ 拖拽：图上起手拖出去 = 原生拖选（登记：不挪位、零改动）→ 回来点两下仍必出 ──
      const 拖前 = await s.js(取点(0));
      const Z点 = await s.js(文本点('Z'));            // 拖到下方那行 Z：向前/向后拖都必须成选区
      const 拖前盘 = fs.readFileSync(file, 'utf8');
      await hi.drag(s, { x: 拖前.x, y: 拖前.y }, { x: Z点.ok ? Z点.x : 拖前.x, y: Z点.ok ? Z点.y : 拖前.y + 120 }, { steps: 10, after: 460 });
      const 拖 = await s.js(读);
      const 拖后 = await s.js(取点(0));
      ctx.assert('⑥ 拖拽：图上起手拖出去仍是原生拖选（选区非空或跨过图），图片没有被展开',
        !拖.折叠 && (拖.选区.length > 0 || (拖.选区盒 && 拖.选区盒.w > 100)) && 拖.图[0].展开 === false,
        JSON.stringify({ 选区: 拖.选区, 选区盒: 拖.选区盒, 折叠: 拖.折叠, 图: 拖.图[0] }));
      ctx.assert('⑥ 拖拽不挪位、不改文档：图盒逐像素不变、磁盘逐字节不变（登记产品口径：图上是拖选）',
        拖后.盒.l === 拖前.盒.l && 拖后.盒.t === 拖前.盒.t && 拖后.盒.w === 拖前.盒.w
        && fs.readFileSync(file, 'utf8') === 拖前盘,
        JSON.stringify({ 前: 拖前.盒, 后: 拖后.盒 }));
      ctx.witness('磁盘：图上拖选前后逐字节', { 相同: fs.readFileSync(file, 'utf8') === 拖前盘, 字节: 拖前盘.length }, 'disk');
      const 点5 = await s.js(取点(0));
      const 两下5 = await 拟真连点(s, 点5, 2, 700);
      const 展5 = await s.js(读);
      ctx.assert('⑥ 拖完回来点两下：粘贴出来的这张图仍然出源码、光标进源码',
        展5.图[0].展开 === true && 展5.图[0].在源码 === true,
        JSON.stringify({ clickCount: 两下5, 图: 展5.图[0], 层: 展5.层 }));
      if (展5.图[0].展开 === true) 出源码命中 += 1;
      ctx.assert('⑥ 拖拽+点两下之后：磁盘上图片引用仍恰好一条（没有因为拖拽复制出第二份）',
        图片引用(fs.readFileSync(file, 'utf8')).length === 1, JSON.stringify(图片引用(fs.readFileSync(file, 'utf8'))));

      // ── ⑦ 右下角缩放角标：点它只开合缩放浮层，不误伤图片、文档零改动 ──────────────
      const 盘7前 = fs.readFileSync(file, 'utf8');
      const 前态 = (await s.js(读)).图[0];            // 点角标之前先记图片状态（上一条腿可能还开着源码）
      const 角 = await s.js(角标);
      ctx.assert('⑦ 前置：右下角缩放角标存在（编辑器 iframe 的右下角）', 角.ok === true, JSON.stringify(角));
      if (角.ok) {
        await s.click(角.x, 角.y); await hi.sleep(460);
        const 角开 = await s.js(角标);
        const 后态 = (await s.js(读)).图[0];
        ctx.assert('⑦ 点缩放角标：缩放浮层弹出来（用户看得见），图片状态纹丝不动（不选中、展开态不翻）',
          角开.浮层 === true && 后态.选中 === false && 后态.展开 === 前态.展开,
          JSON.stringify({ 角标: 角开, 前: { 选中: 前态.选中, 展开: 前态.展开 }, 后: { 选中: 后态.选中, 展开: 后态.展开 } }));
        await s.click(角.x, 角.y); await hi.sleep(420);
        const 角关 = await s.js(角标);
        ctx.assert('⑦ 再点一下收起浮层；全程文档零改动（磁盘逐字节相同）',
          角关.浮层 === false && fs.readFileSync(file, 'utf8') === 盘7前,
          JSON.stringify({ 浮层: 角关.浮层, 盘同: fs.readFileSync(file, 'utf8') === 盘7前 }));
        ctx.witness('几何：缩放角标与图片状态', { 角标: 角, 开时: 角开.浮层, 关时: 角关.浮层, 前态: { 选中: 前态.选中, 展开: 前态.展开 }, 后态: { 选中: 后态.选中, 展开: 后态.展开 } }, 'geometry');
      } else {
        ctx.assert('⑦ 点缩放角标：浮层开合', false, '角标读不到，无法执行点击：' + JSON.stringify(角));
      }

      ctx.metric('粘贴图两下出源码命中数', 出源码命中, { unit: '次', direction: 'higher', values: [出源码命中] });
      ctx.log(`粘贴入口侧第二下命中 ${出源码命中} 次（粘贴后立刻 / 菜单开合后 / 拖拽后）`);
    } finally {
      await ctx.release(s);
      if (用户剪贴板 && 用户剪贴板.__file) {
        try { harness.restoreClipboard(剪贴板房, 用户剪贴板.__file); ctx.witness('剪贴板：收尾还原用户原内容', { 还原: true }, 'clipboard'); }
        catch (error) { ctx.log('用户剪贴板还原失败：' + String(error.message).slice(0, 120)); }
      }
    }
  },
};
