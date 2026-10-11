# 族报告 · code-fence-daily（代码块日常）

- 被测产物：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`，sha16 = **81b39273efae31e5**（188,784,128 B）
- 探针：`E:\MarkPilot\.mp-verify\checklist\code-fence-daily.cjs`（启动范式同 `_probe-cdp-load.cjs`：spawn + 随机 CDP 端口 + 独立 profile + MP_DEBUG=1 + 删 `ELECTRON_RUN_AS_NODE`；输入全部真实通道 `page.keyboard` / `page.mouse`）
- 权威轮次：**r5**（2026-10-10 09:09–09:11 本地；完整跑完，0 pageerror）；r3 被外部 `taskkill` 掐断（记录在案，见下）
- 用例总数：**16**（ok 9 / off 4 / unverified 4，含 2 条对照臂与 1 条环境记录）

## 一、结论表

| 编号 | 用例 | 判定 | 读数要点 |
|---|---|---|---|
| CF-1 | ``` + 语言 + 回车 ⇒ 进代码块 | ok | 打完 ` ```js ` 后回车：` ```js ` 行落 `mp-fence mp-code`；光标行 = 代码行（`mp-code`、无 `mp-fence`、`data-mp-n=1`）、caret 列 0 |
| CF-3 | 代码块内回车不退出 | ok | 回车前 caret L16 → 后 L17（严格下一行）；两行均为 `mp-code`，号 1/2；未退出围栏 |
| **CF-2** | **代码块内 Tab 插缩进（不跳焦点）** | **off（没反应）** | 文档 139→139 **零改动**；`Tab` 的 keydown 到了编辑面（`prevented=false`）但无人消费；**焦点被浏览器焦点遍历带走**：`focusin → BUTTON.mp-tb-item[title=大纲]`（`inContent=false`） |
| **CF-2b** | 代码块内 Shift+Tab（对照臂） | **off（没反应）** | 点回编辑面后 caret L17 col 12；Shift+Tab 后文档仍零改动，`focusin → BUTTON.mp-tb-item.mp-tb-fold[title=收起工具栏]` |
| CF-2c | 对照臂：**列表项**内 Tab | ok | `- 列表项甲` → `  - 列表项甲`（+2 空格），焦点仍在编辑面 ⇒ **同一把尺子能看见有效缩进**，CF-2 的"没反应"不是尺子问题 |
| CF-2d | 备用入口：工具栏「增加缩进」按钮（真实鼠标点，代码块内） | ok | `const b = 2;` → `  const b = 2;`，文档 +2 字节，焦点留在编辑面 ⇒ 产品另有可用入口 |
| CF-4 | 末尾三反引号闭合 | ok | 打 ` ``` ` 时该行 `mp-code`（光标在本行 ⇒ `mp-fence` 按设计隐藏）；光标移开后恢复 `mp-fence mp-code`；其后段落 `闭合后正文` **无 `mp-code`** ⇒ 已出块 |
| ENV-CLIP | 本机系统剪贴板通道可用性（环境事实） | unverified | 壳层写返回 `{ok:true,bytes:39}`，但**主进程自读 `textLen=0`**（写读同进程）；页内 `navigator.clipboard.readText()` 为空；`pwsh Get-Clipboard` 为空；宿主 `clip.exe` = **Access denied**；宿主 pwsh Set/Get-Clipboard 往返亦空 ⇒ DSH 会话拿不到桌面剪贴板 |
| CF-5 / 5b / 5c | 代码块内粘贴多行（纯代码 / 每行含 Tab / 表格片段） | **unverified** | 环境限制 ⇒ 真粘贴（Ctrl+V 读系统剪贴板）无法注入载荷，**不出数、不判产品红** |
| CF-5x | 对照臂（**非粘贴**通道 `Input.insertText`） | ok | 22 字符 3 行进围栏后**逐字落地**，三行都成代码行（号 2/3/4）⇒ 围栏本身能收多行；此臂**不触发 paste 事件**，不代表粘贴行为 |
| CF-6 | 复制代码块（拖选整块，含围栏） | ok | 真实拖选 41 字符；`copy` 事件 `clipboardData` 载荷 = `"```python\ndef add(a, b):\n    return a + b"` **逐字等于源码**；**无行号痕迹**（无"数字+内容"行） |
| CF-6b | 复制代码块（拖选只含内容行） | ok | 拖选 31 字符，载荷 = `"def add(a, b):\n    return a + b"`，无行号 |
| **CF-7** | 工具栏「代码块」按钮（真实鼠标 mousedown） | **off** | 按钮 `[data-mp-id=code]` 未置灰；点后文档 151→161（Δ10 = `\n```\n\n```\n`）；**caret 落在闭合围栏下一行的空行**（col 0，`mp-code=false`），不在块内那行空代码行上 |
| **CF-7b** | 点完按钮立刻打字 | **off** | 打 `X` 后 caret L29 行 = `"X"`，`落在代码块内=false`；块后新段落生成，**代码块留空** |
| PZ | 收尾：进程存活 + pageerror + 壳层 trace | ok | `tasklist` 有本实例 pid；**pageErrors=0**；`main-debug.log` 无 error/dbg 命中 |

## 二、没反应的项 / 行为不符预期

1. **代码块内 Tab / Shift+Tab 完全没反应，且把焦点送出编辑面**（CF-2 / CF-2b，两轮独立复现 r2、r4、r5 一致）
   - 文档零改动（`139→139`），`Tab` keydown 到达编辑面但 `prevented=false`（无人消费）→ 浏览器默认焦点遍历。
   - `focusin` 逐条记录：正向 Tab → 工具栏「大纲」按钮；反向 Shift+Tab → 「收起工具栏」按钮。
   - 同源对照（列表内 Tab 生效 + 工具栏缩进按钮生效）证明尺子无问题，问题定位在"代码块里没有 Tab 绑定"。
   - 旁证（**静态代码位置，非结论**）：`Tab` 仅在 `src-cm6/lists.js:138`（列表）、`src-cm6/tables.js:397`（表格）、`src-cm6/completion.js:154`（补全菜单打开时）有绑定；代码块无绑定。

2. **工具栏「代码块」按钮插入后光标落在块外**（CF-7 / CF-7b）
   - 点一下确实插入了成对围栏（Δ10），但 caret = 闭合围栏**下一行**的空行；紧接着打字，字符落到**代码块外的普通段落**（L29 = `X`，`mp-code=false`），块内那行空代码行保持为空。
   - 用户可见后果：点「代码块」按钮后直接敲代码 ⇒ 得到一个空代码块 + 一段正文。
   - 旁证（**静态代码位置，非结论**）：`src-cm6/toolbar.js:157 insertBlock()` 把 caret 设为 `at + 1 + text.length`（插入串末尾）。

## 三、崩溃 / pageerror

- **r5：无崩溃、无 pageerror**（`pageErrors=0`；`main-debug.log` 无异常）。
- **r3：探针被外部终止**（不是产品崩溃）：探针异常 = `Target page, context or browser has been closed`，本实例 pid 随后从 `tasklist` 消失，同时刻另一条腿（`--user-data-dir=...\.mp-verify\xwdiag2-9yh27\profile`）的新实例进程树正在启动 ⇒ 判为**跨腿 `taskkill /IM` 干扰**，已在 r5 复跑取数；r3 的 `result.json` 保留该归因行。
- 探针侧修正（记录在案）：r4 的第二次拖选**起点落在上一次的选区上**，Chromium 起了原生拖放（DnD）把 `def` 移动到下一行行尾，夹具当场被改写 ⇒ CF-6b 判 unverified；r5 已改为"先真实鼠标点一下折叠选区再拖"，并新增"拖拽是否改文档"的完整性断言（r5 = false）。

## 四、证据文件

- 逐条读数（含每行 `cls`/`data-mp-n`/caret/焦点/keydown 冒泡/focusin）：`E:\MarkPilot\.mp-verify\checklist\code-fence-daily\r5\result.json`
- 运行日志：`E:\MarkPilot\.mp-verify\checklist\code-fence-daily-r5.log`
- 截图（r5）：`...\code-fence-daily\r5\shots\` — `01-enter-into-fence.png`（进围栏后光标在代码行 1）、`02-tab-in-fence.png`（Tab 后焦点在「大纲」按钮、行文未变）、`02c-tab-in-list.png`、`02d-indent-button.png`（工具栏缩进生效）、`04-close-fence.png`、`05x-inserttext-multiline.png`、`CF-6-drag-select.png`、`CF-6b-drag-select.png`、`07-toolbar-code.png`、`07b-type-after-button.png`（光标在块外空行）、`99-final.png`
- 剪贴板通道诊断（写/读/主进程自读/端到端 Ctrl+V）：`E:\MarkPilot\.mp-verify\checklist\code-fence-daily-clipdiag.cjs`、`...\code-fence-daily-clipdiag.log`、`...\code-fence-daily-clipdiag2.log`
- 被外部终止的轮次（归因证据）：`...\code-fence-daily\r3\result.json`
