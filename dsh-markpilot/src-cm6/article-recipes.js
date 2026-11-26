/* article-recipes.js — 「书页 / 研报」两套原创文章配方的**唯一出处**（纯模块，不碰 DOM）。
 *
 * 分工：本文件由配方编码者独占维护；集成侧（编辑器投影 / 导出 / 预览 / 微信 / 知乎）
 * 只通过下面三个函数取值，不读内部值表、不手抄字号与颜色。
 *
 *   getArticleRecipe(recipeId, variant)
 *     recipeId: 'book' | 'report'          未知值回落到 'book'
 *     variant : 'light' | 'dark'           未知值回落到 'light'（'follow' 由调用方先解析）
 *     -> 冻结快照 {
 *          id, label, variant,
 *          colors: { bg, fg, heading, muted, faint, surface, accent, border, rule,
 *                    codeBg, codeFg, quoteBg, quoteFg, quoteBar, tableHeadBg, tableHeadFg,
 *                    tableBorder, zebra, num, link, caption, sel, kw, str, com, typ, snum,
 *                    primary, capsule, num },      // 后三个是与既有调用方对齐的别名
 *          bodyFont, headingFont, monoFont, kaiFont, uiFont,
 *          measure, pad, body, headings[6], quote, table, code, hr, num, strongWeight,
 *          numbering, headingFamily,
 *        }
 *
 *   articleDocumentCss(recipe)  静态文档（导出 / 预览 / PDF）样式：**只**作用在 `.mp-article` 内。
 *   articleEditorCss(recipe)    CM6 编辑面样式：**只**作用在
 *                               [data-mp-article-recipe="…"][data-mp-article-variant="…"] 下。
 *
 * 三款纪律（与 typography.js 同源的那一条）：
 *  1. 投影，不是改写：不碰源码文本、不碰 CM6 事务、不动标题在源码里的偏移；全部是 CSS。
 *  2. 尊重用户字体：编辑面所有 font-family 都写成 var(--mp-type-*, <配方回退>)，
 *     **不用 !important** —— 用户字体设置（font-preferences 的 !important 规则）永远赢；
 *     没有用户设置时才落到配方自带的衬线 / 无衬线字面。
 *  3. 编号只在**真实文本**里出现一次：文档侧 `.mp-edition-num` / `span[data-mp-section]`
 *     画的是集成方已经写进标题里的那串字，本文件**不生成任何 CSS 计数器**（避免重复编号）；
 *     编辑面画的是行属性 data-mp-edition-num 的 attr() 值，同样不加第二个号。
 *
 * 四款配色是**原创**值表（不取既有主题 token），两两不同：
 *   book/light  暖纸 #FBF6EC + 墨褐 #2A241D + 朱砂 #A2402C
 *   book/dark   炭褐 #171411 + 米白 #E8DFD0 + 落霞 #E8A66F
 *   report/light 净白 #FFFFFF + 石墨蓝黑 #1D2530 + 藏青 #0E5A8A
 *   report/dark  深海军蓝 #10151B + 冷白 #DCE4ED + 天青 #6FB6E6
 * 全部正文/次要文字/表头/代码/引文对比度 ≥ 4.5:1（由单测逐条计算，见 tests/article-recipes.test.cjs）。
 *
 * 本文件不使用模板字符串（反引号在 CSS/注释里都是事故源，见 AGENTS 错-42）。
 */

import { chineseNumber, normalizeEdition } from './article-edition.js';

export const ARTICLE_RECIPE_IDS = Object.freeze(['book', 'report']);
export const ARTICLE_RECIPE_VARIANTS = Object.freeze(['light', 'dark']);
export const ARTICLE_RECIPE_LABELS = Object.freeze({ book: '书页', report: '研报' });

/* ── 字面 ─────────────────────────────────────────────────────────────────────
 * 全部包在 var(--mp-type-*, …) 里：用户设了字体就用用户的，没设才落到下面这几组。
 * 注意 var() 的 fallback 可以是逗号列表：外层 --mp-type-body 未设时，整个逗号列表
 * 会成为 font-family 的取值。 */
const BOOK_SERIF = "'Songti SC', 'SimSun', '宋体', 'NSimSun', 'Noto Serif CJK SC', 'Source Han Serif SC', Georgia, serif";
const BOOK_KAI = "var(--mp-type-italic, 'markpilot-kai', 'KaiTi', '楷体', STKaiti, 'Kaiti SC', serif)";
const REPORT_UI = "'Segoe UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', 'Source Han Sans SC', 'Helvetica Neue', Arial, system-ui, sans-serif";
const MONO = "var(--mp-type-code, var(--mp-font-mono, 'SF Mono', 'Cascadia Code', Consolas, 'Courier New', monospace))";

function bodyFontOf(id) {
  if (id === 'report') return 'var(--mp-type-body, ' + REPORT_UI + ')';
  return 'var(--mp-type-body, ' + BOOK_SERIF + ')';
}
/** 逐级标题字面：写作 hN 就认 --mp-type-hN，否则退到正文/配方字面（与 font-preferences 的角色表一致）。 */
function headingFontOf(id, level) {
  const n = Math.max(1, Math.min(6, Math.floor(Number(level) || 1)));
  if (id === 'report') return 'var(--mp-type-h' + n + ', ' + REPORT_UI + ')';
  return 'var(--mp-type-h' + n + ', var(--mp-type-body, ' + BOOK_SERIF + '))';
}

