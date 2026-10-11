/** 首屏之后才做的预热队列。
 *
 *  大文档打开时整段是一个不可中断的长任务：Lute 解析全文、Vditor 插入 2.8MB 的 IR
 *  HTML，随后每个想要几何量或缓存的模块都挤在同一个任务里跑。在它结束之前屏幕上什么都
 *  没有，也就是说读者为"只会让后续交互更快"的工作付出了首屏时间。
 *  348k 字素材实测（scripts/ir-perf-probe.cjs，.perf/ir-perf-baseline3.json）：
 *  first-contentful-paint 4324ms，其中约 1.6s 是我们自己的预热——markdown 缓存首建
 *  855ms、大纲几何 329ms 外加我们派发 resize 触发 Vditor 的 K 全量重排 1017ms、
 *  阅读面 169ms、CV 启用 103ms。更关键的是这些几何读取都发生在样式被写过之后，
 *  于是每一次读都在首屏之前强制重排整篇文档。
 *
 *  这里把这类工作搬到首屏之后的分片里，并在有输入待处理时让路：既不推迟读者等待的
 *  东西，也不会在自己身上制造第二次卡顿。
 */
const IDLE_TIMEOUT = 2000;
const SLICE_BUDGET = 8;   // ms of work per slice; slices are separate tasks
const BUSY_RETRY = 60;    // ms to wait when input is pending

const tasks = [];
const stats = {slices: 0, ms: 0, maxSliceMs: 0, waiting: 0, deferred: 0, failures: 0, byTask: {},
  get queued() { return tasks.length; }};
window.__typoraWarmup = stats;
// A/B 开关：`warmup=off` 时所有预热就地同步执行，等于改动前的行为——同一份产物上
// 就能量出"搬走预热"本身值多少，不必跨构建比较（铁律 12 的口径）。
let deferredEnabled = true;
try { deferredEnabled = localStorage.getItem("warmup") !== "off"; } catch { /* no storage */ }
stats.mode = deferredEnabled ? "deferred" : "sync";

let armed = false, running = false, timer = 0;
const pendingInput = () => {
  try { return navigator.scheduling?.isInputPending?.() === true; } catch { return false; }
};
const step = () => {
  timer = 0;
  const task = tasks[0];
  if (!task) { running = false; return; }
  // Nothing here is urgent: a keystroke always wins over warming a cache.
  if (pendingInput()) { stats.deferred++; timer = setTimeout(step, BUSY_RETRY); return; }
  const started = performance.now();
  let done = false;
  try { done = task.fn(SLICE_BUDGET) !== false; }
  catch (error) { stats.failures++; console.warn("[warmup] " + task.name, error); done = true; }
  const spent = performance.now() - started;
  stats.slices++; stats.ms += spent;
  const entry = stats.byTask[task.name] || (stats.byTask[task.name] = {slices: 0, ms: 0, maxMs: 0, at: Math.round(started)});
  entry.slices++; entry.ms += spent;
  if (spent > entry.maxMs) entry.maxMs = spent;
  if (spent > stats.maxSliceMs) stats.maxSliceMs = spent;
  if (done) tasks.shift();
  if (tasks.length) timer = setTimeout(step, 0); else running = false;
};
const start = () => { if (running || !tasks.length) return; running = true; timer = setTimeout(step, 0); };

/** Queue a warm-up step. `fn(budgetMs)` returning false asks to be called again. */
export const afterPaint = (name, fn) => {
  if (!deferredEnabled) { stats.byTask[name] = {slices: 1, ms: 0, maxMs: 0, at: Math.round(performance.now()), sync: true};
    try { while (fn(SLICE_BUDGET) === false) { /* a synchronous arm runs to completion */ } }
    catch (error) { stats.failures++; console.warn("[warmup] " + name, error); }
    return; }
  tasks.push({name, fn});
  if (armed) { start(); return; }
  armed = true;
  const arm = () => { stats.waiting = 0; start(); };
  // Two frames: the first ends the current task, the second lands after the paint it
  // produced. A timer arms the same path in hosts that throttle rAF (hidden webviews).
  requestAnimationFrame(() => requestAnimationFrame(arm));
  setTimeout(() => { stats.waiting = 1; if (!running) arm(); }, 1000);
};

/** One-shot convenience wrapper. */
export const afterPaintOnce = (name, callback) => afterPaint(name, () => { callback(); return true; });
