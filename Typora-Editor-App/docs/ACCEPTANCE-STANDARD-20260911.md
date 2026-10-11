# 验收标准（2026-09-11 起生效）：产物绑定 · 独立证人 · 无错误面 · 数字台账

本轮用户的三条反馈里，**两条是"我们的测试永远测不出来"的那一类**：

1. 复制图片失败——开发树上一切正常，装到用户机器上报
   `复制图片失败：无法写入系统剪贴板：-File …app.asar…`。开发树的 `__dirname` 是真路径，
   打包后它在 `app.asar`（Electron 的虚拟文件系统）里，Windows PowerShell 打不开。
   探针全绿、用户全红，属于**被测对象不是交付产物**。
2. Shift+Enter 要按两次——真实按键、真实光标位置（段落行尾、全角右括号之后），
   而上一轮的探针用的是"光标在段落中间"的合成场景，**场景不是用户真实落点**。

所以从此以后，一个功能"通过"必须同时满足下面六条。缺任何一条，本轮不算交付。

## 一、六条判据（run.cjs 结构上强制，不靠自觉）

| # | 判据 | 落地方式 |
|---|------|----------|
| P1 | **产物绑定**：跑的是打包产物，且产物里的 renderer 与源（`extension-src/render`）逐字节一致 | `00-static-audit`：asar 内 492 个渲染文件逐字节比对 + 版本三方一致（App / 扩展 / vsixmanifest）+ 解包脚本存在 |
| P2 | **独立证人**：状态变更必须由代码之外的通道证明 | 系统剪贴板读回（PowerShell）、磁盘文件、编辑器几何、OS 窗口可见性；场景没有证人 → 直接判失败 |
| P3 | **用户看得见的效果**：断言可视属性，而不是"处理器被调用了" | 光标框高 16px & 落在新行最左侧、图片虚线轮廓的 computed style、窗口真的出现在屏幕上 |
| P4 | **无错误面**：动作之后没有错误提示/异常/console 报错 | 页面内 MutationObserver 抓气泡文本（气泡只活 2.2s，事后查会漏）；`\uFFFD`/`-File`/`app.asar`/`失败` 一律判失败；console 错误按白名单比对，**新错误即红灯** |
| P5 | **数字台账**：延迟/内存进台账，按容差跨版本比 | `.perf/acceptance/<label>/report.json` + `baseline.json`，退化超容差即失败（本轮就是靠它回答"小文件是不是变慢了"） |
| P6 | **真按键**：输入路径走 OS 输入管线，并自证送达 | CDP `Input.dispatchKeyEvent` / `insertText` + 页面内 keydown 计数自证；DOM 合成事件只允许用在纯单元测试 |

补充纪律：
- **场景清单固定**：少跑一个场景不算通过（`--only` 只用于排查，不产出"通过"结论）。
- **只对打包产物成立的场景**（如 asar 审计）标 `packagedOnly`：开发树跑不了也算不了通过，单独计"不适用"。
- **数字口径要写清**：`open.*.spawnToDom` 是"进程启动→内容进 DOM"（含 Electron 启动），
  `shellToIframe` 与 `inPageToDom` 把它拆成"应用外壳"和"页面内工作"两段——没有这两个分项就分不清
  到底是启动变慢还是渲染变慢。取**中位数**（冷启动单次读数在本机抖动可达 1.5s–5.3s）。

## 二、怎么跑

```bash
npm run accept                 # 对已安装版本跑全套（发布闸门；产物绑定 + 取证）
npm run accept:dev             # 对开发树跑（迭代用；asar 审计会自动标"不适用"）
npm run test:acceptance        # 不启 GUI 的单元检查（外部进程路径解析等）
node scripts/acceptance/run.cjs --app=dist-2.0.16/win-unpacked/MarkPilot.exe --label=2.0.16
node scripts/acceptance/run.cjs --app=installed --label=X --accept   # 把本次数字写成新基准
```

产物：
```
.perf/acceptance/<label>/report.json         全部断言、证人、数字（含截图）
.perf/acceptance/<label>/<场景>/*.png        失败也有留痕（截图）
.perf/acceptance/baseline.json               上一次被接受的数字（容差在这里比）
```

