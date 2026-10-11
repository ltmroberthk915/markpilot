---
name: extract-wechat-group-chat-records
description: 提取微信群聊记录为结构完整、各维度信息完整的SQLite数据库（Windows 微信4.x/Weixin，不注入不hook，只读内存取密钥+离线解密本地库）。当用户提到提取微信群聊/聊天记录导出/群聊数据库/微信记录备份/聊天记录结构化/微信数据解密/wechat chat export/dump 等时使用——即使没明说"数据库"或"导出"。
---

# 提取微信群聊记录

把本机 Windows 微信（Weixin 4.x）的群聊完整记录提取为 SQLite 数据库：秒级时间戳、发送者 wxid+群昵称、全消息类型、@列表、引用链、系统事件、媒体文件解密导出、成员关系与头像。

## 铁律（先读）

1. **只读原则**：对微信进程只允许 `OpenProcess(PROCESS_VM_READ)` + `ReadProcessMemory`。禁止 DLL 注入、hook、写进程内存、修改微信文件。这是用户的核心约束，也是方案能否成立的前提。
2. **合规边界**：仅限本人登录账号、本人机器上的数据、个人备份用途。PyWxDump/chatlog/wechat-dump-rs 等工具作者已因分发收到律师函/DMCA（2025-10），**不要传播工具本体**，使用时向用户说明用途边界。
3. **一切操作针对副本**：先热拷贝 db 到工作区，绝不写原始数据目录。

## 本机事实（2026-09 验证）

- 微信 Weixin **4.1.13.12**，`D:\Program Files\Tencent\Weixin\Weixin.exe`，多进程（取 RSS 最大的为主进程）
- 数据目录：**`D:\xwechat_files\wxid_albeb455hdrc21_fe80`**（自定义位置！不在 Documents 下；定位法：注册表 `HKCU\SOFTWARE\Tencent\Weixin` 的 `OldFileSavePath` + 检查各盘根 `xwechat_files`）
- 本人 wxid：`wxid_albeb455hdrc21`
- 已验证密钥：数据库密钥集存 `workspace/all_keys.json`；图片 XOR key `0xA4`；图片 V2 AES key `9cf3b566f2dea5fc`（密钥可能随账号/时间变化，**解密失败就重扫，不要硬编码假设**）
- 旧 3.x 数据已冻结于 `D:\Wechat_files`（历史已迁移并入 4.x 库，无需回碰）

## 工作流（7 步）

在用户指定的工作目录（或新建，如 `D:\BuyKey\微信监控`）里执行。脚本在 `scripts/`，深度资料在 `references/`。

### 0. 前置检查
微信必须**运行中且已登录**（取密钥需要）。确认版本（exe VersionInfo）与数据目录（见上）。4.1 与 4.0 差异很大，版本变了先读 `references/tools.md` 核对工具支持。

### 1. 环境（一次性）
```bash
python -m venv venv
./venv/Scripts/pip install pycryptodome zstandard pilk
```

### 2. 取数据库密钥（唯一碰进程步骤，只读）
```bash
./venv/Scripts/python.exe scripts/vendor/wcdb_key_tool_windows.py extract \
  --db-dir <数据目录>/db_storage --output workspace/all_keys.json
```
- 原理：定位进程内存中 `com.Tencent.WCDB.Config.Cipher` 对象 → 解码 XOR 掩码的 `x'<key><salt>'` → 对本地 db 首页做 HMAC 验证。4.1.x 有效（4.1.11~4.1.13.12 实测）。
- 成功标准：`N/N salts 找到密钥` 且每个 db 都 OK。
- 若 GitHub 源失效/版本不支持：读 `references/tools.md` 的备选路径与自研要点。

