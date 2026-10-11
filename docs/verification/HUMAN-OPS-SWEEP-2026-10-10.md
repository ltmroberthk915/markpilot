# 人类常用操作普查 · 缺陷总账（2026-10-10）

**被测产物**：`MarkPilot-CM6/dist/win-unpacked/MarkPilot.exe` sha16=`81b39273efae31e5`（3.2.0 便携版）
**规模**：13 族 / 约 500+ 条读数 / 探针全部在 `.mp-verify/checklist/`（前缀＝族名）
**纪律**：子代理只读产品代码、只写 `.mp-verify/`、各自随机端口与独立 profile、结束 taskkill；各族报告原文见下表"报告"列。

## 一、P0 · 会毁数据（最高优先）

| # | 缺陷 | 族 / 证据 | 复现 |
|---|---|---|---|
| P0-1 | **把 `.png` 拖进窗口 ⇒ 当文本打开 ⇒ 打字后被就地改写 ⇒ 图片文件被毁**（495 B 合法 PNG → 882 B，魔数变 U+FFFD） | `link-and-image-daily` I2/I3（物证 `drop-copy.png` 两份）；`dragdrop-files` F-3 **独立复现同一现象** | 稳定 |
| P0-2 | **复选框勾选后再位移文档，点同一复选框会把正文写坏**（「甲」整段消失、widget 消失） | `list-continuation` ①（截图 R1-after-second-click.png）；成因定位：`lists.js:16` 的 `eq()` 只比 `checked` 不比 `from/to`，而 `from/to` 烘进 DOM dataset ⇒ CM6 复用旧 DOM，点击按陈旧区间改写 | 6/6 |
| P0-3 | **脏文档拖入"正在编辑的同一文件"→ 确认框点「取消」→ 文档与磁盘仍被写入被拖文件内容** | `dragdrop-files` F-1（trace 自证该 drop 没走 openPath，破坏来自**引擎自己的 drop 插入**＋去抖自动保存） | 6/6 |
| P0-4 | **表格行内（无覆盖层）粘 TSV ⇒ 原表被劈开**；**正文行粘 TSV ⇒ 该行剩余文字被吞进表末行（屏幕上消失）** | `table-daily` ④★/⑤（源码逐行 + 渲染行读数） | 稳定 |

## 二、P1 · 日常操作直接受影响

| # | 缺陷 | 族 | 关键读数 / 定位 |
|---|---|---|---|
| P1-1 | **启动后编辑器无焦点：不点正文直接打字/回车/Ctrl+End 全不落字**（Typora 是"打开即可打字"） | `undo-redo-chain` ② **＋** `find-replace` ① **＋** `startup-and-menus`（三族独立命中） | `document.hasFocus()=true` 但 `activeElement=BODY`；点一次正文即恢复。Ctrl+F 同理完全没反应 |
| P1-2 | **「保存并退出」保存成功但窗口不退** | `autosave-crash-recovery` ①（含代码定位） | `main.js:709` 只 `send('menu','save')` 后 `return`，指望 `W.__pendingClose`；**全仓无处置 true** ⇒ 永不关窗 |
| P1-3 | **工具栏「查找替换」按钮打开面板后焦点不在查找框，随后键入落进正文** | `find-replace` ② | `toolbar.js:193` `openSearchPanel(v); v.focus()` —— 面板 mount 聚焦查找框后又被 `v.focus()` 抢回 |
| P1-4 | **空列表项回车不退出列表**（与 `lists.js:71` 自己的注释承诺不符） | `list-continuation` ② | 17 条事务 trace：Enter 的 dispatch **全部**来自 `lang-markdown` 的 `insertNewlineContinueMarkup`；`lists.js` 的 `enterContinueList` 一次没被调度 ⇒ **扩展顺序**：`markdown()` 排在 `listSemantics` 前（`tables.js:390` 记过同款教训，那里用了 `Prec.high`） |
| P1-5 | **Ctrl+W 完全无反应**（不关窗、不提示） | `startup-and-menus` ① | 菜单模板无 Ctrl+W 项、渲染侧无 beforeunload；两条注入通道均无反应 |
| P1-6 | **工具栏「代码块」按钮插入后光标落在块外**（紧接着打字落在普通段落） | `code-fence-daily` CF-7/7b | 点后 Δ10，caret 在闭合围栏**下一行空行**；r1/r2/r4/r5 一致 |
| P1-7 | **Ctrl+End 到文末后光标整条被状态栏盖住**（距滚动极限还差 ~28px） | `window-states` ① | 光标 y=377.9 vs 状态栏顶 374.3；文档比视口长就中，与窗口大小无关 |
| P1-8 | **大纲点「第一条」不滚动**：光标到第 1 行，视口纹丝不动（留在屏外 3 万像素） | `long-doc-navigation` ② | 文末→点首条 4/4「scrollTop 30172.6 不变」；点第 2/3 条正常；页面内复刻同一序列**滚动生效** ⇒ 丢在真实点击路径（具体哪步未验证） |

