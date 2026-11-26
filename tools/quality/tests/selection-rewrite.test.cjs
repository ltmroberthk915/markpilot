'use strict';
/*
 * 选区 AI 润色审阅（内核 dsh-markpilot/src-cm6/selection-rewrite.js）的模块级回归。
 *
 * 为什么要这一支：这个功能**写用户正文**，最贵的错误是"覆盖错地方"。所以判据全部钉在
 * 「正文最终是什么」与「面板最终是什么」上，而不是"某个函数被调用了"：
 *   · 采纳 ⇒ 正文变成模型结果，且 **Ctrl+Z 一次**就完全回到润色前；
 *   · 放弃/超时/失败/取消 ⇒ 正文**逐字节不变**；
 *   · 原选区变化、正文被别处改过、文档被换掉 ⇒ 绝不写正文（针对性负例）；
 *   · 重复请求 ⇒ 只发一次网络请求，不叠第二个面板；
 *   · 输入法组字中的 Esc/Tab 不被面板吃掉；焦点在框外时面板不接管键盘。
 *
 * 运行：node --test tools/quality/tests/selection-rewrite.test.cjs
 *
 * 尺子说明：编辑器用**真的** @codemirror/state + @codemirror/commands（history 也是真的），
 * 只有 DOM 是这里的 60 行替身 —— 因为面板是普通 DOM，没有布局参与判据。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '../../..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

/* ───────── 极简 DOM 替身（只实现面板用到的那一小撮） ───────── */

class ClassList {
  constructor() { this.set = new Set(); }
  add(...names) { for (const name of names) if (name) this.set.add(name); }
  remove(...names) { for (const name of names) this.set.delete(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : !!force;
    if (on) this.set.add(name); else this.set.delete(name);
    return on;
  }
  contains(name) { return this.set.has(name); }
}

class FakeNode {
  constructor(nodeType, name) {
    this.nodeType = nodeType;         // 1 = 元素，3 = 文本
    this.nodeName = name;
    this.childNodes = [];
    this.parentNode = null;
    this.ownerDocument = null;
  }
  get textContent() { return this.childNodes.map(n => n.nodeType === 3 ? n.data : n.textContent).join(''); }
  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    const text = String(value ?? '');
    if (text) this.appendChild(new FakeText(text));
  }
  appendChild(child) {
    if (!child) return child;
    // 真 DOM 追加 DocumentFragment 会**搬走它的孩子**，不是嵌进去 —— 面板的对比视图正靠这一步。
    if (child.nodeType === 11) {
      for (const grand of [...child.childNodes]) this.appendChild(grand);
      child.childNodes = [];
      return child;
    }
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.childNodes.push(child);
    return child;
  }
  append(...nodes) { for (const node of nodes) this.appendChild(typeof node === 'string' ? new FakeText(node) : node); }
  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(node) {
    for (let cur = node; cur; cur = cur.parentNode) if (cur === this) return true;
    return false;
  }
}

class FakeText extends FakeNode {
  constructor(data) { super(3, '#text'); this.data = String(data); }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
}

class FakeElement extends FakeNode {
  constructor(tagName) {
    super(1, String(tagName).toUpperCase());
    this.tagName = this.nodeName;
    this.classList = new ClassList();
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.listeners = Object.create(null);
    this.buttons = [];
    this.disabled = false;
    this.id = '';
    this.type = '';
    this.tabIndex = -1;
    this.isFocused = false;
  }
  /* 真 DOM 里 className 与 classList 是同一个事实的两个写法；面板同时用到两者，
     替身必须把它们接起来，否则"类名有没有加上"这条判据量的是空气。 */
  get className() { return [...this.classList.set].join(' '); }
  set className(value) {
    this.classList.set.clear();
    for (const name of String(value ?? '').split(/\s+/)) if (name) this.classList.add(name);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = value;
  }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    const list = this.listeners[type];
    if (!list) return;
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  }
  dispatchEvent(event) {
    event.target ||= this;
    for (const fn of [...(this.listeners[event.type] || [])]) fn(event);
    return true;
  }
  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
    this.isFocused = true;
    return true;
  }
  click() {
    this.dispatchEvent({ type: 'click', target: this, preventDefault() { }, stopPropagation() { } });
    return true;
  }
}

