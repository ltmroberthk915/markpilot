'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname, '../../..');
const load = p => import(pathToFileURL(path.join(root, p)).href);
const modules = Promise.all([load('dsh-markpilot/src-cm6/tables.js'), load('dsh-markpilot/node_modules/@codemirror/state/dist/index.js'), load('dsh-markpilot/node_modules/@codemirror/commands/dist/index.js')]);
const source = fs.readFileSync(process.env.MP_TEST_TABLE_EXTRAS || path.join(root, 'dsh-markpilot/src-cm6/extras.js'), 'utf8');
const testRequire = require('node:module').createRequire(path.join(root,'tools/quality/tests/table-capacity.test.cjs'));
const ast = testRequire('acorn').parse(source, {ecmaVersion: 'latest', sourceType: 'module'});
const body = ast.body.find(node => node.declaration?.id?.name === 'installExtras').declaration.body.body;
const start = body.find(node => node.id?.name === 'tableAt'), end = body.find(node => node.id?.name === 'tableOperation');
assert(start && end && end.start > start.start, 'actual table command block');
const makeCommand = new Function('getView','tableSpanOf','tableLead','withTableLead','isSeparatorBody','deps','toast',
  source.slice(start.start, end.end)+'\nreturn {tableOperation,splitRow};');
async function editor(text, at = 0) {
  const [table, cm, history] = await modules;
  let delta;
  const view = {state: cm.EditorState.create({doc:text, selection:{anchor:at}, extensions:[history.history()]})};
  view.dispatch = spec => {
    const transaction = view.state.update(spec);
    delta = {inserted:0, deleted:0};
    transaction.changes.iterChanges((from,to,_a,_b,insert) => {delta.inserted += insert.length; delta.deleted += to-from;});
    view.state = transaction.state;
  };
  const {splitRow,tableOperation} = makeCommand(()=>view,table.tableSpanOf,table.tableLead,table.withTableLead,table.isSeparatorBody,{},()=>{});
  return {splitRow, state:view.state, run(op) {
    assert(tableOperation(op, at)); const result = {text:view.state.doc.toString(), delta};
    assert.equal(history.undoDepth(view.state),1); assert(history.undo(view)); assert.equal(view.state.doc.toString(),text);
    assert(history.redo(view)); assert.equal(view.state.doc.toString(),result.text);
    return result;
  }};
}

test('row insertion is a local change and leaves the other Markdown rows byte-exact',async()=>{
  const long='A'.repeat(12000), note=['HEAD','','> | A | B |','> | :--- | ---: |','> | first | '+long+' |',
    ...Array.from({length:30},(_,i)=>'> row '+i+' | q'),'','TAIL'].join('\n');
  const {text,delta}=(await editor(note,note.indexOf('first'))).run('row-below');
  const lines=text.split('\n'); assert.equal(lines.length,note.split('\n').length+1);
  assert.match(lines[5],/^> \|\s*\|\s*\|$/);lines.splice(5,1);assert.equal(lines.join('\n'),note);
  assert.equal(delta.deleted,0);assert.equal(delta.inserted,text.length-note.length);
});
test('long cells and short ragged rows do not multiply alignment padding across the table',async()=>{
  for(const cell of ['X'.repeat(8192), Array(180).fill('x').join(' | ')]){
    const doc=['| A | B |','| --- | :---: |','| first | '+cell+' |',...Array.from({length:60},(_,i)=>'| '+i+' | q |')].join('\n');
    const result=(await editor(doc,doc.indexOf('first'))).run('col-left');
    assert(result.text.includes(cell));assert(result.text.length<2*doc.length+1024,'formatting cost bounded by compact input');
  }
});
test('column parser agrees with existing source cell boundaries at leading, trailing and escaped pipes',async()=>{
  const [tables]=await modules;
  for(const lead of ['', '> ', '> > ']) for(const prefix of ['', '| ']) for(let count=0;count<=4;count++){
    const header=lead+prefix+'A | Tail'+'\\'.repeat(count)+'|  ', note=header+'\n'+lead+'| --- | --- |\n'+lead+'| first | second |';
    const f=await editor(note,note.indexOf('first'));const span=tables.tableSpanOf(f.state,1);
    assert(span,header);const values=span.headerCells.map(([a,b])=>note.slice(a,b).trim());
    assert.deepEqual(f.splitRow(header),values,header);
    const result=f.run('col-right');assert(result.text.includes(values[1]),'preserve full terminal source cell in column edit');
  }
});
test('small column commands keep existing source alignment and column markers',async()=>{
 const note='Before\n\n| A | B |\n| --- | --- |\n| x | KEEP |\n\nAfter\n';
 assert.equal((await editor(note,note.indexOf(' x ')+1)).run('col-right').text,
   'Before\n\n| A   |     | B    |\n| --- | --- | ---- |\n| x   |     | KEEP |\n\nAfter\n');
});
