/** 143 · 标题族：**级别与语法形态**面——H1..H6、Setext、七个井号、`#无空格`、前导/全角空格
 *
 *  139 锁的是「标题回车」的契约本体，141 把它铺到 8 种邻块上下文；本场景补的是同一族的
 *  另一根轴：**语法形态与级别**（覆盖率缺口矩阵 §4·143 的 Z1「标题族的 Enter 上下文与语法面」）。
 *
 *  覆盖的形态：
 *    · 级别切换（段落 → H1 / H6 / H5）：工具栏「标题」菜单的真实鼠标手势，键盘敲标记作兜底；
 *    · 标题 → 普通文字（光标在正文起点按退格：上一块是段落时按 94 的既有契约合并，字一个不丢）；
 *    · 带**行内公式**的段落切级别：公式条数与源码一个字符都不许少；
 *    · `####### 七个井号` 与 `#无空格`：载入时按**普通段落**处理，一个标题都不许产生；
 *    · Setext（`标题\n===` / `标题\n---`）：进 IR 后回车、退格**不许吃掉可见文字**；
 *    · `  # 前导空格` 与 `# 全角　空格`：回车、退格不许吞掉看得见的字符；
 *    · 五通道手势跑一遍：非编辑手势不许改文档（磁盘逐字节）。
 *
 *  手势：鼠标（点块正文、点标记左/右缘、点工具栏「标题」菜单项）、键盘（真 Enter / Backspace、
 *  Home / ← / → 定位、敲 `#` 与空格）、键鼠配合（Shift+单击选一整行）、组合键（Ctrl+Z 回退）、
 *  拖拽（跨两行标题拖选）。每段按键类读数前先 `hi.ensureFocus`；落点坐标一律由标记/文字矩形现算。
 *
 *  断言一律写用户看得见的东西：这一块还是不是标题、级别是几、看得见的字有没有少、
 *  磁盘上的字变成什么样。`geometry`（块 tag / 标记枚数 / 公式条数 / 光标层）＋
 *  `disk`（每种形态保存后逐行比对）两条独立通道。
 *
 *  **形态登记（开跑前用探针实测到的既有形态，不作为失败，只登记）**：
 *    · 探针实测 `Ctrl+1..6` / `Ctrl+0` 在本产品里对标题级别**没有作用**（真组合键打上去 DOM 不变），
 *      所以级别切换走工具栏菜单与真键盘敲标记这两条真有作用的路；两条都记在断言标签里。
 *    · Setext 的下划线长度会被归一化（`===` → `======`）；中段回车会把它拆成"文字段 + 空的下划线块"。
 *      本场景因此只钉"可见文字不丢"，不拿形态当失败（矩阵原文即如此要求）。
 *    · 段落行首敲 `#` 会被重新解析成标题（`####### 七个井号` 中段回车 → `##` 与 `##### 七个井号`
 *      各自成标题）：这是"两半各自重新解析"的既有语义，登记而不判红。
 *
 *  突变验证（把修复注掉必须变红——写在这里就是为了让后人一眼能找到"哪一行"）：
 *    · `app/renderer/js/typora-patches.js` 的 `patchHeadingEnter`（L445 起）里
 *      「只认 ATX 形态」的守卫 `if (!/^#{1,6}[ \t]*$/.test(marker.textContent)) return false;`
 *      （L488–490）注掉 → Setext 的形态会被 ATX 分支吞掉，② 的"可见文字不丢"与
 *      "不许凭空长出井号"立刻变红。
 *    · `app/renderer/js/marker-caret-guard.js` 的 `installMarkerCaretGuard`（L154）注掉 →
 *      点标记左缘不再留在块首，⑤ 的前置与 ④ 的落盘断言变红（块首退格会去吃 `#`）。
 */

'use strict';
const fs = require('node:fs');
const hi = require('../../human-input/hi.cjs');

