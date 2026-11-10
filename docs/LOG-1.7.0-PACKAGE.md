# LOG 1.7.0 · 打包实装与真机验收

- 源码基线：`main` @ `e7ad844`（B4.2b/4.3 完成）。
- 打包：`dsh-markdown-editor-typora-1.7.0.tgz`。
- 实装：`C:\Users\Ming\.dsh\profiles\desktop\node_modules\dsh-markdown-editor-typora` 已从 dev junction 换成真实安装目录（1.7.0）。

## 1. 打包

```text
npm pack
name: dsh-markdown-editor-typora@1.7.0
size: 2,796,896 B
unpacked: 8,255,462 B
shasum: d4e6b3965a730c685d044f2ff03b908e6c10d7cd
sha256: 1b1aa3413066c9901cb1a3a5afb9d06df5301fe65740d21e0e8a2397d256dd79
files: 149
```

包内与源码逐字节一致的关键文件：

- `lib/client.js` `1a273fb627e3ae96…`
- `lib/documents-service.js` `3099619db6dc0a8d…`
- `lib/index.js` `550c30c5c131107d…`
- `host/live-documents.js` `0695202529dddec9…`
- `host.json` `d40fc477016c41fb…`

## 2. 实装

- 旧 junction 目标：`D:\BuyKey\markpilot-public\dsh-markdown-editor-typora`
- 新安装目录：`C:\Users\Ming\.dsh\profiles\desktop\node_modules\dsh-markdown-editor-typora`
- 安装目录版本：`1.7.0`
- 安装目录 `lib/client.js` sha16：`1a273fb627e3ae96`
- 插件热加载后 `markdown blocks` 正常返回 9 个 section，证明运行的是安装包。

注意：profile 的 `package.json` 依赖声明仍是 `link:D:/BuyKey/markpilot-public/dsh-markdown-editor-typora`；如果以后执行 `pnpm install`/`dsh plugin`，可能会重建 junction 覆盖当前安装目录。需要长期保持安装态时应把依赖改成 tarball/file 或重新打包。

## 3. 真机验收

### 键盘编辑 + Ctrl+S

- 点击 README 编辑区，`Ctrl+End`，键盘输入 `PACKAGE-KEY-PROBE`；
- `Ctrl+S` 后磁盘文件包含该标记，大小 7844 B；
- 再输入 `X`、`Ctrl+S`，界面显示“已保存”，磁盘更新；
- 复测未再出现此前一次外部冲突横幅（首次运行时曾短暂出现，第二次干净通过，未复现）。

### AI 审阅

- `markdown edit` 追加 `PACKAGE-AI-PROBE`；
- 等 2 秒，磁盘 hash 仍为 `835bff35…`、7825 B，未自动保存；
- 界面出现“AI 修改待确认：AI 修改了 1 处，保存前请确认”；
- 点击“查看差异”，rail 显示 `第 1 组 · 修改 1（替换 48 字符）` 及红色旧行/绿色新行；
- 点击“撤销本次”，toast“已撤销本次 AI 修改（1 组）；磁盘未改变”，正文恢复；
- `agent_group.undone_at` 已置；README 已恢复原 hash/7825 B。

### 回归

```text
npm test
tests 446, pass 445, fail 0, skipped 1
sync-host --check  OK 9 files
sync-core --check  OK 124 files
```

## 4. 风险/后续

- 安装目录是静态副本；源码继续改后必须重新 `npm pack` + 重装，热加载不会同步源码。
- 未在实装包上重复 B4.3 冲突界面（尚无 UI）、B4.2b 关闭/多组全矩阵；这些已在 dev 版真机/测试中覆盖，包内文件与 dev 逐字节一致。
- 未打包 MarkPilot 桌面 EXE；本次“打包实装”指 DSH Markdown 插件包。
