'use strict';
// Shared preflight runs before renderer IPC and again before native staging.
const LIMITS = Object.freeze({ imageBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, imageChars: 48 * 1024 * 1024, totalChars: 192 * 1024 * 1024 });
const extensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp', 'image/svg+xml': '.svg', 'image/avif': '.avif', 'image/x-icon': '.ico', 'image/tiff': '.tif' };
const ASSET_LIMITS = Object.freeze({ ...LIMITS, imageBytes: 32 * 1024 * 1024, imageChars: 96 * 1024 * 1024 });
function imageExtension(mime) { const key=String(mime || '').split(';')[0].trim().toLowerCase();return Object.hasOwn(extensions,key)?extensions[key]:null; }
const fail = message => { throw Object.assign(new Error(message), { code: 'MP_EXPORT_DATA_IMAGE' }); };
const whitespace = c => c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
function planImages(refs, limits, ceiling) {
  const cap = Object.fromEntries(Object.keys(ceiling).map(k => [k, Math.min(ceiling[k], limits[k] ?? ceiling[k])]));
  const plans = new Map(); let totalBytes = 0, totalChars = 0;
  for (const raw of refs || []) {
    const text = String(raw).trim();
    const src = text.startsWith('<') && text.endsWith('>') ? text.slice(1, -1) : text;
    if (!/^data:/i.test(src) || plans.has(src)) continue;
    if (src.length > cap.imageChars || src.length > cap.totalChars - totalChars) fail('内联图片编码数据超过导出上限');
    totalChars += src.length;
    const comma = src.indexOf(',');
    if (comma < 0 || comma > 256) fail('内联图片地址无效');
    const meta = src.slice(5, comma).split(';'), mime = meta[0].toLowerCase(), ext = imageExtension(mime);
    if (!ext) fail('不支持的内联图片类型：' + mime);
    const base64 = meta.slice(1).some(p => p.toLowerCase() === 'base64'), body = src.slice(comma + 1);
    let bytes = 0;
    if (base64) {
      let symbols = 0, padding = 0;
      for (let i = 0; i < body.length; i++) {
        const c = body.charCodeAt(i);
        if (whitespace(c)) continue;
        if (c === 61) { if (++padding > 2) fail('内联图片 base64 编码无效'); continue; }
        if (padding || !(c >= 65 && c <= 90 || c >= 97 && c <= 122 || c >= 48 && c <= 57 || c === 43 || c === 47)) fail('内联图片 base64 编码无效');
        symbols++;
      }
      if (symbols % 4 === 1 || padding && (symbols + padding) % 4 !== 0) fail('内联图片 base64 长度无效');
      bytes = Math.floor(symbols * 6 / 8);
    } else {
      for (let i = 0; i < body.length; i++) {
        const c = body.charCodeAt(i);
        if (c === 37) { if (!/^[0-9a-f]{2}$/i.test(body.slice(i + 1, i + 3))) fail('内联图片百分号编码无效'); i += 2; bytes++; }
        else if (c < 128) bytes++;
        else if (c < 2048) bytes += 2;
        else if (c >= 0xd800 && c <= 0xdbff) { const low = body.charCodeAt(++i); if (!(low >= 0xdc00 && low <= 0xdfff)) fail('内联图片字符无效'); bytes += 4; }
        else if (c >= 0xdc00 && c <= 0xdfff) fail('内联图片字符无效');
        else bytes += 3;
      }
    }
    if (!bytes) fail('内联图片为空');
    if (bytes > cap.imageBytes || bytes > cap.totalBytes - totalBytes) fail('内联图片超过上限（单图 ' + cap.imageBytes / 1048576 + ' MB，总计 ' + cap.totalBytes / 1048576 + ' MB）');
    totalBytes += bytes; plans.set(src, { src, body, base64, bytes, ext, mime });
  }
  return plans;
}
const planDataImages = (refs, limits = LIMITS) => planImages(refs, limits, LIMITS);
const planAssetDataImages = (refs, limits = ASSET_LIMITS) => planImages(refs, limits, ASSET_LIMITS);
module.exports = { LIMITS, planDataImages, planAssetDataImages, imageExtension };
