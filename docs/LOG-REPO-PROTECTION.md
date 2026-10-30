# main 分支保护设置

内部记录，记录仓库自身的安全设置与验证方式。

## 当前规则（2026-10-30 设置）

| 规则 | 状态 |
|---|---|
| 必须开 PR 才能合并 | 开（required_approving_review_count = 0，即不需要别人批准） |
| 禁止 force push | 开 |
| 禁止删除 main | 开 |
| Include administrators（enforce_admins） | 关 |

`enforce_admins` 关闭意味着仓库管理员（所有者）不受上述规则约束：日常仍可直接向 main 推送；其他人或脚本若要改动，必须走 PR。

## 为什么这样设

- main 是发布源：Release 资产、README 与插件目录都从这里出，误删或强推覆盖历史的代价高。
- 单人仓库：开出「必须批准」会把合并锁死；0 个必需批准 + 允许管理员直推，是保护与效率的折中。
- 需要更严时再开：Require status checks（先要有 CI workflow）、Require linear history、signed commits。

## 验证

- `GET /repos/ltmroberthk915/markpilot/branches/main` → `protected: true`
- `GET .../protection` → `allow_force_pushes.enabled=false`、`allow_deletions.enabled=false`、`required_pull_request_reviews.required_approving_review_count=0`
- 普通推送仍按管理员身份放行（enforce_admins=false）

## 界面位置

- 经典：Settings → Branches → Branch protection rules（`main`）
- 新版：Settings → Rules → Rulesets
