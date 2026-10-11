# MarkPilot 2.1.25 → 2.1.26 工作记录

面向用户的口径见 `RELEASE-2.1.26.md` 与两份 README；这里记设计边界、取证数字与过程中踩的坑。

## 一、起点

用户问："最开始设计时有接入各类 Typora 社区 CSS 的能力，现在方便做这种配置吗？"

查证结论：**这条链路一直存在，但只在打包时跑**。
- `tools/adapt_konayuki.cjs` 把上游 Typora 主题（`render/themes/konayuki/konayuki-{light,dark}.css`，各 46KB）改写成
  `css/konayuki.css`：`:root` → `:root[data-editor-theme="konayuki-*"]`、`#write X` → `.vditor-reset X`，
  丢掉 `@`-rules 与 `:has()`。内置的 Konayuki / 宋体-朙就是这么来的。
- 渲染层里**没有任何运行时自定义 CSS 钩子**（`customCss`/`userCss`/`addStyleSheet` 全库无命中）。
- 所以"用户自己塞一套主题"= 把这条链搬到运行时。

## 二、测试素材：最流行的 7 套第三方 Typora 主题

官方画廊（theme.typora.io）没有公开下载计数，可比的公开指标是 GitHub star（`topic:typora-theme` 按 star 降序，
2026-09-15 快照）。抓取脚本 `scripts/fetch-typora-themes.cjs`（走 `gh api` 的 contents 接口；
本机到 `raw.githubusercontent.com` 与 `release-assets.githubusercontent.com` 的连接会被重置）。

| 主题 | star | 许可证 | 入口 | 取到 |
| --- | --- | --- | --- | --- |
| DrakeTyporaTheme | 3544 | MIT | `drake.css` | ✓ |
| Vue 文档风格 | 977 | Apache-2.0 | `vue.css` | ✓ |
| Lapis | 566 | MIT | `lapis.css` | ✓ |
| Mdmdt | 566 | Apache-2.0 | `mdmdt.css` | ✓ |
| Cobalt | 399 | 未声明 | `cobalt.css` | ✓ |
| GitBook 风 | 315 | GPL-3.0 | `src/gitbook-azure.css` | ✓ |
| Notion 风 | 300 | MIT | `themes/enhanced/notion-light-enhanced.css` | ✓ |
| LaTeX 中文样式 | 5960 | GPL-3.0 | 仅 release 包 | ✗（网络） |
| Ursine | 739 | MIT | 仅 release 包 | ✗（网络） |

素材落在 `.perf/typora-themes/`（**第三方作品，只做测试，不入产物**），`manifest.json` 记录来源/许可证/sha256。

实测这批主题的写法分布（决定了适配器必须做什么）：
- `#write` 用得极重：cobalt 48 处、mdmdt 106 处、lapis 64 处…… 所以 `#write → 写作区` 是核心改写。
- **`@import` 是常态**：`@import 'vue/fonts.css'`、`@import url(./drake/font.css)`、`@import "lapis.css"` ——
  真实主题是**文件夹**，不是单个文件；所以导入要支持多选，并在本地内联 `@import`。
- **相对字体/图片很常见**：vue 的 `fonts.css` 有 28 个 `@font-face`、gitbook 11 个，`url(...)` 都是相对路径。
  主题文件夹里的字体文件不在我们手里，直接照抄引用就是一堆 404（webview 里每次都往控制台抛错，
  验收的"无 console 错误"闸门会红）——所以**带相对 src 的 `@font-face` 丢掉、其它相对 `url()` 换 `none`**，
  并如实计数告知用户。
- `@media` 也不少（mdmdt 15 个）：打包时那版把它们丢了，运行时这版**保留外壳、改写内部**。

## 三、实现

