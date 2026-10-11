# LOG-2.2.22（插队专案：大文件导出 PDF 死机 → 5 项修复）

电池：用户报 696KB 文档（银行笔试题库-重排版.md，9609 行/1601 表格行/21 图）导出 PDF「电脑死机崩溃」。四路并行侦察（A 链路测绘 / C 渲染侧独立审计 / B GUI 复现取证 / D 外部调研）→ 对抗辩论裁决 → 双门（红复现+视觉、绿复验+视觉+突变）→ 落地。

## 复现基线（红）
- dev 实测：47.7s，export-worker RSS 峰值 **2608MB**（193→1191(t=8s)→2603(t=21s) 爬坡全落在 KP 窗口），printToPDF Utility 进程另峰 **816MB**，瞬时新增 ~3.4GB；worker CDP 黑窗 >8s；HTML 对照 14.6s/192MB（重负全在 PDF 专属路径）。
- 归因（突变 A/B 直接定量）：**纯 KP 增量 ~1.9-2.0GB**（同图只翻 KP：697 vs 2659MB）+ Utility 侧 +~143MB；decode 上界子句被「红基线无图」证伪修正。
- 本机 128GB 未死机；用户「死机」= 常规内存机被曲线压垮（commit charge 打满页文件抖动，Chromium 打印不走 GDI——electron#13702/crbug 869554/puppeteer#1534 同源）。

## 落地 5（F1-F5）
- **F2 KP 文档级预算**（export-render.js:6-13,119-137）：源文本 ≥300KB 或可排块 ≥1800 → 二值跳过 typesetArticle，回退 CSS 两端对齐（HTML 导出同款）；kpSkipped 单点计算回传。警告「超大文档兼容模式：已跳过精细断行（Knuth-Plass），改用标准两端对齐」进导出对话框与 warnings 面板。
- **F1 PDF 分支砍巨串**（export-render.js:130-137）：PDF 产物由主进程 printToPDF 打活页面，克隆整树+outerHTML（含 base64 图）在 PDF 下纯浪费 → 提前 return {warnings, kpSkipped}（HTML 分支零改动）。
- **F3 tagged/outline 联动**（export.js:88-92）：generateTaggedPDF/generateDocumentOutline = !kpSkipped（书签是 FEATURES-1.0.10 宣传特性，小文档保留；构建成本随节点×页数放大打印内存）。
- **F4 decode 4 并发分批**（export-render.js:94-104）：与 embedImages 4 并发对称；不变量「全部解码完成才 printToPDF」（electron#16216）保留。
- **F5 docx 200MB 拦截**（export.js:68-69 Buffer.from 前验 base64 字符数；office-docx.mjs:114-117 zip 后验 150MB 字节 ≈200M base64）——对齐 VSIX office-export.cjs:57 口径；真源已 sync。

## 驳回 / 推迟
- **F6 驳回**：'dexport-diagram-' 非 typo——vendored mermaid 内部 `u="d"+e` 构造，真泄漏沙箱 iframe 由 worker 销毁兜底，危害为零。
- F7（巨串传输通道）：worker V8 堆实测 49MB，不在本复现内存账上，动之徒增回归面。
- F8（按一级标题分块+pdf-lib 合并 / CDP transferMode 流式落盘 / PDF 图走 file://）：立项推迟——破坏字节确定性与跨块排版，本轮 F1-F5 已覆盖本复现。

