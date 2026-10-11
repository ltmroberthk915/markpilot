# LOG-3.0.0-CM6（独立桌面版首版 · 内部记录）

本文件是 `MarkPilot CM6 3.0.0` 的内部验证记录（面向用户的说明见 [RELEASE-3.0.0-CM6.md](RELEASE-3.0.0-CM6.md)）。

## 一、产物与校验

- 工程目录：`E:\MarkPilot\MarkPilot-CM6`（**与 2.x/VSIX 线完全独立**，不复用 vditor renderer）。
- 编辑内核：`dsh-markpilot/renderer-cm6/`（63 文件 / 2082.9 KB）经 `scripts/sync-engine.mjs` **只读同步**到 `renderer/cm6/`，同步后逐文件 sha256 校验一致；应用侧永不手改引擎产物。
- 依赖：Electron 33.4.11 + electron-builder；`win.signAndEditExecutable=false`（本机非管理员，electron-builder 解 `winCodeSign` 时无法创建 darwin 符号链接，实测连续失败；关闭该步后构建通过，图标/版本信息留待后续用缓存里已解出的 rcedit 补）。
- 产物（`dist/`）：`markpilot-cm6-Setup-3.0.0.exe` 78.9 MB、`markpilot-cm6-3.0.0-portable.exe` 78.7 MB（对比 2.3.3 的 116 MB：本版不携带 vditor/CDN 资产）。

## 二、开发态冒烟（`.mp-verify/app-smoke.md`）

| 判据 | 结果 |
|---|---|
| 引擎 boot + 文档载入 | ✅ 4 行，标题 `app-smoke.md · 12 字 — MarkPilot CM6` |
| 磁盘 == 内存 | ✅ |
| 真实键盘输入（中文 + `$a^2+b^2=c^2$`）→ 防抖落盘 | ✅ 磁盘尾出现新行；上行事件序列 `init → change×26 → text` |
| 错误条 / console error | 无 / 0 |
| 总判定 | **✅ 全绿** |

## 三、装机产物冒烟（`scripts/verify-exe.cjs`，直接跑 portable EXE）

| 判据 | 结果 |
|---|---|
| 引擎 + 文档载入 | ✅ 握手 ≈26 ms |
| 运行时 | `MarkPilotCM6/3.0.0`（Electron/Chromium） |
| 磁盘 == 内存 | ✅ |
| 真实键盘输入（中文 + `$e^{i\pi}+1=0$`）→ 落盘 | ✅ |
| console error | 0 |
| 总判定 | **✅ 装机产物全绿** |

## 四、开发过程踩到的三个真坑（留档，避免重犯）

1. **`ELECTRON_RUN_AS_NODE=1`**：本机开发环境（DSH 宿主注入）下 `electron.exe` 会以纯 Node 模式启动，`require('electron')` 只拿到二进制路径 ⇒ `app.getPath` 直接 TypeError。启动器/探针必须从 env 中删掉该变量。
2. **主→渲染推送竞态**：`webContents.send('doc')` 若早于渲染进程注册监听会被丢弃；反向拉取又可能早于主进程读完文件。最终方案＝**引擎 boot 后反向握手**（渲染进程 `doc:ready` → 主进程再推），并且**空文档只有在主进程确认"没有文件"时才开**（否则会用空文档把主进程的路径清掉）。
3. **`window.__mpDbg` 未初始化**：诊断计数写在 `case 'init'` 里却只在 `onDoc` 分支惰性创建 ⇒ 抛 TypeError 被 `up()` 的 try/catch 吞掉，表现为"引擎发了 init 但宿主毫无反应"，排查了三轮。诊断对象必须在模块顶部初始化。

## 五、后续（已知边界）

