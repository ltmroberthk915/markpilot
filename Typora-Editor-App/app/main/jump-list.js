'use strict';
const path=require('node:path'),fs=require('node:fs/promises'),crypto=require('node:crypto');
const APP_ID='app.personal.markpilot',LIMIT=15;
const key=file=>path.resolve(file).toLowerCase();

// Shell links use Windows command-line quoting, not a shell or PowerShell.
function quoteArgument(value) {return '"'+String(value).replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')+'"';}
function commandLine(args) {return args.map(quoteArgument).join(' ');}
function launcherFor(app,{executable=process.execPath,env=process.env}={}) {
  const program=app.isPackaged && env.PORTABLE_EXECUTABLE_FILE ? env.PORTABLE_EXECUTABLE_FILE : executable;
  const args=app.isPackaged?[]:[app.getAppPath()];
  const profile=app.commandLine.getSwitchValue('user-data-dir');
  if(profile)args.push('--user-data-dir='+path.resolve(profile));
  // Explicit alternate profiles have independent pins and task histories.
  const id=profile ? APP_ID+'.profile.'+crypto.createHash('sha256').update(key(profile)).digest('hex').slice(0,12) : APP_ID;
  return {program:path.resolve(program),args,id};
}
function buildJumpList(recent,launcher) {
  const seen=new Set(),files=[];
  for(const file of recent) {
    if(typeof file!=='string'||!file.trim()||seen.has(key(file)))continue;
    seen.add(key(file));files.push(path.resolve(file));if(files.length===LIMIT)break;
  }
  const names=new Map();for(const file of files){const name=path.basename(file).toLowerCase();names.set(name,(names.get(name)||0)+1);}
  const item=(title,args,description)=>({type:'task',title,program:launcher.program,args:commandLine([...launcher.args,...args]),iconPath:launcher.program,iconIndex:0,description:description.slice(0,259)});
  const items=files.map(file=>item(names.get(path.basename(file).toLowerCase())>1 ? path.basename(file)+' — '+path.dirname(file) : path.basename(file),['--',file],file));
  if(items.length)items.push({type:'separator'});
  items.push(item('新建 Markdown 文件',['--new-md'],'选择保存位置并新建 Markdown 文件'));
  // User Tasks are not subject to Windows' Recent/Frequent destination limit.
  // These are explicit application shortcuts built from our own recent list.
  return [{type:'tasks',items}];
}

class JumpListController {
  constructor({app,state,launcher,enabled=process.platform==='win32'&&app.isPackaged,stat=fs.stat,statTimeout=750}) {
    Object.assign(this,{app,state,launcher,enabled,stat,statTimeout});this.timer=null;this.pending=null;this.version=0;this.applied=0;this.last='';this.lastRefresh=0;this.disposed=false;
  }
  changed() {
    if(!this.enabled||this.disposed)return;
    this.version++;clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=null;this.flush().catch(error=>console.error('Jump List:',error.message));},200);
  }
  focus() {if(Date.now()-this.lastRefresh>30000)this.changed();}
  async flush() {
    if(!this.enabled||this.disposed)return;
    clearTimeout(this.timer);this.timer=null;
    if(this.pending)return this.pending;
    this.pending=(async()=>{
      while(!this.disposed && this.applied!==this.version) {
        const version=this.version,seen=new Set();
        const recent=this.state.recent().recentFiles.filter(file=>{
          if(typeof file!=='string'||!file.trim()||seen.has(key(file)))return false;seen.add(key(file));return true;
        });
        const valid=await Promise.all(recent.map(async file=>{
          // Disconnected drives must not delay closing the editor indefinitely.
          let timer;
          try{return await Promise.race([
            Promise.resolve().then(()=>this.stat(file)).then(st=>st.isFile()?file:null,()=>null),
            new Promise(resolve=>{timer=setTimeout(()=>resolve(null),this.statTimeout);})
          ]);}finally{clearTimeout(timer);}
        }));
        if(this.disposed)return;
        if(version!==this.version)continue;
        const categories=buildJumpList(valid.filter(Boolean),this.launcher),signature=JSON.stringify(categories);
        if(signature!==this.last) {
          const result=this.app.setJumpList(categories);
          if(result==='ok')this.last=signature;
          else console.error('Jump List update:',result);
          this.result=result;
        }
        this.applied=version;this.lastRefresh=Date.now();
      }
    })().catch(error=>{
      // A shell/COM failure is retried on the next change or focus. Consume this
      // attempt so before-quit cannot spin forever if Explorer rejects the list.
      this.applied=this.version;this.lastRefresh=Date.now();this.result='error';
      console.error('Jump List:',error.message);
    }).finally(()=>{this.pending=null;});
    return this.pending;
  }
  get needsFlush(){return this.enabled&&!this.disposed&&(this.applied!==this.version||!!this.pending);}
  dispose(){this.disposed=true;clearTimeout(this.timer);this.timer=null;}
}
module.exports={APP_ID,LIMIT,quoteArgument,commandLine,launcherFor,buildJumpList,JumpListController};
