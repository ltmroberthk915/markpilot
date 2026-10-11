---
name: marcopilot-md-editor
description: marcopilot(Typora) Markdown 编辑器开发与发布必读：双仓架构、Vditor 渲染层承重墙事实、Trae/VS Code 差异、GUI 验收铁律、性能实验纪律、打包发布流程、踩坑与绕弯路对照。只要在 E:\MarkPilot\Typora-Editor-App 或 E:\MarkPilot\Typora-Editor 上工作——改渲染层/补全候选框/大纲/公式/导出、跑测试与验收、打 EXE/VSIX 包、发版交付、做大文档性能实验——先读本 skill。用户提到"编辑器、补全、候选框、大纲、公式、VSIX、EXE、打包、验收、发版、性能、内存、滚动、Trae 里不显示"等任意相关词同样触发。
---

# marcopilot Markdown 编辑器开发（私有项目，勿外传）

## 0. 项目地图（先建立坐标）

| 位置 | 角色 |
|---|---|
| `E:\MarkPilot\Typora-Editor\extension-src\render` | **共享渲染代码的唯一事实源**（本机 `E:\MarkPilot` 相当于旧机 `D:\BuyKey`）。 |
| `E:\MarkPilot\Typora-Editor-App` | Electron 桌面版（EXE）。`app/renderer/` 是事实源的只读同步副本（490 文件），永不手改。 |
| `E:\MarkPilot\Typora-Editor\pack.py` | VSIX 打包（`python pack.py` 私有版；`--public` 公开版不带私有 API）。Python 用 `D:/Users/ltmroberthk/anaconda3/python.exe`（不在 Git Bash PATH）。 |
| `E:\MarkPilot\Typora-Editor\test\vscode-smoke.cjs` | IDE 冒烟测试（真实 DOM 断言模式都在这）。 |
| `E:\MarkPilot\Typora-Editor-App\docs\RELEASE100-FEATURES-*.md` | 交付报告（每次发版追加一节）。 |
| `E:\MarkPilot\测试素材_每次使用需复制用后需删除试验副本\` | 受保护测试素材（用户令）：**任何测试/检查先复制副本，用完删副本，原素材只读禁止改动**。 |

关键命令（都在 App 仓根执行）：
- `npm run sync` → 共享渲染文件 **extension-src/render → app/renderer**（改渲染代码只改 extension-src，再 sync；**旧版 skill 曾把方向写反**，以 scripts/sync-renderer.mjs 的实际行为为准；2026-09-10 核对：490 个文件，两仓同路径文件哈希一致）
- `npm run dist` → electron-builder `--win nsis portable`，产物直接落 `dist/markpilot-Setup-<版本>.exe` + `dist/markpilot-v<版本>-portable.exe`
- `npm run test:completion` / `test:math` / 各 `run-electron-test.mjs <suite>` → 桌面针对性套件
- `npm run bench:renderer` → 官方性能基准（打开/四阶段输入/公式完成/点击/滚动/空闲 CPU，产物 `.perf/optimized.json`）

## 1. 承重墙事实（改代码前必读，违反 = 白干一轮测试）

- **Vditor IR 模式的滚动容器**：`editor.ir.element` 就是 `pre.vditor-reset`——它**既是滚动器又是 contenteditable**。DOM 里同时存在多个 `.vditor-reset`（隐藏的 wysiwyg/sv 副本），裸 `document.querySelector('.vditor-reset')` 必中隐藏副本。滚动一律用模式根 `element.scrollTop`，并且**动作后断言 scrollTop 真的变了**。
- **补全弹窗不能插进文本层**：滚动器是 contenteditable，插进去的节点会被 Vditor 的 DOM→Markdown 序列化吞掉。正确分层是：弹窗 fixed 定位、夹在「画布∩视口」内；锚点光标滚出视口时弹窗随锚点离屏（上下对称）；`.vditor-toolbar{z-index:1001}` 永远压住弹窗（z-index 1000）。
- **completion.js `position()` 的历史翻转语义是承重墙**：嵌套公式用例依赖"弹窗优先开在宽裕侧"避免盖住公式点击点（360px 弹窗盖住公式 + 按钮吞点击曾连续击毙 3 个重写方案）。改几何只做加法（硬边界/离屏分支），不要重写。
- **Trae（字节 VS Code 分叉）不渲染 `views.explorer` 里的树视图贡献**——VS Code 正常、Trae 静默不显示。大纲用自定义活动栏容器 `viewsContainers.activitybar`（键名必须拼 `viewsContainers`；拼成 `viewContainers` 会被静默忽略并回退 Explorer）。
- **SV（源码）面板是 contenteditable 高亮结构**：按换行数定位不可靠，reveal 按标题文本锚定光标。
- **VSIX 不含状态栏文件/大纲按钮**（EXE 专有功能）；分叉 IDE 行为差异必须拿目标 IDE 本身实测，不能拿 VS Code 外推。
- **大文档性能架构（1.0.1 起）**：公式协作调度（4ms 切片/64 个合批提交/输入让路 180ms/IME 全停/视口二分优先，math-scheduler.js）+ 块级源码缓存与增量 Markdown 转换（Lute 分隔符校准，incremental-ir.js）。**保完整 DOM 是设计前提**——任何"砍 DOM 提性能"的方案必须先过编辑/撤销/序列化三关。

## 2. 标准工作流（修复 → 验收 → 发布）

1. 改渲染代码：只改 `extension-src/render` → App 仓 `npm run sync` → 抽查两仓同路径文件哈希一致。
2. 跑针对性套件：桌面 `run-electron-test.mjs` 系列 / `npm run test:completion`；IDE 改动跑 vscode-smoke；**动过弹窗几何必跑嵌套公式套件（守门用例）**。
3. 全量验收：**按 `references/test-protocol.md` 的六层范围与次序框架执行**（定向冒烟 → 静态+后台批量 → 渲染器层 → 真实宿主层 → IDE 层 → 打包后产物树终验），GUI 锁串行、零并行负载。
4. 发布（细节见 `references/release.md`）：版本第三位递增 → **EXE 与 VSIX 必须同版本同步产出**（`npm run dist` 或撞锁时 `npm run dist:fresh` + `python pack.py`，见铁律 11）→ verify（三方/四方哈希链）→ SHA256SUMS → 报告追加 → 交付信息（绝对路径 + 哈希 + 安装指引）。

## 3. 验收铁律（每一条都是学费换的）

1. **断言必须触达真实渲染 DOM + 真实输入事件**。只验证命令通路的"验收"是误报——本项目出过一次，用户拿着截图追责，事后一切验收都要补真实 DOM 税。
2. **测试动作自证生效**：滚动后断言 scrollTop 变化、点击后断言选中态变化，否则后续断言全是在验证噪声。
3. **GUI 验收期间零并行负载**：一次并行的后台 Node 套件就毁掉一次 CDP 合成输入（打字丢字）。一次只跑一个 GUI 任务，全部无 GUI 校验批量先跑完。
4. **抖动（复跑即过）可接受，但必须写进报告披露**，不能静默吞掉。已知抖动类：profile UI 2.5s 等待、Trae 遥测噪声（volo/icube）叠加 `visible:[]`、SV undo 时序。
5. **交付前重建哈希链**：桌面源码 = app.asar = VSIX 三方逐文件一致（verify 脚本断言）。叙述、摘要、记忆都不算数。
6. **崩溃/交接恢复第一步是哈希对账**，不是接着做摘要里说的"下一步"——摘要天然滞后于最后一次编辑，本会话实际出现过摘要与磁盘不符。
7. **【硬规则·用户令】截图自动化取代人工盯守——机器自己当眼睛**：在适当的时机自动截图并**自动比对**：基线帧（操作前原始状态）→ 每执行一次操作一帧（事件驱动，不按时间采样）→ 收尾最终确认帧；用帧差分（字节级变化检测）+ 与帧同步的 DOM 几何断言回答"是否真解决"，**不把验证责任推给用户盯测试窗口**；探针对准用户指认的可见现象；首次复现走真人操作流（真截屏→Ctrl+V→调缩放）；没有关键帧比对通过不得宣称成功；确需人工裁决的视觉项（美感/手感）收尾时一次性打包关键帧请用户看，不做过程性占用；用户内容截图立即删除不入档。
8. **【用户介入复盘】真实环境与探针纪律**："仅用户可复现"的 bug 第一时间用打包 EXE+用户 profile 副本+固定端口复现（fresh-profile 测试对状态依赖的启动失败是系统性盲区，dev 全绿+用户全白曾同时成立）；用户症状差分先做假设排除再动手（"连工具栏都没有"⇒初始化链而非内容层）；用户首报主动提取"截图+精确属性+文件路径"三元组建等价样例，"A 有效/B 无效/C 能恢复"直接映射实现层逐项核对；用户屏幕所见（含弹窗/报错框）当我的工具行为日志读——但目标是让这类事件被自动截图/自动日志捕获，用户无需在场；动用户文件前 md5 备份+attrib +R 只读，全程哈希对账；探针 windowsHide+finally 杀进程+确认退场（dev 入口是 app/main/main.js，不是 app 目录）；打包主进程无 unhandledRejection 兜底，复现第一轮带 --enable-logging=stderr；宣布"数据丢失"前先算输入构成（15K 散文+145K 图属正常）；**别拿"磁盘原文"和编辑器取值比整串**——内嵌 base64 图片的素材上这两个数天然差一个载荷长度（`富文本测试-重识概率论.md`：160,220 字符里一张 PNG 的 data URI 就占 145,152 字符，`getValue()`/宿主 `doc.text` 会按媒体生命周期规范化成资源引用，磁盘保留 base64）。正确断言是"媒体载荷 md5 集合相等 + 把 data URI 规范化掉之后磁盘 == 源文件+本次编辑"（`desktop-user-file.cjs` 已按此改写，套件由红转绿）。
9. **【用户令】轮末清场**：一轮结束必须清理测试临时产物——合成大图/base64 草稿、探针中间文件、一次性 profile（`.perf/user-data-*`）、解压的 VSIX 目录等；只留交付物、报告引用的证据键帧、可复用的测量脚本与固定 fixture（.backups 用户笔记）。防存储垃圾累积（曾清出 dist 24G / test/.runs 54G / .perf 8.7G）。
10. **【用户令·2026-09-10】性能改进的量化纪律**：性能/负载的改进必须以量化、定量检查、截图、测量、探针等方式得到**一致结论**后才能确认；**内存类异常没研究清楚、没有改善方案之前不许落盘**。方法门槛（均为实测学费）：
    - 前后对照必须**交错 A/B（A/B/A/B）**或等价单变量控制，时间漂移会伪造趋势；
    - `JSHeapUsedSize` 不带强制 GC 就是"垃圾在途水位"，**不能用于内存归因**（曾把 Vditor 输入管线垃圾误记为 content-visibility +420MB，险些错杀最优方案；单次输入即 +40MB 未回收）；归因必须 `--js-flags=--expose-gc` + `gc()` 前后双采；
    - Blink 布局/绘制内存只在**渲染进程 privateBytes**（`app.getAppMetrics()`，注意 Electron 44 无 `webContents.getProcessMemoryInfo`、无 `win.isOccluded`）可见，JS 堆看不见；
    - 被前台窗口遮挡时 rAF 会停在 ~116 帧不动（文档仍 visible）：探针加 `disable-backgrounding-occluded-windows` + 看门狗 setTimeout 兜底收帧。

11. **【用户令·2026-09-10】EXE 与 VSIX 同步产出（不许只发一边）**：一次发布必须**同版本号**同时产出桌面 EXE（`npm run dist`，nsis + portable）与 VSIX（`python pack.py`，自用线 `markpilot-<版本>.vsix`），并各自跑对应的产物层验收（EXE → 已安装实例；VSIX → `test/vscode-smoke.cjs <Code.exe> <抽取目录>` 隔离 profile 真宿主）。判"通过"的最小哈希链是**四方**：`extension-src/render` == `app/renderer` == 已安装 `app.asar` 里的 `app/renderer` == VSIX 内 `extension/render`，且两仓 `package.json` 版本一致、`vsix-meta/extension.vsixmanifest` 的 `Identity Version` 与之相同（`pack.py` 每次打包会自动同步该字段）。**任何一侧缺失或版本不一致 = 本轮不算交付**（2.0.10 就是只发了 EXE 的反例，2.0.11 补上）。
    - 本机 VS Code 在 `D:\Users\ltmroberthk\AppData\Local\Programs\Microsoft VS Code\Code.exe`（镜像安装布局，C 盘标准路径不存在；**本机没有 Trae**）。
    - VSIX 抽取用 `python -c` 的 `zipfile` 或 `node` 的 unzip 到 `test/.runs/vsix-markpilot-<版本>/`，与 `extension-src` 逐文件比对后再交给 vscode-smoke。

12. **【2026-09-11】内存归因只能用"冷加载对照"，不能就地增删 DOM**：把已渲染的 224,561 个节点全部换成源文本后，渲染进程 `privateBytes` 从 1,048MB 变成 1,080MB（**不降**）——Chromium 分配器把池留在进程里不还给系统。所以"就地释放"测不出任何收益，正确做法是**两次全新加载**的单变量对照（有公式 vs 无公式：1,131MB vs 591MB，四次交错可复现）。同理，任何"先渲染后优化"的方案都必须用冷加载测收益，否则会得出"没效果"的错误结论。

13. **【2026-09-11】fixture 换过之后，硬编码的期望值就是假失败**：`math-boundaries` 断言"修复版教材 2,844 个公式全部渲染"，而 `.perf/dynamic-planning/repaired.md` 早已被换成 5,634 公式的教材（与 `.testws/教材合订本.md` 逐字节相同），于是它长期在断言一个与被测对象无关的常量，失败原因看起来像渲染回归。**断言期望值必须从被测文件自身推导**（数分隔符），环境变量只作显式覆盖。判"失败是不是我造成的"第一步是核对断言的两侧分别来自哪里。

14. **【2026-09-11】对手产品的对照必须三件事齐备，否则数字是错的**：① **开跑前清干净同名残留进程**（单实例锁会让新进程立刻退出，脚本就会去量那个残留实例——曾把 4 个残留 Typora 进程的 7.45s CPU 当成"新启动 370ms 就 7.45s"）；② **强制前台**（被遮挡的窗口 rAF 被节流、屏幕采样采到的是覆盖它的窗口）；③ **统一窗口几何**（窗口大的那个每屏内容更多、渲染更多，"同一滚动/输入负载"就不再同一，本轮 Typora 800×700 vs 我 1,280×800 就是这个坑，如实标注未对齐）。外部测量的可比项是 CPU 秒数与进程树内存；**帧级/输入级延迟只有能注入脚本的一侧才有**。

15. **【2026-09-11】首屏慢的归因必须先把"打开"拆成相位，不许停在"框架决定的"**：上一轮把 5.2s 首屏归因为"Lute 必须整篇解析（3.7s）"——**错的**。实测（34.8 万字符/531KB 素材）：整篇 Lute `Md2VditorIRDOM` 只占 **~560ms**，浏览器插入 2,839,661 字符的 IR DOM 只用 **37ms**，而 ~3.0s 全是我们自己在同一个长任务里的预热与几何量取（Markdown 缓存首建 855ms、大纲几何 329ms + 我们派发 resize 触发 Vditor 的 `K` 全量重排 1017ms、阅读面一次 `getBoundingClientRect` 169ms、CV 启用 103ms）。
    判据（两个数就够定性）：`longtask` 只有一大段、且那次 `innerHTML` 赋值耗时极小 ⇒ 慢既不在解析也不在插入，而在**插入之后我们自己的同步工作**。口径是 `scripts/ir-perf-probe.cjs`（相位 + FCP + longtask + 资源 + 预热分片逐任务耗时）+ `scripts/profile-report.cjs --tree`（真调用树，用来分清"我们调 Vditor"与"Vditor 调我们"）。
16. **【2026-09-11】"写样式 → 读几何"每交错一次就是一次整篇重排**：大文档上样式脏时单次 `clientWidth`/`getBoundingClientRect` 读是 **~170ms 级**全量重排；`outline-layout.js` 原先读-写交错四次，500ms 级就这么没了。几何函数必须**先读全部、再写全部**（与 `large-doc.js` 的两趟纪律同源）。首屏之前任何"不是首屏必需"的几何量取都应搬到首屏之后（`js/warmup.js`）。
17. **【2026-09-11】搬走工作必须自带同步降级开关，才谈得上单变量对照**：本轮给预热队列留了 `localStorage.warmup='off'`（就地同步执行 = 改动前行为），于是"搬走预热值多少"能在**同一份产物、同一素材、同一探针**上交错两臂量出来（FCP 3828→2732ms，长任务 3107→1965ms），不必跨构建比（跨构建会把别的改动混进来）。同类开关：`mathWindow`、`mathQueue`、`CV_PROBE_RENDERER`。
18. **【2026-09-11】判"这个红是不是我造成的"要用全量回滚树复现**：`nested-math` 的 `wysiwyg-link-table` 用例断言"点击一个公式只展开它自己的源码"，实测 `[]`。我们按顺序做了四种单变量回滚（同步预热 / 回滚 bundle 补丁 / 回滚惰性快照 / 回滚上一轮的 math-scheduler），**再把 6 个改动文件 + bundle 全部还原到 HEAD 后该用例照样红** ⇒ 结论是历史回归，与本轮无关。先例：任何"疑似本轮引入"的红，回滚全树跑一次是成本最低的判决。
19. **【2026-09-11】首次排版能前置就前置：CV 必须在"插入后的第一次排版"之前生效**：打开长任务里最大的一段是 Chromium 对整篇的第一次排版（实测 ~1.0s，由 Vditor 的 `K` 读 `clientWidth` 触发），它在画出来之前完成，**只能靠"别让它排整篇"来砍**。做法：按内容长度预判大文档（`index.js`，≥20 万字符 ≈ 1500 顶层块）→ 构造 Vditor 之前给 `documentElement` 加 `typora-cv-pre` → `css/large-doc.css` 让顶层块一插进来就带 `content-visibility:auto; contain-intrinsic-size:auto 320px` → 首屏之后由 `large-doc.js` **先摘类再量真实高度**（不摘就是量估算值）→ 写回逐块高度 + 总量校准。同产物 A/B：FCP 2732→1892ms、首屏就绪 3239→1952ms、长任务 1975→1449ms。开关 `localStorage.cvFirst='off'`。
20. **【2026-09-11】静止内存水位由打开峰值决定——所以降峰值就是降内存**：同一探针同产物 A/B（`cvFirst` on/off）：渲染进程 **620→555MB（−10.5%）**、进程树 **880→773MB（−12%）**，而这次改动只动了"第一次排版排多少"。归因普查（`.perf/mem-census.cjs`）：静止 592MB 时 **KaTeX 树只有 65 棵**——窗口化已经把公式渲染成本挡在视口外；48,673 个节点里 **63% 是公式的源码脚手架**（`$` marker 19,547 + preview 5,645 + `<code>` 5,668）。想再往下只能虚拟化**编辑面** DOM，那会动序列化/撤销/IME 的正确性前提，**不做**。
21. **【2026-09-11】位置还原只记像素值在含图片的文档里必然落偏**：重开时图片还没占位、内容更矮，一次 `scrollTo` 被 `scrollHeight−clientHeight` 夹住，图片加载把内容撑高之后视口停在偏上处（偏差与还原点上方图片总高同阶，实测 legacy 偏差 145px）。正确做法：**块锚点**（顶部块序号 + 块内偏移 + 块开头 24 字，序号漂移就按文本头找回）+ **持续重贴**（图片 load / `fonts.ready` / 公式队列清空 / 根 ResizeObserver），直到"高度稳定 400ms 且锚点贴准"或 6s 兜底；**任何不是自己造成的滚动都要立刻停手**（读者滚轮/点击/输入、大纲跳转、查找、分屏同步），并且 `pagehide/beforeunload/hidden` 要立刻补发（否则 iframe 换掉时防抖里那 200ms 白丢）。实测 anchor 1px vs legacy 145px，含"一张图 404"的高度变化场景同样 1px。开关 `localStorage.scrollRestore='pixel'|'legacy'`（后者=改动前行为，探针 A/B 用）。
22. **【2026-09-11】多图剪贴板只有 CF_HDROP 一条路**：一次放多张图，必须写**文件拖放列表**——微信/资源管理器/Chrome 系网页（DeepSeek 这类 AI 网页）读的都是它，浏览器把 CF_HDROP 映射成 `paste` 事件的 `files`（实测粘贴进真实页面 `clipboardData.files.length===3`）。一个 DataObject 只能带一个 CF_DIB，所以"只认位图的目标"要靠**拼接成一张图**的回退。产品实现：渲染层 Ctrl+单击收集 + 接管 Ctrl+C（正文选文字不能被抢）→ 主进程把每张图解析成**真实路径**（内嵌/http 来源先落图片缓存）→ `media-clipboard.ps1` 的 `copy-images` 写 FileDrop + 拼接位图。
23. **【2026-09-11】`.ps1` 必须纯 ASCII**：PowerShell 5.1 用**活动 ANSI 代码页**解码无 BOM 脚本，中文字节会被解错甚至解出引号，解析器直接报 `MissingEndParenthesisInMethodCall`（实测）。剪贴板里的文本要经**文件**传递，绝不拼进 `-Command` 命令行（用户剪贴板里正好是一段带引号的中文时同样会炸）。
24. **【2026-09-11】探针里"按键送不到"先查窗口是否真在前台**：`show:false`/`showInactive()` 的窗口里 `sendInputEvent` 的 keyDown 会被**静默丢弃**（char 事件却能到）。Windows 对后台进程的激活请求是滞后的，所以探针要 `show:true` + 循环 `win.isFocused()` 等它真正成为前台，并给按键加"送达自证"（铁律 2）：先合成一个 keydown 确认监听生效，再发真实按键。
25. **【2026-09-11】给 `vm` 加载的渲染层模块加 import 会把整套用例静默变红**（见 §6 第一条）；同理，模块内 `const performance = {...}` 会遮蔽全局 `performance`（`incremental-ir.js` 末尾就有一个），要写 `globalThis.performance.now()`。

26. **【用户令·2026-09-18】交互验收必须"看图说话"——视觉检验是最后一道闸**：交互/光标/选区类改动，"完成"= 有截图证据**且我真的把图打开看过**（数值读数只作辅助，不能单独宣布通过）。
    - CDP 抓帧**画不出原生光标**（Blink 的 caret 在合成层；实测折叠光标在 `Page.captureScreenshot` 里完全不出现），选中高亮是原生绘制、直接拍得到。验收图里按浏览器自报的光标矩形画标记：**红实线＝光标落点、琥珀虚线＝目标列**（`position:fixed` + 视口坐标，滚动与 body 边距都不掺进来）；光标真隐形（0×0）时标记也画不出来——那本身就是"光标没了"的视觉证据。
    - 截图取**局部 2 倍放大**、截在光标所在行附近；clip 用**顶层视口坐标**：`clip.y = iframe 的视口 y + 光标视口 y − 60`，实测缩放后光标线正好落在 `(光标y − clip.y) × scale` 处。整幅图只用来看上下文。
    - 通道：`node scripts/acceptance/probe-real-ops.cjs --doc=a|b --section=visual`（每张图带 manifest：期望列/实际列/层/文本/三拍）、`node scripts/acceptance/probe-caret-shot.cjs`（通道自检 + 标记校准）。看图与数字对不上时先查尺子，别急着改产品。
27. **【用户令·2026-09-18】真人拟真操作五通道 + Typora 习惯 + 交互逻辑，是验收口径的一部分**：
    - 五通道全测：**键盘 / 鼠标 / 组合键 / 键鼠配合（点一下再 Shift+点、拖完再 Shift+方向键）/ 拖拽（按下→多次移动→抬起）**；输入一律走真实通道（`Input.dispatchKeyEvent`、`dispatchMouseEvent`、`insertText`），不许用 JS 造 DOM 事件代替。
    - **按键类读数前必须断言焦点在编辑器 iframe 里**（`帧document.hasFocus() && activeElement.closest('.vditor-ir')`）：实测焦点不在编辑器时按 ↓ 光标照样动、却没有任何 keydown 进 iframe（窗口捕获监听计数 0），此时整轮读数都是假的。
    - **列稳定的正解不是"目标列本身"**：目标列超出该行可落范围时钳到**离目标列最近的可用位置**（不是行首）。注意光标进标题行时 Vditor 会显示标题标记、整行右移（实测同一行 y=125：光标不在这一行时行尾 x=200，一进来变成 x=242），所以"下一拍重算"必须按**原始目标列**在新布局里取最近可用位置，否则差一个字。
    - 光标到顶/到底**不许消失**，也不许丢掉目标列（到底了再往回走，仍回到原列——边界分支里 `reset()` 会丢，实测就是这么错的）。
    - 逐行性的判据是"两次落点之间**不许还有能落光标的行**"（段落间距造成的 y 间隔不算跳行）；`caretRangeFromPoint` 按多个 x 探测时，要**优先取矩形真的盖住 y 的那个候选**，否则会拿相邻行的位置当命中，整行被跳过（实测这正是一次"跳行"的成因）。
    - 素材一律真实文档**副本**（`新建 Markdown 文档-副本.md`、`1-重识概率论.md`），固定种子随机起点；判据写成用户能看见的性质（可见/逐行/列稳定/选区单调/文字保真）。
    - 完整口径见工作区 `AGENTS.md` 的「交互验收总规则」与 `references/acceptance.md` §8。

## 4. GUI 自动化纪律

- **动手前先截屏确认前台归属**：用户正在用机器（任何前台窗口）→ 停止坐标点击，宁可少一步人工复验。截到用户内容的图**立即删除，绝不入档**。
- **受保护素材（`E:\MarkPilot\测试素材_*`）**：任何测试/检查先复制副本到工作区，试验完删副本；原素材只读（已 attrib +R），全程 md5 对账。
- **Trae**：绝不 `Trae.exe --install-extension`（Trae 运行中会转发给用户真实实例，等于动用户环境）。测试一律 `--user-data-dir/--extensions-dir` 隔离 profile + `--extensionDevelopmentPath` 指向抽取的 VSIX 目录；不写用户真实 profile；AI 侧边栏登录态行为不新拉未登录实例测。
- **坐标从 CDP DOM rect 拿**（`getBoundingClientRect`），不从截图比例猜——图像分析反推的图标坐标会反复漂移，每错一次就是一轮"点击+等待+截图+分析"。
- **测试实例用完立即 `CloseMainWindow` 关闭**，不留窗口在用户屏幕上（遗留实例曾让用户误以为功能"刚上线"）。
- 密钥只经 `LIVE_AI_KEY` 环境变量传入，产物/日志做零泄漏自检（全文 grep `sk-` 必须零命中）。

## 5. 绕弯路清单（为什么慢——弯路 → 直接路径）

| 弯路（实际发生过） | 直接路径 |
|---|---|
| 手动截图+点击去复验 CDP 冒烟已断言的行为 | CDP 真实 DOM+输入断言就是验收；人工只看脚本测不了的（视觉/手感），一遍过 |
| 用远程图像分析反推 UI 坐标 | CDP DOM rect / 命令面板；像素永远最后手段 |
| 弹窗几何"重写得更漂亮"（3 轮方案全破公式用例，每轮一整套测试） | 先二分证明因果（换回旧文件单变量对照），再最小 diff + 一层硬保险 |
| 在 webview 里 console.log 调试（根本看不见） | 测试侧插桩：让交互的返回值带上 rect/状态 |
| CDP 多上下文"取第一个不抛错的"读状态（旁观上下文返回 null 掩蔽真相） | 遍历全部调试上下文 + 时间戳基线判定 |
| 并行跑后台套件和 GUI 驱动"省时间"（结果毁掉 GUI 轮次，全部重来） | 串行；时间省在别处 |
| 脚本默认参数/硬编码版本号（1.0.0/2.0.0 各咬一次） | 显式传全参数；版本动态读 package.json |
| 先给"验收成功"结论再被用户抓误报 | 第一天就上真实 DOM 断言——比返工+重建信任便宜得多 |
| 遗留测试实例/窗口不清理 | 用完即关 |
| 实验/验收不做视觉检查，探针放在自造中间量上绕圈（凌晨 F_X 轮两次用户介入纠偏；bug209 先误诊 mask 截断、dev 全绿用户全白） | 铁律 7/8：基线帧+每操作一帧；真人操作流复现；仅用户可复现→打包 EXE+真实 profile 副本+stderr 即刻捕获；无关键帧不判成功 |
| 单遍 before/after 就下性能结论；用未 GC 的 JSHeapUsedSize 做内存归因（CV "+420MB" 假警报） | 铁律 10：交错 A/B/A/B；gc() 前后双采 + 渲染进程 privateBytes；归因探针做单变量确认 |
| 交付时现场猜证据文件路径和字段 | `references/acceptance.md` 有证据索引 |

## 6. 本机死路与陷阱（试过、不通、别再试）

- **`vm` 方式加载渲染层模块的测试要求模块零 import**（清单：`history-selection.js` / `markdown-locations.js` / `math-markdown.js` / `native-chat.js` / `split-resize.js`）：`vm.runInNewContext` 只做 `export function→function` 的文本替换，遇到 `import` 直接 SyntaxError。`history-visibility.test.cjs` 因此长期 11 红（真正原因是 `history-selection.js` 头部 `import {scrollIntoViewSafe} from './large-doc.js'`）。修法：加载器同时剥 `import`/`export` 并把依赖模块一起灌进同一上下文（已修）。**给这五个文件加 import = 静默把整套用例变红**；需要跨模块共享时用 `window.__typoraXxx` 全局注册（如 `__typoraScheduleMath`）。
- **模块内 `const performance = {...}` 会遮蔽全局 `performance`**（`incremental-ir.js` 末尾就有一个）：在该模块里调 `performance.now()` 得到 `TypeError: performance.now is not a function`，只在运行时报错、读代码看不出来。要用 `globalThis.performance.now()`。
- **`nested-math` / `math-table` 不能用 `run-electron-test.mjs <名字>` 跑**：`perf-runner.cjs` 没有这两个分支，会落到通用 probe 分支去等"全篇公式渲染完成"而必然失败（窗口化后 `missing` 永远 ≥5000）。正确入口：`SPLIT_NAV_SUITE=nestedmath node_modules/electron/dist/electron.exe scripts/split-navigation-runner.cjs`、`node_modules/electron/dist/electron.exe scripts/math-table-runner.cjs`（这两个 runner 自己 `require('electron')`，用 `node` 跑会死在 `app.exit` 上）。
- **`workflow-gaps` 依赖一份不在 git 里的合成夹具** `.perf/release100-manual-fixtures/概率论-人工复核副本.md`（含哨兵格 `不变甲`/`不变乙`/`untouched`，供"点击/粘贴只动目标格"类断言定位）。跑之前自己造、跑完删；受保护素材**替代不了**它（受保护的 `富文本测试-重识概率论.md` 里 `不变乙` 出现 0 次）。缺它时 137 项里 18 项必红（E18 历史的视口还原 4 项、E17/E26 表格源码往返 real-note 4 项、单元格字面粘贴 10 项），别把这类红当产品回归。
- **探针不许自己调 `getValue()` 当就绪判据**：我们的 `getValue` 被补丁成"整篇 Markdown 构建"，用它轮询等于把被测对象换成探针自己——本轮曾据此量出一个 840ms 的假长任务，白追一轮。就绪判据用真实 DOM（块数/预览数/pending）。

- **PowerShell 5.1 调 WinRT OCR**：`[Windows.Storage.StorageFile]::GetFileAsync` 报 MethodNotFound（静态方法投影失败），接口类型 `IStorageFileStatics` 也找不到。死路。
- **UIA 遍历 Trae**：无障碍树全空（Chromium a11x 未开）；`SPI_SETSCREENREADER` 唤醒无效，且该系统标志**用后必须恢复 off**。
- **Read 工具读本地图片**：只回传 CDN URL——本环境不存在"亲眼看本地像素"。
- **远程 analyze_image**：URL 带反斜杠会 400；DNS 瞬态故障曾把整个会话卡死。只当最后手段，先备 curl 下载退路。
- **Git Bash 引用/路径**：PowerShell 单行里的 `$_` 写成 `\$_`；`/tmp` 路径交给 Windows 工具前 `cygpath -w`；`node` 的 require 不认 `/d/...`，用 `D:/...`；**给原生 exe 传 `/S` 类开关会被 MSYS 路径转换破坏**（NSIS 静默安装用 PowerShell `Start-Process -ArgumentList '/S'`）；**中文参数过 cmd/powershell 有编码风险**（走 Write 工具写 UTF-8 node 脚本 spawn）。
- **Electron 探针 API**（44.x 实测）：`webContents.getProcessMemoryInfo`、`win.isOccluded` 不存在；被遮挡窗口 rAF 停摆需 `disable-backgrounding-occluded-windows` + 看门狗。
- 找本机软件：C 盘标准路径不存在先换 D 盘同路径（镜像安装布局；本机 Anaconda 在 `D:\Users\ltmroberthk\anaconda3`）。
- **`npm run dist` 报 `dist/win-unpacked/resources/app.asar` 被占用（EBUSY/EPERM）**：占用者通常不是应用、杀软或索引器，而是**工具宿主进程自己**（2026-09-10 实测：pid 8428 `ZCode.exe` 同时持有三棵构建树的 asar）。任务管理器看不出来是因为 `app.asar` 是数据文件、不进任何进程的模块列表，而缺 `FILE_SHARE_DELETE` 的读句柄会同时挡住删除和改名；`fs.open()` 也测不出来（libuv 一律带 `FILE_SHARE_READ|WRITE|DELETE`，锁着的文件照样能打开）。
  - 定位：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/find-file-lock.ps1 <路径>`（走 Windows Restart Manager，报 pid/进程名/可执行路径）。
  - 绕开：`npm run dist:fresh` 构建到 `dist-<版本>` 再只把 EXE 提升进 `dist/`；`--clean` 报出/清理残留构建树。
  - 释放：退出持有进程（宿主持有则退出宿主；已安装应用的 asar 由 `MarkPilot.exe` 持有属正常）或重启，然后 `rmdir /s /q "<目录>"`。
  - 顺序纪律：**先构建、后校验**。一旦对某棵树的 asar 做过解包/哈希校验，那棵树在本会话内就删不掉了。
