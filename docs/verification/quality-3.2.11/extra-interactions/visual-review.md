# MarkPilot 3.2.11 补充交互视觉复核（引用公式子选区 / 表格 Unicode / CDP 合成臂）

## 0. 核验身份与取证口径

- 产品：实际安装的 3.2.11 —— `app.asar` sha256=`0ea5ef6c…3dcf7`（7,534,868 B）、`MarkPilot.exe` sha256=`c32d46ec…9e5c7b`（188,779,520 B，版本 3.2.11.0）；本次只读重算，与三份 result.json 的 artifact 块一致。
- 三份报告磁盘哈希与证据包声明一致：quoted `5a588959…`（renderer-chain-pass）、cell-unicode `7aba0101…`（chromium-chain-pass）、cell-composition `9d572df5…`（transport/commit-unconfirmed）；三份 errors/diagnostics/cleanupErrors 全 0、cleanup.residual 空，quoted 剪贴板 restored=true、另两份 untouched。
- 探针与源码哈希一致：`quoted-math-subrange-workflows.cjs` `75aa5260…`、`cell-composition-workflows.cjs` `27c719eb…`、私有副本 `f2d63246…`；main.js `9785673e…`、math-source-map.js `5866cd59…`、cell-source-map.js `01101435…`、host.js `bf568024…`。
- 两份 cell 探针**运行范围不同**（不是“同一逻辑只删一个字段”）：公共工具 `wantComposition = !!filter && wanted('composition')` 且在结果里写 `compositionRequested` —— 默认只跑 Unicode 格，合成臂必须显式 case filter 才启用；私有副本 `wantComposition = wanted('composition')`（无 filter 时为 true，kind=private-actual-ui-probe）默认两臂都跑。两者的**合成提交门禁逐字节相同**（第 93..161 行一致：`received()` 只认 trusted+inOverlay，缺证据即抛 TRANSPORT/COMMIT_UNCONFIRMED），故门禁结论可共用、范围结论不可混用。
- 看图：证据包 21 条 images[] 按 SHA 去重后仍为 21 个唯一 SHA，实际打开 21/21（每条完整图＋对应局部 2×），逐文件重算哈希全对；清单见 [extra-interaction-opened-3.2.11.json](extra-interaction-opened-3.2.11.json)。没有打开过的图不在此列。

## 1. 去重后各“舞台”的实际帧数（防止把同一张图算成多次证据）

- 引用公式链：03-reverse-selected ≡ 04-copy ≡ 06-cut-undo（同字节）；02-clicked-y ≡ 08-original-position-paste ≡ 10-paste-redo；05-cut ≡ 07-cut-redo ≡ 09-paste-undo；11-continued-R ≡ 12-saved；四组的 2× 亦各自成组。
- 表格链：01-entry ≡ 05-undo（2× 同字节）；07-continue-one ≡ 08-saved 只在**全幅**同字节（24b442ad…），两者的 2× 是不同字节的两帧（8099 vs 8120 B），屏幕内容一致但不当作同一份帧。
- 合成臂：01-entry ≡ 表格链 01；04-commit-observed 与 failure 的**全幅** ≡ 表格链 02 全幅；合成臂独有的屏幕只有 02/03 两张预编辑帧与 failure 的 2×。

## 2. 引用公式子选区链 —— VISUAL AGREED

- 03 全幅：PRE/POST 与两行 `$$` 围栏完整；原生蓝色选区在 `x+` 行自 `x` 起、在 `y` 行自行首起（含不可见的引用前缀区，高亮一直伸到字形左侧），两行连成一块；状态栏“选中 6 字”与源子区间 12..18（`x+\n> y`）等长。
- 03 2×：head=12 处有红色标记落在 `x` 左缘；该状态只报到 caret 的 left/top、宽高为空 —— 有选区时**无可测光标宽度**，标记是按报告点画的，不是拍到的原生光标。
- 05 全幅/2×：`$$`／空体／`$$`，24 字；标记落在空行，caret 实测 w=0 h=12.59（这一档有真实零宽光标矩形），无残留高亮。
- 08 全幅/2×：`x+`、`y` 原位复原，30 字，标记贴在 y 之后；虚线浮层（公式预览框）重新出现 `x + y`。
- 11 全幅/2×：源码为 `x+`、`yR`，31 字，标记在 R 之后；浮层实时变为 `x + yR`；围栏与 PRE/POST 邻域无改动。
- 因果链与图一致：点击渲染字形 y（80% 宽）→ 源端点 18；按住真实 Shift 再在浮层 `x`（20% 宽）Shift+点击 → anchor18/head12（pointers 中 shift+floating 命中、Shift keydown trusted）；复制、剪切前各自装弹并独立 STA 回读（71/72 B 哨兵），Ctrl+C / Ctrl+X 后独立回读均为 `x+\n> y`（6 B，matches=true），剪切只删这 6 个源单元。
- 历史与续写：Ctrl+Z 复原 → Ctrl+Y 重做 → Ctrl+V 原位粘贴（paste 事件 types=['text/plain']、plainLength 6、plainMatches=true）→ 撤销/重做；R 的 beforeinput/input 均 trusted、inEditor、data=R，终态 19/19、磁盘 31 B sha=`c9e5572c…`。
- 本臂只证明**原位续写**，不构成“Redo→R 无中间读数/等待/截图”的即时链：最后一次 PasteRedo 走 `keyStep`，其内部自带 `sleep(120)`＋snapshot＋截图，R 是在这些读数之后才发的；只有 collapse=true 时 `ArrowRight→R` 之间才无读数，而本次 `collapsedWithNativeRight=false`，ArrowRight 根本没执行。真正的即时链在 Unicode 格那支（见 §3）。

