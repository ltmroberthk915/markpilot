/* MarkPilot — 独立桌面壳的宿主桥（单文档，无 iframe）。
 *
 * 与引擎的契约（一行都没有改引擎）：
 *   · 引擎用 `window.handler.on(type, fn)` 注册**下行**处理（open / setValue / requestText）；
 *   · 引擎用 `window.handler.emit("init")` 与内部 `post()`（`window.parent.postMessage({__dshmp:true,dir:"up"})`）
 *     发**上行**事件；在独立页里 `window.parent === window`，所以同一页就能收到自己的上行消息——
 *     这正是"引擎零改动"的关键：我们只在下面监听并路由。
 *   · 上行：init / change{len} / text / host-invoke / openLink
 *   · 下行：open{content} / setValue(string) / requestText / host-result
 */
'use strict';

// 诊断计数器必须在任何分支之前初始化：早先在 case 'init' 里直接写 window.__mpDbg.init，
// 而它只在 onDoc 分支里惰性创建 ⇒ init 分支抛 TypeError 被 up() 的 try/catch 吞掉，
// 表现为"引擎发了 init、宿主毫无反应"（实测踩坑：init 分支整段没执行）。
window.__mpDbg = window.__mpDbg || { init: 0, docEvents: 0, ups: [] };

const bus = Object.create(null);
const textWaiters = [];
/** 【P1-1·2026-10-10 由"人类常用操作普查"三族独立命中】"打开就能打字"在带文档启动时不成立：
 *  实测 `document.hasFocus()=true` 但 `activeElement=BODY`、`view.hasFocus=false`，
 *  不点正文直接打字 / 回车 / Ctrl+End 全不落字（docLen 11→11）。
 *  两轮尝试的教训：抓焦挂在 `doc` 事件处理器里**不会执行** —— 主进程常在引擎 boot 之前就推文档，
 *  那条走 pendingDoc ⇒ `applyDoc` 的首次分支（本文件里 booted 翻 true 的那一处）才是真正的 boot 点。
 *  且只抓一次会被"主进程稍后 `W.show()` 让窗口获焦"覆盖 ⇒ 多时机重复抓（首帧 / 80ms / 700ms /
 *  窗口获得焦点时，且只在前 5 秒内，避免长期抢焦点）。 */
function grabBootFocus() {
  let retired = false;
  const timers = [];
  const retire = () => {
    if (retired) return;
    retired = true;
    timers.forEach(clearTimeout);
    for (const type of ['pointerdown', 'mousedown', 'keydown']) document.removeEventListener(type, onUserInput, true);
    window.removeEventListener('focus', grab);
  };
  const onUserInput = event => { if (event.isTrusted) retire(); };
  const grab = () => {
    if (retired || !document.hasFocus()) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    try { window.mpEngine?.focus?.(); } catch { /* 忽略 */ }
  };
  for (const type of ['pointerdown', 'mousedown', 'keydown']) document.addEventListener(type, onUserInput, true);
  window.addEventListener('focus', grab);
  grab();
  timers.push(setTimeout(grab, 80), setTimeout(grab, 700), setTimeout(retire, 5000));
}

let booted = false;
let pendingDoc = null;      // 主进程可能在引擎 boot 之前就把文档送过来
let filePath = null;
let dirty = false;
let saveTimer = 0;
let saveInFlight = false;
let saveTask = null;
let documentId = null;
let revision = 0;
let saveBlocked = false;
let lastSaveError = null;
let observedSource = null;
let recoverySerial = 0;
let saveAsSerial = 0;
let reloadPending = null;
const consumedReloads = new Set();
let savePolicy = MarkPilotSavePolicy.normalize(false, undefined);
let autoGeneration = 0, policyReadSerial = 0;
function autoTicket() { return { generation: autoGeneration, documentId }; }
function autoCurrent(ticket) { return savePolicy.enabled && ticket?.generation === autoGeneration && ticket.documentId === documentId; }
function retireAutosave() { autoGeneration++; clearTimeout(saveTimer); saveTimer = 0; }
function applySavePolicy(enabled, intervalMs) {
  const next = MarkPilotSavePolicy.normalize(enabled, intervalMs);
  if (next.enabled !== savePolicy.enabled || next.intervalMs !== savePolicy.intervalMs) { retireAutosave(); savePolicy = next; scheduleSave(); }
  window.dispatchEvent(new CustomEvent('mp:save-policy', { detail: savePolicy }));
}
async function refreshSavePolicy() {
  const serial = ++policyReadSerial;
  try {
    const [enabled, interval] = await Promise.all([window.mpHost.settingGet('autosaveEnabled'), window.mpHost.settingGet('autosaveIntervalMs')]);
    if (serial !== policyReadSerial) return;
    applySavePolicy(enabled?.value, interval?.value);
  } catch (error) { console.error('[host] save policy unavailable', error); }
}
void refreshSavePolicy();
window.mpHost.onSetting?.(payload => {
  // The authoritative snapshot cancels a timer immediately, before any read IPC.
  policyReadSerial++;
  if (payload?.savePolicy) applySavePolicy(payload.savePolicy.enabled, payload.savePolicy.intervalMs);
  if (payload?.key === 'autosaveEnabled' || payload?.key === 'autosaveIntervalMs') return;
  void window.mpHost.themeGet().then(r => applyTheme(r.dark)).catch(() => {});
  window.mpEngine?.applyPrefs?.();
});
window.addEventListener('pagehide', retireAutosave);
/* 【体积骤降守卫·2026-10-09】当前文档的"已知体积"：装载时=文件长度，每次成功保存后=写入长度。
   为什么要它：实测到过一次**磁盘级数据丢失**的形态——换文档时旧的非空选区被映射拉成整篇，
   用户敲的第一个字把整篇替换掉，500ms 去抖的自动保存**如实**把那几个字节写回原路径
   （8.13MB → 9B）。根因已在引擎侧修（setValue 显式映射选区），这道守卫是**第二道防线**：
   自动保存遇到"体积骤降"不静默写盘，先问人。Ctrl+S / 重试走 force=true，是明确意图，不拦。 */
