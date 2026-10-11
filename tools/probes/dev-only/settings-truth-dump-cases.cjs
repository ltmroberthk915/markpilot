/** settings-truth 族 · 把结果 JSON 摊成人类可读的完整读数清单（一判据一行 + 原始读数）
 *  用法：node settings-truth-dump-cases.cjs [1|2]
 *  只读 JSON、只写 .mp-verify 下的文本。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const BASE = path.join(__dirname, 'settings-truth-out');
const J = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

for (const n of (process.argv[2] ? [process.argv[2]] : ['1', '2'])) {
  const src = path.join(BASE, `probe-${n}-result.json`);
  const r = JSON.parse(fs.readFileSync(src, 'utf8'));
  const lines = [];
  lines.push(`# settings-truth probe-${n} 完整读数（由 ${path.basename(src)} 生成，不重跑）`);
  lines.push(`产物 sha16=${r.sha16}  共享尺子指纹=${J(r.pins)}`);
  lines.push(`汇总=${J(r.summary)}  阶段抛错=${r.errors.length}`);
  if (r.errors.length) for (const e of r.errors) lines.push(`  ✗ 阶段抛错 ${e.phase} :: ${String(e.error).split('\n')[0]}`);
  lines.push('');
  for (const c of r.cases) {
    lines.push(`[${c.id}] ${c.ok ? '✓' : '✗'} ${c.name}`);
    lines.push(`      got  = ${J(c.got)}`);
    if (!c.ok) lines.push(`      want = ${c.want}`);
  }
  lines.push('');
  lines.push('════ 原始读数（raw）════');
  lines.push(JSON.stringify(r.raw, null, 1));
  const out = path.join(BASE, `probe-${n}-cases.txt`);
  fs.writeFileSync(out, lines.join('\n'), 'utf8');
  console.log(`probe-${n}: ${r.cases.length} 条判据（通过 ${r.summary.pass}，未通过 ${r.summary.fail}）→ ${out}`);
}
