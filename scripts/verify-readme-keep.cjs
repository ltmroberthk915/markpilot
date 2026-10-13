'use strict';
// Verify additions against an explicit pre-edit copy, including pre-existing local changes.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const opts={},argv=process.argv.slice(2);
for(let i=0;i<argv.length;i+=2){assert(['--baseline','--out'].includes(argv[i])&&argv[i+1]&&!opts[argv[i]],'Use --baseline <pre-edit directory> [--out <receipt>]');opts[argv[i]]=argv[i+1];}
assert(opts['--baseline'],'An explicit pre-edit baseline is required');
const root=path.resolve(__dirname,'..'),baseline=fs.realpathSync(opts['--baseline']);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const result={schema:1,passed:false,at:new Date().toISOString(),baseline,files:[]};
for(const name of ['README.md','README.en.md']){
 const before=fs.readFileSync(path.join(baseline,name)),after=fs.readFileSync(path.join(root,name));
 const oldLines=before.toString('utf8').split(/\r?\n/),newLines=after.toString('utf8').split(/\r?\n/);
 let cursor=0;
 for(const line of oldLines){while(cursor<newLines.length&&newLines[cursor]!==line)cursor++;assert(cursor<newLines.length,'Old README content removed or reordered: '+name);cursor++;}
 result.files.push({file:name,beforeSha256:hash(before),afterSha256:hash(after),oldLines:oldLines.length,newLines:newLines.length,addedLines:newLines.length-oldLines.length,allOriginalLinesRetainedInOrder:true});
}
result.passed=true;
if(opts['--out'])fs.writeFileSync(path.resolve(opts['--out']),JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify(result));
