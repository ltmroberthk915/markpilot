#!/usr/bin/env node
// sync-core.mjs — 把 MarkPilot-CM6 已构建的 renderer/cm6 构建产物**逐字节**同步进 DSH 插件。
//
// 为什么只同步构建产物：dsh-markdown 是"换皮套壳"——引擎源码在 src-cm6/，构建产物由
// MarkPilot-CM6 的构建链产出。插件只消费产物；EXE 升级后重跑本脚本即可让插件核心与 EXE
// 字节一致（core.json 记录每个文件的 SHA256/bytes，--check 随时可验证漂移）。
//
// 目录契约（见 README.md）：
//   MarkPilot-CM6/renderer/cm6/{app.js,app.css,markdown-worker.js,mermaid.min.js,fonts/*，KaTeX 字体…}
//     → dsh-markdown/renderer-cm6/cm6/  （同形；**不复制 index.html**）
//   dsh-markdown/renderer-cm6/index.html 是 DSH 皮，永远由本插件的 core-sync 维护，不被同步覆盖。
//
// 用法：
//   node scripts/sync-core.mjs                 # 同步 + 写 core.json
//   node scripts/sync-core.mjs --check         # 逐字节校验，漂移时退出码 1
//   node scripts/sync-core.mjs --from <dir>    # 临时换源目录
//
// 退出码：0 成功/无漂移；1 检测到漂移（--check）；2 用法/前置条件错误；3 源目录不可用。
// 依赖：仅 Node 原生 fs/crypto/path（无第三方包）。写文件一律 UTF-8 无 BOM。

import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));          // .../dsh-markdown/scripts
const PLUGIN_DIR = resolve(HERE, '..');                        // .../dsh-markdown
const DEFAULT_SOURCE = resolve(HERE, '..', '..', 'MarkPilot-CM6', 'renderer', 'cm6');
const SKIN_DIR = resolve(PLUGIN_DIR, 'renderer-cm6');
const DEST_DIR = resolve(SKIN_DIR, 'cm6');
const CORE_JSON = resolve(PLUGIN_DIR, 'core.json');
const CORE_NAME = 'MarkPilot CM6';
const FALLBACK_VERSION = '3.6.2';
const EXCLUDED_AT_ROOT = new Set(['index.html']);              // 皮归插件，核心入口不搬

function fail(code, message) {
  process.stderr.write(`sync-core: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { check: false, from: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (a === '--from') {
      const v = argv[i + 1];
      if (!v) fail(2, '--from 需要目录参数');
      args.from = v;
      i += 1;
    } else if (a === '--help' || a === '-h') args.help = true;
    else fail(2, `未知参数：${a}`);
  }
  return args;
}

const USAGE = `用法：
  node scripts/sync-core.mjs [--check] [--from <dir>]

  --check      逐字节校验插件核心 == 源构建产物，并核对 core.json 哈希；漂移退出码 1
  --from <dir> 覆盖默认源目录（默认 <repo>/MarkPilot-CM6/renderer/cm6）

默认源：${DEFAULT_SOURCE}
目标：  ${DEST_DIR}
`;

// 递归枚举源目录中的文件（相对路径统一成 / 分隔）。不跟目录符号链接，避免环。
function walkFiles(root, prefix = '') {
  const out = [];
  for (const name of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${name.name}` : name.name;
    if (name.isDirectory()) out.push(...walkFiles(root, rel));
    else if (name.isFile()) out.push(rel);
    // symlink/其它类型：构建产物里不应出现；出现也跳过并在调用方计数
  }
  return out;
}

function shouldSkip(rel) {
  return !rel.includes('/') && EXCLUDED_AT_ROOT.has(rel);
}

