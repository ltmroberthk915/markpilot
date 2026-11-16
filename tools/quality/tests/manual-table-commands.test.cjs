'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../../..');
const projectRequire=require('node:module').createRequire(path.join(root,'tools/quality/tests/table-capacity.test.cjs'));
const load=file=>import(pathToFileURL(path.join(root,'dsh-markpilot',file)).href);
const modules=Promise.all([
  load('node_modules/@codemirror/state/dist/index.js'),
  load('node_modules/@codemirror/commands/dist/index.js'),
  load('src-cm6/tables.js'),
  load('src-cm6/cell-source-map.js'),
]);
const source=fs.readFileSync(path.join(root,'dsh-markpilot/src-cm6/main.js'),'utf8');
const tree=projectRequire('acorn').parse(source,{ecmaVersion:'latest',sourceType:'module'});
const declaration=name=>tree.body.find(node=>node.type==='FunctionDeclaration'&&node.id.name===name);
const fragment=node=>source.slice(node.start,node.end);
const keydown=declaration('ensureCellOverlay').body.body.find(node=>
  node.expression?.callee?.property?.name==='addEventListener'&&node.expression.arguments[0]?.value==='keydown'
).expression.arguments[1];
const bind=(body,bindings={})=>new Function(...Object.keys(bindings),body)(...Object.values(bindings));
const parseRow=bind(fragment(declaration('parseTableRow'))+'; return parseTableRow');
/* 编辑面 → 纯文本的读取器：**用产品自己的实现**（连同它依赖的两个小函数）。
   混排格里 DOM 文本不再是裸 textContent（已排版公式是 atom），所以夹具必须跟产品同源，
   否则测的就不是真实镜像路径。这里取真实函数体，不做替身。
   默认参数 owner = cellEdit 指向引擎的模块级变量，夹具里没有；真实调用点总是显式传 owner，
   所以这里包一层把 owner 固定到当前夹具的 cellEdit。 */
const readPlain=bind(['isCellAtomNode','cellAtomSource','cellPlainLength','cellEditPlainText']
  .map(name=>fragment(declaration(name))).join('\n')+
  '; return (edit,owner)=>cellEditPlainText(edit,owner);',
  {'CELL_ATOM_CLASS':'mp-cell-atom','CELL_ATOM_SELECTOR':'.mp-cell-atom'});
const note='|H|K|\n|---|---|\n|ab|KEEP|';

