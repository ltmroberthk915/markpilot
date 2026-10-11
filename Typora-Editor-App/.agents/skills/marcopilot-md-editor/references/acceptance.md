# 全量验收基础设施（怎么跑、证据在哪）

## 1. 任务执行器

`node scripts/run-release100-task.mjs <task>`（App 仓），关键环境变量：

- `RELEASE100_ROOT`：本轮验收根目录（如 `.perf/release100-final-201`），每任务一个 `<task>-<时间戳>` 子目录 + `.launch.log`。
- `ARCHIVE`：桌面任务指向的 app.asar（如 `dist/release-2.0.1-private/win-unpacked/resources/app.asar`）。
- `EXTENSION`：IDE 任务指向的**已抽取 VSIX** 目录（如 `test/.runs/vsix-private-2.0.1/extension`，注意这是 App 仓 test 下）。
- trae 任务使用内置的已过初次配置 profile 副本，不新拉实例。
- GUI 锁：`.perf/release100-gui-active.json`——**一次只跑一个 GUI 任务，零并行负载**。

驱动模式：写一个顺序执行的 shell 驱动（参考 `.perf/run-final-201.sh` / `run-final-201-rest.sh`）：逐任务调用、单任务 900s 超时、遇 FAIL 即停。34 项续跑驱动 FAIL=0 + vscode-full + trae-full + vscode-focus + trae-focus = 36 项全绿。

## 2. 冒烟断言模式（vscode-smoke.cjs 内的既有工具，直接复用）

真实 workbench DOM 断言（不是命令桥）：

```js
// inWorkbench：拿 workbench 侧栏真实树行文本
const ui=await inWorkbench(`()=>{const sb=document.querySelector('.monaco-workbench .part.sidebar');
  if(!sb)return null;
  return{rows:[...sb.querySelectorAll('.monaco-list-row')].map(r=>((r.querySelector('.monaco-tl-contents')||r).textContent||'').trim())}}`);
// 断言 rows 覆盖预期标题文本

// 真实行坐标（点击目标一律这样拿，别从截图猜）
const t=await inWorkbench(`()=>{...getBoundingClientRect()...}`);

// 多上下文读取：遍历全部 debugContexts，取时间戳最大值为基线（anyReveal 模式）
// 双击序列：mouseMoved → click(1) → 第二对 mousePressed/Released 带 clickCount:2
```

桌面侧关键套件：
- `scripts/desktop-completion.cjs`：补全几何（28 项，含"锚点滚出视口时弹窗不得停在工具栏、滚回后回画布"用例）。
- `test/math-table-suite.cjs`（扩展仓）：嵌套公式/表格——**弹窗几何改动的守门用例**。
- 弹窗/几何类改动后必跑：嵌套公式 + 表格 + 补全三套。

## 3. 证据文件索引（交付时按表取数，别现场猜）

| 证据 | 路径（App 仓） | 判定字段 |
|---|---|---|
| 后台 Node 套件 | `.perf/release100-background-features/results.json` | **`testExitCode===0`**（没有 pass/total 汇总字段；`tests[]` 是 path/sha256 文件清单） |
| live-AI | `.perf/release100-live-ai-<tag>/results.json` | `passed===true`；glm/glm-flash 侧 auth 排除属正常 |
| 一致性校验 | `.perf/release100-verify-<tag>/coherence.json` | `verified===true`、`version` |
| 覆盖率 | `node scripts/release100-coverage.cjs`（stdout） | `ready===64 && missingTasks==[]` |
| 任务产物 | `.perf/release100-final-*/<task>-<ts>/` + `.launch.log` | 各任务输出 PASS/FAIL |
| 交付报告 | `docs/RELEASE100-FEATURES-<日期>.md` | 每版一节 |

## 4. 固化命令（显式传全参，勿依赖默认值）

```bash
# 一致性校验（3 个参数都必须显式传；默认值指向 1.0.0 会误报）
node scripts/verify-release100-private.cjs \
  dist/release-<ver>-private \
  dist/release-<ver>-private/marcopilot-<ver>.vsix \
  .perf/release100-verify-<tag>
# 断言内容：版本一致；桌面源码 = app.asar = VSIX 三方逐文件哈希；VSIX 清单版本。

# live-AI（key 只经环境变量；产物零泄漏自检）
LIVE_AI_KEY=*** node scripts/release100-live-ai.cjs .perf/release100-live-ai-<tag>

# 覆盖率（扫描 .perf/release100-source + .perf/release100-final 两根，按 startedAt 取每任务最新通过）
node scripts/release100-coverage.cjs

# 产物哈希自检
cd dist/release-<ver>-private && sha256sum -c SHA256SUMS.txt
```

