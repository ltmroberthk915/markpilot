/** 横向跳行（doc B 的 H3/H4 既有红）定点复现：找到"→ 跳过了中间那一行"的情形，
 *  把被跳过那一行的**内容与层**打出来（正文？预览？围栏？整行只有一条公式？）。
 *  用法：node scripts/acceptance/probe-repro-hskip.cjs [扫描轮数]
 *
 *  下面的脚本片段都在**编辑器 iframe 里**求值（inFrame 负责包一层 w.eval）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-hskip');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '1-重识概率论.md');
const IF = `document.getElementById('editor').contentWindow`;
const inFrame = (script, session) => session.js(`(() => { const w = ${IF}; return w.eval(${JSON.stringify(script)}); })()`);

/** 滚动容器在外壳层：window.scrollTo 纹丝不动，必须 scrollIntoView（2026-09-20 实测）。 */
const 滚动 = f => `(() => { const root = document.querySelector('.vditor-ir .vditor-reset');
  const dh = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, root.scrollHeight);
  const max = Math.max(0, dh - window.innerHeight);
  const 目标 = Math.round(${f} * max);
  const 块 = [...root.querySelectorAll(':scope > *')];
  let 选 = 块[0] || null;
  for (const el of 块) { if (el.offsetTop <= 目标) 选 = el; else break; }
  if (选) 选.scrollIntoView({block: 'start'});
  return {文档高: dh, 目标, 滚过的内容: -Math.round(root.getBoundingClientRect().top)}; })()`;

const 找点 = `(() => { const y = Math.round(window.innerHeight / 2);
  for (const x of [180, 300, 420, 540, 660]) {
    const hit = document.caretRangeFromPoint(x, y);
    if (!hit) continue;
    const at = hit.startContainer.nodeType === 3 ? hit.startContainer.parentElement : hit.startContainer;
    if (at.closest('.vditor-ir__preview,[data-type$="-marker"],code[data-type],table,button')) continue;
    const rect = hit.getBoundingClientRect();
    if (!rect.height) continue;
    return {x, y, 文本: String(at.textContent || '').slice(0, 20)}; }
  return null; })()`;

const 读数 = `(() => { const s = getSelection(); if (!s.rangeCount) return {无: true};
  const r = s.getRangeAt(0); const rect = r.getBoundingClientRect();
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  return {x: Math.round(rect.left), y: Math.round(rect.top), h: Math.round(rect.height),
    层: at.closest('.vditor-ir__preview') ? '预览' : at.closest('[data-type$="-marker"]') ? '围栏'
      : at.closest('code[data-type]') ? '源码' : at.closest('table') ? '表格' : '正文',
    文本: String(at.textContent || '').slice(0, 20)}; })()`;

const 夹心 = (y0, y1) => `(() => {
  const out = [];
  for (let y = Math.min(${y0}, ${y1}) + 3; y <= Math.max(${y0}, ${y1}) - 3; y += 2) {
    for (const x of [60, 200, 400, 700]) {
      const hit = document.caretRangeFromPoint(x, y);
      if (!hit) continue;
      const at = hit.startContainer.nodeType === 3 ? hit.startContainer.parentElement : hit.startContainer;
      if (at.closest('.vditor-ir__preview,[data-type$="-marker"],code[data-type],button,table')) continue;
      const rect = hit.getBoundingClientRect();
      if (!rect.height) continue;
      out.push({y: Math.round(rect.top), x: Math.round(rect.left), 文本: String(at.textContent || '').slice(0, 18)});
      break; } }
  const 唯一 = []; for (const r of out) if (!唯一.some(u => Math.abs(u.y - r.y) <= 3)) 唯一.push(r);
  return 唯一; })()`;

