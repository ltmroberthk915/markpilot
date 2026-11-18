'use strict';
/* 活动格公式预览（cell-math-preview.js）：光标→公式判定 与 卡片落位。
 * 判据全部是用户能看见的性质：哪一条公式被预览、卡片落在格的哪一侧、有没有越出正文列或编辑带。
 * 运行：node --test tools/quality/tests/cell-math-preview.test.cjs */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repo = path.resolve(__dirname, '../../..');
const logic = import(pathToFileURL(path.resolve(repo,
  process.env.MP_CELL_MATH_PREVIEW || 'dsh-markpilot/src-cm6/cell-math-preview.js')).href);

const SCREEN = String.raw`$t=\frac{T}{n}\quad\oiint f\,dx$`;

// 夹具自证：用与产品同一个扫描器打印公式区间，坐标全部由它推出（避免手算偏移）。
let scanInlineMath = null;
async function inlineSpan(source) {
  if (!scanInlineMath) {
    scanInlineMath = (await import(pathToFileURL(path.resolve(repo,
      'dsh-markpilot/src-cm6/inline-format.js')).href)).inlineMathSpans;
  }
  const [span] = scanInlineMath(source);
  return span ? [span.from, span.to] : null;
}

/* ── 光标 → 公式 ─────────────────────────────────────────── */

test('光标紧跟收尾 $ 时命中该公式（截图形态：正在写公式的最后一笔）', async () => {
  const { cellMathTarget } = await logic;
  const target = cellMathTarget(SCREEN, SCREEN.length);
  assert(target, 'caret after the closing dollar must preview the formula');
  assert.equal(target.tex, String.raw`t=\frac{T}{n}\quad\oiint f\,dx`);
  assert.deepEqual([target.from, target.to, target.display], [0, SCREEN.length, false]);
});

test('公式两端都算「在当前公式里」，纯文本光标一律不给预览', async () => {
  const { cellMathTarget } = await logic;
  const source = 'a $x+1$ b'; // 公式占 [2,7)
  assert.deepEqual(await inlineSpan(source), [2, 7]);
  for (const caret of [2, 3, 5, 7]) { // 开口 $ 上、字里、收尾 $ 之后
    assert.equal(cellMathTarget(source, caret)?.tex, 'x+1', 'caret ' + caret);
  }
  for (const caret of [0, 1, 8, source.length]) assert.equal(cellMathTarget(source, caret), null, 'caret ' + caret);
});

test('多个公式只认光标所在那一个；共用边界时认正在收尾的那个', async () => {
  const { cellMathTarget } = await logic;
  const source = '$a$ $b$ $c$';
  assert.equal(cellMathTarget(source, 2)?.tex, 'a');
  assert.equal(cellMathTarget(source, 6)?.tex, 'b');
  assert.equal(cellMathTarget(source, source.length)?.tex, 'c');
  // `$a$$b$`：位置 3 同时是 a 的收尾与 b 的开口，正在收尾的是 a。
  assert.equal(cellMathTarget('$a$$b$', 3)?.tex, 'a');
  assert.equal(cellMathTarget('$a$$b$', 4)?.tex, 'b');
});

test('转义美元与行内代码不进公式（与正文同一套扫描器）', async () => {
  const { cellMathTarget } = await logic;
  assert.equal(cellMathTarget(String.raw`价格 \$5 不是公式`, 6), null);
  assert.equal(cellMathTarget(String.raw`\$a\$\$b\$`, 4), null);
  const code = '`$a$` $b$';
  assert.equal(cellMathTarget(code, 2), null, 'caret inside inline code');
  assert.equal(cellMathTarget(code, code.length)?.tex, 'b');
});

test('未闭合/空公式不给预览（不留下过期预览，也不渲染空壳）', async () => {
  const { cellMathTarget } = await logic;
  assert.equal(cellMathTarget('text $', 6), null);
  assert.equal(cellMathTarget('$a$ 后面还有 $', 12), null);
  assert.equal(cellMathTarget('$$', 2), null);
  assert.equal(cellMathTarget('$ $', 3), null);
  assert.equal(cellMathTarget('', 0), null);
});

