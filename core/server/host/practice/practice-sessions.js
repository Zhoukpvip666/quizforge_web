import { ApiError, bad } from '../platform/errors.js';
import { SerialTransactions } from '../platform/transactions.js';

export class PracticeSessions {
  constructor(factory, { now = () => performance.now() } = {}) { this.factory = factory; this.now = now; this.sessions = new Map(); this.transactions = new SerialTransactions(); }
  bytes() { return [...this.sessions.values()].reduce((count, value) => count + value.session.bytes(), 0); }
  expire() { const now = this.now(); for (const [key, value] of this.sessions) if (value.active === 0 && now - value.touched > 30 * 60 * 1000) { this.sessions.delete(key); value.session.close(); } }
  acquire(id, create, writing) {
    return this.transactions.run(async () => {
      this.expire(); if (!id?.trim()) { if (create) throw new ApiError(409, 'PRACTICE_SESSION_REQUIRED', "Temporary practice requires this browser page's session ID"); return null; }
      if (!/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(id)) throw bad('Invalid practice session ID');
      const full = () => { throw new ApiError(429, 'PRACTICE_SESSION_LIMIT', 'Temporary practice capacity is full; existing answers are preserved. Close idle pages and retry later'); };
      let value = this.sessions.get(id); if (writing && this.bytes() > 224 * 1024 * 1024) full();
      if (!value && create) { if (this.sessions.size >= 32 || this.bytes() > 224 * 1024 * 1024) full(); value = { session: await this.factory(), active: 0, touched: this.now() }; this.sessions.set(id, value); }
      if (!value) return null; value.active++; value.touched = this.now(); let closed = false;
      return { session: value.session, close: () => { if (closed) return; closed = true; value.active--; value.touched = this.now(); } };
    });
  }
  close() { for (const value of this.sessions.values()) value.session.close(); this.sessions.clear(); }
}
