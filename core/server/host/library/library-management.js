import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError, bad, text, requireObject } from '../platform/errors.js';
import { checkPath, exists, readBytes, readJson, replaceFile, safeDirectory, safeFile, walkFiles, within } from '../platform/files.js';
import { cloneJson, jsonBytes } from '../platform/json.js';
import { bankItem, scanBanks, scanExtensions } from './directories.js';
import { markedDevelopment } from '../extensions/extension-packages.js';

const relative = (base, item) => path.relative(base, item).replaceAll('\\', '/');
const labelKey = row => row.kind === 'development' ? 'development:' + row.id : row.id + '@' + row.version;
export function folderName(name) {
  if (['bank.json', 'manifest.json', 'development.json'].includes(name.toLowerCase())) throw bad('此名称用于题库或拓展文件，不能作为分组名称');
  if (name.length > 120 || /[\\/:*?"<>|\x00-\x1f\x7f-\x9f]/.test(name) || name.endsWith('.') || ['.', '..'].includes(name) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(name)) throw bad('分组名称不能包含路径、特殊字符或 Windows 保留名称');
}
export class LibraryManagement {
  constructor(root) { this.root = path.resolve(root); this.labelsFile = path.join(this.root, '.state', 'library-labels.json'); }
  base(kind) { return path.join(this.root, kind === 'bank' ? 'question-banks' : 'extensions'); }
  labels() { return exists(this.labelsFile) ? requireObject(readJson(this.labelsFile, 1024 * 1024), 'Invalid library labels') : {}; }
  groups(kind) {
    if (kind === 'bank') return scanBanks(this.base(kind)).groups;
    const base = this.base(kind), leaves = new Set(scanExtensions(base));
    if (!exists(base)) return [];
    return fs.readdirSync(base).sort().map(name => path.join(base, name)).filter(item => fs.lstatSync(item).isDirectory() && !leaves.has(item)).map(item => checkPath(item));
  }
  catalog(source) {
    try {
      const result = cloneJson(source), labels = this.labels();
      result.groups = { banks: this.groups('bank').map(item => relative(this.base('bank'), item)), extensions: this.groups('extension').map(item => relative(this.base('extension'), item)) };
      for (const row of result.extensions ?? []) {
        const label = labels[labelKey(row)];
        if (typeof label === 'string') { row.name = label; row.displayName = label; if (Object.hasOwn(row, 'title')) row.title = label; }
      }
      return result;
    } catch (error) { throw new ApiError(503, 'LIBRARY_UNAVAILABLE', '无法读取目录设置', { cause: error }); }
  }
  resolve(base, value) {
    if (typeof value !== 'string' || value.includes('\\') || value.includes(':') || value.includes('\0') || path.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw bad('Invalid library path');
    const result = path.resolve(base, value);
    if (result === base || !within(base, result)) throw bad('Invalid library path');
    checkPath(result); return result;
  }
  requireUnused(removed) {
    const formal = new Set(), development = new Set();
    for (const extension of scanExtensions(this.base('extension')).filter(directory => within(removed, directory))) {
      if (markedDevelopment(extension)) development.add(path.basename(extension));
      else { const manifest = readJson(safeFile(extension, 'manifest.json'), 256 * 1024); formal.add(manifest.id + '@' + manifest.version); }
    }
    const used = [];
    const matches = reference => reference && (formal.has(reference.id + '@' + reference.version) || development.has(reference.development));
    for (const bank of scanBanks(this.base('bank')).banks) {
      let raw;
      try { raw = readJson(bank, 8 * 1024 * 1024); }
      catch { throw new ApiError(409, 'BANK_DEPENDENCIES_UNKNOWN', '请先修复无法读取的题库，再删除拓展：' + relative(this.base('bank'), bank)); }
      if (matches(raw.extension) || (raw.questions ?? []).some(question => matches(question.extension))) used.push(raw.title ?? relative(this.base('bank'), bank));
    }
    if (used.length) throw new ApiError(409, 'EXTENSION_IN_USE', '仍被以下题库使用，不能删除：' + used.join('、'));
  }
  change(request, catalog) {
    requireObject(request);
    const kind = text(request, 'kind', 20), action = text(request, 'action', 20), target = text(request, 'target', 20);
    if (!['bank', 'extension'].includes(kind) || !['create', 'update', 'delete'].includes(action) || !['item', 'group'].includes(target)) throw bad('Invalid library operation');
    if (Object.keys(request).some(key => !['kind', 'action', 'target', 'path', 'name', 'group'].includes(key))) throw bad('Unknown library field');
    const base = checkPath(this.base(kind), { directory: true });
    if (action === 'create' && target !== 'group') throw bad('Only groups can be created here');
    const sourcePath = action === 'create' ? '' : text(request, 'path', 1000), source = sourcePath ? this.resolve(base, sourcePath) : null;
    let row = null;
    if (source) {
      if (target === 'group') { if (!this.groups(kind).includes(source)) throw new ApiError(404, 'GROUP_NOT_FOUND', '分组已不存在，请刷新列表'); }
      else {
        row = catalog[kind === 'bank' ? 'banks' : 'extensions'].find(row => row.path === sourcePath);
        if (!row) throw new ApiError(404, 'ITEM_NOT_FOUND', '目录项目已不存在，请刷新列表');
      }
      if (fs.lstatSync(source).isDirectory()) walkFiles(source, 20000); else checkPath(source);
    }
    if (action === 'delete') {
      if (kind === 'extension') this.requireUnused(source);
      const receipt = path.join(safeDirectory(path.join(this.root, '.trash', 'library'), true), randomUUID());
      fs.mkdirSync(receipt);
      replaceFile(path.join(receipt, 'receipt.json'), jsonBytes({ kind, target, path: sourcePath, deletedAt: new Date().toISOString() }));
      fs.mkdirSync(path.join(receipt, 'content')); fs.renameSync(source, path.join(receipt, 'content', path.basename(source)));
      return { archivedTo: relative(this.root, receipt) };
    }
    const name = text(request, 'name', 300).trim(); if (!name) throw bad('名称不能为空');
    const group = Object.hasOwn(request, 'group') ? request.group : '';
    if (typeof group !== 'string') throw bad('Invalid group');
    if (target === 'group' && group) throw bad('分组只支持一层，不能移入其他分组');
    const parent = group ? this.resolve(base, group) : base;
    if (parent !== base && !this.groups(kind).includes(parent)) throw bad('请选择现有分组');
    let filename;
    if (target === 'group') { folderName(name); filename = name; }
    else {
      filename = path.basename(source);
      if (kind === 'bank' && fs.lstatSync(source).isFile() && filename === 'bank.json' && parent !== base) filename = (row.id ?? 'bank') + '.questions.json';
    }
    const destination = path.join(parent, filename);
    if (destination !== source && exists(destination)) throw new ApiError(409, 'LIBRARY_TARGET_EXISTS', '目标分组已有同名文件或文件夹');
    if (!source) {
      if (this.groups(kind).length + (kind === 'extension' ? scanExtensions(base).length : 0) >= 1000) throw bad('目录数量已达到上限');
      fs.mkdirSync(destination); return {};
    }
    let nameFile, before, labels;
    if (target === 'item') {
      if (kind === 'bank') {
        nameFile = fs.lstatSync(source).isDirectory() ? path.join(source, 'bank.json') : source;
        before = readBytes(nameFile, 8 * 1024 * 1024); const raw = requireObject(readJson(nameFile, 8 * 1024 * 1024)); raw.title = name;
        replaceFile(nameFile, jsonBytes(raw));
      } else { labels = this.labels(); Object.defineProperty(labels, labelKey(row), { value: name, configurable: true, enumerable: true, writable: true }); }
    }
    try { if (source !== destination) fs.renameSync(source, destination); }
    catch (error) { if (before) replaceFile(nameFile, before); throw error; }
    if (labels) {
      try { replaceFile(this.labelsFile, jsonBytes(labels)); }
      catch (error) { if (source !== destination) fs.renameSync(destination, source); throw error; }
    }
    return { path: relative(base, destination) };
  }
}