const 行清单 = y => `(() => {
  const 行 = [];
  for (let yy = ${y} - 44; yy <= ${y} + 44; yy += 4) {
    const hit = document.caretRangeFromPoint(200, yy) || document.caretRangeFromPoint(520, yy);
    const el = document.elementFromPoint(200, yy);
    const at = hit && (hit.startContainer.nodeType === 3 ? hit.startContainer.parentElement : hit.startContainer);
    行.push({y: yy,
      元素: el ? el.tagName + '.' + String(el.className).split(' ').slice(0, 2).join('.') : null,
      层: at?.closest?.('.vditor-ir__preview') ? '预览' : at?.closest?.('[data-type$="-marker"]') ? '围栏'
        : at?.closest?.('code[data-type]') ? '源码' : at?.closest?.('table') ? '表格' : at ? '正文' : null,
      文本: at ? String(at.textContent || '').replace(/\\s+/g, ' ').slice(0, 30) : null});
  }
  const 公式 = [...document.querySelectorAll('.vditor-ir__node[data-type="inline-node"],.vditor-ir__node[data-type="math-block"]')]
    .map(n => { const r = n.getBoundingClientRect(); return {类型: n.getAttribute('data-type'), top: Math.round(r.top), bottom: Math.round(r.bottom),
      文本: String(n.textContent || '').replace(/\\s+/g, ' ').slice(0, 24)}; })
    .filter(x => x.bottom > ${y} - 60 && x.top < ${y} + 60);
  return {行, 公式}; })()`;

async function shot(session, name, clip) {
  const result = await session.send('Page.captureScreenshot', {format: 'png', clip: {...clip, scale: 2}});
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  return file;
}

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'real-copy.md');
  fs.copyFileSync(SOURCE, doc);
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-hskip', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 240000, interval: 120});
    await sleep(3000);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    console.log('iframe：' + JSON.stringify(frame));
    let 命中 = 0;
    const 扫描 = Number(process.argv[2] || 14);
    for (let i = 0; i < 扫描; i++) {
      const f = (0.10 + i * 0.055).toFixed(3);
      const 滚读 = await inFrame(滚动(f), session);
      await sleep(280);
      if (i < 3) console.log("  滚动：" + JSON.stringify(滚读));
      const 点 = await inFrame(找点, session);
      if (!点) { console.log(`扫描 ${i}（滚 ${f}）：没找到可点正文行`); continue; }
      await session.click(frame.x + 点.x, frame.y + 点.y);
      await sleep(300);
      let 前 = await inFrame(读数, session);
      if (!前.h) { console.log(`扫描 ${i}（滚 ${f}）：起点光标不可见（${JSON.stringify(前)}），跳过`); continue; }
      const 步数 = Number(process.argv[3] || 6);
      for (let 步 = 1; 步 <= 步数; 步++) {
        await session.key({key: 'ArrowRight', code: 'ArrowRight', vk: 39});
        await sleep(260);
        const 读 = await inFrame(读数, session);
        const 夹 = await inFrame(夹心(前.y, 读.y), session) || [];
        const 跳过 = 夹.filter(r => r.y > Math.min(前.y, 读.y) + 3 && r.y < Math.max(前.y, 读.y) - 3);
        console.log(`  扫描 ${i}（滚 ${f}）步 ${步}：${JSON.stringify(前)} ⇒ → ${JSON.stringify(读)} 夹在中间=${JSON.stringify(跳过)}`);
        if (跳过.length) {
          命中 += 1;
          console.log('\n★ 抓到跳行（扫描 ' + i + ' 步 ' + 步 + '）：被跳过那一行 y≈' + 跳过[0].y + ' 的现场');
          console.log(JSON.stringify(await inFrame(行清单(跳过[0].y), session), null, 1));
          console.log('图：' + await shot(session, 'hskip-' + i + '-' + 步, {x: frame.x, y: frame.y + Math.max(0, 前.y - 130), width: frame.w, height: 280}));
          break;
        }
        if (!读.h) break;
        前 = 读;
      }
      if (命中 >= 2) break;
    }
    console.log(`\n本次扫描命中跳行 ${命中} 次`);
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
