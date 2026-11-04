'use strict';
const { TextDecoder } = require('node:util');
const encodingError = message => Object.assign(new Error(message), { code: 'MP_ENCODING' });

function isBinary(bytes) {
  const head = bytes.subarray(0, 4096), b = i => head[i];
  const begins = value => head.length >= value.length && head.subarray(0, value.length).equals(Buffer.from(value, 'binary'));
  const bmp = begins('BM') && head.length >= 26 && head.readUInt16LE(6) === 0 && head.readUInt16LE(8) === 0
    && [12, 40, 52, 56, 64, 108, 124].includes(head.readUInt32LE(14));
  const magic = begins('\x89PNG\r\n\x1a\n')
    || (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff)
    || begins('GIF87a') || begins('GIF89a') || bmp
    || /^%PDF-\d\.\d/.test(head.subarray(0, 8).toString('ascii'))
    || begins('PK\x03\x04') || begins('PK\x05\x06') || begins('PK\x07\x08')
    || begins('\x7fELF')
    || (begins('RIFF') && head.length >= 12 && ['WEBP', 'WAVE', 'AVI '].includes(head.subarray(8, 12).toString('ascii')))
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
  const crlf = (text.match(/\r\n/g) || []).length, lf = (text.match(/\n/g) || []).length - crlf;
  const cr = (text.match(/\r/g) || []).length - crlf;
  const eol = crlf > 0 && crlf >= lf && crlf >= cr ? '\r\n' : cr > lf ? '\r' : '\n';
  return { text: text.replace(/\r\n?|\n/g, '\n'), bom, eol, encoding };
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
  const lineBreak = ['\n', '\r\n', '\r'].includes(eol) ? eol : '\n';
  const value = (bom ? '\ufeff' : '') + text.replace(/\r\n?|\n/g, lineBreak);
  const bytes = Buffer.from(value, encoding === 'utf8' ? 'utf8' : 'utf16le');
  return encoding === 'utf16be' ? bytes.swap16() : bytes;
}

module.exports = { decodeDocument, encodeDocument };
