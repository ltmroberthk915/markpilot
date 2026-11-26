'use strict';
/* article-recipes.test.cjs — 「书页 / 研报」四款配方的模块级判据。
 *
 * 只测 article-recipes.js 这个纯模块（真 import，不打包、不起界面、不碰 DOM）：
 *   ① 四款快照的接口形态与**两两不同**的配色（用户报的现象：两款浅色同白、两款深色同底）；
 *   ② 文档侧 CSS 的静态作用域（只作用 .mp-article、不得出现 CM6 选择器、不得出现计数器）；
 *   ③ 编辑面 CSS 的静态作用域（只作用 [data-mp-article-recipe][data-mp-article-variant]）；
 *   ④ 颜色对比度（正文/次要/表头/代码/引文一律 ≥ 4.5:1，逐对计算，不是拍脑袋）；
 *   ⑤ 研报编号能显示：编号规则必须**胜过**「H 徽标隐藏」规则（这是实测复现的那个缺陷）。
 *
 * 运行：node tools/quality/tests/article-recipes.test.cjs
 * （本仓当前环境 node --test 会 spawn EPERM，直接 node 等价且退出码可靠，见 ai-status.md §5.1）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.resolve(__dirname, '../../../dsh-markpilot/src-cm6/article-recipes.js');
const recipes = import(pathToFileURL(MODULE_PATH).href);

const VARIANTS = [
  ['book', 'light'], ['book', 'dark'], ['report', 'light'], ['report', 'dark'],
];

/* ── 工具：WCAG 相对亮度与对比度（自己算，不引依赖） ──────────────────────── */
function parseColor(value) {
  const text = String(value || '').trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    let c = hex[1];
    if (c.length === 3) c = c.split('').map((x) => x + x).join('');
    return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (rgb) {
    const parts = rgb[1].split(',').map((x) => Number(x.trim()));
    return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
  }
  return null;
}
function luminance(value) {
  const rgb = parseColor(value);
  assert.ok(rgb, '无法解析的颜色：' + value);
  const lin = rgb.map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/* ── 工具：把 CSS 拆成规则（去注释、保留媒体块内的规则体原文） ────────────── */
function cssRules(css) {
  const source = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(source))) {
    rules.push({ selector: m[1].trim(), body: m[2].trim() });
  }
  return rules;
}
/** 选择器特异度（a=id, b=类/属性/伪类, c=元素/伪元素），:is()/:not() 取内部最大。 */
function specificity(selector) {
  let text = String(selector);
  let extra = [0, 0, 0];
  /* 先把 :is()/:not() 里的内容折成"最大内部特异度"再累加（这是 CSS 规范的口径）。 */
  for (;;) {
    const at = text.search(/(:is|:not)\(/);
    if (at < 0) break;
    const fnLen = text.slice(at).startsWith(':is(') ? 4 : 5;
    let depth = 0;
    let end = -1;
    for (let i = at + fnLen - 1; i < text.length; i++) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) break;
    const inner = text.slice(at + fnLen, end);
    const best = inner.split(',').map((s) => specificity(s))
      .reduce((acc, cur) => [Math.max(acc[0], cur[0]), Math.max(acc[1], cur[1]), Math.max(acc[2], cur[2])], [0, 0, 0]);
    extra = [extra[0] + best[0], extra[1] + best[1], extra[2] + best[2]];
    text = text.slice(0, at) + ' ' + text.slice(end + 1);
  }
  const a = (text.match(/#[\w-]+/g) || []).length;
  const b = (text.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length;
  const c = (text.match(/(^|[\s>+~,])([a-zA-Z][\w-]*)|::[\w-]+/g) || []).length;
  return [a + extra[0], b + extra[1], c + extra[2]];
}
function outranks(x, y) {
  const [a1, b1, c1] = specificity(x);
  const [a2, b2, c2] = specificity(y);
  if (a1 !== a2) return a1 > a2;
  if (b1 !== b2) return b1 > b2;
  return c1 > c2;
}
/** 按顶层逗号拆选择器组（:is()/:not() 内部的逗号不算）。 */
function selectorList(selector) {
  const out = [];
  let depth = 0;
  let start = 0;
  const text = String(selector);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}
/** 从一串声明里取某个属性的值（最后一条胜出，与浏览器一致）。 */
function declared(declText, prop) {
  const re = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)', 'g');
  let value = null;
  let m;
  while ((m = re.exec(';' + declText))) value = m[1].trim();
  return value;
}
/** 在样式表里找"最终生效"的那条规则（同属性、同元素家族，特异度最高者；打平取后写）。 */
function winner(rules, selectorMatch, prop) {
  const candidates = rules.filter((r) => selectorMatch(r.selector.trim()) && declared(r.body, prop) !== null);
  if (!candidates.length) return null;
  let best = candidates[0];
  for (const cur of candidates.slice(1)) if (!outranks(best.selector, cur.selector)) best = cur;
  return best;
}

/* ══ ① 四款快照：接口形态 ══════════════════════════════════════════════════ */
test('four recipes expose the documented snapshot shape', async () => {
  const api = await recipes;
  for (const [id, variant] of VARIANTS) {
    const r = api.getArticleRecipe(id, variant);
    assert.equal(r.id, id);
    assert.equal(r.variant, variant);
    assert.equal(typeof r.label, 'string');
    assert.ok(r.label.length > 0, 'label 不能为空');
    for (const key of ['bg', 'fg', 'muted', 'accent', 'border', 'surface', 'heading', 'faint',
      'codeBg', 'codeFg', 'quoteBg', 'quoteFg', 'quoteBar', 'tableHeadBg', 'tableHeadFg',
      'tableBorder', 'num', 'link', 'caption', 'zebra', 'sel', 'primary', 'capsule']) {
      assert.ok(typeof r.colors[key] === 'string' && r.colors[key].trim(), id + '/' + variant + ' 缺颜色键 ' + key);
    }
    assert.ok(parseColor(r.colors.bg), 'bg 必须是具体色值：' + r.colors.bg);
    assert.ok(parseColor(r.colors.fg), 'fg 必须是具体色值：' + r.colors.fg);
    assert.equal(typeof r.bodyFont, 'string');
    assert.equal(typeof r.headingFont, 'string');
    assert.equal(r.headings.length, 6, '六级标题都要有');
    assert.ok(Object.isFrozen(r), '配方快照应冻结（下游只读）');
  }
});

test('unknown ids and variants fall back instead of throwing', async () => {
  const api = await recipes;
  assert.equal(api.getArticleRecipe('nope', 'light').id, 'book');
  assert.equal(api.getArticleRecipe(undefined, undefined).variant, 'light');
  assert.equal(api.getArticleRecipe('REPORT', 'DARK').id, 'report');
  assert.equal(api.getArticleRecipe('report', 'DARK').variant, 'dark');
  assert.equal(api.getArticleRecipe(' report ', ' dark ').id, 'report', '容忍前后空白');
});

test('the four variants are pairwise different (reported bug: two whites / two charcoals)', async () => {
  const api = await recipes;
  const seen = new Map();
  for (const [id, variant] of VARIANTS) {
    const c = api.getArticleRecipe(id, variant).colors;
    assert.ok(!seen.has(c.bg), id + '/' + variant + ' 的 bg ' + c.bg + ' 与其他款重复（' + seen.get(c.bg) + '）');
    seen.set(c.bg, id + '/' + variant);
  }
  const book = api.getArticleRecipe('book', 'light').colors;
  const report = api.getArticleRecipe('report', 'light').colors;
  assert.notEqual(book.fg, report.fg, '书页与研报的墨色必须不同');
  assert.notEqual(book.accent, report.accent, '书页与研报的强调色必须不同');
  assert.notEqual(book.bg.toLowerCase(), '#ffffff', '书页浅色必须是暖纸，不能是纯白');
  const bookDark = api.getArticleRecipe('book', 'dark').colors;
  const reportDark = api.getArticleRecipe('report', 'dark').colors;
  assert.notEqual(bookDark.bg, reportDark.bg, '两款深色底必须不同');
  assert.notEqual(bookDark.bg.toLowerCase(), '#1b1e24', '书页深色不能沿用主题的 #1B1E24');
});

test('book is a Chinese serif recipe; report is a structured sans recipe', async () => {
  const api = await recipes;
  const book = api.getArticleRecipe('book', 'light');
  const report = api.getArticleRecipe('report', 'light');
  assert.match(book.bodyFont, /Songti|SimSun|宋体|Serif/i, '书页正文字面必须是中文衬线');
  assert.match(book.headings[0].align, /^center$/, '书页章题居中');
  assert.equal(book.body.indent, '2em', '书页首行缩进');
  assert.equal(book.quote.italic, true, '书页引文用楷体斜体');
  assert.match(report.bodyFont, /YaHei|PingFang|Sans|sans-serif/i, '研报正文/标题走无衬线');
  assert.equal(report.body.indent, '0', '研报不缩进');
  assert.equal(report.table.grid, true, '研报表格有网格');
  assert.equal(report.table.headerBg, 'token', '研报表头有底色');
  assert.equal(report.table.numerals, true, '研报数字列等宽数字');
  assert.equal(report.numbering, 'chinese', '研报有真实章节编号');
  assert.equal(book.numbering, 'none', '书页不编号');
  assert.equal(report.body.size, 16, '研报基准字号 16px');
  assert.ok(report.headings[0].size > report.body.size, '章题必须大于正文');
});

/* ══ ② 文档侧 CSS：静态作用域 ═════════════════════════════════════════════ */
test('document CSS only touches .mp-article and never leaks CM6 selectors', async () => {
  const api = await recipes;
  for (const [id, variant] of VARIANTS) {
    const css = api.articleDocumentCss(api.getArticleRecipe(id, variant));
    assert.equal(typeof css, 'string');
    assert.ok(css.length > 800, id + '/' + variant + ' 的文档 CSS 太短，疑似没生成');
    assert.ok(!/\.cm-/.test(css), id + '/' + variant + ' 文档 CSS 里出现了编辑器选择器 .cm-*');
    assert.ok(!/\[data-mp-article-/.test(css), id + '/' + variant + ' 文档 CSS 里出现了编辑面属性选择器');
    assert.ok(!/counter\(|counter-increment|counter-reset/.test(css), '禁止 CSS 计数器（会与真实编号重复）');
    for (const rule of cssRules(css)) {
      for (const sel of selectorList(rule.selector)) {
        if (!sel || sel.startsWith('@')) continue;
        if (/^\d+%$/.test(sel)) continue;                       // 防御：不该有裸关键帧选择器
        assert.ok(sel.includes('.mp-article'), id + '/' + variant + ' 文档 CSS 越界选择器：' + sel);
      }
    }
  }
});

test('document CSS covers every required element family', async () => {
  const api = await recipes;
  const css = api.articleDocumentCss(api.getArticleRecipe('book', 'light'));
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'table', 'th', 'td',
    'ul', 'ol', 'pre', 'code', 'img', 'hr', 'a', 'strong', 'em', 'sup']) {
    assert.ok(new RegExp('\\.mp-article ' + tag + '[,\\s{]').test(css), '文档 CSS 缺 .mp-article ' + tag);
  }
  assert.match(css, /\.mp-article \.mp-footnotes/, '缺脚注区块');
  assert.match(css, /\.mp-article \.mp-fn-ref/, '缺脚注引用上标');
  assert.match(css, /\.mp-article \.mp-link-notes/, '缺文末外链清单');
  assert.match(css, /@media print/, '打印必须回白纸黑字');
});

test('document numbering span is styled but never generated by CSS', async () => {
  const api = await recipes;
  const css = api.articleDocumentCss(api.getArticleRecipe('report', 'light'));
  assert.match(css, /\.mp-edition-num/, '导出件里真实的编号 span 要有样式');
  assert.match(css, /span\[data-mp-section\]/, '允许集成方用 data-mp-section 承载编号');
  assert.ok(!/content:\s*attr\(data-mp-section\)/.test(css), '文档侧不许用 attr() 造编号文本');
  assert.ok(!/content:\s*["']?[（(]?[一二三四五六七八九十]/.test(css), '文档侧不许写死中文数字');
});

/* ══ ③ 编辑面 CSS：静态作用域 ═════════════════════════════════════════════ */
test('editor CSS is scoped to the recipe attributes on every selector', async () => {
  const api = await recipes;
  for (const [id, variant] of VARIANTS) {
    const css = api.articleEditorCss(api.getArticleRecipe(id, variant));
    assert.ok(css.length > 800, id + '/' + variant + ' 的编辑 CSS 太短');
    const scope = '[data-mp-article-recipe="' + id + '"][data-mp-article-variant="' + variant + '"]';
    assert.ok(css.includes(scope), '缺少完整限定作用域 ' + scope);
    for (const rule of cssRules(css)) {
      for (const sel of selectorList(rule.selector)) {
        if (!sel || sel.startsWith('@')) continue;
        assert.ok(sel.includes(scope), id + '/' + variant + ' 编辑 CSS 越界选择器：' + sel);
        /* 作用域之外只能是 html 前缀 / 后代选择器，不许出现另一款的作用域。 */
        const other = id === 'book' ? 'report' : 'book';
        assert.ok(!sel.includes('[data-mp-article-recipe="' + other + '"]'), '越界到另一款：' + sel);
      }
    }
    /* 一款的 CSS 不许把另一款的 variant 写进来。 */
    const otherVariant = variant === 'light' ? 'dark' : 'light';
    assert.ok(!css.includes('[data-mp-article-variant="' + otherVariant + '"]'), '混入了另一档明暗');
  }
});

test('editor CSS paints the editor surface, not only the content box', async () => {
  const api = await recipes;
  for (const [id, variant] of VARIANTS) {
    const r = api.getArticleRecipe(id, variant);
    const css = api.articleEditorCss(r);
    const rules = cssRules(css);
    /* 用户报的现象：.cm-editor 底色仍是主题色 ⇒ --mp-bg 必须落在 .cm-editor 上（祖先），
       只写在 .cm-content 上时 .cm-editor 的 background:var(--mp-bg) 拿不到配方值。 */
    const editorRule = rules.find((x) => /\.cm-editor$/.test(x.selector.trim()) && !/\.cm-content/.test(x.selector));
    assert.ok(editorRule, id + '/' + variant + ' 缺 .cm-editor 规则');
    assert.ok(editorRule.body.includes('--mp-bg:' + r.colors.bg), '--mp-bg 必须落在 .cm-editor 上');
    assert.ok(editorRule.body.includes('background:' + r.colors.bg), '.cm-editor 自身要铺配方纸色');
    const scroller = rules.find((x) => /\.cm-scroller$/.test(x.selector.trim()));
    assert.ok(scroller, '缺 .cm-scroller 规则（滚动区露底）');
    assert.ok(scroller.body.includes(r.colors.bg), '.cm-scroller 要用配方纸色');
    assert.ok(/html\[data-mp-article-recipe=/.test(css), 'html 根也要铺纸色，避免滚动尽头露主题底');
  }
});

test('editor CSS respects user fonts (never !important on font-family)', async () => {
  const api = await recipes;
  for (const [id, variant] of VARIANTS) {
    const css = api.articleEditorCss(api.getArticleRecipe(id, variant));
    for (const rule of cssRules(css)) {
      if (!/font-family/.test(rule.body)) continue;
      assert.ok(!/font-family[^;]*!important/.test(rule.body),
        '用户字体设置靠 !important 生效，配方不许抢：' + rule.selector);
    }
    /* 字体一律经 var(--mp-type-*, …) 出口，用户设了就用用户的。
       例外：编号伪元素**不写字体**（继承所在标题行），那种情况根本不会出现 font-family 声明。 */
    const fonts = (css.match(/font-family:[^;}]+/g) || []);
    assert.ok(fonts.length > 0, '没有任何 font-family 声明');
    assert.ok(fonts.every((f) => f.includes('var(--mp-type-')), '字体声明必须走 --mp-type-* 变量');
  }
});

test('editor CSS keeps code lines monospace and does not restyle their source', async () => {
  const api = await recipes;
  const css = api.articleEditorCss(api.getArticleRecipe('book', 'light'));
  const rules = cssRules(css);
  const quoteRule = rules.find((x) => /\.cm-line\.mp-quote:not\(\.mp-code\)$/.test(x.selector.trim()));
  assert.ok(quoteRule, '楷体斜体只能落在非代码的引文行');
  assert.ok(quoteRule.body.includes('italic'), '书页引文要斜体');
  const codeRule = rules.find((x) => /\.cm-line\.mp-code$/.test(x.selector.trim()));
  assert.ok(codeRule, '代码行必须有自己的规则');
  assert.ok(!/font-family/.test(codeRule.body), '代码行的等宽字体由引擎与用户设置负责，配方不改');
});

/* ══ ⑤ 研报编号：必须真的画得出来 ═════════════════════════════════════════ */
test('report numbering must explicitly beat the engine heading ::before on every conflicting property', async () => {
  const api = await recipes;
  const css = api.articleEditorCss(api.getArticleRecipe('report', 'light'));
  const rules = cssRules(css);
  const isNumberBefore = (sel) => /::before$/.test(sel) && /data-mp-edition-num/.test(sel);
  const numRules = rules.filter((r) => isNumberBefore(r.selector.trim()) && /content:\s*attr\(data-mp-edition-num\)/.test(r.body));
  assert.ok(numRules.length >= 1, '缺少 attr(data-mp-edition-num) 编号规则');
  const num = numRules[0];

  /* 引擎（main.js:8614-8632）那条标题 ::before 的关键声明：
       position:absolute; left:-30px; top:50%; transform:translateY(-50%);
       font-family/…; opacity:.85; pointer-events:none
     实测故障：编号继承了 translateY(-50%) 与 left:-30px ⇒ 高出标题半行、宽号侵入标题。
     所以这四条必须**逐条显式覆盖**，一条缺失就复现故障。 */
  assert.equal(declared(num.body, 'transform'), 'none', '必须显式 transform:none，否则继承 translateY(-50%) 把号抬起半行');
  assert.equal(declared(num.body, 'top'), '0', 'top 必须显式归 0（引擎写的是 50%）');
  assert.equal(declared(num.body, 'left'), 'auto', 'left 必须显式 auto（引擎写的是 -30px，会让宽号向右侵入标题）');
  assert.match(declared(num.body, 'right') || '', /^calc\(100% - \(var\(--mp-article-gutter, \d+px\) - 6px\)\)$/,
    '右缘必须钉在 gutter 内侧 6px，且跟随 gutter 变量：实得 ' + declared(num.body, 'right'));
  assert.equal(declared(num.body, 'bottom'), 'auto', 'bottom 归 auto，高度只由行高决定');

  /* 横向一整串：不许再出现固定 px 宽（40px 那次把「（一）」折成两行）与可折行。 */
  assert.equal(declared(num.body, 'width'), 'max-content', '宽度按内容走，禁止固定 px 宽');
  assert.equal(declared(num.body, 'white-space'), 'nowrap', '编号必须不折行');
  assert.equal(declared(num.body, 'overflow-wrap'), 'normal', '必须覆盖可断词');
  assert.ok(!/\d+px/.test(String(declared(num.body, 'width'))), 'width 不能是固定像素');
  /* 同一基线：line-height 随行盒走，而不是自己写一个 px 行高。 */
  assert.equal(declared(num.body, 'line-height'), 'inherit', 'line-height 必须 inherit，才能与章题同基线');
  assert.ok(declared(num.body, 'font-size'), '编号要有自己的字号（比标题小的视觉重量）');
  assert.ok(/opacity:\s*\.?95|opacity:\s*1\b/.test(num.body), '编号必须可见');

  /* 徽标隐藏必须排除带编号的行，否则编号被 display:none 吃掉（首次复现的缺陷）。 */
  const badgeHide = rules.filter((r) => /::before$/.test(r.selector.trim()) && /display:\s*none/.test(r.body));
  assert.equal(badgeHide.length, 1, '应恰有一条「隐藏 H 徽标」的规则');
  assert.match(badgeHide[0].selector, /:not\(\[data-mp-edition-num\]\)/, '徽标隐藏必须排除带编号的行');

  /* 书页不编号。 */
  assert.ok(!/content:\s*attr\(data-mp-edition-num\)/.test(api.articleEditorCss(api.getArticleRecipe('book', 'light'))),
    '书页不应绘制章节编号');
});

test('numbered heading reserves its own gutter inside the line box (no clipping at 390px)', async () => {
  const api = await recipes;
  const css = api.articleEditorCss(api.getArticleRecipe('report', 'light'));
  const rules = cssRules(css);

  const lineRule = winner(rules,
    (sel) => /\.cm-line:is\(\.mp-h1,[^)]*\)\[data-mp-edition-num\]$/.test(sel), 'padding-left');
  assert.ok(lineRule, '编号行必须自己给 padding-left 腾出 gutter');
  const gutterText = declared(lineRule.body, 'padding-left');
  const m = /^var\(--mp-article-gutter, (\d+)px\)$/.exec(gutterText || '');
  assert.ok(m, 'gutter 必须是带 px 回退的变量：实得 ' + gutterText);
  const gutter = Number(m[1]);
  /* 390px 窄屏：正文列左右各 24px padding（引擎）⇒ 可用宽度 342px。
     gutter 必须留得下最长的章号「（一）」/「十二、」，且仍给标题留下足够宽度。 */
  const narrow = 390 - 24 * 2;
  assert.ok(gutter >= 3 * 16 + 6, 'gutter 至少要装下三个全角字加间距（实得 ' + gutter + 'px）');
  assert.ok(gutter <= narrow * 0.3, '390px 下 gutter 不得超过正文宽度的 30%（实得 ' + gutter + 'px / ' + narrow + 'px）');
  /* 编号右缘 = 行盒左缘 + gutter - 6px；宽号向左生长 ⇒ 右侧始终离标题 6px。
     只取**覆盖一级标题**的那条（三级以下是更窄的短 gutter 规则，不能拿来判一级）。 */
  const pos = winner(rules, (sel) => /data-mp-edition-num\]::before$/.test(sel) && sel.includes('.mp-h1'), 'right');
  assert.ok(pos, '缺编号定位规则');
  const right = declared(pos.body, 'right');
  assert.ok(right.includes(String(gutter)), '编号右缘必须跟随同一条 gutter（实得 ' + right + '）');
  /* 三级以下用更窄的 gutter，且同样带 px 回退。 */
  const short = winner(rules, (sel) => /mp-h3.*data-mp-edition-num\](?:,|$)/.test(sel) && !/::before/.test(sel), 'padding-left');
  assert.ok(short, '三级标题要收窄 gutter');
  const shortText = declared(short.body, 'padding-left') || '';
  const sm = /^var\(--mp-article-gutter-short, (\d+)px\)$/.exec(shortText);
  assert.ok(sm, '短 gutter 也必须是带 px 回退的变量：实得 ' + shortText);
  assert.ok(Number(sm[1]) < gutter, '短 gutter 必须小于长 gutter');
  assert.ok(Number(sm[1]) >= 2 * 16 + 6, '短 gutter 也要装下两个全角字加间距');
});

/* ══ ④ 颜色对比度 ═════════════════════════════════════════════════════════ */
test('all four palettes clear 4.5:1 for text on its own surface', async () => {
  const api = await recipes;
  const PAIRS = [
    ['fg', 'bg', '正文'],
    ['heading', 'bg', '标题'],
    ['muted', 'bg', '次要文字'],
    ['accent', 'bg', '强调色'],
    ['num', 'bg', '编号'],
    ['link', 'bg', '链接'],
    ['caption', 'bg', '图注'],
    ['faint', 'bg', '最弱文字'],
    ['fg', 'surface', '正文/浅表面'],
    ['muted', 'surface', '次要文字/浅表面'],
    ['accent', 'surface', '强调色/浅表面'],
    ['fg', 'zebra', '正文/斑马行'],
    ['codeFg', 'codeBg', '代码'],
    ['quoteFg', 'quoteBg', '引文'],
    ['tableHeadFg', 'tableHeadBg', '表头'],
    ['muted', 'tableHeadBg', '次要文字/表头底'],
    ['num', 'bg', '编号'],
  ];
  for (const [id, variant] of VARIANTS) {
    const c = api.getArticleRecipe(id, variant).colors;
    for (const [fgKey, bgKey, name] of PAIRS) {
      const ratio = contrast(c[fgKey], c[bgKey]);
      assert.ok(ratio >= 4.5,
        id + '/' + variant + ' ' + name + '（' + fgKey + ' on ' + bgKey + '）对比度 '
        + ratio.toFixed(2) + ' < 4.5');
    }
  }
});

test('dark report table keeps readable text on its header fill', async () => {
  const api = await recipes;
  const dark = api.getArticleRecipe('report', 'dark').colors;
  assert.ok(contrast(dark.tableHeadFg, dark.tableHeadBg) >= 7,
    '深色研报表头要 ≥ 7:1（AAA 正文）');
  assert.ok(contrast(dark.fg, dark.bg) >= 12, '深色研报正文 ≥ 12:1');
  const light = api.getArticleRecipe('report', 'light').colors;
  assert.ok(contrast(light.tableHeadFg, light.tableHeadBg) >= 7, '浅色研报表头 ≥ 7:1');
  /* 表头底色必须真的与纸面不同，否则"表头有底色"只是文案。 */
  assert.ok(contrast(light.tableHeadBg, light.bg) > 1.05, '表头底与纸面要有差异');
  assert.ok(contrast(dark.tableHeadBg, dark.bg) > 1.05, '深色表头底与纸面要有差异');
});

test('warm paper reads warm and cool report reads cool (hue sanity)', async () => {
  const api = await recipes;
  const hue = (hex) => {
    const rgb = parseColor(hex);
    const [r, g, b] = rgb.map((x) => x * 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return 0;
    const d = max - min;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  };
  const bookPaper = api.getArticleRecipe('book', 'light').colors.bg;
  const reportPaper = api.getArticleRecipe('report', 'light').colors.bg;
  assert.ok(hue(bookPaper) >= 25 && hue(bookPaper) <= 60, '书页纸色应落在暖色带：' + bookPaper + ' hue=' + hue(bookPaper).toFixed(1));
  assert.ok(hue(reportPaper) <= 30 || hue(reportPaper) >= 190, '研报纸色不应是暖色：' + reportPaper);
  const bookInk = api.getArticleRecipe('book', 'light').colors.fg;
  assert.ok(hue(bookInk) >= 20 && hue(bookInk) <= 60, '书页墨色偏暖褐：' + bookInk);
});
