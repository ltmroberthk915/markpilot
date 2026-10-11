# Typora Editor 1.0.8 / VSIX 0.1.20-local

工具栏更紧凑：移除可见的粗体、斜体按钮，保留三种编辑模式下的 Ctrl+B / Ctrl+I。主题按钮显示半明半暗的圆形图标，补全按钮显示星光与文字线条图标，均保留悬停说明、可访问名称和原有菜单。补全菜单仍显示当前模型、四个模型预设和 API 设置。

桌面应用和 VSIX 使用统一的灰蓝色 M 图标；Windows 的 Markdown 文件关联使用同系列的轻量纸张图标。ICO 包含 16、20、24、32、40、48、64、96、128、256 像素的透明图片，小尺寸文档图标单独增强细边。窗口图标现在从已打包的 `app/assets/icon.png` 加载。

图标源文件和生成说明见 `build/README.md`。浅色、深色背景与重复桌面文件排列预览见 `branding-preview.png`。

安装包：`dist/TyporaEditor-Setup-1.0.8.exe`。便携版：`dist/TyporaEditor-v1.0.8-portable.exe`。插件：`../Typora-Editor/dist/seepine.md-editor-0.1.20-local.vsix`。

安装版会将 Markdown 专用图标放入安装目录的 `resources/markdown.ico`；Windows 将本应用设为 Markdown 默认打开方式时使用该图标。便携版不注册文件关联。

本次验证覆盖三种编辑模式的格式快捷键、主题选择、补全菜单、实际 VSIX 和打包桌面端。发布验证及文件散列记录于 `release-1.0.8.json`。运行测试使用隔离配置与本地模拟服务，不调用真实 LLM。
