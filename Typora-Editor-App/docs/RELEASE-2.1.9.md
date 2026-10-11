# MarkPilot 2.1.9 发布说明（私版）

**这一版做你 2026-09-13 报的那条**（原话）：

> 「含数学公式的段落整体通过鼠标点按不松手的同时拖拽选中」做不到；「现在的拖拽选中只有文字会被加蓝色提示底纹, 公式区无效果」；「caret插入最后, 向前选中整段, 复制出来是空白」。要求「模仿typora做法」。

一句话结论：**现在按住鼠标从公式上拖出去、或从文字上拖过整段公式，都能起真实选区；跨过的公式在
渲染态上就带蓝色底纹（像普通文本）；松手后边界那一条翻成源码，复制拿到的是 `$…$` 源码而不是空白。**

## 1. 根因（三个叠在一起，probe 逐个钉死）

| # | 坏点 | 证据 |
| --- | --- | --- |
| ① | 折叠公式的 `mousedown` 被 `preventDefault()` 吞掉，Chromium 不把这次按下当成"可以起选区" | `probe-math-drag`：按在公式上拖，全程 `collapsed:true`、`ranges:1`、文本长度 0；光标还被 `root.focus()` 甩到文档开头（`#text<# >`，离视口 -5633px） |
| ② | 渲染结果带 `contenteditable="false"`，原生拖拽被**关在这条公式内部** | `probe-math-drag-pick` 配置 C：摘掉这个属性后，从公式上往下拖能选中整段（301 字符）；不摘，最多选中公式内部十来个字符 |
| ③ | 折叠态源码被 Vditor 收成 0×0（`display:none`），既不进选区文本也没有底纹 | DOM 实测：`code` 盒子 180×14 → `w:0 h:0`；`range.toString()` 里只有渲染结果那份重复文本 |

## 2. 修法（照你机器上那份 Typora 1.13.4 的行为定稿）

先把"Typora 到底怎么做"查清楚了（它 1.13.4 就装在你机器上，直接读的 `resources/appsrc/window/frame.js`）：

- **单击**公式：把它展开成源码并选中（`addClass("md-expand")` + `selection.selectAllElem`）；
- **拖拽过程中**：公式照旧渲染，底纹像普通文本一样盖在渲染结果上（**不**边拖边翻源码，否则版面
  跟着指针跳）；
- **松手之后**才 `expand()`：只把"选区端点切进去的那几条"翻成源码，并把该端吸到整条公式
  （`includeTrailMeta`：绝不留下半个 `$`）。

代码改动（都在 `extension-src/render`，已 `npm run sync` 到 `app/renderer`）：

| 文件 | 改动 |
| --- | --- |
| `js/math-select-reveal.js`（新增） | 按下落在折叠公式的渲染结果上时，**这一帧**① 给它挂 `.typora-ir-selected`（源码 inline 显示、可选中，含 `$` 围栏）② 临时摘掉这条预览的 `contenteditable`；松手还原。落手后 `settleEndpoints()` 按 Typora 的规则把那几条翻成源码并把端点吸到整条公式 |
| `js/math-source-map.js` | 折叠公式的 `mousedown` 不再 `preventDefault`（拖拽能起选区的前提）；单击公式改由 `click` 兜底——把落点映射回源码字符位置（这样"点公式本体"仍然是展开 + 光标进源码）；拖拽收尾那次补发的 `click` 被吃掉（否则 Vditor/刷新会把刚建好的选区当场收掉） |
| `index.css` | `.typora-ir-selected` 期间：源码 inline 可选中、`$` 围栏显示、渲染预览收起（三条规则的层叠权重都算过，比"折叠态隐藏 marker"那条更具体） |
| `js/typora-patches.js` | 安装/销毁这个模块 |

**只碰行内公式**（`data-type="inline-node"`）：你报的是"含公式的段落"。块公式（`$$…$$`）的点击/
退格语义由 Vditor 的 rawblock 路径维持原样，一个字没动——`math-caret` 里那几条"块公式渲染结果
正中按退格零改动"的断言就是这条的护栏。

## 3. 前后对照（同一台机器、同一份素材、真实鼠标事件 + 独立进程读剪贴板）

| 手势 | 2.1.8 | 2.1.9 |
| --- | --- | --- |
| 从**文字**上按下拖过整段（5 条公式） | 选区 337 字符、底纹 covers `[1,1,1,1,0]`、复制 201 字符（本来就行） | 一样，且松手后边界那条翻成源码 |
| 从**公式**上按下再拖 | 选区 `collapsed:true`、长度 **0**、复制 **空白** | 选区 **321 字符**、底纹 `[0.27,1,1,1,0]`、复制 **185 字符**（含 `$…$` 源码） |
| 单击公式本体 | 展开 + 光标进源码（原有路径） | 一样（`math-caret` 58 条断言全绿） |
| 点回正文之后 | —— | 翻开的公式立刻收回渲染态，`contenteditable` 还原 |