## 三、现有场景覆盖到哪、没覆盖到哪（如实标注）

| 场景 | 覆盖 | 主要证人 |
|------|------|----------|
| `00-static-audit` | 四方哈希链、三方版本、`app.asar.unpacked` 里外部脚本存在、`.ps1` 纯 ASCII、路径解析器在 asar 布局下的行为 | asar 字节比对（另一个解析器 `@electron/asar`） |
| `10-open-latency` | 小/中/大三档冷启动：窗口可见、内容进 DOM、首屏后安静（每档先跑一次不记账的热身启动，避免冷缓存误判退化） | OS 窗口可见性（后台 PowerShell 轮询 `IsWindowVisible`）、磁盘素材 vs 屏幕 DOM 字数/标题 |
| `11-open-after-large` | 开着大文档再开小文档（双击第二个文件的真实路径：`hostApi.invoke('open-file')`） | 热打开后屏幕标题 vs 磁盘素材 |
| `20-copy-images` | **两种多选顺序**（先 Ctrl 点 / 先普通点再 Ctrl 点）→ Ctrl+C → 系统剪贴板 | **另一个进程**读回 CF_HDROP：文件名 + SHA256 与磁盘素材对账；错误面文本检查 |
| `30-shift-enter` | 段落行尾（全角标点后）与段落中间的软换行 + 存盘往返 | 光标几何（行号、光标框、左边界）+ 磁盘 Markdown（没输入时不改文件、输入后有软换行且无零宽脚手架） |
| `40-restore-position` | 滚轮滚到锚点段 → 换文档 → 开回来 | scratch profile 的 `state.json` 里必须记下 `scrollAnchor`（磁盘证人）+ 重开后锚点段落贴视口顶部（±8px） |
| `50-copy-table-and-image` | 右键菜单"复制表格到 Excel"、"图片设置…→复制原图" | Win32 剪贴板 API **按原始字节**读回 CF_HTML（版本头 + 片段偏移自洽 + 中文单元格完好）；CF_DIB/PNG 尺寸等于磁盘原图 |
| `60-scroll-smoothness` | 大文档真实滚轮连续滚动（>1 万像素） | 页面内 rAF 帧间隔（p50/p95/最大/掉帧比例） |

**已知未覆盖（下一轮优先补）**：
- **微信等第三方目标**：只能由用户手工确认（自动化能证的是 CF_HDROP + 真实文件 + SHA256）。
- **扩展（VS Code / Trae）侧**：本轮用目录侧载装好了 2.0.17，但"在真实 IDE 里打开一篇文档走一遍
  复制/补全"仍靠人眼；可补 `test/vscode-smoke.cjs` 那类宿主冒烟。
- **架构级性能**（首次排版前置、编辑器宿主预热、输入重解析收窄）：仍用开发树探针
  `scripts/ir-perf-probe.cjs`，因为需要 CDP Profiler 与分片计时；这一层的数字进
  `docs/HEADROOM-20260911.md`，不进产物验收台账。

## 四、本轮被这套标准挡下来的假通过（复盘）

| 假通过 | 怎么露馅 | 现在的防线 |
|--------|----------|-----------|
| "复制图片在开发树 7/7 通过" | 用户装上真机报错 | P1：产物绑定 + asar 审计；`copy-images` 场景**必须**在打包产物上跑 |
| 气泡报错检查永远读到 null | 气泡 2.2s 自动消失，断言晚于它 | P4：MutationObserver 实时记录 |
| 探针的"拷贝"其实没触发 copy 事件 | 剪贴板里始终是 0 个文件 | P6：页面内自证 copy 事件到达 + P2 独立进程读回 |
| 光标 rect 为 0 被当成"正常" | 断言写的是 `caretWidth >= 0` | P3：断言真实框高与"在新行最左侧" |
| Shift+Enter 场景只测段落中间 | 用户真实落点是行尾 | 场景补行尾用例（用用户原句） |
| 一个窗口从来没显示过的测试环境 | `windowsHide:true` 让 Windows 把首次 `ShowWindow` 改写成隐藏 | P2：OS 层窗口可见性证人（这条是给测试环境本身的） |
