# LOG-2.2.16（图片交互：连点必展开 + 点图片右侧空白落"图片之后"）

用户口径（2026-10-02，两张问题一起报；随后补充"图片是通过 windows 截图后粘贴进文档的 你试试"）：

1. "点击图片高频率点击有概率触发无法展开源码"；
2. "图片右侧空白点击后，逻辑应该是插入一个图片之后的光标；回车创建新一行。目前没有这个能力，
   导致文档最后如果是一个图片，需要很麻烦展开图片源码后通过键鼠 enter 才能创建新一行"。

## 一、复现（探针 + 用户流程）

- **用户真实形态**：`probe-image-paste-flow.cjs` / `probe-image-paste-tail.cjs` / `probe-image-paste-xscan.cjs`
  ——把一张 1600×900 的"截图"放进系统剪贴板（独立进程 `SetImage`），在应用里真按 Ctrl+V，
  等它归档插入（整栏宽 816×459 的 Markdown 图），再在**这张图**上复测。剪贴板 save/restore 前后各一次。
- **① 连点**：`probe-image-click-family.cjs`（不同间隔/次数矩阵）、`probe-image-click-v3.cjs`（连点 1..5 次）、
  `probe-image-click-timeline.cjs`（window/document 两级捕获 + `DOMTokenList.add/remove` 带栈记录）。
  修复前终态：连点 1 次=折叠（选中），**2 次=展开，3 次=折叠，4 次=展开，5 次=折叠**——奇偶决定成败。
- **② 空白带**：`probe-image-shapes.cjs`（8 种文档形状矩阵：纯 md 图 / 无尾随换行 / 带标题 /
  裸 HTML 图块 / 图文同段 / 引用块 / 列表项 / 长文档尾图）、`probe-image-blankzone.cjs`（命中链 + 逐点打字）、
  `probe-image-blankzone-html.cjs` 与 `probe-image-html-steps.cjs`（裸 HTML 图块：命中链、事件是否
  到达渲染岛/IR 元素、逐段光标）、`probe-image-blankband-steps.cjs` / `probe-image-paste-steps.cjs`
  （mousedown → mouseup → 稳定，分段读光标）。修复前三类坏相：
  - 贴图片右缘（图右 +24px，仍在段落里）落点有时在图片**前面**（P offset 0）；
  - 裸 HTML 图块（正文里直接写 `<img …>`）点右侧空白，光标被塞进**隐藏源码**的 `code` offset 0
    （源码折叠时是 0×0 的隐藏块，Blink 的 `caretRangeFromPoint` 照样命中它），接着打字打进 `<img>` 标签里；
  - 全栏宽粘贴图点"图片右下"那一带（窗口右下角）会命中我们自己的缩放角标，光标落到编辑器外，**打字直接丢**。

## 二、根因

1. **`vditor` 的 `B()`（`cdn/vditor/dist/index.min.js` 1:83237）先清后加**：每次点击先把全文档的
   `vditor-ir__node--expand` **摘干净**，再看"当前 range 的 startContainer 在不在某个
   `vditor-ir__node` 里"决定重加。连点时第 2 下把源码行展开 → 图片被推走 → 第 3 下常落到
   节点外（实测 target 是 `P`，见 `probe-image-click-timeline.cjs` 的事件时间线）→ 展开被摘掉不再重加。
2. **HTML 图块的渲染岛分支抢光标**：`vditor` 的 IR click 处理器里，命中 `pre.vditor-ir__preview`
   （不可编辑岛）时会把选区改成"岛的前一个兄弟（源码）的内容开头"——于是"点图右侧空白"得到
   `code` offset 0（图片**前面**），回车就在图片前面分段。
3. **空白带的落点本来就是"看运气"**：`img` 节点盒就是图片盒，节点之外、段落之内的那一条空白
   由 Blink 的 caret 就近落点决定（近邻像素、行末、节点前后都会随布局位移而变），没有确定性可言。

## 三、修复（`render/js/media-tools.js`，全部在既有图片点击补丁层内）