- 表格进阶编辑（单元格原地编辑、行列增删、整块复制到 Excel）尚未实现（方案见 `TABLE-EDIT-PLAN-CM6.md`）。
- 图标与版本信息未写入 EXE（`signAndEditExecutable=false` 的代价）：可用 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\*\rcedit-x64.exe` 补。
- 性能专项：`research/D1-shell-choice.md`、`research/D3-editor-perf-architecture.md` 已给出"行级检查点增量扫描 + `RangeSet.map`"的首选改造路线；`research/D2`（现引擎热点实测）待回收。

## 六、本轮构建的验证记录（工具栏岛／主题／导出同源／楷体）

产物指纹：portable `44004b2529ea823c`（78.86 MB）、Setup `53129ae09e7ff46f`（79.10 MB）、`app.asar` `a31ee63099a20879`；asar 内已验到本次全部改动标记（`mp-fold-shift`、`mp-toolbar-folded`、`markpilot-kai`、`exportTypoCss`、打印层 `--mp-sel-tint: transparent`、`size-adjust: 97%`）⇒ 装机件不是旧引擎。

| 套件 | 结果 | 关键读数 |
|---|---|---|
| 主题单一渲染事务 | **8/8** | 8 套 × 连点 5 次逐次幂等；面板 / 引擎 `setTheme` / 再点面板三方底色一致（`#191919`）；`dataset.editorTheme` 与 `localStorage` 同源；17 个颜色 token 全部**实际写入** `root.style`（抓 `--mp---mp-bg` 型垃圾名）；`--mp-heading` 取自当前配色而非 TELARI 残留 |
| 导出排版同源 | **5/5** | 编辑面**注入后**的 CSS 与重构前 8/8 逐字符相同；导出件零 `.cm-` 选择器、含 kai `@font-face`＋`size-adjust`＋`text-autospace`＋颜色 token 运行时快照＋14px 基准＋1280 版心；导出件内公式为真 KaTeX |
| 工具栏岛 / 折叠 | **9/9** | 展开岛宽 1067 / 可用 1376（真岛）、左右缝 167·167；窄视口 700 不溢出（676、换行 57）；折叠 **35×35**、右缝 12、只剩 1 按钮；过渡采到 12 个中间宽度；持久化 / 可逆 / `--mp-toolbar-h` 32→35 |
| 真机五通道（便携 EXE） | **13/13** | 键盘逐行 1→2→3、End/Home 列 20/0；鼠标落点 2→26；Shift+方向键选区 (2,6)；点一下再 Shift+点 (0,5)；拖拽 (0,5)；真机岛 1066 / 缝 50·50、折叠 35×35 / 右缝 12；真机 8 套主题底色 == 声明值 |

能效（同一把 `gate.cjs`，三枪取中位；上限＝基线×1.05）：

| 面 | 键入 p95 · 492KB | 每键四扫描 | 打开→就绪 | 内存增量 |
|---|---|---|---|---|
| 插件页（改前 → 改后） | 106.8 → **105.3** | 25.9 → **25.4** | 345 → **342** | 23.0 → **9.1** |
| 便携 EXE（E3 基线 → 本版） | 112.9 → 115.4 | 23.5 → **23.1** | 247 → **234** | 5.8 → 9.9 |

两个形态的优势面都在：EXE 的四扫描比插件页快约 9%、打开快约 31%。

本轮踩到并已修的坑（供后来者，避免重犯）：

1. **工具栏"岛"被自己弄丢过**：样式单一来源收敛时删掉了 `width:fit-content; margin:auto`，只剩 `left/right:12 + width:auto` ⇒ 退化成通栏。而"左右缝 12/12 ＋ 圆角 999px"这把尺子**通栏与岛都成立**，所以报过假绿。新判据：宽视口下量"岛宽 vs 可用跨度"，并比对 `scrollWidth`（贴内容）。
2. **打印层是 user origin**（`insertCSS(..., {cssOrigin:'user'})`）⇒ 凡要压过磁盘 HTML 作者声明的必须 `!important`；导出样式改造后 `table{width}` 与 `a{color}` 两条会**静默失效**，已补。
3. **暗色主题导出件打印＝浅灰字白纸**（原来只压背景、没压文字色）：现整组 token 压成纸面中性色（打印层是刻意的纸面中性，不跟 8 套配色走）。
4. **导出件缺 kai `@font-face`**：只写 `font-family` 会让中文斜体掉成系统衬线斜体；现 src / unicode-range / size-adjust 并入真源表一起生成。
5. **尺子错四次**（每次都先怀疑产品，查下来是尺子）：`Object.keys(root.style)` 不列自定义属性；拿 harness 里写死宽度的 `#editor` 去比 `fixed` 于视口的岛；在**折叠态**下量窄视口；在**空行**上验 End 的列号。

## 七、下一版（已排板）

逐项透明度设置面板（一个消费者一个 token，不捆绑）→ 大纲停靠模式（左 / 右可选）＋「更多」菜单去重＋新增「设置」项 → 阅读模式骨架（跟随主题 / 专用阅读配色两档）→ KP 管线（先接阅读模式，再接 PDF 导出，含代码块·表格·公式跳过与 ≥300KB 降级）。
