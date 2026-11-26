// shell/ai-rewrite.js — 选区 AI 润色的**宿主服务**（主进程侧）
//
// 职责边界：
//   · 渲染进程**零网络**：选区文本经 IPC 进主进程，由这里出网；
//   · 只把**选区+提示词**发出去；请求体里没有任何整篇文档字段；
//   · 凭据**不读 settings.json 的明文**：内置服务只认环境变量/密钥库；
//     自定义端点必须由**可信宿主显式注入**凭据（`customCredential`），渲染侧无法自己"配一个 baseURL 带上全机的 key"；
//   · 端点受**协议与主机策略**约束：远程必须 HTTPS，HTTP 只允许回环；
//   · 每个请求有 **requestId → AbortController** 表：取消按 id 精确中止，窗口销毁时统一收尾；
//   · 错误一律 {ok:false,code,message}，**message 里永不出现密钥**（也不出现密钥所在环境变量的值）。
//
// 这个模块不 require electron 于顶层（用 defaultFetch 惰性取），因此可在纯 Node 里用假 fetch 单测。

'use strict';

const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_SELECTION_CHARS = 24_000;

/** 内置服务：凭据只从**该服务自己的**环境变量取（不是"随便一个 env 键"）。
 *  `envKeys` 是白名单：渲染侧没有任何办法指定读哪个环境变量。 */
const PROVIDERS = Object.freeze({
  deepseek: {
    kind: 'openai',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    envKeys: ['DEEPSEEK_API_KEY'],
    allowCustomBase: false,
  },
  openai: {
    kind: 'openai',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    envKeys: ['OPENAI_API_KEY'],
    allowCustomBase: false,
  },
  anthropic: {
    kind: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    model: 'claude-3-5-haiku-latest',
    envKeys: ['ANTHROPIC_API_KEY'],
    allowCustomBase: false,
  },
  /* 自建/本地网关：**没有内置凭据**。baseURL 与凭据都必须由可信宿主显式注入
     （`registerAiRewrite({ customEndpoint: { baseURL, apiKey, model } })`），
     不接受渲染侧或普通 settings 里随手写的值。 */
  custom: {
    kind: 'openai',
    baseURL: '',
    model: '',
    envKeys: [],
    allowCustomBase: true,
  },
});

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i;

const SYSTEM_PROMPT = [
  '你是 Markdown 文本的润色助手。用户会给你一段选中的 Markdown 原文。',
  '任务：在不改变原意与事实的前提下润色这段文字，使其更准确、简洁、通顺。',
  '硬性要求：',
  '1. 只返回润色后的 Markdown 文本本身；不要解释、不要前言、不要代码围栏包裹。',
  '2. 保持原有的 Markdown 结构（标题层级、列表符号、强调标记、链接、行内代码、公式 $…$）。',
  '3. 不要增删列表项，不要改变引用块的层级。',
  '4. 保留原文的语言（中文就还是中文，英文就还是英文）。',
  '5. 如果原文已经足够好，就把原文原样返回。',
].join('\n');

const MESSAGES = {
  notConfigured: '还没有配置 AI 服务：内置服务需要在启动环境里提供对应服务的密钥',
  noKey: 'AI 服务缺少密钥：内置服务只从它自己的环境变量读取（例如 DEEPSEEK_API_KEY）',
  badProvider: 'AI 服务的 provider 不认识：支持 deepseek / openai / anthropic / custom',
  customNotAllowed: '自定义端点必须由宿主显式配置：请在设置里由应用提供 baseURL 与凭据',
  badBaseURL: 'AI 服务的端点不可用：远程端点必须是 https，http 只允许本机回环地址',
  noModel: '还没有可用的 AI 模型名',
  invalidKey: '密钥无效或已过期（HTTP 401/403）',
  rateLimit: '请求被限流（HTTP 429），稍后再试',
  tooLong: '选区过长，请分段润色',
  empty: '选区是空的，没有可润色的内容',
  cancelled: '已取消',
  timeout: 'AI 服务超时',
};

