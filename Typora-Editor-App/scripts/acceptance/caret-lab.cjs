/** 光标落点实验室：给"状态 × 手势"矩阵、兜底分支、长会话种子扫描共用的读数与判定。
 *
 *  为什么单独抽出来：过去每个场景各写各的"点一下看光标在哪"，于是**只覆盖它自己那条路**
 *  （折叠态点渲染结果 / 展开态点源码 / 拖选……各自一条）。用户 2026-09-23 报的"拖选过公式再点
 *  源码，光标跳回公式开头"就落在两条路**之间**：没有一个场景把"选区残影"当成前置状态。
 *  这里把两件事做成通用的：
 *    1. `STATE` 一次读全当前版面（折叠态给渲染字形+源码区间，展开态给源码字符盒），全部折算成
 *       顶层页坐标，任何场景都能拿它算"这一点应该落在哪个偏移"；
 *    2. `期望_展开 / 期望_折叠` 是**独立口径**（只用版面和 KaTeX 发布的源码区间，不看产品代码），
 *       与产品自己算出来的落点比对——这就是判据，不是"看起来对"。
 *
 *  坐标约定：本文件所有 x/y 都是**顶层页坐标**（可以直接喂给 session.click）。
 */
'use strict';
const crypto = require('node:crypto');

const IF = `document.getElementById('editor').contentWindow`;
const SURFACE = '.vditor-ir .vditor-reset';

/** 版面自述（页坐标）。折叠态：字形表带源码区间；展开态：源码逐字符盒。 */
const STATE = `(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow; const d = w.document;
  const fr = frame.getBoundingClientRect();
  const 页 = b => b ? [Math.round(fr.x + b.left), Math.round(fr.y + b.top), Math.round(b.width), Math.round(b.height)] : null;
  const 节点们 = [...d.querySelectorAll('.vditor-ir__node[data-type="inline-node"],.vditor-ir__node[data-type="math-block"]')];
  const 节点 = 节点们.find(n => String(n.textContent).includes('\\\\left[')) || 节点们[0];
  if (!节点) return {没节点: true};
  const code = 节点.querySelector(':scope > code[data-type="math-inline"]')
    || 节点.querySelector('code[data-type="math-inline"]')
    || 节点.querySelector('code[data-type="math-block"]');
  const text = code && code.firstChild && code.firstChild.nodeType === 3 ? code.firstChild : null;
  const 预览 = 节点.querySelector('.vditor-ir__preview');
  const 源码 = text ? String(text.data) : (code ? String(code.textContent) : null);
  const 字符盒 = [];
  if (text) for (let i = 0; i < 源码.length; i++) { let b = null;
    const r = d.createRange(); r.setStart(text, i); r.setEnd(text, i + 1);
    try { b = r.getBoundingClientRect(); } catch (e) {}
    字符盒.push(b && (b.width || b.height) ? 页(b) : null); }
  const 字形 = [];
  if (预览) for (const el of 预览.querySelectorAll('[data-typora-source-start]')) {
    if (el.querySelector('[data-typora-source-start]')) continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    字形.push({起: Number(el.getAttribute('data-typora-source-start')), 止: Number(el.getAttribute('data-typora-source-end')),
      字: String(el.textContent).slice(0, 4), 盒: 页(r)}); }
  const sel = w.getSelection();
  const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const 层 = el => el && el.closest ? (el.closest('code[data-type]') ? '源码' : el.closest('.vditor-ir__preview') ? '预览'
    : el.closest('[data-type$="-marker"]') ? '围栏' : el.closest('.vditor-ir__node[data-type^="math"]') ? '公式节点' : '正文') : null;
  let 光标 = null;
  if (at) { const n = at.startContainer; const el = n.nodeType === 3 ? n.parentElement : n;
    const q = d.createRange(); q.setStart(n, at.startOffset); q.collapse(true);
    const b = q.getBoundingClientRect();
    const 所在节点 = el && el.closest ? el.closest('.vditor-ir__node[data-type="inline-node"],.vditor-ir__node[data-type="math-block"]') : null;
    光标 = {层: 层(el), 在源码文本: n === text, 偏移: n === text ? at.startOffset : null, 塌: at.collapsed,
      在别处: !!所在节点 && 所在节点 !== 节点, 选中: at.toString().slice(0, 30), 盒: b && b.height ? 页(b) : null}; }
  const 块 = 节点.closest('h1,h2,h3,h4,h5,h6,p,li,td,th') || 节点;
  return {展开: 节点.classList.contains('vditor-ir__node--expand'), 源码, 字符盒, 字形, 光标, 标记: String(节点.className),
    code框: code ? 页(code.getBoundingClientRect()) : null, 节点框: 页(节点.getBoundingClientRect()),
    预览框: 预览 ? 页(预览.getBoundingClientRect()) : null, 行框: 页(块.getBoundingClientRect())}; })()`;