let knownLen = 0;
const SHRINK_MIN = 20000;      // 低于这个体积不判（小文档本来就几行，删空也正常）
const SHRINK_RATIO = 0.2;      // 掉到不足已知体积的 20% 视为骤降

/* ── 桥：上行路由（同一页内 self-postMessage + emit 都汇到 up） ── */
window.handler = {
  on(type, fn) { bus[type] = fn; return this; },
  emit(type, data) { up(type, data); return this; },
};
window.addEventListener('message', (e) => {
  const d = e.data;
  if (d && d.__dshmp === true && d.dir === 'up') up(d.type, d.content);
});
const down = (type, content) => { const fn = bus[type]; if (fn) { try { fn(content); } catch (err) { console.error('[host] down handler failed', type, err); } } };

/* ── 提示条 ──
 *  注意：host.js 在 <head> 里执行，此刻 body 尚未解析——绝不能在模块顶层取 DOM 节点缓存，
 *  否则 init→applyDoc→hideBanner 会在 banner=null 上抛错，引擎的 open 收不到、永远不 boot。 */
const bannerEl = () => document.getElementById('mp-banner');
let bannerSerial = 0;
function showBanner(text, actions = [], info = false) {
  const ticket = ++bannerSerial;
  const banner = bannerEl();
  if (!banner) return ticket;
  banner.className = info ? 'info' : '';
  banner.textContent = text;
  for (const a of actions) {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.onclick = () => { if (hideBanner(ticket)) a.run(); };
    banner.appendChild(b);
  }
  banner.style.display = 'block';
  return ticket;
}
function hideBanner(expectedSerial) {
  if (expectedSerial !== undefined && expectedSerial !== bannerSerial) return false;
  bannerSerial++;
  const b = bannerEl();
  if (!b) return false;
  b.style.display = 'none'; b.textContent = ''; return true;
}

/* ── 标题（文件名 · 脏标 · 字数） ── */
let charCount = 0;
function refreshTitle() {
  const name = filePath ? filePath.split(/[\\/]/).pop() : '未命名';
  document.title = `${dirty ? '● ' : ''}${name}${charCount ? ' · ' + charCount + ' 字' : ''} — MarkPilot`;
  window.mpHost.docDirty(dirty, { documentId, revision });
}

/* ── 当前文档目录（给引擎解析相对 URL 用）────────────────────────────────────
 * 契约（与引擎侧商定，2026-10-08）：`window.__mpDocDir` = 绝对 Windows 路径、**无尾斜杠**、
 * 无文档时 null；目录变化时在 window 上发 `mp:docdir`（e.detail = { dir, filePath }）。
 * 【顺序纪律】先写 `__mpDocDir` → 再发事件 → **最后**才 down 文档内容：引擎首次渲染就要拿到正确目录
 * （它会据此设 `<base href="file:///…/">`，相对路径的 <img> 才落在文档旁边而不是应用安装目录）。
 * 【为什么由壳层给】文档路径的唯一真源在主进程（state.filePath），渲染侧只知道我们自己维护的 filePath；
 * 目录变化（另存为到别处、关闭文件）也都在这一层发生，所以这里发最省事、时序最准。 */
function docDirOf(p) {
  if (!p || typeof p !== 'string') return null;
  const norm = p.replace(/[\\/]+$/, '');              // 去掉尾部分隔符
  const cut = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  return cut > 0 ? norm.slice(0, cut) : null;         // 只留目录部分（无尾斜杠）
}
function publishDocDir(filePathForDir) {
  const dir = docDirOf(filePathForDir);
  try { window.__mpDocDir = dir; } catch { /* 极端情况下赋值失败也不影响编辑 */ }
  window.__mpDocPath = filePathForDir || null;
  try {
    window.dispatchEvent(new CustomEvent('mp:docdir', { detail: { dir, filePath: filePathForDir || null } }));
  } catch (e) { console.error('[host] mp:docdir 派发失败', e); }
  return dir;
}

