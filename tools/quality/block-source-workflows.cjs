'use strict';
// Native source selection, projected fence geometry and exact saved bytes.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {ROOT,args,launch,acquireSlot,sleep,sha256} = require('./lifecycle.cjs');
const {outputDir,reset,snapshot,frame,waitUntil} = require('./harness.cjs');
const fixtures = [
  ['plain-single','PRE\n$$\nx+y\n$$\nPOST\n',true],
  ['plain-multi','PRE\n$$\nx+\ny\n$$\nPOST\n',true],
  ['quote','PRE\n> $$\n> x+y\n> $$\nPOST\n',true],
  ['nested-quote','PRE\n> > $$\n> > x+\n> > y\n> > $$\nPOST\n',true],
  ['empty','PRE\n$$\n$$\nPOST\n',false],
  ['same-line','PRE\n$$x+y$$\nPOST\n',false],
  ['mixed-fence','PRE\n$$x+\ny$$\nPOST\n',false],
  ['leading-blank','PRE\n$$\n\nx+y\n$$\nPOST\n',false],
  ['trailing-blank','PRE\n$$\nx+y\n\n$$\nPOST\n',false],
  ['list-fallback','PRE\n- $$\n  x+y\n  $$\nPOST\n',false],
  ['quote-blank','PRE\n> $$\n> x+y\n> \n> $$\nPOST\n',false]
];
const ids = fixtures.map(f=>'flow-'+f[0]).concat(['open-LF','close-LF','quote-open-LF','quote-close-LF','quote-prefix-delete','shift-click-range','drag-range','quote-shift-click-range','reverse-drag-range','source-anchor-shift-click']);
function geometry(text) {
  let at=0;
  const lines=text.split('\n').map(t=>{const l={text:t,from:at,to:at+t.length};at=l.to+1;return l;});
  const prefix=t=>/^[ \t]*(?:>[ \t]?)+/.exec(t)?.[0].length||0;
  const fences=lines.filter(l=>l.text.slice(prefix(l.text)).trim()==='$$');
  const opening=fences[0],closing=fences.at(-1);
  const body=opening&&closing?lines.filter(l=>l.from>opening.from&&l.from<closing.from):[];
  return {opening,closing,body,prefix};
}
async function main() {
  const o=args(process.argv.slice(2));
  const filter=process.env.MP_QUALITY_CASES?new RegExp(process.env.MP_QUALITY_CASES):null;
  assert(o.exe&&o.out&&o['expected-sha256'],'explicit candidate exe/hash/empty out required');
  const dir=outputDir(o.out,'block-source'),file=path.join(dir,'fixture.md');
  const result={schema:1,suite:'block-source-workflows',caseIds:ids,filter:filter?.source||null,cases:[],errors:[],cleanupErrors:[],
    startedAt:new Date().toISOString(),probe:{file:__filename,sha256:sha256(__filename)},
    channels:{keyboard:false,mouse:false,combo:false,keyboardMouse:false,drag:false},
    limitations:['renderer trusted input; OS input unverified','frames require independent visual review','no clipboard verification']};
  let release,run;
  try {
    release=acquireSlot(ROOT);fs.writeFileSync(file,fixtures[0][1]);run=await launch({...o,settings:{autosaveEnabled:false,restoreLast:false,theme:'light'}},file,dir);result.artifact=run.metadata;
    const p=run.page;await p.bringToFront();p.on('pageerror',e=>result.errors.push(e.message));
    await p.evaluate(async()=>{
      await window.mpHost.settingSet('autosaveEnabled',false);
      window.__blockSourceInput=[];
      for(const type of ['keydown','beforeinput','mousedown','mousemove','mouseup'])document.addEventListener(type,e=>{
        const v=window.mpEngine._view(),s=v.state.selection.main;
        window.__blockSourceInput.push({type,key:e.key,data:e.data,trusted:e.isTrusted,shift:e.shiftKey,
          button:e.button,buttons:e.buttons,inEditor:v.contentDOM.contains(e.target),anchor:s.anchor,head:s.head});
      },{capture:true});
    });
    async function test(id,fn) {
      if(filter&&!filter.test(id))return;
      console.log('CASE '+id);const c={id,status:'running',states:[]};result.cases.push(c);let seq=0;
      const capture=async name=>{
        const s=await snapshot(p),extra=await p.evaluate(async()=>({owner:await window.mpHost.currentDoc(),height:innerHeight,
          events:window.__blockSourceInput.slice(),selected:window.mpEngine._view().state.sliceDoc(window.mpEngine._view().state.selection.main.from,window.mpEngine._view().state.selection.main.to)}));
        const state={name,...s,...extra};c.states.push(state);
        state.frame=await frame(p,dir,id+'-'+(++seq)+'-'+name,{allowMissingCaret:true});
        assert(s.focus,'actual editor focus');assert.equal(path.resolve(extra.owner.filePath),path.resolve(file),'actual doc owner');
        assert(s.caret&&s.caret.bottom>s.caret.top&&s.caret.top>=0&&s.caret.bottom<=extra.height,'visible source caret');return state;
      };
      const key=async(name,k,expected)=>{
        assert((await snapshot(p)).focus,'focus before key');const n=await p.evaluate(()=>window.__blockSourceInput.length);
        await p.keyboard.press(k);await sleep(90);const s=await capture(name);
        assert(s.events.slice(n).some(e=>e.type==='keydown'&&e.trusted&&e.inEditor),'trusted native key delivered');
        if(expected!==undefined)assert.equal(s.text,expected,'exact source '+name);
        result.channels.keyboard=true;if(k.includes('+'))result.channels.combo=true;return s;
      };
      try{await fn({c,capture,key});c.status='pass';}catch(e){c.status='fail';c.error=e.stack||e.message;try{await capture('failure');}catch(err){c.captureError=err.message;}}console.log(c.status.toUpperCase()+' '+id+(c.error?': '+c.error.split('\n')[0]:''));
    }
    const point=async pos=>{
      const r=await p.evaluate(pos=>window.mpEngine._view().coordsAtPos(pos,1),pos);
      assert(r&&r.bottom>r.top,'native source point');return{x:r.left+.1,y:(r.top+r.bottom)/2};
    };
    for(const[id,source,supported]of fixtures)await test('flow-'+id,async({c,capture,key})=>{
      await reset(p,source,0);await capture('closed');
      await key('down-from-PRE','ArrowDown',source);await key('down-again','ArrowDown',source);
      await key('document-trailing-empty','Control+End',source);
      const post=await key('up-to-POST','ArrowUp',source);assert(post.selection.head>=source.indexOf('POST')&&post.selection.head<=source.indexOf('POST')+4,'first Up reaches POST');
      const up=await key('up-toward-formula','ArrowUp',source);
      if(supported){const g=geometry(source);assert(up.selection.head>=g.body[0].from+g.prefix(g.body[0].text)&&up.selection.head<=g.body.at(-1).to,'second Up reaches actual body source interval');}
      const bodyPos=source.indexOf('x');
      if(bodyPos>=0){
        await reset(p,source,bodyPos);
        if(supported){
          const g=geometry(source),positions=[g.opening.from+g.prefix(g.opening.text),g.body[0].from+g.prefix(g.body[0].text),g.body.at(-1).to,g.closing.from+g.prefix(g.closing.text)];
          c.topology=await p.evaluate(a=>a.map((pos,i)=>({pos,rect:window.mpEngine._view().coordsAtPos(pos,i===2?-1:1)})),positions);
          assert(Math.abs(c.topology[0].rect.top-c.topology[1].rect.top)<1,'opening $$ and first body share visual line');
          assert(Math.abs(c.topology[2].rect.top-c.topology[3].rect.top)<1,'last body and closing $$ share visual line');
        }
        const pt=await point(bodyPos+1);await p.mouse.click(pt.x,pt.y,{delay:65});await sleep(90);
        const clicked=await capture('native-source-click');assert.equal(clicked.selection.head,bodyPos+1,'native click exact source endpoint');
        assert(clicked.events.some(e=>e.type==='mousedown'&&e.trusted&&e.inEditor),'trusted source click');result.channels.mouse=true;
        for(const k of ['Home','End','ArrowLeft','ArrowRight'])await key(k,k,source);
        await key('reverse-source','Shift+ArrowLeft',source);const reverse=await snapshot(p);assert(reverse.selection.head<reverse.selection.anchor,'reverse source range');
        await key('collapse','ArrowRight',source);const before=await snapshot(p),at=before.selection.head;
        await p.keyboard.insertText('R');await sleep(90);const typed=await capture('typed-R'),expected=source.slice(0,at)+'R'+source.slice(at);
        assert.equal(typed.text,expected);assert.equal(typed.selection.head,at+1);assert(typed.events.some(e=>e.type==='beforeinput'&&e.trusted&&e.inEditor&&e.data==='R'),'native R');
        await key('R-undo','Control+z',source);await key('R-redo','Control+y',expected);await key('R-undo-final','Control+z',source);
        await reset(p,source,bodyPos+1);await key('body-Backspace','Backspace',source.slice(0,bodyPos)+source.slice(bodyPos+1));await key('body-delete-undo','Control+z',source);
        await reset(p,source,bodyPos+1);const entered=await key('native-Enter','Enter');assert.notEqual(entered.text,source);await key('Enter-undo','Control+z',source);
      }
      const fence=source.indexOf('$$');await reset(p,source,fence+1);
      await key('literal-delete-one-dollar','Backspace',source.slice(0,fence)+source.slice(fence+1));await key('literal-undo','Control+z',source);
      await key('manual-save','Control+s',source);await waitUntil(()=>fs.readFileSync(file).equals(Buffer.from(source)),'exact manual saved bytes',6000);c.diskExact=true;
    });
    for(const[id,quoted,opening]of[['open-LF',false,true],['close-LF',false,false],['quote-open-LF',true,true],['quote-close-LF',true,false]])await test(id,async({capture,key})=>{
      const source=fixtures[quoted?2:0][1],g=geometry(source),lf=opening?g.opening.to:g.body.at(-1).to;
      // Test deletion of the actual hidden LF, not the first visible glyph after prefix.
      await reset(p,source,opening?lf+1:lf);await capture('hidden-LF-start');
      await key('delete-hidden-LF',opening?'Backspace':'Delete',source.slice(0,lf)+source.slice(lf+1));
      await key('hidden-LF-undo','Control+z',source);
    });
    await test('quote-prefix-delete',async({capture,key})=>{
      const source=fixtures[2][1],g=geometry(source),from=g.body[0].from,to=from+g.prefix(g.body[0].text);
      await reset(p,source,to,from);const s=await capture('reverse-hidden-prefix');assert.equal(s.selected,'> ');
      await key('native-prefix-delete','Backspace',source.slice(0,from)+source.slice(to));await key('prefix-undo','Control+z',source);
    });
    for(const drag of[false,true])await test(drag?'drag-range':'shift-click-range',async({capture})=>{
      const source=fixtures[0][1],start=source.indexOf('x'),end=start+3;await reset(p,source,start);
      const a=await point(start),b=await point(end),count=await p.evaluate(()=>window.__blockSourceInput.length);
      await p.mouse.click(a.x,a.y,{delay:65});
      if(drag){await p.mouse.move(a.x,a.y);await p.mouse.down();try{
        assert.deepEqual((await snapshot(p)).selection,{anchor:start,head:start},'drag down collapsed source start');
        for(let i=1;i<=3;i++){const t=await point(start+i);await p.mouse.move(t.x,t.y);await sleep(45);
          assert.deepEqual((await snapshot(p)).selection,{anchor:start,head:start+i},'real drag intermediate source endpoint');}
      }finally{await p.mouse.up();}}
      else{await p.keyboard.down('Shift');try{await p.mouse.click(b.x,b.y,{delay:65});}finally{await p.keyboard.up('Shift');}}
      await sleep(90);const s=await capture('native-range');assert.equal(s.text,source);assert.deepEqual(s.selection,{anchor:start,head:end});assert.equal(s.selected,'x+y');
      const events=s.events.slice(count);assert(events.some(e=>e.type==='mousedown'&&e.trusted&&e.inEditor)&&events.some(e=>e.type==='mouseup'&&e.trusted),'trusted down/up');
      if(drag){assert(events.filter(e=>e.type==='mousemove'&&e.trusted&&e.buttons===1).length>=3,'real multi-step drag');result.channels.drag=true;}else{assert(events.some(e=>e.type==='mousedown'&&e.trusted&&e.shift),'real Shift-click');result.channels.keyboardMouse=true;}
    });
    await test('quote-shift-click-range',async({capture})=>{
      const source=fixtures[2][1],start=source.indexOf('x'),end=start+3;await reset(p,source,start);
      const a=await point(start),b=await point(end);await p.mouse.click(a.x,a.y,{delay:65});
      await p.keyboard.down('Shift');try{await p.mouse.click(b.x,b.y,{delay:65});}finally{await p.keyboard.up('Shift');}
      await sleep(90);const s=await capture('quoted-native-range');assert.equal(s.text,source);assert.deepEqual(s.selection,{anchor:start,head:end});assert.equal(s.selected,'x+y');
    });
    await test('reverse-drag-range',async({capture})=>{
      const source=fixtures[0][1],start=source.indexOf('x'),end=start+3;await reset(p,source,end);
      const a=await point(end);await p.mouse.move(a.x,a.y);await p.mouse.down();try{
        assert.deepEqual((await snapshot(p)).selection,{anchor:end,head:end},'reverse down exact visible endpoint');
        for(let i=1;i<=3;i++){const t=await point(end-i);await p.mouse.move(t.x,t.y);await sleep(45);
          assert.deepEqual((await snapshot(p)).selection,{anchor:end,head:end-i},'reverse drag intermediate endpoint');}
      }finally{await p.mouse.up();}
      const s=await capture('reverse-native-range');assert.equal(s.text,source);assert.equal(s.selected,'x+y');assert.deepEqual(s.selection,{anchor:end,head:start});
    });
    await test('source-anchor-shift-click',async({capture})=>{
      const source=fixtures[0][1],g=geometry(source),anchor=g.opening.to,end=source.indexOf('x')+3;
      // An existing source-command anchor may deliberately include the hidden LF.
      // Only the new pointer endpoint is canonicalized; the old anchor stays exact.
      await reset(p,source,anchor);const b=await point(end);
      await p.keyboard.down('Shift');try{await p.mouse.click(b.x,b.y,{delay:65});}finally{await p.keyboard.up('Shift');}
      const s=await capture('existing-hidden-LF-anchor');assert.equal(s.text,source);assert.deepEqual(s.selection,{anchor,head:end});assert.equal(s.selected,'\nx+y');
    });
  }catch(e){result.fatal=e.stack||e.message;}
  finally{
    try{if(run)result.cleanup=await run.cleanup();}catch(e){result.cleanupErrors.push(e.message);}
    try{if(release)release();}catch(e){result.cleanupErrors.push(e.message);}
    const expected=filter?ids.filter(id=>filter.test(id)):ids;
    result.finishedAt=new Date().toISOString();result.passed=result.cases.length===expected.length&&result.cases.every((c,i)=>c.id===expected[i]&&c.status==='pass')&&(filter||Object.values(result.channels).every(Boolean))&&!result.fatal&&!result.errors.length&&!result.cleanupErrors.length&&!!result.cleanup&&!result.cleanup.residual.length;
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));
  }
  if(!result.passed)process.exitCode=1;
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={ids,fixtures};
