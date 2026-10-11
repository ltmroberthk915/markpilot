# export-daily 族 · 每日导出操作普查（第二波）

**被测产物**：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`
**sha16 = `15b8a1b699a0782e`**（188,784,128 B，构建时间 2026-10-10 10:50:34；每条探针启动时先断言该值，不符即 exit(9) 不出数）
**壳层一致性**：从产物 `resources/app.asar` 抽出的 `main.js / export-folder.js / preload.js` 与工作区源码 sha16 **逐一相同**（`export-folder.js 0871B7BA3B9B2D81`、`main.js 4A060DC9D133916B`、`preload.js 2572D61CCB5C8718`）⇒ 本轮源码级指认对产物成立。
**产品版本**：`markpilot-cm6 3.2.1`
**运行环境**：本机工作站锁屏态；**无外网**（外链图一律 0×0，属环境，不算缺陷）
**pageerror**：全部探针 `[]` **崩溃**：无

---

## 一、用例数：16

| # | 用例 | 结果 |
|---|---|---|
| E1 | 导出为文件夹真实流程 + 产物逐项校验 | 通过 |
| E2 | 导出「单文件 HTML」+ 与对话框承诺对照 | **不符预期（2 项）** |
| E3a | 取消导出（文件夹）：原生框弹出 → 取消 | 通过 |
| E3b | 取消导出（单文件 HTML） | 通过 |
| E3c | 取消后编辑器仍可用（真实鼠标+键盘） | 通过 |
| E3d | 取消后重开对话框再取消（可重试） | 通过 |
| E4 | 连续导出两次 | 通过（逐字节一致） |
| E5 | 目标目录已有同名 HTML + 同名 assets 图（+ 遗留多余图） | 实测行为，见 §三.3 |
| E5b | 同名 HTML 只读（写不进去） | **不符预期（文案/半成品）** |
| E6a | 「更多」菜单 → 「导出…」 | 通过 |
| E6b | Ctrl+Shift+E（CDP 真实按键） | 通过，但落盘名同缺陷① |
| E6c | Ctrl+Shift+E（主进程注入＝加速键路径） | 通过，但落盘名同缺陷① |
| E7a | 连点工具栏「导出」两下 | 通过（仍只有 1 个对话框、0 次导出） |
| E7b | 连点对话框按钮两下 + 真实素材文档（169 KB）导出 | 通过（只导出 1 次、文档零改动） |
| — | 诊断臂（提示条通道 / 取消后焦点） | 见 §四 |

---

## 二、不符预期的项（带关键读数）

### 缺陷① 单文件 HTML 导出的文件名多一个 `.html`（用户看得见）

- 读数：目标目录实测文件 **`导出日常E2E.html.html`**（E2）；`lastExport.file = …\导出日常E2E.html.html`；提示条原文 `已导出：…\导出日常E2E.html.html`（E2/E6b/E6c 三条入口一致）。
- 对照：**文件夹导出**同文档同目录产出的是 `导出日常E2E.html`（正常）。
- 源级指认（产物与源码同 sha）：
  - `dsh-markpilot/src-cm6/extras.js:894` `exportBeginHtml({ dir, name: safeFileName(title) + '.html' })`
  - `MarkPilot-CM6/export-folder.js:111` `const file = path.join(dir, safeName(name, 'markpilot') + '.html')`
  - 两处各加一次 `.html` ⇒ `X.html.html`；`extras.js:901` 的提示兜底里还有第三份同样的假设。
- 影响面：工具栏「导出 → 单文件 HTML」、快捷键 Ctrl+Shift+E（两条尺子都验了）、「更多 → 导出…」三条入口全部如此。

### 缺陷② 「单文件 HTML」承诺"图片内联"，实测一张都没内联

- 对话框原文（从运行中的产品读出，非源码抄写）：**`图片内联，一个文件发给别人也能看。会先让你选目录。`**
- 产物实测：`<img src>` 六条 = `img/pic-a.png` / `other/pic-a.png` / `img/pic-b.png` / `https://example.com/remote.png` / `data:image/gif;base64,…`（文档自带）/ `img/missing.png`；`data:image/` 出现次数 = **1**（只有文档原本就带的那张）。
- **同源对照臂**（同夹具、同目录、同尺子、同一只 headless Chromium，先跑文件夹导出再跑单文件导出）：
  - 文件夹导出件：`assets/pic-a.png→16`、`assets/pic-a-1.png→16`、`assets/pic-b.png→24`（naturalWidth）
  - 单文件导出件：`img/pic-a.png→0`、`other/pic-a.png→0`、`img/pic-b.png→0` ⇒ **三张本地图全裂**
  - 截图：`shots/artifact-folder-export.png`（三块纯色块都在）vs `shots/artifact-single-file-html.png`（四张全是裂图占位 + alt 文字）
