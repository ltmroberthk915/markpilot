/** 数一份 markdown 里 `$$` / `$` 的配对情况，并打印目标行附近的块结构线索。 */
'use strict';
const fs = require('node:fs');
const file = process.argv[2] || 'C:/Users/ltmroberthk/Desktop/新建 Markdown 文档.md';
const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);
let 双 = 0, 单 = 0;
const 行 = [];
lines.forEach((line, i) => {
  let 双本 = 0, 单本 = 0;
  for (let k = 0; k < line.length; k++) {
    if (line[k] !== '$') continue;
    if (line[k + 1] === '$') { 双本++; k++; } else 单本++;
  }
  if (双本 || 单本) { 双 += 双本; 单 += 单本; 行.push({行号: i + 1, 双本, 单本, 文: line.slice(0, 76)}); }
});
for (const r of 行.slice(0, 30)) console.log(r.行号 + ': 双' + r.双本 + ' 单' + r.单本 + '  ' + r.文);
console.log('总计：$$ = ' + 双 + '（' + (双 % 2 ? '奇数 → 有未闭合块公式' : '偶数') + '），单个 $ = ' + 单 + '（' + (单 % 2 ? '奇数' : '偶数') + '）');
const 目标 = lines.findIndex(line => line.includes('慢者独自行驶时间'));
console.log('目标行号：' + (目标 + 1));
if (目标 > 0) for (let i = Math.max(0, 目标 - 4); i <= 目标; i++) console.log('  ' + (i + 1) + ' | ' + lines[i].slice(0, 90));
const 星 = lines[目标] ? [...lines[目标].matchAll(/\*+/g)].map(m => m.index + ':' + m[0]) : [];
console.log('目标行的星号：' + JSON.stringify(星));
if (lines[目标]) console.log('目标行片段码点：' + JSON.stringify([...lines[目标].slice(-24)].map(c => c.codePointAt(0).toString(16))));
