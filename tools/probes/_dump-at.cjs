/** 只读取证：按 line:col 从构建产物里切一段代码（stack 里的列号＝该行字符偏移）
 *  用法：node _dump-at.cjs <file> <line> <col> [radius]
 */
'use strict';
const fs = require('node:fs');
const [file, lineNo, col, radius = '900'] = process.argv.slice(2);
const lines = fs.readFileSync(file, 'utf8').split('\n');
const L = lines[Number(lineNo) - 1];
if (L == null) { console.log('NO SUCH LINE ' + lineNo + ' (file has ' + lines.length + ')'); process.exit(1); }
const c = Number(col), r = Number(radius);
console.log(`file=${file} line=${lineNo} len=${L.length} col=${c}`);
console.log('----8<---- [' + Math.max(0, c - r) + '..' + Math.min(L.length, c + r) + ']');
console.log(L.slice(Math.max(0, c - r), Math.min(L.length, c + r)));
console.log('---->8----');
console.log('★ 命中列前后 80 字符：');
console.log(L.slice(Math.max(0, c - 80), c + 80));
