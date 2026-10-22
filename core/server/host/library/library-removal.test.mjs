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

test('deleting a renamed group archives only banks and keeps all extensions and state/history bytes', t => {
  const f = fixture(t); f.bank('Renamed/leaf', 'Owned/choice', { questions: [{ extension: { path: 'extensions/Other/text' } }] });
  f.extension('Owned/choice'); f.extension('Other/text'); f.extension('Unrelated/choice');
  const state = f.put('.state/practice.json', 'answers and drafts'), history = f.put('.state/history.json', 'frozen history');
  const result = f.remove(); assert.deepEqual(result.removedExtensionGroups, []); assert.deepEqual(result.retainedExtensionGroups, []);
  assert.equal(fs.existsSync(path.join(f.root, 'question-banks/Renamed')), false);
  for (const leaf of ['Owned/choice', 'Other/text', 'Unrelated/choice']) assert.ok(fs.existsSync(path.join(f.root, 'extensions', leaf, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(f.root, result.archivedTo, 'content/Renamed/leaf/bank.json')));
  assert.equal(fs.existsSync(path.join(f.root, result.archivedTo, 'extensions')), false);
  assert.equal(fs.readFileSync(state, 'utf8'), 'answers and drafts'); assert.equal(fs.readFileSync(history, 'utf8'), 'frozen history');
  const receipt = JSON.parse(fs.readFileSync(path.join(f.root, result.archivedTo, 'receipt.json'))); assert.equal(receipt.status, 'complete'); assert.equal(receipt.moves.length, 1);
  assert.equal(receipt.moves[0].from, 'question-banks/Renamed');
});

test('deleting the last bank using an extension still preserves the extension group', t => {
  const f = fixture(t); f.bank('Renamed/leaf'); f.bank('Elsewhere/leaf', 'Owned/text'); f.extension('Owned/choice'); f.extension('Owned/text');
  const result = f.remove(); assert.deepEqual(result.removedExtensionGroups, []);
  assert.ok(fs.existsSync(path.join(f.root, 'extensions/Owned/choice/manifest.json')));
  const last = f.remove('Elsewhere'); assert.deepEqual(last.removedExtensionGroups, []);
  for (const leaf of ['choice', 'text']) assert.ok(fs.existsSync(path.join(f.root, 'extensions/Owned', leaf, 'manifest.json')));
});

for (const malformed of [true, false]) test('unreadable or legacy-bound unrelated banks do not affect deletion: unreadable=' + malformed, t => {
  const f = fixture(t); f.bank('Renamed/leaf'); f.extension('Owned/choice');
  if (malformed) f.put('question-banks/Other/leaf/bank.json', '{broken');
  else f.bank('Other/leaf', '', { extension: { id: 'old-binding' } });
  const result = f.remove(); assert.deepEqual(result.removedExtensionGroups, []); assert.equal(result.cleanupWarning, undefined);
  assert.ok(fs.existsSync(path.join(f.root, 'extensions/Owned/choice/manifest.json')));
});

test('root single-bank and group member deletion always preserve extensions', t => {
  const f = fixture(t); f.bank('Root'); f.extension('Owned/choice');
  assert.deepEqual(f.remove('Root', 'item').removedExtensionGroups, []);
  f.bank('Renamed/one'); f.bank('Renamed/two'); f.extension('Owned/choice');
  assert.deepEqual(f.remove('Renamed/one', 'item').removedExtensionGroups, []);
  assert.ok(fs.existsSync(path.join(f.root, 'question-banks/Renamed/two/bank.json')));
  assert.deepEqual(f.remove('Renamed/two', 'item').removedExtensionGroups, []);
  assert.ok(fs.existsSync(path.join(f.root, 'extensions/Owned/choice/manifest.json')));
});

test('bank deletion does not read bank content or enumerate library or extension directories', t => {
  const f = fixture(t); f.bank('Renamed/leaf'); f.bank('Other/leaf'); f.extension('Owned/choice');
  const read = fs.readFileSync, list = fs.readdirSync;
  let reads = 0, enumerations = 0, result;
  fs.readFileSync = () => { reads++; throw new Error('Bank deletion must not read content'); };
  fs.readdirSync = (directory, ...args) => {
    if (['question-banks', 'extensions'].some(name => within(path.join(f.root, name), directory))) {
      enumerations++; throw new Error('Bank deletion must not enumerate library dependencies');
    }
    return list(directory, ...args);
  };
  try { result = f.remove(); } finally { fs.readFileSync = read; fs.readdirSync = list; }
  assert.equal(reads, 0); assert.equal(enumerations, 0);
  assert.ok(fs.existsSync(path.join(f.root, result.archivedTo, 'content/Renamed/leaf/bank.json')));
  assert.ok(fs.existsSync(path.join(f.root, 'question-banks/Other/leaf/bank.json')));
  assert.ok(fs.existsSync(path.join(f.root, 'extensions/Owned/choice/manifest.json')));
});

test('bank move failure preserves the bank and extensions and records rollback', t => {
  const f = fixture(t); f.bank('Renamed/leaf', 'Owned/choice', { questions: [{ extension: { path: 'extensions/Other/text' } }] }); f.extension('Owned/choice'); f.extension('Other/text');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (from === path.join(f.root, 'question-banks/Renamed')) throw Object.assign(new Error('injected failure'), { code: 'EIO' }); return rename(from, to); };
  try { assert.throws(() => f.remove(), { code: 'LIBRARY_MOVE_FAILED' }); } finally { fs.renameSync = rename; }
  assert.ok(fs.existsSync(path.join(f.root, 'question-banks/Renamed/leaf/bank.json')));
  for (const item of ['Owned/choice', 'Other/text']) assert.ok(fs.existsSync(path.join(f.root, 'extensions', item, 'manifest.json')));
  const trash = path.join(f.root, '.trash/library'), receipt = JSON.parse(fs.readFileSync(path.join(trash, fs.readdirSync(trash)[0], 'receipt.json')));
  assert.equal(receipt.status, 'rolled-back');
});

test('receipt completion failure restores the selected bank and leaves extensions untouched', t => {
  const f = fixture(t); f.bank('Renamed/leaf'); f.extension('Owned/choice');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (path.basename(to) === 'receipt.json' && JSON.parse(fs.readFileSync(from, 'utf8')).status === 'complete') throw new Error('injected receipt failure');
    return rename(from, to);
  };
  try { assert.throws(() => f.remove(), /injected receipt failure/); } finally { fs.renameSync = rename; }
  assert.ok(fs.existsSync(path.join(f.root, 'question-banks/Renamed/leaf/bank.json')));
  assert.ok(fs.existsSync(path.join(f.root, 'extensions/Owned/choice/manifest.json')));
  const trash = path.join(f.root, '.trash/library'), receipt = JSON.parse(fs.readFileSync(path.join(trash, fs.readdirSync(trash)[0], 'receipt.json')));
  assert.equal(receipt.status, 'rolled-back');
});
