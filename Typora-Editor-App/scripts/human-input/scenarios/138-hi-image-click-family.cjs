/** 138-hi · 图片点击家族（五通道拟人）：键盘 / 鼠标 / 组合键 / 键鼠配合 / 拖拽。
 *
 *  背景（用户 2026-10-02，图片是 Windows 截图后 Ctrl+V 粘进文档的）：
 *   ① "点击图片高频率点击有概率触发无法展开源码" —— 修复前连点次数奇偶决定展开成败；
 *   ② "点图片右侧空白应该是插入一个图片之后的光标，回车创建新一行" —— 修复前落点在
 *      "图前/图后"之间摇摆、裸 HTML 图块还会把光标塞进隐藏源码（打字打进 <img> 标签里）。
 *  本场景把两条修复放到**真人五通道**下再钉一遍；判据与正式场景 138 同源，只是输入通道更全。
 *
 *  通道覆盖：
 *    鼠标：单击（选中）/ 连点 2·3 次（必展开）/ 点图右侧空白（落图后）；
 *    键盘：回车 + 打字落新行；Ctrl+End 到底（既有语义）；Esc 清选中；
 *    组合键：Alt+单击（展开）、Ctrl+单击（多选集合，且不改文档）；
 *    键鼠配合：先点图片选中 → 再点右侧空白 → 回车打字（用户报的那条工作流）；
 *    拖拽：从图右侧空白带起手拖进正文（原生拖选、文档零改动）。
 *
 *  证人：磁盘（每次编辑后逐字节读回）+ 几何（落点/展开态）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const hi = require('../hi.cjs');

const BODY = ['# 图家族', '', '前文甲。', '', '![靶图](shot-blue.png)', '', '后文乙。', ''].join('\n');
const BODY_HTML = ['# 图家族H', '', '前文甲。', '', '<img src="shot-blue.png" alt="html图" width="160">', ''].join('\n');

const 几何 = `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop(); if (!img) return { ok: false };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = img.getBoundingClientRect();
  const owner = img.closest('.vditor-ir__node[data-type]');
  return { ok: true, 中心: { x: Math.round(frame.x + r.left + r.width / 2), y: Math.round(frame.y + r.top + r.height / 2) },
    右外30: { x: Math.round(frame.x + r.right + 30), y: Math.round(frame.y + r.top + r.height / 2) },
    展开: !!owner && owner.classList.contains('vditor-ir__node--expand'),
    选中: img.classList.contains('typora-img-selected'),
    多选: d.querySelectorAll('img.typora-img-multi-selected').length,
    类型: owner ? owner.getAttribute('data-type') : null }; })()`;

const 读落点 = `(() => { const w = ${hi.IF}, d = w.document; const sel = w.getSelection(); const s = d.querySelector('${hi.SURFACE}');
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop();
  const owner = img && img.closest('.vditor-ir__node[data-type]');
  if (!sel || !sel.rangeCount) return { 选区: null };
  const r = sel.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  let 位置 = null;
  if (owner) { const 环绕 = d.createRange(); 环绕.setStartBefore(owner); 环绕.setEndAfter(owner);
    const 标 = d.createRange(); 标.setStart(r.startContainer, r.startOffset); 标.collapse(true);
    位置 = 标.compareBoundaryPoints(Range.START_TO_END, 环绕) >= 0 ? '后' : '前/内'; }
  const 源 = owner && owner.querySelector('code[data-type]');
  const 源文本 = 源 && [...源.childNodes].find(node => node.nodeType === 3) || null;
  return { 在节点内: !!(at && owner && owner.contains(at)), 位置, 折叠: r.collapsed,
    容器: r.startContainer.nodeType === 3 ? 'TEXT(' + r.startContainer.data.length + ')' : r.startContainer.nodeName, 偏移: r.startOffset,
    源码末尾: !!(源文本 && r.startContainer === 源文本 && r.startOffset ===源文本.data.length) }; })()`;

const 文本点 = 词 => `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('${词}'));
  if (!t) return { ok: false };
  const r = t.getBoundingClientRect(); return { ok: true, x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;

async function 连点(session, 点, 次数) {
  for (let i = 1; i <= 次数; i++) {
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 点.x, y: 点.y, button: 'left', buttons: 1, clickCount: i });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 点.x, y: 点.y, button: 'left', buttons: 0, clickCount: i });
    if (i < 次数) await hi.sleep(50);
  }
  await hi.sleep(380);
}

module.exports = {
  id: '138-hi-image-click-family',
  title: '图片点击家族五通道：连点必展开；点右侧空白落图后+回车新行；Alt/选中/拖选护栏',
  run: async ctx => {
    fs.mkdirSync(hi.ROOM, { recursive: true });
    fs.writeFileSync(path.join(hi.ROOM, 'shot-blue.png'), hi.fixtures.png(160, 100, [70, 110, 230]));
    const file = hi.writeDoc('hi-image-family.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 4 });
    try {
      ctx.assert('焦点在编辑器', (await hi.ensureFocus(session)).ok, '');
      const 文 = await session.js(文本点('前文甲'));
      let g = await session.js(几何);
      ctx.assert('前置：拿到图片几何', g.ok && g.类型 === 'img', JSON.stringify(g));

      // ── 通道·鼠标：单击选中；连点 2/3 次必展开 ───────────────────────────────
      await session.click(文.x, 文.y); await hi.sleep(300);
      await session.click(g.中心.x, g.中心.y); await hi.sleep(320);
      const 单击 = await session.js(几何);
      ctx.assert('鼠标：单击图片=选中、不展开', 单击.选中 && !单击.展开, JSON.stringify(单击));
      for (const 次数 of [2, 3]) {
        await session.click(文.x, 文.y); await hi.sleep(280);
        await 连点(session, g.中心, 次数);
        const s = await session.js(几何);
        ctx.assert(`鼠标：连点 ${次数} 次必展开（连点奇偶不许决定成败）`, s.展开 === true, JSON.stringify(s));
      }
      ctx.witness('几何：单击/连点后的展开态', { 单击, 连点后: await session.js(几何) }, 'geometry');

      // ── 组合键：Alt+单击=展开；Ctrl+单击=多选且不改文档 ───────────────────────
      await session.click(文.x, 文.y); await hi.sleep(280);
      await session.click(g.中心.x, g.中心.y, { modifiers: hi.MOD.alt }); await hi.sleep(380);
      const Alt = await session.js(几何);
      ctx.assert('组合键：Alt+单击图片仍展开源码', Alt.展开 === true, JSON.stringify(Alt));
      await session.click(文.x, 文.y); await hi.sleep(260);
      const 前盘 = fs.readFileSync(file);
      const g8 = await session.js(几何);
      await session.click(g8.中心.x, g8.中心.y, { modifiers: hi.MOD.ctrl }); await hi.sleep(360);
      const 多选 = await session.js(几何);
      ctx.assert('组合键：Ctrl+单击=多选集合（选中 1 张）、不改文档', 多选.多选 === 1 && fs.readFileSync(file).equals(前盘), JSON.stringify(多选));
      await hi.press(session, 'Escape'); await hi.sleep(220);
      const 清 = await session.js(几何);
      ctx.assert('键盘：Esc 清掉多选高亮', 清.多选 === 0, JSON.stringify(清));

      // ── 键鼠配合：先点图片选中 → 点右侧空白 → 回车 → 打字（用户报的工作流） ────
      await session.click(文.x, 文.y); await hi.sleep(280);
      const g9 = await session.js(几何);
      await session.click(g9.中心.x, g9.中心.y); await hi.sleep(300);        // 鼠标：选中
      const 选中态 = await session.js(几何);
      ctx.assert('键鼠前置：图片处于选中态', 选中态.选中 === true, JSON.stringify(选中态));
      await session.click(g9.右外30.x, g9.右外30.y); await hi.sleep(420);    // 鼠标：点右侧空白
      const 落 = await session.js(读落点);
      ctx.assert('键鼠：点右侧空白后光标在"图片之后"、且不再选中图片',
        落.位置 === '后' && 落.在节点内 === false, JSON.stringify(落));
      const 选中后 = await session.js(几何);
      ctx.assert('键鼠：点右侧空白顺手清掉图片选中态', 选中后.选中 === false, JSON.stringify(选中后));
      await hi.press(session, 'Enter', { text: '\r' }); await hi.sleep(360);   // 键盘：回车（带文本=真实上屏通道）
      await session.type('Z'); await hi.sleep(420);                          // 键盘：打字
      const 期望 = BODY.replace('![靶图](shot-blue.png)\n', '![靶图](shot-blue.png)\n\nZ\n');
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const 盘 = String(saved.after).replace(/\r/g, '');
      ctx.witness('磁盘：回车+打字', { 盘: 盘.replace(/\n/g, '\\n') }, 'disk');
      ctx.assert('键鼠：回车+打字后新行在图片下方、其余逐字不变（磁盘）', 盘 === 期望, JSON.stringify(盘.replace(/\n/g, '\\n')));
      await session.shot('138hi-回车打字');

      // ── 键盘：Ctrl+End 到底打字仍落在文末（既有语义） ─────────────────────────
      await hi.combo(session, 'Ctrl+End'); await hi.sleep(240);
      await session.type('Y'); await hi.sleep(400);
      const 盘2 = String(await hi.mdNow(session));
      ctx.assert('键盘：Ctrl+End 后打字落在文档末尾（后文乙。之后）',
        /后文乙。Y\s*$/.test(盘2.replace(/\r/g, '')), JSON.stringify(盘2.slice(-40)));

      // ── 拖拽：从图右侧空白带起手拖进正文=原生拖选、文档零改动 ────────────────
      await session.click(文.x, 文.y); await hi.sleep(280);
      const g10 = await session.js(几何);
      const 后文 = await session.js(文本点('后文乙'));
      const 前盘2 = fs.readFileSync(file);
      await hi.drag(session, { x: g10.右外30.x, y: g10.右外30.y }, { x: 后文.x, y: 后文.y }, { steps: 8, after: 420 });
      const 选 = await hi.caret(session);
      ctx.assert('拖拽：从右侧空白带拖选是原生拖选（选区非空）', !选.折叠 && 选.选区长 > 0, JSON.stringify(选));
      ctx.assert('拖拽：拖选不改文档（磁盘逐字节相同）', fs.readFileSync(file).equals(前盘2), `前 ${前盘2.length}B`);
      ctx.witness('磁盘：拖选前后逐字节', { 相同: fs.readFileSync(file).equals(前盘2) }, 'disk');
      await hi.press(session, 'Escape'); await hi.sleep(200);
    } finally {
      await ctx.release(session);
    }

    // ══ 裸 HTML 图块：点右侧空白 → 源码末尾 → 回车打字 ═══════════════════════════
    const file2 = hi.writeDoc('hi-image-family-html.md', BODY_HTML);
    const session2 = await hi.openDoc(ctx, file2, { minBlocks: 3 });
    try {
      ctx.assert('会话二 焦点在编辑器', (await hi.ensureFocus(session2)).ok, '');
      const 文2 = await session2.js(文本点('前文甲'));
      const g11 = await session2.js(几何);
      ctx.assert('前置：裸 HTML 图块几何', g11.ok && g11.类型 === 'html-block', JSON.stringify(g11));
      await session2.click(文2.x, 文2.y); await hi.sleep(300);
      await session2.click(g11.右外30.x, g11.右外30.y); await hi.sleep(460);
      const 落2 = await session2.js(读落点);
      ctx.assert('裸 HTML 图：点右侧空白后光标在源码末尾（不是图片前面）', 落2.源码末尾 === true, JSON.stringify(落2));
      await hi.press(session2, 'Enter', { text: '\r' }); await hi.sleep(380);
      await session2.type('Z'); await hi.sleep(440);
      const saved2 = await hi.edge.saveAndWait(session2, file2, { timeout: 8000 });
      const 盘3 = String(saved2.after).replace(/\r/g, '');
      ctx.witness('磁盘：裸 HTML 图回车+打字', { 盘3: 盘3.replace(/\n/g, '\\n') }, 'disk');
      ctx.assert('裸 HTML 图：回车+打字后 Z 在 <img …> 之后、标签原样',
        盘3.includes('<img src="shot-blue.png" alt="html图" width="160">') && /\n\s*Z\s*$/m.test(盘3),
        JSON.stringify(盘3.replace(/\n/g, '\\n')));
      await session2.shot('138hi-HTML图');
    } finally {
      await ctx.release(session2);
    }
  },
};
