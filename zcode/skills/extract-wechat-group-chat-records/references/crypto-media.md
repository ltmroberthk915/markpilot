# 加密与媒体处理手册（微信 4.1 Windows）

## 1. 数据库（SQLCipher 4 / WCDB）

参数：PBKDF2-**HMAC-SHA512**、256000 迭代、salt=文件前16字节、page=4096、每页尾 reserve 80 字节（IV 16 + HMAC-SHA512 64）。

密钥获取（只读）：wcdb-key-tool 的 runtime 扫描——内存中找字符串 `com.Tencent.WCDB.Config.Cipher` → 定位其对象（指针在 name+len 对前 0x10 处，config 对象 +0x88 → {+0x8 data_ptr, +0x10 data_len}）→ blob 与固定掩码 XOR 解码 → 正则 `x'<64hex><32hex盐>'` → 用 db 首页 HMAC 验证。4.0.x 老版本直接正则扫内存明文 `x'...'`。

逐页解密（拿到 raw key 后离线）：
```
mac_salt = salt ^ 0x3A(每字节);  mac_key = pbkdf2_hmac(sha512, key, mac_salt, 2, 32)
页1: 密文=page[16:4016]; 其他页: 密文=page[0:4016]; IV=page[4016:4032]
AES-256-CBC 解密; 页1 输出 = b"SQLite format 3\0" + 明文 + 80零; 其他页 = 明文 + 80零
HMAC(mac_key, page[起始16或0 : 4016+16] + pack('<I', 页号)) == page[4032:4096] 用于验证
```
（密钥可能随登录会话变化；all_keys.json 过期就重跑 extract。）

## 2. 图片 .dat 三种格式（magic = 文件头）

| magic | 格式 | 解法 |
|---|---|---|
| 无（直接乱数字节） | 旧格式：整文件单字节 XOR | 密钥=首字节^0xFF 且 次字节^密钥==0xD8（JPEG）；PNG/GIF/BMP 同理已知明文推。本机 0xA4 |
| `\x07\x08V1\x08\x07` | V1：AES-128-ECB(固定key)+XOR | 固定 key `cfcd208495d565ef`（4.0.3 前版本） |
| `\x07\x08V2\x08\x07` | V2：AES-128-ECB(**账号key**)+XOR | key 16位ASCII，内存扫描（见下） |

V1/V2 头 15 字节：`magic(6) + u32 aes_len@6 + u32 xor_len@10 + 1B`。布局：`头15 | AES段(aes_len, PKCS7, 存储时若整块对齐会多一个 padding 块) | 明文中段 | XOR尾段(xor_len)`。解密=三段分别处理后拼接，输出按前4字节判 jpg/png/gif/webp/**wxgf**（微信私有 HEVC 静图，导出保留原样后缀 .wxgf）。

V2 key 扫描（`scripts/find_image_key.py`）：微信**查看图片后** key（16位字母数字串）驻留 RW 堆内存 → 遍历进程 RW 区正则 `[a-zA-Z0-9]{16,32}` → 用候选对任一 V2 文件 `[15:31]` 块 AES-ECB 解密 → 解出图片魔数即命中。扫不到=用户没看图，让其在微信点开2-3张图后立刻重跑。XOR key：取多个 V2 文件末2字节 ^ `FF D9`（JPEG EOI）取众数。

变体命名（attach 目录内，按质量取用）：`<md5>_h.dat`(高清) > `<md5>.dat`/`<md5>_W.dat`(原图) > `<md5>_t.dat`(缩略图)。

## 3. 媒体落盘规则（**文件名=消息 packed_info 里的 md5**）

```
图片: <data>/msg/attach/<md5(群号username)>/<YYYY-MM>/Img/<md5>[_h|_t|_W].dat
      (转发消息的图在 <月>/Rec/<hash>/Img/ 下, 名为 0_W 等, 少见)
视频: <data>/msg/video/<YYYY-MM>/<md5>.mp4   (未播放过则只有 <md5>_thumb.jpg)
文件: <data>/msg/file/<YYYY-MM>/<真实文件名>  (名字取 appmsg XML title; 可能带"(1)"等变体)
语音: media_N.db VoiceInfo.voice_data (silk), svr_id==server_id, data_index 分片
表情: <data>/cache/<YYYY-MM>/Emoticon/<md5前2位>/<md5>  (非常规加密, 原样备份)
头像: head_image.db image_buffer (明文 jpg/png blob)
```
月份不匹配时取消息时间 ±2 月。hardlink 表做兜底（按 file_name 匹配）。

## 4. 语音转码

silk → 24kHz 16bit 单声道 wav。pilk API 只吃**文件路径**：`pilk.silk_to_wav(in.silk, out.wav)`；多分片先逐段转 wav 再用 wave 模块按 data_index 顺序拼接。blob 开头的 `\x02` 前缀不影响 pilk。

## 5. 已放弃项（知道边界即可）

- 表情缓存解密：XML 里 aeskey 为 24 位 hex（12字节），ECB/CBC 直解均不出 GIF/PNG 头，非标准方案。保留 md5/宽高/CDN url + 原样备份。
- 被撤回消息与撤回通知的可靠关联：撤回通知(type 10000)只有文本昵称，无结构化指向。
- wxgf → jpg 转码：HEVC 静图容器，无公开解码路径，保留原样。

## 6. WAL 一致性

热拷贝时各 db 的 -wal 含未 checkpoint 事务（通常 <4MB，最近几分钟）。历史提取可忽略；要精确到拷贝时刻：请用户退出微信（触发 checkpoint）→ 重拷 → 可重开。
