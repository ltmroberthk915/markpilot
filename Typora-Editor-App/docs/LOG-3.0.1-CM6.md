# LOG-3.0.1（独立桌面版 · 内部记录）

本文件是 `MarkPilot CM6 3.0.1` 的内部验证记录（面向用户的说明见 `RELEASE-3.0.1-CM6.md`）。

以下哈希与体积均为**装机件实测值**（取值命令见 §二）。
本文件引用的证据路径全部在 `.mp-verify/` 下，落笔前逐条核对存在（见 `docs/DRAFT-NOTES.md`）。

## 一、产物与校验

- 工程目录：`E:\MarkPilot\MarkPilot-CM6`（与 2.x/VSIX 线独立）。
- 编辑内核：`dsh-markpilot/renderer-cm6/` 经 `MarkPilot-CM6/scripts/sync-engine.mjs` 只读同步到 `renderer/cm6/`；两侧 `app.js` 逐字节同一份。
- §十 那次独占窗口内**产品未被改动**：`.mp-verify/rig/WINDOW-1-RUNS.md` §1 记录两份 `app.js` 跑前 / 跑中 / 跑后 sha256 全程同为 `FEF389E8…`（1107733 B）。**该窗口之后引擎又前进过三轮**（审计判据修复、死代码手术、导出静音与导出件卫生、导出图片地址二次转义修复）⇒ §十 的读数只对 `FEF389E8` 那一版负责，最终发布件锚定 `F62AD539…`（1108898 B），见 §十四。
- 产物（`MarkPilot-CM6/dist/`，2026-10-07 18:38 构建）：`markpilot-cm6-3.0.1-portable.exe` 82692324 B / sha256 `bcffcf755cb0632bb276572f09d1af74b56e9d565d7c2e9ef4996456fa2180e0`；`markpilot-cm6-Setup-3.0.1.exe` 82951056 B / sha256 `e79194519e3b9fbf00be853d2baead3e0d5361a63764da0bf5bb9235f96dbd1b`；应用侧引擎抄本（`renderer/cm6/app.js`）1108898 B / sha256 `f62ad5398ebf57529f15d5931a4bd6169a8edcda88de1fd979f897ce05a6930f`。
- 版本号：`MarkPilot-CM6/package.json` = `3.0.1`（`productName: MarkPilot CM6`）。
- **装机件标记核对**（`.mp-verify/docs/probe-asar-markers.cjs`，扫 `dist/win-unpacked/resources/app.asar`，只读）：重建后重跑：`text-wrap:pretty` ×**0**（该声明本版已按 §六 的实测结论从导出 CSS 移除）、`line-break: strict` ×1、`text-align: justify` ×1、`file:readBase64` ×2（main + preload）、`win:fullscreen` ×2、`toggleFullscreen` ×3、`readFileBase64` ×4、`<thead>` ×1（生成器里的字面量；导出件实测产出 8 个，见 §四）、`--mp-font-body` ×13。`app.asar` sha256 = `eed24324e044cf49afe11c527dd1b02c9dfa1ff233bbd97e2de936b93819de1d`、2377658 B ⇒ 装机件不是旧引擎。

## 二、占位符取值命令

```powershell
Get-FileHash E:\MarkPilot\MarkPilot-CM6\dist\markpilot-cm6-3.0.1-portable.exe -Algorithm SHA256   # → {{PORTABLE_SHA256}}
Get-FileHash E:\MarkPilot\MarkPilot-CM6\dist\markpilot-cm6-Setup-3.0.1.exe    -Algorithm SHA256   # → {{SETUP_SHA256}}
Get-FileHash E:\MarkPilot\MarkPilot-CM6\renderer\cm6\app.js                   -Algorithm SHA256   # → {{ENGINE_SHA256}}
(Get-Item E:\MarkPilot\MarkPilot-CM6\dist\markpilot-cm6-3.0.1-portable.exe).Length                  # → {{PORTABLE_BYTES}}
(Get-Item E:\MarkPilot\MarkPilot-CM6\dist\markpilot-cm6-Setup-3.0.1.exe).Length                     # → {{SETUP_BYTES}}
```

> 参考：3.0.0 的 portable / Setup / asar 指纹为 `44004b2529ea823c`（82687882 B / 78.86 MB）、`53129ae09e7ff46f`（79.10 MB）、`a31ee63099a20879`（见 `docs/LOG-3.0.0-CM6.md` §六）。本版便携件 82692350 B，比 3.0.0 **大 4468 B**（基本持平）——不要沿用 3.0.0 的任何读数。

## 三、本版改了什么（逐条 / 证据在哪）

