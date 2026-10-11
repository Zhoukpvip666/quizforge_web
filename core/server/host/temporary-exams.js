import { ApiError, bad } from './errors.js';

export function requireOwner(owner) { if (!owner?.trim()) throw new ApiError(409, 'PRACTICE_SESSION_REQUIRED', "Temporary exams require this browser page's session ID"); if (!/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(owner)) throw bad('Invalid practice session ID'); }
const limit = () => { throw new ApiError(429, 'PRACTICE_SESSION_LIMIT', 'Temporary exam capacity is full; existing answers are preserved. Delete unused attempts or retry after idle pages expire'); };
export class TemporaryExamSessions {
  constructor(now = () => Date.now()) { this.now = now; this.entries = new Map(); }
  runtime(id) { return this.entries.get(id)?.runtime ?? null; }
  contains(id) { return this.runtime(id) !== null; }
  bytes() { return [...this.entries.values()].reduce((sum, value) => sum + value.snapshotBytes + (value.runtime?.bytes() ?? 0), 0); }
  checkAdmission(snapshotBytes) { if ([...this.entries.values()].filter(value => value.runtime).length >= 32 || this.bytes() + snapshotBytes > 224 * 1024 * 1024) limit(); }
  add(id, owner, runtime, snapshotBytes) { requireOwner(owner); this.checkAdmission(snapshotBytes); this.entries.set(id, { owner, runtime, snapshotBytes, touched: this.now() }); }
  touchPage(owner, writing) { if (owner === null || owner === undefined) return; requireOwner(owner); if (writing && this.bytes() > 224 * 1024 * 1024) limit(); for (const value of this.entries.values()) if (value.owner === owner) value.touched = this.now(); }
  access(id, owner, writing) { requireOwner(owner); const entry = this.entries.get(id); if (!entry?.runtime || entry.owner !== owner) throw new ApiError(404, 'COLLECTION_NOT_FOUND', '此临时考试属于另一个页面会话或已过期。'); this.touchPage(owner, writing); }
  expire(invalidate) { const expired = [...this.entries].filter(([, value]) => this.now() - value.touched >= 30 * 60 * 1000); for (const [id, entry] of expired) { this.entries.delete(id); invalidate(id); entry.runtime?.close(); } }
  deleted(id, snapshotBytes, invalidate) { const entry = this.entries.get(id); if (!entry) return; entry.runtime?.close(); entry.runtime = null; entry.snapshotBytes = snapshotBytes; entry.touched = this.now(); const deletions = [...this.entries].filter(([, value]) => !value.runtime); for (const [id] of deletions.slice(0, Math.max(0, deletions.length - 256))) { this.entries.delete(id); invalidate(id); } }
  discard(id) { this.entries.get(id)?.runtime?.close(); this.entries.delete(id); }
  close() { for (const value of this.entries.values()) value.runtime?.close(); this.entries.clear(); }
}
