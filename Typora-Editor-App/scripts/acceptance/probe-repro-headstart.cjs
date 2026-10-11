/** 场景 94 的 ② 段为什么会红：它的 setup 用 JS 把光标放到**正文文本 offset 0**，
 *  然后断言"光标在 `# ` 记号里（offset 0）"。这里验：
 *   ① 现在的产品在这个位置上给什么（复现红）；
 *   ② 从那里按 ← 能不能走到"记号 offset 0"（94 注释里写的真实走法）；
 *   ③ 鼠标点标题正文里（井号右侧）落在哪。
 *  用法：node scripts/acceptance/probe-repro-headstart.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-headstart');
// 可选用别的产物跑（A/B）：--app=<exe> [--devmain 表示 dev 树]
const argExe = (process.argv.find(a => a.startsWith('--app=')) || '').slice(6);
const devMain = process.argv.includes('--devmain');
const IF = `document.getElementById('editor').contentWindow`;
/** 下面这些片段在**编辑器 iframe 里**求值（inFrame 负责包一层 w.eval）。 */
const inFrame = (script, session) => session.js(`(() => { const w = ${IF}; return w.eval(${JSON.stringify(script)}); })()`);

const 读数 = `(() => { const w = window, d = document;
  const h = [...d.querySelectorAll('.vditor-ir .vditor-reset h1')].find(x => String(x.textContent).includes('目标标题'));
  if (!h) return {missing: true};
  const mk = h.querySelector('.vditor-ir__marker');
  const s = w.getSelection(), r = s && s.rangeCount ? s.getRangeAt(0) : null;
  if (!r) return {无选区: true};
  const el = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const box = (() => { const q = d.createRange(); q.setStart(r.startContainer, r.startOffset); q.collapse(true);
    const b = q.getBoundingClientRect(); return {x: Math.round(b.left), y: Math.round(b.top), h: Math.round(b.height)}; })();
  return {inMarker: !!(el.closest && el.closest('.vditor-ir__marker')), offset: r.startOffset,
    容器: el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : '') + (el.getAttribute && el.getAttribute('data-type') ? '[' + el.getAttribute('data-type') + ']' : ''),
    矩形: box, 展开: h.classList.contains('vditor-ir__node--expand'),
    记号文本: mk ? String(mk.textContent) : null, 记号守卫: w.__typoraMarkerCaret || null}; })()`;

/** 标题正文第一个字的中心（**帧内**坐标）。 */
const 正文首字 = `(() => { const d = document;
  const h = [...d.querySelectorAll('.vditor-ir .vditor-reset h1')].find(x => String(x.textContent).includes('目标标题'));
  const t = [...h.childNodes].find(n => n.nodeType === 3 && n.data.trim());
  const r = d.createRange(); r.setStart(t, 0); r.setEnd(t, 1);
  const b = r.getBoundingClientRect();
  return {x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2)}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, '块首.md');
  fs.writeFileSync(doc, ['上一段文字，用来当"标题前面那个块"。', '', '| col1 | col2 |', '| ---- | ---- |', '| a    | b    |', '', '# 目标标题', '', '标题后的正文。', '', '末尾。', ''].join('\n'), 'utf8');
  const session = await harness.launch({
    exe: argExe ? path.resolve(project, argExe) : path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: argExe && !devMain ? [] : [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-headstart', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset h1')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2000);
    const fr = await session.js(`(() => { const f = document.getElementById('editor'); const r = f.getBoundingClientRect();
      return {x: Math.round(r.x), y: Math.round(r.y)}; })()`);
    const 字 = await inFrame(正文首字, session);
    console.log('标题正文首字（帧内）：' + JSON.stringify(字) + '，iframe 原点 ' + JSON.stringify(fr));
    // ③ 先点标题正文里（井号右侧）——这是用户最常做的动作
    await session.click(fr.x + 字.x, fr.y + 字.y);
    await sleep(500);
    console.log('③ 点标题正文（首字中心）：' + JSON.stringify(await inFrame(读数, session)));
    // ② 从当前位置按 ←，看能不能走到井号之前（94 注释里写的走法）
    for (const 步 of [1, 2, 3]) {
      await session.key({key: 'ArrowLeft', code: 'ArrowLeft', vk: 37});
      await sleep(320);
      console.log(`② ← 第 ${步} 次：` + JSON.stringify(await inFrame(读数, session)));
    }
    console.log('左走锚形态：' + JSON.stringify(await inFrame('window.__typoraLeftAnchor || null', session)));
    console.log('左走标记：' + JSON.stringify(await inFrame('window.__typoraBlockStartLeft || null', session)));
    // ① 再复现 94 的 setup：JS 把光标放到正文文本 offset 0
    await inFrame(`(() => { const d = document;
      const h = [...d.querySelectorAll('.vditor-ir .vditor-reset h1')].find(x => String(x.textContent).includes('目标标题'));
      const t = [...h.childNodes].find(n => n.nodeType === 3 && n.data.trim());
      const r = d.createRange(); r.setStart(t, 0); r.collapse(true);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); window.focus(); return true; })()`, session);
    await sleep(300);
    console.log('① 94 的 setup（JS 放正文 offset 0）：' + JSON.stringify(await inFrame(读数, session)));
    await session.key({key: 'ArrowLeft', code: 'ArrowLeft', vk: 37});
    await sleep(320);
    console.log('左走标记(再按一次后)：' + JSON.stringify(await inFrame('window.__typoraBlockStartLeft || null', session)));
    console.log('   再按 ← 一次：' + JSON.stringify(await inFrame(读数, session)));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
