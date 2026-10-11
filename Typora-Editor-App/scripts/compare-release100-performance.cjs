const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const [beforeDir,afterDir,outputDir]=process.argv.slice(2).map(x=>path.resolve(x));
if(!outputDir)throw Error('Specify before, after and report directories');
const read=dir=>JSON.parse(fs.readFileSync(path.join(dir,'benchmark.json'),'utf8'));
const before=read(beforeDir),after=read(afterDir),key=s=>[s.name,s.mode,s.caret].join('/');
assert.equal(before.samples.length,12);assert.equal(after.samples.length,12);
assert.equal(new Set(before.samples.map(key)).size,12);assert.equal(new Set(after.samples.map(key)).size,12);
const comparisons=before.samples.map(b=>{
  const a=after.samples.find(s=>key(s)===key(b));assert.ok(a);
  for(const s of [b,a]){
    assert.equal(s.times.length,8);assert.ok(s.times.every(n=>Number.isFinite(n)&&n>=0));
    assert.equal(s.medianMs,s.times.slice(1).sort((x,y)=>x-y)[3]);
    assert.equal(s.documentVersion,s.geometry.documentVersion);assert.equal(s.geometry.caretVisible,s.caret==='visible');
    assert.ok(s.fixtureSHA256&&s.activeMarkdownSHA256);assert.equal(s.sourceUnchanged,true);assert.deepEqual(s.errors,[]);
  }
  for(const field of ['fixtureSHA256','activeMarkdownSHA256','chars','offset','anchorKind'])assert.equal(a[field],b[field],key(b)+' '+field);
  return{scenario:key(b),chars:b.chars,anchor:{offset:b.offset,kind:b.anchorKind},beforeMs:b.medianMs,afterMs:a.medianMs,reductionPercent:100*(1-a.medianMs/b.medianMs)};
});
for(const dir of [beforeDir,afterDir]){assert.equal(fs.existsSync(path.join(dir,'fatal.txt')),false);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'task.json'))).passed,true);}
const report={checkedAt:new Date().toISOString(),before:beforeDir,after:afterDir,applicationBefore:before.application,applicationAfter:after.application,comparisons,
  scope:'Warm visual-anchor mapping only; document identity, active Markdown, actual caret visibility and source offsets all verified. Full application regression and packaged acceptance remain separate.'};
fs.mkdirSync(outputDir,{recursive:true});fs.writeFileSync(path.join(outputDir,'performance.json'),JSON.stringify(report,null,2));
const md=['# 重新验证的锚点映射性能','','基线为冻结的 1.0.18 ASAR，优化版本的实际执行路径记录在 performance.json。每组测量 8 次，剔除首轮后取中位数。两个版本的夹具、实际 Markdown 哈希、字符数、锚点种类和源偏移一致；文档版本及屏内/屏外光标矩形断言均通过。','','| 场景 | 基线 ms | 当前 ms | 降低 |','|---|---:|---:|---:|',...comparisons.map(r=>`| ${r.scenario} | ${r.beforeMs.toFixed(2)} | ${r.afterMs.toFixed(2)} | ${r.reductionPercent.toFixed(1)}% |`),'','以上为锚点映射局部耗时，不代表完整启动或输入速度。完整交互回归、大文件操作及最终包验收另行记录。',''];
fs.writeFileSync(path.join(outputDir,'PERFORMANCE.md'),md.join('\n'));
console.log(JSON.stringify({pairs:comparisons.length,sourceAndAnchorsEqual:true,actualCaretVisibilityVerified:true,reductionPercentRange:[Math.min(...comparisons.map(r=>r.reductionPercent)),Math.max(...comparisons.map(r=>r.reductionPercent))],outputDir},null,2));
