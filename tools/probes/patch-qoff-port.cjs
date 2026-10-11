/** 小补丁 2：probe-qoff 用**每次不同**的 CDP 端口。
 *  实测：固定 9601 被上一次失败留下的僵尸实例占着 ⇒ connectOverCDP 连到的是它（无窗口）⇒ ctx.pages() 恒空。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = path.join(__dirname, 'probe-qoff.cjs');
let t = fs.readFileSync(p, 'utf8');
const oldLine = "const PORT = 9601;";
const newLine = "/* CDP 端口每次不同：固定端口若被上一次失败的僵尸实例占着，connectOverCDP 会连到它（无窗口）⇒ pages() 恒空 */\nconst PORT = 9600 + (process.pid % 400);";
if (t.includes(newLine)) console.log('· 已打过端口补丁');
else if (t.includes(oldLine)) { t = t.replace(oldLine, newLine); fs.writeFileSync(p, t, 'utf8'); console.log('✓ 端口改为每次不同'); }
else console.log('✗ 没找到 PORT 定义行');
