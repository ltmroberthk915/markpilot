/** clip-chan-ab.cjs —— A(clip.exe) vs B(chcp65001+clip.exe) 对中文载荷的可靠度，各 3 轮
 *  读尺子＝**文件落地**（pwsh 把剪贴板写成 UTF-8 文件，Node 读文件），并分类：
 *    相符 / 乱码（含 U+FFFD 或 "鍒" 这类"UTF-8 被当 GBK 解"的特征字）/ 外来值 / 其它
 *  用法：node clip-chan-ab.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const DIR = path.join(__dirname, 'clip-chan-ab');
fs.mkdirSync(DIR, { recursive: true });
const OUT = path.join(DIR, 'readback.txt');
const P = '| 列一 | 列二 |\n| --- | --- |\n| a | 1 |';
const norm = (s) => String(s == null ? '' : s).replace(/\r\n/g, '\n').replace(/\n+$/, '');
const readFile = () => {
  try {
    fs.rmSync(OUT, { force: true });
    execFileSync('pwsh', ['-NoProfile', '-Command', `Import-Module Microsoft.PowerShell.Management -ErrorAction SilentlyContinue; [IO.File]::WriteAllText('${OUT.replace(/\\/g, '/')}', (Get-Clipboard -Raw), (New-Object Text.UTF8Encoding($false)))`], { encoding: 'utf8', timeout: 12000, windowsHide: true });
    return fs.readFileSync(OUT, 'utf8');
  } catch (e) { return 'ERR ' + String((e && (e.stderr || e.message)) || e).slice(0, 60); }
};
const writeA = () => execFileSync('clip', [], { input: P, encoding: 'utf8', timeout: 9000, windowsHide: true });
const writeB = () => execFileSync('cmd', ['/c', 'chcp 65001 >nul & clip'], { input: P, encoding: 'utf8', timeout: 9000, windowsHide: true });
const classify = (back) => {
  const n = norm(back);
  if (n === norm(P)) return '相符';
  if (/[\uFFFD鍒]/.test(n)) return '乱码(UTF-8被当GBK解)';
  if (/^MPU|^CFD|T1\t|头A/.test(n)) return '外来值(别的腿写的)';
  return '其它';
};
const rows = [];
for (const [name, w] of [['A: clip.exe', writeA], ['B: chcp65001+clip.exe', writeB]]) {
  for (let r = 1; r <= 3; r++) {
    let err = null;
    try { w(); } catch (e) { err = String((e.stderr || e.message)).slice(0, 60); }
    const back = readFile();
    const row = { 通道: name, 轮: r, 写错: err, 判定: classify(back), 读回: JSON.stringify(String(back).replace(/\r/g, '\\r').slice(0, 46)) };
    rows.push(row); console.log(JSON.stringify(row));
    execFileSync('cmd', ['/c', 'ping -n 1 -w 120 127.0.0.1 >nul'], { windowsHide: true });
  }
}
fs.writeFileSync(path.join(DIR, 'result.json'), JSON.stringify(rows, null, 1), 'utf8');
console.log('落盘：' + path.join(DIR, 'result.json'));
