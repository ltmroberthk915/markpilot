/** 打包产物验收基座（acceptance harness）。
 *
 *  为什么必须另起一套：本轮用户报的"复制图片失败"在开发树上永远测不出来——
 *  媒体宿主把 `__dirname/media-clipboard.ps1` 交给 PowerShell，而打包后 __dirname
 *  落在 app.asar（虚拟文件系统）里，Windows PowerShell 打不开这个路径。开发树的
 *  文件是真路径，所以探针全绿、用户全红。**假通过的第一大来源就是"被测对象不是
 *  交付产物"**。
 *
 *  所以这套基座只做一件事：把真实产物（安装版 EXE / win-unpacked EXE）用 CDP 拉起来，
 *  用真实输入事件驱动它，并且只接受"代码之外"的证据（系统剪贴板、磁盘文件、
 *  独立进程、几何量测）。结构上禁止假通过：
 *    - 每个场景至少要有一条 independent witness，否则判失败（run.cjs 强制）；
 *    - 每个场景必须断言"用户看得见的效果"，不许只断言"处理器被调用了"；
 *    - 动作之后必须断言"没有错误面"（错误提示/task 报错/异常/console 报错）；
 *    - 性能与内存数字进台账，跨版本按容差比，回归即失败。
 */
'use strict';
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');

const project = path.resolve(__dirname, '..', '..');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let launchCount = 0;

/** 产品内部 HTTP 服务的首选端口。2.0.16 起被占用时会自动退到动态端口，
 *  2.0.15 及更早会直接崩——验收启动前先等它空出来，避免把"上一个实例还没退干净"
 *  误报成"打开失败"。 */
const INTERNAL_PORT = 48190;
const portFree = port => new Promise(resolve => {
  const server = require('node:net').createServer();
  server.once('error', () => resolve(false));
  server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});
async function waitForPortFree(port, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await portFree(port)) return Date.now() - started;
    await sleep(150);
  }
  return -1;
}
/** 端口被占时把占用者找出来：不猜，直接问系统。 */
const portHolder = port => {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
    const lines = out.split('\n').filter(line => line.includes(':' + port) && /LISTENING/i.test(line));
    const pids = [...new Set(lines.map(line => line.trim().split(/\s+/).pop()))];
    const owners = pids.map(pid => {
      try {
        const list = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' }).trim();
        return `${pid} ${list.split(',')[0]}`;
      } catch { return pid; }
    });
    return owners.join(' | ') || '（netstat 没报占用者）';
  } catch (error) { return 'netstat 失败：' + error.message; }
};
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const fileSha = file => sha256(fs.readFileSync(file));

// 注入到每个新文档（顶层页与编辑器 iframe 都覆盖）的只读观测器。它只记录，
// 不改任何产品行为；keydown 监听器在捕获阶段只为自证"按键真的送到了页面"。
const SHIM = `(() => {
  const acc = window.__acc = {marks: [], paints: {}, longtasks: [], innerHTML: [], errors: [], keys: [], href: location.href};
  acc.marks.push({name: 'shim', t: +performance.now().toFixed(1)});
  try { new PerformanceObserver(list => { for (const entry of list.getEntries()) acc.longtasks.push({start: Math.round(entry.startTime), ms: Math.round(entry.duration)}); }).observe({entryTypes: ['longtask']}); } catch (error) { acc.longtaskError = String(error); }
  try { new PerformanceObserver(list => { for (const entry of list.getEntries()) acc.paints[entry.name] = Math.round(entry.startTime); }).observe({type: 'paint', buffered: true}); } catch (error) { acc.paintError = String(error); }
  try {
    addEventListener('error', event => acc.errors.push('error:' + (event.message || '')));
    addEventListener('unhandledrejection', event => acc.errors.push('rejection:' + String((event.reason && event.reason.message) || event.reason)));
  } catch {}
  try {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    Object.defineProperty(Element.prototype, 'innerHTML', {
      configurable: true, get: descriptor.get,
      set(value) {
        if (typeof value !== 'string' || value.length <= 20000) return descriptor.set.call(this, value);
        const start = performance.now();
        descriptor.set.call(this, value);
        acc.innerHTML.push({ms: +(performance.now() - start).toFixed(1), chars: value.length, cls: String(this.className).slice(0, 40)});
      },
    });
  } catch {}
  addEventListener('keydown', event => acc.keys.push({key: event.key, shift: event.shiftKey, ctrl: event.ctrlKey, composing: event.isComposing, prevented: event.defaultPrevented, at: Math.round(performance.now())}), true);
  acc.ready = true;
})();`;

const VK = {
  Enter: 13, Escape: 27, Tab: 9, Space: 32, Backspace: 8, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, End: 35, Home: 36,
  KeyA: 65, KeyC: 67, KeyF: 70, KeyS: 83, KeyV: 86, KeyX: 88, KeyZ: 90, F13: 124,
};
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

function httpJson(port, pathname, timeout = 1200) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname, timeout }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

/** 启动产物并接上 CDP。--remote-debugging-port=0 让 Chromium 自己挑端口，
 *  端口号写在 <profile>/DevToolsActivePort，比猜端口稳。 */