/** 稳定错误：{ ok:false, code, message }。message 给人看，code 给分支用。 */
function failure(code, message, extra) {
  return { ok: false, code: String(code || 'failed'), message: String(message || ''), ...(extra || {}) };
}

/** 日志/回显里的密钥遮蔽：只保留前 3 位与长度。**任何外泄路径都必须先过它。** */
function redact(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= 6) return '***';
  return `${text.slice(0, 3)}***(${text.length})`;
}

/** 把文本里出现的密钥抹掉。错误信息来自远端/网络栈，可能夹带请求头或 URL 片段，
 *  所以**凡是要回给渲染侧或写进日志的字符串，都必须先过这道**。 */
function scrub(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    const value = String(secret ?? '');
    if (value.length >= 4 && out.includes(value)) out = out.split(value).join('***');
  }
  return out;
}

/* ───────────────────────── 端点与凭据策略 ───────────────────────── */

/**
 * 端点校验：**这是防止"渲染侧改写 baseURL 把全机密钥发到任意主机"的关键闸门**。
 *   · https ⇒ 放行（任意主机；用户/宿主显式配置的第三方端点是合法用法）；
 *   · http  ⇒ **只允许回环**（127.0.0.1 / localhost / [::1]），这是本机假 provider 与本地推理端口；
 *   · 其它协议（file:/ws:/data:…）一律拒绝。
 * 额外拒绝带 userinfo 的 URL（`https://user:pass@host` 会把凭据写进日志与 Referer）。
 */
function validateBaseURL(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return failure('not-configured', MESSAGES.badBaseURL);
  let url;
  try { url = new URL(text); } catch { return failure('not-configured', MESSAGES.badBaseURL); }
  if (url.username || url.password) return failure('not-configured', MESSAGES.badBaseURL);
  if (url.protocol === 'https:') return { ok: true, baseURL: text.replace(/\/+$/, '') };
  if (url.protocol === 'http:') {
    const host = String(url.hostname || '');
    if (!LOOPBACK_HOST.test(host)) return failure('not-configured', MESSAGES.badBaseURL);
    return { ok: true, baseURL: text.replace(/\/+$/, '') };
  }
  return failure('not-configured', MESSAGES.badBaseURL);
}

/**
 * 解析一次调用所需的全部事实。
 *
 * 安全口径（本函数的**全部意义**）：
 *   · `settings` 里**只有非秘密的展示项**（provider 名、model、超时）；
 *     **不读** `aiRewriteApiKey`、**不读** `aiRewriteApiKeyEnv`、**不读** `aiRewriteBaseURL`；
 *     普通 settings.json 是渲染侧可写白名单的候选，往里放秘密等于把密钥交给页面；
 *   · 内置 provider：baseURL 与 model 用**内置常量**（不允许被 settings 覆盖），
 *     密钥只从该 provider **自己的** envKeys 里取；
 *   · custom provider：baseURL 与密钥**只能来自**调用方显式传入的 `customEndpoint`（可信宿主注入），
 *     且 baseURL 仍要过 validateBaseURL。
 *
 * 返回 { ok:true, config } 或 { ok:false, code, message } —— 不抛异常。
 */
