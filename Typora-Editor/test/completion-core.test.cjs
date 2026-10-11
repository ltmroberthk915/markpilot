const {test} = require('node:test');
const assert = require('node:assert/strict');
const {settings, endpoint, modelId, locate, plainSnippet, candidate, requestAI} = require('../extension-src/out/completion/core.cjs');

test('不内置任何服务商与模型：全新安装就是“还没配”', () => {
  const config = settings();
  assert.equal(config.protocol, 'anthropic');assert.equal(config.baseUrl, '');assert.equal(config.model, '');
  assert.equal(config.ai, false);assert.equal(config.automaticAI, false);assert.deepEqual(config.profiles, []);
  assert.equal(modelId(' deepseek-flash[1M] '), 'deepseek-flash');
  assert.equal(settings({apiKey:'never-persist', env:{ANTHROPIC_AUTH_TOKEN:'secret'}, delay:3600000}).delay, 3000);
  assert.ok(!JSON.stringify(settings({apiKey:'never-persist'})).includes('never-persist'));
});
test('已知服务商把用户实际会粘的地址写法归一到同一处（以前这种写法直接 404）', () => {
  for (const base of ['https://api.deepseek.com','https://api.deepseek.com/v1','https://api.deepseek.com/anthropic','https://api.deepseek.com/anthropic/v1/messages']) {
    assert.equal(endpoint(base), 'https://api.deepseek.com/anthropic/v1/messages');
  }
  for (const base of ['https://open.bigmodel.cn','https://open.bigmodel.cn/v1','https://open.bigmodel.cn/api/paas/v4']) {
    assert.equal(endpoint(base), 'https://open.bigmodel.cn/api/anthropic/v1/messages');
  }
  // 同一主机上的自定义子路径是“另一个账号/网关”，不能归一掉。
  assert.equal(endpoint('https://api.deepseek.com/another-account'), 'https://api.deepseek.com/another-account/v1/messages');
  assert.equal(endpoint('https://api.deepseek.com','chat-completions'), 'https://api.deepseek.com/chat/completions');
  assert.equal(endpoint('https://open.bigmodel.cn/api/paas/v4','chat-completions'), 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
});
test('API endpoint handling and credential boundaries', () => {
  for (const base of ['https://example.test','https://example.test/v1/','https://example.test/v1/messages']) assert.equal(endpoint(base), 'https://example.test/v1/messages');
  assert.equal(endpoint('https://example.test/v1/','chat-completions'), 'https://example.test/v1/chat/completions');
  assert.equal(endpoint('http://localhost:8222/v1/chat/completions','chat-completions'), 'http://localhost:8222/v1/chat/completions');
  for (const base of ['http://example.test','https://u:p@example.test','https://example.test?key=secret','file:///tmp/key','https://example.test/#token']) assert.throws(()=>endpoint(base));
});
test('Exact source locations preserve CRLF, Unicode and Markdown markers', () => {
  const text = '# 😀\r\n\r\n> **中国** \\frac\r\n';
  assert.deepEqual(locate(text,{needle:'> **中国** \\frac',caret:14}),{line:2,character:14});
  assert.equal(locate('same\n\nsame',{needle:'same',caret:2}),null);
  assert.equal(locate(text,{needle:'中国 frac',caret:2}),null);
  assert.equal(locate(text,{needle:'中国',caret:20}),null);
  assert.equal(locate(text,{needle:'',caret:0}),null);
});
test('Snippet defaults are retained, transforms and variables are declined', () => {
  assert.equal(plainSnippet('${1:hello} $2 ${0}'), 'hello  ');
  assert.equal(plainSnippet('\\$price'), '$price');
  for (const input of ['${1|a,b|}','${TM_FILENAME}','${1/(.*)/$1/}','${1:${2:nested}}']) assert.equal(plainSnippet(input),null);
});
function document(text) {
  const offsetAt = position => text.split('\n').slice(0,position.line).reduce((n,line)=>n+line.length+1,0)+position.character;
  return {offsetAt, getText: range => range ? text.slice(offsetAt(range.start),offsetAt(range.end)) : text};
}
test('Provider edits apply their exact range and reject unrelated edits', () => {
  const doc = document('text provTail\n'), position = {line:0,character:9};
  const options = {document:doc,position,prefix:'prov',suffix:'Tail'};
  const range = {start:{line:0,character:5},end:{line:0,character:13}};
  const item = candidate({label:'provider',textEdit:{range,newText:'provider'}},options);
  assert.equal(item.before,4);assert.equal(item.after,4);
  assert.equal(candidate({label:'provider',additionalTextEdits:[{}]}, options),null);
  assert.equal(candidate({label:'provider',command:{command:'anything'}}, options),null);
  assert.equal(candidate({label:'provider',range:{start:{line:0,character:0},end:position}}, options),null);
  assert.equal(candidate({label:'provider'}, {...options,prefix:'incorrect'}),null);
  assert.equal(candidate({label:'provider',insertText:{value:'${1:provider}$0'}},options).text,'provider');
});
test('Anthropic request uses the user endpoint, protected key, bounded context and text blocks only', async () => {
  let observed;
  const text = await requestAI(settings({baseUrl:'https://example.test/v1',model:'glm-5.3-flash[1M]'}),'test-key',{before:'b'.repeat(12000),after:'a'.repeat(6000)},new AbortController().signal,async (url, options) => {
    observed={url,options,body:JSON.parse(options.body)};
    return new Response(JSON.stringify({content:[{type:'thinking',thinking:'private reasoning'},{type:'text',text:'继续'},{type:'text',text:'写作'}]}));
  });
  assert.equal(text,'继续写作');assert.equal(observed.options.headers['x-api-key'],'test-key');
  assert.equal(observed.options.headers['anthropic-version'],'2023-06-01');assert.equal(observed.options.redirect,'error');
  assert.equal(observed.body.model,'glm-5.3-flash');assert.equal(observed.body.max_tokens,160);
  assert.deepEqual(observed.body.thinking,{type:'disabled'});assert.equal(observed.body.messages.length,1);
  const context=require('./completion-request-variants.cjs').inspectSource(observed.body.messages[0].content);assert.equal(context.before.length,4000);assert.equal(context.after.length,1000);
  assert.ok(!observed.options.body.includes('test-key'));assert.ok(!observed.options.body.includes('hooks'));
});
test('Chat Completions stays available for another compatible service', async () => {
  const config=settings({protocol:'chat-completions',baseUrl:'http://127.0.0.1:8555/v1',model:'local-model'});
  const result=await requestAI(config,'test-key',{before:'正文',after:''},undefined,async (url,options)=>{
    assert.equal(url,'http://127.0.0.1:8555/v1/chat/completions');assert.equal(options.headers.Authorization,'Bearer test-key');
    assert.equal(JSON.parse(options.body).messages[0].role,'system');assert.equal(JSON.parse(options.body).thinking,undefined);
    return new Response(JSON.stringify({choices:[{message:{content:'继续'}}]}));
  });assert.equal(result,'继续');
});
test('Formula gap is explicit and extra GLM effort control stays provider-specific', async () => {
  for (const [baseUrl,model,effort] of [
    ['https://open.bigmodel.cn/api/anthropic','glm-5.3-flash','none'],
    ['https://open.bigmodel.cn/api/anthropic','glm-4.7',undefined],
    ['https://example.test','glm-5.3-flash',undefined],
    ['https://api.deepseek.com/anthropic','deepseek-v4-pro',undefined],
  ]) {
    await requestAI(settings({baseUrl,model}),'test-key',{kind:'math',before:'$\\frac{',after:'}{b}$',mathBefore:'\\frac{',mathAfter:'}{b}',intent:'argument'},undefined,async(url,options)=>{
      const body=JSON.parse(options.body),context=require('./completion-request-variants.cjs').inspectSource(body.messages[0].content);
      assert.equal(context.formula,'\\frac{⟦INSERT⟧}{b}');assert.equal(context.mathBefore,undefined);assert.equal(context.mathAfter,undefined);
      assert.equal(body.reasoning_effort,effort);assert.equal(body.temperature,0.2);assert.equal(body.max_tokens,256);
      return new Response(JSON.stringify({content:[{type:'text',text:'a'}]}));
    });
  }
});
test('Literal source keeps LaTeX escapes and prose completion at the cursor',async()=>{
  const payload={kind:'prose',before:'通过**',after:'**转化。\n后文的末尾，其贝',heading:'折现',intent:'continuation'};
  await requestAI(settings({baseUrl:'https://example.test/v1'}),'test-key',payload,undefined,async(url,options)=>{
    const body=JSON.parse(options.body),source=require('./completion-request-variants.cjs').inspectSource(body.messages[0].content);
    assert.equal(source.formula,'通过**⟦INSERT⟧**转化。');
    assert.ok(body.messages[0].content.lastIndexOf('⟦INSERT⟧')>body.messages[0].content.indexOf('其贝'));
    return new Response(JSON.stringify({content:[{type:'text',text:'扩充状态变量'}]}));
  });
});
test('Service failures do not expose response credentials or unbounded data', async () => {
  const call = fetcher => requestAI(settings({baseUrl:'https://example.test/v1'}),'secret',{before:'a',after:''},undefined,fetcher);
  await assert.rejects(call(async()=>new Response('secret provider details',{status:401})),error=>error.message.includes('401')&&!error.message.includes('secret'));
  await assert.rejects(call(async()=>new Response('a'.repeat(70000))),/过长/);
  await assert.rejects(call(async()=>new Response('{}')),/Anthropic Messages/);
  await assert.rejects(call(async()=>new Response('provider echoed secret')),error=>error.message.includes('JSON')&&!error.message.includes('secret'));
  await assert.rejects(call(async()=>new Response(JSON.stringify({content:[{type:'text',text:{secret:'invalid'}}]}))),/Anthropic Messages/);
  const abort=new AbortController();abort.abort();
  await assert.rejects(requestAI(settings({baseUrl:'http://localhost:8555'}),'',{before:'a',after:''},abort.signal),error=>error.name==='AbortError');
});

test('地址自己写明是哪一族 API 时以地址为准（用户实测的 404 就出在这里）', () => {
  // Trae 里实测到的那份自相矛盾配置：地址是 /anthropic，协议还停在 chat-completions，
  // 于是被拼成 https://api.deepseek.com/anthropic/chat/completions → 404。
  assert.equal(settings({protocol:'chat-completions', baseUrl:'https://api.deepseek.com/anthropic'}).protocol, 'anthropic');
  assert.equal(endpoint('https://api.deepseek.com/anthropic','chat-completions'), 'https://api.deepseek.com/anthropic/v1/messages');
  for (const base of ['https://example.test/anthropic','https://example.test/v1/messages']) {
    assert.equal(settings({protocol:'chat-completions', baseUrl:base}).protocol, 'anthropic');
  }
  assert.equal(settings({protocol:'anthropic', baseUrl:'https://example.test/v1/chat/completions'}).protocol, 'chat-completions');
  assert.equal(endpoint('https://example.test/v1/chat/completions','anthropic'), 'https://example.test/v1/chat/completions');
  // 地址没说的时候仍然听协议开关（裸主机 + chat 就是 OpenAI 兼容那一族）。
  assert.equal(settings({protocol:'chat-completions', baseUrl:'https://api.deepseek.com'}).protocol, 'chat-completions');
  assert.equal(endpoint('https://api.deepseek.com','chat-completions'), 'https://api.deepseek.com/chat/completions');
  // 保存过的用户配置（profiles）同样按地址纠正，避免"列表里那份"与"生效那份"不一致。
  const profile = settings({protocol:'chat-completions', baseUrl:'https://api.deepseek.com/anthropic', model:'deepseek-flash',
    profiles:[{id:'x', label:'DS', protocol:'chat-completions', baseUrl:'https://api.deepseek.com/anthropic', model:'deepseek-flash'}]}).profiles[0];
  assert.equal(profile.protocol, 'anthropic');
});
