import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {createEditorSession} from '../../web/editor/editor-session.js';
import {checkEditorExit} from '../../web/editor/editor-navigation.js';
import {canEditCollection} from '../../web/practice/practice-context.js';
const source=readFileSync(new URL('../../web/app.js',import.meta.url),'utf8');
const hostSource=source.slice(source.indexOf('async function showEditorQuestion('),source.indexOf('\nasync function openEditor('));

function fixture(t,{stage,editing=false,dirty=false,ready=Promise.resolve()}={}){
  const dom=new JSDOM('<section><div></div></section>');t.after(()=>dom.window.close());const document=dom.window.document,node=document.querySelector('section'),frameHost=node.firstElementChild,oldContainer=document.createElement('div'),oldFrame=document.createElement('iframe');oldContainer.append(oldFrame);frameHost.append(oldContainer);
  const calls=[],requests=[],callbacks=[],oldPlugin={isDirty:dirty,flush:async()=>{},getDocument:async()=>({changed:dirty}),destroy(){calls.push('destroy-current');oldFrame.remove();}};
  const oldSession=editing?createEditorSession():null;if(oldSession)oldSession.add('a',{value:{},plugin:oldPlugin,container:oldContainer});
  const pane={kind:'bank',id:'bank',node,frameHost,plugin:oldPlugin,view:editing?'edit':'practice',questionId:'a',editState:editing?{}:null,editorSession:oldSession,collection:{features:{editing:true},questions:[{id:'a'},{id:'b'}]},viewport:{scrollTop:23,scrollLeft:0},tools:{},whiteboard:{setMode(){}}};
  const sandbox={document,canEditCollection,active:()=>pane,newEditorSession:createEditorSession,allowDiscardEditor:target=>checkEditorExit(target),questionPath:(_kind,_id,qid)=>'/q/'+qid,request:async url=>{requests.push(url);if(stage==='read')throw new Error('read failed');return {question:{id:'b',title:'source'},editor:{html:'candidate'},contentVersion:'content-b',revision:0};},prepareAssets:async value=>{if(stage==='assets')throw new Error('assets failed');return value;},el:tag=>document.createElement(tag),updateChrome(){},renderOutline(){},renderEditorStatus(){},syncPracticeCamera(){},saveStatus(){},setEditorLayout(){},pageRequest(){},notice:message=>calls.push(['notice',message]),showPageFailure:(_pane,error,qid)=>calls.push(['page-failure',qid,error.message]),mountExtension:(container,_assets,_context,options)=>{callbacks.push(options);if(stage==='mount')throw new Error('mount failed');const frame=document.createElement('iframe');container.append(frame);return {frame,ready:stage==='ready'?Promise.reject(new Error('ready failed')):ready,destroy(){calls.push('destroy-candidate');frame.remove();}};}};
  vm.runInNewContext(hostSource+'\nglobalThis.show=showEditorQuestion;',sandbox);
  t.after(()=>pane.editorSession?.destroy());return {pane,oldSession,oldPlugin,oldFrame,oldContainer,calls,requests,callbacks,show:()=>sandbox.show(pane,'b')};
}

for(const stage of ['read','assets','mount','ready'])test('failed '+stage+' leaves the current page intact without writing a draft',async t=>{
  const f=fixture(t,{stage});await assert.rejects(f.show(),new RegExp(stage+' failed'));assert.equal(f.pane.view,'practice');assert.equal(f.pane.questionId,'a');assert.equal(f.pane.plugin,f.oldPlugin);assert.equal(f.oldFrame.isConnected,true);assert.equal(f.pane.frameHost.children.length,1);assert.ok(!f.calls.includes('destroy-current'));assert.deepEqual(f.requests,['/q/b/editor']);
});
test('an unsaved editor cannot be replaced even through a direct editor mount call',async t=>{
  const f=fixture(t,{editing:true,dirty:true});await assert.rejects(f.show(),error=>error.code==='UNSAVED_EDITOR_CHANGES');assert.deepEqual(f.requests,[]);assert.equal(f.pane.editorSession,f.oldSession);assert.equal(f.oldFrame.isConnected,true);
});
test('clean replacement waits for registration and starts with source content without a retained draft',async t=>{
  let register;const f=fixture(t,{editing:true,ready:new Promise(resolve=>{register=resolve;})}),loading=f.show();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.pane.plugin,f.oldPlugin);assert.equal(f.oldFrame.isConnected,true);register();await loading;
  assert.equal(f.pane.questionId,'b');assert.equal(f.pane.editorSession.values().length,1);assert.notEqual(f.pane.editorSession,f.oldSession);assert.equal(f.oldSession.values().length,0);assert.equal(f.callbacks[0].editorDraft,undefined);assert.deepEqual(f.requests,['/q/b/editor']);
});
test('editor failures and late callbacks stay attached only to the current live form',async t=>{
  const f=fixture(t);await f.show();f.callbacks[0].onError('current failure');assert.deepEqual(f.calls.at(-1),['notice','current failure']);f.pane.plugin=null;const before=f.calls.length;f.callbacks[0].onError('late failure');assert.equal(f.calls.length,before);
});
