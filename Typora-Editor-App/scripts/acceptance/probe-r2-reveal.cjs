/** 探针 · 第 2 轮判决 W2/D1（2026-10-02）。
 *
 *  被测对象：本仓开发树（app/renderer/js/，= extension-src 的同步副本）。
 *
 *  用例（全部真实输入：CDP key/mouse/insertText；拖拽一律按下→多步移动→抬起）：
 *    W2  展开 $..$ 出预渲染浮框 → 在浮框上**双击起手**（第二击 mousePressed 不松）拖到
 *        段尾松手 → 断言选区含公式、盖到段尾、非折叠
 *        （红：现状 detail≥2 早退不摘围栏，原生拖拽被关在公式内部，选区出不来；
 *          recover 的 native-confined 因 grabbed 为空判 inside=false 放弃）
 *    D1  先拖一段既有选区盖住折叠公式 → 从公式 preview 上按下、把选区拖到别处松手
 *        （原生 dragdrop：mouseup 不派发、dragend 收尾）→ 断言 preview 的
 *        contenteditable=='false' 已还原、root(.vditor-ir) 无 typora-ir-pointer 类；
 *        随后点公式右侧行尾 → 光标层!=源码（不进隐藏源码）
 *        （红：现状 dragend 无人清理——围栏缺 contenteditable、POINTER 类残留，
 *          点公式右侧光标解进隐藏源码）
 *
 *  用法：node scripts/acceptance/probe-r2-reveal.cjs
 *        node scripts/acceptance/probe-r2-reveal.cjs --only=W2
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-r2-reveal');
const IF = hi.IF, SURFACE = hi.SURFACE;
const POWERSHELL = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

/** 素材：两条行内公式行（W2 用第一条 $v$，D1 用第二条 $p$），自建文档不碰素材房。 */
const DOC = [
  '# R2 探针素材', '',
  'W2 行：设速度为 $v$ 千米每小时，全程较长。', '',
  'D1 行：相遇点记作 $p$ 处，再走一段。', '',
].join('\n');

/** 页面几何（顶层页坐标，可直接喂 CDP 输入）。 */
const GEO = `(() => { const w = ${IF}, d = w.document;
  const frame = document.getElementById('editor').getBoundingClientRect();
  const surface = d.querySelector('${SURFACE}');
  if (!surface) return {ok: false};
  const charBox = needle => { for (const b of surface.children) {
      const walker = d.createTreeWalker(b, NodeFilter.SHOW_TEXT); let n;
      while (n = walker.nextNode()) { const i = n.data.indexOf(needle);
        if (i >= 0) { const r = d.createRange(); r.setStart(n, i); r.setEnd(n, i + needle.length);
          const q = r.getBoundingClientRect();
          return {x: Math.round(frame.x + q.left + q.width / 2), y: Math.round(frame.y + q.top + q.height / 2),
            l: Math.round(frame.x + q.left), t: Math.round(frame.y + q.top),
            r: Math.round(frame.x + q.right), w: Math.round(q.width), h: Math.round(q.height)}; } } }
    return null; };
  const nodeBox = host => { const p = host.querySelector(':scope > .vditor-ir__preview') || host;
    const q = p.getBoundingClientRect();
    return {x: Math.round(frame.x + q.left + q.width / 2), y: Math.round(frame.y + q.top + q.height / 2),
      l: Math.round(frame.x + q.left), t: Math.round(frame.y + q.top),
      r: Math.round(frame.x + q.right), w: Math.round(q.width), h: Math.round(q.height)}; };
  const inline = [...surface.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
  return { ok: true,
    较长: charBox('较长'), 一段: charBox('一段'), 相遇: charBox('相遇点'),
    w2: inline.length ? nodeBox(inline[0]) : null,        // $v$（W2 用）
    d1: inline.length > 1 ? nodeBox(inline[1]) : null };  // $p$（D1 用）
  })()`;

