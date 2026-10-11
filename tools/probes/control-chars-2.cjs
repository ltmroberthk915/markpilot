/** 族=control-chars · P2：BOM / CRLF / 混合行尾 / 只有 CR 的老文件 / 深 NUL 文件 —— 开→改→存 的**磁盘字节**
 *
 *  每个夹具一次启动（argv 带文件＝用户双击那个文件），四拍读数：
 *    ① 打开后空转 1.6s         → 应用会不会**自己**改写原文件
 *    ② 不改动按一次 Ctrl+S      → "打开后随手存一下"会不会改写（BOM/行尾是否原样）
 *    ③ 真实点进正文 + 打一个字符 → 引擎文档（引擎已算好的 doc.lines / doc.toString()）
 *    ④ Ctrl+S（或 500ms 去抖自动保存）→ **磁盘字节**（本族主判据）
 *
 *  壳层口径（MarkPilot-CM6\main.js:196-244）：读时剥 BOM、记行尾风格（CRLF 占多数才算 CRLF），
 *  正文归一成 LF；写时按记录的风格还原行尾并补回 BOM。
 *
 *  用法：node control-chars-2.cjs [EXE]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require(path.join(__dirname, 'control-chars-lib.cjs'));

const EXE = process.argv[2] || L.EXE;
const DIR = path.join(L.ROOT, 'p2');
const out = { probe: 'control-chars-2.cjs', exe: EXE, at: new Date().toISOString(), cases: {}, pageErrors: [] };
const J = (o) => JSON.stringify(o);
const diskNow = (p) => ({ ...L.bytesInfo(p), mtimeMs: ((L.statOf(p) || {}).mtimeMs) });
const deepNul = () => Buffer.concat([...Array.from({ length: 11 }, () => L.utf8('A'.repeat(400) + '\n')), L.utf8('前\u0000后\n')]);

const CASES = [
  { id: 'F1', name: 'UTF-8 BOM + LF', file: 'f1-bom.md', marker: '正文行一', buf: Buffer.concat([L.BOM, L.utf8('# BOM 文档\n\n正文行一。\n')]), want: '存后 BOM 仍在' },
  { id: 'F2', name: '无 BOM + LF（对照臂）', file: 'f2-nobom.md', marker: '正文行一', buf: L.utf8('# 无 BOM 文档\n\n正文行一。\n'), want: '存后不得凭空加 BOM' },
  { id: 'F3', name: 'CRLF', file: 'f3-crlf.md', marker: '正文行一', buf: L.utf8('# CRLF 文档\r\n\r\n正文行一。\r\n第二行。\r\n'), want: '存后行尾仍是 CRLF' },
  { id: 'F4', name: '混合行尾（CRLF 多：3 CRLF + 2 LF）', file: 'f4-mix-crlf.md', marker: '甲行一', buf: L.utf8('# 混合行尾甲\r\n\r\n甲行一\n甲行二\r\n甲行三\n'), want: '存后统一成 CRLF（多数派）' },
  { id: 'F5', name: '混合行尾（LF 多：1 CRLF + 3 LF）', file: 'f5-mix-lf.md', marker: '乙行一', buf: L.utf8('# 混合行尾乙\r\n\r\n乙行一\n乙行二\n乙行三\n'), want: '存后统一成 LF（多数派）' },
  { id: 'F6', name: '只有 CR 的老文件（Classic Mac）', file: 'f6-cr-only.md', marker: '甲行一', buf: L.utf8('# CR 老文件\r甲行一\r乙行二\r'), want: '看它怎么显示、存后行尾变成什么' },
  { id: 'F7', name: 'NUL 在 4KB 之外的文件（深 NUL）', file: 'f7-deep-nul.md', special: 'deepnul', buf: deepNul(), want: '删掉前部让 NUL 落进 4KB 嗅探窗口，再看存后字节' },
];

async function runCase(c) {
  const dir = path.join(DIR, c.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const doc = path.join(dir, c.file);
  const t0 = L.writeBytes(doc, c.buf);
  const rec = { id: c.id, name: c.name, 期望: c.want, 夹具: t0 };
  const port = L.pickPort(15200 + Number(c.id.slice(1)) * 40);
  const app = await L.F.launch({ exe: EXE, args: [doc], port, profile: path.join(dir, 'profile') });
  try {
    const page = await L.F.findPage(app.browser, { expectFile: c.file });
    const errs = []; L.wireErrors(page, errs);
    await L.sleep(1600);
    /* ① 打开后空转 */
    const t1 = diskNow(doc);
    rec['①打开后空转'] = { mtimeMs: t1.mtimeMs, sha16: t1.sha16, 改写了原文件: t1.sha16 !== t0.sha16 };
    const s0 = await L.snapCC(page);
    rec['①打开时引擎读数'] = {
      host命中夹具: String((s0.host || {}).filePath || '').replace(/\\/g, '/').toLowerCase().endsWith(c.file.toLowerCase()),
      docLines: s0.docLines, docLen: s0.docLen, renderedLines: s0.renderedLines,
      head16码: s0.head16, ctrl表: s0.ctrlCounts, 行类: s0.lineClasses.slice(0, 6),
      含U_FEFF: !!(s0.ctrlCounts && s0.ctrlCounts[0xfeff]),
      docText: J(s0.docText && s0.docText.slice(0, 120)),
    };
    /* ② 不改动，按一次 Ctrl+S */
    await page.keyboard.press('Control+s');
    const w2 = await L.waitDisk(doc, { mtimeMs: t1.mtimeMs, sha16: t1.sha16 }, 2600);
    const t2 = diskNow(doc);
    rec['②不改动保存'] = { 磁盘变了: w2.changed, 用时ms: w2.ms, info: t2, 字节与打开前相同: t2.sha16 === t0.sha16 };
    /* ③④ 真实编辑 + 保存 */
    if (c.special === 'deepnul') {
      const pt = (n) => page.evaluate((ln) => {
        const v = window.mpEngine._view(); const line = v.state.doc.line(ln);
        const co = v.coordsAtPos(line.from);
        return { x: Math.round(co.left + 2), y: Math.round(co.top + 5) };
      }, n);
      const a = await pt(1), b = await pt(5);
      await page.mouse.click(a.x, a.y); await L.sleep(160);
      await page.keyboard.down('Shift'); await page.mouse.click(b.x, b.y); await page.keyboard.up('Shift');
      await L.sleep(200);
      const sel = await page.evaluate(() => { const v = window.mpEngine._view(); const r = v.state.selection.main; return { from: r.from, to: r.to, len: r.to - r.from, 活动行类: (document.querySelector('.cm-line.cm-activeLine') || {}).className || null }; });
      await page.keyboard.press('Delete');
      await L.sleep(300);
      rec['③真实键鼠配合'] = { 点1: a, 点5: b, 选区: sel, 操作: 'Shift+左键选前 4 行 → Delete' };
    } else {
      const box = await L.clickBody(page, c.marker);
      await page.keyboard.type('X');
      await L.sleep(200);
      rec['③真实编辑'] = { 点击行: box, 操作: '点进正文行 + End + 键入 X' };
    }
    const s1 = await L.snapCC(page);
    rec['③编辑后引擎读数'] = {
      docLines: s1.docLines, docLen: s1.docLen, renderedLines: s1.renderedLines,
      NUL个数: (s1.ctrlCounts && s1.ctrlCounts[0]) || 0,
      NUL字符下标: s1.docText === null ? null : s1.docText.indexOf('\u0000'),
      CR个数: (s1.ctrlCounts && s1.ctrlCounts[13]) || 0,
      docText: J(s1.docText && s1.docText.slice(0, 120)),
      提示条: s1.banner,
    };
    const t3a = diskNow(doc);
    await page.keyboard.press('Control+s');
    const w3 = await L.waitDisk(doc, { mtimeMs: t3a.mtimeMs, sha16: t3a.sha16 }, 3500);
    const t3 = diskNow(doc);
    rec['④保存后磁盘'] = { 磁盘变了: w3.changed, 用时ms: w3.ms, info: t3 };
    /* 一致性：磁盘解码回来（剥 BOM、CRLF→LF）应与引擎文档逐字符相等（不许丢字/多字） */
    let diskText = null;
    try { diskText = fs.readFileSync(doc, 'utf8'); } catch { }
    if (diskText !== null && diskText.charCodeAt(0) === 0xfeff) diskText = diskText.slice(1);
    const normDisk = diskText === null ? null : diskText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    rec['④一致性'] = {
      磁盘解码_剥BOM_归一CRLF后等于引擎文档: normDisk !== null && normDisk === s1.docText,
      差异定位: normDisk === s1.docText ? null : { diskLen: normDisk === null ? null : normDisk.length, docLen: s1.docLen },
    };
    rec.pageErrors = errs;
    out.pageErrors.push(...errs.map((e) => c.id + ' ' + e));
  } catch (e) {
    rec.异常 = String((e && e.stack) || e).slice(0, 300);
  } finally {
    L.F.kill(app);
    await L.sleep(1300);
    rec.收尾后进程还在 = L.alive(app.pid);
  }
  out.cases[c.id] = rec;
  console.log('[' + c.id + '] ' + J(rec));
  return rec;
}

