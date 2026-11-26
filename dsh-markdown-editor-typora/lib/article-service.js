// article-service.js — 工作台 article/* 服务端（中心独占）。
//
// 契约见 .mp-verify/edition-current/plugin-server-contract.md。这一层只做三件事：
//   ① 身份与绑定：把一次工作台 iframe 实例（peer + sessionId + path + docToken + tabId）
//      换成一个不透明 capability；后续每个请求都要它，**body 自报的 owner/path 一律不采信**；
//   ② 选区 AI：模型组从**服务端自己的可信投影**解析（会话 agent.model → 部署默认），
//      只把选中文字交给 lib/selection-rewrite-model.js；取消经 AbortSignal 真的停流；
//   ③ 公众号：把服务端构造的 scope 交给 lib/wechat-draft.js，客户端给不了 owner/dir/path。
//
// 这一层**不读文档内容、不写盘、不碰凭据**。文档权威只有两个来源：
//   · 编辑器自己 open 过的路径表（host 的 openedReadingPaths）；
//   · 会话与文档服务（ctx.sessions / agents）。
// 全部失败都以对象返回，路由层永远不会因为这里抛错而 500。

import { randomBytes, randomUUID } from 'node:crypto';

/** capability 绝对有效期：工作台 tab 正常活不过一天，过期必须重新 bind。 */
export const CAPABILITY_TTL_MS = 12 * 60 * 60 * 1000;
/** 同时在册的 capability 上限（防泄漏的表本身成为内存问题）。 */
export const CAPABILITY_LIMIT = 256;

export const ARTICLE_CODES = Object.freeze({
  scope: 'MP_ARTICLE_SCOPE',
  noSession: 'MP_ARTICLE_NO_SESSION',
  noDoc: 'MP_ARTICLE_NO_DOC',
  badBind: 'MP_ARTICLE_BAD_BIND',
  unbound: 'MP_ARTICLE_UNBOUND',
  stale: 'MP_ARTICLE_STALE',
  staleRequest: 'MP_ARTICLE_STALE_REQUEST',
  noModel: 'MP_ARTICLE_NO_MODEL',
  noLlm: 'MP_ARTICLE_NO_LLM',
  cancelled: 'MP_ARTICLE_CANCELLED',
  badInput: 'MP_ARTICLE_BAD_INPUT',
  unknown: 'MP_ARTICLE_UNKNOWN_METHOD',
  internal: 'MP_ARTICLE_INTERNAL',
  unimplemented: 'MP_ARTICLE_NOT_IMPLEMENTED',
});

function fail(code, error, extra) {
  return { ok: false, code, error: String(error == null ? '' : error), ...(extra || {}) };
}

/**
 * 旧宿主（只有 requestRejection、没有 admit）的同伴 id：由**认证头**派生。
 * 同一浏览器会话稳定、不同客户端互不相同；不含任何凭据明文（只取哈希）。
 * @param {object} headers
 */
function peerKeyFromHeaders(headers) {
  const pick = ['cookie', 'authorization', 'x-dsh-peer', 'origin', 'host'];
  const parts = [];
  for (const name of pick) {
    const value = headers?.[name];
    if (typeof value === 'string' && value) parts.push(`${name}:${value}`);
    else if (Array.isArray(value) && value.length) parts.push(`${name}:${value.join('|')}`);
  }
  if (!parts.length) return 'peer:anonymous';
  let hash = 0x811c9dc5;
  const text = parts.join('\n');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return `peer:${hash.toString(16).padStart(8, '0')}`;
}

function text(value, max = 4096) {
  const raw = typeof value === 'string' ? value : '';
  return raw.length > max ? raw.slice(0, max) : raw;
}

/**
 * @param {object} options
 * @param {(name:string)=>any} options.getService             ctx.get
 * @param {(path:string)=>Promise<{ok:boolean,canonicalPath?:string,sessionCwd?:string|null}>} options.resolveDocument
 *        文档权威：只认本 host 实例经编辑器 open() 打开过、且当前仍在盘上的路径。
 * @param {(sessionId:string)=>{provider:string,model:string,reasoningEffort?:string,source:string}|null} [options.modelSelectionFor]
 *        可选覆盖：默认由本模块自己从会话 Adapter / modelSelection 投影解析（**不碰部署默认**）。
 * @param {()=>any} [options.wechat]   返回 lib/wechat-draft.js 的 host（惰性，避免启动期就构造）
 * @param {()=>Promise<any>} [options.loadRewrite] 惰性载入 selection-rewrite-model.js
 * @param {object} [options.log]
 * @param {()=>number} [options.now]
 */
