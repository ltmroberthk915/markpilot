/** 150 · 中部回车（mid-enter）的结构语义：契约快照 + 不回退门（A-008）
 *
 *  ── 契约快照（A-008 定谳，2026-10-05；改结构语义的人请先读这条） ─────────────────
 *
 *  ① 标题**文字中间**按回车（`### 标|题内容`）：左半留在标题里（仍是 h1..h6、级别不变），
 *     右半成为**普通段落**；中间**不插空段**、不产生第二枚标记、文字逐字不丢。
 *     磁盘形态：`### 标` 一行 + 无井号的 `题内容` 一行。
 *  ② 光标停在标题正文**开头**（左半只剩 `### `）：标记钉在原行（空标题），整段内容回撤成
 *     下一行的普通段落。
 *  ③ 标题里带行内公式时文字中间回车：左半留标题、右半成段，**公式一个字符不许丢**
 *     （源码节点恰好一条、`$` 成对、无残骸）。
 *  ④ 折行（wrap）的标题中部回车仍是同一形态——折行不许改写结构语义。
 *  ⑤ **列表项**文字中间回车：拆成两个列表项（`- 甲` / `- 乙丙`），还在同一条列表里。
 *  ⑥ **引用块**文字中间回车：仍是同一个引用块，左半右半各成一段（`> 甲` / `>` / `> 乙丙`）。
 *  ⑦ 拆分链：连续三次中部回车 → 三次 Ctrl+Z 逐级退回，最后逐字节回到原样。
 *  ⑧ Shift+Enter 对照：正文里是块内软换行（块数不变）；**标题里按产品记档的已知边界**
 *     处理（typora-patches.js `patchSoftBreak` 明文："不接管的容器：…标题——标题里的换行
 *     在这版 Lute 里会被拆成 h1+p"），形态与 Enter 同形。这一条是**登记**不是主张。
 *
 *  挂账背景：A-008「mid-enter 24/36 红定谳为既有行为（P1 结构语义面）」——标题文字中部
 *  回车的拆分形态经对照实验定谳：**数据层没丢**（公式完好），差异属 patchHeadingEnter
 *  的结构语义而非数据丢失。此前只有一次性探针矩阵（F-matrix），**没有正式场景**。
 *  本条把当前形态固化成门：谁改了结构语义，这条就会红，提醒人回来看 A-008 的裁决记录。
 *
 *  不回退门（A-008 证据门原文：mid-enter / wrap / undo / left-space 维持 0 坏）：
 *  ① 是 mid-enter、④ 是 wrap、⑦ 是 undo、② 是 left-space（左半只剩标记）。
 *
 *  通道纪律：定位（放置光标是前置）与回车、软回车、撤销全走真实键盘
 *  （CDP dispatchKeyEvent）；每段按键类读数前先 hi.ensureFocus 并断言 ok。
 *  判据一律是用户看得见的东西：块序列（DOM，标题另读"去掉标记后的正文"）＋磁盘 markdown。
 *
 *  突变点（把修复注掉必须变红）：
 *    · `app/renderer/js/typora-patches.js` 的 `patchHeadingEnter`（L445 起）mid 分支：
 *      把 `光标在标记之后` 判据退回旧判据、或把 else 分支（Spin 重解析两半）退回
 *      "上方插空段、标题整行下移" → ①③ 立刻变红（第一块不再是带左半文字的 H3）；
 *    · `app/renderer/js/math-markdown.js` 的 `repairInlineMathWreck` 短路（M-B 突变）
 *      → ③「公式一个字符不许丢」变红。
 *
 *  证人：几何（块序列/光标层）+ 磁盘（每个形态拆完存盘后逐字节读回）。
 *  素材：hi.writeDoc 现场生成到 .perf/human-input/fixtures/，不碰受保护素材房。
 */
'use strict';
const fs = require('node:fs');
const hi = require('../../human-input/hi.cjs');

const 标题体 = ['### 标题内容', '', '后文。', ''].join('\n');
const 公式体 = ['### 标题甲 $a+b=c$ 收尾', '', '后文。', ''].join('\n');
const 长标题 = '很长的标题文字'.repeat(12) + '收尾';
const 折行体 = ['### ' + 长标题, '', '后文。', ''].join('\n');
const 列表体 = ['- 甲乙丙', '', '后文。', ''].join('\n');
const 引用体 = ['> 甲乙丙', '', '后文。', ''].join('\n');
const 软换行体 = ['后文一。', '', '后文二。', ''].join('\n');

