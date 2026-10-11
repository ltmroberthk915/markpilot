/** 边缘用例套件（70–73）共用的取证工具。
 *
 *  这一套的场景都遵循同样的取证纪律：
 *    · 动作一律走真实输入（CDP 鼠标/键盘/IME 上屏通道），不调用产品内部函数；
 *    · 判据一律是"用户看得见/磁盘上有的东西"——真实 DOM 的几何与属性、磁盘字节；
 *    · 每个动作之后都检查错误面（页面内 toast、console 报错、异常）；
 *    · 坐标换算只做一次：iframe 内的元素坐标 + iframe 自身偏移 = 顶层页坐标，
 *      CDP 的鼠标事件打在外壳页上。
 */
'use strict';
const fs = require('node:fs');
const harness = require('./harness.cjs');

/** 编辑面：文档里还有一个空的 `.vditor-reset`，先匹配到它就会误判成"内容没上屏"。 */
const SURFACE = '.vditor-ir .vditor-reset';

/** iframe 内求值 + 折算成顶层页坐标。`finder` 是一段求值为元素的表达式。 */
const pointOf = finder => `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const doc = w && w.document;
  const node = (${finder});
  if (!node) return {ok: false, error: '找不到目标元素'};
  if (node.scrollIntoView) node.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
  const frameRect = frame.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  const viewport = {width: w.innerWidth, height: w.innerHeight};
  return {ok: true, x: Math.round(frameRect.x + rect.x + rect.width / 2), y: Math.round(frameRect.y + rect.y + rect.height / 2),
    width: Math.round(rect.width), height: Math.round(rect.height),
    visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < viewport.height && rect.right > 0 && rect.left < viewport.width,
    viewport};
})()`;

/** 页面内右键菜单（产品自己的 DOM 菜单，不是原生菜单），带坐标。 */
const MENU_ITEMS = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const doc = w && w.document;
  const menu = doc ? doc.querySelector('.typora-editor-context-menu') : null;
  if (!menu) return {open: false, items: []};
  const frameRect = frame.getBoundingClientRect();
  return {open: true, items: [...menu.querySelectorAll('button')].map(button => {
    const rect = button.getBoundingClientRect();
    return {action: button.dataset.action, label: button.textContent,
      x: Math.round(frameRect.x + rect.x + rect.width / 2), y: Math.round(frameRect.y + rect.y + rect.height / 2)};
  })};
})()`;

/** 右键 → 菜单里点某个动作。返回 {opened, items, label, attempts, tries}。 */
async function menuClick(session, finder, action, { attempts = 3, wait = 900 } = {}) {
  return menuClickWhere(session, pointOf(finder), action, { attempts, wait });
}

/** 同上，但调用方直接给"iframe 坐标系里的点"表达式。用于"在选区上右键"这种操作：
 *  右键必须落在选区内部——落在选区外，Chromium 会把光标挪过去、选区塌掉，于是
 *  剪切/复制变成对空选区的操作（本轮就是这么把"剪切"误判成产品不工作的）。 */
async function menuClickPoint(session, pointExpression, action, options = {}) {
  return menuClickWhere(session, pointExpression, action, options);
}

async function menuClickWhere(session, pointExpression, action, { attempts = 3, wait = 900 } = {}) {
  const tries = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const point = await session.js(pointExpression);
    tries.push(point);
    if (point && point.ok) {
      await session.move(point.x, point.y);
      await harness.sleep(90);
      await session.click(point.x, point.y, { button: 'right' });
    }
    let menu = { open: false, items: [] };
    for (let round = 0; round < 8; round++) {
      await harness.sleep(120);
      menu = await session.js(MENU_ITEMS);
      if (menu.open) break;
    }
    if (!menu.open) { await session.key({ key: 'Escape', code: 'Escape', vk: 27 }); await harness.sleep(120); continue; }
    const item = (menu.items || []).find(entry => entry.action === action);
    if (!item) return { opened: true, items: menu.items, label: null, attempts: attempt, tries, missing: action };
    await session.click(item.x, item.y);
    await harness.sleep(wait);
    return { opened: true, items: menu.items, label: item.label, attempts: attempt, tries };
  }
  return { opened: false, items: [], label: null, attempts, tries };
}

/** 选区中心的顶层页坐标（"在选中的文字上右键"这类真实操作要用它）。 */
const selectionPoint = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const selection = w && w.getSelection ? w.getSelection() : null;
  if (!selection || !selection.rangeCount || selection.isCollapsed) return {ok: false, error: '没有非折叠选区'};
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (!rect.width || !rect.height) return {ok: false, error: '选区没有几何'};
  const frameRect = frame.getBoundingClientRect();
  return {ok: true, x: Math.round(frameRect.x + rect.left + rect.width / 2), y: Math.round(frameRect.y + rect.top + rect.height / 2),
    text: selection.toString().slice(0, 40)};
})()`;

/** 首屏之后的预热/公式队列安静下来。 */
const SETTLE = `(async () => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const start = performance.now();
  let quiet = performance.now(), last = -1;
  while (performance.now() - start < 15000) {
    await new Promise(resolve => requestAnimationFrame(resolve));
    const warm = w && w.__typoraWarmup;
    const queued = warm && typeof warm.queued === 'number' ? warm.queued : 0;
    const math = w && w.__typoraMathStats;
    const pending = math && typeof math.pending === 'number' ? math.pending : 0;
    const nodes = w && w.document ? w.document.querySelectorAll('*').length : 0;
    if (queued === 0 && pending === 0 && nodes === last && nodes > 0) {
      if (performance.now() - quiet > 400) return Math.round(performance.now() - start);
    } else { quiet = performance.now(); last = nodes; }
  }
  return -1;
})()`;
const settle = session => session.js(SETTLE);

/** 错误面：任何一条命中都算用户看得见的故障。 */
const errorsOf = text => {
  const problems = [];
  if (!text) return problems;
  if (/\uFFFD/.test(text)) problems.push('含替换字符（编码解码坏了）');
  if (/-File\s/.test(text)) problems.push('含 PowerShell 用法文本');
  if (/app\.asar/i.test(text)) problems.push('含 app.asar 虚拟路径');
  if (/失败|错误|无法|无效|不能|不支持|超时/.test(text)) problems.push('含失败/错误提示');
  return problems;
};

/** 剪贴板证人要轮询：写剪贴板走的是 PowerShell（Add-Type 首次要 1–2s），
 *  点完菜单立刻读会读到用户原来的内容——这是本轮"复制表格"假失败的真正原因。 */
async function readClipboardUntil(dir, predicate, { timeout = 12000, interval = 600 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    try { last = harness.readClipboard(dir); } catch (error) { last = { error: String(error.message) }; }
    try { if (last && predicate(last)) return {...last, waitedMs: Date.now() - started}; } catch { /* 谓词自己抛错就继续等 */ }
    await harness.sleep(interval);
  }
  return {...(last || {}), timedOut: true, waitedMs: Date.now() - started};
}

/** 表格块（锚点所在的连续 `|` 行）与它的分隔行片段数——Lute 保存时会按列宽重排
 *  破折号数量，所以不能拿 `| --- |` 这种固定形态去比。 */
function tableBlock(text, anchor = '甲') {
  const lines = String(text).split('\n');
  const at = lines.findIndex(line => line.trim().startsWith('|') && line.includes(anchor));
  if (at < 0) return [];
  let start = at, end = at;
  while (start > 0 && lines[start - 1].trim().startsWith('|')) start--;
  while (end + 1 < lines.length && lines[end + 1].trim().startsWith('|')) end++;
  return lines.slice(start, end + 1);
}
const separatorSegments = line => String(line).split('|').filter(part => part.trim()).length;

/** 装一次 toast 观察器（window 级捕获）：产品会 stopImmediatePropagation，所以
 *  不能只挂在 body 上等冒泡。 */
