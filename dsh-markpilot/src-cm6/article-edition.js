/* article-edition.js — 「书页」「研报」两套原创文章版式的**唯一配方**（纯模块，不碰 DOM）。
 *
 * 纪律（与 typography.js 同一条）：
 *   · 一张值表，三种出口：CM6 编辑面 CSS、静态 HTML/PDF 导出 CSS、发布（微信/知乎）内联样式；
 *   · 出口只做"选择器适配"，**不许**各自再手抄一套字号/边距；
 *   · 版式是**投影**：不改源码、不进撤销栈、不动标题在源码里的偏移；
 *     章节编号在编辑面挂在行装饰的 data 属性上（走既有的 46px 悬挂位），在导出/发布件里是**真实文本**；
 *   · 颜色一律取既有主题 token（--mp-*），导入的 Typora 主题与自定义字体继续生效；
 *   · 明暗三档：follow（跟随界面）/ light / dark。follow 在导出时按**导出那一刻**的界面明暗解析。
 *
 * 本文件不使用模板字符串（避免反引号/`$` 被解释类问题；见 AGENTS 错-42）。
 */

import { MP_TYPO } from './typography.js';

export const EDITION_STORAGE_KEY = 'mp-edition';
export const EDITION_KINDS = Object.freeze(['book', 'report']);
export const EDITION_VARIANTS = Object.freeze(['follow', 'light', 'dark']);
export const EDITION_DEFAULT = Object.freeze({ kind: 'plain', variant: 'follow' });

export const EDITION_LABELS = Object.freeze({
  plain: '默认（宋韵）',
  book: '书页',
  report: '研报',
});
export const EDITION_VARIANT_LABELS = Object.freeze({
  follow: '跟随界面',
  light: '浅色',
  dark: '深色',
});

/** 版式说明（设置面板与发布面板共用文案）。 */
export const EDITION_DESCRIPTIONS = Object.freeze({
  plain: '沿用现有宋韵排版：字号阶、标题下边线、楷体斜体与现有配色全部不变。',
  book: '中文衬线正文、首行缩进、居中章节题与细线框、无底色楷体引文，适合随笔、散文与长文阅读。',
  report: '无衬线章节题、真实章节编号、网格表头与等宽数字，适合调研、复盘与需要引用表格的文章。',
});

/** 纸面色 token（显式明暗时使用；跟随界面时不覆盖主题）。 */
export const EDITION_PAPERS = Object.freeze({
  light: Object.freeze({
    bg: '#FFFFFF', fg: '#1F2328', heading: '#11161D', muted: '#57606A', faint: '#8B949E',
    border: '#D6DCE3', codeBg: '#F5F7F9', capsule: '#EEF1F4', quoteBg: '#F5F6F7', quoteBar: '#C6CFD8',
    primary: '#0B65C2', sel: 'rgba(11,101,194,.22)', kw: '#7A3E9D', str: '#1A6B3C', com: '#6C7784',
    num: '#9A5B12', typ: '#0B4F8A',
  }),
  dark: Object.freeze({
    bg: '#1B1E24', fg: '#D7DBE1', heading: '#F1F4F8', muted: '#9BA4AF', faint: '#6E7781',
    border: '#343B45', codeBg: '#20252D', capsule: '#242A33', quoteBg: '#232830', quoteBar: '#4A525D',
    primary: '#5EA8F2', sel: 'rgba(94,168,242,.26)', kw: '#C9A0F5', str: '#7BD8A5', com: '#8A939E',
    num: '#E0A45E', typ: '#79C0FF',
  }),
});

/** 中文数字（章节编号用；到千位足够）。 */
export function chineseNumber(n) {
  const value = Math.floor(Number(n) || 0);
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (value <= 0) return String(value);
  if (value < 10) return digits[value];
  if (value < 20) return '十' + (value % 10 ? digits[value % 10] : '');
  if (value < 100) return digits[Math.floor(value / 10)] + '十' + (value % 10 ? digits[value % 10] : '');
  if (value < 1000) {
    const rest = value % 100;
    const head = digits[Math.floor(value / 100)] + '百';
    if (!rest) return head;
    if (rest < 10) return head + '零' + digits[rest];
    if (rest < 20) return head + '一十' + (rest % 10 ? digits[rest % 10] : '');
    return head + digits[Math.floor(rest / 10)] + '十' + (rest % 10 ? digits[rest % 10] : '');
  }
  return String(value);
}

