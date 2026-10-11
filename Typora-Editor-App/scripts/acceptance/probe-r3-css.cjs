/** 探针 · 第 3 轮 CSS/主题判决"通过"项 T5' / C1 / C2 的实机验收（2026-10-02）。
 *
 *  判决来源：E:/MarkPilot/.zcode-tmp/round3-findings.md C 节（T5'/C1/C2 通过；
 *  C3 意见不改、C存疑2 否决——均不在本探针范围）。
 *  被测对象：extension-src/render 的 index.html / css/index.css / css/themes.css。
 *  **跑前先 `npm run sync`**（extension-src → 开发树 app/renderer），本探针按 harness
 *  dev 模式拉起开发树；--installed 则拉起安装版 EXE。**本探针不碰剪贴板**（纯 CSS/主题
 *  读数，无粘贴类用例，故也无需 save/restore）。
 *
 *  用例与红条件（旧代码必须 FAIL、新代码必须 PASS）：
 *    T5'标准表800px    telari-dark @800px 视口，3 列长文本表
 *       PASS：无横向滚动（table 与 pre.vditor-reset 的 scrollWidth<=clientWidth+2）、
 *             每格文本 Range rects>=2（真折行）、末列 right 在可视右缘内、td/th 计算
 *             white-space=normal
 *       红（旧 nowrap）：table(display:block,overflow:auto) 自身 scrollWidth 远超
 *             clientWidth、rects=1、末列被推出可视区
 *    T5'konayuki表800px konayuki-light @800px 同表
 *       PASS：同上四条 + table 计算 overflow-x=visible（不再 hidden 裁列）
 *       红（旧 overflow:hidden）：overflow-x=hidden；nowrap 下末列整列被裁
 *    C1静态链摘除       读 iframe head 的 content-theme 样式链
 *       PASS：不存在 id≠vditorContentTheme 的 content-theme link（静态链已摘），
 *             且动态链 link#vditorContentTheme 在（vditor preview.theme 路径未伤）
 *       红（旧 index.html:10）：静态 light.css link 仍在
 *    C1深色救回         切 telari-dark 读 h1 下边线 / hr 底色 / 引用竖线
 *       PASS：三色相对亮度均 <0.45 且不等于 #eaecef/#d1d5da/#fff
 *       红（旧）：静态 light.css 的 #eaecef(亮度 .83) 或动态 dark.css 的
 *             #d1d5da(亮度 .65) 任一在场
 *    C1六主题不裸奔     light/dark/konayuki×2/telari×2 逐主题读关键色（每主题截图）
 *       PASS：h1 下边线宽>=1px、hr 底色不透明非透明色、标题字色与纸面对比>=3、
 *             引用文字色与纸面对比>=2
 *       红（基线缺失）：h1 下边线宽 0（删链后无基线）、hr 透明、深底上近黑标题
 *    C1阅读面不裸奔     beige / green 阅读调色盘各读同口径（每盘截图）
 *       PASS：同上（调色盘 !important 规则接管颜色、基线提供线宽/可见性）
 *       红：调色盘下 h1 无下边线或 hr 不可见
 *    C2行悬停           konayuki-light 悬停表格奇数行与偶数行（真实 mouseMoved）
 *       PASS：悬停前后 tr 计算 backgroundColor 变化、移开复原（奇/偶两行都测）
 *       红（旧 themes.css:18 !important 压死）：背景恒为纸色/斑马色不变
 *
 *  突变验证注掉点（改完必须变红）：
 *    · themes.css 的 T5' 折行规则 → 两个 T5' 用例红；
 *    · themes.css konayuki 表 overflow:visible → konayuki 用例 overflow 断言红；
 *    · themes.css C2 hover 两条选择器 → C2 红；
 *    · index.html 恢复静态 link → C1静态链摘除 + C1深色救回 红；
 *    · index.css C1 基线块 → C1六主题（基础两套与 telari 的 h1 线宽/hr）红；
 *    · themes.css --content-rule 深色条目 → base dark 的 h1/hr 变 #141414 → 对比红。
 *
 *  输出：每用例一行 `R3CSS <名> PASS/FAIL <JSON>`；整页 + 关键处 2x 截图存
 *  .perf/probe-r3-css/（主题类用例必须截图）；log.json 汇总。
 *
 *  用法：node scripts/acceptance/probe-r3-css.cjs [--installed] [--only=t5,c1,c2] [--selfcheck]
 *        --selfcheck 只做模板校验（不启动产物）：把每条页内表达式代入后过一遍
 *        new Function 语法检查。不与其它 GUI 探针并行——铁律 3：单 GUI 串行。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const DEV = !process.argv.includes('--installed');
const OUT = path.join(harness.project, '.perf/probe-r3-css');
const IF = hi.IF;                 // 编辑器 iframe window 表达式
const S = hi.SURFACE;             // 编辑面选择器
const THEMES = ['light', 'dark', 'konayuki-light', 'konayuki-dark', 'telari-light', 'telari-dark'];
const sleep = harness.sleep;

// ─── 文档（现场生成，不碰素材房） ─────────────────────────────────────────────
const LONG_A = '很长的中文说明第一段把格子撑到必须折行的宽度abcdefghijklmnopqrstuvwxyz0123456789尾部';
const LONG_B = 'Another long cell payload with a very long unbreakable token https://example.invalid/a/very/long/path/segment/that/never/wraps naturally.';
const DOC = [
  '# R3CSS 验收标题一级', '',
  '## C1 标题二级', '',
  '正文段落，行内代码 code42 与普通文字混排，用于读行内代码底色。', '',
  '> 引用块一行文字，用于读引用文字色与竖线色。', '',
  '---', '',
  '分隔线之后的正文段。', '',
  '| T5头一 | T5头二 | T5头三 |',
  '| --- | --- | --- |',
  `| ${LONG_A} | ${LONG_B} | ${LONG_A}末列 |`,
  `| ${LONG_B} | ${LONG_A} | ${LONG_B}末列 |`,
  '',
].join('\n');

// ─── 页内观测器（只读，不改产品行为；与 r1/r2/r3 探针同一手法） ───────────────
const HELPERS = `(() => {
  if (window.__r3css) return 'already';
  const d = document;
  const parseColor = css => {
    const m = /rgba?\\(([\\d.]+), ?([\\d.]+), ?([\\d.]+)(?:, ?([\\d.]+))?\\)/.exec(String(css || ''));
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  };
  const lum = css => { const p = parseColor(css); if (!p) return null;
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(p.r) + 0.7152 * f(p.g) + 0.0722 * f(p.b); };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); if (x == null || y == null) return null;
    const hi2 = Math.max(x, y), lo = Math.min(x, y); return (hi2 + 0.05) / (lo + 0.05); };
  const cs = el => el ? getComputedStyle(el) : null;
  const surface = () => d.querySelector(${JSON.stringify(S)});
  const findTable = mark => [...d.querySelectorAll(${JSON.stringify(S)} + ' table')]
    .find(t => (t.rows[0] && t.rows[0].cells[0] ? t.rows[0].cells[0].textContent : '').includes(mark)) || null;
  const firstOpaqueBg = el => { let n = el || surface();
    while (n && n !== d.documentElement) { const c = cs(n);
      if (c) { const p = parseColor(c.backgroundColor); if (p && p.a > 0.9) return c.backgroundColor; }
      n = n.parentElement; }
    return 'rgb(255, 255, 255)'; };
  const cellRects = cell => { const r = d.createRange(); r.selectNodeContents(cell);
    return Array.from(r.getClientRects()).filter(b => b.height > 1 && b.width > 1).length; };
  const anchorOf = el => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + Math.min(r.width / 2, 300)), y: Math.round(r.top + 14), w: Math.round(r.width), h: Math.round(r.height) }; };
  const readC1 = () => {
    const root = surface(); if (!root) return { 有: false };
    const h1 = root.querySelector('h1'), h2 = root.querySelector('h2');
    const hr = root.querySelector('hr');
    const bq = root.querySelector('blockquote');
    const code = root.querySelector('p code, p span code');
    const bg = firstOpaqueBg(root);
    const out = { 有: true, 主题: d.documentElement.dataset.editorTheme || '', 纸面: bg };
    if (h1) { const c = cs(h1); out.h1 = { 字色: c.color, 线宽: c.borderBottomWidth, 线色: c.borderBottomColor,
      对纸面: contrast(c.color, bg), 盒: anchorOf(h1) }; }
    if (h2) { const c = cs(h2); out.h2 = { 线宽: c.borderBottomWidth, 线色: c.borderBottomColor }; }
    if (hr) { const c = cs(hr); out.hr = { 底色: c.backgroundColor, 高: c.height,
      亮度: lum(c.backgroundColor), 盒: anchorOf(hr) }; }
    if (bq) { const c = cs(bq); out.引用 = { 字色: c.color, 线色: c.borderLeftColor, 线宽: c.borderLeftWidth,
      对纸面: contrast(c.color, bg) }; }
    if (code) { const c = cs(code); out.行内代码 = { 底色: c.backgroundColor }; }
    return out; };
  const readTable = mark => {
    const t = findTable(mark); if (!t) return { 有: false };
    t.scrollIntoView({ block: 'center', behavior: 'instant' });
    const scroller = t.closest('pre.vditor-reset') || t.closest('.vditor-reset');
    const row = t.tBodies && t.tBodies[0] ? t.tBodies[0].rows[0] : null;
    const cells = row ? Array.from(row.cells) : [];
    const c = cs(t); const sr = scroller.getBoundingClientRect(); const tr2 = t.getBoundingClientRect();
    const last = cells[cells.length - 1];
    return { 有: true, 行数: t.rows.length, 列数: cells.length,
      表overflowX: c.overflowX, 表display: c.display, 表圆角: c.borderRadius,
      tdWhiteSpace: cells.length ? cs(cells[0]).whiteSpace : null,
      表滚动: { sw: t.scrollWidth, cw: t.clientWidth },
      面滚动: { sw: scroller.scrollWidth, cw: scroller.clientWidth },
      末列right: last ? Math.round(last.getBoundingClientRect().right) : null,
      表右缘: Math.round(tr2.right), 面可视右缘: Math.round(sr.left + scroller.clientWidth),
      视口宽: window.innerWidth,
      各格rects: cells.map(cell => cellRects(cell)),
      盒: anchorOf(t) }; };
  const readRow = (mark, idx) => { const t = findTable(mark); if (!t) return null;
    const row = t.tBodies && t.tBodies[0] ? t.tBodies[0].rows[idx] : null; if (!row) return null;
    row.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = row.getBoundingClientRect();
    return { 背景: cs(row).backgroundColor, 盒: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } }; };
  const themeLinks = () => Array.from(d.querySelectorAll('link[rel="stylesheet"]'))
    .map(l => ({ href: l.href, id: l.id || '' })).filter(x => x.href.indexOf('content-theme') >= 0)
    .map(x => ({ id: x.id, 尾: x.href.slice(-24), 已加载: !!(l0 => l0 && l0.sheet && l0.sheet.cssRules && l0.sheet.cssRules.length)(d.getElementById(x.id)) }));
  const contentTheme = () => { const l = d.getElementById('vditorContentTheme');
    if (!l) return { 动态链: false };
    return { 动态链: true, href: l.href, 已加载: !!(l.sheet && l.sheet.cssRules && l.sheet.cssRules.length) }; };
  window.__r3css = { parseColor, lum, contrast, findTable, readC1, readTable, readRow, themeLinks, contentTheme };
  return 'installed';
})();`;

const INSTALL = '(() => { const w = ' + IF + ';'
  + ' if (!w || !w.document.querySelector(' + JSON.stringify(S) + ')) return { ok: false };'
  + ' if (!w.__r3css) w.eval(' + JSON.stringify(HELPERS) + ');'
  + ' return { ok: !!w.__r3css }; })()';
const IN = expression => '(() => { const w = ' + IF + '; return w.eval(' + JSON.stringify(expression) + '); })()';
const ev = (session, expression) => session.js(IN(expression));
const frameOf = session => session.js(`(() => { const f = document.getElementById('editor');
  const r = f.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()`);

/** 切主题：走真产品模块 themes.js 的 applyTheme（同时挂 data-editor-theme、调
 *  vditor.setTheme 换 UI 主题与动态内容链）。
 *  **必须在 iframe 自己的 realm 里 import**（首跑教训）：顶层上下文的动态 import 会在
 *  外壳 realm 另装一份 themes.js，其 document 是外壳页——dataset 挂到外壳 <html> 上，
 *  编辑面主题纹丝不动，六个主题读数全是启动主题。用 w.eval 在 iframe 里 import：
 *  URL 按 iframe 自己的 index.js <script src> 解析（文档 <base> 指向素材目录、
 *  location 是 /doc/<路径>，都不能直接拼），命中 iframe 模块表缓存（index.js 已静态
 *  引入过同一 URL），拿到的是操作正确 document 的同一个模块实例。
 *  import 不可用时在 iframe 内退化为手工等价路径，并在输出里标注。 */
