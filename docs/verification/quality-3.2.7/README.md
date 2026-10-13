# 3.2.7 验证证据

这是本地源码、实际产物及交付验证记录，没有推送或发布。判据和解释见 [LOG-3.2.7](../../LOG-3.2.7.md)，复现命令见 [工具说明](../../../tools/quality/README.md)。

| 结果 | 证据 |
| --- | --- |
| 56 个单元及工具判据；124 份源文件预检 | [checks.json](checks.json) |
| 编辑/上下文/导出 75/75 | [editing/result.json](editing/result.json) |
| 关键回归与系统位图粘贴 26/26 | [critical/result.json](critical/result.json) |
| 五种真实输入及 Mermaid 19/19 | [acceptance/result.json](acceptance/result.json) |
| 后台树与原生命令 28/28 | [worker-integration/result.json](worker-integration/result.json) |
| 窗口、保存、编码 23/23 | [data-safety/result.json](data-safety/result.json) |
| 两组交替性能原始样本 | [A1](performance-a1/result.json)、[B1](performance-b1/result.json)、[A2](performance-a2/result.json)、[B2](performance-b2/result.json) |
| 连续结构回车：后续 P95 162ms | [structural-latency](structural-latency/result.json) |
| 六种真正源码回退与恢复 | [source-negative-controls](source-negative-controls/result.json) |
| 缺失/超时/协议错误降级 | [missing-script](worker-fault-missing-script/result.json)、[timeout](worker-fault-timeout/result.json)、[protocol-mismatch](worker-fault-protocol-mismatch/result.json) |
| 应用 bundle 和 Worker 回建一致 | [build-reproducibility](build-reproducibility/result.json) |
| 三个 EXE 的版本与哈希 | [candidate.json](candidate.json)、[package-payloads](package-payloads/result.json) |
| 最终便携包的实际测试 | [关键](portable-critical/result.json)、[通用](portable-acceptance/result.json)、[Worker](portable-worker-integration/result.json) |
| 隔离安装版的实际测试 | [关键](isolated-critical/result.json)、[通用](isolated-acceptance/result.json)、[Worker](isolated-worker-integration/result.json) |

选择性保留 20 组全图/局部 2x PNG，共约 1.7 MiB。未收录像素的帧在 JSON 中标记 `published=false`；全部原始帧及放大帧的 SHA 在导出之前仍被校验。红线是光标位置标记，原生选中背景直接来自应用。合成夹具、结果和小图可以公开；用户配置、备份、凭据、CPU 大轨迹、安装 EXE 和中间产物留在 `.mp-verify`。

代表性像素：引用代码 [全图](editing/code-enter-quoted.png)/[2x](editing/code-enter-quoted-caret-2x.png)、多光标 [全图](editing/code-enter-multiple.png)/[2x](editing/code-enter-multiple-caret-2x.png)、位图保存重开 [全图](critical/clipboard-assets-reopened.png)/[2x](critical/clipboard-assets-reopened-caret-2x.png)、键鼠 Shift 选区 [全图](acceptance/10-shift-click-selection.png)/[2x](acceptance/10-shift-click-selection-caret-2x.png)、Worker pending 数学补全 [全图](worker-integration/worker-math-priority.png)/[2x](worker-integration/worker-math-priority-caret-2x.png)。

这些套件有重复判据，不能相加推算覆盖率。预检没有运行 124 个 GUI 场景，CDP composition 没有验 Windows 原生候选窗口，普通输入性能不代表结构键性能。实际用户升级结果完成后单列，不以隔离安装冒充。
