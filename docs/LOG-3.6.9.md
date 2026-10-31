# 3.6.9 · 图片右侧点击落点修复（内部记录）

日期：2026-10-31（Asia/Shanghai）
引擎源码：`dsh-markpilot/src-cm6/main.js`（+145 行，新增 `imageRightBlankTarget` + `imageRightBlankClick`）
构建产物：`MarkPilot-CM6/renderer/cm6/app.js` sha256 `b06de411debe28862547239a9a9ed9d0fa27cabc804dd05d63c1f6ed2cc93e6d`（1,485,205 B）
版本：桌面 3.6.9；DSH 插件 0.3.4（同一引擎字节，core.json 0.3.4 / 3.6.9）

## 1. 用户可见问题

`新建 Markdown 文档.md` 末尾：第 215 行 `![](assets/pasted-image.jpeg)`，下一行是正文。

- 点图片本身（既有行为）：图片展开源码，光标在 `![` 与 `]` 之间。
- 点图片右侧（正文宽度内）：光标映射到源码行 `r.to`，仍在图片 region 闭区间内 ⇒ 图片源码
  继续展开，编辑会改到图片语法。
- 点更远（编辑器右侧空白/装订线）：CM6 只在 `.cm-content` 上装 mousedown ⇒ 失焦，光标消失。

用户确认的目标语义：无论图片是否已被点开，点图片右侧任意横向距离都落在**图片下一行行首**；
点击本身不改文档、不展开源码、不失焦；点图片本身保持不变。

## 2. 修复

`ViewPlugin` 在 `view.scrollDOM` 上 capture `mousedown`，命中"图片右缘以外、同一图片高度带、
图片 Markdown 行尾无正文"时接管：`preventDefault + stopPropagation` → selection-only 事务
（`select.pointer`、不进历史）+ `retireRegion` → `view.focus()`。

- 落点：下一行内容起点，跳过引用/列表容器、ATX 标题 `#{1,6} `、任务框 `[ ] `；
  下一行是表格/围栏/分隔线/块公式/缩进代码或图片在末行时，退化为图片紧右侧 `r.to`。
- 守卫：`isTrusted`、`button===0`、`detail===1`、无修饰键、`!defaultPrevented`、非组字；
  滚动条按 `mpZoomOf` 缩放换算后排除；命中另一张图片/公式浮层/表格/单元格覆盖层/面板不接管。
- 拖拽：按下后 document mousemove 用 `posAtCoords` 扩展 head，mouseup 摘监听；双击/三击的
  第二、三下交还原生。

## 3. 验证（复用的证据见 `docs/LOG-DSH-0.3.4.md`）

- 隔离装机产物（装的 Electron 44 runtime + 新 ASAR）真实文档副本 20/20；含 inactive/active
  近/远、装订线、拖选、Shift+点击、标题/任务/表格/末行、200% 缩放、真实文档近/远/激活：
  `.mp-verify/quality/img-caret-r1/run21/result.json`。
- 既有图片/区域回归 `region-workflows` 13/13，clipboard 恢复、无残留：
  `.mp-verify/quality/img-caret-r1/region-r2/result.json`。
- 真实插件 renderer（DSH 面板同源）通过：
  `.mp-verify/quality/img-caret-r1/dsh-click5/result.json`。
- 引擎 3.6.9 的 app.js 与 3.6.8 验证时逐字节相同（版本号不进入 bundle）；打包后复核 ASAR 内
  `renderer/cm6/app.js` 哈希与上表一致、PE 版本 3.6.9.0。

## 4. 交付物

- `markpilot-Setup-3.6.9.exe` / `markpilot-3.6.9-portable.exe`（见 `candidate.json` 的 SHA-256）
- GitHub Release `v3.6.9`，资产含上述两包与 `SHA256SUMS.txt`
- DSH 插件 `dsh-markdown-typora-v0.3.4`（tgz）
