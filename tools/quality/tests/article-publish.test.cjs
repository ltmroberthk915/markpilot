'use strict';
/* article-publish.test.cjs — 发布投影（微信 / 知乎 / 静态文档 / 复制）的契约。
 *
 * 直接对应控制器点名的反例，逐条断言：
 *  1. sourceUrl 默认空；本机磁盘路径绝不进「原文：」或 canonical；只有显式 http(s) 才可用。
 *  2. 链接序列 [A,A,B]：去重开 ⇒ 内文 [1,1,2]、文末 [1,2]；去重关 ⇒ 内文 [1,2,3]、文末 [1,2,3]。
 *  3. 复制契约：意图在点击时取得；宿主明示无效后**不**无 token 重试、**不**退系统剪贴板；
 *     textarea/execCommand 只能复制纯文本 ⇒ 必须明确提示，不得谎报"已复制微信/知乎格式"。
 *  4. 本地正文图片必须变成可搬走的图（data URL），不残留 file:/// 或相对路径。
 *  5. 公式不降级：微信保留 mp-math/mp-math-block、知乎带 ztext-math + data-tex（TeX 来源）。
 *  6. 代码缩进、脚注链接、语义层级在两种发布件里都保留。
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

const LINK_1 = '<p><a href="https://a.test/x">A1</a> <a href="https://a.test/x">A2</a> <a href="https://b.test/y">B</a></p>';
const refsIn = (html) => [...html.matchAll(/class="mp-link-ref"[^>]*>\[(\d+)\]/g)].map((m) => m[1]);
const notesIn = (html) => [...html.matchAll(/class="mp-link-num">\[(\d+)\]/g)].map((m) => m[1]);

async function article(html, opts = {}) {
  const P = await load('article-publish.js');
  return P.buildArticleOutput({
    html, edition: { kind: 'report', variant: 'light' }, tone: 'light', ...opts,
  });
}

test('external link numbering: dedupe on keeps [1,1,2]; dedupe off yields [1,2,3] in body and notes', async () => {
  const on = await article(LINK_1, { dedupe: true });
  assert.deepEqual(refsIn(on.wechatHtml), ['1', '1', '2'], '去重：同址共用编号');
  assert.deepEqual(notesIn(on.wechatHtml), ['1', '2'], '去重：文末只列唯一地址');

  const off = await article(LINK_1, { dedupe: false });
  assert.deepEqual(refsIn(off.wechatHtml), ['1', '2', '3'], '去重关：按出现次序编号');
  assert.deepEqual(notesIn(off.wechatHtml), ['1', '2', '3'], '去重关：文末与内文逐项对齐');
  /* 直接反例：第二项必须指到 [2]，不能仍指 [1]。 */
  const second = /A2<\/span>/.test(off.wechatHtml) ? off.wechatHtml : off.wechatHtml;
  assert.ok(/\[2\]/.test(second), '内文里必须出现 [2]');
  assert.ok(off.wechatHtml.indexOf('[1]') < off.wechatHtml.indexOf('[2]'), '编号按出现次序递增');
});

test('link notes can be turned off without leaving an empty section', async () => {
  const off = await article(LINK_1, { linkNotes: false });
  assert.deepEqual(refsIn(off.wechatHtml), [], '关掉编号后正文不留上标');
  assert.ok(!off.wechatHtml.includes('参考链接'), '不产生空的文末区块');
  assert.ok(!off.wechatHtml.includes('class="mp-link-notes"'));
  assert.equal(off.links.length, 2, '外链计划仍如实统计（面板显示用）');
});

test('sourceUrl never carries a local path into origin or canonical', async () => {
  const P = await load('edition-publish.js');
  for (const bad of ['D:\\work\\a.md', 'C:/Users/me/doc.md', '/home/me/a.md', 'file:///D:/a.md',
    './a.md', 'a.md', '\\\\host\\share\\a.md', 'javascript:alert(1)', 'data:text/html,x', '']) {
    assert.equal(P.publicArticleUrl(bad), '', '本机路径必须判空：' + bad);
  }
  for (const good of ['https://example.test/a', 'http://example.test/a?b=1']) {
    assert.equal(P.publicArticleUrl(good), new URL(good).href);
  }
  const local = await article('<p>x</p>', { sourceUrl: 'D:\\work\\a.md' });
  assert.ok(!local.documentHtml.includes('D:'), 'canonical 不得出现磁盘路径');
  assert.ok(!local.wechatHtml.includes('原文：'), '微信文末不得出现本机路径');
  const pub = await article('<p>x</p>', { sourceUrl: 'https://example.test/a' });
  assert.ok(pub.documentHtml.includes('<link rel="canonical" href="https://example.test/a">'));
  assert.ok(pub.wechatHtml.includes('原文：'));
});