const SET_THEME = (session, theme) => session.js(`(async () => { const w = ${IF};
  if (!w) return { ok: false, 错: '没有编辑器窗口' };
  const entry = w.document.querySelector('script[src*="index.js"]');
  const base = entry ? entry.src : new URL('/render/index.js', w.location.origin).href;
  const url = new URL('./js/themes.js', base).href;
  const theme = ${JSON.stringify(theme)};
  try {
    const src = '(async () => { const m = await import(' + JSON.stringify(url) + ');'
      + ' m.applyTheme(window.vditor, ' + JSON.stringify(theme) + '); })()';
    await w.eval(src);
    return { ok: true, 通道: 'iframe-import.applyTheme', 落位: w.document.documentElement.dataset.editorTheme || '' };
  } catch (error) {
    const manual = '(function () { document.documentElement.dataset.editorTheme = ' + JSON.stringify(theme) + ';'
      + ' const v = window.vditor; if (v && v.setTheme) { const dark = ' + JSON.stringify(String(theme).endsWith('dark')) + ';'
      + ' v.setTheme(dark ? "dark" : "light", dark ? "dark" : "light", dark ? "github-dark" : "github"); } })()';
    await w.eval(manual);
    return { ok: true, 通道: 'iframe-manual', 落位: w.document.documentElement.dataset.editorTheme || '',
      误: String(error && error.message || error).slice(0, 120) };
  } })()`);

