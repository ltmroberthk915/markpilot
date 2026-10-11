/** 探针 · 复刻场景 92 的 H2：长（跨行）行内公式展开后，**按住源码 30% 处**，
 *  逐帧看展开态/落点，并读产品自己的"钳出去"标记（`__typoraInlineMathOutside`）。
 *
 *  用法：node scripts/acceptance/probe-long-inline-hold.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-long-inline-hold');
const IF = hi.IF;
const LONG_FORMULA = '\mathbb{E}_{\mathbb{P}}[\mathbf{1}_{E}]=\int \mathbf{1}_{E}\,d\mathbb{P}'
  + '=\int_{E} d\mathbb{P}=\mathbb{P}(E)+\mathbb{P}(E^{c})-\mathbb{P}(E\cap E^{c})'
  + '+\sum_{i=1}^{n}\alpha_{i}\beta_{i}\gamma_{i}';

const 几何 = `(() => { const w = ${IF}, doc = w.document, fr = w.frameElement.getBoundingClientRect();
  const o = doc.querySelectorAll('.vditor-ir .vditor-ir__node[data-type="inline-node"]')[2];
  const preview = o.querySelector(':scope > .vditor-ir__preview');
  const code = o.querySelector('code[data-type="math-inline"]');
  const box = r => ({left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom),
    w: Math.round(r.width), h: Math.round(r.height), shellLeft: Math.round(fr.x + r.left), shellTop: Math.round(fr.y + r.top)});
  return { expand: o.classList.contains('vditor-ir__node--expand'), preview: box(preview.getBoundingClientRect()),
    code: box(code.getBoundingClientRect()), fragments: [...o.getClientRects()].length,
    标: [...o.children].filter(x => x.nodeName === 'SPAN' && x.classList.contains('vditor-ir__marker')).map(x => box(x.getBoundingClientRect())),
    子: [...o.children].map(x => ({tag: x.nodeName, cls: String(x.className || '').slice(0, 40), dt: x.getAttribute && x.getAttribute('data-type'), 框: box(x.getBoundingClientRect())})) }; })()`;

const 态 = `(() => { const w = ${IF}, doc = w.document;
  const o = doc.querySelectorAll('.vditor-ir .vditor-ir__node[data-type="inline-node"]')[2];
  const code = o.querySelector('code[data-type="math-inline"]');
  const sel = w.getSelection(), rg = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const n = rg && rg.startContainer; const at = n ? (n.nodeType === 3 ? n.parentElement : n) : null;
  return { 展开: o.classList.contains('vditor-ir__node--expand'),
    在源码里: !!(rg && code.contains(rg.startContainer)),
    层: at ? (at.closest?.('code[data-type]') ? '源码' : at.closest?.('.vditor-ir__preview') ? '预览' : at.closest?.('p,h1') ? '正文' : '元素级') : null,
    在公式内: !!(at && at.closest && at.closest('.vditor-ir__node[data-type="inline-node"]')),
    钳过: w.__typoraInlineMathOutside ? JSON.stringify(w.__typoraInlineMathOutside) : null,
    选择: rg ? String(sel).slice(0, 20) : null,
    框内调试: w.__typoraClickDebug || null }; })()`;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'long-hold.md');
  fs.writeFileSync(file, ['# 浮框点击映射', '',
    '上面一段文字，中间夹一个行内公式 $\frac{a}{b}+1$ ，后面继续写点文字把版面撑开。', '',
    '下面一段也写点文字，再来一个 $\frac{x}{2}+1$ 结尾。', '',
    '第三段：' + '用来撑满一整行的中文文字'.repeat(3).slice(0, 40) + ' $' + LONG_FORMULA + '$ 后面继续写。', ''].join('\n'), 'utf8');
  const exe = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: [path.join(harness.project, 'app/main/main.js')],
      label: 'probe-long-inline-hold', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 3, settleMs: 1600 });
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  const 按住 = async (点, ms = 250) => {
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 点.x, y: 点.y, button: 'left', buttons: 1, clickCount: 1 });
    await hi.sleep(ms);
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 点.x, y: 点.y, button: 'left', buttons: 0, clickCount: 1 });
    await hi.sleep(400);
  };
  try {
    await hi.ensureFocus(session);
    let g = await session.js(几何);
    say('折叠态：' + JSON.stringify(g));
    if (!g.expand) {                       // 照 92 的做法：按渲染结果左缘 +10
      const 点 = {x: g.preview.shellLeft + 10, y: g.preview.shellTop + Math.round(g.preview.h / 2)};
      say('展开用点：' + JSON.stringify(点));
      await 按住(点, 90);
      g = await session.js(几何);
      say('展开后：' + JSON.stringify(g));
    }
    if (!g.expand) { say('⚠ 未能展开，停止'); return; }
    const 按点 = {x: g.code.shellLeft + Math.round(g.code.w * 0.3), y: g.code.shellTop + Math.round(g.code.h / 2)};
    say('\nH2 形态按点：' + JSON.stringify(按点) + '（code=' + JSON.stringify(g.code) + ' 围栏=' + JSON.stringify(g.标) + ' 浮框=' + JSON.stringify(g.preview) + '）');
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 按点.x, y: 按点.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 0; i < 10; i++) { await hi.sleep(25); const s = await session.js(态); say(`   f${i}: 展开=${s.展开} 在源码里=${s.在源码里} 层=${s.层} 在公式内=${s.在公式内} 钳过=${s.钳过} 选择=${s.选择}`); }
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 按点.x, y: 按点.y, button: 'left', buttons: 0, clickCount: 1 });
    await hi.sleep(400);
    say('\n松开后：' + JSON.stringify(await session.js(态)));
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
    await ctx.release(session);
  }
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });
