// dsh-markpilot 宿主半边：renderer 静态路由 + 编辑面 API（读/守卫写/版本查询）+ markpilot 模型工具。
//
// 插件三件套形状（宿主 cordis loader 读的就是这个）：
//   export const name / export const inject / export function apply(ctx)
//
// 路由挂载与信任栅栏照抄 dsh-session-telecom/lib/web-rpc.js 的已验证范式：
//   connection.requestRejection 可用 → 走它（必须以方法形式调用）；否则仅放行 loopback。
// 编辑面 API 的所有写都走 ctx.fs 的版本守卫（FS_STALE_VERSION 拒绝盲写，冲突不覆盖）。
// markpilot 工具与编辑面 tab 落同一守卫路径：Agent 改文件 → tab 轮询发现版本变化 →
// 静默重载（setValue 带光标/滚动还原）→ 人在编辑面上直接看见。这就是同一编辑面协同的最小闭环。

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, sep, extname } from 'node:path';

export const name = 'dsh-markpilot';

/** 必需服务：webServer（路由挂载点）+ fs（版本守卫读写）。 */
export const inject = ['webServer', 'fs'];

const ROUTE_PREFIX = '/dsh-markpilot';
const RENDERER_PREFIX = ROUTE_PREFIX + '/renderer/';
const RENDERER_CM6_PREFIX = ROUTE_PREFIX + '/renderer-cm6/';
const API_PREFIX = ROUTE_PREFIX + '/api/';
/* body 上限：8MB 太小 —— 实测一份 8.13MB 的含内联图 Markdown（8527008 B）保存时被 413 拒掉
   （"能打开、存不回去"）。含图文档十几 MB 在真实用户里常见，这里给到 64MB。 */
