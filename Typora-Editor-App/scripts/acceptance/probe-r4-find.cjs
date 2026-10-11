/** 探针 · 第 4 轮查找替换域八缺陷修复验收（2026-10-02，probe-r4-find）。
 *
 *  对应修复（extension-src/render/js/find-replace.js + source-text.js + media-tools.js）：
 *   FR1 单处替换命中公式块 → replaceInPlace 放弃增量通道，回退全量管线（预览与
 *       getValue 永远一致），且可一步撤销。
 *   FR2 面板发起的新搜索完成后定位当前命中（滚动 + 展开折叠公式）。
 *   FR3 编辑面 F3 导航：reveal 把文档选区放到命中上，展开成为合法状态并保持（Typora 手感）。
 *   【R7 修订】面板发起的搜索/导航 reveal 不再落选区——旧"选区落命中"会把 Chromium
 *       焦点一起拽进编辑面，面板 Enter 随即删词换行并存盘（数据损坏级，病例 125④⑤）。
 *       口径分支：焦点在面板=不落选区（当前命中由 CSS Highlight 指示）；焦点在编辑面
 *       =保留落选区（FR3 判据不变）。fr2 判据按此修订，fr6 走等价回归路径。
 *   FR4 sourceText 块间分隔符补 DIV/PRE → 跨块接缝（段尾 c + 块公式围栏 $）不再假命中。
 *   FR5 Ctrl+F 播种改用复制同口径 selectionPlainText → 选中公式预填 $源码$，
 *       不再把 KaTeX 渲染 DOM 的 textContent 塞进查找框。
 *   FR6 单处替换后焦点留在替换框（Enter 连续替换），全部替换才回查找框。
 *   FR7 查找框 IME 组字中间态不触发即时搜索（isComposing 跳过 schedule）。
 *   FC4 Ctrl+F 打开查找时显式 dismiss 补全浮层（注册序使 stopImmediatePropagation
 *       挡掉补全自己的收起逻辑，z1000 浮层原样盖在 z100 查找框上）。
 *
 *  每用例一行：R4FD <名> PASS/FAIL/EVIDENCE {关键读数 JSON}，附整页 + 关键处 2x 截图
 *  （.perf/probe-r4-find/）。截图标记口径沿用 r1/r3 探针：红实线＝光标/选区落点、
 *  琥珀虚线＝期望位、青虚线＝击点。CDP 抓帧拍不到原生光标，按浏览器自报矩形画标记。
 *
 *  通道纪律：
 *   · 全程不碰系统剪贴板（被锁）：FR5 的播种断言直接读查找框 input.value。
 *   · 真实输入走 CDP Input（点击 / insertText / rawKeyDown 组合键 / F3 / Enter /
 *     Input.imeSetComposition + insertCommitText 组字）；焦点先于按键断言
 *     （帧 document.hasFocus() 且活动元素在编辑面/面板内）。
 *   · 每用例独立实例（自己的窗口/会话），结束即释放；素材全部现场生成。
 *   · FR4 的跨块查询词由页内 sourceText 新旧两套复本（与产品逐字同源）动态求差得到，
 *     不猜 DOM 标签；正向对照（真实词 1 命中）防"搜索整个坏了"的假绿。
 *
 *  用法：node scripts/acceptance/probe-r4-find.cjs [--only=fr1,fr2,fr3,fr4,fr5,fr6,fr7,fc4] [--installed]
 *        （--only 大小写不敏感；dev 模式拉开发树（先 npm run sync），--installed 拉安装版。
 *          铁律 3：单 GUI 串行，不与其它探针并行。）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const DEV = !process.argv.includes('--installed');
const OUT = path.join(harness.project, '.perf/probe-r4-find');
const EXE = DEV ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
  : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
const APP_MAIN = path.join(harness.project, 'app/main/main.js');
const IF = hi.IF;
const S = hi.SURFACE;

// ─── 文档（全部现场生成；公式词只在指定层出现） ──────────────────────────────
const DOC_FR1 = ['# R4FD FR1 公式内单处替换', '',
  '行内公式 $alpha+1$ 就在这句里。', '',
  '正文里再来一个 alpha 词。', ''].join('\n');
const DOC_FR2 = (() => {
  const parts = ['# R4FD FR2 搜索定位当前命中', ''];
  for (let i = 1; i <= 60; i++) parts.push('填充段' + String(i).padStart(2, '0') + '：常态正文，把深处公式推出首屏。', '');
  parts.push('深处公式 $zetaUnique$ 收尾。', '');
  return parts.join('\n');
})();
const DOC_FR3 = ['# R4FD FR3 F3 展开保持', '',
  '普通段 target 一处。', '',
  '后面这句有行内公式 $target+2$ 收尾。', ''].join('\n');
const DOC_FR4 = ['# R4FD FR4 跨块假命中', '',
  '段落尾巴c', '',
  '$$', 'x+q', '$$', '',
  '代码前的段落k', '',
  '```js', 'var a=1', '```', '',
  '又一普通段 zzz 收尾。', ''].join('\n');
const DOC_FR5 = ['# R4FD FR5 播种口径', '',
  '前置词 $alpha+1$ 后置词。', ''].join('\n');
const DOC_FR6 = ['# R4FD FR6 连续替换', '',
  'alpha 甲。再 alpha 乙。又 alpha 丙。', '',
  '不同词 delta 一枚，delta 两枚。', ''].join('\n');
const DOC_FR7 = ['# R4FD FR7 组合输入', '',
  '目标词第一处。目标词第二处。', ''].join('\n');
const DOC_FC4 = (() => {
  const parts = ['# R4FD FC4 补全浮层关闭', '', '公式 $a+1$ 附近正文。', ''];
  for (let i = 1; i <= 6; i++) parts.push('填充段' + i + '：给补全面板留出落位空间。', '');
  return parts.join('\n');
})();

// ─── 页内工具（装进编辑器 iframe；sourceText 复本与产品 source-text.js 逐字同源） ──
//  注意：本模板串内不出现 "${" 与反引号；想让页内收到转义序列的地方反斜杠双写。
const HELPERS = `window.__r4fd = (() => {
  const surface = () => document.querySelector('.vditor-ir .vditor-reset');
  const findApi = () => window.vditor && window.vditor.__typoraFind ? window.vditor.__typoraFind : null;
  const state = () => { const api = findApi(), d = document;
    const p = d.getElementById('typora-find');
    const q = p && p.querySelector('[data-field="query"]'), r = p && p.querySelector('[data-field="replace"]');
    const a = d.activeElement;
    return { panel: !!p, pending: api ? api.state.pending : null, count: api ? api.state.count : null,
      active: api ? api.state.active : null,
      output: p ? String((p.querySelector('output') || {}).textContent || '') : null,
      statusText: p ? String((p.querySelector('[role="status"]') || {}).textContent || '') : null,
      query: q ? q.value : null, replace: r ? r.value : null, replaceRowHidden: r ? !!r.closest('.find-replace-row').hidden : null,
      activeIsQuery: !!(q && a === q), activeIsReplace: !!(r && a === r), activeInPanel: !!(p && p.contains(a)),
      activeDesc: a ? (a.tagName + (a.dataset && a.dataset.field ? '[' + a.dataset.field + ']' : '')) : null }; };
  const mdValue = () => { try { return window.vditor ? window.vditor.getValue() : null; } catch (e) { return 'ERR:' + e.message; } };
  const scrollerOf = el => { let p = el;
    while (p && p !== document.body) { const s = getComputedStyle(p);
      if (/(auto|scroll)/.test(String(s.overflowY) + String(s.overflow)) && p.scrollHeight > p.clientHeight) return p;
      p = p.parentElement; }
    return document.documentElement; };
  const mathOwners = () => { const root = surface(); if (!root) return null; const out = [];
    for (const n of root.querySelectorAll('.vditor-ir__node')) {
      const code = n.querySelector('code[data-type^="math"]'); if (!code) continue;
      const lm = n.querySelector('.language-math'), ann = n.querySelector('.katex-mathml annotation');
      const box = n.getBoundingClientRect(), cb = code.getBoundingClientRect();
      const sc = scrollerOf(n), sr = sc.getBoundingClientRect();
      out.push({ tag: n.tagName, expand: n.classList.contains('vditor-ir__node--expand'),
        codeText: String(code.textContent || ''), dataMath: lm ? lm.getAttribute('data-math') : null,
        annotation: ann ? String(ann.textContent || '') : null,
        codeH: Math.round(cb.height), ownerH: Math.round(box.height),
        visible: box.height > 0 && box.bottom > sr.top + 2 && box.top < sr.bottom - 2,
        scrollOf: Math.round(sc.scrollTop),
        point: { x: Math.round(box.left + Math.min(box.width / 2, 200)), y: Math.round(box.top + box.height / 2) } }); }
    return out; };
  const selInfo = () => { const s = getSelection(); if (!s || !s.rangeCount) return { ok: false };
    const r = s.getRangeAt(0);
    const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
    const code = at && at.closest ? at.closest('code[data-type^="math"]') : null;
    return { ok: true, text: s.toString(), len: s.toString().length, collapsed: s.isCollapsed,
      inMathCode: !!code, hasFocus: document.hasFocus() }; };
  // sourceText 复本：separators 传不同清单即可得到"旧模型 / 新模型"两份可搜索文本。
  // visit 顺序、跳过清单与产品 source-text.js 逐字同源（漂移由正向对照兜底）。
  const srcModel = separators => { const root = surface(); let text = '';
    const visit = node => {
      if (node.nodeType === 3) { text += node.data; return; }
      if (node.nodeType !== 1 || node.matches('.vditor-ir__preview,.vditor-wysiwyg__preview,script,style,wbr,[data-type="toc-block"]')) return;
      for (const child of node.childNodes) visit(child);
      if (node !== root && separators.test(node.tagName)) text += '\\n'; };
    visit(root); return text; };
  const OLDSEP = /^(P|H[1-6]|LI|TR|BLOCKQUOTE)$/;
  const NEWSEP = /^(P|H[1-6]|LI|TR|BLOCKQUOTE|DIV|PRE)$/;
  const boundaryProbe = () => { const a = srcModel(OLDSEP), b = srcModel(NEWSEP), out = [];
    let ai = 0;
    for (let bi = 0; bi < b.length; bi++) {
      if (a[ai] === b[bi]) { ai++; continue; }
      // b[bi] 是新模型补上的 \\n：旧模型在这里两块无缝相接
      const q = a.slice(ai - 1, ai + 1);
      if (q.length === 2 && a.includes(q) && !b.includes(q))
        out.push({ q, contextOld: a.slice(Math.max(0, ai - 10), ai + 10), contextNew: b.slice(Math.max(0, ai - 10), ai + 11) });
      // 不动 ai：a[ai] 对应 b[bi+1]
    }
    const root = surface();
    return { oldText: a, newText: b, candidates: out,
      topTags: root ? [...root.children].map(c => c.tagName) : null }; };
  // FR5：选区恰好覆盖行内公式 owner（前文本节点末 → 后文本节点 0）——coveredMathOwners
  // 判定"整个公式被选中"，走 mathSourceText 换源码文本的口径。
  const selectFormulaOwner = () => { const root = surface(); if (!root) return { ok: false, why: '没有编辑面' };
    for (const n of root.querySelectorAll('.vditor-ir__node')) {
      const code = n.querySelector('code[data-type="math-inline"]'); if (!code) continue;
      const before = n.previousSibling, after = n.nextSibling;
      if (!before || !after) continue;
      const r = document.createRange();
      r.setStart(before, before.nodeType === 3 ? before.length : before.childNodes.length);
      r.setEnd(after, 0);
      root.focus();
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return { ok: true, raw: s.toString(), codeText: String(code.textContent || '') }; }
    return { ok: false, why: '没找到带前后兄弟的行内公式' }; };
  const boxes = () => { const p = document.getElementById('typora-find'); if (!p) return null;
    const rect = el => { if (!el) return null; const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
    return { panel: rect(p), query: rect(p.querySelector('[data-field="query"]')),
      replace: rect(p.querySelector('[data-field="replace"]')),
      all: rect(p.querySelector('[data-action="all"]')),
      replaceBtn: rect(p.querySelector('[data-action="replace"]')) }; };
  const popup = () => { const p = document.querySelector('.md-completion:not([hidden])');
    if (!p) return { visible: false };
    const r = p.getBoundingClientRect();
    return { visible: true, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      items: p.querySelectorAll('button').length }; };
  const inlineMathPoint = () => { const root = surface(); if (!root) return null;
    for (const n of root.querySelectorAll('.vditor-ir__node')) {
      const code = n.querySelector('code[data-type="math-inline"]'); if (!code) continue;
      const r = n.getBoundingClientRect(); if (r.width) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }
    return null; };
  const 词点 = word => { const root = surface(); if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node;
    while (node = walker.nextNode()) {
      if (node.parentElement && node.parentElement.closest('.vditor-ir__preview')) continue;
      const at = node.data.indexOf(word);
      if (at < 0) continue;
      const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + word.length);
      const box = range.getBoundingClientRect();
      if (box.width) return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; }
    return null; };
  const resetScroll = () => { const root = surface(); if (!root) return { ok: false };
    const sc = scrollerOf(root); sc.scrollTop = 0;
    return { ok: true, scroller: sc.className ? String(sc.className).slice(0, 40) : sc.tagName }; };
  const mark = list => { const old = document.getElementById('__r4fd_marks'); if (old) old.remove();
    if (!list || !list.length) return 0;
    const layer = document.createElement('div'); layer.id = '__r4fd_marks';
    layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    let drawn = 0;
    for (const item of list) { if (!item) continue;
      const line = document.createElement('div');
      line.style.cssText = 'position:fixed;pointer-events:none;'
        + 'left:' + Math.round(item.x) + 'px;top:' + Math.round(item.y) + 'px;'
        + 'width:' + (item.dash ? 0 : 2) + 'px;height:' + Math.max(2, item.h || 18) + 'px;'
        + 'border-left:' + (item.dash ? '1.5px dashed ' + item.color : '2px solid ' + item.color) + ';'
        + 'background:' + (item.dash ? 'none' : item.color) + ';';
      layer.appendChild(line); drawn += 1;
      if (item.label) { const tag = document.createElement('div'); tag.textContent = item.label;
        tag.style.cssText = 'position:fixed;pointer-events:none;font:11px/1.2 monospace;white-space:nowrap;'
          + 'left:' + (Math.round(item.x) + 3) + 'px;top:' + (Math.round(item.y) - 15) + 'px;color:' + item.color + ';';
        layer.appendChild(tag); } }
    document.body.appendChild(layer); return drawn; };
  const unmark = () => { const old = document.getElementById('__r4fd_marks'); if (old) old.remove(); return 1; };
  return { state, mdValue, mathOwners, selInfo, boundaryProbe, selectFormulaOwner, boxes, popup, inlineMathPoint, 词点, resetScroll, mark, unmark };
})();`;

// 注入与求值（字符串拼接而非反引号插值：HELPERS/expression 不进模板审计域也能完整构造）。
const INSTALL = "(() => { const w = " + IF + ";"
  + " if (!w || !w.document.querySelector(" + JSON.stringify(S) + ")) return { ok: false };"
  + " if (!w.__r4fd) w.eval(" + JSON.stringify(HELPERS) + ");"
  + " return { ok: !!w.__r4fd }; })()";
const IN = expression => "(() => { const w = " + IF + "; return w.eval(" + JSON.stringify(expression) + "); })()";
const ev = (session, expression) => session.js(IN(expression));
const frameOf = session => session.js(`(() => { const f = document.getElementById('editor');
  const r = f.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()`);
const focusOK = async session => (await hi.ensureFocus(session)).ok;

// ─── 通用小件 ───────────────────────────────────────────────────────────────────
async function poll(fn, { timeout = 6000, interval = 150 } = {}) {
  const stop = Date.now() + timeout;
  let last = null;
  while (Date.now() < stop) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error; }
    await harness.sleep(interval);
  }
  return null;
}
const settled = async (session, timeout = 8000) => poll(async () => {
  const st = await ev(session, 'window.__r4fd.state()');
  return st && st.panel && st.pending === false ? st : null;
}, { timeout, interval: 120 });
const clickIn = (session, frame, box) => session.click(frame.x + box.x + Math.max(6, box.w / 2), frame.y + box.y + box.h / 2);
/** 整页 + 关键处 2x 放大截图（center 为 iframe 内坐标，clip 加 iframe 偏移）。 */
async function shots(session, frame, name, center, marks) {
  try {
    const cx = (center && center.x) || 300, cy = (center && center.y) || 300;
    const clip = { x: frame.x + Math.max(0, cx - 260), y: frame.y + Math.max(0, cy - 70), width: 560, height: 190, scale: 2 };
    if (marks && marks.length) await ev(session, 'window.__r4fd.mark(' + JSON.stringify(marks) + ')');
    const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(OUT, name + '-2x.png'), Buffer.from(shot.data, 'base64'));
    await ev(session, 'window.__r4fd.unmark()');
    await session.shot(name + '-full');
  } catch (error) { console.log('  （截图失败 ' + name + '：' + String(error && error.message || error).slice(0, 120) + '）'); }
}
const openFind = async (session, replacing) => {
  await hi.combo(session, replacing ? 'Ctrl+H' : 'Ctrl+F');
  await harness.sleep(320);
  return ev(session, 'window.__r4fd.state()');
};

