/** table-daily 族 · 判据鉴别力自证（AGENTS 错-12：绿灯的可信度）
 *
 *  问题：我说"W1/W2/P4/P5b 两条破损在当前产物上不再出现"，怎么证明**我的判据本身测得出**这两条破损？
 *  做法：把两态的真实文档**从留档文件里读出来**（不手抄），喂给探针里**同一批判据**，看它是否变色。
 *   · 红态 = 修复前产物 sha16=81b39273efae31e5，`_table-daily-paste.log`（2026-10-10 09:18:58，唯一一次
 *     带 81b39273 尺子卡的运行）；
 *   · 绿态 = 当前产物 sha16=db7613632e37d99e，`table-daily-out/paste/result.json`（本次复跑，11:51:35）。
 *  两条文档都取 P5b（光标在表行、无覆盖层、粘多行 TSV）这一发的 `文档行`，**逐字节来自留档**。
 *  注意：这是**判据级**自证（证明判据有鉴别力），不是产品代码突变验证（产品代码对本角色只读，
 *  且修复前产物未留存 ⇒ 代码级突变不在本探针能力范围内，已在报告里如实标注）。
 *  用法：node table-daily-judgement-selftest.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const HERE = __dirname;
const OUT = path.join(HERE, 'table-daily-out');

/** 从日志行 `[P5b 表行内粘 TSV] {json}` 里取读数 */
function fromLog(file, caseId) {
  const txt = fs.readFileSync(file, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\[(.+?)\] (\{.*\})\s*$/);
    if (m && m[1] === caseId) return JSON.parse(m[2]);
  }
  return null;
}
/** 从 result.json 的 log 数组里取某条用例读数 */
function fromResult(file, caseId) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (j.log || []).find((r) => r.case === caseId) || null;
}
/** 探针记录的 `文档行` 是 "N:文本" 形式（N 从 1 起） */
const unnum = (arr) => arr.map((s) => String(s).replace(/^\d+:/, ''));

/* ── 探针里的判据（逐条照搬，勿改口径）── */
const pipes = (docLines) => docLines.filter((l) => /^\s*\|/.test(l)).map((l) => (l.match(/(?<!\\)\|/g) || []).length);
const 判据_每行管道数不变 = (after, before) => JSON.stringify(pipes(after)) === JSON.stringify(pipes(before));
const 判据_渲染表行数不变 = (afterRows, beforeRows) => afterRows.length === beforeRows.length;
const 判据_原表头行是否被粘走 = (doc) => doc.split('\n').some((l) => l.includes('| 甲 | 乙 | 丙 |') && l.trim().startsWith('| T4'));
const 判据_正文句没被并进表格行 = (doc) => !doc.split('\n').some((l) => l.trim().startsWith('|') && l.includes('前置段落。'));
const 判据_原正文句是否还单独成行 = (doc) => doc.split('\n').some((l) => l.trim() === '前置段落。');

const 红 = fromLog(path.join(HERE, '_table-daily-paste.log'), 'P5b 表行内粘 TSV');
const 绿 = fromResult(path.join(OUT, 'paste', 'result.json'), 'P5b 表行内粘 TSV');
if (!红 || !绿) { console.error('✗ 取不到两态留档：红=' + !!红 + ' 绿=' + !!绿); process.exit(1); }

const 红_doc = unnum(红.文档行).join('\n');
const 绿_doc = unnum(绿.文档行).join('\n');
const 夹具 = ['# 表格日常', '', '前置段落。', '', '| 甲 | 乙 | 丙 |', '| --- | --- | --- |', '| a1 | b1 | c1 |', '| a2 | b2 | c2 |', '', '末尾段落。', ''];
/** 渲染表在读数里的位置：两版探针都放在 前/后 里（P() 拼装），取 后.渲染表 为准 */
const 表后 = (r) => (r.后 && r.后.渲染表) || r.渲染表 || null;
const 表前 = (r) => (r.前 && r.前.渲染表) || null;
if (!表后(红) || !表后(绿) || !表前(红) || !表前(绿)) {
  console.error('✗ 渲染表读数位置对不上：红后=' + !!表后(红) + ' 绿后=' + !!表后(绿) + ' 红前=' + !!表前(红) + ' 绿前=' + !!表前(绿));
  process.exit(1);
}

