/**
 * 排版**唯一真源**（编辑面与导出件共用一份值表，2026-10-07 用户要求"编辑与导出同源"）
 *
 * 为什么是"值表 + 两侧生成"，而不是把编辑面那 200 行 CSS 整段搬过来：
 *  · 编辑面 CSS 里混着 `.cm-*`、光标、滚动条、工具栏这些**只在编辑器里有意义**的东西；
 *  · 而用户最担心的是"同源会不会把编辑面那套美观排版弄崩"——搬家的每一步都可能碰到它。
 *  · 所以真源只固定**排版语言本身**（字体栈／字号阶／行高／版心／描边／楷体斜体／autospace），
 *    编辑面用 `editor*()` 这几个生成器吐出来的**与原来逐字相同**的规则，导出件用 `exportTypoCss()`
 *    吐出的静态页规则 —— 两侧取值都来自下面这张表，**改一处两边同时变**，漂移由静态判据兜底。
 *
 * 【导出侧三条硬约束（SPEC 承重结论）】
 *  1. 导出件是静态页，`var(--mp-*)` 全部 invalid ⇒ 颜色**必须运行时快照**（见 typographySnapshot 的姊妹
 *     `colorTokenSnapshot()`，在 extras.js 里对 getComputedStyle 取值后写进导出页 `:root`）。
 *  2. **基准字号必须留 14px**：字号阶是绝对 px，改成老产品的 16px 会让 H4(16px) ＝ 正文，阶梯当场塌一档。
 *  3. 行高是 CM6 高度图纪律的产物（30/24/18… 绝对 px），**纸面不要照搬**，纸面用 margin 承担间距。
 */

export const MP_TYPO = Object.freeze({
  fontLatin: "Georgia, 'Times New Roman'",
  fontHan: "'SimSun', '宋体', 'NSimSun', 'Noto Serif CJK SC', 'Source Han Serif SC'",
  fontMono: "'SF Mono', 'Cascadia Code', Consolas, Monaco, 'Courier New', monospace",
  bodySize: 14,
  bodyLineHeight: 1.8,
  measure: { width: 1280, padLeft: 46, padRight: 28 },
  stroke: { body: '.007em', strong: '.015em', strongWeight: 900 },
  kai: {
    family: 'markpilot-kai', em: 1.18, letterSpacing: '.025em', sizeAdjust: '97%',
    /* 字面来源与码位范围也收进真源：导出件是**静态页**，只写 font-family 而没有 @font-face，
       中文斜体就会掉成系统衬线斜体（实测抓到）。编辑面的 @font-face 与本表由静态判据绑定。 */
    src: "local('KaiTi'), local('楷体'), local('STKaiti'), local('Kaiti SC'), local('KaiTi SC'), local('DFKai-SB'), local('BiauKai')",
    unicodeRange: 'U+2E80-2FDF, U+3005, U+3007, U+3021-3029, U+3038-303A, U+3041-30FF, U+3105-312F, U+31F0-31FF, U+3190-319F, U+3200-33FF, U+3400-4DBF, U+4E00-9FFF, U+A960-A97F, U+AC00-D7A3, U+F900-FAFF, U+FE10-FE19, U+FE30-FE4F, U+FF00-FFEF, U+20000-2FFFD, U+30000-3FFFD',
  },
  /* 字号阶：编辑面是 h1..h6 = 30/24/18/16/14/12（背景见 main.js 的"高度图纪律"）。
     导出件只取 size，行高另算（纸面用 margin）。 */
  headings: [
    { level: 1, size: 30, lineHeight: 48, border: true, bodyFont: true },
    { level: 2, size: 24, lineHeight: 40, border: true, bodyFont: true },
    { level: 3, size: 18, lineHeight: 32, border: false, bodyFont: true },
    { level: 4, size: 16, lineHeight: 30, border: false, bodyFont: true },
    { level: 5, size: 14, lineHeight: 28, border: false, bodyFont: false },
    { level: 6, size: 12, lineHeight: 26, border: false, bodyFont: false },
  ],
});

