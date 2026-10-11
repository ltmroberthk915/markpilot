/** clip-utf8-check —— 验证"强制 UTF-8 代码页后 clip.exe 写中文"是否可靠（r7 的注入伪影修复自证）
 *  判据：另一个独立 pwsh 进程 Get-Clipboard -Raw 回读 == 载荷（逐字节，只归一化 CRLF/尾换行）
 *  用法：node clip-utf8-check.cjs
 */
'use strict';
const { execFileSync } = require('node:child_process');
const norm = (s) => String(s == null ? '' : s).replace(/\r\n/g, '\n').replace(/\n+$/, '');
const read = () => {
  try { return execFileSync('pwsh', ['-NoProfile', '-Command', 'Import-Module Microsoft.PowerShell.Management -ErrorAction SilentlyContinue; Get-Clipboard -Raw'], { encoding: 'utf8', timeout: 9000, windowsHide: true }); }
  catch (e) { return 'ERR ' + String(e.stderr || e.message).slice(0, 70); }
};
const CASES = [
  { name: 'cn-table', text: '| 列一 | 列二 |\n| --- | --- |\n| a | 1 |' },
  { name: 'cn-plain', text: '中文测试-甲乙丙-表头' },
  { name: 'tab-tsv', text: 'name\tvalue\nalpha\t1' },
];
for (const c of CASES) {
  let err = null;
  try { execFileSync('cmd', ['/c', 'chcp 65001 >nul & clip'], { input: c.text, encoding: 'utf8', timeout: 9000, windowsHide: true }); }
  catch (e) { err = String(e.stderr || e.message).slice(0, 70); }
  const back = read();
  console.log(JSON.stringify({ case: c.name, err, match: norm(back) === norm(c.text), back: JSON.stringify(String(back).replace(/\r/g, '\\r').slice(0, 60)) }));
}