### 3. 热拷贝 + 解密
```bash
# 拷贝(连同 -wal/-shm): message_0/1/2.db media_0/1.db message_resource.db
#                        contact.db session.db hardlink.db emoticon.db head_image.db
mkdir -p workspace/source/...  && cp <数据目录>/db_storage/<同结构> workspace/source/
./venv/Scripts/python.exe scripts/decrypt_all.py     # 输出 workspace/decrypted/*.sqlite + integrity_check
```
热拷贝丢最后几分钟写入（wal 未合并），历史数据不受影响；要最新数据请用户退出微信 1 分钟重拷。

### 4. 列群选群
```bash
./venv/Scripts/python.exe scripts/list_groups.py    # 全部群: 名称/成员数/消息量/时间范围 → workspace/groups.json
```
把清单给用户选群（消息量前 60 打印，全量在 json）。

### 5. 提取建库 + 媒体导出
```bash
# 若 V2 图片解密失败, 先: python scripts/find_image_key.py <数据目录>/msg/attach
./venv/Scripts/python.exe scripts/extract_group.py <群名或xxx@chatroom ...>
# 输出: output/<群名>_聊天记录.db + output/<群名>_export/{images,voice,video,file,emoji,avatars}
```
产出结构：`group_info / members(群昵称+邀请人+头像+发言数) / messages(20+维度) / message_refs(引用链) / media(索引)` + 5 个统计视图。库结构详见 `references/schema.md`。

### 6. 校验交付
```bash
./venv/Scripts/python.exe scripts/validate.py    # 自动发现 output/*.db, 逐字段抽样比对+媒体魔数 → output/校验报告.md
```
写 `output/README.md`（库结构+查询示例+边界说明，参考 D:\BuyKey\微信监控\output\README.md 的成熟版本）。

### 7. 补齐 PC 缺失历史：手机「迁移到电脑」（唯一有效路径）

**PC 端没有服务器漫游**——从未在 PC 打开过的会话，向上滚动一条也拉不到（实测 +0 条）。正确做法：

1. 手机与 PC 同一 WiFi；手机微信 `我→设置→通用→聊天记录迁移与备份→迁移→迁移到电脑`（**选"迁移"，不是"备份"**——备份是加密存档，管道读不了；迁移是合并语义，落进 PC 消息库）
2. 手机端可只勾选目标会话；完成后 PC 端能直接查看 = 已落库
3. 迁移后的连锁反应（全部踩过）：
   - **新建 message_3~N.db 存放迁移历史** → 提取/列群/校验脚本必须动态枚举 message_*.db（已支持）
   - **部分库（如 message_resource.db）被重建、salt 轮换** → 旧 all_keys.json 失效，必须重跑第 2 步密钥扫描
   - 产生 `migrate/unspportmsg.db`：微信认为无法迁移的消息（如实况位置 49/17），字段齐全可解析，建议注入对应群库并打 `migrate_unsupported=1` 标记（注意群消息 from_user=群号、to_user=自己，真实发送者在 content 前缀）
   - 老图可能是 **BMP** 格式；个别老视频是**全零占位文件**（源即如此，缩略图正常）
4. 然后重跑：拷贝（含新 message_N.db 与 migrate/）→ 解密 → 提取 → 校验

## 高频坑（都踩过，代价见括号）

