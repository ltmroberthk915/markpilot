/* edition-math.js — 发布件里的公式/图表**自包含**表示（不依赖收件页面的 CSS）。
 *
 * 为什么必须做：微信/知乎的编辑器只在收件页保留**内联样式**与图片，外部样式表一律不带。
 * 实测反例：`$r^2$` 在空白页里变成“r2”，因为 KaTeX 的上标定位靠 `.vlist{display:inline-table}`
 * 那几条类规则（类名在、CSS 不在）。所以发布件必须把公式/图表换成**图片**：
 *   · 微信 ⇒ PNG（data URL），`alt` 带 TeX 源码；
 *   · 知乎 ⇒ SVG（data URL，foreignObject 里自带 KaTeX CSS）＋外层 `data-tex` 与 `alt`，
 *     知乎用它自己的渲染器重排；即使不重排，图片也是可读的。
 *
 * 设计纪律：
 *  · 只在**发布**路径调用（导出静态页仍用矢量 KaTeX + 自带 CSS）；复制/草稿/预览同一份结果；
 *  · 草稿：因为输出里已经没有 `.mp-math` 节点，对话框的栅格化不会再跑一次（不重复栅格化）；
 *  · 栅格化失败 ⇒ 节点原样保留并计入 `failed`，由调用方如实提示（不静默丢公式）；
 *  · 纯函数 + 注入的适配器 ⇒ Node 测试可用假适配器，浏览器用真实 canvas。
 */

const SCALE = 2;
const MAX_PIXELS = 16 * 1000 * 1000;
const MAX_ITEMS = 60;

/* 【图表尺寸真源】复用微信服务已验过的 mermaidSize（viewBox → 数值宽高 → 附着测量）。
   实测反例：样稿 SVG 是 `width="100%"`、无 height、`viewBox="0 0 250 70"`，而我们的 holder
   **从未挂进 DOM** ⇒ `getBoundingClientRect()` 恒为 0 ⇒ 第四个图表被跳过、仍留 <svg>。
   自己再写一份尺寸推断 = 第二把尺子（AGENTS 错-4），所以直接 import 同一份。 */
import { mermaidSize, svgViewBoxSize, svgNumericAttr } from './wechat-draft-dialog.js';

export function escapeXml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
export function base64OfBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64OfText(text) {
  const bytes = new TextEncoder().encode(String(text));
  return base64OfBytes(bytes);
}

/** 元素 → SVG（foreignObject 内嵌样式表；用于知乎的矢量表示，也用于 PNG 的栅格源）。 */
export function elementSvg(info, cssText) {
  const w = Math.max(1, Math.round(info.width * SCALE)), h = Math.max(1, Math.round(info.height * SCALE));
  const styleBlock = cssText ? '<style type="text/css">' + escapeXml(cssText) + '</style>' : '';
  const inner = '<div xmlns="http://www.w3.org/1999/xhtml" style="display:inline-block;background:#fff;color:#000;'
    + 'font-family:' + escapeXml(info.fontFamily) + ';font-size:' + escapeXml(info.fontSize) + ';'
    + 'line-height:' + escapeXml(info.lineHeight) + ';white-space:nowrap">' + (info.html || '') + '</div>';
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">'
    + '<rect width="100%" height="100%" fill="#ffffff"/>'
    + '<foreignObject x="0" y="0" width="' + w + '" height="' + h + '">' + styleBlock
    + '<div xmlns="http://www.w3.org/1999/xhtml" style="transform:scale(' + SCALE + ');transform-origin:0 0">' + inner + '</div>'
    + '</foreignObject></svg>';
}

/** 图表 SVG → 自包含 SVG（补 xmlns/宽高/白底/默认字体）。 */
export function diagramSvg(svgText, width, height) {
  let text = String(svgText || '');
  if (!/^\s*<svg/i.test(text)) return '';
  text = text.replace(/<svg\b([^>]*)>/i, (whole, attrs) => {
    let next = attrs;
    if (!/\bxmlns=/.test(next)) next += ' xmlns="http://www.w3.org/2000/svg"';
    next = next.replace(/\swidth="[^"]*"/i, '').replace(/\sheight="[^"]*"/i, '');
    next += ' width="' + Math.max(1, Math.round(width)) + '" height="' + Math.max(1, Math.round(height)) + '"';
    if (!/\bviewBox=/.test(next)) next += ' viewBox="0 0 ' + Math.max(1, Math.round(width)) + ' ' + Math.max(1, Math.round(height)) + '"';
    return '<svg' + next + '>';
  });
  const style = '<style type="text/css">text{font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif}</style>'
    + '<rect width="100%" height="100%" fill="#ffffff"/>';
  return text.replace(/(<svg\b[^>]*>)/i, '$1' + style);
}

