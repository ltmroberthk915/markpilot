/** 探针（leadconf-a 专用，新文件）：标题行「标记之后按回车」的**视觉确认 + 判据真值表**。
 *
 *  用途（流程第 1、2 步）：
 *    · 在**装机产物**上把用户报的三种光标情形逐条拍下来（每情形都有「按回车前 / 按回车后」的
 *      2 倍局部放大图 + 整页图），看图写结论，不许只看数字；
 *    · 顺带把「光标在标记之后」的**几种判据写法**在同一现场逐条求真值，回答
 *      `compareBoundaryPoints` 的 how 语义到底能不能用。
 *
 *  用法（**必须**包在 app-slot 里，否则会和别的 agent 抢固定端口）：
 *    node scripts/acceptance/app-slot.cjs -- node scripts/acceptance/probe-leadconf-a.cjs --app=installed
 *    node scripts/acceptance/app-slot.cjs -- node scripts/acceptance/probe-leadconf-a.cjs --app=dev
 *
 *  只读：不改产品代码、不改 scenarios/ 下任何文件；产物全部写 --out=（默认 .zcode-tmp/r16/a-heading）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');
const edge = require('./edge-helpers.cjs');

const argOf = (name, fallback) => {
  const hit = process.argv.find(value => value.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const APP = argOf('app', 'installed');
const OUT = path.resolve(argOf('out', 'E:/MarkPilot/.zcode-tmp/r16/a-heading/' + APP));
const TAG = argOf('tag', APP);
fs.mkdirSync(OUT, { recursive: true });

const APPS = {
  installed: { exe: 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe', appArgs: [] },
  dev: { exe: path.join(harness.project, 'node_modules/electron/dist/electron.exe'), appArgs: [path.join(harness.project, 'app/main/main.js')] },
};
const app = APPS[APP];
if (!app) throw new Error('--app 只能是 installed / dev');

// ─── 素材 ─────────────────────────────────────────────────────────────────────
const BODY = ['### 标题内容', '', '后文。', ''].join('\n');
const EMPTY = ['### ', '', '后文。', ''].join('\n');
const MATH = ['### 标题甲 $a+b=c$ 收尾', '', '后文。', ''].join('\n');

// ─── 页内脚本 ─────────────────────────────────────────────────────────────────
const 置文 = md => `(() => { const w = ${hi.IF}; w.vditor.setValue(${JSON.stringify(md)}); return true; })()`;

/** 放光标：角色 marker＝heading 标记的文本节点；content＝标题正文文本节点。 */
const 放光标 = (角色, off) => `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
  const h = s && s.querySelector('h1,h2,h3,h4,h5,h6'); if (!h) return { ok: false, why: 'no-heading' };
  let t = null;
  if (${JSON.stringify(角色)} === 'marker') { const m = h.querySelector('[data-type="heading-marker"]'); t = m ? m.firstChild : null; }
  else { t = [...h.childNodes].filter(n => n.nodeType === 3 && n.data.replace(/[\\s\\u200b]/g, '')).pop() || null; }
  if (!t || t.nodeType !== 3) return { ok: false, why: 'no-text', html: h.outerHTML };
  const o = Math.min(${off}, t.data.length);
  s.focus();
  const r = d.createRange(); r.setStart(t, o); r.collapse(true);
  const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  return { ok: true, 文本: JSON.stringify(t.data), 偏移: o, 长度: t.data.length, 父: t.parentElement ? String(t.parentElement.className).slice(0, 40) : null,
    在标记内: !!(t.parentElement && t.parentElement.closest && t.parentElement.closest('[data-type="heading-marker"]')) }; })()`;

/** 焦点闸门：按键类读数前必须过。 */
const 读焦点 = `(() => { const f = document.getElementById('editor'); const w = f && f.contentWindow;
  if (!w || !w.document) return { ok: false };
  const a = w.document.activeElement;
  return { ok: !!w.document.hasFocus() && !!a && !!(a === w.document.body || (a.closest && a.closest('.vditor-ir'))),
    active: a ? a.tagName + '.' + String(a.className).slice(0, 24) : null }; })()`;

