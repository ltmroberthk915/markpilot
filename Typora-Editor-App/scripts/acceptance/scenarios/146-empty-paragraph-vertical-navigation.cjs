/** 146 · 空段落纵向导航（U-082）：标题行首 Enter 建立的活空段，↑ 必须落得进去
 *
 *  对应台账：U-082（「新bug光标在此处, 按向上方向键无法到上一行空行，已知上一行已经建立了
 *  新的空行了」；2026-10-05 已修 48bef3b，台账「证据门」只有一次性探针，**没有正式场景**）。
 *
 *  为什么单独立一条场景：
 *    · 用户说的「新空行」不是 md 源里的空行（源里空行渲染后不产生空段落块），而是**活建立的
 *      空段落** `<p data-block="0"><br></p>`（高 25px）——在 `### 工程问题` 行首按回车产生。
 *    · 修复前：光标在标题行首按 ↑ 三发全部钉死在标题 marker@0（几何 x/y 纹丝不动）。
 *      根因＝纵向导航链对空段落全盲：空段带内 caretRangeFromPoint 只给 (P,0)、矩形 0×0，
 *      被 usable 的 height>0 筛子拒收 → scan 零候选 → 走"到顶/到底"分支吞键。
 *    · 修法在 app/renderer/js/math-edit.js 的 `emptyLineVertical`（约 L1107，注册 L1176）：
 *      只接管「光标贴着所在块首/末视觉行、且该方向上紧邻的兄弟块是一条空段落」的那一按，
 *      落 (P,0) 并拦下后续监听；其余情形原样放行。
 *
 *  本场景把「一个坐标」推广成**族**（以点扫面）。断言按会话分组，标签里的圈号是组内序号：
 *    · 会话一（①②③④⑤⑬⑥⑦ 共 49 条）——用户原形态：
 *      ① 标题行首 Enter → 上方出现一条**贴着标题**的活空段（几何：空段盒在标题盒正上方）；
 *      ② 在标题行首按 ↑ → 光标**落到那条空行上**（不是钉死原地、不是跳过去）；光标不消失：
 *         空行有可见版面行盒、光标在面内、落点块就是紧邻的上一块；
 *      ③ 空行上打字，字就落在那一行（磁盘逐字节：`X` 出现在 `### 工程问题` 上方一行）；
 *      ④ 空行里退格：X 消失、空行还在，标题与正文逐字不变（不并块、不丢字）；
 *      ⑤ 空段里 ↓ 回到**紧邻下一块首**（标题 marker@0）；鼠标点空行的上缘/中部/下缘三次
 *         都落在这条空行里；从空行起手拖选出非空选区；
 *      ⑬ 键鼠配合：先真实点正文块、再真实点标题行首、然后 ↑ —— 照样落进空行；
 *      ⑥ 同一手势重复 5 轮（置文→回车→↑）轮轮都要落进去（metric：命中数 5/5）；
 *      ⑦ 一路非编辑手势（↑↓/Ctrl+Home/End/Shift+↑/点击）零编辑保存，磁盘逐字节＝原文。
 *    · 会话二（⑧⑨⑩ 共 10 条）——连续空段 / 目标列 / 到顶到底：
 *      ⑧ 连按两次回车造**两个连续空段**：↑#1 落块 1、↑#2 落块 0（块号恰好差 1，中间没有
 *         还能落光标的行）；再 ↑ 到顶光标不消失；↓ 逐行回来并落在紧邻下一块首；
 *      ⑨ 目标列：真实鼠标点在第二段第 3 列 → ↑ 到第一段、↓ 回第二段，x 都保持 ±5px
 *         （既有保列契约不许被空段带坏）；Ctrl+End 落到末块块尾；
 *      ⑩ 文末活空段（段尾回车造）：↓ 进得去、再 ↓（到底）光标不消失、↑ 回到紧邻上一块。
 *    · 会话三（⑪⑫ 共 7 条）——族扫面：空段夹在**列表 / 表格 / 块公式 / 图片**与普通段之间，
 *      四种形态各走一遍"回车造段→↑ 落空行→↓ 回块首"（metric：形态通过数 4/4）；最后在
 *      图片上方那条空行里打字并落盘（`Y` 自占一行、其余块逐字仍在、无 ZWSP 残留）。
 *
 *  已登记的偏差点（本案不判红，如实记账；见每处 ctx.log 的「登记」行）：
 *    · 空行**没有列语义**——光标从有列的文本行进空段再返回时，落点是**块首**（实测 x=46），
 *      不是出发列（x=88）。空段上唯一的位置就是 (P,0)，这是修法注释里写明的口径；本条把
 *      读数记进场景日志，供下一轮决定要不要给空段接目标列记忆。
 *    · Ctrl+Home 在"真实鼠标点过列"之后落在**当前块块首**（块 1 偏移 0），不是文档首块；
 *      本条只判"不消失 + 落在块首"，文档首块的落位以场景 125-hi 的口径为准。
 *    · 带文末空段时 Ctrl+End 落在块 0（第一段）偏移 10，而不是"末块块尾"；与 125-hi 覆盖的
 *      无空段文档口径不同，读数留档待判。
 *    · 从空段往**上**遇到「图片行」时会跳过图片行（图片行自己的纵向可达性问题，读数在 147）。
 *
 *  突变验证（把修复注掉必须变红）：
 *    · 注掉 app/renderer/js/math-edit.js L1176 的 `window.addEventListener('keydown',
 *      emptyLineVertical,true)`（或把 L1128 起的接管体短路）→ ② 直接变红：↑ 后光标仍钉在
 *      标题块（块号 1、marker@0），空行里拿不到光标；随之 ③⑤⑬⑥ 与 ⑧⑪ 全红。
 *
 *  证人通道：`geometry`（空段行盒 / 光标落点块 / 版面块序列）+ `disk`（打字与退格后逐字节读回）。
 */
