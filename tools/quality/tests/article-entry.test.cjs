'use strict';
/* article-entry.test.cjs — 用户入口契约（AI 润色 + 发布面板）。
 *
 * ⚠️ 本轮契约变更（旧契约已作废，保留其它用例）：
 *   1) **Ctrl+Alt+R 热键已移除** —— 旧测试强制要求注册该快捷键，现在必须断言"没有它"。
 *      AI 润色只保留**右键**入口（仍须先恢复右键那一刻的选区）。
 *   2) **版式写者已移出发布面板** —— 旧测试要求发布面板直接持有
 *      `window.mpArticleEdition.set(next)` 与 `setArticleEdition` 封装；
 *      现在版式/明暗归属于「设置 → 主题与字体」的单选组，
 *      发布面板只显示当前版式明暗的**只读行**。因此改为：
 *        · 发布面板不得再有版式写者；
 *        · 设置里的单选组才是唯一入口（name=mp-edition-kind / mp-edition-variant）。
 *
 * 判据全部落在用户可见行为/真实选择器上。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');
const extrasSource = fs.readFileSync(path.join(ROOT, 'dsh-markpilot/src-cm6/extras.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(ROOT, 'dsh-markpilot/src-cm6/main.js'), 'utf8');

/** 去掉注释（判据只看代码；注释里出现同样的字串会造成假绿）。 */
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('right-click menu offers AI rewrite and restores the pre-click selection first', () => {
  const bodyMenu = strip(extrasSource.slice(
    extrasSource.indexOf('  function bodyMenu(event, pos) {'),
    extrasSource.indexOf('  function tableMenu(anchorEvent, tableFrom) {'),
  ));
  assert.ok(bodyMenu.includes('AI 润色选区…'), '右键菜单必须有「AI 润色选区…」');
  const entryAt = bodyMenu.indexOf('AI 润色选区…');
  const restoreAt = bodyMenu.lastIndexOf('v.dispatch({ selection: savedSel', entryAt);
  const openAt = bodyMenu.indexOf('openAiRewrite()', entryAt);
  assert.ok(restoreAt > 0, '必须以右键那一刻的选区为准（恢复 savedSel）');
  assert.ok(openAt > 0, '右键项必须调共享实现 openAiRewrite()');
  assert.ok(restoreAt < openAt, '恢复选区必须发生在发起润色之前（内核按 live selection 取目标）');
  /* 共享实现本身只调内核 open()，且集中在 installExtras 里（三处入口同一个函数）。 */
  const impl = strip(extrasSource.slice(
    extrasSource.indexOf('  function openAiRewrite()'),
    extrasSource.indexOf('  function runFootnote()'),
  ));
  assert.ok(/window\.mpSelectionRewrite/.test(impl), '实现必须接现成的 mpSelectionRewrite');
  assert.ok(/api\.open\(\)/.test(impl), '实现里调用内核 open()');
  assert.ok(/AI 润色内核未就绪/.test(impl), '内核缺席要如实提示，不静默');
  assert.ok(/return api\.open\(\)/.test(impl), '把内核返回值（含 no-selection）原样交回调用方');
  /* 未选中的提示由内核给（不重复 toast），这里只要求入口把返回值交出去。 */
  assert.ok(!/请先选中要润色的文字/.test(impl), '未选提示只有内核一处，避免双 toast');
});

