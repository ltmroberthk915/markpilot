# 源码双屏双向定位：已完成验收

私版 EXE 1.0.17 / VSIX 0.1.27-local，2026-09-08 13:32 最终构建。
已实现右侧点击定位左侧真实源码光标、左侧点击/移动/输入驱动右侧同高对齐，覆盖表格和数学内容。
额外修复：首次窗口激活的容器边界光标导致预览误跳；material 图标重复同步 XHR 导致的 JavaScript 异常。

最终证据：
- .perf/split-navigation-accepted-v3：63/63 双屏场景，JS0。
- .perf/split-navigation-math-regression-v2：68/68 场景，888 次逐步检查，JS0。
- ../Typora-Editor/test/.runs/vscode-1788845529931：最终 VSIX 130/130，Webview/未处理 Promise 错误均0。
- .perf/split-navigation-regressions：9项解析单元及源码切换、公式历史回归通过。
- .perf/split-navigation-manual-exe-1788845722763：最终便携版4项可见复核，含新会话首次先点右侧后 Shift+Right 确認左侧真实选字；JS0；正常关闭。
- .perf/split-navigation-delivery/coherence.json：共同源码、App、ASAR、VSIX477个渲染文件SHA256一致，4个公版产物和当前用户原笔记不变。

最终ASAR SHA256 1f153da1708efd6d6f61ae7214d696ad5b36c6cbd42d6d981bccd96a967d93c9。
用户笔记本轮固定副本 .backups/2026-09-08-split-navigation/user-note-original.md，SHA256 d5c9d7469bea1540cfc2d6c83d58894cbf874abb9f2ed201825f7ad253ce1dfb（用户12:09:34更新版本）。

完整交付报告 docs/CHANGE-REPORT-PRIVATE-SPLIT-NAVIGATION-1.0.17.md，机器验收索引 .perf/split-navigation-delivery/accepted.json。
所有隔离测试窗口均已关闭；旧失败证据与旧构建基线保留，最终包路径见报告。
