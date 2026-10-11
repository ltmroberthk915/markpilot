/** Typora-style IR editing, kept outside the vendored Vditor bundle. */
import { installMathSourceNavigation, sourceOffsetAtPoint } from "./math-source-map.js";
import { installMathSelectionReveal } from "./math-select-reveal.js";
import { installMarkerCaretGuard } from "./marker-caret-guard.js";
import { prepareMathScheduling } from "./math-scheduler.js";
import { installIncrementalIR } from "./incremental-ir.js";
import { installFastTypeGate } from "./fast-type-gate.js";
import { installEditorShortcuts } from "./edit-shortcuts.js";
import { preserveIR, installInputPreviewGuard } from './preserve-render.js';
import { installUnderlines } from './underline.js';
import { installFindReplace } from './find-replace.js';
import { installMathEditing } from './math-edit.js';
import { installSplitNavigation } from './split-navigation.js';
import { captureHistorySelection, restoreHistorySelection, followHistorySelection } from './history-selection.js';
import { installLargeDocGuard } from './large-doc.js';
import { installReadingMode } from './reading-mode.js';
const PREVIEW = ".vditor-ir__preview";
const EXPAND = "vditor-ir__node--expand";
const MATH = 'code[data-type="math-inline"]';

const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const renderProgressive = (render, source, options, error) => {
  // A failing prefix must get shorter, including errors reported at EOF.
  const position = typeof error.position === "number"
    ? Math.max(0, Math.min(error.position, source.length - 1)) : 0;
  let head = "";
  if (position > 0) {
    try { head = render(source.slice(0, position), options); }
    catch (next) { head = renderProgressive(render, source.slice(0, position), options, next); }
  }
  const tail = [...source.slice(position).matchAll(/\\[a-zA-Z]+|\\.|[\s\S]/gu)].map(match => {
    const start = position + match.index;
    return '<span data-typora-source-start="' + start + '" data-typora-source-end="' +
      (start + match[0].length) + '">' + escapeHtml(match[0]) + '</span>';
  }).join("");
  return head + '<span class="vditor-math-error">' + tail + "</span>";
};

const wrapKatex = (katex) => {
  if (!katex?.renderToString || katex.__typoraPatched) return katex;
  const render = katex.renderToString.bind(katex);
  katex.renderToString = (source, options) => {
    options = {...options, sourceMap: true};
    try { return render(source, options); }
    catch (error) { return renderProgressive(render, String(source), options || {}, error); }
  };
  katex.__typoraPatched = true;
  return katex;
};

// Install before Vditor starts loading its asynchronous math renderer.
export const prepareTyporaMath = () => {
  prepareMathScheduling();
  if (window.__katexIntercepted) return;
  window.__katexIntercepted = true;
  let current = wrapKatex(window.katex);
  Object.defineProperty(window, "katex", {
    configurable: true,
    get: () => current,
    set: (katex) => { current = wrapKatex(katex); },
  });
};

const elementAt = (node) => node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
const selectPoint = (node, offset, extend = false) => {
  const selection = getSelection();
  if (extend) selection.extend(node, offset);
  else selection.collapse(node, offset);
};
/** 按住 Shift 扩展选区：**只动"移动端"，另一端钉死**。
 *  不能直接用 `selection.extend`（它只动 focus）：Vditor 在每次选区变化之后会把自己的
 *  区间重新设一遍（`addRange`），range 的 anchor/focus 方向随之被规范化；下一次 extend
 *  于是可能把"移动端"落到锚点上、把选区收塌。实测（probe-math-keys2.cjs，Selection API
 *  代理）：块公式源码里按住 Shift 连按 ← 就是"选中 1 个字符 → 长度 0 → 又选中 1 个字符"。
 *  setBaseAndExtent 明确指定"固定端 → 移动端"，与选区当前方向无关。 */
const extendEnd = (forward, target, position) => {
  const selection = getSelection();
  if (!selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  const anchorNode = forward ? range.startContainer : range.endContainer;
  const anchorOffset = forward ? range.startOffset : range.endOffset;
  selection.setBaseAndExtent(anchorNode, anchorOffset, target, position);
  return true;
};
/** 公式节点外侧最近的落点（先算后动，见 extendEnd）。 */
const selectOutsidePoint = (node, after) => {
  let adjacent = after ? node.nextSibling : node.previousSibling;
  // 空文本节点不算可落点：它上面的位置会被 Chromium 归一化回**前一个**文本节点，而公式节点
  // 里的前一个文本节点正是零宽的 `$` 标记——于是"右方向键走出公式"把光标停在了右 `$` 上，
  // 接着打的字被当成"在围栏上打字"塞回源码里（用户 2026-09-16 报告的正是这条）。
  while (adjacent && adjacent.nodeType === Node.TEXT_NODE && !adjacent.length) {
    adjacent = after ? adjacent.nextSibling : adjacent.previousSibling;
  }
  if (adjacent?.nodeType === Node.TEXT_NODE) return {node: adjacent, offset: after ? 0 : adjacent.length};
  if (!node.parentNode) return null;
  return {node: node.parentNode, offset: Array.prototype.indexOf.call(node.parentNode.childNodes, node) + (after ? 1 : 0)};
};
const selectOutside = (node, after, extend = false) => {
  const point = selectOutsidePoint(node, after);
  if (point) selectPoint(point.node, point.offset, extend);
};
// selectOutsidePoint 的兜底形状：没有可用文本节点就落在**父元素的边界位置**上——实测这种
// 位置型光标读回来还是它自己，在它上面打字也如实落在公式外侧（探针 probe-outside-point 的 Q1/Q2）。

/** 落在**某一行最后一个字形右侧**的点击：新增的权威判定。
 *
 *  为什么要新增（2026-09-17 实测；四个光标模块逐个摘除后读数逐字相同，证明这类点击**我们的
 *  处理器根本没接手**——`event.target` 是 `<p>`，`closest('.vditor-ir__node')` 为 null）：
 *  浏览器自己的命中测试在这里给不出可用位置——行尾 -4px 处给的是靠近**行首**的位置、
 *  行外 +40px 处直接给 `none`（那里没有任何文本位置）。Vditor 的兜底于是把光标塞进最近的
 *  可编辑元素，实测就是行内公式的 `<code>`，而且是它的 **offset 0**：
 *    · 行尾 +4px：公式被展开、光标在公式**最前面**，**1.6 秒内 8 次采样都没有可见矩形**；
 *    · 行外 +40px：光标进了一个**没展开、不可见**的 code——一打字就会写进公式源码。
 *  对照：点公式正中时落点与光标相差 3px，说明映射本身是准的，坏的只是"行尾之外"这一段。
 *
 *  只处理**行末是行内原子（元素）且点击落在它右缘之外**这一种：其余情形一律交回浏览器，
 *  把风险圈到最小。落点用 selectOutside 落在原子**外侧**——与方向键走出公式同一条路径，
 *  避免落到零宽 `$` 标记上（那条坑有实测记录，见 selectOutside 的注释）。
 *
 *  只管单次左键、无修饰键、且没有拖拽的手势：拖选、选词、带修饰键的多选照旧交给浏览器。 */
const lineEndAtom = (root, { x, y }) => {
  if (!root) return null;
  const kids = root.children;
  if (!kids.length) return null;
  let lo = 0, hi = kids.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (kids[mid].getBoundingClientRect().bottom < y) lo = mid + 1; else hi = mid; }
  const block = kids[lo] || kids[lo - 1];
  if (!block) return null;
  const box = block.getBoundingClientRect();
  if (x < box.left - 40 || x > box.right + 40 || y < box.top - 2 || y > box.bottom + 2) return null;
  // 量"这一行上最靠右的可见物"：**每个子节点取自己的盒子 ∪ 它内部的矩形**，
  // 然后只看纵向盖住落点 y 的那些。三条硬规则，缺一条就会出事：
  //  · **不能先算"行盒"再按行过滤**（2026-09-17 实测的坑）：含图片/预览岛的块里
  //    `Range.getClientRects()` 返回的是一堆碎片矩形——实测图片段 21 个矩形里没有一个是行盒，
  //    退化成最后那个 3px 宽的小块（`[46,51,261,277]`），于是"这一行最右的原子"被算成 x≈60，
  //    而图片本身占 46–166。结果是**点在图片正中间也被判成"在行末右侧"**，随手把选区收掉
  //    （连带把"左键选图 → Ctrl+C 复制"整条路打断）。
  //  · **元素盒和它内部的矩形都要算**：图片的可见盒来自元素本身（`Range` 可能量不到它），
  //    跨行公式的每行矩形来自内部。
  //  · **落点这一行必须有可见物**：一个都没有就说明点在了空白带里，不接管，交回浏览器。
  let last = null;
  for (const child of block.childNodes) {
    const text = child.nodeType === Node.TEXT_NODE;
    if (text ? !child.length : child.nodeType !== Node.ELEMENT_NODE) continue;
    const boxes = [];
    if (!text) {
      const own = child.getBoundingClientRect();
      if (own.width > 0 && own.height > 0) boxes.push(own);
    }
    const range = document.createRange();
    range.selectNodeContents(child);
    for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) boxes.push(rect);
    for (const rect of boxes) {
      if (rect.bottom < y - 2 || rect.top > y + 2) continue;                    // 不在落点这一行
      if (!last || rect.right > last.rect.right) last = {node: child, rect};
    }
  }
  if (!last) return null;                                    // 这一行没有可见物：不接管
  if (x <= last.rect.right + 2) return null;                 // 还在字形右缘之内：交回浏览器
  if (last.node.nodeType !== Node.ELEMENT_NODE) return null; // 行末是文本：浏览器自己放得对
  return last.node;
};

const installLineEndCaret = root => {
  let armed = null;
  const onDown = event => {
    armed = (event.button === 0 && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && event.detail <= 1)
      ? {x: event.clientX, y: event.clientY, dragged: false} : null;
  };
  const onMove = event => { if (armed && Math.hypot(event.clientX - armed.x, event.clientY - armed.y) > 4) armed.dragged = true; };
  const onUp = event => {
    const gesture = armed; armed = null;
    if (!gesture || gesture.dragged || event.button !== 0) return;
    let node;
    try { node = lineEndAtom(root, {x: gesture.x, y: gesture.y}); } catch { return; }
    if (!node) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    selectOutside(node, true);
  };
  root.addEventListener('mousedown', onDown, true);
  root.addEventListener('mousemove', onMove, true);
  root.addEventListener('mouseup', onUp, true);
  return () => {
    root.removeEventListener('mousedown', onDown, true);
    root.removeEventListener('mousemove', onMove, true);
    root.removeEventListener('mouseup', onUp, true);
  };
};

const protectPreviews = (scope) => {
  const previews = [...scope.querySelectorAll(PREVIEW)];
  if (scope.matches?.(PREVIEW)) previews.push(scope);
  previews.forEach(preview => {
    // Clicks still bubble to Vditor's preview-to-source handler; editable=false
    // only removes the rendered subtree from the browser's editing traversal.
    if (preview.getAttribute("contenteditable") !== "false") {
      preview.setAttribute("contenteditable", "false");
    }
  });
};

/** Snapshot source must come from the editable code, never the async render cache. */
const normalizeSnapshot = (html, mode = 'ir') => {
  const template = document.createElement("template");
  template.innerHTML = html;
  protectPreviews(template.content);
  template.content.querySelectorAll('.vditor-' + mode + '__preview').forEach(preview => {
    const math = preview.querySelector(".language-math");
    const code = preview.previousElementSibling;
    if (!math || !code) return;
    math.textContent = mode === 'wysiwyg' ? code.textContent.replaceAll('\u200b', '') : code.textContent;
    if (mode === 'wysiwyg') code.setAttribute('style', 'display:none');
    math.className = "language-math";
    math.removeAttribute("data-math");
    preview.setAttribute("data-render", "2");
  });
  return template.innerHTML;
};

const patchHistory = (api) => {
  const editor = api.vditor;
  const undo = editor.undo;
  const historySelections = new WeakMap(), pendingSelections = new Map();
  let stopFollowing = () => {};
  const captureBeforeInput = mode => {
    if (mode === 'sv' || editor.currentMode !== mode) return;
    const pending = pendingSelections.get(mode);
    if (!pending?.receivedInput && pending?.compositionBaseline === undefined) {
      pendingSelections.set(mode, {selection:captureHistorySelection(editor[mode].element), receivedInput:false});
    }
  };
  const recordFirstPosition = undo.recordFirstPosition;
  undo.recordFirstPosition = function (state, event) {
    // Formatting/math commands can replace DOM directly without beforeinput.
    // Their existing transaction boundary must preserve the selection too,
    // including when native recordFirstPosition skips non-initial history.
    captureBeforeInput(state.currentMode);
    return recordFirstPosition.call(this, state, event);
  };
  const halfMatch=undo.dmp.diff_halfMatch_;
  undo.dmp.diff_halfMatch_=function(left,right){
    // The repeated-seed heuristic ignores the diff deadline and can scan the
    // same long run quadratically when a caret marker moves. Large unmatched
    // regions use the native line/Myers path, which already honors that deadline.
    // This changes diff grouping, never the text reconstructed by undo/redo.
    return Math.max(left.length,right.length)>65536?null:halfMatch.call(this,left,right);
  };
  const addCaret = undo.addCaret;
  undo.addCaret = function (state, ...args) {
    if (state.currentMode === "ir" && state.__typoraPerformance) return state.__typoraPerformance.snapshot();
    const html = addCaret.call(this, state, ...args);
    // Vditor inserts/removes a temporary caret span when recording history.
    // At text@0 that splits off an empty text node, which cannot paint a caret.
    const selection = getSelection();
    const focus = selection.focusNode;
    if (state.currentMode === "ir" && args[0] && selection.isCollapsed &&
        focus?.nodeType === Node.TEXT_NODE && !focus.length) {
      let next = focus.nextSibling;
      while (next?.nodeType === Node.TEXT_NODE && !next.length) next = next.nextSibling;
      if (next?.nodeType === Node.TEXT_NODE && next.length) selectPoint(next, 0);
    }
    return state.currentMode !== 'sv' ? normalizeSnapshot(html, state.currentMode) : html;
  };

  const addToUndoStack = undo.addToUndoStack;
  undo.addToUndoStack = function (state) {
    const mode = state.currentMode, history = this[mode], previous = history.undoStack.at(-1);
    const pending = pendingSelections.get(mode);
    // A canceled composition changes neither text nor the undo transaction.
    // Its temporary DOM/caret must not consume a later Ctrl+Z as an empty edit.
    if (pending?.compositionBaseline !== undefined && api.getValue() === pending.compositionBaseline) {
      pendingSelections.delete(mode);
      return;
    }
    const result = addToUndoStack.call(this, state);
    const patch = history.undoStack.at(-1);
    if (pending?.selection && patch && patch !== previous) {
      historySelections.set(patch, {before:pending.selection, after:captureHistorySelection(state[mode].element)});
    }
    pendingSelections.delete(mode);
    return result;
  };

  const flush = () => {
    clearTimeout(editor.ir.processTimeoutId);
    // A cursor move or a completed async render is not a document edit.
    // 【P3】打字后立刻 Ctrl+Z 走的就是这里：historyMarkdown 优先用快照里顺手
    // 存下的 getMarkdown 缓存值（版本命中免整篇换算），只有快照被 LRU 逐出/
    // 版本对不上才退回 convert(lastText)。比较语义不变：仍旧是"当前值与上一
    // 条历史记录的 markdown 是否相同"。
    const previous = editor.__typoraPerformance
      ? editor.__typoraPerformance.historyMarkdown(undo.ir.lastText)
      : editor.lute.VditorIRDOM2Md(undo.ir.lastText);
    if (api.getValue() !== previous) undo.addToUndoStack(editor);
  };
  for (const action of ["undo", "redo"]) {
    const original = undo[action];
    undo[action] = function (state) {
      stopFollowing();
      if (state.currentMode === "ir") flush();
      else if (state.currentMode === 'wysiwyg') {
        clearTimeout(state.wysiwyg.processTimeoutId);
        if (api.getValue() !== state.lute.VditorDOM2Md(undo.wysiwyg.lastText)) undo.addToUndoStack(state);
      } else if (state.currentMode === 'sv') {
        // Source input records history after undoDelay too. A quick undo must
        // include the pending edit, and redo must not replay an abandoned one.
        // Compare text rather than syntax-highlight/caret markup: moving the
        // caret or recoloring a token must not create an extra history step.
        clearTimeout(state.sv.processTimeoutId);
        const snapshot=document.createElement('template');
        snapshot.innerHTML=undo.sv.lastText;
        if(state.sv.element.textContent!==snapshot.content.textContent)undo.addToUndoStack(state);
      }
      const mode = state.currentMode;
      // **空步不吃按键**。Vditor 的历史快照是 HTML 层的：我们重建文档（setValue）之后，公式重排 /
      // reconcile 挪节点会让"markdown 一个字没变"的状态也变成一条补丁，而它自己在 setValue 里挂的
      // 那次去抖 push 正好把它推到栈顶——用户按第一次 Ctrl+Z 撞上的就是它，什么也不发生
      //（用户 2026-09-14 第 7 轮："图片删除要两次 Ctrl+Z 没修好"；实测 scripts/acceptance/probe-img7.cjs
      // 在**用户原文档**上：一次 Delete 推两条，栈 2→3，第二条 mdLen 与第一条相同）。
      // 这里**只动撤销/重做的手势**（不碰历史记录）：走完一步之后如果 markdown 没变、栈里还有更早的
      // 补丁，就再走一步；最多连着走 3 步，防止病态情况下把整段历史吃光。
      let result = null;
      for (let step = 0; ; step++) {
        const stack = this[mode][action === 'undo' ? 'undoStack' : 'redoStack'];
        const patch = stack.at(-1), position = patch && historySelections.get(patch);
        pendingSelections.delete(mode);
        let before = null;
        try { before = api.getValue(); } catch { before = null; }
        result = preserveIR(api, () => original.call(this, state));
        if (position && stack.at(-1) !== patch) {
          restoreHistorySelection(state[mode].element, position[action === 'undo' ? 'before' : 'after']);
        }
        // Render caches and source-only history intentionally discard expansion
        // classes. A restored caret inside math still represents an editing
        // position: expose that source without replaying a click or moving it.
        if (['ir', 'wysiwyg'].includes(state.currentMode)) {
          const selection = getSelection(), root = state[state.currentMode].element;
          const code = elementAt(selection.focusNode)?.closest('code');
          const owner = code?.closest('.vditor-ir__node,.vditor-wysiwyg__block');
          const previewSelector = '.vditor-' + state.currentMode + '__preview';
          if (owner && root.contains(owner) && !code.closest(previewSelector) &&
              (code.matches(MATH) || owner.matches('[data-type="math-block"]'))) {
            if (state.currentMode === 'ir') owner.classList.add(EXPAND);
            const source = owner.querySelector(previewSelector)?.previousElementSibling;
            source?.style.removeProperty('display');
            const preview = owner.querySelector(previewSelector);
            if (preview) {
              protectPreviews(preview);
              window.__typoraScheduleMath?.(preview, {cdn:state.options.cdn,math:state.options.preview.math});
            }
          }
        }
        if (mode !== 'sv' && stack.at(-1) !== patch) {
          stopFollowing = followHistorySelection(state[mode].element, () => state.currentMode === mode, mode === 'wysiwyg' ? state.wysiwyg.popover : undefined);
        }
        if (before === null || step >= 3) break;
        let after = null;
        try { after = api.getValue(); } catch { after = null; }
        if (after !== before) break;                       // 这一步真的改了文档：正常收工
        if (this[mode][action === 'undo' ? 'undoStack' : 'redoStack'].at(-1) === patch) break;  // 已经走不动了
      }
      return result;
    };
  }
  const setValue = api.setValue;
  api.setValue = function (...args) { stopFollowing(); pendingSelections.clear(); return preserveIR(api, () => setValue.apply(this, args)); };
  const clearStack = api.clearStack;
  api.clearStack = function (...args) { stopFollowing(); pendingSelections.clear(); return clearStack.apply(this, args); };
  // after() runs before user input. Replace only the initial snapshot, which
  // Vditor may have recorded before KaTeX finished loading.
  if (undo.ir.undoStack.length <= 1 && !undo.ir.redoStack.length) api.clearStack();

  for (const mode of ['ir', 'wysiwyg', 'sv']) {
  editor[mode].element.addEventListener('compositionstart', () => {
    captureBeforeInput(mode);
    const pending = pendingSelections.get(mode);
    if (pending && !pending.receivedInput) pending.compositionBaseline = api.getValue();
  }, true);
  editor[mode].element.addEventListener('input', () => {
    const pending = pendingSelections.get(mode);
    if (pending) pending.receivedInput = true;
  }, true);
  editor[mode].element.addEventListener("beforeinput", event => {
    const action = {historyUndo: "undo", historyRedo: "redo"}[event.inputType];
    if (!action) {
      captureBeforeInput(mode);
      // insertText / paste can arrive without a physical keydown. Preserve the
      // initial source caret before that edit, just as Vditor's key handler does.
      if(mode==='sv'&&!event.isComposing)undo.recordFirstPosition(editor,event);
      return;
    }
    if (event.isComposing) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    undo[action](editor);
  }, true);
  editor[mode].element.addEventListener("keydown", event => {
    // Vditor handles Enter/Tab and some deletions directly in keydown, without
    // emitting beforeinput. Capture before those structural edits as well.
    if (!event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey &&
        ['Enter', 'Tab', 'Backspace', 'Delete'].includes(event.key)) captureBeforeInput(mode);
    if (event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    const action = key === "z" ? (event.shiftKey ? "redo" : "undo")
      : key === "y" && !event.shiftKey ? "redo" : null;
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    undo[action](editor);
  }, true);
  }
  flush.dispose = () => { stopFollowing(); pendingSelections.clear(); };
  return flush;
};

/**
 * The webview preload cancels native clipboard/history shortcuts at window
 * and forwards them to the host. Some VS Code forks route them to another
 * editor. Keep these keys inside the focused Vditor root: its existing key
 * handlers run first, then the browser dispatches the native clipboard event.
 * Do not cancel the default action or guess whether a cut succeeded later.
 */
const patchClipboardShortcuts = (api) => {
  const editor = api.vditor;
  for (const mode of ["ir", "wysiwyg", "sv"]) {
    const root = editor[mode]?.element;
    if (!root) continue;
    root.addEventListener("keydown", event => {
      if (editor.currentMode !== mode || event.isComposing || event.altKey) return;
      const key = (event.key || "").toLowerCase();
      const modified = event.ctrlKey || event.metaKey;
      const editKey = modified && ["x", "c", "v", "a", "z", "y"].includes(key) &&
        (!event.shiftKey || key === "v" || key === "z");
      const legacyKey = !event.metaKey &&
        ((event.ctrlKey && !event.shiftKey && key === "insert") ||
         (!event.ctrlKey && event.shiftKey && ["insert", "delete"].includes(key)));
      if (editKey || legacyKey) event.stopPropagation();
    });
  }
};

const patchHeadingEnter = (api, flush) => {
  const editor = api.vditor;
  const root = editor.ir.element;
  root.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing || editor.ir.composingLock ||
        event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const selection = getSelection();
    if (!selection.rangeCount || !selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const heading = elementAt(range.startContainer)?.closest("h1,h2,h3,h4,h5,h6");
    if (!heading || !root.contains(heading) || elementAt(range.startContainer)?.closest(PREVIEW)) return;
    const left = document.createRange();
    left.selectNodeContents(heading);
    left.setEnd(range.startContainer, range.startOffset);
    const right = document.createRange();
    right.selectNodeContents(heading);
    right.setStart(range.startContainer, range.startOffset);

    event.preventDefault();
    event.stopImmediatePropagation();
    flush();
    editor.undo.recordFirstPosition(editor, event);
    const first = document.createElement("p");
    first.setAttribute("data-block", "0");
    first.append(left.cloneContents());
    // 【F·C 修订·接管轮 2026-10-05】「左半没有正文文字」有两种，Enter 语义**必须分开**：
    //   · 光标在 heading 标记**之前**（`|### 标题内容`）= 块首 Enter —— 在标题前插一个空段、
    //     标题整行原样下移（Typora 语义，光标随标题走并停在它的标记前）。
    //   · 光标在标记**之后**（`### |标题内容`）= 标记钉在原行不动，标记之后的内容被回撤到
    //     下一行、落成**普通段落** —— 与「文字中间 Enter」走同一条拆分路径（那一路本来就
    //     把右半当普通文本重新解析），只是左半恰好只剩标记。
    //   【F·C】原判据 !leftWithoutMarkers.textContent 把这两种并成一类：`### |标题内容` 与
    //   `|### 标题内容` 按回车完全同形（都是"上方多一个空行、标题整行下移"），于是"井号被
    //   固定在原行"这件事在界面上根本不存在。判据现在多带一个"光标是否在标记之后"。
    const leftWithoutMarkers = first.cloneNode(true);
    leftWithoutMarkers.querySelectorAll('[data-type="heading-marker"]').forEach(marker => marker.remove());
    // 「光标是否已在标记之后」用**左半克隆里那枚 marker 的完整度**判，不碰 compareBoundaryPoints
    // 的 how 语义（那份取舍在主浏览器实现里有歧义，实测按 START_TO_END 判会得到 false）：
    // 左半（heading 起点 → 光标）里出现 marker，且克隆到的文字**不比原 marker 短**，就等于
    // "标记整枚都在光标左边"；比它短说明光标还停在标记文字中间——那种仍按块首语义走空行分支。
    const 光标在标记之后 = (() => {
      const marker = heading.querySelector('[data-type="heading-marker"]');
      if (!marker) return false;                      // 没有标记（html 标题等）：维持旧判据
      // 只认 ATX 形态（`###` + 可选空格）。setext 标题的标记内容是换行，和"井号被钉在原行"
      // 不是一回事；形态不认识就退回旧判据，绝不拿一个数值去赌分支。
      if (!/^#{1,6}[ \t]*$/.test(marker.textContent)) return false;
      const cloned = first.querySelector('[data-type="heading-marker"]');
      return !!cloned && cloned.textContent.length >= marker.textContent.length;
    })();
    if (!leftWithoutMarkers.textContent && !光标在标记之后) {
      // Enter before # inserts a blank line and carries the caret down with
      // the unchanged heading, still immediately before its source marker.
      first.innerHTML = "<br>";
      heading.before(first);
      heading.classList.add(EXPAND);
      const marker = heading.querySelector('[data-type="heading-marker"]');
      selectPoint(marker?.firstChild || marker || heading, 0);
    } else {
      const second = document.createElement("p");
      second.setAttribute("data-block", "0");
      second.append(document.createElement("wbr"), right.cloneContents());
      for (const block of [first, second]) {
        block.querySelectorAll('[data-type="heading-marker"]').forEach(marker => {
          marker.replaceWith(document.createTextNode(marker.textContent));
        });
      }
      // Spin reparses both source halves, so a remaining # prefix determines
      // heading level and inline formatting/math stays intact across the split.
      const template = document.createElement("template");
      template.innerHTML = editor.lute.SpinVditorIRDOM(first.outerHTML + second.outerHTML);
      const caretMarker = template.content.querySelector("wbr");
      const fallback = template.content.lastElementChild;
      heading.replaceWith(template.content);
      if (caretMarker) {
        selectOutside(caretMarker, false);
        caretMarker.remove();
      } else if (fallback) selectPoint(fallback, 0);
    }
    protectPreviews(root);
    root.querySelectorAll(PREVIEW + '[data-render="2"]').forEach(preview => {
      if (preview.querySelector(".language-math")) {
        Vditor.mathRender(preview, {cdn: editor.options.cdn, math: editor.options.preview.math});
        preview.setAttribute("data-render", "1");
      }
    });
    editor.outline.render(editor);
    // Use the editor's normal input/host notification path, without reparsing
    // just the right half a second time and merging the two blocks again.
    editor.ir.preventInput = true;
    root.dispatchEvent(new InputEvent("input", {bubbles: true, inputType: "insertParagraph"}));
    editor.undo.addToUndoStack(editor);
  }, true);
};

/** 【接管轮 2026-10-05·问题1 配套】「空标题 + 紧跟的段落」：段落行首退格由我们自己合并。
 *
 *  病象：`### |标题甲 $a+b=c$ 收尾` 按回车（新契约＝标记钉原行、内容落到下一行成普通段落）
 *  之后，光标就在新段落开头；紧接着按退格，**Blink 的原生块合并会把整条行内公式吃掉**——
 *  0×0 的 `$` 标记与 contenteditable=false 的预览岛一起消失，md 与磁盘都只剩 `### 标题甲  收尾`
 *  （定点探针 probe-lead-enter-bs.cjs 实测：新路 6 轮丢 3 轮；"内容末尾回车再退格"那条老路
 *  0/6，因为老路不搬动段落内容）。这不是新入口独有的形状，"空标题 + 紧跟段落 + 段落最左退格"
 *  任何来源都会中招，只是新契约把它变成一键之遥，必须先堵上。
 *
 *  修法（与 patchHeadingEnter 同构、同一条通道）：在原生合并**之前**接管这一键，把两份干净的
 *  outerHTML 拼成一个块交给 `SpinVditorIRDOM`——它的入参先过 `repairInlineMathWreck`
 *  （math-markdown.js 的包装层），结构由 Lute 重建，公式根本不经浏览器的手。
 *  只在「上一块是**空**标题、当前块是段落、光标在段落最左、无修饰键」时接管，其余一律放行。 */
const patchEmptyHeadingMerge = (api, flush) => {
  const editor = api.vditor;
  const root = editor.ir.element;
  root.addEventListener("keydown", event => {
    if (event.key !== "Backspace" || event.isComposing || editor.ir.composingLock ||
        event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.defaultPrevented) return;
    const selection = getSelection();
    if (!selection.rangeCount || !selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer)) return;
    const at = elementAt(range.startContainer);
    if (at?.closest(PREVIEW)) return;
    let cur = at;
    while (cur && cur.parentElement && cur.parentElement !== root) cur = cur.parentElement;
    if (!cur || cur.parentElement !== root || cur.tagName !== "P") return;
    const prev = cur.previousElementSibling;
    if (!prev || !/^H[1-6]$/.test(prev.tagName)) return;
    // 光标必须在段落**最左**：段落起点到光标之间既没有文字、也没有元素。
    const leftOfCaret = document.createRange();
    leftOfCaret.selectNodeContents(cur);
    try { leftOfCaret.setEnd(range.startContainer, range.startOffset); } catch { return; }
    if (leftOfCaret.toString() !== "" || leftOfCaret.cloneContents().querySelector?.("*")) return;
    // 上一块必须是**空**标题：把 heading 标记剔掉之后没有文字。
    const prevBare = prev.cloneNode(true);
    prevBare.querySelectorAll('[data-type="heading-marker"]').forEach(marker => marker.remove());
    if (prevBare.textContent) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    flush();
    editor.undo.recordFirstPosition(editor, event);
    const merged = document.createElement("p");
    merged.setAttribute("data-block", "0");
    const headingHalf = prev.cloneNode(true);
    headingHalf.querySelectorAll('[data-type="heading-marker"]').forEach(marker => {
      marker.replaceWith(document.createTextNode(marker.textContent));
    });
    merged.append(...headingHalf.childNodes, document.createElement("wbr"),
      ...[...cur.childNodes].map(node => node.cloneNode(true)));
    const template = document.createElement("template");
    template.innerHTML = editor.lute.SpinVditorIRDOM(merged.outerHTML);
    const caretMarker = template.content.querySelector("wbr");
    prev.replaceWith(template.content);
    if (caretMarker) {
      selectOutside(caretMarker, false);      // 落点在"标记 + 原标题文字"之后、段落内容之前＝合并缝
      caretMarker.remove();
    }
    cur.remove();
    protectPreviews(root);
    root.querySelectorAll(PREVIEW + '[data-render="2"]').forEach(preview => {
      if (preview.querySelector(".language-math")) {
        Vditor.mathRender(preview, {cdn: editor.options.cdn, math: editor.options.preview.math});
        preview.setAttribute("data-render", "1");
      }
    });
    editor.outline.render(editor);
    editor.ir.preventInput = true;
    root.dispatchEvent(new InputEvent("input", {bubbles: true, inputType: "deleteContentBackward"}));
    editor.undo.addToUndoStack(editor);
  }, true);
};

