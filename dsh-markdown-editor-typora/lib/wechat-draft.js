// dsh-markdown-editor-typora · 公众号草稿（DSH 可信宿主半边）
//
// 边界（本文件是**隔离模块**；中心自有 lib/index.js / client.js / dsh-bridge.js / 皮肤入口）：
//   · 复用已验收的 EXE 微信实现（host/wechat-api.js / wechat-transport.js /
//     wechat-credentials.js / wechat-draft-service.js，由 scripts/sync-host.mjs 白名单同步）；
//     本文件只做 DSH 适配：按 owner 的账号服务、严格 data: 字节输入、内存/密钥库凭据、
//     dispose。**不另写第二份微信协议**（端点白名单、multipart、errcode、pending、
//     防重复闸门全部来自 service）。
//   · **不读盘、不发自己的请求**：正文图与封面只接受随本次调用带入的
//     `data:image/(png|jpeg);base64,…`；文件路径 / UNC / file: / http(s) 一律拒绝。
//   · **不信任调用方自报的位置**：scope 由中心从已认证用户 + 当前文档/tab 实例解析后注入；
//     本模块不采信 payload 里的 dir/path/workspace/sessionId，也不用它们做任何授权判定。
//   · 凭据只在宿主：系统密钥库可用则加密落盘（0600）；不可用则**仅本进程内存**，
//     绝不写明文、不回显、不进日志。
//
// 唯一导出：createPluginWechatHost(deps) → { handle(action,payload,scope), dispose(), inspect() }

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

const requireHost = createRequire(import.meta.url);

const ACTIONS = new Set(['status', 'configure', 'clear', 'verify', 'pickCover', 'createDraft']);
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg']);
/** data URL 字符上限（封面上限 10MB 的 base64 约 13.4MB；再留 4KB 头）。超限在解码前就拒。 */
const MAX_DATA_URL_CHARS = Math.ceil((10 * 1024 * 1024 * 4) / 3) + 4096;
/** 图片边长上限：挡住"声明尺寸巨大"的畸形图；正常封面/正文图远小于此。 */
const MAX_IMAGE_SIDE = 40000;

/* ── 图片字节识别（PNG/JPEG；不依赖原生解码器，纯字节判）──────────────────────── */

/**
 * 读真实类型与尺寸；只有 PNG / JPEG 被接受。
 * @param {Uint8Array|Buffer} bytes
 * @returns {{ok:true,mime:string,width:number,height:number}|{ok:false,error:string}}
 */
export function imageInfoOf(bytes) {
  if (!bytes || !bytes.length) return { ok: false, error: '图片内容为空' };
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    if (b.length < 24) return { ok: false, error: 'PNG 头部不完整' };
    if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== 'IHDR') return { ok: false, error: 'PNG 缺少 IHDR' };
    const width = readU32(b, 16), height = readU32(b, 20);
    if (!saneSize(width, height)) return { ok: false, error: `PNG 尺寸异常（${width}×${height}）` };
    return { ok: true, mime: 'image/png', width, height };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const size = jpegSize(b);
    if (!size.ok) return size;
    if (!saneSize(size.width, size.height)) return { ok: false, error: `JPEG 尺寸异常（${size.width}×${size.height}）` };
    return { ok: true, mime: 'image/jpeg', width: size.width, height: size.height };
  }
  return { ok: false, error: '不是可识别的 JPG/PNG' };
}
function readU32(b, at) { return ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3]; }
function readU16(b, at) { return (b[at] << 8) + b[at + 1]; }
function saneSize(width, height) {
  return Number.isInteger(width) && Number.isInteger(height)
    && width > 0 && height > 0 && width <= MAX_IMAGE_SIDE && height <= MAX_IMAGE_SIDE;
}
/** 遍历 JPEG 段找 SOF（C0..CF 除 C4/C8/CC），边界显式检查；坏数据返回错误而不是抛。 */
function jpegSize(b) {
  let pos = 2;
  while (pos + 3 < b.length) {
    if (b[pos] !== 0xff) { pos += 1; continue; }
    let marker = b[pos + 1];
    while (marker === 0xff && pos + 2 < b.length) { pos += 1; marker = b[pos + 1]; }
    pos += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (pos + 1 >= b.length) break;
    const length = readU16(b, pos);
    if (length < 2) return { ok: false, error: 'JPEG 段长度损坏' };
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (pos + 7 >= b.length) return { ok: false, error: 'JPEG SOF 段不完整' };
      const height = readU16(b, pos + 3), width = readU16(b, pos + 5);
      return { ok: true, width, height };
    }
    pos += length;
  }
  return { ok: false, error: 'JPEG 里找不到尺寸段（文件可能已损坏）' };
}

