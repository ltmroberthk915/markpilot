'use strict';
const { TextDecoder } = require('node:util');
const encodingError = message => Object.assign(new Error(message), { code: 'MP_ENCODING' });

function isBinary(bytes) {
  const head = bytes.subarray(0, 4096), b = i => head[i];
  const magic = (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47)
    || (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff)
    || (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46)
    || (b(0) === 0x42 && b(1) === 0x4d)
    || (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46)
    || (b(0) === 0x50 && b(1) === 0x4b)
    || (b(0) === 0x7f && b(1) === 0x45 && b(2) === 0x4c && b(3) === 0x46)
    || (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46)
    || (b(0) === 0 && b(1) === 0 && b(2) === 1 && b(3) === 0);
  let printable = 0;
  for (const c of head) if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 128) printable++;
  return magic || (head.includes(0) && head.length && printable / head.length < 0.8);
}

// Open and reload share strict decoding. Never invent replacement characters for bad bytes.
function decodeDocument(bytes, file = '') {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0)
    || (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff)) {
    throw encodingError('暂不支持 UTF-32 文件，请先转换为 UTF-8 或带 BOM 的 UTF-16：' + file);
  }
  let encoding = 'utf8', bom = false, body = bytes;
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    encoding = bytes[0] === 0xff ? 'utf16le' : 'utf16be'; bom = true; body = bytes.subarray(2);
    if (body.length % 2) throw encodingError('UTF-16 文件字节数不完整，已停止打开以保护原文件：' + file);
  } else {
    if (isBinary(bytes)) throw Object.assign(new Error('这是一个二进制文件，MarkPilot 只打开文本文件：' + file), { code: 'MP_BINARY' });
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { bom = true; body = bytes.subarray(3); }
  }
  let text;
  try {
    // BOM bytes were removed explicitly; another U+FEFF is real document content.
    text = new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding === 'utf16le' ? 'utf-16le' : 'utf-16be', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw encodingError('文件不是完整有效的 ' + (encoding === 'utf8' ? 'UTF-8' : 'UTF-16') + ' 文本，已停止打开以保护原文件：' + file);
  }
  const crlf = (text.match(/\r\n/g) || []).length, lf = (text.match(/\n/g) || []).length;
  const eol = crlf > 0 && crlf >= lf - crlf ? '\r\n' : '\n';
  return { text: text.replace(/\r\n/g, '\n'), bom, eol, encoding };
}

function encodeDocument(text, { bom = false, eol = '\n', encoding = 'utf8' } = {}) {
  if (!['utf8', 'utf16le', 'utf16be'].includes(encoding)) throw encodingError('不支持的保存编码：' + encoding);
  // Buffer.from silently repairs invalid UTF-8 strings but can emit invalid UTF-16.
  // Refuse both, retaining the editor draft and previous disk bytes.
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw encodingError('文档包含不完整的 Unicode 字符，已停止保存。请删除该字符后重试或撤销最近输入。');
    } else if (c >= 0xdc00 && c <= 0xdfff) throw encodingError('文档包含不完整的 Unicode 字符，已停止保存。请删除该字符后重试或撤销最近输入。');
  }
  const value = (bom ? '\ufeff' : '') + (eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text);
  const bytes = Buffer.from(value, encoding === 'utf8' ? 'utf8' : 'utf16le');
  return encoding === 'utf16be' ? bytes.swap16() : bytes;
}

module.exports = { decodeDocument, encodeDocument };
