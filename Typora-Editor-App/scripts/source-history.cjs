// Native source-mode input and history regression, including before undoDelay.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async({win,ev,until,output})=>{
  const results=[],pause=ms=>new Promise(r=>setTimeout(r,ms));
  const record=data=>{results.push(data);fs.writeFileSync(path.join(output,'source-history.json'),JSON.stringify(results,null,2));};
  await ev(`__open('# Source history\\n\\nSTART middle END\\n')`);await until('vditor?.vditor?.__typoraPatched');
  win.focus();win.webContents.focus();win.webContents.debugger.attach('1.3');
  const send=(method,params)=>win.webContents.debugger.sendCommand(method,params);
  const key=async(letter,shift=false)=>{
    const params={key:letter.toLowerCase(),code:'Key'+letter,windowsVirtualKeyCode:letter.charCodeAt(0),modifiers:2+(shift?8:0)};
    await send('Input.dispatchKeyEvent',{type:'rawKeyDown',...params});await send('Input.dispatchKeyEvent',{type:'keyUp',...params,modifiers:0});
  };
  const fixture='# Source history\n\nSTART 中文🙂e\u0301 middle END\n\n| 项目 | 公式 |\n| --- | --- |\n| unchanged | $\\frac{x+1}{y}$ |\n\nTAIL\n';
  await ev(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('[data-mode="sv"]').click();true`);await pause(200);
  const load=async source=>{await ev(`vditor.setValue(${JSON.stringify(source)},true);true`);await pause(300);await ev('vditor.clearStack();true');return ev('vditor.getValue()');};
  const place=async offset=>ev(`(()=>{const root=vditor.vditor.sv.element,walker=document.createTreeWalker(root,4);let left=${offset},n;while(n=walker.nextNode()){if(left<=n.length){root.focus();getSelection().collapse(n,left);return true;}left-=n.length;}throw Error('source offset out of bounds')})()`);
  const value=()=>ev('vditor.getValue()');
  for(const location of ['start','body','unicode','formula','end'])for(const wait of [0,40,300]){
    const before=await load(fixture),offset={start:0,body:before.indexOf('middle')+3,unicode:before.indexOf('🙂')+2,formula:before.indexOf('x+1')+1,end:before.indexOf('TAIL')+4}[location];
    await place(offset);await send('Input.insertText',{text:'中🙂'});
    const after=before.slice(0,offset)+'中🙂'+before.slice(offset);assert.equal(await value(),after);
    await pause(wait);const started=performance.now();await key('Z');assert.equal(await value(),before,'immediate undo '+location+'/'+wait);
    await key('Z');assert.equal(await value(),before,'no phantom history from caret movement');
    await key('Y');assert.equal(await value(),after,'redo '+location+'/'+wait);
    await key('Z',true);assert.equal(await value(),after,'Ctrl+Shift+Z is harmless when redo is empty');
    await key('Z');assert.equal(await value(),before);
    await place(offset);await send('Input.insertText',{text:'N'});await key('Y');
    assert.equal(await value(),before.slice(0,offset)+'N'+before.slice(offset),'new edit invalidates old redo');
    await key('Z');assert.equal(await value(),before,'new branch undoes exactly');
    await pause(350);assert.equal(await value(),before,'old delayed recorder does not resurrect edit');
    record({name:'native-source-history-'+location+'-'+wait,passed:true,waitMs:wait,offset,characters:before.length,historySequenceMs:performance.now()-started});
  }
  // Real composition events, commit, and immediately requested native undo.
  const before=await load(fixture),offset=before.indexOf('middle');await place(offset);
  await send('Input.imeSetComposition',{text:'zhong',selectionStart:5,selectionEnd:5});
  await send('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});
  await send('Input.insertText',{text:'中文'});
  const after=before.slice(0,offset)+'中文'+before.slice(offset);assert.equal(await value(),after);
  await key('Z');assert.equal(await value(),before,'committed composition undoes before delay');
  await key('Y');assert.equal(await value(),after,'composition redo');
  record({name:'native-source-composition-immediate-history',passed:true,offset});
  for(const size of (process.env.RELEASE100_HISTORY_PROFILE?[150001]:[150001,900001])){
    const input='# Large source\n\n'+'a'.repeat(size-23)+'\n\nTAIL\n',before=await load(input),offset=before.indexOf('TAIL')+2;
    await place(offset);await send('Input.insertText',{text:'Z'});
    if(process.env.RELEASE100_HISTORY_PROFILE){await send('Profiler.enable');await send('Profiler.start');}
    const started=performance.now();await key('Z');assert.equal(await value(),before);
    if(process.env.RELEASE100_HISTORY_PROFILE){const {profile}=await send('Profiler.stop');fs.writeFileSync(path.join(output,'source-history.cpuprofile'),JSON.stringify(profile));}
    const elapsedMs=performance.now()-started;await pause(350);assert.equal(await value(),before);
    await key('Y');assert.equal(await value(),before.slice(0,offset)+'Z'+before.slice(offset));await key('Z');assert.equal(await value(),before);
    record({name:'large-source-immediate-history-'+size,passed:true,characters:before.length,offset,undoRoundTripMs:elapsedMs});
  }
  const diffChecks=await ev(`(()=>{
    const dmp=vditor.vditor.undo.dmp,reports=[];
    for(const size of [65535,65537,200000])for(const alphabet of ['a','中文🙂abc']){
      const text=alphabet.repeat(Math.ceil(size/alphabet.length)).slice(0,size);
      const before='<p><wbr>'+text+'</p>',after='<p>'+text.slice(0,-2)+'Z<wbr>'+text.slice(-2)+'</p>';
      const started=performance.now(),diff=dmp.diff_main(before,after,true),patch=dmp.patch_make(before,after,diff),applied=dmp.patch_apply(patch,before);
      if(dmp.diff_text1(diff)!==before||dmp.diff_text2(diff)!==after||applied[0]!==after||applied[1].some(x=>!x))throw Error('history diff roundtrip '+size+'/'+alphabet);
      reports.push({name:'history-diff-roundtrip-'+size+'-'+alphabet,passed:true,characters:size,ms:performance.now()-started});
    }
    return reports;
  })()`);
  for(const item of diffChecks)record(item);
  win.webContents.debugger.detach();return results.map(r=>'PASS '+r.name);
};