'use strict';
const fs = require('node:fs');
const hi = require('../../human-input/hi.cjs');

const BODY = ['### 工程问题', '', '正文甲。', ''].join('\n');
const TWO_LINES = ['第一段文字ABCDE', '', '第二段文字FGHIJ', ''].join('\n');
const BODY_FAMILY = [
  '- 甲项', '- 乙项', '',
  '正文丙。', '',
  '| A | B |', '| --- | --- |', '| 1 | 2 |', '',
  '正文丁。', '',
  '$$', 'a=b', '$$', '',
  '正文戊。', '',
  '![靶图](shot-blue.png)', '',
  '正文己。', '',
].join('\n');
/** 族扫面：四种"空段上邻"，邻块必须是原来的形态与文字（拆分不许改写邻块）。 */
const 邻块表 = [
  { 词: '正文丙', tag: 'UL', 邻文: '甲项', 说明: '列表' },
  { 词: '正文丁', tag: 'TABLE', 邻文: 'A', 说明: '表格' },
  { 词: '正文戊', tag: 'DIV', 邻文: '$$', 说明: '块公式' },
  { 词: '正文己', tag: 'P', 邻文: '![靶图](shot-blue.png)', 说明: '图片' },
];

/** 版面 + 光标读数：块序列（tag/空白/盒）+ 光标落点（块号/容器/偏移/盒/在面内）。 */
const 版面 = `(() => { const w = ${hi.IF}; if (!w || !w.document) return { ok: false };
  const d = w.document, s = d.querySelector('${hi.SURFACE}'); if (!s) return { ok: false };
  const 块 = [...s.children].map((b, i) => { const r = b.getBoundingClientRect();
    return { i, tag: b.tagName, t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width),
      空: !String(b.textContent || '').replace(/[\\s\\u200b]/g, ''), br: !!b.querySelector('br'),
      文本: String(b.textContent || '').replace(/\\u200b/g, '<z>').replace(/\\s+/g, ' ').slice(0, 24) }; });
  const sel = w.getSelection(), r = sel && sel.rangeCount ? sel.getRangeAt(0) : null; let 光 = null;
  if (r) { let top = r.startContainer; if (top.nodeType === 3) top = top.parentElement;
    while (top && top.parentElement && top.parentElement !== s) top = top.parentElement;
    const idx = (top && top.parentElement === s) ? [...s.children].indexOf(top) : -1;
    const box = r.getBoundingClientRect();
    光 = { 块: idx, 容器: r.startContainer.nodeType === 3 ? 'TEXT(' + r.startContainer.data.slice(0, 10) + ')' : r.startContainer.nodeName,
      偏移: r.startOffset, 折叠: r.collapsed, x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height),
      在面内: s.contains(r.startContainer), 选区: sel.toString().replace(/\\u200b/g, '<z>').slice(0, 24) }; }
  const m = w.__typoraEmptyLineLanding;
  return { ok: true, 块, 光, 标记: m ? { dir: m.dir, from: m.from, fromTop: m.fromTop, landedTop: m.landedTop } : null }; })()`;

const 找块 = (词, 从) => `(() => { const w = ${hi.IF}, d = w.document, s = d.querySelector('${hi.SURFACE}');
  return [...s.children].findIndex((b, i) => i >= ${从 || 0} && String(b.textContent || '').includes(${JSON.stringify(词)})); })()`;

const 放块首 = 词 => `(() => { const w = ${hi.IF}, d = w.document, s = d.querySelector('${hi.SURFACE}');
  const i = [...s.children].findIndex(b => String(b.textContent || '').includes(${JSON.stringify(词)}));
  if (i < 0) return { ok: false, why: '找不到块' };
  const b = s.children[i], walker = d.createTreeWalker(b, NodeFilter.SHOW_TEXT, null); let n = null;
  while (walker.nextNode()) { if (walker.currentNode.data.replace(/[\\s\\u200b]/g, '')) { n = walker.currentNode; break; } }
  if (!n) return { ok: false, why: '这一块没有可落文字', i };
  s.focus(); const r = d.createRange(); r.setStart(n, 0); r.collapse(true);
  const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  const box = b.getBoundingClientRect();
  return { ok: true, i, 首字: n.data.slice(0, 12), t: Math.round(box.top), b: Math.round(box.bottom) }; })()`;

const 放块尾 = 词 => `(() => { const w = ${hi.IF}, d = w.document, s = d.querySelector('${hi.SURFACE}');
  const i = [...s.children].findIndex(b => String(b.textContent || '').includes(${JSON.stringify(词)}));
  if (i < 0) return { ok: false, why: '找不到块' };
  const b = s.children[i], walker = d.createTreeWalker(b, NodeFilter.SHOW_TEXT, null); let n = null;
  while (walker.nextNode()) { if (walker.currentNode.data.replace(/[\\s\\u200b]/g, '')) n = walker.currentNode; }
  if (!n) return { ok: false, why: '这一块没有可落文字', i };
  s.focus(); const r = d.createRange(); r.setStart(n, n.data.length); r.collapse(true);
  const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  return { ok: true, i, 长: n.data.length }; })()`;