## 3. 表格 Unicode 链（ordinary 臂）—— VISUAL AGREED

- 01：H/K 表头与 KEEP 邻格在图上，单元格覆盖层激活（蓝框），光标落在 `a|` 与 `b` 之间（a、|、b 三字形），43 字。
- 02：格内显示 `a|中文b`、45 字，无组字底色（非组字路径），标记在 中文 之后；beforeinput 边界：trusted、inOverlay、insertText、data=中文、bubbleSeen=true、defaultPrevented 前后皆 false。
- 源/DOM 同步：同一边界 before 为源 26/26＋DOM 2/2，after 为源 28/28＋DOM 2/2 ⇒ 产品在 beforeinput 边界内完成源→DOM 映射修正，且未取消默认插入。
- 05：回到 `a|b`、43 字（撤销回退）；07/08：`a|中文1b`、46 字，标记在 `1` 与 `b` 之间。
- 立即续写“中间无读数”：探针把 Ctrl+Y 与 `1` 写在同一行并注明 no read/wait/frame；trace 中 keyup(y,ctrl)→keyup(Control)→keydown(1) 依次只隔 1.3 ms / 3.2 ms，期间无 evaluate/截图；舞台 06 是 keyup 的被动读数（screenshot=null 且 limitation 已注明），不是插进去的读数。

## 4. 严格 CDP 合成臂 —— UNCONFIRMED（不计入通过数、不作产品 bug）

- 屏幕只陈述所见：02 预编辑 `zhong`、03 预编辑 `中文` 都在格内带黄/橙底色，状态栏仍 43 字（预编辑未镜像进源）；failure 2× 显示 `a|中文b` 且黄底消失，看起来像已提交 —— 但仅凭屏幕不能判系统提交成功。
- 事件证据：compositionstart/compositionupdate/insertCompositionText 的 beforeinput/input 全为 trusted+inOverlay（真实组字 start/update/input 可信，其 isComposing=true）；`Input.insertText` 之后只出现一条 trusted=false 的 compositionend（data=中文；其 isComposing 读数为 **null** —— CompositionEvent 未定义该属性，探针按 `e.isComposing ?? null` 记录，trusted=false 不变），没有 data=中文且 isComposing=false 的可信 input ⇒ commitEvidence 两项为空（compositionend / commitInput 均为 null）⇒ `TRANSPORT/COMMIT_UNCONFIRMED`（productReached=false）。
- 无 JS 合成：两份探针里 `CompositionEvent`/`dispatchEvent` 零命中、注释明写 never synthesize compositionend；安装 ASAR 内 `new CompositionEvent` 0 次（正对照 `function` 10941 次、`compositionend` 7 次，全部是监听器／CM6 内部处理函数，无构造与派发）。
- 该条是传输层取证限制：不得当产品缺陷，也不代表微软拼音／keyCode 229／物理键盘已验。

## 5. 边界

- 未验证：微软拼音候选、229、物理键盘与原生菜单加速器；结论只覆盖 Chromium 渲染层 CDP 通道。
- 本次不重复 3.2.11 已完成的 322 全回归与 102 图独立审批，也不请求重跑与本次无关的套件。
- 跨页鼠标候选尚未纳入：本轮只复核已有证据，新材料到达后再单独取证。
- 冻结：本报告与看图台账 `extra-interaction-opened-3.2.11.json`（sha256=`e796226a…cbaf8`）自本次修正后冻结，之后不再改动；跨页候选材料另立文件，执行前不预跑任何测试。
