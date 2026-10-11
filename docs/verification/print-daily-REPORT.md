# print-daily · 第三波真实用户操作普查（打印族）

被测产物：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`
**sha16 = `1b4e32a2263fcbe6`**（188 784 128 B，mtime 2026-10-10T12:25:48+08:00）——两支探针启动即断言，不符不出数。

探针：`print-daily-1.cjs`（主普查）、`print-daily-2.cjs`（对照臂，专治第 1 支里那处"文档变了"）
启动范式：spawn + 随机端口 + 独立 `--user-data-dir` + `MP_DEBUG=1` + `MP_TEST_HOOKS=1` + 删 `ELECTRON_RUN_AS_NODE` + playwright-core connectOverCDP（照抄 `export-daily-lib.cjs`）。产品目录只读。

**用例数 19**（清单 4 · Ctrl+P 8 · 取消 4 · 产出/清理 3）｜**崩溃 0 · pageerror 0**｜两次运行的进程树均已 taskkill（`我起的进程已结束=true`）

## 结论（每条都带读数）

| # | 问题 | 读数 |
|---|---|---|
| 1 | **Ctrl+P 存在吗** | **不存在**。加速键层：应用菜单无 `CmdOrCtrl+P`（静态体检计数 **0**）；引擎 keymap 无 `Mod-p`（计数 **0**）。行为层：CDP 真实输入按 Ctrl+P → 落字数 **0**、`beforeinput` 空、无对话框/无新窗口/无新页面/无日志；主进程通道按 Ctrl+P → 壳层留痕 `key {"key":"p","control":true}`（**这一击确实到了窗口**），仍无任何动作 |
| 2 | **菜单打印存在吗** | **不存在**。文件菜单 15 项逐项读数（新建/打开/最近打开/关闭窗口/保存/另存为/导出为 PDF…/文件位置/复制绝对路径/在资源管理器显示/关闭文件/退出）无一项含"打印"；工具栏 31 个按钮无；「更多」菜单 15 项无（见截图）；导出框 5 项无；可配置快捷键白名单 8 项无 |
| 3 | **打印预览可用吗** | **不可用**。产品内 `webContents.print(` = 0、`printPreview` = 0、`window.print(` = 0；按 Ctrl+P 后 CDP 页数 1→1、原生顶层窗口无新增、DOM 无新增节点（`bodyKids` 逐字相同）。唯一"打印面"是导出 PDF 的**隐藏窗口**（`printToPDF`，静态计数 13），无预览 UI |
| 4 | **打印通路（唯一一条）** | 导出为 PDF（`Ctrl+Shift+P` / 文件菜单 / 更多→导出…→PDF）。实测产出：`ok=true`、1 页、371 579 B、头 `%PDF-`、`kp.applied=3`、`mathCss.source=engine`(369 219 B)、**路径与请求逐字一致**（不是默认回退路径） |
| 5 | **取消打印干净吗** | 干净（两路）。① 保存框取消：原生 `#32770「导出为 PDF」` 出现→关闭→应用自报 `{ok:false,canceled:true}`，框已消失、主窗口仍在、进程存活、无残留；② 飞行中取消（大夹具 14 102 字）：停在 `typeset` 阶段返回 `canceled`，产物不存在、无 `.mp-partial-*`、staging **3 次 start / 3 次 removed、目录全部不存在**、无 `remove-failed`；③ 取消后再导一次 `ok=true` 470 597 B（会话已释放，可重试） |
| 6 | **打印后文档变了吗** | 没变。导出 PDF 前后：编辑区文本哈希与**磁盘文件 sha16** 均未变、焦点仍在编辑器；CDP Ctrl+P 前后：文档哈希相同、**文件 sha16 相同**（自动保存都没被触发） |

## 没反应 / 行为不符预期的项

**P1（功能缺口）Ctrl+P 完全无反应 —— 属于"没有这个功能"，不是崩溃。**
读数：`E1`(CDP) 文档哈希 `c66a880a→c66a880a`、DOM 逐字相同、`dlgOpen false→false`、页数 `1→1`、新增原生窗口 `[]`、新增日志 **0**；`G1`(主进程通道) 同样无窗口/无页/无对话框/`sessions 1→1`，壳层 `before-input-event` 留痕证明按键到了窗口层。对照臂 `F`（Ctrl+Shift+L 走同一注入）主题 `system/true→light/false` ⇒ **注入通道本身有效**，所以"无反应"是有意义的读数。

**P2（读数纪律，非产品缺陷）壳层测试挂点的合成 `char` 事件会把字母打进文档。**
第 1 支里 `G1 文档未变=false`、夹具从 357 B 长到 361 B、正文出现 `行LPPP内代码`。第 2 支对照臂定案：

| 臂 | 通道 | 落字数 | 落字内容 | 页面 keydown | beforeinput | 主题 |
|---|---|---|---|---|---|---|
| B | CDP `Ctrl+B` | **+4** | `行****内代码` | `b ctrl=true` | 空 | 不变 |
| C | CDP `Ctrl+P` | **0** | 不变 | `p ctrl=true`（到了页面） | 空 | 不变 |
| D | 挂点 `Ctrl+K`（K 无加速键、无菜单项） | **+1** | `行**K**内代码` | `k ctrl=true` | `insertText "K"` | 不变 |
| E | 挂点 `Ctrl+P` | **+1** | `行**KP**内代码` | `p ctrl=true` | `insertText "P"` | 不变 |
| F | 挂点 `Ctrl+Shift+L`（**加速键确实派发**） | **+1** | `行**KPL**内代码` | `L ctrl+shift` | `insertText "L"` | **system/true→light/false** |
| G | 挂点 `Ctrl+P` 复跑 | **+1** | `行**KPLP**内代码` | `p ctrl=true` | `insertText "P"` | 不变 |

D 臂（无加速键的字母同样落字）+ F 臂（加速键派发成功的同时也落字）⇒ 落字与"加速键是否派发"无关，是 `recent:test-send-key` 这个**工具**的 char 事件属性；自动保存（`file:save` 5 行，372→376 B）把它落了盘。CDP 真实输入通道 Ctrl+P 落字数 0、文件 sha16 不变。
⇒ **凡用这条挂点量"按键之后文档变没变"，必须先扣掉这个 +1**；本族据此把第 1 支的 `G1` 改判为"挂点副作用"，产品侧 Ctrl+P 仍是零动作。

**P3（观察项，不属本族判据）** 导出成功后有常驻横幅 `#mp-banner`「已导出 PDF：<目录>」带关闭键；取消后横幅变「已取消导出 PDF 关闭」（`I1 取消后状态` 读数）。

## 未验证项

1. **OS 级真人 Ctrl+P**：自动化里做不到——CDP 输入到不了加速键层（`B/C` 臂的 `before-input-event` 无留痕），而挂点注入带 char 副作用（见 P2）。本族用"两通道行为 + 静态菜单审计 + 壳层留痕"三条合起来定案；要真人级需 computer-use（本会话未授权）。
2. **打印到真实打印机/系统打印对话框**：产品无 `webContents.print`／`showPrintDialog`，无此路径可测（不是"测了没反应"，是"没有这条路"）。
3. `MP_PDF_SHOW=1`（诊断用"把打印窗口显示出来"）本轮未截图——那是导出族的视觉取证范围。
4. 原生保存框的"取消"是关闭该 `#32770` 句柄（等价于点取消），不是真人用鼠标点按钮。
5. 打印机列表/默认纸张：产品不读这些，对本族无判据。

## 证据路径

- 探针：`E:\MarkPilot\.mp-verify\checklist\print-daily-1.cjs`、`print-daily-2.cjs`（复用 `export-daily-lib.cjs` 启动库、`export-daily-dlg.ps1` 原生窗口通道、`_probe-common.cjs` 尺子卡）
- 读数明细：`E:\MarkPilot\.mp-verify\checklist\print-daily\_reports\print-daily-1.json`、`print-daily-2.json`
- 截图：`print-daily\p1\shots\`（`D2-more-menu.png` 更多菜单无"打印"、`D3-export-dialog.png` 导出框无"打印"、`E1-after-ctrl-p.png`、`G1-after-ctrl-p-mainchan.png`、`p2\shots\after-arms.png`）
- 产物：`print-daily\p1\out\print-daily-1.pdf`（371 579 B）、`print-daily-retry.pdf`（470 597 B）；取消的那份**不存在**（这就是判据）
- 主进程一手日志：`print-daily\p1\profile-*\main-debug.log`、`print-daily\p2\profile-*\main-debug.log`（含 staging start/removed、`file:save`、`key` 留痕）
