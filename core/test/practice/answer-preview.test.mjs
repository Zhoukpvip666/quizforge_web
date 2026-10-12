import test from 'node:test';
import assert from 'node:assert/strict';
import {reportAnswerPreview,previewDraftAnswer,confirmAnswerPreview,answerStateForSave} from '../../web/practice/answer-preview.js';
import {outlineStateFor,stateFor} from '../../web/practice/practice-context.js';
const fixture=()=>({view:'practice',questionId:'q',collection:{questions:[{id:'q',outlineItems:[{id:'a'},{id:'b'}]}],states:{q:{status:'unanswered',revision:4,answer:null,result:null}}}});
test('pending answer feedback changes only the outline and never confirmed answers or revisions',()=>{
 const pane=fixture(),before=structuredClone(stateFor(pane,'q')),entry=previewDraftAnswer(pane,'q');
 assert.equal(outlineStateFor(pane,'q').status,'draft');assert.deepEqual(stateFor(pane,'q'),before);
 confirmAnswerPreview(pane,'q',entry);assert.equal(outlineStateFor(pane,'q').status,'unanswered');
});
test('older save acknowledgements cannot clear newer child feedback, including queued older snapshots',()=>{
 const pane=fixture(),first=reportAnswerPreview(pane,{targetId:'a',status:'draft'});
 const pending=previewDraftAnswer(pane,'q',first.stateId);
 const newer=reportAnswerPreview(pane,{targetId:'b',status:'draft'});
 assert.deepEqual(newer.outlineStates,[{id:'a',status:'draft'},{id:'b',status:'draft'}]);
 assert.deepEqual(answerStateForSave(pane,'q',first.stateId),{status:'draft',outlineStates:[{id:'a',status:'draft'}]});
 assert.equal(previewDraftAnswer(pane,'q',first.stateId),null);assert.equal(previewDraftAnswer(pane,'q'),null);
 confirmAnswerPreview(pane,'q',pending);assert.equal(pane.answerPreviews.get('q'),newer);
 confirmAnswerPreview(pane,'q',previewDraftAnswer(pane,'q',newer.stateId));assert.equal(pane.answerPreviews.size,0);
});
test('reports accept only known unique child IDs and pre-submit states',()=>{
 const pane=fixture();
 for(const value of [{},[],{answered:true},{status:'correct'},{status:'draft',score:1},{targetId:'other',status:'draft'},{targetId:null,status:'draft'}])assert.throws(()=>reportAnswerPreview(pane,value),{code:'INVALID_ANSWER_STATE'});
 assert.equal(pane.answerPreviews,undefined);
});
test('snapshot storage is bounded and an expired report never falls back to newer feedback',()=>{
 const pane=fixture(),first=reportAnswerPreview(pane,{status:'draft'});
 for(let i=0;i<256;i++)reportAnswerPreview(pane,{status:'draft'});
 assert.equal(pane.answerStateSnapshots.size,256);
 assert.throws(()=>answerStateForSave(pane,'q',first.stateId),{code:'INVALID_ANSWER_STATE'});
});
test('empty reports, failed saves and frozen or submitted views keep distinct meanings',()=>{
 const pane=fixture();reportAnswerPreview(pane,{targetId:'a',status:'unanswered'});
 assert.equal(outlineStateFor(pane,'q').status,'unanswered');
 const entry=previewDraftAnswer(pane,'q','not-the-current-input');assert.equal(entry,null);
 reportAnswerPreview(pane,{status:'draft'});assert.equal(outlineStateFor(pane,'q').status,'draft');
 pane.collection.states.q.status='submitted';assert.equal(outlineStateFor(pane,'q').status,'submitted');
 pane.view='history';pane.historyView={states:{q:{status:'unanswered',revision:1}}};assert.equal(outlineStateFor(pane,'q').status,'unanswered');
});
test('clearing one child preserves others, and confirmed snapshots restore without scoring',()=>{
 const pane=fixture();pane.collection.states.q.answerState={status:'draft',outlineStates:[{id:'a',status:'draft'}]};
 assert.equal(outlineStateFor(pane,'q').status,'draft');
 reportAnswerPreview(pane,{targetId:'b',status:'draft'});
 reportAnswerPreview(pane,{targetId:'a',status:'unanswered'});assert.equal(outlineStateFor(pane,'q').status,'draft');
 const last=reportAnswerPreview(pane,{targetId:'b',status:'unanswered'});assert.equal(outlineStateFor(pane,'q').status,'unanswered');
 assert.throws(()=>answerStateForSave(pane,'other',last.stateId),{code:'INVALID_ANSWER_STATE'});
 pane.view='history';pane.historyView={states:{q:{status:'draft',answerState:{status:'unanswered',outlineStates:[]}}}};assert.equal(outlineStateFor(pane,'q').status,'unanswered');
});
