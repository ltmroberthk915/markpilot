# MarkPilot 3.5.5 验证与交付记录

本记录覆盖历史56条登记项与新增16条发现的有限结论。登记项包含已修行为、复核、别名、契约限制和取证入口缺口；不能换算为56个或40多个已确认未修bug。SPLIT-S4按既定范围冻结。没有把入口失败、假设被反证、旧描述缺失或静态线索记为产品修复。

## 代码与实际包

- 引擎源码33份；应用资源151份；实际ASAR成员151份；Electron运行时75份；完整资源/运行时映射226项。
- main.js：`b28cc3fc3796da659f8d2867784daa7eb1be912b3482d26dfd8d955d1ab987af`。
- app.js：`2ff47726eb8db7c972186a99562b7968d4cfa1836422e1354a667e132b11ad5b`。
- ASAR：`c94f813dc22281fd6d36a2e28c5c079069483430038087c21ad91f569669312a`。
- 实际内层PE：`c67ffb241659a94033a3ac125860b86c995e9cca05e803d0d8a4d8a60167b1a7`，文件版本3.5.5.0、产品版本3.5.5。
- 三种包装逐份完整解包比对151 ASAR/75运行时全部一致。与最终功能验收相比，33源码/151资源/实际ASAR及其它74运行时文件逐字节一致，仅PE版本/图标资源更新；功能验收按该关联复用，未冒称重新执行。

| 交付物 | 字节 | SHA256 |
|---|---:|---|
| production/markpilot-3.5.5-portable.exe | 84441016 | `29390f8c459c1df776915218b40152aceaa058c90a91006f51b03ece401b6284` |
| production/markpilot-Setup-3.5.5.exe | 84702343 | `32b95c5fde1f820e27b4ebe4d465932e5eb9cf5bfc7dd6fb1e0a23195af844c3` |
| isolated/markpilot-quality-Setup-3.5.5.exe | 84637316 | `2f864a6e22d7e7c5bd0de2b8e1da28a2b7af59f730d3cee56c7b2ee0bef35ec6` |

## 主要修复与判据

- 首次单元格拖选：原始真实mousedown→12次按住移动→mouseup；逐步UA落点、DOM选区与CM源码映射一致，固定anchor且head连续推进。关闭该修复实际负控失败，精确COPY恢复后同臂通过；保留原始富格式严格选字判据与新的首次拖选判据的语义区别。额外普通文本正反向、转义管道正反向、buttons=0、Escape取消均有有限实际证据。
- 短列换行：按当前字体/布局的真实测量，在有界表格中寻找可减少短列换行且不恶化其它单元格行数/高度/溢出的列宽。保留原宽度可行回退；没有按固定6字或8字阈值，也没有宣称全局最优。克隆样式对齐有独立实际负控、精确恢复与主题/缩放证据。
- 强调源码边界、富HTML多选区粘贴、异步图片上下文、多窗偏好与阅读锚点分别保留对应有限原臂、独立负控与恢复证据。各族证据不能互相替代。
- 图片冷API进入后的重复节点清理：原负控出现两个可见解码节点，精确恢复后初始/单击/双击三个阶段均仅一个；同src保留、错误src→有效src恢复另有有限邻域证据。

## 回归与视觉

- 当前共享回归：36个维护测试文件259/259；编辑工作流75/75；增量工作流10/10。原先10项仅因私有空输出父目录不存在而ENOENT的收据保留，补目录后原判据未改。
- 后补传递依赖检查：images维护测试24/24；image-insertion.mjs实际全文与SHA在前后守卫中固定。原core36守卫未包含这个导入fixture的事实保留，不能由原守卫推导它的历史SHA。
- 精确归档4份维护输入：table-geometry.test.cjs、table-width-styles.test.cjs、fixtures/image-insertion.mjs、editing.cjs。其余34份顶层维护测试已与候选一致。没有虚构专属强调span、多range富HTML或DOM段落锚点的新增unit；这些性质由各自有限native/GUI原臂证明。
- 最终图片/首次拖选独立视觉实际读取17张图；几何复核实际读取14张图，主控已审完整报告、原始读数与实际tool proof。
- T4原四种缩放路径有限对齐成立；覆盖层聚焦的快捷键入口仍未证明。PageWidth交叉臂整体entry_unconfirmed/productnull保留，只有自然恢复owner后的T4离散几何子结论。C10原源码Enter/Undo有6个完整且含真实字形的几何采样；PageWidth臂字形为空时不算零交叠通过。
- T4末帧红标记偏移经唯一只读诊断复现：布局宽度645→807时正文左边界移动81px，DOM/API/实际字形和绘制选区同向移动，固定红标记停在旧坐标。原首帧PNG精确复现；裁定为标记跨布局世代，没有据此修改产品或宣称所有原生光标正确。

