// dsh-markdown-editor-typora 桥：AI 润色与公众号草稿的宿主面契约。
// 运行：node test/publish-frame-host.test.mjs
//
// 桥在 iframe 里跑，拿不到 Electron：所有能力都用既有的
//   up   { __dshmd:true, dir:'up',   type:'host-invoke', content:{ id, cmd, args } }
//   down { __dshmd:true, dir:'down', type:'host-result', content:{ id, result|error } }
// 协议转给父窗口。本测试锁的就是这份协议：
//   · 每条 invoke 的 cmd 就是同名 camelCase 公共方法（不另造命令名）；
//   · args 与已交付的桌面 preload / selection-rewrite.js / wechat-draft-dialog.js 真实契约同形；
//   · AbortSignal 绝不上行——本地 abort 改发同名 cancel，且带同一个 requestId；
//   · 父窗口兜底回的 null（宿主没实现）翻译成明确的"未接入"，不假装成功；
//   · wxPickCover 走本 iframe 真实的 <input type=file accept="image/png,image/jpeg">，
//     只上行用户选的那一张的受限字节与名称/MIME，取消回 {ok:false,canceled:true} 且不上行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '..', 'renderer-cm6', 'dsh-bridge.js'), 'utf8');

const PUBLIC_METHODS = [
  'aiRewrite', 'aiRewriteCancel', 'aiStatus',
  'wxStatus', 'wxConfigure', 'wxClear', 'wxVerify', 'wxPickCover', 'wxCreateDraft', 'wxAcknowledge',
];

/**
 * Everything below crosses the vm realm boundary, where a plain object carries a
 * different intrinsic prototype. The protocol promises a JSON shape, so
 * assertions compare the detached copy.
 */
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function fakeStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

/**
 * The bridge schedules real timers for its RPC timeouts (10 s default, up to
 * 180 s for a draft). In a unit test they would keep the process alive long
 * after the assertions, so the sandbox gets inert timers: they hand out ids and
 * can be cleared, but never fire. Tests that need timeout behaviour reject the
 * invoke promise directly instead of waiting for a timer.
 */
function inertTimers() {
  const live = new Map();
  let serial = 0;
  const add = (fn, ms) => { serial += 1; live.set(serial, { fn, ms }); return serial; };
  const drop = (id) => { live.delete(id); };
  return { setTimeout: add, setInterval: add, clearTimeout: drop, clearInterval: drop, live };
}

/** Minimal DOM node used for the cover picker; `click()` runs the scripted user. */
function makeInput({ onPickClick }) {
  const listeners = new Map();
  const input = {
    type: '', accept: '', files: null, parentNode: null, style: {},
    setAttribute(name, value) { this[name] = value; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type);
      if (!list) return;
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    dispatch(type) { for (const fn of [...(listeners.get(type) || [])]) fn({ type }); },
    click() { if (onPickClick) onPickClick(this); },
  };
  return input;
}