/** 版式配置归一化：未知值一律退回默认（旧设置/脏 localStorage 自愈）。 */
export function normalizeEdition(input) {
  let value = input;
  if (typeof value === 'string') value = { kind: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EDITION_DEFAULT };
  const rawKind = typeof value.kind === 'string' ? value.kind.trim().toLowerCase() : '';
  const kind = EDITION_KINDS.indexOf(rawKind) >= 0 ? rawKind : 'plain';
  const rawVariant = typeof value.variant === 'string' ? value.variant.trim().toLowerCase() : '';
  const variant = EDITION_VARIANTS.indexOf(rawVariant) >= 0 ? rawVariant : 'follow';
  return { kind, variant };
}

/** 读持久设置（接受注入的 storage；坏值不抛错，退回默认）。 */
export function readStoredEdition(storage) {
  try {
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return { ...EDITION_DEFAULT };
    const raw = store.getItem(EDITION_STORAGE_KEY);
    if (!raw) return { ...EDITION_DEFAULT };
    let parsed = raw;
    try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    return normalizeEdition(parsed);
  } catch { return { ...EDITION_DEFAULT }; }
}

/** follow ⇒ 按界面明暗解析；显式档原样返回。 */
export function resolveEditionTone(edition, isDark) {
  const e = normalizeEdition(edition);
  if (e.variant === 'light' || e.variant === 'dark') return e.variant;
  return isDark ? 'dark' : 'light';
}

/** 版式是否真的在投影（plain 不产生任何 CSS/编号）。 */
export function editionActive(edition) {
  return normalizeEdition(edition).kind !== 'plain';
}

/* ── 章节编号：研报真实编号（导出/发布件里是文本；编辑面是行属性） ─────────────
 * 一、 / （一） / 1. / (1) / 1) / 无
 * 计数规则：本级 +1、更深层归零；一级/二级用中文数字，三级以下用阿拉伯数字。 */
export function editionNumbering(kind) {
  const scheme = normalizeEdition({ kind }).kind === 'report' ? 'report' : 'none';
  const counters = [0, 0, 0, 0, 0, 0];
  const next = (level) => {
    const l = Math.max(1, Math.min(6, Math.floor(Number(level) || 1)));
    if (scheme === 'none') return '';
    counters[l - 1] += 1;
    for (let i = l; i < counters.length; i++) counters[i] = 0;
    const n = counters[l - 1];
    if (l === 1) return (n < 1000 ? chineseNumber(n) : String(n)) + '、';
    if (l === 2) return '（' + chineseNumber(n) + '）';
    if (l === 3) return n + '.';
    if (l === 4) return '(' + n + ')';
    if (l === 5) return n + ')';
    return '';
  };
  return {
    kind: scheme === 'report' ? 'report' : 'plain',
    scheme,
    next,
    counters: () => counters.slice(),
    reset: () => { for (let i = 0; i < counters.length; i++) counters[i] = 0; },
  };
}

