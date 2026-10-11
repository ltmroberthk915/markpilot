/** 大素材会话里"页面目标消失"到底是什么形态：逐秒记时间线。
 *
 *  场景 76 的第三个会话（受保护素材副本，305,561 字符 / 330 行）在 `until` 轮询里报
 *  `CDP 无响应（Runtime.evaluate，60000ms）：目标可能已关闭 ｜ 存活页面目标=[] ｜ 主进程窗口=null`。
 *  `[]` 有两种可能：调试 HTTP 端点真的没有页面目标，或者**读它的那次请求自己失败了**
 *  （`pages()` 把异常吞成了空数组）。这条探针把两者分开，并且逐秒记：
 *    · `/json/list` 的 HTTP 状态与目标清单（带错误正文）
 *    · 页面目标上 `Runtime.evaluate` 的往返耗时（短超时，不挂 60 秒）
 *    · 主进程的窗口清单与内存（inspect 拿）
 *    · 应用自己的诊断日志尾部（Step 2 落的那个文件）
 *
 *  用法：node scripts/acceptance/probe-target-timeline.cjs [--seconds=120] [--material=路径]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-target-timeline');
const IF = `document.getElementById('editor').contentWindow`;
/** 受保护素材：**只读原件、只用副本**（用完由调用方删除副本）。 */
const MATERIAL = 'E:/MarkPilot/测试素材_每次使用需复制用后需删除试验副本/表格bug-富文本测试-重识概率论-副本.md';

const argOf = (name, fallback) => {
  const hit = process.argv.find(value => value.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};

/** 带状态码与正文的 /json/list：把"端点坏了"和"真的没有目标"分开。 */
const listRaw = port => new Promise(resolve => {
  const request = http.get({host: '127.0.0.1', port, path: '/json/list', timeout: 4000}, response => {
    let body = '';
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => {
      let targets = null, error = null;
      try { targets = JSON.parse(body); } catch (problem) { error = String(problem.message); }
      resolve({status: response.statusCode, bytes: body.length, error,
        pages: Array.isArray(targets) ? targets.filter(t => t.type === 'page').map(t => ({id: t.id, url: String(t.url).slice(0, 40)})) : null,
        types: Array.isArray(targets) ? [...new Set(targets.map(t => t.type))] : null});
    });
  });
  request.on('timeout', () => { request.destroy(); resolve({status: 'timeout', error: '请求本身超时（4s）'}); });
  request.on('error', problem => resolve({status: 'error', error: problem.message}));
});

/** 绕过调试 HTTP 端点，直接对页面目标的 ws 发一次求值（短超时）。 */
const directProbe = url => new Promise(resolve => {
  const began = Date.now();
  let socket;
  try { socket = new WebSocket(url); } catch (problem) { resolve({ok: false, error: '建连失败：' + problem.message}); return; }
  const timer = setTimeout(() => { try { socket.close(); } catch {} resolve({ok: false, ms: Date.now() - began, error: '求值超时（4s）'}); }, 4000);
  socket.onopen = () => {
    try { socket.send(JSON.stringify({id: 1, method: 'Runtime.evaluate', params: {expression: '1+1', returnByValue: true}})); }
    catch (problem) { clearTimeout(timer); resolve({ok: false, error: '发送失败：' + problem.message}); }
  };
  socket.onmessage = event => {
    clearTimeout(timer);
    let value = null;
    try { value = JSON.parse(event.data).result?.result?.value ?? null; } catch (problem) { value = '解析失败：' + problem.message; }
    resolve({ok: true, ms: Date.now() - began, value});
    try { socket.close(); } catch {}
  };
  socket.onerror = () => { clearTimeout(timer); resolve({ok: false, ms: Date.now() - began, error: '连接错误'}); };
});

