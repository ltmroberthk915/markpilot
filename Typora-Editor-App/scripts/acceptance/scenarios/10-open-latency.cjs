/** 打开延迟：冷启动（双击文件的那种路径）到"内容进了 DOM / 画出第一帧 / 后台工作安静下来"。
 *
 *  这一条同时盯住用户本轮提的"小文件打开好像变慢了"：小/中/大三档都进台账，
 *  任何一档相对上一次被接受的版本退化超过容差就判失败——上一轮之所以只能靠用户
 *  手感发现，就是因为没有这根基线。
 *
 *  证人：磁盘上的素材文本 vs 屏幕上真实渲染出来的 DOM 文本（不是产品自报的值）。
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const fixtures = require('../fixtures.cjs');

const READY = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  if (!w || !w.document) return false;
  const root = w.document.querySelector('.vditor-ir .vditor-reset') || w.document.querySelector('.vditor-reset');
  return !!(root && root.childElementCount > 2 && root.textContent.length > 200);
})()`;

// IR 模式把 `#` 当作标记留在标题里，比较前必须剥掉，否则会误判成"内容不对"。
const plain = value => String(value == null ? '' : value).replace(/^[#\s\u200b]+/, '').trim();
const median = values => {
  const list = values.filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return null;
  return list[Math.floor(list.length / 2)];
};

const SETTLE = `(async () => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const start = performance.now();
  let quiet = performance.now();
  let last = -1;
  while (performance.now() - start < 15000) {
    await new Promise(resolve => requestAnimationFrame(resolve));
    const warm = w && w.__typoraWarmup;
    const queued = warm && typeof warm.queued === 'number' ? warm.queued : 0;
    const nodes = w && w.document ? w.document.querySelectorAll('*').length : 0;
    if (queued === 0 && nodes === last && nodes > 0) {
      if (performance.now() - quiet > 500) return Math.round(performance.now() - start);
    } else { quiet = performance.now(); last = nodes; }
  }
  return -1;
})()`;

const SCENE = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const root = w && w.document ? (w.document.querySelector('.vditor-ir .vditor-reset') || w.document.querySelector('.vditor-reset')) : null;
  const first = w && w.document ? w.document.querySelector('.vditor-reset h1, .vditor-reset h2') : null;
  const blocks = root ? [...root.children] : [];
  const visible = blocks.filter(block => { const rect = block.getBoundingClientRect(); return rect.bottom > 0 && rect.top < (w.innerHeight || 800); });
  const warm = w && w.__typoraWarmup;
  return {
    heading: first ? first.textContent.trim() : null,
    blocks: blocks.length,
    chars: root ? root.textContent.length : 0,
    visibleBlocks: visible.length,
    warmup: warm ? {mode: warm.mode, queued: warm.queued, slices: warm.slices, ms: Math.round(warm.ms || 0), deferred: warm.deferred} : null,
  };
})()`;

module.exports = {
  id: '10-open-latency',
  title: '打开延迟（小/中/大，冷启动）',
  async run(ctx) {
    // 冷启动的绝对值受进程调度影响，单次读数会飘（同一产物上实测过 1.5s–5.3s）；
    // 取多次的中位数，台账才有区分力。大文档次数少一档是为了控制时长。
    const cases = [
      ['small', fixtures.small(), 3],
      ['medium', fixtures.medium(), 3],
      ['large', fixtures.large(), 2],
    ];
    for (const [name, file, times] of cases) {
      // 先跑一次不记账的"热身启动"：一次会话里的第一次启动总是更慢（刚构建/刚安装的产物
      // 要被系统扫描、文件缓存是冷的——实测小文档 2520ms vs 热态 1505ms）。把它算进台账
      // 会把"每次跑的第一档"误判成退化（本轮已误判两次）。
      {
        const warmup = await ctx.launch({ args: [file] });
        try {
          await warmup.until(READY, { timeout: 90000, interval: 20 });
          await warmup.js(SETTLE);
        } finally {
          await ctx.release(warmup);
        }
      }
      const runs = [];
      for (let round = 0; round < times; round++) {
        const session = await ctx.launch({ args: [file] });
        try {
          const ready = await session.until(READY, { timeout: 90000, interval: 15 });
          const domAt = Date.now();
          const scene = ready ? await session.js(SCENE) : null;
          const sniffer = await session.sniffer();
          const editor = sniffer.editor || {};
          const source = fs.readFileSync(file, 'utf8');
          const expectedHeading = (source.match(/^#\s+(.*)$/m) || [])[1]?.trim() || '';
          const domChars = scene?.chars ?? 0;
          if (round === 0) {
            // 证人（代码之外）：素材是我们写在磁盘上的，屏幕上的字数必须对得上，
            // 首行标题必须就是磁盘上的那一行。产品自报的 getValue() 不算数。
            ctx.witness('磁盘素材 vs 屏幕 DOM', { file: path.basename(file), diskChars: source.length, domChars, heading: scene?.heading, expectedHeading, visibleBlocks: scene?.visibleBlocks });
            ctx.assert(`${name}：内容渲染上屏`, ready && domChars > source.length * 0.5, `ready=${ready} domChars=${domChars} diskChars=${source.length}`);
            ctx.assert(`${name}：标题与磁盘素材一致`, plain(scene?.heading) === plain(expectedHeading), `DOM「${plain(scene?.heading)}」/ 磁盘「${expectedHeading}」`);
            ctx.metric(`open.${name}.domChars`, domChars, { unit: '字符', direction: 'equal', tolerance: 0.02 });
          }
          if (!ready) continue;
          const settled = await session.js(SETTLE);
          const visible = session.windowVisible();
          runs.push({
            spawnToWindow: visible ? visible.spawnToVisible : null,
            spawnToDom: domAt - session.spawnedAt,
            shellToNav: editor.timeOrigin ? editor.timeOrigin - session.spawnedAt : null,
            inPageToDom: editor.timeOrigin ? domAt - editor.timeOrigin : null,
            settle: settled > 0 ? settled : null,
            cdpMs: session.connectedAt - session.spawnedAt,
            navigation: editor.navigation || null,
            frameRect: sniffer.frameRect || null,
            warmup: scene?.warmup || null,
            longtasks: (editor.longtasks || []).length,
          });
        } finally {
          // 产品内部服务占固定端口：下一个实例启动之前必须把这个放掉。
          await ctx.release(session);
        }
      }
      const pick = key => median(runs.map(run => run[key]));
      const min = key => { const list = runs.map(run => run[key]).filter(value => Number.isFinite(value)); return list.length ? Math.min(...list) : null; };
      ctx.log(`${name}：窗口可见 ${runs.map(run => run.spawnToWindow).join(' / ')}ms，内容进 DOM ${runs.map(run => run.spawnToDom).join(' / ')}ms` +
        ` → 中位 ${pick('spawnToDom')}ms / 最好 ${min('spawnToDom')}ms（外壳→iframe ${pick('shellToNav')}ms，页面内→DOM ${pick('inPageToDom')}ms，CDP ${runs[0]?.cdpMs}ms，首屏后安静 ${pick('settle')}ms，长任务 ${runs[0]?.longtasks} 条）`);
      if (pick('spawnToWindow')) ctx.metric(`open.${name}.spawnToWindow`, pick('spawnToWindow'), { unit: 'ms', direction: 'lower', tolerance: 0.25, samples: runs.length, values: runs.map(run => run.spawnToWindow) });
      ctx.metric(`open.${name}.spawnToDom`, pick('spawnToDom') ?? -1, { unit: 'ms', direction: 'lower', tolerance: name === 'small' ? 0.2 : 0.15, samples: runs.length, values: runs.map(run => run.spawnToDom) });
      // **给这两个相位一个绝对下限，理由写在这里**（2026-09-17 实测）：它们是**单次冷启动读数**
      // （每一轮只开一次这个尺寸的文档，没有第二条样本可取样），而环境抖动可以达到数倍——
      // 同一份产物连测三次，`open.large.shellToIframe` 分别是 **243 / 624 / 1143ms**（4.7×），
      // `hot.small-after-large.inPageToDom` 是 133 / 135 / 248ms。在这种噪声下，±25% 的相对容差
      // 没有意义，一次不走运的读数就会被记成"退化"（全量那一轮就是这么红的）。
      // 下限按实测抖动上沿取：外壳→iframe 400ms、页面内→DOM 120ms。**成倍的真退化仍会被抓住**
      // （例如刚才把假模态框修掉之前，整条打开路径是被卡住的），被放过的只是"百毫秒级的环境抖动"。
      ctx.metric(`open.${name}.shellToIframe`, pick('shellToNav') ?? -1, { unit: 'ms', direction: 'lower', tolerance: 0.25, samples: runs.length, floor: name === 'large' ? 400 : 200, values: runs.map(run => run.shellToNav) });
      ctx.metric(`open.${name}.inPageToDom`, pick('inPageToDom') ?? -1, { unit: 'ms', direction: 'lower', tolerance: 0.25, samples: runs.length, floor: 120, values: runs.map(run => run.inPageToDom) });
      ctx.metric(`open.${name}.settleAfterReady`, pick('settle') ?? -1, { unit: 'ms', direction: 'lower', tolerance: 0.35, samples: runs.length });
    }
  },
};