## 4. 顺带修掉的两个"假缺陷"（都写进日志备查）

1. **合成鼠标拖拽通道**：CDP 的 `Input.dispatchMouseEvent` 在 `mouseMoved` 上必须带
   `button:'left'`，只给 `buttons:1` 时 Chromium 不把移动当成"拖拽中"，选区永远是塌的。上一轮
   （`.perf/drag-select-dev`，2026-09-12）记下的"拖动选中一段文字之后选区是空的"就是这条通道
   问题，**不是产品缺陷**——本轮所有探针都补上了这个字段。
2. **第一次按下只负责激活 iframe**：编辑器在 iframe 里，全新会话里第一次 `mousePressed` 只把
   iframe 激活、不起选区。验收场景里先点一下正文再量，避免把这条浏览器行为记成产品行为。

## 5. 没做到的一条（如实说）

**按在折叠公式上、往同一行的左/右方向拖**（不跨行）仍然起不了选区：命中测试那一刻落点还是
`user-select:none` 的渲染结果，Chromium 不给这种按下起选区。实测四个方向：上 ✅（26 字符）、
下 ✅（74 字符）、左 ✗、右 ✗。跨行的拖拽（也就是"整体选中这一段"的实际手势）都正常。
要连同一行内也生效，只能把渲染结果改成 `user-select:text`，实测会连带改掉光标落点（行尾点一下
会弹预渲染框、`math-caret` 的 v2.1.1 断言当场变红），所以这一版没动——等你验完再说。

## 6. 产物与校验

- `dist/markpilot-Setup-2.1.9.exe` 116,333,111 B `sha256=42b390d207a570ba1271d1f993419f094a9ef249a6073e781729a46f4c3b968a`
- `dist/markpilot-v2.1.9-portable.exe` 116,106,021 B `sha256=3feca55996a5660a922dbe96b8eb319c9bac48a2d63da4ab1f181e35c637a186`
- `Typora-Editor/dist/markpilot-2.1.9.vsix` 6,381,397 B `sha256=db42280f073a6a53e6bd75267d4521b745a81cbda2a129025721082c5a3bd98f`
- 四方哈希链 `verify-vsix-chain`：`verified: true`（519 extension + 496 renderer 文件，三处版本号都是 2.1.9）
- 私版发行目录：`dist/release-2.1.9-private/`（含 `SHA256SUMS.txt`）

## 7. 验收

- 新场景 `scripts/acceptance/scenarios/81-math-drag-select-2.1.9.cjs`：**11/11 断言、7 证人**
  （真鼠标拖拽 → 真选区 → 底纹覆盖率 → 独立进程读回的剪贴板），在**开发树**与**打包产物
  `dist-2.1.9/win-unpacked/MarkPilot.exe`** 上各跑一遍都是全绿。
- 既有公式套件：`math-caret` 58 条、`math-colors` 48 条、`math-history` 8 条、`math`（含 5634
  条公式的整本教材）8 条——全绿。
- IDE 扩展（VSIX）已侧载：Trae 2.1.9、VS Code 2.1.9（重启 IDE 生效）。

## 8. 已经装上了，请你亲手验这三条

桌面版 2.1.9 已装到 `D:\Users\ltmroberthk\AppData\Local\Programs\MarkPilot`（`install-app.cjs`
核验 `version: 2.1.9`、asar sha256 `5c78d584…` 与打包产物一致），IDE 扩展侧载 Trae / VS Code 2.1.9
（重启 IDE 生效）。装完之后我又对着**装好的那份**跑了同一个验收场景：**11/11 断言、7 证人**全绿。

请你打开那份 `数理逻辑1(1).md`，验这三条：

1. 到 `4.3 Example` 那一段里**按住鼠标从公式上往下拖**到段尾 → 选区应该横跨整段，跨过的公式带
   蓝色底纹，松手后起点那条公式显示成 `$…$` 源码；
2. 同一段，**光标点到段尾再往回拖**（或从段尾 Shift+点段首）→ 底纹盖住所有公式；
3. 两种选法都按 Ctrl+C，粘到别处 → 应该是 `$∀x(∀yP(x,y)→∃zQ(x,z))$` 这样的源码，**不是空白**。

已知没做到的一条（第 5 节）：按在折叠公式上往**同一行内**左右拖仍起不了选区（跨行都正常）。