/** 文档指纹（DOM 层）：去掉预览子树与零宽字符后的文本。任何"手滑写进文档"都会让它变。 */
const SNAP = `(() => { const w = ${IF}; const d = w.document;
  const surface = d.querySelector('.vditor-ir .vditor-reset');
  if (!surface) return null;
  const clone = surface.cloneNode(true);
  clone.querySelectorAll('.vditor-ir__preview,.vditor-wysiwyg__preview,.katex').forEach(node => node.remove());
  return String(clone.textContent).replace(/\\u200b/g, ''); })()`;

/** 光标事实（给不变量用）：可见吗、在哪一层、是不是落在某条公式的源码里。 */
const CARE = `(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow; const d = w.document;
  const fr = frame.getBoundingClientRect();
  const 页 = b => b ? [Math.round(fr.x + b.left), Math.round(fr.y + b.top), Math.round(b.width), Math.round(b.height)] : null;
  const sel = w.getSelection();
  if (!sel || !sel.rangeCount) return {有选区: false};
  const at = sel.getRangeAt(0);
  const n = at.startContainer; const el = n.nodeType === 3 ? n.parentElement : n;
  const q = d.createRange(); q.setStart(n, at.startOffset); q.collapse(true);
  const b = q.getBoundingClientRect();
  const code = el && el.closest ? el.closest('code[data-type]') : null;
  const owner = el && el.closest ? el.closest('.vditor-ir__node[data-type="inline-node"],.vditor-ir__node[data-type="math-block"]') : null;
  // 非塌选区（Shift 扩选 / 双击选词）的可见反馈是**高亮**，不是那根光标：这里把选区盒也带上，
  // 不变量才能分开判（塌了看光标、没塌看高亮）。
  const 选区盒 = at.collapsed ? null : (() => { const r = at.getBoundingClientRect();
    if (r && (r.width || r.height)) return 页(r);
    const rects = at.getClientRects(); return rects.length ? 页(rects[0]) : null; })();
  return {有选区: true, 塌: at.collapsed, 可见: !!(b && b.height > 0), 在源码: !!code, 在公式: !!owner,
    在预览: !!(el && el.closest && el.closest('.vditor-ir__preview')), 节点: n.nodeName, 偏移: at.startOffset, 选区盒}; })()`;

const hash = text => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
const 同一点 = (a, b) => a[0] === b[0] && a[1] === b[1];

/** 展开态的独立口径：离点击点最近的**源码字符边界**，只在同一视觉行上找。 */
const 期望_展开 = (状态, x, y) => {
  const 行 = [];
  (状态.字符盒 || []).forEach((盒, i) => { if (盒 && Math.abs(盒[1] + 盒[3] / 2 - y) <= Math.max(6, 盒[3])) 行.push({i, 盒}); });
  if (!行.length) return null;
  let 最佳 = null, 距离 = Infinity;
  for (const {i, 盒} of 行) {
    for (const [边界, 边x] of [[i, 盒[0]], [i + 1, 盒[0] + 盒[2]]]) {
      const d = Math.abs(x - 边x);
      if (d < 距离) { 距离 = d; 最佳 = 边界; }
    }
  }
  return 距离 <= 40 ? 最佳 : null;
};

/** 折叠态的**可接受落点集合**：渲染结果的像素映射做不到逐字复刻（产品那套还有"命令进反斜杠之后"
 *  "行末给末尾"等规则），所以这里只钉**局部性**——光标必须落在你点的那一格或紧挨着它的那一格上，
 *  不许跑到公式的另一头去。用户报的"点哪儿光标跑到公式最前面"违反的正是这条。
 *  返回 null 表示这一点算不出可接受集合（不在公式附近），调用方按"不可判"处理。 */
