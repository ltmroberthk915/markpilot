# a11y-keyboard 族 · 第三波真实用户操作普查报告

## 尺子卡（每条读数都可追到产物）

| 项 | 值 |
|---|---|
| 被测产物 | `E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe` |
| 产物 sha16 | **1b4e32a2263fcbe6**（188784128 B；探针启动先断言，`_probe-common.cjs` 尺子卡 ✓） |
| 夹具 | `.mp-verify\checklist\a11y-keyboard\doc.md`（13 行：H1 / 段落 / 列表 / 围栏代码块 / 段落），每例前重建 |
| 启动范式 | spawn 真实装机 exe + 随机端口 + 独立 `--user-data-dir` + `MP_DEBUG=1` + 删除 `ELECTRON_RUN_AS_NODE` + `playwright-core connectOverCDP`，收尾 `taskkill /T /F` |
| 输入通道 | 100% 真实：`page.keyboard.press` / `page.mouse.click`（CDP `Input.dispatchKeyEvent` / `dispatchMouseEvent`），无 JS 造事件 |
| 每个按键的自证 | 每次按键前**排空**事件日志、按键后读同一批：`keydown/keyup/mousedown/click(capture+bubble，含 detail)` |
| 组读数口径 | 一组相关读数在**一次 evaluate** 内取全（焦点事实 + 事件日志 + 面板存在性 + 文档长度） |

**用例数：83 条**（census 探针 31 条 + keys 探针 52 条），全部落在同一产物 sha16 上，无一次 CDP 断连或重连。

---

## 一、没反应 / 行为不符预期的项（带关键读数）

### 1. 工具栏 31/32 个按钮，键盘 Enter / Space 都点不动（★ 影响面最大）
- **K1a `Enter@bold`**：断言焦点确是该按钮 ✓；事件链 `keydown:Enter@bold` → `click-capture:@bold(detail=0)` → `click-bubble:@bold(detail=0)` → `keyup`（**事件全到齐、Chromium 已合成 click**）⇒ 文档 65→65 **无变化**、焦点仍 `BUTTON/bold`。
- **K1d `Space@bold`**：同样 `click(detail=0)` 已合成 ⇒ 文档无变化。
- **K1b `Enter@outline`**：⇒ `.mp-outline` 计数 0（没开）。**K10b `Enter@more`**：⇒ `.mp-pop` 计数 0（菜单没开）。
- **同源对照臂（同一个工具栏、同一种 `<button>`）**：**K1c/K1e** `Enter`/`Space` 落在 `toolbar-fold` ⇒ 工具栏收起 = `true`；**K1f / K10c** 用真实鼠标点 `outline` / `more` ⇒ 大纲 1 / 菜单 pop 1。⇒ 差异来自**按钮自身的绑定**，不是键盘通道坏了。
- **根因（只读源码，bundle `renderer/cm6/app.js`）**：工具栏项唯一的触发通道是 `c.addEventListener("mousedown", …)`；仅 fold 按钮额外挂了 `c.addEventListener("click", g => { g.detail === 0 && … })`——即"键盘合成 click"的分支。**修法范式本仓已有，只是没铺开。**

### 2. Esc 关不掉「大纲」浮层 `.mp-outline`
- **K6_Esc_大纲浮层**：起点干净 ✓ → 打开 outline=1 → Esc 前焦点 `cm-content`（`hasFocus=true`，排除"焦点在按钮上收不到"）→ Esc 自证 `Escape@cm-content cm-lineWrapping` → **Esc 后 outline 仍 1**，残留容器类 `["mp-outline"]`，`关掉了:false`。
- **K6b** 焦点留在工具栏按钮上再按 Esc：1 → 1，同样关不掉。
- 唯一有效关法：再点一次工具栏「大纲」按钮（**K6c 复位成功 true**）。
- 同轮对照：`.mp-pop`（Emoji / 更多 / 主题设置）与阅读模式 Esc **都能关**（关掉了 true，残留 []）。

### 3. Esc 关不掉 `.mp-dlg` 对话框（导出面板）
- **K6_Esc_导出面板 / K2_Esc_导出面板**：打开 dlg=1 → Esc 自证 `Escape@cm-content…` → **dlg 仍 1**，残留 `["mp-dlg"]`，`关掉了:false`。关法＝对话框自带 ✕（K8d 复位成功 true）。

