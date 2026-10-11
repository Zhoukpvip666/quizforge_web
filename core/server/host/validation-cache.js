import fs from 'node:fs';
import path from 'node:path';
import { exists, readJson, replaceFile, safeDirectory } from './files.js';
import { cloneJson, fingerprint, jsonBytes } from './json.js';
import { readOutlineItems } from './outline.js';

export class ValidationCache {
  constructor(root) { this.directory = path.join(path.resolve(root), '.state', 'validation-cache', 'v1'); }
  read(key, questionCount) {
    if (!/^[a-f0-9]{64}$/.test(key ?? '') || questionCount < 1 || questionCount > 10000) return null;
    try {
      safeDirectory(this.directory);
      const file = path.join(this.directory, key + '.json');
      if (!exists(file)) return null;
      const value = readJson(file, 2 * 1024 * 1024), rows = value?.outlineItems;
      if (!value || Object.keys(value).length !== 4 || value.protocol !== 'quizforge-validation-v1' || value.key !== key || !Array.isArray(rows) || rows.length !== questionCount || value.checksum !== fingerprint(rows, key)) return null;
      return { outlineItems: rows.map(readOutlineItems) };
    } catch { return null; }
  }
  write(key, check) {
    if (!/^[a-f0-9]{64}$/.test(key ?? '')) return;
    try {
      const outlineItems = cloneJson(check.outlineItems), encoded = jsonBytes({ protocol: 'quizforge-validation-v1', key, checksum: fingerprint(outlineItems, key), outlineItems });
      if (encoded.length > 2 * 1024 * 1024) return;
      safeDirectory(this.directory, true);
      const target = path.join(this.directory, key + '.json');
      replaceFile(target, encoded);
      const files = fs.readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
        const file = path.join(this.directory, name), stat = fs.lstatSync(file);
        return { file, stat };
      }).filter(item => item.stat.isFile() && !item.stat.isSymbolicLink()).sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs);
      let count = files.length, bytes = files.reduce((sum, item) => sum + item.stat.size, 0);
      for (const item of files) {
        if (count <= 2048 && bytes <= 32 * 1024 * 1024) break;
        if (item.file === target) continue;
        fs.unlinkSync(item.file); count--; bytes -= item.stat.size;
      }
    } catch { /* Cache availability never replaces actual validation. */ }
  }
}
