import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountWhiteboard} from '../../web/draft/whiteboard.js';

test('one host toolbar publishes tools and directs undo only to the active answer area',t=>{
 const dom=new JSDOM('<div class="question-viewport"><iframe></iframe></div>',{pretendToBeVisual:true});t.after(()=>dom.window.close());const {document,CustomEvent}=dom.window;
 dom.window.HTMLCanvasElement.prototype.getContext=()=>new Proxy({},{get:(target,key)=>target[key]??(()=>{})});
 const viewport=document.querySelector('div'),frame=document.querySelector('iframe'),commands=[];frame.addEventListener('qf-answer-area-command',event=>commands.push(event.detail));
 const whiteboard=mountWhiteboard(viewport);t.after(()=>whiteboard.destroy());whiteboard.setMode('draft');
 const erase=document.querySelector('[data-tool=eraser]');erase.click();assert.equal(viewport.qfAnswerAreaTools.tool,'eraser');
 const blue=document.querySelector('[data-ink="#386db6"]');blue.click();assert.equal(viewport.qfAnswerAreaTools.color,'#386db6');
 const width=document.querySelector('[data-control=width]');width.value='6';width.dispatchEvent(new dom.window.Event('input'));assert.equal(viewport.qfAnswerAreaTools.width,6);
 const undo=document.querySelector('[data-action=undo]');assert.equal(undo.disabled,true);
 frame.qfAnswerAreaFocus={id:'answer',writable:true,canUndo:true,canRedo:false};viewport.dispatchEvent(new CustomEvent('qf-answer-area-focus'));
 assert.equal(undo.disabled,false);undo.click();assert.deepEqual(commands,[{action:'undo',id:'answer'}]);assert.equal(whiteboard.getDraft().strokes.length,0);
 const clear=document.querySelector('[data-action=clear]');clear.click();assert.match(document.querySelector('[data-control=clear-message]').textContent,/当前正式答题区/);
 document.querySelector('[data-action=cancel-clear]').click();assert.equal(commands.length,1);
 clear.click();document.querySelector('[data-action=confirm-clear]').click();assert.deepEqual(commands.at(-1),{action:'clear',id:'answer'});assert.equal(whiteboard.getDraft().strokes.length,0);
 frame.qfAnswerAreaFocus=null;viewport.dispatchEvent(new CustomEvent('qf-answer-area-focus'));assert.equal(undo.disabled,true);
});
