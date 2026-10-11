import {renderLibraryView} from '../web/views/library-view.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {bindLibraryManagement} from '../web/library-management.js';
import {extensionGroups} from '../web/extension-groups.js';

const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
function fixture(t,overrides={}){
  const dom=new JSDOM(html,{url:'http://localhost/'}),document=dom.window.document;
  const saved={document:globalThis.document,Option:globalThis.Option};globalThis.document=document;globalThis.Option=dom.window.Option;
  const dialog=document.querySelector('#library-manage-dialog');dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;};
  t.after(()=>{dom.window.close();Object.assign(globalThis,saved);});
  const calls=[],changed=[];const catalog={canManage:true,groups:{banks:['资料','空分组'],extensions:['类型']}};
  const config={request:async(path,options)=>{calls.push({path,...options});return {archivedTo:'.trash/library/test'};},getContext:()=>({kind:'bank',catalog}),beforeChange:async()=>{},onChanged:async(...args)=>changed.push(args),...overrides};
  const manager=bindLibraryManagement(config);
  const submit=async()=>{document.querySelector('#library-manage-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));for(let i=0;i<12;i++)await Promise.resolve();};
  return {dom,document,dialog,config,catalog,manager,calls,changed,submit};
}
test('editing a bank sends its physical path, name and chosen group only after preparation',async t=>{
  const f=fixture(t);
  f.manager.open('item',{path:'demo/bank.json',title:'练习',group:'资料'});
  assert.equal(f.document.querySelector('#library-manage-group').value,'资料');
  f.document.querySelector('#library-manage-name').value='新的练习';f.document.querySelector('#library-manage-group').value='空分组';await f.submit();
  assert.deepEqual(JSON.parse(f.calls[0].body),{kind:'bank',target:'item',action:'update',path:'demo/bank.json',name:'新的练习',group:'空分组'});
  assert.equal(f.calls[0].path,'/api/library/manage');assert.equal(f.changed.length,1);assert.equal(f.dialog.open,false);
});
test('bank directory editor changes name and group without exposing or writing feature switches',async t=>{
  const f=fixture(t);f.manager.open('item',{path:'bank.json',title:'Bank',features:{exam:false}});
  assert.equal(f.document.querySelector('#library-manage-fields input[type=checkbox]'),null);
  await f.submit();assert.deepEqual(JSON.parse(f.calls[0].body),{kind:'bank',target:'item',action:'update',path:'bank.json',name:'Bank',group:''});
});
test('group editing only renames at the root, and deletion never submits stale fields',async t=>{
  const f=fixture(t);f.manager.open('group',{path:'资料',name:'资料'});
  assert.equal(f.document.querySelector('#library-manage-group').closest('label').hidden,true);
  assert.deepEqual([...f.document.querySelector('#library-manage-group').options].map(option=>option.value),['']);
  f.manager.open('group',{path:'资料',name:'资料'},'delete');
  assert.equal(f.document.querySelector('#library-manage-fields').hidden,true);assert.match(f.document.querySelector('#library-manage-hint').textContent,/全部内容/);
  await f.submit();assert.deepEqual(JSON.parse(f.calls[0].body),{kind:'bank',target:'group',action:'delete',path:'资料'});
});
test('blank names and remote read-only catalogs do not send writes',async t=>{
  const f=fixture(t);f.manager.open('group',null,'create');await f.submit();assert.equal(f.calls.length,0);assert.match(f.document.querySelector('#library-manage-error').textContent,/名称/);
  f.dialog.close();f.catalog.canManage=false;f.manager.open('item',{path:'file.json',title:'不可修改'});assert.equal(f.dialog.open,false);
});

test('new groups only ask for a name, retain the close entry and save at the root',async t=>{
  const f=fixture(t);f.manager.open('group',null,'create');
  const select=f.document.querySelector('#library-manage-group');
  assert.equal(select.closest('label').hidden,true);
  assert.equal(f.document.querySelector('#library-manage-cancel').hidden,true);
  assert.equal(f.document.querySelector('#library-manage-confirm').hidden,false);
  assert.equal(f.document.querySelector('#library-manage-confirm').textContent,'保存');
  f.document.querySelector('#library-manage-close').click();assert.equal(f.dialog.open,false);
  f.manager.open('group',null,'create');f.document.querySelector('#library-manage-name').value='新分组';
  select.value='资料';await f.submit();
  assert.deepEqual(JSON.parse(f.calls[0].body),{kind:'bank',target:'group',action:'create',path:'',name:'新分组',group:''});
});

test('item editing restores group selection while group editing keeps it hidden',t=>{
  const f=fixture(t);f.manager.open('group',null,'create');f.dialog.close();
  f.manager.open('item',{path:'资料/demo.json',title:'练习',group:'资料'});
  assert.equal(f.document.querySelector('#library-manage-group').closest('label').hidden,false);
  assert.equal(f.document.querySelector('#library-manage-group').value,'资料');
  assert.equal(f.document.querySelector('#library-manage-cancel').hidden,false);
  f.dialog.close();f.manager.open('group',{path:'资料',name:'资料'});
  assert.equal(f.document.querySelector('#library-manage-group').closest('label').hidden,true);
  f.dialog.close();f.manager.open('group',{path:'资料',name:'资料'},'delete');
  assert.equal(f.document.querySelector('#library-manage-cancel').hidden,false);
  assert.equal(f.document.querySelector('#library-manage-fields').hidden,true);
});
test('empty physical groups render and management buttons never open a collection',t=>{
  const f=fixture(t),opened=[],managed=[];
  const sandbox={renderLibraryView,document:f.document,$:selector=>f.document.querySelector(selector),listMode:'bank',activeKey:'bank:a',catalog:{canManage:true,groups:{banks:['资料','空分组']},banks:[{id:'a',path:'资料/a.json',title:'A',group:'资料'}],extensions:[]},extensionGroups,collapsedExtensionGroups:new Set(),libraryManager:{open:(...args)=>managed.push(args)},notice(){},transitionTo:fn=>fn(),openCollection:(...args)=>opened.push(args),el:(tag,classes,text)=>{const node=f.document.createElement(tag);node.className=classes||'';if(text!=null)node.textContent=text;return node;}};
  vm.runInNewContext(source.slice(source.indexOf('function renderLibrary('),source.indexOf('\nfunction renderOutline('))+'\nrenderLibrary();',sandbox);
  assert.equal(f.document.querySelectorAll('.extension-group').length,2);assert.equal(f.document.querySelector('#library-new-group').hidden,false);
  f.document.querySelector('.library-row [data-library-action="update"]').click();assert.equal(opened.length,0);assert.equal(managed[0][0],'item');
  f.document.querySelector('.library-item').click();assert.deepEqual(opened,[['bank','a']]);
});
test('a server dependency check preserves the form for retry',async t=>{
  const f=fixture(t);let attempts=0;
  const manager=bindLibraryManagement({request:async()=>{attempts++;throw new Error('仍被题库使用');},getContext:()=>({kind:'extension',catalog:f.catalog}),beforeChange:async()=>{},onChanged:async()=>assert.fail('must not run')});
  manager.open('item',{path:'type',name:'题型'},'delete');await f.submit();assert.equal(attempts,1);assert.equal(f.dialog.open,true);assert.match(f.document.querySelector('#library-manage-error').textContent,/仍被题库/);assert.equal(f.document.querySelector('#library-manage-confirm').disabled,false);
});
test('failed preparation prevents a write and keeps the dialog usable',async t=>{
  const f=fixture(t,{beforeChange:async()=>{throw new Error('请先保存或取消题目编辑');}});
  f.manager.open('item',{path:'bank.json',title:'练习'},'delete');await f.submit();
  assert.equal(f.calls.length,0);assert.equal(f.dialog.open,true);assert.match(f.document.querySelector('#library-manage-error').textContent,/保存或取消/);assert.equal(f.document.querySelector('#library-manage-confirm').disabled,false);
});

function changedFixture(){
  const a={id:'a',title:'A',path:'a.json',contentRevision:'rev-a'},b={id:'b',title:'B',path:'b.json',contentRevision:'rev-b'};
  const events=[],panes=new Map();
  for(const row of [a,b])panes.set(`bank:${row.id}`,{kind:'bank',id:row.id,key:`bank:${row.id}`,node:{remove(){events.push(`remove:${row.id}`);}},plugin:{destroy(){events.push(`destroy:${row.id}`);}},whiteboard:{destroy(){}}});
  const sandbox={catalog:{canManage:true,developmentEnabled:true,banks:[a,b],extensions:[]},collections:panes,activeKey:'bank:a',listMode:'bank',clearTimeout,
    renderLibrary(){events.push('render');},refreshCatalog(){throw new Error('Returned catalog must be reused');},
    questionsCache:{clear(){events.push('clearQuestions');}},pagesCache:{clear(){events.push('clearPages');}},
    disposeEditorSession(){},disposeScoreSummary(){},notice(value){events.push(value);},
    async activateReady(key){events.push(`activate:${key}`);},async openCollection(kind,id){events.push(`open:${kind}:${id}`);},activate(key){events.push(`empty:${key}`);}};
  vm.runInNewContext('const catalog=globalThis.catalog;\n'+source.slice(source.indexOf('async function applyLibraryChange('),source.indexOf('\nconst libraryManager=')),sandbox);
  return {a,b,sandbox,events,panes,apply:(banks,operation={action:'delete'})=>sandbox.applyLibraryChange({catalog:{banks,extensions:[],groups:{banks:[],extensions:[]}},archivedTo:'.trash/library/test'},operation)};
}
test('deleting another bank uses the returned catalog and keeps the current answer page',async()=>{
  const f=changedFixture(),current=f.panes.get('bank:a');await f.apply([f.a]);
  assert.equal(f.sandbox.catalog.canManage,true);assert.equal(f.sandbox.catalog.developmentEnabled,true);
  assert.equal(f.panes.get('bank:a'),current);assert.equal(current.needsRefresh,undefined);
  assert.equal(f.panes.has('bank:b'),false);assert.ok(f.events.includes('destroy:b'));
  assert.ok(!f.events.some(value=>value.startsWith('activate:')||value.startsWith('open:')||value==='destroy:a'));
});
test('a changed surviving bank is refreshed even when deletion targeted another bank',async()=>{
  const f=changedFixture();await f.apply([{...f.a,contentRevision:'new-revision'}]);
  assert.equal(f.panes.get('bank:a').needsRefresh,true);assert.ok(f.events.includes('activate:bank:a'));assert.ok(f.events.includes('clearQuestions'));
});
test('deleting the active bank closes it and opens the remaining bank',async()=>{
  const f=changedFixture();await f.apply([f.b]);assert.equal(f.panes.has('bank:a'),false);assert.ok(f.events.includes('open:bank:b'));
});
test('renaming an extension label refreshes its current preview',async()=>{
  const f=changedFixture(),row={id:'x',name:'Old',path:'x',contentRevision:'same'};
  f.sandbox.catalog.extensions=[row];f.sandbox.activeKey='extension:x';f.panes.clear();f.panes.set('extension:x',{kind:'extension',id:'x',key:'extension:x'});
  await f.sandbox.applyLibraryChange({catalog:{banks:[],extensions:[{...row,name:'New'}]}},{action:'update'});
  assert.ok(f.events.includes('activate:extension:x'));
});

for(const kind of ['bank','extension'])test(`${kind} group rename never submits a parent group`,async t=>{
  const f=fixture(t,{getContext:()=>({kind,catalog:{canManage:true,groups:{banks:['资料','另一组'],extensions:['资料','另一组']}}})});
  f.manager.open('group',{path:'资料',name:'资料'});
  const select=f.document.querySelector('#library-manage-group');
  assert.equal(select.closest('label').hidden,true);
  select.append(new f.dom.window.Option('另一组','另一组'));select.value='另一组';
  f.document.querySelector('#library-manage-name').value='新名称';await f.submit();
  assert.deepEqual(JSON.parse(f.calls[0].body),{kind,target:'group',action:'update',path:'资料',name:'新名称',group:''});
});
