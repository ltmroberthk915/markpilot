'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../..');
const modules = Promise.all([
  import(pathToFileURL(path.join(root, 'dsh-markpilot/src-cm6/markdown-context.js')).href),
  import(pathToFileURL(path.join(root, 'dsh-markpilot/node_modules/@codemirror/state/dist/index.js')).href),
  import(pathToFileURL(path.join(root, 'dsh-markpilot/node_modules/@lezer/markdown/dist/index.js')).href),
]);

test('fence index agrees with the real Markdown parser on quote, type, length, info and EOF boundaries', async () => {
  const [context, { Text }, { parser }] = await modules;
  for (const text of [
    '```js\n- literal\n```\nafter', '~~~text\n$x$\n~~~',
    '````\n```\n- literal\n````', '```\n~~~\n- literal\n```',
    '~~~\nx\n~~~ js\n- literal', '~~~\nx\n~~~~\nafter',
    '> ~~~text\n> > literal\n>\t~~~\nafter',
    '> > ```\n> > x\n> > ```\n', '> ~~~\n> x\nafter\n- literal',
    '> ```\n> a\n\n> b\n> ```\n> c',
    '> ```\n> a\n   \n> b\n> ```\n> c',
    '> ```\n> a\n> \n> b\n> ```\n> c',
    '  ```\n  x\n  ```\n', 'before\n~~~\nx',
  ]) {
    const doc = Text.of(text.split('\n')), ranges = [];
    parser.parse(text).iterate({ enter(node) {
      if (node.name === 'FencedCode') ranges.push([doc.lineAt(node.from).number, doc.lineAt(node.to).number]);
    } });
    assert.deepEqual(context.scanFencedBlocks(doc).map(b => [b.startLine, b.endLine]), ranges, text);
  }
});

test('quote containers preserve literal extra markers and strip only the opening indentation', async () => {
  const [c] = await modules;
  const blocks = c.scanFenceLines(['>  ~~~', '> > literal', '>\t~~~']);
  assert.equal(blocks.length, 1); assert.equal(blocks[0].depth, 1);
  assert.equal(c.codeBody('> > literal', blocks[0]).text, '> literal');
  assert.equal(c.codeBody('>\t x', blocks[0]).text, 'x');
});
test('list and quote ancestry includes continuation and lazy paragraphs while code retains literal markers',async()=>{
 const [c,{EditorState},{parser}]=await modules;
 for(const text of ['- > para\n  > target\n\noutside','> - para\n>   target\n\noutside','> para\ntarget\n\noutside','- para\n  target\n\noutside']){
  const state=EditorState.create({doc:text,extensions:[c.markdownContext]}),pos=text.indexOf('target');
  const got=c.structuralContextAt(state.field(c.markdownContext),pos).path.map(p=>p.kind);
  let node=parser.parse(text).resolveInner(pos),expected=[];
  while(node){if(node.name==='Blockquote')expected.unshift('quote');if(node.name==='ListItem')expected.unshift('list');node=node.parent;}
  assert.deepEqual(got,expected,text);
  assert.equal(c.structuralContextAt(state.field(c.markdownContext),text.indexOf('outside')).path.length,0,text);
 }
 const text='- ```js\n  > $literal$\n  ```\noutside';
 const blocks=c.scanFenceLines(text.split('\n'));assert.equal(blocks.length,1);assert.equal(blocks[0].depth,0);
 assert.equal(c.codeBody('  > $literal$',blocks[0]).text,'> $literal$');
 const ranges=[];parser.parse(text).iterate({enter(n){if(n.name==='FencedCode')ranges.push([n.from,n.to])}});
 assert.deepEqual(blocks.map(b=>[b.syntaxFrom,b.to]),ranges);
 assert.equal(blocks[0].from,0,'the projection owns the full source line including its parent prefix');
});
test('ordinary source edits retain parent identities and mapped parent ranges',async()=>{
 const [c,{EditorState}]=await modules;
 let state=EditorState.create({doc:'before\n- > para\n  > target\n',extensions:[c.markdownContext]});
 const old=c.structuralContextAt(state.field(c.markdownContext),state.doc.toString().indexOf('target')).path;
 state=state.update({changes:{from:state.doc.toString().indexOf('target')+2,insert:'Q'}}).state;
 const now=c.structuralContextAt(state.field(c.markdownContext),state.doc.toString().indexOf('ta')).path;
 assert.deepEqual(now.map(p=>p.id),old.map(p=>p.id));assert.equal(now[0].to,old[0].to+1);
 state=state.update({changes:{from:0,insert:'new\n'}}).state;
 const moved=c.structuralContextAt(state.field(c.markdownContext),state.doc.toString().indexOf('ta')).path;
 assert.deepEqual(moved.map(p=>p.id),old.map(p=>p.id));assert.equal(moved[0].from,old[0].from+4);
});

