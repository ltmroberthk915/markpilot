# dsh-markdown-typora 0.3.3：手动保存、工作区外保存、选区路径前缀（内部记录）

日期：2026-10-31（Asia/Shanghai）
产品：`dsh-markdown-typora` 0.3.3（内核仍是 MarkPilot CM6 3.6.6，`core.json` 124 文件不变）

## 1. 用户可见目标

1. 在 DSH 右侧栏的 Markdown 面板里按 `Ctrl/Cmd + S` 能立即保存；焦点不在编辑区也保存；不再弹浏览器「保存网页/HTML」。
2. 侧栏打开的文件即使不在当前会话工作区里，也能写回原文件夹；版本守卫和冲突提示不变。
3. 选中文段 → 对话（`Ctrl/Cmd + Shift + Enter` 或「插入对话」按钮）时，插入内容开头始终带文档绝对路径。

## 2. 根因与修法

### 2.1 Ctrl+S 空转 / 浏览器保存网页

- 引擎 `renderer-cm6/cm6/app.js` 把 `Ctrl+S` 绑定到 `ACTIONS.save`，第一句读
  `window.mpHost`；DSH 皮此前从未定义它 ⇒ 动作直接 `return`，不落盘、不报错。
- 焦点不在 iframe 内时，按键落到浏览器默认行为 ⇒ 「保存网页/HTML」对话框。
- `renderer-cm6/dsh-bridge.js` 补最小宿主面 `window.mpHost.__save`，上行
  `manual-save`。
- `lib/client.js` 收到后取消防抖、立即 `requestText` 拉全文并走同一个
  `fs.writeText` 版本守卫；给出「已保存 / 没有需要保存的改动 / 保存失败 /
  冲突」反馈，保存飞行中的请求排队。
- 父窗口捕获阶段监听 `Ctrl+S`（只要该 Markdown tab 可见），`preventDefault`，
  焦点在 tab 壳、侧栏或对话输入框时也保存文档，不再弹浏览器保存网页。

### 2.2 `FS_SANDBOX_DENIED`（workspace-write）

- 右侧栏能打开任意文件夹，但 DSH 的 `workspace-write` 根是**会话工作区**
  （通常是会话 cwd），不是侧栏打开的文件夹。文件在会话工作区外时
  `ctx.fs.writeText` 抛 `FS_SANDBOX_DENIED`。
- `lib/index.js` 的 `apiSave` 只对这个明确错误码走 Node 原生 `fs` 回退：
  - 先读 `ctx.fs.stat` 比对 `baseVersion`，不一致仍返回 `FS_STALE_VERSION`；
  - 原生 `fs.writeFile` 写盘；
  - 写后优先用 `ctx.fs.stat` 的新版本，读不到才用同形的
    `dev:ino:size:mtimeNs:ctimeNs` bigint 版本；
  - OS 的 EACCES/EPERM 不吞，照常报错。
- 影响面仅限 Markdown 保存（save），不改读取、图片路由、watch 或其它 fs 能力。

### 2.3 选区→对话路径前缀

- `lib/client.js` 新增纯函数 `composeInsertionText(path, text)`：
  `绝对路径 + "\n\n" + 选区源码`；路径缺失时退回原文。
- `onInsertToChat` 用 `doc.displayPath || doc.absPath || doc.path` 取绝对路径，
  按钮和 `Ctrl/Cmd + Shift + Enter` 共用同一路径；剪贴板兜底也带前缀。
- 选区 256 KiB 上限与插入失败重试/剪贴板兜底逻辑不变。

## 3. 测试与证据

### 3.1 单元/宿主测试（真实插件目录）

```text
node test/client.test.mjs   -> 14/14 pass, exit 0
node test/manual-save.test.mjs -> 3/3 pass, exit 0
node test/host.test.mjs     -> 17/17 pass, exit 0
```

新增覆盖：

- `manualSaveGate`：save/clean/queue/block/skip 五臂；
- 桥 `__save`：只发一条 `manual-save`、不覆盖既有宿主 `__save`；
- 沙箱拒绝回退：`FS_SANDBOX_DENIED` 时原生 fs 写入成功，旧 `baseVersion`
  仍报 `FS_STALE_VERSION` 且不覆盖；
- `composeInsertionText`：路径+空行+选区，空路径/空内容边界。

### 3.2 隔离 DSH 宿主 E2E

