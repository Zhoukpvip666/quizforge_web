import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {answerAreaModel} from '../../shared/answer-area/1.0.0/model.js';
import {createAnswerAreaService} from '../../shared/answer-area/1.0.0/component.js';
import {answerAreaComponent} from '../../server/host/extensions/answer-area-component.js';
import {resolveExtensionApi} from '../../web/bridge/api-bridges.js';
import {prepareExtensionAssets} from '../../web/bridge/page-assets.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {installFrameCapture} from '../../web/bridge/frame-capture.js';
import {readHostAppearance} from '../../web/shell/appearance.js';

const model=answerAreaModel();
function fixture(t,{onChange=()=>{},mode='practice'}={}){
  const dom=new JSDOM('<!doctype html><html><body><div id="one"></div><div id="two"></div></body></html>',{runScripts:'outside-only'});t.after(()=>dom.window.close());
  const {document}=dom.window,drawn=[];
  dom.window.HTMLCanvasElement.prototype.getContext=function(){return {clearRect(){},fillRect(){},beginPath(){},arc(x,y){drawn.push([x,y]);},fill(){},moveTo(){},lineTo(){},stroke(){}};};
  let draft=true,context={mode,capabilities:{canSave:mode!=='history',canWhiteboard:true}},dirty=0;
  const service=createAnswerAreaService({model,getContext:()=>context,isDraft:()=>draft,resources:{get:async()=>({url:'blob:frozen'})},resize(){},onDirty(){dirty++;},document});t.after(()=>service.destroy());
  const area=service.api.mount(document.getElementById('one'),{id:'main',onChange}),canvas=document.querySelector('canvas');
  canvas.getBoundingClientRect=()=>({left:50,top:100,width:380,height:240});
  const pointer=(type,x,y,extra={})=>{const event=new dom.window.Event(type,{cancelable:true});Object.assign(event,{pointerId:1,pointerType:'pen',button:0,clientX:x,clientY:y,pressure:.5,...extra});canvas.dispatchEvent(event);return event;};
  const write=()=>{pointer('pointerdown',60,110);pointer('pointermove',120,150);pointer('pointerup',150,180);};
  return {dom,document,service,area,canvas,write,pointer,drawn,dirty:()=>dirty,mode(value){draft=value;service.refresh();},lock(value='submitted'){context={mode:value==='history'?'history':'exam',capabilities:{canSave:false,canWhiteboard:false}};service.refresh();}};
}

test('eraser hits the middle of a fast straight stroke and undo restores it',async t=>{
  const f=fixture(t);f.pointer('pointerdown',60,110);f.pointer('pointerup',250,110);await f.area.flush();
  assert.equal(f.area.getDocument().strokes.length,1);
  [...f.document.querySelectorAll('button')].find(node=>node.textContent==='擦除').click();
  f.pointer('pointerdown',150,110);f.pointer('pointerup',150,110);await f.area.flush();
  assert.equal(f.area.isEmpty(),true);f.area.undo();await f.area.flush();assert.equal(f.area.getDocument().strokes.length,1);
});

test('scaled input retains logical coordinates across draft/practice switching and readonly locking',async t=>{
  const saved=[],f=fixture(t,{onChange:value=>saved.push(value)});f.write();await f.service.flush();
  const answer=f.area.getDocument();assert.equal(answer.strokes.length,1);assert.deepEqual(answer.strokes[0].points[0],{x:20,y:20,pressure:.5});assert.equal(saved.length,1);assert.equal(answer.snapshot,undefined);
  f.mode(false);assert.deepEqual(f.area.getDocument(),answer);f.write();assert.deepEqual(f.area.getDocument(),answer);assert.equal(f.document.querySelector('.qf-answer-area-tools').style.visibility,'hidden');assert.equal(f.document.querySelector('.qf-answer-area-tools').hidden,false,'Retain the tool row geometry for ordinary draft annotations');
  f.mode(true);f.write();await f.service.flush();assert.equal(f.area.getDocument().strokes.length,2);
  f.lock();f.write();assert.equal(f.area.getDocument().strokes.length,2);assert.throws(()=>f.area.clear(),{code:'READ_ONLY'});
});

