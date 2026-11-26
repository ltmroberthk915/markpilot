'use strict';
/**
 * 微信公众号凭据的**宿主侧**保管（appid 明文、secret 用系统密钥库加密）。
 *
 * 口径：
 *  · 落盘文件 `wechat-credentials.json`（调用方给目录，主进程传 userData）：
 *      { version:1, appId:"wx…", secret: { mode:"safe-storage", data:"<base64>" },
 *        updatedAt:"ISO" }
 *  · **绝不明文存 secret**：`safeStorage.isEncryptionAvailable()` 为假时**拒绝保存**并把原因
 *    如实回报（宁可存不住，也不把 secret 摊在磁盘上）。
 *  · 返回值里**永远不带 secret**（status 只给 appId / 是否已配置 / 存储方式），
 *    主进程日志也不打印 secret（见 main.js 的 wxLog 只记 appId 与长度以外的元信息）。
 *  · 清除 = 删除文件 + 清内存；失败如实回报（不静默）。
 *  · 文件损坏/无法解密 ⇒ 视为"未配置"，并把原因带出去（用户能据此重新填）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE_NAME = 'wechat-credentials.json';
const APP_ID_RE = /^wx[0-9a-zA-Z]{8,40}$/;

function normalizeAppId(value) {
  const s = String(value == null ? '' : value).trim();
  return APP_ID_RE.test(s) ? s : null;
}
function normalizeSecret(value) {
  // 微信 AppSecret 是 32 位；容许宽松一点（大小写字母+数字），但拒绝空白/路径/控制字符。
  const s = String(value == null ? '' : value).trim();
  return /^[0-9a-zA-Z]{16,64}$/.test(s) ? s : null;
}

function createWechatCredentials({ dir, safeStorage, fileName = FILE_NAME } = {}) {
  if (!dir) throw new Error('缺少凭据目录');
  const file = path.join(dir, fileName);
  let memory = null;          // { appId, secret } —— 进程内缓存，避免每次上传都解密
  let lastError = null;

  const keystore = () => {
    try { return !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()); }
    catch { return false; }
  };

  function readRaw() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      lastError = { code: 'MP_WX_STORE_READ', error: `读取微信凭据文件失败：${String(error && error.message || error)}` };
      return null;
    }
    try { return JSON.parse(text); } catch {
      lastError = { code: 'MP_WX_STORE_CORRUPT', error: '微信凭据文件已损坏，请重新填写并保存' };
      return null;
    }
  }

  function writeRaw(payload) {
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不影响结果 */ }
    }
  }

  /** 读回可用凭据（内部用）。失败返回 { ok:false, code, error }，**不抛**。 */
  function read() {
    if (memory && memory.appId && memory.secret) return { ok: true, appId: memory.appId, secret: memory.secret };
    lastError = null;
    const raw = readRaw();
    if (!raw) {
      return lastError || { ok: false, code: 'MP_WX_NOT_CONFIGURED', error: '尚未配置微信公众号 appid / secret' };
    }
    const appId = normalizeAppId(raw.appId);
    if (!appId) {
      lastError = { code: 'MP_WX_STORE_CORRUPT', error: '微信凭据文件里的 appid 不合法，请重新填写并保存' };
      return lastError;
    }
    const box = raw.secret;
    if (!box || box.mode !== 'safe-storage' || typeof box.data !== 'string' || !box.data) {
      lastError = { code: 'MP_WX_STORE_CORRUPT', error: '微信凭据文件里没有可用的 secret（它不该以明文存在），请重新填写并保存' };
      return lastError;
    }
    if (!keystore()) {
      return { ok: false, code: 'MP_WX_NO_KEYSTORE', error: '系统密钥库不可用，无法解密已保存的微信 secret' };
    }
    let secret = '';
    try {
      secret = safeStorage.decryptString(Buffer.from(box.data, 'base64'));
    } catch (error) {
      return { ok: false, code: 'MP_WX_DECRYPT', error: '无法解密已保存的微信 secret（可能换了系统账户或密钥库被重置），请重新填写' };
    }
    if (!normalizeSecret(secret)) {
      return { ok: false, code: 'MP_WX_STORE_CORRUPT', error: '解密出来的 secret 不合法，请重新填写并保存' };
    }
    memory = { appId, secret };
    return { ok: true, appId, secret };
  }

  /** 对外只读状态：**不含 secret**。 */
  function status() {
    const ok = read();
    return {
      configured: ok.ok === true,
      appId: ok.ok ? ok.appId : null,
      secretStored: ok.ok === true || ok.code === 'MP_WX_NO_KEYSTORE' || ok.code === 'MP_WX_DECRYPT',
      secretMode: ok.ok ? 'safe-storage' : (ok.code === 'MP_WX_NOT_CONFIGURED' ? 'none' : 'unreadable'),
      keystore: keystore(),
      file,
      problem: ok.ok ? null : { code: ok.code, error: ok.error },
    };
  }

  function save({ appId, secret } = {}) {
    const id = normalizeAppId(appId);
    if (!id) return { ok: false, code: 'MP_WX_BAD_APPID', error: 'appid 看起来不对：应以 wx 开头，后接字母数字（公众号后台「开发 → 基本配置」里复制）' };
    const key = normalizeSecret(secret);
    if (!key) return { ok: false, code: 'MP_WX_BAD_SECRET', error: 'AppSecret 看起来不对：应是 32 位字母数字（公众号后台可查看/重置）' };
    if (!keystore()) {
      return { ok: false, code: 'MP_WX_NO_KEYSTORE', error: '系统密钥库不可用，拒绝以明文保存 AppSecret。请先在系统里启用凭据保护后再保存。' };
    }
    let data;
    try { data = safeStorage.encryptString(key).toString('base64'); }
    catch (error) { return { ok: false, code: 'MP_WX_ENCRYPT', error: `加密 AppSecret 失败：${String(error && error.message || error)}` }; }
    const payload = { version: 1, appId: id, secret: { mode: 'safe-storage', data }, updatedAt: new Date().toISOString() };
    try { writeRaw(payload); }
    catch (error) { return { ok: false, code: 'MP_WX_STORE_WRITE', error: `写入微信凭据失败：${String(error && error.message || error)}` }; }
    memory = { appId: id, secret: key };
    lastError = null;
    return { ok: true, appId: id, secretStored: true, secretMode: 'safe-storage' };
  }

  /** 取消配置：删文件 + 清内存（失败如实回报）。 */
  function clear() {
    memory = null;
    lastError = null;
    try {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    } catch (error) {
      return { ok: false, code: 'MP_WX_STORE_CLEAR', error: `删除微信凭据失败：${String(error && error.message || error)}` };
    }
    return { ok: true, removed: true };
  }

  return { file, status, save, clear, read, normalizeAppId, normalizeSecret, keystore };
}

module.exports = { createWechatCredentials, FILE_NAME, APP_ID_RE, normalizeAppId, normalizeSecret };
