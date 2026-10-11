// 干净重建：同步引擎 → 清 dist → 出 win-unpacked → 写图标/版本资源 → 出 Setup + portable → 对账。
// 用法：node scripts/dist-fresh.cjs
//
// 为什么要有「④ 写图标/版本资源」这一步：
//   package.json 里 win.signAndEditExecutable=false（当初为了绕开签名/rcedit 失败），
//   于是 electron-builder **不会**把 build/icon.ico 与版本号写进 exe —— 必须自己用 rcedit 写。
//   这一步以前是手工敲的，漏掉就会出一个"默认 Electron 图标 + 无版本号"的安装包，
//   所以固化进脚本：rcedit 找不到、或写失败、或回读对不上，一律报错退出。
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const unpacked = path.join(dist, 'win-unpacked');

// 不经 shell：本机 node 装在 "C:\Program Files\..."，带空格；shell:true 会被 cmd 拆坏（实测 exit 1）。
const run = (args, label) => {
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', shell: false });
  if (r.status !== 0) { console.error(`✗ 失败：${label} (exit ${r.status})`); process.exit(r.status || 1); }
};

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version);
const productName = String(pkg.build?.productName || pkg.productName || pkg.name);
const icon = path.join(root, 'build', 'icon.ico');
const builderCli = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mb = (n) => (n / 1048576).toFixed(2);

/** 在 electron-builder 的下载缓存里找 rcedit（版本号目录不固定，所以按名字递归找）。 */
function findRcedit() {
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign');
  if (!fs.existsSync(cache)) return null;
  const stack = [cache];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === 'rcedit-x64.exe') return p;
    }
  }
  return null;
}

console.log(`① 同步引擎（只读源 → renderer/cm6）`);
run([path.join(__dirname, 'sync-engine.mjs')], 'sync-engine');

console.log('② 清理 dist');
fs.rmSync(dist, { recursive: true, force: true });

console.log('③ electron-builder --win --dir（先只出 win-unpacked，待写资源）');
run([builderCli, '--win', '--dir'], 'electron-builder --dir');

console.log('④ 写图标/版本资源（rcedit）');
if (!fs.existsSync(icon)) { console.error(`✗ 缺图标：${icon}`); process.exit(1); }
const rcedit = findRcedit();
if (!rcedit) {
  console.error('✗ 找不到 rcedit-x64.exe（%LOCALAPPDATA%\\electron-builder\\Cache\\winCodeSign）');
  console.error('  没有它就写不进图标/版本资源，安装包会带默认图标 —— 先联网跑一次 electron-builder 让缓存补齐。');
  process.exit(1);
}
console.log(`   rcedit: ${rcedit}`);
const appExes = fs.existsSync(unpacked)
  ? fs.readdirSync(unpacked).filter((f) => f.toLowerCase().endsWith('.exe'))
  : [];
if (!appExes.length) { console.error(`✗ win-unpacked 里没有 exe：${unpacked}`); process.exit(1); }
for (const f of appExes) {
  const target = path.join(unpacked, f);
  const r = spawnSync(rcedit, [target,
    '--set-icon', icon,
    '--set-version-string', 'ProductName', productName,
    '--set-version-string', 'FileDescription', `${productName} — Markdown 编辑器`,
    '--set-version-string', 'CompanyName', String(pkg.author || ''),
    '--set-version-string', 'LegalCopyright', String(pkg.license || ''),
    '--set-file-version', `${version}.0`,
    '--set-product-version', version,
  ], { cwd: root, stdio: 'inherit', shell: false });
  if (r.status !== 0) { console.error(`✗ rcedit 失败：${f} (exit ${r.status})`); process.exit(r.status || 1); }
  console.log(`   已写：${f}（icon + ${version}.0 / ${version}）`);
}

console.log('⑤ electron-builder --win nsis portable --prepackaged dist/win-unpacked');
run([builderCli, '--win', 'nsis', 'portable', '--prepackaged', unpacked], 'electron-builder --prepackaged');

console.log('⑥ 回读资源（写没写进去，以 exe 自己报的为准）');
const probe = spawnSync('powershell', ['-NoProfile', '-Command',
  appExes.map((f) => `$v=(Get-Item '${path.join(unpacked, f)}').VersionInfo; `
    + `"${f}|" + $v.FileVersion + "|" + $v.ProductVersion + "|" + $v.ProductName + "|" + $v.FileDescription`).join('; '),
], { cwd: root, encoding: 'utf8', shell: false });
if (probe.status === 0 && probe.stdout) process.stdout.write(probe.stdout);
else { console.error('✗ 回读版本资源失败'); process.exit(1); }
for (const line of String(probe.stdout || '').trim().split(/\r?\n/).filter(Boolean)) {
  const [f, fileV, prodV] = line.split('|');
  if (fileV !== `${version}.0` || prodV !== version) {
    console.error(`✗ 版本资源对不上：${f} file=${fileV} product=${prodV}，期望 ${version}.0 / ${version}`);
    process.exit(1);
  }
}

console.log('⑦ 产物指纹');
const arts = fs.existsSync(dist) ? fs.readdirSync(dist).filter((f) => f.endsWith('.exe')) : [];
if (!arts.length) { console.error('✗ dist 里没有 exe 产物'); process.exit(1); }
for (const f of arts) {
  const p = path.join(dist, f);
  console.log(`   ${f}  ${mb(fs.statSync(p).size)} MB  sha256=${sha(p).slice(0, 16)}`);
}
const asar = path.join(unpacked, 'resources', 'app.asar');
if (fs.existsSync(asar)) console.log(`   app.asar  ${fs.statSync(asar).size} B  sha256=${sha(asar).slice(0, 16)}`);
const engine = path.join(root, 'renderer', 'cm6', 'app.js');
if (fs.existsSync(engine)) console.log(`   renderer/cm6/app.js  ${fs.statSync(engine).size} B  sha256=${sha(engine).slice(0, 16)}`);

// ⑧ 顺手跑打包对账尺（存在才跑；它红了就整体红）。
//    --exe-probe：用仓库自带 7za 拆开两个 EXE 的载荷，证明「载荷内 asar == win-unpacked 的 asar」
//    且「载荷内 app.js == 源码构建的 app.js」——纯 node 那几闸看不到 EXE 内部这一环。
const verify = path.resolve(root, '..', '.mp-verify', 'pack', 'verify-pack.cjs');
if (fs.existsSync(verify)) {
  console.log('⑧ 打包对账（.mp-verify/pack/verify-pack.cjs --exe-probe）');
  run([verify, '--exe-probe'], 'verify-pack');
} else {
  console.log('⑧ 跳过打包对账（还没写 .mp-verify/pack/verify-pack.cjs）');
}
