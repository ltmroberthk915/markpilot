# MarkPilot 1.9.4（P5 状态路由）

- `documents.state` 走 SessionManager 缓存；key 覆盖 room 成员/版本/resolvedDisk/mirror/recovery。
- 写端点统一失效；generation 防止旧 load 回填。
- allowedActions 忽略 undone review 组。
- 错误文案区分 lookup failure/mirror。
- 全量：537 / 536 pass / 1 skip / 0 fail。

## 产物

- `dsh-markdown-editor-typora-1.9.4.tgz`
- 150 files / 2.8 MB
- SHA256 `CAA0209E9C9AEBF511D1C9B26C3257E584EBE3FFED8E511B89BC57FB121A748D`
