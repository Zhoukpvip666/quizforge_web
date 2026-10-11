import fs from 'node:fs';
import path from 'node:path';
import { ApiError, bad, id, text } from './errors.js';
import { checkPath, exists, readBytes, readJson, replaceFile, safeDirectory, safeFile, walkFiles } from './files.js';
import { cloneJson, fingerprint, hash, jsonBytes, jsonEqual } from './json.js';
import { BankFeatures } from './features.js';
import { ResourceStore } from './resources.js';
import { RichTextService, validateSdk } from './richtext-service.js';
import { DevelopmentSettings } from './development-settings.js';
import { LibraryManagement } from './library-management.js';
import { LibraryIndex, bankDevelopmentMetadata, catalogError, referenceKey, compareVersion } from './library-index.js';
import { bankItem, scanBanks, scanExtensions } from './directories.js';
import { bindRuntimeExamples, declaration, developmentRevision, editorPage, markedDevelopment, packageSnapshot, snapshotRevision, readDevelopment, readExtension, runtimeExtension, runtimeId, snapshotPage, staticAssets } from './extension-packages.js';
import { extensionGroup } from './directories.js';
import { runRuleBatches } from './outline.js';
import { catalogRevision, developmentFolders, finishCollection, optional, prepareCollection } from './collections.js';
import { ValidationCache } from './validation-cache.js';
import { LoadCoordinator, SerialTransactions } from './transactions.js';
import { LibraryArchive } from './library-archive.js';
import { FileCache } from './file-cache.js';

