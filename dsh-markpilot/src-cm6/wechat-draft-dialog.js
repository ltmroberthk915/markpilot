/**
 * 发送到公众号草稿箱 —— 渲染侧对话框（引擎 v3 / CM6）。
 *
 * 用法（集成方）：
 *   import { openWechatDraft } from './wechat-draft-dialog.js';
 *   await openWechatDraft({ getArticle, toast });
 *
 * 契约：
 *   · getArticle: async () => ({ title, html })；html 是**公开快照**渲染出来的正文片段
 *     （与「导出为 HTML / 复制为公众号格式」同一份投影，含 KaTeX 与 mermaid 的 DOM）。
 *     需要额外字段就通知主控，本模块不偷偷多读字段。
 *   · toast(text, ms, action)：引擎既有的提示条。
 *
 * 这一层只做**渲染侧能做的事**：把正文里的图片、公式、图表变成"可上传的表示"（PNG 或本地文件），
 * 生成 `mpwx:<id>` 占位，然后把最终请求交给宿主（window.mpHost.wx*）。真正的网络、凭据、
 * 草稿创建全在宿主里，渲染进程不接触 appid/secret，也不发任何请求（CSP connect-src 'none'）。
 *
 * 失败一律如实显示（不静默、不假装成功）；**没有任何"发布/群发"入口**——只建草稿。
 */

const MARKER_PREFIX = 'mpwx:';
const RASTER_SCALE = 2;
const MAX_RASTER_ITEMS = 60;
const MAX_RASTER_PIXELS = 16 * 1000 * 1000;      // 单张图 1600 万像素上限（canvas 兜底）
const MIN_INK_RATIO = 0.0004;                    // 空白自检：低于它就当"没画出来"

/* ── 纯字符串工具（可在 Node 里单测）──────────────────────────────────────────── */

/** 图片地址分类：local（相对/file:/绝对路径）/ data / remote / other（blob: 等）。 */
export function classifyImageSrc(src) {
  const s = String(src == null ? '' : src).trim();
  if (!s) return 'other';
  if (/^data:image\/(?:png|jpeg|jpg);base64,/i.test(s)) return 'data';
  if (/^data:/i.test(s)) return 'other';
  if (/^(?:https?:)?\/\//i.test(s)) return 'remote';
  if (/^(?:blob:|about:|javascript:)/i.test(s)) return 'other';
  return 'local';
}

/** 遍历 html 里的 `<img …>` 标签（只动 start tag，不动正文其余字节）。 */
export function mapImgTags(html, fn) {
  let index = 0;
  return String(html == null ? '' : html).replace(/<img\b[^>]*>/gi, (tag) => {
    const out = fn(tag, index++);
    return out == null ? tag : out;
  });
}

/** 读取 start tag 的某个属性值（双引号/单引号/裸值三种都认）。 */
export function attrOf(tag, name) {
  const re = new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>=]+))', 'i');
  const m = re.exec(String(tag || ''));
  return m ? (m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] || '') : null;
}

/** 把某个 src 值换成占位（只替换 **完整属性值**，不会误伤正文里同样的字符串）。 */
export function replaceImgSrc(tag, nextSrc) {
  return String(tag).replace(/(\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i, (_m, head) => `${head}"${nextSrc}"`);
}

/**
 * 把正文里的图片分成「可上传」与「必须拦下」两类，并给可上传的换成占位。
 * 返回 { html, images:[{id, src}], blocked:[{src, host, reason}] }。
 *  · 本地图片与 data: 图片都换成 `mpwx:<id>` 占位（宿主读字节 → 微信 CDN）；
 *  · 远程/其它（http、blob、svg、无效地址）**原样不动**，交给宿主 preflight 如实拒绝
 *    ——这里不下载任何东西，也不把远程地址变成宿主读盘路径。
 */
export function prepareArticleImages(html) {
  const images = [];
  const blocked = [];
  const seen = new Map();
  const out = mapImgTags(html, (tag) => {
    const src = attrOf(tag, 'src');
    if (src == null || !src.trim()) { blocked.push({ src: '', host: null, reason: 'no-src' }); return null; }
    const kind = classifyImageSrc(src);
    if (kind === 'remote') {
      let host = null;
      try { host = new URL(src.startsWith('//') ? 'https:' + src : src).hostname.toLowerCase(); } catch { host = null; }
      blocked.push({ src: src.slice(0, 200), host, reason: 'remote' });
      return null;
    }
    if (kind === 'other') { blocked.push({ src: src.slice(0, 200), host: null, reason: 'unsupported' }); return null; }
    let id = seen.get(src);
    if (!id) {
      id = 'img' + (images.length + 1);
      seen.set(src, id);
      images.push({ id, src });
    }
    return replaceImgSrc(tag, MARKER_PREFIX + id);
  });
  return { html: out, images, blocked };
}

/* ── 渲染侧：公式 / 图表 → PNG（可上传表示）────────────────────────────────────── */

function base64OfBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function pngBytesOfCanvas(canvas) {
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画布导出 PNG 失败'))), 'image/png');
  });
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

