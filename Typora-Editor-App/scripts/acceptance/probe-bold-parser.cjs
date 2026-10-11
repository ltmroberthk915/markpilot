/** 定位"两个 = 之后 **粗体** 不渲染"发生在哪一层：直接问 Lute（解析器），再看 IR 渲染结果。
 *  用法：node scripts/acceptance/probe-bold-parser.cjs [--app=dev|installed|<exe>]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-bold-parser');
const IF = `document.getElementById('editor').contentWindow`;
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');

const 变体 = [
  '甲=乙。丙=**丁**',
  '甲乙。丙=**丁**',
  '甲=乙。丙=丁',
  '甲=乙=丙',
  '=abc=',
  '甲=**乙**',
  '甲=乙。丙=*丁*',
  '甲=乙。丙=__丁__',
];

(async () => {
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'tiny.md');
  fs.writeFileSync(doc, ['# 解析器探针', '', '甲=乙。丙=**丁**', ''].join('\n'));
  const exe = APP === 'dev' ? path.join(project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe' : APP;
  const session = await harness.launch({
    exe, appArgs: APP === 'dev' ? [path.join(project, 'app/main/main.js')] : [],
    label: 'probe-bold-parser', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset') && w.vditor && w.vditor.lute); })()`, {timeout: 220000, interval: 150});
    await sleep(1500);
    let 出 = null;
    for (let i = 0; i < 10 && !出; i++) {
      出 = await session.js(`(() => { const w = ${IF}; const v = w.vditor;
      const 候选 = [v && v.lute, w.Lute, w.lute, w.__lute, (w.hostApi && w.hostApi.lute)].filter(Boolean);
      const lute = 候选[0];
      if (!lute) return {没有lute: true, vditor键: v ? Object.keys(v).slice(0, 24) : null, 全局含lute: Object.keys(w).filter(k => /lute/i.test(k))};
      const 输入 = ${JSON.stringify(变体)};
      const out = [];
      for (const 文 of 输入) {
        const row = {文};
        try { row.Md2HTML = String(lute.Md2HTML(文)).slice(0, 200); } catch (e) { row.Md2HTML = 'ERR:' + e.message; }
        try { row.IR = String(lute.Md2VditorIRDOM(文)).slice(0, 260); } catch (e) { row.IR = 'ERR:' + e.message; }
        out.push(row);
      }
      return {lute版本: lute.version || null, 有vditor: !!v, out}; })()`);
      if (!出) await sleep(600);
    }
    if (!出) throw new Error('拿不到 vditor.lute');
    console.log('Lute 版本：' + 出.lute版本);
    for (const r of 出.out) {
      console.log('\n输入：' + r.文);
      console.log('  Md2HTML : ' + r.Md2HTML);
      console.log('  IR DOM  : ' + r.IR);
    }
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 3)));
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