// ─── 用例 ───────────────────────────────────────────────────────────────────────

/** FR1：单处替换落在行内公式源码内 → 必须走全量管线：预览（data-math / KaTeX
 *  annotation）与 getValue 一致，且一步可撤销。 */
async function caseFR1(session, env) {
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点不在编辑器' } };
  const frame = await frameOf(session);
  const st0 = await openFind(session, true);
  if (!st0 || !st0.panel || st0.replaceRowHidden) return { verdict: 'FAIL', detail: { 阶段: 'Ctrl+H 没打开替换面板', st0 } };
  await session.type('alpha');                                              // 查找框：open 已聚焦
  const stQ = await settled(session);
  if (!stQ || stQ.output !== '1 / 2') return { verdict: 'FAIL', detail: { 阶段: '查找 alpha 没到 1/2', stQ } };
  const bx = await ev(session, 'window.__r4fd.boxes()');
  await clickIn(session, frame, bx.replace); await harness.sleep(180);
  await session.type('beta');
  const before = await ev(session, 'window.__r4fd.mdValue()');
  await session.enter();                                                    // 单处替换（命中 1 在公式源码里）
  const done = await poll(async () => {
    const md = await ev(session, 'window.__r4fd.mdValue()');
    return md && md.includes('$beta+1$') ? md : null;
  }, { timeout: 9000, interval: 180 });
  if (!done) return { verdict: 'FAIL', detail: { 阶段: '替换后 getValue 没有 $beta+1$', 状态: await ev(session, 'window.__r4fd.state()'), before } };
  await harness.sleep(500);                                                 // 等公式重排落定
  const owners = await ev(session, 'window.__r4fd.mathOwners()');
  const m = owners && owners[0];
  const focusAfter = await ev(session, 'window.__r4fd.state()');
  const 词 = await ev(session, 'window.__r4fd.词点("正文里再来")');
  await shots(session, frame, 'FR1-替换后', m ? m.point : null,
    m ? [{ x: m.point.x, y: m.point.y, h: m.ownerH, color: '#ff2d2d', label: '公式块' }] : []);
  // 撤销：点回正文（真实点击）→ Ctrl+Z（最多 4 次，撤到原文为准）
  if (!词 || !词.x) return { verdict: 'FAIL', detail: { 阶段: '没取到正文点击点' } };
  await session.click(frame.x + 词.x, frame.y + 词.y);
  await harness.sleep(300);
  let undone = null, used = 0;
  for (let i = 1; i <= 4 && !undone; i++) {
    await hi.combo(session, 'Ctrl+Z'); used = i;
    undone = await poll(async () => {
      const md = await ev(session, 'window.__r4fd.mdValue()');
      return md && md.includes('$alpha+1$') && !md.includes('beta') ? md : null;
    }, { timeout: 2500, interval: 200 });
  }
  const ownersAfter = undone ? await ev(session, 'window.__r4fd.mathOwners()') : null;
  await shots(session, frame, 'FR1-撤销后', ownersAfter && ownersAfter[0] ? ownersAfter[0].point : null, []);
  const previewFresh = !!(m && (m.dataMath === 'beta+1')
    && (m.annotation == null || (m.annotation.includes('beta') && !m.annotation.includes('alpha'))));
  const codeFresh = !!(m && m.codeText === 'beta+1');
  const pass = !!(previewFresh && codeFresh && undone);
  return { verdict: pass ? 'PASS' : 'FAIL', detail: {
    替换前: String(before || '').slice(0, 80), 替换后: String(done || '').slice(0, 80),
    公式层: m, 焦点在替换框: focusAfter.activeIsReplace, 状态: focusAfter,
    撤销成功: !!undone, 撤销用键数: used, 撤销后公式: ownersAfter && ownersAfter[0] ? { codeText: ownersAfter[0].codeText, dataMath: ownersAfter[0].dataMath } : null,
    红条件: '注掉 find-replace.js 的 FR1 公式块守卫后：codeText=beta+1 但 dataMath/annotation 仍是 alpha+1（预览不刷新）→ previewFresh=false 即红；全量管线不重排（setValue 缺失）则 done 为空',
    突变点: 'find-replace.js replaceInPlace 内 if(block.querySelector(...))return false 一行' } };
}

