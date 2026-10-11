/** 数学/块补全（CM6 版）——**规则与数据直接复用 2.x 侧**：
 *  · `completion-sources.localCandidates()`：命令表（240+ LaTeX 命令与分组）＋排序策略
 *    （完全命中 → 前缀命中 → 同族兄弟 → 说明命中 → 模糊命中；同档内"本文档用过"优先、再表序）；
 *  · `completion-policy.sourceKind()/shouldSuggest()`：上下文判定（公式/代码/正文，含未闭合 `$…`）
 *    与"该不该弹"的纯本地策略。
 *  本模块只做 CM6 原生该做的事：取 token → 调这两个纯函数 → 用 CM6 的 DOM/键位呈现与插入。
 *  ⇒ 规则零重写，行为与 vditor 侧对齐；架构走 CM6（ViewPlugin + 事务插入，无影子文档模型）。
 *
 *  触发：公式里键入 `\` 后继续打字；正文里键入 `/` 后继续打字；`Ctrl+Space` 手动。
 *  键位：↑/↓ 选择、Enter/Tab 接受、Esc 关闭——**仅在菜单打开时**以最高优先级拦截。
 *  插入：替换 `[tokenFrom, head)`；插入串自带 `{}` 时，光标落进花括号内（与 vditor 侧同口径）。 */

import { Prec } from "@codemirror/state";
import { ViewPlugin, keymap } from "@codemirror/view";
import { localCandidates } from "../renderer/js/completion-sources.js";
import { sourceKind } from "../renderer/js/completion-policy.mjs";