export function createArticleService(options = {}) {
  const getService = typeof options.getService === 'function' ? options.getService : () => undefined;
  const resolveDocument = typeof options.resolveDocument === 'function' ? options.resolveDocument : null;
  const wechatFactory = typeof options.wechat === 'function' ? options.wechat : () => null;
  const loadRewrite = typeof options.loadRewrite === 'function' ? options.loadRewrite : null;
  /* 可选覆盖：只在显式注入时生效（测试/未来 adapter 变体用）；默认走内部可信解析。 */
  const modelSelectionOverride = typeof options.modelSelectionFor === 'function' ? options.modelSelectionFor : null;
  const log = options.log ?? console;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  /** capability → 绑定记录（含在途请求的 AbortController）。 */
  const bindings = new Map();

  function say(event, detail) {
    try { log.info?.('%s: article %s', 'dsh-markdown-editor-typora', event, detail ? JSON.stringify(detail) : ''); } catch { /* 日志失败不反噬 */ }
  }

  function sweep() {
    const at = now();
    for (const [token, entry] of bindings) {
      if (entry.expiresAt > at) continue;
      abortEntry(entry, 'expired');
      bindings.delete(token);
    }
  }

  function abortEntry(entry, reason) {
    for (const flight of entry.inflight.values()) {
      try { flight.controller.abort(new Error(reason)); } catch { /* 已停 */ }
    }
    entry.inflight.clear();
  }

  function trim() {
    while (bindings.size > CAPABILITY_LIMIT) {
      const oldest = bindings.keys().next().value;
      const entry = bindings.get(oldest);
      if (entry) abortEntry(entry, 'evicted');
      bindings.delete(oldest);
    }
  }

  /**
   * 解析请求的 peer。优先用 `connection.admit()`（DSH 现行宿主：给出 PeerId + Principal）；
   * 旧宿主只有 `requestRejection` 时退化为"按认证头派生的稳定同伴 id"。
   * `principal` 必须存在且 `kind === 'owner'` —— 缺字段一律 fail-closed（缺项不是"放行"的理由）。
   * body 自报的身份永远不参与这里。
   * @param {{headers:object}} req
   * @returns {Promise<{ok:true,peerId:string,principal:object}|{ok:false,code:string,error:string}>}
   */
  async function resolvePeer(req) {
    const connection = getService('connection');
    if (connection && typeof connection.admit === 'function') {
      let admitted;
      try { admitted = connection.admit({ headers: req?.headers ?? {} }); }
      catch (error) { return fail(ARTICLE_CODES.scope, `连接身份校验失败：${String((error && error.message) || error)}`); }
      if (!admitted || admitted.rejection !== undefined) {
        return fail(ARTICLE_CODES.scope, `当前连接没有通过身份核验（${String(admitted && admitted.rejection)}）`);
      }
      const peer = admitted.peer;
      if (!peer || peer.id === undefined || peer.id === null || peer.id === '') {
        return fail(ARTICLE_CODES.scope, '连接身份缺少 peer');
      }
      const principal = peer.principal;
      if (!principal || typeof principal !== 'object' || typeof principal.kind !== 'string') {
        /* 契约里 principal 是必填；缺了就说明这不是本机owner 的可信连接，不能拿它当授权。 */
        return fail(ARTICLE_CODES.scope, '连接身份缺少可信的 principal，拒绝工作台 article/*');
      }
      if (principal.kind !== 'owner') {
        return fail(ARTICLE_CODES.scope, '只有本机所有者（principal.kind = owner）连接可以使用工作台 article/*');
      }
      return { ok: true, peerId: String(peer.id), principal };
    }
    if (connection && typeof connection.requestRejection === 'function') {
      let rejection;
      try { rejection = connection.requestRejection.call(connection, req?.headers ? { headers: req.headers } : req); }
      catch { return fail(ARTICLE_CODES.scope, '连接身份校验失败（requestRejection 抛错）'); }
      if (rejection !== undefined) {
        return fail(ARTICLE_CODES.scope, `当前连接没有通过身份核验（${String(rejection)}）`);
      }
      /* 这条退路只在旧宿主生效：requestRejection 已经挡住非本机/未认证连接，
         剩下的就是本机已认证用户；同伴 id 由认证头派生（同浏览器稳定）。 */
      return { ok: true, peerId: peerKeyFromHeaders(req?.headers ?? {}), principal: { kind: 'owner' } };
    }
    return fail(ARTICLE_CODES.scope, '宿主没有可用的连接身份服务（connection.admit / requestRejection）；工作台 article/* 需要可信连接');
  }

  function liveSession(sessionId) {
    const sessions = getService('sessions');
    if (!sessions || typeof sessions.get !== 'function' || !sessionId) return null;
    try { return sessions.get(sessionId) || null; } catch { return null; }
  }

  /**
   * 服务端可信模型组：**只认 modelSelection 投影里明确写下的选择**。
   *
   * ★ 为什么不用 `agent.model.current()`（真实反例，已实测）：
   *   `@deepseek-ai/dsh-agent` 的 `AgentModel.current()` 是
   *   `recordedSelection() ?? agent.options` —— 最后一项是**隐式默认路由**。
   *   全新独立 profile、无供应商凭据、UI 显示"请选择模型"、`modelSelection.next === null` 时，
   *   `current()` 仍会回 `deepseek-official / deepseek-flash` ⇒ 润色请求打到默认 adapter，
   *   用户看到 `MISSING_CREDENTIAL` 而不是"请先选择模型"。**绝不能用它判空。**
   *
   * 只读这两处（本安装版本的真实公开 ABI）：
   *   ① `ctx.sessionProjections.snapshot(session, ['modelSelection'])`
   *      → `{ values: { modelSelection: { lastUsed, next } } }`，`next = pending ?? lastUsed`，
   *        无选择时 `next` 为 `null`；
   *   ② 兼容 `ctx.sessionProjections.stateOf(session, 'modelSelection')` → 原始 `{lastUsed, pending}`。
   *
   * 两处都没有明确的 provider/model ⇒ 返回 `null`（"未选择"）。
   * **绝不**退回 `agentDefaultModel`（部署默认是"新会话路由"，不是这个会话的选择），
   * 也**绝不**用 `agent.options` 一类隐式默认补齐。
   *
   * @param {string} sessionId
   * @returns {{provider:string,model:string,reasoningEffort?:string,source:string}|null}
   */
  function resolveModelSelection(sessionId) {
    if (!sessionId) return null;
    if (modelSelectionOverride) {
      try { const chosen = modelSelectionOverride(sessionId); if (chosen) return chosen; }
      catch { /* 覆盖实现坏了 ⇒ 用内部解析 */ }
    }
    const pick = (value, source) => {
      if (!value || typeof value !== 'object') return null;
      if (typeof value.provider !== 'string' || !value.provider.trim()) return null;
      if (typeof value.model !== 'string' || !value.model.trim()) return null;
      return {
        provider: value.provider,
        model: value.model,
        ...(typeof value.reasoningEffort === 'string' && value.reasoningEffort
          ? { reasoningEffort: value.reasoningEffort } : {}),
        source,
      };
    };

    const session = liveSession(sessionId);
    if (!session || !looksLikeSession(session)) return null;

    const state = readModelSelectionProjection(session);
    if (!state) return null;

    /* wire 视图：next = pending ?? lastUsed（无选择为 null）。 */
    const viaWire = pick(state.next, 'session-projection');
    if (viaWire) return viaWire;
    /* 原始状态：pending（用户刚选、尚未发请求）优先于 lastUsed（最近一次实际使用的）。 */
    const viaState = pick(state.pending, 'session-projection') || pick(state.lastUsed, 'session-projection');
    if (viaState) return viaState;

    /* 明确为空 —— 调用方在 llm.stream 之前返回"请先选择模型"。 */
    return null;
  }

  /** 会话对象形态校验：投影读取需要有真实 Session。 */
  function looksLikeSession(session) {
    return typeof session === 'object' && session !== null
      && (typeof session.header === 'object' || typeof session.snapshotEvents === 'function'
        || typeof session.append === 'function');
  }

  /**
   * 读 session 的 `modelSelection` 投影状态（只读）。
   *
   * 用本安装版本真实存在的两个面（不猜 `registry.get`/`handles` 这类不存在的成员）：
   *   ① `snapshot(session, ['modelSelection'])` —— 正式读面，返回 `{asOfSeq, values}`；
   *   ② `stateOf(session, 'modelSelection')` —— 兼容读面，返回 `{lastUsed, pending}`（已废弃但可用）。
   * 两者合并成一个 `{lastUsed, pending, next}` 交给调用方判定；都读不到返回 null。
   *
   * 这里**只读**，绝不 `append('model/selection')`（那会把用户会话改写成我们的选择）。
   */
  function readModelSelectionProjection(session) {
    const registry = getService('sessionProjections');
    if (!registry) return null;
    let wire = null;
    let raw = null;

    if (typeof registry.snapshot === 'function') {
      try {
        const snapshot = registry.snapshot(session, ['modelSelection']);
        const value = snapshot && snapshot.values ? snapshot.values.modelSelection : undefined;
        if (value && typeof value === 'object') wire = value;
      } catch { /* 快照面不可用 ⇒ 试兼容面 */ }
    }
    if (typeof registry.stateOf === 'function' && registry.stateOf.length >= 2) {
      try {
        const value = registry.stateOf(session, 'modelSelection');
        if (value && typeof value === 'object') raw = value;
      } catch { /* 兼容面不可用 */ }
    }
    if (!wire && !raw) return null;
    return {
      /* wire 视图的 next 已经等于 pending ?? lastUsed；原始状态各留一份便于判定来源。 */
      next: wire && Object.prototype.hasOwnProperty.call(wire, 'next') ? wire.next : null,
      lastUsed: (raw && raw.lastUsed) || (wire && wire.lastUsed) || null,
      pending: (raw && raw.pending) || null,
    };
  }

  /* ── bind / unbind ─────────────────────────────────────────────────────── */

  /** capability：CSPRNG 生成的不透明串，不含时间/序号/可猜测前缀。 */
  function newCapability() {
    try { return `art-${randomUUID()}`; }
    catch { return `art-${randomBytes(32).toString('hex')}`; }
  }
  function newBindId() {
    try { return `artb-${randomUUID()}`; }
    catch { return `artb-${randomBytes(16).toString('hex')}`; }
  }

  /**
   * 会话/工作区归属核对：文档必须落在该会话的工作区内。
   * 依据是**可信来源**：会话 header.cwd（DSH 的会话工作区）与文档的规范路径。
   * 两者都拿不到时不额外放宽 —— 只要会话声明了 cwd，就必须包含该文档。
   * @returns {{ok:true}|{ok:false,error:string}}
   */
  function sessionOwnsDocument(session, canonicalPath) {
    let cwd = '';
    try {
      const header = session && typeof session === 'object' ? session.header : null;
      cwd = header && typeof header.cwd === 'string' ? header.cwd : '';
    } catch { cwd = ''; }
    if (!cwd) return { ok: true };   // 会话没声明工作区：readingTarget 已是唯一权威
    if (!isAbsolutePath(cwd)) return { ok: false, error: '会话工作区路径不是绝对路径，拒绝绑定' };
    const base = normalizeSlashes(cwd).replace(/\/+$/, '');
    const target = normalizeSlashes(canonicalPath);
    const caseFold = base.toLowerCase() === base || target.toLowerCase() === target;
    if (caseFold) {
      const b = base.toLowerCase(), t = target.toLowerCase();
      if (t === b || t.startsWith(b + '/')) return { ok: true };
      return { ok: false, error: '文档不在当前会话的工作区内，拒绝绑定' };
    }
    if (target === base || target.startsWith(base + '/')) return { ok: true };
    return { ok: false, error: '文档不在当前会话的工作区内，拒绝绑定' };
  }

  function normalizeSlashes(value) {
    return String(value == null ? '' : value).replace(/\\/g, '/');
  }
  function isAbsolutePath(value) {
    const p = normalizeSlashes(value);
    return /^[A-Za-z]:(\/|$)/.test(p) || p.startsWith('//') || p.startsWith('/');
  }

  async function bind(payload, peer) {
    const sessionId = text(payload?.sessionId, 256);
    const path = text(payload?.path, 32768);
    const docToken = text(payload?.docToken, 512);
    const tabId = text(payload?.tabId, 256);
    if (!docToken) return fail(ARTICLE_CODES.badBind, '缺少 docToken：工作台必须先给文档实例签发代次');
    const session = liveSession(sessionId);
    if (!session) return fail(ARTICLE_CODES.noSession, '当前会话不存在或已关闭；请重新打开文档');
    if (!path) return fail(ARTICLE_CODES.noDoc, '缺少文档路径');
    if (!resolveDocument) return fail(ARTICLE_CODES.noDoc, '服务端没有文档权威可核验');
    let resolved;
    try { resolved = await resolveDocument(path); }
    catch (error) { return fail(ARTICLE_CODES.noDoc, `文档核验失败：${String((error && error.message) || error)}`); }
    if (!resolved || resolved.ok !== true || !resolved.canonicalPath) {
      return fail(ARTICLE_CODES.noDoc, '这份文档不是本工作台用编辑器打开过的文件（或已经关闭），拒绝绑定');
    }
    /* 归属核对：可信 readingTarget 给出的规范路径必须落在该会话的工作区内。 */
    const owns = sessionOwnsDocument(session, resolved.canonicalPath);
    if (!owns.ok) return fail(ARTICLE_CODES.noDoc, owns.error);
    sweep();
    /* 同一 tab + **同一个连接同伴** 重复绑定 ⇒ 旧 capability 作废（防两个 iframe 抢同一份文档）。
       别的同伴（另一个浏览器/另一台机器）的同名 tabId 与我们无关，不能因为名字相同就驱逐。 */
    if (tabId) {
      for (const [token, entry] of [...bindings]) {
        if (entry.tabId !== tabId || entry.peerId !== peer.peerId) continue;
        abortEntry(entry, 'rebound');
        bindings.delete(token);
      }
    }
    const capability = newCapability();
    const bindId = newBindId();
    const entry = {
      capability, bindId, peerId: peer.peerId, sessionId, tabId: tabId || null,
      canonicalPath: resolved.canonicalPath, docToken,
      workspace: sessionCwdOf(session),
      createdAt: now(), expiresAt: now() + CAPABILITY_TTL_MS,
      inflight: new Map(),
      lastRequestId: null,
    };
    bindings.set(capability, entry);
    trim();
    say('bind', { bindId, sessionId, tabId: entry.tabId });
    return {
      ok: true, capability, bindId, expiresAt: entry.expiresAt,
      path: entry.canonicalPath, sessionId,
    };
  }

  function sessionCwdOf(session) {
    try {
      const cwd = session && session.header ? session.header.cwd : '';
      return typeof cwd === 'string' && cwd ? cwd : null;
    } catch { return null; }
  }

  function unbind(payload, peer) {
    const entry = lookup(payload, peer);
    if (!entry.ok) return entry;
    abortEntry(entry.entry, 'unbound');
    bindings.delete(entry.entry.capability);
    say('unbind', { bindId: entry.entry.bindId });
    return { ok: true, released: true };
  }

  /** capability + peer + docToken 三重核对；任何一项不成立就给明确码，且**不执行**。 */
  function lookup(payload, peer) {
    sweep();
    const capability = text(payload?.capability, 512);
    if (!capability) return fail(ARTICLE_CODES.unbound, '缺少 capability：请先 article/bind');
    const entry = bindings.get(capability);
    if (!entry) return fail(ARTICLE_CODES.unbound, 'capability 已失效（过期或已解绑）；请重新绑定后重试');
    if (entry.peerId !== peer.peerId) {
      return fail(ARTICLE_CODES.unbound, '这个 capability 属于另一个工作台连接，已拒绝');
    }
    const docToken = text(payload?.docToken, 512);
    if (docToken !== entry.docToken) {
      /* 同目录换文件也是新文档实例 ⇒ 换 token ⇒ 这里必然不相等。*/
      return fail(ARTICLE_CODES.stale, '编辑器文档实例已经更换（换稿/重开），请重新绑定后再操作');
    }
    return { ok: true, entry };
  }

  /** 文档是否仍是绑定时那一个（wx 的 isCurrent 与 stale 巡检共用）。 */
  function stillCurrent(entry) {
    try {
      if (entry.expiresAt <= now()) return false;
      if (!bindings.has(entry.capability)) return false;
      if (!liveSession(entry.sessionId)) return false;
      return true;
    } catch { return false; }
  }

  async function documentStillOpen(entry) {
    if (!stillCurrent(entry)) return false;
    if (!resolveDocument) return false;
    try {
      const resolved = await resolveDocument(entry.canonicalPath);
      if (!resolved || resolved.ok !== true) return false;
      if (normalizeSlashes(resolved.canonicalPath || '').toLowerCase()
        !== normalizeSlashes(entry.canonicalPath).toLowerCase()) return false;
      /* 归属也复核：会话换了工作区/文档被搬到区外 ⇒ 视为已切换。 */
      const session = liveSession(entry.sessionId);
      if (!session) return false;
      return sessionOwnsDocument(session, resolved.canonicalPath).ok;
    } catch { return false; }
  }

  /* ── 选区 AI ───────────────────────────────────────────────────────────── */

  function aiStatus(sessionId) {
    const llm = getService('llm');
    const selection = resolveModelSelection(sessionId);
    return {
      ok: true,
      available: !!(llm && typeof llm.stream === 'function') && !!selection,
      hasLlm: !!(llm && typeof llm.stream === 'function'),
      provider: selection ? selection.provider : null,
      model: selection ? selection.model : null,
      reasoningEffort: selection && selection.reasoningEffort ? selection.reasoningEffort : null,
      source: selection ? selection.source : null,
    };
  }

  async function aiRewrite(payload, peer, entry) {
    const requestId = text(payload?.requestId, 128);
    if (!requestId) return fail(ARTICLE_CODES.badInput, '缺少 requestId');
    const source = payload?.text;
    if (typeof source !== 'string' || !source.trim()) {
      return fail(ARTICLE_CODES.badInput, '请先选中要润色的文字');
    }
    if (!loadRewrite) return fail(ARTICLE_CODES.unimplemented, '服务端未装配选区润色模块');
    const llm = getService('llm');
    const selection = resolveModelSelection(entry.sessionId);
    /* 投影里没有明确选择 ⇒ 在**调用 llm.stream 之前**结束，并让用户去选模型。
       绝不用 agent.options / 部署默认补齐（真实反例：会打到默认 adapter 报 MISSING_CREDENTIAL）。 */
    if (!selection) {
      return fail(ARTICLE_CODES.noModel, '请先在当前对话选择模型（这个对话还没有选定的模型路由），再润色选区', { requestId });
    }
    if (!llm || typeof llm.stream !== 'function') {
      return fail(ARTICLE_CODES.noLlm, '宿主没有可用的模型服务（ctx.llm 不可用），无法润色选区', { requestId });
    }
    let mod;
    try { mod = await loadRewrite(); }
    catch (error) { return fail(ARTICLE_CODES.internal, `润色模块载入失败：${String((error && error.message) || error)}`); }
    if (!mod || typeof mod.rewriteSelectedText !== 'function') {
      return fail(ARTICLE_CODES.unimplemented, '润色模块缺少 rewriteSelectedText');
    }

    /* 同一 capability 只保留最新一次：旧的在途请求**真的停流**，不是丢回包。 */
    for (const [id, flight] of [...entry.inflight]) {
      if (id === requestId) continue;
      try { flight.controller.abort(new Error('superseded')); } catch { /* 已停 */ }
      entry.inflight.delete(id);
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const flight = { controller, at: now() };
    entry.inflight.set(requestId, flight);
    entry.lastRequestId = requestId;
    let result;
    try {
      result = await mod.rewriteSelectedText({
        llm,
        selection: {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        },
        text: source,
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      entry.inflight.delete(requestId);
      return fail(ARTICLE_CODES.internal, `润色失败：${String((error && error.message) || error)}`, { requestId });
    }
    entry.inflight.delete(requestId);
    if (!result || result.ok !== true) {
      const code = String((result && result.code) || ARTICLE_CODES.internal);
      return fail(code, (result && result.error) || '润色失败', { requestId });
    }
    return {
      ok: true, requestId, text: String(result.text),
      provider: selection.provider, model: selection.model,
      source: selection.source,
    };
  }

  function aiRewriteCancel(payload, entry) {
    const requestId = text(payload?.requestId, 128);
    const flight = requestId ? entry.inflight.get(requestId) : null;
    if (!flight) return { ok: true, canceled: false };
    try { flight.controller.abort(new Error('user-cancel')); } catch { /* 已停 */ }
    entry.inflight.delete(requestId);
    return { ok: true, canceled: true };
  }

  /* ── 公众号草稿箱 ───────────────────────────────────────────────────────── */

  function wxScope(entry) {
    return {
      ownerId: entry.peerId,
      tabId: entry.tabId || undefined,
      documentId: entry.bindId,
      /* path 仅记录用途：wechat-draft.js 不读盘，只收本次随调用带入的 data: 字节。 */
      path: entry.canonicalPath,
      isCurrent: () => { try { return stillCurrent(entry); } catch { return false; } },
      alive: () => { try { return stillCurrent(entry); } catch { return false; } },
    };
  }

  async function wxAction(action, payload, entry) {
    let host;
    try { host = await wechatFactory(); }
    catch (error) { return fail(ARTICLE_CODES.unimplemented, `公众号模块载入失败：${String((error && error.message) || error)}`); }
    if (!host || typeof host.handle !== 'function') {
      return fail(ARTICLE_CODES.unimplemented, '服务端未装配公众号模块（lib/wechat-draft.js）');
    }
    /* 建稿前先按文档权威复核一次：同目录换稿也必须停。 */
    if (action === 'createDraft') {
      const open = await documentStillOpen(entry);
      if (!open) {
        return {
          ok: false, stage: 'owner', code: 'MP_WX_DOC_CHANGED',
          error: '发送前文档已被切换或关闭，已停止创建草稿（重新打开文档后再发一次）',
          draftCreated: false, mediaId: null,
        };
      }
    }
    return host.handle(action, payload || {}, wxScope(entry));
  }

  /* ── 总入口 ────────────────────────────────────────────────────────────── */

  const WX_ACTIONS = new Map([
    ['wxStatus', 'status'],
    ['wxConfigure', 'configure'],
    ['wxClear', 'clear'],
    ['wxVerify', 'verify'],
    ['wxPickCover', 'pickCover'],
    ['wxCreateDraft', 'createDraft'],
    ['wxAcknowledge', 'acknowledge'],
  ]);

  /**
   * 处理一个 article/* 请求。
   * @param {string} method 与 hostApi.invoke 同名（camelCase）
   * @param {object} payload
   * @param {{headers:object}} req
   */
  async function handle(method, payload, req) {
    try {
      const peer = await resolvePeer(req);
      if (!peer.ok) return peer;

      if (method === 'bind') return await bind(payload, peer);
      if (method === 'unbind') return unbind(payload, peer);

      const found = lookup(payload, peer);
      if (!found.ok) return found;
      const entry = found.entry;

      if (method === 'aiStatus') return aiStatus(entry.sessionId);
      if (method === 'aiDiag') {
        const status = aiStatus(entry.sessionId);
        return {
          ok: true, readOnly: true,
          sessionId: entry.sessionId,
          bindId: entry.bindId,
          tabId: entry.tabId,
          hasLlm: status.hasLlm,
          provider: status.provider, model: status.model,
          reasoningEffort: status.reasoningEffort, source: status.source,
          inflight: entry.inflight.size,
          expiresAt: entry.expiresAt,
        };
      }
      if (method === 'aiRewrite') return await aiRewrite(payload, peer, entry);
      if (method === 'aiRewriteCancel') return aiRewriteCancel(payload, entry);
      if (WX_ACTIONS.has(method)) return await wxAction(WX_ACTIONS.get(method), payload, entry);
      return fail(ARTICLE_CODES.unknown, `未知的 article 方法：${String(method)}`);
    } catch (error) {
      try { log.warn?.('%s: article %s failed: %s', 'dsh-markdown-editor-typora', String(method), String((error && error.message) || error)); } catch { /* 忽略 */ }
      return fail(ARTICLE_CODES.internal, `工作台请求失败：${String((error && error.message) || error)}`);
    }
  }

  /** 关 host / 换代际：全部在途请求停流，绑定表清空。 */
  function close() {
    for (const entry of bindings.values()) abortEntry(entry, 'closed');
    bindings.clear();
  }

  return {
    handle, close,
    /* 只读诊断（测试与验收用；不含 capability 本身）。 */
    inspect: () => ({
      bindings: [...bindings.values()].map((entry) => ({
        bindId: entry.bindId, peers: entry.peerId, sessionId: entry.sessionId,
        tabId: entry.tabId, path: entry.canonicalPath, inflight: entry.inflight.size,
        expiresAt: entry.expiresAt,
      })),
      hasWechat: !!wechatFactory,
      hasRewrite: !!loadRewrite,
    }),
  };
}

export default { createArticleService, ARTICLE_CODES, CAPABILITY_TTL_MS, CAPABILITY_LIMIT };
