# MarkPilot 3.6.6 核验与发布记录

范围：核验 3.6.5 交接的转义竖线输入疑点，修正测试，发布现有已验收编辑引擎。没有修改数学选区过滤器，也没有展开历史审计清单。

## 转义竖线结论

在实际安装的 3.6.5 上，以相同夹具和真实键盘输入验证：单元格源码为 `a\|b`，DOM 显示为 `a|b`。

- Home、Right 一次：DOM 偏移 1，输入 R 得到 `aR\|b`；撤销恢复原文。
- Home、Right 两次：DOM 偏移 2，输入 R 得到 `a\|Rb`；撤销恢复原文。
- 第二种情况下，立即读取的 CM 光标仍为源码位置 26（a 后）；原生 DOM 光标已在竖线后。keydown 在浏览器默认移动之前同步，selectionchange 随后同步；输入时读取真实 DOM 光标，因此产品插入位置正确。

原 autosave-liveness 探针从未同步的 CM head 生成 expected，误把正常插入判为偏移。探针现记录两种选区，分别固定验证竖线前后插入及撤销；原来的两次 Right 流程等待 DOM/CM 选区收敛后运行，其预期值来自夹具语义，不再从被测状态生成。原失败收据保留。

实机诊断：`.mp-verify/remediation-363/full-reverify/pipe-diagnose-366/result.json`，两幅局部放大图已打开核对，分别显示 `aR|b` 与 `a|Rb` 及 R 后光标。

受控构建的引擎 SHA-256 仍为 `823214be44625adc643d7a49764f6b3e5a03725fca459f053d2d11f3dcedd1a4`，与 3.6.5 相同。引擎源码 SHA-256 仍为 `141f567c35b02c8c134dd707248e21bad8715def63406a6b831289db1bd58878`。版本资源为 FileVersion 3.6.6.0、ProductVersion 3.6.6。

## 交付证据

在最终 3.6.6 stage 上，指定回归共 64/64：autosave-liveness 2、table-interaction 8、cell-format 2、cell-composition 1、selection 31、math 16、mixed-selection 2、split-source 2。剪贴板保存并恢复，无残留测试进程。表格输入前后放大图已打开核对。

约 9 MB 真实文档副本的加载、输入、撤销重做、保存独立回读、还原与渲染六步全部通过；加载 3,654 ms，最终副本逐字节还原，原文件 SHA-256 仍为 `a15c5d57227884a165d531b50db24c5b39f61082ac30a4e7cd16d255257fe8c2`。

Setup、portable、UUID 隔离 Setup 均解包核对完整 ASAR 成员和 78 个运行时文件。隔离身份在含空格路径实际安装及卸载，原安装完整保留、独立注册项移除。正式安装升级至 3.6.6，实际安装版再次通过 autosave-liveness 2/2，包括竖线两侧插入。

正式安装目录：`D:/Users/Ming/AppData/Local/Programs/MarkPilot CM6`。EXE SHA-256 `e61f0c541d32f735e1e78ebc17358c5ab8e2ad7370a03417b90e9fa75dc95255`；ASAR SHA-256 `c2216c4d696c93168b0022c60606cf209022851ad5062c5371ec0ed73323f570`。

整个用户 profile 的 487 个文件哈希不变，settings/recents 均保留；`.md` 的 Windows open 关联指向正式安装版，开始菜单快捷方式保留。原注册项对比出现一处 Windows AppModel 最近使用时间计数变化，已由已有分类器确认仅 QWord 时间递增且位于安装时间段；未观察到其他非产品注册变更，未修改该系统计数。原始失败及分类收据均保留，不推断其写入进程。

升级备份：`C:/Users/Ming/.codex/backups/markpilot-366-upgrade-20261030`。交付目录：`D:/BuyKey/MarkPilot-3.6.6`，含 Setup、portable、SHA256SUMS.txt。

- Setup SHA-256：`ff28452ccccfeae777e4e1822d9b7060e32bc46348c879f0aeef2b09ee18834f`
- portable SHA-256：`c6366e820266641293c41e6fb27d0579a50c809bd14f749878efc5804872ffc6`

证据索引：`.mp-verify/remediation-363/full-reverify/release-366-receipt.json`、`regress-366/result.json`、`payload-366/result.json`、`exam-large-doc-366/result.json`、`installed-366-autosave/result.json`。原测试误报收据与历史审计状态保留。私有文档、profile 与原始截图不进入仓库或 Release 附件。