async function launch(options) {
  const exe = path.resolve(options.exe);
  if (!fs.existsSync(exe)) throw new Error('产物不存在：' + exe);
  const label = options.label || path.basename(path.dirname(exe));
  const outDir = options.outDir || path.join(project, '.perf/acceptance', label);
  fs.mkdirSync(outDir, { recursive: true });
  // 每次启动一个独立 profile：Windows 上刚退出的进程还会短暂占着文件句柄，
  // 复用同名目录会在删目录时撞 EPERM（实测）。
  const profile = options.profile || path.join(project, '.perf/acceptance/profiles', `${label}-${process.pid}-${++launchCount}`);
  // keepProfile:连续启动同一个 profile 才能观察 Chromium 的磁盘缓存/代码缓存
  // （代码缓存 A/B 探针就靠它）。默认仍然每次用干净 profile。
  if (!options.keepProfile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 });
  fs.mkdirSync(profile, { recursive: true });
  // 复用同一个 profile 时，上一轮写的 DevToolsActivePort 会留下**已经作废的端口号**，
  // 照它去连只会一直连不上（实测：报"没有找到页面目标"，进程其实活得好好的）。
  // 每次启动前先删掉，让 Chromium 重新写。
  if (options.keepProfile) fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
  const logs = fs.openSync(path.join(outDir, 'app-stderr.log'), 'a');
  // 日志是**追加**的（同一个场景目录跨多次运行复用），所以启动前记下偏移：
  // 只在本次追加的那段里找"Debugger listening"，否则会连到上一次运行留下的死地址
  // （实测：拿旧 URL 去连，socket 直接失败，报"主进程调试器没接上"）。
  // **必须是字符数、不是字节数**：下面读日志后是按字符串 slice 的，而日志里会出现中文
  // （例：KaTeX 报 `Unicode text character 甲 used in math mode`）。拿 statSync().size 的
  // 字节数当偏移，前一次运行的中文越多就切得越靠后，会把本次的 Debugger 行整段切掉，
  // 表现为"同一个场景每次都说主进程调试器没接上"（场景 101 踩到，排查花了不少时间）。
  const logStart = (() => {
    try { return fs.readFileSync(path.join(outDir, 'app-stderr.log'), 'utf8').length; } catch { return 0; }
  })();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // 参数顺序有讲究：位置参数必须保持 [可选的应用入口, 被打开的文件] 这个相对顺序，
  // Chromium 开关统一放最后。反例（本轮踩过）：把开关插在应用入口之前，开发模式下
  // 应用的 findLaunchPath 会把 main.js 当成要打开的文档；把入口放开关之后，Electron
  // 自己又会把 .md 素材当成应用入口（ERR_UNKNOWN_FILE_EXTENSION ".md"）。
  const args = [
    ...(options.appArgs || []),
    ...(options.args || []),
    '--user-data-dir=' + profile,
    '--remote-debugging-port=0',
    // inspect：给**主进程**开 Node 调试器（Electron 会在 stderr 打印 ws 地址）。这是
    // 「打开文件/打开文件夹/另存为/导出/确认框」这些**系统对话框**功能的唯一可测通道：
    // 对话框是操作系统的原生窗口，CDP 的 Input 事件送不进去，所以在主进程里把
    // dialog.* 换成受脚本控制的替身（见 attachMainInspector），下游全是真产品代码。
    // inspectBrk：还要**在入口第一行停住**——启动路径（命令行一次给多个文件、会话恢复）
    // 里的对话框比页面目标出现得早，不先停住就没法在它之前把替身装好（实测：一次给 6 个
    // 文件时的确认框在探针装好之前就已经弹出来了，只能干等）。
    ...(options.inspectBrk ? ['--inspect-brk=0'] : options.inspect ? ['--inspect=0'] : []),
    '--no-sandbox',
    '--enable-logging=stderr',
    '--v=0',
  ];
  const waitedForPortMs = await waitForPortFree(INTERNAL_PORT, options.portWait === undefined ? 8000 : options.portWait);
  const portContention = waitedForPortMs < 0 ? portHolder(INTERNAL_PORT) : null;
  if (portContention) console.log(`  · 内部端口 ${INTERNAL_PORT} 被占用：${portContention}`);
  fs.writeFileSync(path.join(outDir, 'launch.json'), JSON.stringify({ exe, args, waitedForPortMs, portContention, at: new Date().toISOString() }, null, 2));
  const spawnedAt = Date.now();
  // 注意：**不能**给被测应用加 windowsHide——它会给进程塞 STARTF_USESHOWWINDOW/SW_HIDE，
  // 而 Windows 对进程的第一次 ShowWindow 调用会忽略参数、直接用 STARTUPINFO 里的值，
  // 于是 win.show() 被改写成"隐藏"，窗口永远不出现（实测 MainWindowHandle 恒为 0）。
  // 于是"窗口可见"这类真机判据会全部假通过。PowerShell 子进程仍然用 windowsHide。
  const child = spawn(exe, args, { env, stdio: ['ignore', logs, logs] });
  // 独立的"窗口什么时候真的出现在屏幕上"证人：从窗口管理器侧看，不由应用自报。
  const watcher = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'window-visible.ps1'), '-Profile', profile, '-Timeout', String(options.windowTimeout || 90000)], { windowsHide: true });
  let watchOutput = '';
  watcher.stdout.on('data', part => { watchOutput += part.toString('utf8'); });
  const windowVisible = () => {
    const hit = /visible\s+(\d+)\s+(\d+)\s+(\d+)/.exec(watchOutput);
    if (!hit) return null;
    return { epoch: Number(hit[1]), pid: Number(hit[2]), fromWatchStart: Number(hit[3]), spawnToVisible: Number(hit[1]) - spawnedAt };
  };
  const errors = [];
  const warnings = [];
  const stderrTail = () => {
    try {
      const file = path.join(outDir, 'app-stderr.log');
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-8).join(' / ').slice(-600);
    } catch { return ''; }
  };
  const kill = () => {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    try { child.kill(); } catch {}
  };
  // inspectBrk：应用正停在入口，Chromium 的 CDP 端口还没开出来（它要等 app ready），
  // 所以必须先接上主进程调试器、装好替身、再放行，然后才谈等端口/等页面。
  let main = null;
  if (options.inspectBrk) {
    main = await attachMainInspector({ outDir, logStart, resume: true, beforeResume: options.beforeResume || null });
    if (!main) throw new Error('主进程调试器没接上（--inspect-brk 没生效？stderr：' + stderrTail() + '）');
  }
  // 启动失败绝不留孤儿进程：上一个实例还活着会占住内部端口，把后面的场景全带崩。
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    let port = 0;
    while (Date.now() - spawnedAt < (options.timeout || 60000)) {
      // Chromium 写这个文件是"先建后写"，读得太早会撞 EBUSY/半截内容（实测）。
      try {
        if (fs.existsSync(portFile)) {
          const text = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
          if (/^\d+$/.test(text)) { port = Number(text); break; }
        }
      } catch { /* 正在写，下一轮再读 */ }
      if (child.exitCode !== null) break;
      await sleep(20);
    }
    if (!port) throw new Error('产物没有开放 CDP 端口（启动失败？stderr：' + stderrTail() + '）');
    // 主进程调试器：inspectBrk 时必须在**等页面目标之前**接上并放行（那时应用还停在入口），
    // 否则启动路径上的对话框早就弹过去了。
    let main = null;
    if (options.inspectBrk || options.inspect) {
      main = await attachMainInspector({ outDir, logStart, resume: !!options.inspectBrk, beforeResume: options.beforeResume || null });
      if (!main) throw new Error('主进程调试器没接上（--inspect 没生效？stderr：' + stderrTail() + '）');
    }
    let target = null;
    const deadline = Date.now() + (options.timeout || 60000);
    while (Date.now() < deadline) {
      try {
        const list = await httpJson(port, '/json/list');
        target = list.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl && !/devtools/.test(entry.url));
      } catch { target = null; }
      if (target) break;
      if (child.exitCode !== null) break;
      await sleep(20);
    }
    if (!target) throw new Error('没有找到页面目标（进程退出码 ' + child.exitCode + '，stderr：' + stderrTail() + '）');
    // 多窗口时 /json/list 的顺序不保证（实测：给两个文件启动时，会话可能绑到**第二个**窗口上，
    // 于是"在窗口一里打字"其实打进了窗口二，整批断言全歪）。这里把会话钉死在**第一个窗口**：
    // 让主进程给那个窗口的页面打上 location.hash 标记，再按标记挑目标。
    if (main) {
      const bound = await bindToFirstWindow(port, main);
      if (bound) target = bound;
    }
    return await attach({ child, port, target, profile, outDir, label, exe, spawn: spawnedAt, errors, warnings, windowVisible, watcher, main });
  } catch (error) {
    kill();
    try { watcher.kill(); } catch {}
    throw error;
  }
}

