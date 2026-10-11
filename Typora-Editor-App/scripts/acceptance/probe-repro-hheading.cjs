/** doc B "→ 跳过标题行"的定点复现：把 208/210/212 那三行（正文 + `###` 标题 + 正文）抽成小素材，
 *  在"段末按 →"与"下一段开头按 ←"两个方向各走一遍，看看差在哪。
 *  用法：node scripts/acceptance/probe-repro-hheading.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-hheading');
const IF = `document.getElementById('editor').contentWindow`;
const inFrame = (script, session) => session.js(`(() => { const w = ${IF}; return w.eval(${JSON.stringify(script)}); })()`);

const 读数 = `(() => { const s = getSelection(); if (!s.rangeCount) return {无: true};
  const r = s.getRangeAt(0); const rect = r.getBoundingClientRect();
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const 块 = at.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th');
  const 链 = (() => { const out = []; let cur = r.startContainer;
    while (cur && out.length < 4) { const cls = (typeof cur.className === 'string' ? cur.className : '').split(' ').filter(Boolean).slice(0, 1).join('.');
      out.push(cur.nodeName + (cur.nodeType === 3 ? '("' + String(cur.data).slice(0, 10) + '")' : (cls ? '.' + cls : ''))); cur = cur.parentNode; }
    return out.join(' < '); })();
  return {x: Math.round(rect.left), y: Math.round(rect.top), h: Math.round(rect.height), 偏移: r.startOffset, 链,
    标签: 块 ? 块.tagName : null, 可编辑: 块 ? 块.isContentEditable : null,
    所在块: 块 ? String(块.textContent || '').replace(/\s+/g, ' ').slice(0, 24) : null}; })()`;

const 结构 = `(() => [...document.querySelectorAll('.vditor-ir .vditor-reset > *')].map(b => {
  const r = b.getBoundingClientRect();
  return {y: Math.round(r.top), bottom: Math.round(r.bottom), 标签: b.tagName + (b.dataset?.type ? '[' + b.dataset.type + ']' : ''),
    可编辑: b.isContentEditable, 文本: String(b.textContent || '').replace(/\s+/g, ' ').slice(0, 22)}; }))`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, '片段.md');
  fs.copyFileSync(path.join(project, '.perf/片段-fixture.md'), doc);
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-hheading', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2200);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    console.log('结构：\n' + JSON.stringify(await inFrame(结构, session), null, 1));
    const 目标 = await inFrame(`(() => { const 块 = [...document.querySelectorAll('.vditor-ir .vditor-reset > *')]
        .find(b => (b.textContent || '').includes('此外第 2 章'));
      if (!块) return null;
      块.scrollIntoView({block: 'center'});
      const r = 块.getBoundingClientRect();
      return {右: Math.round(r.right - 6), 左: Math.round(r.left + 4), 中: Math.round(r.left + 200), y: Math.round(r.top + r.height / 2)}; })()`, session);
    console.log('目标段：' + JSON.stringify(目标));
    for (const [标签, x, 键] of [
      ['① 段末按 →', 目标.右, 'ArrowRight'],
      ['② 段中按 →', 目标.中, 'ArrowRight'],
      ['③ 下段开头按 ←', null, 'ArrowLeft'],
    ]) {
      const 落点 = x !== null ? {x, y: 目标.y} : await inFrame(`(() => { const 块 = [...document.querySelectorAll('.vditor-ir .vditor-reset > *')]
          .find(b => (b.textContent || '').includes('简单函数的勒贝格积分'));
        if (!块) return null; const r = 块.getBoundingClientRect();
        return {x: Math.round(r.left + 4), y: Math.round(r.top + r.height / 2)}; })()`, session);
      if (!落点) { console.log(`\n${标签}：找不到落点`); continue; }
      await session.click(frame.x + 落点.x, frame.y + 落点.y);
      await sleep(320);
      const 前 = await inFrame(读数, session);
      await session.key({key: 键, code: 键, vk: 键 === 'ArrowRight' ? 39 : 37});
      await sleep(340);
      const 后 = await inFrame(读数, session);
      console.log(`\n${标签}：点(${落点.x},${落点.y})\n  前 ${JSON.stringify(前)}\n  后 ${JSON.stringify(后)}`);

    }
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
