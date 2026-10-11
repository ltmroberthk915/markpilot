# LOG-2.2.24（第 10 轮：收尾轮——终裁 9 修 + confirmDiscard 四门 + 全量收官）

电池：I1 总清点 + I2 口径档案（10 项）→ E10 终裁（13 处代码亲核）→ W1 GUI 修复 + 四路写码并行（W2/W3/W4/W5 按文件辖区分轨）→ V10 串行验收 8 门 + V11 修复复验 P3 → 主会话 10 图视觉复核。

## 落地 10（含 1 销案）

1. **confirmDiscard 四早退族**（main.js ×2 + doc.js ×2，W1，已单独提交 adeea59）：脏判据裸读 `dirty` 落后键入 ≤200ms——关窗/退出/切档三场静默丢字根除。红 3/3、绿 6/6（三门×三选择）+ 负门三支（干净文档零假框）、突变门 1/2/3 各自必红、r10-w1 全量 57 场景 0 失败。连带修三件：渲染层 `__mpInputSeen` 口径收窄（input()/setValue() 清零——粘性标志曾让大文档异步渲染漂移误置脏）、flushEditorText 便宜探针先行（干净文档关窗切档拉值成本数百 ms→ms 级）、场景 72 补 Ctrl+S 洗净（旧绿骑在病灶上）。
2. **F11 全屏加速键**（main.js 一行显式声明；V10 发现 Electron 44 对该 role 本有默认 F11——显式声明冗余但无害，防版本漂移）。
3. **F13 两件套**：Ctrl+Shift+V 粘贴纯文本（Typora 官方键；Chromium 原生虽有同键，接管的真实增量=一条撤销+绕开图片归档拦截链）+ 折叠选区 Ctrl+Alt+V 空剪贴板守卫（旧链 writeText('') 清空用户剪贴板）。
4. **F14 列表项 Tab 缩进**（patchListTabIndent +208 行）：文字中间按 Tab 整项缩进为前项子项；V10 验出守卫裸 `pre` 恒命中 IR 根（skill §9 同款坑），V11 定凶修复（`[data-type='code-block']` 锚）；124 全子项 15/15、配套探针 18 PASS、Shift+Tab 反缩进走 vendor 原生、负门域（段落/代码块/表格/补全框）全绿。
5. **K1b 邮件 cid: 图剥离开**（media-tools）：粘贴载荷 cid: 引用图剥图保文字+一次性 tip，`![](cid:…)` 永久断链引用不再落盘；独立 CID_IMAGE_SRC 勿混归档名单（F4 取证规约）；真 Outlook 本机无 profile 未取真源——两种可能形态均已防住（file:/// 物化走 K1 归档、纯 cid: 走剥离），候选②（位图兜底归档）挂账。
6. **T8 konayuki 代码高亮对比度**（生成脚本 adapt_konayuki.cjs + 产物）：根因=上游 `--syntax-comment` 按 Typora/CodeMirror 调色（dark 2.317:1）；覆写变量+补缺失 token（title/type/class/literal/selector-tag，此前落回 CDN 摆动的动态主题色）；dark/light 双修，实测 5.175/5.403/5.841/6.064 ≥4.5:1，突变回落 2.317=R5 基线精确复现。
7. **121② CJK 裹词**（wordAroundCaret）：F9 真机 Typora 取证 16/16——CJK 连续段整裹（扩到非 CJK 边界、类边界 ASCII 优先）；旧「先左后右各一字」改 cjkRun 双向扩段；牵连面核实为全仓唯一调用点（行内代码键），121② 转绿。
8. **折叠光标观测证人**（patchCaretCollapseWitness，log-only）：三嫌疑（S1 blur 收回/S2 按下期补挂/S3 reconcile 摘展开）+ 病灶形状帧入 `window.__mpCaretRing` 环形 50 条，全 passive 只读；ring 实测填充 0→7。
9. **探针断言改写 6 处**（120②③/122/130②/131/124①）：架构性错位断言全部改为「真量用户可见性质」（paint-only 下划线改 CSS.highlights 注册表门、130 双错位改对齐 battery18 E1 量法、131 改纯文本对账、124① md 按 Lute 归一 ≥2 空格校准）；顺带揪出两个旧断言自身缺陷（130 scrollIntoView 永真读数、120③ 任何行为不可满足断言）。
10. **F18b 反向词跳：销案**（定罪探针 ×3 一致：反向 Ctrl+← 落「设」字尾可见位，无 0×0/无整行钳）——不对称但无病灶，备补丁弃用。

