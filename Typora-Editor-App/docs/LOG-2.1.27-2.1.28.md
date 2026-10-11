# 2.1.27 → 2.1.28 工作日志

本轮两件事，都是用户令：

1. issue 提出者在 B 站补的一条：**PC 端把窗口缩窄到一定程度后，段落/标题级别标志左侧的留空消失，右侧留空正常**（用户令：「你处理一下」）。
2. **工具栏手动收纳**：加一个按钮，压缩之后只留这一个按钮；展开态点击变压缩、压缩态点击变展开；加一个小动画；注意性能优化。按钮摆哪儿由我定（用户令：「考虑各种页面布局缩放比例大小的情况，按美观与性能原则找一个地方放，不要太丑」）。

---

## 一、① 窄窗口下级别角标左侧留空消失

### 在真实 DOM 上问清楚"这个标志是谁画的"

先把"是不是我们画的"问清楚（既有探针 `probe-heading-badge-owner.cjs` 同路子）：`H1`…`H6` 这个角标**不是我们的元素**，是 vditor 自带的伪元素
`cdn/vditor/dist/index.css:1640` → `.vditor-ir .vditor-reset > h1:before { float: left; padding-right: 4px; margin-left: -29px; content: 'H1' }`——
它挂在**内容盒左缘之外 29px** 的位置。

### 根因（算术 + 实测两侧吻合）

`.vditor-reset` 的左右垫边是 v2.0.6 定的 `max(28px, calc((100vw - 1280px) / 2))`（`render/css/typography.css`）。只要编辑器宽度 ≤ 1336，这项就退到 **28px < 29px**：角标被顶出滚动容器的左缘、只剩 1px 露在边上，"左侧留空"就等于没有了；右边 28px 照旧——正是用户描述的样子。这也解释了"缩窄到一定程度才出现"：宽窗口下垫边是 `(100vw-1280)/2`，留白很足。

### 修法

左垫边下限提到 46px（29px 悬挂 + 呼吸位），右垫边保持 28px：

```css
padding-left:  max(46px, calc((100vw - 1280px) / 2)) !important;
padding-right: max(28px, calc((100vw - 1280px) / 2)) !important;
```

宽窗口下两侧仍同时等于 `(100vw-1280)/2`，**版心居中与 v2.0.6 完全一致**——观感只在窄窗口这一段变化，风险面最小。右侧不动是因为用户说右侧本来就是正常的。

### 判据（不看源码，看窗口真实像素）

`webContents.capturePage()` 取窗口真实像素，在写作区左边 46px 里**逐列找第一列有墨**（背景亮度取该区域最左两列的均值，深/浅主题都成立）：修好后角标画在离内容盒左缘 17px 处（= 46-29），修之前 ≈0px。这条 A/B 对得上：旧产物必然失败、新产物必然通过。

实测（场景 98）：

| 窗口宽 | 左垫边 | 右垫边 | 角标标称左缘 | 像素上第一列有墨 |
| --- | --- | --- | --- | --- |
| 1647（版心两侧仍有留白） | 55 | 55 | 26px | 26px |
| 1200 / 900 / 700 / 560 / 460 | 46 | 28 | 17px | 17.3px |

---

## 二、② 工具栏手动收纳

### 摆放：为什么是"工具栏自己的最后一项"

候选位置逐个否掉，理由记在 `render/js/toolbar-collapse.js` 的文件头：

- **独立浮标放右上角/左上角**：窄窗口下工具栏浮条会顶到 `max-width: calc(100% - 16px)`，正好压住这两个角——会让出"按钮被浮条盖住"的形态。
- **右下角**（缩放角标旁边）：不与浮条打架，但收起时工具栏带那块**保留高度还在**，正文不会上移，顶部留一大块空白，看起来像坏了。
- **改成工具栏自己的末项**：浮条居中/换行时它跟着走，任何窗口宽度都不会与自己重叠；大纲栏被 `margin-top` 推到工具栏带之下、缩放角标在右下、状态栏在外壳里，谁都不占这块；内容缩放（Ctrl+滚轮）只作用于 `.vditor-content`，工具栏与按钮不在其中，所以**按钮大小与位置不随缩放变化**。
- 收起后浮条改贴工具栏带内右上角（`left:auto; right:8px`），按钮落在离编辑区右缘 17px 处——跨过约 12px 的滚动条。

### 动画：只动 transform / opacity / 颜色

- **收起**：先让其余项与浮条底色淡出（140ms，此刻布局不动、按钮位置不动），140ms 后把其余项 `display:none`、浮条改贴右上角，按钮用 FLIP（一次性平移补回起点 + 两帧内归零）滑到新位置。
- **展开**：反过来，先恢复布局再 FLIP。
- 全程 **不收放任何布局**：一次点击只量两次 `getBoundingClientRect`；不挂 `mousemove`、不挂 `ResizeObserver`。
- 启动恢复走 `--noanim` 一步到位，不让人看到一次"从展开滑到收起"的回放。

