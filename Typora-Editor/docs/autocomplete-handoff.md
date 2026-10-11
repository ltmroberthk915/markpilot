# Markdown 编辑器自动补全 — 需求与交接文档

> 实施更新（2026-09-06）：插件已完成 0.1.13-local，使用说明、智谱预设、验证范围及桌面 Agent 讨论见 [AUTOCOMPLETE-0.1.13.md](AUTOCOMPLETE-0.1.13.md)。下文保留为原始需求记录；实际实现使用精确源码匹配、SecretStorage 和独立预览层，不采用近似文本偏移或把密钥写入 globalState 的建议。

> 用途：本文档自包含，可直接整份交给 AI 助手（GPT 等）或工程师做方案设计与实施。
> 所有代码位置带 `文件:行号`，所有 Vditor API 签名已对照本地 `cdn/vditor/dist/index.min.js`（v3.11.1）核实。
> 交接日期：2026-09-06。基线版本：`seepine.md-editor` 0.1.10-local。

---

## 0. 一句话需求

让本 VSIX 插件（Typora 式 Markdown 编辑器，Custom Editor + Vditor webview，部署目标为 Trae IDE 与 VSCode）拥有自动补全：**① 桥接 VSCode/Trae 宿主的补全生态，② 自建触发符补全源（片段/图片路径等），③ AI 灰字补全（自接 LLM）**。三条路线都要，实施顺序与触发方式见 §6（开放决策点）。

---

## 1. 项目现状速览（务必先读）

### 1.1 架构定性

- 本扩展魔改自市场扩展 `seepine.md-editor` 0.1.1，以 **Custom Editor（`customEditors` 贡献点）独占接管 `*.md`**（`extension-src/package.json` contributes 段，viewType `seepine.md-editor`，priority `default`）。
- 编辑界面是 **webview 内嵌 Vditor v3.11.1 的 IR（即时渲染）模式**，不是原生 TextEditor。
- 宿主侧代码是**预编译 CommonJS JS**（无 TS 源，`out/` 下直接改 JS）；webview 侧是**明文 ES Module JS**（`render/js/` 下 15 个自有模块），无打包器。
- 打包不走 vsce，走 `pack.py`（zip `extension-src/` + 手工清单 `vsix-meta/`）。发版需同时改 `extension-src/package.json` 与 `vsix-meta/extension.vsixmanifest` 两处版本号。

### 1.2 关键文件与职责

| 文件 | 职责 | 关键位置 |
|---|---|---|
| `extension-src/out/extension.js` | activate，注册 CustomEditorProvider | :16-20 |
| `extension-src/out/provider/markdownEditorProvider.js` | 核心编辑器：注入 webview、消息路由、文档同步 | 见下 |
| `extension-src/out/common/handler.js` | webview↔宿主消息桥（EventEmitter 封装） | 见下 |
| `extension-src/render/index.js` | webview 入口：new Vditor(...) | 见下 |
| `extension-src/render/js/typora-patches.js` | 魔改补丁总装（KaTeX 渐进渲染、各模块安装入口） | :360 `installIncrementalIR` |
| `extension-src/render/js/incremental-ir.js` | IR 增量源码缓存 + 撤销重做（**补全要复用的核心积木**） | 见下 |
| `extension-src/render/js/source-text.js` | DOM 纯文本投影，`point(offset)` 文本偏移↔DOM 位置互转 | — |
| `extension-src/render/js/selection-markdown.js` | 任意内联选区 → markdown（哨兵包裹法） | — |
| `render/js/vscode.js` | `acquireVsCodeApi` 判空降级（浏览器可独立跑），暴露 `window.handler` / `window.vscodeEvent` | :1-3 |

### 1.3 宿主侧要点（`markdownEditorProvider.js`）

- `resolveCustomTextEditor(document, webviewPanel, token)`（:31）：**`document` 是真实 `vscode.TextDocument`**——这是桥接宿主补全的关键资产（它的 `uri` 可直接喂给 `vscode.executeCompletionItemProvider`）。
- 消息桥建立（:53）：`const handler = Hanlder.bind(webviewPanel, document.uri)`，之后 `handler.on("xxx", cb)` 收 webview 消息、`handler.emit("yyy", data)` 发回 webview。
- 现有消息：`init`→`open`（:54-65）、`change`→`updateTextDocument`（:66-68）、`setValue`（外部保存推送 :81-88）、`shortcuts-set`、`theme-set`、`img`、`openLink`、`scroll`、`editInVSCode`（:119-121，跳回默认文本编辑器）、`reload`。
- `updateTextDocument`（:126-132）：整文档 `WorkspaceEdit.replace`。**注意**：webview 的 `input()` 有 200ms 防抖（`undoDelay: 200`，`render/index.js:33`），宿主 TextDocument 里的文本**可能滞后 webview 当前内容约 200ms**。