/** 接上**主进程**的 Node 调试器，并把 dialog.* 换成可脚本控制的替身。
 *
 *  为什么必须这么做：`showOpenDialogSync` / `showMessageBoxSync` 是操作系统原生窗口，
 *  渲染进程的 CDP 事件送不进去，于是「欢迎页的打开文件/打开文件夹」「另存为」「导出
 *  HTML/PDF/Word」「未保存确认」「外部修改冲突」这一整类**日常操作**此前根本没法自动验收
 *  ——它们不是没测，是测不了。替身只顶替"用户在系统对话框里选了什么"，
 *  对话框之后的一切（路径处理、读盘、装载、写盘、导出）都是真产品代码。
 *
 *  替身同时把**交给系统的参数**记下来（title / filters / properties / defaultPath /
 *  挂在哪一个窗口上）——这本身就是证人：对话框配置错了（比如没带 multiSelections、
 *  defaultPath 指错目录）能直接看出来。 */
async function attachMainInspector({ outDir, logStart = 0, timeout = 20000, resume = false, beforeResume = null }) {
  const logPath = path.join(outDir, 'app-stderr.log');
  const deadline = Date.now() + timeout;
  let urls = [];
  while (Date.now() < deadline && !urls.length) {
    try {
      // 只看本次追加的那一段：同一个场景目录跨多次运行复用，日志是追加写的，
      // 拿旧地址去连会直接失败（实测报"主进程调试器没接上"）。
      const text = fs.readFileSync(logPath, 'utf8').slice(logStart);
      urls = [...text.matchAll(/Debugger listening on (ws:\/\/\S+)/g)].map(hit => hit[1]);
    } catch { /* 日志还没落盘 */ }
    if (!urls.length) await sleep(40);
  }
  if (!urls.length) return null;
  // 最新的那个才属于本次进程；连不上再逐个往前退（同一段里可能重启过）。
  let url = null, socket = null;
  for (const candidate of [...urls].reverse()) {
    try {
      const attempt = new WebSocket(candidate);
      await new Promise((resolve, reject) => { attempt.onopen = resolve; attempt.onerror = reject; });
      url = candidate; socket = attempt; break;
    } catch { /* 试更早的地址 */ }
  }
  if (!socket) return null;
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { const { resolve } = pending.get(message.id); pending.delete(message.id); resolve(message); }
  };
  const send = (method, params = {}) => new Promise(resolve => { const id = ++sequence; pending.set(id, { resolve }); socket.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable');
  /** 主进程求值。includeCommandLineAPI 是必须的：`require` 只在命令行 API 里存在，
   *  不开这个开关连 require('electron') 都拿不到（实测 ReferenceError）。 */
  const evaluate = async (expression, maxLength = 4000) => {
    const message = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true });
    const result = message.result || {};
    if (result.exceptionDetails) {
      const detail = String(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '');
      throw new Error('主进程内报错：' + detail.split('\n').slice(0, 3).join(' | ').slice(0, maxLength));
    }
    return result.result?.value ?? null;
  };
  const STUB = `(() => {
    const electron = require('electron');
    const dialog = electron.dialog;
    const shell = electron.shell;
    const NAMES = ['showOpenDialogSync','showOpenDialog','showSaveDialogSync','showSaveDialog','showMessageBoxSync','showMessageBox'];
    const SHELL_NAMES = ['showItemInFolder','openPath','openExternal','beep'];
    const state = global.__accDialog = global.__accDialog || { calls: [], script: [], originals: null, shellCalls: [], shellOriginals: null };
    if (!state.originals) {
      state.originals = {};
      for (const name of NAMES) state.originals[name] = dialog[name];
    }
    // 「在资源管理器中显示 / 用系统程序打开 / 打开仓库链接」这类动作会在用户桌面上弹窗口：
    // 自动验收不该去点用户的桌面，所以同样替换成"记录调用"——它照样能证明产品把正确的路径
    // 交给了系统（这正是可断言的部分）。
    if (!state.shellOriginals) {
      state.shellOriginals = {};
      for (const name of SHELL_NAMES) state.shellOriginals[name] = shell[name];
    }
    const clone = value => { try { return JSON.parse(JSON.stringify(value || {}, (k, v) => (typeof v === 'function' ? '[function]' : v))); } catch { return null; } };
    const record = (kind, parent, options) => {
      let parentTitle = null;
      try { parentTitle = parent && !parent.isDestroyed() ? parent.getTitle() : null; } catch { parentTitle = null; }
      state.calls.push({ kind, parentTitle, options: clone(options), at: Date.now() });
    };
    const take = kind => {
      const index = state.script.findIndex(step => step && step.dialog === kind);
      if (index < 0) return null;
      return state.script.splice(index, 1)[0];
    };
    // 没有脚本时给"取消"语义（cancelId 优先）：不脚本化的模态框绝不替用户做危险选择。
    const fallback = options => {
      if (options && typeof options.cancelId === 'number') return options.cancelId;
      if (options && typeof options.defaultId === 'number') return options.defaultId;
      return 0;
    };
    const pick = (step, options) => (step && typeof step.response === 'number' ? step.response : fallback(options));
    dialog.showOpenDialogSync = (parent, options) => { record('open', parent, options); const step = take('open'); return step ? (step.files || []) : []; };
    dialog.showOpenDialog = async (parent, options) => { record('open', parent, options); const step = take('open'); const files = step ? (step.files || []) : []; return { canceled: !files.length, filePaths: files }; };
    dialog.showSaveDialogSync = (parent, options) => { record('save', parent, options); const step = take('save'); return step ? (step.file || null) : null; };
    dialog.showSaveDialog = async (parent, options) => { record('save', parent, options); const step = take('save'); const file = step ? (step.file || null) : null; return { canceled: !file, filePath: file }; };
    dialog.showMessageBoxSync = (parent, options) => { record('message', parent, options); return pick(take('message'), options); };
    dialog.showMessageBox = async (parent, options) => ({ response: (record('message', parent, options), pick(take('message'), options)), checkboxChecked: false });
    for (const name of SHELL_NAMES) {
      shell[name] = (...args) => {
        const target = String(args[0] === undefined ? '' : args[0]);
        state.shellCalls.push({ name, target: target.slice(0, 300), at: Date.now() });
        return name === 'openPath' ? Promise.resolve('') : undefined;
      };
    }
    return 'dialog stub installed';
  })()`;
  const installed = await evaluate(STUB);
  // --inspect-brk 下应用还停在入口：先把调用方要的脚本/设置塞进去，再放行，
  // 这样启动路径里的系统对话框也会走替身。
  if (beforeResume) await evaluate(beforeResume);
  if (resume) await send('Runtime.runIfWaitingForDebugger');
  /** 脚本化"用户在系统对话框里选了什么"：按 dialog 种类（open/save/message）排队取用。 */
  const script = async steps => evaluate(`(() => { const s = global.__accDialog; s.script = ${JSON.stringify(steps || [])}; return s.script.length; })()`);
  const calls = async () => JSON.parse(await evaluate('JSON.stringify(global.__accDialog.calls)'));
  const clearCalls = async () => evaluate('global.__accDialog.calls.length = 0');
  const restore = async () => evaluate(`(() => { const s = global.__accDialog; if (!s || !s.originals) return 'nothing to restore'; const electron = require('electron');
    for (const name of Object.keys(s.originals)) electron.dialog[name] = s.originals[name];
    for (const name of Object.keys(s.shellOriginals || {})) electron.shell[name] = s.shellOriginals[name];
    s.script = []; return 'dialog restored'; })()`);
  /** 「在资源管理器中显示 / 用系统程序打开 / 打开外部链接」被调用的记录（已替换成不弹窗）。 */
  const shellCalls = async () => JSON.parse(await evaluate('JSON.stringify(global.__accDialog.shellCalls)'));
  // 菜单 label 里带 & 助记符与 (F) 这样的加速键括号，归一化后才能按 "文件 > 保存" 这样的路径找。
  const MENU_LABEL_FN = `const menuLabel = item => { let s = String((item && item.label) === undefined ? '' : item.label).replace(/&/g, '');
    const open = s.lastIndexOf('(');
    if (open > 0 && s.trim().endsWith(')')) s = s.slice(0, open);
    return s.trim(); };`;
  /** 应用菜单：桌面端最主要的操作入口（文件/编辑/查看/帮助）。逐项读出 label/type/enabled/
   *  checked/accelerator —— 菜单项的启用状态与勾选状态本身就是"用户看得见"的判据。 */
  const menu = async () => JSON.parse(await evaluate(`(() => {
    ${MENU_LABEL_FN}
    const menubar = require('electron').Menu.getApplicationMenu();
    if (!menubar) return '[]';
    const out = [];
    const walk = (items, prefix) => { for (const item of items) {
      const label = menuLabel(item);
      const path = prefix ? prefix + ' > ' + label : label;
      out.push({path, label, type: item.type || 'normal', enabled: item.enabled !== false, checked: !!item.checked,
        visible: item.visible !== false, accelerator: item.accelerator || null, id: item.id || null, role: item.role || null, hasSubmenu: !!item.submenu, raw: String(item.label === undefined ? '' : item.label)});
      if (item.submenu) walk(item.submenu.items, path);
    } };
    walk(menubar.items, '');
    return JSON.stringify(out);
  })()`));
  /** 按"文件 > 保存"这样的路径点菜单项（等价于用户拿鼠标点）。返回 CLICKED / DISABLED / NOT_FOUND。
   *  注意 role 项（关窗/退出/全屏等）由 Electron 自己处理，这里点不动，要用快捷键或窗口 API。 */
  const clickMenu = async path => evaluate(`(() => {
    ${MENU_LABEL_FN}
    const menubar = require('electron').Menu.getApplicationMenu();
    const want = ${JSON.stringify(String(path))}.split('>').map(part => menuLabel({label: part})).filter(Boolean);
    let items = menubar ? menubar.items : [], found = null;
    for (const name of want) {
      found = items.find(item => menuLabel(item) === name);
      if (!found) return 'NOT_FOUND: ' + name;
      items = found.submenu ? found.submenu.items : [];
    }
    if (!found) return 'NOT_FOUND';
    if (found.enabled === false) return 'DISABLED: ' + menuLabel(found);
    if (found.submenu) return 'HAS_SUBMENU: ' + menuLabel(found);
    if (found.role) return 'ROLE_ITEM: ' + found.role;
    found.click();
    return 'CLICKED: ' + menuLabel(found);
  })()`);
  return { url, installed, js: evaluate, script, calls, clearCalls, restore, shellCalls, send, socket, menu, clickMenu, close: () => { try { socket.close(); } catch {} } };
}

