# 族报告：file-ops-real（文件操作日常 · 第二波普查）

**被测产物**：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`
**sha16 = 15b8a1b699a0782e**，188 784 128 B（每个探针启动时由 `_probe-common.cjs` 尺子卡断言并打印，不一致即 exit(9)，本族 4 支全部 ✓）
**启动范式**：`spawn(exe, [夹具, --remote-debugging-port=随机, --user-data-dir=独立])` + `MP_DEBUG=1 MP_TEST_HOOKS=1 MP_TEST_NO_DIALOG=1` + `delete ELECTRON_RUN_AS_NODE` + `playwright-core connectOverCDP`
**用例数**：**24**（P1=9 / P2=4 / P3=6 / P4=5），全部跑完，进程收尾干净（`0` 个本族 profile 残进程，文件锁已释放）
**纪律**：只在 `.mp-verify\` 写文件；**未改一行产品代码**；每条读数是"最终状态"（文档文本 / 磁盘字节 / activeElement / `view.hasFocus` / `<base href>` / 原生标题）

**通道声明**（判据按此口径记账）
| 动作 | 通道 |
|---|---|
| 打开文件 | `mpHost.openPath(绝对路径)`（与"文件→打开…"选中后同一条落点；框本身见 C7） |
| 编辑 | 真实鼠标点进正文 + `page.keyboard.type` / `insertText`（CDP Input.*） |
| 保存 | **不做显式保存动作**，走 500 ms 去抖自动保存（用户打字后最真实的那条路） |
| 菜单保存/另存为 | `recent:test-menu-click menu-save / menu-save-as`（该菜单项**自身 click 回调**，非鼠标） |
| 提示条按钮 | **真实鼠标**（读按钮矩形 → `page.mouse.click`） |
| 只读 | `fs.chmodSync(0o444)`（Windows 上即 FILE_ATTRIBUTE_READONLY） |
| 外部占用 | 独立 pwsh 进程 `[System.IO.File]::Open(..., FileShare::Read)` 持有句柄，并**在探针侧断言**"确实写不进去"（实测 `EBUSY`） |
| 另存为目标路径 | 壳层 `MP_TEST_SAVE_AS`（**不弹原生框**，只替换"路径从哪来"） |

---

## 一、没反应 / 行为不符预期（6 项）

### F1 磁盘上改名后再保存：静默把**旧文件名重新创建**出来（P1-C2）
- 改名后 `docInfo` 仍是旧路径 `…\ren-old.md`；再敲一个字 → 壳层 `file:save {"filePath":"…\\ren-old.md","bytes":38}`
- 保存后：`ren-old.md` **重新存在**（内容 `…正文。AB`），`ren-new.md` 仍是**旧内容**（`…正文。A`，不含 B）
- 全程 `提示条 shown=false`；标题仍是 `ren-old.md`；盘上同时存在两份、其中一份是陈旧副本
- 佐证：`doc:outside-change` 在 stat 失败时返回 `changed:false`（`main.js:1368-1373`）⇒ 即使窗口重新获得焦点也不会提示（**读码推断**；真实焦点切换本轮未做）
- 截图：改名保存后界面**干干净净、零提示** `p1\shots\C2-rename-banner.png`

### F2 另存为到**另一个目录**后，相对资源基准不跟着换（P3-G6，P2-2 复现）
- `window.__mpDocDir` = `…\p3\fix\甲 目录`（期望 `乙 目录`）；`<base href>` = `document.baseURI` = `file:///E:/…/p3/fix/%E7%94%B2%20%E7%9B%AE%E5%BD%95/`
- 用户可见后果：同一相对路径 `assets/pic.bmp` 在甲目录是红 1×1、乙目录是蓝 3×3 —— 另存为到乙目录后**图上仍是红 1×1**（`P3-3-after-saveas.png`，基线 `P3-0-baseline.png`）
- 代码位置：渲染侧 `saveAsFlow()` 调了 `docPath(filePath)` 却**没有** `publishDocDir(filePath)`（`renderer/host.js:220-228` vs `applyDoc` 的 `:118`）
- 注：`P2-2` 的 `docDir` 读数与这条一致（`…\p2\fix` vs 期望 `…\p2\fix\新 目录 目标`）

