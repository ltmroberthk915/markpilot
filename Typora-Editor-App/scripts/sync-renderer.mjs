// 只读同步：把 E:\MarkPilot\Typora-Editor\extension-src\render 原样复制到 app/renderer。
// 源目录只读，绝不写入；副本字节级等同源，永不手改。
import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = 'E:/MarkPilot/Typora-Editor/extension-src/render';
const DST = fileURLToPath(new URL('../app/renderer/', import.meta.url));

function summarize(root) {
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        files += 1;
        bytes += st.size;
      }
    }
  };
  walk(root);
  return { files, bytes };
}

cpSync(SRC, DST, { recursive: true });
mkdirSync(fileURLToPath(new URL('../app/assets/', import.meta.url)), {recursive:true});
cpSync(path.join(SRC, '../icon.png'), fileURLToPath(new URL('../app/assets/icon.png', import.meta.url)));
// Keep the host's original relative imports intact. The pure policy is shared
// byte-for-byte with the renderer, while desktop services are injected.
const shared = fileURLToPath(new URL('../app/shared/', import.meta.url));
mkdirSync(path.join(shared, 'out'), {recursive:true});
mkdirSync(path.join(shared, 'render/js'), {recursive:true});
cpSync(path.join(SRC, '../out/completion'), path.join(shared, 'out/completion'), {recursive:true});
cpSync(path.join(SRC, 'js/completion-policy.mjs'), path.join(shared, 'render/js/completion-policy.mjs'));
const a = summarize(SRC);
const b = summarize(DST);
if (a.files !== b.files || a.bytes !== b.bytes) {
  console.error(`MISMATCH src=${JSON.stringify(a)} dst=${JSON.stringify(b)}`);
  process.exit(1);
}
console.log(`synced ${a.files} files (${(a.bytes / 1024 / 1024).toFixed(1)} MB) -> ${DST}`);
