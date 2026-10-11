# MarkPilot 推广/上架工具包（DISCOVERY KIT）

> 一句话：**用户搜不到你，产品再好也白搭。** 这份文件把"能被搜到"的每一步写成可直接粘贴的物料：
> 商店上架、winget、替代品目录、社区发帖，以及各自的账号前置。
>
> 配套资产：`dist/winget-2.0.18/`（已通过 `winget validate` 的清单）、
> `docs/screenshots/*`（仓库内已上传的明亮宋体截图）、
> `Typora-Editor/dist/markpilot-2.0.18.vsix`（含商店用清单字段的成品）。
> 抓图脚本：`scripts/shots-probability.cjs`（排版/透明度）、`scripts/shots-mapping.cjs`（公式映射，
> 严格断言"光标落在被点符号的源码上"）。

---

## 0. 现状与优先级（2026-09-11）

| 通道 | 现状 | 影响 |
|---|---|---|
| GitHub 仓库描述 + 20 topics + 英文 README + 截图 | ✅ 已完成 | GitHub 站内搜索的权重大头 |
| GitHub Releases（v2.0.18 三个资产） | ✅ 已完成 | 下载入口 |
| 插件商店（VS Code Marketplace / Open VSX） | ❌ **未上架** | **最大缺口**：VS Code/Trae 里搜 "markdown" 永远搜不到你 |
| winget | 清单已就绪并校验通过，未提 PR | Windows 用户 `winget install` 能装 |
| 替代品目录 / 社区 | 未做 | 搜"Typora alternative"的人的第一站 |

**优先级：商店上架 > winget > AlternativeTo/清单 PR > 社区发帖。**

---

## 1. 插件商店上架（最大缺口）

### 1.1 要发的文件

`Typora-Editor/dist/markpilot-2.0.18.vsix`（publisher = `jinxi`），已包含商店搜索用字段：
- `keywords`（22 个：markdown / typora alternative / wysiwyg / latex / katex / mermaid / ai completion …）
- `categories`（Notebooks / Formatters / Other）
- `displayName`（含 "AI Markdown Editor (Typora alternative)"）、双语 `description`
- `icon.png`（128×128+）、`galleryBanner`、`repository` / `homepage` / `bugs`
- 详情页正文 = `extension-src/README.md`（英文优先 + 中文说明 + 6 张明亮截图）

> 想换发布者名（比如你自己的品牌名）就改 `extension-src/package.json` 的 `publisher` 后重新打包
> ——`pack.py` 会自动同步清单里的 Publisher/Version。**发布者名一旦上架就别再改**（改名等于换一个扩展）。

### 1.2 Open VSX（免费、无付费账号；Trae 等基于它的 IDE 直接可见）

```bash
# 1) 注册并创建命名空间（浏览器，GITHUB 或 ECLIPSE 账号登录）
#    https://open-vsx.org/  →  User Settings  →  Access Tokens  →  生成 token
#    命名空间必须与 package.json 的 publisher 一致：jinxi
npx ovsx create-namespace -n jinxi -p <OPEN_VSX_TOKEN>
# 2) 发布
npx ovsx publish "E:/MarkPilot/Typora-Editor/dist/markpilot-2.0.18.vsix" -p <OPEN_VSX_TOKEN>
# 3) 核对
npx ovsx verify-pat markpilot -p <OPEN_VSX_TOKEN>
```
上架后页面：`https://open-vsx.org/extension/jinxi/markpilot`

### 1.3 VS Code Marketplace（曝光最大，一键安装）

前置（一次性，浏览器）：
1. 建 Azure DevOps 组织：`https://dev.azure.com/<你的组织>`；
2. 建 Personal Access Token：Scope 选 **Marketplace → Manage**；
3. 建发布者：`https://marketplace.visualstudio.com/manage` → Create publisher，
   **Publisher ID 必须填 `jinxi`**（与 package.json 一致）。

```bash
npx @vscode/vsce login markpilot        # 粘贴 PAT
npx @vscode/vsce publish --packagePath "E:/MarkPilot/Typora-Editor/dist/markpilot-2.0.18.vsix"
```
上架后页面：`https://marketplace.visualstudio.com/items?itemName=jinxi.markpilot`

> 首次上架会有人工/自动检查（几分钟到几小时）。若被问"为什么开源仓库里没有源码"，
> 用第 4 节的授权口径回复：**程序与插件本体免费，完整源码为付费授权**。

### 1.4 商店文案（可直接粘贴）

**Short description（≤135 字符）**
```
AI-native Markdown editor in your IDE: inline AI completion, click-to-edit math, large-file speed and print-quality typography. A free Typora alternative.
```

**中文一句话**
```
装进 VS Code / Trae 的 AI 原生 Markdown 编辑器：行内 AI 补全、公式点符号即定位源码、印刷级中文排版，免费替代 Typora。
```

