# 3.2.13 实际交付记录

3.2.13 已正式打包并在既有 CM6 程序目录完成 3.2.12→3.2.13 升级，实际安装后验收通过，未推送。真实安装身份核验时间：2026-10-12T02:37:20.971Z。

本次只修分屏源码窗格点击精确表格位置后立即输入的 owner 交接。原失败是源码位置28被点击，R却写到表后；修订复用搜索的同格闭区间与codec精确映射，成功后保留单元编辑焦点，普通正文走CM正控。没有新历史栈或焦点定时器，Undo/Redo与继续输入仍用既有CM6历史。

可复跑工具包括[源码窗格操作链](../tools/quality/split-source-workflows.cjs)与[根因突变工具](../tools/quality/workflow-mutations.cjs)；输入资格、选区、焦点、真实磁盘与清理的判据见[验证手册](VERIFICATION.md)。

## 实际身份与验收

| 项目 | 已核验结果 |
| --- | --- |
| 正式安装 PE SHA256 | b73fd93ee4dd2ebdc4f39e686df57cfbddc00952cc7412777ed7b22008232ddd |
| 正式 ASAR SHA256 | 08a6de1a9b6be8a6b8033ec5c8dbf5b6fd3f8277a674ed4c35bcc6b58dad4e51 |
| FileVersion / ProductVersion | 3.2.13.0 / 3.2.13 |
| 源回归 runtime PE12 SHA（刻意复用） | d300992b1003765f2f64417269c124f0c7b14af65ce415ad2488d166e6f63e13 |
| 完整源回归 | 24套 / 345场景，通过 |
| 根因突变 | 仅split-source-cell-owner，table原错误红 / plain正控绿 → 精确恢复同ASAR后两臂绿 |
| Node单测 / preflight | 89通过 / 124份源码静态检查通过；124不是GUI场景 |
| 新独立视觉复核 | 41张实际unique SHA；独立工具审计45次成功图像调用 |
| Portable / 隔离安装卸载 / 实际安装 | 6 / 9 / 6场景，通过 |

三份包的完整payload/runtime/resource均核对；正式PE版本与图标资源由实际候选及安装回读验证。隔离含空格路径真实安装后卸载，生产安装保留旧v2文件、profile、shortcut和registry合同。6/9/6是本批定向发行边界，与345源场景不是覆盖百分比。

## 当前实际性能与限制

| 夹具 | steady p50 | steady p95 | first |
| --- | ---: | ---: | ---: |
| plain-1000-lines | 18ms | 22ms | 20ms |
| plain-10000-lines | 32ms | 38ms | 32ms |
| plain-100000-lines | 31ms | 37ms | 30ms |
| math-1000-lines | 31ms | 34ms | 19ms |
| math-10000-lines | 32ms | 34ms | 34ms |
| backspace-100000-lines | 31ms | 34ms | 30ms |
| code-100000-lines | 31ms | 33ms | 17ms |

七档routine steady p95为22–38ms，实际门槛50ms；测量是CDP输入至下一renderer animation frame，含传输和帧节奏，不含之后全文回读，不能外推其它设备或长时操作。约555008 UTF-16单位的引用Enter连续20次：first=130ms、steady p50=106ms、p95=144ms；这是结构补齐路径，单独记录且没有50ms门槛，不声称只慢第一次。

P2活动格「更多→重新加载」失焦仍未修，实际12/canonical13已另证第一条focus失败，排除345。该探针未执行后面的历史和继续编辑断言，不能由此宣布已证错删或历史损坏。[失败证据与复跑入口](verification/quality-3.2.13/known-issues/README.md)已归档，仅调整两条导入路径，未另开GUI或修复批次。半转义/分隔行保留原源码合同；OS物理菜单/加速键、系统IME候选和未测窗口外生命周期不在保证范围。

结果见[正式合成验证快照](verification/quality-3.2.13/snapshot.json)、[实际安装记录](verification/quality-3.2.13/installed.json)、[小型图像工具审计](verification/quality-3.2.13/image-tool-audit.json)。[旧待交付快照](verification/quality-pending-3.2.13/README.md)保留创建时状态及全部原JSON/PNG，顶部仅加历史归档链接。架构事实与性能边界见[3.2.12架构记录](LOG-3.2.12-ARCHITECTURE.md)。本批交付至此收口，未启动3.2.14修复。