/** FR2：命中在视口外的折叠公式里 → 面板输入完成后当前命中可见（滚动 + 展开）。
 *  【R7 判据修订】焦点留在面板输入框、选区不落编辑面（reveal 面板分支不落选区；
 *  旧口径"选区落命中 sel.inMathCode"因 R7 数据损坏修复废弃）。命中可见 = 滚动进
 *  视口 + 展开折叠公式，当前命中的视觉指示由查找层 CSS Highlight 承担。 */
async function caseFR2(session) {
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点不在编辑器' } };
  const frame = await frameOf(session);
  await ev(session, 'window.__r4fd.resetScroll()');
  await harness.sleep(200);
  const pre = await ev(session, 'window.__r4fd.mathOwners()');
  const m0 = pre && pre[0];
  if (!m0) return { verdict: 'FAIL', detail: { 阶段: '没找到行内公式', pre } };
  if (m0.visible || m0.expand) return { verdict: 'FAIL', detail: { 阶段: '前置不成立：公式初始就在视口内/已展开', m0 } };
  const st0 = await openFind(session, false);
  if (!st0 || !st0.panel) return { verdict: 'FAIL', detail: { 阶段: 'Ctrl+F 没打开面板', st0 } };
  await session.type('zetaUnique');
  const stQ = await settled(session, 10000);
  await harness.sleep(450);                                                 // 给 enforce 观察者留时间（若被收回这里就能看见）
  const post = await ev(session, 'window.__r4fd.mathOwners()');
  const m1 = post && post[0];
  const sel = await ev(session, 'window.__r4fd.selInfo()');
  await shots(session, frame, 'FR2-输入后当前命中', m1 ? m1.point : null,
    m1 ? [{ x: m1.point.x, y: m1.point.y, h: m1.ownerH, color: '#ff2d2d', label: '命中公式' }] : []);
  const pass = !!(stQ && stQ.output === '1 / 1' && m1 && m1.expand && m1.visible
    && stQ.activeIsQuery && !sel.inMathCode);
  return { verdict: pass ? 'PASS' : 'FAIL', detail: {
    初始: m0, 输入后: m1, 滚动前: m0.scrollOf, 滚动后: m1 ? m1.scrollOf : null,
    面板: stQ, 选区: sel,
    口径注: 'R7 起"当前命中可见"不含选区落命中：面板分支 reveal 不动 DOM 选区，焦点留输入框（Enter 永远是下一处）。展开保持依据：焦点在输入框 ⇒ 文档选区为空 ⇒ enforce 收回与 refreshMathEditing 都不被选区/键盘事件唤起',
    红条件: '注掉 onmessage 里的 reveal 调用后：expand=false 且 visible=false（输入完什么都不发生）即红；把 reveal 还原成无条件 addRange 后：activeIsQuery=false（焦点被拽进编辑面）即红（R7 数据损坏回归）',
    突变点: 'find-replace.js worker.onmessage 尾部 reveal() 一行 + reveal 内 if(root().contains(document.activeElement)) 选区分支守卫' } };
}

