import fs from 'node:fs';
import path from 'node:path';
import { ApiError, bad, id, text } from '../platform/errors.js';
import { checkPath, exists, readBytes, readJson, replaceFile, safeDirectory, safeFile, walkFiles } from '../platform/files.js';
import { cloneJson, fingerprint, hash, jsonBytes, jsonEqual } from '../platform/json.js';
import { BankFeatures } from './features.js';
import { ResourceStore } from '../resources/resources.js';
import { RichTextService, validateSdk } from '../resources/richtext-service.js';
import { DevelopmentSettings } from '../extensions/development-settings.js';
import { LibraryManagement } from './library-management.js';
import { LibraryIndex, bankDevelopmentMetadata, catalogError, referenceKey, compareVersion } from './library-index.js';
import { bankItem, scanBanks, scanExtensions } from './directories.js';
import { bindRuntimeExamples, declaration, developmentRevision, editorPage, markedDevelopment, packageSnapshot, snapshotRevision, readDevelopment, readExtension, runtimeExtension, runtimeId, snapshotPage, staticAssets } from '../extensions/extension-packages.js';
import { extensionGroup } from './directories.js';
import { runRuleBatches } from '../practice/outline.js';
import { catalogRevision, developmentFolders, finishCollection, optional, prepareCollection } from './collections.js';
import { ValidationCache } from '../extensions/validation-cache.js';
import { LoadCoordinator, SerialTransactions } from '../platform/transactions.js';
import { LibraryArchive } from './library-archive.js';
import { FileCache } from '../platform/file-cache.js';
import { findExtension, referenceIdentity, relativeExtension } from './identity.js';
import { randomUUID } from 'node:crypto';
import { eachReference } from './identity.js';
import { BankLocations } from './bank-locations.js';
import { validateImportLibrary } from './import-validation.js';

