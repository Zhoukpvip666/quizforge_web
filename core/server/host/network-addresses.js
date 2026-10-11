import net from 'node:net';
import os from 'node:os';

export function ipv6Bytes(host) {
  let value = host.replace(/^\[|\]$/g, '').toLowerCase(); if (net.isIP(value) !== 6 || value.includes('%')) return null;
  if (value.includes('.')) { const point = value.lastIndexOf(':'), ipv4 = value.slice(point + 1).split('.').map(Number); value = value.slice(0, point + 1) + ((ipv4[0] << 8) | ipv4[1]).toString(16) + ':' + ((ipv4[2] << 8) | ipv4[3]).toString(16); }
  const [first, second] = value.split('::'), left = first ? first.split(':') : [], right = second ? second.split(':') : [], words = second === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right], bytes = Buffer.alloc(16);
  if (words.length !== 8) return null; for (let i = 0; i < 8; i++) bytes.writeUInt16BE(parseInt(words[i], 16), 2 * i); return bytes;
}
export function hostKey(host) {
  if (typeof host !== 'string' || host.includes('%')) return null; const value = host.replace(/^\[|\]$/g, '').toLowerCase(); if (!value.includes(':')) return value;
  const bytes = ipv6Bytes(value); if (!bytes) return null;
  if (bytes.subarray(0, 10).every(byte => byte === 0) && bytes.readUInt16BE(10) === 0xffff) return [...bytes.subarray(12)].join('.');
  return bytes.toString('hex');
}
export const sameHost = (left, right) => hostKey(left) !== null && hostKey(left) === hostKey(right);
export const url = (host, port) => `http://${host.includes(':') ? '[' + host.replace(/^\[|\]$/g, '') + ']' : host}:${port}/`;
export function privateAddress(address) {
  const value = hostKey(address); if (!value) return false;
  if (net.isIP(value) === 4) { const [a, b] = value.split('.').map(Number); return a === 127 || a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254; }
  const bytes = ipv6Bytes(address); return bytes !== null && (value === hostKey('::1') || (bytes[0] & 0xfe) === 0xfc || bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80);
}
export function interfaceAddresses() { return Object.values(os.networkInterfaces()).flat().filter(Boolean); }
export function sameIpv6Subnet(local, remote, prefix) { const left = ipv6Bytes(local), right = ipv6Bytes(remote); if (!left || !right || prefix < 64 || prefix > 128) return false; for (let i = 0; i < prefix; i++) { const mask = 1 << (7 - i % 8); if ((left[Math.floor(i / 8)] & mask) !== (right[Math.floor(i / 8)] & mask)) return false; } return true; }
export function ipv6Available() { return new Promise(resolve => { const server = net.createServer(); server.once('error', () => resolve(false)); server.listen(0, '::1', () => server.close(() => resolve(true))); }); }
