import fs from 'node:fs';
import path from 'node:path';
import { ApiError, bad } from '../platform/errors.js';
import { cloneJson, hash, jsonBytes, jsonEqual, parseJson } from '../platform/json.js';
import { checkPath, exists, readBytes, readJson, safeDirectory } from '../platform/files.js';
import { catalogRevision, prepareCollection, finishCollection } from '../library/collections.js';
import { EditorDraftStore } from '../editor/editor-drafts.js';
import { questionState, unsubmittedState, interruptRound } from './state-store.js';

export function eligible(extension, automatic = false) { return extension?.id === 'quizforge.short-answer' && (automatic ? extension.version === '1.2.2' : ['1.0.0', '1.1.0', '1.2.0', '1.2.1'].includes(extension.version)); }
const nodeText = node => node?.type === 'text' ? node.text ?? '' : (node?.content ?? []).map(nodeText).join('');
async function prepare(library, current, automatic) {
  const latest = await library.load('bank', current.id);
  if (catalogRevision(latest.collection) !== catalogRevision(current)) throw new ApiError(409, 'CONTENT_CONFLICT', 'Bank changed before upgrade');
  const version = automatic ? '1.3.0' : '1.2.2', targetLoaded = await library.load('page', 'quizforge.short-answer@' + version), target = [...targetLoaded.available.values()].find(extension => extension.id === 'quizforge.short-answer' && extension.version === version);
  if (!target) throw new ApiError(422, 'MISSING_EXTENSION', 'Advanced short-answer ' + version + ' is not installed');
  const before = readBytes(latest.source, 8 * 1024 * 1024), raw = readJson(latest.source);
  if (!jsonEqual(raw, latest.raw)) throw new ApiError(409, 'CONTENT_CONFLICT', 'Bank changed while reading upgrade source');
  if (raw.extension && eligible(current.extension, automatic)) raw.extension = { path: target.referencePath };
  for (const item of raw.questions) {
    const previous = current.extensionFor(current.question(item.id)); if (!eligible(previous, automatic)) continue;
    if (item.extension) item.extension = { path: target.referencePath };
    if (!automatic && ['1.0.0', '1.1.0'].includes(previous.version)) {
      const title = item.title.trim(), content = item.data.stem.content;
      if (title && (!content.length || nodeText(content[0]).trim() !== title)) content.unshift({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: title }] });
    }
  }
  const available = new Map(latest.available); available.set('path:' + target.referencePath, target);
  const { collection } = await finishCollection(library.engine, prepareCollection(raw, 'bank', current.extension ? target : null, current.id, available, current.bankId ?? current.id));
  const after = jsonBytes(raw); if (after.length > 8 * 1024 * 1024) throw new ApiError(413, 'BANK_SIZE_LIMIT', 'Bank exceeds the size limit');
  return { path: latest.source, before, after, collection, question: null };
}
function increment(value) { if (!Number.isSafeInteger(value) || value === Number.MAX_SAFE_INTEGER) throw new ApiError(409, 'REVISION_LIMIT', 'Saved revision cannot be upgraded'); return value + 1; }
function backup(store, plan, state) {
  const directory = safeDirectory(path.join(store.directory, 'upgrade-backups', hash(Buffer.concat([plan.before, state]))), true);
  for (const [name, bytes] of [['bank.json', plan.before], ['state.json', state]]) {
    const file = path.join(directory, name);
    if (exists(file)) { checkPath(file, { directory: false }); if (!fs.readFileSync(file).equals(bytes)) throw new ApiError(409, 'UPGRADE_BACKUP_EXISTS', 'An existing upgrade backup differs; preserve it instead of overwriting'); }
    else { const fd = fs.openSync(file, 'wx'); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  }
}
async function upgrade(library, store, previous, automatic) {
  return store.transactions.run(() => library.managementTransactions.run(async () => {
    const drafts = new EditorDraftStore(path.dirname(store.directory));
    for (const question of previous.questions) if (eligible(previous.extensionFor(question), automatic) && drafts.get(previous.id, question.id).changed) throw new ApiError(409, 'UPGRADE_EDITOR_DRAFT_PENDING', 'Save or cancel the pending short-answer edit before upgrading; the editor draft is preserved');
    const plan = await prepare(library, previous, automatic), replacement = plan.collection, old = store.load(previous), source = store.file(previous), target = store.file(replacement), same = source === target;
    if (!same && exists(target)) throw new ApiError(409, 'UPGRADE_STATE_EXISTS', 'Target version already has saved practice; preserve both versions instead of overwriting');
    const next = same ? cloneJson(old) : { schemaVersion: 1, collection: replacement.stateKey() }; next.extensionFingerprint = replacement.extensionFingerprint; next.upgradedFrom = previous.stateKey();
    for (const key of ['editReceipts', 'finishReceipts', 'restartReceipts', ...(automatic ? ['upgradedCompletion'] : [])]) delete next[key];
    next.questions = {}; const completed = store.summaryRound(old, previous), states = []; let submitted = false;
    for (const question of replacement.questions) {
      const before = previous.question(question.id); let state = cloneJson(questionState(old, previous, before));
      if (automatic && eligible(previous.extensionFor(before), true)) {
        if (!jsonEqual(question.data, before.data) || question.title !== before.title) throw bad('Scoring upgrade cannot change question content');
        if (state.answer !== null) { const op = state.result?.gradingStatus === 'pending' ? 'submit' : 'validateAnswer', evaluated = await store.rules.run(replacement.extensionFor(question), { op, data: question.data, answer: state.answer }); if (op === 'submit') state.result = cloneJson(evaluated.result); }
        state.revision = increment(state.revision); state.fingerprint = question.fingerprint; state.gradingGeneration = increment(state.gradingGeneration ?? 0); state.aiTaskId = null; state.receipts = []; delete state.aiTaskIds; delete state.aiTargetGenerations;
      } else if (!automatic) {
        const changed = question.fingerprint !== before.fingerprint; if (completed?.finishedAt) state = unsubmittedState(state);
        if (changed || completed?.finishedAt) { state.revision = increment(state.revision); state.fingerprint = question.fingerprint; state.receipts = []; for (const key of ['aiTaskId', 'aiTaskIds', 'aiTargetGenerations']) delete state[key]; }
        if (changed && state.answer !== null) await store.rules.run(replacement.extensionFor(question), { op: 'validateAnswer', data: question.data, answer: state.answer });
      }
      Object.defineProperty(next.questions, question.id, { value: state, enumerable: true, writable: true, configurable: true }); states.push(state); submitted ||= state.status === 'submitted';
    }
    if (automatic && completed?.finishedAt) {
      const snapshot = cloneJson(completed); snapshot.extensionFingerprint = replacement.extensionFingerprint; snapshot.fingerprints = {}; snapshot.completionVersions = {};
      for (let i = 0; i < replacement.questions.length; i++) { const q = replacement.questions[i]; Object.defineProperty(snapshot.fingerprints, q.id, { value: q.fingerprint, enumerable: true }); Object.defineProperty(snapshot.completionVersions, q.id, { value: states[i].revision, enumerable: true }); }
      next.upgradedCompletion = snapshot;
    } else {
      if (!automatic && same) interruptRound(next, 'extension-upgraded');
      if (submitted) { const round = await store.freezeRound(replacement, next, states); round.upgradedFrom = previous.stateKey(); (next.historyRounds ??= []).push(round); }
    }
    const expected = store.stateBytes(old), beforeState = exists(source) ? fs.readFileSync(source) : expected;
    if ((automatic || same) && !jsonEqual(parseJson(beforeState), parseJson(expected))) throw new ApiError(409, 'UPGRADE_STATE_CHANGED', 'Saved practice changed before upgrade; restart before trying again');
    const bytes = store.stateBytes(next); if (automatic || same) backup(store, plan, beforeState);
    store.edits.commit(plan, target, bytes); store.remember(replacement.stateKey(), next, bytes.length); library.invalidate();
  }));
}
export async function upgradeShortAnswerBanks(library, store, automatic = false) {
  let count = 0; const catalog = await library.catalog();
  for (const row of catalog.banks) { if (row.error || row.kind !== 'bank') continue; const bank = await library.collection('bank', row.id); if (!bank.extensions.some(extension => eligible(extension, automatic))) continue; await upgrade(library, store, bank, automatic); count++; }
  return count;
}
