import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleEngine } from './rule-engine.js';
import { Library } from './library.js';
import { DevelopmentSettings } from './development-settings.js';
import { readJson, safeDirectory, within } from './files.js';
import { cloneJson, jsonBytes } from './json.js';

const codeRoot = fileURLToPath(new URL('../../', import.meta.url));
const temporaryRoot = path.join(path.dirname(codeRoot), '.temp', 'node-migration');
async function fixture(t, { rules = true } = {}) {
  safeDirectory(temporaryRoot, true);
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'library-'));
  fs.mkdirSync(path.join(root, 'extensions')); fs.mkdirSync(path.join(root, 'question-banks'));
  fs.cpSync(path.join(codeRoot, 'test', 'fixtures', 'legacy-extensions', 'single-choice-1.0.0'), path.join(root, 'extensions', 'choice'), { recursive: true });
  const engine = rules ? await RuleEngine.create(codeRoot) : { run: () => { throw new Error('Metadata index must not execute rules'); }, close() {} };
  if (rules) engine.validationEnvironment = async () => 'fixture-node-environment';
  const library = new Library(root, codeRoot, engine);
  t.after(() => { library.close(); engine.close(); assert.ok(within(temporaryRoot, root) && root !== temporaryRoot); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, engine, library };
}
test('metadata index shows pending entries without executing any extension', async t => {
  const { root, library } = await fixture(t, { rules: false });
  const index = library.index();
  assert.equal(index.extensions[0].id, 'quizforge.single-choice');
  assert.equal(index.extensions[0].validationStatus, 'pending');
  assert.equal(fs.existsSync(path.join(root, '.state', 'resources')), false);
});
test('on-demand collection and page load keep ordinary extension identity', async t => {
  const { library } = await fixture(t);
  const collection = await library.collection('extension', 'quizforge.single-choice');
  assert.equal(collection.stateKey(), 'extension:quizforge.single-choice:quizforge.single-choice:1.0.0');
  assert.ok(collection.questions.length);
  const page = await library.page('quizforge.single-choice', '1.0.0');
  assert.ok(page.script.includes('QF')); assert.deepEqual(page.apiVersion, { major: 1, minor: 2 });
  const ready = library.index().extensions[0]; assert.equal(ready.validationStatus, 'ready');
});
test('external source changes invalidate an already loaded question collection', async t => {
  const { root, library } = await fixture(t);
  const original = await library.collection('extension', 'quizforge.single-choice');
  const examples = path.join(root, 'extensions', 'choice', 'examples.json');
  const actual = original.extension.examples;
  const raw = readJson(actual); raw.questions[0].title = 'Changed by external editor'; fs.writeFileSync(actual, jsonBytes(raw));
  const updated = await library.readCollection('extension', 'quizforge.single-choice');
  assert.equal(updated.questions[0].title, 'Changed by external editor');
  assert.notEqual(updated, original);
});

test('catalog returns changed package bytes to pending rather than reusing a ready status', async t => {
  const { root, library } = await fixture(t);
  const original = await library.collection('extension', 'quizforge.single-choice');
  assert.equal(library.index().extensions[0].validationStatus, 'ready');
  fs.appendFileSync(path.join(root, 'extensions', 'choice', 'practice.css'), '\n/* external package edit */');
  assert.equal(library.index().extensions[0].validationStatus, 'pending');
  const updated = await library.collection('extension', 'quizforge.single-choice');
  assert.notEqual(updated.extensionFingerprint, original.extensionFingerprint);
  assert.equal(library.index().extensions[0].validationStatus, 'ready');
});

test('latest extension preview coexists with banks pinned to older installed versions', async t => {
  const { root, library } = await fixture(t), source = path.join(root, 'extensions', 'choice'), newer = path.join(root, 'extensions', 'choice-new');
  fs.cpSync(source, newer, { recursive: true }); const manifest = readJson(path.join(newer, 'manifest.json')); manifest.version = '1.0.1';
  fs.writeFileSync(path.join(newer, 'manifest.json'), jsonBytes(manifest));
  const example = readJson(path.join(newer, manifest.examples)); example.extension.version = '1.0.1'; fs.writeFileSync(path.join(newer, manifest.examples), jsonBytes(example));
  const bank = readJson(path.join(source, manifest.examples)); bank.id = 'old-pinned-bank'; fs.writeFileSync(path.join(root, 'question-banks', 'old.json'), jsonBytes(bank));
  assert.equal((await library.collection('extension', 'quizforge.single-choice')).extension.version, '1.0.1');
  assert.equal((await library.collection('bank', bank.id)).extension.version, '1.0.0');
  assert.equal(library.index().extensions[0].version, '1.0.1');
  assert.equal((await library.page('quizforge.single-choice', '1.0.0')).html.includes('提交'), true);
});

