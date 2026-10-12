export class ApiError extends Error {
  constructor(status, code, message, options) {
    super(message, options);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}
export function bad(message) { return new ApiError(400, 'INVALID_REQUEST', message); }
export function requireObject(value, message = 'Request must be an object') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad(message);
  return value;
}
export function text(value, key, max) {
  const result = value?.[key];
  if (typeof result !== 'string' || !result.trim() || result.length > max) throw bad(`Invalid ${key}`);
  return result;
}
export function id(value, key) {
  const result = text(value, key, 120);
  return routeId(result, `Invalid ${key}`);
}
export function routeId(value, message = 'Invalid resource ID') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value)) throw bad(message);
  return value;
}
