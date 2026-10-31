# 3.6.7 · 行内公式右边界 IME 双光标/重影修复

## 用户可见问题

在 EXE 中把光标放在行内公式（如 `$P$`）的右边界，再用中文输入法组字时：

- 渲染公式和它的字面源码同时出现，视觉上像两个光标/重影；
- 组字收尾后源码可能仍不收起；
- 原始拼音 `a` 可能被留在 Markdown 源码中（用户文档里出现过 `$P$a`）。

## 根因

`region-session.js` 的呈现态在组字第一笔事务时把 `editing` 从 true 翻成 false；
`buildInlineMath` 随即把源码范围替换成 KaTeX replace widget，但 CM6 在组字期间
会保留正在组字的文本节点。结果是 widget 与 `$P$` 源码同时存在于同一行，形成
重影/双光标。收尾时 head 已越过公式右边界，不再落入普通候选集，因此不会自愈。

## 修复

1. `region-session.js`
   - 组字期间的 compose 事务保留当前所有编辑中公式的 `editing/preview` 会话态，
     不让源码在组字中途被替换。
   - 只在组字结束后的显式刷新或普通事务中恢复渲染态。

2. `main.js`
   - `updateMathProjection` 不再因为 `docChanged` 无条件重建装饰：只有位置/内容/
     上下文/会话意图真正变化，或收到 `refreshMathAt` 时重建。组字插入落在公式
     右边界外时不再做源码↔渲染 DOM 替换。
   - `intent` 在 editing 态不再把 `selected` 算作变化（编辑态渲染分支不读 selected）。
   - `compositionstart` 记录选择触及的所有编辑中公式区域（含 `$A$$B$` 共享边界）。
   - `compositionend` 后派发一次无文档变更、不进历史的 `refreshMathAt` 刷新，
     等 CM6 的组字完全结束后再把源码干净地收起。

## 验证

- 基线 3.6.6（安装版，私有 profile、合成夹具）：组字中点显示 `P$P$a`，探针红。
- 修复后：
  - `probe-fix.cjs`：组字中只有 `$P$a` + 浮层，提交后只有渲染公式 + 啊；ASCII、
    公式内部组字、相邻 `$A$$B$`、多步 `a→ai→aih→aihao`、取消组字均绿。
  - 真实 220 行/9,033,846 B 文档副本（原 SHA256
    `38677C7E33805CB92A703617B46B88D7E25141F12D610DF25BD9EF69B917FEE9`）：
    真实鼠标点右边界、CDP 组字、提交、原生保存菜单回调、撤销/重做均绿。
  - 回归：`math-workflows` 16/16、`math-entry-workflows` 14/14、
    `selection-workflows` 30/30、`document-workflows` 10/10，均在使用 44.9.3
    运行时的隔离构建上通过；`preflight` 通过；`build-check` 源码 bundle 与仓库
    bundle 哈希一致。
  - 表格格内严格 CDP 组字臂仍报 `TRANSPORT/COMMIT_UNCONFIRMED`，属于已知的
    CDP 合成传输限制，不在本修复范围，也不冒充系统输入法通过。

## 交付物

- `D:\BuyKey\MarkPilot-3.6.7\markpilot-Setup-3.6.7.exe`
  SHA256 `78983fb36ea5a469fa8bdcab085e1b093c87b65ac8047ef69355bad498144717`
- `D:\BuyKey\MarkPilot-3.6.7\markpilot-3.6.7-portable.exe`
  SHA256 `5cdbdd6747a428b32d772e8bc5446e1d9a0df6bea3abf61c538f59a14d8b292b`
- 安装版：`D:\Users\Ming\AppData\Local\Programs\MarkPilot CM6`，版本 3.6.7，
  Electron/Chrome 44.9.3 / 152.0.7977.167，应用 payload SHA256
  `688664A30F868968B0ED471F8F4A93F3E4AABA85B96FC90D1BAD09DF93A3BF85`。

## 范围说明

探针用 Chromium CDP 的 `Input.imeSetComposition` + `Input.insertText`，不是
Windows 微软拼音候选窗口或物理键盘；原始拼音落进源码这一条由用户截图和
`$P$a` 文档内容支持，但本次没有直接复现 OS 候选窗中的提交路径。真实鼠标
点边界和提交后的 DOM/文档/磁盘结果已实测。
