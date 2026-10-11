/** 热打开：应用已经开着，再打开一个文档（双击文件的真实路径是 second-instance → 同一个窗口换文档）。
 *
 *  为什么单独测这一条：用户报"小文件打开好像变慢了"，而冷启动两条臂一样快。差别只可能
 *  出在"上一个文档还在收尾"的时候——上一轮的改动把预热/公式/CV 校准都挪到了首屏之后，
 *  如果这些后台工作还在跑，紧接着打开的小文档就会跟着变慢。所以这里刻意构造
 *  "大文档 → 小文档"与"小文档 → 小文档"两种顺序，比的是同一条热打开路径。
 *
 *  驱动方式：hostApi.invoke('open-in-window', {path}) —— 「文件 → 在此窗口打开文件…」用的就是
 *  这条入口，走的是与双击文件同一条主进程打开流程（队列 → doc.openFile → 渲染层），不是
 *  渲染层的测试钩子。**不能用 'open-file'**：2.1.0 起"已经有文档的窗口再开一个文件"按设计
 *  新开一个窗口，老窗口的 iframe 永远不会换文档，本场景会一直等到超时（本轮实测踩到）。
 */
'use strict';
const fs = require('node:fs');
const fixtures = require('../fixtures.cjs');
const harness = require('../harness.cjs');

const READY = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const root = w && w.document && (w.document.querySelector('.vditor-ir .vditor-reset') || w.document.querySelector('.vditor-reset'));
  return !!(root && root.childElementCount > 2 && root.textContent.length > 200);
})()`;

const SRC = `(() => { const frame = document.getElementById('editor'); return frame ? String(frame.getAttribute('src') || '') : null; })()`;

const settle = `(async () => {
  const start = performance.now();
  await new Promise(resolve => requestAnimationFrame(resolve));
  await new Promise(resolve => requestAnimationFrame(resolve));
  return Math.round(performance.now() - start);
})()`;

const median = values => {
  const list = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  return list.length ? list[Math.floor(list.length / 2)] : null;
};

async function warmOpen(session, file) {
  // 就绪判据必须锚在"文档对象本身换了"上：iframe 换 src 是立刻生效的，而 contentWindow
  // 里还是旧文档——只看 src 会在 4ms 就误判成已就绪（第一版就是这样假通过的）。
  // performance.timeOrigin 只在导航发生时更新，正好是"新文档已建立"的判据。
  const before = await session.js(`(() => {
    const frame = document.getElementById('editor');
    const w = frame && frame.contentWindow;
    return {timeOrigin: w && w.performance ? w.performance.timeOrigin : 0, src: frame ? String(frame.getAttribute('src') || '') : ''};
  })()`);
  const startedAt = Date.now();
  const invoked = await session.jsSoft(`hostApi.invoke('open-in-window', {path: ${JSON.stringify(file)}})`);
  if (!invoked.ok) throw new Error('open-in-window 调用失败：' + invoked.error);
  const ready = await session.until(`(() => {
    const frame = document.getElementById('editor');
    if (!frame) return false;
    const w = frame.contentWindow;
    if (!w || !w.performance || !w.document) return false;
    if (!(w.performance.timeOrigin > ${JSON.stringify(before.timeOrigin)})) return false;
    const root = w.document.querySelector('.vditor-ir .vditor-reset') || w.document.querySelector('.vditor-reset');
    return !!(root && root.childElementCount > 2 && root.textContent.length > 200);
  })()`, { timeout: 60000, interval: 10 });
  const domAt = Date.now();
  await session.js(settle);
  const sniffer = await session.sniffer();
  const editor = sniffer.editor || {};
  return {
    ready, domAt, sniffer, editor,
    invokeToDom: domAt - startedAt,
    invokeToIframe: editor.timeOrigin ? editor.timeOrigin - startedAt : null,
    inPageToDom: editor.timeOrigin ? domAt - editor.timeOrigin : null,
    total: Date.now() - startedAt,
    heading: await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame && frame.contentWindow; const h = w && w.document ? w.document.querySelector('.vditor-reset h1') : null; return h ? h.textContent.replace(/^[#\\s]+/, '').trim() : null; })()`),
  };
}

