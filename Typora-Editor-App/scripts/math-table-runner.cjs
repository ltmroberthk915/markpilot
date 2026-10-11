// Dedicated real desktop host, fresh profile and disposable user-note copies.
const {app}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const project=path.resolve(__dirname,'..');
const application=process.argv[2] ? path.resolve(process.argv[2]) : project;
const output=path.resolve(process.env.MATH_TABLE_OUTPUT||path.join(project,'.perf/math-table-current'));
fs.mkdirSync(output,{recursive:true});
// GUI processes can outlive their launcher pipe. Log locally and fail with a
// recorded stack instead of Electron's repeated uncaught-error message boxes.
for(const name of ['log','warn','error'])console[name]=(...args)=>fs.appendFileSync(path.join(output,'run.log'),args.map(x=>x?.stack||String(x)).join(' ')+'\n');
for(const event of ['uncaughtException','unhandledRejection'])process.on(event,error=>{fs.writeFileSync(path.join(output,'fatal.txt'),String(error?.stack||error));app.exit(1);});
app.setPath('userData',path.join(output,'profile'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.on('browser-window-created',(_event,window)=>{if(process.env.TEST_NATIVE_FOREGROUND!=='1')window.show=window.showInactive.bind(window);});
process.argv.splice(2);
const server=require(path.join(application,'app/main/server.js')),native=server.startServer;
server.startServer=options=>native({...options,port:0});
const rendererErrors=[];
// Listen before BrowserWindow creation, including blank iframe/preload startup.
app.on('web-contents-created',(_event,contents)=>{
  contents.on('console-message',event=>{if(event.level==='error'){const error={level:event.level,message:event.message,sourceId:event.sourceId,lineNumber:event.lineNumber};rendererErrors.push(error);fs.appendFileSync(path.join(output,'renderer-errors.log'),JSON.stringify(error)+'\n');}});
  contents.on('preload-error',(_event,preload,error)=>{const failure={preload,error:String(error.stack||error)};rendererErrors.push(failure);fs.appendFileSync(path.join(output,'renderer-errors.log'),JSON.stringify(failure)+'\n');});
});
require(path.join(application,'app/main/main.js'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  await app.whenReady();
  for(let i=0;i<300&&!global.win;i++)await pause(40);
  const win=global.win;if(!win)throw new Error('No desktop window');
  const nativeInput=win.webContents.sendInputEvent.bind(win.webContents);
  win.webContents.sendInputEvent=event=>{if(process.env.TEST_NATIVE_FOREGROUND==='1'&&!win.isFocused())win.focus();nativeInput(event);};
  for(let i=0;i<300;i++){try{if(await win.webContents.executeJavaScript('!!window.hostApi && document.readyState === "complete"'))break;}catch{}await pause(40);}
  await win.webContents.executeJavaScript("hostApi.invoke('boot')",true);
  const bootFile=path.join(output,'startup-note.md');fs.copyFileSync(path.join(project,'.backups/2026-09-08-math-table/user-note-original.md'),bootFile);
  await global.doc.openFile(bootFile);
  for(let i=0;i<300;i++){try{if(await win.webContents.executeJavaScript('!!document.getElementById("editor")?.contentWindow?.vditor?.vditor?.__typoraPatched'))break;}catch{}await pause(40);}
  const contexts=new Map();
  win.webContents.debugger.attach('1.3');
  win.webContents.debugger.on('message',(_event,method,params)=>{
    if(method==='Runtime.executionContextCreated')contexts.set(params.context.id,params.context);
    if(method==='Runtime.exceptionThrown'||method==='Runtime.consoleAPICalled'&&params.type==='error'){
      const error={method,params,context:contexts.get(params.executionContextId||params.exceptionDetails?.executionContextId)};
      rendererErrors.push(error);fs.appendFileSync(path.join(output,'renderer-errors.log'),JSON.stringify(error)+'\n');
    }
  });
  await win.webContents.debugger.sendCommand('Runtime.enable');
  if(process.env.TEST_NATIVE_FOREGROUND!=='1')await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await require('./math-table-matrix.cjs').run({win,output,application});
  if(rendererErrors.length)throw new Error(rendererErrors.length+' renderer/preload console error(s); see renderer-errors.log');
  if(process.env.MATH_TABLE_HOLD==='1'){console.log('Desktop retained for Computer Use');return;}
  win.destroy();app.exit(0);
})().catch(error=>{fs.writeFileSync(path.join(output,'fatal.txt'),String(error.stack));console.error(error);app.exit(1);});
