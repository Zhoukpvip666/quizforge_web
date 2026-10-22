import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../platform/errors.js';
import { replaceFile, safeDirectory } from '../platform/files.js';
import { jsonBytes } from '../platform/json.js';
import { archiveMove } from './archive-move.js';

const relative = (base, item) => path.relative(base, item).replaceAll('\\', '/');

// Archive only the selected bank or group. Extension cleanup is a separate
// operation; deleting a bank must not scan other banks or their dependencies.
export function removeBank(root, source, target, sourcePath) {
  const receipt = path.join(safeDirectory(path.join(root, '.trash', 'library'), true), randomUUID());
  fs.mkdirSync(receipt); fs.mkdirSync(path.join(receipt, 'content'));
  const moves = [{ source, destination: path.join(receipt, 'content', path.basename(source)) }];
  const record = { kind: 'bank', target, path: sourcePath, deletedAt: new Date().toISOString(),
    moves: moves.map(move => ({ from: relative(root, move.source), to: relative(root, move.destination) })),
    removedExtensionGroups: [], retainedExtensionGroups: [] };
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
    retainedExtensionGroups: record.retainedExtensionGroups };
}
