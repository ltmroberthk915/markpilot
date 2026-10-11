# -*- coding: utf-8 -*-
"""群聊全维度提取器: 解密库 -> 结构完整的 SQLite 数据库 + 媒体导出
用法: python extract_group.py <群名或xxx@chatroom ...>
  群名来自 list_groups.py 生成的 workspace/groups.json, 也可直接传 @chatroom id。
环境变量: WXWORK_ROOT(工作根目录, 默认CWD) WXCHAT_DATA(账号数据目录)
          WXCHAT_SELF(本人wxid) WXCHAT_IMG_AES_KEY WXCHAT_IMG_XOR_KEY(hex)
"""
import sqlite3, os, sys, re, json, hashlib, glob, shutil, struct, time
import xml.etree.ElementTree as ET
from datetime import datetime
import zstandard
from Crypto.Cipher import AES
from Crypto.Util import Padding

try:
    import pilk
except ImportError:
    pilk = None

ROOT = os.environ.get("WXWORK_ROOT") or os.getcwd()
DEC = os.path.join(ROOT, "workspace", "decrypted")
XWECHAT = os.environ.get("WXCHAT_DATA") or "D:/xwechat_files/wxid_albeb455hdrc21_fe80"
OUT = os.path.join(ROOT, "output")
SELF_WXID = os.environ.get("WXCHAT_SELF") or "wxid_albeb455hdrc21"

ROOMS = {
    "瓦兰提斯": "43665098904@chatroom",
    "盛夏群岛": "45077454383@chatroom",
    "奥勒留重建2": "49810785755@chatroom",
}

IMG_AES_KEY = (os.environ.get("WXCHAT_IMG_AES_KEY") or "9cf3b566f2dea5fc").encode()
IMG_XOR_KEY = int((os.environ.get("WXCHAT_IMG_XOR_KEY") or "a4"), 16)
V2_MAGIC_FULL = b"\x07\x08V2\x08\x07"
V1_MAGIC_FULL = b"\x07\x08V1\x08\x07"

TYPE_NAMES = {
    1: "文本", 3: "图片", 34: "语音", 42: "名片", 43: "视频", 47: "表情",
    48: "位置", 49: "应用消息", 51: "视频号消息", 10000: "系统通知", 10002: "系统提示",
}
# 合并转发(recorditem/datalist/dataitem)的内层 datatype
MR_TYPES = {1: "文本", 2: "图片", 3: "语音", 4: "视频", 5: "链接", 6: "文件",
            8: "表情", 19: "小程序", 22: "引用/其他", 57: "引用回复"}
APP_TYPE_NAMES = {
    1: "未知应用", 2: "视频", 3: "音乐", 4: "位置", 5: "链接", 6: "文件", 8: "自定义表情",
    9: "转发", 11: "小程序", 15: "群待办", 19: "合并转发", 20: "聊天记录",
    21: "视频号", 24: "小红书", 25: "视频号", 26: "视频号", 27: "音乐", 28: "音乐",
    30: "小程序", 31: "小程序", 33: "小程序", 36: "小程序", 38: "小程序", 51: "视频号",
    57: "引用回复", 63: "音乐", 74: "文件", 87: "优惠券", 92: "视频号",
    2000: "转账", 2001: "红包", 2003: "群公告", 2005: "视频号",
}


def ts2iso(ts):
    try:
        return datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


def maybe_zstd(blob):
    if isinstance(blob, bytes) and blob[:4] == b"\x28\xb5\x2f\xfd":
        try:
            return zstandard.ZstdDecompressor().decompress(blob, max_output_size=64 * 1024 * 1024)
        except Exception:
            return blob
    return blob


def as_text(v):
    if v is None:
        return None
    if isinstance(v, bytes):
        return maybe_zstd(v).decode("utf-8", "replace")
    return str(v)


# ---------------- protobuf (packed_info_data) ----------------
def _varint(buf, i):
    shift = v = 0
    while True:
        if i >= len(buf):
            raise ValueError
        b = buf[i]; i += 1
        v |= (b & 0x7F) << shift
        if not b & 0x80:
            return v, i
        shift += 7
        if shift > 63:
            raise ValueError


def pb_fields(buf):
    """返回 [(field, kind, value)]  完整消耗才有效"""
    out, i = [], 0
    try:
        while i < len(buf):
            tag, i = _varint(buf, i)
            f, wt = tag >> 3, tag & 7
            if f == 0 or f > 64:
                return None
            if wt == 0:
                v, i = _varint(buf, i); out.append((f, "v", v))
            elif wt == 2:
                ln, i = _varint(buf, i)
                if ln > len(buf) - i:
                    return None
                out.append((f, "b", buf[i:i + ln])); i += ln
            elif wt == 5:
                out.append((f, "b", buf[i:i + 4])); i += 4
            elif wt == 1:
                out.append((f, "b", buf[i:i + 8])); i += 8
            else:
                return None
    except Exception:
        return None
    return out or None


HEX32 = re.compile(r"[0-9a-fA-F]{32}")


def pb_md5_tokens(buf):
    fs = pb_fields(buf)
    toks = set()
    if not fs:
        return toks
    for _f, kind, v in fs:
        if kind == "b":
            try:
                s = v.decode("ascii")
                if HEX32.fullmatch(s):
                    toks.add(s.lower())
                    continue
            except Exception:
                pass
            for m in HEX32.findall(v[:128].decode("ascii", "replace")):
                toks.add(m.lower())
    return toks


