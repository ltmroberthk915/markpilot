/* edition-publish.js — 文章版式的**输出侧**：把公开快照渲染出的正文片段变成
 *   ① 静态 HTML 导出（`.mp-article` 语义根，配方选择器挂在它上面）
 *   ② 微信复制 / 草稿（全内联样式、文末外链编号、可去重、公式/图表保留可栅格化类名）
 *   ③ 知乎复制（保留原文链接、语义层级、代码缩进、公式保留 TeX 来源）
 *
 * 纯字符串变换（不碰 DOM、不联网），因此 Node 测试与渲染进程同一份实现。
 * 纪律：
 *  · 只改**标签的外壳**（补 style/属性、拆链接），正文文本与嵌套结构逐字节保留；
 *  · KaTeX 自带的 inline style 一律**合并**、不覆盖（覆盖会把公式排版打散）；
 *  · 公式永不降级成 `<code>TeX</code>`：微信走 mp-math（对话框栅格化成 PNG），
 *    知乎走 ztext-math（data-tex 带 TeX 来源，内层保留 KaTeX 字形）；
 *  · 微信外链：默认编号 + 同址去重，编号是**真实输出**（正文里的上标与文末清单同一份编号）；
 *  · 内部锚点（`#…`）、脚注引用、相对链接不参与外链编号。
 */

/* 纸面色板（显式明暗/plain 对照）：发布件离开本机后没有主题变量，颜色必须成对写死。 */
import { EDITION_PAPERS } from './article-edition.js';

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

