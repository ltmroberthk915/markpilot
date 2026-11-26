/* article-publish.js — 文章版式的发布面：预览 / 复制 / 草稿共用**同一个**投影函数。
 *
 * 为什么集中在一处：微信草稿、复制到微信、复制到知乎、以及面板预览必须是**同一份输出**，
 * 否则会出现"预览好看、粘出来难看"或"草稿少图"。这里的 `buildArticleOutput` 是唯一入口。
 *
 * 输入：公开快照（publicMarkdown 之后）+ 已渲染好的正文 HTML（mdBodyChunks 的产物）
 *       + 配方（book/report/plain）+ 变体（follow/light/dark）+ 当前主题颜色快照。
 * 输出：
 *   · documentHtml  静态 HTML（`.mp-article` 根；导出/预览/打印共用；plain 时为空串）
 *   · wechatHtml    微信（全内联样式、外链编号+去重、公式/图表保留可栅格化类名）
 *   · zhihuHtml     知乎（保留原文链接、语义层级、代码缩进、公式带 TeX 来源）
 *   · links         外链计划（面板显示"将生成 N 条文末编号"）
 *   · summary       图片/公式/图表/表格/脚注/外链计数
 *
 * 全部是纯函数（Node 可单测）；DOM 与 IPC 只在调用方（extras.js / wechat 入口）。
 */

import { getArticleRecipe, articleDocumentCss } from './article-recipes.js';
import { normalizeEdition, exportEditionCss, EDITION_PAPERS } from './article-edition.js';
import {
  wechatArticleHtml, zhihuArticleHtml, articleDocument, articleSummary,
  planExternalLinks, applyInlineStyles, legacyStyles, LEGACY_INLINE_STYLES, escapeHtml,
} from './edition-publish.js';

/**
 * 发布颜色：**配方（kind + 已解析 tone）是唯一真源**。
 *
 * 实测反例：宿主深色 + 文稿「研报/浅色」时，若拿宿主 token 当发布色，白底上会出现
 * 浅灰标题（rgb(222,225,230)）与黑字叠深色表头（rgb(0,0,0) on rgb(42,44,49)）。
 * 发布件是**离开本机**的产物，配色必须由"用户明确选的版式 + 变体"决定，
 * 宿主主题只在 plain（没有配方）时作为对照，且同样要有可读的成对前景/底色。
 */
export function publishPalette(recipe, tone) {
  const paper = EDITION_PAPERS[tone === 'dark' ? 'dark' : 'light'];
  const colors = recipe && recipe.colors ? recipe.colors : null;
  const pick = (key) => (colors && typeof colors[key] === 'string' && colors[key].trim() ? colors[key].trim() : paper[key]);
  return {
    bg: pick('bg'), fg: pick('fg'), heading: pick('heading'), muted: pick('muted'),
    faint: pick('faint'), border: pick('border'), codeBg: pick('codeBg'), capsule: pick('capsule'),
    quoteBg: pick('quoteBg'), quoteBar: pick('quoteBar'), primary: pick('primary'),
    accent: pick('accent'), num: pick('num'),
  };
}

/** 兼容旧名（导出侧曾用 token 快照取色）；now 配方优先，tokens 只作兜底。 */
export function paletteFromSnapshot(tokens, tone) {
  const palette = publishPalette(null, tone);
  const t = tokens && typeof tokens === 'object' ? tokens : {};
  for (const key of Object.keys(palette)) {
    const v = t[key];
    if (typeof v === 'string' && v.trim()) palette[key] = v.trim();
  }
  if (t.num && String(t.num).trim()) palette.num = String(t.num).trim();
  return palette;
}

/** 片段根的内联成对前景/底色（发布件必须自带，不依赖收件页）。 */
export function publishRootStyle(palette, extra = {}) {
  return Object.assign({
    color: palette.fg, 'background-color': palette.bg,
    'font-size': '16px', 'line-height': '1.75', 'word-break': 'break-word',
  }, extra);
}

/** 发布件必备的固定样式（与配方无关，但微信/知乎两边都要有）。 */
function publishOnlyStyles(palette) {
  return {
    linkRef: { 'font-size': '.72em', 'vertical-align': 'super', 'line-height': '0', color: palette.primary, 'text-decoration': 'none' },
    aInline: { color: palette.primary, 'text-decoration': 'none' },
    origin: { color: palette.muted, 'font-size': '.86em', margin: '1.6em 0 0' },
  };
}

/**
 * @param {object} options
 * @param {string} options.html        正文 HTML（已渲染公式/图表/脚注的片段）
 * @param {{kind?:string,variant?:string}} options.edition
 * @param {'light'|'dark'} options.tone 已解析的明暗（follow 由调用方按界面解析）
 * @param {object} [options.tokens]     主题 token 快照（--mp-* 去掉前缀）
 * @param {string} [options.title]
 * @param {string} [options.sourceUrl]  原文地址（导出件 canonical + 微信文末）
 * @param {boolean} [options.linkNotes] 微信是否文末编号（默认 true）
 * @param {boolean} [options.dedupe]    微信外链是否去重（默认 true）
 * @param {string} [options.mathCss]    公式样式（导出页需要；预览可不传）
 */
