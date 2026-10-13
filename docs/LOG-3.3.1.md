# MarkPilot 3.3.1 验证记录

范围：公式预渲染框的完整高度、柔和边界、67.2 viewport CSS px 避让上限、避让开关，以及横向滚动条。保存、多开、共享源码映射、历史和补全策略没有改动。

## 实现与判据

- previewFrame 仅使用能容纳完整高度的近邻带；不足时按完整高度覆盖显示。completion 的 verticalFrame 受限高度策略保持。
- 宽度阶段清除旧高度限制，下一帧量自然高度、边框与实际横向轨道，再向外取整；最终 maxHeight:none、overflowY:hidden，同时断言 scrollHeight<=clientHeight，不能仅隐藏裁剪。
- 默认开启 floatAvoidance；设置关闭后采用 sourceEnd.bottom+6，不作纵向视口钳制、不扫描正文和控件。窄偏好分支保留 doc/selection/session/command intent；有效变化用布局版本拒绝旧测量结果。
- 横向滚动条最终为 3 CSS px，圆角滑块、无箭头；命中继续读取实际 clientHeight 与边框。之前的尺寸候选已失效，未正式升级或发布。
- 无 scroll/resize 跟随。普通光标移动、滚动、CDP 视口变化不触发预览重排；新公式编辑及主动修改避让设置才测量。

## 验证

- 152 项单元测试通过；源码预检无语法、导入和旧路径错误。受控构建完成。
- 冻结最终版执行两个 public workflow 共 18 项：float-layout 10 项与 preview-controls 8 项全部通过，前后源码、完整应用资源和运行时清单一致。此记录为局部回归，不冒称重新执行 3.3.0 的 402 项全套。
- 6 个形态真正执行 12 步原生横向滚动条拖拽与 wheel 末端读取；覆盖键盘、鼠标、组合键、键鼠配合、拖拽，源码、选区、焦点和撤销保持。
- 实际高括号、分式及 14 行矩阵完整展开；矩阵核对独立 region 的 from/to、height>300 和最后一行。深浅主题的边界、完整字形及滚动条经独立 DeepSeek 视觉复核。
- 设置通过真实 More/Settings/checkbox/Esc 操作验证即时生效、跨窗口同步、重载保留。API stress 单独标记，不冒充原生快速点击。
- 独立 actual-function 模型从源码节点提取函数，held read→有效 ABA→旧 write 拒绝；删除唯一布局版本守卫产生真实写入红灯，精确恢复转绿。doc/epoch 退役与新写入正控通过。
- 布局负控恢复 96 px、旧高度钳制、关闭时视口钳制均命中对应红灯，恢复实际模块转绿。正式源码未作突变。
- 关闭避让后 12 次真实公式输入对应 24 次测量；正文 TreeWalker 节点与控件查询均为零。Range 计数包含必要源码锚点，不等于正文扫描；读耗时仅单次观察，不是整机输入延迟结论。
- 真实大文档使用隔离正文/profile 副本，验证目标公式、立即输入和一次撤销。原件及只读副本的字节身份保持；私有正文和截图不发布。

## 证据边界

初次 controls 探针误用了跨窗口共享的 zoom getter、把源码锚点 Range 计作障碍扫描、按单个 leaf 匹配矩阵 13，并猜错主题按钮 selector。失败记录保留；改为实际祖先 CSS zoom、独立节点/控件计数、连续 glyph 串及真实 theme-toggle 后同臂通过，产品未为错误观测而修改。最初标称 tall-matrix 的基线未证进入矩阵，只作为短公式再次观察；最终独立矩阵入口另作断言。

CDP resize 证明视口仿真，无原生 OS 窗口拖动大小的额外结论。全套历史证据不用于伪造新版本 PASS。交付证据保存在私有 preview-controls-3.3.1 目录，安装、发布状态在交付完成后追加。

## 交付核对

- 最终 3 px 两套冻结工作流 18/18、新便携版 8/8；完整 73 个运行文件、142 个 ASAR 成员在生产安装包、便携版、独立安装器中逐项一致。PE 严格同区间证明仅允许 RT_VERSION 与 checksum 变化，其他资源、填充与代码字节不变。
- 独立 UUID 身份在含空格路径实际安装及卸载通过，既有注册项恢复一致。正常安装由 3.3.0 升级为 3.3.1，完整载荷核对、程序/profile/注册项及快捷方式备份保留，profile 字节保持。
- 实装使用真实教材/profile 独立副本验证公式完整高度、关闭避让、立即输入、一次撤销；原文及副本字节保持，测试进程零残留。AssocQueryStringW 的 open 动词仍指向实际 V3 EXE，UserChoice 与第三方登记保留。
- ASAR：e882312ee83d9837f88f1b79113e643d37884488f35f45e42ce3f708b6c7e435；引擎：fdb77e4e519307acfe0007de4be7ef6a053cf9dcc70f522d07ccf8fe4b49fc52；实装 EXE：13c0060ba9c0c08c5d7a81ef8d66af30f8c67e29c4ca65124f6ea792cc023da8。
- Setup SHA-256：49b1970474bacaa0d973064f85b8a83fec9647e8c887ca531d5e2936678e4a00；portable SHA-256：1ca71418f0d051acd5d6508ec13dc19798a417da7df10b579c2b89d527b03550。