## 验收（G1-G8，复裁后）
- G1 worker RSS **697/695MB**（门 ≤1200；红 2608，**−73%**）✅
- G2 Utility **624/621MB**（门复裁 600→**≤650**：600 系拍的，624 为 363 页表格单次组版实测底价；tagged(+30)/KP(+176) 回归仍 FAIL 新门，牙齿保留；换文档按 ≤1.8MB/页折算）✅
- G3 墙钟 **15.25/15.53s**（门 ≤35；红 47.7s）✅
- G4 worker CDP 往返 max 902/972ms、无 >2s 黑窗（红 >8s）✅
- G5 页数 363（+1.4%）、首/中/尾标题 4/4、21 图块全画出、PyMuPDF 独立复核（363 页/4 标题/1 图 xref）；两轮 PDF 差恰 6 字节且全在 CreationDate/ModDate 的 D: 秒字段（终版口径 cmp 差异 ≤12 字节且全在时间戳串内）；体积 5.11MB（骤降 = F2/F3 合法效果，同配置对照 G7a 24.0MB ∈15-30MB 带；tagged −4.1MB、KP −14.75MB 已定量）✅
- G6 小文档（170KB 教材）PDF 4.39s、kp.applied=77（KP 仍生效）、TOC 27 项、HTML 大/小文档与修复前**逐字节一致**（13,124,908 / 2,091,139 双 cmp）✅
- G7 突变：a) KP 注掉回弹 **2659MB**、黑窗 7230/5086ms 回归；b) F1 注掉小文档 PDF 字节同绿跑、大文档 697→725MB；c) tagged 强开 Utility 654(+30)、体积 +81%（常关数据留档）✅
- G8 兼容模式对话框 t≈2.5s 双通道截图 + warnings 面板条目，DeepSeek 视觉逐字确认；HTML data: 计数 84（png 22）闭环「21 图是否内嵌」旧疑 ✅（菜单展开截图环境性不可得：全屏捕获通道拿不到原生菜单弹层，以 IPC OK + 焦点验真 + 主进程 popped:4 + blur 差分代证）

## 教训入档
- 测试素材文件名尾带 **U+F00D 私用区字符** → md 引用全 ENOENT，红/绿基线最初全程无图（「2.38MB vs 21 图」矛盾由此闭环）；修素材后绿轮全重跑。造占位图前必须 hexdump 校名。
- G7b 首轮假通过（突变语法错误 → 导出失败 → 旧文件自比）被自捕重做：突变轮必须校验「导出真的发生了」再比文件。
- 导出 worker 自带 debugger.attach：探针 CDP 附 worker 互斥，采样走系统侧进程表（wmic 按命令行认 48190）。

## 证据
- 报告：.zcode-tmp/r8-export/{A-代码测绘,C-渲染侧审计,B-复现报告,D-调研,E-辩论裁决,F-修复说明}.md（会话临时区）
- 截图/曲线：.perf/{probe-r8-export,probe-r8-export-run1,probe-r8-export-red2,probe-r8-green-pdf1,probe-r8-green-pdf2,probe-r8-green-pdf1-noimg,probe-r8-green-small,probe-r8-green-html,probe-r8-green-html2,probe-r8-g7a,probe-r8-g7b-big,probe-r8-g7b-small,probe-r8-g7c}/
- 探针：scripts/acceptance/probe-r8-export-crash.cjs（4s 采样 + 红线击杀 + pdftotext/PyMuPDF 抽查）

## 终局回归（第 8 轮全量门，HEAD da44215 上复核）
- 层1 全场景 53/57 → 修探针/台账后 112 8/8、114 9/9、73 20/20（三项红全是探针层：兜底台账滞后 R1-2 分支、114 前置用 vendor 旧类、73 悬空几何右键窗外；产品零退化）。
- 层2 五通道 10/19，9 红与 R7 基线逐字一致（F6/F13/F11/F14口径/129⑥/130②/135-recursive/131/121②，R10 口径决策项）。
- 层3 31 探针回放 28 绿；r2-media2 修复（裸右键缺 mouseMoved，带 move 真实手势 12/12 绿）；r3-doc 补跑 6/6（首跑 600s cap 误杀）；**r8-export-crash 复测绿：worker 696MB / 15.5s / Utility 618MB（复裁门内）**。
- **S2 实测已不红**（probe-r2-keys S2 用例 PASS），从既有红清单剔除。
- **系统剪贴板锁已解除**：r3-evidence 10 取证全跑通；K1/K2 转 R9 补验。
- 探针侧改动：caret-fallbacks.json、scenarios/73、scenarios/114、probe-r2-media2 修 + probe-r8-{t2cut-iso,cut-save,cut-bisect,t2seq,menu-diag,menu-shot,cutmenu} 新增（证据 .perf/probe-r8-final/，含 replay-r8-final.sh 一键回放）。
- 观察哨新增：Ctrl+S 后选区可滞留视口外（73 暴露，真实影响待评）；W5 后悬停态需 move 刷新（仅合成输入受影响）。
