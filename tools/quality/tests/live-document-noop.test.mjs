// 共享增量队列：本地编辑在未上行阶段被后续编辑正好抵消时，必须丢弃这笔空增量，
// 不能以 changes:[] 上行（权威协议要求非空，否则 flush/保存以 MP_LIVE_CHANGE 失败）。
// 实测触发：在共享笔记里 Ctrl+X 剪切一段 → Ctrl+Z 撤销 → Ctrl+Y 重做 → Ctrl+S。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '../../..');
const stateUrl = pathToFileURL(path.join(repo, 'dsh-markpilot/node_modules/@codemirror/state/dist/index.js')).href;
const liveUrl = pathToFileURL(path.join(repo, 'dsh-markpilot/src-cm6/live-document.js')).href;
const { ChangeSet, Text } = await import(stateUrl);
const { createLiveDocument } = await import(liveUrl);

const FULL = 'TOP alpha START\nFormula $x+y$ paragraph\nCode `let i = 1` sample\n![diagram](sample.svg)\nTAIL omega END\nAfter sentinel\n';
const REMAINING = 'TOP \nAfter sentinel\n';
const CUT = { from: 4, to: 101, insert: '' };
const UNDO = { from: 4, to: 4, insert: FULL.slice(4, 101) };

function harness() {
  let text = FULL, version = 0;
  const requests = [];
  const view = { state: { doc: Text.of(text.split('\n')) } };
  const transport = {
    onStatus() {},
    async leave() {},
    async join() {
      return { ok: true, client: 'c1', epoch: 'e1', version: 0, savedVersion: 0, diskHash: 'disk0', text: FULL };
    },
    async exchange(client, request) {
      requests.push(JSON.parse(JSON.stringify(request)));
      if (request.changes === undefined) {
        return { ok: true, client: 'c1', epoch: 'e1', version, savedVersion: 0, diskHash: 'disk0', updates: [] };
      }
      // 与 shell/live-documents.js 相同的权威判据：增量列表非空、有序且落在正文内。
      if (!Array.isArray(request.changes) || !request.changes.length) {
        return { ok: false, error: '无效的协同编辑', code: 'MP_LIVE_CHANGE' };
      }
      version += 1;
      return { ok: true, client: 'c1', epoch: 'e1', version, savedVersion: 0, diskHash: 'disk0',
        updates: [{ version, client: 'c1', seq: request.seq, changes: request.changes }] };
    },
  };
  const live = createLiveDocument({
    getView: () => view,
    composing: () => false,
    apply: change => { text = change.apply(Text.of(text.split('\n'))).toString(); },
  });
  // Apply a local edit to the fake view and produce the ChangeSet that observe() sees.
  const local = ({ from, to, insert }) => {
    const changes = ChangeSet.of({ from, to, insert }, text.length);
    text = changes.apply(Text.of(text.split('\n'))).toString();
    return { docChanged: true, changes, transactions: [{ docChanged: true, annotation: () => undefined }] };
  };
  return { live, transport, requests, local, currentText: () => text };
}

test('未上行编辑被撤销+重做抵消后，flush 不上行空 changes', async t => {
  const h = harness();
  t.after(() => h.live.unbind());
  await h.live.bind(FULL, h.transport);
  h.live.observe(h.local(CUT));
  assert.equal(h.live.status().pending, 1);
  await h.live.flush(); // seq 1 上行并被权威接受
  assert.equal(h.live.status().pending, 0);
  assert.equal(h.live.status().version, 1);
  h.live.observe(h.local(UNDO)); // 撤销：把那 97 字插回
  h.live.observe(h.local(CUT)); // 重做：再删掉 → 合成净零
  assert.equal(h.live.status().pending, 0, '净零增量不得留在队列');
  const flushed = await h.live.flush();
  assert.equal(flushed.version, 1);
  assert(h.requests.every(r => r.changes === undefined || r.changes.length > 0), '权威不允许空 changes');
  assert.equal(h.currentText(), REMAINING);
});

test('净零丢弃后退回序号：下一次真实编辑仍从 lease.seq+1 连续上行', async t => {
  const h = harness();
  t.after(() => h.live.unbind());
  await h.live.bind(FULL, h.transport);
  h.live.observe(h.local(CUT));
  await h.live.flush(); // lease.seq = 1（权威已接受）
  h.live.observe(h.local(UNDO)); // seq 2 待发
  h.live.observe(h.local(CUT)); // 合成净零 → 丢弃并退回序号
  h.live.observe(h.local({ from: 4, to: 4, insert: 'X' })); // 真实编辑 → 仍是 seq 2
  assert.equal(h.live.status().pending, 1);
  const flushed = await h.live.flush();
  assert.equal(flushed.version, 2);
  const sent = h.requests.filter(r => Array.isArray(r.changes));
  assert.equal(sent.length, 2, 'seq1 与真实编辑两笔上行');
  assert.equal(sent[1].seq, 2, '丢弃空增量必须把预分配序号退回');
  assert.deepEqual(sent[1].changes, [{ from: 4, to: 4, insert: 'X' }]);
});
