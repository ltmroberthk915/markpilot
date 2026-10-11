# GPT 接手交接 v2：Office 原生互通已通过，其余发布项待收尾

交接时间：2026-09-07 12:10（Asia/Shanghai）。本文件覆盖 `GPT-HANDOFF-media-office-2026-09-07.md` 中关于 P0-1 根因和状态的结论；完整背景仍参考该文件与 `GLM-HANDOFF-media-office-2026-09-07.md`。

## 一、当前准确结论

P0-1 已经完成实测闭环。不要继续排查 `main.js` 的 Electron 剪贴板监视，也不要再删 `Documents.Count` / `InlineShapes.Count` / PID 查询；这些方向已逐项 A/B 排除。

最终完整命令：

```powershell
$env:TYPORA_OFFICE_NATIVE='1'
try { node scripts/run-electron-test.mjs media-office } finally { Remove-Item Env:TYPORA_OFFICE_NATIVE }
```

最后一次真实结果：退出码 `0`，八项全部 PASS：

1. 内嵌 PNG 编辑时保持原分辨率，编辑/补全文本不含 Base64。
2. 50% 显示缩放保留原像素及无关公式 DOM。
3. 单独移动 Markdown 后图片和尺寸可恢复。
4. DOCX 导出完成，公式/图片/表格/列表无转换警告。
5. 导出不覆盖源 Markdown。
6. Excel 原生粘贴保留 3×3 单元格、`00123`、字面量 `=1+1`、中文。
7. App 复制原图后，Word / Excel / PowerPoint 均粘贴并保存，包内 PNG SHA-256 与源图完全一致。
8. VSIX WinForms 桥重复同一组三端验证，也全部通过。

日志与结果：

- `.perf/media-office-1.0.15/desktop-results.json`
- `.perf/media-office-1.0.15/native-table.log`
- `.perf/media-office-1.0.15/native-image-word.log`
- `.perf/media-office-1.0.15/native-image-excel.log`
- `.perf/media-office-1.0.15/native-image-powerpoint.log`
- `.perf/media-office-1.0.15/office-native/*-result.json`

测试结束后已检查，无 `WINWORD` / `EXCEL` / `POWERPNT` 残留进程。

## 二、真正根因与证据

### 1. Word SaveAs2 挂起不是 Electron 竞争

在 App 完全未运行时，用同一份 WinForms 桥剪贴板先跑简化 probe，再跑完整脚本：简化脚本约 87 ms 保存成功，完整脚本仍卡在 `SaveAs2`。因此上一份交接中“完整 App 的 clipboard 监视竞争”是假设，不是根因。

真正触发点是 PowerShell cmdlet 输出传给 Office COM：

- `$out = Join-Path ...` 或 `SaveAs2((Join-Path ...), 16)`：字符内容看似正确，但值携带 PowerShell ETS / `PSObject` 包装，隐藏 Word 会进入交互式保存路径并永久等待。
- `[string]$out = Join-Path ...` 或用 `[System.IO.Path]::Combine(...)` 生成纯 .NET 字符串：同一剪贴板、同一路径、同一脚本结构立即保存成功。
- 已做正反 A/B；`Documents.Count`、`InlineShapes.Count`、`Start-Office` 函数封装、PID 查询均单独验证可成功。

修复已应用到 `scripts/office-native-verify.ps1`：Word/PDF/Excel/PowerPoint 所有传给 COM 的输出路径改为显式 `[string]` + `System.IO.Path.Combine`，保存前删除旧测试产物，避免隐藏覆盖提示。

### 2. Excel 中文乱码是 CF_HTML 字节编码

App 原先用 Electron `ClipboardItem` 写表格，Electron 自己能读回 HTML，但真实 Excel 只粘贴一个空单元格；自读是无效验收。

App Windows 表格复制现改走 WinForms 桥后，结构和 ASCII 内容正确，但中文最初变为 `֐΄`。原因是 WinForms 对自定义 `HTML Format` 的字符串使用系统 ANSI/GBK 编码，而 CF_HTML 消费端按 UTF-8 解码。

修复：`media-clipboard.ps1` 不再把 CF_HTML 作为 String 交给 DataObject，而是写入精确 UTF-8 `MemoryStream`；HTML head 同时声明 `meta charset=utf-8`。真实 Excel 最终返回中文 `中文`。`office-native-verify.ps1` 用 Unicode code point（`0x4e2d`, `0x6587`）断言，避免 Windows PowerShell 5.1 对无 BOM `.ps1` 中文字面量的误解码。

## 三、本轮实际改动

### 正式源码/测试文件

1. `D:\BuyKey\Typora-Editor-App\app\main\doc.js`
   - Windows 下 `copy-table` 攈走 `windowsClipboard`；非 Windows 保留 Electron ClipboardItem fallback。
   - 先前交接已有的 `copy-image` WinForms 桥保持不变，现已在完整 App 环境证明通过。

2. `D:\BuyKey\Typora-Editor\extension-src\render\js\media-clipboard.ps1`
   - CF_HTML 增加 UTF-8 meta。
   - HTML Format 改为 UTF-8 MemoryStream，修复 Excel 中文乱码。
   - 这是共享渲染层唯一源码；随后已执行 `npm run sync`。

3. `D:\BuyKey\Typora-Editor-App\app\renderer\js\media-clipboard.ps1`
   - 由 `npm run sync` 生成，与上述共享源码一致；不要直接手改。

