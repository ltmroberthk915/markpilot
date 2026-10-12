# MarkPilot region workflow tests

Use Node.js 22 or newer and PowerShell 7 on Windows. Install dependencies with `npm ci --prefix tools/quality`. The runner expects a compatible CM6 desktop artifact with mpEngine/mpHost quality interfaces; installed 3.2.13 was used for the recorded study.

### 私有数学语料的特征抽样

`corpus-math-workflows.cjs` 先将完整语料按原字节复制并装入实际产物，再用保留引用/列表上下文的片段测试真实字形点击、立即输入、Undo、Redo 后立即输入、反向选择、原生复制/剪切/粘贴及完整保存字节。系统剪贴板会恢复，只关闭本工具拥有的测试进程。原件不参与编辑。

```powershell
node tools/quality/corpus-math-workflows.cjs --corpus <私有语料.md> --samples <私有manifest.json> --exe <实际产物.exe> --expected-sha256 <完整SHA256> --out <空的私有目录>
```

Manifest 格式如下；`corpusSha256` 对应原文件完整字节，`span` 是 `text` 内目标公式的 UTF-16 源范围。case ID 只用小写字母、数字和连字符。先校验全部样本身份及范围，再运行 GUI。

```json
{
  "corpusSha256": "<完整SHA256>",
  "cases": [{
    "id": "plain-inline",
    "text": "BEFORE\n\n$x+y$\n\nAFTER\n",
    "span": {"from": 8, "to": 13},
    "features": ["inline", "plain"]
  }]
}
```

输入链只确认进入目标公式源码范围，并按实际原生选区核对编辑结果；不独立证明字形的精确落点。保存不等于重开，语料扫描数量不等于渲染成功数量，CDP 输入不等于系统 IME。本工具不声称拖拽、跨屏、所有环境内部编辑或性能已覆盖。报告不记录正文，但 fixture、manifest.text、截图仍含原文，应留在私有输出；公开的是工具源码与合成夹具。[统一交互方案与实测边界](../../docs/LOG-3.2.13-REGION-ARCHITECTURE.md)

### Formula preview layout workflow

`float-layout-workflows.cjs` generates eight fixtures: long and nested quotes, block math, lists, fractions, a two-row matrix, split view, and a short-formula control. It uses actual renderer keyboard/mouse input to check fixed plain-glyph source positions, immediate edits, Undo/Redo, scrollbar reading, local wheel endpoints, Shift-click selection and narrow/wide layout. Each scroll phase records its own geometry and trusted-event trace.

```powershell
node tools/quality/float-layout-workflows.cjs --exe <compatible-CM6.exe> --expected-sha256 <complete-SHA256> --out <empty-private-directory>
```

`MP_QUALITY_CASES` filters case IDs; zero selected cases fail. Optional `--sample <local-copy.md>` adds one private excerpt arm, requiring UTF-8 LF text whose first target inline formula starts with the ordinary mapped letter `e`. This is a bounded snippet contract, not arbitrary corpus support; use the corpus workflow for manifest-bound samples. Keep excerpts, fixtures, screenshots, profiles and receipts private.

Window sizing uses Chromium viewport emulation, not native OS resizing. Recorded inputs do not establish OS IME or physical accelerator behavior; caret markers show measured CM coordinates. The probe requires a compatible desktop artifact and does not ship editor implementation or installers. [Layout scope and verified delivery](../../docs/LOG-3.2.14-FLOAT-LAYOUT.md).
