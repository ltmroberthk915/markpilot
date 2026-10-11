/** 标题块首（点正文 → ← 到最左）按退格，`#` 会不会被吃掉？
 *  ——90 号场景的 ② 就是这个题目，这里用真实手势复现一遍。
 *  用法：node scripts/acceptance/probe-repro-headbackspace.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-headbackspace');
const IF = `document.getElementById('editor').contentWindow`;
const inFrame = (script, session) => session.js(`(() => { const w = ${IF}; return w.eval(${JSON.stringify(script)}); })()`);

const 读数 = `(() => { const w = window, d = document;
  const h = [...d.querySelectorAll('.vditor-ir .vditor-reset h1')].find(x => String(x.textContent).includes('目标标题'));
  const s = w.getSelection(), r = s && s.rangeCount ? s.getRangeAt(0) : null;
  const 值 = String(w.vditor.getValue());
  return {光标: r ? {类型: r.startContainer.nodeType, 元素: r.startContainer.nodeName, 偏移: r.startOffset,
      在记号里: !!(r.startContainer.parentElement?.closest?.('.vditor-ir__marker')),
      在块首: r.startOffset === 0} : null,
    标题还在: 值.includes('# 目标标题'), 井号被吃: !值.includes('# 目标标题') && 值.includes('目标标题'),
    守卫标记: w.__typoraBlockStartBackspace || null}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, '块首退格.md');
  fs.writeFileSync(doc, ['上一段文字，用来当"标题前面那个块"。', '', '| col1 | col2 |', '| ---- | ---- |', '| a    | b    |', '', '# 目标标题', '', '标题后的正文。', ''].join('\n'), 'utf8');
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-headbackspace', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset h1')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2000);
    const fr = await session.js(`(() => { const f = document.getElementById('editor'); const r = f.getBoundingClientRect();
      return {x: Math.round(r.x), y: Math.round(r.y)}; })()`);
    const 字 = await inFrame(`(() => { const d = document;
      const h = [...d.querySelectorAll('.vditor-ir .vditor-reset h1')].find(x => String(x.textContent).includes('目标标题'));
      const t = [...h.childNodes].find(n => n.nodeType === 3 && n.data.trim());
      const r = d.createRange(); r.setStart(t, 0); r.setEnd(t, 1); const b = r.getBoundingClientRect();
      return {x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2)}; })()`, session);
    await session.click(fr.x + 字.x, fr.y + 字.y);      // 点标题正文（展开）
    await sleep(600);
    await session.key({key: 'ArrowLeft', code: 'ArrowLeft', vk: 37});   // ← 到最左
    await sleep(500);
    console.log('① 点正文 + ← 之后：' + JSON.stringify(await inFrame(读数, session)));
    await session.key({key: 'Backspace', code: 'Backspace', vk: 8});
    await sleep(900);
    console.log('② 按退格之后：' + JSON.stringify(await inFrame(读数, session)));
    await sleep(2600);
    console.log('③ 磁盘内容：' + JSON.stringify(fs.readFileSync(doc, 'utf8').slice(0, 60)));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