- 结论：把这份文件"发给别人"，图一张都看不到；只有把它恰好放在源文档同一个目录里才碰巧能看。
- 源级：`extras.js:875-916` 的 `exportHtml()` 走 `mdBodyChunks(md, { math: true })`，**不传 srcMap、也没有任何内联步骤**；引擎里存在 `inlineAllImages`（`extras.js:2973` 一带，菜单「内联全部图片」用它），导出这条路没调它。
- 说明：`MP_EXPORT_DIR` 只替换"选目录"这一步（`MarkPilot-CM6/main.js:1395-1396` 直接返回目录），**不参与 HTML 生成**；E6b/E6c 的快捷键入口（同一函数）产物同样是 `.html.html`，两条入口互相印证。

### 缺陷③（低危）同名 HTML 只读时的报错文案与"半成品目录"

- 读数：toast = **`导出失败：写流不存在`**（E5b）；`lastExport` 未更新；目标 HTML 内容未被破坏（sha 与上一次导出相同）。
- 同时 **`assets/` 已经被写进去了**（5 个条目），留下一个"有图没 HTML"的半成品目录。
- 用户视角：报错看不出是"文件只读/被占用"，只看到"写流不存在"。

---

## 三、实测行为（事实陈述，本轮不判缺陷）

1. **覆盖同名文件不询问**：预置 `SENTINEL-OLD-EXPORT` 的 HTML 与哨兵字节的 `assets/pic-a.png` 被静默覆盖（E5 判据 `同名HTML被覆盖=true`、`同名图被真图覆盖=true`、`有覆盖前询问=false`，提示条里也没有"已存在/覆盖"字样）。对得上 Typora 一类工具的默认手感。
2. **上一轮遗留的多余 assets 不清理**：预置的 `assets/stale-leftover.png` 在重新导出后仍在（`遗留多余图仍存在=true`）。
3. **只读同名文件的失败是"响"的**（不是静默成功）：报了 `导出失败：…`，用户不会以为导出了。

---

## 四、通过的项（关键读数）

**E1 导出为文件夹（图片外链）**
- 真实鼠标：工具栏 `[data-mp-id="document-export"]` → 对话框（5 项，`folder` 未禁用）→ `[data-ex="folder"]`；引擎自报 `lastExport.ms ≈ 34`（主进程 trace：`prepareAssets ms=3` → `beginHtml` → `finishHtml bytes=378539 chunks=3`），点击到落盘完成快于一次 120 ms 采样。
- 目录产物：`导出日常E2E.html` + `assets/{pic-a.png, pic-a-1.png, pic-b.png}`；**三张图 sha16 与源图逐一相同**（字节保真）。
- HTML 内引用：`assets/pic-a.png`、`assets/pic-a-1.png`（同名不同源按 `-1` 去重）、`assets/pic-b.png`；外链原样、`data:` 原样、**复制失败的 `img/missing.png` 保留原路径不假装成功**。
- 独立 headless Chromium 打开该产物：三张本地图 naturalWidth **16 / 16 / 24** ✅；`<title>` = 文档标题；`:root` 颜色 token 快照与 KaTeX CSS 都在，公式已排版（渲染侧 katex=2）。
- 成功提示条（真实提示层读出，非源码抄写）：`已导出：…\导出日常E2E.html（HTML 370 KB · 图片 3 张外链 · 1 张失败(保留原路径)） 打开所在文件夹`。
- 源文档目录零污染（导出前后 `dirSnapshot` 相同）。

**E3 取消导出**
- 点「HTML + 图片文件夹」后 **656 ms** 内出现原生框：`#32770 | 导出为文件夹（图片放进 assets/）| vis`（EnumWindows 按 PID 取证；框弹出时主窗口 `IsWindowEnabled` 由 `en`→`dis`，是正常模态）。
- 对**该框的 HWND** 发 WM_CLOSE（＝点取消）后：框消失、主窗口回到 `en`、**新增文件 0、新增 `export:beginHtml` 0、toast 无、`lastExport` 仍为 null**。
- 取消后编辑器可用：真实鼠标点正文（y=136）取到焦点，真实键盘输入 'X' ⇒ docLen 494→**495**、`focusInEditor=true`。
- 取消后可重试：再次弹出同一个框、再次取消，仍然零残留。

**E4 连续导出两次**：产物 HTML **逐字节相同**、目录快照完全相同（`E4 两次目录相同=true`）。

