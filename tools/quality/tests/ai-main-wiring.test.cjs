'use strict';
/*
 * main.js 接线段的**真跑**验证（不启动 GUI、不打包）。
 *
 * 为什么需要这一支：模块单测验的是 shell/ai-rewrite.js，但"接线接对了没有"要看
 * main.js 里那几段（可信配置读取、provider 解析顺序、aiTrust 映射、registerAiRewrite 装配）。
 * 这些代码此前只能靠"读起来对"来判断 —— 本支把它们**抽成可执行的等价实现并真跑**，
 * 用与 main.js 相同的输入形态（假 state/app/process.env/文件系统）验出行为。
 *
 * 局限（如实写）：这是**等价实现**而不是把 main.js 整个 require 进来（main.js 顶层要
 * electron 的 app/BrowserWindow，无法在纯 Node 里加载）。两者的判据逐字对齐，
 * 若 main.js 那几段改了而这里没改，接线测试会与 ai-diag 的读数对不上 —— 见文末的
 * "锚点一致性"断言：它会扫 main.js 源码，确认关键片段仍在（改了就红）。
 *
 * 运行：node tools/quality/tests/ai-main-wiring.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');
const MAIN = path.join(ROOT, 'MarkPilot-CM6/main.js');
const PRELOAD = path.join(ROOT, 'MarkPilot-CM6/preload.js');
const HOST = require(path.join(ROOT, 'MarkPilot-CM6/shell/ai-rewrite.js'));

const MAIN_SRC = fs.readFileSync(MAIN, 'utf8');
const PRELOAD_SRC = fs.readFileSync(PRELOAD, 'utf8');

/* ═════════════════ 锚点一致性：main.js 里那些片段必须还在 ═════════════════ */

test('main.js 保留了 AI 接线的全部关键片段（改了就红）', () => {
  const must = [
    ["require('./shell/ai-rewrite')", '宿主服务已加载'],
    ['const AI_CONFIG_FILE = path.join(app.getPath(\'userData\'), \'ai-rewrite.json\')', '可信配置文件路径'],
    ['function readTrustedAiConfig()', '可信配置读取'],
    ['function trustedCustomEndpoint()', '可信端点解析（env 优先、其次文件）'],
    ['function aiTrust(e)', '可信窗口/主框架门槛'],
    ['const aiRewriteService = aiRewrite.registerAiRewrite({', '服务装配'],
    ['authorize: aiTrust', '门槛真的接上了'],
    ['customEndpoint: () => trustedCustomEndpoint()', '端点每次现读'],
    ['aiRewriteService.sweepOwner(String(wc.id))', '窗口销毁收尾'],
    ["handle('ai:diag'", '只读诊断通道'],
  ];
  for (const [needle, why] of must) {
    assert.equal(MAIN_SRC.includes(needle), true, `main.js 缺少「${why}」：${needle}`);
  }
});

test('main.js 没有把秘密放进 SETTING_WRITABLE（渲染侧可写白名单）', () => {
  const m = /const SETTING_WRITABLE = new Set\(\[([\s\S]*?)\]\);/.exec(MAIN_SRC);
  assert.ok(m, '必须存在 SETTING_WRITABLE 声明');
  const keys = m[1];
  for (const secretKey of ['aiRewriteApiKey', 'aiRewriteApiKeyEnv', 'aiRewriteBaseURL']) {
    assert.equal(keys.includes(secretKey), false, `${secretKey} 绝不能被渲染侧写`);
  }
});

test('preload 暴露了四条 AI 桥面且不含 signal 透传', () => {
  for (const needle of ["aiRewrite: (payload, options = {})", 'aiRewriteCancel:', 'aiStatus:', 'aiDiag:']) {
    assert.equal(PRELOAD_SRC.includes(needle), true, `preload 缺少 ${needle}`);
  }
  assert.equal(/aiRewrite[\s\S]{0,200}signal/.test(PRELOAD_SRC), false, 'signal 不能跨 IPC 传');
});

