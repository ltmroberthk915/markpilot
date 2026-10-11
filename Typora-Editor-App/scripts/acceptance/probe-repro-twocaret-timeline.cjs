/** 时间线探针：`$$` 块展开 + 源码行末 + Enter + 点"行右下方一点"，每次动作后按 60ms 采样 3 秒，
 *  打印"原生 caret 矩形 / 我们的合成线 / 合成计数 / 块是否在重渲染"的**变化点**。
 *  目的：判断用户看到的"第二根线"是不是我们的合成线**残留**（原生 caret 变可见后没人把它收掉）。
 *  用法：node scripts/acceptance/probe-repro-twocaret-timeline.cjs [--app=dev|installed|<exe>]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-twocaret-timeline');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;
const NEEDLE = '(16,4),(15,6)';
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');

/** 一次采样：原生 caret、合成线、计数、块态。 */
const 采样 = `(() => { const w = ${IF}; const d = w.document;
  const box = r => r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null;
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const bar = d.querySelector('[data-typora-caret-proxy]');
  const blk = [...d.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(n => String(n.textContent).includes(${JSON.stringify(NEEDLE)}));
  const code = blk ? blk.querySelector('code[data-type="math-block"]') : null;
  const 光标链 = at ? (() => { const out = []; let cur = at.startContainer;
    while (cur && out.length < 3) { out.push(cur.nodeName + (cur.getAttribute && cur.getAttribute('data-type') ? '[dt=' + cur.getAttribute('data-type') + ']' : '')
      + (cur.nodeType === 3 ? '(len' + cur.data.length + ')' : '')); cur = cur.parentNode; } return out.join('<'); })() : null;
  return {光标: at ? [光标链, at.startOffset, at.startContainer.nodeType === 3 ? 3 : 1, box(at.getBoundingClientRect())] : null,
    线: bar ? [bar.style.display, box(bar.getBoundingClientRect())] : null, 计数: w.__caretProxyShown || 0,
    块: blk ? [blk.classList.contains('vditor-ir__node--expand') ? 1 : 0, code ? box(code.getBoundingClientRect()) : null] : null,
    焦点: d.hasFocus()}; })()`;

const 采样串 = (() => { const s = JSON.stringify(采样); return s.slice(1, -1); })();

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
    label: 'probe-twocaret-timeline', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  const 记录 = (标签, 序列) => {
    let 上 = null;
    console.log('\n--- ' + 标签 + ' ---');
    for (const [t, s] of 序列) {
      const key = JSON.stringify(s);
      if (key === 上) continue;
      上 = key;
      console.log(`  +${t}ms ` + JSON.stringify(s));
    }
  };
  const 采样3秒 = async (标签) => {
    const 序列 = [];
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) {
      序列.push([Date.now() - t0, await session.js(采样)]);
      await sleep(60);
    }
    记录(标签, 序列);
    return 序列;
  };
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2500);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    const 几何 = async () => session.js(`(() => { const w = ${IF}; const d = w.document;
      const box = r => r ? {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} : null;
      const blk = [...d.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(n => String(n.textContent).includes(${JSON.stringify(NEEDLE)}));
      const code = blk.querySelector('code[data-type="math-block"]');
      const tn = code ? [...code.childNodes].find(n => n.nodeType === 3 && n.data.includes(${JSON.stringify(NEEDLE)})) : null;
      const 行框 = tn ? (() => { const r = d.createRange(); const i = tn.data.indexOf(${JSON.stringify(NEEDLE)}) + ${JSON.stringify(NEEDLE)}.length;
        r.setStart(tn, i); r.setEnd(tn, i); return box(r.getBoundingClientRect()); })() : null;
      return {块框: box(blk.getBoundingClientRect()), 源码框: box(code.getBoundingClientRect()),
        预览框: box((blk.querySelector('.vditor-ir__preview') || {getBoundingClientRect: () => null}).getBoundingClientRect()),
        行框, 展开: blk.classList.contains('vditor-ir__node--expand')}; })()`);

    // ① 点预览中心 → 展开
    let G = await 几何();
    await session.click(frame.x + G.块框.x + 120, frame.y + G.块框.y + Math.round(G.块框.h / 2));
    await sleep(500);
    G = await 几何();
    console.log('① 展开后几何：' + JSON.stringify(G));

    // ② 点源码首行末尾
    await session.click(frame.x + G.行框.x + 6, frame.y + G.行框.y + Math.round(G.行框.h / 2));
    await 采样3秒('② 点源码行末（3 秒）');

    // ③ Enter（用户说的前提）
    await session.key({key: 'Enter', code: 'Enter', vk: 13});
    await 采样3秒('③ Enter 后（3 秒）');

    // ④ 点"该行右下方一点、未到下一行"
    G = await 几何();
    const 行 = G.行框;
    for (const dy of [3, 8, 13]) {
      const x = frame.x + Math.round(行.x + 120);
      const y = frame.y + 行.y + 行.h + dy;
      await session.click(x, y);
      await 采样3秒(`④ 点行底 +${dy}（${x - frame.x},${y - frame.y}）`);
    }
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 3)));
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
