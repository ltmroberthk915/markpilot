/** family=path-edge · 用例 e2：**「另存为…」失败机理的定向枚举**（错-3：跳步/条件分支必须定向枚举，不许只靠一个案例）
 *
 *  e1 已测到：打开过一个文件 → 「另存为…」到**新路径** ⇒ 目标从未创建 + 提示"原文件已不在磁盘上"。
 *  本支用三个**同源同类**的臂把"是路径形态问题"还是"是那条 diskMtime 守卫问题"分开：
 *
 *    A 【空文档 → 另存为新路径】   预测：成功（空会话 diskMtime=0，守卫不触发）
 *    B 【打开的文件 → 另存为已存在的目标】预测：成功（守卫的 stat 打得开）
 *    C 【打开的文件 → 另存为新路径】 预测：失败（= e1 复现，同一次运行里的对照）
 *
 *  三臂同夹具、同序列、同尺子（runCycle），只换启动形态/目标存在性。
 *  用法：node path-edge-2-mech.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require(path.join(__dirname, 'path-edge-lib.cjs'));

const CASE = 'e2-mech';
const DIR = path.join(L.ROOT, CASE);
const FIX = path.join(DIR, 'fix');
const R = { probe: 'path-edge-2-mech.cjs', family: 'path-edge', case: CASE, at: new Date().toISOString(), arms: [] };

(async () => {
  L.rulerEdge('path-edge-2-mech.cjs');
  L.freshDir(DIR);
  fs.mkdirSync(FIX, { recursive: true });

  const src = path.join(FIX, '源.md');
  fs.writeFileSync(src, '# 机理 标题\n\n机理 段落 MARK-MECH。\n', 'utf8');

  /* A 空文档 → 新路径 */
  const outA = path.join(FIX, 'A-新路径.md');
  R.armA_pre = { 目标存在: fs.existsSync(outA) };
  const A = await L.runCycle({ id: CASE + '-A-空文档→新路径', blank: true, openDoc: null, saveAsTarget: outA, dir: path.join(DIR, 'runA'), mark: 'A' });
  R.arms.push(A);
  console.log('\n[A 空文档→新路径] filePath(启动后)=' + JSON.stringify(A.openHit.got) + ' 另存为落盘=' + A.stages.saveAsOk + ' 目标存在=' + fs.existsSync(outA));
  console.log('   docInfo=' + JSON.stringify(A.stages.afterSaveAs && A.stages.afterSaveAs.host && A.stages.afterSaveAs.host.filePath));
  console.log('   提示条=' + JSON.stringify(A.stages.afterSaveAs && A.stages.afterSaveAs.banner && A.stages.afterSaveAs.banner.text));

  /* B 打开的文件 → 已存在的目标 */
  const outB = path.join(FIX, 'B-已存在.md');
  fs.writeFileSync(outB, '# 目标旧内容\n\n这条会被覆盖。\n', 'utf8');
  R.armB_pre = { 目标存在: fs.existsSync(outB), 覆盖前字节: fs.statSync(outB).size };
  const B = await L.runCycle({ id: CASE + '-B-打开的文件→已存在目标', openDoc: src, saveAsTarget: outB, openVia: 'openPath', dir: path.join(DIR, 'runB'), mark: 'B' });
  R.arms.push(B);
  console.log('\n[B 打开→已存在目标] 另存为落盘=' + B.stages.saveAsOk + ' 再打字写新路径=' + B.stages.type2WroteNew + ' 目标存在=' + fs.existsSync(outB));
  console.log('   提示条=' + JSON.stringify(B.stages.afterSaveAs && B.stages.afterSaveAs.banner && B.stages.afterSaveAs.banner.text));
  console.log('   目标内容尾=' + JSON.stringify(typeof B.stages.saveAsDisk2 === 'string' ? B.stages.saveAsDisk2.slice(-14) : B.stages.saveAsDisk2));

  /* C 打开的文件 → 新路径（复现臂，与 A/B 同一次运行） */
  const outC = path.join(FIX, 'C-新路径.md');
  R.armC_pre = { 目标存在: fs.existsSync(outC) };
  const C = await L.runCycle({ id: CASE + '-C-打开的文件→新路径', openDoc: src, saveAsTarget: outC, openVia: 'openPath', dir: path.join(DIR, 'runC'), mark: 'C' });
  R.arms.push(C);
  console.log('\n[C 打开→新路径] 另存为落盘=' + C.stages.saveAsOk + ' 目标存在=' + fs.existsSync(outC));
  console.log('   提示条=' + JSON.stringify(C.stages.afterSaveAs && C.stages.afterSaveAs.banner && C.stages.afterSaveAs.banner.text));

  R.verdict = {
    A_空文档另存为新路径: A.stages.saveAsOk === true ? '成功' : '失败',
    B_打开的文件另存为已存在目标: B.stages.saveAsOk === true ? '成功' : '失败',
    C_打开的文件另存为新路径: C.stages.saveAsOk === true ? '成功' : '失败',
  };
  R.disk = {};
  for (const [k, p] of Object.entries({ outA, outB, outC, src })) {
    R.disk[k] = { exists: fs.existsSync(p), tail: (() => { try { return fs.readFileSync(p, 'utf8').slice(-20); } catch (e) { return e.code; } })() };
  }
  console.log('\n[结论三态] ' + JSON.stringify(R.verdict, null, 1));
  console.log('[磁盘] ' + JSON.stringify(R.disk, null, 1));
  console.log('[pageerror] ' + JSON.stringify(R.arms.flatMap((a) => a.errs)));
  L.writeReport('path-edge-2-mech', R);
})().catch((e) => { console.error('✗ 探针异常：' + ((e && e.stack) || e)); process.exit(2); });