/** 空白自检：数一数画布上"有墨"的像素。空白图上传上去只会让读者看到一块白。 */
function inkRatioOfCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let ink = 0, total = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 400000)));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      total++;
      const a = data[i + 3];
      if (a < 8) continue;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum < 245) ink++;
    }
  }
  return total ? ink / total : 0;
}

/** SVG 文本 → PNG 字节（`<img src="data:image/svg+xml;base64,…">` → canvas）。 */
async function svgToPng(svgText, { width, height } = {}) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (w * h > MAX_RASTER_PIXELS) throw new Error(`图太大（${w}×${h} 像素），请缩小后再发送`);
  const encoded = 'data:image/svg+xml;base64,' + base64OfBytes(new TextEncoder().encode(svgText));
  const img = new Image();
  img.src = encoded;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const ink = inkRatioOfCanvas(canvas);
  if (ink < MIN_INK_RATIO) { canvas.width = 0; canvas.height = 0; throw new Error('转换出来的图片是空白（渲染环境可能不可用）'); }
  const bytes = await pngBytesOfCanvas(canvas);
  canvas.width = 0; canvas.height = 0;
  return { bytes, width: w, height: h, ink };
}

function escapeXmlText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 离屏但**有布局**的测量容器（display:none 会让依赖布局的排版量不到东西）。
 *  没有可用的 document（宿主不完整/已卸载）时返回 null —— 调用方要按"量不到"处理，
 *  而不是在这里抛错（尺寸问题必须由**第一道 viewBox 判据**回答，测量只是最后手段）。 */
function measureHost() {
  if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') return null;
  let host = document.getElementById('mpwx-measure');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'mpwx-measure';
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:absolute;left:-100000px;top:0;width:900px;visibility:hidden;pointer-events:none;background:#fff';
  document.body.appendChild(host);
  return host;
}
function releaseMeasureHost() {
  const host = document.getElementById('mpwx-measure');
  if (host && host.parentNode) host.parentNode.removeChild(host);
}

/** KaTeX/正文元素的字体环境：克隆到测量容器后再量，量完把尺寸带出去。 */
function measureClone(node) {
  const host = measureHost();
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:inline-block;background:#fff;color:#000';
  const style = getComputedStyle(node);
  wrap.style.fontFamily = style.fontFamily || 'system-ui, sans-serif';
  wrap.style.fontSize = style.fontSize || '16px';
  wrap.style.lineHeight = style.lineHeight || '1.5';
  wrap.style.whiteSpace = 'nowrap';
  const clone = node.cloneNode(true);
  // 取证/投影属性对静态图没用，剥离后体积小一半（与导出页同口径）。
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
    fontFamily: wrap.style.fontFamily,
    fontSize: wrap.style.fontSize,
    lineHeight: wrap.style.lineHeight,
    html: clone.outerHTML,
  };
  host.removeChild(wrap);
  return info;
}

/** 元素 → 内联样式的 SVG（foreignObject）。样式表由 mathCss 传入（KaTeX CSS＋data: 字体）。 */
function elementToSvg(info, cssText) {
  const w = info.width * RASTER_SCALE, h = info.height * RASTER_SCALE;
  const styleBlock = cssText ? `<style type="text/css">${escapeXmlText(cssText)}</style>` : '';
  const inner = `<div xmlns="http://www.w3.org/1999/xhtml" style="display:inline-block;background:#fff;color:#000;`
    + `font-family:${escapeXmlText(info.fontFamily)};font-size:${escapeXmlText(info.fontSize)};line-height:${escapeXmlText(info.lineHeight)};`
    + `white-space:nowrap">${info.html}</div>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<rect width="100%" height="100%" fill="#ffffff"/>`
    + `<foreignObject x="0" y="0" width="${w}" height="${h}">${styleBlock}`
    + `<div xmlns="http://www.w3.org/1999/xhtml" style="transform:scale(${RASTER_SCALE});transform-origin:0 0">${inner}</div>`
    + '</foreignObject></svg>';
}

