const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),asar=require('@electron/asar');
const project=path.resolve(__dirname,'..'),source=path.resolve(project,'../Typora-Editor/extension-src/render');
const app=path.join(project,'app/renderer'),archive=path.join(project,'dist/release-1.0.18-private-final/win-unpacked/resources/app.asar');
const vsix=path.resolve(project,'../Typora-Editor/test/.runs/vsix-private-0.1.28-viewflow-v8-final/extension/render');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const files=root=>fs.readdirSync(root,{withFileTypes:true}).flatMap(item=>item.isDirectory()?files(path.join(root,item.name)).map(p=>item.name+'/'+p):[item.name]).sort();
const names=files(source);assert.deepEqual(files(app),names);assert.deepEqual(files(vsix),names);
const report={checkedAt:new Date().toISOString(),rendererFiles:names.length,files:[]};
for(const name of names){
  const expected=hash(fs.readFileSync(path.join(source,name)));
  const actual={desktopSource:hash(fs.readFileSync(path.join(app,name))),desktopASAR:hash(asar.extractFile(archive,path.join('app','renderer',name))),vsix:hash(fs.readFileSync(path.join(vsix,name)))};
  for(const [kind,value] of Object.entries(actual))assert.equal(value,expected,kind+' differs: '+name);
  report.files.push({path:name,sha256:expected});
}
assert.equal(JSON.parse(asar.extractFile(archive,'package.json').toString()).version,'1.0.18');
assert.equal(JSON.parse(fs.readFileSync(path.join(vsix,'../package.json'),'utf8')).version,'0.1.28-local');
report.nativeChatHostFiles=['common/native-chat.cjs','provider/markdownEditorProvider.js','completion/host.cjs'].map(name=>{
  const expected=hash(fs.readFileSync(path.resolve(source,'../out',name)));assert.equal(hash(fs.readFileSync(path.resolve(vsix,'../out',name))),expected,'Final VSIX host differs: '+name);return{path:name,sha256:expected};
});
const packaged=JSON.parse(fs.readFileSync(path.join(vsix,'../package.json'),'utf8'));
assert.ok(packaged.contributes.commands.some(c=>c.command==='markpilot.addSelectionToChat'));
// The webview captures Alt+U only for its own selected document. Avoid a
// workbench-level fallback that can also run while another sidebar has focus.
assert.ok(!(packaged.contributes.keybindings||[]).some(k=>k.command==='markpilot.addSelectionToChat'));
const output=path.join(project,'.perf/viewflow-delivery');
report.public=JSON.parse(fs.readFileSync(path.join(output,'public-before.json'),'utf8'));
for(const entry of report.public)assert.equal(hash(fs.readFileSync(path.resolve(project,entry.path))),entry.sha256,'Public artifact changed: '+entry.path);
report.noteSHA256=hash(fs.readFileSync('D:/Users/Ming/Desktop/实用经济与金融理论/1-重识概率论.md'));
report.testedNoteSnapshots=['user-note-original.md','user-note-latest.md'].map(name=>({name,sha256:hash(fs.readFileSync(path.join(project,'.backups/2026-09-08-viewflow',name)))}));
report.liveNoteMatchesInitialSnapshot=report.noteSHA256===report.testedNoteSnapshots[0].sha256;
report.artifacts=[
  path.join(project,'dist/release-1.0.18-private-final/markpilot-Setup-1.0.18.exe'),
  path.join(project,'dist/release-1.0.18-private-final/markpilot-v1.0.18-portable.exe'),archive,
  path.resolve(project,'../Typora-Editor/dist/markpilot-0.1.28-local.vsix'),
].map(p=>({path:p,bytes:fs.statSync(p).size,modified:fs.statSync(p).mtime.toISOString(),sha256:hash(fs.readFileSync(p))}));
report.verified=true;fs.writeFileSync(path.join(output,'coherence.json'),JSON.stringify(report,null,2));
console.log(`PASS ${names.length} renderer files identical across shared source, desktop source, final ASAR and final VSIX; public artifacts unchanged. Live-note and tested-snapshot hashes recorded separately.`);
console.log(JSON.stringify(report.artifacts,null,2));
