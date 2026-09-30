// Local stand-ins for YouTube: a googlevideo-like CDN with Range support and URL expiry, plus the
// fake yt-dlp executable (test/fixtures/fake-yt-dlp.mjs) that returns formats pointing at it.
// Outbound access to youtube.com / googlevideo.com is not available in CI.
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDashFixture } from './dashFixture.js';

export const FAKE_YTDLP = fileURLToPath(new URL('../fixtures/fake-yt-dlp.mjs', import.meta.url));

// maxRangeBytes mimics googlevideo refusing oversized range requests (it returns 403).
export async function startFakeCdn({ maxRangeBytes = Infinity } = {}) {
  const { dir, files } = ensureDashFixture();
  const cdn = { requests: [], open: 0, maxRangeBytes, dir, files, fail403: 0 };
  cdn.server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const file = path.join(dir, path.basename(u.searchParams.get('f') || ''));
    cdn.requests.push({ path: u.pathname, itag: u.searchParams.get('itag'), range: req.headers.range || null });
    cdn.open++;
    res.on('close', () => { cdn.open--; });
    if (u.pathname !== '/videoplayback') { res.statusCode = 404; return res.end(); }
    if (Number(u.searchParams.get('expire')) * 1000 < Date.now()) { res.statusCode = 403; return res.end('expired'); }
    if (cdn.fail403 > 0) { cdn.fail403--; res.statusCode = 403; return res.end('ip mismatch'); } // e.g. URL used from another IP
    let size;
    try { size = statSync(file).size; } catch { res.statusCode = 404; return res.end(); }
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!m) {
      if (size > cdn.maxRangeBytes) { res.statusCode = 403; return res.end('range required'); }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      return createReadStream(file).pipe(res);
    }
    let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
    let end = m[1] === '' ? size - 1 : m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    if (end - start + 1 > cdn.maxRangeBytes) { res.statusCode = 403; return res.end('range too large'); }
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' });
    createReadStream(file, { start, end }).pipe(res);
  });
  await new Promise(r => cdn.server.listen(0, '127.0.0.1', r));
  cdn.base = `http://127.0.0.1:${cdn.server.address().port}`;
  cdn.close = () => new Promise(r => { cdn.server.closeAllConnections?.(); cdn.server.close(r); });
  return cdn;
}

// Env that points the server code at the fakes.
export function fakeYoutubeEnv(cdn, extra = {}) {
  return {
    YTDLP_PATH: FAKE_YTDLP, FAKE_CDN_BASE: cdn.base, FAKE_FIXTURE_DIR: cdn.dir,
    CDN_ALLOWED_HOSTS: '127.0.0.1', MEDIA_ALLOW_PRIVATE_NETWORK: '1', ...extra,
  };
}
