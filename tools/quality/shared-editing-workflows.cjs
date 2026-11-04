'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {args, launch, acquireSlot} = require('./lifecycle.cjs');
const {outputDir, newWindow, recorder, waitUntil} = require('./harness.cjs');

const source = page => page.evaluate(() => window.mpEngine.getValue());
const proof = '讲义\n\n证明 A\n同一公式 $p$。\n\n证明 B\n同一公式 $p$。\n\n结尾\n';
const reordered = '讲义\n\n证明 B\n同一公式 $p$。\n\n证明 A\n同一公式 $y$（外部修订）。\n\n结尾\n';
const table = '| ID | 数据 | 结论 |\n| --- | --- | --- |\n| A | 相同 | 保留甲 |\n| B | 相同 | 保留乙 |\n\n尾段。\n';
const rows = text => text.split('\n').filter(line => line.startsWith('|'))
  .map(line => line.slice(1, -1).split('|').map(value => value.trim()));

(async () => {
  const o = args(process.argv.slice(2)), dir = outputDir(o.out, 'shared-editing'), release = acquireSlot();
  const result = {cases: []}, record = recorder(dir, result);
  let run;
  try {
    if (process.platform === 'win32') process.env.LOCALAPPDATA = path.join(dir, 'local-cache');
    const seed = path.join(dir, 'seed.md');
    fs.writeFileSync(seed, '隔离测试\n');
    run = await launch({...o, settings: {autosaveEnabled: false, restoreLast: false}}, seed, dir);
    result.artifact = run.metadata;
    await record('native-undo-after-external-proof-reorder-keeps-disk-and-view', async trace => {
      const file = path.join(dir, 'proof.md');
      fs.writeFileSync(file, proof);
      const a = await newWindow(run, run.page, file), b = await newWindow(run, a, file);
      const ids = await Promise.all([a,b].map(page => page.evaluate(() => documentId)));
      assert.notEqual(ids[0], ids[1]);
      await a.bringToFront(); await a.keyboard.press('Control+Home');
      const end = proof.indexOf('证明 A') + '证明 A'.length;
      for (let i = 0; i < end; i++) await a.keyboard.press('ArrowRight');
      await a.keyboard.press('Shift+ArrowLeft');
      assert.equal(await a.evaluate(() => {const v=window.mpEngine._view(),s=v.state.selection.main;return v.state.sliceDoc(s.from,s.to);}), 'A');
      await a.keyboard.insertText('X'); await a.keyboard.press('Control+s');
      const edited = proof.replace('证明 A', '证明 X');
      await waitUntil(async () => fs.readFileSync(file,'utf8') === edited && await a.evaluate(() => !dirty && !saveInFlight), 'saved change acknowledged');
      fs.writeFileSync(file, reordered);
      await a.locator('.mp-tb-item[data-mp-id="more"]').click({delay:50});
      await a.locator('.mp-pop').getByText('重新加载',{exact:true}).click({delay:50});
      await waitUntil(async () => await a.evaluate(id => documentId !== id, ids[0]) && await source(a) === reordered, 'menu reload adopted reordered file');
      // Toolbar focus can route Ctrl+Z through the native historyUndo event.
      await a.bringToFront(); await a.keyboard.press('Control+z');
      assert.equal(await source(a), reordered);
      await a.keyboard.press('Control+s');
      await waitUntil(async () => await a.evaluate(() => !dirty && !saveInFlight) && fs.readFileSync(file,'utf8') === reordered, 'external bytes remain saved');
      assert.equal(await source(await newWindow(run,a,file)), reordered);
      await a.screenshot({path:path.join(dir,'safe-reload-undo.png')});
      trace.push({originalId:ids[0], loadedId:await a.evaluate(() => documentId), diskMatches:true});
    });
    await record('toolbar-deletes-the-active-column-and-retains-identifiers', async trace => {
      const file = path.join(dir,'grid.md'); fs.writeFileSync(file,table);
      const p = await newWindow(run,run.page,file);
      const cell = p.locator('tr').filter({has:p.locator('td[data-mp-col="0"]').filter({hasText:/^B$/})}).locator('td[data-mp-col="1"]');
      await cell.dblclick({delay:60}); await p.locator('.mp-cell-overlay-text').waitFor();
      assert(await p.evaluate(() => document.activeElement === document.querySelector('.mp-cell-overlay-text') && document.querySelector('.mp-cell-editing')?.dataset.mpCol === '1'));
      await p.locator('[data-mp-bar="表格操作"]').click({delay:50});
      await p.locator('.mp-pop-item').filter({hasText:'删除本列'}).click({delay:50});
      await waitUntil(async () => await source(p) !== table, 'column removed');
      const after = await source(p);
      assert.deepEqual(rows(after), rows(table).map(row => [row[0],row[2]]));
      await p.keyboard.press('Control+z'); await waitUntil(async () => await source(p) === table, 'undo restores original bytes');
      await p.keyboard.press('Control+y'); await waitUntil(async () => await source(p) === after, 'redo removes only intended column');
      await p.keyboard.press('Control+s'); await waitUntil(() => fs.readFileSync(file,'utf8') === after, 'deleted column saved');
      const reopened = await newWindow(run,p,file); assert.equal(await source(reopened), after);
      await reopened.screenshot({path:path.join(dir,'identifiers-after-delete.png')}); trace.push({remaining:rows(after)});
    });
  } catch(error) { result.fatal = error.stack; }
  finally {
    try { if (run) result.cleanup = await run.cleanup(); } finally { release(); }
    result.passed = !result.fatal && result.cases.length === 2 && result.cases.every(c=>c.status === 'pass') && !result.cleanup?.residual?.length;
    fs.writeFileSync(path.join(dir,'result.json'), JSON.stringify(result,null,2));
    console.log(JSON.stringify({passed:result.passed,cases:result.cases.map(c=>[c.id,c.status])}));
    if (!result.passed) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode=1; });