function loadBridge(options = {}) {
  const messages = [];
  const windowListeners = Object.create(null);
  const inputs = [];
  const timers = inertTimers();
  const document = {
    body: null,
    documentElement: { dataset: {}, style: { setProperty() {} }, setAttribute() {}, getAttribute() { return null; } },
    querySelector: () => null,
    querySelectorAll: () => [],
    head: { firstChild: null, insertBefore() {} },
    baseURI: 'http://127.0.0.1/dsh-markdown-editor-typora/renderer-cm6/index.html',
    createElement(tag) {
      if (tag !== 'input') return { setAttribute() {}, style: {} };
      const input = makeInput({ onPickClick: options.onPickClick });
      inputs.push(input);
      return input;
    },
  };
  document.body = { appendChild(node) { node.parentNode = document.body; }, removeChild(node) { node.parentNode = null; } };
  const window = {
    __dshBridgeInstalled: false,
    parent: { postMessage(message) { messages.push(message); } },
    addEventListener(type, fn) { (windowListeners[type] || (windowListeners[type] = [])).push(fn); },
    dispatchEvent() { return true; },
  };
  if (options.mpHost !== undefined) window.mpHost = options.mpHost;
  const sandbox = {
    window, document,
    location: { pathname: '/dsh-markdown-editor-typora/renderer-cm6/index.html', href: 'http://127.0.0.1/dsh-markdown-editor-typora/renderer-cm6/index.html' },
    localStorage: fakeStorage(),
    console,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    queueMicrotask,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    AbortController, AbortSignal,
    fetch: () => Promise.reject(new Error('no network in bridge unit test')),
    URL, Promise, Map, Date, JSON, Math, String, Number, Object, Array, Boolean, Error, TypeError,
    Uint8Array, FileReader: undefined, btoa, atob,
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'dsh-bridge.js' });

  const hostInvokes = () => messages.filter((m) => m && m.type === 'host-invoke');

  /** Deliver one parent → iframe message, exactly like the real frame does. */
  function deliver(type, content) {
    for (const fn of [...(windowListeners.message || [])]) {
      fn({ source: window.parent, data: { __dshmd: true, dir: 'down', type, content } });
    }
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
  /** Wait until `count` host-invoke messages for `cmd` have been posted. */
  async function waitInvocations(count, cmd) {
    for (let i = 0; i < 500; i += 1) {
      const list = messages.filter((m) => m && m.type === 'host-invoke' && (cmd === undefined || m.content.cmd === cmd));
      if (list.length >= count) return list;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`expected ${count} host-invoke message(s)${cmd ? ` for ${cmd}` : ''}, saw ${messages.filter((m) => m && m.type === 'host-invoke').length}`);
  }
  /** Call one host method, answer the resulting invoke, and return both sides. */
  async function invokeAndAnswer(method, arg, answer) {
    const before = hostInvokes().length;
    const call = window.mpHost[method](arg);
    const list = await waitInvocations(before + 1);
    const request = list[before].content;
    deliver('host-result', { id: request.id, result: answer });
    return { request: plain(request), reply: plain(await call) };
  }
  return { window, messages, deliver, waitInvocations, invokeAndAnswer, inputs, timers, tick, hostInvokes };
}

test('every public method exists and invokes its own camelCase command', async () => {
  const bridge = loadBridge();
  for (const name of PUBLIC_METHODS) assert.equal(typeof bridge.window.mpHost[name], 'function', `${name} is installed`);

  const status = bridge.window.mpHost.wxStatus();
  const [call] = await bridge.waitInvocations(1, 'wxStatus');
  assert.equal(call.dir, 'up');
  assert.equal(call.type, 'host-invoke');
  assert.deepEqual(Object.keys(call.content).sort(), ['args', 'cmd', 'id']);
  assert.equal(call.content.cmd, 'wxStatus', 'the command name is the method name');
  assert.deepEqual(plain(call.content.args), {}, 'argument-less methods send an empty object');
  assert.match(plain(call.content.id), /^dshhost-\d+$/);
  bridge.deliver('host-result', { id: call.content.id, result: { ok: true } });
  assert.deepEqual(plain(await status), { ok: true });
});

test('aiRewrite forwards the verified-selection payload with a request id and returns the host receipt', async () => {
  const bridge = loadBridge();
  const payload = { purpose: 'selection-rewrite', app: 'MarkPilot', language: 'zh-CN', instruction: '', selection: '## 结论\n这个方法可行。' };
  const { request, reply } = await bridge.invokeAndAnswer('aiRewrite', payload, { ok: true, text: '这个方法可行。' });
  assert.equal(request.cmd, 'aiRewrite');
  assert.deepEqual(request.args, { payload, requestId: request.args.requestId });
  assert.match(request.args.requestId, /^dshai-\d+-[0-9a-z]+$/);
  assert.deepEqual(reply, { ok: true, text: '这个方法可行。' });
  assert.deepEqual(request.args.payload.selection, payload.selection, 'the selection text travels verbatim');
  assert.equal(JSON.stringify(request).includes('signal'), false);
});

test('aiRewrite keeps a caller-supplied request id', async () => {
  const bridge = loadBridge();
  const pending = bridge.window.mpHost.aiRewrite({ selection: 'y' }, { requestId: 'req-42' });
  const list = await bridge.waitInvocations(1, 'aiRewrite');
  assert.equal(list[0].content.args.requestId, 'req-42');
  bridge.deliver('host-result', { id: list[0].content.id, result: { ok: true, text: 'y' } });
  assert.deepEqual(plain(await pending), { ok: true, text: 'y' });
});

