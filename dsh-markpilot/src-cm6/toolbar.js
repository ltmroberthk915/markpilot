/** CM6 工具栏（架构走 CM6 原生事务）。
 *
 *  信息架构·2026-11-16：**一个功能一个入口**。
 *    · 岛上只放高频直达命令与模式开关（格式、插入、查找、图片、表格、全屏、双开、
 *      阅读模式、导出、更多、折叠）；
 *    · 撤销/重做与上/下插空行**不再占可见槽位**：命令仍在 ACTIONS / 右键菜单 / 键盘里
 *      （Mod-z、Mod-Shift-z、Mod-y 由 main.js 的最高优先级 keymap 收口）；
 *    · 持续性偏好统一收进「更多 → 编辑器设置」：主题配色、字体、页面、界面与大纲、
 *      阅读配色、图片策略、快捷键不再各摆一个入口；
 *    · 脚注（插入 / 跳转 / 返回）沿用扩展包的 runFootnote，占原先插空行两颗按钮的位置。
 *
 *  实现纪律：所有动作走 `view.dispatch`（撤销栈/版本守卫/桥同步自动成立），不碰 DOM 文本；
 *  按钮创建期间**不得调用 toolbarClick**（它执行用户命令，会在重开文档时产生点击副作用）。
 */

import { undo, redo, isolateHistory } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { EditorSelection } from "@codemirror/state";
import { codeSpanMarkers, inlineCodeSpans, inlineEmphasisSpans } from './inline-format.js';
import { selectedLines } from './selection-lines.js';
import { quoteLead, codeBlockAt, inFrontMatter, listMarkerOf } from './markdown-context.js';
import { tableSpanOf } from './tables.js';

const svg = (d, extra = "") => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" ${extra}><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/* 【#38·2026-10-18 实测缺陷 N3】块级命令不许写进表行：光标停在表行边界（无格覆盖层）时点
   「标题」得到 "# | a1 | a2 |"（渲染层把 "# " 显示进第一格）；点「表格」/「插入行」会把
   模板行并进原表或把表劈成两段。与粘贴守卫同一口径：拒绝并提示，不动文档。
   【#41·2026-10-18 NX1】同一族守卫补齐围栏与 front-matter：光标在代码块里按 Ctrl+L/点「标题」
   会把 "- " / "# " 写进代码行；落在围栏行上整块塌源码；在 YAML 序言区点「表格」会把模板写进
   front-matter。判据用仓库现成的 codeBlockAt / inFrontMatter。 */
function blockedBlockCommand(view) {
  try {
    const st = view.state, r = st.selection.main;
    const { first, last } = selectedLines(st.doc, r);
    const docText = st.doc.toString();
    for (let i = first; i <= last; i++) {
      const line = st.doc.line(i);
      if (tableSpanOf(st, i)) {
        window.mpExtras?.toast?.('表格内不支持块级格式——请先把光标移到表格外');
        return true;
      }
      if (codeBlockAt(st, line.from)) {
        window.mpExtras?.toast?.('代码块内不支持块级格式——请先把光标移到代码块外');
        return true;
      }
      if (inFrontMatter(docText, line.from)) {
        window.mpExtras?.toast?.('文档头部信息区不支持块级格式——请移到正文再操作');
        return true;
      }
    }
  } catch { /* 判不出来就按不拦：守卫自身不能把命令打崩 */ }
  return false;
}

/** 由扩展包（extras.js）接管的按钮 id：判定"已实现"用静态集合，不看运行时的 window.mpExtras。
 *  集合只登记**岛上真实存在的槽位**：主题配色 / 明暗 / 字体 / 页面 / 界面 / 阅读配色 / 快捷键等
 *  偏好入口已统一到「更多 → 编辑器设置」，不再登记；toolbarClick 里保留它们的路由，外部调用可用。 */
const EXTRAS_IDS = new Set(["more", "outline", "emoji", "document-export", "split", "fullscreen", "reading-mode",
  /* upload（图片）＝只弹原生文件选择器；footnote＝扩展包的 runFootnote（插入 / 跳转 / 返回）。 */
  "upload", "footnote"]);

const NOT_YET = {
  // 【已接】reading-mode / fullscreen / footnote 不再列在这里（见 EXTRAS_IDS）
  // 【2026-10-09 已接】upload（图片）：接上扩展包的文件选择器（单一语义）；
  //                    reload（重新加载）：**不再占工具栏槽位**，改为「更多」菜单项 + 壳侧 file:reload 上行。
  // 【删掉的死按钮】edit-mode / source-toggle：CM6 的文档**本来就是 markdown 源文本直编**，
  // v2.3.3 的"源码模式 / 预览切换"在这里结构性不存在 ⇒ 留着只会永远灰着占位，直接不摆。
};

