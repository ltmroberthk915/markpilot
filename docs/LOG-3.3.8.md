# 3.3.8：主题持久化、独立字体与设置结构

## 范围与实现

本地交付 CM6 桌面 3.3.8；源入口为 `dsh-markpilot/src-cm6/`，宿主为 `MarkPilot-CM6/`。不修改 V2/VSIX，不向 GitHub 或商店发布。DSH 与 Android 仅预研，见 [移植记录](LOG-3.3.8-PORTABILITY.md)。

原始实装 3.3.7 反例：导入后 CSS/name 缓存尚在，但后执行的内置调色盘覆盖内联 token；134 字节显示为 0 KB 则是取整，不能据此断言文件为空。真实旧 profile 的隔离副本与 304097 字符文档也复现并核对了原始状态。

新增 AppearanceStore，导入原始 UTF-8 CSS（含 BOM、CRLF 和注释）复制到 userData/themes/<sha256>.css，原子 active.json 指向激活版本；移除写 tombstone，避免旧缓存复活。读取时校验摘要，普通原文重走适配；旧版只有已适配缓存时标 legacyAdapted 保留外观，重新导入才能取得真正的原 CSS。复制内容与原路径独立，不自动更新或复制相对素材。

字体单独存 fonts.json，正文、H1–H6、斜体、粗体、代码共 10 个角色。主进程按字段合并多窗口修改，revision 与渲染侧请求 generation 拦截迟到回执。字体仅作用于正文相关 token/选择器，界面和 KaTeX 自有字体保持独立。CSSOM 检查主题是否固定字体；锁定时保留偏好、禁用修改，移除主题后恢复。

更多菜单按文档、外观设置、阅读、帮助组织；设置分 8 类，同一对话框内切换，异步导入/移除不重开面板或跳分类。恢复入口明确为“恢复编辑器外观默认”，同时清托管主题和独立字体。旧无效字体设置键不再返回写入成功。

窄屏预研又证实两项共享边界：全文 regex 漏合法末项无分号且会读取注释假变量，现改为离线 CSSOM；跨规则首见、块内遵循浏览器合并，不宣称完整 CSS cascade。只含 bg/fg 的简主题会与旧深色输入底色混用，设置字体输入与提示现由 bg/fg 派生。禁用态仍有 .6 透明度，不承诺任意第三方主题或禁用文本达到固定对比值。

## 验证与身份

私有收据根为 `.mp-verify/theme-next/`，不进入 Git 或发布附件。主要收据如下：

| 范围 | 结果与收据 |
| --- | --- |
| 单元与实际函数模型 | 最终串行 224/224；unit-serial-final.log。generation、迟到 remove、font revision 的模型从实际函数提取，逐项突变红→还原绿；不当作 GUI 证据 |
| 外观主流程 | release-appearance 13/13；新包装实际隔离安装再测 safe-isolated-installed-appearance 13/13 |
| 相邻流程 | frozen-documents 10/10，frozen-preview 8/8，frozen-acceptance 19/19；与主流程合计 50 个不同桌面用例 |
| 旧配置与长文档 | migration-frozen 3/3：旧缓存迁移、真实进程重启、实际原生 MenuItem 的外观恢复；主安装重点复验另存 main-installed-migration |
| 独立视觉 | final-visual、frozen-visual、release-visual；主控亦打开实际图片。五通道由主控 CDP 执行，代理只读复核，不伪称代理亲自操作 |
| 移动浏览器 | release-android-browser 3/3；触屏点入编辑器、Unicode 无换行插入、草稿重载、导入/下载字节、主题副本及字体；不等于 WebView/SAF/IME/APK |

修复负控均只在自有源/ASAR 副本或内存中执行：撤回调色盘末层、面板回调重开、正确浏览器 CSS API、CSS 原文复制，4 臂均在对应性质转红；原样恢复后 12/12。新解析器负控只回退原 regex，ASAR 仅 app.js 改变；白字反例变红，恢复后 13/13。字体输入旧背景负控也转红，修正后 13/13。

最终完整打包前的引擎 SHA256 为 `43efd0639baec380ca488f39639ae4852a4d1093a82074e84364b68f8e1a1c61`。相邻 37 用例先在 `26320314…` ASAR 执行；style-only-proof 逐字节证明到 `74698261…` 只改两条设置 CSS 字符串，没有任何 JS/正文/导出变化，因此定向重跑外观和移动页面，复用相邻结果。后续 wrapper-only-proof 证明新安全包装仅增加 build/installer.nsh 与 package.json 的 nsis.include，所有应用代码/资源相同；新包装 ASAR 为 `1505dc0df2e83c0b32973dc1e7baa1fc89b31c5eade2a66717fa39ac82633b50`。

verify-package 已扩为完整校验：最终 Setup、portable、独立 UUID Setup 各解包核对 147 个 ASAR 文件成员与字节、73 个运行文件及完整集合。不能只拿版本号、七核心摘要或已有布尔值代替完整身份。PE ProductVersion=3.3.8，FileVersion=3.3.8.0。

## 安装器重大边界与处理

