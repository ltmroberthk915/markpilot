import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { admitMessage, authorizeReference, emptyScope, referenceSigner } from '../lib/reference-scope.js';

test('web research stays available during a reference discussion and a target-bound edit', () => {
  const agent = { id: 'one' };
  const toolSet = {};
  const discussion = admitMessage(emptyScope(), {
    role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '> 只读引用：A.md · 文件' }],
  });
  assert.equal(discussion.files.length, 1);
  const webCalls = [['web_fetch', { url: 'https://example.org' }], ['web_search', { queries: ['付息兑付'] }]];
  for (const preset of [undefined, { id: 'standard' }]) for (const [name, args] of webCalls) {
    const inherited = { name };
    let admitted = inherited;
    const tools = { get(tool, scope, step) {
      assert.equal(tool, name);
      if (scope === preset) return inherited;
      if (!scope) return undefined;
      assert.equal(scope, agent);
      assert.equal(step, toolSet);
      return admitted;
    } };
    const call = { name, arguments: args, agent, toolSet };
    for (const state of [discussion, { ...discussion, write: true }]) {
      const check = exec => authorizeReference(state, agent.id, exec, undefined, tools, () => preset);
      assert.equal(check(call), undefined, name);
      assert.equal(check({ ...call, arguments: { ...args, output_path: 'B.md' } }).info.code, 'MP_REFERENCE_SCOPE');
      for (const other of [{ name }, undefined]) {
        admitted = other;
        assert.equal(check(call).info.code, 'MP_REFERENCE_SCOPE');
      }
      admitted = inherited;
      assert.equal(check({ ...call, name: name + '_and_save' }).info.code, 'MP_REFERENCE_SCOPE');
    }
  }
});

