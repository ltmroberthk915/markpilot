import { createAsyncMarkdown } from './async-markdown.js';
// MarkPilot v3 引擎竖切（C1：CM6 文本基座）
//
// 宪法对位：
// - F5/F6（序列化类别消失）：文档就是 md 文本本身，无 doc↔md 转换层。
// - F7（视觉态/DOM 态分离）：行内公式用 Decoration.replace+widget 做「纯视觉投影」，
//   不编辑时显示 KaTeX 渲染，光标进入区间即还原源码——decoration 不改文档，零序列化残留。
// - 竖切改判门：①点公式→源码落位 ②IME 三通道（中文组字/英文/混排）绿。
// - 桥契约与 vditor 版同形（open/init/change/setValue），tab 壳与桥一行不改。

import { EditorState, EditorSelection, StateField, StateEffect, Transaction, Annotation, Prec, Compartment, Text } from "@codemirror/state";
import { EditorView, ViewPlugin, Decoration, WidgetType, keymap } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { undo, redo } from "@codemirror/commands";
import { StreamLanguage, LanguageDescription, LanguageSupport } from "@codemirror/language";
import { python } from "@codemirror/legacy-modes/mode/python";
import { javascript, json } from "@codemirror/legacy-modes/mode/javascript";
import { css } from "@codemirror/legacy-modes/mode/css";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { xml } from "@codemirror/legacy-modes/mode/xml";
// KaTeX 0.19.0 plus the maintained UTF-16 glyph/source mapping port. The
// generator pins upstream bytes and preserves expansion/own-property guards;
// CSS and fonts come from that same release. See tools/vendor/build-katex.cjs.
import "../renderer/vendor/katex/katex-sourcemap.js";
import "../renderer/vendor/katex/katex.min.css";
const katexApi = () => window.katex;
import { listSemantics } from "./lists.js";
import { markdownContext, codeBlockAt, blockAt, scanFencedBlocks, scanStructuralContext, structuralContextAt, codeBody, quoteLead } from './markdown-context.js';
import { breakParagraph as kpBreakParagraph, NO_BREAK_BEFORE, NO_BREAK_AFTER } from "./knuth-plass.js";
import { tableKeys, tableBlockOf, tableLead, isSeparatorBody, displayWidth, fitWidths, applyEnter, applyEnterBr, applyTab, setTableHint, isFenceAt } from "./tables.js";
import { mathCompletion } from "./completion.js";
import { horizontalFrame, localPoint, horizontalScrollbarHit } from './floating-layout.js';
import { previewFrame, PREVIEW_MAX_DISPLACEMENT, controlObstacles, textObstacles } from './overlay-layout.js';
import { createRegionIndex, regionAt, regionsBetween } from './region-index.js';
import { createRegionSession, activateRegion, retireRegion, expandRegionPayload } from './region-session.js';
import { containerContext, createContainerContextReader, bindContainer } from './container-presentation.js';
import { createRenderLifecycle } from './render-lifecycle.js';
import { createViewportIntent, scrollViewportBounds } from './viewport-intent.js';
import { createCommandContext, applySourceHistory } from './command-context.js';
import { editPlan, inlineCodeRanges, rangesTouching } from './edit-plan.js';
import { installToolbar, wrap as wrapInline, TOOLBAR_ACTIONS } from "./toolbar.js";
import { installExtras } from "./extras.js";
import { renderInline, inlineLinkSpans } from './inline-format.js';
import { fileUrlOfPath, resolveImageSource, hasImageCandidate } from './image-path.js';
import { imageInsertions, cancelImageInsertions } from './image-insertion.js';
import { mappedMathSource, mathSourcePosition } from './math-source-map.js';
import { mappedCellSource, cellSourceOffset, cellTextOffset, cellTextChange, encodeCellText } from './cell-source-map.js';
import { installSplit } from "./splitview.js";
import { editorFontVarsCss, editorHeadingsCss, editorContentMetricsCss, editorKaiRuleCss, editorKaiStyle, exportTypoCss } from "./typography.js";

/* ══ 数学渲染缓存层（W1×W2 交叉确认快赢包）══
 * 旧债三笔：① widgetCache 超 2000 条 clear() 雪崩（滚动回访全量重建）；
 * ② 每次重建都重新 KaTeX 解析（0.063ms/式 × 千式级滚动）；
 * ③ 块级 widget 无 estimatedHeight → 快滚高度抖动。
 * 新架构：widget LRU(256) 命中＝同实例复用 DOM；tex→HTML 串 LRU(1MB/512条)
 * 使淘汰后重建走 innerHTML 免解析；块高度记忆(128) 供 estimatedHeight 预留位。 */

const widgetCache = new Map(); // LRU（cap 256）：命中＝同实例 → CM6 eq 复用 DOM，零重建
const htmlCache = new Map(); // Bounded results, large enough for a formula-heavy viewport and its revisit.
const mathTemplates = new Map(); // Detached, content-only DOM; mounted nodes and leases are never cached here.
let mathTemplateBytes = 0;
const blockHeights = new Map(); // 块公式 tex → 实测高 px（cap 128，快滚高度记忆；只存稳态）
let mathGeometryVersion = 0;
const mathHeightKey = (tex,region) => `${mathGeometryVersion}:${region?.context.depth || 0}:${region?.context.indent || 0}:${tex}`;
let lastLiveHeight = -1, lastLiveHeightKey = ''; // Only the current live geometry may be reused.
let htmlBytes = 0;

function renderMathHTML(tex, display) {
  const key = (display ? "B" : "I") + tex;
  const hit = htmlCache.get(key);
  if (hit != null) { htmlCache.delete(key); htmlCache.set(key, hit); return hit; } // LRU touch
  let html;
  try { html = katexApi().renderToString(tex, { throwOnError: false, output: "html", displayMode: display, sourceMap: true, trust: false, maxExpand: 1000, maxSize: 20 }); }
  catch { return null; } // 解析失败：退原文，不缓存
  htmlCache.set(key, html);
  htmlBytes += key.length + html.length;
  for (const k of htmlCache.keys()) { // Map 迭代序＝插入序＝最旧先出
    if (htmlBytes <= 4_000_000 && htmlCache.size <= 1024) break;
    htmlBytes -= k.length + htmlCache.get(k).length;
    htmlCache.delete(k);
  }
  return html;
}
function renderMathDOM(span, tex, display) {
  const key = (display ? 'B' : 'I') + tex, cached = mathTemplates.get(key);
  if (cached) {
    mathTemplates.delete(key); mathTemplates.set(key, cached);
    span.appendChild(cached.template.content.cloneNode(true));
    return;
  }
  const html = renderMathHTML(tex, display);
  if (html === null) { span.textContent = tex; return; }
  const template = document.createElement('template'); template.innerHTML = html;
  span.appendChild(template.content.cloneNode(true));
  const bytes = key.length + html.length;
  if (bytes > 1_000_000) return;
  mathTemplates.set(key, { template, bytes }); mathTemplateBytes += bytes;
  while (mathTemplateBytes > 1_000_000 || mathTemplates.size > 128) {
    const oldest = mathTemplates.keys().next().value;
    mathTemplateBytes -= mathTemplates.get(oldest).bytes; mathTemplates.delete(oldest);
  }
}

function rememberBlockHeight(tex, span, live = false, region = null, lease = null) {
  const key = mathHeightKey(tex,region);
  requestAnimationFrame(() => {
    try {
      if (span.isConnected && (!lease || lease.valid()) && key === mathHeightKey(tex,region)) {
        const height = span.getBoundingClientRect().height;
        if (!Number.isFinite(height) || height <= 0) return;
        if (live) { lastLiveHeight = height; lastLiveHeightKey = mathHeightKey('',region) + ':' + region?.id; return; }
        // CM measures block DOMRects in viewport pixels, including CSS zoom.
        blockHeights.set(key, height);
        if (blockHeights.size > 128) blockHeights.delete(blockHeights.keys().next().value);
      }
    } catch { /* 未挂载则不记 */ }
  });
}

/* ══ mermaid：懒加载 ＋ 三层缓存 ＋ 块级投影（2026-10-11 接入）════════════════════════════
 * 【为什么是"懒加载 + 经典 script"，而不是 import】
 *  vendored 的 mermaid.min.js 是 esbuild 产物，收尾行是
 *  `globalThis["mermaid"] = globalThis.__esbuild_esm_mermaid_nm["mermaid"].default;`
 *  ——它依赖"经典脚本顶层 var 落全局对象"。**二次打包成 ESM 后那个 var 变成模块局部** ⇒
 *  收尾行读 undefined ⇒ **整个应用白屏**（已实测：`window.mpEngine` 始终 undefined ✗）。
 *  ⇒ 只能当经典脚本从 URL 加载。实测冷导入中位 94ms，**首屏增量 0**（首次遇到 mermaid 块才加载）✓。
 * 【URL 必须绝对·安全】引擎会把 `<base href>` 指向**当前文档所在目录**（见 mpSetDocPath）⇒
 *  任何相对路径都会解析到**用户文档目录**：既必然 404，又构成"用户目录放个同名 js 就会被执行"的注入面 ✗。
 *  所以从 `document.currentScript.src` 推 app 根，再拼绝对 URL ✓（与 base 无关 ✓）。
 * 【依赖不落地】本模块**内联实现了一个最小 Promise 队列**：编辑器启动时不需要任何自带依赖
 *  （离线构建装不了包），节点环境也跑得起来 ✓。
 * 【安全】securityLevel 固定 'strict'（loose 有两个真实 CVE；2.x 的 vditor 用的正是 loose ✗）；
 *  渲染前先 `parse` 再 `render`、且**传第三参容器**（不传的话失败会在 body 里留一个 d<id> 错误炸弹 ✗）。 */
const MP_APP_ROOT = (() => {
  try {
    const s = document.currentScript && document.currentScript.src;
    if (s) return s.replace(/[^/]*$/, '');            // 去掉文件名 ⇒ app 所在目录的绝对 URL
  } catch { /* 忽略 */ }
  try { return new URL('cm6/', document.baseURI).href; } catch { return ''; }   // 兜底（正常不会走到）
})();
const MERMAID_URL = MP_APP_ROOT ? MP_APP_ROOT + 'mermaid.min.js' : 'mermaid.min.js';
let mermaidLoading = null;
function loadMermaid(win) {
  if (win.mermaid) return Promise.resolve(win.mermaid);
  if (mermaidLoading) return mermaidLoading;
  mermaidLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = MERMAID_URL;                              // 绝对 URL，与 <base> 无关
    s.async = true;
    s.onload = () => {
      const mk = win.mermaid;
      if (!mk) { mermaidLoading = null; reject(new Error('mermaid 脚本加载完成但没有导出')); return; }
      mermaidApi = mk;
      applyMermaidTheme(mermaidTheme());
      resolve(mk);
    };
    s.onerror = () => { mermaidLoading = null; reject(new Error('mermaid 脚本加载失败：' + s.src)); };
    document.head.appendChild(s);
  });
  return mermaidLoading;
}
/** mermaid 主题白名单：本产品的主题 id 值域是任意的（telari-dark / github-dark / 护眼米黄…），
 *  而 mermaid **未知主题静默忽略**（实测回显错名但 themeVariables 不变 ✗）⇒ 必须自己收敛 ✓。 */
function mermaidTheme() {
  try {
    if (document.documentElement.dataset.mpDark === '1') return 'dark';
    const id = localStorage.getItem('editor-theme') || '';
    return /dark/i.test(id) ? 'dark' : 'default';
  } catch { return 'default'; }
}
/** 导出（HTML/文件夹/复制/PDF）用的图主题：**固定 `neutral`** ✓
 *  为什么不能跟随编辑器：导出件多半印在白纸上或贴进白底文章 ✓ ——
 *  暗色主题下渲出来的图是"暗色填充 + 白字" ✓，印在纸上就是一片黑块 ✗（2026-10-11 逐页验收实测 ✓）。
 *  为什么用 `neutral` 而不是 `default`：`default` 的甘特图 bar 是**很淡的米色** ✓，
 *  印在白纸上几乎看不见 ✗（实测逐页截图：甘特图淡到难以辨认 ✗）；
 *  `neutral` 是 mermaid 的**灰阶主题** ✓，节点/条形都是深灰 ⇒ 纸上对比度够 ✓，
 *  且与"白纸黑字"的导出基调一致 ✓（流程图/时序图也因此更清楚 ✓）。 */
function exportDiagramTheme() { return 'neutral'; }

/** 按主题重新 initialize（mermaid 的 `initialize` 是全局的 ✓，所以**每次渲染前按本次主题设一次** ✓）。
 *  为什么必须每次设：`initialize` 只在脚本加载时调一次 ✗ ⇒ 一旦要渲"导出用浅色"那份，
 *  编辑面那份就会被同一个全局主题带跑 ✗（两套 SVG 缓存并存的设计就失去意义 ✗）。 */
let mermaidApi = null;
function applyMermaidTheme(theme) {
  const mk = mermaidApi;
  if (!mk || typeof mk.initialize !== 'function') return false;
  try {
    mk.initialize({
      startOnLoad: false,
      securityLevel: 'strict',                      // 固定 strict：不许文档脚本执行
      theme,                                        // 未知主题会被静默忽略 ⇒ 我们自己收敛白名单
      fontFamily: mermaidFontFamily(),              // 不显式设 ⇒ 标签度量飘、高度缓存也飘
      flowchart: { useMaxWidth: true },
      sequence: { useMaxWidth: true },
      gantt: { useMaxWidth: true },
    });
    return true;
  } catch { return false; }                         // initialize 失败也让调用方继续（渲染时再报错）
}
function mermaidFontFamily() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--mp-font-body').trim();
    if (v) return v;
  } catch { /* 忽略 */ }
  return 'system-ui, sans-serif';
}
/* 三层缓存：① svgCache（key = 主题|源码 ⇒ {svg,w,h}，回填 0.3ms vs 重渲染 13.6ms ＝ 45× ✓）
 *          ② widgetCache（MermaidWidget 实例，LRU 128 ⇒ 命中连回填都省了 ✓）
 *          ③ heightCache（key = 主题|宽度桶|源码 ⇒ estimatedHeight，防快滚高度抖动 ✓） */
const svgCache = new Map();
const SVG_CACHE_MAX = 64;
/** 【同一源码只渲染一次·2026-10-11 实测修正】两处**逐字节相同**的图表首次出现时是**并发**的
 *  （同一帧里两个 widget 都 miss ⇒ 都入队 ⇒ 渲染两遍 ✗，实测 `累计渲染完成 3` 而唯一源码只有 2 ✓）。
 *  ⇒ 用"进行中"表去重：后来的请求**复用同一个 Promise** ✓；顺带给出**确定性 id** ✓ ——
 *  mermaid 把 `<style>` 的作用域写成 `#<id>`，同一个源码两次渲染拿到不同 id ⇒ 缓存回填的那一份
 *  **样式对不上**（实测第一块高 291px、同样内容的第三块 386px ✗）。内容哈希 id 一并解决它 ✓。 */
const svgInflight = new Map();
/* 失败记录（源码 → 原始错误文本）：只给取证用 ✓ —— 失败态**不进 svg 缓存** ✗，
   而"哪些图型能渲/不能渲"要靠它精确回答（屏幕文案只能靠肉眼对位置 ✗）。上限 32 条，LRU。 */
const mermaidErrors = new Map();
function hash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
}
const mermaidWidgetCache = new Map();
const mermaidHeights = new Map();
const MERMAID_HEIGHT_MAX = 128;
const mermaidQueue = [];
let mermaidRunning = false;
let mermaidPending = 0;
let mermaidDone = 0;
function svgKey(src, theme) { return theme + '|' + src; }
function widthBucket(px) { return Math.max(160, Math.round(px / 80) * 80); }
function heightKey(src, theme, w) { return theme + '|' + widthBucket(w) + '|' + src; }
function pumpMermaid() {
  if (mermaidRunning || !mermaidQueue.length) return;
  mermaidRunning = true;
  const job = mermaidQueue.shift();
  // Rendering belongs to the shared job, not the first consuming mount. A
  // detached widget must not poison a still-valid duplicate consumer's render.
  const holder = job.holder = document.createElement('div');
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:absolute;left:-10000px;top:0;width:900px;visibility:hidden;pointer-events:none';
  document.body.appendChild(holder);
  loadMermaid(window).then((mk) => {
    /* 【每次渲染前按本次主题重设·2026-10-11】mermaid 的 `initialize` 是**全局**的 ✗，
       只在脚本加载时调一次的话，"导出用浅色/中性"与"编辑面跟随主题"两套 SVG 会互相带跑 ✗
       ⇒ 这里按 `job.theme` 再设一次 ✓（队列是串行的 ✓，不会两套主题同时渲 ✓）。 */
    applyMermaidTheme(job.theme);
    /* 【顺序纪律】先 parse 再 render（照 VS Code 的做法 ✓）：坏语法在 parse 阶段就被挡下，
       不会进 render ⇒ **body 里不会留下 d<id> 错误炸弹** ✓（实测：直接 render 坏语法会残留 ✗）。 */
    return Promise.resolve(mk.parse(job.src)).then(() => mk.render(job.id, job.src, job.holder));
  }).then(
    (out) => { job.ok(out && out.svg ? out.svg : ''); },
    (err) => { job.ok('', (err && (err.message || err.str)) || String(err)); },
  ).catch((e) => { job.ok('', String((e && e.message) || e)); })
    .then(() => { holder.remove(); mermaidRunning = false; mermaidDone += 1; pumpMermaid(); });
}
function requestMermaid(src, theme, holder, cb) {
  const key = svgKey(src, theme);
  const hit = svgCache.get(key);
  if (hit && hit.svg) { cb(hit.svg); return; }                 // 命中缓存：0 解析 ✓
  const busy = svgInflight.get(key);
  if (busy) { busy.then((svg) => { try { cb(svg); } catch { /* 忽略 */ } }).catch(() => { try { cb('', '渲染失败'); } catch { /* 忽略 */ } }); return; }   // 同一源码并发 ⇒ 复用同一次渲染 ✓
  mermaidPending += 1;
  const job = {
    src, theme, holder,
    id: 'mpm' + hash32(key),                                   // 确定性 id：同源码同 id ⇒ style 作用域与缓存一致 ✓
    ok: null,
  };
  const p = new Promise((resolve) => {
    job.ok = (svg, err) => {
      mermaidPending -= 1;
      svgInflight.delete(key);
      if (svg) {
        const s = svgCache.get(key);
        if (!s) { svgCache.set(key, { svg }); if (svgCache.size > SVG_CACHE_MAX) svgCache.delete(svgCache.keys().next().value); }
      }
      resolve({ svg: svg || '', err: err || null });
    };
  });
  svgInflight.set(key, p.then((r) => r.svg));
  mermaidQueue.push(job);
  pumpMermaid();
  /* cb 用 try/catch 包住：回填回调里抛错不许把队列或 Promise 链带崩（promise 链是共享的 ✓）。 */
  p.then((r) => { try { cb(r.svg, r.err); } catch { /* 回填失败不影响别人 */ } })
    .catch(() => { try { cb('', '渲染失败'); } catch { /* 同上 */ } });
}
function mermaidWidget(src, from, to, region = null) {
  const theme = mermaidTheme();
  const key = theme + '|' + from + '|' + to + '|' + region?.id + '|' + region?.contextVersion + '|' + src;
  let w = mermaidWidgetCache.get(key);
  if (w) { mermaidWidgetCache.delete(key); mermaidWidgetCache.set(key, w); return w; }   // LRU touch
  w = new MermaidWidget(src, from, to, theme, region);
  mermaidWidgetCache.set(key, w);
  if (mermaidWidgetCache.size > 128) mermaidWidgetCache.delete(mermaidWidgetCache.keys().next().value);
  return w;
}
class MermaidWidget extends WidgetType {
  constructor(src, from, to, theme, region) { super(); this.src = src; this.from = from; this.to = to; this.theme = theme; this.region = region; }
  /* eq() 必须比**全部影响渲染的字段**（错-11：只比一项＝给"复用陈旧 DOM"开门）：
     源码 ✓ 主题 ✓ 位置 ✓（位置烘进了 dataset 与缓存 key）。 */
  eq(other) { return other.src === this.src && other.theme === this.theme && other.from === this.from && other.to === this.to
    && other.region?.id === this.region?.id && other.region?.contextVersion === this.region?.contextVersion; }
  toDOM(view) {
    const box = document.createElement('div');
    box.className = 'mp-mermaid';
    const region = this.region && view.state.field(regionIndexField).byId.get(this.region.id);
    if (region) { box.dataset.mpRegion = region.id; bindContainer(box, region.context); }
    const lease = region ? rendererLifecycle.mount(view, region, box) : null;
    box.dataset.mpMermaid = svgKey(this.src, this.theme);
    const hit = svgCache.get(box.dataset.mpMermaid);
    if (hit && hit.svg) box.innerHTML = hit.svg;
    else box.textContent = 'mermaid 图表（渲染中…）';
    /* 【容器必须"不可见但可量"·2026-10-11 实测】一开始用 `display:none` 藏它 ✗ ⇒
       flowchart 渲染**必然失败**：`Could not find a suitable point for the given distance` ✗
       （mermaid 的边路由要在**有布局的**容器里量节点坐标 ✓；`display:none` 下全量成 0 ✗）。
       时序图不量节点坐标 ⇒ 那时只有它"侥幸"能渲染 ✓（正是它暴露了这个差异）。
       正确做法：离屏 + `visibility:hidden`（**仍有布局** ✓），尺寸给足 ✓。 */
    /* 【图内链接不许把编辑窗口导航走·2026-10-11】mermaid 生成的 `<a>` 没有 target（strict 档也不加 ✓），
       点在编辑面上会**把整个编辑窗口导航到那个网址** ✗（实测静态扫描：本仓无 will-navigate /
       setWindowOpenHandler 守卫 ✗）⇒ 这里拦下点击、交给宿主的外部浏览器通道 ✓（壳侧有 openExternal ✓）。
       捕获阶段拦：mermaid 自己的 click 处理器在 loose 档才绑（我们固定 strict ⇒ 不会抢 ✓）。 */
    box.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a') : null;
      if (!a) return;
      e.preventDefault(); e.stopPropagation();
      const href = a.getAttribute('xlink:href') || a.getAttribute('href') || '';
      try {
        if (window.mpHost && typeof window.mpHost.openExternal === 'function') window.mpHost.openExternal(href);
        else if (/^https?:/i.test(href)) window.open(href, '_blank', 'noopener');
      } catch { /* 打开失败就什么都不做（绝不回退到"让窗口自己导航" ✗） */ }
    }, true);
    if (hit?.svg) return box;
    requestMermaid(this.src, this.theme, null, (svg, err) => {
      if (lease && !lease.valid()) return;
      if (box.dataset.mpMermaid !== svgKey(this.src, this.theme)) return;   // 过期结果直接丢 ✓
      if (svg) {
        box.innerHTML = svg;                                             // 直接改已挂载 DOM：**不 dispatch** ⇒ 打字路径零成本 ✓
        try {
          const w = box.clientWidth || 0, h = box.offsetHeight || 0;
          if (w > 0 && h > 0) {
            const k = heightKey(this.src, this.theme, w);
            mermaidHeights.set(k, h);
            if (mermaidHeights.size > MERMAID_HEIGHT_MAX) mermaidHeights.delete(mermaidHeights.keys().next().value);
          }
        } catch { /* 量不到就算了 */ }
      } else {
        box.textContent = 'mermaid 渲染失败：' + String(err || '未知错误').slice(0, 300);
        /* 【取证·2026-10-11】失败时把源码→错误文本记一份（**只读通道**，不改渲染行为 ✓）：
           图型普查要回答"哪些图型能渲、不能渲的原始错误是什么"，而失败态**不进 svg 缓存** ✗
           ⇒ 探针只能靠屏幕上的文案；记进一张小表就能按源码精确查到错误 ✓（上限 32 条）。 */
        try {
          mermaidErrors.set(this.src, String(err || '未知错误').slice(0, 300));
          if (mermaidErrors.size > 32) mermaidErrors.delete(mermaidErrors.keys().next().value);
        } catch { /* 取证失败不影响渲染 */ }
      }
      view.requestMeasure();
    });
    return box;
  }
  /* CM6 契约：estimatedHeight 必须是数值；-1＝无估计（基类哨兵）。**绝不下发 undefined** ✗
     （既有实测：undefined 让高度图算出 NaN，构造期 viewport 直接崩 ✗）。 */
  get estimatedHeight() {
    const s = mermaidHeights.get(heightKey(this.src, this.theme, (typeof mermaidWidthHint === 'number' ? mermaidWidthHint : 800)));
    return typeof s === 'number' && s > 0 ? s : -1;
  }
  ignoreEvent() { return false; }                                        // 让链接点击能被我们拦下
  destroy(dom) { rendererLifecycle.release(dom); }
}
let mermaidWidthHint = 800;                                              // 由装饰层在量到容器宽时更新（桶内稳定）
function scanMermaidBlocks(doc, blocks = scanFencedBlocks(doc)) {
  return blocks.filter(b => /^mermaid$/i.test(b.info) && b.closeFrom != null).map(b => {
    const parts = [];
    for (let n = b.startLine + 1; n < b.endLine; n++) parts.push(codeBody(doc.line(n).text, b).text);
    return { from: b.from, to: b.to, src: parts.join('\n'), lang: 'mermaid' };
  });
}
const mermaidBlocksField = StateField.define({
  create(state) { mmScanCount++; return scanMermaidBlocks(state.doc, state.field(markdownContext).blocks); },
  update(value, tr) {
    mmUpdateCount++;
    if (!tr.docChanged) return value;
    const context = tr.state.field(markdownContext);
    if (!context.rebuilt && tr.state.field(editPlan)) {
      const touched = new Set();
      tr.changes.iterChangedRanges((from, to) => { for (const b of rangesTouching(value, from, to)) touched.add(b); });
      return value.map(b => {
        const mapped = { ...b, from: tr.changes.mapPos(b.from, 1), to: tr.changes.mapPos(b.to, -1) };
        if (!touched.has(b)) return mapped;
        mmScanCount++;
        return scanMermaidBlocks(tr.state.doc, [blockAt(context.blocks, mapped.from)])[0] || mapped;
      });
    }
    let touched = context.rebuilt;
    tr.changes.iterChangedRanges((from, to) => {
      if (value.some(b => from <= b.to && to >= b.from)) touched = true;
    });
    if (touched) { mmScanCount++; return scanMermaidBlocks(tr.state.doc, context.blocks); }
    return value.map(b => ({ ...b, from: tr.changes.mapPos(b.from, 1), to: tr.changes.mapPos(b.to, 1) }));
  },
});
/* 取证计数（排障"字段到底有没有重算"；也是"每键成本"的自证：正文打字时 updateCount 涨、scanCount 不涨 ✓） */
let mmUpdateCount = 0, mmScanCount = 0;
/** 块级投影：光标在块内 ⇒ 不替换（显源码 ✓）；否则整块替换成图表 ✓。
 *  与 blockMathField 同构（StateField 直供 + estimatedHeight 是 CM6 官方唯一受支持的块级形态 ✓）。 */
function buildMermaidDecorations(state) {
  const out = [];
  const head = state.selection.main.head;
  for (const b of state.field(mermaidBlocksField, false) || []) {
    if (state.field(regionSessionField).presentation.get(regionAt(state.field(regionIndexField),b.from,'mermaid')?.id)?.editing) continue;
    out.push(Decoration.replace({ widget: mermaidWidget(b.src, b.from, b.to,
      regionAt(state.field(regionIndexField), b.from, 'mermaid')), block: true }).range(b.from, b.to));
  }
  return Decoration.set(out, true);
}
const mermaidDecorations = StateField.define({
  create: buildMermaidDecorations,
  update(value, tr) {
    if (!tr.docChanged && !tr.selection && tr.startState.field(regionIndexField) === tr.state.field(regionIndexField)) return value;
    return buildMermaidDecorations(tr.state);
  },
  provide: f => EditorView.decorations.from(f),
});

// Each export owns its SVG results until its writer finishes. The viewport LRU
// remains bounded independently and cannot evict an earlier exported diagram.
window.mpMermaid = {
  /** Render through the shared queue; the caller releases svgs in finally. */
  async prerender(md) {
    const blocks = scanMermaidBlocks(Text.of(String(md || '').split('\n'))).map(b => b.src).filter(s => s.trim());
    /* 【导出应当用**浅色主题**渲图·2026-10-11 逐页验收实测缺陷】
       原先导出走 `mermaidTheme()`（跟随编辑器深/浅色）✗ ⇒ 暗色主题下导出的 PDF/HTML 里
       图是**暗色填充 + 白字** ✓ —— 屏幕上没问题，**印在白纸上就是一片黑块** ✗
       （实测：白纸、黑标题、正文清晰 ✓，唯独流程图节点是近黑块 ✗，很别扭）。
       ⇒ 导出与打印同口径用**浅色** ✓（与壳层 PRINT_CSS 的"白纸黑字"一致 ✓）；
         编辑面仍跟随主题 ✓（缓存键含主题 ⇒ 两套 SVG 并存，互不干扰 ✓）。 */
    const expTheme = exportDiagramTheme();
    const svgs = new Map(), counts = new Map(), todo = [];
    for (const src of blocks) counts.set(src, (counts.get(src) || 0) + 1);
    let bytes = 0, 成功 = 0;
    const 失败 = [], maxBytes = 32 * 1024 * 1024;
    const retain = (src, svg) => {
      // Bound the operation set, without enlarging the permanent viewport cache.
      if (svg.length > maxBytes - bytes) throw new Error('导出图表超过 32 MB，请拆分文档');
      const size = new TextEncoder().encode(svg).byteLength;
      if (size > maxBytes - bytes) throw new Error('导出图表超过 32 MB，请拆分文档');
      bytes += size; svgs.set(src, svg); 成功 += counts.get(src);
    };
    try {
      // Retain all warm hits before a newly rendered block can evict them.
      for (const src of counts.keys()) {
        const hit = svgCache.get(svgKey(src, expTheme));
        if (hit?.svg) retain(src, hit.svg); else todo.push(src);
      }
      for (const src of todo) {
        const r = await new Promise(resolve => requestMermaid(src, expTheme, null, (svg, err) => resolve({ svg, err })));
        if (r.svg) retain(src, r.svg);
        else 失败.push({ src: src.slice(0, 40), err: String((r.err || '').slice(0, 120)) });
      }
      return { 总数: blocks.length, 成功, 失败, 主题: expTheme, bytes, svgs };
    } catch (error) { svgs.clear(); throw error; }
  },
  /** 同步取缓存（导出生成器用；未命中返回 null ⇒ 调用方退回 <pre><code> ✓）
   *  【导出取的是**浅色**那份 ✓】与 prerender 同一口径 ✓：先查导出主题，再退回当前主题 ✓
   *  （后者只在"导出主题那份没渲出来"时兜底，避免整块退化成源码 ✗）。 */
  getSvg(src) {
    const hit = svgCache.get(svgKey(src, exportDiagramTheme())) || svgCache.get(svgKey(src, mermaidTheme()));
    return hit && hit.svg ? hit.svg : null;
  },
  /** 取证：该源码上一次渲染失败的原始错误（成功或没试过 ⇒ null）。图型普查用 ✓ */
  getError(src) { const e = mermaidErrors.get(src); return e == null ? null : e; },
  /** 取证：失败清单快照（源码首行 + 错误前 160 字） */
  errors() { return [...mermaidErrors.entries()].map(([src, err]) => ({ 源码首行: String(src).split('\n')[0].slice(0, 40), 错误: String(err).slice(0, 160) })); },
  /** 诊断（探针用）：块数/缓存规模/字段计数 */
  stat() { return { svg缓存条数: svgCache.size, widget缓存条数: mermaidWidgetCache.size, 高度缓存条数: mermaidHeights.size, 队列中: mermaidQueue.length, 累计渲染完成: mermaidDone, 字段update次数: mmUpdateCount, 字段重扫次数: mmScanCount, 脚本已加载: !!window.mermaid, 脚本URL: MERMAID_URL }; },
};

function mathWidget(tex, display, live = false, selected = false, region = null) {
  const key = (live ? "L" : display ? "B" : "I") + (selected ? "S" : "") + region?.id + ':' + region?.contextVersion + ':' + tex;
  let w = widgetCache.get(key);
  if (w) { widgetCache.delete(key); widgetCache.set(key, w); return w; } // LRU touch
  w = new MathPreview(tex, display, live, selected, region);
  widgetCache.set(key, w);
  if (widgetCache.size > 256) widgetCache.delete(widgetCache.keys().next().value);
  return w;
}

class MathPreview extends WidgetType {
  constructor(tex, display = false, live = false, selected = false, region = null) { super(); this.tex = tex; this.display = display; this.live = live; this.selected = selected; this.region = region; }
  eq(other) { return other.tex === this.tex && other.display === this.display && other.live === this.live && other.selected === this.selected
    && other.region?.id === this.region?.id && other.region?.contextVersion === this.region?.contextVersion; }
  toDOM(inputView) {
    const span = document.createElement("span");
    span.className = this.live && !this.display ? "mp-cm6-math-live-chip"
      : this.live ? "mp-cm6-math-block mp-cm6-math-live"
      : this.display ? "mp-cm6-math-block" : "mp-cm6-math";
    // 【选区态·2026-10-07】公式落在选区里但**光标不在其中**时保持渲染，只加选中底色
    // （原生 ::selection 盖不到 widget 内部字形，必须自带类；色值走主题变量，不写死）。
    if (this.selected) span.className += " mp-math-selected";
    if (this.region) {
      const region = inputView.state.field(regionIndexField).byId.get(this.region.id);
      if (region) { span.dataset.mpRegion = region.id; bindContainer(span, region.context, this.display); }
    }
    const lease = this.region ? rendererLifecycle.mount(inputView,this.region,span) : null;
    renderMathDOM(span, this.tex, this.display);
    if (!this.display && !this.live) rememberInlineMathMetrics(inputView, this.region, span);
    if (this.display) rememberBlockHeight(this.tex, span, this.live,this.region,lease);
    return span;
  }
  // CM6 契约：estimatedHeight 是数值，-1＝无估计（基类哨兵）；绝不下发 undefined
  //（复核实锤：undefined 使高度图 n<0 判false → NaN → 构造期 viewport 崩）。
  // live 中间态 tex 恒 miss 稳态表 → 回退上一 live 高度（防编辑期间下方内容每键跳）。
  get estimatedHeight() {
    if (!this.display && !this.live) return -1;
    const h = blockHeights.get(mathHeightKey(this.tex,this.region));
    if (h !== undefined) return h;
    return this.live && lastLiveHeight > 0 && lastLiveHeightKey === mathHeightKey('',this.region) + ':' + this.region?.id ? lastLiveHeight : -1;
  }
  ignoreEvent() { return false; } // 点击交给 view → 源码落位
  destroy(dom) { rendererLifecycle.release(dom); }
}

// KaTeX already supplies ascent/depth in em. Keep that region's last rendered
// metrics while its source is open, without reading layout or cloning glyphs.
const inlineMathMetrics = new Map();
function inlineMetricKey(inputView, region) {
  return region ? inputView.state.field(regionIndexField).epoch + ':' + region.id : null;
}
function rememberInlineMathMetrics(inputView, region, dom) {
  const key = inlineMetricKey(inputView, region);
  if (!key) return null;
  let ascent = 0, depth = 0, found = false;
  for (const strut of dom.querySelectorAll('.katex-html > .katex-base > .katex-strut, .katex-html > .base > .strut')) {
    if (!strut.style.height.endsWith('em')) continue;
    const height = parseFloat(strut.style.height), below = -(parseFloat(strut.style.verticalAlign) || 0);
    if (!Number.isFinite(height) || !Number.isFinite(below)) continue;
    ascent = Math.max(ascent, height - below); depth = Math.max(depth, below); found = true;
  }
  if (!found) { inlineMathMetrics.delete(key); return null; }
  const metrics = { ascent, depth };
  inlineMathMetrics.delete(key); inlineMathMetrics.set(key, metrics);
  if (inlineMathMetrics.size > 256) inlineMathMetrics.delete(inlineMathMetrics.keys().next().value);
  return metrics;
}
class InlineMathSpace extends WidgetType {
  constructor(tex, region, epoch) {
    super(); this.tex = tex; this.region = region; this.epoch = epoch;
    this.metrics = inlineMathMetrics.get(epoch + ':' + region?.id);
  }
  eq(other) {
    return other.epoch === this.epoch && other.region?.id === this.region?.id &&
      other.region?.contextVersion === this.region?.contextVersion &&
      (this.metrics && other.metrics ? this.metrics.ascent === other.metrics.ascent && this.metrics.depth === other.metrics.depth : other.tex === this.tex);
  }
  toDOM(inputView) {
    if (!this.metrics) {
      const rendered = document.createElement('span'), html = renderMathHTML(this.tex, false);
      if (html) rendered.innerHTML = html;
      this.metrics = rememberInlineMathMetrics(inputView, this.region, rendered);
    }
    const space = document.createElement('span');
    space.className = 'katex mp-inline-math-space'; space.setAttribute('aria-hidden', 'true');
    if (this.metrics) {
      space.style.height = (this.metrics.ascent + this.metrics.depth) + 'em';
      space.style.verticalAlign = -this.metrics.depth + 'em';
    }
    return space;
  }
  ignoreEvent() { return true; }
}

/* ══ 引擎级偏好（版心宽度 / 内容缩放 / 工具岛尺寸 / 状态栏）═════════════════════════
 *  为什么不用宿主 webFrame.setZoomLevel：那个缩放是**整页**的（工具栏、浮层、状态栏、固定定位
 *  全部一起变），用户要的正好相反——内容区缩放、工具岛大小独立。做法是把缩放放在
 *  **包着 .cm-editor 的普通 div** 上（CSS `zoom`），工具栏挂在 body 上、天然在缩放盒之外。
 *  `zoom` 的实测语义（`.mp-verify\v304\probe-zoom-measure.mjs`）：
 *    · 被缩放元素**自己**的 rect 宽高读出来仍是未缩放的 CSS 像素 ⇒ CM6 的高度图/命中测试坐标自洽；
 *    · `width:100%` 之类的百分比按**未缩放**的父盒解析（1400 的盒在 1.5 档出 2100 视觉像素）；
 *    · 因此"版心视觉宽度 = 视口 × 百分比"必须写成 `视口 × 百分比 ÷ 缩放`。
 *  性能：只有窗口 resize 才重算版心（rAF 合并）；打字路径上一个字节都没加。 */
const MP_PREFS = [
  { id: "pageWidth", def: 74, min: 40, max: 100 },   // 版心：占窗口宽的百分比（默认贴合 Typora 观感）
  { id: "zoom", def: 100, min: 50, max: 300 },       // 内容缩放（%）
  { id: "island", def: 100, min: 80, max: 140 },     // 工具岛尺寸（%），与缩放互不影响
  { id: "statusbar", def: 1, min: 0, max: 1 },       // 底部状态栏开关
  { id: "floatAvoidance", def: 1, min: 0, max: 1 }, // 公式预渲染框就近避让
];
const mpPref = (id) => {
  const spec = MP_PREFS.find((p) => p.id === id) || { def: 100, min: 0, max: 1e9 };
  try {
    const raw = localStorage.getItem("mp-pref-" + id);
    const v = raw == null || raw === "" ? NaN : Number(raw);
    return Number.isFinite(v) ? Math.min(spec.max, Math.max(spec.min, v)) : spec.def;
  } catch { return spec.def; }
};
const mpSetPref = (id, v) => {
  const spec = MP_PREFS.find((p) => p.id === id);
  if (!spec) return;
  const n = Math.min(spec.max, Math.max(spec.min, Number(v)));
  if (!Number.isFinite(n)) return;
  try { localStorage.setItem("mp-pref-" + id, String(n)); } catch { /* 无存储 */ }
  if (id === 'floatAvoidance') applyFloatPreference();
  else applyEnginePrefs();
  mpPrefNotify([id]);
};
const mpPrefsAll = () => { const o = {}; for (const p of MP_PREFS) o[p.id] = mpPref(p.id); return o; };
/** 【订阅·2026-10-06】偏好变化的**唯一广播口**：设置面板滑杆、状态栏数字口、`Ctrl+=/-/0`、
 *  `Ctrl+滚轮`、菜单里的不透明度滑杆——**任何一处改值都从这里出去**；订阅者（设置面板）据此刷新自己的
 *  显示，于是"改一处、其余几处立即同步"成立（用户报障的另一半：面板数字不动）。
 *  「不重开应用即生效」也由这条保证：改值 → applyEnginePrefs()（写 CSS 变量 + rAF 算版心）→ 广播。 */
const mpPrefSubs = new Set();
const mpPrefSubscribe = (fn) => { try { mpPrefSubs.add(fn); } catch { /* 忽略 */ } return () => { try { mpPrefSubs.delete(fn); } catch { /* 忽略 */ } }; };
function mpPrefNotify(ids) {
  const snap = mpPrefsAll();
  for (const fn of [...mpPrefSubs]) { try { fn(snap, ids); } catch (err) { console.error("[mp] prefs 订阅者异常：", err); } }
}
window.mpPrefs = { get: mpPrefsAll, set: mpSetPref, subscribe: mpPrefSubscribe, notify: mpPrefNotify };
let mpPageRaf = 0;
/** 写三个 token：内容缩放 → zoomWrap；岛尺寸 → --mp-island-scale；版心 → --mp-page-width。
 *  版心必须等布局稳定后量宽（clientWidth），所以这里只排队，真正写值在算宽函数里。 */
function applyEnginePrefs() {
  mathGeometryVersion++; window.mpEngine?.commands.geometryIntent();
  const root = document.documentElement;
  const p = mpPrefsAll();
  root.style.setProperty("--mp-island-scale", (p.island / 100).toFixed(3));
  root.style.setProperty("--mp-zoom", (p.zoom / 100).toFixed(4));
  root.dataset.mpStatusbar = p.statusbar ? "1" : "0";
  if (zoomWrap) zoomWrap.style.setProperty("--mp-zoom", (p.zoom / 100).toFixed(4));
  schedulePageWidth();
  applyFloatPreference();
}
function schedulePageWidth() {
  if (mpPageRaf) return;
  mpPageRaf = requestAnimationFrame(() => { mpPageRaf = 0; mpApplyPageWidth(); });
}
function mpApplyPageWidth() {
  const root = document.documentElement;
  const pct = mpPref("pageWidth") / 100;
  const z = mpPref("zoom") / 100;
  const vw = Math.max(320, root.clientWidth || window.innerWidth || 1200);
  /* 口径：滑杆说的是**视觉**宽度＝窗口宽 × 百分比。
     `zoom` 的百分比按**未缩放**父盒解析（实测 1400 的盒在 1.5 档出 2100 视觉像素），
     所以文档坐标里的宽度要除以缩放，最终视觉宽度才等于滑杆值。 */
  const docPx = Math.round((vw * pct) / z);
  const width = docPx + "px";
  if (root.style.getPropertyValue("--mp-page-width") !== width) {
    mathGeometryVersion++;
    root.style.setProperty("--mp-page-width", width);
  }
}
/** 缩放外壳：`#editor` 的父级。工具栏/状态栏挂在 body 上 ⇒ 永远在缩放盒外（这就是"解耦"）。 */
let zoomWrap = null;
function installZoomWrap() {
  const host = document.getElementById("editor");
  if (!host || !host.parentNode) return null;
  const wrap = document.createElement("div");
  wrap.className = "mp-zoom-wrap";
  host.parentNode.insertBefore(wrap, host);
  wrap.appendChild(host);
  wrap.style.setProperty("--mp-zoom", (mpPref("zoom") / 100).toFixed(4));
  zoomWrap = wrap;
  return wrap;
}
try {
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => schedulePageWidth()).observe(document.documentElement);
} catch { /* 无 RO：resize 兜底 */ }
window.addEventListener("resize", schedulePageWidth);

/** ── 内容缩放 API（Ctrl+= / Ctrl+- / Ctrl+0 / Ctrl+滚轮 / 状态栏输入口 共用）─────────
 *  语义以 Typora 为准：步长 10%、范围 50–300%、Ctrl+0 回 100%、结果持久化。 */
/* 【步进 5%·2026-10-09 用户要求】改前 10%：Ctrl+滚轮一档跳太多，细调够不着。键盘 Ctrl+=/- 与它同步。 */
const MP_ZOOM_STEP = 5;
function mpZoomTo(v, why) {
  const next = Math.min(300, Math.max(50, Math.round(Number(v))));
  if (!Number.isFinite(next)) return mpPref("zoom");
  try { localStorage.setItem("mp-pref-zoom", String(next)); } catch { /* 无存储 */ }
  applyEnginePrefs();
  syncZoomBadges(next);
  if (why) toastZoom(next);
  return next;
}
const mpZoomBy = (d) => mpZoomTo(mpPref("zoom") + d, true);
/** 状态栏数字口与设置面板滑杆是同一个值的两个视图：这里把两边都刷成同一个数。 */
function syncZoomBadges(v) {
  const pct = String(v) + "%";
  const inp = document.getElementById("mp-status-zoom");
  if (inp && document.activeElement !== inp) inp.value = String(v);
  const badge = document.querySelector(".mp-zoom-badge");
  if (badge) badge.textContent = pct;
  const pane = document.getElementById("mp-set-zoom");
  if (pane && document.activeElement !== pane) pane.value = String(v);
  const lab = document.getElementById("mp-set-zoom-label");
  if (lab) lab.textContent = pct;
}
let zoomToastTimer = 0;
function toastZoom(v) {
  const badge = document.querySelector(".mp-zoom-badge");
  if (!badge) return;
  badge.textContent = v + "%";
  badge.classList.add("is-live");
  clearTimeout(zoomToastTimer);
  zoomToastTimer = setTimeout(() => badge.classList.remove("is-live"), 900);
}
/** 快捷键缩放：CM6 键位（与工具栏/表格命令同一条事务纪律）。 */
const zoomKeys = Prec.high(keymap.of([
  {
    key: "Mod-=", preventDefault: true,
    run: () => { mpZoomBy(MP_ZOOM_STEP); return true; },
  },
  {
    key: "Mod--", preventDefault: true,
    run: () => { mpZoomBy(-MP_ZOOM_STEP); return true; },
  },
  {
    key: "Mod-0", preventDefault: true,
    run: () => { mpZoomTo(100, true); return true; },
  },
]));
window.mpZoom = { get: () => mpPref("zoom"), set: mpZoomTo, by: mpZoomBy, reset: () => mpZoomTo(100, true) };

/* ── 底部状态栏（v2.3.3 观感；性能口径：**零每键 DOM 操作**）──────────────────────
 *  架构与「行内标记」「表格投影」同一条纪律：数据源只有两样——文档**长度**与选区**主位置**；
 *  两者任一不变就一个字节都不碰。因此：
 *    · update() 里先做两个数字的相等判断（O(1)），不等才 touched() 重算文本；
 *    · 只写 textContent / value（不 innerHTML、不建节点、不读布局）——打字时每键一次比较而非一次重建；
 *    · 缩放输入口是**用户操作**才读 value（Enter/失焦），不在键入路径上；输入框自身按 Esc 还原。 */
function buildStatusBar() {
  const bar = document.createElement("div");
  bar.className = "mp-statusbar";
  bar.innerHTML = '<span class="mp-sb-item mp-sb-pos"></span>'
    + '<span class="mp-sb-item mp-sb-sel"></span>'
    + '<span class="mp-sb-item mp-sb-count"></span>'
    + '<span class="mp-sb-spacer"></span>'
    + '<span class="mp-sb-item mp-sb-brand" title="MarkPilot">MarkPilot</span>'
    + '<span class="mp-sb-zoomwrap" title="内容缩放（Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 重置）">'
    + '<span class="mp-zoom-badge">100%</span>'
    + '<input id="mp-status-zoom" class="mp-sb-zoom-input" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" value="100" aria-label="缩放百分比（输入数字后回车）">'
    + '<span class="mp-sb-pct">%</span></span>';
  document.body.appendChild(bar);
  const inp = bar.querySelector(".mp-sb-zoom-input");
  const commit = () => {
    const v = Number(String(inp.value).replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(v) || v <= 0) { inp.value = String(mpPref("zoom")); return; }
    mpZoomTo(v, true);
  };
  inp.addEventListener("keydown", (e) => {
    /* 【#50·2026-10-18 实测缺陷 M4】IME 组字中的 Enter/Esc 是"上屏/取消候选"，不是提交：
       改前不查 isComposing ⇒ 用中文/数字输入法按回车上屏时提前提交（实测组字 "12" 叠进 100
       得到 12100、回车直接提交成 300% 并 blur）。与搜索框（extras.js:165）同口径。 */
    if (e.isComposing || e.keyCode === 229) return;
    // 只认 Enter / Esc；其余按键留给浏览器（不改文档、不冒泡到编辑器快捷键）
    if (e.key === "Enter") { e.preventDefault(); commit(); inp.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); inp.value = String(mpPref("zoom")); inp.blur(); }
    e.stopPropagation();
  });
  inp.addEventListener("blur", () => { commit(); bar.classList.remove("is-editing"); });
  inp.addEventListener("mousedown", (e) => e.stopPropagation());
  const badge = bar.querySelector(".mp-zoom-badge");
  const pct = bar.querySelector(".mp-sb-pct");
  const openEditor = () => { bar.classList.add("is-editing"); inp.focus(); inp.select(); };
  badge.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); openEditor(); });
  pct.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); inp.focus(); });
  return bar;
}
const sbField = StateField.define({
  create: () => ({ len: -1, head: -1, anchor: -1, upd: null }),
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value;
    return { len: tr.state.doc.length, head: tr.state.selection.main.head, anchor: tr.state.selection.main.anchor, upd: value.upd };
  },
});
const statusBarPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.view = view; this.raf = 0; this.build(view); }
  build(view) {
    const el = document.querySelector(".mp-statusbar");
    if (!el) { this.dom = null; return; }
    this.dom = {
      el,
      pos: el.querySelector(".mp-sb-pos"),
      sel: el.querySelector(".mp-sb-sel"),
      count: el.querySelector(".mp-sb-count"),
    };
    for (const k of ["pos", "sel", "count"]) { const n = this.dom[k]; if (n && !n.firstChild) n.appendChild(document.createTextNode("")); }
    this.last = "";
    this.updateInfo(view, true);
  }
  update(u) {
    const st = u.state.field(sbField, false);
    const before = u.startState.field(sbField, false);
    if (!u.docChanged && !u.selectionSet) return;
    if (st && before && st.len === before.len && st.head === before.head && st.anchor === before.anchor) return;
    // 合并到下一帧：连续按键只重算一次，且不在 transaction 里读布局
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.dom) this.updateInfo(this.view, false);
    });
  }
  /** 【就地写文本·3.0.4】`el.textContent = x` 的实现是**删旧文本节点 + 建新文本节点**
   *  （每次都是 childList 变动 + 一次分配）。状态栏读数是每帧都会被改的数字，
   *  直接改已存在文本节点的 `nodeValue` 是**原地写**：零节点创建、零回收。
   *  探针口径（`probe-statusbar-perf.mjs`）：跑完 20 次光标移动 / 20 次键入，
   *  状态栏的 childList 变动必须为 **0**。 */
  setText(el, s) {
    if (!el) return;
    const n = el.firstChild;
    if (n && n.nodeType === 3) { if (n.nodeValue !== s) n.nodeValue = s; return; }
    el.textContent = s;
  }
  updateInfo(view, force) {
    if (!this.dom) return;
    const state = view.state;
    const doc = state.doc;
    const head = state.selection.main.head;
    const line = doc.lineAt(head);
    const col = head - line.from + 1;                    // 人类口径：第 1 列起
    const selLen = state.selection.ranges.reduce((n, r) => n + Math.abs(r.to - r.from), 0);
    const total = doc.lines;
    const key = head + "|" + selLen + "|" + doc.length + "|" + total;
    if (!force && key === this.last) return;             // 真·零改动：数字没变就不碰 DOM
    this.last = key;
    this.setText(this.dom.pos, `行 ${line.number}/${total} · 列 ${col}`);
    this.setText(this.dom.sel, selLen ? `选中 ${selLen} 字` : "");
    this.setText(this.dom.count, `${doc.length} 字`);
  }
  destroy() { if (this.raf) cancelAnimationFrame(this.raf); }
});

/** 状态栏的"一句话提示"（不新增 DOM 通道，复用"选中"格的原地写文本）。
 *  用途＝那些**静默拒绝**的操作（首个用户：分隔行上按 `Shift+Enter`）——按了没反应像坏了。
 *  口径：显示 1.5 秒后把常规内容原样还原；**只在这条拒绝路径上调用一次**，不在每键路径上。 */
let statusHintTimer = 0;
function statusBarHint(text, ms = 1500) {
  const bar = document.querySelector(".mp-statusbar");
  const el = bar && bar.querySelector(".mp-sb-sel");
  if (!el) return false;
  if (!el.firstChild || el.firstChild.nodeType !== 3) el.textContent = "";
  const node = el.firstChild;
  const prev = node.nodeValue || "";
  node.nodeValue = text;                                  // 原地写：不建节点
  clearTimeout(statusHintTimer);
  statusHintTimer = setTimeout(() => {
    try {
      if (node.nodeValue === text) node.nodeValue = prev;  // 期间没被别人改过才还原
      /* 提示期间文档/选区可能变过：让状态栏**下一帧强制重算**一次，
         否则 `last` 与旧值相同会导致"提示消失后内容不刷新"。 */
      if (view) requestAnimationFrame(() => { try { view.requestMeasure(); } catch { /* 忽略 */ } });
    } catch { /* 忽略 */ }
  }, ms);
  return true;
}
/* 把提示通道交给表格键位层（tables.js 不认识状态栏，避免循环依赖）。 */
setTableHint(statusBarHint);

/* ══ 文档目录（相对路径图的解析基准）══════════════════════════════════════════════
 *  壳层在装载文档**之前**写 `window.__mpDocDir` 并发 `mp:docdir`（见 MarkPilot-CM6\renderer\host.js）。
 *  引擎这边：① 用 `mpSetDocPath` 设/清 `<base href>`；② 目录变化时**踢一脚图片装饰**
 *  （widget 的 srcKey 只含 src 文本，目录变了它不会自己失效）。
 *  独立/插件宿主没有这两个通道时静默退化：相对路径维持"按应用目录"的旧行为。 */
/** 【目录变化 ⇒ 图片装饰重建】代数 field：`inlineMarkDecorations` 读它，代数一变就重算
 *  ⇒ `ImageWidget` 重建 ⇒ `toDOM` 用新 base 重赋 `src`（文档内容没变时 CM6 不会自己重算装饰）。 */
const imgBaseBump = StateEffect.define();
const imgBaseField = StateField.define({
  create: () => 0,
  update(v, tr) { for (const e of tr.effects) if (e.is(imgBaseBump)) return v + 1; return v; },
});
/** Preview-only generation; never reuse imgBaseBump (it changes region/session/math context). */
const imgPreviewBump = StateEffect.define();
const imgPreviewField = StateField.define({
  create: () => 0,
  update(v, tr) { for (const e of tr.effects) if (e.is(imgPreviewBump)) return v + 1; return v; },
});
function mpApplyHostDocDir() {
  try {
    const dir = (typeof window.__mpDocDir === "string" && window.__mpDocDir) ? window.__mpDocDir : "";
    const before = mpDocDir;
    mpSetDocPath(dir, true);
    if (before !== mpDocDir && view) {
      mpImgLoadState.clear(); mpImgTries.clear();
      view.dispatch({ effects: [imgBaseBump.of(null), cancelImageInsertions.of(null)] });
      view.requestMeasure();
      prefetchSelectionImages(view); scheduleImgPrefetch(view);
    }
  } catch (e) { console.error("[mp] 文档目录同步失败：", e); }
}
try { window.addEventListener("mp:docdir", mpApplyHostDocDir); } catch { /* 忽略 */ }

/* ══ 排版美化 · Knuth–Plass 整段最优断行（阅读模式可选，**默认关**）══════════════════
 *  功能名统一叫「排版美化」（设置面板 / 阅读模式按钮 / 快捷键提示三处同名）。
 *
 *  【三条硬约束，别来"优化"掉】
 *  ① **不在键入路径上**：只有"阅读模式 + 用户显式开启 + 文档 ≤ KP_MAX_CHARS"三条同时成立才跑；
 *     而且只处理**视口内已渲染**的行 ⇒ 打字时的每键开销为零（编辑态根本不跑）。
 *  ② **只接管"纯文本段"**：该行 DOM 的孩子**全是文本节点**才接管。这一条同时排掉
 *     标题/列表/引用/代码/表格/含行内标记（隐藏标记与行内代码/公式/图片都会引入元素）——
 *     那些行的排版交给浏览器，不冒险切碎行内件。
 *  ③ **尊重用户 CSS**：测量用**该行自己的 computedStyle**（font-style/weight/size/family + letter-spacing），
 *     渲染出的断行行**继承同一套样式**（不写死字体/字号）⇒ 用户自定义 CSS 一改，断行结果跟着重算。
 *
 *  【为什么用 canvas 量而不是 DOM】DOM 测量要插入探针再读 rect（触发布局）；canvas 只量字宽，
 *  不碰文档、不触发布局。CJK 单字宽度按字体缓存，避免逐字重复测量。 */
const KP_MAX_CHARS = 300000;
const kpCharWCache = new Map();      // `${font}|${ch}` → 宽度
const kpLinesCache = new Map();      // `${font}|${ls}|${width}|${text}` → 断行结果
let kpCanvasCtx = null;
function kpCtx() {
  if (!kpCanvasCtx) { try { kpCanvasCtx = document.createElement('canvas').getContext('2d'); } catch { kpCanvasCtx = null; } }
  return kpCanvasCtx;
}
function kpMeasure(s, font) {
  const c = kpCtx(); if (!c) return s.length * 8;
  c.font = font;
  return c.measureText(s).width;
}
function kpCharW(ch, font) {
  const k = font + '|' + ch;
  let w = kpCharWCache.get(k);
  if (w === undefined) { w = kpMeasure(ch, font); if (kpCharWCache.size > 4000) kpCharWCache.clear(); kpCharWCache.set(k, w); }
  return w;
}
const KP_CJK = /[\u2E80-\u9FFF\u3000-\u303F\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;
/** 把一段文字切成 Knuth–Plass 的 box/glue 序列。`ls` = letter-spacing（用户 CSS 可能设了）。 */
function kpItemsFor(text, font, ls) {
  const items = [];
  const pad = (n) => (ls ? ls * n : 0);
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {                                   // 空白 → glue（可伸可缩）
      let j = i; while (j < text.length && /\s/.test(text[j])) j++;
      const s = text.slice(i, j), w = kpMeasure(s, font) + pad(s.length);
      items.push({ type: 'glue', width: w, stretch: w * 0.6, shrink: w * 0.34, text: s });
      i = j; continue;
    }
    if (KP_CJK.test(ch)) {                                 // 汉字/全角标点 → 可断 box
      items.push({ type: 'box', width: kpCharW(ch, font) + pad(1), text: ch, breakable: true });
      i++; continue;
    }
    let j = i;                                             // 西文词 → 不可断 box
    while (j < text.length && !/\s/.test(text[j]) && !KP_CJK.test(text[j])) j++;
    const s = text.slice(i, j);
    items.push({ type: 'box', width: kpMeasure(s, font) + pad(s.length), text: s, breakable: false });
    i = j;
  }
  /* 中文禁则：行首禁（断点落在它前面 = 禁） / 行尾禁（断点落在它后面 = 禁）。
     实现方式与 knuth-plass 的 `breakable` 语义对齐：断点在第 i 项"之前"，由第 i-1 项的 breakable 控制。 */
  for (let k = 1; k < items.length; k++) {
    const cur = items[k], prev = items[k - 1];
    if (cur.type === 'box' && cur.text && NO_BREAK_BEFORE.includes(cur.text)) prev.breakable = false;
    if (prev.type === 'box' && prev.text && NO_BREAK_AFTER.includes(prev.text)) prev.breakable = false;
  }
  return items;
}
/** 求这一段的断行；返回行文本数组（不需要断行时返回 null）。 */
function kpBreak(text, font, ls, width) {
  const key = font + '|' + ls + '|' + Math.round(width) + '|' + text;
  const hit = kpLinesCache.get(key);
  if (hit !== undefined) return hit;
  let out = null;
  try {
    const items = kpItemsFor(text, font, ls);
    const r = kpBreakParagraph(items, width, { tolerance: 200 });
    if (r && r.feasible && r.breaks && r.breaks.length > 1) {
      const lines = []; let start = 0;
      for (const b of r.breaks) { lines.push(items.slice(start, b).map((it) => it.text).join('').replace(/\s+$/, '')); start = b; }
      out = lines.filter((l) => l.length);
    }
  } catch { out = null; }
  if (kpLinesCache.size > 600) kpLinesCache.clear();
  kpLinesCache.set(key, out);
  return out;
}
class KpWidget extends WidgetType {
  constructor(lines, key) { super(); this.lines = lines; this.key = key; }
  eq(o) { return !!o && o.key === this.key; }
  toDOM() {
    /* 【为什么用 inline + <br> 而不是块级子元素·2026-10-09 实测两条路都试过】
       · 块级子元素（display:block）：它们会**逃出行盒**，行元素自己还撑一层 leading ⇒ 同样 4 行
         实测 187px（应 125px）；再补 `line-height:0` 又把段落压成 32px（内容溢出）。
       · `block:true` 的块级替换：CM6 规定**块级替换装饰只能来自 StateField，不能来自 ViewPlugin**
         ⇒ 装饰被整批拒绝（kpParas 8 → 0）。
       ⇒ 正解就是**行内内容 + `<br>` 强制断行**：行盒模型与普通段落完全一致（4 行 = 4×line-height），
         宽度由 KP 决定、只在极少数测量误差时才允许再折（white-space: pre-wrap）。 */
    const wrap = document.createElement('span');
    wrap.className = 'mp-kp-para';
    this.lines.forEach((t, i) => {
      if (i) wrap.appendChild(document.createElement('br'));
      wrap.appendChild(document.createTextNode(t));
    });
    return wrap;
  }
}
const kpMode = () => { try { return localStorage.getItem('mp-typography') === 'kp' ? 'kp' : 'css'; } catch { return 'css'; } };
const kpTypesetPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.deco = Decoration.none; this.key = ''; this.last = '';
    /* 【踩坑·2026-10-09】只改 `this.deco` **不会**让视图重新读装饰：装饰是在 `view.update()`
       里被读的，所以这里必须**发一笔空事务**把视图推一次（再补一次 requestMeasure 让高度图跟上）。
       实测：不推事务时切到 KP 后 `kpParas` 恒为 0（按钮文本变了、排版没变）。 */
    this.onEvt = () => { this.build(view); try { view.dispatch({}); } catch { } view.requestMeasure(); };
    document.addEventListener('mp-typography-changed', this.onEvt);
    this.build(view);
  }
  destroy() { document.removeEventListener('mp-typography-changed', this.onEvt); }
  update(u) { if (u.docChanged || u.viewportChanged || u.geometryChanged) this.build(u.view); }
  build(view) {
    const dbg = globalThis.__mpKpDebug ? (globalThis.__mpKpLog = []) : null;
    const log = (o) => { if (dbg) globalThis.__mpKpLog.push(o); };
    const on = kpMode() === 'kp' && document.documentElement.dataset.mpReading === '1' && view.state.doc.length <= KP_MAX_CHARS;
    log({ on, mode: kpMode(), reading: document.documentElement.dataset.mpReading, docLen: view.state.doc.length });
    if (!on) { if (this.deco !== Decoration.none) { this.deco = Decoration.none; this.key = ''; } return; }
    const doc = view.state.doc;
    const els = [...view.contentDOM.children].filter((el) => el.nodeType === 1 && el.classList && el.classList.contains('cm-line'));
    const deco = [];
    let contentW = 0;
    try { const cs = getComputedStyle(view.contentDOM); contentW = view.contentDOM.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0); } catch { contentW = view.contentDOM.clientWidth; }
    if (!(contentW > 40)) return;
    for (const el of els) {
      /* 【幂等判据·2026-10-09 修振荡】改前是"孩子必须恰好是一个文本节点"。问题是**我们自己套上的 widget 也是元素**
         ⇒ 第二次 build 把已经排好的行判成"非纯文本" ⇒ 装饰被清空 ⇒ 下一轮又排上……实测症状：
         快照 `kpParas=0`、而引擎日志里那些行的孩子是 `1,1,1`（widgetBuffer + widget + widgetBuffer），
         即"widget 明明在、却被自己的判据否掉"。
         白名单：孩子只能是**文本节点** / `img.cm-widgetBuffer`（CM6 部件缓冲）/ `.mp-kp-para`（我们的产物）。
         出现别的元素（隐藏标记的 span、行内代码/公式/图片）就跳过 —— 那一类行交给浏览器排版。 */
      const okChildren = [...el.childNodes].every((n) => n.nodeType === 3
        || (n.nodeType === 1 && n.classList && (n.classList.contains('cm-widgetBuffer') || n.classList.contains('mp-kp-para'))));
      if (!okChildren) { log({ skip: 'not-plain-line', kinds: [...el.childNodes].map((n) => n.nodeType).join(',') }); continue; }
      let ln = -1;
      try { ln = doc.lineAt(view.posAtDOM(el, 0)).number; } catch { ln = -1; }
      if (ln < 0) { log({ skip: 'no-doc-line' }); continue; }
      const line = doc.line(ln);
      const src = line.text;                              // 用文档文本（上面已保证行内没有隐藏标记）
      if (!src.trim()) { log({ skip: 'empty', ln }); continue; }
      if (/^\s*(#{1,6}\s|>|\||```|~~~|[-*+]\s|\d+[.)]\s|---|\*\*\*|___)/.test(src)) { log({ skip: 'block-syntax', ln }); continue; }   // 块级语法行
      if (/[*_`~\[\]<>]|\$\$|!\s*\[/.test(src)) { log({ skip: 'has-inline-marks', ln, src: src.slice(0, 20) }); continue; }             // 含行内标记/链接/公式/图片 ⇒ 不碰
      if (src.length < 12) { log({ skip: 'too-short', ln }); continue; }
      const cs = getComputedStyle(el);
      const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const ls = (cs.letterSpacing && cs.letterSpacing !== 'normal') ? (parseFloat(cs.letterSpacing) || 0) : 0;
      const lines = kpBreak(src, font, ls, contentW);
      log({ ln, srcLen: src.length, font, ls, contentW, lines: lines ? lines.length : null });
      if (!lines || lines.length < 2) { log({ skip: 'no-breaks', ln, lines: lines ? lines.length : null }); continue; }
      const key = lines.join('\u0000');
      /* 【只做 inline 替换·2026-10-09 实测】`block: true` 不行：CM6 规定**块级替换装饰只能来自
         StateField，不能来自 ViewPlugin** ⇒ 装饰被整批拒绝（实测 kpParas 从 8 掉到 0、高度退回两端对齐的 125）。
         所以用 inline 替换 + 下面那条 CSS：`.cm-line:has(> .mp-kp-para) { line-height: 0 }` 把行元素
         自己的那层 leading 去掉（否则 widget 里 4 行之外还要多撑一层，实测 187px vs 应有的 125px）。 */
      deco.push(Decoration.replace({ widget: new KpWidget(lines, key) }).range(line.from, line.to));
    }
    const next = deco.length ? Decoration.set(deco, true) : Decoration.none;
    this.deco = next;
  }
}, { decorations: (v) => v.deco });

/* ══ 数学 span 预计算（性能架构：宪法第二条）══
 * span 清单只在文档变化时重扫（StateField）；选区变化只走 O(spans) 派生层
 * （无正则、无字符串拼接）——点击/移动光标零重扫。 */

/** 数学 span（行内 + 块级统一）：{from,to,tex,display}。仅文档变化时重算。 */


// Plain edits outside math cannot change its parsing. Map every source coordinate;
// edits to math, line structure or code boundaries use the authoritative scanner.
const a1MapSpan = (span, map) => ({ ...span, from: map(span.from), to: map(span.to), texFrom: map(span.texFrom),
  ...(span.texMap ? { texMap: span.texMap.map(part => ({ ...part, docFrom: map(part.docFrom) })) } : {}) });
const mathSpansField = StateField.define({
  create(state) {
    return { spans: scanMathSpans(state.doc, state.field(markdownContext).blocks,state.field(markdownContext)), version: 0, _incr: { fullRescan: 1 } };
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    const context = tr.state.field(markdownContext);
    const plan = tr.state.field(editPlan);
    const map = p => tr.changes.mapPos(p, 1);
    if (!context.rebuilt && plan && !blockAt(context.blocks, plan.after.from)) {
      const owners = rangesTouching(value.spans, plan.before.from, plan.before.to);
      const noSyntax = plan.changes.every(c => !/[$`\r\n]/.test(c.removed + c.added));
      let from = plan.before.from, to = plan.before.to;
      const spanning = owners.filter(s => s.from < from || s.to > to);
      if (noSyntax && (spanning.length === 0 && !/\$\$|\$\\begin\{|<!--|-->/.test(plan.before.text) ||
          spanning.length === 1 && plan.changes.every(c => c.fromA > spanning[0].from && c.toA < spanning[0].to))) {
        if (spanning.length) { from = tr.startState.doc.lineAt(spanning[0].from).from; to = tr.startState.doc.lineAt(spanning[0].to).to; }
        const newFrom = tr.changes.mapPos(from, -1), newTo = map(to);
        const local = scanMathSpans(Text.of(tr.state.doc.sliceString(newFrom, newTo).split('\n')), [])
          .map(s => a1MapSpan(s, p => p + newFrom));
        if (!spanning.length || local.some(s => s.from === map(spanning[0].from) && s.to === map(spanning[0].to))) {
          const spans = value.spans.filter(s => s.to < from || s.from > to).map(s => a1MapSpan(s, map)).concat(local).sort((a,b) => a.from-b.from);
          return { spans, version: value.version + 1, _incr: { fullRescan: 0, localLines: tr.state.doc.lineAt(newTo).number - tr.state.doc.lineAt(newFrom).number + 1 } };
        }
      }
    }
    let rescan = context.rebuilt;
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      if (rescan) return;
      if (/[$\n\r]/.test(tr.startState.doc.sliceString(fromA, toA)) || /[$\n\r]/.test(inserted.toString()) ||
          value.spans.some(span => fromA <= span.to && toA >= span.from) ||
          tr.startState.doc.lineAt(fromA).text.includes('$') || tr.state.doc.lineAt(fromB).text.includes('$')) rescan = true;
    });
    const spans = rescan ? scanMathSpans(tr.state.doc, context.blocks,context) : value.spans.map(span => a1MapSpan(span, p => tr.changes.mapPos(p, 1)));
    return { spans, version: value.version + 1, _incr: { fullRescan: rescan ? 1 : 0 } };
  },
});

function scanMathSpans(doc, blocks = scanFencedBlocks(doc), structure = scanStructuralContext(doc)) {
  let hasDollar = false;
  for (const t of doc.iterLines()) {
    if (t.includes("$")) { hasDollar = true; break; }
  }
  if (!hasDollar) return [];
  const spans = [];
  const fenceGroups = [[]];
  let fences = fenceGroups[0];
  let openDollar = null; // 跨行形态：`$$内容…` 开 → `…内容$$` 合（见下）
  let openSingle = null; // 【单 $ 跨多行】`$\begin{…}` 开 → 以 `$` 结尾的行合（引用区里 LLM 生成的推导块常见）
  let tentativeFrom = 0; // spans 中自该下标起，属于"未闭合区"的临时行内 span
  let openSingleFrom = 0;
  /** 行内 `$…$` 扫描（与主路径同口径） */
  function pushInline(line) {
    const re = /(^|[^\\$])\$((?:\\[^\n]|[^$\n\\])+?)\$/g;
    const code = inlineCodeRanges(line.text);
    let m;
    while ((m = re.exec(line.text))) {
      const start = line.from + m.index + m[1].length;
      if (code.some(([a,b]) => start < line.from+b && start+m[2].length+2 > line.from+a)) continue;
      /* 【#29·2026-10-17】内容 trim 后为空（美元符加空格再加美元符）不算公式：
         否则被换成空 widget，那几个字符从屏幕上消失、也点不中。与格内/导出扫描器口径一致。 */
      if (!m[2].trim()) continue;
      spans.push({ from: start, to: start + m[2].length + 2, tex: m[2], display: false, texFrom: start + 1 });
    }
  }
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const t = line.text;
    if (blockAt(blocks, line.from)) {
      openDollar = openSingle = null;
      if (fences.length) { fences = []; fenceGroups.push(fences); }
      continue;
    }
    // ① 已开启跨行形态：本行只要「以 $$ 收尾」就闭合（含整行只有 $$ 的情况，允许尾随空白）
    /* 【单 $ 跨多行·引用区】各行的 `> ` 前缀要剥掉再拼 tex，否则 KaTeX 会吃到 '>'。 */
    /* 前缀判据唯一化（#15/TBL-3）。 */
    const qOff = structuralContextAt(structure,line.from)?.lead ?? tableLead(t).off;
    const qText = t.slice(qOff);
    if (openSingle) {
      const body = qText;
      /* 空行＝段落边界（MTH-01：跨行单 $ 不许跨段落吞并）。 */
      if (!body.trim()) { openSingle = null; continue; }
      /* 闭合判据与 $ 形态同源：容忍 $ 后的行尾空白（实测 b$ 带尾随空格此前永不闭合）。 */
      const closeAt = body.search(/[$][ \t]*$/);
      if (closeAt >= 0) {
        openSingle.parts.push({ text: body.slice(0, closeAt), from: line.from + qOff });
        const source = mappedMathSource(openSingle.parts);
        openSingle = null;
        if (source.tex) spans.push({ from: openSingleFrom, to: line.to, ...source, display: true });
      } else openSingle.parts.push({ text: body, from: line.from + qOff });
      continue;
    }
    const sOpen = /^[ \t]*\$\\begin\{/.test(qText);
    if (sOpen) {
      const lead = qText.length - qText.trimStart().length;
      const body = qText.slice(lead);
      /* 【引用区单 `$`·2026-10-08 修复】**同一行就闭合**的形态（`>> $\begin{cases}…\end{cases}$`）：
         改前这里只看"`$\begin{` 之后的第一个字符"，永远不等于 `$` ⇒ 一律当成"跨行开口"，
         于是整行进 parts、等下一行用行尾 `$` 闭合；下一行若没有 `$`（单行形态本来就没有），
         这个块**永远闭不上** ⇒ 连同 `$` 定界符一起当普通文本露出（用户截图：整段源码 + 套框）。
         判据：`\begin{…}...\end{…}$` 的**同一行**闭合——取最后一个 `$` 当闭合符。 */
      const close = body.lastIndexOf("$");
      if (close > 0) {
        const source = mappedMathSource([{ text: body.slice(1, close), from: line.from + qOff + lead + 1 }]);
        if (source.tex) spans.push({ from: line.from + qOff + lead, to: line.from + qOff + lead + close + 1, ...source, display: true });
        continue;
      }
      const first = body.slice(1);
      openSingle = { parts: [{ text: first, from: line.from + qOff + lead + 1 }] };
      openSingleFrom = line.from + qOff + lead;
      continue;
    }
    if (openDollar) {
      const cm = /\$\$\s*$/.exec(t);
      if (cm) {
        const texEnd = line.from + cm.index;
        let raw = doc.sliceString(openDollar.texFrom, texEnd);
        if (openDollar.quoted) raw = raw.split("\n").map((l) => l.replace(/^[ \t]*(?:>[ \t]?)+/, "")).join("\n");
        const lead = raw.length - raw.trimStart().length;
        spans.length = tentativeFrom; // 区内"临时行内 span"作废（会与块级 replace 装饰重叠→CM6 抛错）
        if (raw.trim()) spans.push({ from: openDollar.from, to: texEnd + 2, tex: raw.trim(), display: true, texFrom: openDollar.texFrom + lead });
        else spans.push({ from: openDollar.from, to: texEnd + 2, tex: "", display: true, texFrom: openDollar.texFrom });
        openDollar = null;
        continue;
      }
      // 未闭合期间：本行照常按普通行渲染（行内公式不因一个手滑的 $$ 全文失效）
      pushInline(line);
      continue;
    }
    /* 【引用区围栏·2026-10-09 用户要求】围栏判据改用**剥掉引用前缀后**的文本：
       改前 `t.trim() === "$$"` ⇒ `> $$` 永不匹配 ⇒ 引用区里的块公式整段当普通文本
       （用户笔记就是 `> $$` / `> \boxed{…}` / `> $$` 这种写法，实测不渲染）。
       记录 qOff：配对时按行剥前缀，否则 KaTeX 会吃到 `>`。 */
    if (qText.trim() === "$$") { fences.push({ from: line.from, to: line.to, n: i, qOff }); continue; }
    // 单行块公式 $$…$$（用户实测形态：$$\sigma(X):=\{...\}$$ 整条一行）——
    // 旧扫描只认「整行只有 $$」的围栏对，单行形态整条漏渲染。
    const one = /^\$\$(.+)\$\$\s*$/.exec(qText);
    if (one && one[1].trim()) {
      const content = one[1];
      const lead = content.length - content.trimStart().length;
      spans.push({ from: line.from, to: line.to, tex: content.trim(), display: true, texFrom: line.from + qOff + 2 + lead });
      continue;
    }
    // 【2026-10-07 补形态】`$$` 行首带内容、`$$` 行尾带内容的**跨行**写法（Typora/MathJax 标准）：
    //     $$\begin{aligned}…\\
    //     …\end{aligned}$$
    //   旧扫描只认「整行 $$」围栏对与「单行 $$…$$」——这种形态两条都不沾，整段当普通文本
    //   （实机取证：第 4675–4678 行 katex=0/mathSpan=0，而紧邻段落的行内公式 katex=6）。
    /* MTH-02/03：引用前缀与 $ 后空白两种合法跨行写法都要开口。 */
    const om = /^\s*\$\$(?=\s*\S)/.exec(qText);
    if (om) {
      const rest = qText.slice(om[0].length);
      /* 【#28 实测缺陷·2026-10-17】本行已有第二对 $ 时不是跨行开口（如 \`$x$ 正文\`）：
         否则扫描会一路吞到下一个以 $ 结尾的行，把正文和后续块公式一起变成 katex-error。 */
      if (!/\$[$]/.test(rest) && !rest.trimEnd().endsWith("$")) {
        openDollar = { from: line.from, texFrom: line.from + qOff + om[0].length, quoted: qOff > 0 };
        tentativeFrom = spans.length;
        continue;
      }
    }
    if (!t.includes("$")) continue;
    // 【2026-10-07 补形态】**行中段** `$$…$$`（正文里"写着写着突然要个公式，没敲回车就打了"）。
    // 块级 widget 只能落在行边界，故此处按**行内**渲染（display:false）——先保证"任何正确书写
    // 的 latex 都能渲染出来"；要不要独占一行，由 autoBreakMath 的收笔换行决定（零文档改动优先）。
    if (t.includes("$$")) {
      const re2 = /\$\$([^$\n]+?)\$\$/g;
      let m2;
      while ((m2 = re2.exec(t))) {
        const start = line.from + m2.index;
        if (inlineCodeRanges(t).some(([a,b]) => m2.index < b && m2.index+m2[0].length > a)) continue;
        const lead = m2[1].length - m2[1].trimStart().length;
        /* 【#29 第二处·2026-10-17】trim 后为空就不成公式（同 pushInline 口径）。 */
        if (!m2[1].trim()) continue;
        spans.push({ from: start, to: start + m2[0].length, tex: m2[1].trim(), display: false, texFrom: start + 2 + lead });
      }
    }
    pushInline(line);
  }
  for (const fences of fenceGroups) for (let i = 0; i + 1 < fences.length; i += 2) {
    const a = fences[i], b = fences[i + 1];
    if (b.n - a.n < 1) continue;
    const raw0 = doc.sliceString(doc.line(a.n).to + 1, doc.line(b.n).from);
    /* 引用区里的块：逐行剥掉 `> ` 前缀再拼 tex（前缀长度按每行自己算，兼容 `> > ` 与 `>\t`）。 */
    const quoted = !!(a.qOff || b.qOff) || tableLead(raw0).off > 0;
    const parts = [];
    for (let n = a.n + 1; n < b.n; n++) {
      const line = doc.line(n);
      const prefix = structuralContextAt(structure,line.from)?.lead ?? (quoted ? tableLead(line.text).off : 0);
      parts.push({ text: line.text.slice(prefix), from: line.from + prefix });
    }
    spans.push({ from: a.from, to: b.to, ...mappedMathSource(parts, a.to + 1), display: true });
  }
  spans.sort((x, y) => x.from - y.from);
  return spans;
}

/** 派生层（行内）：**光标所在**的 span 显源码（跳过），选区里其余 span 保持渲染＋选中底色。
 *  【选区语义·2026-10-07 裁决】旧口径是"选区相交就展开"，拖过一段公式密集的正文会把整片变成
 *  裸 LaTeX（实测截图：满屏 \in \mathbb）；新口径只展开**光标（head）所在**那一个，划过的保持
 *  渲染但带选中态 ⇒ 拖拽时可读、选区仍可见。配套：copy/cut 一律按**文档源码**写剪贴板
 *  （否则拿到的是 KaTeX 字形文本而非 markdown）。
 *  【行内实时预览】光标在行内 span 内（编辑中）→ 源码后挂渲染 chip—— */
function buildInlineMath(state, spans = state.field(mathSpansField).spans) {
  const out = [];
  const head = state.selection.main.head;
  const flags=s=>state.field(regionSessionField).presentation.get(regionAt(state.field(regionIndexField),s.from,'math')?.id);
  const headIn = s=>!!flags(s)?.editing;
  const inSel = s=>!!flags(s)?.selected;
  for (const s of spans) {
    if (s.display) continue; // 块级走 blockMathField（StateField 直供）
    const sel = inSel(s);
    if (headIn(s)) {
      const region = regionAt(state.field(regionIndexField), s.from, 'math');
      out.push(Decoration.widget({ mpRegion: region?.id,
        widget: new InlineMathSpace(s.tex, region, state.field(regionIndexField).epoch), side: -1 }).range(s.from));
      if (head >= s.from && head <= s.to && s.tex) {
        // 【用户裁定·Typora 行为】编辑预览＝浮动层（absolute 浮于源码上方），
        // 不占排版流——点开公式时正文/后续段落零移动；只有源码展开本身改变
        // 行内容时才重排（Typora 同）。原 block widget 方案会把预览插进排版流，
        // 每次点开都推挤后续内容。
        const line = state.doc.lineAt(s.to);
        out.push(Decoration.widget({ mpRegion: regionAt(state.field(regionIndexField),s.from,'math')?.id, widget: new InlineFloatWidget(s.tex, false, s.from, s.to, s.texFrom,
          regionAt(state.field(regionIndexField), s.from, 'math')), side: 1 }).range(s.to));
      }
      continue;
    }
    out.push(Decoration.replace({ mpRegion: regionAt(state.field(regionIndexField),s.from,'math')?.id, widget: mathWidget(s.tex, false, false, sel,
      regionAt(state.field(regionIndexField), s.from, 'math')) }).range(s.from, s.to));
  }
  return Decoration.set(out, true);
}
const mathProjectionStats = { full: 0, patched: 0, touched: 0 };
function updateMathProjection(value, tr, display) {
  const before = tr.startState.field(regionIndexField), after = tr.state.field(regionIndexField);
  if (!tr.docChanged && !tr.selection && before === after) return value;
  const candidates = new Map(), ids = new Set();
  const addSelection = (state, index) => {
    for (const s of state.selection.ranges) for (const r of regionsBetween(index,s.from,s.to,'math')) candidates.set(r.id,r);
  };
  addSelection(tr.startState,before); addSelection(tr.state,after);
  const flags = (state,r) => {
    if (!r) return '';
    const ranges = state.selection.ranges;
    return `${ranges.some(s=>s.head>=r.from&&s.head<=r.to)}:${ranges.some(s=>s.from<=r.to&&s.to>=r.from)}:${state.selection.main.head>=r.from&&state.selection.main.head<=r.to}`;
  };
  if (tr.docChanged || before !== after) {
    for (const id of after.invalidated) {
      const r = after.byId.get(id) || before.byId.get(id);
      if (r?.kind === 'math') candidates.set(id,r);
    }
  }
  for (const [id,r] of candidates) {
    const old = before.byId.get(id), next = after.byId.get(id);
    if (r.data.display !== display) continue;
    if (tr.docChanged || old?.revision !== next?.revision || old?.contextVersion !== next?.contextVersion || flags(tr.startState,old) !== flags(tr.state,next)) ids.add(id);
  }
  let mapped = tr.docChanged ? value.map(tr.changes) : value;
  if (!ids.size) return mapped;
  const spans = [...ids].map(id=>after.byId.get(id)?.data).filter(Boolean);
  const additions = display ? buildBlockMath(tr.state,spans) : buildInlineMath(tr.state,spans);
  const add = []; additions.between(0,tr.state.doc.length,(from,to,deco)=>add.push(deco.range(from,to)));
  mathProjectionStats.patched++; mathProjectionStats.touched += ids.size;
  return mapped.update({ filter: (from,to,deco)=>!ids.has(deco.spec.mpRegion), add, sort: true });
}
const mathDecorations = StateField.define({
  create(state) { mathProjectionStats.full++; return buildInlineMath(state); },
  update: (value,tr) => updateMathProjection(value,tr,false),
  provide: f => EditorView.decorations.from(f),
});

/** 块级公式投影：StateField 直供（W1：compute 载 block:true 是官方点名反模式——
 *  派生源在选区变化时整组重比对块结构；StateField 直供 + estimatedHeight 是
 *  官方块级装饰的唯一受支持形态）。**光标（head）所在**的块显源码，选区里其余块保持渲染
 *  ＋选中底色，与行内同规则（D8）。
 *  注意：create 里不许读别的 field（CM6 规则）——直接重扫；update 读
 *  mathSpansField 依赖扩展序（mathSpansField 排在前）。 */
const blockFenceLayouts = new WeakMap();
function blockFenceLayout(state, span) {
  const cached = blockFenceLayouts.get(span);
  if (cached?.doc === state.doc) return cached.ranges;
  const opening = state.doc.lineAt(span.from), closing = state.doc.lineAt(span.to);
  const prefix = line => quoteLead(line.text).off;
  const bodyLines = closing.number - opening.number - 1, map = span.texMap;
  let ranges = null;
  if (bodyLines > 0 && span.tex && map?.length === bodyLines &&
      opening.from === span.from && closing.to === span.to &&
      opening.text.slice(prefix(opening)).trim() === '$$' && closing.text.slice(prefix(closing)).trim() === '$$') {
    const first = state.doc.line(opening.number + 1), last = state.doc.line(closing.number - 1);
    if (map[0].docFrom === first.from + prefix(first) && map[map.length - 1].docFrom === last.from + prefix(last)) {
      ranges = [[opening.to, map[0].docFrom], [last.to, closing.from + prefix(closing)]];
    }
  }
  blockFenceLayouts.set(span, { doc: state.doc, ranges });
  return ranges;
}
function mathFencePointerPosition(state, pos) {
  const index = state.field(regionIndexField, false), region = regionAt(index, pos, 'math');
  if (!region?.data.display || !state.field(regionSessionField, false)?.presentation.get(region.id)?.editing) return pos;
  const ranges = blockFenceLayout(state, region.data);
  if (!ranges) return pos;
  if (pos >= ranges[0][0] && pos <= ranges[0][1]) return ranges[0][1];
  if (pos >= ranges[1][0] && pos <= ranges[1][1]) return ranges[1][0];
  return pos;
}
const mathFencePointerSelection = EditorState.transactionFilter.of(tr => {
  if (tr.docChanged || !tr.selection) return tr;
  // Native vertical hit-testing can choose a hidden fence-break alias. Resolve
  // it at the same source boundary as pointer input, preserving the visual goal.
  // The native annotation extender runs later, so use this view's live key intent.
  const nativeVertical = view?.__mpVerticalInput && view.state === tr.startState &&
    tr.annotation(Transaction.userEvent) === 'select';
  if (!tr.isUserEvent('select.pointer') && !nativeVertical) return tr;
  const state = tr.startState, selection = tr.newSelection;
  let changed = false;
  const ranges = selection.ranges.map(range => {
    const head = mathFencePointerPosition(state, range.head);
    const keepAnchor = !range.empty && state.selection.ranges.some(old => old.anchor === range.anchor);
    const anchor = keepAnchor ? range.anchor : mathFencePointerPosition(state, range.anchor);
    if (head === range.head && anchor === range.anchor) return range;
    changed = true;
    return EditorSelection.range(anchor, head, range.goalColumn, range.bidiLevel, range.assoc);
  });
  return changed ? [tr, { selection: EditorSelection.create(ranges, selection.mainIndex), annotations: Transaction.addToHistory.of(false) }] : tr;
});
function buildBlockMath(state, spans) {
  const out = [];
  const head = state.selection.main.head;
  const flags=s=>state.field(regionSessionField).presentation.get(regionAt(state.field(regionIndexField),s.from,'math')?.id);
  const headIn = s=>!!flags(s)?.editing;
  const inSel = s=>!!flags(s)?.selected;
  for (const s of spans) {
    if (!s.display) continue;
    if (headIn(s)) {
      // Only the visual fence breaks fold. Source bytes, source positions and
      // history stay in the same document; unsupported containers stay literal.
      const region = regionAt(state.field(regionIndexField), s.from, 'math')?.id;
      for (const [from, to] of blockFenceLayout(state, s) || []) {
        if (to > from) out.push(Decoration.replace({ mpRegion: region, inclusiveStart: false, inclusiveEnd: false }).range(from, to));
      }
      // 【Typora 块公式编辑语义】光标在块内＝编辑中：源码可见（不加 replace）＋
      // 浮动预览（Typora：浮于真文本之上不占排版流——旧块级 widget 在流内，
      // 每次点开推挤后续段落）。光标不在块内的选区穿越：只显源码不挂预览。
      // 【居中对齐·2026-10-07】渲染态是 displayMode（KaTeX .katex-display 居中）；
      // 展开源码若走默认左对齐，点击瞬间公式会"居中→左"横跳（用户实测烦人）。
      // 故展开期间给 span 覆盖的每一行挂 mp-math-src＝text-align:center，令源码与渲染体同轴。
      // 行装饰纯视觉：不改文档、不进高度图、不改键位。
      const firstLine = state.doc.lineAt(s.from).number;
      const lastLine = state.doc.lineAt(s.to).number;
      for (let n = firstLine; n <= lastLine; n++) out.push(Decoration.line({ class: "mp-math-src", mpRegion: regionAt(state.field(regionIndexField),s.from,'math')?.id }).range(state.doc.line(n).from));
      if (head >= s.from && head <= s.to && s.tex) {
        out.push(Decoration.widget({ mpRegion: regionAt(state.field(regionIndexField),s.from,'math')?.id, widget: new InlineFloatWidget(s.tex, true, s.from, s.to, s.texFrom,
          regionAt(state.field(regionIndexField), s.from, 'math')), side: 1 }).range(s.to));
      }      continue;
    }
    out.push(Decoration.replace({ mpRegion: regionAt(state.field(regionIndexField),s.from,'math')?.id, widget: mathWidget(s.tex, true, false, inSel(s),
      regionAt(state.field(regionIndexField), s.from, 'math')), block: true }).range(s.from, s.to));
  }
  return Decoration.set(out, true);
}
const blockMathField = StateField.define({
  create(state) { return buildBlockMath(state, state.field(mathSpansField).spans); },
  update: (value,tr) => updateMathProjection(value,tr,true),
  provide: (field) => EditorView.decorations.from(field),
});

/** 纵向移动进/出块公式（用户 2026-10-07 实测缺陷：光标在块**下一行**按 ↑ 会整块跳过，
 *  直接落到块上一行正文——因为块级 widget 是 replace 装饰，CM6 的纵向落点在 widget
 *  区域只会映射到它的边界，不会进 span）。
 *  【模型 W′·2026-10-07 裁决】把块看成"**内容行 + 两侧装饰围栏**"：
 *   · 进块（视觉相邻块，↑ 从下方来 / ↓ 从上方来）→ 落**内容**近端（内容末 / 内容首），
 *     并把光标送进 span ⇒ 触发既有的"源码展开"投影；
 *   · 出块 → 从内容首行再按 ↑（或末行再按 ↓）**越过围栏**，直接到块外相邻行；
 *   · **围栏行（`$$`）不作为纵向停靠点**——它们是块的装饰边界而非内容。这条来自 Typora 实机：
 *     第一跳落 `E=mc^2|`（内容行末）、第二跳直接出块；若把围栏当停靠点，穿一个 3 行块要按 4 次。
 *   · **列用"经过前"的值**：穿过块不许吃掉横向位置（模块级 mathPass 记一个 {spanFrom,col}）。
 *  闸门：仅折叠光标；仅当中间只有空白且不超过一个换行（真·视觉相邻）；否则返回 false 交回默认。
 *  性能：只读已有的 mathSpansField（O(spans)）+ O(1) 文本判定，无全文扫描、无新 field。 */
function verticalIntoMath(view, dir) {
  const st = view.state;
  const sel = st.selection.main;
  if (!sel.empty) return false;
  const spans = st.field(mathSpansField, false)?.spans;
  if (!spans || !spans.length) { mathPass = null; return false; }
  const cur = st.doc.lineAt(sel.head);
  const col = sel.head - cur.from;
  const rec = spans.find((x) => x.display && x.tex && sel.head >= x.from && sel.head <= x.to) || null;
  // 【目标列纪律·2026-10-07 实测缺陷修复】目标列只在**新一轮纵向移动**时采集一次；
  // 之后即使某一步被钳到短行行尾（或走过内容内部的原生移动），目标列也不改写——
  // 否则"到底了再往回走"回不到原列。
  // 实测（修前）：起点 col30 → ↑↑（穿块）→ 落"短行。"行尾(col3) → ↓↓ → 停在 **col3**，原列 30 永久丢失；
  // 多行内容块：起点 col2 → 逐行走过内容 → 出块落 col5（内容末列被当成了新目标列）。
  // 判定"同一轮"：光标仍在我们上一次落点上，**或**仍停在记着的那个块内（原生在块内走也算同一轮）。
  const sameRun = mathPass && (mathPass.lastPos === sel.head || (rec && rec.from === mathPass.spanFrom));
  const goalCol = sameRun ? mathPass.goalCol : col;

  // ③ 出块：已在块**内容**的首行（↑）/ 末行（↓）→ 越过围栏，直接到块外相邻行，列用**目标列**。
  //    【为何要越过围栏】围栏行（`$$`）是块的装饰边界，不是内容：Typora 实机里它们根本不参与停靠
  //    （第一跳落内容行末、第二跳直接出块）。把它们当停靠点会让"穿过一个 3 行块"要按 4 次。
  if (rec) {
    const s = rec;
    {
      const openLine = st.doc.lineAt(s.from);
      const closeLine = st.doc.lineAt(s.to);
      // Entry and exit use the same normalized TeX body, including quote leads,
      // trimmed whitespace and formulas with text on a delimiter line.
      const first = st.doc.lineAt(mathSourcePosition(s, 0)).number;
      const last = st.doc.lineAt(mathSourcePosition(s, s.tex.length)).number;
      const exitUp = dir < 0 && cur.number === first;
      const exitDown = dir > 0 && cur.number === last;
      if (exitUp || exitDown) {
        const targetNo = exitUp ? openLine.number - 1 : closeLine.number + 1;
        if (targetNo >= 1 && targetNo <= st.doc.lines) {
          const t = st.doc.line(targetNo);
          const pos = t.from + Math.min(goalCol, t.length);
          mathPass = { spanFrom: s.from, goalCol, lastPos: pos };
          view.dispatch({ selection: { anchor: pos }, userEvent: "select.vertical", scrollIntoView: true });
          return true;
        }
      }
    }
  }

  let best = null;
  for (const s of spans) {
    if (!s.display || !s.tex) continue;
    const above = dir < 0 && s.to <= cur.from;
    const below = dir > 0 && s.from >= cur.to;
    if (!above && !below) continue;
    if (!best || (dir < 0 ? s.to > best.to : s.from < best.from)) best = s;
  }
  if (!best) return false;
  const gapFrom = dir < 0 ? best.to : cur.to;
  const gapTo = dir < 0 ? cur.from : best.from;
  const gap = gapTo > gapFrom ? st.doc.sliceString(gapFrom, gapTo) : "";
  if (gap.trim() !== "" || (gap.match(/\n/g) || []).length > 1) return false;
  // ② 进块（近端规则，落**内容**而非围栏）：从下方来 → 内容末；从上方来 → 内容首。
  // The existing source map locates the TeX body, rather than its delimiters.
  const pos = mathSourcePosition(best, dir < 0 ? best.tex.length : 0);
  mathPass = { spanFrom: best.from, goalCol, lastPos: pos };
  view.dispatch({ selection: { anchor: pos }, userEvent: "select.vertical", scrollIntoView: true });
  return true;
}
let mathPass = null; // { spanFrom, goalCol, lastPos }：本轮纵向移动穿过的块 + 目标列 + 上次落点
let blockPassDir = 0; // 上一个纵向方向（±1）：方向一变就重采目标列（见 verticalIntoMermaid 的实测缺陷）
const verticalSelection = Annotation.define();
const verticalIntentDiag = { keys: 0, cleared: 0, native: 0, custom: 0, resets: 0 };
const verticalInputIntent = Prec.highest(EditorView.domEventHandlers({
  keydown(event, inputView) {
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      inputView.__mpVerticalInput = true;
      verticalIntentDiag.keys++;
      queueMicrotask(() => { inputView.__mpVerticalInput = false; verticalIntentDiag.cleared++; });
    }
    return false;
  },
}));
const nativeVerticalIntent = EditorState.transactionExtender.of(tr => {
  if (view?.__mpVerticalInput && tr.selection && !tr.docChanged &&
    tr.annotation(Transaction.userEvent) === 'select') {
    verticalIntentDiag.native++;
    return { annotations: verticalSelection.of(true) };
  }
  return null;
});

/** 纵向移动进/出**图表块**（与 `verticalIntoMath` 同一套纪律，2026-10-11 补）
 *  为什么需要：块级 widget 是 replace 装饰 ⇒ CM6 的纵向落点在 widget 区域只映射到它的边界、
 *  不会进 span ✗。**实测基线**（`probe-mermaid-nav.cjs`，产物 6904e8e5b49e765f）：
 *   · 图表块下一行按 ↑ ⇒ 直接落到块**上一行**（整块跳过 ✗）；
 *   · 图表块上一行按 ↓ ⇒ 直接落到块**下一行**（整块跳过 ✗）；
 *   · 块内首行 ↑ ⇒ 停在**围栏行**（` ```mermaid ` ✓ 在块内 ✓）；块内末行 ↓ ⇒ 停在收尾围栏 ✗
 *     —— 与块公式的既有契约不一致（围栏是**装饰边界，不作纵向停靠点** ✓，见 verticalIntoMath 的模型 W′）。
 *  纪律（照抄块公式那三条 ✓）：
 *   · 进块落**内容**近端（↑ 从下方来 → 内容末行末；↓ 从上方来 → 内容首行首）；
 *   · 出块越过围栏，直接到块外相邻行；
 *   · **目标列**用"经过前"的值（复用同一个 mathPass 记录 ⇒ 穿过图表块也不丢列 ✓）。
 *  闸门：仅折叠光标；仅当中间只有空白且不超过一个换行（真·视觉相邻）；否则返回 false 交回默认。
 *  性能：只读已有的 `mermaidBlocksField`（O(块数)）+ O(1) 文本判定，**不进每键路径** ✓。 */
function verticalIntoMermaid(view, dir) {  const st = view.state;
  const sel = st.selection.main;
  if (!sel.empty) return false;
  /* 【★ 值的形态·2026-10-11 实测打脸】我原先写成 `st.field(mermaidBlocksField, false)?.blocks` ✗ ——
     而这个字段的值**就是数组本身** ✓（`create` 返回 `scanMermaidBlocks(doc)` ✓，
     见 L366 `for (const b of state.field(mermaidBlocksField, false) || [])` ✓）。
     ⇒ `?.blocks` 恒 undefined ⇒ **整个函数在第一道闸门就 return false** ✗，
     表现是"改了等于没改、读数一字未变" ✗（错-27 的指纹，错-35 的根因：照抄同族时没核对值的形态 ✓）。 */
  const blocks = st.field(mermaidBlocksField, false);
  if (!blocks || !blocks.length) return false;
  const cur = st.doc.lineAt(sel.head);
  const col = sel.head - cur.from;
  /* 【"在块内"必须按**当下**判·2026-10-11 实测缺陷，最隐蔽的一处】
     我原先用 `mathPass ? blocks.find(x => x.from === mathPass.spanFrom) : null` 当 rec ✗ ——
     那是"**上一轮**记的块" ✗，不是"光标此刻在哪个块里" ✗。
     表现（实测 A2 臂 `1:0` 起连按两次 ↓）：第一跳进块落到内容首行(3) ✓，
     **第二跳**在块内按下时 `rec` 为 null ⇒ 直接走"进块"分支 ⇒ 又被送回**近端**内容首行(3) ✗
     ⇒ 光标在块内**卡住**（3 与 4 之间来回 ✗）。10-07 那版块公式靠"记录一定还在"侥幸没暴露 ✗。
     修法：按**光标位置**找当下所在的块 ✓；`mathPass` 只用来判"是不是同一轮"（目标列纪律）✓。 */
  const cur0 = blocks.find((x) => sel.head > x.from && sel.head < x.to) || null;
  const rec = cur0 || (mathPass ? blocks.find((x) => x.from === mathPass.spanFrom) : null);
  /* 【方向反转必须重采目标列·2026-10-11 实测缺陷】原判据只看"是不是同一轮"✗ ——
     而**同方向连按**与**中途反转方向**在它眼里一样 ✓ ⇒ 反转时沿用了另一个方向留下的目标列 ✗。
     实测（A6 臂）：2:0 起 ↓ 进块到 4:0 ✓，再 ↑ 原路返回却从 **4:17** 开始走（列 17 = 出块时的内容末列 ✗）。
     修法：记一个"上一个方向"，**方向一变就重采目标列** ✓（与 Typora"新一轮纵向移动才采集"同一语义 ✓）。 */
  const sameRun = dir === blockPassDir && mathPass && rec && (mathPass.lastPos === sel.head || (sel.head >= rec.from && sel.head <= rec.to));
  blockPassDir = dir;
  const goalCol = sameRun ? mathPass.goalCol : col;
  /* 【只读观测·2026-10-11】A6 臂发现"下行进入时列 0、原路返回时却按列 17 走" ✗ ⇒
     要判"是记错了还是读错了"，必须把每一步的 {方向, 当前列, 是否同一轮, 目标列} 记下来 ✓
     （不猜 ✗）。只 push 进数组，不改任何行为 ✓。 */
  try {
    window.__navTrace = window.__navTrace || [];
    window.__navTrace.push({
      向: dir < 0 ? '上' : '下', 行: cur.number, 列: col, 同轮: !!sameRun, 目标列: goalCol,
      /* 【出块分支的三个输入都要记·2026-10-11】A6 臂的"6:0 ↑ 却落 4:17"要靠它们分辨是
         "方向反转没重采"还是"落点表达式用了行末" ✗ —— 只记落点看不出输入 ✗。 */
      在块内: cur0 ? (st.doc.lineAt(cur0.from).number + '-' + st.doc.lineAt(cur0.to).number) : null,
      本轮块: rec ? (st.doc.lineAt(rec.from).number + '-' + st.doc.lineAt(rec.to).number) : null,
      出块: rec ? (dir < 0 ? (cur.number === (st.doc.lineAt(rec.from).number === st.doc.lineAt(rec.to).number ? st.doc.lineAt(rec.from).number : st.doc.lineAt(rec.from).number + 1)) : (cur.number === (st.doc.lineAt(rec.from).number === st.doc.lineAt(rec.to).number ? st.doc.lineAt(rec.to).number : st.doc.lineAt(rec.to).number - 1))) : null,
    });
    if (window.__navTrace.length > 60) window.__navTrace.shift();
  } catch { }

  /* ① 出块：已在块**内容**首行（↑）/ 末行（↓）⇒ 越过围栏，落块外相邻行 ✓ */
  if (rec) {
    const openLine = st.doc.lineAt(rec.from);
    const closeLine = st.doc.lineAt(rec.to);
    const oneLine = openLine.number === closeLine.number;
    const first = oneLine ? openLine.number : openLine.number + 1;
    const last = oneLine ? closeLine.number : closeLine.number - 1;
    const exitUp = dir < 0 && cur.number === first;
    const exitDown = dir > 0 && cur.number === last;
    if (exitUp || exitDown) {
      const targetNo = exitUp ? openLine.number - 1 : closeLine.number + 1;
      if (targetNo >= 1 && targetNo <= st.doc.lines) {
        const t = st.doc.line(targetNo);
        const pos = t.from + Math.min(goalCol, t.length);
        mathPass = { spanFrom: rec.from, goalCol, lastPos: pos };
        view.dispatch({ selection: { anchor: pos }, userEvent: "select.vertical", scrollIntoView: true });
        return true;
      }
    }
  }

  /* ② 进块：找竖直相邻的那个块（↑ 取下方最近的、↓ 取上方最近的），中间只允许空白 + ≤1 个换行 ✓
     【已在块内 ⇒ 绝不走"进块"·2026-10-11 实测缺陷，两处都踩过】
     出块规则只覆盖"在内容首行 ↑ / 内容末行 ↓" ✗；其余情况落到这条分支就会被送回**近端** ✗：
      · 光标在**内容中间**（实测 A2：在内容首行(3)按 ↓）⇒ 3↔4 反复 ✗；
      · 刚从块外进块后**立刻反向**（实测 A6：`7:0` ↑ 进块到 `4:17`，再 ↑）⇒ 又被送回内容末行末(4:17) ✗
        ⇒ 列从 0 被带到 17，再往上一路带偏（3:12 → 1:4 ✗）。
     【闸门只能按"光标**当下**在不在块里" ·2026-10-11 第三次修正】
     我先用 `cur0`（实测 A2：块内按 ↓ 被送回近端 ✗）✓，再加 `rec` ✗ ——
     结果"刚从块里出来、又往回走"也被挡住，交给 CM6 原生 ⇒ 落**行尾**（实测 `6:0` ↑ 落 `4:14` ✗）。
     正解：**只看 `cur0`** ✓ —— 光标在块内 ⇒ 交原生（行内/穿块都对 ✓）；
     光标在块外 ⇒ 才允许进块，且落点**按目标列钳制** ✓（见下面 pos 的算法 ✓）。 */
  if (cur0) return false;
  let best = null;
  for (const b of blocks) {
    const above = dir < 0 && b.to <= cur.from;
    const below = dir > 0 && b.from >= cur.to;
    if (!above && !below) continue;
    if (!best || (dir < 0 ? b.to > best.to : b.from < best.from)) best = b;
  }
  if (!best) return false;
  const gapFrom = dir < 0 ? best.to : cur.to;
  const gapTo = dir < 0 ? cur.from : best.from;
  const gap = gapTo > gapFrom ? st.doc.sliceString(gapFrom, gapTo) : "";
  if (gap.trim() !== "" || (gap.match(/\n/g) || []).length > 1) return false;
  const openLine = st.doc.lineAt(best.from);
  const closeLine = st.doc.lineAt(best.to);
  const oneLine = openLine.number === closeLine.number;
  /* 落**内容**近端（不是围栏）：单行形态没有独立内容行 ⇒ 退化为落块首/末 ✓。
     【必须**按目标列钳制**·2026-10-11 实测缺陷】我原先写 `closeLine.from - 1`（＝**内容末行的行尾**）✗
     —— 而 CM6 原生纵向移动是**保列**的 ✓ ⇒ 实测（A6 同向臂）：
     从 `7:0` ↑ 进块落 `4:17`（行尾）✗ ⇒ 再 ↑ 时目标列被重采成 **17** ⇒ 一路带偏到 `1:4`（原列 0 丢了 ✗）。
     这与出块分支的口径也不一致（出块是 `t.from + Math.min(goalCol, t.length)` ✓）。
     统一成"目标列 + 钳到该行长度" ✓ ⇒ 列在穿块前后**逐位不丢** ✓。 */
  /* 【落点要按"**内容末行**"的长度钳制,不是围栏行·2026-10-11 实测缺陷(第四次修正)】
     我原先写 `st.doc.lineAt(best.to)` ✗ —— 那是**收尾围栏所在行** ✓（长度 3 ✗），
     而落点在**内容末行**（长度 14 ✓）⇒ 钳制算到围栏行尾 ⇒ 落点落在内容末行的行尾 ✗
     （实测：`6:0` ↑ 进块落 `4:14` 而不是 `4:0` ✗，随后目标列被重采成 14 ⇒ 一路带偏 ✗）。
     修法：取 `closeLine.number - 1`（内容末行 ✓）；单行形态没有独立内容行 ⇒ 用该行 ✓。 */
  const lastContentLine = oneLine ? closeLine : st.doc.line(Math.max(1, closeLine.number - 1));
  const landUp = lastContentLine;
  const landDown = st.doc.lineAt(openLine.to + 1);
  const pos = dir < 0
    ? (oneLine ? best.to : closeLine.from - 1 - (landUp.length - Math.min(goalCol, landUp.length)))
    : (oneLine ? best.from : openLine.to + 1 + Math.min(goalCol, landDown.length));
  /* 【进块后记着的目标列必须是"进块前那一列"·2026-10-11 实测缺陷】
     原写法记 `goalCol`＝进块时采到的列 ✓；但向上进块**落点是内容末行的行尾** ✓ ⇒
     紧接着反向（或出块）时按"内容末列"走 ✗（实测同向臂：`7:0` ↑ 进块落 `4:17` ✗
     ⇒ 再 ↑ 目标列被重采成 17 ⇒ 一路带偏到 `1:4`，原列 0 永久丢失 ✗，与块公式"列不许被吃掉"的契约相反 ✗）。
     修法：进块时**把进块前的列记为 goalCol** ✓ ⇒ 出块时按原列落点 ✓（穿块前后逐位不丢 ✓）。 */
  mathPass = { spanFrom: best.from, goalCol: col, lastPos: pos };
  try {
    window.__navTrace = window.__navTrace || [];
    window.__navTrace.push({
      进块: true, 方向: dir < 0 ? '上' : '下',
      块: st.doc.lineAt(best.from).number + '-' + st.doc.lineAt(best.to).number,
      oneLine, openLineTo: openLine.to, openLen: openLine.length,
      closeLineFrom: closeLine.from, closeLen: closeLine.length,
      目标列: goalCol, landUpLen: landUp.length, landDownLen: landDown.length,
      算出落点: st.doc.lineAt(pos).number + ':' + (pos - st.doc.lineAt(pos).from),
    });
    if (window.__navTrace.length > 60) window.__navTrace.shift();
  } catch { }
  view.dispatch({ selection: { anchor: pos }, userEvent: "select.vertical", scrollIntoView: true });
  return true;
}
/** 纵向键的统一入口：**先块公式、再图表块**（两类块可混排在一篇文档里 ✓；
 *  先判块公式是因为它的 matcher 更窄（`$$…$$`）⇒ 命中即确定，不会与图表块抢 ✓）。 */
function verticalIntoBlock(view, dir) {
  /* 【自证·2026-10-11】错-27 升格：新增/改动的分支必须能证明"**进得去**" ✓。
     修后第一轮读数与修前**一字未变** ⇒ 第一嫌疑是这段没被调用 ✗（而不是参数不对 ✗）。 */
  try { window.__vBlock = (window.__vBlock || []); window.__vBlock.push({ dir, n: (window.__vBlock.length + 1) }); if (window.__vBlock.length > 50) window.__vBlock.shift(); } catch { }
  const a = verticalIntoMath(view, dir);
  try { if (a) { window.__vBlockHit = (window.__vBlockHit || 0) + 1; window.__vBlockLast = 'math'; } } catch { }
  if (a) return true;
  const b = verticalIntoMermaid(view, dir);
  try { if (b) { window.__vBlockHit = (window.__vBlockHit || 0) + 1; window.__vBlockLast = 'mermaid'; } } catch { }
  return b;
}
const blockVerticalKeys = Prec.high(keymap.of([
  { key: "ArrowUp", run: (v) => verticalIntoBlock(v, -1) },
  { key: "ArrowDown", run: (v) => verticalIntoBlock(v, 1) },
]));
/* 【2026-10-11 合并】原先这里还有一份 `mathVerticalKeys`（只处理块公式）✗ ——
   `blockVerticalKeys` 已经**包含**它（先块公式、再图表块）✓，两份键位都注册会互相遮蔽 ✗
   ⇒ 只保留 `blockVerticalKeys` 一份 ✓（错-4：同功能不许留两份实现 ✓）。 */
/* ══ 行级样式（标题 WYSIWYG 投影＋代码围栏/引用块行类）══
 *  标题：井号阅读态隐藏、光标入行显源码（F7 同构）；行类 mp-h1..mp-h6 承担
 *  telari 字号/字重/下边线。代码围栏行 mp-code、引用行 mp-quote 同场扫描。 */

function scanLineStyles(doc, blocks = scanFencedBlocks(doc), structure = null) {
  const headings = [];
  const styled = []; // { line, cls }
  const hrs = []; // 水平分割线（---/***/___ 整行）
  const fenceLines = []; // ``` 围栏行（阅读态压扁隐藏）
  const codeLines = [];  // 【代码块行号】{ line, n }——**内容行**（不含围栏符本身），n 从 1 起、每块重数
  let codeN = 0;         // 当前代码块的计数（进块清 0，出块也清 0 ⇒ 每个块各自从 1 开始）
  let mathPending = false; // 正在一个 `$$…` 待闭合块内（居中稳定用，见下）
  let from = 0;
  for (const t of doc.iterLines()) {
    const code = blockAt(blocks, from);
    if (code) {
      const line = doc.lineAt(from);
      const qClass = code.depth ? ' mp-quote mp-quote-d' + Math.min(3, code.depth) : '';
      styled.push({ line, cls: 'mp-code' + qClass });
      if (line.from === code.from || line.from === code.closeFrom) { fenceLines.push(line); codeN = 0; }
      else { codeLines.push({ line, n: ++codeN }); }
      mathPending = false;
      from += t.length + 1;
      continue;
    }
    // 【居中稳定·2026-10-07】块公式**围栏行/待闭合行**也挂 mp-math-src：
    // 渲染态（KaTeX displayMode）是居中，源码展开也必须居中；若只在"span 被识别"时才居中，
    // 打字过程中会出现"居中↔左对齐"横跳（实测：单独 `$$` 左对齐、配对后居中、再补 `$$` 变
    // `$$$$` 又退回左对齐）。判据与 scanMathSpans 同源但只做首尾轻判，**塞进本次已有遍历**，
    // 不新增全文扫描（性能纪律）。
    const tt = t.trim();
    if (mathPending) {
      styled.push({ line: doc.lineAt(from), cls: "mp-math-src" });
      // 收尾行 或 **空行** → 结束待闭合态（否则一个手滑的 `$$` 会把其后全文都居中；
      // 真正已闭合的多行块由 buildBlockMath 按 span 逐行居中，不依赖这里）
      if (tt === "" || (tt.endsWith("$$") && tt.length >= 2)) mathPending = false;
    } else if (/^\s*\$\$/.test(t) && !/^\s*\$\$.*\$\$\s*$/.test(t)) {
      styled.push({ line: doc.lineAt(from), cls: "mp-math-src" });
      mathPending = true;
    } else if (/^\s*\$\$/.test(t)) {
      // 只有**行首**就是 $$ 的行才居中（`$$x$$`、`$$…` 开围栏）。
      // 【2026-10-07 紧急修正】原判据还含 `endsWith("$$")` ⇒ 正文段落只要行尾出现
      // `$$s$$` 就整行居中（用户实测：一整段「终章底本…（见附录 A）。$$s$$」全被居中）＝重大衰退。
      // 行尾收尾的围栏行由"待闭合态/已识别 span"覆盖，不需要靠 endsWith 兜。
      styled.push({ line: doc.lineAt(from), cls: "mp-math-src" });
    }
    const hm = /^( {0,3})(#{1,6})([ \t]+|$)/.exec(t);
    if (hm) {
      headings.push({ from: from + hm[1].length, to: from + hm[1].length + hm[2].length + (hm[3] ? 1 : 0), level: hm[2].length });
      styled.push({ line: doc.lineAt(from), cls: 'mp-h' + hm[2].length });
      from += t.length + 1;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(t)) { hrs.push(doc.lineAt(from)); from += t.length + 1; continue; }
    const semanticDepth = structure ? structuralContextAt(structure, from).path.filter(p => p.kind === 'quote').length : quoteLead(t).depth;
    if (semanticDepth) {
      // 【A7-D4】嵌套引用分级：> 计数→d1/d2/d3+（缩进递进；竖线由主类画一条）
      const depth = Math.min(3, semanticDepth);
      styled.push({ line: doc.lineAt(from), cls: "mp-quote mp-quote-d" + Math.max(1, depth) });
    }
    from += t.length + 1;
  }
  return { headings, styled, hrs, fenceLines, codeLines };
}
function mapLineStyles(value, tr) {
  const map = p => tr.changes.mapPos(p, 1), line = l => tr.state.doc.lineAt(map(l.from));
  return {
    headings: value.headings.map(h => ({ ...h, from: map(h.from), to: map(h.to) })),
    styled: value.styled.map(s => ({ ...s, line: line(s.line) })),
    hrs: value.hrs.map(line), fenceLines: value.fenceLines.map(line),
    codeLines: value.codeLines.map(c => ({ ...c, line: line(c.line) })),
  };
}
const lineStylesField = StateField.define({
  create(state) {
    const blocks = state.field(markdownContext).blocks;
    return scanLineStyles(state.doc, blocks, state.field(markdownContext));
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    const context = tr.state.field(markdownContext);
    let touched = context.rebuilt || !tr.state.field(editPlan);
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      if (touched) return;
      if (/[`|#>$~*_\-\n\r]/.test(tr.startState.doc.sliceString(fromA, toA)) || /[`|#>$~*_\-\n\r]/.test(inserted.toString())) touched = true;
    });
    return touched ? scanLineStyles(tr.state.doc, context.blocks, context) : mapLineStyles(value, tr);
  },
});

/* ── 表数据层（从 lineStylesField 拆出的窄字段）──
 *  tableDecorations 依赖 tableDataField、activeCell/tableSelection 与窄 separator 展示状态。
 *  create 只在初始化时 scanTables 一次；update 只在 docChanged 时执行。
 *  touched 集合：markdownContext.rebuilt / 无 editPlan / 结构字符 / 与任一表范围相交 /
 *  **变更触达的 old/new 行可能是表行或表分隔行**（有限行局部 guard，见下）。
 *  非结构且不触表：无表位移返回原 tables 数组（身份稳定）；表位移则映射 table.from/to、
 *  headerBlock.from/to 与每个 rows[].from/to，并做位置校验；校验失败返回 null → 调用方
 *  安全全量重扫。本字段绝不读 regionIndexField。
 *  局部 guard 只决定“是否重扫”，不是 parser：actual scanTables 仍是唯一渲染判据。 */
function isPotentialTableLine(text) {
  const raw = String(text == null ? '' : text);
  if (raw.includes('|')) return true;
  return isSeparatorBody(raw.slice(tableLead(raw).off));
}
function locallyTouchesTableSurface(doc, from, to) {
  const len = doc.length;
  const first = doc.lineAt(Math.max(0, Math.min(from, len))).number;
  const last = doc.lineAt(Math.max(0, Math.min(to, len))).number;
  for (let n = first; n <= last; n++) if (isPotentialTableLine(doc.line(n).text)) return true;
  return false;
}
function mapTables(tables, tr) {
  const map = p => tr.changes.mapPos(p, 1);
  let shifted = false;
  const next = [];
  for (const t of tables) {
    const from = map(t.from), to = map(t.to);
    if (from === t.from && to === t.to && typeof tr.changes.touchesRange === 'function' && tr.changes.touchesRange(t.from, t.to) === false) { next.push(t); continue; }
    const hFrom = map(t.headerBlock.from), hTo = map(t.headerBlock.to);
    const rows = t.rows.map(r => ({ ...r, from: map(r.from), to: map(r.to) }));
    const rowsSame = rows.length === t.rows.length && rows.every((r, i) => r.from === t.rows[i].from && r.to === t.rows[i].to);
    if (from === t.from && to === t.to && hFrom === t.headerBlock.from && hTo === t.headerBlock.to && rowsSame) { next.push(t); continue; }
    shifted = true;
    next.push({ ...t, from, to, headerBlock: { ...t.headerBlock, from: hFrom, to: hTo }, rows });
  }
  if (!shifted) return tables;
  /* map-validation-start: safe rescan fallback; never trust a shifted map blindly. */
  const len = tr.state.doc.length; let prevTo = -1;
  for (const t of next) {
    if (!(Number.isInteger(t.from) && Number.isInteger(t.to) && t.from >= 0 && t.to <= len && t.from <= t.to)) return null;
    if (!t.headerBlock || t.headerBlock.from !== t.from || !Number.isInteger(t.headerBlock.to) || t.headerBlock.from > t.headerBlock.to || t.headerBlock.to > t.to) return null;
    if (t.from < prevTo) return null;
    let prev = t.headerBlock.to;
    for (const r of t.rows) {
      if (!(Number.isInteger(r.from) && Number.isInteger(r.to) && r.from >= prev && r.to >= r.from && r.to <= t.to)) return null;
      prev = r.to;
    }
    if (t.to !== (t.rows.length ? t.rows[t.rows.length - 1].to : t.headerBlock.to)) return null;
    prevTo = t.to;
  }
  /* map-validation-end */
  return next;
}
const tableDataField = StateField.define({
  create(state) { return scanTables(state.doc, state.field(markdownContext).blocks); },
  update(tables, tr) {
    if (!tr.docChanged) return tables;
    const context = tr.state.field(markdownContext);
    let touched = context.rebuilt || !tr.state.field(editPlan);
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      if (touched) return;
      if (/[`|#>$~*_\-\n\r]/.test(tr.startState.doc.sliceString(fromA, toA)) || /[`|#>$~*_\-\n\r]/.test(inserted.toString()) ||
          tables.some(t => fromA <= t.to && toA >= t.from) ||
          locallyTouchesTableSurface(tr.startState.doc, fromA, toA) ||
          locallyTouchesTableSurface(tr.state.doc, fromB, toB)) touched = true;
    });
    if (touched) return scanTables(tr.state.doc, context.blocks);
    const mapped = mapTables(tables, tr);
    return mapped === null ? scanTables(tr.state.doc, context.blocks) : mapped;
  },
});

/* ── 表格投影（行级粒度，Typora 交互方向）：每行独立块 widget──
 *  点击单元格 → 该行显源码＋光标落该格源码位；表头与其余行保持渲染。
 *  列宽按全表内容长度比例分配（各行列宽一致，视觉对齐）。 */
function parseTableRow(t, off = 0) {
  /* 【2026-10-08 修】**别再用 `^(\s*)(\|)?(.*?)(\|)?\s*$` 那版贪婪/懒惰混搭**：
     由于 `(.*?)` 懒惰、末尾 `(\|)?` 可选，引擎会一路吃到**最后一个**管道才收尾
     ⇒ 前缀剥掉后的 `| a | b |` 被切成 `['>','a','b']`（第 0 格凭空多出引用记号；
     实测截图：引用区表格首列印着 `>`）。现在与 `cellRangesOf` 同构：
     显式剥前导管道，再从后往前剥尾随管道，中间按**未转义**的 `|` 切分。
     `off`＝引用前缀宽度（前缀不是格内容）。 */
  const body = t.slice(off);
  /* 【必须有裸管道】GFM 里"只有一格的表"不存在；这一条也是**收块的上界**：
     没有它，表后面那行普通文字（`尾段。`）会被吃进表里变成一个空表行
     （复核实测：cellmap 探针 6 格异常、末行的 dataset 变成表格外的行号）。 */
  if (!/(?<!\\)\|/.test(body)) return null;
  const leadM = /^\s*\|/.exec(body);
  const s = leadM ? leadM[0].length : 0;
  let e = body.length;
  while (e > s && /\s/.test(body[e - 1])) e--;
  if (e > s && body[e - 1] === "|" && body[e - 2] !== "\\") e--;
  const mid = body.slice(s, e);
  return { lead: off + s, cells: mid.split(/(?<!\\)\|/).map((c) => c.trim()) };
}
/** 【引用区表格·2026-10-08】**表块前缀**：判定点统一在 `tables.js` 的 `tableLead`
 *  （渲染层 / 源码键位 / 扩展包的行列命令三处必须同源，否则引用区表格在某一层仍被当普通段落）。 */
function tablePrefix(t) {
  return tableLead(t);
}
function scanTables(doc, blocks = scanFencedBlocks(doc)) {
  let hasPipe = false;
  for (const t of doc.iterLines()) {
    if (t.includes("|")) { hasPipe = true; break; }
  }
  if (!hasPipe) return [];
  const tables = [];
  /* 分隔行判据与 tables.js / 扩展包**同源**（含 en/em dash，见 tables.js 的说明）。 */
  const isSep = (t) => isSeparatorBody(t);
  let i = 1;
  while (i <= doc.lines) {
    const line1 = doc.line(i);
    const code = blockAt(blocks, line1.from);
    if (code) { i = code.endLine + 1; continue; }
    const p1 = tablePrefix(line1.text);
    const header = parseTableRow(line1.text, p1.off);
    const line2 = header && header.cells.length > 0 && i + 1 <= doc.lines ? doc.line(i + 1) : null;
    const p2 = line2 ? tablePrefix(line2.text) : null;
    if (header && header.cells.length > 0 && line2 && !blockAt(blocks, line2.from) && p2.q === p1.q && isSep(line2.text.slice(p2.off))) {   // 单列表合法（TBL-7）
      const cols = header.cells.length;
      /* 【β2·对齐数据层】分隔行**本来就在手上**（line2）⇒ 顺手派生每列对齐，不新增扫描。
         SEP_ALIGN：`:…:`⇒center、`…:`⇒right、`:…`⇒left、`---`⇒null（未标注）。
         null 的语义＝"用户没写冒号"：渲染按左，但源码一个字节都不动（点"左"＝无操作）。 */
      const sepCells = line2.text.slice(p2.off).trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());
      const aligns = [];
      for (let c = 0; c < cols; c++) {
        const cell = sepCells[c] || "";
        const hasL = cell.startsWith(":"), hasR = cell.length > 1 && cell.endsWith(":");
        aligns[c] = hasL && hasR ? "center" : hasR ? "right" : hasL ? "left" : null;
      }
      /* 【回归修复·2026-10-08】普通表**没有**引用前缀（p1.q === ''）⇒ 层级必须是 0（＝不加 mp-table-quote）。
         改前写的是 Math.max(1, …) ⇒ **普通表也被算成 qDepth=1**，于是所有表格 widget 都套上了引用竖条+引用底色
         （验收清单 3.13 截图实锤：普通表与引用表肉眼分不出）。有前缀时才按 > 个数分级（1–3）。 */
      const depth = p1.q ? Math.min(3, Math.max(1, (p1.q.match(/>/g) || []).length)) : 0;
      const headerBlock = { from: line1.from, to: line2.to, cells: header.cells, isHeader: true,
        lead: header.lead, qDepth: depth, qOff: p1.off, qText: p1.q };
      const rows = [];
      let j = i + 2;
      while (j <= doc.lines) {
        const rl = doc.line(j);
        if (blockAt(blocks, rl.from)) break;
        const pr = tablePrefix(rl.text);
        if (pr.q !== p1.q) break;                       // 引用层级变了 ⇒ 不是同一张表
        const parsed = parseTableRow(rl.text, pr.off);
        if (!parsed) break;
        rows.push({ from: rl.from, to: rl.to, cells: parsed.cells, isHeader: false, lead: parsed.lead, qDepth: depth, qOff: pr.off, qText: pr.q });
        j++;
      }
      /* 列宽：按**显示宽度**（`displayWidth`，见 tables.js）取"表头与所有行的最大值"，
         再用 `fitWidths` 把下限摊回去。旧口径数源码字符 ⇒ TeX 长格把中文列挤成 89px（3.0.5 用户截图）。 */
      const weights = [];
      for (let c = 0; c < cols; c++) {
        let weight = Math.max(2, displayWidth(header.cells[c] || ""));
        for (const row of rows) weight = Math.max(weight, displayWidth(row.cells[c] || ""));
        weights[c] = weight;
      }
      const widths = fitWidths(weights);
      const total = weights.reduce((a, b) => a + b, 0) || 1;
      tables.push({ headerBlock, rows, widths, weights, total, cols, aligns, alignKey: aligns.join("|"),
        from: headerBlock.from, to: rows.length ? rows[rows.length - 1].to : headerBlock.to });
      i = j;
      continue;
    }
    i++;
  }
  return tables;
}
/** 行内各格的**源码区间**（未 trim 原文段，编辑镜像的落点）
 *  【引用区表格·2026-10-08】`skip`＝引用前缀宽度：`> | a | b |` 的前两个字符不是格内容，
 *  不跳过去的话第一格会带上 `> `（点格落位、覆盖层文本、导出口径全会歪）。 */
function cellRangesOf(line) {
  const text = line.text;
  /* 【引用区表格】首格区间必须从**引用前缀之后**起算：`> | a | b |` 若从 0 起算，
     第 0 格的源码区间就是 `> `（渲染出来首列印着引用记号、点格落位也偏）。
     ⚠ 前缀宽度只在这里算一次（调用方不要再传 skip，否则会与这里叠加——实测首格跑出 `>`）。 */
  const start = tableLead(text).off;
  const p = /^\s*\|/.exec(text.slice(start));
  let i = start + (p ? p[0].length : 0);
  const ranges = [];
  let segStart = i;
  while (i < text.length) {
    if (text[i] === "\\" && text[i + 1] === "|") { i += 2; continue; }
    if (text[i] === "|") {
      ranges.push([line.from + segStart, line.from + i]);
      segStart = i + 1;
    }
    i++;
  }
  /* 【β1·P0-①】与 `tables.js cellRanges` **同步**：末尾段纯空白则丢弃（尾管道后的空白不算格）。
     不修的话覆盖层/点击映射会拿到一个不存在的 col —— `positionCellOverlay` 查不到 td ⇒ display:none。 */
  const tail = text.slice(segStart);
  if (tail.trim()) ranges.push([line.from + segStart, line.from + text.length]);
  return ranges;
}
/** 格内容渲染：HTML 转义＋`$…$` 行内数学（KaTeX 缓存层）。
 *  【2026-10-08 换扫描器】旧写法是一条 `/\\$([^$\\n]+)\\$/g` 正则，三个已知漏点：
 *    · 转义 `\\$` 会被当成定界符（正文里"价格 \\$5"这种写法会把后面整段吞掉）；
 *    · 格内**多行**（粘贴进来的内容）永远不匹配（`[^$\\n]` 排掉了换行）；
 *    · 未闭合的 `$`（用户手写常见）后面的公式全被吃掉。
 *  换成一次线性扫描：支持 `\\$` 转义、定界符内允许换行、未闭合时**原样输出为字面文本**
 *  （宁可显示源码，也不吞掉后面的内容——用户报障里"同格/相邻格公式变字面"就是这条的观感形态）。 */
/**
 * 格内容渲染：HTML 转义 + `$…$` 行内数学（KaTeX 缓存层）+ **`<br>` 白名单（按段处理）**。
 *
 * 【2026-10-08 换扫描器】旧写法是一条 `/\$([^$\n]+)\$/g` 正则，三个已知漏点：
 *   · 转义 `\$` 会被当成定界符（正文里"价格 \$5"这种写法会把后面整段吞掉）；
 *   · 格内**多行**（粘贴进来的内容）永远不匹配（`[^$\n]` 排掉了换行）；
 *   · 未闭合的 `$`（用户手写常见）后面的公式全被吃掉。
 * 换成一次线性扫描：支持 `\$` 转义、定界符内允许换行、未闭合时**原样输出为字面文本**
 * （宁可显示源码，也不吞掉后面的内容 —— 用户报障里"同格/相邻格公式变字面"就是这条的观感形态）。
 *
 * 【β1·格内换行】`<br>` 白名单**按段处理**（`String.split` 带捕获组时命中段落在奇数下标）：
 *   · 放在数学扫描**之前**不行：`$a<br>b$` 会先变成 `$a<br>b$`、被当 TeX 喂给 KaTeX ⇒ 渲染失败返回 null
 *     ⇒ 原样吐回 `<br>` 被当 HTML 解析（视觉上在失败的公式里断行）；
 *   · 放在数学扫描**之后**也不行：KaTeX 成功时会把用户 TeX 里的字面 `<br>` 转义成 `&lt;br&gt;` 写进输出，
 *     再被白名单还原 ⇒ 公式内部被插进换行（可见损坏）。
 *   按段切分后：`<br>` 段直接出真标签、其余段照原样走 esc + 数学扫描 ⇒ 两头都不进 KaTeX。
 *   注意给覆盖层/源码写入的是**字面四个字符** `<br>`（`syncCellEdit` 比对 `textContent`，插 DOM 节点会丢）。
 */
function cellHTML(text) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const attr = s => esc(s).replace(/"/g, '&quot;');
  return renderInline(text, {
    code: source => '<code class="mp-cell-code">' + esc(source) + '</code>',
    math: tex => { const html = renderMathHTML(tex, false); return html == null ? null : '<span class="mp-cm6-math">' + html + '</span>'; },
    image: image => {
      if (image.src == null) return null;
      const src = mpImgSrc(image.src), ref = /^https?:/i.test(src) ? ' referrerpolicy="no-referrer"' : '';
      return '<img class="mp-cell-img" src="' + attr(src) + '" alt="' + attr(image.alt || '') + '"' + ref + '>';
    },
  });
}

/* ══ Excel 式单元格内编辑（Typora 表格交互）══
 *  点格 → 该格变 contenteditable 编辑面（显原文文本＝Excel 编辑格语义），
 *  其余格/行保持渲染（格内数学实时渲染）；input diff 镜像为源码 change；
 *  活动行 widget 的 eq 忽略内容（DOM/焦点/IME 跨键保持）；Tab 换格、
 *  Esc/点外收场、Ctrl+Z 走文档撤销栈。 */
const setActiveCell = StateEffect.define(); // { rowFrom, col } | null
const activeCellField = StateField.define({
  create: () => null,
  update(value, tr) {
    let v = value;
    for (const e of tr.effects) if (e.is(setActiveCell)) v = e.value;
    if (v && tr.docChanged) {
      const rowFrom = tr.changes.mapPos(v.rowFrom);
      if (rowFrom !== v.rowFrom) v = { rowFrom, col: v.col };
      const line = tr.state.doc.lineAt(v.rowFrom);
      if (line.from !== v.rowFrom || !parseTableRow(line.text)) v = null; // 行没了/变形 → 收场
    }
    if (v && value && v.rowFrom === value.rowFrom && v.col === value.col) return value;
    return v;
  },
});
let cellEdit = null; // { text, from, to }：活动格当前镜像（模块级，跨 widget 生命周期）
let cellComposing = false;
let activeCellLayout = null, cellPositionFrame = 0, cellRevealIntent = null, cellMeasureIntent = null;
const cellPositionMeasureKey = {};
function renderedCellLayout(inputView, rowFrom, col, source) {
  const epoch = inputView.state.field(regionIndexField).epoch;
  if (!activeCellLayout || activeCellLayout.epoch !== epoch || activeCellLayout.rowFrom !== rowFrom || activeCellLayout.col !== col) {
    activeCellLayout = { epoch, rowFrom, col, html: cellHTML(mappedCellSource(source).text) };
  }
  return activeCellLayout;
}
function activeCellDOM() {
  const active = view?.state.field(activeCellField, false);
  return active && view.contentDOM.querySelector(`.mp-row [data-mp-row="${active.rowFrom}"][data-mp-col="${active.col}"]`);
}
function updateCellSizer(edit) {
  if (!cellEdit || edit !== cellOverlay?.querySelector('.mp-cell-overlay-text') ||
      cellEdit.epoch !== view?.state.field(regionIndexField).epoch) return;
  const size = activeCellDOM()?.querySelector('.mp-cell-source-size');
  if (size && size.textContent !== edit.textContent) { size.textContent = edit.textContent; view.requestMeasure(); }
}
function scheduleCellOverlay(revealCaret = false) {
  if (!view || !cellEdit) return;
  if (revealCaret) {
    cellRevealIntent = commands.serial();
    if (cellPositionFrame) { cancelAnimationFrame(cellPositionFrame); cellPositionFrame = 0; }
  }
  const owner = view, edit = cellEdit, epoch = owner.state.field(regionIndexField).epoch;
  const owned = () => view === owner && cellEdit === edit && owner.state.field(regionIndexField).epoch === epoch;
  let settleTicket = null;
  const queue = () => {
  if (cellPositionFrame) return;
  cellPositionFrame = requestAnimationFrame(() => {
    cellPositionFrame = 0;
    const reveal = cellRevealIntent; cellRevealIntent = null;
    if (owned()) {
      positionCellOverlay();
      if (reveal !== null && commands.serial() === reveal) {
        const selection = getSelection(), text = cellOverlay?.querySelector('.mp-cell-overlay-text');
        if (document.hasFocus() && document.activeElement === text && text.contains(selection?.focusNode)) {
          const range = document.createRange(); range.setStart(selection.focusNode, selection.focusOffset); range.collapse(true);
          const caret = range.getBoundingClientRect(), sc = owner.scrollDOM, zoom = mpZoomOf(sc), bounds = scrollViewportBounds(sc, zoom);
          let top = bounds.top + 4;
          for (const island of [document.querySelector('.mp-toolbar'), document.querySelector('.mp-table-bar')]) {
            const rect = island?.getBoundingClientRect();
            if (rect?.height > 0 && rect.width > 0 && rect.top < bounds.bottom && rect.bottom > bounds.top &&
                rect.top < Math.max(top + 4, caret.bottom) && caret.right >= rect.left && caret.left <= rect.right &&
                getComputedStyle(island).visibility !== 'hidden') top = Math.max(top, rect.bottom + 4);
          }
          const bottom = bounds.bottom - 4;
          const delta = caret.top < top ? caret.top - top : caret.bottom > bottom ? caret.bottom - bottom : 0;
          if (bottom > top && caret.height > 0 && delta) sc.scrollTop += delta / zoom;
          // A pending CM anchor compensation may follow the first reveal.
          // Only a reveal that moved scroll gets two bounded confirmations;
          // a later trusted pointer/key/wheel invalidates the input serial.
          if (settleTicket && settleTicket.remaining > 0 && (delta || settleTicket.remaining < 2)) {
            settleTicket.remaining--;
            cellRevealIntent = reveal;
            requestReveal(settleTicket);
          }
        }
      }
    }
  });
  };
  const requestReveal = ticket => {
    cellMeasureIntent = ticket;
    // CM may compensate its old scroll anchor after measure-request writes.
    // Position and reveal once in the following frame, after that compensation.
    // Sizer measurement is already pending; the fixed key merges fast inputs.
    owner.requestMeasure({ key: cellPositionMeasureKey, read: () => null,
      write: () => {
        if (cellMeasureIntent !== ticket) return;
        cellMeasureIntent = null;
        const text = cellOverlay?.querySelector('.mp-cell-overlay-text');
        if (owned() && cellRevealIntent === ticket.serial && commands.serial() === ticket.serial &&
            document.hasFocus() && document.activeElement === text) queue();
      },
    });
  };
  if (revealCaret) {
    settleTicket = { serial: cellRevealIntent, remaining: 2 };
    requestReveal(settleTicket);
  } else if (!cellMeasureIntent || cellMeasureIntent.serial !== commands.serial()) queue();
}

const tableRowIndexes = new WeakMap();
const tableRowOrdinals = new WeakMap();
const tableGeometryObservers = new WeakMap();
const tableLayoutSignatures = new WeakMap();
function tableRowGeometry(state, tb, block, isHeader, region) {
  if (!region) return null;
  tableRowIndex(tb);
  const ordinal = isHeader ? 'header' : tableRowOrdinals.get(block);
  if (ordinal === undefined) return null;
  let rows = tableLayoutSignatures.get(tb);
  if (!rows) { rows = new WeakMap(); tableLayoutSignatures.set(tb, rows); }
  let signature = rows.get(block);
  if (!signature) {
    signature = JSON.stringify([block.cells, tb.widths, tb.weights, tb.aligns, tb.headerBlock.qDepth || 0, block.lead || 0]);
    rows.set(block, signature);
  }
  return { key: [state.field(regionIndexField).epoch, region.id, region.contextVersion, ordinal, tb.rows.length, tb.widths.length].join(':'), signature };
}
function cachedTableGeometry(inputView, geometry) {
  const cached = geometry && tableGeometryObservers.get(inputView)?.recent.get(geometry.key);
  return cached?.signature === geometry.signature && cached.generation === mathGeometryVersion ? cached : null;
}
function primeTableGeometry(inputView, cell) {
  if (!cell || !inputView.contentDOM.contains(cell)) return;
  const owner = tableGeometryObservers.get(inputView);
  if (!owner) return;
  const rowFrom = Number(cell.dataset.mpRow), region = regionAt(inputView.state.field(regionIndexField), rowFrom, 'table');
  const tb = region?.data, isHeader = cell.tagName === 'TH';
  const block = tb && (isHeader ? tb.headerBlock : tableRowIndex(tb).get(rowFrom));
  const identity = block && tableRowGeometry(inputView.state, tb, block, isHeader, region);
  if (!identity || cachedTableGeometry(inputView, identity)) return;
  // A cold click or a paint-only preference change may precede RO delivery.
  // Measure only the visible row being handed off, never in a widget getter.
  const wrap = cell.closest('.mp-table-wrap'), table = cell.closest('.mp-row');
  const rect = wrap?.getBoundingClientRect(), scale = mpZoomOf(cell);
  if (!rect || rect.height <= 0 || rect.width <= 0 || !(scale > 0)) return;
  owner.recent.delete(identity.key);
  owner.recent.set(identity.key, { width: rect.width / scale, height: rect.height / scale,
    viewportHeight: rect.height, fittedWidth: table.clientWidth, signature: identity.signature, generation: mathGeometryVersion });
  owner.trim();
}
function observeTableGeometry(inputView, wrap, rowFrom, lease, isHeader, columns, resizeWidth, geometry, fittedWidth) {
  if (!lease || typeof ResizeObserver === 'undefined') return;
  const table = inputView.state.field(regionIndexField).byId.get(lease.id)?.data;
  if (!table) return;
  const ordinal = isHeader ? 'header' : tableRowOrdinals.get(tableRowIndex(table).get(rowFrom));
  if (ordinal === undefined) return;
  // Source offsets change after edits. Geometry belongs to the logical row,
  // while every DOM node still owns its exact current source ranges and lease.
  const key = geometry?.key || [lease.epoch, lease.id, lease.contextVersion, ordinal, table.rows.length, columns].join(':');
  let owner = tableGeometryObservers.get(inputView);
  if (!owner) {
    owner = { active: true, epoch: lease.epoch, nodes: new Set(), sizes: new WeakMap(), recent: new Map(), deliveries: 0, placements: 0, trimPending: false };
    owner.trim = () => {
      const limit = Math.max(256, owner.nodes.size * 2);
      while (owner.recent.size > limit) owner.recent.delete(owner.recent.keys().next().value);
    };
    owner.observer = new ResizeObserver(entries => {
      if (!owner.active || view !== inputView) return;
      owner.deliveries++;
      const changed = [];
      for (const entry of entries) {
        const item = owner.sizes.get(entry.target);
        if (!item || !item.lease.valid()) continue;
        const box = entry.borderBoxSize?.[0] || entry.borderBoxSize;
        const width = box?.inlineSize ?? entry.contentRect.width;
        const height = box?.blockSize ?? entry.contentRect.height;
        const current = inputView.state.field(regionIndexField).byId.get(item.lease.id);
        const tb = current?.data, block = tb && (item.isHeader ? tb.headerBlock : tableRowIndex(tb).get(item.rowFrom));
        const identity = block && tableRowGeometry(inputView.state, tb, block, item.isHeader, current);
        if (!identity || identity.key !== item.key) continue;
        const previous = owner.recent.get(item.key);
        if (width === item.width && height === item.height &&
            previous?.signature === identity.signature && previous.generation === mathGeometryVersion) continue;
        if (width !== item.width) item.resizeWidth?.();
        item.width = width; item.height = height;
        owner.recent.delete(item.key);
        owner.recent.set(item.key, { width, height, viewportHeight: height * inputView.scaleY, fittedWidth: item.fittedWidth?.() ?? null,
          signature: identity.signature, generation: mathGeometryVersion });
        changed.push(item);
      }
      owner.trim();
      if (!changed.length) return;
      const target = tableBarTarget();
      if (!target || !changed.some(item => item.rowFrom >= target.table.from && item.rowFrom <= target.table.to)) return;
      // Floating chrome is outside table layout. Reposition before paint only
      // when a current mounted segment changed; no per-key scan or new scroll.
      owner.placements++;
      positionTableBar();
    });
    tableGeometryObservers.set(inputView, owner);
  }
  owner.active = true;
  if (owner.epoch !== lease.epoch) { owner.epoch = lease.epoch; owner.recent.clear(); }
  const previous = cachedTableGeometry(inputView, geometry);
  if (previous) { owner.recent.delete(key); owner.recent.set(key, previous); }
  owner.nodes.add(wrap);
  owner.sizes.set(wrap, { lease, rowFrom, key, isHeader, resizeWidth, fittedWidth, width: previous?.width ?? null, height: previous?.height ?? null });
  owner.observer.observe(wrap);
  lease.cleanup(() => {
    owner.observer.unobserve(wrap);
    owner.nodes.delete(wrap); owner.sizes.delete(wrap);
    const epoch = inputView.state.field(regionIndexField, false)?.epoch;
    if (epoch !== undefined && owner.epoch !== epoch) { owner.epoch = epoch; owner.recent.clear(); }
    if (!owner.nodes.size) {
      owner.active = false; owner.observer.disconnect();
    }
    // Keep dimensions across synchronous DOM replacements. Empty owners retain
    // at most the small base cache; WeakMap ownership does not retain a view.
    if (!owner.trimPending) {
      owner.trimPending = true;
      queueMicrotask(() => { owner.trimPending = false; owner.trim(); });
    }
  });
}
function tableRowIndex(tb) {
  let index = tableRowIndexes.get(tb);
  if (!index) { index = new Map(tb.rows.map((row,ordinal) => { tableRowOrdinals.set(row,ordinal); return [row.from,row]; })); tableRowIndexes.set(tb,index); }
  return index;
}
const tableFitQueues = new WeakMap();
function scheduleTableFit(inputView, work) {
  let queue = tableFitQueues.get(inputView);
  if (!queue) { queue = new Set(); tableFitQueues.set(inputView, queue); }
  queue.add(work);
  inputView.requestMeasure({ key: queue,
    read: () => {
      const pending = [...queue]; queue.clear();
      return pending.map(item => ({ item, width: item.valid() ? item.table.clientWidth : null }));
    },
    write: measurements => {
      for (const { item, width } of measurements) item.finish(width !== null && item.valid() ? width : null);
    },
  });
  return () => queue.delete(work);
}
class TableRowWidget extends WidgetType {
  constructor(cells, widths, isHeader, ranges, rowFrom, activeCol, qDepth = 0, qLead = 0, weights = null, selKey = "", aligns = null, region = null, geometry = null) {
    super(); this.cells = cells; this.widths = widths; this.isHeader = isHeader;
    this.ranges = ranges; this.rowFrom = rowFrom; this.activeCol = activeCol ?? -1;
    /* 【β1 选择层级】把 "kind:rowFrom:col" 解成三个字段：行/列/整表的高亮由它决定。
       ⚠️ 必须进 eq（"选择变了 ⇒ eq 为 false ⇒ 重建 DOM"）—— A6 的教训是 eq 变真会留陈旧 DOM，
       这里方向相反但要显式写死，别让后来人把它摘掉。 */
    const parts = String(selKey || "").split(":");
    this.selKind = parts[0] || ""; this.selRow = parts.length > 1 ? Number(parts[1]) : NaN; this.selCol = parts.length > 2 ? Number(parts[2]) : NaN;
    this.selKey = String(selKey || "");
    /* 【β2·对齐】alignKey 在构造时算好（不在 eq 里现 join：那会把每键成本搬进 widget 比较）。
       ⚠️ 必须进 eq 的**两个分支**（活动行分支也要）：活动行 eq 变真 ⇒ toDOM 不跑 ⇒ 只有活动行停在旧对齐。 */
    this.aligns = aligns || null;
    this.alignKey = this.aligns ? this.aligns.join("|") : "";
    /* 【引用区表格】qDepth＝引用层级（1–3），qLead＝该行引用前缀的字符数。
       widget 是**整行块级替换**，`.mp-quote` 行类对它不生效 ⇒ 引用竖条与缩进必须在 widget 内部画，
       否则表一渲染，引用块就在这几行上"断了"。 */
    this.qDepth = qDepth || 0; this.qLead = qLead || 0;
    this.region = region; this.geometry = geometry;
    /* 【列宽下限·2026-10-08】weights＝各列的**显示宽度**权重（scanTables 算好）。
       `toDOM` 里按表格真实可用宽度现算一次"每列至少 minPercent"，防止窄窗口/窄版心下
       中文列被压成一字一行（用户 3.0.5 装机截图）。 */
    this.weights = weights;
  }
  /** 现算本次渲染用的列宽（%）：先按显示宽度比例，再把低于下限的列抬到下限、从宽列里扣回。 */
  fitWidthsNow(avail = this.tableEl?.clientWidth || 0) {
    if (!this.weights || !this.weights.length) return this.widths;
    const minPx = 64;                        // 4 个中文字 + 左右各 16 padding：至少能竖排前容纳 4 字
    const minPercent = avail > 0 ? Math.min(30, (minPx / avail) * 100) : 14;
    return fitWidths(this.weights, minPercent);
  }
  get estimatedHeight() {
    // CM's height map uses viewport pixels; ResizeObserver stores CSS pixels.
    // A replacement must keep the known height until its new DOM is measured.
    const cached = view && cachedTableGeometry(view, this.geometry);
    return cached?.viewportHeight > 0 ? cached.viewportHeight : -1;
  }
  eq(other) {
    if (other.region?.id !== this.region?.id || other.region?.contextVersion !== this.region?.contextVersion) return false;
    if (other.rowFrom !== this.rowFrom || other.isHeader !== this.isHeader || other.widths.join(",") !== this.widths.join(",")
      || other.ranges.length !== this.ranges.length || other.activeCol !== this.activeCol
      || other.qDepth !== this.qDepth || other.qLead !== this.qLead) return false;
    if ((other.selKey || "") !== (this.selKey || "")) return false;   // 【β1】选择状态变了必须重建（否则高亮陈旧）
    if ((other.alignKey || "") !== (this.alignKey || "")) return false; // 【β2】列对齐变了必须重建（活动行分支同样适用）
    /* weights 参与 eq：列宽下限是按 weights 现算的，权重变了必须重建（否则改一格文字后列宽不跟着走）。 */
    if ((other.weights ? other.weights.join(",") : "") !== (this.weights ? this.weights.join(",") : "")) return false;
    if (this.activeCol >= 0) {
      // The active cell is painted by the independent input overlay. All other
      // payloads and every source hit range must still match for DOM reuse.
      return other.cells.length === this.cells.length &&
        other.cells.every((cell,k) => k === this.activeCol || cell === this.cells[k]) &&
        other.ranges.every((range,k) => range[0] === this.ranges[k][0] && range[1] === this.ranges[k][1]);
    }
    return other.cells.join("\u0001") === this.cells.join("\u0001")
      && other.ranges.map((r) => r.join(",")).join(";") === this.ranges.map((r) => r.join(",")).join(";");
  }
  toDOM(inputView) {
    const wrap = document.createElement("div");
    wrap.className = "mp-table-wrap" + (this.qDepth ? " mp-table-quote" : "");
    const region = this.region && inputView.state.field(regionIndexField).byId.get(this.region.id);
    if (region) { wrap.dataset.mpRegion = region.id; bindContainer(wrap,region.context); }
    const lease = region ? rendererLifecycle.mount(inputView,region,wrap, {
      sameContent: current => {
        const tb = current.data, block = this.isHeader ? tb.headerBlock : tableRowIndex(tb).get(this.rowFrom);
        const next = block && tableRowWidgetFor(inputView.state,tb,block,this.isHeader,current);
        return !!next && this.eq(next);
      },
    }) : null;
    const table = document.createElement("table");
    if (this.qDepth) {
      wrap.dataset.mpQd = String(this.qDepth);
      this.qLead = this.qLead || 0;
      /* 表框左缘＝竖条右缘，表内文字的**第 1 列左缘与引用文字的 text-indent 起点对齐**：
         widget 是整行替换，引用块那几行不再有 `.mp-line.mp-quote` 的边距，必须在这里补回来。
         数值验算（两处 ch 属同一字号 ⇒ 可约掉）：
           引用文字左缘 = wrap左缘 + 3(条) + .8em + qLead_ch
           表首列文字左缘 = wrap左缘 + 3(条) + wrapPad + 1(表格外框) + 16(单元格左内边距) + qLead_ch
          ⇒ wrapPad = .8em - 17px + 1px = .8em - 16px（单元格 padding 16px + 外框 1px）。 */
      wrap.style.paddingLeft = "calc(var(--mp-q-inset, 0px) + var(--mp-q-pad, .8em) + " + (this.qDepth - 1) + "em - 16px)";
    }
    table.className = "mp-row";
    this.tableEl = table;                    // fitWidthsNow 需要真实可用宽度（挂载后才有）
    const colgroup = document.createElement("colgroup");
    const cols = [];                         // col 元素留着，挂载后按实测宽度重写一次
    const geometry = cachedTableGeometry(inputView, this.geometry);
    const hasFit = geometry?.fittedWidth > 0;
    const initialWidths = hasFit ? this.fitWidthsNow(geometry.fittedWidth) : this.widths;
    initialWidths.forEach((w) => { const col = document.createElement("col"); col.style.width = w + "%"; colgroup.appendChild(col); cols.push(col); });
    table.appendChild(colgroup);
    let fitPending = false, cancelFit = null, fittedWidth = hasFit ? geometry.fittedWidth : null;
    const fitWork = { table, valid: () => wrap.isConnected && (!lease || lease.valid()),
      finish: avail => {
        fitPending = false; cancelFit = null;
        if (avail === null || avail === fittedWidth) return;
        fittedWidth = avail;
        const cached = cachedTableGeometry(inputView, this.geometry);
        if (cached) cached.fittedWidth = avail;
        const fitted = this.fitWidthsNow(avail);
        for (let k = 0; k < cols.length; k++) if (fitted[k]) cols[k].style.width = fitted[k] + "%";
      },
    };
    const scheduleFit = () => {
      if (!this.weights || this.weights.length !== this.widths.length || fitPending) return;
      // Read all mounted row widths before writing any columns. Per-row RAF
      // read/write pairs forced a full layout for each row entering the viewport.
      fitPending = true; cancelFit = scheduleTableFit(inputView, fitWork);
    };
    if (!hasFit) scheduleFit();
    lease?.cleanup(() => { cancelFit?.(); cancelFit = null; fitPending = false; });
    // A zoom/narrower editor changes the available CSS width without replacing
    // the widget. Refresh its existing column-fit policy on that real change;
    // height-only inputs never schedule fitting. CM's read/write phases merge work.
    observeTableGeometry(inputView, wrap, this.rowFrom, lease, this.isHeader, this.widths.length, scheduleFit, this.geometry, () => fittedWidth);
    const tr = table.insertRow();
    /* 【β1 选择层级】整表 ⇒ wrap 描边；行 ⇒ 本行 <tr>；列 ⇒ **每一行**的第 col 格（缺格的行不画）。 */
    if (this.selKind === "table") wrap.classList.add("mp-sel-table");
    if (this.selKind === "row" && this.rowFrom === this.selRow) tr.className = "mp-sel-row";
    for (let k = 0; k < this.widths.length; k++) {
      const cell = this.isHeader ? document.createElement("th") : document.createElement("td");
      const hasSrc = !!this.ranges[k];
      const [a, b] = this.ranges[k] || [0, 0];
      cell.dataset.mpRow = String(this.rowFrom);
      cell.dataset.mpCol = String(k);
      /* 【点击映射】源码里**没有**这一格（参差行：渲染按表头列数出格）时，不许打 from/to——
         改前打的是 0/0，下游会当成真区间用，于是点到幻影格会"字段变了、覆盖层没动"。 */
      if (hasSrc) { cell.dataset.mpFrom = String(a); cell.dataset.mpTo = String(b); }
      else cell.dataset.mpPhantom = "1";
      /* 【β2·对齐渲染】行内 style 覆盖 CSS 里的 `text-align: left`（左/未标注都写 left，与 CSS 默认一致）。 */
      cell.style.textAlign = (this.aligns && this.aligns[k]) || "left";
      if (k === this.activeCol) {
        cell.className = "mp-cell-editing";
        const layout = document.createElement('div'); layout.className = 'mp-cell-layout'; layout.setAttribute('aria-hidden', 'true');
        const rendered = document.createElement('div'); rendered.className = 'mp-cell-rendered-size';
        rendered.innerHTML = renderedCellLayout(inputView, this.rowFrom, k, this.cells[k] || '').html;
        const source = document.createElement('div'); source.className = 'mp-cell-source-size';
        source.textContent = mappedCellSource(this.cells[k] || '').text;
        layout.append(rendered, source); cell.appendChild(layout);
      } else cell.innerHTML = cellHTML(mappedCellSource(this.cells[k] || "").text);
      if (this.selKind === "col" && k === this.selCol) cell.classList.add("mp-sel-col");
      tr.appendChild(cell);
    }
    wrap.appendChild(table);
    if (this.activeCol >= 0) {
      const positionRaf = requestAnimationFrame(() => { if (wrap.isConnected && (!lease || lease.valid())) positionCellOverlay(); });
      lease?.cleanup(() => cancelAnimationFrame(positionRaf));
    }
    return wrap;
  }
  ignoreEvent() { return false; }
  destroy(dom) { rendererLifecycle.release(dom); this.tableEl = null; }
}
/** DOM selection boundaries, including mixed text nodes created by paste. */
function cellDOMSelection(edit) {
  const sel = getSelection();
  if (!sel || !edit.contains(sel.anchorNode) || !edit.contains(sel.focusNode)) return null;
  const offset = (node, at) => {
    const range = document.createRange();
    range.selectNodeContents(edit); range.setEnd(node, at);
    return range.toString().length;
  };
  return { anchor: offset(sel.anchorNode, sel.anchorOffset), head: offset(sel.focusNode, sel.focusOffset) };
}
function setCellDOMSelection(edit, anchor, head) {
  const boundary = offset => {
    const walker = document.createTreeWalker(edit, NodeFilter.SHOW_TEXT);
    let node, last = null;
    while ((node = walker.nextNode())) {
      last = node;
      if (offset <= node.nodeValue.length) return [node, Math.max(0, offset)];
      offset -= node.nodeValue.length;
    }
    return last ? [last, last.nodeValue.length] : [edit, 0];
  };
  const a = boundary(anchor), h = boundary(head);
  getSelection()?.setBaseAndExtent(a[0], a[1], h[0], h[1]);
}
function syncCellSelection(edit) {
  if (!view || !cellEdit) return;
  const dom = cellDOMSelection(edit);
  if (!dom) return;
  const mapped = mappedCellSource(view.state.doc.sliceString(cellEdit.from, cellEdit.to));
  const anchor = cellEdit.from + cellSourceOffset(mapped, dom.anchor);
  const head = cellEdit.from + cellSourceOffset(mapped, dom.head);
  const sel = view.state.selection.main;
  if (sel.anchor !== anchor || sel.head !== head) {
    view.dispatch({ selection: { anchor, head }, userEvent: 'select', annotations: Transaction.addToHistory.of(false) });
  }
}
/** 编辑面 → 源码镜像：源表示之间的最小 diff，DOM 下标不当作源下标。 */
function syncCellEdit(edit) {
  if (!view || !cellEdit) return;
  /* 【#26 第二道门】只读态下覆盖层任何 DOM 变化都不许镜像进源码（含程序化 execCommand）。 */
  if (view.state.readOnly) return;
  const newText = edit.textContent || '';
  const source = view.state.doc.sliceString(cellEdit.from, cellEdit.to);
  /* 【#62-U2R-3】覆盖层打开期间文档可能被**其它路径**改写（典型：位图粘贴异步 commit 插到表格上方
     ⇒ 表格整体右移）。旧代码直接把镜像文本写回 `cellEdit.from/to` ⇒ 覆写到错误区间（实测把表头
     写成 `a1 Z1 | H2 |`，数据破坏）。区间映射在 update 监听器里做；这里再兜一道：区间内容已不是
     上次镜像的文本 ⇒ 不写，改为"源码 → 编辑面"重同步，等映射修复后再键入。 */
  /* 比较必须用"格源码 → DOM 文本"映射后的形态：cellEdit.text 是 DOM 文本（`a|b`），
     而源码里字面管道是转义形态（`a\\|b`）——直接比 raw source 会把所有含管道的格误判成"陈旧"。 */
  if (cellEdit.text != null && mappedCellSource(source).text !== cellEdit.text) { resyncCellEdit(edit); return; }
  const change = cellTextChange(source, newText);
  if (!change) { syncCellSelection(edit); updateCellSizer(edit); scheduleCellOverlay(true); return; }
  const dom = cellDOMSelection(edit), mapped = mappedCellSource(change.source);
  const from = cellEdit.from;
  const selection = dom ? {
    anchor: from + cellSourceOffset(mapped, dom.anchor),
    head: from + cellSourceOffset(mapped, dom.head),
  } : undefined;
  /* 【#60】execCommand('insertText') 在 Chromium 里可能**不触发 beforeinput**（实测只出 input）⇒
     强制来源标记不能只在 beforeinput 里消费，这里同步读一次并立刻清掉。 */
  const inputType = edit.__mpCellForceInputType || edit.__mpCellInputType || '';
  edit.__mpCellForceInputType = '';
  /* 【#60】覆盖层里「会被转换的粘贴 / 公式 / <br>」都走 execCommand('insertText')，beforeinput 只会
     报 insertText ⇒ 旧映射把这些操作记成 input.type，与紧邻键入并成同一撤销组（一次 Ctrl+Z 把打的字
     也撤掉；表外正文同类操作是独立组）。这里支持三个来源标记，由发起 execCommand 的代码预先设置。 */
  const userEvent = inputType.startsWith('delete') ? 'delete'
    : inputType === 'insertFromPaste' ? 'input.paste'
      : inputType === '__format' ? 'input.format'
        : inputType === '__linebreak' ? 'input.linebreak'
          : 'input.type';
  view.dispatch({ changes: { from: from + change.from, to: from + change.to, insert: change.insert },
    selection, userEvent });
  cellEdit.text = newText;
  cellEdit.to = from + change.source.length;
  /* 【A7-(b)】这里原先每次输入都刷一次格内预览（含一次 cellHTML 渲染比较）。已按决定删除：
     预览卡片与"不遮住下一行"在相邻行上结构性互斥（可用带宽 2px vs 卡片 30px+），
     而去掉它同时最贴 Typora、并在每键路径上**净省**一次 innerHTML 写入 + 一次渲染比较。 */
  updateCellSizer(edit); scheduleCellOverlay(true);
}
/** 撤销后外向同步：源码 → 编辑面 */
function resyncCellEdit(edit) {
  if (!view || !cellEdit) return;
  const sel = view.state.selection.main;
  let active = view.state.field(activeCellField, false);
  let line = active && view.state.doc.lineAt(active.rowFrom);
  let ranges = line && line.from === active.rowFrom ? cellRangesOf(line) : [];
  let range = ranges[active?.col];
  const containsSelection = r => view.state.selection.ranges.length === 1 && r && sel.from >= r[0] && sel.to <= r[1];
  if (!containsSelection(range) || (line && isSeparatorBody(line.text.slice(tableLead(line.text).off)))) {
    line = view.state.doc.lineAt(sel.head);
    ranges = cellRangesOf(line);
    const col = tableContaining(view.state, sel.head) && !isSeparatorBody(line.text.slice(tableLead(line.text).off))
      ? ranges.findIndex(containsSelection) : -1;
    range = col < 0 ? null : ranges[col];
    if (range) {
      active = { rowFrom: line.from, col };
      view.dispatch({ effects: setActiveCell.of(active), annotations: Transaction.addToHistory.of(false) });
    }
  }
  if (!range) {
    view.dispatch({ effects: setActiveCell.of(null) });
    deactivateCellOverlay(); view.focus(); return;
  }
  const [from, to] = range, mapped = mappedCellSource(view.state.doc.sliceString(from, to));
  Object.assign(cellEdit, { from, to, text: mapped.text, rowFrom: active.rowFrom, col: active.col, cols: ranges.length });
  if (edit.textContent !== mapped.text) edit.textContent = mapped.text;
  updateCellSizer(edit);
  edit.focus({ preventScroll: true });
  setCellDOMSelection(edit, cellTextOffset(mapped, sel.anchor - from), cellTextOffset(mapped, sel.head - from));
  positionCellOverlay();
}
function cellHistory(edit, command) {
  if (!view || !cellEdit) return;
  return historyCommand(command);
}
function historyCommand(command) {
  const target = view, serial = commands.serial();
  let appliedState = null;
  const handled = commands.run(() => {
    cancelPendingImageInsertions(target);
    // CM history otherwise derives Redo's selection by mapping the pre-input
    // range. A reversed replacement maps to a nonempty range over the new text.
    // Remember the actual current selection in the existing history at Undo's
    // command boundary, without splitting continuous typing into new groups.
    if (applySourceHistory(target, command === redo ? 'redo' : 'undo') === true) appliedState = target.state;
    return true;
  });
  if (appliedState && view === target && target.state === appliedState &&
      commands.serial() === serial && document.hasFocus() && target.hasFocus &&
      target.dom.isConnected && !cellComposing && !target.composing) {
    activateSourceCellSelection(target);
  }
  return handled;
}
function cancelPendingImageInsertions(editor) {
  if (editor.state.field(imageInsertions).tickets.length) {
    editor.dispatch({ effects: cancelImageInsertions.of(null), annotations: Transaction.addToHistory.of(false) });
  }
}

/* ══ 格编辑覆盖层（iframe body 挂载——CM6 DOM 观察器免疫）══
 *  contenteditable 放 cm-content 内会被观察器当篡改（实测：打字触发
 *  「update in progress」异常、镜像 dispatch 被吞）。覆盖层在 body 上
 *  固定定位盖住活动格，IME 原生，input 事件独立于 CM6 更新周期。 */
let cellOverlay = null, cellSelectionDocument = null;
/** 【A7】已经抄过样式的活动格（"row:col"）：只有它变了才重读 computed style —— 见 positionCellOverlay。 */
let overlayStyledFor = "";
/** 【A7 v2】当前覆盖层的**上内边距**（含 1px 边框补偿与垂直居中补偿），由 positionCellOverlay 算出。 */
let overlayPadTop = 0;
/** 【N1】取证计数：覆盖层 copy 处理器被调用的次数与分支（排障"格内复制没写剪贴板"用；零成本）。 */
const cellCopyDiag = { calls: 0, mode: null, bytes: 0 };
/** 【N1·数据完整性】覆盖层上的 Ctrl+C。
 *  覆盖层 `.mp-cell-overlay-text` 挂在 **body** 上（在 CM6 contentDOM 之外）⇒ `docSourceClipboard`
 *  根本收不到它；而"格内没有 DOM 选区"时浏览器默认行为**一个字节都不写** ⇒ 上一份剪贴板原封不动
 *  留给用户。端到端形态（实测复现）：剪贴板里本来有一张截图 → 点格 + Ctrl+C → Excel 粘出来还是那张旧图。
 *  口径（PLAN-3.1.0 §4）：
 *   · 格内**有**文本选区 ⇒ 不拦截，交回浏览器默认（复制格内文字，与原先一致）；
 *   · 格内**无**选区   ⇒ 写**整表** TSV+HTML（与右键「复制表格（可粘 Excel）」同一个 tableClipPayload）；
 *   · 找不到表（理论上不会）⇒ 至少写本格源码 —— **绝不允许静默把旧剪贴板留给用户**。 */
function cellOverlayCopy(event) {
  if (!view || !cellEdit || !cellOverlay || !cellOverlay.contains(event.target)) return;
  cellCopyDiag.calls++;
  const sel = typeof getSelection === "function" ? getSelection() : null;
  if (sel && !sel.isCollapsed && sel.rangeCount && cellOverlay.contains(sel.anchorNode)) {
    cellCopyDiag.mode = "dom-selection";                  // 有选区：让浏览器照常复制格内文字
    return;
  }
  const cb = event.clipboardData;
  const payload = tableClipPayloadOf(tableContaining(view.state, cellEdit.rowFrom));
  if (payload && cb) {
    try { cb.setData("text/plain", payload.tsv); } catch { /* 宿主禁止 */ }
    try { cb.setData("text/html", payload.html); } catch { /* 宿主禁止 */ }
    cellCopyDiag.mode = "table";
    cellCopyDiag.bytes = payload.tsv.length + payload.html.length;
  } else {
    /* 兜底也不能空手：至少把本格源码写进去（旧内容因此一定被覆盖掉）。 */
    const text = view.state.sliceDoc(cellEdit.from, cellEdit.to);
    try { cb?.setData("text/plain", text); } catch { /* 宿主禁止 */ }
    cellCopyDiag.mode = "cell-fallback";
    cellCopyDiag.bytes = text.length;
  }
  event.preventDefault();
}
function ensureCellOverlay() {
  if (cellOverlay && cellOverlay.isConnected) return cellOverlay;
  if (cellSelectionDocument !== document) {
    cellSelectionDocument = document;
    document.addEventListener('selectionchange', () => {
      const edit = cellOverlay?.querySelector('.mp-cell-overlay-text');
      if (!view?.dom.isConnected || !edit?.isConnected || !cellEdit || cellComposing || view.composing ||
          !document.hasFocus() || document.activeElement !== edit || !cellDOMSelection(edit)) return;
      const active = view.state.field(activeCellField,false), selection = view.state.selection;
      if (!active || active.rowFrom !== cellEdit.rowFrom || active.col !== cellEdit.col || selection.ranges.length !== 1 ||
          selection.main.from < cellEdit.from || selection.main.to > cellEdit.to) return;
      const line = view.state.doc.lineAt(cellEdit.from), range = cellRangesOf(line)[cellEdit.col];
      if (line.from !== cellEdit.rowFrom || !range || range[0] !== cellEdit.from || range[1] !== cellEdit.to ||
          mappedCellSource(view.state.doc.sliceString(cellEdit.from,cellEdit.to)).text !== edit.textContent) return;
      syncCellSelection(edit);
    });
  }
  const box = document.createElement("div");
  box.className = "mp-cell-overlay";
  const div = document.createElement("div");
  div.className = "mp-cell-overlay-text";
  div.contentEditable = "true";
  div.spellcheck = false;
  box.appendChild(div);
  div.addEventListener("compositionstart", () => { syncCellSelection(div); cellComposing = true; });
  div.addEventListener("compositionend", () => { cellComposing = false; syncCellEdit(div); });
  div.addEventListener('beforeinput', e => {
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault(); cellHistory(div, e.inputType === 'historyUndo' ? undo : redo); return;
    }
    div.__mpCellInputType = div.__mpCellForceInputType || e.inputType;
    div.__mpCellForceInputType = '';
    if (!cellComposing) syncCellSelection(div);
  });
  div.addEventListener("input", () => {
    if (!cellComposing) syncCellEdit(div);
    else { updateCellSizer(div); scheduleCellOverlay(true); }
  });
  box.addEventListener('wheel', e => {
    if (!cellEdit || !view?.dom.isConnected || !box.isConnected || box.style.display === 'none') return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { mpZoomBy(e.deltaY < 0 ? MP_ZOOM_STEP : -MP_ZOOM_STEP); scheduleCellOverlay(); return; }
    const scale = e.deltaMode === 1 ? (parseFloat(getComputedStyle(div).lineHeight) || 24) : e.deltaMode === 2 ? view.scrollDOM.clientHeight : 1;
    const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0), dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
    const z = mpZoomOf(view.scrollDOM);
    view.scrollDOM.scrollBy({ left: dx * scale / z, top: dy * scale / z, behavior: 'instant' });
  }, { passive: false });
  /* 【N1】copy 必须挂在覆盖层自己身上：它挂 body、事件在 contentDOM 之外，CM6 的处理器收不到。 */
  div.addEventListener("copy", cellOverlayCopy);
  div.addEventListener("blur", () => {
    if (cellEdit && !cellEdit.navigating && view) {
      primeTableGeometry(view, activeCellDOM());
      commands.suspend();
      view.dispatch({ effects: setActiveCell.of(null) });
      deactivateCellOverlay();
    }
  });
  div.addEventListener("keydown", (e) => {
    if (/^(?:Arrow|Home$|End$|Page)/.test(e.key)) scheduleCellOverlay(true);
    /* 【IME 组字期间一律不拦截】—— 实测（真机 + 无头）：组字中途按 Tab 会**丢拼音**并把
       上屏文字串到下一格；Enter 那一下也会被下面的 preventDefault 吞掉。
       ⚠️ 必须**同时** preventDefault：只 `return` 的话 Tab 会走浏览器焦点遍历 ⇒ 覆盖层 blur
       ⇒ `setActiveCell(null)` + 收浮层，等于"打着字把编辑面关了"（对抗复核指出，已修）。
       keyCode 229 是"正在组字"的老口径兜底（部分输入法合成事件不带 isComposing）。 */
    if (e.isComposing || e.keyCode === 229) { e.preventDefault(); return; }
    syncCellSelection(div);
    // The overlay lives outside contentDOM; share the toolbar search action.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && /^f$/i.test(e.key) && view && cellEdit) {
      e.preventDefault();
      TOOLBAR_ACTIONS['find-replace'](view);
      return;
    }
    /* 【A8】表格键转发：焦点在覆盖层上时，CM6 的键位（挂 contentDOM）**收不到**这些键 ——
       真机与装机验收都实测过：格内按 Ctrl+Enter 什么都不发生，而"点进格子"正是最自然的操作路径。
       转发前必须先把 CM 选区落到**本格**（点格只 dispatch setActiveCell、不落选区；直接在陈旧选区上
       执行命令会写错位置 —— 对抗复核的告诫）。命令走 window.mpExtras.tableOp，与右键菜单同一实现。 */
    if ((e.ctrlKey || e.metaKey) && cellEdit) {
      const k = e.key;
      const op = (k === "Enter" && e.shiftKey) ? "row-above"
        : (k === "Enter") ? "row-below"
          : (k === "ArrowLeft" && e.altKey) ? "col-left"
            : (k === "ArrowRight" && e.altKey) ? "col-right"
              : (k === "Backspace" && e.shiftKey) ? "row-delete"
                : (k === "Delete" && e.altKey) ? "col-delete"
                  : null;
      if (op) {
        e.preventDefault();
        try {
          view.dispatch({ selection: EditorSelection.cursor(cellEdit.from) });
          window.mpExtras?.tableOp?.(op);
        } catch (err) { console.error("[mp] 表格键转发失败：", err); }
        return;
      }
    }
    /* 格内沿用行内公式命令；块级快捷键与工具栏共用拒绝边界。 */
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.shiftKey && /^[mqk]$/i.test(e.key) && cellEdit) {
      e.preventDefault();
      window.mpExtras?.toast?.('表格内不支持块级格式——请先把光标移到表格外');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.shiftKey && (e.key === "e" || e.key === "E") && cellEdit) {
      e.preventDefault();
      let picked = "";
      try { const s = window.getSelection(); if (s && !s.isCollapsed) picked = String(s); } catch (err) { picked = ""; }
      div.__mpCellForceInputType = "__format";   /* #60：公式插入单独成撤销组 */
      document.execCommand("insertText", false, "$" + picked + "$");
      if (!picked) { try { window.getSelection().modify("move", "backward", "character"); } catch (err) { } }
      syncCellEdit(div);
      return;
    }
    /* 【A8】表尾出路（覆盖层这一侧）：最后一行按 ↓、第一行按 ↑ ⇒ 退出表格。
       A1 只把这条做在源码键位上；用户点着格子时按不出来，等于没有。 */
    /* 【β1】Ctrl+A 选择递进 / Ctrl+E 选格：焦点在覆盖层上时 CM 的 keymap（挂 contentDOM）**收不到**
       ⇒ 必须在这条 keydown 里显式分派。不加分支的话：表内 Ctrl+E 是**死键**（落到 Chromium 默认的
       contenteditable 无此快捷键），Ctrl+A 走**原生** Select All（不可控；第二次是否升级为选文档未实测）。 */
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      cycleTableSelection();
      return;
    }
    /* 【格内格式键·2026-10-17 实测缺陷 TBL-4】改前这里没有 B/I/U 分支 ⇒ 落到 contenteditable 原生
       格式化：覆盖层 DOM 变成 <b> a2 </b>，而**源码一字不改**，Esc 后再点回该格 textContent 由源码
       重播种 ⇒ 加粗凭空消失（Ctrl+Z 也只撤掉 DOM 的粗体）。现在与表外**同一条命令**
       （TOOLBAR_ACTIONS → wrapSource），并先把 CM 选区按"去掉格内填充空白"收窄：
       格源码是「空格 a2 空格」，整格选中直接包会得到 ** a2 **（markdown 不认，屏幕上反而是字面星号）。 */
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && cellEdit && view) {
      const fmt = /^b$/i.test(e.key) ? "bold" : /^i$/i.test(e.key) ? "italic" : /^u$/i.test(e.key) ? "underline" : null;
      if (fmt) {
        e.preventDefault();
        /* DOM 与 CM 两份选区必须**同时**收窄：只改 CM 的话，commands.run 的 flushOwner →
           syncCellEdit → syncCellSelection 会按 DOM 把整格选区写回来（实测得到 ** a2 **a2 ——
           包裹文本插在前面、原文本没被替换，正是 #22 第二版失败的那个形态）。 */
        const mapped = mappedCellSource(view.state.doc.sliceString(cellEdit.from, cellEdit.to));
        const sel = view.state.selection.main;
        const text = view.state.sliceDoc(sel.from, sel.to);
        const from = sel.from + (text.length - text.trimStart().length);
        const to = Math.max(from, sel.to - (text.length - text.trimEnd().length));
        if (from !== sel.from || to !== sel.to) {
          setCellDOMSelection(div, cellTextOffset(mapped, from - cellEdit.from), cellTextOffset(mapped, to - cellEdit.from));
          syncCellSelection(div);
        }
        try { TOOLBAR_ACTIONS[fmt](view); } catch (err) { console.error("[mp] 格内格式键失败：", err); }
        return;
      }
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "e" || e.key === "E")) {
      e.preventDefault();
      selectCellText();
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && view && cellEdit) {
      const ln = view.state.doc.lineAt(cellEdit.rowFrom).number;
      const blk = tableBlockOf(view.state, ln);
      if (blk && ((e.key === "ArrowDown" && ln === blk.to) || (e.key === "ArrowUp" && ln === blk.from))) {
        e.preventDefault();
        if (e.key === "ArrowDown") {
          if (blk.to < view.state.doc.lines) {
            view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(blk.to + 1).from), scrollIntoView: true });
          } else {
            const end = view.state.doc.length;
            view.dispatch({ changes: { from: end, insert: "\n" }, selection: EditorSelection.cursor(end + 1), scrollIntoView: true });
          }
        } else {
          view.dispatch({ selection: EditorSelection.cursor(blk.from > 1 ? view.state.doc.line(blk.from - 1).from : 0), scrollIntoView: true });
        }
        view.dispatch({ effects: setActiveCell.of(null) });
        deactivateCellOverlay();
        view.focus();
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (view) primeTableGeometry(view, activeCellDOM());
      if (view) view.dispatch({ effects: [setActiveCell.of(null), setTableSel.of(null)] });
      deactivateCellOverlay();
      view?.focus();
    } else if (e.key === "Tab") {
      /* 【β1】与源码行路径**同一个** applyTab：跨行、跳分隔行、末条格行补行、反向到表头停住。
         改前这里是"只在本行内换格"（越界什么都不做），跨行与补行都做不到。 */
      e.preventDefault();
      if (!view || !cellEdit) return;
      moveActiveCellByKey(() => applyTab(view, e.shiftKey ? -1 : 1));
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && /^(z|y)$/i.test(e.key)) {
      e.preventDefault();
      cellHistory(div, e.key.toLowerCase() === 'y' || e.shiftKey ? redo : undo);
    } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      /* 【β1】Enter 三态（覆盖层这一侧）。Ctrl+Enter 家族已被上面的 A8 转发放走，不会走到这里。
         Shift ⇒ 格内换行：往 contenteditable 里写**字面四个字符** <br>（插真 DOM 节点的话
         syncCellEdit 比对的 textContent 里看不到换行，diff 会判"文本没变"、源码侧不落地）。 */
      e.preventDefault();
      if (!view || !cellEdit) return;
      if (e.shiftKey) {
        let ok = false;
        div.__mpCellForceInputType = "__linebreak";   /* #60：<br> 插入单独成撤销组 */
        try { ok = document.execCommand("insertText", false, "<br>"); } catch { ok = false; }
        if (!ok) {
          const sel = getSelection();
          if (sel && sel.rangeCount) {
            const rng = sel.getRangeAt(0);
            rng.deleteContents();
            const node = document.createTextNode("<br>");
            rng.insertNode(node);
            rng.setStartAfter(node); rng.collapse(true);
            sel.removeAllRanges(); sel.addRange(rng);
          }
        }
        syncCellEdit(div);
        positionCellOverlay();
        return;
      }
      /* 覆盖层里若有非空 DOM 选区，先删掉它（与源码行路径"同格内先删"同一口径）：
         contenteditable 的原生删除会触发 input ⇒ syncCellEdit 镜像进源码，一拍事务。 */
      try {
        const ds = getSelection();
        if (ds && !ds.isCollapsed && div.contains(ds.anchorNode)) document.execCommand("delete");
      } catch { /* 忽略：删不掉就直接下移 */ }
      moveActiveCellByKey(() => applyEnter(view));
    }
  });
  document.body.appendChild(box);
  cellOverlay = box;
  return box;
}
function positionCellOverlay() {
  if (!view || !cellOverlay) return;
  const active = view.state.field(activeCellField, false);
  if (!active) { cellOverlay.style.display = "none"; return; }
  const cell = activeCellDOM();
  if (!cell) { cellOverlay.style.display = "none"; return; }
  const r = cell.getBoundingClientRect(), source = cell.querySelector('.mp-cell-source-size');
  if (!source) { cellOverlay.style.display = 'none'; return; }
  const sr = source.getBoundingClientRect(), z = mpZoomOf(cell);
  cellOverlay.style.display = "block";
  /* 【A7】排版抄**该 td 的计算样式**（覆盖层挂 body，em 基准与表格里不同，写死字号/padding 必然错位）。
     ⚠️ 只在**活动格变了**的那一次读 computed style：本函数被滚动/rAF/每次输入的 rAF 反复调用。 */
  /* 【A7 v2c】缓存键**必须带上格子高度**：只按"哪一格"缓存的话，激活那一刻若格子还没到最终高度
     （图片尚未加载 / 夹具稍后用 CSS 撑高 / 行 widget 刚重建），垂直居中补偿会按旧高度算一次然后被缓存住
     —— 复核线复跑实测就是这个症状：高行格 `dy=−36.91px`、`padTop=9px`（补偿项为 0）。
     高度变化才会重算，因此每帧代价仍只是"一次字符串比较 + 一次整数比较"。 */
  const styleKey = active.rowFrom + ":" + active.col + ":" + r.width + ':' + r.height + ':' + z;
  if (overlayStyledFor !== styleKey) {
    overlayStyledFor = styleKey;
    try {
      const cs = getComputedStyle(cell);
      cellOverlay.style.fontFamily = cs.fontFamily;
      cellOverlay.style.fontSize = (parseFloat(cs.fontSize) * z) + 'px';
      cellOverlay.style.fontWeight = cs.fontWeight;
      cellOverlay.style.lineHeight = cs.lineHeight === 'normal' ? 'normal' : (parseFloat(cs.lineHeight) * z) + 'px';
      cellOverlay.style.letterSpacing = cs.letterSpacing === 'normal' ? 'normal' : (parseFloat(cs.letterSpacing) * z) + 'px';
      /* 【β2·A4】进格编辑时排版不横跳：覆盖层抄 td 的 textAlign（不补的话点进右对齐格会从左排）。 */
      cellOverlay.style.textAlign = cs.textAlign;
      cellOverlay.style.color = cs.color;
      /* 【A7 v2】内容盒原点必须对齐 td 的**内容盒**（gaps 线量出来的两条，不是拍的）：
         · td 的 1px 边框要补进 padding，否则整块偏 1px；
         · td 默认 `vertical-align: middle`，覆盖层是块级从顶排 ⇒ 行高小于格高时整体偏上
           —— 实测格高 117px 时同偏移 Range 的 Δy = **−37.91px**（不是 12px，12px 只是 42px 行高那档），
           补垂直居中后 −0.02px。 */
      overlayPadTop = Math.max(0, sr.top - r.top);
    } catch { overlayPadTop = 0; }
  }
  // The grid centers the complete source block and contributes its real height
  // to the row. Rects are already viewport pixels; do not scale them twice.
  cellOverlay.style.padding = `${Math.max(0, sr.top-r.top)}px ${Math.max(0, r.right-sr.right)}px ${Math.max(0, r.bottom-sr.bottom)}px ${Math.max(0, sr.left-r.left)}px`;
  cellOverlay.style.left = r.left + "px";
  cellOverlay.style.top = r.top + "px";
  cellOverlay.style.width = r.width + "px";
  /* 【A7】锁**高**而不是给下限：`min-height` 会被预览块撑到下一行（验收线实测公式格 dH=+33.22px）。 */
  cellOverlay.style.height = r.height + "px";
}
/** 激活/切换活动格：建覆盖层、播种源码文本、落焦点 */
function activateCellOverlay(rowFrom, col, cols, from, to, caretOffset, selectAll, sourceSelection, pointer) {
  const box = ensureCellOverlay();
  const div = box.querySelector(".mp-cell-overlay-text");
  const mapped = mappedCellSource(view ? view.state.doc.sliceString(from, to) : "");
  div.textContent = mapped.text;
  cellEdit = { text: mapped.text, from, to, col, cols, rowFrom, navigating: false, epoch: view.state.field(regionIndexField).epoch };
  const edit = cellEdit, ownedDoc = view?.state.doc;
  box.style.display = "block";
  updateCellSizer(div);
  positionCellOverlay();
  const focusIt = () => {
    if (cellEdit !== edit || view?.state.doc !== ownedDoc) return;
    div.focus({ preventScroll: true });
    if (sourceSelection) {
      setCellDOMSelection(div, cellTextOffset(mapped, sourceSelection.anchor - from),
        cellTextOffset(mapped, sourceSelection.head - from));
      syncCellSelection(div);
      return;
    }
    const rng = document.createRange();
    if (pointer && div.firstChild) {
      const r = div.getBoundingClientRect();
      const x = Math.max(r.left + .5, Math.min(pointer.x, r.right - .5));
      const y = Math.max(r.top + .5, Math.min(pointer.y, r.bottom - .5));
      const hit = document.caretRangeFromPoint(x, y);
      if (hit && div.contains(hit.startContainer)) {
        const s = getSelection(); s.removeAllRanges(); s.addRange(hit); syncCellSelection(div); return;
      }
    }
    // Command offsets are source coordinates; pointer entry uses the live DOM
    // above. Convert command offsets with the same escaped-pipe source codec.
    const node = div.firstChild;
    const len = node && node.nodeType === 3 ? node.nodeValue.length : 0;
    if (typeof caretOffset === "number" && node && node.nodeType === 3) {
      rng.setStart(node, Math.max(0, Math.min(len, cellTextOffset(mapped, Math.round(caretOffset)))));
      rng.collapse(true);
    } else if (selectAll) {
      /* 【β1】Ctrl+E / 递进第 1 级：**全选**格内文本（不折叠）。
         折叠到末尾是"点格落点"口径，与"选格"是两件事 —— 判据锚 getSelection().toString() == 该格源码。 */
      rng.selectNodeContents(div);
    } else {
      rng.selectNodeContents(div);
      rng.collapse(false);
    }
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(rng);
    syncCellSelection(div);
  };
  focusIt();
}
function deactivateCellOverlay() {
  if (cellOverlay) cellOverlay.style.display = "none";
  cellEdit = null;
  activeCellLayout = null;
  cellRevealIntent = null;
  if (cellPositionFrame) { cancelAnimationFrame(cellPositionFrame); cellPositionFrame = 0; }
}
// A source range inside a replacement table row needs its existing cell owner.
// Search and split navigation share the exact codec mapping and one history.
function activateSourceCellSelection(inputView) {
  if (view !== inputView) return false;
  if (inputView.state.readOnly) return false; // CAND-S1: reading mode keeps the source click non-editing
  const state = inputView.state, sel = state.selection.main;
  if (state.selection.ranges.length !== 1 || !tableContaining(state, sel.head)) return false;
  const line = state.doc.lineAt(sel.head);
  if (isSeparatorBody(line.text.slice(tableLead(line.text).off))) return false;
  const ranges = cellRangesOf(line);
  const col = ranges.findIndex(range => sel.from >= range[0] && sel.to <= range[1]);
  if (col < 0) return false;
  const [from, to] = ranges[col], mapped = mappedCellSource(state.doc.sliceString(from, to));
  // Preserve native source ranges that cannot be represented in the cell DOM.
  if ([sel.anchor, sel.head].some(pos => cellSourceOffset(mapped, cellTextOffset(mapped, pos - from)) !== pos - from)) return false;
  inputView.dispatch({ effects: [setActiveCell.of({ rowFrom: line.from, col }), setTableSel.of(null)],
    annotations: Transaction.addToHistory.of(false) });
  activateCellOverlay(line.from, col, ranges.length, from, to, undefined, false,
    { anchor: sel.anchor, head: sel.head });
  return true;
}
// Search returns to the cell owner after CM's focus() finishes.
const searchCellFocus = EditorView.domEventHandlers({
  focus(event, inputView) {
    if (event.target !== inputView.contentDOM || !event.relatedTarget?.closest?.('.cm-search')) return false;
    queueMicrotask(() => {
      if (view !== inputView || !document.hasFocus() || document.activeElement !== inputView.contentDOM || !inputView.hasFocus) return;
      activateSourceCellSelection(inputView);
    });
    return false;
  },
});
/** 【β1】覆盖层路径的**统一落点收场**：跑一个 apply*（它内部已经 dispatch 了文档/选区），
 *  然后把活动格与覆盖层搬到它返回的落点上。返回 null（表外）⇒ 什么也不做；
 *  返回 rejected/stopped（表内但零改动）⇒ 只重定位、不换格。
 *  ⚠️【陈旧选区】点格只 dispatch setActiveCell、**不落 CM 选区**（tableCellClick 末尾 return true
 *  阻断了 CM6 的选区更新）⇒ 直接按选区判"在不在表内"会落在文首（老症状："点着格子按表格键没反应"）。
 *  所以先把 CM 光标落到**活动格起点**，再跑键位层核心。 */
function moveActiveCellByKey(run) {
  if (!view) return;
  primeTableGeometry(view, activeCellDOM());
  if (cellEdit) {
    const cur = view.state.selection.main;
    if (!(cur.head >= cellEdit.from && cur.head <= cellEdit.to)) {
      view.dispatch({ selection: EditorSelection.cursor(cellEdit.from) });
    }
  }
  let dest = null;
  try { dest = run(); } catch (err) { console.error("[mp] 表格键位执行失败：", err); }
  if (!dest) return;
  if (dest.rejected || dest.stopped) { positionCellOverlay(); return; }
  const rowFrom = dest.rowFrom, col = dest.col;
  const line = view.state.doc.lineAt(rowFrom);
  const ranges = cellRangesOf(line);
  primeTableGeometry(view, view.contentDOM.querySelector(`.mp-row [data-mp-row="${rowFrom}"]`));
  view.dispatch({ effects: setActiveCell.of({ rowFrom, col }) });
  if (ranges[col]) activateCellOverlay(rowFrom, col, ranges.length, ranges[col][0], ranges[col][1]);
  else deactivateCellOverlay();
}
/* ══ β1 选择层级（格 → 行 → 列 → 整表 → 全文档）══
 *  为什么**不**把 sel 塞进 activeCellField（`REVIEW-BETA.md` §3.1 的架构级反例）：
 *   行/列/整表三级必须**关掉覆盖层**，而关掉覆盖层（display:none）会让那个 contenteditable 失焦
 *   ⇒ blur 处理器同步 dispatch setActiveCell(null) ⇒ 刚设好的 sel 被一起清空、递进阶梯原地归零。
 *   所以另开一个与活动格**解耦**的 StateField（tableDecorations 同时读两个 field）。
 *  行/列/整表的高亮**不能靠原生选区**：表格源码行被 block widget 整行替换，那些选区在屏幕上不可见
 *  （`BETA-KEYS.md` §1.3-①）⇒ 只能走 widget DOM 的 class（.mp-sel-row / .mp-sel-col / .mp-sel-table）。
 *
 *  已知取舍（判据里锚住，不假装没有）：
 *   · 列层级没有线性文本选区可表达（CM6 只有线性选区）⇒ 文本选区收在当前格，"复制本列"必须是命令；
 *     Ctrl+C 在列层级给的是**当前格源码**（K20 的红侧就是这条）；
 *   · 整表层级 Ctrl+X 会删掉整块（可撤销），与"表消失"同义 —— 行层级的 Ctrl+X 另走"删除本行"
 *     （见 docSourceClipboard.cut 的 rowCut 分支：直接 replaceSelection 会把表切成"只剩表头"）。 */
const setTableSel = StateEffect.define(); // { kind, rowFrom, col } | null
const tableSelectionField = StateField.define({
  create: () => null,
  update(value, tr) {
    let v = value, explicit = false;
    for (const e of tr.effects) if (e.is(setTableSel)) { v = e.value; explicit = true; }
    if (!v) return null;
    if (tr.docChanged) {
      const rowFrom = tr.changes.mapPos(v.rowFrom, 1);
      const tables = tableTablesOf(tr.state);
      if (!tables.some((t) => rowFrom >= t.from && rowFrom <= t.to)) return null;   // 表没了/变形 ⇒ 收场
      v = { ...v, rowFrom };
    }
    /* 【#34·2026-10-18 实测缺陷】表级状态只由 setTableSel 清除，而"点表外正文"只改选区 ⇒
       field 残留，tableSelInputGuard 会把表外键入按记住的格搬回格内：
       实测行级选择后点段落打 X，字符落进 | Xa1 | a2 |、正文不变（focused-48）。
       修法：没有显式 setTableSel 的选区变化，必须仍与该层级应有的选区逐字一致，否则收场。 */
    if (!explicit && tr.selection) {
      const line = tr.state.doc.lineAt(v.rowFrom);
      const ranges = cellRangesOf(line);
      const r = ranges[Math.max(0, Math.min(v.col, ranges.length - 1))];
      let want = null;
      if (v.kind === "row") want = { from: line.from, to: line.to };
      else if (v.kind === "cell" || v.kind === "col") want = r ? { from: r[0], to: r[1] } : null;
      else if (v.kind === "table") {
        const tb = tableTablesOf(tr.state).find((t) => v.rowFrom >= t.from && v.rowFrom <= t.to);
        want = tb ? { from: tb.from, to: tb.to } : null;
      }
      const sel = tr.selection.main;
      if (!want || sel.from !== want.from || sel.to !== want.to) return null;
    }
    return v;
  },
});
function tableTablesOf(state) { try { return state.field(tableDataField) || []; } catch { return []; } }

/** 当前表目标：**活动格优先**（点格不落 CM 选区 —— 只看选区会落到文首），否则看 CM 选区。 */
function tableTargetOf(state) {
  const tables = tableTablesOf(state);
  const hit = (pos) => tables.find((t) => pos >= t.from && pos <= t.to) || null;
  const active = state.field(activeCellField, false);
  if (active) {
    const tb = hit(active.rowFrom);
    if (tb) return { table: tb, rowFrom: active.rowFrom, col: active.col, viaOverlay: true };
  }
  const head = state.selection.main.head;
  const tb = hit(head);
  if (!tb) return null;
  let line = state.doc.lineAt(head);
  /* 分隔行没有自己的 td（它被表头 widget 吃掉了）⇒ 落到分隔行时按表头行算，否则覆盖层无处可放。 */
  if (isSeparatorBody(line.text.slice(tableLead(line.text).off)) && line.number > 1) line = state.doc.line(line.number - 1);
  const ranges = cellRangesOf(line);
  let col = 0;
  for (let i = 0; i < ranges.length; i++) if (head >= ranges[i][0]) col = i;
  return { table: tb, rowFrom: line.from, col, viaOverlay: false };
}

/** Ctrl+E / 递进第 1 级：打开覆盖层并**全选**格内文本。
 *  ⚠️ 不能用 activateCellOverlay 的默认收尾（它 selectNodeContents 之后 collapse(false) ⇒ 光标折到格尾，
 *  那是"点格落点"口径）；全选与否是**两件事**，判据锚的是 getSelection().toString() == 该格源码。
 *  ⚠️ 第 1 级**也要把 kind 记进 field**：不记的话下一次 Ctrl+A 读到 null 又回到"格"级 —— 递进卡死。 */
function selectCellText() {
  if (!view) return false;
  const t = tableTargetOf(view.state);
  if (!t) return false;
  const line = view.state.doc.lineAt(t.rowFrom);
  const ranges = cellRangesOf(line);
  if (!ranges.length) return false;
  const col = Math.max(0, Math.min(t.col, ranges.length - 1));
  const r = ranges[col];
  view.dispatch({ effects: [setActiveCell.of({ rowFrom: t.rowFrom, col }), setTableSel.of({ kind: "cell", rowFrom: t.rowFrom, col })] });
  activateCellOverlay(t.rowFrom, col, ranges.length, r[0], r[1], undefined, true);
  return true;
}

/** 设/清选择层级。行、列、整表三级都要**先关覆盖层**（顺序写死：
 *  navigating=true → dispatch(setActiveCell null) → deactivateCellOverlay → view.focus()）。 */
function setSelLevel(kind, target) {
  if (!view) return false;
  const t = target || tableTargetOf(view.state);
  if (!t) return false;
  if (kind === "cell") return selectCellText();
  const st = view.state;
  const line = st.doc.lineAt(t.rowFrom);
  const ranges = cellRangesOf(line);
  const col = Math.max(0, Math.min(t.col, Math.max(0, ranges.length - 1)));
  let sel;
  if (kind === "row") sel = EditorSelection.range(line.from, line.to);
  /* 列层级：CM6 只有线性选区，"第 k 列"在源码里不是连续区间 ⇒ 文本选区**收在当前格**
     （整格区间，不是折叠光标 —— 折叠的话 Ctrl+C 会走 CM 的"复制整行"约定，给出的是整行源码）。 */
  else if (kind === "col") { const r = ranges[col]; sel = r ? EditorSelection.range(r[0], r[1]) : EditorSelection.cursor(line.from); }
  else sel = EditorSelection.range(t.table.from, t.table.to);
  if (cellEdit) cellEdit.navigating = true;                 // 【死开关用起来】挡住 blur 收场
  view.dispatch({ selection: sel, effects: [setTableSel.of({ kind, rowFrom: t.rowFrom, col }), setActiveCell.of(null)] });
  deactivateCellOverlay();
  view.focus();
  return true;
}

/** Ctrl+A 递进：无 → 格 → 行 → 列 → 整表 → 全文档（到顶再按＝让原生 selectAll 接手，**不循环回格**）。 */
function cycleTableSelection() {
  if (!view) return false;
  const st = view.state;
  const main = st.selection.main;
  if (main.from === 0 && main.to === st.doc.length) return false;   // 已是全文档 ⇒ 幂等，让原生接手
  const t = tableTargetOf(st);
  if (!t) return false;                                             // 表外 ⇒ 逐字节不变（原生全选）
  const cur = st.field(tableSelectionField, false);
  const kind = cur ? cur.kind : null;
  if (!kind) return setSelLevel("cell", t);
  if (kind === "cell") return setSelLevel("row", t);
  /* 【列号必须沿用**记下来的那一格**】行层级那一拍会把活动格清掉（关覆盖层），下一拍再按选区
     反推会落到"行尾那个格"（用户点的是 b1，反推出来是 c1）⇒ 行→列、列→整表都带上 rowFrom/col。 */
  if (kind === "row") return setSelLevel("col", { table: t.table, rowFrom: cur.rowFrom, col: cur.col });
  if (kind === "col") return setSelLevel("table", { table: t.table, rowFrom: cur.rowFrom, col: cur.col });
  view.dispatch({ selection: EditorSelection.range(0, st.doc.length), effects: setTableSel.of(null) });
  return true;
}

/** 行/列/整表层级下**用户打字**：先把表级状态清掉、把选区折叠到该格**内容起点**再放行
 *  （不然一个看不见的按键会插到 line.from 上、把表行结构改掉 —— `REVIEW-BETA.md` §3.5）。 */
const tableSelInputGuard = EditorState.transactionFilter.of((tr) => {
  const cur = tr.startState.field(tableSelectionField, false);
  /* 【#12 收窄·2026-10-17】守卫只承行/列/整表层级：格级选区下的替换是正常编辑，放行后行数才不会被改写掉。 */
  if (!cur || cur.kind === 'cell' || !tr.docChanged) return tr;
  /* 退格/删除也必须走本守卫（见下面的 deleted 分支）：delete.selection 不属于 input 事件族。 */
  /* 【表格命令不许被当键入改写·2026-10-17 实测缺陷 TBL-5b】rewriteTable / 删除表格 / 设对齐的事务
     都带 userEvent:'input.table'，而 isUserEvent("input") 对它**为真** ⇒ 行/列层级下任何表格命令
     都被本守卫"把输入搬进该格"整体改写：实测 Ctrl+Enter 插行得到 8 行、3 条分隔行 ——
     整张新表被塞进那条行级选区，后面的原表还在（文档被写坏）。
     同理 input.format：格内 Ctrl+B 的包裹事务也被改写成"在格内容起点插入 **a2**"，于是原文本没被
     替换、文档变成 **a2**a2。命令自己已经给出正确终态（含选区），守卫只承键入与删除。 */
  /* 【#37·2026-10-18 实测缺陷 N1】查找面板的 Replace / Replace-All 用 userEvent:'input.replace'
     （isUserEvent("input") 对它为真）⇒ 行级/整表级选择下整笔替换事务被守卫搬成
     "把 N 个替换文本串成一条插进格首"：实测 2 处 foo 一个都没被替换、格变成 | ZZZZa1 | a2 |。
     替换命令自己给出正确 changes（与表格命令同族），放行；选区收场由 #34 的选区一致性检查兜住。 */
  if (tr.isUserEvent("input.table") || tr.isUserEvent("input.format") || tr.isUserEvent("input.replace")) return tr;
  if (!(tr.isUserEvent("input") || tr.isUserEvent("delete"))) return tr;
  /* 【#36·2026-10-18】改写事务必须继承原 userEvent：命令族（input.emoji / input.paste 等）
     不能被改写成 input.type —— 否则会和紧邻键入并进同一撤销组（CAND-5 已验"表情单独一组"）；
     原生键入的 userEvent 本来就是 input.type，语义完全不变。 */
  const srcEvent = tr.annotation(Transaction.userEvent) || "input.type";
  let at = tr.startState.selection.main.head;
  try {
    const line = tr.startState.doc.lineAt(cur.rowFrom);
    const ranges = cellRangesOf(line);
    const r = ranges[Math.max(0, Math.min(cur.col, ranges.length - 1))];
    if (r) { const seg = line.text.slice(r[0] - line.from, r[1] - line.from); at = r[0] + (seg.length - seg.trimStart().length); }
  } catch { /* 算不出来就用原 head */ }
  /* 【改写而不是只折叠·2026-10-17 实测缺陷】旧实现返回数组 [「{selection, effects}」, tr]：
     CM6 把后一个 spec 的 changes 按绝对位置合进来 ⇒ 实测“表格行级选区 + 键入”**既没删掉选区、
     也没落在格内**：字符被插到表格**下方**的新行里（#12）。
     现在按本函数注释的既定契约自己发一次事务。 */
  let inserted = "", deleted = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, ins) => { inserted += ins.toString(); if (toA > fromA) deleted = true; });
  if (inserted) {
    return { changes: { from: at, insert: inserted }, selection: EditorSelection.cursor(at + inserted.length), effects: setTableSel.of(null), userEvent: srcEvent };
  }
  if (deleted) {
    /* 【退格/删除同样不能毁表·2026-10-17 实测缺陷】改前门禁只认 input* 事件族，而 CM6 对
       "退格删掉一个非空选区"发的是 delete.selection ⇒ 守卫完全绕过：实测行级选区 30..41
       按 Backspace/Delete，整行数据被删掉、表被切成两段（TBL-2，S2 数据丢失）。
       口径与 Ctrl+X 的 row-delete 守卫一致：不删源码，只把表级状态收场、光标回到该格内容起点。 */
    return { selection: EditorSelection.cursor(at), effects: setTableSel.of(null) };
  }
  return { selection: EditorSelection.cursor(at), effects: setTableSel.of(null) };
});

/** 行层级的剪切判定：选区**正好是某一条完整表行**（[line.from, line.to]）且在表块里。 */
function isFullTableRowSelection(st) {
  const ranges = st.selection.ranges;
  if (ranges.length !== 1 || ranges[0].empty) return false;
  const r = ranges[0];
  let line;
  try { line = st.doc.lineAt(r.from); } catch { return false; }
  if (r.from !== line.from || r.to !== line.to) return false;
  return tableTablesOf(st).some((t) => line.from >= t.from && line.to <= t.to);
}

function tableRowWidgetFor(state,tb,block,isHeader,region) {
  const active = state.field(activeCellField);
  const sel = state.field(tableSelectionField, false);
  /* 【β1】行/列/整表的高亮只能靠 widget DOM 的 class（源码行被 block widget 整行替换，
     原生选区在屏幕上不可见）⇒ 把选择状态编成一个短 key 传给 widget，由它在 toDOM 里落 class。 */
  const selKey = sel ? sel.kind + ":" + sel.rowFrom + ":" + sel.col : "";
  const ranges = cellRangesOf(state.doc.lineAt(block.from));
  if (!ranges.length) return null;
  const activeCol = active && active.rowFrom === block.from ? active.col : -1;
  return new TableRowWidget(isHeader ? tb.headerBlock.cells : block.cells, tb.widths, isHeader, ranges, block.from, activeCol,
    tb.headerBlock.qDepth || 0, block.lead || 0, tb.weights || null, selKey, tb.aligns || null, region, tableRowGeometry(state,tb,block,isHeader,region));
}
// Native source ranges need real DOM text at every table-block endpoint without a cell/table owner.
function sourceTableBlockRange(state, previous = null) {
  if (state.readOnly || state.field(activeCellField, false) || state.field(tableSelectionField, false) ||
      state.selection.ranges.length !== 1) return null;
  const tables = state.field(tableDataField);
  if (!tables.length) return null;
  const sel = state.selection.main;
  // scanTables and mapTables retain ordered, disjoint table and row source ranges.
  let lo = 0, hi = tables.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (tables[mid].to < sel.from) lo = mid + 1;
    else hi = mid;
  }
  const firstTable = lo;
  if (firstTable === tables.length || tables[firstTable].from > sel.to) return null;
  lo = firstTable; hi = tables.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (tables[mid].from <= sel.to) lo = mid + 1;
    else hi = mid;
  }
  const lastTable = lo - 1;
  const blockAt = (table, index) => index ? table.rows[index - 1] : table.headerBlock;
  const first = tables[firstTable], last = tables[lastTable];
  lo = 0; hi = first.rows.length + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (blockAt(first, mid).to < sel.from) lo = mid + 1;
    else hi = mid;
  }
  const firstIndex = lo;
  if (firstIndex > first.rows.length) return null;
  const firstBlock = blockAt(first, firstIndex);
  lo = 0; hi = last.rows.length + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (blockAt(last, mid).from <= sel.to) lo = mid + 1;
    else hi = mid;
  }
  const lastIndex = lo - 1;
  if (lastIndex < 0 || (firstTable === lastTable && firstIndex > lastIndex)) return null;
  const lastBlock = blockAt(last, lastIndex);
  if (firstBlock.from > lastBlock.to || firstBlock.to < sel.from || firstBlock.from > sel.to ||
      lastBlock.to < sel.from || lastBlock.from > sel.to) return null;
  if (previous && previous.from === firstBlock.from && previous.to === lastBlock.to) return previous;
  return { from: firstBlock.from, to: lastBlock.to };
}
const tableSourceRangeField = StateField.define({
  create(state) { return sourceTableBlockRange(state); },
  update(value, tr) {
    if (!tr.docChanged && !tr.selection && tr.startState.readOnly === tr.state.readOnly &&
        tr.startState.field(activeCellField) === tr.state.field(activeCellField) &&
        tr.startState.field(tableSelectionField) === tr.state.field(tableSelectionField) &&
        tr.startState.field(tableDataField) === tr.state.field(tableDataField)) return value;
    return sourceTableBlockRange(tr.state, value);
  },
});
const tableDecorations = EditorView.decorations.compute([tableDataField, activeCellField, tableSelectionField, tableSourceRangeField], (state) => {
  const out = [];
  const source = state.field(tableSourceRangeField);
  for (const tb of state.field(tableDataField)) {
    const mk = (block, isHeader) => {
      if (source && block.from >= source.from && block.to <= source.to) return;
      const widget = tableRowWidgetFor(state,tb,block,isHeader,regionAt(state.field(regionIndexField),block.from,'table'));
      if (!widget) return;
      out.push(Decoration.replace({
        widget,
        block: true,
      }).range(block.from, block.to));
    };
    mk(tb.headerBlock, true);
    for (const row of tb.rows) mk(row, false);
  }
  return Decoration.set(out, true);
});
/** 点单元格 → 激活格内编辑（覆盖层在 body 上；无格归属的原生表格范围显示对应源码） */
let mpDropSource = null;
/* C14【限定能力·非通用框架】owned native-text 拖源记录与只读校验：
 * 仅由真实 trusted 非空 dragstart 绑定同视图源（view/doc 引用/epoch/区间/精确源文本）；
 * readonly、dragend、Escape 取消一律清空；drop 各分支运行前一次性消费清空。
 * 判定 move 只看：同 view、同一 doc 引用、epoch 一致、区间在界、当前源文本逐字相等、
 * RAW 载荷逐字相等、实际 effectAllowed 枚举允许 move，且按实际公开
 * EditorView.dragMovesSelection facet 语义（默认 mac !altKey / 其它 !ctrlKey，
 * 实际平台探测）——绝不读捕获相 dropEffect，绝不写 DataTransfer MIME/effect，
 * 不触 CM 私有 inputState，不加新 observer/timer/重扫/历史改写；
 * CM 自身 dragstart/dragend 机制保持原生。缺失/过期/外部/不可读一概不删旧源。 */
function mpDropBind(view) {
  const s = view.state.selection.main;
  if (view.state.readOnly || s.empty) { mpDropSource = null; return null; }
  let epoch = null;
  try { const ri = view.state.field(regionIndexField, false); epoch = ri && Number.isFinite(ri.epoch) ? ri.epoch : null; } catch { epoch = null; }
  mpDropSource = { view, doc: view.state.doc, epoch, from: s.from, to: s.to, text: view.state.sliceDoc(s.from, s.to) };
  return mpDropSource;
}
function mpDropMoveCheck(view, event, rec, rawPayload) {
  const checks = {
    recordBound: !!rec,
    sameView: !!(rec && rec.view === view),
    sameDoc: !!(rec && view.state.doc === rec.doc),
    epochStable: (() => { if (!rec) return false; if (rec.epoch == null) return false; try { const ri = view.state.field(regionIndexField, false); const now = ri && Number.isFinite(ri.epoch) ? ri.epoch : null; return now === rec.epoch; } catch { return false; } })(),
    rangeInBounds: !!(rec && rec.from >= 0 && rec.to > rec.from && rec.to <= view.state.doc.length),
    sourceTextExact: !!(rec && view.state.sliceDoc(rec.from, rec.to) === rec.text),
    rawPayloadExact: typeof rawPayload === 'string' && !!rec && rawPayload === rec.text,
    effectAllowsMove: (() => { try { const ea = event.dataTransfer && event.dataTransfer.effectAllowed; return ea === 'move' || ea === 'copyMove' || ea === 'linkMove' || ea === 'all'; } catch { return false; } })(),
    dragMovesSelection: (() => { try { const facet = view.state.facet(EditorView.dragMovesSelection); if (facet && facet.length) return !!facet[0](event); const mac = /Mac|iPhone|iPad|iPod/.test(String(navigator.platform || navigator.userAgent || '')); return mac ? !event.altKey : !event.ctrlKey; } catch { return false; } })(),
  };
  const valid = checks.recordBound && checks.sameView && checks.sameDoc && checks.epochStable && checks.rangeInBounds && checks.sourceTextExact && checks.rawPayloadExact && checks.effectAllowsMove;
  return { valid, move: valid && checks.dragMovesSelection, checks };
}
function mpDropClear() { mpDropSource = null; }
const tableCellClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    /* 【阅读态不许改稿·2026-10-17 实测缺陷 #26】覆盖层挂在 body 上、改稿走 view.dispatch，
       EditorState.readOnly 只拦输入级命令、**不拦程序化 dispatch** ⇒ 阅读态点一格照样能打字改稿
       （实测 len 50→52）。这里与 syncCellEdit 双保险：入口不开、写口不写。 */
    if (view.state.readOnly) return false;
    let cell = event.target && event.target.closest ? event.target.closest(".mp-row th[data-mp-row], .mp-row td[data-mp-row]") : null;
    /* 【#66】点在表格**左/右边缘**（与某行同一水平带、距最近格 ≤24px）也归到该格：
       否则 CM6 把 caret 放进块 widget 的源码行、而 DOM 选区落在 widget 边界 ⇒ 随后键入
       （西文与 IME 都实测）被写到**表格之后**的新行（行级数据错位）。 */
    if (!cell) {
      const NEAR_X = 24, NEAR_Y = 10;
      let best = null, bestD = Infinity;
      for (const c of document.querySelectorAll(".mp-row th[data-mp-row], .mp-row td[data-mp-row]")) {
        const b = c.getBoundingClientRect();
        const dx = Math.max(b.left - event.clientX, 0, event.clientX - b.right);
        const dy = Math.max(b.top - event.clientY, 0, event.clientY - b.bottom);
        if (dx <= NEAR_X && dy <= NEAR_Y) { const d = dy * 4 + dx; if (d < bestD) { bestD = d; best = c; } }
      }
      cell = best;
    }
    if (!cell) return false;
    const rowFrom = Number(cell.dataset.mpRow);
    const col = Number(cell.dataset.mpCol);
    if (!Number.isFinite(rowFrom) || !Number.isFinite(col)) return false;
    const line = view.state.doc.lineAt(rowFrom);
    const ranges = cellRangesOf(line);
    if (!ranges.length) return false;
    /* 【点击映射】幻影格（源码里没有这一列，见 toDOM 的 data-mp-phantom）**钳到最近的真实格**；
       无论哪种情况，setActiveCell 与覆盖层都必须一起动 —— 改前 setActiveCell 先动、覆盖层被
       「if (ranges[col])」挡下，于是"激活的是幻影列、显示的是上一格的字"，继续打字会写错格。 */
    const realCol = Math.min(Math.max(0, col), ranges.length - 1);
    const r = ranges[realCol];
    if (!r) return false;
    primeTableGeometry(view, cell);
    /* 【β1】点新格 ⇒ 清掉表级选择状态（行/列/整表高亮不该跨格留着） */
    view.dispatch({ effects: [setActiveCell.of({ rowFrom, col: realCol }), setTableSel.of(null)] });
    // Activation measures the current source layout before mapping this pointer;
    // the rendered cell may have been detached by the active-cell transaction.
    activateCellOverlay(rowFrom, realCol, ranges.length, r[0], r[1], undefined, false, undefined,
      { x: event.clientX, y: event.clientY });
    return true;
  },
  /* 【#33·2026-10-17 实测缺陷】文本拖到渲染表格上时，CM6 的 drop 在块级 widget 上只能取到**块边界**位置
     ⇒ 落点被钳到表行行首，插入的字符还会把行首管道挤掉（实测 | a1 | a2 | → 源| a1 | a2 |，表结构损坏）。
     这里按指针命中的格（data-mp-row / data-mp-col）算出该格的源码区间，把拖入文本插进**该格内容末尾**；
     起拖区间在 dragstart 记住（C14：完整 owned 记录），经 mpDropMoveCheck 校验为 move 时一并删除。
     【C14·2026-10-22 实测缺陷（root r3 qualified RED）】同视图真实 MOVE 被当 copy：块分支只插入不删源
     （拖三字 原文仍在、caret 48≠45、Undo 只回插入选区 4..7、Redo 重复）；格分支读**捕获相**
     dropEffect（实测 none）而最终 dragend 才是 move。删除资格改为只读校验 + 实际公开
     EditorView.dragMovesSelection 语义，绝不写 DataTransfer。 */
  dragstart(event, view) {
    if (!event.isTrusted || view.state.readOnly) { mpDropSource = null; return false; }
    mpDropBind(view);
    return false;
  },
  dragend() { mpDropClear(); return false; },
  keydown(event) { if (event.key === 'Escape') mpDropClear(); return false; },
  drop(event, view) {
    if (view.state.readOnly) { mpDropSource = null; return false; }
    /* C14：owned 记录在所有分支之前**一次性消费并清空**——过期/外部/已取消的记录
     * 在本 drop 后续任何分支里都不可能再触发删源。 */
    const src = mpDropSource; mpDropSource = null;
    /* 【#33 紧邻边界·2026-10-17】目标不能只认"正好命中的格"：拖到行的 padding / 格间隙 / 行容器上时
       指针在表格里、target 却不是 td（实测会把 b1 行劈成 | b1 源文本尾巴 + | b2 |）。这里退一步按几何取最近的格。 */
    let cell = event.target && event.target.closest ? event.target.closest(".mp-row th[data-mp-row], .mp-row td[data-mp-row]") : null;
    if (!cell && event.target && event.target.closest && event.target.closest(".mp-table-wrap")) {
      let best = null, bestD = Infinity;
      for (const c of document.querySelectorAll(".mp-row th[data-mp-row], .mp-row td[data-mp-row]")) {
        const b = c.getBoundingClientRect();
        const dx = Math.max(b.left - event.clientX, 0, event.clientX - b.right);
        const dy = Math.max(b.top - event.clientY, 0, event.clientY - b.bottom);
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = c; }
      }
      cell = best;
    }
    /* 【#61】拖到**渲染块**（display 公式 / mermaid）上：CM6 原生 drop 只能取到块边界，
       实测落在开围栏行首 ⇒ `三字$$` 把公式围栏挤坏、后续再配对吞正文。这里整块接管：把文本
       作为**块后独立文本行**插入（围栏/代码块源码一字不动），光标放到插入文本尾。
       【C14】经 mpDropMoveCheck 校验的同视图真实 MOVE：删源与插入选乘**同一事务**
       （userEvent 'move.drop'，与 CM dropText 同语义），光标经实际 ChangeSet 映射到
       插入文本末（冻结 M61：旧插入点 45 → 删源映射 42 → caret 45）。重叠形态按
       预先登记的保守策略：安全消费、零文档改动、围栏不动、不做投机 copy。 */
    if (!cell) {
      const blockEl = event.target && event.target.closest
        ? event.target.closest(".mp-cm6-math-block:not(.mp-cm6-math-live), .mp-mermaid") : null;
      if (blockEl) {
        let dtText = "";
        try { dtText = event.dataTransfer ? (event.dataTransfer.getData("text/plain") || "") : ""; } catch { return false; }
        const dtRaw = dtText;   /* C14：归一化前的精确 RAW 载荷，仅供 move 校验 */
        dtText = dtText.replace(/\r?\n+/g, " ").trim();
        if (!dtText) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        let block = null;
        if (blockEl.classList.contains("mp-mermaid")) {
          const blocks = view.state.field(mermaidBlocksField, false) || [];
          block = blocks.find((b) => pos != null && b.from - 1 <= pos && pos <= b.to + 1) || null;
        } else {
          const spans = view.state.field(mathSpansField, false)?.spans || [];
          const s = spans.find((s) => s.display && pos != null && s.from - 1 <= pos && pos <= s.to + 1);
          block = s ? { from: s.from, to: s.to } : null;
        }
        if (!block) { view.focus(); return true; }
        const closeLine = view.state.doc.lineAt(block.to);
        const nextLine = closeLine.number < view.state.doc.lines ? view.state.doc.line(closeLine.number + 1) : null;
        const blankNext = !!(nextLine && !nextLine.text.trim());
        const insFrom = blankNext ? nextLine.from : closeLine.to;
        const insText = blankNext ? dtText : "\n" + dtText;
        const moveCheck = mpDropMoveCheck(view, event, src, dtRaw);
        const srcOutsideBlock = !!(moveCheck.move && src && (src.to < block.from || src.from > block.to));
        const insOutsideSrc = !!(moveCheck.move && src && (insFrom <= src.from || insFrom >= src.to));
        if (moveCheck.move && !(srcOutsideBlock && insOutsideSrc)) {
          /* 保守拒绝（预先登记，测试前决定）：源与受保护块重叠或插入点落在源内 ⇒
           * 安全消费、零文档改动、围栏一字不动；反馈只走既有 extras toast 通道（存在才用）。 */
          try { window.mpExtras && window.mpExtras.toast && window.mpExtras.toast("移动与块/源重叠，已保守拒绝"); } catch { /* 静默消费 */ }
          return true;
        }
        const specs = [{ from: insFrom, insert: insText }];
        if (moveCheck.move && src) specs.push({ from: src.from, to: src.to });
        specs.sort((a, b) => a.from - b.from);
        const changes = view.state.changes(specs);
        const caret = changes.mapPos(insFrom, 1);
        view.dispatch({ changes, selection: EditorSelection.cursor(caret), userEvent: moveCheck.move ? "move.drop" : "input.drop" });
        view.focus();
        return true;
      }
    }
    if (!cell || !event.dataTransfer) return false;
    const rowFrom = Number(cell.dataset.mpRow);
    const col = Number(cell.dataset.mpCol);
    if (!Number.isFinite(rowFrom) || !Number.isFinite(col)) return false;
    let text = "";
    try { text = event.dataTransfer.getData("text/plain") || ""; } catch { return false; }
    const rawText = text;   /* C14：格内归一化/管道转义之前的精确 RAW 载荷，仅供 move 校验 */
    /* 格内不能有换行：换行会把表行劈成两行（实测 | b1 … 换行 | b2 |）。 */
    text = text.replace(/\r?\n+/g, " ");
    /* 【#59】拖入文本里的 `|` 是**格内字面量**，必须按格源编码转义成 `\|`：裸管道会当场把表行劈成
       多列（实测 `| a1 | a2 |b文字|`，表从 2 列变 3 列）。粘贴/覆盖层通道早已走 encodeCellText，拖放漏了。 */
    text = encodeCellText(text);
    const line = view.state.doc.lineAt(rowFrom);
    const ranges = cellRangesOf(line);
    if (!ranges.length) return false;
    const r = ranges[Math.min(Math.max(0, col), ranges.length - 1)];
    if (!r) return false;
    event.preventDefault();
    const specs = [{ from: r[1], insert: text }];
    /* C14：删除资格改为共享只读校验（同视图/doc/epoch/界内/源文本/RAW 载荷逐字 +
     * effectAllowed 允许 move + 实际 dragMovesSelection facet 语义）——实测捕获相
     * dropEffect=none 而最终 dragend=move，旧口径把真实 MOVE 当 copy。Ctrl=copy 保持保源。 */
    const moveCheck = mpDropMoveCheck(view, event, src, rawText);
    const isMove = moveCheck.move;
    if (isMove && src && (src.to <= r[1] || src.from >= r[1])) specs.push({ from: src.from, to: src.to });
    specs.sort((a, b) => a.from - b.from);
    const changes = view.state.changes(specs);
    const caret = changes.mapPos(r[1], 1);
    const tr = view.state.update({ changes, selection: EditorSelection.cursor(caret), userEvent: "input.table" });
    view.dispatch(tr);
    /* 【#57】收场选区必须用事务后的映射位置：旧写法 `anchor: r[1] + text.length` 在 move 形态下没扣掉
       拖源删除量 ⇒ 文末表格末格抛 "Selection points outside of document"（整次拖放无效）、非末格 caret
       右偏拖源长度（接着打字写进隔壁格）。另外表格行是 block widget，状态选区落在格内**没有可显示的
       DOM caret**，键入会跑到表外 ⇒ 与点格/IME 同路径：立活动格并打开格覆盖层，caret 落在插入文本尾。 */
    const newRowFrom = tr.changes.mapPos(rowFrom, 1);
    const newLine = tr.state.doc.lineAt(newRowFrom);
    const newRanges = cellRangesOf(newLine);
    const nr = newRanges[Math.min(Math.max(0, col), newRanges.length - 1)];
    view.dispatch({ effects: [setActiveCell.of({ rowFrom: newRowFrom, col }), setTableSel.of(null)] });
    /* activateCellOverlay 自己会把焦点给覆盖层；**不要再 view.focus()** —— 覆盖层 blur 处理器
       （cellEdit && !navigating ⇒ setActiveCell(null)+收起）会当场把刚开的输入框关掉（实测）。 */
    if (nr) activateCellOverlay(newRowFrom, col, newRanges.length, nr[0], nr[1], Math.max(0, caret - nr[0]));
    else view.focus();
    return true;
  },
});
const headingDecorations = EditorView.decorations.compute(["selection", lineStylesField], (state) => {
  const out = [];
  const { headings, hrs, fenceLines } = state.field(lineStylesField);
  const notIn = (line) => !state.selection.ranges.some((r) => r.from <= line.to && r.to >= line.from);
  for (const mark of headings) {
    const line = state.doc.lineAt(mark.from);
    if (notIn(line)) out.push(Decoration.replace({}).range(mark.from, mark.to)); // 光标不在 → 隐藏井号
  }
  for (const line of hrs) {
    if (notIn(line)) {
      out.push(Decoration.line({ class: "mp-hr" }).range(line.from));
      // Structural lines have different height from prose. Keep their literal
      // source in a semantic span so CM's short-text metric sampling cannot
      // promote an HR's 34px line-height to the entire virtual document.
      out.push(Decoration.mark({ attributes: { 'data-mp-line-metric': 'structural' } }).range(line.from, line.to));
    }
  }
  // 围栏行（```）阅读态压扁隐藏（vditor 隐藏围栏观感）；光标入行显源码
  for (const line of fenceLines) {
    if (notIn(line)) out.push(Decoration.line({ class: "mp-fence" }).range(line.from));
  }
  return Decoration.set(out, true);
});
const lineClassDecorations = EditorView.decorations.compute([lineStylesField], (state) => {
  const out = [], styles = state.field(lineStylesField);
  const numbers = new Map(styles.codeLines.map(c => [c.line.from, String(c.n)]));
  for (const s of styles.styled) {
    const n = numbers.get(s.line.from);
    out.push(Decoration.line({ class: s.cls, ...(n ? { attributes: { 'data-mp-n': n } } : {}) }).range(s.line.from));
  }
  return Decoration.set(out);
});

/* ══ 行内标记投影（**、`、~~、[ ]( )——阅读态隐藏，光标入段显源码）══
 *  与标题井号同一 F7 架构：数据层 docChanged 重扫＋selection 派生 O(marks)。
 *  链接：隐藏 [ 与 ](url) 包裹件；强调对：隐藏两侧定界符。与数学 span 互斥
 *（重叠 replace 装饰会抛错——扫描时按 mathSpans 过滤）。 */
/** 图片 widget（编辑面真图）。
 *  · 两条来源共用它：markdown 的 ![](url) 与**裸 <img …>** HTML（Typora/Word 粘贴出来的形态）；
 *  · **src 在 toDOM 里才赋**：CM6 只为视口内的行建 widget ⇒ 只有可见的图会解码；
 *    本机复现的 8.13MB 文档有 20 张 500~900KB 的 data URI，打开时全部解码会拖垮首屏；
 *  · eq 逐项比 src/alt/title/宽高（src 相同时是字符串同引用比较，廉价）；
 *  · ignoreEvent() 返回 false：点图能把光标放进源码（与表格/公式的既有取舍一致）。 */

/** 图片地址解析的**基准目录**：相对路径必须相对**当前文档所在目录**，不能相对应用目录
 *  （否则会解析到 `…\resources\app.asar\…` 或便携解包临时目录 ⇒ ERR_FILE_NOT_FOUND，验收清单实测）。
 *  做法与浏览器同构：写一个 `<base href="file:///D:/docs/">`，让**所有**相对 URL（`<img>`/KaTeX 字体/…）
 *  自动按它解析；壳层在装载文档时把目录经 `window.mpEngine.setDocPath()` 送进来。
 *  拿不到目录（未命名文档/插件宿主）时不动 base，退回应用目录（现状），并在 console 说明一次。 */
let mpDocDir = "";
let mpImgPreviewEpoch = 0;
/** 入参可以是**文件路径**（`D:\docs\a.md`）也可以是**目录**（`D:/docs`、`D:/docs/`）——
 *  壳层两种都可能给，所以判据不能只看末尾有没有斜杠：
 *  ① 先统一成正斜杠；② 末尾是斜杠 ⇒ 已按目录处理；③ 否则看最后一段有没有扩展名，
 *  有扩展名（`a.md`）才砍掉最后一段，没有扩展名（`docs`、`v306`）就当成目录名原样保留。
 *  【踩坑】早先一律 `lastIndexOf('/')` 砍尾 ⇒ 传目录 `…/.mp-verify/v306` 会被砍成 `…/.mp-verify/`，
 *  图片于是解析到上一层（装机表现为"图还是裂的"，而 base 看着"设好了"）。 */
function mpSetDocPath(filePath, isDirectory = false) {
  try {
    let dir = "";
    if (filePath && typeof filePath === "string") {
      let norm = filePath.replace(/\\/g, "/").trim();
      if (norm && !norm.endsWith("/")) {
        const last = norm.slice(norm.lastIndexOf("/") + 1);
        if (!isDirectory && /\.[A-Za-z0-9]{1,8}$/.test(last)) norm = norm.slice(0, norm.lastIndexOf("/") + 1);  // 文件 ⇒ 取目录
        else norm += "/";                                                                        // 目录 ⇒ 补斜杠
      }
      dir = norm;
    }
    if (dir === mpDocDir) return mpDocDir;
    mpDocDir = dir;
    imgBlobInvalidate('docdir', null);
    let base = document.querySelector("base[data-mp-docbase]");
    if (dir) {
      if (!base) { base = document.createElement("base"); base.setAttribute("data-mp-docbase", "1"); document.head.insertBefore(base, document.head.firstChild); }
      base.href = fileUrlOfPath(dir);
    } else if (base) base.remove();
    return mpDocDir;
  } catch (e) { console.error("[mp] 文档目录设置失败：", e); return mpDocDir; }
}
/** 图片地址：相对路径按文档目录解析成绝对 URL；已是绝对/data/blob 的原样返回。
 *  【为什么在渲染时算而不是扫描时算】base 是文档级的，渲染时读一次最省；
 *  解析结果是稳定字符串 ⇒ widget 的 srcKey 也跟着稳定，不会每帧重建。 */
function mpImgSrc(src) {
  return resolveImageSource(src, mpDocDir);
}

/* ══ 【task-12】图片失败/加载中的**可见占位**（纯渲染层：只动 DOM，不进源码/复制/导出）════════
 *  来由（用户报障 + 真实主机实测）：远程图返回 403 时，widget 只剩一个 900×26.2 的空盒、
 *  文本为空、natural 0×0 ⇒ 用户看到"什么都没有，好似空内容"（他以为标题下没东西，其实那里有图）。
 *  不变量：**只要 mark 被识别成图片，屏幕上就必须有可见物**。
 *  原因文案纪律：`<img>` 的 error **不携带 HTTP 状态码** ⇒ 只许写"图片加载失败"/"加载超时"；
 *  真实状态码要等主进程 downloadImageToCache 那条通道接上（见 preload.js L30），**在那之前不许编原因**。 */
/* 【F7 两态】src 指纹 → 'ok' | 'loading-failed' | 'timeout'。
   用途：光标落在 mark 内（且 src≤512）时按 F7 露源码；**但若这张图已被判定取不到，就必须继续显示占位**，
   否则"我在编辑 URL"与"这张图是坏的"在屏幕上无法区分。 */
const mpImgLoadState = new Map();
/* 每个 src 已尝试的次数（配合上面的"最多 2 次"闩锁） */
const mpImgTries = new Map();
// Only short addresses need persistent failure state while their source is edited.
// Data URIs stay rendered and must not pin previous multi-megabyte documents here.
const mpImgKey = (s) => s.length <= 512 ? mpImgSrc(s) : null;
const MP_IMG_TIMEOUT_MS = 10000;
function mpImgFailGuard(wrap, img, rawSrc, lease = null, loaded = null, previous = null, assetEpoch = mpImgPreviewEpoch) {
  if (assetEpoch !== mpImgPreviewEpoch) return () => {};
  let done = false;
  let timer = 0;
  const settle = (state, reason) => {
    if (done) return;
    if (assetEpoch !== mpImgPreviewEpoch) return;
    if (lease && !lease.valid(false)) return;
    done = true;
    if (timer) clearTimeout(timer);
    wrap.classList.remove("is-loading");
    wrap.removeAttribute("data-mp-img-state");
    if (state === "ok") {
      if (previous && previous !== img) previous.remove();
      img.classList.remove('mp-img-pending');
      wrap.classList.remove("is-failed", 'is-stale');
      wrap.querySelector('.mp-img-fallback')?.remove();
      loaded?.(); return;
    }
    wrap.classList.add("is-failed");
    wrap.classList.toggle('is-stale', !!previous);
    wrap.setAttribute("data-mp-img-state", state);          // 取证口：loading-failed / timeout
    if (wrap.querySelector(".mp-img-fallback")) return;     // 同 src 只建一次，不狂重试
    const fb = document.createElement("span");
    fb.className = "mp-img-fallback";
    const icon = document.createElement("span");
    icon.className = "mp-img-broken";
    icon.textContent = "🖼";
    const why = document.createElement("span");
    why.className = "mp-img-why";
    why.textContent = reason;
    const url = document.createElement("span");
    url.className = "mp-img-url";
    url.textContent = rawSrc.length > 512 ? rawSrc.slice(0, 96) + `… (${rawSrc.length.toLocaleString()} 字符)` : rawSrc;
    fb.append(icon, why, url);
    wrap.appendChild(fb);
  };
  const key = mpImgKey(rawSrc);
  const prev = mpImgLoadState.get(key);
  /* 【闩锁·按 Lead 裁定】只允许"初始尝试 + widget 重建时重试一次" = 最多 2 次；
     超过才直接落定成占位（既不狂请求，也不会因一次瞬时超时把有效 URL 永久判死 —— L190 就是活例）。 */
  const tries = (mpImgTries.get(key) || 0) + 1;
  if (key !== null) mpImgTries.set(key, tries);
  if (prev && prev !== "ok" && tries > 2) { wrap.classList.add("is-failed"); wrap.setAttribute("data-mp-img-state", prev); }
  const remember = state => { if (key !== null && assetEpoch === mpImgPreviewEpoch) mpImgLoadState.set(key, state); };
  const load = () => { if (assetEpoch !== mpImgPreviewEpoch) return; if (lease && !lease.valid()) return; remember("ok"); settle("ok"); };
  const error = () => { if (assetEpoch !== mpImgPreviewEpoch) return; if (lease && !lease.valid()) return; remember("loading-failed"); settle("loading-failed", previous ? '图片加载失败，保留上一预览' : "图片加载失败"); };
  img.addEventListener("load", load);
  img.addEventListener("error", error);
  const cleanup = () => { done = true; clearTimeout(timer); img.removeEventListener('load', load); img.removeEventListener('error', error); };
  lease?.cleanup(cleanup);
  timer = setTimeout(() => { if (assetEpoch !== mpImgPreviewEpoch) return; if (lease && !lease.valid()) return; remember("timeout"); settle("timeout", "加载超时（10s）"); }, MP_IMG_TIMEOUT_MS);
  /* ⚠️ 不许用"同步读 img.complete"判失败：刚赋 src 时它可能已是 true 而 naturalWidth 仍为 0，
     会把**已缓存/正在加载**的图误标成失败；settle() 又是"首次落定即终局"，真正的 load 会被丢弃。
     实测后果：真 dev 引擎里图已 599×241 出图，却被 is-failed 的占位盖住（比原缺陷更糟）。
     ⇒ 只有 complete && naturalWidth>0 才算成功；其余一律交给 load/error/超时 三个事件。 */
  if (assetEpoch === mpImgPreviewEpoch) {
    if (img.complete && img.naturalWidth > 0) { remember("ok"); settle("ok"); }
    else wrap.classList.add("is-loading");
  }                    // 加载中也要可见（最小高度由 CSS 给）
  return cleanup;
}

const mpImgNodeEpoch = new WeakMap();

class ImageWidget extends WidgetType {
  constructor(src, alt, title, width, height, align, region = null, retained = false) {
    super();
    this.src = src; this.alt = alt || ""; this.title = title || "";
    this.width = width || ""; this.height = height || "";
    this.align = align || "";                    // left / center / right（来自 data-typora-align，见 scanImageMarks）
    this.resolvedSrc = mpImgSrc(src);
    this.region = region; this.retained = retained;
    this.assetEpoch = mpImgPreviewEpoch;
  }
  eq(o) {
    return o.src === this.src && o.resolvedSrc === this.resolvedSrc && o.alt === this.alt && o.title === this.title
      && o.width === this.width && o.height === this.height && o.align === this.align && o.retained === this.retained
      && o.region?.id === this.region?.id && o.region?.from === this.region?.from && o.region?.to === this.region?.to
      && o.region?.revision === this.region?.revision && o.region?.contextVersion === this.region?.contextVersion
      && o.assetEpoch === this.assetEpoch;
  }
  toDOM(inputView) {
    const wrap = document.createElement(this.retained ? 'div' : "span");
    this.updateDOM(wrap, inputView);
    return wrap;
  }
  updateDOM(wrap, inputView) {
    // Restored EditorState may reuse an older Widget object. Each new DOM mount
    // belongs to the current resource generation; callbacks capture this value.
    const assetEpoch = mpImgPreviewEpoch;
    wrap.className = "mp-img" + (this.align ? " is-" + this.align : "") + (this.retained ? ' mp-img-retained' : '');
    const region = this.region && inputView.state.field(regionIndexField).byId.get(this.region.id);
    if (region) {
      wrap.dataset.mpRegion = region.id;
      bindContainer(wrap, region.context, this.retained);
    }
    const lease = region ? rendererLifecycle.mount(inputView, region, wrap) : null;
    const previous = wrap.querySelector('img:not(.mp-img-pending)');
    wrap.querySelector('.mp-img-pending')?.remove();
    const reused = region && rendererLifecycle.image(inputView, region.id, this.resolvedSrc);
    const previousEpochOk = !!previous && previous.src === this.resolvedSrc && mpImgNodeEpoch.get(previous) === assetEpoch;
    const reusedEpochOk = !!reused && mpImgNodeEpoch.get(reused) === assetEpoch;
    let img = previousEpochOk ? previous : reusedEpochOk ? reused : document.createElement("img");
    mpImgNodeEpoch.set(img, assetEpoch);
    const retaining = previous && img !== previous && previous.complete && previous.naturalWidth > 0 ? previous : null;
    if (retaining) img.classList.add('mp-img-pending');
    img.alt = this.alt;
    img.title = this.title;
    if (this.width) img.setAttribute("width", this.width); else img.removeAttribute('width');
    if (this.height) img.setAttribute("height", this.height); else img.removeAttribute('height');
    img.decoding = "async";
    // Pending replacements sit outside the viewport while the previous preview
    // remains visible. Load them immediately; initial remote images stay lazy.
    const resolvedSrc = this.resolvedSrc;
    img.loading = (retaining || /^(?:data|file|blob):/i.test(resolvedSrc)) ? "eager" : "lazy";
    /* ⚠️ 远程图必须**不带 Referer**：本应用渲染进程是 file:// 页面，跨源取图默认带 `Referer: file:///`，
       而用户图床（华为云 WAF）**对带该 Referer 的请求直接 403**（实测：同一 URL 不带 Referer 是 200 + 34118 B webp，
       带上就 403 / 0 B）。本地 data: / 相对路径图不吃这条，保持原样。 */
    img.referrerPolicy = /^https?:/i.test(resolvedSrc) ? "no-referrer" : '';
    if (img.src !== resolvedSrc) img.src = resolvedSrc;
    if (img.parentNode !== wrap) wrap.appendChild(img);
    /* 【task-12 失败必可见】见 mpImgFailGuard：绝不允许"源码被遮住 + 图没出来"的空白态。 */
    mpImgFailGuard(wrap, img, this.src, lease, () => {
      if (region && assetEpoch === mpImgPreviewEpoch) rendererLifecycle.rememberImage(inputView, region.id, resolvedSrc, img);
      inputView.requestMeasure();
    }, retaining, assetEpoch);
    return true;
  }
  destroy(dom) { rendererLifecycle.release(dom); }
  ignoreEvent() { return false; }
}

/** 从 <img …> 标签里取属性：**单趟扫描**（一次遍历取全部需要的属性名）。
 *  · 属性名必须有**边界**（前一个字符是空白或 "<img"）：否则 `data-src="lazy.png"` 里的 `src=` 会先命中
 *    —— 实测坑，`data-src` 是常见懒加载写法，且在真 `src` 之前；
 *  · 引号感知：`<img alt="a>b" src=x>` 里的 `>` 不会提前截断标签；双引号/单引号/裸值都认；
 *  · 单趟是为了**每键成本**：改前 src/alt/title/width/height 各跑一遍正则 ⇒ 对 90 万字符的标签
 *    等于每键扫 6 遍；现在 1 遍。
 *  返回 { src, alt, title, width, height }（缺失为 undefined）。 */
/** 【task-12 真根因·2026-10-08】HTML 字符引用解码（**只解一层**）。
 *  为什么需要：Typora 的 HTML 属性里 & 写成实体 &amp;；而我们的路径是 img.src = mpImgSrc(属性原文) ——
 *  **JS 赋值绕过 HTML 解析器** ⇒ 实体原样上线 ⇒ 图床收到 …&state=SIG&amp;ty=p（参数名被污染成 amp;ty）⇒ 403 / 空白。
 *  实测 A/B（只差这一个变量）：&amp; 版 403 + 空白；裸 & 版 200 + 真图 815×509。
 *  口径：**只解一层**（&amp;amp; 只变 &amp;）；白名单命名实体 + 数字引用；非法码点给 U+FFFD，**不抛**；
 *  非白名单命名实体（如 &notanentity;）**原样保留**（不许猜）。
 *  只用在**裸 <img> 分支**；markdown 的 ![]() 是文档源码语义，**不解析**。 */
const MP_ENTITIES = { amp: 38, lt: 60, gt: 62, quot: 34, apos: 39, nbsp: 160 };
function mpHtmlUnescape(s) {
  const str = String(s);
  /* 【2026-10-09·按行成本】没有 `&` 就没有任何实体可解（正则不可能命中）⇒ 先做一次原生 `indexOf`
     直接返回。实测夹具里 23 行"单行内联大图"的 src 各 5~90 万字符且**不含 `&`**，
     改前每次都要把整条 base64 送进 replace 的匹配器。 */
  if (str.indexOf("&") < 0) return str;
  return str.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, body) => {
    if (body.charAt(0) === "#") {
      const cp = (body.charAt(1) === "x" || body.charAt(1) === "X") ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return "\uFFFD";
      try { return String.fromCodePoint(cp); } catch (e) { return "\uFFFD"; }
    }
    const v = MP_ENTITIES[body];
    if (v === undefined) return m;
    try { return String.fromCodePoint(v); } catch (e) { return "\uFFFD"; }
  });
}
function imgAttrs(tag) {
  const out = {};
  const n = tag.length;
  let i = tag[0] === "<" ? 4 : 0;          // 跳过 "<img"
  while (i < n) {
    while (i < n && (tag[i] === " " || tag[i] === "\t" || tag[i] === "\n" || tag[i] === "\r" || tag[i] === "/")) i++;
    if (i >= n || tag[i] === ">") break;
    const start = i;
    while (i < n && !" \t\n\r=/>".includes(tag[i])) i++;
    const name = tag.slice(start, i).toLowerCase();
    while (i < n && " \t\n\r".includes(tag[i])) i++;
    let val = "", valueFrom = i, valueTo = i;
    if (tag[i] === "=") {
      i++;
      while (i < n && " \t\n\r".includes(tag[i])) i++;
      const q = tag[i];
      if (q === '"' || q === "'") {
        i++;
        valueFrom = i;
        const end = tag.indexOf(q, i);
        valueTo = end < 0 ? n : end;
        val = end < 0 ? tag.slice(i) : tag.slice(i, end);
        i = end < 0 ? n : end + 1;
      } else {
        const vs = i;
        valueFrom = vs;
        while (i < n && !" \t\n\r>".includes(tag[i])) i++;
        valueTo = i;
        val = tag.slice(vs, i);
      }
    }
    /* 【task-12】属性值要按 HTML 字符引用解码：Typora 写 &amp;，而 JS 赋值绕过 HTML 解析器 ⇒ 不解码就会把
       &amp;ty=p 原样发给图床（参数名被污染成 amp;ty）⇒ 403。只解这一处（裸 <img> 分支）。 */
    if ((name === "src" || name === "alt" || name === "title" || name === "width" || name === "height") && out[name] === undefined) {
      out[name] = mpHtmlUnescape(val);
      if (name === 'src') out.payload = [valueFrom, valueTo];
      if (name === 'alt') out.editFrom = valueFrom;
    }
  }
  return out;
}

/** 扫一行里的图片：裸 <img …> 与 ![](url)（含 <url> 与可选 title）。
 *  · 标签用**引号感知**的单趟扫描（改前用 /<img\b[^>]*>/ 正则会忽略引号里的 `>`）；
 *  · markdown 的 URL 支持**配平括号**（改前 `[^)\s]+` 会把 `https://x/y(1).png` 截成 `https://x/y(1`）；
 *  · 命中即 take(a,b)，后面的链接扫描不会把 "](…)" 再隐藏一遍。 */
function scanImageMarks(line, content, free, take, qoff = 0) {
  const out = [];
  /* 【引用区坐标·2026-10-09 修】`content` = **去掉引用前缀后的行内容**（`> ` 之后那部分）。
     改前这里拿 `line.text`（整行、含前缀）扫，而 `base` 已经加了 `qoff` ⇒ 前缀长度被**重复计算一次**
     ⇒ 图片 mark 的区间整体右移 `qoff` 字节：引用行里写 `![图](地址)` 时，行首那两个字符（`![`）留在屏幕上、
     行尾又多吃掉 `qoff` 个字符（实测：彩排 1.14 / 4.8 的"行内残留字面图片源码"即此）。
     `free`/`take` 与同函数里的正则扫描器一律按 `content` 的相对下标工作，所以这里必须传 `content` 才同源。 */
  const t = content;
  const base = line.from + qoff;
  const add = (a, b, src, alt, title, w, h, payload, form, editOffset = null) => {
    if (!src) return;
    out.push({ from: base + a, to: base + b, hides: [], form, payload: payload ? payload.map(p => base + p) : null,
      editFrom: base + (editOffset ?? a + (form === 'markdown' ? 2 : 4)),
      image: { src, alt: alt || "", title: title || "", width: w || "", height: h || "" } });
    take(a, b);
  };
  /* ① 裸 <img …>：手工扫描，尊重引号（标签内出现 > 不算结束） */
  if (t.indexOf("<img") >= 0 || t.indexOf("<IMG") >= 0) {
    let i = 0;
    for (;;) {
      const lt = t.indexOf("<", i);
      if (lt < 0) break;
      if (!/^<img[\s/>]/i.test(t.slice(lt, lt + 5))) { i = lt + 1; continue; }
      let j = lt + 4, quote = 0, gt = -1;
      /* 【2026-10-09·按行成本】改前是逐字符 for 循环：这份实测夹具里有 23 行"单行内联大图"
         （每行 5~90 万字符），光是"找标签的 `>`"就要走完整条 base64 ⇒ 每键白跑上千万次字符比较
         （实测 `scanInlineMarks` 54ms/键，占四个扫描器总和的 93%）。
         现在**遇到引号就用原生 `indexOf` 跳到收尾引号**——语义与原循环等价（引号内的 `>` 不算结束、
         未闭合引号则扫到行尾 ⇒ `gt = -1`），但把 O(值长度) 的 JS 循环换成 O(属性个数) + 原生扫描。 */
      while (j < t.length) {
        const ch = t[j];
        if (quote) {
          /* 【对抗复核抓到的不等价·2026-10-09】`j` 此时指向**值里的当前字符**；当值是**空串**
             （`<img src="" alt="">`）或闭引号紧邻另一个引号时，闭引号就在 `j` 本身，
             直接 `indexOf(quote, j + 1)` 会**跳过它** ⇒ 引号态奇偶错位 ⇒ 一路"未闭合"到行尾、
             `gt = -1` ⇒ 图片整张不渲染（显示字面 HTML），同行后面的 `<img>` 也一起丢。
             所以**先自检紧邻闭引号**，再走跳步。 */
          if (ch === quote) { quote = 0; j++; continue; }
          const e = t.indexOf(quote, j + 1);
          if (e < 0) { j = t.length; break; }
          j = e + 1; quote = 0; continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; j++; continue; }
        if (ch === ">") { gt = j; break; }
        j++;
      }
      if (gt < 0) break;
      const a = lt, b = gt + 1;
      i = b;
      if (!free(a, b)) continue;
      const at = imgAttrs(t.slice(a, b));
      add(a, b, at.src, at.alt, at.title, at.width, at.height, at.payload?.map(p => a + p), 'html',
        a + (at.editFrom ?? at.payload?.[0] ?? 4));
      /* 【对齐·2026-10-10 对标 2.x】2.x 用 <img … data-typora-align="center"> 表达图片对齐，
         渲染交给 CSS。改前本引擎**忽略**这个属性（对齐写了也不生效），这里把它读进 mark。 */
      {
        const am = /data-typora-align\s*=\s*["']?(left|center|right)/i.exec(t.slice(a, b));
        if (am && out.length) {
          const last = out[out.length - 1];
          if (last && last.image && last.to === base + b) last.image.align = am[1].toLowerCase();
        }
      }
    }
  }
  /* ② ![](url)：]( 之后找**深度为 0 的 )**，URL 里的配平括号不算结束 */
  if (t.indexOf("![") >= 0) {
    let i = 0;
    for (;;) {
      const bang = t.indexOf("![", i);
      if (bang < 0) break;
      const close = t.indexOf("]", bang + 2);
      if (close < 0) break;
      if (t[close + 1] !== "(") { i = bang + 2; continue; }
      let j = close + 2, depth = 0, end = -1;
      /* 【2026-10-09·按行成本】同上一处：改前逐字符走完整条 URL（实测夹具里有 4 行 `![image](data:…)`
         各 20~52 万字符）。用一条 `[\\()]` 原生正则**只跳到"有意思的字符"**上：
         `\` 跳过下一字符（原语义 `j += 2`）、`(` 加深、`)` 在深度 0 时收尾。 */
      const __URLJUMP = /[\\()]/g;
      __URLJUMP.lastIndex = j;
      for (;;) {
        const m = __URLJUMP.exec(t);
        if (!m) break;
        const ch = m[0];
        if (ch === "\\") { __URLJUMP.lastIndex = m.index + 2; continue; }
        if (ch === "(") { depth++; continue; }
        if (depth === 0) { end = m.index; break; }
        depth--;
      }
      j = end < 0 ? t.length : end;
      if (end < 0) break;
      const a = bang, b = end + 1;
      i = b;
      const literal = t.slice(close + 2, end);
      const leading = literal.length - literal.trimStart().length;
      let raw = literal.trim();
      let title = "";
      const tm = /^(<[^>]*>|\S+)\s+["']([^"']*)["']\s*$/.exec(raw);
      if (tm) { raw = tm[1]; title = tm[2]; }
      /* 【2026-10-09·与裸 <img> 路径对齐】markdown 路径的地址也要过 `mpHtmlUnescape`：
         改前只有裸 `<img>` 属性解码字符引用 ⇒ Typora/HTML 来源写出的 `![图](a&amp;b.png)`
         会带着 `&amp;` 去打真实地址（远程图 403/404）。无 `&` 时该函数已早退，零成本。 */
      const angled = raw.startsWith("<") && raw.endsWith(">");
      const payloadFrom = close + 2 + leading + (angled ? 1 : 0);
      const payloadTo = close + 2 + leading + raw.length - (angled ? 1 : 0);
      const src = mpHtmlUnescape(angled ? raw.slice(1, -1) : raw);
      if (!free(a, b)) continue;
      add(a, b, src, t.slice(bang + 2, close), title, "", "", [payloadFrom, payloadTo], 'markdown');
    }
  }
  return out;
}
function scanInlineMarks(doc, mathSpans, blocks = scanFencedBlocks(doc)) {
  const marks = []; // { from, to, hides: [[a,b],...], bullet? } wrapper 与隐藏件
  const overlapsMath = (a, b) => rangesTouching(mathSpans, a, b).some(s => a < s.to && b > s.from);
  let cmtFrom = -1;        // 【HTML 注释】未闭合注释的**绝对起点**（-1＝不在注释里）
  let olCtx = null;        // 【有序列表】当前列表的计数上下文 { key, n }（key = 引用前缀+缩进+分隔符）
  let from = 0;
  for (const t of doc.iterLines()) {
    const line = { from, to: from + t.length, text: t };
    from += t.length + 1;
    /* 【引用区前缀·唯一判据】所有"行首"假定一律先过 `tableLead()`（= tables.js 里那条唯一前缀正则，
     *  与表格 widget/命令/导出三处同源）。`qoff` ＝ 引用前缀（`>`、`> `、`> > `、`>\t` 等）的长度，
     *  `c` ＝ **去掉前缀后的内容**。改前这里全部直接拿 `t` 做行首判据 ⇒ 四类形态在引用区里全被前缀挡掉：
     *   · 无序列表圆点 `/^([ \t]*)([-*+])([ \t]+)(?=\S)/` 被 `>` 挡住 ⇒ 引用区里不画 •；
     *   · 围栏 ` ``` `/`~~~` 同样被挡住 ⇒ 引用区代码块不成块；
     *   · 尖括号自动链接没有 autolink 分支 ⇒ `<https://x>` 原样显示尖括号；
     *   · HTML 注释在编辑面没有概念 ⇒ `<!-- … -->` 字面显示。 */
    const code = blockAt(blocks, line.from);
    const lead = code ? codeBody(t,code) : tableLead(t);
    const qoff = lead.off;
    const c = qoff ? t.slice(qoff) : t;
    /* 【引用前缀先隐藏·2026-10-08】这一步必须在围栏判断**之前**做：
       否则 `inFence) continue` 会把引用区代码块行整个跳过 ⇒ 那些行的 `> ` 留在屏幕上
       （实测：`> ```js ` 已经成块、但每行都还挂着字面 `> `）。 */
    if (qoff) {
      marks.push({ from: line.from, to: line.from + qoff, qmark: true, hides: [[line.from, line.from + qoff]] });
    }
    if (code) { cmtFrom = -1; olCtx = null; continue; }
    /* 【HTML 注释】`<!-- … -->`：编辑面隐藏，光标进入该行显源码（沿用 F7 规则：含选区的行由派生层放开）。
     *  跨行：**一条连续区间**从头盖到尾（改前逐行各标一段 `<!--` / `-->`，中间那几行照样露在屏幕上
     *  —— 用户看到的"注释只在首尾消失、正文还在"就是这个形态）。 */
    const cIdx = c.indexOf("<!--");
    let cEnd = -1, cFromOff = -1, closesMulti = -1;
    if (cmtFrom >= 0) {                                        // 续上一行的未闭合注释
      const e = c.indexOf("-->");
      if (e >= 0) { closesMulti = cmtFrom; cEnd = line.from + qoff + e + 3; cmtFrom = -1; }
    } else if (cIdx >= 0) {
      const e = c.indexOf("-->", cIdx + 4);
      if (e >= 0) { cEnd = line.from + qoff + e + 3; cFromOff = line.from + qoff + cIdx; }
      else { cmtFrom = line.from + qoff + cIdx; cEnd = line.to; }   // 未闭合 ⇒ 先吃掉本行
    }
    if (closesMulti >= 0) {                                    // 跨行注释的收尾行：整段盖到 `-->` 末
      if (cEnd > closesMulti) marks.push({ from: closesMulti, to: cEnd, comment: true, hides: [[closesMulti, cEnd]] });
      if (cEnd >= line.from + qoff + c.length) continue;       // 收尾即行尾 ⇒ 本行没别的了
    } else if (cFromOff >= 0 && cEnd > cFromOff) {             // 单行完整注释
      marks.push({ from: cFromOff, to: cEnd, comment: true, hides: [[cFromOff, cEnd]] });
      if (cEnd >= line.from + qoff + c.length) continue;
    } else if (cmtFrom >= 0) {                                 // 跨行注释：本行从注释起点盖到行尾
      marks.push({ from: cmtFrom, to: line.to, comment: true, hides: [[cmtFrom, line.to]] });
      continue;
    }
    // 无序列表标记：- / * / + ＋空格 → 阅读态换 • 圆点（光标入行显源码，同 F7 规则）
    // 【引用区】判据对象换成 `c`（去前缀后的内容），`base` 把索引加回前缀长度。
    const base = line.from + qoff;
    const lm = /^([ \t]*)([-*+])([ \t]+)(?=\S)/.exec(c);
    if (lm && !overlapsMath(base, base + lm[0].length)) {
      const a = lm[1].length;
      marks.push({ from: base + a, to: base + lm[0].length, bullet: true, hides: [] });
      olCtx = null;                                   // 列表类型切换 ⇒ 有序计数重新起算
    }
    /* 【有序列表】`1.` / `3)`：显示**序号本身**（Typora/CommonMark 口径），不是圆点。
     *  改前这里也发 `bullet: true` ⇒ 有序项被画成 `•`（Lead 用 Typora 同屏对照实锤）。
     *  序号规则按 **CommonMark**：计数从**列表首项声明的数字**起步（`3. c` 起首就是 `3.`），
     *  其后**逐项 +1**（`1. a / 3. b` ⇒ `1. / 2.`，不是 `1. / 3.`）；空行或非列表行打断列表。
     *  与 Typora 实测一致（同一夹具：引用区 `> 1./> 2./> 3.` 渲染成 `1./2./3.`）。 */
    const ol = /^([ \t]*)(\d{1,9})([.)])([ \t]+)(?=\S)/.exec(c);
    const olKey = ol ? (qoff + "|" + ol[1].length + "|" + ol[3]) : null;
    if (ol && !overlapsMath(base, base + ol[0].length)) {
      /* 【空行断列表】CommonMark：空行结束列表 ⇒ 计数必须**重新起算**。
         改前只有"非列表行"才清 `olCtx`，于是两段列表（中间隔一个空行）会被当成同一段继续加下去
         （实测：第二段 `1. 从 1 开始` 被显示成 `5.`）。 */
      if (olCtx && olCtx.broke) olCtx = null;
      if (!olCtx || olCtx.key !== olKey) olCtx = { key: olKey, n: parseInt(ol[2], 10) || 1 };
      marks.push({ from: base + ol[1].length, to: base + ol[0].length, ordered: olCtx.n, hides: [] });
      olCtx.n += 1;
      olCtx.broke = false;
    } else if (!ol && !lm) {
      if (c.trim() === "") { if (olCtx) olCtx.broke = true; }   // 空行：标记"下次要重起"
      else olCtx = null;                                        // 别的行：直接结束
    }
    /* 引用记号（`> `、`> > ` 等）的隐藏已经**上移到围栏判断之前**统一做（见本函数开头），
       这样围栏行与普通行走同一条路径，不会因为 `inFence) continue` 被漏掉。 */
    /* 【长行护栏】本机复现的 8.13MB 文档有 20 行 5~90 万字符：逐字符转义循环＋行内标记正则
       在那种行上等于每键扫 850 万字符。图片扫描（上面已跑完）不受影响。 */
    const huge = t.length > 20000;
    // 【A2-P0①补全】转义序列的「\」本身阅读态隐藏（vditor 语义：\* 显示为 *）
    for (let k = 1; !huge && k < t.length; k++) {
      if (t[k - 1] === "\\" && "*~`[]()#_$".includes(t[k]) && !overlapsMath(line.from + k - 1, line.from + k)) {
        marks.push({ from: line.from + k - 1, to: line.from + k, hides: [[line.from + k - 1, line.from + k]] });
      }
    }
    const consumed = []; // 已占用区间（防止 bold/em/链接互相啃）
    const pureFormats = new Set(); // parallel pure-format record identities only
    // 【A2-P0①】转义禁区：\X（X∈标记字符）不是标记——\*text\* 必须显示 *text*
    /* 【2026-10-09·按行成本】先做一次整行**原生** `indexOf("\\")`：整个函数里 `escapedAt` 会被
       每个候选调用一次，改前每次都要逐字符扫它自己的 [a,b) 区间（大图行上合计上千万次）。
       一行里没有反斜杠时**语义上必然返回 false** ⇒ 这一次原生扫描就是全部成本。 */
    const __hasEsc = c.indexOf("\\") >= 0;
    const escapedAt = (a, b) => {
      if (!__hasEsc) return false;
      /* 【`<` 与 `>` 也要算标记字符·2026-10-11】改前集合是 "*~`[]()#" ✗，**不含尖括号** ✗
         ⇒ 写 `\<u>x</u>` 时 `escapedAt` 恒 false ✗ ⇒ 转义的那对标签照样被投影成下划线 ✗
         （实测验收 U7：屏幕上 `\不该有下划线` 带了下划线、`<u>`/`</u>` 被吃掉 ✗，
         而 Typora/CommonMark 的口径是"**反斜杠转义 ⇒ 这一对按字面**" ✓）。 */
      for (let k = a; k < b; k++) if (t[k - 1] === "\\" && "*~`[]()#<>".includes(t[k])) return true;
      return false;
    };
    /* 【5.8·嵌套强调·2026-10-09】重叠只在**严格内含**时放行 —— 但**只对强调类**（粗体/斜体/三连星）：
       外层 `**…**` 是包裹件（只替换两侧定界符），它里面的 `*斜体*` 必须还能被扫到；
       若把这条放给**链接/行内代码**，链接扫描就会钻进行内代码把 `[` 与 `](…)` 隐掉
       （实测：`![行内码图](data:…)` 被吃成 `!行内码图`，把清单 1.17 打红）。
       ⇒ `nest` 由调用点显式声明，默认 false（严格）。 */
    const free = (a, b, nest) =>
      !consumed.some(([x, y]) => a < y && b > x && !(nest && a > x && b < y))
      && !overlapsMath(base + a, base + b) && !escapedAt(a, b);
    const take = (a, b) => { const record = [a, b]; consumed.push(record); return record; };
    /* 【图片】两条写法都替换成真图。**传 `c` 而不是 `line`**：`scanImageMarks` 内部 `base` 已含 `qoff`，
       它自己再拿整行扫就会把前缀算两遍（见该函数注释）——`free`/`take` 也按 `c` 的相对下标工作。 */
    /* 【1.17·行内代码优先】行内代码里的图片写法必须保持**字面**（Typora 口径：代码里一律原文）。
       图片扫描在本函数里**先跑**，此刻行内代码还没被扫描 ⇒ 必须在图片扫描的 free 里**额外排除行内代码区间**，
       否则写在反引号里的 `![x](y)` 会变成真图（清单 1.17 就是这么红的）。
       注意用**独立的 codeSpans**、不调 take()：take 会把它算作已占用，后面真正的行内代码扫描就再也吃不到它了。 */
    const codeSpans = inlineCodeRanges(c);
    const inCodeSpan = (a, b) => codeSpans.some(([x, y]) => a < y && b > x);
    for (const mk of scanImageMarks(line, c, (a, b) => !inCodeSpan(a, b) && free(a, b), take, qoff)) marks.push(mk);
    const push = (a, b, hides) => marks.push({
      from: base + a, to: base + b,
      hides: hides.map(([x, y]) => [base + x, base + y]),
    });
    // 逐类扫描：拒绝（占用/数学重叠）时 lastIndex 只进 1——matchAll 的整段推进
    // 会吞掉后续配对的定界符（实测 *楷体* 的开星被前一个被拒匹配吃掉、永不隐藏）。
    // 【2026-10-07 修·判据对象错位】冲突只按**真正会被替换的定界符区间**判定：
    // 包裹件本身不替换内容（只 replace 两侧定界符），所以"**加粗里裹着行内公式**"不是冲突。
    // 旧判据拿整个 [a,b] 去测数学重叠 ⇒ `称为 $X$ **诱导的 $\sigma$-域（$\sigma$-field …）**。`
    // 这种最常见写法整对被拒 ⇒ 星号原样露出（实测：正文行 127）。
    const scan = (re, width, hideTail, nest, openLen, closeLen, pureFormat) => {
      if (huge) return;   // 【长行护栏】巨行只做图片扫描
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(c))) {
        const [a, b] = [m.index, m.index + m[0].length];
        /* 【开/闭标记长度可以不等·2026-10-11 实测缺陷】原实现只有**一个** `width` ✗ ——
           对 `**`/`~~`/`__`（开闭都是 2）够用 ✓，但 `<u>…</u>` 是 **3 与 4** ✗
           ⇒ 开标签只隐掉前 2 个字符（`<u` ✓、`>` 留在屏幕上 ✗）、收标签只隐掉末 2 个（`u>` ✓、`</` 留着 ✗）。
           实测屏幕文本：`'甲词2020<'` + 游离 `'u'`(8.05px) + `'>年5月1号是</'` + 游离 `'u'` + `'>周几（周五）'`
           —— 这正是用户看到"下划线没渲染、只多出两个 u"的原因 ✓（本轮就此定案 ✓）。
           ⇒ 允许分开给 openLen / closeLen ✓（不传则退回 width ✓，既有调用一行都不用改 ✓）。 */
        const oL = openLen || width, cL = closeLen || width;
        const hides = hideTail
          ? [[a, a + 1], [c.indexOf("]", a), b]]
          : [[a, a + oL], [b - cL, b]];
        if (!hides.every(([x, y]) => x >= 0 && y > x && free(x, y, nest === true))) { re.lastIndex = m.index + 1; continue; }
        push(a, b, hides);
        const record = take(a, b);
        if (pureFormat) pureFormats.add(record);
      }
    };
    scan(/`[^`\n]+`/g, 1);            // 行内代码
    scan(/\*\*\*[^*\n]+\*\*\*/g, 3, false, true, undefined, undefined, 'strong');   // 三连星
    /* 【5.8·嵌套强调】粗体的内容类必须**允许内部单个星**（`**粗体里 *斜体* 缀**`）：
       改前是 `[^*\n]+` ⇒ 整对匹配不上 ⇒ 斜体正则从第二个星起匹配、把**内侧**两个星隐掉，
       结果外面留一对星（实测文本 `*粗体里 斜体 收尾*` 就是这么来的）。
       用 `(?:\*(?!\*)|[^*\n])+`：单个星可入内容，**双星仍然终止**匹配 ⇒ 不会跨段吞并两个独立粗体。 */
    scan(/\*\*(?:\*(?!\*)|[^*\n])+\*\*/g, 2, false, true, undefined, undefined, 'strong');      // strong
    scan(/__[^_\n]+__/g, 2, false, false, undefined, undefined, 'strong');
    scan(/~~[^~\n]+~~/g, 2, false, false, undefined, undefined, 'strike');          // strike
    /* 【下划线 `<u>…</u>`·2026-10-11 用户报障补齐】Typora 口径的下划线存的就是 `<u>…</u>`
       （Ctrl+U ✓，与 2.x 线同口径 ✓）。改前**根本没有这条规则** ✗ ⇒ 快捷键插进去的标签
       **原样显示**在屏幕上 ✗（实测：`行textContent="<u>前向词</u>"`、可见字形 `["u","u"]` ✗
       = 只隐藏了尖括号、字母 u 与斜杠都露着 ✗）。
       放在这里（`~~` 之后、自动链接之前）：与 `<https://…>` 的自动链接规则**形态不同** ✓
       （后者要求 scheme ✓）⇒ 两条不会互相啃 ✓；命中后 `take()` 占位 ⇒ 内层 `*`/`**` 不再被当强调 ✓。
       转义守位（`\<u>x</u>`）走 free() 里的 escapedAt ✓ ⇒ 反斜杠转义的尖括号保持字面 ✓。 */
    /* 【下划线 <u>…</u>·2026-10-11 定案】真因是**开闭标记长度不等**（`<u>` 3、`</u>` 4）✗ ——
       而 `scan()` 原来只有一个 `width` ⇒ 开标签只隐 `<u`、收标签只隐 `u>` ⇒ 屏幕上留下 `>` 与 `</`，
       外加两个被高亮拆出来的游离 `u` 字形 ✗（用户看到的"下划线没渲染"就是这个 ✓）。
       这里用**自带配对的正则**逐段算实际长度 ✓（顺带支持 `<u >` / `</u >` 这类带空格写法 ✓），
       并把**内文区间**记下来 ✓ —— 标签由通用的 hides 隐掉 ✓，内文由 `mp-u` 类加下划线 ✓。 */
    if (!huge) {
      let um;
      /* 【配对的硬约束·2026-10-11 实测事故】第一版正则写成 `/<u(?:\s[^<>\n]*)?>([^<\n]+)<\/u\s*>/`
         ✗ —— 内文那段**不排除 `<`** ✗ ⇒ 一行里没有 `<u>` 时，它会把**另一行**的 `<u>` 当成
         "本行的开标签"、一路吃到本行的 `</u>` ✗ ⇒ 实测**对照行**（压根没有标签）整段被套上下划线 ✓，
         而且出现 span 套 span 的错乱嵌套 ✗。
         ⇒ 两条硬约束：① **不许跨行**（内文与标签里都不含 `\n` ✓）；② **内文不许含 `<`** ✗
         （否则就会"吃"到别处的标签 ✓）。这样"最近的一对 `<u>…</u>`"才唯一 ✓。 */
      const ure = /<u(?:\s[^<>\n]*)?>([^<\n]+?)<\/u\s*>/g;
      while ((um = ure.exec(c))) {
        const a = um.index, b = a + um[0].length;
        /* 【开/闭长度都按**实际标记**算·2026-10-11】开长 = 到第一个 `>` 为止（`<u>` / `<u >` 都吃 ✓）；
           内容长 = 捕获组长度 ✓；收长 = 总长 − 开长 − 内容长 ✓（只减一次 ✗ 见下）。
           【为什么用"算长度"而不是"搜内文"】先前写成 `um[0].indexOf(um[1])` ✗ ——
           内文与标签**重字**时（`<u>u</u>`、`<u>/u/u</u>`）会搜到**开标签里的那个字符** ✗
           ⇒ 内文区间落进标签、hides 与 mark 重叠 ✗（调研臂与我这边的重字形态都指向这一处 ✓）。
           用长度算**与内容无关** ✓，不存在这个歧义 ✓。 */
        const openLen = um[0].indexOf(">") + 1;                  // `<u>` / `<u >` 的实际长度 ✓
        const innerLen = um[1].length;
        /* 【长度算式要"只减一次"·2026-10-11 当场踩到】第一版写成
           `um[0].length - (innerTo - a) - (innerFrom - a)` ✗ —— 把内文长度**减了两次**
           ⇒ 收尾长度算成 2（真值 4）⇒ 只隐掉 `u>`，屏幕上留 `/` 与游离 `u` ✗。
           正解：收尾长度 = 总长 − 开的长度 − 内文长度 ✓。 */
        const closeLen = um[0].length - openLen - innerLen;
        const innerFrom = a + openLen;
        const innerTo = innerFrom + innerLen;
        if (!free(a, innerFrom) || !free(innerTo, b)) { ure.lastIndex = um.index + 1; continue; }
        push(a, b, [[a, a + openLen], [innerTo, innerTo + closeLen]]);
        const mk = marks[marks.length - 1];
        mk.uOnly = true;
        /* 【uInner 必须是绝对坐标·2026-10-11 实测事故】`push()` 会把 `hides` 加上 `base` ✓，
           但 `uInner` 是我**自己挂上去的附加字段** ⇒ `push` 不会管它 ✗ ——
           第一版直接存了**相对行首**的偏移 ✗ ⇒ 装饰层把它当绝对位置用 ✗
           ⇒ 下划线贴到了**别的行**上（实测：两行文档，第 2 行的下划线跑到第 1 行，
           自报区间 `data-mpu="3-10"` 与第 1 行的 `：2020年5` 正好对上 ✓ —— 靠这个自证一眼定案 ✓）。
           ⇒ 统一口径：**引擎里所有位置字段都是文档绝对坐标** ✓。 */
        mk.uInner = [base + innerFrom, base + innerTo];
        const uRecord = take(a, b);
        pureFormats.add(uRecord);
      }
    }
    if (!huge) for (const span of inlineLinkSpans(c)) {
      const blocked = consumed.some((rec) =>
        span.hides.some(([a, b]) => a < rec[1] && b > rec[0]) &&
        !(pureFormats.has(rec) && span.from > rec[0] && span.to < rec[1]));
      const hideBlocked = span.hides.some(([a, b]) =>
        inCodeSpan(a, b) || overlapsMath(base + a, base + b));
      if (blocked || hideBlocked) continue;
      push(span.from, span.to, span.hides);
      take(span.from, span.to);
    }
    /* 【尖括号自动链接 `<https://…>` / `<mailto:…>`】与链接同一观感：**两侧尖括号都隐去**、文字保留。
     *  只认带 scheme 的（`https:`/`http:`/`mailto:`/`ftp:`…）⇒ `<不是链接>` 保持字面。
     *  行内代码里的 `<https://x>` 不受影响：`scan(/`…`/)` 更早跑并 `take()` 占位，这里 `free()` 会拒。
     *  放在最后扫：链接/代码已占位，避免互相啃。 */
    scan(/<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/g, 1);
    scan(/\*[^*\n]+\*/g, 1, false, true);          // 斜体（最后扫：避免啃粗体内部；nest=true 才能落在粗体里）
  }
  return marks;
}
const inlineMarksField = StateField.define({
  create(state) { return scanInlineMarks(state.doc, state.field(mathSpansField).spans, state.field(markdownContext).blocks); },
  update(value, tr) {
    if (!tr.docChanged) return value;
    const context = tr.state.field(markdownContext);
    const plan = tr.state.field(editPlan), map = p => tr.changes.mapPos(p, 1);
    const mapMark = m => ({ ...m, from: map(m.from), to: map(m.to), hides: m.hides.map(([a,b]) => [map(a),map(b)]),
      ...(m.uInner ? { uInner: m.uInner.map(map) } : {}), ...(m.payload ? { payload: m.payload.map(map), editFrom: map(m.editFrom) } : {}) });
    if (!context.rebuilt && plan && !blockAt(context.blocks, plan.after.from) &&
        !/<!--|-->|^\s*(?:\d+[.)]|[-+*])\s/.test(plan.before.text.slice(quoteLead(plan.before.text).off)) &&
        !value.some(m => m.comment && m.from <= plan.before.to && m.to >= plan.before.from) &&
        !rangesTouching(value, plan.before.from, plan.before.to).some(m => m.from < plan.before.from || m.to > plan.before.to)) {
      const from = plan.after.from, to = plan.after.to;
      const localMath = rangesTouching(tr.state.field(mathSpansField).spans, from, to).map(s => a1MapSpan(s, p => p-from));
      const local = scanInlineMarks(Text.of([plan.after.text]), localMath, []);
      return value.filter(m => m.to < plan.before.from || m.from > plan.before.to).map(mapMark)
        .concat(local.map(m => ({ ...m, from: m.from+from, to: m.to+from, hides: m.hides.map(([a,b])=>[a+from,b+from]),
          ...(m.uInner ? { uInner: m.uInner.map(p=>p+from) } : {}), ...(m.payload ? { payload: m.payload.map(p=>p+from), editFrom: m.editFrom+from } : {}) })))
        .sort((a,b)=>a.from-b.from);
    }
    let touched = context.rebuilt || !plan;
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      if (touched) return;
      if (/[`*_~$\\\n\r<>!\[\]()]/.test(tr.startState.doc.sliceString(fromA, toA)) || /[`*_~$\\\n\r<>!\[\]()]/.test(inserted.toString()) ||
          value.some(m => fromA <= m.to && toA >= m.from) ||
          hasImageCandidate(tr.startState.doc.lineAt(fromA).text) || hasImageCandidate(tr.state.doc.lineAt(fromB).text)) touched = true;
    });
    if (touched) return scanInlineMarks(tr.state.doc, tr.state.field(mathSpansField).spans, context.blocks);
    return value.map(mapMark);
  },
});
const regionIndexField = createRegionIndex(state => {
  const base = state.field(imgBaseField), structure = state.field(markdownContext), blocks = structure.blocks;
  const contextReader = createContainerContextReader(state.doc,structure);
  const context = pos => contextReader(pos,blockAt(blocks,pos));
  const rows = state.field(mathSpansField).spans.map(s => ({ kind: 'math', form: s.display ? 'display' : 'inline',
    from: s.from, to: s.to, data: s, content: s.tex, context: context(s.from) }));
  for (const m of state.field(inlineMarksField)) if (m.image) rows.push({ kind: 'image', form: m.form,
    from: m.from, to: m.to, data: m, payload: m.payload, editFrom: m.editFrom,
    content: [m.image.src, m.image.alt, m.image.title, m.image.width, m.image.height, m.image.align],
    context: contextReader(m.from,null,base) });
  const diagrams = new Map(state.field(mermaidBlocksField).map(b => [b.from, b]));
  for (const b of blocks) {
    const diagram = diagrams.get(b.from);
    rows.push({ kind: diagram ? 'mermaid' : 'code', form: b.char,
      from: b.from, to: b.to, data: diagram || b, sourceOwned: !diagram, content: diagram?.src ?? null, context: context(b.from) });
  }
  for (const t of state.field(tableDataField)) rows.push({ kind: 'table', from: t.from, to: t.to,
    data: t, sourceOwned: true, content: null, context: context(t.from) });
  return rows;
}, [imgBaseField]);
const regionSessionField = createRegionSession(regionIndexField);
// Normal editing needs a small end margin. An active image/source session needs
// the viewport-sized margin used by the locked CM6 scrollPastEnd implementation
// so expansion can retain its visual anchor, including in a short document.
const tailSpacePlugin = ViewPlugin.fromClass(class {
  constructor() { this.height = 48; this.attrs = { style: 'padding-bottom: 48px' }; }
  update({ view }) {
    const activeImage = !!view.state.field(regionSessionField).imageId;
    const height = activeImage ? Math.max(48, view.viewState.editorHeight - view.defaultLineHeight - view.documentPadding.top - 0.5) : 48;
    if (height !== this.height) { this.height = height; this.attrs = { style: `padding-bottom: ${height}px` }; }
  }
});
const tailSpace = [tailSpacePlugin, EditorView.contentAttributes.of(view => view.plugin(tailSpacePlugin)?.attrs || null)];
const rendererLifecycle = createRenderLifecycle(regionIndexField);
const viewportIntent = createViewportIntent(regionIndexField, mpZoomOf);

class ImagePayloadWidget extends WidgetType {
  constructor(id, length) { super(); this.id = id; this.length = length; }
  eq(o) { return o.id === this.id && o.length === this.length; }
  toDOM(inputView) {
    const chip = document.createElement('span'); chip.className = 'mp-image-payload';
    chip.textContent = `… ${this.length.toLocaleString()} 字符 · 展开`;
    chip.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const r = inputView.state.field(regionIndexField).byId.get(this.id);
      if (!r?.payload) return;
      viewportIntent.cancel(inputView);
      inputView.dispatch({ effects: expandRegionPayload.of(this.id), selection: { anchor: r.payload[0] + 24 },
        annotations: Transaction.addToHistory.of(false) });
      inputView.focus();
    });
    return chip;
  }
  ignoreEvent() { return false; }
}
function imageSessionDecorations(state) {
  const session = state.field(regionSessionField), region = state.field(regionIndexField).byId.get(session.imageId);
  if (!region) return Decoration.none;
  const m = region.data, im = m.image, out = [Decoration.widget({
    widget: new ImageWidget(im.src, im.alt, im.title, im.width, im.height, im.align, region, true), block: true, side: 1,
  }).range(m.to)];
  if (!session.expanded && m.payload && m.payload[1] - m.payload[0] > 512) {
    const from = m.payload[0] + 24, to = m.payload[1] - 16;
    out.push(Decoration.replace({ widget: new ImagePayloadWidget(region.id, to - from) }).range(from, to));
  }
  return Decoration.set(out, true);
}
const imageSessionField = StateField.define({
  create: imageSessionDecorations,
  update(value, tr) {
    if (!tr.docChanged && tr.startState.field(regionSessionField) === tr.state.field(regionSessionField) &&
        tr.startState.field(regionIndexField) === tr.state.field(regionIndexField) &&
        tr.startState.field(imgPreviewField) === tr.state.field(imgPreviewField)) return value;
    return imageSessionDecorations(tr.state);
  },
  provide: f => EditorView.decorations.from(f),
});
/* 【前沿机制】长 src 的图当**原子区间**：方向键/选区整块跳过，避免把巨串灌回 DOM。
   短 URL 的图不加原子 —— 保留"光标入内即可改地址"的既有手感。 */
const imageAtomicRanges = EditorView.atomicRanges.of((view) => {
  const marks = view.state.field(inlineMarksField, false) || [];
  const rs = [];
  const session = view.state.field(regionSessionField), index = view.state.field(regionIndexField);
  for (const m of marks) if (m.image && m.image.src.length > 512) {
    const r = regionAt(index, m.from, 'image');
    if (r?.id === session.imageId) {
      if (!session.expanded && m.payload && m.payload[1] - m.payload[0] > 512) rs.push(Decoration.replace({}).range(m.payload[0] + 24, m.payload[1] - 16));
    } else rs.push(Decoration.replace({}).range(m.from, m.to));
  }
  return Decoration.set(rs, true);
});
/** 引用标记的零宽占位（见 scanInlineMarks 里的说明）：不显示任何字形，但**在行盒里留一个零宽盒**，
 *  让整段引用被选中时原生高亮仍然是连续的一块。`aria-hidden` 免得读屏念出一串空。 */
class QuoteMarkWidget extends WidgetType {
  constructor(depth) { super(); this.depth = depth; }
  eq(other) { return other.depth === this.depth; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "mp-qmark";
    span.dataset.mpQd = String(this.depth);
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  ignoreEvent() { return true; }
}
const inlineMarkDecorations = EditorView.decorations.compute(["selection", inlineMarksField, tableDataField, imgBaseField, imgPreviewField, regionIndexField, regionSessionField], (state) => {
  const out = [];
  const tables = state.field(tableDataField, false) || [];
  const inTable = (pos) => tables.some((t) => pos >= t.from && pos <= t.to);   // 表格行走块级 widget，行内装饰必须让位
  for (const mark of state.field(inlineMarksField)) {
    const inSel = state.selection.ranges.some((r) => r.from <= mark.to && r.to >= mark.from);
    /* 【图片优先判】先于 "inSel ⇒ 显源码"：data URI 一旦展开就是 90 万字符回灌 DOM，
       前沿线实测那种行"折行"要 50~78ms/键。所以**长 src 的图永远保持 widget**（要改地址走"编辑源码"）。 */
    if (mark.image) {
      const region = regionAt(state.field(regionIndexField), mark.from, 'image');
      if (state.field(regionSessionField).imageId !== region?.id) {
        out.push(Decoration.replace({ widget: new ImageWidget(mark.image.src, mark.image.alt, mark.image.title,
          mark.image.width, mark.image.height, mark.image.align, region) }).range(mark.from, mark.to));
      }
      continue;
    }
    if (mark.qmark) {
      if (inTable(mark.from)) continue;                          // 引用区表格：竖条/缩进由 widget 自己画
      const depth = Math.min(3, Math.max(1, (state.doc.sliceString(mark.from, mark.to).match(/>/g) || []).length));
      out.push(Decoration.replace({ widget: new QuoteMarkWidget(depth) }).range(mark.from, mark.to));
      continue;
    }
    if (inSel) continue; // 光标在包裹段 → 显示源码标记
    /* 【下划线 <u>…</u>·2026-10-11 已按"隐藏区间"落地 ✓】走过的三条路（留档，别再回头）：
       ① `hides` 零宽替换 + **单个 width** ⇒ 开闭标记长度不等（3 与 4）⇒ 屏幕上留 `>` 与 `</`、
          外加两个高亮拆出来的游离 `u` 字形 ✗（**真因**见上面 `scan()` 的 openLen/closeLen 注释 ✓）；
       ② `Decoration.mark` + `attributes` 把标签收成零宽 ⇒ 同样留游离 `u` ✗（属性落不到同一词法单元的其余字符）；
       ③ 正解＝**把 ① 的宽度按实际标记长度分开给** ✓ —— 与 `**`/`~~`/行内代码**完全同形态** ✓（零成本、零新概念 ✓）。
       ⇒ 现在这条规则走的就是通用的 `mark.hides` 分支（文件末尾那条 `for` 循环 ✓），此处**不需要特判** ✓。
       唯一额外的一步：给**内文**加一条 `mp-u` 的 mark ✓（下面的 uOnly 分支 ✓）——
       标签靠 hides 隐掉 ✓，下划线靠这条类 ✓；两者作用在不同字符上 ⇒ **互不干扰** ✓。 */
    if (mark.uOnly && mark.uInner) {
      /* 【类名要用 `attributes`·2026-10-11 实测】`Decoration.mark({ class })` 在这个 bundle 里
         **没把类挂上去** ✗（实测：内文那个文本节点的 parent 仍是 `.cm-line`、没有 `mp-u` 类 ✗），
         而引擎里既有写法是 `Decoration.line({ class: … })` ✓ —— 两者语义其实一致，但保险起见
         改用**与 `mp-math-src`/`mp-hr` 同款**的 `attributes` 形态 ✓（`mark` 装饰支持 attributes ✓）。 */
      /* 【可辨识标记·2026-10-11】除了 `mp-u` 再挂一个 `data-mpu=from-to` ✓ ——
         先前出现"DOM 里有 mp-u 但引擎标记表里没有对应条目"的矛盾 ✗，两处口径打架时
         **必须能一眼分清"这个 span 是谁加的、它自报的区间是多少"** ✓（错-27 的自证思路 ✓）。 */
      out.push(Decoration.mark({ attributes: { class: "mp-u", "data-mpu": mark.uInner[0] + "-" + mark.uInner[1] } }).range(mark.uInner[0], mark.uInner[1]));
      /* 不 continue：继续走到末尾那条 hides 循环 ✓（标签照样隐掉 ✓）。 */
    }
    /* 【HTML 注释】F7 **按"光标进入该行"口径**（与圆点/标题的既有手感一致）：只按"选区是否相交"
       会让附近选中一段文字就令注释跳出来变源码；改成"光标所在行与注释有交集才展开"——
       想改注释时把光标点到那一行即可，平时始终隐藏。 */
    if (mark.comment) {
      const head = state.selection.main.head;
      const hl = state.doc.lineAt(head);
      if (head >= hl.from && head <= hl.to && mark.to >= hl.from && mark.from <= hl.to) continue;
      for (const [a, b] of mark.hides) out.push(Decoration.replace({}).range(a, b));
      continue;
    }
    if (mark.bullet) { out.push(Decoration.replace({ widget: new BulletWidget() }).range(mark.from, mark.to)); continue; }
    /* 【有序列表】序号 widget（Typora 观感：1.  顶替源码里的 1. ——与 • 同一套 F7 规则）。 */
    if (mark.ordered) {
      out.push(Decoration.replace({ widget: new OrderedWidget(mark.ordered) }).range(mark.from, mark.to)); continue;
    }
    for (const [a, b] of mark.hides) out.push(Decoration.replace({}).range(a, b));
  }
  return Decoration.set(out, true);
});

/** 无序列表圆点（Typora 观感：• 顶替 -/+/＊ 记号） */
class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const span = document.createElement("span");
    span.textContent = "• ";
    span.className = "mp-bullet";
    return span;
  }
  ignoreEvent() { return false; }
}

/** 有序列表序号（Typora 观感：`1. ` 顶替源码里的 `1. `）。
 *  与圆点同一套规则：光标进入该行 ⇒ 显源码（F7）；序号由 `scanInlineMarks` 按 CommonMark 算好传进来。 */
class OrderedWidget extends WidgetType {
  constructor(n) { super(); this.n = n; }
  eq(other) { return other.n === this.n; }
  toDOM() {
    const span = document.createElement("span");
    span.textContent = this.n + ". ";
    span.className = "mp-ordered";
    return span;
  }
  ignoreEvent() { return false; }
}

/** 行内/块公式编辑浮动预览（Typora 行为：浮于真文本之上，不占排版流）。
 *  display=true 渲 displayMode 数学。
 *  定位契约（2026-10-06 定稿）：**锚在源码 span 上、摆在源码正下方 6px**——
 *  · 纵向锚点＝span.to 的行盒底（块级＝闭围栏行底、行内＝该行行底）；
 *  · 横向锚点＝span.from 的左缘（块级居中）；
 *  · estHeight=-1 纯浮动层，永不进高度图（零排版挤压）。 */
class InlineFloatWidget extends WidgetType {
  constructor(tex, display = false, from = null, to = null, texFrom = null, region = null) {
    super(); this.tex = tex; this.display = display; this.from = from; this.to = to; this.texFrom = texFrom;
    this.region = region;
  }
  eq(other) { return other.tex === this.tex && other.display === this.display && other.from === this.from && other.to === this.to && other.texFrom === this.texFrom
    && other.region?.id === this.region?.id && other.region?.contextVersion === this.region?.contextVersion; }
  toDOM(view) {
    const box = document.createElement("span");
    box.className = "mp-inline-float" + (this.display ? " mp-inline-float-display" : "");
    if (this.region) { box.dataset.mpRegion = this.region.id; bindContainer(box, this.region.context, false); }
    const lease = this.region ? rendererLifecycle.mount(view,this.region,box) : null;
    if (this.from != null) box.dataset.mpFrom = String(this.from);
    if (this.to != null) box.dataset.mpTo = String(this.to);
    if (this.texFrom != null) box.dataset.mpTexFrom = String(this.texFrom);
    const html = renderMathHTML(this.tex, this.display);
    if (html != null) box.innerHTML = html;
    else box.textContent = this.tex;
    // 【点预渲染框 ⇒ 精确回源码】浮层是渲染体，不是死图：点哪个字形就落到源码里那个
    // token（与点渲染体同一套 K10 五级判定）。此前 pointer-events:none，点击直接穿到
    // 被盖住的下一行——用户实测「点框里的 λ，光标飞到别处、公式塌回渲染态」。
    box.addEventListener("mousedown", (e) => {
      if (lease && !lease.valid()) return;
      // Native scrollbar reading must not dispatch a glyph selection or block
      // Chromium's default scrolling. Stop only CM's bubbling mouse handler.
      if (floatScrollbarHit(box, e)) { e.stopPropagation(); return; }
      if (floatClickToSource(box, view, e)) { e.preventDefault(); e.stopPropagation(); }
    });
    registerFloat(view, box, lease);
    return box;
  }
  get estimatedHeight() { return -1; } // 纯浮动层：不参与高度图
  destroy(dom) { unregisterFloat(dom); rendererLifecycle.release(dom); }
  ignoreEvent() { return false; }
}
/** 浮动预览框内点击 → 源码精确落位（与点渲染体同一套 K10 五级判定）。
 *  tex 与源码映射从 mathSpansField 现取；旧浮层已失去对应 span 时不写选区。
 *  命令口径一致：点 \lambda 落 `\` 与 `l` 之间（mathGlyphOffset 的既有契约）。 */
function floatClickToSource(box, view, event) {
  if (!view) return false;
  const from = Number(box.dataset.mpFrom), to = Number(box.dataset.mpTo);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  const spans = view.state.field(mathSpansField, false)?.spans ?? [];
  const span = spans.find((s) => s.from === from && s.to === to) || null;
  if (!span || !Number.isFinite(span.texFrom)) return false;
  const tex = span.tex;
  const base = span.texFrom;
  let pos = base;
  if (tex) {
    const offset = mathGlyphOffset(box, event, tex);
    if (offset != null) pos = mathSourcePosition(span, offset);
  }
  setMathPointerSelection(view, pos, { shift: event.shiftKey, anchor: view.state.selection.main.anchor });
  return true;
}
function setMathPointerSelection(view, pos, gesture) {
  const anchor = gesture?.shift ? gesture.anchor : pos;
  view.dispatch({ selection: { anchor, head: pos }, userEvent: 'select.pointer' });
  view.focus();
}
function floatScrollbarHit(box, event) {
  const r = box.getBoundingClientRect();
  return horizontalScrollbarHit({
    left: r.left, right: r.right, top: r.top, bottom: r.bottom,
    zoom: mpZoomOf(box), clientTop: box.clientTop,
    clientWidth: box.clientWidth, clientHeight: box.clientHeight,
    scrollWidth: box.scrollWidth,
    borderBottom: parseFloat(getComputedStyle(box).borderBottomWidth) || 0,
  }, event.clientX, event.clientY);
}
const mathPointerGesture = EditorView.domEventObservers({
  mousedown(event, inputView) {
    inputView.__mpMathGesture = { shift: event.shiftKey, anchor: inputView.state.selection.main.anchor };
  },
});

// Floats use their actual offsetParent (quote line or scroller). DOMRects and
// coordsAtPos both report viewport CSS pixels; zoom and parent border/scroll
// are applied only when converting to its local padding-box coordinates.
/** 【task-10】取元素所处的有效缩放。先看**祖先链上的 CSS zoom**（.cm-editor{zoom:var(--mp-zoom)}，
 *  见本文件 .cm-editor 规则），再退回 token --mp-zoom（偏好层会写 root 与 zoomWrap 两处）。
 *  为什么不在元素自己身上读：多数元素没有 zoom 属性，getComputedStyle(el).zoom 会拿到 "normal"。
 *  ⚠️ 全仓**只此一条** zoom 判定路径（表格浮条与浮动公式预览共用），别在别处再写第二套。
 *  取值域：非有限值 / ≤0 / >3 ⇒ 当 1（避免把坐标算成 Infinity）。 */
function mpZoomOf(el, cache = null) {
  const visited = [];
  const resolved = value => {
    if (cache) for (const node of visited) cache.set(node, value);
    return value;
  };
  let n = el;
  while (n && n !== document.documentElement) {
    if (cache?.has(n)) return resolved(cache.get(n));
    if (cache) visited.push(n);
    const z = parseFloat(getComputedStyle(n).zoom);
    if (Number.isFinite(z) && z > 0 && z !== 1) return resolved(z > 3 ? 1 : z);
    n = n.parentElement;
  }
  const t = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--mp-zoom"));
  return resolved((Number.isFinite(t) && t > 0 && t <= 3) ? t : 1);
}
const floatMeasureKey = {};
const floatRegistry = new WeakMap(), floatOwners = new WeakMap(), floatSettlements = new WeakMap();
const floatViews = new Set();
let floatAvoidanceEnabled = !!mpPref('floatAvoidance'), floatLayoutVersion = 0;
function applyFloatPreference() {
  const enabled = !!mpPref('floatAvoidance');
  if (enabled === floatAvoidanceEnabled) return;
  floatAvoidanceEnabled = enabled; floatLayoutVersion++;
  for (const v of floatViews) {
    const pending = floatSettlements.get(v);
    if (pending) cancelAnimationFrame(pending.raf);
    floatSettlements.delete(v);
    for (const entry of floatRegistry.get(v)?.values() || []) entry.phase = 0;
    positionInlineFloats(v);
  }
}
window.addEventListener('storage', event => {
  if (event.key === 'mp-pref-floatAvoidance' || event.key === null) {
    applyFloatPreference(); mpPrefNotify(['floatAvoidance']);
  }
});
/* 【C15·跨窗 pageWidth 直播】D05 冻结政策要求已开窗实时同步：远端窗口写
 * mp-pref-pageWidth 后，本窗经 storage 事件收到同一值。这里只做消费者——
 * 复用既有 applyEnginePrefs()（写 token + 既有 rAF 版心调度，不新增计时器）
 * 与既有 mpPrefNotify(['pageWidth']) 广播；绝不回写 storage（远端事件不会
 * 触发 mpSetPref，本地回写会造成环）；不动 float 监听器与其它任何键。 */
window.addEventListener('storage', event => {
  if (event.key === 'mp-pref-pageWidth' || event.key === null) {
    applyEnginePrefs(); mpPrefNotify(['pageWidth']);
  }
});
function registerFloat(v, box, lease) {
  let entries=floatRegistry.get(v);if(!entries)floatRegistry.set(v,entries=new Map());
  floatViews.add(v);
  entries.set(box,{lease,phase:0});floatOwners.set(box,v);
  positionInlineFloats(v);
}
function unregisterFloat(box) {
  const v=floatOwners.get(box);if(!v)return;
  floatOwners.delete(box);const entries=floatRegistry.get(v);entries?.delete(box);
  if(!entries?.size){floatViews.delete(v);const pending=floatSettlements.get(v);if(pending)cancelAnimationFrame(pending.raf);floatSettlements.delete(v);}
}
function settleFloats(v,epoch,layoutVersion) {
  const previous=floatSettlements.get(v);if(previous?.epoch===epoch&&previous.layoutVersion===layoutVersion)return;
  if(previous)cancelAnimationFrame(previous.raf);
  const task={epoch,layoutVersion,raf:0};floatSettlements.set(v,task);
  // Leave this CM measure cycle so its initial scrollTarget can run. This is a
  // single mount settlement, never a scroll/resize/caret tracking loop.
  task.raf=requestAnimationFrame(()=>{
    if(floatSettlements.get(v)!==task)return;floatSettlements.delete(v);
    // Unrelated edits may reuse this valid pending widget. Read the current
    // document; the per-node lease still rejects obsolete regions and results.
    if(v.state.field(regionIndexField).epoch===epoch&&floatLayoutVersion===layoutVersion)positionInlineFloats(v);
  });
}
function positionInlineFloats(inputView) {
  if (!inputView || !floatRegistry.get(inputView)?.size) return;
  inputView.requestMeasure({
    key: floatMeasureKey,
    read(v) {
      const entries=floatRegistry.get(v),index=v.state.field(regionIndexField),session=v.state.field(regionSessionField);
      const measured = {doc:v.state.doc,epoch:index.epoch,layoutVersion:floatLayoutVersion,rows:[]};
      if(!entries?.size)return measured;
      const sc = v.scrollDOM, content = v.contentDOM;
      const sr = sc.getBoundingClientRect(), cr = content.getBoundingClientRect();
      // The cache lives for this read only, so zoom changes never reuse stale geometry.
      const zoomCache = new Map();
      const sz = mpZoomOf(sc,zoomCache), cz = mpZoomOf(content,zoomCache), cs = getComputedStyle(content);
      const px = (style, key) => parseFloat(style[key]) || 0;
      const columnLeft = Math.max(sr.left + sc.clientLeft * sz + 6,
        cr.left + (content.clientLeft + px(cs, 'paddingLeft')) * cz);
      const columnRight = Math.min(sr.left + (sc.clientLeft + sc.clientWidth) * sz - 6,
        cr.right - (px(cs, 'paddingRight') + px(cs, 'borderRightWidth')) * cz);
      for (const [f,entry] of entries) {
        if(entry.phase>=2||!f.isConnected||!v.dom.contains(f)||entry.lease&&!entry.lease.valid())continue;
        const from = Number(f.dataset.mpFrom), to = Number(f.dataset.mpTo);
        const region=index.byId.get(f.dataset.mpRegion);
        if(!region||region.kind!=='math'||region.from!==from||region.to!==to||!session.presentation.get(region.id)?.preview)continue;
        const parent = f.offsetParent || v.dom, z = mpZoomOf(parent,zoomCache);
        const line = f.closest('.cm-line') || content, lr = line.getBoundingClientRect();
        const ls = getComputedStyle(line), lz = mpZoomOf(line,zoomCache);
        const left = Math.max(columnLeft, lr.left + (line.clientLeft + px(ls, 'paddingLeft')) * lz);
        const right = Math.min(columnRight, lr.right - (px(ls, 'paddingRight') + px(ls, 'borderRightWidth')) * lz);
        if(right<=left)continue;
        const base={f,entry,phase:entry.phase,id:region.id,contextVersion:region.contextVersion,from,to,maxWidth:(right-left)/z};
        if(!entry.phase){measured.rows.push({...base,widthOnly:true});continue;}
        const pr = parent.getBoundingClientRect(), r = f.getBoundingClientRect();
        const naturalWidth = r.width + Math.max(0, f.scrollWidth - f.clientWidth) * z;
        // The preview is a zero-length widget at `to`. Bias toward the source
        // on both boundaries so the widget can never become its own anchor.
        let a,b;try{a=v.coordsAtPos(from,1);b=v.coordsAtPos(to,-1);}catch{}
        const frame = horizontalFrame({left, right, naturalWidth, preferredLeft: a?.left??left,
          center: f.classList.contains('mp-inline-float-display')});
        if(!frame)continue;
        if(!a||!b){measured.rows.push({...base,hidden:true});continue;}
        const naturalHeight = Math.ceil(Math.max(r.height/z,f.scrollHeight+f.offsetHeight-f.clientHeight))*z;
        const bounds={top:Math.max(sr.top,0)+4,bottom:Math.min(sr.bottom,innerHeight)-4},minimumHeight=(parseFloat(getComputedStyle(f).fontSize)||14)*z+6;
        const offscreen=b.bottom<bounds.top||a.top>bounds.bottom;
        const legacyTop=!floatAvoidanceEnabled||offscreen?b.bottom+6:Math.max(bounds.top,Math.min(b.bottom+6,bounds.bottom-minimumHeight));
        let vertical={top:legacyTop,height:naturalHeight,constrained:false,overlay:true};
        if(floatAvoidanceEnabled&&!offscreen){
          const interest={left:frame.left,right:frame.left+frame.width,top:Math.max(bounds.top,legacyTop-PREVIEW_MAX_DISPLACEMENT-2),bottom:Math.min(bounds.bottom,legacyTop+PREVIEW_MAX_DISPLACEMENT+naturalHeight+2)};
          vertical=previewFrame({bounds,legacyTop,anchor:{top:a.top,bottom:b.bottom},left:frame.left,width:frame.width,height:naturalHeight,
            obstacles:[...textObstacles(v,interest),...controlObstacles(v)],minimumHeight});
        }
        const point = vertical && localPoint({left: frame.left, top: vertical.top}, {
          left: pr.left, top: pr.top, zoom: z, clientLeft: parent.clientLeft,
          clientTop: parent.clientTop, scrollLeft: parent.scrollLeft, scrollTop: parent.scrollTop,
        });
        if (point) measured.rows.push({...base,left:point.left,top:point.top,maxHeight:vertical.height/z,constrained:vertical.constrained,overlay:vertical.overlay});
        else measured.rows.push({...base,hidden:true});
      }
      return measured;
    },
    write(measured, v) {
      const index=v.state.field(regionIndexField),entries=floatRegistry.get(v);
      if(v.state.doc!==measured.doc||index.epoch!==measured.epoch||floatLayoutVersion!==measured.layoutVersion)return;
      let settle=false;
      for (const row of measured.rows) {
        const {f, from, to} = row;
        const region=index.byId.get(row.id);
        if(!region||region.contextVersion!==row.contextVersion||!v.state.field(regionSessionField).presentation.get(row.id)?.preview||entries?.get(f)!==row.entry||row.entry.phase!==row.phase||!f.isConnected||!v.dom.contains(f)||row.entry.lease&&!row.entry.lease.valid()||Number(f.dataset.mpFrom)!==from||Number(f.dataset.mpTo)!==to)continue;
        const styles = row.widthOnly ? {maxWidth:row.maxWidth+'px',height:'auto',maxHeight:'none',overflowY:'hidden',visibility:'hidden'} : row.hidden ? {visibility:'hidden'} : {left: row.left + 'px', top: row.top + 'px', maxWidth: row.maxWidth + 'px',boxSizing:'border-box',height:row.maxHeight+'px',maxHeight:'none',overflowY:'hidden', visibility: 'visible', zIndex: '20'};
        f.dataset.mpPlacement = row.widthOnly?'pending':row.hidden?'no-room':row.overlay?'overlay':row.constrained?'constrained':'free';
        for (const [key, value] of Object.entries(styles)) if (f.style[key] !== value) f.style[key] = value;
        row.entry.phase++;settle ||= row.widthOnly;
      }
      if(settle)settleFloats(v,measured.epoch,measured.layoutVersion);
    },
  });
}

/* ══ 行中段 `$$…$$`「收笔即换行」（用户 2026-10-07 裁定）══
 *  场景：正文写着写着突然要一个公式，没敲回车就直接打了 `$$…$$`——希望它自己独占一行成块公式，
 *  而不是挤在句子中间。触发时机（用户口径：出现完整一对 fence 就立刻）＋三道闸：
 *    ① 光标必须**紧跟闭合的 `$$`**（收笔瞬间；之后又打了字就不再触发——自限）；
 *    ② 该行在 `$$` 之前**必须有文字**（行首形态已由既有规则渲染成块，无需换行）；
 *    ③ **保护块内不动**：代码围栏 / 表格行 / 引用块 / 列表项（那些地方换行会改结构语义）。
 *  另：IME 组字态不动；换行是**一次独立事务**（userEvent=input.autobreak），Ctrl+Z 一步还原。
 *  渲染与换行是两件事：即使闸门拦下（例如在引用块里），行内渲染也已经让公式正常显示。 */
const autoBreakMath = ViewPlugin.fromClass(class {
  constructor(v) { this.view = v; this.raf = 0; }
  update(u) {
    if (!u.docChanged) return;
    // 【中文输入安全·2026-10-07】只认"普通键入"这一种用户事件：
    // · 输入法组字期间 CM6 把 DOM 变更作为 `input.type.compose` 事务下发（isUserEvent("input.type")
    //   对它是 **true**——前缀匹配，会误放行）；这里显式排除，组字的每一笔都不触发换行；
    // · 组字态另有 view.composing 闸（见 autoBreakCheck 首行），两道一起兜。
    const plainType = u.transactions.some((tr) => tr.isUserEvent("input.type") && !tr.isUserEvent("input.type.compose"));
    if (!plainType) return;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; autoBreakCheck(this.view); });
  }
  destroy() { if (this.raf) cancelAnimationFrame(this.raf); }
});
function autoBreakCheck(v) {
  if (!v || v.composing) return;
  const st = v.state;
  const sel = st.selection.main;
  if (st.selection.ranges.length !== 1 || !sel.empty || codeBlockAt(st, sel.head)) return;
  const head = sel.head;
  const line = st.doc.lineAt(head);
  const col = head - line.from;
  if (!line.text.slice(0, col).endsWith("$$")) return;          // ① 光标紧跟闭合 $$
  const before = line.text.slice(0, col - 2);
  const open = before.lastIndexOf("$$");
  if (open < 0) return;
  if (!before.slice(open + 2).trim()) return;                    // 空公式不折腾
  if (!before.slice(0, open).trim()) return;                     // ② 行首形态：已是块
  if (/^\s*(```|~~~)/.test(line.text)) return;                   // ③ 保护块
  if (/^\s*([-*+]|\d+[.)])\s/.test(line.text)) return;
  if (!/^\s*\|/.test(line.text) && line.text.includes("|") && /^\s*\|.*\|\s*$/.test(line.text)) return;
  const styles = st.field(lineStylesField, false);
  const tables = st.field(tableDataField, false);
  if (tables && tables.some((t) => line.from >= t.from && line.from <= t.to)) return;
  if (styles && styles.styled.some((s) => s.line.from === line.from && (s.cls === "mp-code" || String(s.cls).startsWith("mp-quote")))) return;
  const fromOpen = line.from + open;
  // 尾随换行只在"闭合 $$ 之后不是行尾"时才插——否则会白送一个空行（原行尾已有换行）。
  const needTail = !(head >= st.doc.length || st.doc.sliceString(head, head + 1) === "\n");
  const changes = [{ from: fromOpen, insert: "\n" }];
  if (needTail) changes.push({ from: head, insert: "\n" });
  v.dispatch({
    changes,
    selection: { anchor: head + (needTail ? 2 : 1) },
    userEvent: "input.autobreak",
    scrollIntoView: true,
  });
}

/* ── 点公式 → 源码落位（竖切门①；K10 五级判定＝2.x math-source-map 口径平移）── */

/** 渲染像素点 → tex 源偏移（五级判定，render 时 sourceMap、绝不事后猜）：
 *  ① 分数线/上下划线命中 → 其映射元素取 before；
 *  ② 最小包含盒的叶子映射字形 → 半格归侧（左半前/右半后）；
 *  ③ direct 叶子（无子元素有文本）含点 → before（容器不给 after：end 是组的右界）；
 *  ④ 盒内缝隙 → 最近叶子字形＋半格归侧（防「点中段跑公式最前」）；
 *  ⑤ 全不中 → null（调用方回退）。
 *  行末口径（2026-09-14 第7轮）：最后一个可见叶子字形整格 after 连右空白带 → 源码末尾，
 *  且压过命令规则。命令口径（第6轮）：tex[start]=='\\' 的 token 左右半都落 start+1
 *  （\ 与命令首字母之间——点 ∑ 落 \ 与 s 之间）。 */
function mathGlyphOffset(holder, event, tex) {
  const LOC = "[data-typora-source-start]";
  const containsPoint = (rect) => rect.width > 0 && rect.height > 0 &&
    event.clientX >= rect.left && event.clientX <= rect.right &&
    event.clientY >= rect.top && event.clientY <= rect.bottom;
  const half = (rect) => event.clientX >= rect.left + rect.width / 2;
  let tail = null; // 行末锚：最后一个可见叶子映射字形（文档序）
  for (const node of holder.querySelectorAll(LOC)) {
    if (node.querySelector(LOC)) continue;
    for (const rect of node.getClientRects()) if (rect.width && rect.height) { tail = node; break; }
  }
  const at = (node, after) => {
    const s = Number(node.getAttribute("data-typora-source-start"));
    const e = Number(node.getAttribute("data-typora-source-end"));
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e <= s || e > tex.length) return null;
    if (node === tail) return e;                      // 行末整格 after（压过命令规则）
    if (tex[s] === "\\" && e > s + 1) return s + 1;   // 命令 token：进 \ 之后
    return after ? e : s;                             // 半格归侧
  };
  for (const rule of holder.querySelectorAll(".frac-line,.overline-line,.underline-line")) {
    if (containsPoint(rule.getBoundingClientRect())) {
      const n = rule.closest(LOC);
      if (n) { const o = at(n, false); if (o != null) return o; }
    }
  }
  let closest = null;
  for (const node of holder.querySelectorAll(LOC)) {
    if (node.querySelector(LOC)) continue;
    for (const rect of node.getClientRects()) {
      if (!rect.width || !rect.height) continue;
      if (containsPoint(rect) && (!closest || rect.width * rect.height < closest.rect.width * closest.rect.height)) closest = { node, rect };
    }
  }
  if (closest) { const o = at(closest.node, half(closest.rect)); if (o != null) return o; }
  const direct = event.target && event.target.closest ? event.target.closest(LOC) : null;
  if (direct && direct.children.length === 0 && (direct.textContent || "").length && containsPoint(direct.getBoundingClientRect())) {
    const o = at(direct, false); if (o != null) return o;
  }
  const box = holder.getBoundingClientRect();
  const insideBox = box.width > 0 && box.height > 0 &&
    event.clientX >= box.left - 1 && event.clientX <= box.right + 1 &&
    event.clientY >= box.top - 1 && event.clientY <= box.bottom + 1;
  if (!insideBox) return null;
  let nearest = null, gap = Infinity;
  for (const node of holder.querySelectorAll(LOC)) {
    if (node.querySelector(LOC)) continue;
    for (const rect of node.getClientRects()) {
      if (!rect.width || !rect.height) continue;
      const dx = event.clientX < rect.left ? rect.left - event.clientX : event.clientX > rect.right ? event.clientX - rect.right : 0;
      const dy = event.clientY < rect.top ? rect.top - event.clientY : event.clientY > rect.bottom ? event.clientY - rect.bottom : 0;
      const d = dx || dy ? Math.hypot(dx, dy) : 0;
      if (d < gap) { gap = d; nearest = { node, rect }; }
    }
  }
  if (nearest) { const o = at(nearest.node, half(nearest.rect)); if (o != null) return o; }
  return null;
}

/* ══ 【B-1·③ 折中】"文档里选中整张表" ⇒ TSV + `<table>` 剪贴板载荷 ══════════════════
 *  `PLAN-3.1.0 §4`：整表选区的 `text/plain` = TSV、`text/html` = `<table>`（与右键菜单
 *  「复制表格（可粘 Excel）」**同一个** `tableClipPayload`）；不含表的选区行为逐字节不变（D8 口岸不变）。
 *  性能：只查 `lineStylesField.tables`（文档变化时已经算好的字段）＋一次 find，**不做任何扫描**。 */
/** 字段里的表 ⇒ 按行按列的格源码（表头 + 数据行；分隔行在 `tables` 字段里本来就不成行）。 */
function tableRowCells(tb) {
  return [tb && tb.headerBlock ? tb.headerBlock.cells : [], ...((tb && tb.rows) || []).map((r) => r.cells)];
}
/** 表记录 ⇒ 剪贴板载荷。构造器只有一份（在 extras.js 的 tableClipPayload）。 */
function tableClipPayloadOf(tb) {
  const api = window.mpExtras;
  if (!tb || !api || typeof api.tableClipPayload !== "function") return null;
  try { return api.tableClipPayload(tableRowCells(tb), tb.aligns); } catch { return null; }
}
/** 【N1】活动格所在的表（字段查询，无扫描）。 */
function tableContaining(state, pos) {
  return tableTablesOf(state).find((t) => pos >= t.from && pos <= t.to) || null;
}
/* 选区是不是"**正好**这张表块"（允许把表尾那一个换行一起选中）。
   刻意只认这一种形态：选区里只要还夹着表外的字，就不是"复制表格" —— 给 TSV 会把表外的字吃掉；
   那种选区继续走 markdown 源码出口（判据 5 的"逐字节不变"就锚在这条边界上）。 */
function tableClipForSelection(state) {
  const ranges = state.selection.ranges.filter((r) => !r.empty);
  if (ranges.length !== 1) return null;                  // 多光标（罕见的跨表选择）⇒ 交回源码出口
  const r = ranges[0];
  const tb = tableTablesOf(state).find((t) => t.from === r.from && (t.to === r.to || t.to + 1 === r.to));
  return tb ? tableClipPayloadOf(tb) : null;
}

/* ══ 复制/剪切：一律给**文档源码**（D8 的必备配套）══
 *  阅读态里 DOM 已经不是源码：公式是 KaTeX 字形、加粗的 `**` 被隐藏、列表 `-` 换成了 `•`、
 *  表格是行 widget。浏览器默认复制只会拿到这些"转写后的字形"，粘到别处就丢语法。
 *  所以只要选区非空就由我们写 text/plain = state.sliceDoc(range)（逐字等于文件内容）。
 *  注意：本条接管 text/plain；将来"复制表格到 Excel"的 CF_HTML 富文本要在同一个处理器里
 *  另写 text/html（浏览器默认路径已被 preventDefault 挡住，这是有意的，避免两套内容打架）。 */
const docSourceClipboard = EditorView.domEventHandlers({
  copy(event, view) {
    /* 【图片口味·2026-10-06】选区含图时先补二进制图片（微信/DeepSeek 网页端只认 `image/png`）。
       为什么**合进这一个处理器**而不是再注册一个 domEventHandlers：实测两个 `copy` 处理器
       同时注册时**只有文档序里靠前的那个会被调用**（后一个 `imgCopyDiag.calls` 恒为 0，
       而 document 层监听证明 copy 事件确实派发到了 contentDOM）⇒ 图片分支必须并入这里，
       否则永远不执行。文本口味保持"文档源码"（D8 口径）不变。 */
    if (imgCopyFill(event, view)) return true;
    const st = view.state;
    const ranges = st.selection.ranges.filter((r) => !r.empty);
    if (!ranges.length) return false;
    /* 【B-1·③ 折中】选区**正好是一张表块**（例如 Ctrl+A 递进到"整表"那一级）⇒ TSV + `<table>`：
       Excel/Word 直接铺成真表格，粘网页也是表。其余选区（含"表 + 表外的字"）一律往下走源码出口，
       即 D8 口径在这一支继续生效 ⇒ 判据 5（不含表的选区逐字节不变）由这条 if 的边界保证。 */
    const tablePayload = tableClipForSelection(st);
    if (tablePayload) {
      try { event.clipboardData?.setData("text/plain", tablePayload.tsv); } catch { /* 宿主禁止 */ }
      try { event.clipboardData?.setData("text/html", tablePayload.html); } catch { /* 宿主禁止 */ }
      event.preventDefault();
      return true;
    }
    // Native copy reads state.sliceDoc and resets its linewise-copy metadata.
    return false;
  },
  cut(event, view) {
    const st = view.state;
    const ranges = st.selection.ranges.filter((r) => !r.empty);
    if (!ranges.length) return false;
    /* 【整表剪切·2026-10-17 实测缺陷 TBL-6】整表选区（Ctrl+A 递进到"整表"）下 Ctrl+X 与 Ctrl+C 两条口径：
       复制给 TSV+<table>，剪切却落到原生路径给 markdown 源码；更糟的是原生删除被 tableSelInputGuard 按
       "行级删除不许毁表"的口径拦下 ⇒ **一个字都没删**（实测：doc 一字不变、剪贴板已被换掉）。
       这里与复制同源：同一份表格载荷 + 一次整块删除（userEvent:'input.table' 让守卫放行，撤销一步）。 */
    const tablePayload = tableClipForSelection(st);
    if (tablePayload) {
      try { event.clipboardData?.setData("text/plain", tablePayload.tsv); } catch { /* 宿主禁止 */ }
      try { event.clipboardData?.setData("text/html", tablePayload.html); } catch { /* 宿主禁止 */ }
      event.preventDefault();
      const cutRange = ranges[0];
      try {
        view.dispatch({ changes: { from: cutRange.from, to: cutRange.to, insert: "" }, selection: { anchor: cutRange.from }, effects: setTableSel.of(null), userEvent: "input.table" });
      } catch (e) { console.error("[mp] 整表剪切失败：", e); }
      return true;
    }
    /* 【β1】行层级的选区是**整行源码**（[line.from, line.to]）：直接 replaceSelection("") 会把那一行
       变成空行 ⇒ scanTables 在这里 break ⇒ **表被切成"只剩表头 + 余下塌成源码"**（用户看见"我的表被切了"）。
       整行选区落在表块里时改走 tableOp('row-delete')（与右键菜单同一实现，守卫/提示一致）。 */
    if (isFullTableRowSelection(st)) {
      const text = ranges.map((r) => st.sliceDoc(r.from, r.to)).join(st.lineBreak);
      event.clipboardData?.setData("text/plain", text);
      event.preventDefault();
      try { window.mpExtras?.tableOp?.("row-delete"); } catch (e) { console.error("[mp] 行剪切失败：", e); }
      return true;
    }
    return false;
  },
});

/* ══ 选区含图片 → 剪贴板里给**二进制图片口味**（image/png 等）═══════════════════════
 *  问题：选中一张内联大图复制，粘到微信/DeepSeek 网页端这类目标会变成一长串
 *  `<img src="data:image/png;base64,…">` 文本 —— 因为它们只认 `image/png`（或 Files），
 *  不认 data URI 的 HTML。而 `setData` **不支持二进制**，必须走 `clipboardData.items.add(File)`。
 *  又因为 **copy 事件里不能 await**，图片必须在选区变化/图片就绪时就**预取成 Blob 并缓存**。
 *
 *  口径：
 *   · 按 `src` 去重缓存（LRU 上限 8 条 / 总字节上限 48MB，超限跳过并在 console 说明）；
 *   · data URI 用 `fetch(dataURI).blob()` 取字节；MIME 以 data URI 头里的声明为准（GIF/JPEG 原样保留）；
 *   · 本地相对路径走宿主桥读字节再 `new Blob`（懒加载进 bundle，失败就静默跳过）；
 *   · 只对"选区**完整包含**某个图片 mark"的情况补图片口味；纯文字选区一律不碰（交回既有处理器）。 */
const IMG_BLOB_MAX = 48 * 1024 * 1024;      // 单张上限：超过不缓存（避免把整篇图灌进内存）
/* 【缓存条数·2026-10-17 实测缺陷】改前 8 条：而预取也恰好"单轮最多 8 张、按文档顺序"⇒
   一屏图超过 8 张时，第 9 张之后**永远进不了缓存**，选中它 Ctrl+C 拿不到位图口味（复制事件已被接管）。
   条数上限只是内存护栏，真正的上限是下面的 48MB 总量；提到 32 后一次多选的多张图也留得住。 */
const IMG_BLOB_KEEP = 32;                   // 缓存条数上限（LRU）
const IMG_RASTER_MAX_PIXELS = 64000000;
const IMG_RASTER_MAX_SIDE = 32768;
const IMG_RASTER_TIMEOUT_MS = 10000;

const imgBlobs = new Map();                 // src -> { blob, mime, name, bytes } | 'pending' | null(取不到)
let imgBlobBytes = 0;
let imgBlobEpoch = 0;
let imgBlobToken = 0;
let imgBlobEpochReason = '';
const imgPending = new Map(); // key -> unique pending identity {epoch,token}; imgBlobs value stays 'pending'
/** data URI → { mime, base64 }；不是 data URI 返回 null。 */
function imgParseDataUri(src) {
  const m = /^data:([^;,]*)(;[^,]*)?,/.exec(src);
  if (!m) return null;
  return { mime: (m[1] || "").toLowerCase(), base64: /;base64/i.test(m[2] || "") };
}
function imgBlobGet(src) {
  const rec = imgBlobs.get(src);
  if (rec === "pending" || rec === null) return rec;
  return rec && rec.epoch === imgBlobEpoch ? rec : undefined;
}
function imgBlobCost(rec) {
  if (!rec || rec === "pending" || rec === null || rec.state !== "ready") return 0;
  return (rec.bytes || 0) + (rec.raster && rec.raster.data && typeof rec.raster.data.byteLength === "number" ? rec.raster.data.byteLength : 0);
}
function imgBlobDrop(src) {
  if (!imgBlobs.has(src)) { imgPending.delete(src); imgRasterPrune(); return; }
  const old = imgBlobs.get(src);
  if (old !== "pending" && old !== null && old.state === "ready") imgBlobBytes -= imgBlobCost(old);
  imgBlobs.delete(src);
  imgPending.delete(src);
  imgRasterPrune();
}
function imgBlobSet(src, value) {
  if (value !== "pending" && value !== null && value.state === "ready" && imgBlobCost(value) > IMG_BLOB_MAX) return;
  if (imgBlobs.has(src)) imgBlobDrop(src);
  imgBlobs.set(src, value);
  if (value !== "pending" && value !== null && value.state === "ready") imgBlobBytes += imgBlobCost(value);
  while (imgBlobs.size > IMG_BLOB_KEEP) imgBlobDrop(imgBlobs.keys().next().value);
  while (imgBlobBytes > IMG_BLOB_MAX && imgBlobs.size > 1) imgBlobDrop(imgBlobs.keys().next().value);
}
function imgBlobSetPending(src, pending) {
  imgBlobSet(src, "pending");
  imgPending.set(src, pending);
}
function imgBlobOwned(src, pending, epoch) {
  return !!pending && pending.epoch === epoch && imgBlobEpoch === epoch
    && imgPending.get(src) === pending && imgBlobs.get(src) === "pending";
}
function imgBlobCommit(src, pending, rec) {
  if (!imgBlobOwned(src, pending, pending.epoch)) return false;
  if (imgBlobCost(rec) > IMG_BLOB_MAX) return false;
  imgBlobSet(src, rec);
  imgPending.delete(src);
  return true;
}
function imgBlobNull(src, pending) {
  if (!imgBlobOwned(src, pending, pending.epoch)) return false;
  imgBlobSet(src, null);
  imgPending.delete(src);
  return true;
}
function imgBlobInvalidate(reason, targetView) {
  imgBlobEpoch++;
  imgBlobs.clear();
  imgPending.clear();
  imgBlobBytes = 0;
  imgBlobEpochReason = reason;
  imgRasterPrune();
  const refreshPreview = reason === 'replaceDocument' || reason === 'setValue' || reason === 'docdir';
  if (refreshPreview) {
    mpImgPreviewEpoch++;
    mpImgLoadState.clear();
    mpImgTries.clear();
  }
  if (targetView) {
    try {
      cancelImgPrefetch(targetView);
      if (reason === 'replaceDocument' || reason === 'setValue') {
        targetView.dispatch({ effects: [imgPreviewBump.of(null)], annotations: Transaction.addToHistory.of(false) });
      }
      prefetchSelectionImages(targetView);
      scheduleImgPrefetch(targetView);
    } catch { /* lifecycle must not throw */ }
  }
}

async function imgFetchLocal(src) {
  const value = typeof src === 'string' ? src : '';
  if (!value) return null;
  const BS = String.fromCharCode(92);
  const host = window.mpHost;
  const hasHost = !!(host && typeof host.readFileBase64 === 'function');
  let resolved = null;
  try { resolved = new URL(value, document.baseURI); } catch { resolved = null; }
  const httpLike = /^https?:/i.test(value) || !!(resolved && (resolved.protocol === 'http:' || resolved.protocol === 'https:'));
  if (hasHost && httpLike) return null; // remote HTTP never becomes a local host read

  const winAbs = value.length >= 3 && /^[A-Za-z]$/.test(value[0]) && value[1] === ':' && (value[2] === '/' || value[2] === BS);
  const uncRaw = value.startsWith(BS + BS) || value.startsWith('//');
  let localPath = null;
  if (winAbs) localPath = value.split('/').join(BS);
  else if (uncRaw) localPath = value.split('/').join(BS);
  else if (resolved && resolved.protocol === 'file:') localPath = imgFileUrlPath(resolved);
  else if (value.startsWith('/')) {
    try { localPath = imgFileUrlPath(new URL(value, document.baseURI)); } catch { localPath = null; }
  }

  if (hasHost) {
    // Desktop host first; host failure returns null and must not fall into fetch(file).
    if (!localPath) return null;
    let r = null;
    try { r = await host.readFileBase64(localPath, { maxBytes: IMG_BLOB_MAX }); } catch { r = null; }
    if (!r || r.ok !== true || typeof r.base64 !== 'string' || !r.base64) return null;
    if (Number.isFinite(r.bytes) && r.bytes > IMG_BLOB_MAX) return null;
    if (r.base64.length > Math.ceil(IMG_BLOB_MAX * 4 / 3) + 8) return null;
    const bin = atob(r.base64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const ext = (localPath.split('.').pop() || '').toLowerCase();
    const extMime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp' : ext === 'bmp' ? 'image/bmp' : 'image/png';
    const mime = (typeof r.mime === 'string' && /^image\//i.test(r.mime)) ? r.mime : extMime;
    if (/svg/i.test(mime)) return null;
    return new Blob([buf], { type: mime });
  }

  // Non-desktop fallback: keep prior fetch behavior; absolute HTTP still not newly prefetched.
  if (/^https?:/i.test(value)) return null;
  try {
    const res = await fetch(value);
    if (res && res.ok) { const b = await res.blob(); if (b && b.size) return b; }
  } catch { /* no host bridge; preserve original fallback */ }
  return null;
}
function imgToBackslash(s) {
  return s.split('/').join(String.fromCharCode(92));
}
function imgFileUrlPath(u) {
  let p;
  try { p = decodeURIComponent(u.pathname || ''); } catch { return null; }
  const BS = String.fromCharCode(92);
  const host = String(u.hostname || '').toLowerCase();
  if (host && host !== 'localhost') return BS + BS + u.hostname + imgToBackslash(p);
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return imgToBackslash(p);
}
/** data URI → Blob，**不走 fetch**。
 *  【为什么不能用 fetch(dataURI)】独立桌面壳的 CSP 是 `connect-src 'none'`
 *  （见 `MarkPilot-CM6\renderer\index.html`）⇒ 打包后的渲染进程里 `fetch("data:…")` 被 CSP 直接拒掉，
 *  Blob 永远取不到。装机实测：copy 处理器跑了、`imgs=1`，但 `added=0` —— 剪贴板里只剩文本。
 *  自己解 base64 / 百分号转义：零网络、零 CSP 依赖，任何宿主一个样。 */
function imgDataUriToBlob(src) {
  const m = /^data:([^,]*),([\s\S]*)$/.exec(src);
  if (!m) return null;
  const meta = m[1] || "";
  const body = m[2] || "";
  const mime = (meta.split(";")[0] || "").toLowerCase();
  try {
    if (/;base64/i.test(meta)) {
      const bin = atob(body.replace(/\s+/g, ""));
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return { blob: new Blob([u8], { type: mime || "application/octet-stream" }), mime };
    }
    const u8 = new TextEncoder().encode(decodeURIComponent(body));
    return { blob: new Blob([u8], { type: mime || "text/plain" }), mime };
  } catch { return null; }
}
const imgRasterQueue = [];
let imgRasterActive = null;
let imgRasterQueuedBytes = 0;
let imgRasterQuarantine = null;
function imgRasterReleaseQueued(job) {
  imgRasterQueuedBytes = Math.max(0, imgRasterQueuedBytes - (job.blobBytes || 0));
  job.queued = false; job.done = true; job.blob = null; job.owned = null; job.maxBytes = 0;
  try { job.resolve(null); } catch { }
}
function imgRasterDrain() {
  while (imgRasterQueue.length) imgRasterReleaseQueued(imgRasterQueue.shift());
}
function imgRasterPrune() {
  for (let i = imgRasterQueue.length - 1; i >= 0; i--) {
    const job = imgRasterQueue[i];
    let ok = false; try { ok = job.owned ? job.owned() : false; } catch { ok = false; }
    if (ok) continue;
    imgRasterQueue.splice(i, 1); imgRasterReleaseQueued(job);
  }
  if (imgRasterActive) {
    let ok = false; try { ok = imgRasterActive.owned ? imgRasterActive.owned() : false; } catch { ok = false; }
    if (!ok) { try { imgRasterActive.cancel(); } catch { } }
  }
}
function imgRasterPump() {
  if (imgRasterQuarantine || imgRasterActive || imgRasterQueue.length === 0) return;
  const job = imgRasterQueue.shift();
  imgRasterQueuedBytes = Math.max(0, imgRasterQueuedBytes - (job.blobBytes || 0));
  job.queued = false;
  let ok = false; try { ok = job.owned ? job.owned() : false; } catch { ok = false; }
  if (!ok) { job.done = true; job.blob = null; job.owned = null; job.maxBytes = 0; try { job.resolve(null); } catch { } imgRasterPump(); return; }
  imgRasterActive = job;
  const registerCancel = (cancel) => { job.cancel = cancel; };
  imgPngRasterNow(job, registerCancel)
    .then((v) => { try { job.resolve(v); } catch { } })
    .catch(() => { try { job.resolve(null); } catch { } })
    .finally(() => {
      if (imgRasterActive !== job) return;
      if (!job.phaseSettled && job.pendingPhase) {
        const phase = job.pendingPhase;
        imgRasterQuarantine = job;
        imgRasterActive = null;
        imgRasterDrain();
        job.blob = null; job.owned = null; job.maxBytes = 0; job.pendingPhase = null;
        phase.then(() => { }, () => { }).finally(() => {
          if (imgRasterQuarantine === job) imgRasterQuarantine = null;
          job.done = true; job.phaseSettled = true;
          imgRasterPump();
        });
        return;
      }
      imgRasterActive = null;
      job.done = true; job.blob = null; job.owned = null; job.maxBytes = 0; job.cancel = null;
      imgRasterPump();
    });
}
function imgPngRaster(blob, owned, maxBytes) {
  let ok = false;
  try { ok = !!blob && !!owned() && Number.isFinite(maxBytes) && maxBytes > 0 && Number.isFinite(blob.size) && blob.size > 0; } catch { ok = false; }
  if (!ok) return Promise.resolve(null);
  imgRasterPrune();
  if (imgRasterQuarantine) return Promise.resolve(null);
  if (imgRasterQueue.length >= IMG_BLOB_KEEP) return Promise.resolve(null);
  const activeBytes = imgRasterActive && imgRasterActive.blob ? imgRasterActive.blob.size : 0;
  if (activeBytes + imgRasterQueuedBytes + blob.size > IMG_BLOB_MAX) return Promise.resolve(null);
  return new Promise((resolve) => {
    const job = { blob, blobBytes: blob.size, owned, maxBytes, resolve, queued: true, done: false, cancel: null, pendingPhase: null, phaseSettled: true };
    imgRasterQueue.push(job); imgRasterQueuedBytes += job.blobBytes;
    imgRasterPump();
  });
}
async function imgPngRasterNow(job, registerCancel) {
  const blob = job.blob, owned = job.owned, maxBytes = job.maxBytes;
  if (!blob || !owned() || !Number.isFinite(maxBytes) || maxBytes <= 0) return null;
  let url = null, timer = 0, img = null, canvas = null;
  let cancelReject = null;
  const cancelPromise = new Promise((_, reject) => { cancelReject = reject; });
  if (typeof registerCancel === "function") registerCancel(() => { try { cancelReject(new Error("raster cancel")); } catch { } });
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('raster timeout')), IMG_RASTER_TIMEOUT_MS); });
  const track = (p) => {
    job.pendingPhase = p; job.phaseSettled = false;
    p.then(() => { job.phaseSettled = true; }, () => { job.phaseSettled = true; });
    return p;
  };
  try {
    url = URL.createObjectURL(blob);
    img = new Image(); img.src = url;
    await Promise.race([track(img.decode()), timeout, cancelPromise]);
    if (!owned()) return null;
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h || w > IMG_RASTER_MAX_SIDE || h > IMG_RASTER_MAX_SIDE || w * h > IMG_RASTER_MAX_PIXELS) return null;
    canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d'); if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    if (!owned()) return null;
    const encodeP = track(new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error('png encode failed')), 'image/png')));
    const pngBlob = await Promise.race([encodeP, timeout, cancelPromise]);
    if (!owned()) return null;
    if (!pngBlob || pngBlob.size <= 0 || pngBlob.size > maxBytes) return null;
    const abP = track(pngBlob.arrayBuffer());
    const ab = await Promise.race([abP, timeout, cancelPromise]);
    if (!owned()) return null;
    return new Uint8Array(ab);
  } catch { return null; }
  finally {
    if (timer) clearTimeout(timer);
    try { if (url) URL.revokeObjectURL(url); } catch { }
    try { if (img) img.src = ''; } catch { }
    try { if (canvas) { canvas.width = 0; canvas.height = 0; } } catch { }
  }
}
function imgCopyDiagMeta(u8, type, name) {
  let h = 0;
  for (let i = 0; i < u8.length; i++) h = ((h * 31) + u8[i]) >>> 0;
  return { type, name, size: u8.length, hash: h.toString(16), head: [...u8.slice(0, 8)].join(",") };
}
/** 预取一张图的字节（幂等；同一个 src 只会有一个 in-flight）。 */
function imgPrefetch(src) {
  if (!src || typeof src !== "string") return;
  src = mpImgSrc(src); // Resource ownership includes the captured document base.
  if (src.startsWith("http://") || src.startsWith("https://")) return;   // 网图不预取（离线取不到，也不该偷偷发请求）
  const epoch = imgBlobEpoch;
  const existing = imgBlobs.get(src);
  if (existing === "pending" || existing === null) return;
  if (existing && existing.epoch === epoch) {
    if (existing.state === "ready") imgBlobSet(src, existing);
    return;
  }
  const pending = { epoch, token: ++imgBlobToken };
  imgBlobSetPending(src, pending);
  const data = imgParseDataUri(src);
  const run = async () => {
    let blob = null, mime = "";
    try {
      if (data) {
        const dec = imgDataUriToBlob(src);
        if (dec) { blob = dec.blob; mime = data.mime || dec.mime || ""; }
      } else {
        blob = await imgFetchLocal(src);
        mime = (blob && blob.type) || "";
      }
    } catch { blob = null; }
    if (!imgBlobOwned(src, pending, epoch)) return;
    if (!blob || !blob.size) { imgBlobNull(src, pending); return; }
    if (blob.size > IMG_BLOB_MAX) { imgBlobNull(src, pending); return; }     // 超大图不缓存（首屏优先）
    if (!/^image\//i.test(mime)) mime = blob.type && /^image\//i.test(blob.type) ? blob.type : "image/png";
    if (/svg/i.test(mime)) { imgBlobNull(src, pending); return; }            // SVG 不是位图，不做图片口味
    let name = "image";
    if (data) name = "pasted-image";
    else {
      try { const u = new URL(src, "file:///"); name = decodeURIComponent((u.pathname || "").split("/").pop() || "image").replace(/[^\w.\-]/g, "_").slice(0, 40) || "image"; }
      catch { /* 解析不了就用默认名 */ }
    }
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += "." + (mime.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "");
    if (!imgBlobOwned(src, pending, epoch)) return;
    let rawBytes = null;
    try { rawBytes = new Uint8Array(await blob.arrayBuffer()); } catch { rawBytes = null; }
    if (!imgBlobOwned(src, pending, epoch)) return;
    if (!rawBytes || rawBytes.byteLength !== blob.size) { imgBlobNull(src, pending); return; }
    let raster = null;
    if (/^image\/(?:gif|webp|bmp)$/i.test(mime)) {
      const png = await imgPngRaster(blob, () => imgBlobOwned(src, pending, epoch), IMG_BLOB_MAX - rawBytes.byteLength);
      if (!imgBlobOwned(src, pending, epoch)) return;
      if (png && png.byteLength > 0 && rawBytes.byteLength + png.byteLength <= IMG_BLOB_MAX) raster = { mime: "image/png", data: png };
    }
    if (!imgBlobOwned(src, pending, epoch)) return;
    if (rawBytes.byteLength + (raster ? raster.data.byteLength : 0) > IMG_BLOB_MAX) raster = null;
    const rec = { epoch, token: pending.token, state: "ready", data: rawBytes, mime, name, bytes: rawBytes.byteLength,
      raster, diag: imgCopyDiagMeta(rawBytes, mime, name) };
    imgBlobCommit(src, pending, rec);
  };
  run();
}
/** 选区里"被完整包含"的图片 mark（用于 copy 补口味）。 */
function imagesInSelection(state) {
  const marks = state.field(inlineMarksField, false) || [];
  const out = [];
  for (const m of marks) {
    if (!m.image) continue;
    const inside = state.selection.ranges.some((r) => !r.empty && r.from <= m.from && r.to >= m.to);
    if (inside) out.push(m.image);
  }
  return out;
}
/** 【选区优先预取·2026-10-17 实测缺陷】复制是**同步**事件、不能 await，所以图片必须在按下 Ctrl+C
 *  之前就已经在 `imgBlobs` 里。改前只有"视口 ±20 行、单轮最多 8 张、按文档顺序"的惰性预取 ⇒
 *  一屏 10 张图时第 9/10 张永远不会被取，选中它复制只剩 markdown 文本（实测 `imgs=1/added=0`）。
 *  这里把"用户当前选中的图"单独拉出来、**立即**预取（不排队、不受 8 张预算限制）——
 *  用户在选中一张图到按 Ctrl+C 之间通常有几百毫秒，足够把一张图解码进缓存。 */
function prefetchSelectionImages(view) {
  try {
    const imgs = imagesInSelection(view.state);
    for (const im of imgs) imgPrefetch(im.src);
  } catch { /* 忽略 */ }
}
/** 选区/视口变化后预取（**停稳再做 + 空闲时段 + 只做视口附近**；纯文字文档零成本）。
 *  【滚动卡顿·2026-10-09 修复】改前：每次视口变化（滚轮每一格）都在 **requestAnimationFrame** 里
 *  遍历**全文**行内标记逐个预取 —— 8MB 含图文档上实测（长任务口径）6 次长任务 / 总阻塞 556ms / 最长 132ms
 *  （用户报障原话"滚动中卡顿跳动"）。现在三层收敛：
 *  ① 140ms 去抖：滚动过程中不再往帧里塞活；
 *  ② requestIdleCallback（timeout 兜底）：不占帧预算；
 *  ③ 只做**可视行 ±20 行**、单轮最多 8 张：远处的图等滚过去再说。
 *  A/B（同尺子，24 格滚轮）：长任务 6→1、总阻塞 556→76ms、最长 132→76ms。 */
function scheduleImgPrefetch(view) {
  if (imgPrefetchOwner !== view) {
    cancelImgPrefetch();
    imgPrefetchOwner = view;
  }
  if (imgPrefetchTimer || imgPrefetchIdle) return;
  const generation = ++imgPrefetchGeneration;
  imgPrefetchTimer = setTimeout(() => {
    if (generation !== imgPrefetchGeneration || imgPrefetchOwner !== view) return; // stale timeout cannot touch new state
    imgPrefetchTimer = 0;
    const run = () => {
      if (generation !== imgPrefetchGeneration || imgPrefetchOwner !== view) return;
      imgPrefetchIdle = 0;
      try {
        prefetchSelectionImages(view);
        const marks = view.state.field(inlineMarksField, false) || [];
        const doc = view.state.doc;
        const vp = view.viewport;
        const firstLine = doc.lineAt(vp.from).number - 20;
        const lastLine = doc.lineAt(vp.to).number + 20;
        let done = 0;
        for (const m of marks) {
          if (!m.image || !m.image.src) continue;
          const ln = doc.lineAt(m.from).number;
          if (ln < firstLine || ln > lastLine) continue;
          imgPrefetch(m.image.src);
          if (++done >= 8) break;
        }
      } catch { /* 忽略 */ }
    };
    if (typeof requestIdleCallback === "function") imgPrefetchIdle = requestIdleCallback(run, { timeout: 600 });
    else imgPrefetchIdle = setTimeout(run, 0);
  }, 140);
}
function cancelImgPrefetch(view = null) {
  if (view && imgPrefetchOwner && imgPrefetchOwner !== view) return;
  imgPrefetchGeneration++;
  if (imgPrefetchTimer) { clearTimeout(imgPrefetchTimer); imgPrefetchTimer = 0; }
  if (imgPrefetchIdle) {
    try { if (typeof cancelIdleCallback === "function") cancelIdleCallback(imgPrefetchIdle); else clearTimeout(imgPrefetchIdle); } catch { }
    imgPrefetchIdle = 0;
  }
  if (!view) imgPrefetchOwner = null;
}
let imgPrefetchTimer = 0;
let imgPrefetchIdle = 0;
let imgPrefetchGeneration = 0;
let imgPrefetchOwner = null;
const imgPrefetchPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.view = view; scheduleImgPrefetch(view); }
  update(u) {
    if (u.selectionSet) prefetchSelectionImages(u.view);     // 选中即取：复制前把缓存备好
    if (u.docChanged || u.selectionSet || u.viewportChanged) scheduleImgPrefetch(u.view);
  }
  destroy() { cancelImgPrefetch(this.view); }
});
/** 取证计数：copy 处理器被调用的次数与分支（排障"复制没带上图"用；零成本，只在 copy 时自增）。
 *  `addedInfo` 记下**真正写进 clipboardData 的那一份**（type/size/前 8 字节 + 全字节简单哈希）——
 *  "字节是否与源一致"因此可以在**源侧**断言死，不依赖粘贴端（headless 的粘贴端拿不到字节）。 */
const imgCopyDiag = { calls: 0, imgs: 0, added: 0, lastErr: null, addedInfo: null, transport: null, writeAttempts: 0, syncResult: null, generation: 0 };
/** 图片口味填充器（**由 docSourceClipboard.copy 调用**，见那边的说明：两个 copy 处理器只会有第一个生效）。
 *  返回 true ＝ 已写入"含图片"的剪贴板载荷（调用方据此直接收工），false ＝ 让文字路径照旧走。 */
function imgCopyFill(event, view) {
  imgCopyDiag.calls++;
  ++imgCopyDiag.generation;
  const st = view.state;
  if (st.selection.main.empty) return false;
  const imgs = imagesInSelection(st);
  imgCopyDiag.imgs = imgs.length;
  imgCopyDiag.added = 0;
  imgCopyDiag.addedInfo = null;
  imgCopyDiag.lastErr = null;
  imgCopyDiag.transport = null;
  imgCopyDiag.writeAttempts = 0;
  imgCopyDiag.syncResult = null;
  if (!imgs.length) return false;
  const cb = event.clipboardData;
  if (!cb) return false;
  const ranges = st.selection.ranges.filter((r) => !r.empty);
  const text = ranges.map((r) => st.sliceDoc(r.from, r.to)).join("\n");
  let htmlBody = "";
  try {
    htmlBody = text.split("\n").map((ln) => {
      const esc = ln.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return esc.replace(/!\[([^\]]*)\]\((<[^>]*>|[^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (w0, alt, url) => {
        const u = String(url).replace(/^<|>$/g, "").replace(/"/g, "&quot;");
        return `<img src="${u}" alt="${String(alt).replace(/"/g, "&quot;")}">`;
      });
    }).join("<br>");
  } catch { htmlBody = ""; }
  const html = '<div data-markpilot-source="markdown">' + htmlBody + '</div>';
  let chosen = null;
  for (const im of imgs) {
    const rec = imgBlobGet(mpImgSrc(im.src));
    if (!rec || rec === "pending" || rec === null) { imgPrefetch(im.src); continue; }
    if (rec.data instanceof Uint8Array && rec.data.byteLength === rec.bytes) { chosen = rec; break; }
  }
  const host = window.mpHost;
  if (chosen && host && typeof host.writeClipboardImage === "function") {
    imgCopyDiag.writeAttempts = 1;
    try {
      const payload = { text, html, mime: chosen.mime, name: chosen.name, bytes: chosen.data };
      if (chosen.raster && chosen.raster.mime === "image/png" && chosen.raster.data instanceof Uint8Array) {
        payload.raster = { mime: "image/png", bytes: chosen.raster.data };
      }
      const eventToken = host && typeof host.eventClipboardIntent === 'function' ? host.eventClipboardIntent('copy') : null;
      const result = host.writeClipboardImage(payload, eventToken);
      if (result && result.canceled) { imgCopyDiag.syncResult = { ok: false, canceled: true, status: 'canceled' }; imgCopyDiag.transport = 'native-sync-canceled'; event.preventDefault(); return true; }
      if (!result || result.ok !== true) throw new Error((result && result.error) || "native-sync-failed");
      imgCopyDiag.added = 1;
      imgCopyDiag.transport = "native-sync";
      imgCopyDiag.addedInfo = { ...chosen.diag, transport: "native-sync" };
      imgCopyDiag.syncResult = { ok: true, width: result.width, height: result.height };
      event.preventDefault();
      return true; // clipboardData empty; native clipboard already has all flavors
    } catch (err) {
      imgCopyDiag.lastErr = String(err && err.message || err);
      imgCopyDiag.transport = "native-sync-failed";
      imgCopyDiag.syncResult = { ok: false, error: imgCopyDiag.lastErr };
    }
  }
  try { cb.setData("text/plain", text); } catch { /* 某些宿主禁止 */ }
  try { if (html) cb.setData("text/html", html); } catch { /* 忽略 */ }
  let added = 0;
  for (const im of imgs) {
    const rec = imgBlobGet(mpImgSrc(im.src));
    if (!rec || rec === "pending" || rec === null) { imgPrefetch(im.src); continue; }
    try {
      const file = new File([rec.data], rec.name, { type: rec.mime });
      cb.items.add(file, rec.mime);
      added++;
      imgCopyDiag.added = added;
      imgCopyDiag.transport = "browser-file";
      imgCopyDiag.lastErr = null;
      imgCopyDiag.addedInfo = { ...rec.diag, transport: "browser-file" };
      break;
    } catch (err) { imgCopyDiag.lastErr = String(err && err.message || err); console.error("[mp] 图片进剪贴板失败：", err); }
  }
  event.preventDefault();
  return true;
}

/* 扩展包（更多菜单/大纲/导出/表格操作）与可重配 keymap 的挂载点：CM6 只允许在创建时给扩展，故用 Compartment 事后注入。 */
const extrasCompartment = new Compartment();
const keyCompartment = new Compartment();
/* 【阅读模式只读·2026-10-17】阅读模式此前只是 CSS 面具（隐藏光标、收窄版心），编辑器本身仍可编辑
   ⇒ 真机实测在阅读态点正文敲 ZZ，文档长度 17→19（静默改稿）。这里给它一个 Compartment 挂
   readOnly + editable(false)，由 mpEngine.setReadingMode 切换。 */
const readingCompartment = new Compartment();

const clickToSource = EditorView.domEventHandlers({  mousedown(event, view) {
    const image = event.target?.closest?.('.mp-img[data-mp-region]');
    if (image) {
      view.__mpImageClick = null;
      if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return false;
      const index = view.state.field(regionIndexField), r = index.byId.get(image.dataset.mpRegion);
      if (r?.kind !== 'image') return false;
      if ((event.detail || 1) >= 2) {
        if (view.state.field(regionSessionField).imageId !== r.id) return false;
        view.dispatch({ selection: { anchor: r.from, head: r.to }, userEvent: 'select.pointer' });
        view.focus(); return true;
      }
      const shown = image.querySelector('img:not(.mp-img-pending)') || image;
      view.__mpImageClick = { id: r.id, epoch: index.epoch, node: image, x: event.clientX, y: event.clientY,
        top: shown.getBoundingClientRect().height ? shown.getBoundingClientRect().top : image.getBoundingClientRect().top,
        moved: false, serial: viewportIntent.serial(view), revision: r.revision, contextVersion: r.contextVersion };
      view.__mpRegionGesture = { phase: 'down', id: r.id, epoch: index.epoch, serial: viewportIntent.serial(view) };
      return false;
    }
    // 【交互审计 B 修复·位级】双击（detail≥2）：落点在任一数学 span 内（含首击后
    // 已显源码的文本侧——widget 分支够不着）→ 选区钳到 span 整体，防原生 groupAt
    // 把无空格 CJK 串与公式并成一个词（「紧贴$x+a$紧贴」整段选中）。
    if ((event.detail || 1) >= 2) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos != null) {
        const sp = view.state.field(mathSpansField).spans.find((s) => pos > s.from && pos < s.to);
        if (sp) {
          view.dispatch({ selection: { anchor: sp.from, head: sp.to } });
          view.focus();
          return true;
        }
      }
    }
    // 【U-094】块公式类名是 mp-cm6-math-block——.mp-cm6-math 选择器从不匹配它，
    // 块级点击全靠原生落位彩票（落 span 内才展开，落边界外无反应）。
    let holder = event.target && event.target.closest ? event.target.closest(".mp-cm6-math, .mp-cm6-math-block") : null;
    if (!holder) return false;
    // 【K10 验证族①修复】溢出像素纠正：根号 surd SVG 等绝对定位溢出会盖住**上一行**
    // 公式的分母像素并赢下命中测试（event.target 落进别人的 widget），宿主盒几何
    // 校验失败时沿 elementsFromPoint 栈找「自身盒真正含点击点」的公式 widget。
    const inRect = (el, x, y) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.left - 1 <= x && x <= r.right + 1 && r.top - 1 <= y && y <= r.bottom + 1;
    };
    if (!inRect(holder, event.clientX, event.clientY)) {
      const stack = (event.target.ownerDocument || document).elementsFromPoint
        ? (event.target.ownerDocument || document).elementsFromPoint(event.clientX, event.clientY) : [];
      for (const el of stack) {
        const h = el.closest ? el.closest(".mp-cm6-math, .mp-cm6-math-block") : null;
        if (h && inRect(h, event.clientX, event.clientY)) { holder = h; break; }
      }
    }
    const pos0 = view.posAtDOM(holder);
    const spans = view.state.field(mathSpansField).spans;
    const span = spans.find((s) => s.from <= pos0 && pos0 <= s.to) || null;
    let pos = Math.max(pos0, 0) + 1;
    if (span && span.texFrom != null && span.tex.length) {
      const offset = mathGlyphOffset(holder, event, span.tex);
      if (offset != null) pos = mathSourcePosition(span, offset);
    }
    /* 【块公式拖选修复·2026-10-10（普查根因）】原来这里直接精确落位并 `return true`：
       CM6 的 domEventHandlers 返回 true ＝ 该事件已处理 ⇒ **不再走默认处理** ⇒ 拖拽选区机制
       根本不启动（实测拖完选区塌陷、落到"无选区＝整行复制"，Ctrl+C 载荷是缺 $$ 的半截）。
       改成 click vs drag 分离：mousedown 只**记录**落点并放行（return false）⇒ 拖拽正常；
       mouseup 时几乎没有位移（≤4px）才执行精确落位 ⇒ **单击行为与原来完全一致**。
       状态挂在 view 上（expando），不新增模块级变量。 */
    try { view.__mpMathClick = { x: event.clientX, y: event.clientY, pos, t: Date.now(), ...view.__mpMathGesture, moved: false, scrollTop: view.scrollDOM.scrollTop }; } catch { /* 忽略 */ }
    return false;
  },
  mousemove(event, view) {
    const p = view.__mpMathClick;
    if (p && (event.buttons & 1) && Math.abs(event.clientX - p.x) + Math.abs(event.clientY - p.y) > 4) p.moved = true;
    const image = view.__mpImageClick;
    if (image && (event.buttons & 1) && Math.abs(event.clientX - image.x) + Math.abs(event.clientY - image.y) > 4) image.moved = true;
    return false;
  },
  mouseup(event, view) {
    const image = view.__mpImageClick; view.__mpImageClick = null;
    if (image) {
      const index = view.state.field(regionIndexField), r = index.byId.get(image.id);
      const currentMount = [...view.dom.querySelectorAll('.mp-img[data-mp-region]')].find(n => n.dataset.mpRegion === image.id);
      const rect = currentMount?.getBoundingClientRect();
      const sameSource = r?.revision === image.revision && r?.contextVersion === image.contextVersion;
      const hit = !!rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      view.__mpRegionGesture = { phase: 'up', id: image.id, detail: event.detail, moved: image.moved,
        sameEpoch: index.epoch === image.epoch, regionPresent: !!r, sameIntent: image.serial === viewportIntent.serial(view),
        connected: !!currentMount?.isConnected, sameSource, hit, remounted: image.node !== currentMount,
        distance: Math.abs(event.clientX - image.x) + Math.abs(event.clientY - image.y) };
      if ((event.detail || 1) === 1 && !image.moved && index.epoch === image.epoch && r &&
          image.serial === viewportIntent.serial(view) && currentMount?.isConnected && sameSource && hit &&
          Math.abs(event.clientX - image.x) + Math.abs(event.clientY - image.y) <= 4) {
        view.dispatch({ effects: activateRegion.of({ id: r.id }), selection: { anchor: r.editFrom },
          userEvent: 'select.pointer', annotations: Transaction.addToHistory.of(false) });
        view.focus();
        viewportIntent.anchorImage(view, r.id, image.top);
        view.__mpRegionGesture.phase = 'activated';
      }
      return false;
    }
    let p = null;
    try { p = view.__mpMathClick; view.__mpMathClick = null; } catch { p = null; }
    if (!p) return false;
    if ((event.detail || 1) !== 1) return false;                                   // 双击那段由 mousedown 负责
    if (p.moved || view.scrollDOM.scrollTop !== p.scrollTop) return false;
    if (Math.abs(event.clientX - p.x) + Math.abs(event.clientY - p.y) > 4) return false;  // 拖过 ⇒ 不抢选区
    try { setMathPointerSelection(view, p.pos, p); } catch { /* 忽略 */ }
    return false;                                                                  // 放行，不影响后续默认行为
  },
});
const regionKeys = Prec.highest(keymap.of([
  { key: 'Escape', run(v) {
    const s = v.state.field(regionSessionField), r = v.state.field(regionIndexField).byId.get(s.imageId);
    if (!r || !v.hasFocus) return false;
    const after = Math.min(v.state.doc.length, v.state.doc.lineAt(r.to).to + 1);
    viewportIntent.cancel(v);
    v.dispatch({ effects: retireRegion.of({ id: r.id }), selection: { anchor: after },
      annotations: Transaction.addToHistory.of(false), userEvent: 'select' });
    return true;
  } },
  ...['ArrowLeft', 'ArrowRight'].map(key => ({ key, run(v) {
    if (!v.state.selection.main.empty || v.state.field(regionSessionField).imageId) return false;
    const pos = v.state.selection.main.head, r = regionAt(v.state.field(regionIndexField), pos, 'image');
    if (!r || (key === 'ArrowRight' ? pos !== r.from : pos !== r.to)) return false;
    v.dispatch({ effects: activateRegion.of({ id: r.id }), selection: { anchor: key === 'ArrowRight' ? r.editFrom : r.to - 1 },
      annotations: Transaction.addToHistory.of(false), userEvent: 'select' });
    return true;
  } })),
]));

/* ══ Telari（宋体-朙/暗）主题系统——2.3.3 观测等价，CSS 全面模拟 ══
 *  权威源与 vditor 引擎同键同默认（renderer/js/themes.js preferredTheme）：
 *  localStorage['editor-theme']，未选过时 'dark'!=='false' → telari-dark。
 *  双引擎同源即收敛（A-052 解）；跨 iframe 切主题经 storage 事件跟随（零轮询）。
 *  规格：renderer/css/{telari,typography,fontsize}.css——颜色逐项取自
 *  Telari 0.4.8 toml；正文 14px/1.8 宋体+Georgia（正文描边 .007em）；
 *  H1..H6＝30/24/18/16/14/12（H1 行高 38、H2 32）半加粗 700 衬线；
 *  strong 900+.015em；em 楷体 1.18em+.025em 字距；版心 1280（左 46/右 28 垫边）；
 *  引用/表格/代码同 telari 色板；公式裸排（vditor 观感，无胶囊底）。 */

const TELARI = {
  light: {
    mode: "light", bg: "#FAF9F6", fg: "#31312F", heading: "#242423",
    muted: "#636362", faint: "#9A9A98", primary: "#006FB0", border: "#D8D7D4",
    codeBg: "#EDECE9", capsule: "#EDECE9", quoteBg: "#F1EFE9", quoteBar: "#C9C4B8",
    evenRow: "#F1EFE9", markBg: "#F5E9C8", sel: "rgba(0,111,176,0.18)",
    kw: "#000342", str: "#004E36", com: "#616A70", num: "#844500", typ: "#001D4B",
  },
  dark: {
    mode: "dark", bg: "#2E3440", fg: "#C3C7CF", heading: "#EAEDF3",
    muted: "#A4A8AE", faint: "#76797F", primary: "#28AAF1", border: "#4B505B",
    codeBg: "#232935", capsule: "#232935", quoteBg: "#353C4A", quoteBar: "#53607A",
    evenRow: "#353C4A", markBg: "#4A4433", sel: "rgba(40,170,241,0.28)",
    kw: "#E4E7FF", str: "#5EB597", com: "#757E84", num: "#C97F3D", typ: "#96DCFF",
  },
};

function preferredEditorTheme() {
  try {
    const saved = localStorage.getItem("editor-theme");
    /* 【第二波普查·theme-switch 缺陷·2026-10-10】原来的白名单只认宋韵系列（telari 明/暗）、
       裸 light/dark、以及 konayuki 明/暗：用户选「护眼米黄」「GitHub 深色」等其它配色时
       **全部落到下面的回落分支**被映射回宋韵，
       紧接着调用方又把结果写回 localStorage ⇒ **重启必退回宋韵并改写用户选择**
       （普查 R 臂：护眼米黄→telari-light、GitHub 深色→telari-dark；宋韵浅色正常）。
       改为"存什么就尊重什么"：只要有值就原样返回；仅对旧版遗留的裸 light/dark 保持兼容映射。 */
    if (saved) {
      if (/^(light|dark)$/.test(saved)) return saved === "dark" ? "telari-dark" : "telari-light";
      return saved;
    }
    return localStorage.getItem("dark") === "false" ? "telari-light" : "telari-dark";
  } catch { return "telari-dark"; }
}
function applyEditorTheme() {
  mathGeometryVersion++; window.mpEngine?.commands.geometryIntent();
  const id = preferredEditorTheme();
  const root = document.documentElement;
  // 【单一渲染事务·2026-10-07】原先 --mp-* 上坐着四个互不认识的写者（本函数、面板 applyPalette、
  // 工具栏 theme-toggle、EXE 壳 host.js applyTheme），靠"谁后写"定胜负；实测病象：github-dark 后点
  // 一次「切换明暗」→ 整页翻成 telari-light，localStorage 里 editor-theme=telari-light 与 dark=true
  // 自相矛盾，菜单却仍显示「GitHub 深色 · 当前」。现在有登记表（window.mpTheme，由 installExtras 建立）
  // 就**全部委托给它**——它是唯一写者；本函数只在登记表就位前用 TELARI 兜底，
  // 保证 --mp-bg 从第一帧起就有值（否则 html 透明露出原生底，比现状更糟）。
  if (window.mpTheme) { window.mpTheme.apply(id); return; }
  const t = TELARI[id.endsWith("dark") ? "dark" : "light"];
  root.dataset.editorTheme = id;
  root.dataset.mode = t.mode;
  // 【D-8】`mode` 是主题的**字符串**字段（light/dark），不是颜色 token：早先被原样写成
  // `--mp-mode: dark` 挂到 :root 上（零消费者的伪 token）。这里显式跳过。
  for (const [k, v] of Object.entries(t)) { if (k === 'mode') continue; root.style.setProperty(`--mp-${k}`, v); }
}
applyEditorTheme();
window.addEventListener("storage", (e) => { if (e.key === "editor-theme" || e.key === "dark") applyEditorTheme(); });

(function injectTelariCss() {
  const css = `
/* 楷体字面（typography.css 同源：只声明 CJK 码位，西文走真斜体） */
@font-face {
  font-family: 'markpilot-kai';
  src: local('KaiTi'), local('楷体'), local('STKaiti'), local('Kaiti SC'), local('KaiTi SC'), local('DFKai-SB'), local('BiauKai');
  unicode-range: U+2E80-2FDF, U+3005, U+3007, U+3021-3029, U+3038-303A, U+3041-30FF, U+3105-312F, U+31F0-31FF, U+3190-319F, U+3200-33FF, U+3400-4DBF, U+4E00-9FFF, U+A960-A97F, U+AC00-D7A3, U+F900-FAFF, U+FE10-FE19, U+FE30-FE4F, U+FF00-FFEF, U+20000-2FFFD, U+30000-3FFFD;
  font-style: italic;
  /* 【楷体 3%·2026-10-07】1.18em 那个数是补**光学重量**（楷体落墨只有宋体九成，不是字面偏小），
     用 size-adjust 而不是 font-size：①只缩这一款字面——unicode-range 只声明 CJK，西文斜体零影响；
     ②不改 computed font-size ⇒ 无单位 line-height:1.8 的 used 值不变、行盒高度零扰动
     （改 font-size 会让含中文斜体的行矮 ~0.9px，正好撞下面那条高度图纪律）。
     注意：「:1270 的 .cm-content em」是死规则（CM6 产 span 不产 em 元素，元素选择器打不中），
     真正生效的是 :1441 的 HighlightStyle——所以这一处 descriptor 才是唯一改点。 */
  size-adjust: 97%;
}
/* 【复判❷】深色 8px 白边根因：iframe body 默认 margin＋白底——清零铺满 */
html, body { margin: 0; padding: 0; height: 100%; background: var(--mp-bg); }
:root {
  ${editorFontVarsCss()}
}
.cm-editor { background: var(--mp-bg); color: var(--mp-fg); }
.cm-scroller { font-family: var(--mp-font-body); }
/* 中西文/中文数字自动间距（A2-P2：vditor text-autospace 同源；公式/代码退出） */
.cm-content { text-autospace: normal; }
.cm-content :is(.mp-cm6-math, .mp-cm6-math-block, code) { text-autospace: no-autospace; }
/* 【零宽空格必须真的零宽·2026-10-09】CM6 的 highlightSpecialChars（随 basicSetup 进来）会把
 *  "不可见控制字符"画成一个**可见占位字形**（span.cm-specialChar，默认红色圆点，实测占宽 5.5px）。
 *  对**零宽空格 U+200B** 来说这是错的观感：它在正文里就是"看不见、不占位"，
 *  用户看到的是一个凭空冒出来的红点（实测截图 shots/zwsp-before.png），
 *  而且光标跨过它时会白走 5.5px。这里只针对**这一个**控制字符把占位字形压成零宽
 *  （font-size:0：字形 0×0、行高不受影响——实测 25.2px 不变；另两个候选
 *  inline-block;width:0 会把行高顶到 33.7px、display:none 会把它从行盒里摘掉，都不用）。
 *  其它控制字符（软连字符、双向控制符等）**保留**默认红点提示——那些字符出现在正文里通常是事故，
 *  看得见比看不见好。
 *  【选择器的脆弱点，必须知道】这里靠 CM6 自己写上的 title 文本精确匹配；CM6 若改文案，
 *  规则就会失效 ⇒ 观感回到"有红点"。**拦住它的是验收清单 §5.12**（它直接量该 span 的实占宽，
 *  期望 ≤2px）——文案一改那条就会红，届时按新的 title 更新本选择器即可。 */
.cm-content .cm-specialChar[title="Control character zero width space"] { font-size: 0; }
.cm-content {
  font-family: var(--mp-type-body, var(--mp-font-body));
  /* 正文微加肥（telari：宋体单字重，0.007em 描边常态）；公式/标题/代码清零见下 */
  ${editorContentMetricsCss()}
  caret-color: var(--mp-primary);
}
.cm-content .mp-cm6-math, .cm-content .mp-cm6-math-block, .cm-content .cm-line.mp-hx, .cm-content code, .cm-content .mp-code {
  -webkit-text-stroke-width: 0;
}
/* 标题：衬线半加粗＋分级字号＋H1/H2 下边线（vditor --heading-border-color 观感）。
 * 【高度图纪律】行级类禁 margin/padding/min-height（不进 CM6 高度图→光标系统性
 * 漂移，实测首段偏 1 行、块公式后偏 2 行）；全部用 line-height 承担间距。 */
/* 标题阶（字号/行高/下边线来自 typography.js 唯一真源，与导出件同表） */
${editorHeadingsCss()}
/* H 级别徽标（A1-D2：vditor gutter 徽标观感；46px 左垫给悬挂位） */
.cm-line[class*="mp-h"] { position: relative; }
.cm-line.mp-h1::before { content: "H1"; }
.cm-line.mp-h2::before { content: "H2"; }
.cm-line.mp-h3::before { content: "H3"; }
.cm-line.mp-h4::before { content: "H4"; }
.cm-line.mp-h5::before { content: "H5"; }
.cm-line.mp-h6::before { content: "H6"; }
.cm-line[class*="mp-h"]::before {
  position: absolute; left: -30px; top: 50%; transform: translateY(-50%);
  font-family: var(--mp-font-latin); font-size: 12px; font-weight: 400;
  color: var(--mp-muted); opacity: 0.85; pointer-events: none;
}
/* 强调：strong 900+.015em 描边（fontsize.css）；em 楷体斜体（1.18em/字距/字号调整来自唯一真源） */
.cm-content strong { font-weight: 900; -webkit-text-stroke: .015em currentColor; font-family:var(--mp-type-bold, inherit); }
${editorKaiRuleCss()}
/* 公式：裸排（vditor 观感——无胶囊底/无面板），保留命中区与光标语义。
 * 【高度图纪律】widget 元素自身禁 vertical margin（同不进高度图）；间距用 padding。 */
/* 公式：裸排（vditor 观感）。【高度图纪律·A3 复盘】widget 根必须 display:block
 * 且吸收 KaTeX .katex-display 的 1em margin——内联根会让子 margin 漏出盒外
 * （DOM 与高度图差 ~15px→点击漂移一行）；间距一律走自身 padding。 */
.mp-cm6-math { background: transparent; padding: 0; border-radius: 0; font-size: 1em; }
.mp-inline-math-space { display: inline-block; width: 0; overflow: visible; visibility: hidden; pointer-events: none; user-select: none; }
/* ══ 代码块行号栏（3.0.9 · 对齐 Typora 实测规格）═══════════════════════════════════
 *  规格：行号在代码块**左侧独立栏**、右对齐、字号略小、低对比灰、与代码之间有**1px 细竖线**；
 *  每个块**从 1 重新计数**；**空行也占号**（号挂在行元素上，空行一样 +1）；带语言/不带语言都有号。
 *  【号从哪来·2026-10-09 修】号**直接画行属性 data-mp-n**（引擎按块内序号算好）。
 *  改前这里用的是 **CSS 计数器**（counter-increment + content: counter(...)）：计数器**全文档连续**、
 *  没有任何 counter-reset（上面那句"counter-reset 挂在块容器上"**从未落地** —— 代码块没有容器元素）
 *  ⇒ 屏幕上第二块接着第一块往下编（实测：三块 3/2/2 行画成 1,2,3 → 4,5 → 6,7），
 *  与"每个块从 1 开始"冲突，也与属性里本来就正确的号**不一致**。改用 attr() 后二者合一。
 *  纯渲染层：号来自 data-mp-n（行属性）＋CSS attr()，DOM 文本里没有它 ⇒ 复制/导出拿不到。
 *  栏宽按块内最大位数自适应（1/10/100 位）：用 ch 单位，:has() 逐级加宽。 */
/* 【行号栏落位·零布局改动】不额外加 padding（.cm-content 的 24px 左内边距本就是引用框的落位留白），
   把号**画进那 24px 留白里**：行盒从正文列开始，号用负偏移贴到它左边。
   好处：正文列、引用框、选中高亮、高度图**全部不动**（不留 19px 级的横向位移），
   也不会与其它 .cm-line 的 padding-left !important 规则打架（踩过：加了 padding 被后面的 !important 覆盖，
   实测计算值仍是 19.04px）。 */
.cm-content .cm-line.mp-code[data-mp-n] { position: relative; }
/* 1px 细竖分隔线：画在**行盒左缘**（＝正文列）。为什么不挂在 code 子元素上：CM6 的围栏代码行
   实际渲染成 SPAN.ͼx，**没有 code 元素**（实测 DOM 是 .cm-line.mp-code > span）⇒ 早先那条
   .mp-code > code { border-left } 从不命中（计算值 0px，竖线自然看不见）。
   行盒自带 border 会占 1px 布局，但那 1px 落在 24px 留白之内，**正文列不动**。 */
.cm-content .cm-line.mp-code[data-mp-n] { border-left: 1px solid var(--mp-border); }
.cm-content .cm-line.mp-code[data-mp-n]::before {
  content: attr(data-mp-n);
  position: absolute;
  top: 0; bottom: 0;
  left: -1px;                                     /* 贴到行的左缘（含那条 1px 线） */
  transform: translateX(-100%);                   /* 整块挪到行盒左边 = 落进 24px 留白 */
  width: calc(1.35em + var(--mp-codeln, 0ch));    /* 右对齐区：按位数留宽（em 计在 ::before 的字体上） */
  padding-right: .45em;
  box-sizing: border-box;
  text-align: right;
  color: var(--mp-muted);
  opacity: .6;                                    /* 低对比（Typora 观感）；暗/亮主题都用 muted */
  font-size: .82em;
  line-height: inherit;
  font-variant-numeric: tabular-nums;
  user-select: none;                              /* 拖选代码时不会把号选进去 */
  pointer-events: none;
}
/* 位数自适应：10 行以内 1ch，100 行以内 2ch，更多 3ch。 */
.cm-content:has(.cm-line.mp-code[data-mp-n="10"]) { --mp-codeln: 1ch; }
.cm-content:has(.cm-line.mp-code[data-mp-n="100"]) { --mp-codeln: 2ch; }
.cm-content:has(.cm-line.mp-code[data-mp-n="1000"]) { --mp-codeln: 3ch; }
/* 【有序列表】序号观感与圆点同族：等宽数字（tabular-nums）＋一点右空隙，避免 10 项以上串位。 */
.mp-ordered { color: var(--mp-muted); font-variant-numeric: tabular-nums; padding-right: 2px; }
/* 选区里的公式（光标不在其中）＝保持渲染 ＋ 选中底色。原生 ::selection 盖不到 widget 内部字形，
   故自带类；色值＝主题 bg↔fg 混色（--mp-sel-tint 可被自有主题覆盖），不写任何硬编码色。 */
.mp-cm6-math.mp-math-selected, .mp-cm6-math-block.mp-math-selected {
  background: var(--mp-sel-tint, color-mix(in srgb, var(--mp-bg) 72%, var(--mp-fg)));
  border-radius: 3px;
}
.mp-cm6-math-block { display: block; background: transparent; margin: 0; padding: 0.15em 0; border-radius: 0; }
.mp-cm6-math-block .katex-display { margin: 0; }
/* 块公式**源码展开**期间：与渲染态同轴居中（防"居中→左"横跳；纯视觉行类，不进高度图） */
.cm-line.mp-math-src { text-align: center; }
.mp-cm6-math-live { display: block; border: 1px dashed var(--mp-border); background: var(--mp-codeBg); margin: 0; padding: 0.4em 1em; }
.mp-cm6-math-live .katex-display { margin: 0; }
/* 行内/块编辑浮动预览（Typora 行为）：absolute 浮于真文本之上，不占排版流。
 * 【配色纪律·主题无关】底色＝当前主题 bg↔fg 的混色（color-mix），**不写任何硬编码色值**：
 *   · 用户自带 CSS 主题只要定义 --mp-bg/--mp-fg 即自动适配（浅色主题偏灰、深色主题偏亮）；
 *   · 边线/投影同样由主题色派生（border 向 fg 靠、投影用 fg 的透明色）——深浅主题方向自适应。
 * 【毛玻璃·2026-10-07】在「与页面有差色」之上再叠一层背景模糊：下方正文被磨成色块轮廓，
 *   能辨认"这里原本是公式还是文字"，但读不出字，避免浮层内容与下方文字混读。
 *   两个参数写死在此处（--mp-float-blur / --mp-float-alpha），要做成设置项只动这两行；
 *   兜底链：不支持 color-mix → 主题代码底色；不支持 backdrop-filter → 不透明派生色（仍与页面有差色）。 */
.mp-inline-float {
  --mp-float-tint: color-mix(in srgb, var(--mp-bg) 84%, var(--mp-fg));
  /* 表面参数已提到 :root（--mp-float-alpha / --mp-float-blur），此处只消费不声明：
     这样「更多 → 设置 → 界面透明度」才能逐项调整预渲染框，且与其它浮层互不捆绑。 */
  position: absolute;
  visibility: hidden;
  box-sizing: border-box;
  font-size: 93%;
  width: max-content;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  background: var(--mp-codeBg);
  background: var(--mp-float-tint);
  border: 1px solid var(--mp-border);
  border-color: color-mix(in srgb, var(--mp-border) 82%, var(--mp-fg));
  border-radius: 4px;
  padding: 2px 3px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.08);
  box-shadow: 0 1px 4px color-mix(in srgb, var(--mp-fg) 12%, transparent),
              0 0 0 1px color-mix(in srgb, var(--mp-fg) 5%, transparent);
  pointer-events: auto; /* 浮层可点：点字形 → 精确回源码（见 floatClickToSource）；不可点时点击会穿到被盖住的下一行 */
  cursor: text;
  white-space: nowrap;
}
.mp-inline-float::-webkit-scrollbar { height: 3px; }
.mp-inline-float::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
.mp-inline-float::-webkit-scrollbar-track {
  background: color-mix(in srgb, var(--mp-fg) 5%, transparent);
  border-radius: 2px;
}
.mp-inline-float::-webkit-scrollbar-thumb {
  background: var(--mp-border);
  background: color-mix(in srgb, var(--mp-fg) 28%, transparent);
  border-radius: 2px;
  min-width: 24px;
}
.mp-inline-float::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--mp-fg) 42%, transparent);
}
@supports ((backdrop-filter: blur(2px)) or (-webkit-backdrop-filter: blur(2px))) {
  .mp-inline-float {
    background: color-mix(in srgb, var(--mp-float-tint) var(--mp-float-alpha), transparent);
    -webkit-backdrop-filter: blur(var(--mp-float-blur)) saturate(1.05);
    backdrop-filter: blur(var(--mp-float-blur)) saturate(1.05);
  }
}
.mp-inline-float-display { display: inline-block; padding: 2px 3px; }
.mp-inline-float .katex-display { margin: 0; text-align: left; }
.mp-inline-float .katex-display > .katex { text-align: left; }
.mp-cm6-math-live-chip { background: var(--mp-codeBg); border: 1px dashed var(--mp-border); border-radius: 4px; padding: 0 4px; margin-left: 6px; font-size: 0.95em; cursor: text; }
/* 代码：胶囊（inline，token=codeBg 对齐 vditor 实测）与块底（telari 色板）；引用块底纹＋左缘条 */
.cm-content code { background: var(--mp-codeBg); border-radius: 3px; padding: .2em .4em; font-size: .9em; font-family: var(--mp-font-mono); }
.cm-content .cm-line.mp-code { background: var(--mp-codeBg); font-family: var(--mp-font-mono); font-size: .93em; }
.cm-content .cm-line.mp-quote { background: var(--mp-quoteBg); border-left: 3px solid var(--mp-quoteBar); color: var(--mp-muted); font-size: 90%; padding-left: .8em; }
.cm-content .cm-line.mp-quote-d2 { padding-left: 1.8em; }
.cm-content .cm-line.mp-quote-d3 { padding-left: 2.8em; font-size: 85%; }
/* 分割线投影：--- 整行透明＋通宽下边线（光标入行显源码）；line-height 承担上下呼吸（高度图纪律） */
.cm-content .cm-line.mp-hr { color: transparent; -webkit-text-stroke-width: 0; border-bottom: 1px solid var(--mp-border); line-height: 34px; }
/* 围栏行（三反引号）阅读态隐藏。【终判 B3 根因】围栏 token 走 lezer
 * processingInstruction → HighlightStyle 内联 color 压过行类 transparent——
 * ！important＋text-fill 双保险压平一切内联着色。 */
.cm-content .cm-line.mp-fence, .cm-content .cm-line.mp-fence * {
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  -webkit-text-stroke-width: 0 !important;
  font-size: 10px; line-height: 12px;
}
/* 代码块观感对齐（终判差异清单：字号 −9%、行距收敛） */
.cm-content .cm-line.mp-code { background: var(--mp-codeBg); font-family: var(--mp-font-mono); font-size: 0.85em; line-height: 1.55; }
/* 【围栏代码行里的 span 必须"无胶囊"·2026-10-10 实测缺陷（用户报"第一个字母 a 无空格却远离 sdS"）】
   语法高亮给代码文本打的 span 与**行内代码**共用同一个高亮类 .ͼx
   （HighlightStyle 里那条 tag=t.monospace 的规则带 padding: 0.15em 0.3em、代码底色、3px 圆角
    —— 那一套本意只给"行内代码"的小胶囊用）。
   后果：一行代码只要被 CM6 切成两个 span（一次多字符插入 / 输入法提交 / 代码行首按 Tab / 重做），
   两个 span 各自的左右内边距就在**接缝处叠加** ⇒ 凭空多出 6.4px，屏幕上正好"多一个空格"。
   实测（同一文本 a 空格 sdS，文档里只有 1 个 U+0020）：
     载入态 1 个 span：a→s = 6.274px，total−Σadvances = −0.02
     裂成 2 个 span：  a→s = 12.704px，total−Σadvances = +6.400px（= 2×3.213px padding）
   关连字、换等宽字体都不变 ⇒ 与字体无关，纯粹是内边距叠加；裂开后继续打字/退格/滚动都不自愈。
   修法：**围栏行内**的 span 归零内边距/底色/圆角（字号字体仍由行类统一给）。
   正文里的行内代码不受影响：它不在 .mp-code 行内，规则命中不到。
   ⚠️ 本注释在 CSS 模板字符串体内，**不许出现反引号**（一个反引号就会把模板提前结束）。 */
.cm-content .cm-line.mp-code span.ͼx {
  padding: 0 !important; background: transparent !important; border-radius: 0 !important;
}
.cm-content .cm-line.mp-code span.ͼx {
  padding: 0 !important; background: transparent !important; border-radius: 0 !important;
}
/* 【引用区代码块·两类共存·2026-10-08】引用区的围栏行/代码行同时带 mp-code 与 mp-quote：
   · 竖条：必须压过 .mp-code[data-mp-n] 那条 **1px 行号分隔线**（同特异度 (0,4,0)、靠后胜）
     —— 不压的话代码行只剩 1px，引用竖条在这几行断开（checklist §7 实测 blw=1 vs 相邻引用行 3）。
   · 底色：仍是**代码底色**（不许把代码块身份丢掉）；引用底色只画在普通引用行上。
   · 字色：回到正文字色（.mp-quote 的 muted 会把代码压灰）。
   两类共存 = 同一行既有引用装饰（竖条/缩进）又有代码装饰（等宽/底色）。
   ⚠️ 本注释里**不许出现反引号**：它就在 CSS 模板体内，一个反引号会把模板提前结束
      （CSS 被切断、后面的规则变成游离 JS，而语法仍合法 ⇒ 引擎照样起得来、样式静默失效）。
      guard-css-template.cjs 就是查这个的；这条注释在 2026-10-08 因写了反引号真的踩过一次。 */
.cm-content .cm-line.mp-code.mp-quote,
.cm-content .cm-line.mp-code.mp-quote[data-mp-n] {
  border-left: 3px solid var(--mp-quoteBar);
  background: var(--mp-codeBg);
  color: var(--mp-fg);
}
/* 表格投影（telari：表头底 capsule、边框 border、斑马行 evenRow、8/16 padding）；
 * 行级 widget：table-layout fixed＋colgroup 比例列宽（各行列宽一致＝视觉对齐） */
.mp-table-wrap { margin: 0; padding: 0; overflow-x: auto; }
table.mp-row { table-layout: fixed; width: 100%; border-collapse: collapse; }
table.mp-row th, table.mp-row td { border: 1px solid var(--mp-border); padding: 8px 16px; text-align: left; overflow: hidden; }
table.mp-row th { background: var(--mp-capsule); font-weight: 500; }
/* 格内编辑覆盖层（body 挂载，观察器免疫；固定定位**贴合**活动格；只放源码原文，不再做格内预览） */
/* 编辑面真图：不超宽、行内块、未加载时留最小占位（避免行高跳动） */
.mp-img { display: inline-block; max-width: 100%; vertical-align: middle; }
/* 【对齐·对标 2.x】<img … data-typora-align> ⇒ 居中/右对齐。
   注意：**不能**给 wrapper 设 display:block + auto margin —— span 在行内上下文里会撑成整行宽
   （实测 wrapper 822px 全宽、图还在左边）。正解：wrapper 保持行内，让**父行**对齐（:has 选择器）。 */
.mp-img.is-center, .mp-img.is-right { display: inline-block; }
.cm-line:has(> .mp-img.is-center) { text-align: center; }
.cm-line:has(> .mp-img.is-right) { text-align: right; }
/* 【task-12】失败/加载中的可见占位：最小高度 + 破损标记 + 原因 + 完整 URL（可选中复制）。
   不透明实底，暗亮两主题都用既有 token。⚠️ 本注释在 CSS 模板体内，不许出现反引号。 */
.mp-img.is-loading { min-height: 22px; }
.mp-img.is-failed { min-height: 22px; }
.mp-img.is-failed > img { display: none; }
.mp-img.is-failed.is-stale > img:not(.mp-img-pending) { display: inline; }
.mp-img .mp-img-pending { position: absolute; left: -10000px; opacity: 0; pointer-events: none; }
.mp-img-retained { display: block; width: 100%; box-sizing: border-box; line-height: 1.8; }
.mp-img-retained.is-center { display: block; text-align: center; }
.mp-img-retained.is-right { display: block; text-align: right; }
.mp-image-payload { color: var(--mp-muted); border: 1px solid var(--mp-border); border-radius: 3px; padding: 0 4px; cursor: pointer; }
.mp-img .mp-img-fallback {
  display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 6px; max-width: 100%;
  padding: 6px 10px; border: 1px dashed var(--mp-border); border-radius: 6px;
  background: var(--mp-codeBg); color: var(--mp-muted); font-size: 12px; line-height: 1.5;
  user-select: text; cursor: text;
}
.mp-img .mp-img-broken { filter: grayscale(1); opacity: .75; }
.mp-img .mp-img-why { white-space: nowrap; }
.mp-img .mp-img-url {
  font-family: var(--mp-font-mono); font-size: 11px; color: var(--mp-fg);
  word-break: break-all; flex: 1 1 100%; user-select: text;
}

.mp-img img { max-width: 100%; border-radius: 4px; background: var(--mp-capsule); min-height: 18px; }
/* 【1.13】属主用 {width=… height=…} 指定了尺寸时，height 属性必须生效 ——
   改前这里恒写 height: auto，把指定的 height 覆盖掉（实测：指定 48 却渲染成 128）。
   只在**没有** height 属性时才 auto（保持普通图的等比缩放）。 */
.mp-img img:not([height]) { height: auto; }
/* 【3.8 / 1.16】格内投影出来的行内代码与图片（cellHTML 产出，见该函数注释） */
.mp-cell-code { font-family: var(--mp-font-mono); background: var(--mp-capsule); border-radius: 3px; padding: 0 3px; }
.mp-cell-img { max-width: 100%; max-height: 160px; vertical-align: middle; border-radius: 3px; }
.mp-cell-overlay { position: fixed; display: none; background: transparent; border: 0; padding: 8px 16px; z-index: 30; box-sizing: border-box; outline: none; min-width: 40px; overflow: visible; }
.mp-cell-overlay-text { outline: none; white-space: pre-wrap; word-break: break-all; min-height: 1.3em; }
.mp-cell-layout { display: grid; min-width: 0; visibility: hidden; pointer-events: none; user-select: none; }
.mp-cell-layout > div { grid-area: 1 / 1; min-width: 0; align-self: center; }
.mp-cell-source-size { white-space: pre-wrap; word-break: break-all; min-height: 1.3em; }
.mp-cell-editing { outline: 1px solid color-mix(in srgb, var(--mp-primary) 45%, transparent); outline-offset: -1px; }
/* 【β2 表格工具栏】浮在表格上方空行里，不占排版流（出现/消失时正文与表格一个像素都不动）。
   z-index 48 = 盖住格编辑覆盖层(30)、被右键菜单(60)/补全(50)盖住；表面语言与工具岛同源（不写死色值）。
   【⑥ 实底不透明·2026-10-08】用户实测：条是半透明浮层，表格内容从底下透出来 ⇒ 观感"条压住了表头"。
   原写法是 color-mix(--mp-bg 掺 --mp-surface-alpha 76%, transparent) 再加 backdrop-filter: blur()：
   那是**顶部工具岛**的可调透明度（用户可在设置里调到 20%）；表格条贴着表格边缘，半透必然读成"盖住内容"。
   故本条的底色**恒为实底**（同源 token --mp-bg，只是不掺 alpha）、**去掉一切 backdrop-filter**。
   ⚠️ 本注释不许出现反引号：它就在注入 CSS 的模板体内，一个反引号会把模板提前结束、样式静默失效
      （2026-10-08 我在这一条注释上连踩两次，都是 guard-css-template.cjs 立刻抓出来的）。 */
/* 【表格浮动条·2026-10-09 用户要求】三条一起改：
   ① 更小：高度 34px→22px、字号 13→11px、内距收紧（不再压住表头文字）；
   ② 底色走 --mp-table-bar-alpha（透明度进设置，默认 88%）；
   ③ 定位优先落在**表头上方**（见 tableBarPlace 的分支）。
   ⚠ 本注释在注入 CSS 的模板体内，不许出现反引号。 */
.mp-table-bar { position: absolute; z-index: 48; display: flex; align-items: center; justify-content: space-between;
  gap: 4px; box-sizing: border-box; height: 22px; padding: 0 5px; border-radius: 6px;
  background: color-mix(in srgb, var(--mp-bg) var(--mp-table-bar-alpha, 88%), transparent);
  backdrop-filter: blur(4px);
  border: 1px solid var(--mp-border); color: var(--mp-fg); }
.mp-table-bar-l, .mp-table-bar-r { display: flex; align-items: center; gap: 4px; }
.mp-table-bar .mp-table-bar-item { background: transparent; border: 0; color: inherit; cursor: pointer;
  font: inherit; font-size: 11px; line-height: 1; padding: 2px 4px; border-radius: 4px; }
.mp-table-bar .mp-table-bar-item svg { width: 12px; height: 12px; }
.mp-table-bar .mp-table-bar-item:hover { background: color-mix(in srgb, var(--mp-primary) 18%, transparent); }
.mp-table-bar .mp-table-bar-item.is-active { background: color-mix(in srgb, var(--mp-primary) 30%, transparent); }
/* 【β1 选择层级】行/列/整表高亮：原生选区在表格源码行上不可见（整行被 block widget 替换）⇒ 自己画。
   色值全部由主题变量派生（--mp-primary），不写死色值。 */
table.mp-row tr.mp-sel-row > th, table.mp-row tr.mp-sel-row > td { background: color-mix(in srgb, var(--mp-primary) 16%, transparent) !important; }
table.mp-row td.mp-sel-col, table.mp-row th.mp-sel-col { background: color-mix(in srgb, var(--mp-primary) 13%, transparent) !important; }
.mp-table-wrap.mp-sel-table { outline: 2px solid color-mix(in srgb, var(--mp-primary) 55%, transparent); outline-offset: -2px; border-radius: 3px; }
/* 补全菜单（数学命令 / 块片段）：色值全部由主题变量派生，深浅与用户自带主题自适应 */
.mp-complete { position: fixed; z-index: 50; min-width: 200px; max-height: 264px; overflow-y: auto;
  background: var(--mp-bg); border: 1px solid var(--mp-border); border-radius: 6px; padding: 4px;
  box-shadow: 0 6px 20px color-mix(in srgb, var(--mp-fg) 22%, transparent); }
.mp-complete-item { display: flex; gap: 10px; align-items: baseline; padding: 3px 8px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
.mp-complete-item .k { font-family: var(--mp-font-mono); color: var(--mp-primary); min-width: 96px; }
.mp-complete-item .d { color: var(--mp-muted); font-size: 12px; }
.mp-complete-item.is-active { background: color-mix(in srgb, var(--mp-primary) 16%, transparent); }
/* 工具栏（顶部固定条；CM6 未实现的按钮置灰，悬停标注原因）。
 * 换行而非横向滚动：面板可能只有 600px 宽，35 个按钮必须全在视野里（用户要求"全摆上"）；
 * 高度由 ResizeObserver 写进 --mp-toolbar-h，正文 padding-top 随之联动（不遮正文）。 */
/* 工具栏岛（同 v2.3.3 观感）：**样式只在这一处定义**（extras 里不许再写一份，否则两条规则打架、
   实测出现"看着是通栏方角"的假绿）。岛＝内容宽 + 水平居中 + 两端半圆 + 半透明毛玻璃 + 投影。
   【表面 token 层·架构级】不透明度与模糊**不是写死在规则里的字面量**，而是两个 token：
     --mp-surface-alpha / --mp-surface-blur
   消费者：工具栏（本规则）+ 更多→界面透明度（设置面板写这两个 token）+ 将来的其它浮层。
   色相仍由 --mp-bg 派生（不写死颜色）。与浮动预览的 --mp-float-alpha/-blur 是同一设计范式。 */
:root {
  --mp-surface-alpha: 0.76; --mp-surface-blur: 10px; --mp-toolbar-fold: 35px;   /* 折叠圆岛直径：44 的 80%（用户要求缩小） */
  /* 公式预渲染框的表面 token（原先写死在 .mp-inline-float 规则里 ⇒ 设置面板改不动它）。
     提到 :root 后与工具岛同一范式：一个消费者一组 token，设置面板逐项写、互不捆绑。 */
  --mp-float-alpha: 65%; --mp-float-blur: 7px;
}
.mp-toolbar { position: fixed; top: 6px; left: 12px; right: 12px; z-index: 45;
  display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 1px;
  /* 【真·岛·2026-10-07 实锤】只写 left/right:12 + width:auto 是**通栏**（左右各留 12px 的长条），不是岛。
     收敛样式时把 fit-content ＋ margin:auto 删掉，外观就悄悄退化成通栏——而"左右缝 12/12 ＋ 圆角 999px"
     这两种形态**都成立**，所以那把验收尺子报了假绿。岛＝内容宽（fit-content）＋左右 auto 外边距等分剩余空间。 */
  width: fit-content; max-width: calc(100% - 24px); margin-inline: auto; overflow: hidden;
  box-sizing: border-box; padding: 3px 12px; border-radius: 999px;
  background: color-mix(in srgb, var(--mp-bg) calc(var(--mp-surface-alpha) * 100%), transparent);
  -webkit-backdrop-filter: blur(var(--mp-surface-blur)) saturate(1.25); backdrop-filter: blur(var(--mp-surface-blur)) saturate(1.25);
  border: 1px solid var(--mp-border);
  box-shadow: 0 6px 20px color-mix(in srgb, var(--mp-fg) 22%, transparent);
  /* 收起/展开动画：只动外壳属性（width/height/padding/圆角）＋子项淡出，**由用户点击触发**（一次 220ms），
     不在键入路径上 ⇒ 不违反"无新增每键 O(整篇)"。interpolate-size 让 fit-content/auto ↔ 44px 也能插值
     （Chromium 129+，本机 Electron 33＝Chromium 130）；不支持的宿主退化为瞬跳，功能不受影响。 */
  interpolate-size: allow-keywords;
  /* 折叠时整体飞向**右边**（用户要求：小圆别摆中间挡正文）。这里不改布局锚点（left/right/auto 外边距
     全程保持居中），只叠一段 transform —— 好处是"包裹宽度"与"横向位移"两条都是可插值属性，
     收起/展开两头都不会跳位。位移量由 JS 按 clientWidth 精确算（不含滚动条），见 toolbar.js setFolded。 */
  transform: translateX(var(--mp-fold-shift, 0px));
  transition: width .22s cubic-bezier(.22,.61,.36,1), height .22s cubic-bezier(.22,.61,.36,1),
              padding .22s cubic-bezier(.22,.61,.36,1), border-radius .22s cubic-bezier(.22,.61,.36,1),
              transform .22s cubic-bezier(.22,.61,.36,1); }
/* 滚动条（前沿编辑器口径：细、圆角、低对比、悬停提亮、无轨道底色、稳定槽位不跳版）
   为什么不是一条补丁：滚动条是**表面系统**的一部分——所有可滚面板（正文、弹层、大纲、对话框）
   共用同一套 token 化外观；色相由 --mp-fg 派生（不写死颜色），因此任何主题都自动跟随。
   用 scrollbar-gutter:stable 保证滚动条出现/消失时正文不横跳（与工具栏岛同一"不改排版流"纪律）。 */
/* 大纲停靠模式（「设置」里可选左/右）：编辑容器变 flex，编辑器让位出一列；两种外壳共用同一份
   大纲数据与同一套跳转偏移。**版心公式必须同时切换**——停靠后编辑器不再是整视口宽，继续按 100vw
   算会把正文推偏（这是"动版面"最容易踩的一处）。 */
.mp-dock-host { display: flex; align-items: stretch; }
.mp-dock-host > .cm-editor { flex: 1 1 auto; min-width: 0; }
[data-mp-dock="left"] .cm-content, [data-mp-dock="right"] .cm-content {
  padding-left: max(46px, calc((100% - 1280px) / 2)) !important;
  padding-right: max(28px, calc((100% - 1280px) / 2)) !important; }
.mp-outline-dock { flex: 0 0 var(--mp-dock-width, 232px); overflow: auto; box-sizing: border-box;
  /* 与工具岛/浮层同一套表面语言：圆角 ＋ 细边框 ＋ 半透明毛玻璃 ＋ 主题派生投影。
     参数与浮层**共用**同一组 token（--mp-outline-alpha / --mp-outline-blur），在
     「设置 → 界面透明度 → 大纲面板」一项里同时管两种外壳。 */
  margin: calc(var(--mp-toolbar-h, 32px) + 8px) 8px 8px 8px; padding: 8px 6px 20px;
  background: color-mix(in srgb, var(--mp-bg) var(--mp-outline-alpha, 78%), transparent);
  -webkit-backdrop-filter: blur(var(--mp-outline-blur, 10px)) saturate(1.15); backdrop-filter: blur(var(--mp-outline-blur, 10px)) saturate(1.15);
  border: 1px solid var(--mp-border); border-radius: 10px;
  box-shadow: 0 8px 28px color-mix(in srgb, var(--mp-fg) 22%, transparent);
  color: var(--mp-fg); font: 13px/1.6 var(--mp-font-body); }

/* ── 阅读模式（骨架）────────────────────────────────────────────────────────
 * 只改呈现：藏工具栏岛与 H 徽标、隐光标、行距加宽、版心收窄到 780px；出口＝右上角胶囊 ＋ Esc
 * （工具栏在阅读态是隐藏的，所以必须留一条看得见的出口）。配色另由 reading-palette 用行内 token 覆盖。
 * KP（Knuth-Plass）留作第二步：骨架不引入任何断行算法，故不与"无新增每键 O(整篇)"冲突。 */
[data-mp-reading="1"] .mp-toolbar, [data-mp-reading="1"] .mp-table-bar, [data-mp-reading="1"] .mp-pop:not(.mp-pop-keep) { display: none !important; }
/* 【例外·2026-10-08】「更多」菜单在阅读态里必须能开：三档阅读配色就住在它里面
   （用户要求把「阅读调色盘」收进菜单）。改前 .mp-pop 被一并隐藏 ⇒ 进阅读模式后点开菜单
   是**空的一下**（pop 的 rect 全 0），既看不到当前档也切不了档。
   只放行"更多"这一只（.mp-pop-keep），其余浮层在阅读态照旧隐藏。 */
[data-mp-reading="1"] .cm-editor:not(.mp-split-source) .cm-content { max-width: 780px !important; margin: 0 auto !important;
  padding: 56px 28px 40vh !important; font-size: 16px !important; line-height: 1.95 !important;
  /* 阅读态才要的两条：strict 收紧行首行尾禁则；justify 让中文两端对齐（编辑态不给，避免光标/选区手感变化） */
  line-break: strict !important; text-align: justify !important; }
[data-mp-reading="1"] .cm-editor:not(.mp-split-source) .cm-line[class*="mp-h"]::before { display: none; }
[data-mp-reading="1"] .cm-editor:not(.mp-split-source) .cm-content * { -webkit-text-stroke-width: 0 !important; }
[data-mp-reading="1"] .cm-editor:not(.mp-split-source) .cm-cursor, [data-mp-reading="1"] .cm-editor:not(.mp-split-source) .cm-dropCursor { display: none; }
.mp-reading-exit { position: fixed; right: 12px; top: 12px; z-index: 60; display: none; align-items: center;
  padding: 6px 12px; border-radius: 999px; cursor: pointer; font: 12px var(--mp-font-body); color: var(--mp-fg);
  background: color-mix(in srgb, var(--mp-bg) calc(var(--mp-surface-alpha) * 100%), transparent);
  -webkit-backdrop-filter: blur(var(--mp-surface-blur)) saturate(1.25); backdrop-filter: blur(var(--mp-surface-blur)) saturate(1.25);
  border: 1px solid var(--mp-border); box-shadow: 0 6px 20px color-mix(in srgb, var(--mp-fg) 22%, transparent); }
[data-mp-reading="1"] .mp-reading-exit { display: inline-flex; }
/* 【排版美化·2026-10-09】阅读模式右上角那一簇：**排版方式开关** + 退出胶囊。
 *  "不挡阅读位置"的做法：整簇 fixed 在**视口右上角**（正文列是居中的，右上角在列外）；
 *  容器 pointer-events:none、只有按钮自己 auto（簇里多余的区域不挡点击）；纵向排列、不压正文行。 */
.mp-read-cluster { position: fixed; right: 12px; top: 12px; z-index: 61; display: none; flex-direction: column;
  align-items: flex-end; gap: 8px; pointer-events: none; }
[data-mp-reading="1"] .mp-read-cluster { display: flex; }
.mp-read-cluster > * { pointer-events: auto; }
.mp-typography-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px;
  cursor: pointer; font: 12px var(--mp-font-body); color: var(--mp-fg);
  background: color-mix(in srgb, var(--mp-bg) calc(var(--mp-surface-alpha) * 100%), transparent);
  -webkit-backdrop-filter: blur(var(--mp-surface-blur)) saturate(1.25); backdrop-filter: blur(var(--mp-surface-blur)) saturate(1.25);
  border: 1px solid var(--mp-border); box-shadow: 0 6px 20px color-mix(in srgb, var(--mp-fg) 22%, transparent); }
.mp-typography-btn:hover { border-color: var(--mp-primary); }
.mp-typography-btn .k { opacity: .72; margin-left: 2px; }
/* 阅读模式下 .mp-reading-exit 由簇接管定位（不再各自 fixed） */
[data-mp-reading="1"] .mp-read-cluster .mp-reading-exit { position: static; }
/* Knuth–Plass 断行产物：**行内**内容 + br 断行（行盒模型与普通段落一致；块级子元素那条路实测
   会多撑一层 leading、把行高设成 0 又会压塌，见 KpWidget.toDOM 的注释）。
   【写作纪律】本段是**模板字符串**，注释里不许出现反引号（会提前结束字符串）——已踩三次，务必记住。 */
.mp-kp-para { display: inline; white-space: pre-wrap; }
.cm-scroller { scrollbar-gutter: stable; }
.cm-scroller::-webkit-scrollbar, .mp-pop::-webkit-scrollbar, .mp-outline::-webkit-scrollbar, .mp-outline-dock::-webkit-scrollbar, .mp-dlg::-webkit-scrollbar { width: 10px; height: 10px; background: transparent; }
.cm-scroller::-webkit-scrollbar-track, .mp-pop::-webkit-scrollbar-track, .mp-outline::-webkit-scrollbar-track, .mp-outline-dock::-webkit-scrollbar-track, .mp-dlg::-webkit-scrollbar-track { background: transparent; }
.cm-scroller::-webkit-scrollbar-thumb, .mp-pop::-webkit-scrollbar-thumb, .mp-outline::-webkit-scrollbar-thumb, .mp-outline-dock::-webkit-scrollbar-thumb, .mp-dlg::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--mp-fg) 24%, transparent); border-radius: 999px;
  border: 2px solid transparent; background-clip: padding-box; }
.cm-scroller::-webkit-scrollbar-thumb:hover, .mp-pop::-webkit-scrollbar-thumb:hover, .mp-outline::-webkit-scrollbar-thumb:hover, .mp-outline-dock::-webkit-scrollbar-thumb:hover, .mp-dlg::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--mp-fg) 44%, transparent); background-clip: padding-box; }
.cm-scroller::-webkit-scrollbar-corner, .mp-pop::-webkit-scrollbar-corner, .mp-outline::-webkit-scrollbar-corner, .mp-outline-dock::-webkit-scrollbar-corner, .mp-dlg::-webkit-scrollbar-corner { background: transparent; }
/* 折叠态＝**小圆岛**（直径 --mp-toolbar-fold），只留折叠按钮本身；其余项直接不参与布局，
   外壳宽度由 width/max-width 驱动 ⇒ 宽度动画平滑（子项消失不会让宽度瞬跳）。 */
.mp-toolbar.is-folded { width: var(--mp-toolbar-fold); max-width: var(--mp-toolbar-fold); height: var(--mp-toolbar-fold);
  padding: 0; flex-wrap: nowrap; justify-content: center; align-items: center; }
.mp-toolbar.is-folded .mp-tb-item:not(.mp-tb-fold) { display: none; }
.mp-toolbar.is-folded .mp-tb-sep { display: none; }
.mp-tb-item { flex: 0 0 auto; width: 26px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 4px; background: transparent; color: var(--mp-fg); cursor: pointer; opacity: .82; padding: 0;
  transition: opacity .18s ease, transform .18s ease, background-color .12s ease; }
.mp-tb-item:hover:not(:disabled) { background: color-mix(in srgb, var(--mp-primary) 16%, transparent); opacity: 1; }
.mp-tb-item.is-todo { opacity: .3; cursor: not-allowed; }
.mp-tb-sep { flex: 0 0 auto; width: 1px; height: 16px; margin: 0 5px; background: var(--mp-border); }
/* 顶部工具栏占位（高度动态，见 --mp-toolbar-h） */
.cm-content { padding-top: calc(var(--mp-toolbar-h, 32px) + 2px) !important; }
/* 选区/活动行/补全观感 */
.cm-selectionBackground, .cm-content ::selection { background: var(--mp-sel) !important; }.cm-activeLine { background: color-mix(in srgb, var(--mp-fg) 3%, transparent); }
.cm-gutters { background: transparent; color: var(--mp-faint); border: none; }
.cm-activeLineGutter { color: var(--mp-muted); }

/* ══ 版心宽度（设置项「页面宽度」）══════════════════════════════════════════════════
   只作用于**正文内容**：.cm-content 居中 + max-width；工具栏（body 上的固定定位）与状态栏
   完全不在这个盒子里，宽度/缩放都不受影响。数值由 JS 按「窗口宽 × 百分比 ÷ 缩放」算成
   文档坐标像素写进 --mp-page-width（zoom 的百分比按未缩放父盒解析，见 applyEnginePrefs 注释）。 */
.mp-zoom-wrap { width: 100%; height: 100%; }
/* The fixed footer sits outside content zoom. Reserve its actual viewport space
   so it cannot cover the native scrollbar's bottom hit target. */
html[data-mp-statusbar="1"] .mp-zoom-wrap { height: calc(100% - 24px); }
/* 版心（正文列）＝ max(1240px, 视口−320px)，居中：与「页面宽度」设置叠加时取更窄的那个。
   左内边距 24px 是**引用框的落位留白**（3px 竖条 + 呼吸）：引用行把方框画进这段留白里，
   ⇒ 引用框与选中高亮都不会越过正文列、也不会挤窄正文。
   （导出件的版心常量仍是 1280/46，与本条无关：那条链在 typography.js。） */
.cm-scroller > .cm-content {
  --mp-measure: max(1240px, calc(100% - 320px));
  max-width: min(var(--mp-page-width, 100%), var(--mp-measure));
  margin-inline: auto !important;
  padding-left: 24px !important;
  padding-right: 24px !important;
}
/* 阅读模式自己那套版心（780px）优先级更高，保持原样；状态栏不参与缩放 */

/* ══ 引用区：竖条 + 零宽标记占位（选区高亮口径见 scanInlineMarks / QuoteMarkWidget）══
   --mp-q-inset 是引用**方框**相对文本列的左移量：竖条与底色都从它起算。
   --mp-q-pad 是竖条到引用文字的呼吸位（1–3 层同为 .8em，与改前逐像素一致：0.8×12.6=10.08px）。
   每层再叠「本行前缀的视觉缩进」（d2 = 1em + 前缀字形宽，d3 = 2em + 前缀字形宽），
   于是"被隐藏的 > 原来占的那段宽度"由前缀字符自己的宽度补回来——文字横向位置零跳变。
   --mp-q-inset 是引用**方框**相对正文列的左移量：竖条与底色都从它起算。默认 0：
   正文列自己已经预留了 16px 左内边距（见 .cm-scroller > .cm-content），引用框就落在这段留白里，
   于是**引用框内外都在正文列之内**、文字位置与改前逐像素一致，选中时高亮从框左端起连续覆盖。
   （踩过的两条路：inset=0 且不留白 ⇒ 框比文字列宽 10.08px，高亮从文字起画、左侧空一块；
   用负外边距把框推出去 ⇒ 框反而越过正文列、底色画到正文列外面。） */
:root { --mp-q-inset: 0px; --mp-q-pad: .8em; }
.cm-content .cm-line.mp-quote {
  background: none;   /* 底色改由 ::before 画，见下（否则盖住选区层）*/
  position: relative;
  border-left: 3px solid var(--mp-quoteBar);
  color: var(--mp-muted);
  font-size: 90%;
  /* 【引用块的左右轴·2026-10-08】行盒左边距 = **引用框留白**（--mp-q-inset）：
     竖条左缘落在「正文列左缘 + 留白」这条轴上，与正文文字列、表格首列同一竖轴；
     宽度补回 3px（竖条自身宽），padding-left 再补 3px ⇒ **文字横向位置逐像素不变**
     （改前留的是负的 (.8em + inset)，多左移 10.08px ⇒ 引用框比正文列凸出一截，选中高亮也跟着凸）。 */
  margin-left: var(--mp-q-inset, 0px);
  width: calc(100% + 3px);
  box-sizing: border-box;
  padding-left: calc(var(--mp-q-pad, .8em) + 3px);
}
/* 【引用区选中高亮·2026-10-09 用户要求】行元素上的不透明底色会把 CM6 的选区层（z-index:-1）盖住
   ⇒ 引用区里选中"看着没高亮"。底色挪到伪元素并放到 -2：选区层（-1）在它之上、文字在更上层，
   视觉与"先画底色、再画选区、最后画字"一致；引用块的边框/内距仍留在行元素上，横轴逐像素不变。 */
.cm-content .cm-line.mp-quote::before { content: ""; position: absolute; inset: 0; z-index: -2;
  background: var(--mp-quoteBg); pointer-events: none; }
.cm-content .cm-line.mp-quote-d2 { padding-left: calc(var(--mp-q-pad, .8em) + 3px + 1em); }
.cm-content .cm-line.mp-quote-d3 { padding-left: calc(var(--mp-q-pad, .8em) + 3px + 2em); font-size: 85%; }
/* One quote surface and font base for direct block projections of every kind. */
.cm-content .mp-region-container { margin-inline-start: var(--mp-region-indent, 0ch); }
.cm-content .mp-region-container.mp-container-quote {
  position: relative; background: none; border-left: 3px solid var(--mp-quoteBar);
  color: var(--mp-muted); font-size: 90%; margin: 0;
  width: calc(100% + 3px); box-sizing: border-box;
  padding-left: calc(var(--mp-q-pad, .8em) + 3px + var(--mp-region-depth, 0) * 1em + var(--mp-region-indent, 0ch));
}
.cm-content .mp-region-container.mp-container-quote::before {
  content: ''; position: absolute; inset: 0; z-index: -2; background: var(--mp-quoteBg); pointer-events: none;
}
.cm-content .mp-region-container.mp-container-quote[data-mp-quote-level='3'] { font-size: 85%; }
/* 零宽占位：DOM 里存在（选区盒子因此连续），但一个像素都不占 */
.mp-qmark { display: inline-block; width: 0; height: 1em; overflow: hidden; opacity: .001; pointer-events: none; vertical-align: baseline; }
/* 【mermaid 图表块·2026-10-11】整块（含两侧围栏）被 replace 成这个盒子：居中、限宽、随主题底色，
   内部 SVG 由 mermaid 自带的内联 style 负责配色（主题通过 initialize 的 theme 给）。
   ⚠️ 本注释在 CSS 模板字符串体内，**不许出现反引号**。 */
.mp-mermaid { display: block; padding: 8px 0 12px; text-align: center; overflow-x: auto; }
.mp-mermaid svg { max-width: 100%; height: auto; }
.mp-mermaid[data-mp-mermaid]:empty::after { content: 'mermaid 图表（渲染中…）'; color: var(--mp-muted); font-size: 12px; }
/* 【下划线 u 标签·2026-10-11 已落地】标签由 scanInlineMarks 的 hides（零宽 replace ✓）收掉，
   内文由下面这条类加下划线 ✓ —— 两者作用在不同字符上，互不干扰 ✓。
   .mp-u-tag **已废弃**（曾用于"把标签收成零宽"的旧方案 ✗，实测会留游离字形 ✗）⇒ 已删除 ✓，
   避免以后有人照着它再走一遍弯路 ✓。
   ⚠️ 本注释在 CSS 模板字符串体内，**不许出现反引号**（这是第五次踩了，写注释前先自查 ✓）。 */
.mp-u { text-decoration: underline; text-underline-offset: .18em; text-decoration-thickness: .06em; }

/* ══ 引用区里的表格（widget 是整行块级替换 ⇒ 行类失效，竖条与缩进必须在这里补齐）══════
   padding-left 由 widget 按「--mp-q-inset + --mp-q-pad + 层级缩进 + 本行前缀字宽」内联写入。 */
.mp-table-wrap.mp-table-quote {
  border-left: 3px solid var(--mp-quoteBar);
  background: var(--mp-quoteBg);
  box-sizing: border-box;
}
.mp-table-wrap.mp-table-quote table.mp-row th,
.mp-table-wrap.mp-table-quote table.mp-row td { color: var(--mp-muted); background: transparent; }
.mp-table-wrap.mp-table-quote table.mp-row th { background: color-mix(in srgb, var(--mp-capsule) 70%, transparent); }

/* ══ 内容缩放：只影响正文与公式/表格，绝不作用于工具栏岛与状态栏 ══════════════════════
   注意 zoom 放在 .cm-editor 上（而不是 body）：工具栏是 body 的子元素、fixed 定位，
   天生在缩放盒之外 ⇒ 岛的大小与位置与缩放完全解耦（这正是用户要的）。 */
.cm-editor { zoom: var(--mp-zoom, 1); }

/* ══ 工具岛尺寸（设置项，与缩放解耦）════════════════════════════════════════════════
   岛自己 zoom 一档：按钮、内边距、圆角、小圆岛直径、投影全部按同一比例走；
   正文只关心它的视觉高度（--mp-toolbar-h 由 rect 量得，见 toolbar.js sync）。 */
.mp-toolbar { zoom: var(--mp-island-scale, 1); }

/* ══ 底部状态栏（v2.3.3 观感）══════════════════════════════════════════════════════ */
html[data-mp-statusbar="0"] .mp-statusbar { display: none; }
.mp-statusbar {
  position: fixed; left: 0; right: 0; bottom: 0; height: 24px; z-index: 46;
  display: flex; align-items: center; gap: 12px; padding: 0 12px; box-sizing: border-box;
  font: 11.5px/1 var(--mp-font-body); color: var(--mp-muted);
  background: color-mix(in srgb, var(--mp-bg) calc(var(--mp-surface-alpha) * 100%), transparent);
  -webkit-backdrop-filter: blur(var(--mp-surface-blur)) saturate(1.15); backdrop-filter: blur(var(--mp-surface-blur)) saturate(1.15);
  border-top: 1px solid var(--mp-border);
  pointer-events: none;                      /* 空白处点击穿透到正文（右空白回车照旧可用） */
  user-select: none;
  transition: opacity .2s ease;
}
.mp-statusbar .mp-sb-item { white-space: nowrap; }
.mp-statusbar .mp-sb-spacer { flex: 1 1 auto; }
.mp-statusbar .mp-sb-sel { color: var(--mp-primary); min-width: 0; }
.mp-statusbar .mp-sb-brand { opacity: .6; letter-spacing: .04em; }
.mp-statusbar .mp-sb-zoomwrap { display: inline-flex; align-items: center; gap: 4px; pointer-events: auto; }
.mp-statusbar .mp-zoom-badge {
  cursor: text; padding: 2px 7px; border-radius: 999px; border: 1px solid transparent;
  color: var(--mp-fg); font-family: var(--mp-font-mono); font-size: 11px; opacity: .82;
  transition: opacity .15s ease, border-color .15s ease, background-color .15s ease;
}
.mp-statusbar .mp-zoom-badge:hover { opacity: 1; border-color: color-mix(in srgb, var(--mp-primary) 55%, transparent); }
.mp-statusbar .mp-zoom-badge.is-live { opacity: 1; border-color: var(--mp-primary); background: color-mix(in srgb, var(--mp-primary) 14%, transparent); }
.mp-statusbar .mp-sb-zoom-input {
  display: none; width: 46px; box-sizing: border-box; text-align: right;
  background: var(--mp-codeBg); color: var(--mp-fg); border: 1px solid var(--mp-primary);
  border-radius: 4px; padding: 1px 5px; font: 11px var(--mp-font-mono); outline: none;
}
.mp-statusbar.is-editing .mp-sb-zoom-input { display: inline-block; }
.mp-statusbar.is-editing .mp-zoom-badge { display: none; }
.mp-statusbar .mp-sb-pct { display: none; cursor: text; opacity: .8; }
.mp-statusbar.is-editing .mp-sb-pct { display: inline; }
/* 正文给状态栏让位：滚动区底部呼吸位加到 24px（只在状态栏开着时） */
html[data-mp-statusbar="1"] .cm-scroller { padding-bottom: 24px !important; }
/* 顶部提示条避让（导出 PDF 进度等复用 #mp-banner，宿主页在 iframe 外面，这里只管引擎自己的 toast 层） */
html[data-mp-statusbar="1"] .mp-pop { bottom: 24px; }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
})();

/* ── dream-skin 基调的 CM6 主题（克制、清透：低饱和冷灰蓝 + 单强调色） ── */

/* Telari 版式基线（字体/颜色/版心由注入 CSS 承担；这里只留 CM6 结构性样式） */
const themeVars = EditorView.theme({
  "&": { height: "100%", fontSize: "14px", color: "var(--mp-fg)", backgroundColor: "var(--mp-bg)" },
  ".cm-scroller": {
    fontFamily: "var(--mp-font-body)", lineHeight: "1.8", letterSpacing: "0",
    overflow: "auto", padding: "16px 0 24px 0", backgroundColor: "var(--mp-bg)",
  },
  ".cm-content": { caretColor: "var(--mp-primary)" },
  /* 【A3-D12/A7-D9】CM6 基主题给 .cm-line 6px/2px 内边距＝正文全局右移 6px
   * （标题因行类遮蔽不显）——清零对齐 vditor 文本列。 */
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--mp-primary)", borderLeftWidth: "2px" },
  /* 2.3.3 观测等价：无行号槽、无活动行带（vditor 皆无） */
  ".cm-gutters": { display: "none" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".mp-cm6-check": { border: "1.5px solid var(--mp-muted)" },
  ".mp-cm6-check:checked": { borderColor: "var(--mp-primary)", color: "var(--mp-primary)" },
}, { dark: false });

/* 语义高亮：lezer tag → 主题变量色（井号、星号、尖括号等源码标记弱化为冷灰——flash 实测旧版与正文同黑） */
/* 语义高亮：字号/字重/衬线由行级类（mp-h1..h6/strong/em）承担；这里只管
 * 语法着色（标记弱化、链接主色、行内代码胶囊、删除线）——telari 语法梯子。 */
const mdHighlight = HighlightStyle.define([
  /* strong/em 走 tag 规则（CM6 产 span 不产 strong/em 元素——CSS 元素选择器打不中） */
  { tag: t.strong, fontWeight: "900", WebkitTextStroke: ".015em currentColor", fontFamily: "var(--mp-type-bold, inherit)" },
  { tag: t.emphasis, ...editorKaiStyle() },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--mp-primary)", textDecoration: "none" },
  { tag: t.url, color: "var(--mp-muted)", fontSize: "0.92em" },
  { tag: [t.processingInstruction, t.meta], color: "var(--mp-faint)" },
  { tag: t.quote, color: "var(--mp-muted)" },
  { tag: t.monospace, fontFamily: "var(--mp-type-code, var(--mp-font-mono))", background: "var(--mp-codeBg)", borderRadius: "3px", padding: "0.15em 0.3em", fontSize: "0.9em" },
  /* 代码围栏语法梯子（telari 六级，2.3.3 hljs 对齐） */
  { tag: t.keyword, color: "var(--mp-kw)" },
  { tag: t.string, color: "var(--mp-str)" },
  { tag: t.comment, color: "var(--mp-com)" },
  { tag: [t.literal, t.number], color: "var(--mp-num)" },
  { tag: [t.typeName, t.className], color: "var(--mp-typ)" },
  { tag: [t.atom, t.bool], color: "var(--mp-num)" },
]);

/* ── 桥（与 vditor 版同契约） ─────────────────────────────── */

const post = (type, content) => {
  try { window.parent.postMessage({ __dshmp: true, dir: "up", type, content }, "*"); } catch { /* 父不在 */ }
};

let view = null;
let documentExtensions = null;
let suppressChange = false;
let composingDirty = false; // IME 组字期间挂起的脏标（compositionend 一笔补发）
let sourceRevision = 0;
const commands = createCommandContext({
  getView: () => view,
  epochOf: v => v.state.field(regionIndexField).epoch,
  owner: () => {
    const active = document.activeElement, edit = cellOverlay?.querySelector('.mp-cell-overlay-text');
    if (cellEdit && active === edit) return { kind: 'cell', edit };
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName || '')) return { kind: 'native' };
    return { kind: view?.hasFocus ? 'cm' : 'none' };
  },
  flushOwner: input => { if (cellEdit && input.edit?.isConnected) syncCellEdit(input.edit); },
  resumeOwner: input => {
    if (input.kind === 'cell' && activateSourceCellSelection(view)) return true;
    view.focus(); return true;
  },
  composing: () => cellComposing || !!view?.composing,
  cancelViewport: v => viewportIntent.cancel(v),
});

// A checkpoint owns the exact CM state, including history and region epoch.
// Its lifetime is one synchronous turn, so a delayed reply cannot restore over
// subsequent user input. Command intent serials and allocated epochs never rewind.
const checkpointViewportMeasureKey = {};
// Restore the checkpoint viewport after CM's whole measure tail (scroll-anchor
// compensation runs after requestMeasure.write). One microtask, no dispatch/timer/align.
function restoreViewportTail(target, ownedState, top, left) {
  const revision = sourceRevision;
  const serial = commands.serial();
  const viewportSerial = viewportIntent.serial(target);
  const valid = () => view === target && target.state === ownedState && sourceRevision === revision && commands.serial() === serial && viewportIntent.serial(target) === viewportSerial && target.dom.isConnected;
  target.requestMeasure({
    key: checkpointViewportMeasureKey,
    read: valid,
    write(ok) {
      if (!ok || !valid()) return;
      queueMicrotask(() => {
        if (!valid()) return;
        target.scrollDOM.scrollTop = top;
        target.scrollDOM.scrollLeft = left;
      });
    },
  });
}
function checkpointDocument() {
  const target = view, ticket = commands.capture();
  if (!target || !ticket) return null;
  const state = target.state, revision = sourceRevision, pendingComposition = composingDirty;
  const top = target.scrollDOM.scrollTop, left = target.scrollDOM.scrollLeft;
  let active = true;
  queueMicrotask(() => { active = false; });
  return {
    commit() { if (!active || view !== target) return false; active = false; return true; },
    rollback() {
      if (!active || view !== target) return false;
      active = false; commands.invalidate(); deactivateCellOverlay();
      const suppressed = suppressChange; suppressChange = true;
      let rebuilt = false;
      try { if (target.state !== state) { target.setState(state); rebuilt = true; } }
      finally { sourceRevision = revision; composingDirty = pendingComposition; suppressChange = suppressed; }
      target.scrollDOM.scrollTop = top; target.scrollDOM.scrollLeft = left;
      // Auxiliary view failures cannot prevent restoration of the source state.
      try { window.mpSplit?.mirror(state); } catch (error) { console.error('[document] mirror restore', error); }
      try { scheduleTableChrome(); positionTableBar(); } catch (error) { console.error('[document] chrome restore', error); }
      commands.resume(ticket, { intent: false });
      if (rebuilt) restoreViewportTail(target, target.state, top, left);
      return true;
    },
  };
}

/* ══ β2 表格工具栏（光标入表浮出）══
 *  形态照 Typora 实测（4 槽：▦ 表格菜单 / ≡左 ≡中 ≡右 / ⋮ 更多 / 🗑 删除表格）；
 *  实现纪律（`BETA-UI.md` §2 + `REVIEW-BETA.md` §5 的更正）：
 *   · 装在 `boot()` 里（**不做成 ViewPlugin**）：分屏从视图用最小 state 现场建视图，
 *     做成扩展会让从视图也多一条（B7 的正确红侧是"挪进共享扩展数组"）；
 *   · 按钮一律 `pointerdown + mousedown` 双绑 + `preventDefault`（**不用 click**）：
 *     用 click ⇒ 覆盖层先 blur ⇒ 活动格被清 ⇒ 命令报"光标不在表格内"；
 *     触屏上兼容 mousedown 来得太晚（blur 已经发生）⇒ 必须补 pointerdown，且处理体幂等；
 *   · `tabindex="-1"`：不让正文按 Tab 把焦点甩进悬浮条；
 *   · 定位三规则（贴表头上沿外侧 → 上方不够翻到表格下方 → 表头出视口则隐藏）；
 *     `topLimit` 取**顶部工具岛的真实底沿**（`getBoundingClientRect().bottom`），
 *     不是 token + 4（岛是 `top: 6px`，token 只有高度 ⇒ 少 6px 会盖住岛的下沿）；
 *   · 双开/大纲停靠都不产生事务与滚动 ⇒ 靠 `ResizeObserver(view.dom)` 跟随（两者的几何都变）；
 *   · z-index 48（> 覆盖层 30、< .mp-pop 60 / .mp-complete 50）；阅读模式必须藏。
 *  每键成本：状态键只在既有 updateListener 里算（只读两个 field + 二分），无 DOM 读写；
 *  只有状态键变化时才动 DOM（display / 4 个 class）。 */
let tableBar = null;
let tableBarKey = "";
let tableBarVisible = false;
/* 【C10】仅 source 活跃期间的几何失效缓存：保存 state.doc 的 Text 引用（不可变对象，
   任何 docChanged 必换引用 ⇒ 同长替换/换行改高也能失效），不存整串 source、不存
   hash/docLen/长度替代。source 结束（→null / 目标表消失 / 阅读态）即清回 null；
   无 source 的普通热路径零比较、零扫描。 */
let tableBarSourceText = null;
/** 当前表 + 当前列对齐（只读；活动格优先 —— 点格不落 CM 选区）。 */
function tableBarTarget() {
  if (!view) return null;
  const state = view.state;
  const tables = tableTablesOf(state);
  if (!tables.length) return null;
  const active = state.field(activeCellField, false);
  const rowFrom = active ? active.rowFrom : state.selection.main.head;
  const tb = tables.find((t) => rowFrom >= t.from && rowFrom <= t.to);
  if (!tb) return null;
  let col = active ? active.col : 0;
  if (!active) {
    const line = state.doc.lineAt(state.selection.main.head);
    const ranges = cellRangesOf(line);
    for (let i = 0; i < ranges.length; i++) if (state.selection.main.head >= ranges[i][0]) col = i;
  }
  return { table: tb, col, align: (tb.aligns && tb.aligns[col]) || null, rowFrom: active ? active.rowFrom : tb.headerBlock.from };
}
function ensureTableBar() {
  if (tableBar && tableBar.isConnected) return tableBar;
  const bar = document.createElement("div");
  bar.className = "mp-table-bar";
  bar.style.display = "none";
  const mkBtn = (label, title, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mp-tb-item mp-table-bar-item";
    b.tabIndex = -1;
    b.textContent = label;
    b.title = title;
    b.dataset.mpBar = title;
    let lastFire = 0;
    /* ⚠️ 触屏上**只绑 mousedown 不够**：浏览器在 touchend 之后才补发兼容鼠标事件，而"点空白/按钮"
       引发的焦点转移与 blur 在这之前就发生了 —— 覆盖层 blur ⇒ 活动格被清 ⇒ 命令报"光标不在表格内"。
       所以三条都绑（touchstart 要 passive:false 才能真正 preventDefault），并用 350ms 去重保证幂等
       （pointerdown/mousedown 会跟着 touchstart 一起到；🗑 这类命令绝不能被跑两次）。 */
    const fire = (e) => {
      e.preventDefault(); e.stopPropagation();
      const now = Date.now();
      if (now - lastFire < 350) return;
      lastFire = now;
      captureBarAnchor();     // ⚠️ 必须**先捕获目标**（触屏上 blur 可能紧接着就来）
      fn(b, e);
    };
    b.addEventListener("touchstart", fire, { passive: false });
    b.addEventListener("pointerdown", fire);
    b.addEventListener("mousedown", fire);
    return b;
  };
  /* 【2026-10-10】开表格菜单的唯一入口：把**浮动条当前那张表**的 from 一起传过去。
     为什么必须传：表格是 block widget —— 点它**不会**移动 CM 光标，菜单项里 tableAt(光标) 因此必空、
     直接静默 return（哨兵实测：点完「复制表格（可粘 Excel）」剪贴板里还是哨兵值），
     用户粘出来就是"上一个内容"（他剪贴板里恰好是截图时，Excel 里就出现一张整窗图）。
     传了 from，菜单锚点就落在表内，两个复制项都能定位到正确的表。 */
  const openTableMenu = (b) => {
    // Resolve the toolbar table only after committing its active cell.
    if (!commands.capture()) return;
    const r = b.getBoundingClientRect();
    let tf = null;
    try { const t = tableBarTarget(); tf = t && t.table ? t.table.from : null; } catch { /* 取不到就退化为原行为 */ }
    try { window.mpExtras?.tableMenuAt?.({ clientX: r.left, clientY: r.bottom + 2 }, tf); } catch (e) { console.error("[mp] 表格菜单失败：", e); }
  };
  const left = document.createElement("div"); left.className = "mp-table-bar-l";
  const right = document.createElement("div"); right.className = "mp-table-bar-r";
  left.appendChild(mkBtn("▦", "表格操作", (b) => {
    openTableMenu(b);
  }));
  const alignBtn = (label, title, align) => mkBtn(label, title, () => withTableBarTarget(() => window.mpExtras?.setAlign?.(align)));
  left.appendChild(alignBtn("≡左", "本列左对齐", "left"));
  left.appendChild(alignBtn("≡中", "本列居中", "center"));
  left.appendChild(alignBtn("≡右", "本列右对齐", "right"));
  right.appendChild(mkBtn("⋮", "更多表格操作", (b) => {
    openTableMenu(b);
  }));
  right.appendChild(mkBtn("🗑", "删除表格", () => withTableBarTarget(() => window.mpExtras?.tableOp?.('table-delete'))));
  bar.appendChild(left); bar.appendChild(right);
  (view ? view.dom : document.body).appendChild(bar);
  tableBar = bar;
  return bar;
}
/** 【陈旧选区 / 触屏】按下时把目标格**捕获成状态**（与右键菜单的 menuAnchor 同款形状）：
 *  触屏上"点空白/按钮"引发的焦点转移与 blur 可能先于兼容 mousedown 到达 ⇒ 命令执行时活动格已经没了。
 *  捕获之后命令锚的是"被按的那一格"，与覆盖层是否还活着解耦（B4 的红侧因此改成"注掉目标捕获"）。 */
let barAnchor = null;
function captureBarAnchor() {
  barAnchor = null;
  if (!view) return;
  const active = view.state.field(activeCellField, false);
  if (active) {
    const line = view.state.doc.lineAt(active.rowFrom);
    const ranges = cellRangesOf(line);
    const r = ranges[Math.max(0, Math.min(active.col, ranges.length - 1))];
    if (r) { barAnchor = { rowFrom: active.rowFrom, col: active.col, from: r[0], to: r[1] }; return; }
  }
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const ranges = cellRangesOf(line);
  let col = 0;
  for (let i = 0; i < ranges.length; i++) if (head >= ranges[i][0]) col = i;
  const r = ranges[col];
  if (r && tableTablesOf(view.state).some((t) => line.from >= t.from && line.to <= t.to)) barAnchor = { rowFrom: line.from, col, from: r[0], to: r[1] };
}
/** 命令前把 CM 选区落进**捕获到的**那一格（而不是"当前活动格"）。 */
function withTableBarTarget(fn) {
  if (!view) return;
  try {
    const anchor = barAnchor;
    if (anchor) {
      const cur = view.state.selection.main;
      if (!(cur.head >= anchor.from && cur.head <= anchor.to)) view.dispatch({ selection: EditorSelection.cursor(anchor.from) });
    } else {
      captureBarAnchor();
      if (barAnchor) {
        const cur = view.state.selection.main;
        if (!(cur.head >= barAnchor.from && cur.head <= barAnchor.to)) view.dispatch({ selection: EditorSelection.cursor(barAnchor.from) });
      }
    }
    fn();
  } catch (e) { console.error("[mp] 工具栏命令失败：", e); }
  barAnchor = null;
  positionTableBar();
}
function positionTableBar(ctx) {
  if (!view) return;
  /* 【C10】内部上下文严判：仅当绑定当前 view、state 一致且确带 target 与**已读**
     source 时复用（schedule 传入，避免第二次 field 读）。window resize 传进来的
     Event 不满足 view/state 严判 ⇒ 整体走旧解析；绝不把 Event.target 当表格目标。 */
  let t = null, source = null;
  if (ctx && typeof ctx === "object" && ctx.view === view && ctx.state === view.state &&
      Object.prototype.hasOwnProperty.call(ctx, "target") &&
      Object.prototype.hasOwnProperty.call(ctx, "source") &&
      ctx.target && ctx.target.table && ctx.source !== undefined) {
    t = ctx.target; source = ctx.source;
  } else {
    t = tableBarTarget();
    source = tableBarReadSource(t);
  }
  if (!t || document.documentElement.dataset.mpReading === "1") { hideTableBar(); return; }
  const bar = ensureTableBar();
  const headFrom = t.table.headerBlock.from;
  const th = view.contentDOM.querySelector(`.mp-row th[data-mp-row="${headFrom}"], .mp-row td[data-mp-row="${headFrom}"]`);
  if (!th) { hideTableBar(); return; }
  const wrap = th.closest(".mp-table-wrap") || th;
  const hr = wrap.getBoundingClientRect();
  const vh = window.innerHeight || 800;
  /* 规则 3：表头与视口不相交 ⇒ 隐藏（状态不变，滚回来就回来） */
  if (hr.bottom <= 0 || hr.top >= vh) { hideTableBar(); return; }
  bar.style.display = "flex";
  tableBarVisible = true;
  const barH = bar.getBoundingClientRect().height || 34;
  const tokenH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--mp-toolbar-h")) || 32;
  const island = document.querySelector(".mp-toolbar");
  const topLimit = (island && island.getBoundingClientRect().bottom ? island.getBoundingClientRect().bottom : tokenH) + 4;
  /* 【整表 rect·task-10】一张表在 DOM 里是**多个** .mp-table-wrap（实测 2 个：表头段 + 表体段），
     而 th.closest(...) 只拿到表头段 ⇒ 必须聚合。判"属于本表"用**源码区间**：data-mp-row 存的是
     源码 offset（上面 th 的查询用的就是 headerBlock.from），本表区间 = t.table.from .. t.table.to。 */
  const segs = [];
  let tr = { top: hr.top, bottom: hr.bottom, left: hr.left, right: hr.right };
  let haveSeg = false;
  for (const el of view.contentDOM.querySelectorAll(".mp-table-wrap")) {
    const cell = el.querySelector("[data-mp-row]");
    if (!cell) continue;
    const rf = Number(cell.getAttribute("data-mp-row"));
    if (!Number.isFinite(rf) || rf < t.table.from || rf > t.table.to) continue;
    const r = el.getBoundingClientRect();
    segs.push(el);
    if (!haveSeg) { tr = { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; haveSeg = true; }
    else {
      tr.top = Math.min(tr.top, r.top); tr.bottom = Math.max(tr.bottom, r.bottom);
      tr.left = Math.min(tr.left, r.left); tr.right = Math.max(tr.right, r.right);
    }
  }
  if (!haveSeg) segs.push(wrap);
  /* 【C10·源码行并入几何】仅当 source 与当前表闭端点相交才启用。只枚举当前
     view.contentDOM 的 .cm-line；posAtDOM 捕获失败/位置不在“当前表 ∩ source 范围”
     的不收；排除含/位于 .mp-table-wrap 的行（表 widget 自身），但不禁合法 inline
     widget；只认有限正高的真实 rect。raw 行**只并 top/bottom**——绝不改 left/right
     （超长 raw 行不得把工具条拉宽）。raw 节点并入 segs 后去重、按真实 DOM 顺序排序，
     首末端点交给下方原 findLine（避免 widget-only 端点撞 60 guard）。生产循环不设
     诊断的 8 行上限，覆盖当前表全部实际挂载的合格源码行。 */
  if (source && source.from <= t.table.to && source.to >= t.table.from) {
    const lo = Math.max(source.from, t.table.from), hi = Math.min(source.to, t.table.to);
    const insideWrap = (el) => { if (el.querySelector(".mp-table-wrap")) return true; for (let a = el; a && a !== view.contentDOM; a = a.parentElement) if (a.classList && a.classList.contains("mp-table-wrap")) return true; return false; };
    const rawNodes = [];
    for (const el of view.contentDOM.querySelectorAll(".cm-line")) {
      if (insideWrap(el)) continue;
      let p = null;
      try { p = view.posAtDOM(el, 0); } catch { continue; }
      if (p == null || p < lo || p > hi) continue;
      const r = el.getBoundingClientRect();
      if (!Number.isFinite(r.top) || !Number.isFinite(r.bottom) || !(r.height > 0)) continue;
      rawNodes.push(el);
      tr.top = Math.min(tr.top, r.top);
      tr.bottom = Math.max(tr.bottom, r.bottom);
    }
    if (rawNodes.length) {
      const merged = Array.from(new Set(segs.concat(rawNodes)));
      merged.sort((a, b) => (a === b ? 0 : (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1));
      segs.length = 0; segs.push(...merged);
    }
  }
  /* 取"**表外**的正文行"：height > 0 且 posAtDOM 落在本表源码区间之外。
     不这么筛会取到**本表自己的行**（CM6 里表格源码行仍是 .cm-line、被 widget 折成零高且紧贴表格）
     ⇒ 间距恒 0 ⇒ 分支判断全废。只"跳过非 .cm-line"不够，实测反例已记。 */
  const findLine = (start, dir) => {
    let n = start, guard = 0;
    while (n && guard++ < 60) {
      n = dir > 0 ? n.nextElementSibling : n.previousElementSibling;
      if (!n) return null;
      if (!n.classList || !n.classList.contains("cm-line")) continue;
      if (n.getBoundingClientRect().height <= 0) continue;
      let p = null;
      try { p = view.posAtDOM(n, 0); } catch { }
      if (p != null && p >= t.table.from && p <= t.table.to) continue;
      return n;
    }
    return null;
  };
  const srect = view.scrollDOM.getBoundingClientRect();
  const prevLine = findLine(segs[0], -1);
  const nextLine = findLine(segs[segs.length - 1], +1);
  /* 【上方可用·2026-10-09 二次修】= 表顶 − **上文行.bottom**（就是判据要求的那段"行与表之间"的空隙）。
     改前写的是 表顶 − 行.top（= gap + 行高），**比判据松了一个行高** ⇒ 只要
     gap ∈ [barH+6−行高, barH+6)（本机约 14.8–40px）就会走"上方"而压住那一行：
     对抗复核实测夹具 I（块公式行紧贴表格上方、gap=25.84）⇒ 条 ∩ 该行 = 815×14.16 px²（150% 更大）。
     为什么不能"放到那一行之上"：紧贴布局里该行的 top 就是上一块的 bottom，放上去只会压住更上面一行。
     无上文行 ⇒ 表顶 − 内容区顶（文首实测 50）。空行一律按"被占用"处理（保守取严）。 */
  const gapAbove = prevLine ? (tr.top - prevLine.getBoundingClientRect().bottom) : (tr.top - srect.top);
  const spaceBelow = nextLine ? (nextLine.getBoundingClientRect().top - tr.bottom) : (srect.bottom - tr.bottom);
  /* 双上限：既要放得下，也**不许钻进工具岛**（topLimit = 工具岛下沿 + 4，恒保留）。 */
  const spaceAboveIsland = tr.top - topLimit;
  let top;
  /* 【表格浮动条·2026-10-09 用户要求】改前分支 3 会**压在表头文字上**（用户报"还是遮挡"）。
     现在三条分支都优先"表头上方"：放得下就留 4px 间距；放不下就贴着表头（允许压住上一行空白），
     只有"表格上方连 topLimit 都不够"时才退到表格下方。barH 也变小了（22px），遮挡面进一步缩小。 */
  if (Math.min(gapAbove, spaceAboveIsland) >= barH + 4) {
    top = tr.top - barH - 4;                    /* 分支 1：表头上方，留 4px */
  } else if (spaceAboveIsland >= 2) {
    top = Math.min(tr.top - 2, tr.top - barH);  /* 分支 2：紧贴表头（宁可压上一行，不压表头） */
    if (top < topLimit) top = topLimit;
  } else if (spaceBelow >= barH + 4) {
    top = tr.bottom + 4;                        /* 分支 3：上方实在没位置 ⇒ 表格下方 */
  } else {
    top = Math.max(Math.min(tr.top - 2, vh - barH - 4), topLimit);   /* 兜底：仍尽量贴表头上沿 */
  }
  if (top < topLimit) top = topLimit;
  /* 【浮条不遮表头·2026-10-10（zoom-extremes 族）】上面三条分支都优先"表头上方"✓，但**表格顶已滚到
     钳制线之上**时，分支 2 与兜底都会把 top 抬回 topLimit ⇒ 浮条**正好压在表头文字上** ✗
     （实测 200% 遮挡 1122px²、300% 3328px² ✗）。这里按最终 top 复算浮条矩形：与表头相交 ⇒
     **不隐藏、而是退到表格下方**（复用分支 3 的口径 `tr.bottom + 4` ✓）—— 表顶贴视口顶时恰恰是
     用户最可能要操作表格的时候，隐藏等于丢功能 ✗；只有下方也放不下时才隐藏 ✓。 */
  if (top + barH > hr.top + 0.5 && top < hr.bottom - 0.5) {
    const belowTop = tr.bottom + 4;
    if (belowTop + barH <= vh && belowTop >= topLimit) top = belowTop;
    else { hideTableBar(); return; }
  }
  /* 【zoom 轴·task-10】bar 的 offsetParent 就是被 --mp-zoom 缩放的 .cm-editor（实测）
     ⇒ left/top/width 都要 ÷ z 才落进它的局部坐标系；zoom=100% 时是空操作。
     width 不换算的后果实测过：150% 下 style 写 790.5 ⇒ 视觉 1185.75，比表宽出 395.25px。 */
  const z = mpZoomOf(view.dom);
  const hostRect = view.dom.getBoundingClientRect();
  bar.style.left = ((tr.left - hostRect.left) / z) + "px";
  bar.style.width = (Math.max(180, tr.right - tr.left) / z) + "px";
  bar.style.top = ((top - hostRect.top) / z) + "px";
  /* 高亮：与本列对齐一致的那个槽位 */
  const map = { left: "本列左对齐", center: "本列居中", right: "本列右对齐" };
  bar.querySelectorAll(".mp-table-bar-item").forEach((b) => {
    const want = map[t.align] || null;
    b.classList.toggle("is-active", !!want && b.dataset.mpBar === want);
  });
}
function hideTableBar() {
  if (tableBar && tableBar.style.display !== "none") tableBar.style.display = "none";
  tableBarVisible = false;
}
/** 安全读 C8 source 范围：目标缺失/阅读态不读；仅当 C8 的 tableSourceRangeField
 * 真实存在（typeof 守卫，C8-off 时该 const 已随其 hunk 逆撤而消失）才读，且用
 * field(..., false)——未注册不抛错。读不到一律 null，绝不回退猜读 separator 字段。
 * 与当前表按闭端点相交才由调用方启用；正常 cell/table owner 下 source=null 保持原行为。 */
function tableBarReadSource(t) {
  if (!t || !view || document.documentElement.dataset.mpReading === "1") return null;
  try {
    if (typeof tableSourceRangeField !== "undefined") {
      const value = view.state.field(tableSourceRangeField, false);
      if (value && Number.isFinite(value.from) && Number.isFinite(value.to) &&
          value.from <= t.table.to && value.to >= t.table.from) return { from: value.from, to: value.to };
    }
  } catch { /* 读不到就按无 source 处理 */ }
  return null;
}
/** 状态键（不含文档长度/内容哈希/时间）—— 变了才动 DOM，键不变时一个字节都不碰。
 * 【C10】键尾追加 active-source 的 from/to；仅 source 活跃时做 O(1) 的 state.doc
 * Text 引用比较——同长替换/换行改变几何也必须失效（docLen/hash/from-to 都不够）。
 * source→null / 目标表消失 / 阅读态退出活跃 source 时：清 Text 引用，且**不得**
 * 清完缓存又因旧 base 键相同提前 return —— 显式清 tableBarKey 强制走一次原定位/隐藏。
 * 已读 source 经内部上下文传给 positionTableBar，避免第二读；目标表存在时至多一次
 * 安全可选 field 读；t=null 普通热路径零 field 读、零扫描。 */
function scheduleTableChrome() {
  if (!view) return;
  const t = tableBarTarget();
  const reading = document.documentElement.dataset.mpReading === "1";
  const source = reading ? null : tableBarReadSource(t);
  const key = t ? [t.table.headerBlock.from, t.col, t.align || "", reading ? "r" : "",
    source ? "s" + source.from + "-" + source.to : ""].join(":") : "none";
  if (source) {
    if (tableBarSourceText !== view.state.doc) tableBarKey = "";
    tableBarSourceText = view.state.doc;
  } else {
    if (tableBarSourceText !== null) tableBarKey = "";
    tableBarSourceText = null;
  }
  if (key === tableBarKey) return;
  tableBarKey = key;
  positionTableBar(t ? { target: t, source, view, state: view.state } : undefined);
}
function installTableBar(v) {
  ensureTableBar();
  // The master scroll listener installed in boot handles both surfaces once.
  /* 双开/大纲停靠/toggle 都不产生事务与滚动 ⇒ 用 ResizeObserver 盯编辑面几何跟随 */
  try { if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => positionTableBar()).observe(v.dom); } catch { /* 兜底：window resize */ }
  window.addEventListener("resize", positionTableBar);
  scheduleTableChrome();
  return { position: positionTableBar, schedule: scheduleTableChrome, visible: () => tableBarVisible,
    geometry: () => {
      const owner = tableGeometryObservers.get(v);
      return { targets: owner?.nodes.size || 0, deliveries: owner?.deliveries || 0, placements: owner?.placements || 0,
        cachedRows: owner?.recent.size || 0, epoch: owner?.epoch ?? null };
    } };
}

function boot(content) {
  if (view) return;
  installZoomWrap();     // 【缩放解耦】先给 #editor 套一层缩放外壳（工具栏/状态栏在 body 上，不在里面）
  applyEnginePrefs();    // 缩放/岛尺寸/版心/状态栏四件套：装编辑器之前先把 token 写好（首帧即正确）
  if (!document.querySelector(".mp-statusbar")) buildStatusBar();
  const asyncSyntax = createAsyncMarkdown(markdownLanguage);
  view = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: documentExtensions = [
        markdownContext,
        editPlan,
        mathCompletion(), // Open candidates have priority over structural Enter/Tab.
        asyncSyntax.extension, // Prepare native tree queries before basicSetup; math candidates stay first.
        basicSetup,
        readingCompartment.of([]),          // 阅读模式：真只读（D-01）
        markdown({
          addKeymap: false,
          base: asyncSyntax.language,
          // 代码围栏语法着色（2.3.3 hljs 对齐）。【复判实锤】lang-markdown 的
          // getCodeParser 走 found.support（LanguageSupport）——load 返回裸
          // StreamLanguage 首解析无 token、二解析抛 TypeError 截断语法树。
          // 一律用 support 静态挂载。
          codeLanguages: [
            LanguageDescription.of({ name: "python", alias: ["py"], support: new LanguageSupport(StreamLanguage.define(python)) }),
            LanguageDescription.of({ name: "javascript", alias: ["js", "jsx"], support: new LanguageSupport(StreamLanguage.define(javascript)) }),
            LanguageDescription.of({ name: "json", support: new LanguageSupport(StreamLanguage.define(json)) }),
            LanguageDescription.of({ name: "css", support: new LanguageSupport(StreamLanguage.define(css)) }),
            LanguageDescription.of({ name: "shell", alias: ["bash", "sh"], support: new LanguageSupport(StreamLanguage.define(shell)) }),
            LanguageDescription.of({ name: "xml", alias: ["html"], support: new LanguageSupport(StreamLanguage.define(xml)) }),
          ],
        }),
        syntaxHighlighting(mdHighlight),
        mathDecorations, // 派生层（行内）：selection+预计算 spans → 投影/源码切换＋编辑浮动预览
        mathSpansField, // 数据层：仅文档变化时重扫（选区变化零重扫）
        blockMathField, // 块级投影：StateField 直供（须排在 mathSpansField 之后——update 读其 spans）
        mathFencePointerSelection,
        headingDecorations, // 标题井号投影：光标入行显源码、离行隐藏
        lineStylesField, // 行级样式数据层（标题/围栏/引用，仅文档变化重扫）
        tableDataField, // 表数据层（窄字段；非结构不触表时身份稳定 ⇒ 跳过整条 compute）
        lineClassDecorations, // 行类派生（mp-h1..h6/mp-code/mp-quote → telari 版式）
        mermaidBlocksField, // 【mermaid·2026-10-11】图表块数据层（仅文档变化且含结构字符时重扫）
        mermaidDecorations, // 【mermaid】块级投影：光标入块显源码、离块渲染图表
        inlineMarksField, // 行内标记数据层（**/`/~~/链接，仅文档变化重扫；须在 mathSpansField 后）
        regionIndexField,
        regionSessionField,
        imageSessionField,
        rendererLifecycle.extension,
        viewportIntent.extension,
        regionKeys,
        Prec.highest(keymap.of([
          { key: 'Mod-z', run: () => historyCommand(undo) },
          { key: 'Mod-Shift-z', run: () => historyCommand(redo) },
          { key: 'Mod-y', run: () => historyCommand(redo) },
        ])),
        imageInsertions,
        inlineMarkDecorations, // 行内标记投影：光标入段显源码、离段隐藏
        imgBaseField,          // 【图片】文档目录变化时踢一脚，让图片 widget 用新的 base 重建
        imgPreviewField,       // 【图片】资源代次变化时让 retained/inline 图片重建
        imageAtomicRanges, // 【图片】长 data URI 的图当原子区间（方向键整块跳过）
        tableDecorations, // 表格投影：Excel 式格内编辑；无格归属的 separator 原生选区显示源码
        tableCellClick,
        searchCellFocus,
        extrasCompartment.of([]),
        keyCompartment.of(keymap.of([])),
        activeCellField, // 活动格状态（effect 驱动）
        tableSelectionField, // 【β1】选择层级（格/行/列/整表）—— 与活动格**解耦**（见 tableSelectionField 注释）
        tableSourceRangeField, // 同一 separator 行的原生选区；null/相同块坐标保持身份
        tableSelInputGuard, // 【β1】行/列/整表层级下打字：先收场再放行（不许一个看不见的按键改表结构）
        listSemantics,
        tableKeys,
        autoBreakMath, // 行中段 $$…$$ 收笔即换行（三道闸；零文档改动优先，闸门内才动结构）
        blockVerticalKeys, // ↑/↓ 跨块边界时进块公式或**图表块**（否则 CM6 会整块跳过）
        verticalInputIntent,
        nativeVerticalIntent,
        docSourceClipboard, // 选区含公式时按文档源码写剪贴板（D8 配套）
        mathPointerGesture,
        clickToSource,
        kpTypesetPlugin,    // 【排版美化·2026-10-09】阅读模式 + 小文档 + 用户显式开启时，按 Knuth–Plass 整段最优断行
        imgPrefetchPlugin,  // 【图片】选区/视口变化后预取 Blob（copy 里不能 await）
        sbField,            // 状态栏数据源（文档长度 + 选区主位置；只在这两个数变化时才动 DOM）
        statusBarPlugin,    // 底部状态栏（零每键 DOM 操作，见 ViewPlugin 注释）
        zoomKeys,           // Ctrl+= / Ctrl+- / Ctrl+0 → 只缩放内容区（工具岛大小独立）
        EditorView.updateListener.of((u) => {
          if (u.docChanged) sourceRevision++;
          commands.changed(u);
          for (const tr of u.transactions) if (tr.isUserEvent('select.vertical')) verticalIntentDiag.custom++;
          if (u.transactions.some(tr => tr.docChanged || (tr.selection &&
            !tr.isUserEvent('select.vertical') && !tr.annotation(verticalSelection)))) {
            mathPass = null; blockPassDir = 0;
            verticalIntentDiag.resets++;
          }
          // 性能架构：轻量脏标（长度）代替每键全文克隆——250KB/键的 structured clone 是
          // 大文档打字卡顿源之一；客户端防抖到点后 requestText 拉全文（1500ms 一次，可承受）。
          // IME 组字门控（W1 快赢②）：组字态每笔事务只挂脏标不扰桥，compositionend 一笔补发。
          if (u.docChanged || u.selectionSet) {
            if (u.docChanged && !suppressChange) {
              if (view && view.composing) { composingDirty = true; }
              else post("change", { len: u.state.doc.length, ...window.mpEngine?.documentSession() });
            }
          }
          /* 【#62-U2R-3】覆盖层打开时文档被外部路径改写（位图粘贴异步 commit 等）⇒ 把镜像区间与
             活动格位置跟着事务映射，否则下一次键入会写进旧区间（数据破坏，实测把表头写成
             `a1 Z1 | H2 |`）。映射只动位置、不写文档；活动格效果用微任务派发，避免在 update 里重入。 */
          if (u.docChanged && cellEdit) {
            try {
              const nf = u.changes.mapPos(cellEdit.from, 1);
              const nt = u.changes.mapPos(cellEdit.to, -1);
              if (nf !== cellEdit.from || nt !== cellEdit.to) { cellEdit.from = nf; cellEdit.to = nt; }
              const active = u.state.field(activeCellField, false);
              if (active) {
                const nr = u.changes.mapPos(active.rowFrom, 1);
                if (nr !== active.rowFrom) {
                  const stamp = active;
                  queueMicrotask(() => {
                    try {
                      if (!view) return;
                      const cur = view.state.field(activeCellField, false);
                      if (cur && cur === stamp) view.dispatch({ effects: setActiveCell.of({ rowFrom: nr, col: cur.col }) });
                    } catch { /* 视图已换文档 */ }
                  });
                }
              }
            } catch { /* 映射失败不阻塞主流程 */ }
          }
          // 双开（形态 B）状态转发：从视图只读镜像主视图文档。分屏关闭时 mirror() 第一行返回
          //（零成本）；开着时按 Text 对象同一性判脏，纯选区/几何更新不做任何工作。
          /* 【β2】表格工具栏状态键：**必须挂在 if 之外** —— 点格只 dispatch setActiveCell（不落选区、
             不改文档），那种事务的 selectionSet/docChanged 都是 false，挂在 if 里就等于"点格不出工具栏"。 */
          scheduleTableChrome();
          /* 【C16·公开增量】仅在正常（非 suppressChange 的 setValue 窗口之外）且分屏打开时，
             把本次 ViewUpdate 实际组合出的 startState.doc+u.changes 增量交给 mirror；
             关闭时零对象分配；setValue/rollback/replaceDocument 仍走无 delta 全量路径。 */
          window.mpSplit && window.mpSplit.mirror(u.state, (suppressChange || !window.mpSplit.isOpen()) ? null : { from: u.startState.doc, changes: u.changes });
        }),
        themeVars,
        EditorView.lineWrapping,
        // Rich documents create expensive formula DOM outside the screen.
        // Keep a smaller buffer while preserving the visible and selected blocks.
        EditorView.viewportMargin.compute(["doc", mathSpansField, tableDataField], state =>
          state.doc.length > 50000 && (state.field(mathSpansField).spans.length > 128 ||
            state.field(tableDataField).length > 16) ? 300 : 1000),
        tailSpace,
      ],
    }),
    parent: document.getElementById("editor"),
  });
  /* 【#51·2026-10-18 实测缺陷 N6】行/列/整表选择下开始 IME 组字：表行是 block widget，没有可承载
     IME 焦点的文本 DOM；守卫把第一笔组字事务搬进格首后收掉表级状态，而 CM6 的组字观察器仍以
     widget 边界为锚 ⇒ 第二笔组字起被插到表格下方的新行（实测 ni 进格、nihao/你好 跑到表外）。
     方案：组字**开始**时把 CM/DOM 选区临时落到表格块之后的真实文本行（同时收掉表级选择），让 IME
     在正常文本位置完成组字；compositionend 时把这段组字文本整体搬进目标格内容起点，并打开格覆盖层，
     后续键入回到正常格内路径。 */
  let imeTableRelocate = null;
  function tableSafeTextPos(st, rowLine) {
    /* 【C12·EDGE-A5-A2】表行判据改为**缓存表成员**：旧 `^\s*\|`（#58 后剥前缀版）仍把
       无前导管道的真实表行（如 b1 行）当"非表行"，组字临时位落进表内 ⇒ 实测 destructively
       劈表（f9c95e2f…：nolead-first 'nib1 | b2'，commit 'a1 | a2\n2'）。改用已有
       tableTablesOf(st)（读一次缓存 tableDataField，不重扫不重解析）判 line.from ∈ 某表
       [from,to]：头/分隔行/全部行、无前导管道行、引用前缀行一律是表行；相邻其他表的行
       同样跳过。表缓存不可用/空 ⇒ 如实返回 null 放弃搬迁（无环境钩子、无新正则回退、
       缓存分类不再需要 tableLead）。搜索顺序保持原样：向后从下一行取第一条**表外**真实
       源码行的 line.from（**空行也算**）；向前取第一条表外行的 line.to（Math.max）；
       都没有则 null。PURE_NO_NL 表外无行 ⇒ 继续 null，不造追加行。 */
    try {
      const tables = tableTablesOf(st);
      if (!tables.length) return null;
      const inAnyTable = (pos) => tables.some((t) => pos >= t.from && pos <= t.to);
      if (!inAnyTable(rowLine.from)) return null;
      let n = rowLine.number + 1;
      while (n <= st.doc.lines) {
        const line = st.doc.line(n);
        if (inAnyTable(line.from)) { n++; continue; }
        return line.from;
      }
      n = rowLine.number - 1;
      while (n >= 1) {
        const line = st.doc.line(n);
        if (inAnyTable(line.from)) { n--; continue; }
        return Math.max(line.from, line.to);
      }
    } catch { /* 落在异常上就放弃搬迁 */ }
    return null;
  }
  /* 【#52·2026-10-18 实测缺陷 N6 变体】整表选择（四周 block widget）下，CM6 自己的 compositionstart
     处理器会先把跨行 DOM 选区收成 caret（观测：document capture 时 kind=table/sel 4..53，到
     view.dom 的组字处理器时已变成 kind=null/sel 32..32）⇒ #51 的搬迁判据拿不到表级状态。
     因此改挂 **document capture**：在 CM6/浏览器处理组字之前先做搬迁。 */
  document.addEventListener("compositionstart", (event) => {
    if (!view) return;
    const target = event.composedPath?.()[0] || event.target;
    if (!view.contentDOM.contains(target)) return;
    const cur = view.state.field(tableSelectionField, false);
    if (!cur || cur.kind === 'cell' || imeTableRelocate) return;
    try {
      const st = view.state, rowLine = st.doc.lineAt(cur.rowFrom);
      const ranges = cellRangesOf(rowLine);
      const r = ranges[Math.max(0, Math.min(cur.col, ranges.length - 1))];
      if (!r) return;
      const safeFrom = tableSafeTextPos(st, rowLine);
      if (safeFrom == null) return;
      const seg = rowLine.text.slice(r[0] - rowLine.from, r[1] - rowLine.from);
      const sel = st.selection.main;
      const safeLine = st.doc.lineAt(safeFrom);
      imeTableRelocate = { rowFrom: cur.rowFrom, col: cur.col, kind: cur.kind, cellAt: r[0] + (seg.length - seg.trimStart().length), safeFrom, selFrom: sel.from, selTo: sel.to, safeText: safeLine.text, safeRel: safeFrom - safeLine.from };
      /* 先收表级状态、再把选区落到真实文本位置：CM6 的组字锚点因此不再是 widget 边界。 */
      view.dispatch({ selection: EditorSelection.cursor(safeFrom), effects: [setTableSel.of(null), setActiveCell.of(null)], userEvent: 'select.pointer' });
    } catch { imeTableRelocate = null; }
  }, true);
  /* #56：组字收尾也必须 document capture —— 实测取消/失焦时 compositionend 的 target 可能不在
     contentDOM 内（Esc 取消形态 target 落到 body），挂在 view.dom 上会漏掉 ⇒ 残留与恢复都做不了。 */
  document.addEventListener("compositionend", (event) => {
    const ctx = imeTableRelocate;
    if (!ctx || !view) return;
    imeTableRelocate = null;
    const text = event.data || '';
    try {
      const st = view.state;
      const from = Math.min(ctx.safeFrom, st.doc.length);
      const to = Math.min(from + text.length, st.doc.length);
      const landed = text ? st.doc.sliceString(from, to) : '';
      if (!text || landed !== text) {
        /* 【#56】组字被取消（Esc/失焦/候选取消）时什么都不该发生：① 清掉已落在临时行上的组字残留
           （实测 Esc 取消后 CM6 把 "ni" 留在表后新行）；② 把组字开始前搬走的表级选择与选区原样还回去。
           两件事在同一笔事务里做，且**不进撤销栈**（取消的用户语义＝零操作）。 */
        try {
          const len = st.doc.length;
          const line = st.doc.lineAt(Math.min(ctx.safeFrom, len));
          const orig = ctx.safeText ?? '', cur = line.text;
          let p = 0; const max = Math.min(orig.length, cur.length);
          while (p < max && orig[p] === cur[p]) p++;
          let s = 0;
          while (s < Math.min(orig.length - p, cur.length - p) && orig[orig.length - 1 - s] === cur[cur.length - 1 - s]) s++;
          const leftover = cur.slice(p, cur.length - s);
          const at = Math.min(ctx.safeRel ?? 0, cur.length);
          const delFrom = leftover && p === at ? line.from + p : -1;
          const delTo = delFrom >= 0 ? delFrom + leftover.length : -1;
          const a = Math.min(ctx.selFrom, len), b = Math.min(ctx.selTo, len);
          const baseSel = EditorSelection.range(Math.min(a, b), Math.max(a, b));
          const tr = view.state.update({
            changes: delFrom >= 0 ? { from: delFrom, to: delTo, insert: '' } : undefined,
            selection: delFrom >= 0
              ? EditorSelection.range(
                trPos(baseSel.from), trPos(baseSel.to))
              : baseSel,
            effects: [setTableSel.of({ kind: ctx.kind, rowFrom: Math.min(ctx.rowFrom, len), col: ctx.col }), setActiveCell.of(null)],
            userEvent: 'select.pointer',
            annotations: Transaction.addToHistory.of(false),
          });
          /* trPos：把原选区的端点映射过"删掉 leftover"这一笔（端点 >= delTo 的右移）。 */
          function trPos(pos) {
            if (delFrom < 0) return pos;
            if (pos >= delTo) return pos - leftover.length;
            if (pos <= delFrom) return pos;
            return delFrom;
          }
          view.dispatch(tr);
        } catch { /* 文档在组字期间被外部替换 ⇒ 不做恢复 */ }
        return;   // 组字被取消 / 没落在临时行 ⇒ 不搬
      }
      const changes = ctx.cellAt >= from
        ? [{ from: ctx.cellAt, insert: text }, { from, to, insert: '' }]
        : [{ from, to, insert: '' }, { from: ctx.cellAt, insert: text }];
      const tr = view.state.update({ changes, userEvent: 'input.type' });
      view.dispatch(tr);
      const rowFrom = tr.changes.mapPos(ctx.rowFrom, 1);
      const line = tr.state.doc.lineAt(rowFrom);
      const ranges = cellRangesOf(line);
      const r = ranges[Math.max(0, Math.min(ctx.col, ranges.length - 1))];
      if (!r) return;
      const caret = tr.changes.mapPos(ctx.cellAt, 1);
      const relocate = { rowFrom, col: ctx.col, cols: ranges.length, from: r[0], to: r[1], caret: Math.max(0, caret - r[0]) };
      /* compositionend 里 CM6 仍在收尾（view.composing 尚未归零），立即开覆盖层会被同拍的状态更新收掉；
         下一拍再开，用户看到的是组字提交后直接进入格内编辑。 */
      setTimeout(() => {
        try {
          if (!view || view.state.doc !== tr.state.doc) return;
          /* 覆盖层定位依赖 activeCellField（activeCellDOM 取不到就 display:none）⇒ 先立活动格再激活。 */
          view.dispatch({ effects: setActiveCell.of({ rowFrom: relocate.rowFrom, col: relocate.col }) });
          activateCellOverlay(relocate.rowFrom, relocate.col, relocate.cols, relocate.from, relocate.to, relocate.caret);
        } catch (e) { console.warn('[mp] ime 组字搬迁后打开格覆盖层失败：', e); }
      }, 0);
    } catch { imeTableRelocate = null; }
  });
  // IME 组字收尾：组字期间挂起的 change 脏标在此一笔补发（丢一笔＝保存调度失联）。
  view.dom.addEventListener("compositionend", () => {
    if (!composingDirty || !view) return;
    composingDirty = false;
    post("change", { len: view.state.doc.length, ...window.mpEngine?.documentSession() });
  });
  // A pending paste can be canceled even when the native history is empty.
  view.dom.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && /^(?:z|y)$/i.test(event.key)) cancelPendingImageInsertions(view);
  }, true);
  // 表格格编辑覆盖层随滚动重定位
  /* 【β2】滚动钩子合并：先覆盖层、再表格工具栏（监听器数量不变，rAF 数量不增）。 */
  view.scrollDOM.addEventListener("scroll", () => { scheduleCellOverlay(); positionTableBar(); }, { passive: true });
  /* Ctrl+滚轮 ＝ 内容缩放（Typora/v2.3.3 同款手感）：只在指针位于**编辑面**内时接管，
     按 10% 一档、与快捷键共用同一个 setter；`passive:false` 才能 preventDefault 掉页面缩放。
     注意方向：deltaY < 0（向上滚）＝放大。 */
  view.dom.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.target && e.target.closest && e.target.closest(".mp-toolbar")) return;   // 岛上滚轮不缩放
    e.preventDefault();
    mpZoomBy(e.deltaY < 0 ? MP_ZOOM_STEP : -MP_ZOOM_STEP);
    scheduleCellOverlay();
  }, { passive: false, capture: true });
  // 版心/缩放随窗口尺寸变化重算（rAF 合并，无每键成本）
  try {
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => schedulePageWidth()).observe(document.getElementById("editor"));
  } catch { /* 已有 window.resize 兜底 */ }
  schedulePageWidth();
  mpApplyHostDocDir();   // 首帧就用壳层给的文档目录设好 base（相对路径图首屏即正确）
  window.mpEngine = {
    getValue: () => (view ? view.state.doc.toString() : ""),
    commands,
    history: kind => historyCommand(kind === 'redo' ? redo : undo),
    documentSession: () => ({ epoch: view.state.field(regionIndexField).epoch, sourceRevision }),
    menuHistory: (cmd) => {
      if (!view || !document.hasFocus() || (cmd !== "undo" && cmd !== "redo")) return false;
      const active = document.activeElement, edit = cellOverlay?.querySelector(".mp-cell-overlay-text");
      const inCell = !!cellEdit && active === edit;
      if (!inCell && (!view.hasFocus || !view.contentDOM.contains(active))) return false;
      if (cellComposing || view.composing) {
        try { window.mpExtras?.toast?.("请先完成输入，再撤销或重做"); } catch { /* Keep the composing history request handled. */ }
        return true;
      }
      cancelPendingImageInsertions(view);
      const command = cmd === "undo" ? undo : redo;
      historyCommand(command);
      return true;
    },
    _syntax: (detailed = false) => asyncSyntax.inspect(view.state, detailed),
    __recognition: (fresh = false) => {
      const state = view.state, context = fresh ? scanStructuralContext(state.doc) : state.field(markdownContext), blocks = context.blocks;
      const math = fresh ? scanMathSpans(state.doc,blocks,context) : state.field(mathSpansField).spans;
      const inline = fresh ? scanInlineMarks(state.doc,math,blocks) : state.field(inlineMarksField);
      const styles = fresh ? { ...scanLineStyles(state.doc,blocks,context), tables: scanTables(state.doc,blocks) } : { ...state.field(lineStylesField), tables: state.field(tableDataField) };
      return { blocks, math, inline, styles, mermaid: fresh ? scanMermaidBlocks(state.doc,blocks) : state.field(mermaidBlocksField) };
    },
    _view: () => view, // 调试/取证通道
    __cellLayout: () => ({ active: view.state.field(activeCellField),
      owner: cellEdit && { rowFrom: cellEdit.rowFrom, col: cellEdit.col, epoch: cellEdit.epoch },
      matched: !!activeCellDOM(), sizer: !!activeCellDOM()?.querySelector('.mp-cell-source-size') }),
    __regions: () => {
      const index = view.state.field(regionIndexField);
      return { epoch: index.epoch, version: index.version, session: view.state.field(regionSessionField),
        lifecycle: rendererLifecycle.inspect(view), viewportSerial: viewportIntent.serial(view), imageGesture: view.__mpRegionGesture,
        computation: { math: view.state.field(mathSpansField)._incr, projection: { ...mathProjectionStats } },
        regions: index.regions.map(r => ({ id: r.id, kind: r.kind, from: r.from, to: r.to,
          payload: r.payload, editFrom: r.editFrom, revision: r.revision, contextVersion: r.contextVersion, context: r.context })) };
    },
    __renderMathHTML: renderMathHTML, // 取证通道：导出公式排版复用同一个渲染器（A/B 注入实测用）
    /* 外观偏好读写（设置面板 / 状态栏 / 取证共用同一条通道；值域见 MP_PREFS） */
    prefs: () => mpPrefsAll(),
    setPref: (id, v) => { mpSetPref(id, v); return mpPrefsAll(); },
    applyPrefs: () => { applyEnginePrefs(); return mpPrefsAll(); },
    /* 取证通道：图片 Blob 预取缓存（判据与排障用；只读快照，不给写入口） */
    imageBlobCache: () => [...imgBlobs.entries()].map(([src, rec]) => ({ src: src.slice(0, 48), state: rec === 'pending' ? 'pending' : rec === null ? 'null' : 'ready', bytes: rec && rec.bytes || 0, rasterBytes: rec && rec.raster && rec.raster.data ? rec.raster.data.byteLength : 0, retainedBytes: rec ? imgBlobCost(rec) : 0, mime: rec && rec.mime || null })),
    /* 取证通道：当前选区里"被完整包含"的图片（排障"复制没带上图"用） */
    imgCopyDiag: () => ({ ...imgCopyDiag }),
    /* 取证通道：覆盖层 Ctrl+C 的次数与分支（N1：格内复制到底写没写剪贴板） */
    cellCopyDiag: () => ({ ...cellCopyDiag }),
    /* 取证通道：行内标记清单（排障"某类标记没投影"用） */
    __inlineMarks: () => (view ? (view.state.field(inlineMarksField, false) || []).map((m) => ({
      from: m.from, to: m.to,
      kind: m.qmark ? "qmark" : m.bullet ? "bullet" : m.image ? "image" : m.comment ? "comment" : "wrap",
      text: view.state.doc.sliceString(m.from, m.to).slice(0, 14),
      /* 【<u> 取证·2026-10-11】下划线走"标签隐掉 + 内文加类"两步 ✓ ⇒
         必须能看见"这条标记有没有被识别成 uOnly、内文区间是多少、hides 是哪几段" ✓
         （排障"有时灵有时不灵"这类间歇现象时，光看 DOM 不足以定位 ✗）。 */
      uOnly: !!m.uOnly,
      uInner: m.uInner || null,
      hides: (m.hides || []).map(([a, b]) => [a - m.from, b - m.from]),
    })) : []),
    /* 【mermaid 取证通道·2026-10-11】块清单 ＋ 三层缓存的规模与命中情况
       （排障"图表没渲染/改了源码还显示旧图/每键变慢"三件事都靠它） */
    __mermaid: () => ({
      块数: view ? (view.state.field(mermaidBlocksField, false) || []).length : -1,
      块: view ? (view.state.field(mermaidBlocksField, false) || []).map((b) => ({ from: b.from, to: b.to, srcLen: b.src.length, srcHead: b.src.slice(0, 24) })) : [],
      svg缓存条数: svgCache.size,
      svg缓存键: [...svgCache.keys()].map((k) => k.slice(0, 40)),
      widget缓存条数: mermaidWidgetCache.size,
      高度缓存条数: mermaidHeights.size,
      脚本已加载: !!window.mermaid,
      脚本URL: MERMAID_URL,
      队列中: mermaidQueue.length,
      累计渲染完成: mermaidDone,
      字段update次数: mmUpdateCount,
      字段重扫次数: mmScanCount,
      /* 【列纪律取证·2026-10-11】纵向移动记着的"本轮块 + 目标列 + 上次落点" ✓
         （排障"穿过图表块后列被内容末列污染"靠它 —— 只读 ✓） */
      纵向状态: mathPass ? { spanFrom: mathPass.spanFrom, goalCol: mathPass.goalCol, lastPos: mathPass.lastPos } : null,
      纵向方向: blockPassDir,
      纵向意图: { ...verticalIntentDiag },
      纵向轨迹: (window.__navTrace || []).slice(-12),
    }),
    imagesInSelection: () => (view ? imagesInSelection(view.state) : []).map((im) => {
      const rec = imgBlobs.get(mpImgSrc(im.src));
      return { srcLen: im.src.length, mime: rec && rec !== 'pending' && rec !== null ? rec.mime : (rec === 'pending' ? 'pending' : 'none') };
    }),
    getCursor: () => {
      if (!view) return null;
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      return { head, lineNumber: line.number, col: head - line.from, lineText: line.text };
    },
    getSelection: () => {
      if (!view) return null;
      const r = view.state.selection.main;
      return { anchor: r.anchor, head: r.head, selected: view.state.doc.sliceString(Math.min(r.anchor, r.head), Math.max(r.anchor, r.head)) };
    },
    /* 阅读模式：真只读（readOnly + 不可编辑），选区与复制仍可用。 */
    setReadingMode: (on) => {
      if (!view) return false;
      /* 【#26】进阅读态先收场活动格覆盖层：它是 body 级 contenteditable，不会跟着 readOnly 失效。 */
      if (on) { try { deactivateCellOverlay(); } catch { /* 覆盖层可能还没建 */ } }
      try {
        view.dispatch({ effects: readingCompartment.reconfigure(on ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []) });
        return true;
      } catch { return false; }
    },
    checkpointDocument,
    replaceDocument: (text) => {
      if (!view || cellComposing || view.composing) return false;
      const checkpoint = checkpointDocument();
      if (!checkpoint) return false;
      try {
      const old = view.state;
      const state = EditorState.create({ doc: typeof text === 'string' ? text : '', extensions: documentExtensions });
      /* 【CAND-2·2026-10-17】改前只搬 extras/key 两个 compartment，阅读位落回默认 [] ⇒ 阅读态下
         打开另一个文档后 readOnly 归零、而 dataset.mpReading 仍是阅读态（CSS 继续藏光标）⇒ 键入静默改稿。
         阅读位是**状态**，换文档必须原样搬过去。 */
      const fresh = state.update({ effects: [
        extrasCompartment.reconfigure(extrasCompartment.get(old) ?? []),
        keyCompartment.reconfigure(keyCompartment.get(old) ?? []),
        readingCompartment.reconfigure(readingCompartment.get(old) ?? []),
      ] }).state;
      deactivateCellOverlay();
      inlineMathMetrics.clear();
      cellComposing = composingDirty = false;
      mathPass = null; blockPassDir = 0; lastLiveHeight = -1;
      overlayStyledFor = tableBarKey = '';
      view.__mpMathClick = null;
      view.__mpImageClick = null; view.__mpRegionGesture = null;
      view.__mpMathGesture = null; view.__mpVerticalInput = false;
      suppressChange = true;
      try { view.setState(fresh); }
      finally { suppressChange = false; }
      /* 【#47·2026-10-18 实测缺陷 NX2】setState 是整状态替换，不会触发 updateListener ⇒ 换文档后
         大纲仍是旧文档的条目（改短文档时点陈旧条目直接抛 Selection points outside of document）。
         这里显式让扩展重建已打开的大纲。 */
      try { window.mpExtras?.refreshOutline?.(); } catch { }
      commands.invalidate(); sourceRevision = 0;
      view.scrollDOM.scrollTop = view.scrollDOM.scrollLeft = 0;
      window.mpSplit && window.mpSplit.mirror(fresh);
      scheduleTableChrome(); positionTableBar();
      const active = document.activeElement;
      if (!active || active === document.body || active === document.documentElement ||
          view.contentDOM.contains(active) || cellOverlay?.contains(active)) view.focus();
      checkpoint.commit();
      imgBlobInvalidate('replaceDocument', view);
      return true;
      } catch (error) {
        try { checkpoint.rollback(); } finally { imgBlobInvalidate('replaceDocument-failed', view); }
        throw error;
      }
    },
    setValue: (text, ticket = null) => {
      if (!view || cellComposing || view.composing) return false;
      if (ticket && !commands.valid(ticket, { intent: false })) return false;
      view.dispatch({ effects: cancelImageInsertions.of(null), annotations: Transaction.addToHistory.of(false) });
      if (typeof text !== "string") text = "";
      suppressChange = true; // 最小 diff 事务也是 docChanged：挡住回声 change{len}（假脏标＋冗余保存周期）
      // 【T2 红1·最小 diff 形态】外部重载只替换公共前/后缀夹住的中段：
      // ① 旧撤销分支经最小 ChangeSet 映射存活（全量替换会塌缩成零长 no-op——
      //    addToHistory:false 只挡新增历史项，挡不住旧分支被冲，复核 B 臂实锤）；
      // ② 外改非历史项＝Ctrl+Z 永远动不了外部改动（盘上外改守恒）；
      // ③ 光标交给 CM6 原生位置映射（上方插 9 字 → col 精确保持，优于手动钳位）。
      // 【U-093 教训】suppressChange 必在 finally 复位——dispatch 构造期抛错不得
      // 卡死 true（否则全部 change 上行死亡＝不落盘）。
      let scrollTop = 0;
      try {
        const doc = view.state.doc;
        const cur = doc.toString();
        const minLen = Math.min(cur.length, text.length);
        let start = 0;
        while (start < minLen && cur.charCodeAt(start) === text.charCodeAt(start)) start++;
        let endCur = cur.length, endNew = text.length;
        while (endCur > start && endNew > start && cur.charCodeAt(endCur - 1) === text.charCodeAt(endNew - 1)) { endCur--; endNew--; }
        const insert = text.slice(start, endNew);
        if (start === endCur && insert === "") { imgBlobInvalidate('setValue', view); return true; }
        const sc0 = view.dom.closest(".cm-scroller") || view.scrollDOM;
        scrollTop = sc0 ? sc0.scrollTop : 0;
        /* 【★ 2026-10-09 修·数据丢失级】改前这笔 dispatch **不带 selection**，靠 CM6 原生位置映射。
           同文档外改（上方插几个字）时没问题；但**整篇替换**（打开另一个文件 / 外部整体重载）时：
           旧文档里既有的**非空选区**两端都落在被替换区间内、association 相反 ⇒ 选区被拉成
           `[start, start + insert.length]` ≈ **整篇** ⇒ **用户敲的第一个字就把整篇替换掉**。
           实测残留件形状印证：`#` + 118×「测」+ `\n`（首 `#` 与尾 `\n` 正是选区外的残留）。
           现在显式映射，规则只有一条：**端点落在被替换区间内的，塌缩到替换起点**（绝不让选区跨过新插入的内容）；
           区间外的端点按长度差平移（与原生映射等价，保住"上方插 9 字 col 精确保持"那条既有行为）。 */
        const sel = ticket?.selection || view.state.selection;
        const dLen = insert.length - (endCur - start);
        const mapP = (p) => (p <= start ? p : (p >= endCur ? p + dLen : start));
        view.dispatch({
          changes: { from: start, to: endCur, insert },
          selection: EditorSelection.create(sel.ranges.map(r => EditorSelection.range(mapP(r.anchor), mapP(r.head))), sel.mainIndex),
          annotations: Transaction.addToHistory.of(false),
          scrollIntoView: false,
        });
        // 视口还原（下一拍，等新高度就绪；最小 diff 高度扰动极小，纯稳态保险）
        viewportIntent.preserveScroll(view, ticket?.scrollTop ?? scrollTop);
        imgBlobInvalidate('setValue', view);
        return true;
      } finally {
        suppressChange = false;
      }
    },
    focus: () => view && view.focus(),
    /** 主题切换（工具栏用）：写偏好并立即应用（同文档内 storage 事件不会触发）。 */
    setTheme: (id) => {
      // 【单一写者】有登记表就委托给它（它负责写变量＋持久化＋dataset 回显），引擎不再自己写
      // editor-theme——否则又变成两个写者抢同一个键；返回契约不变（归一化 id 字符串）。
      if (window.mpTheme && window.mpTheme.has(id)) { window.mpTheme.apply(id); return id; }
      try { localStorage.setItem("editor-theme", String(id)); } catch { /* 无存储 */ }
      applyEditorTheme();
      return preferredEditorTheme();
    },
  };
  /* 启动时按持久化偏好恢复阅读态（applyReading 在引擎就绪前调用时拿不到 view，故这里补一次）。 */
  try { window.mpEngine.setReadingMode(localStorage.getItem('mp-reading') === '1'); } catch { /* 忽略 */ }
  commands.install();
  // 双开（形态 B）：主视图＝现在的即时渲染编辑面；从视图＝同一份文档的只读源码。  // 【扩展数组纪律】installSplit 不向主视图的扩展数组注入任何东西（它返回 {toggle,open,close,mirror,…}，
  // 从视图在 open() 时用**自己的最小 state**现场创建）——故这里不需要 Compartment，扩展数组结构零改动；
  // 引擎侧唯一的钩子就是上面 updateListener 里的那一行 mirror(u.state)。
  window.mpSplit = installSplit({ EditorView, EditorState, getView: () => view,
    selectSource: pos => commands.run(() => {
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true, userEvent: 'select.pointer' });
      if (!activateSourceCellSelection(view)) view.focus();
    }, { focus: 'control' }),
    intentSerial: commands.serial,
    focusSelection: activateSourceCellSelection });
  installToolbar(view); // 工具栏（对齐 v2.3.3 可见集合；未实现的置灰＋标注）
  /* 【β2】表格工具栏：装在 boot() 里（**不是 ViewPlugin**）——分屏从视图用最小 state 建视图，
     做成扩展会让从视图也多一条（B7 的正确红侧就是"把它挪进共享扩展数组"）。 */
  const tableBarApi = installTableBar(view);
  window.mpTableBar = tableBarApi;
  // 扩展包：更多菜单（快捷键设置/主题/表情/导出/关于/帮助）、大纲、表格行列与复制
  const extras = installExtras({
    EditorView, keymap, keyCompartment, Prec,
    /* 【行内格式唯一实现·2026-10-10】快捷键表（extras 的 ACTIONS）与工具栏按钮共用 toolbar.js 的
       同一个 `wrap`。改前 extras 自带一份 wrapSelection：落点在定界符**之后**、且不做取消包裹，
       与工具栏按钮行为不同（AGENTS 错-4 的活体标本）。 */
    wrapInline,
    getView: () => view,
    imageSource: mpImgSrc,
    getImageAt: (pos) => {
      const images = (view?.state.field(inlineMarksField, false) || []).filter(m => m.image);
      return images.find(m => m.from === pos) || images.find(m => m.from < pos && pos <= m.to) || null;
    },
    /* 【β1】表内 Ctrl+A 递进 / Ctrl+E 选格：实现只有一份（在 main.js，因为它持有活动格/覆盖层/装饰），
       extras.js 的 tableKeys 只是把键**分派**过来；表外返回 false ⇒ 原生全选 / 用户的"行内代码"照旧。 */
    /* 【TBL-5】行列命令要能取"用户点过的那一格"：键盘路径不带 target，而行级选区下 head 天然落在
       行尾（列号＝列数、越界），只有表级选择状态记着原来的列。只读口，不改任何状态。 */
    tableSelect: { cycle: () => cycleTableSelection(), selectCell: () => selectCellText(), sel: () => (view ? view.state.field(tableSelectionField, false) : null) },
    lineStylesField, mathSpansField,
    renderMathHTML, // 导出里的公式排版复用引擎这一份（不重写渲染器）
    exportTypoCss,  // 导出件作者层样式＝排版唯一真源生成（与编辑面同表；见 typography.js）
    scrollOffset: () => {
      try {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--mp-toolbar-h');
        const h = parseFloat(v);
        return (Number.isFinite(h) && h > 0 ? h : 42) + 14; // 工具栏高度 + 呼吸位（v2.3.3 的教训：别把目标顶到视口最上方被工具栏挡住）
      } catch { return 56; }
    },
  });
  window.mpExtras = extras;
  try { view.dispatch({ effects: extrasCompartment.reconfigure(extras.extension) }); } catch (e) { console.error('[extras] reconfigure failed', e); }
  try { extras.rebindKeys(); } catch (e) { console.error('[extras] rebindKeys failed', e); }
  // 【首帧】登记表刚就位，立刻按用户所选配色重绘一次。这一段与上面的 boot 同属一个同步任务，
  // 中间不发生布局/绘制 ⇒ 首帧就是正确配色，不存在"先 TELARI 默认、再跳变"的闪烁。
  applyEditorTheme();
}

window.handler
  .on("open", ({ content }) => { boot(typeof content === "string" ? content : ""); })
  .on("replaceDocument", (val) => { window.mpEngine && window.mpEngine.replaceDocument(typeof val === "string" ? val : ""); })
  .on("setValue", (val) => { window.mpEngine && window.mpEngine.setValue(typeof val === "string" ? val : ""); })
  .on("requestText", () => { post("text", view ? view.state.doc.toString() : ""); });

// init 走 handler.emit：桥的握手看门狗靠截获 emit('init') 武装（双引擎同一自愈路径）。
window.handler.emit("init", {});
// 调试位：原生 keydown 日志（环形 60 条——事件层取证，防长会话无界增长）
try {
  window.__keyLog = [];
  document.addEventListener("keydown", (e) => {
    window.__keyLog.push(e.key + (e.shiftKey ? "+shift" : "") + (e.defaultPrevented ? "(prevented)" : ""));
    if (window.__keyLog.length > 60) window.__keyLog.shift();
  }, true);
} catch { /* 调试位 */ }
