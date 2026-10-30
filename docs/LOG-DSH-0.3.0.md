# dsh-markdown 0.3.0 交付记录（内部）

日期：2026-10-30（Asia/Shanghai）
产品：`dsh-markdown` 0.3.0，内核 MarkPilot CM6 3.6.6

## 1. 内核同步

```
node dsh-markdown/scripts/sync-core.mjs
SYNC_OK 124 files, 7294308 bytes, coreHash=d6df048c976e5517a33c99393f6eb548bc1340a3d393b9ded00f06c839a4b7b4
  core    : MarkPilot CM6 3.6.6
node dsh-markdown/scripts/sync-core.mjs --check
CHECK_OK 124 files, 7294308 bytes, coreHash=d6df048c… (exit 0)
```

源：`MarkPilot-CM6/renderer/cm6`（3.6.6 受控构建产物）。`index.html` 仍由插件皮维护，不参与同步。

关键载荷（插件核心，SHA-256 前 16 位）：

| 文件 | 字节 | SHA-256 |
|---|---:|---|
| `app.js` | 1,479,891 | `823214be44625adc…` |
| `app.css` | 25,201 | `3a60efb75c872151…` |
| `markdown-worker.js` | 63,411 | `48cc1d24f2472c14…` |
| `mermaid.min.js` | 3,572,661 | `581ed7d74bd9048d…` |

与 3.6.2 对比：`app.js`、`markdown-worker.js` 变化；`app.css`、`mermaid.min.js` 未变。

## 2. 与已安装桌面 3.6.6 的逐字节核对

- 安装目录：`D:/Users/Ming/AppData/Local/Programs/MarkPilot CM6`
- `MarkPilot.exe` FileVersion 3.6.6.0 / ProductVersion 3.6.6
- `resources/app.asar` SHA-256 `c2216c4d696c93168b0022c60606cf209022851ad5062c5371ec0ed73323f570`（与 LOG-3.6.6.md 记录一致）
- 用 asar 逐文件 integrity 核对（`.mp-verify/dsh-plugin-366/compare-asar-cm6.cjs`）：
  - `MarkPilot-CM6/renderer/cm6` 125/125 相同（含 `index.html`）
  - 插件 `dsh-markdown/renderer-cm6/cm6` 124/124 相同（无 `index.html`，按契约由插件皮维护）
  - 核心四件按 `offset+0` 抽取后逐字节 SHA-256 命中 integrity（4/4）

## 3. 协议缺陷与修复（本轮发现）

引擎的上行消息有两个信封：

- 插件桥 `dsh-bridge.js`：`{__dshmd:true, dir:'up', …}`（`bridge-ready`/`init`/`insert-to-chat`…）
- 引擎自身 shell 通道：`{__dshmp:true, dir:'up', …}`（`change`/`text` 直接 `window.parent.postMessage`）

3.6.2 与 3.6.6 的 `app.js` 都用 `__dshmp`（`L2=(n,e)=>{…postMessage({__dshmp:!0,…})}`）。插件客户端原先只认 `__dshmd`
⇒ 脏标（change）与 `requestText` 回执（text）全部被丢弃 ⇒ 自动保存不会触发、关闭 tab 的 flush 拿不到全文。

修复：`lib/client.js` 抽出 `isUpEnvelope(data)`（`dir==='up'` 且 `__dshmd===true || __dshmp===true`），
`onMessage` 改用它，并把它加入 `__test`。新增单测覆盖两个信封的接受与 down/非法形态的拒绝。

## 4. 验收

### 4.1 Node 单测

```
node --test test/client.test.mjs test/host.test.mjs
tests 26 / pass 26 / fail 0（exit 0）
```

新增：`上行信封：__dshmd（桥）与 __dshmp（引擎直发）都接受，down/非法拒绝`。

### 4.2 真实浏览器（Chromium / Playwright，真实鼠标与键盘）

探针：`.mp-verify/dsh-plugin-366/harness/{serve.cjs,harness.html,probe.cjs}`；结果 `.mp-verify/dsh-plugin-366/probe/result.json`：**27/27 PASS**。

