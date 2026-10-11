/** 结构自检：围栏配平、§7 内容抽查（不依赖 shell 转义）
 *  用法：node check-structure.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = fs.readFileSync(path.join(__dirname, '..', 'demo', '验收清单.md'), 'utf8').split('\n');

const isFence = (l) => /^[ \t]*(```|~~~)/.test(l);
const isQuoteFence = (l) => /^[ \t]*>+[ \t]*(```|~~~)/.test(l);
const fenceLines = [];
L.forEach((l, i) => { if (isFence(l) && !isQuoteFence(l)) fenceLines.push(i + 1); });
console.log('行首围栏行 =', fenceLines.length, fenceLines.length % 2 === 0 ? '（偶数 ✓ 不会串块）' : '（奇数 ✗ 会串块）');
console.log('  行号：' + fenceLines.join(','));
console.log('引用区围栏行 =', L.filter(isQuoteFence).length, '（引擎只认行首围栏 ⇒ 这些行不算，但 Markdown 解析器认引用里的代码块）');

const sec7 = L.findIndex((l) => l.startsWith('## §7'));
const sec8 = L.findIndex((l) => l.startsWith('## §8'));
console.log(`§7 起始行 ${sec7 + 1} / §8 起始行 ${sec8 + 1}  ⇒ §7 共 ${sec8 - sec7 - 1} 行`);
console.log('--- §7 前 34 行 ---');
for (let k = sec7; k < Math.min(sec7 + 34, sec8); k++) {
  let t = L[k];
  if (t.length > 150) t = t.slice(0, 150) + ' …';
  console.log(`${k + 1}: ${t}`);
}
const ids = L.filter((l) => /^### 7\.\d /.test(l)).map((l) => l.slice(4, 12).trim());
console.log('§7 条目：' + ids.join('、'));