`extension-src/render/js/user-theme.mjs`（纯函数，无 DOM）：
- `adaptTyporaTheme(css, {scope, surface})`：逐块改写；`:root` → 作用域；`#write` → 写作区；`@media`/`@supports`
  递归改写后保留；`:has()` 保留（Chromium 支持）；注释（含许可证头）原样保留；带相对 `src` 的 `@font-face` 丢弃；
  其它相对 `url()` → `none`；输出 `report`（规则数/选择器数/丢弃数/字体块数/中和数/媒体查询数）。
- `inlineThemeImports(entry, files)`：按"完整路径 → 路径后缀 → 文件名"三级匹配内联本地 `@import`，带深度上限与环检测，
  外部地址与找不到的目标分别记账。

`extension-src/render/js/themes.js`：自定义主题的存取（`localStorage`）、编译、注入为最后一个 `<style id="typora-user-theme">` +
`document.documentElement.dataset.userTheme='on'` 作用域；停用即移除样式表与属性（**页面不留残迹**）；
`restoreUserTheme()` 挂在 `applyTheme()` 里，基础主题切换后自动重挂。对话框新增一栏：多选 CSS 文件导入（
`<input type=file multiple>` + 页面内 `File`/`FileReader`，两个宿主零改动）、粘贴导入、使用/停用/删除、
一行如实统计。宿主协议**一处未改**。

## 四、验收

- 单测 `test/user-theme.test.cjs`（放在扩展仓，模块源码那一侧）：5/5 通过，含 7 套真实主题逐个断言
  （规则数 ≥8、选择器 ≥10、不漏相对资源、本地 `@import` 全部内联）。
- 场景 `96-user-theme-import-2.1.26`：**安装版 2.1.26 上 83/83**（dev 树同样 83/83）。逐套主题断言：
  计算样式至少一个探针真的变了；停用后 h1/p/code/td/surface 的 computedStyle **逐字段等于基线**；
  停用后样式表与作用域属性都没了、存储里的"当前主题"清空；主题开着时真实点击落在写作区、打字真的进了文档；
  每套主题之后**本次会话无新增 console 错误**。另测两类脏 CSS："古怪但合法"（相对字体/图片、找不到的 `@import`、
  嵌套 `@media`、`:has`、`!important`、未知 at-rule、`@keyframes`+animation、`::after`）必须照常生效；
  "语法坏掉"（缺花括号、乱码、裸 `}`）不许炸、不许污染控制台、不许把编辑器弄哑。

## 五、过程中踩的坑（都留在记录里，免得下次再花时间）

1. **测试自己的错被当成产品缺陷**：场景 96 早先 45/58、59/76 时，失败集中在"主题开着还能编辑"。
   真因是我的 `closeDialog` 没关掉模态对话框（按坐标点"关闭"按钮，主题一多对话框滚动后按钮位置变了），
   之后所有编辑交互都打在模态框上——`elementFromPoint` 一读就现形（命中 `DIALOG`）。
   改成 **Escape 关闭（模态 `<dialog>` 的规范行为，不依赖坐标）+ 关闭后自证"框没了"**，全绿。
   教训：编辑类断言之前先断言"前置状态成立"（这里是"对话框已关闭""落点自证成功"）。
2. **产品缺陷（真）**：导入几套主题后主题对话框会长过窗口、底部按钮点不到 —— 已加
   `max-height:84vh;overflow:auto`（对话框）与 `max-height:32vh;overflow:auto`（主题列表）。
3. **探针敏感度**：单套主题不一定同时改到多个探针（cobalt 只改到 h1），所以"逐套 ≥1 个探针变化"+
   "七套合起来 h1/p/code/td/surface 至少四个探针被改到过"两条一起断言，既有强度也不误报。
4. **打字判据**：主题会改版面（宽度/行高），按坐标点击不再可靠 —— 改成"真实点击只做几何自查（光标落在写作区）"，
   打字用 TreeWalker 把光标程序化落到目标段落的最后一个文字节点（并自证落点成功），插入仍是真输入。

## 六、发布物（内部）

- `Typora-Editor/dist/markpilot-2.1.26.vsix`（521 个文件），`Typora-Editor-App/dist/markpilot-Setup-2.1.26.exe`、
  `markpilot-v2.1.26-portable.exe`；发布目录 `dist/release-2.1.26-private/`。