/** 从 SVG 的 `viewBox` 里取**可信数值尺寸**（mermaid 的真实产物就是这么带尺寸的）。
 *  实测真实导出：`<svg width="100%" viewBox="0.0000038 0.0000057 250.00001525878906 70">`
 *  —— 没有 height、width 是百分比，`getBoundingClientRect()` 在 detached 的 holder 上恒为 0。
 *  所以尺寸**优先取 viewBox 的后两个数**，而不是测量。返回 null 表示没有可信尺寸。 */
export function svgViewBoxSize(svgEl) {
  const raw = String((svgEl && svgEl.getAttribute && svgEl.getAttribute('viewBox')) || '').trim();
  if (!raw) return null;
  const nums = raw.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
  if (nums.length !== 4) return null;
  const w = nums[2], h = nums[3];
  if (!(w > 1) || !(h > 1)) return null;
  return { x: nums[0], y: nums[1], width: w, height: h };
}

/** 数值宽高属性（px / 无单位）——mermaid 有时给 `width="250"` 而不是 viewBox。 */
export function svgNumericAttr(svgEl, name) {
  const v = String((svgEl && svgEl.getAttribute && svgEl.getAttribute(name)) || '').trim();
  if (!/^\d+(?:\.\d+)?(?:px)?$/.test(v)) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 1 ? n : null;
}

/** mermaid 图的尺寸：viewBox 优先 → 数值宽高 → 附着到页面上真实测量（最后手段）。
 *  返回 { width, height, via }；拿不到就返回 { width:0, height:0, via:'none' }。 */
export function mermaidSize(svgEl, node) {
  const vb = svgViewBoxSize(svgEl);
  if (vb) return { width: Math.ceil(vb.width), height: Math.ceil(vb.height), via: 'viewBox', viewBox: vb };
  const w = svgNumericAttr(svgEl, 'width'), h = svgNumericAttr(svgEl, 'height');
  if (w && h) return { width: Math.ceil(w), height: Math.ceil(h), via: 'attrs' };
  /* 最后手段：把节点临时挂到**有布局**的离屏容器里量一次（display:none 量不到，见 typography 的教训）。 */
  let rect = null;
  try { rect = svgEl.getBoundingClientRect(); } catch { rect = null; }
  if (rect && rect.width > 1 && rect.height > 1) return { width: Math.ceil(rect.width), height: Math.ceil(rect.height), via: 'attached-rect' };
  let host = null;
  try { host = measureHost(); } catch { host = null; }
  if (host) {
    let detached = false;
    try {
      if (!node.isConnected) { host.appendChild(node); detached = true; }
      rect = svgEl.getBoundingClientRect();
      if (rect && rect.width > 1 && rect.height > 1) return { width: Math.ceil(rect.width), height: Math.ceil(rect.height), via: 'detached-measure' };
    } catch { /* 量不到就按下面的失败走 */ }
    finally { if (detached && node.parentNode) node.parentNode.removeChild(node); }
  }
  return { width: 0, height: 0, via: 'none' };
}

/** 归一化时要写死的三个属性（纯计算，可在 Node 里直接测）。
 *  关键：宽高必须是**数值**——真实 mermaid 产物是 `width="100%"`、无 height，这种形态在
 *  `<img src="data:image/svg+xml,…">` 里固有尺寸为 0（canvas 画出来就是空白）。 */
export function mermaidSvgAttrs(svgEl, size) {
  const vb = size.viewBox || svgViewBoxSize(svgEl);
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  return {
    width: String(width),
    height: String(height),
    viewBox: vb ? `${vb.x} ${vb.y} ${vb.width} ${vb.height}` : `0 0 ${width} ${height}`,
  };
}

