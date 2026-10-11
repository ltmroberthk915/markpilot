/** 探针 · 连点第 3 下点击的事件时间线：谁在什么时候、把 `--expand` 摘掉。
 *  window 捕获 → document 捕获 → 目标；class 变更带 6 层调用栈。
 *  用法：node scripts/acceptance/probe-image-click-timeline.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-image-click-timeline');
const IF = hi.IF;
const BODY = ['# 中图文档', '', '前文甲乙丙。', '', '![中图](shot-blue.png)', '', '后文丁戊己。', ''].join('\n');

const ARM = `(() => { const w = ${IF}, d = w.document;
  const log = w.__tl = { events: [], classes: [] }; const t0 = w.performance.now();
  const name = el => el ? (el.nodeName + (el.className ? '.' + String(el.className).split(' ').slice(0, 2).join('.') : '')) : 'null';
  const chain = el => { const out = []; let node = el; while (node && out.length < 4) { out.push(name(node)); node = node.parentElement; } return out.join('<'); };
  for (const [级, 宿主] of [['win', w], ['doc', d]]) {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      宿主.addEventListener(type, e => {
        log.events.push({ t: +(w.performance.now() - t0).toFixed(1), 级, type, detail: e.detail,
          target: chain(e.target), 拦截: e.defaultPrevented, 阶段: e.eventPhase });
      }, true);
    }
  }
  const proto = Object.getPrototypeOf(d.querySelector('${hi.SURFACE}').classList);
  for (const op of ['add', 'remove']) {
    const original = proto[op];
    proto[op] = function (...args) {
      let val = null; try { val = this.value; } catch {}
      if (val && String(val).includes('vditor-ir__node--expand')) {
        log.classes.push({ t: +(w.performance.now() - t0).toFixed(1), op: op + '(' + args.join(',') + ')',
          栈: String(new Error().stack || '').split('\\n').slice(2, 9).map(s => s.trim().replace(/https?:[^)]*\\//, '').slice(0, 90)) });
      }
      return original.apply(this, args);
    };
  }
  return { ok: true }; })()`;
const READ_TL = `(() => { const w = ${IF}; const t = w.__tl; if (!t) return null;
  const d = w.document; const owner = d.querySelector('.vditor-ir__node[data-type="img"]');
  return { 展开: owner ? owner.classList.contains('vditor-ir__node--expand') : null,
    事件: t.events.map(e => e.t + ' ' + e.级 + '/' + e.type + '#' + e.detail + ' 拦=' + e.拦截 + ' ' + e.target.slice(0, 46)),
    类变更: t.classes.map(c => c.t + ' ' + c.op + ' ← ' + c.栈.slice(0, 3).join(' | ')) }; })()`;

const PICK = `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop(); if (!img) return { ok: false };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = img.getBoundingClientRect();
  return { ok: true, x: Math.round(frame.x + r.left + r.width / 2), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;
const textPointOf = word => `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('${word}'));
  const r = t.getBoundingClientRect(); return { x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;

async function clickAt(session, x, y, clickCount) {
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'shot-blue.png'), hi.fixtures.png(160, 100, [70, 110, 230]));
  const file = path.join(OUT, 'timeline.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: [path.join(harness.project, 'app/main/main.js')],
      label: 'probe-image-click-timeline', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 4, settleMs: 1400 });
  try {
    const geom = await session.js(PICK);
    const tp = await session.js(textPointOf('前文甲乙丙'));
    await clickAt(session, tp.x, tp.y, 1); await harness.sleep(300);
    await session.js(ARM);
    for (let i = 1; i <= 3; i++) { await clickAt(session, geom.x, geom.y, i); await harness.sleep(60); }
    await harness.sleep(500);
    const tl = await session.js(READ_TL);
    console.log(JSON.stringify({ 几何: geom, 时间线: tl }, null, 1));
    fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify({ 几何: geom, 时间线: tl }, null, 2));
  } finally {
    await ctx.release(session);
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