- 四方哈希链 `docs/verify-vsix-chain-2.1.26.json`：`verified: true`，扩展 519 / 渲染层 497 个文件。
- 密钥物料审计：VSIX 521 个文件 0 处、ASAR 528 个文件 0 处。
- 装机：桌面版 2.1.26 已装并核验（asar sha256 `af229ca8…`）；VS Code 已 sideload `jinxi.markpilot-2.1.26`；
  Trae 侧因 Trae 正在运行未装（退出后重跑 `node scripts/install-vsix.cjs <vsix>`）。
- 全量验收（安装版 2.1.26，36 个场景）：见 `docs/LOG-2.1.25-2.1.26.md` 末尾补记。

## 七、全量验收补记（安装版 2.1.26，36 个场景）

**33 通过 / 3 被标记**，三条都做了归因，无一与本版改动有关：

| 被标记的 | 归因 | 证据 |
| --- | --- | --- |
| `30-shift-enter`（"输入后：新行的文字落在磁盘上"） | **间歇性**（同一断言在 2.1.24 产物上同样失败过，在 2.1.25 全量跑里又通过过） | 该场景 2.1.24 与 2.1.26 上各复现过、也在两次全量跑里通过过；现象是插入的字符没进文档，与主题功能无关（本版对 Shift+Enter/存盘零改动）。待单独排查。 |
| `73-mixed-editing-stress`（粘贴出现 2 次 / 剪切后仍在） | **既有问题** | 同场景在 2.1.24 产物上**同样三条断言失败**（早前 A/B 实测）。 |
| 指标 `open.large.shellToIframe` 473ms（基准 290） | **测量噪声** | 连着三次单跑：251 / 407 / 314 ms；2.1.25 上三次 258 / 271 / 250 ms；2.1.24 的 A/B 为 254 ms —— 同一区间来回跳，且该指标只取 2 个样本的最小值。 |

本版新增与相关的场景全绿：`96-user-theme-import-2.1.26` 83/83、`94`/`95` 16/16 与 8/8、以及
76/78/82/83/84/92 等与渲染层改动相邻的全部通过。单测 `test/user-theme.test.cjs` 5/5。

## 八、性能对照（用户问"这么多改动对性能有影响吗"）

**一、代码改动本身：与 2.1.24 逐项对照，全在 ±3% 噪声内。**
同一台机器、同一批场景（10/60/72），`dist-2.1.24`（旧代码）与安装版 2.1.26：

| 指标 | 2.1.24 | 2.1.26 | 差 |
| --- | --- | --- | --- |
| open.small.spawnToDom | 500 ms | 492 ms | −1.6% |
| open.small.shellToIframe | 270 ms | 264 ms | −2.2% |
| open.medium.spawnToDom | 571 ms | 586 ms | +2.6% |
| open.large.spawnToDom | 878 ms | 873 ms | −0.6% |
| open.large.inPageToDom | 617 ms | 634 ms | +2.8% |
| scroll.frameP50 / P95 | 16.7 / 16.8 ms | 16.7 / 16.8 ms | 0 |
| scroll.droppedRatio | 0% | 0% | 0 |
| type.large.meanMs / p95Ms | 56 / 66 ms | 57 / 64 ms | +1.8% / −3.0% |

改动里唯一"每次交互都要跑"的两处也是常数级：`patchToolbarMenus` 的文档级 mousedown 只对**工具栏子树**做一次选择器查询（不是遍历整篇文档）；`marker-caret-guard` 只在"落在标题块首记号里的那一次单击"读一次几何，其余按键路径不读。

**二、自定义主题开着时的持续开销：量不出来。**
`probe-theme-performance.cjs`：同一个大文档（2002 块）同一个会话里三段对照，取**改写后体积最大**的一套（mdmdt，20KB / 50 条规则）：

