// Range-aware relay from googlevideo to a client (the browser worker, or FFmpeg via the loopback relay).
//
// - Forwards the client's single byte range; answers 206 + Content-Range + Accept-Ranges (200 without Range).
// - Fetches upstream in chunks of CDN_CHUNK_BYTES (default 10 MiB): googlevideo refuses or throttles
//   oversized ranges, so an open-ended `bytes=N-` becomes several upstream requests streamed back to back.
// - Streams with backpressure (never buffers the file). A client disconnect aborts the upstream socket.
// - A connection the CDN drops mid-transfer is resumed from the exact byte (up to 3 times in a row).
// - A 403/404/410 from the CDN (expired or IP-mismatched URL) triggers one re-extraction and the chunk is
//   retried with the fresh URL, even in the middle of a response.
import { cdnRequest } from './egress.js';
import { shared, envInt } from './state.js';

export const relayStats = () => shared('relayStats', () => ({ active: 0, total: 0, bytes: 0, refreshes: 0, resumes: 0, upstreamErrors: 0 }));

export function parseRange(h) {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h).trim());
  if (!m || (m[1] === '' && m[2] === '')) return { invalid: true };
  return { start: m[1] === '' ? null : Number(m[1]), end: m[2] === '' ? null : Number(m[2]), suffix: m[1] === '' ? Number(m[2]) : null };
}

const baseMime = m => String(m || 'application/octet-stream').split(';')[0];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isExpiry = s => s === 403 || s === 404 || s === 410;

// `resolve({refresh})` -> {url, egress, contentLength?, mimeType?}; refresh=true must re-extract.
export async function relayRange(req, res, { resolve, label = 'relay' }) {
  const st = relayStats();
  if (st.active >= envInt('STREAM_MAX_RELAYS', 64)) return sendJson(res, 503, { error: 'Streaming capacity reached, try again shortly', code: 'capacity' });
  const range = parseRange(req.headers.range);
  if (range?.invalid) return sendJson(res, 416, { error: 'Unsupported Range header', code: 'bad_range' });

  const ac = new AbortController();
  const onClose = () => { if (!res.writableFinished) ac.abort(); };
  res.on('close', onClose);
  req.on('close', () => { if (req.destroyed && !res.writableFinished) ac.abort(); });
  st.active++; st.total++;
  try {
    let src = await resolve({ refresh: false });
    let refreshed = false;
    const chunk = envInt('CDN_CHUNK_BYTES', 10 * 1024 * 1024);

    // Opens one upstream range, re-extracting once on URL expiry. Returns the upstream response.
    const open = async (a, b) => {
      for (let attempt = 0; ; attempt++) {
        let up;
        try { up = await cdnRequest(src.url, { egress: src.egress, headers: { Range: `bytes=${a}-${b ?? ''}` }, signal: ac.signal }); }
        catch (e) {
          if (e.name === 'AbortError' || attempt >= 2) throw e;
          st.upstreamErrors++; await sleep(300 * (attempt + 1)); continue;
        }
        if ((up.statusCode === 206 || up.statusCode === 200) || up.statusCode === 416) return up;
        up.resume();
        st.upstreamErrors++;
        if (isExpiry(up.statusCode) && !refreshed) { refreshed = true; st.refreshes++; src = await resolve({ refresh: true }); continue; }
        if (up.statusCode >= 500 && attempt < 2) { await sleep(300 * (attempt + 1)); continue; }
        throw Object.assign(new Error(`CDN responded ${up.statusCode}`), { upstreamStatus: up.statusCode });
      }
    };

    let total = src.contentLength ?? null;
    let first = null;
    if (!total) {
      // Learn the size from the first chunk's Content-Range.
      const a = range?.suffix != null ? 0 : (range?.start ?? 0);
      first = { a, up: await open(a, a + chunk - 1) };
      const cr = /\/(\d+)$/.exec(first.up.headers['content-range'] || '');
      total = cr ? Number(cr[1]) : Number(first.up.headers['content-length']) || null;
      if (range?.suffix != null) { first.up.destroy(); first = null; }
    }
    if (!total) throw new Error('CDN did not report a content length');

    let start = 0, end = total - 1;
    if (range) {
      if (range.suffix != null) start = Math.max(0, total - range.suffix);
      else { start = range.start; if (range.end != null) end = Math.min(range.end, total - 1); }
      if (start >= total || start > end) {
        first?.up.destroy();
        res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' });
        return res.end();
      }
    }
    if (first && first.a !== start) { first.up.destroy(); first = null; }

    res.writeHead(range ? 206 : 200, {
      'Content-Type': baseMime(src.mimeType),
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') { first?.up.destroy(); return res.end(); }

    let resumes = 0;
    for (let pos = start; pos <= end;) {
      const b = Math.min(pos + chunk - 1, end);
      let up;
      if (first) { up = first.up; first = null; } else up = await open(pos, b);
      if (up.statusCode === 416) { up.resume(); throw new Error('CDN rejected range'); }
      if (up.statusCode === 200 && pos > 0) { up.destroy(); throw new Error('CDN ignored Range'); }
      let want = b - pos + 1;
      try {
        for await (const buf of up) {
          const piece = buf.length > want ? buf.subarray(0, want) : buf;
          want -= piece.length; pos += piece.length; st.bytes += piece.length;
          if (!res.write(piece)) await drained(res);
          if (ac.signal.aborted) { up.destroy(); return; }
          if (want === 0) { up.destroy(); break; }
        }
      } catch { /* upstream socket error: handled below like an early close */ }
      if (ac.signal.aborted) return;
      if (want > 0) {
        // The CDN dropped mid-chunk: resume from the exact byte so the client never notices.
        if (++resumes > 3) throw new Error('CDN connection kept dropping');
        st.upstreamErrors++; st.resumes++;
        await sleep(200 * resumes);
        continue;
      }
      resumes = 0;
    }
    res.end();
  } catch (e) {
    if (ac.signal.aborted || e.name === 'AbortError') return;
    if (!res.headersSent) {
      sendJson(res, e.status || 502, { error: e.status ? e.message : 'Upstream media request failed', code: e.code || 'upstream_failed', detail: e.upstreamStatus ? `CDN ${e.upstreamStatus}` : undefined });
    } else res.destroy(); // truncated body: the client sees an incomplete transfer and resumes by range
    if (!e.status) console.warn(`[${label}] ${e.message}`);
  } finally {
    st.active--;
    res.off('close', onClose);
  }
}

// Resolves on 'drain' or 'close', removing both listeners (Promise.race over once() would leak them).
function drained(res) {
  return new Promise(resolve => {
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.on('drain', done); res.on('close', done);
  });
}

export function sendJson(res, status, body) {
  if (res.headersSent) return res.end();
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
