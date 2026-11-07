# DSH 插件 1.2.1 → 1.2.2 内部记录

2026-11-07。用户报告：点对话里的 md 文件链接，中间确实打开了编辑器，但 DSH 右侧栏也被宿主展开，挂着重复的「正在编辑」标签。

## 根因（录屏/截图实证）

- DSH 打开资源标签时会把右侧栏展开（宿主行为：内容看不见就不打开）。链接由对话调用 `ctx.sidebarRight.openResource()` 打开，插件 tab 类型接住后把文档接进中间，但**没有关掉右侧栏那个重复标签**。
- 1.2.1 里的 `collapseDuplicateRightbar()` 调 `ctx.layout.closeRightbar()`：该 API 只是向布局「报告面板已隐藏」，右侧栏包自己的展开态不变，实际收不起来（截图里右栏仍开着）。已删除该做法。

## 改动

- `EditorTabRedirect`：被动接管成功后，用标签 body 的 `props.actions.close()`（宿主 Tab 域公开的关闭动作）关掉这个重复标签；右栏只剩它时宿主会把空出来的右栏一并收起。
- 删除 `collapseDuplicateRightbar()` 及其两处调用与两个测试（无效方案）。
- 新增测试：链接接管进中间后，重复标签被关闭（`props.actions.close` 被调用一次）。

## 验证

- `node --test test/*.test.mjs`：327 项，326 通过，1 项 POSIX 在 Windows 跳过，0 失败。
- `node --test test/workspace-navigation.test.mjs`：39 项全过。
- 实机：见本轮截图（中间编辑器打开、右栏三个重复标签）。修复后需重启复验。

## 同族问题审计（2026-11-07 深夜）

「同族」= 调用宿主 API 时假设了它没有提供的东西、异常被静默吞掉、或 React hook 用错位置，导致功能看起来没生效。用 acorn 解析 `lib/client.js` 做 AST 审计。

### 已修

1. **hook 在回调里调用（React #321）** —— 关闭重复右栏标签时在 `setTimeout` 回调里调 `props.useTabInfo()`。改为使用渲染期已取得的 `tab` 记录（`tab.actions.close()`）。这是「点链接弹右栏」一直修不好的根因。
2. **`InputFaceTap` 的条件 hook** —— `if (hasEffect) React.useEffect(...)`。React 在模块加载时已 require 成功，改为无条件调用，消除 hook 顺序风险。
3. **`layout.closeRightbar()` 语义误解** —— 它只向布局「报告」面板已隐藏，右侧栏自己的展开态不变。已删除该做法，改由关闭重复标签让宿主按「唯一停靠标签」规则收起。
4. **`props.actions` 不存在** —— 关闭动作挂在 `tab.actions`（宿主文档：`tab.actions` 始终作用于自己的会话）；`props.actions` 仅作旧契约兜底。
5. **`SettingsInputStyle`** 是样式辅助函数却按组件命名、被当普通函数调用（无 hook，属误报），重命名为 `settingsInputStyle`，让后续 hook 审计不再产生假阳性。

### 护栏

- 诊断写入改为显式开关：`localStorage["dsh.markpilot.debug"] = "1"` 才写 `dsh.markpilot.tab-diag.v1`，正常安装不落盘。
- 核心路径不再纯静默：新增 `mpWarn(scope, message, error)`（每个 scope 只告警一次），接入「文档工作台 × 关闭」「浮层 × 关闭」「openResource 失败时展开右栏」「最近文档登记」四处。

### 审计结论（修复后）

- 40 处 hook 调用全部位于组件函数体内；回调内 hook：0；条件 hook：0；在 if/循环/try 内部的条件 hook：0；被当普通函数调用的组件：0。
- 全文件 225 处单行静默 catch，其中 47 处邻近核心路径；本次把用户可见的 4 处改成一次性告警，其余多为 DOM/样式/存储的防御性分支（失败可降级，保持静默）。

### 仍然存在的已知边界

- 右栏里由**旧版本遗留**的其它 md 标签（不是当前工作台那份文档）不会自动关闭：在它们自己的文档再次进中间时才会自我关闭；需要一次性手动关掉。
- 「× 关闭记忆」跨重启保留；被压住的工作目录点会话仍然不会自动打开编辑器（按用户要求保持）。

## 1.2.2 发布与验证（2026-11-07 23:05–23:12）

- Git main `200fa4d`，标签 `dsh-markdown-typora-v1.2.2`（轻量标签，与既有标签一致）。说明：1.2.1 未对外发布，1.2.2 一并覆盖它的改动。
- GitHub Release：https://github.com/ltmroberthk915/markpilot/releases/tag/dsh-markdown-typora-v1.2.2 ，资产 `dsh-markdown-typora-1.2.2.tgz`，2,755,798 字节。
- TGZ SHA-256：`c2a9d2f0cf5ccb4df5512e43e6f557188e1eb00eff8cea0c33cb83b614fba885`；GitHub 资产、npm 下载包、本地打包三方一致（GitHub asset digest 与 npm registry tarball 分别下载比对）。
- npm：`dsh-markdown-typora@1.2.2` 已发布，`dist-tags.latest = 1.2.2`。本轮发布需要 web 登录：PTY 里打印 https://www.npmjs.com/auth/cli/… ，浏览器确认后 `npm publish` 完成（npm 一次性发布令牌再次过期）。
- 官方市场：PR #12838 更新为 1.2.2（tarball 指向新 release，中英文描述补上「链接打开的文档会关掉右栏重复标签」），head `a045ef9`，CI 运行中。
- 开放市场：issue #213（已关闭）追加 1.2.2 评论 [issuecomment-6708802245](https://github.com/polang233/dsh-plugin-index/issues/213#issuecomment-6708802245)。
- 本机实装：`lib/client.js` 源与实装一致（SHA-256 前缀 `D7544898D7915AA4`），重启后生效。
- 测试：`node --test test/*.test.mjs` 328 项，327 通过、1 项 POSIX 跳过、0 失败；导航测试 40 项全过。
- README 只增不删：以 1.1.1 基线校验通过（README.md 913→965 行、README.en.md 920→972 行，原行全部按序保留）。
