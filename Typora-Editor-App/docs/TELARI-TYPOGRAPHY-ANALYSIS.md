# Telari 排版艺术设计拆解与 marcopilot 落地方案（v2.0.5）

> 依据：`Telari-0.4.8.dmg` 实物解包（7z 抽取 `Telari.app`，Mach-O 字符串/符号提取、
> `document-themes/*.toml` 全文、内嵌用户配置文档全文）。本文所有 Telari 事实均来自
> 包内字节，推论部分单独标注。

## 1. Telari 排版引擎的真实配置面（从二进制还原）

内嵌配置文档（原文摘录）：

```
# [typography.fonts]
# han   = { family = "Songti SC", scale = 1.0, baseline = 0.0 }
# latin = { family = "New York" }
# code  = { family = "SF Mono" }
# base_size = 16        # pt (8-48)
# justification = "balanced"   # tight | balanced | relaxed
# punct_strategy = "faithful"  # faithful | spacing | fold
# hyphenation_language = "auto"
# cjk_latin_gap = 0.25  # em（clreq/JIS 四分之一 em）
# table_default_align = "left"; table_breakout = true
# math_shrink_to_fit = false
# limit_reading_width = true; max_content_width = 960
# zoom = 1.0  # 0.8–2.0
```

排版引擎（Swift `SpolaTypography`）字段全表（符号名还原）：

| 字段组 | 字段 | 作用 |
| --- | --- | --- |
| 字体族 | latinFamily / hanFamily / codeFamily | 每文字系统独立字体（NY / 宋体 / SF Mono） |
| 每文字系统光学尺寸 | hanScale / latinScale / codeScale | 各自缩放系数（默认 1.0） |
| 基线微调 | hanBaseline / headingHanBaseline | 正文与标题**分别**的 CJK 基线补偿；另有 `songtiBodyBaseline`、`songtiHeadingBaseline` 两个宋体专用常量、`baselineTrimDelta`、`baselineRaise` |
| 节奏 | baseSize / lineSpacing / paraSpaceBefore / paraSpaceAfter / paraSpaceBetween / paraSeparation / firstLineIndent | 字号、行距、段前段后、段距、首行缩进 |
| 标题 | headingScale / headingWeight / headingSpaceBefore / headingSpaceAfter | 标题字号系数、字重、间距 |
| 中西混排 | interCjkNatural / cjk_latin_gap | 中西文间隙（内建自然间隙 + 用户可调，默认 0.25em） |
| 强调 | cjkItalicFace（Kaiti SC）/ cjkStrongFace | 中文斜体=楷体面；中文粗体=独立字面（非合成加粗） |
| 数学 | mathFont（"New Computer Modern Math"，GUST 许可）/ mathRadicalGap / mathFracBarOverhang | 数学专用衬线字体 + 根号/分数线微调 |
| 断行 | justification（tight/balanced/relaxed）/ hyphenation_language / hangingPunctuation / raggedCodeFraction | 三档 Knuth-Plass 断行、断字词典、标点悬挂、代码参差比例 |
| 上下标 | superscriptShift / subscriptShift | 上下标位移微调 |
| 标点 | punctStrategy（faithful/spacing/fold） | 半角标点在中文里的显示策略（只改显示层，不动文件） |

## 2. 艺术设计逻辑推理

1. **衬线正文 = "书页语义"。** 正文用宋体 + New York 双衬线，而非界面感的黑体/
   SF。这是把编辑器当作"纸"来设计：长文阅读的研究共识是衬线在长行 LOWERCASE
   连续文本中引导视线更省力；宋体横细竖粗的笔画对比在 16pt 正好处于可辨识阈值
   之上。Telari 的 PDF 导出/快照恒用浅色"纸张语义"（内嵌文档原文）互证：屏幕
   即纸。
2. **每文字系统独立 scale/baseline = 混排光学对齐。** CoreText 把 Songti 与 New
   York 混排时，两者 em 方框、字面率（glyph face rate）、基线上视觉重心都不同：
   直接混排会显得"英文偏小偏浮"。Telari 的 `hanCenterAbove`（符号名直译：汉字
   中心高于基线多少）说明它**按视觉中心而非字面 em 对齐**，正文与标题各配一组
   常量（标题用 Black 字重，重心又不同）。
