'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {normalizeFontPreferences}=require('./font-preferences.cjs');
const MAX=4*1024*1024;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
class AppearanceStore {
 constructor(userData,options={}){this.dir=path.join(userData,'themes');this.fontFile=path.join(userData,'fonts.json');this.options=options;this.revision=0;}
 nextRevision(){return Math.max(Date.now(),this.revision+1,(this.read().revision||0)+1,(this.readFonts().revision||0)+1);}
 atomic(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp-'+crypto.randomUUID();try{fs.writeFileSync(tmp,bytes,{flag:'wx'});this.options.beforeCommit?.(file);fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
 read(){const file=path.join(this.dir,'active.json');try{
  if(!fs.existsSync(file))return{ok:true,exists:false,theme:null,revision:0,directory:this.dir};
  const manifest=JSON.parse(fs.readFileSync(file,'utf8'));if(manifest.schema!==1)throw new Error('主题记录版本无效');
  if(manifest.theme===null)return{ok:true,exists:true,theme:null,revision:manifest.revision||0,directory:this.dir};
  const t=manifest.theme;if(!t||!/^[a-f0-9]{64}\.css$/.test(t.file)||typeof t.css!=='string'||!t.vars||typeof t.vars!=='object')throw new Error('主题记录损坏');
  const bytes=fs.readFileSync(path.join(this.dir,t.file));if(bytes.length>MAX||sha(bytes)!==t.sha256)throw new Error('主题副本校验失败，请重新导入');
  return{ok:true,exists:true,theme:{...t,text:bytes.toString('utf8')},revision:manifest.revision||0,directory:this.dir};
 }catch(e){return{ok:false,exists:true,error:e.message,directory:this.dir};}}
 save(input={}){try{
  const {text,css,vars}=input;if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>MAX||typeof css!=='string'||!css.trim()||Buffer.byteLength(css)>MAX)throw new Error('主题 CSS 为空或超过 4 MB');
  if(input.migration===true){const existing=this.read();if(!existing.ok||existing.exists)return existing;}
  if(!vars||typeof vars!=='object'||Array.isArray(vars)||Object.entries(vars).some(([k,v])=>!/^--[a-z0-9-]+$/i.test(k)||typeof v!=='string'||v.length>4096))throw new Error('主题变量无效');
  const bytes=Buffer.from(text),digest=sha(bytes),file=digest+'.css',target=path.join(this.dir,file);
  fs.mkdirSync(this.dir,{recursive:true});if(fs.existsSync(target)){if(sha(fs.readFileSync(target))!==digest)throw new Error('已存在的主题副本损坏');}else this.atomic(target,bytes);
  const theme={name:String(input.name||'自定义主题').slice(0,160),file,sha256:digest,bytes:bytes.length,css,vars,legacyAdapted:input.legacyAdapted===true,fontsLocked:input.fontsLocked===true};
  const revision=this.nextRevision();this.atomic(path.join(this.dir,'active.json'),JSON.stringify({schema:1,revision,theme},null,2));this.revision=revision;return{ok:true,exists:true,theme:{...theme,text},revision,directory:this.dir};
 }catch(e){return{ok:false,error:e.message};}}
 remove(){try{const revision=this.nextRevision();this.atomic(path.join(this.dir,'active.json'),JSON.stringify({schema:1,revision,theme:null}));this.revision=revision;return{ok:true,exists:true,theme:null,revision,directory:this.dir};}catch(e){return{ok:false,error:e.message};}}
 readFonts(){try{const record=fs.existsSync(this.fontFile)?JSON.parse(fs.readFileSync(this.fontFile,'utf8')):{};return{ok:true,value:normalizeFontPreferences(record.value||record),revision:record.revision||0};}catch(e){return{ok:false,error:e.message};}}
 saveFonts(patch){try{
  normalizeFontPreferences(patch);const previous=this.readFonts();if(!previous.ok)throw new Error(previous.error);
  const value=normalizeFontPreferences({...previous.value,...patch}),revision=this.nextRevision();this.atomic(this.fontFile,JSON.stringify({schema:1,revision,value},null,2));this.revision=revision;return{ok:true,value,revision};
 }catch(e){return{ok:false,error:e.message};}}
}
module.exports={AppearanceStore};
