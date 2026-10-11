/** 交接 F3：带标题的文档，空行分隔的多个段落**被并成一个块**（磁盘保真、坏的是 IR 分块）。
 *  这里做最小复现 + 二分：标题 × 段落形态，读顶层块数与每块的首行。
 *  用法：node scripts/acceptance/probe-repro-block-merge.cjs [--app=dev|installed|<exe>]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-block-merge');
const IF = `document.getElementById('editor').contentWindow`;
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');

const 变体 = {
  'A 无标题·两段': ['甲段一。', '', '乙段二。'],
  'B 有标题·两段': ['# 标题', '', '甲段一。', '', '乙段二。'],
  'C 有标题·两段·首段带等号强调': ['# 标题', '', '甲=乙。丙=**丁**', '', '乙段二。'],
  'D 有标题·两段·首段带双星': ['# 标题', '', '甲乙。丙=**丁**', '', '乙段二。'],
  'E 有标题·三段': ['# 标题', '', '甲段一。', '', '乙段二。', '', '丙段三。'],
  'F 有标题·两段·英文': ['# 标题', '', 'a=b. c=**d**', '', 'second paragraph.'],
  'G 有标题·两段·含公式': ['# 标题', '', '公式 $a+b$ 一段。', '', '第二段。'],
};

const 结构 = `(() => { const w = ${IF}; const d = w.document;
  const 面 = d.querySelector('.vditor-ir .vditor-reset');
  if (!面) return {没面: true};
  return {块数: 面.children.length,
    块: [...面.children].map(n => ({标签: n.nodeName, 类: String(n.className || '').slice(0, 40),
      首行: String(n.textContent).replace(/\\s+/g, ' ').slice(0, 40)}))}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const exe = APP === 'dev' ? path.join(project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe' : APP;
  for (const [名, 行] of Object.entries(变体)) {
    const doc = path.join(OUT, 名.replace(/[^\w\u4e00-\u9fa5]/g, '_') + '.md');
    fs.writeFileSync(doc, 行.join('\n') + '\n');
    const session = await harness.launch({
      exe, appArgs: APP === 'dev' ? [path.join(project, 'app/main/main.js')] : [],
      label: 'block-merge', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
    });
    try {
      await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
        {timeout: 220000, interval: 120});
      await sleep(2200);
      const S = await session.js(结构);
      console.log('\n【' + 名 + '】期望块数=' + 行.filter(l => l.trim() && !/^#/.test(l) && !/\*\*/.test(l) === false ? true : l.trim()).length);
      console.log('   实际块数=' + S.块数);
      for (const b of S.块) console.log('     ' + b.标签 + '.' + b.类 + ' | ' + b.首行);
    } finally { await session.close(); }
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