3. **中文斜体=楷体、粗体=独立字面 = 拒绝合成变形。** CJK 没有真斜体；机械倾斜
   会破坏笔画重心与可读性。楷体在中文排版传统里正是"引文/强调"的斜体等价物
   （与西文 Italic 同为"手写体源头"）。粗体同理用真实 Heavy 字面而非算法加粗。
4. **数学 = New Computer Modern。** 正文是衬线（NY/宋体），数学配 NCM 保持
   "同一本书"的气质（CM 本就是纸质书数学排版的默认）；GUST 许可字体内嵌。
   KaTeX 默认字体即 CM 变体，气质同源。
5. **断行三档 + 断字词典 + 标点悬挂 = Knuth-Plass 全家桶。** balanced 是默认档，
   对应经典 TeX 惩罚平衡；tight/relaxed 调节松紧偏好。中英混排断字按文档语言
   投票决定词典——为的是不让英文长词在中文语境里被错误断字。
6. **中西间隙 0.25em = clreq/JIS 传统值。** 现代浏览器实现普遍取 1/8em（更紧），
   Telari 取古典四分之一 em，与宋体的较大字面率匹配——字面越满，间隙越要给足。
7. **版心限宽 960pt。** 长文每行字符数的可读性窗口（中文 35–42 字）在 16pt 下
   ≈ 890–1000pt；960 正落窗口中央。表格允许 breakout 突破版心（数据对象≠ prose
   对象，各有各的宽度权利）。
8. **色彩不是拍脑袋：六阶 ΔL* 梯子。** TOML 头部生成器注释写明约束：语法 token
   六级两两 ΔL*≥7.5、token 对正文 ΔL*≥8、正文对纸 12.38:1（浅）/6.90:1（深）。
   深色纸 #2B303A 特意选"较亮的深色"（用户裁决原话「暗色背景太深眼睛不舒服」），
   并如实记录 comment 降到 3.5:1 的让步——约束化、可复算（生成器产出）、让步
   留痕，这是工程化的美术。

## 3. marcopilot 落地映射（v2.0.5 实现范围）

| Telari 概念 | 我们的实现 | 状态 |
| --- | --- | --- |
| 宋体+NY 正文 | 新主题 拓然宋（telari-light/dark）：`Georgia, 'Times New Roman', SimSun, 宋体, serif`（Latin-first：西文/数字走 Georgia 真衬线与老式数字，汉字走宋体；Windows 无 New York，Georgia 为同气质系统替代——大 x-height、屏优化衬线） | 新增 |
| 纸色/墨色/语法梯子 | 两主题颜色逐项取自 telari-light/dark.toml（#FAF9F6/#2B303A 等） | 新增 |
| 中文斜体=楷体 | 既有 marcopilot-kai（v2.0.3 起原字号）；拓然宋主题下 em 的西文回落 Georgia 真斜体 | 已有+衔接 |
| 中文粗体独立字面 | Windows 宋体无 Bold 字面：保持合成加粗（如实记录为平台限制） | 限制 |
| NCM 数学 | KaTeX 内建 CM 系字体，气质同源；KaTeX 预渲染框不透明红线不动 | 已有 |
| balanced 断行 | 既有 Knuth-Plass（v2.0.2） | 已有 |
| 中西间隙 | Chromium text-autospace 固定 1/8em，不可调至 0.25em（引擎限制，记录） | 限制 |
| 版心限宽 | `.vditor-reset` max-width 960px 居中（限宽仅拓然宋主题生效） | 新增 |
| 每文字系统 baseline/scale | Chromium 无每字形基线补偿（需 DOM 逐段包裹，装饰收益/风险比不划算）；以字体配对+行高调校近似 | 限制（记录） |
| punct_strategy/hanging | 显示层标点变换暂不实现（涉及文本测量层，回归风险大） | 未做 |

## 4. 验收标准（用户指定）

装饰性改动不得引入任何渲染回归：2.0.4 已修复的问题 0/1/2（公式剥皮、标记芯片、
图片消失）与历史复发问题（公式闪源码、像素残迹、美元符丢失）全部零回归——以
bug204/formula-preserve/repairs/residue-app/typography 等套件 + 关键帧截图复核。
