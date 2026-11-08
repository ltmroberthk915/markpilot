'use strict';
// client.js 纯函数回归（无浏览器）：__ModuleLoader__ 捕获工厂后只测 __test 面。
// 覆盖：live 保存请求的房间票形状（UUID 字符串 epoch + 整数 version；数字 epoch 拒收）、
// 保存回执并入（applyLiveReceipt）、live 错误分类（liveErrorAction）。
const path = require('node:path');
const assert = require('node:assert/strict');

const UUID = '6f9619ff-8b86-d011-b42d-00cf4fc964ff';
let captured = null;
global.window = { __ModuleLoader__: { load(m) { captured = m; } } };
require(path.resolve(__dirname, '..', 'lib', 'client.js'));
assert.ok(captured, '__ModuleLoader__.load captured the factory');
const exports_ = captured.factory((id) => {
  if (id === 'react') return null;   // 组件不渲染，纯函数可用
  throw new Error('unexpected require: ' + id);
});
const t = exports_.__test;
assert.ok(t && t.buildSaveRequest && t.applyLiveReceipt && t.liveErrorAction, '__test exports present');

const results = [];
const note = (id, ok, detail) => { results.push({ id, ok: !!ok, detail: detail || null }); if (!ok) process.exitCode = 1; };

// L1 UUID 房间票 → 请求体带 live；CM 数字 epoch 一票拒收（两种契约不得混用）。
{
  const good = t.buildSaveRequest({ path: 'D:/x/a.md', text: 't', baseVersion: 'v1', live: { client: 'c1', epoch: UUID, version: 4 } });
  note('L1-uuid-ticket-accepted', good.ok === true && good.body.live && good.body.live.epoch === UUID && good.body.live.version === 4 && good.body.live.client === 'c1',
    JSON.stringify(good.body && good.body.live));
  const numeric = t.buildSaveRequest({ path: 'D:/x/a.md', text: 't', baseVersion: 'v1', live: { client: 'c1', epoch: 7, version: 4 } });
  note('L1-numeric-epoch-rejected', numeric.ok === false && numeric.reason === 'malformed-live-ticket', JSON.stringify(numeric));
  const noClient = t.buildSaveRequest({ path: 'D:/x/a.md', text: 't', baseVersion: 'v1', live: { epoch: UUID, version: 4 } });
  note('L1-missing-client-rejected', noClient.ok === false && noClient.reason === 'malformed-live-ticket');
  const plain = t.buildSaveRequest({ path: 'D:/x/a.md', text: 't', baseVersion: 'v1' });
  note('L1-plain-request-unchanged', plain.ok === true && plain.body.live === undefined && plain.body.path === 'D:/x/a.md');
}

// L2 保存回执并入：savedVersion/diskHash/epoch(UUID)/liveVersion 采纳，垃圾字段忽略。
{
  const live = { client: 'c1', epoch: UUID, version: 4, diskHash: 'old', savedVersion: 3 };
  const next = t.applyLiveReceipt(live, { savedVersion: 9, diskHash: 'newhash', epoch: '11111111-2222-3333-4444-555555555555', liveVersion: 12 });
  note('L2-receipt-merge', next.savedVersion === 9 && next.diskHash === 'newhash' && next.epoch === '11111111-2222-3333-4444-555555555555' && next.version === 12 && next.client === 'c1',
    JSON.stringify(next));
  const garbage = t.applyLiveReceipt(live, { savedVersion: 'x', epoch: 123, liveVersion: 'y' });
  note('L2-garbage-ignored', garbage.savedVersion === 3 && garbage.epoch === UUID && garbage.version === 4, JSON.stringify(garbage));
  const untouched = t.applyLiveReceipt(null, { savedVersion: 1 });
  note('L2-null-live-unchanged', untouched === null);
}

// L3 错误分类：unsupported / conflict（API.md §4 halt 集含 UNREACHABLE 与 CHANGE）/ notice。
{
  note('L3-unsupported', t.liveErrorAction('MP_LIVE_FACADE_MISSING') === 'unsupported');
  const conflicts = ['MP_LIVE_LEASE', 'MP_LIVE_SESSION', 'MP_LIVE_CLOSED', 'MP_LIVE_CONFLICT', 'MP_LIVE_CHANGE',
    'MP_LIVE_UNREACHABLE', 'MP_DOC_MISMATCH', 'MP_FILE_CONFLICT', 'MP_LIVE_STALE'];
  note('L3-conflict-set', conflicts.every((code) => t.liveErrorAction(code) === 'conflict'));
  note('L3-notice-fallback', t.liveErrorAction('MP_LIVE_TRANSPORT') === 'notice' && t.liveErrorAction(undefined) === 'notice'
    && t.liveErrorAction('MP_LIVE_COMPOSING') === 'notice' && t.liveErrorAction('MP_LIVE_SWITCH') === 'notice');
}

// L4 既有守卫不回归：缺 baseVersion 仍然拒绝（版本守卫永不省略）。
{
  const noBase = t.buildSaveRequest({ path: 'D:/x/a.md', text: 't', live: { client: 'c1', epoch: UUID, version: 4 } });
  note('L4-base-version-still-required', noBase.ok === false && noBase.reason === 'missing-base-version');
}

// L5 recovered 展示投影：合法条目保留、畸形丢弃、截 5 条、无 recoveryPath 全弃、非数组忽略。
{
  const items = t.liveRecoveredItems({ client: 'c1', recovered: [
    { recoveryPath: 'C:/temp/mp-draft-a.md', sha256: 'a'.repeat(64), at: 1730000000000 },
    { recoveryPath: '', sha256: 'x' },                       // 空路径 → 弃
    { path: 'C:/no-recoveryPath.md' },                        // 字段名不对 → 弃
    null,                                                     // 非对象 → 弃
    { recoveryPath: 'C:/temp/mp-draft-b.md' },                // 无 sha/at → 仅路径
    { recoveryPath: 'C:/temp/mp-draft-c.md', at: 'not-a-number' },
    { recoveryPath: 'C:/temp/mp-draft-d.md' }, { recoveryPath: 'C:/temp/mp-draft-e.md' },
    { recoveryPath: 'C:/temp/mp-draft-f.md' },                // 第 6 条合法 → 截断
  ] });
  note('L5-recovered-projection',
    items.length === 5
    && items[0].recoveryPath === 'C:/temp/mp-draft-a.md' && items[0].sha256 === 'a'.repeat(64) && items[0].at === 1730000000000
    && items[1].recoveryPath === 'C:/temp/mp-draft-b.md' && items[1].sha256 === undefined && items[1].at === undefined
    && items[2].at === undefined
    && !items.some((entry) => !entry.recoveryPath),
    JSON.stringify(items.map((entry) => entry.recoveryPath)));
  note('L5-recovered-non-array-ignored', t.liveRecoveredItems({ client: 'c1' }).length === 0
    && t.liveRecoveredItems({ recovered: 'nope' }).length === 0 && t.liveRecoveredItems(null).length === 0);
  note('L5-recovered-all-invalid-dropped', t.liveRecoveredItems({ recovered: [{ sha256: 'z' }, 3] }).length === 0);
}

console.log(JSON.stringify({ suite: 'client-live-pure', passed: results.every((r) => r.ok), cases: results }, null, 2));