/** 切阅读调色盘（reading-palette.js 的真模块；applyPalette 只挂 dataset，无异步）。 */
const SET_PALETTE = (session, palette) => session.js(`(async () => { const w = ${IF};
  if (!w) return { ok: false };
  const entry = w.document.querySelector('script[src*="index.js"]');
  const base = entry ? entry.src : new URL('/render/index.js', w.location.origin).href;
  const url = new URL('./js/reading-palette.js', base).href;
  const palette = ${JSON.stringify(palette)};
  try {
    const src = '(async () => { const m = await import(' + JSON.stringify(url) + ');'
      + ' m.applyPalette(window.vditor, ' + JSON.stringify(palette) + '); })()';
    await w.eval(src);
    return { ok: true, 通道: 'iframe-import.applyPalette', 落位: w.document.documentElement.dataset.readingPalette || '' };
  } catch (error) {
    await w.eval('document.documentElement.dataset.readingPalette = ' + JSON.stringify(palette) + ';');
    return { ok: true, 通道: 'iframe-manual', 落位: w.document.documentElement.dataset.readingPalette || '',
      误: String(error && error.message || error).slice(0, 120) };
  } })()`);

/** 等编辑面的 data-editor-theme 真的翻到目标值（不吞结果：返回 false 时用例必须 FAIL，
 *  首跑的静默 .catch 让"没切过去"伪装成了样式问题）。 */
