# LOG-2.2.19（第 5 轮：VSIX-EXE 差异/Typora 互操作/主题 16 项修复）

辩论：通过16/否决2(D6 D7 有意设计)/存疑3(D3 D4 T3——D4 取证中升级出新缺陷)/意见2(T6 T8 导出主题忠实度留用户裁决)。

## VSIX 域（7）
B1 copy-images 分支（图片复制/剪切复活）；B2 clipboard-read 分支+hostApi shim；B3 滚动 anchor 双字段+关文档清键；B5 openLink 相对路径解析（.md→vscode.open）；B6 copy-table 非 win32 回退+copy-image GDI+ 转 PNG；B7 关于外链走 openLink；B8 导出 tip 按宿主区分。真宿主 smoke 17/17（存量红项经干净 worktree 基线判归属）。

## 互操作（2+取证）
D1 导出保留 style 的 zoom/width/height 子白名单（Typora 缩放图导出保真，120×60 实测）；D2 另存为三选确认（内嵌/保留引用/取消，告知 Typora 兼容代价）。D3 取证：真实漂移仅 front matter 尾空行被吃（原诉求缩进剥离未复现，降级记录）；D4 取证：段中图缩放**两侧正文被复制两份**（新升高危→下轮头号）。

## 主题（4）
B4 vscode.js `if(vscode)`→`if(window.__vscodeHost)`（一行修掉 EXE 侧 IACVT 全灭——修前对照实证注入即偏离主色）；T1 telari/宋体引用文字对比度四处 5.23/4.64:1（实算给值，导出件同步）；T2 reading-palette 补 tbody 特异性压 telari 斑马；T4 斜体 1.18em 四处（字形矩形实测 18.7/16=1.169 倍坐实"大一号"，computed 34/34 像素判读为量测误差）。

## 证据
probe-r5-theme 6/6（B4 修前对照红条件实证）；probe-r5-export D1/D2×2 全绿+4 突变红；vscode-smoke 17/17；回归 76(87/87)/92/138/77/101/107 全绿（76 异常=系统剪贴板锁）。probe-r5-vsix-smoke.md 留 8 节实机清单。