/* ── 四款原创配色 ──────────────────────────────────────────────────────────── */
const PALETTES = Object.freeze({
  book: Object.freeze({
    light: Object.freeze({
      bg: '#FBF6EC', fg: '#2A241D', heading: '#171310', muted: '#6A5D4D', faint: '#75664F',
      surface: '#F4ECDD', accent: '#A2402C', border: '#E2D6C1', rule: '#C9B79A',
      codeBg: '#F1E7D4', codeFg: '#3B3126', quoteBg: '#F6EFE2', quoteFg: '#5C5142', quoteBar: '#B98A64',
      tableHeadBg: '#F0E5D0', tableHeadFg: '#241E17', tableBorder: '#CFBD9F', zebra: '#F7F0E2',
      num: '#8E4A22', link: '#8C3A22', caption: '#61564A',
      sel: 'rgba(162,64,44,.18)', kw: '#6C3F7D', str: '#2D5B36', com: '#6F5E47', typ: '#274F6B', snum: '#8A4A1D',
    }),
    dark: Object.freeze({
      bg: '#171411', fg: '#E8DFD0', heading: '#F7F0E3', muted: '#B7A992', faint: '#9A8C76',
      surface: '#211C17', accent: '#E8A66F', border: '#3B332A', rule: '#5C4E3E',
      codeBg: '#201B16', codeFg: '#E3D8C7', quoteBg: '#241E18', quoteFg: '#CDBEA7', quoteBar: '#A9794F',
      tableHeadBg: '#2A241C', tableHeadFg: '#F3EADA', tableBorder: '#4A4034', zebra: '#1C1814',
      num: '#F0B586', link: '#E8A66F', caption: '#C3B49C',
      sel: 'rgba(232,166,111,.24)', kw: '#D2A8E8', str: '#93D3A6', com: '#9A8B76', typ: '#9CC7E8', snum: '#E8B27A',
    }),
  }),
  report: Object.freeze({
    light: Object.freeze({
      bg: '#FFFFFF', fg: '#1D2530', heading: '#0F1620', muted: '#566273', faint: '#687584',
      surface: '#F5F7FA', accent: '#0E5A8A', border: '#D5DCE5', rule: '#A7B6C6',
      codeBg: '#F3F5F8', codeFg: '#26303B', quoteBg: '#F2F6FA', quoteFg: '#43505F', quoteBar: '#0E5A8A',
      tableHeadBg: '#E9F0F6', tableHeadFg: '#101A24', tableBorder: '#C3CCD8', zebra: '#F8FAFC',
      num: '#0B4C74', link: '#0B4C74', caption: '#4E5C6B',
      sel: 'rgba(14,90,138,.16)', kw: '#6A3D8F', str: '#1F6B3A', com: '#65717F', typ: '#0F4C75', snum: '#8A4E12',
    }),
    dark: Object.freeze({
      bg: '#10151B', fg: '#DCE4ED', heading: '#F1F6FB', muted: '#A2AEBC', faint: '#8793A1',
      surface: '#181F27', accent: '#6FB6E6', border: '#2F3945', rule: '#52616F',
      codeBg: '#171E26', codeFg: '#D7E0EA', quoteBg: '#182028', quoteFg: '#C3CEDA', quoteBar: '#5A9AC4',
      tableHeadBg: '#1D2733', tableHeadFg: '#EEF4FA', tableBorder: '#3F4B58', zebra: '#141B23',
      num: '#9FD1F0', link: '#9FD1F0', caption: '#94A2B2',
      sel: 'rgba(111,182,230,.24)', kw: '#C9A6F0', str: '#8FD8AC', com: '#8A96A5', typ: '#86C5F0', snum: '#E9B072',
    }),
  }),
});

/* ── 排版语言（字号阶 / 行高 / 节奏） ───────────────────────────────────────
 *  headings[].line  文档侧的 unitless line-height；
 *  headings[].lead  编辑面的 px 行高系数（CM6 高度图纪律：行级类禁 margin/padding，
 *                   标题上下的"呼吸"只能由 line-height 承担，所以这里给的是放大的倍数）。 */
