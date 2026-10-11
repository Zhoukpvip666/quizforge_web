import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { ApiError, id, text } from './errors.js';
import { fingerprint, hash, integralField, jsonBytes, jsonEqual } from './json.js';
import { checkPath, exists, readBytes, readJson, replaceFile, safeDirectory, safeFile, walkFiles, within } from './files.js';
import { scanBanks, scanExtensions, bankItem } from './directories.js';
import { folderName } from './library-management.js';
import { markedDevelopment } from './extension-packages.js';
import { ResourceStore, imageReferences } from './resources.js';

export const MAX_UPLOAD = 64 * 1024 * 1024, MAX_EXPANDED = 128 * 1024 * 1024, MAX_FILE = 8 * 1024 * 1024, MAX_ENTRIES = 10000;
export const MANIFEST = 'quizforge-package.json', FORMAT = 'quizforge-bank-group', MIME = 'application/vnd.quizforge.qbank';
const invalid = message => new ApiError(422, 'INVALID_LIBRARY_ARCHIVE', message), conflict = message => new ApiError(409, 'LIBRARY_IMPORT_CONFLICT', message), limit = message => new ApiError(413, 'LIBRARY_ARCHIVE_LIMIT', message);
const relative = (base, file) => path.relative(base, file).replaceAll('\\', '/');
function privatePath(name) { return name.split('/').some(part => part.startsWith('.') || ['node_modules', 'target'].includes(part)); }
function binding(reference) { if (Object.hasOwn(reference, 'development')) throw invalid('题库引用开发版拓展，请先完成拓展发布再导出'); return id(reference, 'id') + '@' + id(reference, 'version'); }
function index(directory, extensions) {
  const result = new Map(); for (const file of extensions ? scanExtensions(directory) : scanBanks(directory).banks) {
    if (extensions && markedDevelopment(file)) continue; const raw = readJson(extensions ? path.join(file, 'manifest.json') : file, extensions ? 256 * 1024 : MAX_FILE), identity = extensions ? binding(raw) : id(raw, 'id');
    if (result.has(identity)) throw conflict('有重复题库或拓展 ID：' + identity); result.set(identity, file);
  } return result;
}
function declaredPaths(extension) {
  const result = new Set(), permit = name => { let file = safeFile(extension, name); while (file !== extension) { result.add(relative(extension, file)); file = path.dirname(file); } }, manifest = readJson(safeFile(extension, 'manifest.json'), 256 * 1024);
  for (const field of ['entry', 'script', 'style', 'rules', 'questionSchema', 'answerSchema', 'examples']) permit(text(manifest, field, 240)); for (const asset of manifest.assets ?? []) { if (typeof asset !== 'string') throw invalid('题库包的拓展文件声明无效'); permit(asset); }
  if (exists(path.join(extension, 'editor.json'))) { const editor = readJson(safeFile(extension, 'editor.json'), 256 * 1024); for (const field of ['entry', 'script', 'style']) permit(text(editor, field, 240)); } return result;
}
function signature(directory) { return Object.fromEntries(walkFiles(directory, MAX_ENTRIES + 1).filter(file => fs.statSync(file).isFile()).map(file => [relative(directory, file), file.endsWith('.json') ? fingerprint(readJson(file, MAX_FILE), 'archive-json') : hash(readBytes(file, MAX_FILE))])); }
function crcUpdate(crc, bytes) { for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return crc >>> 0; }
export class LibraryArchive {
  constructor(root, resources) { this.root = path.resolve(root); this.resources = resources; this.copiedBytes = 0; this.copiedEntries = 0; }
  workspace() { const base = path.join(this.root, '.temp'); safeDirectory(base, true); return fs.mkdtempSync(path.join(base, 'library-transfer-')); }
  removeWorkspace(work) { const base = path.join(this.root, '.temp'); if (path.dirname(work) !== base || !path.basename(work).startsWith('library-transfer-')) throw new Error('Invalid archive workspace'); for (const file of walkFiles(work, MAX_ENTRIES * 4 + 1)) { if (!within(work, file)) throw new Error('Unsafe archive workspace'); checkPath(file); } fs.rmSync(work, { recursive: true }); }
  account(file) { this.copiedBytes += fs.statSync(file).size; if (this.copiedBytes > MAX_EXPANDED) throw limit('复制内容超过 128 MiB，请缩小题库分组'); }
  copyTree(source, destination, declared = new Set()) {
    for (const file of walkFiles(source, MAX_ENTRIES + 1)) {
      const name = relative(source, file); if (privatePath(name) && !declared.has(name)) continue; if (++this.copiedEntries > MAX_ENTRIES) throw limit('复制文件数量超过上限'); checkPath(file); const target = path.resolve(destination, name); if (!within(destination, target)) throw invalid('目录路径越界');
      if (fs.lstatSync(file).isDirectory()) safeDirectory(target, true); else { if (fs.statSync(file).size > MAX_FILE) throw limit('目录中有过大的文件：' + name); this.account(file); safeDirectory(path.dirname(target), true); fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL); }
    }
  }
  exportImages(directory, document) {
    const suffix = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
    for (const id of imageReferences(document)) { const image = this.resources.read(id); if (exists(path.join(directory, 'assets', id + '.' + suffix[image.mime]))) continue; this.copiedBytes += image.bytes.length; if (this.copiedBytes > MAX_EXPANDED || ++this.copiedEntries > MAX_ENTRIES) throw limit('图片及文件超过导出大小或数量上限'); } this.resources.exportReferences(directory, document);
  }
  copyBank(file, destination) { if (path.basename(file) === 'bank.json' && path.dirname(file) !== path.join(this.root, 'question-banks')) this.copyTree(path.dirname(file), destination); else { safeDirectory(destination, true); this.account(file); fs.copyFileSync(file, path.join(destination, 'bank.json'), fs.constants.COPYFILE_EXCL); } this.exportImages(destination, readJson(path.join(destination, 'bank.json'), MAX_FILE)); }
  copyExtension(source, destination) { this.copyTree(source, destination, declaredPaths(source)); const manifest = readJson(path.join(destination, 'manifest.json'), 256 * 1024), examples = safeFile(destination, text(manifest, 'examples', 240)); this.exportImages(path.dirname(examples), readJson(examples, MAX_FILE)); }
  async zip(content, destination) {
    const archive = new yazl.ZipFile(); let total = 0, count = 0; const output = fs.createWriteStream(destination, { flags: 'wx' }); archive.on('error', error => archive.outputStream.destroy(error)); const writing = pipeline(archive.outputStream, output); writing.catch(() => {});
    try {
      for (const file of walkFiles(content, MAX_ENTRIES + 1).sort()) { if (file === content) continue; if (++count > MAX_ENTRIES) throw limit('导出文件数量超过上限'); const stat = fs.statSync(file), name = relative(content, file); if (stat.size > MAX_FILE && stat.isFile() || stat.isFile() && (total += stat.size) > MAX_EXPANDED) throw limit('导出内容超过大小上限'); if (stat.isDirectory()) archive.addEmptyDirectory(name); else archive.addFile(file, name); }
      archive.end(); await writing;
    } catch (error) { archive.outputStream.destroy(error); output.destroy(); await writing.catch(() => {}); throw error; }
  }
  async exportGroup(group) {
    folderName(group); const bankRoot = path.join(this.root, 'question-banks'), selected = path.join(bankRoot, group); if (!scanBanks(bankRoot).groups.includes(selected)) throw new ApiError(404, 'GROUP_NOT_FOUND', '题库分组已不存在，请刷新列表'); const work = this.workspace();
    try {
      const content = path.join(work, 'content'), banks = path.join(content, 'question-banks', group), extensions = path.join(content, 'extensions', group); safeDirectory(banks, true); safeDirectory(extensions, true); const installed = index(path.join(this.root, 'extensions'), true), required = new Set(), ids = new Set();
      for (const file of scanBanks(bankRoot).banks.filter(file => within(selected, file))) { const raw = readJson(file, MAX_FILE), bankId = id(raw, 'id'); if (ids.has(bankId)) throw invalid('分组内有重复题库 ID：' + bankId); ids.add(bankId); if (Object.hasOwn(raw, 'extension')) required.add(binding(raw.extension)); for (const question of raw.questions ?? []) if (Object.hasOwn(question, 'extension')) required.add(binding(question.extension)); this.copyBank(file, path.join(banks, bankId)); }
      for (const identity of required) { const source = installed.get(identity); if (!source) throw invalid('缺少正式拓展：' + identity + '；引用开发版的题库需先完成拓展发布'); this.copyExtension(source, path.join(extensions, identity)); }
      replaceFile(path.join(content, MANIFEST), jsonBytes({ format: FORMAT, formatVersion: 1, group })); const file = path.join(work, 'group.qbank'); await this.zip(content, file); if (fs.statSync(file).size > MAX_UPLOAD) throw limit('导出的题库包超过 64 MiB，请缩小题库分组'); return { workspace: work, file, close: () => this.removeWorkspace(work) };
    } catch (error) { this.removeWorkspace(work); throw error; }
  }
  async unzip(file, staging) {
    let archive, total = 0, count = 0; const seen = new Set();
    try {
      archive = await yauzl.openPromise(file, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
      for await (const entry of archive.eachEntry()) {
        if (++count > MAX_ENTRIES) throw limit('压缩包文件数量超过上限'); const directory = entry.fileName.endsWith('/'), name = directory ? entry.fileName.slice(0, -1) : entry.fileName, parts = name.split('/'), mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (parts.length > 32 || (!['question-banks', 'extensions'].includes(parts[0]) && !(parts.length === 1 && name === MANIFEST && !directory))) throw invalid('题库包顶层只允许格式标识、question-banks 和 extensions');
        if (parts.some(part => !part.trim() || ['.', '..'].includes(part) || /[\\:*?"<>|\x00-\x1f\x7f-\x9f]/.test(part) || /[ .]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(part)) || (entry.generalPurposeBitFlag & 1) || ![0, 0x8000, 0x4000].includes(mode) || mode === 0x4000 && !directory || mode === 0x8000 && directory) throw invalid('压缩包包含无效或越界路径');
        if (seen.has(name.toLowerCase())) throw invalid('压缩包包含重复路径'); seen.add(name.toLowerCase()); const target = path.resolve(staging, name); if (!within(staging, target)) throw invalid('压缩包路径越界');
        if (directory) { safeDirectory(target, true); continue; }
        if (entry.uncompressedSize > MAX_FILE) throw limit('压缩包单个文件超过 8 MiB'); safeDirectory(path.dirname(target), true); let bytes = 0, crc = 0xffffffff;
        const stream = await archive.openReadStreamPromise(entry), bound = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; if (bytes > MAX_FILE || total + bytes > MAX_EXPANDED) return callback(limit('压缩包超过解压大小上限')); crc = crcUpdate(crc, chunk); callback(null, chunk); } });
        await pipeline(stream, bound, fs.createWriteStream(target, { flags: 'wx' })); if (((crc ^ 0xffffffff) >>> 0) !== (entry.crc32 >>> 0)) throw invalid('压缩包文件校验失败'); total += bytes;
      }
    } catch (error) { if (error instanceof ApiError) throw error; throw invalid('压缩包损坏或不是有效的 ZIP 文件'); } finally { archive?.close(); }
  }
  archiveGroup(staging) {
    let manifest; try { manifest = readJson(path.join(staging, MANIFEST), 256 * 1024); } catch { throw invalid('不是 QuizForge 题库包：缺少或损坏的格式标识'); }
    if (manifest?.format !== FORMAT) throw invalid('不是 QuizForge 题库包：格式标识不正确'); if (!integralField(manifest, 'formatVersion') || manifest.formatVersion !== 1) throw invalid('不支持此题库包版本，请升级应用'); let group = null;
    for (const kind of ['question-banks', 'extensions']) {
      const directory = path.join(staging, kind); if (!exists(directory) || !fs.lstatSync(directory).isDirectory()) throw invalid('题库包顶层必须包含 question-banks 和 extensions 两个文件夹'); const children = fs.readdirSync(directory); if (children.length !== 1) throw invalid('每个顶层文件夹必须只包含一个分组'); const child = path.join(directory, children[0]); checkPath(child, { directory: true });
      if (['bank.json', 'manifest.json', 'development.json'].some(name => exists(path.join(child, name)))) throw invalid('顶层目录必须是分组，不能是单个题库或拓展'); folderName(children[0]); if (group !== null && group !== children[0]) throw invalid('题库分组和拓展分组必须同名'); group = children[0];
    }
    if (group !== manifest.group) throw invalid('格式标识中的分组与目录不一致'); return group;
  }
  validatePrivatePaths(staging, banks, extensions) {
    const leaves = new Set(), declared = new Set();
    for (const extension of extensions) { leaves.add(extension); for (const name of declaredPaths(extension)) declared.add(path.resolve(extension, name)); }
    for (const bank of banks) { const item = bankItem(path.join(staging, 'question-banks'), bank); if (fs.lstatSync(item).isDirectory()) leaves.add(item); declared.add(bank); }
    for (const file of walkFiles(staging, MAX_ENTRIES + 1)) { const parts = relative(staging, file).split('/'); if (parts.length <= 2) continue; let base = path.resolve(staging, ...parts.slice(0, 2)); const leaf = path.resolve(staging, ...parts.slice(0, 3)); if (leaves.has(leaf)) base = leaf; if (privatePath(relative(base, file)) && !declared.has(file)) throw invalid('题库包包含未声明的私有文件或目录'); }
  }
  checkGroupDestination(kind, destination) { if (!exists(destination)) return; checkPath(destination); const group = kind === 'bank' ? scanBanks(path.join(this.root, 'question-banks')).groups.includes(destination) : fs.lstatSync(destination).isDirectory() && !['manifest.json', 'development.json'].some(name => exists(path.join(destination, name))); if (!group) throw conflict('分组名称与现有题库或拓展目录冲突：' + path.basename(destination)); }
  async importPackage(input, validator) {
    const work = this.workspace();
    try {
      const zip = path.join(work, 'upload.qbank'), staging = path.join(work, 'content'); let uploaded = 0;
      const bound = new Transform({ transform(chunk, encoding, callback) { if ((uploaded += chunk.length) > MAX_UPLOAD) return callback(limit('压缩包超过上传大小上限')); callback(null, chunk); } }); await pipeline(Buffer.isBuffer(input) ? Readable.from([input]) : input, bound, fs.createWriteStream(zip, { flags: 'wx' })); safeDirectory(staging, true); await this.unzip(zip, staging); const group = this.archiveGroup(staging), incomingBanks = scanBanks(path.join(staging, 'question-banks')).banks, incomingExtensions = scanExtensions(path.join(staging, 'extensions'));
      if (incomingExtensions.some(markedDevelopment)) throw invalid('第一版题库包导入只支持正式拓展，请先完成拓展发布'); try { this.validatePrivatePaths(staging, incomingBanks, incomingExtensions); } catch (error) { if (error instanceof ApiError && error.status !== 400) throw error; throw invalid('题库包的拓展文件声明无效或不完整'); }
      await validator(staging); const stagedResources = new ResourceStore(staging);
      for (const file of incomingBanks) stagedResources.exportReferences(path.dirname(file), readJson(file, MAX_FILE));
      for (const extension of incomingExtensions) { const manifest = readJson(path.join(extension, 'manifest.json'), 256 * 1024), file = safeFile(extension, text(manifest, 'examples', 240)); stagedResources.exportReferences(path.dirname(file), readJson(file, MAX_FILE)); }
      const localBanks = index(path.join(this.root, 'question-banks'), false), localExtensions = index(path.join(this.root, 'extensions'), true), newBanks = index(path.join(staging, 'question-banks'), false), newExtensions = index(path.join(staging, 'extensions'), true), moves = []; let skippedBanks = 0, skippedExtensions = 0;
      const targetBanks = path.join(this.root, 'question-banks', group), targetExtensions = path.join(this.root, 'extensions', group); this.checkGroupDestination('bank', targetBanks); this.checkGroupDestination('extension', targetExtensions);
      for (const [identity, file] of newBanks) {
        const source = bankItem(path.join(staging, 'question-banks'), file), existing = localBanks.get(identity);
        if (existing) { const normalized = path.join(work, 'compare-bank-' + skippedBanks), candidate = path.join(work, 'incoming-bank-' + skippedBanks); this.copyBank(existing, normalized); new LibraryArchive(staging, stagedResources).copyBank(file, candidate); if (!jsonEqual(signature(normalized), signature(candidate))) throw conflict('题库 ID 相同但内容不同：' + identity); skippedBanks++; continue; }
        const destination = path.join(targetBanks, path.basename(source)); if (exists(destination)) throw conflict('目标分组已有同名文件或目录：' + path.basename(destination)); moves.push({ source, destination });
      }
      for (const [identity, source] of newExtensions) {
        const existing = localExtensions.get(identity);
        if (existing) { const normalized = path.join(work, 'compare-extension-' + skippedExtensions); this.copyExtension(existing, normalized); if (!jsonEqual(signature(normalized), signature(source))) throw conflict('拓展 ID 和版本相同但内容不同：' + identity); skippedExtensions++; continue; }
        const destination = path.join(targetExtensions, path.basename(source)); if (exists(destination)) throw conflict('目标分组已有同名文件或目录：' + path.basename(destination)); moves.push({ source, destination });
      }
      const created = [], committed = [];
      try {
        for (const directory of [path.join(this.root, 'question-banks'), path.join(this.root, 'extensions'), targetBanks, targetExtensions]) { if (!exists(directory)) { fs.mkdirSync(directory); created.push(directory); } checkPath(directory, { directory: true }); }
        for (const move of moves) { fs.renameSync(move.source, move.destination); committed.push(move); }
      } catch (error) { for (const move of committed.reverse()) try { fs.renameSync(move.destination, move.source); } catch {} for (const directory of created.reverse()) try { fs.rmdirSync(directory); } catch {} throw error; }
      return { group, importedBanks: newBanks.size - skippedBanks, importedExtensions: newExtensions.size - skippedExtensions, skippedBanks, skippedExtensions };
    } finally { this.removeWorkspace(work); }
  }
}