const 可接受_折叠 = (状态, x, y) => {
  const 字形 = 状态.字形 || [];
  if (!字形.length) return null;
  const 含 = 字形.filter(g => x >= g.盒[0] && x <= g.盒[0] + g.盒[2] && y >= g.盒[1] && y <= g.盒[1] + g.盒[3]);
  let 用 = null, 序号 = -1;
  if (含.length) {
    const 排 = 含.slice().sort((a, b) => a.盒[2] * a.盒[3] - b.盒[2] * b.盒[3]);
    用 = 排[0]; 序号 = 字形.indexOf(用);
  } else {
    let 近 = Infinity;
    字形.forEach((g, i) => {
      const dx = x < g.盒[0] ? g.盒[0] - x : x > g.盒[0] + g.盒[2] ? x - g.盒[0] - g.盒[2] : 0;
      const dy = y < g.盒[1] ? g.盒[1] - y : y > g.盒[1] + g.盒[3] ? y - g.盒[1] - g.盒[3] : 0;
      const d = Math.hypot(dx, dy); if (d < 近) { 近 = d; 用 = g; 序号 = i; } });
    if (!用 || 近 > 12) return null;
  }
  const 源码 = String(状态.源码 || '');
  const 集 = new Set();
  for (const i of [序号 - 1, 序号, 序号 + 1]) {
    const g = 字形[i];
    if (!g) continue;
    集.add(g.起); 集.add(g.止);
    if (源码[g.起] === '\\') 集.add(g.起 + 1);        // 命令：光标进反斜杠之后（产品的既有口径）
    if (i === 字形.length - 1) 集.add(g.止);           // 最后一个字形：整格给末尾
  }
  return {集合: [...集], 字形: 用.字, 区间: [用.起, 用.止]};
};

/** 旧接口（保留给只想知道"大致该落哪"的调用方）：取集合里离点击最近的那个。 */
const 期望_折叠 = (状态, x, y) => {
  const 可 = 可接受_折叠(状态, x, y);
  if (!可) return null;
  return 可.集合.slice().sort((a, b) => Math.abs(a - x) - Math.abs(b - x))[0];
};

/** 源码是不是**真的排出来了**：展开态、以及拖选翻开（REVEAL）但没挂 --expand 的态，都算。 */
const 源码可见 = 状态 => (状态.字符盒 || []).some(Boolean);

/** 采样点：源码可见就点源码字符的左缘内 1px；否则点渲染字形的左缘内 2px。
 *  **跳过源码的首尾两格**：光标贴在公式边界时被"挪到公式外面"是产品的既有契约
 *  （见 math-edit.js 的 caretOutside；场景 101/92 专门钉它），不是本矩阵要抓的跳动。 */
const 采样点 = (状态, {步长 = 3} = {}) => {
  const 点 = [];
  if (源码可见(状态)) {
    const 长 = (状态.字符盒 || []).length;
    (状态.字符盒 || []).forEach((盒, i) => {
      if (盒 && i % 步长 === 0 && i > 1 && i < 长 - 2) 点.push({x: 盒[0] + 1, y: 盒[1] + Math.round(盒[3] / 2), 索引: i});
    });
  } else (状态.字形 || []).forEach((g, i) => { if (i % 步长 === 0) 点.push({x: g.盒[0] + 2, y: g.盒[1] + Math.round(g.盒[3] / 2), 索引: i}); });
  return 点.slice(0, 40);
};

/** iframe 内的命中测试（输入页坐标）：用来在**扣扳机之前**确认这一枪瞄的还是不是源码。 */
const 命中 = (session, x, y) => session.js(`(() => { const frame = document.getElementById('editor');
  const w = frame.contentWindow; const d = w.document; const fr = frame.getBoundingClientRect();
  const el = d.elementFromPoint(${Math.round(x)} - Math.round(fr.x), ${Math.round(y)} - Math.round(fr.y));
  if (!el) return null;
  return {标签: el.nodeName, 类: typeof el.className === 'string' ? el.className.slice(0, 40) : '',
    在源码: !!(el.closest && el.closest('code[data-type]')),
    在公式: !!(el.closest && el.closest('.vditor-ir__node[data-type="inline-node"],.vditor-ir__node[data-type="math-block"]')),
    在预览: !!(el.closest && el.closest('.vditor-ir__preview'))}; })()`);

/** 点**源码的第 i 个字符**：先读版面 → 命中测试确认落点真在源码上 → 再点。
 *  命中测试不过就重读一次（版面在动就等它停）。返回 {点, 命中, 状态}，命中为 null 表示没瞄上。 */
const 点源码字符 = async (session, 索引, {sleep = ms => new Promise(r => setTimeout(r, ms)), 重试 = 6} = {}) => {
  for (let i = 0; i < 重试; i++) {
    const S = await session.js(STATE);
    const 盒 = (S.字符盒 || [])[索引];
    if (盒) {
      const x = 盒[0] + 1, y = 盒[1] + Math.round(盒[3] / 2);
      const 见 = await 命中(session, x, y);
      if (见 && 见.在源码) {
        await session.click(x, y);
        return {点: {x, y}, 命中: 见, 状态: S};
      }
    }
    await sleep(220);
  }
  return {点: null, 命中: null, 状态: await session.js(STATE)};
};

module.exports = { IF, SURFACE, STATE, SNAP, CARE, hash, 同一点, 期望_展开, 期望_折叠, 可接受_折叠, 采样点, 源码可见, 命中, 点源码字符 };
