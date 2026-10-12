import fs from 'node:fs';
import path from 'node:path';
import { checkedStat, readBytes } from './files.js';
import { fingerprint, hash, parseJson } from './json.js';

export function statIdentity(stat) {
  if (!stat.isFile()) throw new Error('Expected a regular file');
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
}
export function fileIdentity(file) { return statIdentity(checkedStat(file, { bigint: true }).stat); }
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** Cache immutable inputs, never mutable state. Every hit checks file identity. */
export class FileCache {
  constructor({ count = 256, bytes = 32 * 1024 * 1024 } = {}) { this.count = count; this.limit = bytes; this.entries = new Map(); this.bytes = 0; }
  entry(file, max) {
    file = path.resolve(file);
    const identity = fileIdentity(file), cached = this.entries.get(file);
    if (cached?.identity === identity) {
      if (cached.size > max) throw new Error('File exceeds the size limit');
      this.entries.delete(file); this.entries.set(file, cached); return cached;
    }
    if (cached) { this.entries.delete(file); this.bytes -= cached.size; }
    const content = readBytes(file, max), after = fileIdentity(file);
    if (identity !== after) throw new Error('File changed while reading');
    const entry = { identity, size: content.length, hash: hash(content), content, fingerprints: new Map() };
    if (entry.size <= this.limit) {
      this.entries.set(file, entry); this.bytes += entry.size;
      while (this.entries.size > this.count || this.bytes > this.limit) { const [oldFile, old] = this.entries.entries().next().value; this.entries.delete(oldFile); this.bytes -= old.size; }
    }
    return entry;
  }
  json(file, max = 8 * 1024 * 1024) { const entry = this.entry(file, max); if (!Object.hasOwn(entry, 'value')) { entry.value = freeze(parseJson(entry.content)); entry.content = null; } return entry.value; }
  jsonFingerprint(file, namespace, max = 8 * 1024 * 1024) {
    const value = this.json(file, max), entry = this.entries.get(path.resolve(file));
    if (!entry) return fingerprint(value, namespace);
    if (!entry.fingerprints.has(namespace)) entry.fingerprints.set(namespace, fingerprint(value, namespace));
    return entry.fingerprints.get(namespace);
  }
  hash(file, max = 8 * 1024 * 1024) { return this.entry(file, max).hash; }
  clear() { this.entries.clear(); this.bytes = 0; }
}
