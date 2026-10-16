'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const {args,launch,acquireSlot,sleep,ROOT}=require('./lifecycle.cjs');
const {outputDir,reset,snapshot,frame,recorder,waitUntil}=require('./harness.cjs');
const {hold,verifyText}=require('./clipboard.cjs');
const requireEngine=createRequire(path.join(ROOT,'dsh-markpilot/package.json'));
const {markdown,markdownLanguage}=requireEngine('@codemirror/lang-markdown');
const {StreamLanguage,LanguageDescription,LanguageSupport}=requireEngine('@codemirror/language');
const {EditorState}=requireEngine('@codemirror/state');
const {Direction}=requireEngine('@codemirror/view');
const {basicSetup}=requireEngine('codemirror');
const {ensureSyntaxTree,syntaxTreeAvailable}=requireEngine('@codemirror/language');
const commands=requireEngine('@codemirror/commands');
const {insertBracket,deleteBracketPair}=requireEngine('@codemirror/autocomplete');
const languages=[['python',['py'],'python','python'],['javascript',['js','jsx'],'javascript','javascript'],['json',[],'javascript','json'],['css',[],'css','css'],['shell',['bash','sh'],'shell','shell'],['xml',['html'],'xml','xml']].map(([name,alias,module,exportName])=>LanguageDescription.of({name,alias,support:new LanguageSupport(StreamLanguage.define(requireEngine('@codemirror/legacy-modes/mode/'+module)[exportName]))}));
const nativeParser=markdown({base:markdownLanguage,codeLanguages:languages}).language.parser;
function originalCommand(text,anchor,head,action) {
 let state=EditorState.create({doc:text,selection:{anchor,head},extensions:[basicSetup,markdown({base:markdownLanguage,codeLanguages:languages})]});
 const referenceTree=ensureSyntaxTree(state,state.doc.length,10000);
 assert(referenceTree&&referenceTree.length===state.doc.length,'native reference must finish parsing before comparing commands');
 state=state.update({}).state;
 assert(syntaxTreeAvailable(state,state.doc.length),'published native reference must include the command position');
 const view={state,viewport:{from:0,to:text.length},textDirectionAt:()=>Direction.LTR,lineBlockAt(pos){return this.state.doc.lineAt(pos);}};
 view.dispatch=tr=>{view.state=tr?.state??view.state.update(tr).state;};
 if(action.input!==undefined){const pos=view.state.selection.main.head,tr=insertBracket(view.state,action.input);view.dispatch(tr??{changes:{from:pos,insert:action.input},selection:{anchor:pos+action.input.length},userEvent:'input.type'});}
 else action.command(view);
 const r=view.state.selection.main;return {text:view.state.doc.toString(),selection:{anchor:r.anchor,head:r.head}};
}
(async()=>{
 const argv=process.argv.slice(2),reference=argv.includes('--native-reference');
 const o=args(argv.filter(s=>s!=='--native-reference')),dir=outputDir(o.out,'worker-integration'),release=acquireSlot(),file=path.join(dir,'worker-fixture.md');fs.writeFileSync(file,'WORKER FIXTURE\n');
 const result={schema:1,startedAt:new Date().toISOString(),scope:reference?'original native command reference':'Worker full-tree and pending command integration',cases:[],frames:[],errors:[]},record=recorder(dir,result),filter=process.env.MP_QUALITY_CASES;
 const check=(id,body)=>!filter||new RegExp(filter).test(id)?record(id,body):Promise.resolve();let run,clip;
 try {
  run=await launch(o,file,dir);result.metadata=run.metadata;const p=run.page;p.on('pageerror',e=>result.errors.push(e.message));
  const inspect=async detail=>reference?{status:'native-reference',available:null}:p.evaluate(d=>window.mpEngine._syntax(d),detail);
  const fixture=async(text,anchor=0,head=anchor)=>{
   if(reference)return reset(p,text,anchor,head);
   await p.bringToFront();
   // Verify the prepared fixture immediately, before the genuine Worker's
   // debounce can finish. The action itself remains a separate real CDP input.
   const s=await p.evaluate(({text,anchor,head})=>{window.mpEngine.setValue(text);const v=window.mpEngine._view();v.dispatch({selection:{anchor,head},scrollIntoView:true});v.focus();return {same:v.state.doc.toString()===text,anchor:v.state.selection.main.anchor,head:v.state.selection.main.head,focus:v.hasFocus&&document.hasFocus()};},{text,anchor,head});
   assert(s.same);assert.equal(s.anchor,anchor);assert.equal(s.head,head);assert(s.focus);
  };
  const ready=async()=>{await waitUntil(async()=>{const s=await inspect(false);return s.status==='ready'&&s.available;},'complete Worker and outer mixed syntax',10000);const s=await inspect(false);assert.equal(s.error,null);assert.equal(s.treeLength,s.length);return s;};
  const equivalent=async(text,points=[])=>{if(reference)return {status:'native',comparison:'text and selection against original commands'};const status=await ready(),actual=await inspect(true),expected=nativeParser.parse(text);assert.equal(actual.tree,expected.toString(),'full syntax tree equals the real original parser');if(points.length){const chains=points.map(pos=>{const a=[];for(let n=expected.resolveInner(pos,1);n;n=n.parent)a.push([n.name,n.from,n.to]);return a;});assert.deepEqual((await inspect(points)).inner,chains,'mixed code nodes resolve at the same UTF-16 positions');}return status;};
  const plain=Array.from({length:100000},(_,i)=>'正文 '+i+' abcdefghijklmnopqrstuvwxyz').join('\n');
  if(!reference){
  for(const [id,ending]of[['eof',''],['newline','\n']])await check('large-paragraph-final-tree-'+id,async trace=>{const text=plain+ending;await reset(p,text,text.length);const before=await inspect(false);trace.push(before);const after=await equivalent(text);trace.push(after);assert.equal(after.nativeFallback,0);assert(after.completed>before.completed||before.status==='ready');return after;});
  await check('rapid-input-undo-redo-keeps-current-revision',async trace=>{
   const text=plain+'\n';await reset(p,text,text.length);const before=await inspect(false);for(let i=0;i<35;i++)await p.keyboard.insertText(i%2?'x':'😀');let s=await snapshot(p);const expected=text+Array.from({length:35},(_,i)=>i%2?'x':'😀').join('');assert.equal(s.text,expected);assert(s.focus);trace.push(await equivalent(expected));
   await p.keyboard.press('Control+z');s=await snapshot(p);assert.notEqual(s.text,expected);const undone=s.text;trace.push(await equivalent(undone));await p.keyboard.press('Control+y');assert.equal((await snapshot(p)).text,expected);const after=await equivalent(expected);trace.push(after);assert(after.deltas>before.deltas);assert.equal(after.nativeFallback,0);return after;
  });
  const mixed='\n\n# Heading\n\n> quote\n\n- item\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst answer = 42;\n```\n\n```json\n{"value": true}\n```\n\n~~~python\nprint("value")\n~~~\n\n<div>html</div>\n\n$x$\n';
  await check('large-mixed-document-preserves-nested-languages',async trace=>{const text=plain+mixed;await reset(p,text,text.indexOf('const answer'));const points=['const answer','"value":','print(','<div>'].map(s=>text.indexOf(s)+1);trace.push(await equivalent(text,points));result.frames.push(await frame(p,dir,'worker-mixed-code'));assert.equal((await snapshot(p)).text,text);});
  await check('pending-cdp-composition-preserves-unicode-and-quotes',async trace=>{
   const text=plain+'\n\nIME ';await fixture(text,text.length);trace.push(await inspect(false));
   await p.evaluate(()=>{window.__qualityComposition=[];for(const type of ['compositionstart','compositionupdate','compositionend'])document.addEventListener(type,e=>window.__qualityComposition.push({type:e.type,trusted:e.isTrusted}),{capture:true});});
   const cdp=await p.context().newCDPSession(p);
   try {
    await cdp.send('Input.imeSetComposition',{text:'拼',selectionStart:1,selectionEnd:1});
    await waitUntil(()=>p.evaluate(()=>window.mpEngine._view().compositionStarted),'actual composition start');
    await cdp.send('Input.imeSetComposition',{text:'拼音😀',selectionStart:4,selectionEnd:4});
    await cdp.send('Input.insertText',{text:'"中文😀"'});
    await waitUntil(()=>p.evaluate(()=>!window.mpEngine._view().compositionStarted),'composition commit');
   } finally {await cdp.detach();}
   const state=await snapshot(p),events=await p.evaluate(()=>window.__qualityComposition);
   trace.push({events,tail:state.text.slice(-40),scope:'Chromium CDP composition updates followed by Input.insertText; this does not verify the operating-system candidate window or a compositionend event'});
   assert.equal(state.text,text+'"中文😀"');assert(state.focus);assert(events.some(e=>e.type==='compositionstart'&&e.trusted));assert(events.some(e=>e.type==='compositionupdate'&&e.trusted));return equivalent(state.text);
  });
  await check('pending-math-completion-keeps-priority-and-fast-path',async trace=>{
   const text=plain+'\n\n计算 $\\fra';await fixture(text,text.length);const before=await inspect(false);assert.equal(before.status,'pending');trace.push(before);
   await p.keyboard.press('Control+Space');await p.locator('.mp-complete').waitFor({state:'visible',timeout:3000});
   assert((await p.locator('.mp-complete-item.is-active .k').textContent()).includes('frac'));
   const opened=await inspect(false);assert.equal(opened.commandFallback,before.commandFallback,'the product math candidate handler consumes CtrlSpace before tree preparation');assert.equal((await snapshot(p)).text,text);
   await p.keyboard.press('Enter');const state=await snapshot(p);assert(state.text.includes('计算 $\\frac{'));assert(state.focus);assert.equal((await inspect(false)).commandFallback,before.commandFallback);trace.push(opened);result.frames.push(await frame(p,dir,'worker-math-priority'));return equivalent(state.text);
  });
  }
  for(const [id,line,key,expected]of[['quote-enter','> quote','Enter','> quote\n> '],['quote-backspace','> ','Backspace','']])await check('pending-'+id+'-preserves-native-command',async trace=>{
   const text=plain+'\n\n'+line;await fixture(text,text.length);const before=await inspect(false);trace.push(before);if(!reference){assert.equal(before.status,'pending','fixture must exercise the actual pending path');assert.equal(before.available,false);}await p.keyboard.press(key);const s=await snapshot(p);trace.push({tail:s.text.slice(-40),selection:s.selection,focus:s.focus,status:await inspect(false)});result.frames.push(await frame(p,dir,'worker-'+id));assert.equal(s.text,plain+'\n\n'+expected);assert(s.focus);return equivalent(s.text);
  });
  const commandCases=[
   {id:'lazy-quote-enter',tail:'> quote\ncontinued',key:'Enter',command:requireEngine('@codemirror/lang-markdown').insertNewlineContinueMarkup},
   {id:'js-backtick-pair',tail:'```js\nconst value = \n```',at:t=>t.indexOf('\n```'),input:'`'},
   {id:'js-string-quote',tail:'```js\nconst value = "one  two";\n```',at:t=>t.indexOf('  ')+1,input:'"'},
   {id:'python-third-quote',tail:'```py\n""\n```',at:t=>t.indexOf('""')+2,input:'"'},
   {id:'js-closing-brace-indent',tail:'```js\nfunction f() {\n  \n```',at:t=>t.indexOf('  \n')+2,input:'}'},
   {id:'plain-leading-quote',tail:'"one  two"',at:t=>t.indexOf('  ')+1,input:'"'},
   {id:'js-backtick-delete-pair',tail:'```js\nconst value = ``;\n```',at:t=>t.indexOf('``;')+1,key:'Backspace',command:deleteBracketPair},
   {id:'js-word-delete',tail:'```js\nconst $value\n```',at:t=>t.indexOf('$value')+6,key:'Control+Backspace',command:commands.deleteGroupBackward},
   {id:'js-blank-line-indent',tail:'```js\nfunction f() {\n}\n```',at:t=>t.indexOf('{')+1,key:'Control+Enter',command:commands.insertBlankLine},
   {id:'js-reindent',tail:'```js\nfunction f() {\n  const value = 1;\n}\n```',at:t=>t.indexOf('const'),key:'Control+Alt+Backslash',command:commands.indentSelection},
   {id:'js-block-comment',tail:'```js\nconst value = 1;\n```',at:t=>t.indexOf('const'),end:t=>t.indexOf('const')+5,key:'Alt+Shift+A',command:commands.toggleBlockComment},
   {id:'js-matching-parenthesis',tail:'```js\nconst value = (")");\n```',at:t=>t.indexOf('("'),key:'Control+Shift+Backslash',command:commands.cursorMatchingBracket},
   {id:'syntax-right',tail:'one **bold** after',at:t=>t.indexOf('bold')+1,key:'Alt+ArrowRight',command:commands.cursorSyntaxRight},
   {id:'html-enter-indent',tail:'<div>',key:'Enter',command:commands.insertNewlineAndIndent},
  ];
  for(const c of commandCases)await check('pending-'+c.id,async trace=>{
   const text=plain+'\n\n'+c.tail,offset=plain.length+2,anchor=offset+(c.at?c.at(c.tail):c.tail.length),head=c.end?offset+c.end(c.tail):anchor;
   const expected=originalCommand(text,anchor,head,c);await fixture(text,anchor,head);const before=await inspect(false);trace.push(before);
   if(!reference){assert.equal(before.status,'pending','test must hit pending parser');assert.equal(before.available,false);}
   const start=performance.now();if(c.input!==undefined)await p.keyboard.insertText(c.input);else await p.keyboard.press(c.key);const elapsed=performance.now()-start;
   const s=await snapshot(p);trace.push({tail:s.text.slice(-150),selection:s.selection,ms:elapsed,focus:s.focus,status:await inspect(false)});assert.equal(s.text,expected.text,'same text as original CM6 command');assert.deepEqual(s.selection,expected.selection,'same selection as original CM6 command');assert(s.focus);
   result.frames.push(await frame(p,dir,'worker-'+c.id));return equivalent(s.text);
  });
  await check('pending-html-input-keeps-automatic-completion',async trace=>{
   const text=plain+'\n\n<sp';await fixture(text,text.length);const before=await inspect(false);trace.push(before);if(!reference)assert.equal(before.status,'pending');await p.keyboard.insertText('a');
   await waitUntil(()=>p.evaluate(()=>[...document.querySelectorAll('.cm-tooltip-autocomplete [role=option]')].some(n=>n.textContent.includes('span'))),'automatic HTML completion after the new revision',3000);
   const s=await snapshot(p);assert.equal(s.text,text+'a');assert(s.focus);result.frames.push(await frame(p,dir,'worker-html-auto-completion'));trace.push(await inspect(false));await p.keyboard.press('Escape');return equivalent(s.text);
  });
  for(const [id,input]of[['explicit-completion',false],['automatic-completion',true]])await check('pending-python-'+id,async trace=>{
   const tail='```py\npri\n```',prefix=plain+'\n\n# '+id+'\n\n',text=prefix+tail,anchor=prefix.length+tail.indexOf('pri')+3;await fixture(text,anchor);const before=await inspect(false);trace.push(before);if(!reference)assert.equal(before.status,'pending');
   if(input)await p.keyboard.insertText('n');else await p.keyboard.press('Control+Space');
   await waitUntil(()=>p.evaluate(()=>[...document.querySelectorAll('.cm-tooltip-autocomplete [role=option]')].some(n=>n.textContent.includes('print'))),'Python print completion',3000);
   const s=await snapshot(p);assert.equal(s.text,input?text.slice(0,anchor)+'n'+text.slice(anchor):text);assert(s.focus);result.frames.push(await frame(p,dir,'worker-python-'+id));trace.push(await inspect(false));await p.keyboard.press('Escape');return equivalent(s.text);
  });
  for(const [id,tail]of[['heading','# heading\n\nbody\n\nmore'],['code','```js\nconst value = 1;\n```']])await check('pending-fold-'+id,async trace=>{
   const text=plain+'\n\n'+tail;await fixture(text,plain.length+2);trace.push(await inspect(false));await p.keyboard.press('Control+Shift+{');trace.push(await p.evaluate(()=>({keys:window.__keyLog?.slice(-8),folds:document.querySelectorAll('.cm-foldPlaceholder').length})));await waitUntil(()=>p.evaluate(()=>document.querySelectorAll('.cm-foldPlaceholder').length>0),'folded syntax range');assert.equal((await snapshot(p)).text,text);await p.keyboard.press('Control+Shift+}');await waitUntil(()=>p.evaluate(()=>document.querySelectorAll('.cm-foldPlaceholder').length===0),'unfold');return equivalent(text);
  });
  if(process.platform==='win32')await check('pending-url-paste-over-selection',async trace=>{
   // This is a text URL fixture. Preserve the existing clipboard without first
   // making the blocking preservation helper own an unrelated delayed bitmap.
   clip=await hold();result.clipboard=clip.metadata;
   try {
    const written=await p.evaluate(()=>window.mpHost.writeClipboard({text:'https://example.invalid/'}));const loaded=verifyText('https://example.invalid/');trace.push({clipboardWrite:written,clipboardBefore:loaded});assert(written.ok,'clipboard write acknowledgement');assert(loaded.matches,'independent URL clipboard arm');const text=plain+'\n\nselected text',anchor=plain.length+2;await fixture(text,anchor,anchor+8);trace.push(await inspect(false));
    await p.keyboard.press('Control+v');await waitUntil(async()=> (await snapshot(p)).text!==text,'trusted URL paste');const afterClip=verifyText('https://example.invalid/');assert(afterClip.matches);const s=await snapshot(p);trace.push({tail:s.text.slice(-100),selection:s.selection,status:await inspect(false),clipboardAfter:afterClip});assert.equal(s.text,plain+'\n\n[selected](https://example.invalid/) text');assert(s.focus);result.frames.push(await frame(p,dir,'worker-url-paste'));await equivalent(s.text);
    // While structure is pending, the outer Markdown language alone must not
    // make its URL-link handler run inside fenced code.
    const tail='```js\nselected text\n```',code=plain+'\n\n'+tail,start=plain.length+2+tail.indexOf('selected');
    const codeClip=verifyText('https://example.invalid/');assert(codeClip.matches);trace.push({clipboardBefore:codeClip});await fixture(code,start,start+8);const before=await inspect(false);trace.push(before);if(!reference)assert.equal(before.status,'pending');
    await p.keyboard.press('Control+v');await waitUntil(async()=> (await snapshot(p)).text!==code,'trusted URL paste inside code');const literal=await snapshot(p);
    const codeAfter=verifyText('https://example.invalid/');assert(codeAfter.matches);assert.equal(literal.text,code.slice(0,start)+'https://example.invalid/'+code.slice(start+8));assert(literal.focus);trace.push({tail:literal.text.slice(-100),status:await inspect(false),clipboardAfter:codeAfter});result.frames.push(await frame(p,dir,'worker-code-url-paste'));return equivalent(literal.text);
   } finally {result.clipboardCleanup=await clip.restore();clip=null;}
  });
 }catch(e){result.fatal=e.stack;console.error(e.message);}
 finally{if(clip){try{result.clipboardCleanup=await clip.restore();}catch(e){result.clipboardCleanup={restored:false,error:e.message};}}result.cleanup=run?await run.cleanup():{residual:[]};result.finishedAt=new Date().toISOString();result.passed=!result.fatal&&result.cases.length>0&&result.cases.every(c=>c.status==='pass')&&result.cleanup.residual.length===0&&result.errors.length===0&&(!result.clipboard||result.clipboardCleanup?.restored===true);fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));release();console.log(JSON.stringify({out:dir,passed:result.passed,total:result.cases.length,failed:result.cases.filter(c=>c.status!=='pass').map(c=>c.id),cleanup:result.cleanup,clipboard:result.clipboardCleanup}));process.exitCode=result.passed?0:1;}
})().catch(e=>{console.error(e.stack);process.exitCode=2;});
