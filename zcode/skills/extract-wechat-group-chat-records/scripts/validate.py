# -*- coding: utf-8 -*-
"""深度校验: 自动发现 output/*_聊天记录.db, 与源解密库逐字段抽样比对 + 媒体魔数检查
输出: output/校验报告.md
环境变量: WXWORK_ROOT(默认CWD)
"""
import sqlite3, os, sys, random, glob, re
from datetime import datetime

ROOT = os.environ.get("WXWORK_ROOT") or os.getcwd()
DEC = os.path.join(ROOT, "workspace", "decrypted")
OUT = os.path.join(ROOT, "output")

# 手机迁移会新建 message_N.db, 动态枚举全部
msg_conns = [sqlite3.connect(p) for p in sorted(glob.glob(os.path.join(DEC, "message", "message_*.db.sqlite")))
             if re.search(r"message_\d+\.db\.sqlite$", os.path.basename(p))]


def src_rows(room):
    import hashlib
    tbl = "Msg_" + hashlib.md5(room.encode()).hexdigest()
    rows = {}
    for c in msg_conns:
        n2i = dict(c.execute("SELECT rowid, user_name FROM Name2Id"))
        try:
            for lid, sid, lt, ct, rs in c.execute(
                    f'SELECT local_id, server_id, local_type, create_time, real_sender_id FROM "{tbl}"'):
                rows[sid] = (lt, ct, n2i.get(rs))
        except sqlite3.OperationalError:
            pass
    return rows


dbs = sorted(glob.glob(os.path.join(OUT, "*_聊天记录.db")))
if not dbs:
    sys.exit("output/ 下未发现 *_聊天记录.db")
report = [f"# 提取校验报告\n\n生成时间: {datetime.now():%Y-%m-%d %H:%M:%S}"]
allok = True
random.seed(42)

for dbp in dbs:
    nm = os.path.basename(dbp).replace("_聊天记录.db", "")
    odb = sqlite3.connect(dbp)
    odb.row_factory = sqlite3.Row
    report.append(f"\n## {nm}")
    room = odb.execute("SELECT value FROM group_info WHERE key='room_id'").fetchone()[0]
    ic = odb.execute("PRAGMA integrity_check").fetchone()[0]
    n_out, tmin, tmax = odb.execute("SELECT COUNT(*), MIN(create_time), MAX(create_time) FROM messages").fetchone()
    src = src_rows(room)
    report.append(f"- integrity_check: **{ic}**")
    report.append(f"- 消息数: 输出 {n_out} / 源 {len(src)}  → {'✅ 一致' if n_out == len(src) else '❌ 不一致'}")
    allok &= n_out == len(src)
    fmt_ts = lambda t: datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M:%S") if t else "—(无消息)"
    report.append(f"- 时间范围: {fmt_ts(tmin)} ~ {fmt_ts(tmax)}")

    sample = random.sample(sorted(src), min(50, len(src)))
    bad = sum(
        1 for sid in sample
        if (lambda r, s: r is None or r["sender_wxid"] != s[2] or r["create_time"] != s[1]
            or r["type"] != (s[0] & 0xFFFFFFFF) or (r["subtype"] or 0) != (s[0] >> 32))(
            odb.execute("SELECT sender_wxid, create_time, type, subtype FROM messages WHERE server_id=?", (sid,)).fetchone(),
            src[sid]))
    report.append(f"- 随机抽样字段比对: {len(sample) - bad}/{len(sample)} 一致 {'✅' if bad == 0 else '❌'}")
    allok &= bad == 0

    dup = odb.execute("SELECT COUNT(*) FROM (SELECT server_id FROM messages GROUP BY server_id HAVING COUNT(*)>1)").fetchone()[0]
    report.append(f"- server_id 重复组: {dup} {'✅' if dup == 0 else '❌'}")

    mrows = odb.execute("SELECT media_id, kind, export_path, fmt FROM media WHERE export_path IS NOT NULL").fetchall()
    miss = badmagic = 0
    for mr in mrows:
        p = os.path.join(OUT, mr["export_path"])
        if not os.path.exists(p):
            miss += 1
            continue
        with open(p, "rb") as f:
            h = f.read(8)
        ok = (mr["kind"] == "voice" and h[:4] == b"RIFF") or (
            mr["kind"] == "image" and (h[:3] == b"\xff\xd8\xff" or h[:4] in (b"\x89PNG", b"RIFF", b"wxgf") or h[:3] == b"GIF" or h[:2] == b"BM")) or (
            mr["kind"] == "video" and (h[4:8] == b"ftyp" or h[:3] == b"\xff\xd8\xff")) or (
            mr["kind"] in ("file", "emoji"))
        if not ok:
            badmagic += 1
    report.append(f"- 媒体导出 {len(mrows)} 项: 文件缺失 {miss}, 魔数异常 {badmagic} {'✅' if miss == 0 and badmagic == 0 else '⚠️'}")

    n_med = odb.execute("SELECT COUNT(*) FROM media").fetchone()[0]
    n_missing = odb.execute("SELECT COUNT(*) FROM media WHERE variant='missing'").fetchone()[0]
    report.append(f"- 媒体总索引 {n_med} 条, 本地未下载缺失 {n_missing} 条")
    rt = odb.execute("SELECT COUNT(*) FROM message_refs").fetchone()[0]
    rr = odb.execute("SELECT COUNT(*) FROM message_refs r JOIN messages m ON m.server_id=r.to_server_id").fetchone()[0]
    report.append(f"- 引用链解析: {rr}/{rt} ({100 * rr / max(rt, 1):.2f}%)")
    orphan = odb.execute("SELECT COUNT(DISTINCT sender_wxid) FROM messages WHERE sender_wxid NOT IN (SELECT wxid FROM members)").fetchone()[0]
    report.append(f"- 发送者未入成员表: {orphan} 人")
    mem = odb.execute("SELECT COUNT(*) FROM members").fetchone()[0]
    av = odb.execute("SELECT COUNT(*) FROM members WHERE avatar_path IS NOT NULL").fetchone()[0]
    report.append(f"- 成员 {mem} 人, 头像 {av} 个")

with open(os.path.join(OUT, "校验报告.md"), "w", encoding="utf-8") as f:
    f.write("\n".join(report))
print("\n".join(report))
print("\n总体:", "✅ 全部通过" if allok else "⚠️ 存在警告项")
