import test from 'node:test';
import assert from 'node:assert/strict';
import {createEditorSession} from '../../web/editor/editor-session.js';

function fixture({changed=false,invalid=false}={}){
  const form={changed,invalid},calls=[],session=createEditorSession();
  const entry=session.add('q1',{value:{},container:{remove(){calls.push('remove');}},plugin:{get isDirty(){return form.changed;},async getDocument({checkOnly=false}={}){calls.push(checkOnly?'check':'validate');if(!checkOnly&&form.invalid)throw new Error('请填写题干');return {changed:form.changed,document:{title:'题目',data:{stem:'内容'}}};},destroy(){calls.push('destroy');}}});
  return {form,calls,session,entry};
}

test('a session holds only one question and cannot silently retain another edit',()=>{
  const f=fixture({changed:true});assert.throws(()=>f.session.add('q2',{}),/保存或取消/);assert.equal(f.session.get('q1'),f.entry);assert.equal(f.session.get('q2'),undefined);assert.equal(f.session.values().length,1);
});
test('dirty inspection accepts temporarily invalid forms and clears after undo',async()=>{
  const f=fixture({changed:true,invalid:true});assert.equal(await f.session.hasChanges(),true);assert.deepEqual(f.calls,['check']);f.form.changed=false;assert.equal(f.session.isDirty,false);assert.equal(await f.session.hasChanges(),false);
});
test('saving an unchanged question performs no write or full validation',async()=>{
  const f=fixture({invalid:true});assert.equal(await f.session.saveCurrent(()=>assert.fail('unexpected save')),false);assert.deepEqual(f.calls,['check']);
});
test('explicit save validates only the current question and acknowledges successful persistence',async()=>{
  const f=fixture({changed:true}),writes=[];const saved=await f.session.saveCurrent(async value=>{writes.push(value);return {revision:3};},(_change,value)=>{assert.equal(value.revision,3);f.form.changed=false;});assert.equal(saved,true);assert.equal(writes.length,1);assert.equal(writes[0].id,'q1');assert.equal(f.session.isDirty,false);
});
test('validation and network failure keep the same original form available for retry',async()=>{
  const f=fixture({changed:true,invalid:true});await assert.rejects(f.session.saveCurrent(()=>assert.fail('invalid write')),/填写题干/);f.form.invalid=false;await assert.rejects(f.session.saveCurrent(()=>{throw new Error('network');}),/network/);assert.equal(f.session.get('q1'),f.entry);assert.equal(f.form.changed,true);assert.ok(!f.calls.includes('destroy'));
});
test('destroy releases only the current form once and has no draft-storage side effects',()=>{
  const f=fixture({changed:true});f.session.destroy();f.session.destroy();assert.deepEqual(f.calls,['destroy','remove']);assert.deepEqual(f.session.values(),[]);assert.equal(f.session.isDirty,false);assert.equal(f.session.suspend,undefined);assert.equal(f.session.exportDraft,undefined);
});
