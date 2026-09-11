**[English](README.en.md)** · 中文

# MarkPilot · 万可百律

> ### AI 时代，全新定义 Markdown 编辑器——万有可能，一致百「律」。
> **开源项目，万众铸造。程序与插件本体免费，想魔改的源码另行授权。**

![version](https://img.shields.io/badge/version-2.0.18-blue) ![platform](https://img.shields.io/badge/platform-Windows%20%7C%20VS%20Code%20%7C%20Trae-green) ![license](https://img.shields.io/badge/license-%E6%9C%AC%E4%BD%93%E5%85%8D%E8%B4%B9%20%7C%20%E6%BA%90%E7%A0%81%E6%8E%88%E6%9D%83-orange)

MarkPilot 是一款 AI 原生的 Markdown 编辑器：你在写上一句的时候，它已经在替你想下一句；你排版的一撇一捺之间，藏着一套正经的中文排版引擎。同一套编辑内核，两种工作形态——既能作为 Windows 桌面应用开箱即用，也能作为插件装进 VS Code、Trae 等 AI IDE。

![MarkPilot：中西文混排与公式编辑](https://raw.githubusercontent.com/ltmroberthk915/markpilot/main/docs/screenshots/hero-light-serif.png)

*窄窗口、密集换行、中西文混排与实时公式——宋体-朙主题，中西文之间自动留白。*

## 界面截图

| | |
|---|---|
| **点符号就跳到源码**——点公式里的 ω，光标落在 `\omega` 的 o 上 | **下标也一样准**——点 `f_n` 的 n，光标就落在源码那个 n 上 |
| ![点 ω 定位源码](https://raw.githubusercontent.com/ltmroberthk915/markpilot/main/docs/screenshots/math-map-omega.png) | ![点下标定位源码](https://raw.githubusercontent.com/ltmroberthk915/markpilot/main/docs/screenshots/math-map-subscript.png) |
| **界面透明度**——弹窗与工具栏半透明，各有 10%–100% 的滑块 | **排版**——衬线宋体、中西文自动间距、整段最优断行 |
| ![半透明右键菜单](https://raw.githubusercontent.com/ltmroberthk915/markpilot/main/docs/screenshots/menu-translucent-70.png) | ![密集换行的正文排版](https://raw.githubusercontent.com/ltmroberthk915/markpilot/main/docs/screenshots/body-dense-wrapping.png) |

## 六个 Typora 给不了的重磅能力

### ✦ AI 行内补全

真正的行内续写：它知道你正在写哪个章节、前后文是什么、是不是在公式环境里，光标后面直接浮现灰色预览，Tab 采纳。双引擎设计——大模型续写（DeepSeek / 智谱 GLM，填自己的 Key 即用）加本地规则补全（公式、模板、路径），断网或没配 Key 也照样补。你的 API Key 只存在本机加密存储，不上传、不打进安装包。

### ✦ 数学公式的精准映射

编辑体验沿用 Typora 的路子：平时看到的是渲染好的公式，光标走近就亮出局部源码，即改即预览。MarkPilot 在这层交互之上，把渲染结果与源码挂了钩——**点击公式上的任意符号，光标就精准落在生成它的那段源码处**；反过来，源码里动一个字符，对应元素立刻刷新。公式嵌在表格单元格里、或层层嵌套，这层映射都不丢；原地点开编辑、精确撤销重做。写数学文档时，公式不再是"渲染完就碰不得的图片"，而是可编辑、可回退的活内容。

### ✦ 插件化：编辑器进驻 AI IDE

整个编辑内核打包成标准扩展：在 VS Code 或 Trae 里装上（现在**直接在扩展商店搜 MarkPilot 即可**，见「下载」），活动栏立刻多出一个 Markdown 工作台——完整编辑器、文档大纲树、AI 补全，全部在 IDE 里原生运行。在 AI IDE 里写文档，不用再切出去。

### ✦ 大文件不卡顿

分片后台渲染加源码缓存复用：打开大文档先建缓存，之后输入、撤销、大纲跳转都保持流畅，公式再多的长文也不会滚不动。内部基准测试中，正文编辑的 CPU 开销下降 57%–87%。

### ✦ 印刷级中文排版

这是 2.0 系列打磨最狠的一块，也是中文名「万可百律」里那个「律」字的来历——排版的韵律：

- **中西文混排自动间距**：中文与西文、数字之间自动留出呼吸空隙，公式与代码内部的像素布局不受干扰；
- **宋体系衬线双主题**（宋体-朙 / 宋体-暗）：正文中文宋体、西文 Georgia 双衬线，细笔画描边、暗色表格不再陷成黑条纹，中文斜体以楷体呈现——把屏幕当"纸"来排；
- **1280px 阅读版心**：宽屏不再一行读到脖子断；
- **导出采用 TeX 同源的 Knuth–Plass 整段最优断行**：不是逐行贪心塞满，而是整段代价最优——TeX 排了四十年的数学论文，用的就是它。

### ✦ 界面透明度可调

每一个弹窗、右键菜单与工具栏默认都是半透明的，而且**可以自己调**：设置里的「界面透明度」给弹窗与工具栏各一个 10%–100% 的滑块（70% 是个不错的起点）。是"可调"而不是"写死"——想看得清就调实，想要玻璃感就调透；正文从半透明的菜单后面透出来，但不会糊成一片。

## 还有这些

- 即时渲染 / 所见即所得 / 源码三种模式，随时切换
- 侧栏大纲树，点击标题直达正文
- 智能表格编辑，表格里写公式也没问题
- Mermaid 图表、上百款代码高亮主题、图片粘贴自动归档
- 悬浮工具栏岛：自动收纳，点空白处即落笔
- Word / Excel / PPT 迁移导出，公式以可编辑的 OMML 直达 DOCX，无需 Pandoc
- 明暗主题、阅读调色盘、Ctrl+滚轮缩放
- 弹窗 / 右键菜单 / 工具栏的透明度独立可调（10%–100%）
- Windows 安装版 + 免安装便携版

## MarkPilot vs Typora

|  | MarkPilot | Typora |
| --- | --- | --- |
| AI 行内补全 | ✅ 大模型 + 本地双引擎 | ❌ |
| 数学公式精准映射（表格内、嵌套可编辑） | ✅ | 部分 |
| 印刷级中文排版（中西文间距 / 衬线宋体 / Knuth–Plass 断行导出） | ✅ | 部分 |
| 大文档性能优化 | ✅ 分片渲染 + 缓存 | ❌ |
| 装进 VS Code / Trae 等 AI IDE | ✅ 插件形态 | ❌ 仅独立应用 |
| 弹窗与工具条透明度可调 | ✅ 10%–100% | ❌ |
| 价格 | 免费 | $14.99 |

## 下载

**IDE 插件**（现在可直接在扩展商店里搜索安装）：

- **VS Code**：扩展视图搜 `MarkPilot` → 安装（市场 ID `Jinxi.markpilot`）→ <https://marketplace.visualstudio.com/items?itemName=Jinxi.markpilot>
- **Trae / Cursor / VSCodium 等**：在 Open VSX 上（ID `jinxi.markpilot`）→ <https://open-vsx.org/extension/jinxi/markpilot>
  - 如果你的 IDE 里一时搜不到，用下面的手动方式装上即可
- **手动安装**：`markpilot-x.x.x.vsix`
  - VS Code / Trae：扩展视图 → `⋯` 菜单 →「从 VSIX 安装」→ 选中下载的 vsix → 重载窗口
  - 装好后活动栏出现 MarkPilot 图标，点开即用；AI 补全在设置里填自己的 API Key

**Windows 桌面版**：到 GitHub 仓库的 **Releases** 页取最新版本

- `markpilot-Setup-x.x.x.exe`（安装版）或 `markpilot-vx.x.x-portable.exe`（便携版，免安装）

## v2.0.18 更新

### ✦ 打开文档，快了一秒

写长文的人最在意的那点等待，这版砍掉了：小文档从启动到内容上屏 **1.5 秒 → 0.55 秒**，二十万字的大文档 **1.9 秒 → 0.9 秒**。换文档、滚动、阅读位置还原都没有退化。

### ✦ 表格里的公式，点一下就能改

把公式写进表格单元格也没问题：点一下展开源码，改完立刻重排；上方/下方插入行、左侧/右侧插入列、删除行列都在右键菜单里，而且**表格之外的正文一个字符都不会动**。

### ✦ 保存不会偷偷改你的文件

没动过的地方，存盘后与你原来的文件一字不差——不会多出看不见的字符，也不会顺手把你的排版重排一遍。

## 修复

- **右键菜单「剪切」点了没反应**：某些环境下它只把文字放进剪贴板、没有真的从文档里删掉，于是剪切看起来什么都没发生、接着粘贴还会出现重复内容。现在剪切会真的删掉你选中的内容。
- **表格存盘后的行与列**：保存时表格会按列宽重新对齐，每一格的内容都原样保留。

## 开源与授权

开源项目，万众铸造——功能请求、缺陷反馈、主题与词条贡献都通过 GitHub Issues 汇入，每个版本都由真实写作场景驱动。**程序与插件本体永久免费**；需要二次开发、想魔改的完整源码为付费授权，请到仓库 Issues 联系作者。

安装包内附《第三方组件声明》（THIRD-PARTY-NOTICES.md），随每个版本同步更新。

## 隐私

本地优先。编辑、渲染、导出全部本地完成；AI 补全只在触发时直连你选择的模型服务商，Key 存于本机加密存储，永远不离开你的电脑。

---

*MarkPilot（万可百律）· 万有可能，一致百「律」 · 由一个每天用它写文档的人维护*

*如果它对你的写作有帮助，点一个 ⭐ 能帮更多人找到它。*
