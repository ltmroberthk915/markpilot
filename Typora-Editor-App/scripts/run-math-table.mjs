import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
for(const name of Object.keys(env))if(/TOKEN|SECRET|PASSWORD|API_?KEY|AUTH_KEY|CREDENTIAL/i.test(name))delete env[name];
const child=spawn(fileURLToPath(new URL('../node_modules/electron/dist/electron.exe',import.meta.url)),[fileURLToPath(new URL('./math-table-runner.cjs',import.meta.url)),...process.argv.slice(2)],{env,windowsHide:true,stdio:'inherit'});
child.on('error',e=>{console.error(e);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
