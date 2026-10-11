/** 探针 · 第 2 轮判决落实（2026-10-02）的实机验收：拖放域一条——
 *   D2  drop 通道：落点在行内公式**闭 $ 中线右半带**（外半带）时 preventDefault，
 *       按 selectOutside 同口径把拖放文本插到公式外（typora-patches.js patchInlineMathClickPosition
 *       里新增的 document drop 监听）。
 *
 *  拖放通道说明（为什么主判用 Input.dispatchDragEvent）：
 *   · 外半带只在**展开态**有像素（折叠围栏宽 0）。而"在别处选中一个词"会立刻把公式收起
 *     （math-edit 的 refreshMathEditing/enforce），所以"真鼠标拖词→展开公式外半带"这条路
 *     天然凑不出判据形状；dispatchDragEvent 是 CDP 的**真实拖放通道**（Blink 拖放控制器），
 *     只发 dragOver+dragDrop、不动选区——公式保持展开，drop 事件照常走产品的监听器。
 *   · 另附一个 EVIDENCE 用例试"真鼠标手势"（dblclick 选词 + hi.drag），记录这条通道在当前
 *     Electron 里到底发不发得出 drop 事件，供后续判据升级。
 *
 *  判据全部是**用户能看见的性质**（md 里字在公式内还是外、drop 有没有被接管），不断言
 *  "监听器被调用了"。每用例一行：
 *     R2TP <用例名> PASS/FAIL/EVIDENCE <关键读数 JSON>
 *  每用例存整页 + 落点附近 2x 放大截图到 .perf/probe-r2-drop/（红实线＝光标、
 *  青虚线＝drop 落点、琥珀虚线＝期望插入位）。
 *
 *  各用例的红条件（未修复版上必红）：
 *   D2a  把 "ab" 拖放到展开公式 $x$ 闭 $ 右半带松手：旧版 Blink 把落点解进源码，
 *        md 变 `前缀 $xab$`（ab 进了公式）；修复后 `前缀 $x$ab`（ab 在公式外）。
 *   D2b  对照——拖到公式**本体**（源码区）上：必须仍进源码（`$xcd$`/`$cdx$`），
 *        变成 `$x$cd` 说明接管过度（这一条红＝修复本身错，不是旧版红）。
 *   D2c  EVIDENCE：真鼠标拖放通道能力记录，不判红绿。
 *
 *  用法：node scripts/acceptance/probe-r2-drop.cjs [--only=d2a,d2b,d2c]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-r2-drop');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');

const DOC1 = ['# 拖放判侧文档', '',
  '源词段落：这里有 ab 两个字符用来拖拽。', '',
  '落点段落：前缀 $x$ 后缀收尾。', ''].join('\n');

// ─── 页内工具（装进编辑器 iframe；标记画法沿用 probe-r1-caret 的 __pr/__r1 口径） ─────────
const HELPERS = `window.__r2d = (() => {
  const surface = () => document.querySelector('.vditor-ir .vditor-reset');
  const layerOf = at => !at ? '?' :
    at.closest && at.closest('code[data-type]') ? '源码'
    : at.closest && at.closest('.vditor-ir__preview') ? '预览'
    : at.closest && at.closest('[data-type$="-marker"]') ? '围栏'
    : at.closest && at.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote') ? '正文' : '元素级';
  const mark = list => {
    const old = document.getElementById('__r2d_marks');
    if (old) old.remove();
    if (!list || !list.length) return 0;
    const layerNode = document.createElement('div');
    layerNode.id = '__r2d_marks';
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
  const unmark = () => { const old = document.getElementById('__r2d_marks'); if (old) old.remove(); return 1; };
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
      选区: s.toString().slice(0, 40), 选区长: s.toString().length,
      x: Math.round(b.left), y: Math.round(b.top), h: Math.round(b.height), 可见: !!(b && b.height) };
  };
  /** 源码为指定文本的行内公式几何（iframe 内坐标）：owner 盒、开/闭围栏盒、源码 code 盒、
   *  展开态，以及"闭 $ 右半带落点"与"源码区中心"两个备选落点。 */
  const 公式 = src => {
    for (const owner of surface().querySelectorAll('.vditor-ir__node[data-type="inline-node"]')) {
      const code = owner.querySelector('code[data-type="math-inline"]');
      if (!code || String(code.textContent).replace(/\\s/g, '') !== src) continue;
      owner.scrollIntoView({ block: 'center', behavior: 'instant' });
      const b = owner.getBoundingClientRect();
      const 标 = [...(owner.children || [])].filter(子 => 子.nodeName === 'SPAN'
        && 子.classList && 子.classList.contains('vditor-ir__marker'));
      const 开 = 标.length ? 标[0].getBoundingClientRect() : null;
      const 闭 = 标.length > 1 ? 标[标.length - 1].getBoundingClientRect() : null;
      const 源码盒 = code.getBoundingClientRect();
      const 外半带 = 闭 && 闭.width ? {
        x: Math.round(闭.left + 闭.width * 0.72),
        y: Math.round(闭.top + 闭.height / 2) } : null;
      return { 有: true, 展开: owner.classList.contains('vditor-ir__node--expand'),
        盒: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
        渲染中心: { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + Math.min(b.height / 2, 14)) },
        开宽: 开 ? Math.round(开.width) : null, 闭: 闭 ? [Math.round(闭.left), Math.round(闭.top), Math.round(闭.width), Math.round(闭.height)] : null,
        源码中心: 源码盒.width ? { x: Math.round(源码盒.left + 源码盒.width / 2), y: Math.round(源码盒.top + Math.min(源码盒.height / 2, 12)) } : null,
        外半带 };
    }
    return { 有: false };
  };
  /** 指定词的文本盒（iframe 内坐标，真实双击/拖拽的落点）。 */
  const 词盒 = word => {
    for (const block of surface().children) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node;
      while (node = walker.nextNode()) {
        const at = node.data.indexOf(word);
        if (at < 0) continue;
        const r = document.createRange(); r.setStart(node, at); r.setEnd(node, at + word.length);
        const b = r.getBoundingClientRect();
        if (b.width > 0) return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
          左: Math.round(b.left), 右: Math.round(b.right) };
      }
    }
    return null;
  };
  /** drop 记录器：产品监听器注册在先（capture），我们后注册的 capture 读到的 prevented
   *  已包含产品的 preventDefault；bubble 那一笔记最终态。 */
  const rec = [];
  document.addEventListener('drop', e => {
    rec.push({ t: Math.round(performance.now()), x: Math.round(e.clientX), y: Math.round(e.clientY),
      通道: 'capture', preventedAtCapture: e.defaultPrevented, types: e.dataTransfer ? [...e.dataTransfer.types] : [] });
  }, true);
  document.addEventListener('drop', e => {
    const last = rec[rec.length - 1];
    if (last) last.preventedAfter = e.defaultPrevented;
  }, false);
  return { caret, mark, unmark, 公式, 词盒,
    drops: () => rec.slice(), clearDrops: () => { rec.length = 0; return rec.length; },
    补丁记账: () => window.__typoraDropOutside || null };
})();`;

const INSTALL = `(() => { const w = ${hi.IF};
  if (!w || !w.document.querySelector('${hi.SURFACE}')) return { ok: false };
  if (!w.__r2d) w.eval(${JSON.stringify(HELPERS)});
  return { ok: !!w.__r2d }; })()`;
const IN = expression => `(() => { const w = ${hi.IF}; return w.eval(${JSON.stringify(expression)}); })()`;
const readCaret = session => session.js(IN('window.__r2d.caret()'));
const caretMark = r => (r && r.可见) ? [{ x: r.x, y: r.y, h: r.h, color: '#ff2d2d', label: '光标' }] : [];
const frameOf = session => session.js(`(() => { const f = document.getElementById('editor');
  const r = f.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()`);
const focusOK = async session => (await hi.ensureFocus(session)).ok;

/** 整页 + 落点附近 2x 放大截图（anchor/marks 都是 iframe 内坐标，clip 才加 iframe 偏移）。 */
async function shots(session, frame, name, anchor, marks) {
  try {
    const clip = { x: frame.x + Math.max(0, (anchor && anchor.x || 300) - 240),
      y: frame.y + Math.max(0, (anchor && anchor.y || 300) - 55), width: 560, height: 165, scale: 2 };
    if (marks && marks.length) await session.js(IN('window.__r2d.mark(' + JSON.stringify(marks) + ')'));
    const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(OUT, name + '-2x.png'), Buffer.from(shot.data, 'base64'));
    await session.js(IN('window.__r2d.unmark()'));
    await session.shot(name + '-full');
  } catch (error) { console.log('  （截图失败 ' + name + '：' + String(error && error.message || error).slice(0, 120) + '）'); }
}

/** CDP 拖放通道：dragOver → dragDrop（真实 drag 事件序列；dragData 带纯文本载荷）。 */
async function cdpDrop(session, topPoint, text) {
  const dragData = { items: [{ mimeType: 'text/plain', data: text, title: '' }], files: [], dragOperationsMask: 1 };
  await session.send('Input.dispatchDragEvent', { type: 'dragOver', x: topPoint.x, y: topPoint.y, modifiers: 0, dragData });
  await harness.sleep(80);
  await session.send('Input.dispatchDragEvent', { type: 'dragDrop', x: topPoint.x, y: topPoint.y, modifiers: 0, dragData });
  await harness.sleep(650);
}

/** 点开公式（真实点击渲染结果），返回展开后的几何；展不开返回 null。 */
async function 展开公式(session, frame) {
  const g0 = await session.js(IN('window.__r2d.公式("x")'));
  if (!g0 || !g0.有) return { 失败: '没找到 $x$' };
  await session.click(frame.x + g0.渲染中心.x, frame.y + g0.渲染中心.y);
  await harness.sleep(700);
  const g1 = await session.js(IN('window.__r2d.公式("x")'));
  if (!g1 || !g1.有) return { 失败: '重读公式失败' };
  if (!g1.展开) return { 失败: '点击后没展开', 公式: g1 };
  if (!g1.外半带) return { 失败: '闭 $ 没有像素（宽 0）', 公式: g1 };
  return { 公式: g1 };
}

const md行 = (md, 词) => {
  const s = String(md || '');
  const at = s.indexOf('落点段落');
  return at >= 0 ? s.slice(at, at + 40) : s.slice(0, 60);
};

// ─── 用例 ───────────────────────────────────────────────────────────────────────

/** D2a：把 "ab" 拖放到展开公式 $x$ 闭 $ 右半带松手——md 里 ab 必须在公式外。 */
async function caseD2a(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点' } };
  const 开 = await 展开公式(session, frame);
  if (!开 || 开.失败) return { verdict: 'FAIL', detail: { 阶段: '展开公式', ...开 } };
  const g = 开.公式;
  const 起点 = await readCaret(session);
  await shots(session, frame, 'D2a-展开待拖', g.外半带, [...caretMark(起点),
    { x: g.外半带.x, y: g.外半带.y, h: 22, dash: true, color: '#25d0ff', label: '外半带落点' }]);
  const mdBefore = String(await hi.mdNow(session));
  await session.js(IN('window.__r2d.clearDrops()'));
  let 通道 = 'Input.dispatchDragEvent（dragOver+dragDrop，text/plain=ab）';
  try {
    await cdpDrop(session, { x: frame.x + g.外半带.x, y: frame.y + g.外半带.y }, 'ab');
  } catch (error) {
    return { verdict: 'EVIDENCE', detail: { 结论: 'CDP 拖放通道不可用，主判据无从落地', 通道,
      错误: String(error && error.message || error).slice(0, 200), 公式: g } };
  }
  const mdAfter = String(await hi.mdNow(session));
  const drops = await session.js(IN('window.__r2d.drops()'));
  const 记账 = await session.js(IN('window.__r2d.补丁记账()'));
  const 落 = await readCaret(session);
  await shots(session, frame, 'D2a-松手后', 落.可见 ? 落 : g.外半带, [...caretMark(落),
    { x: g.外半带.x, y: g.外半带.y, h: 22, dash: true, color: '#25d0ff', label: '外半带落点' }]);
  if (!drops || !drops.length) {
    return { verdict: 'EVIDENCE', detail: { 结论: '拖放事件没有发出来（通道无 drop）', 通道, 公式: g,
      md前: md行(mdBefore), md后: md行(mdAfter) } };
  }
  const 在外 = mdAfter.includes('前缀 $x$ab');
  const 在内 = mdAfter.includes('$xab$') || mdAfter.includes('$abx$');
  return { verdict: 在外 && !在内 ? 'PASS' : 'FAIL', detail: {
    通道, 公式: g, 起点, 松手后: 落, drops, 补丁记账: 记账,
    md前: md行(mdBefore), md后: md行(mdAfter), 在外, 在内,
    红: '旧版 Blink 把外半带落点解进源码：md 变 前缀 $xab$ 后缀（ab 进了公式，在外=false、在内=true）' } };
}

/** D2b（对照）：把 "cd" 拖到公式**本体**（源码区中心）——必须仍进源码，验证没有接管过度。 */
async function caseD2b(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点' } };
  const 开 = await 展开公式(session, frame);
  if (!开 || 开.失败) return { verdict: 'FAIL', detail: { 阶段: '展开公式', ...开 } };
  const g = 开.公式;
  if (!g.源码中心) return { verdict: 'FAIL', detail: { 阶段: '源码区没有盒子', 公式: g } };
  const mdBefore = String(await hi.mdNow(session));
  await session.js(IN('window.__r2d.clearDrops()'));
  let 通道 = 'Input.dispatchDragEvent（dragOver+dragDrop，text/plain=cd）';
  try {
    await cdpDrop(session, { x: frame.x + g.源码中心.x, y: frame.y + g.源码中心.y }, 'cd');
  } catch (error) {
    return { verdict: 'EVIDENCE', detail: { 结论: 'CDP 拖放通道不可用', 通道,
      错误: String(error && error.message || error).slice(0, 200) } };
  }
  const mdAfter = String(await hi.mdNow(session));
  const drops = await session.js(IN('window.__r2d.drops()'));
  const 记账 = await session.js(IN('window.__r2d.补丁记账()'));
  const 落 = await readCaret(session);
  await shots(session, frame, 'D2b-本体松手后', 落.可见 ? 落 : g.源码中心, [...caretMark(落),
    { x: g.源码中心.x, y: g.源码中心.y, h: 22, dash: true, color: '#25d0ff', label: '源码区落点' }]);
  if (!drops || !drops.length) {
    return { verdict: 'EVIDENCE', detail: { 结论: '拖放事件没有发出来（通道无 drop）', 通道,
      md前: md行(mdBefore), md后: md行(mdAfter) } };
  }
  const 在内 = /\$x?cdx?\$/.test(mdAfter);
  const 在外 = mdAfter.includes('$x$cd');
  return { verdict: 在内 && !在外 ? 'PASS' : 'FAIL', detail: {
    通道, 公式: g, 松手后: 落, drops, 补丁记账: 记账,
    md前: md行(mdBefore), md后: md行(mdAfter), 在内, 在外,
    红: '这一条红＝修复本身错（接管过度）：cd 落在公式本体却被插到公式外（md 变 $x$cd）' } };
}

/** D2c（EVIDENCE）：真鼠标手势通道——双击选词 "ab" 后 hi.drag 拖到公式右侧，记录
 *  这条通道在当前 Electron 里发不发得出 drop 事件、md 落在哪。不判红绿。 */
async function caseD2c(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'EVIDENCE', detail: { 阶段: '焦点' } };
  const 词 = await session.js(IN('window.__r2d.词盒("ab")'));
  if (!词) return { verdict: 'EVIDENCE', detail: { 结论: '没找到源词 ab' } };
  const g0 = await session.js(IN('window.__r2d.公式("x")'));
  const mdBefore = String(await hi.mdNow(session));
  await session.click(frame.x + 词.x, frame.y + 词.y, { clickCount: 2 });   // 真实双击选词
  await harness.sleep(350);
  const 选 = await readCaret(session);
  await session.js(IN('window.__r2d.clearDrops()'));
  // 目标：闭 $ 右半带（有像素时）或公式盒右缘外 6px（折叠时的近似带）
  const 目标 = g0 && g0.外半带 ? g0.外半带
    : (g0 && g0.盒 ? { x: g0.盒[0] + g0.盒[2] + 6, y: g0.盒[1] + Math.min(g0.盒[3] / 2, 14) } : null);
  if (!目标) return { verdict: 'EVIDENCE', detail: { 结论: '没找到落点', 公式: g0 } };
  await hi.drag(session, { x: frame.x + 词.x, y: frame.y + 词.y }, { x: frame.x + 目标.x, y: frame.y + 目标.y },
    { steps: 10, after: 700 });
  const mdAfter = String(await hi.mdNow(session));
  const drops = await session.js(IN('window.__r2d.drops()'));
  const 选后 = await readCaret(session);
  await shots(session, frame, 'D2c-真手势后', 选后.可见 ? 选后 : 目标, [...caretMark(选后),
    { x: 目标.x, y: 目标.y, h: 22, dash: true, color: '#25d0ff', label: '拖放目标' }]);
  return { verdict: 'EVIDENCE', detail: {
    结论: drops && drops.length ? '真鼠标通道能发出 drop 事件' : '真鼠标通道没有发出 drop 事件（CDP mouse 不驱动原生拖放）',
    源词: 词, 拖放目标: 目标, 双击后选区: 选, 拖后: 选后, drops,
    md前: md行(mdBefore), md后: md行(mdAfter) } };
}

// ─── 装配 ───────────────────────────────────────────────────────────────────────

const GROUPS = [
  { doc: 'r2-doc-drop.md', content: DOC1, cases: [['D2a', caseD2a], ['D2b', caseD2b], ['D2c', caseD2c]] },
];

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  const want = name => !only.length || only.includes(name.toLowerCase()) || only.includes(name);
  const log = [];
  const report = (name, verdict, detail) => {
    const line = 'R2TP ' + name + ' ' + verdict + ' ' + JSON.stringify(detail);
    console.log(line);
    log.push(line);
  };
  const ctx = {
    launch: options => harness.launch({ exe: EXE, appArgs: [APP_MAIN], label: 'probe-r2-drop',
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
})().catch(error => { console.error('probe-r2-drop 失败：', error); process.exit(1); });