- **Typora 无法注入页面内脚本**：`Typora.exe --remote-debugging-port=<port>` 确实会起 CDP 端点（`/json/version` 回 `Chrome/148`、Protocol 1.3），但 `/json/list` 与浏览器端点的 `Target.getTargets` **都返回空数组**（本机实测 5 次轮询皆空）。所以对手侧拿不到帧级/输入级延迟，只能外部测（`scripts/peer-live.ps1`：CPU 秒数 + 进程树内存 + 像素判首屏）。
- **PowerShell 语法两坑**（写 `.ps1` 时踩过）：`//` **不是注释**（会被当成命令名，报"无法将 // 项识别为 cmdlet"）；静态方法必须 `[Win]::Method()`，写成 `Win::Method()` 同样报"无法识别为 cmdlet"。另外 `.ps1` 必须 ASCII-only（见 §4 编码坑），改脚本时用 `grep -cP "[^\x00-\x7F]"` 自检。

## 7. 大文档性能（2026-09-10 已落盘：CV + telari 描边）

**已落盘内容**（渲染层事实源 `extension-src/render`，`npm run sync` 到 `app/renderer`）：

- `js/large-doc.js` + `css/large-doc.css` + `index.html` 引入 + `typora-patches.js` 接线（`installLargeDocGuard`）。
  ≥1500 顶层块才启用（小文档零规则命中）；**等公式队列清空后**启用并逐块写入 `offsetHeight` 作估算回退，再做一次总量校准。
  实测：滚动最差帧 50–67ms → **17ms**，fps 57→60；renderer privateBytes 反降 ~60–70MB；JS 堆无变化；总高误差 **0.06%**（193934 vs 真实 193815，此前 320px 回退虚高 4.4 倍）。
