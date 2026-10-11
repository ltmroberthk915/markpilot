/** 141 · 标题回车：**上下文矩阵**——契约本体（139）在 8 种邻块/位置里都必须成立
 *
 *  139 锁的是「标题回车」这一族的那**一个点**：单标题、前后都是普通段落。本场景按
 *  覆盖率缺口矩阵（.zcode-tmp/r16/覆盖率缺口-2.3.2.md §4·141）把同一个点扫成**一整面**：
 *  同一契约换 8 种上下文（文首 / 文末 / 上文是表格 / 上文是列表 / 上文是引用 / 上文是块公式 /
 *  上文是图片 / 两个同级标题相邻），每一处都验两件事：
 *    ① 光标在 `### ` **之后**按回车：标记钉在原行（那一行仍是同级别标题、内容为空），
 *       标记之后的内容回撤到**下一行并落成普通段落**，光标在新段落开头；
 *    ② 光标在 `### ` **之前**按回车：上方插一个空段、标题整行下移（Typora 块首语义，不回退）。
 *  邻块（表格 / 列表 / 引用 / 块公式 / 图片）在两种拆分下都必须**内容逐字符不变**——它们是
 *  别的东西，不该被标题的一次回车牵动。文首/文末还要证明"光标没消失"（真的能接着打字，
 *  字落在新段落最前面）。
 *
 *  手势全部走真实输入通道（落点坐标由标记/文字矩形现算，不用产品自报）：
 *    · 鼠标：点标题正文露出源码、点标记左缘（井号左侧那一格）；
 *    · 键盘：真 Enter、Home（标题行上 Home = 走到标记之后，实测口径）、← / → 兜底；
 *    · 键鼠配合：点开标题再用 Home/方向键定位；
 *    · 组合键：Ctrl+Z（**只登记不判红**：实测在 setValue 之后再按 Ctrl+Z，撤回的是那次程序化灌文，
 *      不是刚按下的一回车——"拆分后一步复原"的撤销链由 139 ⑨ 断言，本场景不重复钉）；
 *    · 拖拽：从标记拖过标题正文再回车（替换选区语义的护栏，会话九）。
 *
 *  断言的读法一律是"用户看得见的东西"：第一块还是不是标题、内容有没有掉出标题、光标在哪一层、
 *  磁盘上的字变成什么样。不写"某个处理器被调用了"。
 *
 *  独立证人（至少一条在产品之外）：`disk`（每个上下文保存后逐行比对整份文件 + 邻块内容不变）
 *  ＋ `geometry`（块序列 `TAG[标记]` / 空标记判定 / 光标矩形）。
 *
 *  **形态登记（实测口径，不作为失败，只登记）**：
 *    · 表格保存时会被规范化（`| --- |` → `| -- |`、单元格补空格）——所以磁盘比对按
 *      "压缩空白 + 折叠连字符"的行口径做，原始字节同时写进磁盘证人供人复核；
 *    · 块公式保存时前导空格被去掉（` a=b` → `a=b`）；空段落不落盘。
 *    这两条都是本场景开跑前用探针实测到的既有形态，与标题回车无关，登记在此免得后人误判。
 *
 *  突变验证（把修复注掉必须变红——写在这里就是为了让后人一眼能找到"哪一行"）：
 *    · `app/renderer/js/typora-patches.js` 的 `patchHeadingEnter`（L445 起）里那段
 *      「光标在标记之后」判据（L485–493 的计算 + L494 的 `&& !光标在标记之后`）：
 *      注掉（退回旧的 `!leftWithoutMarkers.textContent` 单判据）→ 8 个上下文的 ① 全线变红
 *      （第一行不再是空的 `###`，内容仍留在标题里，"井号钉在原行"这件事消失）。
 *    · 把 L494 的 `!光标在标记之后` 改成恒 true → ① 依旧变红（两种方向都试过，这条判据是
 *      本场景唯一的支点）。
 */

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const hi = require('../../human-input/hi.cjs');

