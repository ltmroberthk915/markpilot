/** family=path-edge · 用例 e1：**UNC 路径**（\\localhost\E$\…）
 *
 *  范围：打开（启动参数 argv / 壳层 openPath 两条通道）/ 打字后自动保存 / 另存为 / 标题 / MRU（「最近打开」+ 菜单项）
 *  通道：见 path-edge-lib.runCycle 头注；另存为目标来自 MP_TEST_SAVE_AS（不弹原生框）
 *  用法：node path-edge-1-unc.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require(path.join(__dirname, 'path-edge-lib.cjs'));

const CASE = 'e1-unc';
const DIR = path.join(L.ROOT, CASE);
const LOCAL = path.join(DIR, 'fix');                       // E:\… （本地形态）
const UNC_DIR = '\\\\localhost\\E$\\MarkPilot\\.mp-verify\\path-edge\\e1-unc\\fix';  // UNC 形态（同一个目录）

const R = { probe: 'path-edge-1-unc.cjs', family: 'path-edge', case: CASE, at: new Date().toISOString(), cycles: [] };

(async () => {
  L.rulerEdge('path-edge-1-unc.cjs');
  L.freshDir(DIR);
  fs.mkdirSync(LOCAL, { recursive: true });

  const docA = path.join(UNC_DIR, '源 文档 A.md');            // argv 通道
  const outA = path.join(UNC_DIR, '另存 输出 A.md');
  const docB = path.join(UNC_DIR, '源 文档 B.md');            // openPath 通道
  const outB = path.join(UNC_DIR, '另存 输出 B.md');
  for (const p of [docA, docB]) fs.writeFileSync(p, '# UNC 标题\n\nUNC 段落 MARK-UNC。\n', 'utf8');

  R.pathFacts = { docA: L.pathFacts(docA), outA: L.pathFacts(outA) };
  R.fixture = { localDir: LOCAL, uncDir: UNC_DIR, sameDirSeenFromBoth: fs.existsSync(UNC_DIR) };
  console.log('[夹具] UNC 目录可读 = ' + R.fixture.sameDirSeenFromBoth);
  console.log('[路径] docA = ' + docA + '（' + R.pathFacts.docA.chars + ' 字符, UNC=' + R.pathFacts.docA.isUNC + '）');

  /* ① 启动参数带 UNC 路径（与"双击 .md 文件"同一条路） */
  const c1 = await L.runCycle({ id: CASE + '-argv', openDoc: docA, saveAsTarget: outA, openVia: 'argv', dir: path.join(DIR, 'run-argv'), mark: 'V', extraWait: 400 });
  R.cycles.push(c1);
  console.log('\n[argv 通道] 打开命中=' + JSON.stringify(c1.openHit) + ' 打开耗时=' + c1.openMs + 'ms');
  console.log('  标题=' + JSON.stringify(c1.stages.afterOpen && c1.stages.afterOpen.title));
  console.log('  打字落盘=' + c1.stages.typeOk + ' 另存为落盘=' + c1.stages.saveAsOk + ' 再打字写新路径=' + c1.stages.type2WroteNew);
  console.log('  另存后 docInfo=' + JSON.stringify(c1.stages.afterSaveAs && c1.stages.afterSaveAs.host && c1.stages.afterSaveAs.host.filePath));
  console.log('  提示条=' + JSON.stringify(c1.stages.afterSaveAs && c1.stages.afterSaveAs.banner && c1.stages.afterSaveAs.banner.text));
  console.log('  MRU(渲染侧)=' + JSON.stringify(L.mruBrief(c1.stages.afterSaveAs)));

  /* ② 壳层 openPath 带 UNC 路径（与"文件→打开…"选中后的落点同一条路） */
  const c2 = await L.runCycle({ id: CASE + '-openPath', openDoc: docB, saveAsTarget: outB, openVia: 'openPath', dir: path.join(DIR, 'run-openpath'), mark: 'W', extraWait: 400 });
  R.cycles.push(c2);
  console.log('\n[openPath 通道] 打开命中=' + JSON.stringify(c2.openHit) + ' 打开耗时=' + c2.openMs + 'ms');
  console.log('  打字落盘=' + c2.stages.typeOk + ' 另存为落盘=' + c2.stages.saveAsOk + ' 再打字写新路径=' + c2.stages.type2WroteNew);
  console.log('  另存后 docInfo=' + JSON.stringify(c2.stages.afterSaveAs && c2.stages.afterSaveAs.host && c2.stages.afterSaveAs.host.filePath));
  console.log('  MRU(渲染侧)=' + JSON.stringify(L.mruBrief(c2.stages.afterSaveAs)));

  /* ③ 对照臂：**同一个目录**的本地形态（E:\…）——与①②同夹具、同序列、同尺子，
   *    唯一差别是路径形态（UNC vs 盘符）。UNIX 无关：这是 Windows 路径语义的两条路。
   *    【为什么必须有】没有它，"另存为失败"无法区分"UNC 特有"还是"所有新路径都这样"。 */
  const docC = path.join(LOCAL, '源 文档 C.md');
  const outC = path.join(LOCAL, '另存 输出 C.md');
  fs.writeFileSync(docC, '# 本地 标题\n\n本地 段落 MARK-UNC。\n', 'utf8');
  const c3 = await L.runCycle({ id: CASE + '-local-control', openDoc: docC, saveAsTarget: outC, openVia: 'openPath', dir: path.join(DIR, 'run-local'), mark: 'L', extraWait: 400 });
  R.cycles.push(c3);
  console.log('\n[对照·本地盘符] 打开命中=' + JSON.stringify(c3.openHit) + ' 打开耗时=' + c3.openMs + 'ms');
  console.log('  打字落盘=' + c3.stages.typeOk + ' 另存为落盘=' + c3.stages.saveAsOk + ' 再打字写新路径=' + c3.stages.type2WroteNew);
  console.log('  另存后 docInfo=' + JSON.stringify(c3.stages.afterSaveAs && c3.stages.afterSaveAs.host && c3.stages.afterSaveAs.host.filePath));
  console.log('  提示条=' + JSON.stringify(c3.stages.afterSaveAs && c3.stages.afterSaveAs.banner && c3.stages.afterSaveAs.banner.text));

  /* ④ 磁盘侧一手事实：UNC 形态下两个文件都在、且内容含刚敲的字 */
  R.disk = {};
  for (const [k, p] of Object.entries({ docA, outA, docB, outB, docC, outC })) {
    const c = (() => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return { __err: e.code }; } })();
    R.disk[k] = { path: p, exists: fs.existsSync(p), tail: typeof c === 'string' ? c.slice(-12) : c };
  }
  console.log('\n[磁盘] ' + JSON.stringify(R.disk, null, 1));
  console.log('[pageerror] ' + JSON.stringify(R.cycles.flatMap((c) => c.errs)));
  L.writeReport('path-edge-1-unc', R);
})().catch((e) => { console.error('✗ 探针异常：' + ((e && e.stack) || e)); process.exit(2); });
