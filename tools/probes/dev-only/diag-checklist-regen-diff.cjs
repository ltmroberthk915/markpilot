/** 只读量化：把清单**重新生成到我的地盘**（不改 demo 原件），与当前 demo 件逐行 diff，
 *  列出被写坏的行区间。用法：node diag-checklist-regen-diff.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const DIR = __dirname;
const DEMO = path.join(DIR, '..', 'demo', '验收清单.md');
const MINE = path.join(DIR, 'accept', 'out', '验收清单-重生成.md');

/* 把生成器复制成"输出到我的地盘"的变体再跑，绝不碰 demo 原件 */
const src = fs.readFileSync(path.join(DIR, 'gen-checklist.cjs'), 'utf8');
const patched = src
  .replace("const OUT = path.join(DIR, '..', 'demo', '验收清单.md');", `const OUT = ${JSON.stringify(MINE)};`)
  .replace(/fs\.writeFileSync\(ITEMS_JSON[\s\S]*?;\n/, '');
const tmp = path.join(DIR, 'gen-checklist-scope.cjs');   // 放本目录，require('./items-*.cjs') 才找得到
fs.mkdirSync(path.dirname(tmp), { recursive: true });
fs.writeFileSync(tmp, patched, 'utf8');
require('node:child_process').execFileSync(process.execPath, [tmp], { cwd: DIR, stdio: 'inherit' });

const a = fs.readFileSync(MINE, 'utf8').split('\n');
const b = fs.readFileSync(DEMO, 'utf8').split('\n');
console.log(`\n重生成：${a.length} 行 / ${fs.statSync(MINE).size} B`);
console.log(`demo 现件：${b.length} 行 / ${fs.statSync(DEMO).size} B`);
/* 逐行对齐 diff（有插入/删除时用最长公共子序列粗对齐：这里先做"同长度逐行"与"滑动窗口"两种判断） */
if (a.length === b.length) {
  let bad = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) bad.push(i + 1);
  console.log(`\n行数相同 ⇒ 逐行比对，**不同行 ${bad.length} 行**：`);
  let run = [];
  const flush = () => { if (run.length) { console.log(`  · 行 ${run[0]}–${run[run.length - 1]}（${run.length} 行）`); run = []; } };
  for (let i = 0; i < bad.length; i++) { if (run.length && bad[i] === run[run.length - 1] + 1) run.push(bad[i]); else { flush(); run = [bad[i]]; } }
  flush();
  for (const n of bad.slice(0, 30)) {
    console.log(`\n--- 行 ${n} ---`);
    console.log('  重生成: ' + JSON.stringify((a[n - 1] || '').slice(0, 100)));
    console.log('  demo 现: ' + JSON.stringify((b[n - 1] || '').slice(0, 100)));
  }
} else {
  console.log(`\n行数不同（差 ${b.length - a.length} 行）⇒ 先按内容哈希找出"重生成里有、现件里没有"的段落`);
}
