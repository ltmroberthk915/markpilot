/** 138 · 图片交互：连点必展开 + 点图片右侧空白落"图片之后"（回车新起一行）
 *
 *  用户 2026-10-02 报的两条（图片是 **Windows 截图后 Ctrl+V 粘进文档**的，粘贴落成
 *  Markdown 图；正文里直接写 `<img …>` 的裸 HTML 图块另算一种）：
 *   ① "点击图片高频率点击有概率触发无法展开源码"。根因：vditor 的 B()（index.min.js
 *      1:83237）每次点击先把全文档的 `vditor-ir__node--expand` 摘干净，再看"当前 range
 *      的 startContainer 在不在某个 vditor-ir__node 里"重加；连点第 2 下展开后布局位移，
 *      第 3 下常落到节点外的空白上 → 展开被摘掉不再重加。**连点次数是奇是偶决定成败**
 *      （实测修复前：连点 3/5 次=折叠，2/4 次=展开）。判据：连点 2/3/4 次终态都必须展开。
 *   ② "图片右侧空白点击后，逻辑应该是插入一个图片之后的光标；回车创建新一行。目前没有
 *      这个能力"（文档以图片结尾时尤其缺）。修复前实测三种坏相：落点有时在图片**前面**、
 *      裸 HTML 图块点右侧空白把光标塞进隐藏源码的 offset 0（打字打进 `<img>` 标签里）、
 *      全栏宽粘贴图点右下空白时光标落到编辑器外（打字直接丢）。判据：落点必须"在图片
 *      之后"，且回车+打字后新行出现在图片下方、图片引用逐字不变（磁盘证人）。
 *
 *  护栏（不许改坏的既有语义）：
 *    · 单击图片=选中（`typora-img-selected`），点它 1 次不许展开；
 *    · 从图片右侧空白带**起手拖选**仍是原生拖选（选区非空、文档零改动）；
 *    · Alt+单击=展开源码（文档里的老手势），光标进源码。
 *
 *  突变验证（把修复注掉必须变红）：
 *    · 注掉 media-tools.js 里 `document.addEventListener('click', ...)` 的
 *      `event.altKey||event.detail>=2` 那一支 → ① 的连点 3 次/4 次断言变红；
 *    · 注掉 `mouseup` 里的 `落到图片之后(...)` → ② 的"落点在图片之后"与磁盘断言变红；
 *    · 注掉 立零宽锚 里的 `owner.after(z)` 行（收束轮1）→ ③ 的"锚=ZWSP 文本位"断言
 *      变红（选区落回隐藏源码/裸位，无锚可读）。
 *
 *  证人：几何（点击前后落点）+ 磁盘（②③ 打字后逐字节读回；④ 拖选后与原文相同）。
 */
'use strict';
const fs = require('node:fs');
const hi = require('../../human-input/hi.cjs');

const BODY = ['# 图P', '', '前文甲。', '', '![靶图](shot-blue.png)', '', '后文乙。', ''].join('\n');
const BODY_HTML = ['# 图H', '', '前文甲。', '', '<img src="shot-blue.png" alt="html图" width="160">', ''].join('\n');

/** 图片几何（页面坐标）+ 关键点。取文档里最后一张图。 */
const 几何 = `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop(); if (!img) return { ok: false };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = img.getBoundingClientRect();
  const owner = img.closest('.vditor-ir__node[data-type]');
  return { ok: true, 中心: { x: Math.round(frame.x + r.left + r.width / 2), y: Math.round(frame.y + r.top + r.height / 2) },
    右外30: { x: Math.round(frame.x + r.right + 30), y: Math.round(frame.y + r.top + r.height / 2) },
    右缘: Math.round(frame.x + r.right), 图盒: { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) },
    展开: !!owner && owner.classList.contains('vditor-ir__node--expand'),
    选中: !!img.classList.contains('typora-img-selected'), 类型: owner ? owner.getAttribute('data-type') : null }; })()`;

