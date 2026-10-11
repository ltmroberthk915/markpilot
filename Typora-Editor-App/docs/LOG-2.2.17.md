# LOG-2.2.17（第 1-2 轮子代理大规模抓虫：公式/光标/表格/快捷键/图片/拖选 34 项修复）

流程：每轮多猎手并行抓取 → 独立对抗辩论员裁决 → 实机复现红（探针+2x截图+DeepSeek 视觉确认）→ 修复 → 同探针绿+视觉确认 → 突变验证（注掉修复必红）→ 落地。全程铁律 3（单 GUI 实例串行）。

## 第 1 轮（公式光标/块公式/纵向/图片/输入通道/撤销 六域，44 候选 → 辩论通过 20 → 落地 19）

落地（19）：
- A1 粘贴落围栏外半侧文字进公式源码（math-edit paste 补 fence.outside→insertBeside）
- A2 折行长公式判侧用整盒中线致落对侧（改点击行边界）
- A4 开 $ 外半退格只挪不删（让位 boundaryNode）
- B2 Shift+点块公式选区塌缩（mousedown 捕获接管 + mouseup stopPropagation/吞 click——Vditor 挂 pre 的目标相监听同毫秒重写选区）
- B3/B3B 拖选端点只吸 code 边界、替换残留半个围栏/空 $$ 壳（settleEndpoints 与 includeBlocks 都吸 host 整条）
- B4 块公式开栏 $$ 最左退格并段削引用（fence 层改走 action:'open'）
- B5 选区端点闪烁标记滚动后漂移（scroll 即隐）
- C1 ↓ 后 200ms 内打字被旧目标列拽回（重放窗口全可取消）
- C2 补全弹窗开着 ↑↓ 被纵向接管吞（浮层开着让位）
- C3 分栏(sv)下 ↓ 被吞、光标 0×0 冻结（currentMode 守卫）
- C4 行尾/文末行内公式 End/Ctrl+End 被拽回（版面行盒判据）
- C6 空段落合成光标滚后永久消失（scroll 重算）
- C7 大纲跳转后 goalX 残留（程序性跳转 reset）
- D1 同块多图退格只删一张+toast（区间合并一次提交）
- D2 断链图右键对齐写死 width=1（naturalWidth 守卫）
- D8 断链图缩放对话框初值空（兜底 100）
- D4 HTML 图右侧空白起手拖选锚在隐藏源码、打字吃图（mousedown 立锚/mousemove 扩展/mouseup 保险三拍）
- E2 行内公式源码粘多行文本散架（压平 \n）
- W1 行内公式 REVEAL 被 sync 误收（keep 判据扩 covered + inline 保底）

撤销（复现不出红）：B7、C5、F1、F4；证伪：B6、B1、E1。观察项：F2（撤销后光标 0 矩形）、F5。

## 第 2 轮（表格/列表代码块/快捷键/双击选词/拖拽 五域，28 候选 → 辩论通过 23 → 落地 18）

落地（18）：
- T1 表格↓空格/纯公式格跳邻列（空格伪落点 + 候选钳进本格）
- T2 表头行下方插入行变第二表头（落 tbody + td）
- T3 表格内 Ctrl+Backspace 劫成删行（仅整行选态删行）
- T6 末格 Tab 不补行（产品层接管，末格 growTable）
- T7 外来 HTML 表格粘入被当 md 解释（原文直插；IR 无法字面存 $x$ 又原样重开——Lute 实测铁证）
- T8 格内选区回车不替换（先 deleteContents）
- L1 ↑↓ 整块跳过/高块吞键（codeLineAt 逐 TEXT 量行映射 + 幻影源码守卫 + 渲染岛跳跃 + 岛后滚动；四层根因）
- L2 点代码块语言标注光标进不可编辑预览（豁免清单补 code-block——R2 判决通过，随 L1 一并验）
- S1 锚外焦源码选区 Ctrl+B 拆公式（MATH_SOURCE 补查 focusNode）
- S2 选区含公式加粗变双份文本毁公式（单块含公式走 inlineMarkdown 序列化）
- S3 围栏上 Ctrl+B/K 改写围栏（inMathZone 扩围栏 marker；探针浮层断言改 [open] 口径——原"弹出"是常驻休眠节点假红）
- S4 源码内 Ctrl+D/K 插 ~~ ](（FORMATTING 补 d/k + FORMAT_KEYS）
- S5 Ctrl+Alt+V 公式复制无围栏（covered owners 显式端点 containment + data-math 源）
- W4 三击图片被连点展开抢走（detail===3 词选态快照放行原生选段）
- W5 Ctrl 快速两击同图展开而非取消（click detail≥2 对 ctrl/meta 让位）
- T5 撤销（vditor td/th nowrap 不折行，前提不成立；nowrap 立为后续候选）
- W2/D1 缓议撤销（突变不红/CDP 无法触达原生 dragend）
- D2(拖放钳制) 缓议（CDP 无原生 drop 通道）

## 证据台账
- 探针：probe-r1-{caret,mathedit,media,reveal,history}、probe-r2-{code,tables,drop,media2,keys,reveal}（全部绿）。
- 突变：.perf/r1-mutation/（5 项红+视觉 5/5 成立）、.perf/r2-mutation/（17 项：15 红视觉全认、S5 形态不敏感但首跑有真红、W2/D1/L3 不红→撤销）。
- 回归：101 全绿（32/32）；本文件落笔时 74/75/92/107/109/110/134/137/138 串行回归中。
- 关键教训（已写进代码注释）：B2 的 Vditor pre 目标相监听重写；L3 曾回归 A1（End 校正链收窄教训）；D4 锚点在 mousedown；探针模板必过 validate-probe-expr.cjs。

（交付/打包未做，等用户下令。）
