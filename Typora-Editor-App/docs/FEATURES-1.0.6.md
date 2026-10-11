# 1.0.6：文件关联启动与文件路径操作

2026-09-06，桌面程序更新，共用渲染器及 VSIX 0.1.12-local 保持不变。

## 原因与修复

旧版在 shell 页面加载前处理启动参数。文件读入成功后，`doc-load` 通知可能先于页面监听器发出；随后 shell 恢复会话时，文档控制器认为同一文件已经打开而跳过加载。表现为文件夹目录已出现，编辑区仍停留在欢迎页。测试延迟 shell 加载 300 ms，稳定复现了旧版主进程有文档、编辑区无文档的状态。

新增 `app/main/file-open.js`，将启动和菜单的打开请求排队，等 shell 注册监听器并调用 `boot` 后处理。明确指定的文件或文件夹优先于历史会话；窗口尚未创建时的二次启动也会保留请求。打开操作按顺序执行，避免较早文件的异步读取覆盖较晚请求。

Electron 转发第二实例的 argv 时可能追加或调整参数。第二实例现在在自己进程中解析绝对路径，通过 `requestSingleInstanceLock` 的附加数据传给主实例，保留中文、空格、特殊字符及调用方工作目录；兼容旧式 argv 事件。

重新加载 shell 时重新挂载内存中的当前文档，保留未保存内容，不会因同路径短路再次丢失编辑区。

## 功能入口

- 顶部“文件 → 打开文件所在文件夹”：用资源管理器显示并选中当前文档。
- 顶部“文件 → 复制绝对路径”：复制当前文档完整路径。
- 文件树右键菜单提供相同名称的操作，作用于右键选中的文件。
- 没有打开文档时，顶部两项菜单禁用。重命名文件或所在文件夹后，操作使用更新后的路径。

## 验证

- 11 项启动参数与队列单元检查，覆盖启动等待、二次启动顺序、会话优先级、取消与失败恢复；2 项原有最近记录检查。
- 22 项真实 Electron 宿主检查：冷启动、早到的第二次启动、真实第二进程转交、会话恢复、文件夹启动、空会话、原生输入与保存、未保存取消、界面重载、菜单和文件树操作、文件及父目录重命名。
- 30 项原有桌面回归检查通过，包含三种编辑模式、快捷键、查找替换、图片、主题和公式源码保存。
- 最终 ASAR 再通过上述 22 项启动检查和 30 项桌面回归。
- 直接运行最终 `win-unpacked/TyporaEditor.exe`，4 项检查通过：文件参数冷启动、独立配置目录、真实第二 EXE 传入相对路径、原生编辑并写回正确文件。

所有操作使用测试目录与独立配置。资源管理器和剪贴板调用在测试中替换为记录函数，验证实际菜单/IPC 传入的路径；不改系统剪贴板或默认应用。交互测试顺序执行。宿主测试使用随机服务端口，不占用用户正在运行的编辑器端口；实际 EXE 检查会先确认 48190 空闲。

445 个共享渲染文件与上一版及插件源码一致，455 个应用文件与最终 ASAR 一致。没有将上一版的全量 VSIX/渲染测试计作本次新增检查。报告、产物尺寸和 SHA-256 见 `release-1.0.6.json`。

## 产物与复测

- 安装包：`dist/TyporaEditor-Setup-1.0.6.exe`
- 便携版：`dist/TyporaEditor-v1.0.6-portable.exe`
- 最终程序：`dist/release-1.0.6-final/win-unpacked/TyporaEditor.exe`

运行安装包更新已有个人版。此次生成并验证了安装包，没有覆盖用户已安装的版本，也没有改变 Windows 默认应用关联。

```powershell
npm run test:launch
npm run test:state
$env:MD_EDITOR_TEST_SKIP_CLIPBOARD = '1'
node scripts/run-electron-test.mjs shell
node scripts/run-file-launch-tests.mjs dist/release-1.0.6-final/win-unpacked/resources/app.asar
node scripts/run-electron-test.mjs shell dist/release-1.0.6-final/win-unpacked/resources/app.asar
node scripts/test-packaged-launch.mjs
```
