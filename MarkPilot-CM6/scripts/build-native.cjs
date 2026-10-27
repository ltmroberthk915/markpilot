'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
if(process.platform!=='win32') { console.log('Native Windows helper build requires Windows'); process.exit(0); }
const compiler=path.join(process.env.WINDIR||'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
if(!fs.existsSync(compiler))throw Error('The .NET Framework C# compiler is required to build the Windows file worker');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for(const [sourceName,outName] of [['FileWorker.cs','file-worker.exe'],['PdfWorkerGuard.cs','pdf-worker-guard.exe']]){
const source=path.join(root,'native',sourceName),out=path.join(root,'shell/native',outName);
fs.mkdirSync(path.dirname(out),{recursive:true});
const manifest=out+'.build.json',inputs={source:hash(source),compiler:hash(compiler),script:hash(__filename)};
try{const prior=JSON.parse(fs.readFileSync(manifest,'utf8'));if(JSON.stringify(prior.inputs)===JSON.stringify(inputs)&&hash(out)===prior.sha256){console.log(JSON.stringify({...prior,reused:true}));continue;}}catch{}
cp.execFileSync(compiler,['/nologo','/optimize+','/target:exe','/platform:x64','/reference:System.Web.Extensions.dll','/out:'+path.relative(path.dirname(source),out),sourceName],{cwd:path.dirname(source),windowsHide:true,stdio:'inherit'});
const built={file:path.relative(root,out),bytes:fs.statSync(out).size,sha256:hash(out),inputs};fs.writeFileSync(manifest,JSON.stringify(built,null,2));console.log(JSON.stringify(built));
}