/** 【F14 / R10-P3】列表项里按 Tab：这一项缩进成**前一项的子项**（Typora 语义）。
 *
 *  病象（场景 124①，三轮逐字一致）：光标落在列表项**文字中间**按 Tab，什么也不发生——
 *  DOM 无嵌套、源码无缩进。vendored Vditor 自带的列表 Tab（index.min.js 的 at/lt 一对）
 *  只在光标位于**行首**（首文本节点 offset 0，或有选区）时才动手；文字中间的折叠光标
 *  落不进它的守卫，一路漏到段落分支。Typora 的口径是：**任意位置**按 Tab 都缩进整项。
 *
 *  修法（与 patchHeadingEnter 同构）：keydown 捕获段接管这一键，DOM 上把整个 li 挪进
 *  前一项的子列表（前一项已有子列表就并进去），再对整条列表 Spin 归一，wbr 锚定被挪
 *  的项；光标落在该项**首个正文文本节点 offset 0**——这正是 vendored Shift+Tab（lt，
 *  反缩进）自家守卫认的形状，反向一步退回顶层由原生路径达成（124②），本补丁**不接管
 *  Shift+Tab**。首项（无前项）preventDefault 后原地不动（no-op，也不许段落分支往文字
 *  里插空格）。代码块/表格格/代码元素里、补全候选框开着时一概放行——段落与代码块的
 *  Tab 语义属 vendor（插 options.tab 两个空格），保持 HEAD 行为不动。只在真实按键的
 *  keydown 里触发，不碰保存/自动保存路径。 */
const patchListTabIndent = (api, flush) => {
  const editor = api.vditor;
  for (const mode of ["ir", "wysiwyg"]) {
    const root = editor[mode]?.element;
    if (!root) continue;
    root.addEventListener("keydown", event => {
      if (editor.currentMode !== mode || event.defaultPrevented || event.isComposing) return;
      if (editor[mode].composingLock) return;
      if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      if (document.querySelector(".md-completion:not([hidden])")) return;   // 补全开着：Tab=接受候选
      const selection = getSelection();
      if (!selection?.rangeCount || !selection.isCollapsed) return;          // 选区形态交回 vendor 原生
      if (!root.contains(selection.focusNode)) return;
      const at = elementAt(selection.focusNode);
      const li = at?.closest?.("li");
      // 【R10-V11 修复】守卫不能写裸 "pre"：IR 编辑面本身就是 <pre class="vditor-reset">，
      // 恒命中 ⇒ 所有 li 判定被短路（V10 §3 死因②；F17b/patchSoftBreak 同款坑）。块代码
      // 按 [data-type='code-block'] 宿主锚定（其 pre/code 带 marker 类，"code" 照样兜住
      // 源码内文字），td/th 保留——负门域语义不变。
      if (!li || !root.contains(li) || at?.closest?.("code,[data-type='code-block'],td,th")) return;   // 代码块/表格格：负门域
      const list = li.parentElement;
      if (!list || (list.tagName !== "UL" && list.tagName !== "OL")) return;
      const prev = li.previousElementSibling;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!prev || prev.tagName !== "LI") return;                            // 首项：吞键不动结构（no-op）
      const doc = root.ownerDocument, previewSel = ".vditor-" + mode + "__preview";
      const scrollTop = root.scrollTop;
      if (mode === "ir") flush();
      else {
        clearTimeout(editor.wysiwyg.processTimeoutId);
        try { if (api.getValue() !== editor.lute.VditorDOM2Md(editor.undo.wysiwyg.lastText)) editor.undo.addToUndoStack(editor); }
        catch { /* 换算失败就少一条前置历史点，不影响本次编辑 */ }
      }
      editor.undo.recordFirstPosition(editor, event);
      const before = mode === "ir" ? null : api.getValue();
      // 挪动：并入前一项已有的子列表（同层追加），没有才造一条与父列表同形的子列表
      let nested = [...prev.children].find(kid => (kid.tagName === "UL" || kid.tagName === "OL") && kid !== li);
      if (!nested) {
        nested = doc.createElement(list.tagName);
        for (const name of ["data-marker", "data-block", "data-tight"]) {
          const value = list.getAttribute(name);
          if (value !== null) nested.setAttribute(name, value);
        }
        prev.appendChild(nested);
      }
      const marker = li.getAttribute("data-marker");                          // 有序子项编号重起（vendor at() 同式）
      if (marker && marker.length > 1) li.setAttribute("data-marker", "1" + marker.slice(-1));
      for (const stray of root.querySelectorAll("wbr")) stray.remove();       // 残留锚清场（vendor at() 同序）
      const anchor = doc.createElement("wbr");                               // wbr 穿过 Spin 存活：事后找回被挪的项
      li.firstChild ? li.insertBefore(anchor, li.firstChild) : li.appendChild(anchor);
      nested.appendChild(li);
      const spun = mode === "ir" ? editor.lute.SpinVditorIRDOM(list.outerHTML)
        : editor.lute.SpinVditorDOM(list.outerHTML);
      const template = doc.createElement("template");
      template.innerHTML = spun;
      list.replaceWith(template.content);
      root.scrollTop = scrollTop;
      // 光标落被挪项首文本 offset 0（= vendor Shift+Tab 反缩进守卫认的形状）
      const moved = root.querySelector("wbr")?.closest("li");
      if (moved) {
        const walker = doc.createTreeWalker(moved, NodeFilter.SHOW_TEXT);
        let text = null;
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.data.replace(/[\s\u200b\u200c]/g, "")) continue;
          if (node.parentElement?.closest(previewSel + ",.vditor-ir__marker,.vditor-wysiwyg__marker,[data-type$='-marker']")) continue;
          text = node; break;
        }
        root.focus({preventScroll: true});
        if (text) selectPoint(text, 0);
        else {
          const range = doc.createRange();
          range.selectNodeContents(moved);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
      for (const stray of root.querySelectorAll("wbr")) stray.remove();
      protectPreviews(root);
      root.querySelectorAll(previewSel + '[data-render="2"]').forEach(preview => {
        if (preview.querySelector(".language-math")) {
          Vditor.mathRender(preview, {cdn: editor.options.cdn, math: editor.options.preview.math});
          preview.setAttribute("data-render", "1");
        }
      });
      if (mode === "ir") {
        editor.ir.preventInput = true;
        root.dispatchEvent(new InputEvent("input", {bubbles: true, inputType: "formatIndent"}));
        editor.undo.addToUndoStack(editor);
      } else {
        const after = api.getValue();
        if (after !== before) { editor.options.input?.(after); editor.undo.addToUndoStack(editor); }
      }
    }, true);
  }
};

/** Shift+Enter：块内换行（软换行）——紧贴上一行另起一行，光标停在新行行首。
 *
 *  Vditor 的 IR 分支里没有 Shift+Enter：按键落到浏览器默认的 insertLineBreak，随后
 *  SpinVditorIRDOM 会把行尾换行剥掉，于是表现为"没有换行"或者"变成了新段落"。
 *  这里自己接管，只插一个 \n（IR 的 reset 是 white-space:pre-wrap，一个文本换行就画成
 *  紧贴的下一行），再把光标放到它后面。两种常见写法都不行：插两个 \n 会被解析成两个段落
 *  （正文之间就出现了段落间距），行尾插 <br> 会被 spin 删掉、DOM→Markdown 时也会丢。
 *
 *  不接管的容器：表格单元格、代码/公式块、标题——前两类 Vditor 自己就把 Enter 变成换行
 *  （单元格里是 <br>，而单元格里的字面换行在重新解析时会把表格行拆开），标题里的换行在这版
 *  Lute 里会被拆成 h1+p。若光标在公式源码或预览里也一律让路。
 *
 *  已知边界（Markdown 的语义边界，不是缺陷）：紧跟在块尾的换行在序列化时会被 Lute 归一化掉
 *  （"text\n" 与 "text" 不可区分），所以"Shift+Enter 后什么都不输入"在重新打开文件后不留空行；
 *  一旦后面接着输入内容，换行就固定在 Markdown 里（块中间与列表项里都能如实往返）。
 *
 *  【2026-09-11】块尾还多一层渲染问题：white-space: pre-wrap 下"块尾换行"按规范是悬挂的
 *  ——Chromium 不给它建行盒，块高不变、光标矩形为空 ⇒ 用户按一次 Shift+Enter 看不到任何
 *  变化，必须按两次（用户实测）。实测过的四种表示法（块高 / 光标矩形）：
 *    "text\n"        1 行 / 空   ← 现状：不可见
 *    "text\n<br>"    2 行 / 空   ← 有行但光标仍无框
 *    "text<br>"      1 行 / 空
 *    "text\n\u200b"  2 行 / 有框 ← 采用：行盒与光标都正常
 *  零宽空格在这里是"渲染脚手架"：Lute 序列化时会把行尾的它连同换行一起丢掉（实测
 *  SpinVditorIRDOM 对上面四种给出一模一样的 markdown），所以存盘文件依然干净。用户接着
 *  输入时由下面的 input 监听把脚手架摘掉，避免它留在正文里被复制出去。
 *  【2026-09-15】摘的时机很讲究：输入法拼字期间与拼字刚结束的那一拍都不能动这个文本节点，
 *  否则整个组合会被 Blink 作废并在节点开头重起（用户报的"光标跳到上一行'路'字前面"）。
 *  细则见 removePlaceholder 上方的注释。
 */
const SOFT_BREAK_PLACEHOLDER = "\u200b";
const patchSoftBreak = (api, flush) => {
  const editor = api.vditor;
  const root = editor.ir.element;
  // 只在"换行落在块尾"时补脚手架：块中间有后继内容，换行本来就正常渲染。
  const tailIsEmpty = (range, block) => {
    const tail = document.createRange();
    tail.setStart(range.startContainer, range.startOffset);
    tail.setEndAfter(block);
    const fragment = tail.cloneContents();
    fragment.querySelectorAll(PREVIEW).forEach(preview => preview.remove());
    return fragment.textContent.replace(/[\s\u200b]/g, "").length === 0;
  };
  // 用户真输入之后（isTrusted，排除我们自己派发的那个 input）把块尾脚手架摘掉。
  //
  // 【2026-09-15】输入法拼字期间一个字都不能改：Blink 的组合区间就挂在这个文本节点上，
  // 节点内容一变（哪怕只是删掉末尾那个零宽空格），它就把这次组合判为失效、在**节点开头**
  // 重新起一次组合（实测 compositionstart 的选区从行尾 39 跳到 0）。表现为用户报的：
  // "Shift+Enter 后用中文输入法打字，光标跑到上一行'路'字前面"——上屏的字插进了段落开头。
  // 所以组合期间只记状态不动 DOM，等 compositionend 之后再摘脚手架。
  // 另：只有新行上真落了字才摘（否则输入法空组合被取消时，块尾那行会因为脚手架消失而塌掉）。
  let composing = false;
  const removePlaceholder = event => {
    if (composing || (event && event.isComposing)) return;
    if (event && event.isTrusted === false) return;
    const selection = getSelection();
    if (!selection.rangeCount) return;
    const block = elementAt(selection.getRangeAt(0).startContainer);
    if (!block || !root.contains(block)) return;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    let last = null;
    while (walker.nextNode()) last = walker.currentNode;
    if (!last || !last.data.endsWith(SOFT_BREAK_PLACEHOLDER)) return;
    if (last.data[last.data.length - 2] === "\n") return;
    const caret = selection.getRangeAt(0);
    const caretInside = caret.startContainer === last && caret.startOffset <= last.data.length - 1;
    last.data = last.data.slice(0, -1);
    if (caretInside) selectPoint(last, caret.startOffset);
  };
  root.addEventListener("keydown", event => {
    if (event.key !== "Enter" || !event.shiftKey || event.isComposing || editor.ir.composingLock ||
        event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
    let selection = getSelection();
    if (!selection.rangeCount || !selection.isCollapsed) return;
    let range = selection.getRangeAt(0);
    let at = elementAt(range.startContainer);
    if (!at || !root.contains(at) || at.closest(PREVIEW)) return;
    // 【2026-09-16】光标停在行内公式的 `$` 标记上时先归位：标记是渲染出来的**虚拟位置**，
    // 把换行写进标记文本里，"闭 $ 之后"这个位置就没了——接着打的字会被公式的围栏逻辑当成
    // 源码收走（用户报的"光标在右 $ 之外打字却跳回公式"）。落到公式外侧的真实文本位置再换行。
    const owner = at.closest(".vditor-ir__node");
    const marker = at.closest(".vditor-ir__marker");
    if (owner && marker && owner.querySelector(':scope > code[data-type="math-inline"]')) {
      selectOutside(owner, marker === owner.lastElementChild);
      selection = getSelection();
      if (!selection.rangeCount || !selection.isCollapsed) return;
      range = selection.getRangeAt(0);
      at = elementAt(range.startContainer);
      if (!at || !root.contains(at) || at.closest(PREVIEW)) return;
    }
    // 注意不能写成 at.closest("pre")：整个 IR 编辑面本身就是 <pre class="vditor-reset">，
    // 那样写会把所有段落都当成代码块让路（本轮踩过）。代码/公式/HTML 块在 IR 里是带
    // data-type 的 div 包着 <pre>，按 data-type 判断才准确。
    if (at.closest("td,th,h1,h2,h3,h4,h5,h6,[data-type='toc-block'],[data-type='code-block'],[data-type='math-block'],[data-type='html-block']")) return;
    if (at.closest("code") || !at.closest("p,li")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    flush();
    editor.undo.recordFirstPosition(editor, event);
    const placeholder = tailIsEmpty(range, at) ? SOFT_BREAK_PLACEHOLDER : "";
    const node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) {
      const offset = Math.min(range.startOffset, node.data.length);
      node.data = node.data.slice(0, offset) + "\n" + placeholder + node.data.slice(offset);
      selectPoint(node, offset + 1);
    } else {
      const inserted = document.createTextNode("\n" + placeholder);
      range.insertNode(inserted);
      selectPoint(inserted, 1);
    }
    // 没有这一步，元素上的 input 监听会走 P(...) 重新 spin 这个块，行尾换行会被重解析掉。
    editor.ir.preventInput = true;
    root.dispatchEvent(new InputEvent("input", {bubbles: true, inputType: "insertLineBreak"}));
    editor.undo.addToUndoStack(editor);
    window.__typoraScheduleMath?.(root, {cdn: editor.options.cdn, math: editor.options.preview.math});
  }, true);
  root.addEventListener("compositionstart", () => { composing = true; }, true);
  // compositionend 之后这次组合就结束了；但**这一拍仍然不能动节点**——Blink 要在这条事件
  // 派发返回之后才把组合落定（实测在 compositionend 处理器里摘脚手架，光标照样被它复位到
  // 段落开头），所以推到下一个宏任务再摘。真实输入法的上屏 input 带 isComposing=true，
  // 会被上面的守卫挡掉，收尾只能靠这里。
  root.addEventListener("compositionend", () => { composing = false; setTimeout(removePlaceholder, 0); }, true);
  root.addEventListener("input", removePlaceholder);
};

const sourceNodes = (node) => {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
    acceptNode: text => text.parentElement.closest(PREVIEW) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const result = [];
  while (walker.nextNode()) result.push(walker.currentNode);
  return result;
};
const sourceOffset = (node, container, offset) => {
  const prefix = document.createRange();
  prefix.selectNodeContents(node);
  prefix.setEnd(container, offset);
  const fragment = prefix.cloneContents();
  fragment.querySelectorAll(PREVIEW).forEach(preview => preview.remove());
  return fragment.textContent.length;
};
/** 把"源码拼接空间里的偏移"映射回 `(文本节点, 节点内偏移)`。
 *
 *  `stay` 是光标**此刻**所在的那个文本节点。为什么要它：偏移正好落在某个节点的两个端点之一时，
 *  下面的顺序查找会把落点交给**前**一个节点——块公式里前一个节点是 `$$` 围栏，而围栏与源码
 *  **不在一行**（围栏独占一行），于是"在 `a|d` 按 ←"得到的是"跳到上一行的 `$$` 行尾"，
 *  用户看到的就是"没有走到 a 左侧、像是绕过了 a"（2026-09-19 用户报告；改写者由
 *  scripts/acceptance/probe-repro-trajectory.cjs 的 Selection API 代理栈抓到，就是我们这一步）。
 *  规则：落点落在自己身上时**留在自己身上**——源码两端（`|ad`、`ad|`）都停在源码行上。
 *  行内公式同理：`$a$` 与源码同处一行，端点归属换来换去会让光标在 `$` 与正文之间忽左忽右。 */
const sourcePoint = (nodes, offset, stay) => {
  if (stay) {
    let start = 0;
    for (const node of nodes) {
      if (node === stay) {
        if (offset === start) return [node, 0];
        if (offset === start + node.length) return [node, node.length];
        break;
      }
      start += node.length;
    }
  }
  for (const node of nodes) {
    if (offset <= node.length) return [node, offset];
    offset -= node.length;
  }
  const last = nodes[nodes.length - 1];
  return [last, last.length];
};

/** 相邻块里最靠边的一段**正文**文字（上一个块的末尾 / 下一个块的开头）。
 *
 *  围栏（`$$`）、预览结果、空白文本节点都不算落点：它们上面的光标要么**画不出来**
 *  （元素级 0×0），要么停在看不见的空白上。相邻块里没有正文（例如也是公式块）就返回 null。
 *
 *  两处用它：
 *   ① 公式源码走到两端时"出块"（`patchMathCaret`）；
 *   ② 点块公式四周空白带时，把"公式之前/之后"落到**看得见的正文**上（`patchBlankBandClick`，
 *      2026-09-19 用户口径："落到最近的可见正文位置（上一行行尾 / 下一行行首）"）。 */
const blockEdgeText = (node, forward) => {
  let sibling = forward ? node.nextSibling : node.previousSibling;
  while (sibling && sibling.nodeType !== Node.ELEMENT_NODE) {
    sibling = forward ? sibling.nextSibling : sibling.previousSibling;
  }
  if (!sibling) return null;
  const nodes = [];
  const walker = node.ownerDocument.createTreeWalker(sibling, NodeFilter.SHOW_TEXT, {acceptNode: text => {
    const host = text.parentElement;
    return host?.closest(PREVIEW) || host?.closest('.vditor-ir__marker,[data-type$="-marker"]')
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
  }});
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const first = nodes[0], last = nodes[nodes.length - 1];
  if (!first || !last) return null;
  return forward ? {node: first, offset: 0} : {node: last, offset: last.length};
};

const patchMathCaret = (api) => {
  const editor = api.vditor;
  const root = editor.ir.element;
  const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, {granularity: "grapheme"}) : null;
  /** 光标所在的公式节点：行内公式，或**块公式**（两个都要认，见下面 keydown 里的注释）。 */
  const mathOwner = (node) => elementAt(node)?.closest?.(
    '.vditor-ir__node[data-type="inline-node"],.vditor-ir__node[data-type="math-block"]');
  const isBlock = (node) => node.matches?.('.vditor-ir__node[data-type="math-block"]') && !node.closest?.(PREVIEW);
  /** 块公式走到源码两端时"出块"的落点（实现见模块级 `blockEdgeText`）。
   *  块公式占一整块，左右邻居是块而不是行内兄弟，所以不能沿用 `selectOutside` 的 sibling 逻辑
   *  ——块与块之间那一段只有空白的文本节点会被它当成落点，把光标停在一段看不见的空白上。 */
  const blockNeighbourPoint = blockEdgeText;
  /** 跨过 0×0 的空文本节点看下一个同辈：公式节点两侧都常有空的文本节点。 */
  const siblingStep = (node, forward) => {
    let current = node;
    while (current && current.nodeType === Node.TEXT_NODE && !current.length) {
      current = forward ? current.nextSibling : current.previousSibling;
    }
    return current;
  };
  /** 光标在行内公式**外面**、方向键又朝着公式走时，返回那个紧贴的公式节点（否则 null）。 */
  const adjacentMath = (focus, offset, forward) => {
    let candidate;
    if (focus.nodeType === Node.TEXT_NODE) {
      if (forward ? offset !== focus.length : offset !== 0) return null;
      candidate = forward ? focus.nextSibling : focus.previousSibling;
    } else {
      candidate = forward ? focus.childNodes[offset] || null : focus.childNodes[offset - 1] || null;
    }
    const node = siblingStep(candidate, forward);
    return node?.matches?.('.vditor-ir__node[data-type="inline-node"]') ? node : null;
  };
  root.addEventListener("keydown", event => {
    if (event.isComposing || editor.ir.composingLock || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!["ArrowLeft", "ArrowRight", "Backspace", "Delete"].includes(event.key)) return;
    const selection = getSelection();
    if (!selection.rangeCount) return;
    if (elementAt(selection.focusNode)?.closest(PREVIEW)) return;
    if (event.key === "Backspace" && selection.isCollapsed && !event.shiftKey) {
      const focus = selection.focusNode;
      const next = focus.nodeType === Node.TEXT_NODE
        ? (selection.focusOffset === focus.length ? focus.nextSibling : null)
        : focus.childNodes[selection.focusOffset];
      if (next?.matches?.('.vditor-ir__node[data-type="inline-node"]') && next.querySelector(MATH)) {
        // Let the browser delete the preceding body character. Vditor's keydown
        // handler otherwise treats this outside boundary as the opening $.
        event.stopImmediatePropagation();
        return;
      }
    }
    const enclosing = mathOwner(selection.focusNode);
    // 【2026-09-16】光标在公式**外面**、又紧贴着它，方向键朝着公式走 → 把光标放进源码里
    // （展开态由 Vditor 自己跟着光标挂上）。以前是整块跳过去，用户要的是 Typora 那样"进去"。
    // 【2026-09-17】块公式同样收进来。此前只认 data-type="inline-node"，块公式源码里的
    // 方向键整个交给了 Vditor 自己的 keydown：实测（probe-math-keys2.cjs，Selection API
    // 代理 + selectionchange 时间线）它每次按键都 removeAllRanges() + addRange(自己算的区间)，
    // 而算出来的区间**每两下就塌一次**——在源码里按住 Shift 连按 ← 得到的是
    // "选中 1 个字符 → 长度 0 → 又选中 1 个字符"，用户报的"选中失败"就是这个。
    // 认领块公式之后走的是下面这段我们自己的边界步进（含 selection.extend 的 Shift 支持）。
    if (!enclosing) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      // 【H·D 2026-10】非折叠（选区已建立）一律不抢这条"进源码"导航——扩选中把 focus
      // 拉回源码会把扩选吃掉（dev 探针 H-gate dbg1 k6-k8：跨出公式后 focus 停在公式后
      // 文本 offset 0，每按都被这里拦停、len 恒 6 不再增长）。导航语义只在折叠态有意义。
      if (!selection.isCollapsed) return;
      const forward = event.key === "ArrowRight";
      const math = adjacentMath(selection.focusNode, selection.focusOffset, forward);
      const nodes = math ? sourceNodes(math.querySelector(MATH)) : [];
      const target = forward ? nodes[0] : nodes[nodes.length - 1];
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.shiftKey) extendEnd(forward, target, forward ? 0 : target.length);
      else selectPoint(target, forward ? 0 : target.length);
      return;
    }
    const node = enclosing;
    const block = isBlock(node);
    const code = node.querySelector(MATH) || (block ? node.querySelector('code[data-type="math-block"]') : null);
    if (!code || !node.classList.contains(EXPAND)) return;
    // 选中范围跨出了这条公式（在正文里拖选到这里、或整块选中）：不是这套步进的地盘。
    if (!node.contains(selection.anchorNode) || !node.contains(selection.focusNode)) return;
    const nodes = sourceNodes(node);
    const text = nodes.map(text => text.textContent).join("");
    const forward = event.key === "ArrowRight";
    // **移动端**：向左走是选区的起点、向右走是终点（选区为空时两者都是光标）。
    // 不能用 focusNode：Vditor 每次选区变化都会把自己的区间重设一遍，anchor/focus 的方向
    // 随之被规范化，于是"按住 Shift 连按 ←"每次都从同一个位置重算、选区停在第一个字符上
    // （实测：解掉"每两下塌一次"之后就撞上这一条）。
    // 注意 forward 必须在这之前声明：本轮就踩过一次"先用后声明"的 TDZ 坑——整段补丁
    // 静默抛 ReferenceError、被外层 catch 吞掉，表现得像"补丁没装"。
    const caretRange = selection.getRangeAt(0);
    const movingNode = forward ? caretRange.endContainer : caretRange.startContainer;
    const movingOffset = forward ? caretRange.endOffset : caretRange.startOffset;
    const offset = sourceOffset(node, movingNode, movingOffset);
    const codeEnd = node.firstElementChild.textContent.length + code.textContent.length;
    if (selection.isCollapsed && offset === codeEnd) {
      if (event.key === "Backspace" && !code.contains(selection.focusNode)) {
        const codeNodes = sourceNodes(code);
        const last = codeNodes[codeNodes.length - 1];
        if (last) selectPoint(last, last.length);
        return;
      }
      if (event.key === "Delete") {
        const marker = node.lastElementChild;
        selectPoint(marker.firstChild || marker, 0);
        return;
      }
    }
    // 退格/删除的贴边保护归 math-edit 的 boundaryNode（它是"一个字节都不改"那一套），
    // 这里只接管行内公式：块公式的 selectOutside 会落到块与块之间的空文本节点上。
    // 【A4 2026-10-02】开 `$` 边上的退格改成**让位**：boundaryNode 对"围栏两端"的退格本来就放行
    // （退格指的是围栏外那个字符，见它 fence 分支的注释），此前这里抢先用 selectOutside 只把光标
    // 挪出去、一个字都不删——x$a$ 开 `$` 左半按退格，用户要的是删掉前面的 'x'，看到的却是
    // "光标跑到公式前、字还在"。与上面"公式外行尾贴公式退格"同一条路：拦下 Vditor
    // （它会把这里当开 `$` 处理），默认删除留给浏览器去删那个正文字符。
    if (event.key === "Backspace" && !event.shiftKey && selection.isCollapsed && !block &&
        offset <= node.firstElementChild.textContent.length) {
      event.stopImmediatePropagation();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (!selection.isCollapsed && !event.shiftKey) return;
    if ((!forward && offset === 0) || (forward && offset === text.length)) {
      // 先算出落点再 preventDefault：算不出来就整个留给浏览器/Vditor（免得拦了却没有下文）。
      const target = block ? blockNeighbourPoint(node, forward) : selectOutsidePoint(node, forward);
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.shiftKey && !block) {
        // 【H·C 2026-10】Shift 扩出公式：固定端吸到 owner 整条的**外侧**（公式另一头），
        // 整条公式并入选区。固定端留在源码里的话，选区跨过的全是 display:none 的
        // 围栏+源码，可见长度 0、高亮一格都画不出来——用户看到"扩出公式那一下，
        // 选区当场没了"（dev 探针 H-probe2.cjs C1 k5 实锤 len=0，k6 又恢复的瞬态）。
        // 端点吸到 owner 外侧边界，与 math-select-reveal B3 的"整条并入"同一条口径。
        const far = selectOutsidePoint(node, !forward);
        if (far) { selection.setBaseAndExtent(far.node, far.offset, target.node, target.offset); return; }
      }
      if (event.shiftKey) extendEnd(forward, target.node, target.offset);
      else selectPoint(target.node, target.offset);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const boundaries = segmenter ? [...segmenter.segment(text)].map(part => part.index)
      : [0, ...Array.from(text).map((_, i, chars) => chars.slice(0, i + 1).join("").length)];
    boundaries.push(text.length);
    const next = forward ? boundaries.find(value => value > offset)
      : boundaries.filter(value => value < offset).pop();
    if (next === undefined || next === offset) return;   // 没有下一步：交给浏览器/Vditor
    // 带上 movingNode：端点归属留在光标当前所在的文本节点上（见 sourcePoint 的说明）。
    const [target, position] = sourcePoint(nodes, next, movingNode?.nodeType === Node.TEXT_NODE ? movingNode : null);
    if (event.shiftKey) extendEnd(forward, target, position);
    else selectPoint(target, position);
  }, true);
};

