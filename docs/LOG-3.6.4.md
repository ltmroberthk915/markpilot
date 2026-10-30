# MarkPilot 3.6.4 核验与本地交付

基线 checkout：`ec47ac37554b13cef3488435ee5de51fe42d439d`。桌面版本由 3.6.3 升至 3.6.4，运行时 Electron 44.9.3。私有原始证据位于 `.mp-verify/remediation-363/full-reverify/`；正文、profile、私件截图与升级备份不进入发布材料。

## 修复与数据边界

- 表格位于文档末尾（无尾随空行）时，原实现没有可承载组字的真实文本行：真实 Windows 拼音首键无 composition 事件，提交 0 字。修复给表级选择／活动组字提供 CM 自有输入行，并只在本次组字期间保留基线表格投影，避免重扫把预编辑文本并入表行。
- 行／列／整表选择下的普通文本输入先由原生 beforeinput 路由到目标格内容起点，避免浏览器先把整行 DOM 文本一起替换而复制整行。
- 组字开始、取消、提交的阶段与归属绑定 view／epoch／tail 身份；取消不新增空撤销步骤，提交只有一次正常历史操作；组字期间进入阅读模式或替换文档被拒绝而不是丢字。
- 表格行 widget 对 EOF 截断行计算格范围；`cachedTableGeometry(null)` 守卫避免无几何信息时读取崩溃（仅函数级负控，未找到产品路径红臂）。

## 身份与证据链

冻结源码 `4afa643cc68c6fe3463d597b6ae6615e30d548745ab0f41784892904644209c9`；受控构建引擎 `5b647af3cb9c3ace70e0048e2a7f0cea37032203d87e3c4f37748a6fb8fbaae5`；冻结 ASAR `bd913b0aa3c6e754d837eab549741d41729d89dba7ac60b72e9f6342e26e0c92`。

- 私有 no-op 控制重建（r90）从冻结源码逐字节复现冻结引擎与 ASAR；由 `MarkPilot-CM6` + 已安装运行时经 `tools/quality/stage-app.cjs` 新建的 final-stage-r1 也是同一 ASAR。native r10、CDP r8/r9/r92 与全部突变体因此运行在同一 ASAR 字节上。
- 3.6.4 发布阶段 ASAR `cd8b1bbaef25fbf9c8ca70b802aa468ae15ec8afba30993684c3ffd66a3e5d62`：158 个成员逐字节比较，唯一差异是 `package.json` 版本元数据（`stage-identity-364.json`）。
- 发布阶段重跑：IME 13/13（`prototype-ime-r89/result.json`）、边界 13/13（`pure-boundaries-r89-r1/result.json`）。

## 最终证据

| 验证 | 实际结果与限定 |
|---|---|
| 冻结阶段最终回归 | IME 13/13（r92）；边界 13/13（r9/r92）；r9 首次尝试的 table-only+ime 出现一次 composition 早结束入口异常，见下文未决风险 |
| 发布阶段回归 | 3.6.4 阶段 IME 13/13、边界 13/13，页错误 0 |
| 独立根因负控 | M1（强制 inclusiveEnd=true）行/列首键零事件且文档不变 RED；M2（组字期用 live tableData 投影）midUpdate `ni'haoni` + CM `null.dom` 页错误 RED；M3（关 beforeinput 路由）普通 Q 整行重复 RED；M4（去历史隔离）取消后 Ctrl+Z 不再恢复 Q RED；M6（去阅读守卫）pending-reading 提交丢失 RED；M10（去 source-range 尾例外）组字文本串入第二格 RED；同批恢复控制 r90 26/26 GREEN |
| 负控限制 | M4b/M4c 对现有臂不可鉴别（M4a 是有效根）；M5（ownsTableComposition/prefix）现有产品入口均被上游拒绝，未单独突变；M7 仅函数级 RED（冻结返回 null / 突变体抛 `null.signature`），GUI 行臂 GREEN，不冒充产品路径 |
| 真实 Windows 输入法 | native r10：PLAIN 与 PURE_NO_NL 均以真实虚拟键完成 ni→hao→Space，全文、一次 Undo/Redo 精确；每步核 PID／启动时间／HWND／前台／焦点／物理点／HKL 与释放。该有限复验不覆盖全部历史 native 合同，也不覆盖下文早结束组合 |
| 独立视觉复核 | `visual-review-final-r1.md`：对 final-visual-r3 的 12 帧 PASS（qualified）。提交帧单元格内可见 DOM 光标定位在 `你好` 之后；`你好ba1` 光标在 b 后；无源码暴露、重复、裁切、错位或乱码。Q7 明确：旧 native 帧红线在行右块边界，不是单元格光标，不能作光标证据。限定：DOM 帧来自私有构建，非 OS native 证明；鼠标/框选/拖拽帧为基础夹具，不证明 IME 文本在那些交互后保留 |
| 受影响回归 | 最终阶段 11 个维护套件 112/113 通过：cell-composition 的 CDP 组字臂为 `transport/commit-unconfirmed`（与 2026-10-11 历史收据同状态，禁止当成产品红）；其余 table-interaction 8/8、table-scroll 7/7、block-source 21/21、selection 31/31、split-source 2/2、command 3/3、document 10/10、image-payload 11/11、source-layout 16/16、mixed-selection 2/2 |
| 原 99 项续跑 | T3 EX5：`fixed` 通过（PDF 在飞时单文件 HTML 导出给出错误反馈）；T5 S1：`green-no-ghost-overlay` 通过（源探针 CLI 守卫有恒假断言，私有适配仅改该守卫，探针体逐字节未变）；LEAD-ACTIVE-ROW-DOUBLE-MAP：有限注入合同通过（沿用原有限注入限定） |
| 断言恢复 | `ALIAS-MTH05`／`ALIAS-IN-C4`／`ALIAS-IN-C6` 的原始定义在 `Typora-Editor-App/.mp-verify/v340/edit-r2/` 逐字恢复（lane-math `21bda308…`、lane-input `37d04185…`）；`ALIAS-MTH02` 的定义同树 `MTH-02` 找到；原“定义不可得”结论被推翻，等价实测另行记录 |

