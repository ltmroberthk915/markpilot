# 首屏与输入路径归因（2026-09-11）

> 一句话：上一轮把首屏慢归因于"Lute 必须整篇解析（3.7s）"——**这个归因是错的**。整篇解析只占 ~0.6s，
> 剩下 ~3.0s 全是我们自己在同一个长任务里做的预热与几何量取。把那些搬出首屏之后，
> 同一份产物上同机对照：**FCP 3828ms → 2732ms（−29%）**，打开长任务 3107ms → 1965ms（−37%），
> 首屏就绪（一屏内公式渲染完 + 图片加载完）3863ms → 3021ms（−22%）。

## 1. 归因方法

新增两个探针（只测量、不改产品）：

- `scripts/ir-perf-probe.cjs`：把打开的整段拆成可观测的相位——Lute 各方法的累计耗时（原型包装）、
  大字符串 `innerHTML` 赋值的耗时、`first-contentful-paint`、`longtask` 列表、
  `performance.getEntriesByType('resource')`（含 lute.min.js 3.8MB 的取回）、
  warmup 队列逐任务耗时、以及"首屏就绪 / 完全静止"两个终点。
  运行：`node_modules/electron/dist/electron.exe scripts/ir-perf-probe.cjs --label=<标签>`
  证据：`.perf/ir-perf-<标签>.json`
- `scripts/profile-report.cjs`：把 CDP CPU profile 的压缩帧映射回源码上下文，
  同时给出 self / inclusive 与**真实调用树**（`--tree`），用来区分"我们调 Vditor"与"Vditor 调我们"。
  运行：`node scripts/profile-report.cjs .perf/ir-profile-<标签>-open.json --tree --min=60`

## 2. 打开到底慢在哪（348k 字 / 531KB、2,576 个顶层块、5,645 处公式）

`.perf/ir-perf-baseline3.json`（改动前）：

| 相位 | 实测 |
|---|---|
| 首次 `innerHTML` 赋值（2,839,661 字符 IR DOM） | **37ms** |
| Lute `Md2VditorIRDOM`（整篇解析） | **~560ms**（175ms→757ms 之间） |
| Vditor 自己的 `K`（写版心 padding，读 `clientWidth` 强制整篇首次排版） | **~1000ms** |
| `applyTyporaPatches`（我们的补丁安装） | **~1603ms** |
| ↳ 其中 `installIncrementalIR` 的 Markdown 缓存首建 | **855ms** |
| ↳ 其中大纲几何 `update()`（读写交错，每次读都强制重排） | **~329ms** + 触发 Vditor `K` 再排 **~1017ms** |
| ↳ 其中阅读面安装时的一次 `getBoundingClientRect` | **~169ms** |
| ↳ 其中 CV 启用（逐块量高 + 校准） | **~103ms** |
| 我们派发 resize 触发的 Vditor 重排 | 计入上面的 `K` |
| 一次 `first-contentful-paint` 之前的**不可中断长任务** | **3626ms** |

也就是说：**Lute 只占 ~17%，浏览器插入 DOM 只占 1%，~55% 是我们自己的预热与几何**。
更关键的是几何读取的顺序——"写样式 → 读几何"每交错一次就强制重排整篇文档（单次 ~170ms，大纲那段交错四次）。

## 3. 做了什么