export function decodeEntities(text) {
  return String(text == null ? '' : text)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
export function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export function parseAttrs(source) {
  const out = {};
  const text = String(source || '');
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(text))) {
    const name = m[1].toLowerCase();
    const value = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '';
    if (name === 'style') { out.style = (out.style ? out.style + ';' : '') + value; continue; }
    if (Object.prototype.hasOwnProperty.call(out, name)) continue;   // 首个属性胜出（与浏览器一致）
    out[name] = decodeEntities(value);
  }
  return out;
}
function styleString(decls) {
  if (!decls) return '';
  if (typeof decls === 'string') return decls.trim();
  return Object.entries(decls).filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => k + ':' + String(v).trim()).join(';');
}
/** 合并样式：已有声明优先保留（KaTeX 的排版声明绝不被覆盖），只补缺。 */
export function mergeStyle(existing, wanted) {
  const want = styleString(wanted);
  const have = String(existing || '').trim();
  if (!want) return have;
  if (!have) return want;
  const seen = new Set();
  for (const part of have.split(';')) {
    const i = part.indexOf(':');
    if (i > 0) seen.add(part.slice(0, i).trim().toLowerCase());
  }
  const extra = [];
  for (const part of want.split(';')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push(part.trim());
  }
  if (!extra.length) return have;
  return have.replace(/;\s*$/, '') + ';' + extra.join(';');
}
export function serializeAttrs(attrs) {
  const parts = [];
  for (const [name, value] of Object.entries(attrs)) {
    if (value == null) continue;
    parts.push(name + '="' + String(value).replace(/"/g, '&quot;') + '"');
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

/**
 * 按标签名把内联样式补进正文片段。
 * map: { tagName: decls | (attrs, parents) => decls|null }；
 * `.class` 键优先（有该 class 就用它）；函数可读到祖先标签（`pre > code` 要不同样式）。
 * 返回 null/'' 表示这一处不补样式。
 *
 * 【必须跳过完整子树·2026-11-25 实测反例】Mermaid 的 `<svg>` 里是
 * `<foreignObject><div><p class="nodeLabel">…</p></div>`，标签框是**它自己算好的 32×24**。
 * 通用文章样式一旦把 `p{margin:0 0 .9em;text-indent:0;line-height:1.78}` 灌进去，
 * 汉字下半就被 32×24 的框裁掉（实际上传 PNG 里两枚节点的中文都缺下半）。
 * 所以：**SVG / MathML / KaTeX / 公式容器整棵子树按字节原样穿过**，不改它们的标签与属性；
 * 同一支 inliner 仍然只作用于文章层（p/h/table/…）。
 */
export function applyInlineStyles(html, map) {
  const source = String(html == null ? '' : html);
  const guarded = protectedRanges(source);
  if (!guarded.length) return styleSegment(source, map);
  let out = '', cursor = 0;
  for (const [from, to] of guarded) {
    if (from > cursor) out += styleSegment(source.slice(cursor, from), map);
    out += source.slice(from, to);      // 逐字节保留：图表/公式内部一个属性都不碰
    cursor = to;
  }
  if (cursor < source.length) out += styleSegment(source.slice(cursor), map);
  return out;
}

const SKIP_ROOT_CLASS = /(^|\s)(katex|katex-html|katex-display|mp-math|mp-math-block|mp-mermaid)(\s|$)/;

function isProtectedRoot(name, attrs) {
  if (name === 'svg' || name === 'math') return true;
  return SKIP_ROOT_CLASS.test(String(attrs && attrs.class || ''));
}

/** 受保护子树的字节区间（合并嵌套）。单趟扫描；own HTML 由导出链生成，嵌套是良构的。 */
export function protectedRanges(html) {
  const source = String(html == null ? '' : html);
  const ranges = [];
  const stack = [];
  const re = new RegExp(TAG_RE.source, 'g');
  let m;
  while ((m = re.exec(source))) {
    const whole = m[0], closing = m[1] === '/', name = String(m[2] || '').toLowerCase();
    const attrText = m[3] || '', selfClose = m[4] === '/';
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name !== name) continue;
        const entry = stack[i];
        stack.length = i;                        // 该元素及其更内层一起出栈
        if (entry.root) ranges.push([entry.start, m.index + whole.length]);
        break;
      }
      continue;
    }
    if (VOID_TAGS.has(name) || selfClose) continue;
    stack.push({ name, start: m.index, root: isProtectedRoot(name, parseAttrs(attrText)) });
  }
  if (!ranges.length) return [];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (const range of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

/** 只在**未受保护**的片段上做正则改写（图表/公式内部一个字节都不动）。 */
export function mapOutsideProtected(html, fn) {
  const source = String(html == null ? '' : html);
  const guarded = protectedRanges(source);
  if (!guarded.length) return fn(source);
  let out = '', cursor = 0;
  for (const [from, to] of guarded) {
    if (from > cursor) out += fn(source.slice(cursor, from));
    out += source.slice(from, to);
    cursor = to;
  }
  if (cursor < source.length) out += fn(source.slice(cursor));
  return out;
}

function styleSegment(source, map) {
  const rules = Object.entries(map || {});
  const byClass = rules.filter(([k]) => k.startsWith('.'));
  const byTag = new Map(rules.filter(([k]) => !k.startsWith('.')));
  const stack = [];
  return String(source).replace(TAG_RE, (whole, close, tag, attrText, selfClose) => {
    const name = tag.toLowerCase();
    if (close) {
      const at = stack.lastIndexOf(name);
      if (at >= 0) stack.length = at;
      return '</' + name + '>';
    }
    const parents = stack.slice();
    const attrs = parseAttrs(attrText);
    const classes = (attrs.class || '').split(/\s+/).filter(Boolean);
    let rule = null;
    for (const [key, fn] of byClass) {
      if (classes.indexOf(key.slice(1)) >= 0) { rule = fn; break; }
    }
    if (!rule) rule = byTag.get(name) || null;
    if (rule) {
      const decls = typeof rule === 'function' ? rule(attrs, parents) : rule;
      if (decls) attrs.style = mergeStyle(attrs.style, decls);
    }
    if (!selfClose && !VOID_TAGS.has(name)) stack.push(name);
    return '<' + name + serializeAttrs(attrs) + (selfClose ? ' /' : '') + '>';
  });
}

/* ── 旧口径（kind=plain）：与改前 copyRich 的 inlineCss 同一批声明 ─────────────── */
export const LEGACY_INLINE_STYLES = Object.freeze({
  strong: 'font-weight:600',
  h1: 'font-size:24px;font-weight:600;margin:22px 0 10px',
  h2: 'font-size:20px;font-weight:600;margin:20px 0 8px',
  h3: 'font-size:17px;font-weight:600;margin:18px 0 8px',
  p: 'margin:10px 0;line-height:1.75',
  blockquote: 'border-left:3px solid #dfe2e5;padding-left:12px;color:#6a737d;margin:10px 0',
  pre: 'background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto;font-size:13px',
  code: 'background:#f6f8fa;padding:1px 4px;border-radius:3px;font-size:13px',
  table: 'border-collapse:collapse;margin:12px 0',
  td: 'border:1px solid #dfe2e5;padding:6px 12px',
  th: 'border:1px solid #dfe2e5;padding:6px 12px;background:#f6f8fa;text-align:left',
  hr: 'border:0;border-top:1px solid #e1e4e8;margin:18px 0',
});

/** 旧口径里 `pre > code` 不叠行内代码底色（与改前 `<pre><code>` 合并规则同结果）。
 *  传入 palette 时把正文前景/底色成对写死 —— 发布件离开本机后没有任何主题变量可依赖，
 *  缺了它就会出现"白底浅灰字"或"深底黑字"（实测反例：知乎预览 h1 rgb(222,225,230)）。 */
function legacyStyles(palette) {
  const map = { ...LEGACY_INLINE_STYLES };
  map.code = (attrs, parents) => (parents.indexOf('pre') >= 0
    ? 'background:transparent;padding:0;font-size:1em'
    : LEGACY_INLINE_STYLES.code);
  if (palette) {
    map.p = LEGACY_INLINE_STYLES.p + ';color:' + palette.fg;
    map.li = 'color:' + palette.fg;
    map.h1 = LEGACY_INLINE_STYLES.h1 + ';color:' + palette.heading;
    map.h2 = LEGACY_INLINE_STYLES.h2 + ';color:' + palette.heading;
    map.h3 = LEGACY_INLINE_STYLES.h3 + ';color:' + palette.heading;
    map.h4 = 'font-size:15px;font-weight:600;margin:16px 0 6px;color:' + palette.heading;
    map.h5 = 'font-size:14px;font-weight:600;margin:14px 0 6px;color:' + palette.heading;
    map.h6 = 'font-size:13px;font-weight:600;margin:12px 0 6px;color:' + palette.muted;
    map.th = LEGACY_INLINE_STYLES.th + ';color:' + palette.heading;
    map.td = LEGACY_INLINE_STYLES.td + ';color:' + palette.fg;
    map.blockquote = LEGACY_INLINE_STYLES.blockquote + ';color:' + palette.muted;
    map.strong = LEGACY_INLINE_STYLES.strong + ';color:' + palette.heading;
    map.pre = LEGACY_INLINE_STYLES.pre + ';color:' + palette.fg;
  }
  return map;
}

/** 公开文章地址：只接受显式 http(s)。本机文件路径/相对路径一律判空 ——
 *  它会被写进导出件 canonical 与微信「原文：」，泄露磁盘与用户名是不可逆的。 */
export function publicArticleUrl(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (!url.hostname) return '';
    return url.href;
  } catch { return ''; }
}

/* ── 外链编号（微信）────────────────────────────────────────────────────────── */

/** 外链计划：按出现顺序编号；dedupe=true 时同址共用编号。内部锚点/脚注不参与。 */
export function planExternalLinks(html, { dedupe = true } = {}) {
  const source = String(html == null ? '' : html);
  const plan = [];
  const byHref = new Map();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(source))) {
    const attrs = parseAttrs(m[1]);
    const href = String(attrs.href || '').trim();
    if (!href || href.charAt(0) === '#') continue;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//')) continue;   // 相对链接不是"外链"
    if (attrs.class && /\bmp-fn-(?:ref|back)-link\b/.test(attrs.class)) continue;
    if (attrs.role === 'doc-noteref' || attrs.role === 'doc-backlink') continue;
    let entry = dedupe ? byHref.get(href) : null;
    if (!entry) {
      entry = { n: plan.length + 1, href, text: decodeEntities(m[2].replace(/<[^>]*>/g, '')).trim(), count: 0 };
      plan.push(entry);
      if (dedupe) byHref.set(href, entry);
    }
    entry.count += 1;
  }
  return plan;
}

