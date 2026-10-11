/** 族=control-chars · P6：含 ESC/BEL（**没有 NUL**）的文件：打开 → 保存 → **再打开**
 *
 *  为什么补这一支：P1 证明了 ESC/BEL 能逐字节进文档并落盘，但那个夹具后来被写进了 NUL
 *  ⇒ "ESC/BEL 本身会不会触发二进制嗅探（前 4KB 含 NUL 才拒）"这条没有直接读数。
 *  这里用**纯 ESC/BEL 夹具**跑一遍完整来回，并用"再打开"证明它仍被当文本文件接受。
 *
 *  用法：node control-chars-6.cjs [EXE]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require(path.join(__dirname, 'control-chars-lib.cjs'));

const EXE = process.argv[2] || L.EXE;
const DIR = path.join(L.ROOT, 'p6');
const DOC = path.join(DIR, 'cc-esebel.md');
const TEXT = '# 控制字符文件\n\n前\u001b中\u0007后\n';
const out = { probe: 'control-chars-6.cjs', exe: EXE, at: new Date().toISOString(), cases: {}, pageErrors: [] };
const J = (o) => JSON.stringify(o);

async function main() {
  L.ruler('control-chars-6.cjs', EXE);
  fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
  const t0 = L.writeBytes(DOC, L.utf8(TEXT));

  /* 第一次打开：改一个字 → 保存 */
  const app = await L.F.launch({ exe: EXE, args: [DOC], port: L.pickPort(17400), profile: path.join(DIR, 'profile1') });
  const page = await L.F.findPage(app.browser, { expectFile: 'cc-esebel.md' });
  const errs = []; L.wireErrors(page, errs);
  await L.sleep(1500);
  const s0 = await L.snapCC(page);
  await L.clickBody(page, '前');
  await page.keyboard.press('End');
  await page.keyboard.type('Z');
  await L.sleep(200);
  const s1 = await L.snapCC(page);
  const d1 = L.nowDisk(DOC);
  const landed = L.shellLog(path.join(DIR, 'profile1'), 'file:save').matched.filter((l) => l.includes('cc-esebel.md'));
  await page.keyboard.press('Control+s');
  const w = await L.waitDisk(DOC, { mtimeMs: d1.mtimeMs, sha16: d1.sha16 }, 3500);
  const after = L.bytesInfo(DOC);
  out.cases['第一次打开与保存'] = {
    夹具: { size: t0.size, sha16: t0.sha16 },
    打开时: { docText: J(s0.docText), docLen: s0.docLen, ESC个数: s0.ctrlCounts[27] || 0, BEL个数: s0.ctrlCounts[7] || 0, host: s0.host, renderedLines: s0.renderedLines, 行文本码: s0.lineCodes },
    编辑后: { docText: J(s1.docText), ESC个数: s1.ctrlCounts[27] || 0, BEL个数: s1.ctrlCounts[7] || 0 },
    保存: { 磁盘变了: w.changed, 用时ms: w.ms, 磁盘: after, 壳层file_save: landed.map((l) => l.slice(-110)) },
    pageErrors: errs,
  };
  out.pageErrors.push(...errs);
  L.F.kill(app); await L.sleep(1600);

  /* 第二次打开：应被当文本接受（ESC/BEL 不在嗅探判据里） */
  const app2 = await L.F.launch({ exe: EXE, args: [DOC], port: L.pickPort(17600), profile: path.join(DIR, 'profile2') });
  let relErr = null, s2 = null;
  try {
    const p2 = await L.F.findPage(app2.browser, { expectFile: 'cc-esebel.md', timeoutMs: 15000 });
    s2 = await L.snapCC(p2);
  } catch (e) { relErr = String((e && e.message) || e).slice(0, 160); }
  const wins = (() => { try { return L.F.winList(path.join(__dirname, 'win-file-ops-win.ps1'), app2.pid).filter((x) => x.pid === app2.pid).map((x) => ({ cls: x.cls, title: x.title })); } catch (e) { return [{ err: String((e && e.message) || e).slice(0, 60) }]; } })();
  out.cases['第二次打开'] = {
    找到夹具页: !relErr, 失败原因: relErr,
    文档: s2 ? { docText: J(s2.docText), docLen: s2.docLen, ESC个数: s2.ctrlCounts[27] || 0, BEL个数: s2.ctrlCounts[7] || 0, title: s2.title } : null,
    原生窗口: wins,
    壳层: L.shellLog(path.join(DIR, 'profile2'), 'readDoc:binary-refused|openPath:loaded|openPath:error').matched.filter((l) => l.includes('cc-esebel.md')).map((l) => l.slice(-130)),
  };
  const dlg = wins.find((x) => /#32770/.test(x.cls || ''));
  L.F.kill(app2); await L.sleep(1300);
  out.cleanup = { MarkPilot进程总数: L.tasklistMarkpilot(), 一号进程还在: L.alive(app.pid), 二号进程还在: L.alive(app2.pid) };

  const C = out.cases;
  out.verdicts = {
    '打开时文档逐字符等于夹具（ESC/BEL 都在）': C.第一次打开与保存.打开时.docText === J(TEXT),
    'ESC/BEL 落盘（磁盘 0x1B / 0x07 各一）': (after.esc === 1 && after.bel === 1),
    '第二次打开仍被接受（没有 binary-refused）': C.第二次打开.找到夹具页 === true,
    '第二次打开没弹原生框': !dlg,
    '第二次打开文档里 ESC/BEL 仍在': !!(s2 && s2.ctrlCounts[27] === 1 && s2.ctrlCounts[7] === 1),
  };
  L.jsonDump(path.join(DIR, 'control-chars-6.json'), out);
  console.log(JSON.stringify(C));
  console.log('\n=== 判据 ===');
  console.log(J(out.verdicts));
  console.log('pageErrors: ' + J(out.pageErrors));
  console.log('cleanup: ' + J(out.cleanup));
}

main().catch((e) => { console.error('探针异常：' + ((e && e.stack) || e)); process.exitCode = 1; });
