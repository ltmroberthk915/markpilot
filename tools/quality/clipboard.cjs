'use strict';
const path=require('node:path');
const {spawn}=require('node:child_process');
const {sleep}=require('./lifecycle.cjs');
async function bitmap(file) {
  if(process.platform!=='win32')throw new Error('Windows bitmap clipboard test requires Windows');
  const child=spawn(process.env.MP_PWSH || 'pwsh.exe',['-NoProfile','-NonInteractive','-STA','-File',path.join(__dirname,'windows-clipboard.ps1'),'-ImagePath',path.resolve(file)],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',error;
  child.on('error',e=>{error=e;});child.stdout.on('data',d=>{stdout+=d;});child.stderr.on('data',d=>{stderr+=d;});
  const restore=async()=>{
    child.stdin.end('restore\n');
    const limit=Date.now()+8000;
    while(child.exitCode==null&&Date.now()<limit)await sleep(100);
    if(child.exitCode!==0 || !stdout.includes('"restored":true'))throw new Error('Clipboard restoration failed: '+stderr);
    return {restored:true};
  };
  const limit=Date.now()+10000;
  while(!stdout.includes('"ready":true')&&Date.now()<limit) {
    if(error || child.exitCode!=null)throw error || new Error('Clipboard fixture failed: '+stderr);
    await sleep(100);
  }
  if(!stdout.includes('"ready":true')) { await restore();throw new Error('Clipboard fixture timed out'); }
  return {metadata:JSON.parse(stdout.split(/\r?\n/).find(l=>l.startsWith('{'))),restore};
}
module.exports={bitmap};
