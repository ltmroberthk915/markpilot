'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
module.exports=function validate(c,dir){
 switch(c.id){
 case 'open-retargeted-path-adopts-wrong-source':
   assert.notEqual(c.physicalRead,c.currentPhysical);
   if(c.ack.ok){assert.equal(c.doc.filePath,c.physicalRead);assert.equal(c.text,'PHYSICAL A CONTENT\n');}
   else{assert.equal(c.ack.code,'MP_FILE_CONFLICT');assert.equal(c.doc.filePath,path.join(dir,'owner.md'));assert.equal(c.text,'Owner base\n');}
   assert.equal(c.currentLogicalText,'PHYSICAL B CONTENT\n');break;
 case 'open-reading-overwrites-new-draft':
   assert.equal(c.ack.ok,false);assert.equal(c.ack.code,'MP_OPEN_NEWER_INPUT');assert.equal(c.after.text,c.before.text);assert.equal(c.after.title,c.before.title);
   assert.equal(c.ownerAfter.documentId,c.ownerBefore.documentId);assert.equal(c.ownerAfter.filePath,c.ownerBefore.filePath);assert.equal(c.ownerAfter.text,c.ownerBefore.text);break;
 case 'edit-table-command-deletes-outside-paragraph':
   assert.equal(c.disk,c.text);assert(c.text.startsWith('OUTSIDE_A | OUTSIDE_KEEP\n'));assert(!c.text.includes('H1')&&!c.text.includes('D1'));assert(c.text.includes('H2')&&c.text.includes('D2'));break;
 case 'edit-search-bitmap-paste-replaces-document':
   assert.equal(c.active.tag,'INPUT');assert.equal(c.active.name,'search');assert(c.beforeClip.matches&&c.afterClip.matches);assert.equal(c.after.text,'# KEEP\n\nSENTINEL_FULL_DOCUMENT\n');assert.equal(c.after.active.tag,'INPUT');break;
 case 'save-metadata-permissions-and-stream-lost':
   assert(c.before.protected&&c.after.protected);assert.equal(c.after.sddl,c.before.sddl);assert.equal(c.after.stream,c.before.stream);assert.equal(c.disk,'PROTECTED DOCUMENT\nEDITED');break;
 case 'save-close-during-real-composition':
   assert(c.before.composing&&c.before.text.includes('未完成'));assert.equal(c.closed,false);assert.equal(c.disk,'COMPOSE BASE\n');break;
 case 'export-css-token-executes-in-output':
   assert(c.token.includes('</style>'));assert(c.out.ok);assert.equal(c.observed.flag,null);assert.equal(c.observed.scripts,0);assert(c.observed.body.includes('ThemeInjection'));break;
 case 'export-failure-destroys-existing-archive':
   assert(c.exists);assert.equal(c.contents,'OLD_ARCHIVE_SENTINEL');break;
 default:throw Error('Unknown stability oracle '+c.id);
 }
};