4. `D:\BuyKey\Typora-Editor-App\scripts\office-native-verify.ps1`
   - Office COM 输出路径全部改成纯 `[string]`。
   - 固定测试产物保存前清理。
   - PID 进程名从 `WINWORD.EXE` 等改为 `WINWORD` / `EXCEL` / `POWERPNT`，现在能正确记录新启动 PID。
   - Excel 增加中文精确断言。

5. `D:\BuyKey\Typora-Editor-App\scripts\desktop-media-office.cjs`
   - Windows App 表格测试不再相信 Electron 自读，直接以真实 Excel 为准。
   - 增加 `formulaText` 与中文断言。
   - 修复 `TYPORA_OFFICE_SYNC=1` 时 `execFileSync` 返回 String、却按 `{stdout,stderr}` 读取的日志 bug。

## 四、交付前必须清理的诊断残留

以下尚未清理，接手者不要误当正式功能：

- `scripts/desktop-media-office.cjs` 中：
  - `TYPORA_OFFICE_IMAGE_ONLY`
  - `TYPORA_OFFICE_DIRECT`
  - `TYPORA_OFFICE_NOCLIP`
  - `TYPORA_OFFICE_SYNC`
  - `TYPORA_OFFICE_SYNC_PROBE`
- `scripts/clipboard-electron-probe.cjs`
- `.perf/media-office-1.0.15/word-save-probe.ps1`
- `.perf/media-office-1.0.15/probe-image.b64`
- 本轮新增 A/B 文件：
  - `.perf/media-office-1.0.15/word-save-ab.ps1`
  - `.perf/media-office-1.0.15/word-save-path-probe.ps1`
  - `.perf/media-office-1.0.15/word-save-inline-probe.ps1`
  - `.perf/media-office-1.0.15/word-save-helper-probe.ps1`

建议保留 `office-native-verify.ps1` 的分应用执行、即时日志和 PID 差集清理；它们已从临时诊断演变为防止 Office 僵尸进程的正式测试保护。

## 五、尚未开始的工作

本轮只完成 P0-1 及其暴露的表格中文互通问题。下列事项仍沿用 GLM 文档，尚未修改：

### P0

1. `app/main/doc.js`：`openFile` 在新文档 `images.mask` 成功前就释放旧 completion / timer；失败时需完整保留旧文档保护状态。
2. `saveAs`：已有相对路径图片跨目录另存后会失效，应在另存边界嵌入或正确重定位。
3. `portable-images.cjs`：历史文档中的 >20 MB / 损坏 data URI / 缓存写失败应原样降级并提示，不能阻断全文；`checkFile` 异步错误、reload 空 catch、VSIX `maskSync` 裸调用也要收口。
4. 生命周期测试：粘贴→删除→保存→撤销→重开、缩放 undo/redo、保存中继续编辑、外部冲突、只读/锁定/另存为。
5. VSIX 真宿主 smoke：更新旧“外部图片”预期为默认内嵌语义，验证 CRLF / range / undo / 版本映射。

### P1

1. 用最新 DOCX 重新让 Word 导出 PDF并逐页视觉检查矩阵括号、嵌套列表；补复杂公式、合并单元格、SVG/Mermaid、长公式、缺图/取消/冲突测试。
2. `office-math.mjs` 的 PUA 占位符要从原公式未使用字符中选择，避免原文碰撞。
3. 恢复 More 菜单丢失项（至少旧 `content-theme` / 内置 `export`，并核对 outline、打印/PDF/HTML），验证 VSIX iframe/CSP。
4. `portable-markdown.cjs` 补引用式图片、空格/括号/标题、代码字面量、重复、远程失败边界。
5. 图片“导出原图”取消目前仍回报成功；App 与 VSIX 都要返回 canceled，且保存对话框不能被 30 秒 `mediaRequest` 超时误杀。
6. 长数学笔记跑真实编辑与 DOCX 导出性能，不得把 0.85 ms diff 微基准宣传为全文性能。

### P2

1. App 升 `1.0.15`，VSIX 升 `0.1.25-local`，更新 lock / manifest / CHANGELOG / 功能与限制说明。
2. 最终 `npm run sync`，构建 NSIS、portable、VSIX。
3. 对正式产物跑完整回归，核对共享文件、许可证、版本和产物哈希后再交付。

## 六、接手后的推荐顺序

1. 先不要改 Office 桥；立即保存当前八项 PASS 日志作为基线。
2. 完成 P0 open/saveAs/容错并补 Node + Electron 生命周期测试。
3. 完成 P1 数学占位、菜单、取消语义和 portable Markdown 边界。
4. 重新生成 DOCX，使用 Word 导出 PDF，再把每页渲染为 PNG 逐页检查。
5. 清除第四节诊断残留，跑全量测试。
6. 最后升版、sync、构建、对打包产物回归。

## 七、环境与纪律

- App：`D:\BuyKey\Typora-Editor-App`
- VSIX：`D:\BuyKey\Typora-Editor`
- 共享渲染唯一源码：`D:\BuyKey\Typora-Editor\extension-src\render`
- 两处都不是 Git 仓库，不能依赖 `git status`/reset；现有用户改动必须原地保护。
- GUI / Office 测试串行，运行前先检查用户是否已有 Office 文档实例。
- 不调用付费 API，不重做补全模型实验，不用扩大 timeout 掩盖挂起。
- 最终仍需声明：单文件 data URI 迁移不保证所有第三方 Markdown 渲染器都显示；DOCX 是尽量保真，不承诺任意复杂内容完全无损；没有 Pandoc 同条件性能对照。
