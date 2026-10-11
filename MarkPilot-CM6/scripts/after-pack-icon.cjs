/** afterPack：把 build/icon.ico 真正写进打包出的 MarkPilot.exe（离线可用）
 *
 *  为什么需要它：electron-builder 自带的图标/签名改写步骤要联网下载 winCodeSign 工具包
 *  （rcedit 就在里面），本机到不了 github.com 的工具包地址 ⇒ 只能 `signAndEditExecutable: false`
 *  关掉它（否则整个构建失败），代价是**图标不会被写进 exe**（装完还是 Electron 默认图标）。
 *  这里在 afterPack（**早于** NSIS/portable 打包 ⇒ 安装器与便携版也会带上图标）用**本机已有**的
 *  rcedit 补上这一步；找不到 rcedit 时**只跳过、绝不让构建失败**。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CANDIDATES = [
  path.join(__dirname, '..', 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
  path.join(__dirname, '..', 'node_modules', '.bin', 'rcedit.cmd'),
  'C:/Users/ltmroberthk/AppData/Local/npm-cache/_npx/009083ec26dc578f/node_modules/electron-winstaller/vendor/rcedit.exe',
];
function findRcedit() {
  // 先看候选，再在 electron-builder / npm 缓存里兜底找一份（只找几层，避免全盘扫描）
  for (const c of CANDIDATES) { try { if (fs.existsSync(c)) return c; } catch { } }
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx'),
    path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache'),
  ];
  const stack = roots.filter((r) => { try { return r && fs.existsSync(r); } catch { return false; } }).map((r) => ({ dir: r, depth: 0 }));
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > 6) continue;
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isFile() && /^rcedit.*\.exe$/i.test(it.name)) return p;
      if (it.isDirectory()) stack.push({ dir: p, depth: depth + 1 });
    }
  }
  return null;
}

exports.default = async function afterPack(context) {
  try {
    if (context.electronPlatformName !== 'win32') return;
    const icon = path.join(__dirname, '..', 'build', 'icon.ico');
    const exe = path.join(context.appOutDir, 'MarkPilot.exe');
    if (!fs.existsSync(icon) || !fs.existsSync(exe)) { console.log('[afterPack-icon] 跳过：缺少 icon.ico 或 MarkPilot.exe'); return; }
    const rcedit = findRcedit();
    if (!rcedit) { console.log('[afterPack-icon] 跳过：本机找不到 rcedit（离线环境）'); return; }
    execFileSync(rcedit, [exe, '--set-icon', icon], { stdio: 'inherit', windowsHide: true });
    console.log('[afterPack-icon] ✓ 已写入图标：' + exe + '  ← ' + rcedit);
  } catch (e) {
    console.log('[afterPack-icon] 写图标失败（不阻断构建）：' + String((e && e.message) || e));
  }
};
