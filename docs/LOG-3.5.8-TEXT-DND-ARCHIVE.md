# 3.5.8 开发记录：内容拖放封存与停用

内容拖放已移出当前开发范围。实现作为技术实验封存，未来只有明确的恢复需求才重新研究、验证和合入；没有可自动打开的功能开关。普通按下鼠标移动来选择文字、键盘、复制粘贴和菜单插入继续保留。编辑区内容拖入（含图片文件拖入）关闭；窗口外及文件管理区域不属于这次修改。

## 技术存档

- 包名：text-dnd-experimental-v1.zip；13,645,910 bytes，566 个归档项。
- ZIP SHA256：9f2e37a130550b864581745f08b3fd433f11b5b94ce86eb7cbb99ee19c56a93f。
- MANIFEST SHA256：61dd6fbeb029ba2a1eb68085a0b59ee3337885d8cbfacef8db2d77bfbf2dcd01。
- 远端位置：technical-archives/text-dnd-experimental-v1.zip；本机保留同字节副本和说明。
- 保存 a9 source34、HEAD79 两脏文件 binary patch、632/a9 ASAR、身份清单、相关探针/原生 QA 源与二进制、12 组实际 run 及必要原件。未复制完整 Electron、用户文档、用户 profile、剪贴板或通道凭据。
- 632 的两次原生 Move2 风险、诊断干预边界和旧 false/gap 保留。a9 仅构建/275 检查/身份冻结通过；其无干预原生资格仍未取得。未运行 held/passive 文本明确单列，不冒充执行证据。

## 当前代码

移除单元格专用接收、源归属/删源、编码/票据、COPY 提示及 native 拖动结束状态链。统一捕获当前主编辑器、归属覆盖层和分屏源码编辑面内的四类原生拖放事件：dragstart 取消；dragenter 只截断旧处理链、不接受协商；dragover/drop 明确 None 并拒绝默认操作。普通 mousedown/mousemove、表格点击/背景点击和 beginCellPointerSelection 原字节保留。splitview.js 保持 ee2f08f334e8da7084da265b7c6c47f66f40f8c7ab8029a8bb1d9ce2d8dec57c，S4 继续冻结。

工作区 main：da90503f865562ba4b90b6067d394e7a79c6dcaa98b2cc958ca3ea5b562a02ab。
构建引擎：205aad3a2860b175b45010d206464e9e1a3a498bc947b9bf9fdaa0b567d66067。
隔离 ASAR：8dd4bf40f3488855759718d4b4aa9134faefb2c38a57ab2d1852c7287f5b6fb0。
仅一个载荷成员 renderer/cm6/app.js 改变；source33、payload156、其余 runtime77 保持原字节。源34、实际 ASAR157、完整244、runtime78 及严格21均已冻结并核对。

## 定向验证

275 项维护基础检查与 preflight 通过。原维护表格八例通过，包括首次拖动选字、Shift 选区、145/300 入格与输入、异步偏移/删行、当前行归属及 Undo/Redo；它们的原始用例和判据未改。

三个外部有限拒收控制均取得真实系统返回 None0：body→cell、cell→cell 的中间驻留100ms/最终无 over 路线，以及正常有 over 的 active overlay 路线。SRC 或 A|B 外部来源保留，目标全文、选区、owner、epoch/revision、History、dirty/save 和文档身份守恒。每例15项新拒收检查、22项设施检查及原生原件链核对通过。旧 COPY expected1/false/gap 原样保留；没有把缺少 document 事件当作动作证明。

两个内部控制在正文及单元格中取得真实可信 dragstart，最终同事件 defaultPrevented=true，后续无可信 over/drop；源、文档、历史核心、dirty/save 守恒，九步移动与释放完成。微任务早读 false 如实保留，最终完成读数为 true；不宣称内部 OS DoDragDrop 返回值。自然 pointer selection 变化允许存在：正文初始完整词在起拖时成为其子串；原完整词不变的旧尺子失败结果保留，修正后的 DOM 归属/非空子串尺子独立审查后复测。没有修改产品来迎合尺子，也没有事后修复焦点或选区。

测试实例、原生源和驱动均已正常清理；保留原失败、入口缺口和更正记录。所有输入只作用于隔离合成夹具。

## 已保留的视觉边界与后续范围

public readOnly-only 夹具的活动格空白，以及300%首次入格时光标下部超出视口17.491 CSS px，均与此前维护用例相同完整 PNG SHA；不能据本批八例通过宣称完整阅读可见性或始终完整光标可见。稳定行首帧部分后排绘制未稳定也只作线索；R07 缺失第三格来自夹具。后续按真实入口继续核验，未为本次停用改动签发这些性质。

既有42条 regression_recheck_pending 是待复核项目，不能称为42个已确认未修 bug。它们没有因本次归档被自动改为完成。历史拖放风险留在存档，当前路径以撤除功能结束，不再继续开发 COPY/MOVE 接收协议。

本次没有发布、推送、打 tag 或安装；版本仍为私有开发产物。后续安装/发布沿用暂缓状态。

