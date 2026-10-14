import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Library } from './library.js';
import { RuleEngine } from '../extensions/rule-engine.js';
import { StateStore } from '../practice/state-store.js';
import { readJson, within } from '../platform/files.js';
import { bankLocator } from './identity.js';
import { AiGradingService } from '../ai/ai-grading-service.js';

const code = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = path.join(path.dirname(code), '.temp', 'package-v2-tests');
const groupId = 'ec7a70a3-4f7d-4fa5-b176-d8cb51dd3a07', bankId = '136832c4-69e0-4ef9-9b72-e86ce4317405', extensionId = 'f7aa4878-0e49-4f2f-a6d5-c6a7636b24ca';
let engine;
before(async () => { engine = await RuleEngine.create(code); engine.validationEnvironment = async () => 'fixture'; });
after(() => engine.close());
function fixture(t, populated = true) {
  fs.mkdirSync(temporary, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporary, 'test-'));
  fs.mkdirSync(path.join(root, 'extensions')); fs.mkdirSync(path.join(root, 'question-banks'));
  const library = new Library(root, code, engine);
  t.after(() => { library.close(); assert.ok(within(temporary, root)); fs.rmSync(root, { recursive: true, force: true }); });
  if (populated) {
    install(root, 'choice');
    const raw = readJson(path.join(root, 'extensions/choice/examples.json'));
    raw.id = bankId; raw.version = '1.0'; raw.extension = { id: extensionId, path: 'extensions/choice' };
    raw.questions[1].extension = { ...raw.extension };
    fs.mkdirSync(path.join(root, 'question-banks/Group/leaf'), { recursive: true });
    fs.writeFileSync(path.join(root, 'question-banks/Group/.group.json'), JSON.stringify({ schemaVersion: 1, kind: 'bank-group', id: groupId }));
    fs.writeFileSync(path.join(root, 'question-banks/Group/leaf/bank.json'), JSON.stringify(raw));
  }
  return { root, library, file: path.join(root, 'question-banks/Group/leaf/bank.json') };
}
function install(root, name) {
  const directory = path.join(root, 'extensions', name);
  fs.cpSync(path.join(code, 'test/fixtures/legacy-extensions/single-choice-1.0.0'), directory, { recursive: true });
  const manifest = readJson(path.join(directory, 'manifest.json')); manifest.id = extensionId;
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  const raw = readJson(path.join(directory, 'examples.json')); raw.extension.id = extensionId;
  fs.writeFileSync(path.join(directory, 'examples.json'), JSON.stringify(raw));
  return directory;
}
async function pack(source) { const result = await source.library.exportGroup('Group'); try { return fs.readFileSync(result.file); } finally { result.close(); } }
test('v2 reuses matching UUID/hash at a different path and rewrites default and per-question references only in imported banks', async t => {
  const source = fixture(t), target = fixture(t, false), before = fs.readFileSync(source.file);
  install(target.root, '本地选择题');
  const result = await target.library.importPackage(await pack(source));
  assert.equal(result.importedExtensions, 0); assert.equal(result.skippedExtensions, 1);
  const row = result.catalog.banks[0], raw = readJson(path.join(target.root, 'question-banks', row.path, 'bank.json'));
  assert.equal(raw.extension.path, 'extensions/本地选择题'); assert.equal(raw.questions[1].extension.path, raw.extension.path);
  assert.deepEqual(fs.readFileSync(source.file), before);
  const collection = await target.library.collection('bank', row.id);
  assert.equal(collection.extensionFor(collection.questions[1]).referencePath, raw.extension.path);
  const example = await target.library.collection('extension', result.catalog.extensions[0].id);
  assert.equal(example.extension.referencePath, raw.extension.path);
});
test('same UUID/version with changed code installs a suffixed physical directory, keeps display name and independently loads examples', async t => {
  const source = fixture(t), target = fixture(t, false), directory = install(target.root, 'choice');
  fs.appendFileSync(path.join(directory, 'practice.css'), '\n/* local variant */');
  const before = fs.readFileSync(path.join(directory, 'practice.css'));
  const result = await target.library.importPackage(await pack(source));
  assert.equal(result.importedExtensions, 1); assert.equal(result.catalog.extensions.length, 2);
  assert.equal(new Set(result.catalog.extensions.map(row => row.id)).size, 2);
  assert.equal(new Set(result.catalog.extensions.map(row => row.name)).size, 1);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'practice.css')), before);
  assert.equal(result.catalog.banks[0].extension.path, 'extensions/choice（2）');
  for (const row of result.catalog.extensions) assert.equal((await target.library.collection('extension', row.id)).extension.referencePath, row.referencePath);
});
test('equal version requires a choice; replacement inherits frozen history and higher numeric version replaces automatically', async t => {
  const source = fixture(t), target = fixture(t), states = new StateStore(target.root, engine);
  const collection = await target.library.collection('bank', bankLocator(groupId, bankId)), q = collection.questions[0];
  await states.act(collection, q, { requestId: randomUUID(), revision: 0, action: 'submit', data: { answer: { selectedOptionId: q.data.correctOptionId } } });
  const summary = await states.summary(collection);
  await states.finish(collection, { requestId: randomUUID(), roundId: summary.roundId, summaryVersion: summary.summaryVersion });
  const history = (await states.history('bank', collection.id)).records;
  const raw = readJson(source.file); raw.title = '新版标题'; raw.questions[0].data.stem += ' updated'; fs.writeFileSync(source.file, JSON.stringify(raw));
  let preview = await target.library.importPackage(await pack(source));
  assert.equal(preview.needsConfirmation, true); assert.equal(preview.conflicts[0].existingVersion, '1.0');
  await target.library.commitImport(preview.importId, { [bankId]: 'keep' }); assert.notEqual(readJson(target.file).title, raw.title);
  preview = await target.library.importPackage(await pack(source));
  await target.library.commitImport(preview.importId, { [bankId]: 'replace' });
  const updated = await target.library.collection('bank', collection.id);
  await states.question(updated, updated.questions[0]);
  assert.deepEqual((await states.history('bank', collection.id)).records, history);
  assert.equal(readJson(target.file).title, raw.title);
  raw.version = '1.10'; fs.writeFileSync(source.file, JSON.stringify(raw));
  const result = await target.library.importPackage(await pack(source)); assert.equal(result.replacedBanks, 1); assert.equal(result.needsConfirmation, undefined);
});
test('same bank UUID in different groups has independent state; moving a bank retains its state and history', async t => {
  const f = fixture(t), states = new StateStore(f.root, engine), oldId = bankLocator(groupId, bankId);
  const collection = await f.library.collection('bank', oldId), q = collection.questions[0];
  await states.act(collection, q, { requestId: randomUUID(), revision: 0, action: 'draft', data: { answer: { selectedOptionId: q.data.correctOptionId } } });
  await f.library.manage({ kind: 'bank', action: 'create', target: 'group', name: 'Other' });
  const moved = await f.library.manage({ kind: 'bank', action: 'update', target: 'item', path: 'Group/leaf', name: collection.title, group: 'Other' });
  const row = moved.catalog.banks[0], current = await f.library.collection('bank', row.id);
  assert.notEqual(row.id, oldId); assert.notEqual(current.stateKey(), collection.stateKey());
  assert.equal((await states.question(current, current.questions[0])).state.status, 'draft');
  assert.equal((await f.library.collection('bank', oldId)).id, row.id);
  fs.mkdirSync(path.dirname(f.file), { recursive: true }); fs.copyFileSync(path.join(f.root, 'question-banks/Other/leaf/bank.json'), f.file);
  states.clearMemory();
  const copy = await f.library.collection('bank', oldId); assert.notEqual(copy.stateKey(), current.stateKey());
  assert.equal((await states.question(copy, copy.questions[0])).state.status, 'unanswered');
});
test('logical extension grouping changes only host metadata; deleting a group leaves extension files intact', async t => {
  const f = fixture(t), row = f.library.index().extensions[0], before = fs.readFileSync(path.join(f.root, 'extensions/choice/manifest.json'));
  await f.library.manage({ kind: 'extension', action: 'create', target: 'group', name: '基础' });
  await f.library.manage({ kind: 'extension', action: 'update', target: 'item', path: row.path, name: '显示名称', group: '基础' });
  assert.equal(f.library.index().extensions[0].group, '基础');
  await f.library.manage({ kind: 'extension', action: 'delete', target: 'group', path: '基础' });
  assert.equal(f.library.index().extensions[0].group, undefined);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'extensions/choice/manifest.json')), before);
});
test('AI tasks follow a recorded bank move without relaxing content or answer guards',()=>{
 const task={value:{kind:'bank',collectionId:'old',stateKey:'bank:old:mixed',questionId:'q',createdAt:'2026-10-01T00:00:00Z',snapshot:{stateKey:'bank:old:mixed',questionFingerprint:'guard',submissionGeneration:3}}};
 let persisted=0;const service={file(){},live:new Map([['task',task]]),library:{bankLocations:{historical:()=> 'new'}},persist(){persisted++;}};
 const collection={kind:'bank',id:'new',stateKey:()=> 'bank:new:mixed'};
 AiGradingService.prototype.scoped.call(service,collection,{id:'q'},'task');
 assert.equal(task.value.collectionId,'new');assert.equal(task.value.snapshot.stateKey,'bank:new:mixed');assert.equal(task.value.snapshot.questionFingerprint,'guard');assert.equal(task.value.snapshot.submissionGeneration,3);assert.equal(persisted,1);
 service.library.bankLocations.historical=()=> 'other';assert.throws(()=>AiGradingService.prototype.scoped.call(service,{...collection,id:'copy',stateKey:()=> 'bank:copy:mixed'},{id:'q'},'task'),{code:'AI_TASK_NOT_FOUND'});
});
test('installing a variant never makes an existing legacy ID/version bank silently ambiguous',async t=>{
 const source=fixture(t),target=fixture(t),raw=readJson(target.file);raw.extension={id:extensionId,version:'1.0.0'};delete raw.questions[1].extension;fs.writeFileSync(target.file,JSON.stringify(raw));
 fs.appendFileSync(path.join(source.root,'extensions/choice/practice.css'),'\n/* variant */');const before=fs.readFileSync(target.file);
 await assert.rejects(target.library.importPackage(await pack(source)),{code:'LIBRARY_IMPORT_CONFLICT'});
 assert.deepEqual(fs.readFileSync(target.file),before);assert.deepEqual(fs.readdirSync(path.join(target.root,'extensions')),['choice']);
});
test('failed bank installation rolls back installed extensions and restores replaced bank', async t => {
  const source = fixture(t), target = fixture(t), original = fs.readFileSync(target.file);
  fs.appendFileSync(path.join(source.root, 'extensions/choice/practice.css'), '\n/* new variant */');
  const preview = await target.library.importPackage(await pack(source)), rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === path.dirname(target.file) && String(from).includes('content')) throw new Error('injected installation failure'); return rename(from, to); };
  try { await assert.rejects(target.library.commitImport(preview.importId, { [bankId]: 'replace' }), /injected/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(target.file), original);
  assert.deepEqual(fs.readdirSync(path.join(target.root, 'extensions')), ['choice']);
});
