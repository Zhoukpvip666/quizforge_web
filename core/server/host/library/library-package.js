import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError, bad, id } from '../platform/errors.js';
import { checkPath, exists, readBytes, readJson, replaceFile, safeDirectory, walkFiles, within } from '../platform/files.js';
import { cloneJson, fingerprint, hash, jsonBytes } from '../platform/json.js';
import { ResourceStore } from '../resources/resources.js';
import { declaration, staticAssets } from '../extensions/extension-packages.js';
import { scanBanks, scanExtensions, bankItem } from './directories.js';
import { folderName } from './library-management.js';
import { GROUP_FILE, groupIdentity, isUuid, relativeExtension, eachReference, findExtension } from './identity.js';
import { LibraryArchive, MANIFEST, FORMAT, MAX_FILE } from './library-archive.js';

const invalid = message => new ApiError(422, 'INVALID_LIBRARY_ARCHIVE', message);
const conflict = message => new ApiError(409, 'LIBRARY_IMPORT_CONFLICT', message);
const relative = (base, file) => path.relative(base, file).replaceAll('\\', '/');
const occupied = directory => new Set(fs.readdirSync(directory).map(name => name.toLowerCase()));
function uniqueName(name, used) {
  folderName(name);
  const extension = path.extname(name), base = extension ? name.slice(0, -extension.length) : name;
  let result = name, suffix = 2;
  while (used.has(result.toLowerCase())) result = `${base.slice(0, 105)}（${suffix++}）${extension}`;
  used.add(result.toLowerCase()); return result;
}
export function packageHash(directory) {
  const values = {};
  for (const file of walkFiles(directory, 10001).sort()) if (fs.lstatSync(file).isFile()) {
    const name = relative(directory, file);
    values[name] = name.endsWith('.json') ? fingerprint(readJson(file, MAX_FILE), 'archive-json') : hash(readBytes(file, MAX_FILE));
  }
  return fingerprint(values, 'quizforge-extension-package-v2');
}
function inventory(root) {
  return scanExtensions(path.join(root, 'extensions')).map(source => {
    const manifest = declaration(source);
    return { source, id: id(manifest, 'id'), extensionId: manifest.id, version: id(manifest, 'version'), referencePath: relativeExtension(root, source), legacyFolder: path.basename(source) };
  });
}
function rewrite(raw, rows, paths) {
  let changed = false;
  eachReference(raw, (owner, reference) => {
    const row = findExtension(reference, rows), target = paths.get(row.source);
    if (!target) throw invalid('题库引用了未包含的拓展');
    if (reference.path !== target || reference.id !== row.extensionId || Object.keys(reference).some(key => !['id', 'path'].includes(key))) {
      owner.extension = { id: row.extensionId, path: target }; changed = true;
    }
  });
  return changed;
}
export async function exportV2(archive, group) {
  const bankRoot = path.join(archive.root, 'question-banks'), selected = path.join(bankRoot, group), groupId = groupIdentity(selected);
  if (!groupId) return null;
  const files = scanBanks(bankRoot).banks.filter(file => path.dirname(bankItem(bankRoot, file)) === selected);
  if (files.some(file => !isUuid(readJson(file, MAX_FILE).id))) return null;
  const work = archive.workspace();
  try {
    const content = path.join(work, 'content'), targetBanks = path.join(content, 'question-banks', group), targetExtensions = path.join(content, 'extensions');
    safeDirectory(targetBanks, true); safeDirectory(targetExtensions, true);
    const rows = inventory(archive.root), banks = [], required = new Map(), bankIds = new Set();
    for (const file of files) {
      const raw = readJson(file, MAX_FILE);
      if (!isUuid(raw.id)) throw invalid('请先完成题库 UUID 迁移再导出：' + (raw.title ?? file));
      if (bankIds.has(raw.id)) throw conflict('分组内题库 UUID 重复：' + raw.id);
      bankIds.add(raw.id); banks.push({ file, raw });
      eachReference(raw, (_owner, reference) => { const row = findExtension(reference, rows); required.set(row.source, row); });
    }
    const entries = [], paths = new Map(), hashes = new Map(), names = new Set();
    for (const row of required.values()) {
      const name = uniqueName(path.basename(row.source), names), destination = path.join(targetExtensions, name);
      archive.resources.importExtensionAssets(row.source, staticAssets(row.source, declaration(row.source)));
      archive.copyExtension(row.source, destination);
      const digest = packageHash(destination), key = row.extensionId + '#' + digest, existing = hashes.get(key);
      if (existing) { paths.set(row.source, existing); fs.rmSync(destination, { recursive: true }); }
      else { const target = 'extensions/' + name; paths.set(row.source, target); hashes.set(key, target); entries.push({ path: target, id: row.extensionId, version: row.version, hash: digest }); }
    }
    for (const bank of banks) {
      const destination = path.join(targetBanks, bank.raw.id);
      archive.copyBank(bank.file, destination);
      if (rewrite(bank.raw, rows, paths)) replaceFile(path.join(destination, 'bank.json'), jsonBytes(bank.raw));
    }
    replaceFile(path.join(targetBanks, GROUP_FILE), jsonBytes({ schemaVersion: 1, kind: 'bank-group', id: groupId }));
    replaceFile(path.join(content, MANIFEST), jsonBytes({ format: FORMAT, formatVersion: 2, group: { id: groupId, name: group }, extensions: entries }));
    const file = path.join(work, 'group.qbank'); await archive.zip(content, file);
    if (fs.statSync(file).size > 64 * 1024 * 1024) throw new ApiError(413, 'LIBRARY_ARCHIVE_LIMIT', '导出的题库包超过 64 MiB');
    return { workspace: work, file, close: () => archive.removeWorkspace(work) };
  } catch (error) { archive.removeWorkspace(work); throw error; }
}
function higher(incoming, existing) {
  if (![incoming, existing].every(value => typeof value === 'string' && /^\d+(?:\.\d+)*$/.test(value) && value.length <= 120)) return false;
  const a = incoming.split('.').map(BigInt), b = existing.split('.').map(BigInt);
  for (let index = 0; index < Math.max(a.length, b.length); index++) if ((a[index] ?? 0n) !== (b[index] ?? 0n)) return (a[index] ?? 0n) > (b[index] ?? 0n);
  return false;
}
export async function prepareV2(archive, work, staging, marker, validator) {
  if (marker.format !== FORMAT || !marker.group || !isUuid(marker.group.id) || typeof marker.group.name !== 'string' || !Array.isArray(marker.extensions)) throw invalid('题库包 v2 缺少有效分组 UUID 或拓展清单');
  const name = marker.group.name; folderName(name);
  const incomingRoot = path.join(staging, 'question-banks'), extensionRoot = path.join(staging, 'extensions');
  if (!exists(incomingRoot) || !exists(extensionRoot)) throw invalid('题库包需要 question-banks 和 extensions 文件夹');
  if (fs.readdirSync(incomingRoot).length !== 1 || fs.readdirSync(incomingRoot)[0] !== name) throw invalid('题库包只能包含声明的一个题库分组');
  const sourceGroup = path.join(incomingRoot, name);
  if (groupIdentity(sourceGroup) !== marker.group.id.toLowerCase()) throw invalid('题库分组 UUID 与格式标识不一致');
  const incomingBanks = scanBanks(incomingRoot).banks, incomingExtensions = scanExtensions(extensionRoot);
  if (incomingExtensions.some(directory => path.dirname(directory) !== extensionRoot) || fs.readdirSync(extensionRoot).length !== incomingExtensions.length) throw invalid('拓展必须直接平铺在 extensions 文件夹中');
  const rows = inventory(staging), entries = new Map();
  for (const entry of marker.extensions) {
    if (!entry || typeof entry.hash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.hash) || entries.has(entry.path)) throw invalid('拓展清单哈希缺失或重复');
    const row = rows.find(row => row.referencePath === entry.path);
    if (!row || entry.id !== row.extensionId || entry.version !== row.version) throw invalid('拓展清单与声明不一致');
    entries.set(entry.path, entry);
  }
  if (entries.size !== rows.length) throw invalid('拓展清单不完整');
  const ids = new Set();
  for (const file of incomingBanks) { const raw = readJson(file, MAX_FILE); if (!isUuid(raw.id) || ids.has(raw.id)) throw invalid('题库 UUID 无效或在分组内重复'); ids.add(raw.id); }
  archive.validatePrivatePaths(staging, incomingBanks, incomingExtensions);
  await validator(staging);
  const bankBase = path.join(archive.root, 'question-banks'), localGroups = scanBanks(bankBase).groups;
  const matches = localGroups.filter(directory => groupIdentity(directory) === marker.group.id.toLowerCase());
  if (matches.length > 1) throw conflict('本地题库分组 UUID 重复，请先修复');
  const groupName = matches.length ? path.basename(matches[0]) : uniqueName(name, occupied(bankBase)), targetGroup = path.join(bankBase, groupName);
  const localBanks = new Map();
  if (matches.length) for (const file of scanBanks(bankBase).banks.filter(file => path.dirname(bankItem(bankBase, file)) === targetGroup)) {
    const raw = readJson(file, MAX_FILE);
    if (localBanks.has(raw.id)) throw conflict('目标分组内题库 UUID 重复：' + raw.id);
    localBanks.set(raw.id, { file, raw });
  }
  const bankPlans = incomingBanks.map(file => { const raw = readJson(file, MAX_FILE), local = localBanks.get(raw.id); return { file, raw, local, automatic: !local || higher(raw.version, local.raw.version) }; });
  const conflicts = bankPlans.filter(item => !item.automatic).map(item => ({ id: item.raw.id, title: item.raw.title, existingTitle: item.local.raw.title, existingVersion: item.local.raw.version ?? null, incomingVersion: item.raw.version ?? null }));
  const local = inventory(archive.root), paths = new Map(), names = occupied(path.join(archive.root, 'extensions')), extensions = [], signatures = new Map(), planned = new Map();
  let skippedExtensions = 0;
  const normalizedResources = new ResourceStore(work, { fallback: archive.resources });
  for (const row of rows) {
    const incoming = entries.get(row.referencePath), candidates = local.filter(candidate => candidate.extensionId === row.extensionId).sort((a, b) => (a.referencePath === row.referencePath ? -1 : b.referencePath === row.referencePath ? 1 : a.referencePath.localeCompare(b.referencePath)));
    let reused = planned.get(row.extensionId + '#' + incoming.hash);
    for (const candidate of candidates) {
      if (reused) break;
      if (!signatures.has(candidate.source)) {
        const normalized = path.join(work, 'compare-' + signatures.size), normalizer = new LibraryArchive(archive.root, normalizedResources);
        normalizedResources.importExtensionAssets(candidate.source, staticAssets(candidate.source, declaration(candidate.source)));
        normalizer.copyExtension(candidate.source, normalized); signatures.set(candidate.source, packageHash(normalized));
      }
      if (signatures.get(candidate.source) === incoming.hash) reused = candidate.referencePath;
    }
    if (reused) { paths.set(row.source, reused); skippedExtensions++; continue; }
    // A legacy ID/version reference cannot distinguish a second physical entity.
    // Preserve existing banks rather than changing their bindings behind the user.
    if (candidates.some(candidate => candidate.version === row.version)) {
      for (const file of scanBanks(bankBase).banks) {
        const raw = readJson(file, MAX_FILE); let ambiguous = false;
        eachReference(raw, (_owner, reference) => { ambiguous ||= !reference.path && reference.id === row.extensionId && reference.version === row.version; });
        if (ambiguous) throw conflict('已有题库使用旧 ID/version 绑定，请先迁移为准确拓展路径：' + raw.title);
      }
    }
    const folder = uniqueName(path.basename(row.source), names), target = 'extensions/' + folder;
    paths.set(row.source, target); planned.set(row.extensionId + '#' + incoming.hash, target);
    extensions.push({ source: row.source, destination: path.join(archive.root, 'extensions', folder) });
  }
  return {
    prepared: true, group: groupName, conflicts,
    close: () => archive.removeWorkspace(work),
    commit: async choices => {
      if (exists(targetGroup) && (!matches.length || groupIdentity(targetGroup) !== marker.group.id.toLowerCase())) throw conflict('目标分组已变化，请重新导入');
      for (const item of bankPlans) if (item.local && exists(item.local.file) && readJson(item.local.file, MAX_FILE).id !== item.raw.id) throw conflict('目标题库身份已变化，请重新导入');
      if (!choices || typeof choices !== 'object' || Array.isArray(choices) || Object.keys(choices).some(key => !conflicts.some(row => row.id === key))) throw bad('Invalid import choices');
      for (const row of conflicts) if (!['keep', 'replace'].includes(choices[row.id])) throw bad('请选择保留现有题库或使用导入题库');
      const selected = bankPlans.filter(item => item.automatic || choices[item.raw.id] === 'replace'), skippedBanks = bankPlans.length - selected.length;
      const usedTitles = new Set([...localBanks.values()].filter(local => !selected.some(item => item.local === local)).map(item => item.raw.title));
      const usedFiles = exists(targetGroup) ? occupied(targetGroup) : new Set(), installs = [];
      for (const item of selected) {
        let title = item.raw.title, number = 2;
        while (usedTitles.has(title)) title = `${item.raw.title}（${number++}）`;
        usedTitles.add(title);
        const changed = rewrite(item.raw, rows, paths) || title !== item.raw.title; item.raw.title = title;
        const source = bankItem(incomingRoot, item.file);
        if (changed) replaceFile(item.file, jsonBytes(item.raw));
        const destination = item.local ? bankItem(bankBase, item.local.file) : path.join(targetGroup, uniqueName(path.basename(source), usedFiles));
        installs.push({ source, destination, allowReplace: !!item.local });
      }
      // Resources are populated only from this validated package's isolated root.
      const resources = new ResourceStore(staging);
      for (const item of selected) resources.exportReferences(path.dirname(item.file), item.raw);
      const archiveRoot = path.join(archive.root, '.trash', 'library-import', randomUUID()), backups = [], created = [], installed = [];
      try {
        if (!exists(targetGroup)) { safeDirectory(targetGroup, true); created.push(targetGroup); replaceFile(path.join(targetGroup, GROUP_FILE), jsonBytes({ schemaVersion: 1, kind: 'bank-group', id: marker.group.id.toLowerCase() })); }
        for (const move of [...extensions, ...installs]) {
          if (exists(move.destination)) {
            if (!move.allowReplace) throw conflict('导入目标目录已被占用，请重新选择导入包');
            safeDirectory(archiveRoot, true); const backup = path.join(archiveRoot, String(backups.length));
            backups.push({ original: move.destination, backup });
            replaceFile(path.join(archiveRoot, 'receipt.json'), jsonBytes({ group: groupName, createdAt: new Date().toISOString(), backups: backups.map(item => ({ original: relative(archive.root, item.original), backup: path.basename(item.backup) })) }));
            fs.renameSync(move.destination, backup);
          }
          safeDirectory(path.dirname(move.destination), true); fs.renameSync(move.source, move.destination); installed.push(move);
        }
        return { group: groupName, importedBanks: selected.length, replacedBanks: selected.filter(item => item.local).length, importedExtensions: extensions.length, skippedBanks, skippedExtensions, ...(backups.length ? { backup: relative(archive.root, archiveRoot) } : {}) };
      } catch (error) {
        for (const move of installed.reverse()) if (exists(move.destination)) { safeDirectory(path.dirname(move.source), true); fs.renameSync(move.destination, move.source); }
        for (const item of backups.reverse()) if (exists(item.backup)) fs.renameSync(item.backup, item.original);
        for (const directory of created.reverse()) if (exists(directory) && within(bankBase, directory)) fs.rmSync(directory, { recursive: true });
        throw error;
      }
    }
  };
}
