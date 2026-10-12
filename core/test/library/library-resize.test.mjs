import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {bindLibraryResize,libraryWidthBounds} from '../../web/library/library-resize.js';

const html=readFileSync(new URL('../../web/index.html',import.meta.url),'utf8');
function fixture(t,{width=1440,saved}={}){
  const dom=new JSDOM(html,{url:'http://localhost/'}),win=dom.window,document=win.document;
  win.innerWidth=width;
  if(saved!==undefined)win.localStorage.setItem('quizforge-library-width',saved);
  const shell=document.querySelector('.app-shell'),library=document.querySelector('.library'),handle=document.querySelector('#library-resize');
  shell.getBoundingClientRect=()=>({width:win.innerWidth});
  library.getBoundingClientRect=()=>({width:Number.parseFloat(shell.style.getPropertyValue('--library-width'))||232});
  document.querySelector('.outline').getBoundingClientRect=()=>({width:228});
  const controller=bindLibraryResize({shell,library,handle,window:win});
  t.after(()=>{controller.destroy();win.close();});
  function pointer(target,type,x,id=1,button=0){
    const event=new win.MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,button});
    Object.defineProperty(event,'pointerId',{value:id});target.dispatchEvent(event);
  }
  const key=value=>handle.dispatchEvent(new win.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}));
  return {win,document,shell,library,handle,controller,pointer,key,width:()=>shell.style.getPropertyValue('--library-width')};
}

test('dragging the real separator resizes the library and persists only when released',t=>{
  const f=fixture(t);assert.equal(f.handle.getAttribute('role'),'separator');
  f.pointer(f.handle,'pointerdown',232);f.pointer(f.win,'pointermove',332);
  assert.equal(f.width(),'332px');assert.equal(f.handle.getAttribute('aria-valuenow'),'332');
  assert.equal(f.win.localStorage.getItem('quizforge-library-width'),null);
  assert.ok(f.document.querySelector('.library-resize-shield'));
  f.pointer(f.win,'pointerup',332);
  assert.equal(f.win.localStorage.getItem('quizforge-library-width'),'332');
  assert.equal(f.document.querySelector('.library-resize-shield'),null);
});

test('dragging is bounded, respects pointer identity, and leaves room for the answer area',t=>{
  const f=fixture(t);
  f.pointer(f.handle,'pointerdown',232);f.pointer(f.win,'pointermove',9999,2);assert.equal(f.width(),'');
  f.pointer(f.win,'pointermove',9999);assert.equal(f.width(),'480px');
  f.pointer(f.win,'pointermove',-9999);assert.equal(f.width(),'180px');f.pointer(f.win,'pointerup',0);
  assert.deepEqual(libraryWidthBounds(900,228),{min:180,max:352});
});

test('keyboard resizing, persistence, and double-click default reset work',t=>{
  const f=fixture(t,{saved:'350'});assert.equal(f.width(),'350px');
  f.key('ArrowLeft');assert.equal(f.width(),'334px');
  f.key('ArrowRight');assert.equal(f.width(),'350px');
  f.key('End');assert.equal(f.width(),'480px');f.key('Home');assert.equal(f.width(),'180px');
  f.handle.dispatchEvent(new f.win.MouseEvent('dblclick',{bubbles:true}));
  assert.equal(f.width(),'');assert.equal(f.win.localStorage.getItem('quizforge-library-width'),null);
});

test('mobile, hidden and fullscreen libraries cannot resize; desktop width survives responsive changes',async t=>{
  const f=fixture(t,{saved:'350'});
  f.win.innerWidth=600;f.win.dispatchEvent(new f.win.Event('resize'));assert.equal(f.handle.hidden,true);
  f.pointer(f.handle,'pointerdown',350);f.pointer(f.win,'pointermove',450);assert.equal(f.width(),'350px');
  f.win.innerWidth=1440;f.win.dispatchEvent(new f.win.Event('resize'));assert.equal(f.handle.hidden,false);
  f.library.hidden=true;await Promise.resolve();assert.equal(f.handle.hidden,true);
  f.library.hidden=false;f.shell.classList.add('draft-fullscreen');await Promise.resolve();assert.equal(f.handle.hidden,true);
  f.shell.classList.remove('draft-fullscreen');await Promise.resolve();assert.equal(f.width(),'350px');
});

test('cancelled drags restore the previous setting and clean up the iframe drag shield',t=>{
  const f=fixture(t,{saved:'300'});
  f.pointer(f.handle,'pointerdown',300);f.pointer(f.win,'pointermove',400);f.pointer(f.win,'pointercancel',400);
  assert.equal(f.width(),'300px');assert.equal(f.win.localStorage.getItem('quizforge-library-width'),'300');
  assert.equal(f.document.querySelector('.library-resize-shield'),null);
});

test('unavailable storage does not prevent resizing and destroying during a drag releases the shield',t=>{
  const f=fixture(t,{saved:'not-a-number'});
  Object.defineProperty(f.win,'localStorage',{get(){throw new Error('blocked');}});
  f.key('ArrowRight');assert.equal(f.width(),'248px');
  f.pointer(f.handle,'pointerdown',248);f.pointer(f.win,'pointermove',300);f.controller.destroy();
  assert.equal(f.document.querySelector('.library-resize-shield'),null);
  assert.equal(f.shell.classList.contains('library-resizing'),false);
});
