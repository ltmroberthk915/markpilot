/** 定位场景 73 那三条红：粘贴到底重复在哪一层——DOM 文本 / 编辑器取值 / 磁盘？
 *
 *  场景 73 的计数用 `surface.textContent.split(TEXT).length - 1`，报"出现 2 次"。但它的磁盘
 *  断言写在 `if (pasted === 1)` 里面，所以失败时**看不到磁盘读数**——无法区分这两种情形：
 *    (a) 粘贴真的把内容插了两遍 → 严重的用户级缺陷（粘贴会复制一份内容）；
 *    (b) 只有 DOM 的 textContent 里出现两次（比如源码与预览各一份）→ 断言口径问题。
 *
 *  本探针把三个口径分开量，并给出两处命中的 DOM 位置。
 *
 *  用法：node scripts/acceptance/probe-paste-double.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const edge = require('./edge-helpers.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-paste');
const PASTE_TEXT = '粘贴进来的验收字符串甲乙丙';

const countIn = expression => `(() => { const w = document.getElementById('editor').contentWindow, d = w.document;
  const surface = d.querySelector(${JSON.stringify(edge.SURFACE)});
  ${expression} })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const file = path.join(OUT, 'paste.md');
  fs.writeFileSync(file, ['第 1 段：甲乙丙。', '', '第 2 段：丁戊己。', ''].join('\n'), 'utf8');
  const clipboardDir = path.join(OUT, 'clip');
  fs.mkdirSync(clipboardDir, {recursive: true});

  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-paste-double', outDir: OUT, args: [file], timeout: 300000, inspect: true,
  });
  try {
    await session.until(`(() => { const w = document.getElementById('editor').contentWindow;
      return !!(w && w.document.querySelector(${JSON.stringify(edge.SURFACE)})); })()`, {timeout: 120000, interval: 80});
    await sleep(1800);

    harness.writeClipboard(clipboardDir, PASTE_TEXT);
    const target = await session.js(countIn(`const block = [...surface.children].find(node => node.textContent.includes('第 1 段'));
      if (!block) return null;
      const r = block.getBoundingClientRect();
      return {x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2)};`));
    if (!target) { console.log('没找到目标段落'); return; }
    await session.click(target.x + 250, target.y);
    await sleep(250);
    await session.key({key: 'End', code: 'End', vk: 35});
    await sleep(250);

    const menu = await edge.menuClick(session, `(() => {
      const doc = document.getElementById('editor').contentWindow.document;
      const surface = doc.querySelector(${JSON.stringify(edge.SURFACE)});
      return [...surface.children].find(node => node.textContent.includes('第 1 段')) || null; })()`, 'paste', {wait: 1200});

    const report = await session.js(countIn(`
      const TEXT = ${JSON.stringify(PASTE_TEXT)};
      const domCount = surface.textContent.split(TEXT).length - 1;
      const valueCount = (w.vditor.getValue().split(TEXT).length - 1);
      // 命中的 DOM 位置：列出每个包含该文本的元素及其祖先链
      const hits = [];
      for (const node of surface.querySelectorAll('*')) {
        if (!node.textContent.includes(TEXT)) continue;
        if ([...node.children].some(child => child.textContent.includes(TEXT))) continue;   // 只取最内层
        const chain = [];
        for (let at = node; at && at !== surface; at = at.parentElement) {
          chain.push(at.nodeName.toLowerCase() + (at.className ? '.' + String(at.className).split(' ').slice(0,2).join('.') : '') + (at.dataset && at.dataset.type ? '[' + at.dataset.type + ']' : ''));
        }
        hits.push({chain: chain.join(' < '), text: node.textContent.slice(0, 40)});
      }
      return {domCount, valueCount, hits};`));

    await edge.saveAndWait(session, file, {timeout: 6000}).catch(() => null);
    await sleep(1200);
    const disk = fs.readFileSync(file, 'utf8');
    const diskCount = disk.split(PASTE_TEXT).length - 1;

    console.log('菜单点击：' + JSON.stringify(menu));
    console.log('DOM  textContent 命中：' + report.domCount);
    console.log('编辑器 getValue() 命中：' + report.valueCount);
    console.log('磁盘文件命中：' + diskCount);
    console.log('命中位置：');
    for (const hit of report.hits) console.log('  · ' + hit.chain + '  → ' + JSON.stringify(hit.text));
    console.log('\n磁盘内容：' + JSON.stringify(disk));
    await session.shot('paste-double').catch(() => {});
  } finally {
    await session.close();
  }
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