/** FR3：焦点在编辑面按 F3 → 导航到公式内命中：选区落到命中，展开保持（不被
 *  math-edit 的 enforce 观察者收回）。 */
async function caseFR3(session) {
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点不在编辑器' } };
  const frame = await frameOf(session);
  const st0 = await openFind(session, false);
  if (!st0 || !st0.panel) return { verdict: 'FAIL', detail: { 阶段: 'Ctrl+F 没打开面板', st0 } };
  await session.type('target');
  const stQ = await settled(session);
  if (!stQ || stQ.output !== '1 / 2') return { verdict: 'FAIL', detail: { 阶段: '查找 target 没到 1/2', stQ } };
  const 词 = await ev(session, 'window.__r4fd.词点("普通段")');
  if (!词 || !词.x) return { verdict: 'FAIL', detail: { 阶段: '没取到正文点击点' } };
  await session.click(frame.x + 词.x, frame.y + 词.y);                      // 焦点回编辑面
  await harness.sleep(350);
  const focusBefore = await ev(session, 'window.__r4fd.selInfo()');
  if (!focusBefore.hasFocus) return { verdict: 'FAIL', detail: { 阶段: '点击后焦点不在帧内', focusBefore } };
  await hi.press(session, 'F3');                                            // 编辑面 F3：下一处（公式内）
  await harness.sleep(450);                                                 // enforce 在类变更后的观察者拍里就会收回
  const owners1 = await ev(session, 'window.__r4fd.mathOwners()');
  await harness.sleep(600);
  const owners2 = await ev(session, 'window.__r4fd.mathOwners()');           // 再采样一次：保持而非闪现
  const sel = await ev(session, 'window.__r4fd.selInfo()');
  const m = owners2 && owners2[0];
  await shots(session, frame, 'FR3-F3后展开保持', m ? m.point : null,
    m ? [{ x: m.point.x, y: m.point.y, h: m.ownerH, color: '#ff2d2d', label: '命中公式' }] : []);
  const pass = !!(owners1 && owners1[0] && owners1[0].expand && m && m.expand && m.visible
    && sel.inMathCode && sel.text === 'target');
  return { verdict: pass ? 'PASS' : 'FAIL', detail: {
    F3后即刻: owners1 && owners1[0], 一秒后: m, 选区: sel, 面板: await ev(session, 'window.__r4fd.state()'),
    口径注: 'R7 分支口径下本用例判据不变：编辑面 F3 时焦点本就在编辑面，reveal 保留选区落命中（Typora 手感，公式展开靠"光标在源码里"合法化）。面板发起的导航才走不落选区分支',
    红条件: '去掉 reveal 里的选区落位（只加 expand 类）后：owners1/owners2 的 expand 都被 enforce 收回成 false 即红；去掉 if(root().contains(document.activeElement)) 守卫（面板也不落选区）后：sel.inMathCode=false 即红',
    突变点: 'find-replace.js reveal 内 if(root().contains(document.activeElement)){…addRange…} 分支（守卫与 addRange 任一去掉即红）' } };
}