test('单行 display：整格 $$…$$ 按正文同一条边界规则认成 display，格内混排则仍是行内', async () => {
  const { cellMathTarget } = await logic;
  const display = '$$ \\sum_i x_i $$';
  const target = cellMathTarget(display, display.length);
  assert.equal(target.display, true);
  assert.equal(target.tex, String.raw`\sum_i x_i`);
  const mixed = '看 $$ \\sum_i x_i $$ 这行';
  assert.deepEqual(await inlineSpan(mixed), [2, 18]);
  assert.equal(cellMathTarget(mixed, 18)?.display, false, 'a mid-cell $$…$$ stays inline, like a mid-line one');
  assert.equal(cellMathTarget('  $$ a+b $$ ', 10)?.display, true, 'cell padding whitespace is not content');
});

test('光标位置越界/非数字时收敛到文本边界，不抛错', async () => {
  const { cellMathTarget } = await logic;
  const source = '$x$';
  assert.equal(cellMathTarget(source, 99)?.tex, 'x', 'beyond the end clamps to the last boundary');
  assert.equal(cellMathTarget(source, -5)?.tex, 'x', 'negative clamps to the start of the text');
  assert.equal(cellMathTarget(source, 1.6)?.tex, 'x', 'fractional offsets round like DOM offsets do');
  assert.equal(cellMathTarget(source, NaN), null);
  assert.equal(cellMathTarget(source, Infinity), null);
  assert.equal(cellMathTarget(null, 0), null);
});

/* ── 卡片落位 ───────────────────────────────────────────── */

const bounds = { top: 100, bottom: 700 };
const column = { left: 200, right: 900 };
const cell = { left: 320, right: 520, top: 300, bottom: 340 };
const place = (extra = {}) => ({ cell, bounds, column, width: 180, height: 40, ...extra });

test('默认贴在格的下方，且不越出格所在的那一列', async () => {
  const { placeCellMathPreview } = await logic;
  const p = placeCellMathPreview(place());
  assert.equal(p.placement, 'below');
  assert.equal(p.top, cell.bottom + 4);
  assert.equal(p.left, cell.left, 'left edges align when there is room');
  assert(p.left >= column.left && p.left + p.width <= column.right);
  assert.equal(p.scrollX, false);
});

test('再往下就出编辑带时翻到格的上方，始终整卡可见', async () => {
  const { placeCellMathPreview } = await logic;
  const high = { ...cell, top: 620, bottom: 660 };
  const p = placeCellMathPreview(place({ cell: high }));
  assert.equal(p.placement, 'above');
  // 卡片底缘在格上方 gap 处（卡片高 40、gap 4）⇒ 整卡落在编辑带内，不是被裁一半。
  assert.equal(p.top, high.top - 4 - 40);
  assert(p.top >= bounds.top);
  assert.equal(p.maxHeight, high.top - 4 - bounds.top, 'room is everything above the gap');
  assert.equal(p.scrollY, false, 'the whole card fits above, no internal scroll');
});

test('上下都放不下时钳进编辑带并允许卡内滚动，不把长公式甩出屏幕', async () => {
  const { placeCellMathPreview } = await logic;
  const p = placeCellMathPreview(place({ height: 900, cell: { ...cell, top: 380, bottom: 420 } }));
  assert.equal(p.placement, 'clamped');
  assert.equal(p.scrollY, true);
  assert(p.top >= bounds.top && p.top + p.maxHeight <= bounds.bottom + 1e-9);
  assert(p.maxHeight > 0);
});

test('恰好放得下时不加滚动条（scrollY 只在真溢出时为真）', async () => {
  const { placeCellMathPreview } = await logic;
  // 两侧都紧：上 86px、下 66px 可用（编辑带 100–300，格 190–230）。
  const tight = { top: 100, bottom: 300 };
  const mid = { left: 320, right: 520, top: 190, bottom: 230 };
  const fits = placeCellMathPreview({ cell: mid, bounds: tight, column, width: 180, height: 60 });
  assert.equal(fits.placement, 'below');
  assert.equal(fits.scrollY, false, 'a card that fits the roomier side must not get a scrollbar');
  // 比两侧任何一侧都高 ⇒ 才真溢出，允许卡内滚动（并钳在编辑带内，不甩出去）。
  const overflows = placeCellMathPreview({ cell: mid, bounds: tight, column, width: 180, height: 100 });
  assert.equal(overflows.placement, 'clamped');
  assert.equal(overflows.scrollY, true);
  assert(overflows.top >= tight.top && overflows.top + overflows.maxHeight <= tight.bottom + 1e-9);
});

