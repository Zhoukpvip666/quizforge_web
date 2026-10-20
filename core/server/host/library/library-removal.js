import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../platform/errors.js';
import { checkPath, readJson, replaceFile, safeDirectory, walkFiles, within } from '../platform/files.js';
import { jsonBytes } from '../platform/json.js';
import { scanBanks, scanExtensions } from './directories.js';
import { eachReference } from './identity.js';
import { archiveMove } from './archive-move.js';

const relative = (base, item) => path.relative(base, item).replaceAll('\\', '/');

// A bank can move independently of its extensions. Resolve the actual bindings,
// never infer a paired group from the bank's current folder name.
export function bankRemovalPlan(root, source) {
  const extensionBase = path.join(root, 'extensions'), candidates = new Set(), remaining = new Set();
  const groups = new Map(scanExtensions(extensionBase).map(directory => [relative(root, directory), path.dirname(directory)]));
  let unknown = false;
  for (const file of scanBanks(path.join(root, 'question-banks')).banks) {
    const removing = within(source, file);
    try {
      const raw = readJson(file, 8 * 1024 * 1024);
      eachReference(raw, (_owner, reference) => {
        const group = groups.get(reference?.path);
        if (group && path.dirname(group) === extensionBase) (removing ? candidates : remaining).add(group);
        else if (!removing) unknown = true;
      });
    } catch { if (!removing) unknown = true; }
  }
  const remove = [], retain = [];
  for (const group of candidates) {
    if (unknown || remaining.has(group)) retain.push(path.basename(group));
    else { checkPath(group, { directory: true }); walkFiles(group, 20000); remove.push(group); }
  }
  return { remove, retain, unknown };
}

export function removeBank(root, source, target, sourcePath) {
  const plan = bankRemovalPlan(root, source);
  const receipt = path.join(safeDirectory(path.join(root, '.trash', 'library'), true), randomUUID());
  fs.mkdirSync(receipt); fs.mkdirSync(path.join(receipt, 'content')); fs.mkdirSync(path.join(receipt, 'extensions'));
  const moves = [{ source, destination: path.join(receipt, 'content', path.basename(source)) },
    ...plan.remove.map(source => ({ source, destination: path.join(receipt, 'extensions', path.basename(source)) }))];
  const record = { kind: 'bank', target, path: sourcePath, deletedAt: new Date().toISOString(),
    moves: moves.map(move => ({ from: relative(root, move.source), to: relative(root, move.destination) })),
    removedExtensionGroups: plan.remove.map(directory => path.basename(directory)), retainedExtensionGroups: plan.retain };
  const write = status => replaceFile(path.join(receipt, 'receipt.json'), jsonBytes({ ...record, status }));
  write('prepared'); const completed = [];
  try {
    for (const move of moves) { archiveMove(root, move.source, move.destination); completed.push(move); }
    write('complete');
  } catch (error) {
    try { for (const move of completed.reverse()) fs.renameSync(move.destination, move.source); write('rolled-back'); }
    catch (recoveryError) {
      write('recovery-required');
      throw new ApiError(503, 'LIBRARY_RECOVERY_REQUIRED', '删除未完成，部分文件保存在 ' + relative(root, receipt) + '，请保留此回收目录并恢复。', { cause: recoveryError });
    }
    throw error;
  }
  return { archivedTo: relative(root, receipt), removedExtensionGroups: record.removedExtensionGroups,
    retainedExtensionGroups: plan.retain, ...(plan.unknown && plan.retain.length ? { cleanupWarning: '其他题库的拓展引用无法确认，已保留配套拓展组。' } : {}) };
}
