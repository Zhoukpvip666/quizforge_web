import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {readFile} from 'node:fs/promises';
import {bindAiSettings} from '../web/ai-settings.js';
import {createAiClient} from '../web/ai-client.js';

test('host scopes AI requests and excludes extension-supplied prompt, model and key',async()=>{
  const calls=[],updates=[];
  const client=createAiClient({path:'/api/collections/bank/demo/questions/q1',makeRequestId:()=> 'host-operation-1',settled:async()=>{},request:async(path,options)=>{calls.push({path,body:options&&JSON.parse(options.body)});return path.endsWith('/confirm')?{status:'confirmed',payload:{state:{result:{score:2.5}}}}:{taskId:'task-1',status:'queued'};},onConfirmed:value=>updates.push(value)});
  await client('ai-grade',{model:'spoofed',apiKey:'secret',question:'override'},'content-version');
  assert.deepEqual(calls[0].body,{contentVersion:'content-version',force:false,requestId:'host-operation-1'});
  await client('ai-confirm',{taskId:'task-1',score:2.5,candidateVersion:'candidate-1',feedback:'override'},'content-version');
  assert.deepEqual(calls[1].body,{score:2.5,candidateVersion:'candidate-1',requestId:'host-operation-1'});
  assert.equal(updates[0].state.result.score,2.5);
  await assert.rejects(client('ai-task',{taskId:'../../other'}));
});

test('a lost confirmation response reuses the same operation ID, even after recreating the scoped bridge',async()=>{
  const confirmations=new Map(),ids=[];let sequence=0;
  const options={path:'/api/collections/bank/demo/questions/q1',confirmations,makeRequestId:()=>`host-id-${++sequence}`,settled:async()=>{},onConfirmed:()=>{},request:async(_path,options)=>{ids.push(JSON.parse(options.body).requestId);if(ids.length===1)throw new Error('response lost');return {status:'confirmed',payload:{state:{revision:1}}};}};
  const args={taskId:'task-1',candidateVersion:'version-1',score:3.5};
  await assert.rejects(createAiClient(options)('ai-confirm',args));
  await createAiClient(options)('ai-confirm',args);
  assert.deepEqual(ids,['host-id-1','host-id-1']);assert.equal(confirmations.size,0);
  await createAiClient(options)('ai-confirm',{...args,score:4});assert.equal(ids[2],'host-id-2');
});

test('targeted grading and lookup keep stable child IDs while excluding model inputs',async()=>{
  const calls=[];
  const client=createAiClient({path:'/question',makeRequestId:()=> 'host-child-request',settled:async()=>{},onConfirmed:()=>{},request:async(path,options)=>{calls.push({path,body:options&&JSON.parse(options.body)});return {taskId:'task-child',targetId:'小题二',status:'queued'};}});
  await client('ai-grade',{targetId:'小题二',force:true,answer:'override'},'version');
  assert.deepEqual(calls[0],{path:'/question/ai/grade',body:{contentVersion:'version',force:true,targetId:'小题二',requestId:'host-child-request'}});
  await client('ai-task',{targetId:'小题二'});
  assert.equal(calls[1].path,`/question/ai/current?targetId=${encodeURIComponent('小题二')}`);
  await client('ai-task',{taskId:'task-child'});assert.equal(calls[2].path,'/question/ai/tasks/task-child');
  await client('ai-retry',{taskId:'task-child'});assert.deepEqual(calls[3].body,{requestId:'host-child-request'});
  for(const targetId of ['',null,' leading','<b>','x'.repeat(129)])await assert.rejects(client('ai-grade',{targetId}));
  assert.equal(calls.length,4);
});

test('a confirmed background task refreshes current persisted grading when its reply was lost',async()=>{
  const calls=[],updates=[];
  const client=createAiClient({path:'/question',makeRequestId:()=> 'host-id-1',settled:async()=>{},shouldRefreshTask:()=>true,onConfirmed:value=>updates.push(value),request:async path=>{calls.push(path);return path==='/question'?{state:{revision:5,result:{score:4}}}:{task:{taskId:'task-1',status:'confirmed'}};}});
  await client('ai-task',{});assert.deepEqual(calls,['/question/ai/current','/question']);assert.equal(updates[0].state.result.score,4);
});

