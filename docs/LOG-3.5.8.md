# 3.5.8 PDF 本机对齐记录

本批目标是恢复代表性长文档的正常 PDF 导出与桌面响应；不将既有编辑缺陷计作已经清除。发布状态为本地交付，未推送、打 Tag 或上传 GitHub Release。

## 实现

- 固定完整 Electron 44.9.3 Windows x64 运行时及依赖锁。发行 ZIP 的 SHA256 `41a1ffa0541cb0f2c9b9fe920dd2cef1793ad0ea2ada1a9582958880f4d1b23c` 同时匹配官方 npm 校验表和 GitHub Release asset digest。
- 默认 PDF 使用 Chromium 原生断行；显式 `kp:true` 或非 null 的对象参数仍启用原有 Knuth–Plass 及文档预算。保留原字体、字号、字重、斜体和合成策略。
- 仅把默认导出 body/strong 的加深描边限定于 screen；编辑面生成器不变，显式 HTML 描边仍保留。未全局清除描边、禁止假粗或替换字体。
- 在可选排版之后无条件检查取消，共用打印截图诊断，并由真正的打印调用前报告一次 `print-start`；worker 只转发真实阶段。
- 原 PDF guard `629c218b…`、文件 worker、独立进程、25% CPU 硬限额、BelowNormal、3GiB Job、私有量和系统余量检查、所有权及原子发布规则不变。采样余量不宣称硬性预留整机内存。

## 因果证据与本机结果

私有证据根为 `.mp-verify/typora-pdf-alignment-r1`。代表性输入约173KB、7.8万字符、38个表格；使用独立文档副本，原件哈希持续不变。测试启动请求独立 profile；末次装机复测的 profile 隔离例外与恢复见下文。

严格运行时对照使用同一最终 ASAR、冻结 HTML `00f6b505…`、extraCSS `a0242491…`、原描边及显式 KP。旧33／新44.9.3／旧33完整导出分别24017／11141／26352ms，输出83页、16.16／12.74／16.16MB。不能将这些条件与最终 native 条件混成单变量测试。

最终候选完整导出7200ms，77页、2244625B；同一窗口真实取消后再次导出5948ms。最终 PDF 去除空白后的59166字符完整序列与原KP版一致。原生策略会改变分页，不强制旧83页。实际 Typora 对照为原生菜单到保存框约3785ms，105页；它先打印再显示保存框，与 MarkPilot 完整导出不同口径，不计算速度倍数。

275项单元检查全部通过；默认策略与取消边界的独立突变各检出预期断言失败。实际 native、显式KP、恢复描边、旧内核、noGPU及guard反证均保留；不采用全局禁假粗、全局换字体、关闭硬件加速或针对44.2的guard启动适配。

最终候选身份：ASAR `c83494acae859ec313f91d1571d0b26f33626e9596f0f9fdc678f018956096f8`，EXE `485a107fe08a161f4f967940f9678723f8347b1e47fd0f6860f484d6e0b3319b`，完整78个运行文件。私有绑定同时保存全部文件集合与摘要。

## 验收范围与保留项

独立 DeepSeek 实读最终文档首／实际表页／尾和组合夹具：粗斜嵌套、楷体、强内代码、数学、长行折行、相对图片、链接、显式1px描边及自定义字面均在抽样范围正常。媒体探针断言 screen描边保留、print默认0、显式描边不变，并记录实际平台字面；不把字体名称或模型替代视觉。

实际基础交互19项、数据安全23项、表格/丰富内容缩放与选择7项通过。真实生产候选取消及同窗重试通过；故障注入仅在私有worker副本中真实打印后悬置返回，验证取消、超时与清理。最终候选的低提交余量拒绝、实际父进程退出及Job清空通过。

本机微软拼音的候选、空格提交、Esc取消、CtrlZ/Y及CtrlS已通过真实Sky按键、可信中文payload、229 keyup、源/历史及最终磁盘字节交叉核验。最初观察器超时和过早读盘失败均保留；独立迟到保存收据通过，不冒称原runner全绿或该臂正常退出。CDP严格合成臂的end信任位不足，保留为transport/commit-unconfirmed；其原因尚未证实，不臆称产品重派发。