/** 块序列 + 每块字号/行高/几何 + 光标事实（含光标矩形，供画红实线）。 */
const 读结构 = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}'); if (!s) return { ok: false };
  const 块 = [...s.children].map((b, i) => {
    const m = b.querySelector('[data-type="heading-marker"]');
    const 正文 = m ? [...b.childNodes].filter(n => !(n.nodeType === 1 && n.getAttribute('data-type') === 'heading-marker')).map(n => n.textContent).join('') : b.textContent;
    const cs = w.getComputedStyle(b); const r = b.getBoundingClientRect();
    return { i, tag: b.tagName, 标题: /^H[1-6]$/.test(b.tagName), 标记: m ? JSON.stringify(m.textContent) : null,
      标记数: b.querySelectorAll('[data-type="heading-marker"]').length,
      空: !正文.replace(/[\\s\\u200b]/g, ''), 文本: b.textContent.replace(/\\u200b/g, '').slice(0, 40),
      内HTML: String(b.innerHTML).replace(/\\u200b/g, '<z>').slice(0, 150),
      字号: cs.fontSize, 行高: cs.lineHeight, 字重: cs.fontWeight,
      框: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      公式: b.querySelectorAll('.katex,[data-math],code[data-type^="math"]').length };
  });
  const sel = w.getSelection(); const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const at = r ? (r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer) : null;
  const box = r ? r.getBoundingClientRect() : null;
  return { ok: true, 块, 块数: 块.length,
    光标: r ? { 折叠: r.collapsed, 容器: r.startContainer.nodeType === 3 ? 'TEXT' : r.startContainer.nodeName, 偏移: r.startOffset,
      层: !at || !s.contains(at) ? '外' : at.closest('h1,h2,h3,h4,h5,h6') ? '标题' : at.closest('p') ? '段' : '其他',
      在标记里: !!(at && at.closest && at.closest('[data-type="heading-marker"]')),
      x: Math.round(box.x), y: Math.round(box.y), h: Math.round(box.height), w: Math.round(box.width) } : null }; })()`;

/** 「光标是否在标记之后」的**判据真值表**：同一现场把候选写法逐条求值。
 *  · 现 dev 实现口径：左半克隆里那枚 marker 的文字长度 ≥ 原 marker（克隆完整度启发式）；
 *  · 本探针建议的结构判据：整枚 marker 是否都在光标左边（compareDocumentPosition + 偏移），
 *    完全不碰 compareBoundaryPoints；
 *  · 四种 how 的 compareBoundaryPoints 原样记录（用户/主 Agent 对它的语义有疑问，这里留实证）。 */
const 判据真值表 = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
  const h = s && s.querySelector('h1,h2,h3,h4,h5,h6'); if (!h) return { ok: false };
  const marker = h.querySelector('[data-type="heading-marker"]'); if (!marker) return { ok: false, why: 'no-marker' };
  const sel = w.getSelection(); if (!sel.rangeCount) return { ok: false, why: 'no-range' };
  const r0 = sel.getRangeAt(0);
  const care = d.createRange(); care.setStart(r0.startContainer, r0.startOffset); care.collapse(true);
  const mRange = d.createRange(); mRange.selectNode(marker);
  const mContents = d.createRange(); mContents.selectNodeContents(marker);
  const 出 = { ok: true, 光标容器: r0.startContainer.nodeType === 3 ? 'TEXT(' + r0.startContainer.data.length + ')' : r0.startContainer.nodeName,
    光标偏移: r0.startOffset, 标记文本: JSON.stringify(marker.textContent), 标记子元素数: marker.children.length,
    标记内文本节点数: (() => { let n = 0; const it = d.createTreeWalker(marker, NodeFilter.SHOW_TEXT); while (it.nextNode()) n++; return n; })() };
  const 试 = (名, 函数) => { try { 出[名] = 函数(); } catch (error) { 出[名] = 'ERR:' + error.message; } };
  试('cbp_光标START_vs_标记END', () => care.compareBoundaryPoints(Range.START_TO_END, mRange));
  试('cbp_光标START_vs_标记START', () => care.compareBoundaryPoints(Range.START_TO_START, mRange));
  试('cbp_光标END_vs_标记START', () => care.compareBoundaryPoints(Range.END_TO_START, mRange));
  试('cbp_光标END_vs_标记END', () => care.compareBoundaryPoints(Range.END_TO_END, mRange));
  试('cbp_标记START_vs_光标END', () => mRange.compareBoundaryPoints(Range.START_TO_END, care));
  试('cbp_标记END_vs_光标START', () => mRange.compareBoundaryPoints(Range.END_TO_START, care));
  // 判据甲：现 dev 实现的克隆完整度
  const left = d.createRange(); left.selectNodeContents(h); left.setEnd(r0.startContainer, r0.startOffset);
  const holder = d.createElement('div'); holder.appendChild(left.cloneContents());
  const cloned = holder.querySelector('[data-type="heading-marker"]');
  出.现判据_克隆标记文本 = cloned ? JSON.stringify(cloned.textContent) : null;
  出.现判据_克隆左半文本 = JSON.stringify(holder.textContent);
  出.甲_标记整枚在左 = !!cloned && cloned.textContent.length >= marker.textContent.length;
  // 判据乙：结构判据（整枚 marker 在光标左边的精确判定，不依赖 how 语义）
  出.乙_标记整枚在左 = (() => {
    const node = r0.startContainer, off = r0.startOffset;
    if (marker.contains(node)) {
      const it = d.createTreeWalker(marker, NodeFilter.SHOW_TEXT); let last = null, n;
      while ((n = it.nextNode())) last = n;
      if (!last) return false;
      if (node.nodeType === 3) return node === last && off >= last.data.length;
      return off >= node.childNodes.length;
    }
    return (marker.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  })();
  // 判据丙：几何——光标矩形左缘是否已越过标记右缘
  出.丙_几何在标记右 = (() => { const a = care.getBoundingClientRect(), b = marker.getBoundingClientRect();
    if (!b.width) return '标记无像素(' + Math.round(b.width) + ')'; return Math.round(a.left) >= Math.round(b.right) - 1; })();
  出.标记框 = (() => { const b = marker.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; })();
  return 出; })()`;

/** 光标可见性：裸矩形 + 产品自己的「版面有行盒」判据（typora-patches.js 的 patchHomeEndCaret：
 *  Range 矩形读回 0×0 **不等于**原生画不出光标——光标前/后任一侧取得到真实内容行盒就画得出）。 */
const 读光标可见 = `(() => { const w = ${hi.IF}, d = w.document; const sel = w.getSelection();
  if (!sel || !sel.rangeCount || !sel.focusNode) return { none: true };
  const r = d.createRange(); r.setStart(sel.focusNode, sel.focusOffset); r.collapse(true);
  const box = r.getBoundingClientRect();
  const node = sel.focusNode; const at = node.nodeType === 3 ? node.parentElement : node;
  const 块 = at && at.closest ? at.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th') : null;
  const 有行盒 = (range, 取后) => { let rects = []; try { rects = [...range.getClientRects()]; } catch (e) { return false; }
    if (取后) { for (let i = rects.length - 1; i >= 0; i--) if (rects[i].height > 0) return true; return false; }
    return rects.some(b => b.height > 0); };
  let 前后 = false;
  if (块 && 块.contains(node)) { const 夹 = (n, o) => Math.min(Math.max(o | 0, 0), n.nodeType === 3 ? n.length : n.childNodes.length);
    try { const 前 = d.createRange(); 前.setStart(块, 0); 前.setEnd(node, 夹(node, sel.focusOffset));
      const 后 = d.createRange(); 后.setStart(node, 夹(node, sel.focusOffset)); 后.setEnd(块, 块.childNodes.length);
      前后 = 有行盒(前, true) || 有行盒(后, false); } catch (e) { 前后 = 'ERR:' + e.message; } }
  return { 矩形: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
    裸矩形非零: box.height > 0, 前后有行盒: 前后, 容器: node.nodeType === 3 ? 'TEXT' : node.nodeName, 偏移: sel.focusOffset }; })()`;

