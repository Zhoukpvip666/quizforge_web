import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveMove } from './archive-move.js';
const base = fileURLToPath(new URL('../../../../.temp/', import.meta.url));
function fixture(t) {
  fs.mkdirSync(base, { recursive: true }); const root = fs.mkdtempSync(path.join(base, 'archive-move-'));
  const source = path.join(root, 'question-banks', "bank's folder"), destination = path.join(root, '.trash/library/receipt/content/bank');
  fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(path.join(source, 'bank.json'), 'original');
  t.after(() => { assert.equal(path.dirname(root), base.slice(0,-1)); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, source, destination };
}
const blocked = () => { throw Object.assign(new Error('blocked'), { code: 'EPERM' }); };
test('transient Windows rename denial retries and archives the original bytes', t => {
  const f = fixture(t); let calls=0;
  archiveMove(f.root,f.source,f.destination,{platform:'win32',pause(){},rename:(...args)=>{if(++calls<3)blocked();fs.renameSync(...args);},native(){throw new Error('unexpected native call');}});
  assert.equal(calls,3);assert.equal(fs.readFileSync(path.join(f.destination,'bank.json'),'utf8'),'original');
});
test('native fallback uses literal paths through environment variables and never overwrites a target',t=>{
  const f=fixture(t);
  archiveMove(f.root,f.source,f.destination,{platform:'win32',rename:blocked,pause(){},native:(command,args,options)=>{assert.equal(command,'powershell.exe');assert.ok(args.at(-1).includes('Move-Item -LiteralPath'));assert.ok(!args.at(-1).includes(f.source));assert.equal(options.windowsHide,true);fs.renameSync(options.env.QF_ARCHIVE_SOURCE,options.env.QF_ARCHIVE_DESTINATION);return {status:0};}});
  assert.equal(fs.existsSync(f.source),false);assert.equal(fs.existsSync(f.destination),true);
});
test('persistent denial preserves source and gives a specific retryable error',t=>{
  const f=fixture(t);
  assert.throws(()=>archiveMove(f.root,f.source,f.destination,{platform:'win32',rename:blocked,pause(){},native:()=>({status:1})}),{code:'LIBRARY_MOVE_BLOCKED',status:409});
  assert.equal(fs.readFileSync(path.join(f.source,'bank.json'),'utf8'),'original');assert.equal(fs.existsSync(f.destination),false);
});
test('occupied archive targets and out-of-library sources are rejected before a move',t=>{
  const f=fixture(t);fs.mkdirSync(f.destination);
  assert.throws(()=>archiveMove(f.root,f.source,f.destination),{code:'LIBRARY_TARGET_EXISTS'});
  assert.throws(()=>archiveMove(f.root,f.root,f.destination),/Invalid archive move scope/);
});
test('actual Windows native move accepts spaces and apostrophes without changing contents',{skip:process.platform!=='win32'},t=>{
 const f=fixture(t);archiveMove(f.root,f.source,f.destination,{platform:'win32',rename:blocked,pause(){}});
 assert.equal(fs.existsSync(f.source),false);assert.equal(fs.readFileSync(path.join(f.destination,'bank.json'),'utf8'),'original');
});
