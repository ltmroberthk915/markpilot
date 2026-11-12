# MarkPilot 2.0.5 交接文档（给 GPT）

- 交接时间：2026-11-12
- 仓库：`D:\BuyKey\markpilot-public`
- 当前分支：`b4.2b-review-chain`
- 当前 HEAD：`baf48be`（`docs: market listing 2.0.5`）
- 插件包：`dsh-markdown-editor-typora@2.0.5`
- 桌面已安装：2.0.5
- 工作区至少还有未跟踪的历史 `dist/`、旧 `.tgz`；不要误提交，也不要删用户文件。

## 0. 先看结论

### 已发布且已验证
- GitHub Release：`dsh-markdown-editor-typora-v2.0.5`，Latest，非 Draft / 非 prerelease。
- npm：`dsh-markdown-editor-typora@2.0.5`，`dist-tags.latest = 2.0.5`。
- npm 包与 GitHub Release 资产 SHA256 完全一致：
  `D2F3468FD3724264EB0617D36C57CF0BD5ADA19AB3A647275B522CE8978106BA`，2,827,024 bytes。
- 开放市场 `polang233/dsh-plugin-index`：Issue #437 已被维护者关闭，评论“MarkPilot 2.0.5 已收录”。
- 官方市场 `awesome-dsh-plugin`：PR #14521 已提交，CI 已通过（check pass / submission gate pass），等待维护者合并；当前 main 条目仍是 1.8.1。
- 单元/集成测试：544 tests / 543 pass / 1 skip / 0 fail（代码与 2.0.5 包一致；之后只加了文档提交）。

### 还没完成的关键项
1. **主仓库 PR #14 仍是 Draft，且分支比 main 领先 128 个提交**  
   `main` 仍在 `5b0546d`；2.0.5 的发布来自 `b4.2b-review-chain`，不是 main。需要决定是否 review/merge。
2. **官方市场 PR #14521 还未合并**  
   CI 已绿，mergeable 当时是 UNKNOWN；不要重复开第二条更新 PR。
3. **普通保存失败会残留 `.mp-tmp-*`**  
   只读测试时在源目录观察到 `.mp-tmp-38908-*`，时间点早于 saveAs，来源是普通保存路径，不是另存为的 fallback。2.0.5 已修 saveAs 的临时文件清理，但普通保存这条还没修。
4. **POSIX 支持是未完成面**  
   `validSaveAsPath` 只接受 Windows 绝对路径；POSIX 的 native saveAs 分支存在但生产不可达、测试不覆盖。
5. **read-only 语义不一致**  
   普通保存的 native 分支不守 read-only；saveAs 守 read-only。需要产品拍板统一或明确写进契约。
6. **测试仍有缺口**  
   没有真实 dsh-fs-sandbox 集成测试；没有 POSIX 运行；没有完整的失败注入；纯外部写冲突 UI 未稳定强制复现；saveAs 的 version 作为下一次 save baseVersion 未测。
7. **另一条线：computer-use**  
   npm 2.3.0 已是 latest，GitHub Release v2.3.0 已发布；但 npm `next` 仍指 2.2.9，需要执行 dist-tag 对齐。

## 1. 可直接复核的线上状态

```powershell
cd D:\BuyKey\markpilot-public
git log -1 --oneline
git rev-list --left-right --count main...HEAD
npm view dsh-markdown-editor-typora@2.0.5 version dist.shasum --json
npm view dsh-markdown-editor-typora dist-tags.latest --json
gh release view dsh-markdown-editor-typora-v2.0.5 --json tagName,isDraft,isPrerelease,url,assets
gh pr view 14 --json state,isDraft,title,url,baseRefName,mergeable
gh pr view 14521 --repo awesome-dsh-plugin/awesome-dsh-plugin --json state,mergeable,url
gh issue view 437 --repo polang233/dsh-plugin-index --json state,url
```

预期要点：
- `HEAD = baf48be`
- `main...HEAD = 0 128`
- npm latest = `2.0.5`
- Release 非 draft、非 prerelease
- PR #14 Draft
- 开放市场 Issue #437 CLOSED
- 官方市场 PR #14521 OPEN（以实际为准）

## 2. 已完成的内容

- P4 文件生命周期 UI：
  - missing 横幅
  - rename candidate 横幅
  - readonly 横幅与重试
  - recovery center
  - Save As 真机成功
  - 共享会话结束/冲突 + 重载
