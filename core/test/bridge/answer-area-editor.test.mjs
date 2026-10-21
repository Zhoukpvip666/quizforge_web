import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const sample=new URL('../../examples/handwritten-short-answer/',import.meta.url);

test('the example editor saves per-area heights and restores incomplete drafts',async t=>{
 const dom=new JSDOM(fs.readFileSync(new URL('editor.html',sample),'utf8'),{runScripts:'outside-only'});t.after(()=>dom.window.close());let hooks;
 dom.window.QF={ui:{resize(){}},editor:{register(value){hooks=value;return Promise.resolve();}}};dom.window.eval(fs.readFileSync(new URL('editor.js',sample),'utf8'));
 const original=JSON.parse(fs.readFileSync(new URL('examples/bank.json',sample))).questions[1];hooks.onLoad({mode:'edit',question:original,capabilities:{canEdit:true}});
 const heights=dom.window.document.querySelectorAll('#area-settings input');assert.equal(heights.length,2);assert.equal(hooks.hasChanges(),false);
 heights[0].value='720';heights[0].dispatchEvent(new dom.window.Event('input',{bubbles:true}));assert.equal(hooks.hasChanges(),true);
 let changed=hooks.getDocument();assert.equal(changed.data.areas[0].height,720);assert.equal(changed.data.areas[1].height,960);assert.equal(original.data.areas[0].height,480);assert.equal(changed.data.areas[0].id,original.data.areas[0].id);
 heights[1].value='119';assert.throws(()=>hooks.getDocument(),/120–3200/);const draft=hooks.exportDraft();hooks.onLoad({mode:'edit',question:original,capabilities:{canEdit:true}});hooks.importDraft(draft);assert.equal(dom.window.document.querySelectorAll('#area-settings input')[1].value,'119');
 const restored=dom.window.document.querySelectorAll('#area-settings input');restored[1].value='3200';changed=hooks.getDocument();assert.equal(changed.data.areas[1].height,3200);assert.deepEqual(JSON.parse(JSON.stringify(changed.data.areas.map(area=>area.id))),original.data.areas.map(area=>area.id));hooks.onDispose();
});
