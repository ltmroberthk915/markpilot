'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../../..');
const paths=import(pathToFileURL(path.join(root,'dsh-markpilot/src-cm6/image-path.js')).href);
// The imported suite exercises actual EditorState/history and is explicit about
// its state-only boundary. Windows clipboard and pixels are tested by images.cjs.
void import(pathToFileURL(path.join(__dirname,'fixtures/image-insertion.mjs')).href);
test('local document directories retain literal Chinese, spaces, #, % and dots',async()=>{
 const {fileUrlOfPath,resolveImageSource}=await paths;
 for(const dir of ['D:/文档 截图/#folder%()/v3.2.5/','D:\\中文 文件夹\\a#b%\\']) {
  const normalized=dir.replaceAll('\\','/');
  const base=fileUrlOfPath(normalized);
  assert.equal(new URL(base).hash,'');
  assert.equal(decodeURIComponent(new URL(base).pathname),'/'+normalized);
  const img=new URL(resolveImageSource('assets/a%23b%25%28x%29.png',dir));
  assert.equal(decodeURIComponent(img.pathname),'/'+normalized+'assets/a#b%(x).png');
 }
});
test('file, network, data and UNC image addresses retain their source meaning',async()=>{
 const {fileUrlOfPath,resolveImageSource}=await paths;
 for(const src of ['data:image/png;base64,aabb','https://example.test/image.png','file:///D:/a%23b.png','blob:file:///id']) assert.equal(resolveImageSource(src,'D:/other/'),src);
 assert.equal(fileUrlOfPath('\\\\server\\share\\a#b.png'),'file://server/share/a%23b.png');
 assert.equal(resolveImageSource('D:\\中文\\a#b%.png','D:/other/'),'file:///D:/%E4%B8%AD%E6%96%87/a%23b%25.png');
});
test('candidate scan detects a new image formed by deleting an ordinary character',async()=>{
 const {hasImageCandidate}=await paths;
 assert(hasImageCandidate('![x]X(a.png)'));
 assert(hasImageCandidate('![x](a.png)'));
 assert(hasImageCandidate('<IMG src=x>'));
 assert.equal(hasImageCandidate('ordinary prose'),false);
});