| 阶段 | 滚动 p50/p95/掉帧 | 打字均值 | 样式表 |
| --- | --- | --- | --- |
| A 无自定义主题 | 16.7 / 16.8 / 0 | 29 ms | 22 张 |
| B 启用 mdmdt（20KB） | 16.7 / 16.8 / 0 | 30 ms | 23 张 / 20521 字节 |
| C 停用之后 | 16.7 / 16.8 / 0 | 33 ms | 22 张 |

帧间隔逐位相同、零掉帧；打字 +1ms（C 段 33ms 说明重复测量本身的抖动就有 ±4ms）。**一次性**成本：从选文件到生效 28 ms（含读文件与改写，启动时若已存有主题走同一路径，量级相同）。三段都无 console 错误。

## 九、大文件（带公式）编写性能：剩余余量评估（只测量，未改代码）

问题来自用户："目前在大文件带公式编写性能上还有没有优化空间了"。做法：在**装好的 2.1.26** 上，
用验收素材里公式最密的大文档（`fixtures.largeTailMath()`：145,176 字符 / 1843 块 / 2371 处公式 / 18,897 节点）
做 CDP CPU profile（100µs 采样）+ 页内计数器。

**打字成本（实测 20 键）**：均值 **13.7–18.8ms**、p95 26–32ms（约 1 帧）；**每次按键 KaTeX 渲染 0 次**
（公式不在输入路径上重排）；滚动帧间隔 16.7/16.8ms、掉帧 0。自耗时归因（749ms 采样）：

| 归属 | 占比 | 说明 |
| --- | --- | --- |
| Blink `(program)`（排版/样式/GC） | **56.5%** | 与"每次按键失效的版面规模"成正比 |
| Vditor 光标复位：`removeAllRanges` 8.9% + `addRange` 5.8% + 包内 `P` 5.9% + `querySelectorAll` 3.4% | **24%** | 约 9ms/键，全在打包后的 `index.min.js` 里 |
| 我们的渲染层（全部） | **1.8%** | `refreshMathEditing` 仅 0.13ms/键（早前记的"收窄它能省 12%"已不复存在） |
| KaTeX / Lute | ~0.7% | — |

**结论：我们自己的代码已不是瓶颈**（1.8%），剩下的钱在 Vditor 的光标复位与 Blink 的排版规模上。
按"收益÷风险"排的三条余量：

1. **（缺陷，优先）大文档里撤销会把 CV 估算值冲掉、总高 8 倍膨胀且不自愈。**
   实测时间线（`probe-cv-loss-timeline.cjs`，1843 块文档）：
   | 步骤 | `contain-intrinsic-size` 块数 | 总高 |
   | --- | --- | --- |
   | ① 刚上屏 | 1843/1843 | 75,745 px |
   | ② 连打 10 个字（公式队列仍在渲染） | 1842/1843 | 75,753 px |
   | ③ 连撤 10 次 | **0/1843** | **606,128 px（8.0 倍）** |
   | ④ 之后静置 90s | 0/1843 | 606,128 px（**不自愈**） |
   机制：撤销是 HTML 快照恢复（每次 Ctrl+Z 整篇 `innerHTML` 重写，实测 1,024,210 字符/次、解析约 10ms），
   当撤销走回"CV 启用之前"的那份初始快照时，内联的 `contain-intrinsic-size` 一并被换成旧 DOM —— 跳过块退回
   默认 320px 估算（1843×320≈590k，与实测 606k 吻合）。后果与既有记录（`PERF-FIRST-SCREEN-20260911.md` §6.1）
   一致：滚动条几何与"滚动位置记忆"漂移，离屏块的 CV 收益被浪费。触发门槛很低：**打开大文件 → 打字 → 连按几次 Ctrl+Z**。
   修法草案（既有注释里已写）：把 `large-doc.js` 的 `measure()` 抽出来，快照恢复/重载后**先摘 `.typora-cv` 再量、量完挂回**，
   并做去抖（一次全量重排约 50ms）。
