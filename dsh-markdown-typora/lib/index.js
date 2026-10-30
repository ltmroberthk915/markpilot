// dsh-markdown-typora 宿主半边（DSH 0.2.1 契约版）：
//   renderer-cm6 静态路由 + 版本守卫编辑面 API（open/save/stat/edit）+ SSE watch + markdown 模型工具。
//
// 插件三件套形状（宿主 cordis loader 读的就是这个）：
//   export const name / export const inject / export function apply(ctx)
//
// 架构（见 README.md）：引擎 0 改动，插件只做 DSH 皮/桥/文件 IO。
//   · 静态资源来自插件根 renderer-cm6/（core-sync 从 EXE 构建产物逐字节同步）；
//   · 所有写都走 ctx.fs 的版本守卫（FS_STALE_VERSION 拒绝盲写，冲突不覆盖）；
//   · save 的 baseVersion 必填 —— 关 tab 的 keepalive flush 也一样，服务端不做"缺版本就无条件写"；
//   · 写成功后向所有 SSE 连接广播 version（客户端按 path 过滤 + 脏缓冲不覆盖）。
//
// 保留的既有不变量：
//   1. 信任栅栏：ctx.connection.requestRejection 可用就以方法形式调用；否则只放行 loopback。
//   2. body 上限 64MB：含内联图的 Markdown 十几 MB 在真实用户里常见（8MB 曾把 8.13MB 文档拒之门外）。
//   3. fs.watch 是 async（返回 close 函数）；不支持时降级为 2s 探测。旧实现把它当同步调用 ⇒
//      unhandled rejection + watcher 泄漏。这里 await 捕获并幂等 close。
//   4. 每个 async 分支都有 try/catch，错误以 {ok:false,error:{code,message}} 返回，code 原样透传。

import { readFile, stat as fsStat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, sep, extname } from 'node:path';

export const name = 'dsh-markdown-typora';

/** 必需服务：webServer（路由挂载点）+ fs（版本守卫读写）。 */
export const inject = ['webServer', 'fs'];

const ROUTE_PREFIX = '/dsh-markdown-typora';
const STATIC_PREFIX = ROUTE_PREFIX + '/renderer-cm6/';
const API_PREFIX = ROUTE_PREFIX + '/api/';
const IMG_PREFIX = ROUTE_PREFIX + '/img/';
const CORE_JSON_PATH = ROUTE_PREFIX + '/core.json';
const KNOWN_ENDPOINTS = new Set(['open', 'save', 'stat', 'edit']);
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/** 请求体上限：64MB。含内联图文档常见 10MB+；上限之外明确 413，不静默截断。 */
export const BODY_MAX_BYTES = 64 * 1024 * 1024;
/** 本地图片响应上限：与请求体同口径。超过只给 413，不把整块内容读进内存。 */
export const IMAGE_MAX_BYTES = 64 * 1024 * 1024;
const WATCH_DEBOUNCE_MS = 120;
const WATCH_PROBE_MS = 2000;
const SSE_HEARTBEAT_MS = 15000;

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = normalize(join(HERE, '..'));

/** 静态资源 MIME 表（含 CM6 引擎实际用到的 woff/woff2/ttf/wasm/map，以及 mermaid 的 svg/png）。 */
export const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

export function mimeFor(filePath) {
  return MIME_BY_EXT[extname(String(filePath)).toLowerCase()] ?? 'application/octet-stream';
}

/** ETag 由 size-mtime 组成（要求口径）；mtime 取整毫秒，避免频繁重建时抖动。 */
export function makeEtag(size, mtimeMs) {
  const s = Number.isFinite(Number(size)) ? Math.trunc(Number(size)) : 0;
  const m = Number.isFinite(Number(mtimeMs)) ? Math.trunc(Number(mtimeMs)) : 0;
  return `"${s}-${m}"`;
}

/** If-None-Match 匹配（支持 *、逗号列表、弱前缀 W/）。命中返回 304。 */
export function isNotModified(ifNoneMatch, etag) {
  if (typeof ifNoneMatch !== 'string' || ifNoneMatch.length === 0) return false;
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch
    .split(',')
    .map((part) => part.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === etag);
}

/**
 * 缓存策略：
 *   · 入口 HTML、app.js/app.css、dsh-*.js：no-cache（每次带 ETag 校验，拿 304）；
 *   · 字体（woff/woff2/ttf/otf/eot）：public, max-age=604800 —— 内容哈希文件名，长缓存安全；
 *   · 其余（worker/mermaid/图标）：no-cache + ETag。
 */
