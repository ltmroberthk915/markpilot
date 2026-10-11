/** 生成 §7.1 的「修复片段」+ 可选的打补丁脚本（默认只导出片段，**不动 demo 原件**）。
 *  用法：
 *    node fix-checklist-7.1.cjs                 → 只导出片段到 accept\out\7.1-夹具-修复片段.md
 *    node fix-checklist-7.1.cjs --apply         → 备份后把 demo 件的 §7.1 夹具块替换成正确内容（需授权）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const DIR = __dirname;
const DEMO = path.join(DIR, '..', 'demo', '验收清单.md');
const REGEN = path.join(DIR, 'accept', 'out', '验收清单-重生成.md');
const FRAG = path.join(DIR, 'accept', 'out', '7.1-夹具-修复片段.md');
const APPLY = process.argv.includes('--apply');

const blockOf = (L, id) => {
  const re = new RegExp('^### ' + id.replace('.', '\\.') + ' ');
  const s = L.findIndex((x) => re.test(x));
  if (s < 0) return null;
  let e = L.length;
  for (let i = s + 1; i < L.length; i++) if (/^### /.test(L[i]) || /^## /.test(L[i])) { e = i; break; }
  return { s, e, lines: L.slice(s, e) };
};
const demo = fs.readFileSync(DEMO, 'utf8').split('\n');
const regen = fs.readFileSync(REGEN, 'utf8').split('\n');
const bd = blockOf(demo, '7.1'), br = blockOf(regen, '7.1');
if (!bd || !br) { console.error('✗ 找不到 7.1 块'); process.exit(2); }
/* 只替换"夹具"那一段：从 `**夹具**（下面就是原文）：` 到 `**怎么试**` 之前 */
const segOf = (lines) => {
  const s = lines.findIndex((x) => x.startsWith('**夹具**'));
  const e = lines.findIndex((x, i) => i > s && x.startsWith('**怎么试**'));
  return { s, e };
};
const sd = segOf(bd.lines), sr = segOf(br.lines);
if (sd.s < 0 || sd.e < 0 || sr.s < 0 || sr.e < 0) { console.error('✗ 找不到夹具段'); process.exit(2); }
const correct = br.lines.slice(sr.s, sr.e);
fs.mkdirSync(path.dirname(FRAG), { recursive: true });
fs.writeFileSync(FRAG, correct.join('\n') + '\n', 'utf8');
const absFrom = bd.s + sd.s + 1, absTo = bd.s + sd.e;   // 1-based、含两端
console.log(`· demo 件的夹具段 = 第 ${absFrom}–${absTo} 行（共 ${sd.e - sd.s} 行）`);
console.log(`· 正确内容 = 第 ${br.s + sr.s + 1}–${br.s + sr.e} 行（共 ${correct.length} 行）`);
console.log(`· 已导出修复片段：${FRAG}（${fs.statSync(FRAG).size} B）`);
if (!APPLY) { console.log('· 未加 --apply ⇒ **没有改动 demo 原件**。要落地请先取得授权再跑 --apply。'); process.exit(0); }
const bak = DEMO.replace(/\.md$/, '.bak-' + Date.now() + '.md');
fs.copyFileSync(DEMO, bak);
const out = [...demo.slice(0, absFrom - 1), ...correct, ...demo.slice(absTo)];
fs.writeFileSync(DEMO, out.join('\n'), 'utf8');
console.log(`· 已备份 ${bak}`);
console.log(`· 已替换：文件现在 ${out.length} 行 / ${fs.statSync(DEMO).size} B`);
