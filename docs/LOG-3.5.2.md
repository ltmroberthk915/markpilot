# MarkPilot 3.5.2 验收记录

范围：大纲标题的行内公式显示；Ctrl+Shift+E/M/Q/K 分别用于行内公式、块公式、引用、代码块。版本与锁文件、ASAR、PE资源、安装包名称统一为3.5.2。

## 实现

- extras 仅在大纲建立/既有150ms重建时调用共用行内渲染器和KaTeX；缓存64条、256KiB UTF-16负载，单条64KiB，标题输入2048字符。错误公式/超长标题保留文本；不增加按键扫描或计时器。显示HTML剥除正文点击用源码映射属性。
- 快捷键复用wrap、insertBlock、toggleLinePrefix；行内插入没有填充空格，块模板沿用既有换行与光标语义。主编辑面的格式/紧邻输入仍沿用工具栏的撤销分组。
- 一次性mp-key-defaults-352迁移处理旧export键及四组合冲突，保留其它配置，标记后允许用户重新绑定。畸形JSON不改写；先保存键位再记录标记。
- 格内行内公式保留原实现；M/Q/K拒绝块操作并提示，不写入表格。Alt附加组合不被接管。

## 验证

- 实际3.5.1包完成原始显示取证。新包11项定向真实输入通过，含空/正反选区、光标、撤销重做、迁移/重绑/重载、五通道、表格与阅读守卫、大纲及独立读盘保存。
- 将新引擎替换为精确3.5.1引擎的私有突变包：四键与大纲同臂5/5失败；返回冻结新包后5/5通过。冻结新包未被突变修改。
- 两位纯文本独立审阅；DeepSeek最终10次read_image成功，均有image内容回执，包括四组光标2倍图和浮层/停靠公式图。
- 探针早期修正：Shift字母键应按物理大写发送；各臂重建独立文档历史；不将既有“格式后立即输入同组撤销”误判为本次回归。失败原收据保留，不计通过。
- Setup、portable、独立测试Setup各核对完整151个ASAR成员、75个运行文件及解包集合，三包通过；正式ASAR与GUI实测ASAR完全相同。PE版本回读3.5.2/3.5.2.0。
- 唯一测试身份在含空格路径真实安装、运行四键/大纲/保存、卸载；原配置字节、快捷方式及原注册表值/类型保持一致。
- 本机采用同一正式Setup静默升级；77个安装文件包含75个匹配运行文件和2个安装器文件。两个profile共520文件不变，原快捷方式恢复原字节，注册表仅本产品DisplayName、DisplayVersion、EstimatedSize改变。按既定静默约束，本机未启动产品做功能测试；功能证据来自远端实际安装及完全相同载荷。
- 中英文README只增加新版介绍，旧内容全部按顺序保留，现有verify-readme-keep工具在远端通过。

## 未修改与后续

- 富文本粘贴后强调定界符初显单星、重新聚焦显示双星：确认显示差异，文档源码完整。简单正则方案会破坏合法嵌套/相邻强调，未合入。后续只在内容边界判定有安全方案和反例覆盖时处理。
- 点击表格右侧空白暴露行源码的现有行为保留。
- 3.5.1记录的S4额外开销验收缺口及其它延后优化继续保留，本版不宣称解决，也不扩大未知问题搜索范围。

## 身份

- 引擎SHA256：d0f95b178b149cae67b3365186ae8eb73f7fcea8765905ec48fab123ede5336c
- ASAR SHA256：67c41bc19c78306ed4310d8e80303283dfa79fb2c36ded9636b83b78f42d9218
- 正式EXE SHA256：fcb4c6bcad4c5816aea0185081ac18bd5b8ff5d5dd8dc8617412debed1b2515a
- Setup SHA256：0e7cc4894bf5ef43b43e329f8241e333aa3e92257ce37cd9e359d6d6274e6c84
- portable SHA256：f531338e471f7a1ca5b2a39f8fff669dc2a673e2ce5757687df6482083a3ded8

完整私有证据与接续入口位于 .mp-verify/v340/edit-r2/resume-gpt/resume-20261020/ui352/，包括accepted-files、canonical-application、gui-green-r3、gui-red-r2、gui-restore-r1、visual-final、finaltext、pack、isolated-boundary、production-install和HANDOFF-RELEASE-3.5.2.md；正文、profile与截图不发布。
