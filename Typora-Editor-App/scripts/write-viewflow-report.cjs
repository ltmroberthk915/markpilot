const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const project=path.resolve(__dirname,'..'),root=path.join(project,'.perf/viewflow-final-v8-accepted'),delivery=path.join(project,'.perf/viewflow-delivery');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8')),hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const coherence=read(path.join(delivery,'coherence.json')),runs=read(path.join(root,'results.json')),ide=read(path.join(root,'ide-results.json'));
assert.equal(coherence.verified,true);assert.equal(coherence.rendererFiles,479);assert.equal(runs.length,8);assert.ok(runs.every(r=>r.code===0));assert.equal(ide.length,3);assert.ok(ide.every(r=>r.code===0));
for(const artifact of coherence.artifacts)assert.equal(hash(artifact.path),artifact.sha256,'Artifact changed after verification');
const suites=[['嵌套格式中的公式独立展开','nested-math',24],['分屏进入、双向滚动、分隔条及性能','viewflow',60],['原有源码/渲染点击定位','navigation',63],['原始复杂表格与数学快捷键矩阵','math-table',68],['原始 Markdown 选区映射','chat-selection',110]].map(([label,dir,count])=>{
  const file=path.join(root,dir,'results.json'),r=read(file);assert.equal(r.failed,0);assert.equal(r.cases.length,count);assert.ok(r.cases.every(c=>c.status==='PASS'));return{label,dir,count,file,data:r};
});
for(const r of ide){assert.equal(r.checks,r.name==='vscode-full'?150:25);assert.equal(read(path.join(r.location,'webview-errors.json')).length,0);assert.equal(read(path.join(r.location,'unhandled-errors.json')).length,0);}
const manualExe=path.resolve(process.argv[2]||''),manualTrae=path.resolve(process.argv[3]||'');
const exe=read(path.join(manualExe,'manual-verified.json')),observer=read(path.join(manualExe,'observer.json')),trae=read(path.join(manualTrae,'manual-verified.json')),receipts=read(path.join(manualTrae,'native-receipts.json'));
assert.equal(exe.verified,true);assert.equal(trae.verified,true);assert.equal(observer.exitCode,0);assert.equal(observer.runtimeErrorCount,0);assert.equal(read(path.join(manualExe,'runtime-errors.json')).length,0);assert.equal(receipts.errors.length,0);assert.ok(receipts.newCalls.length>0&&receipts.newCalls.every(c=>c.finished&&!c.error));
assert.equal(read(path.join(manualTrae,'exit.json')).code,0);
assert.equal(exe.asarSHA256,coherence.artifacts.find(a=>a.path.endsWith('app.asar')).sha256);
const flow=suites.find(s=>s.dir==='viewflow').data.cases;
const performance=['blocks','ratio'].map(quality=>({quality,...flow.find(c=>c.name==='large-'+quality+'-entry-and-degradation').details,scroll:flow.find(c=>c.name==='large-'+quality+'-both-wheel-directions-and-cache').details}));
const slash=value=>value.replaceAll('\\','/'),link=(label,file)=>`[${label}](${slash(file)})`,beijing=date=>new Date(date).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const lines=[
  '# MarkPilot 私版 1.0.18 / 0.1.28-local 验收记录',
  '',
  '本轮完成分屏三项需求、IDE 原生 AI 选区协作，以及加粗等嵌套格式中公式源码连带展开和黑底的问题。EXE 与 VSIX 的 479 个共享渲染文件逐一校验一致；新增 IDE 宿主代码和命令也与最终 VSIX 一致。Alt+U 由编辑器自身接收，不拦截其他侧栏的快捷键。公开版四个产物哈希与本轮开始时一致。',
  '',
  '切换源码/渲染双屏时保留当前可见编辑位置；纯阅读、旧光标在屏外时保留阅读位置。左右两侧滚动对应移动；拖动中央分隔条会重新排版，宽度会记住，分隔条也支持方向键和双击复位。小文件使用精确对应；超过 150000 字符使用段落/单元格对应；超过 900000 字符使用比例同步。连续滚动复用映射缓存，不逐次解析整篇文档。外部文档刷新、查找和继续输入会及时释放切换时保留的位置，避免旧位置将新输入拉回行首；该问题加入分屏回归，并验证三种模式的补全、中文输入法和撤销。',
  '',
  'Trae 和 VS Code 中，在正文、表格、公式或代码中选中文字后按 Alt+U，可将对应文件及行列范围加入原生 AI 输入区。命令面板也提供“MarkPilot: 将选区加入 AI 对话”。待同步的输入会先完成同步，未保存内容可作为上下文；附件操作不自动提交提示词，不为匹配位置重写 Markdown。验证包含重复单元格、反向和跨段选区、内嵌图片后的偏移、源码视图的表格空格差异及刚输入的中文/emoji。Ctrl+U 下划线功能保留。',
  '',
  '公式黑底问题由外层格式的展开选择器波及后代数学标记引起，现按每个公式自身的状态显示源码。普通加粗、斜体、链接等文本的焦点不会误激活同一容器里的第一条公式。对原笔记 RN 导数段及其正文/表格变体逐个打开公式、再次点击预览、离开公式、执行快捷键往返进行验证。选区映射另修复了 HTML 实体和下划线隐藏标签造成的偏移。',
  '',
  '| 最终包验证 | 结果 | 证据 |','|---|---:|---|',
  ...suites.map(s=>`| ${s.label} | ${s.count} / ${s.count} | ${link('详细结果',s.file)} |`),
  '| 源位置解析单元测试 | 10 / 10 | '+link('日志',path.join(root,'markdown-locations.log'))+' |',
  '| 宿主源码切换与数学历史回归 | 通过 | '+link('切换',path.join(root,'source-toggle-host.log'))+'；'+link('历史',path.join(root,'math-history.log'))+' |',
  ...ide.map(r=>`| ${r.name}（真实 IDE，提取最终 VSIX） | ${r.checks} 项通过 | ${link('结果',path.join(r.location,'results.json'))} |`),
  '',
  '原始数学/表格矩阵共 '+suites.find(s=>s.dir==='math-table').data.events+' 个步骤；嵌套公式组合共 '+suites.find(s=>s.dir==='nested-math').data.cases.reduce((n,c)=>n+c.steps,0)+' 个步骤。除数学历史使用共享 renderer 测试宿主外，上表桌面交互套件运行在最终 app.asar 的真实主进程、preload 和编辑 iframe 上。自动回归在独立窗口以 Chromium 输入事件运行；最终可执行文件和 Trae 另经 Computer Use 鼠标、滚轮、拖动、键盘人工操作复核。',
  '',
  '| 大文件 | 降级方式 | 首次切换耗时 | 最慢滚动同步 | 滚动时重建/重新解析 |','|---|---|---:|---:|---|',
  ...performance.map(p=>`| ${p.chars} 字符 / ${p.bytes} 字节 | ${p.quality==='blocks'?'块对应':'比例对应'} | ${(p.entryMs/1000).toFixed(2)} s | ${p.scroll.after.maxScrollSyncMs.toFixed(2)} ms | 无 |`),
  '',
  '本轮捕获范围内，编辑器 renderer/preload 与扩展测试的 JavaScript 异常、未处理 Promise 拒绝均为 0。该结论限定于已执行的测试，不把 IDE 其他内置组件的日志算作 MarkPilot 异常。',
  '',
  '人工复核：'+link('最终 portable EXE',path.join(manualExe,'manual-verified.json'))+'；'+link('Trae 真实 Alt+U',path.join(manualTrae,'manual-verified.json'))+'；'+link('原生附件回执',path.join(manualTrae,'native-receipts.json'))+'。',
  '',
  '截图：'+link('原段落公式预览再次点击',path.join(manualExe,'01-rn-preview-reclick.png'))+'；'+link('表格内切换单元格后正常渲染',path.join(manualExe,'06-table-cell-exit.png'))+'；'+link('拖动分隔条',path.join(manualExe,'04-divider-wider-preview.png'))+'；'+link('Trae 原生附件',path.join(manualTrae,'02-header-attached.png'))+'。',
  '',
  '测试使用笔记副本。原始文件 D:/Users/Ming/Desktop/实用经济与金融理论/1-重识概率论.md 在用户工作期间有更新：复杂矩阵保留较早快照，人工 EXE 复核使用 14:37 的较新快照。未将副本覆盖回原文件。当前 live hash 与各测试快照分别记录在 '+link('同源及文件校验',path.join(delivery,'coherence.json'))+'，不声称原文件仍与初始快照一致。',
  '',
  '| 私版产物 | 北京时间 | SHA-256 |','|---|---|---|',
  ...coherence.artifacts.map(a=>`| ${link(path.basename(a.path),a.path)} | ${beijing(a.modified)} | \`${a.sha256}\` |`),
  '',
  '过程中未通过的检查均保留证据：公式点击测试曾收到脚本未输入的“类似”，随后自动回归改为后台输入隔离并整轮重跑；Alt+U 的 HTML 实体、原始表格空格和下划线映射问题经修正后加入覆盖。人工操作另发现 Windows 辅助输入只有键值、没有扫描码时 Alt+U 被漏掉，已补键值回退并在三个编辑模式验证。代码块分屏用例曾把被预览层覆盖的坐标误当成编辑光标，现通过真实方向键定位、核对切换前光标，并在原失败窗口尺寸复核通过。最终验收只依据上列全部通过的包和记录。',
  '',
];
const report=path.join(project,'docs/CHANGE-REPORT-PRIVATE-VIEWFLOW-1.0.18.md');fs.writeFileSync(report,lines.join('\n'));
const accepted={acceptedAt:new Date().toISOString(),versions:{exe:'1.0.18',vsix:'0.1.28-local'},report,coherence:path.join(delivery,'coherence.json'),runs,ide,suites:suites.map(({data,...s})=>s),manualExe,manualTrae,performance,artifacts:coherence.artifacts};
fs.writeFileSync(path.join(delivery,'accepted.json'),JSON.stringify(accepted,null,2));console.log('ACCEPTED '+report);
