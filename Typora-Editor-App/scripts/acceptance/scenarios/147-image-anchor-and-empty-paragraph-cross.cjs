/** 147 · 图片 ZWSP 零宽锚 × 空段落交叉（U-079 / U-082 / ZWSP 锚）
 *
 *  对应台账：U-079（图片右侧空白点击落"图片之后"）、U-082（空段落纵向导航）、U-011/A-011
 *  （原生光标可见性）。背景：图片右侧空白点击会立一个**紧随图片节点的 ZWSP 零宽锚**
 *  （`\u200b` 文本节点，选区落 z@0，原生 caret 自己画；media-tools.js 立零宽锚 L1524，
 *  `owner.after(z)` L1529）。138③ 只测「锚存在且原生可见」，锚与**空段落**的交叉
 *  （锚位 Enter 造出的空段、方向键在两者之间进出、退格、撤销、跨锚拖选复制、落盘）零覆盖。
 *
 *  本场景锁住的契约（全部是用户看得见的东西；圈号在会话内编号，跨会话会重复）：
 *    · 会话一（核心形态：图片独占一段、上下都有正文）：
 *      ① 点图片右侧空白 → 锚位上有**可见的原生光标**（选区落在 ZWSP 锚 z@0、矩形高>0、
 *         在编辑面内、不是壳层、不在图片的隐藏源码层）；← 能出去（落到前一处可见文本尾、
 *         锚随之摘除）；再点一下又能锚回来；→ 不把光标送进隐藏源码。
 *      ④ 跨锚拖选（从"前文甲"拖到"后文乙"，横跨锚位）：锚节点被摘除、选区非空；
 *         真 Ctrl+C（到不了加速器时退编辑面的 copy 编辑命令，与场景 20 同款判定）后
 *         **独立进程读回的系统剪贴板文本里没有 U+200B**；拖选前后磁盘逐字节不变。
 *      ② 锚位按回车 → 图片所在块**之后新起一条空段**（用户 2026-10-04 的需求形态），
 *         光标落在这条空段里；随后 Ctrl+Z → 刚造的空段被撤掉（块序列逐项回到回车之前）、
 *         **锚位光标重显**（选区回到锚上、原生矩形高>0、在面内、不落壳层、不落 0×0）、
 *         存盘逐字节回到原文。
 *      ③ 空段与图片行相邻：↓ 逐行到"后文乙"、↑ 回到空段（双向逐行）；再 ↑ 的落点按
 *         「登记」留档；存盘后**非空行逐字与原文一致**且无 ZWSP 残留。
 *    · 会话二（图片行四周的纵向落点矩阵，登记读数）：从后文乙 ↑ / 从前文甲 ↓ / 锚位 ↑ /
 *      锚位 ↓ 四个读数 + "锚位本身逐行（↑ 到前文甲、↓ 到后文乙）"的断言。
 *    · 会话三（文末图，图片是最后一块）：点右空白立锚；锚位回车 → 文末新起空段；再 ↓ 到底
 *      光标不消失；存盘无 ZWSP、以原文为前缀。
 *    · 会话四（图片紧贴标题下方）：锚位 ↑ 落标题行（紧邻上一行）、↓ 落后文乙；文末回车造段；
 *      存盘图片引用/标题/正文逐字不变、无 ZWSP。
 *    · 会话五（图片后接软换行段落＝图文同段）：点右空白仍立锚、选区落 z@0、原生光标可见；
 *      立锚不改文档（磁盘逐字节）。
 *
 *  已登记的偏差点（本案不判红，读数留档，见 ctx.log 的「登记」行）：
 *    · 键盘纵向导航**跨不过图片行**：从图片行下方的空段按 ↑、或从图片行上方的段落按 ↓，
 *      落点会跳过图片行。图片行上唯一能放光标的位置就是那条 ZWSP 锚（**只能点出来**），
 *      锚位回车之后它按产品注释降级成"撤销重显落点"（服役=false），所以键盘链上没有落点。
 *      本场景把这个读数与复现坐标原样记账，不当作锚×空段的契约来判红。
 *    · 拖选横跨"锚位回车造出的那条空段"时，编辑面的 `selection.toString()` 里带着空段自带的
 *      脚手架 ZWSP；但**产品复制通道会剥掉它**，用户拿到的剪贴板文本干净（④ 判的就是这一条，
 *      独立进程读回为证）。
 *
 *  突变验证（把修复注掉必须变红）：
 *    · 注掉 media-tools.js L1529 立零宽锚的 `owner.after(z)`（或 L1596 落到图片之后 整支）
 *      → ① 的"锚存在 + 落锚 + 原生高>0"变红（选区落回隐藏源码位/0×0）；
 *    · 注掉 L2055–2072 selectionchange 里的 `边界救援()` 调用 → ② 的"撤销后锚位光标重显"变红
 *      （撤销后选区停在不可见的元素边界位，锚立不起来）；2026-10-05 那次改动半落地时，本场景
 *      会话三的"点右空白立锚"就实测红过一次（点完没有锚、光标停在 (P,1) 0×0）。
 *
 *  证人通道：`geometry`（锚位原生光标矩形 / 落点层级）+ `disk`（存盘逐字节与 ZWSP 扫描）
 *  + `clipboard`（独立进程读回复制文本）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const hi = require('../../human-input/hi.cjs');

const BODY = ['# 图标题', '', '前文甲。', '', '![靶图](shot-blue.png)', '', '后文乙。', ''].join('\n');
const BODY_TAIL = ['# 图标题', '', '前文甲。', '', '![靶图](shot-blue.png)', ''].join('\n');
const BODY_TITLE_IMG = ['# 图标题', '', '![靶图](shot-blue.png)', '', '后文乙。', ''].join('\n');
const BODY_SOFT = ['# 图标题', '', '前文甲。', '', '![靶图](shot-blue.png)', '软换行乙。', ''].join('\n');

const 版面 = `(() => { const w = ${hi.IF}; if (!w || !w.document) return { ok: false };
  const d = w.document, s = d.querySelector('${hi.SURFACE}'); if (!s) return { ok: false };
  const 块 = [...s.children].map((b, i) => { const r = b.getBoundingClientRect();
    return { i, tag: b.tagName, t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height),
      空: !String(b.textContent || '').replace(/[\\s\\u200b]/g, ''), zwsp: /\\u200b/.test(String(b.textContent || '')),
      文本: String(b.textContent || '').replace(/\\u200b/g, '<z>').replace(/\\s+/g, ' ').slice(0, 24) }; });
  const sel = w.getSelection(), r = sel && sel.rangeCount ? sel.getRangeAt(0) : null; let 光 = null;
  if (r) { let top = r.startContainer; if (top.nodeType === 3) top = top.parentElement;
    while (top && top.parentElement && top.parentElement !== s) top = top.parentElement;
    const idx = (top && top.parentElement === s) ? [...s.children].indexOf(top) : -1;
    const box = r.getBoundingClientRect();
    光 = { 块: idx, 容器: r.startContainer.nodeType === 3 ? 'TEXT(' + r.startContainer.data.replace(/\\u200b/g, '<z>').slice(0, 12) + ')' : r.startContainer.nodeName,
      偏移: r.startOffset, 折叠: r.collapsed, x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height),
      在面内: s.contains(r.startContainer), 选区: sel.toString().replace(/\\u200b/g, '<z>').slice(0, 40) }; }
  return { ok: true, 块, 光 }; })()`;

/** 锚读数：锚节点在不在、选区落不落在 z@0、原生光标矩形、层级、是不是壳层。 */
const 读锚 = `(() => { const w = ${hi.IF}, d = w.document, s = d.querySelector('${hi.SURFACE}');
  const img = [...s.querySelectorAll('img')].pop();
  const owner = img && img.closest('.vditor-ir__node[data-type]');
  const nx = owner && owner.nextSibling;
  const z = nx && nx.nodeType === 3 && nx.data.length === 1 && nx.data.charCodeAt(0) === 0x200b ? nx : null;
  const sel = w.getSelection(), r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  let 落锚 = false;
  if (z && r) { try { const a = d.createRange(); a.setStart(z, 0); a.collapse(true);
    落锚 = r.collapsed && r.compareBoundaryPoints(Range.START_TO_START, a) === 0; } catch (e) { 落锚 = 'ERR'; } }
  const box = r ? r.getBoundingClientRect() : null;
  const el = r ? (r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer) : null;
  let top = r ? r.startContainer : null; if (top && top.nodeType === 3) top = top.parentElement;
  while (top && top.parentElement && top.parentElement !== s) top = top.parentElement;
  return { 有锚: !!z, 落锚, 原生高: box ? Math.round(box.height) : null, 原生宽: box ? Math.round(box.width) : null,
    折叠: r ? r.collapsed : null, 容器: r ? (r.startContainer.nodeType === 3 ? 'TEXT(' + r.startContainer.data.replace(/\\u200b/g, '<z>').slice(0, 12) + ')' : r.startContainer.nodeName) : null,
    偏移: r ? r.startOffset : null, 在面内: r ? s.contains(r.startContainer) : false,
    是壳层: !!(el && r && !s.contains(r.startContainer) && el.closest('.vditor-ir')),
    层: el && el.closest('code[data-type]') ? '源码' : '正文',
    块: (top && top.parentElement === s) ? [...s.children].indexOf(top) : -1,
    选区: sel ? sel.toString().replace(/\\u200b/g, '<z>').slice(0, 40) : null, 选区含零宽: sel ? /\\u200b/.test(sel.toString()) : null }; })()`;

