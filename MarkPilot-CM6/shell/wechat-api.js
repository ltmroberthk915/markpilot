'use strict';
/**
 * 微信公众号 · 草稿箱官方接口客户端（纯 Node，零 Electron 依赖，可单测）。
 *
 * 纪律（与产品安全边界一致）：
 *  · 只登记「拿凭据 / 校验草稿权限 / 上传正文图 / 上传封面素材 / 新建草稿」五类端点；
 *    发布（freepublish）、群发（mass）、删除、修改一律**不登记**，即使调用方写错路径也到不了网络。
 *  · 地址只能由常量拼出；`base` 参数仅用于隔离测试接到本机假传输（127.0.0.1），
 *    正式主进程**不传** base ⇒ 永远打官方域名。
 *  · 本模块不接触 appid/secret 的持久化，也不写日志；凭据只作为一次请求的参数存在。
 *  · 所有失败都返回 { ok:false, code, error, ... }，不抛异常给 IPC 层；超时单列 code，供上层判断
 *    「草稿可能已创建」这种结果不明确的状态。
 */

const crypto = require('node:crypto');

const OFFICIAL_BASE = 'https://api.weixin.qq.com';

/** 唯一合法的接口路径表（没有发布/群发/删除）。 */
const API_PATHS = Object.freeze({
  stableToken: '/cgi-bin/stable_token',
  legacyToken: '/cgi-bin/token',
  draftCount: '/cgi-bin/draft/count',
  uploadContentImage: '/cgi-bin/media/uploadimg',
  uploadCoverMaterial: '/cgi-bin/material/add_material',
  addDraft: '/cgi-bin/draft/add',
});
const ALLOWED_PATHS = new Set(Object.values(API_PATHS));
/* 即便有人在上面误加路径，这一层也会拦下来：发布/群发/删除/修改类端点一律拒绝。 */
const FORBIDDEN_PATH = /freepublish|mass|send|delete|update|delmaterial|custom\/|template/i;

const MAX_REPLY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20000;

