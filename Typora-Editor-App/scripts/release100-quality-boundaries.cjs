const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async({win,fe,wait,pause,test,toggle,mode,output,setup,click})=>{
  const quality=length=>length>900000?'ratio':length>150000?'blocks':'precise';
  const key=async keyCode=>{for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode,modifiers:['control']});await pause(100);};
  let canonicalAdjustment=0;
  for(const length of [150000,150001,900000,900001]){
    const prefix='# Threshold '+length+'\n\n',block='Repeated boundary paragraph '.repeat(24).trim()+'\n\n',tail='ENDTOKEN\n';
    let file,text;
    // Thresholds use the active editor Markdown, which can canonicalize the
    // final newline when entering source mode. Calibrate the fixture only;
    // assertions below still demand exact sizes and a native one-character edit.
    for(let attempt=0;attempt<2;attempt++){
      const rawLength=length+canonicalAdjustment,count=Math.floor((rawLength-prefix.length-tail.length-2)/block.length),padding=rawLength-prefix.length-count*block.length-tail.length;
      text=prefix+block.repeat(count)+'p'.repeat(padding)+tail;assert.equal(text.length,rawLength);
      file=path.join(output,'threshold-'+length+'-'+attempt+'.md');fs.writeFileSync(file,text);
      await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}});
      const version=String(global.doc.docVersion);
      await wait('new URLSearchParams(location.search).get("v")==='+JSON.stringify(version)+'&&!!vditor.__splitNavigation&&vditor.getValue().includes("ENDTOKEN")');
      await setup();await mode('ir');
      await fe('window.focus();vditor.vditor.ir.element.focus();getSelection().collapse(vditor.vditor.ir.element,0);true');
      await toggle();await wait('vditor.__splitNavigation.active&&vditor.__splitNavigation.source===vditor.getValue()');
      const actual=await fe('vditor.getValue().length');if(actual===length)break;
      assert.ok(Math.abs(actual-length)<=2,'Unexpected fixture normalization');canonicalAdjustment+=length-actual;
    }
    await test('threshold-'+length+'-initial-quality',async()=>{
      const state=await fe('({length:vditor.getValue().length,quality:vditor.__splitNavigation.quality,sourceCurrent:vditor.__splitNavigation.source===vditor.getValue()})');
      assert.equal(state.length,length);assert.equal(state.quality,quality(length));assert.equal(state.sourceCurrent,true);return{...state,rawFixtureLength:text.length};
    });
    await test('threshold-'+length+'-native-edit-undo-redo-save',async()=>{
      const baseline=await fe('vditor.getValue()');
      // The held entry anchor keeps the post-toggle caret and scroll until a
      // real user action; script selection or scrolling raises no
      // cancellation events, so maintainEntry pulls both back to the anchor.
      // Position like a user: native Ctrl+End releases the entry and scrolls
      // the tail into view, then click the last ENDTOKEN character and press
      // End for the exact offset.
      for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'End',modifiers:['control']});
      await pause(200);
      await click(await fe("__flow.rect(__flow.point('source','ENDTOKEN',0,7))"));
      for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'End'});
      await wait('(()=>{const c=__flow.caret();return c&&c.offset===__flow.expected("ENDTOKEN",0,8);})()');
      await win.webContents.insertText('z');
      await wait('vditor.getValue().includes("ENDTOKENz")&&vditor.__splitNavigation.source===vditor.getValue()');
      const edited=await fe('({length:vditor.getValue().length,quality:vditor.__splitNavigation.quality})');assert.equal(edited.length,length+1);assert.equal(edited.quality,quality(length+1));
      await key('Z');await wait('vditor.getValue().length==='+length+'&&vditor.__splitNavigation.source===vditor.getValue()');
      assert.equal(await fe('vditor.getValue()'),baseline);assert.equal(await fe('vditor.__splitNavigation.quality'),quality(length));
      await key('Y');await wait('vditor.getValue().includes("ENDTOKENz")&&vditor.__splitNavigation.source===vditor.getValue()');
      const current=await fe('vditor.getValue()');
      for(let i=0;i<100&&global.doc.current.text!==current;i++)await pause(30);
      await global.doc.save();assert.equal(fs.readFileSync(file,'utf8'),current);assert.equal(global.doc.dirty,false);
      return{before:quality(length),edited,undoRestoredExactSource:true,diskEqualsEditor:true};
    });
  }
};
