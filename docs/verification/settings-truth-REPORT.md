# settings-truth 族 · 真实用户日常操作普查（第三波）

**族名**：settings-truth（设置真源与迁移）
**被测产物**：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`
**产物指纹**：sha256 前 16 位 = `1b4e32a2263fcbe6`（**每次运行前**断言，不符即拒绝出数；2 支探针 + asar 复核共 3 次断言全部通过，覆盖全部实例）
**判据数**：**90 条**（probe-1 真源与迁移 60 条 + probe-2 多窗口 30 条），**全绿**；进程启动 **12 次**（probe-1 10 次 + probe-2 1 次两窗口实例 + 1 次 `second-instance` 启动器），**`taskkill` 0 次**（含启动器在内全部自行退出）
**输入通道**：`page.mouse`（真实按下 / 多次移动 / 抬起、真实滚轮滚面板）；第二窗口走**已验证的 OS 二次启动通道**（同 profile 再拉一次 exe ⇒ 单实例锁把 argv 交给首实例的 `second-instance`）
**读数口径**：一组相关读数一次 `evaluate` 拿全（`T.snapAll`）；关窗/关页后一律用**主进程事实**判断（WM_CLOSE + `tasklist` + `userData\main-debug.log` + 磁盘 settings.json），不用渲染侧超时反推
**共享尺子指纹**（错-3 第 2 条：读数要说清用哪把尺子）：`startup-and-menus-lib.cjs 6e506de6d5961798`、`session-truth-lib.cjs 24e343c1b7ecf8a4`、`_probe-common.cjs d4ed9c5dbae33d17`
**代码位置的对齐口径**：源码目录在本轮期间**有别的腿在改**（`renderer/host.js` mtime 12:54 晚于 exe 构建时刻 12:25），所以凡引用"代码在哪"的说法，都另用 `settings-truth-asar-check.cjs` 在被测产物的 `app.asar` 里按字节复核过（14 个标记全命中，含启动分支原文 `if (!hasChoice) applyTheme(t.dark)`、`mp-pref-`/`mp-surfaces` 两个存储层键、`themeSource` 全 asar 只 1 次）

---

## 一、四个问题的结论（先给答案）

| 用户动作 | 结论 | 关键读数 |
|---|---|---|
| **① 关掉应用 → 手改 settings.json → 重开** | **生效**，但只对"壳层读的那些键"生效；**`recentFiles` 是死字段**；**运行期手改会被整份回滚** | `restore-last {"enabled":false}` + 窗口 903×643@(140,120)（请求 900×640@140,120）；`settings:load` 读到 315 B、六个键都在（含未知键）；运行期改盘后 `settings:load` 计数 2→2、关窗后盘上被写回内存值 |
| **② 旧版（3.0.x）键名是否迁移** | **迁移**：3.0.x 的 `recent` 会搬进独立真源 `recents.json`；改名目录（`MarkPilot CM6`→`MarkPilot`）整目录搬 | `recents:loaded {"source":"legacy","count":2}`；`migrated-from-cm6.txt` 里 `copiedSettingsBytes: 265` == 旧文件字节数 == 本次 `settings:load bytes`；搬来的 `restoreLast:false` 与 `860×600` 都生效 |
| **③ 删掉 settings.json 再打开** | **只回一半默认**：壳层键回默认，**渲染侧 12+ 项偏好一个都不回** | 删除后重启：`settings:load-failed ENOENT`、`restore-last enabled:true` 且打开了 MRU 第一条、窗口回 1181×775、未知键消失；但 `mp-pref-pageWidth` 仍 54、`mp-surfaces` 仍 `{"float":{"alpha":29}}`、版心仍 630px（=1167×54%）而不是默认 864px |
| **④ 两个窗口同时改设置是否互相覆盖** | **设置不丢**（真源只有一份：壳层一份 `state.settings`、渲染侧一份 localStorage）；**但界面会分叉**：对面窗口的面板/画面都不刷新；`winBounds` 只有一格 | 两窗口 `mp-surfaces` 逐字节相同 `{"float":{"alpha":29},"toolbar":{"alpha":58}}`（整对象写没互盖）；B 改完 A 面板仍是旧勾选态；存储 `zoom=150` 而 A 窗口渲染 `zoom=1`、B=`1.5` |

---

## 二、没反应 / 行为不符预期（带关键读数）

### S1【真源分层】删掉 settings.json ≠ 恢复默认：渲染侧偏好一条都不回
**复现**：真实「更多→设置」把「页面宽度」拖到 54、「公式框·不透明度」拖到 29 → 真实关窗 → 删除 `settings.json` → 重开。
**读数**（probe-1，sha16 `1b4e32a2263fcbe6`）：

- 回归部分（有效）：日志 `settings:load-failed {"error":"ENOENT…"}`、无 `settings:load`；`restore-last {"enabled":true,"picked":"…settings-truth-A.md"}` 且文档真的打开了；`theme:get → {mode:'system'}`；**删前盘上 `winBounds = {x:140,y:120,width:907,height:650}`（P2 时渲染侧实测 903×643，差的是窗口边框），删后回 1181×775**（与首启基线一致）；`legacyUnknownKey` 的 `value=undefined`
- **没回默认的部分**：`mp-pref-pageWidth = "54"`（默认 74）、`mp-surfaces = {"float":{"alpha":29}}`（默认 65）、`--mp-page-width = 630px` = `1167×54%`（若回默认该是 864px = `1167×74%`）——**用户在界面上能直接看到工具岛透明度、版心、缩放、状态栏开关全都还在**
- 关窗后 `settings.json` 被重建，但只有壳层那五个键；`mp-*` 偏好一个字节都没进这个文件（它们在 `userData\Local Storage\leveldb`）
- 代码位置（asar 复核命中 `mp-pref-` 与 `mp-surfaces`）：渲染侧偏好读写走 `localStorage['mp-pref-*'] / ['mp-surfaces']`，与 `settings.json` 是两套存储 ⇒ "删配置文件"只清得动后者

### S2【死字段】手改 settings.json 的 `recentFiles` 完全没反应（被 recents.json 无条件覆盖）
**复现**：盘上 `settings.json` 写 `recentFiles:["…-B.md"]`，而 `recents.json` 里是 A；重开。
**读数**：

- `settings:load` 的 `keys` 里**确实有** `recentFiles`（读进来了），紧接着启动流程 `state.settings.recentFiles = mpLoadRecents()` 把它**整段替换**（asar 里这一行命中：`state.settings.recentFiles = mpLoadRecents();`）
- 结果：`setting:get recentFiles → ["…-A.md"]`、菜单模型也只有 A、真正打开的也是 A ⇒ **写 `recentFiles` 等于没写**
- 对照：同一个文件里 3.0.x 的旧键 `recent` 反而**是**被读取并迁移的（见第三节「3.0.x 键名迁移」）⇒ 这个文件里的字段并不是同一种"真源"待遇

### S3【静默回滚】运行期手改 settings.json：应用毫无反应，关窗时把改动整份抹掉
**复现**：应用开着 → 在盘上把 `restoreLast:true` 改成 `false`、`theme:'dark'` 改成 `'light'`（回读确认改成功）→ 等 1.5 s → 真实关窗。
**读数**：

- 内存真源 `{restoreLast:true, theme:'dark'}`；盘上被改成 `{false,'light'}`；运行中应用仍报 `{true,'dark'}`
- `settings:load` 计数 **2 → 2**（运行期一次都不重读）
- 关窗后盘上变成 `{restoreLast:true, theme:'dark', legacyUnknownKey:…}` —— 我改的两个字节**没了**（`saveSettings()` 把内存整份写回）
- 用户可见后果：改完不重启 → 没反应；此后**任何一次关窗**都会把这次手改彻底抹掉

### S4【主题】`theme` 是"半生效"的键，而且只在用户从没选过配色时影响画面
**同一把尺子做 A/B，只差"localStorage 里有没有 `editor-theme`"**（读数取引擎自己回显的 `html[data-editor-theme]` / `html[data-mode]` / `window.mpTheme.current()`）：

| 臂 | 盘上 theme | 壳层 `theme:get().mode` | `data-editor-theme` | `data-mode` | `mpTheme.current()` | `localStorage.dark` |
|---|---|---|---|---|---|---|
| A 全新 profile（没选过配色） | dark | dark | `telari-dark` | `dark` | `telari-dark` | `true` |
| B 同 profile（已有配色）改盘 | **light** | **light** | `telari-dark`（不变） | `dark`（不变） | `telari-dark`（不变） | `true`（不变） |

- A 臂证明：首启时 `theme` **真的会**落到调色板上（`host.js` 的启动分支只在 `!hasChoice` 时 `applyTheme(t.dark)`，asar 命中 `hasChoice`）
- B 臂证明：一旦用户选过配色（引擎自己会写 `editor-theme`），盘上的 `theme` **只改壳层记的值，画面一动不动** —— 用户看到的是"设置文件写了 light，界面还是深色"
- 另一层（原生主题）：`themeSource` 在整个 `app.asar` 里**只出现 1 次**，且唯一那次在 `theme:set` 里面（只有用户按 Ctrl+Shift+L 才会走到）；启动路径上没有任何代码把 `theme` 应用到 `nativeTheme`。**它的视觉后果本轮未验证**（见"未验证项 1"）

### S5【多窗口·界面分叉】设置不丢，但对面窗口的面板与画面都不跟
**复现**：A 窗口开设置面板并取消勾选「打开上次的文件」→ 用 OS 二次启动开出 B 窗口（第二个 .md）→ B 也在面板里改同一项 / 另一项。

**读数**：

- **不丢**：B 一点，磁盘 `restoreLast:true`、A 与 B 的 `setting:get` 同时是 `true`（壳层只有一份 `state.settings`，没有"每窗口一份副本"）
- **分叉**：`A_panelChecked = false` 而 `A_shell = true`（A 那个**已经打开**的面板不刷新）；A 的面板初值 65/76 与 B 一样，A 拖 `float.alpha→29`、B 拖 `toolbar.alpha→58` 之后，`mp-surfaces` 两窗口逐字节相同，但 **B 面板里 float 滑杆仍 `65`、A 面板里 toolbar 滑杆仍 `76`**、A 的 `--mp-float-alpha=29%` 而 B 还是 `65%`
- **谁改谁重算**：两窗口 localStorage 同值（`pageWidth=45`、`zoom=150`），但 A 的渲染 `zoom=1`、B 的 `zoom=1.5`；A 的版心 525px = `1167×45%÷1`、B 的 351px = `1171×45%÷1.5` ⇒ 两边各自只用**自己那次操作**触发重算 ⇒ 同一份设置，两个窗口画面可以不一样，直到那个窗口自己再改一次或重启
- 这算"每个窗口独立视图"的设计取向还是缺陷，本族不下判；**给读数，交裁**

### S6【多窗口】`winBounds` 只有一格：后动的窗口把先动的覆盖掉
**复现**：A `resizeTo/moveTo(1000×700@40,60)` → B `(820×560@300,140)` → 先关 B 再关 A。
**读数**：A 实测 `1000×701@(40,60)`、B 实测 `820×561@(300,140)`；关 B 后盘上 `winBounds={x:300,y:140,width:820,height:561}`，关 A 后**仍是这一格** ⇒ 下次启动只有主窗口按 B 的几何回来，A 的几何丢失。用户可见：拖好两个窗口的位置，重开只剩一个记住。

---

## 三、通过面（摘要，均有读数）

| 组 | 用例 | 关键读数 |
|---|---|---|
| 首启形态 | 6 | 首启无 `settings.json`（`settings:load-failed ENOENT`）、**启动期不写这个文件**（关窗时才写出来）、默认 `restoreLast:true`/`theme:system`、窗口 1181×775@(141,0)（请求 1180×820，被工作区钳高） |
| 改盘重启（壳层键） | 7 | 装载自证：盘上就是我写的六个键；`settings:load bytes=315` == 我写的字节数；`restore-last enabled:false` 且**没打开任何文档**；窗口 903×643@(140,120)（请求 900×640，outer 含边框 +3）；`theme:get().mode='dark'`；未知键原样读入 `{hello:'world'}`、关窗后仍在盘上（**没有键名映射/过滤表**） |
| 正对照（改回 true） | 3 | `restore-last {"enabled":true,"picked":"…A.md"}` 且文档正文命中夹具内容 ⇒ 上一条的"没打开"确实是设置生效，不是"列表空" |
| 3.0.x 键名迁移 | 6 | 预置 3.0.0 形态 `{theme,recent:[A,B],winBounds:null}`（键集由 git 取证：`6c86f264a`）⇒ `recents:loaded {"source":"legacy","count":2}`、`recents.json` 两条都进、菜单模型两条、缺 `restoreLast` 按默认 true 处理；**关闭后 `recent` 原样留着**且同时写出新键 `recentFiles` |
| 改名目录迁移 | 6 | `migrated-from-cm6.txt` 的 `copiedSettingsBytes: 265` == 旧文件字节数 == `settings:load bytes=265`（拷完没被提前改写）；搬来的 `restoreLast:false`、`winBounds 860×600`（实测 863×605@(60,69)）、`recents.json`（`source:file count:1`）、旧目录其它文件都生效/都搬 |
| 改名迁移·负对照 | 2 | 新目录**已有** `settings.json` ⇒ 不留痕、不迁移，用自己的设置（`restore-last enabled:true`） |
| 多窗口继承 | 7 | 第二个进程确实走 `second-instance` 开新窗口（进程外窗口清单 A→A+B、耗时 12.2 s、引擎页 2）；新窗口 `sessions.total=2` 且 `mineIsPrimary=false`、载入自己那个文件；**继承** A 的非默认 `mp-pref-pageWidth` 并按它算版心；壳层 `restoreLast=false` 一开就同步；面板一打开就回填真源值 |
| 多窗口不互盖 | 5 | 同键最后写者获胜、两窗口同时读到同一个值；不同 localStorage 键都保住；`mp-surfaces` **整对象写但写入前重读** ⇒ 两窗口改不同字段**都**在、两窗口字符串逐字节相同 |
| 收尾 | 4 | 12 次进程启动全部自行退出（`killedBy` 全程 `null`）、**`taskkill` 0 次**；四个 profile 无残留；关窗后 settings.json 被重建为默认（无未知键） |

---

## 四、pageerror / 控制台 / 崩溃

- **pageerror：0**、**console.error：0**、**渲染进程崩溃：0**（探针在每个实例收尾时落盘一份读数：probe-1 合计 **10 次实例** `P8.2 = {pageerrors:0, consoleErrors:0, crashes:0}`，probe-2 合计 **1 次两窗口实例** `W6.2` 同）
- **无窗口僵死、无原生对话框阻塞**（本族不触发文件对话框）
- **无实例泄漏**：12 次进程启动（含那次 `second-instance` 启动器）全部自行退出，**`taskkill` 一次都没用到**（探针里的 `killedBy` 字段全程为 `null`、收尾兜底回收列表为空）

---

## 五、未验证项（不许猜）

1. **`theme` 对原生主题（标题栏/系统配色）的视觉后果**：我原本用 `matchMedia('(prefers-color-scheme: dark)')` + CSS 媒体查询两条渲染侧口径当尺子，**正对照不合格**——`themeSet('dark')` 返回 `{mode:'dark',dark:true}`，而两条口径都不动（`false→false`、CSS 探针读到 `rgb(9,9,9)`）。尺子无效 ⇒ 这一层写"未验证"。能给的只有源码事实（asar 复核：`themeSource` 全仓唯一写入点在 `theme:set`）。
2. **`settings.json` 内容损坏（半截 JSON / 非法 JSON）时的行为**：不属本族四问（另有 corrupt-config 族在做），本轮未测。
3. **两个窗口在同一毫秒级窗口内改同一个键的竞争**：本轮的"同时"是**秒级先后**（真实鼠标操作的自然间隔），没有构造毫秒级交错。
4. **「清除最近记录」是否把 settings.json 里 3.0.x 的旧 `recent` 副本也清干净**：代码里有这一步（`clearRecent` 清 `state.settings.recent`），本轮未做真实点击，只有"关闭后 `recent` 仍在盘上"这条读数。
5. **`winBounds` 在多显示器/最大化状态下的行为**：本机单屏（工作区 ≈1181×775），未测多屏与最大化。

---

## 六、探针自身的错（已改正并用同一支探针复跑，避免把探针缺陷记成产品缺陷）

1. **`Browser.getWindowForTarget` 在产物这版 Electron 里不存在**（实测 `'Browser.getWindowForTarget' wasn't found`）。第一版把它当硬读数且在阶段里抛错 ⇒ 该阶段后面的判据没跑、**实例也没回收** ⇒ 下一阶段撞上单实例锁（新进程 `code=0` 直接退出），连锁报"起不来/设置面板打不开"。改成"两把尺子都不抛"（渲染侧 `outerWidth/outerHeight/screenX/screenY` 为主 + CDP 探测只记有没有），并给每个阶段加**抛错即回收**；`launch()` 里加"同 profile 还有活实例就先报清楚"的前置断言。
2. **设置面板形态断言写错**：我要求 `input.mp-rng[data-s]` 必须有 **11** 条，实际是"表面 8 条（data-s）+ 版式 3 条（data-p）"⇒ 面板明明开着却判失败，连带后面拖滑杆的用例全没跑。改为分别断言 8 / 3 / 1。
3. **日志读数跨启动串台**：`main-debug.log` 是 `appendFileSync` 累积的，第一版用"整份日志里有没有 `settings:load`"判"这次是不是首次运行"⇒ 必然错。改成"启动前取字节偏移、之后只读这一段"；**又踩第二层**：全新 profile 会被 `spawnApp` 先删掉（连带旧日志），偏移量大于新日志长度 ⇒ slice 出空串、首启判据全假红。最终口径：`keep:false ⇒ 偏移取 0`。
4. **猜属性名**：theme 的调色板判据我写了 `data-mp-theme`——引擎里根本没有这个属性（实际是 `data-editor-theme` / `data-mode` / `window.mpTheme.current()`）⇒ 两条判据假红；改用引擎自己回显的三处后，读数反而更强（A/B 两臂的同/异一目了然）。
5. **`--mp-page-width` 的期望值漏了"÷缩放"，且用了错的缩放来源**：引擎口径是 `版心 = 视口 × 页面宽度% ÷ 缩放`。第一版漏除；第二版用"共享存储里的 zoom=150%"去算 A 窗口的期望值，而 A **压根没应用**那次缩放（A 的渲染 `zoom=1`）⇒ 期望 350px、实测 525px，把正常行为读成"没跟"。最终口径：读引擎已经算好的 `getComputedStyle(.cm-editor).zoom`（该窗口真正生效的缩放）。