### 1.4 消息桥协议（`handler.js`）

- webview→宿主：`window.handler.emit(type, content)` → 宿主 `handler.on(type, cb)`；宿主→webview 反向同构（`panel.webview.postMessage({type, content})`）。
- `Hanlder.on` 对同名事件**自动移除旧监听再挂新的**（handler.js:12-17），补全消息照常注册即可，不会重复。
- 新增补全消息建议命名：`completion-request` / `completion-response`（宿主→webview）、`llm-config-set` / `llm-config-get`（AI 路线）。

### 1.5 webview 侧要点（`render/index.js`）

- `new Vditor("vditor", {...})`（:23-87）；`hint: {}` 目前为**空配置**（:58）——补全路线 A 的挂点。
- `input(content)` 回调（:62-64）：防抖后把全文 markdown 发 `change` 给宿主。
- `after()` 回调（:72-86）：Vditor 就绪后 `applyTyporaPatches(vditor)` 安装各魔改模块——**补全模块也应在此安装**（Vditor 实例与 `vditor.vditor` 内部对象此时才可用）。
- `window.vditor = vditor`（:88）全局暴露。

---

## 2. 根本约束（设计补全方案的第一前提）

1. **Custom Editor 独占 `*.md`**：VSCode/Trae 原生 IntelliSense、其他扩展的 CompletionItemProvider、inline completion（含 Trae 自家 AI 灰字、Copilot）**都不会出现在 webview 里的 Vditor 编辑区**。原生补全只出现在用户点 `editInVSCode` 跳回的默认文本编辑器里。
2. **Trae 的 AI inline 补全无公开扩展 API**（Trae 是 VSCode fork，标准扩展 API 大多兼容，但其 AI 补全服务不暴露给扩展，也没有公开命令可请求 inline completions）。因此"AI 灰字"只能自接 LLM（路线 C）。
3. **宿主补全可以按 URI+Position 程序化查询**：官方内置命令 `vscode.executeCompletionItemProvider`（见 §4），这是 VSCode 官方认可的跨上下文桥接模式（Embedded Languages 指南即此用法），Trae fork 下同样可用。

---

## 3. 路线 A：自建触发符补全（见效最快，建议首先实施）

### 3.1 机制（已核实 v3.11.1 源码）

Vditor 的 hint 即补全系统。类型定义：

```ts
interface IHint {
  parse?: boolean;        // 默认 true：插入 value 前过 Lute Spin（value 应为 markdown 片段）
  emojiTail?: string;
  delay?: number;         // 默认 200ms，extend 回调防抖
  emoji?: { [key: string]: string };
  emojiPath?: string;
  extend?: IHintExtend[]; // 注意字段名是 extend 不是 expand
}
interface IHintExtend { key: string; hint?(value: string): IHintData[] | Promise<IHintData[]>; }
interface IHintData { html: string; value: string; }
```

- **运行时挂载**（不必改构造参数）：`vditor.vditor.options.hint.extend.push({ key: "@", hint: async q => items })`。下拉框、光标定位、↑↓ 导航、Enter 选中、插入+Lute 解析全部原生免费。
- **触发规则（硬编码，无法用配置绕过）**：`getKey` 取光标前当前文本节点内容，触发符必须 ①位于文本节点**第 0 位**，或 ②**前一字符是空格**；且触发符后查询串 **≤32 字符**。构造器会自动 push 一个 `{key:":"}` 的 emoji 项，恒存在。
- **插入语义**（`hint.fillEmoji`）：从**触发符起删到光标**，然后 `parse:true` 时按 IR 模式走 `Lute.SpinVditorIRDOM(value)` 插入（value 给 markdown 源码即可），`false` 时原样 HTML 插入。
- **`genHTML` 最多渲染 8 项**（index > 7 跳过）。
- 键盘交互只有 ↑↓ 和 Enter（无 Ctrl/Meta/Shift/Alt 且非输入法合成态）；**Tab 原生不处理**，要 Tab 确认需走 `options.keydown` 钩子拦截（见 §7）。

