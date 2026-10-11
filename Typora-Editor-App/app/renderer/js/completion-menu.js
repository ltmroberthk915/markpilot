/** A floating settings menu; opening it never changes toolbar height. */
export function installCompletionMenu(api, config, dismiss) {
  const abort = new AbortController();
  const listen = (target, type, callback, options = {}) => target.addEventListener(type, callback, {...options, signal: abort.signal});
  const tool = document.createElement('div');tool.className = 'vditor-toolbar__item md-completion-tool';
  const trigger = document.createElement('button');trigger.type = 'button';
  trigger.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 3 1.9 5.1L22 10l-5.1 1.9L15 17l-1.9-5.1L8 10l5.1-1.9L15 3Z"/><path d="M3 5h4M3 16h5M3 21h14"/></svg>';
  trigger.title = '补全与 API 设置';trigger.setAttribute('aria-haspopup', 'menu');trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'md-completion-settings');tool.append(trigger);
  const toolbar = api.vditor.element.querySelector('.vditor-toolbar');
  (toolbar?.querySelector('.vditor-toolbar__item')?.parentElement || toolbar)?.prepend(tool);
  // Non-modal dialog gives an open menu its own Escape handling, including
  // when the editor's find panel is open. The document remains interactive.
  const menu = document.createElement('dialog');menu.id = 'md-completion-settings';menu.className = 'md-completion-settings';
  menu.setAttribute('role', 'menu');menu.setAttribute('aria-label', '补全与 API 设置');
  const header = document.createElement('header');
  const title = document.createElement('strong');title.textContent = '补全模型';
  const status = document.createElement('span');status.className = 'md-completion-api-status';header.append(title, status);menu.append(header);
  const profileButtons = new Map();
  const fields = {};
  let renderProfiles = () => {};
  const profiles = document.createElement('div');profiles.className = 'md-completion-profiles';profiles.setAttribute('role', 'group');profiles.setAttribute('aria-label', '一键切换模型');menu.append(profiles);
  // Newly added model presets must appear without reopening the editor, so
  // the group rebuilds whenever the saved profile set changes.
  let renderedIds = '';
  const menuRow = (label, hint, dataset, emit) => {
    const button = document.createElement('button');button.type = 'button';button.dataset[dataset] = '';button.setAttribute('role', 'menuitem');
    const name = document.createElement('span');name.textContent = label;
    const small = document.createElement('small');small.textContent = hint;
    button.append(name, small);listen(button, 'click', () => {close();window.handler.emit(emit);});
    return button;
  };
  const addProfile = menuRow('新增模型…', '协议、地址、模型与密钥', 'completionAddProfile', 'completion-add-profile');
  const importProfile = menuRow('导入配置…', '粘贴 settings.json 或 KEY=VALUE', 'completionImportProfile', 'completion-import-profile');
  // 预设与自建配置都能删：删掉的同时会删该平台已保存的密钥。
  const deleteProfile = menuRow('删除模型配置…', '含该平台已保存的密钥', 'completionDeleteProfile', 'completion-delete-profile');
  const renderProfilesList = value => {
    const list = value.profiles || [], ids = list.map(profile => profile.id).join('\n');
    if (ids === renderedIds && profileButtons.size) return;
    renderedIds = ids;profileButtons.clear();profiles.replaceChildren();
    for (const profile of list) {
      const button = document.createElement('button');button.type = 'button';button.dataset.completionProfile = profile.id;button.setAttribute('role', 'menuitemradio');
      const label = document.createElement('span');label.textContent = profile.label;
      const hint = document.createElement('small');button.append(label, hint);button.title = profile.model;
      listen(button, 'click', () => {close(true);window.handler.emit('completion-select-profile', profile.id);});
      profileButtons.set(profile.id, {button, hint});profiles.append(button);
    }
    profiles.append(addProfile, importProfile, deleteProfile);
  };
  renderProfiles = renderProfilesList;
  renderProfiles(config);
  const profileSeparator = document.createElement('hr');profileSeparator.setAttribute('role', 'separator');menu.append(profileSeparator);
  for (const [field, label] of [['key', '填写 / 更换 API Key'], ['baseUrl', 'API 地址'], ['model', '模型']]) {
    const button = document.createElement('button');button.type = 'button';button.setAttribute('role', 'menuitem');button.dataset.apiField = field;
    const name = document.createElement('span');name.textContent = label;button.append(name);
    const value = document.createElement('small');button.append(value);fields[field] = {button, value};
    listen(button, 'click', () => {close();window.handler.emit('completion-api-field', field);});menu.append(button);
  }
  const separator = document.createElement('hr');separator.setAttribute('role', 'separator');menu.append(separator);
  const toggles = {};
  for (const [field, label] of [['automaticAI', '自动 AI 补全'], ['cursorSuggestions', '光标停顿时建议'], ['sectionContext', '章节上下文'], ['local', '公式、模板和路径补全']]) {
    const button = document.createElement('button');button.type = 'button';button.dataset.completionToggle = field;
    button.setAttribute('role', 'menuitemcheckbox');
    const name = document.createElement('span');name.textContent = label;const value = document.createElement('small');button.append(name, value);
    toggles[field] = {button, value};listen(button, 'click', () => window.handler.emit('completion-toggle', field));menu.append(button);
  }
  const more = document.createElement('button');more.type = 'button';more.dataset.completionSettings = '';more.setAttribute('role', 'menuitem');more.textContent = '补全设置…';
  listen(more, 'click', () => {close();window.handler.emit('completion-settings');});menu.append(more);document.body.append(menu);
  const buttons = () => [...menu.querySelectorAll('button:not(:disabled):not([hidden])')];
  function close(restoreFocus = false) {
    if (!menu.open) return;
    menu.close();trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({preventScroll: true});
  }
  function open() {
    if (menu.open) return;
    dismiss();menu.show();trigger.setAttribute('aria-expanded', 'true');
    const anchor = trigger.getBoundingClientRect(), rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(anchor.left, innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(anchor.bottom + 4, innerHeight - rect.height - 8)) + 'px';
    buttons()[0].focus({preventScroll: true});
  }
  function update(value) {
    renderProfiles(value);
    for (const profile of value.profiles || []) {
      const item = profileButtons.get(profile.id);if (!item) continue;
      const selected = value.activeProfile === profile.id;
      item.button.setAttribute('aria-checked', String(selected));
      item.hint.textContent = profile.keyAvailable ? (selected ? '✓ 当前使用' : '密钥已保存') : '待填写平台密钥';
    }
    const selected = value.profiles?.find(profile => profile.id === value.activeProfile);
    trigger.title = '当前模型：' + (selected?.label || value.model || '未配置') + ' · 补全与 API 设置';
    trigger.setAttribute('aria-label', trigger.title);
    fields.baseUrl.value.textContent = value.baseUrl || '点击填写';fields.baseUrl.button.title = value.baseUrl || '填写 API 地址';
    fields.model.value.textContent = value.model || '点击填写';fields.model.button.title = value.model || '填写模型';
    fields.key.value.textContent = value.keyAvailable ? '当前平台密钥已保存 · 点击更换' : '当前平台未保存密钥 · 点击填写';
    status.textContent = selected && !value.keyAvailable ? '待填写 API Key' : value.ai ? (value.automaticAI ? '自动 AI 已开启' : '手动 AI') : 'AI 未开启';
    for (const [field, toggle] of Object.entries(toggles)) {
      toggle.button.setAttribute('aria-checked', String(value[field]));
      if(field==='sectionContext'){toggle.value.textContent=value.sectionContext?'已开启 · 章节与相关数学定义，合计最多 1200 字符':'已关闭 · 仅使用光标附近内容';continue;}
      toggle.value.textContent = field === 'automaticAI' ? (!value.ai ? '先填写 API Key 并开启 AI' : value.automaticAI ? '已开启 · 数学优先，结合公式两侧和附近正文' : '已关闭 · Alt+\\ 手动请求') : field === 'cursorSuggestions' ? (value.cursorSuggestions ? '已开启 · 点击公式或移动光标后停顿也可触发' : '已关闭 · 仅输入和快捷键触发') : value.local ? '已开启 · 输入 \\、/、@ 或 ! 触发' : '已关闭';
    }
    toggles.automaticAI.button.disabled = !value.ai;
  }
  listen(trigger, 'click', () => menu.open ? close(true) : open());
  listen(trigger, 'keydown', event => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {event.preventDefault();event.stopPropagation();open();if (event.key === 'ArrowUp') buttons().at(-1).focus();}
  });
  listen(menu, 'keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') {event.preventDefault();event.stopPropagation();close(true);}
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();event.stopPropagation();
      const available = buttons(), index = available.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length;
      available[next].focus();
    }
  });
  listen(document, 'pointerdown', event => {if (!menu.contains(event.target) && !tool.contains(event.target)) close();}, {capture: true});
  listen(document, 'focusin', event => {if (!menu.contains(event.target) && !tool.contains(event.target)) close();});
  listen(document, 'scroll', event => {if (!menu.contains(event.target)) close();}, {capture: true});
  listen(window, 'blur', () => close());listen(window, 'resize', () => close());
  update(config);
  return {update, close, destroy() {abort.abort();close();menu.remove();tool.remove();}};
}