## 未决风险与保留

- **CDP composition 早结束**：r9 的 `table-only+ime` 与发布阶段 final-visual-r4 前两步出现 `compositionend` 携带预编辑文本（`nihao` / `ni`）先于提交 `insertText`。产品按既有语义把预编辑提交进格，随后提交文本再落一次，得到 `nihao你好a1` / `ni` 前置。同一 ASAR 的其它运行（r92、final-visual-r3）为正常序。两次均保留原始收据；这是 CDP 输入序列下的间歇现象，真实 OS IME 未覆盖该组合，登记为未决风险，不写成已确认产品缺陷，也不写成已解决。
- 真实 OS IME 只资格化 PLAIN 与 PURE_NO_NL 两臂；物理 DND／external move 仍无授权工具，未恢复。
- 原 99 项中仍有许多需要原定义／绑定／入口的条目；续跑计划与逐项分类见 `audit-continuation-plan.md/json` 与后续 `recovery-continuation-r1`。
- 旧 native 帧红线不可作光标证据；本轮新增的 DOM 光标证据只覆盖上述帧。

## 安装交付

- 打包：electron-builder 25.1.8，`candidate-364`。PE `FileVersion=3.6.4.0`、`ProductVersion=3.6.4`；stage EXE 经图标与版本资源写入后 `105282a9938e3be106712be9c872e709f289e8dcd87f8cbab966b823d970cbcd`，ASAR `cd8b1bba…`。
- 正式 Setup 117,596,590 B / `b4ca994370713f825991f6cc50aa351fcff4c025fcac4b10da9619edf10d2de6`；portable 117,335,246 B / `4a1b4efe60350d6f2ccc00420a1dda704810c1e5c05b037af1e02116b276319c`；隔离测试包 `909fa06a21544cabb94ffe1761f87514b63f58676eb3c4780db5c25219c0a81e`。三个安装包解包均核到 158 个 ASAR 成员与 78 个运行文件逐字节一致。
- 隔离身份 `app.markpilot.quality.4e6c7c8636614f3d9343a4781096da83` 在 `Install With Spaces 364` 下实际安装／校验／卸载；安装后 EXE/ASAR 与候选一致，既有安装项保持，卸载项消失。
- 正式升级前完整程序、profile、26,532 个注册表键值类型、222 个快捷方式与 80 个程序文件快照＋备份（`C:\Users\Ming\.codex\backups\markpilot-364-upgrade-20261030`）。正式 Setup 以 `/S /D=` 原地升级：升级前 `90932660…/5ae6e090…`，升级后 `105282a9…/cd8b1bba…`，退出 0。
- 升级后对比：profile 487 个文件不变；程序载荷 78 个文件与候选一致，额外仅安装器拥有的 Uninstall 与图标；原升级项仅自有卸载键与两处 MarkPilot 快捷方式变化。Windows AppModel 的 3 个 HAM/AUI/LU 末次使用时间戳在安装窗口内单调变化，按同族既有裁定归为非注册活动元数据（写入进程未独立追踪，不回写）。无其他非预期注册项/快捷方式变化。
- 安装版版本资源 3.6.4.0/3.6.4，卸载项 `MarkPilot 3.6.4`，桌面与开始菜单快捷方式均指向实际 EXE。
- 安装版复验：IME 13/13（`prototype-ime-r88`）、边界 13/13（`pure-boundaries-r88-r1`）、table-interaction 8/8（`affected-installed-table-r1`），页错误 0。
- 安装版正常默认 profile：真实 profile 启动 3.6.4，合成 A 文档经实际菜单保存；再以 Windows Shell 默认 `.md` 动作打开合成 B，第二实例在新窗口载入，A 的文档身份、文本、选区与脏状态保留，一次 Undo/Redo 历史保留，两个自有窗口按 IPC 门禁干净退出（`adapters/normal-installed-364-r2/result.json`）。首次尝试 r1 在同一步超时，根因是 DSH 环境导出的 `ELECTRON_RUN_AS_NODE=1` 让 Shell 启动的第二进程按 Node 执行；修正探针子进程环境后 r2 通过。r1 与 `manual-launch-364/stderr.log` 保留，不写成产品回归。
- 交付目录 `D:\BuyKey\MarkPilot-3.6.4`：Setup 与 portable 哈希同上。

未推送、未发布 GitHub Release。升级备份保留，未删除。
