'use strict';
// Input is a validated plan from data-images.cjs. Percent bytes are binary,
// not necessarily UTF-8, so decodeURIComponent is not a suitable decoder.
function* dataImageChunks(info) {
  if (info.base64) {
    let part = '';
    for (let i = 0; i < info.body.length; i += 32768) {
      part += info.body.slice(i, i + 32768).replace(/[ \t\r\n\f]/g, '');
      const complete = part.length - part.length % 4;
      if (complete) { yield Buffer.from(part.slice(0, complete), 'base64'); part = part.slice(complete); }
    }
    if (part) yield Buffer.from(part, 'base64');
    return;
  }
  let buffer = Buffer.allocUnsafe(32768), offset = 0;
  for (let i = 0; i < info.body.length; i++) {
    const c = info.body.charCodeAt(i);
    if (c === 37 || c < 128) {
      buffer[offset++] = c === 37 ? parseInt(info.body.slice(i + 1, i + 3), 16) : c;
      if (c === 37) i += 2;
      if (offset === buffer.length) { yield buffer; buffer = Buffer.allocUnsafe(32768); offset = 0; }
      continue;
    }
    const cp = info.body.codePointAt(i), piece = Buffer.from(String.fromCodePoint(cp));
    if (cp > 0xffff) i++;
    for (const byte of piece) {
      buffer[offset++] = byte;
      if (offset === buffer.length) { yield buffer; buffer = Buffer.allocUnsafe(32768); offset = 0; }
    }
  }
  if (offset) yield buffer.subarray(0, offset);
}
function decodeAssetImage(value) {
  const plan = require('./data-images.cjs').planAssetDataImages([value]).get(value);
  if (!plan) throw Error('无效的内联图片');
  const buf = Buffer.concat([...dataImageChunks(plan)]);
  if (buf.length !== plan.bytes) throw Error('内联图片字节数不匹配');
  return {ok:true, buf, bytes:buf.length, mime:plan.mime};
}
module.exports={dataImageChunks,decodeAssetImage};