const 读结构 = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
  if (!s) return { ok: false };
  const fr = document.getElementById('editor').getBoundingClientRect();
  const 块 = [...s.children].map(b => {
    const 是标题 = /^H[1-6]$/.test(b.tagName);
    const 标记 = b.querySelector('[data-type="heading-marker"]');
    const 正文 = 标记 ? [...b.childNodes].filter(n => !(n.nodeType === 1 && n.getAttribute('data-type') === 'heading-marker'))
      .map(n => n.textContent).join('') : b.textContent;
    return { tag: b.tagName, 标题: 是标题, 标记: 标记 ? 标记.textContent : null,
      标记数: b.querySelectorAll('[data-type="heading-marker"]').length,
      空: !正文.replace(/[\\s\\u200b\\u3000]/g, ''), 文本: b.textContent.replace(/\\u200b/g, '').slice(0, 30) };
  });
  const sel = w.getSelection(); const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const at = r ? (r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer) : null;
  let 光标 = null;
  if (r) { const box = r.getBoundingClientRect();
    光标 = { 折叠: r.collapsed, 偏移: r.startOffset,
      层: !at || !s.contains(at) ? '外' : at.closest('h1,h2,h3,h4,h5,h6') ? '标题' : at.closest('p') ? '段'
        : at.closest('[data-type$="-marker"]') ? '围栏' : '其他',
      x: Math.round(fr.x + box.left), y: Math.round(fr.y + box.top), h: Math.round(box.height) }; }
  return { ok: true, 块, 光标,
    全文: s.textContent.replace(/\\u200b/g, '').replace(/\\s+/g, ' ').trim().slice(0, 120),
    表格: [...s.querySelectorAll('table')].map(t => ({ 行: t.querySelectorAll('tr').length,
      格: [...t.querySelectorAll('tr')].map(tr => tr.querySelectorAll('td,th').length) })),
    列表项: s.querySelectorAll('li').length, 引用块: s.querySelectorAll('blockquote').length,
    块公式: s.querySelectorAll('code[data-type="math-block"]').length, 图: s.querySelectorAll('img').length,
    行内公式: s.querySelectorAll('code[data-type="math-inline"]').length }; })()`;

/** 光标相对标题标记的位置：`前缀` = 从标题开头到光标的那段文字。
 *  · 前缀 === 标记文本（`### `）→ 光标正好在**标记之后**（标记整枚在光标左边）；
 *  · 前缀 === ''                   → 光标在**标记之前**（块首）；
 *  · 其它                          → 光标在标记文字或标题正文中间。 */