| 改动 | 文件 | 依据 |
|---|---|---|
| 新增首屏之后的分片预热队列（有输入让路、单片 8ms、可同步降级做 A/B） | `js/warmup.js`（新） | 见 §4 |
| Markdown 缓存首建改为分片预热；分组换算抽成 `unitFor` 共用 | `js/incremental-ir.js` | 855ms 移出首屏 |
| 撤销快照不再在记录时就算 Markdown（记版本号，用时再算：版本没变走缓存，变了走 `convert(html)`——与原实现 cache miss 的回退是同一条路径） | `js/incremental-ir.js` | 打开时 Vditor 的首次 `addToUndoStack → addCaret → snapshot` 会顺带算出整篇 Markdown（839ms），而这份值在打开时没人用 |
| 大纲几何延后到首屏之后，并把 `update()` 改成先读全部再写全部；面板隐藏时不派发 resize | `js/outline-layout.js` | 消除了 4 次强制重排里的 3 次 |
| 阅读面的宽度基准读取延后 | `js/reading-mode.js` | 那一次读强制整篇首次重排（169ms） |
| CV 启用延后到首屏之后（保留"队列清空 + 800ms 无输入"的门） | `js/large-doc.js` | 启用本身要逐块量高 |
| **Vditor 值惰性读取补丁**：渲染结束后的那次取值只在真有消费者（input/counter/cache）时才做 | `cdn/vditor/dist/index.min.js`（`scripts/patch-vditor-lazy-value.cjs`） | 三处调用点，打开时三个消费者全关，取值纯属白算 |
| 预热任务连续作废两次即放弃（避免用户一打字就把后面的 CV/几何预热饿死） | `js/incremental-ir.js` | 见 §5 |

## 4. 同机同产物 A/B（这是本轮的主证据）

同一份代码、同一素材、同一探针，交错跑两臂，只有 `localStorage.warmup` 不同
（`off` = 预热就地同步执行 = 改动前行为）：

| 指标 | sync（改动前行为） | deferred（本次交付） |
|---|---|---|
| first-contentful-paint | **3828ms** | **2732ms** |
| 首屏就绪（一屏公式+图片就绪） | **3863ms** | **3021ms** |
| 打开长任务（最大不可中断段） | **3107ms** | **1965ms** |
| 首屏之后最大单片 | 无（工作都在首屏前） | 454ms（全文分隔符校准，一次） |
| 完全静止（无队列、无长任务 300ms） | 4168ms | 4647ms |

证据：`.perf/ir-perf-ab-sync2.json` / `.perf/ir-perf-ab-defer2.json`（另有 `ab-sync1`/`defer1`/`defer7`/`defer8` 复跑）。

**关于"完全静止变晚"**：同样的工作量，改动前压在首屏之前一次付清，改动后分散到首屏之后、
每片让路给输入。读者能看到的差别是"文档出现前少等 1.1s、出现后不再有 1s 级冻帧"，
总量并没有减少（那 855ms+435ms 的缓存首建与全文校准是一次性成本，早做晚做都要做）。

Vditor 值惰性补丁单独对照（同一产物、只回滚 bundle、同一探针）：

| 指标 | 回滚补丁 | 打上补丁 |
|---|---|---|
| FCP | 2776ms | 2732ms |
| 首屏之后最大单片 | **1090ms**（FCP 之后 ~200ms 处，正是读者开始读的那一刻） | 454ms |
| 首屏就绪 | 4065ms | 3021ms |

证据：`.perf/ir-perf-ab-nopatch.json`。

## 5. 输入路径：谁在花钱（诚实版）

打字 40 字的 CDP CPU profile（`.perf/ir-profile-*-type-full.json`，348k 字全文、5.9 万节点）：

| 归属 | 每次按键 | 说明 |
|---|---|---|
| Vditor 自己的 IR 光标复位 `P → p → c`（`removeAllRanges` 282ms + `addRange` 118ms / 40 键） | **~10ms** | 在压缩包里，改它等于重写 Vditor 的光标逻辑 |
| 同上 `P` 内的 `querySelectorAll` | ~3.4ms | 同上 |
| Blink 自身 `(program)`（样式/排版/GC） | ~8–19ms | 与"编辑面 DOM/排版规模"成正比 |
| 我们的 `refreshMathEditing`（遍历全篇 5,645 处内联公式源码） | ~3ms | 占比小；见下 |
| 我们的公式调度 `scheduler.render/slice` | ~3ms | |
| KaTeX 真正渲染新公式 | ~3ms | 该花的 |