/* ── 文档装载 ── */
function checkpointRendererDocument() {
  const engine = window.mpEngine?.checkpointDocument?.();
  if (booted && !engine) throw new Error('请先完成当前输入');
  const old = { booted, documentId, revision, saveBlocked, filePath, lastSaveError, charCount, knownLen, observedSource, dirty };
  let active = true;
  return {
    commit() { if (!active) return false; if (engine && !engine.commit()) throw new Error('文档提交事务已过期'); active = false; return true; },
    rollback() {
      if (!active) return;
      active = false;
      // A failed source restoration must block saving; never attach an unknown
      // buffer to the previous file and describe it as a retained draft.
      try { if (engine && !engine.rollback()) throw new Error('文档恢复事务已过期'); }
      catch (error) { saveBlocked = true; lastSaveError = error.message; throw error; }
      ({ booted, documentId, revision, saveBlocked, filePath, lastSaveError, charCount, knownLen, observedSource, dirty } = old);
      publishDocDir(filePath); refreshTitle(); scheduleSave();
    },
  };
}
function applyDoc(text, path, id, loadedRevision = 0, loadKind = 'replace', ticket = null, keepOwnerOnFailure = false, transaction = null) {
  let checkpoint;
  retireAutosave();
  // Supply the resource base before mounting. Commit metadata only after the
  // source was accepted; an engine failure must keep the existing buffer.
  try {
    checkpoint = transaction || checkpointRendererDocument();
    publishDocDir(path || null);
    if (!booted) { const fn = bus.open; if (!fn) throw new Error('编辑器尚未就绪'); fn({ content: text }); booted = true; grabBootFocus(); }
    else {
      const engine = window.mpEngine;
      const name = loadKind === 'reload' ? 'setValue' : 'replaceDocument';
      const accepted = typeof engine?.[name] === 'function' ? engine[name](text, ticket) : bus[name]?.(text);
      if (accepted === false || !engine || engine.getValue() !== text) throw new Error('编辑器未接收读取结果');
    }
    documentId = id; revision = loadedRevision; saveBlocked = false;
    filePath = path || null;
    publishDocDir(filePath);
    hideBanner(); lastSaveError = null;
    charCount = knownLen = text.length;
    observedSource = window.mpEngine?.documentSession?.() || null;
    dirty = false; refreshTitle();
    if (!transaction) checkpoint.commit();
    return true;
  } catch (e) {
    try { checkpoint?.rollback(); }
    catch (restoreError) { showBanner('文档状态未能恢复，已暂停保存。请复制正文备份：' + restoreError.message); return false; }
    publishDocDir(filePath);
    if (keepOwnerOnFailure) { showBanner('新文档未能打开，已保留原稿：' + e.message); scheduleSave(); }
    else retainBufferAfterRead({ text, filePath: path, documentId: id, revision: loadedRevision }, e.message);
    return false;
  }
}
function syncSource(content = window.mpEngine?.documentSession?.()) {
  const stamp = content && Number.isSafeInteger(content.sourceRevision) ? content : null;
  if (stamp) {
    if (observedSource && (stamp.epoch !== observedSource.epoch || stamp.sourceRevision <= observedSource.sourceRevision)) return false;
    revision += observedSource ? stamp.sourceRevision - observedSource.sourceRevision : 1;
    observedSource = { epoch: stamp.epoch, sourceRevision: stamp.sourceRevision };
  } else revision++;
  charCount = typeof content?.len === 'number' ? content.len : (window.mpEngine?._view?.().state.doc.length ?? charCount);
  dirty = true; refreshTitle(); return true;
}
async function syncDirty() {
  syncSource();
  const metadata = { documentId, revision };
  const ack = await window.mpHost.docDirty(dirty, metadata);
  return ack?.ok === true && ack.documentId === metadata.documentId && ack.revision === metadata.revision;
}
function retainBufferAfterRead(payload, reason) {
  if (payload.documentId) { documentId = payload.documentId; revision = (payload.revision || 0) + 1; filePath = payload.filePath || null; publishDocDir(filePath); }
  observedSource = window.mpEngine?.documentSession?.() || null;
  dirty = true; saveBlocked = true; recoverySerial++;
  lastSaveError = reason; refreshTitle();
  showBanner('读取期间继续编辑，已保留当前内容。', [
    { label: '另存为…', run: () => { void saveAsFlow(); } },
    { label: '载入磁盘版本', run: () => { void reloadDocument({ origin: 'disk' }); } },
  ]);
}
function consumeReload(payload, pending) {
  if (pending && (payload.requestId !== pending.requestId || payload.loadKind !== 'reload' || (payload.requestedPath || payload.filePath) !== pending.filePath || typeof payload.documentId !== 'string' || typeof payload.text !== 'string')) return pending.result = { ok: false, code: 'MP_DOC_MISMATCH', error: '读取结果不属于当前请求' };
  if (consumedReloads.has(payload.requestId)) return pending?.result || { ok: true, duplicate: true };
  consumedReloads.add(payload.requestId);
  if (consumedReloads.size > 64) consumedReloads.delete(consumedReloads.values().next().value);
  const engine = window.mpEngine;
  const sourceValid = pending && documentId === pending.documentId && filePath === pending.filePath && engine?.commands.valid(pending.ticket, { intent: false });
  if (!sourceValid) {
    if (pending && documentId === pending.documentId && filePath === pending.filePath) retainBufferAfterRead(payload, 'MP_RELOAD_NEWER_INPUT');
    return pending ? (pending.result = { ok: false, code: 'MP_RELOAD_NEWER_INPUT', error: '已保留读取期间的新修改' }) : { ok: false, code: 'MP_DOC_MISMATCH' };
  }
  const ticket = engine.commands.valid(pending.ticket) ? pending.ticket : engine.commands.capture();
  const ok = !!ticket && applyDoc(payload.text, payload.filePath, payload.documentId, payload.revision, 'reload', ticket);
  if (!ok && !ticket) retainBufferAfterRead(payload, 'MP_COMPOSING');
  if (ok) engine.commands.resume(ticket);
  return pending.result = { ...payload, ok };
}
async function reloadDocument({ origin = 'toolbar' } = {}) {
  const engine = window.mpEngine, ticket = engine?.commands.capture();
  if (!ticket) return { ok: false, code: 'MP_COMPOSING', error: '请完成当前输入后再读取文件' };
  if (reloadPending) return { ok: false, code: 'MP_RELOAD_BUSY', error: '正在读取当前文档' };
  const pending = reloadPending = { requestId: crypto.randomUUID(), documentId, filePath, ticket, origin, result: null };
  try {
    if (origin === 'toolbar') await flushSave();
    if (documentId !== pending.documentId || filePath !== pending.filePath || !engine.commands.valid(ticket, { intent: false })) return { ok: false, code: 'MP_DOC_MISMATCH', error: '编辑版本已改变，重载已取消' };
    if (!(await syncDirty())) return { ok: false, code: 'MP_DOC_MISMATCH', error: '文档版本同步失败' };
    if (!engine.commands.valid(ticket, { intent: false })) return { ok: false, code: 'MP_DOC_MISMATCH', error: '编辑版本已改变，重载已取消' };
    const r = await window.mpHost.reload({ requestId: pending.requestId, documentId, revision, filePath, origin });
    if (r?.ok && !pending.result) consumeReload(r, pending);
    if (!r?.ok) engine.commands.resume(ticket);
    return pending.result || r;
  } finally { if (reloadPending === pending) reloadPending = null; }
}
window.mpReloadDocument = reloadDocument;

