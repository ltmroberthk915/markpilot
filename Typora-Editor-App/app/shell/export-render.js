import {prepareMathMarkdown} from '/render/js/math-markdown.js';
import {typesetArticle} from '/render/js/knuth-plass.mjs';
prepareMathMarkdown();
const article = document.querySelector('#content');
const warnings = [];
// Knuth-Plass 文档级预算（二值跳过）：源 Markdown ≥300KB 或可排块 ≥1800 时整体跳过
// 精细断行，回退 export.css 的 CSS 两端对齐（与 HTML 导出同款排版）。实测依据：
// 696KB 源文本 / 2534 块文档全量 KP 使导出 worker RSS 峰值达 2608MB（KP 窗口内爬坡
// 853→2603MB）；170KB 教材基准 KP 全程 4.3s，阈值留足余量。取尺寸阈值而非时间预算，
// 保证同一文档在任何机器上的回退判定一致。块数与 typesetArticle 用同一选择器。
const KP_SKIP_SOURCE_BYTES = 300 * 1024;
const KP_SKIP_BLOCKS = 1800;
let sourceLength = 0;
const allowed = new Set('a p div span br hr h1 h2 h3 h4 h5 h6 blockquote pre code strong b em i s del u sub sup mark small kbd ul ol li dl dt dd table thead tbody tfoot tr th td caption img input details summary section nav'.split(' '));
const attrs = new Set('id class title alt width height colspan rowspan align start value reversed checked type href data-typora-align style'.split(' '));
// Typora 的缩放图把 zoom 写在 style 里（style="zoom:50%"）；导出白名单放行 style，
// 但只保留 zoom/width/height 三个子声明，且值限定为「数字 + 可选单位」——
// position/display/background:url() 等一切其它声明都是注入面，一律剥掉。
const styleKeep = /^(zoom|width|height)\s*:\s*\d+(?:\.\d+)?(?:%|px|em|rem|vw|vh)?\s*$/i;
function cleanStyle(value) {
  const kept = String(value).split(';').map(part => part.trim()).filter(part => styleKeep.test(part));
  return kept.length ? kept.join('; ') : null;
}
function sanitize(html) {
  const template = document.createElement('template');template.innerHTML = html;
  for (const node of template.content.querySelectorAll('*')) {
    if (!allowed.has(node.localName)) {node.remove();continue;}
    if (node.localName === 'img') {node.dataset.exportSrc = node.getAttribute('src') || '';node.removeAttribute('src');}
    for (const attr of [...node.attributes]) {
      if (node.localName === 'img' && attr.name === 'data-export-src') continue;
      if (attr.name === 'style') {const kept = cleanStyle(attr.value);if (kept) node.setAttribute('style', kept);else node.removeAttribute('style');continue;}
      if (!attrs.has(attr.name)) node.removeAttribute(attr.name);
    }
    if (node.hasAttribute('href')) {
      const href = node.getAttribute('href').replace(/[\u0000-\u0020]/g, '');
      if (/^[\w+.-]+:/.test(href) && !/^(https?:|mailto:|tel:)/i.test(href)) node.removeAttribute('href');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (node.localName === 'input') {node.type = 'checkbox';node.disabled = true;}
  }
  return template.content;
}
const load = src => new Promise((resolve, reject) => {
  const script = document.createElement('script');script.src = src;script.onload = resolve;script.onerror = () => reject(new Error('无法加载导出资源'));document.head.append(script);
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
window.prepareExport = async ({text, title, css, format}) => {
  document.title = title;
  sourceLength = text.length;
  if (format === 'pdf') {article.style.cssText='width:672px;padding:0;font-size:11pt';article.dataset.pdf='true';}
  const style = document.createElement('style');style.id = 'export-style';style.textContent = css;document.head.append(style);
  const html = await Vditor.md2html(text, {cdn:'/render/cdn/vditor', markdown:{toc:true}, math:{inlineDigit:true}});
  article.replaceChildren(sanitize(html));
  const formulas = [...article.querySelectorAll('.language-math')];
  if (formulas.length) {
    await load('/render/cdn/vditor/dist/js/katex/katex.min.js');
    await load('/render/cdn/vditor/dist/js/katex/mhchem.min.js');
    const macros = {};
    for (let i = 0; i < formulas.length; i++) {
      const node = formulas[i], source = node.textContent;
      try {katex.render(source, node, {displayMode:node.tagName === 'DIV', output:'htmlAndMathml', macros, throwOnError:true, trust:false});}
      catch (error) {node.classList.add('katex-error');node.title = error.message;warnings.push('公式未能渲染：' + source.slice(0, 100));}
      if (i % 32 === 31) await tick();
    }
  }
  const diagrams = [...article.querySelectorAll('.language-mermaid')];
  if (diagrams.length) {
    await load('/render/cdn/vditor/dist/js/mermaid/mermaid.min.js');
    mermaid.initialize({startOnLoad:false, securityLevel:'strict', theme:'default'});
    for (let i = 0; i < diagrams.length; i++) {
      const code = diagrams[i];
      try {
        const {svg} = await mermaid.render('export-diagram-' + i, code.textContent);
        const figure = document.createElement('div');figure.className = 'export-diagram';figure.innerHTML = svg;(code.parentElement.tagName === 'PRE' ? code.parentElement : code).replaceWith(figure);
      } catch {warnings.push('图表未能渲染，已保留源码');document.getElementById('dexport-diagram-' + i)?.remove();}
    }
  }
  if (article.querySelector('pre code')) {
    await load('/render/cdn/vditor/dist/js/highlight.js/highlight.min.js');
    for (const code of article.querySelectorAll('pre code')) {
      const language = [...code.classList].find(name => name.startsWith('language-'))?.slice(9);
      if (language && hljs.getLanguage(language)) hljs.highlightElement(code);
    }
  }
  return {images:[...article.querySelectorAll('img[data-export-src]')].map(node => node.dataset.exportSrc), formulas:formulas.length, diagrams:diagrams.length};
};
window.finishExport = async ({assets, assetWarnings}) => {
  warnings.push(...assetWarnings);
  for (const img of article.querySelectorAll('img[data-export-src]')) {
    const src = assets[img.dataset.exportSrc];delete img.dataset.exportSrc;
    if (src) img.src = src;
    else {const label = document.createElement('span');label.className = 'export-missing-image';label.textContent = '[图片未能嵌入' + (img.alt ? '：' + img.alt : '') + ']';img.replaceWith(label);}
  }
  // 图片按 4 张一批 decode（与主进程 embedImages 的 4 并发对称），避免全部解码位图
  // 同时驻留；批次串行推进、单张失败沿用逐张 catch 语义（一批失败不中断后续批）。
  // 不变量：全部批次完成才返回——printToPDF 前必须等所有图片就绪，否则打印帧缺图
  // （electron#16216）。
  const images = [...article.querySelectorAll('img')];
  for (let i = 0; i < images.length; i += 4) {
    await Promise.all(images.slice(i, i + 4).map(async img => {
      try {await img.decode();} catch {warnings.push('图片无法解码：' + img.alt);const label=document.createElement('span');label.className='export-missing-image';label.textContent='[图片无法解码：'+img.alt+']';img.replaceWith(label);}
    }));
  }
  await document.fonts.ready;
  // Measure in print media (including table columns), then fit unbreakable
  // formula groups. Otherwise Chromium shrinks the entire textbook to fit one
  // long inline equation, or the editor's horizontal scroller clips a cell.
  for (const node of article.dataset.pdf ? article.querySelectorAll('.language-math .katex') : []) {
    const box=node.closest('td,th,blockquote,li,p,article'),style=getComputedStyle(box);
    const limit=Math.min(672,box.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight));
    const html=node.querySelector('.katex-html');if(!html)continue;
    const range=document.createRange();range.selectNodeContents(html);
    const width=range.getBoundingClientRect().width;
    if (width > limit && limit > 0) node.style.fontSize = (parseFloat(getComputedStyle(node).fontSize)*limit/width) + 'px';
  }
  // v2.0.2: PDF gets true Knuth–Plass total-fit breaking on prose (the live
  // editor keeps browser justification — a contenteditable cannot hand line
  // breaking to an external engine). Failures fall back to CSS justify per
  // paragraph, never blocking the export.
  let kpSkipped = false;
  if (article.dataset.pdf) {
    // 超过文档级预算（阈值见文件顶部常量）：整体跳过 KP，不做部分降级——同一文档
    // 内 KP 与 CSS 两段式排版肉眼可辨。kpSkipped 回传主进程，供状态提示与
    // printToPDF 参数联动（同一判定，单点计算）。
    const blocks = article.querySelectorAll('p, li, blockquote p').length;
    if (sourceLength >= KP_SKIP_SOURCE_BYTES || blocks >= KP_SKIP_BLOCKS) {
      kpSkipped = true;
      warnings.push('超大文档兼容模式：已跳过精细断行（Knuth-Plass），改用标准两端对齐');
      window.__kpStats = {applied: 0, lines: 0, budgetSkipped: true};
    } else {
      try { window.__kpStats = typesetArticle(article, 'p, li, blockquote p'); }
      catch (error) { window.__kpStats = {applied: 0, fallback: {error: 1}, lines: 0}; }
    }
    // PDF 产物由主进程 printToPDF 直接打印活页面；克隆整棵 article 再 outerHTML
    // 序列化出的巨串只服务 HTML 分支，PDF 下是纯浪费的峰值内存（逐字 span 与图片
    // data-URL 会被再复制数份）。warnings/kpSkipped 仍须回传主进程。
    return {warnings, kpSkipped};
  }
  const out = document.implementation.createHTMLDocument(document.title);out.documentElement.lang='zh-CN';
  const charset = out.createElement('meta');charset.setAttribute('charset','utf-8');out.head.prepend(charset);
  const viewport=out.createElement('meta');viewport.name='viewport';viewport.content='width=device-width, initial-scale=1';out.head.append(viewport);
  const csp=out.createElement('meta');csp.httpEquiv='Content-Security-Policy';csp.content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";out.head.append(csp);
  out.head.append(document.getElementById('export-style').cloneNode(true));out.body.append(article.cloneNode(true));
  return {html:'<!doctype html>\n' + out.documentElement.outerHTML, warnings};
};
