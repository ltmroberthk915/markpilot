/** 用户报告（2026-09-23，截图）：`**慢者独自行驶时间**` 用快捷键加粗之后**没有自动渲染**——
 *  正文里直接看见两个星号。素材是用户桌面文档的副本（`.perf/user-file/bold-copy.md`，
 *  已把那一处的 `**` 撤掉，回到"还没加粗"的状态）。
 *
 *  逐事件取证：选中 → Ctrl+B → （不点别处）看 DOM/选区/光标 → 点别处再看一次 → 存盘看磁盘。
 *  用法：node scripts/acceptance/probe-repro-bold-render.cjs [--app=dev|installed|<exe>]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-bold');
const IF = `document.getElementById('editor').contentWindow`;
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');
const 素材 = ARG('file', path.join(project, '.perf/user-file/bold-copy.md'));

const 段 = `(() => { const w = ${IF}; const d = w.document;
  const 面 = d.querySelector('.vditor-ir .vditor-reset');
  const p = [...面.querySelectorAll('p,div[data-block]')].find(x => String(x.textContent).includes('慢者独自行驶时间'));
  if (!p) return {没段: true};
  const s = w.getSelection();
  const rects = [...p.getClientRects()].map(r => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]);
  return {
    HTML尾: p.innerHTML.slice(-320),
    有strong: !!p.querySelector('strong'),
    strong文本: p.querySelector('strong') ? String(p.querySelector('strong').textContent) : null,
    文本含星号: /\\*\\*/.test(String(p.textContent)),
    可见尾: String(p.textContent).slice(-46),
    围栏数: p.querySelectorAll('.vditor-ir__marker').length,
    源码可见: /vditor-ir__node--expand|typora-ir-selected|vditor-ir__marker/.test(p.innerHTML),
    选区: s && s.rangeCount ? {塌: s.isCollapsed, 文本: s.toString().slice(0, 30)} : null,
    行盒: rects,
  }; })()`;

/** 选中"慢者独自行驶时间"这几个字的位置（取渲染文本里那一段的行盒）。 */
const 定位 = `(() => { const w = ${IF}; const d = w.document;
  const 面 = d.querySelector('.vditor-ir .vditor-reset');
  const p = [...面.querySelectorAll('p,div[data-block]')].find(x => String(x.textContent).includes('慢者独自行驶时间'));
  if (!p) return {没段: true};
  const 走 = node => { const out = []; const walker = d.createTreeWalker(node, NodeFilter.SHOW_TEXT, {acceptNode: n =>
      (n.parentElement && n.parentElement.closest('.vditor-ir__preview')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
    while (walker.nextNode()) out.push(walker.currentNode); return out; };
  const 节点们 = 走(p);
  let 目标 = null, 起 = -1;
  for (const t of 节点们) { const i = String(t.data).indexOf('慢者独自行驶时间'); if (i >= 0) { 目标 = t; 起 = i; break; } }
  if (!目标) return {没文本: true, 文本们: 节点们.map(t => String(t.data).slice(0, 12))};
  const 框 = (a, b) => { const r = d.createRange(); r.setStart(目标, a); r.setEnd(目标, b); const box = r.getBoundingClientRect();
    return box && box.height ? {left: Math.round(box.left), top: Math.round(box.top), right: Math.round(box.right), bottom: Math.round(box.bottom)} : null; };
  const fr = d.getElementById('editor') ? d.getElementById('editor').getBoundingClientRect() : {x: 0, y: 0};
  const 段框 = 框(起, 起 + 8);
  if (!段框) return {没几何: true};
  段框.left += Math.round(fr.x); 段框.right += Math.round(fr.x); 段框.top += Math.round(fr.y); 段框.bottom += Math.round(fr.y);
  return {ok: true, 起点: {x: 段框.left + 1, y: Math.round((段框.top + 段框.bottom) / 2)},
    终点: {x: 段框.right - 1, y: Math.round((段框.top + 段框.bottom) / 2)},
    文本: String(目标.data).slice(起, 起 + 8), 段框}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'copy.md');
  fs.copyFileSync(素材, doc);
  const exe = APP === 'dev' ? path.join(project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe' : APP;
  const session = await harness.launch({
    exe, appArgs: APP === 'dev' ? [path.join(project, 'app/main/main.js')] : [],
    label: 'probe-bold', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  const 打印 = (名, R) => {
    if (!R) { console.log('  ' + 名 + '：读不到'); return; }
    console.log('  ' + 名 + '：strong=' + R.有strong + (R.strong文本 ? '("' + R.strong文本 + '")' : '')
      + ' 星号可见=' + R.文本含星号 + ' 围栏数=' + R.围栏数 + ' 选区=' + JSON.stringify(R.选区));
    if (R.可见尾) console.log('       文本尾：' + JSON.stringify(R.可见尾));
  };
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 220000, interval: 120});
    await sleep(3000);

    // 滚到那一段
    for (let i = 0; i < 18; i++) {
      const r = await session.js(`(() => { const w = ${IF}; const d = w.document;
        const 面 = d.querySelector('.vditor-ir .vditor-reset');
        const p = [...面.querySelectorAll('p,div[data-block]')].find(x => String(x.textContent).includes('慢者独自行驶时间'));
        if (!p) return {没段: true};
        const b = p.getBoundingClientRect(); const 高 = w.innerHeight;
        if (b.top >= 160 && b.bottom <= 高 - 220) return {好了: true, 段: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]};
        const 目标 = b.top - Math.round(高 * 0.35);
        let 滚 = p.parentElement; let 推了 = false;
        while (滚) { const cs = w.getComputedStyle(滚);
          if (/(auto|scroll|overlay)/.test(cs.overflowY) && 滚.scrollHeight > 滚.clientHeight + 4) { 滚.scrollTop += 目标; 推了 = true; break; }
          滚 = 滚.parentElement; }
        if (!推了) { p.scrollIntoView({block: 'center'}); 推了 = true; }
        return {迭代: ${i}, top: Math.round(b.top)}; })()`);
      if (r.好了 || r.没段) { console.log('滚动：' + JSON.stringify(r)); break; }
      await sleep(200);
    }
    await sleep(400);

    const 起点 = await session.js(定位);
    console.log('定位：' + JSON.stringify(起点));
    if (!起点.ok) throw new Error('定位失败');

    console.log('\n① 打开后（还没加粗）：');
    打印('初始', await session.js(段));

    // ② 真实鼠标：按下在词首、Shift+点到词尾（选中这个词），再按真 Ctrl+B
    await session.move(起点.起点.x, 起点.起点.y);
    await sleep(60);
    await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: 起点.起点.x, y: 起点.起点.y, button: 'left', buttons: 1, clickCount: 1});
    await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: 起点.起点.x, y: 起点.起点.y, button: 'left', buttons: 0, clickCount: 1});
    await sleep(260);
    await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: 起点.终点.x, y: 起点.终点.y, button: 'left', buttons: 1, clickCount: 1, modifiers: harness.MOD.shift});
    await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: 起点.终点.x, y: 起点.终点.y, button: 'left', buttons: 0, clickCount: 1, modifiers: harness.MOD.shift});
    await sleep(400);
    const 选中后 = await session.js(段);
    console.log('\n② Shift+点选之后：' + JSON.stringify(选中后.选区));

    await session.chord('b', 'KeyB', 66);
    await sleep(900);
    console.log('\n③ Ctrl+B 之后（不点别处）：');
    打印('即时', await session.js(段));

    await sleep(1500);
    console.log('\n③b 再等 1.5 秒：');
    打印('等后', await session.js(段));

    // ④ 点别处（同一段的开头），看是否渲染
    await session.click(起点.起点.x - 120, 起点.起点.y);
    await sleep(900);
    console.log('\n④ 点段落别处之后：');
    打印('离开后', await session.js(段));

    // ⑤ 存盘：磁盘上写的是什么
    await session.chord('s', 'KeyS', 83);
    await sleep(1200);
    const 盘 = fs.readFileSync(doc, 'utf8');
    const 行 = (盘.split(/\r?\n/).find(l => l.includes('慢者独自行驶')) || '').slice(-60);
    console.log('\n⑤ 磁盘：' + JSON.stringify(行));
    console.log('   磁盘含 **慢者独自行驶时间**：' + /\*\*慢者独自行驶时间\*\*/.test(盘));

    const png = await session.send('Page.captureScreenshot', {format: 'png'});
    fs.writeFileSync(path.join(OUT, '现场.png'), Buffer.from(png.data, 'base64'));
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 4)));
    console.log('输出：' + OUT);
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
