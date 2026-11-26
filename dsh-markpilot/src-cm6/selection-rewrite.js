// selection-rewrite.js — 选区 AI 润色审阅（内核）
//
// 产品契约（用户可见）：
//   1. 用户在正文里选中一段 Markdown ⇒ 触发「AI 润色」（菜单/快捷键由宿主接线）。
//   2. **只发选区**：请求体里绝不夹带整篇文档；正文其余字符不出本机。
//   3. 回来以后就地给出**词级增删对比**（删除 = 红色删除线，新增 = 绿色下划线），
//      采纳/拒绝由用户决定。未采纳前**正文一个字都不变**（保存、导出、脏标都不受影响）。
//   4. 采纳 = 一次事务 ⇒ 一步 Ctrl+Z 回到润色前，且不会顺手撤掉用户上一段手打。
//   5. 原选区/正文变化、切换文档、重复请求、超时/取消/失败/未配置 ⇒ 一律不发生错误覆盖。
//
// 设计纪律（与仓库既有约定对位）：
//   · 判「还在原地」用**文档身份 + 区间文本逐字节相同**，不看位置数字（位置会被别处的编辑平移）；
//   · 面板的 Tab/Shift+Tab/Esc 只在面板真正持有焦点时接管，输入法组字期间一律让路；
//   · 写正文的动作**只有一处**（commit/accept），其余全是只读投影；
//   · 不读文件、不碰 localStorage、不改扩展数组 —— 请求由注入的 `request` 通道完成，
//     内核因此可以脱离宿主单测，也能被同样的方式接进 EXE 与 DSH 插件。
//
// 导出面：
//   installSelectionRewrite({ getView, toast, request?, labels?, onState? }) -> { open, close, accept, reject, state }
//   宿主唯一必接的是前两个；`request` 缺省时按 hostTransport() 找通道（见下）。

import { EditorSelection } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';

/* ───────────────────────── 纯函数层（可单测，不依赖 DOM / 编辑器） ───────────────────────── */

/** 词级切分：CJK 逐字，拉丁/数字按词，空白与标点各自成段。
 *  不用 Intl.Segmenter：它把中文切成整段词组，词级增删就看不见了；
 *  润色审阅要的恰恰是"哪几个字被换了"，所以 CJK 一律逐字。 */
const WORD_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]|[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*|\s+|[^\s\p{L}\p{N}]/gu;

export function segmentWords(text) {
  const value = String(text ?? '');
  const out = [];
  WORD_RE.lastIndex = 0;
  let match;
  while ((match = WORD_RE.exec(value))) out.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  return out;
}

/** 词级 diff：[{type:'equal'|'delete'|'insert', text}]。
 *  带公共前后缀裁剪的 LCS；编辑距离超过阈值时退化为"整段删除 + 整段新增"，
 *  保证大选区的耗时可控（宁可粗一点，也不让面板卡住）。 */
export function wordDiff(before, after, { maxCells = 4_000_000 } = {}) {
  const a = segmentWords(before), b = segmentWords(after);
  const AL = a.map(x => x.text), BL = b.map(x => x.text);
  let head = 0;
  while (head < AL.length && head < BL.length && AL[head] === BL[head]) head++;
  let tailA = AL.length, tailB = BL.length;
  while (tailA > head && tailB > head && AL[tailA - 1] === BL[tailB - 1]) { tailA--; tailB--; }
  const midA = AL.slice(head, tailA), midB = BL.slice(head, tailB);
  const out = [];
  const push = (type, text) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text; else out.push({ type, text });
  };
  if (head) push('equal', AL.slice(0, head).join(''));
  if (midA.length === 0 || midB.length === 0) {
    push('delete', midA.join('')); push('insert', midB.join(''));
  } else if (midA.length * midB.length > maxCells) {
    push('delete', midA.join('')); push('insert', midB.join(''));
  } else {
    const n = midA.length, m = midB.length, stride = m + 1;
    const table = new Uint32Array((n + 1) * stride);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * stride + j] = midA[i] === midB[j]
          ? table[(i + 1) * stride + j + 1] + 1
          : Math.max(table[(i + 1) * stride + j], table[i * stride + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { push('equal', midA[i]); i++; j++; }
      else if (table[(i + 1) * stride + j] >= table[i * stride + j + 1]) { push('delete', midA[i]); i++; }
      else { push('insert', midB[j]); j++; }
    }
    while (i < n) { push('delete', midA[i]); i++; }
    while (j < m) { push('insert', midB[j]); j++; }
  }
  if (tailA < AL.length) push('equal', AL.slice(tailA).join(''));
  return out;
}

/** diff ⇒ 面向阅读的行：delete 紧跟 insert 认成"替换"，便于并排看原文与润色后。 */
export function diffSummary(ops) {
  let deleteChars = 0, insertChars = 0;
  const runs = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type === 'equal') { runs.push({ kind: 'equal', before: op.text, after: op.text }); continue; }
    if (op.type === 'delete' && ops[i + 1]?.type === 'insert') {
      runs.push({ kind: 'replace', before: op.text, after: ops[i + 1].text });
      deleteChars += op.text.length; insertChars += ops[i + 1].text.length;
      i++;
      continue;
    }
    if (op.type === 'delete') { runs.push({ kind: 'delete', before: op.text, after: '' }); deleteChars += op.text.length; }
    else { runs.push({ kind: 'insert', before: '', after: op.text }); insertChars += op.text.length; }
  }
  return { runs, deleteChars, insertChars, changed: deleteChars + insertChars > 0 };
}

