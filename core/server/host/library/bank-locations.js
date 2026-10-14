import path from 'node:path';
import fs from 'node:fs';
import { exists, readJson, replaceFile } from '../platform/files.js';
import { jsonBytes, hash } from '../platform/json.js';
import { bad, requireObject } from '../platform/errors.js';

// Host-local routing continuity for banks moved between groups. Exported bank
// identities never depend on this file; independent copies have independent keys.
export class BankLocations {
  constructor(root) { this.file = path.join(root, '.state', 'bank-locations.json'); }
  read() {
    const value = exists(this.file) ? requireObject(readJson(this.file, 4 * 1024 * 1024)) : { schemaVersion: 1, routes: {}, moves: [] };
    requireObject(value.routes);
    if (value.schemaVersion !== 1 || Object.values(value.routes).some(value => typeof value !== 'string') || !Array.isArray(value.moves) || value.moves.length > 20000 || value.moves.some(move => !move || typeof move.from !== 'string' || typeof move.to !== 'string' || !Number.isFinite(Date.parse(move.at)))) throw bad('Invalid bank location registry');
    return value;
  }
  historical(id, createdAt) {
    for (const move of this.read().moves ?? []) if (move.from === id && Date.parse(move.at) >= Date.parse(createdAt)) id = move.to;
    return id;
  }
  move(from, to, stateKey) {
    if (from === to) return;
    const value = this.read();
    for (const key of Object.keys(value.routes)) if (value.routes[key] === from) value.routes[key] = to;
    delete value.routes[to]; value.routes[from] = to;
    (value.moves ??= []).push({ from, to, at: new Date().toISOString() });
    const nextKey = 'bank:' + to + ':mixed', directory = path.dirname(this.file);
    const oldFile = path.join(directory, hash(Buffer.from(stateKey)) + '.json'), nextFile = path.join(directory, hash(Buffer.from(nextKey)) + '.json');
    if (exists(nextFile)) throw bad('目标题库已有练习记录，请先处理目标记录再移动');
    const old = exists(oldFile) ? readJson(oldFile, 32 * 1024 * 1024) : null;
    if (old && old.collection !== stateKey) throw bad('Invalid bank state identity');
    try {
      if (old) {
        replaceFile(oldFile + '.before-group-move.bak', jsonBytes(old));
        replaceFile(nextFile, jsonBytes({ ...old, collection: nextKey }));
        fs.unlinkSync(oldFile);
      }
      replaceFile(this.file, jsonBytes(value));
    } catch (error) { if (old) { replaceFile(oldFile, jsonBytes(old)); if (exists(nextFile)) fs.unlinkSync(nextFile); } throw error; }
  }
}