### 3.2 建议数据源（需求清单）

1. **Markdown 片段/模板**：`/` 触发——表格模板（2/3 列）、代码块（带常用语言列表）、mermaid 图模板、公式块、front-matter 骨架、任务列表、详情折叠块等。
2. **工作区图片路径**：`!` 或 `@` 触发——webview 发消息给宿主，宿主遍历工作区（与文档同目录优先）常见图片扩展名，回传相对路径候选，value 插入 `![](path)`。注意走现有 `img` 消息之外的**新消息**，且做缓存与防抖。
3. **文档内标题/锚点引用**：`#` 触发——解析当前文档标题（可从 outline 数据取），插入 `[文字](#锚点)`。
4. **数学符号/环境**：路线 C 之外的公式补全可在 `$` 块内做 `\` 触发的 LaTeX 命令表（KaTeX 支持集）。
5. **emoji**：默认 `:` 项已有，可扩充 `hint.emoji` 词表。

### 3.3 实施位置

- 新建 `render/js/completion-sources.js`，在 `render/index.js` 的 `after()` 内（`applyTyporaPatches(vditor)` 之后）安装；或并入 typora-patches 总装。
- 宿主侧仅在需要工作区数据（图片路径）时加一条消息处理，挂在 `markdownEditorProvider.js` 的 `handleEvent`（:95-125）链上。

---

## 4. 路线 B：桥接 VSCode/Trae 补全生态（核心路线，真正"接上宿主"）

### 4.1 原理

宿主侧调用官方内置命令查询任意 URI+Position 的补全候选（不依赖编辑器可见性，所有已注册的 CompletionItemProvider 都会被聚合：VSCode 内置 markdown 词补全、其他扩展的片段/路径补全、LSP 等）：

```js
const list = await vscode.commands.executeCommand(
  'vscode.executeCompletionItemProvider',
  document.uri,            // 真实 TextDocument 的 uri
  new vscode.Position(line, character),
  triggerCharacter         // 可选
);
// 返回 vscode.CompletionList: { items: CompletionItem[], isIncomplete }
```

### 4.2 数据流设计

```
webview (Vditor)                          宿主 (extension host)
────────────────────────────────────────────────────────────────
输入/光标变化 → 防抖(100~200ms)
→ 计算当前前缀 + 光标源码 Position   ──completion-request──▶
                                          executeCompletionItemProvider
                                          精简序列化(≤50条)
