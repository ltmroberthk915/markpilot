# LOG 1.7.6 · Markdown 编辑区启动预热与骨架屏

## 基线测量

在重载后的客户端上打点，点击左侧 Markdown 到正文应用完成：

| 阶段 | 相对点击耗时 |
|---|---:|
| entry-effect | 0 ms |
| openWorkspace() | +1 ms |
| bridge-ready | +718 ms |
| init | +796 ms |
| commit（正文应用完） | +853 ms |

iframe 自身 `DOMContentLoaded/load` 约 385 ms，资源 fetch 9 ms。结论：**约 85% 的时间花在 iframe/CM6 启动，不是按钮、不是 docs/recent、不是打开文档**。

## 本批实现

1. **开机预热（只读、不入 live 房间）**
   - DSH 启动约 1 秒后，在 idle 时读取当前工作区最近文档；
   - 用隐藏 `DocsWorkbench` 打开该文档，`api open` 传 `live:false`；
   - 不建立 live room、不参与 AI 写入、不自动保存；
   - 用户点击左栏时，复用同一 `DocsWorkbench`/iframe，只把舞台从 offscreen 变为可见；
   - 显示时再以 `live:true` 重新打开，若磁盘已变则按正常打开/冲突纪律刷新。

2. **骨架屏**
   - `EditorTabBodyInner` 增加 `booted` 状态；
   - `init` 前显示“正在打开编辑器…”，绝对定位、`pointer-events:none`，不改变 rail/iframe 布局；
   - 预热命中时通常瞬间消失；预热未命中时覆盖原来 0.8 秒的空白等待。

3. **关闭/切换的保活边界**
   - 预热实例在初次显示前是**只读、无 live**；
   - 用户关闭编辑区时销毁该实例，不保留隐藏 live room/隐藏写者，避免 AI 编辑落到不可见缓冲区；
   - 因此本批保证安全，但“关闭后再次打开”仍是重新启动（后续可做无 live 的 shell 保活）。

## 测试

```text
npm test
tests 448, pass 447, fail 0, skipped 1
sync-host --check  OK 9 files
sync-core --check  OK 124 files
```

新增 `rail-layout` 骨架屏测试：init 前 `display:flex`，init 后 `display:none`，且 `position:absolute/pointer-events:none` 不占布局。

## 打包

- `dsh-markdown-editor-typora-1.7.6.tgz`
- 大小：2,800,291 B
- shasum：`82193ac6bb2326e5ebc9bb6bff963f03f1524016`

## 激活状态

源码已合并到 `main`（`e29ee09` + 测试合并 `3e0f685`），当前运行中的 DSH 仍是旧客户端；需要重启 DSH 后才会加载预热/骨架屏代码。重启后应验证：

- 点击 Markdown 到正文出现明显快于基线；
- 启动约 1 秒后 `rooms` 仍为空（预热不入 live）；
- 点开后正常加入 live，且编辑/保存不受影响；
- 未命中预热时先看到骨架屏，不出现空白。