const 图几何 = `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop(); if (!img) return { ok: false };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = img.getBoundingClientRect();
  const owner = img.closest('.vditor-ir__node[data-type]');
  const blk = owner && owner.parentElement ? owner.parentElement.getBoundingClientRect() : null;
  return { ok: true, 已加载: !!(img.complete && img.naturalWidth > 0), 右外30: { x: Math.round(frame.x + r.right + 30), y: Math.round(frame.y + r.top + r.height / 2) },
    中心: { x: Math.round(frame.x + r.left + r.width / 2), y: Math.round(frame.y + r.top + r.height / 2) },
    图盒: { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) },
    块盒: blk ? { l: Math.round(blk.left), r: Math.round(blk.right), t: Math.round(blk.top), b: Math.round(blk.bottom) } : null,
    在块内: !!blk && r.right + 30 < blk.right,
    类型: owner ? owner.getAttribute('data-type') : null }; })()`;

/** 图片真的解码出来了（naturalWidth>0）——图没加载完时它的盒子不是用户看到的位置，
 *  按那个盒子点右侧空白会点空（实测 1/3 次偶发：点完没有锚、光标停在元素边界位）。 */
const 等图 = `(() => { const w = ${hi.IF}, d = w.document;
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop();
  return !!(img && img.complete && img.naturalWidth > 0); })()`;