/* ── 无系统密钥库时的凭据：只在本次运行的内存里 ─────────────────────────────── */

function createMemoryCredentials({ notice, normalizeAppId, normalizeSecret }) {
  let memory = null;
  function read() {
    if (memory) return { ok: true, appId: memory.appId, secret: memory.secret };
    return { ok: false, code: 'MP_WX_NOT_CONFIGURED', error: '尚未配置微信公众号 appid / secret' };
  }
  return {
    file: null,
    memoryOnly: true,
    notice,
    keystore: () => false,
    read,
    status() {
      const ok = read();
      return {
        configured: ok.ok === true,
        appId: ok.ok ? ok.appId : null,
        secretStored: ok.ok === true,
        secretMode: ok.ok ? 'memory' : 'none',
        keystore: false,
        memoryOnly: true,
        notice,
        file: null,
        problem: ok.ok ? null : { code: ok.code, error: ok.error },
      };
    },
    save({ appId, secret } = {}) {
      const id = normalizeAppId(appId);
      if (!id) return { ok: false, code: 'MP_WX_BAD_APPID', error: 'appid 看起来不对：应以 wx 开头，后接字母数字（公众号后台「开发 → 基本配置」里复制）' };
      const key = normalizeSecret(secret);
      if (!key) return { ok: false, code: 'MP_WX_BAD_SECRET', error: 'AppSecret 看起来不对：应是 32 位字母数字（公众号后台可查看/重置）' };
      memory = { appId: id, secret: key };
      return { ok: true, appId: id, secretStored: true, secretMode: 'memory', memoryOnly: true, notice };
    },
    clear() { memory = null; return { ok: true, removed: true }; },
  };
}

/* ── 主入口 ─────────────────────────────────────────────────────────────────── */

/**
 * 建一个 DSH 侧的微信草稿宿主。同步构造；缺少可用传输/凭据模块时抛错（配置期失败要早暴露）。
 *
 * @param {object} [deps]
 * @param {object} [deps.log]          {info,warn,error}
 * @param {string} [deps.stateDir]     pending/last-draft/（可用时）加密凭据的落盘根
 * @param {object} [deps.osProtect]    系统密钥库：{isEncryptionAvailable|available, encryptString, decryptString}
 * @param {object} [deps.env]          判测试接缝（MP_TEST_HOOKS + MP_WX_BASE_URL）
 * @param {{fetch:Function}} [deps.net]
 * @param {Function} [deps.transport]  直接注入传输（测试用，优先于 net）
 * @param {Function} [deps.now]
 */
