'use strict';
/**
 * 微信公众号接口的**宿主网络传输**（Electron 主进程专用）。
 *
 * 为什么放在主进程：渲染进程的 CSP 是 `connect-src 'none'`，页面自己也拿不到 secret；
 * 公众号接口需要一个能发 HTTPS 的受信进程，主进程正是那一层。
 *
 * 纪律：
 *  · 只允许打官方域名 + 已登记路径（见 wechat-api.js 的 ALLOWED_PATHS）；
 *  · **唯一例外**是隔离测试：`MP_TEST_HOOKS=1` 且 `MP_WX_BASE_URL` 指向 loopback 时，
 *    才改打本机假传输（127.0.0.1 / localhost）。其它一律拒绝 —— 测试桩不是正式逻辑。
 *  · 每次请求都有硬超时；回包走 capped-read（1MB 上限），不做无界读取；
 *    超时抛 `MP_WX_TIMEOUT`，让上层判"结果不明确"而不是"失败"。
 *  · 本模块不写日志、不碰磁盘、不读凭据。
 */

const { readCappedResponse } = require('./capped-read');
const { endpoint, OFFICIAL_BASE, API_PATHS } = require('./wechat-api');

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i;
/* 传输层自己的**路径白名单**：即使上游（api.endpoint 之外的调用方）拼出了同源但未登记的地址，
 * 这里也一律拒绝。同源不等于允许——发布/群发/删除都在同一个域名下。 */
const ALLOWED_PATHS = new Set(Object.values(API_PATHS));
const FORBIDDEN_PATH = /freepublish|mass|send|delete|update|delmaterial|custom\/|template/i;

/** 解析测试接缝：只有显式测试模式 + loopback 才生效；否则永远官方域名。 */
function resolveBaseUrl({ env = process.env } = {}) {
  const raw = String(env.MP_WX_BASE_URL || '').trim();
  if (!raw) return { base: OFFICIAL_BASE, mock: false };
  if (env.MP_TEST_HOOKS !== '1') return { base: OFFICIAL_BASE, mock: false };
  let url = null;
  try { url = new URL(raw); } catch { return { base: OFFICIAL_BASE, mock: false }; }
  if (url.protocol !== 'http:' || !LOOPBACK.test(url.hostname)) return { base: OFFICIAL_BASE, mock: false };
  return { base: raw.replace(/\/+$/, ''), mock: true };
}

function createNetTransport({ net, base = OFFICIAL_BASE } = {}) {
  if (!net || typeof net.fetch !== 'function') throw new Error('缺少 Electron net');

  /**
   * **浏览器自己管理的请求头**必须让浏览器自己生成。
   *
   * 实测（真实 EXE + 本机假服务）：POST `stable_token` 根本没到服务端，Electron 报
   * `net::ERR_INVALID_ARGUMENT` —— 因为 API 层手写了 `Content-Length`。Chromium 的网络栈
   * 把 `Content-Length` 视为**禁止设置的请求头**（由 body 长度自动派生），手工塞进去会让整个
   * 请求在发出前被拒；Node 的 `fetch`（假 transport 走的那条）对此宽容，所以单测一直是绿的。
   * 同理 `Host` / `Connection` / `Transfer-Encoding` 等也不能手填。
   *
   * 这里统一剥掉，**只保留** Content-Type / Accept 这类应用层头；Content-Type 是 multipart
   * 的 boundary 载体，必须留（剥了微信会回 41005）。
   */
  const AUTO_HEADERS = new Set([
    'content-length', 'host', 'connection', 'keep-alive', 'transfer-encoding',
    'upgrade', 'te', 'trailer', 'proxy-connection', 'accept-encoding', 'expect',
  ]);
  function normalizeHeaders(headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers || {})) {
      if (v === undefined || v === null) continue;
      if (AUTO_HEADERS.has(String(k).toLowerCase())) continue;
      out[k] = String(v);
    }
    return out;
  }

  /**
   * body 归一化：`net.fetch` 走的是 Chromium 的网络栈，body 要么是字符串、要么是
   * `Uint8Array` / `ArrayBuffer` / `Blob` / `FormData`；Node 的 `Buffer` 虽然**是** Uint8Array
   * 的子类，但跨进程/跨实现时最容易出问题（实测同一份 POST 在 Node fetch 上能通、
   * 到 Electron 上连请求都没发出去）。这里统一转成纯 `Uint8Array` 视图，边界只保留一种形态。
   * 二进制（multipart 的图片字节）一个字节都不改 —— 只换"装它的容器"。
   */
  function normalizeBody(body) {
    if (body == null) return undefined;
    if (typeof body === 'string') return body;
    if (body instanceof Uint8Array) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    return body;
  }

  return async function transport({
    method = 'GET', path: apiPath, query = null, url: preparedUrl = null,
    body = null, headers = {}, timeoutMs = 20000, maxBytes = 1024 * 1024,
  } = {}) {
    const target = preparedUrl || endpoint(base, apiPath, query);
    const sameOrigin = (() => {
      try { return new URL(target).origin === new URL(base).origin; } catch { return false; }
    })();
    if (!sameOrigin) throw Object.assign(new Error('拒绝请求非登记来源：' + target), { code: 'MP_WX_ORIGIN' });
    /* 同源之外还要过**路径白名单**：发布/群发/删除与官方同域，只验来源是拦不住的。 */
    let pathname = '';
    try { pathname = new URL(target).pathname; } catch { pathname = ''; }
    if (!ALLOWED_PATHS.has(pathname)) {
      throw Object.assign(new Error('拒绝请求未登记的微信接口：' + pathname), { code: 'MP_WX_ENDPOINT' });
    }
    if (FORBIDDEN_PATH.test(pathname)) {
      throw Object.assign(new Error('拒绝调用发布/删除类接口：' + pathname), { code: 'MP_WX_ENDPOINT' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 20000));
    try {
      const res = await net.fetch(target, {
        method, body: normalizeBody(body), redirect: 'error', signal: controller.signal,
        /* 只交应用层头；Content-Length 由 Chromium 按 body 自动生成（手填会 ERR_INVALID_ARGUMENT）。 */
        headers: normalizeHeaders({ 'Accept': 'application/json', ...headers }),
      });
      let bytes;
      try { bytes = await readCappedResponse(res, Math.max(4096, Number(maxBytes) || 1024 * 1024)); }
      catch (error) {
        if (error && error.code === 'E_TOO_LARGE') throw Object.assign(new Error('微信回包过大'), { code: 'MP_WX_BAD_REPLY' });
        throw error;
      }
      return { status: res.status, text: bytes.toString('utf8') };
    } catch (error) {
      if (error && error.code === 'MP_WX_BAD_REPLY') throw error;
      if (controller.signal.aborted) throw Object.assign(new Error('连接微信接口超时'), { code: 'MP_WX_TIMEOUT', timedOut: true });
      if (error && (error.code === 'MP_WX_ORIGIN' || error.code === 'MP_WX_ENDPOINT')) throw error;
      throw Object.assign(new Error(String((error && error.message) || error)), { code: 'MP_WX_NETWORK' });
    } finally { clearTimeout(timer); }
  };
}

module.exports = { createNetTransport, resolveBaseUrl, LOOPBACK, OFFICIAL_BASE };