const TYPO = Object.freeze({
  book: Object.freeze({
    measure: 688, pad: 30,
    body: Object.freeze({ size: 16, line: 1.95, letter: '.012em', align: 'justify', indent: '2em', weight: 400 }),
    headings: Object.freeze([
      Object.freeze({ size: 26, line: 1.62, lead: 2.45, weight: 600, letter: '.16em', align: 'center', margin: '3em 0 1.6em', frame: true, note: '章题：上下细线＋宽字距' }),
      Object.freeze({ size: 20, line: 1.66, lead: 2.1, weight: 600, letter: '.06em', align: 'left', margin: '2.6em 0 1em', mark: 'dash', note: '节题：朱砂短横' }),
      Object.freeze({ size: 17, line: 1.7, lead: 1.92, weight: 600, letter: '.04em', align: 'left', margin: '2em 0 .8em' }),
      Object.freeze({ size: 16, line: 1.72, lead: 1.82, weight: 600, letter: '.03em', align: 'left', margin: '1.8em 0 .7em' }),
      Object.freeze({ size: 15, line: 1.72, lead: 1.78, weight: 600, letter: '.03em', align: 'left', margin: '1.6em 0 .6em' }),
      Object.freeze({ size: 14, line: 1.74, lead: 1.74, weight: 600, letter: '.08em', align: 'left', margin: '1.4em 0 .5em', muted: true }),
    ]),
    quote: Object.freeze({ size: '.97em', line: 1.9, border: '1.5px', pad: '1.1em 1.4em', margin: '2em 1.6em', bg: 'none', italic: true, letter: '.02em', family: 'kai' }),
    table: Object.freeze({ size: '.94em', thWeight: 600, headerBg: 'none', grid: false, numerals: false }),
    code: Object.freeze({ size: '.86em', radius: '4px' }),
    hr: Object.freeze({ width: '34%', margin: '2.6em auto' }),
    num: null, strongWeight: 600, headingFamily: 'serif', numbering: 'none',
  }),
  report: Object.freeze({
    measure: 800, pad: 32,
    body: Object.freeze({ size: 16, line: 1.78, letter: '0', align: 'left', indent: '0', weight: 400 }),
    headings: Object.freeze([
      Object.freeze({ size: 22, line: 1.5, lead: 2.3, weight: 700, letter: '.01em', align: 'left', margin: '2.4em 0 1em', bar: true, note: '章题：左侧色条' }),
      Object.freeze({ size: 18, line: 1.55, lead: 2.05, weight: 700, letter: '.01em', align: 'left', margin: '2em 0 .8em', under: true, note: '节题：下细线' }),
      Object.freeze({ size: 16, line: 1.6, lead: 1.9, weight: 700, letter: '0', align: 'left', margin: '1.8em 0 .6em' }),
      Object.freeze({ size: 15, line: 1.62, lead: 1.85, weight: 700, letter: '0', align: 'left', margin: '1.6em 0 .55em' }),
      Object.freeze({ size: 14, line: 1.64, lead: 1.8, weight: 700, letter: '0', align: 'left', margin: '1.5em 0 .5em' }),
      Object.freeze({ size: 13, line: 1.7, lead: 1.76, weight: 600, letter: '.06em', align: 'left', margin: '1.4em 0 .5em', muted: true }),
    ]),
    quote: Object.freeze({ size: '.96em', line: 1.78, border: '3px', pad: '.7em 1em', margin: '1.3em 0', bg: 'token', italic: false, letter: '0', family: 'body' }),
    table: Object.freeze({ size: '.93em', thWeight: 700, headerBg: 'token', grid: true, numerals: true }),
    code: Object.freeze({ size: '.86em', radius: '5px' }),
    hr: Object.freeze({ width: '100%', margin: '2em 0' }),
    num: Object.freeze({ family: 'ui', weight: 700, marginRight: '.55em', size: '.92em' }),
    strongWeight: 700, headingFamily: 'ui', numbering: 'chinese',
  }),
});

/* ── 取值 / 归一化 ─────────────────────────────────────────────────────────── */
export function normalizeArticleRecipeId(recipeId) {
  const raw = typeof recipeId === 'string' ? recipeId.trim().toLowerCase() : '';
  return raw === 'report' ? 'report' : 'book';
}
export function normalizeArticleVariant(variant) {
  const raw = typeof variant === 'string' ? variant.trim().toLowerCase() : '';
  return raw === 'dark' ? 'dark' : 'light';
}

function colorsOf(id, tone) {
  const p = PALETTES[id][tone];
  return Object.freeze({
    bg: p.bg, fg: p.fg, heading: p.heading, muted: p.muted, faint: p.faint,
    surface: p.surface, accent: p.accent, border: p.border, rule: p.rule,
    codeBg: p.codeBg, codeFg: p.codeFg, quoteBg: p.quoteBg, quoteFg: p.quoteFg, quoteBar: p.quoteBar,
    tableHeadBg: p.tableHeadBg, tableHeadFg: p.tableHeadFg, tableBorder: p.tableBorder, zebra: p.zebra,
    num: p.num, link: p.link, caption: p.caption,
    sel: p.sel, kw: p.kw, str: p.str, com: p.com, typ: p.typ, snum: p.snum,
    /* 与既有调用方（article-publish / extras）对齐的别名：同一个色，不另起一套值。 */
    primary: p.accent, capsule: p.tableHeadBg,
  });
}

