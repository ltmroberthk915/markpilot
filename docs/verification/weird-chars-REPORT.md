# weird-chars 族 · 第三波「真实用户操作」普查

**被测产物（固定并断言）**：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`
188 784 128 B **sha16 = 1b4e32a2263fcbe6**（探针启动即断言 `MP_EXPECT_EXE`，不符即 exit(9) 不出数）。
**探针**：`weird-chars-typing.cjs`（打字→存盘→光标→退格→复制→粘贴）、`weird-chars-load.cjs`（载入↔回写往返，含 BOM 变体），
共用尺子 `weird-chars-lib.cjs`（spawn + 随机端口 + 独立 `--user-data-dir` + `MP_DEBUG=1` + 删 `ELECTRON_RUN_AS_NODE` + `playwright-core connectOverCDP`）。
**用例数**：12 个载荷 × 10 条判据（输入／盘上／无 U+FFFD／左移次数／左移不改文档／退格单元数／可撤销／复制回读／粘贴逐码点／粘贴目标行）＝ **120**，
外加 4 条粘贴通道对照臂、载入链 6 组判据 ⇒ **约 130 条判据**，每条都带码点读数（`weird-chars-out/*/result.json`）。

载荷：Emoji ZWJ 家庭 `👨‍👩‍👧`／Emoji+肤色 `👍🏽`／星形平面代理对 `𝄞`(U+1D11E)／CJK 扩展 B `𠀀`(U+20000)／组合重音 `e`+U+0301／预组合 `é`(对照)／零宽空格 `a·b`／孤立 ZWJ `x·y`／软连字符 `so·ft`／阿拉伯文 `مرحبا`／泰文 `สวัสดี`／泰文基字+声调 `ก้`。

---

## 一、结论（先给结果）

**逐字节保真：12/12 全通过，零数据损坏。** 四条链都逐字节相等：

| 链 | 判据 | 结果 |
|---|---|---|
| 输入 | 文档片段码点 == 载荷码点 | 12/12 ✓（含 ZWJ 家族 8 单元、代理对 2 单元、组合重音 2 单元不被归一成 U+00E9） |
| 存盘 | 盘上该行**严格相等**、盘上无 U+FFFD、UTF-8 字节序列在盘上 | 12/12 ✓；盘上文本 == 引擎文档（r5：428 B，`盘上==引擎:true`） |
| 复制 | 装弹哨兵→独立 pwsh 回读→Ctrl+C→再回读，**严格相等**（含 copy 事件载荷原子读数） | 12/12 ✓（10 例精确选段；ZWSP/RTL 2 例改真三连击选整行，期望文本＝锚点行+`\n`，同样严格相等） |
| 粘贴 | 装弹自证→Ctrl+V→**定长插入严格等于载荷** + 目标行严格等于载荷 | 12/12 ✓（增量 = 载荷长度，无多字无少字） |
| 载入/回写 | 夹具→引擎==夹具；无改动 Ctrl+S 后**盘上 sha16 与夹具完全相同**；加 `Z` 后逐字节＝夹具+`Z`；Ctrl+Z 回写 sha16 复原；BOM 变体 | 6/6 ✓（400 B 夹具 sha16 `b0c1a9a700751035` 三态一致；BOM 夹具保存后仍是 `BOM+同字节`，引擎文档里不含 U+FEFF） |

## 二、没反应 / 行为不符预期的项（都带读数；**均无字节损坏**）

**W1 退格删的是「一个码点」，不是「一个字符」——与方向键口径不一致（4 例）**

| 载荷 | 退格前 | 退格后（码点） | 删掉单元/期望 |
|---|---|---|---|
| `e`+U+0301 | 锚点05：e◌́ | `U+951A U+70B9 U+0030 U+0035 U+FF1A U+0065` | **1/2**（只剩 `e`，重音符没了） |
| `👍🏽` | 锚点02：👍🏽 | …`U+FF1A U+1F44D` | **2/4**（只剩 👍，肤色修饰符没了） |
| `สวัสดี` | 锚点11：สวัสดี | …`U+0E2A U+0E27 U+0E31 U+0E2A U+0E14` | **1/2**（只剩 `สวัสด`） |
| `ก้` | 锚点12：ก้ | …`U+FF1A U+0E01` | **1/2**（只剩基字 `ก`） |

同一批载荷的**方向键**却是整簇口径：`e`+U+0301 一次左移穿过 2 单元（实测穿越=1/UAX#29 簇=1）、`👍🏽` 一次穿过 4 单元。
机制在**被测产物自带引擎**里可读（`MarkPilot-CM6/renderer/cm6/app.js`，@codemirror/commands 段）：
`var k3=(n,e,t)=>mc(n,… l = ln(o.text, i-o.from, e, e) …), wm = n=>k3(n,!1,!0)`（Backspace），
`ln(n,e,t=!0,r=!0)`＝`findClusterBreak(text,pos,forward,includeExtend)` ⇒ **退格把 includeExtend 传成 false**（不吸收 Extend/组合符），方向键传 true。
另有 `!e && /[\ufe00-\ufe0f]/.test(...)` 专门兜变体选择符（U+FE00–FE0F）。
⇒ 用户可见：打完 `é`(分解式) 按一次退格留下 `e`；`👍🏽` 退格只掉肤色。**是否上游原样未验证**（本机 web 检索全部引擎不可用）。

**W2 孤立 ZWJ 被当成连接符 ⇒ `x`+U+200D+`y` 是「一个簇」**：一次左移穿过 3 个单元（实测穿越=1，UAX#29 簇=2），
一次退格删掉 **3 单元**（删掉单元=3/期望 1）。引擎实现：`function o1(...){ … if(r==n1||i==n1||t&&Ky(i)) … }`，`n1=8205`（ZWJ 两侧无条件连），
与 UAX#29 GB11「两侧都必须是 Extended_Pictographic」不同。无字节损坏。

**W3 阿拉伯文：方向键走**视觉方向**，`End` 落在 LTR/RTL 交界**：一次 `ArrowLeft` 把 head 从阿拉伯文段逻辑末尾 **167 跳到 161**（跨 6 个 UTF-16 单元，列 5→4），
随后退格删的是**第一个**阿拉伯字母 `U+0645`（删掉单元=1/期望 1，数量对、位置随视觉落点）。文档字节全程未变（`文档未变:true`）。
引擎实现：`function jn(n){return n.textDirectionAt(selection.main.head)==Ltr}`，`var s3=n=>i3(n,!jn(n))`（ArrowLeft 在 RTL 处"前进"）。
`End` 同理按**视觉行尾**，混排行上落在 `锚点10：` 之后（head=162）而不是逻辑行尾 167。
> 这条在本族第一版探针里直接把我带沟里：用"点行首+End+Shift+←"选段，选到的是锚点而不是载荷（读数 `选区码点=U+951A U+70B9 U+0031 U+0030 U+FF1A`，回读 10 单元）。
> 已改成"读引擎 `textDirectionAt` 判方向 + 引擎坐标点选/三连击"，同一载荷复跑才对上。

**W4 零宽/软连字符在 DOM 里显示成占位符 `•`（U+2022），文档里仍是原字符**（显示层，不是数据层）：
同一行 `文本码点 … U+0061 U+200B U+0062 … U+00AD …` vs `domText码点 … U+0061 U+2022 U+0062 … U+2022 …`（load1/B上下文 行 11）。
复制/粘贴/存盘三处都是原字符（`a·b`、`so·ft` 逐字节相等），截图里 `so•ft` 的红点就是它。

## 三、被推翻的读数（保留原文，就地标注）

* 「Ctrl+Shift+V 一次按键粘了两遍」：r3 记到 `头部增量=16`（载荷×2，`目标行=👨‍👩‍👧👨‍👩‍👧`）。**查明是探针缺陷**——
  r3 那条臂的写函数自己按了一次 `Ctrl+Shift+V`，通用框架里又按了一次 `Ctrl+V` ⇒ 两次粘贴手势。r4/r5 修正后 4 条臂（clip.exe+Ctrl+V／壳层 API+Ctrl+V／clip.exe+Ctrl+Shift+V／ASCII 对照）
  **全部 8/8、5/5，目标行严格等于载荷** ⇒ **排除产品缺陷**，不作结论。

## 四、稳定性 / 崩溃（主进程事实）

* `pageerror = []`、`console.error = []`（5 次打字跑 + 1 次载入跑，全部为空）。
* **无产品侧崩溃**。r5 出现 1 次外部中断：`04:54:48.564Z win:render-process-gone {"reason":"killed","exitCode":1}`（壳层 trace），
  渲染进程被**外部**杀掉（本仓多族并行实测有 `taskkill /IM MarkPilot.exe`），不是 crash/oom。护栏按设计重启（换 profile+夹具复位）并**复跑该用例通过**（`外部中断次数=1`，`启动次数=2`）。
  副作用如实记录：重启把夹具复位 ⇒ END 的逐行复核里 `emoji-zwj/emoji-skin` 的粘贴目标行为空（这两例的读数在重启前已取全），其余 10 行复核通过；`盘上==引擎:true` 不受影响。
* 我起的实例**结束前全部 taskkill**：收尾核查 `Win32_Process` 里带 `weird-chars-out` 的 MarkPilot 进程数 = 0。

## 五、证据路径（全部在 `.mp-verify\checklist\` 下）

* 探针：`weird-chars-typing.cjs`、`weird-chars-load.cjs`、`weird-chars-lib.cjs`（尺子/启动/剪贴板四步）、`weird-chars-summary.cjs`、`weird-chars-dump.cjs`
* 读数：`weird-chars-out\typing5\result.json`（最终）、`typing\..typing4\`（历次，含被推翻的发次）、`weird-chars-out\load1\result.json`
* **自证命令**：`node weird-chars-selfcheck.cjs`（输出 `weird-chars-selfcheck.txt`）——把上面每个数字从 result.json 里再数一遍：
  `typing5：输入相等 12/12、盘上相等 12/12、复制可用 12/12、粘贴定长相等 12/12、粘贴目标行相等 12/12、退格整簇 6/12（其余 6 例见 W1/W2）、pageerror=[] console=[]`。
* 摘要：`weird-chars-typing-r5-summary.txt`、`weird-chars-typing-r3-summary.txt`（含 16 增量那次）
* 日志：`weird-chars-typing-r1..r5.log`、`weird-chars-load-r1.log`
* 截图（12 载荷局部 + 载入整篇）：`weird-chars-out\typing5\boot{1,2}\shots\*.png`、`weird-chars-out\load1\boot1\shots\{all,top,rtl-thai}.png`
* 壳层 trace：`weird-chars-out\typing5\boot1\profile\main-debug.log`（`win:render-process-gone`）

## 六、未验证 / 未覆盖

1. **ZWSP 与 RTL 的"精确选段复制"**：这两例 `coordsAtPos(载荷起/止)` 两端 **x 差=0**（ZWSP）或整行退化（RTL），
   4 种点/拖拽定位都只选中 `a` 或空选（读数在 `F选区.定位尝试`）；改用真三连击选整行取证（满足"复制后逐字节保真"，但**没验到"刚好选中载荷本身"这一形态**）。
2. **孤立代理项（lone surrogate）**：无法经 CDP `insertText`/系统剪贴板真实投递（通道会先归一），未覆盖；本族覆盖的是合法**代理对**。
3. **组合符/零宽字符的字形与实占宽**（渲染尺寸、是否压行）未量；本族只量字节与光标。
4. **上游 CM6 是否与本仓引擎逐字相同**未验证（无网络）；W1/W2 的机制引自**被测产物自带**的 `renderer/cm6/app.js`。
5. 真 IME 通道未走（本族用 `Input.insertText`，与表情面板/输入法提交同一条 CDP 通道；中文 IME 另有 `ime-chinese` 族）。
6. 未与 Typora 逐项对照（本族只给本产品读数）。
