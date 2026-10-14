/* CM6 引擎扩展包：更多菜单（快捷键设置/主题/表情/关于/帮助）、大纲、导出、表格行列与复制。
 * 设计纪律：
 *  · 引擎核心（main.js）不动数据层：本模块只读 mathSpansField/lineStylesField，写文档一律用一次 dispatch（一次 Ctrl+Z 可退）。
 *  · 主题与颜色走 CSS 变量（--mp-*），不写死色值；面板/弹层用 absolute 挂在编辑面上，不占排版流。
 *  · 导出与复制：不把整篇+全部图片一次性塞进内存（v2.3.3 卡死的教训），分块拼接 + 体积闸门 + 进度提示。
 */

/* 【引用区表格·2026-10-08】表块前缀判据必须与渲染层/tables.js **同源**（同一函数，不是抄一份）：
   三处（渲染层 scanTables / 源码键位 tableBlockOf / 本模块的行列命令与复制）不同源，
   就会出现"渲染成表了、命令说不在表内"。 */
import { tableLead, withTableLead, isFenceAt, isSeparatorBody } from "./tables.js";
import { codeBlockAt, quoteLead, scanFenceLines, codeBody } from './markdown-context.js';
import { EditorSelection } from '@codemirror/state';
import { SearchQuery, getSearchQuery, setSearchQuery } from '@codemirror/search';
import { reserveImageInsertion, captureImageDocument } from './image-insertion.js';
import { mathSourcePosition } from './math-source-map.js';
import { collectImageRefs, decodeImageAttribute } from './resource-images.js';
import { renderInline } from './inline-format.js';
/* 【Typora 社区主题·2026-10-09】用户想直接用 Typora 的主题 CSS。
   改写逻辑**不在这里另写一份**：2.x 线早有一份纯函数实现（`user-theme.mjs` 的 adaptTyporaTheme）
   ——`#write` → 我们的写作区、`:root` 变量挂到作用域属性上、带相对 url() 的 @font-face 丢掉、
   @media/@supports 照留。这里只传 `surface: '.cm-content'`，两条线的改写行为因此永远一致（AGENTS 错-4）。 */
import { adaptTyporaTheme } from "../../Typora-Editor-App/app/renderer/js/user-theme.mjs";
/* 【正文右键菜单复用·2026-10-10】编辑动作与工具栏共用同一张表（见 toolbar.js 的导出注释）。 */
import { TOOLBAR_ACTIONS } from "./toolbar.js";

/** 面板样式（岛、弹层、面板、吐司） */
const CSS = `
/* ① 工具栏岛：**样式不在这里定义**——唯一来源是 main.js 里 .mp-toolbar 那段。
   本文件早先另写了一份 width:fit-content + margin:auto，在引擎的 position:fixed;left:0;right:0
   之下不生效、却又能盖掉引擎新写的半透明底（后注入同权重胜出），是"岛做好了"假绿的成因之一。 */
.mp-toolbar .mp-tb-sep { margin: 0 6px; }
/* ② 弹层/面板：统一观感
 * 【zoom 安全·2026-10-06】弹层挂 cm-editor（host() 返回的 view.dom）之内，而内容缩放是
 * .cm-editor 上的 CSS zoom。position:absolute 的 left/top 是**文档坐标**，会被 zoom 再乘一遍：
 * 实测 zoom=160% 时「更多」菜单落到 x=1464（视口只有 1400）⇒ 整块菜单在屏幕外，
 * 用户点不到「设置」等任何一项（这条同时是"设置面板打不开/滑杆假"的路径之一）。
 * 改 position:fixed：left/top 用**视口坐标**，不受 zoom 缩放；坐标来源 getBoundingClientRect
 * 本来也是视口坐标 ⇒ 两边同一坐标系。 */
.mp-pop { position: fixed; z-index: 60; min-width: 190px; /* 【普查实测·2026-10-10】60vh 太矮：更多菜单内容 625px / 可视 442px，底部项要滚动才够得到。 */ max-height: min(72vh, calc(100vh - 96px)); overflow: auto;
  background: var(--mp-bg); border: 1px solid var(--mp-border); border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.22); padding: 6px; font: 13px/1.7 var(--mp-font-body); color: var(--mp-fg); }
.mp-pop-item { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 5px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
.mp-pop-item:hover { background: color-mix(in srgb, var(--mp-bg) 78%, var(--mp-fg)); }
.mp-pop-item .k { color: var(--mp-muted); font-size: 12px; }
/* 【右键菜单透明度·2026-10-10 用户要求】菜单底色单独可调（设置 → 界面透明度 → 右键菜单）。
   双类名选择器 .mp-pop.mp-pop-menu 优先级高于 .mp-pop，覆盖不会失效；
   半透明时配一点毛玻璃，字才不至于跟下面的正文糊在一起。
   【写作纪律】本段在模板字符串里，注释不许出现反引号。 */
.mp-pop.mp-pop-menu { background: color-mix(in srgb, var(--mp-bg) var(--mp-context-menu-alpha, 100%), transparent);
  backdrop-filter: blur(6px); }
.mp-pop-title { padding: 4px 10px 6px; color: var(--mp-muted); font-size: 12px; }
/* 【弹层关闭按钮·2026-10-09 用户要求】所有弹层右上角常住 ✕（在 openPop 里统一插入，见那里的说明）。
   标题与首项右侧留出避让位，免得 ✕ 压住文字。 */
.mp-pop-close { position: sticky; top: 0; float: right; margin: -2px -2px 0 8px; width: 22px; height: 22px;
  display: inline-flex; align-items: center; justify-content: center; border-radius: 6px; cursor: pointer;
  color: var(--mp-muted); font-size: 13px; line-height: 1; z-index: 1; }
.mp-pop-close:hover { background: color-mix(in srgb, var(--mp-bg) 74%, var(--mp-fg)); color: var(--mp-fg); }
.mp-pop-title, .mp-pop > .mp-pop-item:first-of-type { padding-right: 30px; }
/* 【全应用面板关闭键·2026-10-09】.mp-dlg 一族的关闭键也必须**钉住**：.mp-dlg 是 overflow:auto 的滚动容器，
   改前 position:absolute 会随内容滚走（设置面板很长，等于没有关闭键）。
   注意：这一条与上面 .mp-pop-close 是同一手法——sticky + float，滚到哪儿都在。
   【写作纪律】本段是模板字符串，注释里不许出现反引号。 */
.mp-dlg .close { position: sticky; top: 0; float: right; z-index: 3; width: 24px; height: 24px; margin: -6px -8px 0 0;
  display: inline-flex; align-items: center; justify-content: center; border-radius: 6px; cursor: pointer;
  color: var(--mp-muted); background: color-mix(in srgb, var(--mp-bg) 92%, transparent); }
.mp-dlg .close:hover { background: color-mix(in srgb, var(--mp-bg) 74%, var(--mp-fg)); color: var(--mp-fg); }
.mp-dlg h3 { padding-right: 32px; }
.mp-pop-sep { height: 1px; background: var(--mp-border); margin: 5px 4px; }
.mp-emoji-grid { display: grid; grid-template-columns: repeat(10, 1fr); gap: 2px; }
.mp-emoji-grid button { font-size: 17px; line-height: 1.4; background: transparent; border: 0; border-radius: 6px; cursor: pointer; padding: 2px 0; }
.mp-emoji-grid button:hover { background: color-mix(in srgb, var(--mp-bg) 76%, var(--mp-fg)); }
/* ③ 大纲面板 */
.mp-outline { position: fixed; z-index: 58; top: 44px; left: 12px; width: 260px; max-height: 62vh; overflow: auto;
  /* 表面语言与工具岛/停靠列统一：半透明底（--mp-outline-alpha）＋毛玻璃（--mp-outline-blur），
     两个值由「设置 → 界面透明度 → 大纲面板」逐项调；投影也改成从 --mp-fg 派生（原来写死了 rgba 黑）。 */
  background: color-mix(in srgb, var(--mp-bg) var(--mp-outline-alpha, 78%), transparent);
  -webkit-backdrop-filter: blur(var(--mp-outline-blur, 10px)) saturate(1.15); backdrop-filter: blur(var(--mp-outline-blur, 10px)) saturate(1.15);
  border: 1px solid var(--mp-border); border-radius: 10px;
  box-shadow: 0 8px 28px color-mix(in srgb, var(--mp-fg) 22%, transparent); padding: 8px 6px; font: 13px/1.6 var(--mp-font-body); }
.mp-outline-item { padding: 3px 8px; border-radius: 6px; cursor: pointer; color: var(--mp-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mp-outline-item:hover { background: color-mix(in srgb, var(--mp-bg) 76%, var(--mp-fg)); }
.mp-outline-item.active { color: var(--mp-primary); background: color-mix(in srgb, var(--mp-bg) 84%, var(--mp-primary)); }
.mp-outline-item.h2 { padding-left: 20px; } .mp-outline-item.h3 { padding-left: 34px; }
.mp-outline-item.h4 { padding-left: 48px; } .mp-outline-item.h5 { padding-left: 62px; } .mp-outline-item.h6 { padding-left: 76px; }
/* ④ 吐司与对话框 */
.mp-toast { position: fixed; z-index: 70; left: 50%; transform: translateX(-50%); bottom: 18px;
  background: color-mix(in srgb, var(--mp-bg) 90%, var(--mp-fg)); color: var(--mp-fg);
  border: 1px solid var(--mp-border); border-radius: 8px; padding: 7px 14px; font: 13px/1.6 var(--mp-font-body);
  box-shadow: 0 6px 20px rgba(0,0,0,.20); }
.mp-dlg { position: fixed; z-index: 72; left: 50%; top: 50%; transform: translate(-50%,-50%); width: min(560px, 88%);
  max-height: 76vh; overflow: auto; background: var(--mp-bg); border: 1px solid var(--mp-border); border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0,0,0,.30); padding: 16px 18px; font: 13px/1.75 var(--mp-font-body); color: var(--mp-fg); }
.mp-dlg h3 { margin: 0 0 8px; font-size: 15px; } .mp-dlg p { margin: 6px 0; color: var(--mp-fg); }
.mp-dlg .k { color: var(--mp-muted); }
.mp-dlg table { width: 100%; border-collapse: collapse; } .mp-dlg td { padding: 3px 6px; border-bottom: 1px solid var(--mp-border); }
/* （.mp-dlg .close 的常驻样式统一写在文件上方那一处，避免同一条规则两处定义、改一处漏一处。） */
.mp-key { display: inline-block; min-width: 58px; padding: 1px 7px; border: 1px solid var(--mp-border); border-radius: 5px;
  background: color-mix(in srgb, var(--mp-bg) 86%, var(--mp-fg)); font: 12px/1.6 var(--mp-font-mono); cursor: pointer; }
.mp-key.editing { border-color: var(--mp-primary); color: var(--mp-primary); }
/* 【导出后可点链接·2026-10-09】提示条里的"打开所在文件夹"：跟主题色走，可点区域够大。 */
.mp-toast-link { color: var(--mp-primary); text-decoration: underline; cursor: pointer; margin-left: 4px; }
.mp-toast-link:hover { text-decoration: none; }
/* ⑤ 双开（形态 B）：主视图与从视图各占一半。分栏只用 flex（**不用 absolute**：主视图仍在排版流里，
   "面板不占排版流"这条不破）；两个 pane 各自独立滚动。分屏关闭时 host 上没有 .mp-split-on，
   这一组规则全部不命中 ⇒ 关闭态零成本（不是"开销小一点"）。色值一律由 --mp-* 派生，无硬编码色。 */
.mp-split-on { display: flex; align-items: stretch; }
.mp-split-on > .cm-editor { flex: 1 1 50%; min-width: 0; }
.mp-split-pane { flex: 1 1 50%; min-width: 0; height: 100%; overflow: hidden;
  border-left: 1px solid var(--mp-border);
  background: color-mix(in srgb, var(--mp-bg) 90%, var(--mp-fg)); }
/* 从视图观感：稍暗底 + 等宽 + 字号小一档（相对单位 ⇒ 编辑器字号整体放大时跟着走）；
   底/字色全部来自主题变量。顶部 padding 沿用全局 .cm-content 规则（工具栏是 fixed，会盖住首行）。 */
.mp-split-source { height: 100%; background: transparent; color: var(--mp-muted); }
.mp-split-source .cm-scroller { overflow: auto; padding: 0 0 40vh 0; background: transparent;
  font-family: var(--mp-font-mono); font-size: 0.86em; line-height: 1.65; }
.mp-split-source .cm-line { font-family: var(--mp-font-mono); }
/* 对侧当前块高亮：底色＝当前主题 bg↔primary 混色（禁硬编码色） */
.mp-split-source .cm-line[data-mp-hl] { background: color-mix(in srgb, var(--mp-bg) 78%, var(--mp-primary));
  border-radius: 3px; color: var(--mp-fg); }
.mp-tb-item.is-active { background: color-mix(in srgb, var(--mp-primary) 22%, transparent); opacity: 1; }
`;

const PALETTES = [
  // 【显示名】用户可见名＝宋韵（id 保持 telari-* 不动：它是 localStorage['editor-theme'] 的键，
  // 也是引擎 preferredEditorTheme() 的匹配依据，改 id 会让老用户的选择失效并牵动引擎映射）
  { id: 'telari-dark', name: '宋韵 深色', dark: true, vars: { '--mp-bg': '#1f2126', '--mp-fg': '#d7dae0', '--mp-heading': '#dee1e6', '--mp-muted': '#8b90a0', '--mp-faint': '#5d6272', '--mp-primary': '#4c9aff', '--mp-border': '#33363f', '--mp-codeBg': '#262a31', '--mp-capsule': '#2a2c31', '--mp-quoteBg': '#303237', '--mp-quoteBar': '#525661', '--mp-sel': 'rgba(76,154,255,0.26)', '--mp-kw': '#c58af9', '--mp-str': '#7ee787', '--mp-com': '#7d8590', '--mp-num': '#f0a35e', '--mp-typ': '#79c0ff' } },
  { id: 'telari-light', name: '宋韵 浅色', dark: false, vars: { '--mp-bg': '#ffffff', '--mp-fg': '#24292f', '--mp-heading': '#1e2227', '--mp-muted': '#6e7781', '--mp-faint': '#9aa2ad', '--mp-primary': '#0969da', '--mp-border': '#d8dee4', '--mp-codeBg': '#f2f4f7', '--mp-capsule': '#f2f2f3', '--mp-quoteBg': '#ebecec', '--mp-quoteBar': '#b3bac1', '--mp-sel': 'rgba(9,105,218,0.26)', '--mp-kw': '#8250df', '--mp-str': '#0a7d33', '--mp-com': '#6e7781', '--mp-num': '#b35900', '--mp-typ': '#0550ae' } },
  { id: 'notion-dark', name: 'Notion 深色', dark: true, vars: { '--mp-bg': '#191919', '--mp-fg': '#d4d4d4', '--mp-heading': '#dcdcdc', '--mp-muted': '#9b9b9b', '--mp-faint': '#6f6f6f', '--mp-primary': '#529cca', '--mp-border': '#2f2f2f', '--mp-codeBg': '#242424', '--mp-capsule': '#242424', '--mp-quoteBg': '#2a2a2a', '--mp-quoteBar': '#555555', '--mp-sel': 'rgba(82,156,202,0.26)', '--mp-kw': '#c191ff', '--mp-str': '#6fbf73', '--mp-com': '#808080', '--mp-num': '#e0a76a', '--mp-typ': '#6fb2d2' } },
  { id: 'notion-light', name: 'Notion 浅色', dark: false, vars: { '--mp-bg': '#ffffff', '--mp-fg': '#37352f', '--mp-heading': '#2d2b27', '--mp-muted': '#787774', '--mp-faint': '#a5a29c', '--mp-primary': '#2383e2', '--mp-border': '#e9e9e7', '--mp-codeBg': '#f7f6f3', '--mp-capsule': '#f3f3f3', '--mp-quoteBg': '#ededec', '--mp-quoteBar': '#c1c1bf', '--mp-sel': 'rgba(35,131,226,0.26)', '--mp-kw': '#9065b0', '--mp-str': '#448361', '--mp-com': '#787774', '--mp-num': '#d9730d', '--mp-typ': '#0b6e99' } },
  { id: 'solarized-dark', name: 'Solarized 深', dark: true, vars: { '--mp-bg': '#002b36', '--mp-fg': '#93a1a1', '--mp-heading': '#a6b2b2', '--mp-muted': '#657b83', '--mp-faint': '#586e75', '--mp-primary': '#268bd2', '--mp-border': '#0b3f4a', '--mp-codeBg': '#073642', '--mp-capsule': '#09323c', '--mp-quoteBg': '#0d3640', '--mp-quoteBar': '#2b545e', '--mp-sel': 'rgba(38,139,210,0.26)', '--mp-kw': '#859900', '--mp-str': '#2aa198', '--mp-com': '#586e75', '--mp-num': '#d33682', '--mp-typ': '#b58900' } },
  { id: 'solarized-light', name: 'Solarized 浅', dark: false, vars: { '--mp-bg': '#fdf6e3', '--mp-fg': '#657b83', '--mp-heading': '#53656b', '--mp-muted': '#93a1a1', '--mp-faint': '#b3a68a', '--mp-primary': '#268bd2', '--mp-border': '#eee8d5', '--mp-codeBg': '#f4eeda', '--mp-capsule': '#f4efdd', '--mp-quoteBg': '#efebda', '--mp-quoteBar': '#cecfc3', '--mp-sel': 'rgba(38,139,210,0.26)', '--mp-kw': '#859900', '--mp-str': '#2aa198', '--mp-com': '#93a1a1', '--mp-num': '#d33682', '--mp-typ': '#b58900' } },
  { id: 'github-dark', name: 'GitHub 深色', dark: true, vars: { '--mp-bg': '#0d1117', '--mp-fg': '#c9d1d9', '--mp-heading': '#d3d9e0', '--mp-muted': '#8b949e', '--mp-faint': '#6e7681', '--mp-primary': '#58a6ff', '--mp-border': '#21262d', '--mp-codeBg': '#161b22', '--mp-capsule': '#181d23', '--mp-quoteBg': '#1e2228', '--mp-quoteBar': '#464d55', '--mp-sel': 'rgba(88,166,255,0.26)', '--mp-kw': '#ff7b72', '--mp-str': '#a5d6ff', '--mp-com': '#8b949e', '--mp-num': '#79c0ff', '--mp-typ': '#ffa657' } },
  { id: 'sepia-light', name: '护眼米黄', dark: false, vars: { '--mp-bg': '#f7f1e3', '--mp-fg': '#3f3a33', '--mp-heading': '#34302a', '--mp-muted': '#7d7466', '--mp-faint': '#a89e8f', '--mp-primary': '#b5651d', '--mp-border': '#e3d9c6', '--mp-codeBg': '#efe6d4', '--mp-capsule': '#ece6d8', '--mp-quoteBg': '#e6e1d3', '--mp-quoteBar': '#bfb6a4', '--mp-sel': 'rgba(181,101,29,0.26)', '--mp-kw': '#8c5a2b', '--mp-str': '#4f7942', '--mp-com': '#8a8172', '--mp-num': '#a8562b', '--mp-typ': '#2f6f8f' } },
    /* 【柔和淡绿进主题列表·2026-10-09 用户要求】它本来只是「更多 → 配色」里的**阅读配色**；
       现在同样作为**主题配色**可选（同一套底色，补全浅色主题需要的语法色 token）。 */
    { id: 'green-light', name: '柔和淡绿', dark: false, vars: { '--mp-bg': '#e5eee2', '--mp-fg': '#2e4032', '--mp-heading': '#243026', '--mp-muted': '#516655', '--mp-faint': '#7c8f7e', '--mp-primary': '#245c68', '--mp-border': '#a7bca4', '--mp-codeBg': '#d5e2d2', '--mp-capsule': '#d5e2d2', '--mp-quoteBg': '#dde8da', '--mp-quoteBar': '#a7bca4', '--mp-sel': 'rgba(36,92,104,0.22)', '--mp-kw': '#31605c', '--mp-str': '#3f6b45', '--mp-com': '#6f8574', '--mp-num': '#8a5a2b', '--mp-typ': '#2f6070' } },
];
const EMOJI = ['😀','😄','😁','😅','😂','🙂','😉','😊','😍','🤔','😐','😴','😭','😡','👍','👎','👏','🙏','💪','🎉','✨','🔥','💡','✅','❌','⚠️','❓','❗','⭐','📌','📎','📝','📖','📊','📈','📉','🔍','🔧','⚙️','🚀','🐛','🌱','🌸','☕','🍵','🎯','⏰','🧠','💬','📅','🔒','🔑'];

