/* 「导出为 PDF」的**打印层**（主进程侧实现；electron 由调用方注入 —— 便于脱离壳层做基准测量）。
 *
 * ── 架构约束（照着它写，不许打补丁）────────────────────────────────────────
 *  1) **复用文件夹版 HTML**：PDF 的输入是磁盘上那份「导出为文件夹」产物（`xxx.html` + `assets/`，
 *     图片是**相对路径**）。渲染进程不参与打印，不持有 base64，也不持有整篇 HTML 字符串；
 *     打印窗口加载的是本地文件，图片由 Chromium 自己从磁盘异步读。
 *     ⇒ 与 v2.3.3 的崩法相反：那条路是「整篇 HTML + 全部图片 base64 内联进渲染进程」（5–6 份副本）。
 *  2) **独立窗口**：`new BrowserWindow({show:false, webPreferences:{javascript:true}})` + `loadFile`；
 *     等 `did-finish-load` **且 `document.images` 全部 decode 完**（再等两帧）才 `printToPDF`。
 *     不开 offscreen：printToPDF 走的是 Chromium 的打印管线，不需要合成帧。
 *  3) **流式写盘**：`printToPDF` 给的 Buffer 按 WRITE_CHUNK_BYTES 分片写进 `.mp-partial-*`，
 *     写完 rename 成正式文件（半成品可被取消流程删掉，不会留下看起来正常的坏 PDF）。
 *  4) **可取消**：pick/load/images/print/write 每个阶段边界都查一次取消位；取消即销毁窗口、删半成品、
 *     删 staging 目录。
 *  5) **内存闸门**：见 GATE —— staging HTML 超上限直接拒绝打印；断言 HTML 里 `data:` 图片数为 0
 *     （内联=闸门失败，会被记进结果的 gate 字段，供报告与回归核对）。
 *
 * 断言语义：`GATE` 是"架构约束的可执行形式"，不是调参旋钮。改动它等于改架构，必须在报告里写清楚。
 */
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/* ── Knuth–Plass 排版（只作用于**打印这一趟的内存 DOM**）────────────────────────
 *  与 2.x 线同一份实现：打印前把 `Typora-Editor-App/app/renderer/js/knuth-plass.mjs`
 *  打包成 IIFE（`renderer/pdf-typeset.js`，暴露全局 MPKP），在这里注入隐藏窗口后调用。
 *  **不复制源码**：两条线共用一个真源，断行行为改一处两条线一起变（这也是"编辑与导出同源"的一部分）。
 *
 *  三条硬约束：
 *  ① **磁盘 HTML 一个字节都不改**：排版只发生在加载后的内存 DOM 里；
 *     「导出为文件夹」的产物与 PDF 用的那份 HTML 仍然逐字节相同。
 *  ② **必须按纸面宽度量**：隐藏窗口是屏幕布局，而 printToPDF 是打印布局（A4 − 边距）。
 *     所以排版前先把 body 压到纸面正文宽（user origin + !important），否则按屏幕宽度算出的
 *     断行贴到纸上就是错的（2.x 线在正文层显式设 672px，同一个原因）。
 *  ③ **预算闸门与 2.x 同口径**：源 Markdown ≥300KB 或可排块 ≥1800 ⇒ **整体跳过**、回退 CSS
 *     两端对齐（不做部分降级：同一文档里两段式排版肉眼可辨）。实测依据见 2.x 文件头注释。
 *  失败一律降级：typesetArticle 逐块 try/catch + restoreBlock，出错只是"这块不排"。
 */
const KP_SKIP_SOURCE_BYTES = 300 * 1024;
const KP_SKIP_BLOCKS = 1800;
/** 源长度按 **UTF-8 字节**折算：渲染侧送来的是**字符数**，拿字符数直接比字节阈值会让中文文档
 *  宽松约 3 倍（这正是第一次取证时看到的 `sourceBytes: 1029` 对应 2901 B 的那种错位）。
 *  按最坏 3 字节/字符折算 ⇒ 对纯西文偏保守（宁可早一点回退，也不在中文大文档上把内存顶上去）。 */
const KP_BYTES_PER_CHAR = 3;
/** A4 纸面宽度（英寸）：与 GATE.PAGE_SIZE 对应；正文宽 = 纸宽 − 左右边距。 */
const PAPER_WIDTH_IN = { A4: 8.27, A3: 11.69, A5: 5.83, Letter: 8.5, Legal: 8.5, Tabloid: 11 };
let kpCodeCache;
function kpCode() {
  if (kpCodeCache === undefined) {
    try { kpCodeCache = fs.readFileSync(path.join(__dirname, 'renderer', 'pdf-typeset.js'), 'utf8'); }
    catch { kpCodeCache = ''; }
  }
  return kpCodeCache;
}

