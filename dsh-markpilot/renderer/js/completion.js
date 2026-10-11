import {captureContext, enrichContext} from './completion-context.js';
import {localCandidates} from './completion-sources.js';
import {installCompletionMenu} from './completion-menu.js';
import {aiDelay, shouldSuggest, completionPayload, payloadKey, remainingSuggestion} from './completion-policy.mjs';
import {scheduleSurfaceCleanup} from './surface.js';

/** Shared editor installation, enabled by completion metadata from the host. */
export function installCompletion(api, boot) {
  const editor = api.vditor, handler = window.handler;
  const normalizeConfig = value => {
    return {...value, ai: value?.ai === true, automaticAI: value?.automaticAI === true,
      baseUrl: value?.baseUrl || '', model: value?.model || '', profiles: value?.profiles || []};
  };
  let config = normalizeConfig(boot.settings), version = boot.documentVersion;
  let revision = 0, acknowledged = 0, sequence = 0, generation = 0;
  let timer, aiTimer, statusTimer, context = null, items = [], selected = 0, ghost = '';
  let composing = false, dirty = false, destroyed = false, lastTyping = 0, waiting = null, automatic = false;
  let activity = 'input', lastActivity = 0, cursorTimer, previousAI = null, suppressed = '', selectedByUser = false;
  let quietUntil = 0;
  const pending = new Map(), listeners = [];
  const root = () => editor[editor.currentMode]?.element;
  const listen = (target, event, fn, options) => {target.addEventListener(event, fn, options);listeners.push(() => target.removeEventListener(event, fn, options));};
  // 最近一次鼠标位置：面板落位必须避开它（见 position 的说明）。只记录，不拦事件。
  let pointer = null;
  listen(window, 'mousemove', event => {pointer = {x: event.clientX, y: event.clientY};}, {passive: true, capture: true});
  listen(window, 'mousedown', event => {pointer = {x: event.clientX, y: event.clientY};}, {passive: true, capture: true});
  const css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = new URL('../css/completion.css', import.meta.url).href;document.head.append(css);
  const popup = document.createElement('div');
  popup.className = 'md-completion'; popup.hidden = true; popup.setAttribute('role', 'listbox');popup.setAttribute('aria-label', '补全候选');
  const preview = document.createElement('div');
  preview.className = 'md-completion-preview'; preview.hidden = true; preview.setAttribute('role', 'status');preview.setAttribute('aria-live', 'polite');
  document.body.append(popup, preview);
  const settingsMenu = installCompletionMenu(api, config, dismiss);
  const visible = () => !popup.hidden || !preview.hidden;
  const current = () => !destroyed && !composing && context?.matches() && document.hasFocus();

  function dismiss(disarm = true, preserveAI = false) {
    if (disarm) automatic = false;
    generation++;clearTimeout(timer);clearTimeout(aiTimer);clearTimeout(statusTimer);clearTimeout(cursorTimer);
    selectedByUser = false;
    const wasVisible = visible();
    waiting = null; context = null;items = [];ghost = '';popup.hidden = true;preview.hidden = true;
    for (const request of pending.values()) clearTimeout(request.timer);
    if (pending.size) handler.emit('completion-cancel', {keepAI: preserveAI});
    pending.clear();
    // Translucent popups hide/move over reflowing text on every keystroke;
    // once editing settles, wipe any compositor trail they left behind.
    if (wasVisible) scheduleSurfaceCleanup();
  }
  /** 「正在编辑的那一行」：光标所在的最内层块级容器（公式/代码块里就是那一行源码）。
   *  取不到时退回光标矩形本身。 */
  function editedLineBox(fallback) {
    try {
      const node = context.node;
      const element = node && node.nodeType === 3 ? node.parentElement : node;
      const block = element && element.closest ? element.closest('code,p,li,pre,td,th,h1,h2,h3,h4,h5,h6') : null;
      const box = block && block.getBoundingClientRect ? block.getBoundingClientRect() : null;
      if (box && box.height) return box;
    } catch { /* 落到光标矩形 */ }
    return fallback;
  }
  /** 「正在编辑的那一条公式的预渲染框」（KaTeX 渲染结果那片浮层）。
   *  面板绝不许盖住它：盖住时用户看不见自己正在敲的公式渲染成什么样（用户 2026-09-14
   *  第 6 轮第 3 条：「目前数学公式提示栏虽然避开了 caret 和正在编辑的行，但还应该再加一个
   *  避开预渲染框的规则，否则的话，编辑者无法看清现在编辑的效果」）。
   *  只有**展开态**的节点才有可见的预渲染框（折叠时它被 Vditor 收起来），所以这个查询
   *  在正常文档里最多命中一两个元素，代价可以忽略。 */
  function previewBoxes() {
    const boxes = [];
    try {
      const nodes = document.querySelectorAll('.vditor-ir__node--expand > .vditor-ir__preview,.vditor-wysiwyg__block--expand > .vditor-wysiwyg__preview');
      for (const node of nodes) {
        const box = node.getBoundingClientRect();
        if (box.width > 1 && box.height > 1 && box.bottom > 0 && box.top < innerHeight) boxes.push(box);
      }
    } catch { /* 量不到就当没有：宁可退到旧行为，也不要因为量几何把面板卡住 */ }
    return boxes;
  }
  /** 面板落位（2026-09-14 用户口径）：
   *   ① 面板整体尽量留在视口内；
   *   ② **绝不盖住"正在编辑的那一行"**——盖住源码行时，用户看不见自己在敲什么；
   *   ③ **绝不盖住鼠标**——面板是自动弹出来的，压着鼠标时随手一点就会插进一个模板/公式
   *      （用户实测：点积分符号时光标落点是对的，但提示框正好盖在鼠标上，一点就错）；
   *   ④ **不盖住正在编辑那条公式的预渲染框**（见 previewBoxes）。
   *  两侧都放不下时**不再"硬钳进视口"**（那正是盖住源码行的原因），而是把面板高度压到那一侧
   *  的真实空间（面板本身可滚动），让②③恒成立；只有两侧都窄到放不下任何条目时，才退回旧的
   *  钳位（宁可截断，也不让提示框完全消失）。 */
  function position(element) {
    if (!current()) return;
    const range = context.range.cloneRange();
    let rect = range.getBoundingClientRect();
    if (!rect.height) {
      if (context.node.nodeType === 3 && context.offset > 0) {range.setStart(context.node, context.offset - 1);rect = range.getBoundingClientRect();rect = {left:rect.right, bottom:rect.bottom, top:rect.top, height:rect.height};}
      else rect = (context.node.nodeType === 3 ? context.node.parentElement : context.node).getBoundingClientRect();
    }
    const box = element.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, innerWidth - box.width - 8));
    element.style.left = left + 'px';
    const margin = 8, gap = 4, least = 60;
    // 建议框比候选列表更值钱：一段 AI 续写常常好几行，让它尽量一次显示完
    // （用户要求"行数过多时自动给一个合适的窗口大小，少拉滚动条"），
    // 上限取屏幕高度的六成、最多 520px；候选列表仍按 360px。
    const hardMax = element === preview ? Math.min(520, Math.round(innerHeight * 0.6)) : 360;
    const line = editedLineBox(rect);
    const hitsMouse = (top, height) => !!pointer && top < pointer.y + 4 && top + height > pointer.y - 4;
    const previews = previewBoxes();
    const hitsPreview = (top, height) => previews.some(area =>
      left < area.right - 2 && left + box.width > area.left + 2 && top < area.bottom - 2 && top + height > area.top + 2);
    // 工具栏（可见时）是面板上方的**边界**：既有验收（scripts/desktop-completion.cjs）要求
    // "光标滚出视口时面板跟着离开，而不是停在工具栏上"（那条断言量 `popup.top >= toolbar.bottom - 1`）。
    // 早先的写法只把"压住工具栏"当成一个排序偏好，于是"上方有空间、但空间被工具栏占着"时面板
    // 仍然会顶到屏幕最上面（实测场景 86 的几何：工具栏高 71px、面板落进 8..336，横跨工具栏）。
    // 现在把工具栏下沿当成天花板：可用空间从天花板算起、落位也要 clamp 到它下面，
    // 面板因此在"行上方"这段里变矮（可滚动），而不是顶着工具栏。
    const toolbar = document.querySelector('.vditor-toolbar');
    const toolbarBottom = (() => {
      const rect = toolbar?.getBoundingClientRect?.();
      return rect && rect.height > 1 && rect.bottom > 0 ? rect.bottom : 0;
    })();
    const ceiling = Math.max(margin, toolbarBottom);
    const hitsToolbar = (top, height) => toolbarBottom > 0 && top < toolbarBottom - 1 && top + height > 0;
    // 两侧各自的可用空间：下方从行尾往下（视口为界），上方从行首往上（工具栏下沿为界）。
    const spaceBelow = innerHeight - margin - (line.bottom + gap);
    const spaceAbove = (line.top - gap) - ceiling;
    const plan = (name, space) => {
      const height = Math.round(Math.min(box.height, hardMax, Math.max(0, space)));
      const top = name === 'below' ? line.bottom + gap : line.top - gap - height;
      return {name, top, height, ok: height >= least, mouse: hitsMouse(top, height),
        toolbar: hitsToolbar(top, height), preview: hitsPreview(top, height)};
    };
    const plans = [plan('below', spaceBelow), plan('above', spaceAbove)].filter(item => item.ok);
    // 排序偏好：不压鼠标 → 不压工具栏 → 不盖预渲染框 → 能显示的条目更多 → 放下方（阅读顺序）。
    plans.sort((a, b) => (Number(a.mouse) - Number(b.mouse)) || (Number(a.toolbar) - Number(b.toolbar)) ||
      (Number(a.preview) - Number(b.preview)) || (b.height - a.height) || (a.name === 'below' ? -1 : 1));
    const chosen = plans[0];
    if (!chosen) {
      element.style.maxHeight = box.height + 'px';
      element.style.top = Math.max(ceiling, Math.min(rect.bottom + gap, innerHeight - box.height - margin)) + 'px';
      return;
    }
    element.style.maxHeight = chosen.height + 'px';
    element.style.top = Math.max(ceiling, Math.round(chosen.top)) + 'px';
  }
  function showItems() {
    if (!current() || !items.length) {popup.hidden = true;return;}
    ghost = '';preview.hidden = true;selected = Math.min(selected, items.length - 1);
    popup.replaceChildren();
    items.forEach((item, index) => {
      const button = document.createElement('button');button.type = 'button';button.tabIndex = -1;
      button.dataset.source = item.source || 'local';if (item.source === 'ai') button.title = item.text;
      button.setAttribute('role', 'option');button.setAttribute('aria-selected', String(index === selected));
      const label = document.createElement('span'); label.textContent = item.label;
      const detail = document.createElement('small');detail.textContent = item.detail || '';
      button.append(label, detail);
      button.addEventListener('mousedown', event => {event.preventDefault();selected = index;accept();});
      popup.append(button);
    });
    const hint = document.createElement('footer');hint.textContent = '↑↓ 选择 · Tab / Enter 接受 · Esc 关闭';popup.append(hint);
    popup.hidden = false;
    if (editor.hint?.element) editor.hint.element.style.display = 'none';
    position(popup);
    const option = popup.querySelector('[aria-selected="true"]');
    if (option.offsetTop < popup.scrollTop) popup.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > popup.scrollTop + popup.clientHeight) popup.scrollTop = option.offsetTop + option.offsetHeight - popup.clientHeight;
  }
  function message(text, completion = '') {
    if (!current()) return;
    popup.hidden = true;ghost = completion;preview.replaceChildren();
    const body = document.createElement('div');body.className = 'md-completion-ghost';body.textContent = text;
    preview.append(body);
    if (completion) {const hint = document.createElement('small');hint.textContent = 'AI · Tab 接受 · Esc 取消 · 内容多可直接滚动';preview.append(hint);}
    preview.hidden = false;preview.scrollTop = 0;position(preview);
  }
  function aiItem(text) {
    return {text, before: 0, after: 0, source: 'ai', label: text.slice(0, 120), detail: context.kind === 'math' ? 'AI 数学建议' : 'AI 续写'};
  }
  function showAI(text) {
    if (!text || !current()) return;
    if (popup.hidden) {message(text, text);return;}
    const chosen = items[selected];items = items.filter(item => item.source !== 'ai');items.unshift(aiItem(text));
    selected = selectedByUser && items.includes(chosen) ? items.indexOf(chosen) : 0;showItems();
  }
  function prepareSource(kind) {
    if (kind === 'paths' || context.sourceReady === kind || kind === 'host' && context.sourceReady) return true;
    let source;try {source = captureContext(api);if (source && kind === 'ai') source = enrichContext(api, source);} catch {return false;}
    if (!source?.matches()) return false;
    context = source;context.sourceReady = kind;return true;
  }
  function send(kind, manual = false) {
    if (!current() || dirty || acknowledged !== revision) return;
    // Serialize only the nearby source for remote providers, after document
    // sync. Local candidates never wait for this work or the host round trip.
    if (!prepareSource(kind)) return;
    if (kind === 'host' && !context.needle) return;
    if (kind === 'ai' && !manual && !shouldSuggest(context, activity)) return;
    const id = ++sequence, captured = generation;
    if (kind === 'ai' && popup.hidden) message('AI 正在补全…');
    const timeout = setTimeout(() => {
      if (!pending.has(id)) return;pending.delete(id);
      if (captured === generation && current() && kind === 'ai') {
        message('AI 请求超时，可重试或检查补全设置。');statusTimer = setTimeout(() => {preview.hidden = true;}, 2500);
      }
    }, kind === 'ai' ? 15500 : 3000);
    pending.set(id, {kind, manual, generation: captured, timer: timeout, version, context: kind === 'ai' ? completionPayload(context) : null});
    handler.emit('completion-request', {id, kind, manual, version, prefix: context.prefix, suffix: context.suffix,
      needle: context.needle, caret: context.caret, ...(kind === 'ai' ? {aiContext: completionPayload(context)} : {})});
  }
  function anchoredCandidates() {
    if (!context.prefix.startsWith('#') || context.prefix === '#') return [];
    const query = context.prefix.slice(1).toLowerCase();
    // Outline entries already carry Vditor's actual heading IDs. Read only on #.
    return [...(editor.outline?.element.querySelectorAll('[data-target-id]') || [])]
      .filter(element => element.textContent.toLowerCase().includes(query)).slice(0, 12)
      .map(element => ({label: '#' + element.textContent.trim(), detail: '文档标题',
        text: '[' + element.textContent.trim().replace(/[\[\]]/g, '') + '](#' + encodeURIComponent(element.dataset.targetId) + ')',
        before: context.prefix.length, after: 0, markdown: true, source: 'local'}));
  }
  function request(manual = false, aiOnly = false) {
    if (manual && aiOnly && current() && !dirty && [...pending.values()].some(job => job.kind === 'ai')) return;
    dismiss(false);
    if (manual) suppressed = '';
    if (destroyed || composing || !document.hasFocus()) return;
    try {context = captureContext(api, false);} catch {return;}
    if (!context) return;
    if (aiOnly && !config.ai) {message('请在工具栏“补全 ▾”菜单中填写 API Key，保存后开启补全。');return;}
    if (!aiOnly && config.local) {
      items = [...localCandidates(context.prefix, context), ...anchoredCandidates()];selected = 0;showItems();
    }
    const run = () => {
      waiting = null;if (!current()) return;
      if (aiOnly) {send('ai', true);return;}
      if (config.local && /^[@!]/.test(context.prefix)) send('paths', manual);
      else if (config.host && (manual || context.kind !== 'math' && context.prefix.length >= 2)) send('host', manual);
      if (config.ai && config.automaticAI && prepareSource('ai') && shouldSuggest(context, activity)) {
        if (suppressed && payloadKey(context) === suppressed) return;
        const remaining = remainingSuggestion(previousAI, context);
        if (remaining !== null) {showAI(remaining);return;}
        aiTimer = setTimeout(() => {if (current()) send('ai');}, Math.max(0, aiDelay(config, context, activity) - (Date.now() - lastActivity)));
      }
    };
    if (dirty || acknowledged !== revision) waiting = run;
    else run();
  }
  function schedule() {
    if (destroyed || composing || !(config.local || config.host || (config.ai && config.automaticAI))) return;
    clearTimeout(timer);
    // Held-backspace deletion reflows the edited block at key-repeat pace. A
    // translucent popup flickering open over that reflow is the stale-paint
    // trigger the user reported (v2.0.3): keep deletions quiet for a beat.
    const delay = Math.max(activity === 'cursor' ? 250 : 120, quietUntil - Date.now());
    timer = setTimeout(() => request(), Math.max(0, delay));
  }
  function cursorActivity() {
    if (!config.cursorSuggestions || destroyed || composing) return;
    clearTimeout(cursorTimer);cursorTimer = setTimeout(() => {
      const selection = getSelection();
      if (!selection.isCollapsed || !root()?.contains(selection.anchorNode) || !root().contains(document.activeElement) && document.activeElement !== root()) return;
      activity = 'cursor';lastActivity = Date.now();automatic = true;schedule();
    }, 0);
  }
  function accept() {
    if (!current()) {dismiss();return;}
    const item = !popup.hidden ? items[selected] : ghost ? {text: ghost, before: 0, after: 0} : null;
    if (!item) return;
    const range = context.replacement(item.before, item.after), mode = context.mode;
    if (!range) {dismiss();return;}
    dismiss();
    if (mode === 'ir') api.__typoraFlushIR?.(); else editor.undo.addToUndoStack(editor);
    const selection = getSelection();selection.removeAllRanges();selection.addRange(range);
    editor.undo.recordFirstPosition(editor, {key: 'Tab'});
    if (item.markdown) api.insertMD(item.text);
    else document.execCommand('insertText', false, item.text);
    if (mode === 'ir') editor.undo.addToUndoStack(editor);
    dismiss();
  }
  const changed = content => {
    if (destroyed) return;
    dirty = false;revision++;
    handler.emit('completion-change', {content, revision});
    // Vditor may replace the active block after the input event. Its completed
    // change callback is also a chance to capture the restored caret.
    if (automatic && !context?.matches()) schedule();
  };
  handler.on('completion-ack', ack => {
    if (destroyed || ack.revision < acknowledged) return;
    acknowledged = ack.revision;version = ack.version;
    if (ack.ok && !dirty && acknowledged === revision) waiting?.();
    else if (!ack.ok) {dirty = true;dismiss();}
  }).on('completion-settings-changed', next => {
    dismiss();previousAI = null;suppressed = '';config = normalizeConfig(next.settings);version = next.documentVersion;settingsMenu.update(config);
  }).on('completion-response', response => {
    const request = pending.get(response.id);if (!request) return;
    clearTimeout(request.timer);pending.delete(response.id);
    if (request.generation !== generation || request.version !== version || !current() || dirty) return;
    if (response.error) {
      if (request.kind === 'ai') {
        if (popup.hidden) {message(response.error);statusTimer = setTimeout(() => {preview.hidden = true;}, 2500);}
        else popup.querySelector('footer').textContent = response.error;
      }
      return;
    }
    if (request.kind === 'ai') {
      if (typeof response.text === 'string' && response.text.trim()) {
        previousAI = {context: request.context, text: response.text, time: Date.now()};showAI(response.text);
      }
      else if (popup.hidden) {
        if (request.manual) {message('暂无建议，继续输入后再试。');statusTimer = setTimeout(dismiss, 2000);}
        else preview.hidden = true;
      }
    } else {
      const shownAI = ghost;
      const keys = new Set(items.map(item => item.text + ':' + item.before));
      for (const item of response.items || []) if (typeof item.text === 'string' && typeof item.label === 'string' && !keys.has(item.text + ':' + item.before)) {
        keys.add(item.text + ':' + item.before);items.push(item);
      }
      items = items.slice(0, 12);
      if (shownAI && !items.length) return;
      if (shownAI) {items.unshift(aiItem(shownAI));selected = 0;}
      showItems();
    }
  });
  listen(window, 'keydown', event => {
    if (event.defaultPrevented || !root()?.contains(event.target) || !root().isContentEditable) return;
    if (event.isComposing || composing || editor[editor.currentMode].composingLock) return;
    const manual = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.code === 'Space';
    const ai = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === 'Backslash';
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    const navigation = plain && !popup.hidden && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key);
    const take = plain && event.key === 'Tab' && (ghost || !popup.hidden);
    const escape = event.key === 'Escape' && (visible() || pending.size);
    if (manual || ai || navigation || take || escape) {
      event.preventDefault();event.stopImmediatePropagation();
      if (event.repeat && (take || event.key === 'Enter' || ai)) return;
      if (manual || ai) request(true, ai);
      else if (escape) {suppressed = context ? payloadKey(context) : '';dismiss();}
      else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {selectedByUser = true;selected = (selected + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;showItems();}
      else accept();
      return;
    }
    const navigating=['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key);
    // Navigation may cross identical-looking sections. Only the host cache has
    // the full heading ancestry; local remainder reuse is reserved for typing.
    if(navigating)previousAI=null;
    if (!['Shift','Control','Alt','Meta'].includes(event.key)) dismiss(true, navigating);
  }, true);
  listen(window, 'keyup', event => {
    if (root()?.contains(event.target) && !event.shiftKey && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key) && !(context?.matches() && visible())) cursorActivity();
  }, true);
  listen(window, 'beforeinput', event => {
    if (root()?.contains(event.target)) {dismiss();suppressed = '';dirty = true;lastTyping = Date.now();}
  }, true);
  listen(window, 'input', event => {
    if (root()?.contains(event.target)) {
      dismiss();dirty = true;suppressed = '';lastTyping = Date.now();lastActivity = lastTyping;activity = 'input';automatic = true;
      if (event.inputType && event.inputType.startsWith('delete')) {
        quietUntil = Date.now() + 550;
        // Reflow churn from deletions can leave stale compositor tiles even
        // with no popup involved; clean up once the burst settles.
        scheduleSurfaceCleanup(700);
      }
      schedule();
    }
  }, true);
  listen(window, 'compositionstart', event => {if (root()?.contains(event.target)) {composing = true;dismiss();}}, true);
  listen(window, 'compositionend', event => {if (root()?.contains(event.target)) {composing = false;lastTyping = Date.now();lastActivity = lastTyping;activity = 'input';automatic = true;schedule();}}, true);
  listen(document, 'selectionchange', () => {
    if (context?.matches()) return;
    if (context) dismiss(false);
    if (automatic) schedule();
  });
  // AI 建议框自己也是补全 UI 的一部分：按在框里既不落光标也不关框。
  // 2026-09-15 用户实测“一点就跑、一点就全框消失”——原因就是下面那条 document
  // mousedown 守卫只放过了候选列表 popup，没放过 preview；加上 preview 早期是
  // pointer-events:none，press 直接穿到正文把光标挪走，于是框跟着消失。
  listen(preview, 'mousedown', event => event.preventDefault(), true);
  listen(document, 'mousedown', event => {
    if (popup.contains(event.target) || preview.contains(event.target)) return;
    previousAI=null;dismiss(true, !!root()?.contains(event.target));
  }, true);
  listen(window, 'click', event => {if (root()?.contains(event.target)) cursorActivity();}, true);
  listen(window, 'focusin', event => {if (root()?.contains(event.target)) cursorActivity();}, true);
  // Scrolling is reading, not editing: the caret and its completion context
  // are unchanged, so the popup stays open and follows the caret (clamped
  // into view). Only an explicit click elsewhere closes it.
  listen(document, 'scroll', event => {
    // 在建议框内部滚轮翻看时不要重新落位，否则刚读到的地方会被挪走（用户实测“一点就跑”之一）。
    if (popup.contains(event.target) || preview.contains(event.target) || !current()) return;
    if (!popup.hidden) position(popup);if (!preview.hidden) position(preview);
  }, true);
  listen(window, 'blur', dismiss);
  listen(window, 'resize', dismiss);
  const controller = {changed, flushChanges(){if(dirty&&!composing)changed(api.getValue());}, externalChange() {dismiss();previousAI=null;dirty = false;api.__splitNavigation?.cancelEntry();}, request, dismiss,
    destroy() {destroyed = true;dismiss();listeners.forEach(remove => remove());popup.remove();preview.remove();settingsMenu.destroy();css.remove();},
  };
  api.__completion = controller;
  const destroy = api.destroy.bind(api);api.destroy = (...args) => {controller.destroy();return destroy(...args);};
  return controller;
}