test('the More menu no longer offers AI rewrite (right-click only)', () => {
  const more = strip(extrasSource.slice(
    extrasSource.indexOf('  function openMore('),
    extrasSource.indexOf('  function openImageActions('),
  ));
  /* 【新契约】用户要求：AI 润色**只保留有效选区右键**入口，更多菜单里不再提供该项。 */
  assert.ok(!more.includes('AI 润色选区…'),
    '更多菜单不得再出现「AI 润色选区…」（只保留有效选区右键入口）');
  assert.ok(!/openAiRewrite\(\)/.test(more),
    '更多菜单不得再调 openAiRewrite()');
  assert.ok(!/data-mp-menu=["']ai-rewrite["']|'ai-rewrite'/.test(more),
    '更多菜单不得再有 ai-rewrite 稳定 id');
  /* 菜单本身仍须存在（其它项照旧），并保持两条分隔线的定稿。 */
  assert.ok(/el\.dataset\.mpMenu = id/.test(more), '菜单项写入 data-mp-menu（探针按 id 定位，不按文案）');
  assert.ok(/add\('编辑器设置…'/.test(more), '更多菜单仍提供「编辑器设置…」（设置入口不能被误删）');
  assert.ok(/add\('发布预览与复制…'/.test(more), '更多菜单仍提供发布入口');
  assert.equal((more.match(/sep\(\);/g) || []).length, 2, '保持两条分隔线');
});

test('the Ctrl+Alt+R keyboard shortcut is gone (registration actually removed)', () => {
  /* 【新契约】旧测试曾强制要求：AI_REWRITE_KEY = 'Mod-Alt-r'、处理器 return true、
     aiRewriteKeys 挂进 extension 数组。现在这些都必须**真的不存在**。
     ⚠️ 说明性注释（"原本由 aiRewriteKeys 挂进 keymap"）里仍会出现这些词，
        所以判据一律在 **strip(注释) 之后**的代码上做，不能因为注释提到就报绿/报红。 */
  const code = strip(extrasSource);
  assert.ok(!/const AI_REWRITE_KEY/.test(code), '不得再声明 AI_REWRITE_KEY 常量');
  assert.ok(!/function aiRewriteFromKeyboard/.test(code), '不得再有 aiRewriteFromKeyboard 处理器');
  assert.ok(!/\baiRewriteKeys\b/.test(code), '不得再在代码里使用 aiRewriteKeys 标识符');
  assert.ok(!/Mod-Alt-r/.test(code), '代码里不应再出现 Mod-Alt-r（避免又被某个 keymap 捡起来）');
  /* 具体注册点：keymap.of 与 extension 数组里都不许再有它 */
  const keymapBlocks = code.match(/keymap\.of\(\[[\s\S]*?\]\)/g) || [];
  assert.ok(keymapBlocks.every((blk) => !/aiRewrite|Mod-Alt-r/.test(blk)),
    '任何 keymap.of([...]) 里都不得再注册 AI 润色键');
  const extAt = code.indexOf('extension: [');
  if (extAt >= 0) {
    const extBlock = code.slice(extAt, extAt + 400);
    assert.ok(!/aiRewriteKeys/.test(extBlock), 'extension 数组里不得再挂 aiRewriteKeys');
  }
  /* 功能本身没被删：内核仍登记、右键入口仍存在 */
  assert.ok(/window\.mpSelectionRewrite/.test(extrasSource), '润色内核仍登记');
  assert.ok(/AI 润色选区…/.test(extrasSource), '右键菜单入口仍存在');
  assert.ok(/openAiRewrite/.test(extrasSource), '共享实现 openAiRewrite 仍存在（供右键调用）');
});

test('the engine installs the rewrite kernel and exposes it for menus', () => {
  assert.ok(/import \{ installSelectionRewrite \} from '\.\/selection-rewrite\.js'/.test(mainSource),
    'main.js 必须导入内核（任务书约定路径）');
  const install = strip(mainSource.slice(mainSource.indexOf('installSelectionRewrite({')));
  assert.ok(/getView: \(\) => view/.test(install), '安装环境传 getView');
  assert.ok(/toast: extras\.toast/.test(install), '安装环境传 toast（同一个提示通道）');
  assert.ok(/window\.mpSelectionRewrite = rewrite/.test(install), '登记为 window.mpSelectionRewrite 供菜单调用');
});

test('publish panel is reachable from both the export dialog and the More menu', () => {
  assert.ok(/row\('publish', '发布预览与复制…'/.test(extrasSource), '导出面板里有发布入口');
  assert.ok(/else if \(k === 'publish'\) openPublishPanel\('wechat'\)/.test(extrasSource), '点它打开同一个面板');
  const more = strip(extrasSource.slice(
    extrasSource.indexOf('  function openMore('),
    extrasSource.indexOf('  function openImageActions('),
  ));
  assert.ok(more.includes('发布预览与复制…'), '更多菜单也有发布入口');
  assert.ok(/openPublishPanel\('wechat'\)/.test(more), '两个入口指向同一个函数');
  assert.ok(/case 'publish-panel': openPublishPanel/.test(extrasSource), '外部命令路由保留');
});

test('edition selection lives in settings radios; publish panel is read-only; external API kept', () => {
  const panel = strip(extrasSource.slice(
    extrasSource.indexOf('  const PUBLISH_WIDTHS = ['),
    extrasSource.indexOf('  async function openWechatDraftDialog('),
  ));

  /* ① 发布面板**不得**写版式（写者已迁到设置 → 主题与字体） */
  assert.ok(!/window\.mpArticleEdition\.set\(next\)/.test(panel),
    '发布面板不得再直接调用版式写者（已移到设置 → 主题与字体）');
  assert.ok(!/applyArticleEdition\(/.test(panel),
    '发布面板不得自己贴根属性（TypeScript noResolve 抓到过未导入）');

  /* ② 发布面板只保留当前版式/明暗的**只读行**
        实际 selector：<p class="k" data-pub="editionBrief"> */
  assert.ok(/data-pub="editionBrief"/.test(panel),
    '发布面板应有当前版式/明暗的只读显示（data-pub="editionBrief"）');

  /* ③ 设置里的单选组是唯一入口，且**通过实际 mpArticleEdition.set 提交** */
  assert.ok(/name="mp-edition-kind"/.test(extrasSource), '设置里必须有 mp-edition-kind 单选组');
  assert.ok(/name="mp-edition-variant"/.test(extrasSource), '设置里必须有 mp-edition-variant 单选组');
  assert.ok(/applyEdition\(/.test(extrasSource), '单选组变更必须走 applyEdition()');
  const applyBlock = strip(extrasSource.slice(
    extrasSource.indexOf('const applyEdition = (patch) => {'),
    extrasSource.indexOf('syncEditionRadios();', extrasSource.indexOf('const applyEdition = (patch) => {')),
  ));
  assert.ok(/api && typeof api\.set === 'function'/.test(applyBlock),
    'applyEdition 必须检查宿主写者是否存在');
  assert.ok(/api\.set\(next\)/.test(applyBlock),
    'applyEdition 必须调用 mpArticleEdition.set(next)（唯一写者）');
  assert.ok(/localStorage\.setItem\(EDITION_STORAGE_KEY/.test(applyBlock),
    '仅在 API 真缺失时才降级写存储键（降级必须在 else 分支）');

  /* ④ 外部兼容 API 不受影响：mpExtras.setArticleEdition 仍存在且仍委托同一写者 */
  const compat = strip(extrasSource.slice(
    extrasSource.indexOf('    setArticleEdition: (edition) => {'),
  )).slice(0, 400);
  assert.ok(/setArticleEdition: \(edition\) =>/.test(extrasSource),
    'mpExtras.setArticleEdition 兼容外部调用者，不得因迁移控件而删除');
  assert.ok(/window\.mpArticleEdition\.set\(next\)/.test(compat),
    'setArticleEdition 必须仍委托宿主唯一写者（外部调用者行为不变）');
  assert.ok(/currentArticleEdition/.test(extrasSource),
    'currentArticleEdition 读取入口也应保留');

  /* ⑥ plain（默认宋韵）不投影纸面 ⇒ 隐藏「明暗」整组；切回书页/研报恢复三选 */
  assert.ok(/data-edition-variant-fieldset/.test(extrasSource),
    '「明暗」fieldset 需有稳定标记，供初始生成与 onchange 同步控制显隐');
  assert.ok(/editNow\.kind === 'plain'/.test(extrasSource),
    '初始生成必须按当前 kind 判断是否隐藏明暗组');
  const syncBlock = strip(extrasSource.slice(
    extrasSource.indexOf('const syncEditionRadios = () => {'),
    extrasSource.indexOf('const applyEdition = (patch) => {'),
  ));
  assert.ok(/data-edition-variant-fieldset/.test(syncBlock),
    'onchange/回显同步必须重新读该 fieldset');
  assert.ok(/e\.kind === 'plain' \? 'none' : ''/.test(syncBlock),
    '同步里 plain → none，书页/研报 → 恢复显示（三选回来）');
  /* 已存 variant 不被清除：applyEdition 只改传入的字段 */
  assert.ok(/patch\.variant !== undefined \? patch\.variant : cur\.variant/.test(applyBlock),
    '切到 plain 不得清掉已存 variant（只改 kind，保留 variant 给下次切回）');

  /* ⑦ plain 的发布只读行取**实际界面明暗**，不借用存储的 article variant */
  const briefBlock = strip(extrasSource.slice(
    extrasSource.indexOf('const brief = q(\'[data-pub="editionBrief"]\')'),
    extrasSource.indexOf("d.querySelectorAll('[data-pub-target]')"),
  ));
  assert.ok(/curEdition\.kind === 'plain'/.test(briefBlock),
    '只读行必须对 plain 单独分支（不能沿用存储的 variant 文案）');
  assert.ok(/interfaceIsDark\(document\)/.test(briefBlock),
    'plain 必须取实际界面明暗（interfaceIsDark，与 mpArticleEdition.isDark() 同源）');
  /* 旧长文案只在**去掉注释的 briefBlock**上判：源码注释里会引用这句历史文案，
     搜整个 extrasSource 会把注释命中当成失败。 */
  assert.ok(!/设置 →「编辑器设置 › 主题与字体」/.test(briefBlock),
    '冗长的『设置 →「编辑器设置 › 主题与字体」』应已简化（只看 briefBlock）');
  assert.ok(/编辑器设置 › 主题与字体/.test(briefBlock),
    '简化后的文案应为『编辑器设置 › 主题与字体』');

  /* ⑤ 「主题与字体」页签的稳定选择器由**模板动态生成**，源码里没有字面
        `mp-settings-tab-theme`。实际生成方式（extras.js:3674）：
          sections.map(([id,label]) => `... id="mp-settings-tab-${id}"
                                          data-settings-tab="${id}" ...`)
        且 sections 里含 ['theme', '主题与字体', ...]。
        所以判据是：模板里同时有这两个**带 ${id} 的前缀**，且 sections 里确有 theme 项。 */
  const hasTabTemplate = /id="mp-settings-tab-\$\{id\}"/.test(extrasSource)
    && /data-settings-tab="\$\{id\}"/.test(extrasSource);
  assert.ok(hasTabTemplate,
    '设置 dialog 的页签必须由模板生成 id="mp-settings-tab-${id}" 与 data-settings-tab="${id}"');
  assert.ok(/\[\s*'theme'\s*,\s*'主题与字体'/.test(extrasSource),
    'sections 里必须有 theme 分区（生成 #mp-settings-tab-theme 的前提）');
  /* 兜底：也接受直接写字面量的实现（若日后改成硬编码，同样算通过） */
  assert.ok(hasTabTemplate || /mp-settings-tab-theme/.test(extrasSource),
    '「主题与字体」页签要有可定位的稳定选择器（模板动态生成或字面量）');
});