let pendingOpen = null;
window.mpPrepareOpen = async ({ requestId }) => {
  const engine = window.mpEngine, ticket = engine?.commands.capture();
  if (!booted || !ticket) return { ok: false, code: 'MP_COMPOSING' };
  const pending = pendingOpen = { requestId, documentId, ticket, engine };
  if (!(await syncDirty()) || pendingOpen !== pending || !engine.commands.valid(ticket, { intent: false })) return { ok: false, code: 'MP_OPEN_STALE' };
  return { ok: true, documentId, revision };
};
window.mpCancelOpen = ({ requestId }) => { if (pendingOpen?.requestId === requestId) pendingOpen = null; };
function commitOpenedDoc(payload) {
  const pending = pendingOpen, engine = window.mpEngine;
  const valid = pending?.requestId === payload.requestId && pending.documentId === documentId && pending.engine === engine
    && engine.commands.valid(pending.ticket, { intent: false }) && !engine._view().composing;
  if (!valid) {
    window.mpHost.commitOpen({ requestId: payload.requestId, phase: 'reject' });
    showBanner('读取期间有新修改，已保留原文档。'); return false;
  }
  // Final ticket check, metadata adoption, and source application occupy this
  // one synchronous turn. Input cannot fall into an acceptance/apply gap.
  const accepted = window.mpHost.commitOpen({ requestId: payload.requestId, documentId, phase: 'adopt' });
  if (!accepted?.ok) return false;
  let checkpoint;
  try {
    checkpoint = checkpointRendererDocument();
    if (!applyDoc(payload.text, payload.filePath, payload.documentId, payload.revision, 'replace', pending.ticket, true, checkpoint)) {
      window.mpHost.commitOpen({ requestId: payload.requestId, phase: 'rollback' }); return false;
    }
    const finished = window.mpHost.commitOpen({ requestId: payload.requestId, phase: 'finish' });
    if (!finished?.ok) throw new Error('文档打开提交未确认');
    checkpoint.commit(); pendingOpen = null; return true;
  } catch (error) {
    try { checkpoint?.rollback(); } catch (restoreError) { saveBlocked = true; lastSaveError = restoreError.message; }
    window.mpHost.commitOpen({ requestId: payload.requestId, phase: 'rollback' });
    showBanner(saveBlocked ? '文档状态未能恢复，已暂停保存。请复制正文备份。' : '新文档未能打开，已保留原稿：' + error.message);
    return false;
  }
}
window.mpCloseState = async () => {
  const engine = window.mpEngine;
  if (engine?._view?.()?.composing || !engine?.commands?.capture()) { showBanner('请先完成当前输入，再关闭文档。'); return { ok: false, composing: true }; }
  if (!(await syncDirty())) return { ok: false };
  return { ok: true, documentId, revision, dirty, source: engine.documentSession() };
};

/* ── 取当前文本（引擎侧 requestText → text 上行） ── */
function currentText(timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = textWaiters.indexOf(waiter);
      if (i >= 0) textWaiters.splice(i, 1);
      reject(new Error('requestText 超时'));
    }, timeoutMs);
    const waiter = (text) => { clearTimeout(timer); resolve(text); };
    textWaiters.push(waiter);
    down('requestText');
  });
}
const engineValue = () => {
  try { return window.mpEngine && window.mpEngine.getValue ? window.mpEngine.getValue() : null; } catch { return null; }
};
// A direct page reload must not discard an unsaved editor buffer.
window.addEventListener('beforeunload', event => {
  const inputReady = !booted || !!window.mpEngine?.commands?.capture();
  if (booted && window.mpEngine?.documentSession) syncSource();
  if (!inputReady || dirty || saveInFlight || window.mpEngine?._view?.()?.composing) { event.preventDefault(); event.returnValue = false; }
});

/* ── 保存 ──
 * 诊断留痕：window.__mpDbg.saveTrace 记下每一次保存的路径/结果/异常。
 * "另存为点了没反应"这类问题只看界面看不出来——必须能回答"到底走到哪一步断的"。 */
