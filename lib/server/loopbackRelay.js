// A 127.0.0.1-only HTTP endpoint that FFmpeg reads googlevideo through. FFmpeg therefore uses the same
// egress (proxy / source address the URL is locked to), chunked ranges and expired-URL refresh as the
// browser path, and can seek with Range requests (sidx-indexed fMP4). Each FFmpeg input gets a random,
// short-lived token; nothing is reachable from outside the host.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { relayRange, sendJson } from './cdnRelay.js';
import { formatResolver } from './ytdlp.js';
import { shared } from './state.js';

const st = () => shared('loopbackRelay', () => ({ server: null, port: 0, starting: null, tokens: new Map() }));

function start() {
  const s = st();
  if (s.port) return Promise.resolve(s.port);
  s.starting ??= new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const t = s.tokens.get(req.url.slice(1));
      if (!t || t.exp < Date.now()) return sendJson(res, 404, { error: 'unknown token' });
      relayRange(req, res, { resolve: formatResolver(t.videoId, t.itag), label: `loopback ${t.videoId}/${t.itag}` });
    });
    server.keepAliveTimeout = 30000;
    server.on('error', e => { s.starting = null; reject(e); });
    server.listen(0, '127.0.0.1', () => { server.unref(); s.server = server; s.port = server.address().port; resolve(s.port); });
  });
  return s.starting;
}

export async function loopbackUrl(videoId, itag, ttlMs = 6 * 3600e3) {
  const port = await start();
  const token = randomBytes(24).toString('base64url');
  const s = st();
  s.tokens.set(token, { videoId, itag: String(itag), exp: Date.now() + ttlMs });
  if (s.tokens.size > 5000) for (const [k, v] of s.tokens) if (v.exp < Date.now()) s.tokens.delete(k);
  return { url: `http://127.0.0.1:${port}/${token}`, revoke: () => s.tokens.delete(token) };
}
