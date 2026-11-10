# LOG 1.7.1 · 保存后“文件已在磁盘上更新”误报

## 症状

真机键盘输入后 Ctrl+S：

- 左侧已显示“已保存”；
- 紧接着出现冲突横幅“文件已在磁盘上更新；点「重载磁盘版本」…”；
- 磁盘内容实际正确；
- 第二次同样操作未复现。

## 定位

静态路径唯一：`runSave` 成功保存后，用 `api("stat")` 对账；若 `stat.value.version !== doc.lastVersion`，且 `doc.dirty || doc.conflict`，就设置 `externalStale` 并显示冲突。

`version` 由文件元数据组成（dev/ino/size/mtimeNs/ctimeNs）。保存响应与随后 stat 的版本串在元数据时序上可能不同，但正文完全一致；旧代码只比版本，不比正文，因此会把“自己的保存”误判为外部更新。

未稳定复现，不能宣称已复现根因；但这是唯一能产生该横幅的保存后路径。

## 修复

保存成功后 stat 版本不一致时：

1. 仍先处理 live 分支（refreshLiveRoom）；
2. 非 live 分支调用 `api("open", {path, live:false})` 读取磁盘当前版本/正文；
3. 只有**版本与 stat 相等且规范化正文（去 BOM、CRLF→LF）等于刚保存的文本**时：
   - 采纳该版本为 `doc.lastVersion`；
   - 清除 `externalStale/conflict`；
   - 不再显示冲突；
4. 正文不同或读取失败，保留原有冲突/静默重载逻辑，绝不吞掉真实外部修改。

纯函数：`normalizeSavedText`、`shouldAdoptSavedVersion`，已导出到 `__test`。

## 测试

```text
npm test
tests 447, pass 446, fail 0, skipped 1
```

- `client.test.mjs`：BOM/CRLF 规范化后正文相同→采纳；版本不同/正文不同/读取失败→不采纳。
- 真机保存复测仍正常，但误报本身未稳定复现，故以确定性 helper 测试兜底。

## 打包/实装

- 新包：`dsh-markdown-editor-typora-1.7.1.tgz`
- 大小：2,797,472 B
- shasum：`dbab8dd2babbbc379d4b2e962798c526b5d2880f`
- 已安装到 profile，版本 `1.7.1`，client sha16=`95906864390B27EC`
- 旧 1.7.0 目录保留在 `dsh-markdown-editor-typora.old-1.7.0`
