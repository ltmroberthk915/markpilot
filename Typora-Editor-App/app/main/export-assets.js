'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {fileURLToPath} = require('node:url');
const {mimeOf} = require('./server');
const MAX_IMAGE = 20 * 1024 * 1024, MAX_TOTAL = 100 * 1024 * 1024;
const imageMime = value => /^image\/(?:png|jpeg|gif|webp|svg\+xml|avif|bmp|x-icon)$/i.test(value);

function imageFile(source, documentFile, origin) {
  if (/^[a-z]:[\\/]/i.test(source)) return source;
  if (source.startsWith('file:')) return fileURLToPath(source);
  let url; try { url = new URL(source); } catch {}
  if (url?.hostname === 'file+.vscode-resource.vscode-cdn.net') return decodeURIComponent(url.pathname.slice(1));
  if (url?.origin === origin) {
    if (url.pathname.startsWith('/ws-file/')) return decodeURIComponent(url.pathname.slice(9));
    if (url.pathname.startsWith('/ws/')) {
      const rest = url.pathname.slice(4), slash = rest.indexOf('/');
      if (slash < 0) throw new Error('图片路径无效');
      const rel = decodeURIComponent(rest.slice(slash + 1));
      return /^[a-z]:[\\/]/i.test(rel) ? rel : path.resolve(decodeURIComponent(rest.slice(0, slash)), rel);
    }
    throw new Error('不支持的本地资源地址');
  }
  if (url || source.startsWith('//')) return null;
  // URL encoding and #/? fragments follow Markdown image URL semantics.
  return path.resolve(path.dirname(documentFile), decodeURIComponent(source.split(/[?#]/, 1)[0]));
}

async function embedImages(sources, {file, origin, signal}) {
  const assets = {}, warnings = [];
  let total = 0, next = 0;
  const unique = [...new Set(sources)];
  async function one(source) {
    signal?.throwIfAborted();
    try {
      let bytes, mime;
      if (source.startsWith('data:')) {
        mime = /^data:([^;,]+)/.exec(source)?.[1];
        if (!imageMime(mime || '') || source.length > MAX_IMAGE * 1.4) throw new Error('图片格式或大小不受支持');
        total += source.length;
        if (total > MAX_TOTAL) throw new Error('图片总大小超过 100 MB');
        assets[source] = source; return;
      }
      const local = imageFile(source, file, origin);
      if (local) {
        mime = mimeOf(local).split(';')[0];
        if (!imageMime(mime)) throw new Error('不支持的图片格式');
        const stat = await fs.stat(local);
        if (!stat.isFile() || stat.size > MAX_IMAGE) throw new Error('图片超过 20 MB 或不是文件');
        bytes = await fs.readFile(local, {signal});
      } else {
        const url = new URL(source.startsWith('//') ? 'https:' + source : source);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('不支持的图片地址');
        // Node fetch has no Electron session headers, cookies, or API keys.
        const response = await fetch(url, {signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)])});
        mime = (response.headers.get('content-type') || '').split(';')[0];
        if (!response.ok || !imageMime(mime)) {await response.body?.cancel();throw new Error('图片下载失败或格式不受支持');}
        const parts = [];let length = 0;
        for await (const part of response.body) {length += part.length;if (length > MAX_IMAGE) throw new Error('图片超过 20 MB');parts.push(part);}
        bytes = Buffer.concat(parts);
      }
      total += bytes.length;
      if (total > MAX_TOTAL) throw new Error('图片总大小超过 100 MB');
      assets[source] = `data:${mime};base64,${bytes.toString('base64')}`;
    } catch (error) {
      signal?.throwIfAborted();
      warnings.push(`图片未能嵌入：${source.slice(0, 160)}（${error.message}）`);
    }
  }
  await Promise.all(Array.from({length: Math.min(4, unique.length)}, async () => {while(next < unique.length) await one(unique[next++]);}));
  return {assets, warnings};
}

let cssCache;
async function exportStyles(rendererRoot, shellRoot) {
  if (cssCache) return cssCache;
  const files = ['cdn/vditor/dist/index.css', 'cdn/vditor/dist/css/content-theme/light.css', 'cdn/vditor/dist/js/highlight.js/styles/github.min.css', 'cdn/vditor/dist/js/katex/katex.min.css'];
  const result = [];
  for (const rel of files) {
    const file = path.join(rendererRoot, rel);let css = await fs.readFile(file, 'utf8');
    const urls = [...new Set([...css.matchAll(/url\(([^)]+)\)/g)].map(match => match[1]))];
    for (const raw of urls) {
      const value = raw.trim().replace(/^['"]|['"]$/g, '');
      if (value.startsWith('data:') || value.startsWith('#')) continue;
      const resource = path.resolve(path.dirname(file), value.split(/[?#]/)[0]);
      if (!resource.startsWith(path.resolve(rendererRoot) + path.sep)) throw new Error('导出样式资源路径无效');
      const bytes = await fs.readFile(resource);
      css = css.split(`url(${raw})`).join(`url("data:${mimeOf(resource)};base64,${bytes.toString('base64')}")`);
    }
    result.push(css.replace(/\/\*# sourceMappingURL=.*?\*\//g, ''));
  }
  result.push(await fs.readFile(path.join(shellRoot, 'export.css'), 'utf8'));
  cssCache = result.join('\n');return cssCache;
}
module.exports = {embedImages, imageFile, imageMime, exportStyles};