function createDocument() {
  const doc = {
    createElement: (tag) => { const el = new FakeElement(tag); el.ownerDocument = doc; return el; },
    createTextNode: (text) => { const node = new FakeText(text); node.ownerDocument = doc; return node; },
    createDocumentFragment: () => { const frag = new FakeNode(11, '#document-fragment'); frag.ownerDocument = doc; return frag; },
    getElementById: (id) => {
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType !== 1) continue;
          if (child.id === id) return child;
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(doc.documentElement);
    },
    listeners: Object.create(null),
    addEventListener(type, fn) { (doc.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const list = doc.listeners[type];
      if (!list) return;
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    fire(type, event) {
      event.target ||= doc.activeElement || doc.body;
      for (const fn of [...(doc.listeners[type] || [])]) fn(event);
    },
    hasFocus: () => true,
    activeElement: null,
  };
  doc.documentElement = doc.createElement('html');
  doc.head = doc.createElement('head');
  doc.body = doc.createElement('body');
  doc.documentElement.append(doc.head, doc.body);
  doc.activeElement = doc.body;
  return doc;
}

/* ───────── 用真的 CM6 state 冒充 view ───────── */

function makeView({ EditorState, history, doc: text, anchor, head }) {
  let state = EditorState.create({
    doc: text,
    selection: { anchor, head },
    extensions: [history()],
  });
  const view = {
    dom: { isConnected: true },
    contentDOM: null,
    get state() { return state; },
    dispatch(spec) { state = state.update(spec).state; },
    focus() { view.focused = true; },
    coordsAtPos() { return null; },        // 没有布局 ⇒ 锚点绘制自己会跳过
    posAtDOM() { return 0; },
  };
  return view;
}

const MODULES = Promise.all([
  load('dsh-markpilot/src-cm6/selection-rewrite.js'),
  load('dsh-markpilot/node_modules/@codemirror/state/dist/index.js'),
  load('dsh-markpilot/node_modules/@codemirror/commands/dist/index.js'),
]);

/** 一轮完整的装置：装内核、接管全局 document、给出可控的 transport。 */
async function harness({ text = '这是一段需要润色的文字。', anchor = 1, head = null, reply, bridge } = {}) {
  const [kernel, stateMod, cmdMod] = await MODULES;
  const doc = createDocument();
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  globalThis.document = doc;
  /* bridge 非空时模拟"宿主桥已接好但没注入 request"的形态（走 hostTransport）；否则用注入的 request。 */
  globalThis.window = bridge ? { mpHost: bridge } : { mpHost: undefined };

  const view = makeView({
    EditorState: stateMod.EditorState,
    history: cmdMod.history,
    doc: text,
    anchor,
    head: head == null ? text.length - 2 : head,
  });

  const calls = [];
  const toasts = [];
  const events = [];
  const transport = reply || (async (payload, ctx) => { calls.push({ payload, ctx }); return { ok: true, text: '这是段需要润色的文字。' }; });

  /* 作用域：宿主切文档时会变（EXE 里是当前文件路径，插件里是文档 id）。 */
  const scopeBox = { value: 'doc-A' };

  const api = kernel.installSelectionRewrite({
    getView: () => view,
    toast: (message) => { toasts.push(String(message)); },
    /* 给了 bridge 就**不注入 request**：让内核走 hostTransport（这样才测到真实的宿主桥与取消通道）。 */
    ...(bridge ? {} : { request: async (payload, ctx) => { calls.push({ payload, ctx }); return transport(payload, ctx); } }),
    scopeOf: () => scopeBox.value,
    onState: (event) => { events.push(event); },
  });

  const restore = () => {
    api._internals.dispose();
    globalThis.document = previous.document;
    globalThis.window = previous.window;
  };
  return {
    kernel, stateMod, cmdMod, doc, view, api, calls, toasts, events, restore, transport,
    get scope() { return scopeBox.value; },
    set scope(next) { scopeBox.value = next; },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ═════════════════════ 纯函数：词级 diff ═════════════════════ */

test('词级 diff：中文逐字、英文按词，增删各自成段且能配成替换', async () => {
  const { wordDiff, diffSummary, segmentWords } = await MODULES.then(m => m[0]);
  assert.deepEqual(segmentWords('我们 a-b 好').map(x => x.text), ['我', '们', ' ', 'a-b', ' ', '好']);
  const summary = diffSummary(wordDiff('这个方案很好。', '这个方案不错。'));
  assert.equal(summary.changed, true);
  assert.deepEqual(summary.runs.filter(r => r.kind !== 'equal'),
    [{ kind: 'replace', before: '很好', after: '不错' }]);
  assert.deepEqual([summary.deleteChars, summary.insertChars], [2, 2]);
});

test('词级 diff 的负例：一字不改 ⇒ changed=false（面板必须说"没有改动"而不是给个空 diff）', async () => {
  const { wordDiff, diffSummary } = await MODULES.then(m => m[0]);
  assert.equal(diffSummary(wordDiff('原样不动的一段话。', '原样不动的一段话。')).changed, false);
  assert.equal(diffSummary(wordDiff('', '')).changed, false);
  // 纯插入：英文单词边界要保住，不能把 "cat" 拆成 "c"+"at"
  const insertOnly = diffSummary(wordDiff('the cat sat', 'the big cat sat'));
  assert.deepEqual(insertOnly.runs.filter(r => r.kind !== 'equal'), [{ kind: 'insert', before: '', after: 'big ' }]);
});

/* ═════════════════════ 请求体：只发选区 ═════════════════════ */

test('请求体只含选区：字段集合是白名单，整篇正文没有出口', async () => {
  const { buildRequest } = await MODULES.then(m => m[0]);
  const body = buildRequest({ text: '只有这一段', instruction: '更正式', language: 'zh-CN' });
  assert.deepEqual(Object.keys(body).sort(), ['app', 'instruction', 'language', 'purpose', 'selection']);
  assert.equal(body.selection, '只有这一段');
  // 负例：把整篇文档塞进任何一个字段都必须一看就知道（字段名不允许出现 doc/document/content/text 全文）
  assert.equal(JSON.stringify(body).includes('document'), false);
});

/* ═════════════════════ 回包清洗（主控报的四条反例，逐条钉死） ═════════════════════ */

test('反例①：结果以原文前缀开头时**不许**按前缀删字（旧实现吃掉了合法正文）', async () => {
  const { cleanReply } = await MODULES.then(m => m[0]);
  // 主控报的原样反例：原文 "收益持平"，回包 "收益持平，风险回落。"
  assert.equal(cleanReply('收益持平，风险回落。', '收益持平'), '收益持平，风险回落。');
  // 同一族：回包把原文当开头继续往下写
  assert.equal(cleanReply('原文全文\n\n润色后的新内容', '原文全文'), '原文全文\n\n润色后的新内容');
  // 回包恰好等于原文 ⇒ 原样返回（由内核判"没有改动"，而不是在这里吃字）
  assert.equal(cleanReply('收益持平', '收益持平'), '收益持平');
});

test('反例②：围栏起首且后面还有正文 ⇒ 围栏与后续正文都原样保留', async () => {
  const { cleanReply } = await MODULES.then(m => m[0]);
  const fenced = '```markdown\n收益持平\n```\n\n这是后续正文。';
  assert.equal(cleanReply(fenced, '原选'), fenced, '后续正文与围栏一个都不能丢');
  // 合法代码块作为结果（非 markdown 语言标记）也不能被剥
  assert.equal(cleanReply('```js\nconst a = 1;\n```', '原选'), '```js\nconst a = 1;\n```');
  // 只有"整段恰是一个 markdown/text 围栏块"才剥，且内部原样
  assert.equal(cleanReply('```markdown\n润色后的文字\n```', '原文'), '润色后的文字');
  assert.equal(cleanReply('```\n纯文本结果\n```', '原文'), '纯文本结果');
  // 原文本身就是围栏块 ⇒ 结果里的同种围栏是内容，必须留着
  assert.equal(cleanReply('```js\nconst a = 2;\n```', '```js\nconst a = 1;\n```'), '```js\nconst a = 2;\n```');
});

test('反例②b：尾随换行是合法正文（段落空行/结尾硬换行）⇒ 不许吞', async () => {
  const { cleanReply } = await MODULES.then(m => m[0]);
  assert.equal(cleanReply('甲\n\n', '甲'), '甲\n\n');
  assert.equal(cleanReply('第一段\n\n第二段\n', '原选'), '第一段\n\n第二段\n');
});

test('反例③④：空 / 纯空白回包 ⇒ 清洗层返回空串，绝不返回"可采纳的空结果"', async () => {
  const { cleanReply, isEmptyReply } = await MODULES.then(m => m[0]);
  assert.equal(cleanReply('', '原文'), '');
  assert.equal(cleanReply('   \n\n  ', '原文'), '');
  assert.equal(cleanReply('<<<SELECTION\n\nSELECTION>>>', '原文'), '', '只剩标记也是空');
  assert.equal(isEmptyReply(''), true);
  assert.equal(isEmptyReply(' \n\t '), true);
  assert.equal(isEmptyReply('甲'), false);
  // 尺子自证：空串在 diff 里确实等于"整段删除"
  const { wordDiff, diffSummary } = await MODULES.then(m => m[0]);
  const summary = diffSummary(wordDiff('这一段原文会被整段删掉', ''));
  assert.equal(summary.deleteChars > 0 && summary.insertChars === 0, true);
});

test('回包清洗：剥掉**我们自己的**回显标记与段落缩进，不乱动正文', async () => {
  const { cleanReply } = await MODULES.then(m => m[0]);
  assert.equal(cleanReply('<<<SELECTION\n甲\nSELECTION>>>', '原文'), '甲');
  // 段落开头的缩进是正文的一部分，不许被清掉
  assert.equal(cleanReply('  缩进要保留', '原文'), '  缩进要保留');
  assert.equal(cleanReply('\t制表符缩进', '原文'), '\t制表符缩进');
});

/* ═════════════════════ 采纳 = 一次可撤销事务 ═════════════════════ */

test('采纳：正文变成模型结果，且一次 Ctrl+Z 完全回到润色前（含选区）', async () => {
  const h = await harness({ text: '开头。这是一段需要润色的文字。结尾。', anchor: 3, head: 15 });
  try {
    assert.equal(h.api.open(), 'started');
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    const before = h.view.state.doc.toString();
    assert.equal(h.api.accept(), true);
    assert.equal(h.view.state.doc.toString(), '开头。这是段需要润色的文字。结尾。'.replace('这是段', '这是段'));

    // 用真 history 撤销一次
    const { undo } = h.cmdMod;
    const target = { get state() { return h.view.state; }, dispatch(tr) { h.view.dispatch(tr); } };
    const spec = { state: h.view.state, dispatch: (tr) => h.view.dispatch(tr) };
    assert.equal(undo(spec), true);
    assert.equal(h.view.state.doc.toString(), before, '一次撤销必须回到润色前逐字节相同');

    // 再 redo 一次回到润色后
    const redoSpec = { state: h.view.state, dispatch: (tr) => h.view.dispatch(tr) };
    assert.equal(h.cmdMod.redo(redoSpec), true);
    assert.equal(h.view.state.doc.toString(), '开头。这是段需要润色的文字。结尾。');
    void target;
  } finally { h.restore(); }
});

test('放弃：正文逐字节不变，面板撤掉', async () => {
  const h = await harness();
  try {
    const before = h.view.state.doc.toString();
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    assert.equal(h.api.reject('user'), true);
    assert.equal(h.view.state.doc.toString(), before);
    assert.equal(h.api.state().phase, 'idle');
    assert.equal(h.doc.body.childNodes.length, 0, '面板必须从 DOM 上摘掉');
  } finally { h.restore(); }
});

/* ═════════════════════ 针对性负例：绝不错误覆盖 ═════════════════════ */

test('负例：面板就绪后正文被别处改过 ⇒ 采纳被拒，用户的新输入保留', async () => {
  const h = await harness({ text: '前言 需要润色的一段 后记', anchor: 3, head: 10 });
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    // 模拟用户在正文前面插字（真实场景：等回包时继续写）
    h.view.dispatch({ changes: { from: 0, insert: 'X' } });
    const after = h.view.state.doc.toString();
    assert.equal(h.api.accept(), false, '正文变了就绝不能写');
    assert.equal(h.view.state.doc.toString(), after, '用户的新输入一个字都不能被覆盖');
    assert.ok(h.toasts.some(t => t.includes('已变化')), '必须给"原文已变化"的明确提示');
  } finally { h.restore(); }
});

test('负例：面板就绪后正文被**等长**替换 ⇒ 采纳被拒（长度判据挡不住，必须靠逐字节比对）', async () => {
  const h = await harness({ text: '前言 需要润色的一段 后记', anchor: 3, head: 10 });
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    // 等长替换：文档长度不变，位置不变，只有那几个字变了 —— 这是最阴的一种"别处改过"。
    assert.equal('需要润色的一段'.length, '已被别人改掉了'.length, '尺子自证：两个替换片段必须等长');
    h.view.dispatch({ changes: { from: 3, to: 10, insert: '已被别人改掉了' } });
    const after = h.view.state.doc.toString();
    assert.equal(after.length, '前言 需要润色的一段 后记'.length, '尺子自证：长度确实没变');
    assert.equal(h.api.accept(), false, '文本对不上就绝不能写');
    assert.equal(h.view.state.doc.toString(), after, '用户的新内容一个字都不能被覆盖');
  } finally { h.restore(); }
});

test('负例：选中段**之前**的内容被等长换掉 ⇒ 前缀判据拒绝（区间文本仍巧合同样）', async () => {
  /* 工位算式（与坐标一起写，避免错-44）：
     'X需要润色ZZZ' 中 '需要润色' 位于 [1,5)；把开头的 X 换成等长的 Y ⇒ 'Y需要润色ZZZ'
     ⇒ [1,5) 上仍然是 '需要润色'（文本判据看不出差别），只有前缀从 'X' 变成 'Y'。 */
  const h = await harness({ text: 'X需要润色ZZZ', anchor: 1, head: 5 });
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    h.view.dispatch({ changes: { from: 0, to: 1, insert: 'Y' } });
    const after = h.view.state.doc.toString();
    assert.equal(after, 'Y需要润色ZZZ');
    // 尺子自证①：区间文本确实没变（所以不可能靠文本判据拦下来）
    assert.equal(after.slice(1, 5), '需要润色');
    // 尺子自证②：长度也没变（所以也不可能靠长度判据拦下来）
    assert.equal(after.length, 'X需要润色ZZZ'.length);
    assert.equal(h.api.accept(), false, '前缀变了 ⇒ 保守失效，宁可让用户重选');
    assert.equal(h.view.state.doc.toString(), after);
  } finally { h.restore(); }
});

