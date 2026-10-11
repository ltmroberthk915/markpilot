/** 阅读位置还原验收（打包产物 + 真实滚轮 + 磁盘上的状态文件做独立证人）。
 *
 *  用户上一轮的诉求："含图文档关掉再打开，要回到上次停的地方"。这条场景走真实路径：
 *  真实滚轮滚到某一段 → 换开另一个文档（等于把当前文档关掉）→ 再开回来 →
 *  断言那一段仍然贴在视口顶部。
 *
 *  两路证人：
 *    · 磁盘：scratch profile 里的 state.json 必须记下该文件的滚动锚点（index/head）；
 *      产品自报"我记住了"不算数。
 *    · 几何：重开之后视口顶部那一块必须就是锚点段落（±8px）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('../harness.cjs');
const fixtures = require('../fixtures.cjs');

const ANCHOR_TEXT = '锚点甲：这一段的开头就是还原判据';
const SECOND_TEXT = '锚点乙：第二处锚点';

const GEOMETRY = text => `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const doc = w && w.document;
  const surface = doc ? doc.querySelector('.vditor-ir .vditor-reset') : null;
  if (!surface) return {error: '找不到编辑面'};
  const blocks = [...surface.children];
  const anchor = blocks.find(block => block.textContent.includes(${JSON.stringify(text)}));
  const surfaceRect = surface.getBoundingClientRect();
  const anchorRect = anchor ? anchor.getBoundingClientRect() : null;
  // 视口顶部那一块：底边在容器顶部之下、顶边最接近容器顶部的那一块
  const visible = blocks.filter(block => { const rect = block.getBoundingClientRect(); return rect.bottom > surfaceRect.top + 2 && rect.top < surfaceRect.bottom; });
  const topBlock = visible[0] || null;
  return {
    scrollTop: surface.scrollTop, scrollHeight: surface.scrollHeight, clientHeight: surface.clientHeight,
    surfaceTop: Math.round(surfaceRect.top), surfaceLeft: Math.round(surfaceRect.left),
    surfaceRect: {x: surfaceRect.x, y: surfaceRect.y, width: surfaceRect.width, height: surfaceRect.height},
    anchorTop: anchorRect ? Math.round(anchorRect.top) : null,
    anchorDelta: anchorRect ? Math.round(anchorRect.top - surfaceRect.top) : null,
    anchorText: anchor ? anchor.textContent.slice(0, 24) : null,
    topBlockText: topBlock ? topBlock.textContent.slice(0, 24) : null,
    anchorTags: blocks.map(block => block.tagName).slice(0, 3),
  };
})()`;

module.exports = {
  id: '40-restore-position',
  title: '阅读位置还原（滚轮 → 换文档 → 开回来）',
  async run(ctx) {
    const anchorFile = fixtures.anchor();
    const other = fixtures.small();
    const session = await ctx.launch({ args: [anchorFile] });
    try {
      const ready = await session.until(`(() => {
        const frame = document.getElementById('editor');
        const w = frame && frame.contentWindow;
        const surface = w && w.document && w.document.querySelector('.vditor-ir .vditor-reset');
        return !!(surface && surface.textContent.includes(${JSON.stringify(ANCHOR_TEXT)}));
      })()`, { timeout: 90000, interval: 20 });
      ctx.assert('锚点文档已上屏', ready, `ready=${ready}`);
      if (!ready) return;
      const start = await session.js(GEOMETRY(ANCHOR_TEXT));
      ctx.assert('编辑面是可滚动的（文档比视口高）', start.scrollHeight > start.clientHeight + 200, JSON.stringify({scrollHeight: start.scrollHeight, clientHeight: start.clientHeight}));

      // 真实滚轮：滚到"锚点甲"贴在视口顶部附近（±40px 内再收敛）。
      const point = { x: Math.round(start.surfaceRect.x + start.surfaceRect.width / 2), y: Math.round(start.surfaceRect.y + start.surfaceRect.height / 2) };
      let geometry = start;
      for (let step = 0; step < 60 && (geometry.anchorDelta === null || geometry.anchorDelta > 60); step++) {
        const delta = geometry.anchorDelta === null ? 300 : Math.max(40, Math.min(400, geometry.anchorDelta - 4));
        await session.wheel(point.x, point.y, delta);
        await harness.sleep(90);
        geometry = await session.js(GEOMETRY(ANCHOR_TEXT));
      }
      ctx.log('滚动到位：' + JSON.stringify({scrollTop: geometry.scrollTop, anchorDelta: geometry.anchorDelta, topBlock: geometry.topBlockText}));
      ctx.assert('滚轮把锚点段落带到了视口顶部（滚动真的生效）', geometry.anchorDelta !== null && Math.abs(geometry.anchorDelta) <= 60,
        JSON.stringify({anchorDelta: geometry.anchorDelta, scrollTop: geometry.scrollTop}));
      // 等滚动停止后的持久化节流（应用侧 400ms 级）落地。
      await harness.sleep(1600);

      // 磁盘证人：scratch profile 的 state.json 里必须有这个文件的滚动锚点。
      const stateFile = path.join(session.profile, 'state.json');
      const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; } };
      const persisted = readState();
      const anchors = persisted?.scrollAnchor || {};
      const key = Object.keys(anchors).find(name => name.toLowerCase().includes('anchor.md'));
      const anchorRecord = key ? anchors[key] : null;
      ctx.witness('磁盘 state.json 里的滚动锚点（独立证人）', { stateFile, keys: Object.keys(anchors).map(name => path.basename(name)), record: anchorRecord, store: persisted ? Object.keys(persisted).length : null }, 'disk');
      ctx.log('state.json 锚点：' + JSON.stringify(anchorRecord));
      ctx.assert('磁盘上确实记下了这个文件的滚动锚点（index/head/总块数）',
        !!anchorRecord && Number.isFinite(anchorRecord.index) && anchorRecord.index > 0 && typeof anchorRecord.head === 'string' && anchorRecord.head.length > 0,
        JSON.stringify(anchorRecord));

      // 换开另一个文档（等于把当前文档关掉），再开回来。
      const switched = await session.jsSoft(`hostApi.invoke('open-in-window', {path: ${JSON.stringify(other)}})`);
      ctx.assert('换开另一个文档成功', switched.ok, JSON.stringify(switched.error));
      const switchedReady = await session.until(`(() => {
        const frame = document.getElementById('editor');
        const w = frame && frame.contentWindow;
        const surface = w && w.document && w.document.querySelector('.vditor-ir .vditor-reset');
        return !!(surface && surface.textContent.includes('小文档验收'));
      })()`, { timeout: 60000, interval: 20 });
      ctx.assert('第二个文档上屏', switchedReady, `ready=${switchedReady}`);
      const reopened = await session.jsSoft(`hostApi.invoke('open-in-window', {path: ${JSON.stringify(anchorFile)}})`);
      ctx.assert('把锚点文档开回来成功', reopened.ok, JSON.stringify(reopened.error));
      const backReady = await session.until(`(() => {
        const frame = document.getElementById('editor');
        const w = frame && frame.contentWindow;
        const surface = w && w.document && w.document.querySelector('.vditor-ir .vditor-reset');
        return !!(surface && surface.textContent.includes(${JSON.stringify(ANCHOR_TEXT)}));
      })()`, { timeout: 60000, interval: 20 });
      ctx.assert('锚点文档重新上屏', backReady, `ready=${backReady}`);
      // 还原是"持续重贴"的：给它 1.5s 收敛，再读最终位置。
      await harness.sleep(1500);
      const restored = await session.js(GEOMETRY(ANCHOR_TEXT));
      const shot = await session.shot('restore-position');
      ctx.witness('重开后的几何（截图 + 数字）', { screenshot: shot, anchorDelta: restored.anchorDelta, scrollTop: restored.scrollTop,
        topBlock: restored.topBlockText, expected: ANCHOR_TEXT }, 'dom');
      ctx.log('重开之后：' + JSON.stringify({anchorDelta: restored.anchorDelta, scrollTop: restored.scrollTop, topBlock: restored.topBlockText}));
      ctx.assert('重开后锚点段落贴在视口顶部（±8px）', restored.anchorDelta !== null && Math.abs(restored.anchorDelta) <= 8,
        `锚点相对容器顶部 ${restored.anchorDelta}px（scrollTop ${restored.scrollTop}）`);
      ctx.assert('视口顶部那一块就是锚点段落（不是别的块）', String(restored.topBlockText || '').includes('锚点甲'),
        `顶部块=「${restored.topBlockText}」，期望含「锚点甲」`);
      ctx.metric('restore.anchorErrorPx', Math.abs(restored.anchorDelta ?? 9999), { unit: 'px', direction: 'lower', tolerance: 0.5, floor: 4 });
      ctx.witness('滚动前的落点（对比用）', { anchorDeltaBefore: geometry.anchorDelta, scrollTopBefore: geometry.scrollTop }, 'dom');
    } finally {
      await ctx.release(session);
    }
  },
};
