/** 族=control-chars · P4：「什么都不改，按一下 Ctrl+S」会不会动磁盘（分段归因 + 落地断言）
 *
 *  分四段，每段独立观察窗（基线＝上一段末次；尺子＝lib.watchDisk，单实现）：
 *    段1 纯空转 4s ／ 段2 只跑一次 snapCC 后 4s ／ 段3 第一次 Ctrl+S 后 3s ／ 段4 第二次 Ctrl+S 后 3s
 *
 *  【为什么要"落地断言"】本机 rename 偶发 EPERM（壳层 `file:save:error … EPERM … rename '…mp-tmp…'`），
 *  失败时磁盘一字不动 ⇒ 只看磁盘会把"按键没成功"误读成"应用不写盘"（错-3：单一证据不下结论）。
 *  做法：按之前先**真实点一下正文**（焦点在编辑面），按之后在壳层 `main-debug.log` 里等一条**属于本夹具的
 *  `file:save` 新行**（按前按后计数比对）；没落地就重按，最多 3 次，并把每次的错误行原样记下来。
 *
 *  用法：node control-chars-4.cjs [EXE]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require(path.join(__dirname, 'control-chars-lib.cjs'));

const EXE = process.argv[2] || L.EXE;
const DIR = path.join(L.ROOT, 'p4');
const out = { probe: 'control-chars-4.cjs', exe: EXE, at: new Date().toISOString(), cases: {}, pageErrors: [] };
const J = (o) => JSON.stringify(o);

const CASES = [
  { id: 'G1', name: 'BOM + LF（字节本来就无需归一）', file: 'g1-bom.md', marker: '正文行一', buf: Buffer.concat([L.BOM, L.utf8('# BOM 文档\n\n正文行一。\n')]) },
  { id: 'G2', name: '混合行尾（CRLF 多；字节需要归一）', file: 'g2-mix.md', marker: '甲行一', buf: L.utf8('# 混合行尾甲\r\n\r\n甲行一\n甲行二\r\n甲行三\n') },
  { id: 'G3', name: '只有 CR 的老文件（字节需要归一）', file: 'g3-cr.md', marker: '甲行一', buf: L.utf8('# CR 老文件\r甲行一\r乙行二\r') },
];

async function runCase(c) {
  const dir = path.join(DIR, c.id);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const profile = path.join(dir, 'profile');
  const doc = path.join(dir, c.file);
  const t0 = L.writeBytes(doc, c.buf);
  const rec = { id: c.id, name: c.name, 夹具: { size: t0.size, sha16: t0.sha16, bom: t0.bom, crlf: t0.crlf, lfOnly: t0.lfOnly, crOnly: t0.crOnly } };
  const saveLines = () => ((L.shellLog(profile, 'file:save') || {}).matched || []).filter((l) => l.includes(c.file));
  const app = await L.F.launch({ exe: EXE, args: [doc], port: L.pickPort(16600 + Number(c.id.slice(1)) * 30), profile });
  try {
    const page = await L.F.findPage(app.browser, { expectFile: c.file });
    const errs = []; L.wireErrors(page, errs);
    await L.sleep(1200);
    let base = L.nowDisk(doc);
    const seg = async (tag, ms, act) => {
      let actRec = null;
      if (act) actRec = await act();
      const w = await L.watchDisk(doc, ms, { baseline: base });
      base = w.末次;
      rec[tag] = { 动作: actRec, 变化次数: w.变化次数, 首次变化ms: w.首次变化ms, 末次: { mtimeMs: Math.round(w.末次.mtimeMs), sha16: w.末次.sha16, size: w.末次.size }, 磁盘字节: L.bytesInfo(doc) };
      return w;
    };
    /* 真实按下 Ctrl+S 并在壳层日志里等它落地（落地才作数） */
    const pressUntilLanded = async (label) => {
      const before = saveLines().length;
      const attempts = [];
      for (let i = 0; i < 3; i++) {
        const foc = await L.clickBody(page, c.marker);   // 真实鼠标点正文：先保证焦点在编辑面
        await page.keyboard.press('Control+s');
        let line = null;
        for (let k = 0; k < 14 && !line; k++) { await L.sleep(100); const ls = saveLines(); if (ls.length > before) line = ls[ls.length - 1]; }
        attempts.push({ 第几次: i + 1, 焦点: foc, 落地: !!line, 新行: line ? line.slice(-150) : null });
        if (line) return { 落地: true, 尝试次数: i + 1, 尝试明细: attempts };
      }
      return { 落地: false, 尝试次数: 3, 尝试明细: attempts };
    };
    await seg('段1_纯空转4s', 4000, null);
    const s = await L.snapCC(page);
    rec.段2_前_引擎读数 = { docLen: s.docLen, docLines: s.docLines, docText: J(s.docText && s.docText.slice(0, 60)), host: s.host, banner: s.banner, viewFocus: s.viewFocus, activeEl: s.activeEl };
    await seg('段2_snapCC后4s', 4000, null);
    await seg('段3_第一次CtrlS后3s', 3000, () => pressUntilLanded('段3'));
    await seg('段4_第二次CtrlS后3s', 3000, () => pressUntilLanded('段4'));
    rec.最终字节与夹具相同 = L.sha16(doc) === t0.sha16;
    rec.本次壳层save行 = saveLines().map((l) => l.replace(/^(\S+)/, '$1'));
    rec.pageErrors = errs; out.pageErrors.push(...errs.map((e) => c.id + ' ' + e));
  } catch (e) { rec.异常 = String((e && e.stack) || e).slice(0, 240); }
  finally { L.F.kill(app); await L.sleep(1300); rec.收尾后进程还在 = L.alive(app.pid); }
  out.cases[c.id] = rec;
  const brief = { ...rec }; for (const k of ['段1_纯空转4s', '段2_snapCC后4s', '段3_第一次CtrlS后3s', '段4_第二次CtrlS后3s']) brief[k] = { ...rec[k], 采样: undefined };
  console.log('[' + c.id + '] ' + J(brief));
  return rec;
}

