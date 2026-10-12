import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {preparePhoto} from '../../shared/richtext/1.1.3/src/photo.js';
const read=file=>readFileSync(new URL(`../../shared/richtext/1.1.3/${file}`,import.meta.url),'utf8');
const paragraph=text=>({type:'paragraph',content:[{type:'text',text}]}),doc=text=>({type:'doc',content:[paragraph(text)]});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(t,{put=async()=>({id:'a'.repeat(64)})}={}) {
  const dom=new JSDOM('<!doctype html><div id="field"></div>',{runScripts:'outside-only',pretendToBeVisual:true,url:'http://localhost/'});t.after(()=>dom.window.close());
  dom.window.Range.prototype.getClientRects=()=>[];dom.window.Range.prototype.getBoundingClientRect=()=>({top:0,bottom:0,left:0,right:0,width:0,height:0});
  dom.window.createImageBitmap=async()=>({width:100,height:80,close(){}});dom.window.eval(read('richtext.js'));
  const api=dom.window.QFRichText,field=dom.window.document.getElementById('field');api.configure({resources:{get:async()=>({url:'blob:local'}),put},loadEditor:async()=>dom.window.eval(read('richtext-editor.js'))});
  const selectFile=(input,file)=>{Object.defineProperty(input,'files',{configurable:true,value:[file]});input.dispatchEvent(new dom.window.Event('change'));};
  return {dom,api,field,selectFile};
}
test('camera is a separate rear-facing picker and capturePhoto opens it synchronously after ready',async t=>{
  const f=fixture(t),editor=f.api.createEditor(f.field,{doc:doc('文字答案')});assert.throws(()=>editor.capturePhoto(),/加载/);await editor.ready;
  const camera=f.field.querySelector('.qfrt-toolbar input[capture="environment"]'),album=f.field.querySelector('.qfrt-toolbar input:not([capture])');
  assert.equal(camera.accept,'image/*');assert.equal(album.hasAttribute('capture'),false);assert.equal(camera.getAttribute('aria-label'),'拍摄答案照片');
  let opened=0;camera.addEventListener('click',event=>{event.preventDefault();opened++;});assert.equal(editor.capturePhoto(),true);assert.equal(opened,1);
  camera.dispatchEvent(new f.dom.window.Event('cancel'));assert.deepEqual(JSON.parse(JSON.stringify(editor.getDocument())),doc('文字答案'));
  f.selectFile(camera,new f.dom.window.File(['photo'],'answer.jpg',{type:'image/jpeg'}));assert.equal(editor.isUploading(),true);assert.equal(editor.capturePhoto(),false);await editor.flush();
  const image=editor.getDocument().content.find(node=>node.type==='image');assert.equal(image.attrs.assetId,'a'.repeat(64));assert.equal(camera.value,'');assert.equal(editor.isUploading(),false);editor.destroy();assert.throws(()=>editor.capturePhoto(),/关闭/);
});
test('photo decoding is part of flush, preserves the insertion bookmark, and cannot upload into a replaced answer',async t=>{
  const decoding=deferred(),uploads=[],f=fixture(t,{put:async file=>{uploads.push(file);return {id:'b'.repeat(64)};}}),editor=f.api.createEditor(f.field,{doc:doc('原答案')});await editor.ready;
  f.dom.window.createImageBitmap=()=>decoding.promise;const camera=f.field.querySelector('input[capture]');camera.dispatchEvent(new f.dom.window.Event('click'));f.selectFile(camera,new f.dom.window.File(['photo'],'answer.jpg',{type:'image/jpeg'}));
  let flushed=false;const flush=editor.flush().then(()=>{flushed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(flushed,false);editor.setDocument(doc('新答案'));
  let closed=false;decoding.resolve({width:100,height:80,close(){closed=true;}});await flush;assert.equal(uploads.length,0);assert.equal(closed,true);assert.deepEqual(JSON.parse(JSON.stringify(editor.getDocument())),doc('新答案'));editor.destroy();
});
test('a chooser returning after document replacement is ignored, and photo errors block flush until retry',async t=>{
  let uploads=0;const f=fixture(t,{put:async()=>{uploads++;return {id:'c'.repeat(64)};}}),editor=f.api.createEditor(f.field,{doc:doc('旧')});await editor.ready;
  const camera=f.field.querySelector('input[capture]');camera.dispatchEvent(new f.dom.window.Event('click'));editor.setDocument(doc('新'));f.selectFile(camera,new f.dom.window.File(['photo'],'old.jpg',{type:'image/jpeg'}));await editor.flush();assert.equal(uploads,0);
  camera.dispatchEvent(new f.dom.window.Event('click'));f.selectFile(camera,new f.dom.window.File(['bad'],'bad.txt',{type:'text/plain'}));await assert.rejects(editor.flush(),/照片/);assert.equal(camera.disabled,false);
  assert.equal(editor.capturePhoto(),true);f.selectFile(camera,new f.dom.window.File(['photo'],'new.jpg',{type:'image/jpeg'}));await editor.flush();assert.equal(uploads,1);editor.destroy();
});
test('photo compression bounds dimensions and bytes and releases decoder and canvas on success or failure',async()=>{
  let closed=0,orientation=null,qualities=[],dimensions=[],canvas={width:0,height:0,getContext:()=>({fillRect(){},drawImage(_image,_x,_y,width,height){dimensions.push([width,height]);}}),toBlob(callback,type,quality){qualities.push(quality);callback(new Blob(['jpg'],{type}));}};
  const win={File,document:{createElement:()=>canvas},createImageBitmap:async(_file,options)=>{orientation=options.imageOrientation;return {width:6000,height:4000,close(){closed++;}};},setTimeout,clearTimeout};
  const result=await preparePhoto(new File([new Uint8Array(5*1024*1024)],'large.png',{type:'image/png'}),win);assert.equal(result.type,'image/jpeg');assert.equal(result.name,'large.jpg');assert.equal(orientation,'from-image');assert.equal(closed,1);assert.equal(canvas.width,0);assert.equal(canvas.height,0);assert.deepEqual(qualities,[.9]);assert.deepEqual(dimensions,[[2560,1707]]);
  await assert.rejects(preparePhoto(new File([new Uint8Array(21*1024*1024)],'huge.jpg',{type:'image/jpeg'}),win),/20 MiB/);
  win.createImageBitmap=async()=>({width:10000,height:10000,close(){closed++;}});await assert.rejects(preparePhoto(new File(['x'],'bad.jpg',{type:'image/jpeg'}),win),/分辨率/);assert.equal(closed,2);
  win.createImageBitmap=async()=>({width:3000,height:2000,close(){closed++;}});canvas.toBlob=callback=>callback(null);await assert.rejects(preparePhoto(new File(['x'],'failed.jpg',{type:'image/jpeg'}),win),/处理失败/);assert.equal(closed,3);
});

test('native image fallback preserves a small photo and releases its temporary URL',async()=>{
  const revoked=[],canvas={width:0,height:0};let source='',image;
  class NativeImage {
    constructor(){image=this;this.naturalWidth=640;this.naturalHeight=480;}
    set src(value){source=value;if(value)queueMicrotask(()=>this.onload());}
  }
  const win={Image:NativeImage,URL:{createObjectURL:()=> 'blob:photo',revokeObjectURL:url=>revoked.push(url)},document:{createElement:()=>canvas},setTimeout,clearTimeout};
  const small=new File(['photo'],'small.jpg',{type:'image/jpeg'});assert.equal(await preparePhoto(small,win),small);assert.deepEqual(revoked,['blob:photo']);assert.equal(source,'');assert.equal(typeof image.onload,'function');
  class BrokenImage extends NativeImage {set src(value){if(value)queueMicrotask(()=>this.onerror());}}
  win.Image=BrokenImage;await assert.rejects(preparePhoto(small,win),/无法读取照片/);assert.deepEqual(revoked,['blob:photo','blob:photo']);
});
