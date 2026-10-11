// One-time migration through native IDE SecretStorage -> Electron safeStorage.
// API keys cross only an authenticated loopback bridge in memory; no key files.
const fs=require('node:fs'),path=require('node:path');
exports.readIDE=async(context,options)=>{
  const vscode=require('vscode'),{CompletionManager}=require(path.join(context.extensionPath,'out/completion/host.cjs'));
  // 2.1.23 起不再内置预置模型：迁移工具点名它要迁移的两份用户配置。
  const MODEL_PROFILES=[{id:'custom-glm',label:'GLM',protocol:'anthropic',baseUrl:'https://open.bigmodel.cn/api/anthropic',model:'glm-5.3-flash'},
    {id:'custom-ds',label:'DeepSeek',protocol:'anthropic',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash'}];
  try{
    const manager=new CompletionManager(context);await manager.ready;
    const glm=await manager.getAPIKey(MODEL_PROFILES[0]),ds=await manager.getAPIKey(MODEL_PROFILES[1]);
    if(!glm||!ds)throw new Error('Both saved platform keys are required');
    const response=await fetch(options.bridge+'/import',{method:'POST',headers:{'Content-Type':'application/json','X-Transfer-Nonce':options.nonce},body:JSON.stringify({glm,ds,settings:manager.config}),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('Local transfer failed');
  }catch(error){await fetch(options.bridge+'/error',{method:'POST',headers:{'Content-Type':'application/json','X-Transfer-Nonce':options.nonce},body:JSON.stringify({error:error.message})});}
  finally{await new Promise(resolve=>setTimeout(resolve,400));await vscode.commands.executeCommand('workbench.action.closeWindow');}
};
async function desktop(options){
  const {app}=require('electron');app.setName('markpilot');app.setPath('userData',options.userData);await app.whenReady();
  const headers={'Content-Type':'application/json','X-Transfer-Nonce':options.nonce};
  try{
    const response=await fetch(options.bridge+'/credentials',{method:'POST',headers,body:'{}'});if(!response.ok)throw new Error('Credentials unavailable');
    const data=await response.json();
    const {CompletionVault}=require('../app/main/completion-vault'),{AppState}=require('../app/main/state');
    const {CompletionManager}=require('../app/shared/out/completion/host.cjs');
    const MODEL_PROFILES=[{id:'custom-glm',label:'GLM',protocol:'anthropic',baseUrl:'https://open.bigmodel.cn/api/anthropic',model:'glm-5.3-flash'},
      {id:'custom-ds',label:'DeepSeek',protocol:'anthropic',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash'}];
    const state=new AppState(),context={subscriptions:[],secrets:new CompletionVault(),globalState:{get:k=>state.get(k),update:async(k,v)=>{state.set(k,v);state.saveNow();}}};
    const manager=new CompletionManager(context,{commands:{registerCommand:()=>({dispose(){}})}});await manager.ready;
    await manager.saveAPIKey(data.glm,MODEL_PROFILES[0]);await manager.saveAPIKey(data.ds,MODEL_PROFILES[1]);
    await manager.update({...data.settings,host:false});
    const result={configured:true,userData:options.userData,settings:manager.publicConfig};
    if(!result.settings.profiles.every(p=>p.keyAvailable))throw new Error('One provider did not persist');
    data.glm=data.ds='';
    await fetch(options.bridge+'/result',{method:'POST',headers,body:JSON.stringify(result)});app.exit(0);
  }catch(error){await fetch(options.bridge+'/error',{method:'POST',headers,body:JSON.stringify({error:error.message})});app.exit(1);}
}
async function main(){
  if(process.versions.electron){await desktop(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));return;}
  const project=path.resolve(__dirname,'..'),source=path.resolve(project,'../Typora-Editor/extension-src');
  const root=path.join(project,'.perf','completion-import-'+Date.now());fs.mkdirSync(root,{recursive:true});
  const userData=path.join(process.env.APPDATA,'markpilot');
  if(!fs.existsSync(path.join(userData,'state.json')))throw new Error('Existing desktop profile was not found');
  fs.copyFileSync(path.join(userData,'state.json'),path.join(root,'state-before.json'));
  let credentials,receive,finish,failure;
  const imported=new Promise((resolve,reject)=>{receive=resolve;failure=reject;});
  const completed=new Promise(resolve=>{finish=resolve;});
  const nonce=require('node:crypto').randomBytes(32).toString('hex');
  const server=require('node:http').createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    if(req.method!=='POST'||req.headers['x-transfer-nonce']!==nonce){res.writeHead(403);res.end('{}');return;}
    try{
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>32000)throw new Error('Body too large');}const body=JSON.parse(raw);
      if(req.url==='/import'&&body.glm&&body.ds&&!credentials){credentials=body;res.end('{}');receive();return;}
      if(req.url==='/credentials'&&credentials){res.end(JSON.stringify(credentials));return;}
      if(req.url==='/result'&&body.configured){
        const safe=JSON.stringify(body,null,2).replaceAll(credentials.glm,'[redacted]').replaceAll(credentials.ds,'[redacted]');
        fs.writeFileSync(path.join(root,'result.json'),safe);res.end('{}');finish(JSON.parse(safe));return;
      }
      if(req.url==='/error'){res.end('{}');failure(new Error('Native credential transfer failed'));finish({configured:false});return;}
      res.writeHead(400);res.end('{}');
    }catch{res.writeHead(400);res.end('{}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const options={bridge:'http://127.0.0.1:'+server.address().port,nonce,userData};
  const optionsFile=path.join(root,'options.json');fs.writeFileSync(optionsFile,JSON.stringify(options));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;for(const k of Object.keys(env))if(/TOKEN|SECRET|PASSWORD|API_?KEY|AUTH_KEY|CREDENTIAL/i.test(k))delete env[k];
  let timer,desktopChild;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Transfer timed out')),150000);});
  try{
    const development=path.join(root,'ide-reader');fs.cpSync(source,development,{recursive:true});
    const manifestFile=path.join(development,'package.json'),manifest=JSON.parse(fs.readFileSync(manifestFile));manifest.activationEvents=['*'];fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2));
    fs.appendFileSync(path.join(development,'out/extension.js'),'\nexports.activate=context=>require('+JSON.stringify(__filename)+').readIDE(context,'+JSON.stringify(options)+');\n');
    const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
    const spawn=require('node:child_process').spawn;
    spawn('D:\\Program Files\\Microsoft VS Code\\Code.exe',['--new-window','--skip-welcome','--skip-release-notes','--skip-add-to-recently-opened','--extensionDevelopmentPath='+development,workspace],{env,windowsHide:true,stdio:'ignore'});
    await Promise.race([imported,timeout]);
    console.log('Read existing IDE settings through native SecretStorage.');
    desktopChild=spawn(path.join(project,'node_modules/electron/dist/electron.exe'),[__filename,optionsFile],{env,windowsHide:true,stdio:'inherit'});
    const result=await Promise.race([completed,timeout]);if(!result.configured)throw new Error('Desktop configuration failed');
    console.log('Desktop configured: '+result.settings.model+'; both platform keys saved with native encryption.');console.log('Safe result: '+path.join(root,'result.json'));
  }finally{clearTimeout(timer);credentials=undefined;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(desktopChild&&desktopChild.exitCode===null)desktopChild.kill();}
}
if(require.main===module || process.versions.electron && process.type==='browser')main().catch(error=>{console.error(error.message);process.exitCode=1;});
