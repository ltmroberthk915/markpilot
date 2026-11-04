// 浮层公式 pointer 手势守卫测试·共享吸附核心版（node --test；无 DOM / GUI / 服务）。
// 公开树位置：tools/quality/tests/float-gesture-guard.test.mjs
// 运行：node --test tools/quality/tests/float-gesture-guard.test.mjs（MP_MAIN_JS 可指向任意副本）。
// 红绿口径（对当前公共源＝float-final 形态）：臂 1/2/9/10/11 红；应用 float-snap-shared 的
// A/B 补丁后 12/12 绿。夹具逐字节执行 main.js 的真实手势块、真实 mathPointerSelectionSnap
// 过滤器与真实 mathSnapRange 核心；applyCM 按 dist 语义建模落账（eq 则不 dispatch、dispatch
// 后可被过滤器改写），不逐步构造完整 EditorState。
// 已修的夹具缺陷（v1 教训）：函数声明提取从首个 { 起配平（参数闭括号不再提前截断）；
// exactFloatingClicks 检验 get 返回的**实例**（CM eq 跳派发时 owner.state.selection 是旧等值对象）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');
const { EditorSelection } = createRequire(path.join(root, 'dsh-markpilot', 'src-cm6', 'main.js'))('@codemirror/state');

const mainPath = process.env.MP_MAIN_JS ? path.resolve(process.env.MP_MAIN_JS)
  : path.join(root, 'dsh-markpilot', 'src-cm6', 'main.js');
const source = readFileSync(mainPath, 'utf8');

const DECL = 'const floatingPointerStarts = new WeakMap(), exactFloatingClicks = new WeakSet();';
const MARKER = 'const floatingSelectionStyle = EditorView.mouseSelectionStyle.of((owner, down) => {';
const CORE_FN = 'function mathSnapRange(spans, r, previousMain) {';
const FILTER = 'const mathPointerSelectionSnap = EditorState.transactionFilter.of((tr) => {';

/** 抽一条完整语句（标记起、最外层括号配平回零止；适用于 `const …of((tr) => {…});` 形）。 */
function extractStmt(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) throw new Error('marker not found: ' + marker + ' in ' + mainPath);
  if (text.indexOf(marker, at + 1) >= 0) throw new Error('marker not unique: ' + marker);
  let depth = 0, seenOpen = false, end = -1;
  for (let i = at; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '{' || ch === '[') { depth++; seenOpen = true; }
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (seenOpen && depth === 0) { end = text[i + 1] === ';' ? i + 2 : i + 1; break; }
      if (depth < 0) throw new Error('unbalanced scan at marker: ' + marker);
    }
  }
  if (end < 0) throw new Error('statement end not found: ' + marker);
  return text.slice(at, end);
}
/** 抽函数声明：从标记起到函数体首个 { 的配平 } 止（v1 在参数闭括号处提前截断的修复）。 */
function extractFn(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) throw new Error('function marker not found: ' + marker + ' in ' + mainPath);
  if (text.indexOf(marker, at + 1) >= 0) throw new Error('function marker not unique: ' + marker);
  const open = text.indexOf('{', at);
  if (open < 0) throw new Error('function body not found: ' + marker);
  let depth = 0, end = -1;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error('function end not found: ' + marker);
  return text.slice(at, end);
}
/** 抽手势块（DECL +（可选块注释）+ 工厂）；serial 旧版与所有权新版同形。 */
function extractFloatBlock(text) {
  const at = text.indexOf(MARKER);
  if (at < 0) throw new Error('float gesture factory marker not found in ' + mainPath);
  const stmt = extractStmt(text, MARKER);
  const declAt = text.lastIndexOf(DECL, at);
  if (declAt < 0) throw new Error('WeakMap decl not found before factory');
  const between = text.slice(declAt + DECL.length, at).trim();
  if (between !== '' && !/^\/\*[\s\S]*\*\/$/.test(between)) throw new Error('unexpected text between decl and factory');
  return text.slice(declAt, declAt + DECL.length) + (between ? '\n' + between + '\n' : '\n') + stmt;
}

const serialBox = { value: 1 };
const regionIndexField = Symbol('regionIndexField.sentinel');
const mathSpansField = Symbol('mathSpansField.sentinel');
const floatBox = {};
const stubs = {
  EditorView: { mouseSelectionStyle: { of: (factory) => factory } },
  EditorState: { transactionFilter: { of: (fn) => fn } },
  Transaction: { userEvent: 'uiEvent' },
  viewportIntent: { serial: () => serialBox.value },
  floatSourcePosition: (box, owner, event) => (event && event.__glyphPos != null ? event.__glyphPos : null),
};