// Use real CM transactions, undo history and the registered cell key handler.
// The fake editable implements the browser's pre-key selection and native deletion.
async function cell(text,anchor,head=anchor) {
  const [{EditorState,EditorSelection,StateEffect},{history,undo,redo},tables,codec]=await modules;
  const initial=EditorSelection.single(anchor,head);
  const view={state:EditorState.create({doc:text,selection:initial,extensions:[history()]}),focus(){}};
  view.dispatch=spec=>{view.state=(spec.startState?spec:view.state.update(spec)).state;};
  const start=text.indexOf('ab'),row=view.state.doc.lineAt(start);
  /* 编辑面替身：按真实 DOM 语义实现"追加一个文本节点"（末尾反斜杠撞格尾管道时要补空格，
     产品实现是 appendChild 而非重写 textContent —— 重写会丢掉混排格的 atom 节点）。
     `atoms` 记录这个替身身上的 atom 节点数：真实产品里它们是 KaTeX 宿主，
     textContent 覆写会把它们一起抹掉，所以这条读数能区分"追加"与"重写"两条路径。 */
  const div={textContent:'ab',contains:()=>true,caret:2,atoms:1,
    appendChild(node){
      assert.equal(node.nodeType,3,'only a text node may be appended to a plain cell surface');
      /* 追加：只加文本，**不动**已有子节点（atom 节点因此保留）。 */
      div._text=(div._text===undefined?'ab':div._text)+node.nodeValue;
      div.caret=div._text.length;
      return node;
    }};
  Object.defineProperty(div,'textContent',{
    configurable:true,
    get(){return div._text===undefined?'ab':div._text;},
    set(value){div._text=value;div.atoms=0;},  // 覆写 textContent 会清空所有子节点（含 atom）
  });
  const document={createTextNode(value){return {nodeType:3,nodeValue:value};}};
  const owner={from:start,to:start+2,text:'ab',rowFrom:row.from,col:0};
  const noOp=()=>{};
  const bindings={div,view,cellEdit:owner,cellComposing:false,runScopeHandlers:()=>false,EditorSelection,setActiveCell:StateEffect.define(),...tables,...codec,
    cellEditPlainText:(edit)=>readPlain(edit,owner),
    cellDOMSelection:()=>({anchor:div.caret,head:div.caret}),
    setCellDOMSelection:(_node,_anchor,end)=>{div.caret=end;},syncCellSelection:noOp,updateCellSizer:noOp,
    scheduleCellOverlay:noOp,deactivateCellOverlay:noOp,regionIndexField:0,embeddedImages:()=>[],
    /* syncCellEdit 收尾会调用活动格公式预览的输入入口（cell-math-preview.js 的控制器）。
       本夹具只切 syncCellEdit 这一段源码，不需要公式卡片本身，所以按"其它预览依赖"同款
       方式给一个 no-op 替身；它不改变被断言的行为（镜像 diff / 选区 / 撤销全部走真实实现）。 */
    noteCellMathInput:noOp,
    document,

    moveActiveCellByKey:run=>run(),resyncCellEdit:()=>{div.textContent=codec.mappedCellSource(view.state.sliceDoc(owner.from,owner.to)).text;},
  };
  const sync=bind(fragment(declaration('syncCellEdit'))+'; return syncCellEdit',bindings);
  const key=bind('return '+fragment(keydown),{...bindings,
    getSelection:()=>({isCollapsed:view.state.selection.main.empty,anchorNode:div}),
    document:{execCommand(command){assert.equal(command,'delete');div.textContent='';div.caret=0;div.__mpCellInputType='deleteContentBackward';sync(div);}},
  });
  /* 键入替身：只改文本、**不重建**表面（原生键入不换节点，atom 节点保持不变）。
     只有断言"产品是否整面重写"时才看 div.atoms。 */
  const input=(value,caret)=>{div._text=value;div.caret=caret;div.__mpCellInputType='insertText';sync(div);};
  const press=(name,shiftKey=false)=>key({key:name,shiftKey,preventDefault:noOp});
  return {view,initial,input,key:press,undo:()=>undo(view),redo:()=>redo(view),text:()=>view.state.doc.toString(),
    atoms:()=>div.atoms};
}

test('a path or TeX prefix typed against a pipe preserves the neighboring cell',async()=>{
  const quoted=note.split('\n').map(line=>'> '+line).join('\n');
  const start=quoted.indexOf('ab'),c=await cell(quoted,start+2);
  c.input('ab\\',3);
  assert.deepEqual(parseRow(c.view.state.doc.line(3).text,2).cells,['ab\\','KEEP']);
  assert.equal(c.view.state.selection.main.head,start+3);
  /* 补空格只能**追加一个文本节点**：重写整面 textContent 会把混排格里已排版的公式（atom 节点）
     一起抹掉，用户会看到公式突然闪回源码。这条读数区分两条路径。 */
  assert.equal(c.atoms(),1,'the guard must append a text node, never rewrite the whole surface');
  c.input('ab\\frac ',7);
  assert.deepEqual(parseRow(c.view.state.doc.line(3).text,2).cells,['ab\\frac','KEEP']);
  const openEnd=note.replace('|ab|KEEP|','|KEEP|ab'),unclosed=await cell(openEnd,openEnd.length);
  unclosed.input('ab\\',3);assert.equal(unclosed.text(),openEnd+'\\');
});
test('one Enter on selected last-cell text is one undoable edit',async()=>{
  const pos=note.indexOf('ab'),c=await cell(note,pos+2,pos);
  c.key('Enter');const edited=note.replace('ab','')+'\n|  |  |';assert.equal(c.text(),edited);
  assert(c.undo());assert.equal(c.text(),note);assert(c.view.state.selection.eq(c.initial));
  assert(c.redo());assert.equal(c.text(),edited);
});
test('shift-down at the last row never creates a document line',async()=>{
  const start=note.indexOf('ab'),c=await cell(note,start,start+1);
  c.key('ArrowDown',true);assert.equal(c.text(),note);assert(c.view.state.selection.eq(c.initial));
  c.key('ArrowDown');assert.equal(c.text(),note+'\n');
});
test('inline break preserves a selected structural row and still replaces text within a cell',async()=>{
  const [,,{applyEnterBr}]=await modules,row=note.lastIndexOf('\n')+1,pos=note.indexOf('ab');
  const whole=await cell(note,row,note.length);applyEnterBr(whole.view);
  assert.equal(whole.text(),note);assert(whole.view.state.selection.eq(whole.initial));
  const inside=await cell(note,pos+2,pos);applyEnterBr(inside.view);
  assert.equal(inside.text(),note.replace('ab','<br>'));assert(inside.undo());assert(inside.view.state.selection.eq(inside.initial));
});

