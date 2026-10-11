import { ApiError, bad, requireObject } from './errors.js';

export class BankFeatures {
  constructor({ editing = true, whiteboard = true, history = true, exam = true } = {}) {
    Object.assign(this, { editing, whiteboard, history, exam });
    Object.freeze(this);
  }
  static read(bank) {
    if (!Object.hasOwn(bank, 'features')) return new BankFeatures();
    const value = requireObject(bank.features, 'features must be an object of editing, whiteboard, history and exam booleans');
    for (const key of Object.keys(value)) if (!['editing', 'whiteboard', 'history', 'exam'].includes(key) || typeof value[key] !== 'boolean') throw bad(`Unknown or non-boolean bank feature: ${key}`);
    return new BankFeatures(value);
  }
  json() { return { ...this }; }
  requireEditing() { if (!this.editing) throw new ApiError(403, 'EDITING_DISABLED', 'This collection disables editing'); }
  requireWhiteboard() { if (!this.whiteboard) throw new ApiError(403, 'WHITEBOARD_DISABLED', 'This collection disables the whiteboard'); }
  requireHistory() { if (!this.history) throw new ApiError(403, 'HISTORY_DISABLED', 'This collection keeps practice only in the current page session'); }
}
