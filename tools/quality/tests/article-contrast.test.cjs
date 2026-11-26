'use strict';
/* article-contrast.test.cjs — 发布件的**明暗配对**：配方（版式 + 已解析变体）说了算。
 *
 * 实测反例（qa/editor-review/publish-panel.png）：
 * 宿主 UI 深色、文稿选「研报／浅色」⇒ 白底上 h1 是 rgb(222,225,230)，
 * 表头是 rgb(0,0,0) 字叠 rgb(42,44,49) 深底（几乎不可读）；切目标/宽度的按钮
 * 在深色底上用 UA 默认黑字；知乎目标仍显示微信专属开关（.mp-pub-row 的 flex 压过 hidden）。
 *
 * 判据：两两配对必须**成对可读**，且与用户选的那一档一致 ——
 * 深宿主 + 浅文稿 ⇒ 白底黑字；浅宿主 + 深文稿 ⇒ 深底浅字。
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

function hexToRgb(hex) {
  const h = String(hex || '').trim().replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function luminance([r, g, b]) {
  const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const la = luminance(hexToRgb(a)), lb = luminance(hexToRgb(b));
  if (la == null || lb == null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** 从 style 属性里取声明的计算值（只认 #rrggbb）。 */
const declared = (style, prop) => {
  const m = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)').exec(String(style || ''));
  return m ? m[1].trim() : null;
};

async function payload(kind, variant, tone) {
  const P = await load('article-publish.js');
  const html = '<h1>标题</h1><h2>节</h2><p>正文文字</p>'
    + '<blockquote><p>引文</p></blockquote>'
    + '<table><thead><tr><th>表头</th></tr></thead><tbody><tr><td>格</td></tr></tbody></table>'
    + '<pre><code>code</code></pre>';
  return {
    P,
    out: P.buildArticleOutput({ html, edition: { kind, variant }, tone, title: 'T' }),
  };
}

const HOST_DARK = { bg: '#1f2126', fg: '#d7dae0', heading: '#dee1e6', muted: '#8b90a0', border: '#33363f', primary: '#4c9aff', codeBg: '#262a31', capsule: '#2a2c31', quoteBg: '#303237', quoteBar: '#525661' };
const HOST_LIGHT = { bg: '#ffffff', fg: '#24292f', heading: '#1e2227', muted: '#6e7781', border: '#d8dee4', primary: '#0969da', codeBg: '#f2f4f7', capsule: '#f2f2f3', quoteBg: '#ebecec', quoteBar: '#b3bac1' };

for (const [hostName, host, kind, variant, tone] of [
  ['深宿主＋浅文稿', HOST_DARK, 'report', 'light', 'light'],
  ['浅宿主＋深文稿', HOST_LIGHT, 'report', 'dark', 'dark'],
  ['深宿主＋书页浅色', HOST_DARK, 'book', 'light', 'light'],
  ['浅宿主＋书页深色', HOST_LIGHT, 'book', 'dark', 'dark'],
]) {
  test(hostName + '：' + kind + '/' + variant + ' 的前景/底色成对可读（不受宿主 token 影响）', async () => {
    const { out } = await payload(kind, variant, tone);
    /* 公开颜色必须来自配方，而不是宿主快照。 */
    const recipeColors = out.recipe.colors;
    for (const payloadHtml of [out.wechatHtml, out.zhihuHtml]) {
      const rootStyle = declared(/<section class="mp-article-body"[^>]*style="([^"]*)"/.exec(payloadHtml)?.[1], 'color')
        ? /<section class="mp-article-body"[^>]*style="([^"]*)"/.exec(payloadHtml)[1] : '';
      assert.ok(rootStyle, '发布片段根必须自带内联样式');
      const bg = declared(rootStyle, 'background-color');
      const fg = declared(rootStyle, 'color');
      assert.ok(bg && fg, '根必须有成对的 background-color 与 color：' + rootStyle);
      assert.equal(fg.toLowerCase(), recipeColors.fg.toLowerCase(), '正文前景取配方的 fg');
      assert.equal(bg.toLowerCase(), recipeColors.bg.toLowerCase(), '底色取配方的 bg');
      const ratio = contrast(fg, bg);
      assert.ok(ratio >= 7, '正文对比度必须够读：' + fg + ' on ' + bg + ' = ' + ratio.toFixed(2));
    }
    /* 标题：成对写死颜色，不许跟宿主 token 走。 */
    for (const level of [1, 2]) {
      const tag = new RegExp('<h' + level + '[^>]*style="([^"]*)"[^>]*>').exec(out.zhihuHtml);
      assert.ok(tag, 'h' + level + ' 必须有内联样式');
      const color = declared(tag[1], 'color');
      assert.ok(color, 'h' + level + ' 必须明确前景');
      assert.equal(color.toLowerCase(), recipeColors.heading.toLowerCase(), 'h' + level + ' 用配方的 heading');
      const ratio = contrast(color, recipeColors.bg);
      assert.ok(ratio >= 4.5, 'h' + level + ' 对比度：' + ratio.toFixed(2));
    }
    /* 表头：字色与底色必须是一对（实测反例：黑字叠深底）。 */
    const th = /<th[^>]*style="([^"]*)"[^>]*>/.exec(out.zhihuHtml);
    assert.ok(th, 'th 必须有内联样式');
    const thColor = declared(th[1], 'color');
    const thBg = declared(th[1], 'background');
    assert.ok(thColor, '表头必须有明确字色');
    const thRatio = contrast(thColor, recipeColors.bg);
    assert.ok(thRatio >= 4.5, '表头字色 vs 页面底色：' + thRatio.toFixed(2) + '（' + thColor + ' on ' + recipeColors.bg + '）');
    if (thBg && /^#/.test(thBg)) {
      const r2 = contrast(thColor, thBg);
      assert.ok(r2 >= 4.5, '表头字色 vs 表头底色：' + r2.toFixed(2));
    }
    /* 引用：至少整体对比度够读。 */
    const bq = /<blockquote[^>]*style="([^"]*)"[^>]*>/.exec(out.zhihuHtml);
    assert.ok(bq, 'blockquote 必须有内联样式');
    const bqColor = declared(bq[1], 'color') || recipeColors.fg;
    const bqBg = declared(bq[1], 'background');
    const bqBase = bqBg && /^#/.test(bqBg) ? bqBg : recipeColors.bg;
    assert.ok(contrast(bqColor, bqBase) >= 4.5, '引用对比度：' + contrast(bqColor, bqBase).toFixed(2));
  });
}