结论：**输入路径的剩余成本主要不在我们的代码里**（我们合计 ~6ms），而在 Vditor 的光标复位 +
Blink 的排版。把 `refreshMathEditing` 收窄成"只更新上一个/当前展开的 owner"能省 ~3ms/键（约 12%），
但要冒"展开态残留（公式一直显示源码）"的风险——那正是前几轮反复修过的可见缺陷，
本轮**没有**为了 12% 去动它。

上一轮"打字成本 ∝ 编辑 DOM 规模"的判断在算法层面仍然成立（27.2 万节点 426ms → 4.9 万节点 27ms 是
输入重解析与整篇序列化时代的旧数据）；本轮实测已在 **24.7ms 均值 / 28.7ms p95**，
小文档 8.9ms 均值——剩余的规模相关性来自上面的 Vditor/Blink 两项，收窄我们自己的代码收益有限。

## 6. 顺带查到、本轮未修的问题（如实记录）

1. **`setValue` 之后 CV 的 `contain-intrinsic-size` 丢失**：类 `typora-cv` 还在，但内联估算值全没了
   （实测 `intrinsicSet` 2576 → 0），跳过块退回默认估算，总高从 185,983 抬到 834,426（约 4.5 倍），
   滚动条与"滚动位置记忆"都会跟着漂。**仅在外部改动重载（`setValue`）路径出现**；正常打开是全新实例，不受影响。
   证据：`.perf/ir-perf-defer7.json` 的 `openCounts` vs `typeFull.counts`。
   （修法已想清楚：`measure()` 抽出来，重载后先摘 `typora-cv` 再量、量完再挂回；需要一次全量重排，故单独一轮做。）
2. **`nested-math` 的 `wysiwyg-link-table` 用例红**：断言"点击一个公式只展开它自己的源码"，实际 `[]`。
   已用四种回滚逐一定位——**把 6 个改动文件与 bundle 全部还原到 HEAD 状态后该用例照样红**，
   因此不是本轮（也不上一轮）引入的。证据：`.perf/nest-headeverything.log`（全 HEAD 树）与
   `.perf/nest-sync.log`（同步预热）、`.perf/nest-nopatch.log`（回滚补丁）、`.perf/nest-eager.log`（回滚惰性快照）。
3. **`workflow-gaps` 缺夹具**：该套件读 `.perf/release100-manual-fixtures/概率论-人工复核副本.md`
   （一个含哨兵格 `不变甲`/`不变乙`/`untouched` 的合成复核文档）。该夹具不在 git 里、
   已随上一轮清场删除，且**无法从受保护素材重建**（受保护的 `富文本测试-重识概率论.md` 出现 `不变乙` 0 次）。
   本轮 137 项中 119 项通过，18 项失败**全部**是读这份夹具的用例（E18 历史的视口还原 4 项、
   E17/E26 表格源码往返 real-note 4 项、单元格字面粘贴 10 项）。为完成对照，我按用户令把受保护素材
   复制了一份当作夹具跑过（跑完删除），但它不是原夹具，故这些用例的失败与产品行为无关。
4. **阅读模式首次准备 97.5s 的等待条件**（上一轮记录）本轮未动。
5. **旁路测试修复**：`scripts/history-visibility.test.cjs` 因为 `history-selection.js` 带 ES import
   而在 vm 里加载失败，11 个用例长期是红的（HEAD 里就是这个状态）。已把加载器改为"剥掉 import/export 后
   同时加载 large-doc.js 与 history-selection.js"，11 项现在跑真实代码并通过。

## 7. 复跑命令

```bash
# 归因（打开 + 输入 + 重载，含 FCP/长任务/预热分片）
node_modules/electron/dist/electron.exe scripts/ir-perf-probe.cjs --label=now
node_modules/electron/dist/electron.exe scripts/ir-perf-probe.cjs --label=now-sync --flags=warmup=off
node scripts/profile-report.cjs .perf/ir-profile-now-open.json --tree --min=60
# 正确性（占位消融必须 byte-identical）
node_modules/electron/dist/electron.exe scripts/math-perf-probe.cjs --label=final
```
