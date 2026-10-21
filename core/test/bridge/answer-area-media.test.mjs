import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createCanvas} from '@napi-rs/canvas';
import {answerAreaModel} from '../../shared/answer-area/1.4.0/model.js';
import {createSharedAnswerAreaService} from '../../shared/answer-area/1.4.1/component.js';
const model=answerAreaModel();
function fixture(t,{height=120,save=()=>{},put=async()=>({id:'b'.repeat(64)})}={}){
 const dom=new JSDOM('<div id="answer"></div>',{pretendToBeVisual:true});t.after(()=>dom.window.close());const win=dom.window,{document}=win;let width=760,locked=false,saves=[],regions=[];
 win.HTMLCanvasElement.prototype.getContext=()=>createCanvas(760,3200).getContext('2d');win.URL.createObjectURL=()=> 'blob:photo';win.URL.revokeObjectURL=()=>{};
 win.Image=class{naturalWidth=100;naturalHeight=100;set src(value){this._src=value;if(value)queueMicrotask(()=>this.onload?.());}get src(){return this._src;}};
 const service=createSharedAnswerAreaService({document,model,getContext:()=>({capabilities:{canSave:!locked}}),resources:{put,get:async()=>({url:'blob:stored'})},onSync:async()=>{},onRegions:value=>regions.push(value)});t.after(()=>service.destroy());
 const area=service.api.mount(document.getElementById('answer'),{id:'answer',height,allowImages:true,sharedInk:true,onChange:async value=>{saves.push(value);return save(value);}});
 const surface=document.querySelector('.qf-answer-shared-surface');Object.defineProperty(surface,'clientWidth',{get:()=>width});surface.getBoundingClientRect=()=>({left:20,top:40,width,height:Number.parseFloat(surface.style.height)||height});area.refresh();
 const text=document.querySelector('textarea');const input=value=>{text.value=value;text.dispatchEvent(new win.Event('input'));};
 return {dom,win,document,service,area,text,input,saves,regions,file:()=>new win.File(['image bytes'],'photo.png',{type:'image/png'}),lock(){locked=true;service.refresh();},scale(value){width=value;area.refresh();}};
}
test('header controls stay outside the crop; text grows without shrinking and mobile scaling preserves the full original document',async t=>{
 const f=fixture(t);await Promise.resolve();assert.equal(f.text.placeholder,'');assert.match(f.document.querySelector('header').textContent,/文字、手写和图片/);assert.equal(f.document.querySelector('.qf-answer-shared-surface').querySelector('button'),null);
 f.input('line\n'.repeat(30));await f.area.flush();const answer=f.area.getDocument();assert.ok(answer.height>120);assert.equal(answer.text,'line\n'.repeat(30));
 const count=f.saves.length;f.scale(380);assert.deepEqual(f.area.getDocument(),answer);assert.equal(f.saves.length,count);assert.equal(f.document.querySelector('.qf-answer-shared-plane').style.transform,'scale(0.5)');assert.equal(Number.parseFloat(f.document.querySelector('.qf-answer-shared-surface').style.height),answer.height/2);
 f.input('short');await f.area.flush();assert.equal(f.area.getDocument().height,answer.height);
});
test('photos, file uploads and pasted images share resources, fit the original plane and count as answers',async t=>{
 const f=fixture(t);assert.equal(f.document.querySelector('input[capture]').getAttribute('capture'),'environment');assert.equal(f.area.isEmpty(),true);
 await f.area.insertImage(f.file());await f.area.flush();const answer=f.area.getDocument();assert.equal(answer.images.length,1);assert.equal(answer.images[0].attrs.assetId,'b'.repeat(64));assert.ok(answer.height>=answer.images[0].y+answer.images[0].height);assert.equal(f.area.isEmpty(),false);
 const event=new f.win.Event('paste',{cancelable:true});Object.defineProperty(event,'clipboardData',{value:{files:[f.file()]}});f.text.dispatchEvent(event);await f.area.flush();assert.equal(event.defaultPrevented,true);assert.equal(f.area.getDocument().images.length,2);assert.ok(f.area.getDocument().images[1].y>=answer.images[0].y+answer.images[0].height);
 const picture=f.area.getDocument().images[1];f.document.querySelector('.qf-answer-shared-surface').dispatchEvent(new f.win.MouseEvent('dblclick',{bubbles:true,cancelable:true,clientX:20+picture.x+5,clientY:40+picture.y+5}));f.document.querySelector('[aria-label=删除所选图片]').click();[...f.document.querySelectorAll('button')].find(button=>button.textContent==='删除').click();await f.area.flush();assert.equal(f.area.getDocument().images.length,1);assert.ok(f.area.getDocument().height>=answer.height);
 f.lock();assert.equal(f.text.readOnly,true);await assert.rejects(f.area.insertImage(f.file()),{code:'READ_ONLY'});
});
test('handwriting grows only near the lower edge; the original coordinates remain unchanged',async t=>{
 const f=fixture(t);const stroke={id:'new',color:'#334155',width:3,points:[{x:20,y:100,pressure:.5}]};f.service.setInk({id:'answer',strokes:[stroke],anchor:{x:10,y:20,width:760,height:120}});await f.area.flush();assert.ok(f.area.getDocument().height>120);assert.deepEqual(f.area.getDocument().strokes,[stroke]);
});
test('size limits retain pending text and block submission; upload and save failures do not erase existing content',async t=>{
 const f=fixture(t);f.input('kept');await f.area.flush();const saved=f.area.getDocument();f.input('x\n'.repeat(120));await assert.rejects(f.area.flush(),{code:'ANSWER_AREA_FULL'});assert.deepEqual(f.area.getDocument(),saved);assert.equal(f.text.value,'x\n'.repeat(120));f.input('recovered');await f.area.flush();
 const bad=fixture(t,{put:async()=>{throw Error('offline upload');}});bad.input('previous');await bad.area.flush();await bad.area.insertImage(bad.file());await assert.rejects(bad.area.flush(),/offline upload/);assert.equal(bad.area.getDocument().text,'previous');assert.equal(bad.area.getDocument().images,undefined);
});
test('picture geometry and resource references are validated without altering old answers',()=>{
 const legacy=model.create({id:'answer'});assert.equal(legacy.images,undefined);assert.deepEqual(model.normalize(legacy),legacy);
 const image={type:'image',id:'photo',attrs:{assetId:'a'.repeat(64)},x:16,y:16,width:100,height:100};assert.equal(model.normalize({...legacy,images:[image]}).images.length,1);
 for(const change of [{x:-1},{width:10000},{attrs:{assetId:'http://external'}},{type:'svg'}])assert.throws(()=>model.normalize({...legacy,images:[{...image,...change}]}));
});