◀──────────────────────────completion-response──
hint.genHTML(items, prefix, vditor) 展示
Enter/Tab 选中 → 前缀替换插入
```

宿主侧改动集中在 `markdownEditorProvider.js` 的 `handleEvent` 里新增：

```js
.on("completion-request", async ({ line, character, prefix, triggerCharacter }) => {
  let items = [];
  try {
    const pos = new vscode.Position(line, character);
    const list = await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider', document.uri, pos, triggerCharacter);
    items = (list?.items || []).slice(0, 50).map(it => ({
      label: typeof it.label === 'string' ? it.label : it.label?.label,
      insertText: typeof it.insertText === 'string' ? it.insertText
                : it.insertText?.value,            // SnippetString
      kind: it.kind, detail: it.detail, sortText: it.sortText,
      isSnippet: !!it.insertText && typeof it.insertText !== 'string',
    }));
  } catch (e) { /* 静默，补全失败不干扰编辑 */ }
  handler.emit("completion-response", { requestId, items });
});
```

**注意**：`insertText` 可能是 `SnippetString`（含 `$1` 占位/tabstop）。webview 侧无法原生展开 snippet，一期建议：纯文本直接插；含占位符的做简易处理（去掉 `$n`/`${n:...}` 保留默认文本）或跳过并标记。

### 4.3 webview 侧：光标 → 源码 Position 映射（有现成积木）

目标：把 contenteditable 里的光标位置换算成 `vscode.Position(line, character)`。推荐块级增量算法（避免全量 `getValue()`，大文档慢）：

1. `const sel = getSelection(); const node = sel.getRangeAt(0).startContainer;`
2. `block = blockOf(node)`——`incremental-ir.js:78-81` 有实现（向上走到 `parentNode === vditor.vditor.ir.element` 即顶层块），未导出，4 行可重写。
3. 在 `sourceBlocks()`（`incremental-ir.js:231`，返回 `[{node, html}]`）中按引用找到该块索引 i。
4. 前 i-1 个块的 markdown 用 `incremental-ir` 的缓存（`entryFor(block).html` → `lute.VditorIRDOM2Md`，见 `:105-123`）——该模块已做 16 块一组批量转换与 LRU，直接用其 `getMarkdown()` 思路。
5. 当前块 md = `VditorIRDOM2Md(当前块.outerHTML)`（单块转换很快）；块内光标偏移可用 `source-text.js` 的 `point(offset)` 在块内求字符位置。
6. 累加前面各块 md 的行数与最后一行字符数 → 得 `(line, character)`；前缀 = 光标前当前"词"（`[\w\u4e00-\u9fa5_./-]+` 按需定）。

### 4.4 已识别的四个难题与建议解法

| 难题 | 说明 | 建议 |
|---|---|---|
| **textEdit 无法映射** | 返回的 `CompletionItem.textEdit` 的 range 是针对宿主 TextDocument 的，无法精确映射回 contenteditable DOM | **丢弃 textEdit**，只用 `label`/`insertText`；应用时"删除当前词前缀 + 插入文本" |
| **宿主文档滞后** | webview `input()` 200ms 防抖 → 宿主 TextDocument 可能比 webview 光标处文本旧 200ms，查询位置与实际文本错位 | ① 查询时把 webview 当前前缀随请求带上，宿主侧用 `document.getText()` 校验该行是否吻合，不吻合则跳过本次；② 或接受轻度错位——多数 provider 按前缀过滤，错位只影响词法类候选 |
| **每键性能** | 不能每键全量 `getValue()` + 全量转换 | 用 §4.3 块级增量；请求防抖 100~200ms；`isIncomplete` 忽略（webview 场景无法 refine）；Enter/↑↓ 期间挂起新请求 |
| **detail/documentation 缺失** | 不调用 `resolveCompletionItem`，懒解析 provider 的富信息拿不到 | 一期接受；下拉里只展示 label + kind 图标 + detail（有则显） |

### 4.5 候选展示与应用

- 展示复用原生层：`vditor.vditor.hint.genHTML(items.map(it => ({html: 转义label+图标, value: encodeURIComponent(插入文本)})), prefix, vditor)`——自动定位光标处、加粗命中、↑↓/Enter 交互免费。
- 但 `fillEmoji` 会"从触发符删到光标"——桥接场景没有触发符。两个选择：**a)** 覆盖实例方法 `vditor.vditor.hint.fillEmoji = 自定义`（先删当前词前缀再 `vditor.insertMD(text)` / `insertValue`）；**b)** 完全自建下拉层。推荐 a，改动小。
- Tab 确认：`options.keydown` 里 `event.key === 'Tab' && hint 下拉可见` → 模拟点击当前项并 `event.preventDefault()`（keydown 钩子先于 Vditor 内置 hint.select 执行，见 §7）。

### 4.6 Trae 兼容性

Trae 是 VSCode fork（支持安装 VSIX、标准扩展 API 大多兼容）。`vscode.executeCompletionItemProvider` 是核心内置命令，fork 均保留。已在用的同类模式（`vscode.openWith`、`vscode.open`）在本插件 Trae 部署中工作正常。风险：Trae 内置 AI 的候选不会出现在该命令结果里（它走 inline completion 通道，不走 CompletionItemProvider）。

---

## 5. 路线 C：AI 灰字补全（自接 LLM，工作量最大）

### 5.1 配置

- 存储：仿现有 `shortcuts-set`/`theme-set` 模式（`markdownEditorProvider.js:69-79`），新增 `llm-config-set` 消息，存 `ctx.globalState`（baseUrl / model / apiKey / 触发停顿阈值 / 开关）。设置 UI 仿 `edit-shortcuts.js` 的 `showShortcutSettings` 弹层。
- 调用：OpenAI 兼容 `POST {baseUrl}/chat/completions`，`stream: false`（一期）或 SSE 流式（二期）。**apiKey 只存宿主 globalState，请求由宿主侧发起**（webview 无 CORS/密钥暴露问题）——即 webview 发 `llm-complete-request {前文, 后文}`，宿主调 API 回 `llm-complete-response {text}`。

### 5.2 触发与上下文

- 触发：输入停顿 500~800ms（可配）+ 手动快捷键（如 Alt+\）。
- 上下文：光标前 N 字符 + 后 M 字符（建议前 2000 / 后 500，markdown 源文本），用 §4.3 同样的块级映射截取，避免全量。提示词要求"只返回可直接续写的纯 markdown 文本，不要解释"。
- 停止条件：光标移动 / 继续输入 / Esc / 响应超时（2~3s）即丢弃。

### 5.3 灰字渲染（两方案，推荐 b）

**a) 光标处插入灰色 span**（`<span class="ai-ghost">建议文本</span>` 插入 contenteditable）：视觉最贴近原生，但会 ①进 `getValue()` 污染发回宿主的文档内容，②进 incremental-ir 的 undo 快照，③与 math-scheduler/incremental-ir 重渲染互相干扰。若选 a，必须：插入前后置 `ir.preventInput = true`、从 `getMarkdown` 序列化中剔除该 span（marker class 过滤）、undo 栈需打补丁排除。**坑多，不推荐**。

**b) overlay 浮层定位（推荐）**：不碰 DOM。用 `getSelection().getRangeAt(0).getBoundingClientRect()` 定位，绝对定位一个同字体灰字层显示建议（换行需按容器宽度预折行，或一期只显示单行截断+省略号，接受长建议看不全）。Tab 接受时一次性 `vditor.insertMD(text)`。不污染 undo 栈与 `getValue()`，实现独立、风险低。

### 5.4 键盘

- `options.keydown` 钩子拦截：`Tab` → 接受（insertMD + 隐藏 overlay + preventDefault）；`Esc` → 拒绝；其他可打印键 → 立即废弃在途请求。
- 注意与 `edit-shortcuts.js`（自定义快捷键）和 `find-replace.js`（Ctrl+F/H）的冲突排查；keydown 钩子是最先执行的（见 §7），自行 ensure 不 swallow 其他功能。

---

## 6. 触发方式（开放决策点——留给需求方与 GPT 定）

| 选项 | 体验 | 实现成本 | 风险 |
|---|---|---|---|
| **仅触发符**（`@` `/` `:` `!` `#`） | 安静、误弹少；但"打字就补全"的 IDE 体验没有 | 最低：`hint.extend.push` 即得全套原生交互 | 几乎无 |
| **打字即弹**（IDE 式任意前缀） | 最像 VSCode | 中：需运行时覆盖 `vditor.vditor.hint.getKey/render` 或 keydown+自算前缀再调 `genHTML`；需防抖调优 | 与输入法合成、find-replace、代码块内编辑的边界情况需测 |
| **双模式开关**（配置项切换） | 兼得 | = 两者之和，但共用同一候选管道，增量成本可控 | 配置面稍大 |

