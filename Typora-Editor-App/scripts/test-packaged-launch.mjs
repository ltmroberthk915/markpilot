// Verify the shipping EXE's actual argv parsing and Windows single-instance forwarding.
// Uses an isolated --user-data-dir and disposable documents; never changes associations.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {quoteArgument}=require('../app/main/jump-list');

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
const executable = path.resolve(process.argv[2] || path.join(root, `dist/release-${version}-final/win-unpacked/markpilot.exe`));
const output = path.join(root, '.perf', `exe-launch-${Date.now()}`);
const profile = path.join(output, 'profile');
const fixtures = path.join(output, '真实程序 中文 # (目录)');
fs.mkdirSync(profile, {recursive: true}); fs.mkdirSync(fixtures, {recursive: true});
const first = path.join(fixtures, '双击 第一份.md'), second = path.join(fixtures, '再次双击 第二份.md');
fs.writeFileSync(first, '# EXE first\n\n正文 $x+1$\n');
fs.writeFileSync(second, '# EXE second\n\n正文 $y+2$\n');
const history=Array.from({length:20},(_,i)=>path.join(fixtures,'最近笔记 '+String(i+1).padStart(2,'0')+'.md'));
history.forEach(file=>fs.writeFileSync(file,'# Recent fixture\n'));
const missing=path.join(fixtures,'deleted.md');
fs.writeFileSync(path.join(profile, 'state.json'), JSON.stringify({lastFile: second, lastWs: fixtures,recentFiles:[missing,fixtures,...history]}));
const nativeFolder=path.join(process.env.APPDATA,'Microsoft','Windows','Recent','CustomDestinations');
const nativeBefore=new Map(fs.readdirSync(nativeFolder).map(name=>[name,fs.statSync(path.join(nativeFolder,name)).mtimeMs]));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const pass = message => {results.push('PASS ' + message); console.log(results.at(-1));};
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
const port = await new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {const port = server.address().port; server.close(() => resolve(port));});
});
// The application serves its documents on 48190; avoid interfering with a running copy.
await new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', () => reject(new Error('Port 48190 is occupied; stop this test, leave the running app alone.')));
  server.listen(48190, '127.0.0.1', () => server.close(resolve));
});
const child = spawn(executable, [first, '--user-data-dir=' + profile, '--remote-debugging-port=' + port],
  {env, cwd: fixtures, windowsHide: true, stdio: 'ignore'});