# ---------------- XML ----------------
_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def xml_parse(content):
    if not content:
        return None
    c = _CTRL_RE.sub("", content).strip()
    if not c:
        return None
    try:
        return ET.fromstring(c)
    except Exception:
        return None


def xtext(root, path, default=None):
    if root is None:
        return default
    n = root.find(path)
    return n.text if n is not None and n.text is not None else default


def xattr(root, path, attr, default=None):
    if root is None:
        return default
    n = root.find(path)
    return n.get(attr, default) if n is not None else default


# ---------------- 图片解密 ----------------
def decrypt_dat(src, dst):
    """支持 旧XOR / V1 / V2, 返回 (fmt, ok)"""
    with open(src, "rb") as f:
        data = f.read()
    if len(data) < 32:
        return None, False
    sig = data[:6]
    if sig in (V2_MAGIC_FULL, V1_MAGIC_FULL):
        key = b"cfcd208495d565ef" if sig == V1_MAGIC_FULL else IMG_AES_KEY
        aes_size, xor_size = struct.unpack_from("<LL", data, 6)
        stored = aes_size // 16 * 16 + (16 if aes_size % 16 == 0 or aes_size % 16 else 0)
        if stored == 0:
            stored = 16
        off = 15
        if off + stored > len(data):
            return None, False
        try:
            dec_aes = Padding.unpad(AES.new(key, AES.MODE_ECB).decrypt(data[off:off + stored]), 16)
        except Exception:
            return None, False
        off += stored
        raw_end = len(data) - xor_size
        if raw_end < off:
            raw_end = off
        dec = dec_aes + data[off:raw_end] + bytes(b ^ IMG_XOR_KEY for b in data[raw_end:])
    else:
        k = data[0] ^ 0xFF
        if (data[1] ^ k) != 0xD8:  # 非jpg基准则遍历
            found = None
            for magic0, magic1 in [(0x89, 0x50), (0x47, 0x49), (0x42, 0x4D), (0x52, 0x49)]:
                kk = data[0] ^ magic0
                if (data[1] ^ kk) == magic1:
                    found = kk
                    break
            if found is None:
                return None, False
            k = found
        dec = bytes(b ^ k for b in data)
    h = dec[:4]
    if h[:3] == b"\xff\xd8\xff":
        fmt = "jpg"
    elif h == b"\x89PNG":
        fmt = "png"
    elif h[:3] == b"GIF":
        fmt = "gif"
    elif h[:4] == b"RIFF":
        fmt = "webp"
    elif h[:4] == b"wxgf":
        fmt = "wxgf"
    elif h[:2] == b"BM":
        fmt = "bmp"
    else:
        fmt = "bin"
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "wb") as f:
        f.write(dec)
    return fmt, fmt not in ("bin",)


# ---------------- 数据库连接 ----------------
def connect(rel):
    return sqlite3.connect(os.path.join(DEC, *rel.split("/")) + ".sqlite")


contact_db = connect("contact/contact.db")
head_db = connect("head_image/head_image.db")
hl_db = connect("hardlink/hardlink.db")
emo_db = connect("emoticon/emoticon.db")
# 手机迁移会把历史写进新建的 message_N.db, 必须动态枚举全部
msg_conns, media_conns = [], []
for _i in range(32):
    if os.path.exists(os.path.join(DEC, "message", f"message_{_i}.db.sqlite")):
        msg_conns.append(connect(f"message/message_{_i}.db"))
    if os.path.exists(os.path.join(DEC, "message", f"media_{_i}.db.sqlite")):
        media_conns.append(connect(f"message/media_{_i}.db"))

for c in [contact_db, head_db, hl_db, emo_db] + msg_conns + media_conns:
    c.execute("PRAGMA journal_mode=OFF")

# 预载映射
room_owner = {}
chat_room_rowid = {}
for rid, un, owner in contact_db.execute("SELECT rowid, username, owner FROM chat_room"):
    chat_room_rowid[un] = rid
    room_owner[un] = owner

contact_name2id = {un: rid for rid, un in contact_db.execute("SELECT rowid, username FROM name2id")}
contact_info = {}
for un, nick, remark, alias, small, big in contact_db.execute(
        "SELECT username, nick_name, remark, alias, small_head_url, big_head_url FROM contact"):
    contact_info[un] = (nick, remark, alias, small, big)

# member_id -> name2id rowid
n2i = {}
for rid, un in contact_db.execute("SELECT rowid, username FROM name2id"):
    n2i[rid] = un
room_members_current = {un: set() for un in chat_room_rowid}
for un, rid in chat_room_rowid.items():
    for (mid,) in contact_db.execute("SELECT member_id FROM chatroom_member WHERE room_id=?", (rid,)):
        if mid in n2i:
            room_members_current[un].add(n2i[mid])

room_detail = {}
for un, ann, ed, pt in contact_db.execute(
        "SELECT username_, announcement_, announcement_editor_, announcement_publish_time_ FROM chat_room_info_detail"):
    room_detail[un] = (ann, ed, pt)

