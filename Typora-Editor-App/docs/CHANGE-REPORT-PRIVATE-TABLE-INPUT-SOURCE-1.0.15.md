# marcopilot 私版验收补充报告：表格输入、公式光标与源码视图

日期：2026-09-08  
范围：私用版 `marcopilot` 1.0.15 / VSIX 0.1.25-local；作者/发布名：Jinxi

## 结论

本轮针对“表格内任意键入导致表格消失”的报告，使用真实 Electron 宿主、打包后的私版 App、原始复现文件和真实用户笔记进行了串行实机回归。当前复现结果为通过：表格在 IR 与 WYSIWYG 两种视觉编辑模式下，逐字符输入、图片缩放后输入、媒体替换、结构编辑、撤销重做、模式切换、独立文件重开和源码往返均未消失。

本轮同时修复正文 `Ctrl+Shift+E` 的公式光标落点：IR 重排后会把光标恢复到新建行内公式源码内部；空选区会落在 `$$` 两个美元符号之间。用户说明中的 `Ctrl+Shift+Enter` 按笔误处理，产品没有添加该快捷键或配置项。

## 发现并修正的测试缺陷

这次复跑暴露出测试覆盖与断言设计的问题，已补入测试套件：

- 真实笔记包含 2 个表格，旧断言错误地要求表格数必须等于 1；现改为验证目标表格结构、行列和源文本不变，并额外验证远处表格。
- 正文输入会改变后续快捷键测试的探针文本；各场景现在从真实文件重新复制干净副本。
- Webview 输入事件、宿主 `TextDocument` 更新和磁盘保存是异步链路；测试现在等待宿主源文本确认后再验收磁盘，避免把宿主尚未落盘误判为产品丢数据。
- 启动时的会话恢复可能晚于直接打开文件；测试先等待宿主 boot 完成，再打开目标文件。
- Electron 宿主使用单实例/共享测试状态；回归改为串行执行，避免并行套件互相抢占窗口、配置或文件。
- 失败诊断中的临时 probe 已移除；保留当前通过结果和可复核快照。

因此，早期“消失”信号中有一部分是测试假失败或时序污染，不应直接作为产品已稳定的证据；本轮已将这些情况纳入覆盖，并对原始路径做了逐字符复现。

## 产品改动

### 公式快捷键与光标

`edit-shortcuts.js` 在 IR 模式下记录编辑前所在块，完成 `$…$` 插入后查找本次新建的 `code[data-type="math-inline"]`，在 Vditor DOM 重排完成后把光标放回公式源码末尾。对空选区保留 `$$` 中间位置。WYSIWYG 与 SV 继续使用原有行为，避免改变已通过的行内代码和源视图快捷键语义。

### 一键源码视图

工具栏新增 `source-toggle`。视觉模式点击后进入 SV，再次点击：

- 若源文本未改变，恢复原 IR/WYSIWYG DOM 节点和光标缓存，不重新解析未变更内容；
- 若源文本已改变，走正常重建路径并保留修改；
- 切换本身不制造脏状态，真实宿主保存仍走原通道。

### 右键菜单与表格媒体

右键菜单改为按主题使用不透明背景、边框、悬停色和阴影，避免表格文字与菜单选项重合。表格内图片右键继续同时提供图片设置与表格操作；直连表格图片、图片缩放后的源对齐和撤销/重做路径均纳入回归。

## 验证矩阵

以下数字按逻辑检查项计数；测试输出因宿主日志转发可能重复显示，不重复计数。

| 范围 | 结果 |
| --- | --- |
| 真实用户笔记 `D:\Users\Ming\Desktop\实用经济与金融理论\1-重识概率论.md` | 12/12 PASS：8 个表格可见单元逐字符输入、正文输入、正文选区 `Ctrl+Shift+E`、公式内光标、空公式光标；另有保存落盘断言通过 |
| 原始复现 `D:\BuyKey\Typora-Editor-App\.perf\media-office-1.0.15\workspace\media.md` | 4/4 PASS：IR/WYSIWYG 逐字符输入及正文公式光标 |
| 开发树表格输入宿主 | 17/17 PASS：普通/公式/代码/图片单元格、缩放两次、媒体替换、插入行列、撤销重做、模式切换、独立文件重开、源码往返 |
| 私版打包 App 表格输入宿主 | 17/17 PASS |
| 开发树源码切换宿主 | 5/5 PASS |
| 私版打包 App 源码切换宿主 | 5/5 PASS |
| 私版打包 App 右键菜单宿主 | 11/11 PASS：复制、plain text、粘贴、剪切、六项表格结构操作、撤销重做、保存 |
| 私版打包 App media-office | 16/16 PASS：图片像素/缩放/生命周期/表格输入/DOCX 导出 |
| 渲染层 features | 57/57 PASS；数学、代码、引用、IME、快捷键设置、Mermaid |
| 数学 Markdown 与边界 | 23/23 + 8/8 PASS |
| VSIX 隔离 VS Code 宿主 | 105/105 PASS；最新 VSIX 解包后激活、Webview、三模式、媒体、撤销、公式、补全及异常通道 |

已保留的历史证据仍包括媒体生命周期 5/5、保护 19/19 + 桌面 10/10、导出 16/16 + 桌面 27/27、启动 30/30 + 文件启动 30/30、补全 4/4 及桌面补全 22 项等。Trae 宿主复跑和 Pandoc 对照仍未执行，不作已完成宣称；当前报告也不重新宣称本轮原生 Office 8/8，原生 Office 结果以此前报告中的证据为准。

## 私版产物

| 产物 | 大小 | SHA256 |
| --- | ---: | --- |
| `dist/release-1.0.15-private-final/marcopilot-Setup-1.0.15.exe` | 116,209,366 B | `3AAA26564DF13AB74450807747B0039F697CAF7530165211CCCB03F3F5AD5995` |
| `dist/release-1.0.15-private-final/marcopilot-v1.0.15-portable.exe` | 115,981,956 B | `56042B5F0F8D8500494544750D964341B65494B3FA3E8788E04BF8224D393E67` |
| `dist/release-1.0.15-private-final/win-unpacked/resources/app.asar` | 23,144,575 B | `E7A654F6FE6BEA38EFB773BE4CA82A54DA0EF2DDC399F315A81ADB4EDA372F26` |
| `D:\BuyKey\Typora-Editor\dist\marcopilot-0.1.25-local.vsix` | 6,201,993 B | `A399477848A2B7C81BDC1650E3C92948859D1182153752C32A6E2BC6B8A96C28` |

VSIX 最新包为 496 个文件，使用 `private/self-use` 打包配置。公版产物未被覆盖；当前公版 Setup、portable、App ASAR 和 Jinxi VSIX 的 SHA256 与冻结记录一致。

公版隔离审计重新执行并通过 11/11：发布元数据作者为 Jinxi，`apiEnabled=false`，远程 completion 实现、个人 API/密钥存储和远程渲染分支均未进入公版 App ASAR。私版与公版继续并行保留；本轮没有向 VS Code、Trae 或开放 VSIX 市场上传文件。

## 可复核证据

- [真实用户笔记宿主结果](../.perf/user-file-host/results.json)
- [原始 media.md 复现结果](../.perf/media-repro-host/results.json)
- [表格输入宿主结果](../.perf/table-input-host/results.json)
- [源码切换宿主结果](../.perf/source-toggle-host/results.json)
- [右键菜单宿主结果](../.perf/table-context-host/results.json)
- [上一版表格/右键收尾报告](./CHANGE-REPORT-PRIVATE-TABLE-CONTEXT-1.0.15.md)