/** 落点读数：是否在图片节点内 / 在图片之前还是之后（用 Range.compareBoundaryPoints 判文档序）/ 层。 */
const 读落点 = `(() => { const w = ${hi.IF}, d = w.document; const sel = w.getSelection(); const s = d.querySelector('${hi.SURFACE}');
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop();
  const owner = img && img.closest('.vditor-ir__node[data-type]');
  const 展开 = !!owner && owner.classList.contains('vditor-ir__node--expand');
  if (!sel || !sel.rangeCount) return { 选区: null, 展开 };
  const r = sel.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const 层 = !at || !s.contains(at) ? '外' : (at.closest('code[data-type]') ? '源码' : at.closest('.vditor-ir__preview') ? '岛' : '正文');
  let 位置 = null;
  if (owner) { const 环绕 = d.createRange(); 环绕.setStartBefore(owner); 环绕.setEndAfter(owner);
    const 标 = d.createRange(); 标.setStart(r.startContainer, r.startOffset); 标.collapse(true);
    位置 = 标.compareBoundaryPoints(Range.START_TO_END, 环绕) >= 0 ? '后' : '前/内'; }
  const 源 = owner && owner.querySelector('code[data-type]');
  const 源文本 = 源 && [...源.childNodes].find(node => node.nodeType === 3) || null;
  return { 展开, 层, 在节点内: !!(at && owner && owner.contains(at)), 位置, 折叠: r.collapsed,
    容器: r.startContainer.nodeType === 3 ? 'TEXT(' + r.startContainer.data.length + ')' : r.startContainer.nodeName, 偏移: r.startOffset,
    源码末尾: !!(源文本 && r.startContainer === 源文本 && r.startOffset === 源文本.data.length) }; })()`;

/** 收束轮1（2026-10-02，取消双重光标）零宽锚读数：锚=紧随图片节点的 \u200b 文本节点 +
 *  选区落在 z@0（折叠 + 边界点同点）+ 原生光标可见（rect h>0）。合成光标
 *  （.typora-image-after-caret）结构性不存在。读数必须经 IF 进编辑器 iframe document
 *  （V2 教训 5.2-5：查顶层 document 永远查不到）。 */
const 读零宽锚 = `(() => { const w = ${hi.IF}, d = w.document; const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop();
  const owner = img && img.closest('.vditor-ir__node[data-type]');
  const nx = owner && owner.nextSibling;
  const z = nx && nx.nodeType === 3 && nx.data.length === 1 && nx.data.charCodeAt(0) === 0x200b ? nx : null;
  const sel = w.getSelection(); const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  let 落锚 = false;
  if (z && r) { try { const a = d.createRange(); a.setStart(z, 0); a.collapse(true);
    落锚 = r.collapsed && r.compareBoundaryPoints(Range.START_TO_START, a) === 0; } catch (e) {} }
  const b = r ? r.getBoundingClientRect() : null;
  const pe = r && r.startContainer.nodeType === 3 ? r.startContainer.parentElement : null;
  const 锚容器文本 = !!(r && r.startContainer.nodeType === 3 && pe && (pe.offsetParent !== null || pe.getClientRects().length));
  return { ok: !!(z && 落锚 && ((b && b.height > 0) || 锚容器文本)), 有锚: !!z, 落锚,
    原生高: b ? Math.round(b.height) : null, 容器: r ? (r.startContainer.nodeType === 3 ? 'TEXT(' + r.startContainer.data.length + ')' : r.startContainer.nodeName) : null }; })()`;