/** 文末外链清单（真实输出；没有外链时为空串，不产生空区块）。 */
export function linkNotesHtml(plan, styles) {
  if (!plan || !plan.length) return '';
  const css = styles && styles.linkNotes ? styleString(styles.linkNotes) : '';
  const pCss = styles && styles.linkNoteP ? styleString(styles.linkNoteP) : '';
  const items = plan.map((e) => '<p' + (pCss ? ' style="' + escapeHtml(pCss) + '"' : '')
    + '><span class="mp-link-num">[' + e.n + ']</span> ' + escapeHtml(e.text || e.href)
    + ' <span class="mp-link-url">' + escapeHtml(e.href) + '</span></p>').join('');
  return '<section class="mp-link-notes"' + (css ? ' style="' + escapeHtml(css) + '"' : '')
    + ' role="doc-endnotes" aria-label="参考链接"><p class="mp-link-notes-title"'
    + (pCss ? ' style="' + escapeHtml(pCss) + '"' : '') + '><b>参考链接</b></p>' + items + '</section>';
}

/**
 * 微信正文：外链改成上标编号 + 文末清单；样式全内联；公式/图表保留
 * `.mp-math/.mp-math-block/.mp-mermaid`（草稿对话框据此栅格化成 PNG）。
 */
export function wechatArticleHtml(html, { styles, linkNotes = true, dedupe = true, sourceUrl = '', rootStyle = null, palette = null } = {}) {
  const plan = planExternalLinks(html, { dedupe });
  const styleMap = styles || {};
  const body = String(html == null ? '' : html);
  const publicUrl = publicArticleUrl(sourceUrl);
  /* 编号必须与 plan 的出现次序**逐项对齐**：
       · 去重开 ⇒ 同址复用同一个编号（plan 每个唯一地址一条）；
       · 去重关 ⇒ 每一次出现各占一个编号（plan 每出现一条），按出现次序消费。
     改前这里按 href 再 find 一次 ⇒ 去重关时第二项仍拿到第 1 条的编号（内文 [1,1,3]，文末 [1,2,3]）。 */
  let occurrence = 0;
  const numbered = mapOutsideProtected(body, (segment) => segment.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrText, inner) => {
    const attrs = parseAttrs(attrText);
    const href = String(attrs.href || '').trim();
    const inline = styleMap.aInline ? styleString(styleMap.aInline) : '';
    const plain = '<span class="mp-anchor-inline"' + (inline ? ' style="' + escapeHtml(inline) + '"' : '') + '>' + inner + '</span>';
    if (!href || href.charAt(0) === '#') return plain;
    if (attrs.class && /\bmp-fn-(?:ref|back)-link\b/.test(attrs.class)) return plain;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//')) return plain;
    const entry = dedupe ? plan.find((e) => e.href === href) : plan[occurrence++];
    if (!linkNotes || !entry) return plain;
    const ref = '<sup class="mp-link-ref"' + (styleMap.linkRef ? ' style="' + escapeHtml(styleString(styleMap.linkRef)) + '"' : '')
      + '>[' + entry.n + ']</sup>';
    return inner + ref;
  }));
  const styled = applyInlineStyles(numbered, styleMap);
  const notes = linkNotes ? linkNotesHtml(plan, styleMap) : '';
  const origin = publicUrl ? '<p class="mp-origin"' + (styleMap.origin ? ' style="' + escapeHtml(styleString(styleMap.origin)) + '"' : '')
    + '>原文：' + escapeHtml(publicUrl) + '</p>' : '';
  /* 【片段根自带前景/底色】收件页没有 MarkPilot 的主题变量，根上必须把成对颜色写死；
     否则白底浅灰字/深底黑字这类错配就取决于目标编辑器自己的默认样式。 */
  const rootAttr = rootStyle ? ' style="' + escapeHtml(styleString(rootStyle)) + '"' : '';
  return {
    html: '<section class="mp-article-body" data-mp-publish="wechat"' + rootAttr + '>'
      + styled + notes + origin + '</section>',
    links: plan,
  };
}

