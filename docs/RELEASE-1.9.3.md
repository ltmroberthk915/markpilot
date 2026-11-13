# MarkPilot 1.9.3（P5 可选守卫补丁）

- 修复 `apply` 未定义 `options` 导致 write guard 不安装。
- 可选 `fsSessionIntents`（默认 false）包装 ctx.fs 五个写方法；dirty 拒绝、moveFile 同时检查目的地。
- 包装 disposer 还原原方法；apply 级测试覆盖默认关/开启/严格布尔。
- 全量：534 / 533 pass / 1 skip / 0 fail。

## 产物

- `dsh-markdown-editor-typora-1.9.3.tgz`
- 150 files / 2.8 MB
- SHA256 `4FBCF046870C80E2A72E3377E152FBA2A209C2A993E116C50E6CB71D7A5EC866`
