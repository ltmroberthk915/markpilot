/** 定点查"合成线几何"：在"目标…"那段（段末长行内公式、预览折成两行）附近点选/回车/方向键，
 *  每次动作后 dump `__caretProxyLog`（画线日记：落点链、偏移、前/后兄弟、块框、行高、算出的位）。
 *  目的：找出"画在正文左边缘之外（x 比 块框.left 还小）"的那种几何是怎么来的。
 *  用法：node scripts/acceptance/probe-repro-twocaret-geom.cjs [--app=dev|installed|<exe>]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-twocaret-geom');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;
const NEEDLE = '(16,4),(15,6)';
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');

/** 目标段的几何：段落框、每条行盒、最后一个行内公式节点与其预览的矩形。 */
const 段几何 = `(() => { const w = ${IF}; const d = w.document;
  const box = r => r ? {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} : null;
  const ps = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')];
  const p = ps.find(x => String(x.textContent).includes('1w')) || ps[2];
  const 行盒 = [...p.getClientRects()].map(box);
  const 公式们 = [...p.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')].map(n => ({整体: box(n.getBoundingClientRect()),
    预览: n.querySelector('.vditor-ir__preview') ? box(n.querySelector('.vditor-ir__preview').getBoundingClientRect()) : null,
    预览行盒: n.querySelector('.vditor-ir__preview') ? [...n.querySelector('.vditor-ir__preview').getClientRects()].map(box) : null,
    末段: String(n.textContent).slice(-10)}));
  const 子节点 = [...p.childNodes].map(n => n.nodeName + (n.nodeType === 3 ? '("' + String(n.data).slice(0, 10) + '")' : ''));
  return {段框: box(p.getBoundingClientRect()), 行盒, 公式们, 子节点, 索引: ps.indexOf(p), 视口高: w.innerHeight}; })()`;

const 取日记 = `(() => { const w = ${IF}; const log = w.__caretProxyLog || [];
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const 链 = at ? (() => { const out = []; let cur = at.startContainer;
    while (cur && out.length < 4) { out.push(cur.nodeName + (cur.getAttribute && cur.getAttribute('data-type') ? '[' + cur.getAttribute('data-type') + ']' : '') + (cur.nodeType === 3 ? '(len' + String(cur.data).length + ')' : '')); cur = cur.parentNode; } return out.join('<'); })() : null;
  const bar = w.document.querySelector('[data-typora-caret-proxy]');
  const rb = bar ? bar.getBoundingClientRect() : null;
  return {光标: at ? [链, at.startOffset, (() => { const b = at.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; })()] : null,
    线: rb ? [bar.style.display, [Math.round(rb.left), Math.round(rb.top), Math.round(rb.width), Math.round(rb.height)]] : null,
    日记: log.slice(-6)}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'real-copy.md');
  fs.copyFileSync(SOURCE, doc);
  const exe = APP === 'dev' ? path.join(project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? path.join(process.env.LOCALAPPDATA || 'D:/Users/ltmroberthk/AppData/Local', 'Programs/markpilot/MarkPilot.exe') : APP;
  const session = await harness.launch({
    exe, appArgs: APP === 'dev' ? [path.join(project, 'app/main/main.js')] : [],
    label: 'probe-twocaret-geom', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  const 报 = async (标签) => { await sleep(800); const r = await session.js(取日记);
    const 线 = r.线 && r.线[0] !== 'none' ? r.线[1] : null;
    console.log('\n--- ' + 标签 + ' ---');
    console.log('  光标：' + JSON.stringify(r.光标) + (线 ? '   线：' + JSON.stringify(线) : ''));
    for (const e of r.日记) console.log('  日记：' + JSON.stringify(e)); };
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2500);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    // 滚到"目标…"那段
    for (let i = 0; i < 10; i++) {
      const r = await session.js(`(() => { const w = ${IF}; const d = w.document;
        const ps = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')];
        const p = ps.find(x => String(x.textContent).includes('1w'));
        if (!p) return {没段落: true};
        const b = p.getBoundingClientRect(); const 视口高 = w.innerHeight;
        if (b.top >= 120 && b.bottom <= 视口高 - 200) return {好了: true};
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
    let G = await session.js(段几何);
    console.log('段几何：' + JSON.stringify(G, null, 1));
    const 末行 = G.行盒[G.行盒.length - 1];
    await session.shot('00-静态');

    // 点选矩阵：段末行（"1w大型…"那行）的右侧、行尾、行下、以及段末行内公式上
    const 点 = [
      ['末行行尾右 6px', 末行.x + 末行.w - 6, 末行.y + Math.round(末行.h / 2)],
      ['末行行尾右 40px', 末行.x + 末行.w + 40, 末行.y + Math.round(末行.h / 2)],
      ['末行行尾下 6px', 末行.x + 末行.w - 6, 末行.y + 末行.h + 6],
      ['末行行尾下 16px', 末行.x + 末行.w - 6, 末行.y + 末行.h + 16],
      ['末行行首 x+2', 末行.x + 2, 末行.y + Math.round(末行.h / 2)],
      ['段右空白 末行行中', 末行.x + 末行.w + 120, 末行.y + Math.round(末行.h / 2)],
    ];
    for (const [名, x, y] of 点) {
      await session.js(`(() => { const w = ${IF}; w.__caretProxyLog = []; return 1; })()`);
      await session.click(frame.x + Math.round(x), frame.y + Math.round(y));
      await 报(名 + `（${Math.round(x)},${Math.round(y)}）`);
    }
    // 键盘：段末 → End/→/Home，看合成线是否参与
    for (const [名, 键] of [['End', 'End'], ['ArrowRight', 'ArrowRight'], ['ArrowLeft', 'ArrowLeft']]) {
      await session.js(`(() => { const w = ${IF}; w.__caretProxyLog = []; return 1; })()`);
      await session.key({key: 键, code: 键, vk: 键 === 'End' ? 35 : 键 === 'ArrowRight' ? 39 : 37});
      await 报('按键 ' + 名);
    }
    // Enter 在段末行尾 → 建下一段 → 再点新段
    await session.js(`(() => { const w = ${IF}; w.__caretProxyLog = []; return 1; })()`);
    await session.key({key: 'Enter', code: 'Enter', vk: 13});
    await 报('段末 Enter');
    const G2 = await session.js(段几何);
    console.log('Enter 后段几何：' + JSON.stringify({段框: G2.段框, 行盒: G2.行盒, 子节点: G2.子节点}));
    await session.shot('01-Enter后');
    for (const [名, x, y] of [['新空行 左', G2.段框.x + 20, G2.段框.y + G2.段框.h + 10],
      ['新空行 右', G2.段框.x + 500, G2.段框.y + G2.段框.h + 10]]) {
      await session.js(`(() => { const w = ${IF}; w.__caretProxyLog = []; return 1; })()`);
      await session.click(frame.x + Math.round(x), frame.y + Math.round(y));
      await 报(名 + `（${Math.round(x)},${Math.round(y)}）`);
    }
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 3)));
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
