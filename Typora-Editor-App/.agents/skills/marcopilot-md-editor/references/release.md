# 发布与交付清单（版本 · 打包 · 报告 · 交付格式）

## 1. 版本策略（用户指令，长期有效）

- **每次交付第三位（patch）递增**：2.0.1 → 2.0.2 → 2.0.3……绝不复用旧号。
- 版本号单一来源：两仓 `package.json` 先改；其余全部自动/断言对齐：
  - VSIX 清单：pack.py 自动同步 `<Identity Version>` 并以 `newline=""` 写回（保持 CRLF，使 VSIX 内字节与清单文件一致）。
  - 产物文件名 / dist 目录名：`release-<ver>-private`、`marcopilot-Setup-<ver>.exe`、`marcopilot-v<ver>-portable.exe`、`marcopilot-<ver>.vsix`。
  - 验收断言：verify 脚本动态读 package.json，无硬编码。

## 2. 打包步骤

```bash
# ① 改版本：两仓 package.json 的 version → <新版本>
# ② 同步共享渲染代码（App 仓）
npm run sync
# ③ VSIX（扩展仓；私有版不带 --public）
cd E:/MarkPilot/Typora-Editor && python pack.py
#   产出 E:\MarkPilot\Typora-Editor\dist\marcopilot-<ver>.vsix
# ④ EXE（App 仓；产物落 dist/release-<ver>-private/）
npm run dist
# ⑤ VSIX 复制/归档进统一交付目录 dist/release-<ver>-private/
# ⑥ 抽取 VSIX 供 IDE 冒烟用：
#    解压到 test/.runs/vsix-private-<ver>/extension（zip，注意 extension/ 前缀）
# ⑦ 生成哈希汇总
cd dist/release-<ver>-private && sha256sum marcopilot-Setup-<ver>.exe marcopilot-v<ver>-portable.exe marcopilot-<ver>.vsix win-unpacked/resources/app.asar > SHA256SUMS.txt
```

注意：
- 打包前确认全量验收在**当前产物树**上绿（acceptance.md 顺序：验收 → 打包 → verify → 交付）。
- 公开版（`--public`）与本私版交付无关，勿混淆；公开产物不由本流程改动。

## 3. 交付必做（缺一不算交付完成）

1. `verify` 三方哈希 verified:true（完整命令见 acceptance.md §4）。
2. `sha256sum -c SHA256SUMS.txt` 全 OK。
3. 报告追加一节到 `docs/RELEASE100-FEATURES-<日期>.md`（格式见 §4）。
4. 交付消息**必须**包含 EXE/VSIX 绝对路径 + SHA256（历史格式：哈希前 12 位 + …）+ 用户侧安装指引。

## 4. 报告节格式（沿用既有结构，保持编号连续）

```markdown
## <N>. v<版本>：<一句话主题>（当前交付）
### <N>.1 修复/新功能：每个问题一小节（现象→根因→对策→测试证据）
### <N>.2 …
### <N>.x 本轮验收汇总（36 任务/后台 298/覆盖率 64/64/live-AI/verify + 抖动披露）
### <N>.y 交付物绝对路径（四件 + 哈希 + 汇总文件 + verified:true 出处）
**结论**：`dist/release-<ver>-private` 为当前交付版本（下一交付 <下一版本号>）。
```

披露要求：抖动复跑、手动抽查未执行及原因、任何与"全绿"不完全一致的事实，都写明。

## 5. 用户侧安装指引（真实 Trae）

- **绝不**在 Trae 运行中用 `Trae.exe --install-extension`（会转发给真实实例）。
- 指引用户：Trae 命令面板 →「扩展：从 VSIX 安装」→ 选择交付 VSIX → 重启。
- 升级提示要点：旧版（2.0.0/v10）大纲挂在 explorer 容器，Trae 里永远不显示；必须装 2.0.1+ 才有活动栏"marcopilot 大纲"。

## 6. 历史教训（发布环节）

- vsixmanifest 的 Identity Version 手工同步必漏——pack.py 自动化后别再手改清单。
- CRLF/LF：文本处理脚本写文件要显式 `newline=""`（Python）或等价手段，否则字节级比对必挂。
- verify 脚本默认参数指向旧版本——调用永远显式传 3 参。
- 交付时间线里不要留"已打包但未验收"的中间态产物目录；历史候选目录（v5–v9）原样保留即可，不要清理也不要引用。

## 7. 当前交付线的校验脚本（2.2.0 起）

- **用 `node scripts/verify-chain.cjs <release目录> <VSIX路径> [报告目录]`**：它只做铁律 11 写明的四方链
  （`extension-src/render` == `app/renderer` == 打包 asar 内 == VSIX 内）+ 两仓与清单版本一致，
  逐项打印、缺一即失败，并把 499 个文件的 sha256 清单写进报告。
- **不要用 `scripts/verify-release100-private.cjs`**：那是 1.0.x 交付线的闸门（断言 `publisher = markpilot`、
  `markpilotDistribution` 标记、`app/shared/out/completion` 共享路径）。当前私有线的 VSIX `publisher = jinxi`、
  没有该标记也没有那些路径 —— 对本线**恒不可用**（2.1.29 与 2.2.0 两个 VSIX 逐项一致，已核）。
- 交付目录里要**带 `win-unpacked/`**（两个校验脚本都要读 `win-unpacked/resources/app.asar`）；
  `SHA256SUMS.txt` 记四项：Setup、portable、VSIX、`win-unpacked/resources/app.asar`。
- `--only=` 是按**文件名子串**匹配的：`--only=10` 会连带跑 100–109（踩过），排查时用完整文件名。
