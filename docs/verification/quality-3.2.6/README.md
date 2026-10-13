# 3.2.6 本地候选证据

只公开合成夹具的 JSON、截图和小型清单。安装包、运行时、profile、临时源码、剪贴板备份和模型会话均不提交。

- [便携版数据安全 23 条](portable-data/result.json)：窗口与 UTF-16；全图及对应 2 倍 caret 局部图。
- [通用验收 19 条](acceptance/result.json)：五种真实输入通道，Ctrl+U 旧失败保留为红。
- [关键回归 26 条](critical/result.json)：截图粘贴、窗口、UTF-16 通过；11 条前端旧失败保留为红。
- [性能 5 档](performance/result.json)：记录原始 30 个样本与环境，不证明行业比较。
- [隔离安装后 23 条](installed-data/result.json)及[安装/卸载记录](installation.json)。
- [三个安装/便携文件载荷核对](payload.json)与[候选文件清单](candidate.json)。
- [实际 PDF 正文核对](pdf.json)及[页面像素](primary-pdf-page.png)：主窗口正文，未含副窗口标记；文本提取的重复/交错原样记录。
- [编码旧读取回退](read-mutant/result.json)、[旧写入回退](write-mutant/result.json)与[恢复 SHA 核验](negative-controls.json)。

实现与范围见 [工程记录](../../LOG-3.2.6-CANDIDATE.md)。便携启动器、内层 exe、asar、源文件分别记录完整 SHA；模型助手不能运行 shell 的情况下仅做视觉/文本复核，主控重算哈希。

正式 Setup 仅做构建与载荷对账；实装使用唯一测试 appId 的静默安装配置，保留现有两个版本的安装及 profile。它验证同一应用载荷的安装后行为，未验证用户升级、原生对话框或自动更新。没有发布公共二进制。

安装后截图和突变截图的重复副本只保留在本地；JSON 中标记 `published:false`，不把未发布图片伪装成公开附件。其他 PNG 包含对应全图和 2 倍局部图，并经逐文件哈希检查。
