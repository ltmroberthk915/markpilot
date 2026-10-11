/** 拟人输入补充套件（human-input supplement）共用的输入原语与读数。
 *
 *  与 scripts/acceptance/（DeepSeek 会话主责目录）的关系：**只 require、绝不修改**那边
 *  的任何文件；本套件全部产物写 .perf/human-input/，不碰 .perf/acceptance/。
 *
 *  复用 acceptance 的 CDP 基座（harness.cjs：launch / 真实键鼠 / 剪贴板 / 主进程证人），
 *  补上验收侧一直缺的三类"拟人"原语：
 *    · 按住不放：rawKeyDown 与 keyUp 分离，支持 autoRepeat 连发（键盘长按）；
 *    · 任意组合键：Ctrl+Shift+Alt+主键，修饰键真实按下再抬起（与真人指法一致）；
 *    · 统一拖拽：mousePressed → N 步 mouseMoved(buttons:1) → mouseReleased。
 *  另附：光标/选区几何读数（READ_CARET）、全文前缀读数（CARET_PREFIX）、DOM 指纹、
 *  逐字符盒（点击矩阵的独立口径）、固定种子随机、素材房（writeDoc/copyProtected）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('../acceptance/harness.cjs');
const fixtures = require('../acceptance/fixtures.cjs');
const edge = require('../acceptance/edge-helpers.cjs');

const SURFACE = '.vditor-ir .vditor-reset';
const IF = `document.getElementById('editor').contentWindow`;
const ROOM = path.join(harness.project, '.perf/human-input/fixtures');
const PROTECTED = 'E:/MarkPilot/测试素材_每次使用需复制用后需删除试验副本';

// ─── 键码 ─────────────────────────────────────────────────────────────────────
const LETTER_VK = {}; for (let c = 65; c <= 90; c++) LETTER_VK[String.fromCharCode(c)] = c;
const DIGIT_VK = {}; for (let d = 0; d <= 9; d++) DIGIT_VK[String(d)] = 48 + d;
const EXTRA_VK = { F3: 114, PageUp: 33, PageDown: 34, Control: 17, Shift: 16, Alt: 18, Meta: 91 };
const vkOf = key => harness.VK[key] ?? LETTER_VK[key] ?? DIGIT_VK[key] ?? EXTRA_VK[key] ?? 0;
const CODE_NAMES = { Control: 'ControlLeft', Shift: 'ShiftLeft', Alt: 'AltLeft', Meta: 'MetaLeft' };
const codeOf = key => CODE_NAMES[key] || (/^[0-9]$/.test(key) ? 'Digit' + key : /^[A-Z]$/.test(key) ? 'Key' + key : key);

// ─── 键盘原语：down/up 分离 + 长按连发 + 任意组合键 ─────────────────────────────
function keyEvent(session, type, key, { modifiers = 0, autoRepeat = false, text = null } = {}) {
  const params = { type, key, code: codeOf(key), windowsVirtualKeyCode: vkOf(key), nativeVirtualKeyCode: vkOf(key), modifiers };
  if (autoRepeat) params.autoRepeat = true;
  if (type === 'char' && text != null) { params.text = text; params.unmodifiedText = text; }
  return session.send('Input.dispatchKeyEvent', params);
}
const keyDown = (session, key, options = {}) => keyEvent(session, 'rawKeyDown', key, options);
const keyUp = (session, key, options = {}) => keyEvent(session, 'keyUp', key, options);

/** 单键完整按压（down→up）。带 text 时按 IME char 通道补一发（字母/数字才有意义）。 */
async function press(session, key, options = {}) {
  await keyDown(session, key, options);
  if (options.text) await keyEvent(session, 'char', key, { ...options, text: options.text });
  await keyUp(session, key, options);
}

/** 按住不放：首次按下 + (times-1) 次 autoRepeat 连发 + 抬起——键盘长按的唯一真通道。
 *  onEvery: {every: n, run: async (i)=>{}} 每连发 n 次回调一次，用于中途采样。 */
