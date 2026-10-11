# -*- coding: utf-8 -*-
"""重打包 VSIX。只有一个发行版：源码树就是发布内容。

2026-09-15：原先还有一条 `--public`（API-free）公开版产线，靠替换
`public-release/` 下的宿主模块 + 覆写 build-flavor 实现。用户实测那份包
"AI 补全被搞坏、API Key 配置入口损毁"，据此决定**直接抛弃公版，只留私版**：
源码树就是唯一的发布内容，包里本来也不含任何 API Key（密钥存在用户自己的
IDE 凭据存储 / 系统加密保险库里，见 test/completion-profiles.test.cjs 的断言）。
因此这里不再有 flavor 分支，也不再有"发布版"措辞。
"""
import argparse
import json
import os
import re
import sys
import zipfile

WORKSPACE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(WORKSPACE, "extension-src")
META = os.path.join(WORKSPACE, "vsix-meta")
DIST = os.path.join(WORKSPACE, "dist")


def xml_escape(value):
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def set_element(text, tag, value):
    """把 <tag ...>旧值</tag> 换成新值（保留属性），找不到就在 <Metadata> 里补一个。

    商店（Open VSX / VS Marketplace）**优先读这份清单**，而不是 extension/package.json：
    DisplayName / Description 决定商店页显示，Tags 决定商店搜索能否命中。
    只改 package.json 是不够的——曾经踩过：keywords 在 package.json 里加到 22 个，
    而商店里查到的 Tags 仍是 4 个弱词、描述还是旧的中文一句话。
    """
    pattern = r"(<" + tag + r"\b[^>]*>).*?(</" + tag + r">)"
    if re.search(pattern, text, re.S):
        return re.sub(pattern, lambda m: m.group(1) + value + m.group(2), text, count=1, flags=re.S)
    return text.replace("</Metadata>", "\t\t\t<" + tag + ">" + value + "</" + tag + ">\n\t\t</Metadata>", 1)


def sync_manifest(version, publisher=None, package=None):
    # Keep the VSIX Identity Version **and Publisher** equal to package.json on every pack;
    # the meta file is rewritten so the archive and the source stay byte-identical.
    #
    # Publisher 曾经漏同步（本文件里写死旧品牌名）：Open VSX / VS Code Marketplace 与本地安装
    # 都以 `extension.vsixmanifest` 的 Identity Publisher 为准，于是 publisher 改成 jinxi 之后
    # ovsx 直接报 "Unknown publisher: markpilot"，而包里看不出问题。
    path = os.path.join(META, "extension.vsixmanifest")
    with open(path, encoding="utf-8", newline="") as f:
        text = f.read()
    synced = re.sub(r'(<Identity\b[^>]*\bVersion=")[^"]+(")', r'\g<1>' + version + r'\g<2>', text, count=1)
    if publisher:
        synced = re.sub(r'(<Identity\b[^>]*\bPublisher=")[^"]+(")', r'\g<1>' + publisher + r'\g<2>', synced, count=1)
    if package:
        synced = set_element(synced, "DisplayName", xml_escape(package.get("displayName", "")))
        synced = set_element(synced, "Description", xml_escape(package.get("description", "")))
        synced = set_element(synced, "Tags", ",".join(package.get("keywords", [])))
        synced = set_element(synced, "Categories", ",".join(package.get("categories", [])))
    if synced != text:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(synced)
    return synced


def collect(version, publisher=None, manifest_package=None):
    files = []
    for name in ("[Content_Types].xml", "extension.vsixmanifest"):
        p = os.path.join(META, name)
        if not os.path.isfile(p):
            sys.exit(f"missing {p}")
        if name == "extension.vsixmanifest":
            payload = sync_manifest(version, publisher, manifest_package)
            files.append((None, name, payload.encode("utf-8")))
        else:
            files.append((p, name, None))
    for base, _, names in os.walk(SRC):
        for n in names:
            full = os.path.join(base, n)
            rel = os.path.relpath(full, SRC)
            files.append((full, "extension/" + rel.replace(os.sep, "/"), None))
    return files


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", help="输出文件名（默认 markpilot-<版本>.vsix）")
    args = parser.parse_args()
    os.makedirs(DIST, exist_ok=True)
    with open(os.path.join(SRC, "package.json"), encoding="utf-8") as f:
        package = json.load(f)
    version = package["version"]
    filename = args.out or f"markpilot-{version}.vsix"
    out = os.path.join(DIST, filename)
    files = collect(version, package.get("publisher"), package)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for full, arc, payload in files:
            if payload is None:
                z.write(full, arc)
            else:
                z.writestr(arc, payload)
    size = os.path.getsize(out)
    print(f"packed {out} ({size/1024/1024:.2f} MB, {len(files)} files)")


if __name__ == "__main__":
    main()
