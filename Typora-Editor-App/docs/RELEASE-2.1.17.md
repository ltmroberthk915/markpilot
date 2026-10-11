# MarkPilot 2.1.17 发布说明（私版）

这一版只动一件事：**公式命令补全的"同类补全"**（你第 8 轮的要求）。顺带把你问的"是否依赖 AI API"实测答复清楚。

## 一 你看到的现象与实测

「这个补全怎么现在最多只显示前两个，之前还显示挺多的……我印象中有一个版本，比如我在这里插入补全 `\mathbb`，它会自动给我提示出其他的 `\mathscr` `\mathbf` 之类的同是表示字体语法，现在完全不智能好像是固定的了」

`scripts/acceptance/probe-cands.cjs`（真产物，逐个前缀量）：

| 键入 | 修前候选 | 说明 |
| --- | --- | --- |
| `\` | 12 条 | 常用命令 ✓ |
| `\m` | 5 条 | |
| `\math` | 4 条 | |
| **`\mathbb`** | **1 条**（只有它自己） | 旧实现按"键名前缀精确匹配"筛 |
| **`\frac`** | **1 条** | 同上 |
| `\su` / `\alp` | 各 1 条 | 同上 |

所以"固定且少"是真的：只要你把命令名打到接近完整，候选就只剩它自己一条——同族兄弟（`\mathscr`/`\mathbf`）**根本没有机会出现**。

## 二 修法（`render/js/completion-sources.js`）

1. **命令表加分组**（字体 / 大运算符 / 希腊字母 / 关系符 / 箭头 / 括号与省略号 / 重音与上下括号 / 间距 / 分式与根式 / 矩阵与环境 / 集合与逻辑 / 函数名 / 微积分符号），条目 42 → 215 条。
2. **同类补全**：前缀命中不足 **4** 条时，取这次最匹配那条所在分组，把同组其余命令按表内顺序补进来（补到 **12** 条为止）；命中已经很多时一条不补 —— 这就是"个数自适应"。同类条目在说明里标注 `· 同一类（字体）`。
3. **表序仍然按常用度排**：前 12 条与旧版逐条一致（`\frac` → `\sqrt` → `\sum` → `\int` → `\lim` → `\partial` → `\nabla` → `\infty` → `\alpha` → …），所以"只敲一个 `\`"的画面没有变化。

修后（同一探针）：

```
\        → \frac \sqrt \sum \int \lim \partial \nabla \infty \alpha \beta \gamma \delta   （与旧版一致）
\m       → \mu \mathbb \mathbf \mathcal \mathrm …（前缀命中，不堆同族）
\mathbb  → \mathbb + \mathbf \mathcal \mathrm \text \mathscr \mathfrak \mathsf \mathtt \mathit \boldsymbol \mathnormal（标"同一类（字体）"）
\frac    → \frac + \sqrt \dfrac \tfrac \cfrac（"同一类（分式与根式）"）
\sum     → \sum \sup \succ \subset …（前缀命中）+ 同族大运算符补齐到 12 条
\alpha   → \alpha + 整族希腊字母
```

**回归门**：`scripts/acceptance/scenarios/90-math-command-family-2.1.17.cjs`（11/11 断言，6 证人）——
`\mathbb` 必须带出 5 个指定同族且条数 ≥6、说明里 ≥4 条标出"同一类"、`\frac`/`\sum` 各自的同族、
只敲 `\` 时前四条仍是 `\frac,\sqrt,\sum,\int`、`\m` 时**不出现**同类填充（个数自适应）、
以及**功能自证**：从同类候选里选中一条按 Tab，公式源码里真的出现该命令。
A/B（关掉同类补全）：6 条断言变红。

## 三 你问的"是否依赖过 AI API"

**没有。公式模板补全一直是离线的。**

- 候选来自 `render/js/completion-sources.js` 里**写在代码中的静态表** + 本地字符串匹配（前缀、说明、同类），整个过程没有任何网络调用；
- `render/js/completion.js` 的 `request()`：`if (!aiOnly && config.local) { items = [...localCandidates(...), ...anchoredCandidates()]; showItems(); }` —— 面板在**任何**宿主/AI 往返之前就画好了，本地候选不等任何异步结果；
- `completion-policy.mjs` 开头就写着这条口径：*"Pure local policy shared by the Webview and host. **No model call** is used to decide whether to request a completion or to classify the editing context."*；
- `#` 标题候选也是本地（读大纲 DOM）。

唯一联网的是**另一个可选功能**：AI 续写/公式续写（灰字 ghost text）。它有三道门槛
`config.apiAvailable && config.ai && config.automaticAI`，`config.ai` 需要你自己填 API Key；
公开/无 API 版（`build-flavor.mjs` 里 `API_ENABLED = false`）那段代码路径整块不存在。
VSIX 宿主里另有一条 `vscode.executeCompletionItemProvider`（问 **IDE 自己**的补全提供者，用于路径/符号），
公式上下文里只在**手动**触发时才走它，我们这边不发网络请求。

## 四 回归与交付

| 项目 | 结果 |
| --- | --- |
| `test:completion`（含"公式本地补全在断网/AI 失败时仍然可用"两条） | 0 断言错误 |
| `test:renderer` | 354 通过 / 0 失败 |
| `test:math-history` | 8 通过 / 0 失败 |
| `test:media` | 0 失败 |
| 新增场景 90 | 11/11（A/B 有牙） |
| 全量 dev / installed 验收 | 见交付记录 |

> 记一笔：`test:math-caret` 有一条**与这一版无关的偶发**——在受保护素材的副本上，"点公式正中 + 退格"
> 那一条偶尔会把 `\Leftrightarrow` 的反斜杠删掉（这是 2.1.13 就有的"命令字形落在反斜杠之后"语义，
> 你 ② 要的就是它；测试只容忍"零改动"或"行尾变短"）。当天 4 次里红 1 次，其余 3 次 58/58 全绿。

## 五 请你手验

在公式里敲 `\mathbb`（以及 `\frac`、`\sum`、`\alpha`）→ 候选里应当同时出现同族命令（带「· 同一类（…）」标注）；
敲一个 `\` → 仍是那 12 条常用命令、顺序照旧；上下键选一条按 Tab → 命令插进公式源码。
