#!/usr/bin/env node
/**
 * dist:fresh — build the Windows installers into a version-scoped output directory
 * and promote only the finished EXEs into `dist/`.
 *
 *   node scripts/dist-fresh.cjs                  # nsis + portable -> dist-<version>, EXEs copied to dist/
 *   node scripts/dist-fresh.cjs --dry-run        # show the chosen output dir and stop
 *   node scripts/dist-fresh.cjs --no-promote     # keep artifacts in the scoped dir only
 *   node scripts/dist-fresh.cjs --target portable
 *   node scripts/dist-fresh.cjs --clean          # report/remove leftover build trees
 *
 * Why this exists: `npm run dist` builds into `dist/`, and electron-builder clears
 * `dist/win-unpacked` before repacking. If anything still holds
 * `dist/win-unpacked/resources/app.asar`, that cleanup fails with EBUSY and the
 * whole build dies with a bare "resource busy or locked" message. In practice the
 * holder is the agent/tool host itself: it keeps a handle on every .asar it has
 * read for hash or extract verification, and such a handle is invisible in Task
 * Manager (app.asar is a data file, so it never shows up in any process's module
 * list). Diagnose with scripts/find-file-lock.ps1.
 *
 * A fresh output directory cannot be locked by definition, so the build always
 * proceeds; the stale tree is left for `--clean` once the holder exits.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const version = pkg.version;

const argv = process.argv.slice(2);
const has = flag => argv.includes(flag);
const value = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const targetList = value("--target", "nsis portable").split(/\s+/).filter(Boolean);
const promote = !has("--no-promote");
const distDir = path.join(root, "dist");
/** Build trees are listed either as a dist root (holding win-unpacked/) or as an
 *  unpacked directory itself, so resolve its asar for both shapes. */
const asarOf = dir => path.basename(dir) === "win-unpacked"
  ? path.join(dir, "resources", "app.asar")
  : path.join(dir, "win-unpacked", "resources", "app.asar");
const rel = p => path.relative(root, p).replace(/\\/g, "/");

/**
 * Ask the OS who holds this path. Node's own fs.open cannot answer this: libuv
 * always passes FILE_SHARE_READ|WRITE|DELETE, so a file that cannot be deleted
 * still opens without error.
 */
function probe(target) {
  if (!fs.existsSync(target)) return { status: "MISSING", lines: [] };
  const r = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", path.join(root, "scripts", "find-file-lock.ps1"), target,
  ], { encoding: "utf8" });
  const out = String(r.stdout || "") + String(r.stderr || "");
  const m = out.match(/STATUS=(LOCKED-UNKNOWN-HOLDER|LOCKED|FREE|MISSING)/);
  const lines = out.split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !line.startsWith("---") && !line.startsWith("STATUS="));
  return { status: m ? m[1] : "UNKNOWN", lines };
}

/** Only a positive FREE counts as free; anything else must not be deleted. */
const isFree = target => ["FREE", "MISSING"].includes(probe(target).status);

function reportHolder(target) {
  const { status, lines } = probe(target);
  if (status === "MISSING") return "(path does not exist)";
  if (status === "FREE") return "(not locked)";
  return "STATUS=" + status + "\n" + (lines.join("\n") || "(no holder reported)");
}

const indent = text => String(text).split("\n").map(line => "  " + line).join("\n");

/** Leftover build trees: dist-<x.y.z>, dist-<x.y.z>-<stamp>, dist-build*, plus dist/win-unpacked */
function residueDirs() {
  const out = [];
  for (const name of fs.readdirSync(root)) {
    if (name === "dist" || !name.startsWith("dist-")) continue;
    const full = path.join(root, name);
    if (fs.statSync(full).isDirectory()) out.push(full);
  }
  const unpacked = path.join(distDir, "win-unpacked");
  if (fs.existsSync(unpacked)) out.push(unpacked);
  return out;
}