### F3 点完提示条按钮后正文**失去焦点**，接着打的字不落（P3-G4/G5、P4-H3/H4）
- 点「另存为…」后：`viewFocus=false`、`activeElement=BODY` → 打 `E`：docLen **40→40**，磁盘无 `E`
- 点「重试」后：`viewFocus=false`、`activeElement=BODY` → 打 `K`：docLen **19→19**，磁盘无 `K`
- 对照臂（同一次会话、同样的按键）：先真实鼠标点回正文 → `viewFocus=true` → 打 `R`/`M` 都落字并落盘（41/20）
- 边界收窄：提示条**出现**时不抢焦点（G1/H1 `viewFocus=true`），提示条**在场时**打字也照落（G2 docLen 39→40）⇒ 问题就在"按钮被 `hideBanner()` 移除后焦点落到 body"
- 用户视角：提示条已消失，光标不可见，敲字毫无反应（`P2-3` 的红灯经 P3/P4 复核后**改判为本条**，原判"另存为后自动保存走错路径"**作废**；换路径本身由 P2-4 与 P3-G5 证明是彻底生效的：后续 `doSave:saved` 全部是新路径、源文件一字未动）

### F4 保存失败提示对用户**不可读**，且两种成因共用同一句（P1-C1/C3、P4-H1、P2-1）
- 只读（+R）与"被别的程序占用"给出**同一条**原始 libuv 英文 + 临时文件名：
  `保存失败：EPERM: operation not permitted, rename '…\.readonly.md.mp-tmp-95800' -> '…\readonly.md'（…\readonly.md）`
- 占用臂探针侧自证锁是真的（`open 'r+'` → `EBUSY`），但界面上没有任何"文件被其它程序占用"的字样
- 壳层**已有**中文映射（`main.js:1057` `imgFsError`：`EBUSY: '文件被其它程序占用'`），但只接在图片通道上，`file:save` 未接
- 截图：`p1\shots\C1-readonly-banner.png`、`C3-locked-banner.png`、`p4\shots\H5-banner-geometry.png`

### F5 保存失败会在**用户文档目录**里留下临时文件（P1-C1/C3、P4-H1；物证仍在盘上）
- 失败当场目录里出现：`.readonly.md.mp-tmp-95800`（49 B）、`.locked.md.mp-tmp-67076`（35 B）
- 恢复方式决定它是否消失：走**「重试」成功** ⇒ 被 rename 消耗掉（C1b/C3b/H2 后 `mp-tmp` 残留 = `[]`）；走**「另存为…」** ⇒ 原目录**永久**留下 `.source.md.mp-tmp-108244`（35 B，内容=当时最新文本），实测现存于 `p2\fix\`
- 不丢数据（内容仍在），但用户在资源管理器里会看见一个点号开头的陌生文件

### F6（附带）保存失败提示条与工具栏**矩形重叠**（P4-H5）
- `#mp-banner` rect `y=0..63`，`.mp-toolbar` rect `y=6..37`（x 122..1053）⇒ 提示条第一行被工具栏压住，用户看到的是**半截报错**
- 截图：`p4\shots\H5-banner-geometry.png`（同样的形态见 `p1\shots\C1-readonly-banner.png`）

---

## 二、正常路径的阳性读数（简表）

| 用例 | 结论 | 关键读数 |
|---|---|---|
| P1-C4 中文+空格文件名/目录名 | 有反应 | `docInfo` 逐字符 == `…\测试 目录\会议 纪要 03.md`；磁盘与渲染文档**逐字符相等**；无 tmp 残留 |
| P1-C5 深层目录 | 有反应 | 路径 244 字符，打开/打字/落盘全通 |
| P1-C6 超长路径（边界，信息性） | 有反应 | 路径 **422 字符**（超 MAX_PATH）仍能打开、打字、落盘 |
| P1-C7 另存为的原生框 | 有反应 | 新 `#32770` 窗口，标题「另存为」；WM_CLOSE 后进程仍在、文档未动 |
| P2-2 点「另存为…」→ 新目录+中文空格名 | 有反应 | 目标目录**被自动创建**；磁盘==文档逐字符；`docInfo`/`docPath` UI/原生标题/MRU 首位全部切到新路径；源文件未被动、仍只读；1561 ms 完成 |
| P2-4 另存为后走「文件→保存」 | 有反应 | 后续保存全部写新路径（`saveTrace` 四连证据） |
| P4-H2 占用释放后点「重试」 | 有反应 | 磁盘出现刚敲的字符、提示条消失、tmp 被消耗 |
| P1-C1b 解除只读后点「重试」 | 有反应 | 同上 |
| P1-C3/P4-H1 占用中打字 | 有反应（不静默） | 提示条出现且**不抢焦点**；磁盘字节完全未变（数据没被写坏） |