function resolveConfig({ settings = {}, env = {}, customEndpoint = null } = {}) {
  /* customEndpoint 既可以是对象，也可以是**函数**（宿主在每次调用时现读可信配置，
     这样用户改完配置文件不必重启应用；也让"结构非法"能在调用时如实回报）。 */
  if (typeof customEndpoint === 'function') {
    let produced;
    try { produced = customEndpoint(); }
    catch (error) { return failure('not-configured', String(error?.message || error)); }
    if (produced && produced.ok === false) {
      return failure(produced.error?.code || 'not-configured', produced.error?.message || produced.message || MESSAGES.customNotAllowed);
    }
    customEndpoint = produced && produced.ok === true ? produced.endpoint : (produced || null);
  }
  const requested = String(settings?.aiRewriteProvider || '').trim().toLowerCase();
  const name = (requested || 'deepseek').split(':')[0];
  const spec = PROVIDERS[name];
  if (!spec) return failure('not-configured', MESSAGES.badProvider);

  /* 自定义端点：可信宿主注入优先（这是唯一合法来源）。 */
  if (spec.allowCustomBase) {
    const injected = customEndpoint && typeof customEndpoint === 'object' ? customEndpoint : null;
    if (!injected) return failure('not-configured', MESSAGES.customNotAllowed);
    const base = validateBaseURL(injected.baseURL);
    if (!base.ok) return base;
    const model = String(injected.model || '').trim();
    if (!model) return failure('not-configured', MESSAGES.noModel);
    const apiKey = String(injected.apiKey || '').trim();     // 可空（本地推理常常不要密钥）
    const timeoutMs = timeoutOf(settings);
    return {
      ok: true,
      config: {
        provider: 'custom', kind: spec.kind, baseURL: base.baseURL, model,
        apiKey, keyEnv: '', timeoutMs, source: 'host-injected', defaults: { baseURL: false, model: false },
      },
    };
  }

  /* 内置服务：端点与模型**不可被 settings 覆盖**（防止"改个 baseURL 就把 key 发出去"）。 */
  const base = validateBaseURL(spec.baseURL);
  if (!base.ok) return base;
  const keyEnv = spec.envKeys.find((k) => String(env?.[k] || '').trim());
  const apiKey = keyEnv ? String(env[keyEnv]).trim() : '';
  if (!apiKey) {
    return failure('not-configured', requested ? MESSAGES.noKey : MESSAGES.notConfigured);
  }
  /* 模型：允许用户换（同服务内换模型不改变凭据去向）。 */
  const model = String(settings?.aiRewriteModel || '').trim() || spec.model;
  if (!model) return failure('not-configured', MESSAGES.noModel);
  return {
    ok: true,
    config: {
      provider: name, kind: spec.kind, baseURL: base.baseURL, model,
      apiKey, keyEnv, timeoutMs: timeoutOf(settings),
      source: 'builtin', defaults: { baseURL: true, model: !settings?.aiRewriteModel },
    },
  };
}

function timeoutOf(settings) {
  const raw = Number(settings?.aiRewriteTimeoutMs);
  return Number.isFinite(raw) && raw >= 3000 && raw <= 300_000 ? Math.round(raw) : DEFAULT_TIMEOUT_MS;
}

/** 不会泄露密钥的配置摘要（设置页/诊断用）。 */
function describeConfig(config) {
  if (!config) return { configured: false };
  return {
    configured: true,
    provider: config.provider,
    kind: config.kind,
    baseURL: config.baseURL,
    model: config.model,
    key: redact(config.apiKey),
    keyEnv: config.keyEnv || null,
    source: config.source || null,
    timeoutMs: config.timeoutMs,
  };
}

/* ───────────────────────── 请求构造 ───────────────────────── */

/** 端点拼接：OpenAI 兼容族接 `/chat/completions`，Anthropic 接 `/v1/messages`。
 *  已经带了 `/v1` 的自建网关、以及已经写全路径的地址都要照原样能跑。 */
function endpointOf(config) {
  const base = config.baseURL;
  if (config.kind === 'anthropic') {
    return /\/(v1\/)?messages$/.test(base) ? base : `${base}/v1/messages`;
  }
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function messagesFor(payload) {
  const instruction = String(payload?.instruction || '');
  const selection = String(payload?.selection ?? '');
  const hint = instruction ? `\n\n额外要求：${instruction}` : '';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `请润色下面这段 Markdown（只发这一段）：\n\n<<<SELECTION\n${selection}\nSELECTION>>>${hint}` },
  ];
}