/** 上下方向键跳过"整行只有一条行内公式"的行。
 *
 *  用户报告（2026-09-17）："上下方向键遇到单行仅有 inline math 的会导致光标跳过这一行,
 *  而非正常逻辑上跑到 inline math 行最后"。
 *  实测（scripts/acceptance/probe-math-keys.cjs，同一份文档只换中间那一行）：
 *    纯文字中段        → ↓ 正常落到它
 *    `$a$ $b$`（两条） → ↓ 正常落到它（行里有别的文字）
 *    `$a$ 乙`（公式+字）→ ↓ 正常落到它
 *    **只有一条 `$a$`** → ↓ 直接跳到下一段，↑ 同样从上面跨过去
 *  归因：Chromium 的纵向移动在**可编辑落点**的行盒里找目标，而这一行上只有一条折叠态的
 *  行内公式——`$` 围栏是 display:none、源码是隐藏的、渲染结果是 contenteditable=false，
 *  整行没有任何可编辑落点，于是被整行跳过。
 *
 *  修法：不重写纵向移动，只在**原生结果确实跳过了这样一行**时纠正一次——按下时记下光标
 *  矩形与目标列 x，默认动作跑完（setTimeout 0）再看落点：两点之间若夹着"只有一条公式"的
 *  行，就把光标放进那条公式的源码、落在**离目标列最近**的字符上。这与同一次按键在块公式上
 *  的原生行为是同一个形状（实测 ↓ 停在源码 offset 1、块公式展开），不是新发明的语义。
 *  只在"确实跳过了"且"落点是我们认得的那种行"时动手，其余一律不动。
 */
