/** 探针 · F10 双光标：点"正文段 ↔ 独占行公式行"之间的空白带之后，
 *  原生光标落在正文层折叠态（画得出来），**同时**合成光标竖线还在 —— 同屏两根。
 *
 *  133 的读数只告诉我们"最后是这样"；这里要的是**时间线**：点击前后每帧采样
 *  （选区位置 / 原生矩形高度 / 合成竖线显隐），外加合成光标自己的日记（`__caretProxyLog`：
 *  谁画的、为什么没收），据此判"谁在什么时刻把合成线留下来没收回"。
 *
 *  用法：node scripts/acceptance/probe-f10-double-caret.cjs [--app=dev|installed]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-f10');
const IF = hi.IF, SURFACE = hi.SURFACE;
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');

const BODY = [
  '# 双光标练习标题', '',
  '第一段正文文字，用来提供块间空白的参照。', '',
  '$x_{独占一行}+1$', '',
  '第三段正文。', '',
  '![居中图片](shot-matrix.png)', '',
  '第五段正文收尾。', '',
].join('\n');

/** 采样一次：选区位置 + 原生矩形高度 + 合成竖线显隐。 */
const 采 = `(() => { const w = ${hi.IF}, d = w.document;
  const s = d.querySelector('${SURFACE}');
  const sel = w.getSelection();
  let 位置 = null, 原高 = 0, 层 = null;
  if (sel && sel.rangeCount) {
    const r = sel.getRangeAt(0);
    const n = r.startContainer;
    let top = n; while (top && top.parentElement && top.parentElement !== s) top = top.parentElement;
    const 块 = top && top.parentElement === s ? [...s.children].indexOf(top) : -1;
    const box = r.getBoundingClientRect();
    原高 = Math.round(box.height);
    const 上级 = n.nodeType === 3 ? n.parentElement : n;
    层 = n.nodeType === 3 ? (上级?.closest?.('code[data-type]') ? '源码' : 上级?.closest?.('.vditor-ir__preview') ? '预览'
      : 上级?.closest?.('.vditor-ir__marker,[data-type$="-marker"]') ? '围栏' : '正文') : '元素级';
    位置 = { 块, 容器: n.nodeType === 3 ? 'TEXT' : n.nodeName + '.' + String(n.className || '').slice(0, 20), 偏移: r.startOffset, 层, 原高, 折叠: r.collapsed };
  }
  const bars = [...d.querySelectorAll('[data-typora-caret-proxy]')].map(b => ({ 显示: b.style.display,
    框: (() => { const r = b.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })() }));
  return { 位置, 竖线: bars }; })()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'shot-matrix.png'), hi.fixtures.png(180, 120, [90, 160, 90]));
  const file = path.join(OUT, 'blankzone.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = APP === 'dev' ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe' : APP;
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: APP === 'dev' ? [path.join(harness.project, 'app/main/main.js')] : [],
      label: 'probe-f10', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 5, settleMs: 1500 });
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  try {
    await hi.ensureFocus(session);
    // 装时间线：每帧采样，最长 900ms
    await session.js(`(() => { const w = ${IF}; if (w.__f10) { w.__f10.停(); }
      const F = { 样: [], 停: null, 起: 0 };
      w.__f10 = F;
      F.起 = w.performance.now();
      let 跑 = true;
      F.停 = () => { 跑 = false; };
      const 帧 = () => { if (!跑) return;
        F.样.push({ t: Math.round(w.performance.now() - F.起), 态: (${采}) });
        if (w.performance.now() - F.起 < 900) w.requestAnimationFrame(帧); };
      w.requestAnimationFrame(帧);
      F.日记 = () => (w.__caretProxyLog || []).slice(-8);
      return 1; })()`);
    const 点 = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor');
      const fr = frame.getBoundingClientRect(); const s = d.querySelector(${JSON.stringify(SURFACE)});
      const blocks = [...s.children].filter(n => n.getBoundingClientRect().height > 0);
      const a = blocks[1].getBoundingClientRect(), b = blocks[2].getBoundingClientRect();
      const gap = b.top - a.bottom;
      return { x: Math.round(fr.x + a.x + a.width / 2), y: Math.round(fr.y + a.bottom + gap / 2), 间隙: Math.round(gap),
        块a: String(blocks[1].textContent).slice(0, 18), 块b: String(blocks[2].textContent).slice(0, 18) }; })()`);
    say('【采样点】' + JSON.stringify(点));
    // 点击后分时刻读数（页面内 rAF 采样在 iframe 里没跑起来，改成一串朴素读数）
    say('\n【点击后的光标/竖线读数】');
    await session.click(点.x, 点.y);
    for (const ms of [40, 80, 200, 400, 800]) {
      await harness.sleep(ms === 40 ? 40 : ms - (ms === 80 ? 40 : ms === 200 ? 80 : ms === 400 ? 200 : 400));
      const 态 = await session.js(采);
      const p = 态.位置;
      say(`   t≈${String(ms).padStart(4)}ms  ${p ? `块${p.块} ${p.容器}@${p.偏移}(${p.层}) 原生高${p.原高} 折叠${p.折叠}` : '无选区'}  竖线=${JSON.stringify(态.竖线)}`);
    }
    const 日记 = await session.js(`(() => { const F = ${IF}.__f10; return F ? F.日记() : null; })()`);
    say('\n【合成光标日记】');
    for (const e of (日记 || [])) say('   ' + JSON.stringify(e));
    await session.shot('f10-点击后');
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
    await ctx.release(session);
  }
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });
