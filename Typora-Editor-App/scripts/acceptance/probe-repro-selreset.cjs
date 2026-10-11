/** 遗留 #3 定点追捕：点一个正文位置，连按 shift+→（可再 shift+←），每一步打
 *  "选区长度 / 两端点层 / 是否塌陷 / 这一拍的 Selection 写入口（带栈）"。
 *  目的：看清"选区在哪一步、被谁重置/不增长"。
 *  用法：node scripts/acceptance/probe-repro-selreset.cjs [--app=dev|installed|<exe>] [--doc=a|b] [--x=200] [--y=300] [--presses=8]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-selreset');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const DOCS = {a: path.join(DIR, '新建 Markdown 文档-副本.md'), b: path.join(DIR, '1-重识概率论.md')};
const IF = `document.getElementById('editor').contentWindow`;
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');
const 文档 = ARG('doc', 'b');

const 装埋点 = `(() => {
  if (window.__selTrace) { window.__selTrace.acts.length = 0; window.__selTrace.log.length = 0; return 'reuse'; }
  const trace = window.__selTrace = {acts: [], log: [], t0: performance.now()};
  const 名 = node => { if (!node) return 'null';
    if (node.nodeType === 3) return '#' + String(node.data).slice(0, 10);
    const cls = (typeof node.className === 'string' ? node.className : '').split(' ').filter(Boolean).slice(0, 2).join('.');
    return node.nodeName + (cls ? '.' + cls : '') + (node.getAttribute && node.getAttribute('data-type') ? '[' + node.getAttribute('data-type') + ']' : ''); };
  for (const method of ['removeAllRanges', 'addRange', 'setBaseAndExtent', 'collapse', 'extend']) {
    const orig = window.Selection.prototype[method];
    if (typeof orig !== 'function') continue;
    window.Selection.prototype[method] = function (...args) {
      let stack = '';
      try { stack = String(new Error().stack).split('\\n').slice(1, 4).map(line => line.trim().replace(/^at\\s+/, '')).join(' | ').slice(0, 220); } catch {}
      trace.acts.push({t: Math.round(performance.now() - trace.t0), m: method,
        args: args.map(a => (a && a.nodeType ? 名(a) : String(a).slice(0, 20))), stack});
      return orig.apply(this, args);
    };
  }
  window.document.addEventListener('selectionchange', () => {
    const s = window.getSelection(); const r = s && s.rangeCount ? s.getRangeAt(0) : null;
    trace.log.push({t: Math.round(performance.now() - trace.t0), 长度: r && !r.collapsed ? r.toString().length : 0});
  }, true);
  return 'installed'; })()`;

const 读数 = `(() => { const w = ${IF}; const d = w.document;
  const s = w.getSelection(); const r = s && s.rangeCount ? s.getRangeAt(0) : null;
  const 端 = (node, off) => { if (!node) return null;
    const el = node.nodeType === 3 ? node.parentElement : node;
    const 层 = el && el.closest ? (el.closest('.vditor-ir__preview') ? '预览' : el.closest('[data-type$="-marker"]') ? '围栏'
      : el.closest('code[data-type]') ? '源码' : '正文') : null;
    const 行 = el && el.closest ? el.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th') : null;
    return {层, 偏移: off, 行: 行 ? String(行.textContent || '').replace(/\\s+/g, ' ').slice(0, 14) : null}; };
  const box = b => b ? [Math.round(b.left), Math.round(b.top), Math.round(b.height)] : null;
  return {长度: r && !r.collapsed ? r.toString().length : 0, 折叠: r ? r.collapsed : null,
    起: r ? 端(r.startContainer, r.startOffset) : null, 终: r ? 端(r.endContainer, r.endOffset) : null,
    起框: r ? box((() => { const q = d.createRange(); q.setStart(r.startContainer, r.startOffset); q.collapse(true); return q.getBoundingClientRect(); })()) : null,
    终框: r ? box((() => { const q = d.createRange(); q.setStart(r.endContainer, r.endOffset); q.collapse(true); return q.getBoundingClientRect(); })()) : null,
    焦点: d.hasFocus()}; })()`;

const 取轨 = `(() => { const w = ${IF}; const t = w.__selTrace; return t ? {acts: t.acts.slice(0, 12), log: t.log.slice(0, 12)} : null; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'copy-' + 文档 + '.md');
  fs.copyFileSync(DOCS[文档], doc);
  const exe = APP === 'dev' ? path.join(project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe' : APP;
  const session = await harness.launch({
    exe, appArgs: APP === 'dev' ? [path.join(project, 'app/main/main.js')] : [],
    label: 'probe-selreset-' + APP.replace(/[^a-z]/gi, '').slice(0, 8), outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 240000, interval: 120});
    await sleep(2600);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    await session.js(`(() => { const w = ${IF}; return w.eval(${JSON.stringify(装埋点)}); })()`);
    // 找一个正文可点位置（避开公式/预览/表格）
    const 点 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const 视口高 = w.innerHeight;
      for (const y of [Number(${ARG('y', '300')}), Math.round(视口高 * 0.4), Math.round(视口高 * 0.5), Math.round(视口高 * 0.6)]) {
        for (const x of [Number(${ARG('x', '200')}), 120, 320, 420]) {
          const hit = d.caretRangeFromPoint(x, y);
          if (!hit) continue;
          const at = hit.startContainer.nodeType === 3 ? hit.startContainer.parentElement : hit.startContainer;
          if (!at || !at.closest) continue;
          if (at.closest('.vditor-ir__preview,[data-type$="-marker"],code[data-type],table,button')) continue;
          const rect = hit.getBoundingClientRect();
          if (!rect.height) continue;
          return {x, y, 文本: String(at.textContent || '').replace(/\\s+/g, ' ').slice(0, 16), 层: '正文'};
        }
      }
      return null; })()`);
    if (!点) { console.log('没找到可点正文位置'); return; }
    if (Number(ARG('scan', '0')) > 0) {
      // 扫描模式：网格点逐个试"shift+→ 连按 6 次"，把**不增长**（每按只选 1 字符）的起点找出来并抓写入口
      const 网格 = await session.js(`(() => { const w = ${IF}; const d = w.document;
        const out = []; const 视口高 = w.innerHeight;
        for (let y = 60; y < 视口高 - 80; y += 26) for (let x = 80; x < 820; x += 120) {
          const hit = d.caretRangeFromPoint(x, y);
          if (!hit) continue;
          const at = hit.startContainer.nodeType === 3 ? hit.startContainer.parentElement : hit.startContainer;
          if (!at || !at.closest || !at.closest('.vditor-ir .vditor-reset')) continue;
          const rect = hit.getBoundingClientRect();
          if (!rect.height) continue;
          const 层 = at.closest('.vditor-ir__preview') ? '预览' : at.closest('[data-type$="-marker"]') ? '围栏'
            : at.closest('code[data-type]') ? '源码' : at.closest('table') ? '表格' : '正文';
          out.push({x, y, 层, 文本: String(at.textContent || '').replace(/\s+/g, ' ').slice(0, 12)});
        }
        return out; })()`);
      let 试过 = 0, 差 = 0;
      for (const g of 网格) {
        if (试过 >= Number(ARG('scan', '0'))) break;
        试过 += 1;
        await session.click(frame.x + g.x, frame.y + g.y);
        await sleep(240);
        const 长 = [];
        for (let step = 0; step < 6; step++) {
          await session.key({key: 'ArrowRight', code: 'ArrowRight', vk: 39, modifiers: harness.MOD.shift});
          await sleep(150);
          长.push((await session.js(读数)).长度);
        }
        const 增长 = 长[长.length - 1] - 长[0];
        if (增长 <= 0) {
          差 += 1;
          console.log(`✗ 不增长 ${JSON.stringify(g)} 长度序列=${JSON.stringify(长)}`);
          await session.js(`(() => { const w = ${IF}; if (w.__selTrace) { w.__selTrace.acts.length = 0; w.__selTrace.log.length = 0; } return 1; })()`);
          for (let step = 0; step < 3; step++) {
            await session.key({key: 'ArrowRight', code: 'ArrowRight', vk: 39, modifiers: harness.MOD.shift});
            await sleep(160);
            const 轨 = await session.js(取轨);
            console.log('     写入口: ' + JSON.stringify(轨?.acts || []) + ' 时间线: ' + JSON.stringify(轨?.log || []));
          }
        } else if (差 < 3 && 试过 % 20 === 0) console.log(`✓ 增长 ${JSON.stringify(g)} 序列=${JSON.stringify(长)}`);
      }
      console.log('扫描结束：' + 试过 + ' 个起点，其中不增长 ' + 差 + ' 个');
      return;
    }
    console.log('文档=' + 文档 + ' app=' + APP + ' 起点=' + JSON.stringify(点));
    await session.click(frame.x + 点.x, frame.y + 点.y);
    await sleep(350);
    console.log('点击后：' + JSON.stringify(await session.js(读数)));
    for (const [相位, key, vk, mods] of [['右', 'ArrowRight', 39, harness.MOD.shift], ['左', 'ArrowLeft', 37, harness.MOD.shift]]) {
      for (let step = 1; step <= Number(ARG('presses', '8')); step++) {
        await session.js(`(() => { const w = ${IF}; if (w.__selTrace) { w.__selTrace.acts.length = 0; w.__selTrace.log.length = 0; } return 1; })()`);
        await session.key({key, code: key, vk, modifiers: mods});
        await sleep(160);
        const 读 = await session.js(读数);
        const 轨 = await session.js(取轨);
        console.log(` ${相位} 第 ${step} 次：长度=${读.长度} 折叠=${读.折叠} 起=${JSON.stringify(读.起)} 终=${JSON.stringify(读.终)} 焦点=${读.焦点}`);
        for (const a of (轨?.acts || [])) console.log('     写入: ' + JSON.stringify(a));
        console.log('     时间线: ' + JSON.stringify(轨?.log || []));
      }
    }
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 3)));
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
