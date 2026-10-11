/** 小补丁 4：qoff 夹具改成**引用标记在行首**（标签另起一行）——
 *  实测：把「单层引用（qoff=2）：」写在 `>` 前面 ⇒ 那行根本不是引用行，qoff 症状测不出来（假绿）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = path.join(__dirname, 'probe-qoff.cjs');
let t = fs.readFileSync(p, 'utf8');
const oldBlock = [
  "  `单层引用（qoff=2）：> 引用区 ![单层图](${uri})结尾甲`,",
  "  '',",
  "  `嵌套引用（qoff=4）：> > 嵌套 ![嵌套图](${uri})结尾乙乙`,",
  "  '',",
  "  `非引用对照（qoff=0）：![对照图](${uri})结尾丙丙丙`,",
].join('\n');
const newBlock = [
  "  '单层引用（qoff=2），图后紧跟「结尾甲」：',",
  "  '',",
  "  `> 引用区 ![单层图](${uri})结尾甲`,",
  "  '',",
  "  '嵌套引用（qoff=4），图后紧跟「结尾乙乙」：',",
  "  '',",
  "  `> > 嵌套 ![嵌套图](${uri})结尾乙乙`,",
  "  '',",
  "  '非引用对照（qoff=0），图后紧跟「结尾丙丙丙」：',",
  "  '',",
  "  `![对照图](${uri})结尾丙丙丙`,",
].join('\n');
if (t.includes(newBlock)) console.log('· 夹具已修过');
else if (t.includes(oldBlock)) { t = t.replace(oldBlock, newBlock); fs.writeFileSync(p, t, 'utf8'); console.log('✓ 夹具已改为「引用标记在行首」'); }
else console.log('✗ 没找到旧夹具块');