async function hold(session, key, { times = 10, interval = 55, modifiers = 0, onEvery = null } = {}) {
  if (times < 1) throw new Error('hold times 必须 ≥1');
  await keyDown(session, key, { modifiers });
  for (let i = 1; i < times; i++) {
    await harness.sleep(interval);
    await keyDown(session, key, { modifiers, autoRepeat: true });
    if (onEvery && i % onEvery.every === 0) await onEvery.run(i);
  }
  await keyUp(session, key, { modifiers });
}

const MOD_KEYS = [['Ctrl', 'Control', harness.MOD.ctrl], ['Alt', 'Alt', harness.MOD.alt], ['Shift', 'Shift', harness.MOD.shift], ['Meta', 'Meta', harness.MOD.meta]];
function parseCombo(combo) {
  const parts = combo.split('+');
  const key = parts.pop();
  const flags = {};
  for (const part of parts) {
    const name = part.toLowerCase();
    if (!['ctrl', 'alt', 'shift', 'meta'].includes(name)) throw new Error('未知修饰键：' + part);
    flags[name] = true;
  }
  const modifiers = (flags.ctrl ? harness.MOD.ctrl : 0) | (flags.alt ? harness.MOD.alt : 0) | (flags.shift ? harness.MOD.shift : 0) | (flags.meta ? harness.MOD.meta : 0);
  return { key, modifiers, mods: MOD_KEYS.filter(([name]) => flags[name.toLowerCase()]) };
}

/** 任意组合键（如 'Ctrl+Shift+E'、'Ctrl+Alt+V'）：修饰键逐个真实按下 → 主键 ↓↑ → 修饰键
 *  逆序抬起。产品侧 fromEvent/浏览器都读事件上的修饰位，这条链路与真人完全一致。 */
async function combo(session, comboSpec) {
  const { key, modifiers, mods } = parseCombo(comboSpec);
  for (const [, keyName] of mods) await keyDown(session, keyName, { modifiers });
  await keyDown(session, key, { modifiers });
  await keyUp(session, key, { modifiers });
  for (let i = mods.length - 1; i >= 0; i--) await keyUp(session, mods[i][1], { modifiers });
}

// ─── 鼠标原语：统一拖拽 ────────────────────────────────────────────────────────
/** 拖拽：mousePressed → steps 次 mouseMoved(buttons:1) → mouseReleased。
 *  这是"按下 → 多次移动 → 抬起"的真人手势；没有它就只能是两次无关的点击。 */
async function drag(session, from, to, { steps = 8, interval = 40, after = 260, modifiers = 0 } = {}) {
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, modifiers });
  for (let step = 1; step <= steps; step++) {
    await harness.sleep(interval);
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 1, modifiers,
      x: Math.round(from.x + (to.x - from.x) * step / steps),
      y: Math.round(from.y + (to.y - from.y) * step / steps) });
  }
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, modifiers });
  await harness.sleep(after);
}

/** 多途经点拖拽（模拟手抖拐弯）：points 为顶层页坐标数组，逐段插值走过去。 */
async function dragPath(session, points, { stepsPerLeg = 4, interval = 40, after = 260 } = {}) {
  if (points.length < 2) throw new Error('dragPath 至少两个点');
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: points[0].x, y: points[0].y, button: 'left', buttons: 1, clickCount: 1 });
  for (let leg = 1; leg < points.length; leg++) {
    const from = points[leg - 1], to = points[leg];
    for (let step = 1; step <= stepsPerLeg; step++) {
      await harness.sleep(interval);
      await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 1,
        x: Math.round(from.x + (to.x - from.x) * step / stepsPerLeg),
        y: Math.round(from.y + (to.y - from.y) * step / stepsPerLeg) });
    }
  }
  const last = points[points.length - 1];
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1 });
  await harness.sleep(after);
}

