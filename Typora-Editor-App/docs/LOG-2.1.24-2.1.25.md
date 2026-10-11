# MarkPilot 2.1.24 → 2.1.25 工作记录

面向用户的口径见 `RELEASE-2.1.25.md` 与两份 README；这里记取证、实测数字与判断依据。

## 一、起点：标题左缘的两条报告

- ① 点开标题露出 `# 一、事件与集合` 之后，点井号左侧，光标跑到井号**右边**；只有"点井号右侧 + 左方向键"能到井号之前。
- ② 光标在"最左侧"按退格，删掉的是**井号**（标题降级成正文），而不是按"块首删除"处理。

素材：`E:\MarkPilot\测试素材_每次使用需复制用后需删除试验副本\富文本测试-重识概率论.md`
（复制到 `E:/MarkPilot/.perf/heading-left-click/重识-副本.md` 使用，原素材只读未动）。
复现摘要：L9 `# 一、事件与集合`，上文是 4 行表格，正是报告里的那一屏。

## 二、取证（全部真产物 + 真鼠标/真按键，安装版 2.1.24）

| 探针 | 结论 |
| --- | --- |
| `probe-heading-marker-left2.cjs` | 浏览器自己的命中测试 `caretRangeFromPoint` 在井号左侧 8px 处给的就是 `(# 文本节点, 0)`＝**井号之前**；而真实点击同一批坐标后光标全落在正文开头，且每次都留下 `__typoraMarkerCaret.moved = true, atStart = true` ⇒ **是 `marker-caret-guard` 把光标请走的**。 |
| 同上（DOM dump） | 标题记号是 `<span class="vditor-ir__marker vditor-ir__marker--heading" data-type="heading-marker"># </span>`，即行内记号守卫识别的那种元素。 |
| `probe-heading-marker-left6.cjs` | 五种落点（记号 offset 0/1/2、正文 offset 0、块元素 offset 0）× 两种上文（段落 / 表格）：**十格全部**出现"井号/标题没了"。块首（offset 0）＋上文是可合并的段落时＝合并到上一段（`上一段文字。目标标题`）；上文是表格时＝向前删退化，`#` 被吃、标题与**后面**那段并成一行（`目标标题标题后的正文。`）。 |
| `probe-heading-marker-left5.cjs` | 在 window 捕获阶段 `stopImmediatePropagation()` 拦住 Vditor 之后现象**一模一样** ⇒ 吃掉井号的是 **Chromium 的默认删除动作**，不是 Vditor 的按键处理。 |
| `probe-heading-marker-left7.cjs` | 光标停在井号之前时，Vditor 保持 `vditor-ir__node--expand`、记号照旧画着（宽 21px）、光标矩形画在 x=272（井号左边缘，高 34px）⇒ 把光标留在井号之前**不会有"井号闪掉"的副作用**。 |
| `probe-heading-marker-left8.cjs` | 井号之前是个正常编辑位置：在那儿打字，字进**正文**（`# X目标标题`），不会插坏 `#`、也不会把标题变成普通段落；从正文起点连按两次左方向键即到井号之前（与报告的描述一致）。 |

## 三、改法

`extension-src/render/js/marker-caret-guard.js`（同一份代码供 EXE 与 VSIX）：

1. **块首结构记号的光标落点**：`isBlockMarker()` 判定"记号是宿主首个子节点且宿主是标题/记号自称 heading-marker"。命中时——
   - 点与记号的落点在**画出来的记号左边界**上或左侧 ⇒ 光标放到记号文本 offset 0（井号之前），并确保不重复纠正；
   - 点在画出来的记号自己身上或块内正文 ⇒ 一律不动（浏览器给的位置都是可编辑的正常位置）；
   - 记号**被收起**（块未展开）⇒ 维持原行为（请到正文起点）：此时记号是个看不见的坑，落进去光标画不出来、退格还会偷偷吃掉 `#`。
   几何只在 `fix()` 那一帧读（按下那一帧读几何会把 `desktop-math-caret` 的既有用例弄红，原因写在文件头）。
