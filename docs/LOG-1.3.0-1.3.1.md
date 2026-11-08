# DSH 插件 1.3.0 → 1.3.1 内部记录

2026-11-08。分工：另一个会话负责 1.3.0 的 fail-closed 宿主修复（`0907658`）与把本地 trial 的 66 行 client 拦截合进 main（`53b811a`）；本会话负责 1.3.1 的收尾、测试补齐与发布。1.2.3 是未发布的本地版本，作废。

## 1.3.0 已发布内容（另一方）

- `0907658`：文件 API 的信任栅栏只认 `connection.requestRejection`；宿主缺该能力时全部路由 `503 host-auth-unavailable`，删除 loopback Host/Origin 兜底。
- npm `dsh-markdown-typora@1.3.0` + GitHub release `dsh-markdown-typora-v1.3.0`。
- 但 1.3.0 包打于 `0907658`，**不含** client 链接拦截。

## 1.3.1 内容

- `53b811a`：`installFileLinkInterceptor()` 在捕获阶段接管 `file://` Markdown 链接与绝对路径 `.md` 芯片，解析成本地路径后 `chooseWorkbenchDoc()` 进工作台，阻止宿主后续处理（此前 `file://` 空点、路径芯片会打开右栏 diff 页）。
- 本版补齐测试：`test/workspace-navigation.test.mjs` 新增 3 项（file:// 解析、路径芯片识别、打开后进工作台）与 `test/fixtures/workspace-navigation.cjs` 的四个测试面暴露。
- `package.json` → 1.3.1；plugin README 与顶层中英文 README 只增不删补 1.3.1 段。

## 验证

- 全量测试：331 项，330 通过、1 项 POSIX 跳过、0 失败（1.3.0 基线 330 项 + 3 项新增 - 2 项合并计数）。
- README 只增不删：以 1.1.1 基线校验，通过。

## 发布（待执行）

- tag `dsh-markdown-typora-v1.3.1`、GitHub release（附 tgz）、npm publish。
- 发完由另一方升级 headless、桌面重启后实测链接；市场 listing 更新同轮处理。

## 环境事实（本轮确认）

- desktop profile 的 `dsh-markdown-typora` 已改为 `link:D:/BuyKey/markpilot-public/dsh-markdown-typora`（repo 的 1.3.0），host 内存仍是旧 trial 1.2.3，需重启。
- `dsh plugin --profile desktop install` 会被「profile 由 Electron 独占管理」拒绝；在该 profile 目录跑 `pnpm install` 可完成（另一方已做，锁文件仅 link 相关 9 行）。