test('选区**之后**的编辑不算失效（用户可以在面板开着时继续写文末）', async () => {
  // '需要润色 ABC' 里 '需要润色' 位于 [0,4)
  const h = await harness({ text: '需要润色 ABC', anchor: 0, head: 4 });
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    assert.equal(h.api.state().to, 4);
    const tail = h.view.state.doc.length;
    h.view.dispatch({ changes: { from: tail, insert: '新写的尾巴' } });
    assert.equal(h.api.state().phase, 'ready', '选区之后写东西不该把面板打掉');
    assert.equal(h.api.accept(), true);
    assert.equal(h.view.state.doc.toString(), '这是段需要润色的文字。 ABC新写的尾巴');
  } finally { h.restore(); }
});

test('采纳的撤销边界：Ctrl+Z 只回退润色本身，用户上一段手打还在', async () => {
  const h = await harness({ text: '原句需要润色', anchor: 0, head: 6 });
  try {
    // 先有一段"用户手打"的历史，然后才润色
    h.view.dispatch({ changes: { from: 0, insert: '手打前缀' }, userEvent: 'input.type' });
    const typed = h.view.state.doc.toString();
    assert.equal(typed, '手打前缀原句需要润色');

    h.view.dispatch({ selection: { anchor: 4, head: 10 } });
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    assert.equal(h.api.accept(), true);
    assert.equal(h.view.state.doc.toString(), '手打前缀这是段需要润色的文字。');

    const spec = () => ({ state: h.view.state, dispatch: (tr) => h.view.dispatch(tr) });
    assert.equal(h.cmdMod.undo(spec()), true);
    // 关键：一次撤销只回到"润色前"，**不是**把用户的手打也一起撤掉。
    assert.equal(h.view.state.doc.toString(), typed, '撤销必须停在润色前那一刻，不能越过它');
  } finally { h.restore(); }
});