/** 把"第一个窗口"找出来（多窗口时 /json/list 顺序不可靠）：给它的页面打 hash 标记，再按标记挑目标。 */
async function bindToFirstWindow(port, mainInspector) {
  try {
    const recs = JSON.parse(await mainInspector.js(`JSON.stringify(global.windows.map(r => ({ id: r.id })))`));
    if (!recs.length) return null;
    const marker = 'acc-win-' + recs[0].id;
    await mainInspector.js(`(() => { const rec = global.windows.find(r => r.id === ${Number(recs[0].id)}); if (!rec || rec.win.isDestroyed()) return false; rec.win.webContents.executeJavaScript(${JSON.stringify(`location.hash='${marker}'`)}).catch(() => {}); return true; })()`);
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const list = await httpJson(port, '/json/list').catch(() => []);
      const hit = list.find(entry => entry.type === 'page' && String(entry.url).includes(marker) && entry.webSocketDebuggerUrl);
      if (hit) return hit;
      await sleep(50);
    }
  } catch { /* 绑定失败就退回列表顺序（不影响老用例） */ }
  return null;
}

/** 一条 CDP 连接上的页面能力集。抽出来是因为**多窗口**：每个窗口是一个独立页面目标，
 *  要往第二个窗口发真实输入就得另开一条连接，而"能点的东西"必须和主会话一模一样
 *  （同一套 click/type/key/until），否则第二个窗口只能用造事件来测——那就不算真输入。 */
