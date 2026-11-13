// dsh-mp-tools.js — MarkPilot 数学推导 + AI 交互工具层（DSH 皮，纯外壳）
//
// ══ 边界（硬约束）═══════════════════════════════════════════════════════
// 本文件属于**外壳**，不属于内核：
//   · 不进 core.json（sync-core 只覆盖 renderer-cm6/cm6/**），不进 host/**；
//   · 不改 CM6 引擎任何字节，不改 dsh-bridge.js，不改 lib/client.js；
//   · 对引擎只做两件事：读 window.mpEngine._view()，经 CM6 的 dispatch 写；
//   · 对宿主只用一个**既有**上行类型 insert-to-chat（父窗口已实现，且只填不发）。
// ⇒ EXE 升级后本文件零适配；删掉本文件、去掉 index.html 里那一行 script 即完全回退。
//
// ══ 操守（沿用 dsh-selection.js 已确立的八条）════════════════════════════
//   · 不轮询、不 setInterval；唯一的 setTimeout 是"已插入"徽标 1.4s 复位；
//   · 单一权威：正文只从 view.state 读，不从 DOM 反推；
//   · 输入法保护：view.composing 时不写，避免打断中文/公式输入；
//   · 每动作一次 dispatch（= 一个撤销步），带 userEvent 便于引擎分组；
//   · 不缓存文档、不驻留大对象；
//   · 工具条点击一律 preventDefault，不抢编辑器焦点；
//   · 快捷键用 capture 且只在真正处理时 stopPropagation；
//   · 出错只 console.warn，绝不冒泡打断编辑器。
//
// ══ 能力 ═══════════════════════════════════════════════════════════════
//   数学模板 9 个 · 选区包裹 5 种 · 公式自动编号 · 符号面板 60+ · AI 请求 6 类
//   下行扩展：type:'cmd'（桥有兜底分发 runHandlers，无需改桥）
(function () {
  'use strict';
  if (window.__mpToolsInstalled) return;
  window.__mpToolsInstalled = true;

  var VERSION = '1.0.0';

  /* ───────────────────────── 引擎视图 ───────────────────────── */

  /** 取当前 CM6 EditorView；引擎未 boot 或处于组合输入时返回 null。 */
  function getView() {
    var engine = window.mpEngine;
    if (!engine || typeof engine._view !== 'function') return null;
    var view;
    try { view = engine._view(); } catch (error) { return null; }
    return view && view.state && view.dispatch ? view : null;
  }

  function warn(where, error) {
    try { console.warn('[mp-tools] ' + where + ':', error); } catch (ignored) { /* 无 console */ }
  }

  // Read-only callers keep getView(); only writes release a host-focus preview.
  function getWritableView() {
    var interaction = window.__dshInteraction;
    try {
      if (interaction && typeof interaction.beforeCommand === 'function'
          && interaction.beforeCommand('write') === false) return null;
    } catch (error) { warn('prepare write', error); return null; }
    var view = getView();
    return view && !view.state.readOnly ? view : null;
  }

  /* ───────────────────────── 写入原语 ───────────────────────── */

  /** 在光标处插入；caret 为相对插入文本的落点偏移（null = 末尾）。 */
  function insertAtCursor(text, caret) {
    var view = getWritableView();
    if (!view || view.composing) return false;
    try {
      var sel = view.state.selection.main;
      var from = sel.from;
      var to = sel.to;
      var anchor = from + (caret == null ? text.length : caret);
      view.dispatch({
        changes: { from: from, to: to, insert: text },
        selection: { anchor: anchor },
        scrollIntoView: true,
        userEvent: 'input.mp-tools',
      });
      view.focus();
      return true;
    } catch (error) { warn('insertAtCursor', error); return false; }
  }

  /** 用 before/after 包裹全部选区（空选区时插入一对并把光标放中间）。 */
  function wrapSelection(before, after) {
    var view = getWritableView();
    if (!view || view.composing) return false;
    try {
      var ranges = view.state.selection.ranges;
      var changes = [];
      for (var i = 0; i < ranges.length; i += 1) {
        var r = ranges[i];
        if (r.to === r.from) {
          // 空选区：一次插入整对，光标落到中间
          changes.push({ from: r.from, insert: before + after });
        } else {
          changes.push({ from: r.from, insert: before });
          changes.push({ from: r.to, insert: after });
        }
      }
      // CM6 要求 changes 升序且不重叠
      changes.sort(function (a, b) { return a.from - b.from; });
      var main = view.state.selection.main;
      view.dispatch({
        changes: changes,
        selection: { anchor: main.from + before.length, head: main.to + before.length },
        scrollIntoView: true,
        userEvent: 'input.mp-tools',
      });
      view.focus();
      return true;
    } catch (error) { warn('wrapSelection', error); return false; }
  }

  /* ───────────────────────── 数学模板 ───────────────────────── */

  // 光标落点用标记 @@ 表示（插入时自动剥离并换算偏移）——
  // 手数字符偏移极易错位（本文件上一版就数错过），标记法把"落点"写进模板本身，可读且不会漂移。
  var CARET = '@@';
  var TEMPLATES = [
    { key: 'block',      label: '行间公式', short: '$$',      text: '$$\n@@\n$$' },
    { key: 'inline',     label: '行内公式', short: '$x$',     text: '$@@$' },
    { key: 'aligned',    label: '对齐多行', short: 'aligned', text: '$$\n\\begin{aligned}\n  @@\n\\end{aligned}\n$$' },
    { key: 'derivation', label: '推导链',   short: '⇒',
      text: '$$\n\\begin{aligned}\n  \\text{已知}\\quad & @@ \\\\\n  & = \\\\\n  & = \\\\\n\\end{aligned}\n$$' },
    { key: 'cases',      label: '分段函数', short: 'cases',
      text: '$$\nf(x)=\\begin{cases}\n  @@, & x>0 \\\\\n  , & x\\le 0\n\\end{cases}\n$$' },
    { key: 'matrix',     label: '矩阵',     short: 'pmatrix',
      text: '$$\n\\begin{pmatrix}\n  @@a_{11} & a_{12} \\\\\n  a_{21} & a_{22}\n\\end{pmatrix}\n$$' },
    { key: 'system',     label: '方程组',   short: 'cases',
      text: '$$\n\\begin{cases}\n  x + y = @@ \\\\\n  x - y = \n\\end{cases}\n$$' },
    { key: 'theorem',    label: '已知/求证', short: '题',
      text: '\n> **已知**：@@\n>\n> **求证**：\n>\n> **证明**：\n\n$$\n\\begin{aligned}\n  \n\\end{aligned}\n$$\n' },
    { key: 'vector',     label: '向量',     short: 'vec',
      text: '$$\n\\vec{a}\\cdot\\vec{b}=|\\vec{a}||\\vec{b}|\\cos\\theta\n$$' },
  ];

  function templateOf(key) {
    for (var i = 0; i < TEMPLATES.length; i += 1) if (TEMPLATES[i].key === key) return TEMPLATES[i];
    return null;
  }

  function insertTemplate(key) {
    var tpl = templateOf(key);
    if (!tpl) return false;
    var text = tpl.text;
    var at = text.indexOf(CARET);
    var caret;
    if (at >= 0) {
      text = text.slice(0, at) + text.slice(at + CARET.length);
      caret = at;
    } else {
      caret = text.length;
    }
    return insertAtCursor(text, caret);
  }

  /* ───────────────────────── 选区包裹 ───────────────────────── */

  var WRAPS = [
    { key: 'display', label: '包成 $$…$$', before: '$$\n', after: '\n$$' },
    { key: 'aligned', label: '包成 aligned', before: '$$\n\\begin{aligned}\n', after: '\n\\end{aligned}\n$$' },
    { key: 'paren',   label: '包成 \\left(…\\right)', before: '\\left(', after: '\\right)' },
    { key: 'abs',     label: '包成 |…|', before: '|', after: '|' },
    { key: 'text',    label: '包成 \\mathrm{}', before: '\\mathrm{', after: '}' },
  ];

  function wrapOf(key) {
    for (var i = 0; i < WRAPS.length; i += 1) if (WRAPS[i].key === key) return WRAPS[i];
    return null;
  }

  function applyWrap(key) {
    var w = wrapOf(key);
    if (!w) return false;
    return wrapSelection(w.before, w.after);
  }

  /* ───────────────────────── 公式编号 ───────────────────────── */

  /**
   * 找光标所在的成对 $$ 块（近似：按出现顺序两两配对）。
   * 注意：不解析代码围栏；文档里有 ``` 内含 $$ 的极端情况可能误判，
   * 此时用户会看到编号插错位置 —— 宁可少功能也不假装解析 Markdown。
   */
  function findDisplayMath(docText, pos) {
    var marks = [];
    var p = 0;
    for (;;) {
      var i = docText.indexOf('$$', p);
      if (i < 0) break;
      marks.push(i);
      p = i + 2;
    }
    for (var k = 0; k + 1 < marks.length; k += 2) {
      var open = marks[k];
      var close = marks[k + 1];
      if (pos >= open && pos <= close + 2) return { open: open, close: close };
    }
    return null;
  }

  /** 文档内已有最大编号（扫描 \tag{n}），没有则 0。 */
  function maxEquationNumber(docText) {
    var max = 0;
    var re = /\\tag\{(\d+)\}/g;
    var m;
    while ((m = re.exec(docText)) !== null) {
      var n = parseInt(m[1], 10);
      if (isFinite(n) && n > max) max = n;
    }
    return max;
  }

  function numberEquation() {
    var view = getWritableView();
    if (!view || view.composing) return false;
    try {
      var sel = view.state.selection.main;
      var text = view.state.doc.toString();
      var block = findDisplayMath(text, sel.from);
      if (!block) return false;
      var next = maxEquationNumber(text) + 1;
      var tag = '\\tag{' + next + '}';
      // 插在收尾 $$ 之前，且单独占行更稳
      var insertPos = block.close;
      var before = text.slice(0, insertPos);
      var needsNewline = !/\n$/.test(before);
      view.dispatch({
        changes: { from: insertPos, insert: (needsNewline ? '\n' : '') + tag + '\n' },
        userEvent: 'input.mp-tools',
      });
      view.focus();
      return next;
    } catch (error) { warn('numberEquation', error); return false; }
  }

  /* ───────────────────────── 符号面板 ───────────────────────── */

  var SYMBOLS = [
    { group: '希腊', items: ['α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'λ', 'μ', 'ν', 'ξ', 'π', 'ρ', 'σ', 'τ', 'φ', 'χ', 'ψ', 'ω', 'Γ', 'Δ', 'Θ', 'Λ', 'Σ', 'Φ', 'Ψ', 'Ω'] },
    { group: '关系', items: ['=', '≠', '≈', '≡', '≤', '≥', '≪', '≫', '∝', '∼', '∈', '∉', '⊂', '⊆', '∪', '∩', '∅'] },
    { group: '算子', items: ['∑', '∏', '∫', '∬', '∮', '∂', '∇', '√', '∞', '·', '×', '±', '∘'] },
    { group: '箭头', items: ['→', '←', '↔', '⇒', '⇐', '⇔', '↦', '↑', '↓', '∴', '∵'] },
    { group: '数集', items: ['ℝ', 'ℕ', 'ℤ', 'ℚ', 'ℂ', '∠', '△', '⊥', '∥'] },
  ];

  // 直接敲的符号用原文；数学环境里也合法（CM6 的 KaTeX 会处理）
  function insertSymbol(ch) {
    return insertAtCursor(ch, null);
  }

  /* ───────────────────────── AI 请求 ───────────────────────── */

  var AI_INTENTS = [
    { key: 'explain',  label: '解释这一步', ask: '请逐步解释这段推导的每一步依据（用了什么定理/公式），指出关键变换。' },
    { key: 'next',     label: '下一步',     ask: '基于上面的推导，给出下一步，并说明为什么这一步成立。' },
    { key: 'solve',    label: '求解',       ask: '请解出结果，给出完整推导过程与最终答案。' },
    { key: 'simplify', label: '化简',       ask: '请化简，并说明每步用了哪条恒等式。' },
    { key: 'check',    label: '查错',       ask: '请检查这段推导是否有错；若无误请明确指出每步依据，若有误请指出第一处错误并给出正确写法。' },
    { key: 'ask',      label: '自由提问…',  ask: null },
  ];

  function intentOf(key) {
    for (var i = 0; i < AI_INTENTS.length; i += 1) if (AI_INTENTS[i].key === key) return AI_INTENTS[i];
    return null;
  }

  /**
   * 打包自解释的上下文：任何 agent 在任何会话里都能接手，不需要再问位置。
   * 只读，不改 state。
   */
  function buildAIPayload(intentKey, freeText) {
    var view = getView();
    if (!view) return null;
    var intent = intentOf(intentKey);
    if (!intent) return null;
    var doc = view.state.doc;
    var sel = view.state.selection.main;
    var hasSel = sel.to > sel.from;
    var from = sel.from;
    var to = hasSel ? sel.to : Math.min(doc.length, sel.from + 400);

    var l0 = doc.lineAt(from).number;
    var l1 = doc.lineAt(to).number;
    var body = doc.sliceString(from, to);

    var c0 = Math.max(1, l0 - 3);
    var c1 = Math.min(doc.lines, l1 + 3);
    var ctx = [];
    for (var n = c0; n <= c1; n += 1) ctx.push(doc.line(n).text);

    var ask = intent.ask != null ? intent.ask : (freeText || '');
    if (!ask.trim()) return null;

    // MP208-UI: one shared pure builder. It excludes selected lines from the
    // neighbour context, budgets the context, and refuses an oversized body
    // instead of silently truncating it.
    var core = window.__MP208;
    if (core && typeof core.mathPayload === 'function') {
      var built = core.mathPayload({
        doc: doc,
        from: from,
        to: to,
        body: body,
        ask: ask,
        intent: intent.key,
        intentLabel: intent.label,
      });
      if (built && built.ok === false) return built;
      if (built && built.ok === true) return { text: built.text, meta: built.meta };
    }

    var head = '📐 数学请求 · ' + intent.label;
    var lines = [
      head,
      '位置：第 ' + l0 + '–' + l1 + ' 行' + (hasSel ? '（已选中）' : '（光标处起 400 字）'),
      '',
      '【内容】',
      '````md',
      body,
      '````',
      '',
      '【上下文，第 ' + c0 + '–' + c1 + ' 行】',
      '````md',
      ctx.join('\n'),
      '````',
      '',
      '要求：' + ask,
      '',
      '（这是 MarkPilot 编辑器发出的数学推理请求：内容为 Markdown + LaTeX 源码，'
        + '公式用 $$…$$ 或 $…$。请保留 LaTeX 原样书写，不要在回答里改成图片或纯文本。）',
    ];
    return { text: lines.join('\n'), meta: { intent: intent.key, fromLine: l0, toLine: l1, hasSelection: hasSel } };
  }

  /** 交给父窗口：父窗口会加文档路径前缀，并在拿到 composer 句柄时直接发送。 */
  function sendToChat(payload) {
    if (!payload || !payload.text) return false;
    // 用户口径（2026-11-05）：工具条上的任何操作都**直接发送**，不再只填不发。
    payload.send = true;
    try {
      window.handler.emit('insert-to-chat', payload);
      return true;
    } catch (error) { warn('sendToChat', error); return false; }
  }

  /* 对话列边界拖拽热区由父页面 #mp-chat-handle 独占（贴边界右侧 8px）。
   * iframe 内不再建全高热区：编辑器自己的竖向滚动条就在 iframe 右沿，
   * 14px 的条会把滚动条滑块整个盖住，拖页会被吞成改宽。
   * 父句柄按下后捕获指针，指针越过 iframe 仍能收到 move/up。 */

  function runAI(intentKey, freeText) {
    var payload = buildAIPayload(intentKey, freeText);
    if (!payload) return false;
    if (payload.ok === false) {
      flash(String(payload.message || '数学请求不可用'));
      return false;
    }
    // 自由提问：给模型一个固定格式的头（选中内容仍随【内容】小节一起过去）
    if (intentKey === 'ask' && freeText) {
      payload.text = '请以提问语言回复。\n\nask: ' + String(freeText).trim()
        + '\nselected: 见下方【内容】小节\n\n' + payload.text;
    }
    return sendToChat(payload);
  }

  /* ───────────────────────── 下行命令分发 ───────────────────────── */

  // 桥对未知 type 有兜底 runHandlers(type, content)，所以宿主发 type:'cmd' 即可，不需要改桥。
  function handleCommand(cmd) {
    if (!cmd || typeof cmd !== 'object') return;
    var kind = cmd.kind;
    if (kind === 'template') return void insertTemplate(cmd.key);
    if (kind === 'wrap') return void applyWrap(cmd.key);
    if (kind === 'symbol') return void insertSymbol(cmd.ch);
    if (kind === 'number') return void numberEquation();
    if (kind === 'ai') return void runAI(cmd.intent, cmd.text);
    if (kind === 'reveal') {
      var view = getView();
      if (!view) return;
      var doc = view.state.doc;
      var from = Math.max(0, Math.min(Number(cmd.from) || 0, doc.length));
      var to = Math.max(from, Math.min(Number(cmd.to) || from, doc.length));
      try {
        view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true, userEvent: 'select.mp-reveal' });
        view.focus();
      } catch (error) { warn('reveal', error); }
      return;
    }
    if (kind === 'ping') { try { window.handler.emit('tools-ready', { version: VERSION }); } catch (e) { /* 桥未就绪 */ } }
  }

  try {
    if (window.handler && typeof window.handler.on === 'function') {
      window.handler.on('cmd', handleCommand);
    }
  } catch (error) { warn('register cmd handler', error); }

  /* ───────────────────────── 工具条 UI ───────────────────────── */

  var CSS = [
    '.mp-tools{position:fixed;right:14px;bottom:56px;z-index:2147483000;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;',
    'color:#e6e8eb;pointer-events:auto;user-select:none}',
    '.mp-tools *{box-sizing:border-box}',
    // 工具条是定宽浮层：编辑区被压窄时它的右端会被裁掉（实测）。
    // 允许换行 + 限制最大宽度，任何宽度下都能看到全部按钮。
    // 工具条：**永远单行**。上一版用 flex-wrap 换行，窄编辑区下会变 3 行、占 90px 高（实测）。
    // 改成横向滚动（隐藏滚动条）：高度恒定，所有按钮仍可点到，不再压正文。
    '.mp-tools__bar{display:flex;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;align-items:center;gap:2px;padding:0;border-radius:10px;max-width:calc(100vw - 24px);background:transparent;border:none;box-shadow:none}',
    '.mp-tools__bar::-webkit-scrollbar{display:none}',
    '.mp-tools__wand{display:flex;align-items:center;gap:5px;padding:0 10px;height:30px;border-radius:9px;',
    'background:rgba(16,20,28,.55);border:1px solid rgba(255,255,255,.10);backdrop-filter:blur(10px);',
    'color:#dfe4ec;font:600 12.5px/1 system-ui,sans-serif;cursor:pointer;transition:background .12s,transform .06s}',
    '.mp-tools__wand:hover{background:rgba(79,142,247,.26);border-color:rgba(79,142,247,.55);color:#fff;transform:translateY(-1px)}',
    '.mp-tools__wand[data-on=\"1\"]{background:rgba(79,142,247,.32);border-color:rgba(79,142,247,.7);color:#fff}',
    '.mp-tools__btn{display:flex;align-items:center;justify-content:center;min-width:28px;height:28px;padding:0 7px;',
    'border:none;border-radius:7px;background:transparent;color:#c8cfda;font:inherit;font-size:14px;cursor:pointer}',
    '.mp-tools__btn:hover{background:rgba(255,255,255,.1);color:#fff}',
    '.mp-tools__btn[data-on="1"]{background:rgba(79,142,247,.28);color:#dbe8ff}',
    '.mp-tools__sep{width:1px;height:18px;margin:0 3px;background:rgba(255,255,255,.14)}',
    '.mp-tools__panel{position:absolute;right:0;bottom:calc(100% + 8px);width:268px;max-width:calc(100vw - 28px);max-height:min(66vh,460px);overflow:auto;',
    'padding:8px;border-radius:11px;background:rgba(16,20,28,.62);border:1px solid rgba(255,255,255,.16);',
    'box-shadow:0 12px 36px rgba(0,0,0,.45);backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2)}',
    '.mp-tools__panel[hidden]{display:none}',
    '.mp-tools__h{font-size:11px;font-weight:600;letter-spacing:.04em;color:#8b93a3;margin:2px 0 6px}',
    '.mp-tools__grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-bottom:8px}',
    '.mp-tools__grid--s{grid-template-columns:repeat(10,1fr)}',
    '.mp-tools__grid--ai{grid-template-columns:repeat(2,1fr)}',
    '.mp-tools__grid--mini{grid-template-columns:repeat(3,1fr);margin-bottom:6px}',
    '.mp-tools__grid--mini .mp-tools__cell{min-height:24px;font-size:11px;padding:0 2px}',
    '.mp-tools__cell{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;',
    'min-height:30px;padding:3px 2px;border:1px solid rgba(255,255,255,.09);border-radius:6px;',
    'background:rgba(255,255,255,.03);color:#dfe4ec;font:inherit;font-size:11.5px;cursor:pointer;text-align:center;',
    'transition:background .12s ease,border-color .12s ease,transform .06s ease}',
    '.mp-tools__cell:hover{border-color:rgba(79,142,247,.75);background:rgba(79,142,247,.20);color:#fff;transform:translateY(-1px)}',
    '.mp-tools__cell:active{transform:translateY(0);background:rgba(79,142,247,.30)}',
    '.mp-tools__cell small{font-size:10px;color:#8b93a3}',
    '.mp-tools__sym{min-height:26px;padding:0;font-size:14px}',
    '.mp-tools__ask{display:flex;gap:5px;margin-top:2px}',
    '.mp-tools__ask input{flex:1;min-width:0;height:26px;padding:0 8px;border-radius:6px;',
    'border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#e6e8eb;font:inherit;font-size:11.5px;outline:none}',
    '.mp-tools__ask input:focus{border-color:rgba(79,142,247,.7)}',
    '.mp-tools--collapsed .mp-tools__btn[data-section]{display:none}',
    '.mp-tools--collapsed .mp-tools__sep{display:none}',
    '.mp-tools__send{min-width:26px;padding:0 5px}',
    '.mp-tools__send svg{display:block}',
    '.mp-tools__toast{position:fixed;right:14px;bottom:96px;z-index:2147483001;padding:5px 10px;border-radius:8px;',
    'background:rgba(63,208,138,.16);border:1px solid rgba(63,208,138,.5);color:#b8f5d4;font-size:12px;',
    'pointer-events:none;opacity:0;transition:opacity .15s}',
    '.mp-tools__toast[data-on="1"]{opacity:1}',
  ].join('');

  function injectCss() {
    if (document.querySelector('style[data-mp-tools]')) return;
    var style = document.createElement('style');
    style.setAttribute('data-mp-tools', VERSION);
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  var root = null;
  var panel = null;
  var openSection = null;
  var toastEl = null;
  var toastTimer = null;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function flash(message) {
    if (!toastEl) {
      toastEl = el('div', 'mp-tools__toast');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.setAttribute('data-on', '1');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastTimer = null;
      if (toastEl) toastEl.setAttribute('data-on', '0');
    }, 4000);
  }

  function sectionTitle(text) {
    return el('div', 'mp-tools__h', text);
  }

  function buildMathPanel() {
    var frag = document.createDocumentFragment();
    frag.appendChild(sectionTitle('数学模板'));
    var g = el('div', 'mp-tools__grid');
    TEMPLATES.forEach(function (t) {
      var b = el('button', 'mp-tools__cell');
      b.type = 'button';
      b.dataset.cmd = 'template';
      b.dataset.key = t.key;
      b.appendChild(el('span', null, t.label));
      b.appendChild(el('small', null, t.short));
      g.appendChild(b);
    });
    frag.appendChild(g);

    frag.appendChild(sectionTitle('包裹选中内容'));
    var w = el('div', 'mp-tools__grid');
    WRAPS.forEach(function (it) {
      var b = el('button', 'mp-tools__cell');
      b.type = 'button';
      b.dataset.cmd = 'wrap';
      b.dataset.key = it.key;
      b.appendChild(el('span', null, it.label));
      w.appendChild(b);
    });
    frag.appendChild(w);

    frag.appendChild(sectionTitle('符号'));
    SYMBOLS.forEach(function (grp) {
      var row = el('div', 'mp-tools__grid mp-tools__grid--s');
      grp.items.forEach(function (ch) {
        var b = el('button', 'mp-tools__cell mp-tools__sym', ch);
        b.type = 'button';
        b.dataset.cmd = 'symbol';
        b.dataset.ch = ch;
        row.appendChild(b);
      });
      frag.appendChild(row);
    });

    var num = el('button', 'mp-tools__cell');
    num.type = 'button';
    num.dataset.cmd = 'number';
    num.style.gridColumn = '1 / -1';
    num.textContent = '给当前公式加自动编号 \\tag{n}';
    var nw = el('div', 'mp-tools__grid');
    nw.appendChild(num);
    frag.appendChild(nw);
    return frag;
  }

  function buildAIPanel() {
    var frag = document.createDocumentFragment();
    frag.appendChild(sectionTitle('问 AI（选中+提问一起发出）'));
    // 第一排：两个主动作（解释选中 / 推演下步）；第二排：三个小动作并排
    var MAJOR = ['explain', 'next'];
    var MINOR = ['solve', 'simplify', 'check'];
    var g = el('div', 'mp-tools__grid mp-tools__grid--ai');
    AI_INTENTS.forEach(function (it) {
      if (MAJOR.indexOf(it.key) === -1) return;
      var b = el('button', 'mp-tools__cell');
      b.type = 'button';
      b.dataset.cmd = 'ai';
      b.dataset.intent = it.key;
      b.textContent = it.key === 'next' ? '推演下步' : '解释选中';
      g.appendChild(b);
    });
    frag.appendChild(g);
    var gm = el('div', 'mp-tools__grid mp-tools__grid--mini');
    AI_INTENTS.forEach(function (it) {
      if (MINOR.indexOf(it.key) === -1) return;
      var b = el('button', 'mp-tools__cell');
      b.type = 'button';
      b.dataset.cmd = 'ai';
      b.dataset.intent = it.key;
      b.textContent = it.label;
      gm.appendChild(b);
    });
    frag.appendChild(gm);

    var askRow = el('div', 'mp-tools__ask');
    var input = el('input');
    input.type = 'text';
    input.placeholder = '自由提问，回车提交…';
    input.dataset.mpAsk = '1';
    var go = el('button', 'mp-tools__cell mp-tools__send');
    go.type = 'button';
    go.dataset.cmd = 'ai';
    go.dataset.intent = 'ask';
    go.title = '发送给 AI（选中+提问一起发出）';
    // 简约线条小飞机（内联 SVG，无外部依赖）
    go.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
      + '<path d="M3.2 11.3 20.8 3.4a.5.5 0 0 1 .66.66l-7.9 17.6a.5.5 0 0 1-.93-.06l-2.06-6.1-6.1-2.06a.5.5 0 0 1-.06-.93Z" '
      + 'stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    askRow.appendChild(input);
    askRow.appendChild(go);
    frag.appendChild(askRow);
    return frag;
  }

  function closePanel() {
    if (panel) panel.hidden = true;
    openSection = null;
    if (root) {
      var btns = root.querySelectorAll('.mp-tools__btn');
      for (var i = 0; i < btns.length; i += 1) btns[i].setAttribute('data-on', '0');
    }
  }

  function togglePanel(section) {
    if (!panel) return;
    if (openSection === section) { closePanel(); return; }
    openSection = section;
    panel.textContent = '';
    panel.appendChild(section === 'math' ? buildMathPanel() : buildAIPanel());
    panel.hidden = false;
    var btns = root.querySelectorAll('.mp-tools__btn');
    for (var i = 0; i < btns.length; i += 1) {
      btns[i].setAttribute('data-on', btns[i].dataset.section === section ? '1' : '0');
    }
  }

  function makeBarButton(label, title, section) {
    var b = el('button', 'mp-tools__btn', label);
    b.type = 'button';
    b.title = title;
    if (section) b.dataset.section = section;
    return b;
  }

  function installUi() {
    if (root) return;
    injectCss();
    root = el('div', 'mp-tools');
    panel = el('div', 'mp-tools__panel');
    panel.hidden = true;

    var bar = el('div', 'mp-tools__bar');
    // 数学模板入口已下线（下一版内核接管、连工具岛）。代码与快捷键保留在此处留档：
    //   var mathBtn = makeBarButton('∑', '数学模板 / 符号（Ctrl+Alt+M）', 'math');
    //   bar.appendChild(mathBtn);
    // 工具栏只剩一个无边框按钮：AI + 简笔魔法棒（折叠键已取消）
    var aiBtn = makeBarButton('AI', '问 AI（Ctrl+Alt+E）', 'ai');
    aiBtn.classList.add('mp-tools__wand');   // 追加，不能覆盖 mp-tools__btn（点击分发靠它）
    aiBtn.dataset.section = 'ai';
    aiBtn.innerHTML = '<span>AI</span>'
      + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
      + '<path d="M4 20 14.5 9.5M15.5 4.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1 1-2.5Z" '
      + 'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    bar.appendChild(aiBtn);

    root.appendChild(panel);
    root.appendChild(bar);
    document.body.appendChild(root);

    // 不抢编辑器焦点：工具条上的按下不产生默认行为 —— **但输入框必须放行**，
    // 否则 mousedown 被 preventDefault 后 input 永远拿不到焦点（之前"自由提问"打不了字就是这个）。
    root.addEventListener('mousedown', function (e) {
      var tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
    }, true);
    root.addEventListener('click', function (e) {
      var target = e.target;
      if (!(target instanceof Element)) return;
      // 折叠 / 展开工具条（原来的 × 换成折叠；× 之前点了没有效果）
      var col = target.closest('.mp-tools__btn[data-role="collapse"]');
      if (col) {
        var nowCollapsed = root.classList.toggle('mp-tools--collapsed');
        col.textContent = nowCollapsed ? '\u2303' : '\u2304';
        col.title = nowCollapsed ? '展开工具条' : '折叠工具条';
        if (nowCollapsed) closePanel();
        return;
      }
      if (target.closest('.mp-tools__btn[data-section]')) {
        togglePanel(target.closest('.mp-tools__btn[data-section]').dataset.section);
        return;
      }
      if (target.closest('.mp-tools__btn')) { closePanel(); return; }
      var cell = target.closest('[data-cmd]');
      if (!cell) return;
      var cmd = cell.dataset.cmd;
      if (cmd === 'template') { insertTemplate(cell.dataset.key); flash('已插入模板'); }
      else if (cmd === 'wrap') { applyWrap(cell.dataset.key); flash('已包裹'); }
      else if (cmd === 'symbol') { insertSymbol(cell.dataset.ch); }
      else if (cmd === 'number') {
        var n = numberEquation();
        flash(n ? '已编号 (\\tag{' + n + '})' : '光标不在 $$ 公式块内');
      } else if (cmd === 'ai') {
        var intent = cell.dataset.intent;
        var free = '';
        if (intent === 'ask') {
          var input = panel.querySelector('[data-mp-ask]');
          free = input ? input.value : '';
          if (input) input.value = '';
        }
        var ok = runAI(intent, free);
        flash(ok ? '已提交请求' : '没有可用选区或输入为空');
      }
    });
    // 自由提问回车
    root.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var t = e.target;
      if (!(t instanceof Element) || !t.matches('[data-mp-ask]')) return;
      e.preventDefault();
      var payload = buildAIPayload('ask', t.value);
      if (payload && sendToChat(payload)) { t.value = ''; flash('已提交请求'); }
    }, true);

    // 点面板外面就收起。两种"外面"都要管：
    //   ① iframe 内部（编辑器正文、空白处）→ document 上的 mousedown；
    //   ② 宿主页面（对话栏、侧栏、工具条之外）→ iframe 失焦，用 window blur 兜住。
    // 之前只做了"再点一次按钮"这条，所以用户点别处面板一直挂着。
    document.addEventListener('mousedown', function (e) {
      if (!openSection) return;
      var t = e.target;
      if (t instanceof Element && root && root.contains(t)) return;   // 面板/按钮内部自己处理
      closePanel();
    }, true);
    window.addEventListener('blur', function () {
      if (openSection) closePanel();
    }, false);
    // Pointer actions on non-focusable host UI do not reliably blur an iframe.
    // This renderer is same-origin; release the parent listener on navigation.
    try {
      if (window.parent !== window) {
        var parentDocument = window.parent.document;
        parentDocument.addEventListener('pointerdown', closePanel, true);
        window.addEventListener('pagehide', function () {
          parentDocument.removeEventListener('pointerdown', closePanel, true);
        }, { once: true });
      }
    } catch (error) { /* 跨域宿主仍保留 iframe 内点击与失焦关闭 */ }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && openSection) closePanel();
    }, true);
  }

  /* ───────────────────────── 快捷键 ───────────────────────── */

  function isMac() { return /Mac|iPod|iPhone|iPad/.test(navigator.platform || ''); }

  function onKeydown(e) {
    if (!e.altKey) return;
    var mod = isMac() ? e.metaKey : e.ctrlKey;
    if (!mod) return;
    var k = (e.key || '').toLowerCase();
    if (k === 'm') { e.preventDefault(); e.stopPropagation(); installUi(); togglePanel('math'); }
    else if (k === 'e') { e.preventDefault(); e.stopPropagation(); var ok = runAI('explain', ''); flash(ok ? '已交给对话框' : '没有可解释的内容'); }
  }

  /* ───────────────────────── 启动 ───────────────────────── */

  function boot() {
    // Implement the existing host facade expected by the unchanged CM6 toolbar.
    // The enclosing iframe explicitly allows fullscreen; Escape is handled by
    // the browser and restores its original layout without remounting the doc.
    try {
      var host = window.mpHost || (window.mpHost = {});
      host.toggleFullscreen = async function () {
        try {
          if (document.fullscreenElement) await document.exitFullscreen();
          else await document.documentElement.requestFullscreen();
          return { ok: true, fullscreen: !!document.fullscreenElement };
        } catch (error) {
          return { ok: false, error: String(error && error.message || error) };
        }
      };
    } catch (error) { warn('fullscreen host facade', error); }
    try { installUi(); } catch (error) { warn('installUi', error); }
    try {
      window.handler.emit('tools-ready', { version: VERSION });
    } catch (error) { /* 桥未就绪：静默，工具条已可用 */ }
  }

  // 引擎 boot() 是同步的，但可能晚于本脚本；用 readyState + 一次性 DOMContentLoaded，不轮询。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
  window.addEventListener('keydown', onKeydown, true);

  /* ───────────────────────── 自测/调试出口 ───────────────────────── */

  window.__mpTools = {
    version: VERSION,
    templates: TEMPLATES,
    wraps: WRAPS,
    symbols: SYMBOLS,
    intents: AI_INTENTS,
    getView: getView,
    insertTemplate: insertTemplate,
    applyWrap: applyWrap,
    insertSymbol: insertSymbol,
    numberEquation: numberEquation,
    buildAIPayload: buildAIPayload,
    runAI: runAI,
    findDisplayMath: findDisplayMath,
    maxEquationNumber: maxEquationNumber,
    handleCommand: handleCommand,
  };
})();