test('static document root also carries paired colors (no theme variables to rely on)', async () => {
  const { out } = await payload('report', 'dark', 'dark');
  assert.ok(/<body style="background:#[0-9a-f]{6}">/i.test(out.documentHtml), 'body 底色写死');
  const root = /<div class="mp-article"[^>]*style="([^"]*)"[^>]*>/.exec(out.documentHtml);
  assert.ok(root, '文章根必须带内联颜色');
  const fg = declared(root[1], 'color');
  const bg = declared(root[1], 'background-color');
  assert.equal(fg.toLowerCase(), out.recipe.colors.fg.toLowerCase());
  assert.equal(bg.toLowerCase(), out.recipe.colors.bg.toLowerCase());
});

test('follow mode resolves to the interface tone before colours are chosen', async () => {
  const P = await load('article-publish.js');
  const html = '<h1>标题</h1><p>正文</p>';
  const darkInterface = P.buildArticleOutput({ html, edition: { kind: 'report', variant: 'follow' }, tone: 'dark' });
  const lightInterface = P.buildArticleOutput({ html, edition: { kind: 'report', variant: 'follow' }, tone: 'light' });
  assert.equal(darkInterface.tone, 'dark');
  assert.equal(lightInterface.tone, 'light');
  assert.notEqual(darkInterface.recipe.colors.bg, lightInterface.recipe.colors.bg, '跟随档必须真的换一套配色');
  assert.notEqual(darkInterface.zhihuHtml, lightInterface.zhihuHtml);
});

test('plain edition still pairs fg/bg so pasted text stays readable on any host', async () => {
  const P = await load('article-publish.js');
  for (const tone of ['light', 'dark']) {
    const out = P.buildArticleOutput({ html: '<p>正文</p><h1>标题</h1>', edition: { kind: 'plain', variant: 'follow' }, tone });
    const root = /<section class="mp-article-body"[^>]*style="([^"]*)"/.exec(out.wechatHtml);
    assert.ok(root, 'plain 也要有片段根');
    const fg = declared(root[1], 'color');
    const bg = declared(root[1], 'background-color');
    assert.ok(fg && bg, 'plain 根必须成对写死前景/底色');
    assert.ok(contrast(fg, bg) >= 7, 'plain 对比度：' + contrast(fg, bg).toFixed(2));
    const p = /<p[^>]*style="([^"]*)"[^>]*>正文/.exec(out.wechatHtml);
    assert.ok(p && declared(p[1], 'color'), 'plain 段落也要明确字色');
  }
});

test('panel controls use host tokens and [hidden] really hides wechat-only switches', () => {
  /* ② 按钮/下拉继承 UA 黑字 ⇒ 深色面板上看不见。 */
  assert.ok(/\.mp-pub-row select \{[^}]*color:var\(--mp-fg\)/.test(extrasSource), '下拉用宿主字色');
  assert.ok(/\.mp-pub-row \.mp-key \{[^}]*color:var\(--mp-fg\)/.test(extrasSource), '面板按钮用宿主字色');
  assert.ok(/\.mp-pub \{ display:flex; flex-direction:column; gap:6px; color:var\(--mp-fg\)/.test(extrasSource), '面板根用宿主字色');
  /* ① flex 压过 hidden ⇒ 微信专属开关在知乎目标下仍然显示。 */
  assert.ok(/\.mp-pub \[hidden\] \{ display:none !important; \}/.test(extrasSource), 'hidden 必须真正隐藏');
  /* 目标切换时隐藏微信选项（逻辑面）。 */
  assert.ok(/wx\.hidden = state\.target !== 'wechat'/.test(extrasSource), '非微信目标必须隐藏微信开关');
  assert.ok(/draftBtn\.disabled = state\.target !== 'wechat'/.test(extrasSource), '草稿按钮只在微信目标可用');
  assert.ok(/aria-selected/.test(extrasSource), '选中态用 aria-selected（判据可读）');
});

test('the publish panel never injects article colours into its own chrome', () => {
  const panel = extrasSource.slice(
    extrasSource.indexOf('  const PUBLISH_WIDTHS = ['),
    extrasSource.indexOf('  async function openWechatDraftDialog('),
  );
  const cssBlock = extrasSource.slice(extrasSource.indexOf('.mp-pub {'), extrasSource.indexOf('.mp-pub-frame'));
  assert.ok(!/--mp-article|mp-article-recipe/.test(cssBlock), '面板样式不得引用文章配方 token');
  assert.ok(panel.includes("data-pub=\"stage\""), '预览舞台与面板外壳分离');
});
