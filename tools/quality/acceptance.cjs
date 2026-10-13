'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { sleep, sha256, acquireSlot, args, launch } = require('./lifecycle.cjs');
const { snapshot, reset, frame, outputDir, waitUntil } = require('./harness.cjs');
(async () => {
  const o = args(process.argv.slice(2)), dir = outputDir(o.out, 'acceptance'), release = acquireSlot();
  const aFile = path.join(dir, 'mp-quality-a.md'), bFile = path.join(dir, 'mp-quality-b.md'), saveAsFile = path.join(dir, 'mp-quality-save-as.md');
  const initial = '# Quality fixture\n\n正文 baseline。\n';
  fs.writeFileSync(aFile, initial);
  fs.writeFileSync(bFile, 'SECOND plain LF\n');
  const result = { schema:1, startedAt:new Date().toISOString(), seed:325, cases:[], frames:[], warnings:[], performance:[] };
  let run;
  async function check(id, body) {
    const start = performance.now();
    try { const detail = await body(); result.cases.push({ id, status:'pass', ms:Math.round(performance.now()-start), detail }); console.log('PASS ' + id); }
    catch (e) { result.cases.push({ id, status:'fail', ms:Math.round(performance.now()-start), error:e.message }); console.log('FAIL ' + id + ': ' + e.message); }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  }
  try {
    run = await launch(o, aFile, dir, { MP_TEST_SAVE_AS: saveAsFile, MP_EXPORT_PDF:path.join(dir,'export.pdf') });
    const page = run.page, errors = [];
    result.metadata = run.metadata;
    page.on('pageerror', e => errors.push(e.message));
    await sleep(800);
    result.frames.push(await frame(page, dir, '01-boot'));
    await check('startup-exact-bytes-and-focus', async () => {
      const s = await snapshot(page); assert.equal(s.text, initial); assert(s.focus); return { selection:s.selection, focus:s.focus };
    });
    await check('real-unicode-input-autosave', async () => {
      await page.keyboard.press('Control+End'); await page.keyboard.insertText('中文🙂 append');
      await waitUntil(() => fs.readFileSync(aFile,'utf8') === initial+'中文🙂 append', 'periodic autosave writes exact Unicode bytes', 5000);
      const text = (await snapshot(page)).text; assert.equal(text, initial+'中文🙂 append'); assert.equal(fs.readFileSync(aFile,'utf8'), text);
      return { characters:text.length, diskSha256:sha256(aFile) };
    });
    for (const [name, key, open, close] of [['bold','Control+b','**','**'],['italic','Control+i','*','*'],['underline','Control+u','<u>','</u>'],['strike','Alt+Shift+5','~~','~~'],['code','Control+e','`','`']]) {
      await check('format-' + name + '-typing-and-toggle', async () => {
        await reset(page, '', 0);
        await page.keyboard.press(key);
        let s = await snapshot(page); assert.equal(s.text, open+close); assert.equal(s.selection.head, open.length);
        await page.keyboard.press(key); assert.equal((await snapshot(page)).text, '', 'immediate empty toggle removes markers');
        await page.keyboard.press(key);
        await page.keyboard.insertText('词体');
        s = await snapshot(page); assert.equal(s.text, open+'词体'+close);
        await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.press('Shift+ArrowLeft');
        await page.keyboard.press(key); s = await snapshot(page); assert.equal(s.text, '词体');
        return { text:s.text, selection:s.selection };
      });
    }
    await check('format-selection-undo-redo', async () => {
      await reset(page, '前文 target 后文', 3, 9);
      assert.equal((await page.evaluate(() => window.mpEngine.getSelection())).selected, 'target');
      await page.keyboard.press('Control+b'); const formatted = (await snapshot(page)).text;
      assert.equal(formatted, '前文 **target** 后文');
      await page.keyboard.press('Control+z'); assert.equal((await snapshot(page)).text, '前文 target 后文');
      await page.keyboard.press('Control+y'); assert.equal((await snapshot(page)).text, formatted);
    });
    await check('plain-input-model-fixed-seed', async () => {
      await reset(page, '起点\n'); let expected = '起点\n', seed = result.seed; const trace = [];
      for(let i=0;i<40;i++) {
        seed = (Math.imul(seed,1664525)+1013904223)>>>0;
        await page.keyboard.press('Control+End');
        if(seed%4===0 && expected.length>3) { await page.keyboard.press('Backspace'); expected=Array.from(expected).slice(0,-1).join(''); trace.push('backspace'); }
        else { const token=['甲','a','🙂','乙'][seed%4]; await page.keyboard.insertText(token); expected+=token; trace.push(token); }
        const s=await snapshot(page); assert.equal(s.text,expected,'operation '+i); assert(s.focus);
      }
      return { seed:result.seed, operations:trace, characters:expected.length };
    });
    await check('markdown-projection-and-source-fidelity', async () => {
      const text='对照\n<u>下划线</u>\n**粗体**与`代码`\n$e^{i\\pi}+1=0$\n\n';
      await reset(page,text,0);
      await sleep(300);
      const projected=await page.evaluate(() => ({ underline:[...document.querySelectorAll('[data-mpu]')].map(e=>({text:e.textContent,style:getComputedStyle(e).textDecorationLine})), math:document.querySelectorAll('.katex').length }));
      assert(projected.underline.some(e=>e.text==='下划线' && e.style.includes('underline'))); assert(projected.math>0);
      assert.equal((await snapshot(page)).text,text);
      result.frames.push(await frame(page,dir,'02-markdown'));
      return projected;
    });
    await check('mermaid-render-and-content-update', async () => {
      const text='对照\n\n```mermaid\nflowchart TD\n A[开始] --> B[结束]\n```\n\n';
      await reset(page,text,0);
      await page.waitForFunction(()=>document.querySelector('.mp-mermaid svg')||document.querySelector('[data-mp-mermaid] svg'),{timeout:15000});
      result.frames.push(await frame(page,dir,'03-mermaid'));
      const a=await page.evaluate(()=>document.querySelector('.mp-mermaid')?.textContent || document.querySelector('[data-mp-mermaid]')?.textContent);
      assert(a.includes('结束'));
      await reset(page,text.replace('结束','更新'),0);
      await page.waitForFunction(()=>[...document.querySelectorAll('svg')].some(e=>e.textContent.includes('更新')),{timeout:15000});
      result.frames.push(await frame(page,dir,'04-mermaid-updated'));
      return { svg:true, updated:true };
    });
    await check('mermaid-invalid-source-safe-fallback', async () => {
      const text='对照\n\n```mermaid\nflowchart TD\n A[unterminated\n```\n\n';
      await reset(page,text,0);
      await page.waitForFunction(()=>document.querySelector('.mp-mermaid')?.textContent.includes('渲染失败'),{timeout:15000});
      const message=await page.locator('.mp-mermaid').textContent();
      assert.equal((await snapshot(page)).text,text,'render failure must preserve source');
      assert.equal(await page.locator('.mp-mermaid svg').count(),0,'failed graph must not reuse a previous SVG');
      result.frames.push(await frame(page,dir,'08-mermaid-error'));
      return { message };
    });
    await check('task-list-widget-after-offset-shift', async () => {
      const text='前文\n- [ ] task\n后文\n'; await reset(page,text,0);
      await page.keyboard.insertText('前缀\n');
      const cb=page.locator('.cm-content input[type=checkbox]').first();
      await cb.waitFor({state:'visible',timeout:3000}); await cb.click();
      const s=await snapshot(page); assert(s.text.includes('前缀\n前文')); assert(s.text.includes('- [x] task')); return { text:s.text };
    });
    await check('mouse-drag-selection-and-shift-key-extension', async () => {
      await reset(page,'abcdefghij\nsecond line\n');
      const points=await page.evaluate(()=>{const v=window.mpEngine._view();return[1,6].map(p=>v.coordsAtPos(p))});
      assert(points.every(Boolean));
      await page.mouse.move(points[0].left,(points[0].top+points[0].bottom)/2); await page.mouse.down();
      for(let i=1;i<=6;i++) await page.mouse.move(points[0].left+(points[1].left-points[0].left)*i/6,(points[0].top+points[0].bottom)/2);
      await page.mouse.up();
      const before=await snapshot(page); assert(before.selection.anchor!==before.selection.head);
      await page.keyboard.press('Shift+ArrowRight'); const after=await snapshot(page);
      assert(after.selection.anchor!==after.selection.head); assert.equal(after.text,before.text);
      result.frames.push(await frame(page,dir,'05-selection'));
      return { before:before.selection, after:after.selection };
    });
    await check('shift-mouse-click-and-real-double-click', async () => {
      const text='alpha beta gamma\n'; await reset(page,text,0);
      const points=await page.evaluate(()=>{const v=window.mpEngine._view();return[2,8].map(p=>v.coordsAtPos(p))});
      assert(points.every(Boolean));
      const click=async(point,options={})=>page.mouse.click(point.left,(point.top+point.bottom)/2,options);
      await click(points[0]);
      let s=await snapshot(page);assert(s.focus);assert.equal(s.selection.head,2);assert.equal(s.selection.anchor,2);
      await page.keyboard.down('Shift');
      try { await click(points[1]); } finally { await page.keyboard.up('Shift'); }
      s=await snapshot(page);assert.equal(s.selection.anchor,2);assert.equal(s.selection.head,8);assert.equal(s.text,text);
      const shifted=s.selection;
      result.frames.push(await frame(page,dir,'10-shift-click-selection'));
      await click(points[1],{clickCount:2});
      s=await snapshot(page);assert.equal(text.slice(Math.min(s.selection.anchor,s.selection.head),Math.max(s.selection.anchor,s.selection.head)),'beta');
      assert(s.focus);assert.equal(s.text,text);
      result.frames.push(await frame(page,dir,'09-double-click-selection'));
      return { shifted, doubleClicked:s.selection };
    });
    await check('save-as-real-menu-and-disk', async () => {
      await reset(page,'另存为正文\n',0); await page.keyboard.press('Control+End'); await page.keyboard.insertText('追加');
      const click=await page.evaluate(()=>window.mpHost.recentTestMenuClick('menu-save-as',true)); assert(click);
      await page.waitForFunction(()=>window.__mpDocDir && document.title.includes('mp-quality-save-as.md'),{timeout:10000});
      await sleep(800);
      assert.equal(fs.readFileSync(saveAsFile,'utf8'),(await snapshot(page)).text);
      return { file:path.basename(saveAsFile), bytes:fs.statSync(saveAsFile).size };
    });
    await check('secondary-window-eol-and-session-isolation', async () => {
      await page.evaluate(p=>window.mpHost.openInNewWindow(p),bFile);
      let second;
      for(let i=0;i<40&&!second;i++) {
        for(const p of run.browser.contexts().flatMap(c=>c.pages())) if(p!==page && await p.evaluate(()=>!!window.mpEngine?._view?.()).catch(()=>false)) { second=p; break; }
        if(!second)await sleep(100);
      }
      assert(second,'secondary window boot');
      await sleep(500); const before=await snapshot(page);
      await second.bringToFront();
      await second.evaluate(()=>window.mpEngine.focus());
      assert((await snapshot(second)).focus);
      await second.keyboard.press('Control+End'); await second.keyboard.insertText('SECOND-EDIT');
      await waitUntil(async () => fs.readFileSync(bFile,'utf8') === (await snapshot(second)).text, 'secondary periodic autosave writes its own exact bytes', 5000);
      const a=await snapshot(page), b=await snapshot(second);
      assert.equal(a.text,before.text,'first document preserved');
      assert.equal(fs.readFileSync(bFile,'utf8'),b.text,'secondary saves its own document');
      const infoA=await page.evaluate(()=>window.mpHost.currentDoc()),infoB=await second.evaluate(()=>window.mpHost.currentDoc());
      assert.equal(infoA.filePath,saveAsFile,'primary session path stays primary');
      assert.equal(infoB.filePath,bFile,'secondary session path stays secondary');
      result.frames.push(await frame(second,dir,'06-second-window'));
      await page.bringToFront(); await page.evaluate(()=>window.mpEngine.focus());
      return { primary:path.basename(infoA.filePath),secondary:path.basename(infoB.filePath) };
    });
    await check('large-document-real-input-latency', async () => {
      // UTF-16 document length is explicit. No assertion that a dropped input was fast.
      for(const lines of [1000,10000]) {
        const text=Array.from({length:lines},(_,i)=>'正文 '+i+' abcdefghijklmnopqrstuvwxyz').join('\n')+'\n';
        await reset(page,text,0); await page.keyboard.press('Control+End'); await sleep(250);
        const samples=[];
        for(let i=0;i<30;i++) {
          const t=performance.now(); await page.keyboard.insertText('x');
          const after=await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>{
            const v=window.mpEngine._view();resolve({length:v.state.doc.length,tail:v.state.doc.sliceString(v.state.doc.length-31),focus:v.hasFocus});
          })));
          samples.push(performance.now()-t);
          assert.equal(after.length,text.length+i+1,'latency sample input must land'); assert(after.focus);assert(after.tail.endsWith('x'.repeat(i+1)));
        }
        samples.sort((a,b)=>a-b);
        result.performance.push({lines,characters:text.length,p50Ms:Math.round(samples[14]),p95Ms:Math.round(samples[28]),samples:30,metric:'CDP input through next renderer animation frame; excludes whole-document serialization',rawMs:samples});
      }
      return result.performance;
    });
    await check('no-renderer-exceptions',async()=>{assert.deepEqual(errors,[]);return { errors };});
    result.frames.push(await frame(page,dir,'07-final'));
    assert(result.cases.length>0,'an empty suite cannot pass');
  } catch(e) { result.fatal=e.stack; console.error(e.message); }
  finally {
    result.cleanup=run ? await run.cleanup() : {residual:[]};
    result.finishedAt=new Date().toISOString(); result.passed=!result.fatal && result.cases.length>0 && result.cases.every(c=>c.status==='pass') && result.cleanup.residual.length===0;
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));
    release(); console.log(JSON.stringify({out:dir,passed:result.passed,total:result.cases.length,failed:result.cases.filter(c=>c.status==='fail').map(c=>c.id),fatal:result.fatal?.split('\n')[0],cleanup:result.cleanup}));
    process.exitCode=result.passed?0:1;
  }
})().catch(e=>{console.error(e.stack);process.exitCode=2;});
