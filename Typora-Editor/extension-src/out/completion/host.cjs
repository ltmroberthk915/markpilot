'use strict';
const path = require('node:path');
const {settings, endpoint, parseProviderConfig, protocolFor, modelId, locate, candidate, requestAI} = require('./core.cjs');
const {PROVIDER_TEMPLATES, credentialId, profileFor, allProfiles, effectiveModel, customProfileId} = require('./profiles.cjs');
const {StructureCache}=require('./structure.cjs');
const STORAGE = 'completionSettings';
const LEGACY_SECRET = 'completion.apiKey';
// 已知需要密钥的公共平台：没填密钥时给出可操作的提示。本机服务或自建网关允许不带密钥。
const API_KEY_HOSTS = Object.freeze({'api.deepseek.com': 'DeepSeek', 'open.bigmodel.cn': '智谱 GLM'});
const hostOf = value => {try {return new URL(value).hostname;} catch {return '';}};
const policy = import('../../render/js/completion-policy.mjs');
const encodePath = value => value.split(/[\\/]/).map(part => encodeURIComponent(part).replace(/[()]/g, c => '%' + c.charCodeAt(0).toString(16))).join('/');

class CompletionManager {
  constructor(context, vscode = require('vscode')) {
    this.context = context;
    this.platform = vscode;
    this.controllers = new Set();
    this.keyAvailability = new Map();
    this.switchQueue = Promise.resolve();
    this.ready = this.initializeCredentials();
    this.ready.catch(() => {}); // Requests/settings report storage errors.
    context.subscriptions.push(vscode.commands.registerCommand('markpilot.completionSettings', () => this.configure()));
    context.subscriptions.push(vscode.commands.registerCommand('markpilot.completionAPIKey', () => this.configure('key')));
    context.subscriptions.push(vscode.commands.registerCommand('markpilot.completionModel', () => this.pickProfile()));
  }
  get config() {
    return settings(this.context.globalState.get(STORAGE));
  }
  async initializeCredentials() {
    const legacy = await this.context.secrets.get(LEGACY_SECRET);
    if (legacy) {
      const id = credentialId(this.config);
      if (!await this.context.secrets.get(id)) await this.context.secrets.store(id, legacy);
      // Delete only after successful migration. Never rebind a legacy key to a
      // newly selected provider, even after a restart.
      await this.context.secrets.delete(LEGACY_SECRET);
    }
    await this.refreshCredentials();
  }
  async refreshCredentials() {
    const ids = new Set([...allProfiles(this.config), this.config].map(credentialId));
    const available = await Promise.all([...ids].map(async id => [id, !!await this.context.secrets.get(id)]));
    this.keyAvailability = new Map(available);
  }
  // The active preset is remembered explicitly so a saved model override does
  // not detach it; configs saved before that field fall back to exact matches.
  activeProfile(config = this.config) {
    return allProfiles(config).find(profile => profile.id === config.activeProfile) || profileFor(config);
  }
  get publicConfig() {
    const config = this.config;
    return {...config, activeProfile: this.activeProfile(config)?.id || '', keyAvailable: this.keyAvailability.get(credentialId(config)) || false,
      profiles: allProfiles(config).map(profile => ({...profile, model: effectiveModel(config, profile), keyAvailable: this.keyAvailability.get(credentialId(profile)) || false}))};
  }
  async getAPIKey(config = this.config) {
    await this.ready;
    return this.context.secrets.get(credentialId(config));
  }
  async saveAPIKey(value, config = this.config) {
    await this.ready;
    const key = typeof value === 'string' ? value.trim() : '';
    if (!key) throw new Error('请输入 API Key。');
    await this.context.secrets.store(credentialId(config), key);
    await this.refreshCredentials();
    for (const controller of this.controllers) controller.notify();
  }
  async deleteAPIKey(config = this.config) {
    await this.ready;
    await this.context.secrets.delete(credentialId(config));
    await this.refreshCredentials();
    for (const controller of this.controllers) controller.notify();
  }
  async update(value) {
    await this.ready;
    await this.context.globalState.update(STORAGE, settings(value));
    await this.refreshCredentials();
    for (const controller of this.controllers) controller.notify();
  }
  selectProfile(id) {
    const config = this.config, profile = allProfiles(config).find(item => item.id === id);
    if (!profile) return Promise.resolve(false);
    for (const controller of this.controllers) controller.cancel();
    const switchTo = async () => {await this.ready;await this.update({...this.config, ...profile, model: effectiveModel(config, profile), activeProfile: profile.id});return true;};
    const task = this.switchQueue.then(switchTo);
    this.switchQueue = task.catch(() => {});
    return task;
  }
  async pickProfile() {
    const vscode = this.platform;
    await this.ready;
    const active = this.activeProfile()?.id;
    const item = await vscode.window.showQuickPick(allProfiles(this.config).map(profile => ({...profile,
      label: (profile.id === active ? '$(check) ' : '') + profile.label,
      description: effectiveModel(this.config, profile), detail: this.keyAvailability.get(credentialId(profile)) ? '已保存此平台密钥' : '切换后在“补全 ▾”中填写此平台密钥'})), {title: '切换补全模型'});
    if (item) await this.selectProfile(item.id);
  }
  // 新增模型：模板只预填协议与地址，模型名由用户自己写。全部字段都可再改，
  // 存下来的就是用户自己的配置（可切换、可删除）。
  async addProfileFlow(seed = {}) {
    const vscode = this.platform;
    await this.ready;
    const config = this.config;
    const template = seed.template || await vscode.window.showQuickPick([
      ...PROVIDER_TEMPLATES.map(item => ({label: item.label, description: item.baseUrl, protocol: item.protocol, baseUrl: item.baseUrl})),
      {label: '自定义地址', protocol: config.protocol, baseUrl: ''},
    ], {title: '新增模型（1/5）· 选协议与地址模板'});
    if (!template) return false;
    const protocol = seed.protocol || template.protocol;
    const label = seed.label ?? await vscode.window.showInputBox({title: '新增模型（2/5）· 名称', ignoreFocusOut: true,
      prompt: '给这个配置起个名字，例如 DeepSeek、公司网关；留空就用地址当名字。'});
    if (label === undefined) return false;
    const baseUrl = seed.baseUrl ?? await vscode.window.showInputBox({title: '新增模型（3/5）· API 地址', ignoreFocusOut: true, value: template.baseUrl,
      prompt: '填服务商文档里的地址即可，只填主机名也行（会自动补全路径）；Anthropic 兼容示例 https://api.deepseek.com/anthropic',
      validateInput: value => {try {endpoint(value, protocol);return null;} catch (error) {return error.message;}}});
    if (baseUrl === undefined || !baseUrl.trim()) return false;
    const model = seed.model ?? await vscode.window.showInputBox({title: '新增模型（4/5）· 模型 ID', ignoreFocusOut: true, value: config.model,
      prompt: '服务商文档里的模型 ID，例如 deepseek-flash；会去掉 Claude Code 的 [1M] 后缀。',
      validateInput: value => modelId(value) ? null : '请输入模型 ID。'});
    if (model === undefined || !modelId(model)) return false;
    const trimmed = baseUrl.trim(), name = String(label).trim() || (() => {try {return new URL(trimmed).hostname;} catch {return '自定义模型';}})();
    // 模板只给起点：地址里写着哪一族 API，最终协议就按地址算（避免"模板选了 Chat
    // Completions、地址粘的是 /anthropic"这种自相矛盾的配置，用户实测它就 404）。
    const finalProtocol = protocolFor(trimmed, protocol);
    const entry = {id: customProfileId(name, finalProtocol, trimmed), label: name, protocol: finalProtocol, baseUrl: trimmed, model: modelId(model)};
    const saved = await this.getAPIKey(entry);
    const answer = seed.key ?? await vscode.window.showInputBox({title: '新增模型（5/5）· API Key', password: true, ignoreFocusOut: true,
      prompt: saved ? '这个地址已经存过密钥；留空沿用已保存的' : '粘贴服务商给的 API Key；无需鉴权的本机服务可以留空'});
    if (answer === undefined) return false;
    if (String(answer).trim()) await this.saveAPIKey(String(answer).trim(), entry);
    await this.update({...config, protocol: entry.protocol, baseUrl: entry.baseUrl, model: entry.model, activeProfile: entry.id, ai: true,
      profiles: [...allProfiles(config).filter(item => item.id !== entry.id), entry]});
    vscode.window.showInformationMessage('已保存模型 ' + entry.label + '。可在“补全 ▾”里一键切换，也可在“删除模型配置”里删掉。');
    return true;
  }
  // 导入配置：直接粘 cc-switch / Claude Code 的 settings.json、扁平 JSON，或
  // ANTHROPIC_BASE_URL=… 这样的逐行写法，不限定服务商。
  async importProfileFlow(seed = {}) {
    const vscode = this.platform;
    await this.ready;
    const source = seed.text ?? await vscode.window.showInputBox({title: '导入模型配置', ignoreFocusOut: true,
      prompt: '粘贴配置：{"env":{"ANTHROPIC_BASE_URL":…,"ANTHROPIC_AUTH_TOKEN":…,"ANTHROPIC_MODEL":…}}、扁平 JSON，或逐行 KEY=VALUE。'});
    if (!source || !String(source).trim()) return false;
    const parsed = parseProviderConfig(source);
    if (!parsed || !parsed.baseUrl) {
      vscode.window.showInformationMessage('没认出地址：至少要有一行 baseUrl / ANTHROPIC_BASE_URL。');
      return false;
    }
    if (!parsed.model) vscode.window.showInformationMessage('配置里没有模型 ID，下一步请补上。');
    // 模板就地给定，不再让用户选一次：导入 = 粘一次就落地（缺的字段对话框会带着默认值问）。
    return this.addProfileFlow({...parsed, template: {label: parsed.label, protocol: parsed.protocol, baseUrl: parsed.baseUrl}});
  }
  // 删除模型配置：预设也好、自己加的也好，都能删；连带删掉该平台已保存的密钥。
  async deleteProfileFlow(seed = {}) {
    const vscode = this.platform;
    await this.ready;
    const config = this.config, list = allProfiles(config);
    if (!list.length) {vscode.window.showInformationMessage('还没有保存过模型配置。');return false;}
    const chosen = seed.profile || await vscode.window.showQuickPick(list.map(profile => ({label: profile.label,
      description: profile.model, detail: profile.baseUrl, profile})), {title: '删除模型配置（连同该平台已保存的密钥）'});
    if (!chosen) return false;
    const profile = chosen.profile || chosen, active = config.activeProfile === profile.id;
    const remaining = list.filter(item => item.id !== profile.id);
    const next = {...config, profiles: remaining, activeProfile: active ? '' : config.activeProfile};
    if (active) {
      const fallback = remaining[0];
      // 删掉的正是当前在用的：退回剩下的第一个；一个都不剩就清空，避免继续打到已删掉的地址。
      Object.assign(next, fallback ? {...fallback, activeProfile: fallback.id} : {protocol: 'anthropic', baseUrl: '', model: '', ai: false, automaticAI: false});
    }
    await this.deleteAPIKey(profile);
    await this.update(next);
    vscode.window.showInformationMessage('已删除模型配置 ' + profile.label + '（含该平台密钥）。');
    return true;
  }
  async configure(field) {
    const vscode = this.platform;
    // 渲染层菜单里的“补全 ▾”直接喊具体动作，不进菜单循环。
    if (field === 'addProfile') return this.addProfileFlow();
    if (field === 'import') return this.importProfileFlow();
    if (field === 'deleteProfile') return this.deleteProfileFlow();
    if (field) return this.editField(field);
    if (this.configuring) return;
    this.configuring = true;
    try {
      await this.ready;
      while (true) {
        const config = this.config, active = this.activeProfile(config), saved = this.keyAvailability.get(credentialId(config));
        const items = [
          {label: '切换模型：' + (active?.label || config.model || '未配置'), description: allProfiles(config).map(item => item.label).join(' / ') || '还没有保存过模型配置', action: 'profile'},
          {label: '新增模型…', description: '协议、地址、模型与密钥，全部由你填', action: 'addProfile'},
          {label: '导入配置…', description: '粘贴 cc-switch / Claude Code 的 settings.json 或 KEY=VALUE 行', action: 'import'},
          {label: '删除模型配置…', description: '自己加的与内置预设都能删，连同该平台密钥', action: 'deleteProfile'},
          {label: 'API 地址：' + (config.baseUrl || '未配置'), description: endpoint(config.baseUrl, config.protocol), action: 'baseUrl'},
          {label: '模型：' + (config.model || '未配置'), action: 'model'},
          {label: 'API Key：' + (saved ? '已保存' : '未保存'), action: 'key'},
          {label: 'AI 灰字补全：' + (config.ai ? '开启' : '关闭'), description: 'Alt+\\ 手动请求，Tab 接受，Esc 取消', action: 'ai'},
          {label: '自动请求 AI：' + (config.automaticAI ? '开启' : '关闭'), description: '数学优先，直接生成补写建议', action: 'automaticAI'},
          {label: '光标停顿建议：' + (config.cursorSuggestions ? '开启' : '关闭'), description: '进入公式、移动光标后也可触发；本地判断，无额外检查请求', action: 'cursorSuggestions'},
          {label: '章节上下文：' + (config.sectionContext ? '开启' : '关闭'), description: '附上章节与少量相关数学定义；不增加请求次数，合计最多 1200 字符', action: 'sectionContext'},
          {label: 'AI 等待时间：' + config.delay + ' ms', action: 'delay'},
          {label: '公式、模板和路径补全：' + (config.local ? '开启' : '关闭'), action: 'local'},
          ...(vscode.completionProviderAvailable === false ? [] : [{label: '宿主候选补全：' + (config.host ? '开启' : '关闭'), description: '查询兼容的 CompletionItemProvider', action: 'host'}]),
          {label: '删除当前平台的 API 密钥', action: 'deleteKey'},
          {label: '完成', action: 'done'},
        ];
        const chosen = await vscode.window.showQuickPick(items, {title: 'Markdown 补全设置', placeHolder: '本地补全无需联网；AI 使用你自己配置的服务'});
        if (!chosen || chosen.action === 'done') break;
        if (['profile', 'addProfile', 'import', 'deleteProfile', 'baseUrl', 'model', 'key'].includes(chosen.action)) {
          await this.configure(chosen.action === 'profile' ? undefined : chosen.action);
          if (chosen.action === 'profile') await this.pickProfile();
        } else if (chosen.action === 'deleteKey') {
          await this.deleteAPIKey(config);
          await this.update({...config, ai: false, automaticAI: false});
        } else if (chosen.action === 'delay') {
          const value = await vscode.window.showInputBox({title: 'AI 请求等待时间', prompt: '输入 400～3000 毫秒', value: String(config.delay),
            validateInput: value => /^\d+$/.test(value) && Number(value) >= 400 && Number(value) <= 3000 ? null : '请输入 400～3000。'});
          if (value !== undefined) await this.update({...config, delay: Number(value)});
        } else {
          if (['ai','automaticAI'].includes(chosen.action) && (!config.baseUrl || !config.model)) {
            await vscode.window.showInformationMessage('请先在“新增模型”或“导入配置”里填好地址与模型。'); continue;
          }
          await this.update({...config, [chosen.action]: !config[chosen.action]});
        }
      }
    } finally {this.configuring = false;}
  }
  // 单个字段的编辑：地址、模型、密钥。地址变了就是换了平台——密钥按平台分别保存，
  // 所以这里明确告诉用户，而不是让密钥看起来“被清空了”。
  async editField(field) {
    const vscode = this.platform;
    await this.ready;
    const config = this.config;
    if (field === 'key') {
      if (!config.baseUrl) {
        await vscode.window.showInformationMessage('还没有配置地址：先在“新增模型”或“导入配置”里填好地址，再保存密钥。');
        return;
      }
      const label = this.activeProfile(config)?.label || config.baseUrl;
      const saved = await this.getAPIKey(config);
      const key = await vscode.window.showInputBox({title: '填写 API Key · ' + label, password: true, ignoreFocusOut: true,
        prompt: (saved ? '输入新密钥；留空保留已保存的密钥。' : '粘贴服务商提供的 API Key。') + ' 保存后开启 AI；自动请求可在“补全 ▾”中切换。'});
      if (!key?.trim()) return;
      await this.saveAPIKey(key, config);
      await this.update({...config, ai: true});
      vscode.window.showInformationMessage('API Key 已保存。' + (config.automaticAI ? '自动 AI 补全已开启。' : 'Alt+\\ 请求补全；自动请求可在“补全 ▾”中开启。'));
      return;
    }
    if (field === 'baseUrl') {
      const baseUrl = await vscode.window.showInputBox({title: '修改 API 地址', value: config.baseUrl, ignoreFocusOut: true,
        prompt: '可只填主机名，会自动补全路径；地址里写着 /anthropic 或 /chat/completions 时，协议按地址判定。密钥按“协议 + 地址”分别保存。',
        validateInput: value => {try {endpoint(value, config.protocol);return null;} catch (error) {return error.message;}}});
      if (baseUrl === undefined || !baseUrl.trim()) return;
      const trimmed = baseUrl.trim();
      // 地址自己写明是哪一族 API 就听地址的（用户实测：地址改到 /anthropic、协议还停在
      // chat-completions，于是被拼成 /anthropic/chat/completions 直接 404）。
      const protocol = protocolFor(trimmed, config.protocol);
      const changed = !config.baseUrl || endpoint(trimmed, protocol) !== endpoint(config.baseUrl, config.protocol);
      // 换地址不再顺手把 AI 关掉：那样会出现"明明配好了却什么都不发生"（用户实测）。
      await this.update({...config, baseUrl: trimmed, protocol, activeProfile: ''});
      const notes = [];
      if (protocol !== config.protocol) notes.push('协议按地址判定为 ' + (protocol === 'anthropic' ? 'Anthropic Messages' : 'Chat Completions'));
      if (changed) notes.push('这个地址还没有密钥，需要时在“API Key”里填一次（旧地址的密钥仍留着）');
      if (notes.length) vscode.window.showInformationMessage('地址已更新。' + notes.join('；') + '。');
      return;
    }
    const model = await vscode.window.showInputBox({title: '修改补全模型', value: config.model, ignoreFocusOut: true,
      prompt: '填服务商文档里的模型 ID，例如 deepseek-flash。只改模型不会动密钥。',
      validateInput: value => modelId(value) ? null : '请输入模型 ID。'});
    if (model === undefined || !modelId(model)) return;
    const next = modelId(model), active = this.activeProfile(config);
    const other = allProfiles(config).find(profile => profile.model === next && credentialId(profile) !== credentialId(config));
    // 不静默切平台：改模型只改模型，密钥跟着地址走。
    await this.update({...config, model: next, ...(active ? {activeProfile: active.id} : {}),
      ...(active ? {profileModels: {...config.profileModels, [active.id]: next}} : {})});
    if (other) vscode.window.showInformationMessage('模型已改为 ' + next + '。提示：“' + other.label + '”也是这个模型，可用“切换模型”切到它（密钥按平台分别保存）。');
  }
  bind(document, panel, handler, applyContent) {
    const vscode = this.platform;
    let structure = this.config.sectionContext ? new StructureCache(document) : null;
    const active = new Map();
    let disposed = false, sync = Promise.resolve(), revision = 0, lastAI = 0, pathCache = null, hostQuery = null, aiCache;
    const cancel = options => {
      for (const [kind, job] of active) {if (options?.keepAI && kind === 'ai') continue;job.abort.abort();active.delete(kind);}
    };
    const controller = {
      boot: () => ({settings: this.publicConfig, documentVersion: document.version}),
      cancel,
      synchronized:()=>sync,
      notify: () => {cancel();aiCache?.clear();handler.emit('completion-settings-changed', controller.boot());},
    };
    this.controllers.add(controller);
    this.ready.then(() => {if (!disposed) controller.notify();}).catch(() => {});
    handler.on('completion-settings', () => this.configure());
    handler.on('completion-select-profile', id => this.selectProfile(id));
    handler.on('completion-add-profile', () => this.configure('addProfile'));
    handler.on('completion-import-profile', () => this.importProfileFlow());
    handler.on('completion-delete-profile', () => this.deleteProfileFlow());
    handler.on('completion-api-field', field => ['key', 'baseUrl', 'model'].includes(field) ? this.configure(field) : undefined);
    handler.on('completion-toggle', field => {
      if (!['automaticAI', 'local', 'cursorSuggestions', 'sectionContext'].includes(field)) return;
      const config = this.config;
      if (field === 'automaticAI' && !config.ai) return;
      return this.update({...config, [field]: !config[field]});
    });
    handler.on('completion-cancel', cancel);
    handler.on('completion-change', request => {
      if (!request || typeof request.content !== 'string' || !Number.isSafeInteger(request.revision)) return;
      cancel();
      const write = async () => {
        if (disposed || request.revision < revision) return;
        revision = request.revision;
        let ok = false;
        try {ok = await applyContent(request.content);} catch {}
        if (!disposed) handler.emit('completion-ack', {revision, version: document.version, ok: !!ok});
      };
      sync = sync.then(write, write);
      return sync;
    });
    handler.on('completion-request', async request => {
      if (!request || !Number.isSafeInteger(request.id) || !['host','paths','ai'].includes(request.kind)) return;
      const kind = request.kind, abort = new AbortController(), token = new vscode.CancellationTokenSource();
      active.get(kind)?.abort.abort();
      const job = {id: request.id, abort}; active.set(kind, job);
      abort.signal.addEventListener('abort', () => token.cancel(), {once: true});
      const timer = setTimeout(() => abort.abort(), kind === 'ai' ? 15000 : 2500);
      const response = {id: request.id, kind, items: []};
      try {
        await sync;
        if (disposed || abort.signal.aborted || request.version !== document.version) return;
        const version = document.version, config = this.config;
        if (kind === 'host' && config.host) {
          // This VS Code command has no cancellation-token argument. Keep one
          // native provider call in flight; superseded waiters never start work.
          if (hostQuery) await hostQuery.catch(() => {});
          if (abort.signal.aborted || active.get(kind) !== job || version !== document.version) return;
          const found = locate(document.getText(), request);
          if (found) {
            const position = document.toNativePosition ? document.toNativePosition(found) : new vscode.Position(found.line, found.character);
            const query = Promise.resolve(vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position, undefined, 8));
            hostQuery = query;let list;
            try {list = await query;} finally {if (hostQuery === query) hostQuery = null;}
            if (abort.signal.aborted || active.get(kind) !== job || version !== document.version) return;
            if (list && Array.isArray(list.items)) {
              const prefix = String(request.prefix || '').slice(0, 512), suffix = String(request.suffix || '').slice(0, 512);
              for (const item of list.items.slice(0, 1000)) {
                const result = candidate(item, {document, position, prefix, suffix});
                if (result && (!prefix || result.label.toLowerCase().includes(prefix.toLowerCase()) || result.text.toLowerCase().startsWith(prefix.toLowerCase()))) response.items.push(result);
                if (response.items.length === 12) break;
              }
              response.isIncomplete = !!list.isIncomplete;
            }
          }
        } else if (kind === 'paths' && config.local) {
          const prefix = String(request.prefix || '').slice(0, 512), query = prefix.slice(1).toLowerCase();
          if (/^[@!]/.test(prefix)) {
            const base = vscode.Uri.joinPath(document.uri, '..');
            if (!pathCache || Date.now() - pathCache.time > 30000 || request.manual) {
              const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri || base;
              const files = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*.{md,markdown,png,jpg,jpeg,gif,webp,svg,avif,bmp}'), '**/{node_modules,.git,dist,build,.venv}/**', 1500, token.token);
              pathCache = {time: Date.now(), files};
            }
            response.items = pathCache.files.filter(uri => uri.toString() !== document.uri.toString())
              .map(uri => ({uri, relative: path.relative(base.fsPath, uri.fsPath)}))
              .filter(({relative}) => relative.toLowerCase().includes(query) && (prefix[0] !== '!' || /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(relative)))
              .sort((a, b) => Number(a.relative.startsWith('..')) - Number(b.relative.startsWith('..')) || a.relative.localeCompare(b.relative))
              .slice(0, 12).map(({relative}) => ({label: relative.replaceAll('\\','/'), detail: prefix[0] === '!' ? '图片路径' : '文件链接',
                text: prefix[0] === '!' ? '![](' + encodePath(relative) + ')' : '[' + path.basename(relative).replace(/[\[\]]/g, '') + '](' + encodePath(relative) + ')',
                before: prefix.length, after: 0, markdown: true, source: 'path'}));
          }
        } else if (kind === 'ai' && config.ai && config.baseUrl && config.model) {
          const {suggestionCache, payloadKey} = await policy;
          aiCache ||= suggestionCache();
          const aiContext = {...(request.aiContext || {...request, kind: request.contextKind}),
            sectionContext:config.sectionContext?(structure ||= new StructureCache(document)).forRequest(document,request):''};
          const cacheKey = config.protocol + config.baseUrl + config.model + payloadKey(aiContext);
          const cached = aiCache.get(cacheKey);
          if (cached !== undefined) {
            if (!disposed && !abort.signal.aborted && active.get(kind) === job && version === document.version) handler.emit('completion-response', {...response, text: cached, cached: true});
            return;
          }
          const wait = 400 - (Date.now() - lastAI);
          if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
          if (abort.signal.aborted || active.get(kind) !== job || version !== document.version) return;
          lastAI = Date.now();
          if (typeof aiContext.before !== 'string' || typeof aiContext.after !== 'string') return;
          const key = await this.getAPIKey(config);
          const known = API_KEY_HOSTS[hostOf(config.baseUrl)];
          if (!key && known) throw new Error('请在“补全 ▾ → API Key”里为 ' + known
            + ' 填一次密钥（密钥按“协议 + 地址”分开保存，换了地址写法就要重填一次；填一次之后不再漂移）。');
          if (abort.signal.aborted || active.get(kind) !== job) return;
          response.text = await requestAI(config, key, aiContext, abort.signal);
          aiCache.set(cacheKey, response.text);
        }
        if (!disposed && !abort.signal.aborted && active.get(kind) === job && version === document.version) handler.emit('completion-response', response);
      } catch (error) {
        if (!disposed && active.get(kind) === job) handler.emit('completion-response', {...response, error: abort.signal.aborted ? '请求已取消或超时。' : kind === 'ai' ? (error.name === 'TypeError' ? '无法连接 AI 服务，请检查地址和网络。' : error.message) : ''});
      } finally {clearTimeout(timer);token.dispose();if (active.get(kind) === job) active.delete(kind);}
    });
    panel.onDidChangeViewState(() => {if (!panel.visible) cancel();});
    panel.onDidDispose(() => {disposed = true;cancel();aiCache?.clear();structure?.dispose();this.controllers.delete(controller);});
    return controller;
  }
}
module.exports = {CompletionManager};
