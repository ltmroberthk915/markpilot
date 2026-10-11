/** 交接 F19：160KB 真素材上 `vditor.getValue()` 是否只回半截？顺带读"我们自己的 markdown"（增量 IR）
 *  与 DOM 文本长度，判断到底是**渲染层只留了一部分**还是**序列化被截断**。
 *  素材只用副本（受保护素材：复制→用→删）。
 *  用法：node scripts/acceptance/probe-getvalue-large.cjs [--app=dev|installed]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-getvalue');
const IF = `document.getElementById('editor').contentWindow`;
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');
const 素材 = 'E:/MarkPilot/测试素材_每次使用需复制用后需删除试验副本/富文本测试-重识概率论.md';

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'material-copy.md');
  fs.copyFileSync(素材, doc);
  const 磁盘长 = fs.statSync(doc).size;
  const exe = APP === 'dev' ? path.join(project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe' : APP;
  const session = await harness.launch({
    exe, appArgs: APP === 'dev' ? [path.join(project, 'app/main/main.js')] : [],
    label: 'probe-getvalue', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 220000, interval: 120});
    console.log('磁盘字节=' + 磁盘长 + '（字符数约 ' + fs.readFileSync(doc, 'utf8').length + '）');
    for (const 轮 of [1, 2, 3, 4]) {
      await sleep(3000);
      const 数 = await session.js(`(() => { const w = ${IF}; const d = w.document;
        const 面 = d.querySelector('.vditor-ir .vditor-reset');
        const 出 = {};
        try { 出.getValue = String(w.vditor.getValue()).length; } catch (e) { 出.getValue = 'ERR'; }
        try { 出.增量 = w.__typoraIncrementalIR && w.__typoraIncrementalIR.getMarkdown ? String(w.__typoraIncrementalIR.getMarkdown()).length : null; } catch (e) { 出.增量 = 'ERR'; }
        出.DOM文本 = 面 ? String(面.textContent).length : null;
        出.块数 = 面 ? 面.children.length : null;
        出.源码视图 = w.vditor.getCurrentMode ? w.vditor.getCurrentMode() : null;
        return 出; })()`);
      console.log('第 ' + 轮 + ' 轮（+3s）：' + JSON.stringify(数));
    }
    // 直接问：保存出去的字节是谁给的（Ctrl+S 后比对磁盘）
    const 前 = fs.readFileSync(doc, 'utf8');
    await session.chord('s', 'KeyS', 83);
    await sleep(2500);
    const 后 = fs.readFileSync(doc, 'utf8');
    console.log('保存后逐字节相同：' + (前 === 后) + '（前 ' + 前.length + ' / 后 ' + 后.length + '）');
    console.log('console 错误：' + JSON.stringify(session.errors.slice(0, 2)));
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