/** FR4：sourceText 块间补 DIV/PRE 分隔符 → 跨块接缝查询词 0 命中；正向对照真实词 1 命中。 */
async function caseFR4(session) {
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点不在编辑器' } };
  const frame = await frameOf(session);
  const probe = await ev(session, 'window.__r4fd.boundaryProbe()');
  if (!probe) return { verdict: 'FAIL', detail: { 阶段: '页内模型求值失败' } };
  if (!probe.candidates.length) {
    return { verdict: 'EVIDENCE', detail: { 通道限制: '当前文档没有旧模型无缝、新模型补分隔的块边界（候选为空）', probe: { topTags: probe.topTags, oldLen: probe.oldText.length, newLen: probe.newText.length } } };
  }
  const q = probe.candidates[0].q;
  const st0 = await openFind(session, false);
  if (!st0 || !st0.panel) return { verdict: 'FAIL', detail: { 阶段: 'Ctrl+F 没打开面板', st0 } };
  await session.type(q);
  const stQ = await settled(session, 10000);
  const countQ = stQ ? stQ.output : null;
  await shots(session, frame, 'FR4-跨块查询', st0 && st0.panel ? { x: 300, y: 60 } : null, []);
  await hi.press(session, 'Escape');                                        // 关面板，重开做正向对照
  await harness.sleep(300);
  const 词 = await ev(session, 'window.__r4fd.词点("尾巴c")');                // 先把选区放到一个真实词上
  if (词 && 词.x) await session.click(frame.x + 词.x, frame.y + 词.y);
  await harness.sleep(250);
  await hi.combo(session, 'Ctrl+F');
  await harness.sleep(320);
  await session.type('尾巴c');
  const stC = await settled(session, 10000);
  const countC = stC ? stC.output : null;
  await shots(session, frame, 'FR4-正向对照', { x: 300, y: 60 }, []);
  const pass = !!(countQ === '0 / 0' && countC === '1 / 1');
  return { verdict: pass ? 'PASS' : 'FAIL', detail: {
    跨块查询词: q, 边界上下文: probe.candidates[0], 顶层标签: probe.topTags,
    跨块计数: countQ, 对照词: '尾巴c', 对照计数: countC,
    红条件: "source-text.js 分隔符清单还原成 /^(P|H[1-6]|LI|TR|BLOCKQUOTE)$/ 后：同一查询词 countQ 变 '1 / 1' 即红",
    突变点: 'source-text.js 第 13 行正则去掉 DIV|PRE' } };
}