## 隔离安装与保存

唯一quality appId在含空格的独立路径实际安装、运行和卸载；未执行生产安装器，也未启动便携包装器，便携版完整解包证明单列。安装目录为75应用文件＋2份独有卸载元数据；两个实际进程内均完整读取151份ASAR并匹配。

原首次拖选原臂与冷API图片原臂在新PE中通过；实际键入后Ctrl+S，独立回读磁盘UTF8字节/SHA一致。两个已保存窗口正常关闭，owned PID归零、私有profile移除。卸载后4773行含类型注册表、3个原快捷方式及两个原profile的文件集合/字节全部与安装前相同；原安装EXE/ASAR存在状态和字节也相同。

前两次保护性中止均保留：第一次安装前发现旧注册路径的MarkPilot.exe本来缺失；第二次实际安装后、任何主目标输入前，被混合斜杠路径的ownership精确字符串检查挡住。最终入口只统一path.join表示，未放宽SID/PID/profile/可执行路径守卫。第二次与最终安装卸载均保留原注册/配置。

本机已安装版本未升级，安装按既定选择延期。README中英文通过原verify-readme-keep脚本：两份原内容全部按顺序保留，分别新增8行。发布确认与本机升级分开。

## 历史登记逐条口径

状态中的source_bound_d02_r2等表示对应先前实际包的有限证据，不能解读为新PE逐条重跑。历史描述缺失、原生IME/外部拖拽/系统剪贴板入口缺口仍如实登记；它们不自动构成已确认待修缺陷。