const RUNTIME_ENVIRONMENT_REUSE_MS = 30 * 1000;
export class Library {
  constructor(root, codeRoot, engine, settings = new DevelopmentSettings(root)) {
    this.root = path.resolve(root); this.codeRoot = path.resolve(codeRoot); this.engine = engine; this.settings = settings;
    this.resources = new ResourceStore(root, { fallback: new ResourceStore(path.join(root, '.development')) }); this.developmentResources = new ResourceStore(path.join(root, '.development'));
    this.richtext = new RichTextService(codeRoot); this.management = new LibraryManagement(root); this.indexer = new LibraryIndex(root, settings); this.validationCache = new ValidationCache(root);
    this.coordinator = new LoadCoordinator(); this.managementTransactions = new SerialTransactions();
    this.loaded = new Map(); this.extensionCache = new Map(); this.statuses = new Map(); this.closed = false; this.generation = 0; this.environmentPending = null; this.backgroundRunning = false;
    this.recentEnvironment = null; this.now = Date.now;
    this.files = new FileCache();
    this.pendingImports = new Map();
    this.bankLocations = new BankLocations(root);
  }
  indexSnapshot() { return this.indexer.scan(); }
  index() {
    const snapshot = this.indexSnapshot(), result = snapshot.catalog, folders = new Map();
    for (const section of ['banks', 'extensions']) for (const row of result[section]) {
      const status = this.statuses.get(row.kind + ':' + row.id);
      if (status?.revision === snapshot.revision) {
        try { if (status.identity === this.contentIdentity(this.scope(snapshot, row.kind, row.id), folders)) Object.assign(row, cloneJson(status.row)); } catch { /* Changed or missing inputs return to metadata status. */ }
      }
    }
    return result;
  }
  async catalog() {
    const snapshot = this.indexSnapshot();
    for (const candidate of snapshot.candidates) {
      if (candidate.metadata.error) continue;
      try { await this.load(candidate.kind, candidate.id, false); } catch { /* Errors remain per catalog row. */ }
    }
    return this.index();
  }
  startBackgroundValidation() {
    if (this.closed || this.backgroundRunning) return;
    this.backgroundRunning = true;
    const generation = this.generation;
    const run = async () => {
      try {
        for (const candidate of this.indexSnapshot().candidates) {
          if (this.closed || generation !== this.generation) break;
          if (candidate.metadata.error) continue;
          try { await this.load(candidate.kind, candidate.id, false); } catch { /* Keep healthy entries usable. */ }
        }
      } finally { this.backgroundRunning = false; }
    };
    // Foreground saves and reads go ahead of these batches in the rule workers.
    this.backgroundTask = this.engine.background ? this.engine.background(run) : run();
    this.backgroundTask.catch(() => {});
  }
  async environment() {
    if (this.environmentPending) return this.environmentPending;
    const pending = this.engine.validationEnvironment(); this.environmentPending = pending;
    try { const value = await pending; this.recentEnvironment = value === 'unavailable' ? null : { value, at: this.now() }; return value; } finally { if (this.environmentPending === pending) this.environmentPending = null; }
  }
  // The Node binary and rule dependencies only change with an app update.
  // Reads reuse a recent fingerprint; loads and import checks call environment().
  async runtimeEnvironment() {
    const recent = this.recentEnvironment;
    if (recent && this.now() - recent.at < RUNTIME_ENVIRONMENT_REUSE_MS) return recent.value;
    return this.environment();
  }
  // Reads recheck only the opened binding: its bank file, assets and extension
  // folders. Unrelated banks are not rescanned. Moved or missing inputs, any
  // host write (generation bump) and a newer completed index scan (catalog
  // listing, refresh, import) fall back to the full loader.
  async checkedRead(kind, collectionId) {
    const cached = this.loaded.get(kind + ':' + collectionId), scanned = this.indexer.cached?.snapshot.revision;
    if (!cached?.scope || cached.environment === 'unavailable' || scanned && scanned !== cached.indexRevision) return null;
    let identity;
    try { identity = this.contentIdentity(cached.scope); } catch { return null; }
    if (identity !== cached.identity || await this.runtimeEnvironment() !== cached.environment) return null;
    return this.loaded.get(kind + ':' + collectionId) === cached ? cached : null;
  }
  candidate(snapshot, kind, collectionId) {
    if (kind === 'development-bank') kind = 'bank';
    if (kind === 'development') return this.candidate(snapshot, 'extension', snapshot.candidates.find(row => row.kind === 'extension' && row.metadata.legacyFolder === collectionId)?.id ?? collectionId);
    let candidates = snapshot.candidates.filter(candidate => candidate.kind === kind && candidate.id === collectionId);
    if (!candidates.length && kind === 'extension') candidates = snapshot.candidates.filter(candidate => candidate.kind === kind && candidate.metadata.extensionId === collectionId);
    if (!candidates.length && kind === 'bank') {
      const routed = this.bankLocations.read().routes[collectionId];
      candidates = snapshot.candidates.filter(candidate => candidate.kind === kind && candidate.id === routed);
    }
    if (kind === 'extension' && candidates.length > 1) {
      const latest = candidates.reduce((version, candidate) => compareVersion(candidate.metadata.version, version) > 0 ? candidate.metadata.version : version, candidates[0].metadata.version);
      candidates = candidates.filter(candidate => candidate.metadata.version === latest);
    }
    if (candidates.length !== 1) throw new ApiError(404, kind === 'development' ? 'DEVELOPMENT_NOT_FOUND' : 'COLLECTION_NOT_FOUND', candidates.length ? 'Collection identity is duplicated; inspect catalog errors' : 'Collection unavailable; inspect catalog errors');
    return candidates[0];
  }
  scope(snapshot, kind, collectionId) {
    if (kind === 'page') {
      const separator = collectionId.lastIndexOf('@'), extensionId = collectionId.slice(0, separator), version = collectionId.slice(separator + 1);
      const matches = snapshot.candidates.filter(candidate => candidate.kind === 'extension' && (candidate.id === extensionId || candidate.metadata.extensionId === extensionId) && candidate.metadata.version === version);
      if (matches.length !== 1) throw new ApiError(404, 'EXTENSION_NOT_FOUND', 'Extension is unavailable');
      return { candidate: matches[0], folders: [matches[0].source], source: null };
    }
    const candidate = this.candidate(snapshot, kind, collectionId);
    if (candidate.metadata.error) throw new ApiError(candidate.metadata.errorStatus ?? 422, candidate.metadata.errorCode ?? 'INVALID_BANK', candidate.metadata.error);
    if (candidate.kind === 'extension') return { candidate, folders: [candidate.source], source: null };
    const raw = this.indexer.files.json(candidate.source), references = new Set();
    for (const question of raw.questions ?? []) references.add(referenceKey(Object.hasOwn(question, 'extension') ? question.extension : raw.extension));
    const folders = [];
    const rows = snapshot.candidates.filter(value => value.kind === 'extension').map(value => ({ ...value.metadata, source: value.source }));
    for (const question of raw.questions ?? []) {
      const match = findExtension(Object.hasOwn(question, 'extension') ? question.extension : raw.extension, rows);
      if (match.error) throw bad('Missing or duplicated extension');
      folders.push(match.source);
    }
    return { candidate, folders: [...new Set(folders)], source: candidate.source };
  }
  contentIdentity(scope, folders = new Map()) {
    const values = [];
    for (const directory of [...scope.folders].sort()) {
      let inputs = folders.get(directory);
      if (!inputs) {
        const development = markedDevelopment(directory), config = declaration(directory, development);
        inputs = [directory, config];
        if (development) inputs.push(readJson(safeFile(directory, 'development.json'), 256 * 1024));
        for (const file of walkFiles(directory).sort()) {
          if (!fs.lstatSync(file).isFile()) continue;
          inputs.push(path.relative(directory, file), this.files.hash(file));
        }
        folders.set(directory, inputs);
      }
      // Share scans within this index response only. Every later read checks again.
      for (const input of inputs) values.push(input);
    }
    if (scope.source) {
      values.push(scope.source, this.files.hash(scope.source));
      const assets = path.join(path.dirname(scope.source), 'assets');
      if (path.basename(scope.source) === 'bank.json' && path.dirname(scope.source) !== path.join(this.root, 'question-banks') && exists(assets)) for (const file of walkFiles(assets).sort()) if (fs.lstatSync(file).isFile()) values.push(path.relative(path.dirname(scope.source), file), this.files.hash(file, 4 * 1024 * 1024));
    }
    const registry = path.join(this.codeRoot, 'shared', 'richtext', 'service.json');
    if (exists(registry)) values.push(readJson(registry, 64 * 1024));
    return fingerprint(values, 'quizforge-node-library-source-v1');
  }
  async readCollection(kind, collectionId) {
    if (kind === 'exam' && this.examResolver) return this.examResolver(collectionId);
    return (await this.checkedRead(kind, collectionId))?.collection ?? this.collection(kind, collectionId);
  }
  async writeCollection(kind, collectionId) {
    if (this.closed) throw new ApiError(503, 'LIBRARY_UNAVAILABLE', 'Library is closed');
    if (kind === 'exam' && this.examResolver) return this.examResolver(collectionId);
    const cached = this.loaded.get(kind + ':' + collectionId);
    if (cached && cached.environment !== 'unavailable') {
      // Writes target a previously opened binding. Check that binding and its
      // dependencies without scanning unrelated banks. Changed/moved inputs
      // still resolve through the full loader and its existing conflict checks.
      let unchanged = false;
      try { unchanged = cached.identity === this.contentIdentity(cached.scope); } catch { /* Resolve changed or missing paths below. */ }
      if (unchanged && await this.environment() === cached.environment) return cached.collection;
    }
    return this.collection(kind, collectionId);
  }
  async collection(kind, collectionId) {
    if (kind === 'exam' && this.examResolver) return this.examResolver(collectionId);
    if (!['bank', 'extension', 'development', 'development-bank'].includes(kind)) throw bad('Invalid collection kind');
    return (await this.load(kind, collectionId, true)).collection;
  }
  async load(kind, collectionId, foreground = true) {
    if (this.closed) throw new ApiError(503, 'LIBRARY_UNAVAILABLE', 'Library is closed');
    const snapshot = this.indexSnapshot(), scope = this.scope(snapshot, kind, collectionId), identity = this.contentIdentity(scope), generation = this.generation;
    const target = kind + ':' + collectionId;
    const cached = this.loaded.get(target);
    if (cached && cached.identity === identity && cached.indexRevision === snapshot.revision) {
      const environment = foreground ? await this.environment() : cached.environment;
      if (environment !== 'unavailable' && environment === cached.environment) return cached;
    }
    this.statuses.set(scope.candidate.kind + ':' + scope.candidate.id, { revision: snapshot.revision, identity, row: { validationStatus: 'checking' } });
    return this.coordinator.submit(target + ':' + identity, foreground, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const currentSnapshot = attempt ? this.indexSnapshot() : snapshot, currentScope = attempt ? this.scope(currentSnapshot, kind, collectionId) : scope;
        const currentIdentity = this.contentIdentity(currentScope), environment = await this.environment();
        try {
          const loaded = await this.loadScope(currentSnapshot, currentScope, currentIdentity, environment, kind, collectionId);
          if (this.closed || generation !== this.generation) throw new ApiError(409, 'LIBRARY_CHANGED', 'Library changed while loading');
          const after = this.indexSnapshot();
          if (after.revision !== currentSnapshot.revision || this.contentIdentity(this.scope(after, kind, collectionId)) !== currentIdentity || (environment !== 'unavailable' && await this.environment() !== environment)) {
            if (!attempt) continue;
            throw new ApiError(409, 'LIBRARY_CHANGED', 'Library changed while loading');
          }
          loaded.indexRevision = after.revision; loaded.identity = currentIdentity; loaded.environment = environment;
          this.loaded.delete(target); this.loaded.set(target, loaded);
          while (this.loaded.size > 64) this.loaded.delete(this.loaded.keys().next().value);
          this.statuses.set(currentScope.candidate.kind + ':' + currentScope.candidate.id, { revision: after.revision, identity: currentIdentity, row: loaded.row });
          if (loaded.cacheKey && loaded.successfulCheck) this.validationCache.write(loaded.cacheKey, loaded.successfulCheck);
          return loaded;
        } catch (error) {
          const row = {}; catalogError(row, error, kind.includes('bank') ? 'INVALID_BANK' : 'INVALID_EXTENSION');
          if (!this.closed && generation === this.generation) this.statuses.set(currentScope.candidate.kind + ':' + currentScope.candidate.id, { revision: currentSnapshot.revision, identity: currentIdentity, row });
          throw error;
        }
      }
      throw new ApiError(409, 'LIBRARY_CHANGED', 'Library changed while loading');
    });
  }
  async loadScope(snapshot, scope, identity, environment, kind, collectionId, options = {}) {
    const available = new Map(), packages = new Map(), originals = new Map(), legacyAvailable = new Map();
    kind = scope.candidate.kind === 'bank' ? 'bank' : kind === 'page' ? kind : 'extension';
    if (kind !== 'page') collectionId = scope.candidate.id;
    for (const directory of scope.folders) {
      let shared = options.extensions?.get(directory);
      if (!shared) {
        const development = markedDevelopment(directory), packageValue = development ? readDevelopment(directory) : null;
        const original = readExtension(directory, this.richtext, (id, version) => this.resolveSdk(id, version), packageValue);
        this.resources.importExtensionAssets(directory, staticAssets(directory, declaration(directory, development)));
        shared = { development, packageValue, original }; options.extensions?.set(directory, shared);
      }
      const { development, packageValue, original } = shared;
      const extension = original;
      extension.referencePath = relativeExtension(this.root, directory);
      extension.pageId = snapshot.candidates.find(row => row.kind === 'extension' && row.source === directory)?.id ?? original.id;
      const folder = path.basename(directory);
      available.set('development:' + folder, extension);
      if (development) { packages.set(packageValue.folder, packageValue); originals.set(packageValue.folder, original); legacyAvailable.set('development:' + folder, runtimeExtension(original, packageValue)); }
      else legacyAvailable.set('development:' + folder, extension);
      legacyAvailable.set(extension.id + '@' + extension.version, extension);
      available.set(extension.id + '@' + extension.version, extension);
      available.set('path:' + extension.referencePath + '#' + extension.id, extension);
      this.extensionCache.set(extension.referencePath, extension);
    }
    if (kind === 'page') {
      const extension = [...available.values()].find(value => value.pageId + '@' + value.version === collectionId || value.id + '@' + value.version === collectionId);
      if (!extension) throw new ApiError(404, 'EXTENSION_NOT_FOUND', 'Extension is unavailable');
      return { descriptor: snapshotPage(extension), collection: null, row: { validationStatus: 'ready' }, scope, available, packages, originals };
    }
    let extension = null, raw;
    if (scope.source) raw = readJson(scope.source, 8 * 1024 * 1024);
    else {
      extension = [...available.values()].find(value => value.directory === scope.candidate.source);
      const original = kind === 'development' ? originals.get(collectionId) : extension;
      raw = extension.examples ? readJson(extension.examples, 8 * 1024 * 1024) : { id: 'examples', title: extension.name, extension: { id: original.id, version: original.version }, questions: [{ id: 'preview', title: extension.name, data: {} }] };
      if (raw.id !== 'examples') throw bad('Invalid example ID');
      if (kind === 'development') raw = bindRuntimeExamples(raw, original, extension);
      raw = cloneJson(raw);
      eachReference(raw, (owner, reference) => {
        if (reference.id === extension.id) owner.extension = { id: extension.id, path: extension.referencePath };
        else if (reference.development === path.basename(extension.directory)) owner.extension = { id: extension.id, path: extension.referencePath };
      });
    }
    const prepared = prepareCollection(raw, kind, extension, collectionId, available, scope.candidate.metadata.bankId ?? collectionId);
    const cacheKey = environment === 'unavailable' ? null : fingerprint({ collection: prepared.checkKey, environment, sources: identity }, 'quizforge-node-validation-v1');
    const result = await finishCollection(options.engine ?? this.engine, prepared, this.validationCache.read(cacheKey, prepared.questions.length));
    const collection = result.collection, store = this.resources;
    if (kind === 'bank' && scope.candidate.metadata.groupId) {
      collection.groupId = scope.candidate.metadata.groupId; collection.bankId = raw.id;
      // Old global-ID records remain available when only group metadata changes.
      if (!developmentFolders(raw).length) {
        const legacy = prepareCollection(raw, 'bank', null, raw.id, available);
        collection.legacyCollection = new (collection.constructor)(legacy);
      }
    }
    if (kind === 'bank' && developmentFolders(raw).length) {
      const legacy = prepareCollection(raw, 'development-bank', null, raw.id, legacyAvailable);
      collection.legacyCollection = new (collection.constructor)(legacy);
    } else if (kind === 'extension' && markedDevelopment(extension.directory)) {
      const old = legacyAvailable.get('development:' + path.basename(extension.directory));
      const legacyRaw = cloneJson(raw); eachReference(legacyRaw, owner => { owner.extension = { id: old.id, version: old.version }; });
      const legacy = prepareCollection(legacyRaw, 'development', old, path.basename(extension.directory), new Map([[old.id+'@'+old.version,old]]));
      collection.legacyCollection = new (collection.constructor)(legacy);
    }
    const source = scope.source ?? extension.examples;
    if (source && path.basename(source) === 'bank.json' && path.dirname(source) !== path.join(this.root, 'question-banks')) store.importAssets(path.dirname(source));
    const row = { validationStatus: 'ready', questionCount: collection.questions.length, contentRevision: catalogRevision(collection), extension: collection.extension ? { id: collection.extension.id, version: collection.extension.version } : null, extensions: collection.extensions.map(extension => ({ id: extension.id, version: extension.version })) };
    let descriptor = null;
    if (kind === 'development') {
      const packageValue = packages.get(collectionId), page = snapshotPage(extension), editor = editorPage(extension);
      descriptor = { id: collectionId, kind, title: packageValue.name, description: packageValue.description, revision: packageValue.revision, development: { folder: collectionId }, features: collection.features.json(), canEdit: editor !== null && collection.features.editing, page, collection: { kind, id: collectionId }, extension: { id: extension.id, version: extension.version }, legacyPage: page.legacyPage === true };
      if (editor) descriptor.editor = editor;
    } else if (kind === 'development-bank') {
      const folders = developmentFolders(raw), canEdit = collection.extensions.some(extension => editorPage(extension) !== null);
      descriptor = { id: collectionId, kind, title: collection.title, description: collection.description, development: bankDevelopmentMetadata(folders), features: collection.features.json(), canEdit: canEdit && collection.features.editing, collection: { kind, id: collectionId }, extensions: collection.extensions.map(extension => ({ id: extension.id, version: extension.version })), revision: this.bankRevision(raw, folders) };
      if (folders.length === 1) { const owner = available.get('development:' + folders[0]); descriptor.page = snapshotPage(owner); const editor = editorPage(owner); if (editor) descriptor.editor = editor; descriptor.extension = { id: owner.id, version: owner.version }; }
    }
    return { collection, descriptor, row, scope, available, packages, originals, raw, source, cacheKey, successfulCheck: result.successfulCheck };
  }
  async page(id, version) { const key = id + '@' + version; return cloneJson((await this.checkedRead('page', key) ?? await this.load('page', key)).descriptor); }
  editorPage(extension) { return editorPage(extension); }
  async development(folder) {
    const { collection } = await this.load('development', folder), extension = collection.extension;
    return { id: collection.id, kind: collection.kind, title: collection.title, revision: catalogRevision(collection), features: collection.features.json(), page: snapshotPage(extension), extension: { id: extension.id, version: extension.version }, canEdit: !!editorPage(extension) && collection.features.editing };
  }
  async developmentBank(collectionId) { const { collection } = await this.load('development-bank', collectionId); return { id: collection.id, kind: collection.kind, title: collection.title, revision: catalogRevision(collection), features: collection.features.json() }; }
  developmentDirectory(folder) {
    const matches = scanExtensions(path.join(this.root, 'extensions')).filter(directory => path.basename(directory) === folder);
    if (matches.length !== 1) throw new ApiError(404, 'DEVELOPMENT_NOT_FOUND', 'Development extension is unavailable');
    return matches[0];
  }
  developmentRevision(folder) { return { revision: developmentRevision(this.developmentDirectory(folder)) }; }
  bankRevision(raw, folders = developmentFolders(raw)) {
    const revisions = folders.map(folder => ({ folder, revision: this.developmentRevision(folder).revision }));
    const revision = folders.length === 1 ? revisions[0].revision : fingerprint(revisions, 'quizforge-development-bindings-v1');
    return hash(Buffer.from(fingerprint(raw, 'quizforge-development-bank-v1') + ':' + revision));
  }
  developmentBankRevision(collectionId) {
    const matches = this.indexSnapshot().candidates.filter(candidate => candidate.kind === 'bank' && candidate.id === collectionId);
    if (matches.length !== 1) throw new ApiError(404, 'DEVELOPMENT_BANK_NOT_FOUND', 'Development bank is unavailable');
    const raw = this.indexer.files.json(matches[0].source);
    if (!developmentFolders(raw).length) throw new ApiError(404, 'DEVELOPMENT_BANK_NOT_FOUND', 'Development bank is unavailable');
    return { revision: this.bankRevision(raw) };
  }
  resolveSdk(id, version) {
    validateSdk(id, version);
    const directory = path.join(this.root, '.state', 'sdk', id, version), file = path.join(directory, 'sdk.json');
    safeDirectory(directory);
    if (exists(file)) {
        const value = this.files.json(file, 5 * 1024 * 1024);
      if (!value || Object.keys(value).length !== 5 || value.id !== id || value.version !== version || ['script', 'editorScript', 'style'].some(key => typeof value[key] !== 'string' || value[key].length > 1024 * 1024)) throw new Error('Invalid SDK archive');
      return value;
    }
    const source = path.join(this.codeRoot, 'shared', 'richtext', version), asset = name => new TextDecoder('utf-8', { fatal: true }).decode(readBytes(safeFile(source, name), 1024 * 1024));
    const value = { id, version, script: asset('richtext.js'), editorScript: asset('richtext-editor.js'), style: asset('richtext.css') };
    replaceFile(file, jsonBytes(value)); return value;
  }
  sdk(id, version, editor = false) {
    validateSdk(id, version);
    try { const value = this.resolveSdk(id, version); return editor ? { script: value.editorScript } : { script: value.script, style: value.style }; }
    catch (error) { throw new ApiError(404, 'SDK_UNAVAILABLE', 'Requested public SDK version is unavailable', { cause: error }); }
  }
  async prepareEdit(current, questionId, title, data) {
    current.features.requireEditing();
    const latest = await this.readCollection(current.kind, current.id);
    if (catalogRevision(latest) !== catalogRevision(current)) throw new ApiError(409, 'CONTENT_CONFLICT', 'Bank changed while preparing the edit');
    const loaded = this.loaded.get(current.kind + ':' + current.id), source = loaded?.source;
    if (!source) throw new ApiError(422, 'DEVELOPMENT_NOT_IMPLEMENTED', '请先创建样例题库文件，再保存题目编辑；当前输入已保留。');
    const before = readBytes(source, 8 * 1024 * 1024), raw = readJson(source, 8 * 1024 * 1024);
    const parse = async document => {
      if (current.kind === 'development') document = bindRuntimeExamples(document, loaded.originals.get(current.id), current.extension);
      if (current.kind === 'extension') {
        document = cloneJson(document);
        eachReference(document, (owner, reference) => {
          if (reference.id === current.extension.id || reference.development === path.basename(current.extension.directory)) owner.extension = { id: current.extension.id, path: current.extension.referencePath };
        });
      }
      const prepared = prepareCollection(document, current.kind, current.extension, current.id, loaded.available, current.bankId ?? current.id);
      const replacement = (await finishCollection(this.engine, prepared)).collection;
      for (const field of ['storageKey', 'bankId', 'groupId']) if (current[field]) replacement[field] = current[field];
      return replacement;
    };
    if (catalogRevision(await parse(raw)) !== catalogRevision(current)) throw new ApiError(409, 'CONTENT_CONFLICT', 'Bank changed while reading the edit source');
    for (const question of raw.questions) if (question.id === questionId) { question.title = title; question.data = cloneJson(data); }
    const replacement = await parse(raw);
    if (['extension', 'development'].includes(current.kind) || path.basename(source) === 'bank.json' && path.dirname(source) !== path.join(this.root, 'question-banks')) (current.kind.startsWith('development') ? this.developmentResources : this.resources).exportReferences(path.dirname(source), raw);
    return { path: source, before, after: jsonBytes(raw), collection: replacement, question: replacement.question(questionId) };
  }
  invalidate() { this.generation++; this.recentEnvironment = null; this.loaded.clear(); this.extensionCache.clear(); this.statuses.clear(); this.coordinator.invalidate(() => true); }
  async developmentPublishPlan() { throw new ApiError(410, 'PUBLICATION_REMOVED', '拓展直接修改和使用，无需发布。'); }
  async publishDevelopment() { throw new ApiError(410, 'PUBLICATION_REMOVED', '拓展直接修改和使用，无需发布。'); }
  async manage(request) {
    return this.managementTransactions.run(async () => {
      const snapshot = this.index();
      const moving = request.kind === 'bank' && request.action === 'update' && request.target === 'item' ? snapshot.banks.find(row => row.path === request.path) : null;
      const previous = moving?.bankId && /^[a-f0-9-]{36}$/i.test(moving.bankId) ? await this.collection('bank', moving.id) : null;
      const beforeMove = previous ? this.loaded.get('bank:' + moving.id) : null;
      const beforeBytes = beforeMove?.source ? readBytes(beforeMove.source, 8 * 1024 * 1024) : null;
      const result = this.management.change(request, snapshot); this.invalidate();
      if (previous) {
        const after = this.index().banks.find(row => row.path === result.path);
        if (after && after.id !== previous.id) {
          try { this.bankLocations.move(previous.id, after.id, previous.stateKey()); }
          catch (error) {
            const base = this.management.base('bank'), destination = this.management.resolve(base, result.path), original = path.resolve(base, moving.path);
            if (destination !== original) fs.renameSync(destination, original);
            if (beforeBytes) replaceFile(beforeMove.source, beforeBytes);
            this.invalidate(); throw error;
          }
        }
      }
      return { ...result, catalog: this.index() };
    });
  }
  exportGroup(group) { return this.managementTransactions.run(() => new LibraryArchive(this.root, this.resources).exportGroup(group)); }
  importPackage(input) {
    return this.managementTransactions.run(async () => {
      this.pruneImports();
      if (this.pendingImports.size >= 3) throw new ApiError(429, 'IMPORT_LIMIT', '请先完成或取消已有导入');
      const result = await new LibraryArchive(this.root, this.resources).importPackage(input, async staging => {
        const candidate = new Library(staging, this.codeRoot, this.engine);
        try { await validateImportLibrary(candidate); }
        finally { candidate.close(); }
      });
      if (result.prepared) {
        if (result.conflicts.length) {
          const importId = randomUUID(); result.expires = Date.now() + 10 * 60 * 1000; this.pendingImports.set(importId, result);
          const close = result.close, timer = setTimeout(() => this.cancelImport(importId).catch(() => {}), 10 * 60 * 1000);
          timer.unref(); result.close = () => { clearTimeout(timer); close(); };
          return { needsConfirmation: true, importId, group: result.group, conflicts: result.conflicts };
        }
        try { const committed = await result.commit({}); this.invalidate(); return { ...committed, catalog: this.index() }; }
        finally { result.close(); }
      }
      this.invalidate(); return { ...result, catalog: this.index() };
    });
  }
  pruneImports() { for (const [key, plan] of this.pendingImports) if (plan.expires < Date.now()) { this.pendingImports.delete(key); plan.close(); } }
  commitImport(importId, choices) {
    return this.managementTransactions.run(async () => {
      this.pruneImports(); const plan = this.pendingImports.get(importId);
      if (!plan) throw new ApiError(410, 'IMPORT_EXPIRED', '导入已取消或过期，请重新选择题库包');
      this.pendingImports.delete(importId);
      try { const result = await plan.commit(choices); this.invalidate(); return { ...result, catalog: this.index() }; }
      finally { plan.close(); }
    });
  }
  cancelImport(importId) { return this.managementTransactions.run(() => { const plan = this.pendingImports.get(importId); if (plan) { this.pendingImports.delete(importId); plan.close(); } return { cancelled: true }; }); }
  close() { this.closed = true; for (const plan of this.pendingImports.values()) plan.close(); this.pendingImports.clear(); this.coordinator.close(); this.loaded.clear(); this.extensionCache.clear(); this.files.clear(); this.indexer.files.clear(); this.indexer.cached = null; }
}
