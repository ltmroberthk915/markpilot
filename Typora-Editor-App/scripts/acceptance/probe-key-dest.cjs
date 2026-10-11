/** 键事件路由探针：CDP 的 Input.dispatchKeyEvent 到底送进了哪个窗口/哪个目标？
 *
 *  起因（2026-09-18）：真实文档电池里 `输入` 明明推动了光标（↓ 逐行下移），但补丁挂在
 *  "编辑器窗口捕获段"的 keydown 监听一次都没触发（计数 0），探针自己挂的三个计数器
 *  （顶层 window / 编辑器 window / 编辑器 document）也全是 0。**在没有量清"键去了哪里"
 *  之前，任何"补丁没生效"的结论都靠不住**，所以单独做这一发。
 *
 *  做法：把计数器挂到所有能挂的地方（顶层 window/document、每个 iframe 的 window/document、
 *  编辑面的根元素），然后发一次方向键、一次带文字的按键，逐一读计数。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/key-dest');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');

const httpJson = (port, url) => new Promise((resolve, reject) => {
  const request = http.get({host: '127.0.0.1', port, path: url}, response => {
    let body = '';
    response.on('data', part => { body += part; });
    response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
  });
  request.on('error', reject);
});

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'real-copy.md');
  fs.copyFileSync(SOURCE, doc);
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-key-dest', outDir: OUT, args: [doc], timeout: 300000, inspect: true,
  });
  try {
    await session.until(`(() => { const frame = document.getElementById('editor');
      return !!(frame && frame.contentWindow && frame.contentWindow.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2000);
    console.log('目标清单（/json/list）：');
    for (const target of await httpJson(session.port, '/json/list')) {
      console.log(`  · ${target.type} ${target.url.slice(0, 90)}`);
    }
    console.log('会话目标：' + String(session.target && session.target.url).slice(0, 90));
    // 页面结构 + 计数器：能挂的地方全挂上
    console.log('页面结构：' + JSON.stringify(await session.js(`(() => {
      const frames = [...document.querySelectorAll('iframe')];
      return {顶层href: location.href.slice(0, 80), 顶层焦点: document.hasFocus(),
        活动元素: document.activeElement ? document.activeElement.tagName + '#' + document.activeElement.id : null,
        iframe数: frames.length,
        iframe: frames.map(frame => ({id: frame.id, src: String(frame.src).slice(0, 60),
          有编辑面: !!(frame.contentWindow && frame.contentWindow.document.querySelector('.vditor-ir .vditor-reset')), 帧内焦点: frame.contentWindow ? frame.contentWindow.document.hasFocus() : null}))}; })()`)));
    await session.js(`(() => {
      const counters = {};
      const attach = (label, node) => {
        if (!node) return;
        counters[label] = 0;
        for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input']) {
          node.addEventListener(type, () => { counters[label] += 1; }, true);
        }
      };
      window.__kd = counters;
      attach('顶层window', window);
      attach('顶层document', document);
      const frame = document.getElementById('editor');
      if (frame && frame.contentWindow) {
        attach('帧window', frame.contentWindow);
        attach('帧document', frame.contentWindow.document);
        attach('编辑面根', frame.contentWindow.document.querySelector('.vditor-ir'));
      }
      return Object.keys(counters); })()`);
    const readCounters = () => session.js(`(() => JSON.stringify(window.__kd))()`);
    const readCaret = () => session.js(`(() => { const frame = document.getElementById('editor');
      const w = frame.contentWindow; const selection = w.getSelection();
      if (!selection || !selection.rangeCount) return {无选区: true};
      const box = selection.getRangeAt(0).getBoundingClientRect();
      return {x: Math.round(box.left), y: Math.round(box.top), 高: Math.round(box.height)}; })()`);
    // 先点一下编辑面，让编辑器拿到焦点
    const box = await session.js(`(() => { const frame = document.getElementById('editor');
      const r = frame.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y)}; })()`);
    await session.click(box.x + 300, box.y + 140);
    await sleep(400);
    console.log('点击后计数器：' + await readCounters());
    console.log('点击后光标：' + JSON.stringify(await readCaret()));
    console.log('点击后活动元素：' + JSON.stringify(await session.js(`(() => {
      const frame = document.getElementById('editor'); const w = frame.contentWindow;
      const top = document.activeElement ? document.activeElement.tagName + '#' + document.activeElement.id : null;
      const inner = w.document.activeElement ? w.document.activeElement.tagName + '.' + String(w.document.activeElement.className).split(' ')[0] : null;
      return {顶层: top, 帧内: inner, 帧有焦点: w.document.hasFocus()}; })()`)));
    await session.js(`(() => { for (const key of Object.keys(window.__kd)) window.__kd[key] = 0; return 1; })()`);
    // ① rawKeyDown 的方向键
    await session.key({key: 'ArrowDown', code: 'ArrowDown', vk: 40});
    await sleep(320);
    console.log('① rawKeyDown ArrowDown → 计数器：' + await readCounters() + ' 光标：' + JSON.stringify(await readCaret()));
    await session.js(`(() => { for (const key of Object.keys(window.__kd)) window.__kd[key] = 0; return 1; })()`);
    // ② keyDown 类型的方向键（CDP 的两种类型分得清吗）
    await session.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown',
      windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40});
    await sleep(320);
    console.log('② keyDown ArrowDown → 计数器：' + await readCounters() + ' 光标：' + JSON.stringify(await readCaret()));
    await session.js(`(() => { for (const key of Object.keys(window.__kd)) window.__kd[key] = 0; return 1; })()`);
    // ③ 带文字的按键（真键盘上按 'a'）：文字该进文档，keydown 该被计数
    const before = await session.js(`(() => document.getElementById('editor').contentWindow.vditor.getValue())()`);
    await session.key({key: 'a', code: 'KeyA', vk: 65, text: 'a'});
    await sleep(420);
    const after = await session.js(`(() => document.getElementById('editor').contentWindow.vditor.getValue())()`);
    console.log('③ 按键 a → 计数器：' + await readCounters() + ' 文档长了 ' + (String(after).length - String(before).length) + ' 字符');
    await session.js(`(() => { for (const key of Object.keys(window.__kd)) window.__kd[key] = 0; return 1; })()`);
    // ④ 主进程侧发键（sendInputEvent）：这条通道才走"真输入"的浏览器内核路径吗
    const sent = await (async () => {
      try {
        return await session.main.send('Runtime.evaluate', {expression: `(() => {
          const {BrowserWindow} = require('electron');
          const win = BrowserWindow.getAllWindows()[0];
          win.webContents.focus();
          win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Down'});
          win.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Down'});
          return 'sent'; })()`, returnByValue: true, includeCommandLineAPI: true});
      } catch (error) { return {error: String(error && error.message || error)}; }
    })();
    await sleep(400);
    console.log('④ 主进程 sendInputEvent → 计数器：' + await readCounters() + ' 光标：' + JSON.stringify(await readCaret()));
    console.log('   主进程返回：' + JSON.stringify(sent).slice(0, 200));
    await session.js(`(() => { for (const key of Object.keys(window.__kd)) window.__kd[key] = 0; return 1; })()`);
    await session.type('甲');
    await sleep(400);
    console.log('⑤ insertText 甲 → 计数器：' + await readCounters() + ' 文档含甲：'
      + await session.js(`(() => document.getElementById('editor').contentWindow.vditor.getValue().includes('甲'))()`));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
