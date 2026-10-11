/** 探针 · 第 5 轮主题域修复的实机验收（R5TH，2026-10-02）。
 *
 *  判决来源：E:/MarkPilot/.zcode-tmp/round5-findings.md T 节 + 对抗辩论结论
 *  （B4/T1/T2/T4 通过改码；T3 存疑不动、T5/T6/T8 意见不动——均不在本探针范围）。
 *  被测对象：extension-src/render 的 js/vscode.js、css/telari.css、
 *  css/reading-palette.css、css/typography.css（typora-themes/宋体-*.css 是 Typora
 *  导出件，不进本编辑器探针，同值由源码对拍保证）。
 *  **跑前先 `npm run sync`**（extension-src → 开发树 app/renderer），本探针按 harness
 *  dev 模式拉起开发树；--installed 则拉起安装版 EXE。**本探针不碰剪贴板**（纯主题/
 *  样式读数，无粘贴类用例）。
 *
 *  用例与红条件（旧代码必须 FAIL、新代码必须 PASS）：
 *    B4链接色           telari-light 读 a 链接 computed color，须等于 --primary-color
 *                       的解析值；且页面里不存在 addThemeCss 注入的 --vscode-* 覆盖
 *                       style（EXE 里变量未定义 → IACVT）。
 *                       红（旧 `if (vscode)` 在 EXE 也注入）：注入 style 在场，
 *                       链接色坍成 unset/继承色（近黑），≠ 主色。
 *    T1引用对比light     telari-light 引用文字 computed color 对引用底 #F1EFE9 与
 *                       纸面 #FAF9F6 实算对比度均 ≥4.5（新值 #636362 预期
 *                       5.23 / 5.71；旧 #7C7C7B 只有 3.63/3.97 必红）。
 *    T1引用对比dark      telari-dark 同口径，对引用底 #353C4A 与纸面 #2E3440 均
 *                       ≥4.5（新值 #A4A8AE 预期 4.64 / 5.23；旧 #929599 只有
 *                       3.68/4.15 必红）。
 *    T2调色盘压斑马      telari-dark + beige 调色盘叠加：偶数行 computed
 *                       backgroundColor 须等于调色盘 --reading-code #E9E2D1、
 *                       奇数行等于 --reading-bg #F4EFDF，且偶数行 ≠ telari 暗条纹
 *                       #353C4A。
 *                       红（旧选择器无 tbody，特异性 (0,4,2) 压不过 telari 的
 *                       (0,4,3)）：偶数行仍是暗条纹横在浅纸上。
 *    T4斜体1.18em        telari-light 与基础 light 两处读 em 斜体 computed
 *                       fontSize ÷ 所在段正文字号 == 1.18（±0.011 容差）。
 *                       telari 读数钉 telari.css:179；light 读数钉 typography.css
 *                       的全局 em 基线（两处突变点分别可观测）。红（旧 1.12em /
 *                       typography 无 font-size）：比值 1.12 或 1.0。
 *    B4修前对照IACVT     现场调 window.addThemeCss() 注入一遍旧覆盖（对照"修前"
 *                       状态）：链接色必须立刻偏离主色（红条件实证），随后移除注入
 *                       style、链接色必须复原等于主色（移不干净也算 FAIL）。
 *
 *  突变验证注掉点（改完必须变红）：
 *    · vscode.js 判宿主改回 `if (vscode)` → B4链接色 红（注入 style 在场）；
 *    · telari.css light --text-muted/--text-subtle 回 #7C7C7B → T1引用对比light 红；
 *    · telari.css dark 同组回 #929599 → T1引用对比dark 红；
 *    · reading-palette.css 两行选择器去掉 tbody → T2调色盘压斑马 红；
 *    · telari.css:179 回 1.12em → T4 的 telari 读数红；typography.css 的 em 段
 *      去掉 font-size → T4 的 light 读数红（1.0）。
 *
 *  输出：每用例一行 `R5TH <名> PASS/FAIL <JSON>`；整页 + 关键处 2x 截图存
 *  .perf/probe-r5-theme/（B4 链接色、T1 引用段、T4 斜体段必截）；log.json 汇总。
 *
 *  用法：node scripts/acceptance/probe-r5-theme.cjs [--installed] [--only=b4,t1,t2,t4] [--selfcheck]
 *        --selfcheck 只做模板校验（不启动产物）：把每条页内表达式代入后过一遍
 *        new Function 语法检查。不与其它 GUI 探针并行——铁律 3：单 GUI 串行。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const DEV = !process.argv.includes('--installed');
const OUT = path.join(harness.project, '.perf/probe-r5-theme');
const IF = hi.IF;                 // 编辑器 iframe window 表达式
const S = hi.SURFACE;             // 编辑面选择器
const sleep = harness.sleep;

// 调色盘/斑马的期望常量（reading-palette.css / telari.css 源值，rgb 串与 computed 对拍）
const BEIGE_BG = 'rgb(244, 239, 223)';      // #F4EFDF --reading-bg
const BEIGE_CODE = 'rgb(233, 226, 209)';    // #E9E2D1 --reading-code
const TELARI_STRIPE_DARK = 'rgb(53, 60, 74)'; // #353C4A telari-dark 偶数行斑马

// ─── 文档（现场生成，不碰素材房） ─────────────────────────────────────────────
const DOC = [
  '# R5TH 主题验收标题', '',
  '正文段一，包含一个[外部链接文字](https://example.invalid/r5)用于读链接颜色，前后有普通文字。', '',
  '> 引用块里的普通文字，用于读引用文字色、引用底色与对比度。', '',
  '正文段二，包含*斜体强调文字*用于读斜体字号，前后有普通文字对照。', '',
  '| 表头甲 | 表头乙 |',
  '| --- | --- |',
  '| 奇数行甲格 | 奇数行乙格 |',
  '| 偶数行甲格 | 偶数行乙格 |',
  '',
].join('\n');

// ─── 页内观测器（只读，不改产品行为；与 r3-css 探针同一手法） ───────────────────
const HELPERS = `(() => {
  if (window.__r5th) return 'already';
  const d = document;
  const parseColor = css => {
    const s = String(css || '').trim();
    let m = /rgba?\\(([\\d.]+), ?([\\d.]+), ?([\\d.]+)(?:, ?([\\d.]+))?\\)/.exec(s);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) { const n = parseInt(m[1], 16); return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255, a: 1 }; }
    m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) { const n = m[1]; return { r: parseInt(n[0] + n[0], 16), g: parseInt(n[1] + n[1], 16), b: parseInt(n[2] + n[2], 16), a: 1 }; }
    return null;
  };
  const lum = css => { const p = parseColor(css); if (!p) return null;
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(p.r) + 0.7152 * f(p.g) + 0.0722 * f(p.b); };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); if (x == null || y == null) return null;
    const hi2 = Math.max(x, y), lo = Math.min(x, y); return (hi2 + 0.05) / (lo + 0.05); };
  const norm = css => { const p = parseColor(css); return p ? p.r + ',' + p.g + ',' + p.b : String(css); };
  const same = (a, b) => norm(a) === norm(b);
  const cs = el => el ? getComputedStyle(el) : null;
  const surface = () => d.querySelector(${JSON.stringify(S)});
  const cssVar = name => { const el = surface(); if (!el) return '';
    return String(getComputedStyle(el).getPropertyValue(name) || '').trim(); };
  const findTable = mark => [...d.querySelectorAll(${JSON.stringify(S)} + ' table')]
    .find(t => (t.rows[0] && t.rows[0].cells[0] ? t.rows[0].cells[0].textContent : '').includes(mark)) || null;
  const firstOpaqueBg = el => { let n = el || surface();
    while (n && n !== d.documentElement) { const c = cs(n);
      if (c) { const p = parseColor(c.backgroundColor); if (p && p.a > 0.9) return c.backgroundColor; }
      n = n.parentElement; }
    return 'rgb(255, 255, 255)'; };
  const anchorOf = el => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + Math.min(r.width / 2, 300)), y: Math.round(r.top + 14), w: Math.round(r.width), h: Math.round(r.height) }; };
  const readLink = () => {
    const root = surface(); if (!root) return { 有: false };
    let a = [...root.querySelectorAll('a')].find(x => /example\\.invalid/.test(x.href || '')) || root.querySelector('a');
    if (!a) {
      // IR 态链接不渲染真 <a>（marker span 形态）：注入一个探针链接进首段读 computed color——
      // B4 验的是样式层叠（addThemeCss 的 * !important vs 主题 a 色），载体由探针提供即可。
      const p = root.querySelector('p'); if (!p) return { 有: false };
      a = document.createElement('a'); a.href = 'https://example.invalid/r5'; a.textContent = '探针链接';
      a.id = 'r5th-probe-link'; p.appendChild(document.createTextNode(' ')); p.appendChild(a);
    }
    a.scrollIntoView({ block: 'center', behavior: 'instant' });
    const c = cs(a); const pv = cssVar('--primary-color');
    return { 有: true, 链接色: c.color, primary变量: pv, 相等: same(c.color, pv),
      盒: anchorOf((a.closest('p') || a.parentElement || a)) }; };
  const readQuote = () => {
    const root = surface(); const bq = root && root.querySelector('blockquote');
    if (!bq) return { 有: false };
    bq.scrollIntoView({ block: 'center', behavior: 'instant' });
    const c = cs(bq); const paper = firstOpaqueBg(bq.parentElement);
    return { 有: true, 主题: d.documentElement.dataset.editorTheme || '', 引用字色: c.color,
      引用底: c.backgroundColor, subtle变量: cssVar('--text-subtle'), 纸面: paper,
      对引用底: contrast(c.color, c.backgroundColor), 对纸面: contrast(c.color, paper),
      盒: anchorOf(bq) }; };
  const readEm = () => {
    const root = surface(); const em = root && root.querySelector('p em, p i');
    if (!em) return { 有: false };
    em.scrollIntoView({ block: 'center', behavior: 'instant' });
    const p = em.closest('p') || em.parentElement;
    const ec = cs(em), pc = cs(p);
    // T4 视觉裁决补充：字形实际高度（单字符 Range 矩形）——computed 字号大但字形等高时（字体度量差）以字形为准
    const rect = el => { const t = el.firstChild; if (!t || t.nodeType !== 3) return null;
      const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, 1); const b = r.getBoundingClientRect();
      return Math.round(b.height * 10) / 10; };
    const emH = rect(em); let bodyH = null;
    for (const t of p.childNodes) { if (t.nodeType === 3 && t.data.trim()) { const r = document.createRange();
      r.setStart(t, 0); r.setEnd(t, 1); bodyH = Math.round(r.getBoundingClientRect().height * 10) / 10; break; } }
    return { 有: true, 主题: d.documentElement.dataset.editorTheme || '', em字号: ec.fontSize,
      正文字号: pc.fontSize, 比值: +(parseFloat(ec.fontSize) / parseFloat(pc.fontSize)).toFixed(4),
      em字形高: emH, 正文字形高: bodyH, 字形比: emH && bodyH ? +(emH / bodyH).toFixed(4) : null,
      盒: anchorOf(p) }; };
  const readRow = (mark, idx) => { const t = findTable(mark); if (!t) return null;
    const row = t.tBodies && t.tBodies[0] ? t.tBodies[0].rows[idx] : null; if (!row) return null;
    row.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = row.getBoundingClientRect();
    return { 背景: cs(row).backgroundColor, 盒: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) } }; };
  const injectedStyles = () => Array.from(d.querySelectorAll('style'))
    .filter(s => String(s.textContent || '').indexOf('--vscode-editor-background') >= 0);
  const injectedCount = () => injectedStyles().length;
  const removeInjected = () => { let n = 0; for (const s of injectedStyles()) { s.remove(); n++; } return n; };
  window.__r5th = { parseColor, lum, contrast, norm, same, cssVar, findTable, firstOpaqueBg,
    readLink, readQuote, readEm, readRow, injectedCount, removeInjected };
  return 'installed';
})();`;

const INSTALL = '(() => { const w = ' + IF + ';'
  + ' if (!w || !w.document.querySelector(' + JSON.stringify(S) + ')) return { ok: false };'
  + ' if (!w.__r5th) w.eval(' + JSON.stringify(HELPERS) + ');'
  + ' return { ok: !!w.__r5th }; })()';
const IN = expression => '(() => { const w = ' + IF + '; return w.eval(' + JSON.stringify(expression) + '); })()';
const ev = (session, expression) => session.js(IN(expression));
const frameOf = session => session.js(`(() => { const f = document.getElementById('editor');
  const r = f.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()`);

/** 切主题：走真产品模块 themes.js 的 applyTheme（iframe realm 内 import，首跑教训
 *  见 probe-r3-css.cjs 同名函数注）。 */
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

