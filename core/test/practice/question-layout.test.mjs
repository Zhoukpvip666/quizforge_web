import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {WhiteboardModel,emptyDraft,normalizeDraft} from '../../web/draft/whiteboard-model.js';
import {syncQuestionLayout,LEGACY_DRAFT_LAYOUT} from '../../web/practice/question-layout.js';
import {validateDraft} from '../../server/host/practice/whiteboard.js';

function fixture(t,{draft=null,pending=true,view='practice'}={}){
 const dom=new JSDOM('<div></div>');t.after(()=>dom.window.close());const model=new WhiteboardModel(draft),cameras=[],changes=[];
 const pane={view,draftLayoutPending:pending,world:dom.window.document.querySelector('div'),viewport:{clientWidth:1200},whiteboard:{getDraft:()=>model.getDraft(),setViewCamera:value=>cameras.push(value),initializeLayout:width=>{const changed=model.initializeLayout(width);if(changed)changes.push(model.getDraft());return changed;}}};
 return {pane,model,cameras,changes};
}
test('practice never initializes or saves a layout; first draft freezes full visible width',t=>{
 const f=fixture(t);syncQuestionLayout(f.pane,false);assert.equal(f.changes.length,0);assert.equal(f.model.getDraft().layout,undefined);
 syncQuestionLayout(f.pane,true);assert.deepEqual(f.model.getDraft().layout,{width:1200,padding:0,top:0});assert.equal(f.changes.length,1);
 f.pane.viewport.clientWidth=480;syncQuestionLayout(f.pane,true);assert.equal(f.pane.world.style.getPropertyValue('--qf-draft-width'),'1200px');assert.equal(f.changes.length,1);
 syncQuestionLayout(f.pane,false);assert.equal(f.changes.length,1);assert.deepEqual(f.cameras.at(-1),{x:0,y:0,zoom:1});
});
test('legacy ink and read-only history keep their original coordinates and never write',t=>{
 const draft=emptyDraft();draft.viewport={x:30,y:50,zoom:2};draft.strokes=[{id:'old',color:'#334155',width:3,points:[{x:80,y:120,pressure:.5}]}];
 const f=fixture(t,{draft,pending:false,view:'history'});assert.deepEqual(syncQuestionLayout(f.pane,true),LEGACY_DRAFT_LAYOUT);assert.deepEqual(f.model.getDraft(),draft);assert.equal(f.changes.length,0);
 const modern={...draft,layout:{width:1440,padding:0,top:0}},g=fixture(t,{draft:modern,pending:false,view:'history'});syncQuestionLayout(g.pane,true);g.pane.viewport.clientWidth=390;syncQuestionLayout(g.pane,true);assert.deepEqual(g.model.getDraft(),modern);assert.equal(g.pane.world.style.getPropertyValue('--qf-draft-width'),'1440px');assert.equal(g.changes.length,0);
});
test('layout survives model reload and JSON transport and has matching client/server validation',()=>{
 const model=new WhiteboardModel();model.initializeLayout(1234);model.appendStroke({id:'ink',color:'#334155',width:3,points:[{x:100,y:200,pressure:.5}]});
 const draft=JSON.parse(JSON.stringify(model.getDraft()));validateDraft(draft);assert.deepEqual(normalizeDraft(draft),draft);assert.deepEqual(new WhiteboardModel(draft).getDraft(),draft);assert.equal(model.initializeLayout(390),false);
 for(const layout of [null,[],{width:99,padding:0,top:0},{width:10001,padding:0,top:0},{width:760,padding:-1,top:0},{width:760,padding:0,top:Infinity},{width:760,padding:0,top:0,extra:1}]){assert.throws(()=>normalizeDraft({...draft,layout}));assert.throws(()=>validateDraft({...draft,layout}));}
 const legacy=emptyDraft();validateDraft(legacy);assert.deepEqual(normalizeDraft(legacy),legacy);
});
test('draft initialization waits until question load is committed',t=>{
 const f=fixture(t);f.pane.loading=true;syncQuestionLayout(f.pane,true);assert.equal(f.changes.length,0);f.pane.loading=false;syncQuestionLayout(f.pane,true);assert.equal(f.changes.length,1);
});
test('layout resize reads only small metadata rather than cloning all ink',t=>{
 const f=fixture(t);f.pane.whiteboard.getLayout=()=>f.model.layout;f.pane.whiteboard.getDraft=()=>{throw new Error('Resize must not clone draft ink');};syncQuestionLayout(f.pane,false);syncQuestionLayout(f.pane,true);assert.equal(f.pane.world.style.getPropertyValue('--qf-draft-width'),'1200px');
});