test('multiple areas remain independent and duplicate identity cannot replace a mounted area',async t=>{
  const f=fixture(t),second=f.service.api.mount(f.document.getElementById('two'),{id:'second',targetId:'q-46',onChange(){}});
  f.write();await f.service.flush();assert.equal(second.isEmpty(),true);assert.equal(f.area.isEmpty(),false);
  assert.throws(()=>f.service.api.mount(f.document.getElementById('two'),{id:'main'}),/重复/);
  assert.throws(()=>second.setDocument({...model.create({id:'second',targetId:'foreign'}),strokes:[]}),{code:'ANSWER_AREA_ID_MISMATCH'});
  second.destroy();assert.throws(()=>second.clear(),{code:'READ_ONLY'});assert.equal(f.document.querySelectorAll('[data-qf-answer-area]').length,1);
});

test('a failed answer save blocks flush, retains the ink, and can be retried explicitly',async t=>{
  let failing=true,attempts=0;const f=fixture(t,{onChange(){attempts++;if(failing)throw Error('offline');}});f.write();
  await assert.rejects(f.service.flush(),/offline/);assert.equal(f.area.getDocument().strokes.length,1);assert.match(f.document.querySelector('[role=status]').textContent,/offline/);
  failing=false;[...f.document.querySelectorAll('button')].find(node=>node.textContent==='重试保存').click();await f.service.flush();assert.equal(attempts,2);assert.equal(f.area.getDocument().strokes.length,1);
});

test('undo, redo, clear, height expansion and cancelled pointers do not modify other areas',async t=>{
  const f=fixture(t);f.write();await f.service.flush();f.area.undo();await f.service.flush();assert.equal(f.area.isEmpty(),true);f.area.redo();await f.service.flush();assert.equal(f.area.isEmpty(),false);
  [...f.document.querySelectorAll('button')].find(node=>node.textContent==='加高').click();await f.service.flush();assert.equal(f.area.getDocument().height,720);
  f.pointer('pointerdown',100,100);f.pointer('pointercancel',120,120);await f.service.flush();assert.equal(f.area.getDocument().strokes.length,1);
  f.area.clear();await f.service.flush();assert.equal(f.area.isEmpty(),true);f.area.undo();await f.service.flush();assert.equal(f.area.isEmpty(),false);
});

test('history displays the frozen submitted image and never emits a save',async t=>{
  let saves=0;const f=fixture(t,{mode:'history',onChange:()=>saves++});
  f.area.setDocument({...model.create({id:'main'}),snapshot:{type:'image',attrs:{assetId:'a'.repeat(64)}}});await f.service.flush();
  const image=f.document.querySelector('img');assert.equal(image.hidden,false);assert.equal(image.src,'blob:frozen');assert.equal(f.canvas.hidden,true);f.write();assert.equal(saves,0);
});

test('frozen API 1.5 component loads through the real bootstrap while legacy bridges expose no component',async t=>{
  for(const minor of [0,1,2,3,4])assert.equal(resolveExtensionApi({major:1,minor}).api.capabilities.includes('answer-areas'),false);
  const f=fixture(t),sent=[],parent={postMessage:message=>sent.push(message)},bridge=resolveExtensionApi({major:1,minor:5}),provider=answerAreaComponent();
  f.dom.window.parent=parent;f.dom.window.ResizeObserver=class{observe(){}disconnect(){}};f.dom.window.structuredClone=structuredClone;
  f.dom.window.eval(provider.script);f.dom.window.eval(`(${bridge.bootstrap.toString()})(${JSON.stringify({session:'test',api:bridge.api,answerAreasDeclared:true,answerAreaDraft:true,context:{mode:'practice',capabilities:{canSave:true,canWhiteboard:true}}})});`);
  const QF=f.dom.window.QF;assert.equal(QF.answerAreas.version,'1.4.1');assert.equal(Object.isFrozen(QF.answerAreas),true);assert.equal(f.dom.window.__qfAnswerAreaProvider,undefined);
  const pane=QF.answerAreas.mount(f.document.getElementById('two'),{id:'bridge',onChange(){}});assert.equal(pane.isEmpty(),true);
  f.dom.window.dispatchEvent(new f.dom.window.MessageEvent('message',{source:parent,data:{channel:'quizforge-host',session:'test',kind:'dispose'}}));assert.throws(()=>pane.clear(),{code:'READ_ONLY'});
  const assets={apiVersion:{major:1,minor:5},answerAreasDeclared:true,answerAreaComponent:provider};assert.equal((await prepareExtensionAssets(assets,async()=>{})).answerAreaComponent.script,provider.script);
});

