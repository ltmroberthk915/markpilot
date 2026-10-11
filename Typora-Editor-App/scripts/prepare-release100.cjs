const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const project=path.resolve(__dirname,'..'),extension=path.resolve(project,'../Typora-Editor');
const output=path.join(project,'.backups/2026-09-08-release100');
fs.mkdirSync(output,{recursive:true});
for(const [root,files] of [[project,['package.json','package-lock.json']],[extension,['extension-src/package.json','vsix-meta/extension.vsixmanifest','extension-src/render/js/native-chat.js','extension-src/render/js/split-navigation.js','extension-src/render/js/markdown-locations.js','extension-src/out/common/native-chat.cjs','extension-src/out/completion/host.cjs']]])for(const file of files){
 const source=path.join(root,file),target=path.join(output,root===project?'desktop':'extension',file);if(!fs.existsSync(source)||fs.existsSync(target))continue;fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);
}
const note='D:/Users/Ming/Desktop/实用经济与金融理论/1-重识概率论.md',copy=path.join(output,'user-note-start.md');
if(!fs.existsSync(copy))fs.copyFileSync(note,copy);
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
console.log(JSON.stringify({output,noteSnapshot:copy,noteSHA256:digest(copy)},null,2));