- `scrollIntoViewSafe`（导出在 large-doc.js）：**跳过子树内的深层节点几何不可靠**（实测 find 跳转可整段滚回 0），滚动前把目标顶层块临时置为可见、滚完还原；用于 `find-replace.js` reveal 与 `history-selection.js` 撤销恢复。块级节点本身可直接滚（误差 ≤41px）。
- telari 双主题正文描边 `0.01em → 0.007em`（14px 正文≈0.098px）；标题/表头/代码仍显式清零。

**CV 实现四坑（都是实测学费）**：
1) 只写 `contain-intrinsic-size: auto 320px` 会让总高虚高 4.4 倍→滚动条漂移 + 滚动位置记忆还原错位；必须逐块量真实高度。拟合对照（真实总高 193815）：`offsetHeight` 1.007 ✅ ｜ offsetTop 差值 1.217 ❌（跳过块仍参与外边距折叠，差值法重复计入）｜ 差值-自身外边距 1.036。
2) 在**公式渲染完成前**量高度会系统性偏小（未渲染公式的块更矮，实测偏小 4%）→ 必须等 `window.__typoraMathStats.pending` 归零（带 20s 超时兜底）。
3) 深节点 `scrollIntoView` 在跳过子树内不可靠（见上）。
4) `Selection.toString()` 会漏掉跳过区块的内容（实测 153100 vs 实际 354151）；`cloneContents`/`copy` 事件载荷完整（348420），产品里 toString 仅用于视口内小范围路径（数学源码复制、媒体操作、查找预填 <300 字符），无实际影响。

