# MarkPilot 2.0.11 引擎源码补充（engine source supplement）

插件包 `dsh-markdown-editor-typora@2.0.11` 内置的编辑器内核由本分支的 `dsh-markpilot/src-cm6/` 构建，本分支在标签 `dsh-markdown-editor-typora-v2.0.11` 的树上补齐这些引擎源码。

## 构成

相对标签树新增/更新的引擎文件（共 10 个，另加本文档）：

| 文件 | 相对 v3.6.21 标签 |
|---|---|
| `dsh-markpilot/src-cm6/main.js` | 修改（阅读位置挂载、公共 Markdown 入口） |
| `dsh-markpilot/src-cm6/extras.js` | 修改（跨表格拖选保持、脚注边界校验） |
| `dsh-markpilot/src-cm6/public-markdown.js` | 新增（公共 Markdown 解析入口） |
| `dsh-markpilot/src-cm6/reading-position.js` | 新增（阅读位置共享内核） |
| `dsh-markpilot/src-cm6/footnotes.cjs` | 修改（引用/定义成对校验） |
| `dsh-markpilot/src-cm6/footnotes-view.js` | 修改（脚注视图/导航） |
| `dsh-markpilot/src-cm6/footnote-export.js` | 修改（脚注导出计划） |
| `dsh-markpilot/test/footnotes.test.cjs` | 修改（脚注回归测试） |
| `dsh-markpilot/test/footnotes-durable.test.mjs` | 新增（脚注持久化测试） |
| `dsh-markpilot/test/public-markdown.test.mjs` | 新增（公共解析测试） |

`dsh-markpilot/renderer/vendor`、`tools/vendor`、`MarkPilot-CM6/renderer/vendor` 相对 `v3.6.21` 标签**无改动**（已在本次发布提交清单中逐项核对），因此标签树 + 本分支这些文件即为完整引擎构建输入。

## 重建方法

```bash
git checkout dsh-markdown-editor-typora-v2.0.11
git merge engine-src-2.0.11        # 或 git apply engine-source-2.0.11.patch
node build-from-source.cjs
node dsh-markdown-editor-typora/scripts/sync-core.mjs --check
```

预期产物：

- `MarkPilot-CM6/renderer/cm6/app.js`（与插件 `renderer-cm6/cm6/app.js` 同源同步）sha256 `11aa7c675f183dbe4dd69b2846de41a90503db9d2b76db73a7a948f52ac74d2d`（1,605,701 B）
- `dsh-markdown-editor-typora/scripts/sync-core.mjs --check` 通过：124 个核心文件、`coreHash=a223465c69c824b8d45350615d957fc4f567319be2fe977b782e06cb9eb74a2c`，与包内 `core.json` 一致。

## 证据

- 包内 `core.json` 的 124 个核心文件与 host 9 个文件逐文件哈希已在打包与验收时全部核验，`coreHash` 与发布包一致。
- `engine-source-2.0.11.patch`（同一 Release 的附件）与本分支内容等价，可直接 `git apply` 在标签树上。
