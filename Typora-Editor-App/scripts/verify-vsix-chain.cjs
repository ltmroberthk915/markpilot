// 四方哈希链校验（用户令·铁律 11）：
//   extension-src/render == app/renderer == 已安装 app.asar 内 app/renderer == VSIX 内 extension/render
// 外加：App package.json 版本 == extension package.json 版本 == vsixmanifest Identity Version。
// 运行：node scripts/verify-vsix-chain.cjs [<vsix 路径>] [<app.asar 路径>]
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const asar=require('@electron/asar');
const root=path.resolve(__dirname,'..'),plugin=path.resolve(root,'../Typora-Editor');
const appVersion=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
const extension=JSON.parse(fs.readFileSync(path.join(plugin,'extension-src/package.json'),'utf8')).version;
const vsix=process.argv[2]||path.join(plugin,`dist/markpilot-${extension}.vsix`);
const archive=process.argv[3]||path.join(root,'dist-2.0.11/win-unpacked/resources/app.asar');
const scratch=path.join(root,'.perf/verify-vsix-chain');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const listing=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(item=>item.isDirectory()?listing(path.join(dir,item.name)):[path.join(dir,item.name)]);

assert.equal(appVersion,extension,`version drift: App ${appVersion} vs extension ${extension}`);

// --- VSIX 解包：PATH 上的 tar 是 MSYS 的 GNU tar（不认 zip，且把 "E:" 当远程主机），
//     必须用 Windows 自带 bsdtar；路径一律转正斜杠。---
const {spawnSync}=require('node:child_process');
fs.rmSync(scratch,{recursive:true,force:true});fs.mkdirSync(scratch,{recursive:true});
const bsdtar=path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe');
const unzip=spawnSync(bsdtar,['-xf',vsix.replace(/\\/g,'/'),'-C',scratch.replace(/\\/g,'/')],{encoding:'utf8'});
assert.equal(unzip.status,0,`VSIX extract failed: ${unzip.stderr}`);
const extractedRoot=path.join(scratch,'extension');
assert.ok(fs.existsSync(extractedRoot),'VSIX has no extension/ root');
const manifest=fs.readFileSync(path.join(scratch,'extension.vsixmanifest'),'utf8');
const manifestVersion=/<Identity\b[^>]*\bVersion="([^"]+)"/.exec(manifest)?.[1];
assert.equal(manifestVersion,extension,`vsixmanifest version ${manifestVersion} != ${extension}`);
// Identity Publisher 必须与 package.json 的 publisher 一致：Open VSX / VS Code Marketplace
// 都按这个字段判发布者。漏同步时的症状是 ovsx 报 "Unknown publisher: <旧名>"，而包里看不出毛病
// ——本轮真踩过（清单里写死旧品牌名，pack.py 当时只同步 Version）。
const manifestPublisher=/<Identity\b[^>]*\bPublisher="([^"]+)"/.exec(manifest)?.[1];
const packagePublisher=JSON.parse(fs.readFileSync(path.join(plugin,'extension-src/package.json'),'utf8')).publisher;
assert.equal(manifestPublisher,packagePublisher,`vsixmanifest publisher ${manifestPublisher} != package.json publisher ${packagePublisher}`);
// 清单里的展示元数据也必须与 package.json 一致：商店（Open VSX / VS Marketplace）**优先读清单**，
// DisplayName/Description 决定商店页显示、Tags 决定商店搜索能否命中。只改 package.json 不够——
// 本轮真踩过：keywords 加到 22 个而商店里的 Tags 还是 4 个弱词、描述还是旧文案。
const srcPackage=JSON.parse(fs.readFileSync(path.join(plugin,'extension-src/package.json'),'utf8'));
const unescape=text=>String(text||'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const elementOf=tag=>{const hit=new RegExp('<'+tag+'\\b[^>]*>([\\s\\S]*?)</'+tag+'>').exec(manifest);return hit?unescape(hit[1]).trim():null;};
assert.equal(elementOf('DisplayName'),srcPackage.displayName,'清单 DisplayName 与 package.json 不一致');
assert.equal(elementOf('Description'),srcPackage.description,'清单 Description 与 package.json 不一致');
assert.equal(elementOf('Tags'),(srcPackage.keywords||[]).join(','),'清单 Tags 与 package.json keywords 不一致');
assert.equal(elementOf('Categories'),(srcPackage.categories||[]).join(','),'清单 Categories 与 package.json categories 不一致');

// --- 1) VSIX 内每个文件 == extension-src 对应文件（package.json 允许构建期注入 __metadata 的差异）---
const source=path.join(plugin,'extension-src');
let extensionFiles=0,diffs=[];
for(const file of listing(source)){
  const rel=path.relative(source,file),target=path.join(extractedRoot,rel);
  if(!fs.existsSync(target)){diffs.push('missing in VSIX: '+rel);continue;}
  if(rel===path.join('package.json')){extensionFiles++;continue;}   // 打包器可注入字段，单独比版本
  if(!fs.readFileSync(file).equals(fs.readFileSync(target)))diffs.push('content differs: '+rel);
  extensionFiles++;
}
assert.deepEqual(diffs,[],'VSIX != extension-src\n'+diffs.slice(0,10).join('\n'));
assert.equal(JSON.parse(fs.readFileSync(path.join(extractedRoot,'package.json'),'utf8')).version,extension,'VSIX package.json version');

// --- 2) 渲染层四方一致 ---
const renderer=path.join(source,'render'),rendererFiles=listing(renderer);
for(const file of rendererFiles){
  const rel=path.relative(renderer,file);
  assert.ok(fs.readFileSync(file).equals(fs.readFileSync(path.join(root,'app/renderer',rel))),'app/renderer mismatch '+rel);
  assert.ok(fs.readFileSync(file).equals(fs.readFileSync(path.join(extractedRoot,'render',rel))),'VSIX render mismatch '+rel);
}
// --- 3) 打包 app.asar 内 app/renderer 与 VSIX 内 extension/render 同时对齐源码 ---
// @electron/asar 3.4.1 的 extractFile 对嵌套路径会报 "not found"（已知坑），
// 改用 extractAll 到临时目录后逐文件比对。
assert.ok(fs.existsSync(archive),'missing app.asar: '+archive);
const asarScratch=path.join(scratch,'app-asar');
fs.mkdirSync(asarScratch,{recursive:true});
asar.extractAll(archive,asarScratch);
for(const file of rendererFiles){
  const rel=path.relative(renderer,file);
  const packed=path.join(asarScratch,'app/renderer',rel);
  assert.ok(fs.existsSync(packed),'missing in app.asar: app/renderer/'+rel);
  assert.ok(fs.readFileSync(file).equals(fs.readFileSync(packed)),'app.asar renderer mismatch '+rel);
}
const packedPackage=JSON.parse(fs.readFileSync(path.join(asarScratch,'package.json'),'utf8'));
assert.equal(packedPackage.version,appVersion,'app.asar version '+packedPackage.version);

const report={
  appVersion,extension,manifestVersion,
  vsix:{path:vsix,bytes:fs.statSync(vsix).size,sha256:sha(vsix)},
  appAsar:{path:archive,bytes:fs.statSync(archive).size,sha256:sha(archive)},
  extensionFilesVerified:extensionFiles,sharedRendererFilesVerified:rendererFiles.length,
  chain:'extension-src/render == app/renderer == app.asar(app/renderer) == VSIX(extension/render)',
  verified:true,
};
fs.writeFileSync(path.join(root,'docs',`verify-vsix-chain-${appVersion}.json`),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