const GATE = Object.freeze({
  /** staging HTML 上限：超过它一律拒绝打印（说明这条路已经退化成"整篇内联"了） */
  HTML_MAX_BYTES: 64 * 1024 * 1024,
  /** staging HTML 里允许的 `data:` 图片数：**0** = PDF 路径绝不内联图片 */
  INLINE_DATA_URL_MAX: 0,
  /** printToPDF 的 Buffer → 磁盘：分片大小（不拼大字符串、不整篇驻留） */
  WRITE_CHUNK_BYTES: 1024 * 1024,
  /** 扫 HTML / 数 PDF 页数时的读块大小（内存有界） */
  SCAN_CHUNK_BYTES: 64 * 1024,
  /** 等图片 decode 的上限（坏图不挂死流程） */
  IMAGE_WAIT_MS: 20000,
  /** 等 did-finish-load / printToPDF 的上限 */
  LOAD_TIMEOUT_MS: 60000,
  PRINT_TIMEOUT_MS: 180000,
  /** 等渲染侧用「导出为文件夹」流程写出 staging HTML 的上限（大文件也够） */
  HTML_WAIT_MS: 300000,
  /** 单份 PDF 上限（超过说明布局炸了，宁可报错也不写出一个 500MB 的文件） */
  PDF_MAX_BYTES: 512 * 1024 * 1024,
  PAGE_SIZE: 'A4',
  /** 页边距（英寸；Electron 的 printToPDF.margins 单位就是英寸）≈15mm，中文文档的常规边距 */
  MARGINS_IN: Object.freeze({ top: 0.59, bottom: 0.59, left: 0.59, right: 0.59 }),
});

/* 打印期专用样式（只在打印窗口里 insertCSS，**不写进磁盘上的 HTML**：
 *  磁盘产物与「导出为文件夹」逐字节相同，这一点是可核对的）。
 *  包在 @media print 里，语义明确：这份 CSS 只对打印管线生效。
 *
 *  三条硬要求：
 *   · 代码块/公式**不截断**：导出 CSS 给 pre 设了 `overflow:auto`，打印时那等于"裁掉超出部分"，
 *     这里改回 `overflow:visible` + `white-space:pre-wrap`，长行折行而不是消失；
 *   · 表格**不截断**：`max-width:100%` + 单元格任意断词，跨页由 tr 的 break-inside 控制；
 *   · 公式（当前是 TeX 源码）保持可读：等宽、可折行、带底纹，不溢出页面。
 */
const PRINT_CSS = `
@media print {
  html, body { background: #fff !important; }
  body { max-width: none !important; margin: 0 !important; padding: 0 !important; }

  /* ⓪ 【纸面配色·R1】打印层是 **user origin**（insertCSS {cssOrigin:'user'}），普通声明压不过
     磁盘 HTML 的 author 声明 ⇒ 这里每条都必须 !important。暗色主题导出件直接打印＝浅灰字白纸
     （实测：只压了背景、没压文字色），所以把颜色 token 整组压成"白纸黑字"。
     这里的灰阶是**刻意的纸面中性色**（不是主题色）：纸面不该跟着 8 套配色走，否则等于把屏幕配色
     原样吐到纸上（费墨且难读）。主题色仍然全部走 --mp-*，这一层只是打印期的最终覆盖。 */
  :root, html:root {
    --mp-bg: #ffffff !important; --mp-fg: #1a1a1a !important; --mp-heading: #000000 !important;
    --mp-muted: #444444 !important; --mp-faint: #777777 !important; --mp-border: #bbbbbb !important;
    --mp-primary: #0645ad !important; --mp-codeBg: #f4f4f4 !important; --mp-capsule: #f0f0f0 !important;
    --mp-quoteBg: #f7f7f7 !important; --mp-quoteBar: #bbbbbb !important;
    --mp-sel: transparent !important; --mp-sel-tint: transparent !important;
    --mp-kw: #000342 !important; --mp-str: #004e36 !important; --mp-com: #5a5a5a !important;
    --mp-num: #844500 !important; --mp-typ: #001d4b !important;
  }
  body { color: var(--mp-fg) !important; }
  h1, h2, h3, h4, h5, h6 { color: var(--mp-heading) !important; border-bottom-color: var(--mp-border) !important; }
  code, th, thead td { background: var(--mp-capsule) !important; }
  pre { background: var(--mp-codeBg) !important; }
  blockquote { background: var(--mp-quoteBg) !important; border-left-color: var(--mp-quoteBar) !important; color: var(--mp-muted) !important; }
  td, th { border-color: var(--mp-border) !important; }
  hr { border-top-color: var(--mp-border) !important; }
  a { color: var(--mp-primary) !important; text-decoration: none; }

  /* ① 代码块 / 公式块：不裁剪、长行折行（导出 CSS 的 overflow:auto 在打印里=截断） */
  pre { overflow: visible !important; white-space: pre-wrap !important;
        overflow-wrap: anywhere; word-break: break-word; }
  pre.mp-math { font-size: 12.5px !important; line-height: 1.6 !important;
                border-left: 3px solid var(--mp-border); padding: 8px 10px; border-radius: 0;
                break-inside: auto; page-break-inside: auto; }

  /* ② 表格：不超出页宽；行不跨页断开；表头可重复。
     注意 width/tables-layout 两条**必须 !important**：作者的 table{width:100%;table-layout:fixed}
     是 author 声明，会压掉这里的普通声明（改造后新增，实测会静默失效）。 */
  table { max-width: 100% !important; width: auto !important; table-layout: auto !important;
          break-inside: auto; page-break-inside: auto; }
  thead { display: table-header-group !important; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  td, th { overflow-wrap: anywhere; word-break: break-word; }

  /* ③ 图片：不超过页宽，整张不跨页 */
  img { max-width: 100% !important; height: auto !important;
        break-inside: avoid; page-break-inside: avoid; }

  /* ④ 标题不与正文分离（避免页脚孤行标题）；段落孤行控制 */
  h1, h2, h3, h4, h5, h6 { break-after: avoid-page; page-break-after: avoid; }
  p { orphans: 3 !important; widows: 3 !important; }
  blockquote { break-inside: avoid; page-break-inside: avoid; }
}
`;