| # | 改动 | 证据路径 | 关键读数 |
|---|---|---|---|
| 1 | 导出 HTML/PDF 的表格补齐表头语义：`<thead>/<th>` + `<tbody>` | `.mp-verify/export-table/out/readings.json`、`.mp-verify/export-table/out/exported/base__00-main-tables.body.html`、`.mp-verify/export-table/out/DIGEST.md` | `<table>`=8 / `<thead>`=8 / `<th>`=17 / `<tbody>`=8 / `<td>`=25 / `<tr>`=19 |
| 1b | 同一支探针的**突变臂**（生成器改回 `<table>`+`<td>`）必须变红 | `.mp-verify/rig/logs/C10-export-table.txt`、`.mp-verify/export-table/out/exported/mut__00-main-tables.body.html` | mut 臂 `thead=0 / th=0 / tbody=0 / td=42`；`base 全绿=true | 红项=17（全部在 mut 臂）` |
| 1c | 富文本复制（→ Excel）的表头样式一并补上 | 同上 `C10-export-table.txt` 的 M19 | `<th>` 样式命中 17 个、`<td>` 命中 25 个、`bareTh/bareTd` 均为 0；`thead/tbody` 结构保留 8/8 |
| 2 | 导出页自带同源字体变量（`--mp-font-latin/han/body/mono`） | `.mp-verify/export-table/out/exported/base__00-main-tables.full.html`（第二个 `<style>` 的 `:root` 块） | 导出件里逐字出现 `--mp-font-body: var(--mp-font-latin), var(--mp-font-han), serif;` 与 `body{…font-family:var(--mp-font-body)…}` |
| 2b | 字体真的可用（不是只写了名字） | `.mp-verify/rig/logs/B4a-exporttypo-base.txt`、`.mp-verify/exporttypo/result-typo.json` | `P2`：`cmSelectorHits:0, kai:true, sizeAdjust:true, autospace:true, snapshot:true, bytes:30536`；`P3`：`exportHas{bodySize14:true,measure1280:true,kaiEm:true,kai:true,sizeAdjust:true}`、`sameSource:true` |
| 3 | 导出页 `text-wrap:pretty` —— **本版移除** | `.mp-verify/docs/textwrap-pretty.json`、`.mp-verify/rig/logs/WINDOW-1-RUNS.md` | §六 实测 135 组零分歧（行数与末行逐档逐字相同）⇒ 该声明不产生可观测收益，本版从导出 CSS 删掉；装机件标记扫描 `text-wrap:pretty` = 0（§一） |
| 4 | 阅读态 `line-break:strict` + `text-align:justify`（只阅读态） | `dsh-markpilot/renderer-cm6/app.js`（`[data-mp-reading="1"] .cm-content` 规则，两处声明各出现 1 次）、`.mp-verify/rig/logs/B8a-reading-base.txt`、`.mp-verify/reading/result-reading.json` | 声明带 `[data-mp-reading="1"]` 前缀 + `!important`；R1 编辑态 / R3 阅读态 / R5 退出三态读数见日志；全 bundle 无编辑态同类声明 ⇒ 编辑态不动 |
| 5 | 桌面版全屏通道 | `MarkPilot-CM6/main.js`（`ipcMain.handle('win:fullscreen')`）、`MarkPilot-CM6/preload.js`（`toggleFullscreen`）、`.mp-verify/rig/logs/A2-deadbtn.txt` | `F3`：`{"calls":["toggleFullscreen"],"toast":"已进入全屏（再点退出）"}`、exit 0 |
| 6 | 桌面版 `file:readBase64` 资源读取路径 | `MarkPilot-CM6/main.js`（`ipcMain.handle('file:readBase64')`）、`MarkPilot-CM6/preload.js`（`readFileBase64`）、本文件 §七 的 `file:readBase64` 条目 | 既有 `expmath` 读数（本版未重跑，见 §十二 第 7 条）：`A1` 宿主通道 21 次读取；`A3/A4/A6` 20 条 `data:font/woff2` 且逐个可加载 |

## 四、表格语义验证（真链路）

链路：试验台 → `handler.emit('open')` → 引擎 boot → `mpExtras.exportHtml()`（经 IPC 分块 `begin/append/finish` 拼回整份导出件）→ 在**导出件正文**上判表格语义。素材 8 张表覆盖标准 GFM、仅表头、无分隔行退化、表后接列表/引用、EOF 无换行、单元格含行内代码与公式。

| 判据 | base | mut（预置突变臂） |
|---|---|---|
| `<thead>` 数 = 有表头表数 8 | ✓ | ✗ `{"thead":0}` |
| `<th>` 数 = 表头单元格 17 | ✓ | ✗ `{"th":0,"expect":17}` |
| `<tbody>` 数 = 表数 8 | ✓ | ✗ `{"tbody":0}` |
| `<td>`=25 / `<tr>`=19 | ✓ | ✗ `{"td":42}`（表头被算进表体） |
| 每表一级子元素序列 = `[thead, tbody]` 且配对 | ✓ | ✗ 全部退化成 `[tr,…]` |
| copyRich 表头样式命中 | ✓ 17/25，无裸 `<th>/<td>` | ✗ `thStyled:0` |
| 良构栈扫描（未闭合/错配/非法嵌套） | ✓ 全干净 | ✓（该扫描器**故意**不报"旧版式 tr 直挂 table"，语义判据负责抓） |

判定：`base 全绿=true | 红项=17（全部在 mut 臂）`。扫描器自带 6 条负控（S01–S06）证明它该红时红、该沉默时沉默。

## 五、导出件字体同源验证

- 导出件（`base__00-main-tables.full.html`，373718 B）的 `<style>` 里，字体变量与正文 CSS 同源：`--mp-font-latin` / `--mp-font-han` / `--mp-font-body` / `--mp-font-mono` 四条**在导出页自己声明**，`body` 与 `code` 分别消费 `var(--mp-font-body)` / `var(--mp-font-mono)`；同一次导出仍内联 20 个 KaTeX 字体（`data:font/woff2`）。
- 判据侧（`exporttypo`）：`P1` 编辑面注入 CSS 8/8 逐字符相同（零回归）；`P2` 导出件零 `.cm-` 选择器且含 kai / size-adjust / autospace / token 快照；`P3` 同源不变式 `bodySize14 / measure1280 / kaiEm1.18 / sizeAdjust97%` 两侧齐备、`sameSource:true`；`P4` 导出件公式为真 KaTeX。
- **同族副作用面（必须知情）**：导出页 `body{text-autospace:normal}` 在装机 runtime（Chromium 130）里是**死属性**（解析期即被丢弃，`CSS.supports`=false），在 Chromium 154 上才是活的 ⇒ 编辑面与导出页在这一条上天然不一致。取证见 `.mp-verify/kp/AUTOSPACE.md`。本版**不**把"中西文自动间距"写进对外说明。

## 六、导出页 `text-wrap:pretty` 的行数/孤行实测（**结论：测不出收益，故不作对外声称**）

