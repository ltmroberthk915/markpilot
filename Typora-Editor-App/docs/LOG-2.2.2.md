# LOG-2.2.2：纵向移动的目标列 + 块公式的拖拽选中 + 宋体主题斜体字号

这一轮是 2.2.1 实装到本机之后用户当场试出来的三条手感问题 + 一条主题微调。
来源都是"装完就用"，所以下面每条都带**独立复现读数**（探针 `scripts/acceptance/probe-vertical-roundtrip.cjs`
的 A–F 六组）与**突变验证**（把修复注掉，新场景 110 变红）。

## 一 用户报告

1. "上方向键移动的时候还是会跳过 inline math 跑到更前一行"；
2. "上键移动后再下键回来, 光标位置首位不闭合, 逻辑混乱"；
3. "光标/长按 shift 键+方向键拖拽选中 block math 仍然失败 交互有问题"；
4. "宋体-明 宋体-暗 的 斜体楷体字号, 稍微大一点点再"。

## 二 复现与根因

### 2.1 纵向：目标列被"展开态公式"吃掉了（对应 1、2）

2.2.1 的做法是"只在原生结果确实跳过了纯公式行时补一次"，落点是"离当前光标列最近的字符"。
问题在于**光标一旦进了公式源码，列的含义就变了**：

| 读数（probe-vertical-roundtrip A，起点=纯公式行下一段的列 0） | 2.2.1 | 2.2.2 |
| --- | --- | --- |
| ↑ 进公式行 | 块2 源码（展开） | 块2 源码（展开） |
| ↓ 回来 | 块3 **列 2**（漂了） | 块3 **列 0**（与出发一致） |
| 再 ↑ ↓ 一次 | 继续漂 | 仍然列 0 |

根因：从公式里出来的那一下走的是浏览器/Vditor 的原生纵向移动，而"展开态公式"那一行的几何
与折叠态不同（源码行顶上来、预览浮走），算出来的落点既丢列、也可能少算一行——用户描述的
"跑到更前一行"与"回来位置对不上"是同一个机制的两面。

### 2.2 块公式的选中：拖拽整块跳过（对应 3）

`math-select-reveal.js` 从第一版起就**只认行内公式**（注释写明"块公式…这一版不碰它"）。
实测（probe F）：从上一段末尾拖到下一段，选区只剩 `"\n下段"`——块公式的源码一个字没进来，
块也没挂选中类、源码没翻出来。Shift+→ 走键盘路径能进块（实测 7 字符，含 `$$\na+b`），
所以用户说的"失败"主要是**鼠标拖拽**这一路。

## 三 修法

### 3.1 纵向：目标列（goalX）+ 从公式源码里出去的接管

- 连续按 ↑/↓ 期间保持**目标列**（第一次按下的那一列），别的按键（打字、左右移动）结束这一轮；
- 光标在公式源码里时，出去的这一下由我们接管：目标 = 相邻的**可见块**（`neighbourBlock`），
  落点 = `caretRangeFromPoint(goalX, 该块中线)`；落不进（整块就是一条公式之类）就退到该块
  第一处文字。**不再让浏览器在展开态几何上算落点。**
- 原生的"跳过纯公式行"补正保留（作为兜底），落点也改用 goalX。

### 3.2 块公式的选中：三处小修，缺一不可

1. `hostOf` 收进 `data-type="math-block"`（`index.css` 里块公式的 REVEAL 规则早就写好了，缺的只是 JS 不给挂）；
2. 拖拽结束时把**夹在按下点与松手点之间的块公式**整条并进选区（`skippedBlocks` 按几何 + "源码是否已在选区里"判定，`includeBlocks` 把端点吸到源码两端并挂 REVEAL）；
   · 这一步要**推迟一拍**（`setTimeout 0`）：浏览器自己的 mouseup 选区处理跑在我们的捕获监听之后，当场设进去的选区会被它盖掉（实测：建好的 11 字符选区 700ms 后又缩回 `\n下段`，且过程中没有任何 Selection API 调用）；
   · 挂 REVEAL 之后要**先逼一次布局**（读一次 `getBoundingClientRect`）再设端点：Chromium 样式惰性计算，同一拍里 `code` 还是 `display:none`，那一刻设进去的端点会被判无效；