### 与既有自动收纳的关系

`toolbar-autohide.js`（窗口太矮时自动收起、贴顶弹出）在手动收起时**整体让位**：`measure()` 不再启用、`reveal()` 直接返回、`onMove` 直接 return。否则鼠标一靠顶就会把它弹回来，与"保持压缩"直接矛盾。

---

## 三、过程中的自证与纠错（如实记录）

1. **一个 30 分钟的假谜题是我自己写错类名**：探针里写成了 `.vditor-toolbar-fold-item > button`（应是 `typora-`），于是出现"同一选择器时好时坏"的怪现象——`until()` 用的那一处写对了（能过），`btnSpot` 用的那一处写错了（返回 null）。我先后用"元素关系体检"和"连问 24 次"两种方式取证，才在把两行并排看的时候发现是类名差了三个字母。教训：同一个选择器在同一个文件里出现多次时，先逐字符比对再怀疑浏览器。
2. **`display:none` 收不干净**：第一版收起后浮条里还剩 5 项（浮条 167px 宽）。原因是 **vditor 会按编辑模式给工具栏项写内联 `display`**（`inline-block`/`none`），内联样式压过普通样式。改成 `display:none !important` 才真的只剩一项。
3. **透明浮条会变成正文里的死区**：浮条底色淡出后壳子还在，会接住右上角那一小块 42×36 的点击。补了 `pointer-events:none` + 指针事件收回给按钮自己，并把"那一点上现在是谁"写进验收断言。
4. **"不收放布局"这句话一开始不成立**：收起后写作区保留带（`--typora-toolbar-inner` 决定的 `padding-top`）会被 `outline-layout.js` 的 ResizeObserver 跟着改小，正文因此上移一次。这其实是**该有的效果**（"把空间还给正文"），但要如实说、并且量代价：143,656 字符 / 2002 块的大文件上点一次收起，**长任务为空**（<50ms）。
5. **`title` 会多出一个原生提示框**：`aria-label` 已经够 vditor 画 tooltip 用，写 `title` 的结果是悬停时出现两个提示框。删掉 `title`。
6. **指标噪声再确认一次**：安装版全量跑把 `open.large.shellToIframe` 记成 856ms（基准 290）。**同产物、空机器**连测两次：269 / 244ms；dev 树同样 284 / 284ms。该指标历史摆动 4615 / 473 / 278 / 363 / 856，属单样本噪声，本版未碰启动路径。
7. `73-mixed-editing-stress` 的三条（粘贴出现 2 次 / 剪切后仍在 / 撤销后 2 次）**与 2.1.25、2.1.26、2.1.27 产物逐条相同**，是既有问题，本版未碰剪贴板与编辑路径。

---

## 四、产物与装机（内部）

- `Typora-Editor/dist/markpilot-2.1.28.vsix`（523 个文件，6.15 MB，sha256 `ef52fe76…`）
- `dist/markpilot-Setup-2.1.28.exe`（`d4e63514…`）、`dist/markpilot-v2.1.28-portable.exe`（`1af3079f…`）
- 四方哈希链 `docs/verify-vsix-chain-2.1.28.json`：`verified: true`，扩展 521 / 渲染层 499 个文件；`app.asar` sha256 `36001ac2…`（装进去的那份与构建出来的一致）。
- **次序上有个必须说清的点**：安装版全量验收跑完之后，我才改 README/CHANGELOG（文档不属于验收对象），因此**重打了 VSIX**（`e59d4177…` → `ef52fe76…`）并重跑哈希链。被验收的那两个产物没变（asar `36001ac2…` 与 Setup `d4e63514…` 前后一致），渲染层在 VSIX 里也逐字节未变——验收结论对最终产物依然成立。
- 装机：桌面版 2.1.28 已装并核验（`install-app --expect-version 2.1.28` → `version: 2.1.28`）；VS Code 已 sideload `jinxi.markpilot-2.1.28`；**Trae 侧未装**（Trae 正在运行，脚本拒装），退出 Trae 后 `node scripts/install-vsix.cjs "E:/MarkPilot/Typora-Editor/dist/markpilot-2.1.28.vsix"` 即可。

---

## 五、全量验收（安装版 2.1.28，38 个场景）

**37 通过 / 2 被标记**，两条都归因清楚：

