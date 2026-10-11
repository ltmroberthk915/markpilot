# -*- coding: utf-8 -*-
"""只读扫描微信进程内存, 提取 V2 图片 AES-128 密钥并验证。
原理(公开技术, 已知明文验证):
  - V2 图片(.dat, magic \\x07\\x08V2\\x08\\x07) 前1KB为 AES-128-ECB 加密段, 起始偏移15
  - 密钥是16位ASCII字母数字串, 查看图片后驻留微信 RW 内存
  - 用候选密钥解密某 V2 文件 [15:31] 块, 解出 JPEG/PNG/GIF/WXGF 魔数即命中
用法: python find_image_key.py <attach目录>       # 例: D:/xwechat_files/<账号>/msg/attach
前提: 微信运行中; 若扫描不到, 需在微信里点开2-3张图片后立刻重跑(密钥按需加载)
"""
import ctypes, glob, os, re, sys, subprocess
from ctypes import wintypes
from Crypto.Cipher import AES

PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400
MEM_COMMIT = 0x1000
RW = {0x04, 0x08, 0x40, 0x80}  # RW/WC/RWX/RWX-C
V2_MAGIC = b"\x07\x08V2\x08\x07"
RE_ALNUM = re.compile(rb"(?<![a-zA-Z0-9])[a-zA-Z0-9]{16,32}(?![a-zA-Z0-9])")

kernel32 = ctypes.windll.kernel32


class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_void_p), ("AllocationBase", ctypes.c_void_p),
                ("AllocationProtect", wintypes.DWORD), ("RegionSize", ctypes.c_size_t),
                ("State", wintypes.DWORD), ("Protect", wintypes.DWORD), ("Type", wintypes.DWORD)]


def weixin_pids():
    r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq Weixin.exe", "/FO", "CSV", "/NH"],
                       capture_output=True, text=True, creationflags=0x08000000)
    pids = []
    for line in r.stdout.strip().splitlines():
        p = line.strip('"').split('","')
        if len(p) >= 5 and p[0].lower() == "weixin.exe":
            pids.append((int(p[4].replace(",", "").replace(" K", "") or 0), int(p[1])))  # (内存, pid)
    return [pid for _mem, pid in sorted(pids, reverse=True)]


def v2_cipher_block(attach_dir):
    for pat in ("*/*/Img/*_t.dat", "*/*/Img/*.dat"):
        for f in sorted(glob.glob(os.path.join(attach_dir, pat)), key=os.path.getmtime, reverse=True)[:300]:
            try:
                with open(f, "rb") as fp:
                    h = fp.read(31)
                if h[:6] == V2_MAGIC:
                    return h[15:31], f
            except OSError:
                continue
    return None, None


def try_key(key, block):
    try:
        d = AES.new(key, AES.MODE_ECB).decrypt(block)
    except Exception:
        return None
    if d[:3] == b"\xff\xd8\xff":
        return "jpg"
    if d[:4] in (b"\x89PNG", b"RIFF", b"wxgf") or d[:3] == b"GIF":
        return "png/webp/wxgf/gif"
    return None


def scan(pid, block):
    h = kernel32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
    if not h:
        print(f"[!] 无法打开进程 {pid}(可能需要管理员)")
        return None
    found = None
    try:
        mbi, addr = MBI(), 0
        while addr < 0x7FFFFFFFFFFF:
            if kernel32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)) == 0:
                break
            if mbi.State == MEM_COMMIT and mbi.Protect in RW and 0 < mbi.RegionSize <= 64 * 1024 * 1024:
                buf = ctypes.create_string_buffer(mbi.RegionSize)
                n = ctypes.c_size_t(0)
                if kernel32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, mbi.RegionSize, ctypes.byref(n)):
                    data = buf.raw[:n.value]
                    for m in RE_ALNUM.finditer(data):
                        s = m.group()
                        for cand in (s[:16], s[-16:]):
                            fmt = try_key(cand, block)
                            if fmt:
                                found = (cand.decode(), fmt)
                                break
                    if found:
                        break
            nxt = (mbi.BaseAddress or 0) + mbi.RegionSize
            if nxt <= addr:
                break
            addr = nxt
    finally:
        kernel32.CloseHandle(h)
    return found


def main():
    if len(sys.argv) < 2:
        sys.exit(f"用法: python {sys.argv[0]} <attach目录>")
    attach = sys.argv[1]
    block, f = v2_cipher_block(attach)
    if not block:
        sys.exit("未找到 V2 格式 .dat 样本(该账号可能尚无新格式图片)")
    print(f"[*] V2 样本: {os.path.basename(f)}  cipher={block.hex()}")
    for pid in weixin_pids():
        print(f"[*] 扫描 PID {pid} (RW 区)...")
        r = scan(pid, block)
        if r:
            print(f"[+] AES key = {r[0]}  (验证: {r[1]})")
            print("    使用: 设 WXCHAT_IMG_AES_KEY 环境变量或填入 extract_group.py")
            return
    print("[!] 未命中。请在微信里点开2-3张图片(触发密钥加载)后立刻重跑本脚本")


if __name__ == "__main__":
    main()
