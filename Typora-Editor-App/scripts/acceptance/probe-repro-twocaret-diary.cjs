/** 抓"合成线画到哪儿去了"的现行：真文档（doc A 副本）上把用户描述的几种手势都走一遍，
 *  每次动作后把 `window.__caretProxyLog`（合成线的画/收日记，含落点链、偏移、前/后兄弟、块框、行高）打出来。
 *  用法：node scripts/acceptance/probe-repro-twocaret-diary.cjs [--app=dev|installed|<exe>]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-twocaret-diary');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;
const NEEDLE = '(16,4),(15,6)';
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');

const 几何 = (session) => session.js(`(() => { const w = ${IF}; const d = w.document;
  const box = r => r ? {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} : null;
  const blk = [...d.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(n => String(n.textContent).includes(${JSON.stringify(NEEDLE)}));
  const code = blk ? blk.querySelector('code[data-type="math-block"]') : null;
  return {展开: blk ? blk.classList.contains('vditor-ir__node--expand') : null, 块框: blk ? box(blk.getBoundingClientRect()) : null,
    源码框: code ? box(code.getBoundingClientRect()) : null,
    预览框: blk && blk.querySelector('.vditor-ir__preview') ? box(blk.querySelector('.vditor-ir__preview').getBoundingClientRect()) : null,
    上一块: blk && blk.previousElementSibling ? blk.previousElementSibling.tagName + JSON.stringify(box(blk.previousElementSibling.getBoundingClientRect())) : null,
    下一块: blk && blk.nextElementSibling ? blk.nextElementSibling.tagName + JSON.stringify(box(blk.nextElementSibling.getBoundingClientRect())) : null,
    视口高: w.innerHeight}; })()`);

const 取日记 = (session) => session.js(`(() => { const w = ${IF}; const log = w.__caretProxyLog || [];
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  return {日记: log.slice(-10), 当前光标: at ? {链: (() => { const out = []; let cur = at.startContainer;
      while (cur && out.length < 4) { out.push(cur.nodeName + (cur.getAttribute && cur.getAttribute('data-type') ? '[' + cur.getAttribute('data-type') + ']' : '') + (cur.nodeType === 3 ? '(len' + String(cur.data).length + ')' : '')); cur = cur.parentNode; } return out.join('<'); })(),
    偏移: at.startOffset, rect: (() => { const b = at.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; })()} : null,
    采样时线: (() => { const bar = w.document.querySelector('[data-typora-caret-proxy]'); if (!bar) return null;
      const b = bar.getBoundingClientRect(); return [bar.style.display, [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]]; })()}; })()`);

const 清日记 = (session) => session.js(`(() => { const w = ${IF}; w.__caretProxyLog = []; return 1; })()`);

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'real-copy.md');
  fs.copyFileSync(SOURCE, doc);
  const exe = APP === 'dev' ? path.join(project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? path.join(process.env.LOCALAPPDATA || 'D:/Users/ltmroberthk/AppData/Local', 'Programs/markpilot/MarkPilot.exe') : APP;
  const session = await harness.launch({
    exe, appArgs: APP === 'dev' ? [path.join(project, 'app/main/main.js')] : [],
    label: 'probe-twocaret-diary', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  const 报 = async (标签) => {
    await sleep(900);
    const r = await 取日记(session);
    console.log('\n=== ' + 标签 + ' ===');
    console.log('  当前光标：' + JSON.stringify(r.当前光标));
    console.log('  线：' + JSON.stringify(r.采样时线));
    for (const e of r.日记) console.log('  日记：' + JSON.stringify(e));
  };
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2500);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    for (let i = 0; i < 10; i++) {
      const r = await session.js(`(() => { const w = ${IF}; const d = w.document;
        const blk = [...d.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(n => String(n.textContent).includes(${JSON.stringify(NEEDLE)}));
        const b = blk.getBoundingClientRect(); const 视口高 = w.innerHeight;
        if (b.top >= 120 && b.bottom <= 视口高 - 120) return {好了: true};
        const 点y = b.top > 视口高 / 2 ? Math.min(视口高 - 20, 视口高 - 60) : 60;
        const el = d.elementFromPoint(500, 点y);
        const 锚 = el && el.closest ? (el.closest('p,li,h1,h2,h3,h4,h5,h6,.vditor-ir__node,blockquote,tr') || el) : null;
        if (!锚) return {没锚: true};
        锚.scrollIntoView({block: b.top > 视口高 / 2 ? 'end' : 'start'});
        return {迭代: ${i}, 块top: Math.round(b.top)}; })()`);
      if (r.好了 || r.没锚) { console.log('滚动：' + JSON.stringify(r)); break; }
      await sleep(260);
    }
    await sleep(400);
    let G = await 几何(session);
    console.log('iframe=' + JSON.stringify(frame) + '\n几何：' + JSON.stringify(G, null, 1));

    // 手势 A：折叠态点块下方空白带（用户"行右下方一点"）
    for (const [dx, dy] of [[120, 6], [400, 6], [700, 6], [400, 20], [400, 34]]) {
      await 清日记(session);
      const x = frame.x + G.块框.x + dx, y = frame.y + G.预览框.y + G.预览框.h + dy;
      if (y - frame.y > G.视口高 - 10) continue;
      await session.click(x, y);
      await 报(`A 点空白带 dx=${dx} dy=${dy}（${x - frame.x},${y - frame.y}）`);
      await session.shot(`A-${dx}-${dy}`);
      const G2 = await 几何(session);
      if (G2.展开 !== G.展开) G = G2;
    }

    // 手势 B：点块预览展开 → 点源码行末 → Enter（用户说的"先建立下一行"）→ 再点该行右下方
    await 清日记(session);
    G = await 几何(session);
    await session.click(frame.x + G.块框.x + 150, frame.y + G.块框.y + Math.round(G.块框.h / 2));
    await 报('B1 点块预览（展开）');
    G = await 几何(session);
    const 行 = G.源码框;
    await session.click(frame.x + 行.x + Math.min(行.w - 20, 600), frame.y + 行.y + Math.round(行.h / 2));
    await 报('B2 点源码行末');
    await session.key({key: 'Enter', code: 'Enter', vk: 13});
    await 报('B3 Enter 建下一行');
    G = await 几何(session);
    const 底 = G.源码框.y + G.源码框.h;
    for (const [dx, dy] of [[150, 3], [150, 12], [600, 3], [600, 12]]) {
      await 清日记(session);
      const x = frame.x + G.块框.x + dx, y = frame.y + 底 + dy;
      await session.click(x, y);
      await 报(`B4 点源码行底 +${dy} dx=${dx}（${x - frame.x},${y - frame.y}）`);
      await session.shot(`B4-${dx}-${dy}`);
    }
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 3)));
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