原独立 UUID 安装包触发了 electron-builder 25.1.8 默认的按 executable name 关进程逻辑，原主实例 PID42976 随之消失。此前标题未显示脏标，但它不能证明同进程所有窗口的保存状态。后续定位实际打开的磁盘文档，修改时间早于安装检查，另保留文件摘要和私有备份；不能据此反推不存在任何未保存的内存内容。此次隔离边界判断不足，失败候选和原始记录保留，禁止交付该包。

新增受支持的 customCheckAppRunning 覆盖安装、卸载：仅 FindProcess=603 放行，0 返回2并提示先保存关闭，其他码返回3。没有关闭或强杀操作。独立 appId 只隔离注册身份，今后测试工具同样须在所有 MarkPilot 进程闲置时才执行普通安装/卸载；拒绝分支仅对自有可丢弃探针执行。

真实负控只对自有合成未保存缓冲运行旧包：旧包退出0且结束编辑器，保护判据为红；新包退出2，PID、未保存缓冲、磁盘与注册快照不变。新卸载器亦退出2且保留编辑器，执行自有副本并传 _?= 取得真正卸载逻辑的返回码。FindProcess 608 的受控实际 NSIS 宏另有“错误放行”突变红→恢复返回3绿。标准 NSIS 初始化可能创建空目录/临时文件，不宣称拒绝时整个文件系统零变化。

新独立 UUID 包在含空格路径实际安装，原登记保持；运行完整13条外观流程后，测试卸载拒绝分支，再退出探针并正常卸载，登记恢复原状。对应 nsis-unsafe-owned-red、nsis-safe-running-green、nsis-uninstall-running-green 与 candidate safe installation with spaces。

正式升级脚本经独立审阅修订：要求相关进程全部闲置；备份并核对原程序、profile、注册值/类型和快捷方式；升级前验证完整载荷；精确处理本 GUID 旧 UninstallString，不调用历史卸载器；失败恢复保留新值并回读类型。安装后核完整运行树、卸载器/icon/InstallLocation、原 profile 和其他登记。原始备份在 main-upgrade/backup，不进入公开附件。

NSIS 依据：[插件返回码](https://nsis.sourceforge.io/NsProcess_plugin)、[卸载器复制与退出码](https://nsis.sourceforge.io/Docs/AppendixD.html)。本地安装器模板与最终实际进程测试是本次行为证据，官方说明只支持返回码和机制。

## 保留的失败、审阅裁定与后续

首次字体输入使用 datalist，在 Electron Tab 路径发生进程异常，已换为普通选择框加输入；随后 CSS 字符串常量遮蔽浏览器 CSS API 导致字体不提交，改为 window.CSS.supports。失败原收据保留，不以最终通过覆盖记录。

末次默认并发单元运行中，Worker 模型的即时树可用断言失败，父项/子项计2失败，其余222通过。该用例的实际回调只有20ms解析预算；独立7项重测及无并发完整224项均通过。确切调度原因未单独证明，登记为既有预算敏感测试边界；未改 Worker 产品代码或该测试来制造通过。

迁移探针首次在 reload 后的旧执行上下文读取失败；修正等待真实 load。第二次以“清主题后背景必须变色”为判据失败，因默认底色可与主题同色，改为核 tombstone、样式节点与激活属性确实移除。两次属于观测判据修正，原失败均保留。

独立架构报告中“无 CSP、文件名 HTML 可导致任意写盘”的严重利用链被拒绝：实际桌面有 CSP，Windows 文件名也有约束。主题名转义仍保留，但不将推测写为已证实漏洞。视觉报告中“所有声明末次胜出”及将移动浏览器归入 frozen-acceptance 的描述亦不采纳；最终口径以上述原始套件与 CSSOM 契约为准。

后续重点是 DSH 的版本守卫与关闭生命周期、统一宿主能力接口、Android 原生构建和真机输入法。磁盘损坏后的主题恢复交互、复杂条件 CSS 的完整级联与动态字体简写属于后续边界；当前损坏会可见报错并保留原 manifest，不自动覆盖或从旧缓存复活。

## 最终交付与原窗口恢复

2026-10-17 已将安全包装的 3.3.8 安装到原日常目录，main-upgrade/result.json 的完整运行树、原配置保留、其他安装登记与快捷方式核对通过。主安装迁移 3/3、最终便携包外观 13/13 均通过，最终预检 124 个文件无错误，git diff --check 通过。受保护原测试文档摘要保持不变，验收副本已删除。

normal-reopen.json 确认原日常文档经普通启动重新打开，PE FileVersion=3.3.8.0，无测试钩子或远程调试，rhapsody 已迁入私有主题目录；文档磁盘摘要与备份一致，正常实例保留给用户。首次普通启动探针设置 windowsHide 后没有可见标题，修正启动器标志并通过普通二次打开恢复窗口；不将该探针问题记为产品故障，也不据磁盘一致反推此前所有内存内容均已保存。

交付位于 dist/3.3.8：Setup SHA256 为 c0d2c8a12efc25f8d14bac02d4708946774f42d844604442d65946f8e733b3ba，portable 为 2ca58dcd19cd1d67c653c673f05e029796eef2d7f7cc450ffdd4713f4a2ba889；SHA256SUMS.txt 与 delivery.json 随附。已本地安装，未对外发布。Android 仍未产出 APK，DSH 仍为预研结论，二者不计入已完成的桌面验收。
