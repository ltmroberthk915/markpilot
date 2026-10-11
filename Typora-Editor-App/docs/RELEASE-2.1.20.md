# MarkPilot 2.1.20 发布说明（私版）

你这一条报得很准——"没有任何文字变动，只是点击就不要重新渲染"。查下来：**摘掉展开态的就是我们自己**，
不是 Vditor；而"只有鼠标点击才犯、键盘移动不犯"也正好对上了那个只在 press 期间生效的开关。

## 一 病根：一次点击里 `--expand` 被摘掉又装回来

取证脚本 `scripts/acceptance/probe-click-rerender.cjs`（逐帧 rAF 采样 + 给块公式节点挂 `classList`
代理抓调用栈 + 把 `innerHTML`/`appendChild`/KaTeX 计数全部钩住）。点一次（源码区或渲染区）的变动序列：

```
refreshMathEditing(render/js/math-edit.js) remove --expand   ← 我们自己摘的
Vditor B()  add --expand / remove --hidden                   ← 松手后 Vditor 又装回来
```

同一时刻的上下文读数：`{caret: TEXT@0, inMathCode: true, inOwner: true, pointer: true, hasFocus: true}`。
也就是说——**光标明明已经在公式源码里**，我们却把它判成"不该展开"。

原因在第 7 轮治拖拽抖动的那条规则：按下（`.typora-ir-pointer` 存在）期间 `blocked()` 把块公式挡在
`editing` 集合之外，于是收回循环（`math-edit.js` 里"该展开的展开、展开过的该收回"）把它收了。
按下与松开之间隔着若干帧，块盒高度 **145 → 119 → 145**（差的 26px 正是源码行那一条），
屏幕上就是"整块塌下去又弹回来"。

为什么"键盘移动不闪"：键盘不挂 `.typora-ir-pointer`，`blocked()` 不生效，收回循环这时不会碰它。
你两条观察合起来正好把范围锁死在这一个开关上。

顺带一个方法论上的坑（写进探针注释了）：自动点击如果像 CDP 那样把 `mousePressed` 与 `mouseReleased`
**连着发**，两帧之间没有间隔，一帧折叠态都采不到——"点一下会闪"在台面上直接消失。
本轮探针改成按下后**真的等 250ms** 再松开（人手点击的时序），闪烁立刻现形。

## 二 修法

`render/js/math-edit.js`：按下期间**冻结"按下那一刻已经展开的块公式"**。

- 冻结点在按下开始时**快照一次**（`pressFrozen`），所以无论光标是在按下瞬间就进了源码、还是等 Vditor 的
  click 处理器才挪进去，结果都一样；
- 冻结的语义是**不展开、也不收回**——第 7 轮的防抖规则（"别展开"）原样保留，只是把"收回"也一起停掉；
- 松手后 `.typora-ir-pointer` 摘掉，快照立刻失效，下一次 refresh 照常按"光标在不在公式里"收放。
  所以"光标走出公式就收回去"的正常语义一点没变（场景 91 的 D 组专门钉了这条口径）。

## 三 回归门：场景 91（逐帧采样，26 条断言）

`scripts/acceptance/scenarios/91-block-math-click-no-repaint-2.1.20.cjs`

- **主判据**：按住 250ms 的单击（源码区、渲染区各一次、源码区再来一次）期间**一帧折叠态都不许有**；
  块盒高度与 top **只有一个取值**；单击之后仍是展开态。
- **不重建**：KaTeX 重建计数 0、预渲染子树逐字节不变、**首个子节点还是原来那个节点**、preview 子节点变动 0、公式源码逐字节不变。
- **自证**：每轮都要求"采到 ≥8 帧、其中 ≥3 帧光标确实在这条公式里"，否则判失败（防"什么都没发生"的假通过）；
  每轮点击前**重新量几何**（展开会让源码行从 0×0 变成实体，上一轮的教训）。
- **独立证人**：真实文件落盘字节不变（等 1.5s 给自动保存一个窗口）。
- **对照 D**：键盘方向键（光标留在源码里）同样零折叠；口径写明"光标走出公式时收回去是应当的"。

