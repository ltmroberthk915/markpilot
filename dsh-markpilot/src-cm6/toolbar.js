/** CM6 工具栏（对齐 v2.3.3 的可见集合，架构走 CM6 原生事务）。
 *
 *  口径（用户 2026-10-07 裁定·方案 B）：**按钮全摆上**；CM6 已实现的一律接线，
 *  未实现的**置灰 + 悬停标注「CM6 暂未实现（原因）」**，不给"点了没反应"的空按钮。
 *
 *  与 vditor 侧按钮一一对应（顺序同 renderer/js/toolbar.js:71 起）：
 *    outline / theme-settings / reading-palette / emoji / headings / bold / italic / strike /
 *    find-replace / link │ list / ordered-list / check / outdent / indent │ quote / line / code /
 *    inline-code / insert-before / insert-after │ upload / table │ undo / redo │
 *    fullscreen / shortcut-settings / edit-mode / source-toggle / reading-mode / document-export /
 *    more(surface) │ theme-toggle / toolbar-fold
 *    （「重新加载」2026-10-09 收进「更多」菜单，不再占工具栏槽位）
 *
 *  实现纪律：所有动作走 `view.dispatch`（撤销栈/版本守卫/桥同步自动成立），不碰 DOM 文本。
 */

import { undo, redo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";

const svg = (d, extra = "") => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" ${extra}><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** 未实现的按钮为什么没实现——悬停标注用（用户要求"置灰并标注"）。 */
/** 由扩展包（extras.js）接管的按钮 id：判定"已实现"用静态集合，不看运行时的 window.mpExtras。
 *  【2026-10-08】`surface-settings` 与 `reading-palette` 已从工具栏**移除**（用户要求收进「更多」菜单），
 *  所以这里不再登记——登记着却没有对应按钮只会让"已实现集合"与实际槽位对不上。 */
const EXTRAS_IDS = new Set(["more", "outline", "emoji", "theme-settings", "document-export", "shortcut-settings", "split", "fullscreen", "reading-mode", "theme-toggle",
  /* 【2026-10-09 接上】upload（图片）：由扩展包的 toolbarClick 接管 —— 单一语义＝只弹原生文件选择器。
     登记在这里才会走"已实现"分支（否则 done=false ⇒ 置灰 + is-todo + 不挂监听 = 点了没反应）。 */
  "upload"]);

const NOT_YET = {
  // 【已接】reading-mode / fullscreen / theme-toggle 不再列在这里（见 EXTRAS_IDS）
  // 【2026-10-09 已接】upload（图片）：接上扩展包的文件选择器（单一语义）；
  //                    reload（重新加载）：**不再占工具栏槽位**，改为「更多」菜单项 + 壳侧 file:reload 上行。
  // 【删掉的死按钮】edit-mode / source-toggle：CM6 的文档**本来就是 markdown 源文本直编**，
  // v2.3.3 的"源码模式 / 预览切换"在这里结构性不存在 ⇒ 留着只会永远灰着占位，直接不摆。
};

const ITEMS = [
  { id: "outline", tip: "大纲", icon: svg("M4 6h16M4 12h10M4 18h13") },
  { id: "theme-settings", tip: "主题", icon: svg("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0v18") },
  /* 【明暗切换·2026-10-08】① 位置：紧跟在「主题」之后（两者相邻，间距＝岛上标准间距）；
     ② 图标改成**太阳/月亮二态**，跟随当前明暗自动换：暗色主题显示"太阳"（点它变亮）、
        亮色主题显示"月亮"（点它变暗）——图标本身就是"点下去会得到什么"。
        图标在 setThemeIcon() 里按 dataset.mpDark 切换，主题一变（applyEditorTheme / mpTheme.apply）就刷新。 */
  { id: "theme-toggle", tip: "切换明暗（浅色 / 深色）", icon: svg("M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z") },
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
  { id: "insert-before", tip: "在光标行之前插入空行", icon: svg("M12 4v16M8 8l4-4 4 4") },
  { id: "insert-after", tip: "在光标行之后插入空行", icon: svg("M12 4v16M8 16l4 4 4-4") },
  { sep: true },
  { id: "upload", tip: "图片", icon: svg("M4 6h16v12H4zM8 12l3 3 2-2 3 3M9 9h.01") },
  { id: "table", tip: "表格", icon: svg("M4 5h16v14H4zM4 10h16M10 5v14") },
  { sep: true },
  { id: "undo", tip: "撤销 Ctrl+Z", icon: svg("M9 8H5V4M5 8a8 8 0 1 1-1 7") },
  { id: "redo", tip: "重做 Ctrl+Y", icon: svg("M15 8h4V4M19 8a8 8 0 1 0 1 7") },
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
  { id: "document-export", tip: "导出", icon: svg("M14 4h6v6M20 4l-9 9M18 14v5H5V6h5") },
  /* 【2026-10-09 撤出工具栏】reload（重新加载）已收进「更多」菜单（低频动作不占槽位），
     而且它的上行这次真接上了（壳侧 file:reload）—— 原来它是置灰的 is-todo 死按钮。 */
  /* 【「更多」挪到最右·2026-10-08】用户要求汉堡菜单从工具栏**最左**挪到**最右**：
     现在排在折叠按钮之前、是展开态里最靠右的一项；折叠按钮（`toolbar-fold`）再往后一格，
     收起后仍是最右边那颗小圆岛（J3 判据要求"靠右、右缝≈12"）——即：
       … 双开 │ 阅读模式 │ 导出 │ **更多** │ 折叠　（重新加载 2026-10-09 已收进「更多」菜单）
     "更多在最右"与"折叠永远可点"两条同时成立。 */
  { id: "more", tip: "更多（导出 / 设置 / 界面透明度 / 阅读模式 / 帮助 / 关于）", icon: svg("M6 12h.01M12 12h.01M18 12h.01") },
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
function wrapDelimLen(doc, from, to, open, close) {
  if (to > from && close === open && doc.sliceString(to, to + open.length) !== open) return 0;
  const l = doc.sliceString(Math.max(0, from - open.length), from), r = doc.sliceString(to, to + close.length);
  if (open === '**') {
    if (l === '**' && r === '**') return 2;
    if (l === '***' && r === '***') return 3;              // 粗斜体整体取消
    if (l.endsWith('*') && !l.endsWith('**') && r.startsWith('*') && !r.startsWith('**')) return 1;  // 取消"斜体里的粗体"：剥一层星
  }
  return l === open && r === close ? open.length : 0;
}

/** 包围选区的那个**内容跨度**（含内容、不含可能多出的外层斜体星）；没有则 null。 */
function enclosingSpan(doc, from, to, open, close) {
  const n = wrapDelimLen(doc, from, to, open, close);
  if (!n) return null;
  const outer = n > open.length;                            // 多出的那一层（`***a***` ⇒ 里层是 `**a**`）
  const f = from - outer, t = to + outer;
  return { from: f - n, to: t + n, innerFrom: f, innerTo: t, delim: n, esc: escapedAt(doc, f - n) };
}

/** 在选区两侧加上/去掉定界符。返回 true＝已处理（调用方不要再走别的分支）。 */
export function wrap(view, open, close = open) {
  const r = view.state.selection.main;
  const doc = view.state.doc;
  const sel = doc.sliceString(r.from, r.to);
  const span = enclosingSpan(doc, r.from, r.to, open, close);
  if (span && !span.esc) {
    /* 取消包裹：只删两侧定界符，中间的文本一个字节都不动。 */
    view.dispatch({
      changes: [{ from: span.from, to: span.from + span.delim, insert: '' }, { from: span.innerTo, to: span.to, insert: '' }],
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
  const st = view.state;
  const r = st.selection.main;
  const first = st.doc.lineAt(r.from).number;
  const last = st.doc.lineAt(r.to).number;
  const changes = [];
  let n = 0;
  /* 光标是否真的跟着"插入"走：只有**全部行都是插入**时才前移（任何一行是删除 ⇒ 不动，语义含混时不猜） */
  let allInsert = true;
  for (let i = first; i <= last; i++) {
    const line = st.doc.line(i);
    n++;
    /* 【普查实测·2026-10-10】有序列表传的是空前缀 ⇒ startsWith("") 恒真，永远走"删前缀"分支而 prefix 长度为 0 ⇒ 空操作。
     /* 空前缀一律视为"没有"，交给下面的 ordered 正则判定。 */
    const has = (prefix ? line.text.startsWith(prefix) : false) || (ordered && /^\d+\.\s/.test(line.text));
    if (has) {
      allInsert = false;
      const m = ordered && /^\d+\.\s/.test(line.text) ? /^\d+\.\s/.exec(line.text)[0] : prefix;
      changes.push({ from: line.from, to: line.from + m.length, insert: "" });
    } else {
      changes.push({ from: line.from, insert: ordered ? `${n}. ` : prefix });
    }
  }
  /* 有序列表的前缀长度按**首行**实际写入的串算（`1. ` 与 `12. ` 长度不同） */
  const written = ordered ? `${1}. `.length : prefix.length;
  const anchor = (allInsert && r.empty) ? r.head + written : undefined;
  view.dispatch({ changes, ...(anchor == null ? {} : { selection: { anchor } }), userEvent: "input.format", scrollIntoView: true });
  view.focus();
}

function headingCycle(view) {
  const st = view.state;
  const line = st.doc.lineAt(st.selection.main.head);
  const m = /^(#{1,6})\s/.exec(line.text);
  const next = !m ? "# " : m[1].length >= 6 ? "" : "#".repeat(m[1].length + 1) + " ";
  const to = m ? line.from + m[0].length : line.from;
  view.dispatch({ changes: { from: line.from, to, insert: next }, userEvent: "input.format" });
  view.focus();
}

function indentLines(view, delta) {
  const st = view.state;
  const r = st.selection.main;
  const first = st.doc.lineAt(r.from).number;
  const last = st.doc.lineAt(r.to).number;
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
  table: (v) => insertBlock(v, "| 列一 | 列二 |\n| --- | --- |\n| 内容 | 内容 |\n"),
  "insert-before": (v) => insertBlankLine(v, true),
  "insert-after": (v) => insertBlankLine(v, false),
  undo: (v) => { undo(v); v.focus(); },
  redo: (v) => { redo(v); v.focus(); },
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
 *  只动 width/height/padding/圆角，由点击触发，不在键入路径上）。 */
const FOLD_KEY = "mp-toolbar-folded";
const isFolded = () => { try { return localStorage.getItem(FOLD_KEY) === "1"; } catch { return false; } };
/* 折叠态：贴右上"上边缘"（top 不动），右向只保留"不压滚动条"所需的必要内缩。
   为什么不再用算术：clientWidth/2 - (12 + f/2) 把 12px 当"右边留缝"，而滚动条自身占 10px
   ⇒ 净余量只有 2px（实测 1.5px）—— 任何 DPI/字号/取整差异都会压上去，用户"有时压有时不压"即此。
   为什么必须实测标定：位移写在 --mp-fold-shift 上、由 transform: translateX(...) 消费，而 .mp-toolbar
   上还有 zoom: var(--mp-island-scale)，两者的换算关系不该靠猜 —— 这里给一个**已知位移 P**，量它在屏幕上
   实际走了多远，得到比例 k，再按 k 反算需要的位移。（标定期间临时关掉 transition，否则读到的是
   0.18s 动画的中间值。） */
let lastFoldShift = 0;                  /* 上一次算出的位移：标定退化时沿用它，别硬算 */
const foldShift = (bar, folded) => {
  if (!bar || folded === false) return 0;
  if (!(bar.offsetWidth > 0)) return lastFoldShift;     /* 无盒子（display:none 等）：沿用上次，不测量 */
  const GAP = 8;                        /* 圆岛右缘与滚动条之间的净间距 */
  let targetRight = null;
  try {
    const sc = document.querySelector(".cm-scroller");
    if (sc) {
      const sr = sc.getBoundingClientRect();
      const sbW = sc.offsetWidth - sc.clientWidth;    /* 滚动条槽宽：scrollbar-gutter:stable ⇒ 恒为 10 */
      /* 【无条件减槽宽·2026-10-09】改前按"此刻是否真的显示滚动条"分支：无滚动条时右缘会伸进
         恒定保留的 gutter 里 2.5px，之后再输入到出现滚动条时位移又不重算 ⇒ 交集 2.5×35 ≈ 87.5px²
         （对抗复核实测）。统一减 sbW 后，位置与"滚动条此刻在不在"解耦。 */
      targetRight = sr.right - sbW - GAP;
    }
  } catch { }
  if (targetRight == null) {
    /* 量不到编辑面（异常情形）：沿用旧算术，保持与历史一致，不引入新行为 */
    let f = 35;
    try {
      const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mp-toolbar-fold'));
      if (Number.isFinite(v) && v > 0) f = v;
    } catch { }
    return Math.max(0, Math.round(document.documentElement.clientWidth / 2 - (12 + f / 2)));
  }
  const wasFolded = bar.classList.contains("is-folded");
  const prevShift = bar.style.getPropertyValue("--mp-fold-shift");
  const prevTr = bar.style.transition;
  bar.style.transition = "none";        /* 标定期间不许动画 */
  if (!wasFolded) bar.classList.add("is-folded");
  bar.style.setProperty("--mp-fold-shift", "0px");
  const baseRight = bar.getBoundingClientRect().right;
  const P = 100;                        /* 参考位移：由它量出"每 1px 位移 = 多少屏幕像素" */
  bar.style.setProperty("--mp-fold-shift", P + "px");
  const probeRight = bar.getBoundingClientRect().right;
  bar.style.setProperty("--mp-fold-shift", prevShift);
  bar.style.transition = prevTr;
  if (!wasFolded) bar.classList.remove("is-folded");
  const k = (probeRight - baseRight) / P;
  /* 【标定退化】量不出位移（rect 全 0 等）⇒ 沿用上次位移；不要拿 k=1 硬算
     （实测那样会写出 1148px 这种离谱值，要等下一次 ResizeObserver 才自愈）。 */
  if (!(Math.abs(k) > 1e-3)) return lastFoldShift;
  const v = Math.max(0, Math.round((targetRight - baseRight) / k));
  lastFoldShift = v;
  return v;
};
function setFolded(bar, v) {
  bar.classList.toggle("is-folded", v);
  bar.style.setProperty("--mp-fold-shift", foldShift(bar, v) + "px");
  const btn = bar.querySelector(".mp-tb-fold");
  if (btn) btn.title = v ? "展开工具栏" : "收起工具栏";
  try { localStorage.setItem(FOLD_KEY, v ? "1" : "0"); } catch { }
}

/* ── 明暗切换图标（太阳/月亮二态）────────────────────────────────────────────
 *  为什么跟随状态：图标＝"点下去会得到什么"。当前是**深色** ⇒ 显示**太阳**（点它变亮）；
 *  当前是**浅色** ⇒ 显示**月亮**（点它变暗）。
 *  判定源：`html[data-mode]`（`themeApply()` 写的单一真源，值就是 'dark'/'light'）+ `data-editor-theme`。
 *  用 MutationObserver 盯这两个属性 ⇒ 不管主题从工具栏、设置面板还是壳层菜单切的，图标都会跟上。
 *  （比"点击时自己翻转"可靠：主题应用的唯一写者不是工具栏。） */
const SUN_PATH = "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z";
const MOON_PATH = "M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1Z";
function isDarkNow() {
  try {
    const root = document.documentElement;
    const mode = root.dataset.mode;
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    const id = root.dataset.editorTheme || '';
    if (/-dark$/.test(id)) return true;
    if (/-light$/.test(id)) return false;
    // 兜底：按主题登记表问一次（它才是"当前配色"的权威）
    const mt = window.mpTheme;
    if (mt && mt.current && mt.byId) { const p = mt.byId(mt.current()); if (p) return !!p.dark; }
    // 最后兜底：底色的明度（白底=浅色）
    const bg = getComputedStyle(root).getPropertyValue('--mp-bg').trim();
    const m = /^#([0-9a-f]{6})$/i.exec(bg);
    if (m) { const n = parseInt(m[1], 16); const lum = ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114; return lum < 140; }
  } catch { /* 读不到就按深色（默认主题是深色） */ }
  return true;
}
function setThemeIcon(btn) {
  if (!btn) return;
  const dark = isDarkNow();
  btn.innerHTML = svg(dark ? SUN_PATH : MOON_PATH);
  btn.title = dark ? '切换到浅色模式（当前：深色）' : '切换到深色模式（当前：浅色）';
  btn.setAttribute('aria-label', btn.title);
  btn.dataset.mpDarkNow = dark ? '1' : '0';
}

/** 建工具栏并挂到 iframe 顶部；返回卸载函数。 */
/* 【正文右键菜单复用·2026-10-10】把编辑动作表导出去：菜单与工具栏必须是**同一批实现**，
   否则就会出现"工具栏点了有用、菜单点了没反应"（实测根因：菜单走的是 toolbarClick，
   而那张 switch 里只有面板类命令，格式命令全落 default 返回 false）。 */
export const TOOLBAR_ACTIONS = ACTIONS;

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
    const ext = window.mpExtras && window.mpExtras.toolbarClick ? window.mpExtras.toolbarClick(item.id, btn) : false;
    // 【纪律】不能在这里调用 toolbarClick 判定"是否已实现"：按钮创建那一刻 window.mpExtras
    // 还没挂上（installExtras 在 installToolbar 之后跑），"更多"会被误判成未实现而置灰（实测踩坑）。
    const done = !!ACTIONS[item.id] || EXTRAS_IDS.has(item.id);
    if (done) {
      btn.title = item.tip;
      const runItem = () => {
        if (window.mpExtras && window.mpExtras.toolbarClick(item.id, btn)) return;
        ACTIONS[item.id](view);
      };
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        runItem();
      });
      /* 【键盘可达修复·2026-10-10（第三波 a11y-keyboard 族：31/32 按钮键盘不可达 ✗）】
         原来只绑 mousedown，而键盘激活 <button>（Enter/Space）走的是 **click** ⇒ 键盘用户把焦点
         移到按钮上按 Enter/Space **什么也不会发生**（族实测 31 个按钮激活无效；只有下面的折叠按钮
         有 detail===0 分支）。这里照它的范式补一条：**只接"键盘产生的 click"**（`detail === 0`），
         鼠标 click 的 detail >= 1 直接跳过（那条已由上面的 mousedown 处理）⇒ 不会双触发。 */
      btn.addEventListener("click", (e) => {
        if (e.detail !== 0) return;
        e.preventDefault(); e.stopPropagation();
        runItem();
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
      btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); setFolded(bar, !bar.classList.contains("is-folded")); });
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
    if (item.id === "theme-toggle") {
      btn.setAttribute("aria-label", "切换明暗");
      setThemeIcon(btn);
      btn.addEventListener("mousedown", () => { setTimeout(() => setThemeIcon(btn), 0); });
    }
    bar.appendChild(btn);
  }
  setFolded(bar, isFolded());   // 恢复上次的折叠态（在挂载前设好，避免首帧"先展开再收起"的跳变）
  document.body.appendChild(bar);
  /* 明暗图标的跟随：盯主题的单一真源回显（`html[data-mode]` / `html[data-editor-theme]`）。 */
  const themeBtn = bar.querySelector('.mp-tb-item[data-mp-id="theme-toggle"]');
  let mo = null;
  try {
    mo = new MutationObserver(() => setThemeIcon(themeBtn));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-editor-theme"] });
  } catch { /* 没有 MutationObserver：至少初次正确 */ }
  setThemeIcon(themeBtn);
  // 高度联动：换行后条会变高，正文 padding-top 必须跟着走（否则正文被压住）
  const sync = () => {
    const h = Math.ceil(bar.getBoundingClientRect().height) || 32;
    document.documentElement.style.setProperty("--mp-toolbar-h", h + "px");
    // 视口宽度变了 ⇒ 折叠态的位移量要重算（否则小圆会偏离右边缝）
    if (bar.classList.contains("is-folded")) bar.style.setProperty("--mp-fold-shift", foldShift(bar, true) + "px");
  };
  sync();
  let ro = null;
  try { ro = new ResizeObserver(sync); ro.observe(bar); } catch { }
  /* 【窗口级兜底·2026-10-09】折叠态的 bar 盒子被 .is-folded 钉成 --mp-toolbar-fold(35px) ⇒ 它**不随窗口变**
     ⇒ 只 observe(bar) 的 ResizeObserver 在"折叠 + 拖动窗口"时**根本不响**。实测：窗口 1200→900（变了 500px）
     位移恒 548px，宽 886 时圆岛右缘 1008.5 已在视口外、右余量 −132.5；而**展开态**（bar 会随窗口变宽）
     RO 会响（--mp-toolbar-h 32→57）⇒ 这条缺口是**折叠态特有**的，所以窗口监听必须**无条件**挂上，
     不能只放在 ResizeObserver 构造失败的 catch 分支里。
     rAF 去抖：resize 事件密集，而 sync() 内含强制布局读取（foldShift 标定要连读两次 rect）。 */
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
    try { if (mo) mo.disconnect(); } catch { }
    try { document.documentElement.style.removeProperty("--mp-toolbar-h"); } catch { }
    try { bar.remove(); } catch { }
  };
}