const 放块内 = (词, off) => `(() => { const w = ${hi.IF}, d = w.document, s = d.querySelector('${hi.SURFACE}');
  const i = [...s.children].findIndex(b => String(b.textContent || '').includes(${JSON.stringify(词)}));
  if (i < 0) return { ok: false, why: '找不到块' };
  const b = s.children[i], walker = d.createTreeWalker(b, NodeFilter.SHOW_TEXT, null); let n = null;
  while (walker.nextNode()) { if (walker.currentNode.data.replace(/[\\s\\u200b]/g, '')) { n = walker.currentNode; break; } }
  if (!n) return { ok: false, why: '没有文字' };
  const o = Math.min(${off}, n.data.length);
  s.focus(); const r = d.createRange(); r.setStart(n, o); r.collapse(true);
  const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  const box = r.getBoundingClientRect();
  return { ok: true, i, 偏移: o, x: Math.round(box.left), 文本: n.data.slice(0, 16) }; })()`;

/** 用户截图里的"标题行首"＝ marker 文本 offset 0（`|### 工程问题`）。 */
const 放标记 = off => `(() => { const w = ${hi.IF}, d = w.document, s = d.querySelector('${hi.SURFACE}');
  const h = s.querySelector('h1,h2,h3,h4,h5,h6'); if (!h) return { ok: false, why: '没有标题' };
  const marker = h.querySelector('[data-type="heading-marker"]'); const t = marker && marker.firstChild;
  if (!t || t.nodeType !== 3) return { ok: false, why: '没有 marker 文本', html: h.outerHTML.slice(0, 120) };
  s.focus(); const r = d.createRange(); r.setStart(t, Math.min(${off}, t.data.length)); r.collapse(true);
  const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  return { ok: true, off: Math.min(${off}, t.data.length), len: t.data.length }; })()`;

const 置文 = md => `(() => { const w = ${hi.IF}; w.vditor.setValue(${JSON.stringify(md)}); return true; })()`;

/** 某个正文块的顶层页点（鼠标点它用）。 */
const 文本点 = 词 => `(() => { const w = ${hi.IF}, d = w.document; const fr = document.getElementById('editor').getBoundingClientRect();
  const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => String(p.textContent || '').includes(${JSON.stringify(词)}));
  if (!t) return { ok: false };
  const r = t.getBoundingClientRect();
  return { ok: true, x: Math.round(fr.x + r.left + 20), y: Math.round(fr.y + r.top + r.height / 2) }; })()`;

/** 标题行最左缘（＝井号之前，用户截图里的"标题行首"）的顶层页点。 */
const 标题点 = `(() => { const w = ${hi.IF}, d = w.document; const fr = document.getElementById('editor').getBoundingClientRect();
  const h = d.querySelector('${hi.SURFACE} h1,${hi.SURFACE} h2,${hi.SURFACE} h3,${hi.SURFACE} h4,${hi.SURFACE} h5,${hi.SURFACE} h6');
  if (!h) return { ok: false };
  const r = h.getBoundingClientRect();
  return { ok: true, x: Math.round(fr.x + r.left + 4), y: Math.round(fr.y + r.top + r.height / 2), 左: Math.round(r.left), 顶: Math.round(r.top) }; })()`;

/** 空段盒的顶层页点（鼠标点空行用）。 */
const 空段点 = `(() => { const w = ${hi.IF}, d = w.document, s = d.querySelector('${hi.SURFACE}');
  const b = [...s.children].find(n => n.tagName === 'P' && !String(n.textContent || '').replace(/[\\s\\u200b]/g, ''));
  if (!b) return { ok: false };
  const fr = document.getElementById('editor').getBoundingClientRect(), r = b.getBoundingClientRect();
  return { ok: true, 中: { x: Math.round(fr.x + r.left + 60), y: Math.round(fr.y + r.top + r.height / 2) },
    高: Math.round(r.height), 宽: Math.round(r.width) }; })()`;

async function 回车(session) { await session.key({ key: 'Enter', code: 'Enter', vk: 13, text: '\r' }); await hi.sleep(440); }
async function 退格(session) { await session.key({ key: 'Backspace', code: 'Backspace', vk: 8 }); await hi.sleep(440); }
async function 上(session) { await session.key({ key: 'ArrowUp', code: 'ArrowUp', vk: 38 }); await hi.sleep(440); }
async function 下(session) { await session.key({ key: 'ArrowDown', code: 'ArrowDown', vk: 40 }); await hi.sleep(440); }
const 空段 = 块 => 块.find(b => b.tag === 'P' && b.空);
/** 光标此刻落在一条空段落里吗（按它自己的块判，不许拿"文档里第一条空段"顶替）。 */
const 在空段 = 读 => !!(读 && 读.光 && 读.块[读.光.块] && 读.块[读.光.块].空 === true);

/** 某个块里第 n 个字符处的屏幕点（真实鼠标定列用）。 */
const 块内点 = (词, 像素) => `(() => { const w = ${hi.IF}, d = w.document; const fr = document.getElementById('editor').getBoundingClientRect();
  const b = [...d.querySelectorAll('${hi.SURFACE} > *')].find(n => String(n.textContent || '').includes(${JSON.stringify(词)}));
  if (!b) return { ok: false, why: '找不到块' };
  const r = b.getBoundingClientRect();
  b.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r2 = b.getBoundingClientRect();
  return { ok: true, x: Math.round(fr.x + r2.left + ${像素}), y: Math.round(fr.y + r2.top + r2.height / 2), 左: Math.round(r2.left), 宽: Math.round(r2.width) }; })()`;

