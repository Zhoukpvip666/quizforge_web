import { ApiError } from '../platform/errors.js';
import { jsonBytes } from '../platform/json.js';
import { catalogError } from './library-index.js';

const invalid = message => new ApiError(422, 'INVALID_LIBRARY_ARCHIVE', '题库包包含无效题库或拓展：' + message);

// Only isolated import roots use this adapter. Each original request retains
// its fresh VM boundary, size limits and timeout. Failed merged requests are
// retried separately so one bad bank or the combined timeout cannot reject
// other independently valid requests.
export class ImportValidationEngine {
  constructor(engine) {
    this.engine = engine; this.pending = []; this.queue = []; this.active = 0; this.scheduled = false; this.waiters = [];
  }
  run(extension, input) {
    if (!['validateBank', 'outlineBatch'].includes(input.op) || Object.keys(input).some(key => !['op', 'questions'].includes(key))) return this.engine.run(extension, input);
    return new Promise((resolve, reject) => {
      this.pending.push({ extension, input, resolve, reject, bytes: jsonBytes(input.questions).length });
      if (!this.scheduled) { this.scheduled = true; queueMicrotask(() => this.flush()); }
    });
  }
  flush() {
    this.scheduled = false;
    const groups = new Map();
    for (const job of this.pending.splice(0)) {
      const key = JSON.stringify([job.input.op, job.extension.id, job.extension.version, job.extension.fingerprint, job.extension.directory]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(job);
    }
    for (const jobs of groups.values()) {
      let batch = [], bytes = 0, count = 0;
      const maximum = jobs[0].input.op === 'outlineBatch' ? 24 : 512;
      for (const job of jobs) {
        if (batch.length && (count + job.input.questions.length > maximum || bytes + job.bytes > 512 * 1024)) {
          this.queue.push(batch); batch = []; bytes = 0; count = 0;
        }
        batch.push(job); bytes += job.bytes; count += job.input.questions.length;
      }
      if (batch.length) this.queue.push(batch);
    }
    this.pump();
  }
  pump() {
    while (this.active < 2 && this.queue.length) {
      const batch = this.queue.shift(); this.active++;
      this.execute(batch).catch(error => { for (const job of batch) job.reject(error); }).finally(() => { this.active--; this.pump(); });
    }
    if (!this.active && !this.queue.length && !this.pending.length && !this.scheduled) for (const resolve of this.waiters.splice(0)) resolve();
  }
  async execute(jobs) {
    if (jobs.length > 1) {
      try {
        const questions = [], contextResetOffsets = [];
        for (const job of jobs) {
          if (questions.length) contextResetOffsets.push(questions.length);
          questions.push(...job.input.questions);
        }
        const op = jobs[0].input.op;
        const response = await this.engine.run(jobs[0].extension, { op, questions, contextResetOffsets });
        if (op === 'outlineBatch' && (!Array.isArray(response?.outlineItems) || response.outlineItems.length !== questions.length)) throw new Error('Invalid combined outline response');
        let offset = 0;
        for (const job of jobs) {
          job.resolve(op === 'outlineBatch' ? { outlineItems: response.outlineItems.slice(offset, offset + job.input.questions.length) } : response);
          offset += job.input.questions.length;
        }
        return;
      } catch { /* Retain original per-request behavior on any merged failure. */ }
    }
    for (const job of jobs) {
      try { job.resolve(await this.engine.run(job.extension, job.input)); }
      catch (error) { job.reject(error); }
    }
  }
  drain() {
    if (!this.active && !this.queue.length && !this.pending.length && !this.scheduled) return Promise.resolve();
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

export async function validateImportLibrary(library) {
  const snapshot = library.indexSnapshot(), environment = await library.environment();
  const adapter = new ImportValidationEngine(library.engine), extensions = new Map(), folders = new Map(), scopes = [];
  for (const candidate of snapshot.candidates) if (candidate.metadata.error) throw invalid(candidate.metadata.error);
  // Match the normal loader's 64-collection bound rather than preparing every
  // bank in a large archive at once.
  for (let offset = 0; offset < snapshot.candidates.length; offset += 64) {
    const work = snapshot.candidates.slice(offset, offset + 64).map(candidate => {
      try {
        const scope = library.scope(snapshot, candidate.kind, candidate.id), identity = library.contentIdentity(scope, folders);
        scopes.push({ scope, identity });
        return library.loadScope(snapshot, scope, identity, environment, candidate.kind, candidate.id, { extensions, engine: adapter });
      } catch (error) { return Promise.reject(error); }
    });
    const results = await Promise.allSettled(work);
    await adapter.drain();
    const failure = results.find(result => result.status === 'rejected');
    if (failure) {
      const row = {}; catalogError(row, failure.reason, 'INVALID_BANK'); throw invalid(row.error);
    }
  }
  // Sharing filesystem and runtime work is limited to this one isolated import
  // validation. Recheck everything before allowing the package to be installed.
  const checkedFolders = new Map();
  if (library.indexSnapshot().revision !== snapshot.revision || scopes.some(({ scope, identity }) => library.contentIdentity(scope, checkedFolders) !== identity)
      || environment !== 'unavailable' && await library.environment() !== environment) throw invalid('校验期间文件或规则运行环境发生变化，请重新导入。');
}