test('窄格/贴边格：卡片宽度不超过可见列宽，右边缘不越界', async () => {
  const { placeCellMathPreview } = await logic;
  const columnWidth = column.right - column.left;
  // 贴右边缘的窄格：卡片先钳进列内，再按列宽收窄（比列宽更长 ⇒ 卡内横向滚动，不被裁掉）。
  const narrow = placeCellMathPreview(place({ cell: { left: 860, right: 890, top: 300, bottom: 340 }, width: 400 }));
  assert.equal(narrow.width, Math.min(400, columnWidth));
  assert(narrow.left + narrow.width <= column.right + 1e-9, 'right edge stays inside the column');
  assert(narrow.left >= column.left);
  // 比列窄的公式：右边缘贴着列右缘，但整卡仍然看得见。
  const shortCol = placeCellMathPreview(place({ width: columnWidth + 400 }));
  assert.equal(shortCol.width, columnWidth);
  assert.equal(shortCol.scrollX, true, 'narrower than the formula -> card scrolls instead of clipping');
  const fits = placeCellMathPreview(place({ width: columnWidth - 10 }));
  assert.equal(fits.scrollX, false, 'formula fits the column -> no scrollbar');
});

test('落位参数不合法时返回 null（调用方据此隐藏卡片，而不是画到 (0,0)）', async () => {
  const { placeCellMathPreview } = await logic;
  assert.equal(placeCellMathPreview(null), null);
  assert.equal(placeCellMathPreview(place({ height: 0 })), null);
  assert.equal(placeCellMathPreview(place({ width: NaN })), null);
  assert.equal(placeCellMathPreview(place({ column: { left: 900, right: 900 } })), null);
  assert.equal(placeCellMathPreview(place({ cell: null })), null);
});

test('视口坐标换算：只除以一次缩放，滚动位置天然正确（盒子已在滚动空间里）', async () => {
  const { cellPreviewLocal } = await logic;
  const box = { left: 100, top: 50 };
  assert.deepEqual(cellPreviewLocal({ left: 300, top: 250, width: 400, maxHeight: 200 }, box, 1),
    { left: 200, top: 200, width: 400, maxHeight: 200 });
  assert.deepEqual(cellPreviewLocal({ left: 300, top: 250, width: 400, maxHeight: 200 }, box, 2),
    { left: 100, top: 100, width: 200, maxHeight: 100 });
  // 非法缩放按 1 处理（与 mpZoomOf 的兜底同口径），绝不产出 Infinity。
  assert.deepEqual(cellPreviewLocal({ left: 300, top: 250, width: 400, maxHeight: 200 }, box, 0),
    { left: 200, top: 200, width: 400, maxHeight: 200 });
  assert.equal(cellPreviewLocal(null, box, 1), null);
});

/* ── 渲染节点身份（修了「每帧重建」） ─────────────────────── */

test('同一公式的渲染节点身份保持不变：滚动/移动光标/改尺寸都不重建 KaTeX', async () => {
  const { cellPreviewRenderKey, cellPreviewIsCurrent } = await logic;
  const card = {}; // 已挂渲染的卡片元素（真实 DOM 里就是同一个 div）
  const target = { tex: 'a+b', display: false };
  const key = cellPreviewRenderKey(target);
  let state = { key, dom: card, rendered: true };
  assert.equal(cellPreviewIsCurrent(state, key, card), true, 'same card + same tex -> reuse mounted nodes');
  // 同一公式、不同卡片（换格重建覆盖层）必须重画：身份按卡片元素本身判定。
  assert.equal(cellPreviewIsCurrent(state, key, {}), false);
  // tex 变了必须重画。
  assert.equal(cellPreviewIsCurrent(state, cellPreviewRenderKey({ tex: 'a-b', display: false }), card), false);
  assert.equal(cellPreviewIsCurrent(state, cellPreviewRenderKey({ tex: 'a+b', display: true }), card), false,
    'display 与行内是两种渲染');
  // 解析失败（没有渲染节点）不算"已渲染"，否则会永远停在源码上。
  assert.equal(cellPreviewIsCurrent({ key, dom: card, rendered: false }, key, card), false);
  assert.equal(cellPreviewIsCurrent(null, key, card), false);
  assert.equal(cellPreviewRenderKey(null), '');
});