const ITEMS = [
  { id: "outline", tip: "大纲", icon: svg("M4 6h16M4 12h10M4 18h13") },
  { id: "emoji", tip: "Emoji", icon: svg("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM9 10h.01M15 10h.01M8.5 14.5a4 4 0 0 0 7 0") },
  { id: "headings", tip: "标题（循环 H1→H6→正文）", icon: svg("M6 5v14M18 5v14M6 12h12") },
  { id: "bold", tip: "加粗 Ctrl+B", icon: svg("M7 5h6a3.5 3.5 0 0 1 0 7H7Zm0 7h7a3.5 3.5 0 0 1 0 7H7Z") },
  { id: "italic", tip: "斜体 Ctrl+I", icon: svg("M10 5h8M6 19h8M14 5 10 19") },
  { id: "strike", tip: "删除线 Alt+Shift+5", icon: svg("M5 12h14M8 8.5a3.5 3.5 0 0 1 3.5-3.5h1a3.5 3.5 0 0 1 1 6.9M9 15.5a3.5 3.5 0 0 0 3.5 3.5h1a3.5 3.5 0 0 0 2.5-1") },
  /* 【下划线·2026-10-10 用户报障补齐】Typora 口径：Ctrl+U ⇒ 存成 `<u>…</u>`
     （Markdown 本身没有下划线语法；2.x 线同样落 `<u>`，见 docs/FEATURES-1.0.3.md）。 */
  { id: "underline", tip: "下划线 Ctrl+U", icon: svg("M7 4v8a5 5 0 0 0 10 0V4M5 20h14") },
  { id: "find-replace", tip: "查找替换 Ctrl+F", icon: svg("M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm4.5 10.5L20 20") },
  { id: "link", tip: "链接 Ctrl+K", icon: svg("M10 14a4 4 0 0 1 0-5.7l2-2a4 4 0 0 1 5.7 5.7l-1 1M14 10a4 4 0 0 1 0 5.7l-2 2A4 4 0 0 1 6.3 12l1-1") },
  { sep: true },
  { id: "list", tip: "无序列表", icon: svg("M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01") },
  { id: "ordered-list", tip: "有序列表", icon: svg("M9 6h11M9 12h11M9 18h11M4 5.5h1V9M4 12h1.5L4 15h2") },
  { id: "check", tip: "任务列表", icon: svg("M4 6h4v4H4zM10 8h10M4 14h4v4H4zM10 16h10") },
  { id: "outdent", tip: "减少缩进", icon: svg("M11 6h9M11 12h9M11 18h9M8 8 4 12l4 4") },
  { id: "indent", tip: "增加缩进", icon: svg("M11 6h9M11 12h9M11 18h9M4 8l4 4-4 4") },
  { sep: true },
  { id: "quote", tip: "引用", icon: svg("M6 5v14M10 8h8M10 12h8M10 16h5") },
  { id: "line", tip: "分割线", icon: svg("M4 12h16M7 8h10M7 16h10") },
  { id: "code", tip: "代码块", icon: svg("M9 6 4 12l5 6M15 6l5 6-5 6") },
  { id: "inline-code", tip: "行内代码", icon: svg("M10 6 8 18M16 6l-2 12M5 10h14M5 14h14") },
  /* 【脚注·2026-11-16】形如 x¹ 的原生图标：左下 x（两笔交叉）＋右上标 1（斜起笔＋竖）。
     位置＝原先「上/下插空行」两颗按钮处；行为直接复用 extras.js 的 runFootnote
     （插入引用 / 跳到定义 / 返回引用三种上下文同一个动作），不再在「更多」里重复一条。 */
  { id: "footnote", tip: "脚注：插入、跳转或返回", icon: svg("M4 9.6L9.4 15.4M9.4 9.6L4 15.4M13.4 6.4L15.6 4.2V10.6") },
  { sep: true },
  { id: "upload", tip: "图片", icon: svg("M4 6h16v12H4zM8 12l3 3 2-2 3 3M9 9h.01") },
  { id: "table", tip: "表格", icon: svg("M4 5h16v14H4zM4 10h16M10 5v14") },
  { sep: true },
  { id: "fullscreen", tip: "全屏", icon: svg("M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5") },
  /* 【双开 vs 阅读模式·2026-10-08 图标重画】两者原先都是"左右两块面板"，缩到 24px 剪影几乎一样
     （用户截图实锤）。现在按**剪影差异**分开：
       · 双开＝**方正的两个面板 + 中缝**（几何、直边、上下顶满）——"把一页切成两栏"；
       · 阅读模式＝**打开的书**（宽扁、左右页外缘倾斜、中间书脊，页面下方留白）——"读书"。
     两者外轮廓（方 vs 扁宽 + 斜边）与内部结构（一条竖缝 vs 一条书脊 + 两道页缘）都不同，
     不靠颜色也能分辨；线宽 1.7、viewBox 24、与岛上其它图标同一套（同一个 svg() 助手）。 */
  { id: "split", tip: "双开：左侧渲染编辑面 + 右侧同文档只读源码（滚动/点击双向跟随）", icon: svg("M4 5h7v14H4zM13 5h7v14h-7z") },
  { id: "reading-mode", tip: "阅读模式", icon: svg("M12 7.4C10.2 5.9 7.6 5.2 4.6 5.2v11.2c3 0 5.6.7 7.4 2.2 1.8-1.5 4.4-2.2 7.4-2.2V5.2c-3 0-5.6.7-7.4 2.2ZM12 7.4v11.2") },
  { id: "document-export", tip: "导出（PDF / HTML / 复制）", icon: svg("M14 4h6v6M20 4l-9 9M18 14v5H5V6h5") },
  /* 【2026-10-09 撤出工具栏】reload（重新加载）已收进「更多」菜单（低频动作不占槽位），
     而且它的上行这次真接上了（壳侧 file:reload）—— 原来它是置灰的 is-todo 死按钮。 */
  /* 【「更多」挪到最右·2026-10-08】用户要求汉堡菜单从工具栏**最左**挪到**最右**：
     现在排在折叠按钮之前、是展开态里最靠右的一项；折叠按钮（`toolbar-fold`）再往后一格，
     收起后仍是最右边那颗小圆岛（J3 判据要求"靠右、右缝≈12"）——即：
       … 双开 │ 阅读模式 │ 导出 │ **更多** │ 折叠　（重新加载 2026-10-09 已收进「更多」菜单）
     "更多在最右"与"折叠永远可点"两条同时成立。 */
  { id: "more", tip: "更多（重新加载 / 图片操作 / 编辑器设置 / 帮助）", icon: svg("M6 12h.01M12 12h.01M18 12h.01") },
  { id: "toolbar-fold", tip: "收起工具栏", icon: svg("m7 13 5-5 5 5M7 18l5-5 5 5"), fold: true },
];