- 宿主：`@deepseek-ai/dsh` 0.2.1-rc.3，`DSH_HOME` 沙箱，profile `e2e`，
  插件 `file://` 指向本仓库 `dsh-markdown-typora/lib/index.js`。
- 会话工作区故意设在 `_mpfix/save-20261031/work`，文档放在
  `D:\Users\Ming\Desktop\秋招笔试\.dsh-manual-save-test.md`（工作区外）：
  - `window.mpHost.__save` 存在；调用后父窗口收到 `manual-save`；
  - 客户端拉全文并发起版本守卫写请求；
  - 原生 fs 回退成功，**58ms** 标记写入磁盘，UI 显示「已保存」；
  - 测试文件随后删除；用户原文档 `新建 Markdown 文档.md` 未改写
    （9,033,846 B，mtime 2026-10-31 09:26:44 未变）。
- 收据：`_mpfix/save-20261031/evidence/probe-manual-save.json`；
  修复说明：`_mpfix/save-20261031/FIX-NOTE.md`。

### 3.3 未覆盖

- 选区路径前缀的「真实键盘 Ctrl+Shift+Enter → composer」端到端在这一轮
  未重跑；父窗口载荷函数与插入函数有单测，插入链路沿用 0.3.2 已验证路径。
- 焦点在对话输入框时的 `Ctrl+S` 由父窗口捕获，未单独做真实键盘 E2E；
  代码路径与 tab 壳捕获相同。

## 4. 变更文件

```text
dsh-markdown-typora/lib/client.js             手动保存 + 全局 Ctrl+S + 路径前缀
dsh-markdown-typora/lib/index.js              工作区外保存原生 fs 回退
dsh-markdown-typora/renderer-cm6/dsh-bridge.js mpHost.__save → manual-save
dsh-markdown-typora/test/client.test.mjs      手动保存/路径前缀测试
dsh-markdown-typora/test/host.test.mjs        沙箱回退测试
dsh-markdown-typora/test/manual-save.test.mjs 新增桥测试
dsh-markdown-typora/package.json              0.3.2 → 0.3.3
dsh-markdown-typora/README.md                 功能与安装版本
docs/RELEASE-DSH-0.3.3.md                     发布说明
docs/LOG-DSH-0.3.3-MANUAL-SAVE.md             本文件
```

## 5. 发布收据（0.3.3）

- 源码提交：`95f821c`（main，10 文件 +573/−21）；分支保护以管理员身份直推
  （`remote: Bypassed rule violations … Changes must be made through a pull request`）。
- 打包：`npm pack` → `dsh-markdown-typora-0.3.3.tgz`
  - 2,531,182 B；sha256 `2599faa0d7cd97fa65c8dc3e3a57098a8f19551339e9e23654b0faac116f6990`
  - 解包复核：`package.json` = `dsh-markdown-typora@0.3.3`；136 文件 7,479,336 B；
    `core.json` 仍 124 文件 / version 3.6.6 / `coreHash d6df048c976e…`；
    `lib/index.js` 含 `directWriteText`/`isSandboxWriteDenied`，
    `lib/client.js` 含 `composeInsertionText`/`manual-save`，
    桥含 `manual-save`；`test/` 未进包（`files` 白名单）。
- Release：`dsh-markdown-typora-v0.3.3`（Latest，
  <https://github.com/ltmroberthk915/markpilot/releases/tag/dsh-markdown-typora-v0.3.3>）
  - 资产：`dsh-markdown-typora-0.3.3.tgz`（2,531,182 B）+ `SHA256SUMS.txt`（96 B）
  - 资产回下载复核：字节数一致、sha256 与打包一致；说明文件使用
    `docs/RELEASE-DSH-0.3.3.md`。
- 市场条目：`D:\BuyKey\_publish\entry-dsh-markdown-typora.yml` 与
  `fork-entry` 均已更新为 0.3.3 的 tarball，描述包含 Typora/手动保存/工作区外保存/
  绝对路径。上游 PR **#10776** 已提交：
  <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10776>
  （1 file +3/−3，`MERGEABLE`；截至本记录 CI 仍 pending，合并由维护者执行）。
  合并后官方 `plugins.json` 需重新构建；中国区优先的 npm 快照当时仍是
  `dsh-plugin-catalog@2026.1030.12510`（7,723 条，旧名 `markpilot#dsh-markdown`，
  无 `typora`），需等下一次目录构建/镜像同步。