**Tags（市场标签，逗号分隔）**
```
markdown, markdown editor, typora, typora alternative, wysiwyg, live preview, ai, autocomplete, math, latex, katex, mermaid, outline, notes, writing, docx, cjk, typography, productivity
```

---

## 2. winget（Windows 用户的主入口之一）

清单已写好并通过本地校验：`dist/winget-2.0.18/`（三个 yaml）。
- `PackageIdentifier: MarkPilot.MarkPilot`（与官方 `Typora.Typora` 同构；**上架后不能再改 id**）
- `InstallerType: nullsoft`、`Scope: user`、静默开关 `/S`
- `InstallerSha256` 已填 v2.0.18 安装包的真实哈希

### 提交 PR（一次性，之后每个版本重复）

```bash
# 1) fork + clone
gh repo fork microsoft/winget-pkgs --clone --remote
cd winget-pkgs
# 2) 放到约定路径：manifests/<首字母>/<Publisher>/<Package>/<Version>/
mkdir -p manifests/m/MarkPilot/MarkPilot/2.0.18
cp <本仓>/dist/winget-2.0.18/*.yaml manifests/m/MarkPilot/MarkPilot/2.0.18/
# 3) 本地校验（本机已装 winget 1.29）
winget validate --manifest manifests/m/MarkPilot/MarkPilot/2.0.18
# 4) 提交并开 PR
git checkout -b markpilot-2.0.18
git add manifests/m/MarkPilot/MarkPilot/2.0.18 && git commit -m "New package: MarkPilot.MarkPilot version 2.0.18"
git push -u origin markpilot-2.0.18
gh pr create --repo microsoft/winget-pkgs --title "New package: MarkPilot.MarkPilot version 2.0.18" --body-file <本仓>/docs/winget-pr-body.md
```

**PR 正文文案**（存成 `docs/winget-pr-body.md` 即可直接引用）

```markdown
## New package: MarkPilot.MarkPilot 2.0.18

- **Publisher:** MarkPilot (independent developer, `ltmroberthk915` on GitHub)
- **Product:** AI-native Markdown editor for Windows — a free Typora alternative with inline AI
  completion, click-to-edit math, large-file performance and print-quality CJK typography.
- **Installer:** `markpilot-Setup-2.0.18.exe` (NSIS, electron-builder), released at
  https://github.com/ltmroberthk915/markpilot/releases/tag/v2.0.18
- **License:** Freeware (app and extension are free; the editing-core source is licensed separately)
- **Validation:** `winget validate --manifest` passes locally; silent install (`/S`) verified.
- **Scope:** user (per-user install, no admin required).

I am the author of the package. Thanks for reviewing!
```

> 上架后用户可以：`winget install MarkPilot.MarkPilot`（首次合并后 1–2 天生效）。

---

## 3. 替代品目录与清单（搜 "Typora alternative" 的人第一站）

### 3.1 AlternativeTo（免费提交，流量精准）

- 提交地址：`https://alternativeto.net/manage/`（需账号）
- **Name**：`MarkPilot`
- **Tagline（≤100 字符）**：
  `Free AI-native Markdown editor with inline AI completion, click-to-edit math and print-quality typography.`
- **Description**：
```
MarkPilot is a Markdown editor for people who write Markdown every day.

• Inline AI completion with two engines: a cloud model (Zhipu GLM / DeepSeek presets — bring your own
  key) plus a local rule engine for formulas, templates and paths that works offline.
• Formulas you can click into: click any symbol in a rendered formula and the caret lands exactly on
  the source that produced it — inside table cells and nested blocks too.
• Large documents stay smooth: chunked rendering plus source-cache reuse keeps 200,000-character
  documents responsive (CPU cost per edit down 57–87% in internal benchmarks).
• Print-quality typography: CJK/Latin automatic spacing, serif themes, optimal (Knuth–Plass) line
  breaking on export.
• Two shapes, one core: a native Windows desktop app (installer or portable) and an editor extension
  for VS Code and Trae.
• Exports to Word / Excel / PowerPoint with formulas as editable OMML — no Pandoc required.

Windows · free · portable build available. Local-first: your API key stays in local encrypted storage.
```
- **Alternatives to**：`Typora`（主要）、`Obsidian`、`MarkText`、`Zettlr`、`iA Writer`
- **Platforms**：Windows、VS Code、Trae ｜ **License**：Freeware ｜ **Price**：Free
- **Tags**：markdown-editor、ai、writing、notes、latex
- **Link**：`https://github.com/ltmroberthk915/markpilot`

### 3.2 awesome-list PR（一条条目，长期引流）

按各清单的字母序插入下面这一行（英文），并在 PR 里说明你**就是作者**：

```markdown
- [MarkPilot](https://github.com/ltmroberthk915/markpilot) - Free AI-native Markdown editor (Windows + VS Code/Trae) with inline AI completion, click-to-edit math and print-quality CJK typography. Alternative to Typora.
```

