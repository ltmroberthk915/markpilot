/** 族=control-chars · P5：把"不改动也写盘"这件事**按段归因**
 *
 *  为什么还要一支：P2 的 ② 拍（t1 → snapCC → Ctrl+S）里每个夹具的 mtime 都变了；
 *  P4 的 ① 拍（纯空转 6 秒）却零变化 ⇒ 两支读数对"谁写的"给不出同一答案。
 *  按错-3/错-15：不猜，把两段**分开计时**——先纯空转，再单独跑一次 snapCC（复刻 P2 的 ①），
 *  再单独按 Ctrl+S，每个动作之后都有一段独立观察窗。
 *
 *  分段：
 *    段1 纯空转 4s        （对照：什么都不做）
 *    段2 跑一次 snapCC 后 4s（复刻 P2 的"①打开时引擎读数"）
 *    段3 按第一次 Ctrl+S 后 3s
 *    段4 按第二次 Ctrl+S 后 3s
 *
 *  用法：node control-chars-5.cjs [EXE]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require(path.join(__dirname, 'control-chars-lib.cjs'));

const EXE = process.argv[2] || L.EXE;
const DIR = path.join(L.ROOT, 'p5');
const out = { probe: 'control-chars-5.cjs', exe: EXE, at: new Date().toISOString(), cases: {}, pageErrors: [] };
const J = (o) => JSON.stringify(o);
const snapDisk = (p) => { const s = L.statOf(p) || {}; return { mtimeMs: s.mtimeMs, size: s.size, sha16: L.sha16(p) }; };

async function watch(p, ms, step = 400) {
  const t0 = Date.now(); let last = null, changes = 0, firstMs = null;
  while (Date.now() - t0 < ms) {
    const s = snapDisk(p);
    if (last && (last.sha16 !== s.sha16 || last.mtimeMs !== s.mtimeMs)) { changes++; if (firstMs === null) firstMs = Date.now() - t0; }
    last = s; await L.sleep(step);
  }
  return { 变化次数: changes, 首次变化ms: firstMs, 末次: { mtimeMs: Math.round(last.mtimeMs), sha16: last.sha16, size: last.size } };
}

const CASES = [
  { id: 'H1', name: 'BOM + LF（磁盘字节本来就无需归一）', file: 'h1-bom.md', buf: Buffer.concat([L.BOM, L.utf8('# BOM 文档\n\n正文行一。\n')]) },
  { id: 'H2', name: '混合行尾（磁盘字节需要归一）', file: 'h2-mix.md', buf: L.utf8('# 混合行尾甲\r\n\r\n甲行一\n甲行二\r\n甲行三\n') },
];

async function runCase(c) {
  const dir = path.join(DIR, c.id);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const doc = path.join(dir, c.file);
  const t0 = L.writeBytes(doc, c.buf);
  const rec = { id: c.id, name: c.name, 夹具: { size: t0.size, sha16: t0.sha16, crlf: t0.crlf, lfOnly: t0.lfOnly, bom: t0.bom } };
  const app = await L.F.launch({ exe: EXE, args: [doc], port: L.pickPort(17000 + Number(c.id.slice(1)) * 30), profile: path.join(dir, 'profile') });
  try {
    const page = await L.F.findPage(app.browser, { expectFile: c.file });
    const errs = []; L.wireErrors(page, errs);
    await L.sleep(1200);
    rec['段1_纯空转4s'] = await watch(doc, 4000);
    const s = await L.snapCC(page);
    rec['段2_前_引擎读数'] = { docLen: s.docLen, docLines: s.docLines, docText: J(s.docText && s.docText.slice(0, 60)), host: s.host };
    rec['段2_snapCC后4s'] = await watch(doc, 4000);
    await page.keyboard.press('Control+s');
    rec['段3_第一次CtrlS后3s'] = await watch(doc, 3000);
    rec['段3_磁盘'] = L.bytesInfo(doc);
    await page.keyboard.press('Control+s');
    rec['段4_第二次CtrlS后3s'] = await watch(doc, 3000);
    rec['段4_磁盘'] = L.bytesInfo(doc);
    rec['最终字节与夹具相同'] = L.sha16(doc) === t0.sha16;
    rec.pageErrors = errs; out.pageErrors.push(...errs.map((e) => c.id + ' ' + e));
  } catch (e) { rec.异常 = String((e && e.stack) || e).slice(0, 240); }
  finally { L.F.kill(app); await L.sleep(1300); rec.收尾后进程还在 = L.alive(app.pid); }
  out.cases[c.id] = rec;
  console.log('[' + c.id + '] ' + J(rec));
  return rec;
}

async function main() {
  L.ruler('control-chars-5.cjs', EXE);
  for (const c of CASES) await runCase(c);
  const C = out.cases;
  const wrote = (id, seg) => C[id] && C[id][seg] && C[id][seg].变化次数 > 0;
  out.verdicts = {
    '段1 纯空转：两个夹具都没写盘': !wrote('H1', '段1_纯空转4s') && !wrote('H2', '段1_纯空转4s'),
    '段2 跑一次 snapCC（只读）之后：也没写盘': !wrote('H1', '段2_snapCC后4s') && !wrote('H2', '段2_snapCC后4s'),
    '段3 第一次 Ctrl+S：H2（需归一）写了盘': wrote('H2', '段3_第一次CtrlS后3s'),
    '段3 第一次 Ctrl+S：H1（无需归一）没写盘': !wrote('H1', '段3_第一次CtrlS后3s'),
    '段4 第二次 Ctrl+S：都不再写（写完就不脏了）': !wrote('H1', '段4_第二次CtrlS后3s') && !wrote('H2', '段4_第二次CtrlS后3s'),
    'H2 段3 写完后行尾统一成 CRLF': (C.H2['段3_磁盘'].crlf > 0 && C.H2['段3_磁盘'].lfOnly === 0),
  };
  L.jsonDump(path.join(DIR, 'control-chars-5.json'), out);
  console.log('\n=== 判据 ===');
  console.log(J(out.verdicts));
  console.log('pageErrors: ' + J(out.pageErrors));
}

main().catch((e) => { console.error('探针异常：' + ((e && e.stack) || e)); process.exitCode = 1; });