/** FR5：选中行内公式（选区恰覆盖公式 owner）→ Ctrl+F 查找框预填 $源码$。
 *  不碰系统剪贴板：断言直接读查找框 input.value。 */
async function caseFR5(session) {
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点不在编辑器' } };
  const frame = await frameOf(session);
  const placed = await ev(session, 'window.__r4fd.selectFormulaOwner()');
  if (!placed || !placed.ok) return { verdict: 'FAIL', detail: { 阶段: '没把选区放到公式 owner 上', placed } };
  const owner0 = await ev(session, 'window.__r4fd.mathOwners()');
  await shots(session, frame, 'FR5-选中公式', owner0 && owner0[0] ? owner0[0].point : null, []);  // 选区高亮原生拍摄，无标记
  const st0 = await openFind(session, false);
  const seeded = st0 ? st0.query : null;
  const st1 = await settled(session, 10000);                                 // 播种词即源码：应当能搜到 1 处
  await shots(session, frame, 'FR5-播种后', { x: 300, y: 60 }, []);
  const expect = '$' + placed.codeText + '$';
  const pass = !!(st0 && st0.panel && seeded === expect && st1 && st1.output === '1 / 1');
  return { verdict: pass ? 'PASS' : 'FAIL', detail: {
    期望: expect, 实际预填: seeded, 公式源码: placed.codeText,
    旧口径会播种的原文: placed.raw, 播种后搜索: st1 ? st1.output : null,
    红条件: '还原 open() 里 getSelection().toString() 播种后：预填变 KaTeX 垃圾文本（raw，含渲染层重复字符）即红',
    突变点: 'find-replace.js open() 内 selectionPlainText(api) 播种三行' } };
}