function collectSourceFiles(sourceDir) {
  const all = walkFiles(sourceDir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const kept = [];
  const skipped = [];
  for (const rel of all) (shouldSkip(rel) ? skipped : kept).push(rel);
  return { kept, skipped };
}

function readSourceVersion(sourceDir) {
  // 构建产物的版本真源：MarkPilot-CM6/package.json（cm6/ 的上两级）。
  const pkgPath = resolve(sourceDir, '..', '..', 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) return pkg.version.trim();
  } catch { /* 版本读不到时用契约里的兜底值，--check 仍能校验字节 */ }
  return FALLBACK_VERSION;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// coreHash 的规范形式（与文件顺序无关、与平台路径分隔符无关）：
//   sha256( Σ "path\0sha256\0bytes\n" )，文件按 path 的 UTF-16 码元序排序。
function computeCoreHash(files) {
  const h = createHash('sha256');
  for (const f of files) h.update(`${f.path}\0${f.sha256}\0${f.bytes}\n`);
  return h.digest('hex');
}

function assertSafeDest(dest) {
  const rel = relative(SKIN_DIR, dest);
  if (rel !== 'cm6' || dest !== join(SKIN_DIR, 'cm6')) {
    fail(2, `拒绝操作非核心目录：${dest}`);
  }
}

function buildManifest(sourceDir) {
  const { kept, skipped } = collectSourceFiles(sourceDir);
  if (!kept.includes('app.js') || !kept.includes('app.css')) {
    fail(3, `源目录不像 MarkPilot CM6 构建产物（缺 app.js/app.css）：${sourceDir}`);
  }
  const files = kept.map((rel) => {
    const buf = readFileSync(join(sourceDir, rel));
    return { path: rel, sha256: sha256(buf), bytes: buf.length };
  });
  return { files, skipped };
}

function writeCoreJson(manifest, sourceDir, version) {
  const payload = {
    core: CORE_NAME,
    version,
    source: relative(PLUGIN_DIR, sourceDir).split(sep).join('/'),
    syncedAt: new Date().toISOString(),
    generator: 'scripts/sync-core.mjs',
    files: manifest.files,
    coreHash: computeCoreHash(manifest.files),
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const tmp = `${CORE_JSON}.tmp`;
  writeFileSync(tmp, text, 'utf8');   // Node 写 string 不写 BOM
  renameSync(tmp, CORE_JSON);         // 原子替换，避免半截 core.json
  return payload;
}

function sync({ sourceDir }) {
  if (!existsSync(sourceDir)) fail(3, `源目录不存在：${sourceDir}`);
  if (!statSync(sourceDir).isDirectory()) fail(3, `源不是目录：${sourceDir}`);
  const version = readSourceVersion(sourceDir);
  const manifest = buildManifest(sourceDir);

  assertSafeDest(DEST_DIR);
  if (existsSync(DEST_DIR)) {
    // 只允许删本次生成的核心目录（字面量守卫在 assertSafeDest；此路径不是用户目录）。
    rmSync(DEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(DEST_DIR, { recursive: true });

  for (const f of manifest.files) {
    const target = join(DEST_DIR, ...f.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(sourceDir, ...f.path.split('/')), target);
    // 复制后立刻逐字节自证：产物 != 源就是一个必须立刻失败的严重错误。
    const copied = readFileSync(target);
    const src = readFileSync(join(sourceDir, ...f.path.split('/')));
    if (Buffer.compare(copied, src) !== 0 || sha256(copied) !== f.sha256) {
      fail(1, `复制校验失败：${f.path}`);
    }
  }

  const payload = writeCoreJson(manifest, sourceDir, version);
  process.stdout.write(`SYNC_OK ${payload.files.length} files, ${sumBytes(payload.files)} bytes, coreHash=${payload.coreHash}\n`);
  process.stdout.write(`  core    : ${payload.core} ${payload.version}\n`);
  process.stdout.write(`  source  : ${payload.source}\n`);
  process.stdout.write(`  dest    : ${DEST_DIR}\n`);
  if (manifest.skipped.length) process.stdout.write(`  skipped : ${manifest.skipped.join(', ')}（皮归插件维护）\n`);
  return 0;
}

function sumBytes(files) {
  return files.reduce((n, f) => n + f.bytes, 0);
}

function check({ sourceDir }) {
  if (!existsSync(sourceDir)) fail(3, `源目录不存在：${sourceDir}`);
  if (!existsSync(CORE_JSON)) fail(2, `缺少 core.json（先跑一次同步）：${CORE_JSON}`);
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(CORE_JSON, 'utf8'));
  } catch (error) {
    fail(2, `core.json 解析失败：${error.message}`);
  }

  const drift = [];
  const manifest = buildManifest(sourceDir);
  const recordedFiles = new Map((recorded.files || []).map((f) => [f.path, f]));

  // 1) 源清单 vs core.json 清单（文件集合）
  for (const f of manifest.files) {
    const rec = recordedFiles.get(f.path);
    if (!rec) { drift.push(`core.json 缺条目：${f.path}`); continue; }
    if (rec.sha256 !== f.sha256 || rec.bytes !== f.bytes) {
      drift.push(`core.json 哈希过期：${f.path}（记录 ${rec.sha256.slice(0, 12)}/${rec.bytes}B，源 ${f.sha256.slice(0, 12)}/${f.bytes}B）`);
    }
    recordedFiles.delete(f.path);
  }
  for (const leftover of recordedFiles.keys()) drift.push(`core.json 多出条目：${leftover}`);

  // 2) 插件实际文件 vs 源：逐字节比较（不是只比哈希）
  const destFiles = existsSync(DEST_DIR) ? walkFiles(DEST_DIR).sort() : [];
  const sourceSet = new Set(manifest.files.map((f) => f.path));
  const destSet = new Set(destFiles);
  for (const rel of sourceSet) {
    if (!destSet.has(rel)) { drift.push(`插件核心缺失：${rel}`); continue; }
    const a = readFileSync(join(sourceDir, ...rel.split('/')));
    const b = readFileSync(join(DEST_DIR, ...rel.split('/')));
    if (a.length !== b.length || Buffer.compare(a, b) !== 0) {
      drift.push(`字节漂移：${rel}（源 ${a.length}B / 插件 ${b.length}B）`);
    }
  }
  for (const rel of destSet) if (!sourceSet.has(rel)) drift.push(`插件核心多出文件：${rel}`);

  // 3) coreHash / version 自洽
  const freshHash = computeCoreHash(manifest.files);
  const sourceVersion = readSourceVersion(sourceDir);
  if (recorded.coreHash !== freshHash) {
    drift.push(`coreHash 不匹配（core.json ${String(recorded.coreHash).slice(0, 12)}… / 源 ${freshHash.slice(0, 12)}…）`);
  }
  if (String(recorded.version || '') !== String(sourceVersion)) {
    drift.push(`version 不匹配（core.json ${recorded.version} / 源 ${sourceVersion}）`);
  }

  if (drift.length) {
    process.stderr.write(`CHECK_DRIFT ${drift.length}\n`);
    for (const line of drift) process.stderr.write(`  - ${line}\n`);
    process.stderr.write('修复：node scripts/sync-core.mjs\n');
    return 1;
  }
  process.stdout.write(`CHECK_OK ${manifest.files.length} files, ${sumBytes(manifest.files)} bytes, coreHash=${freshHash}\n`);
  process.stdout.write(`  core   : ${recorded.core} ${recorded.version}\n`);
  process.stdout.write(`  source : ${sourceDir}\n`);
  process.stdout.write(`  dest   : ${DEST_DIR}\n`);
  return 0;
}

const args = parseArgs(process.argv.slice(2));if (args.help) { process.stdout.write(USAGE); process.exit(0); }
const sourceDir = args.from ? resolve(process.cwd(), args.from) : DEFAULT_SOURCE;
process.exit(args.check ? check({ sourceDir }) : sync({ sourceDir }));
