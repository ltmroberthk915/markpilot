/** 量出"打开那份 305KB 真实素材时，页面还能不能响应"——场景 76 的红到底是不是卡死。
 *
 *  线索（均来自场景 76 的失败现场）：
 *   · `until` 轮询回来的传输错误是 `Runtime.evaluate 60 秒无响应：目标可能已关闭`；
 *   · 诊断日志里**没有** `render-process-gone` / `unresponsive` / `fatal`，stderr 也没有崩溃输出。
 *  进程没死，那就是**主线程被长时间占住**——`Runtime.evaluate` 派不进去。若成立，
 *  用户侧的表现就是"打开这个大文件，编辑器卡住不动"。
 *
 *  做法：用**短超时**（3 秒）的 CDP 求值轮询，把"能不能响应 / 图片进没进 DOM"按时间打出来。
 *  短超时是关键：默认 60 秒会把这台机器直接卡成一次超时，什么时间线都看不到。
 *
 *  用法：node scripts/acceptance/probe-material-open.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;

const MATERIAL = 'E:/MarkPilot/测试素材_每次使用需复制用后需删除试验副本/表格bug-富文本测试-重识概率论-副本.md';
const OUT = path.join(project, '.perf/repro-material-open');
const SURFACE = '.vditor-ir .vditor-reset';
/** 一次短超时的探活：返回 {ok, imgs, blocks, chars} 或 {timeout: true}。 */
const PING = `(() => { const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const root = w && w.document && w.document.querySelector(${JSON.stringify(SURFACE)});
  return {imgs: root ? root.querySelectorAll('img').length : -1,
    blocks: root ? root.children.length : -1,
    chars: root ? root.textContent.length : -1,
    title: document.title}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const copy = path.join(OUT, 'material.md');
  fs.copyFileSync(MATERIAL, copy);
  fs.chmodSync(copy, 0o666);   // copyFileSync 会连只读属性一起带过来
  console.log('素材：' + fs.statSync(copy).size + ' 字节');

  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-material-open', outDir: OUT, args: [copy], timeout: 300000, inspect: true,
  });
  const started = Date.now();
  try {
    const timeline = [];
    let firstOk = null, unresponsiveSince = null, maxUnresponsive = 0, lastState = null;
    for (let i = 0; Date.now() - started < 240000; i++) {
      const at = Date.now() - started;
      let entry;
      try {
        const value = await session.send('Runtime.evaluate', {expression: PING, returnByValue: true, awaitPromise: true, userGesture: true}, 3000);
        const state = value && value.result ? value.result.value : null;
        entry = {at, ok: true, ...(state || {})};
        lastState = state;
        if (!firstOk && state && state.imgs >= 2) firstOk = at;
        if (unresponsiveSince !== null) { maxUnresponsive = Math.max(maxUnresponsive, at - unresponsiveSince); unresponsiveSince = null; }
      } catch (error) {
        entry = {at, ok: false, error: String((error && error.message) || error).split('\n')[0]};
        if (unresponsiveSince === null) unresponsiveSince = at;
      }
      // 有变化就记，别把 240 行"没变"刷满屏
      const previous = timeline[timeline.length - 1];
      if (!previous || JSON.stringify({ok: previous.ok, imgs: previous.imgs, blocks: previous.blocks}) !== JSON.stringify({ok: entry.ok, imgs: entry.imgs, blocks: entry.blocks})) {
        timeline.push(entry);
        console.log(`t=${(at / 1000).toFixed(1)}s  ` + (entry.ok ? `响应正常 imgs=${entry.imgs} blocks=${entry.blocks} chars=${entry.chars}` : `★ 无响应（3 秒超时）：${entry.error}`));
      }
      if (firstOk && Date.now() - started > firstOk + 5000) break;   // 就绪之后再稳 5 秒收工
      await sleep(1000);
    }
    if (unresponsiveSince !== null) maxUnresponsive = Math.max(maxUnresponsive, Date.now() - started - unresponsiveSince);
    console.log('\n首次 2 张图片进 DOM：' + (firstOk === null ? '始终没有' : (firstOk / 1000).toFixed(1) + 's'));
    console.log('最长一次无响应：' + (maxUnresponsive / 1000).toFixed(1) + 's');
    console.log('最终状态：' + JSON.stringify(lastState));
    fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify({firstOk, maxUnresponsive, lastState, timeline}, null, 2));
    // 顺便看诊断日志有没有记下无响应
    const logFile = path.join(session.profile, 'logs', 'markpilot.log');
    console.log('诊断日志有无 unresponsive 记录：' +
      (fs.existsSync(logFile) ? (fs.readFileSync(logFile, 'utf8').match(/unresponsive/g) || []).length : 'no-log'));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