test('采纳的撤销边界（后侧）：采纳后立刻打字，一次撤销只撤刚打的字，润色结果仍在', async () => {
  /* 这一臂量的是**后侧**合并：@codemirror/commands 的 joinableUserEvent 是 /^(input\.type|delete)($|\.)/
     ⇒ 采纳之后紧接着的 input.type 默认会并进采纳事件（500ms 内必然并）；
     一次撤销就把润色和刚打的字一起撤掉。isolateHistory.of('full') 正是封住这一侧。
     实测两态（tools/quality/probe-isolate-history.cjs）：无注解 ⇒ 一次撤销回到"原句需要润色"（润色被一并撤掉 ✗）；
     有注解 ⇒ 一次撤销只撤 'Z'，润色结果仍在 ✓。 */
  const h = await harness({ text: '原句需要润色', anchor: 0, head: 6 });
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.accept(), true);
    const afterRewrite = h.view.state.doc.toString();
    assert.equal(afterRewrite, '这是段需要润色的文字。');

    // 真人最常见的下一步：紧接着打一笔
    h.view.dispatch({ changes: { from: 0, insert: 'Z' }, userEvent: 'input.type' });
    assert.equal(h.view.state.doc.toString(), 'Z' + afterRewrite);

    const spec = () => ({ state: h.view.state, dispatch: (tr) => h.view.dispatch(tr) });
    assert.equal(h.cmdMod.undo(spec()), true);
    assert.equal(h.view.state.doc.toString(), afterRewrite, '一次撤销只该撤掉刚打的 Z，润色必须还在');
    assert.equal(h.cmdMod.undo(spec()), true);
    assert.equal(h.view.state.doc.toString(), '原句需要润色', '再撤一次才回到润色前');
  } finally { h.restore(); }
});

test('负例：相同文本切到另一个文件（作用域变了）⇒ 即使内容逐字节相同也拒绝采纳', async () => {
  const h = await harness();
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    const text = h.view.state.doc.toString();
    // 先把这份文档的内容记下来，切档后**内容一字不改**（这是最阴的形态：内容判据全过）
    h.scope = 'other-document.md';
    assert.equal(h.view.state.doc.toString(), text, '尺子自证：切档后文档内容确实没变');
    assert.equal(h.api.accept(), false, '另一份文档（哪怕内容相同）一个字都不许写');
    assert.equal(h.api.state().phase, 'idle', '失效之后不该留面板');
    assert.equal(h.view.state.doc.toString(), text);
    // 明确自证：拒绝只能来自作用域判据（内容、选区、长度全都一模一样）
    assert.equal(h.api._internals.peek().session, null);
  } finally { h.restore(); }
});

test('负例：仅移动选区（内容一字未改）⇒ 采纳被拒，且给的是"选区已改变"而不是"原文已变化"', async () => {
  const h = await harness({ text: '甲乙丙丁戊己庚辛', anchor: 0, head: 4 });
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    const before = h.view.state.doc.toString();
    // 只移动选区：折叠到别处，文档一字不改
    h.view.dispatch({ selection: { anchor: 6 } });
    assert.equal(h.view.state.doc.toString(), before, '尺子自证：内容一点没变');
    assert.equal(h.api.accept(), false, '选区挪走了就不能写');
    assert.equal(h.view.state.doc.toString(), before, '正文一个字都不能变');
    // 提示文案必须是"选区"而不是"原文"（用户该做的事不同）
    assert.ok(h.toasts.some(t => t.includes('选区')), '应提示选区已改变，实际：' + JSON.stringify(h.toasts));
    assert.equal(h.toasts.some(t => t.includes('原文已变化')), false, '内容没变就别说原文变了');
  } finally { h.restore(); }
});

