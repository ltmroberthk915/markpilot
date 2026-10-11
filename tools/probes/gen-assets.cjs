/** 验收集夹具资源生成器（纯 node，无第三方依赖）
 *  产出：
 *    assets/small.png   96×64  彩色棋盘＋斜条（给人眼看"这就是那张测试图"）
 *    assets/big.png     560×400 大图（图案 + 逐像素噪声 ⇒ PNG 压不动 ⇒ base64 ≥ 800KB）
 *    assets/my 图.png    small.png 的副本（给"带空格的路径"那条用）
 *    assets/uris.json    { small, big, bigBytes, bigUriLen }
 *  用法：node gen-assets.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const DIR = __dirname;
const ASSETS = path.join(DIR, 'assets');

/* ── 极简 PNG 编码器（8bit RGB / 无隔行 / filter 0）── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                                  // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8bit / truecolor / deflate / adaptive / no-interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* 确定性伪随机（noise 要可复现，不许每次不同） */
function lcg(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

/** 小图：4 象限彩色 + 斜条 + 黑色边框，任何缩放下一眼可辨 */
function makeSmall(w, h) {
  const buf = Buffer.alloc(w * h * 3);
  const palette = [[38, 139, 210], [133, 153, 0], [211, 54, 130], [203, 75, 22]];  // 蓝 / 橄榄 / 洋红 / 橙
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const q = (y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1);
      let [r, g, b] = palette[q];
      if (((x + y) % 16) < 4) { r = Math.min(255, r + 40); g = Math.min(255, g + 40); b = Math.min(255, b + 40); }
      if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) { r = g = b = 16; }
      const i = (y * w + x) * 3;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
    }
  }
  return encodePNG(w, h, buf);
}

/** 大图：象限色底 + **真随机**逐像素噪声（LCG 低比特有结构，deflate 能吃掉 ⇒ 必须用 crypto）
 *  ⇒ PNG 基本压不动（base64 稳过 800KB）。再叠一条可视斜纹，证明"图真解码了"而不是占位块。 */
function makeBig(w, h) {
  const noise = crypto.randomBytes(w * h * 3);
  const buf = Buffer.alloc(w * h * 3);
  const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const q = (y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1);
      const base = [[70, 130, 180], [120, 160, 60], [190, 90, 130], [210, 120, 40]][q];
      const band = (((x + y) % 64) < 8) ? -40 : 0;
      const i = (y * w + x) * 3;
      for (let k = 0; k < 3; k++) buf[i + k] = cl(base[k] * 0.30 + (noise[i + k] - 128) * 0.90 + band + 128 * 0.7);
    }
  }
  return encodePNG(w, h, buf);
}

fs.mkdirSync(ASSETS, { recursive: true });
const small = makeSmall(96, 64);
const big = makeBig(560, 400);
fs.writeFileSync(path.join(ASSETS, 'small.png'), small);
fs.writeFileSync(path.join(ASSETS, 'big.png'), big);
fs.writeFileSync(path.join(ASSETS, 'my 图.png'), small);           // 带空格的相对路径夹具目标

const uri = (b) => 'data:image/png;base64,' + b.toString('base64');
const out = { small: uri(small), big: uri(big), smallBytes: small.length, bigBytes: big.length, bigUriLen: uri(big).length };
fs.writeFileSync(path.join(ASSETS, 'uris.json'), JSON.stringify(out), 'utf8');

console.log('small.png =', small.length, 'B → data URI', out.small.length, '字符');
console.log('big.png   =', big.length, 'B → data URI', out.bigUriLen, '字符', out.bigUriLen >= 800 * 1024 ? '✓ ≥800KB' : '✗ 不足 800KB');
console.log('写出:', path.join(ASSETS, 'small.png'), '|', path.join(ASSETS, 'big.png'), '|', path.join(ASSETS, 'my 图.png'), '| uris.json');