/** 块序列 + 标记枚数 + 公式条数 + 光标层（几何口径，不看产品自报）。 */
const 读结构 = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
  if (!s) return { ok: false };
  const fr = document.getElementById('editor').getBoundingClientRect();
  const 块 = [...s.children].map(b => {
    const 是标题 = /^H[1-6]$/.test(b.tagName);
    const 标记 = b.querySelector('[data-type="heading-marker"]');
    const 正文 = 标记 ? [...b.childNodes].filter(n => !(n.nodeType === 1 && n.getAttribute('data-type') === 'heading-marker'))
      .map(n => n.textContent).join('') : b.textContent;
    return { tag: b.tagName, 标题: 是标题, 级别: 是标题 ? Number(b.tagName[1]) : 0,
      标记: 标记 ? 标记.textContent : null, 标记数: b.querySelectorAll('[data-type="heading-marker"]').length,
      空: !正文.replace(/[\\s\\u200b\\u3000]/g, ''), 文本: b.textContent.replace(/\\u200b/g, '').slice(0, 30) };
  });
  const sel = w.getSelection(); const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const at = r ? (r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer) : null;
  let 光标 = null;
  if (r) { const box = r.getBoundingClientRect();
    光标 = { 折叠: r.collapsed, 偏移: r.startOffset,
      层: !at || !s.contains(at) ? '外' : at.closest('h1,h2,h3,h4,h5,h6') ? '标题' : at.closest('p') ? '段'
        : at.closest('code[data-type]') ? '源码' : at.closest('[data-type$="-marker"]') ? '围栏' : '其他',
      x: Math.round(fr.x + box.left), y: Math.round(fr.y + box.top), h: Math.round(box.height) }; }
  return { ok: true, 块, 光标, 标题数: s.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
    标记总数: s.querySelectorAll('[data-type="heading-marker"]').length,
    行内公式: s.querySelectorAll('code[data-type="math-inline"]').length,
    公式预览: s.querySelectorAll('.language-math').length,
    全文: s.textContent.replace(/\\u200b/g, '').replace(/\\s+/g, ' ').trim().slice(0, 200) }; })()`;

/** 第 i 块的几何：正文中点 +（标题才有）标记左右缘（顶层页坐标）。 */
const 块几何 = i => `(() => { const w = ${hi.IF}, d = w.document; const fr = document.getElementById('editor').getBoundingClientRect();
  const s = d.querySelector('${hi.SURFACE}'); const b = s.children[${i}]; if (!b) return { ok: false };
  b.scrollIntoView({ block: 'center', behavior: 'instant' });
  const m = b.querySelector('[data-type="heading-marker"]');
  const mr = m ? m.getBoundingClientRect() : null;
  const direct = [...b.childNodes].filter(n => n.nodeType === 3 && n.data.replace(/[\\s\\u200b\\u3000]/g, ''));
  let t = direct.length ? direct[direct.length - 1] : null;
  if (!t) { const walker = d.createTreeWalker(b, NodeFilter.SHOW_TEXT); let n = null;
    while ((n = walker.nextNode())) { if (n.data.replace(/[\\s\\u200b\\u3000]/g, '')) { t = n; break; } } }
  const tr = t ? (() => { const q = d.createRange(); q.selectNodeContents(t); return q.getBoundingClientRect(); })() : null;
  return { ok: true, tag: b.tagName, 标记: m ? m.textContent : null,
    标记右缘: mr ? { x: Math.round(fr.x + mr.right + 2), y: Math.round(fr.y + mr.top + mr.height / 2) } : null,
    标记左缘: mr ? { x: Math.round(fr.x + mr.left + 1), y: Math.round(fr.y + mr.top + mr.height / 2) } : null,
    正文中点: tr ? { x: Math.round(fr.x + tr.left + tr.width / 2), y: Math.round(fr.y + tr.top + tr.height / 2) } : null,
    正文左缘: tr ? { x: Math.round(fr.x + tr.left + 2), y: Math.round(fr.y + tr.top + tr.height / 2) } : null }; })()`;

/** 光标相对第 i 块开头的位置：`前缀` = 这一块开头到光标的那段文字。 */
const 读块位 = i => `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
  const b = s.children[${i}]; if (!b) return { ok: false, why: '没有第 ${i} 块' };
  const sel = w.getSelection(); if (!sel || !sel.rangeCount) return { ok: false, why: '没有选区' };
  const r = sel.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  if (!at || !b.contains(at)) return { ok: false, why: '光标不在这一块里' };
  const pre = d.createRange(); pre.selectNodeContents(b); pre.setEnd(r.startContainer, r.startOffset);
  const 前缀 = pre.toString();
  const m = b.querySelector('[data-type="heading-marker"]'); const 标记文本 = m ? m.textContent : '';
  return { ok: true, 前缀, 标记文本, 块序: ${i}, tag: b.tagName, 折叠: r.collapsed,
    在标记里: !!(at.closest && m && m.contains(at)),
    在标记之后: !!m && 前缀 === 标记文本, 在块首: 前缀 === '' }; })()`;

const 置文 = md => `(() => { const w = ${hi.IF}; w.vditor.setValue(${JSON.stringify(md)}); return true; })()`;

const 规范 = text => String(text).replace(/\r/g, '').split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n');
const 非空行 = text => 规范(text).split('\n').filter(line => line.trim());
/** 可见字符（去掉所有空白与零宽）——"有没有吞字"的唯一口径。 */
const 可见 = text => String(text).replace(/[\s\u200b]/g, '');
/** 文字口径：再去掉 Setext 下划线那两种形态字符（`=` / `-`），只留用户真正写的字。 */
const 文字 = text => 可见(text).replace(/[=\-]/g, '');

async function 回车(session) { await session.key({ key: 'Enter', code: 'Enter', vk: 13, text: '\r' }); await hi.sleep(430); }
async function 退格(session) { await session.key({ key: 'Backspace', code: 'Backspace', vk: 8 }); await hi.sleep(430); }
async function 撤销(session) { await hi.combo(session, 'Ctrl+z'); await hi.sleep(540); }

/** 把光标送到第 i 块的最前面（真实手势：点这一块正文 → Home → 兜底 ←）。 */
async function 到某块首(session, i) {
  const 轨迹 = [];
  const g = await session.js(块几何(i));
  if (!g.ok) return { ok: false, why: '没有第 ' + i + ' 块', 轨迹 };
  if (g.正文中点) { await session.click(g.正文中点.x, g.正文中点.y); await hi.sleep(340); }
  let 位 = await session.js(读块位(i));
  轨迹.push({ 步: '点正文', 前缀: 位.前缀, tag: 位.tag });
  if (位.ok && 位.在块首) return { ok: true, how: '点正文', 轨迹, 位 };
  await session.key({ key: 'Home', code: 'Home', vk: 36 }); await hi.sleep(340);
  位 = await session.js(读块位(i));
  轨迹.push({ 步: 'Home', 前缀: 位.前缀 });
  if (位.ok && 位.在块首) return { ok: true, how: 'Home', 轨迹, 位 };
  for (let n = 0; n < 4; n++) {
    await session.key({ key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }); await hi.sleep(200);
    位 = await session.js(读块位(i));
    if (位.ok && 位.在块首) { 轨迹.push({ 步: '←×' + (n + 1) }); return { ok: true, how: '←×' + (n + 1), 轨迹, 位 }; }
  }
  return { ok: false, why: '没走到这一块的开头', 轨迹, 位 };
}

/** 把光标送到标题的**正文起点**（标记整枚在左、光标在标记里或正文 offset 0）：
 *  点标题正文 → Home（标题行上 Home 落在标记之后）→ 兜底点标记右缘。 */
async function 到正文起点(session, i) {
  const 轨迹 = [];
  let g = await session.js(块几何(i));
  if (!g.ok) return { ok: false, why: '没有第 ' + i + ' 块', 轨迹 };
  if (g.正文中点) { await session.click(g.正文中点.x, g.正文中点.y); await hi.sleep(340); }
  let 位 = await session.js(读块位(i));
  轨迹.push({ 步: '点正文', 前缀: 位.前缀, 在标记之后: 位.在标记之后 });
  if (位.ok && 位.在标记之后) return { ok: true, how: '点正文', 轨迹, 位 };
  await session.key({ key: 'Home', code: 'Home', vk: 36 }); await hi.sleep(340);
  位 = await session.js(读块位(i));
  轨迹.push({ 步: 'Home', 前缀: 位.前缀, 在标记之后: 位.在标记之后 });
  if (位.ok && 位.在标记之后) return { ok: true, how: 'Home', 轨迹, 位 };
  g = await session.js(块几何(i));
  if (g.标记右缘) {
    await session.click(g.标记右缘.x, g.标记右缘.y); await hi.sleep(360);
    位 = await session.js(读块位(i));
    轨迹.push({ 步: '点标记右缘', 前缀: 位.前缀, 在标记之后: 位.在标记之后 });
    if (位.ok && 位.在标记之后) return { ok: true, how: '点标记右缘', 轨迹, 位 };
  }
  return { ok: false, why: '没走到这一块的正文起点', 轨迹, 位 };
}

/** 工具栏「标题」菜单：点开 → 点第 级 项（真实鼠标）。按钮按 Vditor 的 `data-type="headings"` 认，
 *  菜单项按 `data-value`（`### ` 这种）认——都不靠文案。 */
