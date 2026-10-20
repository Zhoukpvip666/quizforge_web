import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeContent } from './initial-content.js';
const base = path.resolve(fileURLToPath(new URL('../../../../.temp/', import.meta.url)));
function fixture(t) {
  fs.mkdirSync(base, { recursive: true }); const work = fs.mkdtempSync(path.join(base, 'initial-content-'));
  const root = path.join(work, 'data'), defaults = path.join(work, 'defaults'); fs.mkdirSync(root);
  for (const name of ['question-banks', 'extensions']) { fs.mkdirSync(path.join(defaults, name, '基础题型'), { recursive: true }); fs.writeFileSync(path.join(defaults, name, '基础题型/template.txt'), name); }
  t.after(() => { assert.equal(path.dirname(work), base); fs.rmSync(work, { recursive: true, force: true }); });
  return { root, defaults, work };
}
test('first start seeds independent data and upgrades never overwrite edited or deleted user files', t => {
  const { root, defaults } = fixture(t); initializeContent(root, defaults);
  const bank = path.join(root, 'question-banks/基础题型/template.txt'); fs.writeFileSync(bank, 'my edits');
  fs.rmSync(path.join(root, 'extensions/基础题型'), { recursive: true });
  fs.writeFileSync(path.join(defaults, 'question-banks/基础题型/template.txt'), 'new program version');
  initializeContent(root, defaults);
  assert.equal(fs.readFileSync(bank, 'utf8'), 'my edits'); assert.equal(fs.existsSync(path.join(root, 'extensions/基础题型')), false);
  assert.equal(fs.readFileSync(path.join(defaults, 'question-banks/基础题型/template.txt'), 'utf8'), 'new program version');
});
test('pre-existing content suppresses all seeding instead of merging templates into it', t => {
  const { root, defaults } = fixture(t); fs.mkdirSync(path.join(root, 'extensions')); fs.writeFileSync(path.join(root, 'extensions/user.txt'), 'mine');
  initializeContent(root, defaults); assert.equal(fs.existsSync(path.join(root, 'question-banks')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.state/initial-content.json'))), { schemaVersion: 1, result: 'existing' });
});
test('an interrupted first start resumes both directories from its journal without replacing the first half', t => {
  const { root, defaults } = fixture(t), rename = fs.renameSync;
  fs.renameSync = (source, target) => { if (target === path.join(root, 'extensions')) throw new Error('interrupted'); return rename(source, target); };
  try { assert.throws(() => initializeContent(root, defaults), /interrupted/); } finally { fs.renameSync = rename; }
  assert.equal(fs.existsSync(path.join(root, 'question-banks/基础题型/template.txt')), true);
  initializeContent(root, path.join(root, 'no-longer-needed-template'));
  assert.equal(fs.existsSync(path.join(root, 'extensions/基础题型/template.txt')), true);
  assert.equal(fs.existsSync(path.join(root, '.state/initial-content.pending.json')), false);
  assert.deepEqual(fs.readdirSync(path.join(root, '.state')), ['initial-content.json']);
});
test('recovery refuses files inserted into an unfinished destination instead of overwriting them', t => {
  const { root, defaults } = fixture(t), rename = fs.renameSync;
  fs.renameSync = (source, target) => { if (target === path.join(root, 'extensions')) throw new Error('interrupted'); return rename(source, target); };
  try { assert.throws(() => initializeContent(root, defaults), /interrupted/); } finally { fs.renameSync = rename; }
  fs.mkdirSync(path.join(root, 'extensions')); fs.writeFileSync(path.join(root, 'extensions/outside.txt'), 'keep');
  assert.throws(() => initializeContent(root, defaults), /conflicts with existing/);
  assert.equal(fs.readFileSync(path.join(root, 'extensions/outside.txt'), 'utf8'), 'keep');
});
test('invalid first-run journals cannot escape the state directory', t => {
  const { root, defaults, work } = fixture(t); fs.mkdirSync(path.join(root, '.state'));
  fs.writeFileSync(path.join(work, 'keep.txt'), 'keep');
  fs.writeFileSync(path.join(root, '.state/initial-content.pending.json'), JSON.stringify({ schemaVersion: 1, stage: '../..' }));
  assert.throws(() => initializeContent(root, defaults), /Invalid initial-content/);
  assert.equal(fs.readFileSync(path.join(work, 'keep.txt'), 'utf8'), 'keep');
});
