/** clip-channels-unicode.cjs —— 判定"哪些注入通道能原样写中文"，以及"读尺子本身会不会把中文读坏"
 *
 *  为什么必须做：r7 里 CF-5c 的载荷 `| 列一 | 列二 |` 到了剪贴板上变成 `| 鍒椾竴 | 鍒椾簩 |`
 *  （UTF-8 字节被按 CP936 解释），那是**注入伪影**，不是产品行为。要出真结论，先得有一把不会
 *  自带同款故障的尺子和一条靠得住的注入通道。
 *
 *  读尺子改成**文件落地**：pwsh 把剪贴板内容以 UTF-8 写进文件，Node 再读文件——
 *  彻底绕开"控制台代码页 / stdout 捕获"这一层（AGENTS 错-3：两把尺子不许共享故障模式）。
 *  用法：node clip-channels-unicode.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DIR = path.join(__dirname, 'clip-channels-unicode');
fs.mkdirSync(DIR, { recursive: true });
const OUT = path.join(DIR, 'readback.txt');
const norm = (s) => String(s == null ? '' : s).replace(/\r\n/g, '\n').replace(/\n+$/, '');

/** 读尺子（文件落地版）：剪贴板 → UTF-8 文件 → Node 读文件 */
const readViaFile = () => {
  try {
    fs.rmSync(OUT, { force: true });
    execFileSync('pwsh', ['-NoProfile', '-Command',
      `Import-Module Microsoft.PowerShell.Management -ErrorAction SilentlyContinue; [IO.File]::WriteAllText('${OUT.replace(/\\/g, '/')}', (Get-Clipboard -Raw), (New-Object Text.UTF8Encoding($false)))`,
    ], { encoding: 'utf8', timeout: 12000, windowsHide: true });
    return fs.readFileSync(OUT, 'utf8');
  } catch (e) { return 'ERR ' + String((e && (e.stderr || e.message)) || e).replace(/\s+/g, ' ').slice(0, 90); }
};
/** 读尺子（老版：stdout 捕获），用来对比"捕获层"会不会自己把中文读坏 */
const readViaStdout = () => {
  try {
    return execFileSync('pwsh', ['-NoProfile', '-Command', 'Import-Module Microsoft.PowerShell.Management -ErrorAction SilentlyContinue; Get-Clipboard -Raw'], { encoding: 'utf8', timeout: 9000, windowsHide: true });
  } catch (e) { return 'ERR ' + String((e && (e.stderr || e.message)) || e).replace(/\s+/g, ' ').slice(0, 90); }
};

const PAYLOAD = '| 列一 | 列二 |\n| --- | --- |\n| a | 1 |';
const CHANNELS = [
  { name: 'A: clip.exe（stdin UTF-8）', run: () => execFileSync('clip', [], { input: PAYLOAD, encoding: 'utf8', timeout: 9000, windowsHide: true }) },
  { name: 'B: cmd /c chcp 65001 & clip', run: () => execFileSync('cmd', ['/c', 'chcp 65001 >nul & clip'], { input: PAYLOAD, encoding: 'utf8', timeout: 9000, windowsHide: true }) },
  {
    name: 'C: pwsh Set-Clipboard（从 UTF-8 文件读）', run: () => {
      const f = path.join(DIR, 'payload.txt'); fs.writeFileSync(f, PAYLOAD, 'utf8');
      execFileSync('pwsh', ['-NoProfile', '-Command', `Set-Clipboard -Value ([IO.File]::ReadAllText('${f.replace(/\\/g, '/')}',[Text.Encoding]::UTF8))`], { encoding: 'utf8', timeout: 12000, windowsHide: true });
    },
  },
  {
    name: 'D: pwsh Set-Clipboard -Path（直接把 UTF-8 文件当载荷）', run: () => {
      const f = path.join(DIR, 'payload-d.txt'); fs.writeFileSync(f, PAYLOAD, 'utf8');
      execFileSync('pwsh', ['-NoProfile', '-Command', `Set-Clipboard -Path '${f.replace(/\\/g, '/')}'`], { encoding: 'utf8', timeout: 12000, windowsHide: true });
    },
  },
];

const rows = [];
for (const ch of CHANNELS) {
  let writeErr = null;
  try { ch.run(); } catch (e) { writeErr = String((e && (e.stderr || e.message)) || e).replace(/\s+/g, ' ').slice(0, 80); }
  const fileBack = readViaFile();
  const stdoutBack = readViaStdout();
  const row = {
    通道: ch.name, 写错: writeErr,
    文件读尺子_相符: norm(fileBack) === norm(PAYLOAD),
    文件读尺子_值: JSON.stringify(String(fileBack).replace(/\r/g, '\\r').slice(0, 50)),
    stdout读尺子_相符: norm(stdoutBack) === norm(PAYLOAD),
    载荷: JSON.stringify(PAYLOAD),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
/* 反向对照：读尺子自己在读**正确 Unicode** 时是否正常（拿文件读尺子读一个已知 UTF-8 文件作基线） */
const BASE = path.join(DIR, 'baseline.txt');
fs.writeFileSync(BASE, PAYLOAD, 'utf8');
const baseBack = fs.readFileSync(BASE, 'utf8');
console.log(JSON.stringify({ 基线: 'Node 读写同一 UTF-8 文件', 相符: norm(baseBack) === norm(PAYLOAD) }));
rows.push({ 通道: '基线(Node 读写同一 UTF-8 文件)', 文件读尺子_相符: norm(baseBack) === norm(PAYLOAD) });
fs.writeFileSync(path.join(DIR, 'result.json'), JSON.stringify(rows, null, 1), 'utf8');
console.log('\n落盘：' + path.join(DIR, 'result.json'));
