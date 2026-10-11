# 拟人输入补充套件（human-input supplement）

补齐主验收（`scripts/acceptance/`，00–114 号场景）在"拟人操作"维度上的覆盖缺口，专抓
**用户手上会犯、现有场景抓不到**的交互缺陷。全部动作走真实 CDP 键鼠
（`Input.dispatchKeyEvent` / `dispatchMouseEvent` / `insertText`），判据只认用户可见的
东西（几何、磁盘、系统剪贴板、独立进程）。

**本目录与 DeepSeek 会话主责的 `scripts/acceptance/` 完全隔离**：只 require 其
harness/edge-helpers/fixtures，不修改那边任何文件；产物全部写 `.perf/human-input/`。

## 用法

```bash
node scripts/human-input/runner.cjs --app=dev --label=<轮次>            # 全部（120–136）
node scripts/human-input/runner.cjs --app=dev --only=128                # 单场景/前缀
node scripts/human-input/runner.cjs --list                              # 列清单
```

场景契约与 `run.cjs` 一致（`{id, title, run(ctx)}` + 反假通过闸门：独立证人、
console 错误面、至少一条用户可见断言）。**某场景修绿后，把文件复制进
`scripts/acceptance/scenarios/` 即成正式 gate，一行不用改**（编号已避开 115–119）。

## 场景一览

| 号 | 维度 |
|---|---|
| 120–122 | 格式快捷键真键（Ctrl+B 单块/跨块/公式源码守卫、Ctrl+U、Ctrl+Shift+Q/K/E、Ctrl+C/X/V/Alt+V、Ctrl+Z/Y/Shift+Z 撤销重做链） |
| 123 | 词级移动/删除（Ctrl+Backspace/Delete、Ctrl+←/→、Ctrl+Shift+→，公式邻域） |
| 124 | Tab/Shift+Tab（列表缩进、代码块字面缩进、普通段落行为记录） |
| 125 | 页面导航（PageUp/Down、Home/End 软换行、Ctrl+Home/End、Ctrl+F→Enter/F3/Esc） |
| 126–127 | 鼠标选区家族（双击+拖拽扩展、三击+Shift↓、Shift+点击、Ctrl+点选双图、跨块拖选复制、拖拽图片） |
| 128 | 键盘长按连发（autoRepeat：↓/↑ 保列、→ 穿公式、Backspace 恰删 N、Shift+→ 逐字选） |
| 129 | 光标点击精确矩阵（中文零误差/英文±1、行尾空白钳位、块左缘、贴公式右缘） |
| 130 | 侧栏/大纲/链接/焦点完整性 |
| 131 | 种子混沌 80 步（真素材副本；逐步归因光标存活与错误面） |
| 132 | 解析形态矩阵（17 种加粗/斜体/删除线形态 + 分段完整性 + 二分） |
| 133 | 空白带×4 点击光标有效且唯一（合成光标≤1、正文折叠态=0）、点图正中、标题退格 |
| 134 | 全文档 →/← 逐键巡走（块内只进、块尾必到紧邻块首、无死路） |
| 135–149 | **递归产物段**（发现 → 延伸 → 反哺，见 `RECURSION.md`；135=段落合并窗口二分、136=连发生效比例台账） |

## 关键文件

- `hi.cjs` —— 拟人输入原语库：`hold`（长按连发，rawKeyDown+autoRepeat+keyUp 分离）、
  `combo`（任意组合键，修饰键真实按下/抬起）、`drag/dragPath`（统一拖拽）、
  `caret/caretPrefix/fingerprint/mdNow`（读数）、`CHARS_OF`（逐字符盒=点击矩阵独立口径）、
  `writeDoc/copyProtected`（素材房；受保护素材只复制副本、用完删）、`rng`（固定种子）。
- `runner.cjs` —— 独立运行器（报告写 `.perf/human-input/<label>/report.json`，含 git 快照）。
- `RECURSION.md` —— 递归测试协议：发现 → 登记 → 15x 延伸场景 → 修复后收编为正式 gate。
- `.perf/human-input/FINDINGS.md` —— 缺陷记录（每条：读数/堆栈/复现命令/用户报障同类映射）。

## 迁移与合流

修复对应缺陷后，把 12x 场景迁入 `scripts/acceptance/scenarios/`；`hi.cjs` 的三个原语
（hold/combo/drag）建议合入 `edge-helpers.cjs`——主验收多个场景在各自手写同款序列。
