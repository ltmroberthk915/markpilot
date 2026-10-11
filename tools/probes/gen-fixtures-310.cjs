/** 3.1.0 性能夹具生成器：fixtures\表-1000行.md（1000 行 × 3 列 + 表格外段落，给"滚动/打字不卡帧"用）
 *  用法：node gen-fixtures-310.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, 'fixtures');
fs.mkdirSync(DIR, { recursive: true });

const L = [];
L.push('# 1000 行大表（性能夹具）');
L.push('');
L.push('用途：验收「1000 行大表滚动/打字不卡帧」。做法：');
L.push('');
L.push('1. 按住右侧滚动条上下快速拖动，看画面是否跟手、有没有白块/跳帧；');
L.push('2. 在表格**上/下**的段落里连续快打 30 个字符，打字试法见正文；');
L.push('3. 点表格中间某一格，进去输入几个字，看输入跟不跟手。');
L.push('');
L.push('表格上面的段落（在这里快打 30 个字符）：');
L.push('');
L.push('上面这段用来打字。');
L.push('');
L.push('| 序号 | 数值 | 说明 |');
L.push('| --- | --- | --- |');
for (let i = 1; i <= 1000; i++) {
  const n = String(i).padStart(4, '0');
  L.push(`| 行${n} | 值-${n} | 第 ${i} 行的说明文字（用来撑宽度） |`);
}
L.push('');
L.push('表格下面的段落（在这里快打 30 个字符）：');
L.push('');
L.push('下面这段用来打字。');
L.push('');

const out = path.join(DIR, '表-1000行.md');
fs.writeFileSync(out, L.join('\n'), 'utf8');
console.log('写出 =', out, ' 行数 =', L.length, ' 字节 =', Buffer.byteLength(L.join('\n'), 'utf8'));
