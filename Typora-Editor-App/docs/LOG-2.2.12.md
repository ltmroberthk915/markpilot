# 2.2.12 · 行内公式：选择态下点源码，光标跳到公式最前面

本文是内部记录（复现步骤、取证读数、哈希与验收数字），不进 README / Release 说明。

## 一、病象

`### 调拨比例问题：$S=\left[\frac{m}{n+m}甲-x\right]+\frac{n}{n+m}乙$` 这一行，公式已经展开（源码可见、渲染浮框悬在下方）时，
鼠标点 `\left[` 与第一个 `\frac` 之间，光标**跳到别处**（实测是跳到这条公式源码的第 0 位）。用户口径："怎么这种问题老出现老修不好"。

## 二、复现

新增探针 `scripts/acceptance/probe-repro-inline-click-jump.cjs`（自带三件仪表：事件末尾/rAF/60/200/600ms 的光标采样；
`Selection` 写入口 `addRange/removeAllRanges/collapse/setBaseAndExtent/extend` **带调用栈**；每个点击点"应该落哪"的独立口径）。
鼠标一律走真实通道（`Input.dispatchMouseEvent`：move → press → 多步 move → release）。

| 用例 | 手势 | 目标偏移 | 修复前落点 |
| --- | --- | --- | --- |
| E1 | 从标题文字拖选跨过渲染结果（节点挂上 `typora-ir-selected`），再点源码 `\left[` 与 `\frac` 之间 | 8 | **0** |
| B1–B5 | 展开态直接点源码五个字符边界 | 8/8/14/21/32 | 全部正确（无选区时） |
| D1–D5 | 同一边界、行内从顶到底五个高度各点一次 | 8 | 全部正确 |

E1 的写入口栈（修复前）：

```
✎ t=3ms collapse(TEXT@46,0)
    ← placeCaret (render/js/math-source-map.js:23)
    ← HTMLPreElement.<anonymous> (render/js/math-source-map.js:272)   ← 贴边兜底
```

## 三、归因（两处叠加）

1. **接管条件把源码点击也接走了**。`math-select-reveal.js` 在拖选端点切进渲染结果时给节点挂 `typora-ir-selected`（REVEAL），
   `math-source-map.js` 的 click 分支把"节点带 REVEAL"也算作"必须接管"——可 REVEAL 之后用户点的往往正是**展开出来的真源码文字**。
   接管后 `targetOffset` 在 REVEAL 态必然算不出来（浮框被 CSS 摊成 `0×0`，点击点不在它任何字形盒里），流程落到贴边兜底；
   旧兜底写的是 `box.width > 0 && event.clientX > box.left + box.width / 2`——盒子量不出来时条件恒假，于是
   `placeCaret(code, 0)`：**光标跳到公式源码第 0 位**。
2. **我们自己的点击补丁无条件让路**。`typora-patches.js` 的 `patchInlineMathClickPosition` 只要看到
   `selection.focusNode === text` 就 `return`（注释口径是"浏览器自己解出来的，别动"），于是上面那个 0 被放行、留在原地。
   实测同一份代码在**没有** REVEAL 的状态下（B/C/D）落点全对——所以病只在"选择态 + 点源码"这个交叉口出现，平时看不见。

## 四、修复

1. `math-source-map.js`：按下落在**这条公式自己的源码**里时，click 一律不接管（新增 `pressedInSource`）。
   分工写进注释：**渲染结果（KaTeX 像素）由我们的映射负责；真源码文字由浏览器原生命中测试负责**。
2. 同文件：贴边兜底量不到盒子返回 `null`；"映射、按下时的映射、贴边都不成立且没有可还原选区"的点击，
   在 `preventDefault` **之前**原样还给浏览器（旧实现先吞掉点击再走到兜底，光标只能停在原地）。
3. `typora-patches.js`：让路前**先核对**——用 `caretRangeFromPoint` 在点击点独立解一次，只有与当前光标相差 ≤1 个字符才让路；
   核不了（解不到、或不在同一文本节点）维持原样。

## 五、验证

**突变验证**（把修复 1 的那行 `if (起于源码) return;` 注掉，重跑同一探针）：

```
✎ t=4ms collapse(TEXT@46,0) ← placeCaret (math-source-map.js:295)     ← 病回来了
✎ t=16ms 落(typora-patches.js:2282/2283) → 8                          ← 修复 3 把 0 修回 8
```

两层各自独立起作用：修复 1 让错误写入不再发生，修复 3 兜住别处写进来的坏偏移。

