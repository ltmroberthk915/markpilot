/** 盯住"打开那份 305KB 真实素材后，app 会不会中途死掉，死在第几秒"。
 *
 *  场景 76 的现场证据（2026-09-17）：`until` 轮询报传输错误时，**存活页面目标 = []**——
 *  那一刻一个页面目标都没有了，而 launch 时明明有（否则 harness 接不上）；诊断日志里
 *  **没有** `render-process-gone`，所以不是渲染进程单独死，是**整个应用没了**。
 *
 *  我上一个探针只观察到"就绪 + 5 秒"（约 6 秒）就收工，看不到这个过程。本探针：
 *   · 一直观察到进程真的退出，或到上限（默认 240 秒）；
 *   · 每 5 秒打一次活体检查（进程是否还活着 / 还有几个页面目标 / 编辑器状态）；
 *   · 捕获子进程的 exit 事件（退出码、信号）与 stderr 尾部——硬崩时这是唯一的现场。
 *
 *  用法：node scripts/acceptance/probe-material-lifetime.cjs [观察秒数]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;

const MATERIAL = 'E:/MarkPilot/测试素材_每次使用需复制用后需删除试验副本/表格bug-富文本测试-重识概率论-副本.md';
const OUT = path.join(project, '.perf/repro-material-life');
const LIMIT = Number(process.argv[2] || 240) * 1000;
const SURFACE = '.vditor-ir .vditor-reset';
const PING = `(() => { const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const root = w && w.document && w.document.querySelector(${JSON.stringify(SURFACE)});
  return {imgs: root ? root.querySelectorAll('img').length : -1, blocks: root ? root.children.length : -1}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const copy = path.join(OUT, 'material.md');
  fs.copyFileSync(MATERIAL, copy);
  fs.chmodSync(copy, 0o666);
  console.log('素材 ' + fs.statSync(copy).size + ' 字节；观察上限 ' + (LIMIT / 1000) + ' 秒');

  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-material-life', outDir: OUT, args: [copy], timeout: 300000, inspect: true,
  });

  const started = Date.now();
  let exited = null;
  session.child.once('exit', (code, signal) => { exited = {at: Date.now() - started, code, signal}; });
  const log = [];
  try {
    while (Date.now() - started < LIMIT) {
      const at = Date.now() - started;
      const pages = await session.pages().catch(() => '读不到');
      if (exited) { console.log(`t=${(exited.at / 1000).toFixed(1)}s  ★★ 进程退出 code=${exited.code} signal=${exited.signal}`); break; }
      let probe;
      try {
        const value = await session.send('Runtime.evaluate', {expression: PING, returnByValue: true, awaitPromise: true, userGesture: true}, 4000);
        probe = (value && value.result && value.result.value) || null;
      } catch (error) { probe = {error: String((error && error.message) || error).split('\n')[0]}; }
      const line = `t=${(at / 1000).toFixed(1)}s  页面目标=${Array.isArray(pages) ? pages.length : pages}  ` + JSON.stringify(probe);
      log.push(line); console.log(line);
      if (!Array.isArray(pages) || pages.length === 0) { console.log('  ★ 页面目标归零，再等 3 秒确认进程是否也随之退出'); }
      await sleep(5000);
    }
    if (!exited) {
      // 再等一小会儿看是否只是慢
      await Promise.race([new Promise(resolve => session.child.once('exit', (code, signal) => { exited = {at: Date.now() - started, code, signal}; resolve(); })), sleep(5000)]);
    }
    console.log('\n结论：' + (exited ? `进程在 t=${(exited.at / 1000).toFixed(1)}s 退出（code=${exited.code} signal=${exited.signal}）` : `观察到 ${(LIMIT / 1000)} 秒进程仍在`));
    const stderr = fs.readFileSync(path.join(OUT, 'app-stderr.log'), 'utf8');
    console.log('--- stderr 尾部 ---\n' + stderr.slice(-1500));
    fs.writeFileSync(path.join(OUT, 'lifetime.json'), JSON.stringify({exited, log}, null, 2));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