function requestBodyOf(config, payload) {
  const messages = messagesFor(payload);
  if (config.kind === 'anthropic') {
    return {
      model: config.model,
      max_tokens: 4096,
      system: messages[0].content,
      messages: [{ role: 'user', content: messages[1].content }],
    };
  }
  return { model: config.model, messages, temperature: 0.3, stream: false };
}

function headersOf(config) {
  if (config.kind === 'anthropic') {
    const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
    if (config.apiKey) headers['x-api-key'] = config.apiKey;
    return headers;
  }
  const headers = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  return headers;
}

/** 从各家回包里取文本。任何读不出来的形态都当失败（不猜、不返回半截）。 */
function extractText(config, json) {
  if (config.kind === 'anthropic') {
    const blocks = Array.isArray(json?.content) ? json.content : [];
    const text = blocks.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
    return text || null;
  }
  const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
  const content = choice?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content.filter(part => part && typeof part.text === 'string').map(part => part.text).join('');
    return text || null;
  }
  return null;
}

function serverMessage(json) {
  const raw = json?.error?.message ?? json?.message ?? json?.error ?? '';
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return text.slice(0, 300);
}

/* ───────────────────────── 单次调用 ───────────────────────── */

/**
 * 一次润色调用。
 * `deps.signal` 是本主进程内的真 AbortSignal（IPC 那层不能直接传，见 registerAiRewrite 的取消通道）。
 */
async function rewriteSelection(payload, options = {}) {
  const selection = String(payload?.selection ?? '');
  if (!selection.trim()) return failure('empty', MESSAGES.empty);
  if (selection.length > MAX_SELECTION_CHARS) return failure('too-long', MESSAGES.tooLong);

  const resolved = resolveConfig({
    settings: options.settings,
    env: options.env,
    customEndpoint: options.customEndpoint,
  });
  if (!resolved.ok) return resolved;
  const config = resolved.config;
  const secrets = [config.apiKey];

  const fetchImpl = options.fetchImpl || defaultFetch();
  if (typeof fetchImpl !== 'function') return failure('network', '当前环境没有可用的网络通道');

  const controller = new AbortController();
  const external = options.signal;
  const onExternalAbort = () => { try { controller.abort(); } catch { /* 已中止 */ } };
  if (external) {
    if (external.aborted) return failure('cancelled', MESSAGES.cancelled);
    try { external.addEventListener('abort', onExternalAbort, { once: true }); } catch { /* 非标准 signal */ }
  }
  let timer = setTimeout(() => { try { controller.abort(); } catch { /* 已中止 */ } }, config.timeoutMs);
  timer?.unref?.();

  try {
    const response = await fetchImpl(endpointOf(config), {
      method: 'POST',
      headers: headersOf(config),
      body: JSON.stringify(requestBodyOf(config, payload)),
      signal: controller.signal,
    });
    if (!response || typeof response !== 'object') return failure('network', '网络通道没有返回响应');
    const status = Number(response.status);
    let json = null;
    try { json = await response.json(); } catch { json = null; }
    if (status === 401 || status === 403) {
      return failure('invalid-key',
        `${MESSAGES.invalidKey}：${scrub(serverMessage(json), secrets) || `HTTP ${status}`}`, { status });
    }
    if (status === 429) return failure('rate-limit', MESSAGES.rateLimit, { status });
    if (!(status >= 200 && status < 300)) {
      return failure('http',
        `AI 服务返回 HTTP ${status}：${scrub(serverMessage(json), secrets) || '无错误详情'}`, { status });
    }
    const text = extractText(config, json);
    if (text === null) return failure('bad-response', 'AI 服务的回包读不出文本（响应结构不符）', { status });
    return { ok: true, text, provider: config.provider, model: config.model };
  } catch (error) {
    const aborted = error?.name === 'AbortError' || controller.signal.aborted;
    if (aborted) {
      if (external?.aborted) return failure('cancelled', MESSAGES.cancelled);
      return failure('timeout', `${MESSAGES.timeout}（${Math.round(config.timeoutMs / 1000)} 秒未响应）`);
    }
    return failure('network', `AI 服务连接失败：${scrub(String(error?.message || error).slice(0, 200), secrets)}`);
  } finally {
    if (timer) { clearTimeout(timer); timer = null; }
    if (external) { try { external.removeEventListener('abort', onExternalAbort); } catch { /* 忽略 */ } }
  }
}