| 点 | 实现 |
| --- | --- |
| 连点（`detail≥2`）与 Alt+单击 | `展开图片节点()`：先清全部展开，再给这一个节点加 `--expand`、去 `--hidden`，光标进源码（md 图落在 `--link`（路径）那格开头、HTML 图块落在 `code` 开头）。**不再让 `B()` 摇摆** |
| 连点落在**已展开的源码行**上 | 只"钉住"展开（不折回去），光标与选区原样保留（双击选词/三击选段不受影响） |
| 连点落在**图片独占那一段的空白**上（展开后图片被顶走，第 3 下常打这儿） | 同样只钉住展开，并把光标收到"图片之后" |
| 单击/点右侧空白 | `图片空白带()`：命中"同一块里、图片右侧或下方、没点在图片/源码上"，且原生落点**不在可见源码上、也不是文本**时接管；落点放到**紧跟图片节点之后**（`setStartAfter`，即 `P` offset=节点下标+1）——回车即在图片下方分出一段 |
| 拖选护栏 | 接管放在 **mouseup**（按下时不 `preventDefault`）：指针动了>4px 就是拖选，交给原生；没动才是点击 |
| click 守卫 | mouseup 接管过的那一下，`click` 阶段再挡一次——否则 HTML 图块的岛分支会把光标抢回源码 offset 0 |
| 候选节点选取 | 候选 = 块内最里层、确实含 `<img>` 的节点；**块自身也算候选**（裸 HTML 图块是"节点即块"，`querySelectorAll` 搜不到自己）；一块多图（表格）时取离点击点最近的，且 >60px 不认 |

## 四、验收

- **探针**：`probe-image-click-v3`（连点 1..5 次：1=选中、2/3/4/5 全部展开）、
  `probe-image-click-timeline`（连点第 3 下：从"被 `B()` 摘掉"变成 `展开图片节点` 重新钉住）、
  `probe-image-shapes`（8 形状：点右侧 → 回车 → 打字 → 存盘，全部落新行）、
  `probe-image-paste-steps`（粘贴图 x=图右+4/8/16/24/31 全部落 `P@1`）、
  `probe-image-blankzone-html`（HTML 图块：源码末尾 TEXT(49)@49，点击不再到达岛/IR 元素）。
- **验收场景 138**（`scripts/acceptance/scenarios/138-image-click-and-blank-band.cjs`）：
  **28/28 断言、6 证人**（几何 + 磁盘）。含两组护栏：单击=选中不展开、从右侧空白带**拖选**仍是原生拖选
  （选区非空、磁盘逐字节相同）、Alt+单击仍展开。
- **human-input 场景 138**（`138-hi-image-click-family.cjs`，五通道）：**21/21 断言、4 证人**。
  鼠标（单击/连点 2·3）、键盘（回车带文本通道 + 打字、Ctrl+End）、组合键（Alt+单击、Ctrl+单击多选、
  Esc 清选）、键鼠配合（先点选中 → 点右侧空白 → 回车打字）、拖拽（空白带起手拖选、文档零改动）。
- **突变验证**（两处各杀一次）：
  - 注掉 click 的 `detail≥2/Alt` 分支 → 连点 2/3/4 次与 Alt 单击共 4 条断言变红；
  - 注掉 mouseup 的落点纠正 → HTML 图块 3 条 + 磁盘 1 条变红（磁盘里 `Z` 插进了正文中间，
    正是用户报的病象）。
- **真屏看图**（`probe-image-accept-shots.cjs`，2 倍放大）：A 连点 3 次后源码行可见；
  B 点右侧空白后原生光标贴在图片右缘（元素级落点）；C 点图片下方落在下一块/新行。
- **回归**：定向 20/50/76/87/89/114/138 = **7 通过 0 失败**（76 是拖选家族 114/114）。
- **全量（dev，57 个场景）：53 通过 / 3 失败 / 1 不适用**；三处失败逐一复跑定性，**没有一处是本轮引入**：
  - `10-open-latency`：长跑里的 CDP 传输超时（17/17 断言全过，大文件那一段没量到）；单独复跑
    17/17 ✓，各指标与基准同级（`open.large.spawnToDom 900ms` 等）——**环境抖动**。
  - `82-caret-marker-jitter-endpoint-2.1.11`：套件上下文里的公式拖选像素断言红 2 条
    （那次"选区长度=37"，太短所以没盖到公式）；单独复跑 22/22 ✓（"选区长度=122"）——**套件上下文抖动**，
    与图片点击无关（该场景只拖公式）。
  - `90-math-command-family-2.1.17` ⑤"选中的同族候选插进公式源码"：**A/B 证明与本轮无关**——
    把渲染层回退到 2.2.15（fa86fa6）后同一场景同样红；该步在场景头注释里已自记脆弱
    （"面板开着时直接改写源码，随后的输入落不进公式"）。