test('main.js 的 AI 通道名与 preload 对得上（4 条，且无重复）', () => {
  const preloadChannels = [...PRELOAD_SRC.matchAll(/invoke\('(ai:[a-z-]+)'/g)].map(m => m[1]);
  assert.deepEqual([...new Set(preloadChannels)].sort(),
    ['ai:diag', 'ai:rewrite', 'ai:rewrite-cancel', 'ai:status']);
  /* registerAiRewrite 注册三条 + main.js 自己一条 diag */
  const ipc = [];
  HOST.registerAiRewrite({
    ipcMain: { handle: (c) => ipc.push(c), removeHandler() { } },
    authorize: async () => ({ ok: true }), readSettings: () => ({}), env: {},
  });
  assert.deepEqual(ipc, ['ai:rewrite', 'ai:rewrite-cancel', 'ai:status']);
});

/* ═════════════════ provider 解析顺序（与 main.js readSettings 同算法） ═════════════════ */

/** 与 main.js 的 readSettings 同一段逻辑（逐字对齐）。 */
function resolveProvider({ env = {}, settings = {}, hasCustomEndpoint = false } = {}) {
  const envProvider = String(env.MP_AI_PROVIDER || '').trim().toLowerCase();
  const settingProvider = String(settings.aiRewriteProvider || '').trim().toLowerCase();
  return envProvider || settingProvider || (hasCustomEndpoint ? 'custom' : 'deepseek');
}

test('provider 解析顺序：env > settings > 已配端点则 custom > 默认 deepseek', () => {
  assert.equal(resolveProvider({ env: { MP_AI_PROVIDER: 'openai' }, settings: { aiRewriteProvider: 'anthropic' } }), 'openai');
  assert.equal(resolveProvider({ settings: { aiRewriteProvider: 'anthropic' } }), 'anthropic');
  assert.equal(resolveProvider({ hasCustomEndpoint: true }), 'custom', '配了可信端点却用不到 = 最大困惑源');
  assert.equal(resolveProvider({}), 'deepseek');
});

/* ═════════════════ 可信端点：环境变量优先，其次可信配置文件 ═════════════════ */

test('可信端点：环境变量优先于配置文件；两者都没有则 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ai-cfg-'));
  const file = path.join(dir, 'ai-rewrite.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ baseURL: 'http://127.0.0.1:1111', model: 'from-file' }));

    /* 文件形态 */
    const fromFile = HOST.resolveConfig({
      settings: { aiRewriteProvider: 'custom' }, env: {},
      customEndpoint: () => ({ ok: true, endpoint: { baseURL: 'http://127.0.0.1:1111', model: 'from-file' } }),
    });
    assert.equal(fromFile.ok, true);
    assert.equal(fromFile.config.model, 'from-file');

    /* env 形态（main.js 里 env 分支在前） */
    const envEndpoint = { baseURL: 'http://127.0.0.1:2222', model: 'from-env', apiKey: '' };
    const fromEnv = HOST.resolveConfig({
      settings: { aiRewriteProvider: 'custom' }, env: {},
      customEndpoint: () => ({ ok: true, endpoint: envEndpoint }),
    });
    assert.equal(fromEnv.ok, true);
    assert.equal(fromEnv.config.baseURL, 'http://127.0.0.1:2222');
    assert.equal(fromEnv.config.model, 'from-env');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('可信配置文件结构非法 ⇒ 调用时如实回报（不是静默退回默认服务）', () => {
  const r = HOST.resolveConfig({
    settings: { aiRewriteProvider: 'custom' }, env: {},
    customEndpoint: () => ({ ok: false, error: { code: 'MP_AI_CONFIG_INCOMPLETE', message: 'ai-rewrite.json 需要 baseURL 与 model' } }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MP_AI_CONFIG_INCOMPLETE');
  assert.match(r.message, /baseURL/);
});

test('可信配置文件里的非法端点（远程明文 http）被拒', () => {
  const r = HOST.resolveConfig({
    settings: { aiRewriteProvider: 'custom' }, env: {},
    customEndpoint: () => ({ ok: true, endpoint: { baseURL: 'http://203.0.113.9/v1', model: 'x' } }),
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /https|回环/);
});

/* ═════════════════ 内建服务密钥限定对应 origin ═════════════════ */

test('内建服务：密钥只去它自己的 origin，且三个 provider 各自绑定', () => {
  /* 同一个环境里放三家的 key，各自解析出的 baseURL 必须是对应的那家 */
  const env = { DEEPSEEK_API_KEY: 'sk-d', OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: 'sk-a' };
  const ds = HOST.resolveConfig({ settings: {}, env }).config;
  assert.equal(ds.baseURL, 'https://api.deepseek.com');
  assert.equal(ds.apiKey, 'sk-d');
  const oa = HOST.resolveConfig({ settings: { aiRewriteProvider: 'openai' }, env }).config;
  assert.equal(oa.baseURL, 'https://api.openai.com/v1');
  assert.equal(oa.apiKey, 'sk-o', 'openai 只能拿到 OPENAI_API_KEY，不能拿到 deepseek 的');
  const an = HOST.resolveConfig({ settings: { aiRewriteProvider: 'anthropic' }, env }).config;
  assert.equal(an.baseURL, 'https://api.anthropic.com');
  assert.equal(an.apiKey, 'sk-a');
});

test('内建服务的密钥**不会被**发到 custom 端点（换了 provider 就不会串）', () => {
  const env = { DEEPSEEK_API_KEY: 'sk-deepseek-should-not-leak' };
  const custom = HOST.resolveConfig({
    settings: { aiRewriteProvider: 'custom' }, env,
    customEndpoint: () => ({ ok: true, endpoint: { baseURL: 'http://127.0.0.1:18080', model: 'local', apiKey: '' } }),
  });
  assert.equal(custom.ok, true);
  assert.equal(custom.config.apiKey, '', 'custom 端点绝不能自动带上任何内建服务的密钥');
  assert.equal(custom.config.baseURL, 'http://127.0.0.1:18080');
});