**修复后同探针**：B1–B5、C1–C2、D1–D5、E1 全部落在点的那一格（8/14/21/32），写入口只剩 Vditor 自己的
`removeAllRanges/addRange`（`index.min.js` 的选区落点处理），没有任何来自我们的接管写入。

**验收图**（探针 F 段：拖选跨过渲染结果 → 点源码 `\left[` 与 `\frac` 之间；2 倍放大，红实线按浏览器自报的光标矩形画）：

- `​.perf/repro-inline-click/F-验收图-修复前.png`：红线在**公式源码第 0 位**（`|S=\left[…`）——病象。
- `.perf/repro-inline-click/F-验收图-修复后.png`：红线在 **`[` 与 `\frac` 之间**（偏移 8，标记读数 `{"left":302,...,"偏移":8}`）。

**中途一版被自己打回**：修复里曾加过"让路前先用 `caretRangeFromPoint` 核对"，全量验收把它打红——
场景 83/92/71。原因是**展开会让源码占住原来渲染结果的版面**：点渲染字形时映射算出的偏移（如 2）与
展开后同一像素落在源码哪一格（如 4）本来就不是一回事，核对等于拿错尺子重排。已回退（代码里留了注释说明为什么不能再加回来）。

## 六、回归与分类

**全量验收**（`scripts/acceptance/run.cjs`，dev 全场景）：

| 轮次 | 结果 | 说明 |
| --- | --- | --- |
| 第一轮（含被回退的那一版） | 43 通过 / 6 失败 / 1 不适用 → REJECT | 71、83、92 是那一版引入的，回退后复跑全绿（15/15、10/10、44/44） |
| 最终轮 `2.2.12-dev-final` | 见 §七 | |

**逐条分类（每条都给对照证据，不靠"看着像抖动"）**：

- `90-math-command-family-2.1.17` 的 ⑤（候选按 Tab 插进源码）：在**实装的 2.2.11**（未含本轮改动）上同样失败，
  读数逐字相同 `{"第二条":null,"源码":null}`（补全面板没打开）→ **既有问题**，非本轮引入。
- `20-copy-images` 的 Ctrl+C 剪贴板文件：整轮里红、**单跑通过**、实装 2.2.11 对照组也通过 → 抖动（剪贴板类），非本轮引入。
- Electron 套件：`test:math-boundaries`、`test:math-history`、`test:renderer`（regression / consistency /
  features / repairs / ui / shell / nav-guard）全部 exit 0；`test:math-caret` 有 1 条红
  （"在尾 $$ 上按退格不能改动文档"），把 `app/renderer` 换回 HEAD（2.2.11）复跑**同样红** → **既有问题**，非本轮引入。

> A/B 的做法：`app/renderer` 是 `extension-src/render` 的字节副本，用
> `git show HEAD:<path> > app/renderer/js/<file>` 换回上一版跑一遍，再换回本轮版本。

## 七、同一轮的第二批：快捷键加粗不渲染（一行里两个 `=`）

用户报告（2026-09-23，截图）：`**慢者独自行驶时间**` 用快捷键加粗之后**没有自动渲染**，正文里直接看见两个星号。

**复现**（`probe-repro-bold-render.cjs`，素材是用户桌面文档的副本）：把用户的真实文件原样打开——
`strong=false`、`星号可见=true`，即**解析层就没出 `<strong>`**，不是渲染时机问题。

**定位**（两级 bisect，都在 Node 里直接跑打包的 `lute.min.js`，`probe-lute-node.cjs`／`probe-lute-options.cjs`）：

- 触发条件是**同一行里出现两个 `=`**：`甲=乙。丙=**丁**` ✗，而 `甲乙。丙=**丁**` ✔、`甲=**乙**` ✔、
  `甲**乙**丙=丁=戊` ✔（强调在 `=` 之前就没事）。连 `*斜*` / `__粗__` 一起失效。
- 是 Lute 自己的行为（关掉我们的所有包装、直接调 `Md2HTML` 也一样），与我们的补丁无关。
- 追到开关：**Lute 的 `SetMark`**（`==高亮==` 那一组）关着时才这样；
  `SetMark(true)` 后 `甲=乙。丙=**丁**` → `<p>甲=乙。丙=<strong>丁</strong></p>`。
  Vditor 的 `preview.markdown.mark` 选项正是调这个（`t.SetMark(e.mark)`）。

**修复**：`extension-src/render/index.js` 的 Vditor 选项里加 `mark: true`（带注释说明它同时是解析开关）。

