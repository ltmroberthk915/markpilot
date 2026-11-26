import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_REPLY_CHARS,
  MAX_SELECTION_CHARS,
  REWRITE_CODES,
  SYSTEM_PROMPT,
  rewriteSelectedText,
  userMessageText,
} from '../lib/selection-rewrite-model.js';

const SELECTION = { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
const TEXT = '## 结论\n\n这个方法**可行**，成本可控。';

/** A chunk stream driven by a script, with optional per-step delays. */
function scripted(steps, { onReturn, throwAt } = {}) {
  const calls = [];
  const iterator = {
    i: 0,
    async next() {
      const step = steps[this.i];
      if (throwAt !== undefined && this.i === throwAt) {
        this.i += 1;
        throw Object.assign(new Error('transport broke'), { code: 'TRANSPORT' });
      }
      this.i += 1;
      if (step === undefined) return { done: true, value: undefined };
      if (typeof step === 'function') return await step();
      if (step instanceof Error) throw step;
      return { done: false, value: step };
    },
    async return() {
      calls.push('return');
      if (onReturn) return onReturn();
      return { done: true, value: undefined };
    },
  };
  const llm = {
    options: [],
    stream(options) {
      this.options.push(options);
      return { [Symbol.asyncIterator]: () => iterator };
    },
  };
  return { llm, iterator, calls };
}

const finish = (kind, extra = {}) => ({ type: 'finish', reason: { kind, ...extra } });
const delta = (text, index = 0) => ({ type: 'text-delta', index, text });
const blockEnd = (text, index = 0) => ({ type: 'block-end', index, block: { type: 'text', text } });

test('one streamed reply is assembled from every text delta in order, with one request', async () => {
  const { llm, calls } = scripted([
    { type: 'block-start', index: 0, blockType: 'text' },
    delta('这个'),
    delta('方法'),
    delta('可行。'),
    { type: 'usage', usage: { inputTokens: 12, outputTokens: 5 } },
    finish('stop'),
  ]);

  const result = await rewriteSelectedText({ llm, selection: SELECTION, text: TEXT });

  assert.deepEqual(result, { ok: true, text: '这个方法可行。' });
  assert.deepEqual(calls, ['return'], 'the source is closed once, after the read');
  assert.equal(llm.options.length, 1, 'exactly one model request');

  const options = llm.options[0];
  assert.equal(options.provider, 'deepseek-official');
  assert.equal(options.model, 'deepseek-v4-flash');
  assert.equal(options.system, SYSTEM_PROMPT);
  assert.equal(options.reasoningEffort, undefined, 'no effort is invented when the server did not verify one');
  assert.equal(options.maxTokens, undefined, 'the adapter output cap applies; no cap is forged here');
  assert.deepEqual(options.messages, [
    { role: 'user', content: [{ type: 'text', text: userMessageText(TEXT) }] },
  ]);
  assert.equal(JSON.stringify(options).includes('filePath'), false);
  assert.equal(JSON.stringify(options).includes('D:\\'), false);
});

test('a verified reasoning effort travels with the request and nothing else does', async () => {
  const { llm } = scripted([delta('好'), finish('stop')]);
  await rewriteSelectedText({ llm, selection: { ...SELECTION, reasoningEffort: 'high' }, text: TEXT });
  assert.equal(llm.options[0].reasoningEffort, 'high');

  const other = scripted([delta('好'), finish('stop')]);
  await rewriteSelectedText({ llm: other.llm, selection: { ...SELECTION, reasoningEffort: '' }, text: TEXT });
  assert.equal(other.llm.options[0].reasoningEffort, undefined, 'an empty effort is not sent');
});

test('the request carries only the framed selection: no session, path, whole document, or tools', async () => {
  const { llm } = scripted([delta('ok'), finish('stop')]);
  await rewriteSelectedText({ llm, selection: SELECTION, text: TEXT });
  const options = llm.options[0];
  assert.deepEqual(Object.keys(options).sort(), ['messages', 'model', 'provider', 'system']);
  assert.equal(options.tools, undefined);
  assert.equal(options.sessionId, undefined);
  assert.equal(options.messages.length, 1);
  assert.equal(options.messages[0].role, 'user');
  assert.equal(options.messages[0].content.length, 1);
  const text = options.messages[0].content[0].text;
  assert.equal(text, `<<<SELECTION\n${TEXT}\nSELECTION>>>`);
  assert.equal(text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n')), TEXT, 'the selection is carried verbatim');
});

test('an authoritative text block replaces its deltas instead of being appended twice', async () => {
  const { llm } = scripted([
    { type: 'block-start', index: 0, blockType: 'text' },
    delta('润色'),
    delta('后的'),
    blockEnd('润色后的整段'),
    finish('stop'),
  ]);
  assert.deepEqual(await rewriteSelectedText({ llm, selection: SELECTION, text: TEXT }), { ok: true, text: '润色后的整段' });
});

test('block-end alone (no deltas) still yields the reply, and late deltas after a close are ignored', async () => {
  const closed = scripted([blockEnd('只有结束块'), finish('stop')]);
  assert.deepEqual(await rewriteSelectedText({ llm: closed.llm, selection: SELECTION, text: TEXT }), { ok: true, text: '只有结束块' });

  const late = scripted([delta('正文'), blockEnd('正文'), delta('多余'), finish('stop')]);
  assert.deepEqual(await rewriteSelectedText({ llm: late.llm, selection: SELECTION, text: TEXT }), { ok: true, text: '正文' });

  // A duplicated block-end is malformed; the first one already closed the block.
  const twice = scripted([blockEnd('第一次'), blockEnd('第二次'), finish('stop')]);
  assert.deepEqual(await rewriteSelectedText({ llm: twice.llm, selection: SELECTION, text: TEXT }), { ok: true, text: '第一次' });
});

test('reasoning deltas and unknown future chunk kinds never become reply text', async () => {
  const { llm } = scripted([
    { type: 'reasoning-delta', index: 0, text: '先想一下' },
    { type: 'future-kind', payload: { text: '不应出现' } },
    delta('结果'),
    { type: 'block-start', index: 1, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 1, text: '另一个思考块' },
    finish('stop'),
  ]);
  assert.deepEqual(await rewriteSelectedText({ llm, selection: SELECTION, text: TEXT }), { ok: true, text: '结果' });
});

test('a wire-format reply with several text blocks is joined once, in stream order', async () => {
  const { llm } = scripted([
    { type: 'block-start', index: 0, blockType: 'text' },
    delta('第一段', 0),
    blockEnd('第一段', 0),
    { type: 'block-start', index: 1, blockType: 'text' },
    delta('第二段', 1),
    finish('stop'),
  ]);
  assert.deepEqual(await rewriteSelectedText({ llm, selection: SELECTION, text: TEXT }), { ok: true, text: '第一段 第二段' });
});

test('the terminal finish ends the read: nothing after it is consumed', async () => {
  const { llm, iterator } = scripted([
    delta('正文'),
    finish('stop'),
    delta('结束后的内容'),
    new Error('never read'),
  ]);
  assert.deepEqual(await rewriteSelectedText({ llm, selection: SELECTION, text: TEXT }), { ok: true, text: '正文' });
  assert.equal(iterator.i, 2, 'iteration stopped exactly at the finish chunk');
});

test('each terminal failure is reported by code, never as a partial rewrite', async (t) => {
  await t.test('error finish keeps the host failure code', async () => {
    const { llm } = scripted([delta('半截'), finish('error', { failure: { code: 'MISSING_CREDENTIAL', message: 'no api key' } })]);
    assert.deepEqual(await rewriteSelectedText({ llm, selection: SELECTION, text: TEXT }), {
      ok: false, code: 'MISSING_CREDENTIAL', error: 'no api key',
    });
  });

  await t.test('aborted finish is cancellation', async () => {
    const { llm } = scripted([delta('半截'), finish('aborted', { failure: { code: 'ABORTED', message: 'stopped' } })]);
    const result = await rewriteSelectedText({ llm, selection: SELECTION, text: TEXT });
    assert.equal(result.ok, false);
    assert.equal(result.code, REWRITE_CODES.aborted);
    assert.equal(result.text, undefined);
  });

  await t.test('max-tokens is a truncated result, not a shorter rewrite', async () => {
    const { llm } = scripted([delta('不完整'), finish('max-tokens')]);
    const result = await rewriteSelectedText({ llm, selection: SELECTION, text: TEXT });
    assert.equal(result.code, REWRITE_CODES.truncated);
    assert.equal(result.text, undefined);
  });

  await t.test('tool calls are refused even when text arrived first', async () => {
    const withFinish = scripted([delta('正文'), finish('tool-calls')]);
    assert.equal((await rewriteSelectedText({ llm: withFinish.llm, selection: SELECTION, text: TEXT })).code, REWRITE_CODES.toolCalls);

    const viaDelta = scripted([delta('正文'), { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'markdown', argumentsDelta: '{}' }, finish('stop')]);
    assert.equal((await rewriteSelectedText({ llm: viaDelta.llm, selection: SELECTION, text: TEXT })).code, REWRITE_CODES.toolCalls);

    const viaBlock = scripted([{ type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c', name: 'markdown', arguments: '{}' } }, finish('stop')]);
    assert.equal((await rewriteSelectedText({ llm: viaBlock.llm, selection: SELECTION, text: TEXT })).code, REWRITE_CODES.toolCalls);
  });

  await t.test('an unknown finish kind is a protocol failure', async () => {
    const { llm } = scripted([delta('正文'), { type: 'finish', reason: { kind: 'paused' } }]);
    assert.equal((await rewriteSelectedText({ llm, selection: SELECTION, text: TEXT })).code, REWRITE_CODES.badFinish);
  });

  await t.test('a stream that ends without a finish chunk is a protocol failure', async () => {
    const { llm } = scripted([delta('正文')]);
    assert.equal((await rewriteSelectedText({ llm, selection: SELECTION, text: TEXT })).code, REWRITE_CODES.noFinish);
  });

  await t.test('an empty or whitespace-only reply is a failure, not a deletion', async () => {
    for (const text of ['', '   \n\t ']) {
      const { llm } = scripted([delta(text), finish('stop')]);
      const result = await rewriteSelectedText({ llm, selection: SELECTION, text: TEXT });
      assert.equal(result.code, REWRITE_CODES.emptyReply);
      assert.equal(result.text, undefined);
    }
  });
});

test('a thrown stream becomes a coded failure and still closes the source cleanly', async () => {
  const thrownOnCreate = {
    stream() { throw Object.assign(new Error('no adapter'), { code: 'NO_ADAPTER' }); },
  };
  assert.deepEqual(await rewriteSelectedText({ llm: thrownOnCreate, selection: SELECTION, text: TEXT }), {
    ok: false, code: 'NO_ADAPTER', error: 'no adapter',
  });

  const midStream = scripted([delta('正文'), new Error('boom')]);
  const result = await rewriteSelectedText({ llm: midStream.llm, selection: SELECTION, text: TEXT });
  assert.equal(result.code, REWRITE_CODES.stream);
  assert.equal(result.error, 'boom');
  assert.deepEqual(midStream.calls, ['return'], 'the source is closed on the failure path too');

  const notAsync = { stream() { return { text: 'nope' }; } };
  assert.equal((await rewriteSelectedText({ llm: notAsync, selection: SELECTION, text: TEXT })).code, REWRITE_CODES.stream);
});

test('cancellation wins even when the provider never observes the signal', async () => {
  const controller = new AbortController();
  let closed = 0;
  const llm = {
    stream() {
      return {
        [Symbol.asyncIterator]: () => ({
          next() {
            // A provider that would answer only after the user gave up.
            return new Promise((resolve) => setTimeout(() => resolve({ done: false, value: finish('stop') }), 50));
          },
          async return() { closed += 1; },
        }),
      };
    },
  };
  const pending = rewriteSelectedText({ llm, selection: SELECTION, text: TEXT, signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, REWRITE_CODES.aborted);
  assert.equal(closed, 1, 'the source is closed once after cancellation');

  const already = new AbortController();
  already.abort();
  let dispatched = 0;
  const untouched = { stream() { dispatched += 1; throw new Error('must not be called'); } };
  const refused = await rewriteSelectedText({ llm: untouched, selection: SELECTION, text: TEXT, signal: already.signal });
  assert.equal(refused.code, REWRITE_CODES.aborted);
  assert.equal(dispatched, 0, 'an already-cancelled call never reaches the provider');
});

for (const [label, input, code, needle] of [
  ['no llm service', { selection: SELECTION, text: TEXT }, REWRITE_CODES.unavailable, 'ctx.llm'],
  ['llm without stream', { llm: {}, selection: SELECTION, text: TEXT }, REWRITE_CODES.unavailable, 'ctx.llm'],
  ['no verified provider', { llm: { stream() {} }, selection: { model: 'm' }, text: TEXT }, REWRITE_CODES.noModel, 'provider'],
  ['no verified model', { llm: { stream() {} }, selection: { provider: 'p' }, text: TEXT }, REWRITE_CODES.noModel, 'provider'],
  ['non-text selection', { llm: { stream() {} }, selection: SELECTION, text: 42 }, REWRITE_CODES.badInput, '选区'],
  ['empty selection', { llm: { stream() {} }, selection: SELECTION, text: '  \n ' }, REWRITE_CODES.emptyText, '选中'],
  ['oversized selection', { llm: { stream() {} }, selection: SELECTION, text: 'x'.repeat(MAX_SELECTION_CHARS + 1) }, REWRITE_CODES.tooLong, '分段'],
]) {
  test(`refuses ${label} before any model call`, async () => {
    let called = 0;
    const llm = input.llm && typeof input.llm.stream === 'function'
      ? { stream() { called += 1; return { [Symbol.asyncIterator]: () => ({ async next() { return { done: true }; } }) }; } }
      : input.llm;
    const result = await rewriteSelectedText({ ...input, llm });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(called, 0, 'no model call is made for a refused request');
    assert.equal(result.text, undefined);
    assert.match(result.error, new RegExp(needle));
  });
}

test('the selection limit is inclusive at the boundary', async () => {
  const exact = 'y'.repeat(MAX_SELECTION_CHARS);
  const { llm } = scripted([delta('ok'), finish('stop')]);
  assert.equal((await rewriteSelectedText({ llm, selection: SELECTION, text: exact })).ok, true);
});

test('a runaway reply is stopped instead of being buffered without bound', async () => {
  const chunk = 'z'.repeat(1_000);
  let served = 0;
  const llm = {
    stream() {
      return {
        [Symbol.asyncIterator]: () => ({
          async next() {
            served += 1;
            if (served > 10_000) return { done: true, value: undefined };
            return { done: false, value: delta(chunk) };
          },
          async return() {},
        }),
      };
    },
  };
  const result = await rewriteSelectedText({ llm, selection: SELECTION, text: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.code, REWRITE_CODES.replyTooLong);
  assert.ok(served < 10_000, `stopped early (read ${served} chunks)`);
});

test('the public reply cap is honoured for a long selection', async () => {
  const selection = 'a'.repeat(MAX_SELECTION_CHARS);
  const chunk = 'b'.repeat(10_000);
  let served = 0;
  const llm = {
    stream() {
      return {
        [Symbol.asyncIterator]: () => ({
          async next() {
            served += 1;
            if (served * chunk.length > MAX_REPLY_CHARS + 20_000) return { done: true, value: undefined };
            return { done: false, value: delta(chunk) };
          },
          async return() {},
        }),
      };
    },
  };
  const result = await rewriteSelectedText({ llm, selection: SELECTION, text: selection });
  assert.equal(result.code, REWRITE_CODES.replyTooLong);
});

test('a reply is returned verbatim: no trimming, no fence stripping, no echo guessing', async () => {
  const reply = '```markdown\n保留的围栏\n```\n\n尾随第二段  \n';
  const { llm } = scripted([delta(reply), finish('stop')]);
  assert.deepEqual(await rewriteSelectedText({ llm, selection: SELECTION, text: TEXT }), { ok: true, text: reply });
});

test('failures never echo the selection back as diagnostic text', async () => {
  const secret = 'SECRET-SELECTION-BODY';
  const { llm } = scripted([delta('x'), finish('error', { failure: { code: 'RATE_LIMIT', message: 'slow down' } })]);
  const result = await rewriteSelectedText({ llm, selection: SELECTION, text: `前文\n${secret}\n后文` });
  assert.equal(result.code, 'RATE_LIMIT');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('diagnostics stay on one bounded line', async () => {
  const { llm } = scripted([delta('x'), finish('error', { failure: { code: 'TRANSPORT', message: `multi\nline\t${'w'.repeat(900)}` } })]);
  const result = await rewriteSelectedText({ llm, selection: SELECTION, text: TEXT });
  assert.equal(result.code, 'TRANSPORT');
  assert.equal(/[\r\n\t]/.test(result.error), false);
  assert.ok(result.error.length <= 320, `error length ${result.error.length}`);
});

test('hostile arguments and hostile stream objects cannot throw out of the call', async () => {
  const hostileText = { toString() { throw new Error('nope'); } };
  const result = await rewriteSelectedText({ llm: { stream() {} }, selection: SELECTION, text: hostileText });
  assert.equal(result.code, REWRITE_CODES.badInput);

  const hostileStream = {
    stream() {
      return {
        [Symbol.asyncIterator]: () => ({
          async next() { return { done: false, value: { get type() { throw new Error('trap'); } } }; },
          async return() {},
        }),
      };
    },
  };
  const thrown = await rewriteSelectedText({ llm: hostileStream, selection: SELECTION, text: TEXT });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.code, REWRITE_CODES.stream, 'a hostile chunk is a stream failure, not a crash');

  const hostileSelection = { model: 'm', get provider() { throw new Error('trap'); } };
  const exploded = await rewriteSelectedText({ llm: { stream() {} }, selection: hostileSelection, text: TEXT });
  assert.equal(exploded.ok, false);
  assert.equal(exploded.code, REWRITE_CODES.internal, 'the outermost guard still returns a result object');

  for (const input of [undefined, null, 'string', 42, { llm: null, selection: null, text: null }]) {
    const refused = await rewriteSelectedText(input);
    assert.equal(refused.ok, false);
    assert.equal(typeof refused.code, 'string');
  }
});

test('a finish with no failure object still reports a code, and a stop with no text fails', async () => {
  const bare = scripted([finish('error')]);
  const result = await rewriteSelectedText({ llm: bare.llm, selection: SELECTION, text: TEXT });
  assert.equal(result.code, REWRITE_CODES.failed);

  const silent = scripted([finish('stop')]);
  assert.equal((await rewriteSelectedText({ llm: silent.llm, selection: SELECTION, text: TEXT })).code, REWRITE_CODES.emptyReply);
});