// ─── 读数：光标 / 选区 / 焦点 / 指纹 / 源码 ───────────────────────────────────
/** 光标与选区事实：在哪一块、哪一层（正文/源码/预览/围栏）、偏移、几何。
 *  前缀 = 光标所在文字节点内、光标之前的 20 个字符（快速判"落点对不对"）。 */
const READ_CARET = `(() => { const w = ${IF}; if (!w) return { none: true };
  const d = w.document; const surface = d.querySelector(${JSON.stringify(SURFACE)});
  if (!surface) return { none: true };
  const s = w.getSelection();
  if (!s || !s.rangeCount) return { none: true, surface: true };
  const r = s.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const inEditor = !!(at && surface.contains(at));
  let top = at, index = -1, text = '';
  if (inEditor) {
    while (top && top.parentElement && top.parentElement !== surface) top = top.parentElement;
    if (top && top.parentElement === surface) { index = [...surface.children].indexOf(top); text = String(top.textContent || '').replace(/\\s+/g, ' ').slice(0, 24); }
  }
  const box = r.getBoundingClientRect();
  const prefix = r.startContainer.nodeType === 3 ? r.startContainer.data.slice(Math.max(0, r.startOffset - 20), r.startOffset) : '';
  const layer = !inEditor ? '外' : at.closest('code[data-type]') ? '源码' : at.closest('.vditor-ir__preview') ? '预览' : at.closest('[data-type$="-marker"]') ? '围栏' : '正文';
  return { ok: inEditor, 块: index, 块文本: text, 层: layer, 前缀: prefix,
    偏移: r.startOffset, 容器: r.startContainer.nodeType === 3 ? 'TEXT' : r.startContainer.nodeName,
    折叠: r.collapsed, 选区: s.toString().slice(0, 80), 选区长: s.toString().length,
    x: Math.round(box.left), y: Math.round(box.top), h: Math.round(box.height) }; })()`;
const caret = session => session.js(READ_CARET);

/** 光标之前的**块内全文**（跨文字节点、含公式源码文本）——点击矩阵的独立口径用。 */
const CARET_PREFIX = `(() => { const w = ${IF}, d = w.document; const surface = d.querySelector(${JSON.stringify(SURFACE)});
  const s = w.getSelection();
  if (!surface || !s || !s.rangeCount) return null; const r = s.getRangeAt(0);
  let top = r.startContainer;
  while (top && top.parentElement && top.parentElement !== surface) top = top.parentElement;
  if (!top || top.parentElement !== surface) return null;
  const pre = d.createRange(); pre.selectNodeContents(top); pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString(); })()`;
const caretPrefix = session => session.js(CARET_PREFIX);

const FOCUS = `(() => { const f = document.getElementById('editor'); const w = f && f.contentWindow; if (!w || !w.document) return { ok: false };
  const d = w.document; const surface = d.querySelector(${JSON.stringify(SURFACE)});
  const active = d.activeElement;
  return { ok: !!surface && d.hasFocus(), hasFocus: d.hasFocus(),
    active: active ? (active.tagName + '.' + String(active.className).slice(0, 30)) : null }; })()`;

/** 焦点不在编辑器时先抢回来（surface.focus()，兜底真实点击一次编辑面）。 */
async function ensureFocus(session) {
  const before = await session.js(FOCUS);
  if (before.ok) return before;
  await session.js(`(() => { const w = ${IF}; const s = w.document.querySelector(${JSON.stringify(SURFACE)}); if (s) s.focus(); return true; })()`);
  let now = await session.js(FOCUS);
  if (!now.ok) {
    const frame = await session.js(`(() => { const f = document.getElementById('editor'); const r = f.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(r.height / 2, 300)) }; })()`);
    if (frame && frame.x) { await session.click(frame.x, frame.y); await harness.sleep(250); }
    now = await session.js(FOCUS);
  }
  return now;
}