**影响面实测**（同一个 Node 台架，开/关逐条比）：

| 输入 | 关 | 开 |
| --- | --- | --- |
| `甲=乙。丙=**丁**` | 字面量 | `<strong>丁</strong>` ✔ |
| `价格 x = 5 元，y = 6 元` | 原样 | 原样（单个 `=` 不受影响） |
| `====` | 原样 | 原样 |
| `x==y` / `a==b==c` | 原样 | `<mark>`（这就是该语法本身；Typora 同样支持 `==高亮==`） |
| 逐条 `Md2VditorIRDOM → VditorIRDOM2Md` | — | **存回磁盘逐字节不变** |

**保真**：用户那份 484241 字节的真实文档，打开→立刻保存→`sha256` 与逐字节都相同
（`probe-open-save-fidelity.cjs`）。

## 八、同一轮的第三批：按下时版面对着手指翻过去

修完上面两条之后，新写的状态矩阵（场景 111）与兜底场景（112）各抓到一个同族缺陷，都钉在
`probe-repro-reveal-press-flip.cjs` 里：

1. **REVEAL 态（拖选翻开、没挂 `--expand`）里按源码被当成"点折叠公式"**。
   `math-edit.js` 的 `fenceClick` 只看 `--expand`：REVEAL 态下源码明明摊在屏幕上，它却走
   "折叠公式"分支——`preventDefault` + `stopImmediatePropagation`，把光标扔到公式外侧；
   顺带还把我们挂在编辑面上的 mousedown 监听吃掉（同一个 `stopImmediatePropagation`）。
   修法：按下落点在源码 `code` 里就交给浏览器（所见即所得），与"展开态"同一条口径。
2. **松手快的时候 click 落在"翻过之后的版面"上**。按下会让选区塌陷 → REVEAL 收起 → 源码藏回去、
   渲染结果顶回来；这一枪于是按新版面解读。实测：点源码第 8 格，光标落到**第 0 位**；按下后停
   120ms 再松手就正常（7）。修法：`math-source-map.js` 在按下那一刻把**浏览器自己的命中结果**
   （文本节点 + 偏移）记下来，click 时核对一次——对得上（±1 格）不动，对不上按按下的偏移落点。

两条合起来，`probe-repro-reveal-press-flip.cjs` 的落点从 **0 变成 8**（点的那一格）。

## 九、测试为什么没抓到（反思）

用户问得对："你设计这么多测试 怎么还是会被我发现重大bug"。把三条 bug 的逃逸路径摊开看，
缺的不是"测试数量"，是**测试类型**：

| 逃逸原因 | 具体表现 | 这一轮补的类型 |
| --- | --- | --- |
| 每个场景都从**干净状态**起步、只跑一条顺路 | 83/92 点的是折叠态、101 是键盘路径，**没人把"上一步留下的选区/REVEAL"当前置状态** | **场景 111**：状态 × 手势矩阵（5 个状态 × 采样点，独立口径判定） |
| **兜底路径零覆盖** | 病就住在"映射算不出来时怎么办"那一行；既有场景全在"算得出来"的路上跑 | **场景 112**：把 4 种"映射不可用/边界"的形状造出来 + **兜底台账**（代码里每多一条 `return null`/`??`/`catch` 而不进台账就红） |
| 判据各写各的、只在单场景内有效 | 83 有单调性、92 有逐点一致，**没有跨状态统一判据** | **`caret-lab.cjs`**：期望偏移由"版面 + KaTeX 发布的源码区间"独立算出，所有点击类场景共用一把尺子 |
| **加分支不需要配套测试** | 2.2.10 给 click 加了 REVEAL 入口，没有任何场景踩过它 | **场景 114/115**：用户报告即回归钉（含"注掉修复就变红"的说明）；新增交互分支必须带一条会红的场景 |
| 全是短会话 | 用户是连着点、拖、按几十分钟 | **场景 113**：种子固定的 40 步长会话扫描（光标不许消失、文档不许被误改、无 console 错误） |

矩阵与兜底台账一上线就各自抓到一个**当天写的**缺陷（第八节两条）——这正是它们该干的事：
不是"多测几遍"，而是把**没测过的输入维度**（残影状态、兜底分支、长会话）变成每次都跑的闸门。

## 十一、交接件（human-input 套件）的收口

并行会话（`sess_57e66d0d`）新加了一套拟人输入场景（`scripts/human-input/`）并报了 20 条，其中与 2.2.12 直接相关的三条：