/** 默认的 fetch：优先 Electron 的 net.fetch（主进程里可用），否则退回全局 fetch（Node 22+/测试）。 */
function defaultFetch() {
  try {
    // 延迟 require：纯 Node 单测里没有 electron，不应当抛。
    const electron = require('electron');
    if (electron && typeof electron.net?.fetch === 'function') {
      return (url, init) => electron.net.fetch(url, init);
    }
  } catch { /* 非 Electron 环境 */ }
  if (typeof globalThis.fetch === 'function') return (url, init) => globalThis.fetch(url, init);
  return null;
}

/* ───────────────────────── IPC 通道 ───────────────────────── */

/**
 * 通道契约（preload 只暴露这三条，**不接受渲染侧传 signal**）：
 *   ai:rewrite        (payload, { requestId }) → { ok:true, text } | { ok:false, code, message }
 *   ai:rewrite-cancel ({ requestId }) → { ok:true, cancelled:boolean }
 *   ai:status         () → { ok, configured, config? }
 *
 * `authorize(event)` 是宿主给的**可信窗口/主框架校验**（与 wxTrust 同口径）。
 * 这里再补三条本模块自己的纪律：
 *   · 未通过 authorize ⇒ 直接拒绝，且**不建 inflight 记录**；
 *   · 同一 requestId 重复提交 ⇒ 拒绝旧的（中止）再开新的，不并行两条；
 *   · 发送窗口销毁 ⇒ 中止该窗口名下所有在途请求（`sweepOwner`）。
 */