test('负例：仅移动选区到"同一个 from/to 的另一处"也躲不过（要求 from/to 精确相等）', async () => {
  const h = await harness({ text: 'AAAA BBBB AAAA', anchor: 0, head: 4 });
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    const before = h.view.state.doc.toString();
    // 选到文档尾部同样内容的 "AAAA"（[10,14)）：内容串相同，但选区不是原来那一段
    h.view.dispatch({ selection: { anchor: 10, head: 14 } });
    assert.equal(h.view.state.doc.toString(), before);
    assert.equal(h.api.accept(), false);
    assert.equal(h.view.state.doc.toString(), before);
  } finally { h.restore(); }
});

test('负例：迟到回包 —— 回包到达前切了档，结果被丢弃且不留面板', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await harness({
    text: '甲乙丙丁需要润色',
    anchor: 0, head: 4,
    reply: async () => { await gate; return { ok: true, text: '甲乙丙丁改过' }; },
  });
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'pending');
    h.scope = 'another-file.md';        // 等待期间宿主切了文档
    release();
    await flush(); await flush();
    assert.equal(h.api.state().phase, 'idle', '迟到回包不许留下可采纳的面板');
    assert.equal(findPanelButtons(h.doc).length, 0, '面板必须已经摘掉');
    assert.equal(h.view.state.doc.toString(), '甲乙丙丁需要润色', '另一个文件没被写');
  } finally { h.restore(); }
});

test('负例：回包到达前用户改了正文 ⇒ 面板不出现，只给失效提示', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await harness({
    text: '甲乙丙丁需要润色',
    anchor: 0, head: 4,
    reply: async () => { await gate; return { ok: true, text: '甲乙丙丁改过' }; },
  });
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'pending');
    h.view.dispatch({ changes: { from: 0, insert: 'Z' } });
    release();
    await flush(); await flush();
    assert.equal(h.api.state().phase, 'idle', '失效后不许留下可采纳的面板');
    assert.equal(h.doc.body.childNodes.length, 0);
    assert.equal(h.view.state.doc.toString(), 'Z甲乙丙丁需要润色');
  } finally { h.restore(); }
});

test('负例：多光标 / 空选区 / 只读，各自给出明确结果且不发请求', async () => {
  const h = await harness();
  try {
    // 空选区
    h.view.dispatch({ selection: { anchor: 2 } });
    assert.equal(h.api.open(), 'no-selection');

    /* 多光标：CM6 的 state.update 会把额外区间折叠掉，所以直接替换 view.state 的读法
       （这正是 view.state 的公开契约：一个带 selection.ranges 的状态对象）。 */
    const doc = h.view.state.doc;
    const multi = h.stateMod.EditorSelection.create([
      h.stateMod.EditorSelection.range(0, 2),
      h.stateMod.EditorSelection.range(4, 6),
    ]);
    assert.equal(multi.ranges.length, 2, '尺子自证：构造出来的确实是两个区间');
    Object.defineProperty(h.view, 'state', {
      configurable: true,
      get: () => ({ doc, docLength: doc.length, readOnly: false, selection: multi }),
    });
    assert.equal(h.api.open(), 'unsupported');
    assert.equal(h.calls.length, 0, '不支持的选区就不该发请求');

    // 只读
    Object.defineProperty(h.view, 'state', {
      configurable: true,
      get: () => ({ doc, docLength: doc.length, readOnly: true, selection: h.stateMod.EditorSelection.single(0, 2) }),
    });
    assert.equal(h.api.open(), 'unsupported');
    assert.equal(h.calls.length, 0);
  } finally { h.restore(); }
});

/* ═════════════════════ 重复请求 ═════════════════════ */

test('重复请求：待回包期间再按一次只提示，不发第二个请求、不叠面板', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await harness({ reply: async () => { await gate; return { ok: true, text: '换个说法的这段话。' }; } });
  try {
    assert.equal(h.api.open(), 'started');
    assert.equal(h.api.open(), 'pending');
    assert.equal(h.api.open(), 'pending');
    await flush();                                  // 请求在微任务里发出，先让它真的出去
    assert.equal(h.calls.length, 1, '网络请求只能有一次');
    assert.equal(h.doc.body.childNodes.filter(n => n.nodeType === 1).length, 1, '面板只能有一个');
    release();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
  } finally { h.restore(); }
});

/* ═════════════════════ 失败 / 未配置 / 取消 ═════════════════════ */

test('反例③：空回包 ⇒ 判失败，面板不给采纳，正文一个字都不少', async () => {
  const h = await harness({ text: '这一段原文绝不能被删掉', anchor: 0, head: 11, reply: async () => ({ ok: true, text: '' }) });
  try {
    const before = h.view.state.doc.toString();
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'failed', '空回包必须是失败态，不能是 ready');
    assert.equal(h.api.accept(), false, '失败态不许采纳');
    assert.equal(h.view.state.doc.toString(), before, '整段正文必须完好');
    const text = h.doc.body.textContent;
    assert.ok(text.includes('空'), '面板要明说返回了空内容：' + text.slice(0, 140));
    // 判据看**按钮的实际动作**，不看文案里有没有"采纳"二字（提示语本身会提到它，字面搜索会误判）
    const actions = findPanelButtons(h.doc).map(b => b.dataset.mpRewriteAction);
    assert.equal(actions.includes('accept'), false, '空回包的面板里不许出现采纳按钮，实际：' + actions.join(','));
    assert.equal(actions.includes('retry'), true, '空回包要给重试');
  } finally { h.restore(); }
});

test('反例④：纯空白回包同样判失败（不是"润色成空行"）', async () => {
  const h = await harness({ text: '也不能被删掉的一段', anchor: 0, head: 9, reply: async () => ({ ok: true, text: ' \n\n\t ' }) });
  try {
    const before = h.view.state.doc.toString();
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'failed');
    assert.equal(h.api.accept(), false);
    assert.equal(h.view.state.doc.toString(), before);
  } finally { h.restore(); }
});

test('合法回包（含尾随换行与围栏）能正常采纳，不是被"清洗"成空', async () => {
  const h = await harness({
    text: '需要润色的一句话',
    anchor: 0, head: 8,
    reply: async () => ({ ok: true, text: '润色后的一句话\n' }),
  });
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready', '有真实内容的回包必须能进审阅态');
    assert.equal(h.api.accept(), true);
    assert.equal(h.view.state.doc.toString(), '润色后的一句话\n');
  } finally { h.restore(); }
});

