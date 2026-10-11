# LOG 3.0.2（CM6 引擎 · 表格 α 档）——内部记录

> 面向用户的说明写在 `RELEASE-3.0.2-CM6.md`；本文是验证数据、哈希、复现命令与决策依据的**内部**记录。
> 上一版：`LOG-3.0.1-CM6.md`（§一–§十八）。本文件只记 3.0.2 这一轮。

## §1 范围与决定

| 项 | 内容 |
|---|---|
| 目标 | 表格 α 档：**把"输入几乎全断"修到能用 + 换皮**（不动架构：真相仍是 markdown 源码行、仍逐行 widget） |
| 决策单 | `.mp-verify\table-research\DECISIONS.md`（Q1–Q16） |
| 方案与修订 | `.mp-verify\table-research\ALPHA-PLAN.md`（含"复核结论与修订"、"落地后必跑的验收矩阵"） |
| 六线调研 | `.mp-verify\table-research\{inventory,ops-keys,clipboard,richtext,frontier,arch}\` |
| Typora 视觉实测 | `.mp-verify\typora-verify\TYPORA-VISUAL.md` + 8 张截图（1.14.10 真机，单实例锁绕开 CDP 走真键鼠） |
| **Q15** | 格内预览**去掉**（用户决定）：最贴 Typora、每键净省一次 `innerHTML` 写入 + 一次渲染比较、结构性冲突整族消失 |
| **Q16** | `copyRich` 行内公式**保持 TeX `<code>`**（β 再议）；澄清"TeX code 不会在目标处自动渲染" |
| **A6** | **按证据推迟到 β**：今天每键增量 +1.0~4.2ms 但键入 p95 15.9–16.4ms、帧间隔 `gt33≈0`（无掉帧）；正解需渲染核重构（`eq` 只比渲染结果 + `updateDOM` + `posAtDOM`），发布前夜做风险大于收益 |

## §2 落地清单（引擎演进与哈希）

`renderer-cm6/app.js`（esbuild → `sync-engine.mjs` 字节校验一致）：

| 序 | 版本 sha16 | 字节 | 含 |
|---|---|---|---|
| 0 | `f62ad5398ebf5752` | 1,108,898 | 3.0.1 冻结件（已发布） |
| 1 | `d13dd5328fec9a69` | 1,108,935 | A2 IME 守卫（初版，缺 `preventDefault`） |
| 2 | `4420f075e3bed44b` | 1,108,958 | + A4a 三处切分口径 |
| 3 | `0dce7599274f0c93` | 1,110,390 | + A7 换皮（初版：`min-height` + 浮层预览） |
| 4 | `75965f881bdde58f` | 1,111,199 | + A2 守卫补 `preventDefault`、+ A1 键位优先级/表内回车消费/表尾↓出路/整块表判定、A7 抄样式缓存 |
| 5 | `a2055b7d05d41020` | 1,111,947 | A7 v2：锁高 + 边框/居中补偿 + 预览锚文本盒底边 |
| 6 | `67e8b6355242ffd2` | 1,111,965 | A7 v2b：间距 8px→2px、卡片 −5px（减损旋钮） |
| 7 | `11befd3b2b2d5d0c` | 1,110,047 | **Q15：格内预览整族删除**（`main.js` 净减 2,966 B） |
| 8 | `a38152c899d19f71` | 1,110,925 | **A3**：右键几何命中 + 命令锚到被点的格 + document 层监听 |
| 9 | `c2722a778723bd2e` | 1,113,706 | **A5**：粘贴（格内止血 / 结构化建表 / 行内 HTML 白名单）+ **写入口 `\|` 转义** |
| 10 | `e82c250baea6e697` | 1,113,785 | **A4c**：把"哪一行算表"三套判据收口到渲染层那一条 |
| 11 | `e403cc755c850933` | 1,113,827 | 仅清理一句过时注释（`上原文、下预览` → `只放源码原文，不再做格内预览`）。**这份注释在 CSS 模板字符串里，minify 剥不掉**，所以哈希会变；已与复核线冻结副本逐字节对拍证明：**唯一差异就是 offset 1092692 处那 28→70 B 的注释**，前缀/后缀完全相同 ⇒ 各复核线对 `e82c250b`/`c2722a77` 的结论对当前头依然成立 |
| 12 | `7a0f04657a6a284d` | 1,113,852 | **修复：垂直居中补偿的缓存过期**（复跑无预览探针时抓到）：`overlayStyledFor` 原来只按"哪一格"缓存，激活那一刻格子若还没到最终高度（图片未加载/夹具稍后撑高/行 widget 刚重建），补偿按旧高度算一次后被缓存住 ⇒ 高行格 `dy=−36.91px`、`padTop=9px`。改成缓存键带上 `Math.round(r.height)`（高度变化才重算）。复验：`padTop` 回到 **45.9px**、高行纯文字 **dy=−0.02px**（高行公式 −1.02px，属 KaTeX/Georgia 的 ascent 量尺差），主臂 `occlMat=0`、对照臂 1 |
| 13 | `6fd44d034eae2102` | 1,114,046 | **A4d**：导出侧**行**判据与渲染层同源（F1）+ 表头行语义（F2：下方插行落分隔行之后 / 表头行不能删） |
| 14 | `37254d2ffedf7def` | 1,114,360 | **A4e**：`copyTable` 锚点与 `tableOp` 统一 + `!cur` 补提示（A3 复核点名的静默）｜分隔行不能删｜表头行「上方插行」拒绝｜A3 根因注释更正 |
| 15 | `4ea4bf5e4f152138` | 1,115,411 | **A8**：覆盖层的表格键转发（Ctrl+Enter 家族）+ ↑/↓ 出表。**这一版有个致命小错**：`main.js` 没导入 `EditorSelection`（它只在 `tables.js` 里导入过），四行转发代码全抛 `ReferenceError`，又被我自己的 `try/catch` 吞掉 ⇒ 装机验收 S3/S6 红、现象是"按了 Ctrl+Enter 有 preventDefault、但什么都不发生"（诊断脚本 `diag-a8.cjs` 用"包一层 `tableOp` + window error 记录器 + 后注册的 bubble 监听读 `defaultPrevented`"三样证据定位） |
| 16 | `30effdae7b5c1a61` | 1,115,434 | **A8 修复**：`import { …, EditorSelection, … } from "@codemirror/state"`；并把 `catch {}` 改成 `catch (err) { console.error(…) }`（**不要再吞异常**——这次就是被它藏了半天） |

改动面（相对 3.0.1 冻结件）：`src-cm6/main.js`、`src-cm6/extras.js`、`src-cm6/tables.js`（共 +314 / −64 行级别，含注释）。

## §3 每项的判据与验收结果
| 项 | 判据（要点） | 结果 | 证据 |
|---|---|---|---|
| A1 键位 | 表内 `Ctrl+Enter` 加行且**表不被劈开**；表外行为逐字节不变；**提优先级注掉必须变红** | 已落；整块表判定（`tableBlockOf`）覆盖第 3 行起；表尾 ↓ 出路 | 代码 + `tables.js` grep；真机复验待装机 |
| A2 IME | 组字中 `Tab`/`Ctrl+Z`/`Escape`：文档不变、**活动格不变**、组字仍在 | **`prod`(0dce7599) 红 8 次 7 红；`head`(75965f88) 8/8 绿** | `alpha-verify\A2A7.md`，时间线 6/6 一致 |
| A4a 切分口径 | 导出/复制/源码键位三处与渲染同口径；`\|` 不劈格 | base 全绿、mut 18 红 | `alpha-verify-a4\A4.md`（后经 A4b 复跑：base 绿 / mut 18 红） |
| A4b 还原·转义·截断·colIdx | 屏幕==导出==TSV 字面；导出按表头列数截断（Q10）；`col-left` 落点正确；写入口 `\|` 幂等 | **base 全绿 = true**；B1/B2（行内码/公式裸管道）转绿 | `a4-verify-a4b.cjs` 复跑（判据期望按新口径更新的副本） |
| A5 粘贴 | 格内多行/表格 ⇒ 拒绝+提示（**不再劈表**）；TSV/markdown 表/HTML 表 ⇒ 建表；单行 `\|` 转义；单值行为不变 | **绿 34 / 红 1（红是对照臂构造，不是产品）**：真 `Ctrl+V` 后文档 116B→116B 逐字节不变 + toast + 焦点仍在覆盖层 + 再敲字能进文档；对照臂（注掉监听）文档 116→141B、目标行被拆行 ⇒ 红 | `alpha-verify-a5\A5.md`（含双版本对照：`c2722a77` 与 `e82c250b` 十项读数逐条相同） |
| A7 换皮 | 外框==格子（Δ≤1px）、无边框/无投影/透明底、预览按需、**同偏移 Range Δy≤1px** | 纯文字格全绿；**去掉预览后 `*-noclobber` 整族消失** | `alpha-verify\A2A7.md` + `alpha-verify-gaps\GAPS.md` + `A7-V2-RECHECK.md`（20/3 → 去预览后再验） |
| A3 右键 | 格上弹 + 左右 1px 外侧仍弹 + 正文/工具栏不弹；命令作用在**被点的格** | **七条判据全绿**：格上（非活动 td / **活动格穿透覆盖层** / 表头 th）各出 7 项菜单；外侧基线 12 点 **12/12 仍弹**；正文/工具栏/对话框不弹且 `defaultPrevented=false`（对照臂上变红 ⇒ 非假绿）；命令锚在被点的格；复制表格载荷 + **真实剪贴板回读**（60 B TSV）都对 | `alpha-verify-a3\A3.md`。**并更正根因**：决定性改动是监听从 contentDOM 换到 **document 捕获**（单变量对照臂：表内 12/14 → 0/14，外侧不变；反方向注掉几何命中格 ⇒ 28 点矩阵逐点不变）；`posAtCoords` 在表格区域内其实恒回到表格源码行的位置，并不落表外 —— 已在源码注释与 LOG §5 更正 |
| A4c 表块判据 | 三层（命令/导出/源码键位）的"哪一行算表"统一到渲染层 | **base 全绿 = true（15/15）**，四条对照臂各自按预期变红 | `alpha-verify-a4c\A4C.md`（并带回 F1/F2 两条必修） |
| A4d F1/F2 | ① 导出的**行**判据也收口；② **表头行**「下方插入行」不再把表写坏（新行插到分隔行之后）、表头行「上方」插到表头之上、表头行不能删 | **F1：导出件 `<table>`=1、无 `<p>c \| d</p>`、一行不丢（22 条判据全绿；三条对照臂全红，其中两条与"改前真产物"导出正文逐字节相同）；F2：表头行 `row-below` 经窗口 API 与**真 Ctrl+Enter** 两条路径都不再写坏表（50 条 0 红，`mut-f2` 16 红）** | `alpha-verify-a4d\A4D.md` |
| A4e 两条守卫 | ③ 分隔行 `row-delete` 仍会散表（改前也如此，守卫未覆盖）；④ 「表头之上插行」那行注定在表外（GFM 表头必须与分隔行相邻）⇒ 改为**拒绝 + 提示** | 待落（等 A3 复核线交报告后动，避免中途漂移） | 本表 + `A4D.md` 的"待定夺" |
| A6 重建 | 13→1 行重建 | **推迟 β**（见 §1） | `arch\mut-rebuild.mjs` 复跑：纯选区 0 重建 / 输入 1 字符 13 重建；`ARCH.md:173-174,202-203` |

**既有套件回归（当前引擎 `c2722a778723bd2e`）**：`export-table` exit=0（base 全绿=true，19 红全在它自己的 mut 臂）、`exporttypo` exit=0（全部通过）、`print` exit=0、`exportux` exit=0（全部通过）、`exportux-dead` exit=0（全部通过）。

## §4 未验证项（如实记账）

1. **装机产物未跑**：以上读数全部来自 headless 引擎副本 / 未打包；装机端到端（PDF 冒烟、五通道、真机键鼠）在出包后跑。
2. **原生光标**：CDP 拍不到（`AGENTS.md` 已写明），几何判据用"同偏移 Range 矩形"，不用截图判光标。
3. **平台门**：headless + `file://` 下 `grantPermissions` 不生效 ⇒ 剪贴板**最终落地内容**读不回（验的是产品构造的 `ClipboardItem` 载荷）。
4. **CRLF**：`dispatch` 进引擎那一刻就归一化 ⇒ "CRLF 保真"在今天不可能成立（不是复制的问题）。
5. **仅暗色主题**；亮色主题下覆盖层的对比度/描边未量。
6. `overlayStyledFor` 只在**换格**时重读 computed style ⇒ 活动期间 td 尺寸变化（图片加载/resize）会让补偿值过期。
7. 多行文本盒/含图格的预览锚点：**随 Q15 去预览而失效**（不再适用）。
8. `range-x` 判据余量最薄（dx=3.89 对容差 4.391，仅 0.501px）—— 它量的是覆盖层里源码原文的前导空格宽，不是缺陷。

