import { copyFixture, writeFixture } from '../../../test/fixtures/installed-library.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Library } from '../library/library.js';
import { StateStore } from './state-store.js';
import { RuleEngine } from '../extensions/rule-engine.js';
import { upgradeShortAnswerBanks } from './short-answer-upgrade.js';
import { jsonBytes } from '../platform/json.js';
import { safeDirectory, within, readJson } from '../platform/files.js';
const codeRoot = fileURLToPath(new URL('../../../', import.meta.url)), base = path.join(path.dirname(codeRoot), '.temp', 'node-migration');
async function fixture(t, version, mixed = false) {
  safeDirectory(base, true); const root = fs.mkdtempSync(path.join(base, 'upgrade-')); fs.mkdirSync(path.join(root, 'extensions')); fs.mkdirSync(path.join(root, 'question-banks'));
  for (const folder of ['short-answer', 'short-answer-1.2.2', 'short-answer-1.3.0', 'single-choice-1.0.0']) copyFixture(path.join(codeRoot, 'test/fixtures/legacy-extensions', folder), path.join(root, 'extensions', 'Test', folder), { recursive: true });
  const source = version === '1.0.0' ? 'short-answer' : 'short-answer-' + version, extension = path.join(root, 'extensions', 'Test', source), raw = readJson(path.join(extension, 'examples.json'));
  raw.id = 'upgrade-bank'; raw.questions = raw.questions.slice(0, 2);
  if (mixed) { const owner = raw.extension; delete raw.extension; for (const q of raw.questions) q.extension = owner; const choice = readJson(path.join(root, 'extensions/Test/single-choice-1.0.0/examples.json')); const q = choice.questions[0]; q.extension = choice.extension; raw.questions.push(q); }
  writeFixture(path.join(root, 'question-banks', 'upgrade', 'bank.json'), jsonBytes(raw));
  const engine = await RuleEngine.create(codeRoot); engine.validationEnvironment = async () => 'upgrade-fixture'; const library = new Library(root, codeRoot, engine), states = new StateStore(root, engine), bank = await library.collection('bank', raw.id);
  t.after(() => { library.close(); engine.close(); assert.ok(within(base, root)); fs.rmSync(root, { recursive: true, force: true }); }); return { root, library, states, bank };
}
const answer = { formatVersion: 1, document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Saved answer' }] }] } };
test('native automatic short-answer upgrade preserves completed grades, ink and frozen history', async t => {
  const { library, states, bank, root } = await fixture(t, '1.2.2', true), question = bank.questions[0];
  await states.act(bank, question, { requestId: 'upgrade-submit', revision: 0, action: 'submit', data: { answer } });
  await states.act(bank, question, { requestId: 'upgrade-review', revision: 1, action: 'review', data: { review: { score: 2.5 } } });
  const summary = await states.summary(bank), completed = await states.finish(bank, { requestId: 'upgrade-finish', roundId: summary.roundId, summaryVersion: summary.summaryVersion }), frozen = await states.history('bank', bank.id, completed.historyId);
  assert.equal(await upgradeShortAnswerBanks(library, states, true), 1);
  const upgraded = await library.collection('bank', bank.id); assert.equal(upgraded.stateKey(), bank.stateKey()); assert.equal(upgraded.extensionFor(upgraded.questions[0]).version, '1.3.0');
  assert.equal((await states.question(upgraded, upgraded.questions[0])).state.result.score, 2.5); assert.equal((await states.summary(upgraded)).finished, true);
  assert.deepEqual(await states.history('bank', bank.id, completed.historyId), frozen); assert.equal(fs.readdirSync(path.join(root, '.state/upgrade-backups')).length, 1);
  assert.equal(await upgradeShortAnswerBanks(library, states, true), 0);
});
test('old short-answer upgrade preserves the old state file and adds the legacy title to the stem', async t => {
  const { library, states, bank } = await fixture(t, '1.0.0'), q = bank.questions[0]; await states.act(bank, q, { requestId: 'old-upgrade-draft', revision: 0, action: 'draft', data: { answer } });
  const original = fs.readFileSync(states.file(bank)); assert.equal(await upgradeShortAnswerBanks(library, states), 1);
  const updated = await library.collection('bank', bank.id), current = await states.question(updated, updated.questions[0]);
  assert.equal(updated.extension.version, '1.2.2'); assert.deepEqual(fs.readFileSync(states.file(bank)), original); assert.deepEqual(current.state.answer, answer);
  assert.equal(updated.questions[0].data.stem.content[0].type, 'heading'); assert.equal(updated.questions[0].data.stem.content[0].content[0].text, q.title);
});