function saveTrace(step, detail) {
  try {
    const d = (window.__mpDbg = window.__mpDbg || { init: 0, docEvents: 0, ups: [] });
    d.saveTrace = d.saveTrace || [];
    d.saveTrace.push({ at: Date.now(), step, detail: detail === undefined ? null : detail });
    if (d.saveTrace.length > 60) d.saveTrace.shift();
  } catch { /* 诊断不许影响主流程 */ }
}
function scheduleSave() {
  if (saveTimer || saveInFlight || !savePolicy.enabled || !dirty || !filePath || saveBlocked || lastSaveError) return;
  const ticket = autoTicket();
  saveTimer = setTimeout(() => { saveTimer = 0; if (autoCurrent(ticket)) void doSave(false, null, null, ticket); }, savePolicy.intervalMs);
}
async function flushSave() {
  window.mpEngine?.commands.capture(); syncSource();
  const ticket = autoTicket();
  const pending = !!saveTimer || !!saveTask;
  clearTimeout(saveTimer); saveTimer = 0;
  if (saveTask) await saveTask;
  if (dirty && !saveBlocked && autoCurrent(ticket)) await doSave(false, null, null, ticket);
  return pending;
}
window.mpFlushSave = flushSave;
function saveFailure(r, path) {
  lastSaveError = r?.error || '未知错误';
  if (['MP_FILE_CONFLICT', 'MP_FILE_MISSING', 'MP_FILE_LINKED'].includes(r?.code)) saveBlocked = true;
  showBanner('保存失败：' + lastSaveError + '（' + path + '）', [
    { label: '另存为…', run: () => { void saveAsFlow(); } },
    { label: '重新加载', run: () => { void reloadDocument({ origin: 'disk' }); } },
    ...(!saveBlocked ? [{ label: '重试', run: () => { void doSave(true); } }] : []),
  ]);
}
async function doSave(force = false, grant = null, saveAsOperation = null, automatic = null) {
  const operationCurrent = () => saveAsOperation === null || saveAsOperation === saveAsSerial;
  if (!operationCurrent() || (!force && (!automatic || !autoCurrent(automatic)))) return false;
  if (window.mpEngine?.commands && !window.mpEngine.commands.capture()) {
    // A canceled composition may leave the committed source unchanged. Keep the
    // current automatic save alive without saving preedit or awaiting new input.
    if (!force && automatic && autoCurrent(automatic)) scheduleSave();
    return false;
  }
  syncSource();
  if (!filePath && !grant) {
    if (force) return saveAsFlow();
    return false;
  }
  if (saveInFlight) {
    const id = documentId;
    await saveTask;
    if (documentId !== id || !operationCurrent() || (!force && !autoCurrent(automatic))) return false;
    if (force || dirty) return doSave(force, grant, saveAsOperation, automatic);
    return true;
  }
  if (saveBlocked && !grant) return false;
  clearTimeout(saveTimer); saveTimer = 0;
  const capture = { documentId, revision, recoverySerial, filePath: grant?.filePath || filePath };
  if (grant && grant.documentId !== capture.documentId) return false;
  saveInFlight = true;
  saveTrace('doSave:start', capture);
  saveTask = Promise.resolve().then(async () => {
    try {
      const immediate = engineValue();
      const text = typeof immediate === 'string' ? immediate : await currentText();
      if (documentId !== capture.documentId || revision !== capture.revision || !operationCurrent() || (!force && !autoCurrent(automatic))) return false;
      if (typeof text !== 'string') throw new Error('取不到文档内容');
      if (!force && knownLen >= SHRINK_MIN && text.length < knownLen * SHRINK_RATIO) {
        showBanner('自动保存被拦下：文档从 ' + knownLen + ' 字骤降到 ' + text.length + ' 字。确认这是你要的结果吗？', [
          { label: '仍要保存', run: () => { void doSave(true); } },
          { label: '放弃这次自动保存', run: () => {} },
        ]); return false;
      }
      const r = await window.mpHost.save(capture.filePath, text, { documentId: capture.documentId, revision: capture.revision, ...(!force ? { automatic: true } : {}), ...(grant ? { saveAsToken: grant.saveAsToken } : {}) });
      saveTrace('doSave:saved', { filePath: capture.filePath, ok: !!r?.ok, revision: capture.revision, code: r?.code, error: r?.error });
      if (documentId !== capture.documentId || recoverySerial !== capture.recoverySerial) return false;
      // A later Save As intent can cancel a picker, but cannot undo a completed
      // disk commit. Reconcile that receipt before the next queued intent runs.
      if (!r?.ok) { if (operationCurrent() && r?.code !== 'MP_AUTOSAVE_DISABLED') saveFailure(r, capture.filePath); return false; }
      if (!r.current) return false;
      filePath = r.filePath; publishDocDir(filePath); knownLen = text.length;
      dirty = revision !== capture.revision;
      lastSaveError = null; saveBlocked = false;
      hideBanner(); refreshTitle();
      await window.mpHost.docSaved(filePath, r);
      return true;
    } catch (e) {
      if (documentId === capture.documentId && recoverySerial === capture.recoverySerial && operationCurrent()) saveFailure({ error: e.message }, capture.filePath);
      return false;
    } finally {
      saveInFlight = false; saveTask = null;
      scheduleSave();
    }
  });
  return saveTask;
}
async function saveAsFlow() {
  const operation = ++saveAsSerial, id = documentId, engine = window.mpEngine, commands = engine?.commands;
  const ticket = commands?.capture();
  if (commands && !ticket) return false;
  saveTrace('saveAsFlow:start',{operation,documentId:id});
  try {
    if (saveTask) await saveTask;
    if (documentId !== id || operation !== saveAsSerial) return false;
    const grant = await window.mpHost.saveAs();
    saveTrace('saveAsFlow:result', grant);
    if (documentId !== id || operation !== saveAsSerial) return false;
    if (!grant?.ok) {
      if (grant?.error) saveFailure(grant, filePath || '未命名文档');
      return false;
    }
    return await doSave(true, grant, operation);
  } catch (error) {
    if (documentId === id && operation === saveAsSerial) saveFailure({error:error.message},filePath || '未命名文档');
    return false;
  } finally {
    if (commands && documentId === id && operation === saveAsSerial && window.mpEngine === engine && document.hasFocus()) {
      const current = commands.valid(ticket,{source:false}) ? ticket : commands.capture({allowSuspended:false});
      if (current) commands.resume(current);
    }
  }
}
async function newDocument({ replace = false } = {}) {
  if (exportActive) { exportBanner('请先完成或取消 PDF 导出'); return false; }
  if (!replace && (filePath || dirty || revision || engineValue())) {
    const r = await window.mpHost.openInNewWindow(null);
    if (!r?.ok) showBanner(r?.error || '新建窗口失败');
    return !!r?.ok;
  }
  const id = documentId;
  if (dirty && !(await confirmDiscard())) return false;
  if (documentId !== id) return false;
  const r = await window.mpHost.docPath(null, { documentId: id });
  if (documentId !== id) return false;
  if (!r?.ok) { showBanner(r?.error || '新建失败'); return false; }
  applyDoc('', null, r.documentId);
  window.mpEngine?.focus?.(); return true;
}

/* ── 上行事件（任何异常都不许打断引擎：包一层，错进 console） ── */
function up(type, content) {
  try { window.__mpDbg.ups.push(type); if (window.__mpDbg.ups.length > 40) window.__mpDbg.ups.shift(); handleUp(type, content); }
  catch (e) { console.error('[host] up handler failed', type, e); }
}
function handleUp(type, content) {
  switch (type) {
    case 'init':
      if (pendingDoc) { const p = pendingDoc; pendingDoc = null; applyDoc(p.text, p.filePath, p.documentId, p.revision, p.loadKind); break; }
      // Starting a window reads the existing session, including its blank identity.
      // Only an explicit new-document command may reset an in-flight file load.
      window.__mpDbg.init = (window.__mpDbg.init || 0) + 1;
      window.mpHost.docReady()
        .then(doc => {
          if (!booted && doc?.documentId) applyDoc(doc.text, doc.filePath, doc.documentId, doc.revision);
        })
        .catch(e => console.error('[host] document handshake failed', e));
      break;
    case 'change': {
      if (!syncSource(content)) break;
      scheduleSave();
      break;
    }
    case 'text': {
      const w = textWaiters.shift();
      if (w) w(typeof content === 'string' ? content : '');
      break;
    }
    case 'openLink': {
      const url = content && (content.href || content.url || content);
      if (url && /^https?:/i.test(String(url))) window.mpHost.openExternal(String(url));
      break;
    }
    case 'host-invoke': {
      const { id, cmd } = content || {};
      const reply = (result) => down('host-result', { id, result });
      if (cmd === 'app-info') window.mpHost.info().then((i) => reply(i));
      else if (cmd === 'toolbar-height') reply(null);
      else reply(null);
      break;
    }
    default: break;
  }
}

