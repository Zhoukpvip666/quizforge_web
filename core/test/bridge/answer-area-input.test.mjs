import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {answerAreaModel} from '../../shared/answer-area/1.2.0/model.js';
import {createAnswerAreaService,ANSWER_AREA_STYLE} from '../../shared/answer-area/1.2.0/component.js';

function fixture(t,{draft=false,onChange=()=>{},onPan}={}){
 const dom=new JSDOM('<style>'+ANSWER_AREA_STYLE+'</style><div id="area"></div>',{pretendToBeVisual:true});t.after(()=>dom.window.close());
 const {document}=dom.window;dom.window.HTMLCanvasElement.prototype.getContext=()=>({clearRect(){},fillRect(){},beginPath(){},arc(){},fill(){},moveTo(){},lineTo(){},stroke(){}});
 let context={mode:'practice',capabilities:{canSave:true,canWhiteboard:true}},dirty=0;const focused=[];
 const service=createAnswerAreaService({document,model:answerAreaModel(),getContext:()=>context,isDraft:()=>draft,resources:{get:async()=>({url:'blob:frozen'})},resize(){},onPan,onDirty(){dirty++;},onFocus:state=>focused.push(state)});
 t.after(()=>service.destroy());const area=service.api.mount(document.getElementById('area'),{id:'answer',allowText:true,onChange});
 const canvas=document.querySelector('canvas'),text=document.querySelector('textarea');canvas.getBoundingClientRect=()=>({left:50,top:100,width:380,height:240});
 function pointer(type,x,y,extra={}){const event=new dom.window.Event(type,{cancelable:true});Object.assign(event,{pointerId:1,pointerType:'pen',button:0,clientX:x,clientY:y,pressure:.5,...extra});canvas.dispatchEvent(event);return event;}
 function type(value){text.focus();text.value=value;text.dispatchEvent(new dom.window.Event('input',{bubbles:true}));}
 const button=name=>[...document.querySelectorAll('button')].find(node=>node.textContent.startsWith(name));
 return {document,dom,area,service,canvas,text,pointer,type,button,focused,dirty:()=>dirty,mode(value){draft=value;service.refresh();},lock(){context={mode:'history',capabilities:{canSave:false,canWhiteboard:false}};service.refresh();}};
}

test('one text box shows both text and ink with no input tabs or duplicate drawing tools',async t=>{
 const saved=[],f=fixture(t,{onChange:doc=>saved.push(doc)});assert.equal(f.text.readOnly,false);assert.equal(f.document.querySelector('[role=toolbar]'),null);
 assert.equal(f.document.defaultView.getComputedStyle(f.document.querySelector('.qf-answer-area')).borderTopWidth,'2px');
 f.type('输入、处理、输出');await f.area.flush();assert.equal(f.area.getDocument().text,'输入、处理、输出');assert.equal(f.area.isEmpty(),false);
 assert.equal(f.document.querySelectorAll('textarea').length,1);assert.equal(f.document.querySelectorAll('[aria-pressed]').length,0);
 f.pointer('pointerdown',60,110);f.pointer('pointerup',100,150);assert.equal(f.area.getDocument().strokes.length,0);
 f.mode(true);f.pointer('pointerdown',60,110);f.pointer('pointerup',100,150);await f.area.flush();assert.equal(f.area.getDocument().strokes.length,1);
 assert.equal(f.text.hidden,false);assert.equal(f.canvas.hidden,false);assert.equal(f.text.value,'输入、处理、输出');assert.equal(f.area.getDocument().strokes.length,1);assert.equal(saved.length,2);
 f.mode(false);assert.equal(f.canvas.style.pointerEvents,'none');assert.equal(f.text.hidden,false);assert.equal(f.area.getDocument().strokes.length,1);
 assert.equal(f.document.body.textContent.includes('框内内容用于评分'),true);
});