test('未配置：明确说"还没配置"，给重试按钮，正文零改动', async () => {
  const h = await harness({ reply: async () => ({ ok: false, code: 'not-configured', message: 'x' }) });
  try {
    const before = h.view.state.doc.toString();
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'failed');
    const text = h.doc.body.textContent;
    assert.ok(text.includes('还没有配置') || text.includes('配置'), '面板要直接说没配置：' + text.slice(0, 120));
    assert.ok(text.includes('重试'), '失败面板必须有重试');
    assert.equal(h.view.state.doc.toString(), before);
    assert.equal(h.api.accept(), false, '失败态不许采纳');
  } finally { h.restore(); }
});

test('失败后重试：点「重试」会真的再发一次请求，且用同一段选区', async () => {
  const SOURCE = '重试这一段需要润色的话';
  const SELECTED = '重试这一段需要';
  let attempt = 0;
  const h = await harness({
    text: SOURCE,
    anchor: 0, head: SELECTED.length,
    reply: async () => {
      attempt++;
      if (attempt === 1) return { ok: false, code: 'network', message: '断网' };
      return { ok: true, text: '重试这一段需要润色的文字' };
    },
  });
  try {
    const before = h.view.state.doc.toString();
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'failed');
    assert.equal(h.calls.length, 1);
    // 尺子自证：第一发请求里装的确实是选中的那一段
    assert.equal(h.calls[0].payload.selection, SELECTED);
    // 找到「重试」按钮并真的点它
    const retryButton = findPanelButtons(h.doc).find(b => b.dataset.mpRewriteAction === 'retry');
    assert.ok(retryButton, '失败面板必须有重试按钮');
    retryButton.click();
    await flush(); await flush();
    assert.equal(h.calls.length, 2, '重试必须真的再发一次请求');
    assert.equal(h.calls[1].payload.selection, SELECTED, '重试要用同一段选区');
    assert.equal(h.api.state().phase, 'ready');
    assert.equal(h.api.accept(), true);
    assert.notEqual(h.view.state.doc.toString(), before);
  } finally { h.restore(); }
});

test('取消：AbortController 传到 transport，回包被丢弃，正文不变', async () => {
  let seenSignal = null;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await harness({
    reply: async (payload, ctx) => { seenSignal = ctx?.signal; await gate; return { ok: true, text: '迟到结果' }; },
  });
  try {
    const before = h.view.state.doc.toString();
    h.api.open();
    await flush();
    assert.ok(seenSignal, 'transport 必须拿到 signal');
    assert.equal(seenSignal.aborted, false);
    h.api.reject('user');
    assert.equal(seenSignal.aborted, true, '放弃时必须中止在途请求');
    release();
    await flush();
    assert.equal(h.view.state.doc.toString(), before);
    assert.equal(h.api.state().phase, 'idle');
  } finally { h.restore(); }
});

test('取消跨 IPC：放弃时调用宿主的 aiRewriteCancel(requestId)，让主进程真停网络', async () => {
  /* AbortSignal 过不了 IPC ⇒ 内核必须走**独立取消通道**。
     没有这一臂的话，"reject 里的 controller.abort 被误删"不会被发现（本地 signal 仍会 abort）。 */
  const cancelled = [];
  const h = await harness({
    /* 在宿主桥上提供取消能力 */
    bridge: {
      aiRewrite: async () => new Promise(() => { /* 永不 settle：模拟在途 */ }),
      aiRewriteCancel: async (requestId) => { cancelled.push(String(requestId)); return { ok: true, cancelled: true }; },
    },
  });
  try {
    const before = h.view.state.doc.toString();
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'pending');
    const id = String(h.api.state().id);
    h.api.reject('user');
    await flush();
    assert.deepEqual(cancelled, [id], '放弃时必须按 requestId 调一次取消通道');
    assert.equal(h.view.state.doc.toString(), before, '取消不写正文');
    assert.equal(h.api.state().phase, 'idle');
  } finally { h.restore(); }
});

/* ═════════════════════ 键盘 / 输入法 / 焦点边界 ═════════════════════ */

function keydown(target, init) {
  const event = {
    type: 'keydown', target, key: init.key, keyCode: init.keyCode ?? 0,
    shiftKey: !!init.shiftKey, isComposing: !!init.isComposing, repeat: !!init.repeat,
    defaultPrevented: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.propagationStopped = true; },
  };
  // 派发到 document 的捕获监听（面板装的是 document 捕获）
  for (const fn of [...(target.ownerDocument?.listeners?.keydown || [])]) fn(event);
  return event;
}

test('Esc 只在面板持有焦点时生效；焦点在正文时让路', async () => {
  const h = await harness();
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    // 焦点在正文（框外）：面板不接管
    const outside = h.doc.body;
    const e1 = keydown(outside, { key: 'Escape', keyCode: 27 });
    assert.equal(e1.defaultPrevented, false, '焦点在框外时不许吃掉 Esc');
    assert.equal(h.api.state().phase, 'ready');

    // 焦点在面板按钮上：Esc = 放弃
    const panel = h.doc.getElementById('mp-rewrite-style') ? null : null;
    const btn = findPanelButton(h.doc);
    assert.ok(btn, '面板上要有按钮');
    const e2 = keydown(btn, { key: 'Escape', keyCode: 27 });
    assert.equal(e2.defaultPrevented, true);
    assert.equal(h.api.state().phase, 'idle');
  } finally { h.restore(); }
});

test('输入法组字中的 Esc 不被面板吃掉（中文输入法的候选框优先级）', async () => {
  const h = await harness();
  try {
    h.api.open();
    await flush();
    const btn = findPanelButton(h.doc);
    const e = keydown(btn, { key: 'Escape', keyCode: 229, isComposing: true });
    assert.equal(e.defaultPrevented, false, '组字中的 Esc 归输入法');
    assert.equal(h.api.state().phase, 'ready', '组字中的 Esc 不该关面板');
    // keyCode 229（无 isComposing 标志的旧浏览器路径）同样让路
    const e2 = keydown(btn, { key: 'Escape', keyCode: 229 });
    assert.equal(e2.defaultPrevented, false);
  } finally { h.restore(); }
});

