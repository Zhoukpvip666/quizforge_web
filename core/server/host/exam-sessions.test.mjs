import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Library } from './library.js';
import { RuleEngine } from './rule-engine.js';
import { StateStore } from './state-store.js';
import { AiGradingService } from './ai-grading-service.js';
import { CollectionRoutes } from './collection-routes.js';
import { ExamSessions } from './exam-sessions.js';
import { BankFeatures } from './features.js';
import { readJson, safeDirectory, within } from './files.js';
import { jsonBytes } from './json.js';

const codeRoot = fileURLToPath(new URL('../../', import.meta.url)), temporaryRoot = path.join(path.dirname(codeRoot), '.temp', 'node-migration');
async function fixture(t, history = true) {
  safeDirectory(temporaryRoot, true); const root = fs.mkdtempSync(path.join(temporaryRoot, 'exam-')); fs.mkdirSync(path.join(root, 'extensions')); fs.mkdirSync(path.join(root, 'question-banks'));
  fs.cpSync(path.join(codeRoot, 'test', 'fixtures', 'legacy-extensions', 'single-choice-1.0.0'), path.join(root, 'extensions', 'choice'), { recursive: true });
  const raw = readJson(path.join(root, 'extensions', 'choice', 'examples.json')); raw.id = 'bank'; raw.features = { history }; fs.writeFileSync(path.join(root, 'question-banks', 'bank.json'), jsonBytes(raw));
  const engine = await RuleEngine.create(codeRoot); engine.validationEnvironment = async () => 'fixture'; const library = new Library(root, codeRoot, engine), states = new StateStore(root, engine), gateway = { freeze() { return this; }, generate() { throw new Error('No model calls expected'); } }, ai = new AiGradingService(root, states, library, gateway), writes = { read: async context => context.body, validateOrigin() {} }, routes = new CollectionRoutes(library, states, ai, writes, () => false);
  let now = Date.now(); const options = { now: () => now }, exams = new ExamSessions(root, library, states, ai, routes, writes, () => false, options), source = await library.collection('bank', 'bank');
  t.after(() => { exams.close(); ai.close(); library.close(); engine.close(); assert.ok(within(temporaryRoot, root) && root !== temporaryRoot); fs.rmSync(root, { recursive: true, force: true }); }); return { root, exams, states, library, ai, writes, routes, options, source, advance: milliseconds => now += milliseconds };
}
function context(body, owner) { return { body, request: { headers: { ...(owner ? { 'x-quizforge-practice-session': owner } : {}) } }, url: new URL('http://127.0.0.1/') }; }
test('exam hides per-question submit and summary until hand-in, then aggregates saved choices', async t => {
  const { exams, source, states } = await fixture(t), command = { requestId: 'exam-start-fixture', durationMinutes: null }, started = await exams.start(source, command); assert.equal(started.status, 'in-progress'); assert.equal(Object.hasOwn(started, 'packages'), false); assert.equal((await exams.start(source, command)).id, started.id);
  const collection = exams.collection(started.id), question = collection.questions[0], parts = ['', 'api', 'exam', started.id, 'questions', question.id, 'actions'];
  const saved = await exams.route(context({ requestId: 'exam-draft-fixture', revision: 0, action: 'draft', data: { answer: { selectedOptionId: 'A' } } }), 'POST', parts); assert.equal(saved.state.status, 'draft'); assert.equal((await states.overview(collection)).states[question.id].status, 'draft');
  await assert.rejects(exams.route(context({ requestId: 'exam-submit-fixture', revision: 1, action: 'submit', data: { answer: { selectedOptionId: 'A' } } }), 'POST', parts), { code: 'EXAM_ACTION_DISABLED' });
  await assert.rejects(exams.route(context(), 'GET', ['', 'api', 'exam', started.id, 'summary']), { code: 'EXAM_ACTION_DISABLED' });
  const finished = await exams.submit(started.id); assert.equal(finished.status, 'completed'); assert.equal(finished.summary.score, 1); assert.equal(finished.summary.submittedCount, 1);
  const history = await exams.appendHistory('bank', source.id, { records: [] }); assert.equal(history.records[0].mode, 'exam'); assert.ok(history.records[0].id.startsWith('exam-')); assert.equal((await exams.history('bank', source.id, history.records[0].id, false)).questions[0].payload.state.result.correct, true);
});
test('deadline locks and submits once; frozen packages survive source changes and a restart', async t => {
  const { root, exams, source, states, library, ai, writes, routes, options, advance } = await fixture(t), started = await exams.start(source, { requestId: 'exam-timeout-fixture', durationMinutes: 1 }); const collection = exams.collection(started.id), question = collection.questions[0];
  await states.act(collection, question, { requestId: 'exam-saved-fixture', revision: 0, action: 'draft', data: { answer: { selectedOptionId: 'A' } } }); advance(60001); await exams.tick(); const ended = exams.publicRecord(exams.require(started.id)); assert.equal(ended.status, 'completed'); assert.equal(ended.submissionReason, 'timeout');
  fs.writeFileSync(source.extension.rules, 'throw new Error("source changed");'); const reopened = new ExamSessions(root, library, states, ai, routes, writes, () => false, options); t.after(() => reopened.close());
  assert.equal((await reopened.list('bank', source.id)).records[0].status, 'completed'); const restored = reopened.collection(started.id); assert.equal((await states.question(restored, restored.questions[0])).state.result.correct, true);
});
test('deleting an unfinished exam cancels deadline processing across restart', async t => {
  const { exams, source, root, library, states, ai, routes, writes, options, advance } = await fixture(t), started = await exams.start(source, { requestId: 'exam-delete-fixture', durationMinutes: 1 }); await exams.delete(started.id, null); advance(60001); await exams.tick();
  const reopened = new ExamSessions(root, library, states, ai, routes, writes, () => false, options); t.after(() => reopened.close()); assert.equal((await reopened.list('bank', source.id)).records.length, 0); assert.throws(() => reopened.collection(started.id), { code: 'COLLECTION_NOT_FOUND' });
});
test('temporary exams require page ownership and delete only their generated package tree', async t => {
  const { exams, source, root } = await fixture(t, false), owner = '12345678-1234-1234-1234-123456789012', stranger = '12345678-1234-1234-1234-123456789013';
  await assert.rejects(exams.start(source, { requestId: 'exam-no-owner', durationMinutes: null }), { code: 'PRACTICE_SESSION_REQUIRED' }); const started = await exams.start(source, { requestId: 'exam-with-owner', durationMinutes: null }, owner);
  assert.equal(fs.existsSync(path.join(root, '.state', 'exams', started.id, 'exam.json')), false); await assert.rejects(exams.route(context(null, stranger), 'GET', ['', 'api', 'exam', started.id]), { code: 'COLLECTION_NOT_FOUND' });
  await exams.delete(started.id, owner); assert.equal(fs.existsSync(path.join(root, '.state', 'exams', started.id)), false); assert.equal((await exams.list('bank', source.id, owner)).records.length, 0);
});