test('wechat keeps formulas and diagrams as rasterisable nodes, never as code', async () => {
  const html = '<p>式 <span class="mp-math"><span class="katex">x</span></span> 完</p>'
    + '<div class="mp-math-block"><span class="katex">y</span></div>'
    + '<div class="mp-mermaid"><svg></svg></div>';
  const out = await article(html);
  assert.ok(out.wechatHtml.includes('class="mp-math"'), '行内公式类名保留（对话框据此栅格化）');
  assert.ok(out.wechatHtml.includes('class="mp-math-block"'));
  assert.ok(out.wechatHtml.includes('class="mp-mermaid"'));
  assert.ok(!/<code>x<\/code>/.test(out.wechatHtml), '公式不得降级成代码文本');
  assert.equal(out.summary.formulas, 2, '两处公式都计数');
  assert.equal(out.summary.diagrams, 1);
});

test('zhihu keeps real links, TeX source, semantic levels and code indentation', async () => {
  const html = '<h2>节二</h2><p>见 <a href="https://a.test/x">资料</a></p>'
    + '<pre><code>def f():\n    return 1\n</code></pre>'
    + '<p>式 <span class="mp-math" data-mp-tex="x^{2}"><span class="katex">x2</span></span></p>'
    + '<div class="mp-math-block" data-mp-tex="\\int a"><span class="katex">I</span></div>';
  const out = await article(html);
  assert.ok(out.zhihuHtml.includes('href="https://a.test/x"'), '知乎保留原文链接');
  assert.ok(out.zhihuHtml.includes('target="_blank"'));
  assert.ok(out.zhihuHtml.includes('ztext-math'), '公式带知乎认得的类');
  assert.ok(out.zhihuHtml.includes('data-tex="x^{2}"'), 'TeX 来源是真实输出（上标不被降级）');
  assert.ok(out.zhihuHtml.includes('data-display="block"'));
  assert.ok(out.zhihuHtml.includes('<h2'), '语义层级保留');
  assert.ok(out.zhihuHtml.includes('    return 1'), '代码缩进逐字保留');
  assert.ok(/white-space:pre-wrap/.test(out.zhihuHtml), '代码块必须保留换行与缩进');
});

test('footnote markers and links survive both publish formats', async () => {
  const html = '<p>正文<sup class="mp-fn-ref"><a id="fnref-1" href="#fn-1" class="mp-fn-ref-link" role="doc-noteref">[1]</a></sup></p>'
    + '<section class="mp-footnotes" role="doc-endnotes"><ol class="mp-footnotes-list"><li id="fn-1" value="1">'
    + '<span class="mp-fn-text">注文</span> <a class="mp-fn-back" href="#fnref-1" role="doc-backlink">↩</a></li></ol></section>';
  const out = await article(html);
  /* 微信：脚注引用拆成 span（不会被编成外链编号），文本与脚注区仍在。 */
  assert.ok(out.wechatHtml.includes('[1]'), '微信保留脚注编号文本');
  assert.ok(out.wechatHtml.includes('注文'), '脚注正文保留');
  assert.equal(out.links.length, 0, '脚注锚点不算外链');
  /* 知乎：锚点保留为可跳转链接。 */
  assert.ok(out.zhihuHtml.includes('href="#fn-1"'), '知乎脚注链接可跳');
  assert.ok(out.zhihuHtml.includes('href="#fnref-1"'));
});

