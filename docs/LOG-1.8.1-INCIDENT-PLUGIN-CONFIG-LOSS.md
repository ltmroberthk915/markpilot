# LOG-1.8.1 · 插件配置丢失事故（2026-11-11）

> 类型：**工程事故 / 高危操作案例**
> 影响范围：DSH `desktop` profile 的插件组合；MarkPilot 1.8.1 开发会话
> 数据结论：**用户文档、仓库、MarkPilot 草稿与附件未发现丢失**；丢失的是 **profile 插件组合配置**
> 直接原因：`cordis.patch.yml` 与 `package.json` 的 `dsh.profile.bundles` 同时被截断
> 当前状态：两个文件均已恢复；除 MarkPilot client 入口暂时 disabled 外，其余插件已恢复

## 1. 事故摘要

开发 MarkPilot 1.8.1 的 B4.3 冲突界面时，为了让新的浏览器端 `client.js` 生效，在 DSH 生产渲染器上用 **DevTools 强制 reload**。reload 触发 DSH web-boot：

```text
Error: web boot: 1 entry did not activate
dsh-markdown-editor-typora: import failed (see console for the import error)
```

随后重启桌面端，用户界面表现为 **插件几乎全部消失**。检查发现 **两个 profile 文件同时被截断**：

```text
C:\Users\Ming\.dsh\profiles\desktop\cordis.patch.yml
  事故前：24922 B（有多个历史备份）
  事故后：  661 B（只剩少量 UI 配置）

C:\Users\Ming\.dsh\profiles\desktop\package.json
  事故前：2091 B（dsh.profile.bundles 25 项）
  事故后：1134 B（dsh.profile.bundles 只剩 base/web 2 项）
```

`package.json` 的插件依赖、`node_modules`、插件源码与用户文档都还在；被破坏的是 **profile 的 patch 组合层和 bundle 启用列表**，所以 UI 看起来像“插件全没了”。

## 2. 时间线（本地时间）

| 时间 | 事件 |
|---|---|
| 23:18 | DSH 首次 host/web-boot 崩溃，生成 `crash-2026-11-10T15-18-08-678Z-web-boot.log` |
| 23:43 | `cordis.patch.yml` 的完整备份 `cordis.patch.yml.bak-1794325904664`（24922 B） |
| 23:51 | 在 DSH 渲染器上用 DevTools 强制 reload；web-boot 报 MarkPilot client import failed，生成 `crash-2026-11-10T15-51-23-428Z-web-boot.log` |
| 00:01 | 发现界面上的插件入口几乎全部消失；检查 `cordis.patch.yml` 已缩成 661 B |
| 00:04 | 只恢复 `cordis.patch.yml`（24922 B，SHA256 = `B2F77CB985DEDECA76A8F18D8A931BD9BBA1423782A8F6912177E8BCD167625D`）；**重启后插件仍然为空** |
| 00:06 | 误以为只是 MarkPilot client 入口阻塞，在 profile patch 末尾临时加入 `dsh-markdown-editor-typora: disabled: true`；这只能避免坏 entry，不能恢复 bundle 启用列表 |
| 00:09 | 用 `plugin_manager list_bundles` 发现所有第三方 bundle 都是 `installed:true, enabled:false`；检查 `package.json`，`dsh.profile.bundles` 只剩 base/web 两项 |
| 00:09 | 保留当前依赖版本，只从 `package.json.bak-router-restore-20261108-220458` 恢复 25 项 `dsh.profile.bundles`；保留当前已升级的 `balance-dsh@2.2.5`、`dsh-free-search@0.9.39` 等依赖版本 |
| 00:10 | 重启后插件恢复；MarkPilot 仍由临时 disable 行关闭，等待单独修复 client import |

> 注意：**patch 为什么被写成 661 B，目前没有可证明的唯一根因**。它与 DevTools reload、插件 enable/disable、web-boot 失败和进程重启在同一时间窗口内发生；本文只记录已观测事实，不把相关性写成结论。

## 3. 根因链（已证实的部分）

1. **DevTools 强制 reload 不是开发插件的安全热更新方式。**
   MarkPilot 是 DSH 的 client 插件；reload 时 Web boot 会重新 import 所有 client entry。只要一个 entry import 失败，boot 就会报“1 entry did not activate”，用户看到的是整个 UI 插件面异常，而不只是 MarkPilot。