/** 取配方。返回冻结快照（下游只读；要改配方请改值表）。 */
export function getArticleRecipe(recipeId, variant) {
  const id = normalizeArticleRecipeId(recipeId);
  const tone = normalizeArticleVariant(variant);
  const t = TYPO[id];
  const recipe = {
    id, label: ARTICLE_RECIPE_LABELS[id], variant: tone,
    colors: colorsOf(id, tone),
    bodyFont: bodyFontOf(id),
    headingFont: headingFontOf(id, 1),
    monoFont: MONO,
    kaiFont: BOOK_KAI,
    uiFont: REPORT_UI,
    serifFallback: BOOK_SERIF,
    measure: t.measure, pad: t.pad,
    body: { ...t.body },
    headings: t.headings.map((h) => ({ ...h })),
    quote: { ...t.quote }, table: { ...t.table }, code: { ...t.code }, hr: { ...t.hr },
    num: t.num ? { ...t.num } : null,
    strongWeight: t.strongWeight, headingFamily: t.headingFamily, numbering: t.numbering,
  };
  return Object.freeze(recipe);
}

/* ── 序列化小工具 ─────────────────────────────────────────────────────────── */
function cssBlock(selector, decls) {
  const body = (decls || []).filter((d) => typeof d === 'string' && d.trim()).map((d) => d.trim().replace(/;$/, '')).join(';');
  return body ? selector + '{' + body + ';}' : '';
}
function normalizedRecipe(recipe) {
  if (recipe && typeof recipe === 'object' && (recipe.id === 'book' || recipe.id === 'report')) return recipe;
  return getArticleRecipe('book', 'light');
}