function registerAiRewrite({
  ipcMain,
  authorize,
  readSettings,
  customEndpoint = null,
  env = process.env,
  fetchImpl,
  log,
  channel = 'ai:rewrite',
  cancelChannel = 'ai:rewrite-cancel',
  statusChannel = 'ai:status',
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new Error('registerAiRewrite: ipcMain.handle is required');

  /** requestId → { controller, ownerId, startedAt }。**带控制器**，取消才真的能中止网络。 */
  const inflight = new Map();
  const ownerKeyOf = (event) => {
    try { return String(event?.sender?.id ?? ''); } catch { return ''; }
  };
  const requestIdOf = (options) => {
    const id = String(options?.requestId ?? '').trim();
    return id.length > 0 && id.length <= 128 ? id : '';
  };

  /** 中止某窗口名下所有在途请求（窗口销毁/重载时收尾）。 */
  function sweepOwner(ownerId) {
    let swept = 0;
    for (const [id, entry] of [...inflight]) {
      if (entry.ownerId !== ownerId) continue;
      try { entry.controller.abort(); } catch { /* 已中止 */ }
      inflight.delete(id);
      swept++;
    }
    return swept;
  }

  const disposers = [];

  ipcMain.handle(channel, async (event, payload = {}, options = {}) => {    /* ① 可信窗口 / 主框架校验：不通过就直接回绝，不读 payload、不建记录。 */
    let owner = null;
    if (typeof authorize === 'function') {
      const verdict = await authorize(event);
      if (!verdict || verdict.ok !== true) {
        const code = String(verdict?.code || 'MP_AI_UNTRUSTED');
        if (log?.warn) log.warn('[ai-rewrite] 拒绝：%s', code);
        return failure(code, String(verdict?.error || '发起者不是受信的编辑器窗口'));
      }
      owner = verdict.owner || null;
    }
    const ownerId = ownerKeyOf(event);
    const requestId = requestIdOf(options);

    /* ② 同一 requestId 重复提交：先中止旧的，再开新的（不并行）。 */
    if (requestId && inflight.has(requestId)) {
      try { inflight.get(requestId).controller.abort(); } catch { /* 已中止 */ }
      inflight.delete(requestId);
    }

    const controller = new AbortController();
    const token = requestId || `anon-${ownerId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    inflight.set(token, { controller, ownerId, startedAt: Date.now() });

    const settings = typeof readSettings === 'function' ? (readSettings() || {}) : {};
    try {
      const result = await rewriteSelection(payload, {
        settings, env, fetchImpl, customEndpoint,
        signal: controller.signal,
      });
      if (result.ok === false && result.code === 'cancelled') {
        if (log?.warn) log.warn('[ai-rewrite] 已取消 (%s)', token.slice(0, 24));
      } else if (result.ok === false && log?.warn) {
        log.warn('[ai-rewrite] %s → %s (%s)', describeConfig(resolveConfig({ settings, env, customEndpoint }).config).model || '?',
          result.code, String(result.message).slice(0, 160));
      }
      return result;
    } finally {
      /* 只有"本条记录还是我这条"才删——否则会把新请求的记录误删。 */
      if (inflight.get(token)?.controller === controller) inflight.delete(token);
    }
  });

  ipcMain.handle(cancelChannel, async (event, payload = {}) => {
    if (typeof authorize === 'function') {
      const verdict = await authorize(event);
      if (!verdict || verdict.ok !== true) {
        return failure(String(verdict?.code || 'MP_AI_UNTRUSTED'), String(verdict?.error || '发起者不是受信的编辑器窗口'));
      }
    }
    const requestId = requestIdOf(payload);
    if (!requestId) return failure('bad-request', '缺少 requestId');
    const entry = inflight.get(requestId);
    if (!entry) return { ok: true, cancelled: false, reason: 'not-found' };
    /* 只允许取消**自己窗口**发出的请求。 */
    if (entry.ownerId && ownerKeyOf(event) && entry.ownerId !== ownerKeyOf(event)) {
      return failure('MP_AI_UNTRUSTED', '不能取消其它窗口的请求');
    }
    try { entry.controller.abort(); } catch { /* 已中止 */ }
    inflight.delete(requestId);
    return { ok: true, cancelled: true };
  });

  ipcMain.handle(statusChannel, async (event) => {
    if (typeof authorize === 'function') {
      const verdict = await authorize(event);
      if (!verdict || verdict.ok !== true) {
        return failure(String(verdict?.code || 'MP_AI_UNTRUSTED'), String(verdict?.error || '发起者不是受信的编辑器窗口'));
      }
    }
    const settings = typeof readSettings === 'function' ? (readSettings() || {}) : {};
    const resolved = resolveConfig({ settings, env, customEndpoint });
    if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message, configured: false };
    return { ok: true, configured: true, config: describeConfig(resolved.config) };
  });

  const dispose = () => {
    /* 插件卸载/宿主退出：中止所有在途请求，并释放 IPC 通道。 */
    for (const [id, entry] of [...inflight]) {
      try { entry.controller.abort(); } catch { /* 已中止 */ }
      inflight.delete(id);
    }
    for (const handler of [channel, cancelChannel, statusChannel]) {
      try { ipcMain.removeHandler(handler); } catch { /* 已移除 */ }
    }
  };
  /* 供宿主在窗口销毁时调用（`webContents.on('destroyed')`）。 */
  return { dispose, sweepOwner, inflightSize: () => inflight.size };
}

module.exports = {
  PROVIDERS, SYSTEM_PROMPT, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS, MAX_SELECTION_CHARS, MESSAGES,
  redact, scrub, validateBaseURL, resolveConfig, describeConfig,
  endpointOf, requestBodyOf, headersOf, extractText,
  rewriteSelection, registerAiRewrite, defaultFetch,
};
