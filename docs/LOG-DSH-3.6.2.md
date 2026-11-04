# DSH 插件 3.6.2 交付记录（内部）

日期：2026-10-30（Asia/Shanghai）
产品：`dsh-markdown` 0.2.0，内核 MarkPilot CM6 3.6.2

## 1. 结论

- 换皮套壳落地：插件核心 = 桌面 3.6.2 构建产物，逐字节一致（124 文件 7,281,263 B，`coreHash 9a042bcb…`）。
- 选中文段 → 对话：真实 DSH 0.2.1-rc.3 宿主 + 真实鼠标 E2E **14/15 PASS**；插入的 composer 草稿是 Markdown 源码。
- 保存：版本守卫、外部改动冲突不覆盖、关 tab 恢复槽均有实现与测试。
- 已安装到 web/desktop 两个 profile 的 patch 层（file URL），重启宿主生效。

## 2. 产物与哈希

| 文件 | 字节 | SHA256 |
|---|---:|---|
| `dsh-markdown/lib/index.js` | 34,710 | `696ee4113620cabe…` |
| `dsh-markdown/lib/client.js` | 59,138 | `693785003b100e9d…` |
| `renderer-cm6/index.html` | 5,978 | `a22e9d94…` |
| `renderer-cm6/dsh-bridge.js` | 11,069 | `a191ec7c…` |
| `renderer-cm6/dsh-selection.js` | 13,947 | `13112fbe…` |
| `scripts/sync-core.mjs` | 11,023 | `44f03951…` |
| `core.json` | 21,628 | `d6a26555…` |

核心（与已安装 MarkPilot 3.6.2 ASAR 逐字节比对一致）：

| 核心文件 | 字节 | SHA256 |
|---|---:|---|
| `app.js` | 1,466,846 | `741ec9303807b52a704e8da14d9fccc336fac0ba95d3235c4d197553a52c2d9e` |
| `app.css` | 25,201 | `3a60efb75c872151419e5d09962647adcf0b28d0f6fa0bbe31a25cf338e8d2e8` |
| `markdown-worker.js` | 63,411 | `281c97bd645b87778bff2181be5b974deae5c1328c7fc4d6481d896f2e451c04` |
| `mermaid.min.js` | 3,572,661 | `581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8` |

已安装 EXE 的 ASAR 中这四个文件与仓库 `MarkPilot-CM6/renderer/cm6/` 的 SHA256 完全相同。

## 3. 验证

### 3.1 内核同步

```text
node scripts/sync-core.mjs
SYNC_OK 124 files, 7281263 bytes, coreHash=9a042bcb…
node scripts/sync-core.mjs --check
CHECK_OK 124 files, 7281263 bytes, coreHash=9a042bcb…  exit 0
```

突变验证：向 `renderer-cm6/cm6/app.css` 追加 1 字节 → `CHECK_DRIFT app.css (25201/25202)` exit 1；重新 sync → CHECK_OK exit 0。

### 3.2 iframe 皮（Electron 44.2.0 / Chromium 152）

`core-sync/test/acceptance.json`：22/22 PASS。

- 真实鼠标拖选 → 浮按钮出现 → 点击/Ctrl+Shift+Enter → 上行 `insert-to-chat` 的 text 与 `state.doc.sliceString(anchor,head)` 逐字符相同。
- Worker `requests=1 completed=1 error=null`；mermaid `svg=1`；KaTeX `katex=1`；console error 0。
- 深/浅主题；300,056 字 fixture；256 KiB 上限拒绝发送并 toast，不截断。
- boot 309ms / bridge-ready 18ms / init 86ms / Worker+mermaid+KaTeX 598ms；selectionchange 6 / rAF 7。
- 尺子修正两条（选区期望值、主题画布 vs 引擎配色）已如实记录在 `CORE-SYNC-REPORT.md` §7。

### 3.3 宿主/客户端半边（Node test）

`node --test test/client.test.mjs test/host.test.mjs`：25/25 pass，exit 0。覆盖保存闸门与必带 `baseVersion`、代际票拒收、插入重试+剪贴板兜底、恢复槽、ETag/304、路径穿越、SSE 广播/降级、64MB 上限、mock ctx + 真实 `node:http`。

### 3.4 真实 DSH 0.2.1-rc.3 E2E

隔离宿主（app.asar 提取，DSH_HOME 沙箱，端口 5893，独立 Chrome 9444）：

`api/E2E-RESULT.json`：**14/15 PASS**。

- PASS：bench、workspace、session、tab、iframe/CM6、bridge、overlay、hit-test、真实鼠标选区、composer 插入（源码 `这是**加粗文本**与行内公式 $E=mc^2$ 的混合段落。`）、Ctrl+Shift+Enter、防抖保存落盘、外部改动冲突不覆盖、tab 冲突横幅。
- FAIL（informational）：插入后 Ctrl+Z。焦点仍在 iframe 时撤销的是编辑器，不是 composer；点回输入框后撤销插入可用。已在 README 写明。
- 插件自身 console error 0；1 个 exception 来自 `dsh-client-ui-plan`（与插件无关）。

## 4. 安装

两份 profile 均以 **bundle** 安装（会出现在 DSH「插件」页）：

- `node_modules\dsh-markdown` → `D:\BuyKey\markpilot-public\dsh-markdown` 的目录 junction
- `package.json` 的 `dsh.profile.bundles` 末尾追加 `"dsh-markdown"`
- `cordis.patch.yml` 里不再保留 `file:///...` insert（bundle 自带 patch 会插入；两者并存会重复）

- `web`：`C:\Users\Ming\.dsh\profiles\web\`
- `desktop`：`C:\Users\Ming\.dsh\profiles\desktop\`

重启宿主生效（Desktop 托盘彻底退出后重开）。安装前备份：`C:\Users\Ming\dsh-backup-20261030-0119`（63,173/63,174 文件；唯一未复制为 `cache\pet-desktop\...\Cookies` 占用锁，可再生）；改名前配置另存 `.audit-work\dsh-plugin-362\profile-backup-rename\`。

## 5. 未验证 / 已知缺口

- bundle（junction）安装下 `markdown` 工具仍可能因 `@deepseek-ai/dsh-tools` 解析不到而缺席（仅 warn；编辑/保存/插入不受影响）。
- `inputActions.insertText` 返回 false → 剪贴板兜底臂未在真实宿主触发（单测覆盖）。
- 多选区真实多光标、表格格内 contenteditable 覆盖层、按钮滚动重定位专项截图、macOS Cmd、>256 KiB 边界逐字节、真实 DSH origin/CSP 未专项验收。
- 性能为单次采样，非统计分布。
- 桌面版工具栏中依赖原生宿主的导出/图片选择入口在 DSH 可能不可用。

## 6. 对齐命令

```powershell
node D:\BuyKey\markpilot-public\dsh-markdown\scripts\sync-core.mjs
node D:\BuyKey\markpilot-public\dsh-markdown\scripts\sync-core.mjs --check
# 重启 DSH
```
