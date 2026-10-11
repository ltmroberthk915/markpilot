# outline-modes 族报告（大纲三形态：浮层 / 左停靠 / 右停靠）

**族名**：outline-modes
**被测产物**：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe` sha16=`15b8a1b699a0782e` bytes=188784128（探针启动即断言，不符即 exit 9 不出数）
**夹具**：`.mp-verify\checklist\outline-modes-run\outline-modes-fixture.md` 690 行 / 51 个标题（含 1 个代码块里的 `#` 行，不计）sha16=`59887a49a49b3bea`
**用例数**：41 条判据（三形态跳转 / 面板滚动 / 当前项高亮 / 遮挡 / 窄窗 / 缩放 / 收尾）
**复跑**：同一条命令连跑 3 次，41 条判据逐条同结果（7 条红稳定复现）
**尺子**：真实键鼠（CDP Input.*：工具栏按钮/设置单选/大纲条目/正文点击都是真实鼠标，滚动是真实滚轮，缩放是真实 Ctrl+= / Ctrl+0）；窄窗尺子＝`window.resizeTo` 真实窗口（innerWidth=660, dpr=1.75）；每组读数一次 `evaluate` 拿全；凡点击先做 `elementFromPoint` 命中测试。

## 通过的核心结论（读数）

| 结论 | 关键读数 |
|---|---|
| 三形态条目点击**都真的滚到目标**（浮层 / 左停靠 / 右停靠） | 光标落目标标题行首 `col=0`（行 5/690、653/690 等逐项对上），目标行在滚动可视区内，`document.hasFocus()=true` 且 `activeElement=.cm-content` |
| 停靠两形态**结构让位、面板不遮正文** | 左停靠：dock rect `[8,40,240,708]` w=232，DOM 里在 `.cm-editor` **之前**，editor 左缘 0→248；右停靠：`[936,40,1168,708]`，在 `.cm-editor` **之后**，editor 右缘 1176→928；两种形态 `overlap(面板, 正文列)=0`、`overlap(面板, 编辑器)=0`，跳转后目标标题文字零遮挡 |
| 面板自身滚动可用（51 条 / 面板仅 460px 可视） | 真实滚轮滚动 + 命中测试确认点中的就是目标条目；跳转后当前项高亮=被点条目 |
| 打开面板那一刻的高亮按光标算 | 光标放文末再开面板：activeIdx=50=光标所在标题（浮层/左/右三形态一致） |
| 停靠态打开时会把当前项滚进面板视野 | panelScrollTop=707.4，activeRect.top=680.9 ∈ 面板 [40,708] |
| 真实窄窗 660px 下停靠态可用 | 真实窗口 innerWidth=660/dpr=1.75；dock 232 + editor 412 + 正文列 402.3；`scrollWidth=402=clientWidth`（无横向溢出）；工具栏「大纲」按钮仍在视口内且命中可点；跳转正常、目标文字零遮挡；设置对话框可滚可点 |
| 缩放 150% 下停靠态可用 | Ctrl+= ×10 → API/computed/localStorage 三处一致 150%（非默认值）；跳转正常、零重叠；Ctrl+0 回 100% |
| 全程无副作用 | FNV 文档指纹 2816633660 前后一致（14189 字符未变）、0 pageerror、0 console.error、结束前 `tasklist` 证明进程仍活着（主进程事实，非渲染侧反推） |

## 没反应 / 行为不符预期（3 类，7 条判据红）

### ① 浮层态：跳转成功，但**目标标题文字被浮层 100% 盖住**（宽窗、真实窄窗、缩放后三处都中）
- F4（宽窗 1176px）：目标标题文字 rect `[172.1,102.5,155.6,27.4]`，浮层 rect `[135,44,408.1,505.1]` ⇒ `textCoveredFrac=1`、`textCoveredArea=4267`；同帧 `firstCharHitCls="mp-outline-item h3"`（标题首字符处最上层元素是大纲条目）。跳转本身是对的：光标 line5/col0、目标行 `visibleInScroller=true`。
- N5（真实窗口 660px）：目标文字 `[105.1,152.4,155.6,27.4]`，浮层 `[26,44,299.1,503.3]` ⇒ `textCoveredFrac=1`。
- Z5（150% 缩放）：目标文字 `[180.5,62.3,233.4,41.1]` ⇒ `textCoveredFrac=1`。
- 视觉证据：`outline-modes-shots\02-float-jump-up.png`、`16-narrow-float-jump.png`（图上目标标题整条不可见，状态栏仍是「行 5/690 · 列 1」＝跳到了却被面板压住）。
- 覆盖量读数（供参考，不单独作判据）：浮层压住**可见正文区**的面积比 宽窗 0.2 / 窄窗 0.3。