### 4. 状态栏键盘完全不可达；缩放框只能鼠标点出来
- **K4a**：从正文起连按 Tab **40 步，命中状态栏 0 次**。
- **K4b**：`#mp-status-zoom` 初始 `display:none`、0×0、`tabIndex=0`、有 `aria-label="缩放百分比（输入数字后回车）"`。**K4c** 真实悬停 `100%` 徽标后 `display` 仍为 `none`。
- **K4d**：只有真实 mousedown 落在 `.mp-zoom-badge` 上，才 `is-editing` + 输入框 46×16 `display:block` + **获得焦点**。
- 进去之后键盘好用：**K4e** `Ctrl+A` → 输 `150` → `Enter` ⇒ 徽标 150%。
- 焦点环：该输入框 `outline: none 0px`（CSS 显式 `outline:none`），仅靠 1px primary 边框（截图 K4）。

### 5. 大纲浮层 / 主题设置面板内**没有任何可聚焦元素**
- **K5_大纲**：容器 `mp-outline`，子元素 1，**可聚焦子元素 `[]`**，条目文本 `["无障碍普查夹具"]`。
- **K5_主题设置**：容器 `mp-pop`，子元素 29，**可聚焦子元素 `[]`**，8 个主题条目全是不可聚焦的 div。
- ⇒ 键盘能开面板（Ctrl+Shift+O），但**在面板里选不了任何条目**。
- 对照：更多菜单有 2 个 `INPUT` 可 Tab 进（K8e「进入菜单 true」）；导出对话框 5 个 `.mp-key` 按钮 Tab 可达（**K9b 首次第 27 步**）。

### 6. 正文获得键盘焦点时没有可见焦点指示器
- **D1**：`.cm-content` focused、`:focus-visible=true`，但 `outline: none 0px`；截图里看不到任何环（CDP 拍不到原生 caret，画面就是"没有指示"）。
- 对照（有环，琥珀色）：工具栏按钮 `auto 0.571429px rgb(229,151,0)`（D2 截图：粗琥珀环清晰）；查找输入框 `auto 0.761905px rgb(229,151,0)`（K9 截图）。

---

## 二、通过项（同轮读数）

| 项 | 读数 |
|---|---|
| Tab 正向全程 | 单一闭环：正文 → 工具栏 31 项 → 回正文（T1..T31 toolbar、T32 body、T33 起重复）。B2：`工具栏项数 31`、`回到正文 true`、**命中不可见控件 []** |
| 按键自证 | B3：**无 keydown 自证的站 = []**（73 次 Tab/Shift+Tab 全部有事件到齐的自证） |
| 焦点环 | B4：**焦点环缺失的站 = []**（31 个工具栏站全部 `:focus-visible` + 有 outline） |
| Shift+Tab 反向 | C2：`未获 shift 自证站 []`；C3：**正反向站点集合差为空**（可逆） |
| 键盘走完「查找」 | Ctrl+F 开面板、焦点落 `INPUT.cm-textfield`、敲"段落"落进输入框（值=`段落`）、**文档 65 不变**、Esc 收回且焦点回正文（K3 三条 + K9d 截图） |
| 默认快捷键表真的装上了 | K7：`Ctrl+B` 文档 67→71 插入 `****`；`Ctrl+Shift+O` 大小写两种拼写都开出大纲 |
| 缩放三键 | K10a：`Ctrl+=` 150→155、`Ctrl+-` →150、`Ctrl+0` →100；**徽标 / `window.mpZoom.get()` / localStorage / CSS 变量四处一致** |
| 阅读模式 | Esc 退出（引擎自报标志 `documentElement.dataset.mpReading` 1→0） |
| 面板 Esc 后焦点 | `.mp-pop` 各例 Esc 后焦点回到 `cm-content@body`（不是丢在 body 上） |

---

## 三、pageerror / 崩溃

- **pageerror：0；console.error：0**（两个探针的 `Z_页面异常` 各一轮，均为 0；样例数组为空）。
- **崩溃/卡死：0**。CDP 会话全程未断（无需重连），`taskkill /T /F` 每次收尾成功。（复查时机器上另有 12 个 MarkPilot 进程，命令行显示属于 `settings-truth-out` / `weird-chars-out` / `corrupt-config-out` 三个**别的族的 profile**，与本族无关，未动。）

---

## 四、我自己尺子的三次修正（错-3 第 4 条：保留原文 + 就地标注）

