import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeBank } from './library-removal.js';
import { within } from '../platform/files.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quizforge-removal-'));
  const put = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const bank = (name, extension = 'Owned/choice', extra = {}) => put('question-banks/' + name + '/bank.json', { extension: { path: 'extensions/' + extension }, questions: [], ...extra });
  const extension = name => put('extensions/' + name + '/manifest.json', {});
  const remove = (name = 'Renamed', target = 'group') => removeBank(root, path.join(root, 'question-banks', name), target, name);
  t.after(() => { assert.ok(within(os.tmpdir(), root) && root !== os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, put, bank, extension, remove };
}

test('deleting a renamed group archives bound extension groups and keeps state/history bytes', t => {
  const f = fixture(t); f.bank('Renamed/leaf', 'Owned/choice', { questions: [{ extension: { path: 'extensions/Other/text' } }] });
  f.extension('Owned/choice'); f.extension('Other/text'); f.extension('Unrelated/choice');
  const state = f.put('.state/practice.json', 'answers and drafts'), history = f.put('.state/history.json', 'frozen history');
  const result = f.remove(); assert.deepEqual(result.removedExtensionGroups.sort(), ['Other', 'Owned']);
  assert.equal(fs.existsSync(path.join(f.root, 'question-banks/Renamed')), false);
  for (const group of result.removedExtensionGroups) { assert.equal(fs.existsSync(path.join(f.root, 'extensions', group)), false); assert.ok(fs.existsSync(path.join(f.root, result.archivedTo, 'extensions', group))); }
  assert.ok(fs.existsSync(path.join(f.root, 'extensions/Unrelated/choice/manifest.json')));
  assert.equal(fs.readFileSync(state, 'utf8'), 'answers and drafts'); assert.equal(fs.readFileSync(history, 'utf8'), 'frozen history');
  const receipt = JSON.parse(fs.readFileSync(path.join(f.root, result.archivedTo, 'receipt.json'))); assert.equal(receipt.status, 'complete'); assert.equal(receipt.moves.length, 3);
});

test('another bank referencing any extension in the paired group preserves that entire group', t => {
  const f = fixture(t); f.bank('Renamed/leaf'); f.bank('Elsewhere/leaf', 'Owned/text'); f.extension('Owned/choice'); f.extension('Owned/text');
  const result = f.remove(); assert.deepEqual(result.removedExtensionGroups, []); assert.deepEqual(result.retainedExtensionGroups, ['Owned']);
  assert.ok(fs.existsSync(path.join(f.root, 'extensions/Owned/choice/manifest.json')));
  const last = f.remove('Elsewhere'); assert.deepEqual(last.removedExtensionGroups, ['Owned']);
});

for (const malformed of [true, false]) test('unknown remaining references retain extensions: unreadable=' + malformed, t => {
  const f = fixture(t); f.bank('Renamed/leaf'); f.extension('Owned/choice');
  if (malformed) f.put('question-banks/Other/leaf/bank.json', '{broken');
  else f.bank('Other/leaf', '', { extension: { id: 'old-binding' } });
  const result = f.remove(); assert.deepEqual(result.removedExtensionGroups, []); assert.deepEqual(result.retainedExtensionGroups, ['Owned']); assert.match(result.cleanupWarning, /无法确认/);
});

test('root single-bank deletion cleans its package, but deleting one group member keeps shared extensions', t => {
  const f = fixture(t); f.bank('Root'); f.extension('Owned/choice');
  assert.deepEqual(f.remove('Root', 'item').removedExtensionGroups, ['Owned']);
  f.bank('Renamed/one'); f.bank('Renamed/two'); f.extension('Owned/choice');
  assert.deepEqual(f.remove('Renamed/one', 'item').retainedExtensionGroups, ['Owned']);
  assert.deepEqual(f.remove('Renamed/two', 'item').removedExtensionGroups, ['Owned']);
});

test('extension move failure rolls back the bank and all earlier extension moves', t => {
  const f = fixture(t); f.bank('Renamed/leaf', 'Owned/choice', { questions: [{ extension: { path: 'extensions/Other/text' } }] }); f.extension('Owned/choice'); f.extension('Other/text');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (from === path.join(f.root, 'extensions/Other')) throw Object.assign(new Error('injected failure'), { code: 'EIO' }); return rename(from, to); };
  try { assert.throws(() => f.remove(), { code: 'LIBRARY_MOVE_FAILED' }); } finally { fs.renameSync = rename; }
  assert.ok(fs.existsSync(path.join(f.root, 'question-banks/Renamed/leaf/bank.json')));
  for (const item of ['Owned/choice', 'Other/text']) assert.ok(fs.existsSync(path.join(f.root, 'extensions', item, 'manifest.json')));
  const trash = path.join(f.root, '.trash/library'), receipt = JSON.parse(fs.readFileSync(path.join(trash, fs.readdirSync(trash)[0], 'receipt.json')));
  assert.equal(receipt.status, 'rolled-back');
});