---

## 三、pageerror / 崩溃

- 4 支探针 `pageerror` 全为 `[]`（P1/P2/P3/P4 均为空数组），无 `PAGE_CRASH` 事件
- 每支结束时 `aliveAtEnd=true`；`tasklist` 复核：本族 profile 的 MarkPilot 进程数 **0**，文件锁已释放（`open 'r+'` 成功）
- 壳层一手记录（`MP_DEBUG=1` → `userData\main-debug.log`）与渲染侧读数一致：`file:save:error {"…error":"EPERM: … rename …"}`、`file:save {"…","bytes":38}`、`pickSaveAs:env …`

## 四、证据文件

探针源码（均在 `.mp-verify\checklist\`）：`file-ops-real-lib.cjs`、`file-ops-real-p1.cjs`、`-p2.cjs`、`-p3.cjs`、`-p4.cjs`、`file-ops-real-lock.ps1`（占用夹具）、`file-ops-real-pick.cjs`（读数提取）、`file-ops-real-scan.cjs`、`file-ops-real-dump.cjs`

原始读数与截图（均在 `.mp-verify\file-ops-real\`）：

| 支 | JSON + stdout | 截图 |
|---|---|---|
| P1 | `p1\file-ops-real-p1.json`、`p1-stdout.txt` | `p1\shots\`：`C1-readonly-banner.png`、`C1b-after-retry.png`、`C2-rename-banner.png`、`C3-locked-banner.png`、`C3b-after-retry.png`、`C7-saveas-dialog.png` |
| P2 | `p2\file-ops-real-p2.json`、`p2-stdout.txt` | `p2\shots\P2-1-readonly-banner.png`、`P2-2-after-saveas.png`；物证文件 `p2\fix\.source.md.mp-tmp-108244` |
| P3 | `p3\file-ops-real-p3.json`、`p3-stdout.txt` | `p3\shots\P3-0-baseline.png`、`P3-1-banner.png`、`P3-3-after-saveas.png` |
| P4 | `p4\file-ops-real-p4.json`、`p4-stdout.txt` | `p4\shots\H2-after-retry.png`、`H5-banner-geometry.png` |

（截图为整幅上下文；结论所依据的"光标/高亮/图片颜色"均已打开看图核对，见 F2 的红/蓝方块与 F6 的压字形态。）

## 五、未验证 / 环境阻断

1. **原生「另存为」框内真选路径**：未验证。CDP 点不到非客户区，接管桌面未获授权 ⇒ C7 只证明框弹出；"路径从哪来"之后的一切由 `MP_TEST_SAVE_AS` 臂覆盖。
2. **保存到已存在的同名文件时的覆盖确认**：未验证（env 臂跳过原生框 ⇒ 真人会看到的"是否覆盖"没走到）。
3. **重命名后"窗口重新获得焦点"这条提示路径**：未做真实焦点切换；仅读码得 `changed:false`（`main.js:1368-1373`，stat 失败即返回未变）⇒ 标注为**推断**，不作读数。
4. **只读的 ACL 形态**（目录拒绝写/只读盘）未测，只测了 `+R` 属性。
5. **图片 `naturalWidth` 判别**未取到（`.cm-content img` 命中的是工具栏图标，文档图不在该选择器下）⇒ F2 改用 `<base href>` + 截图色块判别（红 1×1 vs 蓝 3×3）。
6. **系统剪贴板**：本机锁屏态、对进程不可用；本族用例**未触碰剪贴板**（"复制文件绝对路径"属别的族），故无阻断项。
7. **突变验证**：本族是普查（只读），无修复项 ⇒ 未做突变；F1–F6 均为**现状读数**，不含"已修复"结论。
8. F1/F2/F3 的"应该怎样"以 Typora 使用习惯为准（改名/另存为后基准跟随、操作后焦点回正文）——本轮只给现状读数与代码位置，**未与 Typora 实机对拍**。