test('real host frame renders the versioned component without treating its stylesheet as a script or mutating cached dependencies',t=>{
  const dom=new JSDOM('<div class="question-pane is-draft"><div id="host"></div></div>');t.after(()=>dom.window.close());const document=dom.window.document,container=document.getElementById('host');
  const sandbox={document,window:dom.window,resolveExtensionApi,installFrameCapture,readHostAppearance,makeRequestId:()=> 'test-identifier',setTimeout,clearTimeout};
  const source=readFileSync(new URL('../../web/bridge/frame.js',import.meta.url),'utf8').replace(/^import[^\r\n]*\r?\n/gm,'').replace('export function mountExtension','function mountExtension');
  vm.runInNewContext(`${source}\nglobalThis.mount=mountExtension;`,sandbox);
  const assets={apiVersion:{major:1,minor:5},answerAreasDeclared:true,answerAreaComponent:answerAreaComponent(),html:'<div id="area"></div>',script:'',style:'',libraries:[]};
  const frame=sandbox.mount(container,assets,{mode:'practice',capabilities:{canSave:true,canWhiteboard:true}},{onRequest(){},onError(){}});t.after(()=>frame.destroy());
  assert.equal(assets.libraries.length,0);assert.match(frame.frame.srcdoc,/__qfAnswerAreaProvider/);assert.match(frame.frame.srcdoc,/qf-answer-area-surface/);assert.match(frame.frame.srcdoc,/"answerAreaDraft":true/);
});

test('the frozen 1.3 provider restores text, synchronizes host ink before flush, and never mounts a second ink canvas',async t=>{
 const dom=new JSDOM('<div id="area"></div>',{runScripts:'outside-only'});t.after(()=>dom.window.close());const {document}=dom.window;
 dom.window.HTMLCanvasElement.prototype.getContext=()=>({measureText:()=>({width:9})});dom.window.ResizeObserver=class{observe(){}disconnect(){}};dom.window.structuredClone=structuredClone;
 const sent=[],saved=[],session='shared-bootstrap';let supplied=false;const parent={postMessage(message){sent.push(message);if(message.method==='answer-area-sync'){
   if(!supplied){supplied=true;host({kind:'answer-area-ink',value:{id:'response',strokes:[{id:'host-stroke',width:3,color:'#334155',points:[{x:20,y:30,pressure:.5}]}],anchor:{x:100,y:200,width:760,height:480}}});}
   host({kind:'reply',id:message.id,reply:{ok:true,data:{status:'synced'}}});
 }}};
 const host=value=>dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source:parent,data:{channel:'quizforge-host',session,...value}}));dom.window.parent=parent;
 const bridge=resolveExtensionApi({major:1,minor:5});dom.window.eval(answerAreaComponent().script);dom.window.eval(`(${bridge.bootstrap.toString()})(${JSON.stringify({session,api:bridge.api,answerAreasDeclared:true,context:{mode:'practice',capabilities:{canSave:true,canWhiteboard:true}}})});`);
 const area=dom.window.QF.answerAreas.mount(document.getElementById('area'),{id:'response',sharedInk:true,allowText:true,onChange:doc=>saved.push(doc)});area.setDocument({type:'qf-answer-area',formatVersion:1,id:'response',width:760,height:480,strokes:[],text:'保留文字'});
 await area.flush();assert.equal(area.getDocument().strokes.length,1);assert.equal(saved.at(-1).text,'保留文字');assert.equal(document.querySelectorAll('canvas').length,0);assert.equal(document.querySelector('textarea').placeholder,'');
 assert.ok(sent.filter(value=>value.kind==='answer-area-layout').every(value=>value.areas.length===0||value.areas[0].document.text==='保留文字'),'mount does not publish an empty document before synchronous restoration');
 host({kind:'dispose'});
});