/** 「光标紧贴标记之后」——真人路径的到位判据（比"整枚标记在左"更严：必须是**最靠近标记**的那个位置）。
 *  两种合格形状：① 光标停在标记文本节点的末尾；② 光标停在标题第一个正文文本节点的 offset 0。 */
const 读紧贴标记之后 = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
  const h = s && s.querySelector('h1,h2,h3,h4,h5,h6'); const m = h && h.querySelector('[data-type="heading-marker"]');
  const sel = w.getSelection(); if (!h || !m || !sel.rangeCount) return { ok: false };
  const r = sel.getRangeAt(0); const node = r.startContainer, off = r.startOffset;
  const 标记长 = m.textContent.length;
  if (m.contains(node)) {
    if (node.nodeType !== 3) return { ok: true, 紧贴: false, 形状: '标记内元素级@' + off };
    const it = d.createTreeWalker(m, NodeFilter.SHOW_TEXT); let 前 = 0, n, hit = -1;
    while ((n = it.nextNode())) { if (n === node) hit = 前 + off; 前 += n.data.length; }
    return { ok: true, 紧贴: hit === 标记长, 形状: '标记内文字@' + hit + '/' + 标记长 };
  }
  const 正文 = [...h.childNodes].filter(n => n.nodeType === 3 && n.data.replace(/[\\s\\u200b]/g, ''))[0];
  return { ok: true, 紧贴: node === 正文 && off === 0, 形状: '正文节点@' + off + (node === 正文 ? '(第一个正文节点)' : '(非第一个正文节点)') }; })()`;

/** 判据单元测试（**游离 DOM**，不动编辑面）：同一批光标位置，三种判据写法逐条求真值。
 *  形：单文本 `### ` ／ 两文本 `###`+` `（DOM 手术后的形状）／ 尾空文本 `### `+``。
 *  · 甲＝现 dev 实现（左半克隆里那枚 marker 的文字长度 ≥ 原 marker）；
 *  · 乙＝结构判据朴素版（要求光标在标记内**最后一个文本节点**的末尾）；
 *  · 乙改＝结构判据加固版（把标记内文本串起来，算"光标之前的文字数 ≥ 标记全文长度"）。 */
const 判据单元测试 = `(() => { const d = document;
  const 建 = 形 => { const h = d.createElement('h3');
    const m = d.createElement('span'); m.setAttribute('data-type', 'heading-marker'); m.className = 'vditor-ir__marker';
    if (形 === '单文本') m.appendChild(d.createTextNode('### '));
    else if (形 === '两文本') { m.appendChild(d.createTextNode('###')); m.appendChild(d.createTextNode(' ')); }
    else { m.appendChild(d.createTextNode('### ')); m.appendChild(d.createTextNode('')); }
    h.appendChild(m); const t = d.createTextNode('标题内容'); h.appendChild(t); return { h, m, t }; };
  const 判甲 = (h, m, node, off) => { const left = d.createRange(); left.selectNodeContents(h); left.setEnd(node, off);
    const holder = d.createElement('div'); holder.appendChild(left.cloneContents());
    const c = holder.querySelector('[data-type="heading-marker"]');
    return !!c && c.textContent.length >= m.textContent.length; };
  const 判乙 = (m, node, off) => { if (m.contains(node)) {
      const it = d.createTreeWalker(m, NodeFilter.SHOW_TEXT); let last = null, n;
      while ((n = it.nextNode())) last = n; if (!last) return false;
      return node.nodeType === 3 ? (node === last && off >= last.data.length) : off >= node.childNodes.length; }
    return (m.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0; };
  const 判乙改 = (m, node, off) => { if (m.contains(node)) {
      if (node.nodeType !== 3) return false;
      const it = d.createTreeWalker(m, NodeFilter.SHOW_TEXT); let seen = 0, total = 0, hit = -1, n;
      while ((n = it.nextNode())) { if (n === node) hit = seen + Math.min(off, n.data.length); seen += n.data.length; }
      total = seen; if (hit < 0) return false; return hit >= total; }
    return (m.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0; };
  const 行 = [];
  for (const 形 of ['单文本', '两文本', '尾空文本']) { const { h, m, t } = 建(形); const 点 = [];
    if (形 === '单文本') 点.push(['标记@0', m.firstChild, 0, false], ['标记@1', m.firstChild, 1, false], ['标记@末尾', m.firstChild, m.firstChild.data.length, true]);
    else if (形 === '两文本') 点.push(['标记首文本@3(后面还有空格)', m.firstChild, 3, false], ['标记末文本@1(空格之后)', m.lastChild, 1, true], ['标记末文本@末尾', m.lastChild, m.lastChild.data.length, true]);
    else 点.push(['标记@末尾(后面还有空文本节点)', m.firstChild, m.firstChild.data.length, true]);
    点.push(['正文@0', t, 0, true], ['正文@1', t, 1, true]);
    for (const [名, node, off, 期望] of 点) 行.push({ 形, 点: 名, 期望, 甲: 判甲(h, m, node, off), 乙: 判乙(m, node, off), 乙改: 判乙改(m, node, off) }); }
  return { ok: true, 行 }; })()`;

// ─── 真屏抓帧（原生 caret 只在屏幕上，CDP 抓不到；口径同 probe-caret-blink-truth.cjs） ──
const { execFileSync } = require('node:child_process');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const PS = (script, args) => execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', path.join(__dirname, script), ...args], { encoding: 'utf8', windowsHide: true });

