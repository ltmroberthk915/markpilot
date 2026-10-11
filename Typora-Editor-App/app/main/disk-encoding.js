'use strict';
/** 磁盘字节 → 文本，并判定**这份编码能不能安全写回**。
 *
 *  为什么必须单独做这件事（2026-09-17 定位）：打开时是 `fsp.readFile(file,'utf8')`，
 *  没有 BOM 判定、没有合法性校验。于是 UTF-16 / GBK / Shift-JIS 的 `.md` 被按 UTF-8
 *  **有损**解码成一片 U+FFFD，而默认开启的 1.5 秒自动保存又把这片乱码写回原文件——
 *  用户的文件当场永久损坏，全程没有任何提示。VSIX 侧没有这个问题（走 VS Code 自己的
 *  编码处理），所以这是桌面端独有的静默数据损坏路径。
 *
 *  判定规则（**只写 UTF-8，所以"不是 UTF-8"就必须被认出来**）：
 *
 *  | 磁盘形态 | 解码 | 能否写回 | 理由 |
 *  |---|---|---|---|
 *  | UTF-8（含 BOM） | 精确 | **可以** | BOM 是 U+FEFF，留在文本里，按 UTF-8 写回即还原字节 |
 *  | UTF-16LE / BE（带 BOM） | 精确 | 不可以 | 解码无损，但本产品只写 UTF-8；就地改写会换掉用户的编码 |
 *  | 非法 UTF-8（无 BOM） | **有损** | 不可以 | 解码已经产生 U+FFFD，写回即把损坏固化 |
 *  | 合法 UTF-8 但含 NUL | 精确 | 不可以 | 文本文件不该有 NUL；多半是无 BOM 的 UTF-16 或二进制 |
 *
 *  UTF-8 带 BOM 那条**故意不动**：现在 BOM 靠 U+FEFF 字符在文本里穿过去，场景 77 的
 *  逐字节断言守着这个行为。把 BOM 剥出来单独存会改变既有口径，不是这次要修的东西。
 */

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** 连续 U+FFFD 的个数（有损解码的损坏量；用于告知用户"坏了多少"）。 */
const damage = text => (text.match(/\uFFFD/g) || []).length;

/** UTF-16BE → LE：按 16 位整体交换后借 utf16le 解码。奇数尾字节按畸形文件丢弃。 */
const swap16 = buffer => {
  const even = buffer.length - (buffer.length % 2);
  const copy = Buffer.from(buffer.subarray(0, even));
  copy.swap16();
  return copy;
};

/**
 * @param {Buffer} buffer 磁盘原始字节
 * @returns {{text:string, encoding:{name:string,writable:boolean,detail:string}}}
 */
const readText = buffer => {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('readText 需要 Buffer');

  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return { text: buffer.toString('utf8'), encoding: { name: 'UTF-8（带 BOM）', writable: true, detail: '' } };
  }
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return { text: buffer.subarray(2).toString('utf16le'),
      encoding: { name: 'UTF-16LE', writable: false, detail: '这个文件是 UTF-16LE 编码（带 BOM），可以正常阅读，但 MarkPilot 只写 UTF-8。' } };
  }
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    return { text: swap16(buffer.subarray(2)).toString('utf16le'),
      encoding: { name: 'UTF-16BE', writable: false, detail: '这个文件是 UTF-16BE 编码（带 BOM），可以正常阅读，但 MarkPilot 只写 UTF-8。' } };
  }

  let text;
  try {
    text = utf8.decode(buffer);
  } catch {
    text = buffer.toString('utf8');
    return { text, encoding: { name: '非 UTF-8', writable: false,
      detail: `这个文件不是 UTF-8 编码，按 UTF-8 解读有 ${damage(text)} 处无法识别（会显示为乱码）。` } };
  }

  if (text.includes('\u0000')) {
    return { text, encoding: { name: '含 NUL 字节', writable: false,
      detail: '这个文件里含 NUL 字节，多半是 UTF-16（无 BOM）或二进制文件，不是纯文本。' } };
  }

  return { text, encoding: { name: 'UTF-8', writable: true, detail: '' } };
};

module.exports = { readText, damage };
