/** 追问：为什么 → 会跳过标题行？——把标题那一块的结构、可编辑性、命中结果打出来。
 *  用法：node scripts/acceptance/probe-repro-hheading2.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-hheading2');
const IF = `document.getElementById('editor').contentWindow`;

const 查 = `(() => {
  const 块 = [...document.querySelectorAll('.vditor-ir .vditor-reset > *')];
  const 标题 = 块.find(b => (b.textContent || '').includes('1.3.3 Def'));
  if (!标题) return {没找到: true};
  const r = 标题.getBoundingClientRect();
  const 中点 = {x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2)};
  const el = document.elementFromPoint(中点.x, 中点.y);
  const hit = document.caretRangeFromPoint(中点.x, 中点.y);
  const at = hit && (hit.startContainer.nodeType === 3 ? hit.startContainer.parentElement : hit.startContainer);
  const 链 = (() => { const out = []; let cur = at;
    while (cur && out.length < 6) { out.push({标签: cur.tagName + '.' + String(cur.className).split(' ').slice(0, 3).join('.'),
      可编辑: cur.isContentEditable, 显示: getComputedStyle(cur).display, 位置: getComputedStyle(cur).position}); cur = cur.parentElement; }
    return out; })();
  return {标题块: {标签: 标题.tagName + (标题.dataset?.type ? '[' + 标题.dataset.type + ']' : ''),
      可编辑: 标题.isContentEditable, rect: {y: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height)}},
    标题HTML: String(标题.outerHTML).slice(0, 260),
    命中元素: el ? el.tagName + '.' + String(el.className).split(' ').slice(0, 3).join('.') : null,
    命中元素可编辑: el ? el.isContentEditable : null,
    落点链: 链,
    落点rect: hit ? (() => { const b = hit.getBoundingClientRect(); return {y: Math.round(b.top), h: Math.round(b.height)}; })() : null,
    段落们: 块.filter(b => /^(P|H[1-6])$/.test(b.tagName)).map(b => { const q = b.getBoundingClientRect();
      return {标签: b.tagName, 可编辑: b.isContentEditable, y: Math.round(q.top), 文本: String(b.textContent || '').replace(/\\s+/g, ' ').slice(0, 20)}; }).slice(0, 6)}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, '片段.md');
  fs.copyFileSync(path.join(project, '.perf/片段-fixture.md'), doc);
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-hheading2', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2500);
    console.log(JSON.stringify(await session.js(`(() => { const w = ${IF}; return w.eval(${JSON.stringify(查)}); })()`), null, 1));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