const patchVerticalMathLine = (api) => {
  const editor = api.vditor;
  const root = editor.ir.element;
  let goalX = null;          // 连续上下移动里的目标列
  let lastBox = null;        // 上一次**可见**的光标矩形（隐形落点时用它当锚）
  const reset = () => { goalX = null; lastBox = null; };
  const visibleBox = range => {
    if (!range) return null;
    const box = range.getBoundingClientRect ? range.getBoundingClientRect() : null;
    return box && box.height ? box : null;
  };
  const caretBox = () => {
    const selection = getSelection();
    if (selection?.rangeCount && selection.focusNode && root.contains(selection.focusNode)) {
      const probe = document.createRange();
      probe.setStart(selection.focusNode, selection.focusOffset);
      probe.collapse(true);
      const box = visibleBox(probe);
      if (box) return box;
    }
    return null;
  };
  const usable = hit => {
    if (!hit || !root.contains(hit.startContainer)) return false;
    const at = hit.startContainer.nodeType === 3 ? hit.startContainer.parentElement : hit.startContainer;
    const 坏层 = at?.closest?.(".vditor-ir__preview,.vditor-ir__marker,[data-type$='-marker']");
    if (坏层) {
      // 【L1】代码块源码行按可落行处理：源码住在 pre.vditor-ir__marker--pre 里（里面的 code 元素
      // 也带 marker 类），此前被围栏筛子整块拒掉——↓/↑ 于是跳过整段代码块、高块还吞键。只放行
      // 宿主是 [data-type="code-block"] 且**源码 pre 真显示着**（高>0，展开态）的那一个 pre；
      // 折叠态源码 pre 高 0、文字被挤进窄柱折成幻影行（实测 [54,241]…），命中的位置带着假矩形，
      // 照样拒。公式源码的 code 同样带这个类，但宿主是 inline-node / math-block，照旧拒
      // （公式行走 formulaLineAt / codeAtHit 自己的映射）。
      const 源码pre = 坏层.matches?.("pre.vditor-ir__marker--pre") ? 坏层 : 坏层.closest?.("pre.vditor-ir__marker--pre");
      if (!源码pre || !源码pre.closest?.('[data-type="code-block"]')) return false;
      if (!((源码pre.getBoundingClientRect().height || 0) > 0)) return false;
    }
    return !!visibleBox(hit);
  };
  const doc = root.ownerDocument;
  const pushTrace = (stage, detail) => {
    if (!window.__vertTraceOn) return;
    const ring = window.__vtrace || (window.__vtrace = []);
    ring.push(stage + ' ' + JSON.stringify(detail));
    if (ring.length > 60) ring.shift();
  };
  /** (x,y) 命中在哪个表格格里。几何说话、用 elementFromPoint：空格里 caretRangeFromPoint 给不出
   *  本格位置（它把点钳去最近的可编辑文本），恰恰是 T1 要修的病，不能用它来认格。 */
  const 命中格 = (x, y) => {
    const el = doc.elementFromPoint ? doc.elementFromPoint(x, y) : null;
    const cell = el?.closest?.("td,th");
    return cell && root.contains(cell) ? cell : null;
  };
  /** 格子里有没有**可落正文**（预览、围栏、公式源码都不算）：没有的格（空格/纯公式格）才给伪落点。
   *  格里有正文却一时命不中（比如正排在别的视觉行上）时**不**给伪落点——返回 null 交给外层。 */
  const 格有正文 = cell => {
    const walker = doc.createTreeWalker(cell, NodeFilter.SHOW_TEXT, {acceptNode: text =>
      text.parentElement?.closest(".vditor-ir__preview,.vditor-ir__marker,[data-type$='-marker'],code[data-type]")
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
    let text;
    while (walker.nextNode()) if (walker.currentNode.data.replace(/[\s\u200b]/g, "")) return true;
    return false;
  };
  /** 在 (x, y) 上找可编辑落点：目标列附近扫一遍，再低端密扫（空行/短行只能落行首）。
   *  **优先取"矩形真的盖住 y"的候选**：只按"离目标列最近"挑，会挑中**相邻行**的位置
   *  （实测：目标列 569 时挑中 x=876、顶=340 的候选，而 y 已经扫到 380——那本是下一行的位置，
   *  于是 366 那一行被整行跳过，用户看到的就是"↓ 跳行"）。盖住的都没有，才退回最近的。
   *  【T1】目标列命中表格的空格/纯公式格时给伪落点直落该格，不跳邻列：候选钳在 (x,y) 所在的
   *  td/th 里找——不钳的话 best/近端 桶会被**邻列**同一视觉行的候选占走，↓ 变成"落到隔壁列"。
   *  本格确实一个可用落点都没有、又没有可落正文（空格/纯公式格）→ 给 (格,0) 伪落点：光标矩形
   *  虽是 0×0，但该位本就是正常插入点（原生光标真屏画得出；合成线 2026-10-02 已删），打字如实落进本格。 */
  const resolveAt = (x, y) => {
    if (!doc.caretRangeFromPoint) return null;
    let best = null;      // 盖住 y 的候选里离目标列最近的
    let 近端 = null;      // 盖不住 y 的候选里离目标列最近的（只在前者缺席时才用）
    const 试过 = [];
    const 格 = 命中格(x, y);
    for (const tryX of [x, x - 8, x + 8, x - 16, x + 16, x - 32, x + 32, 0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 96, 112, 128, 160, 200]) {
      const hit = doc.caretRangeFromPoint(tryX, y);
      if (!usable(hit)) continue;
      if (格 && !格.contains(hit.startContainer)) continue;    // 候选不出本格
      const box = hit.getBoundingClientRect();
      试过.push([Math.round(tryX), Math.round(box.left), Math.round(box.top)]);
      const 分 = Math.abs(box.left - x);
      const 距 = Math.abs(box.top - y);          // 与扫描线的行距
      if (y >= box.top - 2 && y <= box.bottom + 2) {
        if (!best || 分 < Math.abs(best.box.left - x)) best = {hit, box};
      } else if (!近端 || 距 < 近端.距 || (距 === 近端.距 && 分 < 近端.分)) {
        // 盖不住的候选里**先看行距**：只按"离目标列近"挑，会挑到更远那一行的位置
        // （实测 ↑ 时挑中 876@顶340，而 y=387 那一带属于 366 行 ⇒ 366 行被整行跳过）。
        近端 = {hit, box, 分, 距};
      }
    }
    if (格 && 格.isConnected && !best && !近端 && !格有正文(格)) {
      const range = doc.createRange();
      range.setStart(格, 0);
      range.collapse(true);
      pushTrace('空格伪落点', {求: [Math.round(x), Math.round(y)], 格: Math.round(格.getBoundingClientRect().top)});
      return range;
    }
    const 选 = best || 近端;
    pushTrace('resolve', {求: [Math.round(x), Math.round(y)], 命中: 选 ? [Math.round(选.box.left), Math.round(选.box.top)] : null,
      盖住y: !!best, 候选: 试过.slice(0, 6)});
    return 选 ? 选.hit : null;
  };
  /** 落点落在渲染结果里 → 映射到那条公式的源码（空公式块的整块占位只在预览里）。 */
  const codeAtHit = hit => {
    const at = hit?.startContainer?.nodeType === 3 ? hit.startContainer.parentElement : hit?.startContainer;
    const preview = at?.closest?.(".vditor-ir__preview");
    if (!preview) return null;
    const owner = preview.closest(".vditor-ir__node[data-type],.vditor-wysiwyg__block");
    const code = owner?.querySelector(":scope > code[data-type='math-inline'],:scope > pre > code[data-type='math-block']");
    const text = code?.firstChild?.nodeType === Node.TEXT_NODE ? code.firstChild : code;
    if (!code || !text) return null;
    const box = preview.getBoundingClientRect();
    const offset = sourceOffsetAtPoint(preview, code, {clientX: goalX === null ? (box.left + box.right) / 2 : goalX, clientY: (box.top + box.bottom) / 2});
    const range = doc.createRange();
    range.setStart(text, Math.max(0, Math.min(offset === null ? text.length : offset, text.length)));
    range.collapse(true);
    // （R1·C5 曾在此为折叠 $$ 块免可见性筛；复现轮证明本产品块源码常显、前提不成立——撤销，不落地。）
    return visibleBox(range) ? range : null;
  };
  /** 这一 y 带上是不是一条**只有行内公式**的行：是就把目标列映射进那条公式的源码。
   *  为什么必须有它：这样的行里除了 contenteditable=false 的渲染结果什么都没有，
   *  caretRangeFromPoint 给的是预览里的位置（不可编辑）→ resolveAt 全被拒绝 → 扫描会**整行跳过**
   *  （实测：场景 109⑤ 与 110①③ 在丢掉这条之后当场变红——那正是用户说的"跳过 inline math 行"）。 */
  const formulaLineAt = (x, y) => {
    // （R1·C5 复现轮证明块源码常显、前提不成立，撤销）
    for (const owner of root.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')) {
      const box = owner.getBoundingClientRect();
      if (!box.height || y < box.top - 2 || y > box.bottom + 2) continue;
      const code = owner.querySelector('code[data-type="math-inline"]');
      const preview = owner.querySelector(":scope > .vditor-ir__preview");
      const text = code?.firstChild?.nodeType === Node.TEXT_NODE ? code.firstChild : null;
      if (!code || !preview || !text) continue;
      const offset = sourceOffsetAtPoint(preview, code, {clientX: x, clientY: y});
      const range = doc.createRange();
      range.setStart(text, Math.max(0, Math.min(offset === null ? text.length : offset, text.length)));
      range.collapse(true);
      // **不要**要求这个位置"此刻可见"：折叠态下源码是 display:none，它自己的 rect 是 0×0，
      // 按"可见"筛就会把整行丢掉（实测：这一步筛掉之后场景 109⑤/110①③ 全红，而且用户那份
      // 真实文档里最后一行 `$a$` 的"卡住"也是同一个形状）。放进去之后公式会展开，自然可见。
      return range;
    }
    return null;
  };
  /** 【L1】代码块源码行的行盒附表：折叠态源码 display:none 量不出自己的矩形，boxOf 只能退到
   *  整块 owner 盒（跨所有行——高块的逐行语义就没了）。codeLineAt 每造一个源码落点，就把
   *  **预览里这一行**的行盒挂进来；WeakMap 随 Range 一起回收，不用清理。 */
  const code行盒 = new WeakMap();
  /** 【L1】这个位置是否落在**折叠态**的代码源码 pre 里：源码 pre 高 0，但文字仍参与排版
   *  （被挤进 ~7px 窄柱折成一串幻影行，实测 [54,241]…[54,811]）——落在里面的 range 自己
   *  就量得出假矩形。boxOf 拿它当真会把行判/方向判/中线重算带歪；放完光标拿它当锚，
   *  keepColumn 会按幻影中线重解、把光标拽回块外的邻行（↑ 白落）。 */
  const 折叠源码 = node => {
    const at = node?.nodeType === 3 ? node.parentElement : node;
    const pre = at?.closest?.('pre.vditor-ir__marker--pre');
    return !!(pre && !(pre.getBoundingClientRect().height > 0));
  };
  /** 【L1】代码块行映射（math 的 formulaLineAt 同路，对象换成 code-block）。
   *  复现读数（probe-r2-code L1a/L1b，2026-10-02）：只放行 usable 的 code-block 源码位置不够——
   *  折叠态可见文本住在 pre.vditor-ir__preview（contenteditable=false，命中被 usable 拒），
   *  源码 pre>code 是 display:none，resolveAt 在块上一个候选都拿不到，近端桶还会被
   *  **钳到块后段落**的候选占走（↓ 从首段一步落到尾段、15 行块原地/跳过，全是这个形状）。
   *  这里按 owner 盒接住 (x, y)：y 用**预览行盒**选行（不要求源码此刻可见——与 formulaLineAt
   *  同一条纪律），x 按行盒比例取该源码行内最近的字符边界（代码行等宽字体，比例≈逐字），
   *  返回源码文本里的真实 Range（落进去节点随之展开，与公式源码同一条路）。
   *  展开态预览没有盒子，本函数自然返回 null，让位给 resolveAt（源码可见、usable 已放行
   *  code-block 宿主的 pre.vditor-ir__marker--pre——公式围栏的拒收语义不受影响，宿主不是
   *  code-block 的照旧拒）。围栏 ``` 行没有自己的落点，y 落在围栏带时映射到最近的那一源码行，
   *  与纵向补丁对公式围栏行的既有取向一致。 */
  const codeLineAt = (x, y) => {
    if (x === null || x === undefined) return null;
    for (const block of root.querySelectorAll('.vditor-ir__node[data-type="code-block"]')) {
      const box = block.getBoundingClientRect();
      if (!box.height || y < box.top - 2 || y > box.bottom + 2) continue;
      if (x < box.left - 40 || x > box.right + 40) continue;
      const src = block.querySelector(':scope > pre.vditor-ir__marker--pre > code')
        || block.querySelector('pre.vditor-ir__marker--pre code')
        || block.querySelector('code[data-type="code-block"]');
      const preview = block.querySelector('pre.vditor-ir__preview');
      if (!src || !preview) continue;
      // 展开态判定看**源码 pre 是否真显示**（高>0），不能看预览有没有盒：本构建里展开后
      // preview 并不隐藏、只是被源码顶到下方（实测源码行 249..306、预览行 328..384 同屏
      // 可见）——若按预览判断，codeLineAt 会在展开态继续抢跑、拿被顶下去的预览行选行，
      // 行号全错（↑ 在展开块里会从第 2 行直接跳第 0 行）。源码显示着就让位 resolveAt
      // （源码可命中、usable 已放行）。
      const 源pre = src.closest('pre') || src.parentElement;
      if (!源pre || (源pre.getBoundingClientRect().height || 0) > 0) continue;
      // 预览行盒：逐**文本节点**量。不能 selectNodeContents(preview) 整段取——那会把块级的
      // code 盒（实测杂散矩形 [46,243,894,331]：整块一条、跨所有行）也带进来，行分组随之错位：
      // ↓ 在围栏带被映射到第 2 行、boxOf 拿到杂散行盒、中线重算被 resolveAt 的邻行候选劫走，
      // 整块跳过再现（L1a 复跑 trace 实锤）。文本节点的 rect 只给自己那一行的字形片段，
      // 按行顶 ±3 归并即得真视觉行。
      const rows = [];
      const tw = doc.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
      let tn;
      while ((tn = tw.nextNode())) {
        if (!tn.data.length) continue;
        const rr = doc.createRange();
        rr.selectNodeContents(tn);
        for (const rect of rr.getClientRects()) {
          if (rect.height <= 0 || rect.width <= 0) continue;
          const same = rows.find(q => Math.abs(q.top - rect.top) <= 3);
          if (same) {
            same.right = Math.max(same.right, rect.right);
            same.left = Math.min(same.left, rect.left);
            same.bottom = Math.max(same.bottom, rect.bottom);
          } else rows.push({top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right});
        }
      }
      if (!rows.length) continue;                        // 预览没画出来（展开态）：让位 resolveAt
      rows.sort((a, b) => a.top - b.top);
      const 行 = rows.find(r => y >= r.top - 2 && y <= r.bottom + 2)
        || rows.reduce((a, b) => Math.abs((a.top + a.bottom) / 2 - y) <= Math.abs((b.top + b.bottom) / 2 - y) ? a : b);
      // lute 在源码尾部多写一个换行（"…c = 3;\n"）：削掉再切行，行号才与预览行一一对应
      const raw = src.textContent;
      const 源行 = (raw.endsWith('\n') ? raw.slice(0, -1) : raw).split('\n');
      const 序 = Math.max(0, Math.min(rows.indexOf(行), 源行.length - 1));
      let 起点 = 0;
      for (let i = 0; i < 序; i++) 起点 += 源行[i].length + 1;
      const 行长 = 源行[序].length;
      const 分 = Math.max(0, Math.min(1, (x - 行.left) / Math.max(1, 行.right - 行.left)));
      const 偏 = Math.max(0, Math.min(行长, Math.round(分 * 行长)));
      // 绝对偏移 → 源码里的文本节点（通常单节点，稳妥起见走一遍 walker）
      const 节 = [];
      const walker = doc.createTreeWalker(src, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) 节.push(walker.currentNode);
      if (!节.length) continue;
      let 绝 = 起点 + 偏, 容 = 节[0], 内 = 0;
      for (const n of 节) {
        if (绝 <= n.length) { 容 = n; 内 = 绝; break; }
        绝 -= n.length; 容 = n; 内 = n.length;
      }
      const range = doc.createRange();
      range.setStart(容, Math.max(0, Math.min(内, 容.length)));
      range.collapse(true);
      code行盒.set(range, {left: 行.left, right: 行.right, top: 行.top,
        bottom: 行.bottom, width: 行.right - 行.left, height: 行.bottom - 行.top});
      pushTrace('code行', {求: [Math.round(x), Math.round(y)], 行: 序, 列: 偏});
      return range;
    }
    return null;
  };
  /** 落点的几何：优先用它自己的矩形；折叠态公式源码没有矩形时退回**公式节点**的盒子。 */
  const boxOf = hit => {
    const at = hit?.startContainer?.nodeType === 3 ? hit.startContainer.parentElement : hit?.startContainer;
    // 【L1】幻影矩形防御：折叠代码源码里的 range 量得出假矩形（见 折叠源码 注释），
    // 不能让它先说话——改用 codeLineAt 附上的预览行盒；源码真显示着（展开态）矩形才是真的。
    if (!折叠源码(hit?.startContainer)) {
      const own = hit ? visibleBox(hit) : null;
      if (own) return own;
    }
    const code盒 = hit ? code行盒.get(hit) : null;
    if (code盒 && code盒.height) return code盒;
    // 【T1】td/th 也算宿主：空格伪落点 (格,0) 自己没有矩形，靠格盒交代行位。
    const owner = at?.closest?.('.vditor-ir__node[data-type],.vditor-wysiwyg__block,td,th');
    const box = owner ? owner.getBoundingClientRect() : null;
    return box && box.height ? box : null;
  };
  const place = range => {
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };
  /** 光标在公式源码里时它所在的块（"落点隐形"时用它找相邻块）。 */
  const codeLine = () => {
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.focusNode) return null;
    const code = elementAt(selection.focusNode)?.closest?.('code[data-type="math-inline"],code[data-type="math-block"]');
    if (!code || code.closest(".vditor-ir__preview")) return null;
    const owner = code.closest(".vditor-ir__node[data-type],.vditor-wysiwyg__block");
    return owner ? {owner, block: owner.closest("p,li,h1,h2,h3,h4,h5,h6") || owner} : null;
  };
  const neighbourBlock = (block, forward) => {
    let node = block;
    while (node && node !== root) {
      let sibling = forward ? node.nextElementSibling : node.previousElementSibling;
      while (sibling && !sibling.getClientRects().length) {
        sibling = forward ? sibling.nextElementSibling : sibling.previousElementSibling;
      }
      if (sibling) return sibling;
      node = node.parentElement;
    }
    return null;
  };
  /** 光标已经**贴着可视区边缘**时，把滚动容器滚一小步、再用滚动后的新几何重扫一次。
   *
   *  为什么必须补这一手：纵向移动整段是我们接管的（`preventDefault` + 自己算落点），
   *  浏览器"把光标移进视口、顺带滚动"这个副作用就一起丢了。于是长文档里按住 ↓ 走到
   *  **可视区最后一行**就彻底停住：扫描被限制在编辑面框内（`y > surfaceBox.bottom - 1` 就 break），
   *  下一行在框外 → `scan` 返回 null → 走"到顶/到底"分支 → 既不移动也不滚动。
   *  用户口径就是"按住方向键一顿一顿走不动"。
   *
   *  实测（scripts/acceptance/probe-f4-hold-steps.cjs，素材 18 块、内容高 821 > 窗高 713）：
   *  18 发 ↓ 走到块 15（y=707）后连着 5 发原地不动，期间滚动量**恒为 0**；
   *  手动把滚动容器下滚 120px 之后，同一发按键立刻前进到块 16 —— 与"下一行在可视区外"一致。
   *  只滚"贴边"这一种情况，且在滚不动（真到底）时原样退给"到顶/到底"分支。 */
  /** 可视区的**上边**：编辑面顶边，但绝不能低于**工具栏底边**。
   *
   *  工具栏（`.vditor-toolbar`）是绝对定位浮在正文之上的（实测盒子 `[0,0,922,71]`、`z-index:30`）。
   *  正文滚上去之后最上面几行会钻到它底下：那一带**既看不见、也命不中**——
   *  `caretRangeFromPoint(x, y<71)` 拿回的是工具栏按钮（不可用），只有 x=0 掉到正文上。
   *  纵向补丁的 `resolveAt` 于是在这一带只能拿到"行首"这一个候选，目标列被钳成 x=46
   *  （实测 probe-f4-toprow.cjs：`求[74,27]` 全部不可用、`候选=[[0,46,14]]`，
   *  覆盖元素 `button.vditor-tooltipped … 盒=[69,1,25,35]`）。 */
  const 可视顶 = () => {
    const frame = root.getBoundingClientRect ? root.getBoundingClientRect() : null;
    const 顶 = frame ? frame.top : 0;
    const bar = editor.toolbar?.element;
    const 条 = bar?.getBoundingClientRect ? bar.getBoundingClientRect() : null;
    return 条 && 条.height ? Math.max(顶, 条.bottom) : 顶;
  };
  /** 真正的滚动容器：实测是 `.vditor-reset` 自己（不是 `.vditor-ir`，也不是窗口）。 */
  const 滚动容器 = () => {
    const surface = root.matches?.('.vditor-reset') ? root : root.querySelector?.('.vditor-reset');
    return [surface, root, doc.scrollingElement]
      .find(el => el && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1) || null;
  };
  /** 落点落在可视区外时把它带进来（留一点余量）。
   *  我们接管纵向移动之后，浏览器"把光标滚进视口"这个副作用也丢了——留一半行的余量，
   *  免得光标正好贴着视口边缘（真人手感里那种"光标卡在边上"）。 */
  const 滚进视口 = box => {
    const scroller = 滚动容器();
    if (!scroller || !box) return;
    const frame = scroller.getBoundingClientRect();
    if (!frame.height) return;
    const 余 = Math.max(6, Math.round((box.height || 18) * 0.6));
    const 顶 = 可视顶() + 余;
    if (box.top < 顶) scroller.scrollTop -= Math.round(顶 - box.top);
    else if (box.bottom > frame.bottom - 余) scroller.scrollTop += Math.round(box.bottom - (frame.bottom - 余));
  };
  const 边缘滚动 = forward => {
    const frame = root.getBoundingClientRect ? root.getBoundingClientRect() : null;
    const box = caretBox();
    if (!frame || !frame.height || !box) return null;
    const lineH = box.height || 18;
    // 【R7·病例3】贴边余量旧值 1.6×行高（16px 行 ⇒ 25.6px）在可视底上方留了一条 26~31px 的
    // 死带（real-ops run-2026-10-03 V2：光标行底 703/704、可视底≈713，↓ 吞键四红）——带上沿
    // 31px 够不着；scan 的截断同一条带里又拒收折线下的下一行。放宽到 2.0×行高（32px）盖住
    // 带上沿，与 scan 放宽后的接受带（可视底-1+行高+2）无缝衔接：带内 ↓ 至少滚动一行再落点。
    // 滚不动（真到底）时下面的 还原() 原样退给"到底"分支，语义不变。
    const 贴边 = forward ? box.bottom >= frame.bottom - lineH * 2 : box.top <= 可视顶() + lineH * 2;
    if (!贴边) return null;
    const scroller = 滚动容器();
    if (!scroller) return null;
    const 步 = Math.max(lineH * 2, 24);
    const 原滚 = scroller.scrollTop;
    // **滚了没落到新位置就必须把滚动还原**：只滚不动光标，等于把光标推出可视区
    // （实测 128 ②：长按 ↑ 之后光标停在 `L02` 行首、y=-18 —— 越过了视口上沿）。
    const 还原 = () => { scroller.scrollTop = 原滚; return null; };
    for (let i = 0; i < 3; i++) {
      const 前 = scroller.scrollTop;
      scroller.scrollTop = forward ? 前 + 步 : Math.max(0, 前 - 步);
      if (scroller.scrollTop === 前) return 还原();            // 滚不动＝真的到头了
      const 新 = caretBox();
      if (!新) return 还原();
      const hit = scan(新, forward);
      if (hit) { pushTrace('滚动', {方向: forward ? '↓' : '↑', 滚到: Math.round(scroller.scrollTop), 落: Math.round(hit.box.top)}); return hit; }
    }
    return 还原();
  };
  /** 【L1】高块穿行：光标在代码块里、块的余下部分（渲染岛及其后的内容）被顶出视口时，
   *  把滚动容器滚到块底/块顶之外再重扫一次。↓ 从块内最后一行出块靠这一步——实测 15 行块
   *  展开后块盒 218..939、视口只到 713、下方段落在 939..965，光标停在 549 不贴边，
   *  `边缘滚动` 不出手，扫描窗也够不着，旧版就落"到底"分支＝吞键。滚不动（真到底）返回 null。 */
  const 岛后滚动 = (before, forward) => {
    const scroller = 滚动容器();
    if (!scroller) return null;
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.focusNode) return null;
    const at = selection.focusNode.nodeType === 3 ? selection.focusNode.parentElement : selection.focusNode;
    const 块 = at?.closest?.('.vditor-ir__node[data-type="code-block"]');
    if (!块 || !root.contains(块)) return null;
    const 块盒 = 块.getBoundingClientRect();
    const frame = root.getBoundingClientRect();
    if (!frame.height) return null;
    const 行高 = before.height || 18;
    let delta = 0;
    if (forward && 块盒.bottom > frame.bottom - 行高) delta = Math.round(块盒.bottom + 行高 + 8 - frame.bottom);
    else if (!forward && 块盒.top < 可视顶() + 行高) delta = -Math.round(可视顶() - 块盒.top + 行高 + 8);
    if (!delta) return null;
    const 原滚 = scroller.scrollTop;
    scroller.scrollTop = Math.max(0, 原滚 + delta);
    if (scroller.scrollTop === 原滚) return null;             // 滚不动＝真的到头了
    pushTrace('岛滚动', {方向: forward ? '↓' : '↑', 滚到: Math.round(scroller.scrollTop)});
    const 新 = caretBox() || before;                          // 滚动后行位置变了，重读锚再扫
    return scan(新, forward);
  };
  const placeAtColumn = (target, x) => {
    const box = target.getBoundingClientRect();
    if (!box.height) return false;
    const y = Math.min(box.bottom - 2, Math.max(box.top + 2, (box.top + box.bottom) / 2));
    let hit = null;
    for (const tryX of [x, 0, 24, 48, 64, 96]) {
      const candidate = doc.caretRangeFromPoint(tryX, y);
      if (usable(candidate) && target.contains(candidate.startContainer)) { hit = candidate; break; }
    }
    if (!hit) {
      const nodes = [];
      const walker = doc.createTreeWalker(target, NodeFilter.SHOW_TEXT, {acceptNode: text =>
        text.parentElement?.closest(".vditor-ir__preview,.vditor-ir__marker,[data-type$='-marker']")
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
      while (walker.nextNode()) nodes.push(walker.currentNode);
      const text = nodes.find(node => node.data.replace(/[\s\u200b]/g, "")) || nodes[0];
      if (!text) return false;
      hit = doc.createRange();
      hit.setStart(text, 0);
      hit.collapse(true);
    }
    place(hit);
    return true;
  };
  /** 兜底：落点隐形时按几何把它放回**相邻的那一行**（先扫描，再相邻块）。 */
  const rescueInvisible = forward => {
    const anchor = lastBox;
    if (!anchor) return false;
    const lineH = anchor.height || 18;
    const surfaceBox = root.getBoundingClientRect();
    const startY = forward ? anchor.bottom + 2 : anchor.top - 2;
    for (let step = 0; step <= 80; step++) {
      const y = forward ? startY + step * 2 : startY - step * 2;
      if (y < 可视顶() + 1 || y > surfaceBox.bottom - 1) break;
      const hit = resolveAt(goalX === null ? anchor.left : goalX, y) || codeAtHit(doc.caretRangeFromPoint(60, y));
      const box = boxOf(hit);
      if (!hit || !box) continue;
      if (Math.abs(box.top - anchor.top) <= Math.max(2, lineH * 0.4)) continue;
      place(hit);
      lastBox = box;
      return true;
    }
    const inside = codeLine();
    if (inside) {
      const neighbour = neighbourBlock(inside.block, forward);
      if (neighbour && placeAtColumn(neighbour, goalX === null ? anchor.left : goalX)) return true;
    }
    return false;
  };
  /** 这一行（按行顶对齐）最左/最右的可落点。用于目标列落在行外时的钳制。
   *  格：主落点所在的 td/th——表格里行端候选也不许出本格（T1：目标列在行外时这一步若不钳，
   *  会捞到邻列同行首尾，把光标拽出本格）。 */
  const lineEdgeHit = (y, top, forward, 格 = null) => {
    const surfaceBox = root.getBoundingClientRect();
    const start = forward ? Math.round(surfaceBox.right - 6) : Math.round(surfaceBox.left);
    const end = forward ? Math.round(surfaceBox.left) : Math.round(surfaceBox.right - 6);
    const stepSize = forward ? -6 : 6;
    for (let x = start; forward ? x >= end : x <= end; x += stepSize) {
      const hit = doc.caretRangeFromPoint(x, y);
      if (!usable(hit)) continue;
      if (格 && !格.contains(hit.startContainer)) continue;    // 【T1】行端候选不出本格
      const box = hit.getBoundingClientRect();
      if (Math.abs(box.top - top) > 3) continue;
      return {hit, box};
    }
    return null;
  };
  /** 【R7·病例2】这一行上离 goal 最近的**真可落边界**：从 goal 向两侧逐 3px 探（探测 y 钳回
   *  框内），只收"行顶 ±3、同格（T1）、usable"的落点，取 left 离 goal 最近者；已见边界比
   *  待探环远 24px 以上就收兵（更远的探针只会钳回已见边界）。与验收探针 nearestOnLine 同一
   *  口径（整行扫、取最近）——验收总规则 3.2"钳到离目标列最近的可用位置"的落地。 */
  const 行内最近 = (goal, 行顶, y, 格 = null) => {
    if (goal === null || goal === undefined) return null;
    const surfaceBox = root.getBoundingClientRect();
    const probeY = Math.max(可视顶() + 3, Math.min(surfaceBox.bottom - 3, y));
    let best = null, bestBox = null;
    for (let dx = 0; dx <= Math.max(240, Math.round(surfaceBox.width)); dx += 3) {
      for (const x of (dx === 0 ? [goal] : [goal - dx, goal + dx])) {
        if (x < surfaceBox.left + 1 || x > surfaceBox.right - 2) continue;
        const hit = doc.caretRangeFromPoint(x, probeY);
        if (!usable(hit)) continue;
        if (格 && !格.contains(hit.startContainer)) continue;        // 【T1】候选不出本格
        const hb = hit.getBoundingClientRect();
        if (!hb.height || Math.abs(hb.top - 行顶) > 3) continue;      // 只算这一行
        if (!bestBox || Math.abs(hb.left - goal) < Math.abs(bestBox.left - goal)) { best = hit; bestBox = hb; }
      }
      if (bestBox && dx > Math.abs(bestBox.left - goal) + 24) break; // 更远只会更远
    }
    return best ? {hit: best, box: bestBox} : null;
  };
  /** 【R7·病例2】scan 落点被"探测列钳制"带偏时，按 goalX 在新行上重解一次（**一次即止**：
   *  纯函数、不进 scan、不挂监听——无递归无抖动）。
   *  病例（real-ops run-2026-10-03T01-58-19 V4，重识概率论，306→231 轨迹）：轮3 ↓3
   *  goalX=306，§1.3 标题行内有一段不可落空档（≈231..344），caretRangeFromPoint 在空档上
   *  一律**左钳到 231**——scan 命中 [231,665]、中线重算还是 [231,665]、放 [231,665]，而该行
   *  离 306 最近的真边界是 344（探针 nearestOnLine 实测；同轮 ↓4 256→344、↑7 231→344、
   *  ↑9 91→344 同形，V4 四红全是它）。修：放落点前，列差超过半个字宽时先走 resolve 链
   *  （codeLineAt→resolveAt→formulaLineAt）在新行按 goalX 重解，再用 行内最近 补上"空档
   *  右侧量不到的边界"，取更近者；解不得／不更近才保留探测 x。 */
  const 按目标列钳 = target => {
    if (!target || goalX === null || goalX === undefined || !target.box) return target;
    const 半字宽 = Math.max(5, Math.round((target.box.height || 16) / 2));
    if (Math.abs(target.box.left - goalX) <= 半字宽) return target;   // 已贴住目标列：不动
    const 中线 = (target.box.top + target.box.bottom) / 2;
    const 主格 = (() => {
      const node = target.hit?.startContainer;
      const at = node?.nodeType === 3 ? node.parentElement : node;
      const cell = at?.closest?.('td,th');
      return cell && root.contains(cell) ? cell : null;
    })();
    // ① resolve 链在新行按 goalX 重解一次（折叠代码块行/公式行各走各的映射；行顶校验防串行）
    const 链 = codeLineAt(goalX, 中线) || resolveAt(goalX, 中线) || formulaLineAt(goalX, 中线);
    const 链盒 = 链 ? boxOf(链) : null;
    let best = null, bestBox = null;
    if (链盒 && Math.abs(链盒.top - target.box.top) <= Math.max(3, (target.box.height || 16) * 0.4)) { best = 链; bestBox = 链盒; }
    // ② 空档右侧的边界 resolve 链上量不到（左钳偏置）：整行取"离 goalX 最近"
    const 近 = 行内最近(goalX, target.box.top, 中线, 主格);
    if (近 && (!bestBox || Math.abs(近.box.left - goalX) < Math.abs(bestBox.left - goalX))) { best = 近.hit; bestBox = 近.box; }
    if (!bestBox || Math.abs(bestBox.left - goalX) >= Math.abs(target.box.left - goalX)) return target;  // 解不得：保留探测 x
    pushTrace('钳', {目标列: Math.round(goalX), 探测列: Math.round(target.box.left), 改判: Math.round(bestBox.left)});
    return {hit: best, box: bestBox, 弱: target.弱};
  };
  const view = root.ownerDocument.defaultView;   // window 捕获段：早于 Vditor 注册在编辑面上的 keydown
  /** 补全浮层（候选列表 / AI 建议框 / 设置菜单）开着吗：开着就绝不接管 ↑/↓。
   *  【C2 2026-10-02】completion.js 自己的 ↑/↓ 导航也挂在 window 捕获段，但注册晚于这里；
   *  这里一旦 preventDefault + stopImmediatePropagation，它的监听器整段被吞——用户看到的
   *  就是"按 ↓ 面板高亮不动、正文光标自己往下走"。判据照抄它自己的可见性口径
   *  （popup/preview 的 hidden 属性、settings 菜单的 dialog open）。 */
  const 浮层开着 = () => !!(doc.querySelector('.md-completion:not([hidden]),.md-completion-preview:not([hidden]')
    || doc.querySelector('dialog.md-completion-settings[open]'));
  /** 【L1】y 落在哪个代码块的**渲染岛**（可见的 pre.vditor-ir__preview 盒）里：岛内没有可落行
   *  （preview 不可编辑；源码行在岛上方、已由 codeLineAt/resolveAt 走完）。高块的岛有几百
   *  像素高（实测 15 行块展开后源码 249..570、岛 575..939），扫描按 2px 磨过去会把 180px
   *  窗口耗光、落到"到底"分支＝吞键——扫描里遇到它就整段跳到岛的另一头。 */
  const 岛盒At = y => {
    for (const block of root.querySelectorAll('.vditor-ir__node[data-type="code-block"]')) {
      const preview = block.querySelector('pre.vditor-ir__preview');
      if (!preview) continue;
      const box = preview.getBoundingClientRect();
      if (box.height > 0 && y >= box.top - 2 && y <= box.bottom + 2) return box;
    }
    return null;
  };
  const scan = (from, forward) => {
    const before = from;
    const lineH = before.height || 18;
    const surfaceBox = root.getBoundingClientRect();
    const startY = forward ? before.bottom + 2 : before.top - 2;
    // 【R7·病例3】视口底缘 ↓ 死区（real-ops run-2026-10-03T01-58-19 V2 四个红样例：轮1 ↓14
    // 上一行y 688→681、轮2 ↓16 687→687 / ↓17 687→680、轮3 ↓10/↓11 同形，文本都停在
    // "**非整数解**"那一行）。几何：可视底（surfaceBox.bottom）≈713，光标行顶 687/688、
    // 行底 703/704——**行底离可视底 26~31px** 的那一条带里，`边缘滚动` 的贴边余量
    // 1.6×行高（16px 行 ⇒ 25.6px）够不着（不触发），scan 的两道截断（探测 y ≤ 可视底-1；
    // 命中的行顶 ≥ 可视底-1 一律拒收）又把"顶刚好压在折线之下 0~几 px 的下一行"整行扔掉
    // ——行缝里的命中测试其实**能**钳到那条折线下的行（同 128② 顶部 y=3 命中 -18 的镜像），
    // 只是被拒了。于是 ↓ 既不滚也不落，落"到底"分支＝吞键，V2 判"按了要动"红。
    // 修（底缘两侧同放宽一行高，两带无缝衔接）：探测 y 上界放到 可视底-1+行高+2（折线外
    // 的空点命中不出根内落点自然跳过；代码块/公式行按盒解，仍可达）；命中行接受上限同放
    // 到 可视底-1+行高+2；贴边余量同步 1.6→2.0×行高（32px ≥ 带上沿 31px，见 边缘滚动）。
    // 带内 ↓ 于是要么 scan 直接接住折线下的下一行、要么 边缘滚动 至少滚一行再落点；落点由
    // 滚进视口 带回可视区，scrollTop 顶格滚不动时也照落（clamp 语义——range 矩形是完整行盒，
    // 不会隐形）。顶部（↑ 向）的拒收语义照旧：128② 的"光标跑到视口上方"仍交给 边缘滚动。
    const 底缘带宽 = Math.round(lineH) + 2;
    let target = null;
    let y = startY;
    for (let step = 0; step <= 90; step++) {
      if (y < 可视顶() + 1 || y > surfaceBox.bottom - 1 + (forward ? 底缘带宽 : 0)) break;
      // 【L1】代码块行映射放在**链首**：折叠态 resolveAt 在块上拿不到候选（预览命中被 usable
      // 拒），近端桶还会被"钳到块后段落"的候选占走——不放在前面，↓ 就整块跳过（L1a 实测）。
      const 精确 = codeLineAt(goalX, y) || resolveAt(goalX, y) || formulaLineAt(goalX, y);
      const hit = 精确 || codeAtHit(doc.caretRangeFromPoint(goalX, y)) || codeAtHit(doc.caretRangeFromPoint(60, y));
      const box = boxOf(hit);
      if (!hit || !box) {
        // 【L1】落进渲染岛：整段跳过（不消耗步数预算），下一轮从岛另一头之外接着扫
        const 岛 = 岛盒At(y);
        y = 岛 ? (forward ? 岛.bottom + 4 : 岛.top - 4) : (forward ? y + 2 : y - 2);
        continue;
      }
      if (Math.abs(box.top - before.top) <= Math.max(2, lineH * 0.4)) { y += forward ? 2 : -2; continue; }
      // **方向必须一致**：找到了"不同的一行"还不够，↓ 只能往下、↑ 只能往上。
      // 少了这一条，按 ↓ 可能落到上一行（实测：366 → 340，用户看到的就是"按↓反而往上跳"）。
      if (forward ? box.top <= before.top : box.top >= before.top) { y += forward ? 2 : -2; continue; }
      // **整行都在可视区外的不算落点**：在行缝里做命中测试时，Chromium 会把点钳到最近的一行——
      // 那一行可能整根都在视口外（实测 128 ②：↑ 回顶时 `求[74,3]` 命中 `[46,-18]`，光标跑到
      // 视口上方、列也被钳成行首 x=46）。这种"下一行在视口外"正是 `边缘滚动` 该处理的情形：
      // 先滚一格再重扫，落点与列都对的。
      // 【R7·病例3】例外：↓ 向的**底缘**接受上限放宽一行高（底缘带宽）——折线下 0~行高 内的
      // 下一行是真实存在的相邻行（行缝钳制钳得到它），接住后由 滚进视口 滚进来；旧的一刀切
      // 拒收正是 26~31px 死带的成因之一。↑ 向的顶部拒收照旧（128②）。
      if (box.bottom <= surfaceBox.top + 1
          || box.top >= surfaceBox.bottom - 1 + (forward ? 底缘带宽 : 0)) { y += forward ? 2 : -2; continue; }
      // 找到相邻行了：**再按这一行自己的中线重算一次列**。
      // 为什么：扫描从光标下/上一像素起步，第一处命中的 y 常落在**行缝**里，那一带的命中测试
      // 只肯给行首（实测三拍对照：目标列 278 → 放成 46＝行首）。用行中线重算才拿得到
      // "这一行上离目标列最近的真位置"。
      // 【R7·病例3】接住的行可能在折线之下：中线重算的探测 y 必须收回框内（框外的点命不中
      // 根内内容），钳到 [可视顶+3, 可视底-3]。
      const midY = Math.max(可视顶() + 3, Math.min(surfaceBox.bottom - 3, (box.top + box.bottom) / 2));
      // 【L1】中线重算同款：代码块的行用 codeLineAt 自己解（resolveAt 在折叠块上解不出）。
      let better = codeLineAt(goalX, midY) || resolveAt(goalX, midY) || formulaLineAt(goalX, midY);
      let betterBox = better ? boxOf(better) : null;
      // 【R7·病例3】钳回框内的中线可能落回光标**所在行**（原行还盖住该 y 时）——重算结果必须
      // 仍是方向上的另一行，否则弃用，防把落点拽回原行（↓ 白按）。
      if (betterBox && (Math.abs(betterBox.top - before.top) <= Math.max(2, lineH * 0.4)
          || (forward ? betterBox.top <= before.top : betterBox.top >= before.top))) { better = null; betterBox = null; }
      // 【T1】主落点在表格格里时，行端钳制候选也不许出本格。
      const 主格 = (() => {
        const at = hit.startContainer?.nodeType === 3 ? hit.startContainer.parentElement : hit.startContainer;
        const cell = at?.closest?.("td,th");
        return cell && root.contains(cell) ? cell : null;
      })();
      // 目标列可能落在"探测列的空档"里（该行可落范围比探测列宽，或目标列在行外）：
      // 把这一行的左端/右端也当候选，谁离目标列近就用谁。**两端都试**，因为目标列可能在行左或行右。
      for (const side of [true, false]) {
        const edge = lineEdgeHit(midY, Math.round(box.top), side, 主格);
        if (!edge) continue;
        if (!betterBox || Math.abs(edge.box.left - goalX) < Math.abs(betterBox.left - goalX)) {
          better = edge.hit; betterBox = edge.box;
        }
      }
      pushTrace('scan', {方向: forward ? '↓' : '↑', 起点: [Math.round(goalX), Math.round(before.top)], 扫到y: Math.round(y),
        命中: [Math.round(box.left), Math.round(box.top), Math.round(box.height)], 中线: Math.round(midY),
        重算: betterBox ? [Math.round(betterBox.left), Math.round(betterBox.top)] : null});
      target = betterBox && Math.abs(betterBox.left - goalX) < Math.abs(box.left - goalX)
        ? {hit: better, box: betterBox, 弱: !精确}
        : {hit, box, 弱: !精确};
      break;
    }
    return target;
  };
  /** 【F7 2026-10-02】PageUp / PageDown：按页移动光标（Typora 语义＝按页跳、保目标列）。
   *
   *  此前这两键整个交给了浏览器/Vditor 的默认处理：IR 面里原生 PageDown 只滚视口不动光标
   *  （或把光标挪到 0×0 的边界位置），连续翻页时光标与视口各走各的。修法与 ↑/↓ 同一套接管：
   *   · 步长＝可视一页（编辑面底 − 工具栏底，即可视带高度，至少 60px），目标 y＝光标 y ∓ 一页；
   *   · 先把滚动容器按一页滚过去（Typora 的视觉：整页内容流过、光标留在原屏幕位置附近；
   *     上下界钳掉多少算多少），再在**滚动后的新几何**里按目标文档位置解落点——落点复用
   *     scan 的同一条 resolve 链（codeLineAt / resolveAt / formulaLineAt / codeAtHit），
   *     解不出或方向不对时退回 scan 从光标行向目标方向走（贴边/岛外由 边缘滚动/岛后滚动 接力）；
   *   · 目标列（goalX）全程参与——翻一页再翻回来，列还是那一列；
   *   · 到顶/到底：**还原滚动、不吞键、不丢列**——不 preventDefault（原生该干嘛干嘛）、
   *     不 reset（回程仍按这一列走）；
   *   · 让位形态：补全浮层开着（C2 同判据，浮层里 ↑/↓ 是导航键）；阅读模式（编辑面被藏起、
   *     焦点在阅读面上，翻页键属于阅读面）；查找面板聚焦（按键属于面板输入框）。
   *  方向判定用**文档坐标**（client y ＋滚动容器 scrollTop）：滚动前后 client y 不可比，
   *  裸比会把"翻一页后落在同一屏幕位置"误判成没动。 */
  const pageJump = (event, forward) => {
    if (浮层开着()) return false;
    if (editor.element?.classList.contains("typora-reading")) return false;   // 阅读模式：不接管
    const active = doc.activeElement;
    if (active && active.closest && (active.closest("#typora-find")
        || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || ""))) return false;   // 查找框/输入框聚焦：不接管
    const before = caretBox() || lastBox;
    if (!before || !root.getBoundingClientRect().height) return false;
    if (goalX === null) goalX = before.left;
    lastBox = before;
    const surfaceBox = root.getBoundingClientRect();
    const 一页 = Math.max(60, Math.round(surfaceBox.bottom - 可视顶()));
    const scroller = 滚动容器();
    const 原滚 = scroller ? scroller.scrollTop : 0;
    if (scroller) scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight,
      forward ? 原滚 + 一页 : 原滚 - 一页));
    const 新滚 = scroller ? scroller.scrollTop : 0;
    const 锚文档y = before.top + 原滚;
    const 目标文档y = 锚文档y + (forward ? 一页 : -一页);
    const y = Math.max(可视顶() + 2, Math.min(surfaceBox.bottom - 2, 目标文档y - 新滚));
    let hit = codeLineAt(goalX, y) || resolveAt(goalX, y) || formulaLineAt(goalX, y)
      || codeAtHit(doc.caretRangeFromPoint(goalX, y));
    const 方向对 = box => !!box && (forward
      ? box.top + 新滚 > 锚文档y + 2
      : box.top + 新滚 < 锚文档y - 2);
    let box = hit ? boxOf(hit) : null;
    if (!方向对(box)) {
      // 兜底：scan 从光标行向目标方向走（滚动被钳死、目标页解不出来时它还能逐行蹭过去）
      const step = scan(caretBox() || before, forward) || 边缘滚动(forward) || 岛后滚动(before, forward);
      if (step) { hit = step.hit; box = step.box; }
    }
    if (!方向对(box)) {
      // 到顶/到底：还原这一下滚动（光标没动就不能把视口挪走）、不吞键、不丢列。
      if (scroller) scroller.scrollTop = 原滚;
      pushTrace('翻页止', {方向: forward ? '↓' : '↑', 一页: Math.round(一页), 滚: [Math.round(原滚), Math.round(新滚)]});
      return true;                      // 已按"不动"处置：调用方不必再 reset（目标列要留着）
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    place(hit);
    滚进视口(box);
    lastBox = 折叠源码(hit.startContainer) ? box : (caretBox() || box);
    pushTrace('翻页', {方向: forward ? '↓' : '↑', 一页: Math.round(一页), 滚: [Math.round(原滚), Math.round(新滚)],
      落: [Math.round(box.left), Math.round(box.top)]});
    // Vditor 在 selectionchange 里改写落点的老毛病（见 ↓/↑ 的 keepColumn）：轻量补一拍确认，
    // 只在"还在目标行上、列却偏了"时按目标列重放一次；两拍之后不再追（用户接着打字不受影响）。
    const 想left = goalX, 想top = box.top;
    const 确认 = () => {
      if (!root.isConnected) return;
      const sel = getSelection();
      if (!sel?.rangeCount || !sel.isCollapsed) return;
      const now = caretBox();
      if (!now || Math.abs(now.top - 想top) >= 6) return;          // 行都换了：不硬掰
      if (Math.abs(now.left - 想left) < 4) return;                 // 本来就在目标列上
      const midY = (now.top + now.bottom) / 2;
      const again = resolveAt(想left, midY) || formulaLineAt(想left, midY);
      const abox = again ? boxOf(again) : null;
      if (abox && Math.abs(abox.left - 想left) < Math.abs(now.left - 想left)) {
        place(again);
        lastBox = abox;
        pushTrace('翻页重放', {目标列: Math.round(想left), 原: Math.round(now.left), 新: Math.round(abox.left)});
      }
    };
    requestAnimationFrame(确认);
    setTimeout(确认, 0);
    return true;
  };
  view.addEventListener("keydown", event => {
    // 【C3 2026-10-02】实机取证（probe-r1-caret C3）证明 sv 面里 ↓ 被本层吞掉、
    // 落点 0×0 不可见、偏移恒 0；IR 专属的纵向接管在别的模式必须让位给原生。
    if (editor.currentMode !== "ir") return;
    if (event.isComposing || editor.ir.composingLock) return;
    if (event.key === "PageUp" || event.key === "PageDown") {
      // 【F7】按页翻。带修饰键的组合（Shift+PageDown 选一页、Ctrl+PageDown 归浏览器翻标签页）
      // 不属于这套语义，照老规矩清目标列；浮层开着时不清（与 ↑/↓ 同口径：面板导航别把列丢了）。
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) { reset(); return; }
      if (浮层开着()) return;
      if (!pageJump(event, event.key === "PageDown")) reset();    // 让位形态（阅读模式/查找框/无锚）：原生照旧
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") { reset(); return; }
    if (浮层开着()) return;                        // 补全/菜单浮层可见：不接管、不吞键（见 浮层开着 的注释）
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const before = caretBox() || lastBox;          // 光标此刻隐形时用上一次的锚
    if (!before) return;                           // 连锚都没有（选区不在编辑面里）：什么都不做
    const forward = event.key === "ArrowDown";
    if (goalX === null) goalX = before.left;
    lastBox = before;
    // 默认动作照常交给浏览器（它负责"哪一行"）；我们只在一拍之后校正两件事：
    //  ① 落点隐形（0×0）→ 按几何找相邻行放回去；
    //  ② 列偏离超过一个字宽 → 在同一行的目标列上重放一次。
    // 这样"上移没反应"那类问题不会出现：默认动作永远先发生，我们只是修饰它。
    let target = scan(before, forward);
    if (!target) target = 边缘滚动(forward);      // 贴着可视区边：先滚一步再扫（见函数头注释）
    if (!target) target = 岛后滚动(before, forward);   // 【L1】高块：块的余下部分在视口外，滚过去再扫
    if (!target) {
      // **隐形脱困**：光标此刻没有可见矩形（上一拍落进了 0×0 的位置）时，扫描与 Vditor 都不动，
      // 整串移动就卡死在这里（实测全篇行走：每次卡死都伴随 1 次隐形落点）。先在锚点那一行上
      // 找一处可编辑落点把光标放出来，这一下不移动、只脱困。
      const visible = (() => {
        const probe = document.createRange();
        const selection = getSelection();
        if (!selection?.rangeCount || !selection.focusNode) return null;
        probe.setStart(selection.focusNode, selection.focusOffset);
        probe.collapse(true);
        const box = probe.getBoundingClientRect();
        return box && box.height ? box : null;
      })();
      if (!visible && lastBox) {
        const y = (lastBox.top + lastBox.bottom) / 2;
        const hit = resolveAt(lastBox.left, y) || codeAtHit(doc.caretRangeFromPoint(lastBox.left, y));
        const unstuck = hit ? visibleBox(hit) : null;
        if (unstuck) {
          // 脱困之后**同一拍继续按方向走一步**：只把光标放出来、不动，用户看到的就是按了没反应
          // （实测全篇行走里 ↑ 的一次都不动就是这个形状）。
          place(hit);
          lastBox = unstuck;
          const next = scan(unstuck, forward);
          if (next) { place(next.hit); lastBox = next.box; }
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
      }
      // 兜底：光标在公式源码里就直接去相邻块。
      const inside = codeLine();
      if (inside) {
        const neighbour = neighbourBlock(inside.block, forward);
        if (neighbour && placeAtColumn(neighbour, goalX === null ? before.left : goalX)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          lastBox = neighbour.getBoundingClientRect();
          return;
        }
      }
      // 到顶/到底（或这一带确实没有可编辑落点）：**保持光标不动**。
      // 这里必须把这一下拦下来：放行的话 Vditor 自己的方向键处理会接手，把光标放到一个
      // 0×0 的边界位置——用户看到的就是"一直按 ↑，光标没了"（实测全篇行走每轮最后 3 次
      // 隐形读数就出在这里）。拦下来什么都不做，光标留在原地、仍是可见的。
      //
      // **不要在这里 reset()**（2026-09-18 实测纠错）：reset 会把"连续移动的目标列"一起丢掉，
      // 于是"按 ↓ 到底 → 再按 ↑"的第二次移动会把**底行那一列**当成目标列——用户看到的就是
      // "上键移动后再下键回来，位置首位不闭合、逻辑混乱"。到底了没动，目标列自然该留着：
      // 真正要清目标列的时机是"用户做了别的动作"（打字、点击、左右移动）。
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    // 【R7·病例2】放落点前按 goalX 重解一次列（空档左钳纠偏，见 按目标列钳 的病例注释）
    target = 按目标列钳(target);
    event.preventDefault();
    event.stopImmediatePropagation();
    place(target.hit);
    滚进视口(target.box);                       // 落点在视口外（上下都可能）时带进来
    // 【L1】落进折叠代码源码时，光标此刻量出的是幻影矩形（窄柱假行，实测深到 y=626）——
    // 拿它当锚，keepColumn 的同行判会被"幻影对幻影"糊弄过去、再按幻影中线重解，把光标拽回
    // 块外邻行（↑ 白落）。折叠源码的锚用**目标行盒**（展开由 Vditor 在 selectionchange 里补上）。
    lastBox = 折叠源码(target.hit?.startContainer) ? target.box : (caretBox() || target.box);
    // **下一拍再确认一次**：我们放的位置分毫不差（同拍读回＝目标列），但下一拍常常被
    // Vditor 的 selectionchange 处理改写（实测三拍对照 10 次里 3 次：46 → 59/89）。
    // 这里只在"确实被挪走了"时把目标列重放一次，其它情况一律不碰。
    const wanted = {left: target.box.left, top: lastBox.top};
    const 弱落点 = !!target.弱;
    pushTrace('放', {目标: [Math.round(target.box.left), Math.round(target.box.top)], 层: String(target.hit.startContainer.nodeType)});
    const keepColumn = () => {
      if (!root.isConnected) return;
      const now = caretBox();
      if (!now) return;
      // 用**原始目标列**去重算，而不是"放下去的那个（已经钳过的）列"：光标落进标题行时 Vditor 会把
      // `###` 标记显示出来，整行向右挪（实测同一行 y=125：光标不在这一行时行尾在 x=200，光标一进来
      // 行尾变成 x=242），此时按旧列 200 去对，就只能停在"新布局里的 205"——离目标列差一个字。
      // 按目标列 242 重算，拿到的正是新布局里离目标列最近的位置（这一行就是行尾 242）。
      const 目标列 = goalX === null ? wanted.left : goalX;
      // 弱落点（从预览映射进源码的兜底）**不能**用"放得准就早退"这条：它可能离目标列很远，
      // 而且展开源码后布局会变，正是要靠这一拍把它挪到源码行里离目标列最近的位置。
      if (!弱落点 && Math.abs(now.left - wanted.left) < 4 && Math.abs(now.top - wanted.top) < 6) return;
      if (Math.abs(now.top - wanted.top) >= 6) return;          // 行都换了：不硬掰回来
      const midY = (now.top + now.bottom) / 2;
      let again = resolveAt(目标列, midY) || formulaLineAt(目标列, midY);
      let box = again ? boxOf(again) : null;
      // 【R7·病例2】重放与放落点同一把尺：resolve 链被空档左钳（列差仍是半个字宽以上）时，
      // 行内最近 补上"离目标列最近的真边界"——否则重放只会重演 306→231 那一类左钳。
      if (Math.abs((box ? box.left : now.left) - 目标列) > Math.max(5, Math.round((now.height || 16) / 2))) {
        const 近 = 行内最近(目标列, now.top, midY);
        if (近 && (!box || Math.abs(近.box.left - 目标列) < Math.abs(box.left - 目标列))) { again = 近.hit; box = 近.box; }
      }
      if (box && Math.abs(box.left - 目标列) < Math.abs(now.left - 目标列)) {
        place(again);
        lastBox = box;
        pushTrace('重放', {目标列: Math.round(目标列), 原: Math.round(now.left), 新: Math.round(box.left)});
        return true;
      }
      return false;
    };
    // 重算要挂在**改写它的那一拍之后**：我们的位置是分毫不差的，偏差来自 Vditor 在
    // selectionchange 里的改写，而那一拍可能比 rAF 还晚（实测标题标记展开整行右移就发生在后面），
    // 所以除了 rAF + 下一拍，再挂一个**一次性**的 selectionchange 监听，带 200ms 截止时间；
    // 最多补 3 次，避免和 Vditor 来回拉锯。
    // 【C1 2026-10-02】这个 200ms 重放窗口必须能被用户**立刻作废**：窗口里打字（input / 组合输入
    // 起手）或按下鼠标时，keepColumn 还在按旧目标列把光标拽回去——用户看到的就是"按完 ↓ 赶紧
    // 打一个字，字上屏了，光标又被拽回目标列那一格"（↓ 后 150ms 打字必回跳）。input /
    // compositionstart / mousedown 一到就解绑 onSel、取消所有挂起的拍；顺序上它们都早于各自
    // 引发的 selectionchange，作废一定赶在重放之前。
    let 补次 = 0;
    const rafIds = [], tmoIds = [];
    const onSel = () => {
      if (补次 >= 3 || Date.now() > 截止) { 解绑(); return; }
      if (keepColumn()) 补次 += 1;
    };
    const 即撤 = () => 解绑();
    const 解绑 = () => {
      doc.removeEventListener("selectionchange", onSel);
      view.removeEventListener("input", 即撤, true);
      view.removeEventListener("compositionstart", 即撤, true);
      root.removeEventListener("mousedown", 即撤, true);
      for (const id of rafIds) cancelAnimationFrame(id);
      for (const id of tmoIds) clearTimeout(id);
    };
    const 截止 = Date.now() + 200;
    doc.addEventListener("selectionchange", onSel);
    view.addEventListener("input", 即撤, true);
    view.addEventListener("compositionstart", 即撤, true);
    root.addEventListener("mousedown", 即撤, true);
    tmoIds.push(setTimeout(解绑, 260));
    for (let i = 0; i < 2; i++) {
      rafIds.push(requestAnimationFrame(() => { keepColumn(); tmoIds.push(setTimeout(keepColumn, 0)); }));
    }
  }, true);
  root.addEventListener("mousedown", reset, true);
  // 【C7 2026-10-02】程序性选区跳转（大纲点击、outline-reveal 这类）清 goalX/lastBox：这类跳转
  // 既不经过键盘、也不点在编辑面上，上面两个 reset 时机全都碰不到它——旧的目标列于是被带进
  // 新位置，跳转后第一次 ↓ 还拿旧文档位置的那一列当尺子。谁做程序性跳转谁发这个通知
  // （outline-layout.js 已在大纲点击与 reveal 跳转处发），这里只负责清。
  view.addEventListener("typora-selection-jump", reset, true);
};

/** 光标"消失"兜底：任何导航键（←→↑↓ Home/End PageUp/PageDown）之后，如果光标落到**没有高度**
 *  的位置（0×0），把它放回上一次的可见位置（就近吸附）。用户永远不该遇到"光标没了"。
 *
 *  为什么要独立一段：纵向移动我们自己接管了；←/→/Home/End 走的是 Vditor 的默认处理，实测在
 *  文档边界/块边界上会把光标放到 0×0 的位置（重识概率论那份 169KB 真样本上，24 次横向按键里
 *  出现 2 次隐形落点，读数形如 {可见:false, x:0, y:0, 高:0}）。这里不改默认动作，只在**事后**
 *  发现光标没了时把它放回原处——不然用户按一下 ←/→ 就再也找不到光标了。
 *
 *  与纵向补丁的关系：纵向那段每次都会把光标放到可见位置，所以这里对 ↑/↓ 基本不会触发；
 *  两边都只碰"已经隐形"的状态，不会互相抢。鼠标按下即解除（用户自己点进公式源码时可能是隐形的，
 *  那是他主动要的，不该被拽回来）。 */
const patchCaretWatchdog = (api) => {
  const editor = api.vditor;
  const root = editor.ir.element;
  if (!root) return;
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const NAV = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
  const caretBox = () => {
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.focusNode || !root.contains(selection.focusNode)) return null;
    const probe = doc.createRange();
    probe.setStart(selection.focusNode, selection.focusOffset);
    probe.collapse(true);
    const rect = probe.getBoundingClientRect();
    return rect && rect.height ? rect : null;
  };
  const usable = hit => {
    if (!hit || !root.contains(hit.startContainer)) return false;
    const at = hit.startContainer.nodeType === 3 ? hit.startContainer.parentElement : hit.startContainer;
    if (at?.closest?.(".vditor-ir__preview,.vditor-ir__marker,[data-type$='-marker']")) return false;
    const rect = hit.getBoundingClientRect ? hit.getBoundingClientRect() : null;
    return !!(rect && rect.height);
  };
  let 上次可见 = null;
  let 上次键 = null;
  let 截止 = 0;
  const 落 = hit => {
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(hit);
    return true;
  };
  /** 可视区的**上边**：编辑面顶边与工具栏底边取大者。工具栏是绝对定位浮在正文上的
   *  （实测盒子 [0,0,922,71]、z-index:30），正文滚上去之后那一条带**既看不见也命不中**——
   *  命中测试拿回的是工具栏按钮。纵向补丁的同名口径见 patchVerticalMathLine。 */
  const 可视顶 = () => {
    const frame = root.getBoundingClientRect ? root.getBoundingClientRect() : null;
    const 顶 = frame ? frame.top : 0;
    const bar = editor.toolbar?.element;
    const 条 = bar?.getBoundingClientRect ? bar.getBoundingClientRect() : null;
    return 条 && 条.height ? Math.max(顶, 条.bottom) : 顶;
  };
  /** 按 Typora 的习惯补一步：→ 在行尾就是"去下一行的行首"、← 在行首就是"去上一行的行尾"。
   *  只在本行没有可落点时用（这正是光标会落到 0×0 的那种边界）。 */
  const 邻行 = (anchor, forward) => {
    const surfaceBox = root.getBoundingClientRect();
    const startY = forward ? anchor.bottom + 2 : anchor.top - 2;
    for (let step = 0; step <= 80; step++) {
      const y = forward ? startY + step * 2 : startY - step * 2;
      if (y < 可视顶() + 1 || y > surfaceBox.bottom - 1) break;
      const edge = forward ? surfaceBox.left : surfaceBox.right - 6;
      for (let x = edge; forward ? x < surfaceBox.right - 4 : x > surfaceBox.left; x += forward ? 4 : -4) {
        const hit = doc.caretRangeFromPoint(x, y);
        if (!usable(hit)) continue;
        const rect = hit.getBoundingClientRect();
        // 必须**落在这个方向上**：只判 "top 不同" 会被软换行边界坑到——段落在软换行处
        // 光标落在**上一行的行尾**（Chromium 的取向），从下一行往前走时它就"往上跳"了
        // （实测：锚 y=307、落点 y=281，用户看到的是"按 → 反而回到上一行"）。
        if (forward ? rect.top <= anchor.top + 3 : rect.top >= anchor.top - 3) continue;
        return 落(hit);
      }
    }
    return false;
  };
  /** 原地兜底：回到上一次的可见位置（就近吸附到可落点）。 */
  const 放回 = () => {
    const anchor = 上次可见;
    if (!anchor) return false;
    const midY = Math.round((anchor.top + anchor.bottom) / 2);
    for (const y of [midY, Math.round(anchor.top + 2), Math.round(anchor.bottom - 2)]) {
      for (const x of [anchor.left, anchor.left - 8, anchor.left + 8, anchor.left - 16, anchor.left + 16, 0, 24, 48, 80, 120, 160, 200]) {
        const hit = doc.caretRangeFromPoint(x, y);
        if (!usable(hit)) continue;
        return 落(hit);
      }
    }
    return false;
  };
  /** 光标隐形**在这个位置是正常的**吗：公式源码（折叠态 display:none ⇒ rect 0×0）、预览、围栏标记
   *  上都可能是"看不见但正确"的位置——那是用户主动进去的（点进公式、方向键走进公式），
   *  绝不能替他挪走。实测教训：不排除这些位置时，场景 101"走出公式后打字"整段行为被兜底改坏。 */
  const 隐形是正常的 = () => {
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.focusNode) return true;
    const at = selection.focusNode.nodeType === 3 ? selection.focusNode.parentElement : selection.focusNode;
    return !!at?.closest?.("code[data-type],.vditor-ir__preview,.vditor-ir__marker,[data-type$='-marker']");
  };
  /** 光标**跑到所有内容块之外**了吗：这才是真正要救的病态位置（实测重识概率论上的读数形如
   *  {可见:false, x:0, y:0, 高:0} 且所在块的 textContent 是整篇文档——光标不在任何块里）。
   *  块内那些"看不见但正确"的位置（公式源码/预览/围栏）一概不动：那是用户主动进去的。
   *
   *  **编辑面自己不算块**（2026-09-23）：IR 的编辑面是 `<pre class="vditor-reset">`，正好命中
   *  上面那个 `pre` 选择器——于是"光标停在编辑面上"（元素级兄弟位置，Chromium 画不出矩形）
   *  被判成"在块内"，看门狗一直不动手。实测（probe-f9-trap.cjs，← 走到末段行首）：
   *  `PRE.vditor-reset@12`、矩形 [0,0,0,0] —— 用户在段首按 ← 看到的是**光标直接没了**，
   *  再按一下才被浏览器带进上一块的表格里。 */
  const surfaceEl = root.matches?.('.vditor-reset') ? root : root.querySelector?.('.vditor-reset');
  const 在块外 = () => {
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.focusNode) return true;
    const at = selection.focusNode.nodeType === 3 ? selection.focusNode.parentElement : selection.focusNode;
    if (!at) return true;
    if (at === root || at === surfaceEl) return true;      // 停在编辑面本身：块与块之间的元素级位置
    return !at.closest('p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,pre,.vditor-ir__node');
  };
  const 查 = () => {
    if (!上次可见 || Date.now() > 截止) return;
    if (caretBox()) return;
    if (!在块外()) return;
    const 横向 = 上次键 === "ArrowRight" || 上次键 === "ArrowLeft";
    if (横向 && 邻行(上次可见, 上次键 === "ArrowRight")) return;
    放回();
  };
  /** **块首的 ← 是死路**：光标停在"块的元素级起点"（`H1@0`、`P@0` 这类）上时，Chromium 的 ←
   *  什么都不做——实测（scripts/acceptance/probe-repro-headstart.cjs，2.2.5 与 2.2.7 读数一致）：
   *  点标题正文 → 光标在 `# ` 记号里（offset 2）→ 按一次 ← 落到 `H1@0` → **再连按三次都不动**。
   *  但契约是"行首 ← 去上一行行尾"（2.2.3 定的），这里补这一手：← 之后若光标**原地不动**
   *  且正处在元素级起点上，就按几何去上一行的可落点（`邻行` 的 ← 方向从行右缘往左扫，取到的是行尾）。
   *  → 方向不碰：从元素级起点往右走有 Vditor/浏览器的正常路径。 */
  let 左走锚 = null;
  const 块首左走 = () => {
    const 锚 = 左走锚;
    const 记 = 详情 => {
      const ring = window.__typoraBlockStartLeft || (window.__typoraBlockStartLeft = []);
      ring.push({...(详情 || {}), 时刻: Date.now()});
      if (ring.length > 10) ring.shift();
    };
    if (!锚) { 记({状态: "没有锚"}); return; }
    if (Date.now() > 截止 + 400) { 记({状态: "过期"}); return; }
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) { 左走锚 = null; 记({状态: "非折叠或无选区"}); return; }
    if (selection.focusNode !== 锚.node || selection.focusOffset !== 锚.offset) { 左走锚 = null; 记({状态: "已经走掉了"}); return; }
    // 只认"**偏移 0**"这一个形状（元素级起点，或块首那个真实文本节点的 offset 0——实测
    // probe-repro-headstart.cjs：标题块首的容器就是 `类型: 3, 偏移: 0` 的文本节点）。
    // 判"是不是真块首"交给上面那句"**光标原地没动**"：块中间的 offset 0（比如加粗段开头）
    // 按 ← 是会动的，动过就不进这里。
    if (锚.offset !== 0) { 左走锚 = null; 记({状态: "不在偏移 0", 类型: 锚.node.nodeType, 偏移: 锚.offset}); return; }
    const box = caretBox();
    if (!box) { 左走锚 = null; 记({状态: "读不出光标框"}); return; }
    左走锚 = null;
    const 成 = 邻行({left: box.left, top: box.top, bottom: box.bottom}, false);
    记({状态: 成 ? "已左走到上一行" : "上一行没找到可落点", 从: Math.round(box.top), 到: Math.round((caretBox() || box).top)});
  };
  view.addEventListener("keydown", event => {
    if (event.isComposing || editor.ir.composingLock) return;
    if (!NAV.has(event.key)) return;
    const now = caretBox();
    if (now) 上次可见 = {left: now.left, top: now.top, bottom: now.bottom};
    // 块首的 ← 要不要补一手（见 `块首左走`）：记下按键前的位置形态
    if (event.key === "ArrowLeft" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const selection = getSelection();
      左走锚 = selection?.rangeCount && selection.isCollapsed
        ? {node: selection.focusNode, offset: selection.focusOffset} : null;
      window.__typoraLeftAnchor = {有锚: !!左走锚, 数量: selection?.rangeCount,
        折叠: selection?.isCollapsed, 类型: 左走锚 ? 左走锚.node.nodeType : null, 偏移: 左走锚 ? 左走锚.offset : null};
    } else 左走锚 = null;
    上次键 = event.key;
    截止 = Date.now() + 300;
  }, true);
  const 收 = () => { 查(); 块首左走(); };
  view.addEventListener("keyup", () => { requestAnimationFrame(收); setTimeout(收, 0); }, true);
  // 原生移动有时比 keyup/rAF 晚一拍（实测：+91ms 才看到落点），再收一次
  view.addEventListener("keydown", () => { setTimeout(收, 120); }, true);
  doc.addEventListener("selectionchange", 收, true);
  root.addEventListener("mousedown", () => { 上次可见 = null; 截止 = 0; 左走锚 = null; }, true);
};

