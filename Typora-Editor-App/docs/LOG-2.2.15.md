# LOG-2.2.15（2.2.15 交付记录）

本版 = 2.2.14 那两条"公式右缘"修复的**收尾**：边界按右 `$` 的中线算，并收掉一条中文输入法相关的
"重大 bug"。技术细节与技术取证全在 `docs/LOG-2.2.13.md` §十二 与本节；本节记交付口径、产物与验收数据。

## 一、本版修了什么

| 用户报告 | 归因 | 修复点 | 变更文件 |
| --- | --- | --- | --- |
| "点右 `$` 像素的**右半**仍要进公式"（2.2.14 口径未修到位） | 边界取的是节点盒右缘，右 `$` 整个 8px 都算"里面" | 边界改取**围栏盒中线**：闭 `$` 右半 → 公式后；开 `$` 左半 → 公式前。跨行公式按"点在哪一行"取该行内容缘（围栏与源码不同行时不能拿两个中线当区间） | `render/js/typora-patches.js` |
| **重大 bug**：光标在公式源码末尾按 → 之后键入（中文输入法），本应落在公式外面的字跳回公式内部 | 光标停在闭 `$` 之后＝**围栏外侧那一半**；`compositionstart` 不考虑"外侧"，把光标挪进源码 → composition 上屏的字成了公式源码 | `compositionstart` 补上 `fence.outside` 分支（与 `beforeinput`/`paste` 同一判断），外侧先把光标立到公式外的真实文本位置 | `render/js/math-edit.js` |
| （回归护栏）跨行长公式、展开态预渲染浮框按不动 | 光标被解进节点内，但点的是"公式自己的地盘" | 浮框盒算公式地盘；区间按行取，不把长公式的里侧压成 1px | `render/js/typora-patches.js` |

## 二、取证与验收（dev）

- 复现器具：`probe-math-exit-type.cjs`（六种变体：真键 / 立刻打 / insertText / IME 组字上屏；V6 是病象——
  上屏后源码长成 `s_n=L(2n-1)kQ`；修后 `段外文本` 与磁盘都是 `…k$qQPWXYZ` ✓）；
  `probe-inline-math-fence-half.cjs`（围栏中线 ±1/±3/±6 逐格：右围栏中线右侧一律"公式外"，
  左侧一律"源码"；左围栏对称）；`probe-long-inline-hold.cjs`（跨行公式按住不放：展开态不进不退）。
- 场景：137（human-input + 验收两份）扩到 **18 断言 / 6 证人**——中线两侧翻转、源码末尾出格后
  **输入法上屏**的字落在公式外、磁盘里 `$S=L(2n-1)$` 之后的正文才带那个字。
- 突变验证：注掉"围栏外侧分支" → ⑥ 上屏源码变长、⑦ 磁盘红（Q 进了 `$…$`）；
  注掉"点盒子外就钳出去" → ② 红。
- 回归：验收 83/84/85/92/101/107/109/110/134/137 **10 通过 0 失败**；human-input 128/133/134/136/137
  **5 通过 0 失败**（其中 101 32/32、92 44/44 是"围栏按普通字符对待"的既有契约，先被本轮的
  第一版改法打红、改成围栏中线 + 分行区间后回绿）。
- 安装版门禁（`--app=installed`，2.2.15）：101 32/32、107 15/15、134 8/8、137 18/18、92 44/44 全绿。
- README 只增不删：`verify-readme-keep` 中英两份均"只增不删 ✓"。

## 三、产物与链校

| 产物 | 字节 | sha256 |
| --- | --- | --- |
| `markpilot-Setup-2.2.15.exe` | 116423988 | `16afe5c874eaa682f66fad27f93ea315ef467e25a388eb99341ddce8469af3a7` |
| `markpilot-v2.2.15-portable.exe` | 116196894 | `51ec0463fcbbc71e13b8fccead2210fea0e3d7d70a4239dc9bb6b94f72e77cc1` |
| `markpilot-2.2.15.vsix` | 6501994 | `4f9ef58afd7dc0afeb9a53e7a166cd6a6b185e981f4a94e31741a8d427037d22` |

- 链校：`scripts/verify-chain.cjs` → **verified=true**（`.perf/verify-2.2.15/chain.json`）。
- 本机安装：EXE → 2.2.15；VSIX → Trae 2.2.15 / VS Code 2.2.15。
- 商店：**Open VSX `jinxi.markpilot` 2.2.15 已在线**（2026-10-01T13:21:02Z），线上 VSIX 与本地逐字节一致；
  VS Code Marketplace 未推（无 `VSCE_PAT`）。
- GitHub Release：`v2.2.15` 三个资产的大小与 digest 与上表逐项相同。
  https://github.com/ltmroberthk915/markpilot/releases/tag/v2.2.15
