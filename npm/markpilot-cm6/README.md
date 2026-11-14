# MarkPilot 独立桌面版 3.6.21

MarkPilot 是一款即时渲染的 Markdown 编辑器：公式、代码块、表格、图片、Mermaid 图表和长文稿都能在熟悉的编辑界面里完成，保存、导出与多窗口协作按同一套文档模型工作。Windows 同时提供安装版与免安装便携版。

这个 npm 包是 MarkPilot 桌面版的下载与启动入口。安装包本身体积很大，不适合塞进 npm 注册表，所以这里只提供一条可核对 SHA-256 的下载通道，真正的安装包从对应的 GitHub Release 获取。

## 安装

```bash
npm install -g markpilot-cm6
```

需要 Node.js 18 及以上，仅支持 Windows。

## 使用

```bash
markpilot --download             # 下载安装版 Setup 并校验 SHA-256
markpilot --download --portable  # 下载便携版
markpilot --download --out D:\Downloads
markpilot                        # 启动已安装的 MarkPilot
markpilot 笔记.md                # 用 MarkPilot 打开文件
markpilot --path                 # 查看找到的 MarkPilot.exe
markpilot --version
```

下载完成后运行 `markpilot-Setup-3.6.21.exe` 即可安装或覆盖升级，原有文档、主题、字体和最近文件设置都会保留。便携版是单个 EXE，双击即用，不需要安装。

## 直接下载

- [安装版](https://github.com/ltmroberthk915/markpilot/releases/download/v3.6.21/markpilot-Setup-3.6.21.exe)
- [便携版](https://github.com/ltmroberthk915/markpilot/releases/download/v3.6.21/markpilot-3.6.21-portable.exe)
- [发布页](https://github.com/ltmroberthk915/markpilot/releases/tag/v3.6.21)

## 许可

MIT。随安装包分发的第三方组件许可见 `THIRD-PARTY-NOTICES.md`。
