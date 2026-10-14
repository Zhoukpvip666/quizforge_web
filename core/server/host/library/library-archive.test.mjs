import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import yazl from 'yazl';
import { Library } from './library.js';
import { RuleEngine } from '../extensions/rule-engine.js';
import { ResourceStore } from '../resources/resources.js';
import { LibraryArchive, MANIFEST, FORMAT } from './library-archive.js';
import { readJson, safeDirectory, within } from '../platform/files.js';
import { jsonBytes } from '../platform/json.js';

const codeRoot = fileURLToPath(new URL('../../../', import.meta.url)), temporaryRoot = path.join(path.dirname(codeRoot), '.temp', 'node-migration');
function root(t) { safeDirectory(temporaryRoot, true); const directory = fs.mkdtempSync(path.join(temporaryRoot, 'archive-')); fs.mkdirSync(path.join(directory, 'extensions')); fs.mkdirSync(path.join(directory, 'question-banks')); t.after(() => { assert.ok(within(temporaryRoot, directory) && directory !== temporaryRoot); fs.rmSync(directory, { recursive: true, force: true }); }); return directory; }
async function packageBuffer(entries) { const zip = new yazl.ZipFile(), chunks = []; zip.outputStream.on('data', chunk => chunks.push(chunk)); const ended = once(zip.outputStream, 'end'); for (const [name, bytes] of entries) if (name.endsWith('/')) zip.addEmptyDirectory(name); else zip.addBuffer(Buffer.from(bytes), name); zip.end(); await ended; return Buffer.concat(chunks); }
test('legacy format fallback exports mixed UUID/string bank IDs with exact path bindings without modifying source banks',async t=>{
 const sourceRoot=root(t),targetRoot=root(t),leaf=path.join(sourceRoot,'extensions/choice');fs.cpSync(path.join(codeRoot,'test/fixtures/legacy-extensions/single-choice-1.0.0'),leaf,{recursive:true});
 const group=path.join(sourceRoot,'question-banks/Group');fs.mkdirSync(group);
 fs.writeFileSync(path.join(group,'.group.json'),jsonBytes({schemaVersion:1,kind:'bank-group',id:'a04a41c3-7374-4a09-9892-1f25e30d24f4'}));
 const raw=readJson(path.join(leaf,'examples.json'));raw.extension={id:raw.extension.id,path:'extensions/choice'};raw.questions[1].extension={...raw.extension};
 const ids=['old-bank','419257df-b27f-4979-af8a-dea38a58ceda'],before=[];
 for(const identity of ids){raw.id=identity;const file=path.join(group,identity+'.json');fs.writeFileSync(file,jsonBytes(raw));before.push([file,fs.readFileSync(file)]);}
 const engine=await RuleEngine.create(codeRoot);engine.validationEnvironment=async()=>'fixture';const source=new Library(sourceRoot,codeRoot,engine),target=new Library(targetRoot,codeRoot,engine);t.after(()=>{source.close();target.close();engine.close();});
 const exported=await source.exportGroup('Group');try{const imported=await target.importPackage(fs.readFileSync(exported.file));assert.equal(imported.importedBanks,2);assert.equal(imported.importedExtensions,1);for(const identity of ids){const collection=await target.collection('bank',identity);assert.equal(collection.extensionFor(collection.questions[1]).id,'quizforge.single-choice');}}finally{exported.close();}
 for(const [file,bytes]of before)assert.deepEqual(fs.readFileSync(file),bytes);
});
test('qbank group round-trip keeps IDs and versions; identical import skips and conflicts preserve data', async t => {
  const first = root(t), second = root(t); fs.cpSync(path.join(codeRoot, 'test', 'fixtures', 'legacy-extensions', 'single-choice-1.0.0'), path.join(first, 'extensions', 'choice'), { recursive: true }); const raw = readJson(path.join(first, 'extensions', 'choice', 'examples.json')); raw.id = 'bank'; fs.mkdirSync(path.join(first, 'question-banks', 'Group')); fs.writeFileSync(path.join(first, 'question-banks', 'Group', 'bank.json'), jsonBytes(raw));
  // A bank.json directly inside a directory denotes a bank, so give the group a
  // normal named bank file rather than accidentally creating a standalone leaf.
  fs.renameSync(path.join(first, 'question-banks', 'Group', 'bank.json'), path.join(first, 'question-banks', 'Group', 'questions.json'));
  const engine = await RuleEngine.create(codeRoot); engine.validationEnvironment = async () => 'fixture'; const source = new Library(first, codeRoot, engine), target = new Library(second, codeRoot, engine); t.after(() => { source.close(); target.close(); engine.close(); });
  const download = await source.exportGroup('Group'); let bytes; try { bytes = fs.readFileSync(download.file); } finally { download.close(); }
  const imported = await target.importPackage(bytes); assert.equal(imported.importedBanks, 1); assert.equal(imported.importedExtensions, 1); const bank = await target.collection('bank', 'bank'); assert.equal(bank.extension.id, 'quizforge.single-choice'); assert.equal(bank.extension.version, '1.0.0');
  const skipped = await target.importPackage(bytes); assert.equal(skipped.skippedBanks, 1); assert.equal(skipped.skippedExtensions, 1);
  const file = path.join(second, 'question-banks', 'Group', 'bank', 'bank.json'), changed = readJson(file); changed.title = 'locally changed'; fs.writeFileSync(file, jsonBytes(changed)); const before = fs.readFileSync(file);
  await assert.rejects(target.importPackage(bytes), { code: 'LIBRARY_IMPORT_CONFLICT' }); assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.readdirSync(path.join(second, '.temp')).length, 0);
});
test('arbitrary ZIP, case-duplicate files and undeclared private files are refused before installation', async t => {
  const directory = root(t), archive = new LibraryArchive(directory, new ResourceStore(directory));
  await assert.rejects(archive.importPackage(await packageBuffer([['anything.txt', 'hello']]), async () => {}), { code: 'INVALID_LIBRARY_ARCHIVE' });
  const marker = jsonBytes({ format: FORMAT, formatVersion: 1, group: 'Group' });
  await assert.rejects(archive.importPackage(await packageBuffer([[MANIFEST, marker], ['question-banks/Group/', ''], ['extensions/Group/', ''], ['question-banks/Group/a.json', '{}'], ['question-banks/Group/A.json', '{}']]), async () => {}), { code: 'INVALID_LIBRARY_ARCHIVE' });
  assert.equal(fs.readdirSync(path.join(directory, 'question-banks')).length, 0); assert.equal(fs.readdirSync(path.join(directory, 'extensions')).length, 0);
});
test('manifest-declared hidden runtime files are transported and unrelated hidden files are omitted', async t => {
  const directory = root(t), leaf = path.join(directory, 'extensions', 'choice'); fs.cpSync(path.join(codeRoot, 'test', 'fixtures', 'legacy-extensions', 'single-choice-1.0.0'), leaf, { recursive: true }); const manifest = readJson(path.join(leaf, 'manifest.json')); fs.renameSync(path.join(leaf, manifest.rules), path.join(leaf, '.rules.js')); manifest.rules = '.rules.js'; fs.writeFileSync(path.join(leaf, 'manifest.json'), jsonBytes(manifest)); fs.writeFileSync(path.join(leaf, '.secret'), 'excluded');
  const archive = new LibraryArchive(directory, new ResourceStore(directory)), destination = path.join(directory, '.temp', 'copy'); archive.copyExtension(leaf, destination); assert.equal(fs.existsSync(path.join(destination, '.rules.js')), true); assert.equal(fs.existsSync(path.join(destination, '.secret')), false);
});