/** 选区事实（照 r1 探针口径）。 */
const READ_SEL = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector('${SURFACE}');
  const s = w.getSelection(); if (!s || !s.rangeCount) return {none: true};
  const layer = node => { const at = node.nodeType === 3 ? node.parentElement : node;
    if (!at || !at.closest) return '外';
    return at.closest('.vditor-ir__preview') ? '预览' : at.closest('code[data-type]') ? '源码' : '正文'; };
  const r = s.getRangeAt(0);
  const note = w.__typoraMathRecover || null;
  return { len: s.toString().length, text: s.toString().slice(0, 120), collapsed: r.collapsed,
    start层: layer(r.startContainer), end层: layer(r.endContainer),
    reveal: [...surface.querySelectorAll('.vditor-ir__node.typora-ir-selected')].map(h => h.dataset.type),
    recover: note ? {why: note.why} : null }; })()`;

/** D1 的悬空状态断言：围栏还原了吗、POINTER 类还在吗。root = editor.ir.element（.vditor-ir）。 */
const READ_STATE = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector('${SURFACE}');
  const inline = [...surface.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
  const p1 = inline.length > 1 ? inline[1].querySelector(':scope > .vditor-ir__preview') : null;
  const ir = d.querySelector('.vditor-ir');
  return { d1previewCE: p1 ? String(p1.getAttribute('contenteditable')) : '无节点',
    pointer类: ir ? ir.classList.contains('typora-ir-pointer') : '无 vditor-ir' }; })()`;

/** 双击起手拖：第一击（clickCount 1）→ 第二击 mousePressed(clickCount 2，即 detail=2)不松 →
 *  多步移动 → 抬起。第二击按住后 Chromium 走"双击选词+按住扩展"的手势，正是 W2 的场景。 */
async function dblclickDrag(session, from, to, {steps = 8, interval = 40, after = 700} = {}) {
  await session.click(from.x, from.y);
  await hi.sleep(50);
  await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 2});
  for (let step = 1; step <= steps; step++) {
    await hi.sleep(interval);
    await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', buttons: 1,
      x: Math.round(from.x + (to.x - from.x) * step / steps),
      y: Math.round(from.y + (to.y - from.y) * step / steps)});
  }
  await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 2});
  await hi.sleep(after);
}

/** 从整页 PNG 里裁出局部再 2x 最近邻放大（照 r1 探针；PS 单引号内反斜杠是字面量）。 */
const psCropZoom = (src, dst, x, y, w, h) => new Promise((resolve, reject) => {
  const cmd = [
    'Add-Type -AssemblyName System.Drawing',
    `$s=[System.Drawing.Bitmap]::FromFile('${src}')`,
    `$d=New-Object System.Drawing.Bitmap([int](${w}*2),[int](${h}*2))`,
    `$g=[System.Drawing.Graphics]::FromImage($d)`,
    `$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor`,
    `$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::Half`,
    `$g.DrawImage($s,(New-Object System.Drawing.Rectangle(0,0,$d.Width,$d.Height)),(New-Object System.Drawing.Rectangle(${x},${y},${w},${h})),[System.Drawing.GraphicsUnit]::Pixel)`,
    `$g.Dispose(); $d.Save('${dst}'); $d.Dispose(); $s.Dispose()`,
  ].join('; ');
  const child = spawn(POWERSHELL, ['-NoProfile', '-Command', cmd], {stdio: 'ignore'});
  child.on('exit', code => (code === 0 ? resolve() : reject(new Error('cropZoom exit ' + code))));
  child.on('error', reject);
});

