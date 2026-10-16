import { resolveImageSource } from './image-path.js';

// A single-file export owns a bounded, operation-local map. Data URLs already
// in the source and remote links require no local IO. Aliases share one read.
export async function embedImageRefs(refs, directory, read, { totalLimit = 32 * 1024 * 1024, imageLimit = 16 * 1024 * 1024 } = {}) {
  const map = new Map(), seen = new Map(), failures = [];
  let bytes = 0, embedded = 0, remote = 0, existing = 0;
  for (const raw of refs) {
    if (/^data:/i.test(raw)) { existing++; continue; }
    const url = resolveImageSource(raw, directory);
    if (/^(?:https?:|\/\/)/i.test(url)) { remote++; continue; }
    if (!/^file:/i.test(url)) { failures.push({ src: raw, reason: '无法解析本地图片位置' }); continue; }
    let result = seen.get(url);
    if (!result) {
      try {
        const remaining = Math.min(imageLimit, totalLimit - bytes);
        if (remaining <= 0) throw new Error('图片内联总量超过 32 MB，请使用 HTML + 图片文件夹');
        result = await read(url, remaining);
        if (!result?.ok || !/^image\//i.test(result.mime || '') || !Number.isSafeInteger(result.bytes) || result.bytes < 0 || result.bytes > remaining) throw new Error(result?.error || '图片无法内联或超过大小限制');
        result = { uri: 'data:' + result.mime + ';base64,' + result.base64, bytes: result.bytes };
        bytes += result.bytes; embedded++;
      } catch (error) { result = { error: error.message }; }
      seen.set(url, result);
    }
    if (result.uri) map.set(raw, result.uri); else failures.push({ src: raw, reason: result.error });
  }
  return { map, summary: { images: refs.length, embedded, existing, remote, failed: failures.length, bytes, failures } };
}