/** 【B1 / R10-P8】折叠光标消失（病例 4，单发未复现）——**纯观测证人**，零行为改动。
 *
 *  三条嫌疑（H2 §5 复审，只标嫌疑不定罪）：
 *   · S1 window blur 之后 refreshMathEditing 把 expandedOwners **全部收回**（math-edit.js）：
 *     光标若正住着某条被收回公式的源码，源码转 display:none、光标 0×0；
 *   · S2 按下期间（pressFrozen 快照之后）Vditor click 处理器补挂的 --expand 不在快照里，
 *     下一拍 refresh 把它收回去——光标刚被点击放进源码就隐身；
 *   · S3 IR 重渲染（撤销/setValue 的 reconcile）把保留块上的 --expand **无条件摘掉**，
 *     同一窗口内 DOM 重排把选区归一化到元素级位就失救。
 *
 *  证人只做**只读采集**：window blur / 编辑面 pointerdown+pointerup / --expand 摘除
 *  （MutationObserver）/「光标在公式源码里且该公式无展开」的 selectionchange 帧，全部
 *  推进 `window.__mpCaretRing`（环形 50 条：时刻 / 嫌疑名 / 光标矩形摘要 / 焦点与展开态）。
 *  监听一律 passive、观察者只读——不 preventDefault、不 stopPropagation、不改任何事件
 *  处理的返回值或时序。下次用户报障"光标消失"时，读这枚 ring 就能回放定位是哪一条。
 *  （仿 `__typoraBlockStartLeft` 的 ring 写法；`__mpCaretRingDisabled` 置真可整体停记。） */
const patchCaretCollapseWitness = (api) => {
  const editor = api.vditor;
  const root = editor.ir.element;
  if (!root) return () => {};
  const doc = root.ownerDocument, view = doc.defaultView;
  if (!view || view.__mpCaretRingInstalled) return () => {};               // 幂等
  view.__mpCaretRingInstalled = true;
  const ring = view.__mpCaretRing || (view.__mpCaretRing = []);
  const 记 = (嫌疑, 详情) => {
    if (view.__mpCaretRingDisabled) return;
    const selection = getSelection();
    const focus = selection?.focusNode ?? null;
    const 摘要 = {焦点: focus ? focus.nodeName + "@" + (selection.focusOffset | 0) : null,
      光标盒: null, 层: "外", 源码无展开: false};
    try {
      if (selection?.rangeCount && focus) {
        const probe = doc.createRange();
        probe.setStart(focus, selection.focusOffset | 0);
        probe.collapse(true);
        const rect = probe.getBoundingClientRect();
        摘要.光标盒 = rect ? [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)] : null;
        const at = focus.nodeType === Node.TEXT_NODE ? focus.parentElement : focus;
        const owner = at?.closest?.('.vditor-ir__node[data-type="inline-node"],[data-type="math-block"]');
        摘要.层 = at?.closest?.("code[data-type]") ? "源码" : at?.closest?.(PREVIEW) ? "预览"
          : owner ? "公式" : at ? "正文" : "外";
        摘要.源码无展开 = !!owner && !owner.classList.contains(EXPAND);
      }
    } catch { /* 读数失败就记 null，绝不让证人反过来影响编辑 */ }
    ring.push({时刻: Date.now(), 嫌疑, ...摘要, ...(详情 || {})});
    if (ring.length > 50) ring.splice(0, ring.length - 50);
  };
  const 展开数 = () => root.querySelectorAll("." + EXPAND).length;
  // S1：blur 那一刻 + 收回拍完之后各记一帧（收回发生在 blur 后的微任务 refresh）
  const onBlur = () => {
    记("S1-blur", {展开数: 展开数(), 焦点态: doc.hasFocus()});
    setTimeout(() => 记("S1-blur后", {展开数: 展开数(), 焦点态: doc.hasFocus()}), 150);
  };
  // S2：按下 / 抬起 / 抬起后一帧（reclaimed 补跑也盖在这一窗口里）
  const onDown = event => { if (root.contains(event.target)) 记("S2-按下", {展开数: 展开数()}); };
  const onUp = event => {
    if (root.contains(event.target)) {
      记("S2-抬起", {展开数: 展开数()});
      setTimeout(() => 记("S2-抬起后", {展开数: 展开数()}), 200);
    }
  };
  // S3：--expand 被摘除这一可见信号（reconcile 强制折叠 / 收回循环共用），光标在被摘的公式里才是病灶帧
  const observer = new MutationObserver(records => {
    for (const record of records) {
      const target = record.target;
      if (target.nodeType !== Node.ELEMENT_NODE) continue;
      if (!String(record.oldValue || "").includes(EXPAND) || target.classList?.contains(EXPAND)) continue;
      if (!root.contains(target)) continue;
      记("S3-摘展开", {目标: target.getAttribute("data-type") || target.nodeName,
        光标在内: !!target.contains(getSelection()?.focusNode ?? null), 焦点态: doc.hasFocus()});
    }
  });
  observer.observe(root, {subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true});
  // 病灶形状本身：折叠光标落在公式源码里、而那条公式没有展开（0×0 的直接读数）
  const onSel = () => {
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !selection.focusNode || !root.contains(selection.focusNode)) return;
    const at = selection.focusNode.nodeType === Node.TEXT_NODE ? selection.focusNode.parentElement : selection.focusNode;
    const owner = at?.closest?.('.vditor-ir__node[data-type="inline-node"],[data-type="math-block"]');
    if (owner && !owner.classList.contains(EXPAND) && at?.closest?.("code[data-type]")) 记("源码无展开帧");
  };
  view.addEventListener("blur", onBlur, {capture: true, passive: true});
  doc.addEventListener("pointerdown", onDown, {capture: true, passive: true});
  doc.addEventListener("pointerup", onUp, {capture: true, passive: true});
  doc.addEventListener("selectionchange", onSel, {capture: true, passive: true});
  return () => {
    view.removeEventListener("blur", onBlur, {capture: true});
    doc.removeEventListener("pointerdown", onDown, {capture: true});
    doc.removeEventListener("pointerup", onUp, {capture: true});
    doc.removeEventListener("selectionchange", onSel, {capture: true});
    observer.disconnect();
    view.__mpCaretRingInstalled = false;
  };
};

/** Home / End / Ctrl+Home / Ctrl+End 的**事后校正**（2026-09-18 实测：这三个键此前没人管，三条都错）。
 *
 *  实测病象（`probe-real-ops --section=endkeys`，doc A）：
 *   · 标题行上按 Home → 光标落进 `SPAN.vditor-ir__marker[data-type="heading-marker"]` 里（层=围栏），
 *     那不是可编辑位置，接着按 ← 完全不动，用户看到"卡住"；
 *   · Ctrl+Home → 同样落进第一块的标题标记里；
 *   · Ctrl+End → 落在 `P` 的**元素级位置**，矩形 0×0 = 光标没了（用户报的"光标消失"）。
 *
 *  **形态选择**：第一版是"按键接管"（preventDefault 后自己算落点）——实测把场景 75 的
 *  「Ctrl+Home 到文档头再按退格」打红（Vditor 那边的选区状态没跟上，还抛了
 *  `getRangeAt': 0 is not a valid index`）。接管按键等于把 Vditor 的整套语义接管过来，代价太大。
 *  改成**事后校正**：按键照旧交给 Vditor，只在**落点明显坏了**的时候纠偏——
 *   ① 光标隐形（0×0）；② 光标落在公式预览里；③ 落在**非公式**的标记里（`###` 这类）；
 *   ④【F8 2026-10-02】Ctrl+Home 落在**文档第一块的文本尾**（非首）——大文档从底部回文档头
 *     的形态（场景 125①：164 段大文档先 Ctrl+End 到文档底、再 Ctrl+Home，落点停在标题最后
 *     一个字后面）。Typora 的"文档头"语义 = 最前可用位置，钳回去（见 `文档首钳`）。
 *  **公式围栏（`$`、块公式的 `$$`）不算坏位置**：那是"围栏当普通字符"契约里允许的落点，
 *  在这里插一脚会把合法落点挪走（实测那样场景 101 由 32/32 掉到 3/12）。
 *  其余情况一律不碰（Vditor 的结果本来就是对的）。
 */