**按 A/B 数据回退的改动（勿重复尝试）**：`index.js` change 防抖 + `incremental-ir.js` ConsString。
依据 `.perf/cv-debounce-ab.json`：Vditor 自身已把连打合并为**单次** `options.input` 回调（10 击键 → inputCallbacks=1），防抖零合并收益，只把脏标记延迟从 ~300ms 拉到 410ms(150ms 窗口)/569ms(300ms 窗口)；ConsString 对照热点（Lute/WASM 占大头）不可测。输入"垃圾"结论：非泄漏，堆水位平稳，GC 可回收，`snapshots` Map ≤4 条 ≈13MB 属设计内。

**探针与证据**（`.perf/`，脚本在 `scripts/`）：`cv-edge-cases.cjs`（**33/39 PASS 0 FAIL**，含 CV 开关、跨块光标、跨屏选区、全选复制、查找远端跳转、公式点击、IME、setValue、双 telari 描边、控制台分级）、`cv-probe.cjs`、`cv-mem-probe.cjs`、`cv-gc-probe.cjs`、`cv-alloc-probe.cjs`、`cv-sampling-probe.cjs`、`cv-geometry.cjs`、`cv-debounce-ab.cjs`、`small-doc-mem.cjs`。
探针支持 `CV_PROBE_RENDERER`/`CV_PROBE_LABEL` 指向另一份渲染层做基线 A/B。