---

## 七、证据文件（均在 `E:\MarkPilot\.mp-verify\checklist\` 下）

| 文件 | 内容 |
|---|---|
| `settings-truth-lib.cjs` | 本族共用尺子：一次性 `SNAP`、设置面板真实输入助手（更多→设置→滚动→拖动/点击）、启动/关窗/只关一个窗口、日志按启动偏移切片、页面错误留痕 |
| `settings-truth-probe-1.cjs` / `settings-truth-out/probe-1-result.json` / `probe-1-cases.txt` | 真源与迁移 60 条判据的**全量原始读数**（含每次改盘的字节数、装载自证的盘上内容、窗口几何、调色板三处回显） |
| `settings-truth-out-probe1-console.txt` | probe-1 控制台逐条输出 |
| `settings-truth-probe-2.cjs` / `settings-truth-out/probe-2-result.json` / `probe-2-cases.txt` | 多窗口 30 条判据的全量原始读数（两窗口各自的 localStorage / :root 变量 / 面板 DOM / 会话身份 / 窗口几何） |
| `settings-truth-out-probe2-console.txt` | probe-2 控制台输出（末次复跑只留了 W3/W6 段；完整读数见 `probe-2-cases.txt`，由 result JSON 生成、不重跑） |
| `settings-truth-asar-check.cjs` / `settings-truth-out/asar-check.json` | 把"代码在哪"的说法钉到**被测产物自己的 asar**：14 个标记全命中、`themeSource` 全 asar 只 1 次、启动分支原文 `if (!hasChoice) applyTheme(t.dark)` |
| `settings-truth-dump-cases.cjs` | 把 result JSON 摊成人类可读清单（报告里引用的行号级读数都来自它） |
| `settings-truth-out/fixtures/settings-truth-{A,B}.md` | 两份真实文档夹具（A 当 MRU 第一条、B 验"settings.json 里的 recentFiles 是不是真源"） |
| `settings-truth-out/legacy-cm6-userdata/` | 伪造的"改名前的旧 userData"（settings.json + recents.json + 标记文件），迁移源 |
| `settings-truth-out/profile-*/` | 每个用例的独立 userData（含 `main-debug.log` 主进程一手事实、磁盘 `settings.json`/`recents.json`） |

