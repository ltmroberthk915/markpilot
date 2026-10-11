# KaTeX 与 MathJax 4.1.3 本地对照（2026-09-06）

建议保留当前 KaTeX。宏兼容范围更广，不代表输入与渲染会更快。未来如有 KaTeX 无法处理的合法公式，可考虑按需加载 MathJax；这次没有替换生产渲染引擎。

## 样本与方法

- 从用户桌面的 `动态规划教材（渲染修复副本）.md` 经当前 Lute 解析得到 2,844 个公式，按“源码 + 行内/块级”去重后为 1,752 个。
- 在全文位置上均匀选取 120 个不同的行内公式，加上全部 26 个不同的块级公式，共 **146 个真实公式**。没有手工改写公式。
- 同一台机器、Electron 44.2.0，全部脚本与字体通过本地服务器加载。没有 LLM 调用、没有上传笔记。每组先运行一轮冷启动，再运行五轮；下表为五轮整批耗时的中位数。
- KaTeX 0.16.9 使用本项目构建和源码映射选项，输出 HTML。MathJax 4.1.3 分别测试 CHTML 与 SVG；每轮重新转换相同源码，插入 DOM 并触发布局。没有使用应用层公式缓存。
- 为避免把额外功能开销误认为核心排版开销，另外测试关闭 MathJax 语义增强、语音、盲文及交互辅助处理的配置。该配置只用于性能对照，不作为无障碍使用的推荐配置。

| 146 个公式整批处理 | 转换中位耗时 | 插入与布局中位耗时 | 整批总耗时中位数 |
|---|---:|---:|---:|
| KaTeX 0.16.9 | 24.4 ms | 39.0 ms | **65.1 ms** |
| MathJax 4.1.3 CHTML，关闭上述额外处理 | 130.9 ms | 15.9 ms | **146.2 ms** |
| MathJax 4.1.3 SVG，关闭上述额外处理 | 159.8 ms | 26.1 ms | **187.4 ms** |

总耗时中位数不是前两列中位数的和。所有配置均完整渲染这 146 个样本，没有公式错误。MathJax 两种输出产生的 DOM 节点更少，但本次总耗时仍较高；因此不能仅凭 DOM 数或宏数量判断提速。

MathJax 保留默认语义/语音等辅助处理时，同一整批的中位数约 3.05 秒。它完成了额外工作，不能将这个倍数宣传成纯排版引擎差距。官方说明 MathJax v4 的组合组件默认启用辅助扩展：[Accessibility Extensions Options](https://docs.mathjax.org/en/latest/options/accessibility.html)。

这些数据是批量转换及布局时间，不是键入到屏幕显示的延迟，也不是能耗测试。编辑器已有的视口优先、输入让路、公式缓存、撤销复用和源码点击定位仍应保留；完整替换还需要重新实现、验证对应行为。

MathJax 的包和字体仅保存在 `.perf/mathjax-benchmark/`，不会进入安装包。官方字体、扩展能力参见 [MathJax Font Support](https://docs.mathjax.org/en/latest/output/fonts.html)；KaTeX 已支持的命令参见 [Supported Functions](https://katex.org/docs/supported)。

## 复现与原始证据

测试脚本：`scripts/math-engine-benchmark.cjs`。准备好隔离依赖 `mathjax@4.1.3` 后执行 `node scripts/run-electron-test.mjs math-engines`；通过 `MATH_ENGINE_VARIANTS=chtml-lean,svg-lean,katex` 测量关闭额外处理的对照。

- `.perf/math-engine-benchmark.json`：默认配置的逐轮、逐公式计时及资源请求。
- `.perf/math-engine-benchmark-lean.json`：关闭额外处理后的同样记录。
- `.perf/math-engine-samples.json`：样本源码与原文公式位置。
- 笔记 SHA-256：`854c06a50d591c99b53810bcb0951e291b1c7bd495336d22897b855c3748599f`。