**融合路线 #3（阅读态窗口化只读渲染面）—— 2026-09-10 已落盘**，设计与实测全文见 `docs/READING-MODE-ROUTE3.md`：

- 做法：复用 Vditor 自带 preview 工具项进入全宽只读阅读面，只对它做**窗口化**——视口 ±1200px 的顶层块挂真实节点，其余换成**等高占位盒**（`div` + 逐块实测 `height` + 复制过来的 `margin-top/bottom`），占位盒里放该块纯文本并 `color:transparent;overflow:hidden` 裁掉，于是 Ctrl+A / 跨未挂载区拖选时**浏览器原生复制仍拿全全文**。编辑面（contenteditable）一条都不碰。
- 门槛：顶层块 <1200 不窗口化（小文档零规则命中，`stats.skipped`）；窗口化前必须等公式队列清空（同 CV）。
- 实测（教材合订本，2576 块/5689 公式）：renderer privateBytes **1011 → 约 750MB（−26%）**，预览面 DOM **13.5 万节点 → 约 2.9 千（−98%）**，滚动 59.9fps/最差帧 16.9ms，总高偏差 <0.5%；退出后 DOM/内存回到编辑基线。
- **成本模型订正（重要）**：立项时"边际 2.5–4.5KB/DOM 节点"的三点拟合**没有复现**——privateBytes 的大头不是节点数。实测 detach 编辑面 26.9 万节点只释放 ~2MB（被引用就不会回收，真释放必须重建，代价是退出时整篇重解析，不可接受）。本轮对外只报 −26%。
- 四坑（实测学费）：① 绑定必须早于窗口化（否则块种类只剩 95/2576）；② 逐块 `replaceWith` 2576 次累计 **5.1s**，整份子节点列表一次 `replaceChildren` **234ms**；③ 占位盒必须复制外边距，否则相邻块外边距折叠结果变了；④ `RenderJSON` 才是解析大头（12 万字 **2.25s**，`markdownLocations` 仅 20ms），所以只在源码变化时算一次。
- 已知边界（v1 明确不做）：Ctrl+F/H 在阅读模式**退回编辑态**再开查找（窗口化后未挂载块既搜不到也高亮不了）；点击进编辑落点是**块内按比例**不是逐字符；Desktop/Tablet/Mobile 宽度预设在阅读模式隐藏（切宽度会让占位高度失效）。
- 探针：`scripts/reading-mode-probe.cjs`（**32/32 PASS**，12 万字真实教材）、`scripts/reading-mode-edge.cjs`（**20/20 PASS**，小文档/空文档/表格与公式点击/缩放重排/连点/销毁/打字不改文档/查找交接/跨占位选区复制 ratio 0.997）。证据 `.perf/reading-mode-probe.json`、`.perf/reading-mode-edge.json`、`.perf/recon-reading-mem.json`。
- 顺带改动：`math-scheduler.js` 的 `prioritizeViewport` 根选择器补上 `.vditor-preview .vditor-reset`（源码视图/阅读模式下预览面才是可见渲染面）；`split-navigation.js` 导出 `documentLocations`/`bindCoarseBlocks` 供阅读模式复用（`previewBlocks(coarse)` 跳过强制布局的宽高读取，5689 个公式块实测省秒级）。