- Save As 修复：
  - `ctx.fs.writeText(createIfAbsent)` 优先
  - 仅 `FS_SANDBOX_DENIED` 且非 read-only 时，走本地 staged create
  - Windows `safeFile.prepareFile` + commit；POSIX `open/sync/link`
  - `MP_FILE_CONFLICT/EEXIST` → `FS_EXISTS`
  - 真实 `fs.stat` version 回执
  - 新副本用 `textCodec.encodeDocument`，拒绝孤立代理
  - 成功/普通失败清理 `.mp-tmp-*`，保留 `preserveTemp`
- 2.0.5 真机：只读源另存为副本成功，源文件未覆盖，目录无 temp。
- 发布链路：
  - GitHub Release + asset 上传
  - npm publish（WebAuthn 指纹确认）
  - 官方市场 PR #14521
  - 开放市场 Issue #437，维护者已收录
- 文档：
  - `docs/RELEASE-2.0.5.md`
  - `docs/LOG-1.8.1-B4.3-WEB-REALTEST.md` §72–§76
  - 本文件

## 3. 未完成 / 风险清单

### P0：发布一致性
1. **PR #14 仍是 Draft，main 不是 2.0.5**
   - 分支：`b4.2b-review-chain`
   - 比 main 领先 128 个提交
   - 如果决定合并：先把 PR #14 标 Ready，再 review/merge 到 main；不要 force push 覆盖。
   - 合并后核对 main 上 `package.json` 是 2.0.5，且 tag `dsh-markdown-editor-typora-v2.0.5` 仍指向发布提交（`551c2aa`）。
2. **官方市场 PR #14521 等待合并**
   - 不要重复开新 PR；先看 #14521 是否已合并。
   - 合并后检查市场 README 是否自动重生成，条目 tarball 是否指向 `dsh-markdown-editor-typora-v2.0.5`。
3. **GitHub Release body / PR body 可能落后于 docs**
   - `docs/RELEASE-2.0.5.md` 后来补了发布状态；Release 创建时用的是旧正文。
   - 可执行 `gh release edit dsh-markdown-editor-typora-v2.0.5 --notes-file docs/RELEASE-2.0.5.md`，但这是公开编辑，先确认。
4. **开放市场“已收录”需最终核对**
   - Issue #437 已关闭，维护者说已收录；检查 index 仓库中的 MarkPilot 条目和 tarball 是否确实为 2.0.5。

### P1：代码与契约
5. **普通保存失败残留 temp**
   - 现象：只读源正常保存失败后，源目录出现 `.mp-tmp-<pid>-<uuid>`（13 B），时间早于 saveAs；saveAs 本身无残留。
   - 待查：`apiSave` → `directWriteText` → `localDocuments.save` / safeFile 的失败清理路径。
   - 不要把它误归因于 2.0.5 的 saveAs fallback。
6. **POSIX saveAs**
   - `validSaveAsPath` 只接受 Windows 绝对路径；POSIX 上 saveAs 会 400。
   - `apiSaveAs` 的 POSIX `open/sync/link` 分支不可达，且测试套件是 Windows 形状。
   - 决定：明确“仅 Windows 支持”并写文档，或重做路径校验/补 POSIX CI。
7. **read-only 不对称**
   - 普通保存 native 分支不守 read-only；saveAs 守 read-only。
   - 要么统一（推荐普通保存也尊重策略），要么把“编辑面是操作者能力、saveAs 是例外”写进契约。
8. **`MP_FILE_CONFLICT` 双义**
   - 既表示“目标已存在”，也表示“临时文件被改、停止替换”；当前都映射为 `FS_EXISTS`，后者会误报。
9. **崩溃期 `.mp-tmp-*` 无 sweeper**
   - 进程在 prepare 与 commit 之间被硬杀会留下临时文件；当前只有成功/普通失败清理。
10. **父目录 symlink/junction 未复检**
    - saveAs 只 `mkdir -p`，没有像 `createExactDraft` 那样做 target 目录 dev/ino 复核。
11. **编码边界**
    - 另存为副本固定 UTF-8 / LF / 无 BOM，不继承源文件 BOM/EOL/UTF-16；这是已知边界，需在 README/Release 明示。
12. **`payload.path` legacy shape**
    - `apiSaveAs` 仍接受 `payload.path` 作为 target 的 legacy test-only 形状，无测试引用；建议删除或明确注释。