test('plain edits map code ranges; closing-tail edits and undo recompute the container', async () => {
  const [c, { EditorState }] = await modules;
  let state = EditorState.create({ doc: '- ab\n~~~\nx\n~~~\n- after', extensions: [c.markdownContext] });
  const update = (from, to, insert) => { state = state.update({ changes: { from, to, insert } }).state; };
  update(4, 4, 'c');
  assert.equal(c.codeBlockAt(state, 5), null);
  assert.equal(c.codeBlockAt(state, 10).from, 6);
  const close = state.doc.toString().lastIndexOf('~~~') + 3;
  update(close, close, 'a');
  assert(c.codeBlockAt(state, state.doc.length), 'nonclosing info makes the following list literal');
  update(close, close + 1, '');
  assert.equal(c.codeBlockAt(state, state.doc.length), null);
});

test('fixed-seed edit sequences keep incremental code classification equal to the parser', async () => {
  const [c, { EditorState }, { parser }] = await modules;
  let state = EditorState.create({ doc: 'before\n~~~js\n> literal $x$\n~~~\n- after\n', extensions: [c.markdownContext] });
  let seed = 0x325;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const tokens = ['x', 'a', ' ', '\t', '\n', '`', '~', '> ', '$', '字'];
  for (let i = 0; i < 600; i++) {
    const from = next() % (state.doc.length + 1), to = Math.min(state.doc.length, from + next() % 4);
    state = state.update({ changes: { from, to, insert: tokens[next() % tokens.length] } }).state;
    const expected = [];
    parser.parse(state.doc.toString()).iterate({ enter(node) {
      if (node.name === 'FencedCode') expected.push([state.doc.lineAt(node.from).number, state.doc.lineAt(node.to).number]);
    } });
    assert.deepEqual(state.field(c.markdownContext).blocks.map(b => [b.startLine, b.endLine]), expected, 'step ' + i);
  }
});

test('first body positions and structural transitions preserve every indexed field', async () => {
  const [c, { EditorState }] = await modules;
  const cases = [
    ['~~~\nx\n~~~', { from: 4, insert: 'a' }],
    ['~~~\n\n~~~', { from: 4, insert: 'a' }],
    ['> ~~~\n> x\n> ~~~', { from: 6, insert: ' ' }],
    ['    > ~~~\n    > x', { from: 0, to: 1 }],
    ['   > ~~~\n   > x', { from: 0, insert: ' ' }],
    ['x~~~\nbody\n~~~', { from: 0, to: 1 }],
    ['~~~\nbody\nx~~~', { from: 9, to: 10 }],
    ['~~~\nbody\n~~~ info', { from: 12, to: 17 }],
    ['~~~\nbody\n~~~', { from: 12, insert: 'x' }],
    ['~~~\nabc\n~~~', [{ from: 4, insert: 'x' }, { from: 6, to: 7, insert: 'y' }]],
  ];
  for (const [doc, changes] of cases) {
    const state = EditorState.create({ doc, extensions: [c.markdownContext] }).update({ changes }).state;
    assert.deepEqual(state.field(c.markdownContext).blocks, c.scanFencedBlocks(state.doc), doc);
  }
  const state = EditorState.create({ doc: '~~~\nx\n~~~', extensions: [c.markdownContext] }).update({ changes: { from: 4, insert: 'a' } }).state;
  assert.equal(state.field(c.markdownContext).blocks[0].bodyFrom, 4, 'typing at the first code-body position must not move the body boundary');
});