test('warm collection reads revalidate after the rule runtime identity changes', async t => {
  const { library, engine } = await fixture(t), original = await library.collection('extension', 'quizforge.single-choice');
  let runs = 0; const run = engine.run.bind(engine); engine.run = (...args) => { runs++; return run(...args); };
  engine.validationEnvironment = async () => 'updated-rule-runner';
  const updated = await library.readCollection('extension', 'quizforge.single-choice');
  assert.notEqual(updated, original); assert.ok(runs > 0);
  assert.equal(updated.extensionFingerprint, original.extensionFingerprint, 'Changing host rules must not change a stored extension identity');
});
test('developer mode changes visibility of development banks and leaves', async t => {
  const { root, library } = await fixture(t, { rules: false });
  const extension = path.join(root, 'extensions', 'choice');
  fs.writeFileSync(path.join(extension, 'development.json'), jsonBytes({ name: 'Choice development' }));
  const samples = readJson(path.join(extension, 'manifest.json')).examples;
  const raw = readJson(path.join(extension, samples)); raw.id = 'dev-bank'; raw.extension = { development: 'choice' };
  fs.writeFileSync(path.join(root, 'question-banks', 'dev-bank.json'), jsonBytes(raw));
  assert.equal(library.index().extensions.length, 0); assert.equal(library.index().banks.length, 0);
  library.settings.update({ enabled: true });
  const index = library.index(); assert.equal(index.extensions[0].kind, 'development'); assert.equal(index.banks[0].kind, 'development-bank');
});
test('group management preserves bank identity and rejects nested groups', async t => {
  const { root, library } = await fixture(t, { rules: false });
  const manifest = readJson(path.join(root, 'extensions', 'choice', 'manifest.json'));
  const raw = readJson(path.join(root, 'extensions', 'choice', manifest.examples)); raw.id = 'bank1';
  fs.writeFileSync(path.join(root, 'question-banks', 'bank1.json'), jsonBytes(raw));
  await library.manage({ kind: 'bank', action: 'create', target: 'group', name: 'Group' });
  await library.manage({ kind: 'bank', action: 'update', target: 'item', path: 'bank1.json', name: 'Renamed', group: 'Group' });
  const bank = readJson(path.join(root, 'question-banks', 'Group', 'bank1.json'));
  assert.equal(bank.id, 'bank1'); assert.equal(bank.title, 'Renamed');
  await assert.rejects(library.manage({ kind: 'bank', action: 'update', target: 'group', path: 'Group', name: 'Nested', group: 'Group' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(library.manage({ kind: 'extension', action: 'delete', target: 'item', path: 'choice' }), { code: 'EXTENSION_IN_USE' });
});

test('development publication freezes the reviewed package and keeps the development source', async t => {
  const { root, library } = await fixture(t), source = path.join(root, 'extensions', 'choice');
  fs.writeFileSync(path.join(source, 'development.json'), jsonBytes({ name: 'Development choice' })); library.settings.update({ enabled: true });
  const plan = await library.developmentPublishPlan('choice'); assert.equal(plan.valid, true);
  const result = await library.publishDevelopment('choice', { revision: plan.revision }); assert.equal(result.published, true);
  assert.equal(fs.existsSync(path.join(source, 'development.json')), true);
  const target = path.join(root, 'extensions', plan.targetFolder); assert.equal(fs.existsSync(path.join(target, 'development.json')), false);
  assert.equal((await library.collection('extension', 'quizforge.single-choice')).extension.version, '1.0.0');
  await assert.rejects(library.developmentPublishPlan('choice'), { code: 'EXTENSION_VERSION_EXISTS' });
});

test('publication refuses edits after review and cleans only its staging directory', async t => {
  const { root, library } = await fixture(t), source = path.join(root, 'extensions', 'choice');
  fs.writeFileSync(path.join(source, 'development.json'), jsonBytes({ name: 'Development choice' })); library.settings.update({ enabled: true });
  const plan = await library.developmentPublishPlan('choice'); fs.appendFileSync(path.join(source, 'practice.css'), '\n/* changed after review */');
  await assert.rejects(library.publishDevelopment('choice', { revision: plan.revision }), { code: 'DEVELOPMENT_CHANGED' });
  assert.equal(fs.existsSync(path.join(root, 'extensions', plan.targetFolder)), false);
});