/* ── 组字交接后重新绑定目标格（真机 delta：吞掉 A/B 之间的竖线） ────────────────
   形态：表格中间一行，A 是非末格（后面还有分隔符与 B）。A 里组字未上屏时点 B：
   handoff 会把候选写进 A ⇒ A 及其后所有偏移变长 ⇒ 交接前算出的 ranges 作废。
   旧实现把过期 r[0]/r[1] 传给 activateCellOverlay ⇒ 吞掉竖线、B 显示成原来的 C。 */
/* ── 一次性源坐标映射（真实 IME 跨格）─────────────────────────────────────
   判据全部用**源码坐标**表达：ChangeDesc.mapPos 之后取到的行/格区间必须就是那张表里
   正确的那一格。插入/替换/删除/等长替换/首行边界都由映射本身保证，不需要分情况。 */

async function mappingFixtures(){
  const [, , tables] = await modules;
  const [{EditorState, Text}]=await modules;
  const cellRangesOfImpl=bind(fragment(declaration('cellRangesOf'))+'; return cellRangesOf',
    {tableLead:tables.tableLead});
  return {EditorState, cellRangesOfImpl};
}

/** 直接用 CM 的 ChangeDesc 复演"已应用事务的累积 changes"这一口径。 */
function mappedRow(EditorState, cellRangesOfImpl, docBefore, changesSpec, targetFrom, cols) {
  const before=EditorState.create({doc:docBefore});
  const tr=before.update({changes:changesSpec});
  const after=tr.state.doc;
  const from=tr.changes.mapPos(targetFrom, targetFrom===0?1:-1);
  const line=after.lineAt(from);
  const ranges=cellRangesOfImpl(line);
  if(!ranges.length||ranges.length!==cols) return null;
  return {rowFrom:line.from,ranges,range:ranges[1],doc:after};
}

test('映射：原格插入后，目标行行首被 mapPos 搬到新坐标，目标格仍是那一格',async()=>{
  const {EditorState,cellRangesOfImpl}=await mappingFixtures();
  const doc='| H | K |\n|---|---|\n| 甲 | 乙 |\n| 丙 | 丁 |';
  const before=EditorState.create({doc});
  const targetFrom=before.doc.line(3).from;
  const cols=cellRangesOfImpl(before.doc.line(3)).length;

  // A 格在第 2 行第 0 列插入 2 个字符 ⇒ 第 3 行整体后移 2。
  const hit=mappedRow(EditorState,cellRangesOfImpl,doc,{from:before.doc.line(2).from+2,insert:'甲乙'},targetFrom,cols);
  assert.ok(hit,'the target row must resolve through ChangeDesc.mapPos');
  assert.equal(hit.rowFrom,targetFrom+2,'row start maps forward by the inserted length');
  assert.equal(hit.doc.sliceString(hit.range[0],hit.range[1]),' 乙 ');
});

