/** scanInlineMarks 内部拆解（纯 Node，不需要引擎/应用）
 *  目的：在真实夹具上确认那 54ms 花在哪个子步骤（读行 / codeSpans 正则 / 图片扫描 / 其它正则）。
 *  用法：node scan-internals.cjs "<doc.md>"
 */
'use strict';
const fs = require('node:fs');

const DOC = process.argv[2];
if (!DOC || !fs.existsSync(DOC)) { console.error('给文档路径'); process.exit(2); }
const raw = fs.readFileSync(DOC, 'utf8');
const lines = raw.split('\n');
let longest = '', longestNo = 0;
for (let i = 0; i < lines.length; i++) if (lines[i].length > longest.length) { longest = lines[i]; longestNo = i + 1; }

const ms = (fn, n = 20) => { const t = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); fn(); t.push(performance.now() - t0); } t.sort((a, b) => a - b); return Math.round(t[Math.floor(t.length / 2)] * 1000) / 1000; };

console.log('文档:', DOC);
console.log('行数', lines.length, '| 最长行 #' + longestNo, longest.length, '字符');
const t = longest;

const r = {};
r['① 取行文本（split 已有，模拟 sliceString）'] = ms(() => { void raw.slice(0, longest.length); });
r['② codeSpans 正则 /(`+)([\s\S]*?)\\1/g'] = ms(() => { const re = /(`+)([\s\S]*?)\1/g; let m, c = 0; while ((m = re.exec(t))) { c++; if (c > 1e6) break; } });
r['③ indexOf("<img")'] = ms(() => { void t.indexOf('<img'); });
r['④ indexOf("![")'] = ms(() => { void t.indexOf('!['); });
r['⑤ 转义循环逐字符'] = ms(() => { let c = 0; for (let k = 1; k < t.length; k++) if (t[k - 1] === '\\') c++; void c; });
r['⑥ tableLead 里的 match(/>/g)'] = ms(() => { void (t.match(/>/g) || []).length; });
r['⑦ 逐字符 includes 判定（"*~`[]()#_".includes）'] = ms(() => { let c = 0; const S = '*~`[]()#_'; for (let k = 1; k < t.length; k++) if (S.includes(t[k])) c++; void c; });
r['⑧ 图片扫描的主体（两轮 indexOf 循环，含 24 个 data URI）'] = ms(() => {
  let i = 0, hits = 0;
  for (;;) { const lt = t.indexOf('<', i); if (lt < 0) break; i = lt + 1; hits++; }
  i = 0;
  for (;;) { const b = t.indexOf('![', i); if (b < 0) break; const close = t.indexOf(']', b + 2); if (close < 0) break; i = b + 2; hits++; }
  void hits;
});
r['⑨ 整行长度 + 头尾切片（a1Fp 口径）'] = ms(() => { void (t.length + ':' + t.slice(0, 16) + ':' + t.slice(-16)); });
r['⑩ 字符串全等比较（缓存命中判定用）'] = ms(() => { void (t === longest); });

for (const [k, v] of Object.entries(r)) console.log('  ' + k.padEnd(52), String(v).padStart(8), 'ms');
const sum = Object.values(r).reduce((a, b) => a + b, 0);
console.log('  合计（粗算，含重复测量的重叠）'.padEnd(54), String(Math.round(sum * 100) / 100).padStart(8), 'ms');
