/** huge-doc 族 · 夹具生成器（第三波真实用户操作普查）
 *
 *  产物（全部落在 .mp-verify\checklist\huge-doc-fix\ 下，除对照臂从既有族拷入）：
 *   fix-1mb.md            ≈1 MB 纯文本（无表格/无标题，纯段落墙）
 *   fix-100k-lines.md     恰好 100,000 行
 *   fix-oneline-500k.md   恰好 500,000 字符的**单行**（无换行）
 *   fix-1000img.md        1000 条图片引用（指向同目录真实 64×64 PNG）
 *   fix-500tables.md      500 个表格（每表 3 列 × 表头+分隔+2 行）
 *   fix-control-500l.md   对照臂：沿用 typing-perf-daily 的 daily500.pristine.md（同夹具同尺子可比）
 *   img-64.png            真实 PNG（zlib 手写，64×64 RGB）
 *   manifest.json         每个夹具的 bytes/chars/lines/maxLineChars/sha16 + 结构自证
 *
 *  自证（生成即断言，不合格直接 exit(1)，绝不产出"看着像"的夹具）：
 *   · 无 BOM、无 CR（readDoc 会把 CRLF 归一，夹具必须已经等效）
 *   · 无控制字符（<9 或 13..31）、无非 BMP 码元（保证 JS 字符数 = 引擎 doc.length）
 *   · 逐夹具结构断言（行数 / 单行长度 / 图片条数 / 表格个数 / 字节数区间）
 *
 *  用法：node huge-doc-mkfix.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const R = require(path.join(__dirname, '_probe-common.cjs'));

const DIR = path.join(__dirname, 'huge-doc-fix');
const DAILY = path.join(__dirname, '..', 'typing-perf-daily', 'fixture', 'daily500.pristine.md');

/** 结构自证：控制字符 / 非 BMP / BOM / CR 全扫一遍 */
function audit(text) {
  const bad = { ctrl: 0, astral: 0, bom: text.charCodeAt(0) === 0xfeff, cr: 0 };
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) bad.cr++;
    else if (c < 9 || (c > 13 && c < 32) || c === 127) bad.ctrl++;
    else if (c >= 0xd800 && c <= 0xdfff) bad.astral++;
  }
  return bad;
}
function emit(name, text, extra = {}) {
  const file = path.join(DIR, name);
  fs.writeFileSync(file, text, 'utf8');
  const back = fs.readFileSync(file, 'utf8');
  const a = audit(back);
  const lines = back.split('\n');
  const maxLineChars = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const m = {
    file: name, bytes: fs.statSync(file).size, chars: back.length, lines: lines.length,
    maxLineChars, sha16: R.sha16(file), audit: a, ...extra,
  };
  const problems = [];
  if (a.ctrl || a.cr || a.astral || a.bom) problems.push('字符集自证不合格 ' + JSON.stringify(a));
  if (back.length !== text.length) problems.push('回读长度不符 ' + back.length + ' ≠ ' + text.length);
  if (m.bytes !== Buffer.byteLength(back, 'utf8')) problems.push('字节数不符');
  for (const [k, v] of Object.entries(extra)) {
    if (k.startsWith('want') && v !== undefined) {
      const real = m[k.slice(4, 5).toLowerCase() + k.slice(5)];
      if (real !== v) problems.push(`结构断言失败 ${k}=${v} 实际 ${real}`);
    }
  }
  if (problems.length) { console.error('✗ ' + name + '：' + problems.join('；')); process.exit(1); }
  console.log(`[夹具] ${name} ${m.bytes} B / ${m.chars} 字符 / ${m.lines} 行 / 最长行 ${m.maxLineChars} / sha16=${m.sha16}${extra.note ? '  ' + extra.note : ''}`);
  return m;
}

