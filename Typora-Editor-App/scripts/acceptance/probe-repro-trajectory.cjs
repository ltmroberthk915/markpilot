/** 光标轨迹记录：一次 ← 按键之后，光标在 selectionchange 上走过哪些位置、谁动过 Selection API。
 *  用法：node scripts/acceptance/probe-repro-trajectory.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-trajectory');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;

/** 装记录器：selectionchange 时间线 + Selection API 代理（带栈）。 */
const 装 = `(() => { const w = ${IF}; const d = w.document;
  if (w.__trace) { w.__trace.log.length = 0; w.__trace.actions.length = 0; return 'reuse'; }
  const trace = w.__trace = {log: [], actions: [], t0: performance.now()};
  const 名 = node => { if (!node) return 'null';
    if (node.nodeType === 3) return '#' + String(node.data).slice(0, 10);
    const cls = (typeof node.className === 'string' ? node.className : '').split(' ').filter(Boolean).slice(0, 2).join('.');
    return node.nodeName + (cls ? '.' + cls : '') + (node.getAttribute && node.getAttribute('data-type') ? '[' + node.getAttribute('data-type') + ']' : ''); };
  const 记 = (来源) => { const sel = w.getSelection();
    const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    let rect = null;
    try { const r = at && at.getBoundingClientRect(); rect = r ? {x: Math.round(r.x), y: Math.round(r.y), h: Math.round(r.height)} : null; } catch {}
    trace.log.push({t: Math.round(performance.now() - trace.t0), 来源, 在: at ? 名(at.startContainer) : 'null',
      偏移: at ? at.startOffset : -1, 折叠: at ? at.collapsed : null, rect}); };
  d.addEventListener('selectionchange', () => 记('selectionchange'), true);
  const proto = w.Selection.prototype;
  for (const method of ['removeAllRanges', 'addRange', 'setBaseAndExtent', 'collapse', 'extend', 'collapseToEnd', 'collapseToStart']) {
    const orig = proto[method];
    if (typeof orig !== 'function') continue;
    proto[method] = function (...args) {
      let stack = '';
      try { stack = String(new Error().stack).split('\\n').slice(1, 5).map(line => line.trim().replace(/^at\\s+/, '')).join(' | '); } catch {}
      trace.actions.push({t: Math.round(performance.now() - trace.t0), method, args: args.map(a => (a && a.nodeType ? 名(a) : String(a).slice(0, 30))), stack: stack.slice(0, 400)});
      return orig.apply(this, args);
    };
  }
  return 'installed'; })()`;

const 读 = `(() => { const w = ${IF}; const d = w.document;
  const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const 链 = node => { const out = []; let cur = node;
    while (cur && out.length < 5) { const cls = (typeof cur.className === 'string' ? cur.className : '').split(' ').filter(Boolean).slice(0, 2).join('.');
      out.push(cur.nodeName + (cur.nodeType === 3 ? '("' + String(cur.data).slice(0, 8) + '")' : (cls ? '.' + cls : '')));
      cur = cur.parentNode; } return out.join(' < '); };
  return {现在: at ? {链: 链(at.startContainer), 偏移: at.startOffset, rect: box(at.getBoundingClientRect())} : null,
    轨迹: w.__trace ? w.__trace.log.slice(-14) : null,
    动作: w.__trace ? w.__trace.actions.slice(-8) : null}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'real-copy.md');
  fs.copyFileSync(SOURCE, doc);
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-trajectory', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2200);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    console.log('记录器：' + await session.js(装));
    // ===== 块公式：光标进源码 offset 1，然后按一次 ← =====
    const 块 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
      const code = [...d.querySelectorAll('code[data-type="math-block"]')].find(c => (c.textContent || '').trim() === 'ad');
      const block = code.parentElement.parentElement;
      block.scrollIntoView({block: 'center', behavior: 'instant'});
      return {块: box(block.getBoundingClientRect()), 预览: box(block.querySelector('.vditor-ir__preview').getBoundingClientRect())}; })()`);
    await session.click(frame.x + 块.预览.x + 8, frame.y + 块.预览.y + 12);
    await sleep(350);
    // 直接把光标放到源码 offset 1（点预览左侧得到 offset 0，再按 →）
    await session.key({key: 'ArrowRight', code: 'ArrowRight', vk: 39});
    await sleep(300);
    console.log('\n起点：' + JSON.stringify((await session.js(读)).现在));
    await session.js(`(() => { const w = ${IF}; w.__trace.log.length = 0; w.__trace.actions.length = 0; return 1; })()`);
    await session.key({key: 'ArrowLeft', code: 'ArrowLeft', vk: 37});
    await sleep(400);
    const 场 = await session.js(读);
    console.log('\n块：按一次 ← 之后现在：' + JSON.stringify(场.现在));
    console.log('selectionchange 轨迹：');
    for (const 项 of 场.轨迹 || []) console.log('   ' + JSON.stringify(项));
    console.log('Selection API 动作：');
    for (const 项 of 场.动作 || []) console.log('   ' + JSON.stringify(项));
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 3)));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