2. **插件组合配置不在 git 里，且是单文件。**
   `C:\Users\Ming\.dsh\profiles\desktop\cordis.patch.yml` 是 profile 的 patch 层；它不在 `markpilot-public` 仓库内，不受 `git status`/`git diff` 保护。单文件被截断时没有仓库可回滚，只能依赖同目录的 `.bak-*`。

3. **恢复成功依赖“提前存在完整备份”。**
   这次能恢复，是因为 23:43 的完整 `.bak-1794325904664` 还在。若没有这份备份，661 B 的文件无法还原出 24 KB 的插件组合。

4. **“插件全没了”是表现，不是依赖或包被删除。**
   `profiles/desktop/package.json` 的依赖、`node_modules` 和插件源码均在；恢复后第三方 bundle 重新 enabled，UI 与 host 条目恢复。因此不要把“UI 空列表”当成“包被卸载”。

5. **只恢复 `cordis.patch.yml` 不够；`package.json.dsh.profile.bundles` 才是“装不装”的开关。**
   patch 负责覆盖/插入/禁用 entry，`dsh.profile.bundles` 负责把 bundle 纳入 profile。两者同时被截断时，只恢复 patch 会出现“entry 有定义、bundle 未启用”的假恢复：host 的 `list_plugins` 仍能看到大量内置 entry，但第三方 bundle 全是 `enabled:false`。

6. **`plugin_manager list_plugins` 不能单独当诊断依据。**
   它列出的是已激活/可寻址的 entry；内置 entry 会让人误以为“插件都在”。必须同时看 `plugin_manager list_bundles` 的 `enabled`/`installed`，以及 `package.json` 的 bundles 长度。

## 3.1 连续失败复盘（为什么修了三次）

| 轮次 | 假设 | 实际检查 | 结果 | 教训 |
|---|---|---|---|---|
| 第 1 次 | 只是 `cordis.patch.yml` 被截断 | 只对比/恢复 patch 文件 | 重启后插件仍为空 | profile 组合至少有两层：patch 与 bundles；不能只修看见的第一个文件 |
| 第 2 次 | 剩余问题是 MarkPilot client import 阻塞 | 在 patch 末尾 disable MarkPilot | 重启后插件仍为空 | “禁用坏 entry”不等于“启用 bundle”；entry 不存在时 disable 也不会产生其它插件 |
| 第 3 次 | 第三方 bundle 本身没有被启用 | `plugin_manager list_bundles` 全部第三方 `enabled:false`；`package.json` 的 bundles 只剩 base/web | 恢复 25 项 bundles 后插件恢复 | 先看 bundle 启用状态，再决定是否重启；不要用反复重启代替取证 |

三次失败暴露的是同一类错误：**把“界面看不到”当成单一原因，修一个文件就重启验证**。正确顺序应是：

1. 先只读取证：`cordis.patch.yml` 大小/hash、`package.json` 的 `dsh.profile.bundles`、`plugin_manager list_bundles` 的 `enabled/installed`、web-boot 日志；
2. 确认是 patch 丢失、bundle 未启用，还是某个 client entry import 失败；
3. 一次只改一个层，保留备份；
4. 改完先静态核对（JSON 可解析、bundle 数、目标 entry 的 disabled 状态），再重启；
5. 重启后先看 `list_bundles`，再看 UI，避免“界面空 = 没修好”的重复试错。

## 4. 恢复步骤（可复用）

> 原则：先保留损坏现场，再从完整备份恢复；不删除任何 `.bak-*`。

```powershell
$profile = 'C:\Users\Ming\.dsh\profiles\desktop'
$c = Join-Path $profile 'cordis.patch.yml'

# 1) 只读诊断：大小、时间、哈希、历史备份
Get-Item $c | Select-Object Length,LastWriteTime
Get-FileHash $c -Algorithm SHA256
Get-ChildItem $profile -Filter 'cordis.patch.yml*' |
  Sort-Object LastWriteTime -Descending |
  Select-Object Name,Length,LastWriteTime

# 2) 选一个完整备份（本次用 24922 B 的 23:43 备份）
$b = Join-Path $profile 'cordis.patch.yml.bak-1794325904664'
Get-Item $b | Select-Object Length,LastWriteTime
Get-FileHash $b -Algorithm SHA256

# 3) 先另存损坏现场，再恢复；不要删旧文件
$safety = $c + '.broken-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
Copy-Item -LiteralPath $c -Destination $safety
Copy-Item -LiteralPath $b -Destination $c -Force
Get-FileHash $c -Algorithm SHA256
```