可提的清单（按命中率排序）：
1. `mundimark/awesome-markdown`（Editors 段）
2. `viatsko/awesome-vscode`（Markdown 段）
3. `sindresorhus/awesome-electron`（Apps 段）
4. `awesome-selfhosted`：**不适合**（你这是桌面应用）
5. `jaywcjlove/awesome-mac`：不适用（无 macOS 版）；如以后出 macOS 版再提

PR 标题与正文模板：
```markdown
Title: Add MarkPilot (AI-native Markdown editor, free Typora alternative)

Body:
Hi! I'm the author of MarkPilot, a free (freeware) Markdown editor for Windows that also ships as a
VS Code/Trae extension. Distinctive bits: inline AI completion with a local fallback engine,
click-a-symbol-to-edit-its-source math editing (works inside table cells), and print-quality
CJK typography. Portable build included, local-first (keys never leave the machine).
Repo: https://github.com/ltmroberthk915/markpilot
Happy to adjust wording/placement to match the list's conventions — thanks!
```

### 3.3 社区发帖文案

**Show HN（标题 + 首段）**
```
Show HN: MarkPilot – a free, AI-native Markdown editor that also runs inside VS Code

Hi HN — I write Markdown every day for math-heavy notes, and I kept hitting two walls: editors that
render math nicely but won't let you edit it once rendered, and AI autocomplete that doesn't notice
you're inside a formula. MarkPilot is my attempt at both.

Three things I'd especially like feedback on:
1. Click any symbol in a rendered formula and the caret lands exactly on the source that produced it
   (screenshots in the README; it also works inside table cells).
2. Inline completion with a local rule engine fallback, so it's useful offline / with no API key.
3. Typography: automatic CJK/Latin spacing and optimal line breaking on export.

Windows installer + portable, and a VSIX for VS Code/Trae. Free to use; the editing-core source is a
separate paid license. I'd love to hear what breaks first for you.
https://github.com/ltmroberthk915/markpilot
```

**Product Hunt**
```
Tagline: The Markdown editor that finishes your sentence — and lets you click into the math.
Description: (用 3.1 的 Description 精简到 260 字符)
First comment: 讲"为什么做"——为写数学笔记的人做的编辑器：公式渲染后仍可编辑、AI 补全认得公式环境、
中文排版按印刷标准做。
```

**Reddit（r/Markdown / r/LaTeX / r/vscode，一天最多发一个社区，注意各版规则）**
```
Title: I built a free Markdown editor where you can click a symbol in a rendered formula and the caret
jumps to that exact spot in the source

Body: (讲 2–3 个具体体验 + 两张截图直链) + 下载在 GitHub Releases，Windows 安装版/便携版，
VS Code/Trae 有插件。
```

**中文社区（少数派 / V2EX / 知乎）**
```
标题：把公式做成可点击编辑的对象：一个 AI 原生 Markdown 编辑器（免费，含 Windows 版与 VS Code 插件）

要点：① 点公式里的任意符号，光标就落在生成它的源码处（表格单元格、嵌套都不丢）
② 行内 AI 补全双引擎（智谱 GLM / DeepSeek 预设 + 本地规则，断网也能补）
③ 印刷级中文排版：中西文自动间距、宋体双主题、导出用 Knuth–Plass 整段最优断行
④ 界面弹窗与工具条透明度可调；二十万字文档保持流畅
```

---

## 4. 常见问题的统一口径（上架/发帖都会遇到）

| 会被问到 | 回答 |
|---|---|
| 开源吗？ | 程序与插件本体**免费**（个人与商业使用均免费）；**完整源码为付费授权**，用于二次开发/魔改。仓库 Issues 联系。 |
| 为什么仓库里没有源码？ | 同上。仓库提供发布物、文档与问题反馈；源码另行授权。 |
| 会收集我的数据吗？ | 本地优先：编辑/渲染/导出全在本机；AI 补全只在你触发时直连你选的模型服务商，Key 存本机加密存储。 |
| 支持 macOS/Linux 吗？ | 目前是 Windows 桌面版 + VS Code/Trae 插件（插件在任何能跑 VS Code 的系统上可用）。 |
| 公式为什么能点？ | 渲染结果与源码之间维护了符号级映射（KaTeX 节点带源码偏移），点击按几何命中最近符号。 |

---

## 5. 每次发版后的固定动作（清单）

1. 出包 → `node scripts/dist-fresh.cjs`；安装 + `npm run accept`（12 场景）
2. VSIX → `pack.py` → `scripts/verify-vsix-chain.cjs`（四方链）
3. GitHub Release → `scripts/publish-github.cjs`（Bug 修复列最后）+ `--readme-append`
4. 商店 → `npx ovsx publish` / `npx @vscode/vsce publish --packagePath`（版本号会自动带上）
5. winget → 复制 `dist/winget-<ver>/` 到 fork 并开 PR
6. 更新 README 里的下载/截图（如界面有变化，用 `scripts/shots-probability.cjs` 重拍）
7. 需要时更新 AlternativeTo 描述与截图