async function main() {
  L.ruler('control-chars-4.cjs', EXE);
  for (const c of CASES) await runCase(c);
  const C = out.cases;
  const wrote = (id, tag) => C[id] && C[id][tag] && C[id][tag].变化次数 > 0;
  const landed = (id, tag) => C[id] && C[id][tag] && C[id][tag].动作 && C[id][tag].动作.落地 === true;
  out.verdicts = {
    '段1 纯空转：三个夹具都不写盘（应用不会自己动盘）': CASES.every((c) => !wrote(c.id, '段1_纯空转4s')),
    '段2 只读读数（snapCC）之后：也不写盘': CASES.every((c) => !wrote(c.id, '段2_snapCC后4s')),
    '段3 Ctrl+S 落地：三个夹具都等到了属于本夹具的 file:save 新行': CASES.every((c) => landed(c.id, '段3_第一次CtrlS后3s')),
    '段3 落地即写盘：三个夹具的 mtime 都变了（不改动也写）': CASES.every((c) => wrote(c.id, '段3_第一次CtrlS后3s')),
    '段4 再按一次：仍会再写一次（不是"不脏就跳过"）': CASES.every((c) => landed(c.id, '段4_第二次CtrlS后3s') && wrote(c.id, '段4_第二次CtrlS后3s')),
    'G1 BOM 文件：写盘后字节与打开前逐字节相同（BOM 保住、内容不变）': C.G1.最终字节与夹具相同 === true,
    'G2 混合行尾：写盘后行尾被统一成 CRLF（字节变了）': (C.G2.段4_第二次CtrlS后3s.磁盘字节.crlf > 0 && C.G2.段4_第二次CtrlS后3s.磁盘字节.lfOnly === 0 && C.G2.段4_第二次CtrlS后3s.磁盘字节.crOnly === 0),
    'G3 CR-only：写盘后 CR 全变 LF（字节变了）': (C.G3.段4_第二次CtrlS后3s.磁盘字节.crOnly === 0 && C.G3.段4_第二次CtrlS后3s.磁盘字节.lfOnly === 3),
    '本环境出现过 rename EPERM（记录在案，非"应用不写盘"）': CASES.some((c) => ((C[c.id].本次壳层save行 || []).join(' ').includes('EPERM'))),
  };
  out.cleanup = { MarkPilot进程总数: L.tasklistMarkpilot() };
  L.jsonDump(path.join(DIR, 'control-chars-4.json'), out);
  console.log('\n=== 判据 ===');
  console.log(J(out.verdicts));
  console.log('pageErrors: ' + J(out.pageErrors));
}

main().catch((e) => { console.error('探针异常：' + ((e && e.stack) || e)); process.exitCode = 1; });
