// One-time local setup through the IDE's normal SecretStorage API. No keys are
// written to this script, result files, child-process arguments or environment.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.activateSetup = async function(context, options) {
  const vscode = require('vscode');
  const {CompletionManager} = require(path.join(context.extensionPath, 'out/completion/host.cjs'));
  // 2.1.23 起不再内置预置模型（用户要求不要预设过多、且要能自己删）：本脚本自带 profile。
  const MODEL_PROFILES=[{id:'custom-glm',label:'GLM',protocol:'anthropic',baseUrl:'https://open.bigmodel.cn/api/anthropic',model:'glm-5.3-flash'},
    {id:'custom-ds',label:'DeepSeek',protocol:'anthropic',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash'}];
  const manager = new CompletionManager(context);
  const exchange = async (route, body) => {
    const response = await fetch(options.bridge + route, {method:'POST', headers:{'Content-Type':'application/json','X-Setup-Nonce':options.nonce}, body:JSON.stringify(body), signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('Local setup bridge failed ('+response.status+')');
    return response.json();
  };
  const result = {host:options.host, version:context.extension.packageJSON.version, configured:false, models:[]};
  try {
    await manager.ready;
    if(options.host==='Trae') {
      const glm = await manager.getAPIKey(MODEL_PROFILES[0]);
      if(!glm)throw new Error('No saved GLM key is available in the ordinary Trae profile');
      await exchange('/glm', {key:glm});
    }
    const credentials = await exchange('/credentials', {});
    if(!credentials.glm || !credentials.ds)throw new Error('Both platform credentials are required');
    await manager.saveAPIKey(credentials.glm, MODEL_PROFILES[0]);
    await manager.saveAPIKey(credentials.ds, MODEL_PROFILES[2]);
    credentials.glm = credentials.ds = '';
    await manager.update({...manager.config, ...MODEL_PROFILES[3], local:true, ai:true, automaticAI:true, cursorSuggestions:true, delay:650});
    result.configured = true;
    result.settings = manager.publicConfig;
    if(options.host==='Trae') {
      const {requestAI} = require(path.join(context.extensionPath, 'out/completion/core.cjs'));
      const payload = {kind:'math', intent:'continuation', heading:'求导', before:'已知 $f(x)=x^2$，则 $f\'(x)=', after:'$。', mathBefore:'f\'(x)=', mathAfter:'', nearby:'补写这个导数的结果。'};
      for(const profile of MODEL_PROFILES) {
        const row = {id:profile.id, requestedModel:profile.model};const started = Date.now();
        try {
          row.text = await requestAI({...manager.config,...profile}, await manager.getAPIKey(profile), payload, AbortSignal.timeout(15000), async (url, options) => {
            const response = await fetch(url, options);row.http = response.status;
            if(response.ok)row.returnedModel = (await response.clone().json()).model;
            return response;
          });
          row.ok = row.returnedModel === profile.model && !!row.text;
        } catch(error) {row.ok=false;row.error=error.name==='TimeoutError'?'Request timed out':error.message;}
        row.elapsedMs=Date.now()-started;result.models.push(row);
      }
    }
  } catch(error) {result.error=error.message;}
  finally {
    await exchange('/result', result);
    await pause(400);
    await vscode.commands.executeCommand('workbench.action.closeWindow');
  }
};

if(require.main===module) (async () => {
  const ds = process.env.MD_EDITOR_SETUP_DS_KEY;
  if(!ds)throw new Error('Provide MD_EDITOR_SETUP_DS_KEY only to this local parent process');
  delete process.env.MD_EDITOR_SETUP_DS_KEY;
  const root = path.resolve(process.argv[2] || 'test/.runs/completion-configure-'+Date.now());
  const source = path.resolve(process.argv[3] || 'extension-src');
  fs.mkdirSync(root,{recursive:true});
  const nonce = crypto.randomBytes(32).toString('hex');
  let glm = '', activeHost = '', completed;
  const results = [];
  const server = require('node:http').createServer(async (req,res) => {
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    if(req.method!=='POST'||req.headers['x-setup-nonce']!==nonce){res.writeHead(403);return res.end('{}');}
    try {
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>32000)throw new Error('Body too large');}
      const body=JSON.parse(raw);
      if(req.url==='/glm'&&activeHost==='Trae'&&typeof body.key==='string'&&body.key.length>8){glm=body.key;return res.end('{}');}
      if(req.url==='/credentials'&&activeHost&&glm)return res.end(JSON.stringify({glm,ds}));
      if(req.url==='/result'&&body.host===activeHost){
        // Defense in depth: never persist credentials even if the driver sends
        // unexpected diagnostic text.
        const safe=JSON.stringify(body).replaceAll(ds,'[redacted]').replaceAll(glm||'__NO_KEY__','[redacted]');
        fs.writeFileSync(path.join(root,activeHost+'.json'),safe);results.push(JSON.parse(safe));
        res.end('{}');completed?.();return;
      }
      res.writeHead(400);res.end('{}');
    } catch {res.writeHead(400);res.end('{}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const bridge = 'http://127.0.0.1:'+server.address().port;
  try {
    for(const [host, executable] of [['Trae','C:\\Users\\Ming\\AppData\\Local\\Programs\\Trae\\Trae.exe'],['VS Code','D:\\Program Files\\Microsoft VS Code\\Code.exe']]) {
      activeHost=host;const development=path.join(root,host.replaceAll(' ','-')+'-setup');
      fs.cpSync(source,development,{recursive:true});
      const manifestPath=path.join(development,'package.json');const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
      manifest.activationEvents=['*'];fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2));
      const options={host,bridge,nonce};
      fs.appendFileSync(path.join(development,'out/extension.js'),'\nexports.activate=context=>require('+JSON.stringify(__filename)+').activateSetup(context,'+JSON.stringify(options)+');\n');
      const workspace=path.join(root,'workspace-'+host.replaceAll(' ','-'));fs.mkdirSync(workspace,{recursive:true});
      const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
      for(const name of Object.keys(env))if(/(?:TOKEN|SECRET|PASSWORD|API_?KEY|AUTH_KEY|CREDENTIAL)/i.test(name))delete env[name];
      let timeout;
      const done = new Promise((resolve,reject)=>{completed=resolve;timeout=setTimeout(()=>reject(new Error(host+' setup timed out')),150000);});
      const child = require('node:child_process').spawn(executable,['--new-window','--skip-welcome','--skip-release-notes','--skip-add-to-recently-opened','--extensionDevelopmentPath='+development,workspace],{env,windowsHide:true,stdio:'ignore'});
      const closed = new Promise(resolve=>child.once('exit',resolve));
      child.once('error',()=>completed?.());
      try {await done;} finally {clearTimeout(timeout);completed=undefined;}
      if(results.at(-1)?.host!==host||!results.at(-1)?.configured)throw new Error(host+' setup failed; see safe result file');
      console.log(host+': configured '+results.at(-1).settings.model+'; both platform keys available');
      await Promise.race([closed,pause(4000)]);
    }
    fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(results,null,2));
    console.log('Setup results: '+root);
  } finally {activeHost='';glm='';server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