function makePage({ socket, send, outDir, errors, warnings, label }) {
  const evaluate = async (expression, options2 = {}) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) {
      const message = String(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '');
      if (options2.soft) return { ok: false, error: message.slice(0, 400), value: null };
      throw new Error('页面内报错：' + message.slice(0, 400) + ' ← ' + String(expression).slice(0, 200));
    }
    return { ok: true, error: null, value: result.result?.value ?? null };
  };
  return {
    label,
    /** 顶层页求值。 */
    async js(expression, options2) { return (await evaluate(expression, options2)).value; },
    /** 顶层页求值，失败返回 {ok:false,error}，不抛。 */
    async jsSoft(expression) { return evaluate(expression, { soft: true }); },
    send,
    // 事件级通道：send 只认回包（按 id 匹配），而 Page.screencastFrame 这类**事件**只能从
    // socket 上收。录屏抓帧（判"画面到底有没有在动"）必须走它。
    socket,
    errors, warnings,
    /** 屏幕上真的有这个窗口、而且它在前台吗（发真实输入前的前置条件）。 */
    async foreground() { return this.js(`document.hasFocus()`); },
    /** 编辑器 iframe 的 window；文档没开好时为 null。 */
    async editorWindow() { return this.js(`(() => { const frame = document.getElementById('editor'); return frame && frame.contentWindow ? true : false; })()`); },
    async until(expression, options2 = {}) {
      const stop = Date.now() + (options2.timeout || 30000);
      let transportErrors = 0;
      let lastError = '';
      while (Date.now() < stop) {
        // 传输层出错（目标暂时不答/超时）不能让它冒泡：`jsSoft` 只吞页面异常，不吞 `send` 的
        // 拒绝，所以一次死目标会让这里挂满 60 秒再抛，把一条**断言全过**的场景判失败
        // （实测：场景 76 105/105 断言、70 证人全过，却因最后一次轮询报 CDP 超时）。
        //
        // **但也不能就此放弃**（2026-09-17 实测纠正）：大素材在 dev 下冷启动时，浏览器进程会有
        // 约 30 秒不答任何调试请求（`probe-target-timeline.cjs` 逐秒时间线：t=1.0s 起
        // `/json/list` 超时、求值超时，t=28s 起恢复、t=34s 素材已完整渲染 295 条公式）。
        // 旧实现在第一次传输错误就 `return false`，180 秒的等待预算当场作废——场景于是被误判成
        // "素材没打开"（76 的两个红断言、以及 `存活页面目标=[]` 那条警告，都是这么来的）。
        // 正确语义是"这一刻还没就绪，接着等"：只在**整段预算里一次都没成功过**时才判失败。
        let hit;
        try { hit = await this.jsSoft(expression); }
        catch (error) {
          transportErrors++;
          lastError = String((error && error.message) || error).split('\n')[0];
          // 第一次记现场就够（还活着哪些页面目标、主进程窗口清单）：pages() 走调试 HTTP 端点、
          // recs() 走主进程那条独立 socket，两者能帮人区分"目标没了"与"进程正忙"。
          if (transportErrors === 1) {
            const alive = await this.pages().catch(() => '读不到');
            const windows = await this.recs().catch(() => '读不到');
            warnings?.push('until 轮询遇到传输错误（继续等，不放弃）：' + lastError
              + ' ｜ 存活页面目标=' + JSON.stringify(alive)
              + ' ｜ 主进程窗口=' + JSON.stringify(windows));
          }
          await sleep(Math.max(options2.interval || 40, 400));
          continue;
        }
        if (hit.ok && hit.value) return true;
        await sleep(options2.interval || 40);
      }
      if (transportErrors) {
        warnings?.push(`until 等待期间有 ${transportErrors} 次传输错误、一次都没读到就绪（最后一条：${lastError}）`);
      }
      return false;
    },
    async key(spec) {
      const modifiers = spec.modifiers || 0;
      const vk = spec.vk || VK[spec.key] || 0;
      const base = { key: spec.key, code: spec.code || spec.key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      if (spec.text) await send('Input.dispatchKeyEvent', { type: 'char', ...base, text: spec.text, unmodifiedText: spec.text });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    async enter(shift = false) { return this.key({ key: 'Enter', code: 'Enter', vk: 13, text: '\r', modifiers: shift ? MOD.shift : 0 }); },
    async chord(key, code, vk) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: MOD.ctrl });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: MOD.ctrl });
    },
    /** 文本输入走 insertText：这正是 IME 上屏在 Chromium 里的通道，不是 DOM 造事件。 */
    async type(text) { await send('Input.insertText', { text }); },
    async click(x, y, options2 = {}) {
      const common = { x, y, button: options2.button || 'left', buttons: options2.button === 'right' ? 2 : 1, clickCount: options2.clickCount || 1, modifiers: options2.modifiers || 0 };
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common, buttons: 0 });
    },
    async move(x, y) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }); },
    async wheel(x, y, deltaY) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY }); },
    async shot(name) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(outDir, name + '.png');
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      return file;
    },
    /** 装观测器（之后新建的文档都会带上它）。 */
    async instrument() {
      await send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM });
    },
    async reload() {
      await send('Page.reload', { ignoreCache: true });
      await sleep(200);
    },
    /** 顶层页 + 编辑器 iframe 的观测器快照。没有注入 shim 时也要能读数：
     *  performance 时间线本身带 navigation / paint / longtask 条目，timeOrigin 又是
     *  "这个文档什么时候开始加载"的绝对时间锚点，正好用来把"启动慢"与"页面内慢"分开。 */
    async sniffer() {
      return this.js(`(() => {
        const frame = document.getElementById('editor');
        const w = frame && frame.contentWindow;
        const round = value => Math.round(value);
        const dump = win => {
          if (!win || !win.performance) return null;
          const navigation = win.performance.getEntriesByType('navigation')[0];
          return {
            href: String(win.location.href).slice(0, 120),
            timeOrigin: round(win.performance.timeOrigin),
            visible: win.document ? win.document.visibilityState : null,
            paints: Object.fromEntries(win.performance.getEntriesByType('paint').map(entry => [entry.name, round(entry.startTime)])),
            longtasks: win.performance.getEntriesByType('longtask').map(entry => ({start: round(entry.startTime), ms: round(entry.duration)})),
            navigation: navigation ? {responseEnd: round(navigation.responseEnd), domInteractive: round(navigation.domInteractive), domContentLoaded: round(navigation.domContentLoadedEventEnd), load: round(navigation.loadEventEnd)} : null,
            acc: win.__acc ? {marks: win.__acc.marks, keys: win.__acc.keys, errors: win.__acc.errors, innerHTML: win.__acc.innerHTML, longtasks: win.__acc.longtasks} : null,
          };
        };
        return {top: dump(window), editor: dump(w), frameRect: frame ? (() => { const rect = frame.getBoundingClientRect(); return {x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height)}; })() : null};
      })()`);
    },
  };
}

/** 会话收尾时仍在飞行中的 CDP 请求，用这个标记拒绝。
 *
 *  此前两条 socket 的 close() 只关 socket、不处理 pending：那个请求只能干等满 60 秒超时，
 *  而它的 rejection 在会话早已关掉之后才浮上来，把一条**断言全过**的场景判成失败
 *  （实测：场景 76 105/105 断言、70 证人全过，却报 "CDP 无响应（Runtime.evaluate，60000ms）"）。
 *  run.cjs 见到这个标记、且该场景断言已全过时，记为"收尾竞态"的 note 而不是场景失败——
 *  验收工具的收尾问题不该冒充产品失败，但也不许静默吞掉。 */
const TEARDOWN_REJECT = '会话已关闭（收尾时仍在飞行中的 CDP 请求）';

/** 把在飞的请求全部拒掉。 */
const drainPending = pending => {
  for (const [, entry] of pending) { try { entry.reject(new Error(TEARDOWN_REJECT)); } catch { /* 已结算 */ } }
  pending.clear();
};

/** 另开一条 CDP 会话接到指定页面目标（窗口级输入用）。 */
async function openPage(target, label, { outDir, errors, warnings }) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors?.push(`console[${label}]:` + (message.params.args || []).map(arg => arg.value || arg.description || '').join(' ').slice(0, 300));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      errors?.push(`exception[${label}]:` + String(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text || '').slice(0, 400));
    }
  };
  const send = (method, params = {}, timeoutMs = 60000) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 无响应（${method}，${timeoutMs}ms）：目标可能已关闭`)); }, timeoutMs);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  const page = makePage({ socket, send, outDir, errors, warnings, label });
  return { ...page, target, close: () => { drainPending(pending); try { socket.close(); } catch {} } };
}

/** 接上 CDP 并把会话能力挂出来。 */
async function attach({ child, target, profile, outDir, label, exe, spawn: spawnedAt, errors, warnings, port, windowVisible, watcher, main = null }) {
  const connectedAt = Date.now();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args || []).map(arg => arg.value || arg.description || '').join(' ').slice(0, 300);
      if (message.params.type === 'error') errors.push('console:' + text);
      else if (message.params.type === 'warning') warnings.push('console:' + text);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params.exceptionDetails;
      errors.push('exception:' + String(detail.exception?.description || detail.text || '').slice(0, 400));
    }
    if (message.method === 'Log.entryAdded' && ['error'].includes(message.params.entry.level)) {
      // 带上 url：网络类日志（"Failed to load resource: ... 404"）的正文里**没有** URL，
      // 不记 url 就等于一条不可诊断的红（本轮实测：一条 404 查了五轮探针都拿不到地址）。
      const entry = message.params.entry;
      errors.push('log:' + String(entry.text).slice(0, 260) + (entry.url ? '  @' + String(entry.url).slice(0, 160) : ''));
    }
  };
  const send = (method, params = {}, timeoutMs = 60000) => new Promise((resolve, reject) => {
    const id = ++sequence;
    // 超时必须有：窗口/页面目标一关，CDP 就再也不会回包，没有超时的 send 会**永久挂住**
    // 整个探针（实测：Ctrl+W 关窗那一按，探针一声不响地卡到被外部杀掉，什么结论都拿不到）。
    // 超时错误里带上**发送时刻的调用栈**：只报"60000ms 无响应"曾让我无法指认是哪个调用点
    // 发出的请求（场景 76 105/105 断言全过却因此判失败，排查卡在这里）。
    const sentAt = new Error(`CDP 请求超时于 ${method}`).stack;
    const timer = setTimeout(() => { pending.delete(id);
      const error = new Error(`CDP 无响应（${method}，${timeoutMs}ms）：目标可能已关闭\n发送于：\n` + String(sentAt).split('\n').slice(1, 6).join('\n'));
      reject(error); }, timeoutMs);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable').catch(() => {});
  const consoleErrors = errors; // 同一数组：下面所有 helper 往里追加

  const page = makePage({ socket, send, outDir, errors: consoleErrors, warnings, label });

  const pageSessions = [];
  const session = {
    label, exe, port, profile, outDir, child, spawnedAt, connectedAt,
    windowVisible, main,
    errors: consoleErrors, warnings,
    ...page,
    send,
    /** 当前所有可驱动的顶层页面目标。 */
    async pages() {
      const list = await httpJson(port, '/json/list').catch(() => []);
      return list.filter(entry => entry.type === 'page' && entry.webSocketDebuggerUrl && !/devtools/.test(entry.url)).map(entry => ({ id: entry.id, url: entry.url, title: entry.title }));
    },
    /** 主进程眼里的窗口清单（哪个窗口装着哪个文件）——多窗口断言的第一手证据。 */
    async recs() {
      if (!main) return null;
      return JSON.parse(await main.js(`JSON.stringify(global.windows.map(r => ({ id: r.id, file: r.doc ? r.doc.file : null, title: (r.win && !r.win.isDestroyed()) ? r.win.getTitle() : null, ws: r.workspace ? r.workspace.root : null, hidden: !(r.win && !r.win.isDestroyed()) || !r.win.isVisible() })))`));
    },
    /** 给"第二个窗口"发真实输入用的独立会话。
     *
     *  顶层 session 只绑启动时那一个窗口；而要验证"新开的空窗口里按钮能不能用"，
     *  必须能点**那个窗口**的按钮、读**那个窗口**的 DOM。所有窗口的 URL 都是 /shell，
     *  没法直接认；所以先让主进程给目标窗口的页面打一个 location.hash 标记，
     *  再按 URL 找到它的页面目标，另开一条 CDP 会话（console 错误仍然汇总到同一处）。 */
    async attachWindow(recId) {
      if (!main) throw new Error('窗口级会话需要 inspect 能力：launch({inspect:true})');
      const marker = 'acc-win-' + recId;
      await main.js(`(() => { const rec = global.windows.find(r => r.id === ${Number(recId)}); if (!rec || !rec.win || rec.win.isDestroyed()) throw new Error('窗口不存在或已销毁'); rec.win.webContents.executeJavaScript(${JSON.stringify(`location.hash='${marker}'`)}).catch(() => {}); return true; })()`);
      const deadline = Date.now() + 8000;
      let target = null;
      while (Date.now() < deadline && !target) {
        const list = await httpJson(port, '/json/list').catch(() => []);
        target = list.find(entry => entry.type === 'page' && String(entry.url).includes(marker) && entry.webSocketDebuggerUrl);
        if (!target) await sleep(50);
      }
      if (!target) throw new Error('没找到该窗口的页面目标（标记 ' + marker + '）');
      const child = await openPage(target, marker, { outDir, errors: consoleErrors, warnings });
      pageSessions.push(child);
      return child;
    },
    async close() {
      for (const extra of pageSessions) { try { extra.close(); } catch {} }
      // 先拒掉在飞请求再关 socket：否则它们只能等满 60 秒超时，而 rejection 会在会话关掉之后
      // 才浮上来（见 TEARDOWN_REJECT 的说明）。
      drainPending(pending);
      try { socket.close(); } catch {}
      try { watcher.kill(); } catch {}
      try { main?.close(); } catch {}
      // Electron 会派生渲染进程；/T 连子进程一起收，避免残留占住 profile。
      const exited = new Promise(resolve => child.once('exit', resolve));
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      try { child.kill(); } catch {}
      await Promise.race([exited, sleep(4000)]);
      // 退出后把内部端口让出来再交还控制权，否则下一次启动会误撞 EADDRINUSE。
      await waitForPortFree(INTERNAL_PORT, 8000);
      await sleep(120);
    },
  };
  return session;
}

/** 系统剪贴板证人：读写都经文件交换，绝不把任意文本拼进命令行。 */
function clipboardWitness(action, payload = {}) {
  const script = path.join(__dirname, 'clipboard.ps1');
  const out = path.join(payload.dir || os.tmpdir(), `acc-clipboard-${action}-${Date.now()}-${process.pid}.json`);
  const inFile = payload.in || '';
  const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action, '-Out', out];
  if (inFile) args.push('-In', inFile);
  // 剪贴板是**全系统独占**的资源：别的程序（微信/网盘/输入法）只要在那一刻开着剪贴板，
  // Get-Clipboard 就会抛 "所请求的剪贴板操作失败"（CLIPBRD_E_CANT_OPEN）。实测这台机器上
  // 微信在跑的时候整轮验收里 5 个场景会整条判失败（2026-09-13 那轮），而同一批场景几小时前
  // 是绿的——所以这里做**有限重试**，把"别人短暂占用"和"我们的通道真坏了"分开：
  // 重试 4 次仍打不开就照旧抛错（那时确实要用人工看一眼）。
  let result = '';
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      result = execFileSync(POWERSHELL, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      // 同步睡一下再试（Atomics.wait 是最省事的同步 sleep，不引第三方依赖）
      if (attempt < 3) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700); } catch { /* 退化：直接重试 */ } }
    }
  }
  if (lastError && !result) {
    const detail = String((lastError.stdout || '') + (lastError.stderr || '') || lastError.message).slice(0, 200);
    throw new Error(`剪贴板被其他程序占用或不可用（action=${action}，重试 4 次）：${detail}`);
  }
  const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, '') : '';
  if (!text) throw new Error(`剪贴板证人没有产出（action=${action}）：${String(result).slice(0, 300)}`);
  const data = JSON.parse(text);
  data.__stdout = result.trim().slice(0, 300);
  data.__file = out;
  return data;
}
const saveClipboard = dir => clipboardWitness('save', { dir });
const restoreClipboard = (dir, inFile) => clipboardWitness('restore', { dir, in: inFile });
const readClipboard = dir => clipboardWitness('read', { dir });
/** 把已知文本放进系统剪贴板（粘贴类场景的"前置条件"由独立进程设置，不经产品）。 */
const writeClipboard = (dir, text) => {
  const file = path.join(dir, `acc-clipboard-write-${Date.now()}-${process.pid}.txt`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return clipboardWitness('write', { dir, in: file });
};

/** 产物四路哈希链 + 路径卫生。返回 {ok, checks:[{name, pass, detail}]}。 */
function auditArtifact(options) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
  const asarReader = () => {
    try { return require('@electron/asar'); } catch { return require('asar'); }
  };
  let asar = null;
  try { asar = asarReader(); } catch (error) { add('asar 模块可用', false, String(error.message)); }
  const asarPath = options.asar || path.join(path.dirname(path.resolve(options.exe)), 'resources/app.asar');
  add('app.asar 存在', fs.existsSync(asarPath), asarPath);
  const shared = path.join(project, 'app/renderer');
  const source = 'E:/MarkPilot/Typora-Editor/extension-src/render';
  const list = [];
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else list.push(path.relative(shared, file).replace(/\\/g, '/'));
    }
  };
  if (fs.existsSync(shared)) walk(shared);
  let mismatch = [];
  let missing = [];
  if (asar && fs.existsSync(asarPath)) {
    // asar 内的条目路径是 "app\renderer\..." 这种反斜杠形态，且**不带**前导反斜杠
    // （实测：正斜杠形态与前导反斜杠形态都查不到）。
    for (const relative of list) {
      const inside = 'app\\renderer\\' + relative.split('/').join('\\');
      let packed = null;
      try { packed = asar.extractFile(asarPath, inside); } catch { missing.push(relative); continue; }
      const local = fs.readFileSync(path.join(shared, relative));
      if (!packed.equals(local)) mismatch.push(relative);
    }
  }
  add('产物内 renderer 与开发树逐字节一致', mismatch.length === 0 && missing.length === 0,
    `不一致 ${mismatch.length}：${mismatch.slice(0, 5).join(', ')}；缺失 ${missing.length}：${missing.slice(0, 5).join(', ')}`);
  // 与源仓（extension-src）的一致性：开发树是同步副本，产物必须等于源。
  let sourceDiff = [];
  if (fs.existsSync(source)) {
    for (const relative of list) {
      const from = path.join(source, relative);
      const to = path.join(shared, relative);
      if (!fs.existsSync(from)) { sourceDiff.push('缺源:' + relative); continue; }
      if (!fs.readFileSync(from).equals(fs.readFileSync(to))) sourceDiff.push(relative);
    }
  }
  add('开发树 == extension-src 源', sourceDiff.length === 0, sourceDiff.slice(0, 5).join(', '));
  // 版本一致性：asar 内 package.json 与开发树 package.json
  let packagedVersion = null;
  if (asar && fs.existsSync(asarPath)) {
    try { packagedVersion = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8')).version; } catch {}
  }
  const appVersion = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version;
  const extensionVersion = (() => {
    try { return JSON.parse(fs.readFileSync('E:/MarkPilot/Typora-Editor/extension-src/package.json', 'utf8')).version; } catch { return null; }
  })();
  add('产物版本 == 开发树版本', packagedVersion === appVersion, `产物 ${packagedVersion} / 开发树 ${appVersion}`);
  add('扩展版本 == 开发树版本', extensionVersion === appVersion, `扩展 ${extensionVersion} / 开发树 ${appVersion}`);
  // 路径卫生：交给外部进程的脚本必须在真实文件系统里存在（asar 内不算）。
  const ps1 = 'app/renderer/js/media-clipboard.ps1';
  let unpackedExists = false;
  try {
    const root = path.resolve(options.exe, '..');
    unpackedExists = fs.existsSync(path.join(root, 'resources/app.asar.unpacked', ps1));
  } catch {}
  let asarHasUnpackRule = false;
  try {
    const build = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).build || {};
    asarHasUnpackRule = JSON.stringify(build.asarUnpack || []).includes('.ps1');
  } catch {}
  add('media-clipboard.ps1 已解包到 app.asar.unpacked', unpackedExists, path.join(path.dirname(path.resolve(options.exe)), 'resources/app.asar.unpacked/' + ps1));
  add('打包配置声明了解包规则', asarHasUnpackRule, JSON.stringify((JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).build || {}).asarUnpack || null));
  // .ps1 必须纯 ASCII（PowerShell 5.1 用 ANSI 码页解码无 BOM 脚本）
  const ps1Source = path.join(source, 'js/media-clipboard.ps1');
  if (fs.existsSync(ps1Source)) {
    const bytes = fs.readFileSync(ps1Source);
    const nonAscii = bytes.filter(byte => byte > 127).length;
    add('media-clipboard.ps1 纯 ASCII', nonAscii === 0, `非 ASCII 字节 ${nonAscii}`);
  }
  // 交给外部进程的路径解析器必须自证可用（asar 布局下也要落到真文件）
  try {
    const { resolveExternal } = require(path.join(source, 'js/external-resource.cjs'));
    const faked = resolveExternal('C:/x/resources/app.asar/app/renderer/js', 'media-clipboard.ps1', { read: file => (file.includes('app.asar.unpacked') ? Buffer.from('script') : null), tempDir: os.tmpdir(), quiet: true });
    add('asar 布局下解析到真实文件', faked.source === 'unpacked' && faked.path.includes('app.asar.unpacked'), JSON.stringify(faked));
  } catch (error) {
    add('asar 布局下解析到真实文件', false, String(error.message));
  }
  return { ok: checks.every(check => check.pass), checks, asarPath, packagedVersion, appVersion, extensionVersion };
}

module.exports = {
  project, POWERSHELL, sleep, sha256, fileSha, launch, auditArtifact, TEARDOWN_REJECT,
  clipboardWitness, saveClipboard, restoreClipboard, readClipboard, writeClipboard, MOD, VK, SHIM,
};
