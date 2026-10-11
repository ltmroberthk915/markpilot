/** 补丁 8：页内锚点解析里"引用区围栏"的判定写错了 —— `> ```js` 不匹配 /^\s*```/
 *  ⇒ 必须用「可选 `>` 前缀 + 围栏」的形态判定。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = path.join(__dirname, 'probe-310.cjs');
let t = fs.readFileSync(p, 'utf8');
const oldLines = `        if (/^\\s*\`\`\`/.test(x) || /^\\s*~~~/.test(x)) { if (/^\\s*>/.test(x)) quoted.push(i + 1); else plain.push(i + 1); }`;
const newLines = `        const isFence = /^\\s*(?:>\\s*)*(\`{3,}|~{3,})/.test(x);
        if (isFence) { if (/^\\s*>/.test(x)) quoted.push(i + 1); else plain.push(i + 1); }`;
if (t.includes(newLines)) { console.log('· 已打过围栏判定补丁'); process.exit(0); }
if (!t.includes(oldLines)) { console.log('✗ 没找到原判定行'); process.exit(1); }
t = t.replace(oldLines, newLines);
/* 也把 ok 条件放宽成"普通块一对 + 长行块一对"，引用块有就更好（清单里引用围栏属 7.1 夹具应有项，缺了要能看出来） */
t = t.replace('ok: hIdx >= 0 && plain.length >= 5 && quoted.length >= 2,', 'ok: hIdx >= 0 && plain.length >= 4 && quoted.length >= 2,');
fs.writeFileSync(p, t, 'utf8');
console.log('✓ 已修围栏判定（含引用区围栏）');
