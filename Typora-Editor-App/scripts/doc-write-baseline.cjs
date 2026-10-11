// Regression reproduction against the pre-autosave controller; disposable file.
const fs=require('node:fs/promises'),path=require('node:path'),Module=require('node:module');
const load=Module._load;Module._load=function(name,...args){return name==='electron'?{dialog:{showMessageBoxSync(){return 2;}},shell:{}}:load.call(this,name,...args);};
const asar=require('@electron/asar'),sourceFile=path.resolve(__dirname,'../app/main/doc.js');
const frozen=new Module(sourceFile,module);frozen.filename=sourceFile;frozen.paths=Module._nodeModulePaths(path.dirname(sourceFile));
frozen._compile(asar.extractFile(path.resolve(__dirname,'../dist/release-1.0.8-final/win-unpacked/resources/app.asar'),path.join('app','main','doc.js')).toString('utf8'),sourceFile);
const {DocController}=frozen.exports;Module._load=load;
(async()=>{
  const root=await fs.mkdtemp(path.resolve('.perf/save-baseline-')),file=path.join(root,'fixture.md');await fs.writeFile(file,'initial');
  const cur={file,text:'first edit',savedText:'initial',dirty:true};
  const doc=Object.assign(Object.create(DocController.prototype),{current:cur,updateTitle(){},scheduleStats(){}});
  const write=fs.writeFile;let release,entered;const start=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  fs.writeFile=async(...args)=>{entered();await gate;return write(...args);};
  try{const saving=doc.save();await start;cur.text='second edit during disk write';release();await saving;const disk=await fs.readFile(file,'utf8');console.log(JSON.stringify({disk,memory:cur.text,savedText:cur.savedText,dirty:cur.dirty,bugReproduced:disk!==cur.text&&!cur.dirty},null,2));}
  finally{fs.writeFile=write;await fs.unlink(file);await fs.rmdir(root);}
})().catch(e=>{console.error(e);process.exitCode=1;});