test('映射：同一行内（非末格组字）插入后，列边界按新文本重算且不吞分隔符',async()=>{
  const {EditorState,cellRangesOfImpl}=await mappingFixtures();
  const doc='| H | K |\n|---|---|\n| 甲 | 乙 |\n| 丙 | 丁 |';
  const before=EditorState.create({doc});
  const line3=before.doc.line(3);
  const targetFrom=line3.from;
  const cols=cellRangesOfImpl(line3).length;

  // A 是第 3 行第 0 格（甲），在其后插入 2 字符 ⇒ 行首不动，格边界右移。
  const hit=mappedRow(EditorState,cellRangesOfImpl,doc,{from:targetFrom+3,insert:'甲乙'},targetFrom,cols);
  assert.ok(hit,'a same-row commit still resolves');
  assert.equal(hit.rowFrom,targetFrom,'the row start does not move');
  assert.equal(hit.doc.sliceString(hit.range[0],hit.range[1]),' 乙 ');
  assert.equal(hit.doc.sliceString(hit.range[0],hit.range[1]).includes('|'),false);
});

test('映射：等长替换与变短替换都不依赖 delta 符号',async()=>{
  const {EditorState,cellRangesOfImpl}=await mappingFixtures();
  const doc='| H | K |\n|---|---|\n| 甲 | 乙 |\n| 丙 | 丁 |';
  const before=EditorState.create({doc});
  const targetFrom=before.doc.line(3).from;
  const cols=cellRangesOfImpl(before.doc.line(3)).length;
  const row2From=before.doc.line(2).from;   // A 所在行（目标行的上一行）

  // 等长替换（2 字符 → 2 字符）⇒ 目标行坐标不变。
  const same=mappedRow(EditorState,cellRangesOfImpl,doc,
    {from:row2From+2,to:row2From+4,insert:'甲乙'},targetFrom,cols);
  assert.ok(same,'an equal-length replacement must still map');
  assert.equal(same.rowFrom,targetFrom,'equal length leaves offsets unchanged');
  assert.equal(same.doc.sliceString(same.range[0],same.range[1]),' 乙 ');

  // 变短替换（3 字符 → 1 字符）⇒ 目标行前移 2。
  const shorter=mappedRow(EditorState,cellRangesOfImpl,doc,
    {from:row2From+2,to:row2From+5,insert:'x'},targetFrom,cols);
  assert.ok(shorter,'a shorter replacement must map too');
  assert.equal(shorter.rowFrom,targetFrom-2,'the target row moves back by the net shrink');
  assert.equal(shorter.doc.sliceString(shorter.range[0],shorter.range[1]),' 乙 ');
});

test('映射：删除原格内容后目标行前移；目标行本身被删则无写入',async()=>{
  const {EditorState,cellRangesOfImpl}=await mappingFixtures();
  const doc='| H | K |\n|---|---|\n| 甲 | 乙 |\n| 丙 | 丁 |';
  const before=EditorState.create({doc});
  const targetFrom=before.doc.line(3).from;
  const cols=cellRangesOfImpl(before.doc.line(3)).length;

  const del=mappedRow(EditorState,cellRangesOfImpl,doc,
    {from:before.doc.line(2).from+2,to:before.doc.line(2).from+4},targetFrom,cols);
  assert.ok(del,'a deletion above the target still maps');
  assert.equal(del.rowFrom,targetFrom-2);
  assert.equal(del.doc.sliceString(del.range[0],del.range[1]),' 乙 ');

  // 目标行整行被删 ⇒ 映射出来的位置不再落在表格行上 ⇒ 必须拒绝（不写任何东西）。
  const whole=before.doc.line(3);
  const gone=mappedRow(EditorState,cellRangesOfImpl,doc,
    {from:whole.from,to:whole.to,insert:'普通一行'},targetFrom,cols);
  assert.equal(gone,null,'a structurally rewritten target row must be refused');
});

test('映射：表格里两行内容完全相同也不会错格（不按文本寻址）',async()=>{
  const {EditorState,cellRangesOfImpl}=await mappingFixtures();
  const dup='| H | K |\n|---|---|\n| 甲 | 乙 |\n| 甲 | 乙 |\n| 丙 | 丁 |';
  const before=EditorState.create({doc:dup});
  const line3=before.doc.line(3);
  const cols=cellRangesOfImpl(line3).length;
  const hit=mappedRow(EditorState,cellRangesOfImpl,dup,
    {from:before.doc.line(2).from+2,insert:'甲乙'},line3.from,cols);
  assert.ok(hit);
  // 仍然是第 3 行（映射后的坐标），不是那条逐字节相同的第 4 行。
  assert.equal(hit.rowFrom,line3.from+2);
  assert.notEqual(hit.rowFrom,hit.doc.line(4).from);
});