test('fixed-seed multi-range and multi-line edits keep the cache equal to a fresh full index', async () => {
  const [c, { EditorState }] = await modules;
  const fixtures = ['~~~\nbody\n~~~', '~~~\n\nbody\n~~~', '> ~~~\n> body\n> ~~~',
    '> ~~~\n> body\n\nplain', '```js\nconst x = 1;\n```', '    > ~~~\n    > text',
    '   > ~~~\n   > text\n   > ~~~', 'x~~~\ntext\n~~~', '~~~\nbody\n~~~ info',
    'before\n~~~\n😀 é\n~~~\nafter', '> > ~~~\n> > body\n> > ~~~', 'plain\n\ntext'];
  const inserts = ['x', 'A', ' ', '\t', '\n', '>', '`', '~', '😀', 'é', 'info', '$x$', '\n$$\nx\n$$\n', '\n```js\nx\n```\n'];
  let seed = 0x9e3779b9;
  const next = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
  for (let i = 0; i < 300; i++) {
    let state = EditorState.create({ doc: fixtures[next(fixtures.length)], extensions: [c.markdownContext] });
    for (let j = 0; j < 50; j++) {
      const from = next(state.doc.length + 1), to = Math.min(state.doc.length, from + next(7));
      const changes = [{ from, to, insert: next(5) ? inserts[next(inserts.length)] : '' }];
      if (next(5) < 2 && to < state.doc.length) {
        const second = to + 1 + next(state.doc.length - to);
        changes.push({ from: second, to: Math.min(state.doc.length, second + next(7)), insert: inserts[next(inserts.length)] });
      }
      state = state.update({ changes }).state;
      assert.deepEqual(state.field(c.markdownContext).blocks, c.scanFencedBlocks(state.doc), `sequence ${i} step ${j}`);
    }
  }
});
test('sparse semantic contexts retain lazy ancestry and agree with a fresh scan after mixed edits',async()=>{
 const [c,{EditorState}]=await modules;
 const fixtures=['plain\n\n> quote\nlazy\n\noutside','- item\n  > quote\n  > next\n\noutside','> - item\n>   continued\n>\n> tail','> ```js\n> literal >\n> ```\nplain','- outer\n  - inner\n    continued\n\nplain','before\n> > $x>0$\n> lazy\n\n# end'];
 const inserts=['x',' ', '\n','> ','- ', '\t','😀','~~~','','$a$'];let seed=0x32152026;const next=n=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)%n};
 const snapshot=(context,pos)=>{const r=c.structuralContextAt(context,pos);return {lead:r.lead,path:r.path.map(p=>({kind:p.kind,width:p.width,from:p.from,to:p.to,parent:p.parent?{kind:p.parent.kind,from:p.parent.from,width:p.parent.width}:null}))};};
 for(let arm=0;arm<150;arm++){
  let state=EditorState.create({doc:fixtures[next(fixtures.length)],extensions:[c.markdownContext]});
  for(let i=0;i<30;i++){
   const from=next(state.doc.length+1),to=Math.min(state.doc.length,from+next(4));state=state.update({changes:{from,to,insert:inserts[next(inserts.length)]}}).state;
   const actual=state.field(c.markdownContext),fresh=c.scanStructuralContext(state.doc);
   for(let line=1;line<=state.doc.lines;line++){const l=state.doc.line(line);for(const pos of [l.from,l.from+Math.floor(l.length/2),l.to])assert.deepEqual(snapshot(actual,pos),snapshot(fresh,pos),`arm ${arm} edit ${i} position ${pos}`);}
  }
 }
 const large=EditorState.create({doc:Array.from({length:100000},(_,i)=>'plain '+i).join('\n'),extensions:[c.markdownContext]});
 assert.equal(large.field(c.markdownContext).records.length,0,'ordinary prose stores no per-line semantic clones');
 const updated=large.update({changes:{from:large.doc.length,insert:'x'}}).state;assert.equal(updated.field(c.markdownContext).rebuilt,false);assert.equal(updated.field(c.markdownContext).records.length,0);
 const empty=c.structuralContextAt(updated.field(c.markdownContext),1);assert(Object.isFrozen(empty)&&Object.isFrozen(empty.path));assert.equal(c.structuralContextAt(null,1),null);
});
test('empty/plain transitions only rescan when an adjacent semantic owner can continue',async()=>{
 const [c,{EditorState}]=await modules;
 for(const [text,rebuilt] of [['plain\n',false],['> para\n',true],['> para\n\n',false],['- item\n',true]]){
  let state=EditorState.create({doc:text,extensions:[c.markdownContext]});state=state.update({changes:{from:state.doc.length,insert:'x'}}).state;
  assert.equal(state.field(c.markdownContext).rebuilt,rebuilt,text);
  const actual=c.structuralContextAt(state.field(c.markdownContext),state.doc.length),fresh=c.structuralContextAt(c.scanStructuralContext(state.doc),state.doc.length);
  assert.equal(actual.lead,fresh.lead);assert.deepEqual(actual.path.map(p=>p.kind),fresh.path.map(p=>p.kind));
  state=state.update({changes:{from:state.doc.length-1,to:state.doc.length,insert:''}}).state;
  assert.deepEqual(state.field(c.markdownContext).blocks,c.scanFencedBlocks(state.doc));
 }
});