test('old shared-ink extensions do not receive image inputs until their schema opts in',async t=>{
 const f=fixture(t),container=f.document.createElement('div');f.document.body.append(container);const old=f.service.api.mount(container,{id:'old',sharedInk:true,onChange(){}});await Promise.resolve();
 assert.ok([...container.querySelectorAll('.qf-answer-pick')].every(node=>node.hidden));await assert.rejects(old.insertImage(f.file()),{code:'IMAGES_DISABLED'});assert.equal(old.getDocument().images,undefined);
});


function pointer(f,node,type,x,y){const event=new f.win.Event(type,{bubbles:true,cancelable:true});Object.assign(event,{pointerId:3,pointerType:'mouse',clientX:x,clientY:y,button:0});node.dispatchEvent(event);}
function select(f){const item=f.area.getDocument().images[0];f.document.querySelector('.qf-answer-shared-surface').dispatchEvent(new f.win.MouseEvent('dblclick',{bubbles:true,cancelable:true,clientX:20+item.x+Math.min(5,item.width/2),clientY:40+item.y+Math.min(5,item.height/2)}));return f.document.querySelector('.qf-answer-image-handle');}
function photoDocument(){return {...model.create({id:'answer',height:480}),text:'kept text',images:[{type:'image',id:'photo',attrs:{assetId:'b'.repeat(64)},x:80,y:100,width:200,height:100}]};}

