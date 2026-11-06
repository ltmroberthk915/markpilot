# MarkPilot DSH 1.0.0 → 1.1.0 验证记录

## 范围与行为契约

本批只改 `dsh-markdown-typora` 插件层。CM6 编辑器仍为 3.6.17，未修改 `src-cm6`、桌面壳或内核载荷。

- Markdown 入口默认打开当前会话工作目录最近**成功打开**的 Markdown；顺序按 MRU，不按文件修改时间。
- 首选动作可设为最近文档、原生文件列表或空白文档；无最近文档时的文件列表/空白回退单独设置。
- 同工作目录切换会话保留文档、编辑实例和选区。跨目录默认执行打开策略，可设为保持当前文档；关闭的编辑区也可由跨目录切换触发打开。
- 空白文档在首次显式保存前不创建文件；首次保存写入其原始工作目录，内容精确保留，包括空字符串。之后沿用版本保护和自动保存。
- 保存状态独立于其它提示：未保存持续显示，已保存三秒后消失。错误、冲突与恢复入口仍保留。

## 实现边界

`lib/index.js` 增加按 canonical cwd 隔离的 MRU 元数据和固定 draft UUID 的首次创建接口。Windows 复用现有安全文件 worker；POSIX 使用不覆盖已有目标的硬链接发布路径。丢失回执可按固定路径与精确字节协调重试；这不是跨重启、跨删除的持久 exactly-once 日志。

`lib/client.js` 增加打开策略、会话选择订阅、带序号的异步打开意图、离开前恢复保护和空白稿首次保存提升。原生 Files 入口使用宿主提供的 command target/navigation 接口；异步结果必须仍属于当前上下文。空白稿首次保存载荷先持久化，再请求创建，后续输入保持脏状态并排队保存。

实机验收发现两项阻断并在插件侧闭环：原生右栏较宽时首次打开文档未及时为编辑区留出空间；同目录切换后，原生占位页与已打开的同名文档状态文案不一致。前者在首次布局读取前建立既有拖动手柄布局，后者按实际文档路径派生显示状态；没有引入逐帧轮询或新的编辑器实例。

## 冻结与载荷

验证日期：2026-11-07（Asia/Shanghai）。Windows，DSH 0.2.2-rc.1。

| 对象 | SHA-256 |
| --- | --- |
| `lib/client.js` | `765f9c9b44ec248bfadc8f3244afe3c533cbab04c961d6993228d54c374d8fc8` |
| `lib/index.js` | `4c83afbc89aa9d0cafb8e51063322ce1795a044f477858e65ce6da8dec5ea98a` |
| `renderer-cm6/cm6/app.js` | `1de9555f78b1871c50b82704bdf1b486057c04af956ef416d2fdbe69f565d600` |
| `dsh-markdown-typora-1.1.0.tgz` | `b280f89ff2e22ede14faaef5e35c6c3270a035d6d87651f302de2a3a2aa4b797` |

内核全量校验：124 个文件、7,351,676 字节，聚合 coreHash `4499e09378a8743fd1ec985c11bf8046f33b55350688dd9d996b839fe0d589ba`。host manifest 的 9 个文件全部通过校验。

实际 npm 包：148 个文件，压缩 2,748,274 字节，展开 8,064,013 字节。逐文件确认源码、解包载荷、实际安装目录三者 SHA-256 一致。包中不含测试、`.mp-verify`、旧 tgz 或打包日志。Windows native worker 及构建清单均在载荷中。

本机安装身份保持为 desktop profile 下的 `dsh-markdown-typora` junction，目标 `D:\BuyKey\markpilot-public\dsh-markdown-typora-trial-20261104`；冻结原始目录没有写入。运行中的实测插件与最终 tgz 的两份 lib 文件一致，完成包核对时只需补齐 README。原生验收结束后恢复 recent/files/follow 默认策略和原会话。

## 自动化与对抗证据

