# LOG-2.2.14（2.2.14 交付记录）

本版内容 = 2.2.13 续修那一轮的两条用户报告修复（技术细节与取证全在 `docs/LOG-2.2.13.md` §十二，
本节只记交付口径、产物与验收数据）。

## 一、本版修了什么

| 用户报告 | 归因 | 修复点 | 变更文件 |
| --- | --- | --- | --- |
| 公式后面有"偏粗的多余光标"（细高一根 + 偏粗一根） | `patchSyntheticCaret` 的抑制判据用 `Range` 矩形高度，元素级插入点读回来 0×0 但其实原生照画 → 我们补了第二根 | 判据改看**版面**：落点在一行有内容的行盒上就不补（几何/日记保留，只是不渲染） | `render/js/typora-patches.js` |
| 点右 `$` 之后半个像素那一带，光标插进公式源码 | 渲染层 `contenteditable=false`，Blink 命中测试跳过它 → 点在公式右缘之外也被解成"源码末尾" | `patchInlineMathClickPosition` 分两路：盒外 → `selectOutside` 钳到公式外侧第一个正常文本位置；盒内 → 原路（展开 + 按像素精确定位） | 同上 |

同时更正了 `LOG-2.2.13.md` §七 对 F10 的"尺子误报"判定（真缺陷），`.perf/human-input/FINDINGS.md` F10 已回填。

## 二、验收数据（dev）

- 新场景 `137-hi-inline-math-right-edge`（真击 + 真实 ← 键，12 断言 / 5 证人）转正为门槛
  `scripts/acceptance/scenarios/137-inline-math-right-edge.cjs`。
- 突变验证：注掉"版面抑制"→ ① 变红（合成 1）；注掉"盒外分支"→ ② 变红（层:源码/展开:true）。
- 回归：human-input 128/133/134/136/137 全绿；验收快跑 101/107/92/83/84/85/134/137 全绿；
  **全量验收（dev）54 通过 / 1 失败 / 1 不适用**，唯一红是既有的 `90-math-command-family` ⑤。
- 尺子同步：133 与 134（human-input + 验收两份副本）的"光标可见"判据从"原生矩形有高度"改成
  "原生矩形有高度 **或落点在一行有内容的版面上**"（依据：真屏像素连拍，见 LOG-2.2.13 §12.1）。
- README 只增不删：`verify-readme-keep` 两份均"只增不删 ✓"（旧 438/346 标题、190/152 段全保留，各新增 1 个标题）。

## 三、产物与链校

| 产物 | 字节 | sha256 |
| --- | --- | --- |
| `markpilot-Setup-2.2.14.exe` | 116422821 | `c05f0746be1fe1fd16dd4675aa548381097175232b2868a76f3bb9878afb0497` |
| `markpilot-v2.2.14-portable.exe` | 116195726 | `839486d67859111c3f80915197bc60dcccbe1a4bc1b3562870e00eea1ff2917c` |
| `markpilot-2.2.14.vsix` | 6500024 | `64f2351dd28fa3db69eef1eed55ece2faf62e9705bdec1249b3133acf9f688f9` |

- 交付目录：`dist/release-2.2.14-private/`（含 `win-unpacked/` 供链校取打包 asar）；`SHA256SUMS.txt` 三行一致。
- 链校：`scripts/verify-chain.cjs dist/release-2.2.14-private … .perf/verify-2.2.14` → **verified=true**
  （① 扩展树==桌面树 499 文件、② 打包 asar 内 renderer==开发树 499 文件、③ VSIX 内 render==扩展树 499 文件、
  ④ asar 内主进程/外壳==开发树 36 文件；三处版本号 2.2.14 全一致）。
- 本机安装：`install-app.cjs --expect-version 2.2.14` → 装成 2.2.14（asar sha256 `df139f14…`）；
  `install-vsix.cjs --ide=both` → Trae 2.2.14 / VS Code 2.2.14。
- 安装版门禁（`--app=installed`）：101 32/32、107 15/15、134 8/8、137 12/12 全绿。
- 商店：**Open VSX `jinxi.markpilot` 2.2.14 已在线**（2026-10-01T05:57:02Z），线上 VSIX 下载后 sha256 与本地产物**逐字节一致**；
  VS Code Marketplace 未推（本机没有 `VSCE_PAT`，与 2.2.13 同）。
- GitHub Release：`v2.2.14` 已发布，三个资产的大小与 GitHub 侧算出的 sha256 与上表逐项相同。
  https://github.com/ltmroberthk915/markpilot/releases/tag/v2.2.14
- README 追加证明：`verify-readme-keep` 两份（zh/en）均"只增不删 ✓"（各新增 1 个标题，旧内容全保留）。