export function buildArticleOutput(options = {}) {
  const html = String(options.html == null ? '' : options.html);
  const edition = normalizeEdition(options.edition || null);
  const tone = options.tone === 'dark' ? 'dark' : 'light';
  const title = String(options.title || '');
  const sourceUrl = String(options.sourceUrl || '');
  const linkNotes = options.linkNotes !== false;
  const dedupe = options.dedupe !== false;
  const active = edition.kind !== 'plain';
  const recipe = getArticleRecipe(active ? edition.kind : 'book', tone);
  /* 配方（版式+已解析明暗）决定公开颜色；plain 用同明暗纸面色作对照（仍成对可读）。 */
  const palette = publishPalette(recipe, tone);
  /* 正文样式：plain 用旧口径（与改前 copyRich 的 inlineCss 同一批声明）＋成对前景/底色；
     book/report 用配方（article-recipes 的 articleDocumentCss 里的同名声明按标签内联）。 */
  const styles = Object.assign(
    active ? docStylesFor(recipe, palette) : legacyStyles(palette),    publishOnlyStyles(palette),
  );
  const rootStyle = publishRootStyle(palette, active ? {
    'font-family': recipe.bodyFont, 'font-size': recipe.body.size + 'px',
    'line-height': String(recipe.body.line), 'letter-spacing': recipe.body.letter,
    'text-align': recipe.body.align,
  } : {});
  const wechat = wechatArticleHtml(html, { styles, linkNotes, dedupe, sourceUrl: linkNotes ? sourceUrl : '', rootStyle, palette });
  const zhihu = zhihuArticleHtml(html, { styles, rootStyle, palette });
  const links = planExternalLinks(html, { dedupe });
  const documentCss = active
    ? articleDocumentCss(recipe) + '\n' + exportEditionCss(edition.kind, edition.variant === 'follow' ? null : tone)
    : '';
  const documentHtml = active
    ? articleDocument({
      body: applyInlineStyles(html, docStylesFor(recipe, palette)), title,
      css: documentCss, mathCss: options.mathCss || '', kind: edition.kind, variant: tone,
      sourceUrl, palette,
    })
    : '';
  return {
    edition, tone, recipe, active, title,
    documentCss,
    documentHtml,
    wechatHtml: wechat.html,
    zhihuHtml: zhihu.html,
    links,
    summary: articleSummary(html, links),
  };
}

/** 配方 → 按标签名内联的声明表（与 articleDocumentCss 的取值同源：都来自 recipe；
 *  颜色取传入的 palette —— 即用户此刻在界面上看见的颜色快照，而不是配方自带的纸面色）。 */