/** DOM 指纹：文本长度 + 结构元素计数。非编辑手势期间必须纹丝不动。 */
const FINGERPRINT = `(() => { const w = ${IF}; const d = w && w.document; const s = d && d.querySelector(${JSON.stringify(SURFACE)}); if (!s) return null;
  const n = sel => s.querySelectorAll(sel).length;
  const text = s.textContent;
  return { len: text.replace(/\\s+/g, '').length, head: text.replace(/\\s+/g, '').slice(0, 30),
    strong: n('strong,b'), em: n('em,i'), u: n('u'), code: n('code'), img: n('img'),
    heading: n('h1,h2,h3,h4,h5,h6'), li: n('li'), table: n('table'), blockquote: n('blockquote') }; })()`;
const fingerprint = session => session.js(FINGERPRINT);

/** 当前 Markdown 源码（产品自己的 getValue，只作过程读数；最终判据仍以磁盘为准）。 */
const mdNow = session => session.js(`(() => { const w = ${IF}; try { return w && w.vditor ? w.vditor.getValue() : null; } catch (error) { return 'ERR:' + error.message; } })()`);

// ─── 定位：把光标/选区放到指定位置（前置设置，动作仍走真实输入） ────────────────
const placeCaretAt = (index, offset) => `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)}); const block = surface && surface.children[${index}];
  if (!block) return { ok: false, error: '没有第 ${index} 块' };
  const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node = null;
  while (walker.nextNode()) if (walker.currentNode.data.replace(/[\\s\\u200b]/g, '')) { node = walker.currentNode; break; }
  if (!node) return { ok: false, error: '这一块没有文字' };
  surface.focus();
  const r = d.createRange(); r.setStart(node, Math.min(${offset}, node.data.length)); r.collapse(true);
  const s = w.getSelection(); s.removeAllRanges(); s.addRange(r);
  return { ok: true, 文本: node.data.slice(0, 20), 长度: node.data.length }; })()`;

const placeAfterPrefix = prefix => `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)}); if (!surface) return { ok: false, error: '没有编辑面' };
  for (const block of surface.children) {
    const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node;
    while (node = walker.nextNode()) {
      const at = node.data.indexOf(${JSON.stringify(prefix)});
      if (at >= 0) { surface.focus();
        const r = d.createRange(); r.setStart(node, at + ${prefix.length}); r.collapse(true);
        const s = w.getSelection(); s.removeAllRanges(); s.addRange(r);
        return { ok: true, 块: [...surface.children].indexOf(block), 文本: node.data.slice(0, 24) }; }
    }
  }
  return { ok: false, error: '找不到前缀 ${prefix}' }; })()`;

/** 选 a 的开头到 b 的结尾（a 必须在 b 之前）。 */
const selectFromTo = (a, b) => `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)}); if (!surface) return { ok: false, error: '没有编辑面' };
  const find = prefix => { for (const block of surface.children) {
      const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node;
      while (node = walker.nextNode()) { const at = node.data.indexOf(prefix); if (at >= 0) return { node, start: at, end: at + prefix.length }; } }
    return null; };
  const A = find(${JSON.stringify(a)}), B = find(${JSON.stringify(b)});
  if (!A || !B) return { ok: false, 找到甲: !!A, 找到乙: !!B };
  surface.focus();
  const r = d.createRange(); r.setStart(A.node, A.start); r.setEnd(B.node, B.end);
  const s = w.getSelection(); s.removeAllRanges(); s.addRange(r);
  return { ok: true, 选区: s.toString() }; })()`;