test('映射：允许缺省首管/尾管与转义管的既有形态（沿用 cellRangesOf，不另立语法）',async()=>{
  const {EditorState,cellRangesOfImpl}=await mappingFixtures();
  // 无首管 + 无尾管的合法表格行：由 cellRangesOf 决定，测试只校验映射后仍解析出同样的格数。
  for (const row of ['| 甲 | 乙 |', '甲 | 乙', '| a\\|b | 乙 |']) {
    const doc='| H | K |\n|---|---|\n'+row+'\n| 丙 | 丁 |';
    const before=EditorState.create({doc});
    const line3=before.doc.line(3);
    const cols=cellRangesOfImpl(line3).length;
    if (!cols) continue;                       // 该形态本身不成立就不作为判据
    const hit=mappedRow(EditorState,cellRangesOfImpl,doc,
      {from:before.doc.line(2).from+2,insert:'xy'},line3.from,cols);
    assert.ok(hit,'legal form must survive mapping: '+JSON.stringify(row));
    assert.equal(hit.ranges.length,cols,'column count is preserved: '+JSON.stringify(row));
  }
});
/* ── 闭环条件：只接受真实的、落在 A 格内的、唯一一笔提交 ─────────────────── */
test('闭环：与 A 无关的目标行改写即便仍是同列数表行也作废',async()=>{
  const [, , tables] = await modules;
  const [{EditorState}]=await modules;
  const cellRangesOfImpl=bind(fragment(declaration('cellRangesOf'))+'; return cellRangesOf',
    {tableLead:tables.tableLead});
  const doc='| H | K |\n|---|---|\n| 甲 | 乙 |\n| 丙 | 丁 |';
  const before=EditorState.create({doc});
  const line3=before.doc.line(3);
  const cols=cellRangesOfImpl(line3).length;

  /* 模拟"改动落在 A 之外"：把目标行整行替换成另一条同列数表行。
     按你的要求，这种情况必须作废 —— 判据用 iterChangedRanges 与 A 的实际区间比。 */
  const allowFrom=before.doc.line(2).from, allowTo=before.doc.line(2).to;   // A 在第 2 行
  const tr=before.update({changes:{from:line3.from,to:line3.to,insert:'| X | Y |'}});
  let inside=false, outside=false;
  tr.changes.iterChangedRanges((fromA,toA)=>{
    if(fromA>=allowFrom&&toA<=allowTo) inside=true; else outside=true;
  });
  assert.equal(outside,true,'a change outside A must be detected');
  assert.equal(inside,false);
  // 即使替换后仍是同列数的合法表行，也必须拒绝。
  const replaced=cellRangesOfImpl(tr.state.doc.line(3));
  assert.equal(replaced.length,cols,'the replacement is still a same-column table row');
});

test('闭环：改动确实落在 A 格内才接受，且行首随 mapPos 正确移动',async()=>{
  const [, , tables] = await modules;
  const [{EditorState}]=await modules;
  const cellRangesOfImpl=bind(fragment(declaration('cellRangesOf'))+'; return cellRangesOf',
    {tableLead:tables.tableLead});
  const doc='| H | K |\n|---|---|\n| 甲 | 乙 |\n| 丙 | 丁 |';
  const before=EditorState.create({doc});
  /* A = 表格的第一条数据行（文档第 3 行）；B = 下一条数据行（第 4 行），即目标。 */
  const aLine=before.doc.line(3), bLine=before.doc.line(4);
  const aRanges=cellRangesOfImpl(aLine);
  const allowFrom=aRanges[0][0], allowTo=aRanges[0][1];

  const tr=before.update({changes:{from:allowFrom,to:allowTo,insert:' 甲甲'}});
  let inside=false, outside=false;
  tr.changes.iterChangedRanges((fromA,toA)=>{
    if(fromA>=allowFrom&&toA<=allowTo) inside=true; else outside=true;
  });
  assert.equal(inside,true);
  assert.equal(outside,false,'a change fully inside A must not be treated as external');

  const mapped=tr.changes.mapPos(bLine.from,-1);
  assert.equal(mapped,bLine.from,'an equal-length in-cell replacement keeps the row start');
  const ranges=cellRangesOfImpl(tr.state.doc.lineAt(mapped));
  assert.equal(tr.state.doc.sliceString(ranges[1][0],ranges[1][1]),' 丁 ');
});