/** 等编辑面的 data-editor-theme 真的翻到目标值（不吞结果：返回 false 时用例必须 FAIL）。 */
async function waitTheme(session, theme, timeout = 6000) {
  const hit = await session.until(`(() => { const w = ${IF}; return !!(w && w.document.documentElement.dataset.editorTheme === ${JSON.stringify(theme)}); })()`,
    { timeout, interval: 80 }).catch(() => false);
  return !!hit;
}

/** 等动态内容链换到期望的 light/dark.css 并解析出规则（稳定渲染，非红绿条件）。 */
async function waitContentTheme(session, name, timeout = 6000) {
  const stop = Date.now() + timeout;
  let last = null;
  while (Date.now() < stop) {
    last = await ev(session, `(() => { const l = document.getElementById('vditorContentTheme');
    if (!l) return { 动态链: false };
    return { 动态链: true, href: l.href, 已加载: !!(l.sheet && l.sheet.cssRules && l.sheet.cssRules.length) }; })()`);
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

/** 切主题 + 等落位 + 等内容链 + 静置（各用例共用的小步）。 */
async function toTheme(session, theme) {
  const switched = await SET_THEME(session, theme);
  const 落位 = await waitTheme(session, theme);
  await sleep(350);
  await waitContentTheme(session, theme.endsWith('dark') ? 'dark' : 'light');
  return { switched, 落位 };
}

// ─── 用例 ─────────────────────────────────────────────────────────────────────
async function caseB4(session, say) {
  const { switched, 落位 } = await toTheme(session, 'telari-light');
  const read = await ev(session, 'window.__r5th.readLink()');
  if (!read || !read.有) { say('R5TH B4链接色 FAIL ' + JSON.stringify({ 切换: switched, 落位, 链接: '没找到 a 元素' })); return; }
  const 注入条数 = await ev(session, 'window.__r5th.injectedCount()');
  const pass = 落位 && read.相等 && 注入条数 === 0;
  say(`R5TH B4链接色 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    切换: switched, 落位, 链接色: read.链接色, primary变量: read.primary变量, 相等: read.相等,
    addThemeCss注入条数: 注入条数, 注入须为零: 注入条数 === 0 }));
  await shots(session, 'B4链接色-telari-light', read.盒, { w: 560, h: 80 });
}

async function caseT1(session, say, theme) {
  const { switched, 落位 } = await toTheme(session, theme);
  const read = await ev(session, 'window.__r5th.readQuote()');
  if (!read || !read.有) { say(`R5TH T1引用对比${theme.endsWith('dark') ? 'dark' : 'light'} FAIL ` + JSON.stringify({ 切换: switched, 落位, 引用: '没找到 blockquote' })); return; }
  const 对底 = typeof read.对引用底 === 'number' ? read.对引用底 : 0;
  const 对纸 = typeof read.对纸面 === 'number' ? read.对纸面 : 0;
  const pass = 落位 && 对底 >= 4.5 && 对纸 >= 4.5;
  say(`R5TH T1引用对比${theme.endsWith('dark') ? 'dark' : 'light'} ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    切换: switched, 落位, 主题: read.主题, 引用字色: read.引用字色, subtle变量: read.subtle变量,
    引用底: read.引用底, 纸面: read.纸面, 对引用底: +对底.toFixed(3), 对纸面: +对纸.toFixed(3),
    阈值: 4.5 }));
  await shots(session, 'T1引用对比-' + theme, read.盒, { w: 560, h: 120 });
}

