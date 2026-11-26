'use strict';
/* article-edition.test.cjs — 书页/研报的**配方语言**与编辑器投影契约。
 * 只测纯模块与真实字符串产物（不启动界面、不占 app-slot）。
 *
 * 覆盖（每条都是用户能看见的性质）：
 *  · 归一化：未知 kind/variant/localStorage 脏值 ⇒ 默认且不抛；
 *  · follow 解析：跟随界面明暗，显式档不被界面覆盖；
 *  · 编号：研报一二三级格式，本级 +1 / 深层归零；书页/plain 不产生编号；
 *  · 编辑面 CSS：只按 [data-mp-article-recipe] 限定、plain 条数为 0、两款互不串味；
 *  · 导出 CSS：静态页不出现 .cm- 选择器；打印媒体回到白纸黑字；
 *  · 配方契约：getArticleRecipe 的返回形态（id/label/variant/colors/bodyFont/headingFont）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../../..');
const ENGINE = path.join(ROOT, 'dsh-markpilot/src-cm6');
const load = (file) => import(pathToFileURL(path.join(ENGINE, file)).href);

/** 按**括号层级**切顶层选择器（`:is(.a,.b)` 里的逗号不算分隔符）。 */
function splitTopLevel(text) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

test('edition settings normalize unknown and dirty values without throwing', async () => {
  const E = await load('article-edition.js');
  assert.deepEqual(E.normalizeEdition(null), { kind: 'plain', variant: 'follow' });
  assert.deepEqual(E.normalizeEdition('book'), { kind: 'book', variant: 'follow' });
  assert.deepEqual(E.normalizeEdition({ kind: 'REPORT', variant: 'Dark' }), { kind: 'report', variant: 'dark' });
  for (const bad of [{}, { kind: 'x' }, { kind: 42 }, { variant: 'sepia' }, [], 'nonsense', 7, null, undefined]) {
    const got = E.normalizeEdition(bad);
    assert.ok(got.kind === 'plain' || got.kind === 'book', JSON.stringify(bad));
    assert.ok(E.EDITION_VARIANTS.includes(got.variant));
  }
  /* 脏 localStorage：JSON 坏、未知值、空串 —— 一律回默认，不抛。 */
  const make = (raw) => ({ getItem: () => raw });
  assert.deepEqual(E.readStoredEdition(make('{"kind":"book","variant":"light"}')), { kind: 'book', variant: 'light' });
  assert.deepEqual(E.readStoredEdition(make('{not json')), { kind: 'plain', variant: 'follow' });
  assert.deepEqual(E.readStoredEdition(make('report')), { kind: 'report', variant: 'follow' });
  assert.deepEqual(E.readStoredEdition(make(null)), { kind: 'plain', variant: 'follow' });
  assert.deepEqual(E.readStoredEdition(null), { kind: 'plain', variant: 'follow' });
});

test('follow resolves to the interface tone while explicit variants stay fixed', async () => {
  const E = await load('article-edition.js');
  assert.equal(E.resolveEditionTone({ kind: 'book', variant: 'follow' }, true), 'dark');
  assert.equal(E.resolveEditionTone({ kind: 'book', variant: 'follow' }, false), 'light');
  assert.equal(E.resolveEditionTone({ kind: 'book', variant: 'light' }, true), 'light');
  assert.equal(E.resolveEditionTone({ kind: 'book', variant: 'dark' }, false), 'dark');
});

test('report chapter numbers are real text: 一、（一）1. with level reset', async () => {
  const E = await load('article-edition.js');
  const n = E.editionNumbering('report');
  assert.equal(n.next(1), '一、');
  assert.equal(n.next(2), '（一）');
  assert.equal(n.next(2), '（二）');
  assert.equal(n.next(3), '1.');
  assert.equal(n.next(3), '2.');
  assert.equal(n.next(1), '二、');      // 回到一级：一级 +1
  assert.equal(n.next(2), '（一）');     // 二级归零重数
  assert.equal(n.next(3), '1.');
  assert.equal(n.next(4), '(1)');
  assert.equal(n.next(5), '1)');
  assert.equal(n.next(6), '');
  /* 十二 / 二十 的中文数字不能被写成 "一十二"。 */
  const m = E.editionNumbering('report');
  for (let i = 0; i < 11; i++) m.next(1);
  assert.equal(m.next(1), '十二、');
  for (let i = 0; i < 8; i++) m.next(1);
  assert.equal(m.next(1), '二十一、');
});

