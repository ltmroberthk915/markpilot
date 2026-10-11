// 外壳逻辑：侧边栏文件树（懒加载/内联新建重命名/右键菜单）、欢迎页、拖放、编辑器 iframe 装载
(() => {
  const api = window.hostApi;
  const $ = (s) => document.querySelector(s);

  // 鼠标侧键（X1/X2 = 浏览器后退/前进）。主进程已用 app-command 吞掉这个命令，
  // 这里再兜一层：侧键落在侧边栏/工具栏（即外壳文档自己）上时也拦掉，中键(1)
  // 和右键(2) 照旧放行。
  for (const type of ['mousedown', 'auxclick']) {
    document.addEventListener(type, (event) => {
      if (event.button < 3) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
  }

  // ---------- 状态 ----------
  let wsRoot = null;
  let currentFile = null;
  let mdOnly = false;
  let expanded = {};                 // dirPath -> true
  const treeCache = new Map();       // dirPath -> entries[]
  let selected = null;
  let pendingCreate = null;          // { parentDir, isDir }
  let renamingPath = null;
  let expandedSaveTimer = null;
  let recentFolders = [];
  let recentFiles = [];

  // ---------- 图标 ----------
  const svg = (inner) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round">${inner}</svg>`;
  const I = {
    dir: svg('<path d="M1.5 4.2c0-.7.6-1.2 1.2-1.2h2.9l1.5 1.8h6.2c.7 0 1.2.6 1.2 1.2v6.8c0 .7-.6 1.2-1.2 1.2H2.7c-.7 0-1.2-.6-1.2-1.2z"/>'),
    file: svg('<path d="M3.5 1.5h5.2l3.3 3.3v9.7h-8.5z"/><path d="M8.7 1.5v3.3h3.3"/>'),
    md: svg('<path d="M2.2 3h11.6v10H2.2z"/><path d="M4.5 10V6.5L6.3 8.7 8.1 6.5V10"/><path d="M10 6.5V10M10 10l1.5-1.6M10 10 8.5 8.4"/>'),
    newMd: svg('<path d="M8.5 1.5H3.5v13h9V5.5z"/><path d="M8.5 1.5v4h4"/><path d="M8 9v4M6 11h4"/>'),
    newDir: svg('<path d="M1.5 4.2c0-.7.6-1.2 1.2-1.2h2.9l1.5 1.8h6.2c.7 0 1.2.6 1.2 1.2v6.8c0 .7-.6 1.2-1.2 1.2H2.7c-.7 0-1.2-.6-1.2-1.2z"/><path d="M8 7v4M6 9h4"/>'),
    refresh: svg('<path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8"/><path d="M13.4 1.8v3h-3"/>'),
    expand: svg('<path d="M6.5 5.5 3 8l3.5 2.5M9.5 5.5 13 8l-3.5 2.5"/>'),
    collapse: svg('<path d="M3.5 8 7 5.5v5zM12.5 8 9 5.5v5z"/>'),
  };
  $('#btn-new-md').innerHTML = I.newMd;
  $('#btn-new-dir').innerHTML = I.newDir;
  $('#btn-refresh').innerHTML = I.refresh;
  $('#btn-expand').innerHTML = I.expand;
  $('#btn-collapse').innerHTML = I.collapse;

  // ---------- 主进程推送（先注册再 boot，避免错过 doc-load） ----------
  api.onPush('doc-load', ({ url, file }) => {
    currentFile = file;
    // MW6：文档一切换，先把状态栏上**上一份**文档的残影清掉（旧字数/旧保存横幅）。
    // 新文档的统计由主进程在 doc-load 同刻推来（doc.pushStats）；这里清一次是保证
    // 在那次推送到达之前的一瞬也不显示旧文档的数——数据安全提示尤其不能串台。
    resetStatusbar();
    const f = $('#editor');
    // 曾经试过"先把外壳画出来、两帧之后再装 iframe"（以为 iframe 解析 4MB 脚本会把外壳首帧
    // 压后）。2.0.18 安装版实测否掉了这个假设：窗口可见时间 496/497ms 与改动前 488/504/502ms
    // 没有差别（外壳首帧的瓶颈是渲染进程启动，不是 iframe），而内容进 DOM 被推迟了约 60ms。
    // 所以这里保持"拿到 URL 就立刻装"。
    f.src = url;
    f.style.display = '';
    $('#welcome').style.display = 'none';
    markActive();
    refreshRecent();
  });
  api.onPush('ws-open', ({ root }) => setWorkspace(root, { reveal: true }));
  api.onPush('tree-changed', () => refreshTree());
  api.onPush('sidebar-toggle', () => toggleSidebar());
  api.onPush('recent-open', () => openRecentDialog());
  api.onPush('editor-theme', theme => {document.documentElement.dataset.editorTheme=theme;});
  api.onPush('recent-changed', data => renderRecent(data.recentFolders, data.recentFiles));
  api.onPush('shortcut-settings', async () => {
    const {showShortcutSettings} = await import('/render/js/edit-shortcuts.js');
    showShortcutSettings({shortcuts: await api.invoke('shortcuts-get'), onSave: value => api.invoke('shortcuts-set', value)});
  });
  api.onPush('ed-relay', (payload) => {
    const f = $('#editor');
    if (f && f.contentWindow) f.contentWindow.postMessage(payload, '*');
  });

  // ---------- 状态栏（字符统计 / 保存状态） ----------
  /** 保存类失败的常驻提示。以前只把文案塞进 #st-save 的 title——**要悬浮才看得到**，界面上
   *  只剩一个"●"小圆点，用户根本不知道文件没存进去。数据安全问题不能靠悬浮提示。
   *  这条**不自动消失**（对比 #sb-error 的 8 秒），用户明确关掉之后同一条不再自动弹回来。 */
  let saveProblemDismissed = '';
  function showSaveProblem(message) {
    const box = $('#sb-save'), text = $('#sb-save-text');
    if (!box) { if (message) console.error(message); return; }
    if (!message) { box.hidden = true; saveProblemDismissed = ''; if (text) text.textContent = ''; return; }
    if (text && text.textContent !== message) { text.textContent = message; saveProblemDismissed = ''; }
    if (saveProblemDismissed === message) return;
    box.hidden = false;
  }
  function dismissSaveProblem() {
    const box = $('#sb-save'), text = $('#sb-save-text');
    saveProblemDismissed = text ? text.textContent : '';
    if (box) box.hidden = true;
  }
  api.onPush('shell-push', ({ type, payload }) => {
    if (type !== 'doc-stats' || !payload) return;
    const bar = $('#statusbar');
    bar.style.display = '';
    const problem = payload.saveError || (payload.snapshotError && ('本地快照失败：' + payload.snapshotError)) || '';
    $('#st-save').textContent = payload.saveError ? '● 保存失败' : payload.dirty ? '● 未保存' : '已保存';
    $('#st-save').title = problem;
    $('#st-save').classList.toggle('dirty', !!payload.dirty);
    $('#st-save').classList.toggle('problem', !!problem);
    showSaveProblem(problem);
    $('#st-words').textContent = `字数 ${fmt(payload.words)}`;
    $('#st-chars').textContent = `字符 ${fmt(payload.chars)}`;
    $('#st-lines').textContent = `行 ${fmt(payload.lines)}`;
    const mins = Math.max(1, Math.round(payload.words / 400));
    $('#st-read').textContent = mins >= 60 ? `约 ${Math.floor(mins / 60)} 时 ${mins % 60} 分` : `约 ${mins} 分钟`;
  });
  function fmt(n) { return Number(n || 0).toLocaleString('zh-CN'); }
  /** MW6：文档切换时把状态栏复位（统计占位、保存横幅隐藏）。只清显示，不猜新值——
   *  新文档的真实统计紧随 doc-load 由主进程推来，避免旧文档的数字/横幅多亮一拍。 */
  function resetStatusbar() {
    const save = $('#st-save');
    if (save) { save.textContent = ''; save.title = ''; save.classList.remove('dirty', 'problem'); }
    showSaveProblem('');
    for (const id of ['st-words', 'st-chars', 'st-lines', 'st-read']) {
      const el = document.getElementById(id);
      if (el) el.textContent = '';
    }
  }
  // 侧栏收起时提示条会被一起藏起来，所以状态栏那格也要能把原因叫回来。
  $('#st-save').addEventListener('click', () => {
    const problem = $('#st-save').title;
    if (!problem) return;
    saveProblemDismissed = '';
    showSaveProblem(problem);
  });
  $('#sb-save-close').addEventListener('click', dismissSaveProblem);

  // ---------- 状态栏左下角固定的面板开关（仅桌面 EXE 外壳；共享渲染代码不参与） ----------
  $('#st-files').addEventListener('click', toggleSidebar);
  $('#st-outline').addEventListener('click', () => {
    const f = $('#editor');
    if (!f || f.style.display === 'none' || !f.contentWindow) return;
    // 与点击编辑器工具栏“展开大纲”完全同一条路径，桌面外壳直接驱动。
    f.contentWindow.vditor?.vditor?.toolbar?.elements?.outline?.querySelector('button')?.click();
  });

  // ---------- 启动 ----------
  (async function boot() {
    const s = await api.invoke('boot');
    if(s.editorTheme)document.documentElement.dataset.editorTheme=s.editorTheme;
    expanded = s.expanded || {};
    applySidebarPrefs(s.sidebar || {});
    if (s.ws) setWorkspace(s.ws);
    renderRecent(s.recentFolders || [], s.recentFiles || []);
    if (!s.file && s.ws) $('#w-hint-ws').style.display = '';
  })().catch((e) => console.error('boot failed:', e));

  function applySidebarPrefs(p) {
    mdOnly = !!p.mdOnly;
    document.documentElement.style.setProperty('--sb-width', (p.width || 240) + 'px');
    $('#btn-mdonly').classList.toggle('on', mdOnly);
    if (p.visible === false) $('#app').classList.add('sb-hidden');
  }

  // ---------- 工作区 ----------
  /** reveal=true 表示"用户刚刚自己选了一个文件夹"（ws-open 推送）。
   *
   *  用户的日常操作在这里曾经完全没有反馈：侧栏被收起来过（这是持久化偏好，一次 Ctrl+Alt+B
   *  就会一直收着）时，点「打开文件夹」= 文件树长在一个隐藏的侧栏里，屏幕上没有任何变化；
   *  侧栏可见时，欢迎页也是一字不变、连"已打开工作区，从左侧文件树选择"的提示都不出现
   *  （那句提示以前只在**启动时**会话里就带工作区的情况下才显示）。于是用户报"打开文件夹是坏的"。
   *  现在的规则：用户主动打开的文件夹 → 侧栏必须露出来 + 欢迎页补上提示；
   *  启动时恢复的偏好照旧尊重（不因为恢复了一个工作区就把用户收起来的侧栏弹开）。 */
  function setWorkspace(root, { reveal = false } = {}) {
    wsRoot = root;
    treeCache.clear();
    $('#ws-name').textContent = baseName(root);
    $('#ws-name').title = root;
    $('#sb-empty').style.display = 'none';
    if (!expanded[root]) { expanded = { [root]: true }; persistExpanded(); }
    if (reveal) {
      if ($('#app').classList.contains('sb-hidden')) {
        $('#app').classList.remove('sb-hidden');
        api.invoke('sidebar-set', { visible: true });
      }
      const welcome = $('#welcome');
      if (welcome && welcome.style.display !== 'none') $('#w-hint-ws').style.display = '';
    }
    renderTree();
  }

  async function refreshTree() {
    if (!wsRoot) return;
    treeCache.clear();
    renderTree();
  }

  function baseName(p) {
    const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }

  // ---------- 文件树渲染 ----------
  async function renderTree() {
    const tree = $('#tree');
    const scrollTop = tree.scrollTop;
    if (!wsRoot) { tree.innerHTML = ''; return; }
    const frag = document.createDocumentFragment();
    await appendDir(frag, wsRoot, 0);
    tree.innerHTML = '';
    tree.appendChild(frag);
    tree.scrollTop = scrollTop;
    markActive();
  }

  async function appendDir(frag, dir, depth) {
    frag.appendChild(rowEl(dir, baseName(dir), depth, { isDir: true, isRoot: true }));
    if (!expanded[dir]) return;
    let entries = treeCache.get(dir);
    if (!entries) {
      entries = (await api.invoke('tree-list', { dir })).entries;
      treeCache.set(dir, entries);
    }
    const kids = document.createDocumentFragment();
    for (const ent of entries) {
      if (!ent.isDir && mdOnly && !ent.isMd) continue;
      if (ent.isDir) await appendDir(kids, ent.path, depth + 1);
      else kids.appendChild(rowEl(ent.path, ent.name, depth + 1, { isDir: false, isMd: ent.isMd }));
    }
    if (pendingCreate && pendingCreate.parentDir === dir) {
      kids.appendChild(createInputRow(depth + 1));
    }
    frag.appendChild(kids);
  }

  function rowEl(path, name, depth, { isDir, isMd, isRoot }) {
    const row = document.createElement('div');
    row.className = 'row' + (expanded[path] ? ' expanded' : '');
    row.dataset.path = path;
    row.dataset.isDir = isDir ? '1' : '';
    row.dataset.isMd = isMd ? '1' : '';
    const tw = isDir ? '<span class="tw">▶</span>' : '<span class="tw"></span>';
    const ic = isDir ? `<span class="icon ic-dir">${I.dir}</span>`
      : isMd ? `<span class="icon ic-md">${I.md}</span>`
        : `<span class="icon ic-file">${I.file}</span>`;
    row.style.paddingLeft = (depth * 14 + 4) + 'px';
    row.innerHTML = `${tw}${ic}<span class="name">${escapeHtml(name)}</span>`;
    if (renamingPath === path) {
      const nameEl = row.querySelector('.name');
      nameEl.innerHTML = '';
      nameEl.appendChild(renameInput(path, name));
    }
    return row;
  }

  /** 内联输入框（新建 / F2 重命名）必须**等它真的挂到文档上**再 focus()。
   *  renderTree 是"先在 DocumentFragment 里拼好、最后才 tree.appendChild(frag)"（中间还夹着
   *  tree-list 的 IPC await），所以原先在 queueMicrotask 里 focus() 时输入框还在游离态——
   *  focus 静默失效（实测 document.activeElement 一直停在工具栏按钮上，选中的"未命名"三个字
   *  用户打不进去：直接敲键盘字全丢，先点一下输入框则光标落到末尾、文件名被接长成
   *  "未命名.md我的笔记.md"）。这里改成挂上去之后再聚焦，最多试 20 次（约 160ms）。 */
  function focusWhenAttached(input) {
    let tries = 0;
    const attempt = () => {
      if (!input.isConnected) { if (++tries < 20) setTimeout(attempt, 8); return; }
      input.focus();
      const dot = input.value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    };
    attempt();
  }

  function createInputRow(depth) {
    const row = document.createElement('div');
    row.className = 'row creating';
    row.style.paddingLeft = (depth * 14 + 4) + 'px';
    row.innerHTML = '<span class="tw"></span>' +
      `<span class="icon ${pendingCreate.isDir ? 'ic-dir' : 'ic-md'}">${pendingCreate.isDir ? I.dir : I.md}</span>` +
      '<span class="name"></span>';
    const input = document.createElement('input');
    input.value = pendingCreate.isDir ? '新文件夹' : '未命名.md';
    row.querySelector('.name').appendChild(input);
    focusWhenAttached(input);
    wireInlineInput(input, {
      onCommit: async (val) => {
        const { parentDir, isDir } = pendingCreate;
        pendingCreate = null;
        try {
          const { path: created } = await api.invoke('tree-create', { parentDir, name: val, isDir });
          treeCache.delete(parentDir);
          await renderTree();
          if (!isDir) api.invoke('open-file', { path: created });
        } catch (e) { showTreeError('新建失败：' + e.message); await renderTree(); }
      },
      onCancel: () => { pendingCreate = null; renderTree(); },
    });
    return row;
  }

  function renameInput(path, oldName) {
    const input = document.createElement('input');
    input.value = oldName;
    focusWhenAttached(input);   // 同上：重命名框也是挂在游离片段里的
    wireInlineInput(input, {
      onCommit: async (val) => {
        const from = path;
        renamingPath = null;
        if (val === oldName) { renderTree(); return; }
        try {
          const { path: to } = await api.invoke('tree-rename', { from, name: val });
          // 展开状态与缓存按新路径迁移
          const newExpanded = {};
          for (const k of Object.keys(expanded)) {
            newExpanded[k === from ? to : k.startsWith(from + '\\') || k.startsWith(from + '/') ? to + k.slice(from.length) : k] = expanded[k];
          }
          expanded = newExpanded;
          persistExpanded();
          for (const k of [...treeCache.keys()]) {
            if (k === from || k.startsWith(from + '\\') || k.startsWith(from + '/')) treeCache.delete(k);
          }
          treeCache.delete(to.split(/[\\/]/).slice(0, -1).join('\\'));
        } catch (e) { showTreeError('重命名失败：' + e.message); }
        await renderTree();
      },
      onCancel: () => { renamingPath = null; renderTree(); },
    });
    return input;
  }

  function wireInlineInput(input, { onCommit, onCancel }) {
    let done = false;
    const finish = (fn, arg) => { if (done) return; done = true; fn(arg); };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(onCommit, input.value.trim());
      else if (e.key === 'Escape') finish(onCancel);
    });
    input.addEventListener('blur', () => finish(onCommit, input.value.trim()));
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('contextmenu', (e) => e.stopPropagation());
  }

  function markActive() {
    document.querySelectorAll('.row.active').forEach((r) => r.classList.remove('active'));
    if (!currentFile) return;
    const row = document.querySelector(`.row[data-path="${cssEscape(currentFile)}"]`);
    if (row) row.classList.add('active');
  }
  function markSelected(path) {
    document.querySelectorAll('.row.selected').forEach((r) => r.classList.remove('selected'));
    if (path) {
      const row = document.querySelector(`.row[data-path="${cssEscape(path)}"]`);
      if (row) { row.classList.add('selected'); selected = path; return; }
    }
    selected = path;
  }
  function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'); }
  function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---------- 树事件（委托） ----------
  const tree = $('#tree');
  tree.addEventListener('click', async (e) => {
    const row = e.target.closest('.row');
    if (!row || row.classList.contains('creating')) return;
    const path = row.dataset.path;
    markSelected(path);
    if (row.dataset.isDir) {
      expanded[path] = !expanded[path];
      if (!expanded[path]) {
        for (const k of Object.keys(expanded)) {
          if (k.startsWith(path + '\\') || k.startsWith(path + '/')) delete expanded[k];
        }
      }
      persistExpanded();
      renderTree();
    } else if (row.dataset.isMd) {
      const r = await api.invoke('open-file', { path });
      if (r && r.ok) renderTree(); // 确认框可能取消，刷新高亮
    }
  });
  tree.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (!row || row.dataset.isDir) return;
    if (!row.dataset.isMd) api.invoke('open-system', { path: row.dataset.path });
  });
  tree.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row');
    if (!row || row.classList.contains('creating')) { hideMenu(); return; }
    e.preventDefault();
    markSelected(row.dataset.path);
    showMenuFor(row, e.clientX, e.clientY);
  });
  tree.addEventListener('keydown', (e) => {
    if (!selected) return;
    if (e.key === 'Delete') { e.preventDefault(); doDelete(selected); }
    else if (e.key === 'F2') { e.preventDefault(); startRename(selected); }
  });

  // ---------- 右键菜单 ----------
  const menu = $('#ctxmenu');
  function hideMenu() { menu.style.display = 'none'; menu.innerHTML = ''; }
  function showMenuFor(row, x, y) {
    const isDir = !!row.dataset.isDir;
    const isMd = !!row.dataset.isMd;
    const path = row.dataset.path;
    const items = [];
    if (isDir) {
      items.push({ label: '新建 Markdown 文件', fn: () => startCreate(path, false) });
      items.push({ label: '新建文件夹', fn: () => startCreate(path, true) });
      items.push({ sep: true });
      items.push({ label: '在此处打开资源管理器', fn: () => api.invoke('tree-reveal', { path }) });
    } else {
      if (isMd) items.push({ label: '打开', fn: () => api.invoke('open-file', { path }) });
      items.push({ label: '用系统程序打开', fn: () => api.invoke('open-system', { path }) });
      items.push({ sep: true });
    }
    items.push({ label: '重命名（F2）', fn: () => startRename(path) });
    items.push({ label: '删除（回收站）', danger: true, fn: () => doDelete(path) });
    items.push({ sep: true });
    items.push({ label: isDir ? '在资源管理器中显示' : '打开文件所在文件夹', fn: () => api.invoke('tree-reveal', { path }) });
    items.push({ label: '复制绝对路径', fn: () => api.invoke('tree-copy', { path }) });

    menu.innerHTML = '';
    for (const it of items) {
      if (it.sep) { const s = document.createElement('div'); s.className = 'sep'; menu.appendChild(s); continue; }
      const el = document.createElement('div');
      el.className = 'mi' + (it.danger ? ' danger' : '');
      el.textContent = it.label;
      el.onclick = () => { hideMenu(); it.fn(); };
      menu.appendChild(el);
    }
    menu.style.display = 'block';
    // 落位规则（与编辑器里的补全面板/右键菜单同一条）：菜单可以在那一行之上或之下，
    // 但**不许盖住鼠标**，也不许盖住右键点的那一行。原来把菜单左上角钉在 (x, y) 上，
    // 鼠标和被点的行都压在菜单底下——想点"删除（回收站）"却先点到被压住的行，或者
    // 一松手菜单就没了，看着像"点了没反应"。
    const rect = menu.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const margin = 8, gap = 8;
    const left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin));
    const hits = top => x >= left && x <= left + rect.width && y >= top && y <= top + rect.height;
    const fits = top => top >= margin && top + rect.height <= window.innerHeight - margin;
    let top = [rowRect.bottom + gap, rowRect.top - gap - rect.height, y + 16, y - rect.height - 16]
      .find(value => fits(value) && !hits(value));
    if (top === undefined) {
      top = Math.max(margin, Math.min(rowRect.bottom + gap, window.innerHeight - rect.height - margin));
      if (hits(top)) top = Math.max(margin, Math.min(rowRect.top - gap - rect.height, window.innerHeight - rect.height - margin));
    }
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }
  window.addEventListener('mousedown', (e) => { if (!menu.contains(e.target)) hideMenu(); }, true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); }, true);
  window.addEventListener('blur', hideMenu);

  // ---------- 文件树 ----------
  /** 树操作的失败提示。以前是 alert()，而 Electron 外壳页里 alert 同样是"不显示任何东西"
   *  （与 confirm 一样是空操作），失败被彻底吞掉。 */
  let treeErrorTimer = 0;
  function showTreeError(message) {
    const box = $('#sb-error');
    if (!box) { console.error(message); return; }
    box.textContent = message;
    box.hidden = false;
    clearTimeout(treeErrorTimer);
    treeErrorTimer = setTimeout(() => { box.hidden = true; box.textContent = ''; }, 8000);
  }
  function clearTreeError() {
    const box = $('#sb-error');
    if (box && !box.hidden) { box.hidden = true; box.textContent = ''; }
    clearTimeout(treeErrorTimer);
  }
  async function startCreate(parentDir, isDir) {
    pendingCreate = { parentDir, isDir };
    if (!expanded[parentDir]) {
      expanded[parentDir] = true;
      persistExpanded();
    }
    await renderTree();
  }
  function startRename(path) { renamingPath = path; renderTree(); }
  async function doDelete(path) {
    const name = baseName(path);
    // 这里以前是 `window.confirm(...)`：Electron 的外壳页里它**恒为 false 且不弹任何东西**
    // （实测 probe-confirm.cjs：2ms 返回 false、页面上什么都没有），于是「删除（回收站）」
    // 点了永远没反应。确认改由主进程的原生对话框回答（同一套还能被自动化验收脚本化）。
    const answer = await api.invoke('confirm-trash', { name }).catch(() => null);
    if (!answer?.ok) return;
    try {
      await api.invoke('tree-delete', { path });
      for (const k of Object.keys(expanded)) {
        if (k === path || k.startsWith(path + '\\') || k.startsWith(path + '/')) delete expanded[k];
      }
      persistExpanded();
      treeCache.clear();
      await renderTree();
    } catch (e) { showTreeError('删除失败：' + e.message); }
  }

  function persistExpanded() {
    clearTimeout(expandedSaveTimer);
    expandedSaveTimer = setTimeout(() => api.invoke('expanded-set', expanded), 300);
  }

  // ---------- 侧边栏工具条 ----------
  $('#btn-new-md').onclick = () => wsRoot && startCreate(wsRoot, false);
  $('#btn-new-dir').onclick = () => wsRoot && startCreate(wsRoot, true);
  $('#btn-refresh').onclick = () => refreshTree();
  $('#btn-mdonly').onclick = () => {
    mdOnly = !mdOnly;
    $('#btn-mdonly').classList.toggle('on', mdOnly);
    api.invoke('sidebar-set', { mdOnly });
    renderTree();
  };
  $('#btn-expand').onclick = async () => {
    if (!wsRoot) return;
    // 递归展开，上限 400 个目录防止超大目录卡死
    let budget = 400;
    const walk = async (dir) => {
      if (budget <= 0) return;
      budget -= 1;
      expanded[dir] = true;
      let entries = treeCache.get(dir);
      if (!entries) {
        entries = (await api.invoke('tree-list', { dir })).entries;
        treeCache.set(dir, entries);
      }
      for (const ent of entries) {
        if (ent.isDir && budget > 0) await walk(ent.path);
      }
    };
    await walk(wsRoot);
    persistExpanded();
    renderTree();
  };
  $('#btn-collapse').onclick = () => {
    if (!wsRoot) return;
    expanded = { [wsRoot]: true };
    persistExpanded();
    renderTree();
  };
  $('#sb-empty-open').onclick = () => api.invoke('choose-folder');

  // ---------- 侧边栏开关 / 分隔条 ----------
  function toggleSidebar() {
    const app = $('#app');
    const hidden = app.classList.toggle('sb-hidden');
    api.invoke('sidebar-set', { visible: !hidden });
  }
  $('#ws-name').addEventListener('dblclick', toggleSidebar);

  const splitter = $('#splitter');
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    splitter.classList.add('drag');
    const move = (ev) => {
      const w = Math.max(180, Math.min(520, ev.clientX));
      document.documentElement.style.setProperty('--sb-width', w + 'px');
    };
    const up = (ev) => {
      splitter.classList.remove('drag');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      api.invoke('sidebar-set', { width: Math.max(180, Math.min(520, ev.clientX)) });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  // ---------- 欢迎页 / 最近 ----------
  $('#w-open-folder').onclick = () => api.invoke('choose-folder');
  $('#w-open-file').onclick = () => api.invoke('choose-file');
  $('#btn-recent').onclick = openRecentDialog;
  $('#w-recent-all').onclick = openRecentDialog;
  $('#recent-close').onclick = () => $('#recent-dialog').close();
  $('#recent-search').oninput = renderRecentDialog;

  function renderRecent(folders, files) {
    recentFolders = (folders || []).slice(0, 50);
    recentFiles = (files || []).slice(0, 50);
    const box = $('#w-recent');
    box.innerHTML = '';
    const mk = (label) => { const h = document.createElement('h3'); h.textContent = label; box.appendChild(h); };
    mk('最近的文件夹');
    if (recentFolders.length) {
      recentFolders.slice(0, 5).forEach((p) => box.appendChild(recentItem(p, I.dir, () => openRecent(p))));
    } else {
      const d = document.createElement('div'); d.className = 'r-none'; d.textContent = '暂无'; box.appendChild(d);
    }
    mk('最近的文件');
    if (recentFiles.length) {
      recentFiles.slice(0, 8).forEach((p) => box.appendChild(recentItem(p, I.md, () => openRecent(p))));
    } else {
      const d = document.createElement('div'); d.className = 'r-none'; d.textContent = '暂无'; box.appendChild(d);
    }
    if ($('#recent-dialog').open) renderRecentDialog();
  }
  function recentItem(p, icon, fn) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'r-item';
    el.innerHTML = `<span class="icon">${icon}</span><span title="${escapeHtml(p)}">${escapeHtml(p)}</span>`;
    el.onclick = fn;
    return el;
  }
  async function refreshRecent() {
    try {
      const s = await api.invoke('recent-get');
      renderRecent(s.recentFolders || [], s.recentFiles || []);
    } catch { /* 主进程暂未提供时忽略 */ }
  }

  async function openRecentDialog() {
    await refreshRecent();
    $('#recent-search').value = '';
    $('#recent-error').textContent = '';
    renderRecentDialog();
    if (!$('#recent-dialog').open) $('#recent-dialog').showModal();
    $('#recent-search').focus();
  }
  function renderRecentDialog() {
    const query = $('#recent-search').value.trim().toLocaleLowerCase();
    for (const [kind, paths, icon, label] of [
      ['files', recentFiles, I.md, '文件'], ['folders', recentFolders, I.dir, '文件夹'],
    ]) {
      const list = $('#recent-' + kind);
      list.replaceChildren();
      $('#recent-' + kind + '-title').textContent = `${label} (${paths.length}/50)`;
      for (const p of paths.filter(p => p.toLocaleLowerCase().includes(query))) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'recent-link'; button.title = p;
        button.dataset.path = p;
        const iconEl = document.createElement('span'); iconEl.className = 'icon'; iconEl.innerHTML = icon;
        const name = document.createElement('strong'); name.textContent = baseName(p);
        const location = document.createElement('small'); location.textContent = p;
        const text = document.createElement('span'); text.append(name, location);
        button.append(iconEl, text); button.onclick = () => openRecent(p);
        list.append(button);
      }
      if (!list.childElementCount) {
        const empty = document.createElement('p'); empty.className = 'r-none';
        empty.textContent = query ? '没有匹配项' : '暂无记录'; list.append(empty);
      }
    }
  }
  async function openRecent(p) {
    const result = await api.invoke('open-path', {path: p});
    if (result.ok) {
      if ($('#recent-dialog').open) $('#recent-dialog').close();
    } else if (result.error) {
      if (!$('#recent-dialog').open) await openRecentDialog();
      $('#recent-error').textContent = '无法打开，文件或文件夹可能已移动：' + p;
    }
  }

  // ---------- 拖放 ----------
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    dragDepth += 1;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const dropped = e.dataTransfer && e.dataTransfer.files;
    if (!dropped || !dropped.length) return;
    try {
      // 2.1.0：拖进来的每个文件都打开（一个文件一个窗口），不再只取第一个。
      const paths = [];
      for (const file of dropped) {
        const p = api.pathForFile(file);
        if (p) paths.push(p);
      }
      if (paths.length) await api.invoke('open-paths', { paths });
    } catch (err) { console.error('drop failed:', err); }
  });
})();