### P2：测试缺口
13. 没有真实 `dsh-fs-sandbox` + policy 集成测试；现有 fallback 测试是假 provider。
14. 没有 POSIX 运行（macOS/Linux 必红）。
15. 没有失败注入：磁盘满、只读目录、prepare 失败、commit 失败、崩溃。
16. 没有测试“saveAs 返回的 version 能作为下一次 save 的 baseVersion”。
17. 没有测试多级父目录创建、UNC、父目录 junction。
18. 纯外部写冲突 UI 未稳定强制；目前只有会话结束/重载冲突 UI 和集成测试覆盖。
19. 没有测试虚拟 provider 绝对形 targetKey 的边界（防误写本机）。

### P3：仓库/交付清理
20. 未跟踪文件较多：`MarkPilot-CM6/dist*`、历史 `.tgz`、`docs/LOG-0.3.12-HANDLE-LIFECYCLE.md` 等；不要擅自提交/删除，先确认归属。
21. 发布 tag 已存在；不要再打同名 tag，也不要重复 `npm publish` 2.0.5（registry 不可覆盖）。

## 4. 建议执行顺序

1. **确认线上**
   - 用第 1 节命令核对 GitHub / npm / PR / Issue。
2. **收尾主仓库**
   - 若用户同意：PR #14 Ready → review → merge 到 main。
   - 合并后核对 main 版本、tag、Release 资产。
3. **官方市场**
   - 等 #14521 合并；合并后核对市场条目 tarball 和 README。
4. **开放市场**
   - 核对 #437 已收录条目；若条目仍是 1.8.1，再联系维护者，不要重复开新 issue。
5. **修 P1 代码问题**
   - 先修普通保存 temp 残留；若要改代码，**必须升 2.0.6**，不能复用 2.0.5 的 npm 版本。
   - 同步补失败注入测试、POSIX/平台决策、read-only 契约测试。
6. **另一条线 computer-use**
   - `npm view dsh-codex-style-computer-use dist-tags --json` 当前是 `latest=2.3.0, next=2.2.9`。
   - 执行（需要 npm 认证）：
     ```powershell
     npm dist-tag add dsh-codex-style-computer-use@2.3.0 next
     npm view dsh-codex-style-computer-use dist-tags --json
     ```
   - 预期 `{"latest":"2.3.0","next":"2.3.0"}`。
   - 不要重新发布 2.3.0；只对齐 tag。

## 5. 操作注意事项

- **不要改 MarkPilot 编辑器内核**（CM6 renderer / 内核）；只改插件 host/client 与文档。
- **不要重复发布 2.0.5**：
  - npm 版本不可覆盖；
  - GitHub tag `dsh-markdown-editor-typora-v2.0.5` 已存在。
- 市场 tarball 必须指向 GitHub Release，不直接指 npm。
- npm 发布需要 WebAuthn 安全密钥/指纹；终端出现 `https://www.npmjs.com/auth/cli/...` 时，按 Enter 打开浏览器并完成 Windows 安全中心确认。
- Git push 若出现 `Recv failure: Connection was reset`，读系统代理（注册表 `ProxyServer`，当前 127.0.0.1:7897），单条命令临时设 `HTTP_PROXY/HTTPS_PROXY`，不要写死到全局。
- 删除只针对自建临时目录；`%TEMP%` 验证目录可删，用户目录/仓库历史包不要动。
- 发布文档与日志：
  - `docs/RELEASE-2.0.5.md`
  - `docs/LOG-1.8.1-B4.3-WEB-REALTEST.md` §72–§76
- 当前源码/文件测试文档：
  - `D:\BuyKey\Typora-Editor-App\g3mirror2.md`，内容应为 `# g3mirror2`，无只读、无副本、无 `.mp-tmp-*`。

## 6. 关键链接

- GitHub Release：<https://github.com/ltmroberthk915/markpilot/releases/tag/dsh-markdown-editor-typora-v2.0.5>
- npm：<https://www.npmjs.com/package/dsh-markdown-editor-typora/v/2.0.5>
- 主仓库 PR：<https://github.com/ltmroberthk915/markpilot/pull/14>
- 官方市场 PR：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/14521>
- 开放市场 Issue：<https://github.com/polang233/dsh-plugin-index/issues/437>
- computer-use GitHub Release（另一条线）：<https://github.com/ltmroberthk915/dsh-computer-use/releases/tag/v2.3.0>
