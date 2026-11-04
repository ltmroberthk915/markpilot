'use strict';
// 保留我的修改（keep-mine）在共享房间里的授权边界：
// 只有该文件房间自己的成员、且本窗正文仍等于房间权威正文时，才允许把自己
// 未保存的草稿写盘并清房；任何正文落后、非成员、普通外写都保持原有保护。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { LiveDocuments } = require('../../../MarkPilot-CM6/shell/live-documents');

const BASE = 'alpha\nomega\n';
const TYPED = 'alpha\nomegaLOCAL\n';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-live-keep-'));
const write = (file, text) => fs.writeFileSync(file, text);
const read = file => fs.readFileSync(file, 'utf8');
function world(tag, base = BASE) {
  const dir = path.join(root, tag); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'note.md'); write(file, base);
  return { dir, file, base };
}
function type(live, member, insert, at = 11) {
  return live.exchange(member.client, { epoch: member.epoch, version: 0, seq: 1, changes: [{ from: at, to: at, insert }] });
}

test('本房间成员的保留：正文一致时写盘成功、草稿落盘并清房', async () => {
  const w = world('owned');
  const live = new LiveDocuments({ directory: w.dir });
  const member = await live.join(w.file, w.base);
  assert.equal(type(live, member, 'LOCAL').version, 1);
  let calls = 0;
  const receipt = await live.external(w.file, async () => {
    calls++;
    write(w.file, TYPED);
    return { ok: true, bytes: TYPED.length };
  }, { client: member.client, keepMineText: TYPED });
  assert.equal(calls, 1, '授权保留必须真的调用写者一次');
  assert.equal(read(w.file), TYPED, '盘上就是本窗正文');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.clean, true);
  assert.equal(receipt.liveVersion, 1);
  const head = live.exchange(member.client, { epoch: member.epoch, version: 1 });
  assert.equal(head.version, head.savedVersion, '写盘后房间是干净的');
  assert.equal(head.diskHash, receipt.diskHash);
  live.leave(member.client);
});

test('正文落后于房间：保留失败且写者不运行、原件与草稿都不动', async () => {
  const w = world('stale');
  const live = new LiveDocuments({ directory: w.dir });
  const member = await live.join(w.file, w.base);
  type(live, member, 'X');
  let called = false;
  await assert.rejects(live.external(w.file, async () => { called = true; write(w.file, w.base); }, {
    client: member.client, keepMineText: w.base,
  }), error => error.code === 'MP_LIVE_STALE');
  assert.equal(called, false);
  assert.equal(read(w.file), w.base, '落后正文绝不允许覆盖磁盘');
  const head = live.exchange(member.client, { epoch: member.epoch, version: 1 });
  assert.notEqual(head.version, head.savedVersion, '草稿仍保留在房间里');
  live.leave(member.client);
});

test('非本房间成员（别的实例/窗口）携带正文也不能代写', async () => {
  const w = world('foreign');
  const owner = new LiveDocuments({ directory: w.dir });
  const mine = await owner.join(w.file, w.base);
  const other = new LiveDocuments({ directory: w.dir });
  const theirs = await other.join(w.file, w.base);
  type(owner, mine, 'MINE');
  let called = false;
  await assert.rejects(owner.external(w.file, async () => { called = true; }, {
    client: theirs.client, keepMineText: 'alpha\nomegaMINE\n', // 正文形状正确也按成员拒绝
  }), error => error.code === 'MP_LIVE_SESSION');
  assert.equal(called, false);
  assert.equal(read(w.file), w.base);
  owner.leave(mine.client); other.leave(theirs.client);
});

test('不加保留授权时，未保存草稿仍然拒绝普通外写（原保护不变）', async () => {
  const w = world('plain');
  const live = new LiveDocuments({ directory: w.dir });
  const member = await live.join(w.file, w.base);
  type(live, member, 'LOCAL');
  let called = false;
  await assert.rejects(live.external(w.file, async () => { called = true; write(w.file, 'EXT\n'); }),
    error => error.code === 'MP_FILE_CONFLICT');
  assert.equal(called, false);
  assert.equal(read(w.file), w.base);
  live.leave(member.client);
});

test('保留清房之后，同房外写恢复既有 adopt 流程', async () => {
  const w = world('after');
  const live = new LiveDocuments({ directory: w.dir });
  const member = await live.join(w.file, w.base);
  type(live, member, 'LOCAL');
  await live.external(w.file, async () => { write(w.file, TYPED); return { ok: true }; },
    { client: member.client, keepMineText: TYPED });
  const external = await live.external(w.file, async () => { write(w.file, 'EXT\n'); return { ok: true, bytes: 4 }; });
  assert.equal(external.ok, true);
  const head = live.exchange(member.client, { epoch: member.epoch, version: 1 });
  assert.equal(head.version, head.savedVersion, '外写被 adopt 成干净的房间');
  assert.equal(head.diskHash, require('node:crypto').createHash('sha256').update('EXT\n').digest('hex'));
  live.leave(member.client);
});
