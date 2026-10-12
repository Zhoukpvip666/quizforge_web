import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {createHistoryView} from '../../web/history/history-view.js';
import {contextFor,collectionFeature,draftViewActive} from '../../web/practice/practice-context.js';

const source=readFileSync(new URL('../../web/app.js',import.meta.url),'utf8');
const historySource=source.slice(source.indexOf('async function showHistory('),source.indexOf('\nfunction disposeEditorSession('));
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function fixture(t,{history=false,stage,ready=Promise.resolve()}={}){
  const dom=new JSDOM('<section><div></div></section>');t.after(()=>dom.window.close());
  const document=dom.window.document,node=document.querySelector('section'),frameHost=node.firstElementChild,oldFrame=document.createElement('iframe');frameHost.append(oldFrame);
  const extension={id:'choice',version:'1'},page={extension,html:'frozen',apiVersion:{major:1,minor:0}},questions=['a','b'].map(id=>({page,payload:{extension,question:{id,data:{}},state:{status:'submitted',answer:{id},result:{score:1,maxScore:1}},draft:{strokes:[id]}}}));
  const record={id:'round',collectionTitle:'frozen',collection:{extension,questions:[{id:'a'},{id:'b'}]},questions},historyView=createHistoryView(record),calls=[],contexts=[],routes=[],mountCallbacks=[];
  const oldPlugin={frame:oldFrame,destroy(){calls.push('destroy-current');oldFrame.remove();}};
  const pane={kind:'bank',id:'bank',view:history?'history':'practice',node,frameHost,plugin:oldPlugin,questionId:'live',payload:{question:{id:'live'},state:{status:'draft',answer:'local'}},collection:{questions:[{id:'live'}]},historyEntry:history?record:null,historyView:history?historyView:null,historyQuestion:history?historyView.entry('a'):null,historyQuestionId:history?'a':null,historyDraftMode:history,draftMode:true,viewport:{scrollTop:39,scrollLeft:11},tools:{hidden:false},whiteboard:{setReadOnly:value=>calls.push(['readonly',value]),load:value=>calls.push(['draft',value]),setMode:value=>calls.push(['mode',value])}};
  const previous={view:pane.view,historyEntry:pane.historyEntry,historyView:pane.historyView,historyQuestion:pane.historyQuestion,historyQuestionId:pane.historyQuestionId,historyDraftMode:pane.historyDraftMode,payload:pane.payload};
  const sandbox={document,collectionFeature,contextFor,draftViewActive,createHistoryView,request:async()=>record,historyPath:()=>'/history',allowDiscardEditor:async()=>true,flushPane:async()=>{},allowLeaveDevelopmentInput:()=>true,active:()=>pane,prepareAssets:async value=>{if(stage==='assets')throw new Error('assets failed');return value;},disposeEditorSession:()=>calls.push('dispose-editor'),disposeScoreSummary:()=>calls.push('dispose-summary'),el:(tag,classes)=>{const child=document.createElement(tag);child.className=classes;return child;},setEditorLayout(){},pageRequest:(target,method)=>{routes.push([target.view,target.historyQuestionId,method]);return Promise.resolve({ok:true});},notice:message=>calls.push(['notice',message]),syncPracticeCamera(){},saveStatus(){},renderOutline(){},updateChrome(){},mountExtension:(container,assets,context,callbacks)=>{
    mountCallbacks.push(callbacks);
    if(stage==='mount')throw new Error('mount failed');
    const frame=document.createElement('iframe');container.append(frame);contexts.push(context);callbacks.onRequest('resource-get',{id:'resource'});
    return {frame,ready:stage==='ready'?Promise.reject(new Error('ready failed')):ready,destroy(){calls.push('destroy-candidate');frame.remove();}};
  }};
  vm.runInNewContext(historySource+'\nglobalThis.host={showHistory,showHistoryQuestion};',sandbox);
  return {pane,previous,oldPlugin,oldFrame,calls,contexts,routes,mountCallbacks,host:sandbox.host,record};
}

for(const stage of ['assets','mount','ready']){
  test(`opening history with an ${stage} failure preserves the practice view, frame and draft`,async t=>{
    const f=fixture(t,{stage});await assert.rejects(f.host.showHistory(f.pane,'round'),new RegExp(`${stage} failed`));
    for(const [key,value] of Object.entries(f.previous))assert.equal(f.pane[key],value,key);
    assert.equal(f.pane.plugin,f.oldPlugin);assert.equal(f.oldFrame.isConnected,true);assert.equal(f.pane.frameHost.children.length,1);
    assert.equal(f.pane.viewport.scrollTop,39);assert.equal(f.pane.tools.hidden,false);assert.equal(f.pane.loading,false);
    assert.equal(f.calls.includes('dispose-editor'),false);assert.equal(f.calls.includes('destroy-current'),false);assert.equal(f.calls.some(call=>call[0]==='draft'),false);
  });
}

test('a broken frozen question keeps the previous history question and its readonly whiteboard',async t=>{
  const f=fixture(t,{stage:'ready',history:true});await assert.rejects(f.host.showHistoryQuestion(f.pane,'b'),/ready failed/);
  for(const [key,value] of Object.entries(f.previous))assert.equal(f.pane[key],value,key);
  assert.equal(f.pane.plugin,f.oldPlugin);assert.equal(f.oldFrame.isConnected,true);assert.equal(f.pane.frameHost.children.length,1);assert.equal(f.calls.some(call=>call[0]==='draft'),false);
});

test('a frozen candidate registers in readonly context before committing the history view',async t=>{
  let register;const ready=new Promise(resolve=>{register=resolve;}),f=fixture(t,{ready});
  const loading=f.host.showHistory(f.pane,'round');await tick();
  assert.equal(f.pane.view,'practice');assert.equal(f.pane.plugin,f.oldPlugin);assert.equal(f.oldFrame.isConnected,true);assert.deepEqual(f.calls,[]);
  assert.equal(f.contexts[0].mode,'history');for(const enabled of Object.values(f.contexts[0].capabilities))assert.equal(enabled,false);
  assert.deepEqual(f.routes,[['history','a','resource-get']]);register();await loading;
  assert.equal(f.pane.view,'history');assert.equal(f.pane.historyQuestionId,'a');assert.equal(f.pane.historyEntry,f.record);assert.equal(f.pane.historyDraftMode,false);
  assert.equal(f.calls.includes('destroy-current'),true);assert.equal(f.pane.frameHost.children.length,1);assert.equal(f.pane.whiteboard!==null,true);assert.equal(f.pane.loading,false);
});

test('a discarded history candidate cannot post a late error over the preserved practice page',async t=>{
  const f=fixture(t,{stage:'ready'});await assert.rejects(f.host.showHistory(f.pane,'round'),/ready failed/);
  f.mountCallbacks[0].onError('late frozen resource failure');
  assert.equal(f.calls.some(call=>call[0]==='notice'),false);assert.equal(f.pane.plugin,f.oldPlugin);assert.equal(f.pane.view,'practice');
});

test('the active history frame still reports its own callback error',async t=>{
  const f=fixture(t);await f.host.showHistory(f.pane,'round');f.mountCallbacks[0].onError('active history failure');
  assert.deepEqual(f.calls.at(-1),['notice','active history failure']);
});
