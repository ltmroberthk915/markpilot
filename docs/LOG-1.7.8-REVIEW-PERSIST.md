# LOG 1.7.8 · AI 审阅态跨关闭/重开持久化（B4.2b P0）

## 目标

AI 修改进入“待确认”后，关闭编辑区或切走再回来，review 横幅和撤销组仍可继续使用；不自动保存、不自动撤销。

## 实现

- `lib/client.js`
  - 新增 `dsh-markdown-editor-typora:review:v1:<path>` localStorage 记录；
  - 记录严格校验：版本 v1、路径归一、`baseVersion`、1–20 个 UUID group、count 范围；
  - AI 编辑进入 review 时同步写记录；`保留并保存` / 撤销成功后删除；
  - 打开文档时若缓冲为脏且 baseVersion 匹配，同步装回 review（先抑制 autosave），再异步调 `documents.reviewGroups` 校验 group 仍存在且未撤销；
  - 校验失败或过期：只清 review，不改正文，给一次 notice；组已变/新 AI 编辑到达时不清新状态。
- `lib/documents-service.js`
  - `reviewGroups` 返回项增加 `undoneAt`，供客户端判断过期。

## 边界

- 版本不匹配：丢弃 review，不把旧 group 套到新正文；
- 存储不可用/配额满：review 仍在内存中，不影响当前编辑；
- 网络校验失败：保留本地 review，撤销时仍由宿主二次校验，绝不自动写盘；
- 关闭时若主编已经静默保存成功，重开为干净文档 → 清 review，不重复提示。

## 测试

```text
npm test
tests 448, pass 447, fail 0, skipped 1
```

新增客户端纯测试：路径大小写归一、baseVersion 不匹配拒绝、非法 JSON/空组/重复组/count 不足拒绝。

## 未完成

本批未在当前 DSH 进程做真机重启验证；打包 1.7.8，待重启后按以下链路复验：

1. AI 改 README → 出现 review；
2. 点左侧 Markdown 关闭 → 再打开；
3. review 横幅/差异还在；
4. 撤销本次 → 正文恢复、磁盘未变；
5. 版本已变的旧记录 → 不恢复、不误撤销。

## 打包

- `dsh-markdown-editor-typora-1.7.8.tgz`
- 大小：2,800,584 B
- shasum：`5fa0305ff77650426abd62a654aa1f7b71658d93`