3. 收回逻辑（`sync` 的 keep 集）除了"端点所在的 owner"，还要保住**源码被选区盖住**的那些块——块公式的选区端点落在它前后的正文里，只看端点会在选区刚建好的一瞬间把源码收掉，源码一收、浏览器随即把选区收窄，回到原点。

### 3.3 主题：斜体（中文走楷体）字号 +6%

`typora-themes/宋体-朙.css`、`宋体-暗.css` 的 `#write em/i/cite` 规则加 `font-size: 1.06em`。
理由写在 CSS 注释里：楷体字面比宋体略小略轻，同字号看上去"缩"了一圈，斜体中文正好走楷体。
用户要求是"稍微大一点点"，1.06 是保守的一档（不够再调这一个数即可）。

## 四 验证

- **新场景 `110-vertical-column-and-block-select.cjs`**（11 条断言、5 条证人：几何 + 磁盘）：
  ① ↑ 进纯公式行（源码形态）；② ↓ 回来列与出发一致（±3px）且再往返一次仍一致；
  ③ 从公式源码里 ↑ 出去落在**紧邻**的上一段（不跳行）；④ 拖拽跨过块公式后选区含
  `a+b=1`、块挂选中类且源码宽高 > 10×8、松手一秒后选区仍在；全程磁盘逐字节未改。
- **突变验证**：把"从公式源码里出去的接管"与"块公式并入选区"两处注掉 → `6/11`，
  红的正是 ②（列 46 → 74，与用户描述一致）与 ④ 的三条（选区退回 `"\n下段"`）。
  恢复用备份 + `sha256sum -c` 逐字节校验，`ABLATED` 残留计数 0。
- **回归**：110 + 81/83/85/91/92/94/107/74/75/109（公式光标/选中/围栏口径）
  + 20/50/76/79/80/86/88/89/90/93/95（复制、右键、日常操作、拖拽抖动、工具栏等）全绿。
- **没能独立复现的一条**：用户 ① 的"跳过 inline math 跑到更前一行"在实验室里没单独复现出来
  ——它大概率就是 2.1 那条"从展开态公式里出来"的同一机制（新口径下出去那一步永远落到紧邻
  的那一块，跳过不再可能发生）。110 的 ③ 断言把"必须落到紧邻块"这条契约钉住了，
  但它在注掉修复的那一版里也过——如实记在这里，不当作已证。

## 五 交付

- 版本号两仓 + `vsix-meta/extension.vsixmanifest` → **2.2.2**；VSIX 与 EXE 同版本产出，
  四方哈希链 `verified=true`；静默安装到本机（`%LOCALAPPDATA%\Programs\MarkPilot`，
  本机落到 D 盘镜像路径）后，安装副本的 `app.asar` sha256 与交付目录逐字节一致。
- 产物与哈希见 `docs/RELEASE-2.2.2.md` 与本文件末尾的交付读数（下文"六"）。
- 未推远端、未上架；编辑器的 VSIX（VS Code / Trae）**没有动**——用户中途说"停吧"，
  这一轮只做代码与桌面端。

## 五·补 上架与实装（2026-09-18，用户令"做完之后上传提交"）