test('local body images are embedded as data URLs, never file:/// or bare relative paths', async () => {
  /* extras.js 的发布取图链：与导出同一条 embedImageRefs + 宿主受权读取。 */
  assert.ok(/embedImageRefs\(refs, window\.__mpDocDir \|\| null/.test(extrasSource),
    '发布链必须走 embedImageRefs 与受权读取');
  assert.ok(/srcMap: images\.map/.test(extrasSource), '发布投影必须把图片映射带进 mdToHtml');
  assert.ok(!/sourceUrl: opts\.sourceUrl \|\| window\.__mpDocPath/.test(extrasSource),
    '绝不能把本机文档路径当 sourceUrl');
  assert.ok(/sourceUrl: publicArticleUrl\(opts\.sourceUrl\)/.test(extrasSource),
    'sourceUrl 必须经 publicArticleUrl 过滤');
  /* 行为面：带 data URL 的正文原样保留，且数据本身不被转义破坏。 */
  const data = 'data:image/png;base64,' + 'A'.repeat(64);
  const out = await article('<p><img src="' + data + '" alt="图"></p>');
  assert.ok(out.wechatHtml.includes(data), '内联图数据逐字保留');
  assert.ok(out.zhihuHtml.includes(data));
  assert.ok(!out.wechatHtml.includes('file:///'), '产物里不得出现 file:///');
});

test('clipboard contract: intent is taken at click time and is never retried without a token', () => {
  /* 注释里也会写 "await"，判据只看去掉注释后的代码。 */
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const copyArticle = stripComments(extrasSource.slice(
    extrasSource.indexOf('  async function copyArticle('),
    extrasSource.indexOf('  /** 兼容旧签名：复制为知乎/微信格式'),
  ));
  assert.ok(copyArticle.length > 200, 'copyArticle 必须存在');
  const intentAt = copyArticle.indexOf('beginClipboardIntent');
  const firstAwait = copyArticle.indexOf('await ');
  assert.ok(intentAt >= 0, 'copyArticle 必须取剪贴板意图');
  assert.ok(firstAwait > intentAt, '意图必须在任何 await（耗时预渲染）之前取得');
  /* ② 文档在预渲染期间变化 ⇒ 停止，不写剪贴板。 */
  assert.ok(/docAtClick/.test(copyArticle), '必须记住点击时的文档');
  assert.ok(/这次复制已取消/.test(copyArticle), '文档变了必须如实取消');
  const copyPublish = stripComments(extrasSource.slice(
    extrasSource.indexOf('  async function copyPublishHtml('),
    extrasSource.indexOf('  async function copyArticle('),
  ));
  /* ③ 受信宿主明示无效 ⇒ 不重试、不退系统剪贴板。 */
  assert.ok(!/writeClipboard\(\{ text, html \}\)/.test(copyPublish), '不得在带 token 失败后再用无 token 重试');
  assert.ok(/if \(usable\) \{/.test(copyPublish), '带 token 的失败必须单独收口');
  const usableBlock = copyPublish.slice(copyPublish.indexOf('if (usable) {'));
  assert.ok(usableBlock.indexOf('return false') < usableBlock.indexOf('navigator.clipboard'),
    '带 token 失败后必须先 return，不得继续落到系统剪贴板');
  /* ④ 最后一级只能复制纯文本 ⇒ 提示必须说"纯文本"，不能冒充格式已复制。 */
  const legacyAt = copyPublish.indexOf('execCommand(');
  assert.ok(legacyAt > 0, '必须有最后一级 textarea 兜底');
  const legacy = copyPublish.slice(legacyAt);
  assert.ok(legacy.includes('已复制纯文本'), 'execCommand 成功必须明确提示只复制了纯文本');
  for (const lie of [
    "toast(ok ? '已复制微信格式（可直接粘到公众号编辑器）'",
    "toast(ok ? '已复制知乎格式（可直接粘到知乎编辑器）'",
  ]) assert.ok(!copyPublish.includes(lie), '纯文本路径不得沿用富文本文案');
});

test('the native menu entry and the panel draft button delegate to one implementation', () => {
  const mainSource = fs.readFileSync(path.join(ENGINE, 'main.js'), 'utf8');
  const hook = mainSource.slice(mainSource.indexOf('window.mpWechat = {'));
  assert.ok(hook.includes('api.openWechatDraft'), '原生菜单入口必须委托 extras.openWechatDraft');
  assert.ok(!hook.includes('mdToHtml('), '原生菜单入口不得自己调 mdToHtml（会绕过版式与外链编号）');
  assert.ok(hook.includes('__ready: true'), '兼容名与就绪位保持不变');
  /* 面板草稿按钮与菜单同一条链。 */
  const panel = extrasSource.slice(
    extrasSource.indexOf('  function openPublishPanel('),
    extrasSource.indexOf('  async function openWechatDraftDialog('),
  );
  assert.ok(panel.includes('openWechatDraftDialog('), '面板草稿按钮必须走同一个 openWechatDraftDialog');
  assert.ok(/openWechatDraftDialog\(\{ linkNotes: state\.linkNotes, dedupe: state\.dedupe \}\)/.test(panel),
    '面板要把当前微信选项（编号/去重）传给草稿');
});

test('publish panel exposes target selection, both widths and the two wechat switches', () => {
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const panel = stripComments(extrasSource.slice(
    extrasSource.indexOf('  const PUBLISH_WIDTHS = ['),
    extrasSource.indexOf('  async function openWechatDraftDialog('),
  ));
  assert.ok(panel.length > 500, '发布面板必须真实存在');
  assert.ok(panel.includes("'wechat:微信', 'zhihu:知乎', 'document:静态文档'"), '三个目标文案必须齐全');
  assert.ok(panel.includes("{ id: 'phone', label: '手机 390', width: 390 }"), '手机宽度档');
  assert.ok(panel.includes("{ id: 'desktop', label: '桌面 100%', width: 0 }"), '桌面宽度档');
  assert.ok(panel.includes('data-pub-target='), '目标按钮挂属性');
  assert.ok(panel.includes('data-pub-width='), '宽度按钮挂属性');
  assert.ok(panel.includes('data-pub="linkNotes"'), '微信外链编号开关');
  assert.ok(panel.includes('data-pub="dedupe"'), '微信同址去重开关');
  assert.ok(panel.includes('sandbox'), '预览 iframe 必须沙箱化');
  /* 异步过时结果：只允许最新一次落地。 */
  assert.ok(/ticket !== building/.test(panel), '过时的预览结果必须丢弃');
  /* 【实测反例】微信与知乎两个目标必须各预览自己的载荷，不许共用导出文档。 */
  assert.ok(!/built\.documentHtml \|\| built\.wechatHtml/.test(panel), '不得用导出文档冒充微信/知乎预览');
  assert.ok(/targetKind === 'zhihu' \? built\.zhihuHtml : built\.wechatHtml/.test(panel),
    '微信/知乎预览必须分别取各自的载荷');
  assert.ok(/publishPreviewDocument\(/.test(panel), '预览要套在没有 MarkPilot CSS 的空白页里');
  assert.ok(!/iframe\.srcdoc = built\.wechatHtml/.test(panel), '微信预览不得直接吃导出载荷');
  assert.ok(/linkNotes: state\.linkNotes, dedupe: state\.dedupe/.test(panel), '改文末编号/去重必须重建预览');
});

test('publishPreviewDocument builds a blank page from real payloads without relying on host globals', async () => {
  const P = await load('article-publish.js');
  const built = P.buildArticleOutput({
    html: '<h1>标题</h1><p><a href="https://a.test/x">A</a></p>',
    edition: { kind: 'report', variant: 'light' }, tone: 'light', title: '稿件 <&>',
  });
  /* 实测反例：面板组装预览页时抛 ReferenceError: escapeHtml is not defined，永远停在"正在准备预览…"。
     这里直接调用同一个函数，任何未定义引用都会当场炸出来。 */
  for (const target of ['wechat', 'zhihu']) {
    const doc = P.publishPreviewDocument(target === 'zhihu' ? built.zhihuHtml : built.wechatHtml,
      { target, title: built.title });
    assert.ok(doc.startsWith('<!DOCTYPE html>'));
    assert.ok(doc.includes('max-width:690px'), '空白页只给版心，不带 MarkPilot CSS');
    assert.ok(!doc.includes('--mp-bg'), '预览页不得出现 MarkPilot 主题变量');
    assert.ok(!doc.includes('data-mp-article-recipe'), '预览页不得带配方属性（那会把版式 CSS 引进来）');
    assert.ok(doc.includes('稿件 &lt;&amp;&gt;'), '标题必须转义');
  }
  /* 两个目标的预览页必须不同（实测反例：逐字节相同）。 */
  const wxDoc = P.publishPreviewDocument(built.wechatHtml, { target: 'wechat' });
  const zhDoc = P.publishPreviewDocument(built.zhihuHtml, { target: 'zhihu' });
  assert.notEqual(wxDoc.replace(/微信（无外部 CSS）/g, ''), zhDoc.replace(/知乎（无外部 CSS）/g, ''),
    '微信与知乎的预览内容必须不同');
  assert.ok(wxDoc.includes('mp-link-ref'), '微信预览里能看见文末编号上标');
  assert.ok(zhDoc.includes('href="https://a.test/x"'), '知乎预览里保留普通链接');
});

test('plain edition keeps the legacy output shape (no recipe wrapper, no numbering)', async () => {
  const P = await load('article-publish.js');
  const out = P.buildArticleOutput({
    html: '<h1>标题</h1><p>甲</p>', edition: { kind: 'plain', variant: 'follow' }, tone: 'light',
  });
  assert.equal(out.documentHtml, '', 'plain 不生成静态文档包裹');
  assert.equal(out.documentCss, '');
  assert.ok(!out.wechatHtml.includes('mp-edition-num'), 'plain 不产生章节编号');
  assert.ok(out.wechatHtml.includes('<h1'), '标题仍原样输出');
  /* 旧口径的声明仍在（与改前 copyRich 的 inlineCss 同一批）。 */
  assert.ok(out.wechatHtml.includes('font-weight:600'), 'strong 仍 600');
  assert.ok(out.wechatHtml.includes('line-height:1.75') || out.wechatHtml.includes('line-height:1.75;'), '段落行高 1.75');
});