test('double click exposes only a floating frame, corners and X; outside click finishes without changing the document',async t=>{
 const f=fixture(t);f.area.setDocument(photoDocument());await f.area.flush();const before=f.area.getDocument(),count=f.saves.length;select(f);
 assert.equal(f.document.querySelector('.qf-answer-image-actions'),null);assert.equal(f.document.querySelector('.qf-answer-image-overlay').hidden,false);assert.equal(f.document.querySelectorAll('[data-corner]').length,4);assert.equal(f.document.querySelector('input[type=range]'),null);assert.equal(f.document.querySelector('.qf-answer-shared-surface').querySelector('button'),null);assert.equal(f.saves.length,count);
 pointer(f,f.text,'pointerdown',5,5);assert.equal(f.document.querySelector('.qf-answer-image-overlay').hidden,true);assert.deepEqual(f.area.getDocument(),before);
});

test('all four corner handles resize proportionally around the opposite corner and preserve text, resource identity and bounds',async t=>{
 for(const corner of ['nw','ne','sw','se']){
  const f=fixture(t);f.area.setDocument(photoDocument());await f.area.flush();const handle=select(f),grip=f.document.querySelector(`[data-corner=${corner}]`),west=corner.includes('w'),north=corner.includes('n');
  pointer(f,grip,'pointerdown',200,200);pointer(f,handle,'pointermove',200+(west?-40:40),200+(north?-20:20));pointer(f,handle,'pointerup',200+(west?-40:40),200+(north?-20:20));await f.area.flush();
  const doc=f.area.getDocument(),image=doc.images[0];assert.equal(image.width,240);assert.equal(image.height,120);assert.equal(image.x+(west?image.width:0),80+(west?200:0));assert.equal(image.y+(north?image.height:0),100+(north?100:0));assert.equal(doc.text,'kept text');assert.equal(image.attrs.assetId,'b'.repeat(64));
 }
});

test('movement clamps to the original plane; cancelling a preview and confirming or cancelling deletion retain the correct answer',async t=>{
 const f=fixture(t);f.area.setDocument(photoDocument());await f.area.flush();let handle=select(f);const before=f.area.getDocument();pointer(f,handle,'pointerdown',200,200);pointer(f,handle,'pointermove',-1000,-1000);assert.equal(f.area.getDocument().images[0].x,0);assert.equal(f.area.getDocument().images[0].y,0);await assert.rejects(f.area.flush(),{code:'IMAGE_BUSY'});pointer(f,handle,'pointercancel',0,0);assert.deepEqual(f.area.getDocument(),before);
 f.document.querySelector('[aria-label=删除所选图片]').click();const dialog=f.document.querySelector('[role=alertdialog]');assert.equal(dialog.hidden,false);[...dialog.querySelectorAll('button')].find(button=>button.textContent==='取消').click();assert.deepEqual(f.area.getDocument(),before);
 f.document.querySelector('[aria-label=删除所选图片]').click();[...dialog.querySelectorAll('button')].find(button=>button.textContent==='删除').click();await f.area.flush();assert.equal(f.area.getDocument().images.length,0);assert.equal(f.area.getDocument().text,'kept text');assert.equal(f.area.getDocument().height,480);
});

test('touch double tap selects a picture, and readonly history never exposes image controls',async t=>{
 const f=fixture(t);f.area.setDocument(photoDocument());await f.area.flush();const surface=f.document.querySelector('.qf-answer-shared-surface');for(let index=0;index<2;index++)for(const phase of ['pointerdown','pointerup']){const event=new f.win.Event(phase,{bubbles:true,cancelable:true});Object.assign(event,{pointerId:9,pointerType:'touch',clientX:110,clientY:160});surface.dispatchEvent(event);}assert.equal(f.document.querySelector('.qf-answer-image-overlay').hidden,false);f.lock();assert.equal(f.document.querySelector('.qf-answer-image-overlay').hidden,true);select(f);assert.equal(f.document.querySelector('.qf-answer-image-overlay').hidden,true);
});


