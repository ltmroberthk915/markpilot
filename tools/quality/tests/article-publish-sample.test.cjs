'use strict';
/* article-publish-sample.test.cjs — 主控验收样稿的**端到端**形状：
 * 4 个可带走的图片/图形（1 张正文照片 + 1 条行内公式 + 1 条块公式 + 1 张项目图表），
 * 其中行内公式的 TeX 精确为 `r^2`。
 *
 * 这份夹具逐字复现实测形态：
 *  · 图表 SVG 是 `width="100%"` ＋ viewBox，holder 不在 DOM 里（尺寸只能从 viewBox 取）；
 *  · 公式节点带 data-mp-tex（内核在 token→HTML 处写入的真源）；
 *  · 正文图已是 data URL（走 embedImageRefs 的产物）。
 * 断言：两种发布载荷都含 4 个 <img>，图表是 PNG，公式带精确 TeX。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '../../..');
const ENGINE = path.join(ROOT, 'dsh-markpilot/src-cm6');
const load = (file) => import(pathToFileURL(path.join(ENGINE, file)).href);
const extrasSource = fs.readFileSync(path.join(ENGINE, 'extras.js'), 'utf8');

/* 与 article-media.test.cjs 同源的极简 DOM（够 selfContainMedia 走完整条路）。 */
function makeDom() {
  const matchSelector = (el, sel) => {
    if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
    if (sel.startsWith('annotation')) return el.tagName === 'ANNOTATION';
    return el.tagName === sel.toUpperCase();
  };
  class Node {
    constructor(tag) {
      this.tagName = String(tag || 'div').toUpperCase();
      this.children = []; this.attrs = {}; this._text = '';
      /* classList.add 必须真的写进集合：写成空函数时 .mp-math/.mp-mermaid 选择器恒不命中，
         整支探针会"测出 0 个媒体"而误判产品（本轮踩过一次）。 */
      this.classList = { _s: new Set(), add(...names) { for (const n of names) this._s.add(n); }, contains(n) { return this._s.has(n); } };
    }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') String(v).split(/\s+/).filter(Boolean).forEach((n) => this.classList.add(n)); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    replaceWith(next) { const p = this.parentNode; if (!p) return; p.children = p.children.map((c) => (c === this ? next : c)); next.parentNode = p; }
    appendText(t) { this._text += String(t); }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children = []; }
    get content() { return this; }
    get firstElementChild() { return this.children[0] || null; }
    getBoundingClientRect() { return { width: 10, height: 10 }; }
    get outerHTML() {
      const attrs = Object.entries(this.attrs).map(([k, v]) => ' ' + k + '="' + String(v).replace(/"/g, '&quot;') + '"').join('');
      return '<' + this.tagName.toLowerCase() + attrs + '>' + this._text + this.children.map((c) => c.outerHTML).join('')
        + '</' + this.tagName.toLowerCase() + '>';
    }
    querySelectorAll(selector) {
      const names = String(selector).split(',').map((s) => s.trim());
      const out = [];
      const walk = (el) => { for (const child of el.children) { if (names.some((n) => matchSelector(child, n))) out.push(child); walk(child); } };
      walk(this);
      return out;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  const parse = (htmlText) => {
    const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);
    const root = new Node('div');
    const stack = [root];
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(htmlText))) {
      if (m[5] != null) { if (m[5].trim()) stack[stack.length - 1].appendText(m[5]); continue; }
      if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
      const el = new Node(m[2]);
      for (const a of m[3].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
        el.setAttribute(a[1], a[2] != null ? a[2] : a[3] != null ? a[3] : (a[4] || ''));
      }
      stack[stack.length - 1].appendChild(el);
      /* 空元素（img/br/…）不入栈，否则后面的 </p> 会把它弹出、把整棵树接错。
         tagName 是大写，VOID 里是小写 —— 必须统一大小写再比（这里踩过一次）。 */
      if (!m[4] && !VOID.has(el.tagName.toLowerCase())) stack.push(el);
    }
    return root;
  };
  const document = { createElement: (t) => new Node(t), getElementById: () => null, body: new Node('body'), documentElement: new Node('html') };
  Object.defineProperty(Node.prototype, 'innerHTML', {
    get() { return this.children.map((c) => c.outerHTML).join(''); },
    set(v) { this.children = []; this._text = ''; for (const child of parse(String(v)).children) this.appendChild(child); },
  });
  return { document };
}