**复现命令**（工作目录 `E:\MarkPilot\.mp-verify\checklist`）：

```
node settings-truth-probe-1.cjs      # 真源与迁移（约 7 分钟，10 次启动）
node settings-truth-probe-2.cjs      # 两窗口同时改设置（约 6 分钟，1 次两窗口实例 + 1 次 second-instance）
node settings-truth-asar-check.cjs   # 代码位置对齐（秒级）
node settings-truth-dump-cases.cjs   # 摊平结果
```

---

## 八、纪律自检

- **只在 `.mp-verify\checklist\` 下写文件**；`src-cm6/`、`MarkPilot-CM6/` 只读（本轮期间这两个目录里 `renderer/host.js`、`renderer/cm6/app.js` 有别的腿在改，mtime 12:54；**我的会话一个字节都没写**，凡引用代码位置都用 asar 复核钉到被测产物上）
- **输入全走真实通道**：设置面板一律"真实鼠标点更多（mousedown 绑定）→ 点设置 → 真实滚轮滚面板 → 真实按下-多次移动-抬起拖滑杆 / 真实点击复选"；第二窗口走 OS 二次启动（不是 IPC 直调）；窗口几何用 OS 级 `resizeTo/moveTo` 并**先自证这条通道真的有效**（`W5.1`）
- **一组相关读数一次 `evaluate` 拿全**（`T.snapAll` 一个函数里取完渲染侧 + 壳层 IPC + 面板 DOM）；断言"不是默认回退值"（面板必须挂上且 8+3+1 形态、文档名必须是请求的那个、每次改盘都回读自证）
- **关窗后判断存活一律用主进程事实**（WM_CLOSE + `tasklist` 按 `--user-data-dir` 精确核对 + `main-debug.log`），未用渲染侧超时反推
- **自己起的进程全部结束**：12 次进程启动、0 残留（`P8.1` 四个 profile 全空、`W6.1` 空）；**`taskkill` 一次都没用到**（`killedBy` 全程 `null`，抛错兜底回收列表为空）
- **判"属于哪种上下文"读引擎已算好的结果**：调色板读 `data-editor-theme`/`data-mode`/`mpTheme.current()`，缩放读 `getComputedStyle(.cm-editor).zoom`，面板状态读 DOM 的 value/checked/标签，不自己推断（本轮为此改了两次尺子，见第六节 4/5）