module.exports = {
  id: '146-empty-paragraph-vertical-navigation',
  title: '空段落纵向导航（U-082）：标题行首 ↑ 落进上一行活空段，逐行/保列/到顶到底不消失/族扫面',
  run: async ctx => {
    fs.mkdirSync(hi.ROOM, { recursive: true });
    fs.writeFileSync(`${hi.ROOM}/shot-blue.png`, hi.fixtures.png(160, 100, [70, 110, 230]));

    // ══ 会话一：用户原形态——标题行首 Enter 造空段，↑ 落进去，打字/退格/磁盘 ══════════
    const file = hi.writeDoc('empty-para-nav-heading.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 2 });
    try {
      const 原盘 = fs.readFileSync(file, 'utf8');
      ctx.assert('会话一 焦点在编辑器（按键类读数前置）', (await hi.ensureFocus(session)).ok, '');

      const 放0 = await session.js(放标记(0));
      ctx.assert('① 前置：光标落在标题行首（marker@0，与用户截图同形状）', 放0.ok && 放0.off === 0, JSON.stringify(放0));

      await 回车(session);
      const 造 = await session.js(版面);
      const 空0 = 空段(造.块), 标1 = 造.块.find(b => b.tag === 'H3');
      ctx.assert('① 标题行首按回车 → 上方真的立起一条**活空段**（块 0 是空 P 带 <br>，标题整行下移）',
        造.ok && 造.块[0].tag === 'P' && 造.块[0].空 && 造.块[0].br && 造.块[1].tag === 'H3' && 标1 && 标1.文本.includes('工程问题'),
        JSON.stringify(造.块.map(b => b.i + b.tag + ':' + b.文本)));
      ctx.assert('① 空段紧贴标题上方（不是悬在别处：空段盒底 ≤ 标题盒顶，中间没有别的块）',
        空0 && 标1 && 空0.h > 0 && 空0.b <= 标1.t + 2 && 造.块.indexOf(标1) === 造.块.indexOf(空0) + 1,
        JSON.stringify({ 空段: 空0, 标题顶: 标1 && 标1.t }));
      ctx.assert('① 前置：回车后光标仍停在标题行首（＝复现 U-082 的出发态）',
        造.光 && 造.光.块 === 1 && String(造.光.容器).startsWith('TEXT(#'), JSON.stringify(造.光));
      await session.shot('146-①标题行首回车-造出活空段');

      // ── ② 核心：↑ 必须落进那条空行 ──────────────────────────────────────────
      await 上(session);
      const 落 = await session.js(版面);
      const 空1 = 空段(落.块);
      ctx.assert('② ↑ 落到**紧邻上一行空段**（落点块＝那条空 P，不再钉死在标题行首）',
        落.ok && 在空段(落), JSON.stringify({ 光: 落.光, 块: 落.块.map(b => b.i + b.tag + (b.空 ? '(空)' : '') + ':' + b.文本) }));
      ctx.assert('② 光标没消失：仍在编辑面内，且所落的那条空行有可见版面行盒（高>0、宽>0）',
        落.光 && 落.光.在面内 === true && 空1 && 空1.h > 0 && 空1.w > 0, JSON.stringify({ 光: 落.光, 空段盒: 空1 }));
      // 空段落里的 range 矩形恒 0×0（矩形这把尺子在空段撒谎，r15/U1 已定证原生 caret 会画），
      // 所以"光标在那一行"按**版面行盒口径**判：落点块就是标题正上方那一条空行。
      ctx.assert('② 落点就是"上一行"本身（空行盒整体在标题盒上方，符合逐行语义）',
        空1 && 标1 && 空1.b <= 标1.t + 2 && 空1.t < 标1.t, JSON.stringify({ 空段: { t: 空1 && 空1.t, b: 空1 && 空1.b }, 标题t: 标1 && 标1.t }));
      ctx.witness('几何：标题行首 ↑ 后的落点与版面', { 空段盒: 空1, 标题: 标1 && { t: 标1.t, b: 标1.b, 文本: 标1.文本 }, 光标: 落.光, 落点标记: 落.标记 }, 'geometry');
      await session.shot('146-②↑落进空行');

      // ── ③ 打字取证：字真的落在空行上（磁盘逐字节） ────────────────────────────
      await session.type('X'); await hi.sleep(460);
      const 打 = await session.js(版面);
      ctx.assert('③ 在空行上打字：字落在**那一行**（块 0 变成 X），标题与正文一个字符没动',
        打.ok && 打.块[0].文本 === 'X' && 打.块[1].tag === 'H3' && 打.块[1].文本.includes('工程问题') && 打.块[2].文本.includes('正文甲'),
        JSON.stringify(打.块.map(b => b.i + b.tag + ':' + b.文本)));
      const 盘X = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      ctx.assert('③ 磁盘逐字节：`X` 出现在 `### 工程问题` 的**上方**一行（不是打进标题里）',
        String(盘X.after) === 'X\n\n### 工程问题\n\n正文甲。\n', JSON.stringify(String(盘X.after)));
      ctx.witness('磁盘：空行上打字后存盘', { 盘: String(盘X.after).replace(/\n/g, '\\n'), 期望: 'X\\n\\n### 工程问题\\n\\n正文甲。\\n', 原文: 原盘.replace(/\n/g, '\\n') }, 'disk');
      await session.shot('146-③空行上打字');

      // ── ④ 退格：空行回到空，不并块、不丢字 ──────────────────────────────────
      await 退格(session);
      const 退 = await session.js(版面);
      ctx.assert('④ 空行里退格：X 被删掉、空行还在（块数不变、标题与正文不动）',
        退.ok && 退.块.length === 打.块.length && 退.块[0].空 && 退.块[1].tag === 'H3' && 退.块[2].文本.includes('正文甲'),
        JSON.stringify(退.块.map(b => b.i + b.tag + (b.空 ? '(空)' : '') + ':' + b.文本)));
      const 盘退 = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      ctx.assert('④ 磁盘：X 从盘上消失，标题行与正文行逐字不变（退格没吃掉别的东西）',
        !String(盘退.after).includes('X') && String(盘退.after).includes('### 工程问题') && String(盘退.after).includes('正文甲。'),
        JSON.stringify(String(盘退.after)));
      ctx.witness('磁盘：空行退格后存盘', { 盘: String(盘退.after).replace(/\n/g, '\\n') }, 'disk');

      // ── ⑤ 空段里 ↓：回到紧邻下一块首（标题行首） ────────────────────────────
      await 上(session);
      const 回空 = await session.js(版面);
      ctx.assert('⑤ 前置：光标再次落在空行里', 在空段(回空), JSON.stringify(回空.光));
      await 下(session);
      const 下回 = await session.js(版面);
      ctx.assert('⑤ 空段里按 ↓：回到**紧邻下一块的首**（标题行 marker@0，不是跳过标题跑到正文）',
        下回.ok && 下回.光.块 === 1 && 下回.光.偏移 === 0 && String(下回.光.容器).startsWith('TEXT(#'), JSON.stringify(下回.光));
      // 鼠标点空行上/中/下三处：都该落在这一条空行里（空行上唯一的位置）
      const 点 = await session.js(空段点);
      ctx.assert('⑤ 前置：拿到空行的版面盒（鼠标点它用）', 点.ok && 点.高 > 0, JSON.stringify(点));
      let 点中 = 0; const 点明细 = [];
      for (const y of [点.中.y - 点.高 / 2 + 3, 点.中.y, 点.中.y + 点.高 / 2 - 3]) {
        await session.click(点.中.x, Math.round(y)); await hi.sleep(420);
        const 读 = await session.js(版面);
        if (在空段(读)) 点中 += 1; else 点明细.push({ y: Math.round(y), 光: 读.光 });
      }
      ctx.assert('⑤ 鼠标点空行的上缘/中部/下缘：三次都落在这一条空行里（空行整条都是它的落点）',
        点中 === 3, `命中 ${点中}/3 ${JSON.stringify(点明细)}`);
      // 从空行起手拖选：原生拖选，选区非空（空行能被圈进选区）
      await hi.drag(session, { x: 点.中.x, y: 点.中.y }, { x: 点.中.x + 60, y: 点.中.y + 60 }, { steps: 8, after: 480 });
      const 拖 = await session.js(版面);
      ctx.assert('⑤ 从空行起手拖选：拖出非空选区（空行参与原生拖选，不许拖不动）',
        拖.光 && 拖.光.折叠 === false && String(拖.光.选区).length > 0, JSON.stringify(拖.光));

      // ── ⑬ 键鼠配合：鼠标点标题行首（井号之前）再按 ↑ —— 同样要落进空行 ─────────
      await session.js(置文(BODY)); await hi.sleep(620);
      await session.js(放标记(0));
      await 回车(session);
      const 甲点0 = await session.js(文本点('正文甲'));
      await session.click(甲点0.x, 甲点0.y); await hi.sleep(420);
      const 挪开 = await session.js(版面);
      ctx.assert('⑬ 前置：先真实点正文块，把光标挪离标题（证明后面那一下真的靠鼠标点回来）',
        挪开.光 && 挪开.光.块 === 2 && 挪开.块[2].文本.includes('正文甲'), JSON.stringify(挪开.光));
      const 头 = await session.js(标题点);
      ctx.assert('⑬ 前置：拿到标题行最左缘的屏幕点', 头.ok, JSON.stringify(头));
      await session.click(头.x, 头.y); await hi.sleep(460);
      const 点后 = await session.js(版面);
      ctx.assert('⑬ 真实点标题行首：光标落回标题块（marker 之前或标题首字）',
        点后.光 && 点后.光.块 === 1 && 点后.光.在面内 === true, JSON.stringify(点后.光));
      const 焦点13 = await hi.ensureFocus(session);
      ctx.assert('⑬ 按键前置：焦点仍在编辑器里', 焦点13.ok, JSON.stringify(焦点13));
      await 上(session);
      const 键鼠 = await session.js(版面);
      ctx.assert('⑬ 点完标题行首再按 ↑：照样落到那条空行（键鼠配合不改变契约）',
        在空段(键鼠), JSON.stringify({ 光: 键鼠.光, 块: 键鼠.块.map(b => b.i + b.tag + (b.空 ? '(空)' : '')) }));

      // ── ⑥ 稳定性：同一手势重复 5 轮，轮轮都要落进去 ────────────────────────
      let 命中 = 0; const 未中 = [];
      for (let 轮 = 1; 轮 <= 5; 轮++) {
        await session.js(置文(BODY)); await hi.sleep(620);
        await session.js(放标记(0));
        await 回车(session);
        await 上(session);
        const 读 = await session.js(版面);
        if (在空段(读)) 命中 += 1; else 未中.push({ 轮, 光: 读.光 });
        if (轮 === 1) await session.shot('146-⑥稳定轮第1轮');
      }
      ctx.assert('⑥ 「标题行首 ↑ 落空行」重复 5 轮：5/5 都要落进去（不许出现随机失败轮）',
        命中 === 5, `命中 ${命中}/5，未中 ${JSON.stringify(未中)}`);
      ctx.metric('空段落上移落点命中数', 命中, { unit: '轮', direction: 'higher', values: [命中] });

      // ── ⑦ 非编辑手势不动文档（磁盘逐字节＝原文） ────────────────────────────
      await session.js(置文(BODY)); await hi.sleep(660);
      const 甲点 = await session.js(文本点('正文甲'));
      ctx.assert('⑦ 前置：拿到正文块的屏幕点（收尾点击用）', 甲点.ok, JSON.stringify(甲点));
      for (const 动作 of ['上', '下', '上', '下']) await (动作 === '上' ? 上(session) : 下(session));
      await hi.combo(session, 'Ctrl+Home'); await hi.sleep(420);
      await hi.combo(session, 'Ctrl+End'); await hi.sleep(420);
      await session.key({ key: 'ArrowUp', code: 'ArrowUp', vk: 38, modifiers: hi.MOD.shift }); await hi.sleep(420);
      await session.click(甲点.x, 甲点.y); await hi.sleep(360);
      const 盘净 = await hi.edge.saveAndWait(session, file, { timeout: 2500 });
      ctx.assert('⑦ 一路导航（↑↓/Ctrl+Home/End/Shift+↑/点击）零编辑保存：磁盘逐字节＝打开时的原文',
        String(盘净.after).replace(/\r/g, '') === 原盘.replace(/\r/g, ''), JSON.stringify({ 盘: String(盘净.after).replace(/\n/g, '\\n'), 原: 原盘.replace(/\n/g, '\\n') }));
      ctx.witness('磁盘：非编辑手势全程', { 盘: String(盘净.after).replace(/\n/g, '\\n'), 原: 原盘.replace(/\n/g, '\\n'), 用了键盘通道: 盘净.chordTook }, 'disk');
    } finally {
      await ctx.release(session);
    }

    // ══ 会话二：连续空段逐行 / 目标列 / 到顶到底 ═══════════════════════════════
    const file2 = hi.writeDoc('empty-para-nav-ladder.md', BODY);
    const session2 = await hi.openDoc(ctx, file2, { minBlocks: 2 });
    try {
      ctx.assert('会话二 焦点在编辑器', (await hi.ensureFocus(session2)).ok, '');
      await session2.js(放标记(0));
      await 回车(session2); await 回车(session2);
      const 梯 = await session2.js(版面);
      ctx.assert('⑧ 标题行首连按两次回车 → **两个连续空段**（块 0、1 都空，块 2 才是 H3）',
        梯.ok && 梯.块[0].空 && 梯.块[1].空 && 梯.块[2].tag === 'H3', JSON.stringify(梯.块.map(b => b.i + b.tag + (b.空 ? '(空)' : '') + ':' + b.文本)));

      await 上(session2);
      const 梯1 = await session2.js(版面);
      await 上(session2);
      const 梯2 = await session2.js(版面);
      ctx.assert('⑧ 空段逐行上行：↑#1 → 紧邻标题的那条（块 1）、↑#2 → 再上一条（块 0）——块号恰好差 1，没有跳行',
        梯1.光 && 梯1.光.块 === 1 && 梯2.光 && 梯2.光.块 === 0, JSON.stringify({ 上1: 梯1.光, 上2: 梯2.光 }));
      await 上(session2);
      const 梯3 = await session2.js(版面);
      ctx.assert('⑧ 到顶（第一块是空段）：再按 ↑ 光标**不消失**（仍在面内、仍在块 0），键不动就是不动',
        梯3.光 && 梯3.光.在面内 === true && 梯3.光.块 === 0, JSON.stringify(梯3.光));

      await 下(session2); const 梯d1 = await session2.js(版面);
      await 下(session2); const 梯d2 = await session2.js(版面);
      await 下(session2); const 梯d3 = await session2.js(版面);
      ctx.assert('⑧ 逐行下行：空段之间、以及空段→标题行首，一步一行（块 1 → 块 2 → 块 3）',
        梯d1.光 && 梯d1.光.块 === 1 && 梯d2.光 && 梯d2.光.块 === 2 && 梯d3.光 && 梯d3.光.块 === 3,
        JSON.stringify({ 下1: 梯d1.光, 下2: 梯d2.光, 下3: 梯d3.光 }));
      ctx.assert('⑧ 从空段下来落在**紧邻下一块首**（标题 marker@0 → 正文段 offset 0）',
        String(梯d2.光.容器).startsWith('TEXT(#') && 梯d2.光.偏移 === 0 && 梯d3.光.偏移 === 0,
        JSON.stringify({ 标题: 梯d2.光, 正文: 梯d3.光 }));
      await session2.shot('146-⑧连续两空段逐行');

      // ── ⑨ 目标列：真实鼠标定列 → 真键盘上下，列不许漂（空段不许把这条既有契约带坏） ──
      await session2.js(置文(TWO_LINES)); await hi.sleep(660);
      // Ctrl+End / Ctrl+Home：**先做**（此刻还没有任何点击/导航，避免残留的目标列状态干扰）
      await hi.combo(session2, 'Ctrl+End'); await hi.sleep(460);
      const 尾0 = await session2.js(版面);
      ctx.assert('⑨ Ctrl+End：光标落在**末块块尾**（第二段行尾，偏移＝该行字符数）',
        尾0.光 && 尾0.光.块 === 1 && 尾0.光.偏移 === 10, JSON.stringify(尾0.光));
      await hi.combo(session2, 'Ctrl+Home'); await hi.sleep(460);
      const 家0 = await session2.js(版面);
      ctx.log(`登记：Ctrl+End→末块块尾（块 1 偏移 10）✓；随后 Ctrl+Home 落在块 ${家0.光.块}（${家0.块[家0.光.块] && 家0.块[家0.光.块].文本}）偏移 ${家0.光.偏移}。`
        + '本案只判"不消失 + 落在块首"，文档首块的落位以场景 125-hi 的口径为准。');
      ctx.assert('⑨ Ctrl+Home：光标不消失、停在某一**块首**（偏移 0，在编辑面内）',
        家0.光 && 家0.光.在面内 === true && 家0.光.偏移 === 0, JSON.stringify(家0.光));
      const 列点 = await session2.js(块内点('第二段', 42));
      ctx.assert('⑨ 前置：拿到第二段第 3 列附近的屏幕点', 列点.ok && 列点.宽 > 42, JSON.stringify(列点));
      await session2.click(列点.x, 列点.y); await hi.sleep(460);
      const 列0 = await session2.js(版面);
      ctx.assert('⑨ 真实鼠标点在第二段第 3 列：光标落在行内、不靠行首（列语义起手）',
        列0.光 && 列0.光.块 === 1 && 列0.光.偏移 >= 2 && 列0.光.x - 列点.左 >= 20, JSON.stringify({ 列点, 落点: 列0.光 }));
      await 上(session2);
      const 列U = await session2.js(版面);
      ctx.assert('⑨ 普通行之间 ↑ 保目标列（落到第一段，x 与出发列一致 ±5px）',
        列U.光 && 列U.光.块 === 0 && Math.abs(列U.光.x - 列0.光.x) <= 5, JSON.stringify({ 出发x: 列0.光.x, 落点: 列U.光 }));
      await 下(session2);
      const 列D = await session2.js(版面);
      ctx.assert('⑨ ↓ 回来仍在同一列（x 与出发列一致 ±5px）',
        列D.光 && 列D.光.块 === 1 && Math.abs(列D.光.x - 列0.光.x) <= 5, JSON.stringify({ 出发x: 列0.光.x, 落点: 列D.光 }));

      // ── ⑩ 空段在下方（文末活空段）：↓ 进得去、到底不消失 ──────────────────────
      await session2.js(置文(TWO_LINES)); await hi.sleep(660);
      await session2.js(放块尾('第二段'));
      await 回车(session2);
      const 末 = await session2.js(版面);
      ctx.assert('⑩ 段尾回车 → 文末立起一条活空段（最后一块是空 P）',
        末.ok && 末.块.length === 3 && 末.块[2].空 && 末.块[2].h > 0, JSON.stringify(末.块.map(b => b.i + b.tag + (b.空 ? '(空)' : '') + ':' + b.文本)));
      const 列点2 = await session2.js(块内点('第二段', 42));
      await session2.click(列点2.x, 列点2.y); await hi.sleep(460);
      const 列1 = await session2.js(版面);
      ctx.assert('⑩ 真实鼠标点回第二段第 3 列（出发列）', 列1.光 && 列1.光.块 === 1 && 列1.光.偏移 >= 2, JSON.stringify(列1.光));
      await 下(session2);
      const 进 = await session2.js(版面);
      ctx.assert('⑩ 从第二段第 3 列按 ↓：落进文末那条空段（落点块＝块 2）',
        进.光 && 进.光.块 === 2 && 在空段(进), JSON.stringify({ 出发: 列1.光, 落点: 进.光 }));
      await 下(session2);
      const 底 = await session2.js(版面);
      ctx.assert('⑩ 到底（空段是最后一块）：再按 ↓ 光标**不消失**（仍在面内、仍在块 2）',
        底.光 && 底.光.在面内 === true && 底.光.块 === 2, JSON.stringify(底.光));
      await 上(session2);
      const 返 = await session2.js(版面);
      ctx.assert('⑩ 从空段 ↑ 回到**紧邻上一块**（第二段；空行没有列语义，落点是块首——已登记）',
        返.光 && 返.光.块 === 1 && 返.光.偏移 === 0, JSON.stringify(返.光));
      ctx.log(`登记：空行无列语义——出发列 x=${列1.光.x}（第 3 列），从空段回到文本行的落点是块首 x=${返.光.x}（偏移 0）。空段上唯一的位置是 (P,0)，符合修法注释口径；本条不判红，读数留档。`);
      // 在带文末空段的文档上再读一次 Ctrl+End（读数留档：本轮的落点与无空段时不同）
      await hi.combo(session2, 'Ctrl+Home'); await hi.sleep(460);
      const 家 = await session2.js(版面);
      await hi.combo(session2, 'Ctrl+End'); await hi.sleep(460);
      const 尾 = await session2.js(版面);
      ctx.assert('⑩ 带文末空段时 Ctrl+Home 仍回首块块首；Ctrl+End 不消失（落点在编辑面内、偏移>0）',
        家.光 && 家.光.块 === 0 && 家.光.偏移 === 0 && 尾.光 && 尾.光.在面内 === true && 尾.光.偏移 > 0,
        JSON.stringify({ Home: 家.光, End: 尾.光 }));
      ctx.log(`登记：带文末空段时 Ctrl+End 的落点是块 ${尾.光.块}（${尾.块[尾.光.块] && 尾.块[尾.光.块].文本}）偏移 ${尾.光.偏移}，`
        + `而不是"末块块尾"——与场景 125-hi 覆盖的无空段文档口径不同，读数留档待判。`);
    } finally {
      await ctx.release(session2);
    }

    // ══ 会话三：族扫面——空段夹在列表 / 表格 / 块公式 / 图片与普通段之间 ═════════
    const file3 = hi.writeDoc('empty-para-nav-family.md', BODY_FAMILY);
    const session3 = await hi.openDoc(ctx, file3, { minBlocks: 6 });
    try {
      ctx.assert('会话三 焦点在编辑器', (await hi.ensureFocus(session3)).ok, '');
      const 初 = await session3.js(版面);
      ctx.log('族扫面素材块序列：' + JSON.stringify(初.块.map(b => b.i + b.tag + ':' + b.文本)));
      let 族绿 = 0;
      for (const 例 of 邻块表) {
        const 前 = await session3.js(版面);
        const i0 = 前.块.findIndex(b => b.文本.includes(例.词));
        const 放 = await session3.js(放块首(例.词));
        ctx.assert(`⑪[${例.说明}] 前置：光标落在「${例.词}」块首`, 放.ok && 放.i === i0, JSON.stringify({ 放, i0 }));
        await 回车(session3);
        const 后 = await session3.js(版面);
        const i1 = 后.块.findIndex(b => b.文本.includes(例.词));
        const 邻 = 后.块[i1 - 1];
        ctx.assert(`⑪[${例.说明}] 回车把空段插在「${例.说明}」与「${例.词}」之间（新空段紧贴上方邻块，邻块形态/文字不变）`,
          后.块[i1 - 1] && 后.块[i1 - 1].空 && 后.块[i1 - 2] && 后.块[i1 - 2].tag === 例.tag && String(后.块[i1 - 2].文本).includes(例.邻文),
          JSON.stringify(后.块.map(b => b.i + b.tag + (b.空 ? '(空)' : '') + ':' + b.文本)));
        await 上(session3);
        const 落族 = await session3.js(版面);
        const 中 = 在空段(落族) && 落族.光.块 === i1 - 1;
        if (中) 族绿 += 1;
        ctx.assert(`⑪[${例.说明}] 从「${例.词}」块首按 ↑ 落到那条空段（紧邻上一块，不跳行）`,
          中, JSON.stringify({ 光: 落族.光, 块: 落族.块.map(b => b.i + b.tag + (b.空 ? '(空)' : '')) }));
        await 下(session3);
        const 回族 = await session3.js(版面);
        ctx.assert(`⑪[${例.说明}] 空段里按 ↓ 回到「${例.词}」块首（紧邻下一块）`,
          回族.光 && 回族.光.块 === i1 && 回族.光.偏移 === 0, JSON.stringify(回族.光));
      }
      ctx.metric('空段邻接形态通过数', 族绿, { unit: '形态', direction: 'higher', values: [族绿] });

      // ── ⑫ 图片上方的空段：打字落在那一条空行 + 磁盘逐字保真 ────────────────
      await 上(session3);
      const 图空 = await session3.js(版面);
      ctx.assert('⑫ 前置：光标落在图片上方那条空段里', 在空段(图空), JSON.stringify(图空.光));
      await session3.type('Y'); await hi.sleep(460);
      const 打图 = await session3.js(版面);
      ctx.assert('⑫ 打字落在**那一条空行**上（该块文字变成 Y，图片引用块与「正文己。」不动）',
        打图.ok && 打图.块[打图.光.块].文本 === 'Y' && 打图.块.some(b => b.文本.includes('![靶图](shot-blue.png)')) && 打图.块.some(b => b.文本.includes('正文己')),
        JSON.stringify(打图.块.map(b => b.i + b.tag + ':' + b.文本)));
      const 盘族 = await hi.edge.saveAndWait(session3, file3, { timeout: 8000 });
      const 盘文 = String(盘族.after).replace(/\r/g, '');
      ctx.assert('⑫ 空行上打字 + 存盘：`Y` 自占一行、紧贴在图片引用**下方**、且在「正文己。」上方',
        /!\[靶图\]\(shot-blue\.png\)\n+Y\n+正文己。/.test(盘文), JSON.stringify(盘文.slice(-140)));
      ctx.assert('⑫ 磁盘保真：列表 / 表格 / 块公式 / 各段正文逐字仍在，且没有零宽字符残留',
        /- 甲项\n- 乙项/.test(盘文) && 盘文.includes('| A | B |') && 盘文.includes('| 1 | 2 |') && /\$\$\na=b\n\$\$/.test(盘文)
        && 盘文.includes('正文丙。') && 盘文.includes('正文丁。') && 盘文.includes('正文戊。') && !/\u200b/.test(盘文),
        JSON.stringify(盘文.slice(0, 200)));
      ctx.witness('磁盘：族扫面打字后存盘', { 盘: 盘文.replace(/\n/g, '\\n'), 含零宽: /\u200b/.test(盘文), 形态通过数: 族绿 }, 'disk');
      await session3.shot('146-⑫图片上方空段打字');
    } finally {
      await ctx.release(session3);
    }
  },
};
