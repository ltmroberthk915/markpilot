// 列表语义三件套 + 复选框投影（CM6 文本级实现——宪法第一条：操作是文本编辑，无 DOM 结构魔法）
//
// - Enter：列表项内回车 → 续出同缩进 bullet（有序自动 +1；空项回车 → 退出列表）
// - Tab / Shift-Tab：列表项缩进/反缩进（两空位）
// - 复选框：`- [ ]` / `- [x]` 的 `[ ]` 段投影为可点 widget（viewport 范式，仅视口行建装饰；
//   点击即翻源码——F7 同款纯视觉投影；光标进入该段时还原源码）。

import { EditorSelection, Prec } from "@codemirror/state";
import { EditorView, ViewPlugin, Decoration, WidgetType, keymap } from "@codemirror/view";
import { codeBlockAt } from './markdown-context.js';

const BULLET_RE = /^(\s*)([-*+]|\d+[.)])\s+/;
const CHECK_RE = /^(\s*)([-*+])\s+\[([ xX])\]/;

class CheckboxWidget extends WidgetType {
  constructor(checked, from, to) { super(); this.checked = checked; this.from = from; this.to = to; }
  /* 【P0-2·2026-10-10 由"人类常用操作普查"查出，会毁正文】原来只比 checked：
     `from/to` 也烘进了 DOM dataset（toDOM 里 mpFrom/mpTo），两者不同就意味着**这是另一处复选框**，
     必须重建 DOM。只比 checked 时 CM6 会复用旧 DOM，点击处理器读到的还是位移前的 dataset，
     于是按**陈旧区间**改写文档——实测「甲」整段消失、widget 也没了（6/6 复现）。
     位置参与 eq 是 CM6 widget 的硬性要求。 */
  eq(other) { return other.checked === this.checked && other.from === this.from && other.to === this.to; }
  toDOM(view) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "mp-cm6-check";
    box.dataset.mpFrom = String(this.from);
    box.dataset.mpTo = String(this.to);
    return box;
  }
  ignoreEvent() { return false; } // false＝事件交 CM6 处理 → view 级 domEventHandlers 能看到并翻源码
}

function buildCheckboxes(view) {
  const out = [];
  const doc = view.state.doc;
  // 视口行扫描（visibleRanges 是数组；旧代码误迭代单对象 viewport，靠全文档兜底才活——一并改对，省整篇扫描）
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = doc.lineAt(pos);
      const m = CHECK_RE.exec(line.text);
      if (m && !codeBlockAt(view.state, line.from)) {
        const start = line.from + m[1].length + m[2].length + 1; // '[' 的位置
        const end = start + 3;
        const inSel = view.state.selection.ranges.some((r) => r.from <= end && r.to >= start);
        if (!inSel) {
          out.push(Decoration.replace({ widget: new CheckboxWidget(m[3] !== " ", start, end) }).range(start, end));
        }
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(out, true);
}

const checkboxPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = buildCheckboxes(view); }
    update(u) { this.decorations = buildCheckboxes(u.view); }
  },
  { decorations: (v) => v.decorations },
);

function listContext(state, pos = state.selection.main.from) {
  if (codeBlockAt(state, pos)) return null;
  const line = state.doc.lineAt(pos);
  const m = BULLET_RE.exec(line.text);
  if (!m) return null;
  return { line, indent: m[1], bullet: m[2], markerEnd: m[0].length };
}

/** Enter：列表项内续项；空项退出列表。 */
function enterContinueList(view) {
  const state = view.state;
  const contexts = state.selection.ranges.map(r => listContext(state, r.from));
  if (contexts.some((ctx, i) => !ctx || state.selection.ranges[i].from < ctx.line.from + ctx.markerEnd)) return false;
  const spec = state.changeByRange(r => {
  const { line, indent, bullet, markerEnd } = listContext(state, r.from);
  /* 【P1-4·补·2026-10-10】空**任务**项（`- [ ] `）也要算空项：原来只把 marker 之后的**原始**文本
     trim 一下就判空，而 `- [ ] ` 之后是 `"[ ] "` ⇒ trim 得 `"[ ]"` ≠ 空 ⇒ 落进"续项"分支，
     空任务项回车永远退不出列表（普查 T10 实测：`- 甲\n- [ ] ` + Enter ⇒ 又续出一行 `- [ ] `）。 */
  if (line.text.slice(markerEnd).replace(/^\[[ xX]\]\s*/, "").trim() === "") {
    // 空项回车：删 marker 退出列表，光标留行首。
    // 空**任务**项要连 `[ ] ` 一起删掉 —— 只删到 markerEnd 会留下 `[ ]` 残骸（实测 T10）。
    const cb = /^\[[ xX]\]\s*/.exec(line.text.slice(markerEnd));
    const cut = markerEnd + (cb ? cb[0].length : 0);
    return {
      changes: { from: line.from, to: line.from + cut },
      range: EditorSelection.cursor(line.from),
    };
  }
  let next = bullet;
  const ord = /^(\d+)([.)])$/.exec(bullet);
  if (ord) next = `${Number(ord[1]) + 1}${ord[2]}`;
  const rest = line.text.slice(markerEnd);
  const check = /^(\[[ xX]\])\s*/.exec(rest);
  const tail = check ? "[ ] " : "";
  const head = r.from;
  const insert = `\n${indent}${next} ${tail}`;
  return {
    changes: { from: head, to: r.to, insert },
    range: EditorSelection.cursor(head + insert.length),
  };
  });
  view.dispatch({ ...spec, userEvent: 'input.list', scrollIntoView: true });
  return true;
}