const patchHomeEndCaret = (api) => {
  const editor = api.vditor;
  const root = editor.ir.element;
  if (!root) return;
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  // 只认 Home/End：←/→ 上"围栏当普通字符"是既有契约（场景 101 钉着），不在这里插手。
  const KEYS = new Set(["Home", "End"]);
  const caretRect = () => {
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.focusNode) return null;
    const probe = doc.createRange();
    probe.setStart(selection.focusNode, selection.focusOffset);
    probe.collapse(true);
    const rect = probe.getBoundingClientRect();
    return rect && rect.height ? rect : null;
  };
  const 在坏位置里 = () => {
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.focusNode) return false;
    const at = selection.focusNode.nodeType === 3 ? selection.focusNode.parentElement : selection.focusNode;
    if (!at?.closest) return false;
    if (at.closest(".vditor-ir__preview")) return true;
    const marker = at.closest('[data-type$="-marker"]');
    if (!marker) return false;
    return !/math/.test(String(marker.getAttribute("data-type") || ""));
  };
  const usable = hit => {
    if (!hit || !root.contains(hit.startContainer)) return false;
    const at = hit.startContainer.nodeType === 3 ? hit.startContainer.parentElement : hit.startContainer;
    if (at?.closest?.(".vditor-ir__preview,.vditor-ir__marker,[data-type$='-marker']")) return false;
    const rect = hit.getBoundingClientRect ? hit.getBoundingClientRect() : null;
    return !!(rect && rect.height);
  };
  const 落 = hit => {
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(hit);
  };
  /** 光标此刻所在的 td/th（不在表格里返回 null）。 */
  const 所在格 = () => {
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.focusNode) return null;
    const at = selection.focusNode.nodeType === 3 ? selection.focusNode.parentElement : selection.focusNode;
    const cell = at?.closest?.("td,th");
    return cell && root.contains(cell) ? cell : null;
  };
  // 【T5】按键那一刻光标所在的格：Home/End（含 ←/→）的行端扫描钳进这个盒。必须在**按下那一刻**
  // 记——默认动作跑完光标可能已被挪出本格，事后再读就读到别的格了；DOM 重建后用 isConnected 防御。
  let 本格 = null;
  /** 在某一行（按行顶对齐）上找最左/最右的可用落点。
   *  【T5】扫描水平边界钳进光标所在 td/th 盒（表格里 Home 只在本格找行端）：不钳的话扫描从
   *  整面左缘起，第 2 列折行的次行按 Home，"本行行首"会被解到第 1 列里——Home 变成跳到前一格。 */
  const 行端 = (y, top, forward) => {
    const box = root.getBoundingClientRect();
    const 格 = 本格 && 本格.isConnected ? 本格.getBoundingClientRect() : null;
    const 左 = 格 && 格.width ? Math.max(box.left, 格.left + 2) : box.left;
    const 右 = 格 && 格.width ? Math.min(box.right, 格.right - 2) : box.right;
    const start = forward ? Math.round(右 - 6) : Math.round(左);
    for (let x = start; forward ? x >= 左 : x <= 右 - 6; x += forward ? -4 : 4) {
      const hit = doc.caretRangeFromPoint(x, y);
      if (!usable(hit)) continue;
      const rect = hit.getBoundingClientRect();
      if (Math.abs(rect.top - top) > 3) continue;
      return hit;
    }
    return null;
  };
  /** 行尾是行内公式时的最后落点：放进源码末尾（落进去会展开，看得见）。 */
  const 公式源码末尾 = (y) => {
    for (const owner of root.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')) {
      const box = owner.getBoundingClientRect();
      if (!box.height || y < box.top - 2 || y > box.bottom + 2) continue;
      const code = owner.querySelector('code[data-type="math-inline"]');
      const text = code?.firstChild?.nodeType === Node.TEXT_NODE ? code.firstChild : null;
      if (!text) continue;
      const range = doc.createRange();
      range.setStart(text, text.data.length);
      range.collapse(true);
      return range;
    }
    return null;
  };
  let 上次可见 = null;
  /** 相邻行兜底：本行没有可见落点时，往上下找最近的可用落点（永远不该出现"没有光标"）。 */
  const 邻行 = (锚, forward) => {
    if (!锚) return false;
    const box = root.getBoundingClientRect();
    for (let step = 1; step <= 40; step++) {
      for (const y of [Math.round(锚.top) + step * 6, Math.round(锚.top) - step * 6]) {
        if (y < box.top + 1 || y > box.bottom - 1) continue;
        const hit = 行端(y, y, forward);
        if (!hit) continue;
        const probe = doc.createRange();
        probe.setStart(hit.startContainer, hit.startOffset);
        probe.collapse(true);
        const rect = probe.getBoundingClientRect();
        if (!rect || !rect.height) continue;
        落(hit);
        上次可见 = {left: rect.left, top: rect.top, bottom: rect.bottom};
        return true;
      }
    }
    return false;
  };
  /** ←/→ 专用：**只在落进标记/预览时**纠偏，隐形一律不管——
   *  公式源码那种"看不见但正确"的位置就住在里面（101 钉着），碰了就把合法落点挪走。 */
  /** 光标落点"在版面上有内容行盒"吗：按 2026-10-01 真屏取证的口径（与已删的合成光标补丁同判据，
   *  矩形这个尺子会撒谎）——Range 矩形读回 0×0 不等于原生画不出光标；光标前/后任一侧取得到
   *  真实内容行盒的位置，Blink 自己就画得出。End/Ctrl+End 落在**行尾公式之后**的元素级位置
   *  正是这种（文档以 $x$ 结尾）：裸 caretRect 0×0 判隐形会把这枚本来就画得出的光标当坏位置
   *  拽回行里——用户看到的就是"End 之后光标被拽走"。 */
  const 版面有行盒 = () => {
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.focusNode) return false;
    const node = selection.focusNode;
    const at = node.nodeType === 3 ? node.parentElement : node;
    const 面 = root.matches?.('.vditor-reset') ? root : root.querySelector?.('.vditor-reset');
    const 块 = at?.closest?.("p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th");
    if (!块 || 块 === 面 || !块.contains(node)) return false;
    const 夹 = (n, o) => Math.min(Math.max(o | 0, 0), n.nodeType === 3 ? n.length : n.childNodes.length);
    const 有行盒 = (range, 取后) => {
      let rects = [];
      try { rects = [...range.getClientRects()]; } catch { return false; }
      if (取后) { for (let i = rects.length - 1; i >= 0; i--) if (rects[i].height > 0) return true; return false; }
      return rects.some(b => b.height > 0);
    };
    try {
      const 前 = doc.createRange();
      前.setStart(块, 0); 前.setEnd(node, 夹(node, selection.focusOffset));
      if (有行盒(前, true)) return true;
      const 后 = doc.createRange();
      后.setStart(node, 夹(node, selection.focusOffset)); 后.setEnd(块, 块.childNodes.length);
      if (有行盒(后, false)) return true;
    } catch { /* 区间建不起来：交回旧判据 */ }
    return false;
  };
  /** ←/→ 专用：**只纠"落在预览浮层里"这一种**——预览是隐藏内容，落进去光标看不见；同行的可用落点找不到
   *  就**什么都不做**（绝不跨行兜底）。
   *
   *  实测（2026-09-20，doc B 横向电池 + `--trace` 选区埋点）：原来的触发条件包含"落在**非公式**标记里"
   *  （`###` 这类），而兜底 `邻行()` 找不到同行落点时会往下逐 6px 找——在标题行上正好找不到，于是把
   *  "→"从上一段末尾**跳过了整行标题**落到下一段（H4 红、H3 红各一处，足迹是 `落()/邻行()`，不是浏览器）。
   *  对 ←/→ 来说，标题标记 `###` 是**合法落点**（围栏当普通字符契约，与 `$` 同类），本就不该纠；
   *  隐形位置更不碰（101 钉着"看不见但正确"的公式源码落点）。 */
  const 校正横向 = forward => {
    if (!root.isConnected) return;
    const selection = getSelection();
    if (!selection?.focusNode) return;
    const at = selection.focusNode.nodeType === 3 ? selection.focusNode.parentElement : selection.focusNode;
    if (!at?.closest?.(".vditor-ir__preview")) return;
    const rect = caretRect() || 上次可见;
    if (!rect) return;
    const midY = Math.round((rect.top + rect.bottom) / 2);
    const hit = 行端(midY, Math.round(rect.top), forward);
    if (hit && hit.startContainer) 落(hit);
  };
  /** 【F8】块内**正文**文本长度（跳过标记/预览；零宽与空白不计），按光标前/后两段分开计数。 */
  const 正文前后 = (块, node, off) => {
    let 前 = 0, 后 = 0, seen = false;
    const walker = doc.createTreeWalker(块, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.parentElement?.closest(".vditor-ir__preview,.vditor-ir__marker,[data-type$='-marker']")) continue;
      const len = n.data.replace(/[\u200b\s]/g, "").length;
      if (n === node) { 前 += Math.min(off, len); 后 += Math.max(0, len - off); seen = true; }
      else if (seen) 后 += len;
      else 前 += len;
    }
    return { 前, 后 };
  };
  /** 【F8】把光标放到块内**最前可用位置**：第一个非标记/非预览的正文文本节点开头
   *  （跳过 `#`、`>` 这类标记——"文档头"落在标题正文第一个字之前，而不是标记里）。 */
  const 落块首 = 块 => {
    const walker = doc.createTreeWalker(块, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (!n.data.replace(/[\u200b\s]/g, "")) continue;
      if (n.parentElement?.closest(".vditor-ir__preview,.vditor-ir__marker,[data-type$='-marker']")) continue;
      const hit = doc.createRange();
      hit.setStart(n, 0);
      hit.collapse(true);
      落(hit);
      return true;
    }
    return false;
  };
  /** 【F8 2026-10-02】Ctrl+Home 的**文档首形态**（场景 125① 每跑必现；第 6 轮定点探针未复现是
   *  路径差异——探针从文档中部按，场景是 164 段大文档先 Ctrl+End 到**文档底**、再按 Ctrl+Home）：
   *  Vditor 的落点在**文档第一块的文本尾**（标题最后一个字后面），用户看到的是"回了文档头
   *  却停在标题末尾"。Typora 的"文档头"语义 = 文档最前可用位置。只认这一种形状：
   *   · 光标（折叠）在编辑面**第一块**内，且不在标记/预览里（那些是 `校正` 的业务）；
   *   · 落点是该块**文本尾**（后面再无正文）且**非首**（前面还有正文）——本来就落在最前
   *     可用位置、或空块、或元素级没贴到块尾的，一律不碰，绝不把正确结果拽走。
   *  满足时钳回该块最前可用位置（跳过标记）。返回是否执行了校正。 */
  const 文档首钳 = () => {
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.focusNode || !selection.isCollapsed) return false;
    const node = selection.focusNode, off = selection.focusOffset;
    const at = node.nodeType === 3 ? node.parentElement : node;
    if (!at?.closest || at.closest(".vditor-ir__preview,.vditor-ir__marker,[data-type$='-marker']")) return false;
    // 元素级位置只认"贴到块尾"那一种（off === 子节点数）：块中间的元素级落点前后归属不明，
    // 宁可放过也不误钳。
    if (node.nodeType !== Node.TEXT_NODE && off !== node.childNodes.length) return false;
    const 块 = at.closest("p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th");
    if (!块 || !root.contains(块)) return false;
    const 面 = root.matches?.(".vditor-reset") ? root : root.querySelector?.(".vditor-reset");
    const 首块 = 面?.firstElementChild;
    if (!首块 || !(首块 === 块 || 首块.contains(块))) return false;  // 不是文档第一块：不碰
    const { 前, 后 } = 正文前后(块, node, off);
    if (!(前 > 0 && 后 === 0)) return false;                         // 不是「文本尾且非首」：不碰
    if (!落块首(块)) return false;                                   // 【F8 突变点】注掉这一行，125① 必红（r7mut 实测）
    const rect = caretRect();
    if (rect) 上次可见 = {left: rect.left, top: rect.top, bottom: rect.bottom};
    return true;
  };
  const 校正 = forward => {
    if (!root.isConnected) return;
    const rect = caretRect();
    // 【C4 2026-10-02】裸 caretRect 0×0 先过"版面内容行盒"这一关：前/后取得到真实内容行盒的
    // 位置 Blink 自己画得出（见 版面有行盒 的注释），不是坏位置，绝不能拽走。
    if (!rect && 版面有行盒()) return;
    if (!rect || 在坏位置里()) {
      const 锚 = rect ? {left: rect.left, top: rect.top, bottom: rect.bottom} : 上次可见;
      if (!锚) return;
      const midY = Math.round((锚.top + 锚.bottom) / 2);
      // （R2·L3 突变不红：行端自命中围栏，前提不成立，撤销）
      const hit = 行端(midY, Math.round(锚.top), forward) || (forward ? 公式源码末尾(midY) : null);
      if (!hit) { 邻行(锚, forward); return; }
      落(hit);
      // 落进去的可能是公式源码（折叠态看不见），Vditor 展开要晚一拍：下一拍再确认；
      // 仍然隐形就退到相邻行的可见位置——用户永远不该遇到"光标没了"。
      const 验 = () => {
        if (!root.isConnected) return;
        const 现在 = caretRect();
        if (现在) { 上次可见 = {left: 现在.left, top: 现在.top, bottom: 现在.bottom}; return; }
        邻行(锚, forward);
      };
      requestAnimationFrame(验);
      setTimeout(验, 60);
      return;
    }
    // Home 在**折行**段落上给的是"逻辑行首"，渲染出来落在**上一行行尾**（实测 x=876、y 差一行）；
    // Typora/VS Code 的习惯是"视觉行首"。只有当按键前光标**不在**本行行首时才纠（连按第二次
    // 时用户要的正是逻辑行首，那个时候让它留着）。
    if (!forward && 上次可见) {
      const 原行 = Math.round(上次可见.top);
      const 还有本行 = rect && Math.abs(rect.top - 原行) <= 3;
      if (rect && !还有本行 && Math.abs(rect.top - 原行) < 60) {
        const 原中线 = Math.round((上次可见.top + 上次可见.bottom) / 2);
        const 原行首 = 行端(原中线, 原行, false);
        if (原行首 && Math.abs(上次可见.left - 原行首.getBoundingClientRect().left) > 6) { 落(原行首); return; }
      }
    }
    上次可见 = {left: rect.left, top: rect.top, bottom: rect.bottom};
  };
  /** 记账：光标**任何时候**可见时都记一笔。只在 Home/End 里记是不够的——
   *  实测：点一下换个位置再按 Home，用的是**上一轮**留下的锚，折行纠偏就判错了。 */
  /** 【F8b】晚到的收口不许越过最新一键/一点：每次按键/点击翻代，旧守望立即作废。 */
  let 拍代 = 0;
  const 记账 = () => { const rect = caretRect(); if (rect) 上次可见 = {left: rect.left, top: rect.top, bottom: rect.bottom}; };
  view.addEventListener("keydown", event => {
    if (event.isComposing || editor.ir.composingLock) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      本格 = 所在格();                 // 【T5】默认动作之前的本格快照
      const forward = event.key === "ArrowRight";
      requestAnimationFrame(() => 校正横向(forward));
      setTimeout(() => 校正横向(forward), 0);
      return;
    }
    if (!KEYS.has(event.key)) { 记账(); return; }
    if (event.altKey || event.metaKey || event.shiftKey) {
      // 【F R9-10-03】Shift+Home/End 的塌缩修复（probe-r9-extend 形状 a/C/D 实测定罪）：
      // Blink 对「紧贴标记边界的位」算行端会失准——标题文本 offset0（≡"## "标记末）处
      // Shift+End，选区**当场塌成空**、两端点一起掉进标记（扩展被吞）；Shift+Home 的
      // focus 只落到标记内 offset0/1，从不落正文行首。给 shift 变体补「只校 focus 端、
      // anchor 原地不动」的事后校正：focus 落进坏位置（标记/预览，复用在坏位置里）时扫
      // 出该行可用的行端、把 focus 挪过去，anchor 用按下时的快照还原（Blink 会把 anchor
      // 一起规范化进标记）。focus 在正文（孤岛行形状 b、普通行）完全不碰；Alt/Meta/Ctrl
      // 变体维持原样不接管。注意不能直接用 行端：它的 ±3px 行顶对齐假设「caret 顶一致」，
      // 而标记字体小于正文（实测 "## " caret 顶 219 vs 正文 197）——这里按「行盒纵向相交」
      // 判同线，并沿袭 T5 的本格钳（表格里 Shift+Home/End 只在本格找行端）。
      if (event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
        本格 = 所在格();
        const forward = event.key === "End";
        const selection = getSelection();
        const 锚节点 = selection?.anchorNode || null, 锚位 = selection?.anchorOffset || 0;
        const 代 = ++拍代;
        const 校扩 = () => {
          if (代 !== 拍代 || !root.isConnected) return;
          const sel = getSelection();
          if (!sel?.rangeCount || !sel.focusNode || !root.contains(sel.focusNode)) return;
          if (!在坏位置里()) return;                 // 只认 focus 落进标记/预览这一种形状
          const rect = caretRect();
          if (!rect) return;
          const y = Math.round((rect.top + rect.bottom) / 2);
          const box = root.getBoundingClientRect();
          const 格 = 本格 && 本格.isConnected ? 本格.getBoundingClientRect() : null;
          const 左 = 格 && 格.width ? Math.max(box.left, 格.left + 2) : box.left;
          const 右 = 格 && 格.width ? Math.min(box.right, 格.right - 2) : box.right;
          let hit = null;
          for (let x = forward ? Math.round(右 - 6) : Math.round(左); forward ? x >= 左 : x <= 右 - 6; x += forward ? -4 : 4) {
            const cand = doc.caretRangeFromPoint(x, y);
            if (!cand || !usable(cand)) continue;
            const r2 = cand.getBoundingClientRect();
            if (r2.top > rect.bottom || r2.bottom < rect.top) continue;  // 行盒不相交：不是同一行
            hit = cand; break;
          }
          if (!hit) return;                            // 本行解不出可用行端：宁可维持现状
          const 锚ok = 锚节点 && root.contains(锚节点);
          try { sel.setBaseAndExtent(锚ok ? 锚节点 : sel.anchorNode, 锚ok ? 锚位 : sel.anchorOffset, hit.startContainer, hit.startOffset); } catch { /* 重建失败维持现状 */ }
        };
        requestAnimationFrame(校扩);
        setTimeout(校扩, 0);
      }
      return;
    }
    本格 = 所在格();                   // 【T5】同上：Home/End 按下那一刻光标还在原格里
    const forward = event.key === "End";
    // 【F8】Ctrl+Home 多走一步"文档首"校正：大文档从底部回文档头时 Vditor 落在第一块文本尾，
    // 钳回最前可用位置（见 `文档首钳`）。没命中该形状时照旧走 `校正`。
    const 文档首 = event.key === "Home" && event.ctrlKey;
    const 代 = ++拍代;
    const 拍 = () => { if (代 !== 拍代) return; if (文档首 && 文档首钳()) return; 校正(forward); };
    requestAnimationFrame(拍);
    setTimeout(拍, 0);
    if (文档首) {
      // 【F8b】大文档 Ctrl+Home 的原生落点是**两段式**的：先落进标题标记、再（虚拟化窗口
      // 重挂载后，实测可晚到一两百毫秒）落到正文尾。单发 120ms 收口会漏拍——改为短窗守望：
      // selectionchange 一到就收口 + 定时补收几拍，全部过**代数闸**（新按键/点击立即作废旧
      // 守望，绝不把晚到的钳制叠加到用户的下一个动作上）。守望窗 500ms，场景读数（400ms）
      // 之前必已收口。
      const 守 = () => { if (代 !== 拍代) { 收守(); return; } 文档首钳(); };
      const 收守 = () => doc.removeEventListener("selectionchange", 守);
      doc.addEventListener("selectionchange", 守);
      setTimeout(收守, 500);
      for (const ms of [120, 200, 280, 360]) setTimeout(() => { if (代 === 拍代) 文档首钳(); }, ms);
    }
  }, true);
  root.addEventListener("mousedown", () => { 拍代++; requestAnimationFrame(记账); setTimeout(记账, 0); }, true);
};

/** 单击落进**公式源码**、却看不见光标（元素级位置，矩形 0×0）时的纠偏。
 *
 *  实测病象（2026-09-19 用户报告，scripts/acceptance/probe-repro-aftermath*.cjs）：
 *  行内公式展开后，点它**后面**的正文（"设"字）——光标进不去，而且公式一直保持展开、
 *  浮出的预渲染框一直压着下一行。逐事件取证（probe-repro-aftermath3）：
 *    `mousedown` 那一帧 target 还是正文 `P`；`mouseup` 那一帧同一个点的 target 变成了
 *    `SPAN.mbin`（浮框里的 KaTeX 子树——展开重排让浮框短暂经过那个像素）；
 *    Vditor 于是把这一按当成"点在公式上"，把光标写进
 *    `code[data-type="math-inline"]@0`（**元素级**位置，0×0 画不出来），公式自然不收回去。
 *
 *  规则（只认这一种形状，其余一律不碰）：
 *   · 单次左键、无修饰键、按下与抬起的点基本没动（不是拖拽）；
 *   · 落点**隐形**（caret 矩形高度 0）且落在某个公式的源码 `code[data-type]` 里；
 *   · **点击点在公式自己的盒子之外**——点公式盒子里就是要进源码编辑（既有契约），不动它。
 *  满足时按点击点重解一次落点（只接受可见、且不在预览/围栏里的位置），把光标还给用户点的
 *  那一处；解不出来就什么都不做（宁可维持原状，也不乱放）。 */
const patchClickIntoFormulaSource = (api) => {
  const editor = api.vditor;
  const root = editor.ir.element;
  if (!root) return;
  const doc = root.ownerDocument;
  /** 点击点真的落在**编辑器正文**上吗——浮动面板/弹层盖在上面时不算。
   *
   *  实测教训（scripts/acceptance/probe-repro-findfocus.cjs）：查找面板浮在正文之上，
   *  点它的输入框时几何上那一点仍落在某条折叠块公式/公式源码的范围内；不设这道闸，
   *  我们就会把光标挪进正文——而 **Blink 在选区落进可编辑区时会把 DOM 焦点一起搬过去**，
   *  于是面板输入框失焦、接着打的字全进了文档（场景 75 的两条红就是这么来的，
   *  A/B：2.2.5 上 50/50，带这两个点击钩子的 2.2.6/2.2.7 上 48/50）。
   *  `elementFromPoint` 走的是真正的命中测试（含浮层），因此拿它当闸门。 */
  const 点在正文上 = (x, y) => {
    const el = doc.elementFromPoint ? doc.elementFromPoint(x, y) : null;
    return !!(el && root.contains(el));
  };
  const 隐形 = () => {
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !selection.focusNode) return false;
    const probe = doc.createRange();
    probe.setStart(selection.focusNode, selection.focusOffset);
    probe.collapse(true);
    const rect = probe.getBoundingClientRect ? probe.getBoundingClientRect() : null;
    return !(rect && rect.height);
  };
  const 可用 = hit => {
    if (!hit || !root.contains(hit.startContainer)) return false;
    const at = hit.startContainer.nodeType === 3 ? hit.startContainer.parentElement : hit.startContainer;
    if (at?.closest?.(".vditor-ir__preview,.vditor-ir__marker,[data-type$='-marker']")) return false;
    const rect = hit.getBoundingClientRect ? hit.getBoundingClientRect() : null;
    return !!(rect && rect.height);
  };
  const 盒子里 = (node, x, y) => {
    const box = node?.getBoundingClientRect?.();
    if (!box || !box.width || !box.height) return false;
    return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
  };
  let 按下 = null;
  // **挂在 document 的捕获阶段**：math-edit 的 fenceClick 也在捕获阶段、但挂在编辑面上，
  // 它处理贴着折叠块公式的空白点击时会 stopImmediatePropagation——挂在编辑面上会被它吃掉
  // （实测：校正一次都没跑，标记恒为 null）。document 在祖先层，先到。
  doc.addEventListener("mousedown", event => {
    按下 = event.button === 0 && event.detail <= 1 && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
      ? {x: event.clientX, y: event.clientY} : null;
    // 【H·A 2026-10】按下这一帧快照"点没点在公式上"（owner 盒 + 浮框盒）。mouseup 之后
    // vendored/refresh 可能把展开态收走，公式盒子整块变掉；这个纠偏事后读布局会把
    // "点在展开源码上"误判成"点在公式外"，把刚放进源码的光标又挪回正文——用户报
    // 「### 标题 $N^2$ 里点 2 后按 Shift+← 反向选中失败」的根因链末环（dev 探针
    // H-probe.cjs：点击落点 N^2@3 正确，18ms 后被本纠偏改写到正文"题"后，栈钉死
    // removeAllRanges/addRange 出自本函数）。按下帧的布局正是用户看见并点击的那一版。
    if (按下) {
      const hit = doc.elementFromPoint ? doc.elementFromPoint(按下.x, 按下.y) : null;
      const owner = hit && hit.closest ? hit.closest('.vditor-ir__node[data-type]') : null;
      if (owner && owner.querySelector(':scope > code[data-type="math-inline"], :scope > pre > code[data-type="math-block"]')) {
        按下.ownerBox = owner.getBoundingClientRect();
        const preview = owner.querySelector('.vditor-ir__preview');
        if (preview) 按下.previewBox = preview.getBoundingClientRect();
      }
    }
  }, true);
  doc.addEventListener("mouseup", event => {
    const 点 = 按下;
    按下 = null;
    if (!点) return;
    if (Math.abs(event.clientX - 点.x) > 3 || Math.abs(event.clientY - 点.y) > 3) return;   // 拖拽，不接管
    const 点在矩形内 = (rect, x, y) => !!(rect && rect.width
      && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
    const 拍 = () => {
      if (!root.isConnected || !隐形()) return;
      if (!点在正文上(点.x, 点.y)) return;                                 // 点在浮层上（查找面板等）：不接管
      const selection = getSelection();
      const at = selection.focusNode.nodeType === 3 ? selection.focusNode.parentElement : selection.focusNode;
      if (!at?.closest?.("code[data-type]")) return;                     // 不在公式源码里：不管
      const owner = at.closest('.vditor-ir__node[data-type]');
      // 【H·A】按下帧点在公式（展开源码/浮框）上：那是"进源码编辑"的点击，光标留在
      // 源码里，绝不外挪（布局时移见 mousedown 处快照的注释）。
      if (点在矩形内(点.ownerBox, 点.x, 点.y) || 点在矩形内(点.previewBox, 点.x, 点.y)) return;
      if (盒子里(owner, 点.x, 点.y)) return;                             // 点在公式盒子里：那是"进源码编辑"
      if (盒子里(owner?.querySelector(".vditor-ir__preview"), 点.x, 点.y)) return;   // 点在浮框上：同上
      for (const x of [点.x, 点.x - 6, 点.x + 6, 点.x - 12, 点.x + 12]) {
        const hit = doc.caretRangeFromPoint ? doc.caretRangeFromPoint(x, 点.y) : null;
        if (!可用(hit)) continue;
        const range = getSelection();
        range.removeAllRanges();
        range.addRange(hit);
        window.__typoraClickIntoFormula = {点: [Math.round(点.x), Math.round(点.y)], 落: Math.round(hit.getBoundingClientRect().left)};
        return;
      }
    };
    requestAnimationFrame(拍);
    setTimeout(拍, 0);
  }, true);
};

/** ←/→ 走进"整行只有一条行内公式"的行：把光标从**画不出来**的元素级位置挪进源码。
 *
 *  实测病象（scripts/acceptance/probe-repro-hline.cjs，5 行小素材，确定性复现）：
 *   · 第一段末尾按 **→**（下一行是整行 `$a+b$`）→ 光标落在 `P@0`：矩形 **0×0**、公式**不展开**；
 *   · 第二段开头按 **←**（上一行同一条公式）→ 同上（`P@1`）。
 *  用户看到的就是"往左/右一按，光标没了"，接着打字落点也不可预期。
 *  **同一条公式上下走是对的**（↓/↑ 落进源码 offset 3、节点展开、光标可见 13px）——
 *  那是 `patchVerticalMathLine` 的功劳；横向一直没有这一手，这条把它补齐。
 *
 *  修法（事后校正，与上下方向键同一形状）：←/→ 之后若
 *   ① 选区折叠、② 落点**隐形**（没有矩形）、③ 落点在"只有一条公式"的块里（元素级位置），
 *  就把光标放进那条公式的**源码**：→ 去开头、← 去末尾。展开由 math-edit 自己的按键刷新完成
 *  （实测：按键路径下节点会展开，程序化落点不会——所以走"键后校正"这条路）。
 *  其余一律不碰：看得见的落点、正文行、公式源码内部（那是"围栏当普通字符"契约里的事）。 */
const patchHorizontalMathLine = (api) => {
  const editor = api.vditor;
  const root = editor.ir.element;
  if (!root) return;
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const 隐形 = () => {
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !selection.focusNode) return false;
    const probe = doc.createRange();
    probe.setStart(selection.focusNode, selection.focusOffset);
    probe.collapse(true);
    const rect = probe.getBoundingClientRect ? probe.getBoundingClientRect() : null;
    return !(rect && rect.height);
  };
  /** 落点所在块里那条唯一的行内公式的源码文本节点（不是"整行只有一条公式"就返回 null）。 */
  const 公式行源码 = () => {
    const selection = getSelection();
    if (!selection?.rangeCount) return null;
    const node = selection.focusNode;
    if (node.nodeType !== 1) return null;                   // 只认元素级落点：文本位置由原生逻辑负责
    if (node.closest?.("code[data-type]")) return null;      // 已经在源码里：不插手
    const 块 = node.closest?.("p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th") || node;
    const 公式们 = [...块.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
    if (公式们.length !== 1) return null;
    const 公式 = 公式们[0];
    const 去空 = text => String(text || "").replace(/[\s\u200b]/g, "");
    if (去空(块.textContent).length !== 去空(公式.textContent).length) return null;   // 行里还有别的字
    const code = 公式.querySelector('code[data-type="math-inline"]');
    return code?.firstChild?.nodeType === Node.TEXT_NODE ? code.firstChild : null;
  };
  /** 方向与**入口侧**对上了吗：这一手补的是"从行外**走进**这条公式行"，只有走进来的那一侧
   *  才该进源码——→ 只在"公式之前"（元素级 `P@0`），← 只在"公式之后"（元素级 `P@childNodes.length`）。
   *
   *  不判侧边的实测后果（2026-09-23，probe-f9-trap.cjs）：在"整行只有一条公式"的行**尾**按 →，
   *  行内公式补丁先把光标放到段尾的元素级位置 `P@1`（矩形读回 0×0，属**正常插入点**——
   *  原生光标真屏画得出），这里紧接着又把这枚隐形光标当成"从上一行走进公式行"，
   *  塞回**同一条公式源码的开头**——用户按 → 想离开这一行，光标却回到了行首，整行出不去了
   *  （134 的 ① 巡走全篇卡在块 3 就是它，读数里 `P@1` 那一步的写入栈指到这里）。
   *  容器不是块元素本身（在段内别处）时维持原判：那种形状本来就是"走进来"。 */
  const 入口侧 = (forward, selection) => {
    const 容器 = selection?.focusNode;
    if (容器?.nodeType !== 1) return true;
    if (容器.closest?.("p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th") !== 容器) return true;
    const 偏 = Math.min(Math.max(selection.focusOffset | 0, 0), 容器.childNodes.length);
    // → 必须停在"公式之前"（偏移 0）；← 必须停在"公式之后"（偏移 > 0，段尾那些空文本节点
    // 会让 childNodes.length 大于 1，按长度判会把合法的段尾落点误判掉）。
    return forward ? 偏 === 0 : 偏 > 0;
  };
  /** 【F18 2026-10-02】Ctrl/Cmd+←/→ **词跳**的"同块回绕"校正（最小侵入点：横向补丁层的
   *  ctrl 分支，事后校正——原生词跳照旧跑完，只在落点回绕时钳回）。
   *
   *  病象（R6 判决 F18）：公式行里 Ctrl+→，Chromium 的词跳跨过 contenteditable=false 的
   *  渲染结果后落点会**回绕**——右跳却回到块首/文档序更靠前的位置，甚至蹦进相邻块。
   *  Typora 的口径：词跳在本行内逐词走，**跨块只发生在行尾/行首**。
   *
   *  判定（与键向相反才动手，其余一律不碰）：
   *   ① **同块回绕**：词跳后落点与起跳点同块，但文档序倒退了（右跳落到起跳点之前——
   *      不比裸 x：折行段落里合法的前跳本来就可能换行后 x 变小）；
   *   ② **非行端跨块**：落点进了**别的块**，而起跳点不在键向那一端的行端（跨块仅行尾/行首合法）。
   *  校正：钳回**起跳那一行**键向那一端的行端（右向行尾/左向行首）。行端位置在**按下那一刻**
   *  用命中测量好（node+offset 存下来）——词跳引发的公式展开/收起重排不会再影响它；
   *  存下的节点被重排掉（!isConnected）或行端根本量不出来时，宁可不纠，也不乱放。
   *  五处 ctrl 早退点（patchMathCaret / 纵向层 / 看门狗 / math-edit / marker-caret-guard）
   *  一概不动：它们只放行不接管，词跳的默认动作与这里的事后校正正好衔接。 */
  const 光标盒 = () => {
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !selection.focusNode) return null;
    const probe = doc.createRange();
    probe.setStart(selection.focusNode, selection.focusOffset);
    probe.collapse(true);
    const rect = probe.getBoundingClientRect();
    return rect && rect.height ? rect : null;
  };
  const 块Of = node => {
    const at = node?.nodeType === 3 ? node.parentElement : node;
    return at?.closest?.("p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th") || null;
  };
  /** 起跳那一行键向那一端的行端位置（右向＝最右可落点，左向＝最左）。
   *  预览里的命中不算（那是隐藏内容）；围栏标记**算**（围栏当普通字符的契约）；
   *  元素级位置没有矩形也不算（扫描会自然越过它）。整行只有一条公式时扫描找不到
   *  同行可落点，退而钳进那条公式源码的尾/首（落进去会展开，看得见）。 */
  const 行端位 = (y, top, forward) => {
    const surfaceBox = root.getBoundingClientRect();
    const start = forward ? Math.round(surfaceBox.right - 6) : Math.round(surfaceBox.left);
    const end = forward ? Math.round(surfaceBox.left) : Math.round(surfaceBox.right - 6);
    for (let x = start; forward ? x >= end : x <= end; x += forward ? -4 : 4) {
      const hit = doc.caretRangeFromPoint ? doc.caretRangeFromPoint(x, y) : null;
      if (!hit || !root.contains(hit.startContainer)) continue;
      const at = hit.startContainer.nodeType === 3 ? hit.startContainer.parentElement : hit.startContainer;
      if (at?.closest?.(".vditor-ir__preview")) continue;
      const rect = hit.getBoundingClientRect();
      if (!rect || !rect.height) continue;
      if (Math.abs(rect.top - top) > 3) continue;                 // 不在起跳那一行
      return {node: hit.startContainer, offset: hit.startOffset, x: rect.left};
    }
    for (const owner of root.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')) {
      const box = owner.getBoundingClientRect();
      if (!box.height || y < box.top - 2 || y > box.bottom + 2) continue;
      const code = owner.querySelector('code[data-type="math-inline"]');
      const text = code?.firstChild?.nodeType === Node.TEXT_NODE ? code.firstChild : null;
      if (!text) continue;
      return {node: text, offset: forward ? text.length : 0, x: forward ? box.right : box.left};
    }
    return null;
  };
  /** 【F18c】**公式边界钳**：前进词跳的落点停在公式 owner 的边界上（元素级压着 owner 的
   *  前沿/后沿——`P@n` 贴着公式、owner 子树末支的元素级终点，或源码文本开头的围栏位）。
   *  这些位置要么 0×0 隐形、要么是"按一下不动"的滞留点；F18b 的行端兜底会把它们一步钳到
   *  **整行行尾**（实测 123③：从公式前的"与"起跳，一步跨掉 与+公式+以及+标点+。——跳过头）。
   *  Typora 口径：**公式整体视为一个词**——直接钳到公式之后的下一个词位（同块内 owner 之后
   *  第一个非空正文文本的开头；其间再遇到的公式同样整条跳过）。起跳点已在这条公式里
   *  （源码内词跳是 123⑤ 钉着的契约行为）时不接管。返回是否执行了钳制。 */
  const OWNER_SEL = '.vditor-ir__node[data-type="inline-node"]';
  const 公式边界钳 = (sel, beforeNode) => {
    const node = sel.focusNode, off = sel.focusOffset | 0;
    if (!node || !root.contains(node)) return false;
    const 块 = (node.nodeType === 3 ? node.parentElement : node)?.closest?.("p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th");
    if (!块) return false;
    const point = doc.createRange();
    try { point.setStart(node, off); point.collapse(true); } catch { return false; }
    let owner = null;
    for (const o of 块.querySelectorAll(OWNER_SEL)) {
      const box = doc.createRange();
      box.selectNodeContents(o);
      let vs首 = 1, vs尾 = -1;
      try {
        vs首 = point.compareBoundaryPoints(Range.START_TO_START, box);   // 落点 vs owner 前沿
        vs尾 = point.compareBoundaryPoints(Range.END_TO_END, box);       // 落点 vs owner 后沿
      } catch { continue; }
      if (vs首 === 0 || vs尾 === 0) { owner = o; break; }                // 元素级压着 owner 前/后沿
      if (vs首 > 0 && vs尾 < 0 && node.nodeType === Node.TEXT_NODE && off <= 1) {
        const code = node.parentElement?.closest?.('code[data-type="math-inline"]');
        if (code && node === code.firstChild) { owner = o; break; }      // 围栏位：源码开头贴着 '$'
      }
    }
    if (!owner) return false;
    if (owner.contains(beforeNode)) return false;                        // 起跳就在这条公式里：契约行为，不接管
    const walker = doc.createTreeWalker(块, NodeFilter.SHOW_TEXT);
    let n = null, seen = false;
    while ((n = walker.nextNode())) {
      if (owner.contains(n)) { seen = true; continue; }
      if (!seen) continue;
      const p = n.parentElement;
      if (!p || p.closest('.vditor-ir__preview,.vditor-ir__marker,[data-type$="-marker"]')) continue;
      if (p.closest(OWNER_SEL)) continue;                                // 别的公式也是"一个词"：整条跳过
      const m = /[^ \t\r\n\f\v\u200b\u200c]/.exec(String(n.data));
      if (!m) continue;
      const range = doc.createRange();
      range.setStart(n, m.index);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    }
    return false;                                                        // 公式之后没有正文：交回行端兜底
  };
  /** 【F18d】Ctrl/Cmd+Backspace 的**公式整体词删**：光标（折叠）贴在公式 owner 的**后沿**
   *  ——紧挨公式结尾的元素级位、或公式后正文文本的开头（其间只允许零宽字符）——时，
   *  一次词删吃掉**整条公式**（两个围栏 `$` 一起走，$ 永远成对）。放任原生/Vditor 处理，
   *  会先把光标塞进源码末尾、再按 TeX 单字往下啃：实测 123① 先啃掉收口 `$`（此后 $ 计数
   *  恒为奇数），随后每删一个源码字符都判"公式被拆坏"。源码**内部**的词删是 123⑤ 钉着的
   *  契约行为（TeX 词删、围栏不拆），不在本形状内。删除走 execCommand 编辑通道：
   *  撤销栈 / IR 重排照常工作。返回是否已接管。 */
  const 公式词删 = event => {
    const sel = getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed || !sel.focusNode || !root.contains(sel.focusNode)) return false;
    const node = sel.focusNode, off = sel.focusOffset | 0;
    const 块 = (node.nodeType === 3 ? node.parentElement : node)?.closest?.("p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th");
    if (!块) return false;
    const point = doc.createRange();
    try { point.setStart(node, off); point.collapse(true); } catch { return false; }
    let owner = null;
    for (const o of 块.querySelectorAll(OWNER_SEL)) {
      const box = doc.createRange();
      box.selectNodeContents(o);
      let vs尾 = 1;
      try { vs尾 = point.compareBoundaryPoints(Range.END_TO_END, box); } catch { continue; }
      if (vs尾 < 0) continue;                        // 光标在 owner 终点之前：不是这个形状
      // 光标到 owner 后沿之间只许零宽/空白（真有正文字就轮不到公式；后面的公式文本也会被量出来）
      const gap = doc.createRange();
      try { gap.setStart(box.endContainer, box.endOffset); gap.setEnd(node, off); } catch { continue; }
      if (String(gap.toString()).replace(/[\s\u200b\u200c]/g, "")) continue;
      owner = o;
      break;
    }
    if (!owner) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    const range = doc.createRange();
    range.selectNode(owner);
    sel.removeAllRanges();
    sel.addRange(range);
    doc.execCommand("delete");
    return true;
  };
  const 词跳校正 = forward => {
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !selection.focusNode) return;
    if (!root.contains(selection.focusNode)) return;
    const beforeNode = selection.focusNode, beforeOffset = selection.focusOffset;
    const beforeBox = 光标盒();
    if (!beforeBox) return;                       // 起跳点自己就隐形（公式源码里）：不掺和
    const 块 = 块Of(beforeNode);
    if (!块) return;
    const 行端 = 行端位((beforeBox.top + beforeBox.bottom) / 2, Math.round(beforeBox.top), forward);
    const 在行端 = !!行端 && Number.isFinite(行端.x) && Math.abs(行端.x - beforeBox.left) <= 8;
    const 检 = () => {
      if (!root.isConnected || !行端) return;
      if (!beforeNode.isConnected) return;       // 词跳引发重排把起跳节点弄没了：无从比对，不纠
      const sel = getSelection();
      if (!sel?.rangeCount || !sel.isCollapsed || !sel.focusNode || !root.contains(sel.focusNode)) return;
      // 【F18c】公式边界落点优先于回绕判定（公式内的隐形豁免会让 SPAN@n 形状判成"不纠"，
      // 而行端兜底又会把 P@n 形状一步钳到整行行尾——跳过头）。公式整体视为一个词。
      if (forward && 公式边界钳(sel, beforeNode)) return;
      const after块 = 块Of(sel.focusNode);
      let 回绕 = false;
      if (after块 === 块) {
        const a = doc.createRange(); a.setStart(beforeNode, beforeOffset); a.collapse(true);
        const b = doc.createRange(); b.setStart(sel.focusNode, sel.focusOffset); b.collapse(true);
        try {
          回绕 = forward ? b.compareBoundaryPoints(Range.START_TO_START, a) < 0
            : b.compareBoundaryPoints(Range.START_TO_START, a) > 0;
        } catch { 回绕 = false; }
        // 【F18b 实测补充】文档序"前进"、几何却倒退的形状：Ctrl+→ 从公式前的正文里起跳，
        // Chromium 把落点放到公式 span 之后的**元素级位置**（P@n，矩形 0×0 渲染回行首 x=0）
        // ——文档序它在公式后（compareBoundaryPoints 判"前进"），用户看到的光标却回到了
        // 行首/直接隐形。同一视觉行上前进词跳的 x 只许不减；落点矩形 0×0 时，公式源码里的
        // 隐形是正常落点（行尾公式跳进源码），元素级/正文位上的隐形才是病。
        if (!回绕) {
          const afterBox = 光标盒();
          if (afterBox) {
            if (Math.abs(afterBox.top - beforeBox.top) <= 3)
              回绕 = forward ? afterBox.left < beforeBox.left - 2 : afterBox.left > beforeBox.left + 2;
          } else {
            const at = sel.focusNode.nodeType === 3 ? sel.focusNode.parentElement : sel.focusNode;
            if (!at?.closest?.('code[data-type],.vditor-ir__node[data-type="inline-node"]')) 回绕 = true;
          }
        }
      } else if (!在行端) 回绕 = true;            // 跨块但起跳点不在行端：跨块仅行尾/行首合法
      if (!回绕) return;
      if (!行端.node.isConnected) return;         // 词跳引发重排把存好的行端节点弄没了：不纠
      const range = doc.createRange();
      const 上限 = 行端.node.nodeType === 3 ? 行端.node.length : 行端.node.childNodes.length;
      range.setStart(行端.node, Math.max(0, Math.min(行端.offset, 上限)));
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      window.__typoraWordWrapFix = {方向: forward ? "→" : "←",
        形态: after块 === 块 ? "同块回绕" : "非行端跨块", 钳: [Math.round((光标盒() || beforeBox).left), Math.round((光标盒() || beforeBox).top)]};
    };
    requestAnimationFrame(检);
    setTimeout(检, 0);
  };
  view.addEventListener("keydown", event => {
    if (event.isComposing || editor.ir.composingLock) return;
    if (event.key === "Backspace" && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
      if (公式词删(event)) return;               // 【F18d】词删吃整条公式（$ 成对走），见 公式词删 的注释
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
      词跳校正(event.key === "ArrowRight");      // 【F18】词跳形态：事后校正，见 词跳校正 的注释
      return;
    }
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    const forward = event.key === "ArrowRight";
    const 拍 = () => {
      if (!root.isConnected || !隐形()) return;
      if (!入口侧(forward, getSelection())) return;
      const text = 公式行源码();
      if (!text) return;
      const range = doc.createRange();
      range.setStart(text, forward ? 0 : text.length);
      range.collapse(true);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      window.__typoraHLine = {方向: forward ? "→" : "←", 落: forward ? 0 : text.length};
    };
    requestAnimationFrame(拍);
    setTimeout(拍, 0);
  }, true);
};

