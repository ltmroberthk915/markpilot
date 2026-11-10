# LOG B4.3b · diff3 三方合并（host-only）

- 基线：`main` @ `32fdbd3`（B4.3a 批量完成）。
- 工作树：`.agents/worktrees/b4.3b-diff3`。
- 只做 host 三方合并；不改 renderer。

## 1. 协议

- `markdown action:"merge3"`：参数 `baseText/otherText/baseVersion`。
- 当前正文为 ours；base 为共同祖先，other 为另一侧。
- 行级 LCS diff，独立改动自动合并；重叠改动返回 `clean:false + conflicts[]`，**不写盘**。
- clean 合并走 `applyEdits` 全文替换，复用 buffer append/磁盘 CAS/归档/group。
- 单侧多行插入/删除、首尾插入均支持；共同祖先超过约 3000×3000 行对拒绝 `MP_MERGE_LIMIT`。

## 2. 工具

- `action` 增加 `merge3`，输入 `baseText/otherText`。
- 输出 `clean/merged/conflicts/version/groupId`。
- render：冲突列表或合并完成提示。

## 3. 测试

```text
npm test
tests 442, pass 441, fail 0, skipped 1
```

- `B4.3b-S1`：独立行改动 clean；同一行冲突不合并；末尾插入。
- `B4.3b-S2`：service clean 写一次 append；冲突零 append。
- `B4.3b-API1`：真实 live room 的 clean merge 写正文；随后冲突不写正文。

## 4. 边界

- 行级 diff，不处理行内字符级冲突；冲突需调用方/用户决定。
- `baseText` 由调用方提供，不校验它一定是当前正文的祖先；写入仍受 `baseRevisionId` 保护。
- renderer 冲突界面未做（B4.2b/后续）。
