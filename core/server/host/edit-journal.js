import fs from 'node:fs';
import path from 'node:path';
import { ApiError, text } from './errors.js';
import { exists, readBytes, readJson, replaceFile, safeDirectory, safeFile, within } from './files.js';
import { hash, jsonBytes, parseJson } from './json.js';
import { decodeBase64 } from './resources.js';
import { scanExtensions } from './directories.js';

const digest = bytes => bytes === null ? 'absent' : hash(bytes);
const equal = (left, right) => left === null || right === null ? left === right : left.equals(right);
function pack(bytes) {
  if (bytes === null) return null;
  const result = [];
  for (let offset = 0; offset < bytes.length; offset += 512 * 1024) result.push(bytes.subarray(offset, offset + 512 * 1024).toString('base64'));
  return result;
}
function unpack(chunks, max) {
  if (chunks === null) return null;
  if (!Array.isArray(chunks) || chunks.length > 64) throw new Error('Invalid journal bytes');
  const result = []; let size = 0;
  for (const chunk of chunks) {
    const bytes = decodeBase64(chunk);
    if (bytes.length > 512 * 1024 || (size += bytes.length) > max) throw new Error('Journal target exceeds limit');
    result.push(bytes);
  }
  return Buffer.concat(result, size);
}
export class EditJournal {
  constructor(root, stateRoot = root) {
    this.root = path.resolve(root); this.stateRoot = path.resolve(stateRoot);
    this.journal = path.join(this.stateRoot, '.state', '.edit-journal.json');
  }
  bankPath(relative) {
    const components = relative.split('/');
    const legacy = [2, 3].includes(components.length) && relative.endsWith('.json');
    const folder = [3, 4].includes(components.length) && components.at(-1) === 'bank.json';
    let example = false;
    if (components.length >= 3 && components.length <= 9 && components[0] === 'extensions') {
      for (const extension of scanExtensions(path.join(this.root, 'extensions'))) {
        try {
          const manifest = readJson(path.join(extension, 'manifest.json'), 256 * 1024);
          if (typeof manifest.examples === 'string' && safeFile(extension, manifest.examples) === path.resolve(this.root, relative)) { example = true; break; }
        } catch { /* An invalid unrelated leaf does not prevent a valid edit. */ }
      }
    }
    if (relative.includes('\\') || relative.includes(':') || relative.includes('\0') || path.isAbsolute(relative) || components.some(part => !part || part === '.' || part === '..') || (!example && ((!legacy && !folder) || components[0] !== 'question-banks'))) throw new Error('Invalid journal bank path');
    const result = path.resolve(this.root, relative);
    if (!within(this.root, result)) throw new Error('Unsafe journal bank path');
    safeDirectory(path.dirname(result));
    if (exists(result) && fs.lstatSync(result).isSymbolicLink()) throw new Error('Unsafe journal bank path');
    return result;
  }
  statePath(name) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('Invalid journal state path');
    const result = path.join(this.stateRoot, '.state', name);
    if (exists(result) && fs.lstatSync(result).isSymbolicLink()) throw new Error('Unsafe journal state path');
    safeDirectory(path.dirname(result)); return result;
  }
  recover() {
    if (!exists(this.journal)) return false;
    const document = readJson(this.journal, 128 * 1024 * 1024);
    if (![1, 2].includes(document?.schemaVersion)) throw new Error('Invalid edit journal');
    const bank = this.bankPath(text(document, 'bank', 240));
    const values = {};
    for (const field of document.schemaVersion === 1 ? ['bankBefore', 'bankAfter', 'stateBefore', 'stateAfter'] : ['bankBefore', 'bankAfter']) {
      const bytes = unpack(document[field], field.startsWith('bank') ? 8 * 1024 * 1024 : 32 * 1024 * 1024);
      if (document[field + 'Digest'] !== digest(bytes)) throw new Error('Edit journal checksum mismatch');
      values[field] = bytes;
    }
    if (values.bankBefore === null || values.bankAfter === null) throw new Error('Incomplete edit journal');
    const planned = parseJson(values.bankAfter);
    if (!planned || typeof planned !== 'object' || !Array.isArray(planned.questions)) throw new Error('Invalid planned source edit');
    const verify = (file, before, after) => {
      const current = readBytes(file, 32 * 1024 * 1024, true);
      if (!equal(current, before) && !equal(current, after)) throw new Error('Transaction target has unrelated changes');
    };
    let state;
    if (document.schemaVersion === 1) {
      if (values.stateAfter === null) throw new Error('Incomplete edit journal');
      state = this.statePath(text(document, 'state', 80));
      const plannedState = parseJson(values.stateAfter), kind = document.kind ?? (this.root === this.stateRoot ? 'bank' : 'development-bank'), id = document.collectionId ?? planned.id;
      if (!['bank', 'extension', 'development', 'development-bank'].includes(kind) || typeof planned.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(planned.id) || plannedState?.schemaVersion !== 1 || !plannedState.questions || Array.isArray(plannedState.questions) || typeof plannedState.collection !== 'string' || !plannedState.collection.startsWith(`${kind}:${id}:`)) throw new Error('Invalid planned edit data');
      verify(state, values.stateBefore, values.stateAfter);
    } else if (Object.hasOwn(document, 'state') || Object.hasOwn(document, 'stateAfter')) throw new Error('Invalid source-only edit journal');
    verify(bank, values.bankBefore, values.bankAfter);
    replaceFile(bank, values.bankAfter);
    if (state) replaceFile(state, values.stateAfter);
    fs.unlinkSync(this.journal); return true;
  }
  commit(edit, state, stateAfter) { this.save(edit, state, stateAfter); }
  commitSource(edit) { this.save(edit, null, null); }
  save(edit, state, stateAfter) {
    safeDirectory(path.dirname(this.journal), true);
    if (exists(this.journal)) throw new Error('Pending edit journal');
    const relative = path.relative(this.root, edit.path).replaceAll('\\', '/'), bank = this.bankPath(relative);
    if (!equal(readBytes(bank, 32 * 1024 * 1024, true), edit.before)) throw new ApiError(409, 'CONTENT_CONFLICT', 'Source changed before the edit could be saved');
    const value = { schemaVersion: state === null ? 2 : 1, bank: relative, bankBefore: pack(edit.before), bankAfter: pack(edit.after), bankBeforeDigest: digest(edit.before), bankAfterDigest: digest(edit.after) };
    if (state !== null) {
      const target = this.statePath(path.basename(state)), before = readBytes(target, 32 * 1024 * 1024, true);
      Object.assign(value, { state: path.basename(target), kind: edit.collection.kind, collectionId: edit.collection.id, stateBefore: pack(before), stateAfter: pack(stateAfter), stateBeforeDigest: digest(before), stateAfterDigest: digest(stateAfter) });
    }
    replaceFile(this.journal, jsonBytes(value));
    this.recover();
  }
}
