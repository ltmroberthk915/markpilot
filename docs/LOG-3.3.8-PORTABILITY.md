# 3.3.8：DSH 插件与 Android 预研

## 交付状态

桌面 CM6 继续以 `dsh-markpilot/src-cm6/` 为引擎真源。Android 新增 `MarkPilot-Android/` 实验项目和可运行的移动 Web 页面；没有复制一套编辑实现。DSH 已完成现有插件骨架的代码与打包清单核对，尚未安装到日常使用的 DSH。

Android 构建入口实际执行过，结果为 `apkProduced:false`：本机缺少 JDK 17、Gradle 8.13、Android SDK Platform 36。**没有生成、安装或验证 APK**；Java 原生宿主目前是未编译的实验骨架。Chromium 的触屏和窄屏模拟不能替代 Android WebView、SAF 文件提供方、中文输入法或真机测试。

## Android 原型

`node MarkPilot-Android/prepare-web.cjs` 将受控桌面构建的 JS、CSS、字体、Worker、mermaid 共 125 项资产复制到 Android assets，附逐文件 SHA256 清单；生成文件不入库。引擎脚本与桌面相同。`pwsh -File MarkPilot-Android/build-apk.ps1` 检查本机工具链并尝试 Gradle 构建；可用 Android Studio 打开该目录继续实验。

在桌面预览可运行 `node MarkPilot-Android/preview.cjs`，打开终端显示的本机地址，并用浏览器的移动设备模式检查；Ctrl+C 关闭预览服务。服务仅监听 127.0.0.1，草稿留在该浏览器来源的存储中。它不提供 Android 原生存储、SAF 或输入法的验证。

原生骨架使用 WebViewAssetLoader 的应用内 HTTPS 地址装载离线资产，禁用 file/content 直接访问和混合内容；脚本接口只处理有限方法。文档打开和导出设计为系统文件选择接口：打开到独立草稿，导出创建新文件。预研阶段不实现原路径覆盖保存和外改合并，避免把桌面文件版本协议误套到 Android URI。

原型已实现共享主题/字体 API 的适配：原生侧将 CSS 原文保存到应用私有 `files/themes/<sha256>.css`，以 active manifest 激活；字体另存文件。移动 Web 调试模式使用同源存储副本；该存储不是 Android 原生文件存储的实测证据。草稿暂存使用 WebView 同源存储，尚不具备桌面恢复系统的全部保障。

浏览器模拟覆盖 390×844、触屏点击后 Unicode 输入、草稿重载、文件导入与下载字节比对、主题副本、标题字体和窄屏设置。首个探针的两次失败保留：一次 HTTP 探针先发头后读缺失 favicon；两次输入探针遗漏触摸落点稳定等待并混入带换行的 insertText，不能据此宣布 Android 换行或软键盘通过。修正后的用例只证明实际触屏进入编辑面、插入无换行 Unicode 文本和持久化。

下一步必须先补齐工具链并产出 debug APK，再用模拟器或真机检验：软键盘/中文组字、触控选区与长按、旋转及进程回收、返回键与未导出草稿、SAF 取消/云文件/权限收回/大文件、相对图片、断网字体/公式/mermaid、主题与字体原生目录副本及重启。原生桥的输入校验与生命周期也需在编译和真实运行后复核。

技术选型依据：[Android 应用内网页资源](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)、[系统文档访问](https://developer.android.com/training/data-storage/shared/documents-files)、[AGP 8.13 兼容要求](https://developer.android.com/build/releases/agp-8-13-0-release-notes)、[AndroidX Webkit](https://developer.android.com/jetpack/androidx/releases/webkit)。使用固定版本验证可重复构建，不将它描述为最新版组件。

## DSH：已证实的准备缺口

独立审阅读取现有服务路由、客户端和 iframe bridge，并实际运行 `npm pack --dry-run --ignore-scripts --json`。清单共 578 项，默认使用的 `renderer-cm6/` 项数为 0；桥脚本在包内。源目录存在不能证明 npm 包可用。

当前插件还有以下独立阻断，均尚未在运行 DSH 中复现，不将静态推论写为已发生的数据丢失：

| 层级 | 现状 | 下一阶段验收 |
| --- | --- | --- |
| 包装/资源 | CM6 未入包；插件引擎与桌面不同；缺当前 Worker/mermaid 资产，Worker 地址按桌面入口推导 | 完整资产与 URL 闭合；隔离 DSH 中证明 Worker 返回、mermaid 渲染 |
| 保存边界 | 正常保存携带 baseVersion，关 tab 的 flush 没有；服务端缺版本时可无条件写入 | 脏缓冲、外改和关 tab 组合下保留双方内容，禁止静默覆盖 |
| 生命周期 | 先移除 message 监听再拉全文；迟到 open/text 没有完整文档身份与编辑 revision | 读取、切引擎、关闭前使用同一文档票据；旧回执拒收；保存可等待且可恢复 |
| 宿主能力 | DSH 只有旧 handler/hostApi，缺桌面 mpHost 的主题、字体、导出接口 | 以 capability 声明已实现能力；主题复制到插件私有目录；未实现入口明确禁用 |

建议的首个里程碑：生成完整 CM6 候选包，在独立 DSH 配置中打开文档副本，验证输入、版本守卫保存、外改冲突、关 tab 恢复和离线资源。完成后再进入日常使用试点。当前不直接给生产实例安装旧保存协议的候选包。

独立原始报告及 dry-run 收据保存在私有 `.mp-verify/theme-next/dsh-preflight-review.md` 与 `dsh-npm-pack-dry-run.json`。它们用于技术核对，不进入公开交付附件。