/* ── 文档侧（.mp-article）：导出 / 预览 / PDF ─────────────────────────────── */
export function articleDocumentCss(recipe) {
  const r = normalizedRecipe(recipe);
  const c = r.colors;
  const out = [];
  out.push('/* ' + r.label + ' · ' + r.variant + ' · 文档投影：只作用在 .mp-article 内；颜色为具体值（静态页没有主题 token）。 */');
  out.push(cssBlock('.mp-article', [
    'max-width:' + r.measure + 'px', 'margin:0 auto', 'padding:8px ' + r.pad + 'px 64px',
    'font-family:' + r.bodyFont, 'font-size:' + r.body.size + 'px', 'line-height:' + String(r.body.line),
    'letter-spacing:' + r.body.letter, 'text-align:' + r.body.align, 'color:' + c.fg, 'background:' + c.bg,
    'text-autospace:normal', 'word-break:break-word', 'overflow-wrap:break-word',
  ]));
  out.push(cssBlock('.mp-article p', [
    'margin:0 0 ' + (r.id === 'book' ? '1.15em' : '.9em'), 'text-indent:' + r.body.indent,
  ]));
  out.push(cssBlock('.mp-article li p,.mp-article blockquote p,.mp-article td p,.mp-article th p,.mp-article figcaption', ['text-indent:0']));

  r.headings.forEach((h, i) => {
    const lvl = i + 1;
    const decls = [
      'font-family:' + headingFontOf(r.id, lvl),
      'font-size:' + h.size + 'px', 'line-height:' + String(h.line), 'font-weight:' + h.weight,
      'letter-spacing:' + h.letter, 'text-align:' + h.align, 'margin:' + h.margin,
      'color:' + (h.muted ? c.muted : c.heading),
    ];
    if (h.frame) decls.push('padding:.7em 0', 'border-top:1px solid ' + c.rule, 'border-bottom:1px solid ' + c.rule);
    if (h.bar) decls.push('border-left:4px solid ' + c.accent, 'padding-left:14px');
    if (h.under) decls.push('padding-bottom:.35em', 'border-bottom:1px solid ' + c.rule);
    out.push(cssBlock('.mp-article h' + lvl, decls));
    if (h.mark === 'dash') {
      out.push(cssBlock('.mp-article h2::before', [
        'content:""', 'display:block', 'width:2.4em', 'height:2px', 'margin:0 0 .72em',
        'background:' + c.accent, 'border-radius:1px',
      ]));
    }
  });

  /* 章节编号：真实文本只出现一次（集成方已经写进标题），这里只负责观感。
     明确**不用** counter()/counter-increment：那会在已有真实编号上再叠一个号。 */
  out.push(cssBlock('.mp-article .mp-edition-num,.mp-article span[data-mp-section]', [
    'font-family:' + (r.num ? r.uiFont : r.bodyFont),
    'font-weight:' + (r.num ? String(r.num.weight) : '600'),
    'font-size:' + (r.num ? r.num.size : '.92em'),
    'margin-right:' + (r.num ? r.num.marginRight : '.4em'),
    'letter-spacing:0', 'font-variant-numeric:tabular-nums lining-nums', 'color:' + c.num,
  ]));

  out.push(cssBlock('.mp-article blockquote', [
    'margin:' + r.quote.margin, 'padding:' + r.quote.pad,
    'border-left:' + r.quote.border + ' solid ' + c.quoteBar,
    'background:' + (r.quote.bg === 'token' ? c.quoteBg : 'transparent'),
    'color:' + c.quoteFg, 'font-size:' + r.quote.size, 'line-height:' + String(r.quote.line),
    'letter-spacing:' + r.quote.letter,
    'font-family:' + (r.quote.italic ? r.kaiFont : r.bodyFont),
    'font-style:' + (r.quote.italic ? 'italic' : 'normal'),
  ]));

  out.push(cssBlock('.mp-article table', [
    'width:100%', 'border-collapse:collapse', 'margin:1.35em 0', 'font-size:' + r.table.size,
    'font-variant-numeric:' + (r.table.numerals ? 'tabular-nums lining-nums' : 'normal'),
    'border-top:' + (r.table.grid ? '2px' : '1.5px') + ' solid ' + c.tableBorder,
  ]));
  out.push(cssBlock('.mp-article th', [
    'text-align:left', 'vertical-align:bottom', 'font-weight:' + r.table.thWeight,
    'padding:.58em .72em', 'color:' + c.tableHeadFg,
    'background:' + (r.table.headerBg === 'token' ? c.tableHeadBg : 'transparent'),
    'border-bottom:' + (r.table.grid ? '1px' : '1.5px') + ' solid ' + c.tableBorder,
    r.table.grid ? 'border-left:1px solid ' + c.tableBorder : '',
    r.table.grid ? 'border-right:1px solid ' + c.tableBorder : '',
  ]));
  out.push(cssBlock('.mp-article td', [
    'text-align:left', 'vertical-align:top', 'padding:.52em .72em', 'color:' + c.fg,
    'border-bottom:1px solid ' + c.tableBorder,
    r.table.grid ? 'border-left:1px solid ' + c.tableBorder : '',
    r.table.grid ? 'border-right:1px solid ' + c.tableBorder : '',
  ]));
  out.push(cssBlock('.mp-article tbody tr:nth-child(even) td', ['background:' + c.zebra]));
  out.push(cssBlock('.mp-article caption,.mp-article figcaption', [
    'caption-side:bottom', 'margin-top:.6em', 'font-size:.86em', 'color:' + c.caption, 'text-align:left',
  ]));

  out.push(cssBlock('.mp-article ul,.mp-article ol', ['margin:1em 0 1.2em', 'padding-left:1.7em']));
  out.push(cssBlock('.mp-article ol', ['list-style:decimal']));
  out.push(cssBlock('.mp-article ul', ['list-style:disc']));
  out.push(cssBlock('.mp-article li', ['margin:.34em 0']));
  out.push(cssBlock('.mp-article li::marker', ['color:' + (r.id === 'report' ? c.accent : c.muted)]));

  out.push(cssBlock('.mp-article pre', [
    'margin:1.2em 0', 'padding:12px 14px', 'background:' + c.codeBg, 'color:' + c.codeFg,
    'border-radius:' + r.code.radius, 'overflow-x:auto', 'font-size:' + r.code.size, 'line-height:1.72',
    'white-space:pre-wrap', 'word-break:break-word', 'font-family:' + r.monoFont,
  ]));
  out.push(cssBlock('.mp-article code', [
    'font-family:' + r.monoFont, 'font-size:.92em', 'background:' + c.codeBg, 'color:' + c.codeFg,
    'border-radius:3px', 'padding:.1em .32em', 'word-break:break-word',
  ]));
  out.push(cssBlock('.mp-article pre code', ['background:transparent', 'color:inherit', 'padding:0', 'font-size:1em']));

  out.push(cssBlock('.mp-article img', ['max-width:100%', 'height:auto']));
  out.push(cssBlock('.mp-article hr', ['border:0', 'border-top:1px solid ' + c.rule, 'width:' + r.hr.width, 'margin:' + r.hr.margin]));
  out.push(cssBlock('.mp-article a', [
    'color:' + (r.id === 'book' ? 'inherit' : c.link), 'text-decoration:none',
    r.id === 'book' ? 'border-bottom:1px solid ' + c.rule : 'border-bottom:1px solid transparent',
  ]));
  out.push(cssBlock('.mp-article strong', ['font-weight:' + r.strongWeight]));
  out.push(cssBlock('.mp-article em', ['font-family:' + r.kaiFont, 'font-style:italic']));
  out.push(cssBlock('.mp-article sup,.mp-article sub', ['font-size:.72em', 'line-height:0']));

  out.push(cssBlock('.mp-article .mp-math-block', ['margin:1.3em 0', 'text-align:center', 'overflow-x:auto']));
  out.push(cssBlock('.mp-article .mp-mermaid', ['margin:1.3em 0', 'text-align:center', 'overflow-x:auto']));
  out.push(cssBlock('.mp-article .mp-mermaid svg', ['max-width:100%', 'height:auto']));

  /* 脚注（footnote-export.js 的产物结构）。 */
  out.push(cssBlock('.mp-article .mp-footnotes', [
    'margin:2.4em 0 8px', 'padding-top:14px', 'border-top:1px solid ' + c.rule,
    'font-size:.88em', 'line-height:1.7', 'color:' + c.muted,
  ]));
  out.push(cssBlock('.mp-article .mp-footnotes-sep', ['display:none']));
  out.push(cssBlock('.mp-article .mp-footnotes-list', ['padding-left:1.35em', 'margin:0']));
  out.push(cssBlock('.mp-article .mp-footnotes-list li', ['margin:0 0 .5em']));
  out.push(cssBlock('.mp-article .mp-fn-ref', ['font-size:.72em', 'vertical-align:super', 'line-height:0']));
  out.push(cssBlock('.mp-article .mp-fn-ref-link', ['color:' + c.num, 'text-decoration:none']));
  out.push(cssBlock('.mp-article .mp-fn-text', ['color:' + c.fg]));
  out.push(cssBlock('.mp-article .mp-fn-back', ['color:' + c.muted, 'text-decoration:none']));

  /* 文末外链清单 / 「原文」行（微信/知乎投影共用这套类名）。 */
  out.push(cssBlock('.mp-article .mp-link-notes', [
    'margin:2.2em 0 0', 'padding-top:14px', 'border-top:1px solid ' + c.rule,
    'font-size:.84em', 'line-height:1.7', 'color:' + c.muted,
  ]));
  out.push(cssBlock('.mp-article .mp-link-notes p', ['margin:.28em 0', 'text-indent:0', 'word-break:break-all']));
  out.push(cssBlock('.mp-article .mp-link-num', ['color:' + c.num, 'font-variant-numeric:tabular-nums']));
  out.push(cssBlock('.mp-article .mp-link-url', ['color:' + c.faint]));
  out.push(cssBlock('.mp-article .mp-origin', ['margin:1.8em 0 0', 'font-size:.86em', 'color:' + c.muted]));

  /* 纸面：暗色版式在纸上不可读，打印一律回到白纸黑字（版式的字号阶/间距/表格规则保留）。 */
  out.push('@media print{'
    + '.mp-article{max-width:none;padding:0;background:#fff;color:#111;}'
    + '.mp-article p,.mp-article li,.mp-article td,.mp-article th,.mp-article blockquote{color:#111;}'
    + '.mp-article h1,.mp-article h2,.mp-article h3,.mp-article h4,.mp-article h5,.mp-article h6{color:#000;break-after:avoid;page-break-after:avoid;}'
    + '.mp-article pre,.mp-article blockquote,.mp-article table,.mp-article tr,.mp-article img{break-inside:avoid;page-break-inside:avoid;}'
    + '.mp-article td,.mp-article th{border-color:#999;}'
    + '}');
  return out.join('\n');
}

