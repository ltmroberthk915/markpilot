# 1.0.1 大文档优化与验证

本轮实现 P0 公式调度和 P1 输入相关计算缓存，保留完整编辑 DOM。安装包和便携版版本为 **1.0.1**。

## 同环境前后比较

使用 `.testws/教材合订本.md` 的只读内容，在独立 Electron 44.2.0 窗口（1180 × 800）运行同一份测试脚本。测试配置位于 `.perf/`，实际保存测试使用独立文件。教材 SHA-256：

`576956e99093bd8d0e0f5195a14e55b2d097c0b23a0f72fa09f48a6ba981f3b3`

| 指标 | 修改前 | 1.0.1 |
| --- | ---: | ---: |
| 初始化完成（含 after 补丁与缓存） | 2.58 s | 3.56 s |
| 刚打开时首次输入的请求到响应完成 | 16.54 s | 209 ms |
| 后台渲染期间，输入事件到下一帧的三个样本 | 175 / 244 / 164 ms | 28 / 49 / 53 ms |
| 全部公式完成后，输入事件到下一帧 | 151 ms | 77 ms |
| 同次输入后 Markdown 转换 | 2321 ms / 1642 万字符 | 1.9 ms / 7110 字符 |
| 整套流程中，公式全部完成的检查时点 | 45.8 s | 25.7 s |
| 50% / 75% / 95% 深度公式点击到可编辑帧 | 275 / 221 / 195 ms | 260 / 206 / 172 ms |
| 全部公式完成后的连续滚动 | 53.7 fps | 55.6 fps |
| 整套基准渲染进程累计 CPU 时间 | 67.29 s | 28.57 s |
| 结束后静止窗口 CPU 使用率 | 约 0.003% | 约 0.001% |

CPU 时间降低约 **57.5%**，作为本轮能效比较指标。它涵盖同样的打开、五次输入、转换校验、三个公式点击和滚动流程。公式完成检查每 10 秒采样，45.8/25.7 秒是上界，并非纯 KaTeX 执行时间。

初始化多约 0.98 秒，用于建立源码缓存和核对原生 Markdown 输出；随后第一笔输入不再排在长时间公式渲染任务之后。没有把首屏显示、输入事件、延迟 200 ms 的保存通知、全文公式完成混成同一项“加载时间”。

原始数据：[`perf-before.json`](perf-before.json)、[`perf-after.json`](perf-after.json)。原有 GLM 记录保存在 [`PERF-NOTES.md`](PERF-NOTES.md)，测试口径不同，不能直接把其中的 16–22 ms、21 fps 当成本轮前后对照。

## 实际修改

源码位于 `D:/BuyKey/Typora-Editor/extension-src/render/`；`app/renderer/` 仍由 `npm run sync` 同步。

- `js/math-scheduler.js`：并发脚本加载去重；KaTeX 生成和离线 DOM 构造按约 4 ms 切片；输入时后台暂停 180 ms，IME 合成期间暂停；当前公式可优先刷新；滚动时按块查找视口附近任务。
- 离屏公式先生成独立片段，每批最多 64 个写入页面，减少整页布局次数。可见公式优先显示。本次运行 292 个生成切片、89 次批量提交；最大生成切片 12.7 ms（单个公式不能中途打断），最大提交 1.2 ms。
- 相同公式的 HTML 使用有界缓存，最多 128 项 / 100 万字符。全局 TeX 定义采用原始顺序并关闭该缓存，保留宏和 mhchem 行为。
- `js/incremental-ir.js`：按顶层源码块缓存历史 HTML；生成快照时跳过 KaTeX 的展示子树，光标标记写入克隆，不修改真实选区。Markdown 转换复用最多 16 块的小段，普通输入只转换受影响的小段。
- Markdown 的分段间隔由原 Lute 全文输出校准，保留表格额外空行等行为。块结构变化、原始 HTML 修改、脚注与引用定义等情况回到完整源码转换，优先保证内容正确。
- 大纲按标题源码与顺序缓存；正文输入复用大纲，标题或顺序变化仍用原渲染器更新。
- `js/typora-patches.js`：接入调度与缓存，保留现有公式定位、方向键、标题回车和剪贴板补丁；预览内部变化不再重复遍历保护逻辑。
- Vditor bundle 只有三个接入点：脚本加载、数学调度、IR Markdown 获取。可用 `D:/BuyKey/Typora-Editor/tools/patch_vditor_performance.cjs` 重现；脚本校验原始 SHA-256，拒绝覆盖未知版本。

撤销与宿主通知继续使用原有 200 ms 分组。输入即时渲染本来通常只重解析当前块；主要耗时来自带 KaTeX 子树的全文 Markdown 转换、快照和全标题大纲计算。

本机的 `lute.min.js` 带有 `$goVersion` 和 GopherJS 标识，没有 WebAssembly 调用。旧笔记的“Go → WASM，约等于原生速度”不适用于这份 bundle；减少重复工作仍是本轮有效的优化方向。

## 回归检查

共 **200 项通过**：

- 原有编辑回归 16 项：标题回车、原生剪切事件、立即撤销/重做、宿主历史事件、公式源码选区、点击定位、错误公式等。
- 新增一致性与调度检查 154 项：原生 Lute 作为输出对照，覆盖待渲染/已渲染公式、表格、列表、HTML、脚注、引用、空块、重排、直接 DOM 修改；真实中文 IME 输入、提交和撤销/重做；宏、化学公式、输入暂停与旧任务取消。
- 真实主进程 / preload / iframe 链路 9 项：IR、所见即所得、源码模式编辑后保存、返回 IR、外部修改重载。比较实际磁盘内容与编辑器完整 Markdown。
- 原有 KaTeX 源码映射与布局指标 21 项。

打包后又从实际 `dist/win-unpacked/resources/app.asar` 启动主进程，重复通过全部 9 项保存链路检查；归档内 425 个 renderer 文件与源目录、同步副本逐字节一致，归档版本确认为 1.0.1。

完整教材的优化导出结果也与未缓存的原生 `VditorIRDOM2Md(root.innerHTML)` 逐字符相同。公式点击测量同时要求光标位于源码、源码有可见高度；避免仅检索原本就存在的隐藏源码。前后均等待公式完成，DOM 均为 272,436 个节点、5686 个 KaTeX 元素。

## 运行与回退

```powershell
npm run sync
npm run test:renderer
node --test D:/BuyKey/Typora-Editor/test/katex-source-map.test.cjs
npm run bench:renderer
npm run dist
node scripts/run-electron-test.mjs shell dist/win-unpacked/resources/app.asar
```

基准原版可通过 `node scripts/run-electron-test.mjs baseline` 运行。基准、回归日志和临时用户配置在 `.perf/`，打包范围只包含 `app/` 和 `package.json`。

修改前完整 renderer 备份：`D:/BuyKey/Typora-Editor/tools/backups/2026-09-05-performance/render/`。原 1.0.0 安装包与便携版也保留在 `dist/`。

## 本轮边界

没有引入虚拟滚动。完整渲染后的前后滚动都约 54–56 fps，不能声称已稳定达到 60 fps；这仍受全量 DOM 布局影响。首次缓存建立和结构性编辑需要全文校准，因此 77 ms 代表本样本的一次稳态正文输入，不是所有操作的延迟保证。
