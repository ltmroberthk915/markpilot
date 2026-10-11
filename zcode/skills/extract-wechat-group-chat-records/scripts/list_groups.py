# -*- coding: utf-8 -*-
"""列出所有群聊: 名称/成员数/消息量/时间范围/最近摘要"""
import sqlite3, os, hashlib, json, glob, re
from datetime import datetime

ROOT = os.environ.get("WXWORK_ROOT") or os.getcwd()
DEC = os.path.join(ROOT, "workspace", "decrypted")
# 手机迁移会新建 message_N.db, 动态枚举全部 message_N.db
MSG_DBS = []
for _p in sorted(glob.glob(os.path.join(DEC, "message", "message_*.db.sqlite"))):
    _m = re.search(r"message_(\d+)\.db\.sqlite$", os.path.basename(_p))
    if _m:
        MSG_DBS.append(f"message/message_{_m.group(1)}.db")

contact = sqlite3.connect(os.path.join(DEC, "contact", "contact.db.sqlite"))
session = sqlite3.connect(os.path.join(DEC, "session", "session.db.sqlite"))
msgconns = [sqlite3.connect(os.path.join(DEC, *p.split("/")) + ".sqlite") for p in MSG_DBS]

# 群成员数: chatroom_member.room_id -> chat_room 表的 rowid (username 主键非rowid, 需用 rowid)
member_count = {}
for room_rowid, un in contact.execute("SELECT rowid, username FROM chat_room"):
    cnt = contact.execute("SELECT COUNT(*) FROM chatroom_member WHERE room_id=?", (room_rowid,)).fetchone()[0]
    member_count[un] = cnt

sess = {}
for un, summary, ts, sender in session.execute(
        "SELECT username, summary, last_timestamp, last_sender_display_name FROM SessionTable"):
    sess[un] = (summary, ts, sender)

rows = []
for un, nick, remark, local_type in contact.execute(
        "SELECT username, nick_name, remark, local_type FROM contact WHERE username LIKE '%@chatroom'"):
    tbl = "Msg_" + hashlib.md5(un.encode()).hexdigest()
    total = 0
    tmin = tmax = None
    for c in msgconns:
        try:
            cnt, mn, mx = c.execute(
                f'SELECT COUNT(*), MIN(create_time), MAX(create_time) FROM "{tbl}"').fetchone()
        except sqlite3.OperationalError:
            continue
        total += cnt
        if mn and (tmin is None or mn < tmin): tmin = mn
        if mx and (tmax is None or mx > tmax): tmax = mx
    summary, ts, sender = sess.get(un, ("", None, ""))
    rows.append({
        "username": un, "name": remark or nick or un, "nick": nick, "remark": remark,
        "members": member_count.get(un, 0), "msgs": total,
        "first": datetime.fromtimestamp(tmin).strftime("%Y-%m-%d") if tmin else None,
        "last": datetime.fromtimestamp(tmax).strftime("%Y-%m-%d") if tmax else None,
        "last_summary": (summary or "")[:40], "last_sender": sender or "",
    })

rows.sort(key=lambda r: -r["msgs"])
print(f"{'#':>3} {'消息量':>7} {'成员':>4}  起始        ~ 最近        群名")
for i, r in enumerate(rows[:60], 1):
    print(f"{i:>3} {r['msgs']:>7} {r['members']:>4}  {r['first'] or '-':10} ~ {r['last'] or '-':10}  {r['name']}  [{r['username']}]")

with open(os.path.join(ROOT, "workspace", "groups.json"), "w", encoding="utf-8") as f:
    json.dump(rows, f, ensure_ascii=False, indent=1)
print(f"\n共 {len(rows)} 个群, 前60已显示; 全量已存 workspace/groups.json")