探针：`.mp-verify/docs/probe-textwrap-pretty.cjs`（Playwright headless Chromium 145，只读，不启动产品、不占 app-slot）。
夹具：`.mp-verify/docs/textwrap-pretty.html` —— 正文 CSS 与导出件 `body` 同源，三臂只差 `text-wrap` 一条。
读数：`.mp-verify/docs/textwrap-pretty.json`。

| 项 | 读数 |
|---|---|
| 对照臂取值口径 | 实测 `text-wrap:normal` **不是合法值**（`CSS.supports`=false，解析期丢弃落到 `wrap`）⇒ 对照必须用 `text-wrap:wrap`，不能用 `normal`/`auto`（两者实测都落回 `wrap`） |
| pretty 是否真的生效 | 是：`getComputedStyle` 侧 `prettyComputed="pretty"`、`baselineComputed="wrap"`，`CSS.supports('text-wrap','pretty')`=true |
| 扫描范围 | 3 段中文（长段 / 标点密集段 / 中英混排段）× 宽度 560–1000px 每 10px 一档 = **45 档 × 3 段 = 135 组** |
| 分歧组数 | **0**：`diffCount=0`，`anyLineIncrease=false`、`anyLineDecrease=false`、`anyLastLineShorter=false` |
| 行数 | 每段在每档下 pretty 与 wrap **行数相同**（例：S1 在 560px 两臂都是 3 行、末行 29 字；1000px 都是 3 行、末行 13 字；S2 在 1000px 都是 3 行、末行 5 字） |
| 结论口径 | 「行数不增加」在本扫描范围内**与事实一致**；「孤行改善」在本扫描范围内**没有观测到**（两臂逐档逐字完全相同）。方向性提示：同一次诊断里 `text-wrap:balance` 在 headless Chromium 145 下同样零效果（`.mp-verify/docs/diag-textwrap3.cjs` 的 `balanceDiffers:false`），怀疑该 runtime 的 `pretty` 对中文/当前语料不产生断点重排 ⇒ **本版不把孤行改善写进对外说明**；要恢复这条声称，需在装机 Chromium 130 上另做一轮端到端取证 |

## 七、阅读态与桌面版通道

- **阅读态两条声明**（`app.js` 的 `[data-mp-reading="1"] .cm-content` 规则，均在阅读态规则块内、均带 `!important`）：
  `line-break: strict !important; text-align: justify !important;`。全 bundle 中 `line-break: strict` 出现 **1** 次、`text-align: justify` 出现 **1** 次，且都在这条带 `[data-mp-reading="1"]` 前缀的规则里 ⇒ 编辑态无同类声明。
- **阅读态三态读数**（`.mp-verify/rig/logs/B8a-reading-base.txt`，base 臂全绿）：R1 编辑态 `font:14px / lh:25.2px / maxW:none`；R3 阅读态 `font:16px / lh:31.2px / maxW:780px / stroke:0px`，工具栏与 H 徽标隐藏、出口胶囊显示；R5 Esc 退出回到编辑态读数。**未覆盖**：本探针只读字号/行距/版心/描边，没有读 `line-break` / `text-align` 的 computed 值，且其 viewport 为 1280（宽视口下编辑器可用宽可能低于 780 的 `max-width` 阈值）⇒ 这两条目前是**源码级确证 + 条件式作用域确证**，端到端体现留作待补（见 §十一）。
- **桌面版全屏**：`main.js` 的 `win:fullscreen` 句柄（`BrowserWindow.setFullScreen`，返回新状态）；`preload.js` 暴露 `toggleFullscreen`；判据 `F3` 实测 `calls:["toggleFullscreen"]`、提示「已进入全屏（再点退出）」、exit 0；插件形态下 `F4` 如实提示「全屏需要桌面版」，不假装成功。
- **`file:readBase64`**：`main.js` 的 `file:readBase64` 句柄（`fsp.readFile` → base64 + bytes，asar 感知），`preload.js` 的 `readFileBase64`。动机写在源码注释里：Chromium 禁 `fetch(file://)`，离线导出要内联 KaTeX 字体必须走宿主 fs 通道。判据侧：`expmath` 的 `A1/A3/A4/A6` 见 LOG-3.0.0-CM6 §六同族条目；本版复核未重跑该套件（见 §十一）。

## 八、判据鉴别力审计（`audit/RULER-AUDIT.md`）

- 审计对象：`.mp-verify/` 下 15 个验收脚本（2026-10-07 15:20–15:55）。纪律：只读产品代码，只写 `audit/`，未启动共享服务、未占 app-slot、未接管键鼠。
- **挖出 12 条恒真/空洞判据（B 类）、11 条测错东西的判据（C 类）**。逐条归类与突变证据在原文 §1.1–§1.15；B/C 的"该怎么改成能变红"在 §3；"最危险的 5 条"在 §2。
- 典型样例（B）：`C1 8 套配色连点 5 次逐次幂等` —— 把写者换成 no-op（画面永不变化）后仍绿，因为它只要求"每次读到的字符串相同"。
- 典型样例（C）：`C5 版心按容器宽算（左右 padding 对称）` —— 实测基线两侧本就 **不对称**（`{"l":"46px","r":"28px"}`，因为规则是 `max(46px,…)` 与 `max(28px,…)`），该判据仍绿 ⇒ 真正生效的是它第二个子句。
- 审计自身的口径边界（原文 §0.0/§0.1/§5 明确写出）：审计中途产品被另一条线重建两次，故 15:56 用同一快照把 11 个可跑脚本整体复跑（`audit/mutants/logs/FINAL__*.txt`），判定序列与各自首次基线逐条相同；共享夹具当时是 730 B 残缺版，导致 `export-ux` 的 X5/X6/X7 与 `deadbtn` 的 F3 报红（**夹具问题，非产品问题**，见 §九）。

