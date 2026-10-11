/** 只读取证：从构建产物里切出"列表语义"那段代码的字符窗口（不写产品文件）
 *  用法：node _dump-excerpt.cjs <file> <needle> <before> <after>
 */
'use strict';
const fs = require('node:fs');
const [file, needle, before = '1200', after = '1600'] = process.argv.slice(2);
const s = fs.readFileSync(file, 'utf8');
let i = s.indexOf(needle);
if (i < 0) { console.log('NOT FOUND: ' + needle); process.exit(1); }
console.log('file=' + file + ' len=' + s.length + ' idx=' + i);
const b = Math.max(0, i - Number(before));
console.log('----8<----');
console.log(s.slice(b, i + Number(after)));
console.log('---->8----');