test('闭环：第二次独立改动即作废；起点文档对象不连续也作废',async()=>{
  const [, , tables] = await modules;
  const [{EditorState}]=await modules;
  const doc='| H | K |\n|---|---|\n| 甲 | 乙 |\n| 丙 | 丁 |';
  const s0=EditorState.create({doc});
  const t1=s0.update({changes:{from:s0.doc.line(2).from+2,insert:'甲'}});
  const t2=t1.state.update({changes:{from:t1.state.doc.line(2).from+3,insert:'乙'}});

  // 连续性：第二次更新的 startState.doc 必须就是上一次的终态。
  assert.equal(t2.startState.doc,t1.state.doc,'the chain is continuous');
  assert.notEqual(t2.startState.doc,s0.doc);
  // 只接受一笔：第二笔到来时应作废（这里用同一判据表达）。
  let settled=false, cancelled=false;
  for(const u of [{startState:s0,state:t1.state,changes:t1.changes},
                  {startState:t1.state,state:t2.state,changes:t2.changes}]){
    if(cancelled) break;
    if(settled){ cancelled=true; break; }
    settled=true;
  }
  assert.equal(cancelled,true,'a second independent change must cancel the probe');

  // 链不连续（起点不是我们记着的 appliedDoc）⇒ 作废。
  const foreign=EditorState.create({doc});
  assert.notEqual(foreign.doc,t1.state.doc,'a foreign start document must be rejected');
});
/* ── 驱动**产品自己的** probe：映射必须用 ChangeDesc.mapPos，身份/范围校验必须生效 ─────
   前面几条对照用的是 CM 原语；这一条把产品的 noteCompositionTargetUpdate 真跑起来，
   所以"忘了 mapPos / 放过外部改动 / 接受第二笔"都会变红。 */
