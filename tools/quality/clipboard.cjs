'use strict';
const path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {sleep}=require('./lifecycle.cjs');
async function preserve(file) {
  if(process.platform!=='win32')throw new Error('Windows bitmap clipboard test requires Windows');
  const child=spawn(process.env.MP_PWSH || 'pwsh.exe',['-NoProfile','-NonInteractive','-STA','-File',path.join(__dirname,'windows-clipboard.ps1'),...(file?['-ImagePath',path.resolve(file)]:[])],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',error;
  child.on('error',e=>{error=e;});child.stdout.on('data',d=>{stdout+=d;});child.stderr.on('data',d=>{stderr+=d;});
  const restore=async()=>{
    child.stdin.end('restore\n');
    const limit=Date.now()+8000;
    while(child.exitCode==null&&Date.now()<limit)await sleep(100);
    if(child.exitCode!==0 || !stdout.includes('"restored":true'))throw new Error('Clipboard restoration failed: '+stderr);
    return {restored:true};
  };
  // Windows may materialize delayed clipboard formats from another process.
  // Keep the same owned helper alive until ready; a startup timeout is not a paste verdict.
  const limit=Date.now()+30000;
  while(!stdout.includes('"ready":true')&&Date.now()<limit) {
    if(error || child.exitCode!=null)throw error || new Error('Clipboard fixture failed: '+stderr);
    await sleep(100);
  }
  if(!stdout.includes('"ready":true')) { await restore();throw new Error('Clipboard fixture timed out'); }
  return {metadata:JSON.parse(stdout.split(/\r?\n/).find(l=>l.startsWith('{'))),restore};
}
const bitmap = file => preserve(file);
const hold = () => preserve();
function verifyText(expected) {
  if(process.platform!=='win32')throw new Error('Windows clipboard verification requires Windows');
  // Read in a separate STA process. Never return, print or store unexpected
  // clipboard contents, which could belong to the user or another program.
  const script="Add-Type -AssemblyName System.Windows.Forms; $observed=[System.Windows.Forms.Clipboard]::GetText(); @{matches=($observed -ceq $env:MP_QUALITY_CLIPBOARD_TEXT);length=$observed.Length}|ConvertTo-Json -Compress";
  return JSON.parse(execFileSync(process.env.MP_PWSH||'pwsh.exe',['-NoProfile','-NonInteractive','-STA','-Command',script],{encoding:'utf8',windowsHide:true,timeout:10000,env:{...process.env,MP_QUALITY_CLIPBOARD_TEXT:expected}}));
}
function verifyBitmap(file,{meanTolerance=0}={}) {
  if(process.platform!=='win32')throw new Error('Windows clipboard verification requires Windows');
  if(!Number.isFinite(meanTolerance)||meanTolerance<0||meanTolerance>2)throw new Error('Invalid pixel tolerance');
  return JSON.parse(execFileSync(process.env.MP_PWSH||'pwsh.exe',['-NoProfile','-NonInteractive','-STA','-File',path.join(__dirname,'windows-clipboard-check.ps1'),'-ImagePath',path.resolve(file),'-MeanTolerance',String(meanTolerance)],{encoding:'utf8',windowsHide:true,timeout:15000}));
}
function verifyHtml(expected) {
  const script="Add-Type -AssemblyName System.Windows.Forms; $observed=[string][System.Windows.Forms.Clipboard]::GetData([System.Windows.Forms.DataFormats]::Html); @{matches=$observed.Contains($env:MP_QUALITY_CLIPBOARD_HTML);length=$observed.Length}|ConvertTo-Json -Compress";
  return JSON.parse(execFileSync(process.env.MP_PWSH||'pwsh.exe',['-NoProfile','-NonInteractive','-STA','-Command',script],{encoding:'utf8',windowsHide:true,timeout:10000,env:{...process.env,MP_QUALITY_CLIPBOARD_HTML:expected}}));
}
module.exports={bitmap,hold,verifyText,verifyHtml,verifyBitmap};