test('AI failures keep their own code and message rather than a generic error', async () => {
  const bridge = loadBridge();
  const { reply } = await bridge.invokeAndAnswer('aiRewrite', { selection: 'x' }, { ok: false, code: 'invalid-key', message: '密钥无效' });
  assert.deepEqual(reply, { ok: false, code: 'invalid-key', message: '密钥无效' });
});

test('a server failure receipt keeps its code and gains a readable message for the shared kernel', async () => {
  const bridge = loadBridge();
  // The real no-model receipt the server sends: {ok:false, code, error} and no message.
  const { reply } = await bridge.invokeAndAnswer('aiRewrite', { selection: 'x' }, {
    ok: false, code: 'MP_ARTICLE_NO_MODEL', error: '请在当前对话选择模型后再润色选区',
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'MP_ARTICLE_NO_MODEL', 'the code is preserved for routing');
  assert.equal(reply.message, '请在当前对话选择模型后再润色选区', 'the human-readable error becomes message');
  assert.equal(reply.error, '请在当前对话选择模型后再润色选区', 'the original error field is untouched');
});

test('adding the message is non-destructive: an existing message always wins and every other field survives', async () => {
  const bridge = loadBridge();
  const kept = await bridge.invokeAndAnswer('aiRewrite', { selection: 'x' }, {
    ok: false, code: 'invalid-key', message: '已经是人话', error: 'server detail',
  });
  assert.deepEqual(kept.reply, { ok: false, code: 'invalid-key', message: '已经是人话', error: 'server detail' });

  const richResult = {
    ok: false, code: 'MP_AI_QUOTA', error: '本月额度已用完', hint: '充值后再试', status: 402, retryable: false,
  };
  const rich = await bridge.invokeAndAnswer('aiRewrite', { selection: 'x' }, richResult);
  assert.deepEqual(rich.reply, {
    ok: false, code: 'MP_AI_QUOTA', error: '本月额度已用完', hint: '充值后再试', status: 402, retryable: false,
    message: '本月额度已用完',
  });
  // Derived from the input, not a hand-counted literal: exactly one field (message) is added.
  assert.equal(Object.keys(rich.reply).length, Object.keys(richResult).length + 1,
    'no field is dropped and only message is added');
});

test('a structured server error yields its safe detail as message', async () => {
  const bridge = loadBridge();
  for (const error of [{ message: '凭据缺失：请先在设置里填写密钥' }, { detail: '模型路由不可用' }, { reason: '额度不足' }]) {
    const { reply } = await bridge.invokeAndAnswer('aiRewrite', { selection: 'x' }, { ok: false, code: 'MP_ARTICLE_NO_CREDENTIAL', error });
    assert.equal(reply.code, 'MP_ARTICLE_NO_CREDENTIAL');
    assert.equal([...Object.values(error)][0], reply.message);
    assert.deepEqual(plain(reply.error), plain(error), 'the structured error itself is passed through');
  }
});

test('a failure with no readable detail is passed through untouched, and success is never rewritten', async () => {
  const bridge = loadBridge();
  const bare = await bridge.invokeAndAnswer('aiRewrite', { selection: 'x' }, { ok: false, code: 'MP_ARTICLE_NO_MODEL' });
  assert.deepEqual(bare.reply, { ok: false, code: 'MP_ARTICLE_NO_MODEL' }, 'no invented message');

  const blank = await bridge.invokeAndAnswer('aiRewrite', { selection: 'x' }, { ok: false, code: 'X', error: '   ' });
  assert.deepEqual(blank.reply, { ok: false, code: 'X', error: '   ' }, 'whitespace is not a message');

  const success = await bridge.invokeAndAnswer('aiRewrite', { selection: 'x' }, { ok: true, text: '润色结果', error: '这个字段在成功回包里应原样保留' });
  assert.deepEqual(success.reply, { ok: true, text: '润色结果', error: '这个字段在成功回包里应原样保留' });

  const long = await bridge.invokeAndAnswer('aiRewrite', { selection: 'x' }, { ok: false, code: 'X', error: '细'.repeat(800) });
  assert.equal(long.reply.message.length, 500, 'the display text is bounded');
  assert.equal(long.reply.message.endsWith('…'), true);
  assert.equal(long.reply.error.length, 800, 'the original field is not truncated');
});

test('aiRewriteCancel, wxConfigure and wxCreateDraft forward exactly the delivered preload shapes', async () => {
  const bridge = loadBridge();

  const cancel = await bridge.invokeAndAnswer('aiRewriteCancel', 'req-9', { ok: true, cancelled: true });
  assert.deepEqual(cancel.request.args, { requestId: 'req-9' });
  assert.deepEqual(cancel.reply, { ok: true, cancelled: true });

  const config = await bridge.invokeAndAnswer('wxConfigure', { appId: 'wx123', secret: 's3cret' }, { ok: true, appId: 'wx123' });
  assert.deepEqual(config.request.args, { appId: 'wx123', secret: 's3cret' });

  const draft = {
    title: '标题', html: '<p>x</p>', images: [{ id: 'img1', src: 'data:image/png;base64,AA' }],
    coverId: 'cover-1', author: '作者', acknowledgeUncertain: false,
  };
  const created = await bridge.invokeAndAnswer('wxCreateDraft', draft, { ok: true, mediaId: 'm1' });
  assert.deepEqual(created.request.args, draft, 'the draft payload is forwarded unchanged');
  assert.deepEqual(created.reply, { ok: true, mediaId: 'm1' });

  const ack = await bridge.invokeAndAnswer('wxAcknowledge', undefined, { ok: true });
  assert.deepEqual(ack.request.args, {});
  assert.deepEqual(ack.reply, { ok: true });
});

test('aiRewriteCancel without an id is refused locally and never reaches the frame', async () => {
  const bridge = loadBridge();
  assert.equal(plain(await bridge.window.mpHost.aiRewriteCancel()).code, 'bad-request');
  assert.equal(plain(await bridge.window.mpHost.aiRewriteCancel('')).code, 'bad-request');
  await bridge.tick();
  assert.equal(bridge.hostInvokes().length, 0);
});

test('AbortSignal never crosses the wire: a local abort sends one cancel with the same request id', async () => {
  const bridge = loadBridge();
  const controller = new AbortController();
  const pending = bridge.window.mpHost.aiRewrite({ selection: 'abc' }, { requestId: 'req-abort', signal: controller.signal });
  const [first] = await bridge.waitInvocations(1, 'aiRewrite');
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes('"signal"'), false, 'the signal object is not serialized');
  assert.equal(serialized.includes('"aborted"'), false);

  controller.abort();
  assert.deepEqual(plain(await pending), { ok: false, code: 'cancelled', message: '已取消' });

  const cancels = await bridge.waitInvocations(1, 'aiRewriteCancel');
  assert.deepEqual(plain(cancels[0].content.args), { requestId: 'req-abort' });

  // A late host answer must not resurrect the cancelled call.
  bridge.deliver('host-result', { id: first.content.id, result: { ok: true, text: 'late' } });
  await bridge.tick();
  assert.equal(bridge.hostInvokes().filter((m) => m.content.cmd === 'aiRewriteCancel').length, 1, 'one cancel per abort');
});