/* ── 值表：两款版式的排版语言（字号/行高/间距/字重/字距/结构） ───────────────── */
export const EDITION_RECIPES = Object.freeze({
  book: Object.freeze({
    id: 'book',
    name: '书页',
    measure: 660,
    pad: 26,
    body: { size: 16, line: 1.95, letter: '.012em', align: 'justify', indent: '2em', weight: 400 },
    headings: Object.freeze([
      { size: 26, line: 1.55, weight: 600, letter: '.08em', align: 'center', margin: '2.6em 0 1.4em', frame: true },
      { size: 20, line: 1.6, weight: 600, letter: '.04em', align: 'left', margin: '2.2em 0 .9em' },
      { size: 17, line: 1.65, weight: 600, letter: '.03em', align: 'left', margin: '1.8em 0 .7em' },
      { size: 16, line: 1.7, weight: 600, letter: '.02em', align: 'left', margin: '1.5em 0 .6em' },
      { size: 15, line: 1.7, weight: 600, letter: '.02em', align: 'left', margin: '1.35em 0 .55em' },
      { size: 14, line: 1.7, weight: 600, letter: '.04em', align: 'left', margin: '1.3em 0 .5em' },
    ]),
    quote: { size: '.97em', line: 1.85, border: '2px', pad: '1.1em', margin: '1.6em 2em', bg: 'none', italic: true, letter: '.02em', family: 'kai' },
    table: { size: '.94em', thWeight: 600, headerBg: 'none', grid: false, numerals: false },
    code: { size: '.86em', radius: '4px' },
    hr: { width: '30%', margin: '2.4em auto' },
    num: null,
    headingFamily: 'body',
    strongWeight: 600,
  }),
  report: Object.freeze({
    id: 'report',
    name: '研报',
    measure: 780,
    pad: 28,
    body: { size: 16, line: 1.78, letter: '0', align: 'left', indent: '0', weight: 400 },
    headings: Object.freeze([
      { size: 22, line: 1.45, weight: 700, letter: '.01em', align: 'left', margin: '2.2em 0 .9em', bar: true },
      { size: 18, line: 1.5, weight: 700, letter: '.01em', align: 'left', margin: '1.9em 0 .7em', under: true },
      { size: 16, line: 1.55, weight: 700, letter: '0', align: 'left', margin: '1.6em 0 .6em' },
      { size: 15, line: 1.6, weight: 700, letter: '0', align: 'left', margin: '1.5em 0 .5em' },
      { size: 14, line: 1.6, weight: 700, letter: '0', align: 'left', margin: '1.4em 0 .5em' },
      { size: 14, line: 1.6, weight: 600, letter: '.02em', align: 'left', margin: '1.3em 0 .5em', muted: true },
    ]),
    quote: { size: '.95em', line: 1.75, border: '3px', pad: '.6em 1em', margin: '1.2em 0', bg: 'token', italic: false, letter: '0', family: 'body' },
    table: { size: '.92em', thWeight: 700, headerBg: 'token', grid: true, numerals: true },
    code: { size: '.87em', radius: '5px' },
    hr: { width: '100%', margin: '2em 0' },
    num: { family: 'ui', weight: 700, marginRight: '.5em', size: '.95em' },
    headingFamily: 'ui',
    strongWeight: 700,
  }),
});

export function editionRecipe(kind) {
  const k = normalizeEdition({ kind }).kind;
  return EDITION_RECIPES[k] || null;
}

/* ── 样式表生成（唯一值表的两种序列化） ───────────────────────────────────── */

const UI_FONT = "'Segoe UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', 'Source Han Sans SC', system-ui, sans-serif";
const KAI_FONT = "var(--mp-type-italic, 'markpilot-kai'), var(--mp-font-latin), serif";
const BODY_FONT = 'var(--mp-type-body, var(--mp-font-body))';

function headingFont(recipe) {
  return recipe.headingFamily === 'ui' ? UI_FONT : BODY_FONT;
}

/** 导出页/预览页的主题值：follow 用快照 token，显式明暗用纸面色 token。 */
function exportTheme(tone) {
  if (tone === 'light' || tone === 'dark') {
    const p = EDITION_PAPERS[tone];
    return {
      bg: p.bg, fg: p.fg, heading: p.heading, muted: p.muted, border: p.border, codeBg: p.codeBg,
      capsule: p.capsule, quoteBg: p.quoteBg, quoteBar: p.quoteBar, primary: p.primary,
      accent: p.primary, num: p.primary, explicit: true, paper: p,
    };
  }
  return {
    bg: 'var(--mp-bg)', fg: 'var(--mp-fg)', heading: 'var(--mp-heading)', muted: 'var(--mp-muted)',
    border: 'var(--mp-border)', codeBg: 'var(--mp-codeBg)', capsule: 'var(--mp-capsule)',
    quoteBg: 'var(--mp-quoteBg)', quoteBar: 'var(--mp-quoteBar)', primary: 'var(--mp-primary)',
    accent: 'var(--mp-primary)', num: 'var(--mp-primary)', explicit: false, paper: null,
  };
}