/** FR6：替换框 Enter×3 连续替换 3 处（焦点全程在替换框）；全部替换后焦点回查找框。 */
async function caseFR6(session) {
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点不在编辑器' } };
  const frame = await frameOf(session);
  const st0 = await openFind(session, true);
  if (!st0 || !st0.panel || st0.replaceRowHidden) return { verdict: 'FAIL', detail: { 阶段: 'Ctrl+H 没打开替换面板', st0 } };
  await session.type('alpha');
  const stQ = await settled(session);
  if (!stQ || stQ.output !== '1 / 3') return { verdict: 'FAIL', detail: { 阶段: '查找 alpha 没到 1/3', stQ } };
  const bx = await ev(session, 'window.__r4fd.boxes()');
  await clickIn(session, frame, bx.replace); await harness.sleep(180);
  await session.type('omega');
  const steps = [];
  for (let i = 1; i <= 3; i++) {
    if (!(await ev(session, 'window.__r4fd.state()')).activeIsReplace) {
      steps.push({ 次: i, 焦点丢失: true }); break;
    }
    await session.enter();
    const st = await settled(session, 9000);
    steps.push({ 次: i, 输出: st ? st.output : null, 焦点在替换框: st ? st.activeIsReplace : null, 焦点: st ? st.activeDesc : null });
    if (!st || !st.activeIsReplace) break;
  }
  const mdAfter = await ev(session, 'window.__r4fd.mdValue()');
  await shots(session, frame, 'FR6-三次回车后', { x: 300, y: 60 }, []);
  // 全部替换：查找词换 delta、替换词换 sigma，点"全部替换"按钮
  const b2 = await ev(session, 'window.__r4fd.boxes()');
  await clickIn(session, frame, b2.query); await harness.sleep(150);
  await hi.combo(session, 'Ctrl+A'); await harness.sleep(120);
  await session.type('delta');
  await settled(session, 9000);
  const b3 = await ev(session, 'window.__r4fd.boxes()');
  await clickIn(session, frame, b3.replace); await harness.sleep(150);
  await hi.combo(session, 'Ctrl+A'); await harness.sleep(120);
  await session.type('sigma');
  const queryWord = (await ev(session, 'window.__r4fd.state()')).query;
  const b4 = await ev(session, 'window.__r4fd.boxes()');
  await clickIn(session, frame, b4.all);
  const stAll = await poll(async () => {
    const st = await settled(session, 9000);
    const md = await ev(session, 'window.__r4fd.mdValue()');
    return st && md && md.includes('sigma') ? st : null;
  }, { timeout: 12000, interval: 250 });
  const mdAll = await ev(session, 'window.__r4fd.mdValue()');
  await shots(session, frame, 'FR6-全部替换后', { x: 300, y: 60 }, []);
  const singlesOK = steps.length === 3 && steps.every(s => s.焦点在替换框 === true);
  const singlesDone = !!(mdAfter && (mdAfter.match(/omega/g) || []).length >= 3 && !mdAfter.includes('alpha'));
  const allOK = !!(stAll && stAll.activeIsQuery && (mdAll.match(/sigma/g) || []).length >= 2 && !mdAll.includes('delta'));
  const pass = !!(singlesOK && singlesDone && allOK && queryWord === 'delta');
  return { verdict: pass ? 'PASS' : 'FAIL', detail: {
    连续替换记录: steps, 单处替换后全文: String(mdAfter || ''), 改词后查找框: queryWord,
    全部替换后焦点: stAll ? { activeIsQuery: stAll.activeIsQuery, activeDesc: stAll.activeDesc, 输出: stAll.output } : null,
    全部替换后全文: String(mdAll || ''),
    口径注: 'R7 起替换后重搜的 reveal 走面板分支（不落选区），焦点留在替换框不再依赖"落选区→还焦"两步：replace.focus() 后 onmessage 的 reveal() 不动选区，activeIsReplace 全程为真，判据与旧口径等价、无需修订',
    红条件: '还原 apply() 里 query.focus 后：第 1 次替换后焦点跳查找框（steps[0].焦点在替换框=false、全文只有 1 个 omega）即红；把 reveal 还原成无条件 addRange 后：每次替换 onmessage 先把焦点拽进编辑面再无还焦，activeIsReplace=false 即红',
    突变点: 'find-replace.js 两处 (allMatches?query:replace).focus 与 replaceInPlace 路径的 replace.focus，及 reveal 内面板分支守卫' } };
}

/** FR7：查找框 IME 组字中间态不触发即时搜索；上屏后才搜。组字走
 *  Input.imeSetComposition + Input.insertText 组合（参照 probe-r3-evidence F5 的用法：
 *  imeSetComposition 造组合中间态，insertText 是 Chromium 里 IME 提交上屏的真实通道）。 */
async function caseFR7(session) {
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点不在编辑器' } };
  const frame = await frameOf(session);
  const st0 = await openFind(session, false);
  if (!st0 || !st0.panel) return { verdict: 'FAIL', detail: { 阶段: 'Ctrl+F 没打开面板', st0 } };
  const base = await settled(session);
  if (!base || base.output !== '0 / 0') return { verdict: 'FAIL', detail: { 阶段: '初始计数不是 0/0', base } };
  const samples = [];
  for (const text of ['目', '目标', '目标词']) {
    await session.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await harness.sleep(260);
    const st = await ev(session, 'window.__r4fd.state()');
    samples.push({ 组字: text, 框值: st.query, pending: st.pending, 计数: st.output });
  }
  const chOk = samples.length === 3 && samples.every(s => s.框值 === s.组字);
  if (!chOk) {
    return { verdict: 'EVIDENCE', detail: { 通道限制: 'imeSetComposition 没有把组字写进查找框（输入通道未生效，红绿均不可判）', samples } };
  }
  await shots(session, frame, 'FR7-组字中', { x: 300, y: 60 }, []);
  await session.send('Input.insertText', { text: '目标词' });
  const stCommit = await settled(session, 10000);
  await shots(session, frame, 'FR7-上屏后', { x: 300, y: 60 }, []);
  const midQuiet = samples.every(s => s.pending === false && s.计数 === '0 / 0');
  const commitSearched = !!(stCommit && stCommit.output === '1 / 2');
  const pass = !!(midQuiet && commitSearched);
  return { verdict: pass ? 'PASS' : 'FAIL', detail: {
    组字采样: samples, 上屏后: stCommit ? { 框值: stCommit.query, 输出: stCommit.output, pending: stCommit.pending } : null,
    红条件: '去掉 input 监听里 isComposing 守卫后：samples 里 pending=true / 计数非 0/0（组字每键触发全篇搜索）即红',
    突变点: 'find-replace.js query input 监听 if(event.isComposing)return 一行' } };
}