### ② 当前项高亮**不跟随光标**（三形态全中，鼠标与键盘两条通道都复现）
- F8 浮层（真实鼠标点另一条标题）：高亮项 activeIdx **49**，光标所在标题 expectIdx **50**。
- F8b 浮层（真实键盘 Ctrl+Home，键日志证明进的是编辑面）：光标 line1（标题 0），activeIdx 仍 **49**。
- L5 左停靠：activeIdx **1** vs expectIdx **2**；R5 右停靠：activeIdx **49** vs expectIdx **50**。
- 三例的鉴别力前置都成立（移动前后标题序号不同），且 `panelOpenAfter=true`（面板没被关掉，只是高亮不动）。
- 与"打开那一刻高亮正确"合起来看：按光标算高亮的逻辑只在**构建面板 / 点条目**时各跑一次，之后不接选区变更。

### ③ 浮层态打开面板时**不把当前项滚进面板视野**
- F10b：光标文末（line 690）+ 打开浮层 ⇒ activeIdx=50 正确，但 `panelScrollTop=0`、`activeRect.top=1392.3` ≫ 面板底 505 ⇒ 高亮项在面板可视区外（51 条标题）。
- 对照（同夹具同尺子）：停靠态同场景 panelScrollTop=707.4、active 可见（L6/R6 ✓）⇒ 差别在浮层的 markActive 没有做 scrollIntoView。

## pageerror / 崩溃
- pageerror + console.error：**0**（每次运行都采集）。
- 崩溃：无。结束前 `tasklist` 见进程活着（Z11 ✓），探针 finally 只 `taskkill /PID <自己那棵>`，跑完复核「命令行带 outline-modes-run 的进程数 = 0」。
- 壳层 trace（MP_DEBUG=1 → `outline-modes-run\profile\main-debug.log`，8348 B）：`newwin:trace winId1/wcId1/isPrimary`、`openPath:loaded len=14189 lines=690`、`doc:current`，无 error ⇒ 渲染侧现象不是会话/窗口串台造成的。

## 环境阻断
- 本族**不使用系统剪贴板**，无锁屏态阻断项。

## 未验证项
1. 真实窗口高度只到 713（屏幕工作区限制，请求 760 未达成）⇒ 窄窗一维（宽度）是真实的，高度是实际值 713，不是 760。
2. 浮层"面板不遮正文"按设计就是 overlay，本族只给读数（宽窗 20% / 窄窗 30% 可见正文面积被覆盖）；除"跳转落点被自己盖住"外不做缺陷判定。
3. 未测：拖拽大纲面板 / 面板内上下键选条目 / 多窗口下大纲形态 / 形态切换瞬间（浮层开着换停靠）的中间态动画。
4. 未做突变验证（AGENTS 错-12 的突变要求适用于"修复类结论"；本族是普查读数，无修复可注）。

## 证据文件
- 探针：`E:\MarkPilot\.mp-verify\checklist\outline-modes.cjs`
- 机器可读结果：`E:\MarkPilot\.mp-verify\checklist\outline-modes-result.json`（含每次 evaluate 的原始读数）
- 完整判据表（41 行，逐条读数）：`E:\MarkPilot\.mp-verify\checklist\outline-modes-report.md`
- 运行日志：`E:\MarkPilot\.mp-verify\checklist\outline-modes-run.log`
- 截图 21 张：`E:\MarkPilot\.mp-verify\checklist\outline-modes-shots\`（关键：`02-float-jump-up`、`05b-float-docend-open`、`10-dock-right-jump`、`14-narrow-dock-jump`、`16-narrow-float-jump`）