const 放块首 = 词 => `(() => { const w = ${hi.IF}, d = w.document, s = d.querySelector('${hi.SURFACE}');
  const i = [...s.children].findIndex(b => String(b.textContent || '').includes(${JSON.stringify(词)}));
  if (i < 0) return { ok: false, why: '找不到块' };
  const b = s.children[i], walker = d.createTreeWalker(b, NodeFilter.SHOW_TEXT, null); let n = null;
  while (walker.nextNode()) { if (walker.currentNode.data.replace(/[\\s\\u200b]/g, '')) { n = walker.currentNode; break; } }
  if (!n) return { ok: false, why: '这一块没有可落文字', i };
  s.focus(); const r = d.createRange(); r.setStart(n, 0); r.collapse(true);
  const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  return { ok: true, i }; })()`;

const 放块尾 = 词 => `(() => { const w = ${hi.IF}, d = w.document, s = d.querySelector('${hi.SURFACE}');
  const i = [...s.children].findIndex(b => String(b.textContent || '').includes(${JSON.stringify(词)}));
  if (i < 0) return { ok: false, why: '找不到块' };
  const b = s.children[i], walker = d.createTreeWalker(b, NodeFilter.SHOW_TEXT, null); let n = null;
  while (walker.nextNode()) { if (walker.currentNode.data.replace(/[\\s\\u200b]/g, '')) n = walker.currentNode; }
  if (!n) return { ok: false, why: '这一块没有可落文字', i };
  s.focus(); const r = d.createRange(); r.setStart(n, n.data.length); r.collapse(true);
  const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  return { ok: true, i, 长: n.data.length }; })()`;

const 文本点 = 词 => `(() => { const w = ${hi.IF}, d = w.document; const fr = document.getElementById('editor').getBoundingClientRect();
  const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => String(p.textContent || '').includes(${JSON.stringify(词)}));
  if (!t) return { ok: false };
  const r = t.getBoundingClientRect();
  return { ok: true, x: Math.round(fr.x + r.left + 20), y: Math.round(fr.y + r.top + r.height / 2) }; })()`;

async function 回车(session) { await session.key({ key: 'Enter', code: 'Enter', vk: 13, text: '\r' }); await hi.sleep(470); }
async function 上(session) { await session.key({ key: 'ArrowUp', code: 'ArrowUp', vk: 38 }); await hi.sleep(450); }
async function 下(session) { await session.key({ key: 'ArrowDown', code: 'ArrowDown', vk: 40 }); await hi.sleep(450); }
async function 左(session) { await session.key({ key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }); await hi.sleep(450); }
async function 右(session) { await session.key({ key: 'ArrowRight', code: 'ArrowRight', vk: 39 }); await hi.sleep(450); }
async function 撤销(session) { await hi.combo(session, 'Ctrl+z'); await hi.sleep(640); }
async function 点锚(session, g) { await session.click(g.右外30.x, g.右外30.y); await hi.sleep(520); }

