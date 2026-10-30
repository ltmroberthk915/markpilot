'use strict';
// Early entry in a separate Electron application process. It never receives
// the final destination, loads an editor profile, or takes the single-app lock.
const fs=require('node:fs'),path=require('node:path');
const {app,BrowserWindow,ipcMain}=require('electron');
const pdf=require('../export-pdf');
function writeJson(file,value){const next=file+'.next';fs.writeFileSync(next,JSON.stringify(value),{mode:0o600});fs.renameSync(next,file);}
function run(configFile){
 let c;
 try{
  const size=fs.statSync(configFile).size;if(size>pdf.GATE.HTML_MAX_BYTES)throw Error('PDF 输入配置过大');
  c=JSON.parse(fs.readFileSync(configFile,'utf8'));
  const eq=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
  if(c.schema!==1||c.token!==process.env.MP_PDF_WORKER_TOKEN||!/^[a-f0-9-]{36}$/.test(c.token)||!eq(path.dirname(configFile),c.runDir)||path.basename(c.runDir)!=='pdf-worker-'+c.token||!eq(path.dirname(c.runDir),c.stageDir)||!eq(path.dirname(c.stageDir),fs.realpathSync.native(app.getPath('temp')))||!path.basename(c.stageDir).startsWith('markpilot-pdf-')||!eq(path.dirname(c.htmlFile),c.stageDir)||!eq(fs.realpathSync(c.runDir),c.runDir)||!eq(app.getPath('userData'),path.join(c.runDir,'profile-real')))throw Error('PDF 输入不属于本次导出');
 }catch(error){console.error('PDF worker admission:',String(error));app.exit(2);return;}
 const phases=[];
 const report=p=>{phases.push(p);writeJson(path.join(c.runDir,'progress.json'),{token:c.token,phases});};
 app.whenReady().then(async()=>{
  let result;
  try{
   const opts={BrowserWindow,ipcMain,htmlFile:c.htmlFile,outFile:path.join(c.runDir,'output.pdf'),extraCss:c.extraCss,sourceBytes:c.sourceBytes,onPhase:report};
   for(const k of ['css','kp','print','showWindow'])if(k in c)opts[k]=c[k];
   result=await pdf.printLocalHtmlToPdf(opts);
  }catch(error){result={ok:false,error:String(error.message||error),code:error.code};}
  try{writeJson(path.join(c.runDir,'result.json'),{schema:1,token:c.token,pid:process.pid,result});}
  catch(error){console.error('PDF worker result:',String(error));app.exit(2);return;}
  app.exit(result.ok?0:1);
 }).catch(error=>{console.error('PDF worker startup:',String(error));app.exit(2);});
}
module.exports={run};