/**
 * 知乎正文：**保留原文链接**（真实 href，内联样式）；标题层级原样；代码块
 * white-space:pre-wrap + 等宽字体保住缩进；公式加 `ztext-math` 并带 data-tex（TeX 来源），
 * 内层仍是 KaTeX 字形 —— 上标/下标不会被降级成代码文本。
 */
export function zhihuArticleHtml(html, { styles, rootStyle = null, palette = null } = {}) {
  const styleMap = styles || {};
  let body = String(html == null ? '' : html);
  /* 公式：给带 TeX 来源的载体补知乎认得的 ztext-math（data-tex 是真实输出）。 */
  body = body.replace(/<(span|div) class="(mp-math|mp-math-block)"([^>]*)>/g, (whole, tag, cls, rest) => {
    const attrs = parseAttrs(rest);
    const tex = attrs['data-mp-tex'];
    if (!tex) return whole;
    const display = cls === 'mp-math-block' ? 'block' : 'inline';
    return '<' + tag + ' class="' + cls + ' ztext-math" data-tex="' + escapeHtml(tex)
      + '" data-display="' + display + '"' + serializeAttrs(attrs) + '>';
  });
  /* 外链：保留 href，补 target/rel；不改文字、不改编号（知乎是真实链接）。
     图表/公式内部（含 SVG 里的 <a>）逐字节跳过。 */
  body = mapOutsideProtected(body, (segment) => segment.replace(/<a\b([^>]*)>/gi, (whole, attrText) => {
    const attrs = parseAttrs(attrText);
    const href = String(attrs.href || '').trim();
    if (!href || href.charAt(0) === '#') return whole;
    attrs.rel = attrs.rel || 'noopener nofollow';
    attrs.target = attrs.target || '_blank';
    return '<a' + serializeAttrs(attrs) + '>';
  }));
  body = applyInlineStyles(body, styleMap);
  const rootAttr = rootStyle ? ' style="' + escapeHtml(styleString(rootStyle)) + '"' : '';
  const wrapped = '<section class="mp-article-body" data-mp-publish="zhihu"' + rootAttr + '>' + body + '</section>';
  return { html: wrapped, links: planExternalLinks(body, { dedupe: true }) };
}

