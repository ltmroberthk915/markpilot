// MarkPilot v3 引擎竖切（C1：CM6 文本基座）
//
// 宪法对位：
// - F5/F6（序列化类别消失）：文档就是 md 文本本身，无 doc↔md 转换层。
// - F7（视觉态/DOM 态分离）：行内公式用 Decoration.replace+widget 做「纯视觉投影」，
//   不编辑时显示 KaTeX 渲染，光标进入区间即还原源码——decoration 不改文档，零序列化残留。
// - 竖切改判门：①点公式→源码落位 ②IME 三通道（中文组字/英文/混排）绿。
// - 桥契约与 vditor 版同形（open/init/change/setValue），tab 壳与桥一行不改。

import { EditorState, EditorSelection, StateField, StateEffect, Transaction, Prec, Compartment, Text } from "@codemirror/state";
import { EditorView, ViewPlugin, Decoration, WidgetType, keymap } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { undo } from "@codemirror/commands";
import { StreamLanguage, LanguageDescription, LanguageSupport } from "@codemirror/language";
import { python } from "@codemirror/legacy-modes/mode/python";
import { javascript, json } from "@codemirror/legacy-modes/mode/javascript";
import { css } from "@codemirror/legacy-modes/mode/css";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { xml } from "@codemirror/legacy-modes/mode/xml";
// 【K10 资产平移】换用 vendored sourceMap KaTeX（0.16.9 带原生 sourceMap 选项，
// 输出 data-typora-source-start/end 属性）——点 ω 落 \omega 的 o 那套 2.x 资产
// 直接平移到 cm6；npm katex 0.19 无此能力。CSS 同源换装防版本错配。
// 该文件是 UMD 且本包 type:module → esbuild 视作 ESM、无默认导出：副作用导入后
// UMD 工厂落到 window.katex，运行期从这里取。
// 【安全欠账·已知，不静默】vendored 0.16.9 差 0.16.10 一个安全版（\edef 绕过
// maxExpand 等四连，W2 报告实锤）——为 sourceMap 能力付出的降版代价，与 vditor
// 侧同欠；升级 0.16.10+ 并重放 typoraMapSource 补丁＝单列工程项（BUG-DB A-050）。
import "../renderer/cdn/vditor/dist/js/katex/katex.min.js";
import "../renderer/cdn/vditor/dist/js/katex/katex.min.css";
const katexApi = () => window.katex;
import { listSemantics } from "./lists.js";
import { breakParagraph as kpBreakParagraph, NO_BREAK_BEFORE, NO_BREAK_AFTER } from "./knuth-plass.js";
import { tableKeys, tableBlockOf, tableLead, isSeparatorBody, displayWidth, fitWidths, applyEnter, applyEnterBr, applyTab, setTableHint, isFenceAt } from "./tables.js";
import { mathCompletion } from "./completion.js";
import { installToolbar, wrap as wrapInline } from "./toolbar.js";
import { installExtras } from "./extras.js";
import { installSplit } from "./splitview.js";
import { editorFontVarsCss, editorHeadingsCss, editorContentMetricsCss, editorKaiRuleCss, editorKaiStyle, exportTypoCss } from "./typography.js";

/* ══ 数学渲染缓存层（W1×W2 交叉确认快赢包）══
 * 旧债三笔：① widgetCache 超 2000 条 clear() 雪崩（滚动回访全量重建）；
 * ② 每次重建都重新 KaTeX 解析（0.063ms/式 × 千式级滚动）；
 * ③ 块级 widget 无 estimatedHeight → 快滚高度抖动。
 * 新架构：widget LRU(256) 命中＝同实例复用 DOM；tex→HTML 串 LRU(1MB/512条)
 * 使淘汰后重建走 innerHTML 免解析；块高度记忆(128) 供 estimatedHeight 预留位。 */

const widgetCache = new Map(); // LRU（cap 256）：命中＝同实例 → CM6 eq 复用 DOM，零重建
const htmlCache = new Map(); // tex → HTML 串（字节预算 1MB／512 条；参数对齐 renderer 侧 markupCache）
const blockHeights = new Map(); // 块公式 tex → 实测高 px（cap 128，快滚高度记忆；只存稳态）
let lastLiveHeight = -1; // 本编辑会话上一 live 预览高度（K10 对抗③：miss 回退防每键抖动）
let htmlBytes = 0;

function renderMathHTML(tex, display) {
  const key = (display ? "B" : "I") + tex;
  const hit = htmlCache.get(key);
  if (hit != null) { htmlCache.delete(key); htmlCache.set(key, hit); return hit; } // LRU touch
  let html;
  try { html = katexApi().renderToString(tex, { throwOnError: false, output: "html", displayMode: display, sourceMap: true }); }
  catch { return null; } // 解析失败：退原文，不缓存
  htmlCache.set(key, html);
  htmlBytes += key.length + html.length;
  for (const k of htmlCache.keys()) { // Map 迭代序＝插入序＝最旧先出
    if (htmlBytes <= 1_000_000 && htmlCache.size <= 512) break;
    htmlBytes -= k.length + htmlCache.get(k).length;
    htmlCache.delete(k);
  }
  return html;
}

