# MarkPilot 2.0.9 引擎源码补充（engine source supplement）

插件包 `dsh-markdown-editor-typora@2.0.9` 内置的编辑器内核由本分支的 `dsh-markpilot/src-cm6/` 构建，本分支在标签 `dsh-markdown-editor-typora-v2.0.9` 的树上补齐这些引擎源码。

## 构成

相对标签树新增/更新的引擎文件（共 8 个，另加本文档）：

| 文件 | 相对 v3.6.20 标签 |
|---|---|
| `dsh-markpilot/src-cm6/main.js` | 修改（围栏显形、表格列对齐、脚注扩展挂载） |
| `dsh-markpilot/src-cm6/extras.js` | 修改（脚注入口/导出、表格对齐 UI） |
| `dsh-markpilot/src-cm6/region-index.js` | 修改（围栏可见性） |
| `dsh-markpilot/src-cm6/region-session.js` | 修改（公式选区边界） |
| `dsh-markpilot/src-cm6/footnotes.cjs` | 新增（脚注解析器） |
| `dsh-markpilot/src-cm6/footnotes-view.js` | 新增（脚注视图/导航） |
| `dsh-markpilot/src-cm6/footnote-export.js` | 新增（脚注导出计划） |
| `dsh-markpilot/test/footnotes.test.cjs` | 新增（脚注回归测试） |

`dsh-markpilot/renderer/vendor`、`tools/vendor`、`MarkPilot-CM6/renderer/vendor` 相对 `v3.6.20` 标签**无改动**（已逐项核对），因此标签树 + 本分支这些文件即为完整引擎构建输入。

## 重建方法

```bash
git checkout dsh-markdown-editor-typora-v2.0.9
git merge engine-src-2.0.9        # 或 git apply engine-source-2.0.9.patch
node build-from-source.cjs
node dsh-markdown-editor-typora/scripts/sync-core.mjs --check
```

预期产物：

- `MarkPilot-CM6/renderer/cm6/app.js` sha256 `be10e2530b59f87d8990c44ad480450f30957302a101863f62b89f1ae947c1c8`（1,573,323 B）
- `dsh-markdown-editor-typora/scripts/sync-core.mjs --check` 通过：124 个核心文件、`coreHash=dd7b3f313b7440f6460ecd86ffeb01d911eb02de7669f5e8aa385f20030eee62`，与包内 `core.json` 一致。

## 证据

- 输入文件最后修改时间均 ≤ 2026-11-14 00:36:21 (+08)，早于包内 `core.json` 的 `syncedAt` 2026-11-13T16:36:30.976Z（= 2026-11-14 00:36:30 +08）。
- 包内 `core.json` 逐文件哈希已在打包时全部核验（124 文件 + host 9 文件）。
- `engine-source-2.0.9.patch`（同一 Release 的附件）与本分支内容等价，可直接 `git apply` 在标签树上。