## 九、验收基座加固（`rig/RIG-HARDENING.md`）

1. **共享夹具恢复 + 根因堵口**。`expmath/page/harness.html` 曾被改写成 730 B 残缺版（只剩 `host=1` 分支，`host=export` 整块消失），恢复为 2134 B 三分支齐全；并堵住**根因**：覆盖它的正是 `expmath/probe.cjs` 自己（"缺失才补"的写入路径），已改成不再回写共享夹具。恢复后 `rig/fixture-selfcheck.cjs` 绿（T1–T6 / B1–B6），三个故障副本红态各自指名（`rig/redcheck-*.html`）。
2. **9 条突变臂纳管**（`rig/port-mpmut.cjs` 注入 `MPMUT` 开关，`rig/PORT-MANIFEST.json` 记纳管前后 sha256，`rig/mpmut-selfcheck.cjs` 做注入实效自检）。纳管不变式三条全过：默认路径逐字节不动 8/8、`--restore` 回滚后 8/8 == 纳管前 sha、`--write` 后 8/8 == 纳管后 sha。
3. **`e3/gate.cjs` 退出码缺口已修**：此前 `process.exit(0)` **恒 0**，任何拿退出码当闸门的下游都会把"能效退化"读成"通过"（审计 §1.15 第 514 行指出）。现改为 `process.exit(result.allPass || process.argv.includes('--no-fail') ? 0 : 1)`，源码里留了承重注释；"只读数不判死"须显式加 `--no-fail`。
4. **一个必须知情的发现**：审计留在 `audit/mutants/**` 的 11 个突变副本是**旧版脚本**，不能照抄复用（`rig/RIG-HARDENING.md` §3.5，`mk.cjs` 现会 `exit 2`）；纳管走的是"把载荷内联进现行脚本"的路子。
5. **一处与预期不符已如实上报**：`islandOffscreen` 的 J9 **未红**（文档原写"J3+J9"），机制是 `translateX` 不产生溢出宽度；原文 §4.4 只报事实、不改判。

## 十、独占验证窗口复跑（23 次，真回归 0 条）

执行器：`rig/run-one.ps1`（串行、逐条落盘），原始输出 `rig/logs/*.txt`，机读索引 `rig/logs/index.tsv`（23 行），汇总 `rig/WINDOW-1-RUNS.md`。

| 组 | 内容 | 结果 |
|---|---|---|
| A（夹具恢复后应转绿） | `exportux/export-ux.cjs`、`exportux/deadbtn.cjs` | **2/2 按预期转绿**：X5/X6/X7 与 F3 全 ✓，exit 0；对照审计 FINAL 的同样条目是红 ⇒ 这两组判据对"夹具缺失"确有鉴别力 |
| B（9 条突变 × 对照+突变） | theme / expmath / exporttypo / print / island / settings / reading / kp | **8 条实测变红**（红项 ID：C1+C2、C2+C5、A1/A4/A6、P1–P4、A2、J3、S6、R7）；第 9 条 `kpFilterBlind` **无红**（K3 仍绿），与审计"无鉴别力"结论一致，如实登记 |
| C（默认路径无回归） | theme / expmath / exporttypo / print / island / settings / outline-probe / outline-unify / reading / export-table / kp-test | **真回归 0 条**；仅两条**既有红**：`settings` 的 S3（判据写"2 组 × 2 项 = 4 个"，产品现为 3 组 6 个 ⇒ 判据过期）、`kp-test` 的 K4（与 `knuth-plass.js:74` 产品注释矛盾）。两条与审计 FINAL 逐字节相同 |
| 同一 bundle 归因 | 跑前/跑中/跑后 `app.js` sha256 | 全程 `FEF389E8…` 未变 ⇒ 无需拆分归因 |

> 锚点说明：上表整轮跑的是 `FEF389E8…`（1107733 B）。此后引擎又前进（判据修复、死代码手术、导出静音与导出件卫生）并重新打包，发布件锚定 `64E0F2E2…`（见 §十四）⇒ §十 的结论只对 `FEF389E8` 负责，不自动继承。

口径注记：C 组 10 个套件里 8 个的"默认路径 1 次"与 B 组各自的对照跑是同一条命令，不重复；`outline-probe` 与 `unify` 分两行故多跑 1 次 ⇒ 合计 **23** 次。
`kp-test` 的 K5（计时项）本窗口按纪律跳过、不计入结论；`e3/gate.cjs` 与 `island/exe-accept.cjs` 等需装机件 + `app-slot` 锁的套件不在本窗口范围（原文 §6）。

## 十一、复跑命令（逐条可照抄；工作目录 `E:\MarkPilot`）

```powershell
# 表格语义（base 臂 + 预置突变臂各一遍，探针内部都跑）
node E:\MarkPilot\.mp-verify\export-table\scripts\probe-table.cjs

# 导出排版同源 / 零回归（P1–P5）
node E:\MarkPilot\.mp-verify\exporttypo\typo-parity.cjs

# 纸面墨色（打印层）
node E:\MarkPilot\.mp-verify\print\print-layer.cjs

# 阅读模式（R1–R10）
node E:\MarkPilot\.mp-verify\reading\reading-probe.cjs

# 导出 UX（X1–X12）与死按钮（F1–F5）—— 依赖共享夹具的 host=export 分支
node E:\MarkPilot\.mp-verify\exportux\export-ux.cjs
node E:\MarkPilot\.mp-verify\exportux\deadbtn.cjs

# 带突变臂复跑（示例；其余 8 条同形）
$env:MPMUT='themeNonIdem'; node E:\MarkPilot\.mp-verify\theme\theme-probe.cjs

# 基座静态自检（不需要浏览器）
cd E:\MarkPilot\.mp-verify
node rig\fixture-selfcheck.cjs
node rig\fixture-selfcheck.cjs rig\redcheck-no-exportpdf.html   # 红态：应 exit 1 并指名 exportPdf
node rig\port-mpmut.cjs --check
node rig\mpmut-selfcheck.cjs
node rig\verify-manifest.cjs after

# 导出页 text-wrap 实测（本文件 §六）
node E:\MarkPilot\.mp-verify\docs\probe-textwrap-pretty.cjs

# 能效闸门（需独占：产品 HTTP 服务占固定端口；EXE 侧注意 --port 与 e3/gate.cjs 内的 EXE 常量已指向 3.0.0，回填 3.0.1 前先改）
node E:\MarkPilot\.mp-verify\e3\gate.cjs --side plugin --out gate-result-plugin.json
node E:\MarkPilot\.mp-verify\e3\gate.cjs --side exe --out gate-result-exe.json --port 9411
```