## 5. 验收顺序建议（最小化重跑浪费）

1. 先批量跑全部**无 GUI** 校验：后台 Node、verify、coverage、live-AI。
2. 再串行跑 GUI 任务（一个锁、零并行负载、抖动复跑单独跑）。
3. 全绿后才进入打包/交付（见 release.md）。
4. 抖动处理：先对照已知抖动类（profile UI 等待、Trae 遥测、SV undo 时序）；复跑通过 → 报告披露；复跑仍挂 → 按真缺陷排查。

## 6. 崩溃/交接恢复流程

1. `sha256sum` 对账三处 completion.js（App 仓 `app/renderer/js/`、extension-src `render/js/`、VSIX 提取目录）+ verify 三方断言拉齐 app.asar。
2. 读 `.perf/release100-final-*/` 各任务目录时间戳，确认哪些任务在最新产物上跑过。
3. `sha256sum -c SHA256SUMS.txt` 确认产物未被重建过。
4. 对齐后才能引用摘要里的"已验收"结论。

## 7. 交互/光标类验收的**默认风格**：随机起点 × 全篇行走（2026-09-18 起强制）

### 为什么改（用户当面的问题："为什么我让你测全量、随机，你就能抓到，你自己测不出来"）

2.2.2 交出去之后，用户一句"上下键左右位置稳定性和逐行性还是失败"直接否掉了我们那套手动夹具。
复盘原因不是"测得少"，而是**测的形状是我自己挑的**：

- 我写的场景（109/110）里，夹具是**照着我的假设**造的（"纯公式行夹在两段之间"这种干净形状），
  断言也是**照着我的实现**写的（"光标进公式源码"）。假设对不上真实文档的地方，夹具根本走不到。
- 真实文档里全是我没造的东西：标题行、`**加粗**` 领起的行、折行的长段落、空公式块、
  行内公式夹在行首/行中/行尾、块公式源码多行——**每一类都可能让"我假设的几何"失效**。
- 更要命的是**判据层级**：我断言的是"机制"（光标进源码），用户感受到的是"属性"
  （光标看得见、一次走一行、列不跑）。机制对了、属性错了，我的绿灯毫无价值。

所以规则改成两条，缺一不算完成：

1. **形状必须来自真实材料的副本**（`--file=<副本>`，原件只读），不能只有我手写的夹具；
2. **判据必须能用用户的话说出来**，并且在**随机起点**下全篇成立：
   · 可见性：每一步光标都要有可见矩形（0×0 就是用户说的"光标没了"）；
   · 逐行性：从顶走到底、再走回顶，双向都要真在动，按键次数与可见行数对得上；
   · 列稳定性：落点 x 与目标列之差 ≤ 该行字号（CJK 只能停字符边界），或贴在该行行首/行尾
     （短行、空行的自然钳制）。

### 怎么做（照抄即可）

```bash
# 全篇随机行走（任何文档都能跑；副本自动生成、原件只读）
node scripts/acceptance/probe-vertical-real.cjs --walks=6 --seed=31337
node scripts/acceptance/probe-vertical-real.cjs --file="<任意 .md 的绝对路径>" --walks=8 --seed=7
```

- **种子固定**：同一 seed 的起点可复现；报告里必须带上 seed。
- **偏离样例必须带"起点+目标列+实际落点"**，这样下一次能定点复现（`--seed` 之外的坐标也能手工 `seek`）。
- 探针自己的记账要**只看可见读数**（隐形读数 y=0，会把"还能不能继续走"判错——2026-09-18 就因此
  把"上移失灵"误报了整整一轮）。

### 与既有场景的关系（加法，不替代）

- 场景（74/75/109/110/…）继续保留：它们钉的是**确定性契约**（围栏口径、空公式、拖拽选中）。
- 随机行走是**发现器**：先跑它找出形状 → 再把新形状写成确定性场景（这一步不能省，
  否则下次回归还是要靠随机撞）。
- 每发现一类新形状，就回写一条场景 + 一句"用户会怎么说"的断言标题。

## 8. 视觉检验 + 真人拟真操作（2026-09-18 起强制，用户令）

§7 管"测什么形状"，本节管"**怎么判、用什么手脚操作、看图看什么**"。交互类的完成定义 = 下面四件同时成立。

### 8.1 视觉检验（截图为准，且必须真的看图）

- **结论必须看图**：光标位置、选中高亮，要能在图上直接看清；数值只是辅助，单独的数字不算通过。
- **CDP 抓帧拍不到原生光标**（Blink 的 caret 画在合成层；实测折叠光标在截图里完全不出现）；**选中高亮是原生绘制，拍得到**。所以：
  - 光标用**标记**画出来——`position:fixed` + 视口坐标（fixed 的包含块就是视口，滚动/body 边距都不掺进来，实测校准图里与选中高亮起点逐像素对齐）；
  - 红实线＝光标落点，琥珀虚线＝目标列（贯穿画面），青虚线＝这一行应有的列；
  - **光标真隐形（0×0）时标记也画不出来**——这正是"光标没了"的视觉证据，别把"没标记"当探针坏了。
