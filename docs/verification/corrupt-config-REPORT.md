# corrupt-config 族 · 真实用户操作普查（第三波）

**族名**：corrupt-config（损坏配置自愈）
**被测产物**：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`
**产物指纹**：`MarkPilot.exe` sha256 前 16 位 = **1b4e32a2263fcbe6**（188 784 128 B，mtime 2026-10-10T12:25:48）
　　＋第二锚点 `resources\app.asar` sha16 = **bd172e68f484e69c**（mtime 12:25:47）
　　⇒ 两者都**早于本轮开始时间（12:28）**，且每次探针启动都断言 exe sha16（recon / run1 / run2×2 / run3 五次全部 ✓）；
　　期间别的 Agent 在 12:54 改过 `MarkPilot-CM6\renderer\*.js`（源码），但**没有进这份产物**（打包时间 12:25:47）⇒ 本轮所有读数同源。
**用例数**：**15 个用例臂，跑了 17 次**（A7 只读臂与 A7b 重启臂在修好尺子后各复跑一次；10 个 settings.json 臂 + 5 个 recents.json 臂），共 **233 条判据** → 230 绿 / 3 红（3 红全部由探针自身缺陷造成，复跑后转绿，见第四节）
**启动次数**：正式 17 次（每次独立 `--user-data-dir`）＋ 侦察 1 次 ＋ 诊断 5 次 ＋ 第一版（尺子有缺陷）4 次
**输入通道**：真实鼠标（`page.mouse` 按下/移动/抬起、真实滚轮把面板滚到位）；读数一律"一次 evaluate 拿全"
**环境**：本机锁屏态；DPR=1.75、可用屏高 775（影响窗口尺寸口径，见下）

---

## 一、结论（先给判据）

| 损坏形态 | 应用能否启动 | 是否回退默认 | 是否自愈（磁盘） | 之后设置面板是否可用 | 裁定 |
|---|---|---|---|---|---|
| **合法且非默认**（对照臂） | ✓ 窗口+引擎页+渲染 | —— **采纳**（主题 dark／宽 900／restoreLast=false） | ✓ | ✓ | **PASS** |
| **非法 JSON** | ✓ | ✓（theme=system、1180×820、restoreLast=true） | ✓ 覆写为合法 JSON | ✓ | **PASS** |
| **截断**（写到一半） | ✓ | ✓ 同上（**半个文件里的 dark/900 一个都没被采纳**） | ✓ | ✓ | **PASS** |
| **写成数组** | ✓ | ✓ 已知键全部回落默认 | ✓（带垃圾键，见三·3） | ✓ | **PASS** |
| **写成字面 null** | ✓ | ✓ | ✓ | ✓ | **PASS** |
| **UTF-8 带 BOM**（记事本另存） | ✓ | ✓ 整份回落默认 | ✓ | ✓ | **PASS** |
| **只读属性**（合法内容） | ✓ | 文件可读 ⇒ 采纳 | — 写不进去（OS 拒绝） | ✓ 面板可用，但**改了不落地也不提示**（见三·1） | **PASS**（族判据）/ 附 1 条中危 |
| **winBounds 类型错**（字符串/非数字） | ✓（**不起崩溃、不白屏**） | 主题/清单回落默认；**窗口退到 Electron 内建 800×600**（见三·2） | ✓ | ✓ | **PASS** / 附 1 条低危 |
| **recents.json 非法 JSON**（＋settings 有 3.0.5 旧字段） | ✓ | ✓ **旧字段迁移成功**：真的打开了那条文件 | ✓ 覆写为合法清单 | ✓ | **PASS** |
| **recents.json 截断**（无旧字段） | ✓ | ✓ 空清单，菜单「（暂无记录）」置灰 | ✓ 覆写为 `[]` | ✓ | **PASS** |
| **recents.json 数组混垃圾**（数字/null/空串/对象/不存在路径） | ✓ | ✓ 只留 2 条合法绝对路径 | 不需要（本就合法） | ✓ | **PASS** |
| **recents.json 只读** | ✓ | —— | **只读被绕过**（见三·5） | ✓ | **PASS** / 附 1 条观察 |
| **两个文件都带 BOM** | ✓ | ✓ 两边都回落默认 | ✓ | ✓ | **PASS** |

**四条硬判据的读数**（每个臂每次运行都测；**15 个臂的最终裁定 15/15 全绿** —— run2 的 A7 曾在"窗口出现"这条上记过 1 红，那是探针竞态造成的假红，run3 修好尺子后绿，红读数保留在 `run2-full10arms.json` 里作对照，详见第四节第 6 条）：
- **启动成立**：EnumWindows 按 profile 精确定位到顶层窗口（class `Chrome_WidgetWin_1`、`vis`、标题「未命名 — MarkPilot」）＋ CDP `connectOverCDP` 找到引擎页（`window.mpEngine && window.mpHost`）。
- **不白屏**：`.cm-editor` 在、`.cm-line` ≥ 1、编辑面矩形宽 > 200px；**截图逐像素统计**（页内 canvas 采样 ~200k 点）颜色数 16 级量化后 ≥ 28、纯白像素占比 **0.0000**（全部 17 臂）。
- **回退默认**：读**主进程算好的结果**——`main-debug.log` 的 `settings:load|load-failed`、`mpHost.themeGet().mode`、`mpHost.settingGet('restoreLast')`、窗口实际外框宽（`window.outerWidth`，DPR=1.75 下 ±8px，与关窗后主进程写进磁盘的 `winBounds` 互证）。
- **面板仍可用**：真实「更多 → 设置」打开，结构 11 滑杆 / 2 复选 / 7 单选 / 4 按钮（**结构读自本产物的侦察读数**，不引用别族报告）；真实拖动「页面宽度」后 **值 67 = 读数标签 67% = localStorage 67 = 引擎算出的 `--mp-page-width` 782px = 版心宽 782px**（`min(round(客户区宽×67%),1240)`，两条独立诊断各证一次）；真实点击「打开上次的文件」后 `setting:set` 落痕。

---

## 二、对照臂为什么必须有（"回退默认"的绿可信度）

A1 用**同一套读出、同一支探针**、只把 settings.json 换成合法且非默认的内容：
- `settings:load {"bytes":146,"theme":"dark","keys":["theme","winBounds","restoreLast","recent"]}`
- `theme:get().mode = "dark"`（而所有损坏臂都是 `"system"`）
- 窗口外框 **903×645**（请求 900×640；而所有损坏臂是 **1181×775** = 请求 1180×820 被屏高 775 钳制）
- `restoreLast=false` + 面板复选框**未勾选**（损坏臂全是 true + 勾选）

⇒ 同一把尺子在"合法非默认"上是**采纳**、在"损坏"上是**回落**：两种状态都测到了，"回退默认"不是尺子失灵。（本波产品代码只读，不允许做注掉式突变，故用对照臂承担鉴别力证明。）

---

## 三、没反应 / 行为不符预期（带关键读数）

### 1【中危·静默丢设置】settings.json 只读时，面板改设置**回执成功、磁盘没变、无任何提示**，重启回原值

**复现**：把 `settings.json` 设为 `{"theme":"dark","winBounds":{900×640},"restoreLast":false}` 并打上只读属性 → 启动 → 真实点开「更多 → 设置」→ 真实点击「打开上次的文件」。
**读数**（A7，sha16 1b4e32a2263fcbe6）：
- 点击前 `{"api":false,"checkbox":false}` → 点击后 `{"checkbox":true,"api":true,"toast":null}`
- 主进程日志有写入意图：`setting:set {"key":"restoreLast","value":true}`
- **磁盘纹丝不动**：mode 仍是 `444`、内容仍 `"restoreLast": false`、**mtime 前后逐位相同**（1791608466946.394 → 1791608466946.394）
- **重启（A7b，同一 profile）**：首帧 `restoreLast.api=false`、复选框未勾选 ⇒ 用户刚才那一改**彻底没了**，而当时界面没有任何提示

**根因（引产物内代码，已核对 asar 里那份与仓库源码逐字节相同）**：
- `main.js:186-194 saveSettings()` 的 `try{ …writeFileSync… }catch{ /* 设置写失败不阻塞编辑 */ }` —— 写入异常被**空 catch 吞掉**；
- `main.js:1292-1299 handle('setting:set')` 在 `saveSettings()` 之后**无条件** `return {ok:true}`；
- 渲染侧其实**留了提示分支**（`app.js` 的 `settingSet(...).then(ze => ze.ok===!1 && toast('保存设置失败：'+…))`），但主进程永远返回 ok ⇒ 该分支**永远走不到**。
- 对比：`recents.js` 的写入失败会 `dbg('recent:save-failed')` 留痕；`settings` 这条连日志都没有（`settings:save-blocked` 只覆盖"载入完成前"那种情况，本轮 17 臂 **0 次**）。

### 2【低危·窗口尺寸不按产品默认回落】`winBounds` 值类型错 ⇒ 退到 Electron 内建 800×600，而不是产品声明的 1180×820

**读数**：`{"winBounds":"oops"}`（A8）与 `{"winBounds":{"width":"abc","height":"abc"}}`（A9）**都能正常启动**（窗口、引擎页、面板、截图全绿），但：
- 实测外框 **801×601**（关窗后主进程写进磁盘的也是 `{x:331,y:87,width:801,height:601}`），而损坏成非法 JSON 的臂是 **1181×775**，对照臂是 903×645。
- `main.js:688 const b = state.settings.winBounds || { width: 1180, height: 820 }` 只判**真假**、不判类型；`b.width/b.height/x/y` 直接进 `new BrowserWindow`（main.js:689-690），非数值 ⇒ 相当于没给 ⇒ Electron 用自己的默认 800×600。
- 用户可见影响：小窗启动（用一次后即被写回真实 bounds 自愈）。属"回退默认"但**不是产品自己声明的那个默认**。

### 3【低危·垃圾键写回】settings.json 写成数组 ⇒ 索引键被平铺进 settings 并落回磁盘

**读数**（A4，`["dark", {"width": 900}, 42]`）：
- `settings:load {"theme":"system","keys":["0","1","2"]}` —— `Object.assign(state.settings, parsed)`（main.js:175）把数组索引当属性拷了进来；
- 关窗后磁盘文件里真的留下了垃圾键：
  `{"0":"dark","1":{"width":900},"2":42,"theme":"system","recent":[],"recentFiles":[],"winBounds":{…},"restoreLast":false}`
- 已知键 `theme/winBounds/restoreLast` 全部正确回退默认，功能无影响；垃圾键会一直留在文件里（用户下次手工看这个文件会困惑）。

### 4【观察】`settings.json` = 字面 `null` 时日志记 `load-failed`，抛点在**诊断行**而不是合并行

`settings:load-failed {"error":"Cannot convert undefined or null to object"}`。逐行核对产物内代码：`Object.assign(target,null)` 按规范是**空操作**（不抛），真正抛的是同一 try 里 main.js:180 诊断行的 `Object.keys(parsed)`。⇒ 行为上仍是"回退默认"（正确），差别只在日志分类。**不改产品代码，只记读数**。

### 5【观察】只读 recents.json 被"先删再改名"的兜底**绕过**：只读属性被清除、文件被替换

**读数**（B4，命令行真的打开一个文件以触发写 MRU）：
- 前：`recents.json` mode **444**、内容 `["…A-文件.md"]`
- 后：mode **666**（只读属性没了）、内容 `["…A3-命令行.md","…A-文件.md"]`、日志**没有** `recent:save-failed`、**没有**残留 `.mp-tmp-*`
- 机制：`shell/recents.js:29-39 save()` 先写临时文件再 `renameSync`；EPERM 时走兜底 `rmSync(file,{force:true})` + 再 rename。**夹具自证**（`corrupt-config-fixture-selfcheck.cjs`）证明：Windows 上只读文件 `rmSync force` **会成功**，而 `writeFileSync`（settings 那条路）**会 EPERM**。
- ⇒ 同一个"只读"，两条写路径行为**相反**：settings 静默失败、recents 直接覆盖。不是崩溃，但属于"用户设了只读却被无视"。

### 6【观察】BOM（记事本"UTF-8 带 BOM"另存）⇒ 设置/清单**整份静默回退默认**，界面无任何提示

- A6：`settings:load-failed {"error":"Unexpected token '\uFEFF' …"}`，主题从 dark 回落 system、窗口从 900 回落 1180。
- B5：两个文件都带 BOM ⇒ 设置与最近打开**同时**回落默认，菜单变「（暂无记录）」。
- 这是族要求的"回退默认"（**PASS**），但用户视角是"我什么都没干，设置和最近文件全没了、也没人告诉我"。

---

## 四、探针自身的错（本族第一版全废/假红的原因，已逐条改正并复跑）

> 记在这里是因为其中前两条**差点被读成产品现象**（AGENTS 错-7 / 错-3 同族）。

1. **用不存在的 CDP 域取窗口尺寸**：`cdp.send('Browser.getWindowForTarget')` 在 `connectOverCDP` 的 page 会话里报 `'Browser.getWindowForTarget' wasn't found` ⇒ 抛在我自己的取证代码上，每个臂都被记成"**CDP/引擎页未出现**"（第一版 10 臂全废，亏在没打印异常文本）。改用 `window.outerWidth/Height`（引擎算好的几何）＋ 关窗后主进程写进磁盘的 `winBounds` 互证，并**先做诊断自证**（默认 1181/定制 903，两条独立启动）。
2. **把 `--mp-page-width` 当成百分数比**：它其实是引擎算出的 px（`min(round(客户区宽×N%),1240)`，诊断两次独立启动 1167×0.74=864、889×0.74=658 逐位吻合）⇒ 我拿 `'67%'` 比 `'596px'`，读成"拖动无效"。改成比引擎算出的 px + 读数标签 + localStorage + 版心宽五处自洽。
3. **拖动目标撞上"已经在那个值"**：目标按比例给，A7b 复用 profile 时滑杆正好停在 67（=0.45 档）⇒ 真实拖动不改变值，被读成"面板不灵"。改成依次试 0.45/0.62/0.30/0.80 直到值**真的变了**，并把每次尝试记进 `dragAttempts`。
4. **复用臂漏标 `readonly`**：A7b 复用 A7 的只读 profile，我却按"可写"分支判 ⇒ 把"确实没落盘"这条**本来要证的结论**读成了红。
5. **A5 期望写错**：期望 `settings:load`，实际 `load-failed`（见三·4）——是判据错，不是产品错；已按实测机制重写期望并备注。
6. **窗口读数与自己的重试打架**：`myMainWindow()` 原先读在 `connect()` 之前；A7 第一次连不上时 lib 会按设计 kill+换端口重起，我这一读正好撞在"被我自己杀掉"的瞬间，拿到 `all:[]` 假红；同时 `render-process-gone {"reason":"killed"}`（**我自己 taskkill 的**）被算进"坏事件"。现改为：早读仅留参考、**判据用 connect 成功之后的读**；日志只扫**本次启动之后新增**的字节，并把 `reason:"killed"/"clean-exit"` 与真实崩溃**分开计数**。

