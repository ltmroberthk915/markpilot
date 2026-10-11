# 微信 4.1 (Weixin) 数据库结构速查

数据根: `<数据目录>/db_storage/`，每个分类一个子目录。解密后为标准 SQLite。

## 库清单与用途

| 库 | 用途 | 关键表 |
|---|---|---|
| message/message_0/1/2.db | 聊天消息（跨库分布） | `Msg_<md5(username)>`, `Name2Id` |
| message/media_0/1.db | 语音 silk blob | `VoiceInfo` |
| message/message_resource.db | 资源清理记账 | MessageResourceInfo |
| contact/contact.db | 联系人/群/群成员 | `contact`, `chat_room`, `chat_room_info_detail`, `chatroom_member`, `name2id` |
| session/session.db | 会话列表 | `SessionTable`（最近摘要/时间） |
| hardlink/hardlink.db | 媒体文件索引(不完整) | `image/video/file_hardlink_info_v4`, `dir2id` |
| emoticon/emoticon.db | 表情 | `kNonStoreEmoticonTable` |
| head_image/head_image.db | 头像 blob | `head_image`（明文 jpg/png） |

## Msg_<hash> 表（每个会话一张，hash = md5(username)）

```sql
local_id INTEGER PK, server_id INTEGER,          -- server_id = MsgSvrID 全局唯一
local_type INTEGER,                              -- (子类型<<32)|主类型
sort_seq INTEGER,                                -- 毫秒时间戳, 全局排序
real_sender_id INTEGER,                          -- -> Name2Id.rowid (群内实际发送者)
create_time INTEGER,                             -- unix 秒
status INTEGER, source BLOB,                     -- source = zstd压缩的 <msgsource> XML
message_content TEXT, compress_content BLOB,
packed_info_data BLOB,                           -- protobuf, 含媒体 md5
WCDB_CT_message_content INTEGER, WCDB_CT_source INTEGER  -- =4 表示该列 zstd 压缩
```

- **Name2Id**: `rowid -> user_name`（每库独立）。会话表与发送者共用。
- `source` 解压后是 `<msgsource>` XML：`<atuserlist>wxid1,wxid2</atuserlist>`（@提及）、`<membercount>`、`<silence>`。
- `packed_info_data` protobuf：字段1/2 是固定小整数；字段3/4 是字符串 `'X <32位hex>'`——hex 即媒体 md5（图片/视频/文件）。取其中所有 32 位 hex 即可。
- `message_content` 群聊前缀 `发送者wxid:\n`，其后为纯文本或 XML。

## 消息类型码（local_type 低32位=主类型，高32位=子类型）

| 主类型 | 含义 | 内容形态 |
|---|---|---|
| 1 | 文本 | 纯文本（可含@昵称） |
| 3 | 图片 | XML `<msg><img aeskey cdnthumburl cdnthumbwidth/height>` |
| 34 | 语音 | XML `<voicemsg voicelength(ms) voiceformat bufid>`；blob 在 media 库 |
| 42 | 名片 | XML |
| 43 | 视频 | XML `<videomsg aeskey cdnvideourl playlength>` |
| 47 | 表情 | XML `<emoji md5 len cdnurl width height>` |
| 48 | 位置 | XML `<location x y label poiname>` |
| 49 | 应用消息（看子类型/XML `<appmsg><type>`） | XML，见下表 |
| 10000 | 系统通知 | 纯文本（撤回/改名/邀请进群/移出） |
| 10002 | 系统提示 | 拍一拍等 |

49 子类型常用：5=链接 6=文件 8=自定义表情 19/20=合并转发 33/36=小程序 51/25/26=视频号 57=**引用回复** 2000=转账 2001=红包 2003=群公告

**引用回复(49/57)** XML: `<appmsg><title>回复文本</title><refermsg><svrid>被引消息server_id</svrid><displayname>被引者</displayname><content>被引原文</content></refermsg>`。svrid 可直接 JOIN 本库 messages.server_id 还原讨论串。

**合并转发(49/19-20)**：内层记录在 `appmsg/recorditem` 的 **CDATA** 里：`<recordinfo>→<datalist count>→<dataitem>`。每个 dataitem：attr `datatype`(1文本 2图片 3语音 4视频 5链接 6文件 8表情 19小程序)/`dataid`；子元素 `datadesc`(内容)、`datatitle`、`sourcename`(发送者)、`sourceheadurl`、`sourcetime`(文本)、`srcMsgCreateTime`(unix 精确时间)、`fromnewmsgid`(原消息全局ID)、`cdnthumburl`、`duration`(语音ms)、`dataitemsource/hashusername`。结构化进 `merged_records` 表。

**文件(49/6)** XML: `<title>=文件名</title><md5>=文件md5</md5><appattach><totallen>`（attach_filename 节点可能没有，文件名取 title）。

## contact.db

- `contact(username, nick_name, remark, alias, small/big_head_url, is_in_chat_room, chat_room_type)`
- `chat_room(rowid, username, owner, ext_buffer)` — ext_buffer protobuf：**字段1 repeated 成员{1:wxid, 2:群昵称, 3:flag, 4:邀请人wxid}**（群昵称与邀请关系的唯一来源）
- `chat_room_info_detail(username_, announcement_, announcement_editor_, announcement_publish_time_)`
- `chatroom_member(room_id, member_id)` — room_id=chat_room.rowid, member_id=name2id.rowid → 当前在群成员
- `name2id(rowid, username)` — id 映射

## VoiceInfo（media_N.db）

`(chat_name_id, create_time, local_id, svr_id, voice_data BLOB, data_index)` — svr_id==消息server_id；data_index 为分片序号（长语音多段，按序合并）。

## hardlink.db（仅兜底）

`*_hardlink_info_v4(md5, file_name, file_size, dir1, dir2)`；`dir2id(rowid→'YYYY-MM')`。md5 列与消息 packed md5 **不是同一哈希**，覆盖率不全——主路径直接用「文件名=packed md5」规则（见 crypto-media.md）。
