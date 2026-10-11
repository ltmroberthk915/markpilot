/** 75 号查找红的追凶：Ctrl+F 打开面板后点输入框、打字，字为什么进了正文？
 *  这里埋 focus/blur/activeElement 时间线 + focus() 的调用栈，看谁把焦点抢回编辑器。
 *  用法：node scripts/acceptance/probe-repro-findfocus.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-findfocus');
const IF = `document.getElementById('editor').contentWindow`;
const inFrame = (script, session) => session.js(`(() => { const w = ${IF}; return w.eval(${JSON.stringify(script)}); })()`);

const 装 = `(() => { const w = window, d = document;
  if (w.__ff) { w.__ff.log.length = 0; return 'reuse'; }
  const trace = w.__ff = {log: [], t0: performance.now()};
  const 名 = el => { if (!el) return 'null';
    const cls = String(el.className || '').split(' ').filter(Boolean).slice(0, 2).join('.');
    return el.tagName + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : ''); };
  const 记 = (种类, 详情) => trace.log.push({t: Math.round(performance.now() - trace.t0), 种类, ...详情});
  for (const 事件 of ['focusin', 'focusout', 'mousedown', 'mouseup', 'click', 'selectionchange']) {
    d.addEventListener(事件, event => 记(事件, {目标: 名(event.target), 活动: 名(d.activeElement),
      ...(事件 === 'selectionchange' ? {选区: (() => { const s = w.getSelection(); return s && s.rangeCount ? String(s).slice(0, 14) : ''; })()} : {})}), true);
  }
  const 原focus = w.HTMLElement.prototype.focus;
  w.HTMLElement.prototype.focus = function (...args) {
    let st = ''; try { st = String(new Error().stack).split('\\n').slice(1, 5).map(l => l.trim().replace(/^at\\s+/, '')).join(' | ').slice(0, 240); } catch {}
    记('focus()调用', {目标: 名(this), 栈: st});
    return 原focus.apply(this, args);
  };
  return 'installed'; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, '查找.md');
  fs.writeFileSync(doc, ['这是一段正文。', '', '$$', 'a1+b1=1', '$$', '', '公式下面还有正文 a1+b1=1 也在一行里出现一次。', ''].join('\n'), 'utf8');
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-findfocus', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2200);
    const fr = await session.js(`(() => { const f = document.getElementById('editor'); const r = f.getBoundingClientRect();
      return {x: Math.round(r.x), y: Math.round(r.y)}; })()`);
    console.log('埋点：' + await inFrame(装, session));
    await session.chord('f', 'KeyF', 70);
    await sleep(700);
    const 输入点 = await inFrame(`(() => { const d = document; const i = d.querySelector('#typora-find input');
      if (!i) return null; const r = i.getBoundingClientRect();
      return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)}; })()`, session);
    console.log('输入框中心（帧内）：' + JSON.stringify(输入点) + '，点它：');
    await session.click(fr.x + 输入点.x, fr.y + 输入点.y);
    await sleep(400);
    console.log('点击后活动元素：' + await inFrame(`(() => { const d = document; const a = d.activeElement;
      return a ? a.tagName + (a.id ? '#' + a.id : '') + (a.className ? '.' + String(a.className).split(' ')[0] : '') : 'null'; })()`, session));
    console.log('我的点击类补丁的标记：' + JSON.stringify(await inFrame("({ 空白带: window.__typoraBlankBand || null, 源码点击: window.__typoraClickIntoFormula || null, 守卫: window.__typoraMarkerCaret || null, 左走: window.__typoraLineStep || null })", session)));
    await session.type('a1');
    await sleep(500);
    console.log('打字后：输入框值=' + await inFrame(`String((document.querySelector('#typora-find input') || {}).value)`, session));
    const 轨 = await inFrame(`(window.__ff.log || []).slice(0, 30)`, session);
    console.log('事件时间线：');
    for (const 项 of 轨 || []) console.log('   ' + JSON.stringify(项));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
