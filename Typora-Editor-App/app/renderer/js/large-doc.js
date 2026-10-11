/** Off-screen render skipping for very large IR documents.
 *  Threshold keeps small documents on the zero-risk path; enabling after the
 *  initial layout pass lets contain-intrinsic-size remember real heights.
 *  Measurements live in .perf/cv-probe.json / cv-mem-probe.json / cv-geometry.json.
 *
 *  【2026-09-16】补一条"估算值被撤销冲掉"的修复（用户：大文件带公式编写还有没有优化空间）。
 *  实测（scripts/acceptance/probe-cv-loss-timeline.cjs，1843 块 / 2371 处公式的文档）：
 *    刚上屏          内联估算值 1843/1843   总高 75,745 px
 *    连打 10 个字    1842/1843            75,753 px   ← 只丢被重建的那一块
 *    连撤 10 次      0/1843              606,128 px  ← 整篇丢，8.0 倍
 *    之后静置 90s    0/1843              606,128 px  ← 不会自愈
 *  机制：撤销是 HTML 快照恢复（整篇 innerHTML 重写，实测 1,024,210 字符/次），走回"CV 启用之前"
 *  那份初始快照时，内联估算值随旧 DOM 一起被换掉；新元素既没有内联值、浏览器也没记住它们的高度，
 *  跳过块退回 large-doc.css 的兜底 320px（1843×320≈590k，与实测 606k 吻合）⇒ 滚动条几何与
 *  "滚动位置记忆"漂移，离屏跳过带来的排版收益也一并浪费。触发门槛很低：打开大文件 → 打字 → Ctrl+Z。
 *  修法：把量高抽成 measure()，子节点被换掉后按缺失规模分两档补——
 *   · 少量缺失（正常编辑只会丢被重建的那一块）：只补那几块，读的是它自己的 offsetHeight；
 *   · 大面积缺失（快照恢复）：摘掉 .typora-cv 重新量全篇、再挂回（与启用时同一条路径与校准）。
 *  两档都走 rIC（有 1.5s 兜底），不与打字抢主线程；补完再自检一次，没补干净的接着补。
 */
import {afterPaint} from './warmup.js';
const THRESHOLD = 1500;
/** 与 large-doc.css 里 contain-intrinsic-size 的兜底值一致：读到这个数说明这一块还没被渲染过，
 *  量到的不是真实高度，写了也没有信息量。 */
const DEFAULT_ESTIMATE = 320;
/** 缺估算值的块少于这么多：只补这几块；超过就按"整篇被换掉"走全量重排。 */
const SMALL_REPAIR = 8;

/** 跳过子树（content-visibility:auto）内的深层节点没有可靠几何：
 *  滚动前把目标所在的顶层块临时置为可见，滚完立刻还原。
 *  对照数据（.perf/cv-geometry.json）：块级滚动误差 ≤41px，
 *  深节点在跳过态下可完全失效（实测滚回 0）；取消跳过后与原生语义一致。 */
export const scrollIntoViewSafe = (node, options = {block: "nearest", inline: "nearest"}) => {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  if (!element) return;
  let block = element;
  while (block.parentElement && !block.parentElement.classList?.contains("vditor-reset")) block = block.parentElement;
  const unskip = block && getComputedStyle(block).contentVisibility === "auto";
  if (unskip) block.style.contentVisibility = "visible";
  element.scrollIntoView(options);
  if (unskip) block.style.removeProperty("content-visibility");
};