| ID | 登记性质 | 当前有限状态 |
|---|---|---|
| T1 | 拖源残留与外部move误删 | fixed_same_view_external_entry_gap |
| T2 | 嵌套列表导出平铺 | finite_original_scope_source_bound_d02_r2 |
| T3 | PDF在飞时单文件HTML吞错 | finite_original_scope_source_bound_d02_r2 |
| T4 | 缩放后覆盖层/表工具栏几何 | current_original_zoom_finite_geometry_root_and_independent_accepted_package_verified_release_pending |
| T5 | 阅读模式从窗点击幽灵覆盖层 | d02r2_original_readonly_split_ghost_overlay_finite_reexecuted_root_reviewed_final_association_pending |
| T6 | 分屏无事件变化重对齐 | finite_original_scope_bound_d02_r2_reflow_interaction_separate |
| T7 | 位图粘贴绕过围栏/公式守卫 | finite_original_scope_source_bound_d02_r2 |
| T8 | 大表每键派生链重算 | finite_original_t8_benchmark_scope_bound_d02_r2 |
| T9 | IME搬迁历史是否两步撤销 | finite_hypothesis_counterproven_neighbors_separate |
| T10 | 表行边界直接组字 | current_r3_natural_source_entry_three_cases_green_old_click_contract_incompatible |
| T11 | 组字中菜单撤销静默无效 | finite_original_scope_source_bound_d02_r2 |
| T12 | 长会话早期撤销历史裁剪 | current_original_whole_arm_accepted_final_binding_pending |
| T13 | worker失败降级/命令解析异常 | finite_original_scope_source_bound_d02_r2 |
| T14 | 选区派生与结构字符扫描测量缺口 | finite_original_a4_a5_current_qualified_green |
| T15 | 富文本链接转义/代码语言/列表起号 | finite_original_scope_source_bound_d02_r2 |
| T16 | 富文本图片绕资产插入策略 | candidate_fixed_functionally_accepted_package_verified_release_pending |
| C2-X | 多选区容器守卫与内部dispatch崩溃 | exact_original_crash_not_reproduced_current_qualified |
| OLD-IMAGE-A3 | 图片全局串行队列跨文档阻塞 | finite_original_scope_source_bound_d02_r2 |
| OLD-IMAGE-A4 | imgBlobs同路径字节缓存不失效 | finite_original_scope_source_bound_d02_r2 |
| SPLIT-S3 | 从窗右键分诊用主窗坐标 | closed_published_354 |
| SPLIT-S4 | 分屏每键全量setState成本 | frozen_by_user |
| DRAG-C2 | input.drop被表选择守卫改写残余 | contract_incompatible_original_joint_entry |
| DRAG-C3 | 拖入已打开格覆盖层无归属 | real_gesture_entry_gap |
| DRAG-C4 | 文件拖入丢落点/只取首文件/图片打开 | finite_original_scope_source_bound_d02_r2 |
| DRAG-C5 | 从视图拖放死区 | finite_original_scope_bound_d02_r2_reflow_interaction_separate |
| DRAG-C6 | ImageWidget拖图载荷直接进格 | selected_image_preselection_qualified_native_drag_entry_gap |
| OLD-W-IN-02 | 分隔行守卫tableLead.body无效 | finite_original_scope_source_bound_d02_r2 |
| OLD-SB5 | 异构多光标Enter不续列表 | finite_original_scope_source_bound_d02_r2 |
| OLD-SBW1 | 转义管道段落误认表行 | finite_original_green_bound_current_candidate |
| OLD-TBL8 | Excel单单元格粘入格被拒 | finite_original_scope_source_bound_d02_r2 |
| OLD-D02 | 阅读模式或版心变化主视图丢滚动锚 | r2_original_reading_layout_two_nc_wheel_cancel_and_replace_scroll_subproof_accepted_package_verified_release_pending |
| OLD-D03 | mirror后同一行第二次点击无高亮 | finite_original_scope_bound_d02_r2_reflow_interaction_separate |
| OLD-D05 | 多窗快捷键和偏好同步不全 | two_window_and_storage_boundaries_green_nc_red_restore_green |
| ALIAS-MTH02 | MTH-02剩余形态旧别名 | mapped_finite_alias_with_remaining_description_gap |
| ALIAS-MTH05 | MTH-05选区原子性旧别名 | original_description_missing_bounded_search_complete |
| ALIAS-IN-C4 | IN-C4旧输入别名 | original_description_missing_bounded_search_complete |
| ALIAS-IN-C6 | IN-C6旧输入别名 | original_description_missing_bounded_search_complete |
| EDGE-A5-A2 | 无前导管道/文末safeFrom残余 | finite_original_scope_source_bound_d02_r2 |
| GAP-IME-51-52 | 纯表与table-at-end组字入口 | four_original_qualified_green_no_tail_LF_CDP_entry_gap |
| GAP-57-MOVE | 已修#57真实move补证 | finite_original_scope_source_bound_d02_r2 |
| GAP-61-MERMAID | 已修#61 mermaid落点补证 | finite_original_scope_source_bound_d02_r2 |
| GAP-62-CLIPBOARD | 已修#62有效载荷自证补齐 | four_original_opaque_PNG_payload_qualified_bound_guard_remaining_attempt0_gap |
| GAP-60-SOURCES | 已修#60公式/换行来源子臂 | finite_original_scope_source_bound_d02_r2 |
| WEAK-IME-LANDED | 多段提交或位移landed不匹配回退 | native_ime_entry_gap |
| WEAK-PLAIN-DIALOG | 对话框paste消费编辑面的原样粘贴票据 | session1_clipboard_OpenClipboard_access5_entry_gap_no_product_launch_no_write |
| OBS-DIRTY-UNDO | 撤销到已存内容仍显脏标 | finite_original_scope_source_bound_d02_r2 |
| OBS-CUT-NOSELECTION | 无选区cut与copy不对称 | adjudicated_no_selection_cut_noop |
| WEAK-IME-SAVE | 组字中菜单保存瞬时文本 | finite_original_scope_source_bound_d02_r2 |
| WEAK-RETAINED-DROP | retained块图片拖入边界 | real_gesture_entry_gap |
| T5-KEYBOARD | 阅读态Ctrl+E/Ctrl+A表格覆盖层邻域 | d02r2_original_readonly_ui_source_finite_protected_body_route_final_association_pending |
| C2-MULTIRANGE-PASTE | 多range粘贴只看主选区容器守卫 | candidate_fixed_functionally_accepted_package_verified_release_pending |
| LIST-TAB-SAME-ROW | 同一列表行多个光标Tab重复缩进 | finite_original_scope_source_bound_d02_r2 |
| SPLIT-STALE-ECHO | 分屏旧滚动回声登记吞后来的真实回程滚动 | finite_original_scope_bound_d02_r2_reflow_interaction_separate |
| COPY-OS-IMAGE-FLAVOR | 含图片全文真实Ctrl+C仅输出文本/HTML，无系统位图 | four_old_qualified_four_environment_unqualified_current_attempted |
| C10 | C8 源码投影后表格工具栏遮住真实源码行 | current_original_source_enter_undo_geometry_root_and_independent_accepted_package_verified_release_pending |
| OUTLINE-ZOOM | 非100%缩放时点击大纲跳转位置偏移 | finite_original_scope_bound_d02_r2_reflow_interaction_separate |

