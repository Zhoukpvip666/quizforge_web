import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from '../platform/errors.js';
import { checkPath, exists } from '../platform/files.js';

export function scanBanks(root) {
  const banks = [], groups = [];
  if (!exists(root)) return { banks, groups };
  function visit(directory, depth) {
    checkPath(directory, { directory: true });
    const bank = path.join(directory, 'bank.json');
    if (depth > 0 && exists(bank)) {
      if (depth > 2) throw new Error(`题库分组只支持一层：${directory}`);
      checkPath(bank);
      if (!fs.lstatSync(bank).isFile()) throw new Error('bank.json must be a file');
      banks.push(bank); return;
    }
    if (depth > 1) throw new Error(`题库分组只支持一层：${directory}`);
    if (groups.length >= 1000) throw new Error('题库分组数量不能超过 1000');
    if (depth > 0) groups.push(directory);
    const entries = fs.readdirSync(directory).sort();
    if (entries.length > 2000) throw new Error('分组中的文件数量不能超过 2000');
    for (const name of entries) {
      const item = path.join(directory, name), stat = fs.lstatSync(item);
      if (stat.isSymbolicLink()) throw new Error('题库目录不能包含链接');
      if (stat.isDirectory()) visit(item, depth + 1);
      else if (name.endsWith('.json') && !name.startsWith('.')) { checkPath(item); banks.push(item); }
      if (banks.length > 1000) throw new Error('题库数量不能超过 1000');
    }
  }
  try { visit(path.resolve(root), 0); return { banks, groups }; }
  catch (error) { throw new ApiError(422, 'INVALID_BANK_DIRECTORIES', error.message, { cause: error }); }
}
export function bankItem(base, bank) { return path.basename(bank) === 'bank.json' && path.dirname(bank) !== path.resolve(base) ? path.dirname(bank) : bank; }
export function scanExtensions(root) {
  const leaves = [];
  if (!exists(root)) return leaves;
  let visited = 0;
  function visit(directory, depth) {
    checkPath(directory, { directory: true });
    if (depth > 0 && (exists(path.join(directory, 'manifest.json')) || exists(path.join(directory, 'development.json')))) {
      if (depth > 2 || leaves.length >= 200) throw new Error('Extension directory depth or count exceeds the limit');
      leaves.push(directory); return;
    }
    if (depth > 1) throw new Error('拓展分组只支持一层');
    for (const name of fs.readdirSync(directory).sort()) {
      const item = path.join(directory, name), stat = fs.lstatSync(item);
      if (!stat.isSymbolicLink() && !stat.isDirectory()) continue;
      if (++visited > 1000) throw new Error('Too many extension directories');
      visit(item, depth + 1);
    }
  }
  try { visit(path.resolve(root), 0); return leaves; }
  catch (error) { throw new ApiError(422, 'INVALID_EXTENSION_DIRECTORIES', error.message, { cause: error }); }
}
export function extensionGroup(base, directory) { return path.relative(checkPath(base, { directory: true }), path.dirname(checkPath(directory, { directory: true }))).replaceAll('\\', '/'); }
