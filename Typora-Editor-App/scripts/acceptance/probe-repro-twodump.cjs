/** 诊断：`$$` 块（含 (16,4),(15,6)）的子树几何 / 展开路径 / 展开后源码几何，
 *  再把"点源码行右下方一点"逐格打出来。一次性打印所有中间态。
 *  用法：node scripts/acceptance/probe-repro-twodump.cjs [--app=dev|installed|<exe>]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-twodump');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;
const NEEDLE = '(16,4),(15,6)';
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');

const boxOf = `const box = r => r ? {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} : null;`;

const 状态 = `(() => { const w = ${IF}; const d = w.document; ${boxOf}
  const blk = [...d.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(n => String(n.textContent).includes(${JSON.stringify(NEEDLE)}));
  if (!blk) return {没找到: true};
  const 描 = (el, 深) => {
    const s = w.getComputedStyle(el);
    const out = {标签: el.nodeName, cls: String(el.className || '').slice(0, 46), dt: el.getAttribute('data-type'),
      框: box(el.getBoundingClientRect()), 显示: s.display, 定位: s.position, 可见: s.visibility, 行高: s.lineHeight, 字号: s.fontSize,
      文本: el.children.length ? null : String(el.textContent).slice(0, 26)};
    if (深 > 0) out.子 = [...el.children].map(c => 描(c, 深 - 1));
    return out; };
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const bar = d.querySelector('[data-typora-caret-proxy]');
  return {展开: blk.classList.contains('vditor-ir__node--expand'), 内高: w.innerHeight, 块: 描(blk, 2),
    光标: at ? {链: (() => { const out = []; let cur = at.startContainer;
      while (cur && out.length < 5) { out.push(cur.nodeName + (cur.getAttribute && cur.getAttribute('data-type') ? '[dt=' + cur.getAttribute('data-type') + ']' : '') + (cur.nodeType === 3 ? '(len' + cur.data.length + ')' : '')); cur = cur.parentNode; } return out.join(' < '); })(),
      偏移: at.startOffset, rect: box(at.getBoundingClientRect())} : null,
    合成: bar ? {显示: bar.style.display, rect: box(bar.getBoundingClientRect()), left: bar.style.left, top: bar.style.top, h: bar.style.height} : null,
    合成计数: w.__caretProxyShown || 0}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const 原文 = fs.readFileSync(SOURCE, 'utf8').split('\n');
  const doc = path.join(OUT, 'fixture.md');
  fs.writeFileSync(doc, 原文.slice(10, 19).join('\n') + '\n', 'utf8');
  const exe = APP === 'dev' ? path.join(project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? path.join(process.env.LOCALAPPDATA || 'D:/Users/ltmroberthk/AppData/Local', 'Programs/markpilot/MarkPilot.exe') : APP;
  const session = await harness.launch({
    exe, appArgs: APP === 'dev' ? [path.join(project, 'app/main/main.js')] : [],
    label: 'probe-repro-twodump', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  const show = async (标签) => console.log('\n===== ' + 标签 + ' =====\n' + JSON.stringify(await session.js(状态), null, 1));
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2500);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    console.log('iframe=' + JSON.stringify(frame));
    await show('静态');

    // 点块里可见的预览（块框中心）
    const 中心 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const blk = [...d.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(n => String(n.textContent).includes(${JSON.stringify(NEEDLE)}));
      const r = blk.getBoundingClientRect();
      return {x: Math.round(r.left + Math.min(120, r.width / 2)), y: Math.round(r.top + r.height / 2)}; })()`);
    console.log('\n点预览中心 (' + 中心.x + ',' + 中心.y + ')');
    await session.click(frame.x + 中心.x, frame.y + 中心.y);
    await sleep(500);
    await show('① 点预览中心后');

    // 若已展开：点源码行末尾
    const 行末 = await session.js(`(() => { const w = ${IF}; const d = w.document; ${boxOf}
      const blk = [...d.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(n => String(n.textContent).includes(${JSON.stringify(NEEDLE)}));
      const code = blk.querySelector('code[data-type="math-block"]') || blk.querySelector('pre');
      const tn = code ? [...code.childNodes].find(n => n.nodeType === 3 && n.data.includes(${JSON.stringify(NEEDLE)})) : null;
      if (!tn) return {没有文本节点: true, 源码: code ? {框: box(code.getBoundingClientRect()), 显示: w.getComputedStyle(code).display} : null};
      const i = tn.data.indexOf(${JSON.stringify(NEEDLE)}) + ${JSON.stringify(NEEDLE)}.length;
      const rng = d.createRange(); rng.setStart(tn, i); rng.setEnd(tn, i);
      return {行末框: box(rng.getBoundingClientRect()), 源码框: box(code.getBoundingClientRect()), 行矩形们: [...code.getClientRects()].map(box)}; })()`);
    console.log('\n【行末读数】' + JSON.stringify(行末));
    if (行末.行末框) {
      await session.click(frame.x + 行末.行末框.x + 6, frame.y + 行末.行末框.y + Math.round(行末.行末框.h / 2));
      await sleep(450);
      await show('② 点源码行末后');
      await session.key({key: 'Enter', code: 'Enter', vk: 13});
      await sleep(500);
      await show('③ Enter 后');
      const 框2 = await session.js(`(() => { const w = ${IF}; const d = w.document; ${boxOf}
        const blk = [...d.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(n => String(n.textContent).includes(${JSON.stringify(NEEDLE)}));
        const code = blk.querySelector('code[data-type="math-block"]') || blk.querySelector('pre');
        const tn = code ? [...code.childNodes].find(n => n.nodeType === 3 && n.data.includes(${JSON.stringify(NEEDLE)})) : null;
        const rects = code ? [...code.getClientRects()].map(box) : [];
        const 行框 = tn ? (() => { const r = d.createRange(); const i = tn.data.indexOf(${JSON.stringify(NEEDLE)}) + ${JSON.stringify(NEEDLE)}.length;
          r.setStart(tn, i); r.setEnd(tn, i); return box(r.getBoundingClientRect()); })() : null;
        return {源码框: code ? box(code.getBoundingClientRect()) : null, 行矩形们: rects, 行框, 块框: box(blk.getBoundingClientRect())}; })()`);
      console.log('\n【④ 前的行几何】' + JSON.stringify(框2));
      const 行 = 框2.行框 || (框2.行矩形们[0] || null);
      if (行) {
        for (const dy of [3, 8, 13]) {
          const x = frame.x + Math.round(行.x + 120);
          const y = frame.y + 行.y + 行.h + dy;
          await session.click(x, y);
          await sleep(430);
          const S = await session.js(状态);
          console.log(`\n④ 点(${x - frame.x},${y - frame.y})（行底 +${dy}）：光标=${JSON.stringify(S.光标)}`);
          console.log('   合成：' + JSON.stringify(S.合成) + ' 计数=' + S.合成计数 + ' 展开=' + S.展开);
          await session.shot('点-底+' + dy);
        }
      }
    }
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 3)));
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