2. **块首退格**：光标在块首结构记号之前时，上一块是 `P/H1-H6/BLOCKQUOTE/DD/DT` ⇒ 不插手（保留浏览器"合并到上一段"）；其余（表格/代码块/公式块/HTML 块/文档第一个块）⇒ `preventDefault()`，这一按什么也不做。列表项刻意不算可合并——把标题并进 `<li>` 会把列表结构搅坏，宁可什么都不发生。

## 四、验收

场景 `scripts/acceptance/scenarios/94-heading-block-start-caret-2.1.25.cjs`（16 条断言、10 条证人）：

- A/B（同一份场景、同一套素材）：
  - **安装版 2.1.24：11/16 通过** —— 失败的五条正是报告的两件事：光标画在正文开头、左方向键走不出这一块（说明光标不在块首）、块首退格把井号删掉、这一按没有被块首规则接管、以及**磁盘上的源码**也被改坏。
  - **改后 dev 树：16/16 通过。**
- 判据通道：光标/记号/正文的**几何量测**、主进程 `capturePage` 抓的**窗口真实像素**（`#` 区域墨量前后一致＝没有闪掉）、**磁盘文件**（自动保存后仍是 `# 目标标题`）、以及自证动作（在块首按一次左方向键会走出这一块）。
- 上一块是段落时"合并到上一段"的既有行为单列断言，并验证一次 `Ctrl+Z` 即可复原。

## 五、同一版里的另外三件事

1. **桌面版去掉「使用vscode默认编辑器」**（`render/js/toolbar.js`）：该按钮由 `window.__vscodeHost` 门控——桌面端不出现，VSIX 保留。宿主侧 `app/main/doc.js` 的 `editInVSCode` 路由未删（渲染层不再发出，仅保留协议面）。场景 95 用真 DOM 读工具栏全部按钮的提示文字断言"没有 vscode 字样、没有那个 svg"，并对源/开发树两份 `toolbar.js` 做逐字节一致与门控存在性检查。
2. **浮层菜单赖着不走**（`render/js/typora-patches.js` 的 `patchToolbarMenus`）：Vditor 的工具栏悬停菜单只在"再点同一个按钮/点别的按钮"时收，指针移开不动它。探针 `probe-toolbar-tip-linger.cjs` 实测：点开编辑模式菜单后把指针移进正文等 2 秒仍在、按 Esc 也不收；补两条收起路径（离开工具栏收悬停菜单；工具栏外按下鼠标连带收起点开的浮层），表情面板这类**点开**的浮层不因指针移开而被收。修后同一探针：指针离开 800ms 后浮层清单为空。
3. **两个不生效的主题下拉**：`ls cdn/vditor/dist/css/` 只有 `content-theme/`，**没有 `code-theme/`** ⇒ "代码块主题预览"选什么都没反应；`content-theme` 的 CSS 选择器全是裸的 `.vditor-reset h1/hr/blockquote/table/code…`，而这三份自有主题（themes/konayuki/telari）对这些选择器分别有 11/27/18 处强制配色 ⇒ 在编辑面里换了也看不出来。两者从 ⋮ 菜单移除。

## 六、GitHub issue #1 的处置（czhhbp，2026-09-15）

- 第 2 宗（悬浮控件持续停留）＝上面第 2 条，已修。
- 第 3 宗（内容主题预览切到 light 无效）＝上面第 3 条，已移除该假控件。
- 第 1 宗（标题左侧 ▲▼🗑 浮条遮住上文）**不是本项目画的**，证据：
  - 渲染层全树 397 个文件里搜不到 `attr(data-marker)`、`heading-level`、`"H"+level` 一类角标实现；
  - 真 DOM 扫描（`probe-heading-badge-owner.cjs`）：顶层页与编辑器 iframe 里**没有任何**文本恰好是 `H1..H6` 的叶子元素，也**没有任何**"上/下箭头"图形的 svg；
  - 桌面端与 VSIX 共用同一份渲染层，所以两端都不会画出那个角标与浮条。
  - 该类 UI（拖动把手 + H1/H2/H3 角标 + ▲▼🗑 块浮条）是"在 VS Code 原生编辑器路径上做富文本 Markdown"的第三方扩展的典型形态；报告者的截图 2、3 是本项目（工具栏/⋮ 菜单），截图 1 疑为点「使用vscode默认编辑器」跳到原生编辑器后由别的扩展画出。已请其确认扩展列表（回复待发）。

