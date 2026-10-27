# 3.5.7 — PDF 整机资源预算

本批目标是在 3.5.6 的打印进程隔离与内存限制之外，约束 PDF 对整机资源的占用，并在本机独立应用上验证实际响应。没有将先前捕获的单核阻塞推断为整机卡死的唯一成因，也没有宣称 3.5.6 已重新复现整机无响应。

## 实现边界

`PdfWorkerGuard.cs` 在恢复打印进程第一条指令之前，为整个打印 Job 设置 `ENABLE|HARD_CAP = 5`、CPU rate 2500，并通过 Windows Job API 查询读回。无 CPU 限额祖先 Job 时，该值是整机 CPU 的 25%；嵌套时相对祖先份额计算。API 设置或读回失败会终止本次启动，不回退到无约束打印。[微软 CPU rate 定义](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_cpu_rate_control_information)

打印根进程以 BelowNormal 创建，使用真实句柄确认 `0x4000` 后才恢复线程。guard 和编辑器留在打印 CPU Job 之外。此项不是后代进程永久低优先级的承诺，强制树级预算由 CPU Job 承担；没有使用要求额外特权的 Job PriorityClass 限制。[微软优先级规则](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-setpriorityclass)

新增 `GetPerformanceInfo` 的系统提交余量保护，用 `(CommitLimit - CommitTotal) × PageSize` 计算，x64 结构 104 字节。创建前不足 3 GiB 时拒绝，运行中连续两次低于阈值时清理当前 Job。保留 Job 3 GiB、private 2.5 GiB、物理可用内存 3 GiB、期限、取消及父进程寿命保护。这是采样拒绝/回收策略，不是始终硬预留 3 GiB 的承诺。[系统性能页计数](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-performance_information)

`pdf-process.js` 固定默认 CPU 25% 与提交余量 3 GiB，并将 private/物理/提交量保护映射为相应内存提示。渲染侧不能传入这些内部 limits。现有全局 `pdfActive` 在第一个 await 前占用，继续限制同时只有一个导出。主进程、编辑器引擎、字体、CSS、KP、PDF 排版与发布事务没有修改。

## 本机实测

证据根为 `.mp-verify/pdf-system-budget-r1/`，复用的生命周期与真实文档副本在 `.mp-verify/pdf-local-freeze-r1/`。硬件是 Intel Core Ultra 5 125H、18 个逻辑处理器、24 GB RAM。

- 真实文档带限额导出 17.631 / 18.534 秒，均为 83 页、16,155,426 字节；真实 Windows 回执为 flags 5、CPU 25、启动 priority 16384、Job 清空。
- CPU 负控仅在私有辅助程序副本中关闭设置和对应断言，固定六个单忙线程各运行六秒，两臂均受外层 CPU 35%／内存 3 GiB／20 秒保护。关闭时忙区约 32.480%，精确恢复产品辅助程序后约 9.144%，比率 3.552；绿臂嵌套有效预算为 35%×25%=8.75%，没有误报为整机 25%。累计 Job accounting 包含已退出子进程。负控 Node 实际退出 1，恢复臂退出 0；两臂完整清空，夹具 SHA 相同。
- 独立 WinForms 应用只接收合成测试输入，使用受支持的 Sky 真实输入。空闲输入到回读 279ms，PDF 导出期间 361ms；UI 线程记录的第二次文本时间位于真实导出开始与结束之间。整个独立窗口观测期 UI gap 最大约 98.8ms、p95 约 74.2ms；timer 仅作为辅助，没有替代真实输入证据。
- 导出阶段 63 个系统样本：总 CPU 平均约 21.9%、峰值约 46.4%；物理可用内存最低约 9,159 MiB，系统可提交余量最低约 27,259 MiB。PDH 页读、磁盘延迟和吞吐记录有效，单样本磁盘延迟峰值约 0.695 秒，不能据此推断全盘阻塞；同阶段独立 UI 仍有正常输入与消息泵记录。本次没有复现整机无响应。
- 新提交余量预检臂用内部阈值 131,072 MiB 模拟不足，未实际消耗大量内存；返回 `MP_PDF_MEMORY`，未创建打印 worker、未输出 PDF、无残留。
- 最终五通道取消臂通过，取消约 1,630ms，编辑器主进程 heartbeat 最大 184ms。真实源文和历史保持，临时目录清理、正常退出及 Job 清空均确认。

新独立静态对抗和最终代码审查分别记录于 `adversary.md`、`independent-review.md`。完整 ASAR 成员差分记录在 `complete-asar-delta.json`：运行时排版、编辑器和字体资源均逐字节未变；另有四项原有源码树中的构建辅助文件进入包内，已随完整载荷核对。视觉结论明确复用 3.5.6 已实际读取五图的 DeepSeek 验收；本次重新逐 83 页 72dpi 光栅和完整文字对照，均无差异。

准备失败也保留：CPU 夹具初版的 .NET Framework 配置系统不接受扩展长度启动路径，改为在同一继承 Job 内以普通路径重启托管夹具后通过；没有修改生产启动器来迁就夹具。独立窗口的无截图 UIA 几何入口无效，改用新截图的真实坐标并核对焦点。迟于打印结束的输入/关闭没有计入打印期响应结论。所有私有突变和观测应用均未进入交付物。

## 包装与安装

3.5.7 冻结 EXE 为 `3cf8ac9b1b159c1485c8a12911d458767ab6a15c343ba92b64afd91d048ecb82`，ASAR 为 `943199f2c455b47700ee19291ab1098c39eb52fd0010566853fb90c34fc555da`，生产辅助程序为 `629c218ba5c54ffc3c266b2f1d1ccf0d3203462a13fd0a70c9ad21dd329b22e9`。21 项核心、77 项完整运行时及所有 ASAR 成员分别绑定。Setup、便携版、唯一测试身份 Setup 三包完整解包核验通过。

含空格路径的唯一身份安装完成真实输入、精确保存、撤销再保存、83 页导出与卸载，应用实际退出 0、无残留。卸载后原安装 77 个文件、两个 profile 共 520 个文件、49 个原文、5,901 条带类型注册快照和两个快捷方式均一致。

正式升级前重新全量备份安装树、profile、快捷方式并读取原文摘要；安装退出 0。实际生产路径 `D:/Users/Ming/AppData/Local/Programs/MarkPilot CM6` 的 3.5.7 再次完成保存与导出，18.546 秒、83 页、16,155,426 字节，CPU 限额读回 25%，进程正常退出 0、无残留。逐 83 页光栅及提取文字继续完全一致。安装后 77 个运行时文件与包内清单匹配，另外两项是自有卸载器和卸载图标。

两个 profile 和 49 个原文内容保持。注册表仅本产品 DisplayName、DisplayVersion、EstimatedSize 改变；安装器刷新两个快捷方式后，其行为字段本已一致，逐字节恢复已验证备份，最终也与升级前一致。实际安装版 PDF 新建在原文旁的 `北交所博士后笔试-优化版-MarkPilot-3.5.7.pdf`。安装包保留，未推送、未打 tag、未发布。