## §5 口径纠正（复核线推翻的说法，勿再沿用）

1. ~~「格内多行粘贴会让焦点掉到 BODY」~~ —— **真实输入通道下未复现**：对照臂里文档确实被切坏（目标行被拆行、该行只剩 2 格），但 `activeElement` 始终是 `.mp-cell-overlay-text`、覆盖层一直可见。对外只说"会把表格切开"，不写焦点丢失（`alpha-verify-a5\A5.md`）。
2. ~~「多出来的格会表现为多一列」~~ —— 用户可见病象是**最右列内容凭空消失 + 冒出一个空格子**：`TableRowWidget.toDOM()` 的循环上界是 `this.widths.length`（表头列数），某行被劈成 4 格时只渲染前 3 格（实测渲染 `["甲内容","","b"]`、丙内容不见了）。Release 措辞已按此改。
3. **方法学**：`A4c` 那类"行判据"改动**截图不敏感**（base 与突变臂的 PNG 逐字节相同，SHA256 `523222241c73485e`）——`toDOM` 按表头列数出格。这类改动的验收必须以**源码/产物读数**（`scanTables` 表数、导出件 `<table>` 计数）为准，截图只作辅助。
4. **判定经验**：`event.defaultPrevented` **不能**当"粘贴处理是否插手"的判据（CM6 自己也会 preventDefault）；"格内粘贴转义"的对照臂**只注掉一处不会红**——A4b 的写入口转义会兜住，两处防线（现同为 `/(?<!\\)\|/g`）必须同源。