const 文本点 = 词 => `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('${词}'));
  if (!t) return { ok: false };
  const r = t.getBoundingClientRect(); return { ok: true, x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;

/** 连点：n 次真实鼠标点击，间隔 50ms，clickCount 递增（与真人连点一致）。 */
async function 连点(session, 点, 次数) {
  for (let i = 1; i <= 次数; i++) {
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 点.x, y: 点.y, button: 'left', buttons: 1, clickCount: i });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 点.x, y: 点.y, button: 'left', buttons: 0, clickCount: i });
    if (i < 次数) await hi.sleep(50);
  }
  await hi.sleep(380);
}
async function 回车(session) { await session.key({ key: 'Enter', code: 'Enter', vk: 13, text: '\r' }); await hi.sleep(380); }

module.exports = {
  id: '138-image-click-and-blank-band',
  title: '图片：连点必展开源码；点图片右侧空白落"图片之后"、回车新起一行（含裸 HTML 图块）',
  run: async ctx => {
    fs.mkdirSync(hi.ROOM, { recursive: true });
    fs.writeFileSync(`${hi.ROOM}/shot-blue.png`, hi.fixtures.png(160, 100, [70, 110, 230]));

    // ══ 会话一：Markdown 图（截图粘贴落成的形态） ═════════════════════════════════
    const file = hi.writeDoc('image-click-family.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 4 });
    try {
      ctx.assert('会话一 焦点在编辑器', (await hi.ensureFocus(session)).ok, '');
      const 文 = await session.js(文本点('前文甲'));
      ctx.assert('会话一 拿到正文落点（前置）', 文.ok, JSON.stringify(文));

      // ── ① 单击=选中，连点 2/3/4 次=展开（不许被奇偶决定） ──────────────────────
      let g = await session.js(几何);
      ctx.assert('① 前置：拿到图片几何', g.ok, JSON.stringify(g));
      await hi.ensureFocus(session);
      await session.click(文.x, 文.y); await hi.sleep(320);          // 复位：点正文 → 展开态被 vditor 清掉
      await session.click(g.中心.x, g.中心.y); await hi.sleep(320);
      const 一 = await session.js(几何);
      ctx.assert('① 单击图片 1 次：只选中、不展开',
        !一.展开 && 一.选中, JSON.stringify(一));
      for (const 次数 of [2, 3, 4]) {
        await session.click(文.x, 文.y); await hi.sleep(280);
        const 复位 = await session.js(几何);
        ctx.assert(`① 连点 ${次数} 次 前置：复位后是折叠态`, !复位.展开, JSON.stringify(复位));
        await 连点(session, g.中心, 次数);
        const s = await session.js(读落点);
        ctx.assert(`① 连点 ${次数} 次：源码必须展开（不许被次数奇偶决定）`, s.展开 === true, JSON.stringify(s));
        // md 图的源码是节点里那串 marker（不是 <code>），所以判"在节点内或图片之后"——
        // 连点的第 3 下会落在"图片独占那一段的空白"上，我们把它收在图片之后，同样是合法的终态。
        ctx.assert(`① 连点 ${次数} 次：光标在图片源码里或图片之后（不许停在图片前面）`,
          s.在节点内 === true || s.位置 === '后', JSON.stringify(s));
      }
      ctx.witness('几何：单击/连点 2·3·4 次后的展开态', { 单击: 一 }, 'geometry');

      // ── ② 点图片右侧空白 → 光标在"图片之后" → 回车 → 打字 → 新行在图片下方 ──────
      await session.click(文.x, 文.y); await hi.sleep(300);
      const g2 = await session.js(几何);
      ctx.assert('② 前置：图片处于折叠态', !g2.展开, JSON.stringify(g2));
      await session.click(g2.右外30.x, g2.右外30.y); await hi.sleep(420);
      const 落2 = await session.js(读落点);
      ctx.assert('② 点图片右侧空白：光标不在图片节点内', 落2.在节点内 === false, JSON.stringify(落2));
      ctx.assert('② 点图片右侧空白：光标位置在图片**之后**（不是图片前面）',
        落2.位置 === '后', JSON.stringify(落2));
      ctx.witness('几何：点右侧空白后的落点', { 点: g2.右外30, 落点: 落2 }, 'geometry');
      await session.shot('138-右空白落点');
      await 回车(session);
      await session.type('Z'); await hi.sleep(420);
      // 图片那一段被回车分成两段：图片 + 新段 Z；后面的"后文乙。"必须原样不动。
      const 预期 = BODY.replace('![靶图](shot-blue.png)\n', '![靶图](shot-blue.png)\n\nZ\n');
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const 盘 = String(saved.after).replace(/\r/g, '');
      ctx.witness('磁盘：回车+打字后的文件', { 盘: 盘.replace(/\n/g, '\\n'), 期望: 预期.replace(/\n/g, '\\n') }, 'disk');
      ctx.assert('② 回车+打字：新行出现在图片下方、图片引用与后文逐字不变（磁盘）',
        盘 === 预期, JSON.stringify(盘.replace(/\n/g, '\\n')));
      await session.shot('138-回车打字');

      // ── ④ 护栏：从右侧空白带起手拖选仍是原生拖选，文档零改动 ────────────────────
      await session.click(文.x, 文.y); await hi.sleep(280);
      const g4 = await session.js(几何);
      const 后文 = await session.js(文本点('后文乙'));
      const 前盘 = fs.readFileSync(file);
      await hi.drag(session, { x: g4.右外30.x, y: g4.右外30.y }, { x: 后文.x, y: 后文.y }, { steps: 8, after: 420 });
      const 选 = await hi.caret(session);
      ctx.assert('④ 护栏：从右侧空白带拖选仍是原生拖选（选区非空）',
        !选.折叠 && 选.选区长 > 0, JSON.stringify(选));
      const 后盘 = fs.readFileSync(file);
      ctx.assert('④ 护栏：拖选不改文档（磁盘逐字节相同）', 前盘.equals(后盘), `前 ${前盘.length}B 后 ${后盘.length}B`);
      ctx.witness('磁盘：拖选前后', { 相同: 前盘.equals(后盘), 字节: 后盘.length }, 'disk');

      // ── ⑤ 护栏：Alt+单击=展开源码（老手势仍然确定可复现） ─────────────────────
      await session.click(文.x, 文.y); await hi.sleep(280);
      const g5 = await session.js(几何);
      await session.click(g5.中心.x, g5.中心.y, { modifiers: hi.MOD.alt }); await hi.sleep(420);
      const 落5 = await session.js(读落点);
      ctx.assert('⑤ 护栏：Alt+单击图片仍展开源码、光标在源码里',
        落5.展开 === true && 落5.在节点内 === true, JSON.stringify(落5));
    } finally {
      await ctx.release(session);
    }

    // ══ 会话二：裸 HTML 图块（正文里直接写 <img …>） ══════════════════════════════
    const file2 = hi.writeDoc('image-click-html.md', BODY_HTML);
    const session2 = await hi.openDoc(ctx, file2, { minBlocks: 3 });
    try {
      ctx.assert('会话二 焦点在编辑器', (await hi.ensureFocus(session2)).ok, '');
      const 文2 = await session2.js(文本点('前文甲'));
      const g6 = await session2.js(几何);
      ctx.assert('③ 前置：拿到裸 HTML 图片几何', g6.ok && g6.类型 === 'html-block', JSON.stringify(g6));
      await session2.click(文2.x, 文2.y); await hi.sleep(300);
      const g7 = await session2.js(几何);
      await session2.click(g7.右外30.x, g7.右外30.y); await hi.sleep(460);
      const 落6 = await session2.js(读落点);
      // R11 案三 Path A 新契约（D-D 裁决，2.3.1）：点裸 HTML 图右侧空白**不再展开源码**——
      // 旧契约「源码行展开+光标进源码末尾」正是回车插 \n 后退格吞块案的入口，已废除。
      // 收束轮1（2026-10-02，取消双重光标）：新契约与 md 图统一——落点=紧随图片节点的
      // ZWSP 零宽锚（z@0，原生 caret 自己画），合成光标结构性不存在。
      ctx.assert('③ 点裸 HTML 图右侧空白：源码不再展开（新契约）', 落6.展开 === false, JSON.stringify(落6));
      ctx.assert('③ 落点是"图片之后"的逻辑位（不是源码、不在图片前面）',
        落6.在节点内 === false && 落6.位置 === '后' && 落6.层 !== '源码', JSON.stringify(落6));
      const 箭6 = await session2.js(读零宽锚);
      ctx.assert('③ 锚=ZWSP 文本位且原生光标可见（合成光标已取消）',
        箭6.ok, JSON.stringify(箭6));
      ctx.witness('几何：裸 HTML 图点右侧的落点', { 点: g7.右外30, 落点: 落6 }, 'geometry');
      await session2.shot('138-HTML图右侧落点');
      await 回车(session2);
      await session2.type('Z'); await hi.sleep(460);
      const saved2 = await hi.edge.saveAndWait(session2, file2, { timeout: 8000 });
      const 盘2 = String(saved2.after).replace(/\r/g, '');
      ctx.witness('磁盘：裸 HTML 图回车+打字后的文件', { 盘2 }, 'disk');
      ctx.assert('③ 回车+打字：新行在 <img …> 之后，标签原样不动（磁盘）',
        盘2.includes('<img src="shot-blue.png" alt="html图" width="160">')
        && /\n\s*Z\s*$/m.test(盘2), JSON.stringify(盘2.slice(-70)));
    } finally {
      await ctx.release(session2);
    }
  },
};
