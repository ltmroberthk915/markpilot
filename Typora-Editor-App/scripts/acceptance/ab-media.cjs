/** A/B 工具：把 2.1.15 的图片修复在**生成副本**（app/renderer）里临时关掉，
 *  用来证明场景 87 的断言真的能抓住这两个缺陷（源码 extension-src 不动，跑完 npm run sync 还原）。
 *  用法：node scripts/acceptance/ab-media.cjs off4|off5
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const target = path.join(__dirname, '..', '..', 'app/renderer/js/media-tools.js');
const mode = process.argv[2];
let text = fs.readFileSync(target, 'utf8');
const before = text;
if (mode === 'off5') {
  text = text.replace('if(view&&box&&box.height>1&&box.top<view.top)keepBelow=true;', 'keepBelow=false; /* A/B：关掉"下方文字不动" */');
} else if (mode === 'off4') {
  text = text.replace('pushHistoryIfChanged(api);preserveIR', 'e.undo.addToUndoStack(e);preserveIR')
    .replace('pushHistoryIfChanged(api);return api.getValue();', 'e.undo.addToUndoStack(e);return api.getValue();');
} else {
  console.error('用法：node scripts/acceptance/ab-media.cjs off4|off5');
  process.exit(1);
}
if (text === before) { console.error('补丁锚点没找到'); process.exit(1); }
fs.writeFileSync(target, text);
console.log('已把 ' + mode + ' 的修复关掉（只改生成副本）');
