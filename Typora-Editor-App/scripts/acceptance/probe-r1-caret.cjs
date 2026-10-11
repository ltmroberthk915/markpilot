/** 探针 · 第 1 轮判决落实（2026-10-02）的实机验收：A2 / A4 / C1 / C2 / C4 / C5 / C6 / C7 八条
 *  修复的"未修复必红、修复后转绿"，外加 EVIDENCE-C3（分栏 ↓ 是否吞键）与 EVIDENCE-B6（折叠
 *  块公式行尾 → 的落点与打字去向）两个只取证用例。
 *
 *  判据全部是**用户能看见的性质**（光标在哪一层、删没删字、目标列对不对、合成线在不在），
 *  绝不断言"处理器被调用了"。每用例一行：
 *     R1CARET <用例名> PASS/FAIL/EVIDENCE <关键读数 JSON>
 *  每用例存整页 + 光标附近 2x 放大截图到 .perf/probe-r1-caret/。CDP 抓帧拍不到原生光标，
 *  图上按浏览器自报的光标矩形画标记：红实线＝光标落点、琥珀虚线＝目标列、青虚线＝点击处；
 *  光标真的隐形（0×0）时标记画不出来——那本身就是"光标没了"的视觉证据。
 *
 *  各用例的红条件（未修复版上必红）：
 *   A2  折行公式点末行闭 $ 右侧：旧判法用 owner 并集盒中线，点击 x 在中线左侧 → 光标被塞回
 *       公式前（侧=-1）；点首行开 $ 左半应落公式前（侧=-1）。
 *   A4  x$a$ 展开光标到开 $ 左半按退格：旧版 preventDefault+selectOutside 只挪不删，md 仍含
 *       x$a$；修复后一次退格删掉 'x'（md 含 $a$ 且不含 x$a$）。
 *   C1  固定列按 ↓ 后 150ms 内 insertText：旧版 200ms 重放窗口把光标按旧目标列拽回——前缀
 *       不以新字结尾；修复后光标停在新字之后。
 *   C2  公式源码里输 \fra 弹补全后按 ↑↓：旧版纵向接管吞键——弹窗高亮不动、正文光标自走；
 *       修复后高亮移动且正文光标纹丝不动。
 *   C4  文档以 $x$ 结尾按 End / Ctrl+End：旧版裸 caretRect 0×0 判隐形 → 行端兜底把光标塞进
 *       公式源码末尾（层=源码）；修复后光标停公式后（侧=+1）。
 *   C5  折叠 $$ 块上一行按 ↓：旧版把折叠源码（0×0）筛掉整块跳过（层=正文）；修复后中途落进
 *       公式源码（层=块源码）。
 *   C6  空段落光标（合成线）滚一屏再滚回：旧版滚动只收线不重算，合成线永久消失；修复后仍在。
 *   C7  某列连按 ↓ 后点大纲跳标题再按 ↓：旧版 goalX 残留旧列；修复后目标列取当前列。
 *
 *  用法：node scripts/acceptance/probe-r1-caret.cjs [--only=a2,c4,...]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-r1-caret');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');

const 求和块 = i => '\\sum_{k=' + i + '}^{' + (i + 30) + '}\\frac{k+1}{k+2}+\\frac{k^2+2k}{k^3+3}'
  + '+\\sqrt{k^2+k+1}+\\frac{1}{k+4}';
// 六段连加分式：实测一段只折 1 行，六段（约 30 个可断排的原子）保证 ≥3 行
const 长公式 = '$S=\\bigg(' + [1, 31, 61, 91, 121, 151].map(求和块).join('+') + '\\bigg)+C$';
const 填充 = label => label + '：这是一段用来把文档撑高的填充文字，写足够多的字让它折成好几行，'
  + '滚轮才有得滚、纵向移动才有得走；内容本身不参与任何判据，只提供真实的排版几何。'
  + '再补一句让这一段稳定超过两行，避免边界效应影响阅读与滚动。';

const DOC1 = ['# 折行判侧文档', '',
  '甲段落：用来隔开的普通文字，至少一行。', '',
  // 【A2 判据口径（绿轮裁定后）】击点必须取"内容边缘之外的空白侧"：
  //   首击＝首行**内容左缘之外**的空白 → 公式前；末击＝末行**内容右缘之外**的空白 → 公式后。
  // 首尾各留一个正文字（甲/乙）让钳位后 selectOutside 落在**真实文本位置**上（公式独占段落时
  // 落的是元素级位置，会被 Vditor 归一化拽回源码——那不是 A2 判侧的语义）。末行内容短时
  // 击末.x < owner并集中线，旧的中线判侧法把"公式后"判成"公式前"——判别力在末击。
  '甲' + 长公式 + '乙', '',
  '乙段落：收尾文字。', '',
  '$x$', ''].join('\n');
const DOC2 = ['# 判决甲文档', '',
  '甲长段落：' + '纵向移动与打字回跳的判读都在这一段上做，' + 填充('其一'), '',
  '## 判决乙', '',
  '乙长段落：' + '大纲跳转之后的目标列判读在这一段上做，' + 填充('其二'), '',
  '前缀x$a$后缀', '',
  'C6锚点段：回车造空段用的段落，后面跟的都是填充。', '',
  填充('填充一'), '', 填充('填充二'), '', 填充('填充三'), '', 填充('填充四'), '', 填充('填充五'), '',
  填充('填充六'), '', 填充('填充七'), ''].join('\n');
const DOC3 = ['# 补全弹窗文档', '',
  '空行起手段：文字若干，给美元符起手留位。', ''].join('\n');
const DOC4 = ['# 块公式逐行文档', '',
  '首段行尾在这里：收束文字。', '',
  '$$\nE=mc^2+\\int_0^1 x\\,\\mathrm{d}x\n$$', '',
  '尾段文字：承接句子。', '',
  '再一段正文：给分栏取证预留的行，多写几个字。', ''].join('\n');

// ─── 页内工具（装进编辑器 iframe；标记画法沿用 probe-real-ops 的 __pr 口径） ─────────
const HELPERS = `window.__r1 = (() => {
  const layerOf = at => !at ? '?' :
    at.closest && at.closest('code[data-type="math-block"]') ? '块源码'
    : at.closest && at.closest('code[data-type]') ? '源码'
    : at.closest && at.closest('.vditor-ir__preview') ? '预览'
    : at.closest && at.closest('[data-type$="-marker"]') ? '围栏'
    : at.closest && at.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th') ? '正文' : '元素级';
  const mark = list => {
    const old = document.getElementById('__r1_marks');
    if (old) old.remove();
    if (!list || !list.length) return 0;
    const layerNode = document.createElement('div');
    layerNode.id = '__r1_marks';
    layerNode.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    let drawn = 0;
    for (const item of list) {
      if (!item) continue;
      const line = document.createElement('div');
      const height = Math.max(2, item.h || 18);
      line.style.cssText = 'position:fixed;pointer-events:none;'
        + 'left:' + Math.round(item.x) + 'px;top:' + Math.round(item.y) + 'px;'
        + 'width:' + (item.dash ? 0 : 2) + 'px;height:' + height + 'px;'
        + 'border-left:' + (item.dash ? '1.5px dashed ' + item.color : '2px solid ' + item.color) + ';'
        + 'background:' + (item.dash ? 'none' : item.color) + ';';
      layerNode.appendChild(line);
      drawn += 1;
      if (item.label) {
        const tag = document.createElement('div');
        tag.textContent = item.label;
        tag.style.cssText = 'position:fixed;pointer-events:none;font:11px/1.2 monospace;white-space:nowrap;'
          + 'left:' + (Math.round(item.x) + 3) + 'px;top:' + (Math.round(item.y) - 15) + 'px;color:' + item.color + ';';
        layerNode.appendChild(tag);
      }
    }
    document.body.appendChild(layerNode);
    return drawn;
  };
  const unmark = () => { const old = document.getElementById('__r1_marks'); if (old) old.remove(); return 1; };
  const caret = () => {
    const s = getSelection();
    if (!s || !s.rangeCount) return { 无选区: true };
    const n = s.focusNode, o = s.focusOffset;
    const at = n.nodeType === 3 ? n.parentElement : n;
    let b = null;
    try { const probe = document.createRange(); probe.setStart(n, o); probe.collapse(true); b = probe.getBoundingClientRect(); } catch (e) {}
    return { 层: layerOf(at),
      容器: n.nodeType === 3 ? ('TEXT「' + String(n.data).slice(0, 12) + '」') : n.nodeName,
      偏移: o, 前缀: n.nodeType === 3 ? String(n.data).slice(Math.max(0, o - 20), o) : '',
      x: Math.round(b.left), y: Math.round(b.top), h: Math.round(b.height),
      可见: !!(b && b.height), 折叠: s.isCollapsed };
  };
  const pick = which => {
    const list = [...document.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
    if (!list.length) return null;
    if (which === 'last') return list[list.length - 1];
    if (which === 'a') return list.find(o => String((o.querySelector('code[data-type="math-inline"]') || {}).textContent || '').replace(/\\s/g, '') === 'a') || null;
    let owner = null, w = 0;
    for (const o of list) { const b = o.getBoundingClientRect(); if (!b.height) continue; const area = b.width * b.height; if (area > w) { w = area; owner = o; } }
    return owner;
  };
  const vsOf = owner => {
    const s = getSelection();
    if (!owner || !s || !s.rangeCount || !s.focusNode) return { 有: !!owner };
    try {
      const box = document.createRange(); box.selectNode(owner);
      const point = document.createRange();
      point.setStart(s.focusNode, Math.min(s.focusOffset,
        s.focusNode.nodeType === 3 ? s.focusNode.length : s.focusNode.childNodes.length));
      point.collapse(true);
      // comparePoint 在"公式独占段落"里退化（P@0/P@1 恰是 range 两端）；用 compareBoundaryPoints
      // 分侧（实测校准：公式内的点 START_TO_START=−1、END_TO_END=+1）：
      //   前 ⇔ 光标起点不晚于公式起点（vsStart≥0，含压在起点边界上）；
      //   后 ⇔ 光标终点不早于公式终点（vsEnd≤0，含压在终点边界上）；其余＝公式内。
      const vsStart = box.compareBoundaryPoints(Range.START_TO_START, point);
      const vsEnd = box.compareBoundaryPoints(Range.END_TO_END, point);
      return { 有: true, 在公式内: owner.contains(s.focusNode),
        侧: vsStart >= 0 ? -1 : (vsEnd <= 0 ? 1 : 0) };
    } catch (e) { return { 有: true, err: String(e) }; }
  };
  return {
    caret, mark, unmark,
    vsInline(which) { return vsOf(pick(which)); },
    vsBlock() { return vsOf(document.querySelector('.vditor-ir__node[data-type="math-block"]')); },
    blockMath() { const o = document.querySelector('.vditor-ir__node[data-type="math-block"]');
      if (!o) return { 有: false };
      const code = o.querySelector('pre > code[data-type="math-block"]');
      return { 有: true, 展开: o.classList.contains('vditor-ir__node--expand'),
        源码: code ? code.textContent.slice(0, 24) : null }; },
    /** 块公式的收折前置证据：无 expand 类、源码不可见、预览可见——三条齐了才叫"收折态"。
     *  附 computed display 与预览文本头：实测旧副本有"无 expand 类但源码可见"的中间态，诊断用。 */
    blockState() { const o = document.querySelector('.vditor-ir__node[data-type="math-block"]');
      if (!o) return { 有: false };
      const code = o.querySelector('pre > code[data-type="math-block"]') || o.querySelector('code[data-type="math-block"]');
      const pre = code ? code.parentElement : null;
      const preview = o.querySelector(':scope > .vditor-ir__preview');
      const cb = code ? code.getBoundingClientRect() : null;
      const pb = preview ? preview.getBoundingClientRect() : null;
      const disp = el => el ? getComputedStyle(el).display : null;
      const 样 = el => el ? (disp(el) + '/' + getComputedStyle(el).visibility + '/' + Math.round(el.getBoundingClientRect().height) + 'px/ovf:' + getComputedStyle(el).overflow) : null;
      return { 有: true, 展开: o.classList.contains('vditor-ir__node--expand'),
        源码可见: !!(cb && cb.height > 0), 预览有盒: !!(pb && pb.height > 0),
        code样: 样(code), pre样: 样(pre), preview样: 样(preview),
        owner类: String(o.className),
        previewHead: preview ? String(preview.textContent || '').slice(0, 24) : null }; },
    collapseBlockMath() { const o = document.querySelector('.vditor-ir__node[data-type="math-block"]');
      if (!o) return { ok: false };
      o.classList.remove('vditor-ir__node--expand');
      return { ok: true }; },
    popup() { const p = document.querySelector('.md-completion');
      if (!p) return { 有: false };
      const buttons = [...p.querySelectorAll('button')];
      const idx = buttons.findIndex(b => b.getAttribute('aria-selected') === 'true');
      return { 有: true, hidden: !!p.hidden, 项数: buttons.length, 选中: idx,
        选中项: idx >= 0 ? buttons[idx].textContent.trim().slice(0, 24) : null }; },
    proxy() { const el = document.querySelector('[data-typora-caret-proxy]');
      if (!el) return { 有: false };
      const shown = el.style.display === 'block';
      const r = el.getBoundingClientRect();
      return { 有: true, 显示: shown, x: Math.round(r.left), y: Math.round(r.top), h: Math.round(r.height) }; },
    scrollY() { const s = document.querySelector('.vditor-ir .vditor-reset'); return s ? -Math.round(s.getBoundingClientRect().top) : 0; },
    /** 与产品 patchSyntheticCaret 同口径的"版面内容行盒"证据：光标前/后取得到真实内容行盒
     *  ＝ Blink 自己画得出原生光标（Range 矩形 0×0 也算画得出）。 */
    版面有行盒() {
      const s = getSelection(); if (!s || !s.rangeCount || !s.focusNode) return null;
      const surface = document.querySelector('.vditor-ir .vditor-reset');
      const node = s.focusNode, at = node.nodeType === 3 ? node.parentElement : node;
      const 块 = at && at.closest ? at.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th') : null;
      if (!块 || 块 === surface || !块.contains(node)) return null;
      const 夹 = (n, o) => Math.min(Math.max(o | 0, 0), n.nodeType === 3 ? n.length : n.childNodes.length);
      const 有 = (range, 取后) => { let rects = []; try { rects = [...range.getClientRects()]; } catch (e) { return false; }
        if (取后) { for (let i = rects.length - 1; i >= 0; i--) if (rects[i].height > 0) return true; return false; }
        return rects.some(b => b.height > 0); };
      try {
        const 前 = document.createRange(); 前.setStart(块, 0); 前.setEnd(node, 夹(node, s.focusOffset));
        if (有(前, true)) return true;
        const 后 = document.createRange(); 后.setStart(node, 夹(node, s.focusOffset)); 后.setEnd(块, 块.childNodes.length);
        if (有(后, false)) return true;
      } catch (e) {}
      return false;
    },
    /** 定点放上"fenceClick 对开 $ 左半点击给的同一位置"（开围栏标记文本 offset 0）。
     *  程序化落点不会触发 Vditor 展开（实测口径见 patchBlankBandClick 注释），而补丁分支只认
     *  展开态——这里显式补上 expand 类，把"展开 + 光标在开 $ 边界"钉成确定状态。 */
    placeAtOpenFence(src) {
      const owner = pick(src);
      if (!owner) return { ok: false, error: '没找到源码为 ' + src + ' 的公式' };
      const marker = owner.firstElementChild;
      const text = marker && marker.firstChild;
      if (!text || text.nodeType !== 3) return { ok: false, error: '开围栏没有文本' };
      owner.classList.add('vditor-ir__node--expand');
      const sel = getSelection(); sel.removeAllRanges();
      const r = document.createRange(); r.setStart(text, 0); r.collapse(true); sel.addRange(r);
      return { ok: true, 位置: 'marker@0' };
    },
  };
})();`;

const INSTALL = `(() => { const w = ${hi.IF};
  if (!w || !w.document.querySelector('${hi.SURFACE}')) return { ok: false };
  if (!w.__r1) w.eval(${JSON.stringify(HELPERS)});
  return { ok: !!w.__r1 }; })()`;
const IN = expression => `(() => { const w = ${hi.IF}; return w.eval(${JSON.stringify(expression)}); })()`;
const readCaret = session => session.js(IN('window.__r1.caret()'));
const caretMark = r => (r && r.可见) ? [{ x: r.x, y: r.y, h: r.h, color: '#ff2d2d', label: '光标' }] : [];
const frameOf = session => session.js(`(() => { const f = document.getElementById('editor');
  const r = f.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()`);
const clickIn = (session, frame, x, y) => session.click(frame.x + x, frame.y + y);
const key = async (session, name, vk, wait = 300, modifiers = 0) => {
  await session.key({ key: name, code: name, vk, modifiers });
  await harness.sleep(wait);
};
const focusOK = async session => (await hi.ensureFocus(session)).ok;

/** 整页 + 光标附近 2x 放大截图（放大帧上带标记：红实线＝光标、琥珀虚线＝目标列、青虚线＝点击处）。 */
async function shots(session, frame, name, anchor, marks) {
  try {
    const clip = { x: frame.x + Math.max(0, (anchor && anchor.x || 300) - 240),
      y: frame.y + Math.max(0, (anchor && anchor.y || 300) - 55), width: 560, height: 165, scale: 2 };
    if (marks && marks.length) await session.js(IN('window.__r1.mark(' + JSON.stringify(marks) + ')'));
    const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(OUT, name + '-2x.png'), Buffer.from(shot.data, 'base64'));
    await session.js(IN('window.__r1.unmark()'));
    await session.shot(name + '-full');
  } catch (error) { console.log('  （截图失败 ' + name + '：' + String(error && error.message || error).slice(0, 120) + '）'); }
}

// ─── 用例 ───────────────────────────────────────────────────────────────────────

/** A2：折行长公式（展开后源码跨 ≥3 行）点首行开 $ 左半 → 公式前；点末行闭 $ 右侧 → 公式后。
 *  判侧补丁的真实触发面是**展开态**（围栏有像素、Blink 把贴栏点击解进节点、钳位才出手）——
 *  折叠态点内容外缘时 Blink 自己就给对段落位置（实测侧=0/正确，不走红绿分岔）。 */
async function caseA2(session) {
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点' } };
  const 最长公式 = `(() => { const owners = [...document.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
    let owner = null, w = 0;
    for (const o of owners) { const b = o.getBoundingClientRect(); if (!b.height) continue;
      const area = b.width * b.height; if (area > w) { w = area; owner = o; } }
    return owner; })()`;
  const 预览中心 = `(() => { const owner = ${最长公式}; if (!owner) return null;
    const pv = owner.querySelector(':scope > .vditor-ir__preview'); if (!pv) return null;
    const b = pv.getBoundingClientRect(); if (!b.height) return null;
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`;
  const 展开几何 = `(() => { const owner = ${最长公式}; if (!owner) return { ok: false, 公式数: 0 };
    if (!owner.classList.contains('vditor-ir__node--expand')) return { ok: false, 原因: '未展开' };
    const 开 = owner.firstElementChild.getBoundingClientRect();
    const 闭 = owner.lastElementChild.getBoundingClientRect();
    const code = owner.querySelector('code[data-type="math-inline"]');
    // 行数不能数 code 元素自己的 getClientRects（它是 inline-block，永远一个盒）；
    // 取**内容区间**的矩形、按行顶去重——这才是"源码排成几行"
    let 行数 = 0;
    if (code) { try { const r = document.createRange(); r.selectNodeContents(code);
      const rows = [...new Set([...r.getClientRects()].filter(b => b.height > 0).map(b => Math.round((b.top + b.height / 2) / 10)))];
      行数 = rows.length; } catch (e) {} }
    const b = owner.getBoundingClientRect();
    if (!开.width || !闭.width) return { ok: false, 原因: '围栏无像素', 行数 };
    // 首行内容左缘 / 末行内容右缘：所在段落这一行上**可见字形**的最左/最右（含正文邻字与围栏）。
    // 击点要落在这两条缘之外的空白里，才分别是"开 $ 左半外侧 / 闭 $ 右侧空白"。
    const 段 = owner.closest('p') || owner.parentElement;
    let 首行内容左 = Math.round(开.left), 末行内容右 = Math.round(闭.right);
    try { const r = document.createRange(); r.selectNodeContents(段);
      const rows = [...r.getClientRects()].filter(x => x.height > 0 && x.width > 0);
      const 同行 = (x, ref) => x.top < ref.bottom - 2 && x.bottom > ref.top + 2;
      for (const x of rows) { if (同行(x, 开)) 首行内容左 = Math.min(首行内容左, Math.round(x.left));
        if (同行(x, 闭)) 末行内容右 = Math.max(末行内容右, Math.round(x.right)); } } catch (e) {}
    return { ok: 行数 >= 3, 行数,
      开: { l: Math.round(开.left), w: Math.round(开.width), cy: Math.round(开.top + 开.height / 2) },
      闭: { r: Math.round(闭.right), cy: Math.round(闭.top + 闭.height / 2) },
      首行内容左, 末行内容右, ownerMid: Math.round(b.left + b.width / 2) }; })()`;
  const 进展开 = async () => {
    const frame = await frameOf(session);
    const c = await session.js(IN(预览中心));
    if (c && c.x) { await clickIn(session, frame, c.x, c.y); await harness.sleep(650); }
  };
  // 展开并等源码真的排出 ≥3 行（KaTeX/重排异步，最多约 8s；展开可能被中途收起，隔几拍补点一次）
  let geo = null;
  await 进展开();
  for (let i = 0; i < 14; i++) {
    geo = await session.js(IN(展开几何));
    if (geo && geo.ok) break;
    if (i === 3 || i === 7 || i === 11) await 进展开();
    await harness.sleep(500);
  }
  try {
    if (!geo || !geo.ok) return { verdict: 'FAIL', detail: { 阶段: '几何（展开后源码没有 3 行？）', geo } };
    let frame = await frameOf(session);
    // ① 首行开 $ 左半＝首行**内容左缘之外**的空白（左移 8px）。期望：公式前（侧=−1）。
    //    这是正确性检查：空白永远在并集中线左侧，旧版中线判侧在这一侧也判"前"，不具判别力。
    const 击首 = { x: geo.首行内容左 - 8, y: geo.开.cy };
    await clickIn(session, frame, 击首.x, 击首.y);
    await harness.sleep(420);
    const r1 = await readCaret(session); const s1 = await session.js(IN('window.__r1.vsInline("long")'));
    await shots(session, frame, 'A2-首行左半', 击首,
      [...caretMark(r1), { x: 击首.x, y: 击首.y, h: 22, dash: true, color: '#25d0ff', label: '点击处' }]);
    // 复位（点击后光标被钳出、公式可能收折），再重新展开读末行几何
    await session.js(hi.placeAfterPrefix('收尾文字'));
    await harness.sleep(150);
    await 进展开();
    const geo2 = await session.js(IN(展开几何));
    if (!geo2 || !geo2.ok) return { verdict: 'FAIL', detail: { 阶段: '二次展开几何', geo, geo2, 首击: { 侧: s1, 光标: r1 } } };
    frame = await frameOf(session);
    // ② 末行闭 $ 右侧＝末行**内容右缘之外**的空白（右移 10px）。期望：公式后（侧=+1）。
    //    末行内容短时击点落在并集中线左侧——旧版中线判侧把"后"判成"前"，判别力在这一击。
    const 击末 = { x: geo2.末行内容右 + 10, y: geo2.闭.cy };
    await clickIn(session, frame, 击末.x, 击末.y);
    await harness.sleep(420);
    const r2 = await readCaret(session); const s2 = await session.js(IN('window.__r1.vsInline("long")'));
    await shots(session, frame, 'A2-末行右侧', 击末,
      [...caretMark(r2), { x: 击末.x, y: 击末.y, h: 22, dash: true, color: '#25d0ff', label: '点击处' }]);
    const 前 = !!(s1 && s1.侧 === -1);
    const 后 = !!(s2 && s2.侧 === 1);
    const 击点在空白 = 击首.x < geo.首行内容左 && 击末.x > geo2.末行内容右;
    return { verdict: 前 && 后 && 击点在空白 ? 'PASS' : 'FAIL', detail: { 源码行数: geo.行数,
      击点在空白, owner并集中线: geo.ownerMid, 末击判别条件成立: 击末.x < geo2.ownerMid,
      首行内容左: geo.首行内容左, 末行内容右: geo2.末行内容右,
      首击: { 点: [击首.x, 击首.y], 侧: s1, 光标: r1, 属: '空白侧正确性检查（不判别旧新）' },
      末击: { 点: [击末.x, 击末.y], 侧: s2, 光标: r2, ownerMid: geo2.ownerMid, 属: '判别击：击点<中线时旧版判前（红）' },
      红: '末击.x 落在并集中线左侧时，旧判法把光标塞回公式前（末击.侧=-1）' } };
  } catch (error) {
    return { verdict: 'FAIL', detail: { 异常: String(error && error.message || error).slice(0, 200) } };
  }
}

/** A4：x$a$ 展开、光标到开 $ 左半，真实退格一次删掉 'x'。 */
async function caseA4(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点' } };
  // ① 点渲染结果展开源码
  const geo = await session.js(IN(`(() => {
    const owners = [...document.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
    const owner = owners.find(o => String((o.querySelector('code[data-type="math-inline"]') || {}).textContent || '').replace(/\\s/g, '') === 'a');
    if (!owner) return { ok: false, 公式数: owners.length };
    const b = owner.getBoundingClientRect();
    if (!b.height) return { ok: false, 原因: '公式不可见' };
    return { ok: true, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`));
  if (!geo || !geo.ok) return { verdict: 'FAIL', detail: { 阶段: '定位 x$a$', geo } };
  await clickIn(session, frame, geo.x, geo.y);
  await harness.sleep(600);
  // ② 真实点开 $ 左半（记录光标去向，作证据；判据用 ③ 的定点）
  const mk = await session.js(IN(`(() => {
    const owners = [...document.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
    const owner = owners.find(o => String((o.querySelector('code[data-type="math-inline"]') || {}).textContent || '').replace(/\\s/g, '') === 'a');
    if (!owner || !owner.classList.contains('vditor-ir__node--expand')) return { ok: false };
    const m = owner.firstElementChild; if (!m) return { ok: false };
    const b = m.getBoundingClientRect();
    return { ok: b.width > 0, l: Math.round(b.left), w: Math.round(b.width), cy: Math.round(b.top + b.height / 2) }; })()`));
  let 点击证据 = { 展开: !!(mk && mk.ok) };
  if (mk && mk.ok) {
    const cx = mk.l + Math.max(1, Math.round(mk.w * 0.25));
    await clickIn(session, frame, cx, mk.cy);
    await harness.sleep(420);
    点击证据 = { 展开: true, 点击: [cx, mk.cy], 光标: await readCaret(session),
      侧: await session.js(IN('window.__r1.vsInline("a")')) };
  }
  // ③ 定点放上 fenceClick 对"开 $ 左半"给的同一位置（marker 文本 offset 0），真实退格
  const placed = await session.js(IN('window.__r1.placeAtOpenFence("a")'));
  if (!placed || !placed.ok) return { verdict: 'FAIL', detail: { 阶段: '定点放置', placed, 点击证据 } };
  await harness.sleep(80);
  const before = await readCaret(session);
  const mdBefore = await hi.mdNow(session);
  await hi.press(session, 'Backspace');
  await harness.sleep(450);
  const after = await readCaret(session);
  const mdAfter = await hi.mdNow(session);
  await shots(session, frame, 'A4-退格后', after.可见 ? after : { x: geo.x, y: geo.y },
    [...caretMark(after), ...(mk && mk.ok ? [{ x: mk.l + Math.max(1, Math.round(mk.w * 0.25)), y: mk.cy, h: 22, dash: true, color: '#25d0ff', label: '开$左半' }] : [])]);
  const md前 = String(mdBefore), md后 = String(mdAfter);
  const 删掉 = md后.includes('$a$') && !md后.includes('x$a$');
  return { verdict: 删掉 ? 'PASS' : 'FAIL', detail: { 定点: placed, 放置后: before, 退格后: after,
    点击证据, md前含x公式: md前.includes('x$a$'), md后含x公式: md后.includes('x$a$'), md后含公式: md后.includes('$a$'),
    红: '旧版开 $ 边界退格 preventDefault+selectOutside 只挪不删：md 仍含 x$a$，光标跑到公式前' } };
}

/** C1：固定列按 ↓ 后 150ms 内 insertText，光标要停在新文本之后不被拽回。 */
async function caseC1(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点' } };
  const placed = await session.js(hi.placeAfterPrefix('甲长段落'));
  if (!placed || !placed.ok) return { verdict: 'FAIL', detail: { 阶段: '定位', placed } };
  await harness.sleep(100);
  const start = await readCaret(session);
  // ↓ 后**立刻**打字：Input.insertText 是 IME 上屏的真实通道，input 事件马上到（远小于 150ms）
  await session.key({ key: 'ArrowDown', code: 'ArrowDown', vk: 40 });
  await session.type('Z');
  await harness.sleep(700);            // 熬过 200ms 重放窗口 + 260ms 兜底解绑
  const now = await readCaret(session);
  await shots(session, frame, 'C1-打字后', now, [...caretMark(now),
    { x: start.x, y: start.y, h: 22, dash: true, color: '#f0a020', label: '目标列' }]);
  const 不回跳 = String(now.前缀).endsWith('Z');
  return { verdict: 不回跳 ? 'PASS' : 'FAIL', detail: { 起点: start, 目标列: start.x, 打字后: now,
    前缀尾: String(now.前缀).slice(-6),
    红: '旧版 200ms 重放窗口里 selectionchange 按旧目标列把光标拽回：前缀不以 Z 结尾' } };
}

/** C2：公式源码里输 \\fra 弹补全，按 ↑↓ 弹窗高亮要动、正文光标不动。 */
async function caseC2(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点' } };
  const placed = await session.js(hi.placeAfterPrefix('空行起手段'));
  if (!placed || !placed.ok) return { verdict: 'FAIL', detail: { 阶段: '定位', placed } };
  await session.type('$');
  await harness.sleep(350);           // 开行内公式，光标进源码
  await session.type('\\fra');
  await harness.sleep(900);           // 本地补全（local 默认开）弹候选
  const popup = await session.js(IN('window.__r1.popup()'));
  const before = await readCaret(session);
  if (!popup || !popup.有 || popup.hidden) {
    await shots(session, frame, 'C2-未弹窗', before, caretMark(before));
    return { verdict: 'FAIL', detail: { 阶段: '弹窗没弹出来', popup, 光标: before,
      md: String(await hi.mdNow(session)).slice(0, 80) } };
  }
  await shots(session, frame, 'C2-弹窗初始', before, caretMark(before));
  await session.key({ key: 'ArrowDown', code: 'ArrowDown', vk: 40 });
  await harness.sleep(300);
  const popupDown = await session.js(IN('window.__r1.popup()'));
  const caretDown = await readCaret(session);
  await session.key({ key: 'ArrowUp', code: 'ArrowUp', vk: 38 });
  await harness.sleep(300);
  const popupUp = await session.js(IN('window.__r1.popup()'));
  await shots(session, frame, 'C2-按键后', caretDown, caretMark(caretDown));
  await hi.press(session, 'Escape');
  await harness.sleep(250);
  const 高亮动了 = !!(popupDown && popup.选中 !== null && popupDown.选中 !== popup.选中)
    || !!(popupUp && popupDown && popupUp.选中 !== popupDown.选中);
  const 光标没动 = !!(caretDown && before && caretDown.偏移 === before.偏移
    && caretDown.y === before.y && caretDown.容器 === before.容器);
  return { verdict: 高亮动了 && 光标没动 ? 'PASS' : 'FAIL', detail: { 弹窗初: popup, 按下后: popupDown,
    按上后: popupUp, 光标前: before, 光标后: caretDown,
    红: '旧版纵向接管吞键：弹窗高亮不动（选中不变），正文光标自己走（偏移/行变了）' } };
}

/** C4：文档以 $x$ 结尾，End / Ctrl+End 光标停公式后且可见（不再拽进源码）。 */
async function caseC4(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点' } };
  const anchor = await session.js(IN(`(() => { const list = [...document.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
    const b = list[list.length - 1].getBoundingClientRect();
    return { x: Math.round(b.right), y: Math.round(b.top + b.height / 2) }; })()`));
  await hi.combo(session, 'Ctrl+End');
  await harness.sleep(600);
  const ctrlEnd = await readCaret(session);
  const side1 = await session.js(IN('window.__r1.vsInline("last")'));
  const layout1 = await session.js(IN('window.__r1.版面有行盒()'));
  await shots(session, frame, 'C4-CtrlEnd', ctrlEnd.可见 ? ctrlEnd : anchor, caretMark(ctrlEnd));
  await session.key({ key: 'End', code: 'End', vk: 35 });
  await harness.sleep(550);
  const end = await readCaret(session);
  const side2 = await session.js(IN('window.__r1.vsInline("last")'));
  const layout2 = await session.js(IN('window.__r1.版面有行盒()'));
  await shots(session, frame, 'C4-End', end.可见 ? end : anchor, caretMark(end));
  const ok1 = !!(side1 && side1.侧 === 1) && ctrlEnd.层 !== '源码';
  const ok2 = !!(side2 && side2.侧 === 1) && end.层 !== '源码';
  const 可见 = !!(ctrlEnd.可见 || layout1 === true);
  return { verdict: ok1 && ok2 && 可见 ? 'PASS' : 'FAIL', detail: {
    CtrlEnd: { 光标: ctrlEnd, 侧: side1, 版面有行盒: layout1 },
    End: { 光标: end, 侧: side2, 版面有行盒: layout2 },
    红: '旧版裸 caretRect 0×0 判隐形→行端兜底把光标塞进公式源码末尾（层=源码、侧=0）' } };
}

/** C5：折叠 $$ 块上一行按 ↓，中途要落进公式源码（不跳过整块）。
 *  前置必须成立：块处于**收折态**（无 expand 类 + 源码不可见 + 预览可见）。实测打开时可能停在
 *  "无类但源码可见"的中间态（KaTeX/重排未 settle）：先真实点进块源码、再真实点尾段促收折，
 *  再轮询等它稳定；仍挂着类就程序化摘掉（收折态的 DOM 本来就是没有这个类）。全程路径记进读数。 */
async function caseC5(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点' } };
  let st = await session.js(IN('window.__r1.blockState()'));
  if (!st || !st.有) return { verdict: 'FAIL', detail: { 阶段: '没找到块公式', st } };
  const 收折了 = s => s && !s.展开 && !s.源码可见 && s.预览有盒;
  let 收折路径 = '打开即收折';
  if (!收折了(st)) {
    收折路径 = '点进块源码→点尾段→轮询等稳定';
    const srcBox = await session.js(IN(`(() => { const o = document.querySelector('.vditor-ir__node[data-type="math-block"]');
      const code = o.querySelector('pre > code[data-type="math-block"]') || o.querySelector('code[data-type="math-block"]');
      if (!code) return null; const b = code.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + Math.min(Math.max(b.height / 2, 6), 120)) }; })()`));
    if (srcBox && srcBox.x) { await clickIn(session, frame, srcBox.x, srcBox.y); await harness.sleep(450); }
    const 尾box = await session.js(IN(`(() => { const s = document.querySelector('.vditor-ir .vditor-reset');
      const p = [...s.children].find(b => b.textContent.includes('尾段文字'));
      if (!p) return null; const b = p.getBoundingClientRect();
      return { x: Math.round(b.left + 40), y: Math.round(b.top + b.height / 2) }; })()`));
    if (尾box && 尾box.x) { await clickIn(session, frame, 尾box.x, 尾box.y); await harness.sleep(500); }
    for (let i = 0; i < 12 && !收折了(st = await session.js(IN('window.__r1.blockState()'))); i++) {
      if (i === 6 && st.展开) {
        收折路径 += '＋程序化摘 expand 类';
        await session.js(IN('window.__r1.collapseBlockMath()'));
      }
      await harness.sleep(400);
    }
  }
  const placed = await session.js(hi.placeAfterPrefix('收束文字。'));
  if (!placed || !placed.ok) return { verdict: 'FAIL', detail: { 阶段: '定位', placed, 收折路径, 前置状态: st } };
  await harness.sleep(120);
  const start = await readCaret(session);
  await key(session, 'ArrowDown', 40, 650);
  const now = await readCaret(session);
  const blk = await session.js(IN('window.__r1.blockMath()'));
  await shots(session, frame, 'C5-下键后', now.可见 ? now : { x: start.x, y: start.y + 40 }, caretMark(now));
  const 进入源码 = now.层 === '块源码';
  const 收折成立 = 收折了(st);
  // 收折前置没成立时"落源码"证明不了修复（源码本来就画在那里、可命中）——如实记 EVIDENCE。
  const verdict = 收折成立 ? (进入源码 ? 'PASS' : 'FAIL')
    : (进入源码 ? 'EVIDENCE' : 'FAIL');
  return { verdict, detail: { 结论: 收折成立 ? null
      : (进入源码 ? '收折前置未成立（源码常显）且落源码——旧版本就落源码，C5 无法在本副本复现' : null),
    前置: { 状态: st, 收折路径, 收折成立 }, 起点: start, 落点: now, 块状态: blk,
    红: '收折成立时：旧版 codeAtHit 把折叠块源码（0×0）筛掉，↓ 跳过整块落到尾段（层=正文）' } };
}

/** C6：空段落光标（合成线）滚一屏再滚回，合成线仍在。 */
async function caseC6(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点' } };
  const placed = await session.js(hi.placeAfterPrefix('C6锚点段：回车造空段用的段落，后面跟的都是填充。'));
  if (!placed || !placed.ok) return { verdict: 'FAIL', detail: { 阶段: '定位', placed } };
  await session.enter();              // 回车造空段：光标落在唯一靠合成线的位置上
  await harness.sleep(550);
  const first = await session.js(IN('window.__r1.proxy()'));
  if (!first || !first.显示) {
    await shots(session, frame, 'C6-初始无合成线', { x: 300, y: 300 }, []);
    return { verdict: 'FAIL', detail: { 阶段: '空段落回车后合成线没亮', 读数: first } };
  }
  await shots(session, frame, 'C6-初始', first, [{ x: first.x, y: first.y, h: first.h, color: '#ff2d2d', label: '合成线' }]);
  // 【滚动读数修正】不依赖 __r1（避免助手被重渲染清掉时悄悄变 null）：直接 IIFE 读**三层**滚动——
  // 面偏移＝内容根相对 iframe 视口的位移（无论哪一层容器在滚，它都会变）；resetTop＝
  // .vditor-reset 自己的 scrollTop；顶层＝外壳页面的 scrollY。哪层动了都算"滚了"。
  const 滚读 = `(() => { const s = document.querySelector('.vditor-ir .vditor-reset');
    const b = s && s.getBoundingClientRect();
    return { 面偏移: b ? -Math.round(b.top) : null, resetTop: s ? Math.round(s.scrollTop) : null,
      可滚: !!s && s.scrollHeight > s.clientHeight + 2 }; })()`;
  const 顶滚 = () => session.js('(() => Math.round(window.scrollY || 0))()');
  const 前 = await session.js(IN(滚读)); const 顶前 = await 顶滚();
  // 【滚轮修正】单发大 delta 会被平滑滚动/命中目标吞掉（绿轮实测滚动量 0）：改成真人形状的
  // 多棘轮（一档 350px × 3 档、间隔 140ms），且打在**正文段落**上（不是可能落在空白/空段上的
  // 面中心）；坐标夹进 iframe 视口内，滚出视口的点 CDP 会直接丢。
  const 文本点 = await session.js(IN(`(() => { const s = document.querySelector('.vditor-ir .vditor-reset');
    const p = [...s.children].find(b => b.textContent.includes('填充'));
    const b = p ? p.getBoundingClientRect() : s.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2),
      y: Math.max(20, Math.min(window.innerHeight - 20, Math.round(b.top + Math.min(b.height / 2, 200)))) }; })()`));
  const 滚轮 = async deltaY => { for (let i = 0; i < 3; i++) {
    await session.wheel(frame.x + 文本点.x, frame.y + 文本点.y, deltaY);
    await harness.sleep(140); } };
  await 滚轮(350);
  await harness.sleep(450);
  const 中 = await session.js(IN(滚读)); const 顶中 = await 顶滚();
  await 滚轮(-350);
  await harness.sleep(700);
  const 后 = await session.js(IN(滚读)); const 顶后 = await 顶滚();
  const after = await session.js(IN('window.__r1.proxy()'));
  await shots(session, frame, 'C6-滚回后', after.显示 ? after : { x: first.x, y: first.y },
    after.显示 ? [{ x: after.x, y: after.y, h: after.h, color: '#ff2d2d', label: '合成线' }] : []);
  const 位移 = t => Math.max(Math.abs((t.面偏移 ?? 0) - (前.面偏移 ?? 0)), Math.abs((t.resetTop ?? 0) - (前.resetTop ?? 0)));
  const 滚动量 = Math.max(位移(中), Math.abs(顶中 - 顶前));
  const 回差 = Math.max(位移(后), Math.abs(顶后 - 顶前));
  const 滚读全 = { 前, 中, 后, 顶层: { 前: 顶前, 中: 顶中, 后: 顶后 } };
  if (!(滚动量 > 50)) {
    // 滚轮发了但一层都没滚：这不是被测行为的红，判据无从谈起——按取证报，滚动容器/坐标待查
    return { verdict: 'EVIDENCE', detail: { 结论: '未滚成：滚轮已发出但滚动量 0', 滚读: 滚读全,
      文本点, 可滚: 前.可滚, 初始: first, 滚回后: after } };
  }
  const 回到位 = 回差 < 50;
  return { verdict: 回到位 && after.显示 ? 'PASS' : 'FAIL', detail: { 滚读: 滚读全, 文本点,
    滚动量: Math.round(滚动量), 回差: Math.round(回差), 初始: first, 滚回后: after,
    红: '旧版滚动只收线不重算：滚一屏再滚回，合成线永久消失（显示=false）' } };
}

/** C7：某列连按 ↓ 后点大纲跳标题再按 ↓，目标列取当前列（不用旧列）。 */
async function caseC7(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点' } };
  // 注意：iframe 里 window.vditor 是 **API 对象**，编辑器在 window.vditor.vditor（toolbar.js:49）。
  // 大纲可见性有两层：工具栏 outline 按钮的 click 只写 localStorage（toolbar.js:75-78，重开才生效），
  // 当场打开要走产品自己的 outline.toggle（toolbar.js:45 restoreCachedVisual 同路）。先真实点按钮，
  // 不行再调产品自身的 toggle——路径如实记进读数。
  const 显示Expr = `(() => { const ed = window.vditor && window.vditor.vditor;
    const o = ed && ed.outline && ed.outline.element;
    return o ? { 显示: o.style.display === 'block' } : { 无: true }; })()`;
  let outline = await session.js(IN(显示Expr));
  let 打开方式 = '已是显示';
  if (!outline || !outline.显示) {
    const btn = await session.js(IN(`(() => { const ed = window.vditor && window.vditor.vditor;
      const t = ed && ed.toolbar && ed.toolbar.elements && ed.toolbar.elements.outline;
      const b = t && t.querySelector('button'); if (!b) return null;
      const r = b.getBoundingClientRect(); if (!r.width) return { 隐: true };
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`));
    if (btn && btn.x) { await clickIn(session, frame, btn.x, btn.y); await harness.sleep(500); }
    outline = await session.js(IN(显示Expr));
    打开方式 = btn && btn.x ? '工具栏按钮真实点击' : (btn && btn.隐 ? '工具栏按钮不可见' : '没找到工具栏按钮');
    if (!outline.显示) {
      const t = await session.js(IN(`(() => { const ed = window.vditor && window.vditor.vditor;
        if (!ed || !ed.outline || !ed.outline.toggle) return { ok: false };
        ed.outline.toggle(ed, true); return { ok: true }; })()`));
      await harness.sleep(500);
      outline = await session.js(IN(显示Expr));
      打开方式 += t && t.ok ? '＋outline.toggle（产品自身 API：按钮只写 localStorage，当场显示走这条）'
        : '＋outline.toggle 不可用';
    }
  }
  if (!outline || !outline.显示) return { verdict: 'FAIL', detail: { 阶段: '大纲面板打不开', outline, 打开方式 } };
  // 在乙长段落里点一列，连按 ↓ 三个建立旧目标列
  const para = await session.js(IN(`(() => { const s = document.querySelector('.vditor-ir .vditor-reset');
    const p = [...s.children].find(b => b.textContent.includes('乙长段落'));
    if (!p) return null; const b = p.getBoundingClientRect();
    return { x: Math.round(b.left + Math.min(600, b.width - 60)), y: Math.round(b.top + 18) }; })()`));
  if (!para) return { verdict: 'FAIL', detail: { 阶段: '找乙长段落' } };
  await clickIn(session, frame, para.x, para.y);
  await harness.sleep(350);
  const start = await readCaret(session);
  for (let i = 0; i < 3; i++) await key(session, 'ArrowDown', 40, 240);
  const walked = await readCaret(session);
  // 点大纲跳「判决乙」
  const item = await session.js(IN(`(() => { const ed = window.vditor && window.vditor.vditor;
    const o = ed && ed.outline && ed.outline.element; if (!o) return null;
    const els = [...o.querySelectorAll('*')].filter(e => !e.children.length);
    const hit = els.find(e => e.textContent.trim() === '判决乙');
    if (!hit) return null; const r = hit.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`));
  if (!item) return { verdict: 'FAIL', detail: { 阶段: '找大纲项「判决乙」', 打开方式,
    大纲文本: String(await session.js(IN(`(() => { const ed = window.vditor && window.vditor.vditor;
      return String(ed && ed.outline && ed.outline.element.textContent || '').slice(0, 60); })()`))) } };
  await clickIn(session, frame, item.x, item.y);
  await harness.sleep(650);
  let at = await readCaret(session);
  let 手动 = false;
  const inHeading = await session.js(IN(`(() => { const s = getSelection(); if (!s.rangeCount) return false;
    const n = s.focusNode; const at = n.nodeType === 3 ? n.parentElement : n;
    const h = at.closest && at.closest('h2'); return !!(h && h.textContent.includes('判决乙')); })()`));
  if (!inHeading) { 手动 = true; await session.js(hi.placeAfterPrefix('判决乙')); await harness.sleep(150); at = await readCaret(session); }
  await shots(session, frame, 'C7-跳转后', at, [...caretMark(at),
    { x: start.x, y: at.y, h: 22, dash: true, color: '#f0a020', label: '旧目标列' }]);
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '跳转后焦点' } };
  await key(session, 'ArrowDown', 40, 380);
  const next = await readCaret(session);
  await shots(session, frame, 'C7-跳转后下键', next, [...caretMark(next),
    { x: start.x, y: next.y, h: 22, dash: true, color: '#f0a020', label: '旧目标列' }]);
  const dCur = Math.abs(next.x - at.x), dOld = Math.abs(next.x - start.x);
  const ok = dCur <= Math.max(24, next.h || 18) && dCur < dOld;
  return { verdict: ok ? 'PASS' : 'FAIL', detail: { 打开方式, 起点列: start.x, 连按后列: walked.x,
    跳转后列: at.x, 手动落位: 手动, 下键后列: next.x, 距当前列: dCur, 距旧列: dOld,
    红: '旧版 goalX 残留：跳转后 ↓ 落到旧目标列（距旧列 << 距当前列）' } };
}

/** EVIDENCE-B6：折叠块公式上一行行尾按 → 的落点与打字去向（只取证）。 */
async function caseB6(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'EVIDENCE', detail: { 阶段: '焦点不在编辑器' } };
  await session.js(hi.placeAfterPrefix('收束文字。'));
  await harness.sleep(150);
  const start = await readCaret(session);
  await key(session, 'ArrowRight', 39, 480);
  const now = await readCaret(session);
  const vs = await session.js(IN('window.__r1.vsBlock()'));
  const layout = await session.js(IN('window.__r1.版面有行盒()'));
  await shots(session, frame, 'B6-右移后', now.可见 ? now : start, caretMark(now));
  await session.type('Q');
  await harness.sleep(500);
  const typed = await readCaret(session);
  const md = String(await hi.mdNow(session));
  const qi = md.indexOf('Q');
  await hi.combo(session, 'Ctrl+Z');
  await harness.sleep(500);
  return { verdict: 'EVIDENCE', detail: { 行尾: start, 右移后: { 光标: now, 对块: vs, 版面有行盒: layout },
    打字后: { 光标: typed, Q上下文: qi >= 0 ? md.slice(Math.max(0, qi - 24), qi + 24) : null } } };
}

/** EVIDENCE-C3：切分栏后在源码面板点一下按 ↓ 多次，记录光标 offset 变化（只取证）。
 *  【C3·R2 探针补丁】切 sv 前先在 IR 相位真实 ↓×3 建立 lastBox/goalX（参照
 *  .perf/r1-mutation/c3-repro.cjs 的判决书原始序列）：没有这一步时 lastBox 为空，
 *  纵向补丁的 `currentMode!=='ir'` 守卫突变在本用例无从显形（守卫在/不在都早退）。
 *  前置之后加自判：切换 ok 且焦点 ok 而 ↓×5 光标 y 全程冻结 → FAIL（吞键显形）。 */
async function caseC3(session) {
  const frame = await frameOf(session);
  // ── 前置：IR 相位建立 lastBox/goalX（光标放「收束文字」后，真实 ↓×3）──
  await hi.ensureFocus(session);
  await session.js(hi.placeAfterPrefix('收束文字'));
  await harness.sleep(200);
  const irSteps = [];
  for (let i = 0; i < 3; i++) { await key(session, 'ArrowDown', 40, 260); irSteps.push(await readCaret(session)); }
  // 注意：iframe 里 window.vditor 是 API 对象，编辑器在 window.vditor.vditor；edit-mode 是
  // Vditor 内置 ctrl：工具栏上是主按钮，三个模式按钮（data-mode=ir/wysiwyg/sv）在弹出面板里。
  const main = await session.js(IN(`(() => { const ed = window.vditor && window.vditor.vditor;
    const item = ed && ed.toolbar && ed.toolbar.elements && ed.toolbar.elements['edit-mode'];
    if (!item) return null;
    const b = item.querySelector(':scope > button'); if (!b) return null;
    const r = b.getBoundingClientRect(); if (!r.width) return { 隐: true };
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`));
  if (!main) return { verdict: 'EVIDENCE', detail: { 切换: '没找到 edit-mode 工具栏按钮（window.vditor.vditor.toolbar.elements）' } };
  if (main.隐) return { verdict: 'EVIDENCE', detail: { 切换: 'edit-mode 主按钮当前不可见（工具栏被收纳？）' } };
  await clickIn(session, frame, main.x, main.y);      // 真实点击打开模式面板
  await harness.sleep(450);
  let svBtn = await session.js(IN(`(() => { const ed = window.vditor && window.vditor.vditor;
    const item = ed && ed.toolbar && ed.toolbar.elements && ed.toolbar.elements['edit-mode'];
    const b = item && item.querySelector('button[data-mode="sv"]'); if (!b) return null;
    const r = b.getBoundingClientRect();
    return r.width ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : { 隐: true }; })()`));
  let 切换方式 = '面板内真实点击';
  if (!svBtn || svBtn.隐) {
    // 面板没弹开：产品自己的 toggleSourceView 就是直接 modeButton(editor,'sv')?.click()（toolbar.js:60），
    // 沿产品同一条路程序化点它
    const clicked = await session.js(IN(`(() => { const ed = window.vditor && window.vditor.vditor;
      const item = ed && ed.toolbar && ed.toolbar.elements && ed.toolbar.elements['edit-mode'];
      const b = item && item.querySelector('button[data-mode="sv"]');
      if (!b) return false; b.click(); return true; })()`));
    切换方式 = clicked ? '程序化 .click()（产品 toggleSourceView 同路，面板未弹开）' : '没找到 data-mode=sv 按钮';
    if (!clicked) return { verdict: 'EVIDENCE', detail: { 切换: 切换方式 } };
  } else {
    await clickIn(session, frame, svBtn.x, svBtn.y);
  }
  await harness.sleep(1000);
  const sv = await session.js(IN(`(() => { const el = document.querySelector('.vditor-sv');
    if (!el) return { 有: false }; const r = el.getBoundingClientRect();
    return { 有: true, x: Math.round(r.left + r.width / 4), y: Math.round(r.top + Math.min(r.height / 2, 200)) }; })()`));
  if (!sv || !sv.有) return { verdict: 'EVIDENCE', detail: { 切换: '切换动作已发，.vditor-sv 没出现', 切换方式, sv } };
  await clickIn(session, frame, sv.x, sv.y);
  await harness.sleep(450);
  // sv 模式下没有 .vditor-ir，不能用 IR 专用的焦点探针：只查 iframe 文档本身有没有焦点
  const focused = await session.js(`(() => { const w = document.getElementById('editor').contentWindow;
    return !!(w && w.document && w.document.hasFocus()); })()`);
  if (!focused) return { verdict: 'EVIDENCE', detail: { 切换: 'ok', 切换方式, 阶段: '源码面板点了但 iframe 没拿到焦点' } };
  const steps = [];
  for (let i = 0; i < 5; i++) { await key(session, 'ArrowDown', 40, 300); steps.push(await readCaret(session)); }
  await shots(session, frame, 'C3-源码面板下键', steps[steps.length - 1], caretMark(steps[steps.length - 1]));
  // ── 自判：焦点真在面板、五次 ↓ 全程同一 y → 光标冻结（吞键）＝守卫突变显形 ──
  const ys = steps.map(s => s && s.y);
  const movedY = new Set(ys).size > 1;
  const detail = { 切换: 'ok', 切换方式, 源码面板点: { x: sv.x, y: sv.y },
    IR相位下键: irSteps.map(s => ({ 层: s.层, 偏移: s.偏移, x: s.x, y: s.y, 可见: s.可见 })),
    下键序列: steps.map(s => ({ 层: s.层, 偏移: s.偏移, x: s.x, y: s.y, 可见: s.可见 })) };
  if (!movedY) return { verdict: 'FAIL', detail: { ...detail,
    红: 'sv 相位 ↓×5 光标 y 全程冻结（吞键）：IR 相位 lastBox 已建立，守卫突变将显形', y序列: ys } };
  return { verdict: 'EVIDENCE', detail };
}

// ─── 装配 ───────────────────────────────────────────────────────────────────────

const GROUPS = [
  { doc: 'r1-doc1-折行判侧.md', content: DOC1, cases: [['A2', caseA2], ['C4', caseC4]] },
  { doc: 'r1-doc2-判决甲.md', content: DOC2, cases: [['A4', caseA4], ['C1', caseC1], ['C6', caseC6], ['C7', caseC7]] },
  { doc: 'r1-doc3-补全弹窗.md', content: DOC3, cases: [['C2', caseC2]] },
  { doc: 'r1-doc4-块公式逐行.md', content: DOC4, cases: [['C5', caseC5], ['B6', caseB6], ['C3', caseC3]] },
];

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  const want = name => !only.length || only.includes(name.toLowerCase()) || only.includes(name);
  const log = [];
  const report = (name, verdict, detail) => {
    const line = 'R1CARET ' + name + ' ' + verdict + ' ' + JSON.stringify(detail);
    console.log(line);
    log.push(line);
  };
  const ctx = {
    launch: options => harness.launch({ exe: EXE, appArgs: [APP_MAIN], label: 'probe-r1-caret',
      outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  let failed = 0, passed = 0, evidenced = 0;
  for (const group of GROUPS) {
    const todo = group.cases.filter(([name]) => want(name));
    if (!todo.length) continue;
    const file = path.join(OUT, group.doc);
    fs.writeFileSync(file, group.content, 'utf8');
    console.log('\n=== ' + group.doc + '：' + todo.map(([n]) => n).join(', ') + ' ===');
    let session = null;
    try {
      session = await hi.openDoc(ctx, file, { minBlocks: 3, settleMs: 1500, timeout: 180000 });
      const installed = await session.js(INSTALL);
      if (!installed || !installed.ok) throw new Error('页内工具装载失败：' + JSON.stringify(installed));
      for (const [name, run] of todo) {
        try {
          const outcome = await run(session) || {};
          report(name, outcome.verdict || 'FAIL', outcome.detail || {});
          if (outcome.verdict === 'PASS') passed += 1;
          else if (outcome.verdict === 'EVIDENCE') evidenced += 1;
          else failed += 1;
        } catch (error) {
          report(name, 'FAIL', { 异常: String(error && error.message || error).slice(0, 300) });
          failed += 1;
        }
      }
    } catch (error) {
      console.log('  ！' + group.doc + ' 组未跑完：' + String(error && error.message || error).slice(0, 300));
      for (const [name] of todo) { report(name, 'FAIL', { 组异常: String(error && error.message || error).slice(0, 200) }); failed += 1; }
    } finally {
      if (session) await ctx.release(session);      // 每组结束释放会话（等内部端口让出来再开下一组）
    }
  }
  fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
  console.log('\n=== 汇总：PASS ' + passed + ' / FAIL ' + failed + ' / EVIDENCE ' + evidenced + ' ===');
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '；截图：' + OUT + '）');
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error('probe-r1-caret 失败：', error); process.exit(1); });
