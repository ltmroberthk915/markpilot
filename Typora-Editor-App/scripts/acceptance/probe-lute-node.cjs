/** 在 Node 里直接跑打包进来的 Lute（不走 GUI）：定位"行里出现两个 `=` 之后强调就不再解析"的规则。
 *  用法：node scripts/acceptance/probe-lute-node.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const 文件 = 'E:/MarkPilot/Typora-Editor/extension-src/render/cdn/vditor/dist/js/lute/lute.min.js';
const 输入们 = process.argv.slice(2).filter(a => !a.startsWith('--'));
const 默认 = [
  '甲=**乙**',
  '甲=乙。丙=**丁**',
  '甲乙。丙=**丁**',
  '甲=乙。丙=*丁*',
  '甲=乙。丙=__丁__',
  '=abc=',
  '甲==乙。丙=丁==戊',
  '甲**乙**丙=丁=戊',
  '甲=x=乙。丙=**丁**',
  '甲=乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥一二三四五六七八九十。丙=**丁**',
];

const {TextDecoder, TextEncoder} = require('node:util');
const 沙箱 = {console, TextDecoder, TextEncoder, setTimeout, clearTimeout, window: {}, document: undefined, self: undefined, globalThis: undefined};
沙箱.globalThis = 沙箱;
沙箱.window = 沙箱;
try {
  vm.runInNewContext(fs.readFileSync(文件, 'utf8'), 沙箱, {filename: 'lute.min.js', timeout: 30000});
} catch (error) {
  console.error('加载 Lute 失败：' + error.message);
  process.exit(1);
}
const Lute = 沙箱.Lute || 沙箱.window.Lute;
if (!Lute || typeof Lute.New !== 'function') {
  console.error('拿不到 Lute.New；导出键：' + JSON.stringify(Object.keys(沙箱).slice(0, 20)));
  process.exit(1);
}
const lute = Lute.New();
console.log('Lute 版本：' + (lute.Version ? lute.Version() : (Lute.version || '?')));
for (const 文 of (输入们.length ? 输入们 : 默认)) {
  let html = '';
  try { html = String(lute.Md2HTML(文)); } catch (error) { html = 'ERR:' + error.message; }
  console.log('\n输入：' + 文);
  console.log('  输出：' + html.replace(/\n/g, ' ⏎ '));
}