const BODY_MAX_BYTES = 64 * 1024 * 1024;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDERER_DIRS = [
  [RENDERER_PREFIX, normalize(join(HERE, '..', 'renderer'))],
  [RENDERER_CM6_PREFIX, normalize(join(HERE, '..', 'renderer-cm6'))],
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

function textBlock(text) {
  return [{ type: 'text', text }];
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function isTrustedLoopbackRequest(req) {
  const host = req.headers?.host;
  if (!host) return false;
  if (!LOOPBACK_HOSTNAMES.has(host.split(':')[0])) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > BODY_MAX_BYTES) { tooLarge = true; resolve(null); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, prefix, rootDir, pathname) {
  const rel = decodeURIComponent(pathname.slice(prefix.length)) || 'index.html';
  const target = normalize(join(rootDir, rel));
  if (target !== rootDir && !target.startsWith(rootDir + sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  if (!existsSync(target)) { res.writeHead(404); res.end('not found'); return; }
  try {
    const data = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(500); res.end('read error');
  }
}

/** FsError 等错误的稳定码（分支认码不认文案）。 */
function errorCode(error) {
  const code = error?.code ?? error?.cause?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'fs-error';
}

export function apply(ctx) {
  const log = typeof ctx.logger === 'function' ? ctx.logger(name) : console;

  const fs = () => ctx.fs;

  async function apiOpen(payload) {
    const path = typeof payload?.path === 'string' ? payload.path : '';
    if (!path) return { ok: false, error: { code: 'bad-request', message: 'path is required' } };
    const target = await fs().resolve(path, payload.cwd ? { cwd: payload.cwd } : undefined);
    const info = await fs().stat(target);
    if (!info || info.type !== 'file') return { ok: false, error: { code: 'not-found', message: `not a file: ${target.displayPath}` } };
    const text = await fs().readText(target);
    return { ok: true, value: { text, version: info.version, displayPath: target.displayPath, size: info.size } };
  }

  async function apiSave(payload) {
    const path = typeof payload?.path === 'string' ? payload.path : '';
    const text = typeof payload?.text === 'string' ? payload.text : null;
    if (!path || text === null) return { ok: false, error: { code: 'bad-request', message: 'path and text are required' } };
    const target = await fs().resolve(path, payload.cwd ? { cwd: payload.cwd } : undefined);
    const expected = typeof payload.baseVersion === 'string' && payload.baseVersion.length > 0
      ? { kind: 'replaceIfVersion', version: payload.baseVersion }
      : undefined;
    const result = await fs().writeText(target, text, expected);
    broadcastChange(target, result.version); // 其他窗口/tab 即刻可见；写者自己按版本比对静默
    return { ok: true, value: { version: result.version, displayPath: target.displayPath } };
  }

  async function apiStat(payload) {
    const path = typeof payload?.path === 'string' ? payload.path : '';
    if (!path) return { ok: false, error: { code: 'bad-request', message: 'path is required' } };
    const target = await fs().resolve(path, payload.cwd ? { cwd: payload.cwd } : undefined);
    const info = await fs().stat(target);
    if (!info) return { ok: true, value: { missing: true } };
    return { ok: true, value: { version: info.version, size: info.size, type: info.type } };
  }

  async function apiEdit(payload) {
    const path = typeof payload?.path === 'string' ? payload.path : '';
    if (!path) return { ok: false, error: { code: 'bad-request', message: 'path is required' } };
    const oldString = typeof payload?.oldString === 'string' ? payload.oldString : null;
    const newString = typeof payload?.newString === 'string' ? payload.newString : null;
    if (oldString === null || newString === null) {
      return { ok: false, error: { code: 'bad-request', message: 'oldString and newString are required' } };
    }
    const target = await fs().resolve(path, payload.cwd ? { cwd: payload.cwd } : undefined);
    const expected = typeof payload.baseVersion === 'string' && payload.baseVersion.length > 0
      ? { version: payload.baseVersion }
      : undefined;
    const result = await fs().editText(target, {
      oldString, newString, replaceAll: payload.replaceAll === true,
    }, expected);
    broadcastChange(target, result.version, { oldString, newString }); // 带 delta：冲突时人看得见 AI 改了什么（协议 v0 可见性第一步）
    return { ok: true, value: { version: result.version, displayPath: target.displayPath, changed: result.before !== result.after } };
  }

  /* ───────── 宪法 v3 第一刀：轮询→事件推 ─────────
   * 1.5s stat 轮询是权宜补丁；架构形态 = 宿主 fs.watch + 自写广播 + SSE 长连接。
   * 客户端 EventSource 订阅 api/watch?path=…，外部/Agent 变更毫秒级推送；
   * 自己的保存不回声（lastSelfVersion 抑制）。轮询保留为兜底（SSE 断开时降级）。 */
  const watchers = new Map(); // targetKey → { refs, controller, timer }
  const liveStreams = new Set(); // Set<res>

  function broadcastChange(target, version, delta) {
    const payload = `event: change\ndata: ${JSON.stringify({
      displayPath: target.displayPath,
      version: String(version ?? ''),
      ...(delta ? { delta: { oldString: delta.oldString?.slice(0, 400) ?? '', newString: delta.newString?.slice(0, 400) ?? '' } } : {}),
    })}\n\n`;
    for (const res of liveStreams) { try { res.write(payload); } catch { /* 连接已断 */ } }
  }

  function ensureWatch(target) {
    let entry = watchers.get(target.targetKey);
    if (entry) { entry.refs += 1; return entry; }
    entry = { refs: 1, controller: new AbortController(), timer: null, lastVersion: undefined, debounce: null };
    watchers.set(target.targetKey, entry);
    const tick = async () => {
      try {
        const info = await fs().stat(target);
        const version = info ? String(info.version) : '';
        if (entry.lastVersion !== undefined && version !== entry.lastVersion) {
          // 防抖 120ms：批量写（原子替换+探测）只推一帧。
          if (entry.debounce) clearTimeout(entry.debounce);
          entry.debounce = setTimeout(() => { entry.debounce = null; broadcastChange(target, version); }, 120);
        }
        entry.lastVersion = version;
      } catch { /* 观测失败静默；SSE 客户端有兜底轮询 */ }
    };
    try {
      fs().watch(target, () => { tick(); }, entry.controller.signal);
    } catch (error) {
      log.warn?.('%s: fs.watch unavailable (%s) — SSE 退化为 2s 探测', name, String(error?.message ?? error));
      entry.timer = setInterval(tick, 2000);
      entry.timer.unref?.();
    }
    tick(); // 建立基线版本
    return entry;
  }

  function releaseWatch(target) {
    const entry = watchers.get(target.targetKey);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    watchers.delete(target.targetKey);
    try { entry.controller.abort(); } catch { /* 已停 */ }
    if (entry.timer) clearInterval(entry.timer);
    if (entry.debounce) clearTimeout(entry.debounce);
  }

  /** GET /dsh-markpilot/api/watch?path=… → SSE 流（res 由路由层在连接关闭时清出 liveStreams）。 */
  async function handleWatch(req, res, url) {
    const path = url.searchParams.get('path') ?? '';
    if (!path) { json(res, 400, { ok: false, error: { code: 'bad-request', message: 'path is required' } }); return; }
    const target = await fs().resolve(path);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(`retry: 2000\n\n`);
    const heartbeat = setInterval(() => { try { res.write(`: ping\n\n`); } catch { /* 断开由 close 处理 */ } }, 15000);
    heartbeat.unref?.();
    const entry = ensureWatch(target);
    liveStreams.add(res);
    req.on('close', () => {
      clearInterval(heartbeat);
      liveStreams.delete(res);
      releaseWatch(target);
    });
  }

  async function dispatch(endpoint, payload) {
    switch (endpoint) {
      case 'open': return apiOpen(payload);
      case 'save': return apiSave(payload);
      case 'stat': return apiStat(payload);
      case 'edit': return apiEdit(payload);
      default: return { ok: false, error: { code: 'bad-request', message: `unknown endpoint: ${String(endpoint)}` } };
    }
  }

  const route = {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      try {
        // 信任栅栏（与 dsh-session-telecom 同款）。
        // cordis 纪律：没进 inject 的服务不能点属性（点就抛 "cannot get ... without inject"），
        // 而 connection 在 headless 组合里可能缺失——所以 try 取，缺了走 loopback 兜底。
        let connection;
        try { connection = ctx.connection; } catch { connection = undefined; }
        let rejection;
        if (typeof connection?.requestRejection === 'function') {
          try { rejection = connection.requestRejection.call(connection, req); } catch { rejection = 403; }
        } else if (!isTrustedLoopbackRequest(req)) {
          rejection = 403;
        }
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
          return;
        }

        const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
        const pathname = url.pathname;

        if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith(ROUTE_PREFIX + '/renderer')) {
          const entry = RENDERER_DIRS.find(([prefix]) => pathname.startsWith(prefix));
          if (entry) {
            await serveStatic(req, res, entry[0], entry[1], pathname);
          } else {
            // /renderer 或 /renderer-cm6 根（无尾斜杠）→ 各自 index.html
            const isCm6 = pathname.startsWith(RENDERER_CM6_PREFIX.slice(0, -1));
            const [prefix, dir] = isCm6 ? RENDERER_DIRS[1] : RENDERER_DIRS[0];
            await serveStatic(req, res, prefix, dir, prefix + 'index.html');
          }
          return;
        }

        // SSE 事件推（宪法 v3 第一刀）：GET /dsh-markpilot/api/watch?path=…
        if (req.method === 'GET' && pathname === API_PREFIX + 'watch') {
          await handleWatch(req, res, url);
          return;
        }

        if (req.method === 'POST' && pathname.startsWith(API_PREFIX)) {
          const endpoint = pathname.slice(API_PREFIX.length).replace(/\/+$/, '');
          const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
          if (mediaType !== 'application/json') { json(res, 415, { ok: false, error: { code: 'bad-request', message: 'content type must be application/json' } }); return; }
          const raw = await readBody(req);
          if (raw === null) { json(res, 413, { ok: false, error: { code: 'too-large', message: 'body exceeds limit' } }); return; }
          let payload;
          try { payload = JSON.parse(raw.toString('utf8')); } catch { json(res, 400, { ok: false, error: { code: 'bad-request', message: 'body is not JSON' } }); return; }
          const result = await dispatch(endpoint, payload);
          json(res, 200, result);
          return;
        }

        res.writeHead(404); res.end('not found');
      } catch (error) {
        const code = errorCode(error);
        log.warn?.('%s: api failed: %s', name, String(error?.message ?? error));
        json(res, 200, { ok: false, error: { code, message: String(error?.message ?? error) } });
      }
    },
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const dispose = ctx.webServer.register(route);
      log.info?.('%s: routes mounted on %s', name, ROUTE_PREFIX);
      return () => {
        try { if (typeof dispose === 'function') dispose(); } catch { /* 已清理 */ }
        for (const res of liveStreams) { try { res.end(); } catch { /* 已断 */ } }
        liveStreams.clear();
        for (const entry of watchers.values()) {
          try { entry.controller.abort(); } catch { /* 已停 */ }
          if (entry.timer) clearInterval(entry.timer);
          if (entry.debounce) clearTimeout(entry.debounce);
        }
        watchers.clear();
      };
    }, 'dsh-markpilot: routes');
  } else {
    ctx.webServer.register(route);
  }

  // markpilot 模型工具：Agent 的编辑入口（与编辑面 tab 同一守卫路径）。
  registerMarkpilotTool(ctx, { dispatch, log });
}