const exited = new Promise(resolve => child.once('exit', resolve));
let socket;
try {
  const until = async (fn, description) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {const result = await fn(); if (result) return result;} catch {}
      await delay(50);
    }
    throw new Error('Timed out: ' + description);
  };
  const page = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find(item => item.type === 'page' && /\/shell$/.test(item.url));
  }, 'packaged shell');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map(); let sequence = 0;
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const {resolve, reject, timer} = pending.get(message.id);
      pending.delete(message.id); clearTimeout(timer);
      if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message)));
      else resolve(message.result);
    }
  };
  await new Promise((resolve, reject) => {socket.onopen = resolve; socket.onerror = reject;});
  const command = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {pending.delete(id); reject(new Error('CDP timeout: ' + method));}, 5000);
    pending.set(id, {resolve, reject, timer}); socket.send(JSON.stringify({id, method, params}));
  });
  const ev = async expression => (await command('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true})).result?.value;
  const frame = 'document.getElementById("editor").contentWindow';
  await until(() => ev(`${frame}?.vditor?.vditor?.__typoraPatched && ${frame}.vditor.getValue().includes('EXE first')`), 'cold file association launch');
  assert.equal(await ev('document.getElementById("welcome").style.display'), 'none');
  const activePath = 'decodeURIComponent(new URL(document.getElementById("editor").src).pathname.slice(5))';
  assert.equal(await ev(activePath), first);
  pass('shipping EXE opens its file argument directly, overriding the previous session');
  await until(() => JSON.parse(fs.readFileSync(path.join(profile, 'state.json'))).lastFile === first, 'isolated profile saved');
  pass('real EXE uses the disposable user-data-dir');
  const nativeFile=await until(()=>{
    for(const name of fs.readdirSync(nativeFolder)) {
      const file=path.join(nativeFolder,name);if(fs.statSync(file).mtimeMs===(nativeBefore.get(name)??-1))continue;
      if(fs.readFileSync(file).includes(Buffer.from(profile,'utf16le')))return file;
    }
  },'isolated native Jump List persisted');
  const linksReport=path.join(output,'native-links','results.json');
  const readerCode=await new Promise((resolve,reject)=>{
    const reader=spawn(path.join(root,'node_modules/electron/dist/electron.exe'),[path.join(root,'scripts/read-native-jump-list.cjs'),nativeFile,linksReport],{env,windowsHide:true,stdio:'inherit',timeout:10000});
    reader.once('error',reject);reader.once('exit',resolve);
  });
  assert.equal(readerCode,0);
  const nativeLinks=JSON.parse(fs.readFileSync(linksReport)).links;
  const links=nativeLinks.filter(link=>link.target && link.args);
  assert.equal(links.length,16,JSON.stringify(nativeLinks));
  assert.equal(nativeLinks.length,17,'15 files + separator + New Markdown');
  assert.ok(links.slice(0,15).every(link=>link.target.toLowerCase()===executable.toLowerCase()));
  assert.deepEqual(links.slice(0,15).map(link=>link.description),[first,...history.slice(0,14)]);
  assert.ok(links.at(-1).args.includes('"--new-md"'));assert.ok(!links.at(-1).args.includes('--remote-debugging-port'));
  pass('Windows persisted all 15 ordered unique file tasks, separator and New Markdown');
  const task=links[7];
  const taskExit=await new Promise((resolve,reject)=>{
    const next=spawn(task.target,[task.args],{argv0:quoteArgument(task.target),windowsVerbatimArguments:true,env,cwd:fixtures,windowsHide:true,stdio:'ignore',timeout:20000});
    next.once('error',reject);next.once('exit',resolve);
  });
  assert.equal(taskExit,0);
  await until(()=>ev(activePath).then(file=>file===task.description),'persisted task opens exact document');
  await until(()=>ev(`${frame}?.vditor?.vditor?.__typoraPatched && ${frame}.vditor.getValue().includes('Recent fixture')`),'task editor ready');
  pass('native persisted shortcut arguments open the exact Unicode file in the existing window');
  const secondExit = await new Promise((resolve, reject) => {
    const next = spawn(executable, [path.basename(second), '--user-data-dir=' + profile],
      {env, cwd: fixtures, windowsHide: true, stdio: 'ignore', timeout: 20000});
    next.once('error', reject); next.once('exit', resolve);
  });
  assert.equal(secondExit, 0);
  await until(() => ev(`${frame}?.vditor?.vditor?.__typoraPatched && ${frame}.vditor.getValue().includes('EXE second')`), 'second EXE forwards relative file');
  assert.equal(await ev(activePath), second);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  assert.equal(pages.filter(item => item.type === 'page' && /\/shell$/.test(item.url)).length, 1);
  pass('second EXE opens its Unicode relative path in the existing window');
  await delay(300);
  await ev(`(() => {const w=${frame},r=w.vditor.vditor.ir.element;w.focus();r.focus();w.getSelection().selectAllChildren(r.querySelector('h1'));w.getSelection().collapseToEnd()})()`);
  await command('Input.insertText', {text: ' 可直接编辑'});
  await until(() => ev('document.getElementById("st-save").textContent.includes("未保存")'), 'real input reaches host');
  await ev('hostApi.invoke("save")');
  const saved = fs.readFileSync(second, 'utf8');
  assert.ok(saved.includes('可直接编辑')); assert.ok(saved.includes('$y+2$'));
  assert.equal(saved, await ev(`${frame}.vditor.getValue()`));
  pass('native editing and saving work in the file opened by the EXE');
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({executable, version, output,nativeFile, checkedAt: new Date().toISOString(), results}, null, 2) + '\n');
  console.log(path.join(output, 'results.json'));
} finally {
  socket?.close();
  if (child.exitCode === null) child.kill();
  await exited;
}