/** 整页截图 + 局部 2x（CSS 坐标按实际 PNG 宽换算成图像像素）。 */
async function shot2x(session, name, rect) {
  const page = await session.shot(name + '-page');
  if (!rect) return page;
  const vp = await session.js('({w: innerWidth, h: innerHeight})');
  const head = fs.readFileSync(page);
  const imgW = head.readUInt32BE(16), imgH = head.readUInt32BE(20);
  const scale = imgW / vp.w;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const X = clamp(Math.round(rect.x * scale), 0, imgW - 10), Y = clamp(Math.round(rect.y * scale), 0, imgH - 10);
  const W = clamp(Math.round(rect.w * scale), 10, imgW - X), H = clamp(Math.round(rect.h * scale), 10, imgH - Y);
  const dst = path.join(OUT, name + '-2x.png');
  await psCropZoom(page, dst, X, Y, W, H);
  return dst;
}
const rectOf = (box, pad = 70) => box ? {x: box.l - pad, y: box.t - pad, w: box.w + pad * 2, h: box.h + pad * 2} : null;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  // 自报家门：副本里有没有本轮两处修复的指纹（没有 = 取红轮）。
  const copy = fs.readFileSync(path.join(harness.project, 'app/renderer/js/math-select-reveal.js'), 'utf8');
  const hasFix = {W2: copy.includes('if (event.detail > 1) { grab(); return; }'), D1: copy.includes("addEventListener('dragend'")};
  const exe = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const ctx = {
    launch: options => harness.launch({exe, appArgs: [path.join(harness.project, 'app/main/main.js')],
      label: 'probe-r2-reveal', outDir: OUT, timeout: 300000, ...options, args: options.args || []}),
    release: async session => { await session.close(); },
  };
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  const only = (process.argv.find(v => v.startsWith('--only=')) || '--only=W2,D1').slice(7).split(',');
  const want = name => only.includes(name);

  const run = async (name, fn) => {
    if (!want(name)) return;
    const file = path.join(OUT, name + '.md');
    fs.writeFileSync(file, DOC, 'utf8');
    const session = await hi.openDoc(ctx, file, {minBlocks: 4, settleMs: 1600});
    try {
      await hi.ensureFocus(session);
      let geo = await session.js(GEO);
      if (!geo.ok || !geo.w2 || !geo.d1 || geo.w2.w < 4 || geo.d1.w < 4) {
        await hi.sleep(1200);                    // KaTeX 偶尔晚一拍：再等一轮重读
        geo = await session.js(GEO);
      }
      if (!geo.ok || !geo.w2 || !geo.d1) { say(`R2RV ${name} FAIL ` + JSON.stringify({why: '素材未就绪', geo: {ok: geo.ok, w2: !!geo.w2, d1: !!geo.d1}})); return; }
      await fn(session, geo, name);
    } finally { await ctx.release(session); }   // 铁律 3：一个用例一个实例，结束立刻释放
  };

  say('被测渲染层副本 app/renderer/js/math-select-reveal.js 含本轮修复指纹：' + JSON.stringify(hasFix)
    + (hasFix.W2 && hasFix.D1 ? '（复验轮：两条应转绿）' : '（取证轮：W2/D1 预期红）'));

  // ── W2：展开浮框上双击起手拖到段尾 → 选区从公式延伸到松手点 ──
  await run('W2', async (session, g, name) => {
    // 1) 点折叠 $v$ 渲染结果 → 进入展开态（源码 + 浮出的预渲染框）
    await session.click(g.w2.x, g.w2.y);
    await hi.sleep(600);
    const 展开几何 = await session.js(GEO);      // 展开后重读：浮框盒 + 行尾锚点
    await shot2x(session, name + '-expanded', rectOf(展开几何.w2, 110));
    // 2) 浮框上双击起手（第二击不松）拖到行尾「较长」**右缘+2px** 松手。端点是字符级的：
    //    recover 的 focus / 原生扩展都来自 caretRangeFromPoint 一类的字符边界解析，松手点
    //    落在「较长」双字**中心**（=「较/长」交界）时端点停在交界前——复验红形态正是
    //    text 尾=「全程较」，差一个「长」。这不是产品滞后，是松手点精度：取目标字符右缘+2px，
    //    端点必盖过「长」。
    const 松手 = {x: 展开几何.较长.r + 2, y: 展开几何.较长.y};
    say('W2 判因读数：浮框=' + JSON.stringify(展开几何.w2) + ' 较长盒(l/r/y)='
      + JSON.stringify({l: 展开几何.较长.l, r: 展开几何.较长.r, y: 展开几何.较长.y}) + ' 松手=' + JSON.stringify(松手));
    await dblclickDrag(session, 展开几何.w2, 松手);
    const 后 = await session.js(READ_SEL);
    await shot2x(session, name + '-after-drag', rectOf(展开几何.较长, 110));
    const 含公式 = /[v$]/.test(后.text);                                   // 行内只有公式里有 v/$
    const 盖到段尾 = 后.text.includes('较长') || 后.text.includes('较长。');
    const 非折叠 = !后.collapsed && 后.len > 0;
    const 出了公式 = 后.end层 === '正文' || 后.end层 === '源码';             // 端点不在预览子树里
    const pass = 含公式 && 盖到段尾 && 非折叠 && 出了公式;
    say(`R2RV W2-dblclick-drag-from-float ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
      拖后: {len: 后.len, text: 后.text.slice(0, 60), collapsed: 后.collapsed, end层: 后.end层, recover: 后.recover, reveal: 后.reveal},
      判据: {含公式, 盖到段尾, 非折叠, 出了公式},
      红条件: '①老红（detail≥2 不摘围栏）：选区被关在公式内部、recover 判 native-ok 放弃；②精度红：端点盖不到松手点字符——松手点落在字符交界时端点停在交界前，所以松手点必须取目标字符右缘+2px'}));
  });

  // ── D1：dragdrop 之后状态收干净 → 再点公式右侧不进隐藏源码 ──
  await run('D1', async (session, g, name) => {
    // 1) 既有选区：从行首拖到公式之后，选区盖住折叠的 $p$
    await hi.drag(session, {x: g.相遇.x, y: g.相遇.y}, {x: g.一段.x, y: g.一段.y}, {steps: 6});
    await hi.sleep(400);
    const 既有 = await session.js(READ_SEL);
    // 2) 从公式 preview 上按下、拖既有选区到行尾松手——按下点在选中内容上，Chromium 走原生
    //    dragdrop：mouseup 不再派发，收尾事件是 dragend（这正是 D1 要清理的时机）
    await hi.drag(session, {x: g.d1.x, y: g.d1.y}, {x: g.一段.x, y: g.一段.y}, {steps: 6});
    await hi.sleep(600);
    const 态 = await session.js(READ_STATE);
    await shot2x(session, name + '-after-dragend', rectOf(g.d1, 110));
    // 3) 点公式右侧行尾：围栏若没还原，光标会解进隐藏源码
    await session.click(g.d1.r + 26, g.d1.y);
    await hi.sleep(400);
    const 光标 = await hi.caret(session);
    await shot2x(session, name + '-click-after', rectOf(g.d1, 110));
    const 围栏还原 = 态.d1previewCE === 'false';
    const 无POINTER = 态.pointer类 === false;
    const 光标不进源码 = 光标 && 光标.层 !== '源码' && !!光标.ok;
    const pass = 围栏还原 && 无POINTER && 光标不进源码;
    say(`R2RV D1-dragend-cleanup ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
      既有选区: {len: 既有.len, text: (既有.text || '').slice(0, 40)},
      dragend后态: 态,
      再点击光标: {层: 光标 && 光标.层, 前缀: 光标 && 光标.前缀, 块文本: 光标 && 光标.块文本},
      判据: {围栏还原, 无POINTER, 光标不进源码},
      红条件: '现状无 dragend 监听：contenteditable 缺失/null、POINTER 类残留，点公式右侧光标层=源码'}));
  });

  fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });
