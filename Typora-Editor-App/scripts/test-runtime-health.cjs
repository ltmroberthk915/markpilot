// Test-process instrumentation; never included in the distributed application.
const fs=require('node:fs'),path=require('node:path');
exports.install=({app,webFrameMain,output})=>{
  const errors=[],resourceErrors=[],file=path.join(output,'runtime-health.json'),exit=app.exit.bind(app);
  const persist=()=>fs.writeFileSync(file,JSON.stringify({errors,resourceErrors,checkedAt:new Date().toISOString()},null,2));
  const record=entry=>{errors.push(entry);persist();};
  app.on('web-contents-created',(_event,contents)=>{
    contents.on('console-message',event=>{if(event.level==='error'){
      const entry={kind:'console',message:event.message,sourceId:event.sourceId,line:event.lineNumber};
      // Missing/forbidden resources are exercised deliberately by export tests.
      // Preserve their evidence separately from JavaScript failures; the suites
      // must still assert successful resources and expected warning branches.
      if(/^Failed to load resource:/.test(event.message)){resourceErrors.push(entry);persist();}
      else record(entry);
    }});
    contents.on('preload-error',(_event,preload,error)=>record({kind:'preload',preload,error:String(error?.stack||error)}));
    contents.on('render-process-gone',(_event,details)=>{if(!['clean-exit'].includes(details.reason))record({kind:'renderer-process',...details});});
    contents.on('did-frame-finish-load',async(_event,_main,processId,routingId)=>{
      try{await webFrameMain.fromId(processId,routingId)?.executeJavaScript(`(()=>{if(window.__release100HealthInstalled)return;window.__release100HealthInstalled=true;window.addEventListener('error',e=>console.error('[release100 uncaught] '+String(e.error?.stack||e.message)));window.addEventListener('unhandledrejection',e=>console.error('[release100 rejection] '+String(e.reason?.stack||e.reason)));})()`);}
      catch{/* A frame can navigate or close before diagnostic installation. */}
    });
  });
  for(const event of ['uncaughtException','unhandledRejection'])process.on(event,error=>{record({kind:event,error:String(error?.stack||error)});exit(1);});
  app.exit=code=>{persist();exit(code||errors.length?code||1:0);};
  persist();return{errors};
};
