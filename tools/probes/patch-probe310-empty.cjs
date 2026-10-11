/** 补丁 11：7.1 的 okEmpty 写死了"空行是第 3 条内容行"（`b1[2].n==='3'`），
 *  但修好的清单夹具块1是 [1, 空, 2] 三条内容行 ⇒ 空行号应为 2。改成"存在空内容行且它的号 == 它在块内的序号"。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = path.join(__dirname, 'probe-310.cjs');
let t = fs.readFileSync(p, 'utf8');
const old = "    const okEmpty = b1[2] && b1[2].n === '3' && !(b1[2].t || '').trim();";
const neu = `    /* 空行必须占号，且号 == 它在内容行里的序号（块内 1 起） */
    const okEmpty = content1.some((x, i) => !String(x.t || '').trim() && String(x.n) === String(i + 1));`;
if (t.includes(neu)) { console.log('· 已打过补丁'); process.exit(0); }
if (!t.includes(old)) { console.log('✗ 没找到 okEmpty 行'); process.exit(1); }
t = t.replace(old, neu);
fs.writeFileSync(p, t, 'utf8');
console.log('✓ okEmpty 改为按序号判定');