test('就绪态 Tab = 采纳：用**真正的默认焦点**（不手工切焦点），一次 Tab 就写正文', async () => {
  const h = await harness({ text: '需要润色的一段话', anchor: 0, head: 8 });
  try {
    const before = h.view.state.doc.toString();
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');

    /* 关键：**不**调用任何 .focus()。读的是内核在 ready 时自己设定的默认焦点。 */
    const active = h.doc.activeElement;
    assert.ok(active, '就绪态必须有默认焦点');
    const isBody = active.classList && active.classList.contains('mp-rw-body');
    const isButton = !!(active.dataset && active.dataset.mpRewriteAction);
    assert.equal(isBody || isButton, true, '默认焦点必须落在面板容器或面板按钮上，实际：' +
      (active.tagName || '?') + '/' + (active.dataset?.mpRewriteAction || '-'));

    /* 真机复验口径：主控按一次原生 Tab，必须采纳。 */
    const e = keydown(active, { key: 'Tab' });
    assert.equal(e.defaultPrevented, true, '就绪态 Tab 必须被面板接管');
    assert.notEqual(h.view.state.doc.toString(), before, '一次 Tab 必须真的采纳（正文变了）');
    assert.equal(h.api.state().phase, 'idle', '采纳后面板收起');
  } finally { h.restore(); }
});

test('就绪态默认焦点是**面板容器**（不是「放弃」按钮）—— 否则用户按 Tab 只能轮转', async () => {
  /* 这是主控在真机复现的缺陷：默认焦点给第一个可用按钮 = 「放弃 (Esc)」，
     而"焦点在按钮上就轮转"的规则会让普通用户永远按不出一次 Tab 采纳。 */
  const h = await harness({ text: '需要润色的一段话', anchor: 0, head: 8 });
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    const active = h.doc.activeElement;
    assert.equal(active.classList.contains('mp-rw-body'), true,
      '就绪态默认焦点必须是面板容器；实际是：' + (active.dataset?.mpRewriteAction || active.tagName));
    assert.equal(!!(active.dataset && active.dataset.mpRewriteAction), false, '不能是某个按钮');
  } finally { h.restore(); }
});

test('焦点先 Shift+Tab 走到按钮，再按 Tab 仍然采纳（不会退化成只能轮转）', async () => {
  const h = await harness({ text: '需要润色的一段话', anchor: 0, head: 8 });
  try {
    const before = h.view.state.doc.toString();
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    const body = h.doc.activeElement;                       // 内核给的默认焦点（容器）
    const buttons = findPanelButtons(h.doc);
    assert.equal(buttons.length, 2);
    /* Shift+Tab：容器 ⇒ 最后一个按钮（可达性） */
    keydown(body, { key: 'Tab', shiftKey: true });
    const onButton = h.doc.activeElement;
    assert.equal(!!(onButton.dataset && onButton.dataset.mpRewriteAction), true, 'Shift+Tab 要把焦点送到按钮上');
    assert.equal(h.view.state.doc.toString(), before, 'Shift+Tab 只移动焦点，不许采纳');
    /* 再按普通 Tab：必须采纳（这是先前缺的那一步） */
    const e = keydown(onButton, { key: 'Tab' });
    assert.equal(e.defaultPrevented, true);
    assert.notEqual(h.view.state.doc.toString(), before, '按钮上按 Tab 也必须采纳');
    assert.equal(h.api.state().phase, 'idle');
  } finally { h.restore(); }
});

test('就绪态 Esc = 拒绝；失败/等待态 Tab 仍走轮转（没有可采纳的东西就别抢）', async () => {
  const h = await harness({ text: '需要润色的一段话', anchor: 0, head: 8 });
  try {
    const before = h.view.state.doc.toString();
    h.api.open();
    await flush();
    const body = findPanelBody(h.doc);
    body.focus();
    const esc = keydown(body, { key: 'Escape', keyCode: 27 });
    assert.equal(esc.defaultPrevented, true);
    assert.equal(h.api.state().phase, 'idle');
    assert.equal(h.view.state.doc.toString(), before, 'Esc 放弃后正文不变');
  } finally { h.restore(); }
});

test('Shift+Tab 保留可达性：就绪态也能把焦点走到「放弃」上并按 Enter 执行', async () => {
  const h = await harness({ text: '需要润色的一段话', anchor: 0, head: 8 });
  try {
    const before = h.view.state.doc.toString();
    h.api.open();
    await flush();
    const body = findPanelBody(h.doc);
    const buttons = findPanelButtons(h.doc);
    const rejectButton = buttons.find(b => b.dataset.mpRewriteAction === 'reject');
    assert.ok(rejectButton, '必须存在「放弃」按钮');
    body.focus();
    const shiftTab = keydown(body, { key: 'Tab', shiftKey: true });
    assert.equal(shiftTab.defaultPrevented, true);
    assert.equal(h.view.state.doc.toString(), before, 'Shift+Tab 只移动焦点，不许采纳');
    assert.equal(h.doc.activeElement, rejectButton, 'Shift+Tab 要把焦点送到「放弃」上');
    const enter = keydown(rejectButton, { key: 'Enter', keyCode: 13 });
    assert.equal(enter.defaultPrevented, true);
    assert.equal(h.api.state().phase, 'idle', 'Enter 在「放弃」上要真的放弃');
    assert.equal(h.view.state.doc.toString(), before);
  } finally { h.restore(); }
});