export class Library {
  constructor(root, codeRoot, engine, settings = new DevelopmentSettings(root)) {
    this.root = path.resolve(root); this.codeRoot = path.resolve(codeRoot); this.engine = engine; this.settings = settings;
    this.resources = new ResourceStore(root); this.developmentResources = new ResourceStore(path.join(root, '.development'));
    this.richtext = new RichTextService(codeRoot); this.management = new LibraryManagement(root); this.indexer = new LibraryIndex(root, settings); this.validationCache = new ValidationCache(root);
    this.coordinator = new LoadCoordinator(); this.managementTransactions = new SerialTransactions();
    this.loaded = new Map(); this.extensionCache = new Map(); this.statuses = new Map(); this.closed = false; this.generation = 0; this.environmentPending = null; this.backgroundRunning = false;
    this.files = new FileCache();
  }
  indexSnapshot() { return this.indexer.scan(); }
  index() {
    const snapshot = this.indexSnapshot(), result = snapshot.catalog;
    for (const section of ['banks', 'extensions']) for (const row of result[section]) {
      const status = this.statuses.get(row.kind + ':' + row.id);
      if (status?.revision === snapshot.revision) {
        try { if (status.identity === this.contentIdentity(this.scope(snapshot, row.kind, row.id))) Object.assign(row, cloneJson(status.row)); } catch { /* Changed or missing inputs return to metadata status. */ }
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
    this.backgroundTask = run();
    this.backgroundTask.catch(() => {});
  }
  async environment() {
    if (this.environmentPending) return this.environmentPending;
    const pending = this.engine.validationEnvironment(); this.environmentPending = pending;
    try { return await pending; } finally { if (this.environmentPending === pending) this.environmentPending = null; }
  }
  candidate(snapshot, kind, collectionId) {
    let candidates = snapshot.candidates.filter(candidate => candidate.kind === kind && candidate.id === collectionId);
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
      const matches = snapshot.candidates.filter(candidate => candidate.kind === 'extension' && candidate.id === extensionId && candidate.metadata.version === version || candidate.kind === 'development' && runtimeId(candidate.id) === extensionId && version === '0.0.0');
      if (matches.length !== 1) throw new ApiError(404, 'EXTENSION_NOT_FOUND', 'Extension is unavailable');
      return { candidate: matches[0], folders: [matches[0].source], source: null };
    }
    const candidate = this.candidate(snapshot, kind, collectionId);
    if (candidate.metadata.error) throw new ApiError(candidate.metadata.errorStatus ?? 422, candidate.metadata.errorCode ?? 'INVALID_BANK', candidate.metadata.error);
    if (kind === 'extension' || kind === 'development') return { candidate, folders: [candidate.source], source: null };
    const raw = this.indexer.files.json(candidate.source), references = new Set();
    for (const question of raw.questions ?? []) references.add(referenceKey(Object.hasOwn(question, 'extension') ? question.extension : raw.extension));
    const folders = [];
    for (const key of references) {
      const matches = snapshot.candidates.filter(value => key.startsWith('development:') ? value.kind === 'development' && value.id === key.slice(12) : value.kind === 'extension' && value.id + '@' + value.metadata.version === key);
      if (matches.length !== 1 || matches[0].metadata.error) throw bad('Missing or duplicated extension');
      folders.push(matches[0].source);
    }
    return { candidate, folders: [...new Set(folders)], source: candidate.source };
  }
  contentIdentity(scope) {
    const values = [];
    for (const directory of [...scope.folders].sort()) {
      const development = markedDevelopment(directory), config = declaration(directory, development);
      values.push(directory, config);
      if (development) values.push(readJson(safeFile(directory, 'development.json'), 256 * 1024));
      for (const file of walkFiles(directory).sort()) {
        if (!fs.lstatSync(file).isFile()) continue;
        values.push(path.relative(directory, file), this.files.hash(file));
      }
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
    if (kind.startsWith('development')) this.settings.requireEnabled();
    const cached = this.loaded.get(kind + ':' + collectionId);
    if (cached) {
      const snapshot = this.indexSnapshot(), scope = this.scope(snapshot, kind, collectionId);
      if (cached.indexRevision === snapshot.revision && cached.identity === this.contentIdentity(scope) && cached.environment !== 'unavailable' && await this.environment() === cached.environment) return cached.collection;
    }
    return this.collection(kind, collectionId);
  }
  async collection(kind, collectionId) {
    if (kind === 'exam' && this.examResolver) return this.examResolver(collectionId);
    if (!['bank', 'extension', 'development', 'development-bank'].includes(kind)) throw bad('Invalid collection kind');
    if (kind.startsWith('development')) this.settings.requireEnabled();
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
  async loadScope(snapshot, scope, identity, environment, kind, collectionId) {
    const available = new Map(), packages = new Map(), originals = new Map();
    for (const directory of scope.folders) {
      const development = markedDevelopment(directory), packageValue = development ? readDevelopment(directory) : null;
      const original = readExtension(directory, this.richtext, (id, version) => this.resolveSdk(id, version), packageValue);
      const extension = development ? runtimeExtension(original, packageValue) : original;
      if (development) { packages.set(packageValue.folder, packageValue); originals.set(packageValue.folder, original); available.set('development:' + packageValue.folder, extension); }
      available.set(extension.id + '@' + extension.version, extension);
      this.extensionCache.set(extension.id + '@' + extension.version, extension);
      (development ? this.developmentResources : this.resources).importExtensionAssets(directory, staticAssets(directory, declaration(directory, development)));
    }
    if (kind === 'page') {
      const extension = available.get(collectionId);
      if (!extension) throw new ApiError(404, 'EXTENSION_NOT_FOUND', 'Extension is unavailable');
      return { descriptor: snapshotPage(extension), collection: null, row: { validationStatus: 'ready' }, scope, available, packages, originals };
    }
    let extension = null, raw;
    if (scope.source) raw = readJson(scope.source, 8 * 1024 * 1024);
    else {
      extension = kind === 'development' ? available.get('development:' + collectionId) : [...available.values()].find(value => value.id === collectionId);
      const original = kind === 'development' ? originals.get(collectionId) : extension;
      raw = extension.examples ? readJson(extension.examples, 8 * 1024 * 1024) : { id: 'examples', title: extension.name, extension: { id: original.id, version: original.version }, questions: [{ id: 'preview', title: extension.name, data: {} }] };
      if (raw.id !== 'examples') throw bad('Invalid example ID');
      if (kind === 'development') raw = bindRuntimeExamples(raw, original, extension);
    }
    const prepared = prepareCollection(raw, kind, extension, collectionId, available);
    const cacheKey = environment === 'unavailable' ? null : fingerprint({ collection: prepared.checkKey, environment, sources: identity }, 'quizforge-node-validation-v1');
    const result = await finishCollection(this.engine, prepared, this.validationCache.read(cacheKey, prepared.questions.length));
    const collection = result.collection, store = kind.startsWith('development') ? this.developmentResources : this.resources;
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
  async page(id, version) { return cloneJson((await this.load('page', id + '@' + version)).descriptor); }
  editorPage(extension) { return editorPage(extension); }
  async development(folder) { this.settings.requireEnabled(); return cloneJson((await this.load('development', folder)).descriptor); }
  async developmentBank(collectionId) { this.settings.requireEnabled(); return cloneJson((await this.load('development-bank', collectionId)).descriptor); }
  developmentDirectory(folder) {
    const matches = scanExtensions(path.join(this.root, 'extensions')).filter(directory => markedDevelopment(directory) && path.basename(directory) === folder);
    if (matches.length !== 1) throw new ApiError(404, 'DEVELOPMENT_NOT_FOUND', 'Development extension is unavailable');
    return matches[0];
  }
  developmentRevision(folder) { this.settings.requireEnabled(); return { revision: developmentRevision(this.developmentDirectory(folder)) }; }
  bankRevision(raw, folders = developmentFolders(raw)) {
    const revisions = folders.map(folder => ({ folder, revision: this.developmentRevision(folder).revision }));
    const revision = folders.length === 1 ? revisions[0].revision : fingerprint(revisions, 'quizforge-development-bindings-v1');
    return hash(Buffer.from(fingerprint(raw, 'quizforge-development-bank-v1') + ':' + revision));
  }
  developmentBankRevision(collectionId) {
    this.settings.requireEnabled();
    const matches = scanBanks(path.join(this.root, 'question-banks')).banks.map(file => ({ file, raw: readJson(file, 8 * 1024 * 1024) })).filter(value => value.raw.id === collectionId);
    if (matches.length !== 1 || !developmentFolders(matches[0].raw).length) throw new ApiError(404, 'DEVELOPMENT_BANK_NOT_FOUND', 'Development bank is unavailable');
    return { revision: this.bankRevision(matches[0].raw) };
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
      const prepared = prepareCollection(document, current.kind, current.extension, current.id, loaded.available);
      return (await finishCollection(this.engine, prepared)).collection;
    };
    if (catalogRevision(await parse(raw)) !== catalogRevision(current)) throw new ApiError(409, 'CONTENT_CONFLICT', 'Bank changed while reading the edit source');
    for (const question of raw.questions) if (question.id === questionId) { question.title = title; question.data = cloneJson(data); }
    const replacement = await parse(raw);
    if (['extension', 'development'].includes(current.kind) || path.basename(source) === 'bank.json' && path.dirname(source) !== path.join(this.root, 'question-banks')) (current.kind.startsWith('development') ? this.developmentResources : this.resources).exportReferences(path.dirname(source), raw);
    return { path: source, before, after: jsonBytes(raw), collection: replacement, question: replacement.question(questionId) };
  }
  invalidate() { this.generation++; this.loaded.clear(); this.extensionCache.clear(); this.statuses.clear(); this.coordinator.invalidate(() => true); }
  async validatePublication(directory) {
    const original = readExtension(directory, this.richtext, (id, version) => this.resolveSdk(id, version));
    const raw = bindRuntimeExamples(readJson(original.examples, 8 * 1024 * 1024), original, original);
    if (raw.id !== 'examples') throw bad('Invalid example ID');
    const prepared = prepareCollection(raw, 'extension', original, original.id, new Map([[original.id + '@' + original.version, original]]));
    const { collection } = await finishCollection(this.engine, prepared);
    editorPage(original);
    await runRuleBatches(this.engine, collection.questions, 'scoreBatch', 'scores', collection.questions.map(question => ({ data: question.data, state: { status: 'unanswered', answer: null, result: null } })));
    return original;
  }
  requirePublicationIdentity(original) {
    for (const directory of scanExtensions(path.join(this.root, 'extensions'))) {
      if (markedDevelopment(directory)) continue;
      let manifest; try { manifest = readJson(safeFile(directory, 'manifest.json'), 256 * 1024); } catch { continue; }
      if (manifest.id === original.id && manifest.version === original.version) throw new ApiError(409, 'EXTENSION_VERSION_EXISTS', 'This formal extension ID and version already exist; choose a new version');
    }
  }
  async developmentPublishPlan(folder) {
    this.settings.requireEnabled(); const source = this.developmentDirectory(folder), value = readDevelopment(source), revision = snapshotRevision(packageSnapshot(source));
    if (value.mode !== 'runtime') throw new ApiError(409, 'DEVELOPMENT_NOT_READY', 'Complete the runtime extension before publishing');
    const original = await this.validatePublication(source); this.requirePublicationIdentity(original);
    let target = original.id + '-' + original.version;
    if (target.length > 120) target = original.id.slice(0, 80) + '-' + hash(Buffer.from(original.id + '@' + original.version)).slice(0, 16);
    const group = extensionGroup(path.join(this.root, 'extensions'), source); if (group) target = group + '/' + target;
    if (exists(path.join(this.root, 'extensions', target))) throw new ApiError(409, 'PUBLISH_TARGET_EXISTS', 'Publication directory already exists');
    if (revision !== snapshotRevision(packageSnapshot(source))) throw new ApiError(409, 'DEVELOPMENT_CHANGED', 'Development files changed during validation; review the publication again');
    return { id: original.id, version: original.version, name: text(readJson(safeFile(source, 'manifest.json')), 'name', 300), targetFolder: target, revision, valid: true };
  }
  publishDevelopment(folder, request) {
    return this.managementTransactions.run(async () => {
      if (!request || Object.keys(request).length !== 1 || typeof request.revision !== 'string') throw bad('Publication requires the reviewed revision');
      const plan = await this.developmentPublishPlan(folder);
      if (request.revision !== plan.revision) throw new ApiError(409, 'DEVELOPMENT_CHANGED', 'Development files changed since publication was reviewed');
      const source = this.developmentDirectory(folder), files = packageSnapshot(source);
      if (snapshotRevision(files) !== plan.revision) throw new ApiError(409, 'DEVELOPMENT_CHANGED', 'Development files changed while preparing publication');
      const manifest = readJson(safeFile(source, 'manifest.json')), media = staticAssets(source, manifest);
      if (media.length) { manifest.assets = media; files.set('manifest.json', jsonBytes(manifest)); }
      const original = await this.validatePublication(source), examples = path.relative(source, original.examples).replaceAll('\\', '/');
      files.set(examples, jsonBytes(bindRuntimeExamples(readJson(original.examples), original, original)));
      const stagingRoot = safeDirectory(path.join(this.root, '.temp', 'publishing'), true), staged = fs.mkdtempSync(path.join(stagingRoot, 'package-'));
      try {
        for (const [relative, bytes] of files) {
          if (relative === 'development.json') continue;
          const target = path.resolve(staged, relative); if (!target.startsWith(staged + path.sep)) throw new Error('Unsafe publication path');
          safeDirectory(path.dirname(target), true); fs.writeFileSync(target, bytes, { flag: 'wx' });
        }
        this.requirePublicationIdentity(await this.validatePublication(staged));
        if (plan.revision !== snapshotRevision(packageSnapshot(source))) throw new ApiError(409, 'DEVELOPMENT_CHANGED', 'Development files changed during publication; review again');
        const destination = path.join(this.root, 'extensions', plan.targetFolder); checkPath(path.dirname(destination), { directory: true });
        if (exists(destination)) throw new ApiError(409, 'PUBLISH_TARGET_EXISTS', 'Publication directory already exists');
        fs.renameSync(staged, destination); this.invalidate(); return { ...plan, published: true };
      } finally {
        if (!staged.startsWith(stagingRoot + path.sep)) throw new Error('Unsafe publication cleanup');
        if (exists(staged)) { for (const file of walkFiles(staged)) checkPath(file); fs.rmSync(staged, { recursive: true }); }
      }
    });
  }
  async manage(request) {
    return this.managementTransactions.run(async () => {
      const snapshot = this.index();
      const result = this.management.change(request, snapshot); this.invalidate();
      return { ...result, catalog: this.index() };
    });
  }
  exportGroup(group) { return this.managementTransactions.run(() => new LibraryArchive(this.root, this.resources).exportGroup(group)); }
  importPackage(input) {
    return this.managementTransactions.run(async () => {
      const result = await new LibraryArchive(this.root, this.resources).importPackage(input, async staging => {
        const candidate = new Library(staging, this.codeRoot, this.engine);
        try { const catalog = await candidate.catalog(); for (const row of [...catalog.banks, ...catalog.extensions]) if (row.error) throw new ApiError(422, 'INVALID_LIBRARY_ARCHIVE', '题库包包含无效题库或拓展：' + row.error); }
        finally { candidate.close(); }
      }); this.invalidate(); return { ...result, catalog: this.index() };
    });
  }
  close() { this.closed = true; this.coordinator.close(); this.loaded.clear(); this.extensionCache.clear(); this.files.clear(); this.indexer.files.clear(); this.indexer.cached = null; }
}