const 读标记位 = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
  if (!s) return { ok: false, why: '没有编辑面' };
  const h = s.querySelector('h1,h2,h3,h4,h5,h6'); if (!h) return { ok: false, why: '没有标题' };
  const 标记 = h.querySelector('[data-type="heading-marker"]'); if (!标记) return { ok: false, why: '没有标记' };
  const sel = w.getSelection(); if (!sel || !sel.rangeCount) return { ok: false, why: '没有选区' };
  const r = sel.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const 所在标题 = at && at.closest ? at.closest('h1,h2,h3,h4,h5,h6') : null;
  if (所在标题 !== h) return { ok: false, why: '光标不在这个标题里' };
  const pre = d.createRange(); pre.selectNodeContents(h); pre.setEnd(r.startContainer, r.startOffset);
  const 前缀 = pre.toString(); const 标记文本 = 标记.textContent;
  return { ok: true, 标记文本, 前缀, 折叠: r.collapsed,
    在标记里: !!(at.closest && at.closest('[data-type="heading-marker"]')),
    在标记之后: 前缀 === 标记文本, 在标记之前: 前缀 === '',
    展开: h.classList.contains('vditor-ir__node--expand') }; })()`;

/** 标题正文/标记的矩形（顶层页坐标）——鼠标手势的落点由它现算，不用产品自报的落点。 */
const 标题几何 = `(() => { const w = ${hi.IF}, d = w.document; const fr = document.getElementById('editor').getBoundingClientRect();
  const s = d.querySelector('${hi.SURFACE}'); const h = s.querySelector('h1,h2,h3,h4,h5,h6'); if (!h) return { ok: false };
  h.scrollIntoView({ block: 'center', behavior: 'instant' });
  const m = h.querySelector('[data-type="heading-marker"]');
  const mr = m ? m.getBoundingClientRect() : null;
  const t = [...h.childNodes].filter(n => n.nodeType === 3 && n.data.replace(/[\\s\\u200b\\u3000]/g, '')).pop();
  const tr = t ? (() => { const q = d.createRange(); q.selectNodeContents(t); return q.getBoundingClientRect(); })() : null;
  return { ok: true, 展开: h.classList.contains('vditor-ir__node--expand'), 标记: m ? m.textContent : null,
    标记长: m ? m.textContent.length : 0,
    标记右缘: mr ? { x: Math.round(fr.x + mr.right + 2), y: Math.round(fr.y + mr.top + mr.height / 2) } : null,
    标记左缘: mr ? { x: Math.round(fr.x + mr.left + 1), y: Math.round(fr.y + mr.top + mr.height / 2) } : null,
    正文中点: tr ? { x: Math.round(fr.x + tr.left + tr.width / 2), y: Math.round(fr.y + tr.top + tr.height / 2) } : null }; })()`;

const 置文 = md => `(() => { const w = ${hi.IF}; w.vditor.setValue(${JSON.stringify(md)}); return true; })()`;

/** 行口径：压掉行尾空白 + 行内连续空白压成一个空格 + 折叠连续连字符
 *  （表格保存时的 `---`→`--`、单元格补空格属既有形态，见文件头"形态登记"）。 */
const 规范 = text => String(text).replace(/\r/g, '').split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n');
const 行规范 = text => 规范(text).split('\n').filter(line => line.trim())
  .map(line => line.replace(/[ \t]+/g, ' ').replace(/-{2,}/g, '--').trim());
const 非空行 = text => 规范(text).split('\n').filter(line => line.trim()).map(line => line.replace(/[ \t]+$/, ''));

async function 回车(session) { await session.key({ key: 'Enter', code: 'Enter', vk: 13, text: '\r' }); await hi.sleep(430); }
async function 撤销(session) { await hi.combo(session, 'Ctrl+z'); await hi.sleep(520); }

/** 走到「标记之后」：点标题正文（露出源码）→ Home（实测：标题行上 Home 落在标记之后）
 *  → 兜底：点标记右缘 → 再兜底：走到块首后按标记长度次 →。每一步都是真实输入。 */
async function 到标记之后(session) {
  const 轨迹 = [];
  let g = await session.js(标题几何);
  if (!g.ok) return { ok: false, why: '没有标题', 轨迹 };
  await session.click(g.正文中点.x, g.正文中点.y); await hi.sleep(380);
  let 位 = await session.js(读标记位);
  轨迹.push({ 步: '点标题正文', 前缀: 位.前缀, 在标记之后: 位.在标记之后 });
  if (位.ok && 位.在标记之后) return { ok: true, how: '点标题正文', 轨迹, 位 };
  await session.key({ key: 'Home', code: 'Home', vk: 36 }); await hi.sleep(360);
  位 = await session.js(读标记位);
  轨迹.push({ 步: 'Home', 前缀: 位.前缀, 在标记之后: 位.在标记之后 });
  if (位.ok && 位.在标记之后) return { ok: true, how: 'Home', 轨迹, 位 };
  g = await session.js(标题几何);
  if (g.标记右缘) {
    await session.click(g.标记右缘.x, g.标记右缘.y); await hi.sleep(380);
    位 = await session.js(读标记位);
    轨迹.push({ 步: '点标记右缘', 前缀: 位.前缀, 在标记之后: 位.在标记之后 });
    if (位.ok && 位.在标记之后) return { ok: true, how: '点标记右缘', 轨迹, 位 };
  }
  const 块首 = await 到标记之前(session);
  if (块首.ok) {
    const 长 = g.标记长 || 0;
    for (let i = 0; i < 长; i++) { await session.key({ key: 'ArrowRight', code: 'ArrowRight', vk: 39 }); }
    await hi.sleep(300);
    位 = await session.js(读标记位);
    轨迹.push({ 步: '块首后按 →×' + 长, 前缀: 位.前缀, 在标记之后: 位.在标记之后 });
    if (位.ok && 位.在标记之后) return { ok: true, how: '块首后按 →×' + 长, 轨迹, 位 };
  }
  return { ok: false, why: '没走到标记之后', 轨迹, 位 };
}

/** 走到「标记之前」（块首）：点标记左缘（井号左侧那一格，块首守卫会把它留在井号前）
 *  → 兜底：Home 之后连按 ←（从标记末尾退到标记之前）。 */
async function 到标记之前(session) {
  const 轨迹 = [];
  let 位 = await session.js(读标记位);
  if (位.ok && 位.在标记之前) return { ok: true, how: '已在块首', 轨迹 };
  let g = await session.js(标题几何);
  if (!g.ok) return { ok: false, why: '没有标题', 轨迹 };
  await session.click(g.正文中点.x, g.正文中点.y); await hi.sleep(380);
  g = await session.js(标题几何);
  if (g.标记左缘) {
    await session.click(g.标记左缘.x, g.标记左缘.y); await hi.sleep(380);
    位 = await session.js(读标记位);
    轨迹.push({ 步: '点标记左缘', 前缀: 位.前缀, 在标记之前: 位.在标记之前 });
    if (位.ok && 位.在标记之前) return { ok: true, how: '点标记左缘', 轨迹, 位 };
  }
  await session.key({ key: 'Home', code: 'Home', vk: 36 }); await hi.sleep(340);
  for (let i = 0; i < (g.标记长 || 4) + 2; i++) {
    await session.key({ key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }); await hi.sleep(190);
    位 = await session.js(读标记位);
    if (位.ok && 位.在标记之前) { 轨迹.push({ 步: 'Home 后 ←×' + (i + 1), 前缀: 位.前缀 }); return { ok: true, how: 'Home 后 ←×' + (i + 1), 轨迹, 位 }; }
  }
  return { ok: false, why: '没走到标记之前', 轨迹, 位 };
}

/** 8 份上下文夹具：同一个标题（`### 标题内容`）换 8 种上文/位置。
 *  `邻断言` 只读块计数与文本（几何口径）；`邻原文` 是磁盘侧的对照原文，用"行口径"比对。 */
