/** clip-inject-enc —— 选定"往系统剪贴板注入载荷"的可靠通道（Unicode / TAB / 多行）
 *
 *  背景：code-fence-daily 的 CF-5/5b/5c 需要把载荷放进**系统剪贴板**再真 Ctrl+V。
 *  通道候选：
 *    A) clip.exe（宿主独立进程，stdin）
 *    B) pwsh 子进程 Set-Clipboard -Value（先写 UTF-8 文件，再从文件读，避免命令行编码）
 *  判据：**另一个独立 pwsh 进程** Get-Clipboard -Raw 回读，与载荷逐字节相等（只归一化 CRLF）。
 *  用法：node clip-inject-enc.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DIR = path.join(__dirname, 'clip-inject-enc');
fs.mkdirSync(DIR, { recursive: true });

const CASES = [
  { name: 'cf5-ascii3', text: 'let x = 1;\nlet y = 2;\nconsole.log(x + y);' },
  { name: 'cf5b-tab', text: 'name\tvalue\nalpha\t1\nbeta\t2' },
  { name: 'cf5c-cn-table', text: '| 列一 | 列二 |\n| --- | --- |\n| a | 1 |' },
];
const norm = (s) => String(s == null ? '' : s).replace(/\r\n/g, '\n').replace(/\n+$/, '');
const psRead = () => {
  try {
    return execFileSync('pwsh', ['-NoProfile', '-Command', 'Import-Module Microsoft.PowerShell.Management -ErrorAction SilentlyContinue; Get-Clipboard -Raw'], { encoding: 'utf8', timeout: 9000, windowsHide: true });
  } catch (e) { return 'ERR ' + String(e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 90); }
};
const viaClipExe = (text) => {
  try { execFileSync('clip', [], { input: text, encoding: 'utf8', timeout: 9000, windowsHide: true }); return null; }
  catch (e) { return String(e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 90); }
};
const viaPwshSet = (text, file) => {
  fs.writeFileSync(file, text, 'utf8');
  try {
    execFileSync('pwsh', ['-NoProfile', '-Command', `Set-Clipboard -Value ([IO.File]::ReadAllText('${file.replace(/\\/g, '/')}',[Text.Encoding]::UTF8))`], { encoding: 'utf8', timeout: 12000, windowsHide: true });
    return null;
  } catch (e) { return String(e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 90); }
};

const out = [];
for (const c of CASES) {
  for (const via of ['clip.exe', 'pwsh-SetClipboard']) {
    const err = via === 'clip.exe' ? viaClipExe(c.text) : viaPwshSet(c.text, path.join(DIR, c.name + '.txt'));
    const back = psRead();
    out.push({ case: c.name, via, writeErr: err, match: norm(back) === norm(c.text), backHead: JSON.stringify(String(back).replace(/\r/g, '\\r').replace(/\t/g, '\\t').slice(0, 70)) });
    console.log(JSON.stringify(out[out.length - 1]));
  }
}
fs.writeFileSync(path.join(DIR, 'result.json'), JSON.stringify(out, null, 1), 'utf8');
console.log('\n落盘：' + path.join(DIR, 'result.json'));