function textBlockRender(args, value) {
  if (value.ok !== true) {
    return textBlock(`markpilot ${String(args.action ?? '')} 失败：${value.error?.code ?? 'error'} — ${value.error?.message ?? ''}`);
  }
  if (value.action === 'read') {
    const text = value.text ?? '';
    const head = text.length > 8000 ? `${text.slice(0, 8000)}\n…（共 ${String(text.length)} 字符，已截断）` : text;
    return textBlock(`${value.displayPath ?? ''}（版本 ${String(value.version ?? '').slice(0, 12)}…）:\n${head}`);
  }
  return textBlock(`已应用编辑：${value.displayPath ?? ''}${value.changed === false ? '（oldString 与 newString 相同，内容未变）' : ''}，新版本 ${String(value.version ?? '').slice(0, 12)}…`);
}

export function registerMarkpilotTool(ctx, { dispatch, log }) {
  const onWarn = (error) => log.warn?.('dsh-markpilot: model tool disabled: %s', String(error));
  try {
    if (typeof ctx?.inject !== 'function') return;
    ctx.inject(['tools'], (sctx) => {
      try {
        const tools = sctx.get?.('tools') ?? sctx.tools;
        if (typeof tools?.register !== 'function') {
          onWarn(new Error('Host tools.register is unavailable'));
          return;
        }
        sctx.effect(() => {
          let stopped = false;
          let dispose;
          const install = (defineTool) => {
            if (stopped || typeof defineTool !== 'function') throw new Error('Host defineTool is unavailable');
            const tool = defineTool({
              name: 'markpilot',
              description: [
                '读写 Markdown（及任意文本）文件，与 MarkPilot 编辑面板走同一版本守卫通道。',
                'read 返回全文与版本；edit 按字面 oldString→newString 原子替换（同 edit 工具语义）。',
                '冲突纪律：save/edit 报 FS_STALE_VERSION 说明文件在读取后被改过（可能用户正在编辑面板里打字）——',
                '此时必须重新 read 拿新版本再重试，绝不盲目覆盖；用户编辑永远优先。',
              ].join(' '),
              parameters: {
                action: { type: 'string', description: 'read = 读文件（text+version）；edit = 字面替换后守卫写回。', enum: ['read', 'edit'] },
                path: { type: 'string', description: '文件的绝对路径。' },
                cwd: { type: 'string', description: '可选：相对路径的解析基准目录。' },
                oldString: { type: 'string', description: 'action=edit 必填：要替换的原文字面量（须在文件中唯一，除非 replaceAll）。' },
                newString: { type: 'string', description: 'action=edit 必填：替换后的文字面量。' },
                replaceAll: { type: 'boolean', description: 'action=edit 可选：替换所有出现（默认 false）。' },
                baseVersion: { type: 'string', description: '可选：上次 read 拿到的版本；提供后文件已变则拒绝（FS_STALE_VERSION），不盲写。' },
              },
              render: textBlockRender,
              async execute(args) {
                const action = args.action === 'edit' ? 'edit' : 'read';
                try {
                  if (action === 'read') {
                    const result = await dispatch('open', { path: args.path, cwd: args.cwd });
                    if (result.ok !== true) return { ok: false, action, error: result.error };
                    return { ok: true, action, text: result.value.text, version: result.value.version, displayPath: result.value.displayPath };
                  }
                  const result = await dispatch('edit', {
                    path: args.path, cwd: args.cwd,
                    oldString: args.oldString, newString: args.newString,
                    replaceAll: args.replaceAll === true, baseVersion: args.baseVersion,
                  });
                  if (result.ok !== true) return { ok: false, action, error: result.error };
                  return { ok: true, action, version: result.value.version, displayPath: result.value.displayPath, changed: result.value.changed };
                } catch (error) {
                  return { ok: false, action, error: { code: errorCode(error), message: String(error?.message ?? error) } };
                }
              },
              finalizeContent(exec, result) {
                const text = result?.content;
                return typeof text === 'string' && text.length > 0 ? textBlock(text) : undefined;
              },
            });
            dispose = tools.register(tool);
          };
          const load = () => import('@deepseek-ai/dsh-tools');
          Promise.resolve().then(load).then((mod) => install(mod?.defineTool)).catch((error) => {
            if (!stopped) onWarn(error);
          });
          return () => {
            stopped = true;
            try { if (typeof dispose === 'function') dispose(); } catch (error) { onWarn(error); }
          };
        }, 'dsh-markpilot: markpilot tool');
      } catch (error) {
        onWarn(error);
      }
    });
  } catch (error) {
    onWarn(error);
  }
}

export default { name, inject, apply };