/** 【H·B 2026-10】标题块里的 Shift+←/→ 扩选：vendored 的 keydown→B 链每按都在重设
 *  选区（index.min.js 的 c@69493 ← B@83619，removeAllRanges+addRange 一对），标题块上
 *  它算出的区间**每两下塌一次**——实测（dev 探针 H-probe2.cjs B1）标题正文"丙"后按住
 *  Shift 连按 ←：选中 1 字 → 塌 → 1 字 → 塌，永远攒不长；同款按键在普通段落上原生
 *  累积完好（B2：1→2→3→4→5）。用户报「### 标题 $N^2$ 里 Shift+← 反向选中失败」的
 *  另一半根因就是它：光标扩出公式后落进标题正文，从此每两按塌一次。
 *
 *  修法（产品层，不碰 vendored）：标题块内的 Shift 横向扩选由我们接管——与
 *  patchMathCaret 同一套字形步进（Intl.Segmenter）+ extendEnd 的 setBaseAndExtent
 *  （固定端钉死，方向不被规范化收塌）。拼接空间=标题块全部文本（含 `### ` 记号与
 *  公式源码，跳过预览），围栏/记号按普通字符对待，与既有契约同口径。两端走出标题块
 *  （块首 `#` 之前 / 块尾之后）时交回浏览器原生扩选（普通段实测原生是好的）。
 *  安装在 patchMathCaret 之后：光标在公式源码里时它先接管并拦停事件，流不到这里。 */
const patchHeadingShiftExtend = (api) => {
  const editor = api.vditor;
  const root = editor.ir.element;
  if (!root) return;
  const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, {granularity: "grapheme"}) : null;
  /* 【U-089 2026-10-06】键盘族锚点丢失——gesture 状态 + keyup 重申（对抗评审 B-方案统一版）。
   * 机制（插桩实锤）：vendored 在同一 root 上挂 keyup 监听，Arrow 分支重写选区
   * （removeAllRanges+addRange 无方向 → anchor 规范化到左端）。旧实现每按从（被规范化的）
   * range 读两端 → 自己认错固定端，锚点逐按后撤；Shift+→ 反向时块尾守卫在角色翻转态放行
   * → focus 跨块。bundle 全文无 selectionchange → 写后重申无循环风险。
   * gesture 只存固定端（移动端两按间会被 vendored 吸进公式源码，存它必失配）。 */
  let gesture = null; // {fixedNode, fixedOffset} — Shift 按住期间跨按持久
  const gestureInvalidators = () => { gesture = null; };
  root.addEventListener("compositionstart", gestureInvalidators, true);
  root.addEventListener("pointerdown", gestureInvalidators, true);
  root.addEventListener("blur", gestureInvalidators, true);
  const samePoint = (a, b, ao, bo) => a === b && ao === bo;
  root.addEventListener("keydown", event => {
    if (event.isComposing || editor.ir.composingLock) return;
    // 对抗评审 F2 加固：无 Shift 的光标键＝手势语境断裂，旧 gesture 必须失效
    // （否则跨普通键存活的 gesture 会在后续 Shift 手势的命中分支里劫持角色判定）。
    if (!event.shiftKey && (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End")) { gesture = null; return; }
    if (event.ctrlKey || event.metaKey || event.altKey || !event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const selection = getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!root.contains(selection.focusNode) || !root.contains(selection.anchorNode)) { gesture = null; return; }
    // 两端同在**一个标题块**里才管：跨块扩选、普通段、列表的扩选交回原生。
    const blockOf = node => {
      const element = elementAt(node);
      const heading = element?.closest?.("h1,h2,h3,h4,h5,h6");
      return heading && root.contains(heading) && heading !== root ? heading : null;
    };
    const heading = blockOf(selection.focusNode);
    if (!heading || blockOf(selection.anchorNode) !== heading) { gesture = null; return; }
    // 端点在**预览**里的不接管（归拖拽/patchMathCaret 语义）。
    for (const node of [selection.focusNode, selection.anchorNode]) {
      if (elementAt(node)?.closest?.(".vditor-ir__preview")) { gesture = null; return; }
    }
    const nodes = sourceNodes(heading);
    const text = nodes.map(text => text.textContent).join("");
    if (!text.length) { gesture = null; return; }
    const forward = event.key === "ArrowRight";
    // 【U-089】端角色解析：优先 gesture 匹配（方向无关——任一端==固定端即命中，移动端取
    // 另一端）；失配时按**选区形状**推导并重建 gesture：折叠光标→固定端=光标自身；
    // 非折叠选区→固定端=当前 anchor（原生语义：Shift+方向键从不翻 anchor）。
    // （旧版按方向猜端：forward→fixed=range.start——在 Shift+Home 造成的反向收缩态
    // （anchor=行尾）上把固定端错认到行首，出块守卫把角色修错后交回原生，
    // 选区塌成 [0..1] 单字——ch5 五通道复现实锤。）
    let movingNode, movingOffset, fixedNode, fixedOffset;
    let matched = false;
    if (gesture && root.contains(gesture.fixedNode)) {
      if (samePoint(range.startContainer, gesture.fixedNode, range.startOffset, gesture.fixedOffset)) {
        movingNode = range.endContainer; movingOffset = range.endOffset;
        fixedNode = range.startContainer; fixedOffset = range.startOffset;
        matched = true;
      } else if (samePoint(range.endContainer, gesture.fixedNode, range.endOffset, gesture.fixedOffset)) {
        movingNode = range.startContainer; movingOffset = range.startOffset;
        fixedNode = range.endContainer; fixedOffset = range.endOffset;
        matched = true;
      }
    }
    if (!matched) {
      if (range.collapsed) {
        // 折叠光标起手：固定端＝光标自身（两端同点，方向无歧义）。
        fixedNode = movingNode = range.startContainer;
        fixedOffset = movingOffset = range.startOffset;
      } else {
        // 既有选区上续接（Shift+Home/Shift+End 之后、或 Shift 断按再续）：固定端＝当前
        // anchor，移动端＝focus——与原生端角色完全一致，不因方向猜端而翻转。
        fixedNode = selection.anchorNode; fixedOffset = selection.anchorOffset;
        movingNode = selection.focusNode; movingOffset = selection.focusOffset;
      }
    }
    // 移动端被 vendored 吸进行内公式源码时，归一到 owner 移动方向那侧的外侧（口径见下）。
    const movingCode = elementAt(movingNode)?.closest?.('code[data-type="math-inline"]');
    if (movingCode) {
      const owner = movingCode.closest('.vditor-ir__node[data-type="inline-node"]');
      const out = owner && selectOutsidePoint(owner, forward);
      if (out) { movingNode = out.node; movingOffset = out.offset; }
    }
    // 固定端被吸进公式源码时同样归一到 owner 外侧。
    const fixedCode = elementAt(fixedNode)?.closest?.('code[data-type="math-inline"]');
    if (fixedCode) {
      const owner = fixedCode.closest('.vditor-ir__node[data-type="inline-node"]');
      const out = owner && selectOutsidePoint(owner, !forward);
      if (out) { fixedNode = out.node; fixedOffset = out.offset; }
    }
    const offset = sourceOffset(heading, movingNode, movingOffset);
    if ((!forward && offset <= 0) || (forward && offset >= text.length)) {
      // 【U-089】出块守卫：先把翻转的角色修正回 anchor=固定端（幂等、只翻角色不动端点），
      // 手势终结，再交回原生跨块扩选（Typora 通识：不钳块吞事件）。
      // 对抗评审 F4③ 括号化：显式 (a!==b || c!==d)，不靠运算符优先级侥幸。
      if (gesture && (selection.anchorNode !== fixedNode || selection.anchorOffset !== fixedOffset)) {
        try { selection.setBaseAndExtent(fixedNode, fixedOffset, selection.focusNode, selection.focusOffset); } catch { /* 端点失效则不写 */ }
      }
      gesture = null;
      return; // 块外：交回原生
    }
    const boundaries = segmenter ? [...segmenter.segment(text)].map(part => part.index)
      : [0, ...Array.from(text).map((_, i, chars) => chars.slice(0, i + 1).join("").length)];
    boundaries.push(text.length);
    const next = forward ? boundaries.find(value => value > offset) : boundaries.filter(value => value < offset).pop();
    if (next === undefined || next === offset) return;
    const [target, position] = sourcePoint(nodes, next, movingNode?.nodeType === Node.TEXT_NODE ? movingNode : null);
    event.preventDefault();
    event.stopImmediatePropagation();
    selection.setBaseAndExtent(fixedNode, fixedOffset, target, position);
    gesture = {fixedNode, fixedOffset};
    // 步进追平固定端 → 折叠光标，手势终结（评审统一案第 3 条）。
    if (samePoint(target, fixedNode, position, fixedOffset)) gesture = null;
    window.__typoraHeadingShift = {块: heading.tagName, 偏: [offset, next], 长: selection.toString().length, 手势: matched ? "命中" : "重建"};
  }, true);
  /* 【U-089】keyup 重申：本监听注册晚于 vendored 同 root 的 keyup → 同一次派发内必在其后。
   * 不变式：只翻角色、永不动端点——区间任一端==固定端且角色被翻才写；端点集变了作废不写。
   * 自动重复（连 keydown 仅末次 keyup）下终态必被本重申修正（评审场景 A 的靶）。 */
  root.addEventListener("keyup", event => {
    if (!gesture) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const selection = getSelection();
    if (!selection?.rangeCount || !root.contains(gesture.fixedNode)) { gesture = null; return; }
    const r = selection.getRangeAt(0);
    const startIsFixed = samePoint(r.startContainer, gesture.fixedNode, r.startOffset, gesture.fixedOffset);
    const endIsFixed = samePoint(r.endContainer, gesture.fixedNode, r.endOffset, gesture.fixedOffset);
    if (!startIsFixed && !endIsFixed) { gesture = null; return; } // 端点被外部改写 → 作废
    const anchorIsFixed = samePoint(selection.anchorNode, gesture.fixedNode, selection.anchorOffset, gesture.fixedOffset);
    if (anchorIsFixed) return; // 角色已正确，幂等不写
    // 角色被规范化翻转：翻回（固定端为 anchor，移动端保持现状端点）。
    const focusNode = startIsFixed ? r.endContainer : r.startContainer;
    const focusOffset = startIsFixed ? r.endOffset : r.startOffset;
    try { selection.setBaseAndExtent(gesture.fixedNode, gesture.fixedOffset, focusNode, focusOffset); } catch { /* 失效不写 */ }
    // 安全网（评审案②）：若 vendored 以非常规时序在本次派发之后又写，下一拍再复检一次（幂等）。
    const fixed = gesture.fixedNode, fixedOff = gesture.fixedOffset;
    const recheck = () => {
      if (!gesture || gesture.fixedNode !== fixed) return;
      const s2 = getSelection();
      if (!s2?.rangeCount || !root.contains(fixed)) return;
      if (s2.anchorNode === fixed && s2.anchorOffset === fixedOff) return;
      const r2 = s2.getRangeAt(0);
      const sHit = r2.startContainer === fixed && r2.startOffset === fixedOff;
      const eHit = r2.endContainer === fixed && r2.endOffset === fixedOff;
      if (!sHit && !eHit) { gesture = null; return; }
      try { s2.setBaseAndExtent(fixed, fixedOff, sHit ? r2.endContainer : r2.startContainer, sHit ? r2.endOffset : r2.startOffset); } catch { /* 失效不写 */ }
    };
    requestAnimationFrame(recheck);
    setTimeout(recheck, 0);
  });
};

/** 【U-087 2026-10-05】标题块 Shift+**鼠标**拖拽扩选接管（对抗轮修订版，B-对抗评审 §4）。
 *  病：记号收起态的标题行尾按 Shift+左键，mousedown 前后版面因 --expand 揭示 `### ` 整行
 *  右移（实测 +73px≈4 字），原生按旧版面映射按下点 ⇒ 按下瞬间凭空出现 4 字反向选区，
 *  拖回起点也收不掉（R1/R2/R4）。键盘族已由 patchHeadingShiftExtend「固定端钉死」，
 *  鼠标族此前无人管。
 *  对抗轮否决了初版（全文档接管+无条件 preventDefault+全局吞 click 会废掉段落/列表/引用
 *  的原生 Shift+单击、帧外焦点、边缘自动滚动，且把错位搬到手势后面）。本版按五处修订：
 *  ①只在**同一个 h1–h6 块内**、折叠光标起手、!defaultPrevented（先到者已认领）时接管；
 *  ②preventDefault 仅此一种形状（已展开态/纯点击/其它块一律交回原生）；③自补三件原生
 *  能力：纯 Shift+单击语义（mouseup 未移动→setBaseAndExtent(按下前锚, 按下点新版面映射)）、
 *  视口边缘自动滚动、帧外按下交焦点；④判据口径见场景 152（首帧禁反向选区；首次移动后
 *  按新版面映射；R4"在按下点抬起残留≤记号宽"为已界定固有几何，如实入档）；⑤click 吞并
 *  照 math-select-reveal.swallowClick 先例只吞一次（本补丁装在四个 root 监听之后，它们
 *  的记账型 click 先跑、不受影响；stopPropagation 只挡冒泡相的 vendored B() 链）。
 *  移动端映射用 caretRangeFromPoint 当前版面（首次移动后 --expand 已稳，映射自洽）；
 *  落点进预览/元素级位置时归一到行内公式 owner 外侧或最近文本位。 */
const patchHeadingShiftDrag = (api) => {
  const editor = api.vditor;
  const root = editor.ir.element;
  if (!root) return;
  const doc = root.ownerDocument;
  let gesture = null;   // {fixedNode, fixedOffset, x, y, moved}
  let swallowOnce = false;   // ⑤本手势的 click 只吞一次（mouseup 置位、click 消费，逐手势复位）
  const blockOf = node => {
    const heading = elementAt(node)?.closest?.("h1,h2,h3,h4,h5,h6");
    return heading && root.contains(heading) && heading !== root ? heading : null;
  };
  /** 屏幕点 → 编辑面内可用落点（文本位优先；预览/元素级归一）。 */
  const usablePoint = (x, y) => {
    let position = null;
    try { position = doc.caretRangeFromPoint(x, y); } catch { return null; }
    if (!position || !root.contains(position.startContainer)) return null;
    let node = position.startContainer, offset = position.startOffset;
    const owner = elementAt(node)?.closest?.(".vditor-ir__node[data-type='inline-node']");
    const preview = elementAt(node)?.closest?.(".vditor-ir__preview");
    if (preview && owner) {                       // 落进渲染预览：归一到 owner 外侧（按 x 选边）
      const box = owner.getBoundingClientRect();
      const out = selectOutsidePoint(owner, x > box.left + box.width / 2);
      if (out) return out;
    }
    if (node.nodeType !== Node.TEXT_NODE) {       // 元素级位置：就近进文本
      const walker = doc.createTreeWalker(node.nodeType === Node.ELEMENT_NODE ? node : root, NodeFilter.SHOW_TEXT);
      let text = walker.nextNode();
      if (text && text.length) return { node: text, offset: 0 };
      if (text) return { node: text, offset: text.length };
      return null;
    }
    return { node, offset };
  };
  root.addEventListener("mousedown", event => {
    gesture = null;
    swallowOnce = false;                          // ⑤逐手势复位残状态
    if (editor.ir.composingLock) return;
    if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.button !== 0 || event.detail !== 1) return;
    if (event.defaultPrevented) return;           // ①公式导航/选区揭示等先到者已认领
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return;
    const caret = selection.getRangeAt(0);
    const fixedHeading = blockOf(caret.startContainer);
    if (!fixedHeading) return;                    // 固定端（按下前光标）不在标题块
    if (fixedHeading.classList.contains("vditor-ir__node--expand")) return;   // ②已展开态无位移，交回原生
    const pressEl = doc.elementFromPoint(event.clientX, event.clientY);
    const pressHeading = pressEl && root.contains(pressEl) ? (pressEl.closest?.("h1,h2,h3,h4,h5,h6") || null) : null;
    if (!pressHeading || pressHeading !== fixedHeading) return;   // ①按下点也须在同一标题块内
    gesture = { fixedNode: caret.startContainer, fixedOffset: caret.startOffset,
      x: event.clientX, y: event.clientY, moved: false, swallow: false };
    event.preventDefault();                       // ②仅此一种形状
    if (!root.contains(doc.activeElement)) {      // ③(c) 帧外按下：把焦点交给编辑面
      try { root.focus({ preventScroll: true }); } catch { /* 不可聚焦环境交回原生也已于事无补 */ }
    }
  }, true);
  const autoScroll = y => {                       // ③(b) 边缘自动滚动（preventDefault 后原生没有）
    const box = root.getBoundingClientRect();
    const edge = 36;
    if (y < box.top + edge) root.scrollTop -= 12;
    else if (y > box.bottom - edge) root.scrollTop += 12;
  };
  const onMove = event => {
    if (!gesture || !(event.buttons & 1)) return;
    gesture.moved = true;
    autoScroll(event.clientY);
    const point = usablePoint(event.clientX, event.clientY);
    if (!point) return;
    try { getSelection().setBaseAndExtent(gesture.fixedNode, gesture.fixedOffset, point.node, point.offset); } catch { /* 失联则交回 */ }
    window.__typoraHeadingShiftDrag = { 长: getSelection().toString().length, 移: [Math.round(event.clientX), Math.round(event.clientY)] };
  };
  const onUp = event => {
    if (!gesture) return;
    const current = gesture; gesture = null;
    if (!current.moved) {                         // ③(a) 纯 Shift+单击：复刻原生扩选语义
      const point = usablePoint(current.x, current.y);
      if (point) { try { getSelection().setBaseAndExtent(current.fixedNode, current.fixedOffset, point.node, point.offset); } catch { /* 交回 */ } }
    }
    swallowOnce = true;                           // ⑤紧随 mouseup 的这一发 click 停止冒泡（一次）
  };
  const onClick = event => {                      // ⑤装在四个 root 监听之后：记账型 click（math-source-map 等）已先跑；
    if (swallowOnce) {                            // 只挡冒泡相的 vendored B() 重放，不吃任何捕获层
      swallowOnce = false;
      event.stopPropagation();
    }
  };
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mouseup", onUp, true);
  root.addEventListener("click", onClick, true);
  return () => {
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    root.removeEventListener("click", onClick, true);
  };
};

/** 点块公式四周的空白带：把"公式之前/之后"的插入点落到**看得见的正文**上。
 *
 *  背景：`math-edit.js` 的 `fenceClick`→`blankLanding` 把"贴着折叠块公式的空白留白"翻成
 *  "这条公式之前/之后"的插入点——这个语义本身有来历（见那里的注释：按几何翻进源码会让
 *  "点文档首块公式上方 4px + 一次退格"吃掉公式源码）。但那个插入点是**元素级位置**，
 *  Chromium 给不出 caret 矩形：用户看到的就是"点了一下，光标没了"（2026-09-19 实测，
 *  scripts/acceptance/probe-repro-collapsedstrip.cjs：源码条上沿/中段、块内右侧空白三处点击全是这个读数）。
 *
 *  用户口径（2026-09-19）："落到最近的可见正文位置（上一行行尾 / 下一行行首）"——
 *  语义不变（还是公式之前/之后），只是把落点换成邻块里那段**画得出来**的正文
 *  （复用 `blockEdgeText`，与"← 在块首去上一行行尾"同一条路）。
 *
 *  只认这一种形状：单次左键、无修饰键、按下与抬起基本没动、落点**隐形**、
 *  且点在一条**折叠**块公式盒子（上下各放宽 10px，与 `blankLanding` 同口径）里。
 *  **同侧没有正文就什么都不做**：文档首块公式上方那条页边距因此在原处（场景 84 的 B 段与
 *  场景 75 的"首块公式上方点一下 + 退格"都钉着它——那两处靠的就是"落点不在源码里"）。 */
const patchBlankBandClick = (api) => {
  const editor = api.vditor;
  const root = editor.ir.element;
  if (!root) return;
  const doc = root.ownerDocument;
  const 隐形 = () => {
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !selection.focusNode) return false;
    const probe = doc.createRange();
    probe.setStart(selection.focusNode, selection.focusOffset);
    probe.collapse(true);
    const rect = probe.getBoundingClientRect ? probe.getBoundingClientRect() : null;
    return !(rect && rect.height);
  };
  /** 点在一条折叠块公式的空白带里吗（返回那条公式节点）。 */
  const 空白带 = (x, y) => {
    for (const node of root.querySelectorAll('.vditor-ir__node[data-type="math-block"]')) {
      if (node.classList.contains("vditor-ir__node--expand")) continue;      // 展开态：源码看得见，点哪儿是哪儿
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      if (y >= box.top - 10 && y <= box.bottom + 10 && x >= box.left - 10 && x <= box.right + 10) return {node, box};
    }
    return null;
  };
  /** 下一个/上一个块元素（跳过 WBR/BR 与空白文本节点）。 */
  const 邻块 = (node, forward) => {
    let sibling = forward ? node.nextSibling : node.previousSibling;
    while (sibling && (sibling.nodeType === 3 || /^(WBR|BR)$/.test(sibling.tagName || ""))) {
      sibling = forward ? sibling.nextSibling : sibling.previousSibling;
    }
    return sibling && sibling.nodeType === 1 ? sibling : null;
  };
  /** 朝着点击方向找**最近的可见正文**：邻块里没有就继续往前走（最多 4 块）。
   *
   *  为什么要"继续走"：邻块可能就是"整行只有一条行内公式"那种块（doc A 的 `$a$` 行就是）。
   *  把光标放进那种块的源码看起来顺理成章，但**只有展开之后才看得见**——实测
   *  （probe-repro-a03.cjs）程序化落进去不会让它展开，节点一直折叠、光标一直 0×0；
   *  更要命的是那种位置上打字会**无声写进公式源码**（用户 2026-09-16 报过同类）。
   *  所以干脆跳过它，落到下一个真有正文的块的行首（"最近的可见正文位置"）。 */
  const 找可见正文 = (node, forward) => {
    let cur = node;
    for (let 步 = 0; 步 < 4; 步++) {
      const 点 = blockEdgeText(cur, forward);
      if (点) return 点;
      cur = 邻块(cur, forward);
      if (!cur) return null;
    }
    return null;
  };
  let 按下 = null;
  // **挂在 document 的捕获阶段**：math-edit 的 fenceClick 也在捕获阶段，但挂在编辑面上，
  // 它处理"贴着折叠块公式的空白点击"时会 stopImmediatePropagation——挂在编辑面上会被它吃掉
  // （实测：校正一次都没跑，`__typoraBlankBand` 恒为 null）。document 在祖先层，先到。
  doc.addEventListener("mousedown", event => {
    按下 = event.button === 0 && event.detail <= 1 && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
      ? {x: event.clientX, y: event.clientY} : null;
  }, true);
  doc.addEventListener("mouseup", event => {
    const 点 = 按下;
    按下 = null;
    if (!点) return;
    if (Math.abs(event.clientX - 点.x) > 3 || Math.abs(event.clientY - 点.y) > 3) return;   // 拖拽，不接管
    const 拍 = () => {
      if (!root.isConnected || !隐形()) return;
      if (!doc.elementFromPoint || !root.contains(doc.elementFromPoint(点.x, 点.y))) return;   // 点在浮层上（查找面板等）：不接管
      const band = 空白带(点.x, 点.y);
      if (!band) return;
      // 点在公式上半 → "公式之前" → 上一块的末尾；下半 → "公式之后" → 下一块的开头。
      // **同侧没有正文就不动**（文档首块公式上方那条页边距就属于这种，见函数头注释）。
      const forward = 点.y > band.box.top + band.box.height / 2;
      const 落点 = 找可见正文(band.node, forward);
      if (!落点) return;
      const range = doc.createRange();
      range.setStart(落点.node, 落点.offset);
      range.collapse(true);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      window.__typoraBlankBand = {点: [Math.round(点.x), Math.round(点.y)], 方向: forward ? '之后' : '之前',
        落: String(落点.node.data || "").slice(-12)};
    };
    requestAnimationFrame(拍);
    setTimeout(拍, 0);
  }, true);
};