const 例表 = [
  { 名: '①文首标题', 文件: '141-ctx-doc-start.md', 特别: '文首',
    文: ['### 标题内容', '', '后文。', ''].join('\n') },
  { 名: '②文末标题', 文件: '141-ctx-doc-end.md', 特别: '文末',
    文: ['前文。', '', '### 标题内容', ''].join('\n') },
  { 名: '③上文是表格', 文件: '141-ctx-table.md', 邻名: '3×2 表格',
    邻原文: ['| 甲 | 乙 |', '| --- | --- |', '| 1 | 2 |'].join('\n'),
    邻断言: r => r.表格.length === 1 && r.表格[0].行 === 2 && r.表格[0].格.every(n => n === 2)
      && r.列表项 === 0 && r.引用块 === 0 && r.块公式 === 0 && r.图 === 0 && r.全文.includes('甲')
      && r.块[0].tag === 'TABLE',
    文: ['| 甲 | 乙 |', '| --- | --- |', '| 1 | 2 |', '', '### 标题内容', '', '后文。', ''].join('\n') },
  { 名: '④上文是列表', 文件: '141-ctx-list.md', 邻名: '两项无序列表',
    邻原文: ['* 甲项', '* 乙项'].join('\n'),
    邻断言: r => r.列表项 === 2 && r.表格.length === 0 && r.块公式 === 0 && r.图 === 0 && r.全文.includes('甲项')
      && r.块[0].tag === 'UL',
    文: ['* 甲项', '* 乙项', '', '### 标题内容', '', '后文。', ''].join('\n') },
  { 名: '⑤上文是引用', 文件: '141-ctx-quote.md', 邻名: '一段引用',
    邻原文: '> 引用甲',
    邻断言: r => r.引用块 === 1 && r.表格.length === 0 && r.图 === 0 && r.全文.includes('引用甲')
      && r.块[0].tag === 'BLOCKQUOTE',
    文: ['> 引用甲', '', '### 标题内容', '', '后文。', ''].join('\n') },
  { 名: '⑥上文是块公式', 文件: '141-ctx-math.md', 邻名: '块公式 $$a=b$$',
    邻原文: ['$$', ' a=b', '$$'].join('\n'),
    邻断言: r => r.块公式 === 1 && r.表格.length === 0 && r.图 === 0 && r.全文.includes('a=b'),
    文: ['$$', ' a=b', '$$', '', '### 标题内容', '', '后文。', ''].join('\n') },
  { 名: '⑦上文是图片', 文件: '141-ctx-image.md', 邻名: '一张 md 图',
    邻原文: '![靶图](shot-blue.png)', 邻断言: r => r.图 === 1 && r.表格.length === 0 && r.全文.includes('后文'),
    文: ['![靶图](shot-blue.png)', '', '### 标题内容', '', '后文。', ''].join('\n') },
  { 名: '⑧两个同级标题相邻', 文件: '141-ctx-adjacent.md', 特别: '相邻', 内容文本: '标题甲',
    文: ['### 标题甲', '', '### 标题乙', '', '后文。', ''].join('\n') },
];