export function cacheControlFor(filePath) {
  const base = String(filePath).split(/[\\/]/).pop() ?? '';
  const ext = extname(base).toLowerCase();
  if (ext === '.woff' || ext === '.woff2' || ext === '.ttf' || ext === '.otf' || ext === '.eot') {
    return 'public, max-age=604800';
  }
  if (base === 'index.html' || base === 'app.js' || base === 'app.css' || /^dsh-[^/]*\.js$/i.test(base)) {
    return 'no-cache';
  }
  return 'no-cache';
}

/**
 * 把一个 URL 相对路径解析成 renderer-cm6 根内的绝对路径；越界/编码异常/盘符/空字节一律 null。
 * 这是路径穿越防护的唯一入口（纯函数，可被测试直接覆盖）。
 */
export function resolveStaticTarget(rootDir, rawRelative) {
  if (typeof rawRelative !== 'string') return null;
  let decoded;
  try {
    decoded = decodeURIComponent(rawRelative);
  } catch {
    return null;
  }
  if (decoded.length === 0) decoded = 'index.html';
  if (decoded.includes('\0')) return null;
  const slashed = decoded.replace(/\\/g, '/');
  if (slashed.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(slashed)) return null;
  const segments = slashed.split('/');
  if (segments.some((segment) => segment === '..')) return null;
  const root = normalize(rootDir);
  const target = normalize(join(root, slashed));
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

/* ══ 本地图片路由（文档相对路径图的取字节通道）══════════════════════════════════════
 * 为什么需要：CM6 引擎按"当前文档所在目录"解析相对图片路径（`image-path.js` 的
 * resolveImageSource）；桌面壳把它拼成 file:// 并靠 file 页面读盘。DSH 的编辑面是
 * **http 源**：CSP 的 img-src 不含 file:，Chromium 也禁止 http 页面加载 file:// 子资源
 * ⇒ 相对路径图必然"图片加载失败"。所以由插件提供唯一合法的本地图片通道：
 *   GET /dsh-markdown-typora/img/<绝对本地路径（逐段百分号编码，保留 /）>
 * 桥（renderer-cm6/dsh-bridge.js）在 open 时把 <base href> 指到
 *   /dsh-markdown-typora/img/<文档目录>/
 * ⇒ 引擎发出的相对 URL 原样落到本路由。浏览器按 RFC 3986 自己归一化 `../`，
 * 因此这里拿到的永远是规整的绝对路径。
 *
 * 安全边界（三条都必须成立，缺一即拒）：
 *   ① 形态：只接受盘符绝对路径（D:/x/y.png）或 UNC（//server/share/y.png），
 *      拒空段 / 单点 / 双点 / NUL / 坏编码 —— 归一化不靠浏览器，自己逐段验；
 *   ② 扩展名：图片白名单之外一律不服务（本路由不是通用文件服务）；
 *   ③ 只在既有信任栅栏之后（loopback + 宿主鉴权），且只读、只 GET/HEAD。
 * 说明：该读面不强于既有 /api/open（它本来就能读任意路径文本）。 */

/** 图片 MIME（本路由专用；比静态表窄，且不接受 fonts/wasm 之类）。 */
export const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function imageMimeFor(filePath) {
  return IMAGE_MIME_BY_EXT[extname(String(filePath)).toLowerCase()] ?? null;
}

/**
 * 把 URL 里 `/img/` 之后的剩余路径还原成**绝对本地路径**；不合规一律 null（纯函数）。
 * 规则见本节注释①。解码逐段进行：`%2e%2e` 解出来是 `..`，同样被拒。
 */
export function decodeImageRequestPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  const slashed = rawPath.replace(/\\/g, '/');
  let unc = false;
  let rest = slashed;
  if (rest.startsWith('//')) { unc = true; rest = rest.slice(2); }
  else if (rest.startsWith('/')) rest = rest.slice(1);
  if (rest.length === 0) return null;
  const segments = rest.split('/');
  const decoded = [];
  // Windows 设备名段（CON/NUL/COM1…）会被当成设备打开：读 CON 可能把请求挂住，
  // 所以连"图片扩展名"都不看，段一级直接拒。
  const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  for (const segment of segments) {
    let value;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (value.length === 0) return null;
    if (value === '.' || value === '..') return null;
    if (value.includes('\0')) return null;
    if (/[\\/]/.test(value)) return null;   // %2f/%5c 解出来的分隔符不许再切一层
    if (DEVICE_NAME.test(value)) return null;
    if (decoded.length > 0 && value.includes(':')) return null;   // 备用数据流（a.png:b）不收
    decoded.push(value);
  }
  if (decoded.length < 1) return null;
  let localPath;
  if (unc) {
    if (decoded.length < 2) return null;    // //server 后面至少还要有共享名
    localPath = '//' + decoded.join('/');
  } else {
    if (!/^[A-Za-z]:$/.test(decoded[0])) return null;   // 必须是盘符绝对路径
    if (decoded.length < 2) return null;
    localPath = decoded[0].toUpperCase() + '/' + decoded.slice(1).join('/');
  }
  if (!imageMimeFor(localPath)) return null;
  return normalize(localPath);
}

