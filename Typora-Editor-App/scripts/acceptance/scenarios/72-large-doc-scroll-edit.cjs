/** 大文档的"大情况"：真实滚轮到文末、在文末编辑并落盘、切换文档、以及打字延迟。
 *
 *  这一条覆盖用户说的"页面滚动、框架渲染"这类整体行为，判据全部落在可观测事实上：
 *    A 滚轮真的滚动了（scrollTop 单调增长、且滚到文末附近，与总高度对比）
 *    B 滚到的那一屏是**磁盘上真实存在的内容**（视口内文本能在磁盘 Markdown 里找到）
 *    C 视口里的公式被优先渲染（content-visibility 窗口化不能把可见区留在源码态）
 *    D 在文末编辑一字 → 磁盘尾部落盘（编辑位置与落盘内容都对）
 *    E 切换文档（大 → 小 → 大）：标题/字数与磁盘素材一致，旧文档内容不残留
 *    F 打字延迟：真实按键 → 下一帧的时间，进台账（这一项是本轮"每键收窄重解析"的判据）
 */
'use strict';
const fs = require('node:fs');
const harness = require('../harness.cjs');
const fixtures = require('../fixtures.cjs');
const edge = require('../edge-helpers.cjs');

const SCROLL_FACTS = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const doc = w && w.document;
  const surface = doc.querySelector(${JSON.stringify(edge.SURFACE)});
  // IR 编辑面自己就是滚动容器（与 60 场景一致）；如果它不是（布局变了），
  // 再向上找第一个真正能滚的祖先，绝不猜一个固定选择器。
  let scroller = surface;
  if (scroller && scroller.scrollHeight <= scroller.clientHeight + 4) {
    for (let node = surface.parentElement; node && node !== doc.body; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 40) { scroller = node; break; }
    }
  }
  const scrollerTop = scroller ? scroller.scrollTop : 0;
  const scrollerHeight = scroller ? scroller.scrollHeight : 0;
  const clientHeight = scroller ? scroller.clientHeight : 0;
  const blocks = surface ? [...surface.children] : [];
  const viewportTop = surface ? surface.getBoundingClientRect().top : 0;
  const visible = blocks.filter(block => { const rect = block.getBoundingClientRect(); return rect.bottom > viewportTop + 4 && rect.top < viewportTop + clientHeight - 4; });
  const visibleMath = visible.flatMap(block => [...block.querySelectorAll('.language-math')]);
  return {
    scrollerClass: scroller ? String(scroller.className).slice(0, 40) : null,
    scrollTop: Math.round(scrollerTop), scrollHeight: Math.round(scrollerHeight), clientHeight: Math.round(clientHeight),
    atBottom: scrollerHeight > clientHeight && scrollerTop + clientHeight >= scrollerHeight - 40,
    visibleCount: visible.length, visibleText: visible.map(block => block.textContent.replace(/\\s+/g, ' ').trim()).join(' | ').slice(0, 400),
    visibleTail: visible.map(block => block.textContent.replace(/\\s+/g, ' ').trim()).join(' | ').slice(-400),
    visibleMathCount: visibleMath.length,
    renderedMath: visibleMath.filter(node => node.querySelector('.katex')).length,
    totalBlocks: blocks.length,
  };
})()`;

const READING = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const doc = w && w.document;
  const surface = doc.querySelector(${JSON.stringify(edge.SURFACE)});
  const heading = doc.querySelector('.vditor-reset h1');
  return {href: String(w.location.href).slice(0, 80), heading: heading ? heading.textContent.replace(/^[#\\s]+/, '').trim() : null,
    chars: surface ? surface.textContent.length : 0, hasLargeMarker: surface ? surface.textContent.includes('公式密集节') : false};
})()`;

const wheelTo = async (session, view, steps, delta) => {
  for (let index = 0; index < steps; index++) {
    await session.wheel(view.x, view.y, delta);
    await harness.sleep(45);
  }
};