/** 在文件里数某个字节串出现次数：分块读（内存有界），块间留 needle 长度的重叠防漏计。 */
async function countInFile(file, needle, { chunkBytes = GATE.SCAN_CHUNK_BYTES } = {}) {
  const buf = Buffer.from(needle, 'utf8');
  let count = 0;
  let carry = Buffer.alloc(0);
  const stream = fs.createReadStream(file, { highWaterMark: chunkBytes });
  for await (const chunk of stream) {
    const hay = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let i = hay.indexOf(buf);
    while (i !== -1) { count++; i = hay.indexOf(buf, i + buf.length); }
    carry = hay.subarray(Math.max(0, hay.length - (buf.length - 1)));
  }
  return count;
}

/**
 * 打印前的闸门体检：**流式**扫 staging HTML，数图片形态与结构，不把文件读进内存。
 * @returns {Promise<{ok:boolean, bytes:number, relImages:number, dataImages:number, remoteImages:number,
 *                    tables:number, mathBlocks:number, katexSpans:number, dataUrls:number, gate:object}>}
 */
async function inspectStagedHtml(htmlFile) {
  const st = await fsp.stat(htmlFile);
  const [relImages, dataImages, remoteImages, tables, mathBlocks, dataUrls, katex] = await Promise.all([
    countInFile(htmlFile, 'src="assets/'),
    countInFile(htmlFile, 'src="data:'),
    countInFile(htmlFile, 'src="http'),
    countInFile(htmlFile, '<table'),
    countInFile(htmlFile, 'class="mp-math"'),
    countInFile(htmlFile, 'url(data:'),
    countInFile(htmlFile, 'class="katex'),
  ]);
  const reasons = [];
  if (st.size > GATE.HTML_MAX_BYTES) reasons.push(`HTML ${st.size}B 超过上限 ${GATE.HTML_MAX_BYTES}B`);
  if (st.size === 0) reasons.push('HTML 是空文件');
  // 闸门的**本意**是"我们没把文档里的本地图片内联成 base64"（v2.3.3 的崩法）。
  // 所以只在"一张相对路径的图都没有、却有一堆 data: 图"时判失败；
  // 用户在 markdown 里自己写的少数 data: 图属合法用法，只上报、不拦截。
  if (dataImages > 0) {
    reasons.push(`HTML 里仍有 ${dataImages} 处内联图片未写入导出目录`);
  }
  return {
    ok: reasons.length === 0, bytes: st.size, relImages, dataImages, remoteImages,
    tables, mathBlocks, katexSpans: katex, dataUrls,
    gate: { passed: reasons.length === 0, reasons, inlineDataImages: dataImages, relImages },
  };
}

/** 数 PDF 页数：优先读页树对象的 `/Count`（权威值，与 pdfinfo 一致），拿不到再退化成数 `/Type /Page`。 */
function pdfPageCount(buf) {
  const needle = Buffer.from('/Type', 'latin1');
  let pages = 0, count = 0;
  const win = GATE.SCAN_CHUNK_BYTES;
  for (let off = 0; off < buf.length; off += win) {
    const hay = buf.subarray(off, Math.min(buf.length, off + win + 64));
    let i = hay.indexOf(needle);
    while (i !== -1) {
      const tail = hay.subarray(i, Math.min(hay.length, i + 64)).toString('latin1');
      if (/^\/Type\s*\/Page(?![s])/.test(tail)) pages++;
      else if (/^\/Type\s*\/Pages/.test(tail)) {
        // /Count 可能出现在 /Type /Pages 之后（Skia 写法），也可能在其之前；两种都认
        const m = /\/Count\s+(\d+)/.exec(tail) || /\/Count\s+(\d+)\s*\/Type\s*\/Pages/.exec(hay.subarray(Math.max(0, i - 40), Math.min(hay.length, i + 64)).toString('latin1'));
        if (m) count = Math.max(count, Number(m[1]));
      }
      i = hay.indexOf(needle, i + needle.length);
    }
  }
  return count || pages;
}

