/** 探针 · 用户报告：一行只有内嵌 base64 图片（`<img src="data:image/png;base64,…">`）时，
 *  打开后**图片变成超长代码**（整条标签原文显示出来）。
 *
 *  素材：`E:\temp1\新建 Markdown 文档.md` 的**副本**（.perf/repro-img-base64/copy.md，原件只读不动）。
 *  要读出来的事实：
 *    ① 这一行在编辑面里长什么样（DOM 元素类型 / 文本片段 / 有没有真的 <img> 元素 / 宽度高度）；
 *    ② 编辑器里的文本是**原始 base64** 还是 portable-images 掩码后的短 URL（口径差异）；
 *    ③ 同文件里 `![](data:...)` 形式的图片是否正常（对照组）。
 *
 *  用法：node scripts/acceptance/probe-repro-img-base64.cjs [--app=dev|installed]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/repro-img-base64');
const IF = hi.IF, SURFACE = hi.SURFACE;
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');

/** 找到含 `<img` 的那一块，把它的一切读出来。 */
const 查 = `(() => { const w = ${IF}, d = w.document; const s = d.querySelector('${SURFACE}');
  if (!s) return { 没编辑面: true };
  const 块们 = [...s.children];
  const 命中 = 块们.map((b, i) => ({ i, b, t: String(b.textContent || '') }))
    .filter(x => x.t.includes('<img') || x.b.querySelector('img'));
  return { 块数: 块们.length, 命中数: 命中.length, 命中: 命中.slice(0, 4).map(x => {
    const img = x.b.querySelector('img');
    const 盒子 = img ? img.getBoundingClientRect() : null;
    return { 块号: x.i, 标签: x.b.tagName, 类型: x.b.getAttribute('data-type') || '',
      文本头: x.t.slice(0, 90), 文本长: x.t.length,
      含base64原文: /data:image\\//i.test(x.t), 含缓存URL: /vscode-resource\\.vscode-cdn\\.net/i.test(x.t),
      有img元素: !!img, img盒子: 盒子 ? [Math.round(盒子.width), Math.round(盒子.height)] : null,
      img_src头: img ? String(img.getAttribute('src')).slice(0, 60) : null,
      内层结构: [...x.b.children].slice(0, 3).map(n => n.tagName + (n.getAttribute('data-type') ? '[' + n.getAttribute('data-type') + ']' : '') + ' 文本' + String(n.textContent || '').length),
      html头: String(x.b.innerHTML || '').slice(0, 160) };
  }) }; })()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const src = 'E:/temp1/新建 Markdown 文档.md';
  const file = path.join(OUT, 'copy.md');
  if (!fs.existsSync(file)) fs.copyFileSync(src, file);
  const exe = APP === 'dev' ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe' : APP;
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: APP === 'dev' ? [path.join(harness.project, 'app/main/main.js')] : [],
      label: 'probe-img-base64', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 8, settleMs: 2500 });
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  try {
    const 结构 = await session.js(查);
    say('【编辑面里含 <img> 的块】' + JSON.stringify(结构, null, 1).slice(0, 3000));
    // 该块**实际显示**的是源码还是图片：两个 pre 的 computed display + 节点展开类
    const 显隐 = await session.js(`(() => { const w = ${IF}, d = w.document; const s = d.querySelector('${SURFACE}');
      const 块 = [...s.children].find(b => String(b.textContent || '').includes('<img') || b.querySelector('img'));
      if (!块) return { 没找到: true };
      const 源码 = 块.querySelector('pre.vditor-ir__marker--pre, code[data-type="html-block"]');
      const 预览 = 块.querySelector('pre.vditor-ir__preview, .vditor-ir__preview');
      const img = 块.querySelector('img');
      const 样式 = n => n ? { display: w.getComputedStyle(n).display, 可见: !!(n.getBoundingClientRect().width && n.getBoundingClientRect().height),
        高: Math.round(n.getBoundingClientRect().height), 宽: Math.round(n.getBoundingClientRect().width) } : null;
      块.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = 块.getBoundingClientRect();
      return { 类: String(块.className), 展开: 块.classList.contains('vditor-ir__node--expand'),
        源码样式: 样式(源码), 预览样式: 样式(预览), img样式: 样式(img),
        块盒: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        块内文本头: String(块.textContent || '').slice(0, 80) }; })()`);
    say('\n【这一块实际显示的是谁】' + JSON.stringify(显隐, null, 1));
    await harness.sleep(400);
    if (显隐.块盒) {
      const 框 = await session.js(`(() => { const f = document.getElementById('editor'); const r = f.getBoundingClientRect();
        const s = ${IF}.document.querySelector('${SURFACE}'); const 块 = [...s.children].find(b => String(b.textContent || '').includes('<img') || b.querySelector('img'));
        const b = 块.getBoundingClientRect();
        return { x: Math.round(r.x + b.left) - 8, y: Math.round(r.y + b.top) - 8, width: Math.round(b.width) + 16, height: Math.round(b.height) + 16 }; })()`);
      const png = await session.send('Page.captureScreenshot', { format: 'png', clip: { ...框, scale: 2 } });
      fs.writeFileSync(path.join(OUT, 'img-块-2倍.png'), Buffer.from(png.data, 'base64'));
      say('（局部 2 倍图：img-块-2倍.png）');
    }
    // 磁盘口径对照
    const raw = fs.readFileSync(file, 'utf8');
    say('\n【磁盘原文件】含 data:image 的行的形态：');
    for (const [i, line] of raw.split('\n').entries()) {
      if (!/data:image\//i.test(line)) continue;
      const 是标签 = /^\s*<img\b/i.test(line), 是markdown图 = /!\[[^\]]*\]\(/.test(line);
      say(`   第${i + 1}行 长${line.length}  ${是标签 ? 'HTML <img> 标签' : 是markdown图 ? 'Markdown ![]()' : '其它'}  ${line.slice(0, 60)}…`);
    }
    await session.shot('img-base64-打开后');
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
    await ctx.release(session);
  }
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });
