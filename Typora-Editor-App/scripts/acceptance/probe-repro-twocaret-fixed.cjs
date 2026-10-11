/** 合成光标几何修复的定点验收（截图为准）：同一串手势跑两遍——`--app=installed`（旧 2.2.8）
 *  与 `--app=dev`（修复版），把"原生 caret / 我们的线 / 各自位置"打出来并截 2 倍放大图。
 *  图上标记：红实线＝原生 caret 矩形；青实线＝我们的线；琥珀虚线＝块框；青虚线＝源码框。
 *  用法：node scripts/acceptance/probe-repro-twocaret-fixed.cjs [--app=dev|installed|<exe>]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-twocaret-fixed');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;
const NEEDLE = '(16,4),(15,6)';
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');
const TAG = APP === 'dev' ? 'dev' : APP === 'installed' ? 'installed' : 'other';

const 读数 = `(() => { const w = ${IF}; const d = w.document;
  const box = r => r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null;
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const bar = d.querySelector('[data-typora-caret-proxy]');
  const blk = [...d.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(n => String(n.textContent).includes(${JSON.stringify(NEEDLE)}));
  return {光标: at ? [(at.startContainer.nodeType === 3 ? '#text(len' + String(at.startContainer.data).length + ')' : at.startContainer.nodeName),
      at.startOffset, box(at.getBoundingClientRect())] : null,
    线: bar ? [bar.style.display, box(bar.getBoundingClientRect())] : null,
    日记: (w.__caretProxyLog || []).slice(-1),
    块框: blk ? box(blk.getBoundingClientRect()) : null,
    块内文本清单: (() => { const sel2 = w.getSelection(); if (!sel2 || !sel2.rangeCount) return null;
      const n0 = sel2.getRangeAt(0).startContainer;
      const el = n0.nodeType === 3 ? n0.parentElement : n0;
      const b = el && el.closest ? el.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th') : null;
      if (!b) return null;
      const out = []; const walker = d.createTreeWalker(b, NodeFilter.SHOW_TEXT, null);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const r = d.createRange(); r.setStart(t, t.length > 0 ? t.length - 1 : 0); r.setEnd(t, t.length);
        const rb = r.getBoundingClientRect();
        const pe = t.parentElement; const pb = pe ? pe.getBoundingClientRect() : null;
        out.push({文本: String(t.data).slice(0, 14), 长: t.length, 父: pe ? pe.nodeName + '.' + String(pe.className || '').slice(0, 16) : null,
          可见: !!(pb && pb.width > 0 && pb.height > 0), 末字: [Math.round(rb.left), Math.round(rb.top), Math.round(rb.right), Math.round(rb.height)]});
      }
      return out.slice(-8); })(),
    锚诊断: (() => { const sel2 = w.getSelection(); if (!sel2 || !sel2.rangeCount) return null;
      const at2 = sel2.getRangeAt(0); const n = at2.startContainer; const off = at2.startOffset;
      const el = n.nodeType === 3 ? n.parentElement : n;
      const 面 = d.querySelector('.vditor-reset');
      let blk = el && el.closest ? el.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th') : null;
      if (!blk || blk === 面) blk = (el && el.closest ? el.closest('.vditor-ir__node') : null) || el;
      if (!blk) return {没有块: true};
      const len = n.nodeType === 3 ? n.length : n.childNodes.length;
      const 偏 = Math.min(Math.max(off | 0, 0), len);
      const 取 = (r, 后) => { let rs = []; try { rs = [...r.getClientRects()]; } catch (e) { return {错: String(e)}; }
        if (后) { for (let i = rs.length - 1; i >= 0; i--) if (rs[i].height > 0) return [Math.round(rs[i].right), Math.round(rs[i].top), Math.round(rs[i].height)]; }
        else for (const b of rs) if (b.height > 0) return [Math.round(b.left), Math.round(b.top), Math.round(b.height)];
        return {无行盒: rs.length}; };
      const r1 = d.createRange(); let 前 = null;
      try { r1.setStart(blk, 0); r1.setEnd(n, 偏); 前 = 取(r1, true); } catch (e) { 前 = {错: String(e)}; }
      const r2 = d.createRange(); let 后v = null;
      try { r2.setStart(n, 偏); r2.setEnd(blk, blk.childNodes.length); 后v = 取(r2, false); } catch (e) { 后v = {错: String(e)}; }
      const bb = blk.getBoundingClientRect();
      return {块: blk.nodeName + '.' + String(blk.className || '').slice(0, 18), 块框: [Math.round(bb.left), Math.round(bb.top), Math.round(bb.right), Math.round(bb.bottom)],
        偏移原: off, 偏移夹: 偏, 前, 后: 后v}; })(),
    视野: [Math.round(w.innerHeight)]}; })()`;

const 画标记 = S => `(() => { const w = ${IF}; const d = w.document;
  const old = d.getElementById('__cal'); if (old) old.remove();
  const layer = d.createElement('div'); layer.id = '__cal';
  layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
  const add = css => { const el = d.createElement('div'); el.style.cssText = 'position:fixed;pointer-events:none;' + css; layer.appendChild(el); };
  const 光标 = ${JSON.stringify(S.光标 ? S.光标[2] : null)};
  if (光标) add('left:' + 光标[0] + 'px;top:' + 光标[1] + 'px;width:1px;height:' + 光标[3] + 'px;background:#ff2d2d;');
  const 线 = ${JSON.stringify(S.线 && S.线[0] !== 'none' ? S.线[1] : null)};
  if (线) add('left:' + (线[0] - 3) + 'px;top:' + 线[1] + 'px;width:2px;height:' + 线[3] + 'px;background:#2dd4ff;');
  const 块框 = ${JSON.stringify(S.块框)};
  if (块框) add('left:' + 块框[0] + 'px;top:' + 块框[1] + 'px;width:' + 块框[2] + 'px;height:' + 块框[3] + 'px;border:1px dashed #ffb020;box-sizing:border-box;');
  d.body.appendChild(layer); return 1; })()`;

(async () => {
  const 目录 = path.join(OUT, TAG);
  fs.rmSync(目录, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(目录, {recursive: true});
  const doc = path.join(目录, 'real-copy.md');
  fs.copyFileSync(SOURCE, doc);
  const exe = APP === 'dev' ? path.join(project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? path.join(process.env.LOCALAPPDATA || 'D:/Users/ltmroberthk/AppData/Local', 'Programs/markpilot/MarkPilot.exe') : APP;
  const session = await harness.launch({
    exe, appArgs: APP === 'dev' ? [path.join(project, 'app/main/main.js')] : [],
    label: 'probe-twocaret-fixed-' + TAG, outDir: 目录, args: [doc], timeout: 300000, inspect: false,
  });
  const 拍 = async (名, frame, 裁剪) => {
    const S = await session.js(读数);
    await session.js(画标记(S));
    const png = await session.send('Page.captureScreenshot', {format: 'png',
      clip: {x: frame.x + 裁剪[0], y: frame.y + 裁剪[1], width: 裁剪[2], height: 裁剪[3], scale: 2}});
    const file = path.join(目录, 名 + '.png');
    fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
    await session.js(`(() => { const w = ${IF}; const old = w.document.getElementById('__cal'); if (old) old.remove(); return 1; })()`);
    const 线 = S.线 && S.线[0] !== 'none' ? S.线[1] : null;
    if (S.块内文本清单) for (const t of S.块内文本清单) console.log(`     文本 ${JSON.stringify(t)}`);
    if (S.锚诊断) console.log('     锚诊断 ' + JSON.stringify(S.锚诊断));
    console.log(`  [${名}] 光标=${JSON.stringify(S.光标)} 线=${JSON.stringify(线)}${S.日记 && S.日记[0] ? ' 日记=' + JSON.stringify(S.日记[0].明细 || S.日记[0]) : ''}`);
    return file;
  };
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2500);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    console.log('app=' + TAG + ' iframe=' + JSON.stringify(frame));
    // 滚到"目标…"那段
    for (let i = 0; i < 10; i++) {
      const r = await session.js(`(() => { const w = ${IF}; const d = w.document;
        const ps = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')];
        const p = ps.find(x => String(x.textContent).includes('1w'));
        if (!p) return {没段落: true};
        const b = p.getBoundingClientRect(); const 视口高 = w.innerHeight;
        if (b.top >= 120 && b.bottom <= 视口高 - 260) return {好了: true};
        const 点y = b.top > 视口高 / 2 ? Math.min(视口高 - 20, 视口高 - 60) : 60;
        const el = d.elementFromPoint(500, 点y);
        const 锚 = el && el.closest ? (el.closest('p,li,h1,h2,h3,h4,h5,h6,.vditor-ir__node,blockquote,tr') || el) : null;
        if (!锚) return {没锚: true};
        锚.scrollIntoView({block: b.top > 视口高 / 2 ? 'end' : 'start'});
        return {迭代: ${i}, 段top: Math.round(b.top)}; })()`);
      if (r.好了 || r.没锚 || r.没段落) { console.log('滚动：' + JSON.stringify(r)); break; }
      await sleep(260);
    }
    await sleep(400);
    const G = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const box = r => r ? {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} : null;
      const ps = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')];
      const p = ps.find(x => String(x.textContent).includes('1w'));
      const blk = [...d.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(n => String(n.textContent).includes(${JSON.stringify(NEEDLE)}));
      return {段: box(p.getBoundingClientRect()), 块: box(blk.getBoundingClientRect()),
        预览: box(blk.querySelector('.vditor-ir__preview').getBoundingClientRect())}; })()`);
    console.log('几何：' + JSON.stringify(G));
    const 裁剪 = [0, Math.max(0, G.段.y - 40), Math.min(frame.w, 900), 260];

    // ① 段落末行右侧点一下（旧版会把合成线画到上一行行尾）
    await session.js(`(() => { const w = ${IF}; w.__caretProxyLog = []; return 1; })()`);
    await session.click(frame.x + G.段.x + G.段.w - 6, frame.y + G.段.y + G.段.h - 20);
    await sleep(700);
    await 拍('①段落末行右侧', frame, 裁剪);
    await sleep(2400);
    const 后 = await session.js(读数);
    console.log('  [①+3s] 线=' + JSON.stringify(后.线 && 后.线[0] !== 'none' ? 后.线[1] : null) + ' 光标=' + JSON.stringify(后.光标));
    await 拍('①段落末行右侧-3秒后', frame, 裁剪);

    // ② 折叠块：点公式下方空白带（用户动作）
    await session.js(`(() => { const w = ${IF}; w.__caretProxyLog = []; return 1; })()`);
    await session.click(frame.x + G.块.x + 600, frame.y + G.预览.y + G.预览.h + 8);
    await sleep(700);
    await 拍('②块下空白带', frame, 裁剪);

    // ③ 块上点开 → 源码行末 → Enter 建空行 → 点该行右下方
    await session.js(`(() => { const w = ${IF}; w.__caretProxyLog = []; return 1; })()`);
    await session.click(frame.x + G.块.x + 150, frame.y + G.块.y + Math.round(G.块.h / 2));
    await sleep(600);
    await 拍('③a点开块', frame, 裁剪);
    const G2 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const box = r => r ? {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} : null;
      const blk = [...d.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(n => String(n.textContent).includes(${JSON.stringify(NEEDLE)}));
      const code = blk.querySelector('code[data-type="math-block"]');
      return {源码: box(code.getBoundingClientRect()), 源码行: [...code.getClientRects()].map(box)}; })()`);
    await session.click(frame.x + G2.源码.x + Math.min(G2.源码.w - 20, 600), frame.y + G2.源码.y + Math.round(G2.源码.h / 2));
    await sleep(500);
    await session.key({key: 'Enter', code: 'Enter', vk: 13});
    await sleep(600);
    await session.js(`(() => { const w = ${IF}; w.__caretProxyLog = []; return 1; })()`);
    for (const dy of [3, 10]) {
      await session.click(frame.x + G2.源码.x + 600, frame.y + G2.源码.y + G2.源码.h + dy);
      await sleep(650);
      await 拍('③b点源码行底+' + dy, frame, 裁剪);
    }
    // ④ 在块后面建一个空段落，点它（"两个光标"的另一种可能来源）
    await session.js(`(() => { const w = ${IF}; w.__caretProxyLog = []; return 1; })()`);
    await session.click(frame.x + G.块.x + 300, frame.y + G.块.y + G.块.h + 6);
    await sleep(600);
    await 拍('④块下空行', frame, 裁剪);
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 2)));
    console.log('输出目录：' + 目录);
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