## 回归

human-input 19 场景 **15 过/4 红**（红={124①→V11 已修、126①/129⑥/135=挂账项}，红集较基线只减不增：120②③/121②/122②/130②/131 全转绿）；run.cjs r10-final 57 场景 56 过/1 环境嫌疑（10-open-latency 台账壳侧抬升，V11 复跑 +133→+63 向基线收敛，页面内相位持平+稳态改善 −432ms，判进程启动链环境抖动）；110/111/112/134/r3-doc/r4-find/r9-save/probe-r10-cd 抽验全绿。

## 口径与挂账（E10 终裁全表见 .zcode-tmp/r10/E10-终裁.md）

口径句 9 条（导出白底/Excel 矩形落位/词删按字/Ctrl+Alt+V·Ctrl+Shift+V/双击拖拽/下划线 paint-only/拖放标题栏/cid 兜底/CJK 单字裹词备用句）；销案 4（F20/131/73/K1 缓存位置）；永久挂账 11 组全带触发条件（126①/129⑥/135/D2/F8/K1b②/electron#29485/W5/G6-G10/121② 备用分支）。V10 附带发现：本机 OS 键盘注入系统级失效（NVIDIA Overlay 嫌疑，影响 SendInput 类取证通道，记档）。

## 证据

`.perf/probe-r10-{cd,g45,v10,v11}/`、`.perf/probe-r10-f18b-dev/`、`.perf/human-input/r10-v10-human*/`、`.perf/acceptance/{r10-w1,r10-final}/`；报告 `.zcode-tmp/r10/`（I1/I2/E10/F4/F9/W1-W5/V10/V11 共 12 份）；突变备份 `.zcode-tmp/r10/mutant-backup/`。主会话视觉复核 10 图（V10 8 图 + V11 2 图含服务故障后补验）。

## 交付（2.3.0，2026-10-04，打包 + 本机安装，未推送）

- **产物**：Setup 116,489,259（`b6eb0b0a6914f175309ed23853ab5721c877cf2f47031f1fe98ffeb99c8c0ba8`）/ portable 116,262,177（`b003d619867b286b2849d4efd319fdaae974d5c54fabf8da58a51ae8d0d2d22c`）/ VSIX 6,607,672（`9549af664ad2b4bee48f0d39344b8cdb3eacb15afb5219948d2a09eaca82bcd6`）；`verify-chain` 四链逐字节 verified=true（`.perf/verify-2.3.0/chain.json`，499+36 文件）。
- **本机安装**：EXE 静默升级 D 盘镜像 2.2.16→2.3.0；VSIX 装 VS Code 与 Trae 均成功。
- **安装版门禁**：2.2.16 同款 9 场景子集 **9/9 全绿**（76/87/89/92/101/107/134/137/138）。全量 57 首跑 55 过，两红（90 补全/91 块公式单击）单场景复跑均绿（14/14、26/26，台账回基线 0 帧/1 种）——定性为长跑中的焦点/时序抖动（CDP 点击不抬 OS 焦点的已知坑）；open.* 台账壳侧抬升同 V10/V11 环境口径（页面内相位持平）。
- **文档**：README 中英各追加 2.3.0 一节（verify-readme-keep 双绿「只增不删 ✓」）；CHANGELOG 与 RELEASE-2.3.0.md 同步。
- **未推送**→**已推送**（用户令"推送"，2026-10-04）：
  - 商店：**Open VSX `jinxi.markpilot` 2.3.0 已在线**（发布即成，索引约 1 分钟后可读）；声明 sha256 与下载回的字节均为 `9549af66…`，与本地逐字节一致。VS Code Marketplace 未推（本机无 VSCE_PAT，与 2.2.16 同口径）。
  - GitHub Release：`v2.3.0` **已是仓库 latest**；三资产（VSIX / Setup / portable）的 API digest 与大小和本地逐项相同（`9549af66…` / `b6eb0b0a…` / `b003d619…`），VSIX 下载回字节级复核一致。
    https://github.com/ltmroberthk915/markpilot/releases/tag/v2.3.0
  - 发布合规：RELEASE-2.3.0.md 补「Bug 修复」单列尾节（发布脚本硬规则③）；源码未外泄（publish-github 无源码路径，硬规则①）。
