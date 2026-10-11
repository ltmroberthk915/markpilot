// Vditor DOM is parsed as HTML before code/math/HTML block source is copied.
// That text is already decoded once. The AST cleanup must not decode literal
// source entities a second time. Keep the other node cleanup/merge behavior.
// https://github.com/88250/lute/blob/v1.7.6/vditor_ir.go
// https://github.com/88250/lute/blob/v1.7.6/vditor_wysiwyg.go
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const marker='/* markpilot: source blocks are already HTML-decoded */';
function patchSource(source){
  if(source.includes(marker))return source;
  const before='j.Tokens=F.UnescapeHTML(j.Tokens);';
  assert.equal(source.split(before).length,3,'Expected the two Vditor AST cleanup passes');
  // Lute 1.7.6: NodeHTMLBlock=9, NodeCodeBlockCode=15, NodeMathBlockContent=302.
  return source.replaceAll(before,marker+'if(l!==9&&l!==15&&l!==302)'+before);
}
exports.patchSource=patchSource;
if(require.main===module){
  const project=path.resolve(__dirname,'..'),file=path.resolve(project,'../Typora-Editor/extension-src/render/cdn/vditor/dist/js/lute/lute.min.js');
  const original=fs.readFileSync(file,'utf8'),patched=patchSource(original);
  if(original===patched){console.log('Source block entity preservation already installed');process.exit(0);}
  const backup=path.join(project,'.backups/2026-09-08-release100/lute-before-source-entities.min.js');
  if(fs.existsSync(backup))assert.equal(fs.readFileSync(backup,'utf8'),original);else fs.copyFileSync(file,backup);
  new(require('node:vm').Script)(patched,{filename:file});fs.writeFileSync(file,patched);console.log('Preserved source block entities in both Vditor AST conversions');
}
