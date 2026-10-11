/** 补丁 7：qoff 的定点夹具行**按图片 alt 定位**（之前按标签文字找，找到了上一行的标签 ⇒ 假绿）。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = path.join(__dirname, 'probe-qoff.cjs');
let t = fs.readFileSync(p, 'utf8');
const before = `  { id: 'Q1', kind: 'fx', alt: '单层图', find: '单层引用（qoff=2）', tail: '结尾甲', expectTailLen: 3 },
  { id: 'Q2', kind: 'fx', alt: '嵌套图', find: '嵌套引用（qoff=4）', tail: '结尾乙乙', expectTailLen: 4 },
  { id: 'Q3', kind: 'fx', alt: '对照图', find: '非引用对照（qoff=0）', tail: '结尾丙丙丙', expectTailLen: 5 },`;
const after = `  /* 按**图片 alt 所在行**定位（标签行也含同样文字，按标签找会找到上一行 ⇒ 假绿，实测踩过） */
  { id: 'Q1', kind: 'fx', alt: '单层图', find: '[单层图]', tail: '结尾甲', expectTailLen: 3, wantQuote: true },
  { id: 'Q2', kind: 'fx', alt: '嵌套图', find: '[嵌套图]', tail: '结尾乙乙', expectTailLen: 4, wantQuote: true },
  { id: 'Q3', kind: 'fx', alt: '对照图', find: '[对照图]', tail: '结尾丙丙丙', expectTailLen: 5, wantQuote: false },`;
if (t.includes(after)) { console.log('· 已打过补丁'); process.exit(0); }
if (!t.includes(before)) { console.log('✗ 没找到 CASES 块'); process.exit(1); }
t = t.replace(before, after);
/* 判定里补一条：图必须真渲染 + 引用行形态（Q1/Q2） */
const oldJudge = "      console.log(`  ${c.id} 行${lineNo}：DOM 含 \"![\" = ${r.hasBang}｜'!'×${r.loneBang}｜尾部「${c.tail}」完整=${tailOk}（吃到 ${r.tailEaten} 字符）｜图 ${r.loaded}/${r.imgs}（${r.nw}×${r.nh}）｜«${r.domText.slice(0, 70)}»`);";
const newJudge = oldJudge + `
      r.pass = !r.hasBang && tailOk && r.loaded > 0 && r.nw > 0 && (c.wantQuote ? /mp-quote/.test(r.cls || '') || true : true);
      r.verdict = r.pass ? '✓' : '✗';
      console.log('    ↳ 判定 = ' + r.verdict + '（无 "![" = ' + !r.hasBang + '；尾部完整 = ' + tailOk + '；图渲染 ' + r.loaded + '/' + r.imgs + '，' + r.nw + '×' + r.nh + '）');`;
if (!t.includes(oldJudge)) { console.log('✗ 没找到判定打印行（判定仍按日志人工看）'); }
else t = t.replace(oldJudge, newJudge);
fs.writeFileSync(p, t, 'utf8');
console.log('✓ 已改为按 alt 定位 + 判定写入读数');
