/** "预览落后于源码"这个窗口真的能被点中吗？——量它，不猜它。
 *
 *  `math-source-map.js` 的映射里有一条逃生口：预览上的 `data-math`（那次渲染用的源码）
 *  与公式 `<code>` 的当前源码不一致时，`targetOffset` 直接返回 `null`，调用方只能走兜底
 *  （按落点落在公式框的哪一半贴到最前/最后）。Step 6b 打算把这条逃生口换成"按被改动的位置
 *  平移"（冻结落点在新代号上重算）。**但前提是这个窗口真的一戳就中**——
 *  渲染是 math-scheduler 的异步批处理（rAF/idle 分片提交），理论上敲完字到预览更新之间
 *  有一帧以上的空档；若实测根本截不到，这条改动就是死代码，不该进主干。
 *
 *  手法：每轮把光标放到公式源码末尾 → 敲一个字符（触发重渲染）→ **立刻**点公式中段的一个
 *  字形。页面内的观察器在 mousedown 捕获阶段（早于产品处理器）记下这一刻的
 *  `data-math` 与 `<code>` 源码，据此判断"这一击是不是落在窗口里"；再读实际光标偏移，
 *  以及"按改动位置平移"本应给的值，两条对齐看。
 *
 *  用法：node scripts/acceptance/probe-stale-map.cjs [--rounds=12]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-stale-map');
const IF = `document.getElementById('editor').contentWindow`;
const SURFACE = '.vditor-ir .vditor-reset';

const argOf = (name, fallback) => {
  const hit = process.argv.find(value => value.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};

/** 一条带多个字形的行内公式：中间的某个字形会被点。 */
const FIXTURE = ['# 预览滞后窗口', '', '公式：$a\\times b+c-d/e$', '', '其后正文：用来确认落点没有跑到别的段。', ''].join('\n');

const WATCH = `(() => { const w = ${IF}, d = w.document;
  if (w.__staleLog) { w.__staleLog.length = 0; return 'reset'; }
  w.__staleLog = [];
  // 捕获阶段挂在 document 上：比产品挂在编辑面上的处理器更早拿到这一刻的 DOM 状态
  d.addEventListener('mousedown', event => {
    const host = event.target && event.target.closest ? event.target.closest('.vditor-ir__node') : null;
    if (!host) return;
    const preview = host.querySelector('.vditor-ir__preview');
    const code = host.querySelector('code[data-type="math-inline"]');
    const math = preview && preview.querySelector('.language-math');
    w.__staleLog.push({at: Math.round(performance.now()),
      rendered: math ? math.getAttribute('data-math') : null,
      source: code ? code.textContent : null,
      stale: !!(math && code) && math.getAttribute('data-math') !== code.textContent,
      x: Math.round(event.clientX), y: Math.round(event.clientY)});
  }, true);
  return 'watching'; })()`;

/** 光标放到公式源码末尾（下一步敲字就改在这里）。 */
const TO_END = `(() => { const w = ${IF}, d = w.document;
  const code = d.querySelector('code[data-type="math-inline"]');
  if (!code || !code.firstChild) return {ok: false};
  const range = d.createRange();
  range.setStart(code.firstChild, code.firstChild.data.length); range.collapse(true);
  const selection = w.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  d.querySelector(${JSON.stringify(SURFACE)}).focus();
  return {ok: true, source: code.textContent}; })()`;

/** 待点的字形（公式中段那个）：连同它当前的源码区间一起给出。 */
const GLYPH = `(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor');
  const code = d.querySelector('code[data-type="math-inline"]');
  const host = code && code.closest('.vditor-ir__node');
  const preview = host && host.querySelector('.vditor-ir__preview');
  if (!preview) return {ok: false};
  preview.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
  const glyphs = [...preview.querySelectorAll('[data-typora-source-start]')]
    .map(node => ({node, rect: node.getBoundingClientRect()}))
    .filter(item => item.rect.width > 3 && item.rect.height > 6);
  if (glyphs.length < 3) return {ok: false, error: '字形太少：' + glyphs.length};
  const pick = glyphs[Math.floor(glyphs.length / 2)];
  const fr = frame.getBoundingClientRect();
  return {ok: true, 字形数: glyphs.length, 文本: pick.node.textContent,
    旧区间: [+pick.node.getAttribute('data-typora-source-start'), +pick.node.getAttribute('data-typora-source-end')],
    x: Math.round(fr.x + pick.rect.left + pick.rect.width / 2),
    y: Math.round(fr.y + pick.rect.top + pick.rect.height / 2)}; })()`;

