// Review aid: source execution evidence and manual acceptance stay separate.
// A run must use current product tree bytes; mere test-file presence is not evidence.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const project=path.resolve(__dirname,'..'),extension=path.resolve(project,'../Typora-Editor/extension-src');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const tree=root=>{const all=p=>fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?all(path.join(p,e.name)):[path.join(p,e.name)]);const h=crypto.createHash('sha256');for(const f of all(root).sort())h.update(path.relative(root,f).replaceAll('\\','/')+'\0'+hash(f)+'\n');return h.digest('hex');};
const current=[path.join(project,'app/main'),path.join(project,'app/renderer'),path.join(project,'app/shared'),path.join(project,'app/shell'),path.join(project,'app/preload'),path.join(extension,'out'),path.join(extension,'render')].map(tree);
// The final one-line change moves only the paste listener from document to the
// editor roots so the existing math paste listener runs first. Reuse earlier
// non-paste flows only after proving every other product byte is unchanged.
const priorFile=path.join(project,'.perf/release100-source-revisions/before-math-paste-order.json');
const prior=fs.existsSync(priorFile)?JSON.parse(fs.readFileSync(priorFile)):null;
const nonPasteTasks=new Set(['nested-math','viewflow','navigation','selection','regression','features','repairs','file-launch','protection','consistency','user-file-host','completion','math-history','math-colors','quality-boundaries','source-history','reading','ui','history-large','benchmark-after','vscode-focus','trae-focus']);
let pasteOrderOnly=false;
if(prior){
  const backup=fs.readFileSync(path.join(project,'.backups/2026-09-08-release100/media-tools-before-paste-listener-order.js'),'utf8');
  const replacement=backup.replace("document.addEventListener('paste',event=>pasteCellText(api,event),true);","for(const mode of ['ir','wysiwyg'])api.vditor[mode].element.addEventListener('paste',event=>pasteCellText(api,event),true);");
  const differences=[];let identicalFileSets=true;
  for(const [i,role]of prior.entries()){
    const walk=p=>fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(p,e.name)):[path.join(p,e.name)]);
    if(walk(role.root).length!==role.files.length)identicalFileSets=false;
    for(const file of role.files){const target=path.join(role.root,file.path);if(!fs.existsSync(target)||hash(target)!==file.sha256)differences.push(i+':'+file.path);}
  }
  pasteOrderOnly=identicalFileSets&&JSON.stringify(differences)===JSON.stringify(['1:js/media-tools.js','6:js/media-tools.js'])&&replacement!==backup&&fs.readFileSync(path.join(extension,'render/js/media-tools.js'),'utf8')===replacement&&fs.readFileSync(path.join(project,'app/renderer/js/media-tools.js'),'utf8')===replacement;
}
const runs=[];
for(const root of ['.perf/release100-source','.perf/release100-final']){
  const folder=path.join(project,root);if(!fs.existsSync(folder))continue;
  for(const name of fs.readdirSync(folder)){const file=path.join(folder,name,'task.json');if(!fs.existsSync(file))continue;const r=JSON.parse(fs.readFileSync(file));
    const exact=r.sourceTrees?.length===current.length&&r.sourceTrees.every((x,i)=>x.sha256===current[i]);
    const compatible=pasteOrderOnly&&nonPasteTasks.has(r.task)&&r.sourceTrees?.length===prior.length&&r.sourceTrees.every((x,i)=>x.sha256===prior[i].sha256);
    if(!r.passed||!exact&&!compatible||r.testOptions?.RELEASE100_GAPS_FILTER||r.testOptions?.RELEASE100_HISTORY_PROFILE)continue;
    if(r.task==='workflow-gaps'){const rows=JSON.parse(fs.readFileSync(path.join(r.output,'workflow-gaps.json')));if(rows.length<137||rows.some(x=>!x.passed))continue;}
    runs.push({...r,manifest:file,sourceCompatibility:exact?'exact current product trees':'Non-paste workflow; every product byte matches except the separately re-tested one-line paste-listener order change.'});
  }
}
const latest=name=>runs.filter(r=>r.task===name).sort((a,b)=>b.startedAt.localeCompare(a.startedAt))[0];
const backgroundFiles=['release100-background-features','release100-background-source-entities-final','release100-background-source-entities','release100-background-table-viewport-final','release100-background-table-viewport','release100-background-render-roundtrip','release100-background-visual-caret-final','release100-background-visual-caret','release100-background-final','release100-background-workflow','release100-background-resumed'].map(n=>path.join(project,'.perf',n,'results.json'));
const background=backgroundFiles.find(file=>{if(!fs.existsSync(file))return false;const r=JSON.parse(fs.readFileSync(file));return r.passed&&r.counts.pass>=291&&r.productUnchanged&&r.productFiles?.length>0&&[...r.productFiles,...r.syntax,...r.tests].every(x=>fs.existsSync(x.path)&&hash(x.path)===x.sha256);});
// Each four-row group corresponds to the reviewed plan's B + 3 E workflows.
// These descriptions identify the actual behavioral evidence, not assertion totals.
const mapping=[
  [
    [['file-launch','shell'],'Native create/open/edit/save, cold/warm launch and recent-file workflows.'],
    [['workflow-gaps','vscode-full','trae-full'],'E01: distinct full paths with identical Chinese/space/emoji basenames; real IDE reopen/host checks.'],
    [['workflow-gaps'],'E02: dirty document switch independently exercises cancel, save and discard, checking both documents on disk.'],
    [['shell'],'Recent-file failure preserves state and later valid opens recover.']
  ],[
    [['protection','user-file-host'],'Real automatic save, manual save and independent reopen of note/table content.'],
    [['source-history','protection'],'Native rapid history plus Node autosave pending-write/serialization/version tests.'],
    [['workflow-gaps','protection'],'E05: failed write retains old disk/new edit, retry succeeds; independent snapshot restoration preserves unsaved text.'],
    [['viewflow'],'External refresh releases old navigation anchor; Node tests exercise dirty conflict and concurrent external writes.']
  ],[
    [['features','shell'],'Formatting commands in three modes and native host save.'],
    [['workflow-gaps','math-history'],'E07: nested formatted boundary edit with exact undo/redo; math history preserves surrounding nodes.'],
    [['workflow-gaps'],'E08: forward/reverse Chinese, emoji and combining characters across paragraphs; cancel/history/mode roundtrip. Native terminal blank-line normalization is recorded separately.'],
    [['workflow-gaps','consistency','features','source-history'],'Real composition input and immediate history, composition command guard, source-toolbar click commit/cancel and scheduler cancellation.']
  ],[
    [['features','navigation'],'Headings, lists, quotes and subsequent source/visual navigation.'],
    [['navigation','selection'],'Repeated headings/text and source offsets identify the requested occurrence.'],
    [['workflow-gaps'],'E11: nested quote/list Enter, Tab, Backspace with undo and adjacent table/math invariants.'],
    [['repairs','navigation'],'Find/replace exact source, undo and navigation retention.']
  ],[
    [['table-context-host','workflow-gaps'],'Add/delete row and column through production menu, exact history and saved source.'],
    [['workflow-gaps'],'E13: first/last columns, header/first-body/final rows, insert/delete with exact undo/redo.'],
    [['table-context-host','math-table'],'Mixed linebreak, code, links and TeX survive structure changes and save/reparse.'],
    [['workflow-gaps'],'E15: 12-column table at 720px, target final column menu, column insertion and exact undo.']
  ],[
    [['math-table','table-input-host'],'Mouse, Tab, Shift+Tab and arrows followed by native cell input.'],
    [['workflow-gaps','math-table'],'E16: duplicate-cell reverse replacement changes only one cell; repeated preview moves preserve source.'],
    [['workflow-gaps','math-table'],'E17: native TSV, CRLF, pipes, TeX-like literals, Unicode paste, undo/redo and reparse; native math-source paste.'],
    [['math-table','workflow-gaps'],'Empty formula Backspace/Delete; old body history followed by native cell delete, immediate undo/redo/retyping, reverse Unicode selection, line breaks and composition commit/cancel. Final-cell navigation also requires manual evidence.','E18']
  ],[
    [['math-table'],'Ctrl+Shift+E wrap/unwrap on paragraph and table equals baseline.'],
    [['math-table'],'Existing/empty/partially selected formulas unwrap correctly and allow subsequent input.'],
    [['math-table'],'Fractions, matrices, pipes, dollars, backticks and incomplete TeX preserve source and table shape.'],
    [['math-table','math-history'],'Thirty alternating-speed shortcuts plus history/save/reopen and subsequent typing.']
  ],[
    [['nested-math'],'Click rendered math, click active preview, exit to ordinary text; only current source is visible.'],
    [['nested-math'],'RN paragraph first/second/third/first formula sequence; source and clean state unchanged.'],
    [['nested-math'],'Both modes, paragraph/table, bold/plain/italic/strike/triple-emphasis/link variants.'],
    [['nested-math','math-colors'],'Ordinary text between formulas receives shortcut pair without activating neighbors; color transition matrix.']
  ],[
    [['math-table','user-file-host'],'Typing then clicking another cell collapses the prior formula within the same table.'],
    [['math-table'],'Unfinished TeX plus Tab/Shift+Tab/arrows/clicks retain table and focus boundary.'],
    [['math-table','workflow-gaps'],'Final-row preview bounds and matrix source; exact HTML/entity/math table source through both mode-menu and source-toggle transitions, native source typing/history/save/reopen; narrow-window interaction also requires manual evidence.','E26'],
    [['math-table'],'Both modes run 50 seeded mixed-edit rounds, checking all untouched cells, history and saved source.']
  ],[
    [['navigation','viewflow'],'Caret location and viewport anchor are mapped between source and rendered view without source edits.'],
    [['navigation','selection'],'Duplicate table text, formula token, multiline code and images map by source instance.'],
    [['viewflow'],'Offscreen caret, empty cell and document-end entry preserve visible reading location.'],
    [['viewflow','completion','source-history'],'Late refresh, new input/completion and history release stale anchors.']
  ],[
    [['viewflow'],'Native divider drag, scroll in both panes, keyboard and persistent proportions.'],
    [['viewflow'],'Resize stress and Node observer-coalescing tests; live IDE sidebar interaction needs manual evidence.','E31'],
    [['viewflow'],'Keyboard, exit/reentry, double-click reset and Node pending-resize cancellation after destroy/mode exit.'],
    [['quality-boundaries','viewflow'],'Large-file layout and no scroll feedback; narrow split/table/formula combination needs manual evidence.','E33']
  ],[
    [['vscode-focus','trae-focus'],'Actual native AI input gets a unique marker, one attachment and unchanged source/disk; manual confirmation also required.','B12'],
    [['vscode-focus','trae-focus','selection'],'Both IDEs, three modes, reverse/repeated/cross-block/math/code ranges and reopened sidebar without scan code.'],
    [[], 'Node native-chat tests cover duplicate messages, synchronous throw, timeout, empty/late reply and stale/replaced requests.'],
    [[], 'Node host/renderer tests cover disposal, inactive editors and version changes during each awaited stage, plus composition/repeat suppression.']
  ],[
    [['completion'],'Local mocked provider: show/accept/undo/save against production host.'],
    [['completion'],'Host and Node tests discard late completion after text, selection, mode or external change.'],
    [['completion'],'Formula/table local completion preserves delimiters and current cell.'],
    [['completion'],'Mock-provider failures and malformed/long responses, composition guard and recovery.']
  ],[
    [['media-office','export'],'Actual image/formula save/reopen and HTML/PDF/DOCX outputs with source preservation.'],
    [['workflow-gaps','media-office'],'E40: native Office HTML table clipboard, literal identifiers and Unicode, undo/repeat; OMML/PUA conversion covered by Node tests.'],
    [['media-lifecycle','media-office'],'Image deletion/undo, resource lifetime, scale changes and moved single-file reopen.'],
    [['export'],'Resource failure/cancel/path guards and hostile HTML; long export and actual PDF inspection are separate evidence.','E42']
  ],[
    [['math-colors','reading','ui'],'Theme/palette/font/reading changes retain source and usable editor controls.'],
    [['math-colors','nested-math'],'Expanded math transitions and nested formulas remain independently readable.'],
    [['math-table','ui'],'Preview bounds and layout controls; large-font narrow-window combined state needs manual evidence.','E44'],
    [['reading','ui','navigation'],'Outline/read/source view changes, restored caret and subsequent native input.']
  ],[
    [['file-launch','viewflow','vscode-focus','trae-focus'],'Open/edit/split/save/native AI flows with runtime error capture; all selected executions must pass.'],
    [['benchmark-after'],'Twelve identical before/after pairs, warm seven-run medians and exact anchor/fixture hash verifier.','E46'],
    [['quality-boundaries','source-history','history-large'],'Thresholds at 150000/900000, native tail editing/history/save and retained large-note render nodes.'],
    [[], 'Version 1.0.0 private artifacts, complete file coherence, final package tests and portable/IDE manual evidence.','E48']
  ]
];
const plan=JSON.parse(fs.readFileSync(path.join(project,'docs/RELEASE100-SATURATED-PLAN.json')));
const manualFile=path.join(project,'.perf/release100-delivery/manual-acceptance.json'),manual=fs.existsSync(manualFile)?JSON.parse(fs.readFileSync(manualFile)):{};
const cases=plan.cases.map((c,i)=>{
  const [tasks,basis,manualId]=mapping[Math.floor(i/4)][i%4],evidence=tasks.map(latest),missing=tasks.filter((_,j)=>!evidence[j]);
  const manualEvidence=manualId?manual[manualId]:null;
  return{...c,reviewedBasis:basis,executionStatus:!background?'pending-current-node-suite':missing.length?'pending-current-code-run':manualId&&!manualEvidence?.passed?'pending-manual-or-artifact-evidence':'source-evidence-ready',missingTasks:missing,evidence:evidence.filter(Boolean).map(r=>({task:r.task,manifest:r.manifest,executionScope:r.executionScope,sourceCompatibility:r.sourceCompatibility})),backgroundEvidence:background,manualEvidence};
});
const report={checkedAt:new Date().toISOString(),scope:'Reviewed workflow mapping; does not replace artifact/visual acceptance or claim every possible interaction was enumerated.',counts:plan.counts,currentProductTrees:current,cases,pending:cases.filter(c=>c.executionStatus!=='source-evidence-ready').map(c=>({id:c.id,missing:c.missingTasks,status:c.executionStatus}))};
const output=path.join(project,'.perf/release100-delivery');fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'coverage.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({counts:report.counts,ready:cases.length-report.pending.length,missingTasks:[...new Set(report.pending.flatMap(x=>x.missing))],manualPending:report.pending.filter(x=>!x.missing.length)},null,2));
