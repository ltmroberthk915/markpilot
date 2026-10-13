# 3.2.5 公开质量证据

判据、根因分组、架构建议与覆盖边界见 [审计记录](../../LOG-3.2.5-AUDIT.md)；运行入口见 [质量工具](../../../tools/quality/README.md)。数据均来自合成夹具，安装包、profile、临时 bundle 和模型会话未发布。

| 目录 | 结果 | 小型证据 |
| --- | --- | --- |
| [infrastructure](infrastructure/result.json) | 8/8 工具自测；124 历史 CJS 预检通过 | TAP 原文、Node 版本、新工具语法检查、公开帧/PDF 哈希核对 |
| [acceptance](acceptance/result.json) | 19 项，18 通过 / 1 失败 | 9 张截图，包括非法 Mermaid 的失败提示、双击选区 |
| [critical](critical/result.json) | 26 项，9 通过 / 17 失败 | 17 张截图；Ctrl+V 为通过项，17 失败不能当作独立 bug 数量 |
| [performance](performance/result.json) | 5 档输入完整性通过 | 预热与 30 样本 P50/P95/原始时间、运行环境 |
| [build](build/result.json) | 构建成功，bundle SHA 不同 | 固定安装后的实际依赖版本与两个完整 SHA |
| [rebuilt-source](rebuilt-source/result.json) | 17 项，16 通过 / 1 失败 | 只发布 JSON；截图哈希仍记录，published=false，不重复发布中间图 |
| [pdf](pdf/identity.json) | 从 A 导出实际得到 B | [原 PDF](pdf/primary.pdf)、[可见页面](pdf/primary-pdf.png)、[预期 A 的失败判据](pdf/expected-primary.json)、[读取 B 的正向对照](pdf/positive-secondary.json) |

`result.json` 记录的 `passed=false` 和失败断言是当前产品结果，不应为了获得 CI 绿灯改成成功。每张公开截图 SHA256 在其套件的 frames 清单；PDF 与页面图的 SHA256 在 identity.json。机器绝对路径已替换，长 inline 文本只公开摘要/长度/哈希，复跑时原始结果在本机输出目录。

Ctrl+V 的图片证据以 [重开后的位图](critical/clipboard-assets-reopened.png)为准，光标落在图片行的另一张截图显示 Markdown 源码，不能只凭源码截图断言位图已显示。

关键截图由主控或 DeepSeek Flash 实际打开复核；其余流程帧随 trace 归档，不单凭有截图就判定界面正确。发布版通用验收新增的错误提示、双击选区，以及实际 PDF 页面也由主控打开核对。红色光标标记是坐标叠加，不能当作原生 caret 的截图。