async function caseT2(session, say) {
  const { switched, 落位 } = await toTheme(session, 'telari-dark');
  const palette = await SET_PALETTE(session, 'beige');
  await sleep(300);
  const odd = await ev(session, 'window.__r5th.readRow("表头甲", 0)');
  const even = await ev(session, 'window.__r5th.readRow("表头甲", 1)');
  const pass = 落位 && !!(odd && even)
    && odd.背景 === BEIGE_BG && even.背景 === BEIGE_CODE && even.背景 !== TELARI_STRIPE_DARK;
  say(`R5TH T2调色盘压斑马 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    切换: switched, 落位, 调色盘: palette, 期望奇数行: BEIGE_BG, 期望偶数行: BEIGE_CODE,
    telari暗条纹: TELARI_STRIPE_DARK, 实测奇数行: odd && odd.背景, 实测偶数行: even && even.背景 }));
  await shots(session, 'T2调色盘压斑马-beige', even && even.盒, { w: 560, h: 90 });
  await SET_PALETTE(session, 'theme');   // 还原，不把调色盘留在会话状态里
}

async function caseT4(session, say) {
  const { switched, 落位 } = await toTheme(session, 'telari-light');
  const telari = await ev(session, 'window.__r5th.readEm()');
  const base = await toTheme(session, 'light');
  const light读 = await ev(session, 'window.__r5th.readEm()');
  const 比值ok = r => !!r && r.有 && typeof r.比值 === 'number' && Math.abs(r.比值 - 1.18) <= 0.011;
  const pass = 落位 && base.落位 && 比值ok(telari) && 比值ok(light读);
  say(`R5TH T4斜体1.18em ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    切换: switched, 落位, base落位: base.落位,
    telari读: telari, light读, 期望比值: 1.18, 容差: 0.011,
    注: 'telari 读数钉 telari.css 的 em 块；light 读数钉 typography.css 的全局 em 基线' }));
  await shots(session, 'T4斜体-telari-light', telari && telari.盒, { w: 560, h: 100 });
}

