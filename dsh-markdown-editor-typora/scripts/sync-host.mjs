// The desktop's maintained disk transaction is also the plugin's local writer.
// Copy an explicit dependency closure, then verify the deployed bytes.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const plugin=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.resolve(plugin,'../MarkPilot-CM6/shell'),dest=path.join(plugin,'host');
const files=['document-store.js','live-documents.js','text-codec.js','safe-file.js','native-worker-lease.js','native-worker-path.ps1','native/file-worker.exe','native/file-worker.exe.build.json'];
export function syncHost(check=false) {
  const manifest=[];
  const entries=[...files.map(file=>[file,fs.readFileSync(path.join(source,file))]),['package.json',Buffer.from('{"type":"commonjs"}\n')]];
  const expected=new Set(entries.map(([file])=>file));
  function visit(directory,prefix='') {
    if(!fs.existsSync(directory))return;
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      const rel=prefix+entry.name;
      if(entry.isDirectory())visit(path.join(directory,entry.name),rel+'/');
      else if(!entry.isFile()||!expected.has(rel))throw Error('Unexpected host payload entry: '+rel);
    }
  }
  visit(dest);
  for(const [file,bytes] of entries){
    const target=path.join(dest,file);
    if(!check){fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);}
    if(!fs.existsSync(target)||!fs.readFileSync(target).equals(bytes))throw Error('Host payload drift: '+file);
    manifest.push({path:file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  const json=JSON.stringify({source:'../MarkPilot-CM6/shell',files:manifest},null,2)+'\n',file=path.join(plugin,'host.json');
  if(!check)fs.writeFileSync(file,json);
  if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==json)throw Error('Host manifest drift');
  console.log('HOST_'+(check?'CHECK':'SYNC')+'_OK '+entries.length+' files');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))syncHost(process.argv.includes('--check'));
