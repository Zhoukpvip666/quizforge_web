import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bad, requireObject } from '../platform/errors.js';
import { exists, readJson, replaceFile } from '../platform/files.js';
import { jsonBytes } from '../platform/json.js';
import { extensionPath, isUuid } from './identity.js';

export class ExtensionGroups {
  constructor(root) { this.file = path.join(root, '.state', 'extension-groups.json'); }
  read() {
    if (!exists(this.file)) return null;
    const value = requireObject(readJson(this.file, 1024 * 1024), 'Invalid extension groups');
    if (value.schemaVersion !== 1 || !Array.isArray(value.groups) || value.groups.length > 1000) throw bad('Invalid extension groups');
    const names = new Set(), ids = new Set();
    for (const group of value.groups) {
      if (!group || !isUuid(group.id) || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 120 || /[\/\\\x00-\x1f]/.test(group.name) || names.has(group.name) || ids.has(group.id) || !Array.isArray(group.members)) throw bad('Invalid extension group');
      names.add(group.name); ids.add(group.id);
      for (const member of group.members) extensionPath(member);
    }
    return value;
  }
  initial(rows, names = []) {
    const groups = new Map();
    for (const name of names) groups.set(name, { id: randomUUID(), name, members: [] });
    for (const row of rows) if (row.group) {
      if (!groups.has(row.group)) groups.set(row.group, { id: randomUUID(), name: row.group, members: [] });
      groups.get(row.group).members.push(row.referencePath ?? 'extensions/' + row.path);
    }
    return { schemaVersion: 1, groups: [...groups.values()] };
  }
  write(value) { replaceFile(this.file, jsonBytes(value)); }
  apply(catalog) {
    const value = this.read();
    if (!value) return catalog;
    catalog.groups.extensions = value.groups.map(group => group.name);
    catalog.extensions = catalog.extensions.flatMap(row => {
      const matches = value.groups.filter(group => group.members.includes(row.referencePath));
      const base = { ...row }; delete base.group;
      return matches.length ? matches.map(group => ({ ...base, group: group.name })) : [base];
    });
    return catalog;
  }
}
