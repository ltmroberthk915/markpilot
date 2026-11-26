'use strict';
/**
 * 「发送到公众号草稿箱」的**宿主侧**编排（纯 Node，可单测；不含 Electron 依赖）。
 *
 * 边界承诺（逐条都能被测试盯住）：
 *  1. 只建草稿：本模块只登记 draft/add，绝不调用发布（freepublish）/群发（mass）/删除/修改。
 *  2. 凭据只在宿主：appid/secret 由 credentials 模块保管；本模块返回的**任何**结果都不含 secret，
 *     日志经 sanitize（含 secret/token 字样的键一律丢弃）。
 *  3. 结果不明确（超时/网络错误/回包不可解析）时：**保留 pending 标记**、返回
 *     code=MP_WX_DRAFT_UNCERTAIN，并在下一次调用时**拒绝**在用户确认之前重复创建
 *     （MP_WX_PENDING_UNCERTAIN）——绝不自动重试建草稿。
 *  4. 只有"确定失败"（微信返回非 0 errcode）才清 pending：那说明服务端没有留下草稿。
 *  5. 图片/封面先校验再上传：类型限 jpg/png、正文图 ≤1MB、封面 ≤10MB；任何一张失败 ⇒
 *     **不建草稿**（避免生成缺图的草稿），并把真实失败原因带回去。
 *  6. **不把远程 URL 变成宿主下载器**：读图只走注入的 readImage（主进程实现），
 *     而主进程那份实现显式拒绝 http(s)；正文里残留的外链图在 preflight 就被挡下。
 *  7. 正文图用 `mpwx:<id>` 占位：上传拿到微信 CDN 地址后**只替换带引号的完整占位**；
 *     残留占位或占位对不上 ⇒ 停止发送，绝不带坏图建草稿。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const api = require('./wechat-api');

const MAX_CONTENT_CHARS = 20000;                 // 官方限制：图文内容必须少于 2 万字符
const MAX_CONTENT_BYTES = 1024 * 1024;           // 且小于 1MB
const MAX_TITLE_CHARS = 64;                      // 标题上限（官方 64 字）
const MAX_CONTENT_IMAGE_BYTES = 1024 * 1024;     // uploadimg：1MB
const MAX_COVER_BYTES = 10 * 1024 * 1024;        // 永久图片素材：10MB
const MAX_IMAGES = 40;
const MAX_IMAGES_TOTAL = 24 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png']);
const WECHAT_IMAGE_HOSTS = new Set(['mmbiz.qpic.cn', 'mmbiz.qlogo.cn', 'res.wx.qq.com']);
const MARKER_PREFIX = 'mpwx:';

/* 常见 errcode → 人话（只做提示，不改变判据）。 */
const ERRCODE_HINT = {
  40001: '凭据无效或已过期：请重新保存 appid / secret，再点「验证配置」',
  40002: '凭据类型不对（grant_type 无效）',
  40013: 'appid 不合法',
  40014: '凭据无效：请重新保存 appid / secret',
  40164: '本机公网 IP 不在公众号 IP 白名单里（公众号后台 → 开发 → 基本配置 → IP 白名单）',
  42001: '凭据已过期：请点「验证配置」刷新',
  45001: '素材大小超出微信限制（正文图 1MB、封面 10MB）',
  45002: '正文内容超过微信限制（少于 2 万字符、1MB 以内）',
  45003: '标题超过微信限制（64 字以内）',
  45004: '摘要过长',
  45009: '接口调用频率超限，请稍后再试',
  48001: '该公众号没有这个接口的权限（订阅号/未认证账号常见）',
  50002: '该账号当天接口调用受限',
  61004: '服务器出口不合规（需在公众号后台配置白名单）',
};
function hintFor(errcode) {
  return Number.isFinite(Number(errcode)) && ERRCODE_HINT[Number(errcode)] ? ERRCODE_HINT[Number(errcode)] : null;
}