test('phone-sized controls keep their physical size; cancelling a grown preview or entering readonly restores the saved plane',async t=>{
 const f=fixture(t);f.area.setDocument(photoDocument());await f.area.flush();let handle=select(f);f.scale(304);const overlay=f.document.querySelector('.qf-answer-image-overlay');assert.equal(overlay.style.getPropertyValue('--qf-image-ui-scale'),'2.5');
 const before=f.area.getDocument();pointer(f,handle,'pointerdown',150,150);pointer(f,handle,'pointermove',150,550);await new Promise(resolve=>f.win.requestAnimationFrame(resolve));assert.ok(f.area.getDocument().height>before.height);
 pointer(f,f.text,'pointerdown',1,1);assert.deepEqual(f.area.getDocument(),before);assert.equal(parseFloat(f.document.querySelector('.qf-answer-shared-surface').style.height),192);
 f.service.command({id:'answer',action:'select-image',imageId:'photo'});pointer(f,handle,'pointerdown',150,150);pointer(f,handle,'pointermove',150,550);f.lock();assert.deepEqual(f.area.getDocument(),before);assert.equal(overlay.hidden,true);await f.area.flush();
});


test('drag preview is not published as an answer and late shared ink is retained after cancelling',async t=>{
 const f=fixture(t);f.area.setDocument(photoDocument());await f.area.flush();const handle=select(f),before=f.area.getDocument(),saves=f.saves.length;pointer(f,handle,'pointerdown',200,200);pointer(f,handle,'pointermove',260,240);await new Promise(resolve=>f.win.requestAnimationFrame(resolve));
 assert.equal(f.saves.length,saves);assert.equal(f.regions.at(-1)[0].imagePreview,true);assert.deepEqual(f.regions.at(-1)[0].document,before);
 f.service.setInk({id:'answer',strokes:[{id:'late',color:'#334155',width:3,points:[{x:30,y:40,pressure:.5}]}],anchor:{x:10,y:20,width:760,height:480}});assert.equal(f.saves.length,saves);pointer(f,handle,'pointercancel',260,240);await f.area.flush();const after=f.area.getDocument();assert.deepEqual(after.images,before.images);assert.equal(after.strokes[0].id,'late');
});


test('pointer release retains its final position even without a final move event',async t=>{
 const f=fixture(t);f.area.setDocument(photoDocument());await f.area.flush();const handle=select(f);pointer(f,handle,'pointerdown',200,200);pointer(f,handle,'pointerup',260,240);await f.area.flush();assert.equal(f.area.getDocument().images[0].x,140);assert.equal(f.area.getDocument().images[0].y,140);
});


test('pressing a resize handle without moving does not enlarge tiny legacy pictures or save an edit',async t=>{
 const f=fixture(t),doc=photoDocument();doc.images[0]={...doc.images[0],width:10,height:2};f.area.setDocument(doc);await f.area.flush();select(f);assert.equal(f.document.querySelector('.qf-answer-image-overlay').hidden,false);const handle=f.document.querySelector('.qf-answer-image-handle'),corner=f.document.querySelector('[data-corner=se]'),before=f.area.getDocument(),count=f.saves.length;pointer(f,corner,'pointerdown',100,100);pointer(f,handle,'pointerup',100,100);await f.area.flush();assert.deepEqual(f.area.getDocument(),before);assert.equal(f.saves.length,count);
});


test('an unfinished photo upload cannot overlap an image drag preview',async t=>{
 let upload;const f=fixture(t,{put:()=>new Promise(resolve=>{upload=resolve;})});f.area.setDocument(photoDocument());await f.area.flush();const task=f.area.insertImage(f.file());while(!upload)await new Promise(resolve=>setTimeout(resolve,1));select(f);assert.equal(f.document.querySelector('.qf-answer-image-overlay').hidden,true);upload({id:'b'.repeat(64)});await task;await f.area.flush();assert.equal(f.area.getDocument().images.length,2);select(f);assert.equal(f.document.querySelector('.qf-answer-image-overlay').hidden,false);
});
