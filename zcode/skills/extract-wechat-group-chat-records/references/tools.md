# 工具生态与合规现状（2026-09 核查）

## 已下架/不可依赖

| 工具 | 状态 |
|---|---|
| xaoyaoo/PyWxDump | 2025-10 收微信官方律师函，仓库清空（PyPI 残留旧版，4.1 支持不明） |
| sjzar/chatlog | 同批收函自删（9.2k star） |
| 0xlane/wechat-dump-rs | GitHub 451 |
| ycccccccy/wx_key | DMCA（其 4.1 方案是 DLL注入+Hook，**违反本 skill 只读原则，不用**） |

## 当前可用

- **TANGandXUE/wcdb-key-tool**（MIT，单文件纯 Python 无依赖）——本 skill 已打包至 `scripts/vendor/wcdb_key_tool_windows.py`。Windows 4.1+ 走只读 runtime `Config.Cipher` 扫描 + HMAC 校验；macOS/Linux 路线是 LLDB/GDB 断点（更重，不用于 Windows）。
- GitHub 直连不稳时：jsDelivr 兜底 `https://cdn.jsdelivr.net/gh/<user>/<repo>@<branch>/<file>`（.py 会以 octet-stream 下发，用 curl 不用 WebFetch）。

## 版本兼容关注点

- wcdb-key-tool 的 Config.Cipher 对象偏移（+0x88 等）在 4.1.11~4.1.13.12 实测有效；微信大版本更新后若 extract 全 MISS，先去原仓库看 issue/新 commit，再考虑自研（要点：搜内存字符串 `com.Tencent.WCDB.Config.Cipher`，沿 name+len 指针对找 config 对象，blob 用仓库内 `WINDOWS_CONFIG_XOR_MASK` 掩码异或后取 `x'<64hex><32hex>'`，HMAC 验证）。
- 4.0.x 与 4.1+ 密钥机制不同：4.0 内存里有明文 `x'key+salt'`（正则直接扫）；4.1 只在 Cipher 配置对象里有（掩码编码）。
- 图片 V2 AES key 疑似按账号持久、按需加载（查看图片才进内存）；XOR key 可由文件尾已知明文推导，无需内存。

## 合规口径（对用户陈述时使用）

- 数据来源：本机登录账号的本地存储，属于用户本人可见/所有的聊天内容；用途：个人备份、迁移、分析。
- 只读内存访问不修改微信、不影响其运行；所有解析在文件副本上进行。
- 不分发密钥提取工具给第三方；产出库含隐私，注意存放位置。
- 参考先例：多个开源工具因**分发**被投诉下架，个人备份场景未被追究，但应保持低调与自用。

## 本 skill 输出库结构（打磨时的基准）

`group_info`(kv) / `members`(wxid,群昵称,邀请人,昵称/备注,在群状态,发言数,头像) /
`messages`(server_id 主键, 时间/iso, sort_seq, 发送者wxid+display, is_self, type/subtype/type_name,
text_content, raw_content, at_wxids, quote_server_id/quote_text/quote_sender, extra_json) /
`message_refs`(from→to) / `media`(kind,variant,md5,src/export_path,size,fmt,duration,宽高,原名) /
视图 v_by_sender / v_by_type / v_by_day / v_by_month / v_text_only。
