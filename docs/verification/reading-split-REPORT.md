# reading-split 族 · 真实用户日常操作普查（第二波）

- **被测产物**：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`
  **sha256 前 16 位 = `15b8a1b699a0782e`**（每次探针启动都断言并打印；四支探针读数一致；跑完复查未被改动）
- **主夹具（真实素材副本）**：`测试素材…/富文本测试-重识概率论.md` → sha16 `20f7fca7b95004f2`，169686 B，160220 字符 / 319 行
- **行导航夹具**：`reading-split-outA7/fixtures/RS-A7-逐行夹具.md` sha16 `54cb746ea13a5db1`，226 字符
- **探针**：`reading-split-probe-A.cjs`（阅读模式进出×光标滚动）、`reading-split-probe-A7.cjs`（方向键）、
  `reading-split-probe-B.cjs`（复制/查找）、`reading-split-probe-C.cjs`（双开）、`reading-split-probe-D.cjs`（分屏比例/窗口尺寸）
- **共用夹具**：`reading-split-lib.cjs`（复用 startup-and-menus-lib 的启动/连接范式）
- **页错误**：4 支探针共 `pageerror=0`；仅 1 条 `console.error: Failed to load resource: 400`（夹具里那条 data-URI 图片的取图请求，无脚本异常）
- **残留进程**：本轮结束 `Get-Process MarkPilot` = 0；产品目录只读（`git status` 里 dist/src 的改动均非本轮产生，exe sha 与开工时一致）

## 用例数与结论

| 探针 | 用例 | PASS | FAIL | INFO(环境阻断) |
|---|---|---|---|---|
| A 阅读模式进出×光标滚动 | 10 | 8 | 2 | 0 |
| A7 方向键逐行 | 5 | 5 | 0 | 0 |
| B 复制/查找 | 9 | 4 | 2 | 3 |
| C 双开 | 10 | 9 | 1 | 0 |
| D 分屏比例/窗口尺寸 | 10 | 6 | 4 | 0 |
| **合计** | **44** | **32** | **9** | **3** |

# 一、没反应 / 行为不符预期的项（带关键读数）

### 1. 阅读模式的光标没有被隐藏（产品 CSS 失效）
- 产品自己的样式表（style#3 第 158 条）写着：
  `[data-mp-reading="1"] .cm-editor:not(.mp-split-source) .cm-cursor{display:none}` —— 该规则**确实命中**光标元素（`matches=true`）。
- 但 CM6 自带规则 `.ͼ1.cm-focused > .cm-scroller > .cm-cursorLayer .cm-cursor{display:block}` 在**同一张表里排在后面、特异性更高** ⇒ 最终 `display:block`。
- 读数（阅读态、窗口有焦点 `document.hasFocus=true`、`cm-focused=true`）：
  `cursorCss={display:"block", w:2, h:34}`、`cursorBorder=rgb(76,154,255)/1.71px`。
- **像素级取证（红/蓝线扫描 + 闪烁相位）**：编辑态对照臂扫到竖线（`x=1726/1727/1728`，各 74 像素高）；
  阅读态第一张截图扫不到（闪烁 off 相位）、第二张扫到 `x=1645/1646/1647`，各 85 像素，颜色 `rgb(76,154,255)`。
  ⇒ 阅读态下**光标确实被画出来并且在闪**，不是"看不见"。
- **图上确认**：`reading-caret2.png` 里表格右缘那条蓝色竖线就是光标（位于 `col3` 单元格右侧），页面同时显示"退出 Esc"胶囊、工具栏隐藏 ⇒ 确系阅读态。
- 证据：`reading-split-outA/A1b-cursor-in-reading.png`、`reading-split-outR8/{edit-caret,reading-caret,reading-caret2}.png`、`reading-split-outR8/facts.json`

### 2. 进出阅读模式会让"正在看的那段文字"在视口里跳走（进入 512–841px，退出只回 22px）
- 三轮复现（同一支探针、同一夹具、同一支滚轮+点击落点手法）：

| 轮 | 进前 scrollTop | 阅读中 scrollTop | 退出后 scrollTop | 光标 head | 进入位移 | 退出回补 |
|---|---|---|---|---|---|---|
| 1 | 7934 | 8607 | 8607 | 12829 | **+673** | 0 |
| 2 | 7300 | 8210 | 8210 | 12829 | **+910** | 0 |
| 3 | 7258 | 7833 | 7833 | 12829 | **+575** | 0 |

- 换算成"原文字在视口里的落点"：编辑态该行在视口上方之外，进入阅读态后跳到视口顶部附近（relFrac -11.7 → -12.6），
  退出后**停在原处不回补**（relFrac 只回 0.03，≈22px）。用户看到的是"进出阅读模式，正文整体往上窜 0.5–0.9 屏"。
- 文档总高也随之变（9784 → 10984 → 10595），属排版重排；但滚动位没有做补偿，**没有回到进入前的那一屏**。
- 证据：`reading-split-outR9/recon9.json`

### 3. 阅读模式里打字/回车会真的改文档（阅读模式不是只读）
- B6：阅读态（`dataset=1`、工具栏隐藏）里真实键盘输入 `RS-TYPING-TEST` + `Enter`：
  文档长度 **160220 → 160230**、`window.mpEngine.getValue()` 含 `RS-TYPING-TEST`、`beforeinput` 事件 15 条**全部 `prevented=false`**。
- 与"阅读模式"的语义直接冲突：用户以为在看，敲键盘却落在正文里（且会进入自动保存链路）。
- 证据：`reading-split-outB/B6.json`、`report-B.json`（B6 项）

### 4. 窗口收窄到 700px 时，主视图正文横向溢出（裁在分栏线上、要横向滚才能读全）
- D5（700px 宽 + 双开）：主视图 pane 宽 350px，`scroller.clientWidth=340` 而 `scrollWidth=518` ⇒ **横向溢出 178px**；
  首行行盒 `left=24, right=494, width=470`（已经越过 pane 的 350px 边界）。
- D7（700px + 双开 + 阅读模式）：溢出 **267px**，`.cm-content` 内容宽 607px（阅读态 `max-width:780px` 不缩）。
- 恢复原尺寸（1167px）后溢出归零 ⇒ 只在窄窗口出现。触发点：**开双开后每栏宽 < ~420px**。
- **图上确认**：`D5-narrow.png`（700×713）里左栏正文被 583→350px 的分栏线裁断（"1.2.4 Remark 随机机制、随机变量的…"一行读到一半就没了），
  右栏源码正常换行 —— 与 178px 溢出读数一致。
- 证据：`reading-split-outD/D5-narrow.png`、`D7-narrow-reading-split.png`、`report-D.json`

### 5. 双开两栏比例不可调：没有分隔条，拖拽无效（恒 50/50）
- C9：拖前/拖后 `主宽=583 / 从宽=583 / 比例=0.5` 完全不变；DOM 里没有分隔条（`.mp-split-handle/[data-mp-split-handle]/.mp-split-divider` 计数 0）；
  pane 的 `cursor:auto`（不是 col-resize）；实现只有 `flex:1 1 50%` + 1px 左边框。
- 证据：`reading-split-outC/C9-divider-drag.png`、`report-C.json`（C9 项）

### 6. 「更多」菜单下半部分默认点不到（需要先在弹层里滚一下）
- 弹层 `overflow-y:auto`、高 527px、内容 625px；「进入阅读模式」那一行初始 rect `[552,584]`，
  该点上的 `elementFromPoint` = `DIV.cm-content`（**不是菜单项**）⇒ 直接点它无效。
- 在弹层上真滚轮后（`popScrollTop=99`）该行移到 `y=469`，`elementFromPoint` = 菜单项，点击成功进入阅读模式。
- 阅读态里工具栏没了，这个弹层是**唯一**的"退出胶囊之外"的入口，所以这条影响真实路径。
- 证据：`report-A.json`（A4 项，含滚动前后 elementFromPoint 对照）

# 二、环境阻断（不写通过也不写失败）

**系统剪贴板不可用（锁屏态）**——已证事实：
1. `mpHost.writeClipboard({text:'RS-ENV-PROBE-0123456789'})` 返回 `{ok:true, bytes:23}`，但紧接着 `clipboard:hasImage` 回读 `textLen=0`（写入→回读不通）；
2. 真实 `Ctrl+C`（B2 阅读态 / B7 编辑态**对照臂**）都没有观察到 `copy` 事件（两条腿同结果 ⇒ 环境/通道问题，不是阅读模式特有的）；
3. 已证的渲染侧事实：选区 = 文档源码 117 字符且含 `$…$` 公式源码（B1 真鼠标拖拽选中），元素位置读数 `sel={from:153,to:270}`。
⇒ "剪贴板里到底有什么"**本机不可验证**，需要在未锁屏的机器上复验。

# 三、未验证 / 未覆盖

- 阅读态光标的像素取证只在**默认深色主题**上做过；其它阅读配色（宋韵浅色/Notion 等）下的光标对比度没量。
- 光标闪烁相位：像素扫描需要两张截图才凑齐"亮"相位，单张截图可能落在灭相位 ⇒ 结论以两张为准（已记录）。
- 只测了 `重识概率论`（含 1 条 data-URI 图片）与一个纯段落小夹具；**超长文档（>30 万字符）**下阅读态排版路径没测。
- 分屏的"从视图对齐"只在主→从 / 从→主两个方向各测了若干采样，没有做极值（文档最末几屏）的系统枚举。

# 四、通过项（要点，读数见 report-*.json）

- **阅读模式进入/退出**：工具栏按钮（真鼠标）→ `dataset=1`、工具栏 `display:none`、胶囊"退出 Esc"可见、正文 16px·justify·内容宽 780 上限；
  Esc（keydown 确实进编辑面、`defaultPrevented=true`）与胶囊点击都能退出；「更多」菜单项在弹层滚动后可点。
- **进出后光标位置守恒**：3 轮 × head 全程不变（9415；A9 文末 head=160220 也不变）。
- **阅读态滚轮**：真实 wheel 后 `scrollTop 5947→8691`，文档长度不变。
- **文末贴底进出**：光标（文末）在进出后都仍在视口内；`scrollTop 9995→10625→9995`。
- **方向键（A7，独立小夹具）**：6 步下移，逻辑行步进 `[0,1,1,1,0,1]`、落点步进恒 `31px`（= 阅读态行高）、光标始终在视口内、文档不变、6 次 keydown 全部进编辑面；原路 6 步 ArrowUp **精确回到原行原列**（`6:51→…→3:6`），顶端再按上不消失。
- **阅读态查找**：`Ctrl+F` 面板出现（`.cm-search.cm-panel`，`display:block`）、焦点进 `cm-textfield`、查询词进的是输入框（文档长度不变）；
  ASCII 查询词第一次 Enter **150ms 内**就跳到匹配（`from 153→893`，命中 `Omega`），第二次继续前进（`→196`），全程留在阅读态。
- **双开**：按钮进入 → 出现 `.mp-split-pane` + 第二个 `readOnly` EditorView（document 同源 160220）；比例 583/583=0.5，无横向溢出；
  主→从滚动 4 轮采样：两侧可见行区间交叠 17/24、23/23、18/18、24/24 行（起点行差 0–1）；
  从→主滚动（主视图回顶部后）：从 0→900 时主 0→1094，两侧首可见行差 0；
  **点从视图某行 → 主视图光标落在同一文档行（150→150、131→131、190→190）并出现 `data-mp-hl` 高亮**；
  编辑主视图 `RS-MIRROR` → 从视图 docLen 同步 +160229 且含该串；
  阅读模式与双开可并存（主 16px/从 13.76px 排版各自独立）；
  再点一次关闭：pane/`.mp-split-source` 从 DOM 移除、host 去掉 `mp-split-on`、`_slave()=null`、按钮取消 active；关闭后主视图仍可滚可打字（+1 字符）。
- **窗口尺寸变化**：+400px 时两栏按比例重分配（583→783、比例仍 0.5）、首行宽 526→726、无横向溢出；
  变宽后滚动同步/点击定位/打字镜像全部仍成立；尺寸恢复后宽度回到 583（差 0）。
- **关掉再开分屏**：2 轮复验，从视图回到与主视图相差 1–2 行的位置（**D 探针里那次"回到第 1 行"未能复现**，判为测量时机问题，不作为缺陷）。

# 五、文件清单（本族产出，全部在 `.mp-verify\checklist\` 下）

- 探针/库：`reading-split-lib.cjs`、`reading-split-probe-{A,A7,B,C,D}.cjs`
- 侦查：`reading-split-recon{1..9}.cjs`（CSS 溯源、弹层几何、双开同步映射、光标像素扫描、复现性检查）
- 读数：`reading-split-out{A,A7,B,C,D,R2,R3,R4,R6,R7,R8,R9}/` 下的 `report-*.json` 与截图