## 十二、本版边界与待补（不写"应该没问题"）

1. **`text-wrap:pretty` 的对外收益未取证**：行数不增加在本扫描范围内成立，孤行改善未观测到（§六）。对外说明里本版不提这一条；若要提，先在装机 Chromium 130 上补一轮端到端读数。
2. **阅读态两条属性的端到端 computed 读数未采集**：`reading-probe.cjs` 不读 `line-break`/`text-align`，且其 1280 viewport 可能低于 `max-width:780px` 的触发阈值。要收口，需在 ≥900px 的编辑面宽下补读一次 `getComputedStyle(.cm-content)` 的两条值。
3. ~~`e3/gate.cjs` 的 EXE 常量指向 3.0.0~~ —— **已修**：`const EXE` 改成「环境变量 `MP_GATE_EXE` 优先，否则取 `dist/` 里最新的 `markpilot-cm6-*portable.exe`」，不再写死版本号；本版三枪用 `e3/run-gates-3.0.1.ps1` 串行跑，EXE 侧经 `app-slot` 取锁。
4. **两条既有红未处置**：`settings` S3 判据过期（写成 4 个滑杆，产品 3 组 6 个）、`kp-test` K4 与产品注释冲突（`kp-test.cjs` 因此退出码恒 1，**不能**用它当"KP 套件通过"的证据）。处置建议见 `rig/WINDOW-1-RUNS.md` §8。
5. **`kpFilterBlind` 无鉴别力**：审计与复跑两次都实测造不出红；K3 需要改成基于 `items` 断点的检查，或正式登记"K3 无鉴别力"。
6. **`islandOffscreen` 的 J9 期望需修正**：实测只有 J3 红（`rig/WINDOW-1-RUNS.md` §4.4）。
7. **未重跑的套件**：`expmath/probe.cjs`（`file:readBase64` 侧的 A1–A6 读数取自 `rig/logs/B3a-expmath-base.txt` —— base 臂全绿：`{host:21,fetch:0}`、`embedded:20/failed:0`、`dataFonts:20`、`faceLoaded:20/faceFailed:[]`，并带 `B1` 突变臂对照，见 §九；本窗口只补跑了它的突变臂）、`island/exe-accept.cjs`、`kp/pretty-*` 计时腿。
8. **README 本版不动**（结论）：`Typora-Editor-App/README.md` 是 1.0.x 个人版线的产品页，与 CM6 线无引用关系；不改即不涉及「只增不删」，无需 `verify-readme-keep.cjs` 出证（该脚本真实路径是 `Typora-Editor-App/scripts/verify-readme-keep.cjs`）。

## 十三、证据索引（全部已核对存在）

| 路径 | 内容 |
|---|---|
| `.mp-verify/export-table/out/readings.json` | 表格语义全量读数（含 `productApp` 段：sha256 + 1107733 B） |
| `.mp-verify/export-table/out/DIGEST.md` / `TABLE-SEMANTICS.md` | 表格语义摘要与规格 |
| `.mp-verify/export-table/out/exported/base__*.body.html` / `mut__*.body.html` | 两臂导出件正文（逐字节可比对） |
| `.mp-verify/export-table/out/exported/base__00-main-tables.rich.html` | copyRich 产物（表头样式命中证据） |
| `.mp-verify/exporttypo/result-typo.json` / `SPEC.md` / `editor-rules-before.json` | 导出排版同源判据、规格、重构前规则快照 |
| `.mp-verify/print/result-print.json` / `out/print-check.html` | 纸面墨色读数与受测页 |
| `.mp-verify/reading/result-reading.json` / `shots/reading-beige.png` | 阅读模式读数与截图 |
| `.mp-verify/exportux/result-export-ux.json` / `export-ux.cjs` / `deadbtn.cjs` | 导出 UX 与死按钮判据 |
| `.mp-verify/settings/result-settings.json`、`.mp-verify/theme/result.json`、`.mp-verify/outline/result-outline.json` / `result-unify.json` | 设置 / 主题 / 大纲回归读数 |
| `.mp-verify/rig/WINDOW-1-RUNS.md` / `RIG-HARDENING.md` / `logs/index.tsv` / `logs/*.txt` / `EVIDENCE.txt` / `PORT-MANIFEST.json` | 复跑汇总、加固记录、23 次原始输出与索引、自检汇总 |
| `.mp-verify/audit/RULER-AUDIT.md` / `audit/mutants/logs/FINAL__*.txt` | 判据鉴别力审计与审计基线输出 |
| `.mp-verify/e3/gate.cjs` / `run-gates-3.0.1.ps1` / `gate-3.0.1-{exe,plugin}-*.json` / `materials/big-492KB.md` | 能效闸门脚本、本版三枪执行器与读数、492KB 素材（`gate-after-exe-3.json` 是 **3.0.0 期**读数，仅作对照） |
| `.mp-verify/kp/AUTOSPACE.md` | `text-autospace` 死活鉴定（导出页与编辑面不一致的取证） |
| `.mp-verify/docs/probe-textwrap-pretty.cjs` / `textwrap-pretty.html` / `textwrap-pretty.json` | 本版 `text-wrap:pretty` 行数/孤行实测 |
| `.mp-verify/docs/probe-asar-markers.cjs` | 装机件（`dist/win-unpacked/resources/app.asar`）的本版改动标记扫描 |
| `.mp-verify/docs/DRAFT-NOTES.md` | 本文件各条证据的核对命令与输出、以及**没写进去的东西与原因** |

