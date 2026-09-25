// Fixed-window per-client rate limiting (single process).
import { shared } from './state.js';

export function clientKey(req) {
  const fwd = process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return fwd || req.socket?.remoteAddress || 'unknown';
}

// Returns true when allowed; otherwise sends 429 and returns false.
export function rateLimit(req, res, { name, limit, windowMs }) {
  const buckets = shared('rate:' + name, () => new Map());
  const key = clientKey(req);
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count++;
  if (buckets.size > 10000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  if (b.count > limit) {
    res.setHeader('Retry-After', Math.ceil((b.reset - now) / 1000));
    res.status(429).json({ error: 'Too many requests', code: 'rate_limited' });
    return false;
  }
  return true;
}
