# MarkPilot 3.6.16 共享编辑与保存稳定性验证

基线为本机正式安装的 3.6.15。原始记录在私有目录 `.mp-verify/editing-3616/`，上一候选（D1）的全部失败与中间证据完整保存在 `archive-D1-evidence-1104-105433/`，未被覆盖。真实个人笔记只用于制作隔离副本，只读，SHA-256 未变。

## 本轮修复的两个真实缺陷

| 缺陷 | 修复前实测 | 修复后验收 | 收据 |
| --- | --- | --- | --- |
| 共享房间里点「保留我的修改」无法落盘 | 原文件被外部程序改写后 Ctrl+S 得到冲突提示；另存为到两个硬链接目标均被拒；点恢复横幅「保留我的修改」再次报「此文件有未保存的编辑」，磁盘不变 | 点击后磁盘写入本窗正文 `alpha\nomega\nLOCAL LATER`，两个硬链接目标仍为 `FOREIGN`，点击前横幅与草稿原样保留 | `final-regression/save-as-workflows/`（7/7，含 7 种另存为/冲突路径） |
| 剪切→撤销→重做后保存被判为「无效的协同编辑」 | 同一份混合图文笔记反向拖选、Ctrl+X、撤销、重做后 Ctrl+S，保存以 `MP_LIVE_CHANGE` 失败，磁盘停在外部内容 | 撤销/重做序列后空增量不再上行，保存成功写入剩余正文，撤销、重做、磁盘三条断言通过 | `final-regression/reverse-family/`（5/5，连续两次），`tools/quality/tests/live-document-noop.test.mjs`（2/2） |

两项修复涉及的产品文件只有 `MarkPilot-CM6/main.js`、`renderer/host.js`、`shell/live-documents.js`、`renderer/cm6/app.js`（后者由 `dsh-markpilot/src-cm6/live-document.js` 构建）。其余构建产物与 D1 逐字节相同（重建前后 412 个文件哈希比对，唯一变化为 `app.js`）。新增单测 `live-documents-keep.test.cjs`（5 项）与 `live-document-noop.test.mjs`（2 项）。

## 场景复核

| 场景 | 验收判据 | 收据 |
| --- | --- | --- |
| 两窗协作同一文件 | Y 窗保存 `Y-DRAFT`，X 窗同步后追加 `X-DRAFT` 再保存，磁盘为 `SHARED BASE\nY-DRAFTX-DRAFT`，两窗正文一致，无冲突横幅 | `final-regression/data-safety/same-file-collab.png`，该套 23/23 |
| 冲突后另存为并回源 | 冲突横幅点「另存为…」写入新文件后回到源输入位置；该套 9 项全过 | `final-regression/reload-workflows/` |
| 多窗口与跨进程协同 | 未保存不传播、各自撤销、外改拒绝或明确保留、崩溃恢复、三窗交叉撤销 | `probes/live-desktop` 5/5、`probes/live-boundaries` 3/3、`stage-targeted/` 相关套件 |
| 反向拖选与表格 | 公式内、跨段、图片右侧空白；表格浮动菜单、End/Backspace、HTML 表格粘贴 | `final-regression/reverse-family`、`table-interaction-workflows` 等冻结套件 |
| 代表性大笔记 | 9,033,628 字节学习笔记隔离副本的选区/剪贴/撤销/重开 | `representative-final/verified.json` |

## 冻结候选

- 完整桌面回归 **40 套 / 424 项全部通过**，冻结文件 `final-regression/frozen.json`（SHA-256 `09eba9bd…`），合并摘要 `summary-complete.json`（`84c95ec4…`）；原始失败摘要 `summary.json`（`c96891f3…`）与四次重跑的原始证据全部保留。
- 四次重跑均为环境时序，未改任何断言或冻结输入：`first-focus`（前台锁）、`study-images`（原子替换+备份窗口的瞬时 ENOENT）、`data-safety`（对窗脏标在下次 160ms 轮询前被采样）、`reload-workflows`（另存为落盘后渲染端收尾前采样焦点）。
- 单元测试 **606/606**，无失败、无跳过；3 个独立插件脚本 `bridge-live-facade`、`client-live-pure`、`live-protocol` 均退出 0。日志 `unit-takeover.log`（SHA-256 `6de2f94c…`）。
- 补充实机 **32/32 套通过**。`reverse-edge`（顶边反向拖选）对轮询节拍敏感：该夹具在 250 次轮询预算内需自动滚过约 2,600 像素，本机空闲节拍每次只前进 8–9 像素，预算内到不了目标带；在受控 CPU 负载下复跑（脚本与 helper 哈希不变）通过，选中区间精确 `1043→265`、指针释放点命中 `265`、系统剪贴板逐字一致、撤销恢复反向区间、磁盘原件完好（收据 `stage-targeted/reverse-edge-retry-1793770249968/result.json`，guard SHA `dc1c8416…` 与脚本一致）。用同一未修改脚本在上一已验收 D1 候选上复跑仍失败（`reverse-edge-d1-recheck/`），说明是本机测试夹具的时序/布局假设，不是本候选新增的产品缺陷；此前全部失败与重试收据保留。
- DSH 插件 0.3.11 TGZ 重打包并复核：146 个文件、124 个内置引擎文件、8 个共享 host 文件与冻结 stage 逐字节一致。SHA-256 `ff08745d…`。

