import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountWhiteboard} from '../../web/draft/whiteboard.js';

function fixture(t){
  const dom=new JSDOM('<div class="question-viewport"><iframe></iframe></div>',{pretendToBeVisual:true});t.after(()=>dom.window.close());const win=dom.window,{document}=win;
  let scale=1,dpr=2;const clips=[],updates=[],saves=[];
  Object.defineProperty(win,'devicePixelRatio',{get:()=>dpr});Object.defineProperty(win,'visualViewport',{value:new win.EventTarget()});
  win.ResizeObserver=class{observe(){}disconnect(){}};
  win.HTMLCanvasElement.prototype.getContext=()=>new Proxy({rect(...args){clips.push(args);}},{get:(object,key)=>object[key]??(()=>{})});
  const bounds=(x,y,width,height)=>({left:30+x*scale,top:40+y*scale,width:width*scale,height:height*scale});
  const original=win.HTMLElement.prototype.getBoundingClientRect;win.HTMLElement.prototype.getBoundingClientRect=function(){return this.classList.contains('qf-whiteboard')?bounds(0,0,900,700):original.call(this);};
  const viewport=document.querySelector('div'),frame=document.querySelector('iframe');Object.defineProperty(viewport,'clientWidth',{value:900});Object.defineProperty(viewport,'clientHeight',{value:700});
  frame.getBoundingClientRect=()=>bounds(0,0,760,900);Object.defineProperty(frame,'clientWidth',{value:760});Object.defineProperty(frame,'clientHeight',{value:900});
  Object.defineProperty(frame,'offsetWidth',{value:760});Object.defineProperty(frame,'offsetHeight',{value:900});
  const board=mountWhiteboard(viewport,{onChange:value=>saves.push(value)});t.after(()=>board.destroy());board.setMode('draft');board.setViewport({x:0,y:0,zoom:1},{emit:false});
  const canvas=document.querySelector('canvas'),root=document.querySelector('.qf-whiteboard');canvas.getBoundingClientRect=()=>bounds(0,0,900,700);
  Object.defineProperty(root,'clientWidth',{value:900});Object.defineProperty(root,'clientHeight',{value:700});
  frame.qfSharedAnswerAreas=[{id:'answer',document:{type:'qf-answer-area',formatVersion:1,id:'answer',width:200,height:120,strokes:[]},rect:[100,100,200,120],writable:true,displayInk:true}];
  frame.addEventListener('qf-answer-ink',event=>{updates.push(event.detail);frame.qfSharedAnswerAreas[0].document={...frame.qfSharedAnswerAreas[0].document,...event.detail,inkSource:'draft'};});
  function pointer(type,x,y){const event=new win.Event(type,{bubbles:true,cancelable:true});Object.assign(event,{clientX:30+x*scale,clientY:40+y*scale,button:0,pointerId:1,pointerType:'pen',pressure:.5});canvas.dispatchEvent(event);}
  function write(){pointer('pointerdown',120,130);pointer('pointermove',180,150);pointer('pointerup',230,180);board.flush();}
  const paint=()=>new Promise(resolve=>setTimeout(resolve,40));
  async function zoom(value,{visual=false}={}){scale=value;dpr=2*value;(visual?win.visualViewport:win).dispatchEvent(new win.Event('resize'));viewport.dispatchEvent(new win.CustomEvent('qf-shared-answer-layout'));await paint();}
  return {win,document,frame,canvas,board,clips,updates,saves,write,zoom,paint};
}

test('browser display scaling preserves draft source points and the saved answer crop across 80, 125 and 100 percent',async t=>{
  const f=fixture(t);f.write();await f.paint();const draft=f.board.getDraft(),answer=structuredClone(f.frame.qfSharedAnswerAreas[0].document),count=f.updates.length,saves=f.saves.length;
  for(const scale of [.8,1.25,1,.9,1.5,1]){await f.zoom(scale);assert.deepEqual(f.board.getDraft(),draft,'display scaling must not move source ink');assert.deepEqual(f.frame.qfSharedAnswerAreas[0].document,answer,'display scaling must not re-crop or resave the answer');}
  assert.equal(f.updates.length,count);assert.equal(f.saves.length,saves);
});

test('practice ink is clipped to canvas coordinates after browser zoom and never saves display changes',async t=>{
  const f=fixture(t);f.write();await f.paint();f.board.setMode('practice');await f.paint();const saves=f.saves.length,answer=structuredClone(f.frame.qfSharedAnswerAreas[0].document);
  for(const scale of [.8,1.25,1]){await f.zoom(scale);assert.deepEqual(f.clips.at(-1),[100,100,200,120]);assert.equal(f.canvas.width,Math.round(900*2*scale));assert.deepEqual(f.frame.qfSharedAnswerAreas[0].document,answer);}
  assert.equal(f.saves.length,saves);
});

test('browser and visual viewport resize refresh DPR even when ResizeObserver is available',async t=>{
  const f=fixture(t);await f.paint();await f.zoom(1.25);assert.equal(f.canvas.width,2250);await f.zoom(.8,{visual:true});assert.equal(f.canvas.width,1440);
});

test('new pen input and readonly hit regions use the same canvas coordinates after display zoom',async t=>{
  const f=fixture(t);f.write();const original=f.board.getDraft().strokes[0];await f.zoom(1.25);f.write();
  assert.deepEqual(f.board.getDraft().strokes[1].points,original.points);assert.deepEqual(f.frame.qfSharedAnswerAreas[0].document.strokes[1].points,f.frame.qfSharedAnswerAreas[0].document.strokes[0].points);
  f.frame.qfSharedAnswerAreas[0].writable=false;const count=f.board.getDraft().strokes.length;f.write();assert.equal(f.board.getDraft().strokes.length,count,'the readonly answer rectangle must still reject pen input');
});
