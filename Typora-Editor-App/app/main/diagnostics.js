'use strict';
/** 本地诊断日志：把主进程错误、渲染进程错误与崩溃事件写到磁盘，供用户交出来排查。
 *
 *  为什么必须有（2026-09-17 定位）：打包后的 Windows 用户看不到 stderr；全应用没有
 *  `app.getPath('logs')`、没有 console 拦截、没有 `uncaughtException` / `unhandledRejection` /
 *  `render-process-gone`。18 处 `console.error` 全进 stderr——**出问题时没有任何可以交给别人
 *  的东西**，只能靠用户口述现象。
 *
 *  三条边界：
 *  · **只写本机**：不装 `crashReporter`，不上报任何远端。对外发送崩溃报告属于发布行为，
 *    要单独决定，不在稳定性工程里顺手做。
 *  · **绝不影响产品**：写日志自身出错一律吞掉。日志把主流程搞挂，比没有日志更糟。
 *  · **有上限**：超过上限就轮转一份 `.1`，不无限增长（用户可能长期不清理）。
 *
 *  读取辅助（`file()` / `tail()`）给"帮助 → 打开诊断日志 / 复制诊断信息"用。
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 1.5 * 1024 * 1024;
const KEEP = 4 * 1024 * 1024;   // 复制诊断信息时最多带这么多尾部内容
/** 攒批：够了或过一小会儿再落盘。**一行一次同步写**会把产品拖死（见下）。 */
const FLUSH_MS = 400;
const FLUSH_BYTES = 256 * 1024;

let logFile = null;
let originalError = null;
let originalWarn = null;
let pending = [];
let pendingBytes = 0;
let timer = null;
let lastLevel = null;
let lastBody = null;
let repeats = 1;

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 23);

/** 轮转：只在收尾落盘时查一次大小，超限就把当前文件顶到 `.1`。 */
const rotate = extra => {
  try {
    if (fs.statSync(logFile).size + extra <= MAX_BYTES) return;
    fs.renameSync(logFile, logFile + '.1');
  } catch { /* 不存在或改名失败都无所谓：接着往下追加即可 */ }
};

/** 把攒着的那一条真正写出去（**每次落盘一次 stat + 一次写**，不是每行一次）。 */
const flush = () => {
  if (timer) { clearTimeout(timer); timer = null; }
  settle();
  if (!pending.length || !logFile) { pending = []; pendingBytes = 0; return; }
  const text = pending.join('');
  pending = [];
  pendingBytes = 0;
  try {
    rotate(text.length);
    fs.appendFile(logFile, text, () => { /* 写日志失败绝不能影响产品 */ });
  } catch { /* 同上 */ }
};

/** 把"正在重复的那一条"结算成一行（带重复计数）。 */
const settle = () => {
  if (lastBody === null) return;
  const suffix = repeats > 1 ? `（同样的消息重复 ${repeats} 次）` : '';
  const text = `${stamp()} [${lastLevel}] ${lastBody}${suffix}\n`;
  lastBody = null;          // 先清状态再 push：push 可能因攒满而触发 flush，flush 又会 settle
  repeats = 1;
  push(text);
};

const push = text => {
  pending.push(text);
  pendingBytes += text.length;
  if (pendingBytes >= FLUSH_BYTES) flush();          // 攒满就立刻落盘（极少数"内容确实各不相同"的洪水）
  else if (!timer) { timer = setTimeout(flush, FLUSH_MS); if (timer.unref) timer.unref(); }
};

/** 记一行。
 *
 *  **为什么不能一行一次同步写**（2026-09-17 实测，代价很大）：公式里的 CJK 会让 KaTeX
 *  一条一条地报 `unicodeTextInMathMode`（受保护素材里 295 条公式报了成千上万条），
 *  每一条都经 `console-message` 过来。旧实现每行做 `statSync` + `appendFileSync`
 *  （4 次同步系统调用），几千条就是几万次同步 FS——**主进程被淹掉，整个应用（连调试端口
 *  一起）几十秒到几分钟不答**：打包版打不开大素材场景就是这么红的，而 2.1.29（没有这套
 *  日志）同一份素材 1 秒渲染完。所以改成三件事：**连批落盘** + **相邻重复折叠计数** +
 *  只在落盘时轮转。 */