test('book and plain never emit chapter numbers', async () => {
  const E = await load('article-edition.js');
  for (const kind of ['book', 'plain']) {
    const n = E.editionNumbering(kind);
    for (const level of [1, 2, 3, 4, 5, 6]) assert.equal(n.next(level), '', kind + '/' + level);
  }
});

test('editor CSS is scoped to the recipe attribute and is empty for plain', async () => {
  const E = await load('article-edition.js');
  const R = await load('article-recipes.js');
  for (const kind of ['book', 'report']) {
    for (const variant of ['light', 'dark']) {
      const css = R.articleEditorCss(R.getArticleRecipe(kind, variant));
      assert.ok(css.includes('[data-mp-article-recipe="' + kind + '"]'), kind + '/' + variant + ' 必须按配方限定');
      assert.ok(css.includes('[data-mp-article-variant="' + variant + '"]'));
      for (const line of css.split('\n')) {
        if (!line.includes('{')) continue;
        if (/^\[data-mp-article-recipe="report"\]/.test(line)) continue;   // 编号规则是全局属性选择器
        /* 一行里可以有多个选择器（顶层逗号分隔）；**每一个**都必须在根上按配方属性限定。
           注意：`:is(.a,.b)` 里的逗号不是选择器分隔符 —— 必须按括号层级切，否则会把
           `.mp-h2` 误判成"未限定规则"（本轮踩过一次）。 */
        const selectors = splitTopLevel(line.slice(0, line.indexOf('{')));
        for (const selector of selectors) {
          assert.ok(/\[data-mp-article-recipe="/.test(selector) && /\[data-mp-article-variant="/.test(selector),
            '未按配方限定的规则：' + selector.slice(0, 90));
        }
      }
    }
  }
  /* 两款互不串味（按**配方值**判定，不按某个具体色条写法 —— 视觉细节归配方编码者）：
     书页：一级标题居中 + 上下细线框；研报：一级标题左对齐 + 左侧色条。 */
  const bookRecipe = R.getArticleRecipe('book', 'light');
  const reportRecipe = R.getArticleRecipe('report', 'light');
  assert.equal(bookRecipe.headings[0].align, 'center', '书页一级标题居中');
  assert.equal(bookRecipe.headings[0].frame, true, '书页一级标题有上下细线');
  assert.equal(reportRecipe.headings[0].align, 'left', '研报标题不居中');
  assert.equal(reportRecipe.headings[0].bar, true, '研报一级标题有章节色条');
  const book = R.articleEditorCss(bookRecipe);
  assert.ok(book.includes('text-align:center'), '书页居中要真的落到 CSS 里');
  assert.ok(!book.includes('border-left:5px solid var(--mp-primary)'), '书页不抄研报的色条');
});

test('export CSS is a static-page stylesheet: no .cm- selectors, print goes back to paper white', async () => {
  const E = await load('article-edition.js');
  for (const kind of ['book', 'report']) {
    for (const tone of ['light', 'dark', null]) {
      const css = E.exportEditionCss(kind, tone);
      assert.ok(css.length > 200, 'kind=' + kind + ' tone=' + tone);
      assert.ok(!/\.cm-/.test(css), '静态页样式不得出现 .cm- 选择器：' + kind);
      assert.ok(css.includes('@media print'), '必须带纸面规则');
      const printBlock = css.slice(css.indexOf('@media print'));
      assert.ok(printBlock.includes('background:#fff !important'), '打印回白底');
      assert.ok(printBlock.includes('color:#111'), '打印正文回到黑字');
      assert.ok(css.includes('.mp-math-block'), '公式块要有占位样式');
      assert.ok(css.includes('.mp-mermaid'), '图表要有占位样式');
      assert.ok(css.includes('.mp-footnotes'), '脚注区要有样式');
      assert.ok(css.includes('.mp-link-notes'), '外链清单要有样式');
    }
  }
  assert.equal(E.exportEditionCss('plain', 'light'), '', 'plain 不产生任何导出样式');
});

test('recipe contract: getArticleRecipe returns the agreed shape for every pair', async () => {
  const R = await load('article-recipes.js');
  for (const id of ['book', 'report']) {
    for (const variant of ['light', 'dark']) {
      const r = R.getArticleRecipe(id, variant);
      assert.equal(r.id, id);
      assert.equal(r.variant, variant);
      assert.ok(r.label === '书页' || r.label === '研报');
      for (const key of ['bg', 'fg', 'heading', 'muted', 'border', 'codeBg', 'capsule', 'quoteBg', 'quoteBar', 'primary', 'accent', 'num']) {
        assert.equal(typeof r.colors[key], 'string', id + '/' + variant + ' colors.' + key);
        assert.ok(r.colors[key].length > 2);
      }
      assert.equal(typeof r.bodyFont, 'string');
      assert.equal(typeof r.headingFont, 'string');
      assert.equal(r.headings.length, 6, '六级标题阶');
      assert.ok(r.measure > 300 && r.pad >= 12);
    }
  }
  /* 未知 id/variant 不抛并落到安全值。 */
  assert.equal(R.getArticleRecipe('nonsense', 'nonsense').id, 'book');
  assert.equal(R.getArticleRecipe('report', 'nonsense').variant, 'light');
  /* 文档样式（.mp-article 根）与编辑器样式是两套：前者不得含 .cm-。 */
  const docCss = R.articleDocumentCss(R.getArticleRecipe('report', 'dark'));
  assert.ok(docCss.includes('.mp-article'));
  assert.ok(!/\.cm-/.test(docCss));
});

test('editor projection writes root attributes only when a recipe is active', async () => {
  const V = await load('edition-view.js');
  const dataset = () => {
    const d = {};
    return { dataset: d, getAttribute: (k) => d[k] ?? null, setAttribute: (k, v) => { d[k] = v; }, removeAttribute: (k) => { delete d[k]; } };
  };
  const html = dataset();
  const doc = { documentElement: html, createElement: () => ({ style: {}, set textContent(v) { this._t = v; }, get textContent() { return this._t; } }), head: { appendChild() { } }, getElementById: () => null };
  V.applyArticleEdition({ kind: 'report', variant: 'follow' }, { doc, isDark: true });
  assert.equal(html.dataset.mpArticleRecipe, 'report');
  assert.equal(html.dataset.mpArticleVariant, 'dark', 'follow 在深色界面下解析成 dark');
  assert.equal(html.dataset.mpEditionMode, 'follow', '原始档要保留，供面板回显');
  V.applyArticleEdition({ kind: 'book', variant: 'light' }, { doc, isDark: true });
  assert.equal(html.dataset.mpArticleVariant, 'light', '显式浅色不被深色界面覆盖');
  V.applyArticleEdition({ kind: 'plain', variant: 'follow' }, { doc, isDark: true });
  for (const key of ['mpArticleRecipe', 'mpArticleVariant', 'mpEditionMode', 'mpEdition']) {
    assert.equal(html.dataset[key], undefined, 'plain 必须摘掉 ' + key);
  }
});

test('editor heading decorations produce one number per heading line, in document order', async () => {
  const { EditorState } = await import(pathToFileURL(path.join(ROOT, 'dsh-markpilot/node_modules/@codemirror/state/dist/index.js')).href);
  const { Decoration } = await import(pathToFileURL(path.join(ROOT, 'dsh-markpilot/node_modules/@codemirror/view/dist/index.js')).href);
  const E = await load('article-edition.js');
  /* editionNumbering 是装饰的唯一计数实现；直接对齐"逐级下推"的期望序列。 */
  const n = E.editionNumbering('report');
  const levels = [1, 2, 2, 3, 1, 2];
  const got = levels.map((l) => n.next(l));
  assert.deepEqual(got, ['一、', '（一）', '（二）', '1.', '二、', '（一）']);
  assert.ok(EditorState && Decoration, 'CM6 依赖可用');
});