| 渠道 | 状态 | 证据 |
| --- | --- | --- |
| **Open VSX** | **已发布 2.2.2** | `node scripts/publish-store-userenv.cjs --only=ovsx`（令牌只从 `HKCU\Environment` 读、全程不打印）→ 上传成功；精确版本端点回读 2.2.2；下载线上包 **6,466,336 字节、sha256 `0cf8517709b19a6f…` 与交付包逐字节相同**。注：`latest` 别名与首页仍有 CDN 延迟（与 2.1.28/2.1.29 两版同样的现象），按既有做法用"精确版本 + 重复发布双重确认"核验。 |
| **VS Code Marketplace** | **未完成：卡在登录** | 线上清单存在：`jinxi.markpilot`（发布者 Jinxi，当前线上版本 **2.1.29**，7 次安装）。上传新版本必须在 `marketplace.visualstudio.com/manage` 登录后操作，而本机 **Chrome 浏览器桥没有连上**（`agent.browsers.list()` 只广告了 ZCode 内嵌浏览器），内嵌浏览器是独立配置、没有市场登录态。按纪律不代登录、也不静默换成内嵌浏览器去顶用户的身份。 |
| 本机 VS Code | 已 sideload `jinxi.markpilot-2.2.2` | `node scripts/install-vsix.cjs Typora-Editor/dist/markpilot-2.2.2.vsix` → 目录 `C:\Users\ltmroberthk\.vscode\extensions\jinxi.markpilot-2.2.2`（重启 IDE 生效） |
| 本机 Trae | 已 sideload `jinxi.markpilot-2.2.2` | 同上（Trae 当时未运行，安装器按既有策略放行） |

解除 Marketplace 那一格的两种办法（任选其一，我这边都是一条命令的事）：
1. 把 Chrome 桥连上（Chrome 打开 + ZCode 的浏览器扩展就位），我直接在浏览器里登录后的会话上点 Update；
   我已经把登录页开在内嵌浏览器里，你登完我接着上传也行。
2. 设一个 `VSCE_PAT`（`setx VSCE_PAT "<Azure DevOps PAT>"`，用户级环境变量，仓库里不留值），
   我跑 `node scripts/publish-store-userenv.cjs --only=vsce` 走命令行发布。

## 六 交付读数（2026-09-18）

交付目录 `E:\MarkPilot\Typora-Editor-App\dist\release-2.2.2-private\`：

| 产物 | 字节 | sha256 |
| --- | --- | --- |
| `markpilot-Setup-2.2.2.exe` | 116,398,543 | `8508139dbeda0d763a0be0b888cd386fa74ae3ea98b2c099a948c0826228b77c` |
| `markpilot-v2.2.2-portable.exe` | 116,171,462 | `f87136f856d16ef3f22a5a734546645a1c99272d07e3c6b7e1f30d92525659e9` |
| `markpilot-2.2.2.vsix` | 6,466,336 | `0cf8517709b19a6fa922f3554d2ffe941cd70fcdb3491ac7ef53c9ea898d6baa` |
| `win-unpacked/resources/app.asar` | 23,775,385 | `42d30fc3ea82f471bc9053afde2ffef219a3e37d6a3e941e317f9cf1df6fb125` |

- `sha256sum -c SHA256SUMS.txt`：四项全 OK。
- `scripts/verify-chain.cjs dist/release-2.2.2-private dist/release-2.2.2-private/markpilot-2.2.2.vsix .perf/release100-verify-2.2.2`
  → **verified=true**（①499 ②499 ③499 ④36 文件逐字节相同；两仓与 VSIX 内 package.json、vsixmanifest 均 2.2.2）。
- 静默安装到本机（`Start-Process … '/S' -Wait`，`LOCALAPPDATA` 指到本机真实目录
  `D:\Users\ltmroberthk\AppData\Local`）→ 已安装 `MarkPilot.exe` 的 `app.asar`
  sha256 = `42d30fc3…`，与交付目录**逐字节一致**；`--app=installed` 跑
  00-static-audit（审计对象即该 asar，版本 2.2.2）/110/109/100/74 全过。
- 未推远端、未上架；**编辑器扩展（VS Code / Trae）本轮没有动**（用户中途叫停）。
