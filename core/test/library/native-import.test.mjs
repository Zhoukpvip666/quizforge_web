import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {takeImportedBank} from '../../web/library/native-import.js';

test('native import opens only an installed bank and consumes the hint without another import',()=>{
  const dom=new JSDOM('',{url:'http://127.0.0.1:8787/?keep=yes&imported-bank=g.new#view'}),row={id:'g.new',title:'新题库'};
  const catalog={canManage:true,banks:[{id:'first'},row]};
  assert.equal(takeImportedBank(catalog,dom.window.location,dom.window.history),row);
  assert.equal(dom.window.location.search,'?keep=yes');assert.equal(dom.window.location.hash,'#view');assert.equal(takeImportedBank(catalog,dom.window.location,dom.window.history),null);dom.window.close();
});
test('unknown or invalid bank hints never open arbitrary routes; remote pages ignore them',()=>{
  for(const id of ['missing','../outside','broken']){
    const dom=new JSDOM('',{url:'http://127.0.0.1/?imported-bank='+encodeURIComponent(id)});
    assert.equal(takeImportedBank({canManage:true,banks:[{id:'broken',error:'unreadable'}]},dom.window.location,dom.window.history),null);assert.equal(dom.window.location.search,'');dom.window.close();
  }
  const dom=new JSDOM('',{url:'http://127.0.0.1/?imported-bank=g.new'});
  assert.equal(takeImportedBank({canManage:false,banks:[{id:'g.new'}]},dom.window.location,dom.window.history),null);assert.match(dom.window.location.search,/imported-bank/);dom.window.close();
});
