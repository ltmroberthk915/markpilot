import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const root = fileURLToPath(new URL('../', import.meta.url));
const application = path.resolve(process.argv[2] || root);
const cases = process.argv[3] ? [process.argv[3]] : ['cold', 'early', 'restore', 'folder', 'empty', 'new-cold', 'new-early', 'new-cancel'];
const output = path.resolve(process.env.RELEASE100_OUTPUT || path.join(root, '.perf', `file-launch-${Date.now()}`));
fs.mkdirSync(output, {recursive: true});
const env = {...process.env};
delete env.ELECTRON_RUN_AS_NODE;
for (const scenario of cases) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'),
      [path.join(root, 'scripts/file-launch-runner.cjs'), application, scenario, path.join(output, scenario)],
      {env, windowsHide: true, stdio: 'inherit', timeout: 60000});
    child.on('error', reject);
    child.on('exit', resolve);
  });
  if (code !== 0) {process.exitCode = 1; break;}
}
if (!process.exitCode) {
  const reports = cases.map(scenario => JSON.parse(fs.readFileSync(path.join(output, scenario, 'results.json'))));
  const report = {application, output, checkedAt: new Date().toISOString(), results: reports.flatMap(r => r.results)};
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.results.length} file launch checks passed. ${path.join(output, 'results.json')}`);
}
