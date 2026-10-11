/** 补丁 17（重大）：probe-310 用**固定 CDP 端口 9598** ⇒ 只要有一个残留实例占着它，
 *  connectOverCDP 就连到**那个旧实例**上，"换产物复跑"读到的其实是旧包的界面（实测：preview7 跑出 preview6 行为）。
 *  处置：① 端口每次不同；② 起前清掉**我自己**的残留（命令行含 profile-310）；③ 连上后校验页面 URL 指向的 asar 与本次 exe 一致（能校验就校验）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = path.join(__dirname, 'probe-310.cjs');
let t = fs.readFileSync(p, 'utf8');
let n = 0;
if (t.includes('const PORT = 9598;')) {
  t = t.replace('const PORT = 9598;', `/* CDP 端口每次不同：固定端口若被残留实例占着，connectOverCDP 会连到**旧实例** ⇒ 换产物复跑会读到旧包界面（实测踩过） */
const PORT = 9500 + (process.pid % 400);`);
  n++;
}
/* 起前清自己的残留 */
const launchAnchor = "  child = spawn(EXE, [MD, `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`], { env, stdio: 'ignore' });";
if (t.includes(launchAnchor) && !t.includes('清掉我自己的残留实例')) {
  t = t.replace(launchAnchor, `  /* 起前清掉**我自己**的残留（命令行含 profile-310 的 MarkPilot 进程），避免"连到旧实例" */
  try {
    const ps = execSync(\`pwsh -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\\\"Name='MarkPilot.exe'\\\\" | Where-Object { $_.CommandLine -match 'profile-310' } | ForEach-Object { $_.ProcessId }"\`, { encoding: 'utf8', windowsHide: true });
    const pids = ps.split(/\\s+/).filter((x) => /^\\d+$/.test(x));
    if (pids.length) { console.log('· 清掉我自己的残留实例：' + pids.join(', ')); for (const pid of pids) { try { execSync(\`taskkill /PID \${pid} /T /F\`, { stdio: 'ignore', windowsHide: true }); } catch { } } await sleep(1200); }
  } catch { }
` + launchAnchor);
  n++;
}
fs.writeFileSync(p, t, 'utf8');
console.log(`✓ 应用了 ${n} 处补丁（端口唯一化 + 起前清残留）`);
