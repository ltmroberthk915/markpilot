const {test} = require('node:test');
const assert = require('node:assert/strict');
const {PROVIDER_TEMPLATES, credentialId, profileFor, allProfiles} = require('../extension-src/out/completion/profiles.cjs');
const {settings, endpoint, parseProviderConfig} = require('../extension-src/out/completion/core.cjs');
const platform = {commands: {registerCommand: () => ({dispose() {}})}, CancellationTokenSource: class {cancel() {} dispose() {}}};
const {CompletionManager} = require('../extension-src/out/completion/host.cjs');
function fixture(config = {}, secrets = {}) {
  const state = new Map([['completionSettings', settings(config)]]), vault = new Map(Object.entries(secrets));
  const context = {subscriptions: [], globalState: {get: key => state.get(key), update: async (key, value) => state.set(key, value)},
    secrets: {get: async key => vault.get(key), store: async (key, value) => vault.set(key, value), delete: async key => vault.delete(key)}};
  return {manager: new CompletionManager(context, platform), context, state, vault};
}
// Scripted dialogs: map input titles / quick-pick titles to answers.
function dialogFixture(config, answers = {}) {
  const state = new Map([['completionSettings', settings(config)]]), vault = new Map();
  const context = {subscriptions: [], globalState: {get: key => state.get(key), update: async (key, value) => state.set(key, value)},
    secrets: {get: async key => vault.get(key), store: async (key, value) => vault.set(key, value), delete: async key => vault.delete(key)}};
  const info = [];
  const scripted = {...platform, window: {
    showInputBox: async options => answers.input?.[options.title] ?? undefined,
    showQuickPick: async (items, options) => {
      const pick = answers.pick?.[options.title];
      return pick === undefined ? undefined : (items.find(item => item.label === pick || item.protocol === pick) || items.find(() => pick === true));
    },
    showInformationMessage: message => {info.push(message);},
  }};
  return {manager: new CompletionManager(context, scripted), context, state, vault, info};
}
const DS = {id: 'custom-ds', label: 'DeepSeek', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash'};
const GLM = {id: 'custom-glm', label: 'GLM', protocol: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3-flash'};

test('不再内置任何服务商或模型；默认就是“还没配”', () => {
  assert.equal(PROVIDER_TEMPLATES.length, 3);
  assert.ok(PROVIDER_TEMPLATES.every(template => !template.model), '模板只给协议与地址，不再预设模型');
  const config = settings();
  assert.equal(config.protocol, 'anthropic');assert.equal(config.baseUrl, '');assert.equal(config.model, '');
  assert.equal(config.ai, false);assert.equal(config.automaticAI, false);assert.deepEqual(config.profiles, []);
  assert.equal(settings({apiKey: 'never-persist', env: {ANTHROPIC_AUTH_TOKEN: 'secret'}, delay: 3600000}).delay, 3000);
  assert.ok(!JSON.stringify(settings({apiKey: 'never-persist'})).includes('never-persist'));
  assert.equal(allProfiles(settings()).length, 0);
});

test('密钥槽只跟“协议 + 归一化地址”绑定：地址换个写法不换槽', () => {
  assert.equal(credentialId(DS), credentialId({...DS, baseUrl: 'https://api.deepseek.com'}));
  assert.equal(credentialId(DS), credentialId({...DS, baseUrl: 'https://api.deepseek.com/v1'}));
  assert.equal(credentialId(DS), credentialId({...DS, baseUrl: 'https://api.deepseek.com/v1/messages'}));
  assert.notEqual(credentialId(DS), credentialId(GLM));
  assert.notEqual(credentialId(DS), credentialId({...DS, protocol: 'chat-completions'}));
  assert.notEqual(credentialId(DS), credentialId({...DS, baseUrl: 'https://api.deepseek.com/another-account'}), '同一主机不同自定义子路径仍是不同账号');
  assert.equal(profileFor(settings({...DS, profiles: [DS]})).id, DS.id);
});

test('只改模型名不会动密钥（用户实测的“改一次模型名就像把密码清空了”）', async () => {
  const {manager} = fixture({...DS, profiles: [DS], ai: true, activeProfile: DS.id});
  await manager.ready;
  await manager.saveAPIKey('ds-key', DS);
  assert.equal(await manager.getAPIKey(), 'ds-key');
  for (const model of ['deepseek-flash', 'deepseek-v4-pro', 'my-own-model']) {
    await manager.update({...manager.config, model});
    assert.equal(await manager.getAPIKey(), 'ds-key', '模型名变化后密钥仍在同一槽：' + model);
    assert.equal(manager.publicConfig.keyAvailable, true);
  }
  // 同一端点的另一种写法也还在同一个槽（以前换写法就会显示“未保存密钥”）。
  for (const baseUrl of ['https://api.deepseek.com', 'https://api.deepseek.com/v1']) {
    await manager.update({...manager.config, baseUrl});
    assert.equal(await manager.getAPIKey(), 'ds-key');
    assert.equal(endpoint(baseUrl, 'anthropic'), 'https://api.deepseek.com/anthropic/v1/messages');
  }
  // 真换了平台才会换槽：旧平台的密钥仍留着，不是被“清空”。
  await manager.update({...manager.config, ...GLM, profiles: [DS, GLM], activeProfile: GLM.id});
  assert.equal(await manager.getAPIKey(), undefined);
  assert.equal(manager.publicConfig.keyAvailable, false);
  assert.equal(await manager.getAPIKey(DS), 'ds-key');
});

test('新增模型：模板只填地址，模型名与密钥由用户写，存下来就是可切换配置', async () => {
  const answers = {input: {'新增模型（2/5）· 名称': '我的 DeepSeek', '新增模型（3/5）· API 地址': 'https://api.deepseek.com',
    '新增模型（4/5）· 模型 ID': 'deepseek-flash[1M]', '新增模型（5/5）· API Key': 'fresh-key'},
    pick: {'新增模型（1/5）· 选协议与地址模板': 'Anthropic 兼容（Claude Code / cc-switch 写法）'}};
  const {manager, state, vault} = dialogFixture({}, answers);
  await manager.ready;
  assert.equal(await manager.addProfileFlow(), true);
  const saved = settings(state.get('completionSettings'));
  assert.equal(saved.profiles.length, 1);
  assert.equal(saved.profiles[0].label, '我的 DeepSeek');
  assert.equal(saved.profiles[0].model, 'deepseek-flash');
  assert.equal(saved.profiles[0].baseUrl, 'https://api.deepseek.com');
  assert.equal(saved.activeProfile, saved.profiles[0].id);
  assert.equal(saved.ai, true);assert.equal(vault.get(credentialId(saved.profiles[0])), 'fresh-key');
  assert.equal(manager.publicConfig.profiles.length, 1);
  // 同一个名字+协议+地址只更新不重复添加。
  const again = dialogFixture(state.get('completionSettings'), answers);
  await again.manager.ready;await again.manager.addProfileFlow();
  assert.equal(settings(again.state.get('completionSettings')).profiles.length, 1);
});

test('导入配置：cc-switch 的 settings.json 与 KEY=VALUE 行都能认', async () => {
  const ccSwitch = JSON.stringify({env: {ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'imported-key', ANTHROPIC_MODEL: 'deepseek-flash'}});
  const {manager, state, vault} = dialogFixture({});
  await manager.ready;
  assert.equal(await manager.importProfileFlow({text: ccSwitch}), true);
  const saved = settings(state.get('completionSettings'));
  assert.equal(saved.profiles.length, 1);assert.equal(saved.model, 'deepseek-flash');
  assert.equal(saved.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.equal(vault.get(credentialId(saved.profiles[0])), 'imported-key');
  const lines = dialogFixture({});
  await lines.manager.ready;
  assert.equal(await lines.manager.importProfileFlow({text: 'export ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic\nANTHROPIC_MODEL=glm-5.3-flash\nANTHROPIC_AUTH_TOKEN="glm-key"'}), true);
  const second = settings(lines.state.get('completionSettings'));
  assert.equal(second.model, 'glm-5.3-flash');assert.equal(second.protocol, 'anthropic');
  assert.equal(lines.vault.get(credentialId(second.profiles[0])), 'glm-key');
  // 认不出地址就明确拒绝，不写脏配置。
  const bad = dialogFixture({});
  await bad.manager.ready;
  assert.equal(await bad.manager.importProfileFlow({text: 'hello world'}), false);
  assert.equal(settings(bad.state.get('completionSettings')).profiles.length, 0);
  assert.ok(bad.info.some(message => /没认出地址/.test(message)));
});

test('删除模型配置：预置与自建都能删，连带删掉该平台密钥；删掉在用的会回退', async () => {
  const config = {ai: true, ...DS, profiles: [DS, GLM], activeProfile: DS.id};
  const {manager, state, vault} = dialogFixture(config);
  await manager.ready;
  await manager.saveAPIKey('ds-key', DS);await manager.saveAPIKey('glm-key', GLM);
  assert.equal(await manager.deleteProfileFlow({profile: DS}), true);
  const after = settings(state.get('completionSettings'));
  assert.deepEqual(after.profiles.map(profile => profile.id), [GLM.id]);
  assert.equal(after.activeProfile, GLM.id, '删掉当前在用的配置会回退到剩下的第一个');
  assert.equal(after.model, GLM.model);assert.equal(after.baseUrl, GLM.baseUrl);
  assert.equal(vault.has(credentialId(DS)), false, '该平台的密钥一并删除');
  assert.equal(vault.get(credentialId(GLM)), 'glm-key', '别的平台密钥不受影响');
  assert.equal(await manager.deleteProfileFlow({profile: GLM}), true);
  const empty = settings(state.get('completionSettings'));
  assert.equal(empty.profiles.length, 0);assert.equal(empty.baseUrl, '');assert.equal(empty.model, '');
  assert.equal(empty.ai, false, '一个配置都不剩时不再自动发 AI 请求');
  assert.equal(await manager.deleteProfileFlow({profile: DS}), false);
});

test('切换配置只换当前配置，不发出请求；请求带的是当前平台的密钥', async () => {
  const {manager} = fixture({ai: true, ...DS, profiles: [DS, GLM], activeProfile: DS.id});
  await manager.saveAPIKey('ds-key', DS);await manager.saveAPIKey('glm-key', GLM);
  const handlers = new Map(), emitted = [], calls = [];
  const handler = {on(name, callback) {handlers.set(name, callback);return this;}, emit: (name, value) => emitted.push({name, value})};
  let dispose;
  manager.bind({version: 1, getText: () => '$x+$'}, {onDidChangeViewState() {}, onDidDispose(fn) {dispose = fn;}}, handler, () => {throw new Error('Switch must not edit document');});
  await Promise.resolve();
  const oldFetch = global.fetch;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({url, body, key: options.headers['x-api-key']});
    return new Response(JSON.stringify({content: [{type: 'text', text: 'x'}]}));
  };
  const request = id => handlers.get('completion-request')({id, kind: 'ai', version: 1, aiContext: {kind: 'math', before: '$x+', after: '$', mathBefore: 'x+', mathAfter: ''}});
  try {
    assert.equal(calls.length, 0);
    await manager.selectProfile(GLM.id);
    assert.equal(calls.length, 0, '切换本身不发请求');
    await request(1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].key, 'glm-key');
    assert.equal(calls[0].body.model, 'glm-5.3-flash');
    assert.equal(calls[0].url, 'https://open.bigmodel.cn/api/anthropic/v1/messages');
    await manager.selectProfile(DS.id);
    await request(2);
    assert.equal(calls[1].key, 'ds-key');assert.equal(calls[1].body.model, 'deepseek-flash');
    assert.equal(calls[1].url, 'https://api.deepseek.com/anthropic/v1/messages');
    const serialized = JSON.stringify(emitted);
    assert.ok(!serialized.includes('ds-key') && !serialized.includes('glm-key'));
  } finally {global.fetch = oldFetch;dispose();}
});

test('AI 报错把服务商原文与实际请求地址都带出来（404 一眼看出地址错在哪）', async () => {
  const {manager} = fixture({ai: true, ...DS, profiles: [DS], activeProfile: DS.id});
  await manager.saveAPIKey('ds-key', DS);
  const handlers = new Map(), emitted = [];
  const handler = {on(name, callback) {handlers.set(name, callback);return this;}, emit: (name, value) => emitted.push({name, value})};
  let dispose;
  manager.bind({version: 1, getText: () => '$x+$'}, {onDidChangeViewState() {}, onDidDispose(fn) {dispose = fn;}}, handler, () => true);
  await Promise.resolve();
  const oldFetch = global.fetch;
  const last = () => emitted.filter(event => event.name === 'completion-response').at(-1).value;
  try {
    global.fetch = async () => new Response(JSON.stringify({error: {message: '模型不存在'}}), {status: 404});
    await handlers.get('completion-request')({id: 1, kind: 'ai', version: 1, aiContext: {kind: 'math', before: '$x+', after: '$', mathBefore: 'x+', mathAfter: ''}});
    assert.match(last().error, /HTTP 404/);assert.match(last().error, /模型不存在/);
    assert.match(last().error, /https:\/\/api\.deepseek\.com\/anthropic\/v1\/messages/);
    // 只回 thinking 的模型不再只显示“暂无建议”。
    global.fetch = async () => new Response(JSON.stringify({content: [{type: 'thinking', thinking: '想来想去'}], stop_reason: 'max_tokens'}));
    await handlers.get('completion-request')({id: 2, kind: 'ai', version: 1, aiContext: {kind: 'math', before: '$x+', after: '$', mathBefore: 'x+', mathAfter: ''}});
    assert.match(last().error, /只返回了思考内容/);
  } finally {global.fetch = oldFetch;dispose();}
});

test('解析出来的配置直接进“新增模型”，协议推断不猜服务商', () => {
  const ccSwitch = parseProviderConfig(JSON.stringify({env: {ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_MODEL: 'deepseek-flash'}}));
  assert.equal(ccSwitch.baseUrl, 'https://api.deepseek.com/anthropic');assert.equal(ccSwitch.model, 'deepseek-flash');
  assert.equal(ccSwitch.protocol, 'anthropic');assert.equal(ccSwitch.key, 'k');
  const openai = parseProviderConfig(JSON.stringify({baseURL: 'https://api.deepseek.com/v1', apiKey: 'k2', model: 'deepseek-chat'}));
  assert.equal(openai.baseUrl, 'https://api.deepseek.com/v1');assert.equal(openai.key, 'k2');
  const chat = parseProviderConfig('OPENAI_BASE_URL=https://example.test/v1\nOPENAI_API_KEY=k3\nOPENAI_MODEL=gpt-x');
  assert.equal(chat.protocol, 'chat-completions');assert.equal(chat.key, 'k3');
  assert.equal(parseProviderConfig(''), null);assert.equal(parseProviderConfig('nonsense'), null);
});

test('改地址：协议跟着地址走，而且不再顺手把 AI 关掉', async () => {
  const answers = {input: {'修改 API 地址': 'https://api.deepseek.com/anthropic'}};
  const {manager, info} = dialogFixture({ai: true, automaticAI: true, protocol: 'chat-completions',
    baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash'}, answers);
  await manager.ready;
  await manager.editField('baseUrl');
  assert.equal(manager.config.protocol, 'anthropic', '地址写着 /anthropic，协议就该是 anthropic');
  assert.equal(manager.config.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.equal(manager.config.ai, true, '换地址不该把 AI 开关一起关掉（用户实测那样会"配好了却什么都不发生"）');
  assert.equal(manager.config.automaticAI, true);
  assert.ok(info.some(message => /协议按地址判定/.test(message)), '要告诉用户协议是按地址判定的');
  assert.ok(info.some(message => /还没有密钥/.test(message)), '也要说明新地址要重填一次密钥');
  // 缺密钥时的提示要解释"密钥按协议+地址分开存"，否则用户以为密码丢了。
  await manager.update({...manager.config, profiles: [{id: 'p1', label: 'DS', protocol: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash'}]});
  const handlers = new Map(), emitted = [];
  const handler = {on(name, callback) {handlers.set(name, callback);return this;}, emit: (name, value) => emitted.push({name, value})};
  let dispose;
  manager.bind({version: 1, getText: () => '$x+$'}, {onDidChangeViewState() {}, onDidDispose(fn) {dispose = fn;}}, handler, () => true);
  await Promise.resolve();
  const oldFetch = global.fetch;
  global.fetch = async () => {throw new Error('must not be called without a key');};
  try {
    await handlers.get('completion-request')({id: 1, kind: 'ai', version: 1, aiContext: {kind: 'math', before: '$x+', after: '$', mathBefore: 'x+', mathAfter: ''}});
    const error = emitted.filter(event => event.name === 'completion-response').at(-1).value.error;
    assert.match(error, /API Key/);assert.match(error, /协议 \+ 地址/);
  } finally {global.fetch = oldFetch;dispose();}
});