/** TeX 源码：优先 data-mp-tex；退化到 KaTeX 的 annotation（同一份渲染结果里就有）。 */
export function texOf(node) {
  if (!node || typeof node.getAttribute !== 'function') return '';
  const direct = node.getAttribute('data-mp-tex');
  if (direct) return String(direct);
  const ann = node.querySelector && node.querySelector('annotation[encoding="application/x-tex"]');
  return ann ? String(ann.textContent || '') : '';
}

/** 图片标签（微信 PNG / 知乎 SVG）；alt 一律带 TeX 源码，便于无图环境仍能读出数学。 */
export function mathImageTag({ target, mime, base64, width, height, tex, display }) {
  const alt = escapeXml(tex || '');
  const data = 'data:' + mime + ';base64,' + base64;
  const box = ' style="max-width:100%;height:auto;vertical-align:' + (display ? 'middle' : 'baseline') + '"'
    + ' width="' + Math.max(1, Math.round(width)) + '" height="' + Math.max(1, Math.round(height)) + '"';
  if (target === 'zhihu') {
    return '<span class="ztext-math" data-tex="' + alt + '" data-display="' + (display ? 'block' : 'inline') + '">'
      + '<img class="mp-math-img" alt="' + alt + '" src="' + data + '"' + box + ' /></span>';
  }
  return '<img class="mp-math-img" alt="' + alt + '" src="' + data + '"' + box + ' />';
}

/**
 * 把发布片段里的公式/图表换成自包含表示。
 * @param {string} html 由 mdToHtml 渲染出的正文片段（含 .mp-math/.mp-math-block/.mp-mermaid）
 * @param {object} opts
 * @param {'wechat'|'zhihu'} opts.target
 * @param {{mathCss?:string, measure?:Function, rasterize?:Function, doc?:Document}} opts
 * @returns {Promise<{html:string, stats:{math:number,diagrams:number,rasterized:number,failed:Array}>}
 */
export async function selfContainMedia(html, opts = {}) {
  const target = opts.target === 'zhihu' ? 'zhihu' : 'wechat';
  const stats = { math: 0, diagrams: 0, rasterized: 0, failed: [] };
  let body = String(html == null ? '' : html);
  if (!body) return { html: body, stats };
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof doc.createElement !== 'function') return { html: body, stats };

  const holder = doc.createElement('div');
  holder.innerHTML = body;
  const mathNodes = [...holder.querySelectorAll('.mp-math-block, .mp-math')];
  const diagramNodes = [...holder.querySelectorAll('.mp-mermaid')];
  stats.math = mathNodes.length;
  stats.diagrams = diagramNodes.length;
  if (mathNodes.length + diagramNodes.length > MAX_ITEMS) {
    stats.failed.push({ label: '媒体', reason: '超过 ' + MAX_ITEMS + ' 项，请拆分文章' });
    return { html: holder.innerHTML, stats };
  }
  /* 公式：微信 PNG / 知乎自带样式的 SVG（两者都不依赖收件页 CSS）；
     图表：两种目标都转 PNG（外部编辑器会清洗 <svg>）。 */
  const canvas = target === 'wechat';

  for (const node of mathNodes) {
    const tex = texOf(node);
    const display = node.classList.contains('mp-math-block');
    try {
      const measured = typeof opts.measure === 'function'
        ? opts.measure(node, tex, display)
        : measureInPlace(node);
      if (!measured || !(measured.width > 0) || !(measured.height > 0)) throw new Error('量不到公式尺寸');
      if (measured.width * measured.height > MAX_PIXELS) throw new Error('公式图片过大');
      const svg = elementSvg(measured, opts.mathCss || '');
      if (canvas) {
        if (typeof opts.rasterize !== 'function') throw new Error('当前环境无法把公式转成图片');
        const png = await opts.rasterize({ svg, width: measured.width * SCALE, height: measured.height * SCALE, tex, display });
        node.replaceWith(documentFromHtml(doc, mathImageTag({
          target, mime: 'image/png', base64: base64OfBytes(png.bytes || png),
          width: measured.width, height: measured.height, tex, display,
        })));
      } else {
        node.replaceWith(documentFromHtml(doc, mathImageTag({
          target, mime: 'image/svg+xml', base64: base64OfText(svg),
          width: measured.width, height: measured.height, tex, display,
        })));
      }
      stats.rasterized++;
    } catch (error) {
      stats.failed.push({ label: display ? '块公式' : '行内公式', tex: tex.slice(0, 80), reason: String((error && error.message) || error) });
    }
  }

  for (const node of diagramNodes) {
    try {
      const svgEl = (node.querySelector && node.querySelector('svg')) || null;
      if (!svgEl) throw new Error('图表还没渲染出来（请稍候重试）');
      /* 离屏 holder 没有布局 ⇒ 不许只信 getBoundingClientRect；走 mermaidSize 的三级兜底。 */
      const size = mermaidSize(svgEl, node);
      if (!(size && size.width > 1 && size.height > 1)) throw new Error('图表尺寸为 0');
      if (size.width * size.height > MAX_PIXELS) throw new Error('图表过大（' + Math.round(size.width) + '×' + Math.round(size.height) + '）');
      const svgText = new XMLSerializer().serializeToString(svgEl);
      const normalized = diagramSvg(svgText, size.width, size.height);
      if (!normalized) throw new Error('图表不是 SVG');
      if (typeof opts.rasterize !== 'function') throw new Error('当前环境无法把图表转成图片');
      /* 【两种复制输出都要 PNG】外部编辑器（公众号/知乎）会清洗 <svg>，
         只留矢量图就是一张空白。这里统一走已验证的 SVG→PNG 栅格化；
         静态 HTML/PDF 不走这条链（那边仍用矢量 SVG）。 */
      const png = await opts.rasterize({ svg: normalized, width: size.width * SCALE, height: size.height * SCALE, tex: '', display: true });
      node.replaceWith(documentFromHtml(doc, '<img class="mp-diagram-img" alt="图表" src="data:image/png;base64,'
        + base64OfBytes(png.bytes || png) + '" width="' + Math.round(size.width) + '" height="' + Math.round(size.height)
        + '" style="max-width:100%;height:auto" />'));
      stats.rasterized++;
      stats.via = stats.via || {};
      stats.via[size.via || 'unknown'] = (stats.via[size.via || 'unknown'] || 0) + 1;
    } catch (error) {
      stats.failed.push({ label: '图表', reason: String((error && error.message) || error) });
    }
  }
  body = holder.innerHTML;
  return { html: body, stats };
}