/* ── 编辑动作（全部走 view.dispatch，撤销/守卫/桥自动成立）────────────────── */

/* ══ 行内格式：包裹 / 取消包裹（**唯一实现**）══════════════════════════════════
 *  【为什么在这里·2026-10-10】快捷键表（extras.js 的 ACTIONS）与工具栏按钮曾经**各有一份**
 *  wrap/wrapSelection（AGENTS 错-4 的同族形态）。两份实现一旦分叉，用户在两条路上会得到
 *  不同的落点与不同的观感；本函数导出后由两处共用，杜绝第二份。
 *
 *  【落点规则·用户 2026-10-10 明确定稿】包裹完成后光标**收进定界符内侧**：
 *    · 从前往后选（anchor < head，扩展式）⇒ 光标落在**后定界符之前**： `**文字|**`
 *    · 从后往前选（head < anchor，收缩式）⇒ 光标落在**前定界符之后**： `**|文字**`
 *    · 无选区 ⇒ 落在成对定界符**正中**： `**|**`
 *  这样接着打字是"在标记内部继续写"，而不是跑到定界符外面（改前一律落在 `**文字**|`）。
 *  代价＝选区被折叠（CM6 里等价于按一下方向键），**不动文档文本**。 */

/** 左邻是否为反斜杠转义：`\**a**` 的开星是字面星号，不是标记。 */
function escapedAt(doc, pos) {
  let n = 0;
  for (let i = pos - 1; i >= 0 && doc.sliceString(i, i + 1) === '\\'; i--) n++;
  return n % 2 === 1;
}

/** 选区外侧那一对定界符的长度（含"多包一层"的修正）；没有则 0。 */
function ownsItalicPair(doc, from, to) {
  const line = doc.lineAt(from);
  if (to > line.to) return false;
  const start = from - line.from, end = to - line.from;
  if (end === start + 2) return line.text[start - 1] !== '*' && line.text[end] !== '*';
  return inlineEmphasisSpans(line.text).some(span => span.width === 1 &&
    span.from <= start && span.to >= end &&
    /^\*+$/.test(line.text.slice(span.from, start + 1)) &&
    /^\*+$/.test(line.text.slice(end - 1, span.to)));
}

function wrapDelimLen(doc, from, to, open, close) {
  if (to > from && close === open && doc.sliceString(to, to + open.length) !== open) return 0;
  const l = doc.sliceString(Math.max(0, from - open.length), from), r = doc.sliceString(to, to + close.length);
  if (open === '*' && l === open && r === close) return ownsItalicPair(doc, from - 1, to + 1) ? 1 : 0;
  if (open === '**') {
    if (l === '**' && r === '**') return 2;
    if (l === '***' && r === '***') return 3;              // 粗斜体整体取消
    if (l.endsWith('*') && !l.endsWith('**') && r.startsWith('*') && !r.startsWith('**')) return 1;  // 取消"斜体里的粗体"：剥一层星
  }
  return l === open && r === close ? open.length : 0;
}

/** 包围选区的那个**内容跨度**（含内容、不含可能多出的外层斜体星）；没有则 null。 */
function enclosingSpan(doc, from, to, open, close) {
  const openLen = wrapDelimLen(doc, from, to, open, close);
  if (!openLen) return null;
  const closeLen = open === close ? openLen : close.length;
  const outer = openLen > open.length;                            // 多出的那一层（`***a***` ⇒ 里层是 `**a**`）
  const f = from - outer, t = to + outer;
  return { from: f - openLen, to: t + closeLen, innerFrom: f, innerTo: t, openLen, esc: escapedAt(doc, f - openLen) };
}

