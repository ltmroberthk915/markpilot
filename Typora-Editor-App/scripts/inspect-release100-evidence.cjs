// Reads existing evidence only; does not launch applications or edit the note.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const project=path.resolve(__dirname,'..'),output=path.resolve(process.argv[2]||path.join(project,'.perf/release100-background'));
fs.mkdirSync(output,{recursive:true});
const read=file=>JSON.parse(fs.readFileSync(file,'utf8')),hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const beforeRoot=path.join(project,'.perf/release100-perf-before-v3'),afterRoot=path.join(project,'.perf/release100-perf-after-v1');
const before=read(path.join(beforeRoot,'benchmark.json')),after=read(path.join(afterRoot,'benchmark.json'));
const key=x=>[x.name,x.mode,x.caret].join('/');
assert.equal(before.samples.length,12);assert.equal(after.samples.length,12);assert.equal(new Set(before.samples.map(key)).size,12);assert.equal(new Set(after.samples.map(key)).size,12);
const comparisons=before.samples.map(b=>{
 const a=after.samples.find(a=>key(a)===key(b));assert.ok(a);assert.equal(a.chars,b.chars);assert.deepEqual(a.errors,[]);assert.deepEqual(b.errors,[]);assert.equal(a.sourceUnchanged,true);assert.equal(b.sourceUnchanged,true);
 assert.equal(a.offset,b.offset,'Anchor offset changed: '+key(b));assert.equal(a.anchorKind,b.anchorKind,'Anchor block changed: '+key(b));
 assert.equal(hash(path.join(beforeRoot,b.name+'.md')),hash(path.join(afterRoot,b.name+'.md')),'Benchmark fixture changed');
 assert.equal(a.times.length,8);assert.equal(b.times.length,8);
 return{scenario:key(b),chars:b.chars,anchor:{kind:b.anchorKind,offset:b.offset},beforeMedianMs:b.medianMs,afterMedianMs:a.medianMs,reductionPercent:100*(1-a.medianMs/b.medianMs),beforeSamplesMs:b.times,afterSamplesMs:a.times};
});
for(const root of [beforeRoot,afterRoot])assert.equal(fs.existsSync(path.join(root,'fatal.txt')),false,'Failed benchmark directory');
const sameAnchorAcrossCaretLabels=after.samples.filter(a=>a.caret==='visible').filter(a=>after.samples.some(b=>b.name===a.name&&b.mode===a.mode&&b.caret==='offscreen'&&b.offset===a.offset&&b.anchorKind===a.anchorKind)).map(a=>a.name+'/'+a.mode);
const performance={checkedAt:new Date().toISOString(),scope:'Previously recorded anchor-capture mapping measurements, not total startup or end-to-end UI latency',before:path.join(beforeRoot,'benchmark.json'),after:path.join(afterRoot,'benchmark.json'),allAnchorOffsetsEqual:true,comparisons,sameAnchorAcrossCaretLabels,finalAcceptance:false,limitations:['The prior script did not assert that a newly opened document version was ready or that the caret geometry matched the visible/offscreen label.','The prepared benchmark now records document identity, active Markdown hash and caret rectangles; both builds require fresh GUI measurements.']};
fs.writeFileSync(path.join(output,'performance-comparison.json'),JSON.stringify(performance,null,2));
const log=fs.readFileSync(path.resolve(project,'../Typora-Editor/test/.runs/release100-focus-matrix-trae3.log'),'utf8');
const root=log.match(/Isolated VSCode test output: ([^\r\n]+)/)?.[1];assert.ok(root);const evidence=read(path.join(root,'native-focus-evidence.json'));
assert.equal(evidence.records.length,24);assert.equal(evidence.basic,6);assert.equal(evidence.edge,18);
for(const record of evidence.records){assert.equal(record.documentUnchanged,true);assert.deepEqual(record.errors,[]);}
assert.deepEqual(read(path.join(root,'webview-errors.json')),[]);assert.deepEqual(read(path.join(root,'unhandled-errors.json')),[]);
const results=read(path.join(root,'results.json'));assert.equal(results.results.length,29);
const focus={checkedAt:new Date().toISOString(),scope:'Trae run recorded before the user paused; newer host and renderer guards still require final IDE regression',host:evidence.host,root,scenarios:24,basic:6,edge:18,bootstrapChecks:5,documentUnchanged:true,recordedRuntimeErrors:0,finalAcceptance:false,limitations:['The prior run reused deterministic typing markers in an existing profile. The prepared matrix now requires a fresh run UUID and absence before insertion to rule out stale-draft false positives.']};
fs.writeFileSync(path.join(output,'prior-trae-focus.json'),JSON.stringify(focus,null,2));
const markdown=['# 已记录性能数据核对','','仅作阶段参考，不作为最终性能验收。只核对暂停前产生的数据；本脚本没有启动编辑器。测量对象是源码切换前的锚点映射，不代表整个应用的启动或输入速度。每组预热后取 7 次测量的中位数。两轮相同 Markdown 副本、字符数、锚点种类和源偏移均已核对一致。','','| 文档 / 模式 / 操作 | 优化前 ms | 优化后 ms | 降低 |','|---|---:|---:|---:|',...comparisons.map(r=>`| ${r.scenario} | ${r.beforeMedianMs.toFixed(2)} | ${r.afterMedianMs.toFixed(2)} | ${r.reductionPercent.toFixed(1)}% |`),'','visible/offscreen 是测试中“先定位”和“随后滚到顶端”的操作标签。原脚本没有断言新文档版本已就绪，也没有断言光标矩形可见性。以下两种标签落在相同锚点：'+sameAnchorAcrossCaretLabels.join('、')+'；不能据此声称实际覆盖了可见光标和屏外光标两个分支。','','已为后续脚本补入新文档版本、当前 Markdown 哈希及光标矩形检查；增强后的脚本尚未运行。恢复桌面测试后，基线和优化版本须按相同增强脚本重新测量，再完成全量定位回归。',''];
fs.writeFileSync(path.join(output,'performance-comparison.md'),markdown.join('\n'));
console.log(JSON.stringify({mappingSamples:comparisons.length,allAnchorOffsetsEqual:true,reductionRangePercent:[Math.min(...comparisons.map(r=>r.reductionPercent)),Math.max(...comparisons.map(r=>r.reductionPercent))],priorTrae:focus,output},null,2));