function resolveBase(base) {
  const raw = String(base || OFFICIAL_BASE).trim();
  let url;
  try { url = new URL(raw); } catch { throw new Error('微信接口根地址不合法'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('微信接口只支持 http/https');
  const tail = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return { origin: url.origin, prefix: tail };
}

function endpoint(base, path, query) {
  if (!ALLOWED_PATHS.has(path)) throw new Error('未登记的微信接口：' + path);
  if (FORBIDDEN_PATH.test(path)) throw new Error('拒绝调用发布/删除类接口：' + path);
  const root = resolveBase(base);
  const url = new URL(root.origin + root.prefix + path);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  return url.href;
}

/** 文件名只留 ASCII 安全字符：微信对 multipart 的 filename 不做容错，中文会变成乱码文件名。 */
function safeUploadName(name, mime) {
  const base = String(name || '').replace(/[^\x20-\x7e]/g, '').replace(/["\\/\r\n]/g, '').trim();
  const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : '';
  const stem = (base.replace(/\.[^.]*$/, '') || 'markpilot').slice(0, 48);
  return (stem || 'markpilot') + (ext ? '.' + ext : '');
}

/** multipart/form-data（单个 media 字段）。微信上传接口只认这一种形态。 */
function buildMultipart({ field = 'media', filename, mime, bytes }) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('上传内容为空');
  const boundary = '----MarkPilotWx' + crypto.randomBytes(12).toString('hex');
  const head = Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="${field}"; filename="${safeUploadName(filename, mime)}"\r\n`
    + `Content-Type: ${mime || 'application/octet-stream'}\r\n\r\n`, 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { boundary, body: Buffer.concat([head, bytes, tail]) };
}

function errorOf(reply, status) {
  const errcode = Number(reply && reply.errcode);
  const errmsg = String((reply && reply.errmsg) || '');
  return {
    ok: false,
    code: 'MP_WX_API',
    status: Number.isFinite(status) ? status : null,
    errcode: Number.isFinite(errcode) ? errcode : null,
    errmsg,
    error: `微信接口返回错误${Number.isFinite(errcode) ? ' ' + errcode : ''}${errmsg ? '：' + errmsg : ''}`,
  };
}

/** 唯一出网点：transport 由主进程注入（Electron net.fetch）；测试注入本机假传输。 */
async function send(transport, request) {
  if (typeof transport !== 'function') return { ok: false, code: 'MP_WX_NO_TRANSPORT', error: '缺少网络传输实现' };
  let reply;
  try {
    reply = await transport({ maxBytes: MAX_REPLY_BYTES, timeoutMs: DEFAULT_TIMEOUT_MS, ...request });
  } catch (error) {
    const code = String((error && (error.code || error.name)) || '');
    /* 传输层的护栏拒绝（非登记端点/非登记来源）说明**请求根本没发出去** ⇒ 这是确定失败，
       不能按"结果不明确"处理（那会让用户白等一次"去草稿箱核对"）。 */
    if (code === 'MP_WX_ENDPOINT' || code === 'MP_WX_ORIGIN') {
      return { ok: false, code: 'MP_WX_BLOCKED', error: '已拦截：' + String((error && error.message) || error) };
    }
    const timedOut = code === 'MP_WX_TIMEOUT' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT'
      || code === 'AbortError' || !!(error && error.timedOut === true);
    return {
      ok: false,
      code: timedOut ? 'MP_WX_TIMEOUT' : 'MP_WX_NETWORK',
      timedOut,
      error: timedOut ? '连接微信接口超时' : `连接微信接口失败：${String((error && error.message) || error)}`,
    };
  }
  const text = String((reply && reply.text) || '');
  const status = Number(reply && reply.status);
  if (text.length > MAX_REPLY_BYTES) return { ok: false, code: 'MP_WX_BAD_REPLY', status, error: '微信接口回复过大' };
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!json || typeof json !== 'object') {
    return { ok: false, code: 'MP_WX_BAD_REPLY', status, error: `微信接口回复无法解析（HTTP ${Number.isFinite(status) ? status : '?'}）` };
  }
  if (json.errcode !== undefined && Number(json.errcode) !== 0) return errorOf(json, status);
  return { ok: true, status, json };
}

function postJson(transport, url, payload, extra = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  /* **不要手写 Content-Length**：Chromium（Electron net.fetch）把它当禁止设置的请求头，
     手工塞进去会让整个请求在发出前就失败（实测 net::ERR_INVALID_ARGUMENT，POST 根本到不了服务端）。
     长度由浏览器按 body 自动派生；这里只给 Content-Type。 */
  return send(transport, {
    method: 'POST', url, body,
    headers: { 'Content-Type': 'application/json' },
    ...extra,
  });
}

/** 稳定版接口调用凭据（官方推荐；同一 appid 的稳定 token 不会互相顶掉）。 */
async function fetchStableToken(transport, { base, appId, secret, timeoutMs } = {}) {
  const url = endpoint(base, API_PATHS.stableToken);
  const r = await postJson(transport, url, { grant_type: 'client_credential', appid: appId, secret, force_refresh: false },
    { timeoutMs: timeoutMs || 15000 });
  return tokenResult(r);
}

/** 老接口（stable_token 不可用时的一次回退；官方仍支持）。 */
async function fetchLegacyToken(transport, { base, appId, secret, timeoutMs } = {}) {
  const url = endpoint(base, API_PATHS.legacyToken, { grant_type: 'client_credential', appid: appId, secret });
  const r = await send(transport, { method: 'GET', url, timeoutMs: timeoutMs || 15000 });
  return tokenResult(r);
}

function tokenResult(r) {
  if (!r.ok) return r;
  const token = r.json.access_token;
  if (typeof token !== 'string' || !token) return { ok: false, code: 'MP_WX_BAD_REPLY', error: '微信没有返回 access_token' };
  const expiresIn = Number(r.json.expires_in);
  return { ok: true, token, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 7200 };
}

/** 草稿总数：最轻的「凭据 + 草稿权限」校验，不改动任何远端内容。 */
async function fetchDraftCount(transport, { base, token } = {}) {
  const url = endpoint(base, API_PATHS.draftCount, { access_token: token });
  const r = await postJson(transport, url, {});
  if (!r.ok) return r;
  const total = Number(r.json.total);
  return { ok: true, total: Number.isFinite(total) ? total : 0 };
}

/** 正文内嵌图片：返回微信 CDN 地址（正文里的 <img src> 换成它）。jpg/png，≤1MB。 */
async function uploadContentImage(transport, { base, token, bytes, mime, filename, timeoutMs } = {}) {
  const url = endpoint(base, API_PATHS.uploadContentImage, { access_token: token });
  const form = buildMultipart({ filename, mime, bytes });
  const r = await send(transport, {
    method: 'POST', url, body: form.body, timeoutMs: timeoutMs || 60000,
    /* Content-Type 带 boundary 必须留（微信靠它解析；剥了会回 41005）；
       Content-Length **不写**（浏览器按 body 自动生成，手填会 ERR_INVALID_ARGUMENT）。 */
    headers: { 'Content-Type': `multipart/form-data; boundary=${form.boundary}` },
  });
  if (!r.ok) return r;
  const hosted = String(r.json.url || '');
  if (!/^https?:\/\//i.test(hosted)) return { ok: false, code: 'MP_WX_BAD_REPLY', status: r.status, error: '微信没有返回正文图地址' };
  return { ok: true, url: hosted, bytes: bytes.length, mime };
}

/** 封面：永久素材（返回 media_id，草稿的 thumb_media_id 用它）。jpg/png，≤10MB。 */
async function uploadCoverMaterial(transport, { base, token, bytes, mime, filename, timeoutMs } = {}) {
  const url = endpoint(base, API_PATHS.uploadCoverMaterial, { access_token: token, type: 'image' });
  const form = buildMultipart({ filename, mime, bytes });
  const r = await send(transport, {
    method: 'POST', url, body: form.body, timeoutMs: timeoutMs || 60000,
    headers: { 'Content-Type': `multipart/form-data; boundary=${form.boundary}` },
  });
  if (!r.ok) return r;
  const mediaId = String(r.json.media_id || '');
  if (!mediaId) return { ok: false, code: 'MP_WX_BAD_REPLY', status: r.status, error: '微信没有返回封面素材 media_id' };
  return { ok: true, mediaId, url: typeof r.json.url === 'string' ? r.json.url : null, bytes: bytes.length, mime };
}

/** 新建草稿（**只建草稿**：不调发布、不调群发）。 */
async function addDraft(transport, { base, token, article, timeoutMs } = {}) {
  const url = endpoint(base, API_PATHS.addDraft, { access_token: token });
  const r = await postJson(transport, url, { articles: [article] }, { timeoutMs: timeoutMs || 30000 });
  if (!r.ok) return r;
  const mediaId = String(r.json.media_id || '');
  if (!mediaId) return { ok: false, code: 'MP_WX_BAD_REPLY', error: '微信没有返回草稿 media_id' };
  return { ok: true, mediaId };
}

module.exports = {
  OFFICIAL_BASE,
  API_PATHS,
  FORBIDDEN_PATH,
  endpoint,
  buildMultipart,
  safeUploadName,
  fetchStableToken,
  fetchLegacyToken,
  fetchDraftCount,
  uploadContentImage,
  uploadCoverMaterial,
  addDraft,
};