test('整格滚出编辑带时卡片隐藏（节点保留），滚回来仍算同一份渲染', async () => {
  const { cellPreviewOnscreen } = await logic;
  const band = { top: 100, bottom: 700 };
  assert.equal(cellPreviewOnscreen({ left: 0, right: 10, top: 300, bottom: 340 }, band), true);
  assert.equal(cellPreviewOnscreen({ left: 0, right: 10, top: 60, bottom: 99 }, band), false, 'above the band');
  assert.equal(cellPreviewOnscreen({ left: 0, right: 10, top: 701, bottom: 740 }, band), false, 'below the band');
  // 只判上下：左右被横向滚出不算"整格离开"（表格可横向滚动，卡片跟着列走）。
  assert.equal(cellPreviewOnscreen({ left: -900, right: -800, top: 300, bottom: 340 }, band), true);
  assert.equal(cellPreviewOnscreen(null, band), false);
});

test('自然尺寸按「公式 + 缩放」缓存：同一公式不重复量，缩放变了才重量', async () => {
  const fs = require('node:fs');
  const main = fs.readFileSync(path.resolve(repo, 'dsh-markpilot/src-cm6/main.js'), 'utf8');
  assert.match(main, /function cellMathNaturalSize\(card, zoom\)/);
  assert.match(main, /cached\.zoom === zoom/, 'natural size must be cached per zoom');
  assert.match(main, /cellMathState\.natural = natural/, 'measured size must be cached');
  // 测量只允许发生在 max-content 临时态里，并且立刻还原（不能在每帧路径上都写）。
  assert.match(main, /card\.style\.width = 'max-content'[\s\S]{0,400}card\.style\.width = width/);
  // 落位只读缓存值，不再每帧写 max-content。
  const place = main.slice(main.indexOf('function previewCellMath('), main.indexOf('function scheduleCellMathPreview('));
  assert.equal((place.match(/max-content/g) || []).length, 0, 'the per-frame path must not touch max-content');
});

