/** family=path-edge · 用例 e2b：**隔离后的空文档臂**（e2 的臂 A 被"迁移 + restoreLast"污染，作废重测）
 *
 *  背景（一线证据）：e2 报告里臂 A 的 `filePath(启动后)` 竟然是 `…\img-bug\verify\copy-original.md`
 *  ——那不是本族夹具。根因：`migrateUserDataFromCm6()` 会把 `%APPDATA%\MarkPilot CM6` 整目录
 *  拷进**没有 settings.json** 的 profile，于是"空文档启动"变成"自动打开了真实用户的 MRU 第一条"。
 *  本支在启动前预置 `settings.json`（restoreLast:false）与 `recents.json`（[]）把入口堵死，
 *  并以 `migrated-from-cm6.txt` **不存在**自证隔离生效。
 *
 *  判据：空文档（diskMtime=0）→ 「另存为…」到**新路径**应当成功（与 e2 臂 B/C 合起来构成完整机理）
 *  用法：node path-edge-2b-blank.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require(path.join(__dirname, 'path-edge-lib.cjs'));

const CASE = 'e2b-blank';
const DIR = path.join(L.ROOT, CASE);
const FIX = path.join(DIR, 'fix');
const R = { probe: 'path-edge-2b-blank.cjs', family: 'path-edge', case: CASE, at: new Date().toISOString(), arms: [] };

(async () => {
  L.rulerEdge('path-edge-2b-blank.cjs');
  L.freshDir(DIR);
  fs.mkdirSync(FIX, { recursive: true });

  /* A' 空文档（隔离后）→ 另存为新路径 */
  const outA = path.join(FIX, 'A2-新路径.md');
  const A = await L.runCycle({ id: CASE + '-A2-空文档→新路径', blank: true, openDoc: null, saveAsTarget: outA, dir: path.join(DIR, 'runA'), mark: 'A' });
  R.arms.push(A);
  console.log('\n[A2 空文档(已隔离)→新路径]');
  console.log('  隔离自证=' + JSON.stringify(A.isolation));
  console.log('  启动后 filePath=' + JSON.stringify(A.openHit && A.openHit.got) + '（应为 null）');
  console.log('  MRU(启动后)=' + JSON.stringify(L.mruBrief(A.stages.afterOpen)));
  console.log('  另存为落盘=' + A.stages.saveAsOk + ' 目标存在=' + fs.existsSync(outA));
  console.log('  docInfo=' + JSON.stringify(A.stages.afterSaveAs && A.stages.afterSaveAs.host && A.stages.afterSaveAs.host.filePath));
  console.log('  标题=' + JSON.stringify(A.stages.afterSaveAs && A.stages.afterSaveAs.title));
  console.log('  提示条=' + JSON.stringify(A.stages.afterSaveAs && A.stages.afterSaveAs.banner && A.stages.afterSaveAs.banner.text));
  console.log('  MRU(另存后)=' + JSON.stringify(L.mruBrief(A.stages.afterSaveAs)));
  console.log('  再打字写新路径=' + A.stages.type2WroteNew + ' 目标尾=' + JSON.stringify(typeof A.stages.saveAsDisk2 === 'string' ? A.stages.saveAsDisk2.slice(-14) : A.stages.saveAsDisk2));

  R.disk = { outA: { exists: fs.existsSync(outA), body: (() => { try { return fs.readFileSync(outA, 'utf8'); } catch (e) { return e.code; } })() } };
  R.verdict = { 空文档另存为新路径: A.stages.saveAsOk === true ? '成功' : '失败', 隔离生效: !!A.isolation.ok };
  console.log('\n[结论] ' + JSON.stringify(R.verdict));
  console.log('[磁盘] ' + JSON.stringify(R.disk));
  console.log('[pageerror] ' + JSON.stringify(A.errs));
  L.writeReport('path-edge-2b-blank', R);
})().catch((e) => { console.error('✗ 探针异常：' + ((e && e.stack) || e)); process.exit(2); });
