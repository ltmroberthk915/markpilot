# dsh-markdown-typora 0.3.4：图片右侧点击落点修复（内部记录）

日期：2026-10-31（Asia/Shanghai）
产品：`dsh-markdown-typora` 0.3.4；内核 MarkPilot CM6 **3.6.8 + 图片右侧补丁**
身份：`core.json` coreHash `9150b5bb82c3384a427fd723f7f464a6c45ccbdf26df799a398ba69b7be6cdb4`，
`renderer-cm6/cm6/app.js` sha256 `b06de411debe28862547239a9a9ed9d0fa27cabc804dd05d63c1f6ed2cc93e6d`（1,485,205 B）。
改动文件：引擎 `dsh-markpilot/src-cm6/main.js`（+145），构建产物 `MarkPilot-CM6/renderer/cm6/app.js`，
插件核心 124 文件（`scripts/sync-core.mjs` 逐字节同步）、`package.json`、`README.md`。

## 1. 用户可见问题（DSH 右侧栏 Markdown 面板，真实文档 `新建 Markdown 文档.md`）

文档最后一段：第 215 行 `![](assets/pasted-image.jpeg)`，下一行是正文。

1. 点图片本身：图片展开为源码（`![](...)`），光标落在 `![` 与 `]` 之间（既有行为，保留）。
2. 点图片右侧、仍在正文宽度内的空白：CM6 把落点映射到图片源码行的 `r.to`（`)` 之后）；
   该位置仍落在图片 region 的 `[from,to]` 闭区间内 ⇒ `region-session` 不退休、源码行继续展开，
   编辑会改到图片语法。
3. 点更远（编辑器右侧空白/装订线，`.cm-scroller`）：CM6 的 mousedown 只装在 `.cm-content` 上，
   编辑器失焦（activeElement 变 `.cm-scroller`），光标消失。

用户确认的目标语义（选项 A）：无论图片是否已被点开，点图片右侧任意横向距离都落在**图片下一行
的行首**继续编辑；点击本身不改文档、不展开源码、不失焦。

## 2. 根因

- 空白右侧的命中有两种：小图/居中图可能落在 `.mp-img` wrapper 的空白外层（被 `clickToSource`
  当成点图 ⇒ 进入源码）；真实大图 wrapper 只到图右缘，落点落在 `.cm-content` 右侧空白，CM6 原生
  `posAtCoords` 映射到 `r.to`，而 `region-session.js` 的退休判据只看 head 是否在 `[from,to]` 之外。
- `.cm-scroller` 空白不属于 contentDOM，CM6 不处理，浏览器默认焦点落到不可聚焦的 scroller ⇒ 失焦。

## 3. 修复（引擎 `main.js`，插件侧零 host/bridge 改动）

新增 `ViewPlugin`，在 `view.scrollDOM` 上 capture `mousedown`（同时覆盖 content 空白与 scroller 装订线）：

1. 命中判据：真实输入、`button===0`、`detail===1`、无 Shift/Ctrl/Meta/Alt、`!defaultPrevented`、
   非组字；落点在 scrollDOM 内，滚动条按**当前内容缩放** `mpZoomOf` 换算后排除；`elementFromPoint`
   不和图片/公式浮层/表格/单元格覆盖层/表格条/图片 payload/面板重叠；命中的 `.mp-img` 必须是本图
   wrapper；点击 `x > 绘制图片右缘` 且 `y` 在 wrapper 上下界内；图片 Markdown 行 `r.to` 之后除空白
   无正文（`![x](y) 后文` 的右侧仍走原生）。
2. 落点：图片下一行行首，跳过引用/列表容器前缀（`structuralContextAt`）、ATX 标题 `#{1,6} `、
   任务框 `[ ] `。下一行是表格/围栏/分隔线/块公式/缩进代码/围栏体内时，没有"同行可安全插入的
   内容起点"⇒ 退化为图片紧右侧 `r.to`（仍收起源码会话，不把结构行写坏）。图片是末行时落
   `doc.length`。
3. 动作：`preventDefault + stopPropagation` → 一次 selection-only 事务（`userEvent:'select.pointer'`、
   `addToHistory:false`）+ `retireRegion` effect（保证末行/结构行退化时源码也收起）+ `view.focus()`。
4. 拖拽：按下后 document mousemove 用 `posAtCoords` 扩展 head（不进历史），mouseup 摘监听。
   已知边界：不提供 CM6 原生拖拽的边缘自动滚动与原子区间吸附。
5. 双击/三击的第二、三下（`detail>=2`）交还原生；组字中、合成事件、已被前置处理器吃掉的事件不接管。

## 4. 验证

- **真实插件 renderer（DSH 面板同源）**：本地 harness 服务真实插件静态文件 + 真实 `serveImageFile`
  图片路由，父页按 `lib/client.js` 协议 v1 发 theme/open；用用户 Edge CDP 9223 新标签页真实键鼠输入。
  结果：未激活/已激活图片右侧近、远、装订线 ⇒ head=下一行行首、session=null、focus=true；
  点图片 ⇒ session 有效、head=editFrom（`[]` 之间）；键入“测”落在下一行行首且图片语法逐字节不变；
  Ctrl+Z 撤销；真实双击第二下 detail=2 不被接管。收据：
  `.mp-verify/quality/img-caret-r1/dsh-click5/result.json`，截图同目录（`01-image-source`、
  `02-active-near-right`、`03-far-right`、`04-typed-next-line` 及 2x 裁剪）。
- **隔离装机产物（装的 Electron runtime + 新 ASAR）**：真实文档副本 + 合成夹具 20/20 通过，含
  inactive/active 近远、图片本体、拖选、Shift+点击、图片本体不变、失焦、引用/列表/标题/任务/表格/末行、
  200% 缩放、滚动条、真实文档近/远/激活三臂：`.mp-verify/quality/img-caret-r1/run21/result.json`。
- **既有图片/区域回归**：`tools/quality/region-workflows.cjs` 13/13，clipboard 恢复、无残留进程：
  `.mp-verify/quality/img-caret-r1/region-r2/result.json`。
- **插件单元测试**：`test/host.test.mjs` 17/17、`test/client.test.mjs` 14/14、
  `test/manual-save.test.mjs` 3/3；`node scripts/sync-core.mjs --check` → `CHECK_OK 124 files`。
- 视觉复核：上述截图为局部 2x，光标位置按浏览器 `coordsAtPos` 画红标记；图上可见"下一行行首"与
  "图片源码 `[]` 之间"两种状态。

## 5. 生效方式

插件以 junction 安装在 `~/.dsh/profiles/{web,desktop}/node_modules/dsh-markdown-typora`，指向本源码。
本次只改 renderer 引擎字节（`lib/index.js`、`lib/client.js`、`dsh-bridge.js` 未改），宿主的静态路由
带 `no-cache`+ETag，**关闭再打开 Markdown 标签页**即可加载新 `app.js`；若面板仍显示旧行为，重启 DSH
宿主后再开面板。

## 6. 已知边界（本批不做）

- 分屏源码镜像（split 从视图）不挂本插件扩展，右侧点击仍是旧行为。
- 阅读模式（`readOnly`）/只读编辑面未单列验收臂。
- 从空白处自写拖拽不带 CM6 边缘自动滚动/原子吸附；从**已展开**图片的空白处起拖会在按下瞬间
  收起源码（布局塌陷一次）。
- 下一行是表格/围栏/分隔线/块公式/缩进代码时，落点为图片紧右侧而非该结构内部（避免写坏结构）。
