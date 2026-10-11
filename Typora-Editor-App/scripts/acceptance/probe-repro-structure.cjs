/** 结构快照：那份小文档在编辑器里的真实 DOM 长什么样（尤其 `$$ad$$` 与紧随其后的 `$a$`）。
 *  用法：node scripts/acceptance/probe-repro-structure.cjs */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-structure');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'real-copy.md');
  fs.copyFileSync(SOURCE, doc);
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-structure', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2000);
    const 结构 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const out = [];
      const walk = (node, depth) => {
        for (const child of node.children) {
          const r = child.getBoundingClientRect();
          const attrs = [...child.attributes].map(a => a.name + '=' + a.value).filter(a => !a.startsWith('style=')).join(' ');
          out.push('  '.repeat(depth) + child.tagName.toLowerCase()
            + (attrs ? ' [' + attrs + ']' : '')
            + ' {x:' + Math.round(r.left) + ' y:' + Math.round(r.top) + ' w:' + Math.round(r.width) + ' h:' + Math.round(r.height) + '}'
            + (child.children.length === 0 ? ' ¶' + JSON.stringify((child.textContent || '').slice(0, 24)) : ''));
          if (depth < 4) walk(child, depth + 1);
        }
      };
      walk(d.querySelector('.vditor-ir .vditor-reset'), 0);
      const sel = w.getSelection();
      const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      return {行数: out.length, 树: out.join('\\n'),
        光标: at ? {折叠: at.collapsed, 在: at.startContainer.nodeName + '.' + (at.startContainer.className || ''), 偏移: at.startOffset} : null}; })()`);
    fs.writeFileSync(path.join(OUT, 'structure.txt'), 结构.树, 'utf8');
    console.log(结构.树);
    console.log('光标：' + JSON.stringify(结构.光标));
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    const shot = await session.send('Page.captureScreenshot', {
      format: 'png', clip: {x: frame.x, y: frame.y, width: frame.w, height: Math.min(760, frame.h), scale: 1}});
    fs.writeFileSync(path.join(OUT, '00-起始.png'), Buffer.from(shot.data, 'base64'));
    console.log('截图：' + path.join(OUT, '00-起始.png'));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