/* 验收样稿：照片 + 行内公式 + 块公式 + 项目图表。 */
const PHOTO = 'data:image/png;base64,' + 'A'.repeat(120);
const SAMPLE = '<h1>样稿</h1>'
  + '<p>照片：<img src="' + PHOTO + '" alt="照片"></p>'
  + '<p>行内公式 <span class="mp-math" data-mp-tex="r^2"><span class="katex">r2</span></span> 结束。</p>'
  + '<div class="mp-math-block" data-mp-tex="\\int_0^1 x\\,dx"><span class="katex">I</span></div>'
  + '<div class="mp-mermaid"><svg width="100%" viewBox="0 0 250 70">'
  + '<foreignObject width="32" height="24"><div xmlns="http://www.w3.org/1999/xhtml">'
  + '<p class="nodeLabel">观察</p></div></foreignObject>'
  + '<foreignObject width="32" height="24"><div xmlns="http://www.w3.org/1999/xhtml">'
  + '<p class="nodeLabel">复核</p></div></foreignObject></svg></div>';

test('acceptance sample yields four carryable images in both publish payloads', async () => {
  const { selfContainMedia } = await load('edition-math.js');
  const Pub = await load('article-publish.js');
  const { document } = makeDom();
  global.XMLSerializer = class {
    serializeToString() {
      return '<svg width="100%" viewBox="0 0 250 70"><foreignObject width="32" height="24">'
        + '<p class="nodeLabel">观察</p><p class="nodeLabel">复核</p></foreignObject></svg>';
    }
  };
  const measure = () => ({ width: 40, height: 20, fontFamily: 'KaTeX_Main', fontSize: '16px', lineHeight: '1.2', html: '<span class="katex">x</span>' });
  const rasterize = async ({ width, height }) => {
    assert.ok(width > 2 && height > 2, '栅格化必须有真实尺寸');
    return { bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) };
  };
  try {
    /* 先按真实顺序走发布投影，再逐目标做媒体自包含（与 extras.buildWechatArticle 同序）。 */
    const base = Pub.buildArticleOutput({ html: SAMPLE, edition: { kind: 'report', variant: 'light' }, tone: 'light' });
    for (const target of ['wechat', 'zhihu']) {
      const html = target === 'wechat' ? base.wechatHtml : base.zhihuHtml;
      const out = await selfContainMedia(html, { target, doc: document, measure, rasterize, mathCss: '.vlist{display:inline-table}' });
      assert.equal(out.stats.failed.length, 0, target + ':' + JSON.stringify(out.stats.failed));
      const imgs = (out.html.match(/<img\b/g) || []).length;
      assert.equal(imgs, 4, target + ' 必须恰好 4 个可带走的图片/图形，实测 ' + imgs);
      assert.ok(!/<svg\b/.test(out.html), target + ' 不得残留 <svg>');
      /* 公式：TeX 必须**在载荷里**可读。
         · 微信：公式是 PNG，TeX 落在 img 的 alt（微信不认 data-*）；
         · 知乎：ztext-math 的 data-tex + img 的 alt 都要有（知乎按 data-tex 重排）。 */
      assert.ok(/alt="r\^2"/.test(out.html), target + ' 的公式图 alt 必须带精确 TeX r^2');
      if (target === 'zhihu') assert.ok(/data-tex="r\^2"/.test(out.html), '知乎的 ztext-math 必须带 data-tex');
      assert.ok(/alt="\\int_0\^1 x\\,dx"/.test(out.html), target + ' 的块公式 alt 逐字保留 TeX');
      if (target === 'zhihu') assert.ok(/data-tex="\\int_0\^1 x\\,dx"/.test(out.html), '知乎块公式带 data-tex');
      /* 图表：PNG，且用 viewBox 的真实尺寸（250×70）。 */
      assert.ok(/class="mp-diagram-img"[^>]*width="250"[^>]*height="70"/.test(out.html), target + ' 图表按 viewBox 尺寸输出');
      assert.ok(/class="mp-diagram-img"[^>]*data:image\/png/.test(out.html) || /data:image\/png[^>]*class="mp-diagram-img"/.test(out.html),
        target + ' 图表是 PNG');
      /* 图表标签文字必须原样（不许被文章样式裁字）。 */
      const svgLeak = out.html.match(/nodeLabel"[^>]*style="[^"]*(line-height|text-indent|margin:0 0)/);
      assert.equal(svgLeak, null, target + ' 不得把文章样式灌进图表标签');
    }
  } finally { delete global.XMLSerializer; }
});

test('the sample path in extras keeps the same order: publish HTML first, media second, draft reuses it', () => {
  const build = extrasSource.slice(
    extrasSource.indexOf('  async function buildWechatArticle('),
    extrasSource.indexOf('  /** 复制到剪贴板'),
  );
  assert.ok(build.indexOf('buildArticleOutput(') < build.indexOf('selfContainMedia('),
    '先做公开投影，再做媒体自包含（否则公式/图表节点已变，TeX 与尺寸都丢了）');
  assert.ok(/rasterize: rasterizeSvgToPng/.test(build), '图表走真实 PNG 栅格化');
  assert.ok(/opts\.media !== false/.test(build), '留出"裸载荷"开关给探针对照');
});