const 级数 = 3;
const 标记文本 = '### ';

module.exports = {
  id: '141-heading-enter-context-matrix',
  title: '标题回车上下文矩阵：标记之后=钉原行/标记之前=整行下移，8 种邻块与文首文末都不变、邻块逐字',
  run: async ctx => {
    fs.mkdirSync(hi.ROOM, { recursive: true });
    fs.writeFileSync(path.join(hi.ROOM, 'shot-blue.png'), hi.fixtures.png(160, 100, [70, 110, 230]));

    let 成立 = 0;
    for (const 例 of 例表) {
      const 内容文本 = 例.内容文本 || '标题内容';
      const 标题行 = '### ' + 内容文本;
      const file = hi.writeDoc(例.文件, 例.文);
      const 原件 = fs.readFileSync(file, 'utf8');
      const 原行 = 行规范(原件);
      const 行首 = 原行.indexOf(标题行);
      const session = await hi.openDoc(ctx, file, { minBlocks: 2 });
      try {
        ctx.assert(`${例.名} 焦点在编辑器（按键类读数前置）`, (await hi.ensureFocus(session)).ok, '');

        // ══ ① 光标在标记之后按回车：标记钉原行、内容落到下一行变普通段落 ═══════════════
        let 标题序 = -1;
        const 到 = await 到标记之后(session);
        ctx.assert(`${例.名} ① 前置：真手势把光标放到标记之后（走法：${到.how || '未成功'}）`,
          到.ok === true, JSON.stringify(到.轨迹 || 到));
        if (到.ok) {
          const 构前 = await session.js(读结构);
          标题序 = 构前.块.findIndex(b => b.标题);
          await 回车(session);
          const 构 = await session.js(读结构);
          ctx.assert(`${例.名} ① 标记钉在原行：标题那一块仍是 H${级数} 且只剩标记（不许整行下移）`,
            构.ok && 标题序 >= 0 && 构.块[标题序] && 构.块[标题序].tag === 'H' + 级数 && 构.块[标题序].空
            && 构.块[标题序].标记 === 标记文本, JSON.stringify({ 标题序, 块: 构.块 }));
          ctx.assert(`${例.名} ① 内容落到下一行、变成普通段落`,
            构.块[标题序 + 1] && 构.块[标题序 + 1].tag === 'P' && !构.块[标题序 + 1].标题
            && 构.块[标题序 + 1].文本 === 内容文本, JSON.stringify(构.块[标题序 + 1] || null));
          ctx.assert(`${例.名} ① 光标落在新段落开头（用户能接着往下打字）`,
            构.光标 && 构.光标.层 === '段' && 构.光标.偏移 === 0 && 构.光标.折叠, JSON.stringify(构.光标));
          const 标题块 = 构.块.filter(b => b.标题);
          ctx.assert(`${例.名} ① 标记只长在标题上、每块标题恰好一枚（不许出现「### ###」）`,
            构.块.filter(b => b.标记).length === 标题块.length && 标题块.every(b => b.标记数 === 1),
            JSON.stringify({ 标记: 构.块.map(b => b.标记), 标题块: 标题块.length }));
          if (例.邻断言) {
            ctx.assert(`${例.名} ① 邻块（${例.邻名}）结构不变`,
              例.邻断言(构), JSON.stringify({ 表格: 构.表格, 列表项: 构.列表项, 引用块: 构.引用块, 块公式: 构.块公式, 图: 构.图 }));
          }
          if (例.特别 === '相邻') {
            ctx.assert(`${例.名} ① 只动光标所在的第一个标题，第二个标题原样不动`,
              构.块[标题序 + 2] && 构.块[标题序 + 2].tag === 'H' + 级数 && 构.块[标题序 + 2].文本 === '### 标题乙'
              && 构.块[标题序 + 3] && 构.块[标题序 + 3].文本 === '后文。',
              JSON.stringify(构.块.slice(标题序)));
          }
          if (例.特别 === '文末') {
            ctx.assert(`${例.名} ① 文末的标题拆完光标仍在新段落里（不是掉到编辑面外）`,
              构.光标 && 构.光标.层 === '段' && 构.光标.偏移 === 0 && 构.光标.折叠, JSON.stringify(构.光标));
          }
          if (例.特别 === '文首' || 例.特别 === '文末') {
            // 自证：真的在"新段落开头"打字，字必须落在新段落最前面
            await session.type(例.特别 === '文首' ? '甲' : '尾');
            await hi.sleep(420);
            const 打 = await session.js(读结构);
            const 期望 = (例.特别 === '文首' ? '甲' : '尾') + 内容文本;
            ctx.assert(`${例.名} ① 自证：在新位置打字，字落在新段落最前面（${期望}）`,
              打.块[标题序 + 1] && 打.块[标题序 + 1].tag === 'P' && 打.块[标题序 + 1].文本 === 期望
              && 打.块[标题序].空, JSON.stringify(打.块.slice(标题序, 标题序 + 2)));
          }
          // 磁盘证人：拆分结果真的落盘，邻块内容不变
          const 盘 = await hi.edge.saveAndWait(session, file, { timeout: 9000 });
          const 盘行 = 行规范(盘.after);
          ctx.witness(`磁盘：${例.名} ① 拆分后的文件`, { 原始: 规范(盘.after) }, 'disk');
          const 期望文 = 原件.replace(标题行, '###\n\n' + (例.特别 === '文首' ? '甲' : 例.特别 === '文末' ? '尾' : '') + 内容文本);
          ctx.assert(`${例.名} ① 落盘：井号单独一行（空的同级别标题）、内容变成下一行的普通文本`,
            JSON.stringify(盘行) === JSON.stringify(行规范(期望文)),
            `实际 ${JSON.stringify(盘行)} 期望 ${JSON.stringify(行规范(期望文))}`);
          if (例.邻原文) {
            ctx.assert(`${例.名} ① 邻块（${例.邻名}）在磁盘上一个字符都没变`,
              盘行.join('\n').includes(行规范(例.邻原文).join('\n')), JSON.stringify(盘行));
          }
          const 打字 = 例.特别 === '文首' ? '甲' : 例.特别 === '文末' ? '尾' : '';
          if (盘行[行首] === '###' && 盘行[行首 + 1] === 打字 + 内容文本) 成立 += 1;
        }

        // ══ ② 光标在标记之前按回车：上方插空段、标题整行下移（块首语义，不回退） ═══════
        await session.js(置文(例.文)); await hi.sleep(640);
        const 到2 = await 到标记之前(session);
        ctx.assert(`${例.名} ② 前置：真手势把光标放到标记之前（走法：${到2.how || '未成功'}）`,
          到2.ok === true, JSON.stringify(到2.轨迹 || 到2));
        if (到2.ok) {
          await 回车(session);
          const 构2 = await session.js(读结构);
          const 序2 = 构2.块.findIndex(b => b.标题);
          ctx.assert(`${例.名} ② 上方多一个空段、标题整行下移（标题那一块前面多出一个空段、级别与内容都在）`,
            构2.ok && 序2 >= 0 && 构2.块[序2 - 1] && 构2.块[序2 - 1].tag === 'P' && 构2.块[序2 - 1].空
            && 构2.块[序2].tag === 'H' + 级数 && !构2.块[序2].空
            && (标题序 < 0 || 序2 === 标题序 + 1),
            JSON.stringify({ 标题序, 序2, 块: 构2.块 }));
          ctx.assert(`${例.名} ② 标题内容原样留在标题里（没有被降级成普通段落）`,
            构2.块[序2].文本 === 标题行 && 构2.块[序2].标记 === 标记文本, JSON.stringify(构2.块[序2]));
          ctx.assert(`${例.名} ② 光标没有消失（还在编辑面里）`,
            构2.光标 && 构2.光标.层 !== '外', JSON.stringify(构2.光标));
          if (例.邻断言) {
            ctx.assert(`${例.名} ② 邻块（${例.邻名}）结构不变`,
              例.邻断言(构2), JSON.stringify({ 表格: 构2.表格, 列表项: 构2.列表项, 引用块: 构2.引用块, 块公式: 构2.块公式, 图: 构2.图 }));
          }
          const 盘2 = await hi.edge.saveAndWait(session, file, { timeout: 9000 });
          ctx.witness(`磁盘：${例.名} ② 块首回车后的文件`, { 原始: 规范(盘2.after) }, 'disk');
          ctx.assert(`${例.名} ② 落盘：一行字都没丢（整份文件的行与原文件逐行相同、标题行仍带完整井号）`,
            JSON.stringify(行规范(盘2.after)) === JSON.stringify(原行) && 规范(盘2.after).includes(标题行),
            `实际 ${JSON.stringify(行规范(盘2.after))}`);
          if (例.邻原文) {
            ctx.assert(`${例.名} ② 邻块（${例.邻名}）在磁盘上一个字符都没变`,
              行规范(盘2.after).join('\n').includes(行规范(例.邻原文).join('\n')), JSON.stringify(行规范(盘2.after)));
          }
          // 几何证人：块序列 + 光标矩形（独立于产品自报）
          ctx.witness(`几何：${例.名} ② 块序列与光标`, { 块: 构2.块, 光标: 构2.光标 }, 'geometry');
          // 形态登记：块首回车之后的 Ctrl+Z 不在本场景的断言里。实测（探针 + 本场景首轮）：
          // 在 setValue 之后再按 Ctrl+Z，撤回的是那次 setValue（回到 setValue 之前的整篇文档），
          // 不是刚按下的一回车——那是"程序化灌文"这条测试路径的历史行为，与用户手打的撤销链不是一回事；
          // "拆分后一步 Ctrl+Z 复原"由 139 ⑨ 覆盖，这里只登记事实。
          ctx.log(`${例.名} ② 登记：块首回车之后一次 Ctrl+Z 会退回 setValue 之前的文档（139 负责撤销链断言）`);
        }
        await session.shot('141-' + 例.名);
      } finally {
        await ctx.release(session);
      }
    }

    // ══ 会话九：拖拽护栏——从标记拖过标题正文再回车（替换选区语义）+ Shift+Enter 对照 ══
    const 文件9 = hi.writeDoc('141-ctx-gesture-guards.md', 例表[0].文);
    const 会话9 = await hi.openDoc(ctx, 文件9, { minBlocks: 2 });
    try {
      ctx.assert('⑨ 焦点在编辑器', (await hi.ensureFocus(会话9)).ok, '');
      const 盘前 = fs.readFileSync(文件9, 'utf8');
      const 位9 = await 到标记之后(会话9);
      ctx.assert(`⑨ 前置：光标在标记之后（走法：${位9.how || '未成功'}）`, 位9.ok === true, JSON.stringify(位9.轨迹 || 位9));
      const 几何9 = await 会话9.js(标题几何);
      await hi.drag(会话9, { x: 几何9.标记右缘.x, y: 几何9.标记右缘.y },
        { x: 几何9.正文中点.x + 24, y: 几何9.正文中点.y }, { steps: 8, after: 560 });
      const 选9 = await hi.caret(会话9);
      ctx.assert('⑨ 从标记拖过标题正文：拖出了一个非空选区（真实拖拽通道）',
        !选9.折叠 && 选9.选区长 > 0, JSON.stringify(选9));
      ctx.assert('⑨ 拖选不改文档（磁盘逐字节相同）', 盘前 === fs.readFileSync(文件9, 'utf8'), '');
      await 回车(会话9);
      const 构9 = await 会话9.js(读结构);
      const 文9 = 规范(await hi.mdNow(会话9) || '');
      ctx.assert('⑨ 选中一段标题文字后回车：选区被替换、井号不重复（不许出现 `### ###`）',
        构9.ok && 构9.块.filter(b => b.标记).length <= 1 && !/###\s*###/.test(文9),
        JSON.stringify(构9.块) + ' md=' + JSON.stringify(文9));
      // Shift+Enter 对照：软换行不拆块（标题还是一条）
      await 会话9.js(置文(例表[0].文)); await hi.sleep(640);
      await 到标记之后(会话9);
      await hi.combo(会话9, 'Shift+Enter'); await hi.sleep(520);
      const 构9b = await 会话9.js(读结构);
      ctx.assert('⑨ 对照：Shift+Enter（软换行）不把标题拆成两块',
        构9b.ok && 构9b.块.filter(b => b.标题).length === 1 && 构9b.块[0].tag === 'H' + 级数,
        JSON.stringify(构9b.块.map(b => b.tag + (b.标记 || ''))));
      await 会话9.shot('141-⑨拖选与软换行对照');
    } finally {
      await ctx.release(会话9);
    }

    ctx.metric('141 上下文矩阵成立例数', 成立, { unit: '例', direction: 'higher', values: [成立] });
    ctx.log(`8 种上下文里 ①（标记钉原行 + 内容落下一行普通段落 + 逐行落盘）成立的例数：${成立}/8`);
  },
};