// ─── 页内标记层（截图口径：红实线＝光标落点；青虚线＝块框；琥珀虚线＝标记右缘参考列） ──
const 装标记 = `(() => { const w = ${hi.IF}; if (!w) return { ok: false };
  w.__lc = { mark(list) {
    const 旧 = w.document.getElementById('__lc_marks'); if (旧) 旧.remove();
    if (!list || !list.length) return 0;
    const 层 = w.document.createElement('div'); 层.id = '__lc_marks';
    层.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    for (const it of list) { if (!it) continue;
      const d = w.document.createElement('div');
      if (it.type === 'line') d.style.cssText = 'position:fixed;pointer-events:none;left:' + Math.round(it.x) + 'px;top:' + Math.round(it.y) + 'px;width:' + (it.w || 2) + 'px;height:' + Math.max(2, it.h || 18) + 'px;background:' + it.color;
      else d.style.cssText = 'position:fixed;pointer-events:none;left:' + Math.round(it.x) + 'px;top:' + Math.round(it.y) + 'px;width:' + Math.round(it.w) + 'px;height:' + Math.round(it.h) + 'px;border:1.5px dashed ' + it.color;
      if (it.label) { const t = w.document.createElement('div'); t.textContent = it.label;
        t.style.cssText = 'position:fixed;pointer-events:none;font:11px/1.2 monospace;white-space:nowrap;left:' + (Math.round(it.x) + 3) + 'px;top:' + (Math.round(it.y) - 13) + 'px;color:' + it.color;
        层.appendChild(t); }
      层.appendChild(d); }
    w.document.body.appendChild(层); return list.length; },
    unmark() { const 旧 = w.document.getElementById('__lc_marks'); if (旧) 旧.remove(); return 1; } };
  return { ok: true }; })()`;
const 标记 = (session, list) => session.js(`(() => { const w = ${hi.IF}; return w.__lc.mark(${JSON.stringify(list)}); })()`);
const 清标记 = session => session.js(`(() => { const w = ${hi.IF}; return w.__lc.unmark(); })()`);