恢复后先核对 `dsh.profile.bundles`，**不要**只恢复 patch：

```powershell
$p = Join-Path $profile 'package.json'
Get-Item $p | Select-Object Length,LastWriteTime
node -e "const p=require(process.argv[1]); console.log(p.dsh.profile.bundles.length); console.log(p.dsh.profile.bundles.join(','))" $p

# 本次：当前 1134 B 的 package.json 只剩 base/web；完整备份列出 25 项
$pb = Join-Path $profile 'package.json.bak-router-restore-20261108-220458'
Get-Content $pb | Select-Object -First 70

# 只重建 bundles 列表，保留当前 dependencies 版本（不要整包回滚旧版本）
# 关键：balance-dsh@2.2.5、dsh-free-search@0.9.39、dsh-codex-style-computer-use@2.2.9 等保持现状
```

本次最终恢复的 25 项 bundles：

```text
@deepseek-ai/dsh-base
@deepseek-ai/dsh-web-app
@deepseek-ai/dsh-experimental-agent-team-profile
@deepseek-ai/dsh-experimental-voice-input-bundle
@deepseek-ai/dsh-experimental-auto-review
@deepseek-ai/dsh-experimental-inspector-profile
dsh-codex-style-computer-use
dsh-web-search-glm
@deepseek-ai/dsh-experimental-tool-worktree
@deepseek-ai/dsh-experimental-terminal-bundle
@deepseek-ai/dsh-experimental-session-search
@deepseek-ai/dsh-experimental-session-titles-bundle
@deepseek-ai/dsh-experimental-plugin-market-bundle
@wxg-prc-cpg/browser-skill-dsh-plugin
dsh-markdown-editor-typora
dsh-agent-remote
balance-dsh
dsh-dream-skin
dsh-see-now
dsh-team-flow-continuous
dsh-session-telecom
dshmarket
dsh-free-search
dsh-open-market
dsh-pets-multiworkers
```

恢复后若某插件 client import 仍失败：
- 在 profile patch 末尾加最小 disable，先让其他 entry 启动：
  ```yaml
  - id: dsh-markdown-editor-typora
    disabled: true
  ```
- 重新启动 DSH，确认其他插件恢复；
- 再单独修该插件的 client 入口，修好后删除 disable 行并重启。
- **顺序不能反**：先恢复 bundle 列表，再处理坏 entry。bundle 未启用时，disable entry 不会让其它插件出现。

## 5. 警告与硬规则

> **实机测试硬规则（2026-11-11 追加）**：MarkPilot 的任何实机测试只用 **DSH Web 端**（浏览器 + 独立测试 profile），不启动、不操作 DSH Desktop。Desktop 只用于用户明确要求后的最终安装验收，且不得在 Desktop 上批量开关插件、改 profile 或强制 reload。

### 5.1 禁止

1. **禁止在用户生产 DSH 上用 DevTools reload、Ctrl+R、地址栏刷新来加载插件改动。**
   开发插件应使用：插件管理器 disable/enable → 正常重启 DSH → 只在独立测试 profile/副本里做 reload 实验。
2. **禁止在未备份 `cordis.patch.yml` 和 `package.json` 的情况下做批量插件 enable/disable。**
   每次批量操作前复制带时间戳的 `.bak`，并记录大小与 SHA256；两个文件都可能被截断。
3. **禁止把“UI 插件列表为空”直接当成“插件包损坏”而重装/删除 `node_modules`。**
   先看 `package.json.dsh.profile.bundles`、profile patch、`plugin_manager list_bundles` 和 web-boot 日志。
4. **禁止在 web-boot 报 “1 entry did not activate” 后连续重试 reload。**
   先定位失败 entry；连续 reload 只会重复中断，并扩大“配置被改写”的窗口。
5. **禁止删除 `%APPDATA%`、`.dsh`、attachments、sessions、storages 等用户数据。**
   本次只改 profile 的 patch 与 package.json；恢复依靠同目录备份。

### 5.2 必须