(async () => {
  let directUrl = null;
  const seconds = Number(argOf('seconds', 120));
  const material = argOf('material', MATERIAL);
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  if (!fs.existsSync(material)) { console.error('素材不存在：' + material); process.exit(1); }
  const copy = path.join(OUT, 'material-copy.md');
  fs.copyFileSync(material, copy);
  fs.chmodSync(copy, 0o666);
  console.log(`素材副本：${copy}（${fs.statSync(copy).size} 字节）`);

  // --inspect=0 会顺带用主进程把会话钉在"第一个窗口"上（bindToFirstWindow）。
  // 场景 76 的第三个会话**没有** inspect，目标只能按 /json/list 的顺序挑——两种都跑一遍对比。
  const useInspect = argOf('inspect', 'on') !== 'off';
  // --exe=… 直接指向打包产物（不传就走开发树）：用来对比"安装版能开、打包版开不动"这类差异
  const exeArg = argOf('exe', '');
  const packaged = !!exeArg;
  console.log('被测产物：' + (packaged ? exeArg : '开发树（electron + app/main/main.js）'));
  console.log('主进程调试器（决定是否按窗口钉目标）：' + (useInspect ? '开' : '关'));
  const session = await harness.launch({
    exe: packaged ? exeArg : path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: packaged ? [] : [path.join(project, 'app/main/main.js')],
    label: 'probe-target-timeline', outDir: OUT, args: [copy], timeout: 300000,
    ...(useInspect ? {inspect: true} : {}),
  });
  const port = session.port;
  const started = Date.now();
  const rows = [];
  try {
    for (let round = 1; Date.now() - started < seconds * 1000; round++) {
      const at = ((Date.now() - started) / 1000).toFixed(1);
      const list = await listRaw(port);
      // 页面目标上的短超时求值：不挂 60 秒，只回答"这一秒它还回话吗"
      const began = Date.now();
      let evalResult = null;
      try {
        evalResult = await session.send('Runtime.evaluate', {expression: `(() => { const w = ${IF};
          return {imgs: w && w.document ? w.document.querySelectorAll('img').length : -1,
            katex: w && w.document ? w.document.querySelectorAll('.katex').length : -1,
            blocks: w && w.document ? (w.document.querySelector('.vditor-ir .vditor-reset') || {children: []}).children.length : -1,
            ready: w && w.document ? !!w.document.querySelector('.vditor-ir .vditor-reset') : false}; })()`,
          returnByValue: true, awaitPromise: false}, 4000);
        evalResult = evalResult && evalResult.result ? evalResult.result.value : evalResult;
      } catch (problem) { evalResult = {error: String(problem.message).split('\n')[0]}; }
      const evalMs = Date.now() - began;
      let windows = null, memory = null;
      if (session.main) {
        try { windows = JSON.parse(await session.main.js(`JSON.stringify(global.windows.map(r => ({id: r.id, title: (r.win && !r.win.isDestroyed()) ? r.win.getTitle() : null})))`)); }
        catch (problem) { windows = '读不到：' + String(problem.message).split('\n')[0]; }
        try { memory = await session.main.js(`(() => { const used = process.memoryUsage(); return {rssMB: Math.round(used.rss / 1048576), heapMB: Math.round(used.heapUsed / 1048576)}; })()`); }
        catch (problem) { memory = '读不到：' + String(problem.message).split('\n')[0]; }
      }
      // 被拉起的那个进程还活着吗——单实例锁抢不到时应用会 app.quit()，这条最直接
      const childExit = session.child.exitCode;
      // 直接连页面目标的 WebSocket（不经过 /json/list）：把"整台浏览器进程卡住"与
      // "只有调试 HTTP 端点不答"分开。第一次拿到 ws 地址后一直记着。
      if (!directUrl && list.pages && list.pages.length) {
        try {
          const fresh = await listRaw(port);
          const hit = await httpJson(port, '/json/list').catch(() => []);
          const page = hit.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl);
          if (page) directUrl = page.webSocketDebuggerUrl;
          void fresh;
        } catch { /* 拿不到就算了 */ }
      }
      const direct = directUrl ? await directProbe(directUrl) : '（还没拿到 ws 地址）';
      const row = {at, list, evalMs, evalResult, windows, memory, childExit, pid: session.child.pid, direct};
      rows.push(row);
      console.log(`t=${at.padStart(6)}s  /json/list 状态=${list.status} 页面目标=${list.pages ? list.pages.length : '读不出'} ` +
        `求值=${evalMs}ms ${JSON.stringify(evalResult)} 窗口=${JSON.stringify(windows)} 内存=${JSON.stringify(memory)} ` +
        `子进程退出码=${childExit === null ? '还活着' : childExit} (pid ${session.child.pid})` +
        (list.error ? ` 列表错误=${list.error}` : ''));
      await sleep(1000);
    }
  } finally {
    // 开着主进程调试器时，把**系统对话框的调用记录**打出来：模态框是"应用卡住"的常见真因，
    // 而它不在 DOM 里，只有这条通道看得见（stub 记录了 title/message/buttons/parent）。
    if (session.main) {
      try {
        const calls = await session.main.calls();
        console.log('\n主进程收到的系统对话框调用（' + calls.length + ' 次）：');
        for (const call of calls) {
          const options = call.options || {};
          console.log(`  · ${call.kind}　挂在哪：${call.parentTitle || '（无父窗口）'}　` +
            `title=${JSON.stringify(String(options.title || '').slice(0, 40))} ` +
            `message=${JSON.stringify(String(options.message || options.detail || '').slice(0, 160))}`);
        }
        fs.writeFileSync(path.join(OUT, 'dialogs.json'), JSON.stringify(calls, null, 2));
      } catch (problem) { console.log('读对话框记录失败：' + problem.message); }
    }
    fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify(rows, null, 2));
    // 应用的诊断日志（Step 2 落的那个文件）若有，一并留下
    try {
      const logs = path.join(session.profile, 'logs', 'markpilot.log');
      if (fs.existsSync(logs)) fs.copyFileSync(logs, path.join(OUT, 'markpilot.log'));
    } catch { /* 没有就算了 */ }
    await session.close();
    fs.rmSync(copy, {force: true});   // 副本用完即删（受保护素材规矩）
    console.log('时间线：' + path.join(OUT, 'timeline.json'));
  }
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