---

## 五、pageerror / 崩溃 / 控制台 / 关窗

- `pageerror`：**0**（17 臂）
- `console.error`：**0**（17 臂）
- 渲染进程崩溃（`page.on('crash')`）：**0**；`win:render-process-gone` 且 reason 非 killed/clean-exit：**0**
- `win:unresponsive`：**0**（17 臂主进程日志，逐 profile 统计）
- `settings:save-blocked`：**0**；`recent:save-failed`：**0**
- 关窗：**17/17 优雅关窗**（`WM_CLOSE` 打到我自己 PID 的主窗口）→ 每次都在**主进程侧**确认进程树已空（`pidsForProfile` 按命令行里的 `--user-data-dir` 精确匹配），**`taskkill` 一次都没用到**
- 我的进程清理：收尾后按 profile 复查 **0 残留**

---

## 六、证据文件（均在 `E:\MarkPilot\.mp-verify\checklist\`）

| 文件 | 内容 |
|---|---|
| `corrupt-config-1.cjs` | settings.json 族 10 臂正式探针（含对照臂、只读臂、重启臂、同族形态） |
| `corrupt-config-2.cjs` | recents.json 族 5 臂正式探针（含旧字段迁移、垃圾数组、只读绕过、双 BOM） |
| `corrupt-config-panel-lib.cjs` | **唯一一份**面板交互与读数尺子（两支探针 `require` 同一文件；错-4） |
| `corrupt-config-recon.cjs` / `corrupt-config-out/recon.json` | 侦察：本产物上的工具栏 id、面板 11/2/7/4 结构逐项原始读数 |
| `corrupt-config-fixture-selfcheck.cjs` / `corrupt-config-out/fixture-selfcheck.json` | 夹具自证：只读文件 `writeFileSync`=EPERM、`rmSync force`=成功、`save()` 失败会留 `.mp-tmp-*` |
| `corrupt-config-diag-connect{,2}.cjs` / `corrupt-config-diag-winbounds.cjs` / `out/diag-*.json` | 诊断：连接各步、CDP 域是否存在、窗口尺寸尺子（默认 1181/定制 903） |
| `corrupt-config-asar.cjs` / `out/asar/` | 从**产物自己的** app.asar 取出的 `main.js`(sha16 8c54271f1691d3a3)、`shell/recents.js`(6d95e2f689093490)、`preload.js` —— 与仓库源码逐字节相同 |
| `corrupt-config-out/corrupt-config-1-result-run2-full10arms.json` | settings 族 10 臂**全量原始读数**（141 条判据 + 每次 evaluate 的完整返回） |
| `corrupt-config-out/corrupt-config-1-result-run3-A7fixed.json` | A7/A7b 修好尺子后的补跑（28 条判据全绿，保留 run2 的红作对照） |
| `corrupt-config-out/corrupt-config-2-result-run2-full5arms.json` | recents 族 5 臂全量原始读数（64 条判据） |
| `corrupt-config-out/run2-probe-1-console.txt` / `run2-probe-2-console.txt` / `run3-A7-console.txt` / `probe-1-console.txt`(第一版) / `recon-console.txt` | 逐条判据的控制台输出（含第一版的红，供对照） |
| `corrupt-config-out/shots/*.png` | 每臂两张：进面板前（desktop）与面板操作后（panel），**共 30 张**（17 臂 ×2，A7/A7b 的两对被 run3 覆盖） |
| `shots/A2-invalid-json-panel.png` | **看图确认**：settings.json 是非法 JSON 时，面板完整渲染、页面宽度显示 67%（正是真实拖出来的值）、复选框已按点击翻转、状态栏「行 1/1·列 1」 |
| `shots/B1-recents-invalid-legacy-desktop.png` | **看图确认**：recents.json 坏掉后靠旧字段迁移，界面真的打开了「# A-文件 / 甲内容。」（状态栏「行 1/4·列 1  13 字」） |