1. **`sqlite3.connect` 对不存在路径会静默建空库**——解密库文件名是 `<原名>.db.sqlite`，连接路径漏 `.db` 就会得到空表 "no such table"。（冒烟测试翻车一次）
2. **消息内容尾部有 NUL 填充字节**，`ET.fromstring` 直接报 invalid token。解析前必须 `re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", s)`。此坑曾让全部文件类消息（文件名/标题全 NULL）和一半引用消息解析失败——**"解析成功率下降"先查这个**。
3. `local_type = (子类型 << 32) | 主类型`。244813135921 = 49/57（引用）。类型/子类型分开取：`t & 0xFFFFFFFF`、`t >> 32`。
4. 群消息 `message_content` 前缀是 `发送者wxid:\n`，解析前 strip（真实发送者另有 `real_sender_id`→Name2Id 映射，两者应一致，可互验）。
5. `WCDB_CT_* = 4` 表示该列 zstd 压缩（magic `28 B5 2F FD`），source/message_content 都可能压缩。
6. **媒体 md5 在 `packed_info_data`（protobuf 字符串字段里的32位hex），且文件名=md5**。hardlink 表只是不完整的旧索引，只能当兜底。图片路径 `msg/attach/<md5(群号)>/<YYYY-MM>/Img/<md5>[_h|_t|_W].dat`（月份用消息时间±2月）。视频 `video/<月>/<md5>.mp4`（未下载只有 `<md5>_thumb.jpg`）。文件用**真实文件名**存 `file/<月>/`（名字取 appmsg XML 的 title）。
7. 图片三种加密（详见 `references/crypto-media.md`）：旧格式=单字节XOR（密钥可由 JPEG 头已知明文推出，本机0xA4）；V1=固定AES key `cfcd208495d565ef`；V2=账号密钥 AES-128-ECB+XOR（需内存扫描，密钥查看图片后才驻留）。部分 V2 原图解出为微信私有 `wxgf`(HEVC) 格式，原样导出即可。
8. 语音在 `media_*.db` 的 `VoiceInfo.voice_data`（silk），按 `svr_id == 消息 server_id` 关联，`data_index` 是分片序号（>60s 语音多段），合并转 24kHz wav（pilk 只吃文件路径）。
9. 表情缓存非常规加密（aeskey 24位hex，非标准AES），放弃解密：库留 md5/尺寸/CDN链接，缓存原样备份。
10. **撤回的消息本体仍留在库里**（微信不删行）；撤回事件是 type 10000 系统通知文本，别试图把两者可靠关联。
11. 导出文件名过长触发 Windows MAX_PATH——超150字符的导出名要截断。
12. 未下载的媒体（用户没看过的图/文件）本地不存在，标 `variant='missing'` 即可，不要当成 bug 修。
13. **合并转发（49/19-20）的内层记录**在 `appmsg/recorditem` 的 CDATA 里（不是 recordinfo 直挂）：`<recordinfo>→datalist→dataitem`，每条含 sourcename/srcMsgCreateTime(精确时间戳)/fromnewmsgid/datadesc/datatitle/cdnthumburl。结构化进 `merged_records` 表。
14. **房间级累积列表（msg_insert/refs/media_rows/merged_rows）必须在消息循环外初始化**——放进循环内会每条清空，症状是"表为 0 但代码路径看着都对"，极易漏诊（merged_rows 首版就犯了这个）。
15. 重跑前清理旧导出目录要宽容（`shutil.rmtree(..., onexc=chmod重试)`）——导出的 PDF 可能正被阅读器打开导致 PermissionError 中断整轮提取。
16. 手机迁移后必须：重扫密钥（salt 轮换）+ 动态枚举 message_N.db + 处理 unspportmsg.db，三者缺一都会静默丢数据（新库不被枚举=丢全部迁移历史）。

## 文件导航

- `scripts/` — 全流程可复跑脚本（参数：`WXWORK_ROOT`(默认CWD)、`WXCHAT_DATA`、`WXCHAT_SELF`、`WXCHAT_IMG_AES_KEY`、`WXCHAT_IMG_XOR_KEY`）
- `scripts/vendor/wcdb_key_tool_windows.py` — 取库密钥（MIT, TANGandXUE/wcdb-key-tool，打包于此防仓库下架）
- `references/schema.md` — 4.1 数据库结构、protobuf/XML 格式、消息类型码全表
- `references/crypto-media.md` — SQLCipher 参数、解密算法、图片三格式、语音/视频/文件/表情处理
- `references/tools.md` — 工具生态与下架现状、版本兼容、备选路线

## 成功基准（本机 6 群实测，含手机迁移回填）

消息数与源库逐条一致（合计 99.3 万条）；抽样逐字段全对；导出媒体 0 缺失、魔数异常仅源侧占位文件；引用链解析率 ≥99.94%；合集内层记录已结构化（合计 4.1 万条）。低于这些指标先查坑 2、6、14、16。
