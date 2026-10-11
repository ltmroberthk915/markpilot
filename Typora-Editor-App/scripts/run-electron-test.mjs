import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
const executable = fileURLToPath(new URL('../node_modules/electron/dist/electron.exe', import.meta.url));
const script = fileURLToPath(new URL('./perf-runner.cjs', import.meta.url));
const project = fileURLToPath(new URL('..', import.meta.url));
const env = {...process.env};
delete env.ELECTRON_RUN_AS_NODE;
for (const name of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_?KEY|AUTH_KEY|CREDENTIAL/i.test(name)) delete env[name];
/** 受保护素材的副本一律叫 material-*.md。套件自己也会删，但窗口还开着时 Windows 上 rmSync 报
 *  EBUSY（实测：几乎每次运行都留一份），而 `app.exit()` 又不会发出 will-quit，所以"退出时再删"
 *  那条钩子是假路。这里在**子进程退出之后**再扫一遍——那时句柄一定已释放。这是用户令
 *  "试验结束之后将复制副本删除"的机器闸门，不靠套件自觉。 */
const sweepMaterialCopies = () => {
  const found = [];
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!/^user-data/.test(entry.name)) walk(full); continue; }
      if (/^material-.*\.md$/.test(entry.name)) found.push(full);
    }
  };
  walk(path.join(project, '.perf'));
  const removed = [];
  for (const file of found) { try { fs.rmSync(file, {force: true}); } catch { /* 下一轮再扫 */ } if (!fs.existsSync(file)) removed.push(file); }
  if (removed.length) console.log('已清理受保护素材的副本 ' + removed.length + ' 份：\n  ' + removed.join('\n  '));
  const left = found.filter(file => fs.existsSync(file));
  if (left.length) { console.error('仍有素材副本删不掉（请手工删）：\n  ' + left.join('\n  ')); process.exitCode = 1; }
};
const child = spawn(executable, [script, ...process.argv.slice(2)], {env, windowsHide:true, stdio:'inherit'});
child.on('error', error => {console.error(error);process.exitCode=1});
child.on('exit', code => {sweepMaterialCopies();process.exitCode=code ?? 1});
