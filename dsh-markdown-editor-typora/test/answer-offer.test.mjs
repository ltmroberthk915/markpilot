import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyScope, reduceReferenceEvent } from '../lib/reference-scope.js';
import { createAnswerWriter } from '../lib/answer-write.js';

test('a mixed directive writes to its reference and a chat answer needs a separate gesture', () => {
  let state = emptyScope(), seq = 0;
  const apply = (type, data) => { state = reduceReferenceEvent(state, {type, data, seq: ++seq}); };
  const user = text => apply('user/message', {role: 'user', source: {kind:'user'}, content:[{type:'text',text}]});
  apply('turn/start', {turn:1});
  user('> 只读引用：A.md · 文件 【MP引用 ' + 'x'.repeat(43) + '】\n> 资料\n\n这个解释一下什么意思 补到合适位置');
  assert.equal(state.write, true);
  apply('turn/end', {turn:1, reason:{kind:'completed'}});
  apply('turn/start', {turn:2});
  user('这个你根据最新信息，先把名词解释和最新的宏观情况补一个答案吧');
  assert.equal(state.write, false);
  apply('assistant/message', {turn:2, message:{id:'done',source:{kind:'model'},content:[{type:'text',text:'答案'}]}});
  apply('turn/end', {turn:2,reason:{kind:'completed'}});
  assert.equal(state.offers.length, 1);
  assert.equal(state.offers[0].file.path, 'A.md');
  user('算了，不用落地，只在对话里讲。');
  assert.deepEqual(state.offers, []);
});

test('a committed answer is never appended again after a remount or selective undo', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mp-answer-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const key = {sessionId:'one', turn:2, endSeq:9, answerSeq:8};
  const path = join(directory, 'A.md');
  let group, writes = 0;
  const deps = {
    directory, resolve: () => ({path,body:'回答一\n\n回答二'}),
    read: async () => ({ok:true,value:{canonical:path,text:'原文',revisionId:'old'}}),
    group: async (_path,id) => id === group?.groupId ? group : null,
    apply: async (payload, _, options) => {
      assert.deepEqual(payload, {path,position:'end',baseRevisionId:'old',newString:'\n\n回答一\n\n回答二'});
      options.check();
      writes++;
      group = {groupId:options.groupId};
      return {ok:true};
    },
  };
  const writer = createAnswerWriter(deps);
  assert.equal((await writer({...key,path:'B.md'},true)).ok, false);
  assert.equal((await writer(key,false)).value.path, path);
  await Promise.all([writer(key,true), writer(key,true)]);
  group.undoneAt = 42;
  assert.equal((await createAnswerWriter(deps)(key,true)).value.undoneAt, 42);
  assert.equal(writes, 1);
});