module.exports = {
  id: '72-large-doc-scroll-edit',
  title: '大文档：滚轮到文末、文末编辑落盘、文档切换完整性、打字延迟',
  async run(ctx) {
    const large = fixtures.large();
    const small = fixtures.small();
    const largeSource = fs.readFileSync(large, 'utf8');
    const smallSource = fs.readFileSync(small, 'utf8');
    const largeHeading = (largeSource.match(/^#\s+(.*)$/m) || [])[1].trim();
    const smallHeading = (smallSource.match(/^#\s+(.*)$/m) || [])[1].trim();
    // 末尾段落的判据从磁盘素材里取（不写死编号）：最后一段的正文前缀必须出现在视口里。
    const tailLine = largeSource.split('\n').reverse().find(line => line.trim().length > 20) || '';
    const tailMarker = tailLine.trim().slice(0, 14);
    ctx.witness('素材（磁盘字节）', { large: {bytes: largeSource.length, heading: largeHeading}, small: {bytes: smallSource.length, heading: smallHeading} });
    const session = await ctx.launch({ args: [large] });
    try {
      const ready = await session.until(`(() => {
        const frame = document.getElementById('editor');
        const w = frame && frame.contentWindow;
        const surface = w && w.document && w.document.querySelector(${JSON.stringify(edge.SURFACE)});
        return !!(surface && surface.childElementCount > 1500);
      })()`, { timeout: 120000, interval: 25 });
      ctx.assert('大文档的块全部上屏（>1500 顶层块）', ready, `ready=${ready}`);
      if (!ready) return;
      await session.js(edge.WATCH_TOASTS);
      await edge.settle(session);
      const start = await session.js(SCROLL_FACTS);
      ctx.log('初始：' + JSON.stringify({scrollTop: start.scrollTop, scrollHeight: start.scrollHeight, clientHeight: start.clientHeight, blocks: start.totalBlocks}));
      const domChars = (await session.js(READING)).chars;
      ctx.witness('DOM vs 磁盘（大文档）', { diskChars: largeSource.length, domChars, heading: (await session.js(READING)).heading, expected: largeHeading });
      ctx.assert('大文档内容渲染上屏且标题与磁盘一致',
        domChars > largeSource.length * 0.5 && (await session.js(READING)).heading === largeHeading,
        JSON.stringify({domChars, diskChars: largeSource.length}));

      // --- A/B) 真实滚轮到文末 -------------------------------------------------
      const surfaceBox = await session.js(`(() => {
        const frame = document.getElementById('editor');
        const w = frame.contentWindow;
        const surface = w.document.querySelector(${JSON.stringify(edge.SURFACE)});
        const rect = surface.getBoundingClientRect();
        return {x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + Math.min(rect.height - 10, 300))};
      })()`);
      let previous = start.scrollTop;
      let monotonic = true;
      for (let round = 0; round < 60; round++) {
        await wheelTo(session, surfaceBox, 2, 900);
        const now = await session.js(SCROLL_FACTS);
        if (now.scrollTop < previous - 4) monotonic = false;
        previous = now.scrollTop;
        if (now.atBottom) break;
      }
      const bottom = await session.js(SCROLL_FACTS);
      ctx.log('滚到底：' + JSON.stringify({scrollTop: bottom.scrollTop, scrollHeight: bottom.scrollHeight, atBottom: bottom.atBottom, visible: bottom.visibleCount}));
      ctx.witness('滚动事实（滚轮事件驱动）', { from: start.scrollTop, to: bottom.scrollTop, scrollHeight: bottom.scrollHeight, atBottom: bottom.atBottom, monotonic });
      ctx.assert('滚轮让文档真的滚动了（位置单调增加，没有回跳）', monotonic && bottom.scrollTop > start.scrollTop, JSON.stringify({from: start.scrollTop, to: bottom.scrollTop, monotonic}));
      ctx.assert('滚到了文末附近（不是只滚了一屏）', bottom.atBottom, JSON.stringify({scrollTop: bottom.scrollTop, clientHeight: bottom.clientHeight, scrollHeight: bottom.scrollHeight}));

      // --- B) 视口里的内容必须是磁盘上真实存在的内容 ---------------------------
      const words = bottom.visibleText.split(/[｜|]/).map(part => part.trim()).filter(part => part.length > 8);
      const found = words.filter(text => largeSource.includes(text.slice(0, 12)));
      ctx.witness('视口文本 vs 磁盘素材', { visible: words.slice(0, 4), matched: found.length, checked: words.length });
      ctx.assert('文末这一屏的文字都能在磁盘素材里找到（不是渲染残影）',
        words.length > 0 && found.length === words.length, JSON.stringify({checked: words.length, matched: found.length, sample: words.slice(0, 3)}));
      ctx.assert('末尾段落（磁盘上真实存在的最后一段）在视口里',
        bottom.visibleText.includes(tailMarker) || String(bottom.visibleTail || '').includes(tailMarker),
        JSON.stringify({tailMarker, head: bottom.visibleText.slice(0, 80), tail: String(bottom.visibleTail || '').slice(-120)}));

      // --- C) 可见区的公式必须已经渲染（窗口化不能把可见区留在源码态）---------
      ctx.assert('可见区的公式全部是渲染态（KaTeX 齐全）',
        bottom.visibleMathCount === 0 || bottom.renderedMath === bottom.visibleMathCount,
        JSON.stringify({visible: bottom.visibleMathCount, rendered: bottom.renderedMath}));
      ctx.metric('large.visibleMathRendered', bottom.visibleMathCount ? bottom.renderedMath / bottom.visibleMathCount : 1, { unit: '比例', direction: 'higher', tolerance: 0 });
      ctx.metric('large.blocks', bottom.totalBlocks, { unit: '块', direction: 'equal', tolerance: 0.05 });

      // --- D) 文末编辑一字并落盘 ----------------------------------------------
      const tailPoint = await session.js(edge.pointOf(`(() => {
        const doc = document.getElementById('editor').contentWindow.document;
        const surface = doc.querySelector(${JSON.stringify(edge.SURFACE)});
        const blocks = [...surface.children];
        const hit = blocks.reverse().find(block => block.textContent.includes('尾段') || block.textContent.includes('第 23'));
        return hit || null;
      })()`));
      ctx.assert('能找到文末段落并点进去', tailPoint.ok, JSON.stringify(tailPoint));
      if (tailPoint.ok) {
        await session.click(tailPoint.x, tailPoint.y);
        await harness.sleep(300);
        await session.key({ key: 'End', code: 'End', vk: 35 });
        await harness.sleep(250);
        await session.type('尾注甲');
        await harness.sleep(500);
        const tailSave = await edge.saveAndWait(session, large);
        ctx.witness('磁盘：文末编辑落盘', { tail: tailSave.after.slice(-120), changed: tailSave.after !== largeSource });
        ctx.assert('文末编辑真的写进了磁盘（末尾出现新文字）',
          tailSave.after !== largeSource && tailSave.after.includes('尾注甲'), JSON.stringify(tailSave.after.slice(-90)));
        ctx.assert('除了末尾，正文没有被整体改写（长度只增加了这一处）',
          tailSave.after.length - largeSource.length <= 12 && tailSave.after.length >= largeSource.length,
          `长度差 ${tailSave.after.length - largeSource.length}`);
      }

      // --- F) 打字延迟（真实按键 → 下一帧）------------------------------------
      // 口径：页面内记录 input 事件到达的时刻 T0，插完一个字符后等**一帧**再读
      // performance.now() - T0。所以这个数天然含一帧的等待（约 16.7ms）——它是"按键到
      // 画面更新"的端到端口径，不是"我们代码自己花了几毫秒"。门槛按此设。
      const typing = await session.js(`(() => {
        const frame = document.getElementById('editor');
        const w = frame && frame.contentWindow;
        const surface = w.document.querySelector(${JSON.stringify(edge.SURFACE)});
        const target = [...surface.children].reverse().find(block => block.textContent.includes(${JSON.stringify('尾注甲')}))
          || [...surface.children].reverse().find(block => block.textContent.trim().length > 20);
        if (!target) return {ok: false};
        const range = w.document.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
        const selection = w.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        surface.focus({preventScroll: true});
        w.__type = {at: null, chars: 0};
        surface.addEventListener('input', () => { if (w.__type.at === null) w.__type.at = performance.now(); w.__type.chars++; }, true);
        return {ok: true, tail: target.textContent.slice(-30)};
      })()`);
      ctx.log('打字探针就绪：' + JSON.stringify(typing));
      const frames = [];
      for (const character of 'abcdefghij') {
        await session.js(`(() => { document.getElementById('editor').contentWindow.__type.at = null; return 1; })()`);
        await session.type(character);
        const span = await session.js(`(async () => {
          await new Promise(resolve => requestAnimationFrame(resolve));
          const at = document.getElementById('editor').contentWindow.__type.at;
          return at === null ? null : Math.round(performance.now() - at);
        })()`);
        if (Number.isFinite(span)) frames.push(span);
      }
      frames.sort((a, b) => a - b);
      const mean = frames.reduce((sum, value) => sum + value, 0) / Math.max(1, frames.length);
      const p95 = frames[Math.floor(frames.length * 0.95)] ?? frames[frames.length - 1];
      ctx.witness('打字延迟样本（大文档末尾，含一帧等待）', { samples: frames, floorMs: 16.7 });
      ctx.log(`打字延迟（大文档，按键→下一帧）：均值 ${mean.toFixed(1)}ms，p95 ${p95}ms，最小 ${frames[0]}ms，样本 ${frames.length}（天然含一帧 ≈16.7ms）`);
      ctx.metric('type.large.meanMs', mean, { unit: 'ms', direction: 'lower', tolerance: 0.3, values: frames });
      ctx.metric('type.large.p95Ms', p95, { unit: 'ms', direction: 'lower', tolerance: 0.3 });

      // R10：打字测量的 10 个字符是真实未保存输入。旧代码在切换时把 <200ms 去抖窗内的
      // 键入静默丢弃（confirmDiscard 门3 病灶），本场景因此「碰巧」不弹框；修复后切换会
      // 正确弹「未保存的修改」，而验收环境没有对话框桩，真弹框会卡死整轮。切换前真键
      // Ctrl+S 洗净（R9 起手动保存会拉活值，飞行中的字一并落盘），场景考察的滚动/切换
      // 保真不受影响（丢字语义由 probe-r10-cd 专测）。
      await session.chord('s', 'KeyS', 83);
      await harness.sleep(1000);

      // --- E) 切换文档：大 → 小 → 大 ------------------------------------------
      const reopen = async (file, expectHeading) => {
        const before = await session.js(READING);
        await session.jsSoft(`hostApi.invoke('open-in-window', {path: ${JSON.stringify(file)}})`);
        const ok = await session.until(`(() => {
          const frame = document.getElementById('editor');
          const w = frame && frame.contentWindow;
          const doc = w && w.document;
          const h = doc ? doc.querySelector('.vditor-reset h1') : null;
          return !!(h && h.textContent.replace(/^[#\\s]+/, '').trim() === ${JSON.stringify(expectHeading)});
        })()`, { timeout: 60000, interval: 25 });
        await edge.settle(session);
        const now = await session.js(READING);
        return {before, after: now, ok, switched: now.href !== before.href};
      };
      const toSmall = await reopen(small, smallHeading);
      ctx.witness('切换文档：大 → 小', { heading: toSmall.after.heading, expected: smallHeading, chars: toSmall.after.chars, hrefChanged: toSmall.switched });
      ctx.assert('切到小文档：标题就是小文档的（大文档内容没有残留）',
        toSmall.ok && toSmall.after.heading === smallHeading && !toSmall.after.hasLargeMarker,
        JSON.stringify(toSmall.after));
      ctx.assert('切到小文档：字数与小文档磁盘素材同量级',
        toSmall.after.chars > 100 && toSmall.after.chars < smallSource.length * 1.5,
        JSON.stringify({domChars: toSmall.after.chars, diskChars: smallSource.length}));
      const backToLarge = await reopen(large, largeHeading);
      ctx.witness('切换文档：小 → 大', { heading: backToLarge.after.heading, expected: largeHeading, chars: backToLarge.after.chars });
      ctx.assert('切回大文档：标题与"公式密集节"都在（内容是真的大文档）',
        backToLarge.ok && backToLarge.after.heading === largeHeading && backToLarge.after.hasLargeMarker,
        JSON.stringify(backToLarge.after));
      ctx.assert('切回大文档：字数回到大文档量级（>5 万字符）', backToLarge.after.chars > 50000, JSON.stringify({domChars: backToLarge.after.chars}));

      // --- 错误面 --------------------------------------------------------------
      const toasts = await session.js(edge.TOASTS);
      const problems = [...(toasts.recorded || []), ...(toasts.live || [])].map(edge.errorsOf).flat();
      ctx.assert('全程没有错误提示（乱码 / -File / app.asar / 失败）', problems.length === 0, JSON.stringify({problems, toasts}));
      await session.shot('72-large-doc-scroll-edit');
    } finally {
      await ctx.release(session);
      try { fs.writeFileSync(large, largeSource); } catch { /* 忽略 */ }
    }
  },
};
