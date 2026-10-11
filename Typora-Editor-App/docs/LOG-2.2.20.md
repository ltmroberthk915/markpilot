# LOG-2.2.20（第 6 轮：FINDINGS 清点 + 段中图复制正文等 7 项修复）

辩论：FINDINGS F1-F20 清点（8 已修确认/2 环境/1 证伪）→ 候选 10 → 通过 5 / 存疑 2 / 否决 3（F14 Tab 口径未裁、F2 观察哨、F19 前提证伪[169KB 素材 145K 是单张 base64 图，DOM 挂全文]）。

## 落地 7
- D4升级 段中图缩放复制两侧正文（数据损坏级；paragraphSplitReplacement 去掉 before/after 拼接，拆段由图源码两侧补空行实现；四段形 4/4 绿）。
- F7 PageUp/PageDown 按页移动光标（pageJump：先滚一页再按目标 y 落点，保列、到顶到底不吞键；160 块 10 键到文末、回程列差 1px）。
- F18 Ctrl+→/← 词跳行界校正（含 F18b 补丁：元素级 0×0 落点与同行 x 回退双判据）。
- F5变 块内跨 <u> 岛加粗按岛边界切分（islandScopedMarkdown；跨标题/li 含岛也治）。
- F17 无选区 Ctrl+Shift+K 裹词（wordAroundCaret：连续英数一词、CJK 按字；公式邻域不渗入）+ F17b 行内代码二按取消守卫（IR 面本身是 pre 的坑）。
- F15变 图上起手拖拽扩展文字（与 D4 同构立旗；产品代码首轮即对——首跑红是探针顶层/iframe selection 读数错位）。

## 取证与新观察
- F8 Ctrl+Home 落标题文字尾：本轮未复现（落文字首），存档。
- F11 双击选词拖拽：逐帧读数 len 恒定无漂移，元凶未现（vendor 层疑），继续观察。
- 新观察：Shift+End 在标题/含岛段把选区塌进标记层（建议后续立项）；快速 Ctrl+S 落后一次 200ms 去抖（setValue 吞推送——探针已加 waitPushed 证人，产品权衡未改）。

## 证据
probe-r6-{para,keys2,bold,imgdrag} 全绿（4+3+12+4）；138 28/28、76 114/114 防连带；三域突变各一实测红（pageJump/守卫/立旗注掉均变红）。
