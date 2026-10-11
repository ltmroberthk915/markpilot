/** 运行中的应用到底发的是哪一版 typora-patches.js？空白点击的 mousedown 监听装上了没有？
 *  用法：node scripts/acceptance/probe-repro-served.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-served');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'real-copy.md');
  fs.copyFileSync(SOURCE, doc);
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-served', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2200);
    const 服务 = await new Promise(resolve => {
      http.get({host: '127.0.0.1', port: session.port, path: '/render/js/typora-patches.js'}, r => {
        let b = ''; r.on('data', c => { b += c; }); r.on('end', () => resolve(b));
      }).on('error', error => resolve('ERR ' + error.message));
    });
    console.log('服务端 typora-patches.js 长度=' + 服务.length
      + '，出现 patchMathBlockBlankClick ' + (服务.match(/patchMathBlockBlankClick/g) || []).length + ' 次'
      + '，含 __typoraBlankTrace=' + /__typoraBlankTrace/.test(服务));
    console.log('磁盘 app/renderer/js/typora-patches.js 长度=' + fs.readFileSync(path.join(project, 'app/renderer/js/typora-patches.js'), 'utf8').length);
    console.log('合成光标代理元素存在=' + await session.js(`(() => { const w = ${IF}; return !!w.document.querySelector('[data-typora-caret-proxy]'); })()`));
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y)}; })()`);
    const p = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const para = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(p => (p.textContent || '').includes('修量不少'));
      para.scrollIntoView({block: 'center', behavior: 'instant'});
      const r = para.getBoundingClientRect(); return {x: Math.round(r.left + 30), y: Math.round(r.top + 12)}; })()`);
    await session.js(`(() => { const w = ${IF}; w.__typoraBlankTrace = '探针先写的哨兵'; return 1; })()`);
    await session.click(frame.x + p.x, frame.y + p.y);
    await sleep(300);
    console.log('正文点击后 __typoraBlankTrace=' + JSON.stringify(await session.js(`(() => { const w = ${IF}; return w.__typoraBlankTrace; })()`)));
    console.log('console 错误：' + JSON.stringify(session.errors.slice(0, 5)));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('失败：', error); process.exit(1); });