- boot 350 ms（引擎就绪，`mpEngine._view()` 可用）；无页面异常。
- core.json：`3.6.6` / 124 文件 / `coreHash d6df048c…`。
- 渲染：标题、加粗（computed font-weight 900）、KaTeX 2、表格、代码块、Mermaid SVG 1；Mermaid 本地脚本与 KaTeX 字体均从插件路由取到。
- 真实键盘输入：doc +2 且落在第 3 段末尾；上行 `change` 实测为 `{"__dshmp":true,"dir":"up","type":"change","content":{"len":253,"epoch":1,"sourceRevision":1}}`（正是 §3 的缺陷证据）。
- 真实鼠标拖选「加粗文本」→ 浮按钮 `data-on="1"` → 点击插入：上行 `insert-to-chat` 的 `text` 与 `mpEngine._view().state.doc.sliceString(from,to)` 逐字符相同（`加粗文`，meta.ranges 31–34）。
- 快捷键路径：拖选「第二项」+ `Ctrl+Shift+Enter` → 第二条 `insert-to-chat`，文本 `第二项`；`window.__dshSelStats` mouse=1 / keyboard=1。
- `requestText` 回执与引擎全文逐字符相同（254 = 254）。
- 主题：下发深色后 `html[data-dsh-theme=dark]`、`editor-theme=telari-dark`，画布 `rgb(255,255,255) → rgb(31,33,38)`。
- 大文档臂（`?big=1`，155,005 字）：装入无截断；Worker 语法树 `requests=1 completed=1 nativeFallback=0`，605 ms；真实输入 +1；`requestText` 回执 155,006 = 155,006。

截图（已肉眼核对）：`probe/shot-selection-light.png`（浮按钮「插入对话」与选区）、`probe/shot-dark.png`（深色 +「已插入」徽标）、`probe/shot-large-doc.png`（155,006 字状态栏）。

### 4.3 未重跑的臂

- 真实 DSH 宿主内的保存落盘 E2E：本轮未重启宿主重跑。引擎侧 `change`/`text` 已在真实浏览器实测；客户端侧信封接受有单测；宿主保存闸门与 `requestText` 拉取在既有 host 测试（真实 `node:http` + mock ctx）中覆盖。重启宿主后可按 §6 复验。

## 5. 本机安装

- `web` 与 `desktop` 两个 profile 均为 `"dsh-markdown": "link:D:/BuyKey/markpilot-public/dsh-markdown"`，并且 `dsh.profile.bundles` 末尾含 `dsh-markdown`。
- 更新后：插件静态文件（内核/皮）由宿主按请求读盘，下一次 iframe 加载即生效；`lib/client.js` 属于客户端包，需重启宿主才会重新打包加载。

## 6. 重启后的复验命令

```powershell
node D:\BuyKey\markpilot-public\dsh-markdown\scripts\sync-core.mjs --check
# 重启 DSH（Desktop 托盘彻底退出后重开）→ 右侧栏打开一个 .md → 输入任意字符 → 等 2s → 读盘核对文件字节
```

## 7. 发布收据

- 源码提交：`33f9d19c5157fe667cb4b2f60cf9ce3ebb48072e`（main，已推送）
- GitHub Release：`https://github.com/ltmroberthk915/markpilot/releases/tag/dsh-markdown-v0.3.0`
- 资产：
  - `dsh-markdown-0.3.0.tgz` 2,522,038 B，SHA-256 `dfca925c2c0e557fdfdaec48e15177625b8fae636c6ae65b15cc6af425c58b27`（与 GitHub 回报的 asset digest 相同）
  - `SHA256SUMS.txt` 89 B
- 打包：`npm pack`，136 文件 / 解包 7.4 MB；`package/core.json` 为 `3.6.6`、`package/package.json` 为 `0.3.0`。
- 本机安装核对：解包 tgz 与 `D:\BuyKey\markpilot-public\dsh-markdown` 逐文件 SHA-256 比对 136/136 相同；
  web / desktop 两个 profile 的 `node_modules/dsh-markdown` 仍指向该目录，`core.json` 读到 `3.6.6` / 124 文件。

## 8. 本机生效状态

- 引擎与皮（`renderer-cm6/**`）：宿主按请求读盘，下一次 iframe 加载即新内核。
- 客户端包（`lib/client.js`，含本轮信封修复）：宿主启动时打包进内存，需重启宿主后才生效；
  本会话运行在旧宿主进程内，未代为重启。