**E7 手快连点**（真实素材 169 KB「富文本测试-重识概率论.md」副本）
- 连点工具栏两下：`对话框个数=1`、期间导出次数 **0**（`dialog()` 先 `closeDlg()`，没被点出两个框）。
- 连点对话框按钮两下：导出次数 **1**、文档长度变化 **0**；产物 `第一部分 高等概率论基础.html` 829,653 B、`h1=3 h2=7 表格 8`、KaTeX 284 处、`</html>` 收尾完整；浏览器渲染里内联大图 **1167×1264** 正常解码。

---

## 五、未验证项（含原因）

1. **在原生目录框里真正"挑一个目录再确定"**：工作站锁屏，真人键鼠到不了锁定会话（SendInput 进不去）。本轮正例走产品自带测试缝 `MP_EXPORT_DIR`（`MarkPilot-CM6/main.js:1395`，注释写明"供自动化/回归用"），取消走原生窗口句柄。**"用户在原生框里选中一个目录"这一步未验证。**
2. **导出后提示条上的「打开所在文件夹」**：会拉起资源管理器；锁屏态下无法收拾该进程，故未点击。
3. **外链图在联网环境下的渲染**：本机无外网，`https://example.com/remote.png` 必然 0×0（只验证了"地址原样保留"）。
4. **PDF 导出、超大文档/海量图片导出性能**：不属本族（另有族覆盖）。
5. **第二次导出时"同名不同源"重命名的稳定性**：结构上 `usedNames` 每次导出重建，本轮只直接量了"同一目录连续两次结果一致"，未构造"两次导出引用不同图集"的定向样例。

---

## 六、探针自身的坑（已修，留档避免误读）

1. **完成信号取晚了**：第一版用"等 main-debug.log 出现新的 `export:finishHtml`"当完成信号，但基线是在**点击之后**取的 —— 产品 26 ms 就导完了，基线里早就含那行 ⇒ 等待 25 s 超时，之后所有快照都落在"提示条 6 s 自动隐藏"之后，渲染侧读数全 null。我一度读成**"导出没有反馈"**。现改为点击前取基线 + 全程 120 ms 采样。
2. **关窗口关掉了主窗口**（两次）：① 第一版 `close` 把该 PID 的**全部**顶层窗口发了 WM_CLOSE；② 改成"新窗口差集"后仍按**整行字符串**比对，而模态框会把主窗口的 `en` 变成 `dis` ⇒ 主窗口又被当成新窗口关掉，应用退出、读数变成 `Target page … has been closed`。现改为**按 HWND 差集** + **只关 `#32770`**。差一点把这两次读成"取消导出会弄崩应用"。
3. **落点被浮动工具栏岛盖住**：取消后"点正文 + 打字"第一版落点取 `.cm-content` 顶 +20 px（y≈36），那里在工具栏岛（z-index 45）底下 ⇒ activeElement 仍是 BODY，差一点读成"取消后编辑器失去焦点"。诊断臂在顶 +120 px 落字正常，现按 +120 取点并记录两个落点。

---

## 七、证据文件

探针（全在 `.mp-verify/checklist/`，文件名均以族名 `export-daily` 开头）：
`export-daily-lib.cjs`（启动/取证库）、`export-daily-fixture.cjs`（夹具）、`export-daily-render.cjs`（真浏览器渲染校验）、`export-daily-dlg.ps1`（按 PID 列/关原生窗口）、`export-daily-e1-folder.cjs`、`export-daily-e2-html.cjs`、`export-daily-e3-cancel.cjs`、`export-daily-e6-entries.cjs`、`export-daily-e7-doubleclick.cjs`、`export-daily-shots.cjs`、`export-daily-diag-toast.cjs`、`export-daily-diag-focus.cjs`、`export-daily-asar-read.cjs` / `export-daily-asar-extract.cjs`、`export-daily-smoke.cjs`

读数（JSON，逐字段可查）：`export-daily-out/_reports/{e1-folder,e2-html,e3-cancel,e6-entries,e7-doubleclick,diag-toast,diag-focus,shots,smoke}.json`

截图：`export-daily-out/shots/{export-dialog.png, toast-after-folder-export.png, artifact-folder-export.png, artifact-single-file-html.png}`

产物目录（可直接打开看）：
- 文件夹导出：`export-daily-out/e1/out-a/`（含 `assets/`）
- 单文件 HTML：`export-daily-out/e2/out-html/导出日常E2E.html.html`
- 对照用同一目录：`export-daily-out/shots-run/out/`（两个导出件并排）
