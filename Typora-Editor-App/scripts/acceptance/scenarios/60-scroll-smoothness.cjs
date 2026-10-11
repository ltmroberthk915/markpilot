/** 滚动响应验收（打包产物 + 真实滚轮 + 页面内帧间隔）。
 *
 *  这是多维度里之前没有产品级数字的一项：大文档开着 content-visibility 滚动，用户能感到的
 *  是"帧有没有掉"。这里用真实滚轮连续滚动，同时用 rAF 采样帧间隔，报出 p50/p95/最大帧与
 *  掉帧比例，并断言 p95 不超过一个可用阈值（默认 50ms ≈ 掉 3 帧以内）。
 */
'use strict';
const harness = require('../harness.cjs');
const fixtures = require('../fixtures.cjs');

const READY = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const surface = w && w.document && w.document.querySelector('.vditor-ir .vditor-reset');
  return !!(surface && surface.childElementCount > 200 && surface.scrollHeight > surface.clientHeight * 4);
})()`;

/** 开始采样：记录每一帧的间隔与滚动位置（采样在编辑器 iframe 里跑）。 */
const START_SAMPLING = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const surface = w.document.querySelector('.vditor-ir .vditor-reset');
  const state = w.__scrollProbe = {frames: [], startedAt: performance.now(), running: true, scrollHeight: surface.scrollHeight};
  let last = performance.now();
  const tick = now => {
    if (!state.running) return;
    state.frames.push(Math.round((now - last) * 10) / 10);
    last = now;
    w.requestAnimationFrame(tick);
  };
  w.requestAnimationFrame(tick);
  return true;
})()`;

const STOP_SAMPLING = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const state = w.__scrollProbe || {frames: []};
  state.running = false;
  const surface = w.document.querySelector('.vditor-ir .vditor-reset');
  const frames = state.frames.slice(2); // 丢掉前两帧（起拍抖动）
  const sorted = frames.slice().sort((a, b) => a - b);
  const at = q => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null;
  return {frames: frames.length, p50: at(0.5), p95: at(0.95), max: sorted.length ? sorted[sorted.length - 1] : null,
    dropped: frames.filter(ms => ms > 33).length, elapsed: Math.round(performance.now() - state.startedAt),
    scrollTop: surface.scrollTop, scrollHeight: surface.scrollHeight};
})()`;

module.exports = {
  id: '60-scroll-smoothness',
  title: '滚动响应（真实滚轮 + 帧间隔采样）',
  async run(ctx) {
    const file = fixtures.large();
    const session = await ctx.launch({ args: [file] });
    try {
      const ready = await session.until(READY, { timeout: 90000, interval: 20 });
      ctx.assert('大文档已窗口化上屏（块数 > 200 且可滚动）', ready, `ready=${ready}`);
      if (!ready) return;
      const view = await session.js(`(() => {
        const frame = document.getElementById('editor');
        const rect = frame.getBoundingClientRect();
        const w = frame.contentWindow;
        const surface = w.document.querySelector('.vditor-ir .vditor-reset');
        return {x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), scrollHeight: surface.scrollHeight, clientHeight: surface.clientHeight};
      })()`);
      // 等首屏后的预热/校准跑完再测滚动（否则测到的是它们的成本，不是滚动的成本）。
      await session.js(`(async () => { const start = performance.now(); while (performance.now() - start < 2500) await new Promise(r => requestAnimationFrame(r)); return 1; })()`);

      await session.js(START_SAMPLING);
      const before = await session.js(`(() => { const w = document.getElementById('editor').contentWindow; return w.document.querySelector('.vditor-ir .vditor-reset').scrollTop; })()`);
      const steps = 24;
      for (let index = 0; index < steps; index++) {
        await session.wheel(view.x, view.y, 420);
        await harness.sleep(70);
      }
      await harness.sleep(500);
      const sample = await session.js(STOP_SAMPLING);
      const after = sample.scrollTop;
      ctx.witness('滚动采样（页面内 rAF 帧间隔）', { frames: sample.frames, p50: sample.p50, p95: sample.p95, max: sample.max, dropped: sample.dropped, scrollTop: [before, after], scrollHeight: sample.scrollHeight });
      ctx.log(`滚动：${steps} 次滚轮 ΔscrollTop=${Math.round(after - before)}px，${sample.frames} 帧 p50 ${sample.p50}ms / p95 ${sample.p95}ms / 最大 ${sample.max}ms，掉帧(>33ms) ${sample.dropped} 帧，采样时长 ${sample.elapsed}ms`);
      ctx.assert('滚轮真的滚动了（scrollTop 明显变化）', after - before > 1000, `ΔscrollTop=${Math.round(after - before)}`);
      ctx.assert('帧间隔 p50 在一帧内（≤20ms）', sample.p50 !== null && sample.p50 <= 20, `p50=${sample.p50}ms`);
      ctx.assert('帧间隔 p95 可用（≤50ms，约 3 帧以内）', sample.p95 !== null && sample.p95 <= 50, `p95=${sample.p95}ms 最大 ${sample.max}ms`);
      ctx.assert('掉帧比例低于 10%', sample.frames > 0 && sample.dropped / sample.frames < 0.1, `掉帧 ${sample.dropped}/${sample.frames}`);
      ctx.metric('scroll.frameP50', sample.p50 ?? -1, { unit: 'ms', direction: 'lower', tolerance: 0.3, floor: 3 });
      ctx.metric('scroll.frameP95', sample.p95 ?? -1, { unit: 'ms', direction: 'lower', tolerance: 0.3, floor: 5 });
      ctx.metric('scroll.droppedRatio', sample.frames ? Math.round((sample.dropped / sample.frames) * 1000) / 10 : -1, { unit: '%', direction: 'lower', tolerance: 0.5, floor: 2 });
      await session.shot('scroll-after');
    } finally {
      await ctx.release(session);
    }
  },
};