/** 等图片就绪（`document.images` 全部 complete + decode()）+ 再等两帧。
 *
 *  【为什么只等**本地**图片】导出 HTML 会原样保留外链图片（`![](https://…)` 是「导出为文件夹」的既定语义）。
 *  没有外网时，这个请求会挂到连接超时——而 `load` 事件要等所有图片，于是"加载本地 HTML"白等 40s
 *  （实测：39.8s，且与打印样式无关）。外链图在离线导出里本来就取不回来，把它算进"就绪"没有意义：
 *  这里只等 `file:`/`data:`/`blob:` 这些**打印真的会画出来**的图，外链图单独计数上报。
 */
async function waitForImages(webContents, { timeoutMs = GATE.IMAGE_WAIT_MS, includeRemote = false } = {}) {
  const started = Date.now();
  const script = `(async () => {
    const all = Array.from(document.images || []);
    const remote = (i) => /^https?:/i.test(i.currentSrc || i.src || '');
    const list = ${includeRemote} ? all : all.filter((i) => !remote(i));
    const wait = (i) => new Promise((r) => {
      if (i.complete) return r();
      i.addEventListener('load', r, { once: true });
      i.addEventListener('error', r, { once: true });
    });
    await Promise.all(list.map(wait));
    // complete 只保证"有结果"，decode 完才算能画：逐个 decode（坏图吞掉异常）
    await Promise.all(list.map((i) => (i.decode ? i.decode().catch(() => {}) : Promise.resolve())));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const nav = performance.getEntriesByType('navigation')[0] || {};
    return {
      total: all.length, local: all.length - all.filter(remote).length, remote: all.filter(remote).length,
      awaited: list.length,
      complete: list.filter((i) => i.complete).length,
      natural: list.filter((i) => i.naturalWidth > 0).length,
      broken: list.filter((i) => i.complete && i.naturalWidth === 0).length,
      remotePending: all.filter((i) => remote(i) && !i.complete).length,
      readyState: document.readyState,
      loadEventEnded: Math.round(nav.loadEventEnd || 0) > 0,
    };
  })()`;
  const race = await Promise.race([
    webContents.executeJavaScript(script, true).then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, error: String((e && e.message) || e) })),
    new Promise((r) => setTimeout(() => r({ ok: false, error: 'timeout' }), timeoutMs)),
  ]);
  return { ms: Date.now() - started, timedOut: !race.ok && race.error === 'timeout', ...(race.r || {}), error: race.ok ? undefined : (race.r ? undefined : race.error) };
}

/** 等文档可排版：**用导航事件**（`dom-ready`）而不是轮询 `executeJavaScript`。
 *
 *  实测踩坑（40s 白等的真因，两轮才定位到）：`loadFile()` 的 promise 等的是 `load` 事件，
 *  而 load 要等**全部子资源**——导出 HTML 里原样保留的外链图片在没有外网时会挂到连接超时，
 *  于是 load 事件 40s 后才来（实测 39.8s，与打印样式、页数都无关）。
 *  改用轮询 `document.readyState` 也不行：导航在飞的时候 `executeJavaScript` 会被**排在导航之后**，
 *  第一次轮询就要等满那 40s（表现为"轮询第一跳就 39.8s"）。`dom-ready`（DOMContentLoaded）才是
 *  "可以排版了"的正确信号——它不等子资源，也不受导航排队影响。
 */
function waitForDomReady(webContents, { timeoutMs = GATE.LOAD_TIMEOUT_MS } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve({ ms: Date.now() - started, ...v }); } };
    const timer = setTimeout(() => finish({ ok: false, timedOut: true }), timeoutMs);
    webContents.once('dom-ready', () => finish({ ok: true, signal: 'dom-ready' }));
    webContents.once('did-fail-load', (_e, code, desc, url) => finish({ ok: false, error: `${desc}(${code}) ${url || ''}` }));
  });
}

/** Buffer → 磁盘：分片写、await drain；先写 .mp-partial-* 再 rename（取消时删得干净）。 */
async function writeBufferStreamed(file, buf, { chunkBytes = GATE.WRITE_CHUNK_BYTES, isCanceled, onProgress } = {}) {
  const t0 = Date.now();
  const tmp = `${file}.mp-partial-${process.pid}`;
  const stream = fs.createWriteStream(tmp);
  await new Promise((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject); });
  let written = 0, chunks = 0;
  try {
    for (let off = 0; off < buf.length; off += chunkBytes) {
      if (isCanceled && isCanceled()) throw Object.assign(new Error('已取消'), { canceled: true });
      const slice = buf.subarray(off, Math.min(buf.length, off + chunkBytes));
      await new Promise((resolve, reject) => stream.write(slice, (e) => (e ? reject(e) : resolve())));
      written += slice.length; chunks++;
      if (onProgress) onProgress({ written, total: buf.length, chunks });
    }
    await new Promise((resolve, reject) => stream.end((e) => (e ? reject(e) : resolve())));
    await fsp.rename(tmp, file);
    return { ok: true, file, bytes: written, chunks, ms: Date.now() - t0 };
  } catch (e) {
    try { stream.destroy(); } catch { /* 已关 */ }
    try { await fsp.unlink(tmp); } catch { /* 没建成就没有 */ }
    throw e;
  }
}

