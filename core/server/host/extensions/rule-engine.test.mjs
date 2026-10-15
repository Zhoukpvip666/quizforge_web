import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeDirectory, within } from '../platform/files.js';
import { RuleEngine } from './rule-engine.js';

const codeRoot = fileURLToPath(new URL('../../../', import.meta.url));
const temporaryRoot = path.join(path.dirname(codeRoot), '.temp', 'node-migration');
const rules = `QF.defineType({
  project(data, state) { if (data.slow) { const until = Date.now() + 400; while (Date.now() < until); } globalThis.calls = (globalThis.calls || 0) + 1; return { calls: globalThis.calls, maxScore: 1 }; },
  grade(data, answer) {
    return { score: answer.mode === 'right' ? 1 : 0, maxScore: 1, correct: answer.mode === 'right', feedback: '' };
  }
});`;

async function fixture(t, options) {
  safeDirectory(temporaryRoot, true);
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'rule-workers-'));
  fs.writeFileSync(path.join(root, 'rules.js'), rules);
  for (const name of ['question.schema.json', 'answer.schema.json']) fs.writeFileSync(path.join(root, name), '{"type":"object"}');
  const engine = await RuleEngine.create(codeRoot, options);
  t.after(() => { engine.close(); assert.ok(within(temporaryRoot, root) && root !== temporaryRoot); fs.rmSync(root, { recursive: true, force: true }); });
  const extension = { rules: path.join(root, 'rules.js'), questionSchema: path.join(root, 'question.schema.json'), answerSchema: path.join(root, 'answer.schema.json') };
  const project = () => engine.run(extension, { op: 'project', data: {}, state: { submitted: false, result: null } });
  const submit = mode => engine.run(extension, { op: 'submit', data: {}, answer: { mode } });
  return { engine, extension, root, project, submit };
}
const exited = child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('close', resolve));

test('one persistent worker serves repeated requests with a fresh VM each time', async t => {
  const { engine, project, submit } = await fixture(t);
  assert.deepEqual(await project(), { projected: { calls: 1, maxScore: 1 } });
  const [worker] = engine.workers();
  assert.deepEqual(await project(), { projected: { calls: 1, maxScore: 1 } }, 'VM globals never leak between requests');
  assert.equal((await submit('right')).result.score, 1);
  assert.deepEqual(engine.workers(), [worker]); assert.equal(worker.served, 3);
});

test('busy workers are capped per extension and queued requests keep their order', async t => {
  const { engine, submit } = await fixture(t);
  const results = await Promise.all(['right', 'wrong', 'right', 'wrong', 'right'].map(submit));
  assert.deepEqual(results.map(value => value.result.score), [1, 0, 1, 0, 1]);
  assert.ok(engine.workers().length <= 2);
});

test('a deadline kills the busy worker and the next request starts a fresh one', async t => {
  const { engine, extension, submit } = await fixture(t);
  await submit('right');
  const [first] = engine.workers();
  // Each VM call stays under the runner's own limit; the batch exceeds the host deadline.
  engine.deadline = 600;
  await assert.rejects(engine.run(extension, { op: 'projectBatch', questions: Array.from({ length: 4 }, () => ({ data: { slow: true }, state: { submitted: false, result: null } })) }), { code: 'RULE_TIMEOUT' });
  await exited(first.child);
  engine.deadline = 8000;
  assert.equal((await submit('right')).result.score, 1);
  assert.notEqual(engine.workers()[0], first);
});

test('a worker that died while idle is replaced without failing the request', async t => {
  const { engine, project } = await fixture(t);
  await project();
  const [first] = engine.workers();
  first.child.kill('SIGKILL'); await exited(first.child);
  assert.equal(engine.workers().length, 0);
  assert.deepEqual(await project(), { projected: { calls: 1, maxScore: 1 } });
});

test('a reused worker that crashes mid-request gets one retry on a fresh worker', async t => {
  const { engine, project } = await fixture(t);
  await project();
  const [first] = engine.workers();
  const pending = project();
  first.child.kill('SIGKILL');
  assert.deepEqual(await pending, { projected: { calls: 1, maxScore: 1 } });
  assert.notEqual(engine.workers()[0], first);
});

test('changed extension rules are read again by the running worker', async t => {
  const { engine, root, project } = await fixture(t);
  await project();
  fs.writeFileSync(path.join(root, 'rules.js'), rules.replace('maxScore: 1 }; }', 'maxScore: 7 }; }'));
  assert.equal((await project()).projected.maxScore, 7);
  assert.equal(engine.workers()[0].served, 2);
});

test('rejected rules keep the worker usable and closing rejects queued work', async t => {
  const { engine, extension, project } = await fixture(t);
  await assert.rejects(engine.run(extension, { op: 'submit', data: {}, answer: 'not an object' }), { code: 'RULE_REJECTED' });
  assert.equal(engine.workers().length, 1);
  assert.equal((await project()).projected.maxScore, 1);
  const pending = project(); engine.close();
  await assert.rejects(pending, { code: 'RULE_UNAVAILABLE' });
  assert.equal(engine.workers().length, 0);
  await assert.rejects(project(), { code: 'RULE_UNAVAILABLE' });
});

test('foreground requests skip queued background batches and get a reserved worker', async t => {
  const { engine, extension, project } = await fixture(t);
  await project();
  const finished = [], slow = () => engine.background(() => engine.run(extension, { op: 'projectBatch', questions: Array.from({ length: 3 }, () => ({ data: { slow: true }, state: { submitted: false, result: null } })) }));
  const background = [1, 2, 3].map(index => slow().then(() => finished.push('background-' + index)));
  await new Promise(resolve => setTimeout(resolve, 50));
  const foreground = project().then(value => { finished.push('foreground'); return value; });
  assert.deepEqual(await foreground, { projected: { calls: 1, maxScore: 1 } });
  assert.deepEqual(finished, ['foreground'], 'The foreground request does not wait for background batches');
  assert.ok(engine.workers().length <= 3);
  await Promise.all(background);
  assert.deepEqual(finished.slice(1).sort(), ['background-1', 'background-2', 'background-3']);
  assert.ok(engine.workers().length <= 3);
});
