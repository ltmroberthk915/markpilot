/** 两个报告的现场测量（doc A 副本）：
 *  ① "双重光标"：在我们的合成线画出来的位置上，**把我们的线藏起来再截图**——
 *     如果图里仍有光标，说明 Blink 其实画了 caret（我们看 `Range` 矩形以为它没画），我们就是重复画；
 *     同时读 `caretRangeFromPoint(点击点)`、落点链、偏移、是否在预览/围栏/源码里。
 *  ② "点已渲染的行内公式不展开、光标不精确"：点渲染出来的公式各处，看节点是否展开、光标落在哪一层。
 *  用法：node scripts/acceptance/probe-repro-caret-click.cjs [--app=dev|installed|<exe>]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-caret-click');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');

const 读数 = `(() => { const w = ${IF}; const d = w.document;
  const box = r => r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null;
  const 链 = node => { const out = []; let cur = node;
    while (cur && out.length < 5) { out.push(cur.nodeName + (cur.getAttribute && cur.getAttribute('data-type') ? '[' + cur.getAttribute('data-type') + ']' : '')
      + (cur.nodeType === 3 ? '(len' + String(cur.data).length + ')' : (typeof cur.className === 'string' && cur.className ? '.' + cur.className.split(' ')[0] : ''))); cur = cur.parentNode; }
    return out.join(' < '); };
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const bar = d.querySelector('[data-typora-caret-proxy]');
  const 层 = n => { if (!n) return null; const el = n.nodeType === 3 ? n.parentElement : n;
    return el && el.closest ? (el.closest('.vditor-ir__preview') ? '预览' : el.closest('[data-type$="-marker"]') ? '围栏'
      : el.closest('code[data-type]') ? '源码' : el.closest('.vditor-ir__node[data-type^="math"]') ? '公式节点' : '正文') : null; };
  return {光标: at ? {链: 链(at.startContainer), 偏移: at.startOffset, 层: 层(at.startContainer),
      rect: box((() => { const q = d.createRange(); q.setStart(at.startContainer, at.startOffset); q.collapse(true); return q.getBoundingClientRect(); })())} : null,
    选中: at ? at.toString().length : null,
    线: bar ? {显示: bar.style.display, rect: box(bar.getBoundingClientRect()), 色: w.getComputedStyle(bar).backgroundColor} : null,
    公式节点: [...d.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')].filter(n => {
      const r = n.getBoundingClientRect(); const 视口高 = w.innerHeight; return r.height > 0 && r.bottom > 0 && r.top < 视口高; })
      .slice(0, 3).map(n => ({展开: n.classList.contains('vditor-ir__node--expand'), rect: box(n.getBoundingClientRect()),
        文本: String(n.textContent).replace(/\\s+/g, ' ').slice(0, 20),
        预览: n.querySelector('.vditor-ir__preview') ? box(n.querySelector('.vditor-ir__preview').getBoundingClientRect()) : null,
        源码: n.querySelector('code[data-type="math-inline"]') ? box(n.querySelector('code[data-type="math-inline"]').getBoundingClientRect()) : null}))}; })()`;

const 查点 = (x, y) => `(() => { const w = ${IF}; const d = w.document;
  const hit = d.caretRangeFromPoint(${x}, ${y});
  if (!hit) return null;
  const 链 = node => { const out = []; let cur = node;
    while (cur && out.length < 4) { out.push(cur.nodeName + (cur.getAttribute && cur.getAttribute('data-type') ? '[' + cur.getAttribute('data-type') + ']' : '') + (cur.nodeType === 3 ? '(len' + String(cur.data).length + ')' : '')); cur = cur.parentNode; }
    return out.join(' < '); };
  const box = r => r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null;
  const el = hit.startContainer.nodeType === 3 ? hit.startContainer.parentElement : hit.startContainer;
  const 层 = el && el.closest ? (el.closest('.vditor-ir__preview') ? '预览' : el.closest('[data-type$="-marker"]') ? '围栏'
    : el.closest('code[data-type]') ? '源码' : el.closest('.vditor-ir__node[data-type^="math"]') ? '公式节点' : '正文') : null;
  return {链: 链(hit.startContainer), 偏移: hit.startOffset, 层, rect: box(hit.getBoundingClientRect())}; })()`;

const 藏线 = `(() => { const w = ${IF}; const d = w.document;
  let st = d.getElementById('__hidebar');
  if (!st) { st = d.createElement('style'); st.id = '__hidebar';
    st.textContent = '[data-typora-caret-proxy]{display:none !important}'; d.head.appendChild(st); }
  return 1; })()`;
const 显线 = `(() => { const w = ${IF}; const d = w.document;
  const st = d.getElementById('__hidebar'); if (st) st.remove(); return 1; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'copy.md');
  fs.copyFileSync(SOURCE, doc);
  const exe = APP === 'dev' ? path.join(project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe' : APP;
  const session = await harness.launch({
    exe, appArgs: APP === 'dev' ? [path.join(project, 'app/main/main.js')] : [],
    label: 'probe-caret-click', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  const 拍 = async (名, frame, clip) => {
    await session.js(显线);
    const png1 = await session.send('Page.captureScreenshot', {format: 'png', clip: {...clip, scale: 2}});
    fs.writeFileSync(path.join(OUT, 名 + '-有线.png'), Buffer.from(png1.data, 'base64'));
    await session.js(藏线);
    await sleep(60);
    const png2 = await session.send('Page.captureScreenshot', {format: 'png', clip: {...clip, scale: 2}});
    fs.writeFileSync(path.join(OUT, 名 + '-无线.png'), Buffer.from(png2.data, 'base64'));
    await session.js(显线);
    return 名;
  };
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 220000, interval: 120});
    await sleep(2500);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    console.log('app=' + APP + ' iframe=' + JSON.stringify(frame));

    // 滚到"政府计划投资 1500 万元…"那段（用户图一那段）
    for (let i = 0; i < 12; i++) {
      const r = await session.js(`(() => { const w = ${IF}; const d = w.document;
        const p = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(x => String(x.textContent).includes('政府计划投资'));
        if (!p) return {没段: true};
        const b = p.getBoundingClientRect(); const 视口高 = w.innerHeight;
        if (b.top >= 80 && b.bottom <= 视口高 - 240) return {好了: true, 段: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]};
        const 点y = b.top > 视口高 / 2 ? Math.min(视口高 - 20, 视口高 - 60) : 60;
        const el = d.elementFromPoint(400, 点y);
        const 锚 = el && el.closest ? (el.closest('p,li,h1,h2,h3,h4,h5,h6,.vditor-ir__node,blockquote,tr') || el) : null;
        if (!锚) return {没锚: true};
        锚.scrollIntoView({block: b.top > 视口高 / 2 ? 'end' : 'start'});
        return {迭代: ${i}, 段top: Math.round(b.top)}; })()`);
      if (r.好了 || r.没锚 || r.没段) { console.log('滚动：' + JSON.stringify(r)); break; }
      await sleep(250);
    }
    await sleep(300);
    const 段 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
      const p = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(x => String(x.textContent).includes('政府计划投资'));
      const tn = [...p.childNodes].find(n => n.nodeType === 3 && n.data.includes('考虑'));
      let 考虑框 = null;
      if (tn) { const i = tn.data.indexOf('考虑'); const r = d.createRange(); r.setStart(tn, i); r.setEnd(tn, i + 2); 考虑框 = box(r.getBoundingClientRect()); }
      return {段: box(p.getBoundingClientRect()), 考虑框, 行盒: [...p.getClientRects()].map(box)}; })()`);
    console.log('目标段：' + JSON.stringify(段));
    const clip = {x: frame.x + Math.max(0, 段.段.x - 20), y: frame.y + Math.max(20, 段.段.y - 40), width: Math.min(880, frame.w), height: 180};

    // ① 图一的位置：点 "考虑" 后面
    const 点1 = [段.考虑框.x + 段.考虑框.w + 2, 段.考虑框.y + Math.round(段.考虑框.h / 2)];
    await session.js(显线);
    await session.click(frame.x + 点1[0], frame.y + 点1[1]);
    await sleep(600);
    let S = await session.js(读数);
    console.log('\n① 点"考虑"右侧 (' + 点1 + ')：' + JSON.stringify(S));
    console.log('   该点 caretRangeFromPoint：' + JSON.stringify(await session.js(查点(点1[0], 点1[1]))));
    console.log('   截图：' + await 拍('01-考虑右侧', frame, clip));

    // ①b 点行尾（段落末尾，常见"隐形但可能真有 caret"的位置）
    const 行尾 = [段.行盒[段.行盒.length - 1].x + 段.行盒[段.行盒.length - 1].w - 8, 段.行盒[段.行盒.length - 1].y + 12];
    await session.click(frame.x + 行尾[0], frame.y + 行尾[1]);
    await sleep(600);
    S = await session.js(读数);
    console.log('\n①b 点行尾 (' + 行尾 + ')：' + JSON.stringify(S));
    console.log('   该点 caretRangeFromPoint：' + JSON.stringify(await session.js(查点(行尾[0], 行尾[1]))));
    console.log('   截图：' + await 拍('01b-行尾', frame, clip));

    // ② 行内公式：找段里那条 $33-1=32，33+8-1=40$（用户图二那种），点它的渲染区
    const 公式 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
      const p = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(x => String(x.textContent).includes('政府计划投资'));
      const 节点 = [...p.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
      const 目标 = 节点.find(n => String(n.textContent).includes('33-1') || String(n.textContent).includes('33-1')) || 节点[0];
      if (!目标) return {没公式: true, 数: 节点.length};
      const 预览 = 目标.querySelector('.vditor-ir__preview');
      return {展开: 目标.classList.contains('vditor-ir__node--expand'), 节点框: box(目标.getBoundingClientRect()),
        预览框: 预览 ? box(预览.getBoundingClientRect()) : null, 文本: String(目标.textContent).slice(0, 24), 共: 节点.length}; })()`);
    console.log('\n② 行内公式：' + JSON.stringify(公式));
    if (公式.预览框) {
      const 公式clip = {x: frame.x + Math.max(0, 公式.预览框.x - 60), y: frame.y + Math.max(20, 公式.预览框.y - 30), width: 520, height: 120};
      for (const 比例 of [0.15, 0.5, 0.85]) {
        const x = 公式.预览框.x + Math.round(公式.预览框.w * 比例);
        const y = 公式.预览框.y + Math.round(公式.预览框.h / 2);
        await session.js(显线);
        await session.click(frame.x + x, frame.y + y);
        await sleep(650);
        const S2 = await session.js(读数);
        const 公式2 = await session.js(`(() => { const w = ${IF}; const d = w.document;
          const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
          const p = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(x => String(x.textContent).includes('政府计划投资'));
          const 节点 = [...p.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
          const 展开们 = 节点.map((n, i) => ({i, 展开: n.classList.contains('vditor-ir__node--expand'),
            源码框: n.querySelector('code[data-type="math-inline"]') ? box(n.querySelector('code[data-type="math-inline"]').getBoundingClientRect()) : null}))
            .filter(x => x.展开);
          return {共: 节点.length, 展开的: 展开们}; })()`);
        console.log(`\n② 点公式左${Math.round(比例 * 100)}%（${x},${y}）：`);
        console.log('   光标：' + JSON.stringify(S2.光标) + '  线：' + JSON.stringify(S2.线));
        console.log('   公式状态：' + JSON.stringify(公式2));
        console.log('   该点 caretRangeFromPoint：' + JSON.stringify(await session.js(查点(x, y))));
        console.log('   截图：' + await 拍('02-公式-' + Math.round(比例 * 100), frame, 公式clip));
      }
    }
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 3)));
    console.log('输出：' + OUT);
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