## §6 装机端到端验收（3.0.2 portable EXE，`realmachine\verify-alpha.cjs`）

命令：`node Typora-Editor-App\scripts\acceptance\app-slot.cjs -- node E:\MarkPilot\.mp-verify\table-research\realmachine\verify-alpha.cjs`
（**必须用绝对路径**：app-slot 会按它自己的 cwd 解析相对路径，本轮踩过一次 `MODULE_NOT_FOUND`。）

**结果：12/12 全绿**（判据表 + 截图在 `.mp-verify\table-research\realmachine\{alpha-verify.json,shots-alpha}\`）：

| # | 判据 | 实测 |
|---|---|---|
| S1 | 表格渲染成行 widget | `table.mp-row`=5、格=15 |
| S2 | 点格＝原地编辑 | Δw=Δh=**0**、`border 0px`、`box-shadow none`、**无预览节点**（Q15） |
| S3 | 格内 `Ctrl+Enter` 加行且不劈表 | 行 12→13、行 widget 5→6、**分隔行上下仍紧贴表行** |
| S4 | 表外 `Ctrl+Enter`（对照） | 13→14 行，默认键位没被抢 |
| S5 | `Tab` 逐格 | 覆盖层 x 46→738、文本 `苹果`→`12` |
| S6 | 表尾 `↓` 出表 | 覆盖层收起、光标落到表外那行（`isTableRow=false`） |
| S7 | 格上右键 + 命令锚在被点的格 | 7 项菜单；点「删除本行」删的是被点的「末行」行 |
| S8 | 左外侧 1px 右键（回归） | 菜单仍出现 |
| S9 | 正文右键 | 无表格菜单 |
| S10 | 格内多行粘贴 | 被拦下、**文档逐字节不变**、浮层仍在、提示文案正确 |
| S11 | IME 组字中按 `Tab` | 文档不变、浮层仍在、组字串 `nihao` 保留 |
| S12 | 格内敲 `\|` | 落地 `\|`、列数不变 |

**两个判据自身写错、行为其实是对的**（记下来避免下次误报）：① S6 原来写死"光标必须落在『表格后正文』那行"，而前几步（S3 加行、S4 表外插空行）已经改了那张表后面的行 ⇒ 改成"浮层收起 + 光标那行不是表行"；② 点格**不落 CM 选区**，所以不能用"按 ↓ 前的 CM 位置"当基线。

**发布件**（`MarkPilot-CM6\dist\`，`dist-fresh.cjs` 8 闸全绿，EXE 内 `app.js` 与源码构建逐字节相同）：

| 文件 | 字节 | sha256_16 |
|---|---|---|
| `markpilot-cm6-3.0.2-portable.exe` | 82,694,412 | `f62fd1d69520f3a5` |
| `markpilot-cm6-Setup-3.0.2.exe` | 82,953,155 | `4997384c043c969e` |

## §7 能量闸门（`e3\run-gates-3.0.1.ps1 -Tag 3.0.2`，两侧各三枪）

| 侧 | 键入小/169K/492K | 四扫描 | 打开 | 内存 | 滚动 | 判定 |
|---|---|---|---|---|---|---|
| plugin | 16 / 15.9 / 115（中位） | **26**（上限 22.995） | 353（上限 349.65） | 8.7 | 23.6 | 3/3 有 ✗ |
| exe（装机 portable） | 15.7 / 15.5 / 116.6 | **22.9** | 232 | 4.9 | 31.6 | 第 2/3 枪全绿；第 1 枪 ✗（`typing-492` 123.7 对 123.27、`scans-per-key` 23.1 对 22.995，均 +0.5%） |

**红项归因：环境/会话漂移，与本次改动无关（已做反证）** —— 四扫描里唯一上升的是 `scanInlineMarks`（基线 16.7 → 插件 20.5~22.1、桌面 17.3），而**它不在本次改动范围**；表格扫描 `scanTables` 恰好等于基线（2.3 / 2.2~2.4）。

反证做法（受控替换 + 强制还原）：把 `renderer-cm6\app.js` 临时换成**改动前的旧引擎** `8a2d908ca99bcc64`（3.0.1），在**同一台机器**上跑同一把尺两枪 ⇒ `scanInlineMarks` **20.8 / 21.2**、`scanTables` 2.2 / 2.4，且**两枪同样判"存在退化项"**。现包读数（20.5 / 22.1）与旧包同带 ⇒ 不是 α 引入的退化。跑完已把现包还原并用 sha256 校验一致（`30effdae7b5c1a61`）。

**环境说明**：本机同时跑着用户端 Edge / DSH Web 等（浏览器类进程 10 个），该档 `scanInlineMarks` 的 `max` 出现过 85.9 / 92.4ms 的离群 ⇒ 这把尺在当前机器上**噪声大于 5% 的判限**。建议后续把 `e3\baseline.json` 的扫描项按"安静机器 + 多轮中位"重采一次（**属于工具口径，不是产品问题**）。

## §8 发布记录（v3.0.2-cm6）

| 项 | 值 |
|---|---|
| Release | https://github.com/ltmroberthk915/markpilot/releases/tag/v3.0.2-cm6 |
| 标题 | `MarkPilot CM6 3.0.2（独立桌面版）`（与 3.0.1 同一体例） |
| 状态 | 非 draft、非 prerelease、**Latest**（列表首条） |
| 说明正文 | 取 `Typora-Editor-App\docs\RELEASE-3.0.2-CM6.md`；回读比对**文本一致**（本地 2,077 / 远端 2,078 字符，差 1 为末尾换行规范化） |
| 资产 | `markpilot-cm6-3.0.2-portable.exe` 82,694,412 B `f62fd1d69520f3a5…`｜`markpilot-cm6-Setup-3.0.2.exe` 82,953,155 B `4997384c043c969e…` |
| 回读比对 | **两个资产都逐字节相符**（`gh release download` 回读后 sha256 与本地发布件、与发布前基线三方一致；回读临时件 165,647,567 B 已删） |
| 本地提交 | `c35909c01`（α 全部改动）、`4b522fd96`（复核段与闸门结论）、`fbda7d359`（发布记录）｜分支 `stability`，**仓库无 remote ⇒ 只有 Release 资产在 GitHub，分支未推送**（与 3.0.1 同） |
| 命令 | `gh release create v3.0.2-cm6 -R ltmroberthk915/markpilot --title "MarkPilot CM6 3.0.2（独立桌面版）" --notes-file <RELEASE md> --latest <两个 exe>`。**注意**：本地无 git remote，所有 `gh` 命令都必须带 `-R ltmroberthk915/markpilot`；另注意 PowerShell 变量大小写不敏感（脚本里用 `$r` 做循环变量会把仓库变量 `$R` 冲掉，本轮踩过一次）。 |

## §9 复现命令

```powershell
# 引擎重建 + 同步（改 src-cm6 后必做；不重建就跑套件＝拿旧字节出假绿）
cd E:\MarkPilot\dsh-markpilot
node node_modules/esbuild/bin/esbuild src-cm6/main.js --bundle --format=iife --outdir=renderer-cm6 `
  --entry-names=app --asset-names=fonts/[name]-[hash] --loader:.woff=file --loader:.woff2=file --loader:.ttf=file --minify
cd E:\MarkPilot\MarkPilot-CM6; node scripts/sync-engine.mjs

# 切分口径（A4a/A4b）：base 应全绿、mut 应红
node E:\MarkPilot\.mp-verify\table-research\alpha-verify-a4\scripts\a4-verify-a4b.cjs

# 重建计数（A6）：纯选区 0 重建、输入 1 字符 13 重建
node E:\MarkPilot\.mp-verify\table-research\arch\mut-rebuild.mjs

# 既有套件
node E:\MarkPilot\.mp-verify\export-table\scripts\probe-table.cjs
node E:\MarkPilot\.mp-verify\exporttypo\typo-parity.cjs
node E:\MarkPilot\.mp-verify\print\print-layer.cjs
node E:\MarkPilot\.mp-verify\exportux\export-ux.cjs

# 出包后（需 app-slot 锁）：两侧三枪 + 装机 PDF 冒烟 + 打包对账
node E:\MarkPilot\scripts\acceptance\app-slot.cjs -- <命令>
```