async function 菜单切级别(session, 级) {
  const 值 = '#'.repeat(级) + ' ';
  const 按钮 = await session.js(`(() => { const cand = [...document.querySelectorAll('.vditor-toolbar button, .vditor-toolbar__item')];
    const e = cand.find(x => x.getAttribute('data-type') === 'headings' || /headings/.test(String(x.getAttribute('data-name') || '')))
      || cand.find(x => [...x.querySelectorAll('use')].some(u => /headings/.test(String(u.getAttribute('href') || u.getAttribute('xlink:href') || ''))));
    if (!e) return { ok: false, why: '没有「标题」菜单按钮' };
    const r = e.getBoundingClientRect(); if (r.width < 1) return { ok: false, why: '按钮不可见' };
    return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  if (!按钮.ok) return { ...按钮, 步: '找按钮' };
  await session.click(按钮.x, 按钮.y); await hi.sleep(720);
  const 项 = await session.js(`(() => { const b = [...document.querySelectorAll('.vditor-hint button')].find(x => x.getAttribute('data-value') === ${JSON.stringify(值)});
    if (!b || b.getBoundingClientRect().height < 1) return { ok: false, why: '菜单项不可见' };
    const r = b.getBoundingClientRect(); return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 文案: b.textContent.trim() }; })()`);
  if (!项.ok) { await session.key({ key: 'Escape', code: 'Escape', vk: 27 }); await hi.sleep(320); return { ...项, 步: '找菜单项' }; }
  await session.click(项.x, 项.y); await hi.sleep(820);
  return { ok: true, 级, 文案: 项.文案 };
}

/** 把第 i 块改成 H级：先走工具栏菜单（真实鼠标），没成再在这一块开头真敲 `### `。 */
async function 改级别(session, i, 级, ctx) {
  const 轨迹 = [];
  const 位 = await 到某块首(session, i);
  轨迹.push({ 步: '定位到块首', ok: 位.ok, how: 位.how });
  if (!位.ok) return { ok: false, why: '没定位到这一块开头', 轨迹 };
  const 菜单 = await 菜单切级别(session, 级);
  轨迹.push({ 步: '工具栏菜单', ok: 菜单.ok, why: 菜单.why, 文案: 菜单.文案 });
  let 构 = await session.js(读结构);
  if (构.块[i] && 构.块[i].tag === 'H' + 级) return { ok: true, how: '工具栏菜单 → ' + (菜单.文案 || ('H' + 级)), 轨迹, 构 };
  for (let n = 0; n < 级; n++) { await session.key({ key: '#', code: 'Digit3', vk: 51, text: '#' }); await hi.sleep(60); }
  await session.key({ key: ' ', code: 'Space', vk: 32, text: ' ' }); await hi.sleep(620);
  构 = await session.js(读结构);
  轨迹.push({ 步: '键盘敲 `' + '#'.repeat(级) + ' `', tag: 构.块[i] ? 构.块[i].tag : null });
  if (构.块[i] && 构.块[i].tag === 'H' + 级) return { ok: true, how: '键盘敲 `' + '#'.repeat(级) + ' `', 轨迹, 构 };
  return { ok: false, why: '两条路都没把这一块变成 H' + 级, 轨迹, 构 };
}

module.exports = {
  id: '143-heading-level-and-syntax-family',
  title: '标题族级别与语法形态：级别切换（含公式标题）、Setext、七个井号、#无空格、前导/全角空格，全程磁盘比对',
  run: async ctx => {
    // ══ 会话一：级别切换（工具栏「标题」菜单 + 真键盘）＋ 标题→普通文字（正文起点退格） ══
    const 文件1 = hi.writeDoc('143-levels.md', ['甲段落', '', '乙段落', '', '正文甲。', ''].join('\n'));
    const 会话1 = await hi.openDoc(ctx, 文件1, { minBlocks: 3 });
    try {
      ctx.assert('① 焦点在编辑器（按键/鼠标类读数前置）', (await hi.ensureFocus(会话1)).ok, '');
      const 构0 = await 会话1.js(读结构);
      ctx.assert('① 前置：三块都是普通段落、一个标题都没有',
        构0.ok && 构0.块[0].tag === 'P' && 构0.块[1].tag === 'P' && 构0.标题数 === 0 && 构0.标记总数 === 0,
        JSON.stringify(构0.块.map(b => b.tag)));

      // ── 第一段 → 一级标题 ────────────────────────────────────────────────────────
      const 改1 = await 改级别(会话1, 0, 1, ctx);
      ctx.assert(`① 段落切一级标题：真的切成了（走法：${改1.how || '未成功'}）`, 改1.ok === true, JSON.stringify(改1.轨迹 || 改1));
      if (改1.ok) {
        const 构1 = await 会话1.js(读结构);
        ctx.assert('① 第一块变成 H1、级别是 1、标记恰好一枚 `# `',
          构1.块[0].tag === 'H1' && 构1.块[0].级别 === 1 && 构1.块[0].标记数 === 1 && 构1.块[0].标记 === '# ',
          JSON.stringify(构1.块.slice(0, 3)));
        ctx.assert('① 切级别不吃字：`甲段落` 与其它两块一字不少',
          可见(构1.全文).includes('甲段落') && 可见(构1.全文).includes('乙段落') && 可见(构1.全文).includes('正文甲。'),
          JSON.stringify(构1.全文));
        ctx.witness('几何：① 段落切 H1 后的块序列', { 块: 构1.块, 光标: 构1.光标 }, 'geometry');

        // ── 第二段 → 六级标题（同一入口的另一级，验级别不串） ──────────────────────
        const 改2 = await 改级别(会话1, 1, 6, ctx);
        ctx.assert(`① 段落切六级标题：真的切成了（走法：${改2.how || '未成功'}）`, 改2.ok === true, JSON.stringify(改2.轨迹 || 改2));
        if (改2.ok) {
          const 构2 = await 会话1.js(读结构);
          ctx.assert('① 第二块变成 H6、级别是 6、标记恰好一枚 `###### `',
            构2.块[1].tag === 'H6' && 构2.块[1].级别 === 6 && 构2.块[1].标记数 === 1 && 构2.块[1].标记 === '###### ',
            JSON.stringify(构2.块.slice(0, 3)));
          ctx.assert('① 两级标题并存：H1 与 H6 各就各位、级别没有串（1 与 6）',
            构2.块[0].级别 === 1 && 构2.块[1].级别 === 6 && 构2.标题数 === 2, JSON.stringify(构2.块.map(b => b.tag)));
          const 盘1 = await hi.edge.saveAndWait(会话1, 文件1, { timeout: 9000 });
          ctx.witness('磁盘：① 段落切成 H1/H6 后的文件', { 后: 规范(盘1.after) }, 'disk');
          ctx.assert('① 落盘：`# 甲段落` 与 `###### 乙段落` 各占一行（级别真的写进 Markdown）',
            /^#[ \t]+甲段落[ \t]*$/m.test(规范(盘1.after)) && /^#{6}[ \t]+乙段落[ \t]*$/m.test(规范(盘1.after)),
            JSON.stringify(非空行(盘1.after)));
          ctx.assert('① 落盘：正文一行没被牵动（`正文甲。` 原样）',
            非空行(盘1.after).includes('正文甲。'), JSON.stringify(非空行(盘1.after)));
          // 组合键：连撤（最多 4 次）回到普通段落
          let 回1 = await 会话1.js(读结构);
          for (let n = 0; n < 4 && 回1.标题数 > 0; n++) { await 撤销(会话1); 回1 = await 会话1.js(读结构); }
          ctx.assert('① 连按 Ctrl+Z：两级标题都退回普通段落（撤得回来、不留半个标记）',
            回1.标题数 === 0 && 回1.标记总数 === 0 && 可见(回1.全文).includes('甲段落') && 可见(回1.全文).includes('乙段落'),
            JSON.stringify({ 块: 回1.块.map(b => b.tag), 标记: 回1.标记总数 }));
        }
      }

      // ── 标题 → 普通文字：光标在正文起点按退格 ────────────────────────────────────
      await 会话1.js(置文(['上一段。', '', '### 目标标题', '', '后文。', ''].join('\n'))); await hi.sleep(760);
      const 位3 = await 到正文起点(会话1, 1);
      ctx.assert(`①′ 前置：光标走到标题正文起点（走法：${位3.how || '未成功'}）`,
        位3.ok === true && 位3.位 && 位3.位.在标记之后 === true, JSON.stringify(位3.轨迹 || 位3));
      await 退格(会话1);
      const 构3 = await 会话1.js(读结构);
      ctx.assert('①′ 正文起点退格：标题级别没了（`# ` 消失、这一行不再是标题）',
        构3.标题数 === 0 && !可见(构3.全文).includes('#'),
        JSON.stringify(构3.块.map(b => b.tag + (b.标记 || ''))) + ' ' + JSON.stringify(构3.全文));
      ctx.assert('①′ 降级/合并之后一个字都没丢（`上一段。`、`目标标题`、`后文。` 都还在）',
        可见(构3.全文).includes('上一段。目标标题') && 可见(构3.全文).includes('后文。'), JSON.stringify(构3.全文));
      let 回3 = await 会话1.js(读结构);
      for (let n = 0; n < 3 && 回3.标题数 === 0; n++) { await 撤销(会话1); 回3 = await 会话1.js(读结构); }
      const 序3 = 回3.块.findIndex(b => b.标题);
      ctx.assert('①′ Ctrl+Z 把标题要回来（`# ` 与标题级别都回来了）',
        回3.标题数 === 1 && 序3 >= 0 && 回3.块[序3].文本 === '### 目标标题', JSON.stringify(回3.块.map(b => b.tag + (b.标记 || ''))));
      const 盘3 = await hi.edge.saveAndWait(会话1, 文件1, { timeout: 9000 });
      ctx.witness('磁盘：①′ 撤销之后的文件', { 后: 规范(盘3.after) }, 'disk');
      ctx.assert('①′ 落盘：`### 目标标题` 回到磁盘上、`上一段。` 仍在（撤销是可见的、可落盘的）',
        规范(盘3.after).includes('### 目标标题') && 非空行(盘3.after).includes('上一段。'), JSON.stringify(非空行(盘3.after)));
      await 会话1.shot('143-①级别切换');
    } finally {
      await ctx.release(会话1);
    }

    // ══ 会话二：带**行内公式**的段落切级别——公式条数与源码一个字符都不许少 ═══════════
    const 文件2 = hi.writeDoc('143-inline-math.md', ['甲含 $x$ 公式', '', '正文甲。', ''].join('\n'));
    const 会话2 = await hi.openDoc(ctx, 文件2, { minBlocks: 2 });
    try {
      ctx.assert('①″ 焦点在编辑器', (await hi.ensureFocus(会话2)).ok, '');
      const 构m0 = await 会话2.js(读结构);
      ctx.assert('①″ 前置：段落里有一枚行内公式（`$x$`）',
        构m0.块[0].tag === 'P' && 构m0.行内公式 === 1, JSON.stringify({ 块: 构m0.块[0], 公式: 构m0.行内公式 }));
      const 改m = await 改级别(会话2, 0, 5, ctx);
      ctx.assert(`①″ 带公式的段落切五级标题：真的切成了（走法：${改m.how || '未成功'}）`, 改m.ok === true, JSON.stringify(改m.轨迹 || 改m));
      if (改m.ok) {
        const 构m1 = await 会话2.js(读结构);
        ctx.assert('①″ 切级别后是 H5、标记恰好一枚、级别是 5',
          构m1.块[0].tag === 'H5' && 构m1.块[0].标记数 === 1 && 构m1.块[0].级别 === 5, JSON.stringify(构m1.块.slice(0, 2)));
        ctx.assert('①″ 切级别**不吃行内公式**：公式条数还是 1',
          构m1.行内公式 === 1, JSON.stringify({ 公式: 构m1.行内公式, 文本: 构m1.块[0].文本 }));
        ctx.witness('几何：①″ 带公式的标题切级别后', { 块: 构m1.块, 公式: 构m1.行内公式 }, 'geometry');
        const 盘m = await hi.edge.saveAndWait(会话2, 文件2, { timeout: 9000 });
        ctx.witness('磁盘：①″ 带行内公式的标题切级别后', { 后: 规范(盘m.after) }, 'disk');
        ctx.assert('①″ 落盘：`##### 甲含 $x$ 公式`（美元号成对、标题文字一个字符不少）',
          /^#{5}[ \t]+甲含[ \t]*\$x\$[ \t]*公式[ \t]*$/m.test(规范(盘m.after)), JSON.stringify(非空行(盘m.after)));
      }
    } finally {
      await ctx.release(会话2);
    }

    // ══ 会话三：七个井号 / `#无空格`——载入时按普通段落处理，一个标题都不许产生 ════════
    const 文件3 = hi.writeDoc('143-not-headings.md', ['####### 七个井号', '', '#无空格', '', '正文甲。', ''].join('\n'));
    const 原件3 = fs.readFileSync(文件3, 'utf8');
    const 会话3 = await hi.openDoc(ctx, 文件3, { minBlocks: 3 });
    try {
      ctx.assert('③ 焦点在编辑器', (await hi.ensureFocus(会话3)).ok, '');
      const 构p = await 会话3.js(读结构);
      ctx.witness('几何：③ 七个井号 / `#无空格` 的块序列', { 块: 构p.块 }, 'geometry');
      ctx.assert('③ `####### 七个井号` 不是标题（是普通段落，可落光标）',
        构p.块[0].tag === 'P' && 构p.块[0].标题 === false, JSON.stringify(构p.块[0]));
      ctx.assert('③ `#无空格` 也不是标题（井号后没有空格就不成标题）',
        构p.块[1].tag === 'P' && 构p.块[1].标题 === false, JSON.stringify(构p.块[1]));
      ctx.assert('③ 屏上**一个标题都没有**、一块标题标记都没有',
        构p.标题数 === 0 && 构p.标记总数 === 0, JSON.stringify({ 标题数: 构p.标题数, 标记总数: 构p.标记总数 }));
      // 键盘：在第一行中部回车。两半各自重新解析是既有语义（登记），这里钉"不丢字 + 邻行原样"
      const 位7 = await 到某块首(会话3, 0);
      ctx.assert(`③ 前置：光标落在第一行开头（走法：${位7.how || '未成功'}）`, 位7.ok === true, JSON.stringify(位7.轨迹 || 位7));
      for (let n = 0; n < 2; n++) { await 会话3.key({ key: 'ArrowRight', code: 'ArrowRight', vk: 39 }); await hi.sleep(150); }
      const 回车前 = 可见((await 会话3.js(读结构)).全文);
      await 回车(会话3);
      const 构7 = await 会话3.js(读结构);
      ctx.log('七个井号行中段回车的形态登记（两半各自重新解析）：' + JSON.stringify(构7.块.map(b => b.tag + (b.标记 || ''))));
      ctx.assert('③ 七个井号行回车：可见字符一个没少（把两行拼起来还是原来那些字）',
        可见(构7.全文) === 回车前, JSON.stringify({ 前: 回车前, 后: 可见(构7.全文) }));
      ctx.assert('③ 七个井号行回车：没动别的块（`#无空格` 与 `正文甲。` 原样）',
        可见(构7.全文).includes('#无空格') && 可见(构7.全文).includes('正文甲。'), JSON.stringify(构7.全文));
      await 撤销(会话3);
      const 盘3 = await hi.edge.saveAndWait(会话3, 文件3, { timeout: 9000 });
      ctx.witness('磁盘：③ 撤销之后的文件', { 前: 规范(原件3), 后: 规范(盘3.after) }, 'disk');
      ctx.assert('③ 落盘：撤销之后磁盘回到打开时的原文（没人偷偷把它写成标题）',
        规范(盘3.after) === 规范(原件3), JSON.stringify({ 后: 非空行(盘3.after), 原: 非空行(原件3) }));
      await 会话3.shot('143-③七个井号与无空格');
    } finally {
      await ctx.release(会话3);
    }

    // ══ 会话四：Setext（`标题\n===` / `标题\n---`）——回车、退格都不许丢可见文字 ═════════
    const 文件4 = hi.writeDoc('143-setext.md', ['一级甲', '===', '', '二级乙', '---', '', '正文甲。', ''].join('\n'));
    const 原件4 = fs.readFileSync(文件4, 'utf8');
    const 会话4 = await hi.openDoc(ctx, 文件4, { minBlocks: 2 });
    try {
      ctx.assert('② 焦点在编辑器', (await hi.ensureFocus(会话4)).ok, '');
      const 构s0 = await 会话4.js(读结构);
      ctx.witness('几何：② Setext 进入 IR 后的块序列', { 块: 构s0.块 }, 'geometry');
      ctx.log('Setext 形态登记：' + JSON.stringify(构s0.块.map(b => b.tag + (b.标记 ? JSON.stringify(b.标记) : ''))));
      ctx.assert('② 两条 Setext 都进编辑面、都被认成标题（`一级甲` = H1 / `二级乙` = H2）',
        构s0.块[0].tag === 'H1' && 构s0.块[1].tag === 'H2' && 可见(构s0.全文).includes('一级甲') && 可见(构s0.全文).includes('二级乙'),
        JSON.stringify(构s0.块.map(b => b.tag)));
      // 行内回车：在标题文字里分段，可见文字不许丢（下划线 `=`/`-` 属形态字符，见文件头登记）
      const g4 = await 会话4.js(块几何(0));
      ctx.assert('② 前置：拿到第一行 Setext 标题的几何', g4.ok === true, JSON.stringify(g4));
      await 会话4.click(g4.正文中点.x, g4.正文中点.y); await hi.sleep(420);
      const 位s = await 会话4.js(读块位(0));
      ctx.assert('② 前置：光标落在第一行标题**文字**里',
        位s.ok === true && /^[一级甲]*$/.test(位s.前缀), JSON.stringify(位s));
      const 前s = 文字((await 会话4.js(读结构)).全文);
      await 回车(会话4);
      const 构s1 = await 会话4.js(读结构);
      ctx.assert('② Setext 标题里回车：可见文字一个都不少（`一级甲`、`二级乙`、`正文甲。` 的字全在）',
        文字(构s1.全文) === 前s, JSON.stringify({ 前: 前s, 后: 文字(构s1.全文), 块: 构s1.块.map(b => b.tag) }));
      ctx.assert('② Setext 标题里回车：光标没被甩出编辑面',
        构s1.光标 && 构s1.光标.层 !== '外', JSON.stringify(构s1.光标));
      ctx.assert('② Setext 标题里回车：不许凭空长出井号（不把 Setext 改写成 ATX）',
        !可见(构s1.全文).includes('#'), JSON.stringify(构s1.全文));
      const 盘s1 = await hi.edge.saveAndWait(会话4, 文件4, { timeout: 9000 });
      ctx.witness('磁盘：② Setext 回车后的文件', { 后: 规范(盘s1.after) }, 'disk');
      ctx.assert('② Setext 回车后落盘：可见文字与原文一致（一字不多、一字不少）',
        文字(规范(盘s1.after)) === 文字(规范(原件4)), JSON.stringify({ 后: 非空行(盘s1.after), 原: 非空行(原件4) }));
      // 退格：只许吃一个字符，不许连坐
      await 会话4.js(置文(原件4)); await hi.sleep(780);
      const g4b = await 会话4.js(块几何(0));
      await 会话4.click(g4b.正文中点.x, g4b.正文中点.y); await hi.sleep(420);
      const 位s2 = await 会话4.js(读块位(0));
      ctx.assert('② 前置：退格前光标也在第一行标题文字里',
        位s2.ok === true && /^[一级甲]*$/.test(位s2.前缀) && 位s2.前缀.length >= 1, JSON.stringify(位s2));
      const 前s2 = 文字((await 会话4.js(读结构)).全文);
      await 退格(会话4);
      const 构s2 = await 会话4.js(读结构);
      const 后s2 = 文字(构s2.全文);
      ctx.log(`Setext 退格形态登记：前 ${JSON.stringify(前s2)} → 后 ${JSON.stringify(后s2)}`);
      ctx.assert('② Setext 行内退格：只吃掉光标左边那一个字符，别的字一个不少',
        后s2.length === 前s2.length - 1 && 后s2.includes('二级乙') && 后s2.includes('正文甲。'),
        JSON.stringify({ 前: 前s2, 后: 后s2 }));
      await 撤销(会话4);
      const 盘s3 = await hi.edge.saveAndWait(会话4, 文件4, { timeout: 9000 });
      ctx.witness('磁盘：② Setext 退格并撤销后的文件', { 前: 规范(原件4), 后: 规范(盘s3.after) }, 'disk');
      ctx.assert('② 退格之后 Ctrl+Z：被吃掉的那个字回来了（可见文字与原文一致）',
        文字(规范(盘s3.after)) === 文字(规范(原件4)), JSON.stringify({ 后: 非空行(盘s3.after), 原: 非空行(原件4) }));
      await 会话4.shot('143-②Setext');
    } finally {
      await ctx.release(会话4);
    }

    // ══ 会话五：前导空格 / 全角空格的标题——回车、退格不许吞看得见的字符 ═══════════════
    const 文件5 = hi.writeDoc('143-spaced-headings.md',
      ['  # 前导空格标题', '', '# 全角　空格标题', '', '正文甲。', ''].join('\n'));
    const 原件5 = fs.readFileSync(文件5, 'utf8');
    const 会话5 = await hi.openDoc(ctx, 文件5, { minBlocks: 3 });
    try {
      ctx.assert('④ 焦点在编辑器', (await hi.ensureFocus(会话5)).ok, '');
      const 构k0 = await 会话5.js(读结构);
      ctx.witness('几何：④ 前导/全角空格标题的块序列', { 块: 构k0.块 }, 'geometry');
      ctx.log('空格标题形态登记：' + JSON.stringify(构k0.块.map(b => b.tag + (b.标记 ? JSON.stringify(b.标记) : ''))));
      ctx.assert('④ 前导空格标题仍是标题、可见文字 `前导空格标题` 全在',
        构k0.块[0].标题 === true && 可见(构k0.全文).includes('前导空格标题'), JSON.stringify(构k0.块[0]));
      ctx.assert('④ 全角空格标题仍是标题、可见文字 `全角空格标题` 全在',
        构k0.块[1].标题 === true && 可见(构k0.全文).includes('全角空格标题'), JSON.stringify(构k0.块[1]));

      // ④-1 前导空格标题：光标停在正文起点按回车 —— 与 141 同一条契约（标记钉原行）
      const 位k = await 到正文起点(会话5, 0);
      ctx.assert(`④ 前置：光标走到前导空格标题的正文起点（走法：${位k.how || '未成功'}）`,
        位k.ok === true && 位k.位 && 位k.位.在标记之后 === true, JSON.stringify(位k.轨迹 || 位k));
      const 首块前 = 构k0.块[0].tag;
      await 回车(会话5);
      const 构k1 = await 会话5.js(读结构);
      ctx.assert('④ 前导空格标题回车：可见文字一个不少（两个标题的文字都还在）',
        可见(构k1.全文).includes('前导空格标题') && 可见(构k1.全文).includes('全角空格标题'), JSON.stringify(构k1.全文));
      ctx.assert('④ 前导空格标题回车：第一块仍是标题且只剩标记、内容落到下一行普通段落（与 141 同一条契约）',
        构k1.块[0].tag === 首块前 && 构k1.块[0].空 && 构k1.块[1].tag === 'P' && 构k1.块[1].文本 === '前导空格标题',
        JSON.stringify(构k1.块.slice(0, 2)));
      const 盘k1 = await hi.edge.saveAndWait(会话5, 文件5, { timeout: 9000 });
      ctx.witness('磁盘：④ 前导空格标题回车后', { 后: 规范(盘k1.after) }, 'disk');
      ctx.assert('④ 落盘：`前导空格标题`、`全角　空格标题`、`正文甲。` 都在（没有哪一行被吞掉）',
        ['前导空格标题', '全角　空格标题', '正文甲。'].every(w => 规范(盘k1.after).includes(w)), JSON.stringify(非空行(盘k1.after)));

      // ④-2 全角空格标题：光标停在正文起点按退格 —— 可见字符不许被吞
      await 会话5.js(置文(原件5)); await hi.sleep(780);
      const 位k2 = await 到正文起点(会话5, 1);
      ctx.assert(`④ 前置：光标走到全角空格标题的正文起点（走法：${位k2.how || '未成功'}）`,
        位k2.ok === true && 位k2.位 && 位k2.位.在标记之后 === true, JSON.stringify(位k2.轨迹 || 位k2));
      await 退格(会话5);
      const 构k2 = await 会话5.js(读结构);
      ctx.assert('④ 全角空格标题正文起点退格：可见文字一个不少（`全角` 与 `空格标题` 都还在）',
        可见(构k2.全文).includes('全角空格标题') && 可见(构k2.全文).includes('前导空格标题'), JSON.stringify(构k2.全文));
      ctx.assert('④ 全角空格标题退格后光标没消失（还在编辑面里）',
        构k2.光标 && 构k2.光标.层 !== '外', JSON.stringify(构k2.光标));
      const 盘k2 = await hi.edge.saveAndWait(会话5, 文件5, { timeout: 9000 });
      ctx.witness('磁盘：④ 全角空格标题退格后', { 后: 规范(盘k2.after) }, 'disk');
      ctx.assert('④ 落盘：两条带空格的标题文字都还在（退格没有把哪一行吃掉）',
        ['前导空格标题', '全角　空格标题'].every(w => 规范(盘k2.after).includes(w)), JSON.stringify(非空行(盘k2.after)));
      await 会话5.shot('143-④空格标题');
    } finally {
      await ctx.release(会话5);
    }

    // ══ 会话六：五通道护栏——非编辑手势不许改文档（磁盘逐字节） ═══════════════════════
    const 文件6 = hi.writeDoc('143-gesture-guards.md', ['# 一级标题', '', '###### 六级标题', '', '正文甲。', ''].join('\n'));
    const 会话6 = await hi.openDoc(ctx, 文件6, { minBlocks: 3 });
    try {
      ctx.assert('⑤ 焦点在编辑器', (await hi.ensureFocus(会话6)).ok, '');
      const 盘前 = 规范(fs.readFileSync(文件6, 'utf8'));

      // 鼠标：点标题正文露出源码 → 点标记左缘（块首守卫）
      const g1 = await 会话6.js(块几何(0));
      ctx.assert('⑤ 前置：拿到第一行标题的几何（标记 `# `）', g1.ok === true && g1.标记 === '# ', JSON.stringify(g1));
      await 会话6.click(g1.正文中点.x, g1.正文中点.y); await hi.sleep(420);
      const g1b = await 会话6.js(块几何(0));
      await 会话6.click(g1b.标记左缘.x, g1b.标记左缘.y); await hi.sleep(460);
      const 位块首 = await 会话6.js(读块位(0));
      ctx.witness('几何：⑤ 点标记左缘后的光标', { 位: 位块首, 标记: g1b.标记 }, 'geometry');
      ctx.assert('⑤ 鼠标：点标记左缘，光标留在这一块最前面（井号之前）——块首守卫的既有契约不回退',
        位块首.ok === true && 位块首.在块首 === true, JSON.stringify(位块首));

      // 键鼠配合：Shift+单击选中标题文字（只选不改）
      const g2 = await 会话6.js(块几何(0));
      await 会话6.click(g2.正文左缘.x, g2.正文左缘.y, { modifiers: hi.MOD.shift }); await hi.sleep(420);
      const 选6 = await hi.caret(会话6);
      ctx.assert('⑤ 键鼠配合：Shift+单击选中了标题文字（选区非空）', !选6.折叠 && 选6.选区长 > 0, JSON.stringify(选6));
      ctx.assert('⑤ 只选不改：磁盘逐字节没动', 盘前 === 规范(fs.readFileSync(文件6, 'utf8')), '');

      // 拖拽：跨两行标题拖选（端点取两行**正文文字**的矩形，不取整块盒子——盒子右缘在正文之外）
      const 盒6 = await 会话6.js(`(() => { const w = ${hi.IF}, d = w.document; const fr = document.getElementById('editor').getBoundingClientRect();
        const s = d.querySelector('${hi.SURFACE}'); const hs = [...s.querySelectorAll('h1,h2,h3,h4,h5,h6')];
        if (hs.length < 2) return { ok: false };
        const 文字盒 = h => { const t = [...h.childNodes].filter(n => n.nodeType === 3 && n.data.replace(/[\\s\\u200b\\u3000]/g, '')).pop();
          if (!t) return null; const q = d.createRange(); q.selectNodeContents(t); return q.getBoundingClientRect(); };
        const a = 文字盒(hs[0]), b = 文字盒(hs[1]);
        if (!a || !b) return { ok: false };
        return { ok: true, 甲: { x: Math.round(fr.x + a.left + 2), y: Math.round(fr.y + a.top + a.height / 2) },
          乙: { x: Math.round(fr.x + b.right - 2), y: Math.round(fr.y + b.top + b.height / 2) } }; })()`);
      ctx.assert('⑤ 前置：拿到两行标题的拖选端点', 盒6.ok === true, JSON.stringify(盒6));
      await hi.drag(会话6, 盒6.甲, 盒6.乙, { steps: 10, after: 540 });
      const 选6b = await 会话6.js(`(() => { const w = ${hi.IF}; const s = w.getSelection();
        return { 文本: String(s).slice(0, 40), 长: String(s).length, 折叠: s.isCollapsed }; })()`);
      ctx.witness('几何：⑤ 跨两行标题拖选的结果', 选6b, 'geometry');
      ctx.assert('⑤ 拖拽：跨两行标题拖出的选区覆盖了两个标题的文字',
        选6b.折叠 === false && 选6b.长 > 0 && 选6b.文本.includes('一级标题') && 选6b.文本.includes('六级标题'), JSON.stringify(选6b));
      ctx.assert('⑤ 拖拽不改文档：磁盘逐字节相同', 盘前 === 规范(fs.readFileSync(文件6, 'utf8')), '');
      const 盘6 = await hi.edge.saveAndWait(会话6, 文件6, { timeout: 9000 });
      ctx.witness('磁盘：⑤ 五通道手势之后', { 前: 盘前, 后: 规范(盘6.after) }, 'disk');
      ctx.assert('⑤ 五通道手势（鼠标 / 键盘 / 组合键 / 键鼠配合 / 拖拽）跑完：磁盘仍是打开时那份原文',
        规范(盘6.after) === 盘前, JSON.stringify(非空行(盘6.after)));
      await 会话6.shot('143-⑤手势护栏');
    } finally {
      await ctx.release(会话6);
    }

    ctx.metric('143 语法形态例数', 6, { unit: '例', direction: 'higher', values: [6] });
    ctx.log('覆盖形态：级别切换（段落→H1/H6/H5、含行内公式的段落）、标题→普通文字（正文起点退格）、'
      + '七个井号、`#无空格`、Setext（=== / ---）、前导空格、全角空格、五通道手势护栏。');
  },
};