// ─── 逐字符盒：点击矩阵的独立口径（不看产品落点逻辑，只看几何） ────────────────
const CHARS_OF = index => `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
  const surface = d.querySelector(${JSON.stringify(SURFACE)}); const block = surface && surface.children[${index}];
  if (!block) return { ok: false, error: '没有第 ${index} 块' };
  block.scrollIntoView({ block: 'center', behavior: 'instant' });
  const chars = []; const parts = [];
  const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node; let abs = 0;
  while (node = walker.nextNode()) {
    const parent = node.parentElement;
    const plain = parent && !(parent.closest('.vditor-ir__preview') || parent.closest('[data-type$="-marker"]'));
    for (let i = 0; i < node.data.length; i++) {
      const r = d.createRange(); r.setStart(node, i); r.setEnd(node, i + 1);
      const rect = r.getBoundingClientRect();
      if (rect.width > 0 && plain) chars.push({ ch: node.data[i], abs,
        left: Math.round(fr.x + rect.left), right: Math.round(fr.x + rect.right),
        y: Math.round(fr.y + rect.top + rect.height / 2), w: Math.round(rect.width) });
      abs += 1;
    }
    parts.push(node.data);
  }
  return { ok: true, text: parts.join(''), chars }; })()`;

/** 编辑面（surface）在顶层页里的可视矩形——混沌场景随机取点用。 */
const SURFACE_RECT = `(() => { const w = ${IF}; if (!w) return null; const s = w.document.querySelector(${JSON.stringify(SURFACE)}); if (!s) return null;
  const fr = document.getElementById('editor').getBoundingClientRect(); const r = s.getBoundingClientRect();
  const left = Math.max(fr.x + 20, fr.x + r.x + 10), top = Math.max(fr.y + 10, fr.y + r.y + 20);
  const right = Math.min(fr.x + fr.width - 20, fr.x + r.x + r.width - 10), bottom = Math.min(fr.y + fr.height - 20, fr.y + r.y + r.height - 10);
  return { left: Math.round(left), top: Math.round(top), right: Math.round(right), bottom: Math.round(bottom) }; })()`;

// ─── 素材房 / 随机 / 打开文档 ─────────────────────────────────────────────────
/** 素材全部现场生成到 .perf/human-input/fixtures/（不碰验收共用素材房）。 */
function writeDoc(name, content) {
  fs.mkdirSync(ROOM, { recursive: true });
  const file = path.join(ROOM, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}
/** 受保护真实素材：只复制副本，场景结束必须删除副本。 */
function copyProtected(name) {
  fs.mkdirSync(ROOM, { recursive: true });
  const src = path.join(PROTECTED, name);
  const dst = path.join(ROOM, '材料副本-' + name);
  fs.copyFileSync(src, dst);
  return dst;
}

/** 固定种子随机（mulberry32）：每一步都可复现。 */
const rng = seed => {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
};

const readyExpr = (minBlocks = 1) => `(() => { const w = ${IF}; if (!w) return false;
  const s = w.document.querySelector(${JSON.stringify(SURFACE)});
  return !!(s && s.children.length >= ${minBlocks} && s.textContent.trim()); })()`;

/** 打开文档并等到编辑面就绪（场景通用的 launch+until）。 */
async function openDoc(ctx, file, { minBlocks = 1, inspect = false, settleMs = 1200, timeout = 140000 } = {}) {
  const session = await ctx.launch({ args: [file], inspect });
  await session.until(readyExpr(minBlocks), { timeout, interval: 100 });
  await harness.sleep(settleMs);
  return session;
}

module.exports = {
  SURFACE, IF, ROOM, PROTECTED,
  harness, edge, fixtures,
  vkOf, codeOf, keyDown, keyUp, press, hold, combo, parseCombo,
  drag, dragPath,
  READ_CARET, caret, CARET_PREFIX, caretPrefix, FOCUS, ensureFocus,
  FINGERPRINT, fingerprint, mdNow,
  placeCaretAt, placeAfterPrefix, selectFromTo,
  CHARS_OF, SURFACE_RECT,
  writeDoc, copyProtected, rng, readyExpr, openDoc,
  sleep: harness.sleep, MOD: harness.MOD, VK: harness.VK,
};
