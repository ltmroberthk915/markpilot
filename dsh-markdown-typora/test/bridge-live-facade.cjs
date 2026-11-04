'use strict';
// 桥协议回归（无 GUI / 无 DSH）：vm 沙箱里跑真实 dsh-bridge.js，mock 引擎 facade，
// 验证 live 传输桥：UUID 房间票、空正文、exchange/leave/flush/refresh 中继、
// 错误归一（error 必须是字符串 + code）、facade 缺席上报、属主校验、幂等 bind。
// 桥自身不做 OT —— 这里断言的只有"转发形状"，不实现任何协同语义。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../renderer-cm6/dsh-bridge.js'), 'utf8');
const UUID = '6f9619ff-8b86-d011-b42d-00cf4fc964ff';
const settle = (n = 6) => new Promise((resolve) => { let left = n; (function tick() { setImmediate(() => (--left ? tick() : resolve())); })(); });
// vm 跨 realm 对象与主 realm 的原型不同，strict deepEqual 会误报：一律走 JSON 结构比较。
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function makeFrame() {
  const up = [];
  const documentElement = {
    dataset: {}, style: { setProperty() {}, colorScheme: '' },
    insertBefore() {},
  };
  const frame = {
    location: { pathname: '/dsh-markdown-typora/renderer-cm6/index.html', href: 'http://127.0.0.1/dsh-markdown-typora/renderer-cm6/index.html' },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    console: { ...console, error() {} },
    document: {
      documentElement,
      head: null,
      body: null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ setAttribute() {} }),
      get baseURI() { return frame.location.href; },
      addEventListener() {},
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener(type, fn) { frame.__onMessage = fn; },
    __parent: { postMessage(message) { up.push(message); } },
    __up: up,
    __dispatch(data) { frame.__onMessage({ source: frame.parent, data }); },
  };
  frame.parent = frame.__parent;   // 桥读的是 window.parent（标准属性），不是自定义名
  frame.window = frame;
  frame.self = frame;
  vm.createContext(frame);
  vm.runInContext(SOURCE, frame, { filename: 'dsh-bridge.js' });
  return frame;
}

function mockFacade() {
  const state = { binds: [], unbinds: 0, flushes: 0, refreshes: 0, transport: null };
  return {
    state,
    bind(text, transport) { state.binds.push({ text, transport }); state.transport = transport; return transport.join().then(() => {}); },
    unbind() { state.unbinds += 1; if (state.transport) state.transport.leave('cli-1'); },
    flush() { state.flushes += 1; return Promise.resolve({ client: 'cli-1', epoch: UUID, version: 7 }); },
    refresh() { state.refreshes += 1; return Promise.resolve(); },
  };
}

function mockEngine(facade) {
  return {
    documentSession: () => ({ epoch: 1, sourceRevision: 0 }),   // CM 数字 epoch：与房间 UUID 无关
    isComposing: () => false,
    commands: { capture: () => ({}) },
    setValue: () => true,
    liveDocument: facade,
  };
}

function boot(frame, engine) {
  frame.handler.on('open', () => { frame.mpEngine = engine; });
  frame.__dispatch({ __dshmd: true, dir: 'down', type: 'open', content: {
    protocol: 2, docToken: 'tok-1', applyId: 'a1', serial: 1, content: 'hello', expected: null, kind: 'open', rootPath: '',
  } });
}

function lastOf(frame, type) {
  for (let i = frame.__up.length - 1; i >= 0; i -= 1) if (frame.__up[i].type === type) return frame.__up[i];
  return null;
}