/* ── 主进程 → 渲染进程 ── */
window.mpHost.onDoc((payload) => {
  window.__mpDbg = window.__mpDbg || {};
  window.__mpDbg.docEvents = (window.__mpDbg.docEvents || 0) + 1;
  if (!payload) return;
  if (payload.loadKind === 'open' && payload.requestId) { commitOpenedDoc(payload); return; }
  if (payload.loadKind === 'reload' && payload.requestId) { consumeReload(payload, reloadPending?.requestId === payload.requestId ? reloadPending : null); return; }
  if (!bus.open) { pendingDoc = payload; return; }
  // 主进程推来的就是权威文档：直接应用（不再用 booted 分流，applyDoc 两种情形都处理）
  pendingDoc = null;
  applyDoc(payload.text, payload.filePath, payload.documentId, payload.revision, payload.loadKind);
});
window.mpHost.onMenu(async (cmd) => {
  switch (cmd) {
    case 'undo':
    case 'redo': {
      if (!window.mpEngine?.menuHistory?.(cmd)) await window.mpHost.history(cmd);
      break;
    }
    /* 【设置真源·S1·2026-10-10（settings-truth 族）】用户"删掉 settings.json"后**仍看到**工具岛
       透明度/版心/内容缩放/状态栏开关全都还在 ✗ —— 因为渲染侧偏好是**另一套存储**：
       `localStorage` 的 mp-pref-* / mp-surfaces / mp-reading* / editor-theme…，删配置文件清不动它。
       这里补上这一半：一次清掉本进程**全部 mp-\* 键**，再 reload 让界面以干净状态重起。
       （壳层那套由删 settings.json / 设置面板负责 ✓ 这里不重复、也不猜它各键的默认值 ✗。） */
    case 'resetAll': {
      const removed = await window.mpHost.themeRemove();
      const defaults = Object.fromEntries(['body','h1','h2','h3','h4','h5','h6','italic','bold','code'].map(id => [id,'']));
      const fonts = await window.mpHost.fontSave(defaults);
      if (!removed.ok || !fonts.ok) { showBanner('恢复外观默认失败：' + (removed.error || fonts.error)); return; }
      let cleared = 0;
      try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf('mp-') === 0) keys.push(k); }
        for (const k of keys) { localStorage.removeItem(k); cleared++; }
        localStorage.removeItem('editor-theme'); localStorage.removeItem('dark');
      } catch { /* 忽略 */ }
      try { console.log('[resetAll] 已清渲染侧偏好键 ' + cleared + ' 个，即将重载'); } catch { /* 忽略 */ }
      try { location.reload(); } catch { /* 忽略 */ }
      return;
    }
    case 'new': await newDocument(); break;
    case 'save': if (!(await doSave(true))) await window.mpHost.cancelCloseSave(); break;
    case 'saveThenReload': if (await doSave(true)) await window.mpHost.reloadView(); break;
    case 'saveAs': await saveAsFlow(); break;
    case 'closeFile': await newDocument({ replace: true }); break;

    case 'theme': await toggleTheme(); break;
    /* 【S5 折中·2026-10-10（用户批准 ✓）】壳层广播过来的**全局观感类**设置 ⇒ 用**既有 applier** 应用 ✓：
       · 主题：`themeGet()` + `applyTheme(dark)` ✓ —— **不是** `toggleTheme()` ✗（广播的是"设成某个值"，
         不是"切换" ✓；用切换会在每个窗口里翻一次，值还可能不一致 ✗）；
       · 字体/字号/行高/公式缩放：引擎自己的 `window.mpEngine.applyPrefs()` ✓（与引擎内部同一入口 ✓
         `extras.js:2134` ✓，**不新写第二份应用逻辑** ✗）。
       两个 applier 都是幂等的 ✓ ⇒ 一律都跑一遍即可，**不依赖广播载荷的字段名** ✓（少一处猜 ✗）。
       注意：`zoom`/滚动**不在广播之列** ✗ —— 视图类各窗口独立 ✓（折中的关键对照 ✓）。 */
    case 'setting':
      await refreshSavePolicy();
      try { const r = await window.mpHost.themeGet(); applyTheme(r.dark); } catch { /* 忽略 */ }
      try { if (window.mpEngine && window.mpEngine.applyPrefs) window.mpEngine.applyPrefs(); } catch { /* 忽略 */ }
      break;
    case 'exportPdf': await exportPdfFlow(); break;   // 菜单：文件 → 导出为 PDF…（Ctrl+Shift+P）
    /* 【缩放解耦·3.0.4】菜单项与 Ctrl+= / Ctrl+- / Ctrl+0 一律走**引擎的内容缩放**：
       壳层 webFrame.setZoomLevel 是整页缩放（工具岛、状态栏一起变大），正是要改掉的观感。
       引擎未就位（极端时序）才回退到壳层缩放，保证菜单永远不静默。 */
    case 'zoomIn': zoomVia('by', +10); break;
    case 'zoomOut': zoomVia('by', -10); break;
    case 'zoomReset': zoomVia('set', 100); break;
    default: break;
  }
});
window.mpHost.onTheme((t) => { applyTheme(t.dark); });

/* ── 导出为 PDF（壳层流程的渲染侧那一半）────────────────────────────────────
 * 分工：主进程负责选目标、建 staging、打印、写盘、清理；**HTML 仍由引擎写**
 * ——主进程发 export:make-html，我们在这里调引擎自己的「导出为文件夹」流程
 * （window.mpExtras.exportFolder），它会经由 mpHost.exportPickFolder 拿到 staging 目录，
 * 于是引擎的分块写流 + assets/ 逐张复制 + 相对路径全部原样复用，引擎一行不用改。
 * 阶段（pick→assets→html→load→images→print→write→cleanup）由主进程经既有
 * export:progress 通道报上来（接口名没改），这里翻成提示条上人话 + 一个取消按钮。
 */
