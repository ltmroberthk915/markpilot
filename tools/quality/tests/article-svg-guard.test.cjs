'use strict';
/* article-svg-guard.test.cjs — 通用文章内联化**不得进入图表/公式内部**。
 *
 * 实测反例（实际上传 PNG：wx-native-images-full/image-4.png）：
 * Mermaid 的标签是 `<foreignObject width="32" height="24"><div><p class="nodeLabel">观察</p></div>`，
 * 标签框由 mermaid 自己算成 32×24。通用 inliner 把文章样式
 * `p{margin:0 0 .9em;text-indent:0;line-height:1.78}` 灌进那个 `<p>` ⇒ 汉字下半被裁掉。
 * 判据（用户可见）：两个节点"观察→复核"的中文必须完整显示 —— 也就是
 * **SVG / MathML / KaTeX / 公式容器整棵子树逐字节原样**，一个属性都不许加。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '../../..');
const ENGINE = path.join(ROOT, 'dsh-markpilot/src-cm6');
const load = (file) => import(pathToFileURL(path.join(ENGINE, file)).href);

const STYLES = {
  p: 'margin:0 0 .9em;text-indent:0;line-height:1.78',
  table: 'border-collapse:collapse',
  th: 'padding:.55em .7em;font-weight:700',
  td: 'padding:.5em .7em',
  pre: 'white-space:pre-wrap',
  code: 'padding:.1em .3em',
  a: 'color:#0b65c2;text-decoration:none',
};

/* 与真实导出件同形的两节点图表（含 foreignObject 内的 nodeLabel p）。 */
const MERMAID = '<div class="mp-mermaid"><svg id="m1" viewBox="0 0 200 100" width="200" height="100">'
  + '<style>#m1 .nodeLabel{font-size:14px}</style>'
  + '<foreignObject width="32" height="24"><div xmlns="http://www.w3.org/1999/xhtml">'
  + '<p class="nodeLabel" style="margin:0">观察</p></div></foreignObject>'
  + '<foreignObject width="32" height="24"><div xmlns="http://www.w3.org/1999/xhtml">'
  + '<p class="nodeLabel">复核</p></div></foreignObject>'
  + '<path d="M1 2"/><text>一</text><a href="#edge"><text>边</text></a></svg></div>';

test('mermaid SVG subtree passes through byte-for-byte: no article styles, labels intact', async () => {
  const P = await load('edition-publish.js');
  const out = P.applyInlineStyles(MERMAID, STYLES);
  assert.equal(out, MERMAID, '图表整棵子树必须逐字节不变');
  for (const leak of ['line-height:1.78', 'text-indent:0', 'margin:0 0 .9em', 'padding:.5em .7em']) {
    assert.ok(!/(foreignObject|nodeLabel)[^>]*\bstyle="[^"]*/.test('') || !out.includes(leak) || !/nodeLabel"[^>]*style="[^"]*/.test(out),
      '不得把文章样式灌进图表：' + leak);
  }
  assert.ok(out.includes('<p class="nodeLabel">复核</p>'), '标签文字与框尺寸原样保留');
  assert.ok(out.includes('width="32" height="24"'), 'mermaid 算好的 foreignObject 尺寸不动');
});

test('MathML / KaTeX subtrees are byte-preserved while the outer article paragraph is styled', async () => {
  const P = await load('edition-publish.js');
  const html = '<p>式 <span class="mp-math" data-mp-tex="r^{2}"><span class="katex"><span class="vlist">2</span>'
    + '<math><mi>r</mi><msup><mn>2</mn></msup></math></span></span> 完</p>';
  const out = P.applyInlineStyles(html, STYLES);
  const inner = out.slice(out.indexOf('<span class="mp-math"'), out.indexOf('</span></span> 完'));
  assert.ok(!/line-height:1\.78|text-indent/.test(inner), '公式子树不得拿到文章行距/缩进');
  assert.ok(inner.includes('<span class="vlist">2</span>'), 'KaTeX 结构原样');
  assert.ok(inner.includes('<math><mi>r</mi><msup><mn>2</mn></msup></math>'), 'MathML 原样');
  assert.ok(/<p style="margin:0 0 \.9em/.test(out), '文章层段落仍要内联样式（守卫不能整页失效）');
});

test('protected ranges cover diagrams/formulas only and never swallow article content', async () => {
  const P = await load('edition-publish.js');
  const html = '<p>前</p>' + MERMAID + '<p>后</p>'
    + '<div class="mp-math-block"><span class="katex">y</span></div>'
    + '<table><tr><td>格</td></tr></table>';
  const ranges = P.protectedRanges(html);
  assert.equal(ranges.length, 2, '恰好两个受保护子树：图表与公式块');
  for (const [from, to] of ranges) {
    const slice = html.slice(from, to);
    assert.ok(/^<(div|span|svg|math)\b/.test(slice), '区间必须从整棵子树的根开始');
    assert.ok(/<\/svg>|<\/span><\/div>|<\/div>$/.test(slice) || slice.endsWith('</div>'), '区间必须闭合完整');
  }
  /* 文章层仍被内联（守卫不许吞掉正文）。 */
  const out = P.applyInlineStyles(html, STYLES);
  assert.ok(/<p style="margin:0 0 \.9em/.test(out));
  assert.ok(/<td style="padding:\.5em \.7em">/.test(out));
});

test('wechat numbering and zhihu link rewriting never enter diagrams', async () => {
  const P = await load('edition-publish.js');
  const html = MERMAID + '<p><a href="https://a.test/x">外部</a></p>';
  const wx = P.wechatArticleHtml(html, { styles: STYLES, linkNotes: true, dedupe: true });
  const svgStart = wx.html.indexOf('<svg'), svgEnd = wx.html.indexOf('</svg>');
  const svg = wx.html.slice(svgStart, svgEnd);
  assert.ok(!svg.includes('mp-link-ref'), '图表里的 <a> 不得被编成外链编号');
  assert.ok(svg.includes('<a href="#edge">'), '图表内锚点原样保留');
  assert.ok(/外部<sup class="mp-link-ref"[^>]*>\[1\]<\/sup>/.test(wx.html), '文章层外链仍然编号');
  assert.equal(wx.links.length, 1, '外链计划只统计文章层');
  const zh = P.zhihuArticleHtml(html, { styles: STYLES });
  const zhSvg = zh.html.slice(zh.html.indexOf('<svg'), zh.html.indexOf('</svg>'));
  assert.ok(!/target="_blank"/.test(zhSvg), '图表内的 <a> 不得被加 target');
  assert.ok(/<a[^>]*href="https:\/\/a\.test\/x"[^>]*target="_blank"/.test(zh.html), '文章层外链保留 href 并补 target');
});

test('the whole publish payload keeps diagram labels untouched end to end', async () => {
  const Pub = await load('article-publish.js');
  const out = Pub.buildArticleOutput({
    html: MERMAID, edition: { kind: 'report', variant: 'light' }, tone: 'light',
  });
  for (const payload of [out.wechatHtml, out.zhihuHtml]) {
    assert.ok(payload.includes('<p class="nodeLabel" style="margin:0">观察</p>'), '第一个标签逐字节保留');
    assert.ok(payload.includes('<p class="nodeLabel">复核</p>'), '第二个标签逐字节保留');
    assert.ok(!/(nodeLabel)[^>]*>(?:(?!<\/p>).)*(padding|line-height:1\.78)/.test(payload), '标签内不得出现文章样式');
  }
});