test('host tools control pen width, color, eraser and touch policy, while hand/select never draw',async t=>{
 const f=fixture(t,{draft:true});
 const tools=(tool,penOnly=true)=>f.service.setTools({tool,color:'#d04444',width:6,penOnly});
 tools('hand');f.pointer('pointerdown',60,110);f.pointer('pointerup',250,110);assert.equal(f.area.isEmpty(),true);
 tools('select-ink');f.pointer('pointerdown',60,110);f.pointer('pointerup',250,110);assert.equal(f.area.isEmpty(),true);
 tools('pen');f.pointer('pointerdown',60,110,{pointerType:'touch'});f.pointer('pointerup',250,110,{pointerType:'touch'});assert.equal(f.area.isEmpty(),true);
 tools('pen',false);f.pointer('pointerdown',60,110,{pointerType:'touch'});f.pointer('pointerup',250,110,{pointerType:'touch'});await f.area.flush();
 assert.equal(f.area.getDocument().strokes[0].color,'#d04444');assert.equal(f.area.getDocument().strokes[0].width,6);
 assert.equal(f.focused.at(-1).canUndo,true);
 tools('eraser');f.pointer('pointerdown',150,110);f.pointer('pointerup',150,110);await f.area.flush();assert.equal(f.area.isEmpty(),true);
 f.service.command({id:'answer',action:'undo'});await f.area.flush();assert.equal(f.area.getDocument().strokes.length,1);
 f.service.command({id:'answer',action:'redo'});await f.area.flush();assert.equal(f.area.isEmpty(),true);
});

test('text save failures retain input and prevent flush until a successful retry',async t=>{
 let fail=true;const f=fixture(t,{onChange(){if(fail)throw Error('offline fixture');}});f.type('保留这份文字');
 await assert.rejects(f.area.flush(),/offline fixture/);assert.equal(f.text.value,'保留这份文字');assert.equal(f.dirty(),1);
 fail=false;f.button('重试保存').click();await f.area.flush();assert.equal(f.area.getDocument().text,'保留这份文字');
 f.lock();f.type('不能覆盖');assert.equal(f.text.value,'保留这份文字');assert.throws(()=>f.area.clear(),{code:'READ_ONLY'});
});

test('hand and pen-only touch movements pass through as camera gestures, including two fingers and cancel',async t=>{
 const pans=[],f=fixture(t,{draft:true,onPan:event=>pans.push(event)});
 f.pointer('pointerdown',60,110,{pointerType:'touch',pointerId:7});f.pointer('pointerdown',120,110,{pointerType:'touch',pointerId:8});
 f.pointer('pointermove',80,140,{pointerType:'touch',pointerId:7});f.pointer('pointerup',80,140,{pointerType:'touch',pointerId:7});
 assert.deepEqual(pans.map(event=>[event.phase,event.pointerId]),[['pointerdown',7],['pointerdown',8],['pointermove',7],['pointerup',7]]);
 f.mode(false);assert.equal(pans.at(-1).phase,'pointercancel');assert.equal(pans.at(-1).pointerId,8);assert.equal(f.area.isEmpty(),true);
 f.mode(true);f.service.setTools({tool:'hand',color:'#334155',width:3,penOnly:true});f.pointer('pointerdown',60,110,{pointerType:'mouse'});f.pointer('pointerup',100,110,{pointerType:'mouse'});
 assert.equal(f.canvas.style.pointerEvents,'none','the operation tool exposes the same text field');await f.area.flush();assert.equal(f.area.isEmpty(),true);
});

test('legacy ink documents restore unchanged; mixed frozen history displays both text and original PNG',async t=>{
 const f=fixture(t),old={type:'qf-answer-area',formatVersion:1,id:'answer',width:760,height:480,strokes:[{id:'old',color:'#334155',width:3,points:[{x:20,y:20,pressure:.5}]}]};
 f.area.setDocument(old);assert.deepEqual(f.area.getDocument(),old);assert.equal(f.canvas.hidden,false);
 f.lock();f.area.setDocument({...old,text:'旧笔迹加上文字',snapshot:{type:'image',attrs:{assetId:'a'.repeat(64)}}});await f.area.flush();
 assert.equal(f.text.readOnly,true);assert.equal(f.text.value,'旧笔迹加上文字');assert.equal(f.document.querySelector('img').hidden,false);assert.equal(f.text.hidden,true);
 f.service.command({id:'answer',action:'undo'});assert.equal(f.area.getDocument().text,'旧笔迹加上文字');
});

test('typing expands the shared plane without shifting or removing saved ink',async t=>{
 const f=fixture(t,{draft:true});f.pointer('pointerdown',60,110);f.pointer('pointerup',100,150);const old=f.area.getDocument().strokes;
 f.service.setTools({tool:'hand',color:'#334155',width:3,penOnly:true});f.type(Array.from({length:30},(_,i)=>`第${i+1}行`).join('\n'));await f.area.flush();
 assert.equal(f.canvas.style.pointerEvents,'none');assert.equal(f.text.hidden,false);assert.ok(f.area.getDocument().height>480);assert.deepEqual(f.area.getDocument().strokes,old);
 assert.equal(f.document.querySelector('.qf-answer-area-plane').style.height,`${f.area.getDocument().height}px`);
});
