// SSRF protection for operator-configured remote media URLs. Clients never submit URLs; they
// submit catalog ids. Remote URLs in the catalog must still pass these checks before FFmpeg opens them.
import { lookup } from 'node:dns/promises';
import net from 'node:net';

export function allowedHosts() {
  return (process.env.MEDIA_ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('ff');
}

const hostMatches = (host, rule) => host === rule || (rule.startsWith('*.') && host.endsWith(rule.slice(1)));

// Throws with a user-safe message when the URL must not be fetched.
export async function assertFetchableUrl(raw, { resolve = lookup } = {}) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid media URL'); }
  const allowPrivate = process.env.MEDIA_ALLOW_PRIVATE_NETWORK === '1';
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) throw new Error('Media URL must use https');
  if (u.username || u.password) throw new Error('Credentials in media URLs are not allowed');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const rules = allowedHosts();
  if (!rules.some(r => hostMatches(host, r))) throw new Error(`Host ${host} is not in MEDIA_ALLOWED_HOSTS`);
  const addrs = net.isIP(host) ? [{ address: host }] : await resolve(host, { all: true });
  if (!allowPrivate && addrs.some(a => isPrivateAddress(a.address))) throw new Error(`Host ${host} resolves to a private address`);
  return u;
}