/** 请求体：**只有选区**（外加语言提示与用途），没有任何整篇文档字段。
 *  这是产品承诺的落地处 —— 任何新增字段都必须先问"它会不会泄露正文其余部分"。 */
export function buildRequest({ text, instruction, language, app } = {}) {
  return {
    purpose: 'selection-rewrite',
    app: String(app || 'MarkPilot'),
    language: String(language || 'zh-CN'),
    instruction: String(instruction || ''),
    selection: String(text ?? ''),
  };
}

export const SYSTEM_PROMPT = [
  '你是 Markdown 文本的润色助手。用户会给你一段选中的 Markdown 原文。',
  '任务：在不改变原意与事实的前提下润色这段文字，使其更准确、简洁、通顺。',
  '硬性要求：',
  '1. 只返回润色后的 Markdown 文本本身；不要解释、不要前言、不要代码围栏包裹。',
  '2. 保持原有的 Markdown 结构（标题层级、列表符号、强调标记、链接、行内代码、公式 $…$）。',
  '3. 不要增删列表项，不要改变引用块的层级。',
  '4. 保留原文的语言（中文就还是中文，英文就还是英文）。',
  '5. 如果原文已经足够好，就把原文原样返回。',
].join('\n');

export function buildMessages(request, systemPrompt = SYSTEM_PROMPT) {
  const text = String(request?.selection ?? '');
  const hint = request?.instruction ? `\n\n额外要求：${request.instruction}` : '';
  return [
    { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
    {
      role: 'user',
      content: [{
        type: 'text',
        text: `请润色下面这段 Markdown（只发这一段）：\n\n<<<SELECTION\n${text}\nSELECTION>>>${hint}`,
      }],
    },
  ];
}

/** 回包清洗：**只做有证据的剥离**，不按原文前缀/长度猜"这是回显"。
 *
 *  四条反例定下的纪律（每条都有实测，见 ai-status.md §反例）：
 *   ① `cleanReply("收益持平，风险回落。", "收益持平")` 旧实现返回 `"，风险回落。"`
 *      —— 把"结果以原文开头"当成回显裁掉，**吃掉了合法正文**。现在**永不按原文前缀删字**。
 *   ② 输出以合法 Markdown 围栏起首、后面还跟正文时（` ```x … ``` \n\n后续正文 `），
 *      旧实现的正则把整段当成"被围栏包裹的结果"，**后续正文连同围栏一起丢掉**。
 *      现在只有「整段恰好就是一个围栏块」才剥，且**围栏内的内容原样保留**。
 *   ③ 空 / 纯空白回包会被当成"润色成空串"，采纳等于**删掉整段**。现在返回 `''`，
 *      由调用方（内核）判成失败 —— 清洗层不替调用方决定"空"是否合法。
 *   ④ 尾随换行是合法正文的一部分（段落间空行、结尾硬换行），**不再吞掉**。
 *
 *  `original` 参数保留只为兼容旧签名；现在**不再用它做裁剪**（它是"猜回显"的唯一来源）。 */
export function cleanReply(raw, original = '') {
  void original;                       // 显式声明：这里故意不看原文（否则又会滑回"按前缀删字"）
  let text = String(raw ?? '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return '';         // 空/纯空白 ⇒ 交给调用方判失败，绝不返回"全部删掉"的合法结果

  /* 只剥我们**自己**在提示词里加的标记（这两样不可能是用户的合法正文）。 */
  text = text.replace(/^[ \t]*<<<SELECTION[^\n]*\n?/, '').replace(/\n?SELECTION>>>[ \t]*$/, '');
  if (!text.trim()) return '';

  /* 围栏：仅当「整段就是一个围栏块」时才剥。判据是**围栏块之外什么都没有**
     （允许围栏块前后有空行）。这样"围栏 + 后续正文"一律原样保留。 */
  const whole = /^[ \t]*\n*(\`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\1[ \t]*\n*$/.exec(text);
  if (whole) {
    const open = whole[1], info = whole[2].trim(), body = whole[3];
    /* 只有当这不是"用户本来就是一段代码块"时才剥：
       若原文本身就以同种围栏起首，那围栏是内容的一部分，必须原样留着。 */
    const originalIsFence = /^[ \t]*\n*(\`{3,}|~{3,})/.test(String(original ?? ''));
    const bareLanguage = /^(markdown|md|text|plaintext|markdown-it)?$/i.test(info);
    if (!originalIsFence && bareLanguage) return body;
  }

  return text;
}

/** 回包是否"空到不可采纳"：空串或纯空白。
 *  单列一个判据是因为"空"在这个功能里等于**删掉用户整段**，必须显式失败。 */
export function isEmptyReply(text) {
  return !String(text ?? '').trim();
}

/* ───────────────────────── 传输通道 ───────────────────────── */

/** 默认通道（按优先级）：
 *   ① 宿主桥 `window.mpHost.aiRewrite(payload, { signal })` —— EXE 主进程执行（推荐，渲染进程零网络）；
 *   ② 探针/验收钩子 `window.__mpAiRewriteTransport` —— 只在宿主显式给出时存在（headless 验收用）；
 *   ③ 都没有 ⇒ 明确报"尚未接入"，绝不假装成功、也绝不偷偷降级成"直接拿渲染进程去请求"。 */
export function hostTransport(scope = (typeof window !== 'undefined' ? window : undefined)) {
  const bridge = scope?.mpHost;
  if (bridge && typeof bridge.aiRewrite === 'function') {
    return (payload, options) => bridge.aiRewrite(payload, {
      requestId: options?.id == null ? '' : String(options.id),
    });
  }
  if (typeof scope?.__mpAiRewriteTransport === 'function') {
    return (payload, options) => scope.__mpAiRewriteTransport(payload, options);
  }
  return null;
}

/** 取消通道：AbortSignal 过不了 IPC，所以主进程侧要按 requestId 精确 abort。
 *  有没有这条桥决定"放弃"是**真的停掉网络**还是只丢弃回包——两者都不写正文，但前者省额度。
 *  返回 null 表示宿主没提供取消能力（内核会退化：只丢弃回包，并在 state 里如实反映）。 */
export function hostCancel(scope = (typeof window !== 'undefined' ? window : undefined)) {
  const bridge = scope?.mpHost;
  if (bridge && typeof bridge.aiRewriteCancel === 'function') {
    return (requestId) => bridge.aiRewriteCancel(String(requestId));
  }
  return null;
}

const MISSING_BRIDGE = '本次构建还没有接入 AI 通道（宿主缺 mpHost.aiRewrite）；'
  + '请在「设置 → AI 润色」里确认 provider 与模型，并更新到含该通道的版本';

/* ───────────────────────── 内核 ───────────────────────── */

const DEFAULT_LABELS = {
  panelTitle: 'AI 润色审阅',
  pending: '正在润色选中的文字…',
  emptySelection: '请先选中要润色的文字',
  unchanged: '这段文字已经足够好了，没有改动',
  emptyReply: 'AI 返回了空内容，这次结果不能用（采纳它会删掉整段文字）',
  accept: '采纳 (Tab)',
  reject: '放弃 (Esc)',
  retry: '重试',
  applied: '已采纳润色，Ctrl+Z 可撤销',
  discarded: '已放弃本次润色',
  notConfigured: '还没有配置 AI 服务：请在「设置 → AI 润色」里填写 provider、模型与密钥',
  notWired: MISSING_BRIDGE,
  failed: '润色失败',
  cancelled: '已取消',
  stale: '原文已变化，本次润色已失效',
  selectionMoved: '选区已改变，本次润色已失效',
  readOnly: '只读模式下不能采纳润色',
  multiRange: '请只选择一段文字（多光标暂不支持润色）',
  tooLong: '选区过长，请分段润色',
};

const MAX_SELECTION_CHARS = 24000;
const WATCH_INTERVAL_MS = 300;

export function installSelectionRewrite(options = {}) {
  const getView = typeof options.getView === 'function' ? options.getView : () => null;
  const toast = typeof options.toast === 'function' ? options.toast : () => {};
  const labels = { ...DEFAULT_LABELS, ...(options.labels || {}) };
  const provided = typeof options.request === 'function' ? options.request : null;
  const onState = typeof options.onState === 'function' ? options.onState : null;

  let panel = null;
  let session = null;
  let serial = 0;
  let installed = false;
  let watch = null;

  const view = () => { try { return getView() || null; } catch { return null; } };

  function emit(kind, detail) {
    if (!onState) return;
    try { onState({ kind, ...(detail || {}) }); } catch { /* 观察者异常不影响正文 */ }
  }

  function request(body, ctx) {
    const channel = provided || hostTransport();
    if (!channel) return Promise.resolve({ ok: false, code: 'not-wired', message: labels.notWired });
    try { return Promise.resolve(channel(body, ctx)); }
    catch (error) { return Promise.resolve({ ok: false, code: 'threw', message: String(error?.message || error) }); }
  }

  /** 放弃在途请求时调用：有宿主取消桥就让它**真的停网络**（省额度）；
   *  没有就退化为"只丢弃回包"（正文不会被写，这一点两种情形都由 session.id 比对保证）。 */
  function cancelRemote(current) {
    if (!current || current.remoteCancelled) return false;
    if (current.cancelled) return false;
    current.cancelled = true;
    const cancel = hostCancel();
    if (!cancel) { emit('cancel-unavailable', { id: current.id }); return false; }
    try {
      Promise.resolve(cancel(current.id)).then((reply) => {
        emit('cancel-result', { id: current.id, cancelled: !!(reply && reply.cancelled === true) });
      }).catch(() => { /* 取消失败不影响正文安全 */ });
      return true;
    } catch { return false; }
  }

  /* ---- 锚点：内容前缀 + 选区文本 + 文档作用域 ----
     为什么不用「doc 对象相同」当主判据：CM6 里**每一次改动都会换一个新的 Text 实例**，
     拿对象身份比就等于"面板开着时用户一个字都不能再打"，过度失效；而只看位置数字又太松。
     真正既正确又不误伤的口径是：
       ① 选区前面那段前缀逐字节没变（前缀变了 ⇒ 位置已经平移 ⇒ 原位已经不是我选的那段）；
       ② [from,to) 上仍然是当初选的那段文字（逐字节）；
       ③ 文档作用域没变（宿主切文档/重建视图 ⇒ 换作用域）。
     满足①②时，[from,to) 里装的就是用户的原文，写它 == 替换用户选的那段，不可能写错地方。
     选区**之后**的编辑不影响①② ⇒ 用户可以在面板开着时继续在文末写东西。 */

  const viewIds = new WeakMap();
  let nextViewId = 1;
  const viewIdOf = (viewInstance) => {
    if (!viewInstance || typeof viewInstance !== 'object') return 0;
    if (!viewIds.has(viewInstance)) viewIds.set(viewInstance, nextViewId++);
    return viewIds.get(viewInstance);
  };
  const scopeOf = typeof options.scopeOf === 'function' ? options.scopeOf : () => '';
  function scopeNow(viewInstance) {
    let host = '';
    try { host = String(scopeOf(viewInstance) ?? ''); } catch { host = ''; }
    return `${viewIdOf(viewInstance)}|${host}`;
  }

  function captureTarget(viewInstance) {
    const state = viewInstance.state;
    if (state.readOnly) return { readOnly: true };
    const selection = state.selection;
    if (selection.ranges.length !== 1) return { multiRange: true, ranges: selection.ranges.length };
    const range = selection.main;
    if (range.empty) return null;
    const from = range.from, to = range.to;
    const text = state.doc.sliceString(from, to);
    if (!text.trim()) return null;
    if (text.length > MAX_SELECTION_CHARS) return { tooLong: true, chars: text.length };
    return {
      from, to, text,
      anchor: range.anchor, head: range.head,
      prefix: state.doc.sliceString(0, from),
      suffix: state.doc.sliceString(to),
      scope: scopeNow(viewInstance),
      view: viewInstance,
      docLength: state.doc.length,
    };
  }

  /** 原选区是否还在，且**眼前这个视图的当前选区**仍然是它。
   *
   *  为什么不能只看 doc 内容（主控报的缺陷）：
   *   · 「仅移动选区」时文档逐字节没变 ⇒ 内容判据全过，但用户的实际选区已经搬到别处，
   *     这时按 Tab 采纳会把文本写到用户**已经不看**的那一段上；
   *   · 「相同文本切了文件」时两份文件内容可能一模一样 ⇒ 内容判据全过，但这是另一份文档。
   *  所以这里同时核实四件事：① 还是同一个视图实例；② 作用域（宿主文档身份）没变；
   *  ③ 当前选区是**单范围且 from/to 与锚点相等**；④ 文档上 [from,to) 与 [0,from) 逐字节没变。
   *
   *  `requireSelection` 默认 true（就绪态核对用）。内部巡检（回包到达、失效侦测）传 false：
   *  那时用户可能刚点了一下别处，我们的判据应该是"内容变了没"，而不是"选区还在不在"
   *  —— 后者由 selectionchange 专门负责，两条分开才不会被面板自身夺焦误触发。 */
  function targetStillValid(viewInstance, target, { requireSelection = true } = {}) {
    if (!viewInstance || !target || target.readOnly || target.multiRange) return false;
    /* ① 同一个视图实例：宿主重建视图（切文件、重载、分屏切换）就不再是同一次审阅。 */
    if (target.view !== viewInstance) return false;
    let state;
    try { state = viewInstance.state; } catch { return false; }
    if (!state || !state.doc) return false;
    if (target.from < 0 || target.to <= target.from) return false;
    if (target.to > state.doc.length) return false;
    /* ② 作用域（宿主文档身份：EXE 是文件路径，插件是文档 id）。 */
    if (scopeNow(viewInstance) !== target.scope) return false;
    /* ③ 当前选区必须就是当初那一段（单范围 + from/to 相等）。
       只允许"用户没动过选区"这一种情形，否则宁可不写。 */
    if (requireSelection) {
      let selection;
      try { selection = state.selection; } catch { return false; }
      if (!selection || !Array.isArray(selection.ranges) || selection.ranges.length !== 1) return false;
      const main = selection.main;
      if (!main || main.from !== target.from || main.to !== target.to) return false;
    }
    /* ④ 内容逐字节没变（区间 + 前缀）。 */
    try {
      if (state.doc.sliceString(target.from, target.to) !== target.text) return false;
      if (state.doc.sliceString(0, target.from) !== target.prefix) return false;
    } catch { return false; }
    return true;
  }

  function liveRange(viewInstance, target) {
    return targetStillValid(viewInstance, target) ? { from: target.from, to: target.to } : null;
  }

  /* ---- 面板 DOM ---- */

  const CSS_ID = 'mp-rewrite-style';
  const ANCHOR_CLASS = 'mp-rw-anchor';
  let anchorEl = null;

  function ensureStyle() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement('style');
    style.id = CSS_ID;
    style.textContent = `
.mp-rw-panel{position:fixed;z-index:75;left:50%;transform:translateX(-50%);bottom:64px;
  width:min(760px,calc(100vw - 48px));max-height:min(62vh,520px);display:flex;flex-direction:column;
  background:var(--mp-bg,#fff);color:var(--mp-fg,#1f2328);
  border:1px solid var(--mp-border,#d0d7de);border-radius:10px;
  box-shadow:0 10px 30px rgba(0,0,0,.18);font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;
  overflow:hidden}
.mp-rw-head{display:flex;align-items:center;gap:8px;padding:8px 12px;
  border-bottom:1px solid var(--mp-border,#d0d7de);background:var(--mp-codeBg,rgba(127,127,127,.06))}
.mp-rw-title{font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-rw-stat{opacity:.72;font-variant-numeric:tabular-nums;white-space:nowrap}
.mp-rw-body{padding:10px 12px;overflow:auto;flex:1;white-space:pre-wrap;word-break:break-word}
.mp-rw-body.is-pending{opacity:.72}
.mp-rw-body.is-error{color:#b32d2e}
.mp-rw-foot{display:flex;gap:8px;justify-content:flex-end;padding:8px 12px;
  border-top:1px solid var(--mp-border,#d0d7de);background:rgba(127,127,127,.04)}
.mp-rw-btn{font:inherit;padding:4px 12px;border-radius:6px;cursor:pointer;
  border:1px solid var(--mp-border,#d0d7de);background:transparent;color:inherit}
.mp-rw-btn:hover{background:rgba(127,127,127,.14)}
.mp-rw-btn.primary{border-color:var(--mp-primary,#0969da);background:var(--mp-primary,#0969da);color:#fff}
.mp-rw-btn:disabled{opacity:.45;cursor:default}
.mp-rw-del{color:#b32d2e;text-decoration:line-through;text-decoration-thickness:1.5px}
.mp-rw-ins{color:#1a7f37;text-decoration:underline;text-decoration-thickness:1.5px;text-underline-offset:2px}
.mp-rw-anchor{position:fixed;z-index:74;pointer-events:none;border-radius:3px;
  background:color-mix(in srgb,var(--mp-primary,#0969da) 12%,transparent);
  outline:1px dashed color-mix(in srgb,var(--mp-primary,#0969da) 55%,transparent);outline-offset:1px}
@media (prefers-color-scheme:dark){
  .mp-rw-del{color:#ff7b72}.mp-rw-ins{color:#7ee787}
  .mp-rw-panel{box-shadow:0 10px 30px rgba(0,0,0,.5)}
}`;
    document.head.appendChild(style);
  }

  function mount() {
    ensureStyle();
    const el = document.createElement('div');
    el.className = 'mp-rw-panel';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', labels.panelTitle);
    el.dataset.mpRewrite = '1';
    const head = document.createElement('div');
    head.className = 'mp-rw-head';
    const title = document.createElement('span');
    title.className = 'mp-rw-title';
    title.textContent = labels.panelTitle;
    const stat = document.createElement('span');
    stat.className = 'mp-rw-stat';
    head.append(title, stat);
    const body = document.createElement('div');
    body.className = 'mp-rw-body';
    body.setAttribute('tabindex', '-1');
    const foot = document.createElement('div');
    foot.className = 'mp-rw-foot';
    el.append(head, body, foot);
    (document.body || document.documentElement).appendChild(el);
    return { el, title, stat, body, foot, buttons: [] };
  }

  function setButtons(node, specs) {
    node.foot.textContent = '';
    node.buttons = specs.map((spec) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mp-rw-btn' + (spec.primary ? ' primary' : '');
      b.textContent = spec.label;
      b.disabled = !!spec.disabled;
      b.dataset.mpRewriteAction = spec.action;
      b.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        try { spec.onClick?.(); } catch { /* 忽略 */ }
      });
      node.foot.appendChild(b);
      return b;
    });
  }

  function renderDiff(node, summary) {
    node.body.classList.remove('is-pending', 'is-error');
    node.body.textContent = '';
    const frag = document.createDocumentFragment();
    for (const run of summary.runs) {
      const plain = (text) => frag.appendChild(document.createTextNode(text));
      if (run.kind === 'equal') { plain(run.after); continue; }
      const span = (cls, text) => {
        const el = document.createElement('span');
        el.className = cls;
        el.textContent = text;
        frag.appendChild(el);
      };
      if (run.kind === 'replace') { span('mp-rw-del', run.before); span('mp-rw-ins', run.after); }
      else if (run.kind === 'delete') span('mp-rw-del', run.before);
      else span('mp-rw-ins', run.after);
    }
    node.body.appendChild(frag);
    node.stat.textContent = `−${summary.deleteChars} 字 / +${summary.insertChars} 字`;
  }

  function renderMessage(node, text, kind) {
    node.body.classList.toggle('is-pending', kind === 'pending');
    node.body.classList.toggle('is-error', kind === 'error');
    node.body.textContent = text;
    if (kind === 'pending') node.stat.textContent = '';
  }

  /* ---- 就地锚点（辅助视觉，全部 try/catch；失败不留残迹） ---- */

  function paintAnchor() {
    clearAnchor();
    const v = view();
    if (!v || !session || !session.target || !v.coordsAtPos || !v.dom || !v.dom.isConnected) return;
    try {
      const { from } = session.target;
      const line = v.state.doc.lineAt(from);
      const start = v.coordsAtPos(line.from);
      const end = v.coordsAtPos(Math.min(line.to, line.from + 400));
      if (!start || !end) return;
      const el = document.createElement('div');
      el.className = ANCHOR_CLASS;
      const zoom = parseFloat(getComputedStyle(v.contentDOM).zoom) || 1;
      el.style.left = `${Math.min(start.left, end.left)}px`;
      const height = Math.max(1, Math.round(1.45 * (start.bottom - start.top)));
      el.style.top = `${start.top}px`;
      el.style.width = `${Math.max(8, Math.abs(end.left - start.left) || 8) / zoom}px`;
      el.style.height = `${height / zoom}px`;
      (document.body || document.documentElement).appendChild(el);
      anchorEl = el;
    } catch { anchorEl = null; }
  }

  function clearAnchor() {
    if (anchorEl) { try { anchorEl.remove(); } catch { /* 已移除 */ } anchorEl = null; }
  }

  function detach() {
    clearAnchor();
    stopWatch();
    if (panel) {
      try { panel.el.remove(); } catch { /* 已被移除 */ }
      panel = null;
    }
  }

  /* ---- 焦点/键盘：只在面板自己持有焦点时接管；输入法组字期间让路 ---- */

  function focusFirstEnabled() {
    if (!panel) return;
    const target = (panel.buttons || []).find(b => !b.disabled) || panel.body;
    try { target.focus({ preventScroll: true }); } catch { /* 无焦点能力 */ }
  }

  /** 就绪态的**默认焦点**：放在面板正文容器（`tabindex=-1`）上，而**不是**某个按钮。
   *
   *  为什么：按钮顺序是「放弃 → 采纳」，都把焦点给第一个可用按钮就等于默认焦点落在"放弃"上；
   *  而 Tab 一旦在按钮上就只能轮转（否则 Shift+Tab 走到「放弃」后再按 Tab 会被当成采纳，
   *  键盘用户会被困住）⇒ 实际用户**永远按不出一次 Tab 采纳**（主控在真机复现）。
   *  默认焦点给容器后：普通 Tab 直接采纳；Shift+Tab 照常轮转到按钮（可达性不变）；
   *  Enter 在按钮上照常激活。 */
  function focusReadyDefault() {
    if (!panel) return;
    const target = panel.body || (panel.buttons || []).find(b => !b.disabled);
    try { target.focus({ preventScroll: true }); } catch { /* 无焦点能力 */ }
  }

  /** 按当前阶段决定默认焦点：就绪给容器（Tab 可采纳），其余给第一个可用按钮（Enter 可激活）。 */
  function focusDefault() {
    if (session && session.phase === 'ready') focusReadyDefault();
    else focusFirstEnabled();
  }

  /** 焦点是否落在"可输入控件"里：这类控件里的 Tab 必须留给用户走焦点遍历，
   *  不能被我们抢去当"采纳"（否则用户在一个多行输入框里想缩进/换焦点时文档被改）。 */
  function focusInEditable(node) {
    if (!node || typeof node !== 'object') return false;
    const tag = String(node.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (node.isContentEditable === true) return true;
    if (typeof node.getAttribute === 'function' && node.getAttribute('contenteditable') === 'true') return true;
    return false;
  }

  /** 面板键盘：
   *   · 就绪态：**Tab = 采纳**、**Esc = 拒绝**（主控要求的真人手感：Tab 就是"接受建议"）；
   *   · Shift+Tab 始终**轮转按钮焦点**（可达性：只用键盘的用户必须能走到"放弃/重试"上）；
   *   · 未就绪（pending/failed）时 Tab 也走轮转（没有可采纳的结果，抢 Tab 只会让人困惑）；
   *   · 组字中（isComposing / keyCode 229）一律让路给输入法；
   *   · 焦点不在面板里 或 落在输入控件里 ⇒ 一律不接管。 */
  function onPanelKeyDown(event) {
    if (!panel || !session) return;
    if (event.isComposing || event.keyCode === 229) return;     // 组字中的键归输入法
    const target = event.target;
    if (!(panel.el.contains(target) || panel.el === target)) return;   // 焦点在框外 ⇒ 不接管
    if (focusInEditable(target)) return;                              // 焦点在输入控件里 ⇒ 让路

    const ready = session.phase === 'ready';

    if (event.key === 'Escape' || event.keyCode === 27) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) reject('escape');
      return;
    }

    if (event.key === 'Tab') {
      /* 就绪 + 不是 Shift+Tab ⇒ **采纳**（主控在真机要求的一次 Tab 采纳）。
         焦点在容器上还是在按钮上都算：默认焦点现在给容器，但用户可能先 Shift+Tab 走到按钮，
         再按 Tab —— 那时若只轮转，就退化成"按不出采纳"（这正是先前实测到的缺陷）。
         可达性由 Shift+Tab 保证（永远轮转），以及失败/等待态一律轮转。 */
      const onButton = !!(target && target.dataset && target.dataset.mpRewriteAction);
      if (ready && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) accept();
        return;
      }
      const list = (panel.buttons || []).filter(b => !b.disabled);
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!list.length) return;
      const index = list.indexOf(document.activeElement);
      const step = event.shiftKey ? -1 : 1;
      const next = list[(index + step + list.length) % list.length] || list[0];
      try { next.focus({ preventScroll: true }); } catch { /* 忽略 */ }
      void onButton;
      return;
    }

    if (event.key === 'Enter' || event.keyCode === 13) {
      const active = document.activeElement;
      if (active && active.dataset && active.dataset.mpRewriteAction) {
        event.preventDefault();
        event.stopImmediatePropagation();
        active.click();
      }
    }
  }

  function install() {
    if (installed) return;
    installed = true;
    document.addEventListener('keydown', onPanelKeyDown, true);
    document.addEventListener('selectionchange', onSelectionChange);
  }

  function uninstall() {
    if (!installed) return;
    installed = false;
    document.removeEventListener('keydown', onPanelKeyDown, true);
    document.removeEventListener('selectionchange', onSelectionChange);
  }

  /* ---- 失效侦测：宿主可显式调 onDocChange；另有面板存活期间的轻量轮询兜底 ----
     （内核不拥有编辑器扩展，挂不了 updateListener；轮询只在有会话时运行，代价是一次区间字符串比较）
     分工（两条判据刻意不混）：
       · onDocChange —— 只问"内容/作用域/视图变了没"（requireSelection:false）；
         用户点一下别处不该让面板消失，那是 selectionchange 的职责。
       · onSelectionChange —— 再问"当前选区还是不是那一段"；不是 ⇒ 失效并给专门的提示。 */
  function onDocChange() {
    if (!session) return;
    const v = view();
    if (!v) { fail('view-gone'); return; }
    if (!targetStillValid(v, session.target, { requireSelection: false })) fail('stale');
    else paintAnchor();
  }

  function onSelectionChange() {
    if (!session) return;
    const v = view();
    if (!v) { fail('view-gone'); return; }
    if (!targetStillValid(v, session.target, { requireSelection: false })) { fail('stale'); return; }
    /* 选区本身被挪走/折叠：面板讲的已经不是眼前的选区，关掉它（提示文案与"内容变了"区分开）。
       为什么这不是"过度敏感"：面板里的按钮拿焦点**不改变** CM6 的 selection（那是 state，不是 DOM 选区），
       所以这里只会被真实的用户选择动作触发。 */
    const sel = v.state.selection;
    const main = sel.main;
    if (sel.ranges.length !== 1 || main.from !== session.target.from || main.to !== session.target.to) fail('moved');
  }

  function startWatch() {
    stopWatch();
    if (typeof setInterval !== 'function') return;
    watch = setInterval(() => { if (!session) { stopWatch(); return; } onDocChange(); }, WATCH_INTERVAL_MS);
    watch?.unref?.();
  }

  function stopWatch() {
    if (watch) { clearInterval(watch); watch = null; }
  }

  /** 失效：**只关面板，绝不写正文**。
   *  `moved`（选区被挪走）与 `stale`（内容/视图/作用域变了）给不同的提示，
   *  因为用户该做的事不同：前者"重新选一段再试"，后者"重新发起"。 */
  function fail(reason) {
    const current = session;
    if (!current) return false;
    if (current.controller) { try { current.controller.abort(); } catch { /* 已中止 */ } }
    cancelRemote(current);
    session = null;
    detach();
    uninstall();
    const message = reason === 'moved' ? labels.selectionMoved : labels.stale;
    toast(message, 2600);
    emit('stale', { id: current.id, reason, message });
    return true;
  }

  /* ---- 生命周期 ---- */

  function reject(reason = 'user') {
    const current = session;
    if (!current) return false;
    if (current.controller) { try { current.controller.abort(); } catch { /* 已中止 */ } }
    cancelRemote(current);
    const wasPending = current.phase === 'pending';
    session = null;
    detach();
    uninstall();
    if (reason === 'escape' || reason === 'user' || reason === 'close') {
      if (!wasPending) toast(labels.discarded, 2000);
    } else if (reason === 'stale') toast(labels.stale, 2600);
    emit('reject', { reason, id: current.id });
    try { current.onReject?.(reason); } catch { /* 忽略 */ }
    return true;
  }

  /** 采纳：一次 dispatch = 一次可撤销事务（isolateHistory 与前后手打隔开）。
   *  写入前按**最严**口径复核（含当前选区仍是那一段）—— 主控报的"仅移动选区"缺陷就在这里挡住。 */
  function accept() {
    const current = session;
    if (!current || current.phase !== 'ready') return false;
    const v = view();
    if (!v) { fail('view-gone'); return false; }
    if (!targetStillValid(v, current.target, { requireSelection: true })) {
      /* 区分两种失效，给不同提示：内容变了 vs 只是选区被挪走。 */
      const contentChanged = !targetStillValid(v, current.target, { requireSelection: false });
      fail(contentChanged ? 'stale' : 'moved');
      return false;
    }
    if (v.state.readOnly) { toast(labels.readOnly, 2600); return false; }
    const { from, to } = current.target;
    const insert = current.result;
    try {
      v.dispatch({
        changes: { from, to, insert },
        selection: EditorSelection.cursor(from + insert.length),
        userEvent: 'input.ai-rewrite',
        scrollIntoView: true,
        annotations: isolateHistory.of('full'),
      });
    } catch (error) {
      toast(`${labels.failed}：${String(error?.message || error)}`, 4000);
      emit('failed', { id: current.id, code: 'dispatch', message: String(error?.message || error) });
      return false;
    }
    const id = current.id;
    session = null;
    detach();
    uninstall();
    toast(labels.applied, 2400);
    emit('accept', { id, from, to, chars: insert.length });
    try { v.focus(); } catch { /* 忽略 */ }
    try { current.onAccept?.({ from, to, insert }); } catch { /* 忽略 */ }
    return true;
  }

  /** 发起一次审阅。返回 'started' | 'pending' | 'busy-ready' | 'no-selection' | 'too-long' | 'unsupported'。 */
  function open(openOptions = {}) {
    const v = view();
    if (!v) return 'unsupported';
    if (session) {
      // 重复请求：待回包期间不再叠第二个（两条回包会互相竞速）；已就绪则按当前选区重来。
      if (session.phase === 'pending') { toast(labels.pending, 1800); return 'pending'; }
      const previous = session;
      session = null; detach(); uninstall();
      emit('reject', { reason: 'replace', id: previous.id });
    }
    const target = captureTarget(v);
    if (!target) { toast(labels.emptySelection, 2400); return 'no-selection'; }
    if (target.readOnly) { toast(labels.readOnly, 2400); return 'unsupported'; }
    if (target.multiRange) { toast(labels.multiRange, 2800); return 'unsupported'; }
    if (target.tooLong) { toast(`${labels.tooLong}（${target.chars} 字，上限 ${MAX_SELECTION_CHARS}）`, 3000); return 'too-long'; }

    const id = ++serial;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const node = mount();
    panel = node;
    session = {
      id, phase: 'pending', target, result: '', controller,
      onReject: openOptions.onReject, onAccept: openOptions.onAccept,
    };
    install();
    startWatch();
    paintAnchor();
    renderMessage(node, labels.pending, 'pending');
    setButtons(node, [{ label: labels.reject, action: 'reject', onClick: () => { reject('user'); } }]);
    emit('pending', { id, from: target.from, to: target.to });

    const body = buildRequest({
      text: target.text,
      instruction: openOptions.instruction || '',
      language: openOptions.language || 'zh-CN',
      app: openOptions.app || 'MarkPilot',
    });

    Promise.resolve()
      .then(() => request(body, { signal: controller?.signal, id }))
      .then((reply) => {
        if (!session || session.id !== id) return;                 // 迟到的回包：丢弃
        if (!reply || reply.ok === false) {
          const code = String(reply?.code || 'failed');
          if (code === 'cancelled' || code === 'aborted') { reject('cancel'); return; }
          const detail = String(reply?.message || '');
          session.phase = 'failed';
          const text = code === 'not-configured' ? labels.notConfigured
            : code === 'not-wired' ? labels.notWired
              : `${labels.failed}：${detail || code}`;
          renderMessage(node, text, 'error');
          setButtons(node, [
            { label: labels.retry, action: 'retry', onClick: () => { const opts = { ...openOptions }; reject('replace'); open(opts); } },
            { label: labels.reject, action: 'reject', onClick: () => { reject('user'); } },
          ]);
          focusFirstEnabled();
          emit('failed', { id, code, message: detail });
          return;
        }
        const cleaned = cleanReply(reply.text, target.text);
        /* 【反例③】空/纯空白回包 ⇒ **失败**，绝不进入"可采纳"状态。
           为什么这条必须是硬判据：空串作为替换内容 = 删掉用户整段正文，而 UI 上它会显示成
           "−N 字 / +0 字"的一个 diff —— 看起来像正常结果，按一下就把整段删了。
           实测（probe-clean-reply-counterexamples.cjs）：旧实现在这里判出 changed=true 并放行。 */
        if (isEmptyReply(cleaned)) {
          session.phase = 'failed';
          renderMessage(node, labels.emptyReply, 'error');
          setButtons(node, [
            { label: labels.retry, action: 'retry', onClick: () => { const opts = { ...openOptions }; reject('replace'); open(opts); } },
            { label: labels.reject, action: 'reject', onClick: () => { reject('user'); } },
          ]);
          focusFirstEnabled();
          emit('failed', { id, code: 'empty-reply', message: labels.emptyReply });
          return;
        }
        const summary = diffSummary(wordDiff(target.text, cleaned));
        if (!summary.changed) {
          session.phase = 'failed';
          renderMessage(node, labels.unchanged, 'info');
          setButtons(node, [{ label: '好的 (Esc)', action: 'reject', onClick: () => { reject('user'); } }]);
          focusFirstEnabled();
          emit('unchanged', { id });
          return;
        }
        /* 回包比用户改字慢 ⇒ 面板不能挂到旧区间。
           这里刻意**不要求选区仍在**：等待期间用户可能只是点了一下别处（选区变了但内容没变），
           那种情形下面板仍可挂着（采纳时 accept() 会再按 requireSelection 复核一次）。
           只有"内容/视图/作用域真的变了"才在这里失效。 */
        if (!targetStillValid(view(), target, { requireSelection: false })) {
          session = null; detach(); uninstall();
          toast(labels.stale, 3000);
          emit('stale', { id, reason: 'late' });
          return;
        }
        session.phase = 'ready';
        session.result = cleaned;
        renderDiff(node, summary);
        setButtons(node, [
          { label: labels.reject, action: 'reject', onClick: () => { reject('user'); } },
          { label: labels.accept, action: 'accept', primary: true, onClick: () => { accept(); } },
        ]);
        focusDefault();
        emit('ready', { id, deleteChars: summary.deleteChars, insertChars: summary.insertChars });
      })
      .catch((error) => {
        if (!session || session.id !== id) return;
        if (error?.name === 'AbortError' || controller?.signal?.aborted) { reject('cancel'); return; }
        session.phase = 'failed';
        renderMessage(node, `${labels.failed}：${String(error?.message || error)}`, 'error');
        setButtons(node, [{ label: labels.reject, action: 'reject', onClick: () => { reject('user'); } }]);
        focusFirstEnabled();
        emit('failed', { id, code: 'threw', message: String(error?.message || error) });
      });
    return 'started';
  }

  function close() { return session ? reject('close') : false; }

  function state() {
    if (!session) return { phase: 'idle' };
    return {
      phase: session.phase,
      id: session.id,
      from: session.target.from,
      to: session.target.to,
      sourceChars: session.target.text.length,
      resultChars: session.result.length,
    };
  }

  return {
    open, close, accept, reject, state,
    /** 宿主接线用：文档变更时调用即可让面板立刻失效（不接也有轮询兜底）。 */
    onDocChange,
    _internals: {
      captureTarget, targetStillValid, liveRange,
      segmentWords, wordDiff, diffSummary, cleanReply, buildRequest, buildMessages,
      hostTransport,
      peek: () => ({ session, panel, anchor: anchorEl }),
      dispose() { if (session) reject('dispose'); uninstall(); stopWatch(); },
    },
  };
}

export default {
  installSelectionRewrite, wordDiff, diffSummary, segmentWords,
  buildRequest, buildMessages, cleanReply, hostTransport,
};