原生限制（无论哪种都要知道）：查询串 ≤32 字符；触发符须在文本节点首位或前邻空格（打字即弹方案必须绕过此逻辑，即覆盖 `getKey`）；`genHTML` 最多 8 项——候选多时需自行预排序截断。

**建议**：路线 A 用触发符（天然契合）；路线 B 先做触发符可用的 provider 转发（如 `/`、路径场景），再评估是否值得上"打字即弹"；路线 C 独立于 hint 系统，不受此决策影响。

---

## 7. 关键 API 速查（本地 v3.11.1 源码核实版）

### Vditor hint 运行时对象

- 访问：`vditor.vditor.hint`（内部对象，实例方法可覆盖/直调）。属性：`element`（div.vditor-hint）、`splitChar`、`lastIndex`、`recentLanguage`。
- 方法：`render(vditor)`（输入时被调）、`getKey(text, extend)`（触发符判定，**覆盖点**）、`genHTML(data, filter, vditor)`（渲染下拉，≤8 项）、`select(event, vditor)`（↑↓/Enter 路由）、`fillEmoji(element, vditor)`（应用选中项，**覆盖点**）。
- 键盘路由时序：`options.keydown(event)` 回调 **最先**执行 → 内置 `hint.select`（仅当 `extend.length > 1 || toolbar 有 emoji 项`，本项目 toolbar.js:15 含 emoji 项，已生效）→ 正常按键处理。

### Vditor 公开 API（补全相关子集）

- `insertMD(md)`——插 markdown 源（IR 下走 `Md2VditorIRDOM`），**插入补全文本首选**。
- `insertValue(value, render=true)`——按 HTML 解析插入，纯文本场景可用。
- `getValue()`——全文 md（全量重解析，**大文档慢，避免每键调用**）。
- `getSelection()`——选中文本；取光标用 `window.getSelection().getRangeAt(0)`（无公开 getRange）。
- `setValue(md, clearStack)` / `updateValue(html)` / `deleteValue()`。
- 回调钩子：`keydown(event)`（最优先）、`input(value)`（防抖后全文）、`after()`、`focus/blur/esc/ctrlEnter/select/unSelect`。**无 selectionchange 监听**——感知光标移动需自行 `document.addEventListener('selectionchange')`。