/** 块序列 + 光标层。`文本` 含标题标记（磁盘/标签视角），`正文` 是去掉标记后用户看到的字。 */
const 读结构 = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector(${JSON.stringify(hi.SURFACE)});
  if (!s) return { ok: false };
  const 干净 = n => String(n.textContent || '').replace(/\\u200b/g, '').replace(/\\s+/g, ' ').trim();
  const 去标记 = b => { if (!b.querySelector('[data-type="heading-marker"]')) return 干净(b);
    const clone = b.cloneNode(true);
    clone.querySelectorAll('[data-type="heading-marker"]').forEach(m => m.remove());
    return 干净(clone); };
  const 块 = [...s.children].map(b => {
    const 标记节 = b.querySelector('[data-type="heading-marker"]');
    const 引用 = b.tagName === 'BLOCKQUOTE' ? b : b.querySelector('blockquote');
    return { tag: b.tagName, 标题: /^H[1-6]$/.test(b.tagName), 标记: 标记节 ? 标记节.textContent : null,
      正文: 去标记(b).slice(0, 46), 文本: 干净(b).slice(0, 46),
      列表项: [...b.querySelectorAll('li')].map(li => 干净(li).slice(0, 26)),
      引用行: 引用 ? [...引用.children].map(c => c.tagName + ':' + 干净(c).slice(0, 22)) : null,
      公式: [...b.querySelectorAll('code[data-type^="math"]')].map(c => String(c.textContent)) };
  });
  const sel = w.getSelection(); const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const at = r ? (r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer) : null;
  // 【复核轮归一化】点正文**下方空白带**会让产品追加一个文末空段（vendored"点文末空白→新段"，
  // 见 media-tools.js 的空白带注释）——本场景判的是"中部回车拆出来的结构"，一条文末空段既不是
  // 拆分产物、也不参与任何判据，所以按读数归一化剔除；同时用 尾巴 字段如实标出来，不静默吞掉。
  const 尾巴 = 块.length > 0 && 块[块.length - 1].tag === 'P' && 块[块.length - 1].正文 === '';
  if (尾巴) 块.pop();
  return { ok: true, 块, 尾巴, 顶层: [...s.children].map(b => b.tagName).join(','),
    公式源码: [...s.querySelectorAll('code[data-type^="math"]')].map(c => String(c.textContent)),
    公式条数: s.querySelectorAll('code[data-type^="math"]').length,
    光标: r ? { 折叠: r.collapsed,
      层: !at || !s.contains(at) ? '外' : at.closest('h1,h2,h3,h4,h5,h6') ? '标题' : at.closest('li') ? '列表项'
        : at.closest('blockquote') ? '引用' : at.closest('p') ? '段' : '其他' } : null }; })()`;

/** 每个顶层块的**完整**文字（不截断）——折行/长文形态的逐字判据用。 */
const 读全文 = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector(${JSON.stringify(hi.SURFACE)});
  if (!s) return null;
  return [...s.children].map(b => String(b.textContent || '').replace(/\\u200b/g, '').replace(/\\s+/g, '')); })()`;

const 置文 = md => `(() => { const w = ${hi.IF}; w.vditor.setValue(${JSON.stringify(md)}); return true; })()`;

/** 把光标放到"含某片段的第一块"里的该片段之后第 n 个字符（定位是前置，动作仍走真实按键）。 */
const 放点 = (片段, 相对) => `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector(${JSON.stringify(hi.SURFACE)});
  if (!s) return { ok: false, why: 'no-surface' };
  for (const b of s.children) {
    const walker = d.createTreeWalker(b, NodeFilter.SHOW_TEXT); let n;
    while ((n = walker.nextNode())) { const at = n.data.indexOf(${JSON.stringify(片段)}); if (at >= 0) {
      const off = Math.min(at + ${相对}, n.data.length);
      const r = d.createRange(); r.setStart(n, off); r.collapse(true);
      const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      return { ok: true, 文本: n.data, 偏移: off, 长度: n.data.length }; } }
  }
  return { ok: false, why: '找不到片段' }; })()`;