const line = (level, parts) => {
  if (!logFile) return;
  const body = parts.map(format).join(' ');
  if (body === lastBody && level === lastLevel) {    // 相邻重复：只计数，不落盘
    repeats++;
    if (!timer) { timer = setTimeout(flush, FLUSH_MS); if (timer.unref) timer.unref(); }
    return;
  }
  settle();
  lastBody = body;
  lastLevel = level;
  repeats = 1;
  if (!timer) { timer = setTimeout(flush, FLUSH_MS); if (timer.unref) timer.unref(); }
};

/** 参数序列化：Error 要带 stack，对象尽量 JSON，其余 String()。 */
const format = value => {
  if (value instanceof Error) return (value.stack || value.message || String(value));
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') { try { return JSON.stringify(value); } catch { return '[object]'; } }
  return String(value);
};

/** 把当前进程的 console 与未捕获异常接上日志。 */
const install = ({ userData }) => {
  if (logFile) return logFile;
  const dir = path.join(userData, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, 'markpilot.log');
  line('info', ['diagnostics start', 'v' + (process.versions.electron || ''), 'node ' + process.versions.node]);

  originalError = console.error.bind(console);
  originalWarn = console.warn.bind(console);
  console.error = (...args) => { line('error', args); originalError(...args); };
  console.warn = (...args) => { line('warn', args); originalWarn(...args); };

  process.on('uncaughtException', error => {
    line('fatal', ['uncaughtException', error]);
    flush();                                  // 崩溃现场必须立刻落盘，不能等攒批
    try { originalError(error); } catch { /* 原始 console 也可能已坏 */ }
  });
  process.on('unhandledRejection', reason => { line('fatal', ['unhandledRejection', reason]); flush(); });
  // 退出前把攒着的写完（这一次同步写是值得的：否则最后几行永远看不到）
  process.on('exit', () => {
    settle();
    if (!pending.length || !logFile) return;
    try { rotate(pendingBytes); fs.appendFileSync(logFile, pending.join('')); } catch { /* 尽力而为 */ }
    pending = [];
    pendingBytes = 0;
  });
  return logFile;
};

/** 接上一个窗口的渲染进程：console、无响应、渲染进程死亡。 */
const attach = (webContents, { onGone } = {}) => {
  if (!webContents || webContents.__diagnosticsAttached) return;
  webContents.__diagnosticsAttached = true;

  // Electron 44 是 (event, details)，老签名是 (event, level, message, line, sourceId)：两种都认。
  webContents.on('console-message', (...args) => {
    const details = args[1];
    const level = details && typeof details === 'object' ? details.level : args[1];
    const message = details && typeof details === 'object' ? details.message : args[2];
    const source = details && typeof details === 'object' ? details.sourceId : args[4];
    const where = source ? ` (${String(source).split(/[\\/]/).pop()})` : '';
    if (level === 'error' || level === 3) line('renderer-error', [String(message) + where]);
    else if (level === 'warning' || level === 'warn' || level === 2) line('renderer-warn', [String(message) + where]);
  });
  webContents.on('unresponsive', () => line('warn', ['renderer unresponsive']));
  webContents.on('responsive', () => line('info', ['renderer responsive again']));
  webContents.on('render-process-gone', (event, details) => {
    line('fatal', ['render-process-gone', details || {}]);
    try { onGone?.(details || {}); } catch (error) { line('warn', ['onGone handler failed', error]); }
  });
};

const file = () => logFile;
const exists = () => !!logFile && fs.existsSync(logFile);

/** 尾部内容：给"复制诊断信息"用（不把整个日志塞进剪贴板）。 */
const tail = (limit = KEEP) => {
  try {
    const buffer = fs.readFileSync(logFile);
    return buffer.length <= limit ? buffer.toString('utf8') : buffer.subarray(buffer.length - limit).toString('utf8');
  } catch { return ''; }
};

module.exports = { install, attach, file, exists, tail };
