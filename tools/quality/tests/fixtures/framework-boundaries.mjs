import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EditorState,EditorSelection,Compartment} from '../../../../dsh-markpilot/node_modules/@codemirror/state/dist/index.js';
import {history,undo,redo} from '../../../../dsh-markpilot/node_modules/@codemirror/commands/dist/index.js';
import {imageInsertions,reserveImageInsertion,cancelImageInsertions} from '../../../../dsh-markpilot/src-cm6/image-insertion.js';
import {deleteGrapheme} from '../../../../dsh-markpilot/src-cm6/grapheme-delete.js';
import {scanSourceImageRefs} from '../../../../dsh-markpilot/src-cm6/resource-images.js';
import {localImagePath} from '../../../../dsh-markpilot/src-cm6/image-path.js';
const run = test;
function view(doc,selection,more=[]){const v={state:EditorState.create({doc,selection,extensions:[history(),imageInsertions,EditorState.allowMultipleSelections.of(true),...more]})};v.dispatch=spec=>{v.state=(spec.startState?spec:v.state.update(spec)).state;};return v;}
run('ticket-forks-keep-order-after-new-selection',()=>{const v=view('A KEEP Z',{anchor:0});const first=reserveImageInsertion(v);v.dispatch({selection:{anchor:2,head:6}});const second=first.fork(),third=first.fork();assert(first.commit('ONE'));assert(second.commit('TWO'));assert(third.commit('THREE'));assert.equal(v.state.doc.toString(),'ONETWOTHREEA KEEP Z');assert.equal(v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to),'KEEP');return v.state.doc.toString();});
run('ticket-fork-selection-replaces-once',()=>{const v=view('A OLD Z',{anchor:2,head:5});const a=reserveImageInsertion(v),b=a.fork();assert(a.commit('ONE'));assert(b.commit('TWO'));assert.equal(v.state.doc.toString(),'A ONETWO Z');return v.state.doc.toString();});
run('edited-reservation-invalidates-all-forks',()=>{const v=view('A OLD Z',{anchor:2,head:5});const a=reserveImageInsertion(v),b=a.fork();v.dispatch({changes:{from:3,insert:'N'}});assert.equal(a.current(),null);assert.equal(b.current(),null);assert.equal(a.commit('BAD'),false);return v.state.doc.toString();});
run('reset-invalidates-all-forks',()=>{const v=view('A Z',{anchor:1});const a=reserveImageInsertion(v),b=a.fork();v.dispatch({effects:cancelImageInsertions.of(null)});assert.equal(a.current(),null);assert.equal(b.current(),null);});
run('readonly-transition-blocks-commit',()=>{const mode=new Compartment(),v=view('A Z',{anchor:1},[mode.of(EditorState.readOnly.of(false))]);const ticket=reserveImageInsertion(v);v.dispatch({effects:mode.reconfigure(EditorState.readOnly.of(true))});const accepted=ticket.commit('BAD');assert.equal(accepted,false);assert.equal(v.state.doc.toString(),'A Z');});
run('cluster-mixed-forward',()=>{const text='A👍🏽B\nXYZ',selection=EditorSelection.create([EditorSelection.cursor(1),EditorSelection.cursor(8)],1),v=view(text,selection);assert(deleteGrapheme(1)(v));assert.equal(v.state.doc.toString(),'AB\nXZ');assert.equal(v.state.selection.ranges.length,2);assert.equal(v.state.selection.mainIndex,1);assert(undo(v));assert.equal(v.state.doc.toString(),text);assert(v.state.selection.eq(selection));assert(redo(v));assert.equal(v.state.doc.toString(),'AB\nXZ');});
for (const [source,want] of [['assets/a%20b.png','D:/notes/assets/a b.png'],['assets/a%2520b.png','D:/notes/assets/a%20b.png'],['D:\\notes\\a%20b.png','D:/notes/a%20b.png'],['file:///D:/notes/a%20b.png?q#x','D:/notes/a b.png'],['file://server/share/a%20b.png','//server/share/a b.png'],['https://x.test/a.png',null]])run('local-url-'+source,()=>{assert.equal(localImagePath(source,'D:/notes'),want);});
run('scanner-survives-escaped-close-and-image-title',()=>{const src='![a](assets/a\\(b\\).png "title") `![x](assets/no.png)`\n\n```\n![y](assets/no2.png)\n```';assert.deepEqual(scanSourceImageRefs(src).map(x=>x.target),['assets/a(b).png']);});

const cases=[
 ['plain','![a](assets/x.png)',['assets/x.png']],
 ['balanced','![a](assets/x(1).png "title)")',['assets/x(1).png']],
 ['angle','![a](<assets/x y.png> "title")',['assets/x y.png']],
 ['escapes','\\![a](ignored.png) ![b](real.png)',['real.png']],
 ['double-backtick','`` ![a](code.png) ` `` ![b](real.png)',['real.png']],
 ['fence','```md\n![a](code.png)\n```\n\n![b](real.png)',['real.png']],
 ['indent','    ![a](code.png)\n\n![b](real.png)',['real.png']],
 ['comment','prefix <!-- ![a](bad.png) --> ![b](real.png) <!-- ![c](bad2.png) -->',['real.png']],
 ['line-leading-comment-tail','<!-- ![a](bad.png) --> ![b](also-comment-block.png)',[]],
 ['multiline-comment','<!--\n![a](bad.png)\n-->\n\n![b](real.png)',['real.png']],
 ['html-quote','<img alt="a>b" src="assets/x>y.png">',['assets/x>y.png']],
 ['html-attrs','<img data-src="wrong.png" SRC = \'assets/x&amp;y.png\' src="wrong2.png">',['assets/x&y.png']],
 ['html-unquoted','<img src=assets/x.png alt=a>',['assets/x.png']],
 ['html-empty','<img src="" src="wrong.png">',[]],
 ['html-script','<script>const x="<img src=bad.png>";</script>\n\n![b](real.png)',['real.png']],
 ['markdown-escape-entity','![a](assets/a\\(b\\)&amp;c.png)',['assets/a(b)&c.png']],
 ['escaped-bracket-alt','![a\\]b](assets/x.png)',['assets/x.png']],
];

for(const [id,source,want] of cases)test('semantic images: '+id,()=>{const refs=scanSourceImageRefs(source);assert.deepEqual(refs.map(x=>x.target),want);for(const ref of refs)assert.equal(source.slice(ref.from,ref.to),ref.raw);});

import {applyEnter} from '../../../../dsh-markpilot/src-cm6/tables.js';
for(const eof of [false,true])test('table Enter maps deletion before '+(eof?'append':'next row'),()=>{const source='|H|K|\n|---|---|\n|ABCDEFGHIJKLMNO|X|'+(eof?'':'\n|b|Y|');const from=source.indexOf('ABCDEFGHIJKLMNO');const selected=EditorSelection.single(from,from+15);const v=view(source,selected);assert(applyEnter(v));const expected=source.replace('ABCDEFGHIJKLMNO','')+(eof?'\n|  |  |':'');assert.equal(v.state.doc.toString(),expected);assert.equal(v.state.selection.main.head,eof?expected.length-4:expected.indexOf('|b|Y|')+1);assert(undo(v));assert.equal(v.state.doc.toString(),source);assert(v.state.selection.eq(selected));});