test('aiRewrite refuses an already-aborted call without touching the host', async () => {
  const bridge = loadBridge();
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(plain(await bridge.window.mpHost.aiRewrite({ selection: 'x' }, { signal: controller.signal })),
    { ok: false, code: 'cancelled', message: '已取消' });
  await bridge.tick();
  assert.equal(bridge.hostInvokes().length, 0);
});

test('every host message is plain JSON: no DOM node, no signal, no function', async () => {
  const bridge = loadBridge({
    onPickClick(input) {
      input.files = [{ name: 'a.jpg', type: 'image/jpeg', size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }];
      input.dispatch('change');
    },
  });
  void bridge.window.mpHost.aiRewrite({ selection: 'x' }, { requestId: 'r1' });
  void bridge.window.mpHost.wxCreateDraft({ title: 't', html: '<p>x</p>', images: [], coverId: 'c' });
  void bridge.window.mpHost.wxPickCover();
  const list = await bridge.waitInvocations(3);
  const seen = new Set();
  for (const message of list) {
    seen.add(message.content.cmd);
    const round = JSON.parse(JSON.stringify(message));
    assert.deepEqual(round, plain(message), `message for ${message.content.cmd} survives a JSON round trip`);
    assert.equal(typeof message.content.id, 'string');
    assert.equal(message.dir, 'up');
    assert.equal(message.__dshmd, true);
  }
  assert.deepEqual([...seen].sort(), ['aiRewrite', 'wxCreateDraft', 'wxPickCover']);
});

