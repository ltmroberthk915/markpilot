/** 权威尺子：用 **Chromium 内置 PDF 阅读器**打开导出的 PDF，截图并采样四角/多点像素
 *  —— 这才是"用户打开 PDF 看到什么" ✓（pdftoppm 会把透明区渲成黑 ✗，是栅格化假象）
 *  用法：node probe-pdf-view.cjs "<pdf路径>" ["<输出png>"]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../quality/dependencies.cjs').playwright();
const PDF = process.argv[2];
const OUT = process.argv[3] || path.join(path.dirname(PDF), 'view.png');
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1000, height: 1300 } });
  await page.goto('file:///' + PDF.replace(/\\/g, '/'), { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: OUT });
  /* 采样截图（用 Chromium 自己解码，避免我再写 PNG 解析） */
  const samples = await page.evaluate(async () => {
    const img = document.querySelector('img');   // PDF 阅读器把页面渲成 <img> 或 canvas
    const cv = document.querySelector('canvas');
    const el = cv || img;
    if (!el) return { 错误: '没找到渲染元素', 标签: [...document.querySelectorAll('*')].slice(0, 8).map((e) => e.tagName) };
    const w = el.naturalWidth || el.width, h = el.naturalHeight || el.height;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.drawImage(el, 0, 0);
    const px = (x, y) => { const d = g.getImageData(Math.round(x), Math.round(y), 1, 1).data; return [d[0], d[1], d[2]]; };
    const pts = {
      左上: px(w * 0.02, h * 0.02), 右上: px(w * 0.98, h * 0.02),
      左下: px(w * 0.02, h * 0.98), 右下: px(w * 0.98, h * 0.98),
      正中: px(w * 0.5, h * 0.5), 上中: px(w * 0.5, h * 0.06),
    };
    /* 全图"接近白"的像素占比 —— 判"这张纸是不是白的" */
    let white = 0, tot = 0;
    const d = g.getImageData(0, 0, w, h).data;
    for (let i = 0; i < d.length; i += 4 * 17) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; if (l > 230) white++; tot++; }
    return { 标签: el.tagName, 尺寸: w + 'x' + h, 采样: pts, 近白占比: +(white / tot).toFixed(3) };
  }).catch((e) => ({ 错误: String(e.message) }));
  console.log(JSON.stringify({ PDF, 截图: OUT, 阅读器读数: samples }, null, 1));
  await b.close();
})();
