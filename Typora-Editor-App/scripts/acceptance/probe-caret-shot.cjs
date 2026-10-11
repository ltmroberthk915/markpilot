/** 截图通道探针：CDP 的 Page.captureScreenshot 到底拍不拍得到**真光标**与**选中高亮**？
 *
 *  用户 2026-09-18 令：最后所有验收必须靠截图，"尤其是截清楚光标位置以及选中高亮情况"。
 *  动手之前先量清这条通道：光标（caret）是合成器画的一层，有些抓帧路径拍不到；
 *  选中高亮是普通绘制，理论上必拍得到。**先证明尺子能用，再拿它做验收。**
 *
 *  输出：.perf/caret-shot/ 下若干 2x 放大的局部截图 + 每张图的坐标说明。
 *  用法：node scripts/acceptance/probe-caret-shot.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/caret-shot');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;

/** 在顶层页坐标里截一块，2 倍放大（"截清楚"）。 */
async function shot(session, name, clip) {
  const result = await session.send('Page.captureScreenshot', {
    format: 'png',
    clip: {x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale || 2},
  });
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
    label: 'probe-caret-shot', outDir: OUT, args: [doc], timeout: 300000, inspect: true,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2000);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    const surface = await session.js(`(() => { const w = ${IF}; const s = w.document.querySelector('.vditor-ir .vditor-reset');
      const r = s.getBoundingClientRect(); return {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    console.log(`ifram: ${JSON.stringify(frame)}  编辑面（帧内坐标）: ${JSON.stringify(surface)}`);
    // 落点：第二段的正文里（帧内坐标）
    const point = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const blocks = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')];
      const block = blocks[1] || blocks[0];
      if (!block) return null;
      block.scrollIntoView({block: 'center', behavior: 'instant'});
      const rect = block.getBoundingClientRect();
      const y = Math.round(rect.top + rect.height / 2);
      const hit = d.caretRangeFromPoint(Math.round(rect.left + 120), y);
      if (!hit) return null;
      const range = hit.getBoundingClientRect();
      return {x: Math.round(rect.left + 120), y, caret: {x: Math.round(range.left), y: Math.round(range.top), h: Math.round(range.height)},
        文本: String(block.textContent).slice(0, 24)}; })()`);
    console.log('落点：' + JSON.stringify(point));
    const box = await session.js(`(() => { const w = ${IF}; const d = w.document; const s = d.querySelector('.vditor-ir .vditor-reset');
      const r = s.getBoundingClientRect(); return {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width)}; })()`);
    const pad = 60;
    const clip = {
      x: frame.x + Math.max(0, box.x - 20),
      y: frame.y + Math.max(0, point.caret.y - pad),
      width: Math.min(frame.w, box.w + 40),
      height: 170,
      scale: 2,
    };
    // ① 光标态（折叠选区）
    const caretShot = await shot(session, '01-光标态', clip);
    console.log('① 光标态截图：' + caretShot + '  裁剪 ' + JSON.stringify(clip));
    // ② 选中态（shift+→ 拖出高亮）
    await session.click(frame.x + point.x, frame.y + point.y);
    await sleep(260);
    for (let index = 0; index < 8; index++) {
      await session.key({key: 'ArrowRight', code: 'ArrowRight', vk: 39, modifiers: harness.MOD.shift});
      await sleep(80);
    }
    await sleep(300);
    const selection = await session.js(`(() => { const w = ${IF}; const s = w.getSelection();
      if (!s || !s.rangeCount) return {无选区: true};
      const r = s.getRangeAt(0); const box = r.getBoundingClientRect();
      return {选中: r.toString().slice(0, 24), 长度: r.toString().length, x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height)}; })()`);
    console.log('② 选中：' + JSON.stringify(selection));
    const selClip = {x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 2};
    const selShot = await shot(session, '02-选中态', selClip);
    console.log('② 选中态截图：' + selShot);
    // ③ 同一张图不带放大，看整体
    const full = await shot(session, '03-整幅', {x: frame.x, y: frame.y, width: frame.w, height: frame.h, scale: 1});
    console.log('③ 整幅：' + full);
    // ④ 校准：三种坐标约定的标记一起画，看哪一种才真的落在光标那一格上
    //    A = 视口坐标直接放（fixed）；B = 视口 + scroll（文档坐标）；C = 视口 + scroll + body 偏移
    const calib = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const s = w.getSelection(); if (!s.rangeCount) return {ok: false};
      const range = s.getRangeAt(0);
      const caret = range.getBoundingClientRect();
      const surfaceRect = d.querySelector('.vditor-ir .vditor-reset').getBoundingClientRect();
      const bodyStyle = w.getComputedStyle(d.body);
      return {ok: true, 光标: {x: Math.round(caret.left), y: Math.round(caret.top), h: Math.round(caret.height)},
        scroll: {x: Math.round(w.scrollX), y: Math.round(w.scrollY)},
        编辑面: {x: Math.round(surfaceRect.left), y: Math.round(surfaceRect.top)},
        body: {marginLeft: bodyStyle.marginLeft, marginTop: bodyStyle.marginTop, position: bodyStyle.position},
        文档高: d.documentElement.scrollHeight, 视口高: w.innerHeight}; })()`);
    console.log('④ 校准读数：' + JSON.stringify(calib));
    await session.js(`(() => { const w = ${IF}; const d = w.document;
      const old = d.getElementById('__calib'); if (old) old.remove();
      const layer = d.createElement('div'); layer.id = '__calib';
      layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
      const caret = ${JSON.stringify(calib.光标)};
      const scroll = ${JSON.stringify(calib.scroll)};
      const items = [
        {label: 'A-fixed', x: caret.x, y: caret.y, color: '#ff2d2d', fixed: true},
        {label: 'B', x: caret.x + scroll.x, y: caret.y + scroll.y, color: '#2dd4ff', fixed: false},
        {label: 'C', x: caret.x + scroll.x + 8, y: caret.y + scroll.y + 8, color: '#7cff2d', fixed: false},
      ];
      for (const item of items) {
        const bar = d.createElement('div');
        bar.style.cssText = (item.fixed ? 'position:fixed;' : 'position:absolute;')
          + 'left:' + item.x + 'px;top:' + item.y + 'px;width:3px;height:' + caret.h + 'px;background:' + item.color + ';';
        const tag = d.createElement('div');
        tag.textContent = item.label;
        tag.style.cssText = (item.fixed ? 'position:fixed;' : 'position:absolute;')
          + 'left:' + (item.x + 4) + 'px;top:' + (item.y - 13) + 'px;font:10px/1.2 monospace;color:' + item.color + ';white-space:nowrap;';
        layer.appendChild(bar); layer.appendChild(tag);
      }
      d.body.appendChild(layer); return 1; })()`);
    const calibClip = {x: clip.x, y: Math.max(0, frame.y + calib.光标.y - 40), width: clip.width, height: 160, scale: 2};
    const calibShot = await shot(session, '04-标记校准', calibClip);
    console.log('④ 校准图：' + calibShot + '  裁剪 ' + JSON.stringify(calibClip)
      + '（图上若 A 落在光标那一格，说明 fixed 视口坐标可用）');
    await session.js(`(() => { const w = ${IF}; const old = w.document.getElementById('__calib'); if (old) old.remove(); return 1; })()`);
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
