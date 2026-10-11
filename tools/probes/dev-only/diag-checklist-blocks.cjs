/** 只读量化 2：按**条目块**比较「重生成」与「demo 现件」，列出结构被写坏的条目。
 *  （§8 汇总段依赖 report.json，天然会不同，不参与比较。）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const DIR = __dirname;
const A = fs.readFileSync(path.join(DIR, 'accept', 'out', '验收清单-重生成.md'), 'utf8').split('\n');
const B = fs.readFileSync(path.join(DIR, '..', 'demo', '验收清单.md'), 'utf8').split('\n');

function blocks(L) {
  const out = new Map();
  const re = /^### ([0-9A-Z]+\.[0-9]+) /;
  let cur = null, buf = [];
  const flush = () => { if (cur) out.set(cur, buf); cur = null; buf = []; };
  for (const line of L) {
    const m = line.match(re);
    if (m) { flush(); cur = m[1]; buf = [line]; }
    else if (cur) { if (/^## /.test(line)) flush(); else buf.push(line); }
  }
  flush();
  return out;
}
const a = blocks(A), b = blocks(B);
const ids = [...new Set([...a.keys(), ...b.keys()])];
let damaged = [];
for (const id of ids) {
  const x = (a.get(id) || []).join('\n');
  const y = (b.get(id) || []).join('\n');
  if (x === y) continue;
  /* 结构指标：行首围栏数（普通/引用）、反引号总数、行数 */
  const stat = (s) => {
    const L = s.split('\n');
    let p = 0, q = 0, loners = 0;
    for (const line of L) {
      if (/^\s*(`{3,}|~{3,})/.test(line)) { if (/^\s*>/.test(line)) q++; else p++; }
      else if (/^\s*`\s*$/.test(line)) loners++;
    }
    return { lines: L.length, plainFences: p, quotedFences: q, lonerBackticks: loners, ticks: (s.match(/`/g) || []).length };
  };
  const sa = stat(x), sb = stat(y);
  const structural = sa.plainFences % 2 !== 0 || sb.plainFences % 2 !== 0 || sa.quotedFences !== sb.quotedFences || sb.lonerBackticks > 0 || Math.abs(sa.lines - sb.lines) > 2;
  damaged.push({ id, structural, regen: sa, demo: sb, demoDiffBytes: y.length - x.length });
}
console.log(`比较 ${ids.length} 个条目块；内容不同的 ${damaged.length} 个：\n`);
console.log('条目  结构可疑  重生成(行/普通围栏/引用围栏/孤立`)  demo(行/普通围栏/引用围栏/孤立`)  长度差');
for (const d of damaged.sort((p, q) => (q.structural - p.structural) || p.id.localeCompare(q.id))) {
  console.log(`${d.id.padEnd(6)} ${d.structural ? '  ⚠ 是   ' : '  否   '} ${String(d.regen.lines).padStart(4)}/${d.regen.plainFences}/${d.regen.quotedFences}/${d.regen.lonerBackticks}`.padEnd(48)
    + `${String(d.demo.lines).padStart(4)}/${d.demo.plainFences}/${d.demo.quotedFences}/${d.demo.lonerBackticks}`.padEnd(22) + `${d.demoDiffBytes > 0 ? '+' : ''}${d.demoDiffBytes}`);
}
const bad = damaged.filter((d) => d.structural);
console.log(`\n⇒ 结构可疑条目（需要修）：${bad.map((d) => d.id).join(', ') || '(无)'}`);
