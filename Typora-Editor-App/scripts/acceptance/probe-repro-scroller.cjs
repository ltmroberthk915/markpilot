/** 编辑器的滚动到底发生在谁身上？——验收基座里 `window.scrollTo` 一直没动过页面，
 *  先把这个事实量清楚（它决定"跳行"这类场景能扫到哪一段）。
 *  用法：node scripts/acceptance/probe-repro-scroller.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-scroller');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const IF = `document.getElementById('editor').contentWindow`;

const 可滚动 = `(() => { const out = [];
  for (const el of [document.documentElement, document.body, ...document.querySelectorAll('div,main,section')]) {
    if (!el || !el.scrollHeight) continue;
    if (el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 100) {
      const s = getComputedStyle(el);
      out.push({标签: el.tagName + '.' + String(el.className).split(' ').slice(0, 2).join('.'),
        clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, overflowY: s.overflowY, scrollTop: Math.round(el.scrollTop)});
    }
  }
  return out.slice(0, 8); })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-scroller', outDir: OUT,
    args: [path.join(DIR, '1-重识概率论.md')], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 240000, interval: 120});
    await sleep(3000);
    console.log('帧内可滚动元素：\n' + JSON.stringify(await session.js(`(() => { const w = ${IF}; const d = w.document; return d ? (0, eval)(${JSON.stringify(可滚动)}) : null; })()`), null, 1));
    console.log('顶层页可滚动元素：\n' + JSON.stringify(await session.js(`(0, eval)(${JSON.stringify(可滚动)})`), null, 1));
    console.log('深部公式 scrollIntoView 之后：\n' + JSON.stringify(await session.js(`(() => { const w = ${IF}; const d = w.document;
      const nodes = [...d.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
      const deep = nodes[Math.floor(nodes.length * 0.6)];
      if (!deep) return null;
      deep.scrollIntoView({block: 'center'});
      const r = deep.getBoundingClientRect();
      return {深层公式视口位置: Math.round(r.top), 帧windowScrollY: Math.round(w.scrollY),
        帧documentElement_scrollTop: Math.round(d.documentElement.scrollTop), 帧body_scrollTop: Math.round(d.body.scrollTop),
        帧内滚动容器: (() => { const out = []; for (const el of d.querySelectorAll('div')) { if (el.scrollTop > 0) out.push(el.tagName + '.' + String(el.className).split(' ').slice(0, 2).join('.') + '=' + Math.round(el.scrollTop)); } return out.slice(0, 4); })()}; })()`), null, 1));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('失败：', error); process.exit(1); });