async function waitTheme(session, theme, timeout = 6000) {
  const hit = await session.until(`(() => { const w = ${IF}; return !!(w && w.document.documentElement.dataset.editorTheme === ${JSON.stringify(theme)}); })()`,
    { timeout, interval: 80 }).catch(() => false);
  return !!hit;
}

/** 等动态内容链换到期望的 light/dark.css 并真的解析出规则（旧世界的亮色来自这条链，
 *  红条件要求它在场；新世界里产品层规则特异性更高，不受它影响）。 */
async function waitContentTheme(session, name, timeout = 6000) {
  const stop = Date.now() + timeout;
  let last = null;
  while (Date.now() < stop) {
    last = await ev(session, 'window.__r3css.contentTheme()');
    if (last && last.动态链 && String(last.href).endsWith('/' + name + '.css') && last.已加载) return last;
    await sleep(120);
  }
  return last;
}

/** 整页 + 关键处 2x 放大截图（截图证据规则：主题类必须截图；anchor 为 iframe 内坐标）。 */
async function shots(session, name, anchor, span) {
  try {
    await session.shot(name + '-full');
    if (!anchor) return;
    const frame = await frameOf(session);
    const w = Math.min((span && span.w || 560) + 120, 1500), h = Math.min((span && span.h || 160) + 120, 900);
    const clip = { x: Math.max(0, frame.x + anchor.x - Math.round(w / 2)),
      y: Math.max(0, frame.y + anchor.y - Math.round(h / 3)), width: w, height: h, scale: 2 };
    const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(OUT, name + '-2x.png'), Buffer.from(shot.data, 'base64'));
  } catch (error) { console.log('  （截图失败 ' + name + '：' + String(error && error.message || error).slice(0, 120) + '）'); }
}

