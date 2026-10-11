// Launch one disposable packaged instance for the native Save dialog check.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;
const executable=path.join(root,`dist/release-${version}-final/win-unpacked/markpilot.exe`);
const output=path.join(root,'.perf','new-ui-'+Date.now()),profile=path.join(output,'profile'),fixtures=path.join(output,'新建 测试 # (目录)');
fs.mkdirSync(profile,{recursive:true});fs.mkdirSync(fixtures,{recursive:true});
fs.writeFileSync(path.join(fixtures,'previous.md'),'# Previous file remains intact\n');
fs.writeFileSync(path.join(profile,'state.json'),JSON.stringify({lastWs:fixtures,lastFile:path.join(fixtures,'previous.md')}));
await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(48190,'127.0.0.1',()=>s.close(resolve));});
const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(executable,['--user-data-dir='+profile,'--remote-debugging-port='+port,'--new-md'],{env,detached:true,windowsHide:false,stdio:'ignore'});
await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
const report={executable,output,profile,fixtures,port,pid:child.pid};
fs.writeFileSync(path.join(root,'.perf','new-ui-active.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
