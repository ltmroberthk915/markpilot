// 只读同步：把 dsh-markpilot 的 CM6 引擎 bundle 原样复制到本应用的 renderer/cm6。
// 单一真源＝dsh-markpilot/src-cm6 → esbuild → dsh-markpilot/renderer-cm6；
// 本应用**永不手改**引擎产物，只做字节级复制并校验（与 Typora-Editor-App 的 sync-renderer 同一纪律）。
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = 'E:/MarkPilot/dsh-markpilot/renderer-cm6';
const DST = fileURLToPath(new URL('../renderer/cm6/', import.meta.url));

function walk(root, base = root, out = []) {
  for (const name of readdirSync(root)) {
    const p = path.join(root, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, base, out);
    else out.push({ rel: path.relative(base, p).replace(/\\/g, '/'), size: st.size, sha: createHash('sha256').update(readFileSync(p)).digest('hex') });
  }
  return out;
}

const before = walk(SRC);
rmSync(DST, { recursive: true, force: true });
mkdirSync(DST, { recursive: true });
cpSync(SRC, DST, { recursive: true });
const after = walk(DST);

const same = before.length === after.length
  && before.every((b, i) => b.rel === after[i].rel && b.size === after[i].size && b.sha === after[i].sha);
const total = after.reduce((n, f) => n + f.size, 0);
console.log(`engine sync: ${after.length} files, ${(total / 1024).toFixed(1)} KB → renderer/cm6`);
if (!same) { console.error('字节校验失败：副本与源不一致'); process.exit(1); }
console.log('字节校验：全部一致');