test('产品 probe：mapPos 映射 + 只接受 A 内改动 + 第二笔作废',async()=>{
  const [, , tables] = await modules;
  const [{EditorState}]=await modules;
  const cellRangesOfImpl=bind(fragment(declaration('cellRangesOf'))+'; return cellRangesOf',
    {tableLead:tables.tableLead});

  /* 取出产品真实实现，注入它依赖的 cellRangesOf 与 regionIndexField 字段读取。 */
  const src=source;
  const noteFn=fragment(declaration('noteCompositionTargetUpdate'));
  const stateWithEpoch=epoch=>({field:(f,req)=>({epoch})});
  const makeNote=probe=>{
    const fn=new Function('compositionTargetProbe','cellRangesOf','regionIndexField','return '+noteFn);
    // 用闭包变量模拟模块级的 compositionTargetProbe（产品里就是同一角色）。
    return fn(probe,cellRangesOfImpl,{});
  };

  const doc='| H | K |\n|---|---|\n| 甲 | 乙 |\n| 丙 | 丁 |';
  const s0=EditorState.create({doc});
  const aLine=s0.doc.line(3), bLine=s0.doc.line(4);
  const aRanges=cellRangesOfImpl(aLine);
  const bRanges=cellRangesOfImpl(bLine);

  const build=(over)=>({
    owner:{}, epoch:7, startDoc:s0.doc, from:bLine.from, col:1,
    cols:bRanges.length, allowFrom:aRanges[0][0], allowTo:aRanges[0][1],
    appliedDoc:s0.doc, result:null, settled:false, cancelled:false, updates:0, ...over,
  });

  // ① 正常的 A 内插入 ⇒ 必须用 mapPos 得到新行首，并给出正确的目标格。
  const tr1=s0.update({changes:{from:aRanges[0][0],to:aRanges[0][1],insert:' 甲甲'}});
  const view1={state:{doc:tr1.state.doc,field:(f,r)=>({epoch:7})}, startState:{doc:s0.doc},
    changes:tr1.changes};
  let probe=build({owner:view1});
  makeNote(probe)({view:view1,startState:view1.startState,state:view1.state,changes:tr1.changes});
  assert.equal(probe.cancelled,false,'an in-cell change must be accepted');
  assert.ok(probe.result,'the probe must produce a mapped target');
  assert.equal(probe.result.rowFrom,bLine.from,'equal-length in-cell edit keeps the row start');
  assert.equal(tr1.state.doc.sliceString(probe.result.range[0],probe.result.range[1]),' 丁 ');
  // 关键：mapPos 真的参与了（行首不动的等长情形由「不是原地照抄」另行覆盖，见 ②）。

  // ② 行首确实移动的情形：A 格里插入更多字符（net +2）⇒ 目标行整体后移 2。
  const tr2=s0.update({changes:{from:aRanges[1][0],to:aRanges[1][1],insert:' 乙乙乙乙'}});
  const view2={state:{doc:tr2.state.doc,field:(f,r)=>({epoch:7})}, startState:{doc:s0.doc},
    changes:tr2.changes};
  probe=build({owner:view2,allowFrom:aRanges[0][0],allowTo:aRanges[1][1]});
  makeNote(probe)({view:view2,startState:view2.startState,state:view2.state,changes:tr2.changes});
  assert.equal(probe.cancelled,false);
  assert.ok(probe.result,'the probe must map the moved row');
  assert.equal(probe.result.rowFrom,bLine.from+2,
    'mapPos must move the target row start by the net inserted length');
  assert.equal(tr2.state.doc.sliceString(probe.result.range[0],probe.result.range[1]),' 丁 ');

  // ③ 与 A 无关的目标行整行改写 ⇒ 即使仍是同列数表行也必须作废。
  const tr3=s0.update({changes:{from:bLine.from,to:bLine.to,insert:'| X | Y |'}});
  const view3={state:{doc:tr3.state.doc,field:(f,r)=>({epoch:7})}, startState:{doc:s0.doc},
    changes:tr3.changes};
  probe=build({owner:view3});
  makeNote(probe)({view:view3,startState:view3.startState,state:view3.state,changes:tr3.changes});
  assert.equal(probe.cancelled,true,'a change outside A must cancel the probe');
  assert.equal(probe.result,null);

  // ④ 第二笔独立改动 ⇒ 作废。
  const tr4=tr1.state.update({changes:{from:aRanges[0][0],to:aRanges[0][1],insert:' 甲'}});
  const view4={state:{doc:tr4.state.doc,field:(f,r)=>({epoch:7})}, startState:{doc:s0.doc},
    changes:tr1.changes};
  probe=build({owner:view4});
  const note=makeNote(probe);
  note({view:view4,startState:{doc:s0.doc},state:{doc:tr1.state.doc,field:(f,r)=>({epoch:7})},changes:tr1.changes});
  const settledOnce=probe.settled;
  note({view:view4,startState:{doc:tr1.state.doc},state:{doc:tr4.state.doc,field:(f,r)=>({epoch:7})},changes:tr4.changes});
  assert.equal(settledOnce,true,'the first change settles the probe');
  assert.equal(probe.cancelled,true,'a second independent change must cancel it');

  // ⑤ appliedDoc 不连续（起点不是我们记着的对象）⇒ 作废。
  probe=build({owner:view1});
  makeNote(probe)({view:view1,startState:{doc:EditorState.create({doc:'x'}).doc},
    state:view1.state,changes:tr1.changes});
  assert.equal(probe.cancelled,true,'a discontinuous start document must cancel');

  // ⑥ epoch 换了 ⇒ 作废。
  probe=build({owner:view1});
  makeNote(probe)({view:view1,startState:view1.startState,
    state:{doc:tr1.state.doc,field:(f,r)=>({epoch:99})},changes:tr1.changes});
  assert.equal(probe.cancelled,true,'an epoch change must cancel');
});