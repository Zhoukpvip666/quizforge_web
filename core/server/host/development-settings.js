import path from 'node:path';
import { ApiError, bad, requireObject } from './errors.js';
import { exists, readJson, replaceFile, safeDirectory } from './files.js';
import { jsonBytes } from './json.js';

export class DevelopmentSettings {
  constructor(root) {
    this.file = path.join(root, '.state', 'development-settings.json');
    safeDirectory(path.dirname(this.file)); this.enabled = false;
    if (exists(this.file)) {
      const value = readJson(this.file, 4096);
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || typeof value.enabled !== 'boolean') throw new Error('Invalid developer settings');
      this.enabled = value.enabled;
    }
  }
  status(canManage) { return { enabled: this.enabled, canManage }; }
  update(request) {
    requireObject(request, 'Developer settings require enabled');
    if (Object.keys(request).length !== 1 || typeof request.enabled !== 'boolean') throw bad('Developer settings require enabled');
    replaceFile(this.file, jsonBytes({ schemaVersion: 1, enabled: request.enabled }));
    this.enabled = request.enabled; return this.status(true);
  }
  requireEnabled() { if (!this.enabled) throw new ApiError(404, 'DEVELOPMENT_DISABLED', 'Enable developer mode on the host computer first'); }
}