/** 真实 mathSnapRange 核心（float-final 公共源上不存在 ⇒ null，相关臂红）。 */
const snapCore = source.includes(CORE_FN)
  ? new Function('EditorSelection', extractFn(source, CORE_FN) + '\n;return mathSnapRange;')(EditorSelection)
  : null;
/** 用与指定 bundle 同一 exactFloatingClicks 实例编译真实过滤器（旁路豁免才可见）。 */
function compileFilterFor(bundle) {
  return new Function('EditorState', 'EditorSelection', 'Transaction', 'mathSpansField', 'exactFloatingClicks', 'mathSnapRange',
    extractStmt(source, FILTER) + '\n;return mathPointerSelectionSnap;')(
    stubs.EditorState, EditorSelection, stubs.Transaction, mathSpansField, bundle.exactFloatingClicks, snapCore);
}
function compileFloat(blockText) {
  const fn = new Function('EditorView', 'EditorSelection', 'viewportIntent', 'regionIndexField', 'floatSourcePosition', 'mathSnapRange', 'mathSpansField',
    blockText + '\n;return { floatingPointerStarts, exactFloatingClicks, floatingSelectionStyle };');
  return fn(stubs.EditorView, EditorSelection, stubs.viewportIntent, regionIndexField, stubs.floatSourcePosition, snapCore, mathSpansField);
}
const newBundle = () => compileFloat(extractFloatBlock(source));

// 假 owner：field 只应答哨兵字段（spans 默认 $x+y$＝24..29）；__docPos 模拟 posAtCoords。
function makeOwner({ epoch = 7, spans = [{ from: 24, to: 29, display: false }], sel0 = [28, 28] } = {}) {
  const owner = {
    composing: false, __epoch: epoch, __docPos: null,
    contentDOM: { contains: () => true },
    posAtCoords: () => owner.__docPos,
    state: {
      field: (f) => (f === regionIndexField ? { epoch: owner.__epoch } : f === mathSpansField ? { spans } : undefined),
      selection: EditorSelection.single(sel0[0], sel0[1]),
    },
  };
  return owner;
}
function mkEvent(x, glyphPos, { shift = false } = {}) {
  return {
    clientX: x, clientY: 136, shiftKey: shift, detail: 1, __glyphPos: glyphPos,
    target: { closest: (sel) => (sel === '.mp-inline-float' ? floatBox : null) },
  };
}
/** 模拟 CM select()＋真实过滤器：get() 产出与当前一致则不 dispatch（登记的仍是返回实例）；
 *  否则事务可被 mathPointerSelectionSnap 改写——落账的是改写后的选区。返回 {raw, applied}。 */
function applyCM(owner, style, event, filter) {
  const raw = style.get(event);
  if (raw && !raw.eq(owner.state.selection)) {
    const before = owner.state.selection;
    const out = filter({ docChanged: false, annotation: () => 'select.pointer', selection: raw,
      state: owner.state, startState: { selection: before } });
    owner.state.selection = Array.isArray(out) ? out[1].selection : raw;
  }
  return { raw, applied: owner.state.selection };
}
function startGesture(bundle, owner, { shift = false } = {}) {
  const filter = compileFilterFor(bundle);
  const down = mkEvent(265, 28, { shift });
  bundle.floatingPointerStarts.set(down, 28);
  const style = bundle.floatingSelectionStyle(owner, down);
  const first = applyCM(owner, style, down, filter);
  return { down, style, filter, downRaw: first.raw };
}
const main = (sel) => [sel.main.anchor, sel.main.head];

test('serial 守卫必须已移除（源级判别）', () => {
  assert.ok(!/viewportIntent\s*\.\s*serial/.test(extractFloatBlock(source)), 'block still gates on viewportIntent.serial');
});

test('伪 goalColumn 调用必须已移除（源级判别：r.assoc 不得占 range 第 3 参）', () => {
  assert.ok(!source.includes('EditorSelection.range(anchor, head, r.assoc)'),
    'mathPointerSelectionSnap 仍把 r.assoc 灌进 goalColumn 槽位（eq 无条件比较 goalColumn）');
});

test('裸 Shift / serial bump 后真实移动不得冻结选区（内浮 wheel 复放 28→25）', () => {
  const bundle = newBundle();
  const owner = makeOwner();
  const { style, filter } = startGesture(bundle, owner);
  serialBox.value++;
  const heads = [];
  for (const x of [263, 261, 259, 256, 254, 252, 250, 248, 245, 243, 241, 239, 236, 234, 232]) {
    owner.__docPos = null;
    heads.push(applyCM(owner, style, mkEvent(x, x > 252 ? 26 : 25), filter).applied.main.head);
  }
  assert.notEqual(new Set(heads).size, 1, '拖拽期间落账必须变化（"什么都没发生"不算通过）');
  assert.deepEqual(main(owner.state.selection), [28, 25]);
});