/** 静态 HTML 导出 / 预览用的文档包裹（`.mp-article` 是配方选择器的唯一根）。 */
export function articleDocument({ body, title = '', css = '', mathCss = '', kind = 'book', variant = 'light', sourceUrl = '', palette = null }) {
  const recipe = kind === 'report' ? 'report' : 'book';
  const publicUrl = publicArticleUrl(sourceUrl);   // 只认显式 http(s)：本机路径永不进 canonical
  const canonical = publicUrl ? '<link rel="canonical" href="' + escapeHtml(publicUrl) + '">\n' : '';
  const tone = variant === 'dark' ? 'dark' : 'light';
  const paper = palette || (EDITION_PAPERS[tone]);
  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; '
    + 'style-src \'unsafe-inline\'; img-src data: blob: file: https: http:; font-src data: file:; base-uri \'none\'; form-action \'none\'">\n'
    + '<title>' + escapeHtml(title || 'MarkPilot') + '</title>\n'
    + canonical
    + '<style>' + String(css || '') + '</style>\n'
    + (mathCss ? '<style>' + String(mathCss) + '</style>\n' : '')
    + '</head>\n<body style="background:' + escapeHtml(paper.bg) + '">\n'
    + '<div class="mp-article" data-mp-article-recipe="' + recipe + '" data-mp-article-variant="'
    + tone + '" style="color:' + escapeHtml(paper.fg) + ';background-color:' + escapeHtml(paper.bg) + '">\n'
    + String(body || '') + '\n</div>\n</body>\n</html>\n';
}

/** 预览用的最小摘要（面板显示，不参与正文）。 */
export function articleSummary(html, plan) {
  const text = String(html || '');
  const count = (re) => (text.match(re) || []).length;
  return {
    images: count(/<img\b/gi),
    formulas: count(/class="[^"]*mp-math/gi),
    diagrams: count(/class="[^"]*mp-mermaid/gi),
    tables: count(/<table\b/gi),
    footnotes: count(/class="[^"]*mp-fn-ref/gi),
    links: plan ? plan.length : count(/<a\b[^>]*href=/gi),
    chars: text.length,
  };
}

export { legacyStyles, styleString };

export default {
  applyInlineStyles, mergeStyle, planExternalLinks, linkNotesHtml,
  wechatArticleHtml, zhihuArticleHtml, articleDocument, articleSummary,
  parseAttrs, escapeHtml, decodeEntities, legacyStyles, LEGACY_INLINE_STYLES, publicArticleUrl,
  protectedRanges, mapOutsideProtected,
};