/** B4 的"修前"红条件实证（放在最后跑：注入 style 是页面内临时变异，必须当场移除干净）。 */
async function caseB4IACVT(session, say) {
  const { switched, 落位 } = await toTheme(session, 'telari-light');
  const result = await ev(session, `(() => {
    const h = window.__r5th; if (!h) return { ok: false, 错: '观测器不在' };
    if (typeof window.addThemeCss !== 'function') return { ok: false, 错: 'window.addThemeCss 不存在' };
    const n0 = h.injectedCount();
    const before = h.readLink();
    window.addThemeCss();
    const n1 = h.injectedCount();
    const during = h.readLink();
    const removed = h.removeInjected();
    const after = h.readLink();
    return { ok: true, 注入前条数: n0, 注入后条数: n1, 修前链接色: during && during.链接色,
      修前主色: during && during.primary变量, 修前偏离主色: during ? !h.same(during.链接色, during.primary变量) : null,
      移除条数: removed, 复原链接色: after && after.链接色, 复原等于主色: after ? h.same(after.链接色, after.primary变量) : null,
      残留条数: h.injectedCount() };
  })()`);
  const pass = 落位 && result && result.ok && result.注入后条数 === result.注入前条数 + 1
    && result.修前偏离主色 === true && result.移除条数 >= 1
    && result.复原等于主色 === true && result.残留条数 === 0;
  say(`R5TH B4修前对照IACVT ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    切换: switched, 落位, result, 注: '注入即修前状态：IACVT 令链接色偏离主色（红条件实证）；移除后复原' }));
}

// ─── 模板校验（--selfcheck：不启动产物，只证明每条页内表达式语法成立） ─────────
function selfcheck() {
  const expressions = [
    'window.__r5th.readLink()', 'window.__r5th.readQuote()', 'window.__r5th.readEm()',
    'window.__r5th.readRow("表头甲", 0)', 'window.__r5th.injectedCount()', INSTALL,
    `(() => {
    const h = window.__r5th; if (!h) return { ok: false, 错: '观测器不在' };
    if (typeof window.addThemeCss !== 'function') return { ok: false, 错: 'window.addThemeCss 不存在' };
    const n0 = h.injectedCount();
    const before = h.readLink();
    window.addThemeCss();
    const n1 = h.injectedCount();
    const during = h.readLink();
    const removed = h.removeInjected();
    const after = h.readLink();
    return { ok: true, n0, n1, removed, 残留: h.injectedCount() };
  })()`,
    `(() => { const l = document.getElementById('vditorContentTheme');
    if (!l) return { 动态链: false };
    return { 动态链: true, href: l.href, 已加载: !!(l.sheet && l.sheet.cssRules && l.sheet.cssRules.length) }; })()`,
  ];
  const substituted = [
    ...expressions.map(e => IN(e)),
    `(async () => { const w = ${IF}; const entry = w.document.querySelector('script[src*="index.js"]');
       const url = new URL('./js/themes.js', entry.src).href; const theme = ${JSON.stringify('telari-light')};
       const src = '(async () => { const m = await import(' + JSON.stringify(url) + ');'
         + ' m.applyTheme(window.vditor, ' + JSON.stringify(theme) + '); })()';
       await w.eval(src); })()`,
    `(async () => { const w = ${IF}; const entry = w.document.querySelector('script[src*="index.js"]');
       const url = new URL('./js/reading-palette.js', entry.src).href; const palette = ${JSON.stringify('beige')};
       const src = '(async () => { const m = await import(' + JSON.stringify(url) + ');'
         + ' m.applyPalette(window.vditor, ' + JSON.stringify(palette) + '); })()';
       await w.eval(src); })()`,
    `(() => { const w = ${IF}; return !!(w && w.document.documentElement.dataset.editorTheme === 'telari-dark'); })()`,
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
  const file = path.join(OUT, 'r5-theme.md');
  fs.writeFileSync(file, DOC, 'utf8');

  const exe = DEV ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
    : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
  const ctx = {
    launch: options => harness.launch({ exe, ...(DEV ? { appArgs: [path.join(harness.project, 'app/main/main.js')] } : {}),
      label: 'probe-r5-theme', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
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

    if (want('b4')) await caseB4(session, say);
    if (want('t1')) {
      await caseT1(session, say, 'telari-light');
      await caseT1(session, say, 'telari-dark');
    }
    if (want('t2')) await caseT2(session, say);
    if (want('t4')) await caseT4(session, say);
    if (want('b4')) await caseB4IACVT(session, say);   // 注入类变异放最后

    if (session.errors && session.errors.length) say('console错误（按错误面规则需人工看一眼）：' + JSON.stringify(session.errors.slice(0, 5)));
    else say('console错误：无');
    const fails = log.filter(line => / FAIL /.test(line)).length;
    say(`R5TH 汇总：${log.filter(line => / PASS | FAIL /.test(line)).length} 用例，FAIL ${fails}`);
  } finally {
    try { await ctx.release(session); } catch { /* 已关 */ }
    fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2));
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