/** 编辑面：纸面 token 覆盖（只在显式明暗时；跟随界面时完全交给现有主题）。 */
function editorPaperCss() {
  const out = [];
  for (const tone of ['light', 'dark']) {
    const p = EDITION_PAPERS[tone];
    const decls = [
      '--mp-bg:' + p.bg, '--mp-fg:' + p.fg, '--mp-heading:' + p.heading, '--mp-muted:' + p.muted,
      '--mp-faint:' + p.faint, '--mp-border:' + p.border, '--mp-codeBg:' + p.codeBg,
      '--mp-capsule:' + p.capsule, '--mp-quoteBg:' + p.quoteBg, '--mp-quoteBar:' + p.quoteBar,
      '--mp-primary:' + p.primary, '--mp-sel:' + p.sel, '--mp-kw:' + p.kw, '--mp-str:' + p.str,
      '--mp-com:' + p.com, '--mp-num:' + p.num, '--mp-typ:' + p.typ,
    ];
    out.push('html[data-mp-edition][data-mp-edition-paper="' + tone + '"] .cm-content{'
      + decls.join(';') + ';background:var(--mp-bg);}');
    out.push('html[data-mp-edition][data-mp-edition-paper="' + tone + '"] .cm-content .cm-gutters{background:var(--mp-bg);}');
  }
  return out.join('\n');
}

/** 编辑面 CSS：选择器只认 `.cm-content` 内的行类/表格类；数值与导出同一张值表。 */
export function editorEditionCss() {
  const out = [editorPaperCss()];
  /* 普通版式：删掉 H1..H6 徽标上的字母，给章节编号让出同一条悬挂位。 */
  out.push('html[data-mp-edition] .cm-content .cm-line[class*="mp-h"]::before{content:"";width:0;height:0;}');
  out.push('html[data-mp-edition="report"] .cm-content .cm-line[data-mp-edition-num]::before{'
    + 'content:attr(data-mp-edition-num);position:absolute;left:-46px;width:40px;text-align:right;'
    + 'top:.62em;transform:none;font:700 12px/1.4 var(--mp-font-latin,Georgia,serif);color:var(--mp-primary);'
    + 'opacity:.92;pointer-events:none;}');
  out.push('html[data-mp-edition="report"] .cm-content .cm-line[class*="mp-h"]{position:relative;}');

  for (const kind of EDITION_KINDS) {
    const r = EDITION_RECIPES[kind];
    const scope = 'html[data-mp-edition="' + kind + '"] .cm-content';
    out.push(scope + '{font-size:' + r.body.size + 'px;line-height:' + r.body.line + ';letter-spacing:'
      + r.body.letter + ';text-align:' + r.body.align + ';}');
    r.headings.forEach((h, i) => {
      const lvl = i + 1;
      const decls = [
        'font-size:' + h.size + 'px',
        'line-height:' + Math.round(h.size * (kind === 'book' ? 1.62 : 1.55)) + 'px',
        'font-weight:' + h.weight,
        'letter-spacing:' + h.letter,
        'text-align:' + h.align,
        'font-family:' + headingFont(r),
      ];
      if (h.frame) { decls.push('border-top:1px solid var(--mp-border)', 'border-bottom:1px solid var(--mp-border)'); }
      if (h.bar) decls.push('border-left:5px solid var(--mp-primary)', 'padding-left:12px');
      if (h.under) { decls.push('border-bottom:1px solid var(--mp-border)'); }
      if (h.muted) decls.push('color:var(--mp-muted)');
      out.push(scope + ' .cm-line.mp-h' + lvl + '{' + decls.join(';') + ';}');
    });
    const q = r.quote;
    out.push(scope + ' .cm-line.mp-quote{border-left:' + q.border + ' solid var(--mp-quoteBar);'
      + 'background:none;color:var(--mp-muted);font-size:' + q.size + ';line-height:' + q.line + ';'
      + 'letter-spacing:' + q.letter + ';'
      + (q.italic ? 'font-family:' + KAI_FONT + ';font-style:italic;' : 'font-family:' + BODY_FONT + ';')
      + 'padding-left:' + q.pad + ';}');
    out.push(scope + ' .cm-line.mp-quote::before{background:' + (q.bg === 'token' ? 'var(--mp-quoteBg)' : 'none') + ';}');
    const t = r.table;
    out.push(scope + ' table.mp-row th{background:' + (t.headerBg === 'token' ? 'var(--mp-capsule)' : 'transparent') + ';'
      + 'font-weight:' + t.thWeight + ';border-top:' + (t.grid ? '2px' : '1.4px') + ' solid var(--mp-border);'
      + 'border-bottom:1px solid var(--mp-border);}');
    out.push(scope + ' table.mp-row td{border-left:' + (t.grid ? '1px' : '0') + ' solid var(--mp-border);'
      + 'border-right:' + (t.grid ? '1px' : '0') + ' solid var(--mp-border);'
      + 'border-bottom:1px solid var(--mp-border);'
      + (t.numerals ? 'font-variant-numeric:tabular-nums lining-nums;' : '') + '}');
    out.push(scope + ' .mp-row .mp-cell-code{font-size:' + r.code.size + ';}');
    out.push(scope + ' strong{font-weight:' + r.strongWeight + ';}');
    if (r.num) {
      out.push('html[data-mp-edition="report"] .cm-content .mp-edition-inline-num{font-family:' + UI_FONT + ';font-weight:' + r.num.weight + ';}');
    }
  }
  return out.join('\n');
}