/** 服务一次本地图片请求：ETag/304、HEAD、大小上限、流式输出。返回是否已响应。 */
export async function serveImageFile(req, res, rawPath) {
  const method = req?.method === 'HEAD' ? 'HEAD' : 'GET';
  const target = decodeImageRequestPath(rawPath);
  if (!target) {
    sendText(res, 400, 'bad image path');
    return false;
  }
  let info;
  try {
    info = await fsStat(target);
  } catch (error) {
    sendText(res, error?.code === 'ENOENT' ? 404 : 500, error?.code === 'ENOENT' ? 'not found' : 'stat error');
    return false;
  }
  if (!info.isFile()) {
    sendText(res, 404, 'not found');
    return false;
  }
  if (info.size > IMAGE_MAX_BYTES) {
    sendText(res, 413, 'image too large');
    return false;
  }
  const etag = makeEtag(info.size, info.mtimeMs);
  const headers = {
    'content-type': imageMimeFor(target),
    'cache-control': 'no-cache',
    etag,
    'x-content-type-options': 'nosniff',
    // SVG 在 <img> 里不执行脚本，但**直接导航**（地址栏/window.open）时就是同源文档、脚本可跑。
    // 这条 CSP 对 <img> 渲染零影响，对文档导航把脚本/表单/子资源全部中和。
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
  };
  if (isNotModified(req.headers['if-none-match'], etag)) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  // 不写 content-length：stat 与流之间有 TOCTOU（文件被改写会截断/挂住）。
  // 交给 chunked 传输，浏览器按流读完即可。
  res.writeHead(200, headers);
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (settled) return; settled = true; resolve(); };
    const stream = createReadStream(target);
    stream.on('error', () => { try { res.destroy(); } catch { /* 已断 */ } done(); });
    stream.on('end', done);
    res.on('close', () => { try { stream.destroy(); } catch { /* 已断 */ } done(); });
    stream.pipe(res);
  });
  return true;
}

/** FsError 等错误的稳定码（分支认码不认文案；不许把 code 吞成 message）。 */
export function errorCode(error) {
  const code = error?.code ?? error?.cause?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  if (error?.name === 'AbortError') return 'FS_ABORTED';
  return 'fs-error';
}

function textBlock(text) {
  return [{ type: 'text', text: String(text ?? '') }];
}

function badRequest(message) {
  return { ok: false, error: { code: 'bad-request', message } };
}

function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return '';
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    return end > 0 ? hostHeader.slice(1, end).toLowerCase() : '';
  }
  return hostHeader.split(':')[0].toLowerCase();
}

/** loopback 兜底栅栏：Host 必须本机；跨站请求拒绝；有 Origin 时必须与 Host 同源。 */
export function isTrustedLoopbackRequest(req) {
  const host = req?.headers?.host;
  if (!host) return false;
  const hostname = hostnameOf(host);
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host.toLowerCase() === String(host).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * 读请求体，超限返回 {ok:false,code:'too-large'}；网络错误返回 {ok:false,code:'request-error'}。
 * 超限后暂停消费剩余数据（不把 64MB 之外的攻击流量继续读进内存）。
 */
export function readBody(req, limit = BODY_MAX_BYTES) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        chunks.length = 0;
        req.pause();
        finish({ ok: false, code: 'too-large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, buffer: Buffer.concat(chunks) }));
    req.on('error', () => finish({ ok: false, code: 'request-error' }));
    req.on('aborted', () => finish({ ok: false, code: 'request-error' }));
  });
}

function sendJson(res, status, value, extraHeaders) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (res.headersSent) {
    try { res.end(); } catch { /* 已断 */ }
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, status, text, extraHeaders) {
  if (res.headersSent) {
    try { res.end(); } catch { /* 已断 */ }
    return;
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...extraHeaders });
  res.end(text);
}

/**
 * 宿主核心：把 ctx 依赖收成一个可独立测试的对象。
 * @param {{fs:object, log?:object, rootDir?:string, bodyLimit?:number, watchDebounceMs?:number,
 *          watchProbeMs?:number, heartbeatMs?:number, connectionProvider?:() => any}} [options]
 */