## 新发现逐条口径

| ID | 当前有限状态 |
|---|---|
| C2-MULTIRANGE-PASTE | candidate_fixed_functionally_accepted_package_verified_release_pending |
| NEW-MULTIRANGE-MAININDEX | candidate_fixed_functionally_accepted_package_verified_release_pending |
| NEW-MULTIRANGE-HISTORY | candidate_fixed_functionally_accepted_package_verified_release_pending |
| T16 | candidate_fixed_functionally_accepted_package_verified_release_pending |
| NEW-ASYNC-IMAGE-CONTEXT | candidate_fixed_functionally_accepted_package_verified_release_pending |
| CODE-LITERAL-EMPH | candidate_fixed_functionally_accepted_package_verified_release_pending |
| EMPH-CODELINE-EXCLUSION | candidate_fixed_functionally_accepted_package_verified_release_pending |
| EMPH-TRIPLE-EDGES | candidate_fixed_functionally_accepted_package_verified_release_pending |
| EMPH-ADJACENT-SHARED-RUN | candidate_fixed_functionally_accepted_package_verified_release_pending |
| NEW-OUTER-ITALIC-NESTED-STRONG | candidate_fixed_functionally_accepted_package_verified_release_pending |
| NEW-MATH-ADJACENT-DOLLAR-PARITY | static_lead_finite_qualification_pending |
| NEW-TABLE-SHORT-COLUMN-WRAP | theme_r3_native5_matrix_core_gui_accepted_package_verified_release_pending |
| CAND-TABLE-CLONE-STYLE-PARITY | theme_r3_actual_parity_nc_red_exact_restore_green_native5_accepted |
| OBS-IMAGE-DUPLICATE-NODES | candidate_cold_image_duplicate_nc_restore_boundaries_core_independent_accepted_package_verified_release_pending |
| OBS-READING-REPLACE-SELECTION-END | formal354_and_d02r2_same_natural_postreplace_end_observed_finite_workflow_impact_unproven |
| NEW-TABLE-FIRST-DRAG | candidate_first_gesture_actual_nc_restore_original5_six_boundaries_core_independent_accepted_package_verified_release_pending |

相邻美元公式的静态解析差异在正式3.5.4与当前同段源码中相同，缺少原始编辑/导出配对复现，保留线索；未据静态推演修改公式行为。DRAG-C2原自然入口要求同时维持正文19..28与表行87..98，和既有自然选择契约不相容；保留原菜单入口失败及productnull，没有冒称原生COPY通过。C6仅选中图片来源证明成立，实际原生dragstart/drop拒绝入口尚未成立。

## 2026-10-24：源码缩放定位、表格失焦与较深目录保存

本轮继续处理用户澄清的源码侧映射不稳定，以及离开单元格后整行露出源码的问题。渲染区与大纲原有映射保持原范围，S4 仍按用户要求冻结。保持 3.5.5 未发布候选版本；用户已明确选择保留安装包、暂不发布，本机安装继续暂缓。

### 修改与有限范围