/* ── 编辑面：字体变量（逐字等于原注入 CSS 里的那一行） ── */
export function editorFontVarsCss() {
  return `--mp-font-latin: ${MP_TYPO.fontLatin};\n`
    + `  --mp-font-han: ${MP_TYPO.fontHan};\n`
    + `  --mp-font-body: var(--mp-font-latin), var(--mp-font-han), serif;\n`
    + `  --mp-font-mono: ${MP_TYPO.fontMono};`;
}

/* ── 编辑面：标题阶（逐字等于原来的六条 .cm-line.mp-hN 规则） ── */
export function editorHeadingsCss() {
  return MP_TYPO.headings.map((h) => {
    const font = ` font-family: var(--mp-type-h${h.level}, var(--mp-type-body, var(--mp-font-body)));`;
    const border = h.border ? ' border-bottom: 1px solid var(--mp-border);' : '';
    return `.cm-line.mp-h${h.level} { font-size: ${h.size}px; line-height: ${h.lineHeight}px; font-weight: 700; color: var(--mp-heading);${font}${border} }`;
  }).join('\n');
}

/* ── 编辑面：正文版心/描边（逐字等于原规则） ── */
export function editorContentMetricsCss() {
  const m = MP_TYPO.measure;
  return `-webkit-text-stroke: ${MP_TYPO.stroke.body} currentColor;\n`
    + `  padding-left: max(${m.padLeft}px, calc((100vw - ${m.width}px) / 2)) !important;\n`
    + `  padding-right: max(${m.padRight}px, calc((100vw - ${m.width}px) / 2)) !important;`;
}

/* ── 编辑面：楷体斜体（HighlightStyle 用的三项） ── */
export function editorKaiStyle() {
  return {
    fontFamily: `var(--mp-type-italic, '${MP_TYPO.kai.family}'), var(--mp-font-latin), serif`,
    fontStyle: 'italic',
    fontSynthesisStyle: 'none',
    fontSize: `${MP_TYPO.kai.em}em`,
    letterSpacing: MP_TYPO.kai.letterSpacing,
  };
}
export function editorKaiRuleCss() {
  const k = editorKaiStyle();
  return `.cm-content em { font-family: ${k.fontFamily}; font-style: italic; font-synthesis-style: none; font-size: ${k.fontSize}; letter-spacing: ${k.letterSpacing}; }`;
}

/** 供静态判据使用：把"排版语言"的关键值摊平成一个可比对的快照。 */
export function typographySnapshot() {
  const m = MP_TYPO.measure;
  return {
    fontLatin: MP_TYPO.fontLatin, fontHan: MP_TYPO.fontHan, fontMono: MP_TYPO.fontMono,
    bodySize: MP_TYPO.bodySize, bodyLineHeight: MP_TYPO.bodyLineHeight,
    measure: `${m.width}/${m.padLeft}/${m.padRight}`,
    stroke: MP_TYPO.stroke.body, strongStroke: MP_TYPO.stroke.strong, strongWeight: MP_TYPO.stroke.strongWeight,
    kaiEm: MP_TYPO.kai.em, kaiSizeAdjust: MP_TYPO.kai.sizeAdjust, kaiLetterSpacing: MP_TYPO.kai.letterSpacing,
    headings: MP_TYPO.headings.map((h) => h.size).join('/'),
  };
}

/** 楷体字面的 @font-face（导出件必须自带：只写 font-family 而没有 face，中文斜体会掉成系统衬线斜体）。
 *  与编辑面那份同源（src/unicode-range/size-adjust 三项由静态判据绑定）。 */
export function kaiFaceCss() {
  const k = MP_TYPO.kai;
  return `@font-face{font-family:'${k.family}';src:${k.src};unicode-range:${k.unicodeRange};`
    + `font-style:italic;size-adjust:${k.sizeAdjust};}`;
}

/**
 * 导出件作者层样式（静态页，**不得出现 .cm- 选择器**；颜色一律走 --mp-*，由运行时快照提供）。
 * 与编辑面的差异都写在注释里：纸面没有视口，也没有 H 徽标悬挂位。
 */
