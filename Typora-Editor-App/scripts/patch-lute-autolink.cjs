// Local Lute 1.7.6 performance patch, reproducible against the original vendor.
// Reference: https://github.com/88250/lute/blob/v1.7.6/parse/auto_link.go
// parseGFMAutoLink0 splits the remaining text on :// at every byte. Precompute
// the necessary custom-scheme conditions once, retaining the native parser for
// all candidate links and all existing standard-protocol / www branches.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const project=path.resolve(__dirname,'..'),file=path.resolve(project,'../Typora-Editor/extension-src/render/cdn/vditor/dist/js/lute/lute.min.js');
const backup=path.join(project,'.backups/2026-09-08-release100/lute-before-autolink.min.js');
const marker='/* markpilot: linear custom-scheme lookahead */';
let text=fs.readFileSync(file,'utf8');
if(text.includes(marker)){console.log('Lute autolink lookahead already installed');process.exit(0);}
const start=text.indexOf('AC.ptr.prototype.parseGFMAutoLink0=function(b){'),end=text.indexOf('};AC.prototype.parseGFMAutoLink0=',start);
assert.ok(start>=0&&end>start,'Expected Lute 1.7.6 parser not found');
const original=text.slice(start,end),initial='c=this;d=b.Tokens;e=d.$length;f=5;',split='aq=A.Split($subslice(d,j),(new CW($stringToBytes("://"))));if((2===aq.$length)';
assert.equal(original.split(initial).length,2);assert.equal(original.split(split).length,2);
const lookahead=`${marker}
var mpBytes=d.$array,mpBase=d.$offset,mpLast=-1,mpPrevious=-1,mpSchemeStart=0,mpRunStart=0,mpStandard=-1;
for(var mpAt=0;mpAt<e;mpAt++){
  var mpByte=mpBytes[mpBase+mpAt];
  if(mpByte===58&&mpAt+2<e&&mpBytes[mpBase+mpAt+1]===47&&mpBytes[mpBase+mpAt+2]===47){
    mpPrevious=mpLast;mpLast=mpAt;mpSchemeStart=mpRunStart;
    if(mpAt>=4&&mpBytes[mpBase+mpAt-4]===104&&mpBytes[mpBase+mpAt-3]===116&&mpBytes[mpBase+mpAt-2]===116&&mpBytes[mpBase+mpAt-1]===112)mpStandard=mpAt-4;
    else if(mpAt>=5&&mpBytes[mpBase+mpAt-5]===104&&mpBytes[mpBase+mpAt-4]===116&&mpBytes[mpBase+mpAt-3]===116&&mpBytes[mpBase+mpAt-2]===112&&mpBytes[mpBase+mpAt-1]===115)mpStandard=mpAt-5;
    else if(mpAt>=3&&mpBytes[mpBase+mpAt-3]===102&&mpBytes[mpBase+mpAt-2]===116&&mpBytes[mpBase+mpAt-1]===112)mpStandard=mpAt-3;
  }
  if(!(mpByte>=48&&mpByte<=57||mpByte>=65&&mpByte<=90||mpByte>=97&&mpByte<=122))mpRunStart=mpAt+1;
}
`;
const candidate='j>mpPrevious&&j<mpLast&&mpLast+3<e&&j>=mpSchemeStart&&j>mpStandard';
const patched=original.replace(initial,initial+lookahead).replace(split,`aq=(${candidate})?A.Split($subslice(d,j),(new CW($stringToBytes("://")))):null;if(aq&&(2===aq.$length)`);
if(!fs.existsSync(backup))fs.copyFileSync(file,backup);else assert.equal(fs.readFileSync(backup,'utf8'),text,'Original vendor backup differs');
text=text.slice(0,start)+patched+text.slice(end);new(require('node:vm').Script)(text,{filename:file});fs.writeFileSync(file,text);
console.log(JSON.stringify({file,backup,sha256:crypto.createHash('sha256').update(text).digest('hex')}));