const rows = [
  ['红·修复前 81b39273', 红_doc, 表后(红), 表前(红), 红.每行管道数],
  ['绿·当前产物 db761363', 绿_doc, 表后(绿), 表前(绿), 绿.每行管道数],
].map(([tag, doc, 渲染表, 渲染表前, 记录管道数]) => ({
  态: tag,
  文档行数: doc.split('\n').length,
  每行管道数_记录: JSON.stringify(记录管道数),
  每行管道数_重算: JSON.stringify(pipes(doc.split('\n'))),
  判据_每行管道数不变: 判据_每行管道数不变(doc.split('\n'), 夹具),
  判据_渲染表行数不变: 判据_渲染表行数不变(渲染表, 渲染表前),
  判据_原表头行是否被粘走: 判据_原表头行是否被粘走(doc),
  判据_原正文句是否还单独成行: 判据_原正文句是否还单独成行(doc),
  判据_正文句没被并进表格行: 判据_正文句没被并进表格行(doc),
  第7行: doc.split('\n')[6] || '',
}));
console.table(rows);

const 红态命中 = rows[0]['判据_每行管道数不变'] === false && rows[0]['判据_原表头行是否被粘走'] === true
  && rows[0]['判据_渲染表行数不变'] === false;
const 绿态通过 = rows[1]['判据_每行管道数不变'] === true && rows[1]['判据_原表头行是否被粘走'] === false
  && rows[1]['判据_渲染表行数不变'] === true;
console.log('红态（修复前文档）是否被判为"破损" =', 红态命中);
console.log('绿态（当前文档）是否被判为"完好"   =', 绿态通过);
console.log(红态命中 && 绿态通过 ? '✔ 判据有鉴别力：同一批判据在两态上分别给出 破损 / 完好' : '✗ 判据没有鉴别力（两态同色）⇒ 本族的"通过"不可信');

/* ── 第二块：W1/P4「正文行剩余文字被并进新表最后一行」那一条判据的鉴别力 ──
 *  红态 P4 只留了「新增行」切片（没留全文）⇒ 用"夹具 + 该切片"按**写明规则**重建，并断言重建行数
 *  等于当时记录的 `文档行数`（13）——重建不成立就不出结论。
 *  绿态直接用本次 W1 的整篇文档（同一场景：光标在第 3 行行首粘 TSV）。 */
const 红P4 = fromLog(path.join(HERE, '_table-daily-paste.log'), 'P4 表外粘 TSV');
const 绿W1 = fromResult(path.join(OUT, 'pastevisual', 'result.json'), 'W1 正文行里粘 TSV');
if (!红P4 || !绿W1) { console.error('✗ 第二块取不到留档：红P4=' + !!红P4 + ' 绿W1=' + !!绿W1); process.exit(1); }
const 红P4_doc = [...夹具.slice(0, 2), ...红P4.新增行, ...夹具.slice(7)].join('\n');
const 重建行数 = 红P4_doc.split('\n').length;
if (重建行数 !== 红P4.后.文档行数) {
  console.error('✗ 红态 P4 文档重建不成立：重建 ' + 重建行数 + ' 行 ≠ 记录 ' + 红P4.后.文档行数 + ' 行 ⇒ 不出结论');
  process.exit(1);
}
const table2 = [
  ['红·修复前 81b39273（P4 重建）', 红P4_doc],
  ['绿·当前产物 db761363（W1 原文）', 绿W1.文档行.join('\n')],
].map(([态, doc]) => ({
  态,
  文档行数: doc.split('\n').length,
  判据_原正文句是否还单独成行: 判据_原正文句是否还单独成行(doc),
  判据_正文句没被并进表格行: 判据_正文句没被并进表格行(doc),
  '含前置段落的那一行': doc.split('\n').find((l) => l.includes('前置段落。')) || '(不存在)',
}));
console.table(table2);
const 红P4命中 = table2[0]['判据_原正文句是否还单独成行'] === false && table2[0]['判据_正文句没被并进表格行'] === false;
const 绿W1通过 = table2[1]['判据_原正文句是否还单独成行'] === true && table2[1]['判据_正文句没被并进表格行'] === true;
console.log('红态（修复前 P4 文档）是否被判为"正文句被吞" =', 红P4命中);
console.log('绿态（当前 W1 文档）是否被判为"正文句完好"  =', 绿W1通过);
console.log(红P4命中 && 绿W1通过 ? '✔ W1/P4 判据同样有鉴别力' : '✗ W1/P4 判据没有鉴别力');

process.exit(红态命中 && 绿态通过 && 红P4命中 && 绿W1通过 ? 0 : 2);
