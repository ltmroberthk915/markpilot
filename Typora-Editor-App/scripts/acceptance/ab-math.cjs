/** A/B 工具：把 2.1.16 的"行末语义"在**生成副本**（app/renderer）里临时关掉，
 *  用来证明场景 85 的 A 组断言真的能抓住它（源码 extension-src 不动，跑完 npm run sync 还原）。
 *  用法：node scripts/acceptance/ab-math.cjs off-tail
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const target = path.join(__dirname, '..', '..', 'app/renderer/js/math-source-map.js');
const mode = process.argv[2];
let text = fs.readFileSync(target, 'utf8');
const before = text;
if (mode === 'off-tail') {
  text = text.replace('const at = (node, after) => ({node, after: after || node === tail, tail: node === tail});',
    'const at = (node, after) => ({node, after, tail: false}); /* A/B：关掉行末语义 */');
} else {
  console.error('用法：node scripts/acceptance/ab-math.cjs off-tail');
  process.exit(1);
}
if (text === before) { console.error('补丁锚点没找到'); process.exit(1); }
fs.writeFileSync(target, text);
console.log('已把 ' + mode + ' 关掉（只改生成副本）');