const PDF_PHASE_TEXT = {
  pick: '选择保存位置…', assets: '复制图片…', html: '生成 HTML…', load: '加载本地 HTML…',
  images: '等待图片解码…', style: '套用打印样式…', print: '排版打印…', write: '写入 PDF…',
  'write-done': '写入完成', cleanup: '清理临时文件…', canceled: '已取消', error: '导出失败',
};
let exportActive = false;      // 由 export:progress 的阶段驱动：谁发起导出都能看到同一条提示条
let exportLastPhase = '';
function exportBanner(text, cancelable = true) {
  showBanner(text, cancelable ? [{ label: '取消', run: () => { void window.mpHost.exportPdfCancel(); } }] : [], true);
}
window.mpHost.onExportProgress((p) => {
  if (!p || !p.phase) return;
  if (p.phase === 'pick') { exportActive = true; exportLastPhase = ''; exportBanner('正在导出 PDF：准备…'); return; }
  if (!exportActive) return;
  if (p.phase === 'done') {
    exportActive = false;
    const kb = Math.round((p.bytes || 0) / 1024);
    const ticket = showBanner(`已导出 PDF：${p.file}（${p.pages || '?'} 页 · ${kb} KB · 用时 ${((p.ms || 0) / 1000).toFixed(1)}s）`,
      [{ label: '关闭', run: () => hideBanner() }], true);
    setTimeout(() => { if (!exportActive) hideBanner(ticket); }, 12000);
    return;
  }
  if (p.phase === 'canceled') {
    exportActive = false;
    const ticket = showBanner('已取消导出 PDF（临时文件与半成品已清理）', [{ label: '关闭', run: () => hideBanner() }], true);
    setTimeout(() => hideBanner(ticket), 6000); return;
  }
  if (p.phase === 'error') { exportActive = false; showBanner(`导出 PDF 失败：${p.error || '未知错误'}`, [{ label: '关闭', run: () => hideBanner() }]); return; }
  const label = PDF_PHASE_TEXT[p.phase];
  if (!label || p.phase === exportLastPhase) return;
  exportLastPhase = p.phase;
  const n = p.done && p.bytes ? `（${Math.round(p.done / 1024)}/${Math.round(p.bytes / 1024)} KB）` : '';
  exportBanner(`正在导出 PDF：${label}${n}`);
});
window.mpHost.onExportMakeHtml(async (payload) => {
  const reply = o => window.mpHost.htmlDone({ id: payload?.id, ...o });
  const sourceLength = engineValue()?.length || charCount;
  if (payload?.documentId !== documentId) return void (await reply({ ok: false, error: 'PDF 发起文档已切换' }));
  try {
    const fx = window.mpExtras;
    if (!fx || typeof fx.exportFolder !== 'function') return void (await reply({ ok: false, error: '引擎没有 exportFolder（当前宿主不支持文件夹导出流程）' }));
    // silent：这条路的目标目录是主进程的 staging 临时目录，不该把「已导出：<临时目录>\xxx.html」弹给用户
    const r = await fx.exportFolder({ dir: payload && payload.stageDir, pdfSessionId: payload?.id, silent: true });
    if (!r || !r.ok) return void (await reply({ ok: false, error: (r && r.error) || 'exportFolder 未成功', mode: r && r.mode }));
    if (!r.file) return void (await reply({ ok: false, error: '引擎没有写出本地 HTML 文件（可能降级成下载导出了）', mode: r.mode }));
    // 公式 CSS：导出 HTML 里只有 `.katex` 标记，KaTeX 的类样式由引擎单独给出（buildMathCss）。
    // 打印窗口不注入它，公式就是"有结构没排版"。这里取一次带给主进程（只在打印窗口里用，不落盘）。
    let mathCss = null, mathCssError = null;
    try {
      if (typeof fx.buildMathCss === 'function') {
        const c = fx.buildMathCss();
        mathCss = (c && typeof c.then === 'function') ? await c : c;
      }
    } catch (e) { mathCssError = String((e && e.message) || e); }
    await reply({ ok: true, file: r.file, mode: r.mode, mathCss: typeof mathCss === 'string' ? mathCss : null, mathCssError,
      /* 源 Markdown 长度：PDF 打印层的 Knuth–Plass 预算用它（源 ≥300KB 或可排块 ≥1800 ⇒ 整体跳过精细断行）。
         这是"文档长度"而非"HTML 长度"——与 2.x 线的预算口径一致，同一文档在两条线上判定相同。 */
      sourceBytes: sourceLength });
  } catch (e) {
    await reply({ ok: false, error: String((e && e.message) || e) });
  }
});
/** 壳层菜单入口：真正的活儿在主进程，界面由上面那条进度监听驱动（引擎侧调 mpHost.exportPdf() 同样走这条）。 */
async function exportPdfFlow() {
  try {
    const r = await window.mpHost.exportPdf();
    window.__mpDbg.lastPdf = r;           // 诊断：最后一次 PDF 导出的完整结果（真链路测试直接读它）
    if (r && !r.ok && !r.canceled && !exportActive) {
      showBanner(`导出 PDF 失败：${r.error || '未知错误'}`, [{ label: '关闭', run: () => hideBanner() }]);
    } else if (r && r.canceled && !exportActive) {
      const ticket = showBanner('已取消导出 PDF', [{ label: '关闭', run: () => hideBanner() }], true);
      setTimeout(() => hideBanner(ticket), 5000);
    }
    /* 【KP 排版的两条用户可见反馈】与 2.x 线同一口径：
       · 超预算（源 ≥300KB 或可排块 ≥1800）⇒ 整体跳过精细断行，必须**明说**，不许静默降级；
       · 排版代码缺失/注入失败 ⇒ 也明说一句，否则用户会以为是"排版没生效"的产品缺陷。 */
    if (r && r.ok && r.kp) {
      if (r.kp.budgetSkipped) showBanner('超大文档兼容模式：已跳过精细断行（Knuth-Plass），改用标准两端对齐', [{ label: '知道了', run: () => hideBanner() }]);
      else if (r.kp.error) showBanner(`精细断行未生效（已回退两端对齐）：${r.kp.error}`, [{ label: '关闭', run: () => hideBanner() }]);
    }
    return r;
  } catch (e) {
    showBanner(`导出 PDF 异常：${(e && e.message) || e}`, [{ label: '关闭', run: () => hideBanner() }]);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function confirmDiscard() {
  return window.confirm('当前文档有未保存的修改，确定放弃吗？');
}

/* 菜单缩放 → 引擎的内容缩放（工具岛不跟着变）。引擎没就位时退回壳层整页缩放（不静默）。 */
function zoomVia(kind, v) {
  const z = window.mpZoom;
  try {
    if (z && typeof z[kind] === 'function') { z[kind](v); return; }
  } catch { /* 落到壳层 */ }
  if (kind === 'set') window.mpHost.zoomReset();
  else if (v > 0) window.mpHost.zoomIn();
  else window.mpHost.zoomOut();
}

/* ── 主题：**唯一写者是 window.mpTheme（引擎侧登记表）**，壳层只管"模式"这件事 ──
   原先这里直接把 editor-theme 改写成 telari-*，等于第二个写者：用户选了 Notion 深色，壳层一同步
   就被顶掉，还会留下 editor-theme=telari-light 而 dark=true 这种自相矛盾的状态（菜单显示"当前"、
   画面却是另一套）。现在只在**用户从未选过配色**时才落一套默认，且不再写死任何颜色
   （底色由引擎的 `html,body{background:var(--mp-bg)}` 负责，--mp-bg 由引擎在模块求值期就写入）。 */
function themeForMode(dark) {
  const cur = (() => { try { return localStorage.getItem('editor-theme') || ''; } catch { return ''; } })();
  const mt = window.mpTheme;
  const want = dark ? '-dark' : '-light';
  if (mt && mt.has && cur && mt.has(cur)) {
    const sib = mt.sibling(cur);
    if (sib && sib.endsWith(want)) return sib;                       // 同族邻居正好是这个明暗 ⇒ 保住家族
    const fam = String(cur).replace(/-(dark|light)$/, '') + want;
    if (mt.has(fam)) return fam;
  }
  return dark ? 'telari-dark' : 'telari-light';
}
function applyTheme(dark) {
  const id = themeForMode(dark);
  try {
    if (window.mpTheme && window.mpTheme.apply) window.mpTheme.apply(id);
    else if (window.mpEngine && window.mpEngine.setTheme) window.mpEngine.setTheme(id);
  } catch { }
}
async function toggleTheme() {
  const cur = await window.mpHost.themeGet();
  const next = cur.dark ? 'light' : 'dark';
  const r = await window.mpHost.themeSet(next);
  applyTheme(r.dark);
}

/* ── 拖入文件 ── */
window.addEventListener('dragover', (e) => { e.preventDefault(); });
/* 【P0-3·2026-10-10 由"人类常用操作普查"查出，会毁数据】原来这条监听挂在**冒泡阶段**：
   `e.preventDefault()` 确实调了，但 **CM6 自己在 `.cm-content` 上的 drop 处理器先跑**，
   已经把被拖文件的内容插进了文档 —— 之后再 preventDefault 也晚了（插入事务已经发生）。
   实测后果：脏文档拖入"正在编辑的同一个文件"、确认框点「取消」，内容照样进了内存，
   并被去抖自动保存写回磁盘（56 B→114 B，6/6 复现）。
   修法：① 挂到**捕获阶段** + `stopPropagation()`，让 CM6 根本看不到这次文件拖放；
        ② 只截**带 files 的**拖放 —— 纯文本拖拽（含编辑器内部移动文字）原样放行给 CM6。 */
window.addEventListener('drop', async (e) => {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;              // 纯文本拖拽：放行（编辑器内部移动文字依赖它）
  e.preventDefault();
  e.stopPropagation();
  const f = files[0];
  const p = window.mpHost.pathForFile(f);
  if (!p) return;
  const r = await window.mpHost.openDocument(p);
  if (!r?.ok && !r?.canceled) showBanner(r?.error || '打开失败');
}, true);

/* ── 外改探测：窗口获得焦点时比对磁盘 mtime ── */
window.addEventListener('focus', async () => {
  if (!filePath) return;
  const origin = { documentId, filePath };
  const r = await window.mpHost.outsideChange(origin.filePath);
  if (documentId !== origin.documentId || filePath !== origin.filePath) return;
  if (!r || !r.changed) return;
  // A late disk notice cannot replace the current document's recovery actions.
  // outsideChange is read-only; later focus still compares the actual disk.
  if (saveBlocked || lastSaveError) return;
  if (r.missing) { saveBlocked = true; showBanner('磁盘上的文件已不在，请另存为保留当前内容。', [{ label: '另存为…', run: () => { void saveAsFlow(); } }]); return; }
  /* 【第二波·cross-window 缺陷·2026-10-10】这里原来调 `openPath(filePath)`：
     openPath **不带落点**时用主会话 + 最后创建的窗口收尾 ⇒ 多窗口下"自动重载"会把内容灌进
     别的窗口（实测：只改 A 的 mtime、点 B 再点 A ⇒ B 自报变成 A 的文档）。
     改用 `reload()`（file:reload，壳侧已按**发起窗口**的会话/窗口收尾）⇒ 只重载我自己这一份。 */
  if (!dirty) {
    const fresh = await reloadDocument({ origin: 'watcher' });
    if (fresh && fresh.ok === false) return;
  } else {
    showBanner('磁盘上的文件已被其他程序修改。', [
      { label: '载入磁盘版本', run: async () => { await reloadDocument({ origin: 'disk' }); } },
      { label: '保留我的修改', run: () => { void doSave(true); } },
    ]);
  }
}, true);

/* The init handshake reads the document once the engine is registered. */
(async () => {
  try {
    const t = await window.mpHost.themeGet();
    // 【不再改写 editor-theme】只有"用户从未选过配色"时才用壳层模式落一套默认；已选过就尊重用户选择。
    let hasChoice = false;
    try { hasChoice = !!localStorage.getItem('editor-theme'); } catch { }
    if (!hasChoice) applyTheme(t.dark);
  } catch { }
  refreshTitle();
})();
