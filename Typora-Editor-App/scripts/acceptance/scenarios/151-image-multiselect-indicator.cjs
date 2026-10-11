/** 151 · 图片多选指示框：Ctrl 点"已经实线选中"的那一张，框不许凭空消失
 *
 *  用户 2026-10-05 报：「之前做的那个第一次点击，然后按住CTRL再点击图片的那个选中指示框好像没了。
 *  这个你去查一下，是因为不同的图片格式不一样吗，还是什么原因？你兜一下底。」
 *
 *  确认轮结论（装机 2.3.2，8 形态 × 6 手势 48 格 / 24 张截图）：**图片格式不是变量**——md 图、
 *  裸 HTML 图块、段中行内、列表项、引用块、表格单元、文首、文末八种形态上，「单击 A → Ctrl 点 B
 *  （另一张）」都正常出虚线框。真正坏掉的是**同一张**：`单击 A（实线）→ 按住 Ctrl 再点 A 自己`
 *  —— mousedown 里那条"Ctrl 点已经单选的那一张 = 取消选择"的早退把实线框摘掉，**没有任何虚线框
 *  接手**，屏幕上就是一个选中指示都没有（race 探针时间线：只观测到"摘实"，"加虚"一次都没发生）。
 *  同一手势点另一张却正常 ⇒ 同一手势两种语义，用户无法预期。
 *
 *  同时抓到的第二条（同一条分支的附带损伤）：那条早退用 `getSelection().removeAllRanges()` 清
 *  选区，而 `keepEditorFocused()` 保存到的是**已被清空的选区**，Blink 把光标停在**文档开头**——
 *  紧接着按 Delete 会吃掉第一行标题的 `# `（标题塌成正文）、直接打字会打进文首。
 *
 *  修复后的契约：
 *    ① 单击图片 = 实线框（不变）；
 *    ② Ctrl 点**实线**那张 = 并入多选集合（实线 → 虚线），屏上**始终至少有一个框**；
 *    ③ 再 Ctrl 点一下这张虚线图 = 取消（框才消失）；
 *    ④ Ctrl 点另一张图 = 两张都虚线（既有）；
 *    ⑤ Ctrl 快速两击同图 = 先选入再取消（W5），且**不许**把图片源码弹出来；
 *    ⑥ Ctrl 手势**不许移动用户的文本光标**（迁移之后打字要落在原来的文本落点，不许落到文档开头）；
 *    ⑦ Delete / Ctrl+C 对集合生效，正文零损伤。
 *
 *  突变验证（注掉必须变红）：
 *    · 把 Ctrl 分支里那道门**放开**：`if(!刚才是实线){` → `if(true){`（不要写成 `if(false){`——
 *      那等于把整段 toggle 删掉，迁移加上的虚类没人摘，反而不会变红；复核轮实测两种写法的差别）。
 *      正确写法下：② 立刻变红（Ctrl 点自己之后框数 0＝用户报的症状）；
 *    · 把"光标还原"换回 `getSelection().removeAllRanges()` → ⑥ 变红（打字后光标落到块 0 的
 *      `# 甲标题` 上、那个字没进任何正文段，磁盘与打字前逐字相同）；
 *    · 注掉 media-tools.css 的 `.typora-img-multi-selected` 规则 → ② 的虚线框断言变红
 *      （类名仍在、`outlineStyle` 从 dashed 变 none）。
 *
 *  证人：几何（类 + computed outline-style + 框数）+ 磁盘（Delete 之后逐字节；正文零损伤）。
 */
'use strict';
const fs = require('node:fs');
const hi = require('../../human-input/hi.cjs');

const BODY = ['# 甲标题', '', '前文甲。', '', '![甲](shot-blue.png)', '', '![乙](shot-red.png)', '', '后文乙。', ''].join('\n');
const BODY_HTML = ['# 甲标题', '', '前文甲。', '', '<img src="shot-blue.png" alt="html甲" width="160">', '',
  '<img src="shot-red.png" alt="html乙" width="160">', '', '后文乙。', ''].join('\n');