旧/新运行时都保留的边界：同级280/281字符含空格的完整安装目录均在ICU初始化失败，未进入应用JS；不记长路径通过，不改系统策略。205%表格Redo的DOM光标600→792在旧33基线同样出现，作为既有缺陷保留。分屏工作流的对象身份断言在旧/新都失败，实际源字符串、方向光标及可写owner的点击/即时输入前缀正确；不冒称整套旧工作流通过。

## 打包与本机安装

冻结候选制作安装版、便携版及随机应用标识的隔离安装版；三种包均逐一解包核对 EXE、ASAR、157个归档成员及全部78个运行文件。安装版 SHA256 `2fabdf2dea1431cc48754b95d3304d08b8c57fa57e3ec0d30aceccc9b27305d0`，便携版 `207bbb826c7f9ea4cd37bb145c251f0ffd2fa62132bc8e43463f12fa1dd377f4`。

隔离安装版在含空格目录完成安装、真实中文/emoji保存、正常退出和卸载，保留原安装；49个已有文档、两套profile、5901行带类型的注册表和两个快捷方式均核对。正式本机升级至3.5.8，安装退出码0；装机目录全部78个运行文件匹配冻结候选，额外文件仅为卸载器和卸载图标。关联保持原状，注册表差异仅为本应用卸载项的名称、版本和估算大小；快捷方式行为及原始字节保留。

装机版实际 Electron44.9.3 / MarkPilot3.5.8，再次完整导出6092ms（外部观察6601ms），77页、2244625B。完整非空白文字59166字符与已验收候选的有序序列一致；原文件哈希不变。后台worker私有内存峰值约560.7MiB，CPU硬限额25%，Job清空；应用正常退出，无残留导出进程。最终PDF另存至输入文件旁，未覆盖原件或已有不同内容的PDF。

末次装机复测发现 Chromium 的 `--user-data-dir` 请求未完全隔离 Electron userData，原配置目录有35个缓存/存储及窗口尺寸文件差异。首次保全检查如实失败，证据保留；确认应用已关闭、设置仅窗口尺寸变化后，先备份差异，再按预先备份和当前哈希恢复19个原文件、移除16个本次新增文件。恢复后重新核对两套profile逐文件字节、49个文档、关联及快捷方式；不把首次失败改记为通过。后续启动工具须先核验实际 userData 路径，不能只依赖该命令行参数。

完整profile、用户路径/正文、截图和备份仅保留私有证据目录，不进入源码交付。源码和安装包均保留本地，未推送、打Tag或发布GitHub Release。

## 表格边界与阅读意图候选修复（table-boundary-fix-r1，候选 r4）

内部记录：本批仅落源码候选，未打包发布。dsh-markpilot/src-cm6/main.js cc210803…（A：首次手势仅可信左键 mouseup reveal，修复 300% 顶部 padding 首击 caret 下缘越界约 17.5 CSS px；B1：readOnly 态 activeCell 即清+同事务清表选；B2：readingSourceIntent 双位置+精确 "select" 读回投影+真实退出 carry，修复真实退出阅读后数据行呈源码并保留合法源上下文；B3：Windows 原生全选固定菜单 id menu-select-all（registerAccelerator:false）→ host onMenu → engine beforeNativeSelectAll 意图钩子 → 固定 edit:selectAll IPC，修复旧意图覆盖用户新选区）。壳层 main.js/preload.js/renderer/host.js 同批三处小改；renderer/cm6/app.js 为构建派生。

验收（freeze-final-13 全身份 source34/runtime78/ASAR157/shellDeps/探针 hash，逐任务前后核验）：directed suite 8/8、维护 table8 8/8（含真实 Undo/Redo）、原生全选正向（真实注册菜单 click 通道+真实胶囊退出，两 raw 全窗图）、parity 两臂（Ctrl+A 正文/折叠/格内一级；编辑态搜索框输入本地全选）、五负控全红（A 视口/ B1 只读活动格/ B2 纯退出源暴露/ carry 保护/ host 前置切断）。非 GUI：preflight+node:test 275/275+asset 合同（core-qualified-native-r4）。假绿更正：selectAll 早期 head-only 判读两份 passed 按裁定改为更正引用，原始收据未改。台账 r22（93 保留+4 新增 candidate_fix_verified_delivery_pending，42 pending 原样）在私有目录；S4（splitview.js ee2f08f…）实测未动；编辑器内容 DnD 拒收守卫在候选源码完好。未推送、未打 Tag、未发布、未安装。
