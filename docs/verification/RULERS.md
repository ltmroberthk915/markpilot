# 尺子清单（哪些探针是权威的、量什么、怎么锁产物）

> 这份文件是 `AGENTS.md`「高频错误与硬性对策」错-1 / 错-4 的操作面：
> **一件事只有一份实现；每条读数都要能追到产物与夹具。**

## 一、锁产物（每次取证都该做）

```powershell
$env:MP_EXPECT_EXE='<portable 的 sha256 前 16 位>'   # 例：ee13fa05013171e3
$env:MP_EXPECT_DOC='<夹具 sha256 前 16 位>'          # 例：42c129273a0cd486
node .mp-verify\checklist\<探针>.cjs "<exe>"
```

- 探针启动先打一行 **`[尺子卡]`**（探针名 / 产物与夹具的 size+sha16 / node 版本）；
- 期望值不符 ⇒ 打印 ✗ 并 **exit 9**，**不出数**（宁可没有数，也不要"对不上号的数"）；
- 不设期望值时只打印、不拦（探索阶段用）。共用实现在 `_probe-common.cjs`（唯一一份）。

⚠️ **注意产物有两个身份**：`dist/win-unpacked/MarkPilot.exe`（解包目录，探针常用）
与 `dist/markpilot-cm6-<版本>-portable.exe`（**发布产物**，验收报告锚定的是它）。
两者 sha 不同——本轮就出现过"探针在 unpacked 上量、验收锚 portable"的不同源问题。
**锁哪个就传哪个**，别混。

## 二、权威尺子（活目录里只有这些是"算数的"）

| 探针 | 量什么 | 备注 |
|---|---|---|
| `accept-310.cjs` + `probe-310.cjs` | 全量验收（80 项）与 §7 交互/性能判据 | `probe-310.cjs` 是**唯一**的 `instrument`/`typeKeys` 实现；`accept-310.cjs` 自带 app-slot 自锁，必须直接运行 |
| `perf-keys.cjs` / `perf-dispatch.cjs` | 真实按键 / 紧循环 dispatch 两把尺子 | **两把尺子的数不许直接比**（错-3） |
| `probe-pdf-kp.cjs` | 导出链：PDF 是否落盘、KP 是否生效、公式 CSS 是否进打印窗口、磁盘是否干净 | 与 `shoot-print-window.cjs` 配套 |
| `shoot-print-window.cjs` | 打印窗口的**视觉取证**（排版后、打印前自截） | 需要 `MP_PDF_SHOT` / `MP_PDF_SHOW` |
| `oom-scroll.cjs` / `oom-stress.cjs` | 大文档滚动的内存与存活（RSS 序列、JS 堆、DOM 计数） | 结论"未复现"的证据在 `.mp-verify/oom-hunt/` |
| `probe-typography.cjs` / `probe-kp-debug.cjs` | 阅读模式排版美化（KP 接管段数、行高、模式切换） | 只能对**小文档**期待 KP 生效 |
| `verify-push-3.1.0.cjs` | 发布回读：资产 digest / 说明正文 / latest 位 | 推送后必跑 |

## 三、不许出现的东西

1. **活目录里第二份同名实现**（`instrument`、`typeKeys`、`sha16`…）——历史快照一律进 `_retired/`（只读）。
2. **没带尺子卡的读数进报告**——报告里的每个数字都要能追到产物 sha + 夹具 sha + 尺子名。
3. **两把尺子的数放在同一张表里比**（例：紧循环 dispatch 的 13ms 与真实按键的 1.3ms）。
4. **读日志前不确认"日志在哪、开关开没开"**——本轮为验证崩溃埋点连踩两次：
   `dbg()` 被 `MP_DEBUG` 门控（没开就什么都不写），而日志落在 `app.getPath('userData')`，
   探针用 `--user-data-dir=<profile>` 起应用时**日志在那个 profile 里**，不在 `%APPDATA%`。
   两处任一搞错，都会把"我没读到"误判成"埋点没触发"。
   ⇒ 探针要**自己**把开关打开（`MP_DEBUG=1`）、自己算日志路径（`path.join(PROFILE,'main-debug.log')`），
   并在尺子卡里把日志路径打出来。

