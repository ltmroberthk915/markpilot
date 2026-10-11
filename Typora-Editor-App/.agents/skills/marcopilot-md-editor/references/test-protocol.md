# 最完整测试守则（全轮次范围并集 + 次序框架）

> 范围 = 历次交付轮（v2…v10、2.0.1）测试任务的**并集**，来源为 `scripts/run-release100-task.mjs` 任务注册表 + 覆盖率矩阵（64 项）+ 后台套件（≥291）+ 交付终验。共 **42 个映射任务 + 4 项静态终验**。
> 原则：每个任务"单次可审查"；GUI 锁互斥；**GUI 期间零并行负载**；任务执行器自动清洗密钥类环境变量。

## 0. 六层范围清单（并集）

### L0 静态一致性（无 GUI，可并行）
| 项 | 内容 | 门 |
|---|---|---|
| sync 对账 | 两仓 480 共享文件零差异（`npm run sync` 后抽查哈希） | 零差异 |
| verify | 版本一致 + 桌面源码=app.asar=VSIX 三方逐文件哈希 | `verified:true` |
| SHA256SUMS | 四件产物 `sha256sum -c` 全 OK | 全 OK |
| coverage | 覆盖率矩阵 64 项（16 basic + 48 edge）按 startedAt 取每任务最新通过 | `ready=64, missing=0` |

### L1 后台 Node 套件（无 GUI，可并行；"Node-only; no desktop input or GUI"）
- 单元/集成：math-markdown、completion-platform、autosave、snapshots、text-stats、recent-state、file-open、jump-list、new-document、outline-parse（扩展仓）等，共 298 项。
- **门**：`counts.pass≥291` 且 `productUnchanged`（结果里的 productFiles 哈希须与当前产物逐一相符——后台证据同时证明"测试没改产物"）。

### L2 桌面·渲染器 harness（`run-electron-test.mjs <task>`，专用 Electron 载具跑共享渲染层，14 项）
`regression`、`consistency`、`features`、`repairs`、`ui`、`reading`、`mermaid`、`source-history`、`math-history`、`math-colors`、`math-boundaries`、`table-context`、`history-large`、`theme-audit`

### L3 桌面·真实宿主（真实 main/preload/iframe + app.asar，22 项）
- run-electron-test 宿主类（13）：`workflow-gaps`（骨干，须产 ≥137 行全 pass）、`shell`、`completion`（28 项，含弹窗滚动几何守门）、`protection`、`export`、`export-large`、`media-office`、`media-repro`、`media-lifecycle`、`table-context-host`、`table-input-host`、`source-toggle-host`、`user-file-host`
- split-navigation 类（7）：`nested-math`（弹窗几何守门）、`viewflow`、`quality-boundaries`（=viewflow boundaries 相位）、`navigation`、`selection`、`benchmark-before`（锚定冻结基线 asar `release-1.0.18-private-final`）、`benchmark-after`（指向当前产物）
- 独立驱动（2）：`math-table`（50 轮浸泡）、`file-launch`（真实桌面启动/文件打开工作流）

### L4 IDE 双目标（`test/vscode-smoke.cjs <host-exe> <extension>`，6 项）
`vscode-full`（153 断言，含大纲真实 DOM 行+点击 reveal）、`vscode-chat`、`vscode-focus`、`trae-full`、`trae-chat`、`trae-focus`
- Trae 用内置已过初次配置的 profile 副本；**AI 侧边栏登录态行为在用户本人登录的真实实例上手动验收**，不新拉未登录实例。
- IDE 任务必须指向**抽取的 VSIX 目录**（`test/.runs/vsix-private-<ver>/extension`）。

### L5 真实 API 与交付终验
`live-AI`（LIVE_AI_KEY 环境变量；ds-* 应 OK，glm 侧 auth 排除属正常；产物零 "sk-" 泄漏自检）→ `verify` → `coverage` → `SHA256SUMS` → benchmark 前后对比入报告。

## 1. 次序框架（两轮制：源码树快门 → 产物树终验）