**落盘前全网搜索结论（2026-09-10）**：Atlassian 编辑器只对表格/媒体/展开块开 CV、**刻意不给文本块**（caret/selection 顾虑）→ 我们的门因此含跨块光标与跨屏选区（实测均通过）；[CSSWG #9337] `scrollIntoView` 对 CV 子树先视为可见；[Chromium #40733057] CV 元素进视口双布局可致位移（用真实尺寸 + 总量校准缓解）；CM6 viewport+高度估算模型确认路线 #3 方向——**本轮的读数面窗口化正是该模型**（编辑面全量 + 阅读面窗口，两家社区共识：可编辑虚拟化是难点，分层才是正解）。
- **CV 落盘门槛（八门，未过不许写渲染层）**：仅大文档启用（阈值 ~≥1500 顶层块）、初始布局完成后延迟启用、`contain-intrinsic-size: auto 320px`；必须过 find-replace 套件、跨块光标移动（Ctrl+End/方向键）+ **跨屏选区拖选**、公式视口优先正确性、export-large、全套回归 + bench 等价 + 截图终验 + privateBytes 平价。

**视口窗口化公式渲染 —— 2026-09-11 已落盘（2.0.13）**，全文与全部读数见 `docs/PERF-WINDOWED-MATH-20260911.md`：

- 做法（`js/math-scheduler.js`，仅 ≥1500 顶层块）：只渲染"文档顶部到视口下方 2 个视口高度"这一带公式，**这条线以上永不被撤走**（单向 frontier）。单向带来两个必要性质：视口以上每个块高度恒为真实 ⇒ 滚动位置记忆还原仍落在同一内容（frontier 会一路追到还原点，实测顶部块逐字相同）；内容不会在读者眼下被撤走而跳动。
- 为什么不能"先全渲染再释放"：见铁律 12——分配器不还池，就地释放零收益（实测 1,048→1,080MB）。**唯一的省法是从不分配**。
- 为什么不按公式逐个放占位盒：会改掉行内断行与块高（估高误差累积）。按块 + frontier 直接借用既有 CV/`contain-intrinsic-size` 的真实高度，一行代码都不碰几何。
- 代价（如实）：首次滚过未渲染区域 p95 帧 33ms（改前 16.8ms，第二次滚过无此成本）；静止总高 −4.1%（自校正，滚过即回真值）；**输入延迟优势只覆盖未读区域**（27ms vs 改前 426ms；整篇读完后回到 ≈365ms）。
- 开关：`localStorage.mathWindow='off'` 回退全量渲染；`scripts/perf-runner.cjs` 按套件模式设置（`math-boundaries` 需全量才能断言全渲染，其余走默认窗口化；`MATH_WINDOW=on|off` 可覆盖）。
- §7 坑 2 的口径更新：窗口化后 `__typoraMathStats.pending` 归零**不再等于"全篇渲染完成"**，只等于"视口附近渲染完成"。凡是用它当"布局已定型"信号的消费者（`large-doc.js` 启用 CV、`reading-mode.js` 量槽高、`history-selection.js` 停滚动修正），只在**视口以上已真实**这一点上成立——这正是 frontier 单向设计要保证的。
- 队列吞吐同轮修掉：`requestIdleCallback` 空闲回调会回落到 120ms 超时，89 批 ×~160ms 就是"14.3s 里只有 <2s 是 CPU"的全部原因；改为**没有待处理输入时用 `setTimeout(0)` 串接分片**（4ms/8ms 预算、32/64 条随输入自适应），输入让路逻辑原样保留。实测队列墙钟 9.6–15.0s → **2.13s**。
- **性能基线锚点（本机，34.8 万字符/2576 块/5689 公式）**：ready 3.53s；公式全完成 25.5s；稳态输入到下一帧 60ms（块内重解析 0.5ms/46 字符）；公式点击 116–205ms；滚动 55fps/最差帧 67ms；renderer privateBytes ~950MB（JS 堆 ~30MB）。Rust 重构量化论证：WebView 形态零交互收益；原生形态只在内存 ~9× 与后台 CPU 占优，输入/滚动已被架构手段抹平，机会成本月级。

## 8. 首屏与输入路径归因（2026-09-11 已落盘，2.0.14）

全文与全部读数见 `docs/PERF-FIRST-SCREEN-20260911.md`。要点：

- **归因结论**：打开的长任务里 Lute 整篇解析只占 ~560ms、浏览器插入 2.84MB IR DOM 只占 37ms；~3.0s 是我们自己的预热与几何（Markdown 缓存首建 855ms、大纲几何 329ms + 我们派发 resize 触发 Vditor `K` 全量重排 1017ms、阅读面 169ms、CV 启用 103ms）。**别再把它归给框架。**
- **做法**：新增 `js/warmup.js`（首屏之后的分片预热队列，单片 8ms、`navigator.scheduling.isInputPending` 让路、`localStorage.warmup='off'` 同步降级做 A/B），Markdown 缓存首建改分片预热、撤销快照改惰性换算、大纲/阅读面/CV 的几何量取搬到首屏之后（并把大纲 `update()` 改成先读全再写全、面板隐藏时不派发 resize）。
- **Vditor bundle 补丁**（`scripts/patch-vditor-lazy-value.cjs`，三处调用点）：渲染结束后的取值只在真有消费者（`input`/`counter`/`cache`）时才做。打开时三者全关，那次取值纯属白算——实测它在 FCP 之后 ~200ms 处造成 **1090ms** 冻帧（读者刚开始读的那一刻）。
- **A/B 读数（同产物交错）**：FCP **3828→2732ms**、打开长任务 **3107→1965ms**、首屏就绪 **3863→3021ms**、"完全静止"4168→4647ms（同样的量，改动后分散并让路，不再首屏前一次付清）。
- **输入路径**：24.7ms 均值 / 28.7ms p95（小文档 8.9ms）。剩余成本主要在 Vditor 自己的 IR 光标复位（`P→p→c`，`removeAllRanges` 282ms + `addRange` 118ms / 40 键 ≈ 10ms/键）与 Blink 排版；**我们自己的代码合计 ~6ms/键**（`refreshMathEditing` 全篇扫 5,645 处内联公式 ~3ms + 调度 ~3ms）。为这 3ms 去改 `refreshMathEditing` 会冒"展开态残留"的可见缺陷风险，本轮**不做**。
- **发现未修**：`setValue`（外部改动重载）后 `contain-intrinsic-size` 丢失（`intrinsicSet` 2576→0），跳过块退回默认估算把总高抬到 4.5 倍（185,983→834,426），滚动位置记忆会漂；正常打开是全新实例，不受影响。修法已想清楚（量高前先摘 `typora-cv`，量完挂回），需要一个独立轮次。
- **旁路测试修复**：`scripts/history-visibility.test.cjs` 的 vm 加载器（见 §6）——原先 11 项长期红，现在 228/228 Node 全绿。
- **探针**：`scripts/ir-perf-probe.cjs`（相位/FCP/longtask/资源/预热分片）、`scripts/profile-report.cjs --tree`（真调用树 + 压缩帧回源码）。证据 `.perf/ir-perf-*.json`、`.perf/ir-profile-*.json`、`.perf/math-perf-final.json`。

## 9. 首次排版前置 + 三项交互需求（2026-09-11 第二轮，2.0.15）

全文与全部读数见 `docs/PERF-AND-FEATURES-20260911.md`。要点：

- **首次排版前置**（详见铁律 19）：FCP 2732→**1892ms**、首屏就绪 3239→**1952ms**、打开长任务 1975→**1449ms**；累计到本轮开始（FCP 4324/长任务 3626/首屏 4368）＝ **−56% / −60% / −55%**。整篇排版没消失，变成首屏之后一次 999ms 的校准任务。
- **内存帕累托**（铁律 20）：620→**555MB** 渲染进程、880→**773MB** 进程树；归因普查给出天花板（63% 节点是公式源码脚手架，KaTeX 树只剩 65 棵）。
- **位置还原**（铁律 21）：新增块锚点持久化 + 持续重贴 + 用户接管即停 + `pagehide` 立刻补发；实测 anchor 1px / legacy 145px；大文档（20 万字符 + 图）保证"视口顶部块一致"。
- **Shift+Enter**（`typora-patches.js` 的 `patchSoftBreak`）：只插一个 `\n`（`pre-wrap` 画成紧贴的下一行）+ 光标后移，块数不变；表格单元格/代码公式块/标题让路。**踩坑：不能写 `at.closest("pre")`——IR 编辑面本身就是 `<pre class="vditor-reset">`**。探针 `scripts/soft-break-probe.cjs` 7/7。
- **多图剪贴板**（铁律 22/23）：Ctrl+单击多选（虚线框）+ Ctrl+C → 文件拖放列表 + 拼接位图回退。探针三条：`multi-image-copy-probe.cjs`（手势 7/7）、`multi-image-clipboard-probe.cjs`（系统剪贴板格式与还原）、`multi-image-paste-probe.cjs`（真实网页 `files.length===3`）。

## 10. 验收标准重立 + 三项实测缺陷（2026-09-11 第三轮，2.0.16）

全文见 `docs/ACCEPTANCE-STANDARD-20260911.md`（标准）与 `docs/ROUND-20260911-ACCEPTANCE-AND-FIXES.md`（过程）。要点：

26. **【2026-09-11】"开发树上验过"不算验过：交付物是打包产物**。本轮用户报"复制图片失败：无法写入系统剪贴板：-File …app.asar…"——媒体宿主把 `__dirname/media-clipboard.ps1` 交给 PowerShell，而打包后 `__dirname` 落在 `app.asar` 这个 Electron 虚拟文件系统里，外部进程打不开。开发树 `__dirname` 是真路径，所以探针 7/7 全绿、用户 100% 红。**同一个洞还一直让 `copy-table`/`copy-image` 在安装版里坏死**（共用宿主）。判据：任何"把路径交给外部进程"的代码，都要问"打包后这个路径还在真实文件系统里吗"。做法：`external-resource.cjs`（asar → `app.asar.unpacked`；没解包就从 asar 读出来落临时文件；都拿不到就抛错，绝不 spawn 不存在的路径）+ `asarUnpack: ["app/**/*.ps1"]`。**第一道闸门是 `00-static-audit` 场景**：asar 内每个渲染文件与 `extension-src/render` 逐字节比对。
27. **【2026-09-11】验收必须是"产物 + 真实输入 + 独立证人 + 无错误面"四件套**（`scripts/acceptance/`）。结构上强制：场景没有代码之外的证人 → 失败；只断言"处理器被调用了"→ 失败；动作后存在错误面 → 失败；场景少跑一个 → 不算通过。独立证人指：**另一个进程**读回系统剪贴板（`clipboard.ps1`，格式 + 文件 SHA256 对账）、磁盘文件、OS 层窗口可见性（`window-visible.ps1` 轮询 `IsWindowVisible`）、编辑器几何。触发真实输入用 CDP `Input.dispatchKeyEvent` / `insertText`，并在页面内自证事件到达。
28. **【2026-09-11】错误面断言要抓"短命提示"**：气泡 2.2s 自动消失，事后 `querySelector` 只会读到 null——第一版就把用户的报错漏成"没有报错"。做法：动作前挂 `MutationObserver` 记录所有 `.typora-context-toast` 文本，再断言其中没有 `\uFFFD` / `-File` / `app.asar` / `失败`。同类：产品自己 `stopImmediatePropagation` 的 copy 事件，观测器要挂 **window** 而不是 document（挂 document 会被它挡掉）。
29. **【2026-09-11】块尾软换行在 `pre-wrap` 下是"悬挂"的：不建行盒 ⇒ 块高不变、光标矩形 0×0 ⇒ 用户按一次 Shift+Enter 看不到任何变化**（本轮缺陷 ③）。四种表示法实测（块高 / 光标框 / 序列化）：`text\n` 1 行 / 无 / `text`；`text\n<br>` 2 行 / 无 / `text`；`text<br>` 1 行 / 无 / `text`；**`text\n\u200b` 2 行 / 有 / `text`**。所以落在块尾的软换行要补一个零宽空格脚手架，并在用户 `input`（`event.isTrusted`）时摘掉；零宽字符在 Lute 序列化时本来就被丢弃，文件依然干净——验收用"没输入时存盘文件字节不变 + 输入后有软换行且无零宽字符"两条钉死。
30. **【2026-09-11】"感觉变慢了"要拆成可观测的段再比，而且必须同盘同素材**：`spawnToWindow`（OS 层可见性）/`shellToIframe`/`inPageToDom`/`settle`，冷启 + 热启双路。反例：拿安装版（D:）比 dist 构建（E:）会得到"外壳慢 400ms"的假象；刚装完的头几次启动 2740ms 是系统在扫描新 asar，热态 1543ms。结论（2.0.14→2.0.16 小/中/大）：1516/1541/1543、1590/1609/1623、2104/1918/1908，热打开 138/135/130 —— **无可测退化**。
31. **【2026-09-11】台账的统计口径决定闸门可信**：冷启动单次抖动实测 1.5s–5.3s；延迟类指标取**多次样本的最小值**（"这台机器能做到多快"），中位数与全样本仍写进报告；"退化"必须同时超过相对容差**与**绝对下限（ms 类默认 20ms），否则 `invokeToIframe` 3ms→4ms 这种噪声会把闸门误杀。`--only` 跑单场景时必须**合并**写回 report，不能用本次结果覆盖（曾把同一 label 的其它场景数字抹掉）。
32. **【2026-09-11】测试环境自己也会制造假通过**：`spawn(..., {windowsHide:true})` 会让 Windows 把进程的**第一次** `ShowWindow` 改写成 `SW_HIDE`（STARTUPINFO 优先），于是被测窗口从未出现、所有"窗口可见"类判据全假通过。另：CDP 注入的 Ctrl+C 到不了浏览器加速器（要先把焦点交给编辑器 iframe，否则 copy 事件根本不派发）；开发模式下 `electron.exe <main.js> <file>` 的位置参数顺序不能乱（Chromium 开关插在前面会让应用把 `main.js` 当文档打开；入口放开关后面 Electron 又会把 `.md` 当应用入口）。
33. **【2026-09-11】顺带修掉的既有缺陷**：`app/main/server.js` 内部服务绑固定端口 48190，被占用时 `listen` 抛 EADDRINUSE → `app.exit(1)`，用户看到"应用起来了又没了"（便携版 + 安装版并存必现）；现在退到系统分配的空闲端口。

### 安装与工具链自动化（用户明确要求"自动化解决后写入 skill"）

34. **【2026-09-11】静默安装 EXE 必须用 Node spawn，且装前要先让应用自己退出**：`scripts/install-app.cjs`。
    - **`/S` 会被 MSYS 改写**：在 Git Bash 里执行 `Setup.exe /S`，MSYS 把 `/S` 当成路径 → `S:/`，NSIS 收到无意义参数就照常弹图形安装向导（用户实测"还要我手动点一下就这个"）。Node 的 `spawn(installer, ['/S'])` 不经 shell，参数原样到达。
    - **应用在运行 = 必定要人点**：electron-builder 的 NSIS 有 `_CHECK_APP_RUNNING`，只要 `MarkPilot.exe` 在跑就弹 MessageBox（点 OK 之后它还会 `/F` 强杀你正在编辑的实例）。脚本改为先发**不带 /F 的正常关闭请求**（WM_CLOSE，应用会走自己的保存/确认逻辑），等它退出再装；它若因"未保存修改"确认框没退，脚本**停下来报告**而不是替用户点。
    - **安装目录不能猜**：本机用户真实 `LocalAppData` 在 D: 盘，而工具宿主进程的环境变量写的是 C:，且 electron-builder 不写 `InstallLocation`。从卸载项的 `UninstallString` 反推目录最可靠（`installedRoot()`）。
    - 装完核验三件事：asar 里的版本号、`app.asar.unpacked/**/*.ps1` 存在、asar 哈希与 release 目录一致。
35. **【2026-09-11】VSIX 安装：CLI 不可靠，用目录侧载并核验版本**：`scripts/install-vsix.cjs`。
    - VS Code 系 CLI（`Trae.exe --install-extension`）在本机会**把整个 IDE 拉起来并且不退出**，90s 超时杀掉后扩展目录里依然没有文件夹 ⇒ 不能当自动化手段。
    - 改为侧载：bsdtar 解开 VSIX → 把 `extension/**` 平铺拷进 `<extensions>/<publisher>.<name>-<version>/`（Trae 在 `~/.trae/extensions`，VS Code 在 `~/.vscode/extensions`）→ 读回该目录 `package.json` 的版本号核验；顺带清掉同 id 的旧版本目录，避免出现两个版本。
    - 仍然遵守既有纪律：**IDE 正在运行时不要命令行安装**（会转发到用户实例），脚本检测到进程直接拒绝并提示改用命令面板。
36. **【2026-09-11】本机有 Anaconda，别再说"没有 Python"**：`D:\Users\ltmroberthk\anaconda3\python.exe`（3.10.13）。上一轮的误判来自"只在 C: 盘找 maxdepth 3"。发版路径固定为 `/d/Users/ltmroberthk/anaconda3/python.exe pack.py`（官方打包器，自动同步 vsixmanifest 的 Identity Version）。无 Python 环境才用 `Typora-Editor/scripts/pack-vsix.cjs`（Node 移植版，已用 `scripts/compare-vsix-packers.cjs` 验证与 pack.py **逐文件 0 差异**：517 文件）。
37. **【2026-09-11】两个新发现的多选/剪贴板细节**：
    - **多选两种顺序都要成立**（用户实测）：普通点第一张 → 按住 Ctrl 点第二张也必须能多选。做法是 Ctrl 点时把先前单选的那张**迁移**进多选集合（实线框→虚线框，并清掉 DOM 选区）；Ctrl 点已单选的那张 = 取消。判据看 `outline-style`（solid/dashed），不是看类名。
    - **CF_HTML 必须按原始字节读回**：WinForms 对自定义格式按 ANSI 码页转 String，读回来中文表格就是乱码（产品代码正是为避开这点才写字节流）。验收脚本要用 Win32 `RegisterClipboardFormat`+`GetClipboardData`+`GlobalSize` 自己解码 UTF-8；`GlobalSize` 返回 `UIntPtr`，要 `.ToUInt64()` 再转 int。
38. **【2026-09-11】给验收脚本加 .ps1 也踩了 ANSI 坑**：往 `scripts/acceptance/clipboard.ps1` 里加了一行中文注释，PowerShell 5.1 按 ANSI 码页解码 UTF-8 字节 → 注释被解坏、括号错位 → 整脚本 ParserError。**所有 .ps1（含验收脚本）一律纯 ASCII**，已加单测（`external-resource.test.cjs`）遍历 `scripts/acceptance` 与 `app/renderer/js` 下所有 .ps1 断言无非 ASCII 字节。
39. **【2026-09-11·本轮最大一条】asar 内的静态文件绝不能用 `open`/`createReadStream` 服务**：Electron 对归档内路径的 `open()` 会把**整个文件先抄到临时目录**（耗时与大小成正比、约 4MB/s、只有第一次付）。实测同一份 3.8MB 的 `lute.min.js`：`openSync` 868ms、`promises.open` 0.4ms、`readFileSync` 1.1ms；用生产代码的 `startServer` 做 HTTP A/B：`createReadStream` **1161ms** vs `readFile`+`res.end` **13ms**。而它正好在冷启动关键链上（编辑器页要等 lute 才能解析文档），于是"安装版比开发版慢 1.2 秒"的真凶就是它——**不是** asar 读得慢，也不是需要"预热编辑器宿主"。
    - 修法：`app/main/server.js` 的 `sendFile` 用 `fs.readFile` 整读后回写（带 `Content-Length`，HEAD 走对）。
    - 效果（安装版）：页面内 → 内容进 DOM **1218ms → 214ms**；lute 取用 **882ms → 13ms**；进程启动→内容进 DOM **1482ms → 558ms**。
    - 永久防线：单测断言 `app/main/server.js` 里不再出现 `createReadStream|openSync|fs.open(`（注释里提到不算）；场景 00 的产物审计同时比对 asar 内 server.js 与开发树字节。
    - 推广：任何"交给外部进程/让浏览器去读"的产物内文件都要先问一句"这个路径在 asar 里吗"，能整读就别流式。
40. **【2026-09-11】剪贴板类动作的验收必须**轮询**证人，不能点完就读**：写剪贴板走 PowerShell（首次 `Add-Type` 要 1–2s），真实菜单点完立刻读会读到**用户原来的内容**——"复制表格失败"的第一版就是这么假失败的（产品其实正常）。用 `edge-helpers.readClipboardUntil(dir, predicate)` 轮询到目标内容出现（带上 `waitedMs` 进证人）。同理，凡是"产品→外部进程→外部状态"的链路，都要按"最终状态出现"来等，而不是按固定 sleep。
41. **【2026-09-11】右键菜单类验收的两个坑**：
    - **右键必须落在选区内部**：落在选区外，Chromium 先把光标挪过去、选区塌掉，于是复制/剪切变成对空选区的操作（会给产品扣一顶"不工作"的假帽子）。做法：用 `edge.selectionPoint`（选区中心的顶层页坐标）右键。
    - **表格行列增删别只数行数**：删掉的可能是另一行。改成"插一行 → 删掉**刚插的那一行**（空行/空列就是天然的锚点）→ 磁盘字节必须回到插之前"，才真正钉住语义。锚点格要用"含公式源码"之类的**内容**去定位，不要用索引（索引会随插行漂移——本轮第一版就是这么把自己的锚点删掉的）。
42. **【2026-09-11】含表格的文档保存时表格会被重排，所以"字节保真"必须在没有表格的素材上量**：Lute 在 IR→Markdown 时按列宽对齐表格：`| 项 | 值 |`→`| 项 | 值             |`、`| --- | --- |`→`| -- | -------------- |`（列宽被补齐、分隔行破折号数按列宽重算）。**已实测重新打开仍能正确解析为表格（行/列/内容一字不差），是对齐归一不是数据损坏**。验收口径：`math-only.md` 上做严格字节往返保真；`dense-math.md`/`math-table.md` 上验"表格语义往返不变"（行数/列数/单元格内容）。
43. **【2026-09-11】`document.execCommand('cut')` 的返回值不可信，要以"选区是否塌掉"为准**：Electron 实测会**返回 true、也写了剪贴板，但不删正文**——右键菜单的"剪切"于是看起来"没反应"，再粘贴就是一份重复内容（同一个选区按 Ctrl+X 是正常的）。修法：`cutSelection()` 里判断"选区还在"就自己 `range.deleteContents()`，并先 `execCommand('copy')` 兜一次剪贴板。判据用**出现次数**（粘贴后 1 次 → 剪切后 0 次 → Ctrl+Z 后 1 次），不是"包不包含"。
44. **【2026-09-11】构建链路：GitHub 不可达时 electron-builder 会挂在 electron 分发下载上**：连续三次 `Timeout awaiting 'request' for 600000ms`（`connect ETIMEDOUT 20.205.243.166:443`），因为要下载并解包 `electron-v44.2.0-win32-x64.zip`；`ELECTRON_BUILDER_BINARIES_MIRROR` **对 electron 本体不生效**（那个变量只管 builder-binaries，如 winCodeSign/nsis）。修法：`scripts/dist-fresh.cjs` 自动带 `--config.electronDist=node_modules/electron/dist`（同版本同平台解包产物），构建不再依赖任何外部下载；`--no-local-electron` 可退回。winCodeSign 需要时从 `https://registry.npmmirror.com/-/binary/electron-builder-binaries/winCodeSign-2.6.0/winCodeSign-2.6.0.7z` 预先放进 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign-2.6.0\`。
45. **【2026-09-11】"没收益就回退"，并把否掉的证据留在代码注释里**：本轮试过"外壳先上屏、两帧之后再装 iframe"（假设 iframe 抢主线程让窗口晚 220ms 出现）。安装版实测窗口可见 496/497/481ms **与改前 513/488/479 没有差别**（外壳首帧瓶颈是渲染进程启动，不是 iframe），而内容进 DOM 被推迟约 60ms → 按纪律整段回退，并把这三行实测数字写进 `app/shell/shell.js` 的注释，避免下一轮再想当然重做一遍。同轮还有两处被数据否掉：预置 lute/katex 脚本标签（asar 修复后"取回"只剩 10–17ms，无省可省）、warmup 片预算 8ms→4ms（没有新证据说明它在制造卡顿）。

46. **【2026-09-10·对第三方应用做性能对照】Typora 的 CDP 只能走管道**：`--remote-debugging-port` 它**收下但不监听**（`DevToolsActivePort` 不出现、端口不开放，实测连 9333 被拒），而 `--remote-debugging-pipe` 正常。Node 侧用 `stdio: ['ignore','ignore','ignore','pipe','pipe']` 拿到 fd3（写）/fd4（读），消息以 `\0` 分隔。参考实现：`scripts/peer-cdp.cjs`。**对任何闭源 Electron 应用做同口径对照，先试管道再谈别的**——走 CDP 之后窗口可见性、z 序、焦点统统无关，机器被占用时照样能测。
47. **【2026-09-10】屏幕抓图在"机器有人用"时不可信，而且有两种不同的坏法**：(1) `CopyFromScreen` 抓到的是**遮挡物窗口**（实测把用户正在用的编辑器当成了被测应用的大文档截图）；(2) `PrintWindow(hwnd, dc, 2)` 在窗口被完全遮挡时返回**纯色**（连续 3249 帧色量 0），而"检测到纯色就激活并提到最前"的抢救对**本身也是 topmost 且活动的窗口无效**——`SetWindowPos(HWND_TOPMOST)` 对已经是 topmost 的窗口是空操作。结论：像素证人只能作为**辅助**证据，且必须带"整轮最大色量低于门限就判废"的闸门（`captureFailed`）；主证据用 CDP。
48. **【2026-09-10】向被测量窗口注入输入的两个硬前提**：(1) **窗口成为前台 ≠ 编辑器拿到键盘焦点**——MarkPilot 的编辑器在 iframe 里，实测 `document.hasFocus()===false`、`activeElement===BODY`，此时 `Ctrl+End` 送到外壳、文档一动不动（点击前的抓图还停在文档开头，这才暴露它）；先在正文里点一下建立焦点，`Ctrl+End` 立刻生效（scrollTop 0 → 75085）。激活是异步的，之后还要留约 250 ms 再发输入。(2) **`SendInput` 的返回值必须看**——它返回真正塞进队列的事件数，0 表示被拒（例如前台窗口完整性级别更高）；本轮实测按键 4/4、点击 3/3 全部插入成功，说明"没反应"的原因不是没送到。**任何输入注入之前必须确认前台属于被测应用，拿不到就整段跳过、绝不重试硬发**（本轮曾因少了这道闸门，把测试用的字符打进了另一个应用的输入框）。
49. **【2026-09-10】"安静"这个判据必须带正文下限，而且口径要说清楚**：空白编辑器也是一个**完全稳定的画面**，只按"像素不再变化"判安静，会把"空白上屏"当成"文档已就绪"（实测 MarkPilot 大文档在 228 ms 就被判"安静"，色量 0）。修法两层：见证器侧给 quiet 加绝对色量下限（`INK_FLOOR`，空白页不算安静），正文判据改为"达到本轮最大色量的 25% 且不低于下限"。另外"安静"的像素口径与 DOM 变动口径会在中档文档上打架（像素：MarkPilot 1240 / Typora 1257；DOM：1528 / 2451）——**口径依赖的指标不下单一结论**，报告里要并列写出来。

50. **【2026-09-10·差点翻车的三件事，按严重程度排】** 这一轮为了回答"性能是否比 Typora 强"，走了不少弯路，其中三件事是真会出事的，写在这里当红线：
    - **(1) 最严重：注入的输入打进了用户正在用的另一个应用。** 见证器要测"打字延迟"，用 `SendInput` 发字符，但当时只检查了"窗口被激活过"，没有在**每一次发送前**确认前台仍属于被测应用；结果那台机器上用户正在用的编辑器抢走了前台，测试用的 `x` 一连串打进了它的输入框。**代价**：用户的编辑内容被污染，且这种事无法自动回滚。**本应怎么做**：任何输入注入（键、鼠标、滚轮）在**每一次发送前**都要 `OwnsForeground(hwnd)`（精确句柄或同进程）复核，不成立就整段跳过并如实记成"输入阶段跳过"，**绝不重试硬发**；能不用系统级注入就不用——优先用 CDP 的 `Input.dispatch*`，它只进被测页面，不碰系统输入栈。
    - **(2) 抓图抓到了遮挡物，并且会得出完全错误的结论。** 用 `CopyFromScreen` 抓"Typora 打开大文档"，抓到的其实是用户正在用的编辑器窗口——而且因为两个应用的中/大档"色量完全相同"（5754），差点得出"Typora 没打开我的素材"的错误结论。**本应怎么做**：像素类证据必须配一个**内容同一性证人**（本轮用的是"DOM 一级标题 == 磁盘文件一级标题"和打开瞬间的截图）；发现"两个不同素材的读数一模一样"这种反直觉现象时，先怀疑测量本身。
    - **(3) 把"空白页"判成"文档已就绪"，会得出好看但假的数字。** 只按"像素不再变化"判安静，MarkPilot 打开大文档在 228 ms 就被判"安静"（色量 0，编辑器还是空白），差点写出"打开大文档只要 228 ms"这种谎。**本应怎么做**：所有"稳定/安静"判据都要带**内容下限**（空白也是稳定的），并且正文判据要用"达到本轮最大色量的某个比例且不低于绝对下限"这种可复核的定义。
51. **【2026-09-10】怀疑"产品没反应"之前，先证明"动作到底有没有发生"**：本轮一连串"点击没反应/按键没反应"的表象，真因是**窗口成为前台 ≠ 编辑器拿到键盘焦点**（编辑器在 iframe 里，`document.hasFocus()===false`、`activeElement===BODY`），而不是输入没送到——`SendInput` 返回值显示事件全部插入成功（4/4、3/3）。**顺序很重要**：先量"动作是否发生"（`SendInput` 返回值、`GetCursorPos`、`WindowFromPoint`、应用自报的 `scrollTop`/选区），再谈"产品有没有反应"；否则会把"我没点到"写成"产品有 bug"。这一轮为此写了 `scripts/acceptance/win-sendinput.ps1`（最小 SendInput 驱动，打印插入事件数与落点窗口）与 `scripts/probe-input-delivery.cjs`（用 CDP 读应用自报状态做真相）。
52. **【2026-09-10】对照类测量必须两把独立尺子，且"口径依赖的指标"不下单一结论**：本轮同时用了屏幕像素与 CDP 两套测法（互为独立见证，排序一致才敢写进 README）。其中"画面彻底安静"这一项两套口径在中档文档上打架（像素：本产品 1240 / 对照 1257；DOM 变动：1528 / 2451）——**这种指标只在报告里并列写明，不进结论、不进宣传**。可进宣传的只有两套尺子都同意的那几项。

## 11. 何时读哪份参考

- **最完整测试守则（全轮次范围并集 42 任务 + 4 终验 + 次序框架 + 硬性门）→ 首选读 `references/test-protocol.md`**
- 任务执行器用法、冒烟断言代码模式、证据文件索引 → 读 `references/acceptance.md`
- 版本策略、打包、交付清单与报告格式 → 读 `references/release.md`
- 完整踩坑编年史（每条含代价与"本应怎么做"） → 读 `references/pitfalls.md`
