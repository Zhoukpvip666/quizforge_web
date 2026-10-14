import path from 'node:path';
import fs from 'node:fs';
import { ApiError, bad, id, text, requireObject } from '../platform/errors.js';
import { exists, readJson, safeFile, within } from '../platform/files.js';
import { cloneJson, fingerprint } from '../platform/json.js';
import { BankFeatures } from './features.js';
import { bankItem, extensionGroup, scanBanks, scanExtensions } from './directories.js';
import { markedDevelopment } from '../extensions/extension-packages.js';
import { requireBankFormat, requireManifestApi } from '../extensions/extension-api.js';
import { developmentFolders, optional } from './collections.js';
import { LibraryManagement } from './library-management.js';
import { FileCache, fileIdentity } from '../platform/file-cache.js';
import { groupIdentity, GROUP_FILE, isUuid, bankLocator, extensionLocator, relativeExtension, referenceIdentity, findExtension } from './identity.js';

const relative = (base, file) => path.relative(base, file).replaceAll('\\', '/');
export function compareVersion(left, right) {
  const a = left.split(/[.-]/), b = right.split(/[.-]/);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? '0', y = b[i] ?? '0';
    if (/^[+-]?\d+$/.test(x) && /^[+-]?\d+$/.test(y)) { if (BigInt(x) !== BigInt(y)) return BigInt(x) < BigInt(y) ? -1 : 1; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
export function referenceKey(reference) {
  return referenceIdentity(reference);
}
export function bankDevelopmentMetadata(folders) { return { folders: [...folders], ...(folders.length === 1 ? { folder: folders[0] } : {}) }; }
export function catalogError(row, failure, code) {
  Object.assign(row, { validationStatus: 'error', error: failure.message ?? 'Invalid library entry', errorCode: failure instanceof ApiError ? failure.code : code, errorStatus: failure instanceof ApiError ? failure.status : 422 });
}
export function latestExtensions(rows) {
  const versions = new Map();
  for (const row of rows) if (row.kind === 'extension' && !row.error) { const version = versions.get(row.id); if (!version || compareVersion(row.version, version) > 0) versions.set(row.id, row.version); }
  return rows.filter(row => row.kind !== 'extension' || row.error || row.version === versions.get(row.id));
}
export class LibraryIndex {
  constructor(root, settings) { this.root = path.resolve(root); this.settings = settings; this.management = new LibraryManagement(root); this.files = new FileCache(); }
  scan() {
    const extensionRoot = path.join(this.root, 'extensions'), folders = scanExtensions(extensionRoot), bankTree = scanBanks(path.join(this.root, 'question-banks'));
    const inventory = JSON.stringify([this.settings.enabled, folders, bankTree.banks, bankTree.groups, exists(extensionRoot) ? fs.readdirSync(extensionRoot).sort() : []]);
    const stamp = file => { try { return exists(file) ? fileIdentity(file) : null; } catch { return 'unavailable'; } };
    if (this.cached?.inventory === inventory && this.cached.inputs.every(([file, identity]) => stamp(file) === identity)) return cloneJson(this.cached.snapshot);
    const inputs = new Set([this.management.labelsFile, this.management.extensionGroups.file, ...bankTree.groups.map(directory => path.join(directory, GROUP_FILE)), ...bankTree.banks, ...folders.flatMap(directory => [path.join(directory, 'manifest.json'), path.join(directory, 'development.json')])]);
    const candidates = [], available = new Set(), packages = [], banks = [], identities = [], names = new Map();
    for (const directory of folders) { const name = path.basename(directory); names.set(name, (names.get(name) ?? 0) + 1); }
    for (const directory of folders) {
      const development = markedDevelopment(directory);
      const folder = path.basename(directory), kind = 'extension';
      const row = { id: folder, kind, version: '?', name: folder, description: '', questionCount: 0, validationStatus: 'pending', path: relative(path.join(this.root, 'extensions'), directory) };
      const group = extensionGroup(path.join(this.root, 'extensions'), directory); if (group) row.group = group;
      try {
        const manifestFile = exists(path.join(directory, 'manifest.json')) ? safeFile(directory, 'manifest.json') : null, markerFile = development ? safeFile(directory, 'development.json') : null;
        const manifest = manifestFile ? this.files.json(manifestFile, 256 * 1024) : {}, marker = markerFile ? this.files.json(markerFile, 256 * 1024) : {};
        requireObject(manifest, 'Invalid extension declaration'); requireObject(marker, 'Invalid extension declaration');
        if (development) {
          if (Object.hasOwn(marker, 'mode') && !['ui', 'runtime'].includes(marker.mode)) throw bad('Invalid legacy development mode');
          if (Object.hasOwn(marker, 'types') || Object.hasOwn(marker, 'packageFormatVersion')) throw bad('Each extension provides one question type');
        }
        {
          requireManifestApi(manifest);
          if (Object.hasOwn(manifest, 'types') || Object.hasOwn(manifest, 'packageFormatVersion')) throw bad('Each extension provides one question type');
          Object.assign(row, { id: id(manifest, 'id'), version: id(manifest, 'version'), name: text(manifest, 'name', 300), description: optional(manifest, 'description', 4000) });
          row.extensionId = row.id; row.referencePath = relativeExtension(this.root, directory);
          available.add(row.id + '@' + row.version);
        }
        row.legacyFolder = folder;
        if (names.get(folder) === 1) available.add('development:' + folder);
        const exampleName = Object.hasOwn(manifest, 'examples') ? manifest.examples : marker.examples;
        if (typeof exampleName === 'string') {
          if (!exampleName.trim() || exampleName.length > 240 || path.isAbsolute(exampleName) || exampleName.includes('\\') || exampleName.includes(':') || !within(directory, path.resolve(directory, exampleName))) throw bad('Invalid examples path');
          inputs.add(path.resolve(directory, exampleName));
          if (exists(path.resolve(directory, exampleName))) { const file = safeFile(directory, exampleName), raw = this.files.json(file); row.questionCount = Array.isArray(raw.questions) ? raw.questions.length : 0; identities.push(this.files.jsonFingerprint(file, 'index-examples')); }
        }
        identities.push(manifestFile ? this.files.jsonFingerprint(manifestFile, 'index-manifest', 256 * 1024) : fingerprint(manifest, 'index-manifest'), markerFile ? this.files.jsonFingerprint(markerFile, 'index-development', 256 * 1024) : fingerprint(marker, 'index-development'));
      } catch (error) { catalogError(row, error, 'INVALID_EXTENSION'); }
      candidates.push({ kind, id: row.id, source: directory, metadata: cloneJson(row) }); packages.push(row);
    }
    const counts = new Map(); for (const row of packages) counts.set(row.extensionId, (counts.get(row.extensionId) ?? 0) + 1);
    for (let index = 0; index < packages.length; index++) {
      const row = packages[index];
      if (row.referencePath && (isUuid(row.extensionId) || counts.get(row.extensionId) > 1)) row.id = extensionLocator(row.referencePath);
      candidates[index].id = row.id; candidates[index].metadata = cloneJson(row);
    }
    for (const file of bankTree.banks) {
      const base = path.join(this.root, 'question-banks'), item = bankItem(base, file);
      const row = { id: path.basename(file).replace(/\.json$/, ''), kind: 'bank', title: path.basename(item), description: '', questionCount: 0, validationStatus: 'pending', path: relative(base, item) };
      const group = relative(base, path.dirname(item)); if (group) row.group = group;
      try {
        const raw = this.files.json(file), development = developmentFolders(raw).length > 0;
        requireBankFormat(raw); row.features = BankFeatures.read(raw).json();
        Object.assign(row, { id: id(raw, 'id'), title: text(raw, 'title', 300), description: optional(raw, 'description', 4000) });
        row.bankId = row.id; if (typeof raw.version === 'string') row.version = raw.version;
        const groupId = group ? groupIdentity(path.dirname(item)) : null;
        if (groupId && isUuid(row.bankId)) { row.groupId = groupId; row.id = bankLocator(groupId, row.bankId); }
        if (!Array.isArray(raw.questions) || !raw.questions.length || raw.questions.length > 10000) throw bad('Invalid questions');
        const ids = new Set(), references = new Map();
        for (const question of raw.questions) {
          const questionId = id(question, 'id'); if (ids.has(questionId) || !Object.hasOwn(question, 'data')) throw bad('Duplicate question or missing data'); ids.add(questionId);
          text(question, 'title', 300); if (Object.hasOwn(question, 'features')) throw bad('features belong at the bank root');
          const reference = Object.hasOwn(question, 'extension') ? question.extension : raw.extension, key = referenceKey(reference);
          findExtension(reference, packages); if (!references.has(key)) references.set(key, reference);
        }
        Object.assign(row, { questionCount: raw.questions.length, extension: cloneJson(raw.extension ?? null), extensions: cloneJson([...references.values()]) });
        identities.push(this.files.jsonFingerprint(file, 'index-bank'));
      } catch (error) { catalogError(row, error, 'INVALID_BANK'); }
      candidates.push({ kind: row.kind, id: row.id, source: file, metadata: cloneJson(row) }); banks.push(row);
    }
    const catalog = this.management.catalog({ banks, extensions: packages, developmentEnabled: this.settings.enabled });
    identities.push(catalog); const revision = fingerprint(identities, 'quizforge-library-index-v1'); catalog.indexRevision = revision;
    const snapshot = { revision, candidates, catalog };
    this.cached = { inventory, inputs: [...inputs].map(file => [file, stamp(file)]), snapshot: cloneJson(snapshot) };
    return snapshot;
  }
}