function sanitize(detail) {
  if (!detail || typeof detail !== 'object') return detail;
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (/secret|token|authorization|cookie|password/i.test(k)) continue;
    if (typeof v === 'string' && v.length > 300) { out[k] = v.slice(0, 300) + '…'; continue; }
    out[k] = v;
  }
  return out;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 标题校验：非空、≤64 字（按码点）、单行、无控制字符、无尖括号。 */
function checkTitle(title) {
  const t = String(title == null ? '' : title).replace(/\r\n?/g, '\n').trim();
  if (!t) return { ok: false, code: 'MP_WX_TITLE_EMPTY', error: '标题为空：请先给文章加一级标题（# 标题），或在对话框里填写标题' };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(t)) return { ok: false, code: 'MP_WX_TITLE_CHARS', error: '标题里有不可见控制字符，请先清理' };
  if (t.includes('\n')) return { ok: false, code: 'MP_WX_TITLE_CHARS', error: '标题不能换行：微信草稿标题只支持单行' };
  if (/[<>]/.test(t)) return { ok: false, code: 'MP_WX_TITLE_CHARS', error: '标题里不能有 < 或 >' };
  const points = [...t];
  if (points.length > MAX_TITLE_CHARS) return { ok: false, code: 'MP_WX_TITLE_LONG', error: `标题 ${points.length} 字，超过微信上限 ${MAX_TITLE_CHARS} 字` };
  return { ok: true, title: t };
}

/** 正文校验：非空、长度/字节在上限内、有实际可见文字。 */
function checkHtml(html) {
  const s = String(html == null ? '' : html);
  if (!s.trim()) return { ok: false, code: 'MP_WX_HTML_EMPTY', error: '正文为空：没有可发送的内容' };
  if (s.length > MAX_CONTENT_CHARS) return { ok: false, code: 'MP_WX_HTML_LONG', error: `正文 ${s.length} 字符，超过微信草稿上限 ${MAX_CONTENT_CHARS} 字符` };
  const bytes = Buffer.byteLength(s, 'utf8');
  if (bytes > MAX_CONTENT_BYTES) return { ok: false, code: 'MP_WX_HTML_LONG', error: `正文 ${(bytes / 1024).toFixed(0)} KB，超过微信草稿上限 1MB` };
  const text = s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  /* 只有图片/公式图、没有文字的正文是合法的（图集式文章）；判据是"有没有可看的东西"。 */
  const hasMedia = /<(?:img|video|svg)\b/i.test(s);
  if (!text && !hasMedia) return { ok: false, code: 'MP_WX_HTML_EMPTY', error: '正文里没有可见内容（只有空标签/空段落），请检查内容' };
  return { ok: true, html: s };
}

/** 正文里**不能交给微信**的图片地址（外链）：公众号只认自家 CDN。 */
function remoteImagesIn(html) {
  const out = [];
  const re = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const m of String(html).matchAll(re)) {
    const src = (m[1] || m[2] || m[3] || '').trim();
    if (!/^(?:https?:)?\/\//i.test(src)) continue;
    let host = '';
    try { host = new URL(src.startsWith('//') ? 'https:' + src : src).hostname.toLowerCase(); } catch { host = ''; }
    if (WECHAT_IMAGE_HOSTS.has(host)) continue;
    out.push({ src: src.slice(0, 200), host: host || null });
  }
  return out;
}

/** 正文里的占位清单（`mpwx:<id>`），用于与调用方送来的 images 对账。 */
function markersIn(html) {
  const ids = new Set();
  const re = new RegExp(`"${MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([A-Za-z0-9_-]{1,64})"`, 'g');
  for (const m of String(html).matchAll(re)) ids.add(m[1]);
  return ids;
}