module.exports = {
  id: '11-open-after-large',
  title: '热打开：上一个文档是大的 / 是小的',
  async run(ctx) {
    const small = fixtures.small();
    const smallB = fixtures.smallB();
    const large = fixtures.large();
    const expectedHeading = (fs.readFileSync(small, 'utf8').match(/^#\s+(.*)$/m) || [])[1]?.trim() || '';
    const expectedHeadingB = (fs.readFileSync(smallB, 'utf8').match(/^#\s+(.*)$/m) || [])[1]?.trim() || '';
    const cases = [
      { name: 'small-after-small', first: small, second: smallB, expect: expectedHeadingB, repeats: 2 },
      { name: 'small-after-large', first: large, second: small, expect: expectedHeading, repeats: 2 },
      { name: 'large-after-small', first: small, second: large, expect: '大文档验收', repeats: 1 },
    ];
    for (const item of cases) {
      // 同上：第一次启动不记账（冷缓存/系统扫描会让首档偏慢）。
      {
        const warmup = await ctx.launch({ args: [item.first] });
        try {
          await warmup.until(READY, { timeout: 90000, interval: 20 });
          await harness.sleep(1500);
        } finally {
          await ctx.release(warmup);
        }
      }
      const samples = [];
      for (let round = 0; round < item.repeats; round++) {
        const session = await ctx.launch({ args: [item.first] });
        try {
          const firstReady = await session.until(READY, { timeout: 90000, interval: 15 });
          if (!firstReady) { ctx.assert(`${item.name}：第一个文档就绪`, false, '未就绪'); continue; }
          // 大文档在前时，等它的首屏后工作（预热/公式/CV）跑到安静，才模拟"用户看完再开下一个"。
          await session.js(`(async () => { const n = performance.now(); while (performance.now() - n < 1500) await new Promise(r => requestAnimationFrame(r)); return 1; })()`);
          const before = await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame && frame.contentWindow; return w && w.__typoraWarmup ? JSON.stringify({queued: w.__typoraWarmup.queued, deferred: w.__typoraWarmup.deferred}) : null; })()`);
          const result = await warmOpen(session, item.second);
          if (round === 0) {
            ctx.witness('热打开后的屏幕标题 vs 磁盘素材', { case: item.name, heading: result.heading, expectedHeading: item.expect });
            ctx.assert(`${item.name}：第二个文档渲染上屏`, result.ready && result.heading === item.expect, `ready=${result.ready} 标题「${result.heading}」/ 磁盘「${item.expect}」`);
          }
          samples.push(result);
          ctx.log(`${item.name} 第 ${round + 1} 次：调用→DOM ${result.invokeToDom}ms（调用→iframe ${result.invokeToIframe}ms，页面内→DOM ${result.inPageToDom}ms）开前预热 ${before}`);
        } finally {
          await ctx.release(session);
        }
      }
      if (!samples.length) continue;
      const pick = key => median(samples.map(sample => sample[key]));
      const values = key => samples.map(sample => sample[key]).filter(value => Number.isFinite(value));
      // **一律把样本交给台账**（2026-09-17 调整）：`ctx.metric` 对延迟类指标取样本**最小值**进台账，
      // 这是仓库既定的口径（"单次冷启动的抖动可达数倍…最小值是这台机器能做到多快"）。
      // 这三项此前只传了中位数，于是一次环境尖峰就能把整轮判红：实测 `hot.small-after-small.inPageToDom`
      // 同一次运行里其它项都正常（invokeToIframe 5ms、invokeToDom 154ms），只有它读到 **2058ms**
      // （基准 130ms），闸门因此拒绝写基准。传 `values` 后按最小值记账，尖峰不再冒充退化。
      ctx.metric(`hot.${item.name}.invokeToDom`, pick('invokeToDom') ?? -1, { unit: 'ms', direction: 'lower', tolerance: 0.25, samples: samples.length, values: values('invokeToDom') });
      if (pick('invokeToIframe')) ctx.metric(`hot.${item.name}.invokeToIframe`, pick('invokeToIframe'), { unit: 'ms', direction: 'lower', tolerance: 0.3, samples: samples.length, values: values('invokeToIframe') });
      // 绝对下限 150ms：这两项与场景 10 的相位一样，是**每次运行只取一次的冷读数**，
      // 环境抖动可达数倍（同一份产物三次运行：`hot.small-after-large.inPageToDom` = 133 / 135 / 248ms，
      // 而基准是 2.0.18 时代的 132ms），±30% 的相对容差在这种噪声下没有判别力。
      // 成倍的退化仍会越界（150ms 以上即报），被放过的只是百毫秒级的环境抖动。
      if (pick('inPageToDom')) ctx.metric(`hot.${item.name}.inPageToDom`, pick('inPageToDom'), { unit: 'ms', direction: 'lower', tolerance: 0.3, samples: samples.length, floor: 150, values: values('inPageToDom') });
    }
  },
};