| 被标记的 | 归因 | 证据 |
| --- | --- | --- |
| `73-mixed-editing-stress`（粘贴出现 2 次 / 剪切后仍在 / 撤销后 2 次） | **既有问题**，与 2.1.25/2.1.26/2.1.27 同一现象 | 三个版本的 `report.json` 里这三条断言逐字相同；本版未碰剪贴板与编辑路径 |
| 指标 `open.large.shellToIframe` 856ms（基准 290） | **单样本噪声** | 同产物空机器连测 269 / 244ms；dev 树 284 / 284ms；该指标历史 4615/473/278/363 |

本版新增的两个场景全绿：`98-heading-badge-left-gutter-2.1.28` 9/9（2 证人）、`99-toolbar-fold-collapse-2.1.28` 20/20（9 证人，含大文件一次点击的代价指标）。
dev 树全量先跑了一遍（37 个场景，36 通过）：唯一失败是 99 的"源与开发树逐字节一致"——那一跑用的副本比源旧（我在跑之前改了 `toolbar-collapse.js` 忘了同步），同步后重跑 20/20。

## 六、文档

- 两份 README 与 VSIX 的 `extension-src/README.md`：在 v2.1.27 之前插入「v2.1.28 更新」小节，版本徽章随之改到 2.1.28；**逐字对照线上已发布版本过"只增不删"闸门**（`verify-readme-keep.cjs`，基线是 `gh api` 拉回的线上正文）：中文 104→105 标题 / 49→49 段，英文 98→99 标题 / 46→46 段，丢失 0。
- `docs/RELEASE-2.1.28.md`（对外说明，末节为「修复」）。
- `extension-src/CHANGELOG.md`：追加 2.1.28 段（含根因、修法、两个新场景、判据数字）。

## 七、推送记录（2026-09-16）

用户令：「推送吧」。

**推送前的文档审计**：两份 README 的 v2.1.28 小节 + `RELEASE-2.1.28.md` + VSIX 的 `README.md` 逐行过禁用词
（`根据|指示|我们修|成因|变更：|本轮|用户报|用户实测|用户令|自证|断言|验收|台账|回归|实测|基准|commit|哈希`）——全部 0 命中；
本版小节里出现的"数字"只有 `H1`/`H2` 与版本号本身（没有任何 ms/px/倍率这类刻度）。两份 README 对着**线上已发布版本**过"只增不删"闸门：丢失 0。

| 通道 | 结果 | 线上核验 |
| --- | --- | --- |
| GitHub Release `v2.1.28` | 已创建（非草稿、非预发布），3 个资产 | 三个资产的**服务器端 sha256** 与本地 `SHA256SUMS.txt` 逐个一致（vsix `ef52fe76…`、Setup `d4e63514…`、portable `1af3079f…`）；说明正文 688 字符、小节顺序 `工具栏收成一个小按钮 / 窄窗口下标题级别角标不再贴边 / 安装 / 修复`，末节为「修复」、无禁用词、与本地 `docs/RELEASE-2.1.28.md` 逐字节相同 |
| README.md（中文） | 已推（commit `0b4babdaf7`，63253 → 63683 字节） | 拉回线上正文与本地**逐字节相同**（sha256 `e3c33aa59f12`） |
| README.en.md | 已推（commit `c8bf6e367b`，64297 → 64793 字节） | 同上（sha256 `e1bd222ab33c`） |
| Open VSX | 已发布 `jinxi.markpilot 2.1.28`（第一次上传即成功） | `latest` 端点回读 `version=2.1.28`、`timestamp=2026-09-16T02:12:13Z`；再发一次明确报"already published"；下载线上包 **6,447,818 字节、sha256 `ef52fe76…` 与本地逐字节相同**。（`/api/jinxi/markpilot/2.1.28` 这个精确版本地址在发布后几分钟内仍 404——与上一版同样的 CDN 延迟，用 `latest` 与重复发布双重确认） |
| VS Code Marketplace | **未发**：本机无 `VSCE_PAT`（`publish-store-userenv.cjs --check`：OVSX_TOKEN 已找到、VSCE_PAT 未设置） | — （用户自设 `setx VSCE_PAT "<PAT>"` 后 `node scripts/publish-store-userenv.cjs --only=vsce`） |

**Trae 侧补装（用户 2026-09-16 关闭 Trae 后）**：`node scripts/install-vsix.cjs <vsix>` 已装进
`C:\Users\ltmroberthk\.trae\extensions\jinxi.markpilot-2.1.28`。逐文件核对两个 IDE 里的副本与源**逐字节一致**
（`toolbar-collapse.js` `06f7c368…`、`toolbar-collapse.css` `20fa7170…`、`toolbar.js` `c0415a1f…`、
`toolbar-autohide.js` `28a67f32…`、`typography.css` `67a812ff…`），`package.json` 版本同为 `2.1.28`。
至此三处装机齐了：桌面 EXE 2.1.28、VS Code 2.1.28、Trae 2.1.28；只剩 VS Code Marketplace 因本机无 `VSCE_PAT` 未发。
