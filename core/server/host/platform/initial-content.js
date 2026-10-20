import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkPath, exists, readJson, replaceFile, safeDirectory, walkEntries } from './files.js';
import { jsonBytes } from './json.js';

// Called only while this host owns the data-directory lock. Templates are
// seeded once, never merged into user-authored content during an app upgrade.
export function initializeContent(root, defaults) {
  const state = safeDirectory(path.join(root, '.state'), true);
  const marker = path.join(state, 'initial-content.json'), pending = path.join(state, 'initial-content.pending.json');
  if (exists(marker)) {
    const value = readJson(marker, 4096);
    if (value.schemaVersion !== 1 || !['seeded', 'existing'].includes(value.result)) throw new Error('Invalid initial-content receipt');
    return;
  }
  const names = ['question-banks', 'extensions'];
  let journal;
  if (exists(pending)) {
    journal = readJson(pending, 4096);
    if (journal.schemaVersion !== 1 || !/^initial-content-[a-f0-9-]{36}$/.test(journal.stage)) throw new Error('Invalid initial-content recovery journal');
  } else {
    const occupied = names.some(name => {
      const directory = path.join(root, name);
      return exists(directory) && (checkPath(directory, { directory: true }), fs.readdirSync(directory).length > 0);
    });
    if (occupied) { replaceFile(marker, jsonBytes({ schemaVersion: 1, result: 'existing' })); return; }
    defaults = checkPath(defaults, { directory: true });
    for (const name of names) walkEntries(path.join(defaults, name), 20000);
    journal = { schemaVersion: 1, stage: 'initial-content-' + randomUUID() };
    const stage = safeDirectory(path.join(state, journal.stage), true);
    for (const name of names) fs.cpSync(path.join(defaults, name), path.join(stage, name), { recursive: true, errorOnExist: true, force: false });
    replaceFile(pending, jsonBytes(journal));
  }
  const stage = checkPath(path.join(state, journal.stage), { directory: true });
  for (const name of names) {
    const source = path.join(stage, name), target = path.join(root, name);
    if (!exists(source)) { checkPath(target, { directory: true }); continue; }
    checkPath(source, { directory: true });
    if (exists(target)) {
      checkPath(target, { directory: true });
      if (fs.readdirSync(target).length) throw new Error('Initial content conflicts with existing user files; preserve the recovery journal');
      fs.rmdirSync(target);
    }
    fs.renameSync(source, target);
  }
  replaceFile(marker, jsonBytes({ schemaVersion: 1, result: 'seeded' }));
  fs.unlinkSync(pending); fs.rmdirSync(stage);
}