async function main() {
  const results = [];

  // C1 UUID 房间票 bind + join 兑现（API.md §2 ok:true 信封）
  {
    const frame = makeFrame(), facade = mockFacade();
    boot(frame, mockEngine(facade));
    await settle();
    frame.__dispatch({ __dshmd: true, dir: 'down', type: 'live-bind', content: {
      protocol: 2, docToken: 'tok-1', text: 'hello', live: { client: 'cli-1', epoch: UUID, version: 3, diskHash: 'ab'.repeat(32), savedVersion: 2 },
    } });
    await settle();
    assert.equal(facade.state.binds.length, 1, 'facade.bind called once');
    assert.equal(facade.state.binds[0].text, 'hello');
    const joined = await facade.state.transport.join();
    assert.ok(sameJson(joined, { ok: true, client: 'cli-1', epoch: UUID, version: 3, text: 'hello', diskHash: 'ab'.repeat(32), savedVersion: 2 }), 'join ticket shape (API.md §2 ok:true envelope)');
    results.push(['C1-uuid-bind-join', true]);
  }

  // C2 空文件：text === '' 是合法正文，bind 不得拒绝
  {
    const frame = makeFrame(), facade = mockFacade();
    boot(frame, mockEngine(facade));
    await settle();
    frame.__dispatch({ __dshmd: true, dir: 'down', type: 'live-bind', content: {
      protocol: 2, docToken: 'tok-1', text: '', live: { client: 'cli-1', epoch: UUID, version: 0, diskHash: 'cd'.repeat(32) },
    } });
    await settle();
    assert.equal(facade.state.binds.length, 1, 'empty text binds');
    const joined = await facade.state.transport.join();
    assert.equal(joined.text, '');
    assert.equal(joined.savedVersion, 0, 'savedVersion falls back to version');
    const err = lastOf(frame, 'live-error');
    assert.equal(err, null, 'no live-error for empty text');
    results.push(['C2-empty-text-bind', true]);
  }

  // C3 exchange 中继往返（ok:true → value 透传并补 ok:true）
  {
    const frame = makeFrame(), facade = mockFacade();
    boot(frame, mockEngine(facade));
    await settle();
    frame.__dispatch({ __dshmd: true, dir: 'down', type: 'live-bind', content: {
      protocol: 2, docToken: 'tok-1', text: 'hello', live: { client: 'cli-1', epoch: UUID, version: 3 },
    } });
    await settle();
    const value = { epoch: UUID, version: 4, savedVersion: 3, diskHash: 'ef'.repeat(32), updates: [{ version: 4, client: 'other', seq: 1, changes: [{ from: 5, to: 5, insert: ' [A-local]' }] }] };
    const pending = facade.state.transport.exchange('cli-1', { epoch: UUID, version: 3, seq: 1, changes: [{ from: 0, to: 0, insert: 'x' }] });
    await settle(2);
    const up = lastOf(frame, 'live-exchange');
    assert.ok(up, 'live-exchange sent up');
    assert.equal(up.content.docToken, 'tok-1');
    assert.equal(up.content.client, 'cli-1');
    assert.deepEqual(up.content.request.changes, [{ from: 0, to: 0, insert: 'x' }]);
    frame.__dispatch({ __dshmd: true, dir: 'down', type: 'live-exchange-result', content: { protocol: 2, docToken: 'tok-1', id: up.content.id, response: { ok: true, value } } });
    const relayed = await pending;
    assert.ok(sameJson(relayed, Object.assign({ ok: true }, value)), 'exchange result passes value through with ok:true (API.md §2)');
    results.push(['C3-exchange-relay', true]);
  }

  // C4 错误归一：{error:{code,message}} → {ok:false, error:String, code}
  {
    const frame = makeFrame(), facade = mockFacade();
    boot(frame, mockEngine(facade));
    await settle();
    frame.__dispatch({ __dshmd: true, dir: 'down', type: 'live-bind', content: { protocol: 2, docToken: 'tok-1', text: 't', live: { client: 'cli-1', epoch: UUID, version: 1 } } });
    await settle();
    const pending = facade.state.transport.exchange('cli-1', { epoch: UUID, version: 1 });
    await settle(2);
    const up = lastOf(frame, 'live-exchange');
    frame.__dispatch({ __dshmd: true, dir: 'down', type: 'live-exchange-result', content: { protocol: 2, docToken: 'tok-1', id: up.content.id, response: { ok: false, error: { code: 'MP_LIVE_SESSION', message: '会话已结束' } } } });
    const normalized = await pending;
    assert.equal(normalized.ok, false);
    assert.equal(normalized.code, 'MP_LIVE_SESSION');
    assert.equal(typeof normalized.error, 'string');
    assert.equal(normalized.error, '会话已结束');
    results.push(['C4-error-normalize', true]);
  }

  // C5/C6 flush + refresh 中继
  {
    const frame = makeFrame(), facade = mockFacade();
    boot(frame, mockEngine(facade));
    await settle();
    frame.__dispatch({ __dshmd: true, dir: 'down', type: 'live-bind', content: { protocol: 2, docToken: 'tok-1', text: 't', live: { client: 'cli-1', epoch: UUID, version: 1 } } });
    await settle();
    frame.__dispatch({ __dshmd: true, dir: 'down', type: 'live-flush', content: { protocol: 2, docToken: 'tok-1', id: 'f1' } });
    frame.__dispatch({ __dshmd: true, dir: 'down', type: 'live-refresh', content: { protocol: 2, docToken: 'tok-1' } });
    await settle();
    assert.equal(facade.state.flushes, 1);
    assert.equal(facade.state.refreshes, 1);
    const flushed = lastOf(frame, 'live-flush-result');
    assert.equal(flushed.content.id, 'f1');
    assert.equal(flushed.content.ok, true);
    assert.ok(sameJson(flushed.content.result, { client: 'cli-1', epoch: UUID, version: 7 }), 'flush result relayed');
    results.push(['C5-flush-refresh-relay', true]);
  }

  // C7 unbind：facade 解绑 + leave 上行；在途 exchange 以 MP_LIVE_GONE 结清
  {
    const frame = makeFrame(), facade = mockFacade();
    boot(frame, mockEngine(facade));
    await settle();
    frame.__dispatch({ __dshmd: true, dir: 'down', type: 'live-bind', content: { protocol: 2, docToken: 'tok-1', text: 't', live: { client: 'cli-1', epoch: UUID, version: 1 } } });
    await settle();
    const pending = facade.state.transport.exchange('cli-1', { epoch: UUID, version: 1 });
    await settle(2);
    frame.__dispatch({ __dshmd: true, dir: 'down', type: 'live-unbind', content: { protocol: 2, docToken: 'tok-1' } });
    await settle();
    assert.equal(facade.state.unbinds, 1);
    const gone = await pending;
    assert.equal(gone.ok, false);
    assert.equal(gone.code, 'MP_LIVE_GONE');
    const leave = lastOf(frame, 'live-leave');
    assert.ok(leave, 'leave relayed up');
    assert.equal(leave.content.client, 'cli-1');
    results.push(['C7-unbind-leave-gone', true]);
  }

  // C8 facade 缺席：上报 MP_LIVE_FACADE_MISSING，不 bind（父窗口据此回落单窗口）
  {
    const frame = makeFrame(), facade = mockFacade();
    boot(frame, { documentSession: () => ({ epoch: 1, sourceRevision: 0 }), isComposing: () => false });  // 无 liveDocument
    await settle();
    frame.__dispatch({ __dshmd: true, dir: 'down', type: 'live-bind', content: { protocol: 2, docToken: 'tok-1', text: 't', live: { client: 'cli-1', epoch: UUID, version: 1 } } });
    await settle();
    assert.equal(facade.state.binds.length, 0);
    const err = lastOf(frame, 'live-error');
    assert.equal(err.content.code, 'MP_LIVE_FACADE_MISSING');
    results.push(['C8-facade-missing', true]);
  }

  // C9 属主校验：docToken 不匹配 → MP_LIVE_OWNER
  {
    const frame = makeFrame(), facade = mockFacade();
    boot(frame, mockEngine(facade));
    await settle();
    frame.__dispatch({ __dshmd: true, dir: 'down', type: 'live-bind', content: { protocol: 2, docToken: 'tok-OTHER', text: 't', live: { client: 'cli-1', epoch: UUID, version: 1 } } });
    await settle();
    assert.equal(facade.state.binds.length, 0);
    assert.equal(lastOf(frame, 'live-error').content.code, 'MP_LIVE_OWNER');
    results.push(['C9-owner-mismatch', true]);
  }

  // C10 幂等：同一 docToken 重复 bind 只认第一次
  {
    const frame = makeFrame(), facade = mockFacade();
    boot(frame, mockEngine(facade));
    await settle();
    const content = { protocol: 2, docToken: 'tok-1', text: 't', live: { client: 'cli-1', epoch: UUID, version: 1 } };
    frame.__dispatch({ __dshmd: true, dir: 'down', type: 'live-bind', content });
    await settle();
    frame.__dispatch({ __dshmd: true, dir: 'down', type: 'live-bind', content });
    await settle();
    assert.equal(facade.state.binds.length, 1);
    results.push(['C10-idempotent-bind', true]);
  }

  // C11 数字 epoch 房间票必须被拒（房间 epoch 是 UUID 字符串；数字是 CM 会话的契约）
  {
    const frame = makeFrame(), facade = mockFacade();
    boot(frame, mockEngine(facade));
    await settle();
    frame.__dispatch({ __dshmd: true, dir: 'down', type: 'live-bind', content: { protocol: 2, docToken: 'tok-1', text: 't', live: { client: 'cli-1', epoch: 7, version: 1 } } });
    await settle();
    assert.equal(facade.state.binds.length, 0, 'numeric room epoch rejected');
    assert.equal(lastOf(frame, 'live-error').content.code, 'MP_LIVE_JOIN');
    results.push(['C11-numeric-epoch-rejected', true]);
  }

  return results;
}

main().then((results) => {
  const failed = results.filter(([, ok]) => !ok);
  console.log(JSON.stringify({ suite: 'bridge-live-facade', passed: failed.length === 0, cases: results.map(([id]) => id) }, null, 2));
}).catch((error) => {
  console.error('bridge-live-facade FAILED:', error && error.stack || error);
  process.exitCode = 1;
});
