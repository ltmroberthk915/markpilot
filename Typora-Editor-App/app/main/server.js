// 本地 HTTP 资源服务（仅绑定 127.0.0.1）：
//   /shell, /shell/*      -> 外壳页
//   /render/*             -> renderer 副本（GPT 的编辑器资源，含 ES module，需正确 MIME）
//   /doc/<enc绝对路径>    -> 动态改写 index.html（复刻扩展 buildPath + {{baseUrl}} 替换）
//   /ws/<enc目录>/<相对>  -> md 所在目录的资源（图片等）
//   /ws-file/<enc绝对路径>-> 任意本地文件（file:/// 图片重定向用）
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {randomBytes, timingSafeEqual} = require('node:crypto');
const AUTH_HEADER = 'X-Typora-Token';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// 等价于扩展 buildPath：相对 src/href 前缀 /render，排除 http/#/data:与以 / 开头的
function transformDocHtml(html, mdDirEnc) {
  return html
    .replace('{{baseUrl}}', `/ws/${mdDirEnc}`)
    .replace(
      /((?:src|href)=["'])((?!https?:|\/\/|#|data:|\/)[^"']*)(["'])/gi,
      (_m, pre, rel, post) => `${pre}/render/${rel.replace(/^\.\//, '')}${post}`
    );
}