export function createHost(options = {}) {
  const fs = options.fs;
  if (!fs || typeof fs.resolve !== 'function' || typeof fs.writeText !== 'function') {
    throw new Error('dsh-markdown-typora: a filesystem service (ctx.fs) is required');
  }
  const log = options.log ?? console;
  const rootDir = normalize(options.rootDir ?? PLUGIN_ROOT);
  const staticRoot = normalize(join(rootDir, 'renderer-cm6'));
  const coreJsonFile = normalize(join(rootDir, 'core.json'));
  const bodyLimit = options.bodyLimit ?? BODY_MAX_BYTES;
  const watchDebounceMs = options.watchDebounceMs ?? WATCH_DEBOUNCE_MS;
  const watchProbeMs = options.watchProbeMs ?? WATCH_PROBE_MS;
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const connectionProvider = typeof options.connectionProvider === 'function'
    ? options.connectionProvider
    : () => undefined;

  /** 每个被观察文件一条 entry；refs 计数到 0 才释放（SSE 多 tab 共享）。 */
  const watchers = new Map();
  /** 所有活着的 SSE 连接：{ res, targetKey }。广播按"所有连接"发出，客户端按 path 过滤。 */
  const liveStreams = new Set();

  function watchKeyOf(target) {
    return String(target?.targetKey ?? target?.displayPath ?? '');
  }

  function broadcastChange(target, version, delta) {
    const data = {
      path: target?.displayPath,
      targetKey: target?.targetKey,
      version: String(version ?? ''),
      ...(delta ? { delta: { oldString: String(delta.oldString ?? '').slice(0, 400), newString: String(delta.newString ?? '').slice(0, 400) } } : {}),
    };
    const frame = `event: change\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of liveStreams) {
      try {
        stream.res.write(frame);
      } catch { /* 连接已断，close 事件会清理 */ }
    }
  }

  async function tickWatch(entry, baseline = false) {
    if (entry.disposed) return;
    let version = '';
    let missing = false;
    try {
      const info = await fs.stat(entry.target);
      if (info === undefined) missing = true;
      else version = String(info.version ?? '');
    } catch {
      return;
    }
    if (entry.disposed) return;
    const changed = entry.lastVersion !== undefined && (missing || version !== entry.lastVersion);
    if (changed && !baseline) {
      if (entry.debounce) clearTimeout(entry.debounce);
      entry.debounce = setTimeout(() => {
        entry.debounce = null;
        if (!entry.disposed) broadcastChange(entry.target, version);
      }, watchDebounceMs);
      entry.debounce.unref?.();
    }
    if (!missing) entry.lastVersion = version;
  }

  async function startWatch(entry) {
    if (entry.started) return;
    entry.started = true;
    // FS.watch 是 async：resolve 为 close 函数；不支持时 reject（FS_IO_ERROR）。旧实现把它当
    // 同步调用且不 catch —— 这里必须 await 并保留 close，否则 watcher 泄漏 / unhandled rejection。
    try {
      const close = await fs.watch(entry.target, () => { void tickWatch(entry); }, entry.controller.signal);
      if (entry.disposed) {
        try { if (typeof close === 'function') await close(); } catch { /* 已停 */ }
        return;
      }
      entry.close = typeof close === 'function' ? close : null;
    } catch (error) {
      if (entry.disposed) return;
      log.warn?.('%s: fs.watch unavailable (%s) — SSE 退化为 %dms 探测', name, String(error?.message ?? error), watchProbeMs);
      entry.timer = setInterval(() => { void tickWatch(entry); }, watchProbeMs);
      entry.timer.unref?.();
    }
    await tickWatch(entry, true);
  }

  function ensureWatch(target) {
    const key = watchKeyOf(target);
    let entry = watchers.get(key);
    if (entry) {
      entry.refs += 1;
      return entry;
    }
    entry = {
      refs: 1,
      target,
      lastVersion: undefined,
      controller: new AbortController(),
      close: null,
      timer: null,
      debounce: null,
      disposed: false,
      started: false,
    };
    watchers.set(key, entry);
    void startWatch(entry);
    return entry;
  }

  function releaseWatch(target) {
    const key = watchKeyOf(target);
    const entry = watchers.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    watchers.delete(key);
    entry.disposed = true;
    try { entry.controller.abort(); } catch { /* 已停 */ }
    if (entry.timer) clearInterval(entry.timer);
    if (entry.debounce) clearTimeout(entry.debounce);
    const close = entry.close;
    entry.close = null;
    if (typeof close === 'function') {
      Promise.resolve().then(() => close()).catch(() => { /* close 失败不影响进程 */ });
    }
  }

  async function serveStatic(req, res, rawRelative) {
    const target = resolveStaticTarget(staticRoot, rawRelative);
    if (!target) {
      sendText(res, 403, 'forbidden');
      return;
    }
    let info;
    try {
      info = await fsStat(target);
    } catch (error) {
      sendText(res, error?.code === 'ENOENT' ? 404 : 500, error?.code === 'ENOENT' ? 'not found' : 'stat error');
      return;
    }
    let filePath = target;
    if (info.isDirectory()) {
      filePath = join(target, 'index.html');
      try {
        info = await fsStat(filePath);
      } catch {
        sendText(res, 404, 'not found');
        return;
      }
    }
    if (!info.isFile()) {
      sendText(res, 404, 'not found');
      return;
    }
    const etag = makeEtag(info.size, info.mtimeMs);
    const headers = {
      'content-type': mimeFor(filePath),
      'cache-control': cacheControlFor(filePath),
      etag,
      'x-content-type-options': 'nosniff',
    };
    if (isNotModified(req.headers['if-none-match'], etag)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    let data;
    try {
      data = await readFile(filePath);
    } catch {
      sendText(res, 500, 'read error');
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  async function serveCoreJson(req, res) {
    let data;
    try {
      data = await readFile(coreJsonFile);
    } catch (error) {
      // 不生成 core.json 的旧包也不能让客户端崩：明确 404 + 可诊断文案。
      sendJson(res, error?.code === 'ENOENT' ? 404 : 500, {
        ok: false,
        error: {
          code: error?.code === 'ENOENT' ? 'not-found' : 'fs-error',
          message: error?.code === 'ENOENT'
            ? 'core.json has not been generated yet (run scripts/sync-core.mjs)'
            : String(error?.message ?? error),
        },
      });
      return;
    }
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    try {
      const info = await fsStat(coreJsonFile);
      const etag = makeEtag(info.size, info.mtimeMs);
      headers.etag = etag;
      if (isNotModified(req.headers['if-none-match'], etag)) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
    } catch { /* 无 stat 也要能返回内容 */ }
    res.writeHead(200, { ...headers, 'content-length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  /** GET /dsh-markdown-typora/api/watch?path=…：SSE 外部变更流；心跳 15s；close 幂等清理。 */
  async function handleWatch(req, res, url) {
    const path = url.searchParams.get('path') ?? '';
    if (!path) {
      sendJson(res, 400, badRequest('path is required'));
      return;
    }
    let target;
    try {
      target = await fs.resolve(path);
    } catch (error) {
      sendJson(res, 200, { ok: false, error: { code: errorCode(error), message: String(error?.message ?? error) } });
      return;
    }
    if (res.headersSent) return;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
    res.write('retry: 2000\n\n');
    const stream = { res, targetKey: watchKeyOf(target) };
    liveStreams.add(stream);
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* close 清理 */ }
    }, heartbeatMs);
    heartbeat.unref?.();
    const entry = ensureWatch(target);
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      liveStreams.delete(stream);
      releaseWatch(target);
    };
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    try {
      res.write(`event: ready\ndata: ${JSON.stringify({ path: target.displayPath, version: String(entry.lastVersion ?? '') })}\n\n`);
    } catch { /* 已断 */ }
  }

  function resolveOptions(payload) {
    const cwd = payload?.cwd;
    return typeof cwd === 'string' && cwd.length > 0 ? { cwd } : undefined;
  }

  async function apiOpen(payload) {
    const path = typeof payload?.path === 'string' ? payload.path : '';
    if (!path) return badRequest('path is required');
    const target = await fs.resolve(path, resolveOptions(payload));
    const info = await fs.stat(target);
    if (!info) return { ok: false, error: { code: 'FS_NOT_FOUND', message: `not found: ${target.displayPath}` } };
    if (info.type !== 'file') {
      return { ok: false, error: { code: 'FS_NOT_REGULAR_FILE', message: `not a regular file: ${target.displayPath}` } };
    }
    const text = await fs.readText(target);
    return { ok: true, value: { text, version: info.version, displayPath: target.displayPath, size: info.size, type: info.type } };
  }

  async function apiSave(payload) {
    const path = typeof payload?.path === 'string' ? payload.path : '';
    const text = typeof payload?.text === 'string' ? payload.text : null;
    const baseVersion = typeof payload?.baseVersion === 'string' ? payload.baseVersion : '';
    if (!path) return badRequest('path is required');
    if (text === null) return badRequest('text is required');
    if (!baseVersion) return badRequest('baseVersion is required — refusing to overwrite without a version guard');
    const target = await fs.resolve(path, resolveOptions(payload));
    const result = await fs.writeText(target, text, { kind: 'replaceIfVersion', version: baseVersion });
    const version = result?.version;
    broadcastChange(target, version);
    return {
      ok: true,
      value: { version, displayPath: target.displayPath, size: Buffer.byteLength(text, 'utf8') },
    };
  }

  async function apiStat(payload) {
    const path = typeof payload?.path === 'string' ? payload.path : '';
    if (!path) return badRequest('path is required');
    const target = await fs.resolve(path, resolveOptions(payload));
    const info = await fs.stat(target);
    if (!info) return { ok: true, value: { missing: true } };
    return { ok: true, value: { version: info.version, size: info.size, type: info.type, displayPath: target.displayPath } };
  }

  async function apiEdit(payload) {
    const path = typeof payload?.path === 'string' ? payload.path : '';
    const oldString = typeof payload?.oldString === 'string' ? payload.oldString : null;
    const newString = typeof payload?.newString === 'string' ? payload.newString : null;
    if (!path) return badRequest('path is required');
    if (oldString === null || newString === null) return badRequest('oldString and newString are required');
    const target = await fs.resolve(path, resolveOptions(payload));
    const expected = typeof payload?.baseVersion === 'string' && payload.baseVersion.length > 0
      ? { version: payload.baseVersion }
      : undefined;
    const result = await fs.editText(target, {
      oldString,
      newString,
      replaceAll: payload?.replaceAll === true,
    }, expected);
    const version = result?.version;
    broadcastChange(target, version, { oldString, newString });
    return {
      ok: true,
      value: {
        version,
        displayPath: target.displayPath,
        changed: result?.before !== result?.after,
      },
    };
  }

  async function dispatch(endpoint, payload) {
    try {
      switch (endpoint) {
        case 'open': return await apiOpen(payload);
        case 'save': return await apiSave(payload);
        case 'stat': return await apiStat(payload);
        case 'edit': return await apiEdit(payload);
        default: return badRequest(`unknown endpoint: ${String(endpoint)}`);
      }
    } catch (error) {
      const code = errorCode(error);
      try { log.warn?.('%s: %s failed (%s): %s', name, String(endpoint), code, String(error?.message ?? error)); } catch { /* 日志失败不影响响应 */ }
      return { ok: false, error: { code, message: String(error?.message ?? error) } };
    }
  }

  /** 信任栅栏：requestRejection 以方法调用；不可用时只放行 loopback。 */
  function fenceStatus(req) {
    let rejection;
    try {
      let connection;
      try { connection = connectionProvider(); } catch { connection = undefined; }
      if (typeof connection?.requestRejection === 'function') {
        try { rejection = connection.requestRejection.call(connection, req); } catch { rejection = 403; }
      } else if (!isTrustedLoopbackRequest(req)) {
        rejection = 403;
      }
    } catch {
      rejection = isTrustedLoopbackRequest(req) ? undefined : 403;
    }
    if (rejection === undefined) return undefined;
    return typeof rejection === 'number' ? rejection : 403;
  }

  async function handleApiPost(req, res, url) {
    const endpoint = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '');
    if (!KNOWN_ENDPOINTS.has(endpoint)) {
      try { req.resume(); } catch { /* 已断 */ }
      sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `unsupported endpoint: ${String(endpoint)}` } });
      return;
    }
    const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      try { req.resume(); } catch { /* 已断 */ }
      sendJson(res, 415, badRequest('content type must be application/json'));
      return;
    }
    const body = await readBody(req, bodyLimit);
    if (!body.ok) {
      const status = body.code === 'too-large' ? 413 : 400;
      sendJson(res, status, { ok: false, error: { code: body.code, message: body.code === 'too-large' ? `body exceeds ${bodyLimit} bytes` : 'body read failed' } }, { connection: 'close' });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(body.buffer.toString('utf8'));
    } catch {
      sendJson(res, 400, badRequest('body is not JSON'));
      return;
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      sendJson(res, 400, badRequest('body must be a JSON object'));
      return;
    }
    const result = await dispatch(endpoint, payload);
    sendJson(res, 200, result);
  }

  const route = {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      try {
        const rejection = fenceStatus(req);
        if (rejection !== undefined) {
          sendText(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden');
          return;
        }
        let url;
        try {
          url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        } catch {
          sendText(res, 400, 'bad request');
          return;
        }
        const pathname = url.pathname;
        const isRead = req.method === 'GET' || req.method === 'HEAD';

        if (isRead && pathname === CORE_JSON_PATH) {
          await serveCoreJson(req, res);
          return;
        }
        // 本地图片通道（文档相对路径图）：见 serveImageFile 上方注释。
        if (isRead && pathname.startsWith(IMG_PREFIX)) {
          await serveImageFile(req, res, pathname.slice(IMG_PREFIX.length));
          return;
        }
        if (isRead && pathname === STATIC_PREFIX.slice(0, -1)) {
          await serveStatic(req, res, 'index.html');
          return;
        }
        if (isRead && pathname.startsWith(STATIC_PREFIX)) {
          await serveStatic(req, res, pathname.slice(STATIC_PREFIX.length));
          return;
        }
        if (req.method === 'GET' && pathname === API_PREFIX + 'watch') {
          await handleWatch(req, res, url);
          return;
        }
        if (req.method === 'POST' && pathname.startsWith(API_PREFIX)) {
          await handleApiPost(req, res, url);
          return;
        }
        sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `not found: ${pathname}` } });
      } catch (error) {
        const code = errorCode(error);
        try { log.warn?.('%s: request failed (%s): %s', name, code, String(error?.message ?? error)); } catch { /* 日志失败不影响响应 */ }
        if (!res.headersSent) sendJson(res, 200, { ok: false, error: { code, message: String(error?.message ?? error) } });
        else { try { res.end(); } catch { /* 已断 */ } }
      }
    },
  };

  function close() {
    for (const stream of liveStreams) {
      try { stream.res.end(); } catch { /* 已断 */ }
    }
    liveStreams.clear();
    for (const entry of watchers.values()) {
      entry.disposed = true;
      try { entry.controller.abort(); } catch { /* 已停 */ }
      if (entry.timer) clearInterval(entry.timer);
      if (entry.debounce) clearTimeout(entry.debounce);
      const closeFn = entry.close;
      entry.close = null;
      if (typeof closeFn === 'function') {
        Promise.resolve().then(() => closeFn()).catch(() => { /* close 失败不影响进程 */ });
      }
    }
    watchers.clear();
  }

  return { route, dispatch, close, broadcastChange, _internals: { watchers, liveStreams } };
}

function safeGet(ctx, serviceName) {
  try {
    return ctx?.get?.(serviceName);
  } catch {
    return undefined;
  }
}

function safeLogger(ctx) {
  try {
    if (typeof ctx?.logger === 'function') return ctx.logger(name);
  } catch { /* 用 console */ }
  return console;
}

export function apply(ctx) {
  const log = safeLogger(ctx);
  let fsService = safeGet(ctx, 'fs');
  if (!fsService) {
    try { fsService = ctx.fs; } catch { fsService = undefined; }
  }
  if (!fsService) {
    log.warn?.('%s: ctx.fs unavailable — plugin disabled', name);
    return;
  }

  let host;
  try {
    host = createHost({
      fs: fsService,
      log,
      rootDir: PLUGIN_ROOT,
      connectionProvider: () => safeGet(ctx, 'connection'),
    });
  } catch (error) {
    log.warn?.('%s: host init failed: %s', name, String(error?.message ?? error));
    return;
  }

  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        const dispose = ctx.webServer.register(host.route);
        log.info?.('%s: routes mounted on %s', name, ROUTE_PREFIX);
        return () => {
          try { if (typeof dispose === 'function') dispose(); } catch { /* 已清理 */ }
          try { host.close(); } catch { /* 已清理 */ }
        };
      }, 'dsh-markdown-typora: routes');
    } else {
      ctx.webServer.register(host.route);
    }
  } catch (error) {
    log.warn?.('%s: route registration failed: %s', name, String(error?.message ?? error));
    try { host.close(); } catch { /* 已清理 */ }
    return;
  }

  // markdown 模型工具：Agent 的编辑入口（与编辑面 tab 同一守卫路径）。
  registerMarkdownTool(ctx, { dispatch: host.dispatch, log });
}

/**
 * markdown 工具定义（纯数据 + execute，不触达宿主）：便于测试/外部校验 defineTool 形态。
 * DSH 0.2.1 的 defineTool 需要 output.schema + output.render；0.2.0 的旧形态（顶层 render）会抛。
 */
export function createMarkdownToolDefinition(dispatch) {
  return {
    name: 'markdown',
    description: [
      '读写 Markdown（及任意文本）文件，与 MarkPilot 编辑面板走同一版本守卫通道。',
      'read 返回全文与版本；edit 按字面 oldString→newString 原子替换（同 edit 工具语义）。',
      '冲突纪律：save/edit 报 FS_STALE_VERSION 说明文件在读取后被改过（可能用户正在编辑面板里打字）——',
      '此时必须重新 read 拿新版本再重试，绝不盲目覆盖；用户编辑永远优先。',
    ].join(' '),
    parameters: {
      action: { type: 'string', required: true, description: 'read = 读文件（text+version）；edit = 字面替换后守卫写回。', enum: ['read', 'edit'] },
      path: { type: 'string', required: true, description: '文件的绝对路径。' },
      cwd: { type: 'string', description: '可选：相对路径的解析基准目录。' },
      oldString: { type: 'string', description: 'action=edit 必填：要替换的原文字面量（须在文件中唯一，除非 replaceAll）。' },
      newString: { type: 'string', description: 'action=edit 必填：替换后的文字面量。' },
      replaceAll: { type: 'boolean', description: 'action=edit 可选：替换所有出现（默认 false）。' },
      baseVersion: { type: 'string', description: '可选：上次 read 拿到的版本；提供后文件已变则拒绝（FS_STALE_VERSION），不盲写。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          text: { type: 'string' },
          version: { type: 'string' },
          displayPath: { type: 'string' },
          changed: { type: 'boolean' },
          error: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
            },
          },
        },
      },
      render: (args, value) => {
        if (value?.ok !== true) {
          return textBlock(`markdown ${String(args?.action ?? '')} 失败：${value?.error?.code ?? 'error'} — ${value?.error?.message ?? ''}`);
        }
        if (value.action === 'read') {
          const text = String(value.text ?? '');
          const head = text.length > 8000 ? `${text.slice(0, 8000)}\n…（共 ${text.length} 字符，已截断）` : text;
          return textBlock(`${value.displayPath ?? ''}（版本 ${String(value.version ?? '').slice(0, 12)}…）:\n${head}`);
        }
        return textBlock(`已应用编辑：${value.displayPath ?? ''}${value.changed === false ? '（oldString 与 newString 相同，内容未变）' : ''}，新版本 ${String(value.version ?? '').slice(0, 12)}…`);
      },
    },
    async execute(args) {
      const action = args?.action === 'edit' ? 'edit' : 'read';
      try {
        if (action === 'read') {
          const result = await dispatch('open', { path: args?.path, cwd: args?.cwd });
          if (result.ok !== true) return { ok: false, action, error: result.error };
          return {
            ok: true,
            action,
            text: result.value.text,
            version: result.value.version,
            displayPath: result.value.displayPath,
          };
        }
        const result = await dispatch('edit', {
          path: args?.path,
          cwd: args?.cwd,
          oldString: args?.oldString,
          newString: args?.newString,
          replaceAll: args?.replaceAll === true,
          baseVersion: args?.baseVersion,
        });
        if (result.ok !== true) return { ok: false, action, error: result.error };
        return {
          ok: true,
          action,
          version: result.value.version,
          displayPath: result.value.displayPath,
          changed: result.value.changed,
        };
      } catch (error) {
        return { ok: false, action, error: { code: errorCode(error), message: String(error?.message ?? error) } };
      }
    },
  };
}

/**
 * markpilot 模型工具（read/edit）：与编辑面 tab 同一守卫。加载失败只告警，不影响插件其它能力。
 */
export function registerMarkdownTool(ctx, { dispatch, log } = {}) {
  const onWarn = (error) => {
    try { log?.warn?.('dsh-markdown-typora: model tool disabled: %s', String(error?.message ?? error)); } catch { /* 忽略 */ }
  };
  try {
    if (typeof ctx?.inject !== 'function') return;
    ctx.inject(['tools'], (sctx) => {
      try {
        const tools = sctx?.get?.('tools') ?? sctx?.tools;
        if (!tools || typeof tools.register !== 'function') {
          onWarn(new Error('Host tools.register is unavailable'));
          return;
        }
        sctx.effect(() => {
          let stopped = false;
          let dispose;
          Promise.resolve()
            .then(() => import('@deepseek-ai/dsh-tools'))
            .then((mod) => {
              if (stopped) return;
              const defineTool = mod?.defineTool;
              if (typeof defineTool !== 'function') throw new Error('Host defineTool is unavailable');
              const tool = defineTool(createMarkdownToolDefinition(dispatch));
              dispose = tools.register(tool);
            })
            .catch((error) => {
              if (!stopped) onWarn(error);
            });
          return () => {
            stopped = true;
            try { if (typeof dispose === 'function') dispose(); } catch (error) { onWarn(error); }
          };
        }, 'dsh-markdown-typora: markdown tool');
      } catch (error) {
        onWarn(error);
      }
    });
  } catch (error) {
    onWarn(error);
  }
}

export default { name, inject, apply };