/** 在选区两侧加上/去掉定界符。返回 true＝已处理（调用方不要再走别的分支）。 */
export function wrap(view, open, close = open) {
  const command = window.mpEngine?.commands;
  return command ? command.run(() => wrapSource(view, open, close)) : wrapSource(view, open, close);
}
function wrapInlineCode(view) {
  const state = view.state;
  let isolate = false;
  const spec = state.changeByRange(r => {
    const doc = state.doc, start = doc.lineAt(r.from).from, end = doc.lineAt(r.to).to;
    const source = doc.sliceString(start, end);
    const a = r.from - start, b = r.to - start;
    const spans = inlineCodeSpans(source);
    const hit = spans.find(s => s.from === a && s.to === b || s.innerFrom === a && s.innerTo === b);
    if (hit) {
      const from = start + hit.from, to = from + hit.innerTo - hit.innerFrom;
      const whole = a === hit.from;
      isolate ||= whole;
      return { changes: [{ from, to: start + hit.innerFrom }, { from: start + hit.innerTo, to: start + hit.to }],
        range: whole ? EditorSelection.range(r.anchor <= r.head ? from : to, r.anchor <= r.head ? to : from) : EditorSelection.cursor(from) };
    }
    // Toggle the empty placeholder before its first real character is typed.
    if (r.empty && source[a - 1] === '`' && source[a] === '`' &&
        source[a - 2] !== '`' && source[a + 1] !== '`' && !escapedAt(doc, r.from - 1) &&
        !spans.some(s => s.from < a && s.to > a))
      return { changes: { from: r.from - 1, to: r.to + 1 }, range: EditorSelection.cursor(r.from - 1) };
    const text = doc.sliceString(r.from, r.to), { open, close } = codeSpanMarkers(text);
    return { changes: { from: r.from, to: r.to, insert: open + text + close },
      range: EditorSelection.cursor(r.from + open.length + (r.anchor <= r.head ? text.length : 0)) };
  });
  view.dispatch({ ...spec, ...(isolate ? { annotations: isolateHistory.of('full') } : {}), userEvent: 'input.format', scrollIntoView: true });
  view.focus();
  return true;
}
function wrapSource(view, open, close) {
  if (open === "`" && close === "`") return wrapInlineCode(view);
  const ranges = view.state.selection.ranges;
  if (ranges.length === 1) return wrapSingle(view, open, close);
  return wrapMulti(view, open, close, ranges);
}
/* 【#43·2026-10-18 实测缺陷 NX3】多光标行内格式：每个选区单独规划"加/取消包裹"（与单光标同一套
   toggle 语义），合并成一次事务；每处落点用 ChangeSet.mapPos 映射后加局部偏移 ——
   空选区落在两个定界符之间，有选区落在内容那一侧（与单光标的方向口径一致）。 */
function wrapPlan(doc, r, open, close) {
  const sel = doc.sliceString(r.from, r.to);
  const span = enclosingSpan(doc, r.from, r.to, open, close);
  if (!span) {
    const outer = open.length + close.length;
    if (sel.length >= outer && sel.startsWith(open) && sel.endsWith(close) && !escapedAt(doc, r.from) &&
        (open !== '*' || ownsItalicPair(doc, r.from, r.to))) {
      const innerFrom = r.from + open.length, innerTo = r.to - close.length;
      return { changes: [{ from: r.from, to: innerFrom, insert: '' }, { from: innerTo, to: r.to, insert: '' }], caret: r.from, delta: 0 };
    }
  }
  if (span && !span.esc) {
    return { changes: [{ from: span.from, to: span.from + span.openLen, insert: '' }, { from: span.innerTo, to: span.to, insert: '' }], caret: span.from, delta: 0 };
  }
  const insert = open + sel + close;
  const forward = r.empty ? true : r.anchor <= r.head;
  return { changes: [{ from: r.from, to: r.to, insert }], caret: r.from, delta: forward ? open.length + sel.length : open.length };
}
function wrapMulti(view, open, close, ranges) {
  const doc = view.state.doc;
  const changes = [], plans = [];
  for (const r of ranges) {
    const p = wrapPlan(doc, r, open, close);
    if (!p) return false;
    changes.push(...p.changes);
    plans.push(p);
  }
  let transaction;
  try {
    const mapped = view.state.changes(changes);
    const carets = plans.map(p => EditorSelection.cursor(mapped.mapPos(p.caret, -1) + p.delta));
    transaction = view.state.update({ changes: mapped, selection: EditorSelection.create(carets, view.state.selection.mainIndex),
      userEvent: 'input.format', scrollIntoView: true });
  } catch { return false; }
  view.dispatch(transaction);
  view.focus();
  return true;
}
function wrapSingle(view, open, close) {
  const r = view.state.selection.main;
  const doc = view.state.doc;
  const sel = doc.sliceString(r.from, r.to);
  const span = enclosingSpan(doc, r.from, r.to, open, close);
  /* 【选区把定界符一起选进去·2026-10-17 实测缺陷】选 `**beta**` 按 Ctrl+B 得到 `****beta****`：
     `wrapDelimLen` 只看选区**外侧**（那里是空格）⇒ 认不出"已经加粗"，于是又包一层，留下退化标记
     （斜体 `*beta*` 选整段按 Ctrl+I ⇒ `**beta**`：斜体反而变粗体）。Typora 手感是**取消**这层标记。
     补一条：选区文本本身以 open 开头、以 close 结尾 ⇒ 只删这两个定界符，内容与撤销都正常。 */
  if (!span) {
    const outer = open.length + close.length;
    if (sel.length >= outer && sel.startsWith(open) && sel.endsWith(close) && !escapedAt(doc, r.from) &&
        (open !== '*' || ownsItalicPair(doc, r.from, r.to))) {
      const innerFrom = r.from + open.length, innerTo = r.to - close.length;
      view.dispatch({
        changes: [{ from: r.from, to: innerFrom, insert: '' }, { from: innerTo, to: r.to, insert: '' }],
        selection: r.anchor <= r.head
          ? { anchor: r.from, head: r.from + innerTo - innerFrom }
          : { anchor: r.from + innerTo - innerFrom, head: r.from },
        annotations: isolateHistory.of('full'), userEvent: 'input.format', scrollIntoView: true,
      });
      view.focus();
      return true;
    }
  }
  if (span && !span.esc) {
    /* 取消包裹：只删两侧定界符，中间的文本一个字节都不动。 */
    view.dispatch({
      changes: [{ from: span.from, to: span.from + span.openLen, insert: '' }, { from: span.innerTo, to: span.to, insert: '' }],
      /* 取消后光标落在内容起点 —— Typora 手感：再按一次可以重新加上 */
      selection: { anchor: span.from },
      userEvent: 'input.format', scrollIntoView: true,
    });
    view.focus();
    return true;
  }
  const insert = open + sel + close;
  /* 方向 ⇒ 落点（用户定稿）：
     · 无选区：成对定界符正中（`**|**`）
     · 从**后**往前选（收缩式，head < anchor）：落在**后**定界符之前 ⇒ `**文字|**`（选中的内容还在光标左边）
     · 从**前**往后选（扩展式，anchor < head）：落在**前**定界符之后 ⇒ `**|文字**` */
  const forward = r.empty ? true : r.anchor <= r.head;
  const caret = forward ? r.from + open.length + sel.length : r.from + open.length;
  view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: { anchor: caret }, userEvent: 'input.format', scrollIntoView: true });
  view.focus();
  return true;
}