function createWechatDraftService({
  credentials, transport, readImage, inspectImage = null,
  dir, log = () => {}, baseUrl = null, now = () => Date.now(), imageLimits = {},
} = {}) {
  if (!credentials) throw new Error('缺少凭据存储');
  if (typeof readImage !== 'function') throw new Error('缺少本地读图实现（readImage）');
  const limits = {
    contentImage: MAX_CONTENT_IMAGE_BYTES, cover: MAX_COVER_BYTES,
    images: MAX_IMAGES, imagesTotal: MAX_IMAGES_TOTAL, ...imageLimits,
  };
  const pendingFile = dir ? path.join(dir, 'wechat-pending.json') : null;
  const lastFile = dir ? path.join(dir, 'wechat-last-draft.json') : null;
  let tokenCache = null;
  let inFlight = null;
  /* 封面按**发起窗口**分账：A 窗口选的封面，B 窗口既看不到也用不了（否则"另一个窗口的封面"
     会静默变成这篇的封面，用户根本没法察觉）。key = owner.id。 */
  const covers = new Map();
  let coverSerial = 0;
  const say = (event, detail) => { try { log(event, sanitize(detail)); } catch { /* 日志失败不反噬 */ } };

  /** 调用方身份（主进程判定后传进来）：id 用来隔离封面，docDir() 用来解析相对图片地址。 */
  function ownerOf(owner) {
    const id = owner && owner.id != null ? String(owner.id) : '';
    if (!id) return null;
    const docDir = () => { try { const d = typeof owner.docDir === 'function' ? owner.docDir() : owner.docDir; return d ? String(d) : null; } catch { return null; } };
    const alive = () => { try { return typeof owner.alive === 'function' ? owner.alive() === true : true; } catch { return false; } };
    return { id, docDir, alive };
  }

  function readJson(file) {
    if (!file) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }
  function writeJson(file, value) {
    if (!file) return { ok: true };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      return { ok: true };
    } catch (error) { return { ok: false, error: String((error && error.message) || error) }; }
  }
  function removeFile(file) { if (file) { try { fs.rmSync(file, { force: true }); } catch { /* 忽略 */ } } }

  const pending = () => readJson(pendingFile);
  const lastDraft = () => readJson(lastFile);
  function resetToken() { tokenCache = null; }

  async function obtainToken({ allowLegacy = true } = {}) {
    const cred = credentials.read();
    if (!cred.ok) return cred;
    if (tokenCache && tokenCache.expiresAt > now() + 60000) return { ok: true, token: tokenCache.token, cached: true };
    const common = { base: baseUrl || undefined, appId: cred.appId, secret: cred.secret };
    let r = await api.fetchStableToken(transport, common);
    if (!r.ok && allowLegacy && r.code !== 'MP_WX_API') {
      /* stable_token 不可用（老账号/网络抖动）时回退一次老接口；凭据仍只在宿主内。 */
      say('token:legacy-fallback', { code: r.code });
      r = await api.fetchLegacyToken(transport, common);
    }
    if (!r.ok) return { ok: false, ...r, hint: hintFor(r.errcode) };
    tokenCache = { token: r.token, expiresAt: now() + Math.min(r.expiresIn, 7200) * 1000 };
    say('token:ok', { expiresIn: r.expiresIn, appId: cred.appId });
    return { ok: true, token: r.token, cached: false };
  }

  /** 对外状态：**不含 secret/token/封面地址**。covers 只列**本窗口**自己选过的封面。 */
  function status(owner = null) {
    const o = ownerOf(owner);
    const cred = credentials.status();
    const p = pending();
    return {
      ok: true,
      configured: cred.configured,
      appId: cred.appId,
      keystore: cred.keystore,
      problem: cred.problem,
      pending: p ? { at: p.at || null, stage: p.stage || null, title: p.title || null } : null,
      lastDraft: lastDraft(),
      tokenReady: !!(tokenCache && tokenCache.expiresAt > now()),
      covers: o ? [...covers.entries()].filter(([, c]) => c.owner === o.id)
        .map(([id, c]) => ({ id, name: c.name, bytes: c.bytes.length, mime: c.mime, width: c.width, height: c.height })) : [],
    };
  }

  function configure(payload) { resetToken(); return credentials.save(payload || {}); }
  function clear(owner = null) {
    resetToken();
    const o = ownerOf(owner);
    if (o) { for (const [id, c] of [...covers]) if (c.owner === o.id) covers.delete(id); }
    else covers.clear();
    return credentials.clear();
  }

  async function verify() {
    const t = await obtainToken();
    if (!t.ok) return { ok: false, stage: 'token', code: t.code, errcode: t.errcode || null, error: t.error, hint: t.hint || hintFor(t.errcode) };
    const r = await api.fetchDraftCount(transport, { base: baseUrl || undefined, token: t.token });
    if (!r.ok) return { ok: false, stage: 'verify', code: r.code, errcode: r.errcode || null, error: r.error, hint: hintFor(r.errcode) };
    say('verify:ok', { total: r.total });
    return { ok: true, total: r.total, appId: credentials.status().appId };
  }

  /** 封面入池：读本地图（拒绝 http/https），校验可解码再把字节留在宿主。**按窗口隔离**。 */
  async function putCover({ src } = {}, owner = null) {
    const o = ownerOf(owner);
    if (!o) return { ok: false, code: 'MP_WX_NO_OWNER', error: '缺少发起窗口，拒绝处理封面' };
    const source = String(src == null ? '' : src);
    if (!source) return { ok: false, code: 'MP_WX_COVER_MISSING', error: '没有提供封面图' };
    if (/^(?:https?:)?\/\//i.test(source)) {
      return { ok: false, code: 'MP_WX_IMAGE_REMOTE', error: '封面不能直接用网址：请先把封面存到本地，再选择本地文件' };
    }
    let read;
    try { read = await readImage(source, { owner: o, base64: /^data:/i.test(source) }); }
    catch (error) { return { ok: false, code: 'MP_WX_IMAGE_READ', error: `读取封面失败：${String((error && error.message) || error)}` }; }
    if (!read || read.ok !== true) return { ok: false, code: (read && read.code) || 'MP_WX_IMAGE_READ', error: (read && read.error) || '读取封面失败' };
    const mime = String(read.mime || '').toLowerCase();
    if (!ALLOWED_IMAGE_MIME.has(mime)) return { ok: false, code: 'MP_WX_IMAGE_TYPE', error: `封面格式是 ${mime || '未知'}，微信只支持 JPG/PNG` };
    if (read.bytes.length > limits.cover) {
      return { ok: false, code: 'MP_WX_COVER_LARGE', error: `封面 ${(read.bytes.length / 1048576).toFixed(1)} MB，超过微信上限 ${(limits.cover / 1048576).toFixed(1)} MB` };
    }
    let size = { width: null, height: null };
    if (inspectImage) {
      let info = null;
      try { info = await inspectImage({ bytes: read.bytes, mime }); } catch { info = null; }
      if (!info || info.ok !== true) return { ok: false, code: 'MP_WX_COVER_DECODE', error: '这张封面图解析失败（可能已损坏），请换一张 JPG/PNG' };
      size = { width: Number(info.width) || null, height: Number(info.height) || null };
    }
    const id = 'cover-' + o.id + '-' + (++coverSerial) + '-' + sha256(read.bytes).slice(0, 8);
    covers.set(id, { owner: o.id, bytes: read.bytes, mime, name: read.name || `cover-${id}.${mime === 'image/png' ? 'png' : 'jpg'}`, sha256: sha256(read.bytes), at: now(), ...size });
    /* 上限按窗口算：只清掉**本窗口**最老的那张，别的窗口的封面不受影响。 */
    const mine = [...covers.entries()].filter(([, c]) => c.owner === o.id);
    while (mine.length > 8) { const [old] = mine.shift(); covers.delete(old); }
    say('cover:put', { id, bytes: read.bytes.length, mime, ...size });
    return { ok: true, id, name: read.name || null, bytes: read.bytes.length, mime, ...size };
  }
  function dropCover(id, owner = null) {
    const o = ownerOf(owner);
    const key = String(id || '');
    const c = covers.get(key);
    if (!c || (o && c.owner !== o.id)) return { ok: true, removed: false };
    return { ok: true, removed: covers.delete(key) };
  }
  function coverInfo(id) {
    const c = covers.get(String(id || ''));
    return c ? { id: String(id), name: c.name, bytes: c.bytes.length, mime: c.mime, width: c.width, height: c.height } : null;
  }
  function clearCovers(owner = null) {
    const o = ownerOf(owner);
    if (!o) { covers.clear(); return; }
    for (const [id, c] of [...covers]) if (c.owner === o.id) covers.delete(id);
  }

  /**
   * 只做校验（+ 读本地图，不联网）：对话框在"开始发送"之前用它先给出可读的前置错误。
   * 返回 { ok, title, html, images:[{id,bytes,mime,name}], coverId }。
   * owner 由**主进程**判定后传入：相对图片地址按该窗口自己的文档目录解析，
   * 封面必须是该窗口自己选的那一张（跨窗口的封面一律视为失效）。
   */
  async function preflight({ title, html, images = [], coverId } = {}, owner = null) {
    const o = ownerOf(owner);
    if (!o) return { ok: false, code: 'MP_WX_NO_OWNER', error: '缺少发起窗口，拒绝处理' };
    const t = checkTitle(title);
    if (!t.ok) return t;
    const h = checkHtml(html);
    if (!h.ok) return h;
    const remote = remoteImagesIn(h.html);
    if (remote.length) {
      return {
        ok: false, code: 'MP_WX_IMAGE_REMOTE', remote,
        error: `正文里有 ${remote.length} 张图片是外部网址（${remote.slice(0, 3).map(r => r.host || r.src).join('、')}${remote.length > 3 ? ' 等' : ''}）。`
          + '公众号只接受上传过的图片，本工具不会替你下载外链。请把这些图保存到文档目录（或直接粘贴进文档）后再发送。',
      };
    }
    if (!Array.isArray(images)) return { ok: false, code: 'MP_WX_IMAGES_BAD', error: '图片清单格式不对' };
    if (images.length > limits.images) return { ok: false, code: 'MP_WX_IMAGES_MANY', error: `正文图片超过 ${limits.images} 张，请拆分文章` };
    const markers = markersIn(h.html);
    const seen = new Set();
    const list = [];
    let total = 0;
    for (const raw of images) {
      const id = String((raw && raw.id) || '');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { ok: false, code: 'MP_WX_IMAGE_BAD', error: '图片标识不合法' };
      if (seen.has(id)) return { ok: false, code: 'MP_WX_IMAGE_BAD', id, error: `图片占位 ${id} 重复` };
      seen.add(id);
      if (!markers.has(id)) return { ok: false, code: 'MP_WX_IMAGE_UNUSED', id, error: `正文里没有找到图片占位 ${MARKER_PREFIX}${id}（图片与正文不一致，可能文档中途改过）` };
      const src = String((raw && raw.src) || '');
      if (!src) return { ok: false, code: 'MP_WX_IMAGE_BAD', id, error: `图片 ${id} 没有地址` };
      if (/^(?:https?:)?\/\//i.test(src)) return { ok: false, code: 'MP_WX_IMAGE_REMOTE', id, error: `图片 ${id} 是外部网址，本工具不会下载它` };
      let read;
      try { read = await readImage(src, { owner: o, base64: /^data:/i.test(src) }); }
      catch (error) { return { ok: false, code: 'MP_WX_IMAGE_READ', id, error: `读取图片 ${id} 失败：${String((error && error.message) || error)}` }; }
      if (!read || read.ok !== true) return { ok: false, code: (read && read.code) || 'MP_WX_IMAGE_READ', id, error: (read && read.error) || `读取图片 ${id} 失败` };
      const mime = String(read.mime || '').toLowerCase();
      if (!ALLOWED_IMAGE_MIME.has(mime)) return { ok: false, code: 'MP_WX_IMAGE_TYPE', id, error: `图片 ${id} 是 ${mime || '未知格式'}，微信正文图只支持 JPG/PNG（SVG/GIF/WebP 请先转成 PNG）` };
      if (read.bytes.length > limits.contentImage) {
        return { ok: false, code: 'MP_WX_IMAGE_LARGE', id, error: `正文图 ${id} 有 ${(read.bytes.length / 1048576).toFixed(2)} MB，超过微信正文图上限 1MB` };
      }
      total += read.bytes.length;
      if (total > limits.imagesTotal) return { ok: false, code: 'MP_WX_IMAGES_LARGE', error: '正文图片总量超过 24MB，请压缩后再发送' };
      list.push({ id, bytes: read.bytes, mime, name: read.name || `image-${id}.${mime === 'image/png' ? 'png' : 'jpg'}` });
    }
    for (const id of markers) {
      if (!seen.has(id)) return { ok: false, code: 'MP_WX_IMAGE_MISSING', id, error: `正文里的图片占位 ${MARKER_PREFIX}${id} 没有对应数据（请重新生成预览后再发送）` };
    }
    if (!coverId) return { ok: false, code: 'MP_WX_COVER_MISSING', error: '还没有选择封面：微信草稿必须带封面图' };
    const picked = covers.get(String(coverId));
    if (!picked) return { ok: false, code: 'MP_WX_COVER_STALE', error: '封面已失效，请重新选择封面图' };
    if (picked.owner !== o.id) return { ok: false, code: 'MP_WX_COVER_FOREIGN', error: '这张封面属于另一个窗口，请在本窗口重新选择封面图' };
    return { ok: true, title: t.title, html: h.html, images: list, coverId: String(coverId), owner: o };
  }

  function markPending(record) {
    writeJson(pendingFile, { at: new Date(now()).toISOString(), ...record });
    say('draft:pending', record);
  }

  /**
   * 建草稿（**只建草稿**）。顺序：pending 闸门 → 校验 → 凭据 → token → 正文图 → 封面素材 → 替换占位 → draft/add。
   * 任何一步失败都不自动重来；建草稿结果不明确时保留 pending，直到用户显式确认。
   */
  async function createDraft({ title, html, images = [], coverId, acknowledgeUncertain = false, digest = null, author = null, isCurrent = null } = {}, owner = null) {
    if (inFlight) return { ok: false, stage: 'busy', code: 'MP_WX_BUSY', error: '上一次发送还在进行中，请等它结束' };
    const o = ownerOf(owner);
    if (!o) return { ok: false, stage: 'owner', code: 'MP_WX_NO_OWNER', error: '缺少发起窗口，拒绝发送' };
    inFlight = 'create';
    try {
      const p = pending();
      if (p && !acknowledgeUncertain) {
        return {
          ok: false, stage: 'pending', code: 'MP_WX_PENDING_UNCERTAIN',
          error: `上次创建草稿的结果不明确（${p.at || '时间未知'}）：草稿可能已经建好。请先打开公众号后台 → 草稿箱核对；`
            + '确认后勾选「我已核对草稿箱」再发送。本工具不会自动重试。',
          pending: { at: p.at || null, stage: p.stage || null, title: p.title || null },
        };
      }
      if (p && acknowledgeUncertain) { removeFile(pendingFile); say('draft:pending-acknowledged', { at: p.at || null }); }

      const pre = await preflight({ title, html, images, coverId }, o);
      if (!pre.ok) return { ...pre, stage: 'validate' };

      const t = await obtainToken();
      if (!t.ok) return { ok: false, stage: 'token', code: t.code, errcode: t.errcode || null, error: t.error, hint: t.hint || hintFor(t.errcode) };

      const base = baseUrl || undefined;
      /* ① 正文图：串行上传，失败即停（不生成缺图的草稿）。 */
      const uploaded = [];
      for (const img of pre.images) {
        const r = await api.uploadContentImage(transport, { base, token: t.token, bytes: img.bytes, mime: img.mime, filename: img.name });
        if (!r.ok) {
          say('image:failed', { id: img.id, code: r.code, errcode: r.errcode, uploaded: uploaded.length });
          return {
            ok: false, stage: 'image', code: r.code, errcode: r.errcode || null,
            error: `正文图 ${img.id} 上传失败：${r.error}${hintFor(r.errcode) ? '（' + hintFor(r.errcode) + '）' : ''}`,
            hint: hintFor(r.errcode), failedImage: img.id,
            uploaded: { images: uploaded.length, of: pre.images.length, cover: false },
            draftCreated: false, mediaId: null,
          };
        }
        uploaded.push({ id: img.id, url: r.url });
      }

      /* ② 封面：永久图片素材 ⇒ thumb_media_id（必须是**本窗口**自己选的那张）。 */
      const cover = covers.get(pre.coverId);
      if (!cover) return { ok: false, stage: 'cover', code: 'MP_WX_COVER_STALE', error: '封面已失效，请重新选择封面图', draftCreated: false, mediaId: null };
      if (cover.owner !== o.id) return { ok: false, stage: 'cover', code: 'MP_WX_COVER_FOREIGN', error: '这张封面属于另一个窗口，请在本窗口重新选择封面图', draftCreated: false, mediaId: null };
      const material = await api.uploadCoverMaterial(transport, { base, token: t.token, bytes: cover.bytes, mime: cover.mime, filename: cover.name });
      if (!material.ok) {
        say('cover:failed', { code: material.code, errcode: material.errcode });
        return {
          ok: false, stage: 'cover', code: material.code, errcode: material.errcode || null,
          error: `封面上传失败：${material.error}${hintFor(material.errcode) ? '（' + hintFor(material.errcode) + '）' : ''}`,
          hint: hintFor(material.errcode),
          uploaded: { images: uploaded.length, of: pre.images.length, cover: false },
          draftCreated: false, mediaId: null,
        };
      }

      /* ③ 占位替换：只替换带引号的完整占位；残留 ⇒ 构造错误，停止。 */
      let content = pre.html;
      for (const item of uploaded) {
        const needle = `"${MARKER_PREFIX}${item.id}"`;
        if (!content.includes(needle)) return { ok: false, stage: 'compose', code: 'MP_WX_IMAGE_UNUSED', error: `正文里没有找到图片占位 ${MARKER_PREFIX}${item.id}`, draftCreated: false, mediaId: null };
        content = content.split(needle).join(`"${item.url}"`);
      }
      if (content.includes(`"${MARKER_PREFIX}`)) {
        return { ok: false, stage: 'compose', code: 'MP_WX_MARKER_LEFT', error: '正文里还有未替换的图片占位，已停止发送（不会创建缺图的草稿）', draftCreated: false, mediaId: null };
      }
      const h = checkHtml(content);
      if (!h.ok) return { ...h, stage: 'compose', draftCreated: false, mediaId: null };

      const article = {
        title: pre.title,
        author: typeof author === 'string' && author.trim() ? author.trim().slice(0, 16) : '',
        digest: typeof digest === 'string' ? String(digest).slice(0, 120) : '',
        content: h.html,
        content_source_url: '',
        thumb_media_id: material.mediaId,
        need_open_comment: 0,
        only_fans_can_comment: 0,
      };


      /* ④ 建草稿：**先落 pending 再发请求**（进程崩溃/断电也能在下次打开时提示"结果不明确"）。
         建稿前最后两道归属校验：① 发起窗口还活着；② 文档没被切走。
         上传是幂等的，建稿不是 —— 这两项任一不成立就停在这里，绝不"替一个已经消失的窗口建稿"。 */
      if (!o.alive()) {
        say('draft:owner-gone', { uploaded: uploaded.length });
        return { ok: false, stage: 'compose', code: 'MP_WX_OWNER_GONE', error: '发起发送的窗口已经关闭，已停止创建草稿（可以重新打开文档再发一次）',
          uploaded: { images: uploaded.length, of: pre.images.length, cover: true }, draftCreated: false, mediaId: null };
      }
      if (typeof isCurrent === 'function') {
        let current = false;
        try { current = isCurrent() === true; } catch { current = false; }
        if (!current) {
          say('draft:document-changed', { uploaded: uploaded.length });
          return { ok: false, stage: 'compose', code: 'MP_WX_DOC_CHANGED', error: '发送期间文档被切换或关闭，已停止创建草稿（图片上传不影响任何东西，可以重发）',
            uploaded: { images: uploaded.length, of: pre.images.length, cover: true }, draftCreated: false, mediaId: null };
        }
      }
      markPending({ stage: 'draft', title: pre.title });
      const r = await api.addDraft(transport, { base, token: t.token, article });
      if (r.ok) {
        removeFile(pendingFile);
        writeJson(lastFile, { mediaId: r.mediaId, at: new Date(now()).toISOString(), title: pre.title, images: uploaded.length });
        say('draft:created', { mediaId: r.mediaId, images: uploaded.length });
        return { ok: true, stage: 'done', mediaId: r.mediaId, title: pre.title,
          uploaded: { images: uploaded.length, of: pre.images.length, cover: true } };
      }
      if (r.code === 'MP_WX_API') {
        /* 明确失败（微信返回 errcode）⇒ 服务端没有留下草稿。 */
        removeFile(pendingFile);
        say('draft:failed', { errcode: r.errcode });
        return {
          ok: false, stage: 'draft', code: 'MP_WX_DRAFT_REJECTED', errcode: r.errcode || null,
          error: `微信拒绝创建草稿：${r.error}${hintFor(r.errcode) ? '（' + hintFor(r.errcode) + '）' : ''}`,
          hint: hintFor(r.errcode),
          uploaded: { images: uploaded.length, of: pre.images.length, cover: true },
          draftCreated: false, mediaId: null,
        };
      }
      /* 超时/网络中断/回包不可解析 ⇒ 结果不明确：**保留 pending**、绝不自动重试。 */
      say('draft:uncertain-result', { code: r.code, timedOut: !!r.timedOut });
      const why = r.timedOut ? '创建草稿超时' : r.code === 'MP_WX_BAD_REPLY' ? '微信回包无法解析' : '创建草稿时网络中断';
      return {
        ok: false, stage: 'draft', code: 'MP_WX_DRAFT_UNCERTAIN', uncertain: true, timedOut: !!r.timedOut,
        error: `${why}，结果不明确：草稿**可能已经建好**。请先到公众号后台 → 草稿箱核对，再决定是否重发；本工具不会自动重试。`,
        uploaded: { images: uploaded.length, of: pre.images.length, cover: true },
        draftCreated: null, mediaId: null,
      };
    } finally { inFlight = null; }
  }

  /** 用户核对过草稿箱后清掉"结果不明确"标记（显式动作）。 */
  function acknowledgeUncertain() {
    const p = pending();
    removeFile(pendingFile);
    say('draft:acknowledged', { at: p && p.at || null });
    return { ok: true, acknowledged: p || null };
  }

  return {
    status, configure, clear, verify, preflight, createDraft,
    putCover, dropCover, coverInfo, clearCovers, acknowledgeUncertain,
    pending, lastDraft, resetToken,
    /* 窗口关闭时清掉它名下的封面（不碰别的窗口）。 */
    releaseOwner: (ownerId) => {
      const id = String(ownerId == null ? '' : ownerId);
      let n = 0;
      for (const [key, c] of [...covers]) if (c.owner === id) { covers.delete(key); n++; }
      return { ok: true, removed: n };
    },
    inspect: () => ({
      covers: [...covers.entries()].map(([id, c]) => ({ id, owner: c.owner })),
      tokenCached: !!(tokenCache && tokenCache.expiresAt > now()),
      busy: !!inFlight, pending: pending(), lastDraft: lastDraft(), limits: { ...limits },
    }),
  };
}

module.exports = {
  createWechatDraftService,
  checkTitle, checkHtml, remoteImagesIn, markersIn, hintFor, sanitize,
  MARKER_PREFIX, WECHAT_IMAGE_HOSTS,
  CONSTANTS: {
    MAX_CONTENT_CHARS, MAX_CONTENT_BYTES, MAX_TITLE_CHARS, MAX_CONTENT_IMAGE_BYTES,
    MAX_COVER_BYTES, MAX_IMAGES, MAX_IMAGES_TOTAL, ALLOWED_IMAGE_MIME: [...ALLOWED_IMAGE_MIME],
  },
};