/* ── PNG（64×64 纯色带网格，手写 zlib；不引第三方库） ── */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function makePng(W, H) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    const off = y * (W * 3 + 1);
    raw[off] = 0;
    for (let x = 0; x < W; x++) {
      const p = off + 1 + x * 3;
      raw[p] = (x * 4) & 0xff; raw[p + 1] = (y * 4) & 0xff; raw[p + 2] = ((x ^ y) * 2) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const M = { at: new Date().toISOString(), dir: DIR, items: [] };

/* ══ ① 1 MB 纯文本 ══ */
{
  const zh = '马克笔编辑器在处理超大文档时需要保持输入响应与滚动流畅度这是一段用来撑起体积的中文段落';
  let s = '', i = 0;
  while (Buffer.byteLength(s, 'utf8') < 1000000) {
    i++;
    s += zh.repeat(2) + '\n';                                          // 1 行中文（约 3×84=252 B）
    s += 'The quick brown fox jumps over the lazy dog 0123456789 abcdefghij. '.repeat(2) + '\n'; // 1 行英文
    s += '\n';
  }
  M.items.push(emit('fix-1mb.md', s, { kind: 'plain-1mb', paragraphs: i, note: `≈1 MB 纯文本（${i} 段）` }));
}

/* ══ ② 10 万行 ══ */
{
  const mk = (n) => { const L = []; for (let i = 1; i <= n; i++) L.push('L' + String(i).padStart(6, '0') + ' quick brown fox 0123456789'); return L.join('\n') + '\n'; };
  M.items.push(emit('fix-100k-lines.md', mk(100000), { kind: 'lines-100k', wantLines: 100001, note: '10 万行（末行空）' }));
  /* 行数扫描臂：用来判"每键延迟随行数增长"是不是真的（定向枚举，不靠单点外推） */
  M.items.push(emit('fix-50k-lines.md', mk(50000), { kind: 'lines-50k', wantLines: 50001, note: '5 万行（行数扫描臂）' }));
  M.items.push(emit('fix-25k-lines.md', mk(25000), { kind: 'lines-25k', wantLines: 25001, note: '2.5 万行（行数扫描臂）' }));
  M.items.push(emit('fix-10k-lines.md', mk(10000), { kind: 'lines-10k', wantLines: 10001, note: '1 万行（行数扫描臂）' }));
}

/* ══ ③ 单行 50 万字符 ══ */
{
  const W = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
  let s = '';
  let k = 0;
  while (s.length < 500000) { s += (s ? ' ' : '') + W[k % W.length] + String(k % 1000); k++; }
  s = s.slice(0, 500000);
  if (/[\n\r]/.test(s)) { console.error('✗ 巨行夹具里出现了换行'); process.exit(1); }
  M.items.push(emit('fix-oneline-500k.md', s, { kind: 'one-line-500k', wantChars: 500000, wantLines: 1, note: '单行 50 万字符' }));
}

/* ══ ④ 1000 张图片引用 ══ */
{
  fs.writeFileSync(path.join(DIR, 'img-64.png'), makePng(64, 64));
  const L = ['# 图集（1000 张）', '', '首段文字：用于落光标与打字读数。', ''];
  for (let i = 1; i <= 1000; i++) L.push(`![img-${String(i).padStart(4, '0')}](img-64.png)`, '');
  L.push('尾段文字。', '');
  const t = L.join('\n');
  const imgs = (t.match(/!\[/g) || []).length;
  if (imgs !== 1000) { console.error('✗ 图片条数 ' + imgs); process.exit(1); }
  M.items.push(emit('fix-1000img.md', t, { kind: 'images-1000', images: imgs, note: '1000 条图片引用 → img-64.png (64×64 真 PNG)' }));
}

/* ══ ⑤ 500 个表格 ══ */
{
  const L = ['首段文字。', ''];
  for (let i = 1; i <= 500; i++) {
    const n = String(i).padStart(3, '0');
    L.push('### 表 ' + n, '');
    L.push('| 列A | 列B | 列C |', '| --- | --- | --- |');
    L.push(`| a${n}-1 | b${n}-1 | c${n}-1 |`, `| a${n}-2 | b${n}-2 | c${n}-2 |`, '');
  }
  const t = L.join('\n');
  const tables = (t.match(/\|\s*---\s*\|\s*---\s*\|\s*---\s*\|/g) || []).length;
  if (tables !== 500) { console.error('✗ 表格个数 ' + tables); process.exit(1); }
  M.items.push(emit('fix-500tables.md', t, { kind: 'tables-500', tables, note: '500 个表格' }));
}

/* ══ ⑥ 对照臂：既有族的小文档（同夹具，跨族可比） ══ */
{
  if (!fs.existsSync(DAILY)) { console.error('✗ 找不到对照臂母本 ' + DAILY); process.exit(1); }
  fs.copyFileSync(DAILY, path.join(DIR, 'fix-control-500l.md'));
  M.items.push(emit('fix-control-500l.md', fs.readFileSync(path.join(DIR, 'fix-control-500l.md'), 'utf8'), { kind: 'control-500l', note: '对照臂：typing-perf-daily 的 daily500（同夹具同尺子）' }));
}

fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(M, null, 1), 'utf8');
console.log('\n[清单] ' + path.join(DIR, 'manifest.json'));
console.log('[自证] 6 个夹具全部通过字符集/结构断言');