/**
 * 从样式表里摘出 KaTeX 相关规则（全部 `@font-face` + 选择器里含 `.katex` 的规则），
 * 并把字体相对路径改写成绝对 URL。
 *
 * 为什么壳层要自己摘一份：引擎的 `buildMathCss()` 是用 fetch 取 CSS 的，桌面壳是 `file://` 页面，
 * Chromium 禁止 file:// fetch ⇒ 实测返回空串（`mathCssStat()` = `{error:'css-fetch: Failed to fetch'}`），
 * 于是导出 HTML 里只有 `.katex` 标记、没有排版规则，打印出来公式等于"有结构没排版"。
 * 壳层从自己的 `renderer/cm6/app.css` 里摘出这 24KB（含 20 个 @font-face），把 `url("./fonts/…")`
 * 指向应用内字体目录的绝对 file:// URL，打印窗口就能用上真正的数学字体。
 * 引擎侧修好后（file:// 下别用 fetch），这里会自动让位：优先用引擎给的 CSS。
 */
function extractKatexCss(cssText, { fontDir } = {}) {
  const parts = [];
  for (const m of String(cssText).matchAll(/@font-face\s*\{[^}]*\}/g)) parts.push(m[0]);
  for (const m of String(cssText).matchAll(/[^{}@]*\.katex[^{}]*\{[^}]*\}/g)) parts.push(m[0]);
  let css = parts.join('\n');
  if (fontDir) {
    // 字体必须**内联成 data: URL**，不能给 file:// 路径：
    // 打印窗口是 file:// 文档，跨文件字体请求会被 CORS 拒；而 @font-face 的 block 期内文字是**不可见**的，
    // 打印正好落在 block 期 ⇒ 实测整片公式变成空白（页面上只剩标点）。只保留 woff2 一路（Chromium 130 够用）。
    let inlined = 0, missing = 0;
    css = css.replace(/src:[^;}]*/g, (whole, offset) => {
      const m = /url\(["']?([^"')]+\.woff2)["']?\)/.exec(whole);
      if (!m) return whole;
      const file = path.join(fontDir, path.basename(m[1].replace(/[?#].*$/, '')));
      try {
        const buf = fs.readFileSync(file);
        inlined++;
        return `src:url(data:font/woff2;base64,${buf.toString('base64')}) format("woff2")`;
      } catch { missing++; return whole; }
    });
    css = `/* 壳层兜底公式样式：内联 ${inlined} 个 woff2${missing ? `，${missing} 个缺失` : ''} */\n${css}`;
  }
  return css;
}

/**
 * 把磁盘上的本地 HTML 打成 PDF。
 * @param {object} o
 * @param {any} o.BrowserWindow  Electron BrowserWindow（注入，便于测试替身）
 * @param {string} o.htmlFile     已落盘的 HTML（一般是「导出为文件夹」的产物）
 * @param {string} o.outFile      目标 PDF（父目录必须存在）
 * @param {(p:object)=>void} [o.onPhase]  阶段回调：{phase:'load'|'images'|'print'|'write', ...}
 * @param {()=>boolean} [o.isCanceled]
 * @param {object} [o.print]      覆盖 printToPDF 选项（基准里用 pageRanges 切页）
 * @param {string|null} [o.css]   覆盖打印期样式：undefined=用 PRINT_CSS，''/null=不注入（诊断用）
 * @param {boolean} [o.showWindow] 诊断用：把打印窗口显示出来（默认 false，正式路径永远隐藏）
 * @param {string} [o.preloadPath] 打印窗口 preload（默认 renderer/print-preload.js：渲染侧自报图片就绪）
 * @param {any} [o.ipcMain]        Electron ipcMain（接 preload 的 mp:print-ready）
 * @param {string} [o.extraCss]    额外样式（引擎的公式 CSS：KaTeX 类样式只在打印窗口里补上）
 * @param {number} [o.sourceBytes] 源 Markdown 长度：Knuth–Plass 的文档级预算（见文件头 KP 注释）
 * @param {boolean|object} [o.kp]  排版开关：默认按预算自动；`false` 完全不做（诊断/基准用）
 */
async function printLocalHtmlToPdf({ BrowserWindow, ipcMain, htmlFile, outFile, onPhase, isCanceled, print, css, showWindow, preloadPath, extraCss, sourceBytes, kp: kpOpt } = {}) {
  if (typeof BrowserWindow !== 'function') throw new Error('printLocalHtmlToPdf 需要注入 BrowserWindow');
  if (!htmlFile || !outFile) throw new Error('printLocalHtmlToPdf 需要 htmlFile 与 outFile');
  const t0 = Date.now();
  const phases = [];
  const mark = (phase, extra = {}) => {
    // 注意顺序：extra 里也可能有 ms（如 waitForImages 的自计时），必须让**阶段累计 ms 覆盖它**，
    // 否则会出现"负数 delta"这种自欺读法（实测踩过：images 阶段显示 cum=82ms < 上一阶段）。
    const row = { ...extra, phase, ms: Date.now() - t0 };
    phases.push(row);
    if (onPhase) { try { onPhase(row); } catch { /* 进度回调不许影响打印 */ } }
    return row;
  };
  const canceled = () => !!(isCanceled && isCanceled());

  const info = await inspectStagedHtml(htmlFile);
  mark('inspect', { bytes: info.bytes, relImages: info.relImages, dataImages: info.dataImages, tables: info.tables });
  if (!info.gate.passed) {
    const err = new Error(`内存闸门未通过：${info.gate.reasons.join('；')}`);
    err.gate = info.gate;
    throw err;
  }
  if (canceled()) return { ok: false, canceled: true, phases };

  const printPreload = preloadPath || path.join(__dirname, 'renderer', 'print-preload.js');
  const win = new BrowserWindow({
    show: !!showWindow,
    width: 1240, height: 1754,       // 只为布局初始宽度给个 A4 比例的值；分页由 printToPDF 决定
    backgroundColor: '#ffffff',
    title: 'MarkPilot — PDF 打印',
    webPreferences: {
      javascript: true,              // 导出 HTML 是静态产物，但保留 JS 让 Chromium 正常跑完 decode/布局
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      backgroundThrottling: false,   // 隐藏窗口也要正常解码图片、跑完布局
      offscreen: false,              // 明确不用离屏渲染
      images: true,
      plugins: false,
      devTools: false,
      ...(fs.existsSync(printPreload) ? { preload: printPreload } : {}),
    },
  });
  // 渲染侧自报"本地图片就绪"：主进程的 executeJavaScript 会被排在文档 load 之后（外链图能挂住它），
  // 所以这条路径必须由 preload 主动报（见 renderer/print-preload.js 顶部注释）。只认本窗口发来的消息。
  let readyResolve = null;
  const readyPromise = new Promise((resolve) => { readyResolve = resolve; });
  const onReady = (event, payload) => {
    try { if (event.sender !== win.webContents) return; } catch { return; }
    if (readyResolve) { const r = readyResolve; readyResolve = null; r(payload || {}); }
  };
  if (ipcMain) { try { ipcMain.on('mp:print-ready', onReady); } catch { /* 接不上就靠超时兜底 */ } }
  let pdf = null;
  let kp = { applied: 0, lines: 0, skipped: 'not-run' };   // 阶段 3.5 填；catch/finally 也要能引用（别放 try 里）
  try {
    // ── 阶段 1：加载本地 HTML（图片相对路径由 Chromium 从磁盘读，不进任何 JS 内存） ──
    // 只等 `dom-ready`（可排版），**不等 load 事件**：load 会等外链图片，无外网时白等 40s（实测成因）。
    const nav = win.loadFile(htmlFile).then(() => 'load-event').catch((e) => 'load-error:' + String((e && e.message) || e));
    const ready = await waitForDomReady(win.webContents, { timeoutMs: GATE.LOAD_TIMEOUT_MS });
    if (!ready.ok) throw new Error(`加载本地 HTML 失败：${ready.error || 'dom-ready 超时'}`);
    mark('load', { signal: ready.signal, loadMs: ready.ms });
    if (canceled()) return { ok: false, canceled: true, phases };

    // ── 阶段 2：等**本地**图片全部 decode 完（渲染侧 preload 主动上报；外链图不参与，见文件头注释） ──
    const imgs = await Promise.race([
      readyPromise,
      new Promise((r) => setTimeout(() => r({ timedOut: true }), GATE.IMAGE_WAIT_MS)),
    ]);
    mark('images', { ...imgs, ms: undefined, waitMs: undefined });
    if (canceled()) return { ok: false, canceled: true, phases };

    // ── 阶段 3：注入样式（都只在这一趟打印里生效；磁盘 HTML 与文件夹导出逐字节相同） ──
    // 【顺序即语义·2026-10-11 逐页验收实测缺陷】原来先注 extraCss、后注 PRINT_CSS ✗，
    // 而 **后注入的同 origin 规则靠后者赢** ⇒ 看起来顺序是对的 ✓。真凶是 **origin 不同** ✗：
    //   · PRINT_CSS 走 `cssOrigin:'user'` ✓
    //   · 而引擎给的 mathCss 实测是 **369 KB 的整份应用样式表**（`serializeLiveCss()` 抓的是
    //     "含 KaTeX_Main 且含 @font-face 的那张表"，命中的是**应用自己的样式表** ✓，里面
    //     连带 `:root{--mp-bg:#1f2126;…}` 这类**主题 token** ✓）
    //   ⇒ author origin 的它把 user origin 的 PRINT_CSS 压掉 ⇒ **纸上仍是暗色** ✗
    //     （实测：PDF 栅格化后整页近黑、正文几乎不可见 ✗；而导出项文案承诺"暗色主题自动转白纸黑字" ✗）。
    // 修法两条一起上：
    //   ① **顺序反过来**：先注 mathCss、**再注 PRINT_CSS** ⇒ 同 origin 下后者赢 ✓；
    //   ② 给 PRINT_CSS 的对象选择器加 `html` 前缀抬特异性（`html:root`），对 author 声明更稳 ✓。
    if (extraCss) { try { await win.webContents.insertCSS(String(extraCss), { cssOrigin: 'user' }); } catch { /* 注入失败仍继续打印 */ } }
    // ② 打印期样式（分页/不截断/公式可读/纸面配色）—— **最后注** ⇒ 同 origin 下它赢 ✓
    const cssText = css === undefined ? PRINT_CSS : css;
    if (cssText) { try { await win.webContents.insertCSS(cssText, { cssOrigin: 'user' }); } catch { /* 注入失败不该阻断打印 */ } }
    mark('style', { mathCssBytes: extraCss ? String(extraCss).length : 0 });

    // ── 阶段 3.5：Knuth–Plass 整段最优断行（只改**这一趟打印的内存 DOM**；磁盘 HTML 不动） ──
    //  预算与 2.x 线同口径：源 ≥300KB 或可排块 ≥1800 ⇒ 整体跳过，回退 CSS 两端对齐（不给部分降级）。
    kp = { applied: 0, lines: 0, skipped: 'disabled' };   // 外层的 kp：这里只赋值，不重新声明（catch 也要引用）
    if (kpOpt !== false) {      const code = kpCode();
      if (!code) { kp = { applied: 0, lines: 0, error: '排版代码缺失（renderer/pdf-typeset.js 未打包）' }; mark('typeset', kp); }
      else {
        try {
          const wc = win.webContents;
          const blocks = await wc.executeJavaScript('document.querySelectorAll("p, li, blockquote p").length', true);
          const srcChars = Number(sourceBytes) || 0;                 // 渲染侧给的是**字符数**
          const srcBytesApprox = srcChars * KP_BYTES_PER_CHAR;       // 折算成 UTF-8 字节上界
          if (srcBytesApprox >= KP_SKIP_SOURCE_BYTES || blocks >= KP_SKIP_BLOCKS) {
            kp = { applied: 0, lines: 0, blocks, budgetSkipped: true, sourceBytes: srcBytesApprox, sourceChars: srcChars };
            mark('typeset', { skipped: 'budget', blocks, sourceChars: srcChars, sourceBytesApprox: srcBytesApprox });
          } else {
            // 纸面宽度：A4 8.27in − 左右边距 0.59×2 ⇒ ≈680.6 CSS px。**只压屏幕媒体**：
            // 打印媒体那份宽度由页面边距决定，不该被这里覆盖（也会与 PRINT_CSS 打架）。
            const paperW = PAPER_WIDTH_IN[String(GATE.PAGE_SIZE)] || PAPER_WIDTH_IN.A4;
            const contentPx = Math.round((paperW - GATE.MARGINS_IN.left - GATE.MARGINS_IN.right) * 96 * 100) / 100;
            await wc.insertCSS(`@media screen { body { width: ${contentPx}px !important; max-width: none !important; margin: 0 !important; padding: 0 !important; } }`, { cssOrigin: 'user' });
            await wc.executeJavaScript(code, true);
            const st = await wc.executeJavaScript(
              `(() => { try { const s = window.MPKP.typesetArticle(document.body, 'p, li, blockquote p'); return { applied: s.applied, lines: s.lines, fallback: s.fallback }; } catch (e) { return { applied: 0, lines: 0, error: String((e && e.message) || e) }; } })()`,
              true);
            kp = { ...st, blocks, width: contentPx, sourceBytes: srcBytesApprox, sourceChars: srcChars };
            mark('typeset', { applied: kp.applied, lines: kp.lines, blocks, width: contentPx, fallback: kp.fallback || null });
          }
        } catch (e) {
          kp = { applied: 0, lines: 0, error: String((e && e.message) || e) };
          mark('typeset', { error: kp.error });
        }
      }
      if (canceled()) return { ok: false, canceled: true, phases, kp };
      /* 诊断取证：`MP_PDF_SHOT=<png 路径>` ⇒ **排版完成后、打印前**把这一趟的版面存一张图。
         为什么不从外面用 CDP 截：打印窗口生命周期只有几百毫秒（load→print），外部轮询抓不稳
         （实测抓空）；在这里截，图上就是即将被打印的那一版——KP 的断行与伸缩都在。
         与 MP_PDF_SHOW 的分工：SHOW 让窗口显形（人眼可看），SHOT 留图（报告可引用）。 */
      if (process.env.MP_PDF_SHOT) {
        try {
          const img = await win.webContents.capturePage();
          const buf = img.toPNG();
          await fsp.writeFile(process.env.MP_PDF_SHOT, buf);
          /* 同时把"这一趟到底在多宽的盒子里排版"量出来：截图只能看个大概，
             宽度口径错了（比如注入的纸面宽度被作者层容器吃掉）纸面上就是"行太短"的错版。 */
          const probe = await win.webContents.executeJavaScript(
            `(() => { const b = document.body; const p = document.querySelector('p'); const cs = getComputedStyle(b);
               return { dpr: devicePixelRatio, winW: innerWidth, bodyW: Math.round(b.getBoundingClientRect().width),
                 bodyMaxW: cs.maxWidth, bodyPad: cs.paddingLeft + '/' + cs.paddingRight,
                 pW: p ? Math.round(p.getBoundingClientRect().width) : null,
                 pClientW: p ? p.clientWidth : null }; })()`, true);
          mark('shot', { file: process.env.MP_PDF_SHOT, bytes: buf.length, probe });
          kp = { ...kp, measure: probe };
        } catch (e) { mark('shot', { error: String((e && e.message) || e) }); }
      }
    }

    // ── 阶段 4：printToPDF（Chromium 打印管线；printBackground 保住代码块底纹与表格边框） ──
    const printOpts = {
      landscape: false,
      displayHeaderFooter: false,
      printBackground: true,
      scale: 1,
      pageSize: GATE.PAGE_SIZE,
      margins: { ...GATE.MARGINS_IN },
      preferCSSPageSize: false,
      generateTaggedPDF: false,
      generateDocumentOutline: true,   // h1..h6 → PDF 书签（Chromium 从标题生成大纲）
      ...(print || {}),
    };
    const printRace = await Promise.race([
      win.webContents.printToPDF(printOpts).then((b) => ({ ok: true, buf: b })).catch((e) => ({ ok: false, error: String(e && e.message || e) })),
      new Promise((r) => setTimeout(() => r({ ok: false, error: 'print-timeout' }), GATE.PRINT_TIMEOUT_MS)),
    ]);
    if (!printRace.ok) throw new Error(`printToPDF 失败：${printRace.error}`);
    pdf = printRace.buf;
    if (!pdf || !pdf.length) throw new Error('printToPDF 返回空 Buffer');
    if (pdf.length > GATE.PDF_MAX_BYTES) throw new Error(`PDF ${pdf.length}B 超过上限 ${GATE.PDF_MAX_BYTES}B`);
    mark('print', { bytes: pdf.length, pages: pdfPageCount(pdf) });
    if (canceled()) return { ok: false, canceled: true, phases };

    // ── 阶段 5：分片写盘（临时文件 + rename） ──
    const w = await writeBufferStreamed(outFile, pdf, {
      isCanceled: canceled,
      onProgress: (p) => mark('write', { done: p.written, bytes: p.written, chunks: p.chunks, total: undefined }),
    });
    mark('write-done', { bytes: w.bytes, chunks: w.chunks, writeMs: w.ms });
    const navOutcome = await Promise.race([nav, new Promise((r) => setTimeout(() => r('pending'), 50))]);
    return {
      ok: true, file: outFile, bytes: w.bytes, chunks: w.chunks,
      pages: pdfPageCount(pdf), ms: Date.now() - t0, phases, gate: info.gate, html: info,
      kp,                              // Knuth–Plass 排版统计（见阶段 3.5）
      loadEvent: navOutcome,           // 'load-event' / 'load-error:…' / 'pending'（外链图没回来时就是 pending）
    };
  } catch (e) {
    if (e && e.canceled) return { ok: false, canceled: true, phases, kp };
    throw e;
  } finally {
    if (ipcMain) { try { ipcMain.removeListener('mp:print-ready', onReady); } catch { /* 已经没人听 */ } }
    pdf = null;                                   // 立刻放开 Buffer（GC 可回收）
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* 已销毁 */ }
  }
}

/**
 * 内存闸门的**测量器**：用 Electron 自己的 `app.getAppMetrics()` 采整棵应用进程树的 RSS
 * （workingSetSize 单位 KB）。为什么不用外部 WMI/CIM 采样：CIM 单次查询要吃 ~0.5s CPU，
 * 采样本身就污染被测对象（实测：150ms 间隔的 CIM 采样把一次导出拖成 104s）。
 * @param {any} app Electron app
 * @returns {{start:()=>void, stop:()=>({peakMB:number,lastMB:number,samples:number,perProc:any[],seriesMB:number[]})}}
 */
function memorySampler(app, { intervalMs = 200 } = {}) {
  const perProc = new Map();
  const series = [];
  let peak = 0, timer = null;
  const tick = () => {
    let sumKB = 0;
    for (const m of app.getAppMetrics()) {
      const kb = (m.memory && m.memory.workingSetSize) || 0;
      sumKB += kb;
      const key = `${m.type}#${m.pid}`;
      const prev = perProc.get(key) || { type: m.type, pid: m.pid, peakKB: 0 };
      if (kb > prev.peakKB) prev.peakKB = kb;
      perProc.set(key, prev);
    }
    peak = Math.max(peak, sumKB);
    series.push(Math.round(sumKB / 1024));
    return sumKB;
  };
  return {
    start() { tick(); if (!timer) timer = setInterval(tick, intervalMs); },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      const lastKB = tick();
      return {
        peakMB: +(peak / 1024).toFixed(1), lastMB: +(lastKB / 1024).toFixed(1),
        samples: series.length, intervalMs,
        perProc: [...perProc.values()].map((p) => ({ type: p.type, pid: p.pid, peakMB: +(p.peakKB / 1024).toFixed(1) })).sort((a, b) => b.peakMB - a.peakMB),
        seriesMB: series,
      };
    },
  };
}

module.exports = {
  GATE, PRINT_CSS, countInFile, inspectStagedHtml, pdfPageCount, extractKatexCss,
  waitForImages, waitForDomReady, writeBufferStreamed, printLocalHtmlToPdf, memorySampler,
};