async function main() {
  L.ruler('control-chars-2.cjs', EXE);
  for (const c of CASES) await runCase(c);

  const C = out.cases;
  const inf = (id, k) => (((C[id] || {})[k] || {}).info || {});
  const s0 = (id) => ((C[id] || {})['①打开时引擎读数'] || {});
  out.verdicts = {
    '各夹具打开后空转都不改写原文件': CASES.every((c) => C[c.id] && C[c.id]['①打开后空转'] && C[c.id]['①打开后空转'].改写了原文件 === false),
    '各夹具"不改动保存"都不动磁盘': CASES.every((c) => C[c.id] && C[c.id]['②不改动保存'] && C[c.id]['②不改动保存'].磁盘变了 === false),
    'F1 打开时文档不含 U+FEFF（BOM 被剥掉）': s0('F1').含U_FEFF === false,
    'F1 保存后 BOM 仍在（磁盘 EF BB BF）': inf('F1', '④保存后磁盘').bom === true,
    'F2 无 BOM 文件保存后不凭空加 BOM': inf('F2', '④保存后磁盘').bom === false,
    'F3 CRLF 保存后行尾仍是 CRLF（lone LF = 0）': (inf('F3', '④保存后磁盘').crlf > 0 && inf('F3', '④保存后磁盘').lfOnly === 0 && inf('F3', '④保存后磁盘').crOnly === 0),
    'F4 混合(CRLF 多) 保存后统一 CRLF': (inf('F4', '④保存后磁盘').crlf > 0 && inf('F4', '④保存后磁盘').lfOnly === 0 && inf('F4', '④保存后磁盘').crOnly === 0),
    'F5 混合(LF 多) 保存后统一 LF': (inf('F5', '④保存后磁盘').crlf === 0 && inf('F5', '④保存后磁盘').lfOnly > 0 && inf('F5', '④保存后磁盘').crOnly === 0),
    'F6 CR-only 打开时被渲染成多行': (s0('F6').docLines || 0) > 1 && (s0('F6').renderedLines || 0) > 1,
    'F6 CR-only 打开后引擎文档里已无 CR': (s0('F6').ctrl表 && !s0('F6').ctrl表[13]),
    'F6 CR-only 保存后 CR 全消失（行尾变 LF）': (inf('F6', '④保存后磁盘').crOnly === 0 && inf('F6', '④保存后磁盘').crlf === 0 && inf('F6', '④保存后磁盘').lfOnly > 0),
    'F7 深 NUL 文件能打开（NUL 在 4KB 之外）': ((C.F7 || {})['③编辑后引擎读数'] || {}).NUL个数 > 0 || (s0('F7').ctrl表 && s0('F7').ctrl表[0] === 1),
    'F7 删前部 + 保存后首 NUL 落进 4096B 嗅探窗口': (inf('F7', '④保存后磁盘').nulOffsets || []).some((o) => o < 4096),
    '各夹具磁盘解码后与引擎文档逐字符一致': CASES.filter((c) => c.id !== 'F7').every((c) => C[c.id] && C[c.id]['④一致性'] && C[c.id]['④一致性'].磁盘解码_剥BOM_归一CRLF后等于引擎文档 === true),
  };
  out.cleanup = { MarkPilot进程总数: L.tasklistMarkpilot() };
  L.jsonDump(path.join(DIR, 'control-chars-2.json'), out);
  console.log('\n=== 判据 ===');
  console.log(J(out.verdicts));
  console.log('pageErrors: ' + J(out.pageErrors));
}

main().catch((e) => { console.error('探针异常：' + ((e && e.stack) || e)); process.exitCode = 1; });
