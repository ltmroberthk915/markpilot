# MarkPilot 3.6.5 内部验证记录

日期：2026-10-30。范围：修复已确认缺陷 ALIAS-MTH05（数学选区端点），独立于 3.6.4 表格/IME 修复批次。

## 1. 缺陷与根因

- 夹具 `前 $a+b$ 后\n`；真实点击公式内部（a 与 + 之间，anchor 4）后 `Shift+End`。
- 期望选区 2..9（`$a+b$ 后`），实际 4..9（`+b$ 后`）；Ctrl+C 载荷缺开头 `$a`。
- 根因：行内公式在编辑态是源码文本；`Shift+End` 走 CM6 `moveToLineBoundary`，不读 `atomicRanges`；产品没有行内公式的选区端点归一化。
- 负控：原子区间候选不可行（点击被吸附到 2，恢复探针入口直接不成立，且不修 Shift+End）。

## 2. 修复

源码 `dsh-markpilot/src-cm6/main.js`（修复后 SHA-256 `141f567c35b02c8c134dd707248e21bad8715def63406a6b831289db1bd58878`）：

1. `mathPointerSelectionSnap`：`EditorState.transactionFilter`。只处理 `select` 事件；空选区不动；对行内公式（`display === false`），若选区一端在公式内部、另一端越过公式另一侧，则把该端吸附到公式边界，整块包含；多选区逐 range 修正，保留 `assoc`。
2. `setMathPointerSelection`：Shift+点击公式标记为 `select.pointer.glyph`，过滤器豁免，保留 `selection-workflows` 要求的精确源码端点契约。
3. 块公式（`display`）不参与，避免影响块级选区。

引擎产物 `MarkPilot-CM6/renderer/cm6/app.js` SHA-256 `823214be44625adc643d7a49764f6b3e5a03725fca459f053d2d11f3dcedd1a4`。

## 3. 验证（真实执行）

- 恢复探针 `alias-probes/probe-mth05.cjs`（最终版 SHA `0e747675…`），在修复 stage（asar `10ae3801…`）与实装 3.6.5 上均 **exit 0**：main slice `$a+b$ 后`、剪贴板等于期望（sha `a0d41178…`）、左控制臂 ` $a+b$`、`productHeld=true`。
- 回归（修复 stage r5）：`selection-workflows` **31/31 pass**（含两条 Shift+glyph 精确端点用例）；`math-workflows` pass；`table-interaction-workflows` **8/8 pass**。
- `mixed-selection-workflows` 1/2：`mouse-reverse-drag-mixed-copy-replace-history` 为 **entry-unconfirmed**，原因是该用例把“未修复的原始拖选端点”当作入口前提，修复后不再成立；不作产品红。
- `quoted-math-subrange-workflows`：**entry-unconfirmed**（剪贴板哨兵装载失败），不作产品结论。
- 安装版 3.6.5 上 `probe-mth05` 再次 exit 0。

## 4. 包装与安装

- 私有打包脚本 `package-365.cjs`：`stage-app` → 直接调用 electron-builder 缓存中的 `rcedit-x64.exe` 写 PE 资源（本仓 `win.signAndEditExecutable=false`，且无独立 rcedit；app-builder 的 rcedit 子命令因 7za 缺失失败，故直接用解出的 rcedit）→ `electron-builder --prepackaged` 产出生产 Setup/portable 与 UUID appId 隔离 Setup。
- 版本资源回读：ProductName `MarkPilot`、FileVersion `3.6.5.0`、ProductVersion `3.6.5`。
- 身份：stamped exe `9d268e06…`、asar `b20fcb74…`（package.json 3.6.5、engine `823214be…`、164 个成员）、Setup `2b2d2e28…`、portable `79cf04ee…`、隔离 Setup `27d2e446…`。
- 隔离身份在含空格路径 `D:\BuyKey\.mp-verify-temp\MTH05 365 Isolated Install` 实际安装：exe/asar/版本/engine 均匹配，`probe-mth05` exit 0；卸载后目录清空。
- 正式安装到 `D:\Users\Ming\AppData\Local\Programs\MarkPilot CM6`（原 3.6.4 安装已在错误参数试验中被其卸载器移除，本次为全新安装）：退出 0，exe/asar/版本匹配，profile `settings.json` 与 `recents.json` 哈希不变（`ef4109…` / `e58305…`），开始菜单快捷方式存在（桌面快捷方式未生成，记为限制）。
- `.md` 关联存活：`AssocQueryStringW(open)` 的 kind 1/2 均指向安装版 `MarkPilot.exe`，kind 20 为 `Applications\MarkPilot.exe`。
- 用户文档副本哈希不变：`a15c5d57…`。
- 交付目录 `D:\BuyKey\MarkPilot-3.6.5`：Setup 与 portable。

## 5. 残留风险/限制

- 表格单元格内公式的选区交互未单独实测（本批未改表格代码；表格交互 8/8 通过）。
- `mixed-selection` 的旧入口前提与 `quoted` 的剪贴板哨兵属测试侧限制，已如实记录。
- 桌面快捷方式未生成；如需可后续补装。
- 3.6.4 的安装历史（升级备份 `C:\Users\Ming\.codex\backups\markpilot-364-upgrade-20261030`）保留不删。