**复现命令**（工作目录 `E:\MarkPilot\.mp-verify\checklist`）：

```
node corrupt-config-fixture-selfcheck.cjs      # 夹具自证（不启应用）
node corrupt-config-recon.cjs                  # 侦察本产物结构
node corrupt-config-1.cjs                      # settings.json 10 臂
node corrupt-config-2.cjs                      # recents.json 5 臂
node corrupt-config-1.cjs A7-readonly,A7b-readonly-restart   # 只跑只读两臂
node corrupt-config-digest.cjs 1               # 把结果 JSON 摘要成表
node corrupt-config-tally.cjs                  # 判据计数与错误计数
```

---

## 七、未验证项（如实列出，不猜）

1. **只读 + 损坏的组合**（只读且是非法 JSON）：预期"每次启动都回落默认、永远无法自愈"，本轮没测。
2. **其它不可读形态**：`settings.json` 是**目录**、`EACCES`（ACL 拒绝读）、超大文件 —— 未测。
3. **运行中把配置改坏**（不重启）：不在本族范围（本族是启动期自愈），未测。
4. **「恢复默认」按钮在配置损坏后的行为**：属 first-run-settings 族，未测。
5. 只读 recents 的"绕过"结论依赖 Windows 的 `rmSync(force)` 语义（本机实测成立）；其它文件系统未验证。
6. 崩溃/白屏只在**启动路径**上验了；导出、打印等重活路径不在本族范围。
7. `winBounds` 的数值边界（0、负数、超大）未逐类穷举 —— 只测了"字符串"与"非数字字符串"两类（错-3：随机/单点不能替代定向枚举，这里明确标注覆盖不足）。
