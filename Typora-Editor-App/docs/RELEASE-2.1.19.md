# MarkPilot 2.1.19 发布说明（私版）

你那句"算法不好、去查成熟方案"是对的。我把排序策略整个重做了，并且用**你截图里那行的形状**做了回归门。

## 一 你截图里的病根（两处，都量到了）

截图候选：`\int`、`\mathbb`、`\mathbf`、`\in`、`\frac`、`\sqrt`。

旧打分是 `完全命中 +10 / 公式里出现过 +3`，而"出现过"这一项**对所有条目生效**：

1. 你那行里已经有 `\int` 和 `\mathbf` → `\int` 拿 +3，**`\in` 也拿 +3**（旧实现用字符串包含判断，
   `\in` 正是 `\int` 的子串）→ 这两条被顶到了按常用度排在前面的命令之上；
2. 同族补全的触发条件写错了（把模糊命中也算作"已经够了"）→ 敲 `\frac` 时 `\sqrt` 会消失。

## 二 查到的成熟做法（策略依据）

VS Code 的补全排序模型：**匹配质量决定次序**，`sortText` / 声明顺序只用于初始排序、只在"匹配得一样好"时打破平局；
匹配分里对**词首命中**与**连续命中**加成、对跨度扣分（`base/common/filters.js` 的 `fuzzyScore`，
`vscode.d.ts` 里 `sortText` 的说明；gopls/clangd 用 `filterText` 让"自己的次序"生效也是同一层意思）。

## 三 新策略（分档，越小越靠前）

| 档 | 含义 | 效果 |
| --- | --- | --- |
| 0 | **完全命中**命令名 | 敲 `\mathbb` → `\mathbb` 第一 |
| 1 | **前缀命中**（同档内按"键入部分占命令名的比例"降序） | 敲 `\math` → `\mathbb`/`\mathbf` 先于 `\mathcal` |
| 2 | **同族兄弟**（插在强命中之后、弱命中之前；同族内按"与命中那条的最长公共前缀"降序） | `\mathbb` → **`\mathbf`**（公共前缀 `mathb`）→ `\mathcal`、**`\mathscr`**、`\mathfrak`… |
| 3 | 说明（中文）命中 | 备用档（当前上下文只产出 `\`+ASCII 的 token） |
| 4 | 子序列**模糊命中**（词首/连续加成、跨度扣分；只对 ≥2 字符开） | 敲 `\lr` → `\leftrightarrow`、`\Leftrightarrow` |

同档内次序：**本文档公式里已用过**（精确 token，只作同级次级键）→ 表内声明顺序（表是按常用度人工排过的）。
另外把 `\text` 从"字体"组挪到独立的"文字"组（它是文字排版，不是数学字母表），
这样 `\mathbb` 的同族顺序正好把 `\mathbf`、`\mathscr` 顶到前面。

## 四 现在的实际次序（单元探针 `probe-cands-unit.mjs`，在**含 `\int` 的公式上下文**里量）

```
\        → \frac \sqrt \sum \int \lim \partial \nabla \infty \alpha \beta \gamma \delta
\mathbb  → \mathbb  \mathbf  \mathcal  \mathrm  \mathscr  \mathfrak  \mathsf  \mathtt
           \mathit  \mathnormal  \boldsymbol  \operatorname
\frac    → \frac \sqrt \dfrac \tfrac \cfrac
\lr      → \lbrace \lor \lvert \lVert \leftrightarrow \Leftrightarrow …
```

## 五 回归门（场景 90 重写，13/13 断言 + A/B）

fixture 直接用你截图那行的形状 `\mathbb{E}_{\mathbb{P}}[\mathbf{1}_{E}]=\int_0^1 f`：

- 在这个公式里敲 `\mathbb`：首条 `\mathbb`、**第二条 `\mathbf`**、前六条里出现 `\mathscr`/`\mathcal`/`\mathfrak`、
  且**前六条不许混进与字体无关的命令**（这条就是治截图那三行的）、同族字体命令 ≥5 条；
- 同一公式里敲 `\`：前四条仍是 `\frac,\sqrt,\sum,\int`；
- 敲 `\frac`：`\sqrt` 在前三、`\dfrac`/`\tfrac`/`\cfrac` 都在；
- 敲 `\m`：候选全是 `\m` 开头（不做同族填充）；
- 功能自证：选第二条按 Tab，源码里真的出现该命令。

**A/B**：关掉同族补全 → 13 条里红 5 条（含 ① 的 `\mathbf`、③ 的 `\sqrt`）。

## 六 交付与回归

`desktop-completion` 0 断言错误、`test:renderer` 354/0、`test:math-history` 8/0、场景 90 = 13/13。

```
markpilot-Setup-2.1.19.exe     6fdc3ac1795238bc157c01deb0781189441a131f5c0c67ec208ced1c38a67ae8
markpilot-v2.1.19-portable.exe 4ee08322956f091b75ee8b43f6d305f474d210c67f7f7ea1b86b229ebcd87de6
markpilot-2.1.19.vsix          2b9c04c1a936b9a9fad9b906429b88b5543c41c786c80350be328fe7ceca6fbe
app.asar（安装后实测）           311e430fa24c8c177ee2a628f6409e71eef3c07576fe2923a51f4228ee2658fa
```

`verify-vsix-chain`：`verified: true`。EXE 与 VSIX 都已装到本机（Trae / VS Code 2.1.19）。

**这一版我没有跑"装后全量验收"**——你正在这台机器上手测，上一轮就是我在你手测期间跑验收导致窗口反复弹出；
按你的要求先不动 GUI，等你说机器空下来我再补跑（场景级门已经在开发树上全绿）。

## 七 请你手验

在**已经写着** `\mathbb`/`\mathbf`/`\int` 的那种公式里：

1. 敲 `\` → 候选应当还是 `\frac`、`\sqrt`、`\sum`、`\int`… 的常用次序（不再被 `\int`/`\in` 顶乱）；
2. 敲 `\mathbb` → 第二条就是 `\mathbf`，接着 `\mathcal`、`\mathrm`、`\mathscr`、`\mathfrak`…，
   前几条**不该**混进与字体无关的命令；
3. 敲 `\frac` → `\sqrt` 应当在前三。
