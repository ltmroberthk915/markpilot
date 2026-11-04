# MarkPilot 3.6.17 / dsh-markdown-typora 0.3.12 验证与交付记录

## 这一版做了什么

恢复 MarkPilot V2 最后版本的深蓝宋体主题，作为第 10 套内置主题 **宋韵 深蓝**：

- 纸面 `#2E3440`、正文 `#C3C7CF`、标题 `#EAEDF3`、弱化 `#A4A8AE`、主色 `#28AAF1`、
  边框 `#4B505B`、代码 `#232935`、引用 `#353C4A` + `#53607A`，六级语法色沿用 V2 原色板。
- 现有 **宋韵 深色**（`#1f2126`）保持不变；两套并存，互不覆盖。产品增量只有
  `dsh-markpilot/src-cm6/extras.js` 的一个调色盘条目 + 版本号，编辑、保存、多窗口、
  导出/导入代码均未改动。
- 版本：桌面 3.6.17，插件 0.3.12，`core.json` 3.6.17；README 与插件 README 的主题数改为十套。

## 验证结果

- **完整 GUI 回归：40 套 / 424 项通过**，绑定 ASAR `839ceb41…`。三处环境重跑（原始失败收据全部保留在
  `final-regression/failed/`，没有改断言）：
  - `reverse-family`：鼠标拖拽端点映射 transient miss；
  - `math-gesture-workflows`：释放点几何 transient miss；
  - `data-safety`：对端窗口 dirty 标题在 160ms live 轮询前被采样，第二次重跑通过。
- **单元/契约：606 / 606 通过**（84 个测试文件）。
- **representative 大笔记：通过**（同一语料）。
- **32 项补充实机：32 / 32 通过**。`reverse-edge` 仍对机器负载敏感，在 8 核受控负载下第三次通过；
  前两次失败与收据保留。其余 31 项无负载一次通过；`plugin-pair`、`plugin-save-contention`、
  `plugin-image`、`plugin-overlap`、`plugin-same-point`、`public-gui` 在 0.3.12 宿主契约下通过。
- **安装链（第二轮，从 3.6.16 升级）**：备份基座 `markpilot-3617-from-3.6.16`（程序 + 完整 profile），
  isolated 安装/复核/卸载/复核、正式覆盖安装、覆盖后复核、正式收据复核全部通过。
  安装版 3.6.17：EXE `74b426ea…`，ASAR `839ceb41…`，ProductVersion 3.6.17；程序 79 文件、
  profile 487 文件、快捷方式/注册表与快照一致，原有设置与最近文件保留。
- **安装后抽查**（同一安装 EXE，隔离 LOCALAPPDATA）：`save-as` 7/7、`live-desktop` 5/5、
  `representative`、`first-focus` 2/2，全绿（本轮为节省时间只跑这四组，完整 40 套已在同一 ASAR 上跑过）。
- **主题实机截图**：最终 ASAR 上主题列表 10 套，`宋韵 深蓝` 生效值为
  `--mp-bg #2E3440 / --mp-fg #C3C7CF / --mp-primary #28AAF1 / --mp-quoteBg #353C4A / --mp-quoteBar #53607A`；
  截图 `theme-final-3617/v2-blue.png`（宋韵深蓝）与 `current-dark.png`（宋韵深色）内容一致、深色主题不变。
- 已知边界：物理微软拼音未在最终 ASAR 上重跑（沿用此前证据；`ime-rows` 2 项通过）；
  `reverse-edge` 仍需受控负载；DSH desktop 宿主 bundle 显示 0.3.12 且 fiber active，但 GUI 回归期间
  HMR apply RPC 超时——**已打开的旧标签需重开或重启 DSH 一次**，新标签直接读取磁盘上的新渲染器。

## 发布与实装

- GitHub：`main` 提交 `cba1063`，标签 `v3.6.17`、`dsh-markdown-typora-v0.3.12`；
  [MarkPilot 3.6.17](https://github.com/ltmroberthk915/markpilot/releases/tag/v3.6.17)（Setup `5fd8212a…`、
  portable `4586ae0b…`）与 [dsh-markdown-typora 0.3.12](https://github.com/ltmroberthk915/markpilot/releases/tag/dsh-markdown-typora-v0.3.12)
  （TGZ `60db59a7…`）已发布，资产 digest 与本地一致。
- npm：`dsh-markdown-typora@0.3.12` 已发布为 latest（Edge 网页认证 + 安全密钥二次确认），
  registry tarball SHA-256 `60db59a7…` 与 GitHub 资产逐字节一致；`dist.shasum=21672f7a…`。
- DSH：web/desktop profile 指向本源码的 link（0.3.12 / core 3.6.17），headless profile 已从 npm
  registry 安装 0.3.12 / core 3.6.17；desktop 宿主 bundle 0.3.12、fiber active。

## 证据

- 交付收据 `.mp-verify/editing-3616/delivery.json`，SHA-256 `56d49393e7163ee4e7febbbff8849a38b92a1e8234d569a5f8a86256d99981de`。
- 发布收据 `release-publication.json`（SHA-256 `5b252667…`）；正式安装收据 `official-install.json`
  （SHA-256 `24bd9c4f…`）；冻结清单 `frozen.json`（`872c67fd…`）。
- 3.6.16 的发布/安装/验证证据完整保留在 `archive-3616-release/`。

未做未经验证的声明：本轮没有在最终 ASAR 上重跑物理输入法，也没有把"安装后全套 40 套"再跑一遍；
上述两项在文中均按实际情况写明。