const 非空行 = text => String(text).replace(/\r/g, '').split('\n').filter(line => line.trim());
const 行 = text => 非空行(text).map(line => line.trim());
const 显 = text => String(text).replace(/\n/g, '\\n');

async function 回车(session) { await session.key({ key: 'Enter', code: 'Enter', vk: 13, text: '\r' }); await hi.sleep(460); }
async function 软回车(session) { await session.key({ key: 'Enter', code: 'Enter', vk: 13, text: '\r', modifiers: hi.MOD.shift }); await hi.sleep(460); }
async function 撤销(session) { await hi.combo(session, 'Ctrl+z'); await hi.sleep(620); }

module.exports = {
  id: '150-heading-mid-enter-structure',
  title: '中部回车的结构语义（契约快照）：左半留标题/右半成段，公式不丢，列表/引用同族，链式撤销',
  run: async ctx => {
    // ══ 会话一：标题族形态矩阵（文字中部 / 内容中部 / 左空白 / 带公式 / 折行） ═════
    const file = hi.writeDoc('mid-enter-heading.md', 标题体);
    const session = await hi.openDoc(ctx, file, { minBlocks: 2 });
    try {
      ctx.assert('会话一 焦点在编辑器（按键类读数前置）', (await hi.ensureFocus(session)).ok, '');

      // ── ① 标题文字中部（`### 标|题内容`）：左半留标题、右半成普通段落【契约快照】 ──
      await session.js(置文(标题体)); await hi.sleep(600);
      await session.js(放点('标题内容', 1)); await hi.sleep(120);
      await 回车(session);
      const 构1 = await session.js(读结构);
      ctx.witness('几何：标题文字中部回车的块序列', { 顶层: 构1.顶层, 块: 构1.块.map(b => b.tag + '[' + b.正文 + ']'), 光标: 构1.光标 }, 'geometry');
      ctx.log('① mid-enter 标题：' + JSON.stringify(构1.块.map(b => b.tag + '[' + b.正文 + ']')) + ' 光标=' + JSON.stringify(构1.光标));
      ctx.assert('① 左半留在标题里（第一块仍是 H3、正文只剩「标」）',
        构1.ok && 构1.块[0].tag === 'H3' && 构1.块[0].标题 && 构1.块[0].正文 === '标' && 构1.块[0].标记 === '### ',
        JSON.stringify(构1.块[0]));
      ctx.assert('① 右半成为**普通段落**（第二块是 P、正文「题内容」）',
        构1.块[1] && 构1.块[1].tag === 'P' && !构1.块[1].标题 && 构1.块[1].正文 === '题内容', JSON.stringify(构1.块[1]));
      ctx.assert('① 中间**没有**多出一个空段（不许暗中改结构语义）',
        构1.块.length === 3 && 构1.块[2].正文 === '后文。', JSON.stringify(构1.块.map(b => b.tag + '[' + b.正文 + ']')));
      ctx.assert('① 只产生一枚标记、级别不变（不许出现 `### ###`）',
        构1.块.filter(b => b.标记).length === 1 && 构1.块[0].标记 === '### ', JSON.stringify(构1.块.map(b => b.标记)));
      ctx.assert('① 全文逐字不丢、顺序不变', 构1.块.map(b => b.正文).join('') === '标题内容后文。',
        JSON.stringify(构1.块.map(b => b.正文)));
      ctx.assert('① 光标落在右半新段落里（用户能接着往下打）', 构1.光标 && 构1.光标.层 === '段', JSON.stringify(构1.光标));

      const 存1 = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      ctx.witness('磁盘：① 标题中部拆分后的 markdown', { 行: 行(存1.after) }, 'disk');
      ctx.assert('① 磁盘快照：第一行 `### 标`、第二行是没有井号的普通段落 `题内容`',
        行(存1.after)[0] === '### 标' && 行(存1.after)[1] === '题内容' && 行(存1.after)[2] === '后文。', JSON.stringify(行(存1.after)));

      // ── ② left-space：光标停在标题正文开头（左半只剩标记）────────────────────
      await session.js(置文(标题体)); await hi.sleep(600);
      await session.js(放点('标题内容', 0)); await hi.sleep(120);
      await 回车(session);
      const 构2 = await session.js(读结构);
      ctx.witness('几何：left-space（正文开头回车）的块序列', { 块: 构2.块.map(b => b.tag + '[' + b.正文 + ']') }, 'geometry');
      ctx.log('② left-space：' + JSON.stringify(构2.块.map(b => b.tag + '[' + b.正文 + ']')));
      ctx.assert('② 光标停在标题正文开头时回车：标记钉在原行（第一块是只剩标记的 H3）',
        构2.ok && 构2.块[0].tag === 'H3' && 构2.块[0].正文 === '' && 构2.块[0].标记 === '### ', JSON.stringify(构2.块[0]));
      ctx.assert('② 内容整段回撤到下一行、是普通段落（不是标题、不许整行下移）',
        构2.块[1] && 构2.块[1].tag === 'P' && 构2.块[1].正文 === '标题内容', JSON.stringify(构2.块[1]));
      ctx.assert('② 标题级别不变、全文不丢字', 构2.块.map(b => b.正文).join('') === '标题内容后文。', JSON.stringify(构2.块.map(b => b.正文)));

      // ── ③ 标题内容中部（更靠中间）────────────────────────────────────────────
      await session.js(置文(标题体)); await hi.sleep(600);
      await session.js(放点('标题内容', 2)); await hi.sleep(120);
      await 回车(session);
      const 构3 = await session.js(读结构);
      ctx.log('③ 内容中部：' + JSON.stringify(构3.块.map(b => b.tag + '[' + b.正文 + ']')));
      ctx.assert('③ 中文内容中部回车：左半「标题」留在 H3 里',
        构3.ok && 构3.块[0].tag === 'H3' && 构3.块[0].正文 === '标题', JSON.stringify(构3.块[0]));
      ctx.assert('③ 右半「内容」成为普通段落',
        构3.块[1] && 构3.块[1].tag === 'P' && 构3.块[1].正文 === '内容', JSON.stringify(构3.块[1]));

      // ── ④ 标题里带行内公式，文字中部回车：公式一个字符不许丢 ──────────────────
      const file4 = hi.writeDoc('mid-enter-math.md', 公式体);
      await session.js(置文(公式体)); await hi.sleep(700);
      await session.js(放点('标题甲', 1)); await hi.sleep(150);
      const 前置4 = await session.js(读结构);
      ctx.assert('④ 前置：标题里的行内公式已经解析成源码节点', 前置4.公式条数 === 1 && 前置4.公式源码[0] === 'a+b=c', JSON.stringify(前置4.公式源码));
      await 回车(session);
      const 构4 = await session.js(读结构);
      const md4 = await hi.mdNow(session);
      ctx.witness('几何：带公式标题中部回车的块序列', { 块: 构4.块.map(b => b.tag + '[' + b.正文 + ']'), 公式源码: 构4.公式源码 }, 'geometry');
      ctx.log('④ 带公式中部：' + JSON.stringify(构4.块.map(b => b.tag + '[' + b.正文 + ']')) + ' 公式=' + JSON.stringify(构4.公式源码));
      ctx.assert('④ 左半「标」留在标题里', 构4.块[0].tag === 'H3' && 构4.块[0].正文 === '标', JSON.stringify(构4.块[0]));
      ctx.assert('④ 右半成为普通段落（公式跟着右半走，段落里看得见公式渲染）',
        构4.块[1] && 构4.块[1].tag === 'P' && 构4.块[1].公式.length === 1, JSON.stringify(构4.块[1]));
      ctx.assert('④ 行内公式**一个字符都不许丢**（源码节点仍恰好一条、内容原样）',
        构4.公式条数 === 1 && 构4.公式源码[0] === 'a+b=c', JSON.stringify({ 条数: 构4.公式条数, 源码: 构4.公式源码 }));
      ctx.assert('④ 文档层形态逐字：`### 标` + 普通段落 `题甲 $a+b=c$ 收尾`（无残骸、`$` 成对）',
        md4 === '### 标\n\n题甲 $a+b=c$ 收尾\n\n后文。\n', 显(md4));
      const 存4 = await hi.edge.saveAndWait(session, file4, { timeout: 8000 });
      ctx.witness('磁盘：④ 带公式标题中部拆分后的 markdown', { 盘: 显(存4.after) }, 'disk');
      ctx.assert('④ 磁盘上公式成对且原样（`$a+b=c$` 恰好一次、全文 `$` 恰好两个）',
        (String(存4.after).match(/\$a\+b=c\$/g) || []).length === 1 &&
        (String(存4.after).match(/\$/g) || []).length === 2, 显(存4.after));

      // ── ⑤ wrap：标题长到折行时，中部回车仍是同一形态 ─────────────────────────
      const file5 = hi.writeDoc('mid-enter-wrap.md', 折行体);
      await session.js(置文(折行体)); await hi.sleep(700);
      const 盒高 = await session.js(`(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector(${JSON.stringify(hi.SURFACE)});
        const h = s.children[0], p = s.children[s.children.length - 1]; if (!h || !p) return null;
        return { 标题盒高: Math.round(h.getBoundingClientRect().height), 段落盒高: Math.round(p.getBoundingClientRect().height) }; })()`);
      ctx.log('⑤ 折行前提：' + JSON.stringify(盒高));
      const 折行 = await session.js(放点('很长的标题文字', 6)); await hi.sleep(150);
      ctx.assert('⑤ 前置：这个长标题确实折了行（标题盒高 明显大于 一行普通段落）',
        盒高 && 盒高.段落盒高 > 0 && 盒高.标题盒高 > 盒高.段落盒高 * 1.5, JSON.stringify(盒高));
      ctx.assert('⑤ 前置：光标落在折行标题的文字中间', 折行.ok && 折行.偏移 === 6, JSON.stringify(折行));
      await 回车(session);
      const 构5 = await session.js(读结构);
      const 全文5 = await session.js(读全文);
      ctx.log('⑤ 折行中部：顶层=' + 构5.顶层 + ' 块=' + JSON.stringify(构5.块.map(b => b.tag + '(' + b.正文.length + ')')) + ' 全文=' + JSON.stringify((全文5 || []).map(t => t.length)));
      ctx.assert('⑤ 折行标题中部回车：左半仍在标题里（第一块是 H3、级别不变）',
        构5.块[0].tag === 'H3' && 构5.块[0].标题, JSON.stringify(构5.块[0]));
      ctx.assert('⑤ 右半成为普通段落（折行不许改写结构语义）',
        构5.块[1] && 构5.块[1].tag === 'P' && !构5.块[1].标题, JSON.stringify(构5.块[1]));
      ctx.assert('⑤ 折行拆分后全文逐字不丢（两半拼起来正好是原标题，次序不变）',
        Array.isArray(全文5) && 全文5[0] + 全文5[1] === '###' + 长标题, JSON.stringify((全文5 || []).map(t => t.length)));
      const 存5 = await hi.edge.saveAndWait(session, file5, { timeout: 8000 });
      ctx.witness('磁盘：⑤ 折行标题中部拆分后的 markdown', { 行数: 非空行(存5.after).length }, 'disk');
      ctx.assert('⑤ 磁盘上两行拼起来仍是原标题全文（折行拆分不吞字）',
        String(存5.after).replace(/[#\s]/g, '').trim() === 长标题 + '后文。', 显(行(存5.after).map(line => line.slice(0, 20) + '…')));

      ctx.metric('150 标题中部拆分后的块数', 构1.块.length, { direction: 'equal', unit: '块' });
      ctx.metric('150 折行标题拆分后右半字符数', 全文5[1].length, { direction: 'equal', unit: '字符' });
    } finally {
      await ctx.release(session);
    }

    // ══ 会话二：同族扩面——列表项、引用块、Shift+Enter 对照 ════════════════════
    const file6 = hi.writeDoc('mid-enter-list-quote.md', 列表体);
    const session2 = await hi.openDoc(ctx, file6, { minBlocks: 2 });
    try {
      ctx.assert('会话二 焦点在编辑器', (await hi.ensureFocus(session2)).ok, '');

      // ── ⑥ 列表项文字中部回车 ────────────────────────────────────────────────
      await session2.js(置文(列表体)); await hi.sleep(600);
      const 放6 = await session2.js(放点('甲乙丙', 1)); await hi.sleep(120);
      ctx.assert('⑥ 前置：光标落在列表项文字中间', 放6.ok && 放6.偏移 === 1, JSON.stringify(放6));
      await 回车(session2);
      const 构6 = await session2.js(读结构);
      const md6 = await hi.mdNow(session2);
      ctx.witness('几何：列表项中部回车的结构', { 顶层: 构6.顶层, 列表项: 构6.块[0].列表项, md: md6 }, 'geometry');
      ctx.log('⑥ 列表中部：顶层=' + 构6.顶层 + ' 列表项=' + JSON.stringify(构6.块[0].列表项) + ' md=' + 显(md6));
      ctx.assert('⑥ 列表项中部回车：拆成两个列表项、左半「甲」在前',
        构6.块[0].列表项.length === 2 && 构6.块[0].列表项[0] === '甲', JSON.stringify(构6.块[0]));
      ctx.assert('⑥ 右半「乙丙」留在同一条列表里（没被甩成普通段落、没丢字）',
        构6.块[0].列表项[1] === '乙丙' && 构6.顶层 === 'UL,P', JSON.stringify({ 顶层: 构6.顶层, 列表项: 构6.块[0].列表项 }));
      const 存6 = await hi.edge.saveAndWait(session2, file6, { timeout: 8000 });
      ctx.witness('磁盘：⑥ 列表项中部拆分后的 markdown', { 行: 行(存6.after) }, 'disk');
      ctx.assert('⑥ 磁盘：两行列表项、各自带 `- ` 前缀、文字逐字不丢',
        行(存6.after)[0] === '- 甲' && 行(存6.after)[1] === '- 乙丙' && 行(存6.after)[2] === '后文。', JSON.stringify(行(存6.after)));

      // ── ⑦ 引用块文字中部回车 ────────────────────────────────────────────────
      await session2.js(置文(引用体)); await hi.sleep(600);
      const 放7 = await session2.js(放点('甲乙丙', 1)); await hi.sleep(120);
      ctx.assert('⑦ 前置：光标落在引用块文字中间', 放7.ok && 放7.偏移 === 1, JSON.stringify(放7));
      await 回车(session2);
      const 构7 = await session2.js(读结构);
      const md7 = await hi.mdNow(session2);
      ctx.witness('几何：引用块中部回车的结构', { 顶层: 构7.顶层, 引用行: 构7.块[0].引用行, md: md7 }, 'geometry');
      ctx.log('⑦ 引用中部：顶层=' + 构7.顶层 + ' 引用行=' + JSON.stringify(构7.块[0].引用行) + ' md=' + 显(md7));
      ctx.assert('⑦ 引用块中部回车：仍是同一个引用块（顶层是 BLOCKQUOTE），左右两半各成一段',
        构7.顶层 === 'BLOCKQUOTE,P' && Array.isArray(构7.块[0].引用行) && 构7.块[0].引用行.length === 2, JSON.stringify({ 顶层: 构7.顶层, 引用行: 构7.块[0].引用行 }));
      ctx.assert('⑦ 文字逐字不丢、顺序不变（甲在前、乙丙在后）',
        构7.块[0].引用行[0].endsWith('甲') && 构7.块[0].引用行[1].endsWith('乙丙') &&
        构7.块[0].正文.replace(/\s/g, '') === '甲乙丙', JSON.stringify(构7.块[0]));
      const 存7 = await hi.edge.saveAndWait(session2, file6, { timeout: 8000 });
      ctx.witness('磁盘：⑦ 引用块中部拆分后的 markdown', { 行: 行(存7.after) }, 'disk');
      ctx.assert('⑦ 磁盘：仍是引用行（`>` 开头），左右两半各自成行、文字完好',
        /^>\s*甲$/.test(行(存7.after)[0]) && 行(存7.after).some(line => /^>\s*乙丙$/.test(line)), JSON.stringify(行(存7.after)));

      // ── ⑧ Shift+Enter 对照 ──────────────────────────────────────────────────
      // ⑧a 先把"软回车真的带着 Shift 送到页面"这件事钉住：正文里 Shift+Enter 是块内换行，
      //     块数不变。它红了说明探针的 Shift 没送到（那时 ⑧b 的读数不可信）。
      const file8 = hi.writeDoc('soft-enter-control.md', 软换行体);
      await session2.js(置文(软换行体)); await hi.sleep(600);
      await session2.js(放点('后文一。', 2)); await hi.sleep(120);
      await 软回车(session2);
      const 构8a = await session2.js(读结构);
      ctx.log('⑧a 正文里 Shift+Enter：顶层=' + 构8a.顶层 + ' 块=' + JSON.stringify(构8a.块.map(b => b.tag + '[' + b.正文 + ']')));
      ctx.assert('⑧a 对照：正文里 Shift+Enter 是块内软换行（还是同一块，没有拆成两段）',
        构8a.顶层 === 'P,P' && 构8a.块.length === 2 && 构8a.块[0].正文.replace(/\s/g, '') === '后文一。', JSON.stringify({ 顶层: 构8a.顶层, 块: 构8a.块.map(b => b.tag + '[' + b.正文 + ']') }));

      await session2.js(置文(标题体)); await hi.sleep(600);
      await session2.js(放点('标题内容', 1)); await hi.sleep(120);
      await 软回车(session2);
      const 构8b = await session2.js(读结构);
      const md8 = await hi.mdNow(session2);
      ctx.witness('几何：标题里 Shift+Enter 的形态（产品记档的已知边界）', { 顶层: 构8b.顶层, 块: 构8b.块.map(b => b.tag + '[' + b.正文 + ']'), md: md8 }, 'geometry');
      ctx.log('⑧b 标题里 Shift+Enter：顶层=' + 构8b.顶层 + ' 块=' + JSON.stringify(构8b.块.map(b => b.tag + '[' + b.正文 + ']')) + ' md=' + 显(md8));
      ctx.assert('⑧b 标题里 Shift+Enter 的形态＝与 Enter 同形（patchSoftBreak 明文"不接管标题：这版 Lute 会把换行拆成 h1+p"，本条是**登记**不是主张）',
        构8b.块[0].tag === 'H3' && 构8b.块[0].正文 === '标' && 构8b.块[1] && 构8b.块[1].tag === 'P' && 构8b.块[1].正文 === '题内容',
        JSON.stringify(构8b.块.map(b => b.tag + '[' + b.正文 + ']')));
      ctx.assert('⑧b 无论走哪条分支，文字逐字不丢', 构8b.块.map(b => b.正文).join('') === '标题内容后文。', JSON.stringify(构8b.块.map(b => b.正文)));

      ctx.metric('150 列表项中部拆分后的列表项数', 构6.块[0].列表项.length, { direction: 'equal', unit: '项' });
      ctx.metric('150 引用块中部拆分后的引用行数', (构7.块[0].引用行 || []).length, { direction: 'equal', unit: '行' });
    } finally {
      await ctx.release(session2);
    }

    // ══ 会话三：连续多次拆分 + 多次 Ctrl+Z 的还原链 ═════════════════════════════
    const file9 = hi.writeDoc('mid-enter-chain.md', 标题体);
    const 原件9 = fs.readFileSync(file9, 'utf8');
    const session3 = await hi.openDoc(ctx, file9, { minBlocks: 2 });
    try {
      ctx.assert('会话三 焦点在编辑器', (await hi.ensureFocus(session3)).ok, '');
      const md0 = await hi.mdNow(session3);

      const 拆 = async (片段, 相对) => { await session3.js(放点(片段, 相对)); await hi.sleep(140); await 回车(session3); return session3.js(读结构); };
      const 级1 = await 拆('标题内容', 1);
      ctx.log('⑨ 第 1 次拆分：' + JSON.stringify(级1.块.map(b => b.tag + '[' + b.正文 + ']')));
      ctx.assert('⑨ 第 1 次拆分：H3「标」+ P「题内容」',
        级1.块[0].tag === 'H3' && 级1.块[0].正文 === '标' && 级1.块[1].tag === 'P' && 级1.块[1].正文 === '题内容', JSON.stringify(级1.块.map(b => b.tag + '[' + b.正文 + ']')));
      const 级2 = await 拆('题内容', 1);
      ctx.log('⑨ 第 2 次拆分：' + JSON.stringify(级2.块.map(b => b.tag + '[' + b.正文 + ']')));
      ctx.assert('⑨ 第 2 次拆分：普通段落「题内容」也拆成两段（结构语义一贯）',
        级2.块[1].正文 === '题' && 级2.块[2].正文 === '内容' && 级2.块.length === 4, JSON.stringify(级2.块.map(b => b.tag + '[' + b.正文 + ']')));
      const 级3 = await 拆('内容', 1);
      ctx.log('⑨ 第 3 次拆分：' + JSON.stringify(级3.块.map(b => b.tag + '[' + b.正文 + ']')));
      ctx.assert('⑨ 第 3 次拆分后依然逐字不丢（拆到底也不许丢字）',
        级3.块.map(b => b.正文).join('') === '标题内容后文。' && 级3.块.length === 5, JSON.stringify(级3.块.map(b => b.正文)));

      // 磁盘证人（拆分态）：三次拆分的结果真的落盘，同时让"撤销回原件"不是空转
      const 存拆 = await hi.edge.saveAndWait(session3, file9, { timeout: 8000 });
      ctx.witness('磁盘：⑨ 三次拆分后保存的 markdown', { 行: 行(存拆.after) }, 'disk');
      ctx.assert('⑨ 三次拆分的结果真的落盘（盘上已是拆开的短行、原始整句不再出现）',
        行(存拆.after)[0] === '### 标' && !String(存拆.after).includes('标题内容'), JSON.stringify(行(存拆.after)));

      await 撤销(session3);
      const 回1 = await session3.js(读结构);
      await 撤销(session3);
      const 回2 = await session3.js(读结构);
      await 撤销(session3);
      const 回3 = await session3.js(读结构);
      const md3 = await hi.mdNow(session3);
      ctx.witness('几何：三次 Ctrl+Z 后的块序列', { 回1: 回1.块.map(b => b.正文), 回2: 回2.块.map(b => b.正文), 回3: 回3.块.map(b => b.正文) }, 'geometry');
      ctx.log('⑨ 撤销链：回1=' + JSON.stringify(回1.块.map(b => b.正文)) + ' 回2=' + JSON.stringify(回2.块.map(b => b.正文)) + ' 回3=' + JSON.stringify(回3.块.map(b => b.正文)));
      ctx.assert('⑨ 一次 Ctrl+Z 退回第 2 级中间态（四块：H3「标」+ 题 / 内容 / 后文。）',
        回1.块.length === 4 && 回1.块[0].tag === 'H3' && 回1.块[0].正文 === '标' && 回1.块[1].正文 === '题' && 回1.块[2].正文 === '内容',
        JSON.stringify(回1.块.map(b => b.tag + '[' + b.正文 + ']')));
      ctx.assert('⑨ 两次 Ctrl+Z 退回第 1 级中间态（三块）', 回2.块.length === 3 && 回2.块[0].tag === 'H3' && 回2.块[0].正文 === '标' && 回2.块[1].正文 === '题内容', JSON.stringify(回2.块.map(b => b.tag + '[' + b.正文 + ']')));
      ctx.assert('⑨ 三次 Ctrl+Z 完全复原（H3「标题内容」整体回来、后文不动）',
        回3.块.length === 2 && 回3.块[0].tag === 'H3' && 回3.块[0].正文 === '标题内容' && 回3.块[1].正文 === '后文。', JSON.stringify(回3.块.map(b => b.tag + '[' + b.正文 + ']')));
      ctx.assert('⑨ 三次撤销后内容逐字节回到打开时（文档层）', md3 === md0, JSON.stringify({ 回: 显(md3), 原: 显(md0) }));

      const 存9 = await hi.edge.saveAndWait(session3, file9, { timeout: 8000 });
      ctx.witness('磁盘：⑨ 三次撤销后保存（逐字节比对原件）', { 行: 行(存9.after), 与原件相同: 存9.after === 原件9 }, 'disk');
      ctx.assert('⑨ 撤销链走完存盘：磁盘逐字节回到原件', 存9.after === 原件9, JSON.stringify({ 盘: 显(存9.after), 原件: 显(原件9) }));

      ctx.metric('150 三次拆分后的块数', 级3.块.length, { direction: 'equal', unit: '块' });
      ctx.metric('150 三次撤销后的块数', 回3.块.length, { direction: 'equal', unit: '块' });
    } finally {
      await ctx.release(session3);
    }
  },
};