for(const method of ['ai-grade','ai-retry'])test(`an immediately confirmed ${method} refreshes the automatically saved score`,async()=>{
  const calls=[],updates=[];
  const client=createAiClient({path:'/question',makeRequestId:()=> 'host-id-1',settled:async()=>{},shouldRefreshTask:()=>true,onConfirmed:value=>updates.push(value),request:async path=>{calls.push(path);return path==='/question'?{state:{revision:3,result:{score:5}}}:{taskId:'task-1',status:'confirmed'};}});
  const reply=await client(method,{taskId:'task-1'},'content-version');
  assert.equal(reply.data.status,'confirmed');assert.equal(calls.at(-1),'/question');assert.equal(updates[0].state.result.score,5);
});

async function fixture(request){
  const dom=new JSDOM(await readFile(new URL('../web/index.html',import.meta.url),'utf8'));
  const document=dom.window.document,dialog=document.getElementById('network-settings-dialog');dialog.open=true;dialog.close=()=>{dialog.open=false;dialog.dispatchEvent(new dom.window.Event('close'));};
  const ui=bindAiSettings({request,document});
  return {ui,document,dom,get:id=>document.getElementById(`ai-settings-${id}`)};
}
const profile={canManage:true,enabled:true,baseUrl:'http://localhost:11434/v1',model:'local',apiKeyConfigured:true,vision:false,outputMode:'json',maxOutputTokens:8192,timeoutSeconds:90};
const credential='synthetic-saved-key';
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
const passedReport={ok:true,status:'passed',summary:'文字评分与基础图片识别均通过。',model:'local',testedAt:'2026-10-10T01:00:00Z',calls:2,elapsedMs:450,checks:[{id:'connection',label:'文字连接',status:'passed',message:'模型已响应。'},{id:'gradingFormat',label:'评分输出',status:'passed',message:'评分格式正常。'},{id:'vision',label:'图片识别',status:'passed',message:'已识别随机图片。'}],note:'复杂图片仍需验证。'};

test('simple AI settings restore a masked editable key and retain it after saving',async()=>{
  const calls=[];
  const f=await fixture(async(path,options)=>{calls.push({path,options});return path.endsWith('/credential')?{apiKey:credential}:profile;});
  await f.ui.open();assert.equal(f.get('apiKey').value,credential);assert.equal(f.get('apiKey').type,'password');
  for(const field of ['vision','outputMode','maxOutputTokens','timeoutSeconds','clearApiKey'])assert.equal(f.get(field),null);
  f.get('form').dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));await settle();
  const saved=JSON.parse(calls[2].options.body);assert.equal(saved.apiKey,credential);assert.equal(saved.baseUrl,profile.baseUrl);assert.equal(f.get('apiKey').value,credential);
  assert.equal('vision' in saved,false);assert.equal('outputMode' in saved,false);
  f.get('close').click();assert.equal(f.get('apiKey').value,'');
  f.ui.destroy();f.dom.window.close();
});

test('deleting or replacing the password field updates the stored key without a separate checkbox',async()=>{
  const bodies=[];
  const f=await fixture(async(path,options)=>{if(path.endsWith('/credential'))return {apiKey:credential};if(options){const body=JSON.parse(options.body);bodies.push(body);return {...profile,apiKeyConfigured:!body.clearApiKey};}return profile;});
  await f.ui.open();f.get('apiKey').value='';f.get('form').dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));await settle();
  assert.equal(bodies[0].clearApiKey,true);assert.equal('apiKey' in bodies[0],false);assert.equal(f.get('apiKey').value,'');
  f.get('apiKey').value='synthetic-replacement-key';f.get('form').dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));await settle();
  assert.equal(bodies[1].apiKey,'synthetic-replacement-key');assert.equal('clearApiKey' in bodies[1],false);assert.equal(f.get('apiKey').value,'synthetic-replacement-key');
  f.ui.destroy();f.dom.window.close();
});

