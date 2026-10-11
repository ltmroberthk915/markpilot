/** "左键选中图片 → Ctrl+C → 剪贴板里有图片文件"这条为什么在打包版上不成立。
 *
 *  背景：场景 76 的这条断言在**安装版 2.1.29 上 2/2 通过**，在**打包版 2.1.30 上 4/4 失败**，
 *  而失败时应用**不报错**（错误面断言全过）、剪贴板里**一个格式都没有**（`formats: []`）。
 *  "没有报错" + "什么也没写" 这个组合最可能的形态是：**复制处理器的前置判断直接 return 了**
 *  （图片没被应用认成"已选中"），于是既不发请求也不报错。
 *
 *  所以这里不去猜，直接在页面里挂一层**只读**记录：包装 `hostApi.invoke`（不改变它的行为），
 *  记下应用到底发了什么请求；再读图片上的选中类、以及剪贴板的真实内容。
 *
 *  用法：node scripts/acceptance/probe-image-copy.cjs [--exe=…]（不给 --exe 就走 dev）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const fixtures = require('./fixtures.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-image-copy');
const IF = `document.getElementById('editor').contentWindow`;
const SURFACE = '.vditor-ir .vditor-reset';

const argOf = (name, fallback) => {
  const hit = process.argv.find(value => value.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};

/** 只读包装：记下应用发出的请求（不改行为、不改返回值）。 */
const WATCH = `(() => { const w = ${IF};
  if (w.__copyLog) return 'already';
  w.__copyLog = [];
  w.__lineEndLog = [];
  const api = w.hostApi;
  if (!api || !api.invoke) return 'no-hostApi';
  const original = api.invoke.bind(api);
  api.invoke = (name, payload) => {
    const record = {name, payload: null, at: Math.round(performance.now())};
    try { record.payload = JSON.parse(JSON.stringify(payload)); } catch { record.payload = '无法序列化'; }
    w.__copyLog.push(record);
    return original(name, payload);
  };
  return 'ok'; })()`;

/** 记录 copy/cut 事件有没有到达编辑面、有没有被应用吃掉、以及 Ctrl+C 的 keydown 到没到。 */
const EVENT_WATCH = `(() => { const w = ${IF}, d = w.document;
  if (w.__copyEvents) { w.__copyEvents.length = 0; return 'reset'; }
  w.__copyEvents = [];
  d.addEventListener('selectionchange', () => {
    const s = d.getSelection();
    const img = d.querySelector('img.typora-img-selected');
    const r = s && s.rangeCount ? s.getRangeAt(0) : null;
    let covers = null; try { covers = !!(r && !s.isCollapsed && img && r.intersectsNode(img)); } catch { covers = '判不了'; }
    w.__copyEvents.push({type: 'selectionchange', at: Math.round(performance.now()), 折叠: s ? s.isCollapsed : null, 覆盖图片: covers, 容器: r ? (r.startContainer.nodeType === 3 ? 'TEXT' : r.startContainer.nodeName) : null});
  }, true);
  for (const type of ['copy', 'cut']) {
    d.addEventListener(type, event => {
      const selection = d.getSelection();
      w.__copyEvents.push({type, at: Math.round(performance.now()),
        被吃掉: event.defaultPrevented, 选中图片: d.querySelectorAll('img.typora-img-selected').length,
        选区文本: selection ? String(selection.toString()).slice(0, 30) : null,
        有clipboardData: !!event.clipboardData});
    }, true);
  }
  d.addEventListener('keydown', event => {
    if (!event.ctrlKey || String(event.key).toLowerCase() !== 'c') return;
    w.__copyEvents.push({type: 'keydown-c', at: Math.round(performance.now()), 被吃掉: event.defaultPrevented,
      目标: event.target ? (event.target.tagName || String(event.target)) : null});
  }, true);
  return 'ok'; })()`;

const SELECT_STATE = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  const images = [...(surface ? surface.querySelectorAll('img') : [])];
  const selection = w.getSelection();
  return {图片数: images.length,
    选中的图片: images.filter(node => node.classList.contains('typora-img-selected')).length,
    类名: images.map(node => String(node.className)).slice(0, 4),
    选区: selection ? {折叠: selection.isCollapsed, 文本: String(selection.toString()).slice(0, 20)} : null,
    事件: (w.__copyEvents || []).slice(), 行尾规则决定: (w.__lineEndLog || []).slice(-4),
    记录: (w.__copyLog || []).map(item => ({name: item.name, payload: JSON.stringify(item.payload).slice(0, 160)})),
    提示: [...d.querySelectorAll('.typora-context-toast, .media-error')].map(node => node.textContent)}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const exeArg = argOf('exe', '');
  const images = fixtures.images();
  const session = await harness.launch({
    exe: exeArg || path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: exeArg ? [] : [path.join(project, 'app/main/main.js')],
    label: 'probe-image-copy', outDir: OUT, args: [images.markdown], timeout: 300000, inspect: true,
  });
  const clipboardDir = path.join(OUT, 'clipboard');
  fs.mkdirSync(clipboardDir, {recursive: true});
  try {
    const ready = await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector(${JSON.stringify(SURFACE)})); })()`, {timeout: 90000, interval: 60});
    if (!ready) throw new Error('素材没有打开');
    await sleep(2500);
    console.log('包装 hostApi：' + await session.js(WATCH));
    console.log('事件观察器：' + await session.js(EVENT_WATCH));

    const point = await session.js(`(() => { const frame = document.getElementById('editor');
      const w = frame.contentWindow, d = w.document;
      const surface = d.querySelector(${JSON.stringify(SURFACE)});
      const img = surface.querySelectorAll('img')[0];
      if (!img) return {ok: false};
      img.scrollIntoView({block: 'center', behavior: 'instant'});
      const rect = img.getBoundingClientRect(), fr = frame.getBoundingClientRect();
      return {ok: true, x: Math.round(fr.x + rect.left + rect.width / 2), y: Math.round(fr.y + rect.top + rect.height / 2),
        src: String(img.getAttribute('src')).slice(0, 60), box: {w: Math.round(rect.width), h: Math.round(rect.height)}}; })()`);
    console.log('模块标记：' + await session.js('(() => { const w = ' + JSON.stringify(IF) + '; return w.__typoraPatchesMarker || "（读不到：加载的不是被改过的那份）"; })()'));
    console.log('图片落点：' + JSON.stringify(point));
    if (!point.ok) throw new Error('没有图片可点');

    harness.saveClipboard(clipboardDir);
    harness.writeClipboard(clipboardDir, "zcode-baseline");
    await session.move(point.x, point.y);
    // 点击之后**按时间采样**：单击图片本该建立一个"覆盖这张图"的选区（media-tools.js:969
    // 的 range.selectNode(img)），而断言失败时读到的是折叠选区——要分清它是"从没建起来"
    // 还是"建起来又被谁收掉了"。
    const SAMPLE = `(() => { const w = ${IF}, d = w.document;
      const selection = w.getSelection();
      const img = d.querySelector('img.typora-img-selected');
      const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
      let 覆盖图片 = null;
      try { 覆盖图片 = !!(range && !selection.isCollapsed && img && range.intersectsNode(img)); } catch { 覆盖图片 = '判不了'; }
      return {t: Math.round(performance.now()), 折叠: selection ? selection.isCollapsed : null,
        范围数: selection ? selection.rangeCount : null, 覆盖图片,
        选中的图片: d.querySelectorAll('img.typora-img-selected').length,
        容器: range ? (range.startContainer.nodeType === 3 ? 'TEXT' : range.startContainer.nodeName) : null,
        文本: range ? String(range.toString()).slice(0, 20) : null}; })()`;
    await session.click(point.x, point.y);
    const series = [];
    let elapsed = 0;
    for (const at of [40, 200, 500, 1000, 1800]) { await sleep(at - elapsed); elapsed = at; series.push({at, state: await session.js(SAMPLE)}); }
    console.log('点击后的选区时间线：');
    for (const item of series) console.log(`  +${item.at}ms  ` + JSON.stringify(item.state));
    const afterClick = await session.js(SELECT_STATE);
    console.log('行尾规则的日志：' + JSON.stringify(await session.js('(() => { const w = ' + JSON.stringify(IF) + '; return (w.__lineEndLog || []).slice(-6); })()')));
    console.log('点击之后：' + JSON.stringify({选中的图片: afterClick.选中的图片, 选区: afterClick.选区, 提示: afterClick.提示}));

    // 三轮取样：这一条现象是**竞态**，单次样本不足以下结论（前两轮各一次结论相反）
    void 0;
    await session.chord('c', 'KeyC', 67);
    await sleep(2500);
    const afterCopy = await session.js(SELECT_STATE);
    const clipboard = harness.readClipboard(clipboardDir);
    console.log('Ctrl+C 之后：' + JSON.stringify({请求记录: afterCopy.记录, 事件: afterCopy.事件, 选中的图片: afterCopy.选中的图片, 提示: afterCopy.提示}, null, 1));
    console.log('剪贴板：' + JSON.stringify({hasFiles: clipboard.hasFiles, hasText: clipboard.hasText,
      files: (clipboard.files || []).length, formats: (clipboard.formats || []).slice(0, 6), text: String(clipboard.text || '').slice(0, 40)}));
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({exe: exeArg || 'dev', point, afterClick, afterCopy, clipboard: {...clipboard, text: String(clipboard.text || '').slice(0, 200)}}, null, 1));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('probe 失败：', (error && error.stack) || error); process.exit(1); });