if (has("--clean")) {
  let removed = 0;
  const dirs = residueDirs();
  for (const dir of dirs) {
    const name = rel(dir);
    const asar = asarOf(dir);
    const { status, lines } = probe(asar);
    if (status === "LOCKED" || status === "LOCKED-UNKNOWN-HOLDER" || status === "UNKNOWN") {
      console.log(`[dist:fresh] LOCKED  ${name}`);
      console.log(indent(reportHolder(asar)));
      console.log(`[dist:fresh]   -> close that process (or reboot), then: rmdir /s /q "${dir}"`);
      continue;
    }
    if (path.basename(dir) === `dist-${version}` && !has("--force")) {
      console.log(`[dist:fresh] KEPT    ${name} (current version; pass --force to remove)`);
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[dist:fresh] REMOVED ${name}`);
      removed++;
    } catch (err) {
      console.log(`[dist:fresh] FAILED  ${name}: ${err.message}`);
    }
  }
  console.log(`[dist:fresh] clean done: ${dirs.length} tree(s) inspected, ${removed} removed`);
  process.exit(0);
}

function pickOutputDir() {
  const primary = path.join(root, `dist-${version}`);
  if (fs.existsSync(primary)) {
    if (!isFree(asarOf(primary))) {
      console.log(`[dist:fresh] ${path.basename(primary)} is still held open; not reusing it:`);
      console.log(indent(reportHolder(asarOf(primary))));
    } else {
      try {
        fs.rmSync(primary, { recursive: true, force: true, maxRetries: 2 });
        console.log(`[dist:fresh] cleared stale ${path.basename(primary)}`);
      } catch (err) {
        console.log(`[dist:fresh] could not clear ${path.basename(primary)}: ${err.message}`);
      }
    }
  }
  if (!fs.existsSync(primary)) return primary;
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  return path.join(root, `dist-${version}-${stamp}`);
}

const stale = residueDirs().filter(dir => !isFree(asarOf(dir)));
if (stale.length) {
  console.log(`[dist:fresh] ${stale.length} leftover build tree(s) are held open (see --clean):`);
  for (const dir of stale) console.log(`[dist:fresh]   ${rel(dir)}`);
}

const outDir = pickOutputDir();
console.log(`[dist:fresh] version ${version} -> ${path.basename(outDir)} (targets: ${targetList.join(", ")})`);
if (has("--dry-run")) {
  console.log("[dist:fresh] dry run: stopping before electron-builder");
  process.exit(0);
}

// Run electron-builder through its JS entry point with the current node: no shell,
// so paths with spaces stay intact and node does not warn about unescaped args.
const cli = path.join(root, "node_modules", "electron-builder", "cli.js");
if (!fs.existsSync(cli)) {
  console.error(`[dist:fresh] electron-builder not found at ${cli}; run npm install first`);
  process.exit(1);
}

// 本地 Electron 发行版：electron-builder 默认要从 GitHub 下载并解包 electron-v<ver>-win32-x64.zip，
// 网络不通时会挂满 600s 再失败（2026-09-11 实测 connect ETIMEDOUT 20.205.243.166:443；而
// node_modules/electron/dist 里就是同版本同平台的解包产物）。把 electronDist 指过去就跳过了
// 这一步，构建不再依赖任何外部下载。`--no-local-electron` 可退回默认行为。
const localElectron = path.join(root, "node_modules", "electron", "dist");
const useLocalElectron = !has("--no-local-electron") && fs.existsSync(path.join(localElectron, "electron.exe"));
if (useLocalElectron) console.log(`[dist:fresh] 用本地 Electron 发行版：${localElectron}`);

const build = spawnSync(process.execPath, [cli, "--win", ...targetList, `--config.directories.output=${outDir}`,
  ...(useLocalElectron ? [`--config.electronDist=${localElectron}`] : [])], {
  cwd: root,
  stdio: "inherit",
});
if (build.status !== 0) {
  console.error(`[dist:fresh] electron-builder exited ${build.status}`);
  process.exit(build.status || 1);
}

const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const artifacts = [`markpilot-Setup-${version}.exe`, `markpilot-v${version}-portable.exe`];

console.log("");
for (const name of artifacts) {
  const from = path.join(outDir, name);
  if (!fs.existsSync(from)) {
    console.log(`[dist:fresh] missing artifact: ${name}`);
    continue;
  }
  let final = from;
  if (promote) {
    fs.mkdirSync(distDir, { recursive: true });
    final = path.join(distDir, name);
    fs.copyFileSync(from, final);
  }
  console.log(`[dist:fresh] ${final}`);
  console.log(`            ${fs.statSync(final).size} bytes  sha256=${sha256(final)}`);
}

console.log("");
console.log(`[dist:fresh] build tree: ${outDir}`);
const builtAsar = asarOf(outDir);
if (!isFree(builtAsar)) {
  console.log("[dist:fresh] its app.asar is held open (hash/extract verification), so the tree");
  console.log("[dist:fresh] cannot be deleted until that process exits:");
  console.log(indent(reportHolder(builtAsar)));
  console.log(`[dist:fresh] then: rmdir /s /q "${outDir}"`);
}