## 七、2.1.25 产物与验收记录（内部）

产物（`E:\MarkPilot`）：
- `Typora-Editor-App\dist\markpilot-Setup-2.1.25.exe` sha256 `534863bd9f4eafabfa36e714a5b46226f2d7bfada21667175f42acc646ce9ffa`
- `Typora-Editor-App\dist\markpilot-v2.1.25-portable.exe` sha256 `e7d34eda922c1bf71c0b45fb1ad21516e4b2f9ae3ca70dea155a08b2e2dff0fb`
- `Typora-Editor\dist\markpilot-2.1.25.vsix` sha256 `34b815c1a9a3008bc11539d497cac24bf166a7c6f266b2424d74e371ca32489b`
- 发布目录：`Typora-Editor-App\dist\release-2.1.25-private\`（含 `SHA256SUMS.txt`）

四方哈希链（`docs/verify-vsix-chain-2.1.25.json`）：`extension-src/render == app/renderer == app.asar(app/renderer) == VSIX(extension/render)`，`verified: true`，扩展侧 518 个文件、共享渲染层 496 个文件；装机版 `app.asar` 与 `dist-2.1.25` 的构建产物 sha256 相同（`ef47555e…`）。
密钥物料审计：VSIX 520 个文件 0 处命中、ASAR 528 个文件 0 处命中。
与 2.1.24 产物的 renderer 逐字节比对（`scripts/acceptance/probe-renderer-diff.cjs`）：只有 `js/marker-caret-guard.js`、`js/toolbar.js`、`js/typora-patches.js` 三个文件不同。

全量验收（安装版 2.1.25，35 个场景）：**32 通过 / 3 被标记**，三条都做了归因：

| 被标记的 | 归因 | 证据 |
| --- | --- | --- |
| `50-copy-table-and-image` | **测试自身的竞态**，不是产品回归 | 场景的就绪条件是 `.some(图片已加载)`，而素材图片没有写死宽高、每加载一张就把表格往下推一截；"量坐标"与"右键"之间表格还在移动，右键落到表格上方的段落上，菜单里自然没有表格那组。探针 `probe-50-table-hit.cjs` 在 2.1.24 与 2.1.25 上量到**完全相同**的命中元素（`<th>名称</th>`）与完整菜单。把就绪条件改成"等全部图片加载完 + 600ms 稳定"后，2.1.25 上 14/14 通过。 |
| `73-mixed-editing-stress` | **既有问题**（与本次改动无关） | 同一场景在同一台机器上跑 2.1.24 产物：**同样的三条断言失败**（粘贴出现 2 次 / 剪切后仍在 / 撤销后 2 次）。待单独排查。 |
| 指标 `open.large.shellToIframe` 4615ms（基准 290） | **负载噪声** | 同一场景在安装版上连测三次：258 / 271 / 250 ms（均低于基准）；4615ms 出现在装机后紧接着的全量跑（机器同时在忙）。 |

新场景：`94-heading-block-start-caret-2.1.25`（16 断言 / 10 证人，安装版与 dev 树均通过；A/B 安装版 2.1.24 为 11/16）、`95-toolbar-and-floating-panels-2.1.25`（8 断言 / 5 证人，均通过）。变更相关子集（76 / 78 / 82 / 83 / 84 / 92）在安装版上全绿。

装机状态：桌面版 2.1.25 已装并核验（`install-app.cjs --expect-version 2.1.25`）；VS Code 侧 2.1.25 已 sideload 到 `%USERPROFILE%\.vscode\extensions\jinxi.markpilot-2.1.25`（重启 IDE 生效）；**Trae 侧未装**——Trae 正在运行，安装会被它接管，退出后重跑 `node scripts/install-vsix.cjs <vsix>` 即可。

未做的事（等指令）：GitHub Release、README 推送、商店发布、issue #1 的公开回复（回复草稿在 `E:\MarkPilot\.perf\issue-1\reply-draft.md`）。