/** mermaid 的 SVG：补 xmlns / 用**可信尺寸**写死宽高 / 白底，再交给 canvas 栅格化。 */
export function normalizeMermaidSvg(svgEl, size) {
  const attrs = mermaidSvgAttrs(svgEl, size);
  const clone = svgEl.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!clone.getAttribute('xmlns:xlink')) clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('width', attrs.width);
  clone.setAttribute('height', attrs.height);
  clone.setAttribute('viewBox', attrs.viewBox);
  /* 原图上的 `style="max-width:…px"` 会参与 <img> 的固有尺寸计算，留着可能把图压扁。 */
  clone.removeAttribute('style');
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = 'text{font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif}';
  clone.insertBefore(style, clone.firstChild);
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('width', '100%'); rect.setAttribute('height', '100%'); rect.setAttribute('fill', '#ffffff');
  clone.insertBefore(rect, style.nextSibling);
  return { svg: new XMLSerializer().serializeToString(clone), width: Number(attrs.width), height: Number(attrs.height) };
}

/** 用一段 HTML 内容替换一个节点（只替换该节点本身，不重新解析整篇）。 */
function replaceNodeWithImage(node, imgHtml) {
  const tpl = document.createElement('template');
  tpl.innerHTML = imgHtml;
  const el = tpl.content.firstElementChild;
  if (!el) throw new Error('生成图片占位失败');
  node.replaceWith(el);
  return el;
}

/** 把正文里的公式/图表换成 PNG 占位（返回新的 html + 待上传图片 + 失败清单）。
 *  opts.math=false 时**完全不碰公式相关代码**（如 KaTeX 样式缺失的纯图表文档）；
 *  opts.diagram=false 时同理跳过图表。两条线各自独立，互相当前提。 */
async function rasterizeRichContent(html, { mathCss, math = true, diagram = true } = {}) {
  const holder = document.createElement('div');
  holder.innerHTML = String(html || '');
  const images = [];
  const failures = [];
  let serial = 0;
  const push = async (label, bytes, width, height) => {
    const id = 'fig' + (++serial);
    images.push({ id, src: 'data:image/png;base64,' + base64OfBytes(bytes), width, height, label });
    return `<img alt="${escapeXmlText(label)}" src="${MARKER_PREFIX}${id}" data-mpwx-figure="${id}" width="${width}" />`;
  };
  if (math) for (const node of [...holder.querySelectorAll('.mp-math-block, .mp-math')]) {
    if (!holder.contains(node)) continue;
    if (images.length >= MAX_RASTER_ITEMS) { failures.push({ label: '公式', reason: `超过 ${MAX_RASTER_ITEMS} 张图，请拆分文章` }); break; }
    try {
      const target = node.querySelector('.katex') || node;
      if (!target || !target.getBoundingClientRect) throw new Error('找不到公式内容');
      const info = measureClone(target);
      const png = await svgToPng(elementToSvg(info, mathCss), { width: info.width * RASTER_SCALE, height: info.height * RASTER_SCALE });
      replaceNodeWithImage(node, await push('公式', png.bytes, info.width, info.height));
    } catch (error) {
      failures.push({ label: '公式', reason: String((error && error.message) || error) });
    }
  }
  if (diagram) for (const node of [...holder.querySelectorAll('.mp-mermaid')]) {
    if (!holder.contains(node)) continue;
    if (images.length >= MAX_RASTER_ITEMS) { failures.push({ label: '图表', reason: `超过 ${MAX_RASTER_ITEMS} 张图，请拆分文章` }); break; }
    try {
      const svgEl = node.querySelector('svg');
      if (!svgEl) throw new Error('图表还没渲染出来（请稍候重试）');
      /* 尺寸取 viewBox（真实 mermaid 产物就有），量不到才退到附着测量。
         detached holder 上 getBoundingClientRect 恒为 0 —— 那就是"图表尺寸为 0"的来源。 */
      const size = mermaidSize(svgEl, node);
      if (!(size.width > 1 && size.height > 1)) {
        throw new Error('图表没有可用的尺寸（viewBox 与宽高属性都缺失，附着后也量不到）');
      }
      const norm = normalizeMermaidSvg(svgEl, size);
      const png = await svgToPng(norm.svg, { width: norm.width * RASTER_SCALE, height: norm.height * RASTER_SCALE });
      replaceNodeWithImage(node, await push('图表', png.bytes, norm.width, norm.height));
    } catch (error) {
      failures.push({ label: '图表', reason: String((error && error.message) || error) });
    }
  }
  releaseMeasureHost();
  return { html: holder.innerHTML, images, failures };
}

