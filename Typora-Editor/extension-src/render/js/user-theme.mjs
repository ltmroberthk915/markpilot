/** 把 **Typora 社区主题的 CSS** 改写成能作用在本编辑器上的样式（运行时版本）。
 *
 *  背景：Typora 主题的正文规则都挂在 `#write` 这个 id 上（Typora 的写作区），而我们的写作区是
 *  `.vditor-ir .vditor-reset`。仓库里早就有这条转换链——`tools/adapt_konayuki.cjs` 把
 *  Konayuki 的上游 CSS 改写成 `css/konayuki.css`（内置主题就是这么来的）——但它只在**打包时**跑，
 *  用户塞不进自己的主题。这个模块是同一套思路的**运行时**版本：用户在「主题」里选一个主题文件夹
 *  或粘一段 CSS，我们当场改写、注入。
 *
 *  与打包时那版的两处不同（有意为之，写清楚免得后人以为是漏改）：
 *   · 保留 `@media` / `@supports` 外壳，只改写里面的选择器。内置主题当时图省事直接丢了带 `@` 的规则，
 *     实测 MdmdT 这类主题有 15~16 个 `@media` 块，丢了就少一大截适配。
 *   · 保留 `:has()` 选择器（Chromium 支持；当时丢掉是因为 `#write:has(...)` 改写成
 *     `.vditor-reset:has(...)` 之后语义要重新确认，不是不能留）。`#write:has(x)` 只在"写作区里
 *     有 x"时生效，改写后语义一致。
 *
 *  **相对 `url(...)` 一律中和掉**：主题里的 `@font-face { src: url(./drake/font.woff2) }`、
 *  `background-image: url(img/bg.png)` 在 Typora 里相对主题文件夹解析，在这里相对的是我们的页面，
 *  必然 404——而 webview 里每次 404 都会往控制台抛错误（验收里"无 console 错误"是硬闸门）。
 *  所以：带相对 src 的 `@font-face` 整块丢掉，其它声明里的相对 `url()` 换成 `none`，
 *  两种都在报告里计数，导入提示里如实告诉用户"字体文件不会跟着走"。
 *
 *  纯函数、不碰 DOM：好测，也让调用方决定注入方式。
 */

/** 顶层按 `sep` 切分，尊重括号/引号/转义（选择器列表、`@import` 里都有逗号）。 */
const splitTopLevel = (text, sep = ',') => {
  const out = [];
  let depth = 0, quote = '', start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === sep && depth <= 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out.map(part => part.trim()).filter(Boolean);
};

/** 把一段 CSS 拆成顶层条目：`{prelude, body}` 的块，或 `{prelude, body: null}` 的语句/注释。 */
const topLevelItems = source => {
  const items = [];
  let i = 0;
  while (i < source.length) {
    // 注释原样留下（主题的许可证头就在注释里，不能因为我们改写就把它抹掉）
    if (source[i] === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      items.push({ prelude: source.slice(i, stop), body: null, comment: true });
      i = stop;
      continue;
    }
    if (/\s/.test(source[i])) { i++; continue; }
    const preludeStart = i;
    let quote = '';
    for (; i < source.length; i++) {
      const ch = source[i];
      if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (source[i] === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 1; continue; }
      if (ch === '{' || ch === ';') break;
    }
    const prelude = source.slice(preludeStart, i).trim();
    if (source[i] === ';' || i >= source.length) { if (prelude) items.push({ prelude, body: null }); i++; continue; }
    // 找到配对的 `}`
    let depth = 0, start = i, quote2 = '';
    for (; i < source.length; i++) {
      const ch = source[i];
      if (quote2) { if (ch === '\\') i++; else if (ch === quote2) quote2 = ''; continue; }
      if (ch === '"' || ch === "'") { quote2 = ch; continue; }
      if (ch === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 1; continue; }
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) break;
    }
    items.push({ prelude, body: source.slice(start + 1, i) });
    i++;
  }
  return items;
};