- 源码分屏的高度图、documentTop 与视口坐标使用同一 client 像素口径；只在写 scrollTop 时换算为布局像素。修正未挂载行回退、长行行内分数和非100%缩放后的定位，不更改滚动意图、回声票据或 S4 的增量同步。
- 单元格 blur 延迟到微任务，并核对原视图、原编辑对象和焦点归属，避免鼠标原生落点计算途中撤掉投影、制造跨格源码选区。正文实际字形仍可继续编辑，Escape 露出原始源码和 C8 闭区间选择保持。
- 当前活动行远离单元格的纯空白，只在可信单次主键、原格真实焦点、源码/代次/范围一致、非组字且无修饰键时保留该格。保留 Shift、拖选、正文、邻近单元格的正常路径；没有把所有表格外像素统一拦截。
- 隔离安装发现原生 FileWorker 在较深 EXE 所在目录无法启动。原 C# 进程、可执行文件和构建戳均不变；每个新代次从固定打包成员核对完整字节，在经只读祖先/owner/DACL/reparse 检查的 KnownFolder LocalAppData 下创建进程专用执行目录，独占写入、同步并复核后执行。没有公共 TEMP 回退、ACL/系统设置修改、缓存或清扫器。
- 共用异步启动承诺；已接收的 prepare→commit/abort 事务持有进程生存期，等待旧失败进程退出后才换代。will-quit 在脏文档选择完成后等待已接收保存、EOF、子进程退出和目录清理；取消退出后仍可保存。未知提交仍保留真实恢复文件，不重放、不降级覆盖。

### 当前身份与校验

- 源码33、完整载荷153、实际 ASAR 成员153、运行时75；完整绑定 `delivery-native-longpath355-r3/full-binding-root-r3.json` SHA256 `849388d3351060b306699bb74d65a7d094969aa802b3dc40211a0d5a08e3856c`。
- ASAR `903c2717a66b58ddbd5b3e4e64dec63bee62e9339023052fcd62319154a3cbbb`；PE 3.5.5.0、EXE `c67ffb241659a94033a3ac125860b86c995e9cca05e803d0d8a4d8a60167b1a7`。
- 前端 bundle `2bbedc519085ee77d6e2ec6003477a6c883eb98b619f24f2a2351fd3cb6c64db`；原 FileWorker `49d1b860c778393a096d2aa38b13f6b565011d48e7d4a4866aadc9521e9caf95`。
- 当前维护测试一次完整执行264/264，无失败/跳过；含3个分屏坐标维护测试及2个原生租约/实际 PowerShell ACL 函数测试。所有产品构建、运行、安装和测试均在远端完成。
- 安装版、便携版和隔离安装版实际解包均核对153完整载荷、75运行时和153实际 ASAR 成员，没有沿用旧绑定里的派生身份字段。

### 实际交互与负控

- `runs/source-table-zoom-final-r2`：表格空白/正文/Escape、大纲125、源码分屏100/80/125共7臂均有合格入口并通过。三个根因分别真实关掉后失败，整个源/载荷/运行时 COPY 精确还原，同一操作重新通过。
- 五通道分别核验了可见真实输入、撤销、正文拖选与 Shift 扩选、单元格首手势拖选和 Shift 点击。首版 body 后续点击被覆盖层挡住的失败保留，仅该臂改用实际覆盖层字形入口重跑。
- `runs/source-table-zoom-long-r1`：80%/125%多屏长逻辑行、主/从真实滚轮均通过独立 DOM 行内分数核验；未以两侧任意像素 y 完全相等作为标准。源码、历史和归属均保持原约束。
- `runs/nwp-gui-current-r1` 的 table/image/mapping 三臂，加 `runs/nwp-gui-saveclose-r2` 的 saveclose，均实际保存精确字节、正常退出并清理该主进程租约目录。覆盖图片保存→取消退出→同进程继续保存，80%源码跳转→CtrlS后立即关窗等待保存，以及未先 CtrlS 的保存并退出。
- 原生路径 NC r2：只绕开短目录物化，正确指向实际存在且 SHA 不变的原打包 `app.asar.unpacked` EXE259；在 app-root202 上实际 CtrlS 重现进程退出4294967295、原1068字节不变且1085字节草稿保留。整个33/153/75 COPY 还原903后，同一表格保存操作精确1085字节、正常退出和租约0。证据 `native-worker-fix-r1/nc-prep-r2`、`nc-off-copy-r2.json`、`runs/nwp-gui-{nc,restored}-r2`。
- 新物化过程引出的已接收事务退出竞态另有真实协议负控：移除事务生存期持有后出现 MP_FILE_WORKER_CLOSING，精确还原后同一并发保存/中断恢复/正常关闭维护臂通过。原始原子替换、ACL、哈希冲突及未知提交语义保持。
- 独立最终视觉实际打开7张图，补充复核又实际打开修正负控与还原2张图；`native-worker-final-{visual-r1,supplement-r2}` 的报告/结果及实际工具证明均保留。A/B 的五通道及三根因负控按同33源码/前端 bundle 身份复用，原生后端轮次没有冒称全部重新执行。

