# dsh-markdown 插件架构（MarkPilot CM6 3.6.2 · 换皮套壳）

> 内部记录。代码位置：`dsh-markdown/`。目标：把 MarkPilot 3.6.2 已构建的编辑面装进 DSH，同时让"桌面版升级 → 插件跟上"只需要一条同步命令。

## 1. 一句话

**引擎是搬进来的，不是重写的。** `renderer-cm6/cm6/` 是 `MarkPilot-CM6/renderer/cm6/` 的逐字节副本；插件只提供 DSH 皮、宿主桥、文件 IO 和选中文段插入。

## 2. 所有权（Astra 规则）

| 东西 | 唯一权威 |
|---|---|
| Markdown 字节、选区、撤销历史 | iframe 内的 CM6 `EditorState` |
| 保存身份（path + version + generation） | 插件客户端 `lib/client.js` |
| 磁盘版本守卫 | 宿主 `ctx.fs`（`replaceIfVersion` / `editText`） |
| 插入对话的输入框 | DSH `props.inputActions`（`captureInsertion` / `insertText`） |
| 内核版本身份 | `core.json`（124 文件 SHA256 + `coreHash`） |
| 主题调色板 | 引擎 `window.mpTheme`（桥只调 `setTheme`，不写调色板） |

壳不缓存第二份文档；不抢占焦点；不用定时器修状态。

## 3. 目录形状（必须与 EXE 构建产物同形）

```
renderer-cm6/
  index.html          DSH 皮：base → app.css → dsh-bridge → dsh-selection(defer) → cm6/app.js
  dsh-bridge.js       协议 v1：bridge-ready / init 看门狗 / host-invoke / open/setValue/requestText/theme/toast
  dsh-selection.js    选中文段 → insert-to-chat（只读 CM6 state）
  cm6/                从 MarkPilot-CM6/renderer/cm6 逐字节复制（不含 index.html）
    app.js app.css markdown-worker.js mermaid.min.js KaTeX_* fonts/...
```

为什么入口在上一级：引擎用 `new Worker(new URL("cm6/markdown-worker.js", location.href))` 和 `document.currentScript.src` 推导 mermaid/KaTeX；把 `index.html` 放错层会让 Worker/mermaid/字体 404。

## 4. 分层

### 4.1 皮（DSH 侧，永远归插件）

- `index.html`：CSP（`script-src 'self'`、`worker-src 'self' blob:`、图片放行 http/https）、首帧底色、浮按钮/提示样式。
- `dsh-bridge.js`：iframe ↔ 父窗口唯一传输层；不缓存文档；主题只调引擎既有 `setTheme`；init 看门狗（2s×30）只负责握手自愈。
- `dsh-selection.js`：`selectionchange` + rAF 合并；从 `window.mpEngine._view()` 的 `state.selection.ranges` + `state.doc.sliceString(from,to)` 取**文档源码**；`fixed` 浮按钮；点击 preventDefault 保选区；Ctrl/Cmd+Shift+Enter；>256 KiB 拒绝并提示，不截断。

### 4.2 宿主半边（`lib/index.js`）

- 静态路由 `/dsh-markdown/renderer-cm6/*`：MIME、ETag/304、入口/app.js/app.css `no-cache`、字体 7 天长缓存、路径穿越拒绝。
- `core.json` 路由：内核版本/哈希诊断。
- `open/save/stat/edit` + SSE `watch`：所有写走 `ctx.fs` 版本守卫；`save` 必带 `baseVersion`；`FS_STALE_VERSION` 原样回传。
- `markpilot` 工具：read/edit，与编辑面同一守卫（file URL 安装时可能因依赖解析不到而缺席，仅 warn）。

### 4.3 客户端半边（`lib/client.js`）

- `sidebar.right.pane.tab` 注册 `dsh-markdown/editor`，patterns `*.md`/`*.markdown`，`keepMounted`。
- iframe 生命周期：`bridge-ready`/`init` 后先 theme 再 open；文档代际 `sessionId+path+generation`，旧回执拒收。
- 保存：`change` 轻量脏标 → 1500ms 防抖 → `requestText`（2s 超时）→ 串行保存（必带 `baseVersion`）→ `stat` 对账。
- 冲突：脏缓冲绝不覆盖；横幅给「重载磁盘版本 / 复制我的内容」。
- 关 tab flush：`requestText` ≤120ms → keepalive save（带 `baseVersion`）；拿不到全文/失败写 `localStorage` 恢复槽，重开时只在"与磁盘不同"时提示恢复。
- 外部变更：SSE 优先；干净才 `setValue` 重载；断了降级 2s→6s 轮询；页面隐藏暂停。
- 选中文段插入：`props.inputActions.captureInsertion()` + `insertText(text,span)`；失败重 capture 一次；仍失败复制到剪贴板并提示。不直接改 composer DOM。

## 5. 主题

DSH 用 `body[data-ds-dark-theme]` 表达明暗。客户端 `MutationObserver` 只看 body attributes，向 iframe 发 `theme {dark}`；桥写 `localStorage['editor-theme']` 让 boot 首帧正确，并在 `window.mpEngine` 就绪后调 `setTheme('telari-dark'|'telari-light')`。引擎调色板仍由 `window.mpTheme` 单一写者维护。

## 6. 性能

- 编辑器在 iframe：宿主 React 不因键入重渲染；iframe 只在 tab body 挂载时创建一次。
- 核心资源走 ETag/304；字体长缓存；Worker/mermaid/KaTeX 全部本地，按需加载。
- 选区旁路：1 个 fixed 按钮 + 1 个 rAF 合并的 `selectionchange`，无轮询/无长定时器。
- 保存：防抖 1500ms；每周期最多一次 `requestText`；SSE 优先。
- 实测（Electron 44 / Chromium 152，1440×900，隐藏窗口，单次采样）：300,056 字文档 boot 309ms、bridge-ready 18ms、init 86ms；Worker+mermaid+KaTeX 首就绪 598ms；selectionchange 6 / rAF 7；console error 0。

## 7. 升级与对齐

```
桌面构建产物 MarkPilot-CM6/renderer/cm6
  → node dsh-markdown/scripts/sync-core.mjs
  → renderer-cm6/cm6/（逐字节）+ core.json（哈希）
  → node scripts/sync-core.mjs --check（0 = 对齐）
  → 重启 DSH
```

`--check` 在 1 字节漂移下必须变红（已做突变验证：25201→25202 → CHECK_DRIFT exit 1 → 重新 sync → CHECK_OK）。

## 8. 已知边界

- `markpilot` 工具依赖宿主 `@deepseek-ai/dsh-tools`；file URL 安装时可能解析不到。
- 引擎工具栏里桌面专属的导出/图片选择入口在 DSH 可能不可用；编辑、公式、表格、Mermaid、保存、选中文段插入不受影响。
- 插入不抢焦点，撤销需先点回输入框。
- 多选区实现支持但未做真实多光标验收；表格格内 contenteditable 覆盖层未专项验收。