## 安装与交付

隔离安装与卸载：新增恰好 1 个隔离卸载登记，卸载后归零；程序与 profile 全量逐文件对比通过，未预期变更 0。随后正式安装器将本机安装升级为 3.6.16：安装后 77 个运行文件、163 个应用包成员与候选一致；PE `ProductVersion=3.6.16`、`FileVersion=3.6.16.0`，应用包版本 3.6.16；487 个用户配置文件逐字节保持，产品自有登记与两个快捷方式按白名单更新；闭窗快照与稍后复读零漂移。

| 本地产物 | SHA-256 |
| --- | --- |
| `markpilot-Setup-3.6.16.exe` | `92fa932d7d3739a1f14f19e698ced8c005ce5a305013e7264c8fb11176a3daa0` |
| `markpilot-3.6.16-portable.exe` | `7733222575c80184e45784ae06f7060375463f6bf8b0b4ce22859715b21f6fbb` |
| `dsh-markdown-typora-0.3.11.tgz` | `0169a98df28d34d546a9b4755b8f88236bd59810e39ba3f50d71f6dc5aaae852` |

实装主程序 SHA-256 `339ff062b49656c53e9587ac9ab1d18dcf3e7d796ca8ad3288a54b2eb1b43d29`，应用包 SHA-256 `a9dd12f84ec42f528c731bb0ec709abb1bdc601eff2dcd2795ebf5283cd584a0`。从正式安装位置另跑 40 项全部通过：反向选择与剪贴 5、另存为/保留我的修改 7、富文本 10、可见图片迟到 2、组字后点击序列 4、跨目录图片 4、双窗实时协同 5、代表性大笔记 1、首键 2。安装版反向选择第一次因窗口/滚动几何瞬时抖动在 `mixed-reverse` 失败，重跑 5/5；首键第一次前台锁失败，重跑 2/2；原始失败记录保留。

DSH 侧：`web` 与 `desktop` 两个 profile 的 `dsh-markdown-typora` 均是指向仓库树的 junction，磁盘上的 `package.json` 为 0.3.11、`core.json` 为 3.6.16，host/live-documents 与 renderer app.js 哈希与本轮源码一致。**本批未重启正在运行的 DSH 宿主**，插件 host 中新增的保留车道在插件自身路径下不启用（默认参数），运行中进程行为不受影响；下一次正常重载/重启后加载同一份字节。

## 保留的观测边界

- `reverse-edge` 的环境限制见上；该套不计为通过。
- 真实微软拼音（公式与表格提交“你”）的物理输入证据来自上一候选 D1（ASAR `d1f12e18…`）。本轮没有在最终 ASAR `a9dd12f8…` 上重跑物理 IME；IME 相关源码未变，但这里不据此声明最终候选的物理 IME 通过。
- DSH 宿主未重启；插件在磁盘上的字节与 TGZ 已核对，运行中模块的加载状态如实记为“未重启”。

完整交付收据为 `.mp-verify/editing-3616/delivery.json`，SHA-256 `27660c85e8558b09e654f74f2ab696b8749a3dd5e733f8f302b604005396f8cf`；正式安装收据 `official-install.json`（SHA-256 `0bbb8126…`）。

## 发布与实装

- GitHub：`main` 已推送（释放提交 `70d0838`、合并提交 `fd94839`，以及 `7000c2d`、`370ed7b`、`34db652`、`28d7dc9`）；[MarkPilot 3.6.16](https://github.com/ltmroberthk915/markpilot/releases/tag/v3.6.16) 与 [dsh-markdown-typora 0.3.11](https://github.com/ltmroberthk915/markpilot/releases/tag/dsh-markdown-typora-v0.3.11) 已发布。Release API 记录的 Setup/portable/TGZ/SHA256SUMS digest 与本地逐项一致；桌面 Release 触发的 winget 工作流成功，插件 Release 同时触发的 winget 工作流按预期失败（它期待桌面 Setup，与 0.3.4 时相同）。
- npm：**仍被阻断**。`npm whoami` 返回 401、`npm publish --access public` 返回 404（无权限）；`%USERPROFILE%\.npmrc` 里的 token 已失效，与 0.3.4 轮记录一致。`npm pack --dry-run` 的 146 个文件、2,654,982 字节与 GitHub 资产一致；换有效 token 或 `npm login` 后重跑即可发布。
- DSH 实装：`web`/`desktop` profile 保持指向本源码的 link（0.3.11 / core 3.6.16）；运行中的 desktop 宿主通过插件管理器 `pluginManager/setBundleEnabled` 关闭再启用 `dsh-markdown-typora`，两次均 `application=applied`、无警告，插件 fiber 为 active；`headless` profile 从本次 GitHub Release 的 TGZ 全新安装为 `dsh-markdown-typora@0.3.11`，下载文件摘要与 Release digest 一致。
- 实装 EXE 为本次 Release 的同一个 Setup：安装版 3.6.16.0 / ProductVersion 3.6.16，EXE `339ff062…`，ASAR `a9dd12f8…`；发布用 Setup `92fa932d…` 为 rcedit 盖章后的安装包。