function rememberBlockHeight(tex, span, live = false) {
  requestAnimationFrame(() => {
    try {
      if (span.isConnected && span.offsetHeight > 0) {
        if (live) { lastLiveHeight = span.offsetHeight; return; } // 中间态只进会话变量，不挤稳态表
        blockHeights.set(tex, span.offsetHeight);
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
    .then(() => { mermaidRunning = false; mermaidDone += 1; pumpMermaid(); });
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
function mermaidWidget(src, from, to) {
  const theme = mermaidTheme();
  const key = theme + '|' + from + '|' + to + '|' + src;
  let w = mermaidWidgetCache.get(key);
  if (w) { mermaidWidgetCache.delete(key); mermaidWidgetCache.set(key, w); return w; }   // LRU touch
  w = new MermaidWidget(src, from, to, theme);
  mermaidWidgetCache.set(key, w);
  if (mermaidWidgetCache.size > 128) mermaidWidgetCache.delete(mermaidWidgetCache.keys().next().value);
  return w;
}
class MermaidWidget extends WidgetType {
  constructor(src, from, to, theme) { super(); this.src = src; this.from = from; this.to = to; this.theme = theme; }
  /* eq() 必须比**全部影响渲染的字段**（错-11：只比一项＝给"复用陈旧 DOM"开门）：
     源码 ✓ 主题 ✓ 位置 ✓（位置烘进了 dataset 与缓存 key）。 */
  eq(other) { return other.src === this.src && other.theme === this.theme && other.from === this.from && other.to === this.to; }
  toDOM(view) {
    const box = document.createElement('div');
    box.className = 'mp-mermaid';
    box.dataset.mpMermaid = svgKey(this.src, this.theme);
    const hit = svgCache.get(box.dataset.mpMermaid);
    if (hit && hit.svg) { box.innerHTML = hit.svg; return box; }         // 命中＝0 解析、0 事务 ✓
    box.textContent = 'mermaid 图表（渲染中…）';
    const holder = document.createElement('div');                        // 第三参容器：失败也不落 body ✓
    /* 【容器必须"不可见但可量"·2026-10-11 实测】一开始用 `display:none` 藏它 ✗ ⇒
       flowchart 渲染**必然失败**：`Could not find a suitable point for the given distance` ✗
       （mermaid 的边路由要在**有布局的**容器里量节点坐标 ✓；`display:none` 下全量成 0 ✗）。
       时序图不量节点坐标 ⇒ 那时只有它"侥幸"能渲染 ✓（正是它暴露了这个差异）。
       正确做法：离屏 + `visibility:hidden`（**仍有布局** ✓），尺寸给足 ✓。 */
    holder.setAttribute('aria-hidden', 'true');
    holder.style.cssText = 'position:absolute;left:-10000px;top:0;width:900px;visibility:hidden;pointer-events:none';
    box.appendChild(holder);
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
    requestMermaid(this.src, this.theme, holder, (svg, err) => {
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
}
let mermaidWidthHint = 800;                                              // 由装饰层在量到容器宽时更新（桶内稳定）
const MERMAID_FENCE = /^(`{3,}|~{3,})[ \t]*mermaid[ \t]*$/i;
/** 扫出全部 mermaid 块：只在**文档变化且含结构字符**时重算（普通打字零成本 ✓）。
 *  块的范围含**两侧围栏行**（整块替换 ⇒ 围栏也一起消失 ✓，与 Typora 的"图表块"观感一致）。 */
function scanMermaidBlocks(doc) {
  const out = [];
  for (let i = 1, open = -1, openLine = null; i <= doc.lines; i++) {
    const line = doc.line(i);
    const t = line.text;
    if (open < 0) {
      if (MERMAID_FENCE.test(t)) { open = i; openLine = line; }
      continue;
    }
    if (isFenceAt(t)) {
      const src = doc.sliceString(doc.line(open + 1).from, line.from - 1);
      out.push({ from: openLine.from, to: line.to, src, lang: 'mermaid' });
      open = -1; openLine = null;
    }
  }
  return out;
}
const mermaidBlocksField = StateField.define({
  create(state) { mmScanCount += 1; return scanMermaidBlocks(state.doc); },
  update(value, tr) {
    mmUpdateCount += 1;
    if (!tr.docChanged) return value;
    /* 与 inlineMarksField 同款守卫（错-32：按**最小可观察输入单元**判，不按成品形态判）：
       mermaid 只对反引号/波浪线/mermaid 这几个字母与换行敏感；普通正文打字直接复用 ✓。 */
    /* 【结构字符集必须"窄而准"·2026-10-11 控制臂实测修正】原来写成字符集
       `[`~mermaid\n\r]` ✗ —— 那等于把 mermaid 拆成 8 个**单字符**：普通正文里敲一个 `i` 或 `a`
       就会判"结构变了" ⇒ **每次打字都全文重扫** ✗（实测：无图表的普通文档打字 20 次，
       `字段重扫次数` 从 1 涨到 7 ✗ —— 这正是"新功能给普通文档加成本"的形态 ✗）。
       正确判据（两层，都要满足才重扫）：
         ① 改动里有**围栏字符**（反引号/波浪线）或换行 —— 这是"围栏能成立"的必要条件 ✓；
         ② 且改动里出现 `mermaid` 这个词（大小写不敏感 ✓）。
       ⇒ 普通正文打字一律不重扫 ✓；敲围栏、改语言、删围栏照样重扫 ✓（② 在 ```` ``` ```` 之后到达时命中 ✓）。 */
    const FENCE_CH = /[`~\n\r]/;
    const hasWord = (s) => /mermaid/i.test(s);
    let touched = false;
    const inBlock = (a, b) => {
      for (let i = 0; i < value.length; i++) { const blk = value[i]; if (a <= blk.to && b >= blk.from) return true; }
      return false;
    };
    try {
      tr.changes.iterChanges((fromA, toA, fromB, toB) => {
        if (touched) return;
        if (inBlock(fromA, toA + (toA === fromA ? 1 : 0)) || inBlock(fromB, toB + (toB === fromB ? 1 : 0))) { touched = true; return; }
        const oldT = tr.startState.doc.sliceString(fromA, toA), newT = tr.state.doc.sliceString(fromB, toB);
        if ((FENCE_CH.test(oldT) || FENCE_CH.test(newT)) && (hasWord(oldT) || hasWord(newT))) touched = true;
      });
    } catch { touched = true; }
    if (!touched) return value;                       // ★ 零扫描（数组身份不变：本字段**不投影**，无需新身份）
    mmScanCount += 1;
    return scanMermaidBlocks(tr.state.doc);
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
    if (head >= b.from && head <= b.to) continue;                       // 编辑态：源码可见
    out.push(Decoration.replace({ widget: mermaidWidget(b.src, b.from, b.to), block: true }).range(b.from, b.to));
  }
  return Decoration.set(out, true);
}
const mermaidDecorations = EditorView.decorations.compute(['selection', mermaidBlocksField], (state) => buildMermaidDecorations(state));

/** 【导出侧接口·2026-10-11】只暴露两件事：预渲染（异步，导出前 await 一次）与取缓存 SVG（同步）。
 *  为什么导出不能自己渲染：mermaid 的 API 在**编辑面**这一侧（懒加载 + strict 配置 ＋ parse 前置 ＋ 容器），
 *  导出再实现一份就是错-4（同功能两份实现）✗。导出只需**同步查缓存** ⇒ 生成器保持同步 ✓。 */
window.mpMermaid = {
  /** 扫 md 里的 mermaid 围栏，逐个渲染进缓存；返回 { 总数, 成功, 失败: [{src, err}] } */
  async prerender(md) {
    const blocks = [];
    const lines = String(md || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*(`{3,}|~{3,})[ \t]*mermaid[ \t]*$/i.exec(lines[i]);
      if (!m) continue;
      const fence = m[1];
      const close = new RegExp('^\\s*' + fence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$');
      const buf = [];
      for (let k = i + 1; k < lines.length; k++) {
        if (close.test(lines[k])) { i = k; break; }
        buf.push(lines[k]);
      }
      const src = buf.join('\n');
      if (src.trim()) blocks.push(src);
    }
    /* 【导出应当用**浅色主题**渲图·2026-10-11 逐页验收实测缺陷】
       原先导出走 `mermaidTheme()`（跟随编辑器深/浅色）✗ ⇒ 暗色主题下导出的 PDF/HTML 里
       图是**暗色填充 + 白字** ✓ —— 屏幕上没问题，**印在白纸上就是一片黑块** ✗
       （实测：白纸、黑标题、正文清晰 ✓，唯独流程图节点是近黑块 ✗，很别扭）。
       ⇒ 导出与打印同口径用**浅色** ✓（与壳层 PRINT_CSS 的"白纸黑字"一致 ✓）；
         编辑面仍跟随主题 ✓（缓存键含主题 ⇒ 两套 SVG 并存，互不干扰 ✓）。 */
    const expTheme = exportDiagramTheme();
    const cacheHits = blocks.filter((s) => svgCache.get(svgKey(s, expTheme))).length;
    const todo = blocks.filter((s) => !svgCache.get(svgKey(s, expTheme)));
    let 成功 = cacheHits, 失败 = [];
    for (const src of todo) {
      /* 串行渲染（与编辑面同一条队列语义 ✓）；每个都等到底，避免导出时图还没出来 */
      const r = await new Promise((resolve) => requestMermaid(src, expTheme, null, (svg, err) => resolve({ svg, err })));
      if (r.svg) 成功 += 1; else 失败.push({ src: src.slice(0, 40), err: String((r.err || '').slice(0, 120)) });
    }
    return { 总数: blocks.length, 成功, 失败, 主题: expTheme };
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

function mathWidget(tex, display, live = false, selected = false) {
  const key = (live ? "L" : display ? "B" : "I") + (selected ? "S" : "") + tex;
  let w = widgetCache.get(key);
  if (w) { widgetCache.delete(key); widgetCache.set(key, w); return w; } // LRU touch
  w = new MathPreview(tex, display, live, selected);
  widgetCache.set(key, w);
  if (widgetCache.size > 256) widgetCache.delete(widgetCache.keys().next().value);
  return w;
}

class MathPreview extends WidgetType {
  constructor(tex, display = false, live = false, selected = false) { super(); this.tex = tex; this.display = display; this.live = live; this.selected = selected; }
  eq(other) { return other.tex === this.tex && other.display === this.display && other.live === this.live && other.selected === this.selected; }
  toDOM() {
    const span = document.createElement("span");
    span.className = this.live && !this.display ? "mp-cm6-math-live-chip"
      : this.live ? "mp-cm6-math-block mp-cm6-math-live"
      : this.display ? "mp-cm6-math-block" : "mp-cm6-math";
    // 【选区态·2026-10-07】公式落在选区里但**光标不在其中**时保持渲染，只加选中底色
    // （原生 ::selection 盖不到 widget 内部字形，必须自带类；色值走主题变量，不写死）。
    if (this.selected) span.className += " mp-math-selected";
    const html = renderMathHTML(this.tex, this.display);
    if (html != null) span.innerHTML = html;
    else span.textContent = this.tex;
    if (this.display) rememberBlockHeight(this.tex, span, this.live); // 挂载后实测高度（live 只进会话变量）
    return span;
  }
  // CM6 契约：estimatedHeight 是数值，-1＝无估计（基类哨兵）；绝不下发 undefined
  //（复核实锤：undefined 使高度图 n<0 判false → NaN → 构造期 viewport 崩）。
  // live 中间态 tex 恒 miss 稳态表 → 回退上一 live 高度（防编辑期间下方内容每键跳）。
  get estimatedHeight() {
    if (!this.display && !this.live) return -1;
    const h = blockHeights.get(this.tex);
    if (h !== undefined) return h;
    return this.live && lastLiveHeight > 0 ? lastLiveHeight : -1;
  }
  ignoreEvent() { return false; } // 点击交给 view → 源码落位
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
  applyEnginePrefs();
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
  const root = document.documentElement;
  const p = mpPrefsAll();
  root.style.setProperty("--mp-island-scale", (p.island / 100).toFixed(3));
  root.style.setProperty("--mp-zoom", (p.zoom / 100).toFixed(4));
  root.dataset.mpStatusbar = p.statusbar ? "1" : "0";
  if (zoomWrap) zoomWrap.style.setProperty("--mp-zoom", (p.zoom / 100).toFixed(4));
  schedulePageWidth();
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
  root.style.setProperty("--mp-page-width", docPx + "px");
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
function mpApplyHostDocDir() {
  try {
    const dir = (typeof window.__mpDocDir === "string" && window.__mpDocDir) ? window.__mpDocDir : "";
    const before = mpDocDir;
    mpSetDocPath(dir);
    if (before !== mpDocDir && view) {
      view.dispatch({ effects: imgBaseBump.of(null) });   // 只做一次、只在目录真变了时做
      view.requestMeasure();
    }
  } catch (e) { console.error("[mp] 文档目录同步失败：", e); }
}
try { window.addEventListener("mp:docdir", mpApplyHostDocDir); } catch { /* 忽略 */ }

/* 【代码块行号·3.0.9】把行号写进**行 DOM 的属性**（`data-mp-n`），数字本身由 CSS 的 ::before 画出来。
 *  为什么这么做（三条硬约束同时满足）：
 *   · **不进内容**：源码与 DOM 文本节点一个字都没加 ⇒ 复制 / `copyRich` / 导出 HTML / PDF /
 *     `mdBodyChunks` 都拿不到行号（判据⑤的红侧是"把行号写进导出件"，这样写根本无从写进去）；
 *   · **性能**：只在行集合变化时写一轮属性（文档变或视口变才跑），不在每键路径上新增扫描；
 *   · **长行折行只算一个号**：号挂在**行元素**上，与视觉行数无关（判据⑥）。
 *  引用区里的围栏块同样有号（`> ``` ` 那批已经成块，这里一视同仁）。 */
const codeLineNoPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.field = null; this.vpKey = ''; this.domCount = -1; this.lastVp = ''; this.wrote = new WeakMap(); this.nums = new Map(); this.apply(view); view.requestMeasure(); }
  /* 【为什么每次 update 都要判】视口外的行没有 DOM ⇒ 属性只能等它被渲染出来再补。CM6 在滚动时
     未必发 `viewportChanged`（长行折行把后面的行推出视口就不会），实测漏号（第 2 行明明在
     `codeLines` 里、DOM 里却一个号都没有）。真正昂贵的不是"判要不要跑"，而是"跑了要遍历谁"：
     `apply()` 只遍历**已渲染的行**（视口规模），不扫全文。
     【★ 2026-10-09 实测·性能】**不许在这里无条件 `requestMeasure()`**：那会让每键多跑两轮完整布局，
     9.4MB 文档上实测把每键 p50 从 **1.4ms 抬到 93.4ms**（比历史全文重扫还差）。
     只有"视口真的换了"才值得请求一次测量，其余情况交给内置的 measure 阶段。 */
  update(u) {
    this.apply(u.view);
    const vp = u.view.viewport ? u.view.viewport.from + '-' + u.view.viewport.to : '';
    if (vp !== this.lastVp) { this.lastVp = vp; u.view.requestMeasure(); }
  }
  /* 【为什么还要挂 measure·2026-10-09 实测】只靠 update 会**漏挂**：CM6 在没有事务时也会自己
     重建/补渲染行 DOM（视口渲染、行高变化后的重排），此时没有任何 update 可挂。
     `requestMeasure` 的回调在每轮布局后跑（CM6 保证此时 DOM 与文档已对齐）。 */
  measure() { this.apply(this.view); }
  /* 【门控·性能纪律】measure 每轮布局都跑 ⇒ 不能每轮全量扫。三个输入变了才重扫：
     ① 文档变（`lineStylesField` 换了新对象）② 视口变（`view.viewport` 是新的）③ 已渲染行数变。
     三者都没变 ⇒ 上一轮挂的属性仍然成立，直接返回。 */
  apply(view) {
    if (!view || !view.contentDOM || !view.state) return;   // 视图尚未挂载（构造期第一跑）
    /* ══ 【2026-10-09 修·光标停在开围栏上行号整块错位】══════════════════════════════════
     *  改前的对位是"**靠 `.mp-fence` 计数**"：`if (el.classList.contains('mp-fence')) fenceNo += 1;`
     *  —— 而 `.mp-fence` 这个类**在光标落到该行时会消失**（该行切成源码态）。
     *  实测：光标停在开围栏行时，容器 dump 是
     *    `cm-line cm-activeLine mp-code`(```js) / `mp-code`(const first) / `mp-code`(空行)
     *    / `mp-code`(const second) / `mp-fence mp-code`(```)
     *  开围栏丢了 `mp-fence` ⇒ `fenceNo` 少算 ⇒ 5 行里只有空行拿到号（`普通块号=[null,null,"2",null,null]`），
     *  `byBlock` 的"号序 1..N"判据跟着红。
     *  另外还有一个**更早就存在的隐患**：三输入门（字段对象 / 视口键 / 已渲染行数）在"光标移动导致
     *  行 DOM 被重建"时**三个输入都没变** ⇒ 直接早退 ⇒ 新元素上的号永远补不回来（4/5 行缺号就是这个）。
     *
     *  现在的口径：
     *   ① **不猜结构**——每个已渲染行元素用它**自己的位置**换文档行号（`view.posAtDOM(el, 0)`），
     *      再拿这个行号去 `lineStylesField.codeLines` 的表里查号；查不到就把号摘掉。
     *      （可见行 `posAtDOM` 可用性有探针自证：抽样 30 条成功 30、抛错 0。）
     *   ② 用 **WeakMap 记住"这个元素已经处理过"**：CM6 重建行 DOM 时元素是新的 ⇒ 自动重算；
     *      元素没换 ⇒ 一次 WeakMap 查表就跳过（不做布局读取）。字段对象一变（文档改了）整表作废重算。
     *  ⇒ 既不再依赖 `.mp-fence`，也不怕"三个输入都没变但 DOM 换了"。 */
    const list = view.state.field(lineStylesField, false)?.codeLines || [];
    const fieldObj = view.state.field(lineStylesField, false);
    if (fieldObj !== this.field) {
      this.field = fieldObj;
      this.wrote = new WeakMap();                                  // 文档变了 ⇒ 全部重算
      this.nums = new Map(list.map((it) => [it.line.number, String(it.n)]));
    }
    const nums = this.nums || new Map();
    const domLines = [];
    for (const el of view.contentDOM.children) {
      if (el.nodeType === 1 && el.classList && el.classList.contains('cm-line')) domLines.push(el);
    }
    this.domCount = domLines.length;
    for (const el of domLines) {
      /* 【★ 2026-10-09 实测·号被抹掉的真因】CM6 的行属性是**由它自己按模型写**的：
         当某一行的装饰集变化（实测：光标落到开围栏行 ⇒ 该块切源码态）时，它会**重新应用**该行的属性，
         于是**我们自己挂的 `data-mp-n` 被抹掉**——而元素对象没换（WeakMap 命中）⇒ 旧代码认为"已处理"
         ⇒ 永远不补写。现场：同一次滚动里刚滚过去读到 `[1,2,3]`，1.2 秒后变成 `[null,2,null]`。
         所以"跳过"的条件不能只是"处理过"，还要**属性仍然正确**：多读一次 `getAttribute`
         （纯属性读取，不触发任何布局），不对就按缓存值补写回去，不必重新解析位置。 */
      const cached = this.wrote.get(el);
      if (this.wrote.has(el)) {
        const cur = el.getAttribute('data-mp-n');
        if (cur === cached || (cur === null && cached === null)) continue;
        if (cached === null) { if (cur !== null) el.removeAttribute('data-mp-n'); }
        else if (cur !== cached) el.setAttribute('data-mp-n', cached);
        continue;
      }
      let ln = -1;
      try { ln = view.state.doc.lineAt(view.posAtDOM(el, 0)).number; } catch { ln = -1; }
      /* 【保守规则·2026-10-09】解析失败 ⇒ **什么都不做**（不写、不摘、也不记进 WeakMap，下一轮再试）。
         实测教训：改前"解析失败当非代码行 ⇒ removeAttribute"会让**已经写对的号被摘掉**——
         同一次滚动里，刚滚过去读到 `[1,2,3]`，1.2 秒后变成 `[null,2,null]`（现场 dump 见 LOG §10）。
         宁可留一个旧号，也不摘掉正确的号。 */
      if (ln < 0) { if (globalThis.__mpLnDebug) (globalThis.__mpLn = globalThis.__mpLn || []).push({ why: 'posAtDOM-fail', n: null }); continue; }
      const want = nums.has(ln) ? nums.get(ln) : null;
      if (want !== null) {
        if (el.getAttribute('data-mp-n') !== want) el.setAttribute('data-mp-n', want);
      } else {
        /* 摘号要多一道确认：DOM 文本与该行文档源码一致，才认定"这行确实不再是代码行"。
           （引用区代码行的源码带 `> ` 前缀、DOM 里被隐藏 ⇒ 文本不相等 ⇒ 不动它，避免误摘。） */
        const srcText = view.state.doc.line(ln).text;
        const domText = el.textContent || '';
        if (domText === srcText || domText.trim() === srcText.trim()) {
          if (el.hasAttribute('data-mp-n')) el.removeAttribute('data-mp-n');   // 反向清理：曾经是代码行、现在不是了
        } else if (globalThis.__mpLnDebug) {
          (globalThis.__mpLn = globalThis.__mpLn || []).push({ why: 'keep-stale', ln, src: srcText.slice(0, 24), dom: domText.slice(0, 24) });
        }
      }
      if (globalThis.__mpLnDebug) (globalThis.__mpLn = globalThis.__mpLn || []).push({ ln, want, cls: String(el.className).slice(0, 30) });
      this.wrote.set(el, want);
    }
  }
});

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


/* ══ A1 · 按脏行增量的公共机械（v2；第 1 步：只被 mathSpansField 使用）══════════════════
 *  v1→v2 修正（2026-10-08，被 a1-verify 240 步对照器在第 1 步抓到）：
 *    span 里**不只有 from/to**，还有 `texFrom`（TeX 真正开始的绝对位置）。v1 只把 from/to 换算成绝对，
 *    `texFrom` 仍是切片内的相对值 ⇒ 对照器报 `firstCharDiff=-1`（from/to/tex/display 全同、只有 texFrom 差 130）。
 *    教训：**凡是位置字段都要一起 map/offset**，只挑显眼的两个改，第三个会静默错。
 *  正确性依据：四个扫描器都是"逐行 + 携带状态"的确定性函数；只要**入口状态与行文本**都与上一轮相同，
 *  其余输出就与全量重扫逐字节相同。故缓存按行存 (entryState, exitState, products, fingerprint)，
 *  一旦某行重算后的 exitState 与缓存相等 ⇒ 其后缀可证明相同，直接沿用（位置经 mapPos 平移）。
 *  两条兜底：① 行文本指纹不符 ② 入口态不干净且扩不到结构起点 ⇒ 全文重扫（宁慢不错）。 */

/** 行指纹：长度 + 首尾 16 字符（不做全行哈希 —— 357k 行档全行哈希会自己成为瓶颈）。 */
const a1Fp = (t) => (t.length <= 32 ? t.length + ':' + t : t.length + ':' + t.slice(0, 16) + ':' + t.slice(-16));

/** 取证口用：整篇强制重扫的待办计数（四个字段各消费一次）。 */
let mpA1ForcePending = 0;

/** ★ 把 span 的**所有位置字段**统一换算（from / to / texFrom）—— 少一个就是静默错。 */
const a1MapSpan = (s, f) => ({
  ...s,
  from: f(s.from), to: f(s.to),
  texFrom: (typeof s.texFrom === 'number' ? f(s.texFrom) : s.texFrom),
});

/** 事务的脏行区间（1-based 闭区间，已向外扩 1 行）。★ fromB/toB 是**新文档**坐标。
 *  实证：@codemirror/state ChangeSet.apply → doc.replace(fromB, …)，doc 是被逐段改写的旧文档，
 *  到第 k 段时已与新文档一致 ⇒ fromB/toB 落在新文档。用 fromA/toA 会把脏行算到别处且**不报错**。 */
function a1DirtyLines(tr) {
  const doc = tr.state.doc, out = [];
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const a = doc.lineAt(Math.min(fromB, doc.length)).number;
    const b = doc.lineAt(Math.min(toB, doc.length)).number;
    out.push([Math.max(1, a - 1), Math.min(doc.lines, b + 1)]);
  });
  if (!out.length) out.push([1, Math.min(doc.lines, 1)]);        // 保险：空变更也要有一行脏
  out.sort((x, y) => x[0] - y[0]);
  const merged = [out[0].slice()];
  for (let i = 1; i < out.length; i++) {
    const last = merged[merged.length - 1];
    if (out[i][0] <= last[1] + 1) last[1] = Math.max(last[1], out[i][1]); else merged.push(out[i].slice());
  }
  return merged;
}

/** 行级"跨行结构"小状态机：只回答"第 n 行的入口是否干净"（不在 $ / 单$ 跨行 / 围栏里）。
 *  刻意保持极简：只看行首（与 scanMathSpans 的开合口径同源但更宽松）——判不准就报不干净 ⇒ 走降级，不会算错。 */
function a1LineStates(doc) {
  const st = new Array(doc.lines + 2);                            // st[n] = 第 n 行的入口是否干净
  let inDollar = false, inFence = false;
  for (let n = 1; n <= doc.lines; n++) {
    st[n] = !inDollar && !inFence;
    const t = doc.line(n).text, tt = t.trim();
    if (/^\s*(```|~~~)/.test(t)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (inDollar) { if (tt.endsWith('$') && tt.length >= 2) inDollar = false; continue; }
    if (/^\s*\$\$/.test(t) && !/^\s*\$\$.*\$\$\s*$/.test(t)) inDollar = true;
  }
  st[doc.lines + 1] = !inDollar && !inFence;                      // 文末状态（供"整篇干净"判定）
  return st;
}

/** 从 (doc, cache, dirty) 增量重算 math spans。cache = { fp:[], prod:[], spansOf:[] }（下标 = 行号-1）
 *  返回 { spans, reusedFrom, fullRescan, reason }。 */
function a1ScanMath(doc, cache, dirty, tr) {
  const states = a1LineStates(doc);
  const d0 = dirty[0][0], d1 = dirty[dirty.length - 1][1];
  /* 入口必须干净；不干净就向前扩（最多 200 行，避免病态长块把收益吃光） */
  let start = d0;
  let guard = 0;
  while (start > 1 && !states[start] && guard++ < 200) start--;
  if (!states[start]) return { spans: scanMathSpans(doc), fullRescan: true, reason: 'entry-state-dirty', reusedFrom: -1 };

  /* 切片 doc：只含 [start-1, d1+1] 行（多带一行做缓冲），位置相对切片起点 */
  let base = start > 1 ? doc.line(start - 1).to + 1 : 0;
  let endLine = Math.min(doc.lines, d1 + 1);
  /* ══ 【2026-10-09 修·静默错根因】窗口必须**两端都切在结构之外** ══════════════════════
   *  改前只做两件事：① `start` 按 `a1LineStates` 往前扩到"入口干净"；② 要求 `states[endLine+1]`
   *  干净。**这两条都不够**：`a1LineStates` 是"看行首"的粗状态机，与 `scanMathSpans` 真实的
   *  开合口径**不等价**——实测（对抗复核 `a1-red`，1539 例单步编辑穷举，5 例不一致）：
   *  文档 `$$\na\n$$\n$$\nb\n$$` 在**第 3 行行尾**插一个字符，全量扫描把第一块一直开到第 6 行，
   *  而窗口（第 1–5 行）里那块**没有闭合** ⇒ 窗口产出残缺、前缀/后缀照旧复用 ⇒ **整条 span 丢失**。
   *  【现在的口径】不猜状态，**用扫描器自己的产出来判断窗口有没有被切断**：
   *   · 有 span 触到窗口末尾（`to >= sliceDoc.length`）⇒ 尾部可能被切 → 把 `endLine` 往后扩；
   *   · 有 span 从窗口首字符起（`from === 0`）⇒ 头部可能被切 → 把 `start` 往前扩；
   *   · 扩不动（到文档边界）或超出上限 ⇒ **全文重扫**（宁慢不错）。
   *  这样"窗口闭合"的判据与真实扫描语义同源，不再依赖第二个状态机。 */
  /* 【保守门·2026-10-09】脏区邻域（±2 行）里只要出现**任何数学/代码相关字符**，就整体重扫。
     为什么要这道门：`scanMathSpans` 对**未闭合**的 `$$` 块会整块不认（当成行内文本），
     于是"窗口里那一块产出为空"⇒ 上面那套"用产出判断有没有被切断"**看不出来**
     （对抗复核：`$$\na\n$$\n$$\nb\n$$` 第 3 行插一个字符 ⇒ 整条 span 丢失；随机 fuzz 还能找出更多形态）。
     收紧后的口径：邻域里**不得出现** `$`、反引号、`~`、`<!--` —— 出现即判定"该区域结构不确定"，
     整体重扫（宁慢不错）。纯文本/大图文档（本机性能夹具就是这种：单行内联大图、base64 里没有这些字符）
     不受影响，增量照常生效。 */
  {
    const lo = Math.max(1, start - 2), hi = Math.min(doc.lines, endLine + 2);
    for (let n = lo; n <= hi; n++) {
      const t = doc.line(n).text;
      if (t.indexOf('$') >= 0 || t.indexOf('`') >= 0 || t.indexOf('~') >= 0 || t.indexOf('<!--') >= 0) {
        return { spans: scanMathSpans(doc), fullRescan: true, reason: 'math-chars-nearby', reusedFrom: -1 };
      }
    }
  }

  let rel = null;
  {
    let guard = 0;
    for (;;) {
      const sliceText = doc.sliceString(base, doc.line(endLine).to);
      const sliceDoc = Text.of(sliceText.split('\n'));
      const r = scanMathSpans(sliceDoc);
      const cutTail = r.some((sp) => sp.to >= sliceDoc.length);
      const cutHead = r.some((sp) => sp.from === 0);
      if (!cutTail && !cutHead) { rel = { r, base, endLine }; break; }
      if (cutHead && start > 1 && guard++ < 500) {
        start -= 1;
        base = start > 1 ? doc.line(start - 1).to + 1 : 0;
        continue;
      }
      if (cutTail && endLine < doc.lines && guard++ < 500) { endLine += 1; continue; }
      return { spans: scanMathSpans(doc), fullRescan: true, reason: 'window-not-closed', reusedFrom: -1 };
    }
  }
  const toAbs = (p) => p + base;

  const spans = [];
  const keep = (p) => tr.changes.mapPos(p, 1);                    // 旧缓存位置 → 新文档位置
  for (let n = 1; n < start; n++) {                               // 前缀：沿用缓存
    for (const s of (cache.spansOf[n - 1] || [])) spans.push(a1MapSpan(s, keep));
  }
  for (const s of rel.r) spans.push(a1MapSpan(s, toAbs));         // 窗口：切片重扫（相对 → 绝对）

  /* 后缀能不能沿用？要求：① 窗口尾部已回到干净态 ② 其后每一行指纹与缓存一致 */
  let reusedFrom = -1;
  if (endLine < doc.lines && states[endLine + 1]) {
    let ok = true;
    for (let n = endLine + 1; n <= doc.lines; n++) {
      if (cache.fp[n - 1] !== a1Fp(doc.line(n).text)) { ok = false; break; }
    }
    if (ok) {
      for (let n = endLine + 1; n <= doc.lines; n++) {
        for (const s of (cache.spansOf[n - 1] || [])) spans.push(a1MapSpan(s, keep));
      }
      reusedFrom = endLine + 1;
    }
  }
  if (reusedFrom < 0) return { spans: scanMathSpans(doc), fullRescan: true, reason: 'suffix-fp-mismatch', reusedFrom: -1 };

  spans.sort((a, b) => a.from - b.from || a.to - b.to);
  return { spans, reusedFrom, fullRescan: false, reason: null };
}

const mathSpansField = StateField.define({
  create(state) {
    return { spans: scanMathSpans(state.doc), version: 0, _c: { fp: [], spansOf: [] }, _incr: { reusedFrom: -1, fullRescan: 1 } };
  },
  update(value, tr) {
    /* ★ forceFullPending 检查必须在 docChanged 短路**之前** */
    if (typeof mpA1ForcePending !== 'undefined' && mpA1ForcePending > 0) {
      mpA1ForcePending--;
      return { spans: scanMathSpans(tr.state.doc), version: value.version + 1, _c: value._c, _incr: { reusedFrom: -1, fullRescan: 1 } };
    }
    if (!tr.docChanged) return value;
    const doc = tr.state.doc, cache = value._c || { fp: [], spansOf: [] };
    const dirty = a1DirtyLines(tr);
    const r = a1ScanMath(doc, cache, dirty, tr);
    /* 重建按行归档的缓存（只对"已算过且未被平移影响"的行归档；简化：只归档窗口与后缀） */
    const spansOf = new Array(doc.lines);
    for (const s of r.spans) {
      const n = doc.lineAt(s.from).number;
      (spansOf[n - 1] || (spansOf[n - 1] = [])).push({ from: s.from, to: s.to, tex: s.tex, display: s.display, texFrom: s.texFrom });
    }
    const fp = new Array(doc.lines);
    for (let n = 1; n <= doc.lines; n++) fp[n - 1] = a1Fp(doc.line(n).text);
    return { spans: r.spans, version: value.version + 1, _c: { fp, spansOf }, _incr: { reusedFrom: r.reusedFrom, fullRescan: r.fullRescan ? 1 : 0, reason: r.reason, dirty: dirty.length } };
  },
});

function scanMathSpans(doc) {
  const spans = [];
  const fences = [];
  let openDollar = null; // 跨行形态：`$$内容…` 开 → `…内容$$` 合（见下）
  let openSingle = null; // 【单 $ 跨多行】`$\begin{…}` 开 → 以 `$` 结尾的行合（引用区里 LLM 生成的推导块常见）
  let tentativeFrom = 0; // spans 中自该下标起，属于"未闭合区"的临时行内 span
  let openSingleFrom = 0, openSingleTexFrom = 0;
  /** 行内 `$…$` 扫描（与主路径同口径） */
  function pushInline(line) {
    const re = /(^|[^\\$])\$([^$\n]+)\$/g;
    let m;
    while ((m = re.exec(line.text))) {
      const start = line.from + m.index + m[1].length;
      spans.push({ from: start, to: start + m[2].length + 2, tex: m[2], display: false, texFrom: start + 1 });
    }
  }
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const t = line.text;
    // ① 已开启跨行形态：本行只要「以 $$ 收尾」就闭合（含整行只有 $$ 的情况，允许尾随空白）
    /* 【单 $ 跨多行·引用区】各行的 `> ` 前缀要剥掉再拼 tex，否则 KaTeX 会吃到 '>'。 */
    const qm = /^[ \t]*(?:>[ \t]?)+/.exec(t);
    const qOff = qm ? qm[0].length : 0;
    const qText = t.slice(qOff);
    if (openSingle) {
      const body = qText;
      if (body.endsWith("$")) {
        openSingle.parts.push(body.slice(0, -1));
        const tex = openSingle.parts.join("\n").trim();
        openSingle = null;
        if (tex) spans.push({ from: openSingleFrom, to: line.to, tex, display: true, texFrom: openSingleTexFrom });
      } else openSingle.parts.push(body);
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
        const tex = body.slice(1, close).trim();
        if (tex) spans.push({ from: line.from + qOff + lead, to: line.from + qOff + lead + close + 1, tex, display: true, texFrom: line.from + qOff + lead + 1 });
        continue;
      }
      const first = body.slice(1);
      openSingle = { parts: [first] };
      openSingleFrom = line.from + qOff + lead;
      openSingleTexFrom = line.from + qOff + lead + 1;
      continue;
    }
    if (openDollar) {
      const cm = /\$\$\s*$/.exec(t);
      if (cm) {
        const texEnd = line.from + cm.index;
        const raw = doc.sliceString(openDollar.texFrom, texEnd);
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
    const one = /^\$\$(.+)\$\$\s*$/.exec(t);
    if (one && one[1].trim()) {
      const content = one[1];
      const lead = content.length - content.trimStart().length;
      spans.push({ from: line.from, to: line.to, tex: content.trim(), display: true, texFrom: line.from + 2 + lead });
      continue;
    }
    // 【2026-10-07 补形态】`$$` 行首带内容、`$$` 行尾带内容的**跨行**写法（Typora/MathJax 标准）：
    //     $$\begin{aligned}…\\
    //     …\end{aligned}$$
    //   旧扫描只认「整行 $$」围栏对与「单行 $$…$$」——这种形态两条都不沾，整段当普通文本
    //   （实机取证：第 4675–4678 行 katex=0/mathSpan=0，而紧邻段落的行内公式 katex=6）。
    const om = /^\s*\$\$(?=\S)/.exec(t);
    if (om) {
      const rest = t.slice(om[0].length);
      if (!rest.endsWith("$$")) {
        openDollar = { from: line.from, texFrom: line.from + om[0].length };
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
        spans.push({ from: start, to: start + m2[0].length, tex: m2[1].trim(), display: false, texFrom: start + 2 });
      }
    }
    pushInline(line);
  }
  for (let i = 0; i + 1 < fences.length; i += 2) {
    const a = fences[i], b = fences[i + 1];
    if (b.n - a.n < 1) continue;
    const raw0 = doc.sliceString(doc.line(a.n).to + 1, doc.line(b.n).from);
    /* 引用区里的块：逐行剥掉 `> ` 前缀再拼 tex（前缀长度按每行自己算，兼容 `> > ` 与 `>\t`）。 */
    const quoted = !!(a.qOff || b.qOff) || /^[ \t]*(?:>[ \t]?)+\S/.test(raw0);
    const raw = quoted ? raw0.split("\n").map((l) => l.replace(/^[ \t]*(?:>[ \t]?)+/, "")).join("\n") : raw0;
    const tex = raw.trim();
    if (!tex) spans.push({ from: a.from, to: b.to, tex: "", display: true, texFrom: a.to + 1 });
    else {
      // texFrom＝去空白后源码首字符的文档坐标（KaTeX sourceMap 的 loc 相对 trim 后的 tex 串）
      const lead = raw.length - raw.trimStart().length;
      spans.push({ from: a.from, to: b.to, tex, display: true, texFrom: a.to + 1 + lead });
    }
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
const mathDecorations = EditorView.decorations.compute(["selection", mathSpansField], (state) => {
  const { spans } = state.field(mathSpansField);
  const out = [];
  const head = state.selection.main.head;
  const headIn = (s) => state.selection.ranges.some((r) => r.head >= s.from && r.head <= s.to);
  const inSel = (s) => state.selection.ranges.some((r) => r.from <= s.to && r.to >= s.from);
  for (const s of spans) {
    if (s.display) continue; // 块级走 blockMathField（StateField 直供）
    const sel = inSel(s);
    if (headIn(s)) {
      if (head >= s.from && head <= s.to && s.tex) {
        // 【用户裁定·Typora 行为】编辑预览＝浮动层（absolute 浮于源码上方），
        // 不占排版流——点开公式时正文/后续段落零移动；只有源码展开本身改变
        // 行内容时才重排（Typora 同）。原 block widget 方案会把预览插进排版流，
        // 每次点开都推挤后续内容。
        const line = state.doc.lineAt(s.to);
        out.push(Decoration.widget({ widget: new InlineFloatWidget(s.tex, false, s.from, s.to, s.texFrom), side: 1 }).range(s.to));
      }
      continue;
    }
    out.push(Decoration.replace({ widget: mathWidget(s.tex, false, false, sel) }).range(s.from, s.to));
  }
  return Decoration.set(out, true);
});

/** 块级公式投影：StateField 直供（W1：compute 载 block:true 是官方点名反模式——
 *  派生源在选区变化时整组重比对块结构；StateField 直供 + estimatedHeight 是
 *  官方块级装饰的唯一受支持形态）。**光标（head）所在**的块显源码，选区里其余块保持渲染
 *  ＋选中底色，与行内同规则（D8）。
 *  注意：create 里不许读别的 field（CM6 规则）——直接重扫；update 读
 *  mathSpansField 依赖扩展序（mathSpansField 排在前）。 */
function buildBlockMath(state, spans) {
  const out = [];
  const head = state.selection.main.head;
  const headIn = (s) => state.selection.ranges.some((r) => r.head >= s.from && r.head <= s.to);
  const inSel = (s) => state.selection.ranges.some((r) => r.from <= s.to && r.to >= s.from);
  for (const s of spans) {
    if (!s.display) continue;
    if (headIn(s)) {
      // 【Typora 块公式编辑语义】光标在块内＝编辑中：源码可见（不加 replace）＋
      // 浮动预览（Typora：浮于真文本之上不占排版流——旧块级 widget 在流内，
      // 每次点开推挤后续段落）。光标不在块内的选区穿越：只显源码不挂预览。
      // 【居中对齐·2026-10-07】渲染态是 displayMode（KaTeX .katex-display 居中）；
      // 展开源码若走默认左对齐，点击瞬间公式会"居中→左"横跳（用户实测烦人）。
      // 故展开期间给 span 覆盖的每一行挂 mp-math-src＝text-align:center，令源码与渲染体同轴。
      // 行装饰纯视觉：不改文档、不进高度图、不改键位。
      const firstLine = state.doc.lineAt(s.from).number;
      const lastLine = state.doc.lineAt(s.to).number;
      for (let n = firstLine; n <= lastLine; n++) out.push(Decoration.line({ class: "mp-math-src" }).range(state.doc.line(n).from));
      if (head >= s.from && head <= s.to && s.tex) {
        out.push(Decoration.widget({ widget: new InlineFloatWidget(s.tex, true, s.from, s.to, s.texFrom), side: 1 }).range(s.to));
      }      continue;
    }
    out.push(Decoration.replace({ widget: mathWidget(s.tex, true, false, inSel(s)), block: true }).range(s.from, s.to));
  }
  return Decoration.set(out, true);
}
const blockMathField = StateField.define({
  create(state) { return buildBlockMath(state, scanMathSpans(state.doc)); },
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value;
    return buildBlockMath(tr.state, tr.state.field(mathSpansField).spans);
  },
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
  const rec = mathPass ? spans.find((x) => x.display && x.tex && x.from === mathPass.spanFrom) : null;
  // 【目标列纪律·2026-10-07 实测缺陷修复】目标列只在**新一轮纵向移动**时采集一次；
  // 之后即使某一步被钳到短行行尾（或走过内容内部的原生移动），目标列也不改写——
  // 否则"到底了再往回走"回不到原列。
  // 实测（修前）：起点 col30 → ↑↑（穿块）→ 落"短行。"行尾(col3) → ↓↓ → 停在 **col3**，原列 30 永久丢失；
  // 多行内容块：起点 col2 → 逐行走过内容 → 出块落 col5（内容末列被当成了新目标列）。
  // 判定"同一轮"：光标仍在我们上一次落点上，**或**仍停在记着的那个块内（原生在块内走也算同一轮）。
  const sameRun = mathPass && rec && (mathPass.lastPos === sel.head || (sel.head >= rec.from && sel.head <= rec.to));
  const goalCol = sameRun ? mathPass.goalCol : col;

  // ③ 出块：已在块**内容**的首行（↑）/ 末行（↓）→ 越过围栏，直接到块外相邻行，列用**目标列**。
  //    【为何要越过围栏】围栏行（`$$`）是块的装饰边界，不是内容：Typora 实机里它们根本不参与停靠
  //    （第一跳落内容行末、第二跳直接出块）。把它们当停靠点会让"穿过一个 3 行块"要按 4 次。
  if (rec) {
    const s = rec;
    {
      const openLine = st.doc.lineAt(s.from);
      const closeLine = st.doc.lineAt(s.to);
      const first = openLine.number === closeLine.number ? openLine.number : openLine.number + 1;
      const last = openLine.number === closeLine.number ? closeLine.number : closeLine.number - 1;
      const exitUp = dir < 0 && cur.number === first;
      const exitDown = dir > 0 && cur.number === last;
      if (exitUp || exitDown) {
        const targetNo = exitUp ? openLine.number - 1 : closeLine.number + 1;
        if (targetNo >= 1 && targetNo <= st.doc.lines) {
          const t = st.doc.line(targetNo);
          const pos = t.from + Math.min(goalCol, t.length);
          mathPass = { spanFrom: s.from, goalCol, lastPos: pos };
          view.dispatch({ selection: { anchor: pos }, userEvent: "select", scrollIntoView: true });
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
  //    单行形态 `$$x$$` 没有独立内容行，退化为落块首/末。
  const openLine = st.doc.lineAt(best.from);
  const closeLine = st.doc.lineAt(best.to);
  const oneLine = openLine.number === closeLine.number;
  const pos = dir < 0
    ? (oneLine ? best.to : closeLine.from - 1)
    : (oneLine ? best.from : openLine.to + 1);
  mathPass = { spanFrom: best.from, goalCol, lastPos: pos };
  view.dispatch({ selection: { anchor: pos }, userEvent: "select", scrollIntoView: true });
  return true;
}
let mathPass = null; // { spanFrom, goalCol, lastPos }：本轮纵向移动穿过的块 + 目标列 + 上次落点
let blockPassDir = 0; // 上一个纵向方向（±1）：方向一变就重采目标列（见 verticalIntoMermaid 的实测缺陷）

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
        view.dispatch({ selection: { anchor: pos }, userEvent: "select", scrollIntoView: true });
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
  view.dispatch({ selection: { anchor: pos }, userEvent: "select", scrollIntoView: true });
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

function scanLineStyles(doc) {
  const headings = [];
  const styled = []; // { line, cls }
  const hrs = []; // 水平分割线（---/***/___ 整行）
  const fenceLines = []; // ``` 围栏行（阅读态压扁隐藏）
  const codeLines = [];  // 【代码块行号】{ line, n }——**内容行**（不含围栏符本身），n 从 1 起、每块重数
  let fence = false;
  let codeN = 0;         // 当前代码块的计数（进块清 0，出块也清 0 ⇒ 每个块各自从 1 开始）
  let mathPending = false; // 正在一个 `$$…` 待闭合块内（居中稳定用，见下）
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const t = line.text;
    // 【居中稳定·2026-10-07】块公式**围栏行/待闭合行**也挂 mp-math-src：
    // 渲染态（KaTeX displayMode）是居中，源码展开也必须居中；若只在"span 被识别"时才居中，
    // 打字过程中会出现"居中↔左对齐"横跳（实测：单独 `$$` 左对齐、配对后居中、再补 `$$` 变
    // `$$$$` 又退回左对齐）。判据与 scanMathSpans 同源但只做首尾轻判，**塞进本次已有遍历**，
    // 不新增全文扫描（性能纪律）。
    const tt = t.trim();
    if (mathPending) {
      styled.push({ line, cls: "mp-math-src" });
      // 收尾行 或 **空行** → 结束待闭合态（否则一个手滑的 `$$` 会把其后全文都居中；
      // 真正已闭合的多行块由 buildBlockMath 按 span 逐行居中，不依赖这里）
      if (tt === "" || (tt.endsWith("$$") && tt.length >= 2)) mathPending = false;
    } else if (/^\s*\$\$/.test(t) && !/^\s*\$\$.*\$\$\s*$/.test(t)) {
      styled.push({ line, cls: "mp-math-src" });
      mathPending = true;
    } else if (/^\s*\$\$/.test(t)) {
      // 只有**行首**就是 $$ 的行才居中（`$$x$$`、`$$…` 开围栏）。
      // 【2026-10-07 紧急修正】原判据还含 `endsWith("$$")` ⇒ 正文段落只要行尾出现
      // `$$s$$` 就整行居中（用户实测：一整段「终章底本…（见附录 A）。$$s$$」全被居中）＝重大衰退。
      // 行尾收尾的围栏行由"待闭合态/已识别 span"覆盖，不需要靠 endsWith 兜。
      styled.push({ line, cls: "mp-math-src" });
    }
    /* 【引用区围栏·2026-10-08】围栏判据也必须走**唯一前缀判据** `tableLead()`：
       `> ```js ` 这种引用区里的代码块此前被前缀挡住 ⇒ 不成块（行样式与行内标记两处都要按内容判）。
       去掉前缀后再判围栏，于是引用区里的代码块与正文里的行为完全一致（`mp-code`/`mp-fence` 都落上）。
       【ARCH §3-①】判据函数收敛到 `tables.js` 的 `isFenceAt()`（与 `scanInlineMarks` 同源）。 */
    const leadLs = tableLead(t);
    const cLs = leadLs.off ? t.slice(leadLs.off) : t;
    /* 【引用区围栏·竖条连续·2026-10-08】围栏行与代码行**必须同时保留引用视觉**：
       只给 `mp-code` 的话 `.mp-quote` 的 `border-left: 3px solid var(--mp-quoteBar)` 不生效
       ⇒ 引用竖条/底色在这几行断开（checklist §7 结构烟测发现：引用区围栏行 blw=0、
       代码行只有行号那条 1px，而相邻普通引用行是 3px；类名与**非引用区**围栏块完全一样 ⇒ 引用上下文整个丢失）。
       两类共存：`mp-code`（等宽/代码底色）+ `mp-quote mp-quote-dN`（竖条/缩进）。
       层级只按**前缀**里的 `>` 个数算（不数内容里的 `>`，代码块里出现 `>` 很常见）。 */
    const qDepthLs = leadLs.off ? Math.min(3, (leadLs.q.match(/>/g) || []).length) : 0;
    const qClsLs = qDepthLs ? " mp-quote mp-quote-d" + qDepthLs : "";
    if (isFenceAt(cLs)) {
      fenceLines.push(line);
      fence = !fence;
      codeN = 0;                                       // 进块/出块都归零 ⇒ 每块从 1 重新计数
      styled.push({ line, cls: "mp-code" + qClsLs });
      continue;
    }
    if (fence) {
      codeN += 1;
      /* 【行号·3.0.9】只记录"第几行"，**不写进源码文本**：数字由渲染层（行属性 + CSS 计数器）画，
         因此复制/导出/`mdBodyChunks` 都拿不到它（硬判据⑤）。空行也占一个号（Typora 实测口径）。 */
      codeLines.push({ line, n: codeN });
      styled.push({ line, cls: "mp-code" + qClsLs });
      continue;
    }
    const hm = /^(#{1,6})([ \t]*)(?=\S|$)/.exec(t);
    if (hm && hm[0].trim()) {
      headings.push({ from: line.from, to: line.from + hm[1].length + (hm[2] ? Math.min(hm[2].length, 1) : 0), level: hm[1].length });
      styled.push({ line, cls: "mp-h" + hm[1].length });
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(t)) { hrs.push(line); continue; }
    if (/^\s*>/.test(t)) {
      // 【A7-D4】嵌套引用分级：> 计数→d1/d2/d3+（缩进递进；竖线由主类画一条）
      const depth = Math.min(3, (t.match(/>/g) || []).length);
      styled.push({ line, cls: "mp-quote mp-quote-d" + Math.max(1, depth) });
    }
  }
  return { headings, styled, hrs, fenceLines, codeLines };
}
const lineStylesField = StateField.define({
  create(state) { return { ...scanLineStyles(state.doc), tables: scanTables(state.doc) }; },
  /* 【超大文档打字性能·2026-10-10（`huge-doc`：10 万行 P50 **727ms** ✗，延迟随总行数**线性增长**）】
     这两个扫描器只对**结构字符**敏感（行首 `#` / 围栏 / `|` / `$$` / 分隔线 / `>` / 列表标记）
     —— 行样式、表格、围栏、公式**全由它们决定** ✓。于是：本次改动若**没碰到任何结构字符**
     （新旧文本逐行轻判 ✓）⇒ 直接**复用**上一份结果 ✓（普通正文打字＝绝大多数按键 ⇒ 成本与文档长度
     **解耦** ✓）；一旦碰到结构字符 ⇒ 照旧全文重扫 ⇒ 行为与今天**逐字节一致** ✓（保守、可回归 ✓）。
     成本：`sliceString` 只取**改动范围**（O(改动) ✓），不随文档增长 ✓。 */
  update(value, tr) {
    if (!tr.docChanged) return value;
    /* 【判据必须覆盖"部分输入"·2026-10-10（第二轮回退定位）】原来按"**整行**是否以结构前缀起手"判 ✗ ——
       而按键/输入法是**逐字符**送进来的（敲围栏时每次改动只是单个反引号 ✗）⇒ 单字符匹配不上
       "三个反引号" ✗ ⇒ 围栏行**从未触发重扫** ✗ ⇒ 代码块/围栏装饰整体停更 ✗✗（CF-1/CF-3/CF-4 即此）。
       改为**单字符守护集**：改动文本里只要出现任一结构字符 ⇒ 重扫 ✓（宁可多扫，不可漏扫 ✓）；
       纯中文/字母的正文打字不含这些字符 ⇒ 仍零扫描 ✓（性能收益保留 ✓）。 */
    let touched = false;
    const STRUCT_CH = /[`|#>$~*_\-\n\r]/;         /* ★ 含换行：换行＝**行结构变化** ✓（回车/粘贴多行必须重扫 ✗） */
    try {
      tr.changes.iterChanges((fromA, toA, fromB, toB) => {
        if (touched) return;
        if (STRUCT_CH.test(tr.startState.doc.sliceString(fromA, toA)) || STRUCT_CH.test(tr.state.doc.sliceString(fromB, toB))) touched = true;
      });
    } catch { touched = true; }                    // 取不到改动范围 ⇒ 保守重扫 ✓
    /* 【★ 身份必须变·2026-10-10（回退实证）】原来这里 `return value` ✗ —— **同一个对象引用**
       在 CM6 里等于"**没变化**" ✗ ⇒ `EditorView.decorations.compute(["selection", lineStylesField], …)`
       **根本不重算** ✗ ⇒ 行类/围栏/代码行号（`mp-code`、行号属性）**整体停更** ✗✗。
       实证：同族两次落盘对照（旧产物 `db761363…` 非ok 只有 CF-5b/CF-5c ✓ → 本产物 `a9ef6edf…`
       非ok 变成 CF-1/CF-3/CF-4/CF-5/CF-5b ✗）⇒ **围栏不再被识别为代码块** ✗。
       修法：**返回一个新对象**（身份变 ⇒ 下游重算 ✓）但**内部数组整份复用**（不重扫 ⇒ 性能收益保留 ✓）。 */
    if (!touched) return { ...value };             /* ★ 零扫描但身份变 ✓ */
    return { ...scanLineStyles(tr.state.doc), tables: scanTables(tr.state.doc) };
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
function scanTables(doc) {
  const tables = [];
  /* 分隔行判据与 tables.js / 扩展包**同源**（含 en/em dash，见 tables.js 的说明）。 */
  const isSep = (t) => isSeparatorBody(t);
  let i = 1;
  /* 【第二波·code-fence 缺陷·2026-10-10】扫描必须**跳过代码围栏内部**：
     围栏里的 `| … |` 行（手写的、或刚从 Excel/网页粘进来的）原来会被当成表格 ⇒
     行类变非代码、围栏里渲染出一张表（实测 CF-5c：插入区 3 行 code=false、
     "出现竖线表格形状行=true"）。这里维护围栏开关，**围栏优先于表格识别**。 */
  let inFence = false;
  while (i <= doc.lines) {
    const fenceLine = doc.line(i).text.trim();
    if (fenceLine.startsWith('```') || fenceLine.startsWith('~~~')) { inFence = !inFence; i++; continue; }
    if (inFence) { i++; continue; }
    const line1 = doc.line(i);
    const p1 = tablePrefix(line1.text);
    const header = parseTableRow(line1.text, p1.off);
    const line2 = i + 1 <= doc.lines ? doc.line(i + 1) : null;
    const p2 = line2 ? tablePrefix(line2.text) : null;
    if (header && header.cells.length > 1 && line2 && p2.q === p1.q && isSep(line2.text.slice(p2.off))) {
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
        weights[c] = Math.max(2, displayWidth(header.cells[c] || ""), ...rows.map((r) => displayWidth(r.cells[c] || "")));
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
  const m = /^[ \t]*(?:>[ \t]?)+/.exec(text);
  const start = m ? m[0].length : 0;
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
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  /** 单段渲染（原扫描器逐字搬进来，输入输出都只是"段"） */
  const renderSeg = (src) => {
    let out = "";
    let buf = "";
    let i = 0;
    const flush = () => { if (buf) { out += esc(buf); buf = ""; } };
    while (i < src.length) {
      const ch = src[i];
      if (ch === "\\" && src[i + 1] === "$") { buf += "$"; i += 2; continue; }   // 转义美元：原样显示一个 $
      if (ch === "\\") { buf += src[i] + (src[i + 1] || ""); i += 2; continue; }
      if (ch !== "$") { buf += ch; i++; continue; }
      // 找闭合的 $（不跨过另一个未转义的 $）
      let j = i + 1, tex = null;
      while (j < src.length) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "$") { tex = src.slice(i + 1, j); break; }
        j++;
      }
      if (tex == null || !tex.trim()) { buf += ch; i++; continue; }              // 未闭合/空公式：保持字面
      const html = renderMathHTML(tex, false);
      if (html == null) { buf += src.slice(i, j + 1); i = j + 1; continue; }       // KaTeX 报错：原样显示源码
      flush();
      out += `<span class="mp-cm6-math">${html}</span>`;
      i = j + 1;
    }
    flush();
    return out;
  };
  /* 【3.8 / 1.16】格内行内标记要**投影**（Typora 口径）：行内代码显示成等宽代码（反引号不显示）、
     图片写法显示成真图。改前格内只做转义 + 数学 ⇒ 反引号与 `![…](…)` 原样露在格子里（清单 3.8 / 1.16 就是这么红的）。
     **只动这两类**（最小改动面）：其余标记仍按原样走 esc + 数学，避免与编辑覆盖层/复制口径打架。 */
  const escAttr = (s) => esc(s).replace(/"/g, "&quot;");
  const renderWithMarks = (seg) => {
    let out = "", last = 0, m;
    const re = /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g;
    while ((m = re.exec(seg))) {
      out += renderSeg(seg.slice(last, m.index));
      if (m[1] !== undefined) {
        out += '<code class="mp-cell-code">' + esc(m[2]) + '</code>';
      } else {
        const src = mpImgSrc(m[4]);                       // 与块级图同一条 src 解析（相对路径按文档目录）
        const ref = /^https?:/i.test(src) ? ' referrerpolicy="no-referrer"' : '';
        out += '<img class="mp-cell-img" src="' + escAttr(src) + '" alt="' + escAttr(m[3] || '') + '"' + ref + '>';
      }
      last = m.index + m[0].length;
    }
    out += renderSeg(seg.slice(last));
    return out;
  };
  const parts = String(text == null ? "" : text).split(/(<br\s*\/?>)/i);
  let out = "";
  for (let k = 0; k < parts.length; k++) {
    if (!parts[k]) continue;
    out += (k % 2 === 1) ? "<br>" : renderWithMarks(parts[k]);
  }
  return out;
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
    if (v) {
      v = { rowFrom: tr.changes.mapPos(v.rowFrom), col: v.col };
      const line = tr.state.doc.lineAt(v.rowFrom);
      if (line.from !== v.rowFrom || !parseTableRow(line.text)) v = null; // 行没了/变形 → 收场
    }
    return v;
  },
});
let cellEdit = null; // { text, from, to }：活动格当前镜像（模块级，跨 widget 生命周期）
let cellComposing = false;

class TableRowWidget extends WidgetType {
  constructor(cells, widths, isHeader, ranges, rowFrom, activeCol, qDepth = 0, qLead = 0, weights = null, selKey = "", aligns = null) {
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
    /* 【列宽下限·2026-10-08】weights＝各列的**显示宽度**权重（scanTables 算好）。
       `toDOM` 里按表格真实可用宽度现算一次"每列至少 minPercent"，防止窄窗口/窄版心下
       中文列被压成一字一行（用户 3.0.5 装机截图）。 */
    this.weights = weights;
  }
  /** 现算本次渲染用的列宽（%）：先按显示宽度比例，再把低于下限的列抬到下限、从宽列里扣回。 */
  fitWidthsNow() {
    if (!this.weights || !this.weights.length) return this.widths;
    const avail = this.tableEl && this.tableEl.clientWidth ? this.tableEl.clientWidth : 0;
    const minPx = 64;                        // 4 个中文字 + 左右各 16 padding：至少能竖排前容纳 4 字
    const minPercent = avail > 0 ? Math.min(30, (minPx / avail) * 100) : 14;
    return fitWidths(this.weights, minPercent);
  }
  eq(other) {
    if (other.isHeader !== this.isHeader || other.widths.join(",") !== this.widths.join(",")
      || other.ranges.length !== this.ranges.length || other.activeCol !== this.activeCol
      || other.qDepth !== this.qDepth || other.qLead !== this.qLead) return false;
    if ((other.selKey || "") !== (this.selKey || "")) return false;   // 【β1】选择状态变了必须重建（否则高亮陈旧）
    if ((other.alignKey || "") !== (this.alignKey || "")) return false; // 【β2】列对齐变了必须重建（活动行分支同样适用）
    /* weights 参与 eq：列宽下限是按 weights 现算的，权重变了必须重建（否则改一格文字后列宽不跟着走）。 */
    if ((other.weights ? other.weights.join(",") : "") !== (this.weights ? this.weights.join(",") : "")) return false;
    if (this.activeCol >= 0) {
      // 活动行：只认行位＋活动列（内容变化由镜像写回，DOM 必须保活——eq true 保 IME/焦点）
      return other.ranges[this.activeCol] ? other.ranges[this.activeCol][0] === this.ranges[this.activeCol][0] : false;
    }
    return other.cells.join("\u0001") === this.cells.join("\u0001")
      && other.ranges.map((r) => r.join(",")).join(";") === this.ranges.map((r) => r.join(",")).join(";");
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "mp-table-wrap" + (this.qDepth ? " mp-table-quote" : "");
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
    this.widths.forEach((w) => { const col = document.createElement("col"); col.style.width = w + "%"; colgroup.appendChild(col); cols.push(col); });
    table.appendChild(colgroup);
    if (this.weights && this.weights.length === this.widths.length) {
      /* 【两段式宽度】首帧先按静态比例落一次（不读布局），插进 DOM 之后再按**实测表宽**把下限摊一遍：
         读 clientWidth 会强制一次布局，所以只在 toDOM 末尾做一次，不在每键路径上。 */
      requestAnimationFrame(() => {
        try {
          const fitted = this.fitWidthsNow();
          for (let k = 0; k < cols.length; k++) if (fitted[k]) cols[k].style.width = fitted[k] + "%";
        } catch { /* 忽略：拿不到宽度就保持静态比例 */ }
      });
    }
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
      if (k === this.activeCol) cell.className = "mp-cell-editing";
      else cell.innerHTML = cellHTML((this.cells[k] || "").replace(/\\\|/g, "|"));
      if (this.selKind === "col" && k === this.selCol) cell.classList.add("mp-sel-col");
      tr.appendChild(cell);
    }
    wrap.appendChild(table);
    if (this.activeCol >= 0) requestAnimationFrame(positionCellOverlay); // 布局后定位覆盖层
    return wrap;
  }
  ignoreEvent() { return false; }
}
/** 编辑面 → 源码镜像：公共前后缀 diff → 最小 change；行内其余区间原样 */
function syncCellEdit(edit) {
  if (!view || !cellEdit) return;
  const newText = edit.textContent;
  const old = cellEdit.text;
  if (newText === old) return;
  let p = 0;
  while (p < old.length && p < newText.length && old[p] === newText[p]) p++;
  let s = 0;
  while (s < old.length - p && s < newText.length - p && old[old.length - 1 - s] === newText[newText.length - 1 - s]) s++;
  /* 【A4b 写入口】格内直接打出来的裸 `|` 必须落地成 `\|` —— GFM 里它是**格边界**，
     不转义当场多出一列并把内容劈开（真机已复现）。只转义"这次新增的这段"，不动文档已有内容；
     文档侧位移用**转义后**的长度算（cellEdit.text 仍记编辑面文本，两边各自自洽）。 */
  const rawInsert = newText.slice(p, newText.length - s);
  const insert = rawInsert.replace(/(?<!\\)\|/g, "\\|");
  const from = cellEdit.from + p;
  const to = cellEdit.to - s;
  view.dispatch({ changes: { from, to, insert } });
  const delta = insert.length - (to - from);
  cellEdit.text = newText;
  cellEdit.to += delta;
  /* 【A7-(b)】这里原先每次输入都刷一次格内预览（含一次 cellHTML 渲染比较）。已按决定删除：
     预览卡片与"不遮住下一行"在相邻行上结构性互斥（可用带宽 2px vs 卡片 30px+），
     而去掉它同时最贴 Typora、并在每键路径上**净省**一次 innerHTML 写入 + 一次渲染比较。 */
  requestAnimationFrame(positionCellOverlay); // 行高可能变，重定位
}
/** 撤销后外向同步：源码 → 编辑面 */
function resyncCellEdit(edit) {
  if (!view || !cellEdit) return;
  const src = view.state.doc.sliceString(cellEdit.from, cellEdit.to);
  if (edit.textContent !== src) edit.textContent = src;
  cellEdit.text = src;
}

/* ══ 格编辑覆盖层（iframe body 挂载——CM6 DOM 观察器免疫）══
 *  contenteditable 放 cm-content 内会被观察器当篡改（实测：打字触发
 *  「update in progress」异常、镜像 dispatch 被吞）。覆盖层在 body 上
 *  固定定位盖住活动格，IME 原生，input 事件独立于 CM6 更新周期。 */
let cellOverlay = null;
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
  const box = document.createElement("div");
  box.className = "mp-cell-overlay";
  const div = document.createElement("div");
  div.className = "mp-cell-overlay-text";
  div.contentEditable = "true";
  div.spellcheck = false;
  box.appendChild(div);
  div.addEventListener("compositionstart", () => { cellComposing = true; });
  div.addEventListener("compositionend", () => { cellComposing = false; syncCellEdit(div); });
  div.addEventListener("input", () => { if (!cellComposing) syncCellEdit(div); });
  /* 【N1】copy 必须挂在覆盖层自己身上：它挂 body、事件在 contentDOM 之外，CM6 的处理器收不到。 */
  div.addEventListener("copy", cellOverlayCopy);
  div.addEventListener("blur", () => {
    if (cellEdit && !cellEdit.navigating && view) {
      view.dispatch({ effects: setActiveCell.of(null) });
      deactivateCellOverlay();
    }
  });
  div.addEventListener("keydown", (e) => {
    /* 【IME 组字期间一律不拦截】—— 实测（真机 + 无头）：组字中途按 Tab 会**丢拼音**并把
       上屏文字串到下一格；Enter 那一下也会被下面的 preventDefault 吞掉。
       ⚠️ 必须**同时** preventDefault：只 `return` 的话 Tab 会走浏览器焦点遍历 ⇒ 覆盖层 blur
       ⇒ `setActiveCell(null)` + 收浮层，等于"打着字把编辑面关了"（对抗复核指出，已修）。
       keyCode 229 是"正在组字"的老口径兜底（部分输入法合成事件不带 isComposing）。 */
    if (e.isComposing || e.keyCode === 229) { e.preventDefault(); return; }
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
    /* 【task-2 ⑧·格内 Ctrl+Shift+E ＝ 行内公式】表外这个组合键仍是「导出 HTML」（DEFAULT_KEYS.export），
       格内接管、表外一字不动（下面 return 只在 cellEdit 为真时生效）。
       改前格内按它是**死键**（CM 的 keymap 挂 contentDOM，覆盖层上的按键它收不到；实测 docGrew=0）。
       插入走覆盖层自己的 execCommand（与格内粘贴同一条路径），插完把光标放进两个 $ 之间。 */
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "e" || e.key === "E") && cellEdit) {
      e.preventDefault();
      let picked = "";
      try { const s = window.getSelection(); if (s && !s.isCollapsed) picked = String(s); } catch (err) { picked = ""; }
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
      if (view) view.dispatch({ effects: [setActiveCell.of(null), setTableSel.of(null)] });
      deactivateCellOverlay();
      view?.focus();
    } else if (e.key === "Tab") {
      /* 【β1】与源码行路径**同一个** applyTab：跨行、跳分隔行、末条格行补行、反向到表头停住。
         改前这里是"只在本行内换格"（越界什么都不做），跨行与补行都做不到。 */
      e.preventDefault();
      if (!view || !cellEdit) return;
      moveActiveCellByKey(() => applyTab(view, e.shiftKey ? -1 : 1));
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      if (view) { view.focus(); undo(view); resyncCellEdit(div); div.focus(); positionCellOverlay(); }
    } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      /* 【β1】Enter 三态（覆盖层这一侧）。Ctrl+Enter 家族已被上面的 A8 转发放走，不会走到这里。
         Shift ⇒ 格内换行：往 contenteditable 里写**字面四个字符** <br>（插真 DOM 节点的话
         syncCellEdit 比对的 textContent 里看不到换行，diff 会判"文本没变"、源码侧不落地）。 */
      e.preventDefault();
      if (!view || !cellEdit) return;
      if (e.shiftKey) {
        let ok = false;
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
  const cell = view.contentDOM.querySelector(`.mp-row th[data-mp-row="${active.rowFrom}"][data-mp-col="${active.col}"], .mp-row td[data-mp-row="${active.rowFrom}"][data-mp-col="${active.col}"]`);
  if (!cell) { cellOverlay.style.display = "none"; return; }
  const r = cell.getBoundingClientRect();
  cellOverlay.style.display = "block";
  /* 【A7】排版抄**该 td 的计算样式**（覆盖层挂 body，em 基准与表格里不同，写死字号/padding 必然错位）。
     ⚠️ 只在**活动格变了**的那一次读 computed style：本函数被滚动/rAF/每次输入的 rAF 反复调用。 */
  /* 【A7 v2c】缓存键**必须带上格子高度**：只按"哪一格"缓存的话，激活那一刻若格子还没到最终高度
     （图片尚未加载 / 夹具稍后用 CSS 撑高 / 行 widget 刚重建），垂直居中补偿会按旧高度算一次然后被缓存住
     —— 复核线复跑实测就是这个症状：高行格 `dy=−36.91px`、`padTop=9px`（补偿项为 0）。
     高度变化才会重算，因此每帧代价仍只是"一次字符串比较 + 一次整数比较"。 */
  const styleKey = active.rowFrom + ":" + active.col + ":" + Math.round(r.height);
  if (overlayStyledFor !== styleKey) {
    overlayStyledFor = styleKey;
    try {
      const cs = getComputedStyle(cell);
      cellOverlay.style.fontFamily = cs.fontFamily;
      cellOverlay.style.fontSize = cs.fontSize;
      cellOverlay.style.fontWeight = cs.fontWeight;
      cellOverlay.style.lineHeight = cs.lineHeight;
      cellOverlay.style.letterSpacing = cs.letterSpacing;
      /* 【β2·A4】进格编辑时排版不横跳：覆盖层抄 td 的 textAlign（不补的话点进右对齐格会从左排）。 */
      cellOverlay.style.textAlign = cs.textAlign;
      cellOverlay.style.color = cs.color;
      /* 【A7 v2】内容盒原点必须对齐 td 的**内容盒**（gaps 线量出来的两条，不是拍的）：
         · td 的 1px 边框要补进 padding，否则整块偏 1px；
         · td 默认 `vertical-align: middle`，覆盖层是块级从顶排 ⇒ 行高小于格高时整体偏上
           —— 实测格高 117px 时同偏移 Range 的 Δy = **−37.91px**（不是 12px，12px 只是 42px 行高那档），
           补垂直居中后 −0.02px。 */
      const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
      const padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0;
      const bordL = parseFloat(cs.borderLeftWidth) || 0, bordR = parseFloat(cs.borderRightWidth) || 0;
      const bordT = parseFloat(cs.borderTopWidth) || 0, bordB = parseFloat(cs.borderBottomWidth) || 0;
      const lineH = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 14) * 1.5;
      const innerH = Math.max(0, r.height - bordT - bordB - padT - padB);
      overlayPadTop = padT + bordT + Math.max(0, (innerH - lineH) / 2);
      cellOverlay.style.padding = `${overlayPadTop}px ${padR + bordR}px ${padB + bordB}px ${padL + bordL}px`;
    } catch { overlayPadTop = 0; }
  }
  cellOverlay.style.left = r.left + "px";
  cellOverlay.style.top = r.top + "px";
  cellOverlay.style.width = r.width + "px";
  /* 【A7】锁**高**而不是给下限：`min-height` 会被预览块撑到下一行（验收线实测公式格 dH=+33.22px）。 */
  cellOverlay.style.height = r.height + "px";
}
/** 激活/切换活动格：建覆盖层、播种源码文本、落焦点 */
function activateCellOverlay(rowFrom, col, cols, from, to, caretOffset, selectAll) {
  const box = ensureCellOverlay();
  const div = box.querySelector(".mp-cell-overlay-text");
  const src = view ? view.state.doc.sliceString(from, to) : "";
  div.textContent = src;
  cellEdit = { text: src, from, to, col, cols, rowFrom, navigating: false };
  box.style.display = "block";
  positionCellOverlay();
  const focusIt = () => {
    div.focus();
    const rng = document.createRange();
    /* 【点格落点】给了 caretOffset（点格时按点击位置算的比例）就把光标放到文本的对应字符上，
       否则沿用旧行为折到末尾。offset 钳在 [0, 文本长度]，跨节点安全。 */
    const node = div.firstChild;
    const len = node && node.nodeType === 3 ? node.nodeValue.length : 0;
    if (typeof caretOffset === "number" && node && node.nodeType === 3) {
      rng.setStart(node, Math.max(0, Math.min(len, Math.round(caretOffset))));
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
  };
  requestAnimationFrame(focusIt); setTimeout(focusIt, 30);
}
function deactivateCellOverlay() {
  if (cellOverlay) cellOverlay.style.display = "none";
  cellEdit = null;
}
/** 【β1】覆盖层路径的**统一落点收场**：跑一个 apply*（它内部已经 dispatch 了文档/选区），
 *  然后把活动格与覆盖层搬到它返回的落点上。返回 null（表外）⇒ 什么也不做；
 *  返回 rejected/stopped（表内但零改动）⇒ 只重定位、不换格。
 *  ⚠️【陈旧选区】点格只 dispatch setActiveCell、**不落 CM 选区**（tableCellClick 末尾 return true
 *  阻断了 CM6 的选区更新）⇒ 直接按选区判"在不在表内"会落在文首（老症状："点着格子按表格键没反应"）。
 *  所以先把 CM 光标落到**活动格起点**，再跑键位层核心。 */
function moveActiveCellByKey(run) {
  if (!view) return;
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
    let v = value;
    for (const e of tr.effects) if (e.is(setTableSel)) v = e.value;
    if (!v) return null;
    if (tr.docChanged) {
      const rowFrom = tr.changes.mapPos(v.rowFrom, 1);
      const tables = tableTablesOf(tr.state);
      if (!tables.some((t) => rowFrom >= t.from && rowFrom <= t.to)) return null;   // 表没了/变形 ⇒ 收场
      v = { ...v, rowFrom };
    }
    return v;
  },
});
function tableTablesOf(state) { try { return state.field(lineStylesField).tables || []; } catch { return []; } }

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
  if (!cur || !tr.docChanged || !tr.isUserEvent("input")) return tr;
  let at = tr.startState.selection.main.head;
  try {
    const line = tr.startState.doc.lineAt(cur.rowFrom);
    const ranges = cellRangesOf(line);
    const r = ranges[Math.max(0, Math.min(cur.col, ranges.length - 1))];
    if (r) { const seg = line.text.slice(r[0] - line.from, r[1] - line.from); at = r[0] + (seg.length - seg.trimStart().length); }
  } catch { /* 算不出来就用原 head */ }
  return [{ selection: EditorSelection.cursor(at), effects: setTableSel.of(null) }, tr];
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

const tableDecorations = EditorView.decorations.compute(["selection", lineStylesField, activeCellField, tableSelectionField], (state) => {
  const out = [];
  const active = state.field(activeCellField);
  const sel = state.field(tableSelectionField, false);
  /* 【β1】行/列/整表的高亮只能靠 widget DOM 的 class（源码行被 block widget 整行替换，
     原生选区在屏幕上不可见）⇒ 把选择状态编成一个短 key 传给 widget，由它在 toDOM 里落 class。 */
  const selKey = sel ? sel.kind + ":" + sel.rowFrom + ":" + sel.col : "";
  for (const tb of state.field(lineStylesField).tables) {
    const mk = (block, isHeader) => {
      const line = state.doc.lineAt(block.from);
      const ranges = cellRangesOf(line);
      if (!ranges.length) return;
      const activeCol = active && active.rowFrom === block.from ? active.col : -1;
      out.push(Decoration.replace({
        widget: new TableRowWidget(isHeader ? tb.headerBlock.cells : block.cells, tb.widths, isHeader, ranges, block.from, activeCol,
          tb.headerBlock.qDepth || 0, block.lead || 0, tb.weights || null, selKey, tb.aligns || null),
        block: true,
      }).range(block.from, block.to));
    };
    mk(tb.headerBlock, true);
    for (const row of tb.rows) mk(row, false);
  }
  return Decoration.set(out, true);
});
/** 点单元格 → 激活格内编辑（行源码永不露出；覆盖层在 body 上） */
const tableCellClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    const cell = event.target && event.target.closest ? event.target.closest(".mp-row th[data-mp-row], .mp-row td[data-mp-row]") : null;
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
    /* 【β1】点新格 ⇒ 清掉表级选择状态（行/列/整表高亮不该跨格留着） */
    view.dispatch({ effects: [setActiveCell.of({ rowFrom, col: realCol }), setTableSel.of(null)] });
    /* 【点格落点】按点击点在格内的横向比例估一个源码字符位置（渲染文本与源码长度不同 ⇒ 近似）。
       用户报过"点了某处、光标却不在那"——旧行为是一律落格尾。
       ⚠ 必须用**活节点**的矩形：mousedown 期间 CM6 可能刚重建过整行 widget，
       事件里的 cell 会脱离文档，而 detached 节点的 getBoundingClientRect() 全是 0
       ⇒ frac 兜底成 1 ⇒ 光标永远落格尾（实测就是这个坑）。positionCellOverlay 也是按 row/col 现查的。 */
    let caretOffset;
    try {
      let live = null;
      for (const el of view.dom.querySelectorAll(".mp-row th[data-mp-row], .mp-row td[data-mp-row]")) {
        if (Number(el.dataset.mpRow) === rowFrom && Number(el.dataset.mpCol) === realCol) { live = el; break; }
      }
      const box = (live || cell).getBoundingClientRect();
      const frac = box.width > 0 ? (event.clientX - box.left) / box.width : 1;
      const srcText = view.state.doc.sliceString(r[0], r[1]);
      caretOffset = Math.round(Math.max(0, Math.min(1, frac)) * srcText.length);
    } catch (err) { console.error("[mp] caretOffset 计算失败：", err); caretOffset = undefined; }
    activateCellOverlay(rowFrom, realCol, ranges.length, r[0], r[1], caretOffset);
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
    if (notIn(line)) out.push(Decoration.line({ class: "mp-hr" }).range(line.from)); // 分割线投影
  }
  // 围栏行（```）阅读态压扁隐藏（vditor 隐藏围栏观感）；光标入行显源码
  for (const line of fenceLines) {
    if (notIn(line)) out.push(Decoration.line({ class: "mp-fence" }).range(line.from));
  }
  return Decoration.set(out, true);
});
const lineClassDecorations = EditorView.decorations.compute([lineStylesField], (state) => {
  const out = [];
  for (const s of state.field(lineStylesField).styled) out.push(Decoration.line({ class: s.cls }).range(s.line.from));
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
/** 入参可以是**文件路径**（`D:\docs\a.md`）也可以是**目录**（`D:/docs`、`D:/docs/`）——
 *  壳层两种都可能给，所以判据不能只看末尾有没有斜杠：
 *  ① 先统一成正斜杠；② 末尾是斜杠 ⇒ 已按目录处理；③ 否则看最后一段有没有扩展名，
 *  有扩展名（`a.md`）才砍掉最后一段，没有扩展名（`docs`、`v306`）就当成目录名原样保留。
 *  【踩坑】早先一律 `lastIndexOf('/')` 砍尾 ⇒ 传目录 `…/.mp-verify/v306` 会被砍成 `…/.mp-verify/`，
 *  图片于是解析到上一层（装机表现为"图还是裂的"，而 base 看着"设好了"）。 */
function mpSetDocPath(filePath) {
  try {
    let dir = "";
    if (filePath && typeof filePath === "string") {
      let norm = filePath.replace(/\\/g, "/").trim();
      if (norm && !norm.endsWith("/")) {
        const last = norm.slice(norm.lastIndexOf("/") + 1);
        if (/\.[A-Za-z0-9]{1,8}$/.test(last)) norm = norm.slice(0, norm.lastIndexOf("/") + 1);  // 文件 ⇒ 取目录
        else norm += "/";                                                                        // 目录 ⇒ 补斜杠
      }
      dir = norm;
    }
    if (dir === mpDocDir) return mpDocDir;
    mpDocDir = dir;
    let base = document.querySelector("base[data-mp-docbase]");
    if (dir) {
      if (!base) { base = document.createElement("base"); base.setAttribute("data-mp-docbase", "1"); document.head.insertBefore(base, document.head.firstChild); }
      base.href = "file:///" + encodeURI(dir);
    } else if (base) base.remove();
    return mpDocDir;
  } catch (e) { console.error("[mp] 文档目录设置失败：", e); return mpDocDir; }
}
/** 图片地址：相对路径按文档目录解析成绝对 URL；已是绝对/data/blob 的原样返回。
 *  【为什么在渲染时算而不是扫描时算】base 是文档级的，渲染时读一次最省；
 *  解析结果是稳定字符串 ⇒ widget 的 srcKey 也跟着稳定，不会每帧重建。 */
function mpImgSrc(src) {
  const s = String(src == null ? "" : src);
  if (!s) return s;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(s)) return s;       // data:/http:/https:/blob:/file: 等
  if (!mpDocDir) return s;                                        // 没有文档目录：保持现状（应用目录）
  try { return new URL(s.replace(/\\/g, "/"), "file:///" + encodeURI(mpDocDir)).href; } catch { return s; }
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
const mpImgKey = (s) => s.length + "|" + s.slice(0, 24) + "|" + s.slice(-24);
const MP_IMG_TIMEOUT_MS = 10000;
function mpImgFailGuard(wrap, img, rawSrc) {
  let done = false;
  let timer = 0;
  const settle = (state, reason) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    wrap.classList.remove("is-loading");
    wrap.removeAttribute("data-mp-img-state");
    if (state === "ok") { wrap.classList.remove("is-failed"); return; }
    wrap.classList.add("is-failed");
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
    url.textContent = rawSrc;                               // **完整原始 URL**，可选中复制（用户要拿它去修/换图）
    fb.append(icon, why, url);
    wrap.appendChild(fb);
  };
  const key = mpImgKey(rawSrc);
  const prev = mpImgLoadState.get(key);
  /* 【闩锁·按 Lead 裁定】只允许"初始尝试 + widget 重建时重试一次" = 最多 2 次；
     超过才直接落定成占位（既不狂请求，也不会因一次瞬时超时把有效 URL 永久判死 —— L190 就是活例）。 */
  const tries = (mpImgTries.get(key) || 0) + 1;
  mpImgTries.set(key, tries);
  if (prev && prev !== "ok" && tries > 2) { wrap.classList.add("is-failed"); wrap.setAttribute("data-mp-img-state", prev); }
  img.addEventListener("load", () => { mpImgLoadState.set(key, "ok"); settle("ok"); });
  img.addEventListener("error", () => { mpImgLoadState.set(key, "loading-failed"); settle("loading-failed", "图片加载失败"); });
  timer = setTimeout(() => { mpImgLoadState.set(key, "timeout"); settle("timeout", "加载超时（10s）"); }, MP_IMG_TIMEOUT_MS);
  /* ⚠️ 不许用"同步读 img.complete"判失败：刚赋 src 时它可能已是 true 而 naturalWidth 仍为 0，
     会把**已缓存/正在加载**的图误标成失败；settle() 又是"首次落定即终局"，真正的 load 会被丢弃。
     实测后果：真 dev 引擎里图已 599×241 出图，却被 is-failed 的占位盖住（比原缺陷更糟）。
     ⇒ 只有 complete && naturalWidth>0 才算成功；其余一律交给 load/error/超时 三个事件。 */
  if (img.complete && img.naturalWidth > 0) { mpImgLoadState.set(key, "ok"); settle("ok"); }
  else wrap.classList.add("is-loading");                    // 加载中也要可见（最小高度由 CSS 给）
}

class ImageWidget extends WidgetType {
  constructor(src, alt, title, width, height, align) {
    super();
    this.src = src; this.alt = alt || ""; this.title = title || "";
    this.width = width || ""; this.height = height || "";
    this.align = align || "";                    // left / center / right（来自 data-typora-align，见 scanImageMarks）
    /* 【前沿预警】eq 不拿整段 data URI 当比较键：重扫后是新字符串，900KB 逐字比会拖慢每键。
       用"长度 + 首尾 32 字符"指纹（改到中段会漏判，概率极低；真改了首尾或长度就会重建）。 */
    this.srcKey = src.length + "|" + src.slice(0, 32) + "|" + src.slice(-32);
  }
  eq(o) {
    return o.srcKey === this.srcKey && o.alt === this.alt && o.title === this.title
      && o.width === this.width && o.height === this.height && o.align === this.align;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "mp-img" + (this.align ? " is-" + this.align : "");
    const img = document.createElement("img");
    img.alt = this.alt;
    if (this.title) img.title = this.title;
    if (this.width) img.setAttribute("width", this.width);
    if (this.height) img.setAttribute("height", this.height);
    img.decoding = "async";
    /* 【A.1/A.2/A.3】data URI 走 **eager**：`loading="lazy"` 对**视野外**的图会推迟加载，
       而大内联图（≥800KB）解码慢，夹具在视野外时 `naturalWidth` 恒为 0 ⇒ 判"图未加载"假红。
       data URI 是本地数据、没有网络成本 ⇒ eager 只有好处。远程/相对路径仍 lazy（省流量/省 IO）。 */
    img.loading = /^data:/i.test(this.src) ? "eager" : "lazy";
    const resolvedSrc = mpImgSrc(this.src);   // 相对路径按**文档所在目录**解析（见 mpImgSrc / mpSetDocPath）
    /* ⚠️ 远程图必须**不带 Referer**：本应用渲染进程是 file:// 页面，跨源取图默认带 `Referer: file:///`，
       而用户图床（华为云 WAF）**对带该 Referer 的请求直接 403**（实测：同一 URL 不带 Referer 是 200 + 34118 B webp，
       带上就 403 / 0 B）。本地 data: / 相对路径图不吃这条，保持原样。 */
    if (/^https?:/i.test(resolvedSrc)) img.referrerPolicy = "no-referrer";
    img.src = resolvedSrc;
    wrap.appendChild(img);
    /* 【task-12 失败必可见】见 mpImgFailGuard：绝不允许"源码被遮住 + 图没出来"的空白态。 */
    mpImgFailGuard(wrap, img, this.src);
    return wrap;
  }
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
    let val = "";
    if (tag[i] === "=") {
      i++;
      while (i < n && " \t\n\r".includes(tag[i])) i++;
      const q = tag[i];
      if (q === '"' || q === "'") {
        i++;
        const end = tag.indexOf(q, i);
        val = end < 0 ? tag.slice(i) : tag.slice(i, end);
        i = end < 0 ? n : end + 1;
      } else {
        const vs = i;
        while (i < n && !" \t\n\r>".includes(tag[i])) i++;
        val = tag.slice(vs, i);
      }
    }
    /* 【task-12】属性值要按 HTML 字符引用解码：Typora 写 &amp;，而 JS 赋值绕过 HTML 解析器 ⇒ 不解码就会把
       &amp;ty=p 原样发给图床（参数名被污染成 amp;ty）⇒ 403。只解这一处（裸 <img> 分支）。 */
    if ((name === "src" || name === "alt" || name === "title" || name === "width" || name === "height") && out[name] === undefined) out[name] = mpHtmlUnescape(val);
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
  const add = (a, b, src, alt, title, w, h) => {
    if (!src) return;
    out.push({ from: base + a, to: base + b, hides: [], image: { src, alt: alt || "", title: title || "", width: w || "", height: h || "" } });
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
      add(a, b, at.src, at.alt, at.title, at.width, at.height);
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
      let raw = t.slice(close + 2, end).trim();
      let title = "";
      const tm = /^(<[^>]*>|\S+)\s+["']([^"']*)["']\s*$/.exec(raw);
      if (tm) { raw = tm[1]; title = tm[2]; }
      /* 【2026-10-09·与裸 <img> 路径对齐】markdown 路径的地址也要过 `mpHtmlUnescape`：
         改前只有裸 `<img>` 属性解码字符引用 ⇒ Typora/HTML 来源写出的 `![图](a&amp;b.png)`
         会带着 `&amp;` 去打真实地址（远程图 403/404）。无 `&` 时该函数已早退，零成本。 */
      const src = mpHtmlUnescape(raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw);
      if (!free(a, b)) continue;
      add(a, b, src, t.slice(bang + 2, close), title, "", "");
    }
  }
  return out;
}
function scanInlineMarks(doc, mathSpans) {
  const marks = []; // { from, to, hides: [[a,b],...], bullet? } wrapper 与隐藏件
  const overlapsMath = (a, b) => mathSpans.some((s) => a < s.to && b > s.from);
  let inFence = false;
  let cmtFrom = -1;        // 【HTML 注释】未闭合注释的**绝对起点**（-1＝不在注释里）
  let olCtx = null;        // 【有序列表】当前列表的计数上下文 { key, n }（key = 引用前缀+缩进+分隔符）
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const t = line.text;
    /* 【引用区前缀·唯一判据】所有"行首"假定一律先过 `tableLead()`（= tables.js 里那条唯一前缀正则，
     *  与表格 widget/命令/导出三处同源）。`qoff` ＝ 引用前缀（`>`、`> `、`> > `、`>\t` 等）的长度，
     *  `c` ＝ **去掉前缀后的内容**。改前这里全部直接拿 `t` 做行首判据 ⇒ 四类形态在引用区里全被前缀挡掉：
     *   · 无序列表圆点 `/^([ \t]*)([-*+])([ \t]+)(?=\S)/` 被 `>` 挡住 ⇒ 引用区里不画 •；
     *   · 围栏 ` ``` `/`~~~` 同样被挡住 ⇒ 引用区代码块不成块；
     *   · 尖括号自动链接没有 autolink 分支 ⇒ `<https://x>` 原样显示尖括号；
     *   · HTML 注释在编辑面没有概念 ⇒ `<!-- … -->` 字面显示。 */
    const lead = tableLead(t);
    const qoff = lead.off;
    const c = qoff ? t.slice(qoff) : t;
    /* 【引用前缀先隐藏·2026-10-08】这一步必须在围栏判断**之前**做：
       否则 `inFence) continue` 会把引用区代码块行整个跳过 ⇒ 那些行的 `> ` 留在屏幕上
       （实测：`> ```js ` 已经成块、但每行都还挂着字面 `> `）。 */
    if (qoff) {
      const a = lead.q.length - lead.q.replace(/^[ \t]*/, "").length;   // 前缀前导空白里真正属于 `>` 的部分
      const qm2 = /^([ \t]*)((?:>[ \t]?)+)/.exec(t);
      if (qm2) {
        const s = qm2[1].length;
        marks.push({ from: line.from + s, to: line.from + s + qm2[2].length, qmark: true, hides: [[line.from + s, line.from + s + qm2[2].length]] });
      }
    }
    /* 【围栏·按内容判】`> ``` ` 也要成块；成块后本行的行内标记一律不投影，
     *  这样引用区代码块里的 `*`/`**` 不会被当行内标记吃掉（守住"围栏内不投影"这条既有契约）。
     *  【ARCH §3-①】判据收敛到 `tables.js` 的 `isFenceAt()` —— 与 `scanLineStyles` 同源。
     *  两处各自翻转状态是历史 bug 源（E 那批：只改了一处 ⇒ 引用区代码块的 `> ` 留在屏幕上）。 */
    if (isFenceAt(c)) { inFence = !inFence; continue; }
    if (inFence) continue;
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
      if (t[k - 1] === "\\" && "*~`[]()#_".includes(t[k]) && !overlapsMath(line.from + k - 1, line.from + k)) {
        marks.push({ from: line.from + k - 1, to: line.from + k, hides: [[line.from + k - 1, line.from + k]] });
      }
    }
    const consumed = []; // 已占用区间（防止 bold/em/链接互相啃）
    // 【A2-P0①】转义禁区：\X（X∈标记字符）不是标记——\*text\* 必须显示 *text*
    /* 【2026-10-09·按行成本】先做一次整行**原生** `indexOf("\\")`：整个函数里 `escapedAt` 会被
       每个候选调用一次，改前每次都要逐字符扫它自己的 [a,b) 区间（大图行上合计上千万次）。
       一行里没有反斜杠时**语义上必然返回 false** ⇒ 这一次原生扫描就是全部成本。 */
    const __hasEsc = c.indexOf("\\") >= 0;
    const escapedAt = (a, b) => {
      if (!__hasEsc) return false;
      for (let k = a; k < b; k++) if (t[k - 1] === "\\" && "*~`[]()#".includes(t[k])) return true;
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
    const take = (a, b) => consumed.push([a, b]);
    /* 【图片】两条写法都替换成真图。**传 `c` 而不是 `line`**：`scanImageMarks` 内部 `base` 已含 `qoff`，
       它自己再拿整行扫就会把前缀算两遍（见该函数注释）——`free`/`take` 也按 `c` 的相对下标工作。 */
    /* 【1.17·行内代码优先】行内代码里的图片写法必须保持**字面**（Typora 口径：代码里一律原文）。
       图片扫描在本函数里**先跑**，此刻行内代码还没被扫描 ⇒ 必须在图片扫描的 free 里**额外排除行内代码区间**，
       否则写在反引号里的 `![x](y)` 会变成真图（清单 1.17 就是这么红的）。
       注意用**独立的 codeSpans**、不调 take()：take 会把它算作已占用，后面真正的行内代码扫描就再也吃不到它了。 */
    const codeSpans = (() => {
      const out = []; const re = /(`+)([\s\S]*?)\1/g; let m;
      while ((m = re.exec(c))) out.push([m.index, m.index + m[0].length]);
      return out;
    })();
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
    const scan = (re, width, hideTail, nest) => {
      if (huge) return;   // 【长行护栏】巨行只做图片扫描
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(c))) {
        const [a, b] = [m.index, m.index + m[0].length];
        const hides = hideTail
          ? [[a, a + 1], [c.indexOf("]", a), b]]
          : [[a, a + width], [b - width, b]];
        if (!hides.every(([x, y]) => x >= 0 && y > x && free(x, y, nest === true))) { re.lastIndex = m.index + 1; continue; }
        push(a, b, hides);
        take(a, b);
      }
    };
    scan(/`[^`\n]+`/g, 1);            // 行内代码
    scan(/\*\*\*[^*\n]+\*\*\*/g, 3, false, true);   // 【A2-P0②】三连星＝粗斜体（先于粗体，防边星残留）
    /* 【5.8·嵌套强调】粗体的内容类必须**允许内部单个星**（`**粗体里 *斜体* 缀**`）：
       改前是 `[^*\n]+` ⇒ 整对匹配不上 ⇒ 斜体正则从第二个星起匹配、把**内侧**两个星隐掉，
       结果外面留一对星（实测文本 `*粗体里 斜体 收尾*` 就是这么来的）。
       用 `(?:\*(?!\*)|[^*\n])+`：单个星可入内容，**双星仍然终止**匹配 ⇒ 不会跨段吞并两个独立粗体。 */
    scan(/\*\*(?:\*(?!\*)|[^*\n])+\*\*/g, 2, false, true);      // 粗体（允许嵌套斜体；nest=true 见 free 注释）
    scan(/__[^_\n]+__/g, 2);
    scan(/~~[^~\n]+~~/g, 2);          // 删除线
    /* 【下划线 `<u>…</u>`·2026-10-11 用户报障补齐】Typora 口径的下划线存的就是 `<u>…</u>`
       （Ctrl+U ✓，与 2.x 线同口径 ✓）。改前**根本没有这条规则** ✗ ⇒ 快捷键插进去的标签
       **原样显示**在屏幕上 ✗（实测：`行textContent="<u>前向词</u>"`、可见字形 `["u","u"]` ✗
       = 只隐藏了尖括号、字母 u 与斜杠都露着 ✗）。
       放在这里（`~~` 之后、自动链接之前）：与 `<https://…>` 的自动链接规则**形态不同** ✓
       （后者要求 scheme ✓）⇒ 两条不会互相啃 ✓；命中后 `take()` 占位 ⇒ 内层 `*`/`**` 不再被当强调 ✓。
       转义守位（`\<u>x</u>`）走 free() 里的 escapedAt ✓ ⇒ 反斜杠转义的尖括号保持字面 ✓。 */
    /* 【下划线 <u>…</u> 走"类"而不是"隐藏区间"·2026-10-11】见 inlineMarkDecorations 里 umark 分支的说明：
       用 hides 做零宽替换时开标签只隐掉 2 个字符（`<` 留在屏幕上 ✗），而同类 `~~`/`**`/行内代码都正常 ✗。
       这里用一条**自带配对**的正则抓出整段并打 umark 标 ✓：不依赖 hideTail 的宽度推算 ✓。 */
    if (!huge) {
      let um;
      const ure = /<u>[^<\n]+<\/u>/g;
      while ((um = ure.exec(c))) {
        const a = um.index, b = a + um[0].length;
        if (!free(a, b)) { ure.lastIndex = um.index + 1; continue; }
        push(a, b, []);
        marks[marks.length - 1].umark = true;
        take(a, b);
      }
    }
    scan(/\[[^\]\n]*\]\([^)\n]*\)/g, 0, true); // 链接
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
  create(state) { return scanInlineMarks(state.doc, scanMathSpans(state.doc)); },
  update(value, tr) {
    if (!tr.docChanged) return value;
    /* 【C·实测否决了"去冗余"这条】原本这里想把 `tr.state.field(mathSpansField).spans` **复用**过来，
       省掉一次全文数学扫描（看起来是白赚）。**实测反而更慢**：
         841KB / 44,200 行夹具，每键 dispatch 同步耗时 **p50 136.6ms → 171.8ms**（p95 167.9 → 192.5）
       —— 原因是 CM6 的 StateField 是**惰性求值**：在 `update` 里访问 `tr.state.field(...)` 会**当场触发**
       那个字段的计算，于是这次访问本身变成一次全文扫描，**外加**原本那次 ⇒ 一共扫了两遍而不是一遍。
       结论：在 CM6 里"跨字段复用"不是免费的，必须实测；这条保持**自己扫**（原样，未改行为）。
       真正的收益只能来自"按脏行增量"，那是 A1 主体（已交接）。 */
    /* 【按脏行增量的第一步·2026-10-10：无结构字符即复用（守卫与 lineStylesField 同款 ✓）】
       上面那段"跨字段复用被实测否决"仍然成立 ✓（不要再去读 `tr.state.field(...)` 来省扫描 ✗）。
       但**不扫**是另一回事：行内标记只对 `* _ ~ \` $` 与换行敏感 ✓ ⇒ 本次改动不含这些字符时，
       **直接复用上一份结果** ✓（返回浅拷贝：**身份必须变** ✓ 否则 CM6 下游不重算 ✗ —— 见台账第十三节）。
       10 万行场景下，连续正文打字因此不再每键扫全文 ✓。 */
    const STRUCT_CH = /[`*_~$\\\n\r<>]/;
    let touched = false;
    try {
      tr.changes.iterChanges((fromA, toA, fromB, toB) => {
        if (touched) return;
        if (STRUCT_CH.test(tr.startState.doc.sliceString(fromA, toA)) || STRUCT_CH.test(tr.state.doc.sliceString(fromB, toB))) touched = true;
      });
    } catch { touched = true; }                    // 取不到改动范围 ⇒ 保守重扫 ✓
    /* 【★ 本字段的值是**数组**·2026-10-10（当场回退实证）】上面那句不能照抄 `lineStylesField` 的
       `{ ...value }` ✗ —— 那里 `value` 是对象 ✓，这里 `create` 返回的是 `scanInlineMarks(...)` 的
       **数组** ✗ ⇒ 展开会把数组变成普通对象 ✗ ⇒ 下游按数组用的地方**每键抛一次异常** ✗✗
       （实测：`landed:0`、`pageerror:30`、notes 报"逐键 docLen 不是每次 +1" ✗）。
       数组要**新身份**就用 `slice()` ✓（元素引用不变 ⇒ 不重扫 ✓，身份变 ⇒ 下游重算 ✓）。 */
    if (!touched) return value.slice();            // ★ 零扫描但身份变（数组口径 ✓）
    const spans = tr.state.field(mathSpansField, false)?.spans ?? scanMathSpans(tr.state.doc);
    return scanInlineMarks(tr.state.doc, spans);
  },
});
/* 【前沿机制】长 src 的图当**原子区间**：方向键/选区整块跳过，避免把巨串灌回 DOM。
   短 URL 的图不加原子 —— 保留"光标入内即可改地址"的既有手感。 */
const imageAtomicRanges = EditorView.atomicRanges.of((view) => {
  const marks = view.state.field(inlineMarksField, false) || [];
  const rs = [];
  for (const m of marks) if (m.image && m.image.src.length > 512) rs.push(Decoration.replace({}).range(m.from, m.to));
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
const inlineMarkDecorations = EditorView.decorations.compute(["selection", inlineMarksField, lineStylesField, imgBaseField], (state) => {
  const out = [];
  const tables = state.field(lineStylesField, false)?.tables || [];
  const inTable = (pos) => tables.some((t) => pos >= t.from && pos <= t.to);   // 表格行走块级 widget，行内装饰必须让位
  for (const mark of state.field(inlineMarksField)) {
    const inSel = state.selection.ranges.some((r) => r.from <= mark.to && r.to >= mark.from);
    /* 【图片优先判】先于 "inSel ⇒ 显源码"：data URI 一旦展开就是 90 万字符回灌 DOM，
       前沿线实测那种行"折行"要 50~78ms/键。所以**长 src 的图永远保持 widget**（要改地址走"编辑源码"）。 */
    if (mark.image) {
      const longSrc = mark.image.src.length > 512;
      /* 【F7 两态】光标在 mark 内且 src 短 ⇒ 露源码（保留"点进去改 URL"）；
         但**这张图已被判定取不到时必须继续显示占位**，否则"编辑中"与"图坏了"分不出来。 */
      const rec = mpImgLoadState.get(mpImgKey(mark.image.src));
      const failedKnown = !!rec && rec !== "ok";
      if (!inSel || longSrc || failedKnown) {
        out.push(Decoration.replace({ widget: new ImageWidget(mark.image.src, mark.image.alt, mark.image.title, mark.image.width, mark.image.height, mark.image.align) }).range(mark.from, mark.to));
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
    /* 【下划线走"类"而不是"隐藏区间"·2026-10-11】`<u>…</u>` 用 `hides` 做零宽替换时，
       **开标签只隐掉 2 个字符、`<` 留在屏幕上** ✗（实测：屏幕上 `甲词<`、文本节点就是它；
       同类的 `~~`/`**`/行内代码全部正常 ⇒ 只有这条宽度 3 的成对标签规则会这样 ✗，
       引擎自己的标记表其实是**对的**（`from:0,to:9`、`<u>甲词</u>` ✓）。
       与其继续追 CM6 的替换语义，改用**零成本且不依赖替换**的做法 ✓：
       把整个 `<u>…</u>` 区间打一个类 `mp-u` ✓，由 CSS 把开闭标签**收成零宽**、正文加下划线 ✓
       （CSS 用 mp-qmark 那套：`display:inline-block;width:0;overflow:hidden;opacity:.001` ✓）。
       好处：不动文档 ✓、不新增扫描 ✓、光标进去仍是源码（上面的 `inSel` 分支照旧 ✓）、
       复制仍然给源码 ✓（CM6 的 copy 从 state 取文本 ✓）。 */
    /* 【下划线 <u>…</u>：本轮**如实显示源码**·2026-10-11】两个方案都试过并实测过：
       ① 用 `hides` 做零宽替换 ⇒ 开标签只隐掉 2 个字符、`<` 留在屏幕上 ✗（`~~`/`**`/行内代码同期全部正常 ✗）；
       ② 用 `Decoration.mark` + `attributes` 把开/闭标签收成零宽 ⇒ `<u>` 收到了 ✓，但**紧邻的 `u` 字符
          被单独拆成一个 span 且保持 8.05px 可见宽** ✗（同样的属性没落到它身上 ✗）= 屏幕上多一个游离的 `u` ✗。
       两种都比"如实显示源码"更糟 ✗ ⇒ 本轮**不做投影** ✓：`<u>`/`</u>` 与 `**` 在光标离开时一样留字面 ✓
       （对用户诚实、可编辑、可复制 ✓）。真正的投影留给下一轮（要点：需要用 CM6 的
       `Decoration.mark` 在**逐字符**粒度上稳定覆盖标签，或改用零宽 widget 顶替标签 ✓）。 */
    if (mark.umark) continue;
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
  constructor(tex, display = false, from = null, to = null, texFrom = null) {
    super(); this.tex = tex; this.display = display; this.from = from; this.to = to; this.texFrom = texFrom;
  }
  eq(other) { return other.tex === this.tex && other.display === this.display && other.from === this.from && other.to === this.to && other.texFrom === this.texFrom; }
  toDOM(view) {
    const box = document.createElement("span");
    box.className = "mp-inline-float" + (this.display ? " mp-inline-float-display" : "");
    if (this.from != null) box.dataset.mpFrom = String(this.from);
    if (this.to != null) box.dataset.mpTo = String(this.to);
    if (this.texFrom != null) box.dataset.mpTexFrom = String(this.texFrom);
    const html = renderMathHTML(this.tex, this.display);
    if (html != null) box.innerHTML = html;
    else box.textContent = this.tex;
    // 【点预渲染框 ⇒ 精确回源码】浮层是渲染体，不是死图：点哪个字形就落到源码里那个
    // token（与点渲染体同一套 K10 五级判定）。此前 pointer-events:none，点击直接穿到
    // 被盖住的下一行——用户实测「点框里的 λ，光标飞到别处、公式塌回渲染态」。
    box.addEventListener("mousedown", (e) => { if (floatClickToSource(box, view, e)) { e.preventDefault(); e.stopPropagation(); } });
    requestAnimationFrame(() => positionInlineFloats(view));
    return box;
  }
  get estimatedHeight() { return -1; } // 纯浮动层：不参与高度图
  ignoreEvent() { return false; }
}
/** 浮动预览框内点击 → 源码精确落位（与点渲染体同一套 K10 五级判定）。
 *  tex/texFrom 从 mathSpansField 现取（同 from/to 的 span），拿不到时退回 data 属性上的 texFrom。
 *  命令口径一致：点 \lambda 落 `\` 与 `l` 之间（mathGlyphOffset 的既有契约）。 */
function floatClickToSource(box, view, event) {
  if (!view) return false;
  const from = Number(box.dataset.mpFrom), to = Number(box.dataset.mpTo);
  const dataTexFrom = Number(box.dataset.mpTexFrom);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  const spans = view.state.field(mathSpansField, false)?.spans ?? [];
  const span = spans.find((s) => s.from === from && s.to === to) || null;
  const tex = span && typeof span.tex === "string" ? span.tex : null;
  const base = span && Number.isFinite(span.texFrom) ? span.texFrom
    : (Number.isFinite(dataTexFrom) ? dataTexFrom : from);
  let pos = base;
  if (tex) {
    const offset = mathGlyphOffset(box, event, tex);
    if (offset != null) pos = base + Math.max(0, Math.min(offset, tex.length));
  }
  view.dispatch({ selection: { anchor: pos } });
  view.focus();
  return true;
}

/** 把每个 .mp-inline-float 摆到**自己那份源码的正下方**。
 *  【坐标系纪律·根因记录】浮层的 offsetParent 是 .cm-scroller（滚动容器）：绝对定位子元素
 *  随内容滚动 ⇒ top/left 必须写**内容坐标**（视口坐标 − offsetParent 视口原点 + 其滚动量）。
 *  历史缺陷：直接写视口坐标 → 文档一滚动，浮层就被甩到 scrollTop 之外（实机复现：
 *  scrollTop=2205 时点击，浮层实测 client top=-1913、style top=292；把 top 改成 2497
 *  立刻可见）＝用户看到的「点了什么都没有」。 */
/** 【task-10】取元素所处的有效缩放。先看**祖先链上的 CSS zoom**（.cm-editor{zoom:var(--mp-zoom)}，
 *  见本文件 .cm-editor 规则），再退回 token --mp-zoom（偏好层会写 root 与 zoomWrap 两处）。
 *  为什么不在元素自己身上读：多数元素没有 zoom 属性，getComputedStyle(el).zoom 会拿到 "normal"。
 *  ⚠️ 全仓**只此一条** zoom 判定路径（表格浮条与浮动公式预览共用），别在别处再写第二套。
 *  取值域：非有限值 / ≤0 / >3 ⇒ 当 1（避免把坐标算成 Infinity）。 */
function mpZoomOf(el) {
  let n = el;
  while (n && n !== document.documentElement) {
    const z = parseFloat(getComputedStyle(n).zoom);
    if (Number.isFinite(z) && z > 0 && z !== 1) return z > 3 ? 1 : z;
    n = n.parentElement;
  }
  const t = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--mp-zoom"));
  return (Number.isFinite(t) && t > 0 && t <= 3) ? t : 1;
}
function positionInlineFloats(view) {
  if (!view) return;
  const host = view.dom;
  const floats = host.querySelectorAll(".mp-inline-float");
  if (!floats.length) return;
  const doc = view.state.doc;
  for (const f of floats) {
    const from = Number(f.dataset.mpFrom);
    const to = Number(f.dataset.mpTo);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    let a = null, b = null;
    try {
      a = view.coordsAtPos(Math.max(0, Math.min(from, doc.length)));
      b = view.coordsAtPos(Math.max(0, Math.min(to, doc.length)));
    } catch { }
    if (!a || !b) continue; // 锚点不在视口内：保持原位（静态落点＝源码之后，同旧 chip 观感）
    const parent = f.offsetParent || host;
    const pr = parent.getBoundingClientRect();
    const sx = parent.scrollLeft || 0, sy = parent.scrollTop || 0;
    /* 【task-10·zoom 轴】offsetParent 链在 .cm-editor 内部，而 .cm-editor 被 --mp-zoom 缩放
       ⇒ 那个局部坐标系是"设备像素 ÷ zoom"。coordsAtPos 给的是**设备像素**，
       视口差值必须 ÷ z 才落得进局部坐标系（否则 zoom≠1 时按比例偏，实测 150% 偏近半倍距离）。
       居中的那一支用的是 parent.clientWidth 与 f.offsetWidth（都是局部单位）⇒ 不需要换算。 */
    const z = mpZoomOf(parent);
    f.style.position = "absolute";
    f.style.left = f.classList.contains("mp-inline-float-display")
      ? Math.round(Math.max(0, ((parent.clientWidth || host.clientWidth) - f.offsetWidth) / 2) + sx) + "px"
      : Math.round((a.left - pr.left) / z + sx) + "px";
    /* 末尾那个 +6（浮层与源码行之间的间距）**也要 ÷z**：间距是"屏幕上的 6px"，
       写进局部坐标就是 6/z。改前它没换算 ⇒ 150% 下视觉间距变成 9.71 而非 6（对抗复核实测），
       而表格浮条那边的 −6 是**设备恒定**的（先按视觉坐标算再 ÷z）⇒ 两处口径原本相反，现在统一为设备 px。 */
    f.style.top = Math.round((b.bottom - pr.top + 6) / z + sy) + "px";
    f.style.zIndex = "20";
  }
}
/** 浮层重定位调度（按帧合并）。
 *  【为何必须·复核实锤】CM6 虚拟滚动＋高度图估计：滚动过程中未测行的估计高度被真实高度
 *  替换，**同一行的内容坐标会漂**（实测 2255.5→2295，+39.5px）。浮层若只在创建那一拍
 *  定位，就会与源码脱开——独立复核实测：快滚往返后偏移 +6 → +45.48px，浮层压住下一段
 *  正文，且此后滚动不再自愈。故滚动/几何变化一律重算。 */
let floatPositionRaf = 0;
function scheduleFloatPosition() {
  if (floatPositionRaf) return;
  floatPositionRaf = requestAnimationFrame(() => {
    floatPositionRaf = 0;
    positionInlineFloats(view);
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
  if (!sel.empty) return;
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
  if (styles) {
    if (styles.tables.some((t) => line.from >= t.from && line.from <= t.to)) return;
    if (styles.styled.some((s) => s.line.from === line.from && (s.cls === "mp-code" || String(s.cls).startsWith("mp-quote")))) return;
  }
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
    const text = ranges.map((r) => st.sliceDoc(r.from, r.to)).join("\n");
    if (!text) return false;
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
    return true;
  },
  cut(event, view) {
    const st = view.state;
    const ranges = st.selection.ranges.filter((r) => !r.empty);
    if (!ranges.length) return false;
    const text = ranges.map((r) => st.sliceDoc(r.from, r.to)).join("\n");
    if (!text) return false;
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
    /* 【β1】行层级的选区是**整行源码**（[line.from, line.to]）：直接 replaceSelection("") 会把那一行
       变成空行 ⇒ scanTables 在这里 break ⇒ **表被切成"只剩表头 + 余下塌成源码"**（用户看见"我的表被切了"）。
       整行选区落在表块里时改走 tableOp('row-delete')（与右键菜单同一实现，守卫/提示一致）。 */
    if (isFullTableRowSelection(st)) {
      try { window.mpExtras?.tableOp?.("row-delete"); } catch (e) { console.error("[mp] 行剪切失败：", e); }
      return true;
    }
    view.dispatch({ ...st.replaceSelection(""), userEvent: "delete.cut", scrollIntoView: true });
    return true;
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
const IMG_BLOB_KEEP = 8;                    // 缓存条数上限（LRU）
const imgBlobs = new Map();                 // src -> { blob, mime, name, bytes } | 'pending' | null(取不到)
let imgBlobBytes = 0;
/** data URI → { mime, base64 }；不是 data URI 返回 null。 */
function imgParseDataUri(src) {
  const m = /^data:([^;,]*)(;[^,]*)?,/.exec(src);
  if (!m) return null;
  return { mime: (m[1] || "").toLowerCase(), base64: /;base64/i.test(m[2] || "") };
}
function imgBlobTouch(src, rec) {
  if (imgBlobs.has(src)) imgBlobs.delete(src);
  imgBlobs.set(src, rec);
  while (imgBlobs.size > IMG_BLOB_KEEP) {
    const k = imgBlobs.keys().next().value;
    const old = imgBlobs.get(k);
    imgBlobs.delete(k);
    if (old && old !== "pending" && old !== null && old.bytes) imgBlobBytes -= old.bytes;
  }
}
async function imgFetchLocal(src) {
  /* 本地图（相对路径/绝对路径）两种取法：
     ① 渲染进程是 `file://` 页面 ⇒ 直接 `fetch(相对路径)` 就能读到同目录文件；
     ② 读不到（路径解析失败/插件 iframe 的 http 宿主）就退回宿主桥 `readFileBase64` 再转 Blob。 */
  try {
    const res = await fetch(src);
    if (res && res.ok) { const b = await res.blob(); if (b && b.size) return b; }
  } catch { /* 落到宿主桥 */ }
  let abs = src;
  try {
    if (!/^[a-zA-Z]:[\\/]/.test(abs) && !abs.startsWith("/")) {      abs = new URL(src, document.baseURI).href;
    }
  } catch { /* 保持原样 */ }
  let path = abs;
  try { if (path.startsWith("file://")) path = decodeURIComponent(new URL(path).pathname).replace(/^\//, "").replace(/\//g, "\\"); } catch { /* 忽略 */ }
  const host = window.mpHost;
  if (!host || typeof host.readFileBase64 !== "function") return null;
  const r = await host.readFileBase64(path);
  if (!r || !r.ok || !r.base64) return null;
  const bin = atob(r.base64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const ext = (path.split(".").pop() || "").toLowerCase();
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif"
    : ext === "webp" ? "image/webp" : ext === "bmp" ? "image/bmp" : "image/png";
  return new Blob([buf], { type: mime });
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
/** 预取一张图的字节（幂等；同一个 src 只会有一个 in-flight）。 */
function imgPrefetch(src) {
  if (!src || typeof src !== "string") return;
  if (src.startsWith("http://") || src.startsWith("https://")) return;   // 网图不预取（离线取不到，也不该偷偷发请求）
  /* 【滚动卡顿·2026-10-09 修复】改前 `imgBlobs.has(src)` 只挡住"已缓存/pending"两种，
     而**判定为不可缓存（null，例如超过 IMG_BLOB_MAX 的大图）的结果没被记住** ⇒
     每次视口变化都把那些大图的 base64 **重新解码一遍**再丢掉（8MB 文档里的巨图正是这一类）。
     现在：null ⇒ 直接返回（不再重复解码）；pending ⇒ 也不重入。 */
  /* 【滚动卡顿·2026-10-09 修复】改前 `imgBlobs.has(src)` 只挡住"已缓存/pending"两种，
     而**判定为不可缓存（null，例如超过 IMG_BLOB_MAX 的大图）的结果没被记住** ⇒
     每次视口变化都把那些大图的 base64 **重新解码一遍**再丢掉（8MB 文档里的巨图正是这一类）。
     现在：null ⇒ 直接返回（不再重复解码）；pending ⇒ 也不重入。 */
  if (imgBlobs.has(src)) {
    const r = imgBlobs.get(src);
    if (r && r !== "pending") imgBlobTouch(src, r);
    return;
  }
  imgBlobTouch(src, "pending");
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
    if (!blob || !blob.size) { imgBlobTouch(src, null); return; }
    if (blob.size > IMG_BLOB_MAX) { imgBlobTouch(src, null); return; }     // 超大图不缓存（首屏优先）
    if (!/^image\//i.test(mime)) mime = blob.type && /^image\//i.test(blob.type) ? blob.type : "image/png";
    if (/svg/i.test(mime)) { imgBlobTouch(src, null); return; }            // SVG 不是位图，不做图片口味
    let name = "image";
    if (data) name = "pasted-image";                       // data URI 没有文件名：给个语义名（不要拿 base64 当名字）
    else {
      try { const u = new URL(src, "file:///"); name = decodeURIComponent((u.pathname || "").split("/").pop() || "image").replace(/[^\w.\-]/g, "_").slice(0, 40) || "image"; }
      catch { /* 解析不了就用默认名 */ }
    }
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += "." + (mime.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "");
    const rec = { blob, mime, name, bytes: blob.size };
    imgBlobBytes += blob.size;
    imgBlobTouch(src, rec);
    while (imgBlobBytes > IMG_BLOB_MAX && imgBlobs.size > 1) {              // 总量超限：淘汰最旧的
      const k = imgBlobs.keys().next().value;
      const old = imgBlobs.get(k);
      imgBlobs.delete(k);
      if (old && old !== "pending" && old !== null && old.bytes) imgBlobBytes -= old.bytes;
    }
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
/** 选区/视口变化后预取（**停稳再做 + 空闲时段 + 只做视口附近**；纯文字文档零成本）。
 *  【滚动卡顿·2026-10-09 修复】改前：每次视口变化（滚轮每一格）都在 **requestAnimationFrame** 里
 *  遍历**全文**行内标记逐个预取 —— 8MB 含图文档上实测（长任务口径）6 次长任务 / 总阻塞 556ms / 最长 132ms
 *  （用户报障原话"滚动中卡顿跳动"）。现在三层收敛：
 *  ① 140ms 去抖：滚动过程中不再往帧里塞活；
 *  ② requestIdleCallback（timeout 兜底）：不占帧预算；
 *  ③ 只做**可视行 ±20 行**、单轮最多 8 张：远处的图等滚过去再说。
 *  A/B（同尺子，24 格滚轮）：长任务 6→1、总阻塞 556→76ms、最长 132→76ms。 */
function scheduleImgPrefetch(view) {
  if (imgPrefetchTimer) return;
  imgPrefetchTimer = setTimeout(() => {
    imgPrefetchTimer = 0;
    const run = () => {
      try {
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
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 600 });
    else setTimeout(run, 0);
  }, 140);
}
let imgPrefetchRaf = 0;
let imgPrefetchTimer = 0;

const imgPrefetchPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.view = view; scheduleImgPrefetch(view); }
  update(u) { if (u.docChanged || u.selectionSet || u.viewportChanged) scheduleImgPrefetch(u.view); }
  destroy() { if (imgPrefetchRaf) cancelAnimationFrame(imgPrefetchRaf); }
});
/** 取证计数：copy 处理器被调用的次数与分支（排障"复制没带上图"用；零成本，只在 copy 时自增）。
 *  `addedInfo` 记下**真正写进 clipboardData 的那一份**（type/size/前 8 字节 + 全字节简单哈希）——
 *  "字节是否与源一致"因此可以在**源侧**断言死，不依赖粘贴端（headless 的粘贴端拿不到字节）。 */
const imgCopyDiag = { calls: 0, imgs: 0, added: 0, lastErr: null, addedInfo: null };
/** 图片口味填充器（**由 docSourceClipboard.copy 调用**，见那边的说明：两个 copy 处理器只会有第一个生效）。
 *  返回 true ＝ 已写入"含图片"的剪贴板载荷（调用方据此直接收工），false ＝ 让文字路径照旧走。 */
function imgCopyFill(event, view) {
  imgCopyDiag.calls++;
  const st = view.state;
  if (st.selection.main.empty) return false;
  const imgs = imagesInSelection(st);
  imgCopyDiag.imgs = imgs.length;
  if (!imgs.length) return false;                       // 纯文字选区：原样交回文字路径
  const cb = event.clipboardData;
  if (!cb) return false;
  /* 文本口味保持"文档源码"（与 D8 口径一致：粘回编辑器仍是 markdown） */
  const ranges = st.selection.ranges.filter((r) => !r.empty);
  const text = ranges.map((r) => st.sliceDoc(r.from, r.to)).join("\n");
  try { cb.setData("text/plain", text); } catch { /* 某些宿主禁止 */ }
  /* 富文本目标：HTML 里带 <img>，Word/网页编辑器可直接取图 */
  try {
    const html = text.split("\n").map((ln) => {
      const esc = ln.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return esc.replace(/!\[([^\]]*)\]\((<[^>]*>|[^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (w0, alt, url) => {
        const u = String(url).replace(/^<|>$/g, "").replace(/"/g, "&quot;");
        return `<img src="${u}" alt="${String(alt).replace(/"/g, "&quot;")}">`;
      });
    }).join("<br>");
    cb.setData("text/html", html);
  } catch { /* 忽略 */ }
  /* 【关键】二进制图片口味：微信/DeepSeek 网页端只认这个。多图时先给第一张（微信一次一张），
     其余仍在 HTML 里，粘到支持多图的目标（Word/网页编辑器）能拿到全部。 */
  let added = 0;
  for (const im of imgs) {
    const rec = imgBlobs.get(im.src);
    if (!rec || rec === "pending" || rec === null) { imgPrefetch(im.src); continue; }
    try {
      const file = new File([rec.blob], rec.name, { type: rec.mime });
      cb.items.add(file, rec.mime);
      added++;
      imgCopyDiag.added = added;
      /* 源侧自证：把"写进去的那一份"的字节指纹记下来（异步算，不影响 copy 本身） */
      try {
        file.arrayBuffer().then((buf) => {
          const u8 = new Uint8Array(buf);
          let h = 0;
          for (let i = 0; i < u8.length; i++) h = ((h * 31) + u8[i]) >>> 0;
          imgCopyDiag.addedInfo = { type: file.type, name: file.name, size: file.size, hash: h.toString(16), head: [...u8.slice(0, 8)].join(",") };
        }).catch(() => { });
      } catch { /* 忽略 */ }
      break;                                              // 微信只接受一张；先保证"粘出去是图"
    } catch (err) { imgCopyDiag.lastErr = String(err && err.message || err); console.error("[mp] 图片进剪贴板失败：", err); }
  }
  event.preventDefault();
  return true;
}

/* 扩展包（更多菜单/大纲/导出/表格操作）与可重配 keymap 的挂载点：CM6 只允许在创建时给扩展，故用 Compartment 事后注入。 */
const extrasCompartment = new Compartment();
const keyCompartment = new Compartment();

const clickToSource = EditorView.domEventHandlers({  mousedown(event, view) {
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
      if (offset != null) pos = span.texFrom + Math.max(0, Math.min(offset, span.tex.length));
    }
    /* 【块公式拖选修复·2026-10-10（普查根因）】原来这里直接精确落位并 `return true`：
       CM6 的 domEventHandlers 返回 true ＝ 该事件已处理 ⇒ **不再走默认处理** ⇒ 拖拽选区机制
       根本不启动（实测拖完选区塌陷、落到"无选区＝整行复制"，Ctrl+C 载荷是缺 $$ 的半截）。
       改成 click vs drag 分离：mousedown 只**记录**落点并放行（return false）⇒ 拖拽正常；
       mouseup 时几乎没有位移（≤4px）才执行精确落位 ⇒ **单击行为与原来完全一致**。
       状态挂在 view 上（expando），不新增模块级变量。 */
    try { view.__mpMathClick = { x: event.clientX, y: event.clientY, pos, t: Date.now() }; } catch { /* 忽略 */ }
    return false;
  },
  mouseup(event, view) {
    let p = null;
    try { p = view.__mpMathClick; view.__mpMathClick = null; } catch { p = null; }
    if (!p) return false;
    if ((event.detail || 1) !== 1) return false;                                   // 双击那段由 mousedown 负责
    if (Math.abs(event.clientX - p.x) + Math.abs(event.clientY - p.y) > 4) return false;  // 拖过 ⇒ 不抢选区
    try { view.dispatch({ selection: { anchor: p.pos } }); view.focus(); } catch { /* 忽略 */ }
    return false;                                                                  // 放行，不影响后续默认行为
  },
});

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
  const id = preferredEditorTheme();
  const root = document.documentElement;
  // 【单一渲染事务·2026-10-07】原先 --mp-* 上坐着四个互不认识的写者（本函数、面板 applyPalette、
  // 工具栏 theme-toggle、EXE 壳 host.js applyTheme），靠"谁后写"定胜负；实测病象：github-dark 后点
  // 一次「切换明暗」→ 整页翻成 telari-light，localStorage 里 editor-theme=telari-light 与 dark=true
  // 自相矛盾，菜单却仍显示「GitHub 深色 · 当前」。现在有登记表（window.mpTheme，由 installExtras 建立）
  // 就**全部委托给它**——它是唯一写者；本函数只在登记表就位前用 TELARI 兜底，
  // 保证 --mp-bg 从第一帧起就有值（否则 html 透明露出原生底，比现状更糟）。
  if (window.mpTheme && window.mpTheme.has(id)) { window.mpTheme.apply(id); return; }
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
.cm-content strong { font-weight: 900; -webkit-text-stroke: .015em currentColor; }
${editorKaiRuleCss()}
/* 公式：裸排（vditor 观感——无胶囊底/无面板），保留命中区与光标语义。
 * 【高度图纪律】widget 元素自身禁 vertical margin（同不进高度图）；间距用 padding。 */
/* 公式：裸排（vditor 观感）。【高度图纪律·A3 复盘】widget 根必须 display:block
 * 且吸收 KaTeX .katex-display 的 1em margin——内联根会让子 margin 漏出盒外
 * （DOM 与高度图差 ~15px→点击漂移一行）；间距一律走自身 padding。 */
.mp-cm6-math { background: transparent; padding: 0; border-radius: 0; font-size: 1em; }
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
  background: var(--mp-codeBg);
  background: var(--mp-float-tint);
  border: 1px dashed var(--mp-border);
  border-color: color-mix(in srgb, var(--mp-border) 60%, var(--mp-fg));
  border-radius: 4px;
  padding: 2px 8px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.12);
  box-shadow: 0 2px 10px color-mix(in srgb, var(--mp-fg) 20%, transparent),
              0 0 0 1px color-mix(in srgb, var(--mp-fg) 7%, transparent);
  pointer-events: auto; /* 浮层可点：点字形 → 精确回源码（见 floatClickToSource）；不可点时点击会穿到被盖住的下一行 */
  cursor: text;
  white-space: nowrap;
}
@supports ((backdrop-filter: blur(2px)) or (-webkit-backdrop-filter: blur(2px))) {
  .mp-inline-float {
    background: color-mix(in srgb, var(--mp-float-tint) var(--mp-float-alpha), transparent);
    -webkit-backdrop-filter: blur(var(--mp-float-blur)) saturate(1.05);
    backdrop-filter: blur(var(--mp-float-blur)) saturate(1.05);
  }
}
.mp-inline-float-display { display: inline-block; max-width: 90%; overflow-x: auto; padding: 0.3em 1em; }
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
/* 零宽占位：DOM 里存在（选区盒子因此连续），但一个像素都不占 */
.mp-qmark { display: inline-block; width: 0; height: 1em; overflow: hidden; opacity: .001; pointer-events: none; vertical-align: baseline; }
/* 【mermaid 图表块·2026-10-11】整块（含两侧围栏）被 replace 成这个盒子：居中、限宽、随主题底色，
   内部 SVG 由 mermaid 自带的内联 style 负责配色（主题通过 initialize 的 theme 给）。
   ⚠️ 本注释在 CSS 模板字符串体内，**不许出现反引号**。 */
.mp-mermaid { display: block; padding: 8px 0 12px; text-align: center; overflow-x: auto; }
.mp-mermaid svg { max-width: 100%; height: auto; }
.mp-mermaid[data-mp-mermaid]:empty::after { content: 'mermaid 图表（渲染中…）'; color: var(--mp-muted); font-size: 12px; }
/* 【下划线 <u>…</u>·2026-10-11 本轮不投影 ⇒ 这里只留一条**备而未用**的观感规则：
   将来把标签收成零宽后（用逐字符 mark 或零宽 widget），正文直接带下划线 ✓。
   ⚠️ 本注释在 CSS 模板字符串体内，**不许出现反引号**。 */
.mp-u { text-decoration: underline; text-underline-offset: .18em; text-decoration-thickness: .06em; }
.mp-u-tag { display: inline-block; width: 0; overflow: hidden; opacity: .001; pointer-events: none; }

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
    overflow: "auto", padding: "16px 0 40vh 0", backgroundColor: "var(--mp-bg)",
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
  { tag: t.strong, fontWeight: "900", WebkitTextStroke: ".015em currentColor" },
  { tag: t.emphasis, ...editorKaiStyle() },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--mp-primary)", textDecoration: "none" },
  { tag: t.url, color: "var(--mp-muted)", fontSize: "0.92em" },
  { tag: [t.processingInstruction, t.meta], color: "var(--mp-faint)" },
  { tag: t.quote, color: "var(--mp-muted)" },
  { tag: t.monospace, fontFamily: "var(--mp-font-mono)", background: "var(--mp-codeBg)", borderRadius: "3px", padding: "0.15em 0.3em", fontSize: "0.9em" },
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
let suppressChange = false;
let composingDirty = false; // IME 组字期间挂起的脏标（compositionend 一笔补发）

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
function positionTableBar() {
  if (!view) return;
  const t = tableBarTarget();
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
/** 状态键（不含文档长度/内容哈希/时间）—— 变了才动 DOM，键不变时一个字节都不碰。 */
function scheduleTableChrome() {
  if (!view) return;
  const t = tableBarTarget();
  const reading = document.documentElement.dataset.mpReading === "1";
  const key = t ? [t.table.headerBlock.from, t.col, t.align || "", reading ? "r" : ""].join(":") : "none";
  if (key === tableBarKey) return;
  tableBarKey = key;
  positionTableBar();
}
function installTableBar(v) {
  ensureTableBar();
  v.scrollDOM.addEventListener("scroll", () => { positionCellOverlay(); positionTableBar(); }, { passive: true });
  /* 双开/大纲停靠/toggle 都不产生事务与滚动 ⇒ 用 ResizeObserver 盯编辑面几何跟随 */
  try { if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => positionTableBar()).observe(v.dom); } catch { /* 兜底：window resize */ }
  window.addEventListener("resize", positionTableBar);
  scheduleTableChrome();
  return { position: positionTableBar, schedule: scheduleTableChrome, visible: () => tableBarVisible };
}

function boot(content) {
  if (view) return;
  installZoomWrap();     // 【缩放解耦】先给 #editor 套一层缩放外壳（工具栏/状态栏在 body 上，不在里面）
  applyEnginePrefs();    // 缩放/岛尺寸/版心/状态栏四件套：装编辑器之前先把 token 写好（首帧即正确）
  if (!document.querySelector(".mp-statusbar")) buildStatusBar();
  view = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        markdown({
          base: markdownLanguage,
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
        headingDecorations, // 标题井号投影：光标入行显源码、离行隐藏
        lineStylesField, // 行级样式数据层（标题/围栏/引用，仅文档变化重扫）
        lineClassDecorations, // 行类派生（mp-h1..h6/mp-code/mp-quote → telari 版式）
        mermaidBlocksField, // 【mermaid·2026-10-11】图表块数据层（仅文档变化且含结构字符时重扫）
        mermaidDecorations, // 【mermaid】块级投影：光标入块显源码、离块渲染图表
        inlineMarksField, // 行内标记数据层（**/`/~~/链接，仅文档变化重扫；须在 mathSpansField 后）
        inlineMarkDecorations, // 行内标记投影：光标入段显源码、离段隐藏
        imgBaseField,          // 【图片】文档目录变化时踢一脚，让图片 widget 用新的 base 重建
        imageAtomicRanges, // 【图片】长 data URI 的图当原子区间（方向键整块跳过）
        tableDecorations, // 表格投影：全渲染态＋Excel 式格内编辑（行源码永不露出）
        tableCellClick,
        extrasCompartment.of([]),
        keyCompartment.of(keymap.of([])),
        activeCellField, // 活动格状态（effect 驱动）
        tableSelectionField, // 【β1】选择层级（格/行/列/整表）—— 与活动格**解耦**（见 tableSelectionField 注释）
        tableSelInputGuard, // 【β1】行/列/整表层级下打字：先收场再放行（不许一个看不见的按键改表结构）
        listSemantics,
        tableKeys,
        mathCompletion(), // 数学/块补全（规则与数据复用 2.x 侧纯函数；本文件只做呈现与插入）
        autoBreakMath, // 行中段 $$…$$ 收笔即换行（三道闸；零文档改动优先，闸门内才动结构）
        blockVerticalKeys, // ↑/↓ 跨块边界时进块公式或**图表块**（否则 CM6 会整块跳过）
        docSourceClipboard, // 选区含公式时按文档源码写剪贴板（D8 配套）
        clickToSource,
        kpTypesetPlugin,    // 【排版美化·2026-10-09】阅读模式 + 小文档 + 用户显式开启时，按 Knuth–Plass 整段最优断行
        imgPrefetchPlugin,  // 【图片】选区/视口变化后预取 Blob（copy 里不能 await）
        codeLineNoPlugin,   // 【代码块行号·3.0.9】给代码行挂 data-mp-n（数字由 CSS 计数器画，不进内容）
        sbField,            // 状态栏数据源（文档长度 + 选区主位置；只在这两个数变化时才动 DOM）
        statusBarPlugin,    // 底部状态栏（零每键 DOM 操作，见 ViewPlugin 注释）
        zoomKeys,           // Ctrl+= / Ctrl+- / Ctrl+0 → 只缩放内容区（工具岛大小独立）
        EditorView.updateListener.of((u) => {
          // 性能架构：轻量脏标（长度）代替每键全文克隆——250KB/键的 structured clone 是
          // 大文档打字卡顿源之一；客户端防抖到点后 requestText 拉全文（1500ms 一次，可承受）。
          // IME 组字门控（W1 快赢②）：组字态每笔事务只挂脏标不扰桥，compositionend 一笔补发。
          if (u.docChanged || u.selectionSet) {
            if (u.docChanged && !suppressChange) {
              if (view && view.composing) { composingDirty = true; }
              else post("change", { len: u.state.doc.length });
            }
            if (u.selectionSet || u.geometryChanged) scheduleFloatPosition();
          }
          // 双开（形态 B）状态转发：从视图只读镜像主视图文档。分屏关闭时 mirror() 第一行返回
          //（零成本）；开着时按 Text 对象同一性判脏，纯选区/几何更新不做任何工作。
          /* 【β2】表格工具栏状态键：**必须挂在 if 之外** —— 点格只 dispatch setActiveCell（不落选区、
             不改文档），那种事务的 selectionSet/docChanged 都是 false，挂在 if 里就等于"点格不出工具栏"。 */
          scheduleTableChrome();
          window.mpSplit && window.mpSplit.mirror(u.state);
        }),
        themeVars,
        EditorView.lineWrapping,
      ],
    }),
    parent: document.getElementById("editor"),
  });
  // IME 组字收尾：组字期间挂起的 change 脏标在此一笔补发（丢一笔＝保存调度失联）。
  view.dom.addEventListener("compositionend", () => {
    if (!composingDirty || !view) return;
    composingDirty = false;
    post("change", { len: view.state.doc.length });
  });
  // 表格格编辑覆盖层随滚动重定位
  /* 【β2】滚动钩子合并：先覆盖层、再表格工具栏（监听器数量不变，rAF 数量不增）。 */
  view.scrollDOM.addEventListener("scroll", () => { positionCellOverlay(); positionTableBar(); }, { passive: true });
  // 公式浮动预览随滚动/几何变化重定位（固定内容坐标会因高度图收敛而失准，见 scheduleFloatPosition）
  view.scrollDOM.addEventListener("scroll", scheduleFloatPosition, { passive: true });
  /* Ctrl+滚轮 ＝ 内容缩放（Typora/v2.3.3 同款手感）：只在指针位于**编辑面**内时接管，
     按 10% 一档、与快捷键共用同一个 setter；`passive:false` 才能 preventDefault 掉页面缩放。
     注意方向：deltaY < 0（向上滚）＝放大。 */
  view.dom.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.target && e.target.closest && e.target.closest(".mp-toolbar")) return;   // 岛上滚轮不缩放
    e.preventDefault();
    mpZoomBy(e.deltaY < 0 ? MP_ZOOM_STEP : -MP_ZOOM_STEP);
  }, { passive: false, capture: true });
  // 版心/缩放随窗口尺寸变化重算（rAF 合并，无每键成本）
  try {
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => schedulePageWidth()).observe(document.getElementById("editor"));
  } catch { /* 已有 window.resize 兜底 */ }
  schedulePageWidth();
  mpApplyHostDocDir();   // 首帧就用壳层给的文档目录设好 base（相对路径图首屏即正确）
  window.mpEngine = {
    getValue: () => (view ? view.state.doc.toString() : ""),
    _view: () => view, // 调试/取证通道
    __renderMathHTML: renderMathHTML, // 取证通道：导出公式排版复用同一个渲染器（A/B 注入实测用）
    /* 外观偏好读写（设置面板 / 状态栏 / 取证共用同一条通道；值域见 MP_PREFS） */
    prefs: () => mpPrefsAll(),
    setPref: (id, v) => { mpSetPref(id, v); return mpPrefsAll(); },
    applyPrefs: () => { applyEnginePrefs(); return mpPrefsAll(); },
    /* 取证通道：图片 Blob 预取缓存（判据与排障用；只读快照，不给写入口） */
    imageBlobCache: () => [...imgBlobs.entries()].map(([src, rec]) => ({ src: src.slice(0, 48), state: rec === 'pending' ? 'pending' : rec === null ? 'null' : 'ready', bytes: rec && rec.bytes || 0, mime: rec && rec.mime || null })),
    /* 取证通道：当前选区里"被完整包含"的图片（排障"复制没带上图"用） */
    imgCopyDiag: () => ({ ...imgCopyDiag }),
    /* 取证通道：覆盖层 Ctrl+C 的次数与分支（N1：格内复制到底写没写剪贴板） */
    cellCopyDiag: () => ({ ...cellCopyDiag }),
    /* 取证通道：行内标记清单（排障"某类标记没投影"用） */
    __inlineMarks: () => (view ? (view.state.field(inlineMarksField, false) || []).map((m) => ({
      from: m.from, to: m.to,
      kind: m.qmark ? "qmark" : m.bullet ? "bullet" : m.image ? "image" : m.comment ? "comment" : "wrap",
      text: view.state.doc.sliceString(m.from, m.to).slice(0, 14),
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
      纵向轨迹: (window.__navTrace || []).slice(-12),
    }),
    imagesInSelection: () => (view ? imagesInSelection(view.state) : []).map((im) => {
      const rec = imgBlobs.get(im.src);
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
    setValue: (text) => {
      if (!view) return;
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
        if (start === endCur && insert === "") return; // 内容相同：零扰动（历史/光标/视口全保）
        const sc0 = view.dom.closest(".cm-scroller") || view.scrollDOM;
        scrollTop = sc0 ? sc0.scrollTop : 0;
        /* 【★ 2026-10-09 修·数据丢失级】改前这笔 dispatch **不带 selection**，靠 CM6 原生位置映射。
           同文档外改（上方插几个字）时没问题；但**整篇替换**（打开另一个文件 / 外部整体重载）时：
           旧文档里既有的**非空选区**两端都落在被替换区间内、association 相反 ⇒ 选区被拉成
           `[start, start + insert.length]` ≈ **整篇** ⇒ **用户敲的第一个字就把整篇替换掉**。
           实测残留件形状印证：`#` + 118×「测」+ `\n`（首 `#` 与尾 `\n` 正是选区外的残留）。
           现在显式映射，规则只有一条：**端点落在被替换区间内的，塌缩到替换起点**（绝不让选区跨过新插入的内容）；
           区间外的端点按长度差平移（与原生映射等价，保住"上方插 9 字 col 精确保持"那条既有行为）。 */
        const sel = view.state.selection.main;
        const dLen = insert.length - (endCur - start);
        const mapP = (p) => (p <= start ? p : (p >= endCur ? p + dLen : start));
        view.dispatch({
          changes: { from: start, to: endCur, insert },
          selection: { anchor: mapP(sel.anchor), head: mapP(sel.head) },
          annotations: Transaction.addToHistory.of(false),
          scrollIntoView: false,
        });
        // 视口还原（下一拍，等新高度就绪；最小 diff 高度扰动极小，纯稳态保险）
        const restore = () => {
          const sc = view.dom.closest(".cm-scroller") || view.scrollDOM;
          if (sc) sc.scrollTop = scrollTop;
        };
        requestAnimationFrame(restore);
        setTimeout(restore, 60);
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
  // 双开（形态 B）：主视图＝现在的即时渲染编辑面；从视图＝同一份文档的只读源码。  // 【扩展数组纪律】installSplit 不向主视图的扩展数组注入任何东西（它返回 {toggle,open,close,mirror,…}，
  // 从视图在 open() 时用**自己的最小 state**现场创建）——故这里不需要 Compartment，扩展数组结构零改动；
  // 引擎侧唯一的钩子就是上面 updateListener 里的那一行 mirror(u.state)。
  window.mpSplit = installSplit({ EditorView, EditorState, getView: () => view });
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
    /* 【β1】表内 Ctrl+A 递进 / Ctrl+E 选格：实现只有一份（在 main.js，因为它持有活动格/覆盖层/装饰），
       extras.js 的 tableKeys 只是把键**分派**过来；表外返回 false ⇒ 原生全选 / 用户的"行内代码"照旧。 */
    tableSelect: { cycle: () => cycleTableSelection(), selectCell: () => selectCellText() },
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