test('滚动/尺寸变化只在有卡片时跟随重定位（无卡片零成本）', async () => {
  const fs = require('node:fs');
  const main = fs.readFileSync(path.resolve(repo, 'dsh-markpilot/src-cm6/main.js'), 'utf8');
  assert.match(main, /function followCellMathPreview\(\)\s*\{\s*if \(cellMathState\.rendered \|\| cellMathState\.visible\) scheduleCellMathPreview\(\);/);
  // 滚动监听器必须把卡片跟随接上（只加在既有合并钩子里，不新增监听器）。
  assert.match(main, /scrollDOM\.addEventListener\("scroll", \(\) => \{ positionTableBar\(\); followCellMathPreview\(\); \}/);
  /* 覆盖层收起时必须丢掉节点（否则下次入口白排一帧、旧公式还会闪一帧）。
     改动只加前置语句、不改这个语义 ⇒ 断言改成"函数体内必须调用 clearCellMathPreview"，
     不再依赖它出现在开头多少字符内（那是对语句位置的静态耦合，不是行为）。 */
  const deactivate = main.slice(main.indexOf('function deactivateCellOverlay()'),
    main.indexOf('function deactivateCellOverlay()') + 2000);
  const body = deactivate.slice(0, deactivate.indexOf('\n}'));
  assert.match(body, /clearCellMathPreview\(\)/, 'dropping the overlay must drop the preview card');
  // 而且必须在把 cellEdit 置空**之前**（否则清卡片时已经找不到活动格）。
  assert.ok(body.indexOf('clearCellMathPreview()') < body.indexOf('cellEdit = null;'),
    'the preview must be cleared while the cell is still owned');
});

test('溢出才可交互：普通公式保持穿透（不劫持编辑），长公式放行滚动条', async () => {
  const { cellPreviewInteractive, placeCellMathPreview } = await logic;
  assert.equal(cellPreviewInteractive(placeCellMathPreview(place({ width: 5000, height: 5000 }))), true,
    'long formula needs its scrollbar to be draggable');
  assert.equal(cellPreviewInteractive(placeCellMathPreview(place({ width: 100, height: 20 }))), false,
    'a fitting formula must not intercept clicks');
  assert.equal(cellPreviewInteractive(null), false);
  // 渲染后实测也参与判定：文本比卡宽（scrollWidth 溢出）同样算"要交互"。
  const overflowing = { scrollWidth: 400, clientWidth: 200, scrollHeight: 20, clientHeight: 20 };
  const fitting = { scrollWidth: 200, clientWidth: 200, scrollHeight: 20, clientHeight: 20 };
  const noScroll = placeCellMathPreview(place({ width: 400, height: 20 }));
  assert.equal(cellPreviewInteractive(noScroll, overflowing), true);
  assert.equal(cellPreviewInteractive(noScroll, fitting), false);

  const fs = require('node:fs');
  const main = fs.readFileSync(path.resolve(repo, 'dsh-markpilot/src-cm6/main.js'), 'utf8');
  // 交互性按落位+实测决定：只有溢出才 is-interactive，其他一律 pointer-events:none。
  assert.match(main, /cellPreviewInteractive\(placement, card\)/);
  assert.match(main, /\.mp-cell-math-preview\.is-interactive \{ pointer-events: auto; \}/);
  assert.match(main, /\.mp-cell-math-preview \{[\s\S]{0,400}pointer-events: none;/);
  // 隐形时收回交互权，避免不可见卡片继续吃点击。
  assert.match(main, /function hideCellMathPreview\(\)[\s\S]{0,400}classList\.remove\('is-interactive'\)/);
  // 按下只放行滚动条区域，其他一律 preventDefault 并把焦点留给源码 ⇒ 不劫持编辑。
  assert.match(main, /function cellOverlayMathPointer\(event\)/);
  assert.match(main, /if \(onVertical \|\| onHorizontal\) \{/);
  assert.match(main, /event\.preventDefault\(\);[\s\S]{0,260}edit\.focus\(\{ preventScroll: true \}\)/);
});

test('卡片表面沿用正文公式浮框的同一套变量（调透明度/模糊时表格跟着变）', async () => {
  const fs = require('node:fs');
  const main = fs.readFileSync(path.resolve(repo, 'dsh-markpilot/src-cm6/main.js'), 'utf8');
  const card = main.slice(main.indexOf('.mp-cell-math-preview {'),
    main.indexOf('.mp-cell-math-preview::-webkit-scrollbar {'));
  // 同一个 tint 派生式、同一对表面 token、同一套 @supports 毛玻璃配方。
  assert.match(card, /--mp-float-tint: color-mix\(in srgb, var\(--mp-bg\) 84%, var\(--mp-fg\)\)/);
  assert.match(main, /@supports \(\(backdrop-filter: blur\(2px\)\) or \(-webkit-backdrop-filter: blur\(2px\)\)\) \{\s*\.mp-cell-math-preview \{/);
  assert.match(card, /var\(--mp-float-alpha\)/);
  assert.match(card, /blur\(var\(--mp-float-blur\)\)/);
  // 与正文浮框同一条 fallback 链：先纯色、再 tint、最后毛玻璃（三层都在）。
  assert.match(card, /background: var\(--mp-codeBg\);/);
  assert.match(card, /background: var\(--mp-float-tint\);/);
  const floatRule = main.slice(main.indexOf('.mp-inline-float {'), main.indexOf('.mp-cell-code {'));
  for (const token of ['--mp-float-tint', '--mp-float-alpha', '--mp-float-blur']) {
    assert(floatRule.includes(token), 'body float uses ' + token + ' (shared token surface)');
  }
});

test('普通格快路径：不含 $ 就不做 DOM 选区计算（每键路径零 Range/零 offset）', async () => {
  const fs = require('node:fs');
  const main = fs.readFileSync(path.resolve(repo, 'dsh-markpilot/src-cm6/main.js'), 'utf8');
  const fn = main.slice(main.indexOf('function cellMathCaret()'), main.indexOf('function ensureCellMathPreview()'));
  // 顺序即性能：includes 判定必须排在 cellDOMSelection（建 Range + toString）之前。
  const gate = fn.indexOf("if (!text.includes('$')) return null;");
  const range = fn.indexOf('cellDOMSelection(edit)');
  assert(gate > 0, 'plain cells must be rejected by a text test before touching the selection');
  assert(range > gate, 'cellDOMSelection must come after the $ gate, never before');
  /* 文本经投影读取器取一次、复用给 cellMathTarget（混排格里 DOM 文本不再是纯 textContent，
     所以"只读一次"的口径改由读取器承担；这里断言**真实**的读取次数，而不是数字面量）。 */
  assert.equal((fn.match(/cellEditPlainText\(/g) || []).length, 1, 'read the cell text once and reuse it');
  assert.match(fn, /const text = cellEditPlainText\(edit\);/);
  assert.match(fn, /cellMathTarget\(text, dom\.head\)/, 'the same text is reused for the target decision');

  /* 真实行为：把**产品自己的**读取器解出来，用一个会计数的假编辑面量每键成本。
     纯文本格必须"恰好一次 textContent、零 querySelector、零 Range/零 offset"。 */
  const pickFn = (source, name) => {
    const at = source.indexOf('function ' + name + '(');
    assert.ok(at > 0, 'missing function ' + name);
    const rest = source.slice(at + 1);
    const next = rest.indexOf('\nfunction ');
    return next > 0 ? source.slice(at, at + 1 + next) : source.slice(at);
  };
  const readerScope = ['isCellAtomNode', 'cellAtomSource', 'cellPlainLength', 'cellVisibleText', 'cellEditPlainText']
    .map(name => pickFn(main, name)).join('\n');
  const cellEditPlainText = new Function('CELL_ATOM_CLASS', 'CELL_ATOM_SELECTOR',
    readerScope + '\nreturn cellEditPlainText;')('mp-cell-atom', '.mp-cell-atom');
  const textNode = value => ({ nodeType: 3, nodeValue: value });
  const atomNode = src => ({
    nodeType: 1, textContent: 'KATEXGLYPHS',
    classList: { contains: name => name === 'mp-cell-atom' },
    getAttribute: name => (name === 'data-mp-cell-src' ? src : null),
  });
  const editWith = (children, atomHit = null) => {
    let reads = 0, queries = 0;
    const nodes = children.slice();
    nodes.forEach((node, i) => { node.nextSibling = nodes[i + 1] || null; });
    return {
      edit: {
        nodeType: 1, firstChild: nodes[0] || null,
        get textContent() { reads++; return nodes.map(n => (n.nodeType === 3 ? n.nodeValue : 'KATEXGLYPHS')).join(''); },
        querySelector(selector) { queries++; assert.equal(selector, '.mp-cell-atom'); return atomHit; },
      },
      reads: () => reads,
      queries: () => queries,
    };
  };
  const plain = editWith([textNode('ab')]);
  assert.equal(cellEditPlainText(plain.edit, { hasAtoms: false }), 'ab');
  assert.equal(plain.reads(), 1, 'a plain cell reads textContent exactly once per key');
  assert.equal(plain.queries(), 0, 'a warm plain cell does no atom probing at all');
  // 账本未知（外部夹具/旧对象）：探测一次就记账，之后仍是"一次读取、零探测"。
  const cold = editWith([textNode('ab')]), coldOwner = {};
  assert.equal(cellEditPlainText(cold.edit, coldOwner), 'ab');
  assert.equal(cold.queries(), 1);
  assert.equal(cold.reads(), 1);
  assert.equal(coldOwner.hasAtoms, false, 'the probe result is remembered');
  cellEditPlainText(cold.edit, coldOwner);
  assert.equal(cold.queries(), 1, 'the probe must not repeat on the next key');
  assert.equal(cold.reads(), 2);
  // 含 atom 的格：KaTeX 字形永不进入源码坐标，只读 atom 自己的 Markdown。
  const withAtom = editWith([textNode('x '), atomNode('$a$')], true);
  assert.equal(cellEditPlainText(withAtom.edit, { hasAtoms: true }), 'x $a$');
  assert.equal(withAtom.reads(), 0, 'rendered glyphs must never be read into source coordinates');

  // 触发入口同样受此快路径保护：普通格连 frame 都不排。
  assert.match(main, /if \(cellMathCaret\(\)\) scheduleCellMathPreview\(\);/);
  // selectionchange 监听先判活动格，再碰 DOM。
  assert.match(main, /addEventListener\('selectionchange', \(\) => \{\s*if \(!cellEdit\) return;/);
  // 有卡片时仍走重算路径（公式被删/光标移走要能收掉）。
  assert.match(main, /if \(cellMathState\.rendered \|\| cellMathState\.visible\) \{ scheduleCellMathPreview\(\); return; \}/);
});

/* ── 与正文共用同一套公式缓存 ─────────────────────────────── */

test('预览与正文走同一个 KaTeX 缓存入口（不另建渲染器）', async () => {
  const fs = require('node:fs');
  const main = fs.readFileSync(path.resolve(repo, 'dsh-markpilot/src-cm6/main.js'), 'utf8');
  assert.match(main, /cellMathTarget\(/, 'active cell must resolve its formula through the shared rule');
  assert.match(main, /renderMathHTML\(target\.tex/, 'the preview must reuse renderMathHTML (same tex->HTML cache)');
  // 同一个 tex 第二次进来只应命中缓存：main.js 里预览没有第二套 katexApi().renderToString。
  const renders = main.match(/katexApi\(\)\.renderToString/g) || [];
  assert.equal(renders.length, 1, 'there must stay exactly one KaTeX render entry point');
});