- **F1【已修】**Word 删除（Ctrl+Backspace/Delete）触发撤销快照崩溃：`HierarchyRequestError: insertNode … no parent`，
  栈 `incremental-ir.js:196 snapshot ← typora-patches.js:252 undo.addCaret`。根因是**元素级落点**（Word 删除后正是这种形状）
  让 `route` 为空、插入容器落到**没有父节点的克隆体**上。修法：容器必须在克隆体内部（退到块内第一个文本节点），
  实在没有就跳过 wbr、快照照记。验证：`runner.cjs --only=131` 修复前每轮都在 step 37 抛该异常，修复后不再出现。
- **F2【本轮未再现】**代码块附近打字导致整条选区消失 + `getRangeAt(0)` 抛 `IndexSizeError`：同一发混沌场景复跑后
  该异常不再出现（同轮唯一的 console 记录是网络日志）；按"待下一轮定点复现"记录，没有当作已修。
- **F3【判定：夹具缺陷，非产品缺陷】**`132` 报"空行分隔的 17 段被并成 1 块"。核到夹具生成器
  `BODY = [..., ...SHAPES.map(([text]) => text), ''].join('\n')` —— 形态之间是**单个 `\n`**，Markdown 里那是同一段的软换行，
  正确渲染就是"标题 + 1 段"。改成空行分隔后 ⓪ 断言通过（18 块）；另有一条期望与 CommonMark 的 `_` 规则冲突
  （`__…__与` 是词内定界符，不出强调），一并对齐。现在 `--only=132` **11/11 通过**。
- **F19【确认边界】**160KB 真素材上 `vditor.getValue()` 只回 **15255** 字符（DOM 文本 16492、顶层块 133——IR 面只留了一部分），
  而 **Ctrl+S 落盘逐字节相同**（160220/160220）：保存不受影响。我们自己在 `math-edit.js`/`edit-shortcuts.js`/`find-replace.js`/
  `completion.js`/`reading-mode.js` 里用 `getValue()` 做前后对比或上下文，大文档上看到的是窗口——单独立一轮。

回写位置：`.perf/human-input/FINDINGS.md` 末尾「回写 · DeepSeek 会话」。

### 顺带修掉的一个构建事故

本轮把 `Typora-Editor-App/package.json` **截成了 7 行**（只剩 name/version/main…），`npm run sync` 因此静默失败过一次
（当轮我误判为"同步成功"，直到服务端仍加载旧文件才追出来）。所幸**静态审计（场景 00 "打包配置声明了解包规则"）当场报警**，
构建产物（`dist:fresh` 成功 + asarUnpack 生效）不受影响。已从上一提交恢复（39 个脚本、`asarUnpack: ["app/**/*.ps1"]`）并
重新打包实装；教训写在这里：**npm 脚本跑不动时要看输出，不能只看退出码靠 `>/dev/null` 掩盖**。

## 十、最终结果

**全量验收**（`node scripts/acceptance/run.cjs --app=dev --label=2.2.12-final`，54 个场景）：

```
结论：51 通过 / 2 失败 / 1 不适用 → REJECT（1 个是既有红，1 个是整轮抖动）
```

逐条分类（每条都有对照证据）：

| 场景 | 结论 | 证据 |
| --- | --- | --- |
| `100-ime-softbreak-caret-2.1.29` | **整轮抖动** | 同一份代码**单跑通过 21/21**；前两轮全量里也是绿的（像素证人受会话状态影响） |
| `90-math-command-family-2.1.17` | **既有红**（非本轮引入） | 在实装 2.2.11 上同样红、读数逐字相同 `{"第二条":null,"源码":null}`。诊断：⑤ 在补全面板还开着时直接改写源码文本，随后的输入落不进公式、节点也收起来；本轮加了一条前置断言（Esc 收面板 + 确认展开态，现已 13/14），⑤ 本身仍需单独收拾 |

**新场景在本轮全量里全部通过**：111（状态×手势矩阵 7/7）、112（兜底分支+台账 8/8）、113（长会话扫描 6/6）、
114（回归钉 9/9）、115（两等号后加粗 5/5）；受影响的 83（10/10）、92（44/44）、101（32/32）、107（15/15）
也都在本轮全量里绿。

**Electron 套件**：`test:math`、`test:math-history`、`test:renderer`（regression/consistency/features/repairs/ui/shell/nav-guard）
全部 exit 0；`test:math-caret` 1 条红（"在尾 `$$` 上按退格不能改动文档"）——把 `app/renderer` 换回 HEAD（2.2.11）
复跑**同样红** → 既有问题。
