# first-run-settings 族 · 真实用户日常操作普查（第二波）

**族名**：first-run-settings（首次运行与设置）
**被测产物**：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`
**产物指纹**：sha256 前 16 位 = `15b8a1b699a0782e`（探针启动前断言并打印；不符即拒绝出数）
**判据数**：75 条（probe-1 56 条 + probe-2 19 条）+ probe-3 一条补验；正式启动 6 次（全新 profile → 重启 → 再重启；定向复核 2 次；补验 1 次）+ 侦察 1 次
**输入通道**：`page.mouse`（真实按下/移动/抬起、真实拖动、真实滚轮滚面板、真实右键）、`page.keyboard`；工具栏按钮一律真实鼠标点击（「更多」绑的是 mousedown）
**读数口径**：一组相关读数一次 `evaluate` 拿全；判据读"最终状态"（DOM value / 读数标签 / CSS 变量 / localStorage / 主进程 settings.json / 消费者的 computed style + **可见性**）
**环境**：本机锁屏态，系统剪贴板对所有进程不可用；本族无用例依赖跨系统剪贴板，未受影响

---

## 一、通过面（摘要，均有读数）

| 组 | 用例 | 关键读数 |
|---|---|---|
| 首启形态 | 5 | 首启无 settings.json（`settings:load-failed ENOENT` 后回落默认）；`restore-last enabled=true`；:root 八个表面变量 = 注册表默认（.76/10px、65%/7px、78%/10px、88%、100%）；状态栏可见、版心 = 窗口宽×74%（1167→864px） |
| 面板逐项枚举 | 3 | 真实「更多→设置」打开：11 条滑杆（表面 8 + 版式 3）+ 2 复选 + 7 单选 + 4 按钮；滑杆集合/上下限/步长/标签与注册表逐项相等；无"HTML 中值回退"迹象 |
| 8 条表面滑杆逐项真实拖动 | 8+2 | 8/8：值变了，且 **值 = 读数标签 = :root 变量 = localStorage**；工具岛那两条还验了消费者——面板一改，`.mp-toolbar` 真实底色 alpha 与 `backdrop-filter blur()` 立即跟着变 |
| 版式 3 条 + 状态栏 | 4 | pageWidth→`.cm-content` 视觉宽 817px（= min(1167×70%, 1240)）；zoom→`.cm-editor` computed zoom=2；island→`.mp-toolbar` zoom=1.2；状态栏取消勾选后 `display:none` + `html[data-mp-statusbar]=0` + 存储 0 |
| 单选 3 组 | 8 | 大纲 左/右/浮层：存储 + `html[data-mp-dock]` 即时变，真实点工具栏「大纲」分别出现左/右停靠列；图片策略→inline 立即写存储并给回执；排版 Knuth–Plass→立即进阅读态（`data-mp-reading=1`）；Esc 能退出且设置面板不响应 Esc |
| 只读项 | 3 | 11 个读数标签都是 `SPAN`（不可编辑）且随滑杆同步；「Typora 主题 当前：未安装」+ 无主题时「移除」置灰；壳层通道只读契约——渲染侧写 `recentFiles` 被拒 `{ok:false,error:'readonly-key'}`，写白名单键 `restoreLast` 成功 |
| 面板内导航 | 1 | 真实点「快捷键设置…」→ 打开快捷键面板（8 个键位） |
| 消费者视觉 | 4 | 右键菜单 `.mp-pop-menu` alpha=0.56 == `--mp-context-menu-alpha`；大纲浮层 `.mp-outline` alpha=0.52/blur=5 == 两个变量；公式浮框 `.mp-inline-float`（真实键入 `$a+b$`、光标进公式）blur=62px == 变量（见 FS-1）；表格浮动条 `.mp-table-bar`（probe-3 补验）display:flex、822×22、alpha=0.62 == `--mp-table-bar-alpha` |
| 重启后保持 | 11 | 8 条表面偏好 + 3 条版式偏好在 :root/localStorage 全在；工具岛真实底色/模糊、版心/缩放/岛尺寸视觉形态全在；大纲/图片/排版三项偏好全在；状态栏"关闭"这个非默认值也在；壳层 `settings.json` 的 `restoreLast=false` 在磁盘上；主进程日志最后一条 `restore-last {"enabled":false}` |
| 面板重开回填 | 2 | 11 条滑杆的值与标签都回填成重启前的值（非默认）；两个复选框回填为未勾选 |
| 同源（菜单 ↔ 面板） | 3 | 菜单「整体不透明度」显示值与面板读同一份 `mp-surfaces`；菜单里真实拖动后重开面板，8 条表面滑杆全部跟到同一新值（面板不是缓存） |
| 恢复默认 | 3 | 真实点击后 11 条滑杆立即回默认（值/标签/变量），`mp-surfaces` 与 `mp-pref-*` 键被清；当前窗口视觉立即回默认（工具岛 .76/10px、版心 74%、缩放 100%、岛 100%、状态栏回可见）；重启后仍是默认 |
| 收尾 | 4 | 6 次启动全部真实关窗（WM_CLOSE）；带判据的 4 次都自行退出，无"未保存"弹窗阻塞 |

---

## 二、没反应 / 行为不符预期（带关键读数）

### FS-1【真缺陷】「更多 → 整体不透明度」把 0–100 的百分数写进**所有**表面项，含"背景模糊"：越界 + 面板自相矛盾 + 跨重启不自愈

**复现**：全新 profile → 设置面板把「公式预渲染框·不透明度」真实拖到 30% → 关面板 → 「更多」菜单里把**整体不透明度**真实拖到 62。
**读数**（probe-2，sha16 15b8a1b699a0782e）：

- 存储：`mp-surfaces = {"float":{"alpha":62,"blur":62},"outline":{"alpha":62,"tbalpha":62,"ctxalpha":62,"blur":62},"toolbar":{"alpha":62,"blur":62}}`
- :root 变量：`--mp-float-blur: 62px`、`--mp-outline-blur: 62px`、`--mp-surface-blur: 62px` —— 而面板自己声明的合法区间是 **0–24 / 0–24 / 0–30**
- 重开面板当场打架：`float.blur 滑杆=24(上限24) 但读数标签="62px"`；`outline.blur 24 / "62px"`；`toolbar.blur 30 / "62px"`（截图 `FS1-panel-blur-mismatch.png`：模糊滑杆顶到轨道最右，数字写 62px）
- 越界值真的生效（不是只写了个变量）：挂上消费者后 `.mp-inline-float` 的 `backdrop-filter = blur(62px) saturate(1.05)`（公式浮框真实可见，截图 `FS1-float-blur62.png`）；`.mp-outline` = `blur(62px) saturate(1.15)`
- 跨重启不自愈：重启后 `--mp-outline-blur` 仍 62px、`--mp-surface-blur` 仍 62px，面板那两行仍是"滑杆顶格 / 标签 62px"（截图 `FS1-panel-after-restart.png`）
- 用户自救存在但只救得动一行：在面板里拖一下该行 → `float.blur=13`，值/标签/变量重新自洽（`13px/13px/13px`）且跨重启保留；**没碰过的另两行脏值不会消失**

**代码位置**（只读核对，未改）：`dsh-markpilot/src-cm6/extras.js` 菜单内联滑杆的 `setAll(v)` —— 它把同一个 val 写进 `SURFACES` 里**每一个** item（`st[s.key][it.id] = val`），没有按各项 `min/max` 钳制；而"背景模糊"项的区间是 0–24 / 0–30。面板侧读回原值 62 → `it.fmt(62) = "62px"` 进标签，滑杆自身被 HTML `max` 钳到 24/30 ⇒ 一个值、两处口径分叉。

### FS-2【口径待裁决】「恢复默认」只清 `mp-surfaces` 与 `mp-pref-*`，面板里另外四项不回默认

**读数**：真实点击「恢复默认」后，11 条滑杆/两个存储键都正确回默认；但同一面板里的「打开上次的文件」仍是**未勾选**（磁盘 `settings.json restoreLast=false`）、大纲样式/图片策略/排版美化三项 `localStorage` 键**一个都没被触碰**；再重启一次依然如此（图片策略=inline 保留、`restoreLast` 仍未勾选）。按钮文案是「恢复默认」且面板里没有任何范围说明 —— 与用户对"整面板恢复默认"的预期不符（源码注释显示是有意只补了版式四项，其余未纳入）。

### FS-3【观察】逐项调过之后，菜单那行仍叫「整体不透明度」并显示"公式框"那一项的值

**读数**：面板里逐项拖到 公式框=30% / 工具岛=48% 时，菜单显示 `30%`（= `SURFACES[0].items[0]`）。此时三项并不相等，用户看到的是一个不存在的"整体值"。

---

## 三、未验证项

1. **Typora 主题「安装 .css…」**：该按钮会拉起原生文件对话框（会把渲染侧 invoke 挂死），未点击；只验证了无主题时「移除」置灰。
2. 「恢复默认」的**跨重启**结论有 C 段实测（第三次启动仍是默认值）；但"越界脏值 62px 是否影响导出/打印"超出本族范围，未测。

### 已补齐：表格浮动条消费者（probe-3）
probe-1 的 `A10.4` 曾判"绿"，属**假绿**——它只读 computed style，而 `.mp-table-bar` 是常驻节点（`display:none` 时底色照样解析得出来），我已就地标注。probe-2 加上可见性闸门后仍读不到（键入的表被改写、光标不在表内）。probe-3 逐行真实键入并试了三种"把光标放进表格"的真人手法，最终用 `ArrowUp` 进表：`.mp-table-bar` **display:flex、rect 172,154 822×22、可见**，底色 alpha = **0.62** == `--mp-table-bar-alpha`（62%）⇒ 该"设置项 → 当前窗口即时视觉"链路**验证通过**（截图 `shots/FS1-table-bar-visible.png`）。

**顺带观察（不属本族范围，不作为判定）**：脚本按字面逐行键入 `| A | B |` / `| --- | --- |` / `| 1 | 2 |`（每行后回车）时，最终源码与键入序列不一致（`"\n-- | --- |\n| 1 | 2 |\n\n\n| A | B |\n| -"`），疑似"自动补分隔行"与"字面键入的分隔行"叠加所致；交表格族用真人节奏复核。

---

## 四、探针自身的错（已改正并复跑，避免把探针缺陷记成产品缺陷）

1. probe-1 的 `A1.1/B1.1` 正则写成 `/"restore-last"/`（带引号），而主进程日志行是 `restore-last {...}`（无引号）⇒ **两条误红**。改正为 `/restore-last\s*\{/` 后复跑：首启最后一条 `enabled:true`、重启后最后一条 `enabled:false`，两条判据成立（probe-2 `FIX-A1/FIX-B1`）。
2. probe-2 的 `FIX-B3/FIX-B4` 期望值写错（忽略了 FS-1 里"自救"后 `float.blur=13`）⇒ 两条误红；实测数据反而更强：`float.blur` 13px（自救值跨重启保留）、`outline.blur`/`toolbar.blur` 仍是 62px 脏值。
3. probe-1 的 `A10` 消费者读数原先只取 computed style，未查可见性 ⇒ 表格浮动条假绿（见上）。probe-2 起所有消费者读数带 `display/visibility/rect/getClientRects` 四道闸门。

---

## 五、pageerror / 崩溃 / 控制台

- `pageerror`：**0**（6 次启动合计，每次都装了监听）
- `console.error`：**0**
- 渲染进程崩溃（`page.on('crash')`）：**0**；无窗口僵死、无原生对话框阻塞
- 关窗：6 次启动共 6 次关窗；其中 4 次带"进程自行退出"判据（`A11.2` / `B4.4` / `FIX-C4` / probe-3）**全部通过**，`taskkill` 一次都没用到；另 2 次（probe-1 实例 C、probe-2 实例 B）收尾关窗后未再断言，进程树已按 profile 精确核对为空

---

## 六、证据文件（均在 `E:\MarkPilot\.mp-verify\checklist\` 下）

| 文件 | 内容 |
|---|---|
| `first-run-settings-recon.cjs` / `first-run-settings-out/recon.json` | 侦察：菜单路径、面板 DOM/几何/默认值原始读数 |
| `first-run-settings-probe-1.cjs` / `first-run-settings-out/first-run-settings-result.json` | 主普查 56 条判据的**全量原始读数**（含每次拖动的 from/to、通道、变量、存储、消费者） |
| `first-run-settings-out/probe-1-console.txt` | 主普查控制台逐条输出 |
| `first-run-settings-probe-2.cjs` / `first-run-settings-out/first-run-settings-result-2.json` | 定向复核 19 条判据（FS-1 缺陷刻画 + 消费者可见性闸门 + 改正后的两类判据） |
| `first-run-settings-out/probe-2-console.txt` | 定向复核控制台输出 |
| `first-run-settings-probe-3.cjs` / `first-run-settings-out/first-run-settings-result-3.json` | 补验：表格浮动条消费者（逐种手法把光标放进表格） |
| `first-run-settings-out/probe-3-console.txt` | 补验控制台输出 |
| `first-run-settings-out/shots/FS1-panel-blur-mismatch.png` | 面板截图：模糊滑杆顶格而标签写 62px（三条 blur 行同屏） |
| `first-run-settings-out/shots/FS1-float-blur62.png` | 公式浮框真实可见、其 backdrop-filter 为越界 blur(62px) |
| `first-run-settings-out/shots/FS1-panel-after-restart.png` | 重启后面板：版式回默认、图片策略/排版未变、「打开上次的文件」仍未勾选 |
| `first-run-settings-out/shots/FS1-table-bar-visible.png` | 表格浮动条真实可见（alpha 0.62） |

**复现命令**（工作目录 `E:\MarkPilot\.mp-verify\checklist`）：

```
node first-run-settings-recon.cjs
node first-run-settings-probe-1.cjs
node first-run-settings-probe-2.cjs
node first-run-settings-probe-3.cjs
```

---

## 七、纪律自检

- 只在 `.mp-verify\checklist\` 下写文件；`src-cm6/`、`MarkPilot-CM6/` 只读（产品源码 mtime 全部早于本轮开始时间，`git status` 里的改动项均非本轮产生）
- 输入全走真实通道；工具栏按钮（更多/大纲）为真实鼠标按下-抬起；滚动面板用真实滚轮，未用 `scrollIntoView`
- 一组读数一次 `evaluate` 拿全；断言"拿到的不是默认回退值"（面板必须在场、滑杆数必须为 11、标签必须等于 `fmt(value)`，否则抛错不出数）
- 关窗后判断存活一律走主进程事实（命令行里的 `--user-data-dir` 精确定位 + `tasklist` + `main-debug.log`），未用渲染侧超时反推
- 全部自起进程已 `taskkill`（按 profile 精确核对：**无残留**）
