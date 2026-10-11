/** 加粗不渲染的最小复现：一行一段的变体，逐个读"有没有 <strong>"。
 *  用法：node scripts/acceptance/probe-bold-variants.cjs [--app=dev|installed|<exe>]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-bold-variants');
const IF = `document.getElementById('editor').contentWindow`;
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');

const 变体 = [
  'Y1 甲=乙。丙=**丁**',
  'Y2 甲=乙。丙=*丁*',
  'Y3 甲=乙。丙=__丁__',
  'Y4 甲乙。丙=**丁**',
  'Y5 甲=**乙**',
  'Y6 x==y 与 a==b==c',
  'Y7 ====',
  'Y8 价格 x = 5 元，y = 6 元',
  'Y9 错时接送问题：  接者省时距离：慢者出发地到相遇地距离的2倍，得到单倍该距离时间=省时的一半。提前时间与最终实际节省时间差是因为在该单倍距离的速度差导致的浪费，则时间差+接者单倍距离时间=**慢者独自行驶时间**',
];

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'variants.md');
  fs.writeFileSync(doc, '# 加粗变体\n\n' + 变体.join('\n\n') + '\n');
  const exe = APP === 'dev' ? path.join(project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe' : APP;
  const session = await harness.launch({
    exe, appArgs: APP === 'dev' ? [path.join(project, 'app/main/main.js')] : [],
    label: 'probe-bold-variants', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset p')); })()`,
      {timeout: 220000, interval: 120});
    await sleep(2500);
    const 结果 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const 面 = d.querySelector('.vditor-ir .vditor-reset');
      const ps = [...面.querySelectorAll('p')].filter(p => /^[VWXY]\\d+/.test(String(p.textContent).trim()));
      return ps.map(p => { const t = String(p.textContent).trim();
        return {文本: t.slice(0, 46), 有strong: !!p.querySelector('strong'),
          strong文本: p.querySelector('strong') ? String(p.querySelector('strong').textContent) : null,
          星号在文本里: /\\*\\*/.test(t), 标记类: [...p.querySelectorAll("mark,u,em,i,strong,b")].map(n=>n.nodeName+":"+String(n.textContent).slice(0,8)), 围栏数: p.querySelectorAll('.vditor-ir__marker').length,
          HTML: p.innerHTML.slice(0, 150)}; }); })()`);
    for (const r of 结果) {
      console.log('\n' + r.文本);
      console.log('   有strong=' + r.有strong + ' 星号可见=' + r.星号在文本里 + ' 标记类=' + JSON.stringify(r.标记类));
      console.log('   HTML: ' + r.HTML);
    }
    // 存盘回读：看看被写回磁盘时变成什么样
    await session.chord('s', 'KeyS', 83);
    await sleep(1200);
    const 盘 = fs.readFileSync(doc, 'utf8');
    console.log('\n磁盘（含变体行）：');
    for (const line of 盘.split(/\r?\n/)) if (/^V\d+/.test(line)) console.log('  ' + line.slice(0, 80));
    console.log('console 错误：' + JSON.stringify(session.errors.slice(0, 3)));
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
