'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {args,launch,acquireSlot,sleep}=require('./lifecycle.cjs');
const {outputDir,snapshot,frame,recorder,waitUntil,newWindow}=require('./harness.cjs');
const clipboard=require('./clipboard.cjs');
async function main(){
  const options=args(process.argv.slice(2)),dir=outputDir(options.out,'rich-workflows'),release=acquireSlot();
  const result={suite:'rich-workflows',schema:1,startedAt:new Date().toISOString(),cases:[]},record=recorder(dir,result),filter=process.env.MP_QUALITY_CASES;
  const test=(id,body)=>!filter||new RegExp(filter).test(id)?record(id,body):Promise.resolve();
  let run,clip;
  try{
    const file=path.join(dir,'mixed-tables.md'),initial='Existing text\n\n';fs.writeFileSync(file,initial);
    run=await launch(options,file,dir);result.artifact=run.metadata;const p=run.page;
    clip=await clipboard.hold();
    const tableA='<table><tr><th>A_HEAD</th><th>A_LABEL</th></tr><tr><td>A_CELL</td><td>A_VALUE</td></tr></table>',tableB='<table><tr><th>B_HEAD</th><th>B_LABEL</th></tr><tr><td>B_CELL</td><td>B_VALUE</td></tr></table>';
    const mixed='<p>PRE_SENTINEL</p>'+tableA+'<p>MID_SENTINEL</p>'+tableB+'<p>POST_SENTINEL</p>';
    const fixtures=[
      ['mixed',mixed,['PRE_SENTINEL','A_HEAD','A_LABEL','A_CELL','A_VALUE','MID_SENTINEL','B_HEAD','B_LABEL','B_CELL','B_VALUE','POST_SENTINEL']],
      ['wrapper','<div><section>'+mixed+'</section></div>',['PRE_SENTINEL','A_HEAD','A_LABEL','A_CELL','A_VALUE','MID_SENTINEL','B_HEAD','B_LABEL','B_CELL','B_VALUE','POST_SENTINEL']],
      ['bare-text','PRE_SENTINEL'+tableA+'MID_SENTINEL'+tableB+'POST_SENTINEL',['PRE_SENTINEL','A_HEAD','A_LABEL','A_CELL','A_VALUE','MID_SENTINEL','B_HEAD','B_LABEL','B_CELL','B_VALUE','POST_SENTINEL']],
      ['adjacent',tableA+tableB,['A_HEAD','A_LABEL','A_CELL','A_VALUE','B_HEAD','B_LABEL','B_CELL','B_VALUE']],
      ['single',tableA,['A_HEAD','A_LABEL','A_CELL','A_VALUE']],
      ['rich-no-table','<h2>PRE_SENTINEL</h2><p>A <strong>A_HEAD</strong> word</p><p>POST_SENTINEL</p>',['PRE_SENTINEL','A_HEAD','POST_SENTINEL']],
      ['paragraph-bare-text','<p>PRE_SENTINEL</p>MID_SENTINEL'+tableA+'<p>POST_SENTINEL</p>',['PRE_SENTINEL','MID_SENTINEL','A_HEAD','A_LABEL','A_CELL','A_VALUE','POST_SENTINEL']],
      ['uppercase',mixed.replace(/table/g,'TABLE'),['PRE_SENTINEL','A_HEAD','A_LABEL','A_CELL','A_VALUE','MID_SENTINEL','B_HEAD','B_LABEL','B_CELL','B_VALUE','POST_SENTINEL']],
      ['nested-fallback','<p>PRE_SENTINEL</p><table><tr><td>OUTER_SENTINEL'+tableA+'</td></tr></table>'+tableB+'<p>POST_SENTINEL</p>',['PRE_SENTINEL','OUTER_SENTINEL','A_HEAD','A_LABEL','A_CELL','A_VALUE','B_HEAD','B_LABEL','B_CELL','B_VALUE','POST_SENTINEL'],{plainFallback:true}],
      ['merged-fallback','<p>PRE_SENTINEL</p><table><tr><td colspan="2">MERGED_SENTINEL</td></tr></table>'+tableB+'<p>POST_SENTINEL</p>',['PRE_SENTINEL','MERGED_SENTINEL','B_HEAD','B_LABEL','B_CELL','B_VALUE','POST_SENTINEL'],{plainFallback:true}],
      ['one-row','<table><tr><th>ONLY_HEADER</th><th>ONLY_LABEL</th></tr></table>',['ONLY_HEADER','ONLY_LABEL'],{fragment:'| ONLY_HEADER | ONLY_LABEL |\n| --- | --- |'}],
      ['plain-tsv','',['TSV_HEAD','TSV_LABEL','TSV_CELL','TSV_VALUE'],{plain:'TSV_HEAD\tTSV_LABEL\nTSV_CELL\tTSV_VALUE',fragment:'| TSV_HEAD | TSV_LABEL |\n| --- | --- |\n| TSV_CELL | TSV_VALUE |'}],
      ['code-literal',mixed,['PRE_SENTINEL','A_HEAD','A_LABEL','A_CELL','A_VALUE','MID_SENTINEL','B_HEAD','B_LABEL','B_CELL','B_VALUE','POST_SENTINEL'],{initial:'Start\n```text\n\n```\nEnd\n',code:true,literal:true}],
      ['plain-shortcut',mixed,['PRE_SENTINEL','A_HEAD','A_LABEL','A_CELL','A_VALUE','MID_SENTINEL','B_HEAD','B_LABEL','B_CELL','B_VALUE','POST_SENTINEL'],{key:'Control+Shift+V',literal:true}]
    ];
    for(const[name,html,tokens,config={}]of fixtures)await test(name+'-html-preserve-all-content-in-order',async trace=>{
      const original=config.initial||initial,file=path.join(dir,name+'.md');fs.writeFileSync(file,original);const p=await newWindow(run,run.page,file);
      const plain=config.plain||tokens.join('\n');
      await p.bringToFront();await p.evaluate(()=>window.mpEngine.focus());
      await waitUntil(()=>p.evaluate(()=>document.hasFocus()&&window.mpEngine._view().hasFocus),'actual editor focus');
      await p.keyboard.press('Control+End');
      if(config.code){await p.keyboard.press('Control+Home');await p.keyboard.press('ArrowDown');await p.keyboard.press('ArrowDown');assert(await p.evaluate(()=>document.querySelector('.cm-line.cm-activeLine')?.classList.contains('mp-code')),'literal code context');}
      trace.push({name:'before',...await snapshot(p),screenshot:await frame(p,dir,name+'-01-before')});
      const written=await p.evaluate(payload=>window.mpHost.writeClipboard(payload),{text:plain,html});assert(written?.ok,'native clipboard write');
      const before={text:clipboard.verifyText(plain),html:html?clipboard.verifyHtml(html):{matches:true,absent:true}};trace.push({name:'clipboard-before',...before});assert(before.text.matches&&before.html.matches,'independent clipboard armed');
      await p.evaluate(tokens=>{window.__qualityPaste=null;document.addEventListener('paste',e=>{const h=e.clipboardData?.getData('text/html')||'',source=h||e.clipboardData?.getData('text/plain')||'';window.__qualityPaste={trusted:e.isTrusted,types:[...e.clipboardData.types],format:h?'html':'plain',tokens:tokens.map(t=>source.includes(t))};},{capture:true,once:true});},tokens);
      await p.keyboard.press(config.key||'Control+v');
      await waitUntil(()=>p.evaluate(original=>window.mpEngine.getValue()!==original,original),'real paste changed document');await sleep(650);
      const pasted=await snapshot(p),paste=await p.evaluate(()=>window.__qualityPaste);
      trace.push({name:'pasted',...pasted,paste,screenshot:await frame(p,dir,name+'-02-pasted')});
      const after={text:clipboard.verifyText(plain),html:html?clipboard.verifyHtml(html):{matches:true,absent:true}};trace.push({name:'clipboard-after',...after});assert(after.text.matches&&after.html.matches,'independent clipboard retained');assert(paste?.trusted&&paste.tokens.every(Boolean),'real event has complete clipboard content');
      await p.keyboard.press('Control+z');await sleep(150);const undone=await snapshot(p);trace.push({name:'undo',...undone,screenshot:await frame(p,dir,name+'-03-undo')});
      await p.keyboard.press('Control+y');await sleep(200);const redone=await snapshot(p);trace.push({name:'redo',...redone,screenshot:await frame(p,dir,name+'-04-redo')});
      assert.equal(undone.text,original,'one undo restores the complete pre-paste text');assert.equal(redone.text,pasted.text,'one redo restores complete pasted text');
      const positions=tokens.map(t=>pasted.text.indexOf(t));trace.push({name:'order',tokens,positions});
      assert(positions.every(n=>n>=0),'every table and surrounding paragraph must survive');
      assert(positions.every((n,i)=>!i||n>positions[i-1]),'all source nodes retain document order');
      if(config.plainFallback||config.literal){assert(pasted.text.includes(plain),'whole clipboard plain text survives unchanged');assert(!pasted.text.includes('| --- |'),'fallback and literal paths do not build partial tables');}
      else{
        if(html.includes('A_CELL'))assert(pasted.text.includes('| A_HEAD | A_LABEL |\n| --- | --- |\n| A_CELL | A_VALUE |'),'first complete Markdown table');
        if(html.includes('B_CELL'))assert(pasted.text.includes('| B_HEAD | B_LABEL |\n| --- | --- |\n| B_CELL | B_VALUE |'),'second complete Markdown table');
        if(config.fragment)assert(pasted.text.includes(config.fragment),'expected structured Markdown');
      }
      return {tokens,positions,atomicUndoRedo:true};
    });
  }finally{
    try{if(clip)result.clipboard=await clip.restore();}finally{try{if(run)result.cleanup=await run.cleanup();}finally{release();}}
    result.finishedAt=new Date().toISOString();result.passed=result.cases.length>0&&result.cases.every(c=>c.status==='pass')&&!result.cleanup?.residual?.length;fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));
  }
  if(!result.passed)process.exitCode=1;
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
