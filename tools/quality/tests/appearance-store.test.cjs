'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const source=process.env.MP_TEST_APPEARANCE_STORE||'../../../MarkPilot-CM6/shell/appearance-store';
const fixture=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mp-appearance-'));t.after(()=>{assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});return dir;};
const theme=(text=':root{--bg-color:#f4eddc}',name='主题 中文')=>({text,name,css:':root[data-mp-user-theme]{--bg-color:#f4eddc}',vars:{'--bg-color':'#f4eddc'},fontsLocked:false});
test('import preserves exact original UTF-8 bytes and restores without source file',t=>{
 const {AppearanceStore}=require(source),dir=fixture(t),store=new AppearanceStore(dir),input=theme('\ufeff/* License 中文 */\r\n:root{--bg-color:#f4eddc}');
 const r=store.save(input);assert(r.ok);assert.equal(r.theme.bytes,Buffer.byteLength(input.text));assert.deepEqual(fs.readFileSync(path.join(dir,'themes',r.theme.file)),Buffer.from(input.text));
 const after=new AppearanceStore(dir).read();assert(after.ok);assert.equal(after.theme.text,input.text);assert.equal(after.theme.name,input.name);
});
test('same name new bytes creates a separate managed copy and activates new value',t=>{
 const {AppearanceStore}=require(source),dir=fixture(t),store=new AppearanceStore(dir),a=store.save(theme()).theme,b=store.save(theme('h1{color:red}')).theme;
 assert.notEqual(a.file,b.file);assert(fs.existsSync(path.join(dir,'themes',a.file)));assert.equal(store.read().theme.file,b.file);
});
test('failed commit preserves existing active theme and cleans its temporary manifest',t=>{
 const {AppearanceStore}=require(source),dir=fixture(t),store=new AppearanceStore(dir),first=store.save(theme()).theme;
 const fail=new AppearanceStore(dir,{beforeCommit:file=>{if(file.endsWith('active.json'))throw new Error('disk unavailable');}});
 const r=fail.save(theme('h1{color:blue}'));assert.equal(r.ok,false);assert.match(r.error,/disk unavailable/);assert.equal(store.read().theme.file,first.file);assert(!fs.readdirSync(path.join(dir,'themes')).some(n=>n.includes('.tmp-')));
});
test('remove writes a tombstone and prevents cache migration resurrection',t=>{
 const {AppearanceStore}=require(source),dir=fixture(t),store=new AppearanceStore(dir);assert.equal(store.read().exists,false);store.save(theme());assert(store.remove().ok);
 const after=new AppearanceStore(dir).read();assert.equal(after.exists,true);assert.equal(after.theme,null);
});
test('invalid or oversized input preserves prior theme; names never control paths',t=>{
 const {AppearanceStore}=require(source),dir=fixture(t),store=new AppearanceStore(dir),old=store.save(theme()).theme;
 for(const bad of [{},{...theme(),text:''},{...theme(),text:'x'.repeat(4*1024*1024+1)},{...theme(),vars:{a:{bad:true}}}])assert.equal(store.save(bad).ok,false);
 assert.equal(store.read().theme.file,old.file);const r=store.save(theme('h1{color:red}','../../outside'));assert(r.ok);assert.equal(path.basename(r.theme.file),r.theme.file);
});
test('corrupt copied CSS is reported rather than silently replaced by old cache',t=>{
 const {AppearanceStore}=require(source),dir=fixture(t),store=new AppearanceStore(dir),r=store.save(theme());fs.writeFileSync(path.join(dir,'themes',r.theme.file),'damaged');assert.equal(store.read().ok,false);
});
test('font preferences are durable, role-specific and reject CSS injection',t=>{
 const {AppearanceStore}=require(source),dir=fixture(t),store=new AppearanceStore(dir);
 assert(store.saveFonts({body:'Arial',h1:'Georgia',italic:'KaiTi'}).ok);const saved=new AppearanceStore(dir).readFonts();assert.equal(saved.value.body,'Arial');assert.equal(saved.value.h1,'Georgia');assert.equal(saved.value.italic,'KaiTi');assert.equal(saved.value.h2,'');
 assert.equal(store.saveFonts({body:'serif; color:red'}).ok,false);assert.equal(store.readFonts().value.body,'Arial');
});
test('a late first-run migration cannot overwrite a removal tombstone or newer import',t=>{
 const {AppearanceStore}=require(source),dir=fixture(t),store=new AppearanceStore(dir),legacy={...theme(),legacyAdapted:true,migration:true};store.remove();const old=store.read();const migrated=store.save(legacy);assert(migrated.ok);assert.equal(migrated.theme,null);assert.equal(migrated.revision,old.revision);
 store.save(theme('h1{color:red}','new'));const newer=store.read();store.save(legacy);assert.equal(store.read().theme.name,'new');assert.equal(store.read().revision,newer.revision);
});
test('commit revisions order theme and partial font updates; failed writes do not commit',t=>{
 const {AppearanceStore}=require(source),dir=fixture(t),store=new AppearanceStore(dir),a=store.save(theme()),b=store.saveFonts({body:'Arial'}),c=store.saveFonts({h1:'Georgia'}),d=store.remove();assert(a.revision<b.revision&&b.revision<c.revision&&c.revision<d.revision);assert.equal(store.readFonts().value.body,'Arial');assert.equal(store.readFonts().value.h1,'Georgia');const bad=store.saveFonts({h2:'a;b'});assert.equal(bad.ok,false);assert.equal(store.readFonts().revision,c.revision);
});
