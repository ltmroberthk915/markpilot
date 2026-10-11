import {spawn} from 'node:child_process';
import {copyFileSync, mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const env = {...process.env};delete env.ELECTRON_RUN_AS_NODE;
for (const name of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_?KEY|AUTH_KEY|CREDENTIAL/i.test(name)) delete env[name];
const code = await new Promise((resolve, reject) => {
  const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [path.join(root, 'scripts/render-icons.cjs')], {env, windowsHide:true, stdio:'inherit'});
  child.on('error', reject);child.on('exit', resolve);
});
if (code !== 0) throw new Error('Icon export failed: ' + code);
mkdirSync(path.join(root, 'app/assets'), {recursive:true});
copyFileSync(path.join(root, 'build/icon.png'), path.join(root, 'app/assets/icon.png'));
copyFileSync(path.join(root, 'build/icon.png'), path.resolve(root, '../Typora-Editor/extension-src/icon.png'));
console.log('Generated app, VSIX, runtime and Markdown icons; ICO sizes 16–256 px.');
