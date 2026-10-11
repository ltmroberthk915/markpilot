/** 打开→立刻保存→逐字节对比（不碰任何东西）。默认素材是用户桌面那份真实文档的副本。
 *  用法：node scripts/acceptance/probe-open-save-fidelity.cjs [--app=dev|installed|<exe>] [--file=<md>]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-fidelity');
const IF = `document.getElementById('editor').contentWindow`;
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');
const 素材 = ARG('file', 'C:/Users/ltmroberthk/Desktop/新建 Markdown 文档.md');
const 摘要 = buffer => crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'copy.md');
  fs.copyFileSync(素材, doc);
  const 前 = fs.readFileSync(doc);
  const exe = APP === 'dev' ? path.join(project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe' : APP;
  const session = await harness.launch({
    exe, appArgs: APP === 'dev' ? [path.join(project, 'app/main/main.js')] : [],
    label: 'probe-fidelity', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 220000, interval: 120});
    await sleep(4000);
    await session.chord('s', 'KeyS', 83);
    await sleep(2000);
    const 后 = fs.readFileSync(doc);
    console.log('素材：' + 素材);
    console.log('打开前 sha=' + 摘要(前) + ' 字节=' + 前.length);
    console.log('保存后 sha=' + 摘要(后) + ' 字节=' + 后.length);
    console.log('逐字节相同：' + 前.equals(后));
    if (!前.equals(后)) {
      const a = 前.toString('utf8').split(/\r?\n/), b = 后.toString('utf8').split(/\r?\n/);
      let 处 = 0;
      for (let i = 0; i < Math.max(a.length, b.length) && 处 < 6; i++) {
        if (a[i] !== b[i]) { 处++; console.log('  第 ' + (i + 1) + ' 行不同：\n    前: ' + String(a[i]).slice(0, 120) + '\n    后: ' + String(b[i]).slice(0, 120)); }
      }
    }
    console.log('console 错误：' + JSON.stringify(session.errors.slice(0, 2)));
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