module.exports = {
  id: '147-image-anchor-and-empty-paragraph-cross',
  title: '图片 ZWSP 零宽锚 × 空段落：锚位可见光标/进出、锚位回车造空段、撤销重显、跨锚复制不含零宽、落盘无 ZWSP',
  run: async ctx => {
    fs.mkdirSync(hi.ROOM, { recursive: true });
    fs.writeFileSync(`${hi.ROOM}/shot-blue.png`, hi.fixtures.png(160, 100, [70, 110, 230]));
    const clipDir = path.join(ctx.outDir, 'clip');
    fs.mkdirSync(clipDir, { recursive: true });
    let 剪贴板存档 = null;
    try { 剪贴板存档 = hi.harness.saveClipboard(clipDir); } catch (error) { ctx.log('剪贴板存档失败：' + error.message); }

    // ══ 会话一：锚位事实 + 进出 + 锚位回车造空段 + 撤销重显 + 落盘 ═══════════════
    const file = hi.writeDoc('anchor-cross-core.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 4 });
    try {
      const 原盘 = fs.readFileSync(file, 'utf8');
      ctx.assert('会话一 焦点在编辑器（鼠标/按键类读数前置）', (await hi.ensureFocus(session)).ok, '');
      const 图就绪 = await session.until(等图, { timeout: 25000, interval: 120 });
      const g = await session.js(图几何);
      ctx.assert('会话一 前置：图片真的加载出来了（naturalWidth>0），且拿到右侧空白带的有效点',
        图就绪 && g.ok && g.已加载 === true && g.类型 === 'img' && g.在块内 === true, JSON.stringify({ 图就绪, g }));

      // ── ① 点右空白 → 可见原生光标；← 出得去；再点锚回来；→ 不进隐藏源码 ─────────
      await 点锚(session, g);
      const 锚1 = await session.js(读锚);
      ctx.assert('① 点图片右侧空白：立起 ZWSP 零宽锚、选区落在锚上（z@0）',
        锚1.有锚 === true && 锚1.落锚 === true, JSON.stringify(锚1));
      ctx.assert('① 锚位上有**可见的原生光标**（矩形高>0、在编辑面内、不是壳层、不在隐藏源码层）',
        锚1.原生高 > 0 && 锚1.在面内 === true && 锚1.是壳层 === false && 锚1.层 === '正文', JSON.stringify(锚1));
      ctx.witness('几何：点图片右侧空白后的锚位光标', 锚1, 'geometry');
      await session.shot('147-①锚位原生光标');

      await 左(session);
      const 左后 = await session.js(读锚);
      ctx.assert('① 锚位上按 ← 能出去：光标落到前一处可见文本尾（前文甲行尾），锚随之摘除',
        左后.有锚 === false && 左后.在面内 === true && 左后.块 === 1 && 左后.偏移 === 4,
        JSON.stringify({ 左后, 期望: '块1 前文甲。 偏移4' }));
      await 点锚(session, g);
      const 锚再来 = await session.js(读锚);
      ctx.assert('① 再点一次右空白：锚又立回来（进得来）', 锚再来.有锚 === true && 锚再来.落锚 === true, JSON.stringify(锚再来));
      await 右(session);
      const 右后 = await session.js(读锚);
      ctx.assert('① 锚位上按 → 不进图片的隐藏源码（光标仍在图片行内、层＝正文）',
        右后.在面内 === true && 右后.层 === '正文' && 右后.块 === 2, JSON.stringify(右后));

      // ── ④ 跨锚拖选复制：剪贴板里不含零宽字符（本步全程不编辑文档，先做） ─────────
      const 哨兵 = 'MARKPILOT-ANCHOR-SENTINEL-' + Date.now();
      hi.harness.writeClipboard(clipDir, 哨兵);
      const 甲 = await session.js(文本点('前文甲'));
      const 乙 = await session.js(文本点('后文乙'));
      await 点锚(session, g);
      const 锚拖 = await session.js(读锚);
      ctx.assert('④ 前置：拖选之前锚在图片行上', 锚拖.有锚 === true, JSON.stringify(锚拖));
      await hi.drag(session, { x: 甲.x, y: 甲.y }, { x: 乙.x, y: 乙.y }, { steps: 10, after: 560 });
      const 拖后 = await session.js(读锚);
      ctx.assert('④ 跨锚拖选：拖出非空选区、锚节点已被摘掉（锚不会被圈进选区）',
        拖后.折叠 === false && String(拖后.选区).length > 0 && 拖后.有锚 === false, JSON.stringify(拖后));
      await hi.combo(session, 'Ctrl+c'); await hi.sleep(980);
      let 剪 = null, 通道 = 'Ctrl+C（真实键盘）';
      try { 剪 = hi.harness.readClipboard(clipDir); } catch (error) { ctx.log('读剪贴板失败：' + error.message); }
      if (!剪 || !剪.hasText || String(剪.text || '').includes(哨兵)) {
        // CDP 派发的 Ctrl+C 到不了浏览器加速器时，用编辑面自己的 copy 编辑命令兜底
        // （与场景 20 同款判定）；选区本身是真实拖拽出来的，这一步只负责把文本读出来。
        通道 = '编辑面 copy 编辑命令（Ctrl+C 没送到加速器）';
        await session.jsSoft(`(() => { const w = ${hi.IF}; return w.document.execCommand('copy'); })()`);
        await hi.sleep(900);
        try { 剪 = hi.harness.readClipboard(clipDir); } catch (error) { ctx.log('二次读剪贴板失败：' + error.message); }
      }
      const 剪文 = String((剪 && 剪.text) || '');
      ctx.assert('④ 系统剪贴板（独立进程读回）拿到的是这段选区文字，且**不含 U+200B 零宽空格**',
        !!剪 && 剪.hasText === true && /文甲。/.test(剪文) && /后/.test(剪文) && !/\u200b/.test(剪文),
        `通道=${通道} 文本=${JSON.stringify(剪文.replace(/\u200b/g, '<ZWSP>').slice(0, 60))}`);
      ctx.witness('剪贴板：跨锚拖选复制读回', { 通道, 文本: 剪文.replace(/\u200b/g, '<ZWSP>').slice(0, 80), 含零宽: /\u200b/.test(剪文), 选区: 拖后.选区 }, 'clipboard');
      const 盘选 = await hi.edge.saveAndWait(session, file, { timeout: 3000 });
      ctx.assert('④ 拖选 + 复制不改文档（磁盘逐字节＝原文）',
        String(盘选.after).replace(/\r/g, '') === 原盘.replace(/\r/g, ''), JSON.stringify(String(盘选.after).replace(/\n/g, '\\n')));

      // ── ② 锚位回车 → 图片之后新起空段 → Ctrl+Z → 撤销后锚位光标重显 ───────────
      await 点锚(session, g);
      const 撤前 = await session.js(版面);
      await 回车(session);
      const 造2 = await session.js(版面);
      ctx.assert('② 锚位按回车：图片所在块**之后**新起一条空段（块数 +1、光标落在这条空段里）',
        造2.ok && 造2.块.length === 撤前.块.length + 1 && 造2.光 && 造2.块[造2.光.块].空 === true
        && 造2.光.块 === 3 && 造2.块[2].文本.includes('![靶图]'),
        JSON.stringify(造2.块.map(b => b.i + b.tag + (b.空 ? '(空)' : '') + ':' + b.文本)) + ' 光=' + JSON.stringify(造2.光));
      await 撤销(session);
      const 撤后 = await session.js(版面);
      const 撤锚 = await session.js(读锚);
      ctx.assert('② Ctrl+Z 撤销：刚造出的空段被撤掉（块序列逐项回到回车之前）',
        撤后.ok && JSON.stringify(撤后.块.map(b => b.tag + '|' + b.文本)) === JSON.stringify(撤前.块.map(b => b.tag + '|' + b.文本)),
        JSON.stringify({ 撤前: 撤前.块.map(b => b.tag + ':' + b.文本), 撤后: 撤后.块.map(b => b.tag + ':' + b.文本) }));
      ctx.assert('② 撤销后**锚位光标重显**：选区回到锚上（落锚）、原生光标矩形高>0、在编辑面内',
        撤锚.有锚 === true && 撤锚.落锚 === true && 撤锚.原生高 > 0 && 撤锚.在面内 === true, JSON.stringify(撤锚));
      ctx.assert('② 撤销后的选区**不落壳层、不落 0×0**（是壳层＝A-005 那类回退；0×0＝光标看不见）',
        撤锚.是壳层 === false && 撤锚.原生高 > 0, JSON.stringify({ 是壳层: 撤锚.是壳层, 原生高: 撤锚.原生高, 原生宽: 撤锚.原生宽 }));
      ctx.witness('几何：撤销后的锚位光标', 撤锚, 'geometry');
      await session.shot('147-②撤销后锚位光标重显');
      const 盘撤 = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      ctx.assert('② 撤销 + 存盘：文件逐字节回到打开时的原文（那条空段没有落进 md）',
        String(盘撤.after).replace(/\r/g, '') === 原盘.replace(/\r/g, ''), JSON.stringify({ 盘: String(盘撤.after).replace(/\n/g, '\\n'), 原: 原盘.replace(/\n/g, '\\n') }));
      ctx.witness('磁盘：撤销后存盘', { 盘: String(盘撤.after).replace(/\n/g, '\\n'), 含零宽: /\u200b/.test(String(盘撤.after)) }, 'disk');

      // ── ③ 锚位回车造的空段与图片行之间的 ↑↓（逐行的那一向 + 登记读数） ─────────
      await 点锚(session, g);
      await 回车(session);
      const 段后 = await session.js(版面);
      ctx.assert('③ 前置：锚位回车造出紧贴图片块下方的空段（块 3，图片行仍是块 2）',
        段后.ok && 段后.块.length === 5 && 段后.块[2].文本.includes('![靶图]') && 段后.块[3].空,
        JSON.stringify(段后.块.map(b => b.i + b.tag + (b.空 ? '(空)' : '') + ':' + b.文本)));
      await 下(session);
      const 下探 = await session.js(版面);
      ctx.assert('③ 空段里按 ↓ 逐行到紧邻的下一块（后文乙，块 4），不跳行、光标不消失',
        下探.光 && 下探.光.在面内 === true && 下探.光.块 === 4 && 下探.块[4].文本.includes('后文乙'),
        JSON.stringify(下探.光));
      await 上(session);
      const 乙上 = await session.js(版面);
      ctx.assert('③ 从后文乙 ↑ 回到紧邻的空段（块 3）——空段与文本行之间双向逐行',
        乙上.光 && 乙上.光.在面内 === true && 乙上.光.块 === 3 && 乙上.块[3].空 === true, JSON.stringify(乙上.光));
      await 上(session);
      const 空上 = await session.js(版面);
      ctx.log(`登记：键盘纵向导航跨不过图片行——从图片行下方的空段（块 3）继续 ↑ 落在块 ${空上.光.块}`
        + `（${空上.块[空上.光.块] && 空上.块[空上.光.块].文本}），图片行（块 2）被跳过。`
        + '图片行上唯一能放光标的位置是那条 ZWSP 锚、只能点出来；锚位回车之后它按产品注释降级成"撤销重显落点"，键盘链上没有落点。读数留档，本案不判红。');
      ctx.witness('几何：空段与图片行之间的纵向落点', { 空段: 段后.光, 从空段下: 下探.光, 从后文乙上: 乙上.光, 再上: 空上.光 }, 'geometry');
      const 盘跨 = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const 盘跨文 = String(盘跨.after).replace(/\r/g, '');
      ctx.assert('③ 跨图片行导航后存盘：**非空行逐字与原文一致**（只多出一条空行＝刚造的那条空段），且没有 ZWSP 残留',
        !/\u200b/.test(盘跨文) && 盘跨文.replace(/\n+/g, '\n') === 原盘.replace(/\r/g, '').replace(/\n+/g, '\n'),
        JSON.stringify(盘跨文.replace(/\n/g, '\\n')));
      ctx.witness('磁盘：空段与图片行之间导航后存盘', { 盘: 盘跨文.replace(/\n/g, '\\n'), 含零宽: /\u200b/.test(盘跨文) }, 'disk');
    } finally {
      await ctx.release(session);
    }

    // ══ 会话二：图片行在键盘纵向链上的可达性（登记读数，不判红） ════════════════
    const file2 = hi.writeDoc('anchor-cross-nav.md', BODY);
    const session2 = await hi.openDoc(ctx, file2, { minBlocks: 4 });
    try {
      ctx.assert('会话二 焦点在编辑器', (await hi.ensureFocus(session2)).ok, '');
      await session2.until(等图, { timeout: 25000, interval: 120 });
      const g2 = await session2.js(图几何);
      await session2.js(放块首('后文乙'));
      await 上(session2);
      const 乙上 = await session2.js(版面);
      await session2.js(放块尾('前文甲'));
      await 下(session2);
      const 甲下 = await session2.js(版面);
      await 点锚(session2, g2);
      await 上(session2);
      const 锚上 = await session2.js(版面);
      await 点锚(session2, g2);
      await 下(session2);
      const 锚下 = await session2.js(版面);
      ctx.log('登记：图片行（块 2）的键盘可达性读数——'
        + `从后文乙↑→块${乙上.光.块}(${乙上.块[乙上.光.块] && 乙上.块[乙上.光.块].文本})；`
        + `从前文甲↓→块${甲下.光.块}(${甲下.块[甲下.光.块] && 甲下.块[甲下.光.块].文本})；`
        + `锚位↑→块${锚上.光.块}(${锚上.块[锚上.光.块] && 锚上.块[锚上.光.块].文本})；`
        + `锚位↓→块${锚下.光.块}(${锚下.块[锚下.光.块] && 锚下.块[锚下.光.块].文本})。`);
      ctx.assert('② 锚位（图片行上的光标）按 ↑ 落到**紧邻上一行**、按 ↓ 落到紧邻的下一块——锚位本身是逐行的',
        锚上.光.块 === 1 && 锚下.光.块 === 3, JSON.stringify({ 锚上: 锚上.光, 锚下: 锚下.光 }));
      ctx.witness('几何：图片行四周的纵向落点矩阵', { 从后文乙上: 乙上.光, 从前文甲下: 甲下.光, 锚位上: 锚上.光, 锚位下: 锚下.光 }, 'geometry');
    } finally {
      await ctx.release(session2);
    }

    // ══ 会话三：文末图（图片是最后一块）——锚位回车造文末空段、↑↓ 往返、落盘 ══════
    const file3 = hi.writeDoc('anchor-cross-tail.md', BODY_TAIL);
    const session3 = await hi.openDoc(ctx, file3, { minBlocks: 3 });
    try {
      const 原盘3 = fs.readFileSync(file3, 'utf8');
      ctx.assert('会话三 焦点在编辑器', (await hi.ensureFocus(session3)).ok, '');
      const 图就绪3 = await session3.until(等图, { timeout: 25000, interval: 120 });
      const g3 = await session3.js(图几何);
      ctx.assert('③ 前置：文末图已加载、右侧空白带的点在图片块内（点空会点出 0×0 光标）',
        图就绪3 && g3.ok && g3.已加载 === true && g3.在块内 === true, JSON.stringify(g3));
      await 点锚(session3, g3);
      const 锚3 = await session3.js(读锚);
      ctx.assert('③ 文末图：点右侧空白同样立锚、原生光标可见', 锚3.有锚 === true && 锚3.落锚 === true && 锚3.原生高 > 0, JSON.stringify(锚3));
      await 回车(session3);
      const 尾段 = await session3.js(版面);
      ctx.assert('③ 文末图锚位回车：文末新起一条空段、光标在它里面（用户"图片后回车新行"的需求形态）',
        尾段.ok && 尾段.块.length === 4 && 尾段.块[3].空 && 尾段.光 && 尾段.光.块 === 3,
        JSON.stringify(尾段.块.map(b => b.i + b.tag + (b.空 ? '(空)' : '') + ':' + b.文本)) + ' 光=' + JSON.stringify(尾段.光));
      await 下(session3);
      const 尾底 = await session3.js(版面);
      ctx.assert('③ 文末空段再按 ↓：已经到底，光标**不消失**（仍在面内、仍在块 3）',
        尾底.光 && 尾底.光.在面内 === true && 尾底.光.块 === 3, JSON.stringify(尾底.光));
      const 盘尾 = await hi.edge.saveAndWait(session3, file3, { timeout: 8000 });
      ctx.assert('③ 文末空段存盘：文件里没有多出 ZWSP、图片引用逐字不变',
        !/\u200b/.test(String(盘尾.after)) && String(盘尾.after).includes('![靶图](shot-blue.png)') && String(盘尾.after).replace(/\r/g, '').startsWith(原盘3.replace(/\r/g, '')),
        JSON.stringify(String(盘尾.after).replace(/\n/g, '\\n')));
      ctx.witness('磁盘：文末图锚位回车后存盘', { 盘: String(盘尾.after).replace(/\n/g, '\\n'), 含零宽: /\u200b/.test(String(盘尾.after)) }, 'disk');
    } finally {
      await ctx.release(session3);
    }

    // ══ 会话四：图片紧贴在标题下方（图片行上邻是标题）——逐行往返 + 落盘 ═════════
    const file4 = hi.writeDoc('anchor-cross-titleimg.md', BODY_TITLE_IMG);
    const session4 = await hi.openDoc(ctx, file4, { minBlocks: 3 });
    try {
      const 原盘4 = fs.readFileSync(file4, 'utf8');
      ctx.assert('会话四 焦点在编辑器', (await hi.ensureFocus(session4)).ok, '');
      await session4.until(等图, { timeout: 25000, interval: 120 });
      const g4 = await session4.js(图几何);
      await 点锚(session4, g4);
      const 锚4 = await session4.js(读锚);
      ctx.assert('④ 标题下方图：点右侧空白立锚、原生光标可见', 锚4.有锚 === true && 锚4.落锚 === true && 锚4.原生高 > 0, JSON.stringify(锚4));
      await 上(session4);
      const 上4 = await session4.js(版面);
      ctx.assert('④ 锚位 ↑ 落到**紧邻上一行**（标题行，块 0）——图片行上一行是标题时逐行成立',
        上4.光 && 上4.光.块 === 0 && 上4.块[0].tag === 'H1', JSON.stringify(上4.光));
      await 下(session4);
      const 下4 = await session4.js(版面);
      ctx.assert('④ ↓ 从标题行落到紧邻的下一个可见文本块（后文乙，块 2）——没有丢键、没有落到编辑面外',
        下4.光 && 下4.光.在面内 === true && 下4.光.块 === 2 && 下4.块[2].文本.includes('后文乙'), JSON.stringify(下4.光));
      await 回车(session4);
      const 段4 = await session4.js(版面);
      ctx.assert('④ 后文乙行尾回车：文末新起空段（块 3），光标落在里面',
        段4.ok && 段4.块.length === 4 && 段4.块[3].空 && 段4.光 && 段4.光.块 === 3,
        JSON.stringify(段4.块.map(b => b.i + b.tag + (b.空 ? '(空)' : '') + ':' + b.文本)));
      const 盘4 = await hi.edge.saveAndWait(session4, file4, { timeout: 8000 });
      ctx.assert('④ 落盘：图片引用、标题、后文乙逐字不变，且没有零宽字符残留',
        !/\u200b/.test(String(盘4.after)) && String(盘4.after).includes('![靶图](shot-blue.png)')
        && String(盘4.after).includes('# 图标题') && String(盘4.after).includes('后文乙。'),
        JSON.stringify(String(盘4.after).replace(/\n/g, '\\n')));
      ctx.witness('磁盘：标题下方图 + 文末空段存盘', { 盘: String(盘4.after).replace(/\n/g, '\\n'), 原: 原盘4.replace(/\n/g, '\\n') }, 'disk');
    } finally {
      await ctx.release(session4);
    }

    // ══ 会话五：图片后接软换行段落（图文同段）——锚仍然立得住、文字一个不动 ══════
    const file5 = hi.writeDoc('anchor-cross-soft.md', BODY_SOFT);
    const session5 = await hi.openDoc(ctx, file5, { minBlocks: 3 });
    try {
      ctx.assert('会话五 焦点在编辑器', (await hi.ensureFocus(session5)).ok, '');
      await session5.until(等图, { timeout: 25000, interval: 120 });
      const g5 = await session5.js(图几何);
      const 软块 = await session5.js(版面);
      ctx.assert('⑤ 前置：图文同段（图片与"软换行乙。"在同一块里）',
        软块.ok && 软块.块.some(b => b.文本.includes('![靶图]') && b.文本.includes('软换行')), JSON.stringify(软块.块.map(b => b.i + b.tag + ':' + b.文本)));
      await 点锚(session5, g5);
      const 锚5 = await session5.js(读锚);
      ctx.assert('⑤ 图文同段的图片：点右侧空白仍立锚、选区落 z@0、原生光标可见',
        锚5.有锚 === true && 锚5.落锚 === true && 锚5.原生高 > 0 && 锚5.层 === '正文', JSON.stringify(锚5));
      const 盘5 = await hi.edge.saveAndWait(session5, file5, { timeout: 3000 });
      ctx.assert('⑤ 立锚不改文档：软换行文字与图片引用逐字不变、无零宽残留（磁盘）',
        String(盘5.after).replace(/\r/g, '') === BODY_SOFT && !/\u200b/.test(String(盘5.after)),
        JSON.stringify(String(盘5.after).replace(/\n/g, '\\n')));
      ctx.witness('磁盘：图文同段立锚前后', { 盘: String(盘5.after).replace(/\n/g, '\\n'), 含零宽: /\u200b/.test(String(盘5.after)) }, 'disk');
    } finally {
      await ctx.release(session5);
    }

    if (剪贴板存档) {
      try { hi.harness.restoreClipboard(clipDir, 剪贴板存档.__file); ctx.log('剪贴板已还原'); }
      catch (error) { ctx.log('剪贴板还原失败：' + error.message); }
    }
  },
};