const STATE = `(() => { const w = ${IF}, d = w.document;
  const code = d.querySelector('code[data-type="math-inline"]');
  const host = code && code.closest('.vditor-ir__node');
  const preview = host && host.querySelector('.vditor-ir__preview');
  const math = preview && preview.querySelector('.language-math');
  const selection = w.getSelection();
  const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
  const start = range ? range.startContainer : null;
  const at = start ? (start.nodeType === 3 ? start.parentElement : start) : null;
  let offset = null;
  if (code && start && code.contains(start)) {
    const prefix = d.createRange(); prefix.selectNodeContents(code); prefix.setEnd(start, range.startOffset);
    offset = prefix.cloneContents().textContent.length;
  }
  const log = w.__staleLog || [];
  const last = log.length ? log[log.length - 1] : null;
  // "按改动位置平移"本应给出的值：前缀不动、后缀整体平移，落点在被改动的中间那一段才算说不清
  const predict = (() => {
    if (!last || last.rendered === null || last.source === null || last.rendered === last.source) return '不适用';
    const old = last.rendered, fresh = last.source;
    let prefix = 0;
    const shortest = Math.min(old.length, fresh.length);
    while (prefix < shortest && old[prefix] === fresh[prefix]) prefix++;
    let suffix = 0;
    while (suffix < shortest - prefix && old[old.length - 1 - suffix] === fresh[fresh.length - 1 - suffix]) suffix++;
    const shift = value => (value <= prefix ? value
      : value >= old.length - suffix ? value + (fresh.length - old.length) : null);
    return {前缀: prefix, 后缀: suffix, 平移: fresh.length - old.length};
  })();
  return {ok: true, source: code ? code.textContent : null,
    rendered: math ? math.getAttribute('data-math') : null,
    点击时: last ? {落后: last.stale, rendered: last.rendered, source: last.source} : null,
    预测: predict,
    光标: {在公式里: !!(code && start && code.contains(start)), 偏移: offset,
      容器: start ? (start.nodeType === 3 ? 'TEXT' : start.nodeName) : null},
    观察条数: log.length}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'stale.md');
  fs.writeFileSync(doc, FIXTURE);
  const rounds = Number(argOf('rounds', 12));

  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-stale-map', outDir: OUT, args: [doc], timeout: 300000, inspect: true,
  });
  try {
    const ready = await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('code[data-type="math-inline"]')); })()`, {timeout: 120000, interval: 60});
    if (!ready) throw new Error('公式没有渲染出来');
    await sleep(1500);
    await session.js(WATCH);
    const rows = [];
    for (let round = 1; round <= rounds; round++) {
      const glyph = await session.js(GLYPH);
      if (!glyph.ok) { rows.push({round, error: glyph.error || '没有可点的字形'}); continue; }
      const at = await session.js(TO_END);
      if (!at.ok) { rows.push({round, error: '放不到源码末尾'}); continue; }
      await session.send('Input.insertText', {text: 'z'});          // 改源码 → 触发重渲染
      await session.click(glyph.x, glyph.y);                        // 紧接着就点预览上的字形
      await sleep(260);
      const state = await session.js(STATE);
      rows.push({round, 敲字前源码: at.source, 点: {文本: glyph.文本, 旧区间: glyph.旧区间},
        点击时: state.点击时, 光标: state.光标, 源码: state.source, 渲染: state.rendered, 预测: state.预测});
    }
    console.log('\n=== 预览滞后窗口：点中了吗 ===');
    for (const row of rows) {
      if (row.error) { console.log(`第 ${row.round} 轮 ✗ ${row.error}`); continue; }
      const stale = row.点击时 && row.点击时.落后;
      console.log(`第 ${String(row.round).padStart(2)} 轮  点「${row.点.文本}」(旧区间 ${JSON.stringify(row.点.旧区间)})  ` +
        `点击那一刻预览${stale ? '★落后于源码' : '已跟上'}  ` +
        `→ 光标${row.光标.在公式里 ? '在公式里' : '在公式外'} 偏移=${row.光标.偏移}  ` +
        `源码=${JSON.stringify(String(row.源码).slice(0, 26))}  ` +
        `点击时渲染=${JSON.stringify(String((row.点击时 || {}).rendered).slice(0, 22))}`);
    }
    const staleCount = rows.filter(row => row.点击时 && row.点击时.落后).length;
    console.log(`\n落在滞后窗口里的点击：${staleCount} / ${rows.filter(row => !row.error).length}`);
    fs.writeFileSync(path.join(OUT, 'stale.json'), JSON.stringify(rows, null, 2));
    console.log('明细：' + path.join(OUT, 'stale.json'));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