test('one test button saves current input and renders all diagnostics even with AI grading disabled',async()=>{
  const calls=[];
  const f=await fixture(async(path,options)=>{
    calls.push({path,options});if(path.endsWith('/credential'))return {apiKey:credential};
    if(path.endsWith('/test'))return {...passedReport,settings:{...profile,enabled:false,vision:true,testReport:passedReport}};
    return {...profile,enabled:false};
  });
  await f.ui.open();assert.equal(f.get('test').disabled,false);
  f.get('model').value='changed-model';f.get('apiKey').value='changed-synthetic-key';f.get('test').click();await settle();await settle();
  assert.deepEqual(calls.slice(2).map(call=>[call.path,call.options.method]),[['/api/settings/ai','PUT'],['/api/settings/ai/test','POST']]);
  assert.equal(JSON.parse(calls[2].options.body).model,'changed-model');assert.equal(JSON.parse(calls[2].options.body).apiKey,'changed-synthetic-key');
  assert.equal(f.get('apiKey').value,'changed-synthetic-key');assert.equal(f.get('report').hidden,false);assert.equal(f.get('report').querySelectorAll('li').length,3);
  assert.match(f.get('report').textContent,/文字连接.*通过.*评分输出.*通过.*图片识别.*通过/s);
  assert.equal(f.get('test').disabled,false);assert.match(f.get('status').textContent,/测试已完成/);
  f.ui.destroy();f.dom.window.close();
});

test('failed vision report remains visible and edited configuration clears stale diagnostics',async()=>{
  const partial={...passedReport,status:'partial',summary:'文字评分可用，图片识别尚未通过。',checks:passedReport.checks.map(check=>check.id==='vision'?{...check,status:'unknown',message:'模型调用等待超时。'}:check)};
  const f=await fixture(async path=>path.endsWith('/credential')?{apiKey:credential}:{...profile,testReport:partial});
  await f.ui.open();assert.match(f.get('report').textContent,/无法判断/);assert.match(f.get('report').textContent,/超时/);
  f.get('model').value='new-model';f.get('model').dispatchEvent(new f.dom.window.Event('input'));assert.equal(f.get('report').hidden,true);assert.match(f.get('status').textContent,/配置有修改/);
  f.ui.destroy();f.dom.window.close();
});

test('remote settings never request credentials and cannot save or test',async()=>{
  const calls=[];
  const f=await fixture(async(path,options)=>{calls.push({path,options});return {...profile,canManage:false};});
  await f.ui.open();assert.equal(calls.length,1);assert.equal(f.get('apiKey').value,'');
  for(const name of ['save','test','apiKey','autoGrade'])assert.equal(f.get(name).disabled,true);
  f.get('form').dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));assert.equal(calls.length,1);
  f.ui.destroy();f.dom.window.close();
});

test('automatic grading is independently editable and ordinary save never invokes model tests',async()=>{
  const calls=[];
  const f=await fixture(async(path,options)=>{calls.push({path,options});if(path.endsWith('/credential'))return {apiKey:credential};return options?{...profile,autoGrade:JSON.parse(options.body).autoGrade}:profile;});
  await f.ui.open();assert.equal(f.get('autoGrade').checked,false);assert.match(f.get('status').textContent,/题卡点击评分.*自动保存/);
  f.get('autoGrade').checked=true;f.get('form').dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));await settle();
  assert.equal(calls.length,3);assert.equal(JSON.parse(calls[2].options.body).autoGrade,true);assert.equal(f.get('autoGrade').checked,true);
  assert.equal(calls.some(call=>call.path.endsWith('/test')),false);
  f.get('autoGrade').checked=false;f.get('form').dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));await settle();assert.equal(f.get('autoGrade').checked,false);
  f.ui.destroy();f.dom.window.close();
});

test('closing settings before a credential response arrives does not restore the secret',async()=>{
  let resolve;
  const f=await fixture(async path=>path.endsWith('/credential')?await new Promise(done=>{resolve=done;}):profile);
  const opening=f.ui.open();await settle();f.get('close').click();resolve({apiKey:credential});await opening;
  assert.equal(f.get('apiKey').value,'');assert.equal(f.document.getElementById('network-settings-dialog').open,false);
  f.ui.destroy();f.dom.window.close();
});

test('an old backend missing the credential endpoint explains restart and cannot clear the existing key',async()=>{
  const calls=[];
  const f=await fixture(async(path,options)=>{calls.push({path,options});if(path.endsWith('/credential'))throw Object.assign(new Error('Endpoint not found'),{status:404,code:'NOT_FOUND'});return profile;});
  await f.ui.open();assert.match(f.get('error').textContent,/关闭原启动窗口.*重新启动/);assert.equal(f.get('save').disabled,true);assert.equal(f.get('apiKey').value,'');
  f.get('form').dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));assert.equal(calls.length,2);
  f.ui.destroy();f.dom.window.close();
});
