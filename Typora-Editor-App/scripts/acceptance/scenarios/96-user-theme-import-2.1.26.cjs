/** 2.1.26：自定义主题（导入 Typora 社区主题）。
 *
 *  用户令：开这条能力，但要注意"全量测试、避免特殊 CSS 导致的问题"，并**拿第三方最多下载量的
 *  7 个 Typora 主题去测**。官方画廊没有公开下载计数，可比的公开指标是 GitHub star；素材由
 *  `scripts/fetch-typora-themes.cjs` 抓到 `.perf/typora-themes/`（第三方作品，不入产物）。
 *  取到 7 套：drake(★3544) / vue(★977) / lapis(★566) / mdmdt(★566) / cobalt(★399) /
 *  gitbook(★315) / notion(★300)。另有两套（LaTeX ★5960、Ursine ★739）的 CSS 只随 release
 *  发布，本机到 release-assets 的连接被重置，清单里如实记为"未取到"。
 *
 *  判据一律是"用户看得见 / 可验证"的东西，不看产品自报：
 *   · 真 DOM：写作区里 h1/p/code/td 的 **computedStyle** 在启用前后必须真的变了，停用后必须
 *     **逐字段回到基线**（同一个字符串比较），并且注入了样式表、摘掉了作用域属性；
 *   · 真输入：主题开着的时候还能打字（源码真的变），打字前光标有真实矩形（字号/行高被主题改了也不掉光标）；
 *   · 独立通道：**磁盘无关**——但用 `window.__typoraUserTheme` 的统计与 localStorage 的持久化做交叉验证，
 *     并在停用后断言样式表元素与属性都没了（DOM 层的"痕迹为零"）；
 *   · 每一套主题之后单独检查 **本次会话没有新增 console 错误**（相对字体/图片 404 会在这里现形）。
 *
 *  素材缺失时场景直接失败并给出抓取命令（不假装测过）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '96-user-theme-import-2.1.26',
  title: '自定义主题：导入 7 个最流行的 Typora 主题 + 恶劣 CSS 不炸',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '96-round');
    fs.mkdirSync(dir, {recursive: true});
    const IF = `document.getElementById('editor').contentWindow`;

    const room = path.join(harness.project, '.perf/typora-themes');
    if (!fs.existsSync(path.join(room, 'manifest.json'))) {
      ctx.assert('第三方主题素材已就位（node scripts/fetch-typora-themes.cjs）', false, room);
      return;
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(room, 'manifest.json'), 'utf8'));
    const themes = manifest.themes.filter(theme => theme.css && theme.css.length);
    ctx.witness('测试用的第三方主题（star 数作为下载量代理）', themes.map(theme => ({key: theme.key, stars: theme.stars, license: theme.license, files: theme.css.length})));
    ctx.assert('至少取到 7 套第三方主题', themes.length >= 7, `实到 ${themes.length}：${themes.map(t => t.key).join(', ')}`);

    const doc = path.join(dir, '主题验收.md');
    fs.writeFileSync(doc, [
      '# 一级标题验收', '',
      '正文一段：包含**加粗**、`行内代码` 与行内公式 $a^2+b^2=c^2$，用来观察主题对正文的作用。', '',
      '```js', 'const answer = 42;', '```', '',
      '| 名称 | 数值 |', '| --- | --- |', '| 甲 | 1 |', '| 乙 | 2 |', '',
      '末尾段落：收尾。', '',
    ].join('\n'));

    /** 探针：写作区里几个代表性元素的"用户看得见"的计算样式。 */
    const PROBES = `(() => { const w = ${IF}, d = w.document;
      const root = d.querySelector('.vditor-ir .vditor-reset');
      if (!root) return null;
      const pick = (sel, props) => { const node = root.querySelector(sel); if (!node) return null;
        const cs = w.getComputedStyle(node); const out = {};
        for (const prop of props) out[prop] = cs.getPropertyValue(prop);
        return out; };
      const FONT = ['font-family', 'font-size', 'line-height', 'color', 'background-color'];
      const TEXT = ['color', 'background-color', 'font-weight', 'border-bottom-width', 'text-align', 'padding-left'];
      return {
        surface: pick('.vditor-ir .vditor-reset', ['font-family', 'font-size', 'line-height', 'color', 'background-color', 'max-width', 'width', 'padding-left']),
        h1: pick('h1', TEXT.concat(FONT)),
        p: pick('p', TEXT),
        strong: pick('strong', TEXT),
        code: pick('code', ['color', 'background-color', 'font-family', 'padding-left']),
        td: pick('td,th', TEXT),
        styleElement: !!d.getElementById('typora-user-theme'),
        scopeAttr: d.documentElement.dataset.userTheme || null,
        userTheme: w.__typoraUserTheme ? {id: w.__typoraUserTheme.id, name: w.__typoraUserTheme.name, cssBytes: w.__typoraUserTheme.cssBytes,
          rules: w.__typoraUserTheme.report.rules, mediaKept: w.__typoraUserTheme.report.mediaKept,
          droppedSelectors: w.__typoraUserTheme.report.droppedSelectors, fontFacesDropped: w.__typoraUserTheme.report.fontFacesDropped,
          urlsNeutralized: w.__typoraUserTheme.report.urlsNeutralized, missing: w.__typoraUserTheme.missing} : null,
        stored: (() => { try { return JSON.parse(localStorage.getItem('typora-user-themes') || '[]').map(item => item.name); } catch { return null; } })(),
        activeStored: localStorage.getItem('typora-user-theme-active'),
        caret: (() => { const s = w.getSelection(); if (!s || !s.rangeCount) return null; const r = s.getRangeAt(0);
          const box = (() => { const q = d.createRange(); q.setStart(r.startContainer, r.startOffset); q.setEnd(r.startContainer, r.startOffset); return q.getBoundingClientRect(); })();
          const el = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
          return {collapsed: r.collapsed, height: Math.round(box.height), inSurface: !!(el && root.contains(el))}; })()
      }; })()`;

    /** 打开/关闭主题对话框（真点击工具栏按钮）。 */
    const openDialog = async page => {
      const at = await page.js(`(() => { const w = ${IF}, fr = document.getElementById('editor').getBoundingClientRect();
        const btn = w.document.querySelector('.vditor-toolbar__item button[data-type="theme-settings"]');
        if (!btn) return null; const r = btn.getBoundingClientRect();
        return {x: Math.round(fr.x + r.left + r.width / 2), y: Math.round(fr.y + r.top + r.height / 2)}; })()`);
      if (!at) return false;
      await page.click(at.x, at.y);
      await sleep(500);
      return await page.until(`(() => ${IF}.document.getElementById('typora-themes') !== null)()`, {timeout: 6000, interval: 50});
    };
    /** 关闭主题对话框：**Escape 为主**（模态 <dialog> 的规范行为，不依赖坐标——主题一多，
     *  对话框会长/滚动，按坐标点"关闭"按钮会打到别处，这一条踩过一次：那之后所有编辑交互都打在
     *  模态框上，被误读成"主题开着就打不了字"）。关掉之后必须自证"框真的没了"。 */
    const dialogOpen = page => page.js(`(() => ${IF}.document.getElementById('typora-themes') !== null)()`);
    const closeDialog = async page => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!await dialogOpen(page)) return true;
        await page.key({key: 'Escape', code: 'Escape', vk: 27});
        await sleep(350);
        if (!await dialogOpen(page)) return true;
        const at = await page.js(`(() => { const w = ${IF}, d = w.document, fr = document.getElementById('editor').getBoundingClientRect();
          const dialog = d.getElementById('typora-themes'); if (!dialog) return null;
          const btn = dialog.querySelector('footer button'); if (!btn) return null;
          btn.scrollIntoView({block: 'nearest'});
          const r = btn.getBoundingClientRect();
          return {x: Math.round(fr.x + r.left + r.width / 2), y: Math.round(fr.y + r.top + r.height / 2)}; })()`);
        if (at) { await page.click(at.x, at.y); await sleep(400); }
      }
      return !await dialogOpen(page);
    };
    /** 通过产品自己的文件选择路径导入（页面里造 File + input.files + change 事件）。 */
    const importAsFiles = async (page, name, files) => page.jsSoft(`(() => { const w = ${IF}, d = w.document;
      const input = d.querySelector('#typora-theme-files');
      if (!input) return {ok: false, error: '对话框里没有文件输入框'};
      const dt = new DataTransfer();
      for (const file of ${JSON.stringify(files)}) dt.items.add(new File([file.text], file.name, {type: 'text/css'}));
      input.files = dt.files;
      d.querySelector('#typora-theme-name').value = ${JSON.stringify(name)};
      input.dispatchEvent(new Event('change', {bubbles: true}));
      return {ok: true, count: dt.files.length}; })()`);

    const session = await ctx.launch({args: [doc]});
    try {
      await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset h1')); })()`, {timeout: 90000, interval: 60});
      await sleep(2200);
      await session.send('Page.bringToFront');
      const base = await session.js(PROBES);
      ctx.witness('启用任何自定义主题之前的基线（计算样式）', {h1: base.h1, p: base.p, code: base.code, surface: base.surface, styleElement: base.styleElement, scopeAttr: base.scopeAttr});
      ctx.assert('起点是干净的：没有注入样式表、没有作用域属性', base.styleElement === false && base.scopeAttr === null, {styleElement: base.styleElement, scopeAttr: base.scopeAttr});
      const baseJson = JSON.stringify({surface: base.surface, h1: base.h1, p: base.p, code: base.code, td: base.td});

      const sensitivity = {};
      const seenProbes = new Set();
      let round = 0;
      for (const theme of themes) {
        round++;
        const errorsBefore = session.errors.length;
        const files = theme.css.map(rel => ({name: path.basename(rel), path: rel, text: fs.readFileSync(path.join(room, rel), 'utf8')}));
        if (!await openDialog(session)) { ctx.assert(`[${theme.key}] 打开主题对话框`, false, null); break; }
        const imported = await importAsFiles(session, theme.key, files);
        await sleep(900);
        const on = await session.js(PROBES);
        ctx.witness(`[${theme.key}] 启用后的统计（产品自报，用右边的计算样式交叉验证）`, on.userTheme);
        ctx.assert(`[${theme.key}] 导入生效：注入样式表 + 挂上作用域属性 + 进了主题列表`,
          on.styleElement === true && on.scopeAttr === 'on' && Array.isArray(on.stored) && on.stored.includes(theme.key),
          {imported, styleElement: on.styleElement, scopeAttr: on.scopeAttr, stored: on.stored});
        ctx.assert(`[${theme.key}] 产出的规则量合理（≥8 条）`, (on.userTheme?.rules ?? 0) >= 8, on.userTheme);
        // 用户看得见：写作区里的样式真的变了
        const changed = ['surface', 'h1', 'p', 'strong', 'code', 'td'].filter(probe =>
          JSON.stringify(on[probe]) !== JSON.stringify(base[probe]));
        ctx.witness(`[${theme.key}] 启用后与基线不同的探针`, changed);
        sensitivity[theme.key] = changed;
        for (const probe of changed) seenProbes.add(probe);
        ctx.assert(`[${theme.key}] 计算样式真的变了（主题确实落到写作区上了）`, changed.length >= 1, {changed, h1: on.h1, baseH1: base.h1});
        ctx.assert(`[${theme.key}] 本次导入没有新增 console 错误（相对字体/图片没被带去 404）`,
          session.errors.length === errorsBefore, session.errors.slice(errorsBefore, errorsBefore + 3));
        // 主题开着也能正常编辑：光标有真实矩形，打字进得去
        const closed = await closeDialog(session);
        ctx.assert(`[${theme.key}] 导入后能关掉对话框（关掉才有资格谈"主题开着还能编辑"）`, closed === true, {closed});
        // 真实点击：光标必须落在写作区里（主题改了行高/宽度也不许点到别处）
        const spot = await session.js(`(() => { const w = ${IF}, d = w.document, fr = document.getElementById('editor').getBoundingClientRect();
          const node = [...d.querySelectorAll('.vditor-ir .vditor-reset p')].find(p => String(p.textContent).includes('末尾段落'));
          if (!node) return null;
          const box = d.createRange(); box.selectNodeContents(node);
          const r = box.getBoundingClientRect();
          return {x: Math.round(fr.x + r.left + 4), y: Math.round(fr.y + r.top + r.height / 2)}; })()`);
        let caret = null, under = null;
        if (spot) {
          await session.click(spot.x, spot.y);
          await sleep(400);
          caret = (await session.js(PROBES)).caret;
          under = await session.js(`(() => { const w = ${IF}, d = w.document, fr = document.getElementById('editor').getBoundingClientRect();
            const el = d.elementFromPoint(${spot.x} - Math.round(fr.left), ${spot.y} - Math.round(fr.top));
            return el ? {tag: el.tagName, cls: String(el.className || '').slice(0, 24), inSurface: !!el.closest('.vditor-ir .vditor-reset')} : null; })()`);
        }
        ctx.witness(`[${theme.key}] 真实点击的落点与命中的元素`, {spot, under, caret});
        ctx.assert(`[${theme.key}] 真实点击之后光标落在写作区里（几何自查 + 命中元素，不是产品自报）`,
          !!caret && caret.inSurface === true && caret.height > 4 && !!under && under.inSurface === true, {spot, under, caret});
        // 打字：程序化把光标放到目标段落（主题会改版面，坐标不再稳），插入是真实输入。
        // 落点本身要自证成功——落点失败是**判据**问题，不能算成"产品打不了字"。
        const placed = await session.js(`(() => { const w = ${IF}, d = w.document;
          const node = [...d.querySelectorAll('.vditor-ir .vditor-reset p')].find(p => String(p.textContent).includes('末尾段落'));
          if (!node) return {ok: false, why: '找不到目标段落'};
          const walker = d.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
            acceptNode: text => (text.data.trim().length && !text.parentElement.closest('.vditor-ir__preview'))
              ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
          let text = null, last = null;
          while ((text = walker.nextNode())) last = text;
          if (!last) return {ok: false, why: '目标段落里没有可编辑文字'};
          const r = d.createRange(); r.setStart(last, last.data.length); r.collapse(true);
          const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r); w.focus();
          return {ok: true, data: last.data.slice(-6)}; })()`);
        await sleep(250);
        caret = (await session.js(PROBES)).caret;
        ctx.witness(`[${theme.key}] 打字前的落点自查`, {placed, caret});
        ctx.assert(`[${theme.key}] 打字前的落点自证成功（否则这一条的失败要算在判据头上，不算产品的）`,
          placed?.ok === true && !!caret && caret.inSurface === true, {placed, caret});
        const before = await session.js(`(() => String(${IF}.vditor.getValue()))()`);
        await session.type('Ы');
        await sleep(600);
        const after = await session.js(`(() => String(${IF}.vditor.getValue()))()`);
        ctx.witness(`[${theme.key}] 主题开着时的光标与输入`, {caret, changed: after !== before});
        ctx.assert(`[${theme.key}] 主题开着仍能编辑：光标有真实矩形且打字进了文档`,
          !!caret && caret.height > 4 && caret.inSurface && after !== before, {caret, changed: after !== before});
        await session.chord('z', 'KeyZ', 90);
        await sleep(600);
        // 停用 → 必须逐字段回到基线，且不留痕
        if (!await openDialog(session)) { ctx.assert(`[${theme.key}] 重新打开对话框以停用`, false, null); break; }
        const stopAt = await session.js(`(() => { const w = ${IF}, d = w.document, fr = document.getElementById('editor').getBoundingClientRect();
          const item = d.querySelector('#typora-themes .user-theme-list li[data-active=true]');
          if (!item) return null; item.scrollIntoView({block: 'nearest'});
          const btn = item.querySelector('[data-action=toggle]'); const r = btn.getBoundingClientRect();
          return {x: Math.round(fr.x + r.left + r.width / 2), y: Math.round(fr.y + r.top + r.height / 2), label: btn.textContent}; })()`);
        ctx.witness(`[${theme.key}] 停用按钮`, stopAt);
        if (stopAt) { await session.click(stopAt.x, stopAt.y); await sleep(700); }
        await closeDialog(session);
        const off = await session.js(PROBES);
        ctx.witness(`[${theme.key}] 停用之后（应当与基线逐字段相同）`, {h1: off.h1, surface: off.surface, styleElement: off.styleElement, scopeAttr: off.scopeAttr});
        ctx.assert(`[${theme.key}] 停用后写作区逐字段回到基线（含 h1/p/code/td/surface）`,
          JSON.stringify({surface: off.surface, h1: off.h1, p: off.p, code: off.code, td: off.td}) === baseJson,
          {now: {h1: off.h1, p: off.p}, base: {h1: base.h1, p: base.p}});
        ctx.assert(`[${theme.key}] 停用后不留痕迹（样式表移除、作用域属性摘掉、没有"当前主题"标记）`,
          off.styleElement === false && off.scopeAttr === null && (off.activeStored === null || off.activeStored === ''), {styleElement: off.styleElement, scopeAttr: off.scopeAttr, activeStored: off.activeStored});
      }

      ctx.witness('七套主题各自改变了哪些探针', sensitivity);
      ctx.assert('探针集合整体对真实主题敏感（h1/p/code/td/surface 至少四个探针在七套里被改到过）',
        seenProbes.size >= 4, {seen: [...seenProbes]});

      /* ── 恶劣 CSS：用户点名的"避免特殊 CSS 导致的问题" ───────────────────────
       *
       *  分两段测，因为两类"脏"要的判据不一样：
       *   ① 能解析但写法古怪：相对字体/图片、找不到的 @import、嵌套 @media、`:has`、
       *      `!important`、未知 at-rule、`@keyframes`+animation、`::after` 内容 —— 这些**必须**照常生效
       *      （否则"特殊 CSS"就成了"随便哪条都能把主题搞哑"）。
       *   ② 语法本身就是坏的（少花括号、乱码）：**不许**让导入流程炸掉、不许污染控制台、
       *      不许把编辑器弄到不能打字；能留下几条算几条。
       */
      const nastyOk = [
        '@font-face { font-family: Ghost; src: url(./ghost.woff2); }',
        '#write { background-image: url(../img/bg.png); }',
        '@import "does/not/exist.css";',
        '@media (max-width: 100px) { #write p { color: red; } @media screen { #write code { color: blue; } } }',
        '#write * { box-sizing: border-box; }',
        '#write:has(> table) { outline: 1px solid rgb(1, 2, 3); }',
        '#write h1 { color: rgb(1, 2, 3) !important; }',
        '@unknown-at-rule { #write p { color: pink; } }',
        '#write p::after { content: "»"; }',
        '@keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }',
        '#write strong { animation: spin 2s linear infinite; }',
      ].join('\n');
      const pasteCss = async (name, css) => {
        if (!await openDialog(session)) return null;
        const pasted = await session.jsSoft(`(() => { const w = ${IF}, d = w.document;
          const area = d.querySelector('#typora-theme-paste');
          if (!area) return {ok: false, error: '没有粘贴框'};
          d.querySelector('#typora-theme-name').value = ${JSON.stringify(name)};
          area.value = ${JSON.stringify(css)};
          d.querySelector('#typora-themes [data-action=paste]').scrollIntoView({block: 'nearest'});
          d.querySelector('#typora-themes [data-action=paste]').click();
          return {ok: true}; })()`);
        await sleep(900);
        return pasted;
      };
      const errorsBefore = session.errors.length;
      const pasted = await pasteCss('古怪但合法', nastyOk);
      const afterNasty = await session.js(PROBES);
      ctx.witness('古怪但合法的 CSS 导入后的统计', {pasted, userTheme: afterNasty.userTheme});
      ctx.assert('古怪但合法：导入流程本身不炸、产出的规则量合理（≥3 条）',
        !!pasted?.ok && afterNasty.styleElement === true && (afterNasty.userTheme?.rules ?? 0) >= 3, afterNasty.userTheme);
      ctx.assert('古怪但合法：相对字体/图片被挡住（字体块计数 > 0，且 url 被中和过）',
        (afterNasty.userTheme?.fontFacesDropped ?? 0) >= 1 && (afterNasty.userTheme?.urlsNeutralized ?? 0) >= 1,
        {font: afterNasty.userTheme?.fontFacesDropped, urls: afterNasty.userTheme?.urlsNeutralized});
      ctx.assert('古怪但合法：找不到的 @import 被如实记下来（不是静默吞掉）',
        (afterNasty.userTheme?.missing ?? []).length >= 1, afterNasty.userTheme?.missing);
      ctx.assert('古怪但合法：`!important` 这类规则照常生效（说明改写没被古怪写法带坏）',
        afterNasty.h1?.color === 'rgb(1, 2, 3)', afterNasty.h1);
      ctx.assert('古怪但合法：本次导入没有新增 console 错误（缺失资源/解析报错都算）',
        session.errors.length === errorsBefore, session.errors.slice(errorsBefore, errorsBefore + 4));
      await closeDialog(session);

      // ② 语法坏掉的 CSS：能留下几条算几条，但不许炸、不许污染控制台、不许把编辑器弄哑
      const errorsBeforeBroken = session.errors.length;
      const broken = ['/* 少一个右花括号 */ #write h1 { color: rgb(9, 8, 7);', '::::: 这不是 CSS ;;;;', '}', '#write p { color: rgb(2, 3, 4)', '@media { #write p { color: blue; }'].join('\n');
      const pastedBroken = await pasteCss('语法坏掉', broken);
      await sleep(300);
      const afterBroken = await session.js(PROBES);
      ctx.witness('语法坏掉的 CSS 导入后的统计', {pasted: pastedBroken, userTheme: afterBroken.userTheme});
      ctx.assert('语法坏掉：导入仍然成功（有统计、有样式表），没有把对话框或流程炸掉',
        !!pastedBroken?.ok && afterBroken.styleElement === true, {pasted: pastedBroken, userTheme: afterBroken.userTheme});
      ctx.assert('语法坏掉：没有新增 console 错误', session.errors.length === errorsBeforeBroken, session.errors.slice(errorsBeforeBroken, errorsBeforeBroken + 4));
      // 坏 CSS 之后编辑健康度：打字、退格、光标都还正常（光标程序化落到目标段落：
      // 主题会把版面改得面目全非，坐标点击在这时候不再可靠，而这里要测的是"编辑还能不能用"）
      await closeDialog(session);
      const before2 = await session.js(`(() => { const w = ${IF}, d = w.document;
        const node = [...d.querySelectorAll('.vditor-ir .vditor-reset p')].find(p => String(p.textContent).includes('末尾段落'));
        if (!node) return null;
        const walker = d.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
          acceptNode: text => (text.data.trim().length && !text.parentElement.closest('.vditor-ir__preview'))
            ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
        let text = null, last = null;
        while ((text = walker.nextNode())) last = text;
        if (!last) return null;
        const r = d.createRange(); r.setStart(last, last.data.length); r.collapse(true);
        const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r); w.focus();
        return String(w.vditor.getValue()); })()`);
      await sleep(300);
      await session.type('Z');
      await sleep(500);
      await session.key({key: 'Backspace', code: 'Backspace', vk: 8});
      await sleep(700);
      const after2 = await session.js(`(() => String(${IF}.vditor.getValue()))()`);
      const caret2 = (await session.js(PROBES)).caret;
      ctx.witness('坏 CSS 之后：打字+退格往返与光标', {same: after2 === before2, caret: caret2});
      ctx.assert('坏 CSS 之后：打字与退格都还正常（源码往返一致、光标有真实矩形）',
        !!before2 && after2 === before2 && !!caret2 && caret2.height > 4, {same: after2 === before2, caret: caret2});
      // 删除这套主题：列表、样式表、作用域属性、写作区基线四方一起验
      if (!await openDialog(session)) { ctx.assert('坏 CSS：能重新打开对话框以删除', false, null); return; }
      const del = await session.js(`(() => { const w = ${IF}, d = w.document, fr = document.getElementById('editor').getBoundingClientRect();
        const item = d.querySelector('#typora-themes .user-theme-list li[data-active=true]');
        if (!item) return null; item.scrollIntoView({block: 'nearest'});
        const btn = item.querySelector('[data-action=delete]'); const r = btn.getBoundingClientRect();
        return {x: Math.round(fr.x + r.left + r.width / 2), y: Math.round(fr.y + r.top + r.height / 2)}; })()`);
      if (del) { await session.click(del.x, del.y); await sleep(700); }
      const cleared = await session.js(PROBES);
      ctx.witness('删除自定义主题之后', {stored: cleared.stored, styleElement: cleared.styleElement, scopeAttr: cleared.scopeAttr, h1: cleared.h1});
      ctx.assert('删除后：主题列表里不再有它、样式表与作用域属性也一并去掉、写作区回到基线',
        Array.isArray(cleared.stored) && !cleared.stored.includes('语法坏掉') && cleared.styleElement === false && cleared.scopeAttr === null
          && JSON.stringify({surface: cleared.surface, h1: cleared.h1, p: cleared.p, code: cleared.code, td: cleared.td}) === baseJson,
        {stored: cleared.stored, styleElement: cleared.styleElement, scopeAttr: cleared.scopeAttr});
      await closeDialog(session);
    } finally {
      await session.close();
    }
  },
};