- 截图规格：**2 倍放大、局部**（高 ~200px）截在光标所在行附近；整幅图只交代上下文。
- clip 坐标是**顶层视口坐标**：`clip.x = iframe 视口 x + 帧内列 − 8`、`clip.y = iframe 视口 y + 光标帧内 y − 60`；实测缩放后光标线落在 `(光标y − clip.y) × scale` 处（通道自检见 `probe-caret-shot.cjs`）。
- 每张图配一行 manifest（`visual-manifest.json`：期望列/实际列/偏差/层/文本/三拍），看图与数字对不上时**先查尺子**。

### 8.2 真人拟真操作（五通道，全部真实输入）

| 通道 | 怎么做（真实输入） | 判什么 |
|---|---|---|
| 键盘 | `Input.dispatchKeyEvent`（方向键、Home/End、回车、退格、Ctrl+Z） | 逐行、列稳定、光标不消失、撤销还原 |
| 鼠标 | `Input.dispatchMouseEvent` 单击/双击(clickCount:2)/三击(3) | 落点行列对得上、双击选词、三击选段、单击不选中 |
| 组合键 | 同上 + `modifiers`（Shift=8 / Ctrl=2） | Shift+方向键选区非空且单调、Ctrl+Home/End 边界 |
| 键鼠配合 | 点一下 → `click(..., {modifiers: 8})`；拖完 → Shift+方向键 | 选区从锚点到点击处、拖后还能续选/收缩 |
| 拖拽 | `mousePressed` → 多次 `mouseMoved(buttons:1)` → `mouseReleased` | 选区非空、起终点与按下/抬起位置对得上、跨块公式整块并入选区 |

- **按键读数前先断言焦点**：`帧document.hasFocus() && activeElement.closest('.vditor-ir')`。实测焦点不在编辑器时按 ↓ 光标照样动、却没有任何 keydown 进 iframe（窗口捕获监听计数 0）——此时整轮读数都是假的（曾把一轮 V4 全判成缺陷）。
- 起点/目标列用**固定种子随机**，偏离样例必须带"起点 + 目标列 + 实际列 + 该行可落范围 + 决策轨迹"，下一轮能定点复跑。
- 素材用真实文档**副本**（`新建 Markdown 文档-副本.md`、`1-重识概率论.md`），原件只读。

### 8.3 判据口径（以 Typora 习惯为准）

- 逐行：两次落点之间**不许还有能落光标的行**（段落间距造成的 y 间隔不算跳行）。
- 列稳定：目标列在该行可落范围内 → 落在**离目标列最近的可用位置**（差 ≤ 一个字宽）；超出范围 → 钳到最近的可用位置；**不许钳到行首**。
- 往返：到底了再往回走，必须回到原来的列（边界分支不能丢目标列）。
- 光标到顶/到底：**不许消失**。
- 围栏符按普通字符：退格删一个字符、方向键能进出、拖拽能选中；块公式整块并入选区。

### 8.4 已知测量陷阱（踩过，别再踩）

1. **`caretRangeFromPoint` 的候选要按 y 盖住过滤**：按多个 x 探测、再挑"离目标列最近"时，可能挑中**相邻行**的位置（实测：目标列 569 时挑中 876@顶340，于是把本该落的 366 行整行跳过）。正确顺序是先取"矩形真的盖住 y"的候选，都没有才退回最近的。
2. **一行能放光标的范围会随光标在不在这一行而变**：光标进标题行 → Vditor 显示标题标记 → 整行右移（实测同一行 y=125：不在时行尾 x=200，进来后 x=242）。所以"下一拍重算"要按**原始目标列**在新布局里取最近可用位置。
3. **探索性扫描（探针侧）也要按行顶过滤**：同一 y 带里可能叠着上一行的尾巴（实测块公式源码行 y=683 扫到顶 679 的命中），不按行顶过滤会量出"左缘 866 / 右缘 897"这种自相矛盾的行范围。
4. **折叠态公式源码没有矩形**：`display:none` 的源码 rect 是 0×0，按"可见"筛会把整行丢掉（探针和产品补丁都要按"公式节点的盒子"兜底）。
5. **看不见的读数不吃账**：隐形读数（y=0、高 0）不能当作"锚点"参与"还能不能继续走"的判断——2026-09-18 因此把"上移失灵"误报了一整轮。