const WATCH_TOASTS = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  if (w.__edgeToasts) { w.__edgeToasts.length = 0; return true; }
  w.__edgeToasts = [];
  const record = node => {
    if (node.nodeType !== 1) return;
    const hit = node.matches && node.matches('.typora-context-toast, .media-error') ? [node] : [...(node.querySelectorAll ? node.querySelectorAll('.typora-context-toast, .media-error') : [])];
    for (const item of hit) w.__edgeToasts.push(item.textContent);
  };
  const observer = new MutationObserver(records => { for (const item of records) for (const node of item.addedNodes) record(node); });
  observer.observe(w.document.body, {childList: true, subtree: true});
  return true;
})()`;
const TOASTS = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const doc = w && w.document;
  return {recorded: w && w.__edgeToasts ? [...w.__edgeToasts] : [],
    live: doc ? [...doc.querySelectorAll('.typora-context-toast, .media-error')].map(node => node.textContent) : []};
})()`;

/** 存盘：真实 Ctrl+S，然后等磁盘真的变了（产品自报不算数）。 */
async function saveAndWait(session, file, { timeout = 6000, interval = 120 } = {}) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const started = Date.now();
  await session.chord('s', 'KeyS', 83);
  let chordTook = false;
  while (Date.now() - started < timeout) {
    await harness.sleep(interval);
    const now = fs.readFileSync(file, 'utf8');
    if (now !== before) { chordTook = true; break; }
  }
  if (!chordTook) {
    // 键盘通道没送到就退到主进程的同一条保存命令（用户菜单里的"保存"），
    // 并且如实记账：这一步不是按键路径。
    // 传输层出错（目标已关/超时）不能让它冒泡：一次死目标会挂满 60 秒再抛，把断言全过的
    // 场景判失败（实测：场景 76 105/105 断言全过却报 CDP 超时）。这里记下来、不抛——
    // 后面按磁盘内容比较，落盘没发生自然会让调用方的断言失败，那才是可操作的信号。
    let fallbackError = null;
    try { await session.jsSoft(`hostApi.invoke('save')`); }
    catch (error) { fallbackError = String((error && error.message) || error).split('\n')[0]; }
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await harness.sleep(interval);
      if (fs.readFileSync(file, 'utf8') !== before) break;
    }
    return { before, after: fs.readFileSync(file, 'utf8'), chordTook, fallbackError, waitedMs: Date.now() - started };
  }
  return { before, after: fs.readFileSync(file, 'utf8'), chordTook, waitedMs: Date.now() - started };
}

/** 等磁盘出现/消失某个串（用于"保存之后磁盘必须变"的判据）。 */
async function waitDisk(file, predicate, { timeout = 8000, interval = 120 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const text = fs.readFileSync(file, 'utf8');
    if (predicate(text)) return {ok: true, text, waitedMs: Date.now() - started};
    await harness.sleep(interval);
  }
  return {ok: false, text: fs.readFileSync(file, 'utf8'), waitedMs: Date.now() - started};
}

/** 表格事实：行列数、单元格文本，直接读真实 DOM。 */
const TABLE_FACTS = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const doc = w && w.document;
  const surface = doc.querySelector(${JSON.stringify(SURFACE)});
  if (!surface) return null;
  const tables = [...surface.querySelectorAll('table')].map(table => ({
    rows: table.querySelectorAll('tr').length,
    cells: [...table.querySelectorAll('tr')].map(row => row.querySelectorAll('td,th').length),
    text: table.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200),
  }));
  return {tables, surfaceText: surface.textContent.replace(/\\s+/g, ' ').trim()};
})()`;

module.exports = { SURFACE, pointOf, selectionPoint, MENU_ITEMS, menuClick, menuClickPoint, settle, SETTLE, errorsOf, WATCH_TOASTS, TOASTS, saveAndWait, waitDisk, TABLE_FACTS, readClipboardUntil, tableBlock, separatorSegments };