test('a host that has not wired the command answers null, which becomes an explicit not-wired failure', async () => {
  const bridge = loadBridge();
  const ai = await bridge.invokeAndAnswer('aiRewrite', { selection: 'x' }, null);
  assert.equal(ai.reply.ok, false);
  assert.equal(ai.reply.code, 'not-wired');
  assert.match(ai.reply.message, /aiRewrite/);

  const status = await bridge.invokeAndAnswer('aiStatus', undefined, null);
  assert.equal(status.reply.code, 'not-wired');

  const wx = await bridge.invokeAndAnswer('wxStatus', undefined, null);
  assert.equal(wx.reply.ok, false);
  assert.equal(wx.reply.code, 'MP_WX_HOST_UNAVAILABLE');
  assert.equal(wx.reply.configured, false, 'the engine dialog reads configured to show the problem');
  assert.equal(typeof wx.reply.problem.error, 'string');
});

test('host-side errors and timeouts keep their distinct codes and never pretend success', async () => {
  const bridge = loadBridge();
  const call = bridge.window.mpHost.aiRewrite({ selection: 'x' });
  const [posted] = await bridge.waitInvocations(1, 'aiRewrite');
  bridge.deliver('host-result', { id: posted.content.id, error: 'MISSING_CREDENTIAL' });
  assert.deepEqual(plain(await call), { ok: false, code: 'host-error', message: 'MISSING_CREDENTIAL' });

  // The real invoke rejects with this message when its own timeout fires.
  const original = bridge.window.hostApi.invoke;
  bridge.window.hostApi.invoke = () => Promise.reject(new Error('宿主未响应：wxVerify'));
  const timedOut = plain(await bridge.window.mpHost.wxVerify());
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.code, 'MP_WX_TIMEOUT_LOCAL');
  assert.equal(timedOut.timeout, true);
  assert.match(timedOut.error, /草稿箱核对/);

  const aiTimedOut = plain(await bridge.window.mpHost.aiRewrite({ selection: 'x' }));
  assert.equal(aiTimedOut.code, 'timeout');
  assert.equal(aiTimedOut.message, '宿主未响应：wxVerify');
  bridge.window.hostApi.invoke = original;
});