/** FC4：补全浮层弹着 → Ctrl+F 打开查找 → 浮层必须消失（不被 z1000 盖住查找框）。 */
async function caseFC4(session) {
  const frame = await frameOf(session);
  const spot = await ev(session, 'window.__r4fd.inlineMathPoint()');
  if (!spot) return { verdict: 'FAIL', detail: { 阶段: '没找到行内公式' } };
  await session.click(frame.x + spot.x, frame.y + spot.y);                   // 点开公式：展开、光标进源码
  await harness.sleep(600);
  await session.type('\\ma');                                               // 真实输入通道敲公式源码前缀
  const pop = await poll(async () => {
    const p = await ev(session, 'window.__r4fd.popup()');
    return p && p.visible ? p : null;
  }, { timeout: 9000, interval: 200 });
  if (!pop) {
    return { verdict: 'EVIDENCE', detail: { 通道限制: '补全浮层没有弹起（该构建补全未启用或触发条件未满足），Ctrl+F 关浮层无从判起',
      补全浮层: await ev(session, 'window.__r4fd.popup()') } };
  }
  const focusBefore = await ev(session, 'window.__r4fd.selInfo()');
  if (!focusBefore.hasFocus) return { verdict: 'FAIL', detail: { 阶段: '敲前缀后焦点不在帧内', focusBefore } };
  await shots(session, frame, 'FC4-补全弹着', { x: pop.x + pop.w / 2, y: Math.max(60, pop.y - 20) }, []);
  await hi.combo(session, 'Ctrl+F');
  await harness.sleep(500);
  const gone = await poll(async () => {
    const p = await ev(session, 'window.__r4fd.popup()');
    return p && !p.visible ? p : null;
  }, { timeout: 3000, interval: 150 });
  const st = await ev(session, 'window.__r4fd.state()');
  const bxs = await ev(session, 'window.__r4fd.boxes()');
  await shots(session, frame, 'FC4-CtrlF后', bxs && bxs.panel ? { x: bxs.panel.x + bxs.panel.w / 2, y: bxs.panel.y + 30 } : { x: 300, y: 60 }, []);
  const pass = !!(gone && st.panel);
  return { verdict: pass ? 'PASS' : 'FAIL', detail: {
    弹起时: pop, CtrlF后浮层: gone, 面板: st.panel, 查找框聚焦: st.activeIsQuery,
    红条件: '注掉 open() 里的 api.__completion?.dismiss() 后：popup().visible 仍为 true（z1000 浮层盖在查找框上）即红',
    突变点: 'find-replace.js open() 首行 api.__completion?.dismiss()' } };
}

// ─── 编排 ───────────────────────────────────────────────────────────────────────
const GROUPS = [
  { doc: 'r4fd-fr1.md', content: DOC_FR1, cases: [['FR1公式内替换一致性', caseFR1]] },
  { doc: 'r4fd-fr2.md', content: DOC_FR2, cases: [['FR2输入后当前命中可见', caseFR2]], open: { minBlocks: 10, settleMs: 2000, timeout: 200000 } },
  { doc: 'r4fd-fr3.md', content: DOC_FR3, cases: [['FR3编辑面F3展开保持', caseFR3]] },
  { doc: 'r4fd-fr4.md', content: DOC_FR4, cases: [['FR4跨块假命中', caseFR4]] },
  { doc: 'r4fd-fr5.md', content: DOC_FR5, cases: [['FR5选中公式播种源码', caseFR5]] },
  { doc: 'r4fd-fr6.md', content: DOC_FR6, cases: [['FR6替换框连续替换', caseFR6]] },
  { doc: 'r4fd-fr7.md', content: DOC_FR7, cases: [['FR7组字不触发搜索', caseFR7]] },
  { doc: 'r4fd-fc4.md', content: DOC_FC4, cases: [['FC4补全浮层随CtrlF关闭', caseFC4]] },
];

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  // 名字归一后取"前缀命中"：--only=fr3 也能命中 fr3f3展开保持 这类带尾缀的名字。
  const want = name => { if (!only.length) return true;
    const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return only.includes(norm) || only.some(o => norm.startsWith(o)); };
  const log = [];
  const report = (name, verdict, detail) => {
    const line = 'R4FD ' + name + ' ' + verdict + ' ' + JSON.stringify(detail);
    console.log(line);
    log.push(line);
  };
  console.log((DEV ? '开发树模式（electron + app/main/main.js）' : '已安装产物模式') + '：' + EXE);
  const ctx = {
    launch: options => harness.launch({ exe: EXE, ...(DEV ? { appArgs: [APP_MAIN] } : {}),
      label: 'probe-r4-find', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  let passed = 0, failed = 0, evidenced = 0;
  try {
    for (const group of GROUPS) {
      const todo = group.cases.filter(([name]) => want(name));
      if (!todo.length) continue;
      const file = path.join(OUT, group.doc);
      fs.writeFileSync(file, group.content, 'utf8');
      const env = { file };
      console.log('\n=== ' + group.doc + '：' + todo.map(([n]) => n).join(', ') + ' ===');
      const openOpts = group.open || { minBlocks: 2, settleMs: 1800, timeout: 200000 };
      let session = null;
      try {
        session = await hi.openDoc(ctx, file, { ...openOpts, inspect: false });   // 每用例独立实例
        const installed = await session.js(INSTALL);
        if (!installed || !installed.ok) throw new Error('页内工具装载失败：' + JSON.stringify(installed));
        for (const [name, run] of todo) {
          try {
            const outcome = await run(session, env) || {};
            if (session.errors && session.errors.length) outcome.detail = { ...(outcome.detail || {}), 页面错误: session.errors.slice(0, 3) };
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
        if (session) await ctx.release(session);     // 释放实例（单 GUI 串行，端口让出来再开下一组）
      }
    }
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
  }
  console.log('\n=== 汇总：PASS ' + passed + ' / FAIL ' + failed + ' / EVIDENCE ' + evidenced + ' ===');
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '；截图：' + OUT + '）');
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error('probe-r4-find 失败：', error); process.exit(1); });
