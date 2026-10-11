# 私版 1.0.0 前的后台工作记录

用户暂停桌面操作后，补充授权“你执行不需要控制电脑的部分”。本阶段只改代码、运行纯 Node 测试、检查已有证据和准备测试计划；没有启动 IDE/Electron/浏览器交互测试，也没有操作鼠标、键盘或剪贴板。测试使用副本，没有写入用户原笔记。

后台阶段已完成。整体目标仍未完成，当前版本仍为 EXE 源码 1.0.18、VSIX 0.1.28-local；尚未改为或打包 1.0.0。

## 修复与验证

- 扩展宿主：空的失败消息及已关闭面板的迟到通知不再访问失效对象；同一请求的重复范围消息只能添加一次；在同步或命令发现阶段切走编辑器会取消后续附件动作。原有错误处理和附件完成后焦点交接保留。
- 渲染桥接：没有待处理选区时，直接忽略迟到的空来源消息。修复前 24 项测试中 3 项稳定报 Cannot read properties of null；修复后 24 项全部通过，覆盖正常选区、请求完成、超时、改文档、切模式、销毁及快捷键/输入法边界。
- 分屏布局：为已改的 ResizeObserver 延后写入逻辑补充 8 项纯 Node 行为测试，验证连续尺寸变化、取消、销毁、窄窗以及键盘调宽。实际窗口变化仍需桌面复核。
- 后续交互测试：AI 输入标记改为每轮唯一，并验证输入前不存在；性能脚本补充新文档版本、Markdown 哈希和真实光标矩形检查。这两份增强后的 GUI 脚本只做了语法检查，尚未运行。

| 已执行后台检查 | 结果 |
|---|---|
| 全部纯 Node 用例 | 240 / 240，失败、跳过、取消均为 0 |
| 其中：原生 AI 宿主 / 渲染桥接 / 分屏尺寸 | 33 / 24 / 8 项，已包含在总数内 |
| 产品 JS/CJS/MJS 语法检查 | 70 个文件通过 |
| 共享渲染源码 | 479 个文件在两端一致，无额外文件 |
| 公版产物 | 4 个既有产物哈希未变 |

日志及源哈希：[后台结果](D:/BuyKey/Typora-Editor-App/.perf/release100-background/results.json)；[完整 Node TAP](D:/BuyKey/Typora-Editor-App/.perf/release100-background/node-tests.tap)；[渲染桥接修复前失败记录](D:/BuyKey/Typora-Editor-App/.perf/release100-native-renderer-before.tap)；[宿主边界修复前失败记录](D:/BuyKey/Typora-Editor-App/.perf/release100-native-edge-before.log)。

## 已有证据的适用范围

暂停前的 12 对映射测量记录显示耗时中位数降低约 52%–85%，对应锚点一致。但旧脚本没有断言新文档已就绪或光标确实处于屏内/屏外；原笔记的两种操作标签还落在相同锚点。这些数据只作阶段参考，不能作为最终性能结论。恢复后须以增强脚本对基线和当前代码重新测量。详见 [性能核对及限制](D:/BuyKey/Typora-Editor-App/.perf/release100-background/performance-comparison.md)。

暂停前 Trae 记录包含 24 个流程（6 基础 / 18 边缘）及 5 项启动检查，记录中正文未变、捕获异常为零。但其输入标记可在复用的草稿中重复，且之后又改了宿主与渲染桥接；因此不作为当前代码的最终焦点验收。VS Code 完整矩阵和两个 IDE 的真实手动输入都待重跑。详见 [先前 Trae 证据核对](D:/BuyKey/Typora-Editor-App/.perf/release100-background/prior-trae-focus.json)。

## 恢复桌面后仍需完成

1. 按 [64 项流程计划](D:/BuyKey/Typora-Editor-App/docs/RELEASE100-SATURATED-PLAN.md) 逐项补齐证据：16 项基础、48 项边缘。该比例按流程计数，模式/平台/内容的展开数量和断言数另报；所有流程当前均为待验收。
2. 对原笔记的新副本执行公式、表格、嵌套格式、分屏、保存重开及连续操作回归；复核旧光标、迟到回调、输入法和 JS 异常。
3. 两个 IDE 重跑增强后的 Alt+U 矩阵，并用真实鼠标键盘复核输入停留在 AI 草稿；不提交消息。重新测量映射性能及大文件降级。
4. 当前源码全量通过后，将两端版本及 VSIX manifest 更新为 1.0.0，构建私版，核验源码、ASAR、VSIX、宿主代码和公版哈希，再复核实际 EXE/VSIX。旧 run-viewflow-* / verify-viewflow-private.cjs 硬编码旧版本，不能直接作为新版本签收依据。

恢复信息及增强脚本哈希：[机器可读检查点](D:/BuyKey/Typora-Editor-App/.perf/release100-background/checkpoint.json)。