1. 改 `~/.dsh` 前先备份受影响文件；恢复时保留 broken 现场。
2. 用**大小 + SHA256 + 时间**判断文件是否完整，不用“看起来还在”。
3. web-boot 失败时先读：
   ```text
   C:\Users\Ming\AppData\Roaming\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log
   ```
   再查 `plugin_manager list_bundles` 的 `installed/enabled`，以及 `package.json` 的 `dsh.profile.bundles` 长度；`plugin_manager list_plugins` 只能证明 entry 是否存在，不能证明 bundle 已启用。
4. 插件 import 修复验证要在**独立测试 profile** 或受控副本中进行；生产 profile 只接受已验证版本。
5. 事故后先恢复环境，再继续产品功能；恢复动作本身也要留时间线和证据。
6. 恢复 bundle 列表时**只重建 `dsh.profile.bundles`**，保留当前 `dependencies` 版本；不要用旧 `package.json` 整包覆盖，否则会把已升级的插件版本回退。

## 6. 与 MarkPilot 1.8.1 的关系

- 本次事故发生在 B4.3 冲突界面的**真机验证阶段**；产品代码未打包、未进入正式安装。
- 代码侧当时状态：`npm test` 464 / 463 pass / 1 skip / 0 fail；`sync-host`、`sync-core` 通过；`coreHash` 未变。
- B4.3 真机验证中另发现：新建文件首次保存后 live join 成功（room 版本/ack），但随后 AI append 出现 `Position 22 is out of range`；已改为“保存后 clean 重载再 bind”，该版尚未完成真机复测。此问题与本次 profile 配置丢失是**两件独立的事故**，不能混写。
- 2026-11-11 起实机测试改为 **DSH Web 端 + 独立 `mp-web-test` profile**；Web 端已确认 MarkPilot 加载、冲突面板和 no-op resolve 路径。单独记录见 [LOG-1.8.1 · B4.3 Web 实机测试记录](LOG-1.8.1-B4.3-WEB-REALTEST.md)。

## 7. 待办

- [x] 恢复 `cordis.patch.yml`（24922 B，哈希与备份一致）。
- [x] 恢复 `package.json.dsh.profile.bundles`（25 项），保留当前依赖版本。
- [ ] 从 profile patch 删除临时 `dsh-markdown-editor-typora: disabled: true`，仅在 client import 修复并验证后。
- [ ] 在**独立测试 profile** 验证 MarkPilot client 能在 web boot 正常 import。
- [ ] 真机复测“新建→首次保存→AI 编辑→冲突面板”链路。
- [ ] 若再次出现配置截断，保留现场并同时对比 `cordis.patch.yml*` 与 `package.json*`，不要先 reload。
- [ ] 将 profile 关键文件（`cordis.patch.yml`、`package.json`）纳入开发前的只读快照脚本（不自动写回）。

## 8. 最终经验（本次有效）

1. **profile 有两个独立层**：`cordis.patch.yml` 决定 entry 的覆盖/插入/禁用；`package.json.dsh.profile.bundles` 决定 bundle 是否参与组合。只看前者会得到“假恢复”。
2. **决定性诊断是 `plugin_manager list_bundles`**：第三方 `installed:true, enabled:false` 就是 bundle 未启用；`list_plugins` 里的内置 entry 再多也不能证明第三方插件已加载。
3. **恢复时只重建缺失字段**：本次只恢复 `dsh.profile.bundles`，保留当前 `dependencies`；整包覆盖旧 `package.json` 会把已升级版本回退。
4. **一次只改一层，改完先静态核对再重启**：JSON 可解析、bundles 数量、目标 entry 的 disabled 状态都对上，再重启；不要用连续重启代替取证。
5. **现场和备份都要留**：broken 文件、完整备份、恢复前快照三份并存；恢复脚本先复制再覆盖。
6. **MarkPilot 的临时 disable 是隔离措施，不是修复**：其它插件恢复后，仍需在独立测试 profile 修 client import，再删除 disable 行。
7. **实机测试一律走 DSH Web 端**：用浏览器 + 独立测试 profile；Desktop 只做用户明确要求的最终安装验收，不承担日常开发验证。

## 9. 一句话教训

**“profile 的 patch 与 bundles 要一起看；UI 空列表先用 `list_bundles` 确认 bundle 是否 enabled，再恢复对应字段；生产环境不强制 reload、不连续重启。”**
