/** 折叠态块公式的"空白带"里点一下，光标落在哪里？（用户截图里点公式附近那一带的另一支）
 *  用法：node scripts/acceptance/probe-repro-collapsedstrip.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-collapsedstrip');
const DIR = 'D:/Users/ltmoberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const DIR_OK = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR_OK, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;

const 现场 = (x, y) => `(() => { const w = ${IF}; const d = w.document;
  const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const 链 = node => { const out = []; let cur = node;
    while (cur && out.length < 4) { const cls = (typeof cur.className === 'string' ? cur.className : '').split(' ').filter(Boolean).slice(0, 2).join('.');
      out.push(cur.nodeName + (cur.nodeType === 3 ? '("' + String(cur.data).slice(0, 8) + '")' : (cls ? '.' + cls : '')));
      cur = cur.parentNode; } return out.join(' < '); };
  const bar = d.querySelector('[data-typora-caret-proxy]');
  const el = d.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
  return {命中: el ? el.tagName + '.' + String(el.className).split(' ').slice(0, 3).join('.') : null,
    光标: at ? {链: 链(at.startContainer), 偏移: at.startOffset, rect: box(at.getBoundingClientRect())} : null,
    合成: bar ? (bar.style.display === 'none' ? 'none' : box(bar.getBoundingClientRect())) : null}; })()`;

async function shot(session, name, clip) {
  const result = await session.send('Page.captureScreenshot', {
    format: 'png', clip: {x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale || 2}});
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
    label: 'probe-repro-collapsedstrip', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2200);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    const G = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
      const code = [...d.querySelectorAll('code[data-type="math-block"]')].find(c => (c.textContent || '').trim() === 'ad');
      const block = code.parentElement.parentElement;
      block.scrollIntoView({block: 'center', behavior: 'instant'});
      return {块: box(block.getBoundingClientRect()), 源码条: box(code.getBoundingClientRect()),
        预览: box(block.querySelector('.vditor-ir__preview').getBoundingClientRect())}; })()`);
    console.log('折叠态几何：' + JSON.stringify(G));
    const clip = {x: frame.x + Math.max(0, G.块.x - 16), y: frame.y + Math.max(0, G.块.y - 30), width: 700, height: 190, scale: 2};
    console.log('静态：' + await shot(session, '00-折叠静态', clip));
    const 点集 = [
      ['01-源码条上沿', 54, G.块.y + 18],
      ['02-源码条中段', 54, G.块.y + 30],
      ['03-块内右侧空白', 500, G.块.y + 18],
      ['04-预览正中', 465, G.预览.y + 12],
    ];
    for (const [名, x, y] of 点集) {
      await session.click(frame.x + x, frame.y + y);
      await sleep(360);
      console.log(`· ${名} 点(${x},${y}) → ` + JSON.stringify(await session.js(现场(x, y))));
      console.log('   图：' + await shot(session, 名, clip));
      // 复位：把光标放到上一段末尾，再看下一个点
      await session.js(`(() => { const w = ${IF}; const d = w.document;
        const p = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(p => (p.textContent || '').includes('所有移动的树'));
        const t = p && p.firstChild; if (t) { const s = w.getSelection(); s.removeAllRanges(); const r = d.createRange(); r.setStart(t, 0); r.collapse(true); s.addRange(r); }
        return 1; })()`);
      await sleep(200);
    }
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 3)));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
