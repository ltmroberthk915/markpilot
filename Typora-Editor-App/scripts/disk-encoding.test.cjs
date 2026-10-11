'use strict';
/** 磁盘编码判定的单元测试（无 GUI，`node --test` 直接跑）。
 *
 *  最要紧的一条是**可写 ⇒ 字节可还原**：凡是被判成 writable 的文件，把解码出的文本按
 *  UTF-8 重新编码必须与磁盘原始字节逐字节相同。这条一破，就等于"我们声称安全、实际在改写"。
 *
 *  用法：node --test scripts/disk-encoding.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert');
const { readText } = require('../app/main/disk-encoding.js');

const ZH = '中文段落 $a+b$ 与 emoji 🙂';
const FIXTURES = {
  '纯 UTF-8': Buffer.from(ZH, 'utf8'),
  'UTF-8 带 BOM': Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(ZH, 'utf8')]),
  'UTF-16LE 带 BOM': Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(ZH, 'utf16le')]),
  'UTF-16BE 带 BOM': Buffer.concat([Buffer.from([0xFE, 0xFF]), (() => { const le = Buffer.from(ZH, 'utf16le'); le.swap16(); return le; })()]),
  'GBK 字节（非法 UTF-8）': Buffer.concat([Buffer.from([0xD6, 0xD0, 0xCE, 0xC4]), Buffer.from(' 结尾', 'utf8')]),
  'UTF-8 但含 NUL': Buffer.from('abc\u0000def', 'utf8'),
  '空文件': Buffer.alloc(0),
  '只有 ASCII 与 CRLF': Buffer.from('a\r\nb\r\n', 'utf8'),
};

test('可写 ⇒ 按 UTF-8 重新编码与原始字节逐字节相同', () => {
  for (const [name, buffer] of Object.entries(FIXTURES)) {
    const { text, encoding } = readText(buffer);
    if (!encoding.writable) continue;
    assert.deepStrictEqual(Buffer.from(text, 'utf8'), buffer, `${name}：判定为可写，但重新编码不等于原字节`);
  }
});

test('UTF-16LE 带 BOM：解码无损（用户看到真实内容），但禁止写回', () => {
  const { text, encoding } = readText(FIXTURES['UTF-16LE 带 BOM']);
  assert.strictEqual(text, ZH, '解码结果应当与原文完全一致');
  assert.strictEqual(encoding.writable, false, 'UTF-16LE 不该被判成可写');
  assert.match(encoding.name, /UTF-16LE/);
  assert.strictEqual(text.includes('\uFFFD'), false, '无损解码不该产生替换字符');
});

test('UTF-16BE 带 BOM：同样无损解码且禁止写回', () => {
  const { text, encoding } = readText(FIXTURES['UTF-16BE 带 BOM']);
  assert.strictEqual(text, ZH);
  assert.strictEqual(encoding.writable, false);
  assert.match(encoding.name, /UTF-16BE/);
});

test('非法 UTF-8：禁止写回，且如实报出损坏处数', () => {
  const { text, encoding } = readText(FIXTURES['GBK 字节（非法 UTF-8）']);
  assert.strictEqual(encoding.writable, false, '非法 UTF-8 必须被判成不可写');
  assert.match(encoding.name, /非 UTF-8/);
  assert.ok((text.match(/\uFFFD/g) || []).length >= 2, '应当在文本里如实留下替换字符');
  assert.match(encoding.detail, /[1-9]\d* 处/, '详情里要告诉用户坏了多少处');
});

test('合法 UTF-8 但含 NUL：判成不可写（多半是无 BOM 的 UTF-16）', () => {
  const { encoding } = readText(FIXTURES['UTF-8 但含 NUL']);
  assert.strictEqual(encoding.writable, false);
  assert.match(encoding.name, /NUL/);
});

test('UTF-8 带 BOM 保持可写，且 BOM 字符留在文本里（场景 77 的既有口径）', () => {
  const { text, encoding } = readText(FIXTURES['UTF-8 带 BOM']);
  assert.strictEqual(encoding.writable, true);
  assert.strictEqual(text.codePointAt(0), 0xFEFF, 'BOM 必须留在文本首位，否则保存时会丢 BOM');
});

test('普通 UTF-8 与空文件都是可写的', () => {
  for (const name of ['纯 UTF-8', '空文件', '只有 ASCII 与 CRLF']) {
    assert.strictEqual(readText(FIXTURES[name]).encoding.writable, true, `${name} 应当可写`);
  }
});

test('非 Buffer 输入直接报错，不做猜测', () => {
  assert.throws(() => readText('中文字符串'), /Buffer/);
});
