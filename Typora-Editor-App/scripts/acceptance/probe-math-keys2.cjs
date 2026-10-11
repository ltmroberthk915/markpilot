/** 追捕 B：块公式闭围栏之后按 Shift+←，选区**每两下就塌一次**。
 *
 *  probe-math-keys.cjs 已经量到症状（从"闭围栏之后"起手，Shift+← 的读数在
 *  "选中 1 个字符 → 长度 0 → 又选中 1 个字符"之间来回），但读数看不出**是谁**把选区收塌的。
 *  这里给 iframe 装上三样记录器：
 *   · Selection 的 collapse / removeAllRanges / addRange / setBaseAndExtent 代理（记调用栈）
 *   · selectionchange 时间线（每次选区变动一行，含 anchor/focus 与可见文本）
 *   · keydown 的 defaultPrevented（在**冒泡**阶段读，能看到别人 prevent 过没有）
 *
 *  用法：node scripts/acceptance/probe-math-keys2.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-math-keys2');
const IF = `document.getElementById('editor').contentWindow`;

const INSTALL = `(() => { const w = ${IF}, d = w.document;
  if (w.__sel) return 'already';
  const log = w.__sel = {calls: [], changes: [], keys: []};
  const frame = () => String((new Error()).stack || '').split('\\n').slice(1, 5).map(line => line.trim().replace(/^at\\s+/, '').replace(/https?:\\/\\/[^/]+\\//, '')).join(' ← ');
  for (const name of ['collapse', 'extend', 'removeAllRanges', 'addRange', 'setBaseAndExtent', 'modify']) {
    const original = w.Selection.prototype[name];
    w.Selection.prototype[name] = function (...args) {
      log.calls.push({op: name, args: args.map(a => (a && a.nodeType ? '节点' : String(a)).toString().slice(0, 24)), stack: frame(), at: Math.round(performance.now())});
      return original.apply(this, args);
    };
  }
  d.addEventListener('selectionchange', () => {
    const s = w.getSelection();
    const describe = (node, offset) => {
      if (!node) return 'null';
      const at = node.nodeType === 3 ? node.parentElement : node;
      const path = [];
      for (let cur = at; cur && cur !== d.body; cur = cur.parentElement) path.push(cur.nodeName.toLowerCase() + (cur.dataset && cur.dataset.type ? '[' + cur.dataset.type + ']' : ''));
      return path.slice(0, 4).join('<') + (node.nodeType === 3 ? ':TEXT' : '') + '@' + offset;
    };
    log.changes.push({at: Math.round(performance.now()), n: s.rangeCount,
      collapsed: s.rangeCount ? s.getRangeAt(0).collapsed : null,
      text: s.rangeCount ? JSON.stringify(s.toString()).slice(0, 40) : null,
      anchor: s.rangeCount ? describe(s.anchorNode, s.anchorOffset) : null,
      focus: s.rangeCount ? describe(s.focusNode, s.focusOffset) : null});
  });
  d.addEventListener('keydown', event => log.keys.push({key: event.key, shift: event.shiftKey, prevented: event.defaultPrevented, at: Math.round(performance.now())}), false);
  return 'installed'; })()`;

const RESET = `(() => { const w = ${IF}; if (!w.__sel) return 'off'; w.__sel.calls = []; w.__sel.changes = []; w.__sel.keys = []; return 'cleared'; })()`;
const DUMP = `(() => { const w = ${IF}; if (!w.__sel) return null; return {calls: w.__sel.calls, changes: w.__sel.changes, keys: w.__sel.keys}; })()`;

const CARET = `(() => { const w = ${IF}, d = w.document;
  const s = w.getSelection();
  if (!s.rangeCount) return {none: true};
  const r = s.getRangeAt(0);
  const describe = (node, offset) => {
    if (!node) return 'null';
    const at = node.nodeType === 3 ? node.parentElement : node;
    const path = [];
    for (let cur = at; cur && cur !== d.body; cur = cur.parentElement) path.push(cur.nodeName.toLowerCase() + (cur.dataset && cur.dataset.type ? '[' + cur.dataset.type + ']' : ''));
    return path.slice(0, 5).join('<') + (node.nodeType === 3 ? ':TEXT' : '') + '@' + offset;
  };
  return {collapsed: r.collapsed, text: JSON.stringify(s.toString()).slice(0, 60), length: r.toString().length,
    anchor: describe(s.anchorNode, s.anchorOffset), focus: describe(s.focusNode, s.focusOffset)}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'keys2.md');
  fs.writeFileSync(doc, '占位\n', 'utf8');
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-math-keys2', outDir: OUT, args: [doc], timeout: 600000, inspect: true,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`, {timeout: 140000, interval: 80});
    await sleep(1600);
    console.log('记录器：' + await session.js(INSTALL));

    const setValue = async text => {
      await session.js(`(() => { const w = ${IF}; w.vditor.setValue(${JSON.stringify(text)}); return 1; })()`);
      await sleep(1400);
    };
    const place = async js => {
      const out = await session.js(`(() => { const w = ${IF}, d = w.document;
        const surface = d.querySelector('.vditor-ir .vditor-reset');
        surface.focus(); const placed = (${js});
        if (!placed || !placed.range) return {ok: false, error: placed ? placed.why : '没有结果'};
        const s = w.getSelection(); s.removeAllRanges(); s.addRange(placed.range);
        return {ok: true, why: placed.why}; })()`);
      await sleep(320);
      return out;
    };
    const walk = async (times, label) => {
      for (let i = 1; i <= times; i++) {
        await session.js(RESET);
        await session.key({key: 'ArrowLeft', code: 'ArrowLeft', vk: 37, modifiers: harness.MOD.shift});
        await sleep(320);
        const dump = await session.js(DUMP);
        console.log(`\n  ● ${label} Shift+← #${i}`);
        console.log('    按键：' + JSON.stringify(dump.keys));
        console.log('    选区变动（每次一行）：');
        for (const change of dump.changes) console.log(`      +${change.at}ms collapsed=${change.collapsed} text=${change.text}\n        anchor=${change.anchor}\n        focus=${change.focus}`);
        if (dump.calls.length) {
          console.log('    Selection API 调用：');
          for (const call of dump.calls) console.log(`      ${call.op}(${call.args.join(', ')})  ← ${call.stack}`);
        } else console.log('    Selection API 调用：（没有——选区由浏览器默认行为改的）');
        console.log('    终态：' + JSON.stringify(await session.js(CARET)));
      }
    };

    const md = '前段甲\n\n$$\na+b=1\n$$\n\n后段乙\n';
    await setValue(md);
    console.log('\n===== B1 程序放位：后段乙@0（闭围栏之后的位置型起点）=====');
    await place(`(() => { const t = surface.children[2].firstChild; const r = d.createRange(); r.setStart(t, 0); r.collapse(true); return {range: r, why: '后段乙@0'}; })()`);
    await walk(3, 'B1');

    console.log('\n===== B2 点公式渲染区（Vditor 展开、光标进源码）=====');
    const hit = await session.js(`(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor');
      const surface = d.querySelector('.vditor-ir .vditor-reset');
      const code = surface.children[1].querySelector('code[data-type="math-block"]');
      const owner = code.closest('.vditor-ir__node');
      const preview = owner.querySelector('.vditor-ir__preview');
      const box = preview.getBoundingClientRect(), fr = frame.getBoundingClientRect();
      return {x: Math.round(fr.x + box.left + box.width / 2), y: Math.round(fr.y + box.top + box.height / 2)}; })()`);
    await session.click(hit.x, hit.y);
    await sleep(400);
    console.log('  点后：' + JSON.stringify(await session.js(CARET)));
    await walk(3, 'B2');

    console.log('\n===== B3 展开态：光标放到闭围栏文本末尾再 Shift+← =====');
    const placed = await place(`(() => { const owner = surface.children[1]; const marks = [...owner.querySelectorAll('.vditor-ir__marker')];
      const last = marks[marks.length - 1]; const t = last.firstChild; if (!t) return {why: '闭围栏没有文本'};
      const r = d.createRange(); r.setStart(t, t.data.length); r.collapse(true); return {range: r, why: '闭围栏文本末尾'}; })()`);
    console.log('  放位：' + JSON.stringify(placed) + ' → ' + JSON.stringify(await session.js(CARET)));
    await walk(3, 'B3');

    console.log('\n===== B4 对照：行内公式之后 Shift+← =====');
    await setValue('前段甲 $a+b=1$ 后段乙\n');
    const placedInline = await place(`(() => { const owner = surface.querySelector('.vditor-ir__node[data-type="inline-node"]');
      const r = d.createRange(); r.setStartAfter(owner); r.collapse(true); return {range: r, why: '行内公式之后'}; })()`);
    console.log('  放位：' + JSON.stringify(placedInline) + ' → ' + JSON.stringify(await session.js(CARET)));
    await walk(4, 'B4');

    console.log('\n===== B5 对照：普通文字（最后一段中间）Shift+← =====');
    await setValue('前段甲乙丙丁\n');
    await place(`(() => { const t = surface.children[0].firstChild; const r = d.createRange(); r.setStart(t, 3); r.collapse(true); return {range: r, why: '文字中间'}; })()`);
    await walk(3, 'B5');
  } finally {
    await session.close();
  }
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
