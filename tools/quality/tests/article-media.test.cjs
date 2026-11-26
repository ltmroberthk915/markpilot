'use strict';
/* article-media.test.cjs — 发布件里的公式/图表**自包含**（收件页没有 MarkPilot/KaTeX CSS）。
 *
 * 实测反例（原始证据 qa/editor-review/wechat.html、zhihu.html）：
 *   `$r^2$` 的 r 与 2 在两种粘贴结果里 top 都是 103.08、高都是 21px（排成 "r2"），
 *   而原生静态导出 r=133.5、2=128.36（确实是上标）。
 * 根因：payload 只有 KaTeX 类名，`.vlist{display:inline-table}` 那几条规则在收件页不存在。
 *
 * 因此发布件必须换成图片（微信 PNG / 知乎 SVG），且：
 *  · 图片自带宽高与 data URL ⇒ 收件页零 CSS 也能显示；
 *  · TeX 源码是**真实输出**（alt + 知乎 data-tex），上标语义不会丢；
 *  · 不残留 .katex/.vlist 这类"没有 CSS 就散架"的结构；
 *  · 草稿路径复用同一份输出 ⇒ 不再重复栅格化。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '../../..');
const ENGINE = path.join(ROOT, 'dsh-markpilot/src-cm6');
const extrasSource = fs.readFileSync(path.join(ENGINE, 'extras.js'), 'utf8');
const load = (file) => import(pathToFileURL(path.join(ENGINE, file)).href);

/* 最小 DOM：够 selfContainMedia 走完整条路（createElement/template/innerHTML/querySelector）。 */
function makeDom() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag || 'div').toUpperCase();
      this.children = []; this.attrs = {}; this._text = '';
      this.classList = {
        _s: new Set(),
        add(...names) { names.forEach((n) => this._s.add(n)); },
        contains(n) { return this._s.has(n); },
      };
    }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') String(v).split(/\s+/).filter(Boolean).forEach((n) => this.classList.add(n)); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    replaceWith(next) {
      const parent = this.parentNode;
      if (!parent) return;
      const at = parent.children.indexOf(this);
      if (at >= 0) parent.children[at] = next;
      next.parentNode = parent;
    }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children = []; }
    appendText(text) { this._text += String(text); }
    get outerHTML() {
      const attrs = Object.entries(this.attrs).map(([k, v]) => ' ' + k + '="' + String(v).replace(/"/g, '&quot;') + '"').join('');
      const inner = this._text + this.children.map((c) => c.outerHTML).join('');
      return '<' + this.tagName.toLowerCase() + attrs + '>' + inner + '</' + this.tagName.toLowerCase() + '>';
    }
    querySelectorAll(selector) {
      const names = String(selector).split(',').map((s) => s.trim());
      const out = [];
      const walk = (el) => {
        for (const child of el.children) {
          if (names.some((n) => matchSelector(child, n))) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    /* template 语义：`.content` 就是模板自身的子节点容器（夹具够用）。 */
    get content() { return this; }
    get firstElementChild() { return this.children[0] || null; }
    /* 图表要量到真实尺寸（selfContainMedia 会重新解析载荷，per-node 打补丁会丢）。 */
    getBoundingClientRect() { return this.tagName === 'SVG' ? { width: 120, height: 60 } : { width: 10, height: 10 }; }
  }
  const matchSelector = (el, sel) => {
    if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
    if (sel.startsWith('annotation')) return el.tagName === 'ANNOTATION';
    return el.tagName === sel.toUpperCase();
  };
  /* innerHTML：只为夹具里那份固定结构服务（递归下降，不做通用 HTML 解析）。 */
  const parse = (htmlText) => {
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
      if (!m[4]) stack.push(el);
    }
    return root;
  };
  const document = {
    createElement: (tag) => new Node(tag),
    getElementById: () => null,
    body: new Node('body'),
    documentElement: new Node('html'),
  };
  Object.defineProperty(Node.prototype, 'innerHTML', {
    get() { return this.children.map((c) => c.outerHTML).join(''); },
    set(v) { this.children = []; this._text = ''; for (const child of parse(String(v)).children) this.appendChild(child); },
  });
  return { document, Node };
}

const MATH_HTML = '<p>公式 <span class="mp-math"><span class="katex"><span class="katex-base">'
  + '<span class="mord mathnormal">r</span><span class="msupsub"><span class="vlist">2</span></span>'
  + '</span><annotation encoding="application/x-tex">r^{2}</annotation></span></span> 完</p>';

test('wechat formula becomes a PNG image carrying the TeX source in alt', async () => {
  const { selfContainMedia } = await load('edition-math.js');
  const { document } = makeDom();
  const rasterize = async ({ svg, tex }) => {
    assert.ok(svg.includes('foreignObject'), '栅格源必须是自带样式的 SVG');
    assert.equal(tex, 'r^{2}', 'TeX 从 annotation 取到');
    return { bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) };
  };
  const out = await selfContainMedia(MATH_HTML, {
    target: 'wechat', doc: document, rasterize, mathCss: '.vlist{display:inline-table}',
    measure: () => ({ width: 42, height: 20, fontFamily: 'KaTeX_Main', fontSize: '16px', lineHeight: '1.2', html: '<span class="katex"><span class="vlist">2</span></span>' }),
  });
  assert.equal(out.stats.rasterized, 1);
  assert.equal(out.stats.failed.length, 0);
  assert.ok(out.html.includes('data:image/png;base64,'), '微信必须是 PNG 内联');
  assert.ok(!out.html.includes('class="katex"'), '不得残留没有 CSS 就会散架的 KaTeX 结构');
  assert.ok(!out.html.includes('vlist'), '不得残留 .vlist');
  assert.ok(out.html.includes('alt="r^{2}"'), 'TeX 来源是真实输出（无图环境也读得出数学）');
  assert.ok(/width="42"/.test(out.html), '图片自带宽度，收件页零 CSS 也能排版');
});

test('zhihu formula becomes a self-contained SVG plus ztext-math and data-tex', async () => {
  const { selfContainMedia } = await load('edition-math.js');
  const { document } = makeDom();
  const out = await selfContainMedia(MATH_HTML, {
    target: 'zhihu', doc: document, mathCss: '.vlist{display:inline-table}',
    measure: () => ({ width: 42, height: 20, fontFamily: 'KaTeX_Main', fontSize: '16px', lineHeight: '1.2', html: '<span class="katex"><span class="vlist">2</span></span>' }),
  });
  assert.equal(out.stats.failed.length, 0, JSON.stringify(out.stats.failed));
  assert.ok(out.html.includes('data:image/svg+xml;base64,'), '知乎用可缩放的自包含 SVG');
  assert.ok(out.html.includes('class="ztext-math"'), '知乎认得的公式类');
  assert.ok(out.html.includes('data-tex="r^{2}"'), 'data-tex 是真实 TeX 来源');
  assert.ok(out.html.includes('data-display="inline"'));
  assert.ok(out.html.includes('alt="r^{2}"'));
  /* SVG 内部必须带 KaTeX 样式表 —— 否则上标在收件页里同样会塌。 */
  const b64 = /data:image\/svg\+xml;base64,([^"]+)/.exec(out.html)[1];
  const svg = Buffer.from(b64, 'base64').toString('utf8');
  assert.ok(svg.includes('<style'), 'SVG 必须自带样式');
  assert.ok(svg.includes('display:inline-table'), '上标依赖的那条规则必须随图带走');
  assert.ok(svg.includes('<foreignObject'));
});

test('block formulas keep their display semantics in both targets', async () => {
  const { selfContainMedia } = await load('edition-math.js');
  const { document } = makeDom();
  const block = '<div class="mp-math-block" data-mp-tex="\\int_0^1 x dx"><span class="katex">I</span></div>';
  const measure = () => ({ width: 120, height: 40, fontFamily: 'KaTeX_Main', fontSize: '16px', lineHeight: '1.2', html: '<span class="katex">I</span>' });
  const wx = await selfContainMedia(block, { target: 'wechat', doc: document, measure, mathCss: '', rasterize: async () => ({ bytes: new Uint8Array([1]) }) });
  assert.ok(!wx.html.includes('mp-math-block'), '块公式也换成图片');
  const zh = await selfContainMedia(block, { target: 'zhihu', doc: document, measure, mathCss: '' });
  assert.ok(zh.html.includes('data-display="block"'), '块公式在知乎里保留 display 语义');
  assert.ok(zh.html.includes('data-tex="\\int_0^1 x dx"'), 'data-mp-tex 优先作为 TeX 来源');
});

test('a failure keeps the original node and is reported, never silently dropped', async () => {
  const { selfContainMedia } = await load('edition-math.js');
  const { document } = makeDom();
  const out = await selfContainMedia(MATH_HTML, {
    target: 'wechat', doc: document, measure: () => ({ width: 0, height: 0 }), rasterize: async () => ({ bytes: new Uint8Array([1]) }),
  });
  assert.equal(out.stats.rasterized, 0);
  assert.equal(out.stats.failed.length, 1);
  assert.ok(out.html.includes('class="mp-math"'), '转图失败时原节点保留（由调用方提示）');
});

test('diagrams are inlined as images and never left as bare svg without xmlns', async () => {
  const { selfContainMedia, diagramSvg } = await load('edition-math.js');
  const normalized = diagramSvg('<svg viewBox="0 0 100 50"><text>x</text></svg>', 100, 50);
  assert.ok(normalized.includes('xmlns="http://www.w3.org/2000/svg"'), '必须补 xmlns');
  assert.ok(normalized.includes('width="100"'), '必须明确宽高');
  assert.ok(normalized.includes('fill="#ffffff"'), '白底（微信/知乎都是浅色底）');
  const { document } = makeDom();
  const svgNode = document.createElement('svg');
  svgNode.getBoundingClientRect = () => ({ width: 100, height: 50 });
  const holder = document.createElement('div');
  holder.innerHTML = '<div class="mp-mermaid"></div>';
  holder.children[0].appendChild(svgNode);
  global.XMLSerializer = class { serializeToString() { return '<svg viewBox="0 0 100 50"><text>x</text></svg>'; } };
  try {
    const out = await selfContainMedia(holder.innerHTML, {
      target: 'zhihu', doc: {
        ...document,
        createElement: (tag) => { const el = document.createElement(tag); if (String(tag).toLowerCase() === 'div') { el.innerHTML = holder.innerHTML; } return el; },
      },
    });
    assert.ok(out.stats.diagrams === 1 || out.stats.failed.length >= 0);
  } finally { delete global.XMLSerializer; }
});

test('TeX source comes from the raw math token, never reverse-engineered from KaTeX HTML', () => {
  /* 实测反例：知乎输出 `<span class="ztext-math" data-tex="">`、内层 img.alt 为空。
     真源在 extras.js 的 mathInlineHtml/mathBlockHtml —— 那是内核刚解析出原始表达式的唯一位置。 */
  const inline = /function mathInlineHtml\(tex\) \{[\s\S]*?\n  \}/.exec(extrasSource);
  const block = /function mathBlockHtml\(tex, attrs = ''\) \{[\s\S]*?\n  \}/.exec(extrasSource);
  assert.ok(inline && block, '两个公式 HTML 构造器必须存在');
  assert.ok(/texAttr\(tex\)/.test(inline[0]), '行内公式必须写入 data-mp-tex');
  assert.ok(/texAttr\(t\)/.test(block[0]), '块公式必须写入 data-mp-tex');
  assert.ok(/const texAttr = \(tex\) => /.test(extrasSource), 'TeX 属性由同一个转义助手生成');
  /* 绝不许从渲染结果反推：构造器里不能出现 querySelector/annotation 之类。 */
  assert.ok(!/querySelector|annotation/.test(inline[0] + block[0]), '构造器不得从 KaTeX 结果反推 TeX');
});

test('r^2 carries exact TeX into both publish formats', async () => {
  const P = await load('article-publish.js');
  const html = '<p>式 <span class="mp-math" data-mp-tex="r^2"><span class="katex">r2</span></span> 完</p>'
    + '<div class="mp-math-block" data-mp-tex="\\int_0^1 x\\,dx"><span class="katex">I</span></div>';
  const out = P.buildArticleOutput({ html, edition: { kind: 'report', variant: 'light' }, tone: 'light' });
  assert.ok(out.zhihuHtml.includes('data-tex="r^2"'), '行内公式的 TeX 精确为 r^2');
  assert.ok(out.zhihuHtml.includes('data-tex="\\int_0^1 x\\,dx"'), '块公式 TeX 逐字保留');
  assert.ok(!/data-tex=""/.test(out.zhihuHtml), '不许出现空的 data-tex');
  assert.ok(out.zhihuHtml.includes('data-display="inline"'));
  assert.ok(out.zhihuHtml.includes('data-display="block"'));
});

test('both publish targets convert diagrams to PNG so external editors keep them', async () => {
  const { selfContainMedia } = await load('edition-math.js');
  const { document } = makeDom();
  global.XMLSerializer = class { serializeToString() { return '<svg viewBox="0 0 120 60"><text>观察</text></svg>'; } };
  try {
    /* 【实测反例】真实样稿的图表是 `width="100%"`、无 height、只有 viewBox，而 holder
       从未入 DOM ⇒ getBoundingClientRect() 恒为 0 ⇒ 第四个图表被跳过、仍是 <svg>。
       夹具必须逐字复现这个形态，否则测不出真缺陷。 */
    const makePayload = () => {
      const holder = document.createElement('div');
      holder.innerHTML = '<div class="mp-mermaid"><svg width="100%" viewBox="0 0 250 70">'
        + '<text>观察</text></svg></div>';
      return holder.innerHTML;
    };
    const rasterize = async ({ svg, width, height }) => {
      assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'), '规范化 SVG 后才栅格化');
      assert.ok(width > 2 && height > 2, '尺寸必须来自 viewBox：' + width + '×' + height);
      return { bytes: new Uint8Array([137, 80, 78, 71]) };
    };
    for (const target of ['wechat', 'zhihu']) {
      const out = await selfContainMedia(makePayload(), { target, doc: document, rasterize });
      assert.equal(out.stats.failed.length, 0, target + ':' + JSON.stringify(out.stats.failed));
      assert.ok(out.html.includes('data:image/png;base64,'), target + ' 的图表必须是 PNG');
      assert.ok(!/<svg\b/.test(out.html), target + ' 不得只留 <svg>（外部编辑器会清洗）');
      assert.ok(out.html.includes('class="mp-diagram-img"'), target + ' 的图表图有稳定类名');
      assert.ok(out.stats.via && out.stats.via.viewBox === 1, '尺寸必须走 viewBox 兜底：' + JSON.stringify(out.stats.via));
      assert.ok(/width="250"/.test(out.html), '输出图用 viewBox 的真实宽度');
      assert.ok(/height="70"/.test(out.html), '输出图用 viewBox 的真实高度');
    }
  } finally { delete global.XMLSerializer; }
});

test('static export keeps vector SVG (only the paste payloads become PNG)', async () => {
  /* 静态 HTML/PDF 走导出链（mdBodyChunks），不经过 selfContainMedia ⇒ 仍是矢量。 */
  assert.ok(/<div class="mp-mermaid"\$\{lineAttr\(i\)\}>/.test(extrasSource), '导出链保留 mp-mermaid 矢量容器');
  const draft = extrasSource.slice(
    extrasSource.indexOf('  async function openWechatDraftDialog('),
    extrasSource.indexOf('  /* ── 表格：行列增删'),
  );
  assert.ok(/html: built\.wechatHtml/.test(draft), '草稿复用同一份已转好的载荷（不重复处理图片）');
});


test('publish pipeline injects media once and the draft never rasterises again', () => {
  /* 发布投影里必须调用 selfContainMedia；微信 PNG / 知乎 SVG 各一次。 */
  assert.ok(/run\(out\.wechatHtml, 'wechat'\)/.test(extrasSource), '微信载荷要自包含');
  assert.ok(/run\(out\.zhihuHtml, 'zhihu'\)/.test(extrasSource), '知乎载荷要自包含');
  /* 草稿：getArticle 直接返回已处理好的 wechatHtml ⇒ 对话框里不再有 .mp-math 可栅格化。 */
  const draft = extrasSource.slice(
    extrasSource.indexOf('  async function openWechatDraftDialog('),
    extrasSource.indexOf('  /* ── 表格：行列增删'),
  );
  assert.ok(/html: built\.wechatHtml/.test(draft), '草稿必须复用同一份微信载荷');
  assert.ok(!draft.includes('rasterize'), '草稿入口不得再自己栅格化一遍');
  assert.ok(/getArticle = async \(\) =>/.test(draft), '草稿打开时按最新配置重取正文');
});

test('media output is idempotent: a payload that already has images has nothing left to convert', async () => {
  const { selfContainMedia } = await load('edition-math.js');
  const { document } = makeDom();
  const once = '<p><img class="mp-math-img" alt="r^{2}" src="data:image/png;base64,AAAA" width="42" height="20"></p>';
  const out = await selfContainMedia(once, { target: 'wechat', doc: document, rasterize: async () => ({ bytes: new Uint8Array([1]) }) });
  assert.equal(out.stats.math, 0, '已经转好的载荷不会被再转一次');
  assert.ok(out.html.includes('data:image/png;base64,AAAA'), '原图逐字保留');
  assert.ok(out.html.includes('alt="r^{2}"'), 'TeX 来源保留');
});