function docStylesFor(recipe, paletteIn) {
  const c = paletteIn && paletteIn.fg ? paletteIn : recipe.colors;
  const out = {
    p: { margin: '0 0 ' + (recipe.id === 'book' ? '1.15em' : '.9em'), 'text-indent': recipe.body.indent,
      'line-height': String(recipe.body.line), color: c.fg },
    blockquote: {
      margin: recipe.quote.margin, padding: recipe.quote.pad,
      'border-left': recipe.quote.border + ' solid ' + c.quoteBar,
      background: recipe.quote.bg === 'token' ? c.quoteBg : 'transparent', color: c.muted,
      'font-size': recipe.quote.size, 'line-height': String(recipe.quote.line),
      'letter-spacing': recipe.quote.letter,
      'font-family': recipe.quote.italic ? recipe.kaiFont : recipe.bodyFont,
      'font-style': recipe.quote.italic ? 'italic' : 'normal',
    },
    table: {
      width: '100%', 'border-collapse': 'collapse', margin: '1.2em 0',
      'font-size': recipe.table.size,
      'font-variant-numeric': recipe.table.numerals ? 'tabular-nums lining-nums' : 'normal',
    },
    th: {
      'font-weight': String(recipe.table.thWeight), 'text-align': 'left', padding: '.55em .7em',
      'border-top': (recipe.table.grid ? '2px' : '1.4px') + ' solid ' + c.border,
      'border-bottom': '1px solid ' + c.border,
      background: recipe.table.headerBg === 'token' ? c.capsule : 'transparent',
      color: c.heading,
    },
    td: {
      'text-align': 'left', padding: '.5em .7em', 'border-bottom': '1px solid ' + c.border,
      'border-left': recipe.table.grid ? '1px solid ' + c.border : '',
      'border-right': recipe.table.grid ? '1px solid ' + c.border : '',
      color: c.fg,
    },
    pre: {
      margin: '1.1em 0', padding: '12px 14px', background: c.codeBg,
      'border-radius': recipe.code.radius, 'overflow-x': 'auto',
      'font-size': recipe.code.size, 'line-height': '1.7', 'white-space': 'pre-wrap',
      'word-break': 'break-word', 'font-family': recipe.monoFont,
    },
    code: (attrs, parents) => (parents.indexOf('pre') >= 0
      ? { background: 'transparent', padding: '0', 'font-size': '1em', 'font-family': recipe.monoFont }
      : { 'font-family': recipe.monoFont, 'font-size': '.92em', background: c.codeBg, 'border-radius': '3px', padding: '.1em .3em' }),
    ul: { margin: '1em 0 1.15em', 'padding-left': '1.65em' },
    ol: { margin: '1em 0 1.15em', 'padding-left': '1.65em' },
    li: { margin: '.32em 0' },
    hr: { border: '0', 'border-top': '1px solid ' + c.border, width: recipe.hr.width, margin: recipe.hr.margin },
    a: { color: recipe.id === 'book' ? 'inherit' : c.primary, 'text-decoration': 'none',
      'border-bottom': recipe.id === 'book' ? '1px solid ' + c.border : '' },
    strong: { 'font-weight': String(recipe.strongWeight) },
    em: { 'font-family': recipe.kaiFont, 'font-style': 'italic' },
    img: { 'max-width': '100%', height: 'auto' },
    sup: { 'vertical-align': 'super', 'font-size': '.72em', 'line-height': '0' },
  };
  recipe.headings.forEach((h, i) => {
    const d = {
      'font-family': recipe.headingFont, 'font-size': h.size + 'px', 'line-height': String(h.line),
      'font-weight': String(h.weight), 'letter-spacing': h.letter, 'text-align': h.align,
      margin: h.margin, color: h.muted ? c.muted : c.heading,
    };
    if (h.frame) { d.padding = '.55em 0'; d['border-top'] = '1px solid ' + c.border; d['border-bottom'] = '1px solid ' + c.border; }
    if (h.bar) { d['border-left'] = '5px solid ' + c.accent; d['padding-left'] = '12px'; }
    if (h.under) { d['border-bottom'] = '1px solid ' + c.border; d['padding-bottom'] = '.3em'; }
    out['h' + (i + 1)] = d;
  });
  /* 章节编号：真实文本，等宽数字；与标题同色系、略弱。 */
  out['.mp-edition-num'] = {
    'font-family': recipe.uiFont, 'font-weight': recipe.num ? String(recipe.num.weight) : '600',
    'margin-right': recipe.num ? recipe.num.marginRight : '.4em',
    'font-size': recipe.num ? recipe.num.size : '.92em',
    'letter-spacing': '0', color: c.num,
  };
  out['.mp-math-block'] = { margin: '1.2em 0', 'text-align': 'center', 'overflow-x': 'auto' };
  out['.mp-mermaid'] = { margin: '1.2em 0', 'text-align': 'center', 'overflow-x': 'auto' };
  out['.mp-footnotes'] = {
    margin: '2.2em 0 8px', 'padding-top': '12px', 'border-top': '1px solid ' + c.border,
    'font-size': '.88em', color: c.muted,
  };
  out['.mp-footnotes-list'] = { 'padding-left': '1.3em', margin: '0' };
  out['.mp-fn-ref'] = { 'font-size': '.72em', 'vertical-align': 'super', 'line-height': '0' };
  out['.mp-link-notes'] = {
    margin: '2em 0 0', 'padding-top': '12px', 'border-top': '1px solid ' + c.border,
    'font-size': '.84em', color: c.muted,
  };
  out['.mp-link-notes p'] = { margin: '.25em 0', 'text-indent': '0', 'word-break': 'break-all' };
  return out;
}

/** 面板预览用的窄封装：只产出静态文档（不带导出体积的公式样式）。 */
export function previewArticleDocument(options = {}) {
  return buildArticleOutput(options).documentHtml;
}

/**
 * 目标预览页：把**该目标真正会被粘贴出去的那份 HTML** 放进一个没有 MarkPilot CSS 的空白页。
 * 这是唯一能证明"粘到目标编辑器里长什么样"的预览 —— 用导出文档预览微信/知乎，
 * 会把公式的 KaTeX 类样式与版式带进来，看起来永远是对的（实测两个目标 srcdoc 逐字节相同就是这条）。
 */
export function publishPreviewDocument(bodyHtml, { target = 'wechat', title = '' } = {}) {
  const label = target === 'zhihu' ? '知乎（无外部 CSS）' : '微信（无外部 CSS）';
  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
    + '<title>' + escapeHtml(title || label) + '</title>\n'
    + '<style>html,body{margin:0;padding:0;background:#fff;}</style>\n</head>\n<body>\n'
    + '<div style="max-width:690px;margin:0 auto;padding:18px 16px 40px;background:#fff;">\n'
    + String(bodyHtml || '') + '\n</div>\n</body>\n</html>\n';
}
export { docStylesFor, LEGACY_INLINE_STYLES };

export default {
  buildArticleOutput, previewArticleDocument, paletteFromSnapshot, docStylesFor,
  publishPreviewDocument, publishPalette, publishRootStyle,
};