/** 编辑行内公式时，渲染浮框**只在会盖住正文的时候翻到源码上方**。
 *
 *  背景：展开态的 `.vditor-ir__preview` 是绝对定位浮层（CSS 锚点钉在源码下方左侧），它不占位置，
 *  于是默认会压住下面那一行——而下面那一行正是**光标之后的续行**（2026-09-19 用户截图：
 *  浮框压着"…则公共套有…"那句的开头）。
 *
 *  用户口径（2026-09-19）："只在会遮住正文时翻到源码上方"。判定按几何——
 *  用**正文文本节点的字形矩形**与浮框矩形求交（围栏、公式源码、预览自己的字形都不算正文）；
 *  会相交就挂 `typora-preview-above`（CSS 把 `top` 换成 `bottom: anchor(源码 top)`）。
 *  翻上去之后若顶出编辑面（会被裁掉，比盖字更糟）就保持原样。
 *  表格里是静态流式（`position: static`，占位、把单元格撑高），不参与这套。
 *
 *  量"默认那一版"必须先摘掉类再量（几何会变），所以每次只在选择/输入变化后按 rAF 跑一遍，
 *  且只处理**展开中的**行内公式（通常 0–1 条）。 */
const patchPreviewFlip = (api) => {
  const editor = api.vditor;
  const root = editor.ir.element;
  if (!root) return;
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const UP = "typora-preview-above";
  /** 浮框矩形里有没有正文的字形（只扫公式所在块与它的下一个块，够覆盖浮框可能伸出的范围）。 */
  const 盖住正文 = (box, node) => {
    const 扫 = host => {
      if (!host) return false;
      const walker = doc.createTreeWalker(host, NodeFilter.SHOW_TEXT, {acceptNode: text => {
        if (!text.data || !text.data.trim()) return NodeFilter.FILTER_REJECT;
        const at = text.parentElement;
        if (at?.closest?.(PREVIEW) || at?.closest?.("code[data-type]") ||
            at?.closest?.(".vditor-ir__marker,[data-type$='-marker']")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }});
      let text;
      while ((text = walker.nextNode())) {
        const range = doc.createRange();
        range.selectNodeContents(text);
        for (const rect of range.getClientRects()) {
          if (rect.width < 1 || rect.height < 1) continue;
          if (rect.right - box.left > 2 && box.right - rect.left > 2
            && rect.bottom - box.top > 2 && box.bottom - rect.top > 2) return true;
        }
      }
      return false;
    };
    const 块 = node.closest?.("p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th") || node.parentElement;
    let next = 块?.nextElementSibling;
    while (next && /^(WBR|BR)$/.test(next.tagName)) next = next.nextElementSibling;
    return 扫(块) || 扫(next);
  };
  const 更新 = () => {
    if (!root.isConnected) return;
    for (const node of root.querySelectorAll('.vditor-ir__node--expand[data-type="inline-node"]')) {
      const pre = node.querySelector(":scope > .vditor-ir__preview");
      const src = node.querySelector(":scope > code[data-type]");
      if (!pre || !src) continue;
      if (view.getComputedStyle(pre).position !== "absolute") { node.classList.remove(UP); continue; }
      // **算术重建"默认（下方）"那一版的框**，不靠"摘掉类再量"——
      // 摘类会真的改 DOM（浮动盒当场跳一下），一旦这段在连续几拍里跑，用户看到的就是**高频闪烁**。
      // 翻不翻只改 top：宽度/高度/左边都取自当前这一版的 `pre` 矩形；默认那一版的 top = 源码下沿 + 4，
      // 翻上去那一版的 top = 源码上沿 − 4（与场景 92 的断言口径一致）。
      const 自身 = pre.getBoundingClientRect();
      const 源码框 = src.getBoundingClientRect();
      if (!自身.width || !自身.height || !源码框.width) { if (node.classList.contains(UP)) node.classList.remove(UP); continue; }
      const 默认框 = {left: 自身.left, right: 自身.right, top: 源码框.bottom + 4, bottom: 源码框.bottom + 4 + 自身.height};
      const 放得下 = 源码框.top - 4 - 自身.height > root.getBoundingClientRect().top + 2;
      const 该翻 = 放得下 && 盖住正文(默认框, node);
      const box = 默认框;
      node.classList.toggle(UP, 该翻);      // 同值不产生 DOM 变更；需要翻才写
      if (该翻 && !放得下 && !原样) window.__typoraPreviewFlip = {结果: "想翻但上面放不下", 框高: Math.round(box.height)};
      else if (该翻 && 放得下) window.__typoraPreviewFlip = {结果: "翻到上方", 框高: Math.round(box.height)};
    }
  };
  const 排 = () => { requestAnimationFrame(更新); };
  doc.addEventListener("selectionchange", 排, true);
  view.addEventListener("keyup", () => { 排(); setTimeout(更新, 0); }, true);
  view.addEventListener("mouseup", () => { 排(); setTimeout(更新, 0); }, true);
  view.addEventListener("input", 排, true);
  排();
};

/** 【双重光标取消 · 轮2，2026-10-02】通用合成光标补丁 patchSyntheticCaret 已在此整删
 *  （函数体约 217 行 + 安装行 + 画/收日记与计数埋点 + 运行时注入的
 *  typora-caret-blink keyframes）。当初引入理由（pitfalls §31 三类"画不出"）已被真屏连拍
 *  全部证伪：元素级边界与空段落位原生 caret 都画（矩形 0×0 只是尺子撒谎；空段落位证据
 *  r15/out/n-u1 八帧连拍四帧亮=闪烁，期间合成计数恒 0）。删除后光标只余 Blink 原生一根。
 *  判据遗产：版面有行盒()（patchHomeEndCaret 内）沿用同口径判"原生画得出"；133/134/137
 *  场景的"合成===0"断言保留作金丝雀，防任何画线补丁将来回潮。 */

import {installOutlineLayout} from './outline-layout.js';


import {afterPaint} from './warmup.js';

/** 工具栏的**悬停菜单**（编辑模式 / 标题 / 表情…）只会被"再触发一次同一个按钮"或"触发另一个
 *  按钮"收起——指针移开不动它（Vditor `index.min.js` 里那段 `g()`：开是 `style.display='block'`，
 *  合的路径只有 `'block' === t.style.display ? t.style.display='none'` 这一支）。实测
 *  （scripts/acceptance/probe-toolbar-tip-linger.cjs，2.1.24）：指针从按钮上扫过就会留下一个菜单
 *  压在正文上，移到正文里等 2 秒还在，按 Esc 也不收。用户报的就是这个（GitHub issue #1：
 *  「悬浮控件会持续停留，没有及时消失完成悬浮控件展示的切换」，截图里菜单正盖在正文上）。
 *
 *  补两条收起的路（都只是把 Vditor 自己那套 `style.display='none'` 用在同样的元素上）：
 *   · 指针离开整个工具栏（含浮层自己：浮层是工具栏项的子节点，指针进菜单不算离开）→ 收悬停菜单；
 *   · 在工具栏与浮层之外按下鼠标 → 连点开的浮层（表情/预览等）一起收。
 *  悬停菜单和点开的浮层分开对待：表情面板是**点**开的，用户在菜单上找东西时把指针挪开不该被收掉。
 *  同一个按钮再点一次、点别的按钮这些原有路径一概不动。 */
const patchToolbarMenus = (api) => {
  const toolbar = api.vditor?.toolbar?.element;
  if (!toolbar) return;
  const HOVER = '.vditor-hint';
  const PANELS = '.vditor-panel, .vditor-emojis';
  const close = selector => {
    const open = [...toolbar.querySelectorAll(selector)].filter(node => node.style.display === 'block');
    for (const node of open) node.style.display = 'none';
    if (open.length) window.__typoraToolbarMenusClosed = (window.__typoraToolbarMenusClosed || 0) + open.length;
    return open.length;
  };
  toolbar.addEventListener('mouseleave', () => close(HOVER));
  // 捕获阶段：Vditor 自己的按钮处理在气泡阶段，这里只处理"点在工具栏之外"的那一下。
  toolbar.ownerDocument.addEventListener('mousedown', event => {
    if (!toolbar.contains(event.target)) close(HOVER + ', ' + PANELS);
  }, true);
  // 【FC6】键盘缺口（GitHub issue #1 残留）：表情这类**点开**的面板此前只有"再点
  // 一次同一个按钮 / 点外面"两条收起路，Esc 收不了。挂编辑器 window 的捕获阶段把
  // HOVER+PANELS 一起收。注册顺序天然排在 find-replace 之后（applyTyporaPatches 里
  // installFindReplace 先于本函数调用）：同一 window 同阶段的监听按注册序执行，
  // 查找框开着时它先吃掉 Esc（preventDefault + stopImmediatePropagation），这里收
  // 不到——用户按 Esc 的顺序仍是"先关查找框、再关面板"；面板独立在场时才由这里收。
  // 只在真的关掉了东西时才拦事件，无面板可收的 Esc 原样放行（IME 组字中的 Esc
  // 是取消组字，也不碰）。
  toolbar.ownerDocument.defaultView?.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
    if (close(HOVER + ', ' + PANELS)) { event.preventDefault(); event.stopPropagation(); }
  }, true);
};

export const applyTyporaPatches = (api) => {
  const editor = api.vditor;
  if (editor.__typoraPatched) return;
  editor.__typoraPatched = true;
  const root = editor.ir.element;
  const performance = installIncrementalIR(api);
  protectPreviews(root);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (elementAt(record.target)?.closest(PREVIEW)) continue;
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) protectPreviews(node);
      }
    }
  });
  observer.observe(root, {childList: true, subtree: true});
  const flush = patchHistory(api);
  api.__typoraFlushIR = flush;
  const removeShortcuts = installEditorShortcuts(api, flush);
  const removeMathEditing = installMathEditing(api);
  const removeSplitNavigation = installSplitNavigation(api);
  const removeUnderlines = installUnderlines(api);
  const removeFind = installFindReplace(api, flush);
  const removeOutlineLayout = installOutlineLayout(api);
  const removeLargeDocGuard = installLargeDocGuard(api);
  // 源码缓存首建（实测 855ms，占打开长任务约四分之一）不影响任何一次编辑的正确性：
  // getMarkdown 自己会补齐缺失分组。放到首屏之后按分片预热，读者先看到文档。
  // 排在 large-doc 之后：CV 是唯一能让后续每一步几何都变便宜的东西，先给它。
  afterPaint('markdown-prime', budget => performance.prime(budget));
  const removeReadingMode = installReadingMode(api);
  const removeInputPreviewGuards = [
    installInputPreviewGuard(api, root),
    // WYSIWYG pairs its previews with source codes the same way; typing near
    // a formula there must not flash it back to source either.
    installInputPreviewGuard(api, editor.wysiwyg.element, '.vditor-wysiwyg__preview'),
  ];
  patchClipboardShortcuts(api);
  patchToolbarMenus(api);
  patchHeadingEnter(api, flush);
  patchEmptyHeadingMerge(api, flush);
  patchListTabIndent(api, flush);
  patchSoftBreak(api, flush);
  patchMathCaret(api);
  patchVerticalMathLine(api);
  if (globalThis.localStorage?.getItem('caretWatchdog') !== 'off') patchCaretWatchdog(api);   // 单变量开关（探针 A/B 用）
  const removeCaretCollapseWitness = patchCaretCollapseWitness(api);   // 【R10-P8】光标消失观测证人（log-only）
  patchHomeEndCaret(api);
  patchClickIntoFormulaSource(api);
  patchBlankBandClick(api);
  patchHorizontalMathLine(api);
  patchHeadingShiftExtend(api);
/** 点**已渲染的行内公式**：源码展开之后，光标要落在**你点的那一个字**上。
 *
 *  实测（scripts/acceptance/probe-repro-dupcaret.cjs，doc A 的 `$33-1=32，33+8-1=40$`）：
 *  点公式盒子里时 Vditor 会把节点展开（源码可见），但落点是 `code[data-type="math-inline"]` 的
 *  **元素级**位置——矩形 0×0、偏移永远是 0 或源码长度，**跟点击的横坐标无关**：点正中（x=738）
 *  也跳到源码第 14 个字符而不是第 8 个；点左缘内 2px 落在 offset 0。用户 2026-09-21 报的
 *  "点击已经渲染好的 inline math 区域还是无法做到展开源码后精确定位"就是这条。
 *
 *  修法（事后校正，与其余点击补丁同形）：点击点落在某个**已展开**的行内公式盒子里、
 *  而光标**没有**落进它的源码文本时——先按点击点重新解一次（展开后源码是真实文本，命中测试准），
 *  解不到就按源码每个字符的行盒扫一遍，取离点击横坐标最近的那个字符边界。
 *  只认单次左键、无修饰键、按下抬起基本没动；点公式盒子**之外**、或光标本来就在源码文本里，一律不碰。 */
const patchInlineMathClickPosition = (api) => {
  const editor = api.vditor;
  const root = editor.ir.element;
  if (!root) return;
  const doc = root.ownerDocument;
  /** 公式的**里侧区间**（左右边界），按"点落在哪一行"算：
   *   · 点在围栏**自己那一行**上 → 边界取围栏盒的中线（用户 2026-10-01 口径：闭 `$` 的右半
   *     算公式外面、开 `$` 的左半也算外面）；
   *   · 否则 → 边界取**该行内容**的左右缘。
   *
   *  为什么要分行：**跨行的行内公式，围栏和源码不在一行**——实测那条长公式（场景 92 的
   *  LONG_FORMULA）展开后，开 `$` 落在上一行行尾（x≈613）、闭 `$` 落在下一行行首（x≈50），
   *  拿两个中线当里侧区间会把它压成 1px 宽，于是**点源码正中都被判成"点公式外面"**、
   *  光标被钳出去、展开态当场折起来（92 的 H2 就是这么红的）。折叠态围栏没有像素（宽 0），
   *  边界自然退回渲染结果里该行片段的左右缘——与旧行为一致。 */
  const 公式边界 = (node, box, y) => {
    const 标 = [...(node.children || [])].filter(子 => 子.nodeName === 'SPAN'
      && 子.classList && 子.classList.contains('vditor-ir__marker'));
    const 有框 = el => { const b = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      return b && b.width > 0 ? b : null; };
    const 在行上 = b => !!(b && y >= b.top - 2 && y <= b.bottom + 2);
    // 这一行的内容盒：展开态看源码（`code`），折叠态看渲染结果（`preview`），各取一个含 y 的片段
    const 行 = (() => {
      const rects = [];
      for (const el of [node.querySelector?.('code[data-type]'), node.querySelector?.('.vditor-ir__preview')]) {
        if (!el || !el.getClientRects) continue;
        for (const r of el.getClientRects()) if (r.width > 0 && r.height > 0) rects.push(r);
      }
      let best = null;
      for (const r of rects) if (在行上(r) && (!best || r.width > best.width)) best = r;
      // 【U-095 对抗A】行间带（y 不在任何分片行 ±2px 内）：边**不再**退化为并集盒左右缘
      //（那会把行间正文的横向整段划成公式地盘、劫持正文点击）——改取**离 y 最近分片行**
      // 的跨度；x 不压任何分片行的点击会在 框内 判定落空 → 走 ① 正文语义。
      if (!best) {
        let nearest = null, nd = Infinity;
        for (const r of rects) {
          const d = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
          if (d < nd) { nd = d; nearest = r; }
        }
        best = nearest;
      }
      return best;
    })();
    const 开 = 标.length ? 有框(标[0]) : null;
    const 闭 = 标.length > 1 ? 有框(标[标.length - 1]) : null;
    const 左 = 在行上(开) ? 开.left + 开.width / 2 : (行 ? 行.left : box.left);
    const 右 = 在行上(闭) ? 闭.left + 闭.width / 2 : (行 ? 行.right : box.right);
    return {左, 右: Math.max(右, 左 + 1)};
  };
  /** 落点这一行上所有**行内公式节点**的盒子（按垂直重叠取，按下那一刻量）+ 里侧区间。
   *
   *  为什么不用命中元素判"点在不在公式里"：渲染结果挂了 `contenteditable=false`
   *  （protectPreviews），Blink 命中测试**跳过**它，公式右缘之外的点也可能命中它下面那个
   *  `code`（2026-10-01 实测：右缘 +12px 仍被解成"源码末尾"）。几何说话，命中的元素让路。 */
  const 这一行的公式 = (x, y) => {
    const out = [];
    for (const node of root.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')) {
      const box = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
      if (!box || !box.height || !box.width) continue;
      const 预览 = node.querySelector?.('.vditor-ir__preview');
      const 预览盒 = 预览?.getBoundingClientRect ? 预览.getBoundingClientRect() : null;
      // 浮框（展开态那个贴在源码上/下方的预渲染框）算**公式自己的地盘**：按在它上面不是"点公式外面"。
      // 实测（场景 92 H1/H2）：浮框挂在长公式源码上方，纵向落在多行 owner 框的并集里，横向也压着边界——
      // 不收这条例外就会把"按浮框"判成门外点击，把光标钳出公式、顺手把展开态折起来（H1 当场变红）。
      const 浮框内 = !!(预览盒 && 预览盒.width > 0 && x >= 预览盒.left && x <= 预览盒.right
        && y >= 预览盒.top && y <= 预览盒.bottom);
      if (!浮框内 && (y < box.top - 2 || y > box.bottom + 2)) continue;
      out.push({node, box, 边: 公式边界(node, box, y), 浮框: 浮框内});
    }
    return out;
  };
  let 按下 = null;
  let 已钳 = false;                                              // 这一次手势已经钳过（见 拍 里的 ①）
  doc.addEventListener("mousedown", event => {
    已钳 = false;
    // 只有当次点击落在**编辑面里**才去量公式盒子（`querySelectorAll` + 逐个 getBoundingClientRect
    // 会强制一次排版）：点工具栏、浮层、状态栏这些地方一律不量。
    按下 = event.button === 0 && event.detail <= 1 && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
      && root.contains(event.target)
      ? {x: event.clientX, y: event.clientY, 公式: 这一行的公式(event.clientX, event.clientY)} : null;
  }, true);
  doc.addEventListener("mouseup", event => {
    const 点 = 按下;
    按下 = null;
    if (!点) return;
    if (Math.abs(event.clientX - 点.x) > 3 || Math.abs(event.clientY - 点.y) > 3) return;   // 拖拽不接管
    const 拍 = () => {
      if (!root.isConnected) return;
      // ① **点在公式盒子外面**（按下那一刻的几何）→ 光标只许在公式外面：
      //    Blink 会把"公式右缘之外的点"解进源码（渲染层 contenteditable=false，命中被跳过），
      //    用户 2026-10-01 报的就是这条（点右 `$` 之后那一带，光标插进源码）。钳到公式外侧
      //    第一个正常文本位置——与 ←/→ 走出公式同一条路（selectOutside，见它的注释）。
      //    **边界是围栏盒的中线**：围栏外侧那一半本来就该算"公式外面"（用户第二轮更正的口径）。
      //    `已钳` 是**这次手势**的闸门：拍要跑两趟（rAF + 60ms），第二趟时节点已经因为
      //    光标离开而收起、几何变回折叠态（盒子更长），光凭几何会误判成"点在盒子里"，
      //    于是 ② 又把光标搬回源码（实测就是这个走势）。钳过就不再让 ② 插手。
      const 框内 = 点.公式.find(f => f.浮框)                       // 【U-095 对抗C】浮框匹配优先
        || 点.公式.find(f => 点.x >= f.边.左 && 点.x <= f.边.右);
      if (!框内 && 点.公式.length > 0) {
        if (已钳) return;
        const selection = getSelection();
        const at = selection?.focusNode ? elementAt(selection.focusNode) : null;
        // 光标**落在公式节点里**就算"被解进去了"——不一定在源码 `code` 里：围栏外侧那一半上
        // 实测落点是节点内的零宽哨兵文本（`层` 看着像"正文"，其实还在节点里，接着打字会写进公式）。
        const owner = at?.closest?.('.vditor-ir__node[data-type="inline-node"]');
        if (!owner) return;                                      // 光标没在公式节点里：本来就在外面，不碰
        const 框 = owner.getBoundingClientRect();
        // 【A2 2026-10-02】判侧改用**点击那一行的行边界**（按下那一刻 公式边界 量好的 边.左/右），
        // 不能用 owner 并集盒的中线：折行公式的并集盒横跨多行，首行缩进深、末行只到中部——
        // 点末行闭 `$` 右侧时点击 x 仍在并集盒**中线左侧**，旧判法把光标塞回"公式前"；点首行
        // 开 `$` 左半则可能落在中线右侧被判成"公式后"。行边界才是"这一行上公式占哪一段"，
        // 快照里找不到（理论上不会）才退回旧的并集盒中线。
        const 条 = 点.公式.find(f => f.node === owner);
        const 在后 = 条 ? 点.x > 条.边.右 : 点.x > 框.left + 框.width / 2;
        selectOutside(owner, 在后);
        已钳 = true;
        window.__typoraInlineMathOutside = {点: [Math.round(点.x), Math.round(点.y)],
          落: 在后 ? "公式后" : "公式前", 判据: 条 ? "行边界" : "并集盒中线"};
        return;
      }
      // ② 点在公式盒子里（含围栏、含渲染字形）：展开 + 按像素精确定位（原来的路）
      const hit = doc.elementFromPoint ? doc.elementFromPoint(点.x, 点.y) : null;
      if (!hit || !root.contains(hit)) return;                        // 点在浮层上：不接管
      let owner = hit.closest?.('.vditor-ir__node[data-type="inline-node"]');
      // 【U-095】折行公式的并集盒空洞：几何判定（框内）已命中公式，但 elementFromPoint
      // 解到的是两行分片之间的正文 P（渲染层 contenteditable=false 被 Blink 命中测试跳过，
      // 空洞处下层就是正文）。此时接管给几何命中的那条公式——空洞带（分片行间 + 分片段
      // ±2px 容差带）本来就在公式自己盒内，用户点的是"公式那一带"，展开才是意图；
      // 真正文点击（框外/分片行上分片跨度之外）走不到这里（①已拦截），无劫持风险。
      if (!owner && 框内) { owner = 框内.node; window.__typoraInlineMathHollow = {点: [Math.round(点.x), Math.round(点.y)]}; }
      if (!owner) return;
      // 没展开（点的是渲染出来的公式）→ 先把源码展开再落点：用户要的就是"点一下公式，源码出来、光标在点上"。
      // 展开用的就是 Vditor 自己那个类名（IR 模式下它的展开状态就存在这个类上），类挂上后源码是真实可见文本。
      const 本来展开 = owner.classList.contains("vditor-ir__node--expand");
      if (!本来展开) owner.classList.add("vditor-ir__node--expand");
      const code = owner.querySelector(':scope > code[data-type="math-inline"]');
      const text = code && code.firstChild && code.firstChild.nodeType === Node.TEXT_NODE ? code.firstChild : null;
      if (!text || !text.length) return;
      // 光标已经落在源码**文本**里：让路，别动。
      // 【2026-09-23 试过"核对后再让路"，当场被场景 83 打回】：点渲染字形时映射算出来的
      // 偏移（如 2）与"展开之后同一个像素落在源码哪一格"（如 4）**本来就不是一回事**——
      // 展开会让源码占住原来渲染结果的版面，同一个点上已经不是同一个字符了。核对等于用
      // 一把错尺子重排，实测把沿公式从左点到右的光标序列打乱（[2]→4、[5..6]→8、缝→9）。
      // 让路才是对的：这条公式的落点权威是 math-source-map 的 **渲染像素映射**。
      const selection = getSelection();
      if (selection?.focusNode === text) return;
      const 落 = (node, offset) => {
        const range = doc.createRange();
        range.setStart(node, offset);
        range.collapse(true);
        const probe = range.cloneRange();
        const box = probe.getBoundingClientRect ? probe.getBoundingClientRect() : null;
        if (!box || !box.height) return false;
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      };
      // ① 展开后源码是真实文本：先按点击点重新命中一次
      const 再解 = doc.caretRangeFromPoint ? doc.caretRangeFromPoint(点.x, 点.y) : null;
      if (再解 && 再解.startContainer === text
        && 落(text, Math.min(Math.max(再解.startOffset, 0), text.length))) {
        window.__typoraInlineMathClick = {路径: "重解", 偏移: 再解.startOffset, 本来展开}; return;
      }
      // ② 兜底：扫源码每个字符的行盒，取离点击横坐标最近的字符边界（源码通常几十字符，够快）
      // 【U-095】折行公式展开后的源码也折行：就近比较加纵向罚项——与点击 y 不同行的字符
      // 距离 +1000，避免"同 x 两条源码行抢光标"落错行；全部字符都不在点击行附近时（如
      // 行间带点击）罚项全体平等，退化回纯横向就近（旧行为）。
      const 上限 = Math.min(text.length, 400);
      // 【U-095 对抗B】源码折行时字符盒横向不再单调（第二行起点可能比第一行更近），
      // 提前 break 会把光标塌到源码开头——折行态禁用，全量扫（≤400 字符，毫秒级）。
      const 源码折行 = !!(code.getClientRects && code.getClientRects().length > 1);
      let 最佳偏移 = 0, 最佳距离 = Infinity;
      for (let i = 0; i < 上限; i++) {
        const range = doc.createRange();
        range.setStart(text, i);
        range.setEnd(text, i + 1);
        const box = range.getBoundingClientRect ? range.getBoundingClientRect() : null;
        if (!box || !box.width) continue;
        const 纵外 = 点.y < box.top - 4 || 点.y > box.bottom + 4 ? 1000 : 0;
        const 边界 = [box.left, box.right];
        for (let k = 0; k < 2; k++) {
          const 距离 = Math.abs(点.x - 边界[k]) + 纵外;
          if (距离 < 最佳距离) { 最佳距离 = 距离; 最佳偏移 = i + k; }
        }
        if (!源码折行 && 点.x < box.left && box.left - 点.x > 400) break;      // 单行源码：越过很远别再扫
      }
      if (落(text, 最佳偏移)) window.__typoraInlineMathClick = {路径: "就近", 偏移: 最佳偏移, 本来展开};
    };
    requestAnimationFrame(拍);
    setTimeout(拍, 60);
  }, true);
  /** 【D2】drop 通道：拖放文本松手落在行内公式**闭 $ 中线右半带**（外半带）——Blink 的命中测试
   *  跳过 contenteditable=false 的渲染层，把这一带的落点解进公式源码，拖过来的字被当成源码插进
   *  公式里。与上面 ① 的点击钳位同一条边界口径（右 $ 中线之右＝公式外，见 公式边界 的注释）：
   *  这里在 drop 上 preventDefault，按 selectOutside 同口径把拖放文本插到**公式外**。
   *  点在公式本体（源码/渲染字形）上的 drop 不碰，照旧进源码；折叠态围栏没有像素，无从触发。 */
  doc.addEventListener("drop", event => {
    if (!root.isConnected || !event.dataTransfer) return;
    const text = event.dataTransfer.getData("text/plain");
    if (!text) return;                                    // 没有纯文本载荷（拖图等）：不接管
    const x = event.clientX, y = event.clientY;
    for (const node of root.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')) {
      const 标 = [...(node.children || [])].filter(子 => 子.nodeName === 'SPAN'
        && 子.classList && 子.classList.contains('vditor-ir__marker'));
      if (标.length < 2) continue;
      const 闭 = 标[标.length - 1].getBoundingClientRect();
      if (!闭.width || y < 闭.top - 2 || y > 闭.bottom + 2) continue;   // 不在闭 $ 自己那一行
      if (x < 闭.left + 闭.width / 2 || x > 闭.right + 2) continue;     // 只认中线右半带（外半带）
      event.preventDefault();
      const 点 = selectOutsidePoint(node, true);
      if (!点) return;
      selectPoint(点.node, 点.offset);
      doc.execCommand("insertText", false, text);          // 走编辑输入通道：撤销栈/IR 重排照常工作
      window.__typoraDropOutside = {点: [Math.round(x), Math.round(y)], 插入: text.slice(0, 24)};
      return;
    }
  }, true);
};

  patchInlineMathClickPosition(api);
  patchPreviewFlip(api);
  installMathSourceNavigation(root);
  const removeLineEndCaret = installLineEndCaret(root);
  const removeMathSelectionReveal = installMathSelectionReveal(root);
  const removeMarkerCaretGuard = installMarkerCaretGuard(root);
  installFastTypeGate(api);   // R13-S1：纯文本键 At-only 快道（捕获监听须晚于上面全部 root 监听注册）
  const removeHeadingShiftDrag = patchHeadingShiftDrag(api);   // U-087：装在四个 root 监听之后（见其头注⑤）
  const destroy = api.destroy;
  api.destroy = function (...args) {
    flush.dispose();
    observer.disconnect();
    removeShortcuts();
    removeMathEditing();
    removeSplitNavigation();
    removeUnderlines();
    removeFind();
    removeOutlineLayout();
    removeLargeDocGuard();
    removeReadingMode();
    removeInputPreviewGuards.forEach(remove => remove());
    removeLineEndCaret();
    removeMathSelectionReveal();
    removeMarkerCaretGuard();
    removeHeadingShiftDrag();
    removeCaretCollapseWitness();
    performance.destroy();
    return destroy.apply(this, args);
  };
};
