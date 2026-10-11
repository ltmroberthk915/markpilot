'use strict';
const {createHash} = require('node:crypto');
const {endpoint} = require('./core.cjs');
// 不再内置任何“特定模型”。以前这里是 4 个写死的服务商+模型（glm-5.3-flash、
// deepseek-v4-pro…）：用户既不能改也不能删，模型名与实际账号对不上时只会 404
// （用户实测）。现在配置完全由用户自己加，也可以自己删；下面这些只是“新增模型”
// 里的一键模板，只预填协议与地址，模型名由用户自己写。
const PROVIDER_TEMPLATES = Object.freeze([
  {label: 'Anthropic 兼容（Claude Code / cc-switch 写法）', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic'},
  {label: '智谱 GLM（Anthropic 兼容）', protocol: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic'},
  {label: 'OpenAI 兼容（Chat Completions）', protocol: 'chat-completions', baseUrl: 'https://api.deepseek.com'},
].map(Object.freeze));
// A credential belongs to a normalized endpoint and protocol, never a model.
// 所以“只改模型名”不会换密钥槽。用户实测的“改模型名就像把密码清空了”是两个原因：
// 地址写法一变端点字符串就变（密钥槽跟着漂移），以及切到别的平台本来就没有密钥；
// 现在地址先归一化（见 core.endpoint 的 KNOWN_HOSTS），切换也会明说。
function credentialId(config) {
  // 还没配地址时（默认状态、或删光了所有配置）不能抛：host 的 refreshCredentials
  // 会把当前配置也过一遍，抛出去整条补全链路都会炸（新默认值是空地址才暴露出来）。
  const identity = (() => {
    try {return config.protocol + '|' + endpoint(config.baseUrl, config.protocol);} catch {return 'unconfigured';}
  })();
  return 'completion.apiKey.v2.' + createHash('sha256').update(identity).digest('hex');
}
// 用户自己的模型配置（可增可删）。
function allProfiles(config) {
  return Array.isArray(config?.profiles) ? config.profiles : [];
}
function profileFor(config) {
  try {return allProfiles(config).find(profile => profile.model === config.model && credentialId(profile) === credentialId(config));}
  catch {return undefined;}
}
// 用户配置里的模型就是最终模型。保留这个函数名是为了不再散落“按预设覆盖模型”的分支。
function effectiveModel(config, profile) {
  return profile?.model || config?.model || '';
}
// Stable id for a user-added provider: same name+protocol+endpoint updates the
// existing entry instead of duplicating it.
function customProfileId(label, protocol, baseUrl) {
  return 'custom-' + createHash('sha256').update(label + '|' + protocol + '|' + endpoint(baseUrl, protocol)).digest('hex').slice(0, 10);
}
module.exports = {PROVIDER_TEMPLATES, credentialId, profileFor, allProfiles, effectiveModel, customProfileId};