**阶段 0｜定向冒烟（改动域，先行快门）**
只跑与改动直接相关的套件，红→修循环到绿才准进全量：
- 弹窗/补全几何：`completion` + `nested-math` + `math-table`（三套是几何守门组合）
- 大纲/IDE 功能：`outline-parse` + `vscode-full`
- 表格：`table-context*` + `math-table`；公式：`math-*` 全族 + `nested-math`
- 导出/媒体：`export` + `media-*`；启动/文件：`file-launch` + `recent-state`

**阶段 1｜静态 + 后台批量（可并行，GUI 开始前全部完成）**
sync 对账 → L1 后台套件（298）→ 源码级检查。此时不 verify（产物未建）。

**阶段 2｜渲染器层（GUI 锁，串行；便宜→贵）**
`regression → consistency → features → repairs → ui → reading → mermaid → source-history → math-history → math-colors → math-boundaries → table-context → history-large → theme-audit`

**阶段 3｜真实宿主层（GUI 锁，串行；守门与骨干先行，长尾殿后）**
`workflow-gaps`（骨干+已知抖动源，早跑留复跑预算）→ `completion` → `nested-math` → `math-table` → `viewflow` → `quality-boundaries` → `navigation` → `selection` → `shell` → `protection` → `export` → `export-large` → `table-context-host` → `table-input-host` → `source-toggle-host` → `user-file-host` → `media-office` → `media-repro` → `media-lifecycle` → `file-launch` → `benchmark-before → benchmark-after`（最后：性能对比需树已稳定）

**阶段 4｜IDE 层（GUI 锁，串行，一次一个 IDE）**
`vscode-full → vscode-focus → vscode-chat → trae-full → trae-focus →（trae-chat 登录态转手动）`

**阶段 5｜打包后产物树终验（AUTHORITATIVE，全部重指向终产物）**
打包（见 release.md）→ 抽取 VSIX → 以 `ARCHIVE=dist/release-<ver>-private/win-unpacked/resources/app.asar`、`EXTENSION=test/.runs/vsix-private-<ver>/extension` **重跑映射任务**（至少 34 项续跑驱动 + vscode-full + trae-full + 双 focus）→ live-AI → verify（3 显式参数）→ coverage → SHA256SUMS → 报告。
> 源码树绿 ≠ 交付；**只有产物树上的绿算验收**（历轮均如此执行）。

## 2. 硬性门（任一不满足 = 不得交付）

1. UI 新功能/修复：真实渲染 DOM + 真实输入事件断言（命令桥不算）。
2. 弹窗几何类改动：`nested-math` + `math-table` + `completion` 全绿（360px 弹窗盖公式点击点是历史雷区）。
3. `workflow-gaps` ≥137 行全 pass；L1 `counts.pass≥291` 且 `productUnchanged`。
4. coverage `ready=64, missing=0`；verify `verified:true`；SHA256SUMS 全 OK；live-AI `passed:true` 且零密钥泄漏。
5. 版本三处一致（package.json / VSIX 清单 / 文件名与目录）。

## 3. 抖动与失败处理

| 已知抖动 | 处置 |
|---|---|
| 并行负载致 CDP 输入丢字 | 禁因；单独串行复跑 |
| profile UI 2.5s 等待超时 | 复跑一次 |
| Trae 遥测噪声（volo/icube）+ `visible:[]` | 复跑一次 |
| workflow-gaps 的 SV undo 时序 | 历史已知，复跑即过 |

- 复跑规则：**单独、零并行**复跑一次；通过 → 报告披露；连续两次仍挂 → 按真缺陷排查，禁止第三次盲跑。
- 任何失败先看 `.perf/release100-final-*/<task>-<ts>/` 与 `.launch.log`，对照本表分类后再动作。

## 4. 环境与安全守则（执行期间恒定）

- 密钥只经 `LIVE_AI_KEY`；任务执行器会自动剥除 TOKEN/SECRET/PASSWORD/API_KEY 类环境变量——不要绕过它手工传。
- GUI 任务一次一个（`.perf/release100-gui-active.json` 锁；遇到"Another GUI task is active"先确认存活状态）。
- 用户中断 → 立即暂停，不开新任务链。
- 测试实例用完即关；动坐标前确认前台归属；截到用户内容立即删除。