/* 【光标必须落在刚插入的前缀**之后**·2026-10-10 用户报「点引用按钮出现奇怪错误，无法描述」】
 *  实测差异（`probe-quote-caret.cjs`，同一夹具、同一空行起点）：
 *    直接键入 `> `      ⇒ 文档 `> ⏎`，光标列 **2**，接着打字得到 `> 引用内容`（落在引用行里）✓
 *    点工具栏「引用」   ⇒ 文档 `> ⏎`（**逐字节相同**），光标列 **0**（停在前缀之前）✗
 *                       接着打字得到 `引用内容> ⏎` —— 文字跑到引用**外面**去了 ✗
 *  用户"无法描述"的就是这个：屏幕上多出一条空的引用底色条纹，光标闪在左外侧，
 *  接着打字看着像没进引用（其实进了，只是跑到前缀前面）。
 *  修法：插入前缀后把光标按**前缀长度**前移（删除前缀时不动光标，保持原有手感）。
 *  多行选区：每行加同样的前缀 ⇒ 列号偏移量都是 prefix.length，用同一个锚点即可。 */
function linePrefix(view, prefix, ordered = false) {
  if (blockedBlockCommand(view)) return;
  const st = view.state;
  const r = st.selection.main;
  const { first, last } = selectedLines(st.doc, r);
  const changes = [];
  let n = 0;
  /* 光标是否真的跟着"插入"走：只有**全部行都是插入**时才前移（任何一行是删除 ⇒ 不动，语义含混时不猜） */
  let allInsert = true;
  for (let i = first; i <= last; i++) {
    const line = st.doc.line(i);
    n++;
    /* 【普查实测·2026-10-10】有序列表传的是空前缀 ⇒ startsWith("") 恒真，永远走"删前缀"分支而 prefix 长度为 0 ⇒ 空操作。
     /* 空前缀一律视为"没有"，交给下面的 ordered 正则判定。 */
    /* 【引用容器·2026-10-17 实测缺陷】前缀必须插在 `> ` 之后：改前用 `line.from` 绝对行首，
       `> t` 点「无序列表」得到 `- > t`、点「标题」得到 `# > t` —— 引用容器被顶掉，
       屏幕上原来的引用块消失、内容变成普通行（两个按钮同一根因）。
       `quoteLead` 是渲染层/表格层共用的同源函数，不在这里再抄一份正则。 */
    const lead = quoteLead(line.text);
    const indent = /^[ \t]*/.exec(line.text.slice(lead.off))[0].length;
    const at = line.from + lead.off + indent;
    const body = line.text.slice(lead.off + indent);
    /* 【#45·2026-10-18 实测缺陷 M2+M3】行前缀家族两处归一：
       ① 引用容器：前缀落在 "> " 之后（M2：引用行 Ctrl+L 得 "> - 文本" 而不是 "- > 文本"）；
       ② 列表标记互转：目标是无序/有序/任务时，先剥掉 body 上已有的列表标记（M3：
          "1. 项目" 点无序不再得到 "- 1. 项目"）；缩进行保留缩进（at 在缩进之后）。 */
    if (prefix === '> ') {
      if (line.text.startsWith('> ')) {
        allInsert = false;
        changes.push({ from: line.from, to: line.from + 2, insert: "" });
      } else changes.push({ from: line.from, insert: '> ' });
      continue;
    }
    const existing = listMarkerOf(body);
    const marker = ordered ? (n + '. ') : prefix;
    const listTarget = ordered || prefix === '- ' || prefix === '- [ ] ';
    const has = (prefix ? body.startsWith(prefix) : false) || (ordered && !!existing && existing.kind === 'ordered');
    if (has) {
      allInsert = false;
      const m = ordered && existing && existing.kind === 'ordered' ? /^\d+\.\s/.exec(body)[0] : prefix;
      changes.push({ from: at, to: at + m.length, insert: "" });
    } else if (listTarget && existing) {
      /* 归一化＝替换不是纯插入：光标交给 CM6 自动映射（显式 anchor 会因文本变短越界） */
      allInsert = false;
      changes.push({ from: at, to: at + existing.len, insert: marker });
    } else {
      changes.push({ from: at, insert: marker });
    }
  }
  /* 有序列表的前缀长度按**首行**实际写入的串算（`1. ` 与 `12. ` 长度不同） */
  const written = ordered ? `${1}. `.length : prefix.length;
  const anchor = (allInsert && r.empty) ? r.head + written : undefined;
  view.dispatch({ changes, ...(anchor == null ? {} : { selection: { anchor } }), userEvent: "input.format", scrollIntoView: true });
  view.focus();
}