const MATH_TOKEN = /\\([A-Za-z]*)$/;
const SLASH_TOKEN = /(?:^|[\s([{>])\/([A-Za-z]*)$/;

let view = null;
let box = null;
let rows = [];
let active = 0;
let tokenFrom = 0;
let tokenTo = 0;
let raf = 0;

function ensureBox() {
  if (box && box.isConnected) return box;
  box = document.createElement("div");
  box.className = "mp-complete";
  box.style.display = "none";
  // 观察器免疫：与表格覆盖层同一策略，挂 body（不进 CM6 的 contentDOM）
  box.addEventListener("mousedown", (e) => {
    const item = e.target && e.target.closest ? e.target.closest("[data-mp-idx]") : null;
    if (!item) return;
    e.preventDefault(); e.stopPropagation();
    accept(Number(item.dataset.mpIdx));
  });
  document.body.appendChild(box);
  return box;
}

function place() {
  if (!box || box.style.display === "none" || !view) return;
  let c = null;
  try { c = view.coordsAtPos(tokenTo); } catch { }
  if (!c) { close(); return; }
  const h = box.offsetHeight || 200;
  const below = c.bottom + 6;
  const flip = below + h > window.innerHeight - 8;
  box.style.left = Math.round(Math.min(c.left, Math.max(8, window.innerWidth - box.offsetWidth - 8))) + "px";
  box.style.top = Math.round(flip ? Math.max(8, c.top - h - 6) : below) + "px";
}

function render() {
  const el = ensureBox();
  el.innerHTML = rows.map((row, i) =>
    `<div class="mp-complete-item${i === active ? " is-active" : ""}" data-mp-idx="${i}">` +
    `<span class="k">${escapeHtml(row.label)}</span>` +
    `<span class="d">${escapeHtml(row.detail || "")}</span></div>`).join("");
  el.style.display = "block";
  place();
  const cur = el.querySelector(".is-active");
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function close() {
  if (box) box.style.display = "none";
  rows = []; active = 0;
}

function move(delta) {
  if (!rows.length) return;
  active = (active + delta + rows.length) % rows.length;
  render();
}

function accept(index) {
  if (!view || !rows.length) { close(); return; }
  const row = rows[Math.max(0, Math.min(index, rows.length - 1))];
  const insert = row.text;
  // 【替换区间契约】`before` = 光标左侧属于本 token 的字符数；`after` = 右侧仍属于本 token 的
  // 字符数（例：`\fr|ac{x}{y}` 里 ac 要一起换掉，才不会留下 `\frac{}{}ac{x}{y}`）。
  const from = tokenTo - (row.before || 0);
  const to = tokenTo + (row.after || 0);
  // 插入串里的空花括号：光标落进去（`\mathbb{}` → 光标在 {} 中间）
  const caretIn = insert.indexOf("{}");
  const anchor = caretIn >= 0 ? from + caretIn + 1 : from + insert.length;
  close();
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor },
    scrollIntoView: true,
    userEvent: "input.complete",
  });
  view.focus();
}

/** token → 候选。返回 null 表示"当前不该有菜单"。 */
function candidatesFor(state, manual) {
  const head = state.selection.main.head;
  if (!state.selection.main.empty) return null;
  const before = state.doc.sliceString(Math.max(0, head - 12000), head);
  const after = state.doc.sliceString(head, Math.min(state.doc.length, head + 1000));
  const ctx = sourceKind(before);
  const kind = ctx.kind;
  let prefix = null, from = head;
  if (kind === "math") {
    const m = MATH_TOKEN.exec(before);
    if (m) { prefix = "\\" + m[1]; from = head - m[0].length; }
  } else if (kind === "prose") {
    const m = SLASH_TOKEN.exec(before);
    if (m) { prefix = "/" + m[1]; from = head - prefix.length; }
  }
  if (!prefix) return null;
  const mathAfter = kind === "math" ? after.split(/(?<!\\)\$/)[0].slice(0, 1200) : "";
  // 【门的归属·与 2.x 同口径】`shouldSuggest()` 在 vditor 侧只拦 **AI** 源
  // （completion.js:196 `if (kind === 'ai' && !manual && !shouldSuggest(...)) return;`），
  // 本地源（命令/片段）照实弹（:228 `items = [...localCandidates(prefix, context), …]`）。
  // 故这里不再做二次门控——有没有候选完全由 localCandidates 决定（它在公式里对 `/` 返回空，
  // 天然把"公式里没有块片段"这条互斥做掉了）。manual（Ctrl+Space）保留给后续 AI 源用。
  const list = localCandidates(prefix, { kind, mathBefore: ctx.mathBefore || "", mathAfter });
  if (!list.length) return null;
  return { rows: list, from: head - prefix.length, head };
}

function refresh(v, manual) {
  try {
    const hit = candidatesFor(v.state, manual);
    if (!hit) { close(); return; }
    const sameToken = rows.length === hit.rows.length && tokenFrom === hit.from && rows[0] && hit.rows[0] && rows[0].label === hit.rows[0].label;
    rows = hit.rows; tokenFrom = hit.from; tokenTo = hit.head;
    if (!sameToken) active = 0;
    render();
  } catch { close(); }
}

function schedule(v, manual) {
  view = v;
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; refresh(v, manual); });
}

const keyHandlers = [
  { key: "ArrowDown", run: () => (rows.length ? (move(1), true) : false) },
  { key: "ArrowUp", run: () => (rows.length ? (move(-1), true) : false) },
  { key: "Enter", run: () => (rows.length ? (accept(active), true) : false) },
  { key: "Tab", run: () => (rows.length ? (accept(active), true) : false) },
  { key: "Escape", run: () => (rows.length ? (close(), true) : false) },
  { key: "Ctrl-Space", run: (v) => { refresh(v, true); return !!rows.length; } },
];

export function mathCompletion() {
  return [
    Prec.highest(keymap.of(keyHandlers)),
    ViewPlugin.fromClass(class {
      constructor(v) { view = v; }
      update(u) {
        // 【方向键安全·2026-10-07 实测缺陷】补全只在**键入**时开；任何"只动光标"的变化一律先关。
        // 否则：↑ 把光标送进公式源码（`\rho\eta` 这种满是反斜杠的行），菜单自己弹出来，
        // 而菜单打开时 ↑/↓ 被本模块的 keymap 吃掉 ⇒ 光标再也不动＝"上键无限循环"。
        if (u.docChanged) schedule(u.view, false);
        else if (u.selectionSet) close();
        else if (u.geometryChanged || u.viewportChanged) place();
      }
      destroy() { close(); }
    }, {
      eventHandlers: {
        blur() { close(); },
        scroll() { place(); },
      },
    }),
  ];
}
