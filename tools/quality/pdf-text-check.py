"""Read-only PDF text diagnostics. Requires pypdf; never rewrites the PDF."""
import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path
from pypdf import PdfReader

parser = argparse.ArgumentParser()
parser.add_argument("pdf", type=Path)
parser.add_argument("--expect", action="append", required=True, help="Positive anchor; absence is never evidence of a correct document")
parser.add_argument("--forbid", action="append", default=[])
parser.add_argument("--out", type=Path)
parser.add_argument("--pdftotext", help="Optional Poppler executable (otherwise discovered on PATH)")
args = parser.parse_args()
if args.out and args.out.exists():
    raise SystemExit("Output already exists")
reader = PdfReader(args.pdf)
texts = [page.extract_text(extraction_mode="layout") or "" for page in reader.pages]
extractors = {"pypdf": {"text": "\n".join(texts)}}
poppler = args.pdftotext or shutil.which("pdftotext")
if poppler:
    run = subprocess.run([poppler, "-layout", "-enc", "UTF-8", str(args.pdf.resolve()), "-"], capture_output=True, timeout=30)
    extractors["pdftotext"] = {"text": run.stdout.decode("utf-8", errors="replace"), "exitCode": run.returncode, "diagnostics": run.stderr.decode("utf-8", errors="replace")}
for extracted in extractors.values():
    extracted["expected"] = {token: extracted["text"].count(token) for token in args.expect}
    extracted["forbidden"] = {token: extracted["text"].count(token) for token in args.forbid}
result = {
    "schema": 1,
    "pdfSha256": hashlib.sha256(args.pdf.read_bytes()).hexdigest(),
    "pages": len(texts),
    "extractors": extractors,
    "note": "Text anchors supplement visual inspection. Raw extraction is retained; duplicated/interleaved text is not silently normalized.",
}
result["passed"] = any(all(e["expected"].values()) for e in extractors.values()) and not any(any(e["forbidden"].values()) for e in extractors.values()) and all(e.get("exitCode", 0) == 0 for e in extractors.values())
if args.out:
    with args.out.open("w", encoding="utf-8", newline="\n") as output:
        output.write(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps(result, ensure_ascii=False, indent=2))
raise SystemExit(0 if result["passed"] else 1)
