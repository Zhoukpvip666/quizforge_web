import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createSharedAnswerAreaService} from '../../shared/answer-area/1.3.2/component.js';
import {answerAreaModel} from '../../shared/answer-area/1.3.0/model.js';
import {bootstrapV1} from '../../web/bridge/api-v1.js';
import {resolveExtensionApi} from '../../web/bridge/api-bridges.js';

test('answer width changes are coalesced outside ResizeObserver delivery and height-only notifications settle',async t=>{
  const dom=new JSDOM('<div id="answer"></div>',{pretendToBeVisual:true});t.after(()=>dom.window.close());const {document}=dom.window;
  const observers=[],frames=new Map();let sequence=0,width=760,resizeCalls=0;
  dom.window.requestAnimationFrame=callback=>{const id=++sequence;frames.set(id,callback);return id;};dom.window.cancelAnimationFrame=id=>frames.delete(id);
  dom.window.ResizeObserver=class{constructor(callback){this.callback=callback;observers.push(this);}observe(target){this.target=target;}disconnect(){}};
  dom.window.HTMLCanvasElement.prototype.getContext=()=>({measureText:()=>({width:9})});
  const service=createSharedAnswerAreaService({document,model:answerAreaModel(),getContext:()=>({capabilities:{canSave:true}}),resources:{},resize(){resizeCalls++;},onSync:async()=>{}});t.after(()=>service.destroy());
  const area=service.api.mount(document.getElementById('answer'),{id:'answer',sharedInk:true,onChange(){}});await Promise.resolve();
  const surface=document.querySelector('.qf-answer-shared-surface');Object.defineProperty(surface,'clientWidth',{get:()=>width});area.refresh();
  const observer=observers[0],deliver=()=>observer.callback([{target:surface,contentRect:{width,height:Number.parseFloat(surface.style.height)-4}}]);
  width=380;const previous=surface.style.height,before=resizeCalls;deliver();deliver();
  assert.equal(surface.style.height,previous,'observer delivery must not synchronously change observed dimensions');assert.equal(frames.size,1,'one layout pass for repeated notifications');
  const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback());assert.equal(surface.style.height,'244px');assert.equal(resizeCalls,before+1);
  deliver();assert.equal(frames.size,0,'our own height adjustment must not schedule another pass');
  width=500;deliver();assert.equal(frames.size,1);await area.flush();assert.equal(frames.size,0,'flush finishes pending layout before syncing ink');assert.equal(surface.style.height,'319.789px');
  width=600;deliver();assert.equal(frames.size,1);area.destroy();assert.equal(frames.size,0,'destroy cancels deferred layout');
});

test('browser resize-delivery notices do not fail the page while actual errors still reach the host',t=>{
  const dom=new JSDOM('<div></div>',{runScripts:'outside-only'});t.after(()=>dom.window.close());const sent=[];
  dom.window.parent={postMessage:value=>sent.push(value)};dom.window.ResizeObserver=class{observe(){}disconnect(){}};dom.window.structuredClone=structuredClone;
  const api=resolveExtensionApi({major:1,minor:5}).api;dom.window.eval(`(${bootstrapV1.toString()})(${JSON.stringify({session:'resize-error',api,context:{mode:'practice',capabilities:{canSave:true}}})});`);
  for(const message of ['ResizeObserver loop completed with undelivered notifications.','ResizeObserver loop limit exceeded']){
    const event=new dom.window.ErrorEvent('error',{message,cancelable:true});dom.window.dispatchEvent(event);assert.equal(event.defaultPrevented,true);assert.equal(sent.filter(value=>value.kind==='error').length,0);
  }
  dom.window.dispatchEvent(new dom.window.ErrorEvent('error',{message:'real failure',error:new Error('real failure')}));assert.equal(sent.at(-1).message,'real failure');
  const message='ResizeObserver loop completed with undelivered notifications.';dom.window.dispatchEvent(new dom.window.ErrorEvent('error',{message,error:new Error(message)}));assert.equal(sent.filter(value=>value.kind==='error').length,2,'a thrown Error is never hidden merely for using similar text');
});

test('page zoom refreshes the answer rectangle even when its rounded width stays the same',async t=>{
  const dom=new JSDOM('<div id="answer"></div>',{pretendToBeVisual:true});t.after(()=>dom.window.close());const {document}=dom.window,frames=new Map(),regions=[];let seq=0,left=20,top=100,saves=0;
  dom.window.requestAnimationFrame=callback=>{const id=++seq;frames.set(id,callback);return id;};dom.window.cancelAnimationFrame=id=>frames.delete(id);dom.window.ResizeObserver=class{observe(){}disconnect(){}};dom.window.HTMLCanvasElement.prototype.getContext=()=>({measureText:()=>({width:9})});
  const service=createSharedAnswerAreaService({document,model:answerAreaModel(),getContext:()=>({capabilities:{canSave:true}}),resources:{},onRegions:value=>regions.push(value),onSync:async()=>{}});t.after(()=>service.destroy());
  const area=service.api.mount(document.getElementById('answer'),{id:'answer',sharedInk:true,onChange(){saves++;}});await Promise.resolve();const surface=document.querySelector('.qf-answer-shared-surface');
  Object.defineProperty(surface,'clientWidth',{value:760});Object.defineProperty(surface,'offsetWidth',{value:764});surface.getBoundingClientRect=()=>({left,top,width:764,height:484});area.refresh();const answer=area.getDocument();
  left=70;top=140;dom.window.dispatchEvent(new dom.window.Event('resize'));assert.equal(frames.size,1);const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback());
  assert.deepEqual(regions.at(-1)[0].rect,[72,142,760,480]);assert.deepEqual(area.getDocument(),answer);assert.equal(saves,0);
  area.destroy();dom.window.dispatchEvent(new dom.window.Event('resize'));assert.equal(frames.size,0,'disposed pages remove their resize listener');
});
