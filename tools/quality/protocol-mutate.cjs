'use strict';
// Only driver-marked disposable source copies; never mutate the checkout.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function repositoryRoot(start){let p=fs.realpathSync(start);for(;;){if(fs.existsSync(path.join(p,'tools/quality/lifecycle.cjs'))&&fs.existsSync(path.join(p,'MarkPilot-CM6/main.js')))return p;const q=path.dirname(p);if(p===q)throw Error('Repository not found');p=q;}}
const ROOT=repositoryRoot(__dirname),[mode,...argv]=process.argv.slice(2),opts={};
for(let i=0;i<argv.length;i+=2){assert(['--root','--owned-root','--kind'].includes(argv[i])&&argv[i+1],'Invalid argument');opts[argv[i].slice(2)]=argv[i+1];}
const definitions={
 'image-pending-load':{file:'dsh-markpilot/src-cm6/main.js',before:'img.loading = (retaining || /^(?:data|file|blob):/i.test(resolvedSrc)) ? "eager" : "lazy";',after:'img.loading = /^(?:data|file|blob):/i.test(resolvedSrc) ? "eager" : "lazy";'},
 'image-command':{file:'dsh-markpilot/src-cm6/extras.js',before:'const outcome = sourceEdit && commands ? commands.run(fn) : fn();',after:'const outcome = false && sourceEdit && commands ? commands.run(fn) : fn();'},
 'region-eof':{file:'dsh-markpilot/src-cm6/region-index.js',before:'if (!prior && raw.sourceOwned && !old.has(key) && counts.get(key) === 1) {',after:'if (false && !prior && raw.sourceOwned && !old.has(key) && counts.get(key) === 1) {'},
 'cell-observer':{file:'dsh-markpilot/src-cm6/main.js',before:"document.addEventListener('selectionchange', () => {\n      const edit = cellOverlay?.querySelector('.mp-cell-overlay-text');",after:"document.addEventListener('selectionchange', () => {\n      return; // protocol mutation: omit native selection observer.\n      const edit = cellOverlay?.querySelector('.mp-cell-overlay-text');"},
 'save-as-focus':{file:'MarkPilot-CM6/renderer/host.js',before:'if (commands && documentId === id && operation === saveAsSerial && window.mpEngine === engine && document.hasFocus()) {',after:'if (false && commands && documentId === id && operation === saveAsSerial && window.mpEngine === engine && document.hasFocus()) {'},
 'watcher-recovery':{file:'MarkPilot-CM6/renderer/host.js',before:'  if (saveBlocked || lastSaveError) return;',after:'  /* protocol mutation: omit watcher recovery guard. */'},
 'async-cut-owner':{file:'dsh-markpilot/src-cm6/extras.js',before:'if (!ticket || !commands.valid(ticket) || !v.state.selection.eq(selection)) { toast("选区已改变，已复制原选区，本次未剪切"); return; }',after:'if (false) { toast("选区已改变，已复制原选区，本次未剪切"); return; }'},
 'region-footprint':{file:'dsh-markpilot/src-cm6/region-index.js',before:'if (!prior || !sameContent || !sameContext) invalidated.add(id);',after:'if (false) invalidated.add(id);'},
};
assert(['on','off'].includes(mode)&&opts.root&&opts['owned-root']&&definitions[opts.kind],'Use on|off --root <copy> --owned-root <owned output> --kind <root>');
const owner=fs.realpathSync(opts['owned-root']),target=fs.realpathSync(opts.root),within=(a,b)=>{const r=path.relative(a,b);return !!r&&!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r);};
assert(within(owner,target)&&!within(target,ROOT)&&target!==ROOT,'Owned copy containment');
for(const p of [owner,target]){assert(!fs.existsSync(path.join(p,'.git')),'No repository allowed');const m=JSON.parse(fs.readFileSync(path.join(p,'quality-run.json'),'utf8'));assert.equal(m.owner,'markpilot-quality');assert.equal(m.protocolMutationOwner,owner,'Protocol ownership marker');assert.equal(m.sourceRoot,ROOT);}
const def=definitions[opts.kind],file=fs.realpathSync(path.join(target,def.file));assert(within(target,file)&&file!==fs.realpathSync(path.join(ROOT,def.file)),'Source containment');
const receipt=path.join(target,'.protocol-mutation-'+opts.kind+'.json');let saved=fs.existsSync(receipt)?JSON.parse(fs.readFileSync(receipt,'utf8')):null;
if(saved)assert(saved.root===target&&saved.owner===owner&&saved.kind===opts.kind&&saved.file===def.file,'Receipt ownership');
const verify=h=>assert.equal(sha(fs.readFileSync(file)),h,'Unexpected source bytes');
if(mode==='off'){
 if(saved?.active){verify(saved.mutantSha256);const bytes=Buffer.from(saved.before,'base64');assert.equal(sha(bytes),saved.beforeSha256,'Backup hash');fs.writeFileSync(file,bytes);verify(saved.beforeSha256);saved.active=false;fs.writeFileSync(receipt,JSON.stringify(saved,null,2));}
 else if(saved)verify(saved.beforeSha256);
 console.log(JSON.stringify({kind:opts.kind,active:false,restored:!!saved}));
}else if(saved?.active){verify(saved.mutantSha256);console.log(JSON.stringify({kind:opts.kind,active:true,alreadyApplied:true}));}
else{
 for(const n of fs.readdirSync(target).filter(n=>n.startsWith('.protocol-mutation-')))assert(!JSON.parse(fs.readFileSync(path.join(target,n),'utf8')).active,'Restore active mutation first');
 if(saved)verify(saved.beforeSha256);
 const before=fs.readFileSync(file),original=before.toString('utf8'),newline=original.includes('\r\n')?'\r\n':'\n',anchor=def.before.replaceAll('\n',newline),replacement=def.after.replaceAll('\n',newline);
 assert.equal(original.split(anchor).length,2,'Exact mutation anchor must occur once');
 const mutant=Buffer.from(original.replace(anchor,replacement));assert.notEqual(sha(mutant),sha(before),'Mutation must change bytes');
 saved={schema:1,root:target,owner,kind:opts.kind,file:def.file,active:true,before:before.toString('base64'),beforeSha256:sha(before),mutantSha256:sha(mutant)};
 fs.writeFileSync(receipt,JSON.stringify(saved,null,2));fs.writeFileSync(file,mutant);verify(saved.mutantSha256);console.log(JSON.stringify({kind:opts.kind,active:true,beforeSha256:saved.beforeSha256,mutantSha256:saved.mutantSha256}));
}