// ─── 用例 ─────────────────────────────────────────────────────────────────────
async function caseT5(session, say, theme, name) {
  const switched = await SET_THEME(session, theme);
  const 落位 = await waitTheme(session, theme);
  await sleep(350);
  await waitContentTheme(session, theme.endsWith('dark') ? 'dark' : 'light');
  await session.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {});
  await sleep(500);
  const read = await ev(session, 'window.__r3css.readTable("T5头")');
  if (!read || !read.有) { say(`R3CSS ${name} FAIL ` + JSON.stringify({ 切换: switched, 落位, 表: '没找到 T5头 表' })); return; }
  const 滚动超标 = [['表', read.表滚动], ['面', read.面滚动]].filter(([, s]) => s.sw > s.cw + 2).map(([k, s]) => `${k}:${s.sw}>${s.cw}`);
  const 末列可见 = read.末列right !== null && read.末列right <= Math.min(read.面可视右缘, read.视口宽) + 2;
  const 格行数够 = read.各格rects.length > 0 && read.各格rects.every(n => n >= 2);
  const 折行开 = read.tdWhiteSpace === 'normal';
  const 不裁 = read.表overflowX !== 'hidden';
  const pass = 落位 && 滚动超标.length === 0 && 末列可见 && 格行数够 && 折行开 && 不裁;
  say(`R3CSS ${name} ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    切换: switched, 落位, 主题: theme, 视口宽: read.视口宽, 表overflowX: read.表overflowX, 表display: read.表display,
    表圆角: read.表圆角, tdWhiteSpace: read.tdWhiteSpace, 滚动超标, 末列right: read.末列right,
    面可视右缘: read.面可视右缘, 末列可见, 各格rects: read.各格rects, 折行开, 不裁 }));
  await shots(session, name, read.盒, { w: read.盒.w, h: read.盒.h });
}

async function caseC1Link(session, say) {
  const links = await ev(session, 'window.__r3css.themeLinks()');
  const 动态 = (links || []).filter(x => x.id === 'vditorContentTheme');
  const 静态 = (links || []).filter(x => x.id !== 'vditorContentTheme');
  const pass = 静态.length === 0 && 动态.length === 1;
  say(`R3CSS C1静态链摘除 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({ 静态链: 静态, 动态链: 动态 }));
}