export function createPluginWechatHost(deps = {}) {
  const log = deps.log ?? {};
  const env = deps.env ?? process.env;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const say = (event, detail) => { try { log.info?.(`wechat:${event}`, detail); } catch { /* 日志失败不反噬 */ } };

  const api = requireHost('../host/wechat-api.js');
  const transportModule = requireHost('../host/wechat-transport.js');
  const credentialsModule = requireHost('../host/wechat-credentials.js');
  const serviceModule = requireHost('../host/wechat-draft-service.js');
  const dataImages = requireHost('../host/data-image-bytes.js');
  const sanitize = typeof serviceModule.sanitize === 'function' ? serviceModule.sanitize : (x) => x;
  if (!api || typeof api.addDraft !== 'function') throw new Error('wechat-asset-missing: 缺少 host/wechat-api.js（先跑 scripts/sync-host.mjs）');

  const base = transportModule.resolveBaseUrl({ env });
  const transport = typeof deps.transport === 'function'
    ? deps.transport
    : transportModule.createNetTransport({
      net: deps.net ?? { fetch: (...args) => globalThis.fetch(...args) },
      base: base.base,
    });

  const stateDir = deps.stateDir || defaultStateDir();
  const accounts = new Map();
  let disposed = false;

  /** 严格 data: 图片 —— 唯一被允许的字节来源。 */
  function readImage(src) {
    const value = String(src == null ? '' : src);
    if (/^(?:https?:)?\/\//i.test(value)) {
      return { ok: false, code: 'MP_WX_IMAGE_REMOTE', error: '不接受网络图片地址：请把图片放进正文后重新生成预览' };
    }
    if (!/^data:/i.test(value)) {
      return { ok: false, code: 'MP_WX_IMAGE_PATH', error: '只接受随本次发送带入的图片数据（data:），不接受文件路径' };
    }
    if (value.length > MAX_DATA_URL_CHARS) {
      return { ok: false, code: 'MP_WX_IMAGE_LARGE', error: '图片数据过大（超过 10MB），请压缩后再发送' };
    }
    let decoded;
    try { decoded = dataImages.decodeAssetImage(value); }
    catch (error) { return { ok: false, code: (error && error.code) || 'E_DATA_IMAGE', error: String((error && error.message) || error) }; }
    if (!decoded || !decoded.buf || !decoded.buf.length) return { ok: false, code: 'MP_WX_IMAGE_READ', error: '图片内容为空' };
    const mime = String(decoded.mime || '').toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      return { ok: false, code: 'MP_WX_IMAGE_TYPE', error: `图片格式是 ${mime || '未知'}，微信正文图/封面只支持 JPG/PNG` };
    }
    const info = imageInfoOf(decoded.buf);
    if (!info.ok) return { ok: false, code: 'MP_WX_IMAGE_DECODE', error: `这张图解析失败（${info.error}）` };
    if (info.mime !== mime) {
      return { ok: false, code: 'MP_WX_IMAGE_TYPE', error: `图片内容与声明的类型不一致（声明 ${mime}，实际 ${info.mime}）` };
    }
    return { ok: true, bytes: decoded.buf, mime, name: 'inline.' + (mime === 'image/png' ? 'png' : 'jpg') };
  }
  function inspectImage({ bytes }) {
    const info = imageInfoOf(bytes);
    return info.ok ? { ok: true, width: info.width, height: info.height } : { ok: false, error: info.error };
  }

  /** 账号级服务：凭据 / pending / token / 在途闸门按账号；封面按发起端（owner.id）隔离。 */
  function accountFor(userKey) {
    const existing = accounts.get(userKey);
    if (existing) return existing;
    const dir = join(stateDir, 'accounts', createHash('sha256').update(String(userKey)).digest('hex').slice(0, 16));
    const protect = deps.osProtect;
    const available = (() => {
      try {
        if (!protect) return false;
        const probe = typeof protect.isEncryptionAvailable === 'function'
          ? protect.isEncryptionAvailable
          : protect.available;
        return typeof probe === 'function' && probe.call(protect) === true;
      } catch { return false; }
    })();
    const credentials = available
      ? credentialsModule.createWechatCredentials({ dir, safeStorage: protect })
      : createMemoryCredentials({
        notice: '系统密钥库不可用：AppSecret 只保存在本次运行的记忆里，关闭应用后需要重新填写（不会明文写盘）。',
        normalizeAppId: credentialsModule.normalizeAppId,
        normalizeSecret: credentialsModule.normalizeSecret,
      });
    const service = serviceModule.createWechatDraftService({
      credentials, transport, readImage, inspectImage,
      dir, baseUrl: base.mock ? base.base : null, now,
      log: (event, detail) => say(event, sanitize(detail)),
    });
    const record = { key: userKey, dir, credentials, service };
    accounts.set(userKey, record);
    return record;
  }

  /** scope → {owner(服务用), account, isCurrent}；不合格返回 null（**不发任何请求**）。 */
  function resolveScope(action, scope) {
    const userKey = String(scope?.ownerId ?? '').trim();
    if (!userKey) return null;
    if (action === 'createDraft' && typeof scope?.isCurrent !== 'function') return null;
    const tabId = String(scope?.tabId ?? '').trim() || userKey;
    const alive = () => {
      try { return typeof scope?.alive === 'function' ? scope.alive() !== false : true; }
      catch { return false; }
    };
    const owner = { id: tabId, docDir: () => null, alive };
    const isCurrent = () => {
      try { return typeof scope?.isCurrent === 'function' ? scope.isCurrent() === true : true; }
      catch { return false; }
    };
    return { owner, isCurrent, account: accountFor(userKey) };
  }

  async function handle(action, payload = {}, scope = null) {
    if (disposed) return { ok: false, code: 'MP_WX_DISPOSED', error: '公众号功能已卸载，请重开编辑器' };
    if (!ACTIONS.has(action)) return { ok: false, code: 'MP_WX_ACTION', error: `未知动作：${String(action)}` };
    const resolved = resolveScope(action, scope);
    if (!resolved) {
      return {
        ok: false, code: 'MP_WX_SCOPE',
        error: action === 'createDraft'
          ? '缺少可信的发起者/文档绑定，拒绝发送'
          : '缺少可信的发起者绑定，拒绝处理',
      };
    }
    const { owner, account, isCurrent } = resolved;
    const service = account.service;
    try {
      switch (action) {
        case 'status': {
          const status = service.status(owner);
          return { ...status, memoryOnly: account.credentials.memoryOnly === true, notice: account.credentials.notice ?? null };
        }
        case 'configure': {
          const saved = service.configure({ appId: payload?.appId, secret: payload?.secret });
          if (!saved || saved.ok !== true) return saved;
          return { ...saved, memoryOnly: account.credentials.memoryOnly === true, notice: account.credentials.notice ?? null };
        }
        case 'clear':
          return service.clear(owner);
        case 'verify':
          return await service.verify();
        case 'pickCover': {
          const dataUrl = String(payload?.dataUrl ?? '');
          if (!dataUrl) return { ok: false, code: 'MP_WX_COVER_MISSING', error: '没有提供封面图' };
          if (dataUrl.length > MAX_DATA_URL_CHARS) {
            return { ok: false, code: 'MP_WX_COVER_LARGE', error: '封面图超过 10MB，请换一张' };
          }
          const picked = await service.putCover({ src: dataUrl }, owner);
          if (!picked || picked.ok !== true) return picked;
          return {
            ok: true, id: picked.id, name: picked.name || payload?.name || null,
            bytes: picked.bytes, mime: picked.mime, width: picked.width, height: picked.height,
          };
        }
        case 'createDraft': {
          /* 第一道：进入服务之前先看发起端是否还是同一份文档（同目录换稿也算变了）。 */
          if (!isCurrent()) {
            return {
              ok: false, stage: 'owner', code: 'MP_WX_DOC_CHANGED',
              error: '发送前文档已被切换或关闭，已停止创建草稿（重新打开文档后再发一次）',
              draftCreated: false, mediaId: null,
            };
          }
          const result = await service.createDraft({
            title: payload?.title,
            html: payload?.html,
            images: Array.isArray(payload?.images) ? payload.images : [],
            coverId: payload?.coverId,
            author: typeof payload?.author === 'string' ? payload.author : null,
            acknowledgeUncertain: payload?.acknowledgeUncertain === true,
            /* 第二道在服务内部、draft/add 之前再复核一次（图片上传之后）。 */
            isCurrent,
          }, owner);
          say('draft:result', { ok: !!result.ok, stage: result.stage || null, code: result.code || null, mediaId: result.mediaId || null });
          return result;
        }
        default:
          return { ok: false, code: 'MP_WX_ACTION', error: '未知动作' };
      }
    } catch (error) {
      say('error', { action, error: String((error && error.message) || error) });
      return { ok: false, code: 'MP_WX_INTERNAL', error: `公众号操作失败：${String((error && error.message) || error)}` };
    }
  }

  function dispose() {
    if (disposed) return { ok: true };
    disposed = true;
    for (const record of accounts.values()) {
      try { record.service.resetToken?.(); } catch { /* 已释放 */ }
      try { record.service.clearCovers?.(); } catch { /* 已释放 */ }
    }
    accounts.clear();
    return { ok: true };
  }

  return {
    handle,
    dispose,
    inspect: () => ({
      disposed,
      base: base.base,
      mock: base.mock,
      owners: [...accounts.keys()],
      busy: [...accounts.values()].some((record) => record.service.inspect().busy),
    }),
  };
}

function defaultStateDir() {
  const local = process.env.LOCALAPPDATA;
  if (local) return join(local, 'dsh-markdown-editor-typora', 'wechat');
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg) return join(xdg, 'dsh-markdown-editor-typora', 'wechat');
  return join(homedir(), '.local', 'state', 'dsh-markdown-editor-typora', 'wechat');
}

export default { createPluginWechatHost };