test('reference ownership across tools, users, turns and restored sessions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mp-reference-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [];
  for (const name of ['A', 'B']) {
    const dir = join(root, name);
    await mkdir(dir);
    const file = join(dir, '同名.md');
    await writeFile(file, 'identical text');
    files.push(await realpath(file));
  }
  const [a, b] = files;
  const sign = referenceSigner(root);
  const quote = p => '> 只读引用：' + p + ' · 第 1 行 【MP引用 ' + sign('one', p) + '】\n> \n> 改';
  const message = (text, kind = 'user') => ({ role: 'user', source: { kind }, content: [{ type: 'text', text }] });
  const nextTurn = s => ({ ...s, receivedReferences: false, write: false });
  const edit = path => ({ name: 'edit', arguments: { file_path: path } });
  const allowed = (s, call, id = 'one') => !authorizeReference(s, id, call, sign);
  const discussion = admitMessage(emptyScope(), message(quote(a) + '\n\n我觉得这一段不对'));
  assert.equal(allowed(emptyScope(), edit(b)), true);
  assert.equal(allowed(discussion, { name: 'read' }), true);
  for (const tool of [edit(a), edit(b), { name: 'bash' }, { name: 'terminal' }, { name: 'run_code' }, { name: 'agent' },
    { name: 'apply_patch' }, { name: 'markdown', arguments: { action: 'editSelection', path: a } }]) {
    assert.equal(allowed(discussion, tool), false, tool.name);
  }
  const modify = admitMessage(nextTurn(discussion), message('改'));
  for (const instruction of ['补入专门估值章节', '请追加到附录', '添加到正文', '插入一段说明']) {
    const follow = admitMessage(nextTurn(discussion), message(instruction));
    assert(allowed(follow, edit(a)));
    assert(!allowed(follow, edit(b)));
  }
  for (const question of ['补入专门估值章节合适吗', '如果补入专门估值章节', '补入这段会怎样', '不要补入这段']) {
    assert(!allowed(admitMessage(nextTurn(discussion), message(question)), edit(a)));
  }
  const tools = { get: () => tools };
  const basic = (s, name, args) => !authorizeReference(s, 'one', { name, arguments: args }, sign, tools);
  for (const [name, args] of [
    ['read_image', { file_path: b }], ['present', { files: [{ path: b }] }], ['working_directory', { cd: 'B' }],
    ['ask_user_question', { questions: [] }], ['terminal_list', {}], ['terminal_read', { sessionId: 'term' }],
    ['get_goal', {}], ['markdown', { action: 'blocks', path: a }], ['markdown', { action: 'inspect', path: b }],
    ['plugin_manager', { action: 'list_plugins' }], ['session_telecom', {}], ['see_now', { action: 'help' }],
  ]) assert(basic(discussion, name, args), name);
  for (const [name, args] of [
    ['terminal_send', { text: 'x' }], ['plugin_manager', { action: 'set_plugin' }], ['see_now', { action: 'status', say: 'x' }],
    ['session_telecom', { action: 'send' }], ['read_image', { file_path: a, output_path: b }],
    ['remote_download_file', {}], ['schedule_create', {}], ['made_up_query', {}],
  ]) assert(!basic(modify, name, args), name);
  for (const [name, args] of [
    ['markdown', { action: 'batch' }], ['markdown', { action: 'merge3' }], ['markdown', { action: 'undo' }], ['markdown', { action: 'insert' }],
    ['str_replace_editor', { command: 'str_replace' }], ['str_replace_editor', { command: 'insert' }],
  ]) {
    assert(!basic(discussion, name, { ...args, path: a }));
    assert(basic(modify, name, { ...args, path: a }));
    assert(!basic(modify, name, { ...args, path: b }));
  }
  assert.equal(allowed(modify, edit(a)), true);
  for (const text of ['请在附录 H 后新增一节', '这个怎么理解？你把这个加到附录 H', '先查一下，再补到附录 H', '这个你也都给补上啊', '请在文末追加一段', '请将这段插入附录 H 之后']) {
    assert.equal(allowed(admitMessage(discussion, message(text)), edit(a)), true, text);
  }
  for (const text of ['在附录 H 后新增一节？', '讨论一下，补到附录 H', '不要在附录 H 后新增一节', '补入 H 是什么意思', '新增这一节可能影响什么', '你可以先解释，补上这个会影响哪里']) {
    assert.equal(allowed(admitMessage(discussion, message(text)), edit(a)), false, text);
  }
  assert.equal(allowed(modify, edit(b)), false);
  assert.equal(allowed(modify, edit(a), 'other-session'), false);
  assert.equal(referenceSigner(root)('one', a), sign('one', a));
  for (const text of ['改吗？', '请先讨论怎么改', '不要修改', '能不能改一下？']) {
    assert.equal(allowed(admitMessage(modify, message(text)), edit(a)), false);
  }
  assert.equal(allowed(admitMessage(discussion, message('改', 'runtime-context')), edit(a)), false);
  assert.equal(allowed(admitMessage(discussion, message(quote(b), 'markpilot-reference')), edit(b)), false);
  const both = admitMessage(nextTurn(modify), message(quote(a) + '\n\n' + quote(b) + '\n\n改'));
  const sameBatch = admitMessage(admitMessage(emptyScope(), message(quote(a))), message(quote(b) + '\n\n改'));
  for (const group of [both, sameBatch]) {
    assert.equal(group.files.length, 2);
    assert.equal(allowed(group, edit(a)), false);
    assert.equal(allowed(group, edit(b)), false);
    const choice = admitMessage(group, message('选择目标 2'));
    assert.equal(allowed(choice, edit(b)), false);
    const confirmed = admitMessage(nextTurn(choice), message('请修改'));
    assert.equal(allowed(confirmed, edit(b)), true);
    assert.equal(allowed(confirmed, edit(a)), false);
    assert.equal(allowed(admitMessage(confirmed, message('结束引用')), { name: 'bash' }), true);
  }
  const replaced = admitMessage(nextTurn(discussion), message(quote(b) + '\n\n改'));
  assert.equal(allowed(replaced, edit(b)), true);
  const altered = admitMessage(emptyScope(), message(quote(a).replace(a, b) + '\n\n改'));
  assert.equal(allowed(altered, edit(b)), false);
  for (const prefix of ['> ', '']) {
    const old = admitMessage(emptyScope(), message(prefix + '只读引用：' + a + ' · 第 1 行\n\n改'));
    assert.equal(allowed(old, edit(a)), false);
    assert.equal(allowed(old, edit(b)), false);
  }
});