async function caseC1Dark(session, say) {
  const switched = await SET_THEME(session, 'telari-dark');
  const 落位 = await waitTheme(session, 'telari-dark');
  await sleep(350);
  await waitContentTheme(session, 'dark');
  const read = await ev(session, 'window.__r3css.readC1()');
  if (!read || !read.有) { say('R3CSS C1深色救回 FAIL ' + JSON.stringify({ 切换: switched, 落位, 读: '没读到编辑面' })); return; }
  const lumOf = c => {
    const m = /rgba?\(([\d.]+), ([\d.]+), ([\d.]+)/.exec(String(c || '')); if (!m) return null;
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(+m[1]) + 0.7152 * f(+m[2]) + 0.0722 * f(+m[3]);
  };
  const 亮白系 = c => ['rgb(234, 236, 239)', 'rgb(209, 213, 218)', 'rgb(255, 255, 255)'].includes(String(c).trim());
  const h1线 = read.h1 ? lumOf(read.h1.线色) : null;
  const h2线 = read.h2 ? lumOf(read.h2.线色) : null;
  const hr亮 = read.hr ? lumOf(read.hr.底色) : null;
  const 引线 = read.引用 ? lumOf(read.引用.线色) : null;
  const ok = v => v !== null && v < 0.45;
  // 线宽阈值 0.5px：本机 DPI 150% 时 1px 边框会被 Chrome 对齐到 1 个物理像素＝
  // 计算 0.666667px（首跑实测），视觉在、数字小于 1——"有没有线"看 0.5，不看 1。
  const pass = 落位 && ok(h1线) && ok(h2线) && ok(hr亮) && ok(引线)
    && !亮白系(read.h1 && read.h1.线色) && !亮白系(read.hr && read.hr.底色)
    && parseFloat(read.h1 && read.h1.线宽 || 0) >= 0.5 && read.hr && read.hr.底色 !== 'rgba(0, 0, 0, 0)';
  say(`R3CSS C1深色救回 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    切换: switched, 落位, 主题: read.主题, h1: read.h1, h2: read.h2, hr: read.hr, 引用: read.引用,
    h1线亮度: h1线 === null ? null : +h1线.toFixed(3), hr亮度: hr亮 === null ? null : +hr亮.toFixed(3),
    引线亮度: 引线 === null ? null : +引线.toFixed(3), 阈值: 0.45 }));
  await shots(session, 'C1深色救回-telari-dark', read.h1 && read.h1.盒, { w: 560, h: 200 });
}

async function caseC1Six(session, say) {
  const 每主题 = [];
  let pass = true;
  for (const theme of THEMES) {
    const switched = await SET_THEME(session, theme);
    const 落位 = await waitTheme(session, theme);
    await sleep(300);
    await waitContentTheme(session, theme.endsWith('dark') ? 'dark' : 'light');
    const read = await ev(session, 'window.__r3css.readC1()');
    if (!read || !read.有) { pass = false; 每主题.push({ 主题: theme, 切换: switched, 落位, 错: '没读到编辑面' }); continue; }
    // 线宽阈值 0.5px：DPI 150% 下 1px 边框计算值 0.666667px（见 caseC1Dark 注）
    const h1线宽 = read.h1 ? parseFloat(read.h1.线宽 || 0) : 0;
    const hr可见 = !!read.hr && read.hr.底色 !== 'rgba(0, 0, 0, 0)' && read.hr.底色 !== 'transparent';
    const 标题对比 = read.h1 && typeof read.h1.对纸面 === 'number' ? read.h1.对纸面 : 0;
    const 引用对比 = read.引用 && typeof read.引用.对纸面 === 'number' ? read.引用.对纸面 : 0;
    const ok = 落位 && h1线宽 >= 0.5 && hr可见 && 标题对比 >= 3 && 引用对比 >= 2;
    if (!ok) pass = false;
    每主题.push({ 主题: theme, 落位, h1线宽, h1线色: read.h1 && read.h1.线色, 标题字色: read.h1 && read.h1.字色,
      纸面: read.纸面, 标题对比: +标题对比.toFixed(2), hr底色: read.hr && read.hr.底色, hr可见,
      引用字色: read.引用 && read.引用.字色, 引用对比: +引用对比.toFixed(2), ok });
    await shots(session, 'C1六主题-' + theme, read.h1 && read.h1.盒, { w: 560, h: 200 });
  }
  say(`R3CSS C1六主题不裸奔 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify(每主题));
}

async function caseC1Palette(session, say) {
  await SET_THEME(session, 'light');
  await waitTheme(session, 'light');
  await sleep(250);
  const 每盘 = [];
  let pass = true;
  for (const palette of ['beige', 'green']) {
    const switched = await SET_PALETTE(session, palette);
    await sleep(300);
    const read = await ev(session, 'window.__r3css.readC1()');
    if (!read || !read.有) { pass = false; 每盘.push({ 盘: palette, 切换: switched, 错: '没读到编辑面' }); continue; }
    // 线宽阈值 0.5px：DPI 150% 下 1px 边框计算值 0.666667px（见 caseC1Dark 注）
    const h1线宽 = read.h1 ? parseFloat(read.h1.线宽 || 0) : 0;
    const hr可见 = !!read.hr && read.hr.底色 !== 'rgba(0, 0, 0, 0)' && read.hr.底色 !== 'transparent';
    const 标题对比 = read.h1 && typeof read.h1.对纸面 === 'number' ? read.h1.对纸面 : 0;
    const ok = h1线宽 >= 0.5 && hr可见 && 标题对比 >= 3;
    if (!ok) pass = false;
    每盘.push({ 盘: palette, 落位: switched && switched.落位, h1线宽, h1线色: read.h1 && read.h1.线色,
      标题字色: read.h1 && read.h1.字色, 纸面: read.纸面, 标题对比: +标题对比.toFixed(2),
      hr底色: read.hr && read.hr.底色, hr可见, ok });
    await shots(session, 'C1阅读面-' + palette, read.h1 && read.h1.盒, { w: 560, h: 200 });
  }
  await SET_PALETTE(session, 'theme');   // 还原，不把调色盘留在会话状态里
  say(`R3CSS C1阅读面不裸奔 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify(每盘));
}

async function caseC2(session, say) {
  const switched = await SET_THEME(session, 'konayuki-light');
  const 落位 = await waitTheme(session, 'konayuki-light');
  await sleep(350);
  await waitContentTheme(session, 'light');
  const frame = await frameOf(session);
  await session.send('Page.bringToFront').catch(() => {});
  await session.move(8, 8);   // 先挪到中性位置，避免既有悬停污染基线
  await sleep(150);
  const rows = [];
  let pass = 落位;
  for (const idx of [0, 1]) {   // 奇数行（第 1 行）与偶数行（斑马，第 2 行）
    const before = await ev(session, `window.__r3css.readRow("T5头", ${idx})`);
    if (!before) { pass = false; rows.push({ 行: idx + 1, 错: '没找到行' }); continue; }
    await session.move(frame.x + before.盒.x, frame.y + before.盒.y);
    await sleep(180);
    const during = await ev(session, `window.__r3css.readRow("T5头", ${idx})`);
    if (during) await shots(session, `C2行悬停-行${idx + 1}`, { x: before.盒.x, y: before.盒.y }, { w: 560, h: 90 });
    await session.move(8, 8);
    await sleep(180);
    const after = await ev(session, `window.__r3css.readRow("T5头", ${idx})`);
    const 变 = during && during.背景 !== before.背景;
    const 复原 = after && after.背景 === before.背景;
    if (!变 || !复原) pass = false;
    rows.push({ 行: idx + 1, 斑马: idx % 2 === 1, 悬停前: before.背景, 悬停中: during && during.背景,
      移开后: after && after.背景, 变, 复原 });
  }
  say(`R3CSS C2行悬停 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({ 切换: switched, 落位, rows }));
}

// ─── 模板校验（--selfcheck：不启动产物，只证明每条页内表达式语法成立） ─────────
function selfcheck() {
  const expressions = [
    'window.__r3css.readC1()', 'window.__r3css.readTable("T5头")', 'window.__r3css.readRow("T5头", 0)',
    'window.__r3css.themeLinks()', 'window.__r3css.contentTheme()', INSTALL,
    'window.__r3css.readRow("T5头", 1)',
  ];
  const substituted = [
    ...expressions,
    `(async () => { const w = ${IF}; const entry = w.document.querySelector('script[src*="index.js"]');
       const url = new URL('./js/themes.js', entry.src).href; const theme = ${JSON.stringify('light')};
       const src = '(async () => { const m = await import(' + JSON.stringify(url) + ');'
         + ' m.applyTheme(window.vditor, ' + JSON.stringify(theme) + '); })()';
       await w.eval(src); })()`,
    `(async () => { const w = ${IF}; const entry = w.document.querySelector('script[src*="index.js"]');
       const url = new URL('./js/reading-palette.js', entry.src).href; const palette = ${JSON.stringify('beige')};
       const src = '(async () => { const m = await import(' + JSON.stringify(url) + ');'
         + ' m.applyPalette(window.vditor, ' + JSON.stringify(palette) + '); })()';
       await w.eval(src); })()`,
    `(() => { const w = ${IF}; return !!(w && w.document.documentElement.dataset.editorTheme === 'dark'); })()`,
    `(() => { const f = document.getElementById('editor'); const r = f.getBoundingClientRect(); return r.x; })()`,
  ];
  let bad = 0;
  for (const text of substituted) {
    try { new Function('return (' + text.replace(/\;$/, '') + ');'); }
    catch (error) { bad++; console.log('模板语法红：' + String(error.message).slice(0, 160) + '\n  ← ' + text.slice(0, 160)); }
  }
  // HELPERS 本体也要单独过一遍（它以 IIFE 形式自执行）
  try { new Function(HELPERS); } catch (error) { bad++; console.log('HELPERS 语法红：' + error.message); }
  console.log(`selfcheck：${substituted.length + 1} 条模板，语法红 ${bad} 条`);
  return bad === 0;
}

// ─── 主流程 ────────────────────────────────────────────────────────────────────
(async () => {
  if (process.argv.includes('--selfcheck')) { process.exitCode = selfcheck() ? 0 : 1; return; }
  const only = (() => { const hit = process.argv.find(a => a.startsWith('--only=')); return hit ? hit.slice(7).split(',').map(s => s.trim().toLowerCase()) : null; })();
  const want = name => !only || only.some(k => name.toLowerCase().includes(k));

  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'r3-css.md');
  fs.writeFileSync(file, DOC, 'utf8');

  const exe = DEV ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
    : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
  const ctx = {
    launch: options => harness.launch({ exe, ...(DEV ? { appArgs: [path.join(harness.project, 'app/main/main.js')] } : {}),
      label: 'probe-r3-css', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  let session = null;
  try {
    session = await hi.openDoc(ctx, file, { minBlocks: 5, settleMs: 1600 });
    const installed = await session.js(INSTALL);
    if (!installed || !installed.ok) throw new Error('观测器没装上：' + JSON.stringify(installed));
    await session.send('Page.bringToFront').catch(() => {});

    if (want('t5')) {
      await caseT5(session, say, 'telari-dark', "T5'标准表800px");
      await caseT5(session, say, 'konayuki-light', "T5'konayuki表800px");
      await session.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      await sleep(400);
    }
    if (want('c1')) {
      await caseC1Link(session, say);
      await caseC1Dark(session, say);
      await caseC1Six(session, say);
      await caseC1Palette(session, say);
    }
    if (want('c2')) await caseC2(session, say);

    if (session.errors && session.errors.length) say('console错误（按错误面规则需人工看一眼）：' + JSON.stringify(session.errors.slice(0, 5)));
    else say('console错误：无');
    const fails = log.filter(line => / FAIL /.test(line)).length;
    say(`R3CSS 汇总：${log.filter(line => / PASS | FAIL /.test(line)).length} 用例，FAIL ${fails}`);
  } finally {
    try { await ctx.release(session); } catch { /* 已关 */ }
    fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2));
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