export function exportTypoCss() {
  const t = MP_TYPO, m = t.measure;
  const headings = t.headings.map((h) => `h${h.level}{font-size:${h.size}px;font-weight:700;color:var(--mp-heading);`
    + `font-family:var(--mp-font-body);margin:${h.level <= 2 ? '1.6em' : '1.25em'} 0 .6em;`
    + (h.border ? 'border-bottom:1px solid var(--mp-border);padding-bottom:.25em;' : '') + '}').join('\n');
  return [
    /* 导出件是**静态页**：字体变量必须自带。此前只带颜色快照 ⇒ 作者层里所有
       `font-family: var(--mp-font-*)` 在计算值阶段整条失效，正文与代码一起掉回浏览器默认
       （实测落到 Times New Roman）。由同一张值表生成，不另抄一份。 */
    `:root{${editorFontVarsCss()}}`,
    kaiFaceCss(),
    /* 纸面版心：屏幕端 max-width 1280 居中（与编辑面同宽），左右各留 28px；
       编辑面那 46px 左垫是给 H1..H6 徽标悬挂用的，导出件剥掉徽标 ⇒ 不抄 46。 */
    `body{max-width:${m.width}px;margin:0 auto;padding:0 ${m.padRight}px;`
    + `font-family:var(--mp-font-body);font-size:${t.bodySize}px;line-height:${t.bodyLineHeight};color:var(--mp-fg);background:var(--mp-bg);`
    + `text-autospace:normal;-webkit-text-stroke:${t.stroke.body} currentColor;}`,
    `strong{font-weight:${t.stroke.strongWeight};-webkit-text-stroke:${t.stroke.strong} currentColor;}`,
    /* 中文斜体楷书化：与编辑面同一款字体、同一个 1.18em 与 size-adjust（真源在 @font-face，见 index/app.css） */
    `em{font-family:'${t.kai.family}',var(--mp-font-latin),serif;font-style:italic;font-synthesis-style:none;`
    + `font-size:${t.kai.em}em;letter-spacing:${t.kai.letterSpacing};}`,
    headings,
    /* 代码：SPEC 定 0.9em（与行内 code 同号，避免编辑面 0.85em 在纸面偏小） */
    `pre{background:var(--mp-codeBg);border-radius:6px;padding:12px 14px;overflow:auto;font-size:.9em;line-height:1.6;}`
    + `code{font-family:var(--mp-font-mono);background:var(--mp-codeBg);border-radius:3px;padding:.12em .3em;font-size:.9em;}`
    + `pre code{background:transparent;padding:0;font-size:1em;}`,
    `blockquote{margin:1em 0;padding:.2em 0 .2em 14px;border-left:3px solid var(--mp-quoteBar);background:var(--mp-quoteBg);color:var(--mp-muted);}`,
    `a{color:var(--mp-primary);text-decoration:none;}`,
    /* 表格：纸面用 fixed 布局 + 满宽（与老产品 export.css:36 同口径），边框走 token */
    `table{width:100%;table-layout:fixed;border-collapse:collapse;margin:1em 0;font-size:${t.bodySize}px;}`
    + `td,th{border:1px solid var(--mp-border);padding:6px 10px;word-break:break-word;vertical-align:top;}`
    + `th,thead td{background:var(--mp-capsule);font-weight:700;}`,
    `img{max-width:100%;height:auto;}`,
    `hr{border:0;border-top:1px solid var(--mp-border);margin:1.6em 0;}`,
    /* 分页：断页由 break-* 承担；不写 @page（打印层 preferCSSPageSize:false 下不生效，且会与壳层边距形成两个真源） */
    `h1,h2,h3,h4,h5,h6{break-after:avoid;page-break-after:avoid;}`
    + `pre,blockquote,table,tr,img{break-inside:avoid;page-break-inside:avoid;}`
    + `p{orphans:3;widows:3;}`,
  ].join('\n');
}