function documentFromHtml(doc, htmlText) {
  const tpl = doc.createElement('template');
  tpl.innerHTML = htmlText;
  return tpl.content.firstElementChild;
}

/** 浏览器里的测量：按节点自身的计算字体克隆到"不可见但有布局"的容器里量。 */
export function measureInPlace(node) {
  const doc = node.ownerDocument || document;
  let host = doc.getElementById('mp-media-measure');
  if (!host) {
    host = doc.createElement('div');
    host.id = 'mp-media-measure';
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:absolute;left:-100000px;top:0;width:900px;visibility:hidden;pointer-events:none;background:#fff';
    (doc.body || doc.documentElement).appendChild(host);
  }
  const wrap = doc.createElement('div');
  const style = doc.defaultView.getComputedStyle(node);
  wrap.style.cssText = 'display:inline-block;background:#fff;color:#000;white-space:nowrap;'
    + 'font-family:' + (style.fontFamily || 'system-ui, sans-serif') + ';'
    + 'font-size:' + (style.fontSize || '16px') + ';'
    + 'line-height:' + (style.lineHeight || '1.5');
  const clone = node.cloneNode(true);
  for (const el of [clone, ...clone.querySelectorAll('*')]) {
    if (!el.attributes) continue;
    for (const name of [...el.attributes].map((a) => a.name)) {
      if (/^data-typora-source-/.test(name)) el.removeAttribute(name);
    }
  }
  wrap.appendChild(clone);
  host.appendChild(wrap);
  const rect = wrap.getBoundingClientRect();
  const info = {
    width: Math.max(1, Math.ceil(rect.width)),
    height: Math.max(1, Math.ceil(rect.height)),
    fontFamily: wrap.style.fontFamily, fontSize: wrap.style.fontSize, lineHeight: wrap.style.lineHeight,
    html: clone.outerHTML,
  };
  host.removeChild(wrap);
  return info;
}

/** 浏览器里的 PNG 栅格化（SVG → canvas → PNG 字节）。 */
export async function rasterizeSvgToPng({ svg, width, height }) {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
  if (w * h > MAX_PIXELS) throw new Error('图太大（' + w + '×' + h + ' 像素）');
  const img = new Image();
  img.src = 'data:image/svg+xml;base64,' + base64OfText(svg);
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise((resolve, reject) => cv.toBlob((b) => (b ? resolve(b) : reject(new Error('画布导出 PNG 失败'))), 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  cv.width = 0; cv.height = 0;
  return { bytes };
}

/** 浏览器默认适配器：发布路径直接用这一份。 */
export function browserMediaAdapter() {
  return { measure: null, rasterize: rasterizeSvgToPng };
}

export default {
  selfContainMedia, elementSvg, diagramSvg, texOf, mathImageTag,
  measureInPlace, rasterizeSvgToPng, browserMediaAdapter, escapeXml, base64OfText, base64OfBytes,
};
