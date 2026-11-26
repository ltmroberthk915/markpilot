import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditIsolation } from '../lib/edit-isolation.js';

test('an edit without a model tool call leaves a plugin notice before the parent opens its first step', async () => {
  const events = [];
  const services = {
    llm: { async *stream() { yield { type: 'finish', reason: { kind: 'stop' } }; } },
    tools: { resolve: async () => ({}), execute: () => assert.fail('no edit should execute') },
  };
  const edit = createEditIsolation({
    ctx: { get: name => services[name] },
    documents: { captureSelection: async () => ({ ok: true, value: { selectionId: 'selection-a' } }) },
  });
  const agent = { id: 'chat', session: { append: (...event) => events.push(event) } };
  const held = await edit.prepare({ sessionId: agent.id, path: '/project/a.md', intent: '修改选区' });
  assert.equal(held.ok, true);
  const { nonce, rpcId, selectionId } = held.value;
  const text = '修改目标 ' + selectionId;
  assert.equal((await edit.arm({ nonce, text })).ok, true);
  const marker = { id: 'submission', role: 'user', source: { kind: 'user', rpcId },
    content: [{ type: 'text', text: '[[mp-edit:' + nonce + ']]\n' + text }] };
  const next = await edit.preStep({ agent, signal: new AbortController().signal, turn: 36, step: 1,
    messages: [marker], modelSelection: { provider: 'offline', model: 'test' } },
    async () => ({ kind: 'enter', messages: [marker] }));
  assert.deepEqual(next.messages, []);
  assert.equal(edit.status({ nonce }).value.error.code, 'MP_EDIT_NO_TOOL_CALL');
  assert.deepEqual(events.map(([type]) => type), ['user/message', 'user/message']);
  const [, receipt, surface] = events[1];
  assert.equal(receipt.source.kind, 'markpilot-edit-result');
  assert.equal(receipt.source.form, 'notice');
  assert.match(receipt.content[0].text, /模型没有调用 editSelection/);
  assert.deepEqual(surface, { surfaceOp: 'append' });
});