export const installLargeDocGuard = api => {
  const editor = api.vditor;
  const root = editor.ir.element;
  let enabled = false;
  let repairing = false;
  let repairTimer = 0;
  /** 给验收与排查读的现场：启用状态、最近若干次修复（模式/耗时/总高）。 */
  const stats = window.__typoraCv = {enabled: false, repairs: []};
  // 首屏之前可能已经带了"预置跳过"类（index.js 按内容长度预判，见 large-doc.css）：
  // 它让插入后的第一次排版只排可见块。但预置类的估算高度（320px）不是真实高度，
  // 量高之前必须先摘掉——否则量到的是估算值（这是本轮之前就踩过的坑）。
  const clearPre = () => document.documentElement.classList.remove("typora-cv-pre");
  // 预置跳过还挂着的时候，顶层块的高度是估算值：几何会随校准变一次。滚动位置还原要
  // 等这一信号落定，否则它会在"高度稳定 400ms"上提前收工，然后被校准推走（实测偏 4%）。
  window.__typoraCvPending = document.documentElement.classList.contains("typora-cv-pre");
  /** 量高并写入估算值。**调用前必须保证 .typora-cv 不在**（否则离屏块只返回估算值）。
   *  两趟处理：先全部读，再全部写，避免读-写交错触发全文档重复布局。
   *  拟合对照（.perf/cv-geometry.json，真实总高 193815）：offsetHeight 1.007 ｜ offsetTop 差值 1.217 ｜
   *  差值-自身外边距 1.036 —— 差值法把外边距重复计入（跳过块的盒子仍参与外边距折叠），故取 offsetHeight。
   *  量到的每块高度与真实总高一并缓存下来：整篇被换掉时可以**直接写回缓存值**，不必再摘一次 CV 重排
   *  （实测摘 CV 重量全篇在公式密集文档里要 404ms，而写回缓存只要几毫秒）。 */
  let cache = {heights: null, realTotal: 0};
  const measure = () => {
    const blocks = root.children;
    const count = blocks.length;
    const heights = new Array(count);
    for (let i = 0; i < count; i++) heights[i] = blocks[i].offsetHeight;
    const realTotal = root.scrollHeight;
    const write = scale => {
      for (let i = 0; i < count; i++) {
        if (heights[i] > 0) blocks[i].style.containIntrinsicSize = "auto " + Math.round(heights[i] * scale) + "px";
      }
    };
    write(1);
    cache = {heights, realTotal};
    return {count, realTotal, write};
  };
  /** 用缓存值直接铺一遍（不做任何内容排版）：块数与缓存相差 2% 以内时成立——
   *  撤销一次通常只改一行文字，块数不变；块数变了说明内容结构动过，交给重量那一档。 */
  const applyCached = () => {
    const heights = cache.heights;
    const blocks = root.children;
    if (!heights || !blocks.length) return null;
    if (Math.abs(blocks.length - heights.length) > Math.max(8, heights.length * 0.02)) return null;
    const count = Math.min(blocks.length, heights.length);
    const write = scale => {
      for (let i = 0; i < count; i++) {
        if (heights[i] > 0) blocks[i].style.containIntrinsicSize = "auto " + Math.round(heights[i] * scale) + "px";
      }
    };
    write(1);
    const cvTotal = root.scrollHeight;                    // 有 CV 时读的是估算值之和，不需要内容排版
    if (cache.realTotal > 0 && cvTotal > 0 && Math.abs(cvTotal - cache.realTotal) / cache.realTotal > 0.005) {
      write(cache.realTotal / cvTotal);
    }
    return {blocks: blocks.length, cached: heights.length, realTotal: cache.realTotal, calibrated: Math.round(root.scrollHeight)};
  };
  const enable = () => {
    // 预判错了（块数不够）就把预置类摘掉：小文档零规则命中。
    if (root.childElementCount < THRESHOLD) { clearPre(); window.__typoraCvPending = false; return; }
    if (enabled || !root.isConnected) return;
    clearPre();
    // 逐块写入真实高度作为估算回退值。不这么做时 320px 兜底会把总高抬到真实值的
    // ~4.4 倍（实测 847790 vs 真实 193355），表现为滚动条漂移与"滚动位置记忆"还原到错误位置。
    const {realTotal, write} = measure();
    enabled = true;
    stats.enabled = true;
    root.classList.add("typora-cv");
    // 一次总量校准：把残差按比例摊回，使启用后的 scrollHeight 与真实值一致
    //（实测残差 0.7%–3.9%，校准后 <0.5%），保证滚动位置记忆精确还原。
    const cvTotal = root.scrollHeight;
    if (realTotal > 0 && cvTotal > 0 && Math.abs(cvTotal - realTotal) / realTotal > 0.005) {
      write(realTotal / cvTotal);
    }
    window.__typoraCvPending = false;
  };
  /** 缺估算值的顶层块数。带提前退出：一次按键只需扫到 SMALL_REPAIR+1 块就能判断该走哪一档。 */
  const countMissing = () => {
    const blocks = root.children;
    let missing = 0;
    for (let i = 0; i < blocks.length && missing <= SMALL_REPAIR; i++) {
      if (!blocks[i].style.containIntrinsicSize) missing++;
    }
    return missing;
  };
  /** 少量缺失：只补这几块。被编辑重建的那一块此刻就在视口里，读到的是真实高度；
   *  离屏块读到的是兜底 320px（说明它还没被渲染过），写了没有信息量，跳过。 */
  const patchFew = () => {
    const blocks = root.children;
    const pending = [];
    for (let i = 0; i < blocks.length; i++) {
      if (!blocks[i].style.containIntrinsicSize) pending.push([blocks[i], blocks[i].offsetHeight]);
    }
    let patched = 0;
    for (const [block, height] of pending) {
      if (height > 0 && height !== DEFAULT_ESTIMATE) {
        block.style.containIntrinsicSize = "auto " + height + "px";
        patched++;
      }
    }
    return {missing: pending.length, patched};
  };
  const repair = mode => {
    if (!enabled || repairing || !root.isConnected) return;
    repairing = true;
    const started = performance.now();
    let record = null;
    if (mode === "few") {
      record = patchFew();
    } else {
      // 先用缓存值铺一遍（几毫秒）；块数动过或没有缓存，才摘掉 CV 重量全篇。
      const cached = applyCached();
      if (cached) {
        record = {mode: "full-cached", ...cached};
      } else {
        root.classList.remove("typora-cv");     // 量真实高度前必须先摘掉跳过
        const {realTotal, write} = measure();
        root.classList.add("typora-cv");
        const cvTotal = root.scrollHeight;
        if (realTotal > 0 && cvTotal > 0 && Math.abs(cvTotal - realTotal) / realTotal > 0.005) write(realTotal / cvTotal);
        record = {mode: "full-measured", blocks: root.childElementCount, realTotal, cvTotal, calibrated: Math.round(root.scrollHeight)};
      }
    }
    repairing = false;
    stats.repairs.push({ms: Math.round(performance.now() - started), ...record});
    if (stats.repairs.length > 20) stats.repairs.shift();
    // 补的过程中若又丢了（连撤、或这一趟没覆盖到），接着补一轮
    if (countMissing()) scheduleRepair();
  };
  const scheduleRepair = () => {
    if (!enabled || repairing) return;
    if (!countMissing()) return;
    if (repairTimer) return;
    const mode = countMissing() > SMALL_REPAIR ? "full" : "few";
    repairTimer = setTimeout(() => {
      repairTimer = 0;
      // rIC 有 1.5s 兜底：不与打字抢主线程，但也不会永远拖下去
      if (typeof requestIdleCallback === "function") requestIdleCallback(() => repair(mode), {timeout: 1500});
      else repair(mode);
    }, 120);
  };

  // 启用本身是一次性成本（2576 块的量高 + 校准布局，实测 ~50ms）。撞上用户
  // 打字就会变成一次可感知的输入延迟，故要求"队列已清空 且 近 800ms 无输入"
  // 才启用；20s 超时兜底（长文档公式极多时不能无限等）。整段评估也放到首屏
  // 之后才起步：它不是首屏的一部分，而它自己的量高会在首屏之前强制重排。
  let lastInputAt = 0;
  const noteInput = () => { lastInputAt = performance.now(); };
  document.addEventListener("beforeinput", noteInput, true);
  document.addEventListener("keydown", noteInput, true);
  const evaluate = () => {
    if (enabled || document.hidden || root.childElementCount < THRESHOLD) return;
    const deadline = performance.now() + 20000;
    const attempt = () => {
      if (enabled) return;
      const pending = window.__typoraMathStats?.pending;
      const quiet = performance.now() - lastInputAt > 800;
      if ((!pending && quiet) || performance.now() > deadline) { enable(); return; }
      setTimeout(attempt, 300);
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(attempt, {timeout: 2000});
    } else {
      setTimeout(attempt, 200);
    }
  };
  // 首屏之前不做任何几何：这条路径的量高会强制整篇重排。
  afterPaint("large-doc-cv", () => { evaluate(); return true; });
  // 子节点被换掉时：没启用就先跑启用评估；已启用就看看是不是把估算值换丢了（见文件头 2026-09-16 那段）。
  // "子节点被换"既包括正常编辑重建的那一块（只丢它自己），也包括撤销/重做/setValue 的整篇恢复（全丢）。
  // 单向启用：一旦过阈值不回退（收益已建立，回退反而触发全量重排）。
  const observer = new MutationObserver(records => {
    if (!enabled) { evaluate(); return; }
    for (const record of records) {
      if (record.addedNodes.length) { scheduleRepair(); return; }
    }
  });
  observer.observe(root, {childList: true});
  return () => { observer.disconnect(); if (repairTimer) clearTimeout(repairTimer); };
};