**A/B**（把生成副本里的冻结关掉）：

```
node -e "const fs=require('fs');const f='app/renderer/js/math-edit.js';const t=fs.readFileSync(f,'utf8');
fs.writeFileSync(f,t.replace('const frozen=owner=>!!pressFrozen&&pressFrozen.owners.has(owner);','const frozen=owner=>false;'))"
```

| 版本 | 一次"源码区按住 250ms"的逐帧采样 |
| --- | --- |
| 关掉冻结 | 44 帧里 **15 帧折叠态**，块高取值 `[145, 119]` → 场景 91 变红 2 条 |
| 本版 | 44 帧里 **0 帧折叠态**，块高取值 `[145]` |

场景 91 连跑 4 次，每次 26/26。

## 四 回归

`test:renderer` 354/0、`test:math-caret` 58/0、`test:math-history` 8/0、`test:math-colors` 48/0、
`test:math` 8/0、`test:completion` 28/0；dev 上 11 个数学/媒体场景全绿（含第 7 轮的拖拽抖动门
`88-drag-over-block-math-no-jitter` 8/8、块公式点击映射 `85-block-math-click` 11/11）。

**这一版没有跑"装后全量验收"**：你正在手测，上一轮就是我在你手测期间跑全量导致窗口反复弹出。
按你的要求先不动 GUI，等你说机器空下来我再补跑那轮全量。

不过安装时你的 MarkPilot 已经关闭，我借这个窗口**对装好的 EXE 跑了本轮的新场景**
（`--app=installed`，一次启动 12 秒）：场景 91 = **26/26 断言、6 证人**。
即"闪不闪"这条判据是在**你机器上装着的那个产物**上量的，不是只在开发树上量的；
装完的 `app.asar` 与本次验证过的构建产物哈希也一致（见下表）。

## 五 产物（四方哈希链 `verified: true`）

```
markpilot-Setup-2.1.20.exe      b78b6bf8f6af34e135c97f71d2e0a8cb4eb05f6124b1d18178376ab585b2b3f0
markpilot-v2.1.20-portable.exe  6d46b15cde18b44932bcac68e3177ef4346b9b6038904594bb59c661fd80a656
markpilot-2.1.20.vsix           db4ac0f2ec5d8cf5210f1531c4991945e472f2399663b87ce933770acb5e5ca2
app.asar（安装后实测）            b9db2a8f4791d1c30e07b2278a7cfb5c853a633aa7234f2a5fb469aa817f900f
```

`verify-vsix-chain`：520 个扩展文件 + **497 个渲染层文件逐字节相同**，`verified: true`。
EXE 与 VSIX 都已装到本机（Trae 2.1.20、VS Code 2.1.20）。私版目录：
`dist/release-2.1.20-private/`（含 `SHA256SUMS.txt`）。

> 打包顺序上的一个坑（本轮又踩了一次，已按既有规矩修掉）：我在第一次打包**之后**顺手改了一处
> **注释**（把 `refreshMathEditing(math-edit.js:344)` 这个会失效的行号引用换成文字描述），
> 于是"源码 == 产物"当场不成立——`verify-vsix-chain` 的 497 文件逐字节比对就是为抓这个而设的。
> 处理方式：`sync` → 重新 `pack.py` → 重新 `dist:fresh` → 重新核链 → 重新安装 → 重做私版目录，
> 上表是**重打包之后**的哈希；重装后又对装好的 EXE 跑了一遍场景 91（26/26）。
> 规矩：**打包前把话说完**，打包后一个字都别动。

## 六 请你亲手验

1. 展开一条块公式（预渲染 + 源码都在），**按住鼠标左键在源码区停 1–2 秒再松开**——块公式应当纹丝不动，不塌不弹；
2. 同样按住停在**渲染区**上松开——同样纹丝不动；
3. 点完再去改公式里的字（键盘输入）——渲染区仍按原来的方式跟着变（这条本来是好的，确认没被带坏）。