test('真正的后续 Ctrl+A 与外来同类 select.pointer 让位且粘滞', () => {
  const bundle = newBundle();
  const owner = makeOwner();
  const { style, filter } = startGesture(bundle, owner);
  owner.__docPos = 26; applyCM(owner, style, mkEvent(254, null), filter);
  const foreign = EditorSelection.single(0, 30);
  owner.state.selection = foreign;
  assert.equal(style.get(mkEvent(250, 25)), foreign, '必须原样让位给外来选区');
  const alien = { docChanged: false, annotation: () => 'select.pointer', selection: EditorSelection.single(26, 60),
    state: owner.state, startState: { selection: owner.state.selection } };
  const out = filter(alien);
  owner.state.selection = Array.isArray(out) ? out[1].selection : alien.selection;
  assert.equal(style.get(mkEvent(246, 25)), owner.state.selection, '外来同类指针（会被同型 snap 改写）也必须让位');
  assert.equal(style.get(mkEvent(244, 24)), owner.state.selection, '让位粘滞');
});

test('同文档 live 更新/等值重建选区不打断手势；span 失配退锚点（护栏，无判别力）', () => {
  const bundle = newBundle();
  const owner = makeOwner();
  const { style, filter } = startGesture(bundle, owner);
  const mid = applyCM(owner, style, mkEvent(254, 26), filter).applied;
  owner.state.selection = EditorSelection.single(mid.main.anchor, mid.main.head);
  owner.__docPos = 25;
  assert.equal(applyCM(owner, style, mkEvent(246, null), filter).applied.main.head, 25, '等值选区重建后手势继续');
  owner.__docPos = null;
  assert.equal(applyCM(owner, style, mkEvent(240, null), filter).applied.main.head, 28, '映射失配退回锚点');
});

test('换文档会话（epoch 变化）即使选区数值相同也必须让位', () => {
  const bundle = newBundle();
  const owner = makeOwner();
  const { style, filter } = startGesture(bundle, owner);
  const mid = applyCM(owner, style, mkEvent(254, 26), filter).applied;
  owner.__epoch = 8;
  owner.state.selection = EditorSelection.single(mid.main.anchor, mid.main.head);
  assert.equal(style.get(mkEvent(250, 25)), owner.state.selection, 'epoch 变化 ⇒ 不认领同数值选区，立即让位');
  assert.equal(style.get(mkEvent(244, 24)), owner.state.selection, '让位粘滞');
});

test('组字（composition）让位且粘滞', () => {
  const bundle = newBundle();
  const owner = makeOwner();
  const { style, filter } = startGesture(bundle, owner);
  owner.__docPos = 26; applyCM(owner, style, mkEvent(254, null), filter);
  owner.composing = true;
  assert.equal(style.get(mkEvent(250, 25)), owner.state.selection, '组字期间不得写手势选区');
  owner.composing = false;
  assert.equal(style.get(mkEvent(244, 24)), owner.state.selection, '让位粘滞：组字结束后也不复活');
});

test('shift-at-down 锚点保留与 exactFloatingClicks 登记（检验 get 返回实例；护栏）', () => {
  const bundle = newBundle();
  const owner = makeOwner();
  const { style, filter, downRaw } = startGesture(bundle, owner, { shift: true });
  assert.equal(owner.state.selection.main.anchor, 28, 'shift 按下沿用既有锚点');
  assert.ok(bundle.exactFloatingClicks.has(downRaw), 'shift 精确点击登记的是 get 返回实例');
  owner.__docPos = 25;
  assert.deepEqual(main(applyCM(owner, style, mkEvent(232, null, { shift: true }), filter).applied), [28, 25]);

  const plain = newBundle();
  const plainStart = startGesture(plain, owner);
  assert.ok(!plain.exactFloatingClicks.has(plainStart.downRaw), '非 shift 不登记');
  assert.equal(owner.state.selection.main.head, 28, '非 shift 落点＝down 的源码位');
  assert.equal(plainStart.style.update(), false, 'update() 语义保持');
});

