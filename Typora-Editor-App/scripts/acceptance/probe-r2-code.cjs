/** 探针 · 第 2 轮判决落实（2026-10-02）的实机验收：代码块/标题域两条——
 *   L1  代码块源码行按可落行处理（usable 放行 code-block 的 pre.vditor-ir__marker--pre 内
 *       位置）：段+3行代码块+段连发 ↓/↑ 逐行走完、15 行高块 ↓ 不吞键；
 *   L3  Home 邻行兜底前先试本行合法落点（公式源码 0 处/井号前）：`# $a+b$` 按 Home 留本行。
 *
 *  判据全部是**用户能看见的性质**（光标走进哪一源码行、有没有按了不动、标题行有没有被甩出去），
 *  绝不断言"处理器被调用了"。每用例一行：
 *     R2TP <用例名> PASS/FAIL/EVIDENCE <关键读数 JSON>
 *  每用例存整页 + 光标附近 2x 放大截图到 .perf/probe-r2-code/。CDP 抓帧拍不到原生光标，
 *  图上按浏览器自报的光标矩形画标记：红实线＝光标落点、琥珀虚线＝期望行、青虚线＝点击处。
 *
 *  各用例的红条件（未修复版上必红）：
 *   L1a 3 行代码块：旧版 usable 把 pre.vditor-ir__marker--pre 整块拒掉，↓ 从首段直接落到尾段
 *       （代码行落点数 = 0 或跳行）；↑ 回程同样跳过。
 *   L1b 15 行高块：旧版 ↓ 在块上一连多按原地不动（吞键，行号序列出现连续重复且后面还有行），
 *       或整块被跳过（行号落点数 = 0）。
 *   L3  `# $a+b$`：旧版 Home 后行端找不到本行落点、邻行兜底把光标踢出标题行
 *       （focus 落进前/后段落，不在 h1 里）。
 *
 *  用法：node scripts/acceptance/probe-r2-code.cjs [--only=l1a,l1b,l3]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-r2-code');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');

const FENCE = '```';
const DOC1 = ['# 代码块纵向逐行', '',
  '首段起点文字，按 ↓ 从这里开始逐行走。', '',
  FENCE + 'js',
  'const a = 1;',
  'const b = 2;',
  'const c = 3;',
  FENCE, '',
  '尾段承接文字，↑ 回程的终点。', ''].join('\n');
// 行文刻意短（≈20 字符）：代码块 pre 不横滚换行，一源码行＝一视觉行，逐行判读才干净
const 高块行 = i => 'L' + String(i).padStart(2, '0') + ' const v' + i + ' = ' + i + ';';
const DOC2 = ['# 高块不吞键', '',
  '上方段落起点，连按 ↓ 要一行一行穿过下面这块。', '',
  FENCE + 'js',
  ...Array.from({length: 15}, (_, i) => 高块行(i + 1)),
  FENCE, '',
  '下方段落终点，穿过高块以后落在这里。', ''].join('\n');
const DOC3 = ['# 标题 Home 判侧', '',
  '前段落隔开文字一行。', '',
  '# $a+b$', '',
  '后段落收尾文字一行。', ''].join('\n');

// ─── 页内工具（装进编辑器 iframe；标记画法沿用 probe-r1-caret 的 __pr/__r1 口径） ─────────
const HELPERS = `window.__r2c = (() => {
  const surface = () => document.querySelector('.vditor-ir .vditor-reset');
  // 分层顺序有讲究：代码块的源码 pre 自带 vditor-ir__marker 类，必须先把"代码"认出来再落到
  // 围栏，否则源码会被错报成围栏；反过来行内公式的 $ 围栏（span.vditor-ir__marker，无 data-type）
  // 不在 code-block 宿主里，照旧落到围栏——此前漏了 .vditor-ir__marker 类，把 $ 报成"正文"。
  const layerOf = at => !at ? '?' :
    at.closest && at.closest('code[data-type]') ? '源码'
    : at.closest && at.closest('.vditor-ir__preview') ? '预览'
    : at.closest && at.closest('pre.vditor-ir__marker--pre,[data-type="code-block"]') ? '代码'
    : at.closest && at.closest('.vditor-ir__marker,[data-type$="-marker"]') ? '围栏'
    : at.closest && at.closest('td,th') ? '表格'
    : at.closest && at.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote') ? '正文' : '元素级';
  const mark = list => {
    const old = document.getElementById('__r2c_marks');
    if (old) old.remove();
    if (!list || !list.length) return 0;
    const layerNode = document.createElement('div');
    layerNode.id = '__r2c_marks';
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
  const unmark = () => { const old = document.getElementById('__r2c_marks'); if (old) old.remove(); return 1; };
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
  /** 光标落在哪个"行"上：代码块里报（宿主=code-block + 源码行号/行文本），否则报所在段落标题。
   *  行号按"光标之前的换行数"算——这是用户看见的源码行，与渲染无关。
   *  宿主结构（lute 实产 DOM）：div[data-type="code-block"] > span(开/闭围栏+info) +
   *  pre.vditor-ir__marker--pre > code.language-js。三个坑：
   *   ① 源码 code 没有 data-type（class 只有 language-*），只能从源码 pre 里取；
   *   ② lute 在源码尾部多写一个换行（"…c = 3;\n</code>"），总行数要削掉它，
   *      光标落到这个尾部换行之后仍算最后一行（0 基行号不越界）；
   *   ③ 光标可能在源码 pre 的元素级位置（pre/code 的 childIndex），range 取"源码起点→光标"
   *      的文本再数换行，text 节点与元素级两种容器都成立；不在源码里（站围栏/info）时
   *      行号必须报 null，不许拿空 before 报 0。 */
  const 行Of = () => {
    const s = getSelection();
    if (!s || !s.rangeCount) return null;
    const n = s.focusNode, o = s.focusOffset;
    const at = n.nodeType === 3 ? n.parentElement : n;
    const 源pre = at && at.closest ? at.closest('pre.vditor-ir__marker--pre') : null;
    const 块 = at && at.closest ? at.closest('[data-type="code-block"]') : null;
    if (块 || (源pre && 源pre.closest('[data-type="code-block"]'))) {
      const host = 块 || 源pre.closest('[data-type="code-block"]');
      const src = (源pre && (源pre.querySelector('code') || 源pre))
        || host.querySelector('pre.vditor-ir__marker--pre code')
        || host.querySelector('code[data-type="code-block"]')
        || host.querySelector('pre.vditor-ir__marker--pre') || null;
      if (src) {
        const scope = (src === n || src.contains(n)) ? src
          : (源pre && (源pre === n || 源pre.contains(n)) ? 源pre : null);
        let before = null;
        if (scope) {
          try {
            const r = document.createRange();
            r.selectNodeContents(scope);
            r.setEnd(n, Math.min(o, n.nodeType === 3 ? n.length : n.childNodes.length));
            before = r.toString();
          } catch (e) { before = null; }
        }
        const raw = String(src.textContent);
        const text = raw.endsWith('\\n') ? raw.slice(0, -1) : raw;   // 削掉 lute 尾部多写的一个换行
        const lines = text.split('\\n');
        let 号 = null;
        if (before !== null) {
          号 = (before.match(/\\n/g) || []).length;
          if (号 >= lines.length) 号 = lines.length - 1;            // 站在尾部换行之后仍是最后一行
        }
        return { 宿主: 'code-block', 在源码: scope !== null,
          行号: 号, 行文本: 号 !== null && lines[号] !== undefined ? lines[号].slice(0, 36) : null,
          总行数: lines.length };
      }
      return { 宿主: 'code-block', 在源码: false, 行号: null, 行文本: null };
    }
    const p = at && at.closest ? at.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote') : null;
    return { 宿主: p ? p.nodeName : (at ? at.nodeName : '?'),
      在源码: false, 行号: null, 行文本: p ? String(p.textContent).slice(0, 24) : null };
  };
  /** 行内公式定位/几何：源码为指定文本的 owner 盒、渲染盒、展开态。 */
  const 公式 = src => {
    for (const owner of surface().querySelectorAll('.vditor-ir__node[data-type="inline-node"]')) {
      const code = owner.querySelector('code[data-type="math-inline"]');
      if (!code || String(code.textContent).replace(/\\s/g, '') !== src) continue;
      owner.scrollIntoView({ block: 'center', behavior: 'instant' });
      const b = owner.getBoundingClientRect();
      return { 有: true, 展开: owner.classList.contains('vditor-ir__node--expand'),
        盒: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
        中心: { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + Math.min(b.height / 2, 14)) } };
    }
    return { 有: false };
  };
  /** 标题块判定：focus 是否在含公式（源码=src）的那个标题里；顺带报它前后的段落（红形状的证据）。
   *  文档里有两个 h1（题目 + 「# $a+b$」），querySelector('h1') 拿的是第一个（题目），
   *  把焦点留在测试标题上也会误报 在标题=false——必须认"含这条公式"的那个标题。 */
  const 所在块 = src => {
    const s = getSelection();
    if (!s || !s.rangeCount) return null;
    const n = s.focusNode;
    let 标题 = null;
    for (const owner of surface().querySelectorAll('.vditor-ir__node[data-type="inline-node"]')) {
      const code = owner.querySelector('code[data-type="math-inline"]');
      if (code && String(code.textContent).replace(/\\s/g, '') === src) {
        标题 = owner.closest('h1,h2,h3,h4,h5,h6'); break;
      }
    }
    const 前段 = [...surface().children].find(b => b.textContent.includes('前段落'));
    const 后段 = [...surface().children].find(b => b.textContent.includes('后段落'));
    const 宿主el = (n.nodeType === 3 ? n.parentElement : n);
    const 实际 = 宿主el && 宿主el.closest ? 宿主el.closest('h1,h2,h3,h4,h5,h6,p,li,blockquote') : null;
    return { 标题文本: 标题 ? String(标题.textContent).slice(0, 20) : null,
      在标题: !!(标题 && (标题 === n || 标题.contains(n))),
      在前段: !!(前段 && (前段 === n || 前段.contains(n))),
      在后段: !!(后段 && (后段 === n || 后段.contains(n))),
      实际宿主: 实际 ? 实际.nodeName : (宿主el ? 宿主el.nodeName : '?') };
  };
  return { caret, mark, unmark, 行Of, 公式, 所在块 };
})();`;

const INSTALL = `(() => { const w = ${hi.IF};
  if (!w || !w.document.querySelector('${hi.SURFACE}')) return { ok: false };
  if (!w.__r2c) w.eval(${JSON.stringify(HELPERS)});
  return { ok: !!w.__r2c }; })()`;
const IN = expression => `(() => { const w = ${hi.IF}; return w.eval(${JSON.stringify(expression)}); })()`;
const readCaret = session => session.js(IN('window.__r2c.caret()'));
const read行 = session => session.js(IN('window.__r2c.行Of()'));
const caretMark = r => (r && r.可见) ? [{ x: r.x, y: r.y, h: r.h, color: '#ff2d2d', label: '光标' }] : [];
const frameOf = session => session.js(`(() => { const f = document.getElementById('editor');
  const r = f.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()`);
const key = async (session, name, vk, wait = 330) => {
  await session.key({ key: name, code: name, vk });
  await harness.sleep(wait);
};
const focusOK = async session => (await hi.ensureFocus(session)).ok;

/** 整页 + 光标附近 2x 放大截图（anchor/marks 都是 iframe 内坐标，clip 才加 iframe 偏移）。 */
async function shots(session, frame, name, anchor, marks) {
  try {
    const clip = { x: frame.x + Math.max(0, (anchor && anchor.x || 300) - 240),
      y: frame.y + Math.max(0, (anchor && anchor.y || 300) - 55), width: 560, height: 165, scale: 2 };
    if (marks && marks.length) await session.js(IN('window.__r2c.mark(' + JSON.stringify(marks) + ')'));
    const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(OUT, name + '-2x.png'), Buffer.from(shot.data, 'base64'));
    await session.js(IN('window.__r2c.unmark()'));
    await session.shot(name + '-full');
  } catch (error) { console.log('  （截图失败 ' + name + '：' + String(error && error.message || error).slice(0, 120) + '）'); }
}

/** 连发行走并记录每一拍：{步, 行读数, 光标读数}。--trace 时附带纵向补丁的决策轨迹
 *  （window.__vtrace：scan/resolve/code行 的 pushTrace 环形缓冲，取每拍尾部 16 条）。 */
const TRACE = !!process.argv.find(a => a === '--trace');
async function 走(session, keyName, vk, times) {
  const steps = [];
  for (let i = 0; i < times; i++) {
    if (TRACE) await session.js(IN('window.__vertTraceOn = true; window.__vtrace = [];'));
    await session.key({ key: keyName, code: keyName, vk });
    await harness.sleep(330);
    const step = { 步: i + 1, 行: await read行(session), 光标: await readCaret(session) };
    if (TRACE) step.轨迹 = (await session.js(IN('window.__vtrace || []'))).slice(-16);
    steps.push(step);
  }
  if (TRACE) await session.js(IN('window.__vertTraceOn = false;'));
  return steps;
}
const 摘要 = steps => steps.map(s => ({
  步: s.步, 宿主: s.行 && s.行.宿主, 行号: s.行 && s.行.行号, 在源码: s.行 && s.行.在源码,
  行文本: s.行 && s.行.行文本, y: s.光标 && s.光标.y, 可见: s.光标 && s.光标.可见,
  ...(s.轨迹 ? { 轨迹: s.轨迹 } : {}) }));

/** 逐行性判定：代码行落点必须按 0,1,2…顺序一个一个出现（不跳行、不缺行、都在源码里），
 *  走完代码块以后要落到代码块外的段落上。 */
function 判逐行(steps, 期望代码行数, 尾段关键词) {
  const 序列 = steps.map(s => s.行).filter(Boolean);
  const 代码落点 = 序列.filter(r => r.宿主 === 'code-block' && r.在源码).map(r => r.行号);
  const 按序 = 代码落点.every((号, i) => 号 === i);            // 0,1,2,…严格挨着来
  const 全到 = 代码落点.length === 期望代码行数;
  const 出块 = 序列.some(r => r.宿主 !== 'code-block' && r.行文本 && r.行文本.includes(尾段关键词));
  return { 代码落点, 按序, 全到, 出块, 过: 按序 && 全到 && 出块 };
}

// ─── 用例 ───────────────────────────────────────────────────────────────────────

/** L1a：段+3行代码块+段，连发 ↓ 逐行落源码行；再从尾段连发 ↑ 回程同样。 */
async function caseL1a(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点' } };
  const placed = await session.js(hi.placeAfterPrefix('首段起点'));
  if (!placed || !placed.ok) return { verdict: 'FAIL', detail: { 阶段: '定位', placed } };
  await harness.sleep(120);
  const start = await readCaret(session);
  await shots(session, frame, 'L1a-起点', start, caretMark(start));
  const 下 = await 走(session, 'ArrowDown', 40, 5);            // 首段→3行代码→尾段（5 拍走完）
  const last下 = 下[下.length - 1];
  await shots(session, frame, 'L1a-下行末', last下.光标.可见 ? last下.光标 : start, caretMark(last下.光标));
  const 判下 = 判逐行(下, 3, '尾段承接');
  // ↑ 回程：从当前位置（应在尾段）往回走 5 拍回首段
  const 上 = await 走(session, 'ArrowUp', 38, 5);
  const 判上 = (() => {
    const 序列 = 上.map(s => s.行).filter(Boolean);
    const 代码落点 = 序列.filter(r => r.宿主 === 'code-block' && r.在源码).map(r => r.行号);
    const 期望 = [2, 1, 0];                                    // 回程从最后一行往回
    const 按序 = 代码落点.every((号, i) => 号 === 期望[i]);
    const 全到 = 代码落点.length === 3;
    const 回段 = 序列.some(r => r.宿主 !== 'code-block' && r.行文本 && r.行文本.includes('首段起点'));
    return { 代码落点, 按序, 全到, 回段, 过: 按序 && 全到 && 回段 };
  })();
  return { verdict: 判下.过 && 判上.过 ? 'PASS' : 'FAIL', detail: {
    起点: start, 下行: 摘要(下), 上行: 摘要(上), 判下, 判上,
    红: '旧版 ↓ 从首段直接落到尾段（代码落点=[]），或跳行（落点 0,2）；↑ 回程同样跳过整块' } };
}

/** L1b：15 行高块连发 ↓ 不吞键——每一按都要前进一行，直到穿出块落进下方段落。 */
async function caseL1b(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点' } };
  const placed = await session.js(hi.placeAfterPrefix('上方段落起点'));
  if (!placed || !placed.ok) return { verdict: 'FAIL', detail: { 阶段: '定位', placed } };
  await harness.sleep(120);
  const start = await readCaret(session);
  const 步 = await 走(session, 'ArrowDown', 40, 18);            // 1 拍进块 + 14 拍行进 + 穿出落尾段
  const last = 步[步.length - 1];
  await shots(session, frame, 'L1b-穿出后', last.光标.可见 ? last.光标 : start, caretMark(last.光标));
  const 序列 = 步.map(s => s.行).filter(Boolean);
  const 代码落点 = 序列.filter(r => r.宿主 === 'code-block' && r.在源码).map(r => r.行号);
  const 覆盖 = new Set(代码落点);
  const 全到 = [...Array(15).keys()].every(i => 覆盖.has(i));
  // 吞键判定：相邻两拍读数完全相同、而此时还没到块内最后一行（还有行可走）→ 有按不动的拍
  const 卡点 = [];
  for (let i = 1; i < 序列.length; i++) {
    const a = 序列[i - 1], b = 序列[i];
    if (a.宿主 !== 'code-block' || !a.在源码) continue;
    if (b.宿主 === a.宿主 && b.在源码 && b.行号 === a.行号 && a.行号 < 14) 卡点.push({ 步: i + 1, 行号: a.行号 });
  }
  const 出块 = 序列.some(r => r.宿主 !== 'code-block' && r.行文本 && r.行文本.includes('下方段落'));
  return { verdict: 全到 && !卡点.length && 出块 ? 'PASS' : 'FAIL', detail: {
    起点: start, 行走: 摘要(步), 代码落点, 全到, 卡点, 出块,
    红: '旧版 ↓ 在块上原地不动（卡点非空：行号连续重复且 <14），或整块被跳过（代码落点=[]）' } };
}

/** L3：`# $a+b$` 标题（整行只有一条公式）里按 Home，光标要留在本行（不被邻行兜底踢出去）。 */
async function caseL3(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点' } };
  const geo = await session.js(IN('window.__r2c.公式("a+b")'));
  if (!geo || !geo.有) return { verdict: 'FAIL', detail: { 阶段: '没找到公式 $a+b$', geo } };
  // ① 真实点渲染结果：源码展开、光标进源码（这是按 Home 的自然起手）
  await session.click(frame.x + geo.中心.x, frame.y + geo.中心.y);
  await harness.sleep(700);
  const 展开 = await session.js(IN('window.__r2c.公式("a+b")'));
  const start = await readCaret(session);
  if (!展开.展开 || start.层 !== '源码') {
    await shots(session, frame, 'L3-未展开', start.可见 ? start : geo.中心, caretMark(start));
    return { verdict: 'FAIL', detail: { 阶段: '点击后公式没展开/光标没进源码', 公式: 展开, 光标: start } };
  }
  await shots(session, frame, 'L3-展开起点', start, [...caretMark(start),
    { x: geo.中心.x, y: geo.中心.y, h: 22, dash: true, color: '#25d0ff', label: '点击处' }]);
  // ② 真实 Home：Vditor 的落点若坏（进 # 标记/隐形），校正层要么行端要么本行合法落点，都不许出本行
  await key(session, 'Home', 36, 650);
  const now = await readCaret(session);
  const 块 = await session.js(IN('window.__r2c.所在块("a+b")'));   // 含公式的那一个 h1（文档里有两个 h1）
  await shots(session, frame, 'L3-Home后', now.可见 ? now : start,
    [...caretMark(now), { x: 0, y: now.y || (start && start.y) || 100, h: 22, dash: true, color: '#f0a020', label: '本行行首方向' }]);
  const 留本行 = !!(块 && 块.在标题) && !(块.在前段 || 块.在后段);
  return { verdict: 留本行 ? 'PASS' : 'FAIL', detail: {
    公式: 展开, 起点: start, Home后: now, 所在块: 块,
    红: '旧版邻行兜底把光标踢出标题行：所在块.在标题=false（落进前段落行尾/后段落行首）' } };
}

// ─── 装配 ───────────────────────────────────────────────────────────────────────

const GROUPS = [
  { doc: 'r2-doc-code3.md', content: DOC1, cases: [['L1a', caseL1a]] },
  { doc: 'r2-doc-code15.md', content: DOC2, cases: [['L1b', caseL1b]] },
  { doc: 'r2-doc-heading.md', content: DOC3, cases: [['L3', caseL3]] },
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
    launch: options => harness.launch({ exe: EXE, appArgs: [APP_MAIN], label: 'probe-r2-code',
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
})().catch(error => { console.error('probe-r2-code 失败：', error); process.exit(1); });