# chat_room.ext_buffer: 群昵称+邀请人
def parse_room_ext(room):
    disp, inviter = {}, {}
    row = contact_db.execute("SELECT ext_buffer FROM chat_room WHERE username=?", (room,)).fetchone()
    if not row or not row[0]:
        return disp, inviter
    buf = row[0]
    fs = pb_fields(buf)
    if not fs:
        return disp, inviter
    for f, kind, v in fs:
        if f == 1 and kind == "b":
            sub = pb_fields(v)
            if not sub:
                continue
            wxid = dname = inv = None
            for sf, sk, sv in sub:
                if sf == 1 and sk == "b":
                    try:
                        wxid = sv.decode("utf-8")
                    except Exception:
                        pass
                elif sf == 2 and sk == "b":
                    try:
                        dname = sv.decode("utf-8") or None
                    except Exception:
                        dname = None
                elif sf == 4 and sk == "b":
                    try:
                        inv = sv.decode("utf-8")
                    except Exception:
                        pass
            if wxid:
                if dname:
                    disp[wxid] = dname
                if inv:
                    inviter[wxid] = inv
    return disp, inviter


# hardlink 映射
hl_months = {rid: m for rid, m in hl_db.execute("SELECT rowid, username FROM dir2id")}
hl_image = {}
for md5, fn, sz, d1, d2 in hl_db.execute("SELECT md5, file_name, file_size, dir1, dir2 FROM image_hardlink_info_v4"):
    hl_image.setdefault(md5.lower(), []).append((fn, sz, d1, d2))
hl_video = {}
for md5, fn, sz, d1, d2 in hl_db.execute("SELECT md5, file_name, file_size, dir1, dir2 FROM video_hardlink_info_v4"):
    hl_video.setdefault(md5.lower(), []).append((fn, sz, d1, d2))
hl_file = {}
for md5, fn, sz, d1, d2 in hl_db.execute("SELECT md5, file_name, file_size, dir1, dir2 FROM file_hardlink_info_v4"):
    hl_file.setdefault(md5.lower(), []).append((fn, sz, d1, d2))

emoji_db_md5 = {}
for md5, cap, cdn, tp in emo_db.execute("SELECT md5, caption, cdn_url, tp_url FROM kNonStoreEmoticonTable"):
    emoji_db_md5[md5.lower()] = (cap, cdn, tp)

# voice 映射 (svr_id -> [(data_index, blob)])
voice_map = {}
for mc in media_conns:
    for svr, di, blob, ct in mc.execute("SELECT svr_id, data_index, voice_data, create_time FROM VoiceInfo"):
        if svr:
            voice_map.setdefault(svr, []).append((int(di or 0), blob, ct))

# 头像
avatar_buf = {}
for un, buf in head_db.execute("SELECT username, image_buffer FROM head_image"):
    if buf:
        avatar_buf[un] = buf

# Name2Id per message db
msg_n2i = []
for c in msg_conns:
    msg_n2i.append({rid: un for rid, un in c.execute("SELECT rowid, user_name FROM Name2Id")})


def _months_around(create_time):
    """消息月份及前后一个月"""
    from datetime import timedelta
    dt = datetime.fromtimestamp(create_time)
    out = [dt.strftime("%Y-%m")]
    for delta in (1, -1, 2, -2):
        out.append((dt + timedelta(days=31 * delta)).strftime("%Y-%m"))
    seen, res = set(), []
    for m in out:
        if m not in seen:
            seen.add(m)
            res.append(m)
    return res


IMG_SUFFIXES = ["_h.dat", ".dat", "_W.dat", "_t.dat", "_t_W.dat"]


def image_paths(room, m5, create_time):
    """attach/<md5(room)>/<月份±>/Img/<m5><后缀>, 按清晰度优先"""
    room_md5 = hashlib.md5(room.encode()).hexdigest()
    out = []
    for suf in IMG_SUFFIXES:
        for m in _months_around(create_time):
            p = os.path.join(XWECHAT, "msg", "attach", room_md5, m, "Img", m5 + suf)
            if os.path.isfile(p):
                out.append(p)
                break
        if out and suf in (".dat", "_h.dat") and len(out) >= 1 and suf == "_h.dat":
            # 已有最高清, 直接用
            return out[:1]
    if not out:  # hardlink 兜底
        for fn, sz, d1, d2 in hl_image.get(m5, []):
            for d in (d1, d2):
                mm = hl_months.get(d)
                if mm:
                    p = os.path.join(XWECHAT, "msg", "attach", room_md5, mm, "Img", fn)
                    if os.path.isfile(p):
                        out.append(p)
    return out


def video_paths(room, m5, create_time):
    out = []
    for suf in [".mp4", "_thumb.jpg"]:
        for m in _months_around(create_time):
            p = os.path.join(XWECHAT, "msg", "video", m, m5 + suf)
            if os.path.isfile(p):
                out.append(p)
                break
        if out and suf == ".mp4":
            return out
    return out


def file_paths(room, m5, create_time, names):
    """names: 候选真实文件名列表(来自XML title / attach_filename / hardlink)"""
    cands = list(names)
    for fn, sz, d1, d2 in hl_file.get(m5, []):
        if fn not in cands:
            cands.append(fn)
    for name in cands:
        for m in _months_around(create_time):
            p = os.path.join(XWECHAT, "msg", "file", m, name)
            if os.path.isfile(p):
                return p
    return None


# ---------------- 输出库 ----------------
SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE group_info(
  key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE members(
  wxid TEXT PRIMARY KEY, group_display_name TEXT, inviter_wxid TEXT,
  nick_name TEXT, remark TEXT, alias TEXT,
  is_current_member INTEGER, is_self INTEGER, msg_count INTEGER DEFAULT 0,
  avatar_path TEXT, small_head_url TEXT, big_head_url TEXT);
CREATE TABLE messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER UNIQUE, local_id INTEGER, room_id TEXT,
  create_time INTEGER, create_time_iso TEXT, sort_seq INTEGER,
  sender_wxid TEXT, sender_display TEXT, is_self INTEGER,
  type INTEGER, subtype INTEGER, type_name TEXT,
  is_recalled INTEGER DEFAULT 0,
  text_content TEXT, raw_content TEXT, at_wxids TEXT,
  quote_server_id INTEGER, quote_text TEXT, quote_sender TEXT,
  extra_json TEXT);