/* ── 编辑面（CM6）：只认 [data-mp-article-recipe][data-mp-article-variant] ── */
export function articleEditorCss(recipe) {
  const r = normalizedRecipe(recipe);
  const c = r.colors;
  const scope = '[data-mp-article-recipe="' + r.id + '"][data-mp-article-variant="' + r.variant + '"]';
  const content = scope + ' .cm-content';
  const out = [];
  out.push('/* ' + r.label + ' · ' + r.variant + ' · 编辑面投影（源码零改动；编号来自行属性 attr()，不写计数器）。 */');

  /* 纸面：html/body 的底色与编辑器同色（否则滚动到尽头会露出主题底色的一条边）。 */
  out.push(cssBlock('html' + scope + ',html' + scope + ' body', ['background:' + c.bg]));

  /* token 落在 .cm-editor 上（它才是 .cm-scroller/.cm-content 的祖先）：
     这样 .cm-editor 自己的 background:var(--mp-bg) 就能拿到配方纸色，而不是主题色。 */
  out.push(cssBlock(scope + ' .cm-editor', [
    '--mp-bg:' + c.bg, '--mp-fg:' + c.fg, '--mp-heading:' + c.heading, '--mp-muted:' + c.muted,
    '--mp-faint:' + c.faint, '--mp-border:' + c.border, '--mp-codeBg:' + c.codeBg,
    '--mp-capsule:' + c.tableHeadBg, '--mp-quoteBg:' + c.quoteBg, '--mp-quoteBar:' + c.quoteBar,
    '--mp-primary:' + c.accent, '--mp-sel:' + c.sel,
    '--mp-kw:' + c.kw, '--mp-str:' + c.str, '--mp-com:' + c.com, '--mp-num:' + c.snum, '--mp-typ:' + c.typ,
    '--mp-article-bg:' + c.bg, '--mp-article-fg:' + c.fg, '--mp-article-accent:' + c.accent,
    '--mp-article-rule:' + c.rule, '--mp-article-surface:' + c.surface, '--mp-article-num:' + c.num,
    'background:' + c.bg, 'color:' + c.fg,
  ]));
  out.push(cssBlock(scope + ' .cm-scroller', ['background:' + c.bg, 'color:' + c.fg]));
  out.push(cssBlock(scope + ' .cm-gutters', ['background:' + c.bg, 'color:' + c.faint]));

  /* 正文版式：字体用 var(--mp-type-body, 配方字面) 且不加 !important —— 用户字体设置优先。 */
  out.push(cssBlock(content, [
    'font-family:' + r.bodyFont, 'font-size:' + r.body.size + 'px', 'line-height:' + String(r.body.line),
    'letter-spacing:' + r.body.letter, 'text-align:' + r.body.align,
    'color:' + c.fg, 'background:' + c.bg, 'caret-color:' + c.accent, 'text-autospace:normal',
  ]));

  /* 标题行：字号/字重/字距/字面；呼吸全靠 line-height（CM6 高度图纪律，禁 margin）。 */
  r.headings.forEach((h, i) => {
    const lvl = i + 1;
    const decls = [
      'font-family:' + headingFontOf(r.id, lvl),
      'font-size:' + h.size + 'px', 'line-height:' + Math.round(h.size * h.lead) + 'px',
      'font-weight:' + h.weight, 'letter-spacing:' + h.letter, 'text-align:' + h.align,
      'color:' + (h.muted ? 'var(--mp-muted)' : 'var(--mp-heading)'),
    ];
    if (h.frame) decls.push('border-top:1px solid var(--mp-article-rule)', 'border-bottom:1px solid var(--mp-article-rule)');
    if (h.bar) decls.push('border-left:4px solid ' + c.accent, 'padding-left:12px');
    if (h.under) decls.push('border-bottom:1px solid var(--mp-article-rule)');
    out.push(cssBlock(content + ' .cm-line.mp-h' + lvl, decls));
  });

  /* 「H1…H6」徽标：只隐藏**没有编号**的标题行。
     为什么必须带 :not([data-mp-edition-num])：徽标隐藏规则与编号规则曾同为 ::before，
     徽标那条类/属性更多 ⇒ 编号被 display:none 吃掉（真实复现：研报二级章节眼前无号）。
     两条规则改成互斥选择器后，编号行永远走下面那条，不再靠特异度抢。 */
  out.push(cssBlock(content + ' :is(.mp-h1,.mp-h2,.mp-h3,.mp-h4,.mp-h5,.mp-h6):not([data-mp-edition-num])::before',
    ['content:""', 'display:none']));

  /* 章节编号（**只有研报**）：内容是行属性里的真实文本，横向一整串、与章题同基线、不裁切、不顶字。
     【踩过的三种形态·2026-11-25 实拍】
       ① left:-46px + width:40px + text-align:right：40px 装不下「（一）」三个全角字 ⇒
          中文在伪元素里折成两行；46px 又超过正文列预留的 24px 留白 ⇒ 「一、」只剩一个顿号。
       ② 改成 top:0 + width:max-content 后横排了，但**引擎那条标题 ::before 规则还带着
          top:50% + transform:translateY(-50%) + left:-30px**：它们写在同一个伪元素上 ⇒
          top:0 被 translateY(-50%) 整个抬起半个行高
          （实测 h1::before height:51px、matrix(1,0,0,1,0,-25.5) ⇒ 号高出标题半行、贴在标题上横线上）；
          同时 left:-30px 让宽号从 -30px 往右长，**侵入标题文字**。
     正解（不改源码、不动光标偏移，全部在行盒的悬挂位上做）：
       · 显式 transform:none + top:0 + left:auto + right —— 把引擎那三条**逐条覆盖**；
       · 编号右缘钉在 gutter 内侧 6px，gutter 由**行自身的 padding-left** 提供 ⇒ 号永远在行盒
         之内，窄屏（390px）也不会被 .cm-scroller 的左缘裁掉；
       · width:max-content + text-align:right + white-space:nowrap：号越长越往左长，
         极端长的号最多溢进正文列的 24px 留白（仍然可见），绝不会顶到标题文字上；
       · line-height:inherit + top:0：伪元素的行高与标题行盒相同 ⇒ 两者**同一基线**。 */
  if (r.numbering === 'chinese') {
    const numSelector = content + ' .cm-line:is(.mp-h1,.mp-h2,.mp-h3,.mp-h4,.mp-h5,.mp-h6)[data-mp-edition-num]';
    /* gutter 用绝对 px：H1 与 H6 的号要对在同一条竖轴上，且 390px 下不能因字号缩放挤掉正文。 */
    const gutter = 'var(--mp-article-gutter, 76px)';
    const shortGutter = 'var(--mp-article-gutter-short, 56px)';
    out.push(cssBlock(numSelector, ['position:relative', 'padding-left:' + gutter]));
    out.push(cssBlock(content + ' .cm-line:is(.mp-h3,.mp-h4,.mp-h5,.mp-h6)[data-mp-edition-num]',
      ['padding-left:' + shortGutter]));
    const numDecls = [
      'content:attr(data-mp-edition-num)',
      'position:absolute', 'left:auto', 'right:calc(100% - (' + gutter + ' - 6px))', 'top:0', 'bottom:auto',
      /* 这五条是与引擎那条标题 ::before 的**正面冲突点**，缺一条就错位/侵入。 */
      'transform:none', 'margin:0', 'padding:0',
      'width:max-content', 'max-width:none', 'min-width:0',
      'white-space:nowrap', 'overflow-wrap:normal', 'word-break:keep-all',
      'text-align:right', 'text-indent:0', 'overflow:visible',
      'display:block', 'box-sizing:border-box',
      /* 与章题同一基线：行高继承行盒，绝不自己抬 top。字体也**不写**（继承所在标题行）。 */
      'line-height:inherit',
      'font-weight:' + (r.num ? String(r.num.weight) : '600'),
      'font-size:' + (r.num ? r.num.size : '.86em'),
      'letter-spacing:0', 'font-variant-numeric:tabular-nums lining-nums',
      'font-style:normal', 'text-transform:none',
      'color:' + c.num, 'opacity:.95', 'pointer-events:none', 'user-select:none',
    ];
    out.push(cssBlock(numSelector + '::before', numDecls));
    /* 三级以下：右缘跟着短 gutter 走（换变量，仍是同一张值表）。 */
    out.push(cssBlock(content + ' .cm-line:is(.mp-h3,.mp-h4,.mp-h5,.mp-h6)[data-mp-edition-num]::before',
      ['right:calc(100% - (' + shortGutter + ' - 6px))']));
  }

  /* 引文行：书页是楷体斜体无底色；研报是正文体＋浅色块。代码行/围栏行不套引文字色与字号。 */
  out.push(cssBlock(content + ' .cm-line.mp-quote', [
    'border-left:' + r.quote.border + ' solid var(--mp-quoteBar)',
    'color:' + (r.id === 'book' ? 'var(--mp-muted)' : 'var(--mp-fg)'),
    'font-size:' + r.quote.size, 'line-height:' + String(r.quote.line),
    'letter-spacing:' + r.quote.letter, 'padding-left:' + (r.quote.border === '1.5px' ? '1.1em' : '.9em'),
  ]));
  if (r.quote.italic) {
    out.push(cssBlock(content + ' .cm-line.mp-quote:not(.mp-code)', ['font-family:' + r.kaiFont, 'font-style:italic']));
  }
  out.push(cssBlock(content + ' .cm-line.mp-quote::before', ['background:' + (r.quote.bg === 'token' ? 'var(--mp-quoteBg)' : 'none')]));
  out.push(cssBlock(content + ' .cm-line.mp-quote:not(.mp-code) em', ['font-style:inherit']));
  /* 代码行保留等宽与用户代码字体，只换底色与字色（源码/公式原样，不重排）。 */
  out.push(cssBlock(content + ' .cm-line.mp-code', ['background:none', 'color:var(--mp-fg)']));
  out.push(cssBlock(content + ' .cm-line.mp-code::after', ['background:var(--mp-codeBg)']));

  /* 表格：表头底色/字色、网格线、数字列等宽数字（研报）。 */
  out.push(cssBlock(content + ' table.mp-row', ['border-top:' + (r.table.grid ? '2px' : '1.5px') + ' solid ' + c.tableBorder]));
  out.push(cssBlock(content + ' table.mp-row th', [
    'background:' + (r.table.headerBg === 'token' ? c.tableHeadBg : 'transparent'),
    'color:' + c.tableHeadFg, 'font-weight:' + r.table.thWeight,
    'border-top:' + (r.table.grid ? '2px' : '1.5px') + ' solid ' + c.tableBorder,
    'border-bottom:1px solid ' + c.tableBorder,
    r.table.grid ? 'border-left:1px solid ' + c.tableBorder : '',
    r.table.grid ? 'border-right:1px solid ' + c.tableBorder : '',
  ]));
  out.push(cssBlock(content + ' table.mp-row td', [
    'color:' + c.fg, 'border-bottom:1px solid ' + c.tableBorder,
    'border-left:' + (r.table.grid ? '1px' : '0') + ' solid ' + c.tableBorder,
    'border-right:' + (r.table.grid ? '1px' : '0') + ' solid ' + c.tableBorder,
    r.table.numerals ? 'font-variant-numeric:tabular-nums lining-nums' : '',
  ]));
  out.push(cssBlock(content + ' .mp-table-wrap', ['background:' + (r.table.headerBg === 'token' ? c.bg : 'transparent')]));

  /* 列表标记 / 分隔线 / 强调：随配方走，不动源码。 */
  out.push(cssBlock(content + ' .mp-bullet', ['color:' + (r.id === 'report' ? c.accent : c.muted)]));
  out.push(cssBlock(content + ' .mp-ordered', ['color:' + (r.id === 'report' ? c.accent : c.muted), 'font-variant-numeric:tabular-nums']));
  out.push(cssBlock(content + ' .cm-line.mp-hr', ['border-bottom:1px solid ' + c.rule]));
  out.push(cssBlock(content + ' .cm-line.mp-fence', ['color:' + c.faint]));
  out.push(cssBlock(content + ' .mp-frontmatter-preview', ['background:' + c.surface, 'border-color:' + c.border, 'color:' + c.fg]));
  /* 公式 / 图表：只保证字色与底色，不碰 KaTeX 自己的排版（源与偏移都不动）。 */
  out.push(cssBlock(content + ' :is(.mp-cm6-math,.mp-cm6-math-block,.katex)', ['color:' + c.fg]));
  out.push(cssBlock(content + ' .mp-mermaid svg', ['background:transparent']));
  return out.join('\n');
}

export default { getArticleRecipe, articleDocumentCss, articleEditorCss };

/* 兼容既有引用：这两个纯函数原本从这里再导出（article-edition 是它们的真源）。 */
export { chineseNumber, normalizeEdition };