### 证据修正与保留限制

- 最初物化 NC r1 的正则没有把 Windows 路径中的 app.asar 转为 app.asar.unpacked，实际触发 ENOENT。截图、原报告和原始失败均保留；它不作为原始长路径故障的因果证据，由正确映射、原进程实际退出4294967295的 r2 替代。
- 最初四臂汇总因空观测集合查询 PID0 而为 false，原结果不改写。只修正测量器并重跑失败的 saveclose 臂；产品一直是同903。saveclose 的瞬态辅助进程父 PID 未捕获，明确保留缺口，不能把空集合视为未知孤儿进程为0。
- 关闭对话框选择使用既有 MP_TEST_CLOSE_RESPONSE，实际编辑/CtrlS、app.quit/window.close、落盘及退出均执行；不称已物理点击原生对话框。
- 120/244/259 与目录/cwd 轴实验只说明当前环境的实际边界，不推断普遍 CLR 最大路径值。无强杀/注销完整清理保证；同 SID/admin 对抗不在此范围。
- 历史56条及既有16条发现保留逐条原有限状态，新增4条单列。仍保留真实原生 IME/拖放/剪贴板入口缺口、旧描述缺失及冻结项，没有把它们算成“仍有40多个已证实未修的 bug”，也没有宣称所有历史项已清零。

### 安装、保护边界与保留包

`remote runs/nwp-install-r3/result.json`（SHA256 `af1161d270394c7cd1580f4bbbba514f6fea0644edfb0b81540df1aef5a45955`）实际通过：隔离安装目录202字符且含空格，原打包辅助进程路径259字符；Session1/Default，运行时75加仅属于隔离安装的卸载器/图标2文件。表格首手势拖选、API图片自然操作、80%大纲/源码点击三个入口均合格，分别保存1082/220/12087字节；真实 CtrlS 后正常关窗、各主进程租约目录0、隔离卸载通过。4773条带类型注册表记录、3个快捷方式、原有用户配置和既有安装字节前后完全相等；未运行生产安装器，未实装本机。图片臂没有冒称原生剪贴板入口。

本机保留目录 `closure-all/delivery-native355-public-r3`（与原 `delivery-355-public-r1` 分开，旧包未覆盖）：

| 文件 | 字节 | SHA256 |
|---|---:|---|
| markpilot-Setup-3.5.5.exe | 84705527 | `97d7f903121507b2a354f0dfa2add2d3bbfdaf0254a0edf22089c255f15ed95f` |
| markpilot-3.5.5-portable.exe | 84444226 | `f5d1d1bdd231f3779f04ffafa8ea940dd3b74861dd3bcf5847565e767b6636da` |

两包传回后独立哈希均相同，SHA256SUMS 为 `490c6735d03af6b903573d7efca91a64e742687c95efbe1316ec60b1e0d25fd2`。README 中英文只增加新收益段，远端原始 verify-readme-keep 验证全部旧行顺序保留（792→794、797→799）。源码33与153载荷逐项比对本机规范目录相同，5个无关插件改动保持原哈希；原有 Android、旧文档和插件未跟踪文件未纳入提交。未 push、未建 tag、未创建 release，未实装本机。

安装后独立复核的最终报告和实际 read_image 证明，记入 `native-worker-final-install-r3`；它只补充当前完整包/实际隔离安装与既有有限功能验收的关联，不扩大历史入口范围。