CREATE INDEX idx_msg_time ON messages(create_time);
CREATE INDEX idx_msg_sender ON messages(sender_wxid);
CREATE INDEX idx_msg_type ON messages(type, subtype);
CREATE TABLE message_refs(
  from_server_id INTEGER, to_server_id INTEGER, kind TEXT);
CREATE INDEX idx_refs_to ON message_refs(to_server_id);
CREATE TABLE merged_records(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER, idx INTEGER,
  datatype INTEGER, datatype_name TEXT,
  sender_name TEXT, src_create_time INTEGER, src_time_text TEXT,
  orig_server_id INTEGER,
  title TEXT, content TEXT,
  extra_json TEXT);
CREATE INDEX idx_mr_msg ON merged_records(server_id);
CREATE INDEX idx_mr_time ON merged_records(src_create_time);
CREATE TABLE media(
  media_id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER, kind TEXT, variant TEXT, md5 TEXT,
  src_path TEXT, export_path TEXT, size_bytes INTEGER, fmt TEXT,
  duration_ms INTEGER, width INTEGER, height INTEGER, file_name TEXT);
CREATE INDEX idx_media_msg ON media(server_id);
CREATE VIEW v_by_sender AS
  SELECT sender_wxid, MAX(COALESCE(NULLIF(group_display_name,''),NULLIF(remark,''),nick_name,sender_wxid)) AS display,
         COUNT(*) AS msgs, MIN(create_time_iso) AS first, MAX(create_time_iso) AS last
  FROM messages m LEFT JOIN members ON members.wxid = m.sender_wxid
  GROUP BY sender_wxid ORDER BY msgs DESC;
CREATE VIEW v_by_type AS
  SELECT type, subtype, type_name, COUNT(*) AS msgs FROM messages GROUP BY type, subtype ORDER BY msgs DESC;
CREATE VIEW v_by_day AS
  SELECT date(create_time, 'unixepoch', 'localtime') AS day, COUNT(*) AS msgs,
         COUNT(DISTINCT sender_wxid) AS active_senders
  FROM messages GROUP BY day ORDER BY day;
CREATE VIEW v_by_month AS
  SELECT strftime('%Y-%m', create_time, 'unixepoch', 'localtime') AS month, COUNT(*) AS msgs
  FROM messages GROUP BY month ORDER BY month;
CREATE VIEW v_text_only AS
  SELECT create_time_iso, sender_display, text_content FROM messages WHERE type=1 AND is_recalled=0;
