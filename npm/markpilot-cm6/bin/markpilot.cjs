#!/usr/bin/env node
'use strict';
/**
 * markpilot-cm6 — MarkPilot 桌面版的 npm 分发包。
 *
 * 这个包本身不内嵌 100 MB 级的 EXE（npm 注册表的单包大小不适合装桌面安装包），
 * 它提供一条可核对 SHA-256 的下载/启动通道：安装后运行 `markpilot --download`，
 * 从对应的 GitHub Release 取安装版或便携版，再 `markpilot` 启动。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const pkg = require('../package.json');
const VERSION = pkg.version;
const TAG = 'v' + VERSION;
const RELEASE_BASE = process.env.MARKPILOT_RELEASE_BASE
  || 'https://github.com/ltmroberthk915/markpilot/releases/download/' + TAG;
const ASSETS = {
  setup: 'markpilot-Setup-' + VERSION + '.exe',
  portable: 'markpilot-' + VERSION + '-portable.exe',
};
const SUMS_FILE = 'SHA256SUMS-' + VERSION + '.txt';

function usage() {
  console.log([
    'MarkPilot 独立桌面版 ' + VERSION,
    '',
    '用法：',
    '  markpilot                     启动已安装的 MarkPilot（可跟一个 .md 文件）',
    '  markpilot <file.md>           用已安装的 MarkPilot 打开文件',
    '  markpilot --download          下载安装版 Setup 到本地并校验 SHA-256',
    '  markpilot --download --portable   下载便携版并校验 SHA-256',
    '  markpilot --download --out <dir>  指定下载目录',
    '  markpilot --path              打印探测到的 MarkPilot.exe 路径',
    '  markpilot --exe <path>        指定 MarkPilot.exe 后启动',
    '  markpilot --version           打印版本',
    '',
    '发布页：https://github.com/ltmroberthk915/markpilot/releases/tag/' + TAG,
  ].join('\n'));
}

function fail(message, code = 1) {
  console.error('markpilot: ' + message);
  process.exit(code);
}

function sums() {
  const file = path.join(__dirname, '..', SUMS_FILE);
  const map = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match) map.set(match[2].trim(), match[1].toLowerCase());
  }
  return map;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function download(kind, outDir) {
  const asset = ASSETS[kind];
  const expected = sums().get(asset);
  if (!expected) fail('缺少 ' + asset + ' 的校验值');
  const url = RELEASE_BASE + '/' + asset;
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, asset);
  const partial = target + '.part';
  console.log('下载 ' + asset + '\n  从 ' + url + '\n  到 ' + target);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) fail('下载失败：HTTP ' + response.status + ' ' + response.statusText);
  const total = Number(response.headers.get('content-length') || 0);
  let read = 0;
  let lastTick = 0;
  const stream = fs.createWriteStream(partial);
  for await (const chunk of response.body) {
    read += chunk.length;
    if (!stream.write(chunk)) await new Promise((r) => stream.once('drain', r));
    const now = Date.now();
    if (total && now - lastTick > 1000) {
      lastTick = now;
      process.stdout.write('\r  ' + (read / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB   ');
    }
  }
  await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));
  if (total) process.stdout.write('\r  ' + (total / 1048576).toFixed(1) + ' MB 完成\n');
  const actual = await sha256File(partial);
  if (actual !== expected) {
    fs.rmSync(partial, { force: true });
    fail('SHA-256 不匹配：期望 ' + expected + '，实际 ' + actual);
  }
  fs.renameSync(partial, target);
  console.log('  校验通过 sha256=' + actual);
  console.log('  已保存 ' + target);
  if (kind === 'setup') console.log('  运行安装器即可覆盖升级，原有文档与设置保留。');
  else console.log('  便携版可直接双击运行，不需要安装。');
  return target;
}

function registryInstallDirs() {
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const dirs = [];
  for (const root of roots) {
    let output;
    try {
      output = execFileSync('reg.exe', ['query', root, '/s'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    } catch { continue; }
    for (const block of output.split(/\r?\n\r?\n/)) {
      if (!/DisplayName\s+REG_(?:SZ|EXPAND_SZ)\s+MarkPilot/i.test(block)) continue;
      const uninstall = /UninstallString\s+REG_(?:SZ|EXPAND_SZ)\s+"?([^"\r\n]+\.exe)"?/i.exec(block);
      if (uninstall) dirs.push(path.dirname(uninstall[1]));
      const location = /InstallLocation\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)/i.exec(block);
      if (location && location[1].trim()) dirs.push(location[1].trim());
    }
  }
  return dirs;
}

function candidates() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const declared = registryInstallDirs().map((dir) => path.join(dir, 'MarkPilot.exe'));
  return [
    ...declared,
    path.join(local, 'Programs', 'MarkPilot CM6', 'MarkPilot.exe'),
    path.join(local, 'Programs', 'MarkPilot', 'MarkPilot.exe'),
    path.join(programFiles, 'MarkPilot', 'MarkPilot.exe'),
    path.join(programFilesX86, 'MarkPilot', 'MarkPilot.exe'),
  ];
}

function findExecutable() {
  for (const candidate of candidates()) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { }
  }
  return null;
}

function launch(exe, file) {
  const args = file ? [path.resolve(file)] : [];
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  console.log('已启动 ' + exe + (file ? ' ' + file : ''));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) { console.log(VERSION); return; }
  if (args.includes('--help') || args.includes('-h')) { usage(); return; }

  if (args.includes('--download')) {
    const portable = args.includes('--portable');
    const setup = args.includes('--setup');
    if (portable && setup) fail('--portable 与 --setup 只能选一个');
    const outIndex = args.indexOf('--out');
    const outDir = outIndex >= 0 && args[outIndex + 1]
      ? path.resolve(args[outIndex + 1])
      : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'MarkPilot', 'downloads');
    await download(portable ? 'portable' : 'setup', outDir);
    return;
  }

  const exeIndex = args.indexOf('--exe');
  const exe = exeIndex >= 0 && args[exeIndex + 1] ? path.resolve(args[exeIndex + 1]) : findExecutable();
  if (args.includes('--path')) {
    if (!exe || !fs.existsSync(exe)) fail('没有找到已安装的 MarkPilot.exe；先运行 markpilot --download 安装，或用 --exe 指定。', 2);
    console.log(exe);
    return;
  }
  if (!exe || !fs.existsSync(exe)) {
    console.error('没有找到已安装的 MarkPilot。');
    console.error('  安装版：markpilot --download 然后运行下载到的 markpilot-Setup-' + VERSION + '.exe');
    console.error('  便携版：markpilot --download --portable');
    console.error('  或从发布页直接下载：https://github.com/ltmroberthk915/markpilot/releases/tag/' + TAG);
    process.exit(2);
  }
  const file = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '--exe' && args[i - 1] !== '--out');
  launch(exe, file);
}

main().catch((e) => fail(String(e && e.message || e)));