/** 导出/预览 CSS：静态页（**不得出现 .cm- 选择器**）。tone=null ⇒ 跟随快照 token。 */
export function exportEditionCss(kind, tone) {
  const k = normalizeEdition({ kind }).kind;
  if (k === 'plain') return '';
  const r = EDITION_RECIPES[k];
  const t = exportTheme(tone === 'light' || tone === 'dark' ? tone : null);
  const out = [];
  if (t.explicit) {
    const p = t.paper;
    out.push(':root{--mp-edition-bg:' + p.bg + ';--mp-edition-fg:' + p.fg + ';--mp-edition-heading:' + p.heading
      + ';--mp-edition-muted:' + p.muted + ';--mp-edition-border:' + p.border + ';--mp-edition-codeBg:' + p.codeBg
      + ';--mp-edition-capsule:' + p.capsule + ';--mp-edition-quoteBg:' + p.quoteBg + ';--mp-edition-quoteBar:'
      + p.quoteBar + ';--mp-edition-primary:' + p.primary + ';}');
    out.push('html{background:' + p.bg + ';}');
  }
  out.push('body{max-width:' + r.measure + 'px;margin:0 auto;padding:0 ' + r.pad + 'px 56px;'
    + 'font-family:' + BODY_FONT + ';font-size:' + r.body.size + 'px;line-height:' + r.body.line + ';'
    + 'letter-spacing:' + r.body.letter + ';text-align:' + r.body.align + ';text-autospace:normal;'
    + 'color:' + t.fg + ';background:' + t.bg + ';}');
  out.push('p{margin:0 0 ' + (k === 'book' ? '1.15em' : '.9em') + ';text-indent:' + r.body.indent + ';}');
  out.push('li p,blockquote p,td p,th p{text-indent:0;}');
  r.headings.forEach((h, i) => {
    const lvl = i + 1;
    const decls = [
      'font-family:' + headingFont(r),
      'font-size:' + h.size + 'px',
      'line-height:' + h.line,
      'font-weight:' + h.weight,
      'letter-spacing:' + h.letter,
      'text-align:' + h.align,
      'margin:' + h.margin,
      'color:' + (h.muted ? t.muted : t.heading),
    ];
    if (h.frame) decls.push('padding:.55em 0', 'border-top:1px solid ' + t.border, 'border-bottom:1px solid ' + t.border);
    if (h.bar) decls.push('border-left:5px solid ' + t.accent, 'padding-left:12px');
    if (h.under) decls.push('border-bottom:1px solid ' + t.border, 'padding-bottom:.3em');
    out.push('h' + lvl + '{' + decls.join(';') + ';}');
  });
  if (r.num) {
    out.push('.mp-edition-num{font-family:' + UI_FONT + ';font-weight:' + r.num.weight + ';margin-right:'
      + r.num.marginRight + ';font-size:' + r.num.size + ';letter-spacing:0;color:' + t.num + ';}');
  } else {
    out.push('.mp-edition-num{display:none;}');
  }
  const q = r.quote;
  out.push('blockquote{margin:' + q.margin + ';padding:' + q.pad + ';border-left:' + q.border + ' solid ' + t.quoteBar + ';'
    + 'background:' + (q.bg === 'token' ? t.quoteBg : 'transparent') + ';color:' + t.muted + ';font-size:' + q.size + ';'
    + 'line-height:' + q.line + ';letter-spacing:' + q.letter + ';'
    + (q.italic ? 'font-family:' + KAI_FONT + ';font-style:italic;' : '') + '}');
  const tb = r.table;
  out.push('table{width:100%;border-collapse:collapse;margin:1.2em 0;font-size:' + tb.size + ';'
    + (tb.numerals ? 'font-variant-numeric:tabular-nums lining-nums;' : '') + '}');
  out.push('th{font-weight:' + tb.thWeight + ';text-align:left;padding:.55em .7em;'
    + 'border-top:' + (tb.grid ? '2px' : '1.4px') + ' solid ' + t.border + ';border-bottom:1px solid ' + t.border + ';'
    + 'background:' + (tb.headerBg === 'token' ? t.capsule : 'transparent') + ';}');
  out.push('td{text-align:left;padding:.5em .7em;border-bottom:1px solid ' + t.border + ';'
    + (tb.grid ? 'border-left:1px solid ' + t.border + ';border-right:1px solid ' + t.border + ';' : '') + '}');
  out.push('thead{display:table-header-group;}');
  out.push('pre{margin:1.1em 0;padding:12px 14px;background:' + t.codeBg + ';border-radius:' + r.code.radius + ';'
    + 'overflow-x:auto;font-size:' + r.code.size + ';line-height:1.7;white-space:pre-wrap;word-break:break-word;}');
  out.push('code{font-family:var(--mp-font-mono,monospace);font-size:.92em;background:' + t.codeBg + ';'
    + 'border-radius:3px;padding:.1em .3em;}');
  out.push('pre code{background:transparent;padding:0;font-size:1em;}');
  out.push('ul,ol{margin:1em 0 1.15em;padding-left:1.65em;}li{margin:.32em 0;}');
  out.push('hr{border:0;border-top:1px solid ' + t.border + ';width:' + r.hr.width + ';margin:' + r.hr.margin + ';}');
  out.push('a{color:' + (k === 'book' ? 'inherit' : t.primary) + ';text-decoration:none;'
    + (k === 'book' ? 'border-bottom:1px solid ' + t.border + ';' : '') + '}');
  out.push('strong{font-weight:' + r.strongWeight + ';}');
  out.push('img{max-width:100%;height:auto;}');
  out.push('.mp-math-block{margin:1.2em 0;text-align:center;overflow-x:auto;overflow-y:hidden;}');
  out.push('.mp-math-block .katex-display{margin:0;}');
  out.push('.mp-mermaid{margin:1.2em 0;text-align:center;overflow-x:auto;}');
  out.push('.mp-mermaid svg{max-width:100%;height:auto;}');
  out.push('.mp-footnotes{margin:2.2em 0 8px;padding-top:12px;border-top:1px solid ' + t.border + ';font-size:.88em;color:' + t.muted + ';}');
  out.push('.mp-footnotes-list{padding-left:1.3em;margin:0;}');
  out.push('.mp-footnotes-list li{margin:0 0 .45em;}');
  out.push('.mp-fn-ref{font-size:.72em;vertical-align:super;line-height:0;}');
  out.push('.mp-fn-ref-link{color:' + t.primary + ';text-decoration:none;}');
  out.push('.mp-fn-text{color:' + t.fg + ';}');
  out.push('.mp-link-notes{margin:2em 0 0;padding-top:12px;border-top:1px solid ' + t.border + ';font-size:.84em;color:' + t.muted + ';}');
  out.push('.mp-link-notes p{margin:.25em 0;text-indent:0;word-break:break-all;}');
  /* 纸面：PDF 一律回到白纸黑字（暗色版式在纸上不可读），保留版式的字号阶/间距/表格规则。 */
  out.push('@media print{'
    + ':root{--mp-edition-fg:#111;--mp-edition-heading:#000;--mp-edition-muted:#333;--mp-edition-border:#999;'
    + '--mp-edition-codeBg:#f3f3f3;--mp-edition-capsule:#efefef;--mp-edition-quoteBg:#f6f6f6;--mp-edition-quoteBar:#bbb;'
    + '--mp-edition-primary:#0b4f8a;--mp-edition-bg:#fff;}'
    + 'html,body{background:#fff !important;}'
    + 'body{max-width:none !important;margin:0 !important;padding:0 !important;color:#111 !important;font-size:11.5pt;}'
    + 'h1,h2,h3,h4,h5,h6{break-after:avoid;page-break-after:avoid;}'
    + 'pre,blockquote,table,tr,img{break-inside:avoid;page-break-inside:avoid;}'
    + 'pre{white-space:pre-wrap;overflow:visible;}'
    + 'thead{display:table-header-group;}'
    + 'p{orphans:3;widows:3;}'
    + '}');
  if (t.explicit) out.push('@media print{body{background:#fff !important;color:#111 !important;}}');
  return out.join('\n');
}