## 三、P2 · 体验/一致性

| # | 缺陷 | 族 |
|---|---|---|
| P2-1 | `Ctrl+K` **无绑定**（工具栏 title 承诺"链接 Ctrl+K"），且「快捷键设置」白名单里没有 `link` ⇒ 用户也改不了 | `link-and-image-daily` L1/D |
| P2-2 | **Ctrl+点击链接不打开**（文档里根本没有 `<a>` 元素，`openExternal` 调用 0） | `link-and-image-daily` L5 |
| P2-3 | 表格：**方向键不跨格**；**Shift+Tab 表头首格静默顶停**；**粘贴多行 TSV 被拒**（产品有意止血，但"扩行"无入口） | `table-daily` |
| P2-4 | 阅读模式下**光标没被隐掉**（CSS 有 `display:none`，计算样式仍 `block`） | `window-states` ③ |
| P2-5 | 退出阅读模式后光标最长 ~1s 仍画在旧位置（偏上 ~25px） | `window-states` ② |
| P2-6 | 「最近打开」里被删文件**静默消失**，与注释承诺的「(文件不存在)」不符 | `startup-and-menus` ③ |
| P2-7 | 拖放后 ~0.5s **无条件写一次盘**（即使没改动，683 KB 文档也照写） | `dragdrop-files` F-2b |
| P2-8 | F11 未绑定（产品用工具栏按钮进全屏）；首启默认窗口超工作区 49 DIP | `window-states` ④/附记 |
| P2-9 | 替换全部后在查找框里 Ctrl+Z 撤不了文档（需点回正文） | `find-replace` ④ |
| P2-10 | 选中多行列表按 Tab 只缩进 head 那一行且折叠选区 | `list-continuation` ④ |

## 四、环境阻断（**本机工作站处于锁屏态**，不得当"通过"或"失败"）

- **系统剪贴板全线不可用**：`LogonUI.exe` 在跑（安全桌面占用输入桌面）⇒ `OpenClipboard` 返回 `err=5 拒绝访问`、`clip.exe` Access denied、`Get-Clipboard` 抛异常、`navigator.clipboard.readText()` 恒空；
  受影响族：`cross-window-clipboard`（X1/X2/X3/X5/X11）、`link-and-image-daily`（L4/I1）、`table-daily`（W1/W2）、`code-fence-daily`（CF-5）、`list-continuation`（⑥）、`undo-redo-chain`（粘贴 5/5）。
  ⇒ **必须在解锁的交互桌面上复跑**；探针自带环境体检，届时自动改判，无需改码。
- **真实资源管理器鼠标拖拽（OS 级 CF_HDROP）**未获授权 ⇒ 未测；CDP 拖放通道已自证 File→真实绝对路径。
- **物理 Windows IME** 未测（CDP 的 `imeSetComposition` 恒从 offset 0 合成、不产生真实合成事件）⇒ IME 族的 C1/C2/C6/C7 只能算"CDP 合成事件下的读数"。
- 原生菜单栏点击、原生对话框按钮（除 Win32 `BM_CLICK`）、多显示器 DPI 迁移、任务栏跳转列表可见性 ⇒ 通道受限未验证。

## 五、被推翻 / 更正（按 AGENTS 错-3 第 4 条保留）

- `dragdrop-files` 撤回 round1「拖到工具栏无反应」（合成拖拽太稀疏的通道伪影，密集 dragOver 3/3 正常）。
- `dragdrop-files` 撤回 round1 D7/D8（判据被前例污染 / 慢操作让自动保存先清 dirty）。
- `find-replace` 尺子错 4 处（手写期望值错 4 个数、查询真字段在 `state.query.spec.*`、invalid 正则下 `matchAll` 会抛、"粘贴不提交查询"被数据推翻）。
- 「Ctrl+B 插 4 个星号」：读数显示 **事务数=1、insert="****"** ⇒ 单事务内插成对标记，属**正常行为**（空选区加粗）；族报告称"两处绑定"的推断未被读数支持，记为**存疑**。

## 六、跨族交叉印证（可信度最高的一组）

| 现象 | 独立命中的族 |
|---|---|
| 启动后无焦点、不点正文打不了字 | `undo-redo-chain`、`find-replace`、`startup-and-menus` |
| 拖入非文本文件被当文档打开（并可能被改写） | `link-and-image-daily`、`dragdrop-files` |
| 剪贴板通道不可用（环境） | `cross-window-clipboard`、`link-and-image-daily`、`table-daily`、`code-fence-daily`、`list-continuation`、`undo-redo-chain` |
