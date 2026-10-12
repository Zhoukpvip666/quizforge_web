import test from 'node:test';
import assert from 'node:assert/strict';
import {createEditorSession} from '../../web/editor/editor-session.js';

function entry({changed=false, invalid=false, title='题名'}={}) {
  const calls=[];
  const form={title,invalid,changed};
  const value={form,calls,removed:false,destroyed:false,plugin:{
    get isDirty(){return form.changed;},
    async getDocument({checkOnly=false}={}) {
      calls.push(checkOnly?'check':'validate');
      if(!checkOnly&&form.invalid)throw new Error('请填写题干。');
      return {changed:form.changed,document:checkOnly?undefined:{title:form.title,data:{stem:'题干'}}};
    },
    destroy(){value.destroyed=true;}
  },container:{remove(){value.removed=true;}}};
  return value;
}

test('suspension releases an invalid form only after durable draft confirmation',async()=>{
  let confirm;const saved=[];
  const session=createEditorSession({persistDraft:(id,value,snapshot)=>{saved.push({id,draft:snapshot.draft});return new Promise(resolve=>{confirm=resolve;});}});
  const first=entry({changed:true,invalid:true,title:''});first.value={revision:4,contentVersion:'fixed'};first.plugin.exportDraft=async()=>({supported:true,changed:true,draft:{title:'',stem:''}});
  session.add('q1',first);const leaving=session.suspend('q1');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(first.destroyed,false);assert.deepEqual(saved,[{id:'q1',draft:{title:'',stem:''}}]);
  confirm();await leaving;assert.equal(first.destroyed,true);assert.equal(first.plugin,null);assert.equal(first.changed,true);assert.equal(first.draft,null);assert.equal(await session.hasChanges(),true);
});

test('session retains the original unfinished form without invoking valid-document reads',async()=>{
  const session=createEditorSession(),first=entry({changed:true,invalid:true,title:''});
  session.add('q1',first);session.add('q2',entry());
  assert.equal(session.get('q1'),first);
  assert.equal(session.isDirty,true);
  assert.equal(await session.hasChanges(),true);
  assert.deepEqual(first.calls,['check']);
  assert.equal(session.get('q1').form.title,'');
  assert.equal(first.destroyed,false);
});

test('a later invalid question prevents every write and identifies the preserved form',async()=>{
  const session=createEditorSession(),valid=entry({changed:true}),invalid=entry({changed:true,invalid:true});
  session.add('q1',valid);session.add('q2',invalid);
  const writes=[];
  await assert.rejects(session.saveAll(change=>writes.push(change.id)),error=>error.questionId==='q2'&&error.savedCount===0&&error.phase==='validation');
  assert.deepEqual(writes,[]);
  assert.equal(session.get('q2'),invalid);
  assert.equal(invalid.destroyed,false);
});

test('save all validates only changed questions and persists each complete document',async()=>{
  const session=createEditorSession(),first=entry({changed:true,title:'第一题'}),clean=entry({invalid:true}),last=entry({changed:true,title:'第三题'});
  session.add('q1',first);session.add('q2',clean);session.add('q3',last);
  const writes=[],confirmed=[];
  const count=await session.saveAll(async change=>{writes.push({id:change.id,document:change.document});return {revision:8};},(change,value)=>{confirmed.push([change.id,value.revision]);change.entry.form.changed=false;});
  assert.equal(count,2);
  assert.deepEqual(writes.map(value=>[value.id,value.document.title]),[['q1','第一题'],['q3','第三题']]);
  assert.deepEqual(clean.calls,['check']);
  assert.deepEqual(confirmed,[['q1',8],['q3',8]]);
  assert.equal(session.isDirty,false);
});

test('a failed later save reports committed questions and preserves all unsaved editors for retry',async()=>{
  const session=createEditorSession(),first=entry({changed:true}),last=entry({changed:true});
  session.add('q1',first);session.add('q2',last);
  const writes=[];
  await assert.rejects(session.saveAll(async change=>{writes.push(change.id);if(change.id==='q2')throw new Error('connection lost');return {};},change=>{change.entry.form.changed=false;}),error=>error.questionId==='q2'&&error.savedCount===1&&error.pendingCount===1&&error.phase==='saving');
  assert.deepEqual(writes,['q1','q2']);
  assert.equal(first.form.changed,false);
  assert.equal(last.form.changed,true);
  assert.equal(session.get('q2'),last);
  assert.equal(await session.hasChanges(),true);
});

test('removing a clean editor and destroying a session release every retained frame exactly once',()=>{
  const session=createEditorSession(),first=entry(),second=entry({changed:true});
  session.add('q1',first);session.add('q2',second);
  session.remove('q1');assert.equal(session.get('q1'),undefined);
  assert.equal(first.destroyed,true);assert.equal(first.removed,true);
  assert.equal(session.get('q2'),second);
  session.destroy();session.destroy();
  assert.equal(second.destroyed,true);assert.equal(second.removed,true);
  assert.equal(session.values().length,0);assert.equal(session.isDirty,false);
});

test('confirmed source changes advance only editors opened from the same snapshot',async()=>{
  const session=createEditorSession({persistDraft:async()=>{}}),first=entry({changed:true}),second=entry({changed:true}),older=entry({changed:true});
  first.value={revision:1,contentVersion:'question-1',sourceVersion:'source-1'};
  second.value={revision:2,contentVersion:'question-2',sourceVersion:'source-1'};
  older.value={revision:3,contentVersion:'question-3',sourceVersion:'source-0'};
  second.plugin.exportDraft=async()=>({supported:true,changed:true,draft:{unfinished:''}});
  session.add('q1',first);session.add('q2',second);session.add('q3',older);
  await session.suspend('q2');
  session.confirmSourceVersion('source-1','source-2');
  assert.equal(first.value.sourceVersion,'source-2');assert.equal(second.value.sourceVersion,'source-2');assert.equal(older.value.sourceVersion,'source-0');
  assert.equal(first.value.contentVersion,'question-1');assert.equal(second.value.contentVersion,'question-2');assert.equal(second.changed,true);
  session.confirmSourceVersion(undefined,undefined);assert.equal(older.value.sourceVersion,'source-0');
});

test('partial saves preserve the confirmed source version for the remaining retry',async()=>{
  const session=createEditorSession(),first=entry({changed:true}),second=entry({changed:true});
  first.value={contentVersion:'question-1',sourceVersion:'source-1'};second.value={contentVersion:'question-2',sourceVersion:'source-1'};
  session.add('q1',first);session.add('q2',second);const sources=[];
  await assert.rejects(session.saveAll(async change=>{sources.push(change.entry.value.sourceVersion);if(change.id==='q2')throw new Error('connection lost');return {previousSourceVersion:'source-1',sourceVersion:'source-2'};},(change,value)=>{session.confirmSourceVersion(value.previousSourceVersion,value.sourceVersion);change.entry.form.changed=false;}),error=>error.savedCount===1);
  assert.deepEqual(sources,['source-1','source-2']);assert.equal(second.value.sourceVersion,'source-2');assert.equal(second.form.changed,true);
  const count=await session.saveAll(async change=>{assert.equal(change.id,'q2');assert.equal(change.entry.value.sourceVersion,'source-2');return {previousSourceVersion:'source-2',sourceVersion:'source-3'};},(change,value)=>{session.confirmSourceVersion(value.previousSourceVersion,value.sourceVersion);change.entry.form.changed=false;});
  assert.equal(count,1);assert.equal(second.value.sourceVersion,'source-3');assert.equal(session.isDirty,false);
});