/* ── 对话框 ──────────────────────────────────────────────────────────────────── */

const CSS = `
.mpwx-dlg{position:fixed;z-index:72;left:50%;top:50%;transform:translate(-50%,-50%);width:min(680px,92vw);max-height:88vh;overflow:auto;
  background:var(--mp-bg,#fff);color:var(--mp-fg,#222);border:1px solid var(--mp-border,#ddd);border-radius:10px;
  box-shadow:0 12px 40px rgba(0,0,0,.28);padding:16px 18px;font:13px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif}
.mpwx-dlg h3{margin:0 0 4px;font-size:15px;padding-right:28px}
.mpwx-dlg .mpwx-close{position:absolute;right:10px;top:8px;width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:15px}
.mpwx-dlg .mpwx-close:hover{background:color-mix(in srgb,var(--mp-fg,#222) 12%,transparent)}
.mpwx-dlg p{margin:6px 0}
.mpwx-dlg .mpwx-k{color:var(--mp-muted,#777);font-size:12px}
.mpwx-dlg label{display:block;margin:8px 0 2px;font-size:12px;color:var(--mp-muted,#777)}
.mpwx-dlg input[type=text],.mpwx-dlg input[type=password],.mpwx-dlg textarea{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--mp-border,#ddd);
  border-radius:6px;background:var(--mp-bg,#fff);color:inherit;font:inherit}
.mpwx-dlg .mpwx-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}
.mpwx-dlg button{font:inherit;padding:5px 12px;border:1px solid var(--mp-border,#ddd);border-radius:6px;background:transparent;color:inherit;cursor:pointer}
.mpwx-dlg button:hover:not(:disabled){background:color-mix(in srgb,var(--mp-fg,#222) 10%,transparent)}
.mpwx-dlg button:disabled{opacity:.55;cursor:not-allowed}
.mpwx-dlg button.mpwx-primary{background:var(--mp-primary,#3b82f6);border-color:transparent;color:#fff}
.mpwx-dlg .mpwx-status{padding:7px 10px;border-radius:6px;background:color-mix(in srgb,var(--mp-fg,#222) 6%,transparent);margin:8px 0}
.mpwx-dlg .mpwx-err{color:#b3261e;white-space:pre-wrap;margin:8px 0}
.mpwx-dlg .mpwx-ok{color:#1b6e3a}
.mpwx-dlg .mpwx-warn{color:#8a5a00;background:color-mix(in srgb,#f5b301 18%,transparent);padding:8px 10px;border-radius:6px;white-space:pre-wrap}
.mpwx-dlg .mpwx-cover{display:flex;gap:10px;align-items:center;margin:6px 0}
.mpwx-dlg .mpwx-cover img{max-width:150px;max-height:90px;border:1px solid var(--mp-border,#ddd);border-radius:6px;background:#fff}
.mpwx-dlg ul{margin:4px 0 4px 18px;padding:0}
.mpwx-dlg code{background:color-mix(in srgb,var(--mp-fg,#222) 8%,transparent);padding:1px 4px;border-radius:4px;font-size:12px}
@media (prefers-color-scheme: dark){
  .mpwx-dlg{background:var(--mp-bg,#1f2126);color:var(--mp-fg,#ddd)}
}
`;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function installCss() {
  if (document.getElementById('mpwx-style')) return;
  const style = document.createElement('style');
  style.id = 'mpwx-style';
  style.textContent = CSS;
  document.head.appendChild(style);
}

function hostApi() {
  const h = typeof window !== 'undefined' ? window.mpHost : null;
  if (!h || typeof h.wxStatus !== 'function') return null;
  return h;
}