## 十四、发布件冻结（本轮手术 + 打包链）

- 冻结时刻：**2026-10-07 18:38** 构建（第二刀：修掉导出图片地址二次转义后重出）；引擎 `renderer/cm6/app.js` = 1108898 B / `F62AD539…`，与 `dsh-markpilot/renderer-cm6/app.js`、以及 `app.asar` 内那一份**三处逐字节相同**，并且**两个 EXE 载荷内部**也与它们逐字节相同（对账输出见下）。
- 冻结前落地的改动（逐条带判据）：
  1. **插件客户端半边删除 635 行实验残留**：`dsh-markpilot/lib/client.js` 66865 → 30904 B。删掉的是布局翻转 v1/v2、骨架扫描、对话宽度探针与快捷键、布局宽度滑杆，以及往 `http://127.0.0.1:19399/dump` 回传的**调试通道**。判据：被删区间定义过 106 个标识符，剪后 **0 个**仍被引用（`.mp-verify/clean/dangling-check.cjs`）；`node --check` 通过；被删区间的符号名 grep 全 0（`markpilot-main` 是有意保留的活代码，不在其中，见 §十六）。
  2. **导出件卫生（D-7）**：正文里唯一原样穿过转义的 `<img>` 改走「属性白名单 + style 子声明白名单」（style 只留 `zoom/width/height`，值限数字+单位；`on*` 一律不带出），markdown 图片语法的 `alt/src` 过属性转义。KaTeX 走占位符回填、不经过此处，因此公式样式不受影响。
  3. **导出 PDF 静音（D-6）**：`exportFolder` 支持 `opts.silent`（**只关提示**，返回值 / 统计 / 分块写盘 / assets 复制一律不动），PDF 路径由 `renderer/host.js` 显式传 `silent: true` ⇒ 用户不再看到指向 staging 临时目录的「已导出：…」吐司；普通「导出为文件夹」的提示照旧。
  4. **布局宽度滑杆死残留清除**：`src-cm6/extras.js` 再删 3630 B（`trackPush` / `trackSection` / `TRACK_MIN` / `TRACK_MAX` / `TRACK_FLOOR` / `trackSnap` / `trackStore` / `trackSaved` / `trackFmt` 与两个永不渲染的事件分支）；`mp-panel-mode` 的残留键清理保留。
  5. **导出图片地址二次转义（真回归，本轮发现并修掉）**：独立复核用 `![A & B](assets/a&b.png)` 定点复现 —— markdown 图片语法那条路处理的是**已经过 `esc()` 的整行**，第 2 条改动又套了一层 `attrEsc`，`&` 被二次转义成 `&amp;amp;`，导出件里该图 `naturalWidth=0`（图裂）；原始 `<img>` 那条路只转义一次、反而正常。修法：那一层收成**只转引号**的 `quoteEsc`（属性位注入的防护保留 —— `![" onerror="alert(1)](a.png)` 仍打不出事件处理器 —— 但不再二次转义）。修后两把独立的尺都转绿：换人写的 `review-d6-d7.cjs` **25/25**、原 `judge-exportfix.cjs` **30/30**。
- **打包链补上一处缺口**：`MarkPilot-CM6/scripts/dist-fresh.cjs` 现在包含此前**只在手工 pwsh 里做过**的「写图标/版本资源」一步（`package.json` 的 `win.signAndEditExecutable=false` 会让 electron-builder 跳过它）：同步引擎 → 清 dist → `--win --dir` → rcedit（icon + 文件版本 `3.0.1.0` / 产品版本 `3.0.1`）→ `--win nsis portable --prepackaged`，并**回读 exe 自己报的版本资源**，对不上即失败退出。本次回读：`MarkPilot CM6.exe|3.0.1.0|3.0.1|MarkPilot CM6|MarkPilot CM6 — Markdown 编辑器`。
- **打包对账**（`.mp-verify/pack/verify-pack.cjs --exe-probe`，作为 dist-fresh 第⑧步自动跑）：**8/8 全绿** —— ①asar 可读且引擎入口按实际结构定位；②`app.js` 三处同 sha（源码构建 == 同步目录 == asar 内）；③8 个「必须 0 命中」字符串在整包与包内 `app.js` 里全为 0；④asar 头部声明的 SHA256 == 实际字节（`f62ad5398ebf5752…`）；⑤源码构建与同步目录同组字符串全 0；⑥两个 EXE 的体积与 sha256 落档；⑦⑧**用 7za 拆开两个 EXE 的载荷**，证明「载荷内 `app.asar` == `win-unpacked` 的 asar（`eed24324…`，2377658 B）」且「载荷内 `app.js` == 源码构建的 `app.js`（`f62ad539…`，1108898 B）」—— 纯 node 的明文搜索证明不了这一环（electron-builder 用 LZMA2 压过）。该尺子自带 `--selftest`：**15/15**，含「同步目录翻 1 字节 / asar 内翻 1 字节 / asar 体事后改 1 字节 / 注入后门串 / 抽掉入口 / 8 条针脚逐条注入」等突变臂，且红必须是**进程级非 0**。
- **打包预检**（`.mp-verify/pack/preflight.cjs`）：PASS 10 / FAIL 0 / WARN 1（WARN 为 nsis-resources 的历史解包残留，不影响本次构建，**零联网**）。
- 两侧能效闸门的三枪读数与判定见 §十五。