function headingCycle(view) {
  if (blockedBlockCommand(view)) return;
  const st = view.state;
  const line = st.doc.lineAt(st.selection.main.head);
  /* 【引用容器·2026-10-17 实测缺陷】标题标记必须落在 `> ` 之后（`> # t`）；
     改前从绝对行首插到底 ⇒ `# > t`，引用块被顶掉，原来的引用内容变成普通标题行。 */
  const off = quoteLead(line.text).off;
  const body = line.text.slice(off);
  const m = /^(#{1,6})\s/.exec(body);
  const next = !m ? "# " : m[1].length >= 6 ? "" : "#".repeat(m[1].length + 1) + " ";
  const to = m ? line.from + off + m[0].length : line.from + off;
  view.dispatch({ changes: { from: line.from + off, to, insert: next }, userEvent: "input.format" });
  view.focus();
}

function indentLines(view, delta) {
  const st = view.state;
  const r = st.selection.main;
  const { first, last } = selectedLines(st.doc, r);
  const changes = [];
  for (let i = first; i <= last; i++) {
    const line = st.doc.line(i);
    if (delta > 0) changes.push({ from: line.from, insert: "  " });
    else if (line.text.startsWith("  ")) changes.push({ from: line.from, to: line.from + 2, insert: "" });
    else if (/^\s/.test(line.text)) changes.push({ from: line.from, to: line.from + 1, insert: "" });
  }
  if (!changes.length) return;
  view.dispatch({ changes, userEvent: "input.format" });
  view.focus();
}

function insertBlock(view, text) {
  if (blockedBlockCommand(view)) return;
  const st = view.state;
  const line = st.doc.lineAt(st.selection.main.head);
  const at = line.to;
  const ins = "\n" + text;
  /* 【P1-6·2026-10-10 由"人类常用操作普查"查出】原来光标一律落在插入串**末尾**：代码块模板
     `"```\n\n```\n"` 的末尾在**闭合围栏之后** ⇒ 用户点完「代码块」接着打字，字符落在**块外的
     普通段落**、块内仍是空的（CF-7/7b 四轮复现一致）。
     模板里带**空行**时（代码块正是这种），把光标放进那个空行 —— 那才是"该开始打字的位置"；
     表格 / 分隔线等模板没有空行 ⇒ 保持原语义（落在末尾）。
     注意用 indexOf 而不是 split：模板首字符就是换行，`\n\n` 的首次出现即围栏后的那一行。 */
  let caret = at + ins.length;
  const blank = ins.indexOf("\n\n");
  if (blank >= 0) caret = at + blank + 1;   // 两个换行**之间**＝那个空行的行首（+2 会落到闭合围栏那一行）
  view.dispatch({ changes: { from: at, insert: ins }, selection: { anchor: caret }, userEvent: "input.format", scrollIntoView: true });
  view.focus();
}

function insertBlankLine(view, before) {
  if (blockedBlockCommand(view)) return;
  const st = view.state;
  const line = st.doc.lineAt(st.selection.main.head);
  const at = before ? line.from : line.to;
  view.dispatch({ changes: { from: at, insert: "\n" }, selection: { anchor: at + (before ? 0 : 1) }, userEvent: "input.format" });
  view.focus();
}

const ACTIONS = {
  bold: (v) => wrap(v, "**"),
  italic: (v) => wrap(v, "*"),
  strike: (v) => wrap(v, "~~"),
  /* 【下划线】`<u>` / `</u>` 两端不同长 ⇒ 用 open/close 两个参数（wrap 的落点规则对两者同样成立）。 */
  underline: (v) => wrap(v, "<u>", "</u>"),
  "inline-code": (v) => wrap(v, "`"),
  link: (v) => wrap(v, "[", "](https://)"),
  headings: headingCycle,
  list: (v) => linePrefix(v, "- "),
  "ordered-list": (v) => linePrefix(v, "", true),
  check: (v) => linePrefix(v, "- [ ] "),
  quote: (v) => linePrefix(v, "> "),
  indent: (v) => indentLines(v, +1),
  outdent: (v) => indentLines(v, -1),
  line: (v) => insertBlock(v, "---\n"),
  code: (v) => insertBlock(v, "```\n\n```\n"),
  "block-math": (v) => insertBlock(v, "$$\n\n$$\n"),
  table: (v) => insertBlock(v, "| 列一 | 列二 |\n| --- | --- |\n| 内容 | 内容 |\n"),
  "insert-before": (v) => insertBlankLine(v, true),
  "insert-after": (v) => insertBlankLine(v, false),
  undo: (v) => window.mpEngine?.history ? window.mpEngine.history('undo') : undo(v),
  redo: (v) => window.mpEngine?.history ? window.mpEngine.history('redo') : redo(v),
  /* 【P1-3·2026-10-10 由"人类常用操作普查"查出】原来是 `openSearchPanel(v); v.focus()`：
     面板 mount 时把焦点交给查找框，紧接着这一句 `v.focus()` 又抢回正文 ⇒ 实测点工具栏
     「查找替换 Ctrl+F」后 `focusIsSearchField=false`，用户接着敲的字符**落进了文档**
     （docLen 277→279，得 Ctrl+Z 才复位）。改成先给正文焦点、再开面板，
     让面板自己的聚焦成为最后一次写焦点（顺序即语义）。 */
  "find-replace": (v) => { v.focus(); openSearchPanel(v); },
  "theme-toggle": () => {
    // 【单一渲染事务】不再绕过面板直接看 editor-theme 自己翻：委托 window.mpTheme（唯一写者）。
    // 语义＝翻到**同族明暗邻居**；无邻居的两套（GitHub 深色 / 护眼米黄）回落到宋韵，由 mpTheme.sibling 定义。
    const cur = (() => { try { return localStorage.getItem("editor-theme") || "telari-dark"; } catch { return "telari-dark"; } })();
    if (window.mpTheme && window.mpTheme.apply) { window.mpTheme.apply(window.mpTheme.sibling(cur)); return; }
    const next = /dark$/.test(cur) ? "telari-light" : "telari-dark";
    if (window.mpEngine && window.mpEngine.setTheme) window.mpEngine.setTheme(next);
  },
};

/** 折叠态：持久化 ＋ 一键收起/展开。折叠后是**小圆岛**（外壳动画在 main.js 的 .mp-toolbar 规则里，
 *  只动 width/height/padding/圆角，由点击触发，不在键入路径上）。
 *
 *  【折叠位·2026-11-15】折叠态由 CSS 贴**编辑区右上角**（left:auto; right:12px，与展开态同一内边距），
 *  不再用 JS 写 translateX 去"追"滚动条。旧做法要在每次 resize 时标定位移比例 k：
 *  临时把 --mp-fold-shift 写成 0px、100px 各读一次 rect 再还原 —— 拖动分隔条时它每帧都跑，
 *  实测采样帧里能读到 transform 停在 100px、圆岛右缘与滚动条右缘的间距在 15~226px 之间跳，
 *  折叠柄的 x 在一次单向拖动里反向 160 次（用户看到的就是"按钮反复左右刷新闪动"）。
 *  CSS 锚定后：位置只由编辑区右界决定 ⇒ 拖动过程中平滑跟随，且没有中间写入。 */
const FOLD_KEY = "mp-toolbar-folded";
const isFolded = () => { try { return localStorage.getItem(FOLD_KEY) === "1"; } catch { return false; } };
function setFolded(bar, v) {
  bar.classList.toggle("is-folded", v);
  const btn = bar.querySelector(".mp-tb-fold");
  if (btn) {
    btn.title = v ? "展开工具栏" : "收起工具栏";
    btn.setAttribute("aria-label", btn.title);
  }
  try { localStorage.setItem(FOLD_KEY, v ? "1" : "0"); } catch { }
}

/** 建工具栏并挂到 iframe 顶部；返回卸载函数。 */
/* 【正文右键菜单复用·2026-10-10】把编辑动作表导出去：菜单与工具栏必须是**同一批实现**，
   否则就会出现"工具栏点了有用、菜单点了没反应"（实测根因：菜单走的是 toolbarClick，
   而那张 switch 里只有面板类命令，格式命令全落 default 返回 false）。 */
export const TOOLBAR_ACTIONS = Object.fromEntries(Object.entries(ACTIONS).map(([id, action]) => [id, v => {
  const commands = window.mpEngine?.commands;
  return commands ? commands.run(() => action(v), { focus: id === 'find-replace' ? 'control' : 'owner' }) : action(v);
}]));

export function installToolbar(view) {
  const bar = document.createElement("div");
  bar.className = "mp-toolbar";
  for (const item of ITEMS) {
    if (item.sep) { const s = document.createElement("span"); s.className = "mp-tb-sep"; bar.appendChild(s); continue; }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mp-tb-item" + (item.fold ? " mp-tb-fold" : "");
    btn.dataset.mpId = item.id;
    btn.innerHTML = item.icon;
    /* 【热路径纪律·2026-11-16】这里**只建 DOM**，绝不调用 toolbarClick：
       它是"执行用户命令"的入口（打开更多/导出/切换大纲…），而 installToolbar 在每次重开文档时
       都会再跑一遍 ⇒ 创建即触发会变成"菜单自己弹出、导出框自开"的点击副作用。
       是否已实现只看静态集合（ACTIONS / EXTRAS_IDS），与运行时的 window.mpExtras 无关。 */
    const done = !!ACTIONS[item.id] || EXTRAS_IDS.has(item.id);
    if (done) {
      btn.title = item.tip;
      btn.setAttribute("aria-label", item.tip);
      if (item.id === "more") btn.setAttribute("aria-haspopup", "menu");
      const runItem = (keyboard = false) => {
        /* 第三参是“激活来源”提示（弹层用它决定要不要把焦点交给首项），不是命令参数；
           外部调用仍可只传 (id, anchor)。 */
        if (window.mpExtras && window.mpExtras.toolbarClick(item.id, btn, { keyboard })) return;
        TOOLBAR_ACTIONS[item.id]?.(view);
      };
      btn.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        runItem(false);
      });
      /* 【键盘可达修复·2026-10-10（第三波 a11y-keyboard 族：31/32 按钮键盘不可达 ✗）】
         原来只绑 mousedown，而键盘激活 <button>（Enter/Space）走的是 **click** ⇒ 键盘用户把焦点
         移到按钮上按 Enter/Space **什么也不会发生**（族实测 31 个按钮激活无效；只有下面的折叠按钮
         有 detail===0 分支）。这里照它的范式补一条：**只接"键盘产生的 click"**（`detail === 0`），
         鼠标 click 的 detail >= 1 直接跳过（那条已由上面的 mousedown 处理）⇒ 不会双触发。 */
      btn.addEventListener("click", (e) => {
        if (e.detail !== 0) return;
        e.preventDefault(); e.stopPropagation();
        runItem(true);
      });
    } else {
      btn.disabled = true;
      btn.classList.add("is-todo");
      btn.title = `${item.tip} · CM6 暂未实现：${NOT_YET[item.id] || "未接"}`;
    }
    if (item.fold) {
      btn.disabled = false;
      btn.classList.remove("is-todo");
      btn.title = "收起工具栏";
      btn.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation(); setFolded(bar, !bar.classList.contains("is-folded"));
      });
      /* 【键盘可达·2026-10-09】折叠原先只绑 mousedown，而键盘激活 <button>（Enter/Space）走的是 click
         ⇒ 键盘用户**根本折不动**（实测：聚焦后 Enter/Space 三次 folded 都是 true）。
         这里只接"键盘产生的 click"：键盘激活的 click `detail === 0`、鼠标点击 `detail >= 1`
         （鼠标那条已由上面的 mousedown 处理）⇒ 用 detail 判别可**确定性**地避免鼠标双触发
         ——若改成 click 全接，鼠标会 mousedown + click 各折一次 = 看起来"没反应"。 */
      btn.addEventListener("click", (e) => {
        if (e.detail !== 0) return;
        e.preventDefault(); e.stopPropagation();
        setFolded(bar, !bar.classList.contains("is-folded"));
      });
    }
    bar.appendChild(btn);
  }
  setFolded(bar, isFolded());   // 恢复上次的折叠态（在挂载前设好，避免首帧"先展开再收起"的跳变）
  document.body.appendChild(bar);
  /* ── 展开态"能不能单行"：按真实宽度分档，带迟滞 ──────────────────────────────
   * 岛是 fit-content + 居中：宽度每跨一次换行阈值，整行按钮就会横向重排（居中的行
   * 变宽/变窄都会让按钮左右跳）。拖动分隔条时宽度连续变化，临界点附近
   * "折一行 ↔ 不折"会来回切 —— 用户看到的就是按钮反复左右闪。
   * 这里把"单行 / 多行"变成显式状态 data-mp-fit：
   *   needed ≤ available           → row  （单行，CSS 钉 flex-wrap:nowrap）
   *   needed >  available          → stack（多行；CSS 把岛宽钉满，行宽不再随换行次数变）
   * 迟滞 12px：从 stack 回到 row 需要"确实富余"，单次单向拖动只切一次。
   * 不隐藏任何按钮、不延迟拖动、不改松手后的定位；只让换行决策稳定。 */
  const FIT_JOIN_SLACK = 12;
  const fitNeeded = () => {
    // 逐项量（屏幕 px，含 zoom），gap/padding 同坐标系 ⇒ 与可用宽可直接比较。
    const cs = getComputedStyle(bar);
    const gap = parseFloat(cs.columnGap) || 0;
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    let total = padL + padR;
    let n = 0;
    for (const kid of bar.children) {
      const r = kid.getBoundingClientRect();
      if (!(r.width > 0)) continue;
      const kcs = getComputedStyle(kid);
      total += r.width + (parseFloat(kcs.marginLeft) || 0) + (parseFloat(kcs.marginRight) || 0);
      n += 1;
    }
    return total + Math.max(0, n - 1) * gap;
  };
  const syncFit = () => {
    if (bar.classList.contains("is-folded")) return;
    const available = document.documentElement.clientWidth - 24;   // 与 left/right:12px 同一内边距
    if (!(available > 0)) return;
    const needed = fitNeeded();
    const prev = bar.getAttribute("data-mp-fit") || "";
    let next;
    if (prev === "stack") next = needed <= available - FIT_JOIN_SLACK ? "row" : "stack";
    else next = needed <= available ? "row" : "stack";
    // 只有真的量到盒子才写：折叠动画中间态/display:none 时 needed 不可信。
    if (!(needed > 0)) return;
    if (next !== prev) bar.setAttribute("data-mp-fit", next);
  };
  // 高度联动：换行后条会变高，正文 padding-top 必须跟着走（否则正文被压住）
  const sync = () => {
    const h = Math.ceil(bar.getBoundingClientRect().height) || 32;
    document.documentElement.style.setProperty("--mp-toolbar-h", h + "px");
    syncFit();
  };
  sync();
  let ro = null;
  try { ro = new ResizeObserver(sync); ro.observe(bar); } catch { }
  /* 【窗口级兜底·2026-10-09】折叠态的 bar 盒子被 .is-folded 钉成 --mp-toolbar-fold(35px) ⇒ 它**不随窗口变**
     ⇒ 只 observe(bar) 的 ResizeObserver 在"折叠 + 拖动窗口"时**根本不响**；而展开态的盒子随窗口变，
     RO 会响。两种态都要在窗口 resize 时重算（折叠态位置现由 CSS 锚定，无需 JS 位移）。
     rAF 去抖：resize 事件密集，sync() 内含布局读取。 */
  let rafSync = 0;
  const onWinResize = () => {
    if (rafSync) return;
    rafSync = requestAnimationFrame(() => { rafSync = 0; sync(); });
  };
  window.addEventListener("resize", onWinResize);
  return () => {
    try { if (rafSync) cancelAnimationFrame(rafSync); } catch { }
    try { window.removeEventListener("resize", onWinResize); } catch { }
    try { if (ro) ro.disconnect(); } catch { }
    try { document.documentElement.style.removeProperty("--mp-toolbar-h"); } catch { }
    try { bar.remove(); } catch { }
  };
}