/** 打开对话框。返回 Promise<{ok:boolean, mediaId?:string, error?:string}>，永不抛给调用方。 */
export async function openWechatDraft({ getArticle, toast } = {}) {
  const say = typeof toast === 'function' ? toast : (text) => { try { console.info('[mpwx]', text); } catch { /* 忽略 */ } };
  const host = hostApi();
  if (!host) { say('发送到公众号草稿箱需要 MarkPilot 桌面版 3.7.1 及以上'); return { ok: false, error: 'host-unavailable' }; }
  if (typeof getArticle !== 'function') { say('发送失败：没有拿到正文'); return { ok: false, error: 'no-article' }; }
  installCss();

  let article;
  try { article = await getArticle(); }
  catch (error) { say('发送失败：' + ((error && error.message) || error)); return { ok: false, error: String((error && error.message) || error) }; }
  const rawHtml = String((article && article.html) || '');
  const rawTitle = String((article && article.title) || '');
  if (!rawHtml.trim()) { say('发送失败：正文是空的'); return { ok: false, error: 'empty' }; }

  const prepared = prepareArticleImages(rawHtml);
  const blocked = prepared.blocked;

  /* 公式 / 图表 → PNG。两条线**彼此独立**：
   *  · 公式需要 KaTeX 样式（字体 data URL 内联在 CSS 里，栅格化才有正确字形）⇒ 取不到就停；
   *  · 图表是**自带样式的 SVG**（mermaid 把样式写进 <style>），完全不需要 KaTeX——
   *    实测缺陷：只含 mermaid、没有公式的文档曾因为"KaTeX 样式表不可用"被整篇拦下 ✗。
   *    这里按"正文里有没有公式"决定是否要 KaTeX 样式，图表照常走。 */
  let rich = { html: prepared.html, images: [], failures: [] };
  const hasMath = /class="[^"]*mp-math/.test(prepared.html);
  const hasDiagram = /class="[^"]*mp-mermaid/.test(prepared.html);
  if (hasMath || hasDiagram) {
    let mathCss = '';
    if (hasMath) {
      try { mathCss = (window.mpExtras && typeof window.mpExtras.buildMathCss === 'function') ? await window.mpExtras.buildMathCss() : ''; }
      catch { mathCss = ''; }
      if (!mathCss) {
        say('发送已停止：取不到公式样式（KaTeX 样式表不可用），直接上传会得到排版错乱的公式图');
        return { ok: false, error: 'math-css' };
      }
    }
    try { rich = await rasterizeRichContent(prepared.html, { mathCss, math: hasMath, diagram: hasDiagram }); }
    catch (error) {
      say('发送已停止：' + ((error && error.message) || error));
      return { ok: false, error: String((error && error.message) || error) };
    }
  }
  const images = [...prepared.images, ...rich.images.map(({ id, src }) => ({ id, src }))];
  const html = rich.html;

  return new Promise((resolve) => {
    let closed = false;
    let busy = false;
    let coverId = null;
    let coverInfo = null;
    let pendingInfo = null;
    let statusInfo = null;

    const dlg = document.createElement('div');
    dlg.className = 'mpwx-dlg';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', '发送到公众号草稿箱');
    dlg.innerHTML = `
      <button type="button" class="mpwx-close" aria-label="关闭">✕</button>
      <h3>发送到公众号草稿箱</h3>
      <p class="mpwx-k">只创建草稿，不会发布、也不会群发。发完之后由你到公众号后台自行确认并发布。</p>
      <div class="mpwx-status" data-role="status">正在读取公众号配置…</div>
      <div data-role="config" hidden>
        <label for="mpwx-appid">公众号 appid</label>
        <input id="mpwx-appid" type="text" autocomplete="off" spellcheck="false" placeholder="wx…（公众号后台 → 开发 → 基本配置）" />
        <label for="mpwx-secret">AppSecret（只保存在本机，用系统密钥库加密）</label>
        <input id="mpwx-secret" type="password" autocomplete="off" spellcheck="false" placeholder="32 位字母数字" />
        <div class="mpwx-row">
          <button type="button" data-role="save-cred" class="mpwx-primary">保存配置</button>
          <button type="button" data-role="verify">验证配置</button>
          <button type="button" data-role="clear-cred">清除配置</button>
        </div>
        <p class="mpwx-k">AppSecret 只在宿主进程里使用；界面与日志都不会显示它。不想用了随时可以点「清除配置」。</p>
      </div>
      <div data-role="main" hidden>
        <label for="mpwx-title">标题</label>
        <input id="mpwx-title" type="text" maxlength="64" />
        <label>封面（微信草稿必须带封面）</label>
        <div class="mpwx-cover" data-role="cover-box">
          <button type="button" data-role="pick-cover">选择本地图片…</button>
          <span class="mpwx-k" data-role="cover-note">还没有选择</span>
        </div>
        <label for="mpwx-author">作者（可选，≤16 字）</label>
        <input id="mpwx-author" type="text" maxlength="16" />
        <div class="mpwx-warn" data-role="pending" hidden></div>
        <div class="mpwx-warn" data-role="blocked" hidden></div>
        <div class="mpwx-err" data-role="error" hidden></div>
        <p class="mpwx-k" data-role="summary"></p>
        <div class="mpwx-row">
          <button type="button" data-role="send" class="mpwx-primary">发送到草稿箱</button>
          <button type="button" data-role="cancel">取消</button>
          <span class="mpwx-k" data-role="busy" hidden>正在发送…请不要关闭窗口</span>
        </div>
      </div>`;
    document.body.appendChild(dlg);

    const $ = (role) => dlg.querySelector(`[data-role="${role}"]`);
    const setError = (text) => { const el = $('error'); if (!el) return; el.hidden = !text; el.textContent = text || ''; };
    const finish = (result) => {
      if (closed) return;
      closed = true;
      try { dlg.remove(); } catch { /* 已移除 */ }
      resolve(result);
    };
    const close = () => {
      if (busy) { say('正在发送，请等这次结束'); return; }
      finish({ ok: false, canceled: true });
    };

    const titleInput = dlg.querySelector('#mpwx-title');
    const authorInput = dlg.querySelector('#mpwx-author');
    titleInput.value = rawTitle;
    authorInput.value = String((article && article.author) || '');

    const refreshSummary = () => {
      $('summary').textContent = `正文 ${html.length} 字符 · 图片 ${images.length} 张${coverId ? ' · 封面已选' : ' · 还没有封面'}`;
    };
    refreshSummary();

    if (blocked.length) {
      const box = $('blocked');
      box.hidden = false;
      const hosts = [...new Set(blocked.map((b) => b.host).filter(Boolean))];
      box.textContent = `正文里有 ${blocked.length} 张图片不是本地文件（${hosts.slice(0, 3).join('、') || '不支持的地址'}${hosts.length > 3 ? ' 等' : ''}）。`
        + '公众号只接受上传过的图片，本工具不会替你下载外链；请先把这些图保存到文档目录或直接粘贴进文档。';
    }
    if (rich.failures.length) {
      const box = $('blocked');
      box.hidden = false;
      box.textContent = (box.textContent || '') + `\n有 ${rich.failures.length} 处公式/图表转换失败：` + rich.failures.map((f) => `${f.label}（${f.reason}）`).join('；') + '。发送会被拦下，请先处理这些内容。';
    }

    const applyStatus = (st) => {
      statusInfo = st;
      const configured = !!(st && st.configured);
      const problem = st && st.problem ? st.problem : null;
      const status = $('status');
      if (configured) {
        status.innerHTML = `已配置公众号 <code>${esc(st.appId || '')}</code>${st.keystore ? '' : '（系统密钥库不可用）'}`;
        $('config').hidden = true;
        $('main').hidden = false;
        $('summary').textContent = `正文 ${html.length} 字符 · 图片 ${images.length} 张${coverId ? ' · 封面已选' : ' · 还没有封面'}`;
      } else {
        status.innerHTML = problem
          ? `公众号配置不可用：${esc(problem.error || '未知原因')}`
          : '还没有配置公众号。填入 appid 与 AppSecret 后点「保存配置」（只存本机）。';
        $('config').hidden = false;
        $('main').hidden = true;
      }
      pendingInfo = st && st.pending ? st.pending : null;
      const pendingBox = $('pending');
      if (pendingInfo) {
        pendingBox.hidden = false;
        pendingBox.innerHTML = `上次（${esc(pendingInfo.at || '未知时间')}）创建草稿的结果不明确：草稿可能已经建好。<br>请先打开公众号后台 → 草稿箱核对；确认后勾选下面的框再发送。`
          + '<br><label style="display:inline"><input type="checkbox" data-role="ack" /> 我已核对草稿箱</label>';
      } else {
        pendingBox.hidden = true;
        pendingBox.innerHTML = '';
      }
    };

    const loadStatus = async () => {
      try { applyStatus(await host.wxStatus()); }
      catch (error) { $('status').textContent = '读取公众号配置失败：' + ((error && error.message) || error); }
    };
    void loadStatus();

    dlg.querySelector('.mpwx-close').onclick = close;
    $('cancel').onclick = close;
    dlg.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !busy) { event.preventDefault(); close(); } }, true);

    $('save-cred').onclick = async () => {
      setError('');
      const appId = String(dlg.querySelector('#mpwx-appid').value || '').trim();
      const secret = String(dlg.querySelector('#mpwx-secret').value || '').trim();
      const r = await host.wxConfigure({ appId, secret });
      dlg.querySelector('#mpwx-secret').value = '';
      if (!r || !r.ok) { setError((r && r.error) || '保存失败'); return; }
      await loadStatus();
      say('公众号配置已保存（secret 已加密存本机）');
    };
    $('verify').onclick = async () => {
      setError('');
      const status = $('status');
      const before = status.textContent;
      status.textContent = '正在验证（会向微信取一次接口凭据）…';
      let r;
      try { r = await host.wxVerify(); } catch (error) { r = { ok: false, error: String((error && error.message) || error) }; }
      if (r && r.ok) { status.textContent = `验证通过：公众号 ${esc(r.appId || '')}，草稿总数 ${r.total == null ? '未知' : r.total}`; }
      else { status.textContent = before; setError('验证失败：' + ((r && r.error) || '未知错误')); }
    };
    $('clear-cred').onclick = async () => {
      setError('');
      const r = await host.wxClear();
      if (!r || !r.ok) { setError((r && r.error) || '清除失败'); return; }
      coverId = null; coverInfo = null;
      await loadStatus();
      say('已清除本机保存的公众号配置');
    };

    $('pick-cover').onclick = async () => {
      setError('');
      let r;
      try { r = await host.wxPickCover(); } catch (error) { r = { ok: false, error: String((error && error.message) || error) }; }
      if (!r || !r.ok) {
        if (!(r && r.canceled)) setError('选择封面失败：' + ((r && r.error) || '未知错误'));
        return;
      }
      coverId = r.id;
      coverInfo = r;
      const box = $('cover-box');
      const old = box.querySelector('img');
      if (old) old.remove();
      if (r.dataUrl) {
        const img = document.createElement('img');
        img.src = r.dataUrl;
        img.alt = '封面预览';
        box.appendChild(img);
      }
      $('cover-note').textContent = `${r.name || '封面'} · ${Math.round((r.bytes || 0) / 1024)} KB${r.width ? ` · ${r.width}×${r.height}` : ''}`;
      refreshSummary();
    };

    $('send').onclick = async () => {
      if (busy) return;
      setError('');
      if (blocked.length) { setError('正文里还有不能发送的图片，请先处理上面的提示'); return; }
      if (rich.failures.length) { setError('有公式/图表没转换成功，请先处理'); return; }
      if (!coverId) { setError('请先选择封面图'); return; }
      const ackEl = dlg.querySelector('[data-role="ack"]');
      const acknowledgeUncertain = !!(pendingInfo && ackEl && ackEl.checked);
      if (pendingInfo && !acknowledgeUncertain) { setError('请先到公众号后台核对草稿箱，确认后勾选「我已核对草稿箱」再发送'); return; }
      busy = true;
      const sendBtn = $('send');
      sendBtn.disabled = true;
      $('busy').hidden = false;
      let r;
      try {
        r = await host.wxCreateDraft({
          title: String(titleInput.value || '').trim(),
          html,
          images: images.map(({ id, src }) => ({ id, src })),
          coverId,
          author: String(authorInput.value || '').trim(),
          acknowledgeUncertain,
        });
      } catch (error) { r = { ok: false, error: String((error && error.message) || error) }; }
      busy = false;
      sendBtn.disabled = false;
      $('busy').hidden = true;
      if (r && r.ok) {
        say(`已发送到公众号草稿箱（media_id ${r.mediaId}）。请到公众号后台草稿箱确认后自行发布。`, 8000);
        finish({ ok: true, mediaId: r.mediaId });
        return;
      }
      if (r && r.code === 'MP_WX_PENDING_UNCERTAIN') await loadStatus();
      const detail = r && r.error ? r.error : '未知错误';
      setError(detail + (r && r.mediaId ? `\n草稿 media_id：${r.mediaId}` : '') + (r && r.hint ? `\n提示：${r.hint}` : ''));
    };
  });
}

export default { openWechatDraft };
