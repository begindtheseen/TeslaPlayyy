// Phase 2: range-aware googlevideo proxy (/api/stream/:videoId).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { handleYoutubeRange } from '../lib/server/youtubeStream.js';
import { createSession } from '../lib/server/sessions.js';
import { relayStats } from '../lib/server/cdnRelay.js';
import { extractionStats, invalidateExtraction } from '../lib/server/ytdlp.js';
import { startFakeCdn, fakeYoutubeEnv } from './helpers/fakeYoutube.js';

const VID = 'dQw4w9WgXcQ';
let cdn, server, base, session, video, audio;
const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 20)); } return fn(); };

before(async () => {
  cdn = await startFakeCdn({ maxRangeBytes: 256 * 1024 });
  Object.assign(process.env, fakeYoutubeEnv(cdn), { CDN_CHUNK_BYTES: String(256 * 1024) });
  video = readFileSync(cdn.files.video); audio = readFileSync(cdn.files.audio);
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const m = /^\/api\/stream\/([^/]+)$/.exec(u.pathname);
    handleYoutubeRange(req, res, { videoId: m[1], itag: u.searchParams.get('itag') ?? undefined, sessionId: u.searchParams.get('session') ?? undefined, query: u.search });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  session = createSession({ player: 'canvas', youtubeVideoId: VID });
});
after(async () => { server.closeAllConnections(); server.close(); await cdn.close(); });
beforeEach(() => { cdn.requests.length = 0; });

const url = (itag, id = VID, s = session.id) => `${base}/api/stream/${id}?itag=${itag}&session=${s}`;

test('206 Partial Content with Content-Range, Accept-Ranges, Content-Type and exact bytes', async () => {
  const r = await fetch(url(134), { headers: { Range: 'bytes=100-1123' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 100-1123/${video.length}`);
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.equal(r.headers.get('content-length'), '1024');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), video.subarray(100, 1124));
});

test('open-ended range is fetched upstream in chunks the CDN accepts and streamed back intact', async () => {
  const r = await fetch(url(134), { headers: { Range: 'bytes=5000-' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 5000-${video.length - 1}/${video.length}`);
  const body = Buffer.from(await r.arrayBuffer());
  assert.equal(body.length, video.length - 5000);
  assert.ok(body.equals(video.subarray(5000)));
  assert.ok(cdn.requests.length >= Math.ceil((video.length - 5000) / (256 * 1024)));
  for (const q of cdn.requests) { const [a, b] = q.range.slice(6).split('-').map(Number); assert.ok(b - a + 1 <= 256 * 1024, q.range); }
});

test('no Range -> 200 whole file; suffix range; 416 beyond end; audio itag', async () => {
  const full = await fetch(url(140));
  assert.equal(full.status, 200);
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(audio));
  const tail = await fetch(url(140), { headers: { Range: 'bytes=-500' } });
  assert.equal(tail.status, 206);
  assert.ok(Buffer.from(await tail.arrayBuffer()).equals(audio.subarray(audio.length - 500)));
  const bad = await fetch(url(140), { headers: { Range: `bytes=${audio.length}-` } });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('content-range'), `bytes */${audio.length}`);
});

test('client abort tears down the upstream CDN socket (no leaked sockets)', async () => {
  const ac = new AbortController();
  const r = await fetch(url(134), { signal: ac.signal });
  const reader = r.body.getReader();
  await reader.read();
  ac.abort();
  assert.ok(await waitFor(() => relayStats().active === 0), `relays still active: ${relayStats().active}`);
  assert.ok(await waitFor(() => cdn.open === 0), `CDN connections still open: ${cdn.open}`);
});

test('expired / IP-mismatched CDN URL (403) triggers one re-extraction and the response continues', async () => {
  invalidateExtraction(VID);
  await fetch(url(134), { headers: { Range: 'bytes=0-10' } }).then(r => r.arrayBuffer()); // warm the cache
  const before = extractionStats().attempts;
  cdn.fail403 = 1;
  const r = await fetch(url(134), { headers: { Range: 'bytes=0-99999' } });
  assert.equal(r.status, 206);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(video.subarray(0, 100000)));
  assert.equal(extractionStats().attempts, before + 1);
  assert.ok(relayStats().refreshes >= 1);
});

test('session binding, bad input, and default combo redirect', async () => {
  assert.equal((await fetch(`${base}/api/stream/${VID}?itag=134`)).status, 403);
  const other = createSession({ player: 'canvas', youtubeVideoId: 'AAAAAAAAAAA' });
  assert.equal((await fetch(url(134, VID, other.id))).status, 403);
  assert.equal((await fetch(url('x;rm'))).status, 400);
  const nf = await fetch(url(9999));
  assert.equal(nf.status, 404);
  assert.equal((await nf.json()).code, 'unknown_itag');
  const age = createSession({ player: 'canvas', youtubeVideoId: 'AGEGATED000' });
  assert.equal((await fetch(url(134, 'AGEGATED000', age.id))).status, 403);
  const redir = await fetch(`${base}/api/stream/${VID}?session=${session.id}`, { redirect: 'manual' });
  assert.equal(redir.status, 307);
  assert.equal(redir.headers.get('location'), `/api/muxed/${VID}?session=${session.id}`);
});

test('CDN drops mid-transfer are resumed from the exact byte; the client gets an intact response', async () => {
  const before = relayStats().resumes;
  cdn.dropNext = 2; cdn.dropAfterBytes = 50_000;
  const r = await fetch(url(134), { headers: { Range: 'bytes=1000-599999' } });
  assert.equal(r.status, 206);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(video.subarray(1000, 600000)));
  assert.equal(relayStats().resumes - before, 2);
  // More consecutive drops than the relay tolerates: the response is truncated (the client resumes by range).
  cdn.dropNext = 10; cdn.dropAfterBytes = 1000;
  const bad = await fetch(url(134), { headers: { Range: 'bytes=0-199999' } });
  await assert.rejects(bad.arrayBuffer());
  cdn.dropNext = 0;
  assert.ok(await waitFor(() => relayStats().active === 0));
});