export function installExtras(deps) {
  // The stock panel commits on keyup/change. Text input and IME commits must
  // update the same query before the next Enter, without touching source/history.
  function syncSearchInput(event) {
    const input = event.target;
    if (input?.tagName !== 'INPUT' || (input.name !== 'search' && input.name !== 'replace') || event.isComposing) return;
    const panel = input.closest('.cm-search'), v = deps.getView();
    if (!panel || !v?.dom.contains(panel)) return;
    const current = getSearchQuery(v.state);
    const query = new SearchQuery({ ...current,
      search: panel.querySelector('input[name="search"]').value,
      replace: panel.querySelector('input[name="replace"]').value,
    });
    if (!query.eq(current)) v.dispatch({ effects: setSearchQuery.of(query) });
  }
  document.addEventListener('input', syncSearchInput, true);
  document.addEventListener('compositionend', syncSearchInput, true);
  const { EditorView, getView, getImageAt, imageSource, lineStylesField, mathSpansField, scrollOffset, exportTypoCss } = deps;
  /* 【贴底/贴边翻转·2026-10-10（zoom-extremes 族 M6/M7）】三套右键菜单（图片 1567／表格 1643／表格行列 1734）
     都是**先定位、后加条目** ⇒ 定位那一刻菜单高度≈0，"下方放不下"根本判不出来 ⇒ 贴近视口底部右键时
     菜单伸出视口，只剩 36px／13px 的细条、**0 个可点项** ✗（实测 100/50/200/300 四档同签名）。
     逐处补钳制既繁琐又容易漏，这里用一个观察器在**菜单插入 DOM 之后**用 rAF 校一次：
     下方放不下就整体上移、右侧放不下就整体左移（照 1722 那条既有范式 ✓）。只依赖 document.body ✓。 */
  const fitMenuIntoViewport = (el) => {
    try {
      const pr = el.getBoundingClientRect();
      /* 【坐标系·2026-10-10】边界必须用**引擎自己的可视化区域**（host() 的矩形 ✓），不能用
         window.innerHeight —— 引擎跑在自己的文档里，"窗口高度"与用户看到的可见区未必相同
         （第一版就是这么没生效的 ✗）。pr 与 hr 同为视口坐标，相减得到的位移量才正确 ✓。 */
      const hs = (typeof host === "function") ? host() : null;
      const hr = (hs && hs.getBoundingClientRect) ? hs.getBoundingClientRect() : document.documentElement.getBoundingClientRect();
      const vBottom = (hr && hr.height) ? hr.bottom : (window.innerHeight || 800);
      const vRight = (hr && hr.width) ? hr.right : (window.innerWidth || 1200);
      /* 【拉伸根因与修复·2026-10-10（zoom-extremes M6/M7）】根因已用算术定死：
         `html[data-mp-statusbar="1"] .mp-pop { bottom: 24px; }`（main.js:3982 ✓ 原意是"别被状态栏盖住"）
         与菜单的**内联 top** 并存 ⇒ `position:fixed` 元素被**拉伸**：高度 = 视口底 − top − 24 − 边距
         ⇒ 越靠视口底越矮（实测 456 / 219 / 13，三档算术全对 ✓）⇒ 贴底右键时可视区里没有条目、
         **0 个可点项** ✗。菜单是 **top 锚定**的，必须显式清掉 bottom ⇒ 高度回到内容高度
         （仍受 .mp-pop 的 max-height 515 约束 ✓，超出时 overflow:auto 正常滚动 ✓）。 */
      el.style.bottom = "auto";
      const before = { top: el.style.top, left: el.style.left, prBottom: Math.round(pr.bottom), prRight: Math.round(pr.right), vBottom: Math.round(vBottom), vRight: Math.round(vRight) };
      /* 【空间自适应·2026-10-10（第二轮）】`bottom:auto` 已让菜单回到**内容高度** ✓（实测 529px、
         firstUsable:true ✓），但 200% 缩放下可用高度不足 ⇒ clipped:5、inViewport:false ✗。
         这里按"上下哪边空间大"处理：① 下方放不下、上方更宽裕 ⇒ **上翻**；② 一律把 max-height
         钳到可用空间（至少留 160px，超出走 overflow:auto 滚动 ✓）。 */
      /* 【选边 + 钳到该侧 + 除缩放位移·2026-10-10】上一版取"两侧较大者"✗ ⇒ 菜单待在**下方**却按
         **上方**空间给高度 ⇒ 实测 t=699/b=1227（溢出 511px ✗）。现在三步：
         ① 判断放上方还是下方（谁宽裕且下方确实放不下）；② maxHeight 钳到**所选那一侧**；
         ③ 上翻的位移量必须**除以缩放**（局部坐标 ≠ 视口 px ✗ —— 上上版就是栽在这里，菜单被推到 t=1377 ✗）。
         缩放比从元素自身的 rect/style 比值推出（position:fixed ⇒ 不受祖先偏移干扰 ✓，不新增依赖 ✓）。 */
      const rect = el.getBoundingClientRect();
      const localTop0 = parseFloat(el.style.top || "0");
      /* 【已回退"真源缩放"·2026-10-10】上一版改用 `--mp-zoom` 作分母 ✗ ⇒ 200% 档把 maxHeight 压得过小
         ⇒ M6/M7@200% 反而翻红（失败 4 → **6** ✗）。实测**启发式（rect.top/style.top）更优** ✓
         ⇒ 回退到那一版（失败 4、M6/M7 四档全绿 ✓）。M4@200% 的剩余问题下一轮换思路：
         用**高度比**（rect.height / styleHeight）推缩放 —— 高度随缩放线性变化 ✓，而 top 含偏移 ✗。 */
      /* 【实测缩放比·2026-10-10】前两版都在"猜比值"（top 比值 ✗ 会退化成 1；换 --mp-zoom 真源 ✗ 实测更差，
         失败 4→6 已回退）。现在**直接量**：放一个 `height:100px` 的 fixed 探针，读回它的 rect 高度
         ⇒ 比值就是该上下文里真实的缩放/变换系数 ✓（不管成因是 zoom 还是 transform ✓ 都能量到 ✓）。 */
      const zGuess = (() => {
        try {
          const p = document.createElement('div');
          p.style.cssText = 'position:fixed;left:-9999px;top:0;width:10px;height:100px;pointer-events:none';
          document.body.appendChild(p);
          const h = p.getBoundingClientRect().height;
          p.remove();
          if (h > 10 && h < 1000) return Math.max(0.2, Math.min(5, h / 100));
        } catch { /* 忽略 */ }
        return (localTop0 > 1 && rect.top > 1) ? Math.max(0.2, Math.min(5, rect.top / localTop0)) : 1;
      })();
      const vpTop = rect.top, h0 = rect.height;
      const below = Math.max(0, (vBottom - 8) - vpTop);
      const above = Math.max(0, vpTop - 8 - hr.top);
      const useAbove = below < Math.min(h0, 515) && above > below;
      const avail = Math.max(160, useAbove ? above : below);
      /* 【单位统一·2026-10-10】`avail` 来自 rect/vBottom（**视口 px** ✓），而 maxHeight 写的是**CSS px** ✗
         ⇒ 200% 档钳制量整整松一倍 ⇒ M4@200% 仍 clipped:9 ✗。除以缩放比即对齐（zGuess 已在上文 ✓）。 */
      /* 【扣自身盒余量·2026-10-10】M4@200% 的完整读数把它定死了：maxH 钳到 361 ✓ 而元素总高 374 ✗
         （374 − 361 = **13** = padding 12 + border 2 ✓）⇒ 底沿 721 > 视口 716 ⇒ 只差 5px 就判 ✗。
         `max-height` 钳的是**内容盒**高度 ⇒ 必须先扣掉自身盒余量，总高才装得下 ✓。 */
      /* 【余量取值修正·2026-10-10】原来用 `rect.height − el.clientHeight` ✗ —— 那是**钳制之后**测的 ✓，
         此时内容已被 max-height 压扁 ⇒ 余量只剩 **1px** ✗（真值 padding 12 + border 2 = **13px** ✓）
         ⇒ 钳制少扣 12px ⇒ 元素底沿 720 > 视口 716 ⇒ M4@200% 就差这 **5px** ✗。
         改用**计算样式**里的 padding+border ⇒ 与测量时机无关 ✓。 */
      const csBox = getComputedStyle(el);
      const boxExtra = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']
        .reduce((n, k) => n + (parseFloat(csBox[k]) || 0), 0);
      el.style.maxHeight = Math.min(515, Math.round(Math.max(80, avail - boxExtra) / (zGuess || 1))) + "px";
      /* 【条件修正·2026-10-10】原来写 `h0 > avail` ✗ ⇒ 上翻场景里 h0(528) > avail(691) 恒假 ⇒ 永不位移 ✗
         （实测 t=699/b=1227 一字未变 ✗）。正确条件是"**菜单向下溢出**"：top + 目标高度 > 视口底 − 8 ✓。 */
      if (useAbove && vpTop + Math.min(h0, 515) > vBottom - 8) {
        const shiftVp = Math.min(h0, (vpTop + avail) - (vBottom - 8));
        if (shiftVp > 0) el.style.top = Math.max(4, localTop0 - shiftVp / zGuess) + "px";
      }
      /* 【已回退"上翻"·2026-10-10】上一版在这里做 `style.top -= (pr.height - spaceAbove)` ✗ ——
         `pr` 是**视口坐标**、`style.top` 是**缩放后的局部坐标**（--mp-zoom 在 .cm-editor 上 ✓），
         两者相减 ⇒ 位移量被放大 ⇒ 实测菜单被推到 **t=1377**（完全出屏 ✗✗）。
         正确做法要像 positionTableBar 那样先 `mpZoomOf(view.dom)` 再换算 ✗ ⇒ 本轮先回退，
         只保留已验证有效的两半：`bottom:auto`（高度回到内容 ✓）与 `maxHeight` 钳制（三档 M4 转 ✓）。 */
      if (pr.right > vRight - 4) el.style.left = Math.max(4, parseFloat(el.style.left || "0") - (pr.right - (vRight - 4))) + "px";
      /* 自证：钩子触发没触发、算出来什么 ⇒ 下次复跑直接读 window.__menuFit（避免再出现
         "什么都没发生却被当成没效果 / 没触发却当成不生效" ✗ —— 错-24 的同族）。 */
      try { (window.__menuFit = window.__menuFit || []).push({ ...before, afterTop: el.style.top, afterLeft: el.style.left }); } catch { /* 忽略 */ }
    } catch { /* 忽略 */ }
  };
  try {
    const mo = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n && n.classList && n.classList.contains('mp-pop-menu')) requestAnimationFrame(() => fitMenuIntoViewport(n));
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  } catch { /* 观察器装不上时保持原行为 */ }
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  /** 浮层的挂载点。
   *  【zoom 安全·2026-10-06 · 关键】必须是 **document.body**，不能是 `view.dom`（.cm-editor）：
   *  内容缩放是 `.cm-editor` 上的 CSS `zoom`，而**祖先的 zoom 会把 `position:fixed` 子元素一起缩放**
   *  （fixed 只免疫"祖先有 transform"，不免疫 zoom）。实测 zoom=160% 时「更多」菜单
   *  rect.x=1464（视口 1400）⇒ 菜单整块在屏幕外，用户点不到「设置」——这也是"设置面板打不开、
   *  看着像滑杆坏了"的路径之一。挂到 body 后浮层永远在缩放盒之外，left/top 就是纯视口坐标。
   *  副作用检查：这些浮层的位置**全部**来自 getBoundingClientRect（视口坐标），
   *  且样式是全局类名（不依赖 .cm-editor 祖先）⇒ 换挂点不影响既有观感。 */
  const host = () => (document.body || (getView() ? getView().dom : null));
  let pop = null, outlineEl = null, toastEl = null, dlgEl = null, currentPalette = null, unsubPrefs = null;

  const panelLifecycles = new WeakMap();
  function armPanel(el, onClose = null) {
    if (!panelLifecycles.has(el)) panelLifecycles.set(el, {
      focus: document.activeElement, ticket: window.mpEngine?.commands.capture(),
      onClose, cleanup: new Set(), recording: null,
    });
    return panelLifecycles.get(el);
  }
  function closePanel(el, restoreFocus = false) {
    if (!el) return;
    const lifecycle = panelLifecycles.get(el);
    const active = document.activeElement;
    // Closing a panel is a new explicit focus intent. Keep a newer editor or
    // external native-input owner when the panel did not own the current focus.
    const returnFocus = restoreFocus && (el.contains(active) || active === document.body || (active === lifecycle?.focus && !getView()?.hasFocus));
    panelLifecycles.delete(el);
    if (pop === el) pop = null;
    if (dlgEl === el) dlgEl = null;
    el.remove();
    if (lifecycle) {
      for (const cleanup of lifecycle.cleanup) cleanup();
      lifecycle.onClose?.();
      if (returnFocus) {
        const previous = lifecycle.focus;
        const commands = window.mpEngine?.commands;
        const sameDocument = lifecycle.ticket && commands?.valid(lifecycle.ticket, { source: false, intent: false });
        if (sameDocument && previous?.isConnected && previous.matches('input, textarea, [contenteditable="true"]') &&
            !previous.closest('.cm-editor') && previous.getClientRects().length) {
          previous.focus({ preventScroll: true });
          if (previous.contains(document.activeElement)) return;
        }
        if (lifecycle.ticket && commands?.resume(lifecycle.ticket, { intent: false })) return;
        // A different document invalidates the old owner. Explicit panel close
        // may return to the current editor, without reviving an old selection.
        if (document.hasFocus() && document.activeElement === document.body) window.mpEngine?.focus();
      }
    }
  }
  const closePop = () => closePanel(pop);
  const closeDlg = () => closePanel(dlgEl);
  /** 提示条。第三参 action = { label, onClick } 时渲染成"文字 + 可点链接"，停留时间拉到 ≥6s（够点）。 */
  function toast(text, ms = 1800, action = null) {
    const h = host(); if (!h) return;
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'mp-toast'; h.appendChild(toastEl); }
    if (action && action.label) {
      toastEl.textContent = '';
      toastEl.appendChild(document.createTextNode(String(text) + ' '));
      const a = document.createElement('a');
      a.className = 'mp-toast-link'; a.href = '#'; a.textContent = action.label;
      a.onclick = (e) => { e.preventDefault(); try { action.onClick && action.onClick(); } catch { /* 忽略 */ } };
      toastEl.appendChild(a);
      ms = Math.max(ms, 6000);
    } else toastEl.textContent = text;
    toastEl.style.display = 'block';
    clearTimeout(toast._t); toast._t = setTimeout(() => { if (toastEl) toastEl.style.display = 'none'; }, ms);
  }
  /** 【导出后可点链接·2026-10-09 用户要求】导出收尾统一走这里：一条带「打开所在文件夹」的提示。
   *  壳层用 showItemInFolder（打开资源管理器并**选中刚导出的文件**）；文件被移走则退而打开其目录。 */
  /** 【导出后可点链接】统一的"打开所在文件夹"动作对象（toastExported 与 say 共用一份实现）。 */
  function openFolderAction(target) {
    return {
      label: '打开所在文件夹',
      onClick: () => {
        const h = window.mpHost;
        if (!h || typeof h.showItem !== 'function') { toast('当前宿主不支持打开文件夹'); return; }
        Promise.resolve(h.showItem(String(target || ''))).then((r) => { if (r && r.ok === false) toast('打开失败：' + (r.error || '未知')); }).catch(() => { });
      },
    };
  }
  /** 【剪贴板写入·2026-10-10】三级：壳层 clipboard.write → navigator.clipboard → textarea+execCommand。
      为什么要壳层那一级：渲染进程的 navigator.clipboard 需要手势/权限，实测"点菜单项"这条路会失败，
      而失败是**静默**的（剪贴板留着旧内容，用户粘出来是上一个东西）。 */
  async function writeClip(payload) {
    const text = String((payload && payload.text) || "");
    const html = (payload && payload.html) ? String(payload.html) : "";
    const h = window.mpHost;
    if (h && typeof h.writeClipboard === "function") {
      try { const r = await h.writeClipboard({ text, html }); if (r && r.ok) return true; } catch { /* 落到下一级 */ }
    }
    try {
      const item = html
        ? new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })
        : new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }) });
      await navigator.clipboard.write([item]);
      return true;
    } catch { /* 落到兜底 */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy"); ta.remove();
      return !!ok;
    } catch { return false; }
  }
  function toastExported(text, targetPath) {
    const target = String(targetPath || '');
    if (!target) { toast(text, 4000); return; }
    toast(text, 6000, openFolderAction(target));
  }

  /* ── 主题调色盘（单一渲染事务） ────────────────────────────────────────────
   * 原先 --mp-* 上坐着**四个互不认识的写者**：引擎 applyEditorTheme、本函数、工具栏 theme-toggle、
   * EXE 壳 host.js applyTheme，靠"谁后写"定胜负。实测病象：github-dark 后点一次工具栏「切换明暗」
   * → 整页翻成 telari-light，而 localStorage 写成 editor-theme=telari-light 且 dark=true 自相矛盾，
   * 菜单却仍显示「GitHub 深色 · 当前」。
   * 现在 window.mpTheme 是**唯一写者**：本函数、工具栏、引擎 setTheme、EXE 壳全部委托 themeApply()，
   * "换主题"从两次写收成**一个事务**；dataset.editorTheme 成为登记 id 的回显（判据与渲染同源）。 */
  function themeApply(id) {
    const p = PALETTES.find((x) => x.id === id) || PALETTES[0];
    currentPalette = p.id;
    const root = document.documentElement;
    root.dataset.editorTheme = p.id;
    root.dataset.mode = p.dark ? 'dark' : 'light';
    for (const [k, v] of Object.entries(p.vars)) root.style.setProperty(k, v);   // 键本身带 --mp- 前缀
    try { localStorage.setItem('editor-theme', p.id); localStorage.setItem('dark', p.dark ? 'true' : 'false'); } catch { }
    return p;
  }
  function applyPalette(id) { toast(`主题：${themeApply(id).name}`); }
  window.mpTheme = {
    list: () => PALETTES.map((p) => ({ id: p.id, name: p.name, dark: !!p.dark })),
    has: (id) => PALETTES.some((p) => p.id === id),
    byId: (id) => PALETTES.find((x) => x.id === id) || null,
    current: () => currentPalette,
    apply: (id) => themeApply(id),
    /* 同族明暗邻居；族内无邻居的两套（GitHub 深色 / 护眼米黄）回落到宋韵 */
    sibling: (id) => {
      const p = PALETTES.find((x) => x.id === id);
      if (p) { const fam = p.id.replace(/-(dark|light)$/, ''); const s = PALETTES.find((x) => x.id === fam + (p.dark ? '-light' : '-dark')); if (s) return s.id; }
      return (p && p.dark) ? 'telari-light' : 'telari-dark';
    },
  };
  // 「当前」判据与持久真源对齐（原先 currentPalette 只在点过一次之后才有值 ⇒ 菜单与画面漂移）
  try { currentPalette = localStorage.getItem('editor-theme') || 'telari-dark'; } catch { currentPalette = 'telari-dark'; }

  /* ── 通用弹层 ── */
  function openPop(anchor, build) {
    const h = host(); if (!h) return;
    closePop();
    pop = document.createElement('div');
    pop.className = 'mp-pop';
    armPanel(pop);
    /* 【定位·2026-10-08】锚点必须**可见**才按它定位：阅读模式下工具栏 `display:none`，
       锚点的 rect 全是 0，照着算会把菜单顶到 (6,6) 甚至负坐标（用户报障形态：菜单"跑到屏幕外"）。
       锚点不可见（或被隐藏）时退回**视口右上角**（阅读态唯一合理的落点）。 */
    const ar = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
    const anchorVisible = !!ar && ar.width > 0 && ar.height > 0 && ar.bottom > 0;
    const hr = h.getBoundingClientRect();
    let left, top;
    if (anchorVisible) { left = Math.max(6, Math.min(ar.left - hr.left, hr.width - 220)); top = ar.bottom - hr.top + 6; }
    else { left = Math.max(6, hr.width - 240); top = 8; }
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    build(pop);
    /* 【关闭按钮·2026-10-09 用户要求】**凡是弹出面板，右上角常住一个 ✕**。
       为什么必须在这里做：弹层有十几个入口（更多/表格/主题配色/表情/大纲…），
       在每处各自加必然漏；这里是**唯一**的构造点（`openPop`）。
       顺手解决"点了别处才关"的旧问题：以前只能点空白处关闭，鼠标离得远时不方便。 */
    if (!pop.querySelector('.mp-pop-close')) {
      const panel = pop;
      const x = document.createElement('span');
      x.className = 'mp-pop-close';
      x.textContent = '✕';
      x.title = '关闭（Esc）';
      x.onclick = (e) => { e.stopPropagation(); closePanel(panel, true); };
      pop.insertBefore(x, pop.firstChild);
    }
    h.appendChild(pop);
    /* 建完再夹一次：菜单可能比视口高（更多菜单有滑杆 + 三档配色）⇒ 底部越界时整体上移。 */
    try {
      const pr = pop.getBoundingClientRect();
      if (pr.bottom > hr.bottom - 4) pop.style.top = Math.max(4, (top - (pr.bottom - hr.bottom) - 4)) + 'px';
      if (pr.right > hr.right - 4) pop.style.left = Math.max(4, (hr.right - 4 - pr.width) - hr.left) + 'px';
    } catch { /* 量不到就保持初值 */ }
    const panel = pop, lifecycle = panelLifecycles.get(panel);
    const away = e => { if (panel.isConnected && !panel.contains(e.target) && e.target !== anchor) closePanel(panel); };
    const awayTimer = setTimeout(() => { if (panel.isConnected) document.addEventListener('mousedown', away, true); }, 0);
    lifecycle.cleanup.add(() => { clearTimeout(awayTimer); document.removeEventListener('mousedown', away, true); });
  }

  /* ── 快捷键设置（Compartment 重配 keymap；白名单动作） ── */
  /* 【Typora 口径·2026-10-10 用户报障补齐】默认表对齐 Typora 的常用格式键：
   *   Ctrl+B 加粗 / Ctrl+I 斜体 / Ctrl+U 下划线（存 `<u>…</u>`）/ Alt+Shift+5 删除线。
   *  Ctrl+Shift+X 仍可用（用户可在「设置 → 快捷键设置…」里改成它）——原值写死成默认值。
   *  ⚠️ `Mod-i` 撞车记录：@codemirror/commands 的 **defaultKeymap**（由 basicSetup 装上）
   *  把 `Mod-i` 绑给 `selectParentSyntax`（选中语法父节点），且它带 `preventDefault`。
   *  本表的 compartment 原先是裸 `keymap.of(...)`（默认优先级）⇒ **被它抢先**，于是 Ctrl+I
   *  在真实按键下"没有斜体、光标却跑到整篇末尾"（实测 sel=0/16、文档零改动）。
   *  对策见 rebindKeys：本表改用 `Prec.high`，与 tableKeys / zoomKeys 同级。 */
  const DEFAULT_KEYS = {
    bold: 'Mod-b', italic: 'Mod-i', underline: 'Mod-u', strike: 'Alt-Shift-5',
    code: 'Mod-e', quote: 'Mod-/', list: 'Mod-l', save: 'Mod-s', outline: 'Mod-Shift-o', export: 'Mod-Shift-e',
  };
  const ACTIONS = {
    /* 行内格式全部走 toolbar.js 的同一个 wrap（唯一实现；落点规则与工具栏按钮逐字节一致）。 */
    bold: (v) => deps.wrapInline(v, '**'), italic: (v) => deps.wrapInline(v, '*'),
    underline: (v) => deps.wrapInline(v, '<u>', '</u>'), strike: (v) => deps.wrapInline(v, '~~'),
    code: (v) => deps.wrapInline(v, '`'),
    quote: (v) => toggleLinePrefix(v, '> '), list: (v) => toggleLinePrefix(v, '- '),
    /* 【Ctrl+S·2026-10-10 普查实测】改前调 window.mpHost.__save —— 这个函数**全仓从未定义**，
       于是页面内 Ctrl+S 是空转（真正落盘的是 500ms 自动保存）。现在走壳层已有的 file:save 通道
       （与自动保存同一条）：有路径就直接写；没有路径就退到「另存为」。失败给提示，不静默。 */
    save: () => {
      const h = window.mpHost;
      if (!h) return;
      if (typeof h.__save === 'function') { h.__save(); return; }
      try {
        const v = getView(); if (!v) return;
        const text = v.state.doc.toString();
        Promise.resolve(typeof h.docInfo === 'function' ? h.docInfo() : null).then((d) => {
          const p = d && (d.filePath || d.path || d.file);
          if (p && typeof h.save === 'function') {
            Promise.resolve(h.save(p, text)).then((r) => { if (r && r.ok === false) toast('保存失败：' + (r.error || '未知')); else toast('已保存'); }).catch(() => toast('保存失败'));
          } else if (typeof h.saveAs === 'function') {
            Promise.resolve(h.saveAs()).then((r) => { if (r && r.ok) toast('已保存'); }).catch(() => { });
          } else toast('当前宿主不支持保存');
        }).catch(() => { });
      } catch (e) { console.error('[mp] Ctrl+S 失败：', e); }
    },
    outline: () => toggleOutline(), export: () => exportHtml(),
  };
  function keyConfig() { try { return { ...DEFAULT_KEYS, ...JSON.parse(localStorage.getItem('mp-keys') || '{}') }; } catch { return { ...DEFAULT_KEYS }; } }
  function setKey(action, combo) { const c = keyConfig(); c[action] = combo; try { localStorage.setItem('mp-keys', JSON.stringify(c)); } catch { } rebindKeys(); }
  const comboOf = (e) => {
    const parts = []; if (e.ctrlKey || e.metaKey) parts.push('Mod'); if (e.shiftKey) parts.push('Shift'); if (e.altKey) parts.push('Alt');
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) parts.push(k);
    return parts.join('-');
  };
  /** 键位显示：`Mod` → `Ctrl`（Windows 口径）。Alt/Shift 组合原样显示。 */
  const showCombo = (c) => String(c || '').replace('Mod', 'Ctrl');
  function rebindKeys() {
    // These product actions use document/context data directly. If a future
    // high-priority action queries CM6 syntax, prepare the pending tree through
    // the shared asyncMarkdown guard before executing that action.
    const v = getView(); if (!v || !deps.keyCompartment) return;
    const cfg = keyConfig();
    const bindings = Object.entries(cfg).filter(([a, c]) => ACTIONS[a] && c).map(([a, c]) => ({ key: c, run: (view) => { const fn = ACTIONS[a]; if (!fn) return false; return window.mpEngine.commands.run(() => fn(view)) !== false; }, preventDefault: true }));
    /* 【必须 Prec.high·2026-10-10 实测】默认优先级的 keymap 会被 basicSetup 的 defaultKeymap
       （`Mod-i` = selectParentSyntax）与语言 keymap 抢先；用 high 之后本表排在最前，
       与 tableKeys / zoomKeys 同级且**注册更早** ⇒ 只有它们的显式键位能覆盖这里，逐字节可控。 */
    v.dispatch({ effects: deps.keyCompartment.reconfigure(deps.Prec.high(deps.keymap.of(bindings))) });
  }

  /* ── 单元格/行操作小工具 ── */
  /* 【唯一实现】行内格式的包裹/取消包裹在 toolbar.js 的 `wrap` 里（deps.wrapInline 注入）。
     这里**故意不再保留第二份**：两份实现一旦分叉，快捷键与工具栏按钮的落点/观感就会不一致
     （AGENTS 错-4；本文件原有一份 wrapSelection 与它行为不同，已删除）。 */
  function toggleLinePrefix(view, prefix) {
    const r = view.state.selection.main;
    const a = view.state.doc.lineAt(r.from).number, b = view.state.doc.lineAt(r.to).number;
    const changes = [];
    for (let n = a; n <= b; n++) {
      const line = view.state.doc.line(n);
      if (line.text.startsWith(prefix)) changes.push({ from: line.from, to: line.from + prefix.length, insert: '' });
      else changes.push({ from: line.from, insert: prefix });
    }
    view.dispatch({ changes });
    return true;
  }

  /* ── 大纲：点条目滚到该标题，**顶部留出工具栏高度**（v2.3.3 的教训：别把目标顶到视口最上方被工具栏挡住） ── */
  function headings() {
    const v = getView(); if (!v) return [];
    const f = v.state.field(lineStylesField, false);
    return (f && f.headings ? f.headings : []).map((h) => ({ from: h.from, level: h.level, text: v.state.doc.lineAt(h.from).text.replace(/^#{1,6}\s*/, '').slice(0, 80) }));
  }
  const headingMeasureKey = {};
  function gotoHeading(from) {
    const v = getView(), commands = window.mpEngine?.commands, ticket = commands?.capture();
    if (!v || commands && !ticket) return;
    v.dispatch({ selection: { anchor: from }, scrollIntoView: false, userEvent: 'select.pointer' });
    v.focus();
    const target = v.state.selection, current = () => (!commands || commands.valid(ticket)) && v.state.selection.eq(target);
    const off = typeof scrollOffset === 'function' ? scrollOffset() : 48;
    v.requestMeasure({ key: headingMeasureKey,
      read: () => current() ? Math.max(0,v.lineBlockAt(from).top-off) : null,
      write: top => { if (top !== null && current()) v.scrollDOM.scrollTop = top; },
    });
  }
  /* ── 大纲展示形式：浮层 / 靠左停靠 / 靠右停靠（「设置」里选） ────────────────
   * 两种外壳共用同一份数据与同一套跳转：停靠＝在编辑容器里插一列（flex，编辑器让位），
   * 浮层＝现有的挂左上角浮板。**偏移规则（目标行别被工具栏遮）两边共用**，所以停靠态不会退化。
   * 能效：切换只是一次 flex 布局变更（CM6 自己重测一次），列表仍是"打开才构建"，无每键开销。 */
  const outlineMode = () => { try { return localStorage.getItem('mp-outline-mode') || 'float'; } catch { return 'float'; } };
  let dockEl = null;
  function applyOutlineMode() {
    const v = getView(); const box = v && v.dom.parentElement;
    const mode = outlineMode();
    document.documentElement.dataset.mpDock = mode === 'float' ? '' : mode;
    if (!box) return;
    if (mode === 'float') {
      box.classList.remove('mp-dock-host');
      if (dockEl) { dockEl.remove(); dockEl = null; }
    } else {
      if (outlineEl) { outlineEl.remove(); outlineEl = null; }                       // 换壳：先收浮层
      if (dockEl && dockEl.dataset.side !== mode) { dockEl.remove(); dockEl = null; box.classList.remove('mp-dock-host'); }
    }
  }
  function toggleOutlineDock(anchor) {
    const v = getView(); if (!v) return;
    const box = v.dom.parentElement; if (!box) return;
    const mode = outlineMode() === 'left' ? 'left' : 'right';
    if (dockEl) { dockEl.remove(); dockEl = null; box.classList.remove('mp-dock-host'); return; }   // 再点＝收起
    const hs = headings();
    box.classList.add('mp-dock-host');
    dockEl = document.createElement('aside');
    dockEl.className = 'mp-outline-dock';
    dockEl.dataset.side = mode;
    if (!hs.length) dockEl.innerHTML = '<div class="mp-pop-title">（本篇没有标题）</div>';
    else for (const x of hs) {
      const d = document.createElement('div');
      d.className = 'mp-outline-item h' + x.level;
      d.textContent = x.text || '(空标题)';
      d.onclick = () => { gotoHeading(x.from); markActiveDock(); };
      dockEl.appendChild(d);
    }
    if (mode === 'left') box.insertBefore(dockEl, v.dom); else box.appendChild(dockEl);
    markActiveDock();
    function markActiveDock() {
      if (!dockEl) return;
      const pos = getView().state.selection.main.head;
      const items = [...dockEl.querySelectorAll('.mp-outline-item')];
      let idx = -1; hs.forEach((x, i) => { if (x.from <= pos) idx = i; });
      items.forEach((el, i) => el.classList.toggle('active', i === idx));
      const act = items[idx]; if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });   // 长文档时当前项自动进视野
    }
  }

  function toggleOutline(anchor) {
    if (outlineMode() !== 'float') return toggleOutlineDock(anchor);
    const h = host(); if (!h) return;
    if (outlineEl) { outlineEl.remove(); outlineEl = null; return; }
    const hs = headings();
    outlineEl = document.createElement('div');
    outlineEl.className = 'mp-outline';
    if (!hs.length) outlineEl.innerHTML = '<div class="mp-pop-title">（本篇没有标题）</div>';
    for (const x of hs) {
      const d = document.createElement('div');
      d.className = 'mp-outline-item h' + x.level;
      d.textContent = x.text || '(空标题)';
      d.onclick = () => { gotoHeading(x.from); markActive(); };
      outlineEl.appendChild(d);
    }
    h.appendChild(outlineEl);
    if (anchor) { const ar = anchor.getBoundingClientRect(), hr = h.getBoundingClientRect(); outlineEl.style.left = Math.max(6, ar.left - hr.left) + 'px'; }
    markActive();
    function markActive() {
      if (!outlineEl) return;
      const v = getView(); const pos = v.state.selection.main.head;
      const items = [...outlineEl.querySelectorAll('.mp-outline-item')];
      let idx = -1;
      hs.forEach((x, i) => { if (x.from <= pos) idx = i; });
      items.forEach((el, i) => el.classList.toggle('active', i === idx));
    }
  }

  /* ── 导出：HTML（下载）与「导出为文件夹（图片外链）」 ─────────────────────
   * 口径（对着 Typora 的胜负手）：**图片不内联**。
   *  · 文件夹导出：本地图片逐张复制进 <目标>/assets/，HTML 里写相对路径；外链/失败的原样保留；
   *  · HTML 分块生成、逐块经 IPC 流式落盘 —— 渲染进程一次只持有一块（v2.3.3 的教训：一次性整篇
   *    md2html + 全图 base64，会让同一份图片在内存里出现 5–6 份副本 → 696KB 源就让 worker 冲到 2.6GB）；
   *  · 单文件下载导出沿用原路径（不复制图片）；宿主没有这套 IPC 时自动降级到下载导出并提示。
   */
  const CHUNK_CHARS = 256 * 1024;   // 每块 HTML 字符上限
  const IMG_CONCURRENCY = 4;        // 图片复制并发（主进程 fs 逐张：读进来就写出去，不进渲染进程内存）
  let progressBound = false;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const decodeSafe = (s) => { try { return decodeURI(s); } catch { return s; } };
  /* 【颜色 token 运行时快照·承重】导出件是**静态页**，`var(--mp-*)` 在那边全部 invalid ⇒
     底纹/边框/链接色会**静默消失**（不报错，最难查的一类）。所以导出时把当前 root 上的颜色 token
     逐条取出来写进导出页的 `:root`。顺带绕开一个既有分裂：TELARI 与 PALETTES 对同一 id 有两套值
     （两个写者都写 :root），快照取到的永远是"用户当时看见的那一份"。 */
  const SNAPSHOT_TOKENS = ['bg', 'fg', 'heading', 'muted', 'faint', 'primary', 'border', 'codeBg', 'capsule',
    'quoteBg', 'quoteBar', 'sel', 'sel-tint', 'kw', 'str', 'com', 'num', 'typ', 'surface-alpha', 'surface-blur'];
  function colorTokenSnapshot() {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    const out = [];
    for (const k of SNAPSHOT_TOKENS) {
      const v = (root.style.getPropertyValue('--mp-' + k) || cs.getPropertyValue('--mp-' + k) || '').trim();
      if (v) out.push(`--mp-${k}:${v}`);
    }
    return out.length ? `:root{${out.join(';')}}` : '';
  }
  /* 【作者层样式·同源】由 typography.js 唯一真源生成（与编辑面同一张值表），本文件不再手抄一套。
     导出页专属的少量适配追加在后面（公式块独占一行等）。 */
  const exportCssText = () => exportTypoCss() + '\n'
    + '.mp-math-block{margin:14px 0;text-align:center;overflow-x:auto;overflow-y:hidden}\n'
    + '.mp-math-block .katex-display{margin:0}\n'
    + '.mp-math{white-space:nowrap}\n'
    + 'pre.mp-math{font:13px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--mp-com);white-space:pre-wrap;margin:10px 0}\n';
  /** 导出页 head：颜色 token 快照 ＋ 同源作者层样式 ＋ 引擎自己那份 KaTeX CSS（字体已内联为 data URL ⇒ 离线可排版）。
   *  mathCss 为空（宿主取不到样式表）时退化为只有前两者，公式会缺排版——由调用方提示。 */
  const htmlHead = (title, mathCss = '') => '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
    + `<title>${esc(String(title || 'MarkPilot 导出'))}</title>\n<style>${colorTokenSnapshot()}</style>\n<style>${exportCssText()}</style>\n`
    + (mathCss ? `<style>${mathCss}</style>\n` : '')
    + '</head>\n<body>\n';
  const HTML_TAIL = '\n</body>\n</html>\n';
  const mdTitle = (md) => ((md.split('\n').find((l) => /^#\s+/.test(l)) || '# MarkPilot 导出').replace(/^#\s+/, '').trim() || 'MarkPilot 导出');
  const safeFileName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'markpilot';

  /** 图片地址映射：命中映射的换成相对路径（assets/x.png），其余原样（外链、data:、复制失败） */
  function mapSrc(raw, srcMap) {
    const s = String(raw == null ? '' : raw).trim().replace(/^<|>$/g, '');
    if (!srcMap || !srcMap.size) return s;
    return srcMap.get(s) || srcMap.get(decodeSafe(s)) || s;
  }
  /* 【导出件卫生·白名单】正文里**原样穿过** esc 的 HTML 只有 <img>（其余标签在 inlineMd 里被 esc 成字面
     文本）。照抄的话，源文档里的 style / on* 会跟着进导出件、也进 PDF 的打印窗口：
       · style 是注入面（position:fixed 盖住整页、background:url(...) 外联）；
       · on* 是脚本面（打印窗口 loadFile 这份 HTML 时会执行）。
     口径与 v2.3.3 的 export-render.js:14-23 同源：属性白名单 + style 子声明白名单。
     但**白名单只加在源文档侧的载体上**，不做整页 DOM sanitize——引擎自己的 KaTeX 输出带 20+ 种内联
     样式（height / vertical-align / top / margin-right / margin-left / border-bottom-width / color），
     Typora 那条 `zoom|width|height` 白名单会把它们整片剥掉，公式直接塌成一堆错位字形
     （反例读数见 .mp-verify/exportfix/out/judge.json 的 naive 臂）。KaTeX 由 mdBodyChunks 的占位符
     回填（inlineMd 末尾），根本不经过这里。 */
  const IMG_ATTRS = new Set(['src', 'alt', 'title', 'width', 'height', 'data-typora-align', 'data-typora-scale']);
  /* style 只留缩放/尺寸三件套，值限「数字 + 可选单位」——素材实测作者写的正是 zoom:N%（5/5 张）；
     定位/叠层/脚本类声明（position/display/background/behavior/expression/z-index/transform…）一律剥掉。 */
  const STYLE_KEEP = /^(?:zoom|width|height)\s*:\s*\d+(?:\.\d+)?(?:%|px|em|rem|vw|vh)?$/i;
  const cleanStyle = (v) => {
    const kept = String(v).split(';').map((s) => s.trim()).filter((s) => STYLE_KEEP.test(s));
    return kept.length ? kept.join('; ') : null;
  };
  const attrEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  /** 行内语法；srcMap 只影响 <img> 的地址；其余属性按白名单收拾（内联样式限三件套、事件处理器不带出） */
  const rewriteImgTag = (tag, srcMap) => String(tag)
    .replace(/^<img\b([^>]*?)\s*\/?>$/i, (_m, attrs) => {
      const keep = [];
      for (const a of String(attrs).matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
        const name = a[1].toLowerCase();
        const raw = a[2] != null ? a[2] : (a[3] != null ? a[3] : (a[4] || ''));
        const value = decodeImageAttribute(raw);
        if (name === 'style') { const s = cleanStyle(value); if (s) keep.push('style="' + s + '"'); continue; }
        if (!IMG_ATTRS.has(name)) continue;
        keep.push(name + '="' + attrEsc(name === 'src' ? mapSrc(value, srcMap) : value) + '"');
      }
      return '<img' + (keep.length ? ' ' + keep.join(' ') : '') + '>';
    });
  /* ── 公式排版（导出）──────────────────────────────────────────────────
   * 口径：**复用引擎已有的 renderMathHTML(tex, display)**——不重写渲染器；行内用 inline、
   * 块级用 display，与编辑面同一份 KaTeX HTML、同一套 KaTeX CSS。
   * 排版只做"摘出来再放回去"：先把 $…$ / $$…$$ 换成不含 markdown 元字符的占位符，
   * 走完原有的 esc＋行内标记链后回填渲染结果——非公式文本的导出路径逐字节不变。
   * 解析失败（renderMathHTML 返回 null）退回原来的 `<code>tex</code>`，不假装成功。 */
  const mathApi = typeof deps.renderMathHTML === "function" ? deps.renderMathHTML : null;
  const PH = (i) => `\u0000M${i}\u0000`;
  /** 导出页里**剥掉编辑器专用**的 sourceMap 标（data-typora-source-*）：那是给编辑面"点字形回源码"
   *  用的，静态导出页毫无用处，却让每处公式的 HTML 近乎翻倍（实测 1,649 → 3,448 B/式；
   *  本篇 5,643 式 ⇒ 白扛 ~5MB）。只做字符串剥离，不重渲染、不影响编辑面 DOM。 */
  const stripSrcMap = (html) => String(html).replace(/ data-typora-source-(?:start|end)="[^"]*"/g, "");
  function mathInlineHtml(tex) {
    const html = mathApi ? mathApi(String(tex), false) : null;
    return html == null ? `<code>${esc(String(tex))}</code>` : `<span class="mp-math">${stripSrcMap(html)}</span>`;
  }
  function mathBlockHtml(tex) {
    const t = String(tex == null ? "" : tex);
    if (!t.trim()) return '<div class="mp-math-block"></div>';
    const html = mathApi ? mathApi(t, true) : null;
    return html == null ? `<pre class="mp-math">${esc(t)}</pre>` : `<div class="mp-math-block">${stripSrcMap(html)}</div>`;
  }
  /* ── 导出页的 KaTeX 样式与字体（离线可排版）──────────────────────────────
   * 取的是**引擎自己正在用的那份** KaTeX CSS（渲染面 <link> 的 app.css），不另抄一份：
   *  · CSS 里每个 @font-face 的 woff2 拉成 data URL 内联 ⇒ 导出的 HTML 脱离本机也能排版；
   *  · 只保留 woff2 一路（woff/ttf 是给老浏览器的，内联三份会让导出体积×3）；
   *  · 拉不到字体时保留原 url() 相对路径，并在返回值里记账（failed>0 ⇒ 调用方提示）。
   * 成本：一次性 ~250KB 字体 → ~340KB base64 字符串，建一次即缓存；正文仍走 mdBodyChunks 分块。 */
  let mathCssCache = null, mathCssInflight = null, mathCssStat = null;
  const mathCssStatVia = { host: 0, fetch: 0, liveSheet: 0, hostErr: null };
  const b64 = (buf) => {
    const bytes = new Uint8Array(buf); let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const katexCssHref = () => {
    try { const l = document.querySelector('link[rel="stylesheet"]'); if (l && l.href) return l.href; } catch { }
    return null;
  };
  /* 【导出公式排版·资源通道】Chromium 禁 fetch(file://)：桌面壳里 katexCssHref() 拿到的是
     file:// 的 app.css，fetch 直接抛错 ⇒ 导出件只有 .katex 标记、没有 CSS，公式印成 "dPdQ"。
     修法是**按协议分流**，两条腿拿到的东西逐字节等价：
       · file:   ⇒ 宿主 fs 通道（mpHost.readFileBase64；壳层 fs 读，asar 感知）——零网络；
       · http(s) ⇒ fetch（插件/开发面本来就通）；
       · 兜底    ⇒ 序列化页面里那份已注入样式表的 cssRules（同源可读时最省事）。
     与图片导出同一条设计：**本地资源走宿主通道，不走 URL 请求**；成本全在导出时刻，启动零开销。 */
  const isFileUrl = (u) => /^file:/i.test(String(u || ''));
  const fileUrlToPath = (u) => {
    try {
      const url = new URL(u);
      let p = decodeURIComponent(url.pathname || '');
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);        // /E:/x → E:/x（Windows 盘符）
      return p || null;
    } catch { return null; }
  };
  const hostReadable = () => !!(window.mpHost && typeof window.mpHost.readFileBase64 === 'function');
  const b64ToBytes = (s) => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
  async function readAssetBytes(absUrl) {
    if (isFileUrl(absUrl) && hostReadable()) {
      const p = fileUrlToPath(absUrl);
      if (!p) throw new Error('bad-file-url');
      const r = await window.mpHost.readFileBase64(p);
      if (!r || !r.ok) throw new Error('host-read: ' + ((r && r.error) || 'unknown'));
      mathCssStatVia.host++;
      return b64ToBytes(r.base64);
    }
    const resp = await fetch(absUrl);
    if (!resp.ok) throw new Error('http ' + resp.status);
    mathCssStatVia.fetch++;
    return new Uint8Array(await resp.arrayBuffer());
  }
  function serializeLiveCss() {
    try {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules = null;
        try { rules = sheet.cssRules; } catch { continue; }   // 跨源 / file:// 可能抛 SecurityError
        if (!rules || !rules.length) continue;
        const txt = Array.from(rules).map((r) => r.cssText).join('\n');
        if (txt.indexOf('KaTeX_Main') >= 0 && txt.indexOf('@font-face') >= 0) return { css: txt, base: sheet.href || document.baseURI };
      }
    } catch { }
    return null;
  }
  async function readKatexCss() {
    const href = katexCssHref() || document.baseURI;
    if (isFileUrl(href) && hostReadable()) {
      const p = fileUrlToPath(href);
      if (p) {
        try {
          const r = await window.mpHost.readFileBase64(p);
          if (r && r.ok) { mathCssStatVia.host++; return { css: new TextDecoder().decode(b64ToBytes(r.base64)), base: href }; }
          mathCssStatVia.hostErr = (r && r.error) || 'unknown';
        } catch (e) { mathCssStatVia.hostErr = String((e && e.message) || e); }
      }
    }
    const live = serializeLiveCss();
    if (live) { mathCssStatVia.liveSheet++; return live; }
    try {
      const resp = await fetch(href);
      if (!resp.ok) throw new Error('http ' + resp.status);
      mathCssStatVia.fetch++;
      return { css: await resp.text(), base: href };
    } catch (e) { return { error: 'css: ' + String((e && e.message) || e) }; }
  }
  function buildMathCss() {
    if (mathCssCache != null) return Promise.resolve(mathCssCache);
    if (mathCssInflight) return mathCssInflight;
    mathCssInflight = (async () => {
      const got = await readKatexCss();
      if (got.error) { mathCssStat = { error: got.error, via: { ...mathCssStatVia } }; return ''; }
      const css = got.css, base = got.base;
      const faces = [];
      const rest = css.replace(/@font-face\s*\{[^}]*\}/g, (b) => { faces.push(b); return ''; });
      const seen = new Map();
      let embedded = 0, failed = 0, fontBytes = 0;
      const outFaces = [];
      for (const f of faces) {
        const m = /url\(\s*(["']?)([^)"']+\.woff2)\1\s*\)/.exec(f);
        if (!m) { outFaces.push(f); continue; }
        const rel = m[2];
        let uri = seen.get(rel);
        if (uri === undefined) {
          try {
            const bytes = await readAssetBytes(new URL(rel, base).href);
            fontBytes += bytes.byteLength; embedded++;
            uri = 'data:font/woff2;base64,' + b64(bytes);
          } catch { uri = null; failed++; }
          seen.set(rel, uri);
        }
        outFaces.push(uri ? f.replace(/src\s*:[^;}]*/, `src:url(${uri}) format("woff2")`) : f);
      }
      mathCssStat = { cssBytes: css.length, faces: faces.length, embedded, failed, fontBytes, via: { ...mathCssStatVia }, outBytes: rest.length + outFaces.join('\n').length };
      return rest + '\n' + outFaces.join('\n');
    })();
    return mathCssInflight.then((v) => { mathCssCache = v; mathCssInflight = null; return v; });
  }
  function inlineMd(line, srcMap, math = false) {
    return renderInline(String(line).replace(/\\\|/g, '|'), {
      math: tex => math && mathApi ? mathInlineHtml(tex) : '<code>' + esc(tex) + '</code>',
      image: image => image.src == null ? rewriteImgTag(image.raw, srcMap)
        : '<img alt="' + attrEsc(image.alt) + '" src="' + attrEsc(mapSrc(image.src, srcMap)) + '">',
      link: href => '<a href="' + attrEsc(href) + '">',
    });
  }
  /** 正文分块生成器：边扫边吐块，调用方拿到一块就能写走（不攒整篇）
   *  【公式排版】opts.math=true 时块级公式走 KaTeX display（复用引擎 renderMathHTML）：
   *   · 单行 `$$…$$`、整行 `$$` 围栏对、`$$content…content$$` 跨行三种形态都排；
   *   · 闭合判据与引擎 scanMathSpans 同口径（围栏形态认整行 `$$`，带内容形态认行尾 `$$`）；
   *   · 兜底纪律不变：只有**看得到闭合行**才进块模式（否则一个孤立 $$ 会把后面整段吞进 <pre>）；
   *   · 单个公式的 TeX 源码最多攒 MATH_TEX_MAX 字符（超限退回 <pre> 文本），块级缓存与整篇无关。 */
  const MATH_TEX_MAX = 32 * 1024;
  function* mdBodyChunks(md, opts = {}) {
    const { srcMap = null, chunkChars = CHUNK_CHARS, math = false } = opts;
    const lines = md.split('\n'), codeStarts = new Map(scanFenceLines(lines).map(b => [b.startLine - 1, b]));
    let buf = [], size = 0, list = null;
    const take = () => { if (!buf.length) return null; const s = buf.join('\n') + '\n'; buf = []; size = 0; return s; };
    const push = s => { buf.push(s); size += s.length + 1; };
    const closeList = () => { if (list) { push(`</${list}>`); list = null; } };
    const blockHtml = tex => math ? mathBlockHtml(tex) : `<pre class="mp-math">${esc(tex)}</pre>`;
    const isMathClose = s => /^\s*\$\$\s*$/.test(s);
    const cellsOf = line => line.slice(tableLead(line).off).trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim());
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i], code = codeStarts.get(i);
      if (code) {
        closeList();
        const last = code.closeFrom == null ? code.endLine : code.endLine - 1;
        const parts = lines.slice(i + 1, last).map(t => codeBody(t, code).text);
        const src = parts.join('\n');
        const api = typeof window !== 'undefined' ? window.mpMermaid : null;
        const svg = /^mermaid$/i.test(code.info) && api?.getSvg ? api.getSvg(src) : null;
        for (let n = 0; n < code.depth; n++) push('<blockquote>');
        if (svg) push(`<div class="mp-mermaid">${svg}</div>`);
        else {
          push('<pre><code>');
          for (const part of parts) {
            push(esc(part));
            if (size >= chunkChars) { const chunk = take(); if (chunk) yield chunk; }
          }
          push('</code></pre>');
        }
        for (let n = 0; n < code.depth; n++) push('</blockquote>');
        i = code.endLine - 1;
      } else {
        const lead = tableLead(line), next = lines[i + 1];
        const header = rowText(line) ? cellsOf(line) : null;
        const isTable = header?.length > 1 && next != null && !codeStarts.has(i + 1) &&
          tableLead(next).q === lead.q && isSeparatorBody(next.slice(tableLead(next).off));
        if (isTable) {
          closeList();
          const sep = cellsOf(next);
          const aligns = sep.map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : null);
          const rowHtml = (cells, tag) => '<tr>' + cells.slice(0, header.length).map((c, k) =>
            `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inlineMd(c, srcMap, math)}</${tag}>`).join('') + '</tr>';
          if (lead.q) push('<blockquote>');
          push('<table><thead>' + rowHtml(header, 'th') + '</thead><tbody>');
          i += 1;
          while (i + 1 < lines.length && !codeStarts.has(i + 1) && rowText(lines[i + 1]) && tableLead(lines[i + 1]).q === lead.q) {
            push(rowHtml(cellsOf(lines[++i]), 'td'));
            if (size >= chunkChars) { const chunk = take(); if (chunk) yield chunk; }
          }
          push('</tbody></table>');
          if (lead.q) push('</blockquote>');
        } else if (/^\s*\$\$/.test(line)) {
          closeList();
          const single = /^\s*\$\$(.+)\$\$\s*$/.exec(line);
          if (single) push(blockHtml(single[1].trim()));
          else {
            const rest = line.slice(/^\s*\$\$/.exec(line)[0].length), tail = !!rest.trim();
            let close = -1;
            for (let k = i + 1; k < Math.min(lines.length, i + 40); k++) {
              if (codeStarts.has(k)) break;
              if (tail ? /\$\$\s*$/.test(lines[k]) : isMathClose(lines[k])) { close = k; break; }
            }
            if (close < 0) push(`<p>${inlineMd(line, srcMap, math)}</p>`);
            else {
              const parts = [rest, ...lines.slice(i + 1, close)];
              if (tail) parts.push(lines[close].replace(/\$\$\s*$/, ''));
              const tex = parts.join('\n');
              push(tex.length > MATH_TEX_MAX ? `<pre class="mp-math">${esc(tex)}</pre>` : blockHtml(tex));
              i = close;
            }
          }
        } else {
          const h = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/.exec(line);
          const item = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
          if (item) {
            const ordered = /^\d/.test(item[1]), tag = ordered ? 'ol' : 'ul';
            if (list !== tag) { closeList(); push(ordered ? `<ol start="${parseInt(item[1], 10)}">` : '<ul>'); list = tag; }
            push(`<li>${inlineMd(item[2], srcMap, math)}</li>`);
          } else {
            closeList();
            if (h) push(`<h${h[1].length}>${inlineMd(h[2] || '', srcMap, math)}</h${h[1].length}>`);
            else {
              const quote = /^>\s?(.*)$/.exec(line);
              if (quote) push(`<blockquote>${inlineMd(quote[1], srcMap, math)}</blockquote>`);
              else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) push('<hr>');
              else if (!line.trim()) push('');
              else push(`<p>${inlineMd(line, srcMap, math)}</p>`);
            }
          }
        }
      }
      if (size >= chunkChars) { const chunk = take(); if (chunk) yield chunk; }
    }
    closeList();
    const chunk = take(); if (chunk) yield chunk;
  }
  function mdToHtml(md, opts) { let out = ''; for (const c of mdBodyChunks(md, opts)) out += c; return out; }

  /* 【先选位置】桌面版：先弹目录选择框 → 流式写盘（渲染进程一次只持一块）；用户取消 ⇒ 什么都不做。
     插件（iframe）没有这套 IPC，才退回浏览器下载（并在提示里说明）。 */
  const canDiskExport = () => {
    const h = window.mpHost;
    return !!(h && typeof h.exportPickFolder === 'function' && typeof h.exportBeginHtml === 'function'
      && typeof h.exportAppendHtml === 'function' && typeof h.exportFinishHtml === 'function');
  };
  const pickDir = async (defaultPath) => {
    try {
      const p = await window.mpHost.exportPickFolder({ defaultPath: defaultPath || undefined });
      return (p && (p.dir || p.path || (typeof p === 'string' ? p : null))) || null;
    } catch { return null; }
  };

  async function exportHtml() {
    const v = getView(); if (!v) return { ok: false };
    const md = v.state.doc.toString();
    let dir = null;
    if (canDiskExport()) { dir = await pickDir(); if (!dir) return { ok: false, canceled: true }; }   // 让用户选存哪儿
    toast('正在导出…');
    const title = mdTitle(md);
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    // 公式排版：先把 KaTeX 样式＋字体（data URL）准备好，再分块吐正文——正文不进一次性大字符串，
    // 写盘/Blob 都直接吃块数组（旧写法先 concat 全文，等于同一份内容在内存里躺两份）。
    const mathCss = mathApi ? await buildMathCss() : '';
    /* 【mermaid 预渲染·2026-10-11】与公式同一个范式：**先 await 一次**把全部图表渲进缓存，
       下面的同步生成器才能直接查缓存吐 `<div class="mp-mermaid">` ✓（一个钩子覆盖 HTML/PDF/复制 ✓）。 */
    let mermaidStat = null;
    try { if (window.mpMermaid && window.mpMermaid.prerender) mermaidStat = await window.mpMermaid.prerender(md); } catch (e) { mermaidStat = { 失败: [{ err: String((e && e.message) || e) }] }; }
    const msMathCss = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
    const head = htmlHead(title, mathCss);
    const parts = [head];
    let bytes = head.length;
    for (const c of mdBodyChunks(md, { math: true })) { parts.push(c); bytes += c.length; }
    parts.push(HTML_TAIL); bytes += HTML_TAIL.length;
    const msBuild = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
    if (dir) {                                   // ① 桌面版：写到用户选的位置
      const beg = await window.mpHost.exportBeginHtml({ dir, name: safeFileName(title) + '.html' });
      if (!beg || !beg.ok) { toast(`写入失败：${(beg && beg.error) || '未知错误'}`); return { ok: false, error: (beg && beg.error) || 'begin-failed' }; }
      for (const c of parts) await window.mpHost.exportAppendHtml({ id: beg.id, text: c });
      const fin = await window.mpHost.exportFinishHtml({ id: beg.id });
      if (!fin || !fin.ok) { toast(`写入失败：${(fin && fin.error) || '未知错误'}`); return { ok: false, error: (fin && fin.error) || 'write-failed' }; }
      const summary = { ok: true, mode: 'single-file', dir, file: fin.file, bytes: fin.bytes || bytes, ms: msBuild, msMathCss, mathCss: mathCssStat, math: !!mathApi };
      lastExport = summary;
      toastExported(`已导出：${fin.file || (safeFileName(title) + '.html')}`, fin.path || fin.dir || fin.file);
      return summary;
    }
    const blob = new Blob(parts, { type: 'text/html;charset=utf-8' });   // ② 插件：退回浏览器下载
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = safeFileName(title) + '.html';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    const summary = { ok: true, mode: 'download', bytes, ms: msBuild, msMathCss, mathCss: mathCssStat, math: !!mathApi };
    lastExport = summary;
    toast(mathCssStat && mathCssStat.failed
      ? `导出完成（${(bytes / 1024).toFixed(0)} KB）；${mathCssStat.failed} 个公式字体未能内联，离线打开可能缺字形`
      : `导出完成（${(bytes / 1024).toFixed(0)} KB，公式已排版、字体已内联）；当前宿主不支持选目录，已用浏览器下载`);
    return summary;
  }

  /** PDF：壳层冻结的接口（内部自己选目标 → staging → printToPDF → 分片落盘）。 */
  async function exportPdf() {
    const h = window.mpHost;
    if (!(h && typeof h.exportPdf === 'function')) { toast('导出 PDF 需要桌面版（当前宿主不支持）'); return { ok: false }; }
    toast('正在导出 PDF…');
    try {
      const r = await h.exportPdf({});
      if (r && r.ok === false) toast(`导出 PDF 失败：${r.error || '未知错误'}`);
      else if (r && (r.path || r.file)) toastExported('已导出 PDF', r.path || r.file);   // 【可点链接】打开所在文件夹
      return r;
    }
    catch (e) { toast('导出 PDF 失败：' + String((e && e.message) || e)); return { ok: false }; }
  }

  /* ── 导出：**一个入口 → 先选格式** ─────────────────────────────────────────
   * 原先格式散在工具栏 / ⋯ 菜单 / 文件菜单三处，且单文件 HTML 直接触发浏览器下载（不问存哪儿）。
   * 现在点「导出」就是拉起这个选择框：选格式 → 需要落盘的都先让你选位置。 */
  function exportDialog() {
    const disk = canDiskExport(), pdf = !!(window.mpHost && typeof window.mpHost.exportPdf === 'function');
    // 禁用态要**仍然读得清**：浏览器默认灰化 + opacity 在深色主题上会把字糊没（实测截图），
    // 所以显式给可用/不可用两种配色，靠 token 派生、不写死颜色。
    const row = (id, name, desc, ok) => `<tr><td style="white-space:nowrap"><button class="mp-key" data-ex="${id}"${ok ? '' : ' disabled'}`
      + ` style="${ok ? '' : 'color:var(--mp-muted);background:color-mix(in srgb, var(--mp-bg) 86%, var(--mp-fg));opacity:1;cursor:not-allowed'}">${name}</button></td><td class="k">${desc}</td></tr>`;
    dialog('导出', `<table>`
      + row('pdf', 'PDF', pdf ? '打印级排版；暗色主题自动转白纸黑字。会先让你选保存位置。' : '需要桌面版（当前宿主不支持）。', pdf)
      + row('html', '单文件 HTML', disk ? '图片内联，一个文件发给别人也能看。会先让你选目录。' : '当前宿主不支持选目录，将直接用浏览器下载。', true)
      + row('folder', 'HTML + 图片文件夹', disk ? '图片不内联、放进 assets/，适合长期归档。会先让你选目录。' : '需要桌面版（当前宿主不支持）。', disk)
      + `</table><p class="k" style="margin:12px 0 6px">或者直接复制：</p><table>`
      + row('copy-rich', '复制为知乎/微信格式', '整篇富文本进剪贴板，直接粘到公众号/知乎编辑器。', true)
      + row('copy-table', '复制表格到 Excel', '光标在表格里时可用，制表符分隔。', true)
      + `</table><p class="k" style="margin:12px 0 6px">图表：</p><table>`
      /* 【灰色入口·2026-10-11 用户要求】"主题暂时保留灰色入口，具体功能不做" ✓ ——
         放一个**禁用态**的入口，把当前实际行为写清楚（跟随编辑器深/浅色 ✓），
         并注明"自定义配色尚未开放" ✓。禁用态配色沿用上面的 row() 约定（不写死色值 ✓）。 */
      + row('diagram-theme', '图表主题', '当前跟随编辑器的深色/浅色；自定义图表配色尚未开放。', false)
      + `</table>`);
    const d = dlgEl; if (!d) return;
    d.querySelectorAll('[data-ex]').forEach((el) => {
      el.onclick = async () => {
        if (el.disabled) return;
        const k = el.dataset.ex; closeDlg();
        try {
          if (k === 'pdf') await exportPdf();
          else if (k === 'html') await exportHtml();
          else if (k === 'folder') await exportFolder();
          else if (k === 'copy-rich') await copyRich();
          else if (k === 'copy-table') await copyTable();
        } catch (e) { toast('操作失败：' + String((e && e.message) || e)); }
      };
    });
  }
  /** 插件（iframe）里 <a download> 可能被宿主拦掉，而 JS 无法可靠探测"是否真被拦"。
   *  所以不做自动判定：导出后给一句提示，指路「更多 → 复制为知乎/微信格式」作为兜底（一次点击）。 */
  async function exportOrCopy() { return exportHtml(); }

  /** 导出为文件夹：xxx.html + assets/（图片**复制**过去、HTML 里写相对路径，不内联 base64）。
   *  需要壳层 IPC（window.mpHost.export*）；没有就降级为下载导出并明说，不假装成功。 */
  async function exportFolder(opts = {}) {
    /* 【PDF 复用同一条流程 ⇒ 必须能静音】导出 PDF 时壳层把目标目录定成 staging 临时目录
       （MarkPilot-CM6/main.js:332-340：pdfActive 期间 export:pickFolder 不问用户、直接返回 staging），
       于是「已导出：<临时目录>\xxx.html（HTML …）」这条吐司会当着用户的面报一个他既没选、也不该看见的路径。
       opts.silent 只关**提示**：返回值 / lastExport 统计 / 分块写盘 / assets 复制一律不动，
       文件夹导出（不传 opts）逐字不变。调用侧见 MarkPilot-CM6/renderer/host.js 的 onExportMakeHtml。 */
    const say = opts.silent ? () => { } : toast;
    const v = getView(); if (!v) return { ok: false, error: 'no-view' };
    const host = window.mpHost;
    const can = host && typeof host.exportPickFolder === 'function' && typeof host.exportPrepareAssets === 'function'
      && typeof host.exportBeginHtml === 'function' && typeof host.exportAppendHtml === 'function' && typeof host.exportFinishHtml === 'function';
    if (!can) {
      say('当前宿主不支持「导出为文件夹」，已改用下载导出 HTML');
      return exportHtml();
    }
    const md = v.state.doc.toString();
    const title = mdTitle(md);
    const name = safeFileName(title);
    let docPath = null;
    try { const info = await host.docInfo(); docPath = info && info.filePath ? info.filePath : null; } catch { }

    const pick = await host.exportPickFolder({ defaultPath: opts.dir || undefined });
    if (!pick || !pick.ok) {
      if (pick && pick.canceled) return { ok: false, canceled: true };
      say(`导出失败：${(pick && pick.error) || '无法选择文件夹'}`);
      return { ok: false, error: (pick && pick.error) || 'pick-folder-failed' };
    }
    const dir = pick.dir;
    if (host.onExportProgress && !progressBound) {
      progressBound = true;
      try { host.onExportProgress((p) => { if (p && p.total) say(`正在复制图片 ${p.done}/${p.total}…`, 60000); }); } catch { }
    }

    const refs = collectImageRefs(md);
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    let prep = { entries: [], copied: 0, failed: 0, skipped: 0, bytes: 0 };
    if (refs.length) {
      say(`正在复制图片 0/${refs.length}…`, 60000);
      try { prep = await host.exportPrepareAssets({ dir, docPath, refs, concurrency: IMG_CONCURRENCY }); }
      catch (e) { prep = { entries: [], copied: 0, failed: refs.length, skipped: 0, bytes: 0, error: String((e && e.message) || e) }; }
      if (!prep || prep.ok === false) prep = { entries: [], copied: 0, failed: refs.length, skipped: 0, bytes: 0, error: (prep && prep.error) || 'prepare-failed' };
    }
    const srcMap = new Map();
    for (const e of (prep.entries || [])) if (e && e.ok && e.rel) { srcMap.set(e.src, e.rel); srcMap.set(decodeSafe(e.src), e.rel); }

    const beg = await host.exportBeginHtml({ dir, name });
    if (!beg || !beg.ok) { say(`写入失败：${(beg && beg.error) || '未知错误'}`); return { ok: false, error: (beg && beg.error) || 'begin-failed' }; }
    let chunks = 0;
    try {
      const mathCss = mathApi ? await buildMathCss() : '';
      try { if (window.mpMermaid && window.mpMermaid.prerender) await window.mpMermaid.prerender(md); } catch { /* 失败就退回源码块 */ }
      await host.exportAppendHtml({ id: beg.id, text: htmlHead(title, mathCss) });
      for (const chunk of mdBodyChunks(md, { srcMap, math: true })) { await host.exportAppendHtml({ id: beg.id, text: chunk }); chunks++; }
      await host.exportAppendHtml({ id: beg.id, text: HTML_TAIL });
      const fin = await host.exportFinishHtml({ id: beg.id });
      if (!fin || !fin.ok) throw new Error((fin && fin.error) || '写入失败');
      const ms = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
      const summary = {
        ok: true, mode: 'folder', dir, file: fin.file, bytes: fin.bytes, chunks,
        images: refs.length, copied: prep.copied, failed: prep.failed, skipped: prep.skipped, assetBytes: prep.bytes, ms,
        mathCss: mathCssStat, math: !!mathApi,
      };
      lastExport = summary;
      say(`已导出：${fin.file}（HTML ${(fin.bytes / 1024).toFixed(0)} KB · 图片 ${prep.copied} 张外链${prep.failed ? ` · ${prep.failed} 张失败(保留原路径)` : ''}）`, 4200, openFolderAction(fin.file));   // 【可点链接】
      return summary;
    } catch (e) {
      try { await host.exportAbortHtml({ id: beg.id }); } catch { }
      say(`导出失败：${(e && e.message) || e}`);
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  /** 最近一次导出的统计（探针/报告取证用，不参与业务逻辑） */
  let lastExport = null;
  /** 复制为知乎/微信格式：clipboard 写 text/html（全内联样式），粘进知乎编辑器即为富文本 */
  async function copyRich() {
    const v = getView(); if (!v) return;
    const md = v.state.doc.toString();
    const inlineCss = (html) => html
      .replace(/<strong>/g, '<strong style="font-weight:600">')
      .replace(/<h1>/g, '<h1 style="font-size:24px;font-weight:600;margin:22px 0 10px">').replace(/<h2>/g, '<h2 style="font-size:20px;font-weight:600;margin:20px 0 8px">')
      .replace(/<h3>/g, '<h3 style="font-size:17px;font-weight:600;margin:18px 0 8px">')
      .replace(/<p>/g, '<p style="margin:10px 0;line-height:1.75">')
      .replace(/<blockquote>/g, '<blockquote style="border-left:3px solid #dfe2e5;padding-left:12px;color:#6a737d;margin:10px 0">')
      .replace(/<pre><code>/g, '<pre style="background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto;font-size:13px"><code>')
      .replace(/<code>/g, '<code style="background:#f6f8fa;padding:1px 4px;border-radius:3px;font-size:13px">')
      .replace(/<table>/g, '<table style="border-collapse:collapse;margin:12px 0">')
      /* 【β2·§6.2 单一写者】带 text-align 的格**先合并**盒子样式（顺序在裸标签规则之前）：
         不合并的话中/右对齐格不再匹配裸 <td>，在知乎/微信里那一列会**丢边框**；
         而"再拼一段 style"会产生两个 style 属性（第二个被忽略，同样丢样式）。 */
      .replace(/<td style="text-align:(center|right)"/g, '<td style="border:1px solid #dfe2e5;padding:6px 12px;text-align:$1"')
      .replace(/<th style="text-align:(center|right)"/g, '<th style="border:1px solid #dfe2e5;padding:6px 12px;background:#f6f8fa;text-align:$1"')
      .replace(/<td>/g, '<td style="border:1px solid #dfe2e5;padding:6px 12px">')
      .replace(/<th>/g, '<th style="border:1px solid #dfe2e5;padding:6px 12px;background:#f6f8fa;text-align:left">')
      .replace(/<hr>/g, '<hr style="border:0;border-top:1px solid #e1e4e8;margin:18px 0">');
    /* 【mermaid 预渲染·复制路径】与导出同一范式：先 await 一次补齐缓存，再同步生成 ✓
       （少了这一步，复制到知乎/微信时图表位置会变成源码块 —— 与"导出有图、复制没图"的不一致 ✗）。 */
    try { if (window.mpMermaid && window.mpMermaid.prerender) await window.mpMermaid.prerender(md); } catch { /* 退回源码块 */ }
    const html = inlineCss(mdToHtml(md));
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([md], { type: 'text/plain' }),
      })]);
      toast('已复制富文本（可直接粘到知乎/公众号编辑器）');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = html; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      toast('已复制 HTML（浏览器不支持富文本剪贴板，已退化为 HTML 源码）');
    }
  }

  /* ── 表格：行列增删（纯文本操作，一次 dispatch）+ 复制为 TSV/HTML（粘 Excel 成真表格） ── */
  /* 【引用区表格·2026-10-08】前缀感知：表格可以长在引用区里（`> | a | b |`）。
     判据与渲染层/tables.js **同一个** tableLead，三处必须同源——不同源就会出现
     "渲染成表了、命令说不在表内"（用户报障的形态）。 */
  /* 【A3】右键菜单打开时记下的**被点的格**（文档位置）：tableOp 优先用它，用完即清（一次性）。 */
  let menuAnchor = null;
  /* 【A4c 口径统一】"哪一行算表"以**渲染层**为准（main.js 的 parseTableRow/scanTables 是用户看得见的
     事实源）：去掉可选首尾管道后，中间还有**裸** `|` 才算一行。改前这里用 `/^\s*\|/`（必须前导管）
     ⇒ 遇到无前导管的数据行会**断块** ⇒ 只看到表头+分隔行 ⇒ 插入列只重写前两行（表头多一列、数据行不变）。 */
  const rowText = (t) => {
    const m = /^\s*\|?(.*?)\|?\s*$/.exec(t.slice(tableLead(t).off));
    return !!(m && m[1].includes("|"));
  };
  function tableAt(pos) {
    const v = getView();
    // 【纪律】不依赖 lineStylesField.tables 的字段时机（实测：整表重写后紧接着的第二次操作取不到表格），
    // 直接按光标所在行上下收集连续表行 + 必须有分隔行，才算一张表。
    const line = v.state.doc.lineAt(pos);
    if (codeBlockAt(v.state, pos) || !rowText(line.text)) return null;
    const base = tableLead(line.text);
    const same = (n) => { const ld = tableLead(v.state.doc.line(n).text); return ld.q === base.q && rowText(v.state.doc.line(n).text); };
    let a = line.number, b = line.number;
    while (a > 1 && same(a - 1)) a--;
    while (b < v.state.doc.lines && same(b + 1)) b++;
    const rows = [];
    for (let n = a; n <= b; n++) rows.push(v.state.doc.line(n));
    // 分隔行判据也要**剥前缀**：`> | --- | --- |` 的原文不以 `|` 开头，不剥就认不出表
    if (rows.length < 2 || !rows.some((r) => isSep(r.text.slice(tableLead(r.text).off)))) return null;
    return { rows, fromLine: a, toLine: b, lead: base.q };
  }
  const splitRow = (text) => text.slice(tableLead(text).off).trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
  const isSepBody = text => isSeparatorBody(text.slice(tableLead(text).off));
  const isSep = isSepBody;
  /** 新行第一个格内容的源码偏移（剥引用前缀后再找第一个 `|`）：光标落回表内用。 */
  const firstCellOffset = (text) => {
    const skip = tableLead(text).off;
    const rel = /^\s*\|/.exec(text.slice(skip));
    return skip + (rel ? rel[0].length : 0) + 1;
  };
  /** 【β2】分隔行的单个格：**保留冒号的位置与两侧性**，短横按列宽补齐（下限 3）。
   *  显式对齐命令 setAlign 走另一条规则（保留用户写的短横个数），两条规则分开锚。 */
  const sepCellOut = (cell, w) => {
    const core = String(cell == null ? '' : cell).trim();
    const n = Math.max(1, (core.match(/-/g) || []).length);
    const left = core.startsWith(':');
    const right = core.length > 1 && core.endsWith(':');
    const body = '-'.repeat(Math.max(3, w, n));
    return (left ? ':' : '') + body + (right ? ':' : '');
  };
  function rewriteTable(view, rows, fromLine, toLine, newRows, caretRow) {
    const le = tableLead(rows[0] || '');
    const widths = [];
    for (const r of newRows) { if (isSepBody(r)) continue; splitRow(r).forEach((c, i) => { widths[i] = Math.max(widths[i] || 3, c.length); }); }
    const out = newRows.map((r) => {
      /* 【β2·A5/A6】分隔行输出**保留每一列自己的冒号形态**（`:--`/`:-:`/`--:` 逐字保留；
         短横个数允许被列宽重排 —— 复核 §6.4 更正的口径）。移动列时新行数组里的分隔行格已经跟着搬过，
         所以这里按"该行自己的格"取冒号形态，对齐标签就跟着列走。 */
      if (isSepBody(r)) return withTableLead(le.q, '| ' + widths.map((w, i) => sepCellOut(splitRow(r)[i], w)).join(' | ') + ' |');
      const cells = splitRow(r);
      while (cells.length < widths.length) cells.push('');
      return withTableLead(le.q, '| ' + cells.map((c, i) => c + ' '.repeat(Math.max(0, (widths[i] || 3) - c.length))).join(' | ') + ' |');
    });
    const from = view.state.doc.line(fromLine).from, to = view.state.doc.line(toLine).to;
    // 【必须同事务给选区】整表被替换后，落在表内的旧光标会被映射到替换区间**边界**（= 表格外），
    // 于是"连续做第二个表格操作"会报"光标不在表格内"（实测只有第一个操作成功）。所以一次 dispatch 里
    // 就把光标放回表内（同一数据行的首格附近）。引用区表格要把 `> ` 前缀算进去，否则落点跑到格前。
    const after = view.state.doc.line(fromLine).from;
    /* 【task-2 ⑦·光标落点】改前恒落 `out[0]`（＝**表头行**首格）⇒ 实测六例全是
       "Ctrl+Enter 插完行、光标跳回表头"（对抗复核的表：A/B/C/D/E 五例实测落点 = 表头首格，
       应落新行首格）。现在按 `caretRow`（**输出行下标**）落；调用点没传就退回第 0 行（兼容旧调用）。
       注释里那句"同一数据行的首格附近"从改前就没实现过 —— 这次才真落地。 */
    const kRow = Math.max(0, Math.min(Number.isFinite(caretRow) ? caretRow : 0, out.length - 1));
    let off = 0;
    for (let i = 0; i < kRow; i++) off += (out[i] || '').length + 1;   // +1 ＝ 行间换行
    view.dispatch({ changes: { from, to, insert: out.join('\n') }, selection: { anchor: after + off + firstCellOffset(out[kRow] || '') }, userEvent: 'input.table' });
    return true;
  }
  function tableOp(op) {
    return window.mpEngine.commands.run(() => tableOperation(op));
  }
  function tableOperation(op) {
    const v = getView();
    /* 【A3】锚点优先级：右键菜单记下的**被点的格** > CM 选区。菜单命令必须作用在"被点的那一格"上，
       否则会出现"点第 3 行、命令作用在光标所在行"。用完即清，键盘路径不受影响。 */
    const pos = menuAnchor != null ? menuAnchor : v.state.selection.main.head;
    menuAnchor = null;
    const cur = tableAt(pos);
    if (!cur) { toast('光标不在表格内'); return false; }
    const { fromLine, toLine, lead } = cur;
    const rows = cur.rows.map((r) => r.text);   // 【纪律】一律用**文本**：rows 里是 CM6 的 Line 对象，直接当字符串用会炸（实测 se.trim is not a function）
    const rowIdx = v.state.doc.lineAt(pos).number - fromLine;
    const cells = rows.map(splitRow);
    const colIdx = (() => {
      const line = v.state.doc.lineAt(pos);
      /* 【引用区表格】先剥引用前缀：`> | a | b |` 里 `> ` 后面那根管道不是格边界，
         不剥会把列号数大一（插列插到错位置）。 */
      const before = line.text.slice(0, pos - line.from).replace(/^[ \t]*(?:>[ \t]?)+/, '');
      /* 【A4b】与渲染/切分同一口径：裸管道会把 `a\|b` 数成两格，导致 col-left 插到行尾。 */
      return Math.max(0, before.replace(/^\s*\|/, '').split(/(?<!\\)\|/).length - 1);
    })();
    const dataRow = Math.max(0, Math.min(rowIdx, rows.length - 1));
    /* 【引用区表格】改行的三个入口都必须把 `> ` 前缀**原样拼回**：widget 构造的是 `| a | b |` 这种
       无前缀正文，直接落盘就把引用层级删了（表格会被踢出引用区）。 */
    const blank = () => withTableLead(lead, '| ' + cells[0].map(() => '   ').join(' | ') + ' |');
    const joined = (cs) => withTableLead(lead, '| ' + cs.join(' | ') + ' |');
    let next = rows.slice();
    /* 【A4d·F2】表头语义：分隔行与其上那一行是表头。
       改前在**表头行**上按「下方插入行」会把新行插到表头与分隔行之间 ⇒ 分隔行落到第 3 行、
       表头被踢出表格、退化成正文源码（复核线截图确认；`Ctrl+Enter` 正好走这条路径）。
       现在：表头行的「下方」＝插到**分隔行之后**（即第一条数据行）；表头行的「上方」＝插到**表头之上**；
       表头行不能删（删了表格就散了）。 */
    const sepAt = rows.findIndex((r) => isSepBody(r));
    const headerAt = sepAt > 0 ? sepAt - 1 : -1;
    const onHeaderRow = headerAt >= 0 && dataRow <= headerAt;
    if (op === 'row-above') {
      /* 【A4e】表头行不能「上方插入」：GFM 要求表头与分隔行**相邻**，插在表头之上的任何一行都注定在表外
         （A4d 复核实测：新行成表外裸源码行、scanTables 找到的表从第 2 行开始）⇒ 拒绝 + 提示。 */
      if (onHeaderRow) { toast('表头行上方插不了行（表格从表头开始）'); return false; }
      next.splice(Math.max(0, dataRow), 0, blank());
    }
    else if (op === 'row-below') {
      if (onHeaderRow) next.splice(sepAt + 1, 0, blank());
      else next.splice(Math.min(rows.length, dataRow + 1), 0, blank());
    }
    else if (op === 'row-delete') {
      if (onHeaderRow) { toast('表头行不能删（删了表格就散了）'); return false; }
      /* 【A4e】分隔行同样不能删：删掉它整张表就不再被认出（A4d 复核实测 scanTables=0）。 */
      if (isSepBody(rows[dataRow])) { toast('分隔行不能删（删了表格就散了）'); return false; }
      if (rows.length <= 2) { toast('只剩表头，不能再删'); return false; }
      next.splice(dataRow, 1);
    }
    else if (op === 'col-left' || op === 'col-right') {
      const at = Math.max(0, colIdx);
      next = rows.map((r) => { const cs = splitRow(r); cs.splice(op === 'col-left' ? at : at + 1, 0, isSepBody(r) ? '---' : '  '); return joined(cs); });
    }
    /* 【β1·移动行列】Alt+方向（Typora 口径）。守卫与 α 的既有风格一致：一动就破表的一律拒绝 + toast，
       而且**不产生 dispatch**（零文档改动）。成功的移动走 rewriteTable ⇒ 整表重排（Q8 未决，见报告读数）。 */
    else if (op === 'row-move-up' || op === 'row-move-down') {
      if (onHeaderRow || isSepBody(rows[dataRow])) { toast('表头行/分隔行不能移动'); return false; }
      const firstData = Math.max(0, sepAt) + 1;
      const lastData = rows.length - 1;
      if (op === 'row-move-up' && dataRow <= firstData) { toast('已经是第一行'); return false; }
      if (op === 'row-move-down' && dataRow >= lastData) { toast('已经是最后一行'); return false; }
      const j = op === 'row-move-up' ? dataRow - 1 : dataRow + 1;
      if (j < firstData || j > lastData) { toast('已经是第一行'); return false; }
      const swap = next[dataRow]; next[dataRow] = next[j]; next[j] = swap;
    }
    else if (op === 'col-move-left' || op === 'col-move-right') {
      const at = Math.max(0, colIdx);
      /* 列数以**表头**为准（Q10：显示与导出按表头列数）——参差行多的表不许把列"移出去"。 */
      const width = Math.max(cells[0] ? cells[0].length : 0, 1);
      if (width <= 1) { toast('只剩一列，不能移动'); return false; }
      if (op === 'col-move-left' && at <= 0) { toast('已经是第一列'); return false; }
      if (op === 'col-move-right' && at >= width - 1) { toast('已经是最后一列'); return false; }
      const j = op === 'col-move-left' ? at - 1 : at + 1;
      next = rows.map((r) => {
        const cs = splitRow(r);
        if (cs.length <= Math.max(at, j)) return r;      // 参差行缺格 ⇒ 该行原样不动（不擅自动手，Q10）
        const swap = cs[at]; cs[at] = cs[j]; cs[j] = swap;
        return joined(cs);
      });
    } else if (op === 'table-delete') {
      /* 【β2】删除表格（工具栏 🗑 与右键菜单同一实现）：整块删掉，光标落到原位置前一行的行尾。 */
      const from = v.state.doc.line(fromLine).from, to = v.state.doc.line(toLine).to;
      v.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: Math.max(0, from - 1) }, userEvent: 'input.table' });
      toast('已删除表格');
      return true;
    } else if (op === 'col-delete') {
      const at = Math.max(0, colIdx);
      if (cells[0].length <= 1) { toast('只剩一列，不能再删'); return false; }
      next = rows.map((r) => { const cs = splitRow(r); cs.splice(at, 1); return joined(cs); });
    }
    /* 【task-2 ⑦】按 op 算"操作后该行在输出里的下标"：默认＝原行号（列操作/其它都在本行上），
       插行＝新行下标，删行＝删掉后同一位置那一行（钳到末尾），上下移＝移动后的新下标。
       `onHeaderRow`/`sepAt` 在表头行上插行时决定新行落到哪 —— 与上面 splice 的口径**必须一致**。 */
    let caretRow = Number.isFinite(dataRow) ? dataRow : 0;
    if (op === 'row-above') caretRow = Math.max(0, dataRow);
    else if (op === 'row-below') caretRow = onHeaderRow ? sepAt + 1 : Math.min(rows.length, dataRow + 1);
    else if (op === 'row-delete') caretRow = Math.min(dataRow, Math.max(0, next.length - 1));
    else if (op === 'row-move-up') caretRow = Math.max(0, dataRow - 1);
    else if (op === 'row-move-down') caretRow = Math.min(next.length - 1, dataRow + 1);
    rewriteTable(v, rows, fromLine, toLine, next, caretRow);
    toast({
      'row-above': '上方插入行', 'row-below': '下方插入行', 'row-delete': '删除本行',
      'col-left': '左侧插入列', 'col-right': '右侧插入列', 'col-delete': '删除本列',
      'row-move-up': '已上移该行', 'row-move-down': '已下移该行',
      'col-move-left': '已左移该列', 'col-move-right': '已右移该列',
    }[op] || '已修改');
    return true;
  }
  /** 【β2·A7/A8】显式对齐：**只动分隔行该格两侧的冒号**，保留用户写的短横个数；
   *  未标注的列点「左」＝**无操作**（不产生 dispatch、不产生撤销项 —— 用户没写冒号我们不替他写）。
   *  锚点优先级与 tableOp 一致（被点的格 > CM 选区）。 */
  function setAlign(align) {
    return window.mpEngine.commands.run(() => setColumnAlign(align));
  }
  function setColumnAlign(align) {
    const v = getView();
    const pos = menuAnchor != null ? menuAnchor : v.state.selection.main.head;
    menuAnchor = null;
    const cur = tableAt(pos);
    if (!cur) { toast('光标不在表格内'); return false; }
    const sepRow = cur.rows.find((r) => isSep(r.text));
    if (!sepRow) { toast('这张表没有分隔行'); return false; }
    const t = sepRow.text;
    const skip = tableLead(t).off;
    const lead = /^\s*\|/.exec(t.slice(skip));
    let i = skip + (lead ? lead[0].length : 0);
    const ranges = [];
    let segStart = i;
    while (i < t.length) {
      if (t[i] === '\\' && t[i + 1] === '|') { i += 2; continue; }
      if (t[i] === '|') { ranges.push([segStart, i]); segStart = i + 1; }
      i++;
    }
    if (t.slice(segStart).trim()) ranges.push([segStart, t.length]);
    const before = v.state.doc.lineAt(pos).text.slice(0, pos - v.state.doc.lineAt(pos).from).replace(/^[ \t]*(?:>[ \t]?)+/, '');
    const col = Math.max(0, before.replace(/^\s*\|/, '').split(/(?<!\\)\|/).length - 1);
    const r = ranges[col];
    if (!r) { toast('这一列不在表里'); return false; }
    const raw = t.slice(r[0], r[1]);
    const core = raw.trim();
    if (!core) { toast('这一列是空的分隔格'); return false; }
    const n = Math.max(1, (core.match(/-/g) || []).length);
    const hasL = core.startsWith(':'), hasR = core.length > 1 && core.endsWith(':');
    const now = hasL && hasR ? 'center' : hasR ? 'right' : hasL ? 'left' : null;
    if (now === align || (align === 'left' && now === null)) return true;   // 已经是这个对齐（含"未标注⇒左"）⇒ 无操作
    const next = align === 'left' ? '-'.repeat(n) : align === 'center' ? ':' + '-'.repeat(n) + ':' : '-'.repeat(n) + ':';
    const at = raw.indexOf(core);
    const insert = raw.slice(0, at) + next + raw.slice(at + core.length);
    v.dispatch({ changes: { from: sepRow.from + r[0], to: sepRow.from + r[1], insert }, userEvent: 'input.table' });
    toast({ left: '本列左对齐', center: '本列居中', right: '本列右对齐' }[align] || '已设置对齐');
    return true;
  }
  /** 读某张表某列的对齐（工具栏三连高亮用；只读，不改文档）。 */
  function alignAt(pos) {
    const v = getView();
    const cur = tableAt(pos != null ? pos : v.state.selection.main.head);
    if (!cur) return { ok: false };
    const sepRow = cur.rows.find((r) => isSep(r.text));
    if (!sepRow) return { ok: false };
    const cells = splitRow(sepRow.text);
    const line = v.state.doc.lineAt(pos != null ? pos : v.state.selection.main.head);
    const before = line.text.slice(0, (pos != null ? pos : v.state.selection.main.head) - line.from).replace(/^[ \t]*(?:>[ \t]?)+/, '');
    const col = Math.max(0, before.replace(/^\s*\|/, '').split(/(?<!\\)\|/).length - 1);
    const core = String(cells[col] || '').trim();
    const hasL = core.startsWith(':'), hasR = core.length > 1 && core.endsWith(':');
    return { ok: true, col, align: hasL && hasR ? 'center' : hasR ? 'right' : hasL ? 'left' : null };
  }

  /* 【A3 命中测试】按**几何**找到被点的 td/th。（根因更正，A3 复核实测：让「格子上右键能弹菜单」的
     决定性改动是监听从 contentDOM 换到 **document 捕获**；`posAtCoords` 在表格区域内其实**恒回到表格
     源码行**的位置，并不落表外。所以几何命中的职责是「把命令锚点精确到被点的那一格」，不是「决定弹不弹」。）
     仍然保留 posAtCoords 回退路径：表格左右 1px 外侧那 12 个点靠它才弹。 */
  function cellFromPoint(x, y) {
    let els = [];
    try { els = document.elementsFromPoint(x, y) || []; } catch { return null; }
    for (const el of els) {
      if (!el || !el.dataset) continue;
      if (el.closest && el.closest('.mp-cell-overlay')) continue;   // 覆盖层正盖在活动格上：穿透它继续往下找
      if (el.dataset.mpCol != null && el.dataset.mpRow != null) {
        return { rowFrom: Number(el.dataset.mpRow), col: Number(el.dataset.mpCol) };
      }
    }
    /* 【N3 补强·2026-10-08】表格**左右边缘 1–2px** 那几像素落在 widget 盒之外，elementsFromPoint
       命中的是表格外的节点（正文 / 横线 / 空白）⇒ 几何直接落空；旧路径只能靠下面的 posAtCoords 碰运气，
       实测**同一个坐标两枪一对一空**（右键后菜单根本不弹，「复制表格」无从谈起）。
       这里按"格子矩形 + 水平容差"补一次命中，并把容差**只放在水平方向**：纵向必须仍落在格子的
       高度带内 —— 不向上/下放宽，避免把紧贴表格上下两行的正文右键抢过来（A3 的纪律：不抢正文/工具栏/外壳）。 */
    const NEAR = 2;
    let best = null, bestDx = Infinity;
    for (const el of document.querySelectorAll('.mp-row th[data-mp-row], .mp-row td[data-mp-row]')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (y < r.top || y > r.bottom) continue;
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (dx <= NEAR && dx < bestDx) { bestDx = dx; best = el; }
    }
    if (best) return { rowFrom: Number(best.dataset.mpRow), col: Number(best.dataset.mpCol) };
    return null;
  }
  /** 把「表格源码第 rowFrom 行的第 col 格」换算成一个**文档位置**（落在该格内容里）。
   *  只按**文档文本**算：DOM 的 dataset 只用来定位是哪一格，绝不当锚点（重渲染后它会陈旧）。 */
  function anchorPosInCell(rowFrom, col) {
    const v = getView(); if (!v) return null;
    if (!Number.isFinite(rowFrom) || rowFrom < 0 || rowFrom > v.state.doc.length) return null;
    let line; try { line = v.state.doc.lineAt(rowFrom); } catch { return null; }
    if (line.from !== rowFrom) return null;                       // 陈旧：该位置已不是原来那一行的起点
    if (!Number.isFinite(col) || col < 0) return null;
    /* 【引用区表格】整段都按**剥掉前缀后**的文本算：`> | a | b |` 的 `> ` 不是格内容，
       不剥会算出"落点在格前 2 个字符"（右键菜单命令作用到错位置）。 */
    const skip = tableLead(line.text).off;
    const body = line.text.slice(skip);
    if (!/^\s*\|/.test(body)) return null;
    const parts = body.split(/(?<!\\)\|/);                      // 与渲染/切分同一口径（Q9）
    const head = body.trimStart().startsWith('|') ? 1 : 0;        // 有前导管道 ⇒ parts[0] 是格前那段
    const idx = col + head;
    if (idx < 0 || idx >= parts.length) return null;
    let off = 0;
    for (let i = 0; i < idx; i++) off += parts[i].length + 1;     // +1 = 被 split 吃掉的那根管道
    const inCell = skip + off + Math.min(Math.max(parts[idx].length, 0), 1);
    return Math.min(line.from + inCell, line.to);
  }
  /* ── 右键菜单：表格操作 ──
   * 【A3】监听挂 **document** 而不是 contentDOM：① 活动格的覆盖层挂在 body 上（在 contentDOM 之外），
   * 编辑面上的处理器收不到它上面的右键；② 命中测试按**几何**做（见 cellFromPoint）。
   * 只有真的命中表格时才 preventDefault + 出菜单；其余位置一律放行（不抢正文/工具栏/外壳的右键）。 */
  function onDocContextMenu(event) {
    const v = getView();
    if (!v) return;
    const target = event.target, source = window.mpSplit?._slave?.();
    const cell = target?.closest?.('.mp-cell-overlay-text');
    const inCell = cell?.isConnected && cell === document.querySelector('.mp-cell-overlay-text');
    if (!v.scrollDOM.contains(target) && !source?.scrollDOM.contains(target) && !inCell) return;
    menuAnchor = null;                                            // 每次右键都从干净状态开始
    const hitCell = cellFromPoint(event.clientX, event.clientY);
    if (hitCell) {
      const pos = anchorPosInCell(hitCell.rowFrom, hitCell.col);
      if (pos != null && tableAt(pos)) {
        event.preventDefault();
        menuAnchor = pos;                                         // 命令锚到**被点的那一格**
        tableMenu(event);
        return;
      }
    }
    /* 【N3】兜底分支**也要设 menuAnchor**。这条分支正是"表格左右 1px 外侧那圈点"（cellFromPoint 的
       几何命中落空）唯一能弹菜单的路径；posAtCoords 在这些点上命中的是**表格源码行内**的位置，
       所以它就是"被点的那一格"的合理解。不设锚点的后果实测：菜单照弹，点「复制表格」却走
       `v.state.selection.main.head`（不在表内）⇒ toast「光标不在表格内」、剪贴板一个字节不写。 */
    const hit = v.posAtCoords({ x: event.clientX, y: event.clientY });
    const pos = hit == null ? v.state.selection.main.head : hit;
    const cur = tableAt(pos);
    if (cur) { event.preventDefault(); menuAnchor = pos; tableMenu(event); return; }
    /* 【正文右键·2026-10-10 用户要求】命中表格走表格菜单；**其余位置给正文菜单**（照 Typora 分组）。
       改前这里直接 return ⇒ 正文右键什么都没有（用户报"正文右键功能没有做"）。
       动作全部复用工具栏那一批命令（toolbarClick），不另写第二份实现。 */
    /* 【图片右键·2026-10-10】命中图片（.mp-img / <img>）⇒ 弹图片菜单；正文才弹正文菜单。 */
    const imgHit = (() => {
      try {
        const t = event.target;
        const wrap = t && t.closest ? (t.closest(".mp-img") || (t.tagName === "IMG" ? t : null)) : null;
        if (!wrap) return null;
        const im = wrap.tagName === "IMG" ? wrap : wrap.querySelector("img");
        // The widget's document position identifies the image even when its
        // height makes coordinate hit-testing land on a neighbouring text line.
        const imagePos = v.posAtDOM(wrap, 0);
        const mark = getImageAt(imagePos);
        if (!mark) return null;
        return { src: mark.image.src || im?.getAttribute('src') || '', pos: mark.from };
      } catch { return null; }
    })();
    event.preventDefault();
    if (imgHit) { imageMenu(event, imgHit); return; }
    bodyMenu(event, pos);
  }
  document.addEventListener('contextmenu', onDocContextMenu, true);
  /* 【菜单随滚动关闭·2026-10-10 用户报"右键选单固定不动很诡异"】弹层是 position:fixed（坐标用视口系），
     页面一滚它就"钉"在原处 ⇒ 与内容脱节。Typora 的做法是**滚动即收起**，这里照做：
     任何滚动（编辑器、面板、弹层内部都算）都收起菜单；对话框（.mp-dlg）不受影响。 */
  const closePopOnScroll = (e) => {
    if (!pop) return;                                    // 【性能】没有菜单时零成本
    /* 【修正·2026-10-10】菜单**自己内部**滚动不算"页面滚动"：更多菜单是可滚动的，
       在里面滚一下就自我关闭，看起来又像"点了没反应"（实测：探针滚到底后菜单已消失）。 */
    try { if (e && e.target && pop.contains(e.target)) return; } catch { /* target 不可用 */ }
    closePop();
  };
  document.addEventListener('scroll', closePopOnScroll, true);
  /* 【菜单生命周期·2026-10-10 用户报】两条离谱现象：① 右键菜单开着时**点文档区域不消失**；
     ② **切换打开的文件后菜单还留着**（新文档上挂着一个属于旧文档的表菜单）。
     根因：菜单只挂了"滚动关闭"，没有"点外面关闭"，也没有跟文档切换联动。
     这里补齐四条出口（capture 阶段，保证在编辑器自己的 mousedown 之前跑）：
       · 在菜单外任意位置按下/点击 ⇒ 关；
       · 文档切换（壳层 doc 事件）⇒ 关；
       · 窗口失焦 / 页面隐藏 ⇒ 关。 */
  const closePopOutside = (e) => {
    if (!pop) return;                                    // 【性能】没有菜单时零成本早返回（每次按下都会走这里）
    let t = null;
    try { t = e.target; } catch { t = null; }
    try { if (t && pop.contains(t)) return; } catch { /* target 不是节点 */ }
    /* 【回归修复·2026-10-10 实测踩到】工具栏与表格条的按钮是在 **mousedown** 阶段开菜单的，
       同一次操作随后还会派发 pointer/click ⇒ 若在这里无差别关闭，菜单刚开就被关掉
       （症状：点「更多」"面板没弹出来"，而其它按钮看起来正常）。来自这两个容器的按下一律放行。 */
    try { if (t && t.closest && (t.closest('.mp-toolbar') || t.closest('.mp-table-bar'))) return; } catch { /* closest 不可用 */ }
    closePop();
  };
  document.addEventListener('mousedown', closePopOutside, true);
  document.addEventListener('pointerdown', closePopOutside, true);
  /* 不再挂 click：菜单在 mousedown 阶段已开好，click 到达时会把刚开的菜单关掉（上面那条回归就是这个）。 */
  try { if (window.mpHost && typeof window.mpHost.onDoc === 'function') window.mpHost.onDoc(() => { closePop(); if (dlgEl?.dataset.imageDialog === '1') closeDlg(); }); } catch { /* 宿主不支持 */ }
  window.addEventListener('blur', () => closePop());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') closePop(); });
  /* 【Esc 关弹层·2026-10-10 普查实测】原来 Esc 关不掉「更多」等弹层（只有点外面/滚动才关）。
     菜单开着时 Esc 优先关菜单，并且不再往下传（否则会顺手退出阅读模式）。 */
  const closePopOnEsc = (e) => {
    if (e.key !== 'Escape' && e.keyCode !== 27) return;
    const layers = [...document.querySelectorAll('.mp-pop, .mp-dlg, .cm-panel')].filter(el => el.getClientRects().length && (el === pop || el.querySelector('.mp-pop-close, .close, button[name="close"]')));
    const el = layers.sort((a,b) => (Number(getComputedStyle(a).zIndex)||0) - (Number(getComputedStyle(b).zIndex)||0)).at(-1);
    if (!el) return;
    if (!e.repeat) {
      const lifecycle = panelLifecycles.get(el);
      if (lifecycle?.recording) lifecycle.recording();
      else if (el.classList.contains('cm-panel')) el.querySelector('button[name="close"]')?.click();
      else closePanel(el, true);
    }
    try { e.preventDefault(); e.stopImmediatePropagation(); } catch { /* 忽略 */ }
  };
  document.addEventListener('keydown', closePopOnEsc, true);
  window.addEventListener('wheel', closePopOnScroll, { passive: true, capture: true });

  /** 找出 pos 所在的图片语法范围：**裸 <img …> 或 markdown ![](…)** 都可。 */
  function imageRangeAt(pos) {
    const mark = getImageAt(pos);
    return mark ? { from: mark.from, to: mark.to, attrs: mark.image } : null;
  }
  /** 生成 <img> 标签（与 2.x 的 imageHtml 同构：属性顺序 src/alt/title/align/width）。 */
  function imageTagOf(a) {
    const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    let tag = "<img src=\"" + esc(a.src) + "\"";
    if (a.alt) tag += " alt=\"" + esc(a.alt) + "\"";
    if (a.title) tag += " title=\"" + esc(a.title) + "\"";
    if (a.align && a.align !== "left") tag += " data-typora-align=\"" + a.align + "\"";
    if (a.width) tag += " width=\"" + a.width + "\"";
    if (a.height) tag += " height=\"" + a.height + "\"";
    return tag + ">";
  }
  /** 统一改写入口：拿到范围与属性 ⇒ 一次 dispatch。 */
  function rewriteImageAt(pos, mutate) {
    const r = imageRangeAt(pos);
    if (!r) { toast("没找到图片语法（请右键图片本身）"); return false; }
    const v = getView();
    const attrs = { ...r.attrs };
    if (!attrs.src) { toast("这段图片语法读不出地址"); return false; }
    mutate(attrs);
    const next = imageTagOf(attrs);
    v.dispatch({ changes: { from: r.from, to: r.to, insert: next }, userEvent: "input.format", scrollIntoView: true });
    return true;
  }
  /** 对齐：left / center / right（left 即删除属性）。 */
  function setImageAlignAt(pos, align) {
    return rewriteImageAt(pos, (a) => { a.align = align === "left" ? "" : align; });
  }
  /** Stable presets: 100% is the original image fitted to the current text area. */
  function setImageScaleAt(pos, percent) {
    const p = Number(percent);
    if (!Number.isFinite(p) || p < 5 || p > 400) { toast("请输入 5～400 的缩放百分比"); return false; }
    const r = imageRangeAt(pos);
    if (!r) { toast("没找到图片语法（请右键图片本身）"); return false; }
    const v = getView();
    let base = 0;
    try {
      const wrap = [...v.contentDOM.querySelectorAll('.mp-img')].find(w => imageRangeAt(v.posAtDOM(w, 0))?.from === r.from);
      const img = wrap?.querySelector('img'), line = wrap?.closest('.cm-line');
      if (img?.complete && img.naturalWidth > 0 && line) {
        const style = getComputedStyle(line);
        const available = line.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
        base = Math.min(img.naturalWidth, available);
      }
    } catch { base = 0; }
    if (!base) { toast("图片尚未加载完成，稍后再试"); return false; }
    const width = Math.max(1, Math.round(base * p / 100));
    return rewriteImageAt(pos, (a) => { a.width = String(width); a.height = ''; });
  }
  function imageDialog(title, bodyHtml) {
    dialog(title, bodyHtml);
    if (dlgEl) dlgEl.dataset.imageDialog = '1';
    const v = getView(), current = v ? captureImageDocument(v) : () => false;
    return () => {
      if (getView() === v && current()) return true;
      closeDlg(); toast('文档已变化，请重新打开图片菜单'); return false;
    };
  }
  /** 图片右键菜单（Typora 风格）：复制图片 / 另存为图片 / 抽出到 assets / 删除图片。
      为什么要有这一支：全仓此前**没有任何图片右键菜单**，右键图片什么都不发生（用户报"没反应"）。 */
  function imageMenu(event, imgInfo) {
    const h = host(); if (!h) return;
    const commands = window.mpEngine?.commands, menuTicket = commands?.capture();
    closePop();
    pop = document.createElement("div");
    pop.className = "mp-pop mp-pop-keep mp-pop-menu";
    const hr = h.getBoundingClientRect();
    pop.style.left = Math.max(6, event.clientX - hr.left) + "px";
    pop.style.top = Math.max(6, event.clientY - hr.top) + "px";
    const add = (label, fn, sourceEdit = false) => {
      const it = document.createElement("div"); it.className = "mp-pop-item";
      const sp = document.createElement("span"); sp.textContent = label; it.appendChild(sp);
      it.onclick = () => {
        if (sourceEdit && commands && !commands.valid(menuTicket, { intent: false })) {
          closePop(); toast('文档已变化，请重新打开图片菜单'); return;
        }
        closePop();
        try {
          const outcome = sourceEdit && commands ? commands.run(fn) : fn();
          if (sourceEdit && outcome === false) toast('输入尚未结束，请稍后重试');
          return outcome;
        } catch (e) { console.error("[mp] 图片菜单失败：", e); }
      };
      pop.appendChild(it);
    };
    const title = (t) => { const d = document.createElement("div"); d.className = "mp-pop-title"; d.textContent = t; pop.appendChild(d); };
    const sep = () => { const d = document.createElement("div"); d.className = "mp-pop-sep"; pop.appendChild(d); };
    const src = imgInfo && imgInfo.src ? imgInfo.src : "";
    const name = (() => { const mm = /^data:image\/([a-z0-9+.-]+)/i.exec(src); return "image." + (mm ? mm[1].replace("jpeg", "jpg") : "png"); })();
    title("图片");
    add("复制图片", () => {
      const hp = window.mpHost;
      if (!hp || typeof hp.writeImage !== "function") { toast("当前宿主不支持复制图片"); return; }
      Promise.resolve(hp.writeImage(src)).then((r) => toast(r && r.ok ? `已复制图片（${r.width}×${r.height}）` : "复制图片失败：" + ((r && r.error) || "未知"))).catch(() => { });
    });
    add("另存为图片…", () => {
      const hp = window.mpHost;
      if (!hp || typeof hp.saveImageAs !== "function") { toast("当前宿主不支持另存为"); return; }
      Promise.resolve(hp.saveImageAs({ src, fileName: name })).then((r) => {
        if (r && r.ok) toastExported("已保存图片", r.path);
        else if (r && !r.canceled) toast("保存失败：" + (r.error || "未知"));
      }).catch(() => { });
    });
    add("抽出到 assets", () => { try { extractImagesToAssets(); } catch (e) { console.error("[mp] 抽出图片失败：", e); } });   // 直调本地实现（普查实测：window.mpExtras.extractImagesToAssets 未导出 ⇒ 死链）
    sep();
    /* 【图片对齐/大小·2026-10-10 对标 2.x】单击即生效，写回 data-typora-align / width（与 2.x 同构）。 */
    title("对齐");
    add("左对齐", () => { setImageAlignAt(imgInfo.pos, "left"); }, true);
    add("居中", () => { setImageAlignAt(imgInfo.pos, "center"); }, true);
    add("右对齐", () => { setImageAlignAt(imgInfo.pos, "right"); }, true);
    title("大小 · 100% 适配正文");
    add("25%", () => { setImageScaleAt(imgInfo.pos, 25); }, true);
    add("50%", () => { setImageScaleAt(imgInfo.pos, 50); }, true);
    add("75%", () => { setImageScaleAt(imgInfo.pos, 75); }, true);
    add("100%", () => { setImageScaleAt(imgInfo.pos, 100); }, true);
    /* 【自定义大小·2026-10-10】命令层本来就支持任意 5～400%，这里补一个输入入口（与 2.x 的缩放对话框同义）。 */
    add("自定义…", () => {
      closePop();
      const current = imageDialog("图片大小", '<p class="k">输入 5～400 的百分比。100% 为原尺寸，超宽图片适配正文；放大后仍受正文宽度限制。</p>'
        + '<p><input id="mp-scale-in" type="number" min="5" max="400" step="5" value="100" style="width:96px"> %</p>'
        + '<p><button class="mp-key" id="mp-scale-go">应用</button></p>');
      const apply = () => {
        if (!current()) return;
        const inp = document.getElementById("mp-scale-in");
        const val = Number(inp && inp.value);
        if (setImageScaleAt(imgInfo.pos, val)) closeDlg();
      };
      const go = document.getElementById("mp-scale-go"); if (go) go.onclick = apply;
      const inp0 = document.getElementById("mp-scale-in");
      if (inp0) { inp0.onkeydown = (e) => { if (e.key === "Enter") apply(); }; inp0.focus(); inp0.select && inp0.select(); }
    });
    add('编辑图片地址…', () => {
      const current = imageRangeAt(imgInfo.pos);
      if (!current) return;
      const owner = imageDialog('图片地址', '<p><input id="mp-image-url" type="text" style="width:100%;box-sizing:border-box"></p><p><button class="mp-key" id="mp-image-url-go">应用</button></p>');
      const input = document.getElementById('mp-image-url');
      const inline = /^data:/i.test(current.attrs.src);
      input.value = inline ? '' : current.attrs.src;
      input.placeholder = inline ? '输入新的图片地址以替换内联图片' : '图片地址';
      const apply = () => { if (!owner()) return; const src = input.value.trim(); if (src && rewriteImageAt(imgInfo.pos, a => { a.src = src; })) closeDlg(); };
      document.getElementById('mp-image-url-go').onclick = apply;
      input.onkeydown = e => { if (e.key === 'Enter') apply(); };
      input.focus(); input.select();
    });
    sep();
    add("删除图片", () => {
      try {
        const v = getView(); if (!v) return;
        const at = imgInfo && imgInfo.pos != null ? imgInfo.pos : v.state.selection.main.head;
        const range = imageRangeAt(at);
        if (!range) { toast("找不到这段图片语法"); return; }
        v.dispatch({ changes: { from: range.from, to: range.to, insert: "" }, userEvent: "delete.image" });
        toast("已删除图片");
      } catch (e) { console.error("[mp] 删除图片失败：", e); }
    }, true);
    h.appendChild(pop);
  }
  /** 正文右键菜单（照 Typora 分组：编辑 / 段落 / 格式 / 插入）。 */
  function bodyMenu(event, pos) {
    const h = host(); if (!h) return;
    closePop();
    pop = document.createElement("div");
    pop.className = "mp-pop mp-pop-keep mp-pop-menu";   // 右键菜单：不带关闭键（见 tableMenu 处的说明）
    const hr = h.getBoundingClientRect();
    pop.style.left = Math.max(6, event.clientX - hr.left) + "px";
    pop.style.top = Math.max(6, event.clientY - hr.top) + "px";
    /* 【选区保真·2026-10-10】右键的 mousedown 会把光标落到点击处、**把选区收掉** ⇒
       "选中一段 → 右键 → 加粗"会作用在空选区上（实测：文档一个字节都没变）。
       Typora 的语义是"菜单命令作用于右键那一刻的选区"，所以先把那一刻的选区存下来，命令前恢复。 */
    let savedSel = null;
    try { const v0 = getView(); if (v0) savedSel = v0.state.selection; } catch { savedSel = null; }
    const commands = window.mpEngine?.commands, menuTicket = commands?.capture();
    if (menuTicket) savedSel = menuTicket.selection;
    const tb = (id) => () => {
      const v = getView();
      /* 先把选区恢复到右键那一刻（菜单点击会把光标落到别处）。 */
      try { if (v && savedSel) v.dispatch({ selection: savedSel, userEvent: 'select' }); } catch { return; }
      /* 优先用工具栏那张动作表：格式命令（加粗/斜体/…）都在这里；
         面板类命令（更多/导出/阅读…）不在表里，自然退回 toolbarClick。 */
      const act = TOOLBAR_ACTIONS && TOOLBAR_ACTIONS[id];
      if (typeof act === "function") {
        try { act(v); return; } catch (e) { console.error("[mp] 右键动作失败：", id, e); return; }
      }
      try { toolbarClick(id); } catch (e) { console.error("[mp] 右键命令失败：", id, e); }
    };
    const add = (label, fn, accel) => {
      const it = document.createElement("div");
      it.className = "mp-pop-item";
      const t = document.createElement("span"); t.textContent = label;
      it.appendChild(t);
      if (accel) { const k = document.createElement("span"); k.className = "k"; k.textContent = accel; it.appendChild(k); }
      it.onclick = () => {
        const v = getView();
        if (commands && (!commands.valid(menuTicket,{intent:false}) || !v.state.selection.eq(menuTicket.selection))) { closePop(); return; }
        closePop();
        return commands ? commands.run(fn) : fn();
      };
      pop.appendChild(it);
      return it;
    };
    const sep = () => { const d = document.createElement("div"); d.className = "mp-pop-sep"; pop.appendChild(d); };
    const title = (t) => { const d = document.createElement("div"); d.className = "mp-pop-title"; d.textContent = t; pop.appendChild(d); };
    /* 编辑 */
    /* 【普查实测·2026-10-10】原来对 DOM 选区跑 execCommand：CM6 里 DOM 选区是折叠的 ⇒ 剪贴板一字未写。
       改成读 CM 选区 → 走壳层剪贴板（与表格复制同一条 writeClip）。 */
    const selSource = selection => { try { const v = getView(); return selection.ranges.filter(r=>!r.empty).map(r=>v.state.sliceDoc(r.from,r.to)).join(v.state.lineBreak); } catch { return ""; } };
    add("剪切", async () => {
      const ticket = commands?.capture(), v = getView(), selection = ticket?.selection || v?.state.selection;
      const text = selection && selSource(selection);
      if (!text) { toast("没有选中内容"); return; }
      if (!(await writeClip({text}))) { toast("剪切失败：剪贴板不可用"); return; }
      if (!ticket || !commands.valid(ticket) || !v.state.selection.eq(selection)) { toast("选区已改变，已复制原选区，本次未剪切"); return; }
      v.dispatch({...v.state.replaceSelection(""),userEvent:'delete.cut'});
      commands.resume(ticket);
    }, "Ctrl+X");
    add("复制", async () => {
      const ticket = commands?.capture(), selection = ticket?.selection || getView()?.state.selection;
      const text = selection && selSource(selection);
      if (!text) { toast("没有选中内容"); return; }
      const ok = await writeClip({text}); toast(ok ? "已复制" : "复制失败：剪贴板不可用");
      if (ticket) commands.resume(ticket);
    }, "Ctrl+C");
    add("粘贴", () => {
    /* 【第二波·右键粘贴缺陷·2026-10-10（两族独立命中）】原来直接调 hp.paste()：菜单项在 mousedown
       那一刻就把焦点挪到了 <body>（实测 focusout → ae=BODY），主进程 webContents.paste() 随后执行时
       **没有插入目标** ⇒ 文字被静默丢弃，而它仍返回 {ok:true}（连失败提示都不给）。
       紧邻的「全选」是先 v.focus() 再动手 —— 这里照做，并把 paste 放到焦点落回编辑面之后的下一拍。 */
    const run = () => {
      const hp = window.mpHost;
      if (hp && typeof hp.paste === "function") { Promise.resolve(hp.paste()).then((r) => { if (r && r.ok === false) toast("粘贴失败：" + (r.error || "未知")); }).catch(() => { }); }
      else { try { document.execCommand("paste"); } catch { } }
    };
    try { const v = getView(); if (v) v.focus(); } catch { /* 落到直调 */ }
    run();
  }, "Ctrl+V");
    add("全选", () => { try { const v = getView(); if (v) { v.focus(); v.dispatch({ selection: { anchor: 0, head: v.state.doc.length }, userEvent: 'select' }); } } catch { } }, "Ctrl+A");
    sep();
    /* 段落（与工具栏同一批命令） */
    title("段落");
    add("标题（循环 H1→H6→正文）", tb("headings"));
    add("引用", tb("quote"));
    add("无序列表", tb("list"));
    add("有序列表", tb("ordered-list"));
    add("任务列表", tb("check"));
    sep();
    /* 格式 */
    title("格式");
    add("加粗", tb("bold"), "Ctrl+B");
    add("斜体", tb("italic"), "Ctrl+I");
    add("删除线", tb("strike"));
    add("行内代码", tb("inline-code"));
    add("链接", tb("link"), "Ctrl+K");
    sep();
    /* 插入 */
    title("插入");
    add("表格", tb("table"));
    add("代码块", tb("code"));
    add("分割线", tb("line"));
    add("图片", tb("upload"));
    h.appendChild(pop);
    /* 落点在视口外就翻边（与其它弹层同一口径） */
    const pr = pop.getBoundingClientRect();
    if (pr.bottom > hr.bottom - 4) pop.style.top = Math.max(4, (event.clientY - hr.top - (pr.bottom - hr.bottom) - 4)) + "px";
    if (pr.right > hr.right - 4) pop.style.left = Math.max(4, (event.clientX - hr.left - (pr.right - hr.right) - 4)) + "px";
    void pos;
  }
  function tableMenu(anchorEvent, tableFrom) {
    /* 【2026-10-10】tableFrom = 浮动条当前那张表的位置（⋮ 按钮传进来）：表格是 block widget，
       点它不会移动 CM 光标 ⇒ 菜单项里 tableAt(光标) 必空。有它就把它当锚点，复制项才能定位到表。 */
    if (tableFrom != null) menuAnchor = tableFrom;
    const h = host(); if (!h) return;
    pop = document.createElement('div');
    /* 【右键菜单不带关闭键·2026-10-10 用户报】菜单里的 ✕ 点了没反应（菜单的关闭语义是
       "选一项 / 点外面 / Esc / 滚动"，另塞一个 ✕ 只会误导）。标记类让关闭键守卫跳过它。 */
    pop.className = 'mp-pop mp-pop-menu';
    const hr = h.getBoundingClientRect();
    pop.style.left = Math.max(6, anchorEvent.clientX - hr.left) + 'px';
    pop.style.top = Math.max(6, anchorEvent.clientY - hr.top) + 'px';
    const add = (label, fn, k) => { const d = document.createElement('div'); d.className = 'mp-pop-item'; d.innerHTML = `<span>${label}</span>${k ? `<span class="k">${k}</span>` : ''}`; d.onclick = () => { closePop(); fn(); }; pop.appendChild(d); };
    add('上方插入行', () => tableOp('row-above'), 'Ctrl+Shift+Enter');
    add('下方插入行', () => tableOp('row-below'), 'Ctrl+Enter');
    add('左侧插入列', () => tableOp('col-left'), 'Ctrl+Alt+←');
    add('右侧插入列', () => tableOp('col-right'), 'Ctrl+Alt+→');
    const sep = document.createElement('div'); sep.className = 'mp-pop-sep'; pop.appendChild(sep);
    /* 【β1·Q19】移动与插入**并列写明**（两组键形近：Alt+方向＝移动、Ctrl+Alt+左右＝插入） */
    add('上移该行', () => tableOp('row-move-up'), 'Alt+↑');
    add('下移该行', () => tableOp('row-move-down'), 'Alt+↓');
    add('左移该列', () => tableOp('col-move-left'), 'Alt+←');
    add('右移该列', () => tableOp('col-move-right'), 'Alt+→');
    const sepM = document.createElement('div'); sepM.className = 'mp-pop-sep'; pop.appendChild(sepM);
    add('删除本行', () => tableOp('row-delete'), 'Ctrl+Shift+Backspace');
    add('删除本列', () => tableOp('col-delete'), 'Ctrl+Alt+Delete');
    const sep2 = document.createElement('div'); sep2.className = 'mp-pop-sep'; pop.appendChild(sep2);
    add('复制表格（可粘 Excel）', () => copyTable());
    /* 【B-1·③ 折中】markdown 源码出口从 Ctrl+C 让给了 TSV/HTML（整表选区），但"要源码"的场合仍在
       —— 显式命令挂在**同一个**表格菜单里（不新造交互），紧跟「复制表格」；不含表的选区行为不变。 */
    add('复制为 Markdown 源码', () => copyTableSource());
    add('删除表格', () => tableOp('table-delete'));
    h.appendChild(pop);
    const away = (e) => { if (pop && !pop.contains(e.target)) { menuAnchor = null; closePop(); document.removeEventListener('mousedown', away, true); } };
    setTimeout(() => document.addEventListener('mousedown', away, true), 0);
  }
  /* 【N1/B-1 同源·唯一实现】"表格的格行" ⇒ 剪贴板载荷（TSV + `<table>` HTML）。
     三个出口**必须**都调这里（PLAN-3.1.0 §4 的 ③ 口径），否则又会分裂成
     "菜单粘出来是表、Ctrl+C 粘出来是源码"：
       · 右键菜单「复制表格（可粘 Excel）」  → copyTable()
       · 格里 Ctrl+C（覆盖层无 DOM 选区）   → main.js 覆盖层的 copy 处理器（N1）
       · 文档里选中整表 Ctrl+C              → main.js 的 docSourceClipboard（B-1）
     入参 rowCells ＝ 按行按列的**格源码**（`\|` 的还原只在这里做一次）；aligns ＝ 每列对齐词。 */
  function tableClipPayload(rowCells, aligns) {
    // 【A4b】与导出同口径：剪贴板里的 `a\|b` 还原成 `a|b`（Excel/Word 里看到的应是字面竖线）
    const rows = (rowCells || []).map((r) => (r || []).map((c) => String(c == null ? '' : c).replace(/\\\|/g, '|')));
    /* 【软换行口径统一·2026-10-08】TSV（纯文本出口）里 `<br>` 还原成**真换行**：
       Excel/Word 的格内换行就是这个语义；留着字面 `<br>` 会让人以为粘贴坏了。 */
    const tsv = rows.map((r) => r.map((c) => c.replace(/<br\s*\/?>/gi, '\n')).join('\t')).join('\n');
    /* 【β2·L5】格内容必须转义（旧写法把 `<`/`&` 原样塞进 HTML 串）；顺带按列写对齐。
       【软换行口径统一·2026-10-08】换成 `inlineMd`（＝导出件**同一个**行内渲染器）：
       路径不同源是这条 bug 的根源——导出走 inlineMd、复制走这里的裸 esc，
       于是同一个 `<br>` 在导出件里是断行、在复制里是字面 `&lt;br&gt;`。
       现在两处同一个函数、同一套 `<br>` 白名单（按段处理，且不会漏进 KaTeX）。 */
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cellHtml = (c) => { try { return inlineMd(String(c), null, false); } catch { return esc(c); } };
    const al = Array.isArray(aligns) ? aligns : [];
    /* 【charset·2026-10-09】带上 <meta charset="utf-8">：Excel / pandas 这类消费端在没有声明时
       会按本地代码页猜编码，中文列名会变乱码（实测：同一份 HTML，pandas 猜成 latin-1 ⇒ "姓名"变"å§å"）。
       TSV 那一路不带声明，Excel 也照本地代码页解 —— 但 TSV 是纯文本路径，用户可在导入向导里选编码；
       HTML 这一路能自带声明，就带上。 */
    const html = '<meta charset="utf-8"><table>' + rows.map((r, i) => '<tr>' + r.map((c, k) => {
      const tag = i === 0 ? 'th' : 'td';
      const a = al[k];
      const sty = a === 'center' ? ' style="text-align:center"' : a === 'right' ? ' style="text-align:right"' : '';
      return `<${tag}${sty}>${cellHtml(c)}</${tag}>`;
    }).join('') + '</tr>').join('') + '</table>';
    return { tsv, html, rows: rows.length, cols: rows.length ? rows[0].length : 0 };
  }
  /** tableAt() 的结果 ⇒ tableClipPayload 的两个入参（分隔行**不进**载荷，与旧口径一致）。 */
  function tableClipArgs(cur) {
    const rowCells = cur.rows.filter((r) => !isSep(r.text)).map((r) => splitRow(r.text));
    const sepRow = cur.rows.find((r) => isSep(r.text));
    const aligns = !sepRow ? [] : splitRow(sepRow.text).map((cell) => {
      const c = String(cell || '').trim();
      const hasL = c.startsWith(':'), hasR = c.length > 1 && c.endsWith(':');
      return hasL && hasR ? 'center' : hasR ? 'right' : hasL ? 'left' : null;
    });
    return { rowCells, aligns };
  }
  async function copyTable() {
    const v = getView();
    /* 【A4e】锚点与 tableOp 同一套优先级：右键菜单记下的**被点的格** > CM 选区。
       改前这里写死读选区 ⇒ 光标在表外时「右键格子 → 复制表格」**完全静默**（无载荷、无提示；
       A3 复核实测：ClipboardItem 构造 0 次、toast=null、剪贴板不变）。失败时也补一句提示。 */
    const pos = menuAnchor != null ? menuAnchor : v.state.selection.main.head;
    menuAnchor = null;
    const cur = tableAt(pos);
    if (!cur) { toast('光标不在表格内'); return; }
    const args = tableClipArgs(cur);
    const { tsv, html } = tableClipPayload(args.rowCells, args.aligns);
    if (await writeClip({ text: tsv, html })) toast('已复制表格（Excel/Word 可直接粘成表格）');
    else toast('复制表格失败：剪贴板不可用');
  }
  /** 【B-1 配套】显式命令：整表按**文档源码**（markdown）写剪贴板 —— ③ 折中里给"要源码"的场合留的出口。
   *  锚点优先级与 copyTable/tableOp 同一套（被点的格 > CM 选区），失败也给提示，不静默。 */
  async function copyTableSource() {
    const v = getView();
    const pos = menuAnchor != null ? menuAnchor : v.state.selection.main.head;
    menuAnchor = null;
    const cur = tableAt(pos);
    if (!cur) { toast('光标不在表格内'); return false; }
    const text = cur.rows.map((r) => r.text).join('\n');
    if (await writeClip({ text })) { toast('已复制表格源码（Markdown）'); return true; }
    toast('复制失败'); return false;
  }

  /* ── 关于 / 帮助 ── */
  /* ── 界面透明度：逐项独立，**不捆绑** ────────────────────────────────────
   * 架构：**一个消费者一组 token**，设置面板由注册表驱动 ⇒ 以后要多调一个组件，只往 SURFACES
   * 里加一条，面板与持久化自动跟上；结构上不存在"一个总透明度"的捆绑。
   * 能效：写进去的只是 CSS 变量（底色/模糊全部由 var() 消费），滑杆只在拖动时写一次，
   * 没有每键开销、也没有新增任何文档扫描。 */
  const SURFACES = [
    { key: 'float', name: '公式预渲染框', hint: '光标进公式时浮出的预览框', items: [
      { id: 'alpha', k: '--mp-float-alpha', label: '不透明度', def: 65, min: 0, max: 100, fmt: (v) => v + '%' },
      { id: 'blur', k: '--mp-float-blur', label: '背景模糊', def: 7, min: 0, max: 24, fmt: (v) => v + 'px' },
    ] },
    { key: 'outline', name: '大纲面板', hint: '浮层与侧边停靠共用同一组参数', items: [
      { id: 'alpha', k: '--mp-outline-alpha', label: '不透明度', def: 78, min: 20, max: 100, fmt: (v) => v + '%' },
      /* 【表格浮动条·2026-10-09】用户要求透明度可调；与工具岛/大纲各自独立。 */
      { id: 'tbalpha', k: '--mp-table-bar-alpha', label: '表格浮动条不透明度', def: 88, min: 20, max: 100, fmt: (v) => v + '%' },
      /* 【右键菜单透明度·2026-10-10】与其它表面各自独立；默认 100%（菜单要看清）。 */
      { id: 'ctxalpha', k: '--mp-context-menu-alpha', label: '右键菜单不透明度', def: 100, min: 20, max: 100, fmt: (v) => v + '%' },
      { id: 'blur', k: '--mp-outline-blur', label: '背景模糊', def: 10, min: 0, max: 24, fmt: (v) => v + 'px' },
    ] },
    { key: 'toolbar', name: '工具岛', hint: '顶部悬浮工具栏（含折叠后的小圆岛）', items: [
      { id: 'alpha', k: '--mp-surface-alpha', label: '不透明度', def: 76, min: 20, max: 100, fmt: (v) => (v / 100).toFixed(2) },
      { id: 'blur', k: '--mp-surface-blur', label: '背景模糊', def: 10, min: 0, max: 30, fmt: (v) => v + 'px' },
    ] },
  ];
  const surfaceStore = () => { try { return JSON.parse(localStorage.getItem('mp-surfaces') || '{}') || {}; } catch { return {}; } };
  const surfaceSaved = (key, id, def) => { const st = surfaceStore(); const v = st && st[key] ? st[key][id] : undefined; return Number.isFinite(v) ? v : def; };
  /** 把保存过的表面参数写回 :root（启动时调一次；以后加项自动覆盖）。 */
  function applySurfaces() {
    const root = document.documentElement;
    for (const s of SURFACES) for (const it of s.items) {
      /* 【读取侧钳制·2026-10-10（third-run FS-1 后半）】只防"新的越界写入"不够：已经落在
         localStorage 里的越界值（如 blur=62，它的合法区间是 0–24）会**跨重启一直在**，
         面板还会呈现"滑杆顶格、标签写 62px"的自相矛盾态（普查 FIX-B3/B4 两条红）。
         这里读取时按各 item 的 min/max 夹一次，并把夹过的值回写 ⇒ 脏值自愈（一次即可）。 */
      const raw = surfaceSaved(s.key, it.id, it.def);
      const lo = Number.isFinite(it.min) ? it.min : 0;
      const hi = Number.isFinite(it.max) ? it.max : 100;
      const n = Number(raw);
      const v = Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : it.def;
      root.style.setProperty(it.k, it.fmt(v));
      if (v !== n) {
        try {
          const st2 = surfaceStore();
          st2[s.key] = st2[s.key] || {};
          st2[s.key][it.id] = v;
          localStorage.setItem('mp-surfaces', JSON.stringify(st2));
        } catch { /* 忽略 */ }
      }
    }
  }
  /* ── 版式：页面宽度 / 内容缩放 / 工具岛尺寸 / 状态栏 ────────────────────────────────
   *  读写都走引擎同一条通道 `window.mpEngine.setPref / prefs`（单一真源＝引擎的 localStorage
   *  键 `mp-pref-*`）：这样面板滑杆、状态栏数字口、Ctrl+= 快捷键改的是**同一个值**，
   *  不会出现"面板显示 120% 而实际 100%"的第三个写者。引擎未就位时退回默认值（面板仍可用）。 */
  const LAYOUT_ITEMS = [
    { id: 'pageWidth', label: '页面宽度', min: 40, max: 100, step: 1, fmt: (v) => v + '%', hint: '正文栏占窗口宽度的百分比（居中留白；工具栏与状态栏不受影响）' },
    { id: 'zoom', label: '内容缩放', min: 50, max: 300, step: 5, fmt: (v) => v + '%', hint: '只缩放正文（字号/行高/公式/表格）；Ctrl+= / Ctrl+- / Ctrl+0 也是它' },
    { id: 'island', label: '工具岛尺寸', min: 80, max: 140, step: 5, fmt: (v) => v + '%', hint: '顶部工具栏岛的大小，与内容缩放完全独立' },
  ];
  const prefsRead = () => (window.mpEngine && window.mpEngine.prefs ? window.mpEngine.prefs() : { pageWidth: 74, zoom: 100, island: 100, statusbar: 1 });
  const prefWrite = (id, v) => { if (window.mpEngine && window.mpEngine.setPref) window.mpEngine.setPref(id, v); };
  // 中置编辑区方案已撤回（外壳未给 main 面板渲染槽位的能力）⇒ 清掉可能残留的模式键。
  try { localStorage.removeItem('mp-panel-mode'); } catch { /* 忽略 */ }
  function settingsDialog() {
    const rows = SURFACES.map((s) => {
      const body = s.items.map((it) => {
        const cur = surfaceSaved(s.key, it.id, it.def);
        return `<tr><td style="white-space:nowrap">${it.label}</td><td style="width:100%">`
          + `<input class="mp-rng" type="range" data-s="${s.key}" data-i="${it.id}" min="${it.min}" max="${it.max}" value="${cur}" `
          + `style="width:190px;vertical-align:middle;accent-color:var(--mp-primary)">`
          + `<span class="mp-num" data-n="${s.key}-${it.id}" style="margin-left:8px;color:var(--mp-muted);font:12px var(--mp-font-mono)">${it.fmt(cur)}</span>`
          + `</td></tr>`;
      }).join('');
      const avoidance = s.key === 'float' ? `<tr><td>正文避让</td><td><label style="cursor:pointer"><input id="mp-pref-float-avoidance" type="checkbox"${prefsRead().floatAvoidance !== 0 ? ' checked' : ''} style="accent-color:var(--mp-primary)"> 就近避让正文</label><div class="k">关闭后，预览直接显示在公式源码下方。</div></td></tr>` : '';
      return `<p class="k" style="margin:12px 0 4px"><b style="color:var(--mp-fg)">${s.name}</b> · ${s.hint}</p><table>${body}${avoidance}</table>`;
    }).join('');
    const outlineSec = `<p class="k" style="margin:12px 0 4px"><b style="color:var(--mp-fg)">大纲</b> · 展示形式（两种并存，随时可换）</p>`
      + `<table><tr><td style="white-space:nowrap">样式</td><td>`
      + [['float', '浮层（挂左上角）'], ['left', '靠左停靠'], ['right', '靠右停靠']].map(([v, label]) =>
        `<label style="margin-right:14px;cursor:pointer;white-space:nowrap"><input type="radio" name="mp-outline-mode" value="${v}"${outlineMode() === v ? ' checked' : ''} style="accent-color:var(--mp-primary)"> ${label}</label>`).join('')
      + `</td></tr></table>`;
    /* 【版式】页面宽度 / 内容缩放 / 工具岛尺寸 / 状态栏：与透明度面板同一套 registry 驱动写法 */
    const pv = prefsRead();
    const layoutSec = `<p class="k" style="margin:12px 0 4px"><b style="color:var(--mp-fg)">版式</b> · 页面宽度、内容缩放、工具岛尺寸各自独立</p>`
      + `<table>${LAYOUT_ITEMS.map((it) => `<tr><td style="white-space:nowrap">${it.label}</td><td style="width:100%">`
        + `<input class="mp-rng" type="range" data-p="${it.id}" min="${it.min}" max="${it.max}" step="${it.step}" value="${pv[it.id]}" `
        + `style="width:190px;vertical-align:middle;accent-color:var(--mp-primary)">`
        + `<span class="mp-num" data-pn="${it.id}" style="margin-left:8px;color:var(--mp-muted);font:12px var(--mp-font-mono)">${it.fmt(pv[it.id])}</span>`
        + `<div class="k" style="margin-top:2px">${it.hint}</div></td></tr>`).join('')}`
      + `<tr><td style="white-space:nowrap">底部状态栏</td><td><label style="cursor:pointer"><input type="checkbox" id="mp-pref-statusbar"${pv.statusbar ? ' checked' : ''} style="accent-color:var(--mp-primary)"> 显示（右下角可直接输入缩放百分比，回车生效）</label></td></tr>`
      /* 【task-17】图片策略：插图和粘贴位图都按它决定"落盘 assets 还是内联 data URI"。
         文档头部写了 mp-image-mode 时以文档为准（偏好只是没写时的默认）。
         【2026-10-09】默认翻成 assets（依据见本文件 imageModePref 上方注释）；inline 保留为显式选项，
         文案里明说它的代价（平台不渲染 + 单行超长）。 */
      + `<tr><td style="white-space:nowrap">图片策略</td><td>`
      + [['assets', '落盘 assets/ + 相对路径（推荐）'], ['inline', '内联 data URI（换目录仍显示，但 GitHub/GitLab 不渲染、那行会很长）']].map(([v, label]) =>
        `<label style="margin-right:14px;cursor:pointer;white-space:nowrap"><input type="radio" name="mp-image-pref" value="${v}"${imageModePref() === v ? ' checked' : ''} style="accent-color:var(--mp-primary)"> ${label}</label>`).join('')
      + `<div class="k" style="margin-top:2px">「图片」按钮插入与粘贴位图都按这里；文档头部写了 mp-image-mode 时以文档为准。「更多 → 抽出到 assets」可把已经内联进文档的图一次性落盘。</div></td></tr>`
      /* 【排版美化·2026-10-09】功能名统一叫「排版美化」：阅读模式下的段落断行方式。
         默认「浏览器两端对齐」；选 Knuth–Plass 才做整段最优断行（只在阅读模式 + 小文档生效）。 */
      + `<tr><td style="white-space:nowrap">排版美化</td><td>`
      + [['css', '浏览器两端对齐（默认）'], ['kp', 'Knuth–Plass 整段最优断行（仅阅读模式 + 小文档）']].map(([v, label]) =>
        `<label style="margin-right:14px;cursor:pointer;white-space:nowrap"><input type="radio" name="mp-typo-pref" value="${v}"${typographyMode() === v ? ' checked' : ''} style="accent-color:var(--mp-primary)"> ${label}</label>`).join('')
      + `<div class="k" style="margin-top:2px">阅读模式下可按 <b>Ctrl+Alt+K</b> 或点右上角「排版美化」按钮一键切换；超过 30 万字符的文档自动保持两端对齐（不做整段重排）。测量与排版都跟随你的字体/字号设置，自定义 CSS 改字号后断行会重算。</div></td></tr>`
      /* 【Typora 社区主题·2026-10-09】用户可以直接装 Typora 的主题 CSS（改写与桥接见上方实现段）。 */
      /* 【启动打开上次的文件·2026-10-10 用户要求】设置项在壳层（settings.json 的 restoreLast），
         渲染侧经白名单通道读写；勾选状态异步取回后回填。 */
      + `<tr><td style="white-space:nowrap">启动</td><td>`
      + `<label style="cursor:pointer"><input type="checkbox" id="mp-restore-last"> 打开上次的文件</label>`
      + `<div class="k" style="margin-top:2px">打开应用时自动接着上次的文件；关掉则每次开空白文档。上次的文件若已被移走，则自动往后找最近一个仍在的。</div></td></tr>`
      + `<tr><td style="white-space:nowrap">保存</td><td>`
      + `<label style="cursor:pointer"><input type="checkbox" id="mp-autosave" disabled> 自动保存</label>`
      + `<label style="margin-left:14px">间隔 <input id="mp-autosave-seconds" type="number" min="1" max="3600" step="1" value="30" disabled style="width:72px"> 秒</label>`
      + `<div class="k" style="margin-top:2px">默认手动保存，按 Ctrl+S 写入文件。开启后按间隔保存有修改的文件；未命名文档需先另存为。</div></td></tr>`
      + `<tr><td style="white-space:nowrap">Typora 主题</td><td>`
      + `<button class="mp-key" id="mp-theme-install">安装 .css…</button>`
      + `<span class="k" style="margin-left:8px">当前：<b id="mp-theme-name">${userThemeName() || '未安装'}</b>${userThemeCss() ? `（${Math.round(userThemeCss().length / 1024)} KB）` : ''}</span>`
      + `<button class="mp-key" id="mp-theme-remove" style="margin-left:10px"${userThemeCss() ? '' : ' disabled'}>移除</button>`
      + `<div class="k" style="margin-top:2px">选一个 Typora 主题的 <b>.css</b>（默认打开 Typora 的主题目录）：正文与界面配色一起换，重启后仍在。主题里自带的字体/图片文件不会跟着走（CSS 里的相对引用会被忽略，避免整页报错）。</div></td></tr>`
      + `</table>`;
    dialog('设置', layoutSec + outlineSec + rows
      + `<p class="k" style="margin-top:12px">每一项独立调整、互不影响，改完立即生效并被记住。</p>`
      + `<p style="margin-top:10px"><button class="mp-key" data-act="reset">恢复默认</button>`
      + `<button class="mp-key" data-act="keys" style="margin-left:8px">快捷键设置…</button></p>`);
    const d = dlgEl; if (!d) return;
    {
      const hp = window.mpHost, enabled = d.querySelector('#mp-autosave'), seconds = d.querySelector('#mp-autosave-seconds');
      let current = { enabled: false, seconds: 30 }, busy = false;
      const show = () => { enabled.checked = current.enabled; seconds.value = current.seconds; enabled.disabled = busy; seconds.disabled = busy || !current.enabled; };
      const changed = event => { current = { enabled: event.detail.enabled, seconds: Math.round(event.detail.intervalMs / 1000) }; show(); };
      window.addEventListener('mp:save-policy', changed);
      panelLifecycles.get(d).cleanup.add(() => window.removeEventListener('mp:save-policy', changed));
      const read = async () => {
        const [a,b] = await Promise.all([hp.settingGet('autosaveEnabled'), hp.settingGet('autosaveIntervalMs')]);
        current = { enabled: a?.value === true, seconds: Math.round(Number(b?.value || 30000)/1000) }; show();
      };
      const write = async (key, value) => {
        busy = true; show();
        try { const r = await hp.settingSet(key, value); if (!r?.ok) throw new Error(r?.error || '未知错误'); await read(); }
        catch (error) { toast('保存设置失败：' + error.message); }
        finally { busy = false; show(); }
      };
      if (hp?.settingGet && hp?.settingSet) {
        void read().catch(error => toast('读取保存设置失败：' + error.message));
        enabled.onchange = () => { const value = enabled.checked; void write('autosaveEnabled', value); };
        seconds.onchange = () => { const value = Number(seconds.value); if (!Number.isInteger(value) || value < 1 || value > 3600) { show(); toast('保存间隔需为 1～3600 秒的整数'); return; } void write('autosaveIntervalMs', value * 1000); };
      }
    }
    /* 【双向同步·2026-10-06】面板订阅引擎的偏好广播：**别处**改了值（`Ctrl+=/-/0`、Ctrl+滚轮、
       状态栏数字口、菜单里的不透明度滑杆）时，把这里的滑杆与数字刷新到同一个值。
       改前是单向的——面板读一次初始值就再也不更新，"面板数字不动"会让用户以为滑杆是假的。 */
    const refreshFromPrefs = (snap) => {
      const s = snap || prefsRead();
      for (const it of LAYOUT_ITEMS) {
        const el = d.querySelector(`input.mp-rng[data-p="${it.id}"]`);
        const n = d.querySelector(`[data-pn="${it.id}"]`);
        if (el && document.activeElement !== el) el.value = String(s[it.id]);
        if (n) n.textContent = it.fmt(s[it.id]);
      }
      const sbx = d.querySelector('#mp-pref-statusbar');
      if (sbx) sbx.checked = !!s.statusbar;
      const avoidance = d.querySelector('#mp-pref-float-avoidance');
      if (avoidance) avoidance.checked = s.floatAvoidance !== 0;
    };
    try {
      if (unsubPrefs) { unsubPrefs(); unsubPrefs = null; }
      unsubPrefs = window.mpPrefs && window.mpPrefs.subscribe ? window.mpPrefs.subscribe((snap) => refreshFromPrefs(snap)) : null;
      const subscription = unsubPrefs;
      if (subscription) panelLifecycles.get(d).cleanup.add(() => { subscription(); if (unsubPrefs === subscription) unsubPrefs = null; });
    } catch { /* 没有订阅口就退化为单向 */ }
    d.querySelectorAll('input.mp-rng[data-p]').forEach((el) => {
      el.oninput = () => {
        const v = Number(el.value);
        prefWrite(el.dataset.p, v);
        const n = d.querySelector(`[data-pn="${el.dataset.p}"]`);
        const it = LAYOUT_ITEMS.find((x) => x.id === el.dataset.p);
        if (n && it) n.textContent = it.fmt(v);
      };
    });
    const sb = d.querySelector('#mp-pref-statusbar');
    if (sb) sb.onchange = () => prefWrite('statusbar', sb.checked ? 1 : 0);
    const avoidance = d.querySelector('#mp-pref-float-avoidance');
    if (avoidance) avoidance.onchange = () => prefWrite('floatAvoidance', avoidance.checked ? 1 : 0);
    d.querySelectorAll('input[name="mp-outline-mode"]').forEach((el) => {
      el.onchange = () => { try { localStorage.setItem('mp-outline-mode', el.value); } catch { } applyOutlineMode(); };
    });
    /* 【task-17】图片策略偏好：只写偏好（文档级覆盖仍由 front-matter 决定），写完给一次可见回执 */
    d.querySelectorAll('input[name="mp-image-pref"]').forEach((el) => {
      el.onchange = () => {
        setImageModePref(el.value);
        toast('图片策略已改为：' + (el.value === 'assets' ? '落盘 assets/（相对路径）' : '内联（data URI）'));
      };
    });
    /* 【排版美化】设置面板里的两个单选：与右上角按钮、Ctrl+Alt+K 走**同一个** toggleTypography，
       保证三处语义一致（含"切到 kp 就顺带进阅读模式"与"大文档提示"）。 */
    d.querySelectorAll('input[name="mp-typo-pref"]').forEach((el) => {
      el.onchange = () => toggleTypography(el.value);
    });
    /* 【Typora 社区主题】安装/移除按钮：装完重开一次设置面板，让"当前"与字节数即时刷新。 */
    {
      const bi = d.querySelector('#mp-theme-install');
      if (bi) bi.onclick = async () => { await installTyporaTheme(); closeDlg(); settingsDialog(); };
      /* 「打开上次的文件」：先把壳层里的当前值取回来回填，再在改动时写回。 */
      const rl = d.querySelector('#mp-restore-last');
      if (rl) {
        const hp = window.mpHost;
        if (hp && typeof hp.settingGet === 'function') { Promise.resolve(hp.settingGet('restoreLast')).then((r) => { rl.checked = !(r && r.value === false); }).catch(() => { rl.checked = true; }); }
        else rl.checked = true;
        rl.onchange = () => {
          const hp2 = window.mpHost;
          if (!hp2 || typeof hp2.settingSet !== 'function') { toast('当前宿主不支持修改该设置'); return; }
          Promise.resolve(hp2.settingSet('restoreLast', !!rl.checked)).then((r) => { if (r && r.ok === false) toast('保存设置失败：' + (r.error || '未知')); }).catch(() => { });
        };
      }
      const br = d.querySelector('#mp-theme-remove');
      if (br) br.onclick = () => { removeTyporaTheme(); closeDlg(); settingsDialog(); };
    }
    /* 【只挑表面滑杆·2026-10-06 修「假滑杆」】选择器必须是 `input.mp-rng[data-s]`：
       本文件早先写的是 `querySelectorAll('input.mp-rng')`——在只有表面参数滑杆的年代无害，
       但「版式」那三根滑杆（data-p，没有 data-s）用的是同一个 class ⇒ 被这一行**整体接管**：
       `el.oninput` 被覆盖成表面参数的处理函数，而它读 `el.dataset.s` 得到 undefined、
       `SURFACES.find(...)` 找不到 ⇒ **第一句就 return**（静默）。
       现象＝用户报的"页面宽度/内容缩放/工具岛尺寸拖了没反应，数字也不动"（3.0.5 装机实测复现）。
       归属判据用**属性**而不是顺序：有 data-s 归表面参数，有 data-p 归版式，两者互不越界。 */
    d.querySelectorAll('input.mp-rng[data-s]').forEach((el) => {
      el.oninput = () => {
        const s = SURFACES.find((x) => x.key === el.dataset.s), it = s && s.items.find((x) => x.id === el.dataset.i);
        if (!it) return;
        const v = Number(el.value);
        const st = surfaceStore(); st[s.key] = st[s.key] || {}; st[s.key][it.id] = v;
        try { localStorage.setItem('mp-surfaces', JSON.stringify(st)); } catch { }
        document.documentElement.style.setProperty(it.k, it.fmt(v));
        const n = d.querySelector(`[data-n="${s.key}-${it.id}"]`); if (n) n.textContent = it.fmt(v);
      };
    });
    const rst = d.querySelector('[data-act="reset"]');
    if (rst) rst.onclick = () => {
      try { localStorage.removeItem('mp-surfaces'); } catch { }
      // 版式四项一并回默认（否则"恢复默认"只恢复一半，用户会以为没生效）
      try { for (const k of ['pageWidth', 'zoom', 'island', 'statusbar', 'floatAvoidance']) localStorage.removeItem('mp-pref-' + k); } catch { }
      if (window.mpEngine && window.mpEngine.applyPrefs) window.mpEngine.applyPrefs();
      applySurfaces(); settingsDialog();
    };
    const ko = d.querySelector('[data-act="keys"]');
    if (ko) ko.onclick = () => { closeDlg(); shortcutDialog(); };
  }

  // 启动即把保存过的表面参数写回 :root。**必须放在 SURFACES / surfaceStore 这些 const 之后**：
  // 函数声明会提升，但它引用的 const 在暂时性死区里，调用早了就是 "Cannot access 'x' before initialization"。
  applySurfaces();
  applyOutlineMode();   // 大纲展示形式（浮层/左停靠/右停靠）启动即按保存值应用

  /* ── Typora 社区主题（用户自带 CSS）·2026-10-09 ──────────────────────────────
     用户在设置里选一个 Typora 主题 .css，当场改写并注入，重启后仍在。
     四条设计要点：
      · 改写复用 2.x 线的纯函数（见文件头 import 注释），本文件不另写一份；
      · 主题的 `:root` 变量被改写到 `:root[data-mp-user-theme]` 作用域 ⇒ 关掉主题只要摘属性，页面不留残迹；
      · **变量桥接**：Typora 的 `--bg-color/--text-color/--code-bg-color/…` 映射到引擎自己的 `--mp-*`，
        这样工具栏/面板/状态栏跟着一起变（只改正文不叫"装了主题"）；
      · 选区色用 color-mix 补透明度：Typora 的 `--select-text-bg-color` 常常是不透明实色，
        直接拿来当选区会把字盖住。 */
  const UT_CSS_KEY = "mp-user-theme-css";
  const UT_NAME_KEY = "mp-user-theme-name";
  const UT_SCOPE = ":root[data-mp-user-theme]";
  const UT_BRIDGE = "\n" + UT_SCOPE + " {\n"
    + "  --mp-bg: var(--bg-color, var(--mp-bg));\n"
    + "  --mp-fg: var(--text-color, var(--mp-fg));\n"
    + "  --mp-heading: var(--text-color, var(--mp-heading));\n"
    + "  --mp-muted: var(--text-muted, var(--mp-muted));\n"
    + "  --mp-faint: var(--text-faint, var(--mp-faint));\n"
    + "  --mp-primary: var(--primary-color, var(--mp-primary));\n"
    + "  --mp-border: var(--border-color, var(--mp-border));\n"
    + "  --mp-codeBg: var(--code-bg-color, var(--mp-codeBg));\n"
    + "  --mp-capsule: var(--code-bg-color, var(--mp-capsule));\n"
    + "  --mp-quoteBg: var(--quote-bg-color, var(--mp-quoteBg));\n"
    + "  --mp-quoteBar: var(--primary-color, var(--mp-quoteBar));\n"
    + "  --mp-sel: color-mix(in srgb, var(--select-text-bg-color, var(--primary-color)) 26%, transparent);\n"
    + "}\n";
  let lastThemeReport = null;
  const UT_VARS_KEY = "mp-user-theme-vars";
  /** Typora 变量 → 引擎 token 的映射（桥接与内联覆盖共用同一张表，避免两处口径漂移） */
  const UT_VAR_MAP = {
    "--bg-color": "--mp-bg",
    "--text-color": "--mp-fg",
    "--text-muted": "--mp-muted",
    "--text-faint": "--mp-faint",
    "--primary-color": "--mp-primary",
    "--border-color": "--mp-border",
    "--code-bg-color": "--mp-codeBg",
    "--quote-bg-color": "--mp-quoteBg",
  };
  const UT_INLINE_SET = new Set();      // 我们写过的内联 token（移除时要清干净）
  /** 从主题 CSS 里解析变量：**全文扫、首个声明胜出**。
      为什么不只认 `:root`：实测 konayuki dark 把 `--bg-color` 写在 `:root` 之外的选择器下，
      只读 `:root` 会漏掉背景色（现象：装完字色变了、底色没变）。 */
  function extractThemeVars(css) {
    const out = {};
    const re = /(--[a-z0-9-]+)\s*:\s*([^;{}]+);/gi;
    let m;
    while ((m = re.exec(String(css)))) {
      const k = m[1].trim(), v = m[2].trim();
      if (v && !(k in out)) out[k] = v;
    }
    return out;
  }
  /* 【版式守卫·2026-10-09 实测踩到】Typora 主题是给 Typora 的**富块结构**写的（`#write` 上写着
     padding:60px 20px 120px、max-width:90ch、margin:0 auto；正文是 `<p>`、行内是 `<strong>`）；
     我们的编辑器是**逐行**结构（一个源码行一个 `.cm-line`，行内标记是行内 span）。
     直接套用会跟引擎抢版式：实测一段正文被拆成三行、行距被拉到 200px（有截图）。
     所以：**主题只负责外观**（颜色/底色/字体/字重/字形/圆角/边框/阴影），
     版面（display/position/宽高/内外边距/浮动/溢出/层叠/网格）一律归引擎 —— 这些声明在这里剥掉。 */
  const UT_LAYOUT_DECL = /^(display|position|float|clear|overflow|overflow-x|overflow-y|padding|padding-top|padding-right|padding-bottom|padding-left|margin|margin-top|margin-right|margin-bottom|margin-left|width|max-width|min-width|height|max-height|min-height|box-sizing|inset|top|right|bottom|left|z-index|transform|grid|grid-template-columns|grid-template-rows|flex|flex-basis|flex-direction|flex-wrap|align-items|justify-content|columns|column-count|column-gap)$/i;
  /* 【元素映射·2026-10-09】Typora 主题的选择器对着 Typora 的 DOM 写，我们的结构不同：
     · 标题：Typora 是 `<h1>` 元素，我们是**行类** `.cm-line.mp-h1`（所以主题的 h1 规则原本一条都不生效）；
     · 引用：Typora 是 `<blockquote>`，我们是 `.cm-line.mp-quote`；
     · 代码块：Typora 是 `.md-fences`，我们是 `.mp-code`。
     只做**整词**替换（不碰属性值与注释内容），映射表集中在这里，便于以后加。 */
  const UT_SELECTOR_MAP = [
    [/\bh([1-6])\b/g, '.cm-line.mp-h$1'],
    [/\bblockquote\b/g, '.cm-line.mp-quote'],
    [/\.md-fences\b/g, '.mp-code'],
  ];
  const mapSelectors = (sel) => {
    let out = sel;
    for (const [re, to] of UT_SELECTOR_MAP) out = out.replace(re, to);
    return out;
  };
  function sanitizeThemeCss(css) {
    let stripped = 0, mapped = 0;
    const out = String(css).replace(/([^{}]+)\{([^{}]*)\}/g, (whole, sel, body) => {
      if (/^\s*@/.test(sel)) return whole;                       // @media/@font-face 等外壳不动
      const kept = body.split(";").map((d) => d.trim()).filter(Boolean).filter((d) => {
        const i = d.indexOf(":");
        if (i < 0) return true;
        if (UT_LAYOUT_DECL.test(d.slice(0, i).trim())) { stripped++; return false; }
        return true;
      });
      if (!kept.length) return "";
      const sel2 = mapSelectors(sel);
      if (sel2 !== sel) mapped++;
      return sel2 + "{" + kept.join(";") + "}\n";
    });
    return { css: out, stripped, mapped };
  }
  /** 把主题变量以内联方式写进 documentElement（优先级压过引擎调色板的内联值） */  function applyThemeVarsInline(vars) {
    const el = document.documentElement;
    for (const k of [...UT_INLINE_SET]) { try { el.style.removeProperty(k); } catch { } UT_INLINE_SET.delete(k); }
    for (const [tk, mk] of Object.entries(UT_VAR_MAP)) {
      const v = vars && vars[tk];
      if (!v) continue;
      try { el.style.setProperty(mk, v); UT_INLINE_SET.add(mk); } catch { }
    }
    const selBg = (vars && (vars["--select-text-bg-color"] || vars["--primary-color"])) || "";
    if (selBg) { try { el.style.setProperty("--mp-sel", `color-mix(in srgb, ${selBg} 26%, transparent)`); UT_INLINE_SET.add("--mp-sel"); } catch { } }
  }
  function clearThemeVarsInline() {
    const el = document.documentElement;
    for (const k of [...UT_INLINE_SET]) { try { el.style.removeProperty(k); } catch { } }
    UT_INLINE_SET.clear();
  }
  const userThemeName = () => { try { return localStorage.getItem(UT_NAME_KEY) || ""; } catch { return ""; } };
  const userThemeCss = () => { try { return localStorage.getItem(UT_CSS_KEY) || ""; } catch { return ""; } };
  /** 应用（或摘掉）用户主题样式；返回是否处于"已装"状态 */
  function applyUserTheme() {
    const css = userThemeCss();
    let el = document.getElementById("mp-user-theme");
    if (!css) {
      if (el) el.remove();
      clearThemeVarsInline();
      try { delete document.documentElement.dataset.mpUserTheme; } catch { }
      return false;
    }
    if (!el) { el = document.createElement("style"); el.id = "mp-user-theme"; document.head.appendChild(el); }
    el.textContent = css + UT_BRIDGE;
    document.documentElement.dataset.mpUserTheme = "1";
    let vars = {};
    try { vars = JSON.parse(localStorage.getItem(UT_VARS_KEY) || "{}"); } catch { vars = {}; }
    applyThemeVarsInline(vars);
    return true;
  }
  /** 安装核心（对话框与探针都走这一条，保证两条路同源） */
  function installTyporaThemeFromText(text, name) {
    const res = adaptTyporaTheme(String(text || ""), { scope: UT_SCOPE, surface: ".cm-content" });
    if (!res || !res.css || !res.css.trim()) return { ok: false, error: "改写后没有可用规则（确认选的是 Typora 主题 .css）" };
    /* 【变量内联覆盖·2026-10-09 实测踩到】引擎的调色板把 --mp-* 写在 documentElement 的**内联样式**上，
       内联优先级高于任何样式表规则 ⇒ 光靠 UT_BRIDGE 那条 `:root[data-mp-user-theme]{--mp-bg:var(--bg-color)}`
       **改不动颜色**（实测装完 bg 还是引擎自己的 #1f2126）。所以安装时把主题的 :root 变量解析出来，
       以**内联**写回 documentElement（同为内联、后写者胜）；移除时清掉这些内联项并重新应用当前调色板。 */
    const vars = extractThemeVars(String(text || ""));
    const guarded = sanitizeThemeCss(res.css);          // 版式守卫：剥掉抢版面的声明（见上）
    const finalCss = guarded.css;
    try {
      localStorage.setItem(UT_CSS_KEY, finalCss);
      localStorage.setItem(UT_NAME_KEY, String(name || "自定义主题"));
      localStorage.setItem(UT_VARS_KEY, JSON.stringify(vars));
    } catch { return { ok: false, error: "主题太大，浏览器存储放不下" }; }
    applyUserTheme();
    lastThemeReport = res.report || null;
    return { ok: true, name: String(name || "自定义主题"), bytes: finalCss.length, report: res.report || null, vars: Object.keys(vars).length, stripped: guarded.stripped };
  }
  async function installTyporaTheme() {
    const h = window.mpHost;
    if (!h || typeof h.pickThemeCss !== "function") { toast("当前宿主不支持选择主题文件"); return { ok: false }; }
    let r = null;
    try { r = await h.pickThemeCss(); }
    catch (e) { toast("选择主题文件失败：" + String((e && e.message) || e)); return { ok: false }; }
    if (!r || !r.ok) { if (r && !r.canceled) toast("读取主题失败：" + (r.error || "未知错误")); return r || { ok: false }; }
    const res = installTyporaThemeFromText(r.text, r.name);
    if (!res.ok) { toast("安装主题失败：" + res.error); return res; }
    const rep = res.report || {};
    toast(`已装上 Typora 主题「${res.name}」：${rep.rules || 0} 条规则生效`
      + (rep.fontFacesDropped ? `（${rep.fontFacesDropped} 个主题自带字体未随 CSS 导入）` : "")
      + (rep.urlsNeutralized ? `，已忽略 ${rep.urlsNeutralized} 处图片/字体引用` : ""));
    return res;
  }
  function removeTyporaTheme() {
    const had = userThemeName();
    try { localStorage.removeItem(UT_CSS_KEY); localStorage.removeItem(UT_NAME_KEY); localStorage.removeItem(UT_VARS_KEY); } catch { }
    applyUserTheme();
    /* 清掉内联覆盖后，把当前调色板重新应用一次（否则引擎的 --mp-* 内联值已被我们删掉，界面会失去配色）。 */
    try {
      const cur = (() => { try { return localStorage.getItem("editor-theme") || "telari-dark"; } catch { return "telari-dark"; } })();
      applyPalette(cur);
    } catch { }
    if (had) toast(`已移除主题「${had}」`);
    return { ok: true, removed: had || null };
  }
  const userThemeInfo = () => ({ name: userThemeName(), bytes: userThemeCss().length, report: lastThemeReport });
  applyUserTheme();      // 启动即恢复上次装的主题

  /* ── 面板关闭键：全应用单点保证（2026-10-09 用户要求）─────────────────────────
     要求原话是"全应用的这种面板都可关闭常驻，大纲除外"。为什么不在每个构造点各加一个：
     面板容器不止两条路——`openPop()` 造 `.mp-pop`、`dialog()` 造 `.mp-dlg`，**表格菜单/主题配色等
     还有自己造 `.mp-pop` 的地方**；逐个补必然漏（本轮就是这么漏掉的）。
     所以改成**观察者兜底**：DOM 里一出现面板容器，若没有关闭键就补一个 sticky ✕。
     这样"以后新加的面板"也自动有——规则写在机制里，不写在记忆里。
     两处例外（用户明确排除/已有出口）：大纲浮层 `.mp-outline` 与大纲停靠 `.mp-outline-dock`。 */
  (function installPanelCloseGuard() {
    if (typeof MutationObserver !== "function") return;
    const PANELS = ".mp-pop, .mp-dlg";
    const ensure = (el) => {
      try {
        if (!el || el.nodeType !== 1) return;
        if (el.classList.contains("mp-outline") || el.classList.contains("mp-outline-dock")) return;   // 大纲除外
        /* 【右键菜单不带关闭键·2026-10-10】菜单不补 ✕；已经补过的（旧版本注入的）顺手摘掉。 */
        if (el.classList.contains("mp-pop-menu")) { const old = el.querySelector(".mp-pop-close"); if (old) old.remove(); return; }
        armPanel(el);
        if (el.querySelector(".mp-pop-close, .close")) return;                                          // 已有（dialog 自带）
        const isDlg = el.classList.contains("mp-dlg");
        const x = document.createElement("span");
        x.className = isDlg ? "close" : "mp-pop-close";
        x.textContent = "✕";
        x.title = "关闭（Esc）";
        x.onclick = (e) => { e.stopPropagation(); closePanel(el, true); };
        el.insertBefore(x, el.firstChild);
      } catch { /* 补不上也不影响面板本身 */ }
    };
    const scan = (root) => {
      if (!root || root.nodeType !== 1) return;
      if (root.matches && root.matches(PANELS)) ensure(root);
      if (root.querySelectorAll) root.querySelectorAll(PANELS).forEach(ensure);
    };
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) scan(n);
    }).observe(document.body, { childList: true, subtree: true });
  })();

  /* ── 阅读模式（骨架）────────────────────────────────────────────────────
   * 定位：**同一份文档的第三种外壳**（编辑面 / 阅读面），只改呈现，不动数据与交互契约。
   *  · 去编辑感：藏工具栏岛与 H 徽标、隐光标、行距加宽、版心收窄；
   *  · 出去的路：右上角一颗退出胶囊 ＋ Esc（工具栏藏了，不能没有出口）；
   *  · 配色两档：默认「跟随主题」（只改版式），另给「米色纸张 / 柔和淡绿」专用阅读配色
   *    （色值取自 2.3.3 的 reading-palette.css，按本引擎 17 个 token 补齐）；
   *  · 专用配色用**行内 token 覆盖**（与主题同一机制），退出时用 mpTheme.apply 还原，不会残留。
   *  · KP（Knuth-Plass 断行）是**第二步**：骨架先把版式与出口立住，再上算法。 */
  const READING_PALETTES = [
    { id: 'theme', name: '跟随主题', desc: '只改版式（更宽行距、更窄版心），配色不变' },
    { id: 'beige', name: '米色纸张', desc: '暖白纸感，长时间阅读不刺眼', vars: {
      '--mp-bg': '#f4efdf', '--mp-fg': '#3e392f', '--mp-heading': '#2f2b22', '--mp-muted': '#68604e',
      '--mp-faint': '#8a8170', '--mp-border': '#c3b8a0', '--mp-primary': '#285c70', '--mp-codeBg': '#e9e2d1',
      '--mp-capsule': '#e9e2d1', '--mp-quoteBg': '#efe9d8', '--mp-quoteBar': '#c3b8a0', '--mp-sel': 'rgba(40,92,112,0.22)' } },
    { id: 'green', name: '柔和淡绿', desc: '低饱和绿底，护眼', vars: {
      '--mp-bg': '#e5eee2', '--mp-fg': '#2e4032', '--mp-heading': '#243026', '--mp-muted': '#516655',
      '--mp-faint': '#7c8f7e', '--mp-border': '#a7bca4', '--mp-primary': '#245c68', '--mp-codeBg': '#d5e2d2',
      '--mp-capsule': '#d5e2d2', '--mp-quoteBg': '#dde8da', '--mp-quoteBar': '#a7bca4', '--mp-sel': 'rgba(36,92,104,0.22)' } },
  ];
  const readingOn = () => { try { return localStorage.getItem('mp-reading') === '1'; } catch { return false; } };
  const readingPalette = () => { try { return localStorage.getItem('mp-reading-palette') || 'theme'; } catch { return 'theme'; } };
  /* 【排版美化·2026-10-09】段落断行方式：css（浏览器两端对齐，默认） / kp（Knuth–Plass 整段最优）。
     只在**阅读模式**下生效，且只对**小文档**（引擎侧 KP_MAX_CHARS = 30 万字符）生效 —— 三条闸门见
     main.js 的 kpTypesetPlugin 文件头（不在键入路径上 / 只接管纯文本段 / 尊重用户 CSS）。 */
  const TYPO_KEY = 'mp-typography';
  const typographyMode = () => { try { return localStorage.getItem(TYPO_KEY) === 'kp' ? 'kp' : 'css'; } catch { return 'css'; } };
  const TYPO_NAME = { css: '浏览器两端对齐', kp: 'Knuth–Plass 整段最优' };
  function applyTypography() {
    // 通知引擎重建断行（引擎侧只监听这一个事件，不轮询）
    try { document.dispatchEvent(new CustomEvent('mp-typography-changed')); } catch { }
    const btn = document.querySelector('.mp-typography-btn');
    if (btn) {
      const m = typographyMode();
      /* 【文案简化·2026-10-09 用户要求】按钮上只留「已美化 / 未美化」两个词，细节进 title（悬停可看）。 */
      btn.innerHTML = m === 'kp' ? '<b>已美化</b>' : '未美化';
      btn.title = m === 'kp'
        ? '当前：Knuth–Plass 整段最优断行（仅在阅读模式 + 小文档生效）。点击切回浏览器两端对齐'
        : '当前：浏览器两端对齐。点击切到 Knuth–Plass 整段最优断行（仅在阅读模式 + 小文档生效）';
    }
  }
  /** 切换排版美化方式；`enterReading` = 切到 kp 时若不在阅读模式就一并进入（否则看不到效果）。 */
  function toggleTypography(force) {
    const next = typeof force === 'string' ? (force === 'kp' ? 'kp' : 'css') : (typographyMode() === 'kp' ? 'css' : 'kp');
    try { localStorage.setItem(TYPO_KEY, next); } catch { }
    if (next === 'kp' && !readingOn()) { toggleReading(true); }
    applyTypography();
    if (next === 'kp') {
      const big = (() => { try { const v = window.mpEngine && window.mpEngine._view(); return v ? v.state.doc.length > 300000 : false; } catch { return false; } })();
      toast(big
        ? '排版美化：已选 Knuth–Plass，但本文档超过 30 万字符 ⇒ 仍用浏览器两端对齐（大文档不做整段重排）'
        : '排版美化：Knuth–Plass 整段最优断行（再按 Ctrl+Alt+K 或点右上角按钮切回两端对齐）');
    } else {
      toast('排版美化：浏览器两端对齐');
    }
  }
  function applyReading() {
    const on = readingOn();
    document.documentElement.dataset.mpReading = on ? '1' : '';
    const pal = READING_PALETTES.find((p) => p.id === readingPalette()) || READING_PALETTES[0];
    // 【判据踩过的坑】必须**先判阅读态**：否则退出时会把专用配色又写回去（实测 --mp-bg 停在 #f4efdf 不还原）。
    if (on && pal.vars) for (const [k, v] of Object.entries(pal.vars)) document.documentElement.style.setProperty(k, v);
    else if (window.mpTheme) { const cur = window.mpTheme.current(); if (cur) window.mpTheme.apply(cur); }   // 其余一律还原主题配色
    const pill = document.querySelector('.mp-reading-exit');
    /* 【文案简化·2026-10-09】退出按钮只留两个词（配色名进 title，不挤在按钮上）。 */
    if (pill) pill.textContent = on ? '退出 Esc' : '';
    if (pill) pill.title = on ? `退出阅读模式（当前配色：${pal.name}）` : '';
    if (on) applyTypography();
  }
  function toggleReading(force) {
    const next = typeof force === 'boolean' ? force : !readingOn();
    try { localStorage.setItem('mp-reading', next ? '1' : '0'); } catch { }
    applyReading();
    if (next) toast('已进入阅读模式：Esc 或右上角胶囊退出');
    else toast('已退出阅读模式');
  }
  function readingPaletteDialog() {
    const cur = readingPalette();
    dialog('阅读模式', `<p class="k">版式（行距/版心）与配色分开：配色默认跟随主题，也可以单独选一套阅读配色。</p>`
      + `<table>${READING_PALETTES.map((p) => `<tr><td style="white-space:nowrap"><button class="mp-key" data-rp="${p.id}"${p.id === cur ? ' style="outline:1px solid var(--mp-primary)"' : ''}>${p.name}</button></td><td class="k">${p.desc}${p.id === cur ? '（当前）' : ''}</td></tr>`).join('')}</table>`
      + `<p style="margin-top:10px"><button class="mp-key" data-act="toggle">${readingOn() ? '退出阅读模式' : '进入阅读模式'}</button></p>`);
    const d = dlgEl; if (!d) return;
    d.querySelectorAll('[data-rp]').forEach((el) => {
      el.onclick = () => {
        try { localStorage.setItem('mp-reading-palette', el.dataset.rp); } catch { }
        if (!readingOn()) toggleReading(true); else applyReading();
        closeDlg(); readingPaletteDialog();
      };
    });
    const tg = d.querySelector('[data-act="toggle"]');
    if (tg) tg.onclick = () => { toggleReading(); closeDlg(); };
  }
  // 退出胶囊：工具栏在阅读态是藏起来的，所以必须留一条看得见的出口
  (function installReadingPill() {
    /* 【排版美化·2026-10-09】右上角改成**一簇**：上＝排版美化开关，下＝退出阅读模式。
       位置在视口右上角、正文列之外（"不挡阅读位置"）；容器 pointer-events:none，
       只有按钮自己可点，簇里的空隙不挡正文点击。 */
    const cluster = document.createElement('div');
    cluster.className = 'mp-read-cluster';
    const typoBtn = document.createElement('div');
    typoBtn.className = 'mp-typography-btn';
    typoBtn.onclick = () => toggleTypography();
    cluster.appendChild(typoBtn);
    const pill = document.createElement('div');
    pill.className = 'mp-reading-exit';
    pill.onclick = () => toggleReading(false);
    cluster.appendChild(pill);
    document.body.appendChild(cluster);
    applyTypography();
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && readingOn()) { toggleReading(false); e.preventDefault(); }
    }, true);
    applyReading();
  })();

  function dialog(title, bodyHtml, onClose = null) {
    const h = host(); if (!h) return;
    closeDlg();
    dlgEl = document.createElement('div');
    dlgEl.className = 'mp-dlg';
    armPanel(dlgEl, onClose);
    dlgEl.innerHTML = `<span class="close">✕</span><h3>${title}</h3>${bodyHtml}`;
    const panel = dlgEl;
    dlgEl.querySelector('.close').onclick = () => closePanel(panel, true);
    h.appendChild(dlgEl);
  }
  async function about() {
    let info = { name: 'MarkPilot', version: '', platform: navigator.platform };   // 版本一律以 mpHost.info() 为准；兜底留空，不显示错版本
    try { if (window.mpHost && window.mpHost.info) info = await window.mpHost.info(); } catch { }
    const nav = navigator.userAgent.replace(/^Mozilla\/5\.0 /, '');
    dialog('关于 MarkPilot', `
      <p><b>MarkPilot</b> ${info.version || ''}</p>
      <p class="k">Typora 手感的即时渲染 Markdown 编辑器：公式点开即改、复制出去就是 Markdown 源码、中文输入法安全。</p>
      <p class="k">运行时：${nav.slice(0, 120)}</p>
      <p class="k">内核：CodeMirror 6 + KaTeX　·　渲染与源码同面，不切预览。</p>`);
  }
  async function help() {
    const cfg = keyConfig();
    const rows = Object.entries(cfg).map(([a, c]) => `<tr><td>${({ bold: '加粗', italic: '斜体', underline: '下划线', strike: '删除线', code: '行内代码', quote: '引用', list: '无序列表', save: '保存', outline: '大纲', export: '导出 HTML' })[a] || a}</td><td><span class="mp-key">${c.replace('Mod', 'Ctrl')}</span></td></tr>`).join('');
    dialog('帮助 · 快捷键', `
      <p class="k">快捷键可在「更多 → 快捷键设置」里点键位直接改。</p>
      <table>${rows}</table>
      <p class="k" style="margin-top:10px">表格：在表格内右键可插入/移动/删除行列、复制表格到 Excel。键位 —— Enter（下移一格，末行补行）、Shift+Enter（格内换行）、Tab / Shift+Tab（逐格前后，跨行）、Ctrl+E（选格）、Ctrl+A（格→行→列→整表→全篇）、Ctrl+Enter（下插行）、Ctrl+Shift+Enter（上插行）、Alt+↑/↓（上移/下移该行）、Alt+←/→（左移/右移该列，**移动**）、Ctrl+Alt+←/→（插列，**新增**）、Ctrl+Shift+Backspace（删行）、Ctrl+Alt+Delete（删列）。</p>
      <p class="k">公式：光标进公式会展开源码并浮出预渲染预览；点渲染体任意位置可精确落位。行中段直接打 $$…$$，收笔会自动独占一行。</p>
      <p class="k">复制：选中含公式/表格的内容，剪贴板里是标准 Markdown 源码，粘到 Typora/Obsidian/GitHub 都能正常渲染。</p>`);
  }
  function shortcutDialog() {
    const cfg = keyConfig();
    const names = { bold: '加粗', italic: '斜体', underline: '下划线', strike: '删除线', code: '行内代码', quote: '引用', list: '无序列表', save: '保存文件', outline: '大纲面板', export: '导出 HTML' };
    dialog('快捷键设置', `<p class="k">点右侧键位后按下新组合键（Esc 取消，退格恢复默认）。</p><table id="mp-keys">` +
      Object.entries(cfg).map(([a, c]) => `<tr><td>${names[a] || a}</td><td><span class="mp-key" data-a="${a}">${showCombo(c)}</span></td></tr>`).join('') + '</table>');
    const lifecycle = panelLifecycles.get(dlgEl);
    dlgEl.querySelectorAll('.mp-key').forEach((el) => {
      el.onclick = () => {
        lifecycle.recording?.();
        el.classList.add('editing'); el.textContent = '按下组合键…';
        const finish = () => {
          el.classList.remove('editing'); el.textContent = showCombo(keyConfig()[el.dataset.a]);
          document.removeEventListener('keydown', onKey, true);
          lifecycle.cleanup.delete(finish); lifecycle.recording = null;
        };
        const onKey = (e) => {
          e.preventDefault(); e.stopPropagation();
          if (e.key === 'Escape') { finish(); return; }
          /* 【普查实测·2026-10-10】改前：任何 keydown 都当场落定 ⇒ 真实按 Ctrl+Shift+Y 时，
             第一个事件是 Control，于是组合被记成单键 'Mod'（后续按键再没人接）。
             现在：**纯修饰键不落定**，继续等真正的那个键（此时修饰位仍按着，comboOf 能拿到完整组合）。 */
          const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'OS', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn']);
          if (MODIFIER_KEYS.has(e.key)) {
            const shown = e.key === 'Control' ? 'Ctrl' : (e.key === 'Meta' ? 'Win' : e.key);
            el.textContent = '按下组合键…（已按 ' + shown + '，请继续按主键）';
            return;                                    // 不摘监听、不落定
          }
          if (e.key === 'Backspace') { setKey(el.dataset.a, DEFAULT_KEYS[el.dataset.a]); el.textContent = showCombo(DEFAULT_KEYS[el.dataset.a]); }
          else { const combo = comboOf(e); setKey(el.dataset.a, combo); el.textContent = showCombo(combo); }
          finish();
        };
        lifecycle.cleanup.add(finish); lifecycle.recording = finish;
        document.addEventListener('keydown', onKey, true);
      };
    });
  }

  /* ── 表格快捷键（与 v2.3.3 的教训对齐：绝不用 Ctrl+= / Ctrl+-，那两条让给缩放） ──
   * 【A1 上下文分派】不在表格里一律 `return false`，**让给默认键位**（表外 Ctrl+Enter 仍是"插空行"），
   * 也不再弹"光标不在表格内"那句提示 —— 否则表外每次按都挨一句。
   * 【A1 优先级】用 `Prec.high`：`basicSetup` 的默认键位（`Mod-Enter`=insertBlankLine、
   * `Mod-[`=indentLess…）本来排在前面，**同优先级先到先得**，不提优先级我们的绑定永远轮不到
   * （真机实测：表里 Ctrl+Enter 插的是空行，把表劈成两张）。 */
  const inTableNow = () => {
    try { const v = getView(); return !!(v && tableAt(v.state.selection.main.head)); } catch { return false; }
  };
  const tableKey = (op) => () => (inTableNow() ? tableOp(op) : false);
  /* 【β1】表内**无条件消费**版：守卫拒绝（表头行不能移动 / 已经是第一行）时也必须吃掉这个键 ——
     否则同键的下一条命令（默认键位 moveLineUp/moveLineDown/cursorSyntaxLeft）会接手，
     用户看到的是"提示说不能移动，表格却被改了"。 */
  const moveKey = (op) => () => { if (!inTableNow()) return false; tableOp(op); return true; };
  /* 【字素簇退格·2026-10-10（第三波 weird-chars 族）】CM6 默认退格/Delete 按**码点**删 ⇒
     `e`+U+0301（组合重音）只删掉重音、`👍🏽`（emoji+肤色修饰）只删掉肤色、ZWJ 家庭表情被拆开
     ⇒ 删完留下"半个字形"（族实测：退格后仍有非空可见字形）。这里用 Intl.Segmenter 的 **grapheme**
     粒度把整个字素簇一次删掉。只在"光标贴着簇边界且簇长 > 1 码点"时接管，其余一律 return false
     ⇒ 默认语义（含行首合并行、行尾、有选区）**逐字节不变**。
     成本：只看**光标所在行**的文本（字素簇不跨行）⇒ 与文档总长无关，巨行也不额外扫描。 */
  const mpGraphemeSeg = (() => { try { return new Intl.Segmenter(undefined, { granularity: 'grapheme' }); } catch { return null; } })();
  const mpClusterFrom = (lineText, rel) => {
    if (!mpGraphemeSeg || rel <= 0) return null;
    let start = rel - 1;
    for (const s of mpGraphemeSeg.segment(lineText.slice(0, rel))) start = s.index;
    return start < rel ? start : null;
  };
  const mpClusterTo = (lineText, rel) => {
    if (!mpGraphemeSeg || rel >= lineText.length) return null;
    for (const s of mpGraphemeSeg.segment(lineText.slice(rel))) if (s.index === 0) return rel + s.segment.length;
    return null;
  };
  const mpDelCluster = (dir) => (v) => {
    try {
      const sel = v.state.selection.main;
      if (!sel.empty) return false;                          // 有选区：默认语义
      const line = v.state.doc.lineAt(sel.head);
      const rel = sel.head - line.from;
      if (dir < 0) {
        if (rel <= 0) return false;                          // 行首：交给默认（合并上一行）
        const s = mpClusterFrom(line.text, rel);
        if (s == null || rel - s <= 1) return false;         // 只有一个码点：交给默认
        v.dispatch({ changes: { from: line.from + s, to: sel.head }, selection: { anchor: line.from + s } });
        return true;
      }
      if (rel >= line.text.length) return false;             // 行尾：交给默认
      const e = mpClusterTo(line.text, rel);
      if (e == null || e - rel <= 1) return false;
      v.dispatch({ changes: { from: sel.head, to: line.from + e }, selection: { anchor: sel.head } });
      return true;
    } catch { return false; }
  };
  const tableKeys = deps.Prec.high(deps.keymap.of([
    { key: 'Backspace', run: mpDelCluster(-1) },
    { key: 'Delete', run: mpDelCluster(1) },
    /* 【β1】表内 Ctrl+A＝选择递进、Ctrl+E＝选格（Typora 口径）；表外一律 return false ⇒
       原生 selectAll / 用户可改的"行内代码"（DEFAULT_KEYS.code = 'Mod-e'）继续生效，逐字节不变。
       与用户改键是**两个** compartment（本表在 extras 的 Prec.high 层，rebindKeys 改的是 keyCompartment），
       所以用户把 code 改到别的键不会牵动这里；表内固定占 Ctrl+E 是已登记的已知限制。 */
    { key: 'Mod-a', run: () => !!(deps.tableSelect && deps.tableSelect.cycle()) },
    { key: 'Mod-e', run: () => !!(deps.tableSelect && deps.tableSelect.selectCell()) },
    /* 【β1·移动行列】Alt+方向＝移动（Typora 口径），与下面的 Ctrl+Alt+左右（插列）**并存**（Q19）。
       表外一律 return false ⇒ Alt+↑/↓ 仍是 moveLineUp/Down、Alt+←/→ 仍是按语法单元移动，逐字节不变。
       ⚠️ 表内**必须无条件消费掉**（moveKey 而不是 tableKey）：守卫拒绝时若 return false，
       同一个 run 数组里的下一条命令会接手（Alt+↑ ⇒ moveLineUp 交换两条源码行 ⇒ 表头被移出表格）。
       "拒绝 + toast" 的语义是"这一次按键什么都不做"，不是"把键让给别人"。 */
    { key: 'Alt-ArrowUp', run: moveKey('row-move-up') },
    /* 【排版美化·2026-10-09】一键切换段落断行方式（浏览器两端对齐 ⇄ Knuth–Plass 整段最优）。
       不在表内语义里，无条件消费掉这次按键（preventDefault 由 CM6 keymap 默认行为处理）。 */
    { key: 'Mod-Alt-k', run: () => { toggleTypography(); return true; } },
    { key: 'Alt-ArrowDown', run: moveKey('row-move-down') },
    { key: 'Alt-ArrowLeft', run: moveKey('col-move-left') },
    { key: 'Alt-ArrowRight', run: moveKey('col-move-right') },
    { key: 'Mod-Enter', run: tableKey('row-below') },
    { key: 'Mod-Shift-Enter', run: tableKey('row-above') },
    { key: 'Mod-Alt-ArrowLeft', run: tableKey('col-left') },
    { key: 'Mod-Alt-ArrowRight', run: tableKey('col-right') },
    { key: 'Mod-Shift-Backspace', run: tableKey('row-delete') },
    { key: 'Mod-Alt-Delete', run: tableKey('col-delete') },
  ]));

  /* ── 工具栏按钮路由（toolbar.js 里所有点击先过这里；返回 true 表示已处理） ── */
  function toolbarClick(id, anchor) {
    return window.mpEngine.commands.run(() => toolbarCommand(id,anchor), { focus: 'control' });
  }
  function toolbarCommand(id, anchor) {
    switch (id) {
      case 'outline': toggleOutline(anchor); return true;
      case 'emoji': openEmoji(anchor); return true;
      case 'theme-settings': openTheme(anchor); return true;
      case 'more': openMore(anchor); return true;
      case 'split': {
        // 双开（形态 B）：主视图＝渲染编辑面，从视图＝同一份文档的只读源码。实例由 boot() 挂到 window.mpSplit。
        const s = window.mpSplit;
        if (!s) return true;
        s.toggle();
        if (anchor && anchor.classList) anchor.classList.toggle('is-active', s.isOpen());
        return true;
      }
      case 'document-export': exportDialog(); return true;
      case 'surface-settings': settingsDialog(); return true;
      case 'reading-mode': toggleReading(); return true;
      case 'reading-palette': readingPaletteDialog(); return true;
      case 'fullscreen': {
        // 桌面版：壳层切全屏；插件（iframe 未授权 allowfullscreen）如实说明，不假装成功。
        const h = window.mpHost;
        if (h && typeof h.toggleFullscreen === 'function') {
          h.toggleFullscreen().then((r) => { if (r && r.ok) toast(r.fullscreen ? '已进入全屏（再点退出）' : '已退出全屏'); else toast('全屏切换失败：' + ((r && r.error) || '未知错误')); }).catch(() => { });
        } else toast('全屏需要桌面版（当前宿主是 iframe，未授权 allowfullscreen）');
        return true;
      }
      case 'shortcut-settings': shortcutDialog(); return true;
      /* 【task-3·C2】图片按钮只有一种语义：弹原生文件选择器（低频的"从浏览器打开"在「更多」里）。
         ⚠️ 这里必须**同步 return true**：toolbarClick 一旦改成 async，两个调用点的
         `if (window.mpExtras.toolbarClick(…)) return;` 会拿到 Promise（恒真）⇒ 提前 return
         ⇒ 纯 ACTIONS 类按钮（粗体/斜体…）的兜底 `ACTIONS[item.id](view)` **永不执行** ⇒ 整条工具栏废掉。
         所以异步活在本分支内 detach，同步把 true 交回去。 */
      case 'upload': {
        pickAndInsertImages().catch((e) => toast('插入图片失败：' + ((e && e.message) || e)));
        return true;
      }
      default: return false;
    }
  }
  function openTheme(anchor) {
    openPop(anchor, (p) => {
      const t = document.createElement('div'); t.className = 'mp-pop-title'; t.textContent = '主题配色'; p.appendChild(t);
      for (const pal of PALETTES) {
        const d = document.createElement('div'); d.className = 'mp-pop-item';
        d.innerHTML = `<span>${pal.name}</span><span class="k">${pal.dark ? '深' : '浅'}${currentPalette === pal.id ? ' · 当前' : ''}</span>`;
        d.onclick = () => { applyPalette(pal.id); closePop(); };
        p.appendChild(d);
      }
    });
  }
  function openEmoji(anchor) {
    openPop(anchor, (p) => {
      const t = document.createElement('div'); t.className = 'mp-pop-title'; t.textContent = '常用表情'; p.appendChild(t);
      const g = document.createElement('div'); g.className = 'mp-emoji-grid';
      for (const e of EMOJI) { const b = document.createElement('button'); b.textContent = e; b.onclick = () => { insertText(e); closePop(); }; g.appendChild(b); }
      p.appendChild(g);
    });
  }
  function openMore(anchor) {
    openPop(anchor, (p) => {
      p.classList.add('mp-pop-keep');   // 阅读态里也允许显示（阅读配色住在菜单里）
      const add = (label, fn, k) => { const d = document.createElement('div'); d.className = 'mp-pop-item'; d.innerHTML = `<span>${label}</span>${k ? `<span class="k">${k}</span>` : ''}`; d.onclick = () => { closePop(); fn(); }; p.appendChild(d); };
      const sep = () => { const s = document.createElement('div'); s.className = 'mp-pop-sep'; p.appendChild(s); return s; };
      const t = document.createElement('div'); t.className = 'mp-pop-title'; t.textContent = '更多'; p.appendChild(t);
      /* 【入口收敛】格式不在这里各占一行：点「导出…」拉起**格式选择框**（先选格式 → 再选位置）。
         工具栏上已有平行按钮的（双开/主题配色/表情符号/导出/快捷键设置）不在菜单里重复。
         【2026-10-08 收编】「界面透明度」与「阅读模式」两件事从工具栏独立按钮**移到这里内联**：
         用户要求工具栏只留高频动作，低频的调参进菜单；内联＝不用再开二级面板，
         滑杆/数字口/三档配色都在菜单里直接给，且都显示**当前值**。 */
      add('导出…', exportDialog, 'PDF / HTML / 文件夹 / 复制');
      add('设置', settingsDialog, '');
      /* 【快捷键设置的直达入口·2026-10-10 用户反馈"自定义快捷键找不到了"】改前只有一条路：
         更多 → 设置 → 面板底部的「快捷键设置…」。工具栏上原来那个 ⌨ 图标在 2026-10-08
         随"低频动作收进更多菜单"一起撤掉了 ⇒ 用户从界面上再也看不到"能改键"这件事。
         这里补一个**同名直达项**（设置面板里那颗按钮保留，两条路都能到，同一份实现）。 */
      add('快捷键设置…', shortcutDialog, '点键位直接改');
      /* 【2026-10-09 收编】两件事从工具栏槽位收进这里：
         · 「重新加载」原来是置灰的 is-todo 死按钮（toolbar.js 的 NOT_YET），这次**连上行一起接上**了
           （壳侧 file:reload：重读磁盘、不 pushRecent、脏文档先确认且默认取消）；
         · 「从浏览器打开」= 图片的另一种**取回方式**（主进程代取），与「图片」按钮共用同一条插入路径
           ⇒ 全应用不再需要任何"选文件还是从浏览器"的二选一对话框。 */
      add('重新加载', reloadDoc, '从磁盘重读当前文件');
      add('从浏览器打开…', openImageFromUrl, '按网址取图');
      /* 【task-17】图片的两条批量命令（对整篇生效，各一次撤销；外链一律不动） */
      add('内联全部图片', inlineAllImages, '本地路径 → data URI');
      add('抽出到 assets', extractImagesToAssets, 'data URI → assets/ 相对路径');
      p.appendChild(sep());

      /* ── 界面透明度（内联；与「设置 → 界面透明度」同一组 token / 同一份存储）── */
      const tt = document.createElement('div'); tt.className = 'mp-pop-title'; tt.textContent = '界面透明度'; p.appendChild(tt);
      const firstOf = (s) => s.items[0];
      const curOf = (s) => surfaceSaved(s.key, firstOf(s).id, firstOf(s).def);
      const allSame = (s) => s.items.every((it) => surfaceSaved(s.key, it.id, it.def) === curOf(s));
      const rowLabel = document.createElement('div'); rowLabel.className = 'mp-pop-item';
      rowLabel.innerHTML = `<span>整体不透明度</span><span class="k" data-mp-alpha-val>${curOf(SURFACES[0])}%</span>`;
      p.appendChild(rowLabel);
      const row = document.createElement('div'); row.className = 'mp-pop-item';
      row.style.cssText = 'gap:8px';
      const rng = document.createElement('input');
      rng.type = 'range'; rng.min = '0'; rng.max = '100'; rng.step = '1';
      rng.value = String(curOf(SURFACES[0]));
      rng.setAttribute('aria-label', '界面不透明度（百分比）');
      rng.style.cssText = 'flex:1 1 auto;min-width:120px;accent-color:var(--mp-primary)';
      const num = document.createElement('input');
      num.type = 'text'; num.inputMode = 'numeric'; num.value = String(curOf(SURFACES[0]));
      num.setAttribute('aria-label', '界面不透明度数字口（回车生效）');
      num.style.cssText = 'width:44px;text-align:right;background:var(--mp-codeBg);color:var(--mp-fg);border:1px solid var(--mp-border);border-radius:4px;padding:1px 5px;font:11px var(--mp-font-mono)';
      const pct = document.createElement('span'); pct.className = 'k'; pct.textContent = '%';
      row.append(rng, num, pct);
      p.appendChild(row);
      const hint = document.createElement('div'); hint.className = 'mp-pop-title';
      hint.textContent = '工具岛 / 公式框 / 大纲面板同值；逐项微调在「设置」里';
      hint.style.cssText = 'padding:0 10px 4px;font-size:11px;opacity:.75';
      p.appendChild(hint);
      /* 【交互】滑杆拖动 = 即时生效；数字口 = 键入 + **回车**生效（Esc 还原、失焦提交）；
         两条路都写同一个 localStorage 键（`mp-surfaces`），与「设置」面板是同源读写。 */
      const pushSurfaces = () => { try { localStorage.setItem('mp-surfaces', JSON.stringify(st)); } catch { } applySurfaces(); };
      let st = surfaceStore();
      const setAll = (v) => {
        const val = Math.max(0, Math.min(100, Math.round(Number(v))));
        if (!Number.isFinite(val)) return null;
        st = surfaceStore();
        /* 【第二波·FS-1 缺陷·2026-10-10】原来把 0–100 **无差别写进每一项** —— 连"背景模糊"
           （合法区间 0–24px，见 SURFACES 的 min/max）也写 ⇒ 越界值 + 面板滑杆顶格与标签自相矛盾
           + 跨重启不自愈。修成：只作用于**不透明度类**项（id 以 alpha 结尾：alpha / tbalpha /
           ctxalpha），且各自按自己的 min/max 钳制；非透明度项一个字节都不动。 */
        for (const s of SURFACES) {
          st[s.key] = st[s.key] || {};
          for (const it of s.items) {
            if (!/alpha$/.test(String(it.id))) continue;
            const lo = Number.isFinite(it.min) ? it.min : 0;
            const hi = Number.isFinite(it.max) ? it.max : 100;
            st[s.key][it.id] = Math.max(lo, Math.min(hi, val));
          }
        }
        pushSurfaces();
        rng.value = String(val); num.value = String(val);
        const lab = p.querySelector('[data-mp-alpha-val]'); if (lab) lab.textContent = val + '%';
        return val;
      };
      rng.addEventListener('input', () => setAll(rng.value));
      rng.addEventListener('mousedown', (e) => e.stopPropagation());
      rng.addEventListener('click', (e) => e.stopPropagation());
      num.addEventListener('mousedown', (e) => e.stopPropagation());
      num.addEventListener('click', (e) => e.stopPropagation());
      num.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); const v = setAll(num.value); if (v == null) num.value = String(curOf(SURFACES[0])); num.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); num.value = String(curOf(SURFACES[0])); num.blur(); }
      });
      num.addEventListener('blur', () => { const v = setAll(num.value); if (v == null) num.value = String(curOf(SURFACES[0])); });

      /* ── 阅读模式（内联；三档配色 + 进入/退出；与「更多 → 设置」里的阅读面板同源）── */
      p.appendChild(sep());
      const rt = document.createElement('div'); rt.className = 'mp-pop-title'; rt.textContent = '阅读模式'; p.appendChild(rt);
      const curPal = readingPalette();
      for (const pal of READING_PALETTES) {
        const d = document.createElement('div'); d.className = 'mp-pop-item';
        d.dataset.mpRp = pal.id;
        d.innerHTML = `<span>${pal.name}</span><span class="k">${pal.id === curPal ? '当前' : ''}</span>`;
        d.onclick = () => {
          try { localStorage.setItem('mp-reading-palette', pal.id); } catch { }
          if (!readingOn()) toggleReading(true); else applyReading();
          /* 【菜单要在阅读态里也能重开】`anchor` 是**闭包引用**（不是快照），
             切档后阅读态可能刚好被打开 ⇒ 锚点那一下 rect 全 0；openPop 已做"锚点不可见就退右上角"，
             这里再补一层：DOM 里取**活的** more 按钮当锚点，避免用到已被移除的旧节点。 */
          closePop();
          const live = document.querySelector('.mp-toolbar .mp-tb-item[data-mp-id="more"]') || anchor;
          openMore(live);          // 重开菜单显示新的当前档
        };
        p.appendChild(d);
      }
      /* 阅读档的"当前"标记存在内存里（`readingPalette()` 读 localStorage）；
         菜单每次都重新构建 ⇒ 上面这个循环天然显示最新值。 */
      add(readingOn() ? '退出阅读模式' : '进入阅读模式', () => toggleReading(!readingOn()), '阅读态会隐藏工具栏，Esc 可退出');

      p.appendChild(sep());
      add('帮助', help, '');
      add('关于', about, '');
    });
  }
  function insertText(text) {
    const v = getView(); if (!v) return;
    const r = v.state.selection.main;
    v.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length } });
    v.focus();
  }

  /* ── 粘贴（Q2 口径）──────────────────────────────────────────────────────────
   * 今天**没有任何粘贴处理**：格内粘多行会把管道塞进一格 ⇒ 表格被切开、焦点掉 BODY、Ctrl+Z 也救不回。
   * 这里按"先看内容再决定"：格内单行 ⇒ 交回默认（行为不变）；格内多行/表格 ⇒ 拒绝 + 提示；
   * 文档里 TSV / markdown 管道表 / 剪贴板 HTML <table> ⇒ 生成 markdown 表；单行 HTML 行内格式 ⇒ 白名单转 markdown。
   * 挂 document（capture）：活动格的覆盖层挂在 body 上，CM6 的处理器（挂 contentDOM）根本收不到它的粘贴。 */
  const INLINE_MARKS = { B: '**', STRONG: '**', I: '*', EM: '*', CODE: '`', DEL: '~~', S: '~~' };
  function htmlInlineNodeToMd(child) {
    if (child.nodeType === 3) return child.nodeValue.replace(/\s+/g, ' ');
    if (child.nodeType !== 1) return '';
    const tag = child.tagName;
    if (tag === 'BR') return ' ';
    const inner = htmlInlineToMd(child);
    const mark = INLINE_MARKS[tag];
    if (mark) return mark + inner + mark;
    if (tag === 'A') return '[' + inner + '](' + (child.getAttribute('href') || '') + ')';
    return inner;
  }
  function htmlInlineToMd(node) {
    return [...node.childNodes].map(htmlInlineNodeToMd).join('');
  }
  const HTML_BLOCKS = 'h1,h2,h3,h4,h5,h6,p,div,section,article,main,aside,header,footer,figure,figcaption,address,ul,ol,li,blockquote,hr,pre,table,dl,dt,dd';
  /* 一个 DOM 按 childNodes 顺序转换；表格在原位置输出，包装层和裸文本也保序。 */
  function htmlRichToMd(body) {
    const blocks = []; let inline = '';
    const flush = () => { if (inline.trim()) blocks.push(inline.trim()); inline = ''; };
    for (const el of body.childNodes) {
      if (el.nodeType !== 1) { inline += htmlInlineNodeToMd(el); continue; }
      const T = el.tagName;
      if (!el.matches(HTML_BLOCKS) && !el.querySelector(HTML_BLOCKS)) {
        inline += htmlInlineNodeToMd(el); continue;
      }
      flush();
      if (T === 'TABLE') blocks.push(rowsToMdTable(tableRowsFromElement(el)));
      else if (/^H[1-6]$/.test(T)) blocks.push('#'.repeat(Number(T[1])) + ' ' + htmlInlineToMd(el).trim());
      else if (T === 'UL' || T === 'OL') {
        const items = [...el.children].filter(c => c.tagName === 'LI');
        blocks.push(items.map((li, i) => {
          const marker = T === 'OL' ? (i + 1) + '. ' : '- ';
          return marker + htmlRichToMd(li).replace(/\n/g, '\n' + ' '.repeat(marker.length));
        }).join('\n'));
      } else if (T === 'BLOCKQUOTE') blocks.push(htmlRichToMd(el).split('\n').map(line => '> ' + line).join('\n'));
      else if (T === 'HR') blocks.push('---');
      else if (T === 'PRE') blocks.push('```\n' + String(el.textContent || '').replace(/\s+$/, '') + '\n```');
      else blocks.push(htmlRichToMd(el));
    }
    flush();
    return blocks.filter((b) => b.length).join('\n\n');
  }
  function tableRowsFromElement(t) {
    // Markdown 表格无法表示嵌套表或合并单元格；由调用者回退完整纯文本。
    if (t.querySelector('table,[rowspan]:not([rowspan="1"]),[colspan]:not([colspan="1"])')) throw new Error('unsupported HTML table');
    const rows = [];
    for (const tr of t.querySelectorAll('tr')) {
      if (tr.closest('table') !== t) continue;
      const cells = [...tr.children].filter(cell => cell.tagName === 'TH' || cell.tagName === 'TD').map(cell => htmlInlineToMd(cell).trim());
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) throw new Error('empty HTML table');
    return rows;
  }
  /** 纯文本里的结构化：全行带 Tab（Excel/TSV）或全行以 `|` 起手（markdown 表）。 */
  function tableFromPlain(plain) {
    const lines = String(plain).replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
    if (lines.length < 2) return null;
    if (lines.every((l) => l.indexOf('\t') >= 0)) return lines.map((l) => l.split('\t').map((c) => c.trim()));
    if (lines.every((l) => /^\s*\|/.test(l))) {
      const rows = lines.map((l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim()));
      const body = rows.filter((r) => !(r.length && r.every((c) => /^:?-{2,}:?$/.test(c))));   // 丢掉原表分隔行
      return body.length >= 2 ? body : null;
    }
    return null;
  }
  function rowsToMdTable(rows) {
    const cols = Math.max(...rows.map((r) => r.length));
    const pad = (r) => { const c = r.slice(); while (c.length < cols) c.push(''); return c; };
    const line = (cs) => '| ' + cs.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ') + ' |';
    const head = pad(rows[0]);
    return [line(head), '| ' + head.map(() => '---').join(' | ') + ' |', ...rows.slice(1).map((r) => line(pad(r)))].join('\n');
  }

  /* ══ task-13：读 front-matter 里的 mp-image-mode ══════════════════════════════════════
     盘上**没有**现成的 front-matter 解析器（grep 过），故新写这个最小实现：
       · 只扫**开头那段** `---` 块（不做全文搜 mp-image-mode，避免正文里出现同名文本被误读）；
       · 宽容：键名大小写不敏感、冒号两侧允许多余空白、值可带引号；
       · 未知值 ⇒ 回落 `inline`，**不报错**；
       · **只读不写**（默认不往文档里写 front-matter，与 D 口径一致）。 */
  /** 【task-13】光标是否落在**开头那段 front-matter 块**内（与 imageModeOf 同一套正则，口径一致）。 */
  function inFrontMatter(doc, pos) {
    const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(doc || ""));
    if (!m) return false;
    return typeof pos === "number" && pos <= m[0].length;
  }

  /** 【task-17】图片策略的**全局偏好**。与 front-matter 的关系（唯一判定顺序，别在别处再判一次）：
   *  **文档 front-matter 写了 `mp-image-mode` ⇒ 以文档为准**；没写 ⇒ 看这份偏好；偏好也没有 ⇒ `assets`。
   *  键名与 front-matter 同名（`mp-image-mode`），便于用户理解"这是同一件事的两个层级"。
   *  【2026-10-09 默认翻面：inline → assets】依据（外部调研，来源见 `.mp-verify/images-research/REPORT.md`）：
   *   · 主流编辑器**没有一家**把 inline 作默认（Typora / Obsidian / VS Code 1.79+ / JetBrains / Zettlr /
   *     MarkText 全部落盘；Zettlr 的默认目录就叫 `assets/`）；base64 在两款常见扩展里都是 opt-in 且默认关；
   *   · **GitHub / GitLab 渲染会剥离 `data:` 图片**（html-pipeline 白名单：`img src` 仅 http/https/相对）
   *     ⇒ 默认内联的文档推上 forge **必裂图**；
   *   · 内联还把一张 1080p 截图变成**一整行 40~270 万字符**：本机实测"该行在视口里"时每键 12.5ms、
   *     在该行内打字 40ms+（`EXEMPT` OPEN-1 第 1 条）；落盘后那一行只剩 `![](assets/x.png)` 几十个字符。
   *  inline **保留为显式选项**（设置面板 / 文档头 `mp-image-mode: inline`），文案里注明平台不渲染。
   *  存量内联文档**不静默改写**：要转换由用户显式执行「抽出到 assets」命令。 */
  const IMG_MODE_KEY = "mp-image-mode";
  function imageModePref() {
    try { return localStorage.getItem(IMG_MODE_KEY) === "inline" ? "inline" : "assets"; } catch { return "assets"; }
  }
  function setImageModePref(v) {
    try { localStorage.setItem(IMG_MODE_KEY, v === "inline" ? "inline" : "assets"); } catch { }
  }
  /* 首启就把**默认值**落进 localStorage：偏好项必须"可见"（设置面板与验收都按 mp-* 键读它），
     不能只靠"缺省即 assets" —— 那样外部无法区分"默认 assets"与"根本没这项设置"。 */
  setImageModePref(imageModePref());

  function imageModeOf(doc) {
    const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(doc || ""));
    if (!m) return imageModePref();          /* 【task-17】没有 front-matter ⇒ 用全局偏好（默认 inline） */
    for (const line of m[1].split(/\r?\n/)) {
      /* 单一的键值行解析：键名大小写不敏感由 k[1].toLowerCase() 判 —— 只留这一条判定路径 */
      const k = /^[ \t]*([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*?)[ \t]*$/.exec(line);
      if (!k) continue;
      if (k[1].toLowerCase() !== "mp-image-mode") continue;
      const v = String(k[2] || "").trim().toLowerCase().replace(/^["']|["']$/g, "");
      return v === "assets" ? "assets" : "inline";
    }
    return imageModePref();                  /* 【task-17】front-matter 在、但没有这个键 ⇒ 同样看偏好 */
  }

  /** 从剪贴板挑**第一张**位图（image/*）；同时报出图片总数以便提示。 */
  function pickClipboardImage(cd) {
    const out = { file: null, n: 0 };
    try {
      const items = cd.items ? Array.from(cd.items) : [];
      for (const it of items) {
        if (it.kind !== "file") continue;
        if (!/^image\//i.test(it.type || "")) continue;
        out.n++;
        if (!out.file) { try { out.file = it.getAsFile(); } catch (e) { } }
      }
      if (!out.file) {
        for (const f of Array.from(cd.files || [])) {
          if (!/^image\//i.test(f.type || "")) continue;
          out.n++;
          if (!out.file) out.file = f;
        }
      }
    } catch (e) { }
    return out;
  }

  const fileToBase64 = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    const timer = setTimeout(() => { r.abort(); rej(new Error('读图超时')); }, 15000);
    r.onload = () => { clearTimeout(timer); const s = String(r.result || ""); const i = s.indexOf(","); res(i >= 0 ? s.slice(i + 1) : s); };
    r.onerror = r.onabort = () => { clearTimeout(timer); rej(new Error("读图失败")); };
    r.readAsDataURL(file);
  });
  let imageInsertionQueue = Promise.resolve();
  async function imageHostCall(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('图片处理超时')), 15000); })]); }
    finally { clearTimeout(timer); }
  }

  /** 【唯一图片插入路径】粘贴（task-13）/ 选文件（task-3 C2）/ 从浏览器取回（task-3 C2）全部汇到这里。
   *  **策略只由内部的 imageModeOf(doc) 决定**（inline / assets）⇒ 改策略只改这一个函数（task-17），
   *  别在 upload / download / paste 各写一份分支（分叉了就会出现"粘的是 assets、选文件是 inline"）。
   *  @param file  File/Blob（只需 .type，且能被 FileReader 读）
   *  @param total 来源张数（>1 时提示"已插入第 1 张"）
   *  @param userEvent 撤销栈里的动作名 —— **必须与实际来源一致**（用户在撤销提示里看得见）：
   *                   粘贴 "input.paste" / 选文件 "input.upload" / 从浏览器 "input.download" */
  async function insertImageFile(file, total = 1, userEvent = "input.paste") {
    const el = document.activeElement;
    const inCell = !!(el && el.classList && el.classList.contains("mp-cell-overlay-text"));
    if (inCell) { toast("格内不能放图片，请粘到表格外"); return; }   // 明确拒绝，绝不静默
    /* 【front-matter 保护】光标在文档头部信息区（开头那段 --- 块）内 ⇒ 明确拒绝：
       否则会把 ![]() 插进 YAML、把闭合的 --- 挤到行尾，**破坏文档结构**。
       与"格内拒绝"同族：宁可明确拒绝，也不静默破坏。此处已在函数入口 preventDefault，故不会漏进默认行为。 */
    {
      const v0 = getView();
      if (v0 && inFrontMatter(v0.state.doc.toString(), v0.state.selection.main.head)) {
        toast("光标在文档头部信息区，请移到正文再粘贴");
        return;
      }
    }
    const v = getView();
    if (!v) { toast("当前无法插入图片"); return; }
    const ticket = reserveImageInsertion(v);
    if (!ticket) { toast('请只选择一个插入位置再粘贴图片'); return; }
    const mode = imageModeOf(v.state.doc.toString());
    const host = window.mpHost;
    const originRequest = host && typeof host.docInfo === 'function'
      ? imageHostCall(host.docInfo()).catch(() => null) : Promise.resolve(null);
    const mime = /^image\//i.test((file && file.type) || "") ? file.type : "image/png";
    const ext = (mime.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "") || "png";
    const work = imageInsertionQueue.then(async () => {
    if (!ticket.current()) return;
    let base64 = "";
    try { base64 = await fileToBase64(file); } catch (e) { toast("读取剪贴板图片失败"); return; }
    if (!base64) { toast("剪贴板里的图片是空的"); return; }
    const origin = await originRequest;
    const sameOrigin = async () => {
      if (getView() !== v || !ticket.current()) return false;
      if (origin && host && typeof host.docInfo === 'function') {
        const now = await imageHostCall(host.docInfo()).catch(() => null);
        if (!now || now.filePath !== origin.filePath || now.documentId !== origin.documentId) return false;
      }
      return !!ticket.current();
    };
    const canceled = () => toast('插入位置或文档已变化，图片插入已取消');
    if (!await sameOrigin()) { canceled(); return; }
    // Warm the widget's exact URL before committing its native scroll request.
    // A decode failure still uses the existing visible image failure state.
    const insert = async (md, src) => {
      let image = new Image(), timer;
      try {
        image.src = imageSource(src);
        try {
          await Promise.race([image.decode(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('图片解码超时')), 10000);
          })]);
        } catch { /* Keep the real source and let the widget show a failure. */ }
        if (!await sameOrigin()) { canceled(); return false; }
        return ticket.commit(md, userEvent);
      } finally {
        clearTimeout(timer);
        image.src = '';
        image = null;
      }
    };
    const more = total > 1 ? "（剪贴板里有 " + total + " 张，已粘贴第 1 张）" : "";
    /* 回落原因只**记**不弹：toast 是单例，先弹原因会被后面的"已插入图片"覆盖掉（实测踩过） */
    let fallbackWhy = "";
    if (mode === "assets") {
      if (host && typeof host.saveImageToAssets === "function") {
        const docPath = origin?.filePath || null;
        /* 【2026-10-09·默认改成 assets 之后这条更要紧】文档还没保存过 ⇒ 不知道该把 assets/ 放哪。
           提示要**可操作**（告诉用户怎么办），而不是只说"失败"；本次仍回退内联，图不会丢。 */
        if (!docPath) fallbackWhy = "文档还没保存到磁盘（Ctrl+S 保存后即可把图落盘到 assets/），本次已内联";
        else try {
          const r = await imageHostCall(host.saveImageToAssets({ docPath, base64, mime, fileName: "pasted-image." + ext }));
          const rel = r && (r.relPath || r.rel);
          /* 【(b′) 不变量守卫】本图真实字节数（由 base64 长度反推，含尾部 padding 修正） */
          const myBytes = Math.floor(base64.length * 3 / 4) - (base64.slice(-2) === "==" ? 2 : base64.slice(-1) === "=" ? 1 : 0);
          const shellBytes = (r && typeof r.bytes === "number" && isFinite(r.bytes)) ? r.bytes : null;
          if (r && r.ok === true && rel) {
            if (shellBytes === myBytes) {
              if (!await sameOrigin()) { canceled(); return; }
              if (await insert("![](" + rel + ")", rel)) toast("已存入 assets 并插入图片" + more);
              return;
            }
            /* 壳返回的字节数与本图不一致 ⇒ 那条路径指向的是**别人的图** ⇒ 绝不插入，宁可回落 inline。
               （实测场景：连粘两张不同位图时，壳只判"文件在不在"就复用旧路径 ⇒ 用户"粘了 B 却看到 A"。） */
            fallbackWhy = "assets 同名冲突未解决（壳返回 " + (shellBytes === null ? "未返回 bytes" : shellBytes + " 字节") + " ≠ 本图 " + myBytes + " 字节），已改为内联";
          } else {
            /* 回落必须**写明原因**：别让用户以为"本来就是 inline"（Lead 口径） */
            fallbackWhy = "assets 落盘失败：" + ((r && r.error) || "宿主未返回路径") + "，已改为内联";
          }
        } catch (e) { fallbackWhy = "assets 落盘失败：" + ((e && e.message) || e) + "，已改为内联"; }
      } else {
        fallbackWhy = "assets 落盘失败：当前宿主不支持 saveImageToAssets，已改为内联";
      }
    }
    if (!await sameOrigin()) { canceled(); return; }
    if (!await insert("![](data:" + mime + ";base64," + base64 + ")", "data:" + mime + ";base64," + base64)) return;
    /* 只弹这一次：有回落原因就把它并进来（否则用户看到的只是"已插入图片"，以为本来就是 inline） */
    toast(fallbackWhy ? (fallbackWhy + more) : ("已插入图片" + more));
    }).catch(e => { toast('插入图片失败：' + (e?.message || e)); }).finally(() => ticket.cancel());
    imageInsertionQueue = work;
    return work;
  }

  /** 位图粘贴入口：**唯一**粘贴专有动作是 preventDefault（保住"不落默认行为"），其余全部委托给共享 helper。 */
  async function pasteImageFile(event, file, total) {
    event.preventDefault();
    return insertImageFile(file, total);
  }

  /* ── task-3（C1 / C2）新增：可复用输入框 · 重新加载 · 图片的两条取回路径 ────────────── */

  /** 可复用单行输入（沿用 dialog() 骨架 + .mp-dlg 一族的视觉）。本仓**没有**专用输入类名，
   *  故输入框按同族内联样式写，不新增全局样式类（免得一个输入框弹窗长得跟设置弹窗不一样）。
   *  @returns {Promise<string|null>} 取消 ⇒ null（与"确认了空串"区分开） */
  function promptLine({ title, placeholder = '', value = '', okText = '确定' }) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = value => { if (!settled) { settled = true; resolve(value); } };
      dialog(title, '<p><input class="mp-line-input" type="text" style="width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--mp-border);border-radius:6px;background:transparent;color:var(--mp-fg);font:inherit" placeholder="' + placeholder + '" value="' + value + '"></p>'
        + '<p style="text-align:right;margin-top:12px"><button class="mp-key" data-ok>' + okText + '</button></p>', () => settle(null));
      const inp = dlgEl && dlgEl.querySelector('input.mp-line-input');
      if (!inp) { resolve(null); return; }
      const panel = dlgEl;
      inp.focus(); inp.select();                 // 默认聚焦 + 全选：用户可直接覆盖
      const done = (val) => { settle(val); closePanel(panel, true); };
      dlgEl.querySelector('[data-ok]').onclick = () => done(inp.value);
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); done(inp.value); }
        else if (ev.key === 'Escape') { ev.preventDefault(); done(null); }   // dialog() 没有全局 Esc，这里自带
      });
    });
  }

  /** 「重新加载」：调壳侧 file:reload 重新读盘并灌回编辑器（引擎无任何读盘能力，只能由壳做）。
   *  【为什么这里**不**清空撤销栈、**不**手动挪光标】引擎侧 setValue 用的是"最小 diff 中段替换"：
   *   ① 外部改动以 addToHistory:false 应用 ⇒ 它根本不是历史项 ⇒ Ctrl+Z 永远动不了外部改动
   *      （"盘上外改守恒"）—— 所以"撤销一下就把外改冲掉"这条数据丢失路径**并不存在**；
   *   ② 用户原有的撤销分支经最小 ChangeSet 映射**存活**（全量替换会让它们塌缩成零长 no-op）；
   *   ③ 光标交给 CM6 原生位置映射（上方插 9 字时列仍精确保持），**优于手动钳位**。
   *  ⇒ 本函数只负责"发起 + 如实报结果"，一行重置代码都不要加。 */
  async function reloadDoc() {
    const h = window.mpHost;
    if (!h || typeof h.reload !== 'function') { toast('重新加载需要桌面版'); return; }
    /* 【先落盘，再重载】渲染侧 host.js 的保存是 **500ms 去抖**（SAVE_DEBOUNCE_MS）⇒
       编辑后立刻点「重新加载」，那半秒里的改动会被"以磁盘为准"的重载**静默顶掉**（实测到一次）。
       冲一次待落盘的保存就没有这个窗口：冲完磁盘即最新 ⇒ 重载回来仍是用户刚写的内容；
       冲不下去（保存失败）⇒ 文档仍脏 ⇒ 壳侧的确认框（默认取消）才真正有意义。 */
    try {
      const r = await window.mpReloadDocument({ origin: 'toolbar' });
      if (r && r.ok) toast('已重新加载文件内容');
      else if (r && r.canceled) { /* 用户取消：静默（别弹"失败"误导） */ }
      else toast((r && r.error) || '重新加载失败');
    } catch (e) { toast('重新加载失败：' + ((e && e.message) || e)); }
  }

  /** 把壳侧给的**绝对路径**读成 File/Blob（与粘贴同形状）⇒ 汇入唯一插入路径。
   *  壳侧 file:readBase64 返回 { ok, base64, bytes, mime, path }。 */
  async function imageFileFromPath(p) {
    const h = window.mpHost;
    if (!h || typeof h.readFileBase64 !== 'function') { toast('读取图片需要桌面版'); return null; }
    let r = null;
    try { r = await h.readFileBase64(p); } catch (e) { toast('读取图片失败：' + ((e && e.message) || e)); return null; }
    if (!r || r.ok === false || !r.base64) { toast('读取图片失败：' + ((r && r.error) || p)); return null; }
    const mime = r.mime || 'image/png';
    const bin = atob(r.base64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const name = String(p).split(/[\\/]/).pop() || 'image';
    try { return new File([buf], name, { type: mime }); }
    catch (e) { const b = new Blob([buf], { type: mime }); b.name = name; return b; }
  }

  /** 【C2·单一语义】图片按钮只做一件事：弹**原生文件选择器**（壳侧 image:pick 现成，壳零改动）。
   *  取回的每张都走 insertImageFile ⇒ 策略 / assets 回落 / 字节守卫与粘贴**完全同源**。
   *  ⚠️ 本函数是 async，但**调用点必须保持同步**（见 toolbarClick 的 case 'upload' 注释）。 */
  async function pickAndInsertImages() {
    const h = window.mpHost;
    if (!h || typeof h.pickImages !== 'function') { toast('插入图片需要桌面版'); return; }
    const r = await h.pickImages({ multiple: true });
    if (!r || r.canceled) return;
    const list = (r.files || []).filter(Boolean);
    if (!list.length) return;
    let ok = 0;
    for (const p of list) {
      const f = await imageFileFromPath(p);
      if (!f) continue;
      await insertImageFile(f, list.length, 'input.upload');
      ok++;
    }
    if (!ok) toast('没有可插入的图片');
  }

  /** 「从浏览器打开」：弹地址输入 → **主进程代取**（渲染进程零网络）→ 取回后走同一条插入路径。
   *  【为什么不再需要"二选一"对话框】取回方式不同（选文件 / 按 URL 取），**插入路径只有一个**。 */
  async function openImageFromUrl() {
    const url = await promptLine({ title: '从浏览器打开图片', placeholder: 'https://…/image.png', okText: '获取' });
    if (url == null) return;                      // 取消（与"确认了空串"不同：空串在下面被拦住）
    const u = String(url).trim();
    if (!u) { toast('请输入图片地址'); return; }
    if (!/^https?:\/\//i.test(u)) { toast('请输入 http(s) 开头的图片地址'); return; }
    const h = window.mpHost;
    if (!h || typeof h.downloadImageToCache !== 'function') { toast('该功能需要桌面版'); return; }
    let r = null;
    try { r = await h.downloadImageToCache({ url: u }); } catch (e) { toast('获取图片失败：' + ((e && e.message) || e)); return; }
    if (!r || r.ok === false) { toast('获取图片失败：' + ((r && r.error) || '未知错误')); return; }
    const src = r.absPath || r.cachePath;
    const f = src ? await imageFileFromPath(src) : null;
    if (!f) { toast('获取图片失败：宿主未返回可用路径'); return; }
    await insertImageFile(f, 1, 'input.download');
  }

  /* ── task-17：图片策略的两条**批量**命令 ────────────────────────────────────────
     共同契约（与 7.4 的判据一一对应）：
       · **一次 dispatch 改完整篇** ⇒ 一次 Ctrl+Z 就能整体回退（不是撤 N 次）；
       · **http(s) 外链一律不动**（渲染进程零网络，拉不下来就保持原样，且如实报数量）；
       · **往返幂等**：inline → assets → inline 后源码与第一次 inline **逐字节相同**
         （关键是不重新编码：落盘写原字节、内联读回同一 mime ⇒ base64 不变）；
       · 两条命令都**只改图片的 target**，alt 与其余文本一字不动。 */

  /** 扫描文档里的 `![alt](target)`（只认最朴素形态：目标不含空格/右括号）。 */
  function scanImageRefs(text) {
    const out = [];
    const re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m;
    while ((m = re.exec(text))) {
      const open = m[0].indexOf("](");
      const tFrom = m.index + open + 2;
      out.push({ from: tFrom, to: tFrom + m[2].length, alt: m[1], target: m[2] });
    }
    return out;
  }

  /** 文档所在目录（相对路径的基准）；无路径 ⇒ null。 */
  async function docDirPath() {
    try {
      const info = await window.mpHost.docInfo();
      const fp = info && info.filePath;
      if (!fp) return null;
      const i = Math.max(fp.lastIndexOf("\\"), fp.lastIndexOf("/"));
      return i > 0 ? fp.slice(0, i) : null;
    } catch { return null; }
  }

  /** 相对/本地路径 → 绝对路径（URL 与 data: 由调用方先排除）。 */
  function absImagePath(dir, target) {
    const t = String(target).replace(/^</, "").replace(/>$/, "");
    if (/^[A-Za-z]:[\\/]/.test(t) || t.slice(0, 2) === "\\\\") return t;
    if (!dir) return null;
    return dir + "\\" + t.replace(/\//g, "\\");
  }

  /** 「内联全部图片」：本地路径 → data URI（外链保持原样）。 */
  async function inlineAllImages() {
    const v = getView(); if (!v) return;
    const current = captureImageDocument(v);
    const h = window.mpHost;
    if (!h || typeof h.readFileBase64 !== "function") { toast("内联图片需要桌面版"); return; }
    const dir = await docDirPath();
    if (getView() !== v || !current()) { toast('文档已变化，图片转换已取消'); return; }
    const refs = scanImageRefs(v.state.doc.toString());
    const changes = []; let remote = 0, failed = 0;
    for (const r of refs) {
      if (/^data:/i.test(r.target)) continue;
      if (/^(https?|file):/i.test(r.target)) { remote++; continue; }   // 外链不动
      const abs = absImagePath(dir, r.target);
      if (!abs) { failed++; continue; }
      let res = null;
      try { res = await h.readFileBase64(abs); } catch (e) { res = null; }
      if (getView() !== v || !current()) { toast('文档已变化，图片转换已取消'); return; }
      if (!res || res.ok === false || !res.base64) { failed++; continue; }
      changes.push({ from: r.from, to: r.to, insert: "data:" + (res.mime || "image/png") + ";base64," + res.base64 });
    }
    if (!changes.length) {
      toast(remote ? ("没有可内联的本地图片（" + remote + " 张外链保持原样）") : "文档里没有可内联的本地图片");
      return;
    }
    v.dispatch({ changes, userEvent: "input.inline-all-images" });      // 一次 ⇒ 一次撤销
    toast("已内联 " + changes.length + " 张图片"
      + (remote ? "（" + remote + " 张外链保持原样）" : "")
      + (failed ? "，" + failed + " 张读不到已跳过" : ""));
  }

  /** 「抽出到 assets」：data URI → 落盘 assets/ + 改写相对路径。 */
  async function extractImagesToAssets() {
    const v = getView(); if (!v) return;
    const current = captureImageDocument(v);
    const h = window.mpHost;
    if (!h || typeof h.saveImageToAssets !== "function") { toast("抽出图片需要桌面版"); return; }
    let docPath = null;
    try { const info = await h.docInfo(); docPath = info && info.filePath ? info.filePath : null; } catch (e) { docPath = null; }
    if (getView() !== v || !current()) { toast('文档已变化，图片转换已取消'); return; }
    if (!docPath) { toast("请先把文档保存到磁盘，再抽出图片（否则不知道 assets 该放哪）"); return; }
    const refs = scanImageRefs(v.state.doc.toString()).filter((r) => /^data:/i.test(r.target));
    if (!refs.length) { toast("文档里没有可抽出的内联图片"); return; }
    const changes = []; let failed = 0, idx = 0;
    for (const r of refs) {
      const m = /^data:([^;,]+)(;base64)?,(.*)$/i.exec(r.target);
      if (!m) { failed++; continue; }
      const mime = m[1] || "image/png";
      const ext = (mime.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "") || "png";
      idx++;
      let res = null;
      try { res = await h.saveImageToAssets({ docPath, base64: m[3] || "", mime, fileName: "inline-" + idx + "." + ext }); } catch (e) { res = null; }
      if (getView() !== v || !current()) { toast('文档已变化，图片转换已取消'); return; }
      const rel = res && (res.relPath || res.rel);
      if (!res || res.ok === false || !rel) { failed++; continue; }
      changes.push({ from: r.from, to: r.to, insert: rel });
    }
    if (!changes.length) { toast("抽出失败：没有一张图片落盘成功"); return; }
    v.dispatch({ changes, userEvent: "input.extract-images" });         // 一次 ⇒ 一次撤销
    toast("已抽出 " + changes.length + " 张图片到 assets/"
      + (failed ? "（" + failed + " 张失败已跳过）" : ""));
  }

  // Windows HTML clipboard context may surround the selected fragment with
  // whitespace. Read its DOM comment boundaries without trimming its text.
  function clipboardFragmentText(doc) {
    const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT);
    let start = null, node;
    while ((node = walker.nextNode())) {
      if (!start && node.data.trim() === 'StartFragment') start = node;
      else if (start && node.data.trim() === 'EndFragment') {
        const range = doc.createRange();
        range.setStartAfter(start); range.setEndBefore(node);
        return range.cloneContents().textContent || '';
      }
    }
    return doc.body.textContent || '';
  }
  function onDocPaste(event) {
    const cd = event.clipboardData; if (!cd) return;
    /* ★【task-13】位图分支**必须在最前面**：位图粘贴时 text/plain 通常为空，
       走到后面的 return（"不抢默认"）会被吞掉 ⇒ 表现就是"粘了完全没反应"。 */
    {
      const picked = pickClipboardImage(cd);
      if (picked.file) { pasteImageFile(event, picked.file, picked.n); return; }
    }
    const plain = cd.getData('text/plain') || '';
    const html = cd.getData('text/html') || '';
    let htmlDoc = null;
    if (html) { try { htmlDoc = new DOMParser().parseFromString(html, 'text/html'); } catch { /* 完整纯文本回退 */ } }
    const htmlHasTable = !!htmlDoc?.body.querySelector('table');
    const bare = plain.replace(/\r?\n$/, '');
    const multi = bare.indexOf('\n') >= 0;
    const el = document.activeElement;
    const inCell = !!(el && el.classList && el.classList.contains('mp-cell-overlay-text'));
    if (inCell) {
      /* ① 多行 / 表格：**拒绝**（这正是"表格被切开、焦点掉 BODY"的止血点） */
      if (multi || htmlHasTable) {
        event.preventDefault();
        toast(multi ? '格内不支持多行粘贴（会把表格切开）—— 请粘到表格外' : '格内不能放表格');
        return;
      }
      // Literal pipes stay visible in the DOM; the cell codec encodes the source.
      /* ③ 单行 HTML 行内格式 ⇒ 白名单转 markdown 标记（Q2 ④） */
      if (htmlDoc) {
        const md = htmlInlineToMd(htmlDoc.body);
        if (md != null && md.replace(/\s+/g, ' ').trim() && md.trim() !== bare.trim()) {
          event.preventDefault();
          document.execCommand('insertText', false, md.trim());
          return;
        }
      }
      return;   // 其余：交回默认（单值粘贴行为不变）
    }
    const v = getView();
    if (!v || !el || !v.contentDOM.contains(el)) return;
    /* 【第二波·code-fence 缺陷·2026-10-10】代码块内粘贴 TSV / 表格片段会被下面的"建表启发式"
       改写成 Markdown 表（实测 CF-5b：Δ58、插入片段变成 `| name | value |…`、随后 4 行
       `code=false`、toast「已建成 3 行 × 2 列」；CF-5c 同形）。**代码块里的内容应当逐字**，
       且 CF-5e 对照臂证明"粘 TSV 建表"在普通段落是设计特性 ⇒ 缺陷是它在围栏内也建。
       这里在接管之前判一次：光标在未闭合的围栏内 ⇒ **直接放行**（交回默认粘贴＝逐字插入）。 */
    /* 【单一真源·改用引擎渲染到行上的类·2026-10-10】前一版我用"从第 1 行累计抖动围栏"推断
       "光标是否在代码块内"，结果在**普通段落**上也判成围栏内 ⇒ 对照臂 CF-5e（普通段落粘 TSV
       应建表）从 ok 变 off、与围栏内的 CF-5b 互相拉扯（两臂对照已证实）。
       现在直接读引擎**已经算好并渲染到行上**的类（普查读数里就是 `cm-line cm-activeLine mp-code`
       这种形态，活动行始终在视口内 ⇒ 一定拿得到）；取不到时用 elementFromPoint 兜底。 */
    const caretOnCodeLine = () => {
      try {
        const el = document.querySelector('.cm-content .cm-line.cm-activeLine') || document.querySelector('.cm-line.cm-activeLine');
        if (el) return el.classList.contains('mp-code');
        const v0 = getView();
        const c = v0.coordsAtPos(v0.state.selection.main.head);
        const hit = document.elementFromPoint(c.left, Math.max(1, c.top + 2));
        const line = hit && hit.closest ? hit.closest('.cm-line') : null;
        return !!(line && line.classList.contains('mp-code'));
      } catch { return false; }
    };
    if (caretOnCodeLine()) return;
    // TeX is literal source. All ranges must belong to one mapped body; a
    // cross-formula or delimiter selection keeps the ordinary rich-text route.
    const mathSpans = v.state.field(mathSpansField, false)?.spans || [];
    const inMathBody = mathSpans.some(span => {
      const from = mathSourcePosition(span, 0);
      const to = mathSourcePosition(span, span.tex.length);
      return v.state.selection.ranges.every(range => range.from >= from && range.to <= to);
    });
    if (inMathBody) {
      if (plain || !htmlDoc) return; // Native CM paste owns text and history.
      const literal = clipboardFragmentText(htmlDoc);
      if (literal) {
        event.preventDefault();
        v.dispatch({ ...v.state.replaceSelection(literal), userEvent: 'input.paste' });
      }
      return;
    }
    const plainBare = String(plain || '').replace(/\r\n?/g, '\n').trim();
    const linesNonEmpty = plainBare ? plainBare.split('\n').filter((l) => l.trim()) : [];
    const plainIsTableOnly = linesNonEmpty.length > 0 && linesNonEmpty.every((l) => /\t/.test(l) || /^\s*\|/.test(l));
    const rows = tableFromPlain(plain);
    const convertHtml = !!htmlDoc && (htmlHasTable || !plainIsTableOnly);
    if (!convertHtml && !rows) return;
    /* 【P0-4·2026-10-10 由"表格日常"普查查出（剪贴板可用后复验为真缺陷）】
       ① 光标停在**表格行内**（但没有格覆盖层，例如点表格左侧空白 / 表头行）时，多行 TSV 会走
          普通块插入 ⇒ **原表被劈开**：实测管道数 `[4,4,4,4,4]` 变成 `[4,4,8,4,4,4]`，
          表头被粘走、分隔行 `---` 被当数据渲染。原来的守卫只判"焦点是否在格覆盖层里"，
          没判光标是否在表格里 ⇒ 这里补上：**与格内一致，拒绝并给同一句提示**。
       ② 插入新表时不做块级前后换行 ⇒ 末行会把正文行剩余文字吞进表格（实测
          `| T4 | T5 | T6 |前置段落。`，屏幕上那句正文消失）⇒ 光标不在行首/行尾时各补一个换行。 */
    const inTableAt = (state) => {
      try {
        const isPipe = (i) => { const t = state.doc.line(i).text.trim(); return t.startsWith('|') && t.endsWith('|'); };
        const n = state.doc.lineAt(state.selection.main.head).number;
        if (!isPipe(n)) return false;
        let a = n; let b = n;
        while (a > 1 && isPipe(a - 1)) a--;
        while (b < state.doc.lines && isPipe(b + 1)) b++;
        for (let i = a; i <= b; i++) if (/^\|(\s*:?-{2,}:?\s*\|)+$/.test(state.doc.line(i).text.trim())) return true;
        return false;
      } catch { return false; }
    };
    if (inTableAt(v.state) && (multi || htmlHasTable)) {
      event.preventDefault();
      toast('格内不支持多行粘贴（会把表格切开）—— 请粘到表格外');
      return;
    }
    let text;
    if (convertHtml) {
      try { text = htmlRichToMd(htmlDoc.body); }
      catch { text = plain || htmlDoc.body.textContent || ''; }
      if (!text.trim()) text = plain;
    } else text = rowsToMdTable(rows);
    if (!text) return;
    event.preventDefault();
    const sel = v.state.selection.main;
    const doc = v.state.doc;
    const blockPaste = !!rows || !!htmlDoc?.body.querySelector(HTML_BLOCKS);
    const headNl = blockPaste && sel.from > 0 && doc.lineAt(sel.from).from !== sel.from ? '\n' : '';
    const tailNl = blockPaste && sel.to < doc.length && doc.lineAt(sel.to).to !== sel.to ? '\n' : '';
    const ins = headNl + text + tailNl;
    v.dispatch({ changes: { from: sel.from, to: sel.to, insert: ins }, selection: { anchor: sel.from + ins.length }, userEvent: 'input.paste' });
    toast(convertHtml ? '已粘贴富文本' : '已建成 ' + rows.length + ' 行 × ' + Math.max(...rows.map((r) => r.length)) + ' 列');
  }
  /* 【Ctrl+Shift+V＝原样（纯文本）粘贴·2026-10-10 由普查查出】普查实测它与 Ctrl+V **逐项相同**
     （同样 27 字符 / 3 个 TAB / 同样被改写成表）⇒ 用户想要"原样粘贴"时没有任何出路。
     做法：按下 Ctrl+Shift+V 时置一次标志，**下一次粘贴不接管**（不 preventDefault、不改写），
     直接放行给浏览器默认 ⇒ 逐字落进文档（在代码块里尤其要紧）。标志用完即清，不影响后续粘贴。 */
  let plainPasteOnce = false;
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && String(e.key || '').toLowerCase() === 'v') plainPasteOnce = true;
  }, true);
  const onDocPasteGuarded = (event) => {
    if (plainPasteOnce) { plainPasteOnce = false; return; }     // 原样粘贴：放行，不做任何改写
    return onDocPaste(event);
  };
  document.addEventListener('paste', onDocPasteGuarded, true);

  /* 【代码块内 Tab·2026-10-10 由"人类常用操作普查"查出】code-fence-daily 族实测：
     代码块内按 Tab **文档零改动**，keydown 到了编辑面却无人消费 ⇒ 浏览器把焦点遍历带走
     （`focusin → BUTTON.mp-tb-item.mp-tb-fold`）；用户体感就是"在代码块里按 Tab 后打字没反应"。
     列表/表格各有自己的 Tab 绑定（lists.js:138、tables.js:397），**代码块这一支从来没有绑定**。
     这里补上：Tab 插两空格（与列表缩进同宽），Shift+Tab 退两格；Shift+Tab 在嵌入环境会被浏览器反向
     焦点遍历劫走（仓里早有这条记录），故同样给 Mod-] / Mod-[ 两个入口。
     判定用"从文首数 ``` / ~~~ 围栏"的纯文本扫描（Tab 是低频操作，不为它引入新的状态依赖）。 */
  const inCodeFence = (state, pos) => {
    return !!codeBlockAt(state, pos);
  };
  const fenceNewline = view => {
    const st = view.state;
    const leadFor = r => {
      const block = codeBlockAt(st, r.from), line = st.doc.lineAt(r.from);
      if (!block || line.from === block.closeFrom || r.to > (block.closeFrom ?? block.to)) return null;
      const lead = quoteLead(line.text, block.depth);
      if (r.from < line.from + lead.off) return null;
      return lead.q + /^[ \t]*/.exec(line.text.slice(lead.off))[0];
    };
    if (st.selection.ranges.some(r => leadFor(r) === null)) return false;
    view.dispatch(st.changeByRange(r => {
      const insert = '\n' + leadFor(r);
      return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(r.from + insert.length) };
    }), { scrollIntoView: true, userEvent: 'input' });
    return true;
  };
  const fenceIndent = (view, outdent) => {
    const st = view.state;
    if (st.selection.ranges.length !== 1) return false;
    if (!inCodeFence(st, st.selection.main.head)) return false;      // 不在代码块 ⇒ 让位给列表/表格/默认行为
    const r = st.selection.main;
    if (outdent) {
      const line = st.doc.lineAt(r.from);
      const off = quoteLead(line.text, codeBlockAt(st, r.from).depth).off;
      const body = line.text.slice(off);
      const strip = body.startsWith('  ') ? 2 : (body.startsWith(' ') ? 1 : 0);
      if (!strip) return true;                                       // 已顶格：吃掉按键，别让焦点跑掉
      view.dispatch({ changes: { from: line.from + off, to: line.from + off + strip, insert: '' }, userEvent: 'input.indent' });
      return true;
    }
    try {
      const at = r.from;
      view.dispatch({
        changes: { from: at, to: r.to, insert: '  ' },
        selection: { anchor: at + 2 },
        userEvent: 'input.indent',
      });
    } catch { return false; }
    return true;
  };
  /* 【Tab 语义·方案 D 的安全阀·2026-10-10（GLM 调研报告第 0 节 ✓）】
     D ＝「有选区 ⇒ 缩进整段；在列表/表格/引用/代码块内 ⇒ 结构缩进；纯光标且在普通段落 ⇒ **焦点遍历**」，
     并**必须**配齐三个焦点出口 ✓（否则等于自造"键盘陷阱"✗，CM6 官方默认不处理 Tab 正是为避开它 ✓）。
     这里补其中的 **Ctrl+M 全局切换** ✓：一键在"Tab 缩进 / Tab 走焦点"之间切 ✓，并落盘记忆 ✓。
     三个出口的另两个：**Esc 后 Tab**（由浏览器默认行为提供 ✓，Tab 未被接管时自然可用 ✓）、帮助文档写明 ✓。
     默认值 **true**（缩进可用 ✓）＝与今天的行为一致 ✓ ⇒ 本处**不改任何默认行为** ✗（纯增量 ✓）。 */
  const TAB_INDENT_KEY = 'mp-pref-tab-indent';
  const tabIndentOn = () => { try { return localStorage.getItem(TAB_INDENT_KEY) !== '0'; } catch { return true; } };
  const toggleTabIndent = () => {
    const next = !tabIndentOn();
    try { localStorage.setItem(TAB_INDENT_KEY, next ? '1' : '0'); } catch { /* 忽略 */ }
    try { window.mpTabIndent = next; } catch { /* 探针读数口 ✓ */ }
    try { if (typeof toast === 'function') toast(next ? 'Tab：缩进（Ctrl+M 可切回焦点遍历）' : 'Tab：焦点遍历（Ctrl+M 可切回缩进）'); } catch { /* 忽略 */ }
    return true;
  };
  try { window.mpTabIndent = tabIndentOn(); } catch { /* 忽略 */ }   // 启动即暴露给探针 ✓
  /* 【方案 D 第 6 项·有选区 ⇒ 整段缩进·2026-10-10】D ＝「有选区 ⇒ 缩进整段；列表/表格/引用/代码块内
     ⇒ 结构缩进；**纯光标且在普通段落 ⇒ 焦点遍历**」✓。这条只补"选区缩进"一半 ✓：
       · **纯光标（空选区）⇒ 返回 false 不接管** ✓ ⇒ 交给浏览器做焦点遍历 ✓（D 的第三条 ✓）；
       · **有选区** ⇒ 逐行在行首插两空格 ✓（缩进语境统一用**空格**不用 tab ✓，报告第 0 节 ✓），
         选区整体跟着位移 ✓；`Shift+Tab` 反向最多去两格 ✓；
       · **保守边界** ✗：选区里只要**有一行在代码块内**（交给 codeFenceKeys ✓）**或像表格行**（`|` 起手 ✓
         交给 tables.js ✓），本处**一律不接管** ✓ ⇒ 既有三处 Tab 行为**一字不变** ✗。
     成本 ✓：只在"确实有选区"时才起一次 transaction ✓（纯光标路径**零开销** ✓）。 */
  const indentSelection = (view, outdent) => {
    if (view.state.selection.ranges.length !== 1) return false;
    const st = view.state, r = st.selection.main;
    if (r.empty) return false;                       // 纯光标 ⇒ 不接管（焦点遍历 ✓）
    const first = st.doc.lineAt(r.from), last = st.doc.lineAt(r.to);
    if (first.number === last.number && !outdent) return false;   // 单行内的普通选区也走默认 ✓
    for (let n = first.number; n <= last.number; n++) {
      const t = st.doc.line(n).text;
      if (/^\s*\|/.test(t) || /^\s*(```|~~~)/.test(t)) return false;   // 表格行/围栏 ⇒ 让位 ✓
    }
    if (inCodeFence(st, r.from)) return false;       // 代码块内 ⇒ 交给 codeFenceKeys ✓
    const changes = [];
    for (let n = first.number; n <= last.number; n++) {
      const line = st.doc.line(n);
      if (outdent) {
        const strip = line.text.startsWith('  ') ? 2 : (line.text.startsWith(' ') ? 1 : 0);
        if (strip) changes.push({ from: line.from, to: line.from + strip, insert: '' });
      } else if (line.text.length) {
        changes.push({ from: line.from, insert: '  ' });
      } else {
        changes.push({ from: line.from, insert: '  ' });   // 空行也补，保持整块对齐 ✓
      }
    }
    if (!changes.length) return true;                // 反向缩进但都顶格 ⇒ 吃掉按键 ✓
    /* 【自证·2026-10-10（错-27 范式 ✓）】只有"我真的接管了"才会 +1 ✓ ⇒ 探针据此判"有没有接管"✓，
       不再拿文档比对 ✗ —— 表格里按 Tab 会被 **tables.js 合法地加一行** ✓，文档比对会把这种
       正常行为读成失败 ✗（本轮实测就是这样连中两次错-19 ✗）。 */
    try { window.__tabSel = (window.__tabSel || 0) + 1; } catch { /* 忽略 */ }
    try {
      const tr = view.state.update({ changes, userEvent: 'input.indent' });
      /* 选区整体平移：行首插入会让 from/to 右移，逐行累加插入量 ✓ */
      let addFrom = 0, addTo = 0;
      for (const c of changes) {
        const n = outdent ? 0 : 2;
        if (c.from <= r.from) addFrom += n - (c.to - c.from);
        if (c.from <= r.to) addTo += n - (c.to - c.from);
      }
      view.dispatch(tr);
      view.dispatch({ selection: { anchor: Math.max(0, r.from + addFrom), head: Math.max(0, r.to + addTo) } });
    } catch { return false; }
    return true;
  };
  const tabPolicyKeys = deps.keymap.of([
    { key: 'Mod-m', run: () => toggleTabIndent() },
    /* 【双绑定·2026-10-10（实测 Mod-m 收不到按键）】探针实测：按 Ctrl+M 后 `window.mpTabIndent` 与
       落盘值**都没变** ✓ ⇒ 而启动行已执行（值为 true ✓）⇒ 说明**按键没进我的 keymap** ✗，
       但有更高优先级的 keymap 或捕获期监听器先吃掉了它 ✗（已排除菜单加速键：全清单里没有 Ctrl+M ✓）。
       这里增设 **Ctrl+Alt+M** ✓（无冲突 ✓、不会与任何系统/菜单键打架 ✓）—— D 要求的是"**有一个全局
       开关**"✓，键位归实现定 ✓；两条同时留着 ⇒ 哪天 Ctrl+M 通了也自动可用 ✓。 */
    { key: 'Mod-Alt-m', run: () => toggleTabIndent() },
    { key: 'Tab', run: (v) => indentSelection(v, false), shift: (v) => indentSelection(v, true) },
  ]);
  const codeFenceKeys = deps.Prec.highest(deps.keymap.of([
    { key: 'Enter', run: fenceNewline, shift: fenceNewline },
    { key: 'Tab', run: (v) => fenceIndent(v, false), shift: (v) => fenceIndent(v, true) },
    { key: 'Mod-]', run: (v) => fenceIndent(v, false) },
    { key: 'Mod-[', run: (v) => fenceIndent(v, true) },
  ]));

  /* 【浮岛遮挡与跳转丢滚动·2026-10-10 由"长文导航"普查查出】工具栏是**悬浮浮岛**：
     实测 Ctrl+Home 后文档第一行 `top=-1.4`，而浮岛底边 `barBottom=37.1` ⇒ 首行被压住；
     `.cm-scroller` 只有 16px padding-top，产品**从未登记 `EditorView.scrollMargins`**。
     CM6 的正解就是登记它：此后任何 `scrollIntoView`（Ctrl+Home/End、大纲跳转、查找命中、光标移动）
     都会自动在顶部让出浮岛高度，不需要各处手写补偿。高度按浮岛实际底边算，随字号/换行自适应。 */
  const toolbarScrollMargins = EditorView.scrollMargins.of(() => {
    try {
      const bar = document.querySelector('.mp-toolbar');
      /* 【P1-7 后半·2026-10-10 由"窗口状态"普查查出】Ctrl+End 到文末后光标整条被**底部状态栏**盖住
         （实测光标 y=377.9、状态栏顶 374.3 ⇒ 100% 在后面；距滚动极限还差 ~28px）。
         这里把底部也让出来：状态栏的类名在多个模块里出现过不同写法，故用一组候选选择器取
         "贴着窗口底边的覆盖条"，取不到就退化为 0（不会误伤无状态栏的布局）。 */
      let bottom = 0;
      for (const sel of ['.mp-statusbar', '#mp-statusbar', '.mp-status', '.mp-status-bar', '.mp-footer', '.mp-bottom-bar']) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.bottom > window.innerHeight - 80) bottom = Math.max(bottom, Math.round(window.innerHeight - r.top + 6));
      }
      if (!bar) return bottom ? { bottom } : null;
      const r = bar.getBoundingClientRect();
      return { top: Math.max(0, Math.round(r.bottom + 6)), bottom };
    } catch { return null; }
  });

  return {
    extension: [tableKeys, codeFenceKeys, tabPolicyKeys, toolbarScrollMargins],
    toolbarClick, applyPalette, toggleOutline, exportHtml, exportFolder, copyRich, copyTable, tableOp, setAlign, alignAt, about, help, shortcutDialog, rebindKeys, PALETTES,
    /* 【Typora 社区主题】安装/移除/读数：`installTyporaThemeFromText` 是**核心**（对话框与探针同源），
       `installTyporaTheme` 走壳层选文件；`userThemeInfo` 供设置面板与取证读当前状态。 */
    installTyporaTheme, installTyporaThemeFromText, removeTyporaTheme, userThemeInfo,
    /* 【图片命令导出·2026-10-10】对齐/缩放/范围解析：探针与后续的自定义百分比输入都用这两个。 */
    setImageAlignAt, setImageScaleAt, imageRangeAt,
    /* 【N1/B-1 同源出口】引擎侧（覆盖层 Ctrl+C、整表选区 Ctrl+C）取**同一个** TSV/HTML 构造器；
       引擎不重写一份载荷逻辑，口径只在这里。 */
    tableClipPayload, copyTableSource,
    /* 【β2】工具栏 ▦/⋮ 槽复用同一份表格菜单（矩形锚点：只读 clientX/clientY） */
    tableMenuAt: (rect, tableFrom) => { try { tableMenu(rect || { clientX: 40, clientY: 80 }, tableFrom); } catch (e) { console.error('[mp] tableMenuAt 失败：', e); } },
    lastExport: () => lastExport, collectImageRefs, mdToHtml, mdBodyChunks,
    buildMathCss, mathCssStat: () => mathCssStat, // 导出公式排版（探针/报告取证用）
  };
}