"""


def _safe_name(fname):
    """清洗文件名并截断, 规避 Windows MAX_PATH(导出路径还带群名/月份/前缀)"""
    safe = re.sub(r'[\\/:*?"<>|]', "_", fname).strip()
    if len(safe) > 110:
        stem, ext = os.path.splitext(safe)
        safe = stem[:95] + "~" + (ext[:12] if ext else "")
    return safe


def _rmtree_lenient(p):
    """清理旧导出; 被占用的文件(如正在PDF阅读器里打开)跳过即可, 导出阶段会覆盖/跳过"""
    import stat as _st

    def _onexc(fn, path, exc):
        try:
            os.chmod(path, _st.S_IWRITE)
            fn(path)
        except Exception:
            pass

    shutil.rmtree(p, onexc=_onexc)


def build_room(name, room):
    if name.endswith("@chatroom"):
        row = contact_db.execute(
            "SELECT COALESCE(remark, nick_name) FROM contact WHERE username=?", (room,)).fetchone()
        name = (row[0] if row and row[0] else name)
    out_db = os.path.join(OUT, f"{name}_聊天记录.db")
    exp = os.path.join(OUT, f"{name}_export")
    if os.path.exists(out_db):
        os.remove(out_db)
    if os.path.exists(exp):
        _rmtree_lenient(exp)  # 重新提取时自清理, 避免旧导出残留导致文件名冲突
    for d in ["images", "voice", "video", "file", "emoji", "avatars"]:
        os.makedirs(os.path.join(exp, d), exist_ok=True)
    odb = sqlite3.connect(out_db)
    odb.executescript(SCHEMA)

    # ---- 群信息 ----
    nick, remark = contact_db.execute(
        "SELECT nick_name, remark FROM contact WHERE username=?", (room,)).fetchone() or (name, None)
    ann, ann_ed, ann_pt = room_detail.get(room, (None, None, None))
    disp, inviter = parse_room_ext(room)
    for k, v in [
        ("room_id", room), ("name", name), ("nick_name", nick), ("remark", remark),
        ("owner_wxid", room_owner.get(room)), ("announcement", ann),
        ("announcement_editor", ann_ed), ("announcement_publish_time", ann_pt),
        ("announcement_publish_time_iso", ts2iso(ann_pt) if ann_pt else None),
        ("current_member_count", len(room_members_current.get(room, ()))),
        ("known_member_count", len(set(disp) | room_members_current.get(room, set()))),
        ("self_wxid", SELF_WXID),
        ("extract_time", ts2iso(time.time())),
    ]:
        odb.execute("INSERT OR REPLACE INTO group_info VALUES (?,?)", (k, v))

    # ---- 成员 ----
    all_members = set(disp) | set(inviter) | room_members_current.get(room, set())
    cur = room_members_current.get(room, set())
    senders_seen = set()
    avatars_written = {}
    mem_rows = []
    for wxid in all_members:
        ci = contact_info.get(wxid, (None,) * 5)
        gdn = disp.get(wxid)
        if gdn is None:
            gdn = ci[0] if ci[0] else None
        ap = None
        if wxid in avatar_buf:
            h = avatar_buf[wxid][:4]
            ext = "jpg" if h[:3] == b"\xff\xd8\xff" else ("png" if h == b"\x89PNG" else "bin")
            ap = f"{name}_export/avatars/{wxid}.{ext}"
            fp = os.path.join(OUT, ap)
            if not os.path.exists(fp):
                with open(fp, "wb") as f:
                    f.write(avatar_buf[wxid])
            avatars_written[wxid] = ap
        mem_rows.append((wxid, gdn, inviter.get(wxid), ci[0], ci[1], ci[2],
                         1 if wxid in cur else 0, 1 if wxid == SELF_WXID else 0, 0, ap, ci[3], ci[4]))
    odb.executemany("INSERT OR REPLACE INTO members VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", mem_rows)

    # ---- 消息 ----
    tbl = "Msg_" + hashlib.md5(room.encode()).hexdigest()
    raw_rows = []
    for dbi, c in enumerate(msg_conns):
        n2i = msg_n2i[dbi]
        try:
            rows = c.execute(
                f'SELECT local_id, server_id, local_type, sort_seq, real_sender_id, create_time, '
                f'status, source, message_content, compress_content, packed_info_data, '
                f'WCDB_CT_message_content, WCDB_CT_source FROM "{tbl}"').fetchall()
        except sqlite3.OperationalError:
            continue
        for r in rows:
            raw_rows.append((dbi,) + r)
        print(f"  [db{dbi}] {len(rows)} rows")
    raw_rows.sort(key=lambda x: x[4])  # sort_seq
    print(f"  共 {len(raw_rows)} 条消息")

    # 撤回: 10000 撤回提示按 server_id 无法直接映射, 保留提示事件
    stats = {"media_ok": 0, "media_miss": 0, "voice_ok": 0, "voice_miss": 0}
    msg_insert = []
    refs = []
    media_rows = []
    merged_rows = []  # 合并转发内层记录(房间级累积, 勿放消息循环内)

    def export_image(md5hex, server_id, create_time):
        m5 = md5hex.lower()
        paths = image_paths(room, m5, create_time)
        if not paths:
            stats["media_miss"] += 1
            return None, None, None
        ym = datetime.fromtimestamp(create_time).strftime("%Y-%m")
        os.makedirs(os.path.join(exp, "images", ym), exist_ok=True)
        for src in paths:
            dst = os.path.join(exp, "images", ym, f"{server_id or int(create_time)}_{m5[:16]}.img")
            fmt, ok = decrypt_dat(src, dst)
            if ok:
                final = dst + "." + fmt
                os.replace(dst, final)
                stats["media_ok"] += 1
                return os.path.relpath(final, OUT).replace("\\", "/"), fmt, os.path.getsize(final)
        stats["media_miss"] += 1
        return None, None, None

    def export_voice(server_id, create_time):
        parts = voice_map.get(server_id)
        if not parts:
            stats["voice_miss"] += 1
            return None, None
        parts.sort(key=lambda x: x[0])
        import wave
        ym = datetime.fromtimestamp(create_time).strftime("%Y-%m")
        dst = os.path.join(exp, "voice", ym, f"{server_id}.wav")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        frames = 0
        with wave.open(dst, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)
            for di, blob, ct in parts:
                ts = os.path.join(exp, "voice", f"_tmp_{server_id}_{di}.silk")
                tw = ts + ".wav"
                with open(ts, "wb") as f:
                    f.write(blob)
                try:
                    pilk.silk_to_wav(ts, tw)
                    with wave.open(tw, "rb") as r:
                        w.writeframes(r.readframes(r.getnframes()))
                        frames += r.getnframes()
                except Exception:
                    pass
                for t in (ts, tw):
                    if os.path.exists(t):
                        os.remove(t)
        if frames == 0:
            os.remove(dst)
            stats["voice_miss"] += 1
            return None, None
        stats["voice_ok"] += 1
        return os.path.relpath(dst, OUT).replace("\\", "/"), frames * 1000 // 24000

    def export_video(m5hex, server_id, create_time):
        paths = video_paths(room, m5hex.lower(), create_time)
        if not paths:
            stats["media_miss"] += 1
            return None, None, None, None
        src = paths[0]
        ym = datetime.fromtimestamp(create_time).strftime("%Y-%m")
        fname = os.path.basename(src)
        safe = _safe_name(fname)
        dst = os.path.join(exp, "video", ym, f"{server_id or int(create_time)}_{safe}")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if not os.path.exists(dst):
            shutil.copy2(src, dst)
        stats["media_ok"] += 1
        return (os.path.relpath(dst, OUT).replace("\\", "/"), os.path.splitext(fname)[1].lstrip(".") or "bin",
                os.path.getsize(dst), fname)

    def export_file(m5hex, server_id, create_time, names):
        src = file_paths(room, m5hex.lower() if m5hex else "", create_time, names or [])
        if not src:
            stats["media_miss"] += 1
            return None, None, None, None
        ym = datetime.fromtimestamp(create_time).strftime("%Y-%m")
        fname = os.path.basename(src)
        safe = _safe_name(fname)
        dst = os.path.join(exp, "file", ym, f"{server_id or int(create_time)}_{safe}")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if not os.path.exists(dst):
            shutil.copy2(src, dst)
        stats["media_ok"] += 1
        return (os.path.relpath(dst, OUT).replace("\\", "/"), os.path.splitext(fname)[1].lstrip(".") or "bin",
                os.path.getsize(dst), fname)

    for (dbi, local_id, server_id, local_type, sort_seq, real_sender_id, create_time,
         status, source, message_content, compress_content, packed_info_data,
         ct_mc, ct_src) in raw_rows:
        mtype = local_type & 0xFFFFFFFF
        msub = (local_type >> 32) & 0xFFFFFFFF
        sender = msg_n2i[dbi].get(real_sender_id) or ""
        senders_seen.add(sender)
        content = message_content if not isinstance(message_content, bytes) or ct_mc != 4 else maybe_zstd(message_content)
        if isinstance(content, bytes):
            content = content.decode("utf-8", "replace")
        if not content and compress_content:
            c2 = maybe_zstd(compress_content) if isinstance(compress_content, bytes) else compress_content
            try:
                content = c2.decode("utf-8", "replace") if isinstance(c2, bytes) else str(c2)
            except Exception:
                pass
        # 群消息内容前缀 "wxid:\n"
        body = content or ""
        if body.startswith(sender + ":\n"):
            body = body[len(sender) + 2:]
        src_xml = as_text(source) if isinstance(source, bytes) and ct_src == 4 else (source if isinstance(source, str) else as_text(source))
        at_list = None
        if src_xml:
            m = re.search(r"<atuserlist>(?:<!\[CDATA\[)?([^<\]]+)", src_xml)
            if m and m.group(1).strip():
                at_list = ",".join(x for x in m.group(1).strip().split(",") if x)
        pinfo_md5s = pb_md5_tokens(packed_info_data) if packed_info_data else set()

        extra = {}
        text = None
        quote_sid = quote_text = quote_sender = None
        media_items = []  # (kind, variant, md5, src, export, size, fmt, dur, w, h, fname)

        tname = TYPE_NAMES.get(mtype, f"未知({mtype})")
        if mtype == 1:
            text = body
        elif mtype == 3:
            tname = "图片"
            root = xml_parse(body)
            extra["aeskey"] = xattr(root, "img", "aeskey")
            extra["cdnthumburl"] = xattr(root, "img", "cdnthumburl")
            extra["width"] = xattr(root, "img", "cdnthumbwidth")
            extra["height"] = xattr(root, "img", "cdnthumbheight")
            text = "[图片]"
            for m5 in pinfo_md5s:
                ep, fmt, sz = export_image(m5, server_id, create_time)
                if ep:
                    media_items.append(("image", "best", m5, None, ep, sz, fmt,
                                        None, extra.get("width"), extra.get("height"), None))
                    break
            else:
                for m5 in pinfo_md5s:
                    media_items.append(("image", "missing", m5, None, None, None, None, None, None, None, None))
        elif mtype == 34:
            tname = "语音"
            root = xml_parse(body)
            vl = xattr(root, "voicemsg", "voicelength")
            extra["duration_ms"] = int(vl) if vl and vl.isdigit() else None
            extra["voiceformat"] = xattr(root, "voicemsg", "voiceformat")
            text = f"[语音 {int(vl) // 1000 if vl and vl.isdigit() else '?'}秒]"
            ep, dur = export_voice(server_id, create_time)
            media_items.append(("voice", "", None, None, ep, None, "wav", dur or extra.get("duration_ms"), None, None, None))
        elif mtype == 43:
            tname = "视频"
            root = xml_parse(body)
            extra["playlength"] = xattr(root, "videomsg", "playlength")
            extra["aeskey"] = xattr(root, "videomsg", "aeskey")
            text = f"[视频 {extra['playlength'] or ''}秒]"
            done = False
            for m5 in pinfo_md5s:
                ep, fmt, size, base = export_video(m5, server_id, create_time)
                if ep:
                    media_items.append(("video", "", m5, None, ep, size, fmt,
                                        int(extra["playlength"]) * 1000 if extra.get("playlength", "").isdigit() else None,
                                        None, None, base))
                    done = True
                    break
            if not done:
                media_items.append(("video", "missing", ",".join(pinfo_md5s) if pinfo_md5s else None,
                                    None, None, None, None, None, None, None, None))
        elif mtype == 47:
            tname = "表情"
            root = xml_parse(body)
            m5 = (xattr(root, "emoji", "md5") or "").lower()
            extra["md5"] = m5
            extra["width"] = xattr(root, "emoji", "width")
            extra["height"] = xattr(root, "emoji", "height")
            cap, cdn, tp = emoji_db_md5.get(m5, (None, None, None))
            extra["caption"] = cap or xattr(root, "emoji", "extern_url")
            extra["cdn_url"] = cdn or xattr(root, "emoji", "cdnurl")
            text = f"[表情{(':' + cap) if cap else ''}]"
            if m5:
                # 本地缓存为加密文件, 原样备份; 数据库保留 md5/尺寸/链接
                ep = None
                for g in glob.glob(os.path.join(XWECHAT, "cache", "*", "Emoticon", m5[:2], m5)):
                    ym = datetime.fromtimestamp(create_time).strftime("%Y-%m")
                    dst = os.path.join(exp, "emoji", f"{m5}.dat")
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    if not os.path.exists(dst):
                        shutil.copy2(g, dst)
                    ep = os.path.relpath(dst, OUT).replace("\\", "/")
                    break
                media_items.append(("emoji", "", m5, None, ep, None, "dat-encrypted",
                                    None, extra.get("width"), extra.get("height"), None))
        elif mtype == 10000:
            tname = "系统通知"
            text = body.strip()
            if "撤回了一条消息" in body:
                extra["event"] = "recall_notice"
            elif "修改群名为" in body:
                extra["event"] = "rename_group"
            elif "加入了群聊" in body:
                extra["event"] = "join"
            elif "移出了群聊" in body or "被移出群聊" in body:
                extra["event"] = "remove"
            elif "拍一拍" in body:
                extra["event"] = "pat"
        elif mtype == 10002:
            tname = "系统提示"
            text = body.strip()[:500]
        elif mtype == 42:
            root = xml_parse(body)
            extra["card_nickname"] = xattr(root, "msgsender", "nickname") or xtext(root, "msgsender/nickname")
            text = f"[名片 {extra.get('card_nickname') or ''}]"
        elif mtype == 48:
            root = xml_parse(body)
            extra["label"] = xattr(root, "location", "label")
            extra["poiname"] = xattr(root, "location", "poiname")
            text = f"[位置 {extra.get('poiname') or extra.get('label') or ''}]"
        elif mtype == 49:
            root = xml_parse(body)
            apptype = xtext(root, "appmsg/type")
            try:
                apptype_i = int(apptype) if apptype else 0
            except Exception:
                apptype_i = 0
            if msub:
                subname = APP_TYPE_NAMES.get(msub) or APP_TYPE_NAMES.get(apptype_i) or f"应用{msub}"
            else:
                subname = APP_TYPE_NAMES.get(apptype_i, f"应用{apptype_i}")
            tname = subname
            title = xtext(root, "appmsg/title")
            desc = xtext(root, "appmsg/des")
            url = xtext(root, "appmsg/url")
            extra.update({"app_type": apptype_i, "title": title, "des": desc, "url": url})
            if apptype_i == 57 or msub == 57:
                ref = root.find("appmsg/refermsg") if root is not None else None
                if ref is not None:
                    sv = xtext(ref, "svrid")
                    quote_sid = int(sv) if sv and sv.isdigit() else None
                    quote_text = xtext(ref, "content")
                    quote_sender = xtext(ref, "displayname")
                    extra["refer_type"] = xtext(ref, "type")
                text = (title or "") + (f"  ↩ 引用[{quote_sender}]" if quote_sender else "")
            elif apptype_i == 6 or msub == 6:
                fn = xtext(root, "appmsg/appattach/attach_filename") or title
                extra["file_name"] = fn
                text = f"[文件] {fn or title}"
                xml_md5 = (xtext(root, "appmsg/md5") or "").lower()
                m5_cands = [m for m in ({xml_md5} | pinfo_md5s) if m]
                done = False
                for m5 in m5_cands:
                    ep, fmt, size, base = export_file(m5, server_id, create_time, [fn] if fn else [])
                    if ep:
                        media_items.append(("file", "", m5, None, ep, size, fmt, None, None, None, base))
                        done = True
                        break
                if not done:
                    media_items.append(("file", "missing", ",".join(m5_cands) if m5_cands else None,
                                        None, None, None, None, None, None, None, fn))
            elif apptype_i in (19, 20) or msub in (19, 20):
                text = f"[合并转发] {title or ''}"
                # 内层逐条记录: appmsg/recorditem CDATA -> recordinfo -> datalist/dataitem
                ri = root.find("appmsg/recorditem") if root is not None else None
                if ri is not None and ri.text:
                    try:
                        info = ET.fromstring(_CTRL_RE.sub("", ri.text).strip())
                    except Exception:
                        info = None
                    if info is not None:
                        items = info.findall(".//dataitem")
                        extra["record_count"] = len(items)
                        for i2, item in enumerate(items):
                            it = lambda p: (item.find(p).text if item.find(p) is not None and item.find(p).text else None)
                            dt = item.get("datatype")
                            dti = int(dt) if dt and dt.isdigit() else None
                            sct = it("srcMsgCreateTime")
                            fnm = it("fromnewmsgid")
                            hu = item.find("dataitemsource/hashusername")
                            mre = {"dataid": item.get("dataid"),
                                   "head_url": it("sourceheadurl"),
                                   "cdn_thumb": it("cdnthumburl"),
                                   "duration_ms": it("duration")}
                            if hu is not None and hu.text:
                                mre["hash_username"] = hu.text
                            merged_rows.append((
                                server_id, i2, dti, MR_TYPES.get(dti, f"类型{dti}"),
                                it("sourcename"),
                                int(sct) if sct and sct.isdigit() else None,
                                it("sourcetime"),
                                int(fnm) if fnm and fnm.isdigit() else None,
                                it("datatitle"), it("datadesc"),
                                json.dumps(mre, ensure_ascii=False)))
            elif apptype_i == 2000:
                text = f"[转账] {title or ''}"
            elif apptype_i == 2001:
                text = f"[红包] {title or ''}"
            else:
                text = f"[{subname}] {title or desc or ''}"
        else:
            text = body[:200] if body else f"[{tname}]"

        # raw_content 保留原始体(截断超大)
        raw_keep = body if body and len(body) <= 200000 else (body[:200000] + "...[截断]" if body else None)
        gdn = disp.get(sender)
        if gdn is None:
            ci = contact_info.get(sender)
            if ci:
                gdn = ci[1] or ci[0] or sender
            else:
                gdn = sender
        msg_insert.append((
            server_id if server_id else None, local_id, room,
            create_time, ts2iso(create_time), sort_seq,
            sender, gdn, 1 if sender == SELF_WXID else 0,
            mtype, msub or None, tname, 0,
            text, raw_keep, at_list,
            quote_sid, (quote_text[:2000] if quote_text else None), quote_sender,
            json.dumps(extra, ensure_ascii=False) if extra else None))
        if quote_sid:
            refs.append((server_id, quote_sid, "quote"))
        for it in media_items:
            media_rows.append((server_id,) + it)

    odb.executemany(
        "INSERT INTO messages(server_id, local_id, room_id, create_time, create_time_iso, sort_seq, "
        "sender_wxid, sender_display, is_self, type, subtype, type_name, is_recalled, text_content, "
        "raw_content, at_wxids, quote_server_id, quote_text, quote_sender, extra_json) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", msg_insert)
    odb.executemany("INSERT INTO message_refs VALUES (?,?,?)", refs)
    odb.executemany(
        "INSERT INTO merged_records(server_id, idx, datatype, datatype_name, sender_name, "
        "src_create_time, src_time_text, orig_server_id, title, content, extra_json) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)", merged_rows)
    odb.executemany(
        "INSERT INTO media(server_id, kind, variant, md5, src_path, export_path, size_bytes, fmt, "
        "duration_ms, width, height, file_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", media_rows)

    # 成员消息计数
    for wxid, n in odb.execute("SELECT sender_wxid, COUNT(*) FROM messages GROUP BY sender_wxid").fetchall():
        odb.execute("UPDATE members SET msg_count=? WHERE wxid=?", (n, wxid))
    # 补充发送者(可能不在成员表——已退群且无ext记录)
    known = {r[0] for r in odb.execute("SELECT wxid FROM members")}
    for wxid in senders_seen - known:
        ci = contact_info.get(wxid, (None,) * 5)
        ap = None
        if wxid in avatar_buf:
            h = avatar_buf[wxid][:4]
            ext = "jpg" if h[:3] == b"\xff\xd8\xff" else ("png" if h == b"\x89PNG" else "bin")
            ap = f"{name}_export/avatars/{wxid}.{ext}"
            fp = os.path.join(OUT, ap)
            if not os.path.exists(fp):
                with open(fp, "wb") as f:
                    f.write(avatar_buf[wxid])
        n = odb.execute("SELECT COUNT(*) FROM messages WHERE sender_wxid=?", (wxid,)).fetchone()[0]
        odb.execute("INSERT OR REPLACE INTO members VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (wxid, ci[0] or wxid, None, ci[0], ci[1], ci[2], 0,
                     1 if wxid == SELF_WXID else 0, n, ap, ci[3], ci[4]))

    odb.commit()
    # 校验摘要
    total, tmin, tmax = odb.execute("SELECT COUNT(*), MIN(create_time), MAX(create_time) FROM messages").fetchone()
    resolved = odb.execute("SELECT COUNT(*) FROM message_refs r JOIN messages m ON m.server_id=r.to_server_id").fetchone()[0]
    refs_total = odb.execute("SELECT COUNT(*) FROM message_refs").fetchone()[0]
    print(f"\n[{name}] 消息 {total} 条  {ts2iso(tmin)} ~ {ts2iso(tmax)}")
    print(f"  引用解析: {resolved}/{refs_total}")
    mr_n = odb.execute("SELECT COUNT(*) FROM merged_records").fetchone()[0]
    if mr_n:
        print(f"  合并转发内层记录: {mr_n} 条")
    print(f"  媒体: 图片/视频/文件导出成功 {stats['media_ok']}, 缺失 {stats['media_miss']}; 语音 {stats['voice_ok']}/{stats['voice_ok']+stats['voice_miss']}")
    print("  类型分布:")
    for t, s, n2, n in odb.execute("SELECT type, subtype, type_name, COUNT(*) AS n FROM messages GROUP BY type, subtype ORDER BY n DESC LIMIT 15"):
        print(f"    {t}/{s or '-'} {n2}: {n}")
    print("  发送者TOP8:")
    for r in odb.execute("SELECT display, msgs FROM v_by_sender LIMIT 8"):
        print(f"    {r[0]}: {r[1]}")
    odb.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    odb.close()
    return out_db


def resolve_rooms(args):
    known = dict(ROOMS)
    gj = os.path.join(ROOT, "workspace", "groups.json")
    if os.path.exists(gj):
        with open(gj, encoding="utf-8") as f:
            for g in json.load(f):
                known.setdefault(g["name"], g["username"])
    out = {}
    for a in args:
        if a.endswith("@chatroom"):
            out[a] = a
        elif a in known:
            out[a] = known[a]
        else:
            sys.exit(f"未知群: {a} —— 先运行 list_groups.py 生成 groups.json 后按群名传参")
    return out


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit("用法: python extract_group.py <群名或xxx@chatroom ...>  (群名见 list_groups.py 输出)")
    os.makedirs(OUT, exist_ok=True)
    for nm, room in resolve_rooms(args).items():
        print(f"\n{'='*70}\n### {nm} ({room})")
        build_room(nm, room)


if __name__ == "__main__":
    main()
