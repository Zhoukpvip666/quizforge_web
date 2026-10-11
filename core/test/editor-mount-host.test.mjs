import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {createEditorSession} from '../web/editor-session.js';
import {collectionFeature,canEditCollection} from '../web/practice-context.js';

const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const editorSource=source.slice(source.indexOf('async function showEditorQuestion('),source.indexOf('\nasync function openEditor('));
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function fixture(t,{stage,editing=false,persistent=true,retained=false,ready=Promise.resolve()}={}){
  const dom=new JSDOM('<section><div></div></section>');t.after(()=>dom.window.close());
  const document=dom.window.document,node=document.querySelector('section'),frameHost=node.firstElementChild,oldContainer=document.createElement('div');frameHost.append(oldContainer);
  const oldFrame=document.createElement('iframe');oldContainer.append(oldFrame);
  const calls=[],mountCallbacks=[],oldDraft={text:'unfinished current form'},targetDraft={text:'unfinished target form'};
  const oldPlugin={frame:oldFrame,flush:async()=>{},exportDraft:async()=>{calls.push('export-current');if(stage==='export')throw new Error('export failed');return {supported:true,changed:true,draft:oldDraft};},destroy(){calls.push('destroy-current');oldFrame.remove();}};
  const session=createEditorSession({persistDraft:persistent?async()=>{calls.push('persist-current');if(stage==='persist')throw new Error('persist failed');}:undefined});
  t.after(()=>session.destroy());
  if(editing)session.add('a',{id:'a',value:{question:{id:'a'},contentVersion:'content-a'},plugin:oldPlugin,container:oldContainer,changed:true});
  if(retained)session.add('b',{id:'b',value:{contentVersion:'content-b'},draft:targetDraft,changed:true});
  const pane={kind:'bank',id:'bank',node,frameHost,plugin:oldPlugin,view:editing?'edit':'practice',questionId:'a',editState:editing?session.get('a').value:null,editorSession:editing?session:null,collection:{features:{history:persistent},questions:[{id:'a'},{id:'b'}]},viewport:{scrollTop:23,scrollLeft:0},tools:{},whiteboard:{setMode(){}}};
  const previous={view:pane.view,questionId:pane.questionId,editState:pane.editState,editorSession:pane.editorSession};
  const sandbox={document,collectionFeature,canEditCollection,active:()=>pane,newEditorSession:()=>session,questionPath:(_kind,_id,qid)=>`/q/${qid}`,editorDraftPath:(_pane,qid)=>`/draft/${qid}`,request:async path=>{if(stage==='read')throw new Error('read failed');return path.endsWith('/editor')?{question:{id:'b'},editor:{html:'candidate'},contentVersion:'content-b',revision:0}:{draft:retained?targetDraft:null,changed:retained,contentVersion:'content-b'};},prepareAssets:async value=>{if(stage==='assets')throw new Error('assets failed');return value;},el:tag=>document.createElement(tag),updateChrome(){},renderOutline(){},syncPracticeCamera(){},saveStatus(){},scheduleEditorDraft(){},setEditorLayout(){},pageRequest(){},notice:message=>calls.push(['notice',message]),showPageFailure:(_pane,error,qid)=>calls.push(['page-failure',qid,error.message]),mountExtension:(container,_assets,_context,callbacks)=>{
    mountCallbacks.push(callbacks);
    if(stage==='mount')throw new Error('mount failed');
    const frame=document.createElement('iframe');container.append(frame);
    return {frame,ready:stage==='ready'?Promise.reject(new Error('ready failed')):ready,setActive(){},destroy(){calls.push('destroy-candidate');frame.remove();}};
  }};
  vm.runInNewContext(editorSource+'\nglobalThis.show=showEditorQuestion;',sandbox);
  return {pane,previous,session,oldPlugin,oldFrame,oldContainer,calls,mountCallbacks,show:()=>sandbox.show(pane,'b'),targetDraft};
}

for(const stage of ['read','assets','mount','ready']){
  test(`formal editor ${stage} failure preserves the current practice frame and mode`,async t=>{
    const f=fixture(t,{stage});await assert.rejects(f.show(),new RegExp(`${stage} failed`));
    assert.equal(f.pane.plugin,f.oldPlugin);assert.equal(f.pane.view,'practice');assert.equal(f.pane.questionId,'a');assert.equal(f.pane.editorSession,null);
    assert.equal(f.oldFrame.isConnected,true);assert.equal(f.pane.frameHost.children.length,1);assert.equal(f.pane.loading,false);
    assert.equal(f.calls.includes('destroy-current'),false);
  });
}

for(const stage of ['ready','export','persist']){
  test(`formal editor ${stage} failure keeps both the current form and the suspended target draft`,async t=>{
    const f=fixture(t,{stage,editing:true,retained:true});await assert.rejects(f.show(),new RegExp(`${stage} failed`));
    assert.equal(f.pane.plugin,f.oldPlugin);assert.equal(f.pane.view,f.previous.view);assert.equal(f.pane.questionId,f.previous.questionId);assert.equal(f.pane.editState,f.previous.editState);assert.equal(f.pane.editorSession,f.session);
    assert.equal(f.session.get('a').plugin,f.oldPlugin);assert.equal(f.session.get('b').draft,f.targetDraft);assert.equal(f.session.get('b').changed,true);
    assert.equal(f.oldFrame.isConnected,true);assert.equal(f.pane.frameHost.children.length,1);assert.equal(f.calls.includes('destroy-current'),false);
  });
}

test('a session-only target draft survives a failed candidate registration',async t=>{
  const f=fixture(t,{stage:'ready',editing:true,persistent:false,retained:true});await assert.rejects(f.show(),/ready failed/);
  assert.equal(f.session.get('b').draft,f.targetDraft);assert.equal(f.pane.plugin,f.oldPlugin);assert.equal(f.oldFrame.isConnected,true);
});

test('the current editor is suspended only after the candidate registers',async t=>{
  let register;const ready=new Promise(resolve=>{register=resolve;});const f=fixture(t,{editing:true,ready});
  const loading=f.show();await tick();
  assert.equal(f.pane.questionId,'a');assert.equal(f.pane.plugin,f.oldPlugin);assert.equal(f.oldFrame.isConnected,true);assert.deepEqual(f.calls,[]);
  register();await loading;
  assert.deepEqual(f.calls,['export-current','persist-current','destroy-current']);assert.equal(f.pane.view,'edit');assert.equal(f.pane.questionId,'b');
  assert.equal(f.pane.frameHost.children.length,1);assert.equal(f.session.get('a').plugin,null);assert.equal(f.pane.plugin,f.session.get('b').plugin);
});

test('a discarded development editor cannot replace the current page error with a late callback',async t=>{
  const f=fixture(t,{stage:'ready'});f.pane.kind='development';f.pane.development={folder:'demo-dev'};
  await assert.rejects(f.show(),/ready failed/);
  const before=f.calls.filter(call=>call[0]==='page-failure');assert.equal(before.length,1);
  f.mountCallbacks[0].onError('late resource failure');
  assert.deepEqual(f.calls.filter(call=>call[0]==='page-failure'),before);assert.equal(f.pane.plugin,f.oldPlugin);
});

test('an active formal editor still reports its own callback error',async t=>{
  const f=fixture(t);await f.show();f.mountCallbacks[0].onError('active editor failure');
  assert.deepEqual(f.calls.at(-1),['notice','active editor failure']);
});