const URL_WITH_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/|data:|#)/i;
/** 中和声明里的相对 url()：换 `none`（合法值，且不会发起请求）。 */
const neutralizeRelativeUrls = body => {
  let count = 0;
  const out = body.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole, _q, target) => {
    if (!target.trim() || URL_WITH_SCHEME.test(target.trim())) return whole;
    count++;
    return 'none';
  });
  return { body: out, count };
};
const hasRelativeUrl = value => {
  let found = false;
  String(value).replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole, _q, target) => {
    if (target.trim() && !URL_WITH_SCHEME.test(target.trim())) found = true;
    return whole;
  });
  return found;
};

/**
 * @param {string} source 主题 CSS（已是能读到的全文，含注释与 license 头）
 * @param {object} options
 *   scope     作用域选择器（默认 `:root[data-user-theme]`）：`:root` 规则会挂到它上面
 *              —— 与内置主题把 `:root` 映射到 `:root[data-editor-theme=…]` 是同一个手法，
 *              主题定义的 CSS 变量因此照常生效，关掉主题只要摘掉这个属性。
 *   surface   `#write` 要落到的容器（默认 `.vditor-reset`）。
 * @returns {{css: string, report: object}}
 */
export const adaptTyporaTheme = (source, options = {}) => {
  const scope = options.scope || ':root[data-user-theme]';
  const surface = options.surface || '.vditor-reset';
  const report = { rules: 0, selectors: 0, droppedSelectors: 0, droppedAtRules: {}, fontFacesDropped: 0, urlsNeutralized: 0, mediaKept: 0 };

  const WRITE = /#write(?![-\w])/g;
  const rewriteSelector = selector => {
    const text = selector.trim();
    if (!text) return null;
    // `:root` 上的变量定义照搬（内置主题也是这么做的）：作用域挂到 scope 上，
    // 因此关掉主题只要把那个属性摘掉，页面上不留残迹。
    if (/^:root\b/.test(text)) return text.replace(/^:root/, scope);
    if (!WRITE.test(text)) { WRITE.lastIndex = 0; return null; }
    WRITE.lastIndex = 0;
    // `#write` 是 Typora 写作区的 id；我们的写作区是 surface。前面缀 scope 保证只在本主题作用域内生效。
    return scope + ' ' + text.replace(WRITE, surface);
  };
  const rewriteRule = (prelude, body) => {
    const kept = [];
    for (const selector of splitTopLevel(prelude)) {
      const next = rewriteSelector(selector);
      if (next) kept.push(next);
      else report.droppedSelectors++;
    }
    if (!kept.length) return '';
    report.selectors += kept.length;
    return kept.join(',\n') + '{' + body + '}\n';
  };

  const render = items => items.map(item => {
    const prelude = item.prelude;
    if (item.comment) return prelude + '\n';
    if (item.body === null) {
      // 语句形态：@import / @charset / @namespace 在运行时注入里都没有意义（相对路径解析不了）
      report.droppedAtRules[prelude.split(/\s/)[0]] = (report.droppedAtRules[prelude.split(/\s/)[0]] || 0) + 1;
      return '';
    }
    const lower = prelude.toLowerCase();
    if (lower.startsWith('@media') || lower.startsWith('@supports')) {
      const inner = render(topLevelItems(item.body));
      report.mediaKept++;
      return prelude + '{' + inner + '}';
    }
    if (lower.startsWith('@font-face')) {
      if (hasRelativeUrl(item.body)) { report.fontFacesDropped++; return ''; }
      report.rules++;
      return prelude + '{' + item.body + '}';
    }
    if (lower.startsWith('@')) {
      const name = prelude.split(/[\s{]/)[0];
      report.droppedAtRules[name] = (report.droppedAtRules[name] || 0) + 1;
      return '';
    }
    const { body, count } = neutralizeRelativeUrls(item.body);
    report.urlsNeutralized += count;
    const rule = rewriteRule(prelude, body);
    if (rule) report.rules++;
    return rule;
  }).join('');

  const css = render(topLevelItems(String(source || '')));
  return { css, report };
};

/**
 * 把主题文件夹里的 `@import` 就地展开——Typora 主题是**文件夹**（`drake.css` 里
 * `@import url(./drake/font.css)`，`vue.css` 里 `@import 'vue/fonts.css'`），浏览器给我们的只是
 * 一堆 File，路径信息可能只剩文件名（`webkitRelativePath` 不一定有）。所以按**路径后缀/文件名**
 * 两种方式找目标，找不到就如实记进 `missing`。带深度上限与环检测。
 *
 * @param {string} entry 入口文件名（如 'vue.css'）
 * @param {Array<{name: string, path?: string, text: string}>} files
 */
export const inlineThemeImports = (entry, files, options = {}) => {
  const maxDepth = options.maxDepth || 8;
  const byPath = new Map();
  for (const file of files) {
    const keys = [file.path, file.name].filter(Boolean).map(key => String(key).replace(/\\/g, '/').toLowerCase());
    for (const key of keys) if (!byPath.has(key)) byPath.set(key, file);
    const base = keys[keys.length - 1]?.split('/').pop();
    if (base && !byPath.has(base)) byPath.set(base, file);
  }
  const find = (from, target) => {
    const clean = String(target).replace(/^['"]|['"]$/g, '').trim().replace(/\\/g, '/');
    if (!clean || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(clean)) return { external: clean };
    const dir = String(from || '').replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    const joined = (dir ? dir + '/' : '') + clean;
    const normalized = joined.split('/').reduce((stack, part) => {
      if (part === '.' || part === '') return stack;
      if (part === '..') { stack.pop(); return stack; }
      stack.push(part);
      return stack;
    }, []).join('/');
    const candidates = [normalized, clean, normalized.split('/').pop(), clean.split('/').pop()];
    for (const candidate of candidates) {
      const hit = byPath.get(String(candidate).toLowerCase());
      if (hit) return { file: hit };
    }
    return { missing: clean };
  };
  const missing = [];
  const external = [];
  const seen = new Set();
  const expand = (name, text, depth) => {
    if (depth > maxDepth) return text;
    // 只认顶层、语句形态的 @import（块内的 @import 不合法）
    return String(text).replace(/(^|[;}\s])@import\s+(?:url\(\s*)?(['"]?)([^'");]+)\2\s*\)?\s*([^;{]*);/gi, (whole, lead, _q, target, media) => {
      if (media && media.trim()) { external.push({ target: target.trim(), media: media.trim() }); return whole; }
      const hit = find(name, target);
      if (hit.external) { external.push({ target: hit.external }); return ''; }
      if (hit.missing) { missing.push({ from: name, target: hit.missing }); return ''; }
      const key = String(hit.file.path || hit.file.name).toLowerCase();
      if (seen.has(key)) return '';                       // 环
      seen.add(key);
      return lead + expand(hit.file.path || hit.file.name, hit.file.text, depth + 1);
    });
  };
  seen.add(String(entry).toLowerCase());
  // 入口也要按"路径后缀/文件名"找：清单里的 entry 是相对主题目录的（`src/gitbook-azure.css`），
  // 而浏览器给过来的 path 可能带上一层目录（`gitbook/src/gitbook-azure.css`），或者干脆只有文件名。
  const entryLookup = byPath.get(String(entry).replace(/\\/g, '/').toLowerCase())
    || byPath.get(String(entry).toLowerCase())
    || find('', entry).file
    || files.find(file => String(file.name).toLowerCase() === String(entry).toLowerCase());
  const css = entryLookup ? expand(entryLookup.path || entryLookup.name, entryLookup.text, 0) : '';
  return { css, missing, external, entryFound: !!entryLookup };
};
