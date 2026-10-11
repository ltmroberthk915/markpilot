const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {startServer,AUTH_HEADER}=require('../app/main/server');
const {authorizedRequest,installResourceAuth}=require('../app/main/resource-auth');
test('local server authenticates every route and rotates the startup capability',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'typora-auth-'));
  const rendererRoot=path.join(root,'render'),shellRoot=path.join(root,'shell');
  await fs.mkdir(rendererRoot);await fs.mkdir(shellRoot);await fs.mkdir(shellRoot+'-sibling');
  const secret=path.join(root,'private.md');await fs.writeFile(secret,'private test contents');
  await fs.writeFile(path.join(rendererRoot,'index.html'),'<base href="{{baseUrl}}/">');
  await fs.writeFile(path.join(shellRoot,'shell.html'),'trusted shell');await fs.writeFile(path.join(shellRoot+'-sibling','private.md'),'sibling');
  const first=await startServer({rendererRoot,shellRoot,port:0}),second=await startServer({rendererRoot,shellRoot,port:0});
  t.after(async()=>{await Promise.all([new Promise(r=>first.server.close(r)),new Promise(r=>second.server.close(r))]);assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'typora-auth-'));await fs.rm(root,{recursive:true,force:true});});
  const request=(resource,{token,host,method='GET'}={})=>new Promise((resolve,reject)=>{
    const headers={};if(token)headers[AUTH_HEADER]=token;if(host)headers.Host=host;
    http.request({hostname:'127.0.0.1',port:first.port,path:resource,method,headers},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));}).on('error',reject).end();
  });
  const routes=['/shell','/shell/shell.html','/render/index.html','/doc/'+encodeURIComponent(secret),'/ws/'+encodeURIComponent(root)+'/private.md','/ws-file/'+encodeURIComponent(secret)];
  for(const route of routes)await t.test('denies unauthenticated '+route.split('/')[1],async()=>{
    for(const token of [undefined,'wrong',second.token])assert.equal((await request(route,{token})).status,403);
    const valid=await request(route,{token:first.token});assert.equal(valid.status,200);assert.ok(!valid.body.includes(first.token));assert.equal(valid.headers['referrer-policy'],'no-referrer');
  });
  for(const host of ['localhost:'+first.port,'evil.test:'+first.port,'127.0.0.1:'+second.port])await t.test('rejects wrong Host '+host,async()=>assert.equal((await request('/shell',{token:first.token,host})).status,403));
  for(const route of ['/shell/..%5cshell-sibling%5cprivate.md','/render/..%5cprivate.md'])await t.test('rejects encoded traversal '+route,async()=>assert.equal((await request(route,{token:first.token})).status,403));
  assert.equal((await request('/shell/%zz',{token:first.token})).status,400);
  assert.equal((await request('/shell',{token:first.token,method:'POST'})).status,405);
  assert.equal((await request('/ws-file/'+encodeURIComponent(path.join(root,'absent.md')),{token:first.token})).body,'not found');
});
test('header injection is restricted to registered windows and trusted frames, stripped externally',()=>{
  const origin='http://127.0.0.1:1234',contents=new Set([7]);
  const local={url:origin+'/ws-file/a',webContentsId:7,resourceType:'image',frame:{url:origin+'/doc/a?v=1'}};
  assert.equal(authorizedRequest(local,origin,contents),true);
  for(const change of [{webContentsId:8},{frame:{url:'https://evil.test'}},{url:'http://127.0.0.1:4321/ws-file/a'},{url:'https://evil.test/image'},{frame:null}])assert.equal(authorizedRequest({...local,...change},origin,contents),false);
  assert.equal(authorizedRequest({...local,resourceType:'mainFrame',url:origin+'/shell',frame:{url:'about:blank'}},origin,contents),true);
  assert.equal(authorizedRequest({...local,resourceType:'mainFrame',url:origin+'/render/office.html',frame:{url:'about:blank'}},origin,contents),true);
  assert.equal(authorizedRequest({...local,webContentsId:8,resourceType:'mainFrame',url:origin+'/render/office.html',frame:{url:'about:blank'}},origin,contents),false);
  assert.equal(authorizedRequest({...local,resourceType:'subFrame',url:origin+'/doc/a',frame:{url:'',parent:{url:origin+'/shell'}}},origin,contents),true);
  let callback;const fake={webRequest:{onBeforeSendHeaders(_filter,fn){callback=fn;}}};
  const auth=installResourceAuth(fake,{port:1234,token:'private-capability'});auth.allow({id:7,once(){}});
  callback({...local,requestHeaders:{}},result=>assert.equal(result.requestHeaders[AUTH_HEADER],'private-capability'));
  callback({...local,url:'https://evil.test',requestHeaders:{[AUTH_HEADER]:'private-capability'}},result=>assert.equal(result.requestHeaders[AUTH_HEADER],undefined));
});