test('reverse-to-prose：跨界合法 snap（28..52→24..52）后手势必须继续到 29..4', () => {
  const bundle = newBundle();
  const owner = makeOwner();
  const filter = compileFilterFor(bundle);
  const down = mkEvent(265, 28);
  bundle.floatingPointerStarts.set(down, 28);
  const style = bundle.floatingSelectionStyle(owner, down);
  owner.__docPos = 28; applyCM(owner, style, down, filter);
  const steps = [262, 258, 255, 251, 248, 244, 237, 202].map((x, i) => [x, [27, 27, 27, 27, 52, 50, 4, 4][i]]);
  const trace = [];
  for (const [x, head] of steps) {
    owner.__docPos = head;
    trace.push(applyCM(owner, style, mkEvent(x, null), filter).applied);
  }
  assert.ok(trace.some((s) => main(s).join('..') === '24..52'), '中途必须出现过合法 snap 落账 24..52');
  assert.deepEqual(main(owner.state.selection), [29, 4], '终态必须是 closing fence 29..4');
});

test('共享核心与真实过滤器逐例一致，且元数据（goalColumn/bidiLevel/assoc）保留', () => {
  assert.ok(snapCore, 'mathSnapRange 必须存在（float-final 上不存在 ⇒ 本臂红）');
  const owners = {
    inline: makeOwner(),
    display: makeOwner({ spans: [{ from: 24, to: 29, display: true }] }),
    none: makeOwner({ spans: [] }),
  };
  const R = EditorSelection.range;
  const cases = [
    ['inline', R(28, 27), R(28, 28)],
    ['inline', R(28, 52), R(28, 27)],
    ['inline', R(28, 50), R(24, 52)],
    ['inline', R(28, 4), R(24, 50)],
    ['inline', R(28, 52, 40), R(28, 27)],           // goalColumn=40 必须随吸附保留
    ['inline', R(24, 52), R(24, 52)],                // previous-eq：不改写
    ['inline', R(24, 29), R(28, 28)],                // 端点恰在边界：严格内含才吸附
    ['inline', R(28, 28), R(28, 28)],                // 空 range：不改写
    ['display', R(28, 52), R(28, 27)],               // display span 不参与
    ['none', R(28, 52), R(28, 27)],                  // 无 span：不改写
  ];
  for (const [key, range, prevRange] of cases) {
    const owner = owners[key];
    const sel = EditorSelection.create([range], 0);
    const before = EditorSelection.create([prevRange], 0);
    owner.state.selection = before;
    const out = compileFilterFor(newBundle())({ docChanged: false, annotation: () => 'select.pointer',
      selection: sel, state: owner.state, startState: { selection: before } });
    const applied = Array.isArray(out) ? out[1].selection : sel;
    const core = snapCore(owner.state.field(mathSpansField).spans, range, before.main);
    const expected = EditorSelection.create([core || range], 0);
    assert.ok(applied.eq(expected), `核心必须等于过滤器落账：${range.anchor}..${range.head} @ ${key}`);
    if (core) {
      assert.equal(applied.main.goalColumn, range.goalColumn, 'goalColumn 必须原样保留');
      assert.equal(applied.main.bidiLevel, range.bidiLevel, 'bidiLevel 必须原样保留');
      assert.equal(applied.main.assoc, range.assoc, 'assoc 必须原样保留');
    }
  }
});

test('Shift+down 跨 span（锚在外段）＋继续拖：down 落账原始端点，后续按真实吸附继续', () => {
  const bundle = newBundle();
  const owner = makeOwner({ sel0: [20, 20] });
  const { style, filter, downRaw } = startGesture(bundle, owner, { shift: true });
  assert.deepEqual(main(downRaw), [20, 28], 'down 产出＝锚 20 到点 28 的精确端点');
  assert.deepEqual(main(owner.state.selection), [20, 28], 'down 落账必须保持原始（exactFloatingClicks 旁路，head 28 在 span 内也不吸附）');
  const trace = [];
  for (const [x, head] of [[258, 30], [254, 26], [244, 50], [202, 4]]) {
    owner.__docPos = head;
    trace.push(applyCM(owner, style, mkEvent(x, null), filter).applied);
  }
  assert.deepEqual(main(trace[1]), [20, 29], 'head 26 内含、锚 20 在 span 外 ⇒ 吸附为 20..29');
  assert.deepEqual(main(owner.state.selection), [20, 4], '继续拖到 20..4，全程无让位');
});

test('等值但 goalColumn 不同的外来选区必须让位（eq 无条件比较 goalColumn）', () => {
  const bundle = newBundle();
  const owner = makeOwner();
  const { style, filter } = startGesture(bundle, owner);
  const mid = applyCM(owner, style, mkEvent(254, 26), filter).applied;
  owner.state.selection = EditorSelection.create([EditorSelection.range(mid.main.anchor, mid.main.head, 77)], 0);
  assert.equal(style.get(mkEvent(250, 25)), owner.state.selection, '同数字不同 goal ⇒ 是外来选区，必须让位');
});