/** Tab：列表项整体缩进两空位。 */
function tabIndentList(view) {
  if (view.state.selection.ranges.length !== 1 || !view.state.selection.main.empty) return false;
  const ctx = listContext(view.state);
  if (!ctx) return false;
  const head = view.state.selection.main.head;
  view.dispatch({
    changes: { from: ctx.line.from, to: ctx.line.from, insert: "  " },
    selection: EditorSelection.cursor(head + 2),
  });
  return true;
}

/** Shift-Tab：反缩进（最多去两空位）。 */
function shiftTabOutdentList(view) {
  if (view.state.selection.ranges.length !== 1 || !view.state.selection.main.empty) return false;
  const ctx = listContext(view.state);
  if (!ctx) return false;
  const cut = ctx.line.text.startsWith("  ") ? 2 : ctx.line.text.startsWith(" ") ? 1 : 0;
  if (cut === 0) return false;
  const head = view.state.selection.main.head;
  view.dispatch({
    changes: { from: ctx.line.from, to: ctx.line.from + cut },
    selection: EditorSelection.cursor(Math.max(ctx.line.from, head - cut)),
  });
  return true;
}

/** 复选框点击：view 级 mousedown 通道（与数学投影共用事件面；widget 的 dataset 带源码区间）。 */
const checkboxClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    const holder = event.target && event.target.closest ? event.target.closest(".mp-cm6-check") : null;
    if (!holder) return false;
    const from = Number(holder.dataset.mpFrom);
    const to = Number(holder.dataset.mpTo);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
    event.preventDefault();
    const cur = view.state.sliceDoc(from, to);
    view.dispatch({ changes: { from, to, insert: /\[x\]/i.test(cur) ? "[ ]" : "[x]" } });
    return true;
  },
});

export const listSemantics = [
  /* 【P1-4·2026-10-10 由普查查出】Enter 的 dispatch 全部来自 lang-markdown 的
     `insertNewlineContinueMarkup`（其"紧列表第 2 项为空"分支会把空项下移），本文件的
     `enterContinueList` **一次都没被调度** ⇒ "空列表项回车退出列表"（见本文件第 3 行承诺）从未生效。
     原因：`markdown()` 在扩展数组里排在 listSemantics 之前，同优先级先到先得。
     `tables.js:390` 记过同款教训并用了 Prec.high —— 这里照做，让列表语义优先于语言包默认。 */
  Prec.highest(keymap.of([
    { key: "Enter", run: enterContinueList },
    { key: "Tab", run: tabIndentList, shift: shiftTabOutdentList },
    // 嵌入上下文的结构性替代：Shift+Tab 的 keydown 被浏览器反向焦点遍历先劫走（原生日志实锤），
    // VSCode 肌肉记忆键在 iframe 内完全可达——不是补丁，是嵌入式键盘映射。
    { key: "Mod-[", run: shiftTabOutdentList },
    { key: "Mod-]", run: tabIndentList },
  ])),
  checkboxPlugin,
  checkboxClick,
  EditorView.theme({
    ".mp-cm6-check": {
      appearance: "none", width: "1em", height: "1em", margin: "0 0.35em 0 0.1em",
      border: "1.5px solid var(--mp-muted)",
      borderRadius: "4px", display: "inline-block", verticalAlign: "-0.12em",
      cursor: "pointer", position: "relative", background: "transparent",
    },
    ".mp-cm6-check:checked::after": {
      content: '"✓"', position: "absolute", inset: "0", textAlign: "center",
      fontSize: "0.85em", lineHeight: "1em", color: "var(--mp-primary)", fontWeight: "700",
    },
    ".mp-cm6-check:checked": { borderColor: "var(--mp-primary)" },
  }),
];
