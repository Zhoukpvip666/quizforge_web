import fs from 'node:fs';
import path from 'node:path';
import { ApiError, bad, routeId } from './errors.js';
import { cloneJson, hash, jsonBytes } from './json.js';
import { checkPath, exists, readJson, replaceFile, safeDirectory } from './files.js';

const limit = 1024 * 1024;
function validate(request) { if (!request || typeof request !== 'object' || Array.isArray(request) || !/^[a-f0-9]{64}$/.test(request.contentVersion) || !request.draft || typeof request.draft !== 'object' || Array.isArray(request.draft) || typeof request.changed !== 'boolean') throw bad('Invalid editor draft envelope'); }
export class EditorDraftStore {
  constructor(root) { this.directory = path.join(root, '.state', 'editor-drafts'); }
  file(bank, question, create = false) { routeId(bank); routeId(question); safeDirectory(this.directory, create); const file = path.join(this.directory, hash(Buffer.from(bank + ':' + question)) + '.json'); if (exists(file)) checkPath(file); return file; }
  get(bank, question) {
    const file = this.file(bank, question); if (!exists(file)) return { draft: null };
    const stored = readJson(file, limit); if (stored?.schemaVersion !== 1 || stored.bank !== bank || stored.question !== question) throw new ApiError(503, 'EDITOR_DRAFT_UNAVAILABLE', 'Stored editor draft is invalid'); validate(stored);
    return { contentVersion: stored.contentVersion, changed: stored.changed, draft: cloneJson(stored.draft) };
  }
  put(bank, question, request) {
    validate(request); if (Object.keys(request).length !== 3) throw bad('Editor draft requires contentVersion, draft and changed');
    const stored = { schemaVersion: 1, bank, question, contentVersion: request.contentVersion, changed: request.changed, draft: request.draft }, bytes = jsonBytes(stored);
    if (bytes.length > limit) throw new ApiError(413, 'EDITOR_DRAFT_SIZE_LIMIT', 'Editor draft exceeds 1 MiB'); replaceFile(this.file(bank, question, true), bytes); return { saved: true };
  }
  delete(bank, question) { const file = this.file(bank, question), present = exists(file); if (present) fs.unlinkSync(file); return { deleted: present }; }
}