test('就绪态：按钮焦点上 Tab = 采纳（不是轮转）；Shift+Tab 才是轮转', async () => {
  /* 【规则修订·真机实测】旧规则是"焦点在按钮上就轮转"，理由是"否则走不到「放弃」"；
     但真机复验发现默认焦点本就落在「放弃」上 ⇒ 普通用户按 Tab 永远只轮转、采纳不出来。
     现在的分工：**Tab = 采纳**，**Shift+Tab = 轮转**（可达性由后者保证），两条各司其职。 */
  const h = await harness({ text: '需要润色的一段话', anchor: 0, head: 8 });
  try {
    const before = h.view.state.doc.toString();
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    const buttons = findPanelButtons(h.doc);
    const acceptButton = buttons.find(b => b.dataset.mpRewriteAction === 'accept');
    const rejectButton = buttons.find(b => b.dataset.mpRewriteAction === 'reject');
    assert.ok(acceptButton && rejectButton);

    /* 按钮上按 Tab ⇒ 采纳 */
    acceptButton.focus();
    keydown(acceptButton, { key: 'Tab' });
    assert.notEqual(h.view.state.doc.toString(), before, '按钮上 Tab 也必须采纳');
    assert.equal(h.api.state().phase, 'idle');
  } finally { h.restore(); }

  /* 另一臂：Shift+Tab 在按钮间轮转、不采纳 */
  const h2 = await harness({ text: '需要润色的一段话', anchor: 0, head: 8 });
  try {
    const before = h2.view.state.doc.toString();
    h2.api.open();
    await flush();
    const [first, second] = findPanelButtons(h2.doc);
    first.focus();
    keydown(first, { key: 'Tab', shiftKey: true });
    assert.equal(h2.doc.activeElement, second, 'Shift+Tab 要轮转到另一个按钮');
    assert.equal(h2.view.state.doc.toString(), before, 'Shift+Tab 不许采纳');
    assert.equal(h2.api.state().phase, 'ready');
  } finally { h2.restore(); }
});

test('输入控件里的 Tab/Esc 让路：面板不抢输入框的键', async () => {
  const h = await harness({ text: '需要润色的一段话', anchor: 0, head: 8 });
  try {
    h.api.open();
    await flush();
    const before = h.view.state.doc.toString();
    // 造一个"面板里的输入框"（将来加"补充要求"输入框就是这种形态）
    const input = h.doc.createElement('textarea');
    findPanelBody(h.doc).parentNode.appendChild(input);
    assert.equal(h.api.state().phase, 'ready');
    const tab = keydown(input, { key: 'Tab' });
    assert.equal(tab.defaultPrevented, false, '输入框里的 Tab 必须让给焦点遍历');
    assert.equal(h.api.state().phase, 'ready');
    const esc = keydown(input, { key: 'Escape', keyCode: 27 });
    assert.equal(esc.defaultPrevented, false, '输入框里的 Esc 必须让给用户');
    assert.equal(h.api.state().phase, 'ready');
    assert.equal(h.view.state.doc.toString(), before);
  } finally { h.restore(); }
});

test('Enter 只在焦点确实在面板按钮上时当确认，不抢正文回车', async () => {
  const h = await harness();
  try {
    h.api.open();
    await flush();
    const before = h.view.state.doc.toString();
    const outside = h.doc.body;
    const e = keydown(outside, { key: 'Enter', keyCode: 13 });
    assert.equal(e.defaultPrevented, false);
    assert.equal(h.api.state().phase, 'ready');
    assert.equal(h.view.state.doc.toString(), before);

    const acceptButton = findPanelButtons(h.doc).find(b => b.dataset.mpRewriteAction === 'accept');
    acceptButton.focus();
    const e2 = keydown(acceptButton, { key: 'Enter', keyCode: 13 });
    assert.equal(e2.defaultPrevented, true);
    assert.notEqual(h.view.state.doc.toString(), before);
  } finally { h.restore(); }
});

function findPanelButtons(doc) {
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if (child.dataset && child.dataset.mpRewriteAction) out.push(child);
      walk(child);
    }
  };
  walk(doc.body);
  return out;
}
function findPanelButton(doc) { return findPanelButtons(doc)[0] || null; }

/** 面板的正文区（`.mp-rw-body`，tabindex=-1）。按类名找，不按位置猜。 */
function findPanelBody(doc) {
  let found = null;
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if (child.classList && child.classList.contains('mp-rw-body')) { found = child; return; }
      walk(child);
    }
  };
  walk(doc.body);
  return found;
}

/* ═════════════════════ 面板内容：词级增删真的画出来了 ═════════════════════ */

test('对比视图：删除与新增分别落在 .mp-rw-del / .mp-rw-ins 上，等文部分保持正文样式', async () => {
  const h = await harness({
    text: '这个方案很好。',
    anchor: 0, head: 7,
    reply: async () => ({ ok: true, text: '这个方案不错。' }),
  });
  try {
    h.api.open();
    await flush();
    const del = collectClass(h.doc, 'mp-rw-del');
    const ins = collectClass(h.doc, 'mp-rw-ins');
    assert.deepEqual(del, ['很好'], '被删的字要能看见');
    assert.deepEqual(ins, ['不错'], '新增的字要能看见');
    const stat = h.doc.body.textContent.includes('−2') && h.doc.body.textContent.includes('+2');
    assert.ok(stat, '字数增删统计要可见：' + h.doc.body.textContent.slice(0, 200));
  } finally { h.restore(); }
});

function collectClass(doc, className) {
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if (child.classList && child.classList.contains(className)) out.push(child.textContent);
      walk(child);
    }
  };
  walk(doc.body);
  return out;
}

/* ═════════════════════ 轮询兜底：不接宿主也能自己失效 ═════════════════════ */

test('不接宿主 onDocChange 时，轮询也会发现正文变了并撤掉面板', async () => {
  const h = await harness();
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    h.view.dispatch({ changes: { from: 0, insert: 'Q' } });
    assert.equal(h.api.onDocChange(), undefined);   // 宿主主动调的入口不抛
    assert.equal(h.api.state().phase, 'idle', '一次显式检查就应失效');
    assert.equal(h.doc.body.childNodes.length, 0);
    assert.equal(h.view.state.doc.toString().startsWith('Q'), true, '用户的输入保留');
  } finally { h.restore(); }
});

test('选区被用户挪走 ⇒ 面板失效（不能对着旧选区按采纳）', async () => {
  const h = await harness({ text: '甲乙丙丁戊己', anchor: 0, head: 3 });
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    h.view.dispatch({ selection: { anchor: 5, head: 6 } });
    h.doc.fire('selectionchange', { type: 'selectionchange' });
    assert.equal(h.api.state().phase, 'idle');
    assert.equal(h.doc.body.childNodes.length, 0);
  } finally { h.restore(); }
});
