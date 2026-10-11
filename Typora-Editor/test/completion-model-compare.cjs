'use strict';
// Explicit, opt-in model comparison using contexts captured from the real
// editor. Credentials are read only from the process environment; no headers
// or secrets are written. This script never changes IDE settings or documents.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {settings, requestAI} = require('../extension-src/out/completion/core.cjs');
const katex = require('../extension-src/render/cdn/vditor/dist/js/katex/katex.min.js');
const root = path.resolve(__dirname, '..');
const readRun = name => JSON.parse(fs.readFileSync(path.join(__dirname, '.runs', name, 'results.json'), 'utf8'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const comparable = body => {
  const {model, reasoning_effort, ...rest} = body;
  return rest;
};

async function main() {
  const supplied = process.env.MD_EDITOR_COMPARE_BASELINE ? JSON.parse(fs.readFileSync(process.env.MD_EDITOR_COMPARE_BASELINE,'utf8')) : null;
  const math = supplied || readRun('quality-dp-0.1.17');
  const prose = supplied || readRun('quality-dp-prose-final');
  assert.deepEqual(math.source, prose.source);
  const source = math.source;
  const sourceHash = () => hash(fs.readFileSync(source.path));
  assert.equal(sourceHash(), source.sha256, 'The original textbook has changed');
  const key = process.env.ANTHROPIC_AUTH_TOKEN;
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || '').match(/https:\/\/[^\s)\]]+/)?.[0];
  assert.ok(key && baseUrl, 'Set ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL in this process');
  assert.equal(new URL(baseUrl).origin, 'https://api.deepseek.com', 'Do not send this credential to another provider');
  const models = process.env.MD_EDITOR_COMPARE_MODELS?.split(',') || ['deepseek-v4-flash-vision-exp', 'deepseek-v4-pro'];
  const selected = process.env.MD_EDITOR_COMPARE_CASES?.split(',');
  const cases = [...math.cases.filter(row => row.kind === 'math'), ...prose.cases.filter(row=>row.kind==='prose')].filter(row => !selected || selected.includes(row.id));
  assert.ok(cases.every(row=>row.payload&&row.requestBody),'Every comparison sample needs a captured context and request');
  const repeatedIds=process.env.MD_EDITOR_COMPARE_REPEAT_CASES?.split(',')||[];
  const repeatCount=Math.max(1,Math.min(3,Number(process.env.MD_EDITOR_COMPARE_REPEAT_COUNT)||1));
  const trials=cases.map(sample=>({sample,trial:1}));
  for(let trial=2;trial<=repeatCount;trial++)for(const sample of cases.filter(row=>repeatedIds.includes(row.id)))trials.push({sample,trial});
  const output = path.resolve(process.argv[2] || path.join(__dirname, '.runs', 'quality-dp-deepseek'));
  fs.mkdirSync(output, {recursive: true});
  assert.ok(!fs.existsSync(path.join(output, 'results.json')), 'Choose a new output directory to preserve earlier runs');
  const result = {
    startedAt: new Date().toISOString(), source,
    productionCoreSha256: hash(fs.readFileSync(path.join(root, 'extension-src/out/completion/core.cjs'))),
    baselineRuns: supplied ? [process.env.MD_EDITOR_COMPARE_BASELINE] : ['quality-dp-0.1.17 (math)', 'quality-dp-prose-final (prose)'],
    provider: {protocol: 'anthropic', baseUrl},
    method: 'Production requestAI, identical prompts, context, output limits and cleanup; GLM-only reasoning_effort removed for DeepSeek. No UI latency included.',
    baseline: cases.map(({id, label, line, kind, group, expected, suggestion, apiMs, usage, contentBlocks, katexValid}) => ({id, label, line, kind, group, expected, suggestion, apiMs, usage, contentBlocks, katexValid})),
    cases: [],
  };
  const save = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  save();
  const stopped = new Set();
  try {
    for (const {sample,trial} of trials) {
      // Alternate providers at each identical hole; at most two live requests.
      await Promise.all(models.filter(model => !stopped.has(model)).map(async model => {
        const row = {id: sample.id, label: sample.label, line: sample.line, kind: sample.kind, group:sample.group,trial, expected: sample.expected, requestedModel: model, payload: sample.payload};
        result.cases.push(row);
        const started = performance.now();
        try {
          row.suggestion = await requestAI(settings({ai: true, protocol: 'anthropic', baseUrl, model}), key, sample.payload, AbortSignal.timeout(15000), async (url, init) => {
            row.requestBody = JSON.parse(init.body);
            const transform=process.env.MD_EDITOR_COMPARE_VARIANT==='literal-gap' ? require('./completion-request-variants.cjs').literalGap : body=>body;
            row.requestBody=transform(row.requestBody);
            assert.deepEqual(comparable(row.requestBody), comparable(transform(sample.requestBody)), 'Comparison changed the prompt or source context');
            init={...init,body:JSON.stringify(row.requestBody)};
            if(process.env.MD_EDITOR_COMPARE_VARIANT)result.variant=process.env.MD_EDITOR_COMPARE_VARIANT;
            row.identicalPromptAndContext = true;
            const response = await fetch(url, init);
            row.httpStatus = response.status;
            const body = await response.clone().json();
            row.apiMs = Math.round(performance.now() - started);
            row.responseModel = body.model;
            row.usage = body.usage;
            row.stopReason = body.stop_reason;
            row.contentBlocks = body.content?.map(block => ({type: block.type, characters: (block.text || block.thinking || '').length}));
            row.rawSuggestion = body.content?.filter(block => block.type === 'text').map(block => block.text).join('');
            if (response.status >= 400) stopped.add(model);
            return response;
          });
          row.totalMs = Math.round(performance.now() - started);
          row.nonempty = !!row.suggestion;
          if (row.kind === 'math' && row.suggestion) {
            row.completedMath = row.payload.mathBefore + row.suggestion + row.payload.mathAfter;
            try {katex.renderToString(row.completedMath, {displayMode: true, throwOnError: true, strict: 'ignore'}); row.katexValid = true;}
            catch (error) {row.katexValid = false; row.katexError = error.message.slice(0, 350);}
          }
        } catch (error) {
          row.totalMs = Math.round(performance.now() - started);
          // Fetch errors carry no request headers, and only allowlisted messages
          // are persisted. Unexpected errors are classified by type.
          row.error = error.name;
          if (error.code === 'ERR_ASSERTION') {row.error = 'Prompt/context equality failed'; stopped.add(model);}
        }
        save();
        console.log(JSON.stringify({id: row.id,trial, model, responseModel: row.responseModel, http: row.httpStatus, ms: row.apiMs || row.totalMs, suggestion: row.suggestion, usage: row.usage, error: row.error}));
      }));
      if (stopped.size === models.length) break;
    }
  } finally {
    result.finishedAt = new Date().toISOString();
    result.originalUnchanged = sourceHash() === source.sha256;
    result.stoppedModels = [...stopped];
    save();
    assert.ok(result.originalUnchanged, 'Original textbook must stay unchanged');
  }
  console.log('Comparison results: ' + output);
}
main().catch(error => {console.error(error.name + ': comparison could not complete'); process.exitCode = 1;});
