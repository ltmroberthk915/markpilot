# DSH 插件 1.2.0 → 1.2.1 内部记录

2026-11-07。用户报告：点开会话后编辑器没有出现在中间；右侧显示的是宿主自带的 md 预览（标签带 MD 图标、路径行和刷新按钮），不是插件编辑器。

## 根因

- 1.2.0 的被动接管只发生在插件的 tab 组件（EditorTabRedirect）里。DSH 重启时会先从保存的布局里把上次的 md 标签恢复出来，这一步早于插件注册 tab 类型，标签因此落在宿主文档预览里，插件的路由代码根本不会运行。
- 现场核对：本机 localStorage（dsh-app://app）里 `dsh.markpilot.workspace-editor.v1` 记录了 `d:/buykey/deepseek harness 探索任务` 在 11:36 被 × 关过（用户要求永久压住，本轮不改该语义）；`d:uykeydeepseek harness 探索任务` 的最近文档只有 MarkPilot-GPT交接报告，不含截图里的北交所 md。

## 改动

- 新增 `adoptOpenNativeDocs()`：从 `sidebarRight.openTabs`（宿主公布的已开标签清单，条目 `{sessionId,tabId,kind,contentId}`）里挑出当前会话的 `.md` 资源标签，用 `workbenchEntryOfNative()` 转成工作台条目并打开。
- 触发点：① 插件 apply 后分 0/350/1200/3000/6000ms 扫几次（覆盖宿主恢复时序，定时器在 effect 清理时取消）；② 每次跨目录切会话、自动恢复没打开东西之后 260ms 再扫一次。
- 约束：仅当插件启用（enabled===true）、passiveOpenMode 为 workbench、当前没有编辑器开着、且该目录没有被 × 记忆压住时才接管；kind===TAB_KIND 的标签（插件自己的）跳过。
- 新增 `collapseDuplicateRightbar()`：接管完成后，若当前会话的右栏只剩这些 Markdown 预览标签，就调 `layout.closeRightbar()` 收起右栏——宿主恢复会话布局时会自己把右栏展开，看起来像「点会话就弹出文件栏」。右栏里还有别的标签（文件树等）时不动。
- 触发点：接管（启动扫描 / 被动路由）之后 400ms 调一次。
- × 关闭记忆保持永久（用户明确要求），未加 TTL / 一次性。

## 验证

- `node --test test/*.test.mjs`：328 项，327 通过，1 项 POSIX 在 Windows 跳过，0 失败。
- `node --test test/workspace-navigation.test.mjs`：40 项全过（新增：宿主恢复的 md 标签被接进工作台、overlay 模式与被压目录不接管、已有编辑器时不抢占、只含 Markdown 的右栏被收起、含别的标签的右栏不动）。
- 说明：仍无法用 computer-use 驱动 DSH 宿主窗口（HOST-GUARDED），装机后需重启验证。