- 冻结源码完整测试：`node --test --test-force-exit dsh-markdown-typora/test/*.test.mjs`，302 项，301 通过，0 失败，1 项跳过（Windows 不运行 POSIX 专项）。
- `node --check` 两份 lib 通过。内核/host manifest 检查通过。README 增量验证通过，两份根 README 的旧行全部按原顺序保留；插件 README 旧字节完整保留。
- Windows 实际文件 API 专项：27 项通过，包括原生提交竞争、读拒绝、目录 junction 别名、首次保存回执版本与精确内容。这是实际 host 模块与文件系统证据，不冒充 GUI 证据。
- 首次保存等待、输入追加、持久化失败、旧实例回执、丢失回执恢复、空恢复文本等分支有定向反例。六组首次保存突变、两组空白恢复突变均保留精确原始代码恢复后的同臂通过记录。
- 会话导航 14 臂通过；七组导航突变证明旧结果、错误归属或关闭后的打开能够被探针检出。
- 冷启动布局覆盖 1281/1463 窗宽、宽右栏、关闭复原及连续拖动。移除首次布局建立后定向判据转红，恢复后通过。
- 最后占位文案用实际 client 闭包验证：2/2 通过；移除路径匹配块后同文档臂转红、异目录负例仍绿；精确恢复 2/2 通过。产品文件前后哈希一致。

## 原生交互与实际看图

通过 computer-use 在装机 DSH 中操作，验收用真实 README 副本、隔离的 A/A2（同目录）、B、Empty 会话。所有写入均落在测试副本/新空白文件，不改原用户文档。启动使用 app-slot 锁，结束释放锁并保留原用户应用。

真实输入覆盖键盘、鼠标、Ctrl/Shift 组合键、点击后 Shift+End、拖选后 Shift+Right，以及按下→移动→抬起拖选。主控和独立视觉代理均实际打开截图；同目录切换的选区另做局部 2 倍裁剪并实际查看，蓝色完整选区保持。DeepSeek 视觉路由在此实例不支持图像，文字回执没有当作视觉证据；替代视觉代理直接读取了实际图片。

关键截图在本机 `dsh-markdown-typora/.mp-verify/workspace-open-1.1/`：

| 证据 | 可见结果 |
| --- | --- |
| `native-empty-fallback.png`、`native-final.png` | 原生文件列表打开，最终工作目录与所选会话匹配 |
| `native-settings.png` | 三个独立策略选项清晰排列 |
| `native-cross-workspace-recent.png` | 即使 a-first 的 mtime 更晚，仍打开最近访问的 a-recent |
| `native-same-cwd-before.png`、`native-same-cwd-label-corrected.png` 及 `-2x.png` | 同目录切换保留完整 13 字选区，同名原生占位页显示正在编辑 |
| `native-cross-workspace-keep.png` | 跨目录 keep 保留原文与选区 |
| `native-file-bootstrap-1281.png` | 窄窗口首次文件打开时文档、聊天与原生栏正常分列 |
| `native-blank-dirty-persistent.png` | 输入后未保存提示保留 |
| `native-saved-visible.png`、`native-saved-expired.png` | 保存回执出现后消失，没有遗留空横栏或布局跳动 |
| `native-direct-blank.png`、`native-empty-first-save.png` | 已有历史仍可直接空白，空内容可首次保存；对应磁盘文件确认为 0 字节 |
| `native-real-drag-selection.png` | 真实拖选与 Shift 扩展选区可见 |
| `native-close-restores-width.png` | 关闭编辑区恢复原生栏宽并撤掉插件拖动手柄 |

三秒计时的精确断言来自保存状态控制器测试；静态截图只证明出现/消失终态。测试 README 副本没有复制图片资源，图内破图属于夹具资源缺失，不作为图片功能回归结论。本批未新增浅色主题、macOS 或 Linux 的原生验收，不作相应已测声明。

## 发布和已知边界

目标版本/tag：`1.1.0` / `dsh-markdown-typora-v1.1.0`。GitHub、npm、两个市场的最终在线状态及链接写入本机 `MarkPilot-1.1.0-发布交接.md`。

开放市场此前指出的旧认证兼容分支仍存在：宿主 connection 认证能力不可用时保留 loopback Host/Origin 回退。本批没有把它宣称为已修复，也不把提交市场更新等同于审核通过。旧宿主声明兼容范围保留，新增交互的原生验证范围是 DSH 0.2.2-rc.1。