function startServer({ rendererRoot, shellRoot, port }) {
  let htmlTemplate = null;
  rendererRoot = path.resolve(rendererRoot);
  shellRoot = path.resolve(shellRoot);
  // Kept in the main process only: never put this capability in URLs or HTML.
  const token = randomBytes(32).toString('hex');
  const expectedToken = Buffer.from(token);

  const send404 = (res, what) => {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  };

  // 打包后 rendererRoot 落在 app.asar 里，而 **Electron 对归档内路径的 open() 会把
  // 整个文件先抄到临时目录**（实测同一份 3.8MB 的 lute.min.js：createReadStream 走
  // open→1161ms，readFile 走归档区间读→13ms，约 4MB/s 对 300MB/s）。这条路径正好在
  // 冷启动的关键链上——编辑器页要等 lute 才能解析文档，用户看到的就是"装完版比开发版
  // 慢 1.2 秒"。readFile 把整个文件读进内存再一次性写回，代价可忽略（最大也就几 MB），
  // 换来每次启动少 1.1s。**不要再改回 createReadStream。**
  // R12a（2026-10-04 D-E 裁决）：应用自有静态资源（/shell、/render）补条件请求缓存——
  // ETag(size+mtime) + If-None-Match→304 + Cache-Control: no-cache。为什么不是
  // immutable/长 max-age：资源 URL 不带版本 hash，升级换文件后磁盘缓存会把旧 lute
  // 喂一年（lute 驱动 md↔DOM round-trip，陈旧=文档损坏级风险）；no-cache 强制每次
  // 再验证，文件未变走 304（0 字节体，3.8MB 的 lute 不再每次重传），变了拿新体。
  // 用户文件（/ws*）与动态模板（/doc/）维持 no-store；token 由 resource-auth 的
  // onBeforeSendHeaders 自动盖在条件请求上，再验证不额外握手。
  const sendFile = (res, file, head = false, cacheable = false) => {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send404(res, file);
      const etag = `"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`;
      if (cacheable && res.req && res.req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
        res.end();
        return;
      }
      fs.readFile(file, (error, data) => {
        if (error) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('server error'); return; }
        const headers = {
          'Content-Type': mimeOf(file),
          'Content-Length': data.length,
          'Cache-Control': 'no-store',
        };
        if (cacheable) {
          headers.ETag = etag;
          headers['Last-Modified'] = st.mtime.toUTCString();
          headers['Cache-Control'] = 'no-cache';
        }
        res.writeHead(200, headers);
        res.end(head ? undefined : data);
      });
    });
  };

  const server = http.createServer((req, res) => {
    // 只服务本机回环请求，且 Host 必须匹配（防 DNS rebinding）
    const host = `127.0.0.1:${server.address().port}`;
    const receivedToken = Buffer.from(String(req.headers[AUTH_HEADER.toLowerCase()] || ''));
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers.host !== host || receivedToken.length !== expectedToken.length || !timingSafeEqual(receivedToken, expectedToken)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {res.writeHead(405);res.end('method not allowed');return;}
    let url;
    try { url = new URL(req.url, `http://${host}`); if(url.origin !== `http://${host}`) throw new Error(); }
    catch { res.writeHead(400); res.end('bad url'); return; }
    const pathname = url.pathname;

    try {
      if (pathname === '/shell' || pathname === '/shell/index.html') {
        sendFile(res, path.join(shellRoot, 'shell.html'), req.method === 'HEAD', true);
        return;
      }
      if (pathname.startsWith('/shell/')) {
        const rel = path.normalize(decodeURIComponent(pathname.slice('/shell/'.length)));
        const file = path.join(shellRoot, rel);
        if (file !== shellRoot && !file.startsWith(shellRoot + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
        sendFile(res, file, req.method === 'HEAD', true);
        return;
      }
      if (pathname.startsWith('/render/')) {
        const rel = path.normalize(decodeURIComponent(pathname.slice('/render/'.length)));
        const file = path.join(rendererRoot, rel);
        if (file !== rendererRoot && !file.startsWith(rendererRoot + path.sep)) {
          res.writeHead(403); res.end('forbidden'); return;
        }
        sendFile(res, file, req.method === 'HEAD', true);
        return;
      }
      if (pathname.startsWith('/doc/')) {
        const enc = pathname.slice('/doc/'.length);
        const absFile = decodeURIComponent(enc);
        if (!htmlTemplate) {
          htmlTemplate = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
        }
        const mdDirEnc = encodeURIComponent(path.dirname(absFile));
        const html = transformDocHtml(htmlTemplate, mdDirEnc);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }
      if (pathname.startsWith('/ws/')) {
        const rest = pathname.slice('/ws/'.length);
        const slash = rest.indexOf('/');
        if (slash === -1) return send404(res, pathname);
        const baseDir = decodeURIComponent(rest.slice(0, slash));
        let rel = rest.slice(slash + 1);
        // 相对路径里可能混入绝对盘符（如 md 里写了 D:/x.png），直接按绝对处理
        let file;
        if (/^[A-Za-z]:[\\/]/.test(decodeURIComponent(rel))) {
          file = decodeURIComponent(rel);
        } else {
          file = path.join(baseDir, decodeURIComponent(rel));
        }
        sendFile(res, file, req.method === 'HEAD');
        return;
      }
      if (pathname.startsWith('/ws-file/')) {
        const abs = decodeURIComponent(pathname.slice('/ws-file/'.length));
        sendFile(res, abs, req.method === 'HEAD');
        return;
      }
      send404(res, pathname);
    } catch (e) {
      res.writeHead(e instanceof URIError ? 400 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(e instanceof URIError ? 'bad url' : 'server error');
    }
  });

  return new Promise((resolve, reject) => {
    // 首选端口被别人占了（同一个应用的另一个实例：便携版 + 安装版、或上一份
    // 没退干净的进程）不能直接崩——那样用户看到的是"应用起来了又没了"。退到
    // 系统分配的空闲端口即可，端口本来就只在本机内部使用，是动态传下去的。
    const listen = (candidate, fallback) => {
      server.listen(candidate, '127.0.0.1', () => resolve({ server, port: server.address().port, token }));
      server.once('error', error => {
        if (fallback && error.code === 'EADDRINUSE') { listen(0, false); return; }
        reject(error);
      });
    };
    listen(port, true);
  });
}

module.exports = { startServer, AUTH_HEADER, mimeOf };
