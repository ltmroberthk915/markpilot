// Lute 1.7.6 SV table source must use the same HTML escaping as inline source.
// https://github.com/88250/lute/blob/v1.7.6/render/vditor_sv_renderer.go
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const marker='/* markpilot: escape SV table source */';
function patchSource(source){
  if(source.includes(marker))return source;
  const start=source.indexOf('P.ptr.prototype.renderTable=function('),end=source.indexOf('};P.prototype.renderTable=',start);
  assert.ok(start>=0&&end>start,'Expected Lute 1.7.6 SV table renderer');
  const original=source.slice(start,end),write='$r=c.Write(a.Tokens);';
  assert.equal(original.split(write).length,2,'Exactly one raw table write');
  return source.slice(0,start)+original.replace(write,marker+'$r=c.Write(G.EscapeHTML(a.Tokens));')+source.slice(end);
}
exports.patchSource=patchSource;
if(require.main===module){
  const project=path.resolve(__dirname,'..'),file=path.resolve(project,'../Typora-Editor/extension-src/render/cdn/vditor/dist/js/lute/lute.min.js');
  const original=fs.readFileSync(file,'utf8'),patched=patchSource(original);
  if(patched===original){console.log('SV table source escaping already installed');process.exit(0);}
  const backup=path.join(project,'.backups/2026-09-08-release100/lute-before-sv-table.min.js');
  if(fs.existsSync(backup))assert.equal(fs.readFileSync(backup,'utf8'),original,'Backup differs');else fs.copyFileSync(file,backup);
  new(require('node:vm').Script)(patched,{filename:file});fs.writeFileSync(file,patched);
  console.log('Escaped native SV table tokens; generated newline markup unchanged');
}
