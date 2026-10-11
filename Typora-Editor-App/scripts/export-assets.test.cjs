const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {pathToFileURL}=require('node:url');
const {embedImages,imageFile,exportStyles}=require('../app/main/export-assets');
test('image paths preserve Chinese, spaces, # and absolute/relative file references',()=>{
  const doc='D:\\笔记\\教材.md',image='D:\\笔记\\图 #1.png',origin='http://127.0.0.1:54321';
  for(const ref of ['图%20%231.png',image,pathToFileURL(image).href,origin+'/ws-file/'+encodeURIComponent(image),origin+'/ws/'+encodeURIComponent(path.dirname(image))+'/图%20%231.png','https://file+.vscode-resource.vscode-cdn.net/'+encodeURIComponent(image)])assert.equal(imageFile(ref,doc,origin),image);
  assert.equal(imageFile('https://example.com/a.png',doc,origin),null);
  assert.throws(()=>imageFile(origin+'/render/index.js',doc,origin));
});
test('image embedding handles duplicates, failed downloads, caps, cancellation and never sends auth headers',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'typora-export-'));t.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'typora-export-'));return fs.rm(root,{recursive:true,force:true});});
  const file=path.join(root,'doc.md'),image=path.join(root,'tiny.png');await fs.writeFile(image,Buffer.from([1,2,3]));
  const huge=path.join(root,'huge.png');const handle=await fs.open(huge,'w');await handle.truncate(21*1024*1024);await handle.close();
  const headers=[];const server=http.createServer((req,res)=>{headers.push(req.headers);res.setHeader('Content-Type',req.url==='/bad'?'text/html':'image/png');res.end('image');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const remote='http://127.0.0.1:'+server.address().port;
  const result=await embedImages(['tiny.png','tiny.png','huge.png','missing.png',remote+'/ok',remote+'/bad','data:text/html,boom','data:image/png;base64,AQID'],{file,origin:'http://127.0.0.1:1'});
  assert.equal(Object.keys(result.assets).length,3);assert.equal(result.warnings.length,4);assert.equal(result.assets['tiny.png'],'data:image/png;base64,AQID');
  for(const item of headers){assert.equal(item['x-typora-token'],undefined);assert.equal(item.authorization,undefined);assert.equal(item.cookie,undefined);}
  const controller=new AbortController();controller.abort();await assert.rejects(embedImages(['tiny.png'],{file,signal:controller.signal}));
});
test('standalone styles embed every dependency without loopback/CDN links',async()=>{
  const css=await exportStyles(path.resolve(__dirname,'../app/renderer'),path.resolve(__dirname,'../app/shell'));
  for(const match of css.matchAll(/url\(([^)]+)\)/g))assert.match(match[1],/^["']?(data:|#)/);
  assert.match(css,/@page/);assert.match(css,/data:font\/woff2;base64,/);
});
