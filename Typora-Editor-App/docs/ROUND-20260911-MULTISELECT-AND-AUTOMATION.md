# 多选顺序修复 + 自动化补齐（2026-09-11 第四轮，发布 2.0.17）

用户验收（①Shift+Enter 无问题 ②图片复制基本没问题但多选顺序要两种都行 ③表格复制暂时无问题）
+ 四条执行（改进空间量化 / 补两个场景 / 安装器为什么要点 / Python 与 Trae 的自动化）。
本文记这一轮的交付；改进空间量化单独一篇：`docs/HEADROOM-20260911.md`。

## 0. 结论速览

| 事项 | 结果 |
|---|---|
| 多图两种顺序 | 先普通点第一张 → 按住 Ctrl 点第二张，**现在也能多选**（那张单选图会被迁移进多选集合，实线框→虚线框）；原有"先 Ctrl 点第一张"不变。验收 `20-copy-images` 两种顺序各 17 项断言、剪贴板各 3 个真实文件（SHA256 对账） |
| 安装器"要手动点" | **两个原因都找到并解决**：①在 Git Bash 里 `/S` 被 MSYS 改写成 `S:/`，NSIS 收到无意义参数就弹图形向导；②electron-builder 的 NSIS 有 `_CHECK_APP_RUNNING`——只要 MarkPilot 在运行就弹"应用正在运行，确定关闭？"并要求点击（点完它还会强杀进程）。现在 `scripts/install-app.cjs`：Node 原样传 `/S`，装前先发**正常关闭请求**（不带 /F，让应用走自己的保存逻辑），装完核验版本与解包脚本 |
| Python | 本机有 **Anaconda**（`D:\Users\ltmroberthk\anaconda3\python.exe`，3.10.13），上一轮我只在 C: 找过、误判为"没有 Python"。本轮改用 `pack.py` 出 VSIX，并把上一轮的 Node 移植版与 pack.py **逐文件比对**：517 文件、0 差异（`scripts/compare-vsix-packers.cjs`），所以无 Python 时用移植版也是安全的 |
| Trae 未安装 | Trae 在 `D:\Program Files (x86)\Trae\Trae.exe`，扩展目录 `C:\Users\ltmroberthk\.trae\extensions`（之前是空的）。命令行 `--install-extension` 在本机会**把整个 IDE 拉起来且不退出**、扩展目录里始终不出现文件夹 ⇒ 改为**目录侧载**（解开 VSIX → 拷进 `<extensions>/markpilot.markpilot-<版本>/`，再读回版本号核验），Trae 与 VS Code 均已装 2.0.17 |
| 新增场景 | `40-restore-position`（阅读位置还原）、`50-copy-table-and-image`（表格 CF_HTML 字节 + 单图位图/PNG 尺寸）、`60-scroll-smoothness`（真实滚轮 + rAF 帧间隔） |
| 全量验收 | 安装版 **8 场景 / 89 断言 / 0 失败 → ACCEPT**（连跑两次稳定），四方哈希链 `verified: true`（2.0.17，515 扩展 / 492 渲染文件） |

四个数字（安装版 2.0.17）：
- Setup `71a8208ea94c74287656cdb95582112fd7068e46b2e7dea748c39bef4b2a667b`
- portable `524f867acbc3d895cc916aabfcf03f25da519b9aa88b981699789577f873b9e3`
- VSIX `7b33b46103350d5c0ef10f894dde1d4b04767a1d5bf210df4fce943e921f124d`
- app.asar `0cec681cefe1059878782b9b2e153cf1c9606e9b69e06900d56f06ad2f5c4fe7`

## 1. 多选顺序修复（`media-tools.js`）

原实现：普通点击 → `clearImageSelection()` 后设 `selectedImage`（实线单选）；Ctrl+点击 → 切换
`multiSelected` 集合，并且**把单选那张的高亮直接删掉**。于是"先点第一张再 Ctrl 点第二张"永远
凑不出多选——用户必须先按 Ctrl 点第一张。

改为（与资源管理器同手感）：
- Ctrl 点**已经单选的那一张** = 取消选择；
- Ctrl 点另一张时，先把先前单选的那张**迁移**进多选集合（摘 `typora-img-selected`、挂
  `typora-img-multi-selected`、清掉 DOM 选区），再切换被点的那张；
- 普通点击仍然是"替换选择"（清空多选再单选那一张）——这是标准行为，保持不变。

验收判据是**看得见的样式**（单选实线 / 多选虚线）而不是类名：迁移瞬间断言"0 张单选 + 2 张虚线"，
整轮结束断言"3 张虚线 + 3 个剪贴板文件"。

## 2. 三个新场景

- **`40-restore-position`**：真实滚轮滚到"锚点甲"段落 → 换开另一个文档 → 再开回来；
  断言该段落贴在视口顶部 ±8px，并用 **scratch profile 里的 `state.json`** 做独立证人
  （实测 `{index:82, delta:-3, head:"锚点甲：…", total:204}`，还原误差 4px）。
- **`50-copy-table-and-image`**：真右键弹出页面内菜单（不是原生菜单）→"复制表格到 Excel"→
  用 **Win32 剪贴板 API 按原始字节**读回 CF_HTML（.NET 的 `GetData` 会用 ANSI 码页把 UTF-8 表格
  解成乱码，这条本身也成了被测对象）：断言版本头 + 片段偏移自洽 + 中文单元格完好，实测
  StartFragment 172 → EndFragment 1325、原始 1357 字节；再走"图片设置…→复制原图"，断言
  CF_DIB 与 PNG 都在、尺寸等于磁盘原图（120×80）。
- **`60-scroll-smoothness`**：大文档真实滚轮 24 次（10,079px），页面内 rAF 采样帧间隔：
  **p50 16.7ms / p95 16.8ms / 掉帧 0/180**。

## 3. 自动化补齐（已写入 SKILL 规则 34–36）

```bash
node scripts/install-app.cjs dist/markpilot-Setup-2.0.17.exe --expect-version 2.0.17
node scripts/install-vsix.cjs E:/MarkPilot/Typora-Editor/dist/markpilot-2.0.17.vsix
/d/Users/ltmroberthk/anaconda3/python.exe pack.py          # 官方打包器；无 Python 时 node scripts/pack-vsix.cjs
node scripts/compare-vsix-packers.cjs                      # 两种打包器逐文件比对
```

`install-app.cjs` 的关键点：安装目录**不能靠 `%LOCALAPPDATA%` 猜**（本机用户真实目录在 D: 盘，
而工具宿主进程的环境变量写的是 C:；electron-builder 又不写 `InstallLocation`），所以从卸载项的
`UninstallString` 反推。`install-vsix.cjs` 的关键点：VS Code 系 CLI 装完不退出，所以按**扩展目录
里出现目标版本**来判定成败。

## 4. 回归

- 安装版全量验收 8 场景 89 断言全绿（连跑两次）；四方哈希链 verified。
- `npm run test:media` 0 失败；shell 34 / regression 16 / consistency 154 / features 66 /
  ui 43 / table-input 36 / source-toggle 10 全绿（上一轮记录，本轮未改这些路径）。
- 受保护素材 md5 未变；本轮素材仍全部现场生成。
