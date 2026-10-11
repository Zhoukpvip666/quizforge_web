import test from 'node:test';
import assert from 'node:assert/strict';
import {WhiteboardModel,emptyDraft,DRAFT_LIMITS} from '../web/whiteboard-model.js';
import {rectangle,enclosedStrokes,strokeBounds,translateStrokes} from '../web/whiteboard-selection.js';
const stroke=(id,x,y)=>({id,color:'#334155',width:4,points:[{x,y,pressure:1},{x:x+10,y:y+10,pressure:.5}]});
test('reverse-direction box selects whole strokes including their thickness and excludes crossing strokes',()=>{
 const strokes=[stroke('inside',10,10),stroke('crossing',29,29),stroke('outside',100,100)];
 assert.deepEqual(enclosedStrokes(strokes,rectangle({x:30,y:30},{x:0,y:0})),['inside']);
 assert.deepEqual(enclosedStrokes(strokes,{x:10,y:10,width:10,height:10}),[]);
 assert.deepEqual(strokeBounds([]),null);
});
test('moves and copies are atomic undoable edits with stable original IDs and pressure',()=>{
 const model=new WhiteboardModel({...emptyDraft(),strokes:[stroke('one',10,10),stroke('two',50,50)]}),before=model.getDraft();
 model.editStrokes(translateStrokes(model.strokes,['one'],15,-5));
 assert.equal(model.strokes[0].points[0].x,25);assert.equal(model.strokes[0].points[1].pressure,.5);assert.deepEqual(model.strokes[1],before.strokes[1]);
 model.undo();assert.deepEqual(model.getDraft(),before);model.redo();assert.equal(model.strokes[0].id,'one');
 const copies=translateStrokes(model.strokes,['one'],24,24,()=> 'copy');model.editStrokes([...model.strokes,...copies]);assert.equal(model.strokes.length,3);assert.equal(model.strokes[2].id,'copy');
 model.editStrokes(model.strokes.filter(s=>s.id!=='copy'));model.undo();assert.equal(model.strokes.length,3);model.undo();assert.equal(model.strokes.length,2);
});
test('invalid move, duplicate copy IDs and stroke-count overflow preserve ink and undo history',()=>{
 const model=new WhiteboardModel({...emptyDraft(),strokes:[stroke('one',10,10)]}),before=model.getDraft();
 assert.throws(()=>model.editStrokes(translateStrokes(model.strokes,['one'],DRAFT_LIMITS.coordinate,0)));
 assert.throws(()=>model.editStrokes([...model.strokes,...model.strokes]));
 assert.throws(()=>model.editStrokes(Array.from({length:DRAFT_LIMITS.maxStrokes+1},(_,i)=>stroke(`id-${i}`,0,0))));
 assert.deepEqual(model.getDraft(),before);assert.equal(model.canUndo,false);
});