/* ── 内联样式（发布件用）：与上面同一张值表，颜色取**具体值** ────────────────── */
export function editionInlineStyles(kind, options = {}) {
  const k = normalizeEdition({ kind }).kind;
  if (k === 'plain') return null;
  const r = EDITION_RECIPES[k];
  const p = options.palette || {};
  const fonts = options.fonts || {};
  const tone = options.tone === 'light' || options.tone === 'dark' ? options.tone : 'light';
  const paper = EDITION_PAPERS[tone];
  const pick = (key, fallback) => (p && p[key]) || (r.body ? '' : '') || fallback;
  const theme = {
    bg: pick('bg', paper.bg), fg: pick('fg', paper.fg), heading: pick('heading', paper.heading),
    muted: pick('muted', paper.muted), border: pick('border', paper.border), codeBg: pick('codeBg', paper.codeBg),
    capsule: pick('capsule', paper.capsule), quoteBg: pick('quoteBg', paper.quoteBg),
    quoteBar: pick('quoteBar', paper.quoteBar), primary: pick('primary', paper.primary),
    accent: pick('primary', paper.primary), num: pick('num', paper.primary),
  };
  const bodyFont = fonts.body || BODY_FONT.replace(/var\([^)]*\)/g, '').replace(/,\s*,/g, ',') || 'Georgia, serif';
  const latin = fonts.latin || MP_TYPO.fontLatin;
  const mono = fonts.mono || MP_TYPO.fontMono;
  const kai = fonts.kai || latin;
  const ui = fonts.ui || UI_FONT;
  const headingFontFamily = r.headingFamily === 'ui' ? ui : bodyFont;
  const map = {};
  map.body = {
    'font-family': bodyFont, 'font-size': r.body.size + 'px', 'line-height': String(r.body.line),
    'letter-spacing': r.body.letter, 'text-align': r.body.align, color: theme.fg, background: theme.bg,
    'word-break': 'break-word', 'overflow-wrap': 'break-word',
  };
  r.headings.forEach((h, i) => {
    const d = {
      'font-family': headingFontFamily, 'font-size': h.size + 'px', 'line-height': String(h.line),
      'font-weight': String(h.weight), 'letter-spacing': h.letter, 'text-align': h.align,
      margin: h.margin, color: h.muted ? theme.muted : theme.heading,
    };
    if (h.frame) { d['padding'] = '.55em 0'; d['border-top'] = '1px solid ' + theme.border; d['border-bottom'] = '1px solid ' + theme.border; }
    if (h.bar) { d['border-left'] = '5px solid ' + theme.accent; d['padding-left'] = '12px'; }
    if (h.under) { d['border-bottom'] = '1px solid ' + theme.border; d['padding-bottom'] = '.3em'; }
    map['h' + (i + 1)] = d;
  });
  map.p = { margin: '0 0 ' + (k === 'book' ? '1.15em' : '.9em'), 'text-indent': r.body.indent, 'line-height': String(r.body.line) };
  map.blockquote = {
    margin: r.quote.margin, padding: r.quote.pad, 'border-left': r.quote.border + ' solid ' + theme.quoteBar,
    background: r.quote.bg === 'token' ? theme.quoteBg : 'transparent', color: theme.muted,
    'font-size': r.quote.size, 'line-height': String(r.quote.line), 'letter-spacing': r.quote.letter,
  };
  if (r.quote.italic) { map.blockquote['font-family'] = kai + ', ' + latin; map.blockquote['font-style'] = 'italic'; }
  map.table = {
    width: '100%', 'border-collapse': 'collapse', margin: '1.2em 0', 'font-size': r.table.size,
    'font-variant-numeric': r.table.numerals ? 'tabular-nums lining-nums' : 'normal',
  };
  map.th = {
    'font-weight': String(r.table.thWeight), 'text-align': 'left', padding: '.55em .7em',
    'border-top': (r.table.grid ? '2px' : '1.4px') + ' solid ' + theme.border,
    'border-bottom': '1px solid ' + theme.border,
    background: r.table.headerBg === 'token' ? theme.capsule : 'transparent',
  };
  map.td = {
    'text-align': 'left', padding: '.5em .7em', 'border-bottom': '1px solid ' + theme.border,
  };
  if (r.table.grid) { map.td['border-left'] = '1px solid ' + theme.border; map.td['border-right'] = '1px solid ' + theme.border; }
  map.pre = {
    margin: '1.1em 0', padding: '12px 14px', background: theme.codeBg, 'border-radius': r.code.radius,
    'overflow-x': 'auto', 'font-size': r.code.size, 'line-height': '1.7', 'white-space': 'pre-wrap',
    'word-break': 'break-word', 'font-family': mono,
  };
  map.code = {
    'font-family': mono, 'font-size': '.92em', background: theme.codeBg, 'border-radius': '3px', padding: '.1em .3em',
  };
  map.preCode = { background: 'transparent', padding: '0', 'font-size': '1em', 'font-family': mono };
  map.ul = { margin: '1em 0 1.15em', 'padding-left': '1.65em' };
  map.ol = map.ul;
  map.li = { margin: '.32em 0' };
  map.hr = { border: '0', 'border-top': '1px solid ' + theme.border, width: r.hr.width, margin: r.hr.margin };
  map.a = { color: k === 'book' ? 'inherit' : theme.primary, 'text-decoration': 'none' };
  if (k === 'book') map.a['border-bottom'] = '1px solid ' + theme.border;
  map.strong = { 'font-weight': String(r.strongWeight) };
  map.em = { 'font-family': kai + ', ' + latin, 'font-style': 'italic' };
  map.img = { 'max-width': '100%', height: 'auto' };
  map.sup = { 'vertical-align': 'super', 'font-size': '.72em', 'line-height': '0' };
  map.mathBlock = { margin: '1.2em 0', 'text-align': 'center', 'overflow-x': 'auto' };
  map.mermaid = { margin: '1.2em 0', 'text-align': 'center', 'overflow-x': 'auto' };
  map.footnotes = {
    margin: '2.2em 0 8px', 'padding-top': '12px', 'border-top': '1px solid ' + theme.border,
    'font-size': '.88em', color: theme.muted,
  };
  map.footnotesList = { 'padding-left': '1.3em', margin: '0' };
  map.footnotesItem = { margin: '0 0 .45em' };
  map.num = {
    'font-family': ui, 'font-weight': r.num ? String(r.num.weight) : '600',
    'margin-right': r.num ? r.num.marginRight : '.4em', 'font-size': r.num ? r.num.size : '.92em',
    'letter-spacing': '0', color: theme.num,
  };
  map.linkNotes = {
    margin: '2em 0 0', 'padding-top': '12px', 'border-top': '1px solid ' + theme.border,
    'font-size': '.84em', color: theme.muted,
  };
  map.linkNoteP = { margin: '.25em 0', 'text-indent': '0', 'word-break': 'break-all' };
  map.title = { 'font-family': headingFontFamily, 'font-weight': '700', color: theme.heading };
  return map;
}

/** 给编辑器/探针的只读摘要（判据与面板回显同源）。 */
export function editionSnapshot(edition, isDark) {
  const e = normalizeEdition(edition);
  const tone = resolveEditionTone(e, isDark);
  const r = EDITION_RECIPES[e.kind] || null;
  return {
    kind: e.kind, variant: e.variant, tone,
    active: e.kind !== 'plain',
    label: EDITION_LABELS[e.kind] || EDITION_LABELS.plain,
    variantLabel: EDITION_VARIANT_LABELS[e.variant] || EDITION_VARIANT_LABELS.follow,
    measure: r ? r.measure : null,
    bodySize: r ? r.body.size : null,
    numbering: e.kind === 'report' ? 'report' : 'none',
  };
}