- **human-input 全量（19 个场景）：7 通过 / 12 失败**；失败 12 个逐一核对，**全部是既有红**：
  - `120/121/122/123/124/125/126/127/129/130/131`（11 个）：与 `.perf/human-input/human-input-r2`
    的历史报告同一批，早就是红的；
  - `135-recursive-merge-window`：与 `.perf/human-input/human-input-r3` 的既有红一致；
    **A/B 复验**（回退到 2.2.15 渲染层）同样红、证据逐字相同。
  - 本轮相关的那一组全绿：**128 / 132 / 133 / 134 / 136 / 137 / 138**（138 是本次新增的五通道场景）。
  - 另做了一次定点 A/B：`127-hi-drag-image` ② 在回退版上同样红（落点 `SPAN@7`、`选区长 0`，
    证据逐字相同）——拖图选区那条不是本轮引入。

## 五、产物与链校

| 产物 | 字节 | sha256 |
| --- | --- | --- |
| `markpilot-Setup-2.2.16.exe` | 116427524 | `0e0d4c59382711cfcad59c7a40bfb6f347a132cd41b44bf1439a4057f624d644` |
| `markpilot-v2.2.16-portable.exe` | 116200428 | `9f7fff50d7474430d4b30519bd4c27adf1a750c5b254be1de7af6e46e6ff40cd` |
| `markpilot-2.2.16.vsix` | 6506906 | `34c021465938d6899c98ccf712bfb43d25e18eb7254bf126629144a2d6f859f7` |

- 链校：`scripts/verify-chain.cjs` → **verified=true**（`.perf/verify-2.2.16/chain.json`），四链逐字节：
  extension-src/render == app/renderer == 打包 asar 内 app/renderer；extension-src/render == VSIX 内
  extension/render；asar 内主进程/外壳 == 开发树 app/（36 文件）。
- 本机安装：EXE → 2.2.16；VSIX → Trae 2.2.16 / VS Code 2.2.16（重启 IDE 后生效）。
- **安装版门禁**（`--app=installed`，2.2.16）：76 114/114、87 16/16、89 7/7、92 44/44、101 32/32、
  107 15/15、134 8/8、137 18/18、138 28/28 —— **9 通过 0 失败**。
- **已推送**（用户令"推送"，2026-10-02）：
  - 商店：**Open VSX `jinxi.markpilot` 2.2.16 已在线**（2026-10-02T07:45:35Z，`latest` 已指向它）；
    线上文件声明的 sha256 与下载回来的字节都与本地逐字节一致（`34c02146…`）。
    VS Code Marketplace 未推（本机无 `VSCE_PAT`）。
  - GitHub Release：`v2.2.16` 三个资产（VSIX / Setup / portable）的大小与 sha256 与本地逐项相同。
    https://github.com/ltmroberthk915/markpilot/releases/tag/v2.2.16

## 六、口径与未决

- 修复前的 `probe-image-paste-tail.cjs` ② 段用**陈旧坐标**（几何在文档变动前取一次）——
  其中 `x=图右+24` 的 P@0 读数已用按 x 扫描的 `probe-image-paste-xscan.cjs` 证伪：
  同一形态下 x=图右+4/8/16/24/31 全部落 P@1。该读数不作为证据使用。
- 粘贴图的 base64 ↔ `file+.vscode-resource` URL 口径不变（内存显示用 URL、磁盘保留原样），
  与本轮无关，见 `docs/LOG-2.2.13.md` 的 user-file-host 结案。
- 窗口右下角"缩放角标"覆盖的那一小块：点它仍走角标自己的交互（不加宽）。