### 宿主侧

- `vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, position, triggerCharacter?)` → `Thenable<CompletionList>`；官方文档：code.visualstudio.com/api/references/commands（Embedded Languages 指南为跨上下文桥接的官方范例）。
- 消息桥：`handler.on(type, cb)` / `handler.emit(type, content)`（§1.4）。

### 块级映射积木（`incremental-ir.js`，`vditor.vditor.__typoraPerformance`）

- `blockOf(node)` :78-81；`entryFor(block)` :105-121（缓存 `{html, dependent, shape}`）；`convert(html)` :123；`getMarkdown()` :124-166（增量拼装）；`snapshot()` :168-197（含光标 Range→块内路径算法 :180-190）；`sourceBlocks()` :231；`historyMarkdown(html)` :232（LRU）。
- 挂载：`typora-patches.js:360 installIncrementalIR(api)`；undo/redo 集成 `typora-patches.js:103-162`。

---

## 8. 坑清单（实施时逐条核对）

1. `fillEmoji` 从**触发符起删到光标**——桥接/无触发符场景必须自定义应用逻辑。
2. `genHTML` 硬上限 8 项——多候选需自行排序截断。
3. 构造器恒 push `{key:":"}` emoji 项——`extend.length > 1` 判断恒真，hint 键盘路由总是启用。
4. 触发判定：触发符须在文本节点首位或前邻空格；查询串 ≤32 字符；`{key:" "}` 不可行。
5. `hint.parse` 默认 true：value 会过 Lute——桥接候选若已是纯文本，用 `parse:false` 语义或绕过 fillEmoji 自插。
6. Tab 原生不处理；Enter 路由要求非 composing（输入法状态）——中文输入法高频场景，测！
7. `getValue()` 全量重解析，大文档（>1MB）慢——一切前缀/位置计算走块级增量。
8. 宿主 TextDocument 滞后 webview ~200ms（input 防抖）——桥接查询需容错（§4.4）。
9. `insertText` 可能是 SnippetString（`$1` tabstop）——webview 无法原生展开，需降级处理。
10. 代码块/公式块/链接文字内部的光标：块级映射会把它当普通文本块处理，LaTeX/代码补全数据源要按块类型分流。
11. 与 `find-replace.js`（Ctrl+F/H）、`edit-shortcuts.js`（自定义快捷键）的键盘冲突——新增 Tab/Esc/Alt+\ 拦截前先查这两个模块。
12. webview 独立浏览器运行模式（`vscode.js` 判空降级）——宿主消息（补全候选、llm 配置）不存在时需静默降级，不报错。
13. 发版双版本号：`extension-src/package.json` + `vsix-meta/extension.vsixmanifest`，打包 `python pack.py`，产物在 `dist/`。

## 9. 验证流程

- 浏览器回归：`test/serve.py` + `test/regression.js`（webview 可脱离宿主跑，宿主相关功能需 mock `window.handler`）。
- VSCode 冒烟：`test/vscode-smoke.cjs`（@vscode/test-electron）。
- Trae 实装：`trae --install-extension dist/xxx.vsix`，失败则手动投放到 `~/.trae/extensions/`（既有流程）。
- 补全专项手测清单：中文输入法下打字弹层与 Enter 确认；`@ / : ! #` 各触发符；表格/代码块/公式块内部；大文档（1000+ 行）输入延迟无感知劣化；`editInVSCode` 跳转往返后补全仍正常。

---

## 10. 建议实施顺序

1. **P0 路线 A（触发符 + 自建源）**：最小闭环，验证 hint 挂载、插入语义、Tab 拦截。
2. **P1 路线 B（桥接宿主补全）**：先宿主消息 + 前缀过滤的粗版（Position 可先用"当前块行首+查询行文本定位"近似），再上精确块级映射。
3. **P2 触发方式升级**：按 §6 决策结果实施"打字即弹"（覆盖 getKey/render）。
4. **P3 路线 C（AI 灰字）**：overlay 方案 + 宿主侧 API 代理 + 配置 UI。
