'use strict';
// Run against an owned negative-control artifact with a missing, silent, or
// incompatible Worker. This suite must not alter the installed application.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { args, launch, acquireSlot } = require('./lifecycle.cjs');
const { outputDir, reset, snapshot, recorder, waitUntil } = require('./harness.cjs');

(async () => {
  const argv = process.argv.slice(2), index = argv.indexOf('--expect');
  if (index < 0) throw new Error('Use --expect missing-script|timeout|protocol-mismatch');
  const expect = argv[index + 1];
  assert(['missing-script', 'timeout', 'protocol-mismatch'].includes(expect));
  argv.splice(index, 2);
  const options = args(argv), dir = outputDir(options.out, 'worker-degradation'), release = acquireSlot();
  const file = path.join(dir, 'degradation-fixture.md');
  fs.writeFileSync(file, 'WORKER DEGRADATION FIXTURE\n');
  const result = { schema: 1, startedAt: new Date().toISOString(), expect, cases: [], errors: [] };
  const check = recorder(dir, result);
  let run;
  try {
    run = await launch(options, file, dir);
    result.metadata = run.metadata;
    const page = run.page;
    page.on('pageerror', error => result.errors.push(error.message));
    const prefix = 'plain paragraph abcdefghijklmnopqrstuvwxyz\n'.repeat(10000) + '\n';
    const inspect = () => page.evaluate(() => window.mpEngine._syntax());
    await check('real-worker-failure-is-bounded-and-visible', async trace => {
      await reset(page, prefix + '> quote', prefix.length + 7);
      await waitUntil(async () => (await inspect()).status === 'failed', 'Worker failure fallback', 18000);
      const state = await inspect();
      assert(state.error, 'failure diagnostic must be retained');
      if (expect === 'timeout') assert.match(state.error, /did not finish/);
      if (expect === 'protocol-mismatch') assert.match(state.error, /schema|manifest|length|payload|property|record/i);
      trace.push(state);
      return state;
    });
    await check('failed-worker-keeps-quote-enter-and-undo', async trace => {
      const before = (await snapshot(page)).text;
      await page.keyboard.press('Enter');
      let state = await snapshot(page);
      assert.equal(state.text, before + '\n> ');
      assert(state.focus);
      await page.keyboard.press('Control+z');
      state = await snapshot(page);
      assert.equal(state.text, before);
      trace.push(await inspect());
    });
    await check('failed-worker-keeps-code-pairs-and-native-indent', async trace => {
      const tail = '```js\nfunction f() {\n  \n```', text = prefix + tail;
      const anchor = prefix.length + tail.indexOf('  \n') + 2;
      await reset(page, text, anchor);
      await page.keyboard.insertText('}');
      const state = await snapshot(page);
      assert.equal(state.text, prefix + '```js\nfunction f() {\n}\n```');
      assert(state.focus);
      trace.push(await inspect());
    });
    await check('failed-worker-persists-exact-document-bytes', async trace => {
      const text = (await snapshot(page)).text;
      await page.keyboard.press('Control+s');
      await waitUntil(() => fs.readFileSync(file, 'utf8') === text, 'native fallback save');
      trace.push({ bytes: fs.statSync(file).size, status: await inspect() });
      assert.equal((await snapshot(page)).text, text);
    });
  } catch (error) {
    result.fatal = error.stack;
  } finally {
    result.cleanup = run ? await run.cleanup() : { residual: [] };
    result.finishedAt = new Date().toISOString();
    result.passed = !result.fatal && result.cases.length === 4 && result.cases.every(c => c.status === 'pass') && !result.cleanup.residual.length && !result.errors.length;
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    release();
    console.log(JSON.stringify({ out: dir, passed: result.passed, total: result.cases.length, failed: result.cases.filter(c => c.status !== 'pass').map(c => c.id), errors: result.errors, cleanup: result.cleanup }));
    process.exitCode = result.passed ? 0 : 1;
  }
})().catch(error => { console.error(error.stack); process.exitCode = 2; });
