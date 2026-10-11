# -*- coding: utf-8 -*-
"""解密工作区副本: workspace/source/<rel>.db -> workspace/decrypted/<rel>.sqlite
密钥来自 wcdb-key-tool 的 all_keys.json (只读内存扫描已验证)。
逐页 AES-256-CBC, SQLCipher4 布局: page=4096, reserve=80(IV16+HMAC64), salt=首页前16字节。
"""
import json, os, sys, hashlib, hmac as hmac_mod, struct, sqlite3, time
from Crypto.Cipher import AES

ROOT = os.environ.get("WXWORK_ROOT") or os.getcwd()
SRC = os.path.join(ROOT, "workspace", "source")
DST = os.path.join(ROOT, "workspace", "decrypted")
KEYS = os.path.join(ROOT, "workspace", "all_keys.json")

PAGE, KEY_SZ, SALT_SZ, IV_SZ, HMAC_SZ, RESERVE = 4096, 32, 16, 16, 64, 80
HDR = b"SQLite format 3\x00"


def decrypt_db(src, dst, key):
    sz = os.path.getsize(src)
    n_pages = sz // PAGE + (1 if sz % PAGE else 0)
    with open(src, "rb") as fi:
        p1 = fi.read(PAGE)
        if len(p1) < PAGE:
            return False, "too small"
        salt = p1[:SALT_SZ]
        mac_key = hashlib.pbkdf2_hmac("sha512", key, bytes(b ^ 0x3A for b in salt), 2, dklen=KEY_SZ)
        hm = hmac_mod.new(mac_key, p1[SALT_SZ:PAGE - RESERVE + IV_SZ], hashlib.sha512)
        hm.update(struct.pack("<I", 1))
        if hm.digest() != p1[PAGE - HMAC_SZ:]:
            return False, "page1 HMAC fail"
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as fo:
            iv = p1[PAGE - RESERVE: PAGE - RESERVE + IV_SZ]
            fo.write(HDR + AES.new(key, AES.MODE_CBC, iv).decrypt(p1[SALT_SZ:PAGE - RESERVE]) + b"\x00" * RESERVE)
            for pg in range(2, n_pages + 1):
                page = fi.read(PAGE)
                if not page:
                    break
                if len(page) < PAGE:
                    page += b"\x00" * (PAGE - len(page))
                iv = page[PAGE - RESERVE: PAGE - RESERVE + IV_SZ]
                fo.write(AES.new(key, AES.MODE_CBC, iv).decrypt(page[:PAGE - RESERVE]) + b"\x00" * RESERVE)
    return True, n_pages


def main():
    with open(KEYS, encoding="utf-8") as f:
        keys = json.load(f)
    key_map = {k.replace("\\", "/"): v["enc_key"] for k, v in keys.items() if not k.startswith("_")}

    targets = []
    for root, _dirs, files in os.walk(SRC):
        for name in files:
            if name.endswith(".db"):
                rel = os.path.relpath(os.path.join(root, name), SRC).replace("\\", "/")
                targets.append(rel)
    targets.sort()

    ok, fail = [], []
    for rel in targets:
        if rel not in key_map:
            fail.append((rel, "no key"))
            continue
        src = os.path.join(SRC, *rel.split("/"))
        dst = os.path.join(DST, *rel.split("/")) + ".sqlite"
        t0 = time.time()
        good, info = decrypt_db(src, dst, bytes.fromhex(key_map[rel]))
        if not good:
            print(f"FAIL {rel}: {info}")
            fail.append((rel, info))
            continue
        try:
            conn = sqlite3.connect(dst)
            ic = conn.execute("PRAGMA integrity_check").fetchone()[0]
            tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
            conn.close()
        except Exception as e:
            print(f"FAIL {rel}: sqlite open: {e}")
            fail.append((rel, str(e)))
            continue
        status = "OK" if ic == "ok" else f"INTEGRITY:{ic}"
        print(f"{status:12s} {rel}  pages={info}  {time.time()-t0:.1f}s  tables={len(tables)}")
        (ok if ic == "ok" else fail).append((rel, ic))

    print(f"\n=== {len(ok)} ok, {len(fail)} fail ===")
    for rel, why in fail:
        print(f"  FAIL {rel}: {why}")


if __name__ == "__main__":
    main()
