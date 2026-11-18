'use strict';
/* 活动格混排投影：纯逻辑（cell-math-projection.js）+ 落码接线（main.js）。
 * 判据全部是用户能看见的性质：格里有几条公式保持排版、哪一条被摊成源码、点字形落到源码哪位。
 *
 * 运行（默认读本 checkout 的产品源码）：
 *   node --test tools/quality/tests/cell-math-projection.test.cjs
 * 核对候选实现（私有目录里的完整变更文件）：
 *   MP_CELL_SRC=<impl>/dsh-markpilot/src-cm6 node --test tools/quality/tests/cell-math-projection.test.cjs */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

/* 仓库根：从本文件向上找**真正**的 checkout（认 build-from-source.cjs 这个入口），
   这样同一支测试在 checkout 里、在私有 impl 镜像里都指得回同一份产品源码。
   需要核对别处的副本时用 MP_CELL_SRC 显式指定。 */
function findRepo(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'build-from-source.cjs')) &&
        fs.existsSync(path.join(dir, 'dsh-markpilot', 'src-cm6', 'main.js'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
const repo = findRepo(__dirname) || path.resolve(__dirname, '../../..');
const SRC_DIR = process.env.MP_CELL_SRC
  ? path.resolve(process.env.MP_CELL_SRC)
  : path.resolve(repo, 'dsh-markpilot/src-cm6');
const MAIN = fs.readFileSync(path.join(SRC_DIR, 'main.js'), 'utf8');
const logic = import(pathToFileURL(path.join(SRC_DIR, 'cell-math-projection.js')).href);

/* 短失败信息：断言只打印函数名与缺的那一条，绝不把整个 600KB 源码倒出来。 */
function scope(label, startMarker, endMarker) {
  const at = MAIN.indexOf(startMarker);
  assert.ok(at >= 0, label + ': missing ' + startMarker);
  const stop = endMarker ? MAIN.indexOf(endMarker, at) : -1;
  if (endMarker) assert.ok(stop > at, label + ': missing end marker ' + endMarker);
  return endMarker ? MAIN.slice(at, stop) : MAIN.slice(at);
}
/** 只取一个函数体（到下一个顶层 function/const 声明为止），用于"这个函数里不许出现 X"。 */
function fnBody(label, marker) {
  const at = MAIN.indexOf(marker);
  assert.ok(at >= 0, label + ': missing ' + marker);
  const rest = MAIN.slice(at + marker.length);
  const next = rest.search(/\n(?:async )?function [A-Za-z_]|\nconst [A-Za-z_]+ = |\n\/\* ══/);
  return marker + (next > 0 ? rest.slice(0, next) : rest);
}
const has = (text, needle, note) => assert.ok(text.includes(needle), note || ('missing ' + needle));
const lacks = (text, needle, note) => assert.ok(!text.includes(needle), note || ('must not contain ' + needle));

const MIXED = '前文 $a_1$ 中间 $b^2$ 尾文';

/* 把**产品自己的** cellOverlayCopyAtoms 里那段真实逻辑跑起来（不是正则比对），
   用假事件/假选区观察它到底拦没拦默认行为、删没删东西。
   只把"纯文本读取/切片/删除/DOM 选区"这些边界替换成可数的替身，
   被断言的分支判断、"先写后删"的顺序、只读/IME/不可取消的门禁全部是真实源码。 */
function runCopyHandler({ type = 'cut', cancelable = true, canWrite = true,
  readOnly = false, composing = false, text = MIXED } = {}) {
  const handler = fnBody('copy handler', 'function cellOverlayCopyAtoms(');
  let prevented = false, deleted = 0, writes = 0;
  const selection = {
    isCollapsed: false, rangeCount: 1, anchorNode: { nodeType: 3 },
    getRangeAt: () => ({ startContainer: {}, startOffset: 0, endContainer: {}, endOffset: 0 }),
  };
  const clipboard = { setData() { writes++; if (!canWrite) throw new Error('denied'); } };
  const event = {
    type, cancelable, clipboardData: clipboard,
    currentTarget: { contains: () => true },
    target: { nodeType: 3 },
    preventDefault() { prevented = true; },
  };
  const api = {
    cellEdit: { surface: { open: -1 } },
    view: { state: { readOnly }, composing },
    cellComposing: composing,
    getSelection: () => selection,
    cellSelectionTouchesAtom: () => true,
    cellPlainSelection: () => ({ text: '$a_1$', from: 3, to: 8 }),
    cellPlainWriteClipboard: (data, payload) => {
      if (!data) return false;
      try { data.setData('text/plain', payload); return true; } catch { return false; }
    },
    deleteCellPlainRange: () => { deleted++; },
    setCellDOMSelection: () => {},
    syncCellEdit: () => {},
    refreshCellProjection: () => {},
  };
  const call = new Function(...Object.keys(api), '__event', handler + '\ncellOverlayCopyAtoms(__event);');
  call(...Object.values(api), event);
  return { prevented, deleted, writes };
}

// 夹具自证：用与产品同一个扫描器打印公式区间，坐标由它推出（不手算偏移）。
let scan = null;
async function spans(source) {
  if (!scan) scan = (await import(pathToFileURL(path.join(SRC_DIR, 'inline-format.js')).href)).inlineMathSpans;
  return scan(source).map(s => [s.from, s.to]);
}

/* ── 切段 ───────────────────────────────────────────────── */

test('混排格切成「文字—公式—文字—公式—文字」，区间与共享扫描器一致', async () => {
  const { cellMathParts } = await logic;
  const found = await spans(MIXED);
  assert.equal(found.length, 2, 'fixture must really contain two formulas');
  const parts = cellMathParts(MIXED);
  assert.deepEqual(parts.map(p => p.kind), ['text', 'math', 'text', 'math', 'text']);
  assert.deepEqual([parts[1].from, parts[1].to], found[0]);
  assert.deepEqual([parts[3].from, parts[3].to], found[1]);
  assert.equal(parts[1].tex, 'a_1');
  assert.equal(parts[3].tex, 'b^2');
  let at = 0;
  for (const part of parts) { assert.equal(part.from, at); at = part.to; }
  assert.equal(at, MIXED.length);
});

test('纯文本格零公式：只有一段文字（纯文本快路径不建任何 atom）', async () => {
  const { cellMathParts } = await logic;
  assert.deepEqual(cellMathParts('就是一句话').map(p => p.kind), ['text']);
  assert.deepEqual(cellMathParts(''), []);
});

test('转义美元 / 行内代码 / 空公式不当公式（与正文同一套语法）', async () => {
  const { cellMathParts } = await logic;
  for (const source of ['价格 \\$5 不是公式', '`$a$` 是代码', '$$', '$ $', '只有 $ 一个']) {
    assert.equal(cellMathParts(source).filter(p => p.kind === 'math').length, 0, JSON.stringify(source));
  }
  assert.equal(cellMathParts('`$a$` $b$').filter(p => p.kind === 'math').length, 1);
});

test('只有整格 $$…$$ 才是块级；混在文字里的 $$…$$ 保持行内（与正文同一条边界规则）', async () => {
  const { cellMathParts } = await logic;
  const display = cellMathParts('$$ \\sum_i x_i $$');
  assert.equal(display.length, 1);
  assert.equal(display[0].display, true);
  assert.equal(display[0].tex, String.raw`\sum_i x_i`);
  assert.equal(display[0].lead, 1, 'trimmed lead whitespace is recorded for the tex -> source map');
  assert.equal(cellMathParts('看 $$ \\sum_i x_i $$ 这行').find(p => p.kind === 'math').display, false);
});

test('渲染失败的公式不排版、按字面源码留在文字流里（宁可显示源码也不吞内容）', async () => {
  const { cellMathParts, atomizedParts } = await logic;
  assert.equal(atomizedParts(cellMathParts('前 $\\badcmd{$ 后', () => false), -1).filter(p => p.atom).length, 0);
  assert.equal(atomizedParts(cellMathParts('前 $\\badcmd{$ 后', () => true), -1).filter(p => p.atom).length, 1);
});

/* ── 打开哪一条 ─────────────────────────────────────────── */

test('只打开光标所在的那一条：其余公式保持排版', async () => {
  const { cellMathParts, openMathIndex, atomizedParts } = await logic;
  const parts = cellMathParts(MIXED);
  const first = parts.findIndex(p => p.kind === 'math');
  const second = parts.findIndex((p, i) => p.kind === 'math' && i !== first);
  assert.equal(openMathIndex(parts, parts[first].from + 2), first);
  assert.equal(openMathIndex(parts, parts[second].from + 2), second);
  const a = atomizedParts(parts, first).filter(p => p.atom);
  const b = atomizedParts(parts, second).filter(p => p.atom);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.notEqual(a[0].from, b[0].from);
  assert.equal(atomizedParts(parts, -1).filter(p => p.atom).length, 2);
  assert.equal(atomizedParts(parts, -2).filter(p => p.atom).length, 0);
});

test('点公式右侧的文字不打开公式（"点文字一律露出所有公式"的回归点）', async () => {
  const { cellMathParts, openMathIndex } = await logic;
  const parts = cellMathParts(MIXED);
  const first = parts.findIndex(p => p.kind === 'math');
  assert.equal(openMathIndex(parts, parts[first].to), -1, 'caret just after the closing $ stays text');
  assert.equal(openMathIndex(parts, parts[first].from - 1), -1, 'space before the opening $ stays text');
  assert.equal(openMathIndex(parts, parts[first].from, { includeStart: false }), -1);
  assert.equal(openMathIndex(parts, parts[first].from, { includeStart: true }), first);
});

test('整块 display 公式独占一格：光标停在任一端点都打开它（否则整格无法编辑）', async () => {
  const { cellMathParts, openMathIndex } = await logic;
  const source = '$$ a+b $$';
  const parts = cellMathParts(source);
  assert.equal(openMathIndex(parts, 0), 0);
  assert.equal(openMathIndex(parts, source.length), 0);
});

test('非数字/越界光标一律不打开（不猜意图、不留过期投影）', async () => {
  const { cellMathParts, openMathIndex } = await logic;
  const parts = cellMathParts(MIXED);
  for (const caret of [NaN, Infinity, -Infinity, null, undefined]) assert.equal(openMathIndex(parts, caret), -1, String(caret));
  assert.equal(openMathIndex(parts, -5), -1);
  assert.equal(openMathIndex(parts, MIXED.length + 50), -1);
});

/* ── 点字形 → 源码位 ────────────────────────────────────── */

test('点公式字形换算成格源码坐标：落在该公式自己的源码区间内，越界也不甩出公式', async () => {
  const { cellMathParts, texOffsetToCell } = await logic;
  for (const part of cellMathParts(MIXED).filter(p => p.kind === 'math')) {
    assert.equal(texOffsetToCell(part, 0), part.from + 1);
    assert.equal(texOffsetToCell(part, part.tex.length), part.to - 1);
    assert.equal(texOffsetToCell(part, -100), part.from + 1);
    assert.equal(texOffsetToCell(part, 10_000), part.to - 1);
    const mid = texOffsetToCell(part, 1);
    assert.ok(mid >= part.from && mid <= part.to);
  }
});

test('整块 display 公式的 tex 偏移补回被 trim 的前导空白', async () => {
  const { cellMathParts, texOffsetToCell } = await logic;
  const source = '$$   a+b $$';
  const [part] = cellMathParts(source).filter(p => p.kind === 'math');
  assert.equal(part.display, true);
  assert.equal(part.lead, 3);
  assert.equal(texOffsetToCell(part, 0), 5);
  assert.equal(source.slice(texOffsetToCell(part, 0), texOffsetToCell(part, 1)), 'a');
});

/* ── 纯文本坐标不变（镜像/选区/撤销契约） ─────────────────── */

test('atom 的纯文本贡献是它自己的 Markdown：读取器只认 data-mp-cell-src', async () => {
  const body = scope('atom reader', 'function cellAtomSource(node)', 'function cellPlainLength(');
  has(body, 'data-mp-cell-src', 'atom source must come from the data attribute');
  has(body, "raw == null ? (node && node.textContent) || '' : raw", 'only a raw fallback may read rendered text');
});

test('镜像 diff / 选区换算 / sizer / 光标判定都走投影感知的读取器，不读 raw textContent', async () => {
  // 三个可接受入口：纯文本读取器、按节点换算、（选区换算走 cellDOMSelection，它内部也用纯文本坐标）。
  const readers = ['cellEditPlainText', 'cellVisibleText', 'cellPlainOffsetAt', 'cellDOMSelection'];
  const cases = [
    ['syncCellSelection', 'function syncCellSelection('],
    ['syncCellEdit', 'function syncCellEdit(edit)'],
    ['updateCellSizer', 'function updateCellSizer(edit)'],
    ['cellMathCaret', 'function cellMathCaret()'],
  ];
  for (const [name, marker] of cases) {
    const body = fnBody(name, marker);
    assert.ok(readers.some(reader => body.includes(reader)),
      name + ' must read the projection through a projection-aware reader');
    lacks(body, 'edit.textContent', name + ' must not read raw textContent');
    lacks(body, 'div.textContent', name + ' must not read raw textContent');
  }
});

test('纯文本格走快路径：没有 atom 时只读一次 textContent', async () => {
  const body = scope('plain fast path', 'function cellEditPlainText(', 'function cellPlainOffsetAt(');
  has(body, 'owner.hasAtoms === false) return edit.textContent');
});

test('投影校正只在"打开的是另一条 / 原子集合变了"时重铺，且不碰整表', async () => {
  const body = fnBody('refresh', 'function refreshCellProjection(');
  has(body, 'sameCellSurface(owner, edit, open, atoms)');
  has(body, "edit !== cellOverlay?.querySelector('.mp-cell-overlay-text')");
  lacks(body, 'querySelectorAll', 'refreshing must not scan the table');
  lacks(body, 'contentDOM');
  for (const gate of ['cellComposing || view.composing || view.state.readOnly', 'cellProjecting']) {
    has(body, gate, 'the per-key path must bail out early on: ' + gate);
  }
  // 纯文本格连选区都不读：includes 判定必须排在 cellDOMSelection 之前。
  const plainGate = body.indexOf("if (!text.includes('$') && !owner.hasAtoms) return false;");
  const rangeRead = body.indexOf('cellDOMSelection(edit)');
  assert.ok(plainGate > 0, 'plain cells must hit the text gate first');
  assert.ok(rangeRead > plainGate, 'cellDOMSelection must come after the $ gate');
});

/* ── 缺陷 A：原生点击只改 DOM 选区，必须据此收掉投影 ─────────── */

test('真机点击回归：selectionchange 必须在光标离开公式后收掉投影（不只在 input 时）', async () => {
  has(MAIN, 'function scheduleCellProjectionRefresh(edit)');
  // 该调度器必须真的挂在 selectionchange 上（真机点击只派发选区变化，不派发 input）。
  // 取**调用点**（带分号），不是函数定义。
  const call = MAIN.indexOf('scheduleCellProjectionRefresh(edit);');
  assert.ok(call > 0, 'the scheduler must actually be called');
  const wiring = MAIN.slice(Math.max(0, call - 1200), call);
  has(wiring, "document.addEventListener('selectionchange'", 'projection must follow native selection changes');
  const body = fnBody('schedule', 'function scheduleCellProjectionRefresh(');
  has(body, 'requestAnimationFrame');
  has(body, 'cellProjecting');
  has(body, 'cellComposing');
  has(body, 'dom.head === cellProjectionLastHead', 'an unchanged collapsed caret must not re-project (self-excitation guard)');
  has(body, 'refreshCellProjection(target)');
});

test('an active drag owns both source endpoints through projection changes', () => {
  const body = fnBody('drag', 'function beginCellPointerSelection(');
  has(body, 'setCellDOMSelection(edit, anchor, head)');
  has(body, 'syncCellSelection(edit, mapped)');
  has(body, 'continueTableSelection(');
  has(fnBody('refresh', 'function refreshCellProjection('), 'if (!dom || dom.anchor !== dom.head) return false');
});

test('重铺期间挡住选区回灌：syncCellSelection 与 selectionchange 不许自激', async () => {
  const sync = fnBody('syncCellSelection', 'function syncCellSelection(');
  has(sync, 'if (cellProjecting) return;', 'our own DOM selection write must not be mirrored back');
  const seed = fnBody('seed', 'function seedCellEditSurface(edit, text, openIndex)');
  has(seed, 'cellProjecting = true');
  has(seed, 'cellProjecting = wasProjecting', 'the guard must be restored even when seeding throws');
  has(seed, 'finally');
  has(MAIN, 'function resetCellProjectionState()');
});

/* ── 缺陷 B：插字不该让没变的公式每键重建 ───────────────────── */

test('插字不重建：是否重铺按"原子源码值"对账，不按旧 parts 的 from/to 切新文本', async () => {
  const { surfaceMatches } = await logic;
  // 公式前面插了字 ⇒ 偏移全变，但原子的源码值没变 ⇒ 必须判"无需重铺"。
  const before = ['$a_1$', '$b^2$'];
  assert.equal(surfaceMatches(-1, before, -1, ['$a_1$', '$b^2$']), true,
    'inserting plain text before a formula must not rebuild it');
  assert.equal(surfaceMatches(-1, before, -1, ['$a_1$']), false, 'a removed formula must rebuild');
  assert.equal(surfaceMatches(-1, before, -1, ['$a_1$', '$b^3$']), false, 'an edited formula must rebuild');
  assert.equal(surfaceMatches(0, before, -1, ['$b^2$']), false, 'changing which formula is open must rebuild');
  // 空对空：没有公式的格永远不必重铺。
  assert.equal(surfaceMatches(-1, [], -1, []), true);
  assert.equal(surfaceMatches(-1, null, -1, []), true, 'a missing live list is treated as empty');
});

test('对账读的是当前 DOM 里原子的真实源码值（不是缓存下标）', async () => {
  const live = fnBody('live atoms', 'function cellLiveAtoms(edit)');
  has(live, 'querySelectorAll(CELL_ATOM_SELECTOR)');
  has(live, 'cellAtomSource(node)', 'live atoms must read their own data-mp-cell-src');
  const same = fnBody('same surface', 'function sameCellSurface(owner, edit, open, atoms)');
  has(same, 'surfaceMatches(open, cellLiveAtoms(edit), open, atoms)');
  lacks(same, 'text.slice(', 'must never slice the new text with cached from/to');
  lacks(same, 'surface.parts', 'cached parts from/to must not decide whether to rebuild');
});

test('绘制计划与打开判定共用同一个 renderable：不可渲染的公式两边都不排版', async () => {
  const { cellSurfacePlan, openMathIndex, cellMathParts } = await logic;
  const unrenderable = (tex) => tex !== 'bad';
  const source = '前 $bad$ 中 $ok$ 后';
  const plan = cellSurfacePlan(source, -1, unrenderable);
  assert.equal(plan.filter(s => s.kind === 'atom').length, 1, 'only the renderable formula becomes an atom');
  assert.equal(plan.find(s => s.kind === 'atom').src, '$ok$');
  const parts = cellMathParts(source, unrenderable);
  const badIndex = parts.findIndex(p => p.tex === 'bad');
  assert.equal(openMathIndex(parts, parts[badIndex].from + 1), -1, 'an unrenderable formula never opens');
});

test('普通键入不重铺 DOM：原子集合相同即返回（每键零 KaTeX、零节点重建）', async () => {
  const body = fnBody('seed inner', 'function seedCellEditSurfaceInner(');
  // 内容由纯模块的 cellSurfacePlan 决定（单测钉住），DOM 侧只做落地。
  has(body, 'const parts = cellPartsOf(text)');
  has(body, 'atomizedParts(parts, openIndex)');
  lacks(body, 'innerHTML', 'seeding must not parse HTML');
  lacks(body, 'renderToString', 'KaTeX parsing belongs to renderMathDOM/renderMathHTML only');
  // splice 规则：只有 atom 建 span，文字一律文本节点（不做整段重排）。
  has(body, "if (to > from) frag.appendChild(document.createTextNode(text.slice(from, to)))");
  has(body, 'frag.appendChild(cellAtomNode(text.slice(part.from, part.to), part))');
  has(fnBody('parts', 'function cellPartsOf('), 'cellMathParts(source, cellRenderableMath)');
});

/* ── 绘制计划：把"该画什么"变成可断言的值（不靠肉眼） ─────── */

test('绘制计划：只有未打开的公式成为原子，且每个原子携带它自己的原文', async () => {
  const { cellSurfacePlan } = await logic;
  const plan = cellSurfacePlan(MIXED, -1);
  assert.deepEqual(plan.map(s => s.kind), ['text', 'atom', 'text', 'atom', 'text']);
  const atoms = plan.filter(s => s.kind === 'atom');
  assert.deepEqual(atoms.map(a => a.src), ['$a_1$', '$b^2$']);
  assert.deepEqual(atoms.map(a => a.tex), ['a_1', 'b^2']);
  assert.deepEqual(atoms.map(a => a.display), [false, false]);
  // 打开第二条 ⇒ 它回到文字形态（源码），第一条仍是原子。
  const openSecond = cellSurfacePlan(MIXED, 3);
  assert.deepEqual(openSecond.map(s => s.kind), ['text', 'atom', 'text', 'text', 'text']);
  assert.equal(openSecond[3].kind, 'text');
  assert.equal(openSecond[3].src, '$b^2$');
  assert.equal(openSecond.filter(s => s.kind === 'atom').length, 1);
  // 全摊（Ctrl+E）⇒ 一个原子都不剩。
  assert.equal(cellSurfacePlan(MIXED, -2).filter(s => s.kind === 'atom').length, 0);
});

test('绘制计划的纯文本读回逐字节等于格文本（镜像/选区/撤销的坐标契约）', async () => {
  const { cellSurfacePlan, surfacePlanText } = await logic;
  for (const source of [MIXED, '就是一句话', '$$ \\sum_i x_i $$', '', 'a `$x$` b $y+1$ c']) {
    for (const open of [-2, -1, 0, 1, 2, 3, 4]) {
      const plan = cellSurfacePlan(source, open);
      assert.equal(surfacePlanText(plan), source, 'plan(' + source + ', open=' + open + ') must read back losslessly');
    }
  }
});

test('计划内落点：原子内部只贴两端（永远不会停在公式源码中间）', async () => {
  const { cellSurfacePlan, planBoundary } = await logic;
  const plan = cellSurfacePlan(MIXED, -1);
  const atom = plan[1];
  assert.equal(atom.kind, 'atom');
  const left = planBoundary(plan, atom.from + 1, false);
  const right = planBoundary(plan, atom.from + 1, true);
  assert.deepEqual([left.index, left.offset], [1, 0], 'assoc backwards stops before the atom');
  assert.deepEqual([right.index, right.offset], [1, 1], 'assoc forwards stops after the atom');
  // 公式之后的文字照常按字符落。
  const inside = planBoundary(plan, atom.to + 1, true);
  assert.equal(inside.index, 2);
  assert.equal(inside.offset, 1);
});

/* ── 复制/剪切给源码 ───────────────────────────────────── */

test('复制与剪切共用同一套序列化：跨未展开原子时给闭合的 $…$ 原文', async () => {
  const { planSlice, cellSurfacePlan } = await logic;
  const plan = cellSurfacePlan(MIXED, -1);           // 两条公式都是未展开的 atom
  const [first, second] = plan.filter(s => s.kind === 'atom');
  // 整条公式被覆盖 ⇒ 必须给出完整的闭合源码（这是"闭合原子原文丢失"的判据）。
  assert.equal(planSlice(plan, first.from, first.to), '$a_1$');
  assert.equal(planSlice(plan, second.from, second.to), '$b^2$');
  // 只覆盖公式的**一部分** ⇒ 仍然给整条闭合公式，绝不给半条或 KaTeX 字形。
  assert.equal(planSlice(plan, first.from + 2, first.to - 1), '$a_1$');
  // 从文字跨进公式 ⇒ 文字照原样 + 整条公式。
  assert.equal(planSlice(plan, 0, first.to), '前文 $a_1$');
  // 两条都跨 ⇒ 中间文字与两条公式都在，顺序不变。
  assert.equal(planSlice(plan, 0, second.to), '前文 $a_1$ 中间 $b^2$');
  // 纯文字区间不受公式规则影响。
  assert.equal(planSlice(plan, 0, 2), '前文');
  // 空/退化区间不产生内容。
  assert.equal(planSlice(plan, 5, 5), '');
  assert.equal(planSlice(plan, 9, 3), '');
  // 整格选中 = 整格源码（与 Ctrl+E 口径一致）。
  assert.equal(planSlice(plan, 0, MIXED.length), MIXED);
});

test('单元格复制/剪切处理器：copy 与 cut 走同一个入口，且必须防止 KaTeX 字形入剪贴板', async () => {
  has(MAIN, 'div.addEventListener("copy", cellOverlayCopyAtoms)');
  has(MAIN, 'div.addEventListener("cut", cellOverlayCopyAtoms)', 'cut must share the handler');
  assert.equal((MAIN.match(/cellOverlayCopyAtoms\)/g) || []).length, 2, 'both copy and cut are wired');
  const scope = fnBody('copy handler', 'function cellOverlayCopyAtoms(');
  // 序列化只有一份来源（纯模块的 planSlice），不许在 handler 里再拼一遍。
  has(scope, 'cellPlainSelection(div, range)');
  has(scope, 'cellPlainWriteClipboard(event.clipboardData, slice.text)');
  lacks(scope, 'cloneContents', 'cloneContents clones atoms as elements => KaTeX glyphs leak');
  // 纯文字选区让位给浏览器（原有行为不变）。
  has(scope, 'if (!cellSelectionTouchesAtom(div, range)) return;');
});

test('剪切：先写剪贴板，写成功才删；只删与复制同一段源码', async () => {
  const scope = fnBody('copy handler', 'function cellOverlayCopyAtoms(');
  has(scope, 'const wrote = cellPlainWriteClipboard(event.clipboardData, slice.text);');
  // 删除用的是同一个 slice 区间（不按 DOM 重新推断，避免两套口径）。
  has(scope, 'deleteCellPlainRange(div, slice.from, slice.to);');
  lacks(scope, 'cellDOMSelection(div)', 'the cut range must not be re-derived from the DOM');
  // 一次 DOM 改动 → 既有镜像 diff → 一条历史记录（可撤销）。
  has(scope, 'syncCellEdit(div);');
  // 光标落在被剪起点。
  has(scope, 'setCellDOMSelection(div, slice.from, slice.from);');
  // 归到 delete 类，剪切是独立撤销组（不并进前一段键入）。
  has(scope, "div.__mpCellInputType = 'deleteByCut';");
});

/* ── 剪切的默认回退语义：拦不住就不能删，拦得住才自己删 ───── */

test('剪切失败（剪贴板写不进）也必须拦下浏览器默认删除，文档保持原样', async () => {
  /* 用假事件跑**真实**的处理逻辑：这是本族最容易写错的地方 ——
     "只 return 不 preventDefault" 会让浏览器把选区删掉，用户既丢内容又没剪贴板。 */
  const cases = [
    // [类型, cancelable, 剪贴板能否写入, 只读, 组字中] → 期望 { prevented, deleted }
    ['cut', true, false, false, false, { prevented: true, deleted: 0 }],   // 写失败：拦住且不删
    ['cut', true, true, false, false, { prevented: true, deleted: 1 }],    // 正常剪切：拦住且删
    ['cut', true, true, true, false, { prevented: true, deleted: 0 }],     // 只读：拦住且不删
    ['cut', true, true, false, true, { prevented: true, deleted: 0 }],     // 组字中：拦住且不删
    ['copy', true, false, false, false, { prevented: false, deleted: 0 }], // 复制写失败：交给浏览器
    ['copy', true, true, false, false, { prevented: true, deleted: 0 }],   // 正常复制：拦住给源码
    ['copy', true, true, true, false, { prevented: true, deleted: 0 }],    // 只读：**仍然**给源码
    ['cut', false, true, false, false, { prevented: false, deleted: 0 }],  // 不可取消：完全不接管
  ];
  for (const [type, cancelable, canWrite, readOnly, composing, want] of cases) {
    const result = runCopyHandler({ type, cancelable, canWrite, readOnly, composing });
    const label = `${type} cancelable=${cancelable} wrote=${canWrite} readonly=${readOnly} ime=${composing}`;
    assert.equal(result.prevented, want.prevented, 'preventDefault for ' + label);
    assert.equal(result.deleted, want.deleted, 'delete calls for ' + label);
  }
});

test('atom 删掉＝整条公式从源码里消失（与 Typora 把行内公式当整体删同语义）', async () => {
  const body = scope('delete range', 'function deleteCellPlainRange(', 'function syncCellSelection(');
  // 与 planSlice 同一条规则：交集非空就整条删（部分覆盖也删整条，避免剪贴板与原文对不上）。
  has(body, 'if (pos < to && pos + len > from) remove.push({ node: child })');
  has(body, 'parentNode.removeChild(item.node)');
});

/* ── 组字交接：A 格未上屏时点 B 格（实测 ime-new2 / ime-old2） ─────────────
   缺陷：共享覆盖层立刻显示 B，Chromium 不给 A 送 compositionend ⇒ cellComposing 卡在 true、
   桥的 isComposing 一直 true，A、B 都收不到那段中文，随后连 ASCII 也都不进。
   修法：切换/失焦/换文档之前，先按**原格**安全收尾（blur 交还 IME 让候选真的上屏）。 */

test('交接前必须按原格收尾：点别的格会先收尾在途组字（否则内容永远不上屏）', async () => {
  const click = fnBody('tableCellClick', 'const tableCellClick = EditorView.domEventHandlers({');
  /* 只有"确有在途组字"时才走跨格映射分支；该分支内部先 handoff 再映射，最后才激活。 */
  const branch = click.indexOf('liveCellComposition()');
  const dispatch = click.indexOf('setActiveCell.of');
  assert.ok(branch > 0, 'the click path must take the composition branch only when a composition is live');
  assert.ok(dispatch > 0, 'the click path still dispatches the new active cell');
  assert.ok(branch < dispatch, 'the composition branch must resolve BEFORE the active cell moves');
  /* 普通点击（无组字）必须直接复用已解析范围：零追踪、零额外 dispatch。 */
  has(click, ': parsedTarget;', 'a plain click reuses the parsed target without any tracking');
  /* 交接确实发生在映射函数里，且在映射（mapPos）之前。 */
  const mapFn = fnBody('across', 'function cellTargetAcrossComposition(');
  const handoff = mapFn.indexOf('handoffCellComposition();');
  const mapping = mapFn.indexOf('noteCompositionTargetUpdate') >= 0 || mapFn.indexOf('compositionTargetProbe = probe') >= 0;
  assert.ok(handoff > 0, 'the mapping branch must hand off the in-flight composition');
  assert.ok(mapping, 'the mapping branch must register the one-shot probe');
  // 同一格内的组字不受影响（原有守卫仍在）。
  has(click, '((cellComposing || view.composing) || event.button !== 0)) return true;');
});

test('收掉覆盖层也必须先收尾（失焦/点正文/换文档都走这条路）', async () => {
  const body = fnBody('deactivate', 'function deactivateCellOverlay()');
  const handoff = body.indexOf('handoffCellComposition();');
  const clear = body.indexOf('cellEdit = null;');
  assert.ok(handoff > 0, 'deactivate must hand off before it drops the cell');
  assert.ok(clear > handoff, 'the session must be settled while cellEdit still points at the original cell');
  has(body, 'cellCompositionSession = null;');
});

test('只收尾一次：重复的 compositionend / 交接与事件双至都不会重复提交', async () => {
  const settle = fnBody('settle', 'function settleCellComposition(');
  has(settle, 'if (!session || session.done) { cellComposing = false; return false; }');
  has(settle, 'session.done = true;', 'the session is claimed before any commit');
  // 清账必须无条件（即便被 stale 守卫挡下），否则 cellComposing 会卡住。
  const claim = settle.indexOf('cellCompositionSession = null;');
  const staleGate = settle.indexOf('owner.rowFrom !== session.rowFrom');
  assert.ok(claim > 0 && staleGate > claim, 'bookkeeping is cleared before any stale bail-out');
});

test('取消不诈提交：空候选的 compositionend 清账但不写文档', async () => {
  const cancel = fnBody('cancel', 'function cancelCellComposition(');
  has(cancel, 'cellCompositionSession.cancelled = true;');
  const settle = fnBody('settle', 'function settleCellComposition(');
  has(settle, 'if (cancelled) return false;', 'a cancelled composition must not be committed');
  // compositionend 上真的接了取消分支。
  has(MAIN, "event && event.data === ''");
});

test('stale/换格/换文档不得写错位置：只镜像回会话自己那一格', async () => {
  const settle = fnBody('settle', 'function settleCellComposition(');
  for (const guard of ['owner.rowFrom !== session.rowFrom', 'owner.col !== session.col',
    'owner.from !== session.from', 'owner.to !== session.to']) {
    has(settle, guard, 'stale guard: ' + guard);
  }
  has(settle, '!edit.isConnected', 'a detached surface must not be committed');
  has(settle, 'view.state.readOnly');
  // 提交动作绑定在会话自己的编辑面上，不是"当前覆盖层那一格"。
  has(MAIN, 'commit: node => { syncCellEdit(node); noteCellMathInput(); }');
});

test('交接用 blur 让 Chromium 上屏（真实提交），且不把 tentative 写进新格', async () => {
  const handoff = fnBody('handoff', 'function handoffCellComposition(');
  has(handoff, 'edit.blur()', 'Chromium commits the pending candidate on blur');
  has(handoff, 'settleCellComposition();');
  // 交接只碰会话里的 edit，绝不碰新格。
  lacks(handoff, 'cellOverlay', 'hand-off must not touch the shared overlay (it may already show another cell)');
  lacks(handoff, 'activateCellOverlay');
});

/* ── 与既有契约并存 ─────────────────────────────────────── */

test('Ctrl+E 全选仍给出整格源码：先摊成纯源码再建选区', async () => {
  has(MAIN, 'selectAll ? CELL_OPEN_ALL : cellProjectionOpen');
  has(MAIN, 'setCellDOMSelection(div, 0, mapped.text.length)');
});

test('atom 是 contenteditable=false 的叶子：不会被拆开编辑，KaTeX 子树不参与选区', async () => {
  has(MAIN, "span.setAttribute('contenteditable', 'false')");
  has(MAIN, 'span.className = CELL_ATOM_CLASS');
  const css = scope('atom css', '.mp-cell-atom {', '.mp-cell-atom.mp-cell-atom-display');
  has(css, 'display: inline-block');
  has(css, 'vertical-align: baseline');
});

test('活动格公式预览不再与已排版公式重复（同一内容只画一次）', async () => {
  const body = scope('preview', 'function cellMathCaret()', 'function ensureCellMathPreview(');
  has(body, 'cellEdit.surface?.open');
});

test('the active formula uses source hit-testing for the initial click and the rest of the drag', () => {
  const body = fnBody('atom pointer', 'function cellAtomPointer(event)');
  has(body, 'cellPointerTextPosition(edit, event.clientX, event.clientY)');
  has(body, 'setCellDOMSelection(edit, anchor, pos)');
  has(body, 'beginCellPointerSelection(event, view)');
  const drag = fnBody('drag', 'function beginCellPointerSelection(');
  for (const type of ['keydown', 'wheel', 'blur', 'compositionstart', 'dragstart', 'contextmenu']) {
    has(drag, "'" + type + "'", 'cancel on ' + type);
  }
  const hit = fnBody('pointer hit', 'function cellPointerTextPosition(');
  has(hit, 'mathGlyphOffset', 'glyph -> tex offset must reuse the body rule');
  has(hit, 'texOffsetToCell', 'tex offset must map back to the cell source');
});

/* ── 点击已排版公式：位置一律现算（缓存只存 tex）────────────────────────
   缺陷：节点缓存里存了 part.from 这类**绝对格内偏移**。前文插字后公式源码不变 ⇒
   sameCellSurface 保留原节点（这是设计要求：普通输入不重建节点），旧 from 于是过期，
   点公式会落到错误位置。修法：缓存只存 tex/display，点击时用实节点在当前格源序列里的
   起点（DOM 兄弟源码长度累加，含 rendered atom）加局部字形偏移。 */

test('atom 缓存只存 tex/display，不缓存任何绝对位置', async () => {
  const body = fnBody('atom node', 'function cellAtomNode(');
  has(body, 'cellAtomParts.set(span, { tex: part.tex, display: !!part.display, width: part.width, lead: part.lead });');
  // 绝不把 part 整个塞进去（那会带上过期的 from/to）。
  lacks(body, 'cellAtomParts.set(span, part)', 'the whole part would carry a stale absolute from');
  lacks(body, 'from:', 'no absolute offset may be cached on the node');
});

test('点击位置 = 节点当前起点 + 局部字形偏移（不读 KaTeX textContent、不搜公式字符串）', async () => {
  const body = fnBody('pointer', 'function cellPointerTextPosition(');
  has(body, 'cellPlainStart(div, atom)', 'the atom start is measured from the current DOM each click');
  has(body, 'texOffsetToCell(', 'the glyph offset is converted within the atom itself');
  lacks(body, 'part.from', 'a cached absolute offset must never be used');
  lacks(body, 'textContent', 'rendered KaTeX glyphs must not be read as source');
  lacks(body, 'indexOf(', 'no formula-string search');
  // 起点按 DOM 兄弟的源码长度累加（含 rendered atom），这是 cellPlainStart 的既有口径。
  const start = fnBody('plain start', 'function cellPlainStart(');
  has(start, 'cellPlainLength(prev)');
});

test('前文增/删字后复用同一 atom 节点：点击仍落在该公式的正确位置', async () => {
  const { cellMathParts, openMathIndex, texOffsetToCell } = await logic;
  /* 真实演算：复用节点 ⇒ 节点只知道 tex；起点由"当前格源序列"决定。
     这里用与产品同一条规则手算：起点 = 该公式在文本里的 from。 */
  for (const before of ['', '前文', '很长很长的一段前文']) {
    const text = before + '$a_1$ 中间';
    const parts = cellMathParts(text);
    const mathIndex = parts.findIndex(p => p.kind === 'math');
    const part = parts[mathIndex];
    // 起点随前文长度变化（这就是"现算"能对、缓存绝对偏移会错的原因）。
    assert.equal(part.from, before.length);
    // 局部字形偏移换算后加上起点 = 绝对格内坐标。
    for (const glyph of [0, 1, 3]) {
      const local = texOffsetToCell({ ...part, from: 0, to: part.to - part.from }, glyph);
      assert.equal(part.from + local, texOffsetToCell(part, glyph),
        'start + local offset must equal the absolute position');
    }
    assert.equal(openMathIndex(parts, part.from + 1), mathIndex);
  }
});

test('两个完全相同的公式：各自落到自己那一段（不靠搜索字符串）', async () => {
  const { cellMathParts, texOffsetToCell } = await logic;
  const text = '$x$ 和 $x$';
  const math = cellMathParts(text).filter(p => p.kind === 'math');
  assert.equal(math.length, 2, 'the fixture must really contain two identical formulas');
  assert.equal(math[0].tex, math[1].tex);
  /* 两条的绝对起点不同；点第二条必须得到第二条的坐标（起点 + 局部偏移），不是第一条。 */
  const secondStart = math[1].from;
  const local = texOffsetToCell({ ...math[1], from: 0, to: math[1].to - math[1].from }, 0);
  const absolute = secondStart + local;
  assert.ok(absolute > math[0].to, 'clicking the second formula must land after the first');
  assert.equal(absolute, secondStart + 1, 'glyph 0 of that formula is right after its opening $');
  assert.equal(text.slice(absolute, absolute + 2), 'x$');
});

test('活动格最近一次 text→parts 复用，但文本一变立刻失效（无全表缓存）', async () => {
  const body = fnBody('parts cache', 'function cellPartsOf(');
  has(body, 'cellPartsCache.text === source', 'the cache is keyed by the exact text');
  has(body, 'cellMathParts(source, cellRenderableMath)', 'a miss re-parses with the shared scanner');
  // 只有一条缓存（活动格最近一次），不是按格/按表的历史。
  const decl = MAIN.slice(MAIN.indexOf('let cellPartsCache'), MAIN.indexOf('let cellPartsCache') + 160);
  has(decl, 'text: null, parts: null');
  lacks(decl, 'Map', 'no per-cell / whole-table cache');
  // 同一次刷新里两处都走缓存（不再直接调扫描器）。
  const refresh = fnBody('refresh', 'function refreshCellProjection(');
  lacks(refresh, 'cellMathParts(', 'the refresh path must reuse the cached parts');
  has(refresh, 'cellPartsOf(text)');
});

test('two drag endpoints open only their two formulas', async () => {
  const { cellMathParts, atomizedParts } = await logic;
  const text = '$a$ + $b$ + $c$ + $d$';
  const parts = cellMathParts(text);
  const indexes = parts.flatMap((p,i) => p.kind === 'math' ? [i] : []);
  const got = atomizedParts(parts, [indexes[0], indexes[2]]).filter(p => p.kind === 'math');
  assert.deepEqual(got.map(p => p.atom), [false,true,false,true]);
});
