# MarkPilot 工作区迁移包（2026-09-10，基于 v2.0.9）

## 包内清单

```
Typora-Editor-App/     桌面 EXE 仓（Electron 主进程/shell/测试套件/交付报告）
Typora-Editor/         VSIX 扩展源码仓（extension-src/render = 渲染层唯一事实源 + pack.py）
zcode/AGENTS.md        全局默认指令（本机软件镜像布局等，恢复到新机 ~/.zcode/）
zcode/skills/          用户级 ZCode skill（微信群聊记录提取）
README-MIGRATION.md    本文件
```

## 恢复步骤（新电脑）

1. **前置**：Windows + Node ≥ 22（测试探针用原生 WebSocket，本机为 v24）+ Python 3（VSIX 打包）+ 已安装 ZCode。
2. **解压两仓到 `D:\BuyKey\`**（务必保持这个绝对路径：skill、脚本与文档里硬编码了 `D:\BuyKey\Typora-Editor-App` 与 `D:\BuyKey\Typora-Editor`）。
3. **ZCode 配置**：`zcode/AGENTS.md` → `C:\Users\<新用户名>\.zcode\AGENTS.md`；`zcode/skills/` → `C:\Users\<新用户名>\.zcode\skills\`。若新机用户名/盘符布局不同，同步修改 AGENTS.md 里的镜像路径描述。
4. **装依赖**：`cd D:\BuyKey\Typora-Editor-App && npm install`（会下载 Electron 运行时）。
5. **密钥（不在包内，零泄漏）**：AI 补全的 `LIVE_AI_KEY` 用环境变量设置；应用内 API Key 需在新机重填一次（2.0.9 起保险库跨机不可解会自动降级，不再阻断文档打开）。

## 开发铁律（详见 App 仓 `.agents/skills/marcopilot-md-editor/SKILL.md`，已随仓打包）

- 渲染层改动**只改** `Typora-Editor/extension-src/render`，然后在 **App 仓**跑 `npm run sync`（486 文件 → `app/renderer`）；`app/renderer` 永不手改。
- 每项修复：bug2xx 套件 before/after 双相（基线取证 → 修复断言），**最终截图确认才能收尾**（skill §3.7 硬规则）。
- GUI 验收串行零并行；测试 profile 用完即清；用户内容截图当场删除。
- 版本第三位递增发版：`python pack.py`（VSIX）→ `npm run dist`（EXE）→ `node scripts/verify-release100-private.cjs <releaseDir> <vsix> <out>`（**必须显式传全参**）→ SHA256SUMS → `docs/RELEASE100-FEATURES-*.md` 追加一节。

## 已排除（可再生/不应搬运）

`node_modules`（npm install 重建）、`dist`（24G 产物，npm run dist 重建）、`.perf`（8.7G 测试证据与 profile 缓存）、`test/.runs`（54G VSIX 解压与冒烟缓存）、`.backups` 内 23M×N 的旧 asar 快照与 1.0.x 全树（当前源码即真相；用户笔记小备份已保留）、`~/.zcode/v2`（含 credentials 与本机会话状态，新机重新登录）。

## 现状锚点

- 当前版本 **2.0.9**（交付哈希链与全部 18 节报告：`Typora-Editor-App/docs/RELEASE100-FEATURES-20260909.md`）。
- 常用命令：`node scripts/run-electron-test.mjs <suite>`（regression/consistency/features/repairs/ui/shell/completion/typography/export/media-* / residue-app…）；`SPLIT_NAV_SUITE=bug208 BUG208_PHASE=after node scripts/run-split-navigation.mjs`；VSIX 冒烟 `node test/vscode-smoke.cjs <Code.exe> <解压的VSIX>/extension`。
