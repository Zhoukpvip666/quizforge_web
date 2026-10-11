import path from 'node:path';
import { pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ApiError, bad, requireObject } from './errors.js';
import { integralField, jsonBytes } from './json.js';
import { exists, readJson, replaceFile } from './files.js';
import { decodeBase64 } from './resources.js';
import { hostKey, ipv6Bytes } from './network-addresses.js';
import { SerialTransactions } from './transactions.js';

const derive = promisify(pbkdf2), iterations = 210000;
export function normalizePublicUrl(value) {
  const message = '公网访问地址需为 http:// 或 https:// 域名／公网 IP 地址，IPv6 写成 http://[IPv6地址]:端口/，不包含路径、账号或查询参数。';
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_PUBLIC_URL', message); if (!value.trim()) return '';
  try {
    if (value.length > 500) throw new Error(); const parsed = new URL(value.trim()), host = parsed.hostname.replace(/^\[|\]$/g, ''), key = hostKey(host), bytes = ipv6Bytes(host);
    if (!['http:', 'https:'].includes(parsed.protocol) || !key || key === hostKey('::1') || key === hostKey('::') || key.startsWith('127.') || key === '0.0.0.0' || host === 'localhost' || host.endsWith('.localhost') || (bytes && (bytes[0] === 0xff || bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80)) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' || parsed.port === '0') throw new Error();
    return parsed.origin + '/';
  } catch { throw new ApiError(400, 'INVALID_PUBLIC_URL', message); }
}
function switches(request) { requireObject(request, 'Provide connection switches and a valid port'); if (typeof request.enabled !== 'boolean' || !integralField(request, 'port') || ['publicEnabled'].some(key => Object.hasOwn(request, key) && typeof request[key] !== 'boolean') || Object.hasOwn(request, 'publicUrl') && typeof request.publicUrl !== 'string') throw bad('Provide connection switches and a valid port'); }
const config = value => ({ ...value, get remoteEnabled() { return this.enabled || this.publicEnabled; }, get passwordConfigured() { return this.salt !== null && this.hash !== null; } });
export class NetworkSettings {
  constructor(root, defaultPort) {
    this.file = path.join(root, '.state', 'network-settings.json'); this.sessions = new Map(); this.attempts = new Map(); this.transactions = new SerialTransactions(); this.config = config({ enabled: false, publicEnabled: false, publicUrl: '', port: defaultPort, salt: null, hash: null });
    if (exists(this.file)) {
      const saved = readJson(this.file, 8192); switches(saved); if (saved.schemaVersion !== 1 || saved.port < 1024 || saved.port > 65535) throw new Error('Invalid network settings'); let salt = null, hash = null;
      if (Object.hasOwn(saved, 'password')) { if (saved.password.algorithm !== 'PBKDF2WithHmacSHA256' || saved.password.iterations !== iterations) throw new Error('Invalid connection password hash'); salt = decodeBase64(saved.password.salt); hash = decodeBase64(saved.password.hash); if (salt.length !== 16 || hash.length !== 32) throw new Error('Invalid connection password hash'); }
      const publicEnabled = saved.publicEnabled ?? false, publicUrl = normalizePublicUrl(saved.publicUrl ?? '');
      if (publicEnabled && !publicUrl || (saved.enabled || publicEnabled) && salt === null) throw new Error('Invalid saved remote access configuration');
      this.config = config({ enabled: saved.enabled, publicEnabled, publicUrl, port: saved.port, salt, hash });
    }
  }
  async candidate(request, localPort) {
    switches(request); if (request.port < 1024 || request.port > 65535 || request.port === localPort) throw bad('Connection port must be 1024..65535 and different from the local port');
    const publicEnabled = request.publicEnabled ?? this.config.publicEnabled, publicUrl = Object.hasOwn(request, 'publicUrl') ? normalizePublicUrl(request.publicUrl) : this.config.publicUrl;
    if (publicEnabled && !publicUrl) throw new ApiError(400, 'INVALID_PUBLIC_URL', '开启公网连接时请填写公网访问地址'); let salt = this.config.salt, hash = this.config.hash;
    if (Object.hasOwn(request, 'password')) {
      if (typeof request.password !== 'string') throw bad('Invalid password'); if (request.password.trim()) { if (request.password.length < 8 || request.password.length > 256) throw bad('Password must contain 8..256 characters'); salt = randomBytes(16); hash = await derive(request.password, salt, iterations, 32, 'sha256'); }
    }
    if ((request.enabled || publicEnabled) && hash === null) throw bad('Set a password before enabling remote access'); return config({ enabled: request.enabled, publicEnabled, publicUrl, port: request.port, salt, hash });
  }
  save(replacement) {
    const saved = { schemaVersion: 1, enabled: replacement.enabled, publicEnabled: replacement.publicEnabled, publicUrl: replacement.publicUrl, port: replacement.port };
    if (replacement.passwordConfigured) saved.password = { algorithm: 'PBKDF2WithHmacSHA256', iterations, salt: replacement.salt.toString('base64'), hash: replacement.hash.toString('base64') };
    replaceFile(this.file, jsonBytes(saved)); const before = this.config;
    if (['enabled', 'publicEnabled', 'publicUrl', 'port'].some(key => before[key] !== replacement[key]) || !(before.hash === replacement.hash || before.hash && replacement.hash && before.hash.equals(replacement.hash))) this.sessions.clear(); this.config = replacement;
  }
  limitLogin(peer) {
    const now = Date.now(); for (const [key, value] of this.attempts) if (now - value.start >= 60000) this.attempts.delete(key); const current = this.attempts.get(peer);
    if (current && current.count >= 6 || !current && this.attempts.size >= 256) throw new ApiError(429, 'LOGIN_RATE_LIMITED', 'Too many login attempts; try again in a minute'); this.attempts.set(peer, { start: current?.start ?? now, count: (current?.count ?? 0) + 1 });
  }
  async login(password, peer) {
    const profile = this.config; if (!profile.remoteEnabled || !profile.passwordConfigured) throw new ApiError(401, 'PASSWORD_REQUIRED', 'Remote access is not enabled'); this.limitLogin(peer);
    if (typeof password !== 'string' || password.length > 256 || !timingSafeEqual(profile.hash, await derive(password, profile.salt, iterations, 32, 'sha256')) || profile !== this.config) throw new ApiError(401, 'PASSWORD_REQUIRED', 'Incorrect connection password');
    const now = Date.now(); for (const [key, expires] of this.sessions) if (expires <= now) this.sessions.delete(key); if (this.sessions.size >= 128) this.sessions.clear(); const token = randomBytes(32).toString('base64url'); this.sessions.set(token, now + 12 * 60 * 60 * 1000); return token;
  }
  authenticated(token) { if (!this.config.remoteEnabled || !this.sessions.has(token)) return false; if (this.sessions.get(token) <= Date.now()) { this.sessions.delete(token); return false; } return true; }
  invalidateSessions() { this.sessions.clear(); }
}
