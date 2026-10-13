import test from 'node:test';
import assert from 'node:assert/strict';
import {runRuleBatches} from './outline.js';

test('mixed projection groups overlap within two workers and retain question order', async () => {
  const extensions = ['c','a','b'].map(id => ({id,version:'1',fingerprint:id}));
  const questions = extensions.map(extension => ({extension}));
  let active = 0, peak = 0, release;
  const gate = new Promise(resolve => {release = resolve;});
  const engine = {async run(extension, input) {
    active++; peak = Math.max(peak, active);
    if (active === 2) release();
    await gate;
    active--;
    return {projected:input.questions.map(value => extension.id + value)};
  }};
  assert.deepEqual(await runRuleBatches(engine, questions, 'projectBatch', 'projected', [0,1,2]), ['c0','a1','b2']);
  assert.equal(peak, 2); assert.equal(active, 0);
});

test('batch failure drains the other active group and does not start queued groups', async () => {
  const questions = ['a','b','c'].map(id => ({extension:{id,version:'1',fingerprint:id}}));
  let release, bStarted, done = false;
  const gate = new Promise(resolve => {release = resolve;}), started = new Promise(resolve => {bStarted = resolve;});
  const seen = [], failure = new Error('validator failed');
  const pending = runRuleBatches({async run(extension) {
    seen.push(extension.id);
    if (extension.id === 'a') {await started; throw failure;}
    bStarted(); await gate;
    return {valid:true};
  }}, questions, 'validateBank', null, [0,1,2]);
  pending.then(() => {done = true;}, () => {done = true;});
  await started; await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false); release();
  await assert.rejects(pending, error => error === failure);
  assert.deepEqual(seen, ['a','b']);
});