2. **Vditor 光标复位约 9ms/键（占打字成本 24%，占 13.7ms 均值的一多半）。**
   它在打包后的 bundle 里；项目已有"打包时给 bundle 打补丁"的先例（`tools/patch_vditor_performance.cjs`）。
   可行的收窄：选区已经正确时跳过 `removeAllRanges + addRange`。风险是光标行为，验收里光标相关场景很密
   （94/92/83/84/76 + `desktop-math-caret`）能兜住，但要单独一轮做、逐场景验。
3. **撤销整篇重写（1MB innerHTML/次）**：彻底修需要块级增量撤销（架构级、数月）；不做也不影响正确性，
   只影响"大文档里连撤"的流畅度。

顺带修正一条我自己的误读：早前 `probe-large-math-profile` 报"CV 没挂上"是**探针计数写错**
（数的是 `．typora-cv` 子孙节点，而类挂在根元素上）；复测确认 CV 正常启用（1843 块全部写入估算值）。

### 九之补：上面那份归因是"离屏光标"条件下的，**补测视口内条件并修正结论**

上文表格里的 13.7–18.8ms / 我们占 1.8%，是在"程序化把光标放到末尾块、视口还停在别处"的条件下量的 ——
那时被编辑的块正处在 `content-visibility` 跳过态，走的是便宜路径。人真的在写字时**被编辑的块在视口里**，
两种条件差 2 倍以上，必须分开说（探针加了 `--visible=1` 开关，先 `scrollIntoView` 再打字）：

| 条件 | 打字均值 | p95 | 说明 |
| --- | --- | --- | --- |
| 光标块**离屏**（CV 跳过） | 18.9–21.3 ms | 24–29 ms | 程序化落点、视口在别处；不是用户场景 |
| 光标块**在视口内**（真人写字） | **40.0 ms** | **54 ms** | 场景 72 单独复跑两次也是 43 / 56 ms ✓ 一致 |

视口内条件的 CPU profile（749ms → 1249ms 采样，20 键）与来源归因：

| 归属 | 自耗时/20 键 | 每次按键 | 占比 | 谁在调用（按调用栈归因） |
| --- | --- | --- | --- | --- |
| Blink `(program)`（排版/样式） | 597 ms | 29.9 ms | 47.9% | — |
| `querySelectorAll` | 217 ms | 10.9 ms | 17.4% | **全部** `index.min.js::P`(179ms) 与 `::I`(38ms) |
| `removeAllRanges` / `addRange` | 215 ms | 10.7 ms | 17.2% | **全部** `index.min.js::c` |
| `querySelector` | 24.7 ms | 1.2 ms | 2.0% | `index.min.js::p` |
| **我们的 `refreshMathEditing`** | 53.3 ms | **2.7 ms** | 4.3% | `math-edit.js` |
| 我们的其余（`incremental-ir.drain`、`anchorOf`…） | ~10 ms | ~0.5 ms | 0.8% | — |
| KaTeX | 0 ms | 0 | 0 | 输入路径不重排公式（`katex` 计数 0/20 键） |

**修正后的结论**：视口内打字（40ms/键）里，**约 57% 是 Vditor bundle 自己的 DOM 查询与选区复位**
（`P` / `c` / `I` / `p` 四个函数），47.9% 是 Blink 的排版；**我们自己的代码约 3.2ms/键（8%）**，
其中 `refreshMathEditing` 2.7ms —— 它在视口内条件下不再是"可忽略"，与 2026-09-11 那句
"收窄它只省 12%、且有展开态残留风险"相比，现在值得重新评估（但风险仍在）。
可动手的地方因此从"我们的层"改成两处：**bundle 打补丁**（项目已有 `tools/patch_vditor_performance.cjs` 先例）
与**修 CV 估算值被撤销冲掉的缺陷**（见第九节第 1 条）。探针：`probe-large-math-profile.cjs --visible=1`
（新增 `--fixture=` 与 `--visible=` 两个开关）、`probe-cv-loss-timeline.cjs`；画面帧/延迟口径与验收套件 60/72 相同。