/** 一条读数答完：每张图的类/框、框总数、光标块号与偏移、图片数、正文文本。 */
const 读图 = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
  if (!s) return { ok: false };
  const 图 = [...s.querySelectorAll('img')].map(im => {
    const cs = w.getComputedStyle(im);
    const own = im.closest('.vditor-ir__node[data-type]');
    return { alt: im.getAttribute('alt') || '', 实: im.classList.contains('typora-img-selected'),
      虚: im.classList.contains('typora-img-multi-selected'), outline: cs.outlineStyle,
      展开: !!own && own.classList.contains('vditor-ir__node--expand') };
  });
  const sel = w.getSelection(); const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const 块 = r ? [...s.children].indexOf(r.startContainer.nodeType === 1 && r.startContainer.parentElement === s ? r.startContainer : (r.startContainer.parentElement?.closest('p,h1,h2,h3,h4,h5,h6,li,blockquote') || null)) : -1;
  return { ok: true, 图, 图数: 图.length,
    框数: 图.filter(g => g.实 || g.虚).length,
    实线数: 图.filter(g => g.实).length, 虚线数: 图.filter(g => g.虚).length,
    光标: r ? { 折叠: r.collapsed, 块, 偏移: r.startOffset } : null,
    正文: s.textContent.replace(/\\u200b/g, '').slice(0, 60),
    toast: (d.querySelector('.typora-context-toast') || {}).textContent || null }; })()`;

const 文本点 = 词 => `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('${词}'));
  if (!t) return { ok: false };
  const r = t.getBoundingClientRect(); return { ok: true, x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;

/** 正文首段（第一个顶层 `<p>`）的点击点：**按结构定位**，不按文字找——本场景第 ⑥ 腿会往这一段
 *  里打一个字，之后再拿文字当搜索键就会因为字符串被切开而找不到（实测 `前文甲` → `前Q文甲`）。 */
const 首段点 = `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const s = d.querySelector('${hi.SURFACE}');
  const p = [...s.children].filter(b => b.tagName === 'P')[0];
  if (!p) return { ok: false };
  const r = p.getBoundingClientRect();
  return { ok: true, x: Math.round(frame.x + r.left + 24), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;

/** 图 i 的屏幕点（先滚进视口再量）。 */
const 图点 = i => `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const im = [...d.querySelectorAll('${hi.SURFACE} img')][${i}]; if (!im) return { ok: false };
  im.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = im.getBoundingClientRect();
  return { ok: true, x: Math.round(frame.x + r.left + r.width / 2), y: Math.round(frame.y + r.top + r.height / 2),
    natural: im.naturalWidth > 0 }; })()`;

/** 真实鼠标：单击（clickCount=1）或 Ctrl+单击。 */
async function 单击(session, 点, { ctrl = false, clickCount = 1 } = {}) {
  const modifiers = ctrl ? hi.MOD.ctrl : 0;
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 点.x, y: 点.y, button: 'left', buttons: 1, clickCount, modifiers });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 点.x, y: 点.y, button: 'left', buttons: 0, clickCount, modifiers });
  await hi.sleep(420);
}

module.exports = {
  id: '151-image-multiselect-indicator',
  title: '图片多选指示框：Ctrl 点已实线那张=实线转虚线（屏上始终有框），光标不丢',
  run: async ctx => {
    fs.mkdirSync(hi.ROOM, { recursive: true });
    fs.writeFileSync(`${hi.ROOM}/shot-blue.png`, hi.fixtures.png(160, 100, [70, 110, 230]));
    fs.writeFileSync(`${hi.ROOM}/shot-red.png`, hi.fixtures.png(160, 100, [230, 90, 90]));

    // ══ 会话一：Markdown 图 ══════════════════════════════════════════════════════
    const file = hi.writeDoc('msel-indicator.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 5 });
    try {
      ctx.assert('会话一 焦点在编辑器', (await hi.ensureFocus(session)).ok, '');
      const 文 = await session.js(文本点('前文甲'));
      const 甲点 = await session.js(图点(0));
      ctx.assert('前置：两张图都在视口内且已解码', 文.ok && 甲点.ok && 甲点.natural, JSON.stringify({ 文, 甲点 }));

      // 复位动作统一走"**现算**正文点再点"：图点做过 scrollIntoView，页面一滚，开局算好的坐标
      // 就失效了——拿旧坐标点会把光标点到图片源码里（实测：随后打字把 `shot-blue.png` 写成
      // `shot-blQue.png`，还顺带引发三条 404）。所以每次点击前都重新量。
      const 点正文 = async () => {
        const p = await session.js(首段点);
        if (!p.ok) throw new Error('找不到正文首段');
        await session.click(p.x, p.y); await hi.sleep(320);
        return p;
      };
      const 量图 = async i => {
        const p = await session.js(图点(i));
        if (!p.ok) throw new Error('找不到第 ' + i + ' 张图');
        return p;
      };

      // ── ① 单击 = 实线 ────────────────────────────────────────────────────────
      await 单击(session, await 量图(0));
      const 一 = await session.js(读图);
      ctx.assert('① 单击图片：实线框、框数 1',
        一.实线数 === 1 && 一.框数 === 1 && 一.图[0].outline === 'solid', JSON.stringify(一.图));

      // ── ② 核心：Ctrl 点"刚才那张自己" → 实线转虚线，框不许消失 ────────────────
      await 单击(session, await 量图(0), { ctrl: true });
      const 二 = await session.js(读图);
      ctx.assert('② Ctrl 点刚才实线的那一张：仍然有框（虚线），不许"全没了"',
        二.框数 === 1 && 二.虚线数 === 1 && 二.图[0].outline === 'dashed', JSON.stringify(二.图));
      ctx.assert('② toast 说明选中的张数（1 张）', String(二.toast || '').includes('1 张'), JSON.stringify(二.toast));
      await session.shot('151-②Ctrl点自己-虚线框还在');
      ctx.witness('几何：Ctrl 点自己后的框与光标', { 图: 二.图, 框数: 二.框数, 光标: 二.光标 }, 'geometry');

      // ── ③ 再 Ctrl 点一下 → 取消 ─────────────────────────────────────────────
      await 单击(session, await 量图(0), { ctrl: true });
      const 三 = await session.js(读图);
      ctx.assert('③ 再 Ctrl 点一下这张虚线图：取消（框数 0）', 三.框数 === 0, JSON.stringify(三.图));

      // ── ④ Ctrl 快速两击同图：先选入再取消，且不许弹源码 ───────────────────────
      await 点正文();
      await 单击(session, await 量图(0), { ctrl: true, clickCount: 1 });
      await 单击(session, await 量图(0), { ctrl: true, clickCount: 2 });
      const 四 = await session.js(读图);
      ctx.assert('④ Ctrl 快速两击同图：先选入再取消（框数 0）、源码不许弹出',
        四.框数 === 0 && 四.图.every(g => !g.展开), JSON.stringify(四.图));

      // ── ⑤ 单击甲 → Ctrl 点乙：两张虚线（既有契约） ───────────────────────────
      await 点正文();
      await 单击(session, await 量图(0));
      await 单击(session, await 量图(1), { ctrl: true });
      const 五 = await session.js(读图);
      ctx.assert('⑤ 单击甲 → Ctrl 点乙：两张都虚线、框数 2',
        五.虚线数 === 2 && 五.框数 === 2, JSON.stringify(五.图));

      // ── ⑥ 迁移之后打字：字必须落在**用户原来的文本落点**，不许跑到图片源码/文档开头 ──
      await 点正文();
      const 落点 = await session.js(读图);
      ctx.assert('⑥ 前置：复位后光标在正文段落里（不是图片行）', 落点.光标 && 落点.光标.块 === 1, JSON.stringify(落点.光标));
      await 单击(session, await 量图(0));
      await 单击(session, await 量图(0), { ctrl: true });
      const 迁后 = await session.js(读图);
      ctx.assert('⑥ 迁移之后光标不在文档开头、也不在图片行里（块号 = 复位时那一块）',
        迁后.光标 && 迁后.光标.块 === 落点.光标.块, JSON.stringify({ 复位块: 落点.光标.块, 迁后: 迁后.光标 }));
      await session.type('Q'); await hi.sleep(500);
      const 打字后 = await session.js(读图);
      // 判据只取用户看得见、且与本次契约相关的三件：字落在**原来那一块**、图片数不变、没有把字打进标题。
      // （打字会走整块重放，图片那一块的 `typora-img-multi-selected` 可能随重放掉——那是"重放丢外来类"
      //  这条既有机制，独立记账，不在本场景的契约里，所以不拿它当红项。）
      ctx.assert('⑥ 迁移之后打字：字落在**原来的文本落点那一块**、图片数不变',
        打字后.图数 === 2 && 打字后.光标 && 打字后.光标.块 === 落点.光标.块,
        JSON.stringify({ 原块: 落点.光标 && 落点.光标.块, 打字后: 打字后.光标, 图数: 打字后.图数, 框数: 打字后.框数 }));
      ctx.log('⑥ 备注：打字后框数=' + 打字后.框数 + '（整块重放会丢外来类，独立记账）');
      const 盘6 = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      ctx.witness('磁盘：迁移后打字落点', { 盘: String(盘6.after).replace(/\n/g, '\\n') }, 'disk');
      ctx.assert('⑥ 落盘核对：标题行完好、**图片引用一个字没被吃**（`![甲](shot-blue.png)` 逐字在）',
        /^# 甲标题\s*$/m.test(String(盘6.after).replace(/\r/g, ''))
        && String(盘6.after).includes('![甲](shot-blue.png)'),
        JSON.stringify(String(盘6.after).slice(0, 80)));

      // ── ⑦ Delete：删的是图片、正文零损伤 ─────────────────────────────────────
      await 点正文();
      await 单击(session, await 量图(0));
      await 单击(session, await 量图(0), { ctrl: true });
      await session.key({ key: 'Delete', code: 'Delete', vk: 46 }); await hi.sleep(600);
      const 七 = await session.js(读图);
      // 判据写成"把刚打进去的那个 Q 剥掉之后，正文逐字还在"——比固定子串稳（Q 落在第几个字符
      // 取决于点击像素与字形宽度，用 `前文甲` 这种两字子串会被 Q 切开而假红）。
      const 七正文 = String(七.正文).replace(/Q/g, '');
      ctx.assert('⑦ 迁移后按 Delete：删掉的是图片（图数 2→1），正文一个字不少',
        七.图数 === 1 && 七正文.includes('前文甲。') && 七正文.includes('后文乙。'),
        JSON.stringify({ 图数: 七.图数, 剥掉Q后的正文: 七正文 }));
      await session.shot('151-⑦Delete删图不伤正文');

      // ── ⑧ Esc 仍能清选（护栏） ───────────────────────────────────────────────
      await 点正文();
      const 剩点 = await 量图(0);
      await 单击(session, 剩点, { ctrl: true });
      const 选上 = await session.js(读图);
      ctx.assert('⑧ 前置：Ctrl 点后有一张虚线', 选上.虚线数 === 1, JSON.stringify(选上.图));
      await session.key({ key: 'Escape', code: 'Escape', vk: 27 }); await hi.sleep(420);
      ctx.assert('⑧ 护栏：Esc 清选（框数 0）', (await session.js(读图)).框数 === 0, '');
    } finally {
      await ctx.release(session);
    }

    // ══ 会话二：裸 HTML 图块（另一种图片形态）走同一契约 ═════════════════════════
    const file2 = hi.writeDoc('msel-indicator-html.md', BODY_HTML);
    const s2 = await hi.openDoc(ctx, file2, { minBlocks: 5 });
    try {
      ctx.assert('会话二 焦点在编辑器', (await hi.ensureFocus(s2)).ok, '');
      const 甲2 = await s2.js(图点(0));
      ctx.assert('⑨ 前置：裸 HTML 图块已解码', 甲2.ok && 甲2.natural, JSON.stringify(甲2));
      await 单击(s2, 甲2);
      const 其一 = await s2.js(读图);
      ctx.assert('⑨ 裸 HTML 图块：单击=实线', 其一.实线数 === 1 && 其一.图[0].outline === 'solid', JSON.stringify(其一.图));
      await 单击(s2, 甲2, { ctrl: true });
      const 其二 = await s2.js(读图);
      ctx.assert('⑨ 裸 HTML 图块：Ctrl 点自己 → 虚线框还在（与 md 图同契约）',
        其二.框数 === 1 && 其二.图[0].outline === 'dashed', JSON.stringify(其二.图));
      await s2.shot('151-⑨HTML图-Ctrl点自己-虚线框还在');
    } finally {
      await ctx.release(s2);
    }
  },
};
