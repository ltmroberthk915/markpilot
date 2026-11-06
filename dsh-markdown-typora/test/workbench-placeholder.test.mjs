import {test} from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/workspace-navigation.cjs';
test('native placeholder recognizes the same workbench document across same-cwd conversations',async()=>{
 const f=fixture.make();
 await f.W.chooseWorkbenchDoc({path:'D:/A/note.md',address:'dsh-resource://file/absolute/D%3A/A/note.md',workspace:'D:/A',sessionId:'A2'});
 const tab={id:'native',contentId:'dsh-resource://file/session/A/note.md',visible:true,navigation:{revision:1},signal:new AbortController().signal};
 const tree=f.render(f.W.EditorTabRedirect,{sessionId:'A',useTabInfo:()=>({tab})});
 assert.equal(tree.props.shown,true);f.dispose();
});
test('native placeholder does not claim a different document is currently open',async()=>{
 const f=fixture.make();
 await f.W.chooseWorkbenchDoc({path:'D:/B/note.md',address:'dsh-resource://file/absolute/D%3A/B/note.md',workspace:'D:/B',sessionId:'B'});
 const tab={id:'native',contentId:'dsh-resource://file/session/A/note.md',visible:true,navigation:{revision:1},signal:new AbortController().signal};
 const tree=f.render(f.W.EditorTabRedirect,{sessionId:'A',useTabInfo:()=>({tab})});
 assert.equal(tree.props.shown,false);f.dispose();
});