## 十五、能效闸门（本版三枪，两侧分开）

执行器：`.mp-verify/e3/run-gates-3.0.1.ps1`（串行三枪；EXE 侧经 `app-slot` 取锁；素材每枪重取副本）。**锚定**：EXE = 便携件 `bcffcf755cb0632b`（82692324 B）；插件 = bundle `f62ad5398ebf5752`（1108898 B）。**六枪 `drifted` / `srcDrifted` 全 false**，同侧锚点一致 ⇒ 读数有效。

| 指标 | EXE 三枪 | EXE 中位 | 上限 | 插件三枪 | 插件中位 |
|---|---|---|---|---|---|
| 键入 p95 · 小文档 19.9KB | 16.8 / 15.5 / 15.9 | **15.9** | 17.325 | 15.8 / 14.6 / 15.4 | **15.4** |
| 键入 p95 · 169KB | 16.3 / 16.3 / 14 | **16.3** | 17.22 | 15.5 / 16.6 / 16 | **16** |
| 键入 p95 · 492KB | 117.6 / 114 / 116.3 | **116.3** | 123.27 | 111.1 / 108.9 / 111.1 | **111.1** |
| 每键四扫描 · 492KB | 22.9 / 23.4 / 22.7 | **22.9** | 22.995 | 25.5 / 25.2 / 25.3 | **25.3** |
| 打开→就绪 · 492KB | 230 / 236 / 226 | **230** | 349.65 | 345 / 345 / 362 | **345** |
| 内存增量 · 492KB | 5.4 / 5.1 / 4.6 | **5.1** | 22.11 | 7.3 / 7.9 / 7.4 | **7.4** |
| 滚动帧间隔 p95（参考项，只报不判） | 32.8 / 32.5 / 31.7 | 32.5 | — | 25.3 / 23.3 / 24.9 | 24.9 |

- **发布件（EXE）侧**：逐枪判定 = 第 1 枪全绿、第 2 枪 1 项 ✗（四扫描 23.4 ms，超上限 1.8%）、第 3 枪全绿；按三枪中位数（与 3.0.0 同一口径）**能效不低于基线**。
- **插件面（开发面，不是发布件）侧**：三枪都因 `scans-per-key` 判 ✗（25.2–25.5 ms，上限 22.995；第 3 枪 `open-ready` 362 ms 也超 349.65 一次）。这一项**不是本版引入**：本版更早一次读数（同一闸门、前一版引擎）是 25.7–26.5 ms，再往前的折叠改造那次是 25.9 ms，而基线 `21.9` 取自更早的 `.mp-verify/perf/REPORT-perf.md`（折叠改造之前）⇒ 折叠改造之后插件面的四扫描就一直在限外，本版没让它变差。发布件侧同一项 22.9，贴着上限（上限 = 基线 × 1.05）。
- 读数：`.mp-verify/e3/gate-3.0.1f-exe-{1,2,3}.json`、`gate-3.0.1f-plugin-{1,2,3}.json`（`3.0.1f` = 修掉导出图片二次转义之后的最终引擎）；前一版引擎的两组读数保留为 `gate-3.0.1-{exe,plugin}-*.json` 供对照。
- 口径声明：**没有**用 `--no-fail`。上表的 ✗ 是闸门自己判的，逐枪如实登记，不用中位数掩盖单枪红。

## 十六、本轮独立复核与如实登记的边界

- **导出件卫生 / 静音（D-6 / D-7）复核（两把独立的尺，都由别人写）**：①`.mp-verify/exportfix/EXPORT-LEFTOVERS.md` + `judge-exportfix.cjs`，四臂串行（`mut` / `shipped` / `fixed` / `naive`）**30/30 符合预期、exit 0**；②`.mp-verify/exportfix-review/REVIEW-D6-D7.md` + `review-d6-d7.cjs`，重搭四臂（`prod` / `base` / `naive` / `noimg`）**25/25、exit 0**，连跑 5 次稳定，并且**逐张看图**给出 9 条肉眼结论（缩放真的生效：600×300 的图 computed `zoom=0.33`、渲染 79.2×39.6；公式没被误伤：`aligned` 两行的 `=` 竖直对齐、`color` 生效、KaTeX 片段与未打补丁版本指纹逐字相同；没有全屏覆盖层：原 `position:fixed` 那张 computed `position=static`、在流里、`covers` 计数 0）。**这一把尺抓出了上面第 5 条那个真回归**（`&` 二次转义导致图裂），修完复跑转绿 —— 这正是"换人复核"该有的产出。①的 `mut` 臂（把 11 条改法逐条反向打回）上 C1 / C3 / C4 / C5 / C8 全红，出厂臂与修复臂全绿；①的反例臂（把 Typora 的 `zoom|width|height` 白名单照抄到整页）实测把 KaTeX 的 `verticalAlign / top / marginRight / color` 剥光、公式盒 50.3×21 → 40.8×21 px ⇒ 「不能整页 sanitize」有实跑依据。出厂 bundle 与源码构建**逐字节相同**。
- **死代码剪除的对抗复核**：`.mp-verify/clean/REVIEW-CUT.md`。六条风险里四条已证伪（`layout-tracks`、`chat-width` 都没有活发送方；宿主页面上四种残留形态刷新即重建；`lib/client.js` 不在引擎包内 —— 判据针脚 `sidebar.right.pane.tab`、`__DSH_MARKPILOT__` 在 `app.js` 里均 0 命中）。两个 profile 的 `node_modules/dsh-markpilot` 都是 Junction 指向本仓库 ⇒ 改动即生效。
- **四条如实登记**（不粉饰）：
  1. 这次删掉的**不全是**"从未生效"的代码：布局翻转（v1/v2）与 Alt+, / Alt+. 改宽在**诊断窗口**里真实生效过（`.mp-verify/layout-recon/` 的回传里 flip 1284/1397 份 `want:true`、chatwidth 26/26 写进模板）。它们是**默认关闭**的实验开关（`localStorage['mp-layout-flip']='1'` 或 URL 带 `#mp-layout-probe` 才动作），随本轮一并撤回；对外说明不提（从未随版本发布），但曾手工开启过的用户会看到行为消失。
  2. **热重载残留**（窄、自愈、**未实机复现**）：历史版本曾把外壳那条 grid 模板写成 `!important`；客户端 HMR 在不刷新页面时换入新代码，旧 `!important` 会继续压住外壳的无优先级写入 ⇒ 理论上可复现「点开右栏没反应」。刷新即自愈。**没有**为此加"摘掉 `!important`"的自愈：外壳自己也会用 `!important` 写模板，盲目摘会重新踩上「点开右栏：按钮消失、界面无变化」那个坑 —— 宁可不碰布局。
  3. **反向判据的用法要写清**：`dangling-check.cjs` 的"已声明集"是从被测文件现算的，所以"把整段贴回"这种突变体会**自我豁免**（复核实测仍报 0 悬挂）；有效的是**裸引用阳性对照**（只插一行不带声明的 `reconPost` → 报 `悬挂：reconPost → L437`、exit 1）。判据不是空转，但突变体不能那样用。
  4. `verify-pack.cjs` 的 8 条 NEEDLES 里 `markpilot-main` 在 `lib/client.js` 仍出现 3 处（**有意保留**的持久化面板 id 清理，是活代码）；该尺子扫描面是 asar / 引擎源码构建 / sync，不含插件客户端半边 ⇒ §十四 的"死符号名 grep 全 0"应读作"**被删区间的**符号名全 0"。
