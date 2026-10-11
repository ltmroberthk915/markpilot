/** 找让 Lute 不再把 `=…=` 当一对的开关：试 SetMark / SetTextMark 等，四种组合都跑一遍。 */
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const {TextDecoder, TextEncoder} = require('node:util');
const 文件 = 'E:/MarkPilot/Typora-Editor/extension-src/render/cdn/vditor/dist/js/lute/lute.min.js';
const 源码 = fs.readFileSync(文件, 'utf8');
const 样例 = [
  '甲=乙。丙=**丁**',
  '甲=乙。丙=*丁*',
  '甲=乙。丙=__丁__',
  '甲=**乙**',
  '甲==乙。丙==丁==戊',
  '=abc=',
  '甲=乙。`x=**y**`',
];

const 造 = (设置) => {
  const 沙箱 = {console, TextDecoder, TextEncoder, setTimeout, clearTimeout};
  沙箱.window = 沙箱; 沙箱.globalThis = 沙箱;
  vm.runInNewContext(源码, 沙箱, {timeout: 30000});
  const lute = 沙箱.Lute.New();
  for (const [名, 值] of Object.entries(设置)) if (typeof lute[名] === 'function') lute[名](值);
  return lute;
};

for (const 设置 of [
  {名: '默认', 值: {}},
  {名: 'Mark(false)', 值: {SetMark: false}},
  {名: 'TextMark(false)', 值: {SetTextMark: false}},
  {名: 'Mark(false)+TextMark(false)', 值: {SetMark: false, SetTextMark: false}},
  {名: 'GFMStrikethrough(false)', 值: {SetGFMStrikethrough: false}},
]) {
  const lute = 造(设置.值);
  console.log('\n=== ' + 设置.名);
  for (const 文 of 样例) {
    let 出 = '';
    try { 出 = String(lute.Md2HTML(文)).replace(/\n/g, ' '); } catch (e) { 出 = 'ERR:' + e.message; }
    const 有粗 = /<strong>/.test(出);
    console.log('  ' + (文.length > 22 ? 文.slice(0, 22) + '…' : 文).padEnd(24) + ' → ' + (有粗 ? '✔ ' : '✗ ') + 出.slice(0, 96));
  }
}