// ─── 截图 ─────────────────────────────────────────────────────────────────────
/** 放大图的锚点：**前两块**（改动就发生在这两行之间），空标题用例也能框住。 */
const 关键盒 = 结构 => {
  const 首 = 结构.块[0] || { 框: { x: 60, y: 60, h: 30 } };
  const 次 = 结构.块[1];
  return { x: Math.min(首.框.x, 次 ? 次.框.x : 首.框.x), y: Math.min(首.框.y, 次 ? 次.框.y : 首.框.y), h: 首.框.h };
};
/** 2 倍局部放大（截在改动行附近，光标与高亮占满画面）+ 整页图；先画标记再拍。 */
async function 拍照(session, 名, 结构, { 干净 = false } = {}) {
  const f = await session.js(`(() => { const r = document.getElementById('editor').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  const 标 = [];
  for (const b of 结构.块) {
    标.push({ x: b.框.x, y: b.框.y, w: b.框.w, h: b.框.h, color: '#00b3b3', label: b.tag + (b.标记 ? ' 标记' + b.标记 : '') + (b.空 ? '（空）' : '') + ' ' + b.字号 });
    if (b.标记) 标.push({ x: b.框.x - 6, y: b.框.y, w: 0, h: b.框.h, color: '#ff8c00', type: 'line', label: '' });
  }
  if (结构.光标 && 结构.光标.w >= 0 && 结构.光标.h > 0) {
    标.push({ x: 结构.光标.x - 1, y: 结构.光标.y, w: 3, h: 结构.光标.h, color: '#ff2d2d', type: 'line', label: '光标' });
  }
  const 写入 = async (名2, clip) => {
    const shot = await session.send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
    const 文件 = path.join(OUT, 名2 + '.png');
    fs.writeFileSync(文件, Buffer.from(shot.data, 'base64'));
    return 文件;
  };
  // 干净图（不画标记）：像素级比对「两种光标位置结果是否同形」用
  await 清标记(session);
  const 干净图 = 干净 ? await 写入(名 + '-干净-整页', null) : null;
  const 锚 = 关键盒(结构);
  const clip = { x: Math.max(0, f.x + 锚.x - 210), y: Math.max(0, f.y + 锚.y - 46), width: 620, height: 210, scale: 2 };
  await 标记(session, 标);
  const 放大图 = await 写入(名 + '-2x', clip);
  const 整页图 = await 写入(名 + '-marked-整页', null);
  await 清标记(session);
  return { 放大图, 整页图, 干净图 };
}

// ─── 动作 ─────────────────────────────────────────────────────────────────────
const 键 = async (session, spec, 等 = 460) => { await session.key(spec); await hi.sleep(等); };
const 回车 = session => 键(session, { key: 'Enter', code: 'Enter', vk: 13, text: '\r' });
const 退格 = session => 键(session, { key: 'Backspace', code: 'Backspace', vk: 8 });
const 撤销 = async session => { await hi.combo(session, 'Ctrl+z'); await hi.sleep(620); };

/** 判据全部写成**用户看得见的性质**：块的标签/标记/空否、文本、光标落在哪一层。
 *  「标记」在读数里是 JSON 串（为了看见空格），这里解回来再按 `#+` 数井号，避免把
 *  "###"（3 字）与 "### "（4 字）这类实现差异误判成语义差异。 */
const 判定 = (结构, 期望, 级 = 3) => {
  const 块 = 结构.块 || [];
  const 光 = 结构.光标 || {};
  const 标记原文 = b => (b && b.标记 ? JSON.parse(b.标记) : null);
  const 井号数 = b => { const m = 标记原文(b); return m ? (m.match(/^#+/) || [''])[0].length : 0; };
  const 块0 = 块[0], 块1 = 块[1];
  const 概览 = JSON.stringify({ 块0: 块0 && 块0.tag + (标记原文(块0) || '') + (块0.空 ? '(空)' : ':' + 块0.文本), 块1: 块1 && 块1.tag + (标记原文(块1) || '') + (块1.空 ? '(空)' : ':' + 块1.文本), 光标: 光.层 + '@' + 光.偏移 });
  if (期望 === '标记钉原行') {
    return { pass: !!块0 && 块0.tag === 'H' + 级 && 块0.标题 && 块0.空 && 井号数(块0) === 级 && 块0.标记数 === 1
        && !!块1 && 块1.tag === 'P' && !块1.标题 && 块1.文本 === '标题内容'
        && 光.层 === '段' && 光.偏移 === 0, 细节: 概览 };
  }
  if (期望 === '块首整行下移') {
    return { pass: !!块0 && 块0.tag === 'P' && 块0.空 && !!块1 && 块1.tag === 'H' + 级 && !块1.空
        && 块1.文本.includes('标题内容') && 井号数(块1) === 级 && 光.层 === '标题', 细节: 概览 };
  }
  if (期望 === '文字中间拆分') {
    return { pass: !!块0 && 块0.tag === 'H3' && 块0.文本.includes('标') && !!块1 && 块1.tag === 'P' && 块1.文本 === '题内容',
      细节: 概览 };
  }
  if (期望 === '空标题标记钉原行') {
    return { pass: !!块0 && 块0.tag === 'H3' && 块0.空 && !!(块0.标记) && !!块1 && 块1.tag === 'P' && 块1.空 && 光.层 === '段',
      细节: 概览 };
  }
  return { pass: false, 细节: '未知期望 ' + 期望 };
};

// ─── 主流程 ───────────────────────────────────────────────────────────────────
(async () => {
  const 报告 = { app: APP, tag: TAG, out: OUT, at: new Date().toISOString(), exe: app.exe, 用例: [], 判据: [], 版本: null };
  const file = hi.writeDoc('leadconf-heading.md', BODY);
  const 级文件 = hi.writeDoc('leadconf-levels.md', BODY);
  const 公式文件 = hi.writeDoc('leadconf-math.md', MATH);

  // 版本号：从装机 asar 里读（装机产物才有 asar）
  try {
    const buf = fs.readFileSync('D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/resources/app.asar');
    const headerSize = buf.readUInt32LE(12);
    const header = JSON.parse(buf.slice(16, 16 + headerSize).toString('utf8'));
    const dataStart = 8 + buf.readUInt32LE(4);
    const entry = header.files['package.json'];
    const pkg = JSON.parse(buf.slice(dataStart + Number(entry.offset), dataStart + Number(entry.offset) + entry.size).toString('utf8'));
    报告.版本 = { 装机: pkg.version, name: pkg.name };
  } catch (error) { 报告.版本 = { 读失败: error.message }; }

  console.log(`# 探针 leadconf-a｜app=${APP}｜out=${OUT}`);
  console.log('装机版本：' + JSON.stringify(报告.版本));

  const session = await harness.launch({ exe: app.exe, appArgs: app.appArgs, args: [file], outDir: OUT, label: 'leadconf-a-' + TAG, inspect: argOf('screen', '0') === '1' });
  const 收尾 = [];
  try {
    await session.until(hi.readyExpr(2), { timeout: 140000, interval: 120 });
    await hi.sleep(1400);
    await session.js(装标记);
    const 焦点 = await hi.ensureFocus(session);
    console.log('焦点：' + JSON.stringify(焦点));
    报告.焦点 = 焦点;

    // 判据单元测试（游离 DOM）：三种判据写法在四种形状上的真值
    报告.判据单元测试 = await session.js(判据单元测试);
    console.log('\n【判据单元测试（游离 DOM）】期望↔甲↔乙↔乙改');
    for (const 行 of 报告.判据单元测试.行) {
      const 对 = (值) => (值 === 行.期望 ? '✓' : '✗');
      console.log(`   ${行.形}｜${行.点}｜期望=${行.期望} 甲=${行.甲}${对(行.甲)} 乙=${行.乙}${对(行.乙)} 乙改=${行.乙改}${对(行.乙改)}`);
    }

    const 用例 = [
      { 名: '1-光标在标记之后', 素材: BODY, 文件: file, 放: ['marker', 4], 期望: '标记钉原行', 干净: true },
      { 名: '2-光标在标记之前', 素材: BODY, 文件: file, 放: ['marker', 0], 期望: '块首整行下移', 干净: true },
      { 名: '3-光标在标记文字中间', 素材: BODY, 文件: file, 放: ['marker', 1], 期望: '块首整行下移' },
      { 名: '4-光标在标题文字中间', 素材: BODY, 文件: file, 放: ['content', 1], 期望: '文字中间拆分' },
      { 名: '5-空标题光标在标记之后', 素材: EMPTY, 文件: file, 放: ['marker', 4], 期望: '空标题标记钉原行' },
      { 名: '6-光标在正文节点起点(marker右邻)', 素材: BODY, 文件: file, 放: ['content', 0], 期望: '标记钉原行' },
    ];
    for (let 级 = 1; 级 <= 6; 级++) {
      用例.push({ 名: '7-h' + 级 + '-标记之后', 素材: '#'.repeat(级) + ' 标题内容\n\n后文。\n', 文件: 级文件, 放: ['marker', 级 + 1], 期望: '标记钉原行', 级 });
    }

    for (const 例 of 用例) {
      if (!(await session.js(读焦点)).ok) await hi.ensureFocus(session);
      await session.js(置文(例.素材));
      await hi.sleep(600);
      const 放 = await session.js(放光标(例.放[0], 例.放[1]));
      await hi.sleep(160);
      const 真值 = await session.js(判据真值表);
      const 前 = await session.js(读结构);
      const 前图 = await 拍照(session, `${TAG}-${例.名}-前`, 前, { 干净: !!例.干净 });
      const 焦点2 = await session.js(读焦点);
      await 回车(session);
      const 后 = await session.js(读结构);
      const md = await hi.mdNow(session);
      // 光标可见性连采四拍（100/300/600/1000ms）：把"瞬时的 0×0"和"光标真没了"分开
      const 可见序列 = [];
      for (const 等 of [100, 200, 300, 400]) { await hi.sleep(等); 可见序列.push(await session.js(读光标可见)); }
      const 后图 = await 拍照(session, `${TAG}-${例.名}-后`, 后, { 干净: !!例.干净 });
      const 判 = 判定(后, 例.期望, 例.级 || 3);
      const 条 = { 名: 例.名, 素材首行: 例.素材.split('\n')[0], 放: 放, 焦点: 焦点2, 真值, 前: { 块: 前.块, 光标: 前.光标 }, 后: { 块: 后.块, 光标: 后.光标 },
        md后: md, 期望: 例.期望, 判定: 判, 图: { 前: 前图, 后: 后图 }, 光标可见序列: 可见序列 };
      报告.用例.push(条);
      console.log(`\n【${例.名}】素材首行=${JSON.stringify(例.素材.split('\n')[0])} 放光标=${JSON.stringify(放)} 焦点ok=${焦点2.ok}`);
      console.log('   前：' + 前.块.map(b => b.tag + (b.标记 ? ' 标记' + b.标记 : '') + (b.空 ? '(空)' : ':' + b.文本) + ' ' + b.字号).join(' | '));
      console.log('   后：' + 后.块.map(b => b.tag + (b.标记 ? ' 标记' + b.标记 : '') + (b.空 ? '(空)' : ':' + b.文本) + ' ' + b.字号).join(' | '));
      console.log('   后·前两块内HTML/框高：' + 后.块.slice(0, 2).map(b => `${b.tag} h=${b.框.h} html=${JSON.stringify(b.内HTML)}`).join(' || '));
      console.log('   光标后：' + JSON.stringify(后.光标) + '  md后=' + JSON.stringify(md));
      console.log('   光标可见性四拍：' + 可见序列.map(v => JSON.stringify(v.矩形) + (v.裸矩形非零 ? '[矩形非零]' : '[矩形0×0]') + ' 前后有行盒=' + v.前后有行盒).join(' ; '));
      console.log('   判据真值：甲(克隆完整度)=' + 真值.甲_标记整枚在左 + ' 乙(结构)=' + 真值.乙_标记整枚在左 + ' 丙(几何)=' + 真值.丙_几何在标记右
        + ' | cbp光标START_vs标记END=' + 真值.cbp_光标START_vs_标记END + ' cbp光标START_vs标记START=' + 真值.cbp_光标START_vs_标记START
        + ' cbp标记START_vs光标END=' + 真值.cbp_标记START_vs_光标END);
      console.log('   期望=' + 例.期望 + ' → ' + (判.pass ? '✅ 成立' : '❌ 不成立') + ' ' + 判.细节);
    }
    报告.判据 = 报告.用例.map(条 => ({ 名: 条.名, 放: 条.放.偏移, 角色: 条.放.在标记内 ? '标记内' : '标记外',
      甲: 条.真值.甲_标记整枚在左, 乙: 条.真值.乙_标记整枚在左, 丙: 条.真值.丙_几何在标记右,
      cbp_START_TO_END: 条.真值.cbp_光标START_vs_标记END, cbp_START_TO_START: 条.真值.cbp_光标START_vs_标记START,
      cbp_markerSTART_vs_caretEND: 条.真值.cbp_标记START_vs_光标END, 标记文本: 条.真值.标记文本 }));

    // ── 8. 带行内公式：拆分 / 立刻退格 / Ctrl+Z（数据保真面）────────────────────
    //  ⚠️ 磁盘证人必须是**应用真正打开的那个文档**：本探针只启动一个文档（launch 的 args=[file]），
    //  所有 setValue 都改的是它。上一版误把 writeDoc 另建的 math 文件当证人，于是"存盘"永远读到
    //  旧内容（验收工具自己的 bug 会伪装成产品 bug）。现在一律以 `file` 为准，并记 mtime。
    const 公式组 = [];
    const 读盘 = f => ({ 内容: fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/\r/g, '') : null, mtime: fs.existsSync(f) ? fs.statSync(f).mtime.toISOString() : null });
    // 8a 标记之后 Enter → 公式仍在盘上
    await session.js(置文(MATH)); await hi.sleep(600);
    await session.js(放光标('marker', 4)); await hi.sleep(160);
    const 前8 = await session.js(读结构);
    await 拍照(session, `${TAG}-8a-公式-前`, 前8);
    const 原件 = 读盘(file);
    await 回车(session);
    const 后8 = await session.js(读结构);
    const md8 = await hi.mdNow(session);
    await 拍照(session, `${TAG}-8a-公式-后`, 后8);
    const 盘8 = await edge.saveAndWait(session, file, { timeout: 9000 });
    公式组.push({ 步: '8a 标记之后 Enter', 后块: 后8.块.map(b => b.tag + (b.标记 || '') + (b.空 ? '(空)' : ':' + b.文本)), md: md8,
      盘面: String(盘8.after).replace(/\r/g, ''), 走按键存盘: 盘8.chordTook, 兜底报错: 盘8.fallbackError || null, mtime: 读盘(file).mtime, 原件: 原件.内容 });
    console.log('\n【8a 公式·标记之后 Enter】后：' + 后8.块.map(b => b.tag + (b.标记 || '') + (b.空 ? '(空)' : ':' + b.文本)).join(' | '));
    console.log('   md（产品自报）=' + JSON.stringify(md8));
    console.log('   盘面=' + JSON.stringify(String(盘8.after).replace(/\r/g, '')) + '  走 Ctrl+S 通道=' + 盘8.chordTook + '  兜底报错=' + (盘8.fallbackError || '无'));
    // 8b 立刻退格合并 → 公式仍不许丢
    if (!(await session.js(读焦点)).ok) await hi.ensureFocus(session);
    await 退格(session);
    const 后8b = await session.js(读结构);
    const md8b = await hi.mdNow(session);
    await 拍照(session, `${TAG}-8b-公式-退格后`, 后8b);
    const 盘8b = await edge.saveAndWait(session, file, { timeout: 9000 });
    公式组.push({ 步: '8b 退格合并', 后块: 后8b.块.map(b => b.tag + (b.标记 || '') + (b.空 ? '(空)' : ':' + b.文本)), md: md8b,
      盘面: String(盘8b.after).replace(/\r/g, ''), 走按键存盘: 盘8b.chordTook, 兜底报错: 盘8b.fallbackError || null, mtime: 读盘(file).mtime });
    console.log('【8b 退格后】后：' + 后8b.块.map(b => b.tag + (b.标记 || '') + (b.空 ? '(空)' : ':' + b.文本)).join(' | '));
    console.log('   md（产品自报）=' + JSON.stringify(md8b));
    console.log('   盘面=' + JSON.stringify(String(盘8b.after).replace(/\r/g, '')) + '  含公式=' + String(盘8b.after).includes('$a+b=c$') + '  走 Ctrl+S 通道=' + 盘8b.chordTook);
    // 8c Ctrl+Z
    await session.js(置文(MATH)); await hi.sleep(600);
    await session.js(放光标('marker', 4)); await hi.sleep(160);
    await 回车(session);
    const 拆9 = await session.js(读结构);
    if (!(await session.js(读焦点)).ok) await hi.ensureFocus(session);
    await 撤销(session);
    const 后9 = await session.js(读结构);
    await 拍照(session, `${TAG}-8c-公式-撤销后`, 后9);
    公式组.push({ 步: '8c Ctrl+Z', 拆时: 拆9.块.map(b => b.tag + (b.标记 || '') + (b.空 ? '(空)' : ':' + b.文本)), 撤销后: 后9.块.map(b => b.tag + (b.标记 || '') + (b.空 ? '(空)' : ':' + b.文本)), md: await hi.mdNow(session) });
    console.log('【8c Ctrl+Z】拆分时：' + 拆9.块.map(b => b.tag + (b.标记 || '') + (b.空 ? '(空)' : ':' + b.文本)).join(' | '));
    console.log('        撤销后：' + 后9.块.map(b => b.tag + (b.标记 || '') + (b.空 ? '(空)' : ':' + b.文本)).join(' | '));
    报告.公式组 = 公式组;

    // ── 8d 真人路径：鼠标点标题正文（真 click 展开标记）→ ← 逐次左移到"紧贴标记之后" → 真回车 ──
    await session.js(置文(BODY)); await hi.sleep(700);
    const 标题点 = await session.js(`(() => { const w = ${hi.IF}, d = w.document; const fr = document.getElementById('editor').getBoundingClientRect();
      const s = d.querySelector('${hi.SURFACE}'); const h = s.querySelector('h1,h2,h3,h4,h5,h6');
      const t = [...h.childNodes].find(n => n.nodeType === 3 && n.data.trim());
      const r = d.createRange(); r.setStart(t, Math.min(3, t.data.length)); r.setEnd(t, Math.min(4, t.data.length));
      const b = r.getBoundingClientRect();
      return { x: Math.round(fr.x + b.left + 2), y: Math.round(fr.y + b.top + b.height / 2) }; })()`);
    await session.click(标题点.x, 标题点.y);
    await hi.sleep(500);
    const 真人步 = [];
    let 到位 = null;
    for (let 按 = 0; 按 <= 8; 按++) {
      const 紧 = await session.js(读紧贴标记之后);
      真人步.push({ 左移次数: 按, 形状: 紧.形状, 紧贴: 紧.紧贴 });
      if (紧.紧贴) { 到位 = 按; break; }
      await 键(session, { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }, 320);
    }
    console.log('\n【8d 真人路径】点标题正文后逐次 ← ：' + 真人步.map(步 => `×${步.左移次数}:${步.形状}${步.紧贴 ? '【紧贴标记之后】' : ''}`).join(' → '));
    const 真前 = await session.js(读结构);
    await 拍照(session, `${TAG}-8d-真人-前`, 真前);
    await 回车(session);
    const 真后 = await session.js(读结构);
    const 真md = await hi.mdNow(session);
    await 拍照(session, `${TAG}-8d-真人-后`, 真后);
    const 真判 = 判定(真后, '标记钉原行');
    报告.真人路径 = { 点: 标题点, 步: 真人步, 到位于第几次左移: 到位, 后块: 真后.块.map(b => b.tag + (b.标记 || '') + (b.空 ? '(空)' : ':' + b.文本)), 光标: 真后.光标, md后: 真md, 判定: 真判 };
    console.log('   键盘路径到位（第 ' + 到位 + ' 次 ← 后即"紧贴标记之后"）：' + (到位 !== null ? '是' : '否'));
    console.log('   真回车后：' + 报告.真人路径.后块.join(' | ') + '  md=' + JSON.stringify(真md));
    console.log('   期望=标记钉原行 → ' + (真判.pass ? '✅ 成立' : '❌ 不成立') + ' ' + 真判.细节);

    // ── 8e 空标题拆分后的落点能不能用：真打字（insertText）看字落在哪一块 + 撤销 ──────
    await session.js(置文(EMPTY)); await hi.sleep(700);
    await session.js(放光标('marker', 4)); await hi.sleep(160);
    await 回车(session);
    const 空前 = await session.js(读结构);
    const 空可见 = await session.js(读光标可见);
    await session.type('甲');   // 真实输入通道（IME 上屏同一条）
    await hi.sleep(500);
    const 空后 = await session.js(读结构);
    const 空md = await hi.mdNow(session);
    await 拍照(session, `${TAG}-8e-空标题-打字后`, 空后);
    if (!(await session.js(读焦点)).ok) await hi.ensureFocus(session);
    await 撤销(session);
    const 空撤 = await session.js(读结构);
    报告.空标题落点 = { 拆分后块: 空前.块.map(b => `${b.tag}${b.标记 || ''}${b.空 ? '(空)' : ':' + b.文本}[框高${b.框.h}]`),
      拆分后光标可见: 空可见, 打字后块: 空后.块.map(b => `${b.tag}${b.标记 || ''}${b.空 ? '(空)' : ':' + b.文本}`), 打字后md: 空md,
      撤销后块: 空撤.块.map(b => `${b.tag}${b.标记 || ''}${b.空 ? '(空)' : ':' + b.文本}`) };
    console.log('\n【8e 空标题拆分后的落点】拆分后：' + 报告.空标题落点.拆分后块.join(' | '));
    console.log('   拆分后光标可见读数：' + JSON.stringify(空可见));
    console.log('   真打字「甲」之后：' + 报告.空标题落点.打字后块.join(' | ') + '  md=' + JSON.stringify(空md));
    console.log('   Ctrl+Z 之后：' + 报告.空标题落点.撤销后块.join(' | '));

    // ── 10. 真屏连拍：拆分之后的光标**在屏幕上到底画没画出来**（原生 caret 只在屏幕像素里）──
    if (argOf('screen', '0') === '1') {
      const 窗口 = () => session.main.js(`(() => { const {BrowserWindow, screen} = require('electron');
        const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
        return { content: win.getContentBounds(), scale: screen.getDisplayMatching(win.getBounds()).scaleFactor,
          hwnd: win.getNativeWindowHandle().readBigUInt64LE(0).toString(16) }; })()`);
      const 顶前 = () => session.main.js(`(() => { const {BrowserWindow} = require('electron');
        const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
        win.setAlwaysOnTop(true); win.show(); win.focus(); if (win.moveTop) win.moveTop(); return 1; })()`);
      const 收顶 = () => session.main.js(`(() => { const {BrowserWindow} = require('electron');
        const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed()); win.setAlwaysOnTop(false); return 1; })()`);
      const 连拍 = async (标签, 区域, 帧数 = 12) => {
        await 顶前(); await hi.sleep(600);
        const info = await 窗口();
        const 回执 = PS('win-screen-burst.ps1', ['-OutPrefix', path.join(OUT, 标签), '-Hwnd', info.hwnd,
          '-X', String(Math.round((info.content.x + 区域.x) * info.scale)),
          '-Y', String(Math.round((info.content.y + 区域.y) * info.scale)),
          '-W', String(Math.round(区域.w * info.scale)), '-H', String(Math.round(区域.h * info.scale)),
          '-Count', String(帧数), '-IntervalMs', '150']);
        await 收顶();
        console.log(`\n[真屏连拍] ${标签} 区域(CSS)=${JSON.stringify(区域)} 缩放=${info.scale}`);
        for (const line of String(回执).split('\n').filter(Boolean)) console.log('   ' + line);
        return { 区域, 缩放: info.scale, 回执: String(回执) };
      };
      const 第二块区域 = async () => session.js(`(() => { const w = ${hi.IF}, d = w.document;
        const fr = document.getElementById('editor').getBoundingClientRect(); const s = d.querySelector('${hi.SURFACE}');
        const b = s.children[1]; if (!b) return { ok: false };
        const r = b.getBoundingClientRect();
        return { ok: true, x: Math.round(fr.x + r.left) - 34, y: Math.round(fr.y + r.top) - 10,
          w: 110, h: Math.round(r.height) + 20, 块: b.tagName, 块内HTML: String(b.innerHTML).slice(0, 60),
          块框: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }; })()`);

      // 10a 对照：正文「后文。」里点一下 → 原生光标一定画得出来（证明这套抓帧看得见光标）
      await session.js(置文(BODY)); await hi.sleep(700);
      const 对照点 = await session.js(`(() => { const w = ${hi.IF}, d = w.document; const fr = document.getElementById('editor').getBoundingClientRect();
        const s = d.querySelector('${hi.SURFACE}'); const p = [...s.children].find(b => b.textContent.includes('后文'));
        const t = [...p.childNodes].find(n => n.nodeType === 3 && n.data.trim());
        const r = d.createRange(); r.setStart(t, 1); r.setEnd(t, 2); const b = r.getBoundingClientRect();
        return { 点: { x: Math.round(fr.x + b.left + 3), y: Math.round(fr.y + b.top + b.height / 2) },
          区: { x: Math.round(fr.x + b.left) - 34, y: Math.round(fr.y + b.top) - 10, w: 110, h: Math.round(b.height) + 20 } }; })()`);
      await session.click(对照点.点.x, 对照点.点.y); await hi.sleep(450);
      const 对照 = await 连拍(`${TAG}-10a对照-正文`, 对照点.区);
      // 10b 本轮核心：`### |标题内容` 拆分之后，第二行（新段落）的光标画没画出来
      await session.js(置文(BODY)); await hi.sleep(600);
      await session.js(放光标('marker', 4)); await hi.sleep(160);
      await 回车(session);
      const 区1 = await 第二块区域();
      const 拍1 = 区1.ok ? await 连拍(`${TAG}-10b-拆分后-第二行`, 区1) : null;
      // 10c 空标题拆分之后（第二行是空段）
      await session.js(置文(EMPTY)); await hi.sleep(600);
      await session.js(放光标('marker', 4)); await hi.sleep(160);
      await 回车(session);
      const 区5 = await 第二块区域();
      const 拍5 = 区5.ok ? await 连拍(`${TAG}-10c-空标题拆分后-空段`, 区5) : null;
      报告.真屏连拍 = { 对照: 对照, 拆分后: { 区: 区1, 拍: 拍1 }, 空标题: { 区: 区5, 拍: 拍5 } };
    }

    // ── 9. 「两种光标位置是否同形」的像素级比对（干净整页图的哈希）──────────────
    const 图1 = 报告.用例.find(条 => 条.名 === '1-光标在标记之后');
    const 图2 = 报告.用例.find(条 => 条.名 === '2-光标在标记之前');
    const 哈希 = 文件2 => (文件2 && fs.existsSync(文件2)) ? crypto.createHash('sha256').update(fs.readFileSync(文件2)).digest('hex').slice(0, 20) : null;
    报告.同形比对 = {
      标记之后_干净整页_hash: 哈希(图1 && 图1.图.后.干净图),
      标记之前_干净整页_hash: 哈希(图2 && 图2.图.后.干净图),
      后_块结构相同: JSON.stringify(图1.后.块.map(b => [b.tag, b.标记, b.空, b.文本, b.字号])) === JSON.stringify(图2.后.块.map(b => [b.tag, b.标记, b.空, b.文本, b.字号])),
      后_光标相同: JSON.stringify(图1.后.光标) === JSON.stringify(图2.后.光标),
      后_md相同: 图1.md后 === 图2.md后,
    };
    报告.同形比对.整页像素完全一致 = !!报告.同形比对.标记之后_干净整页_hash && 报告.同形比对.标记之后_干净整页_hash === 报告.同形比对.标记之前_干净整页_hash;
    console.log('\n【同形比对（用户问的"那不就一样了吗"）】' + JSON.stringify(报告.同形比对, null, 1));

    const 焦点终 = await session.js(读焦点);
    报告.错误面 = session.errors.filter(m => !/Electron sandboxed_renderer|preloadScripts/.test(m));
    console.log('\n会话报错（去掉 Electron 沙箱已知噪声）：' + JSON.stringify(报告.错误面));
    console.log('最终焦点=' + JSON.stringify(焦点终));
  } finally {
    for (const 项 of 收尾) await 项;
    fs.writeFileSync(path.join(OUT, TAG + '-facts.json'), JSON.stringify(报告, null, 2));
    console.log('\n事实台账 → ' + path.join(OUT, TAG + '-facts.json'));
    await session.close();
  }
})().catch(error => { console.error('探针异常：' + (error && error.stack || error)); process.exitCode = 1; });