- **调试回传通道已停**：`http://127.0.0.1:19399/dump` 的接收端（`layout-recon/dump-server.cjs`）在本轮结束前被停掉；产品侧已无任何调用者（§十四 第 1 条），落盘的历史回传留在 `.mp-verify/layout-recon/` 作考古，不随仓库外发。
- **留给下一版（本版不动，动了就要重建引擎、本次打包件即作废）**：`src-cm6/extras.js:731-733` 的 `exportOrCopy` 经机械证实 0 引用；`style` 白名单仍允许 `width` / `height`（可把图撑到页宽，但 `position` 已剥、无法覆盖正文）；client.js 剪掉的 `localStorage['mp-layout-tracks']` 读写者会留下惰性脏键（无读者，不处理）。

## 十七、装机产物端到端导出 PDF（本版补做的最后一环）

此前 D-6 / D-7 的判据都是 headless Chromium + 壳层桩，"在装机件上真的导一次 PDF"没有做过。本轮补上：

- 脚本：`.mp-verify/pack/pdf-smoke-exe.cjs`（经 `app-slot` 取锁；独立 `--user-data-dir`；用 `MP_EXPORT_PDF` 指定落盘路径，避免弹保存框）。
- 素材：`.mp-verify/pack/pdf-smoke/pdf-smoke.md` —— 行内公式、块公式、三行表格、白名单内图片（`style="zoom:33%" width="240"`）、白名单外图片（`style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999"`）、带 `onerror="alert(1)"` 的图片。
- 结果（2026-10-07 18:52，最终便携件 `bcffcf755cb0632b`）：**A1–A5 全绿** —— PDF 384614 B、头 `%PDF-`、1 页、打印 376 ms；控制台 0 错误；页面上**没有**任何带 staging 临时目录路径的提示（D-6 在装机件上成立）；进程未崩。
- 触发路径如实登记：CDP 注入的 `Ctrl+Shift+P` **没有**触发菜单加速键（菜单项在 `main.js:119`，加速键由主进程菜单处理，注入按键到不了那条路径）⇒ 本枪改走渲染侧正式入口 `window.mpHost.exportPdf()`（与菜单最终调用的是同一个 IPC）。直接调用绕过了 `exportPdfFlow`，所以画面里那条状态条显示 `已导出 PDF：undefined（? 页 · 0 KB · 用时 0.0s）` —— 这是**调用路径的产物**，不是产品缺陷。
- 仍未覆盖（不写"应该没问题"）：① 真人按 `Ctrl+Shift+P` 的那条路径（需要有焦点的桌面窗口 + 真键盘）；② 跨页表格"表头重复"的视觉读数（本枪只有 1 页）。

## 十八、发布（GitHub Release）

- **v3.0.1-cm6** — https://github.com/ltmroberthk915/markpilot/releases/tag/v3.0.1-cm6 ，2026-10-07 19:08（本地时区）发布，列表里显示为 **Latest**，非 draft、非 prerelease；tag 指向远端默认分支 `main`（与 3.0.0 同惯例）。
- 两个资产上传后**逐个回读 `sha256` 与本地逐字节比对，全部相符**：
  - `markpilot-cm6-3.0.1-portable.exe` 82692324 B / `bcffcf755cb0632bb276572f09d1af74b56e9d565d7c2e9ef4996456fa2180e0`
  - `markpilot-cm6-Setup-3.0.1.exe` 82951056 B / `e79194519e3b9fbf00be853d2baead3e0d5361a63764da0bf5bb9235f96dbd1b`
- 说明正文取自 `docs/RELEASE-3.0.1-CM6.md`（线上回读已确认渲染正常）。
- 上传前复核：两个 EXE 的字节数与 sha256 与 §十四 的冻结值一致；`verify-pack.cjs --exe-probe` 8/8。
- 本地仓库：提交 `57cd840f`（17 个文件，+3256 / −995 —— 引擎源码、插件客户端半边、桌面壳层与打包脚本、两份发布文档）。**未推送**：本仓库没有配置 remote（`git remote -v` 为空），与 3.0.0 时做法一致 —— 发布件走 release 资产分发，代码不在远端仓库。