test('wxPickCover uses this frame\'s real file input and sends only the chosen file', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const bridge = loadBridge({
    onPickClick(input) {
      assert.equal(input.type, 'file');
      assert.equal(input.accept, 'image/png,image/jpeg');
      input.files = [{ name: '封面.png', type: 'image/png', size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(0) }];
      input.dispatch('change');
    },
  });
  const pending = bridge.window.mpHost.wxPickCover();
  const [call] = await bridge.waitInvocations(1, 'wxPickCover');
  assert.deepEqual(Object.keys(call.content.args).sort(), ['bytesBase64', 'mime', 'name']);
  assert.equal(call.content.args.name, '封面.png');
  assert.equal(call.content.args.mime, 'image/png');
  assert.equal(Buffer.from(call.content.args.bytesBase64, 'base64').equals(Buffer.from(bytes)), true, 'exactly the chosen bytes');
  assert.equal(bridge.inputs.length, 1, 'one real input element per pick');
  assert.equal(bridge.inputs[0].parentNode, null, 'the input is detached after the pick');

  bridge.deliver('host-result', { id: call.content.id, result: { ok: true, id: 'cover-1', bytes: bytes.length, mime: 'image/png' } });
  const reply = plain(await pending);
  assert.equal(reply.ok, true);
  assert.equal(reply.id, 'cover-1');
  assert.equal(reply.name, '封面.png', 'name is completed from the frame\'s own selection');
  assert.equal(reply.dataUrl, `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
});

test('a cancelled pick returns canceled and sends nothing upstream', async () => {
  const bridge = loadBridge({ onPickClick(input) { input.dispatch('cancel'); } });
  assert.deepEqual(plain(await bridge.window.mpHost.wxPickCover()), { ok: false, canceled: true });
  await bridge.tick();
  assert.equal(bridge.hostInvokes().length, 0);
});

test('a change with no file (empty dialog) is also a cancellation', async () => {
  const bridge = loadBridge({ onPickClick(input) { input.files = []; input.dispatch('change'); } });
  assert.deepEqual(plain(await bridge.window.mpHost.wxPickCover()), { ok: false, canceled: true });
  await bridge.tick();
  assert.equal(bridge.hostInvokes().length, 0);
});

test('the cover picker refuses a foreign type and an oversized file before reading or sending', async () => {
  let read = 0;
  const gif = loadBridge({
    onPickClick(input) {
      input.files = [{ name: 'a.gif', type: 'image/gif', size: 10, arrayBuffer: async () => { read += 1; return new ArrayBuffer(0); } }];
      input.dispatch('change');
    },
  });
  const refusedType = plain(await gif.window.mpHost.wxPickCover());
  assert.equal(refusedType.ok, false);
  assert.equal(refusedType.code, 'MP_WX_COVER_TYPE');
  assert.equal(read, 0, 'the bytes are not read for a refused type');
  await gif.tick();
  assert.equal(gif.hostInvokes().length, 0);

  const huge = loadBridge({
    onPickClick(input) {
      input.files = [{ name: 'big.png', type: 'image/png', size: 11 * 1024 * 1024, arrayBuffer: async () => { read += 1; return new ArrayBuffer(0); } }];
      input.dispatch('change');
    },
  });
  const refusedSize = plain(await huge.window.mpHost.wxPickCover());
  assert.equal(refusedSize.code, 'MP_WX_COVER_LARGE');
  assert.equal(read, 0, 'the bytes are not read for an oversized file');
  await huge.tick();
  assert.equal(huge.hostInvokes().length, 0);
});

test('an unreadable cover file fails locally and never posts half a payload', async () => {
  const bridge = loadBridge({
    onPickClick(input) {
      input.files = [{ name: 'a.png', type: 'image/png', size: 4, arrayBuffer: async () => { throw new Error('disk gone'); } }];
      input.dispatch('change');
    },
  });
  const reply = plain(await bridge.window.mpHost.wxPickCover());
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'MP_WX_COVER_READ');
  assert.match(reply.error, /disk gone/);
  await bridge.tick();
  assert.equal(bridge.hostInvokes().length, 0);
});

test('only one cover picker can be open at a time and it releases afterwards', async () => {
  let inputsCreated = 0;
  const bridge = loadBridge({ onPickClick() { inputsCreated += 1; } });
  const first = bridge.window.mpHost.wxPickCover();
  const second = bridge.window.mpHost.wxPickCover();
  assert.equal(first, second, 'the in-flight pick is reused');
  assert.equal(inputsCreated, 1);
  assert.equal(bridge.window.__dshBridge.hostApi.coverPickInFlight(), true);
  bridge.inputs[0].dispatch('cancel');
  assert.deepEqual(plain(await first), { ok: false, canceled: true });
  assert.equal(bridge.window.__dshBridge.hostApi.coverPickInFlight(), false);
  void bridge.window.mpHost.wxPickCover();
  assert.equal(inputsCreated, 2, 'a later pick opens a fresh input');
  bridge.inputs[1].dispatch('cancel');
});

test('the bridge never overrides host methods the parent frame already provided', async () => {
  const mine = () => 'app-provided';
  const bridge = loadBridge({ mpHost: { aiRewrite: mine, wxStatus: mine, keep: 1 } });
  assert.equal(bridge.window.mpHost.aiRewrite, mine);
  assert.equal(bridge.window.mpHost.wxStatus, mine);
  assert.equal(bridge.window.mpHost.keep, 1);
  assert.equal(typeof bridge.window.mpHost.wxCreateDraft, 'function', 'missing ones are still installed');
});