1. **r1 的 E/F 用例**：把"按键自证"读成了**按键前已排空**的那批日志 ⇒ 恒为空，无法判定按键到没到。r3 起改成"按键前排空、按键后读同一批"，并加挂 `click(capture/bubble, detail)` 记录——正是这条修正才拿到"click 已合成但无人监听"的根因证据。
2. **r2 全域**：把 `.mp-reading-exit`（引擎**常驻但 display:none** 的退出胶囊）当成阅读模式状态 ⇒ 所有"起点干净"判定为 false，用例互相污染。改用**引擎自己算好的标志** `document.documentElement.dataset.mpReading`（源码 `Ks()` 写、`or()` 读 `localStorage["mp-reading"]`）后恢复干净。
3. **r4 的 K9c「缩放三键全部无效」—— 已被 r5 K10a 推翻**。K9c 那一步编辑器没有焦点，按键事件根本没进渲染进程（无自证）；r5 加了"编辑器有焦点"断言与 keydown 自证后，三键全部生效（150→155 / 150 / 100）。**K9c 的读数保留在 `a11y-keyboard-keys-r4.log` 中，作废，不得引用。**
4. 附带：K8b 早期判"焦点跑出对话框"是因为只 Tab 了 6 步；K9b 加长到 45 步后修正为"**可达，首次第 27 步**"，此前的判断作废。

---

## 五、证据路径

| 类型 | 路径 |
|---|---|
| 探针（census 31 例） | `.mp-verify\checklist\a11y-keyboard-census.cjs` |
| 探针（keys 52 例，定稿） | `.mp-verify\checklist\a11y-keyboard-keys.cjs` |
| 探针（活体侦察） | `.mp-verify\checklist\a11y-keyboard-recon-live.cjs` |
| 定稿日志 | `a11y-keyboard-keys-r5.log`、`a11y-keyboard-census-r1.log` |
| 含作废读数的日志 | `a11y-keyboard-keys-r1.log` ~ `r4.log`（K9c 作废读数在 r4） |
| 原始读数 JSON | `.mp-verify\checklist\a11y-keyboard\census.json`、`keys.json` |
| 截图（局部 2×） | `a11y-keyboard\shots\D1-正文焦点.png`、`D2-工具栏按钮焦点.png`、`K4-状态栏缩放框焦点.png`、`K9-查找面板焦点.png` |
| 静态侦察脚本（只读产物） | `_a11y-recon-bind.cjs`、`_a11y-recon-reading.cjs`、`_a11y-recon-zoom.cjs`、`_a11y-recon-zoom2.cjs`、`a11y-keyboard-recon-classes.cjs` |

产品代码 `MarkPilot-CM6\` 全程**只读**（仅读 `renderer/cm6/app.js`、`app.css`、`index.html`）；本族所有写入都在 `.mp-verify\` 下。

---

## 六、未验证项（不猜）

1. **对话框里的 `.mp-key` 按钮能否被 Enter 激活**：未测（怕触发真实导出/原生保存对话框）。本族内可用的 Enter 对照只有状态栏缩放框（K4e 生效）与工具栏 fold 按钮（K1c 生效）。
2. **Shift+Tab 在面板内 / 对话框内的反向遍历**：只验证了正向 Tab 可达（K9b），反向未测。
3. **「设置」对话框的 Esc 行为**：未单独测（入口在「更多」菜单里，而该菜单键盘打不开）；同 `.mp-dlg` 的「导出」已测为 Esc 关不掉。
4. **屏幕阅读器实测（NVDA）/ 高对比模式**：未做。只有 DOM 属性统计——A3：工具栏 31 个按钮中 **30 个没有 `aria-label`**（全部有 `title`）、全应用 `role=` 出现 **0 次**；`.mp-outline-item` / `.mp-pop-item` 是 `cursor:pointer` 的普通 div（无 `tabindex`/`role`）。
5. **`.mp-outline` 在阅读模式/双开等其他状态下的 Esc 行为**：未单独测（本轮只在编辑态下测）。
6. **行为差异（非缺陷，供产品决策）**：正文里 `Tab` 不缩进，直接把焦点送去工具栏（census T1：body → toolbar/outline；K9a 三次 Tab/Shift+Tab 后文档 67→67 文本一致）。这与 Typora「Tab 缩进」的习惯不同，但对键盘可达性是正确取向。
