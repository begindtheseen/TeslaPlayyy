import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TSDemuxer } from '../lib/ts/demuxer.js';
import { handleStream } from '../lib/server/streamHandler.js';
import { createPlaybackSession, PlaybackError } from '../lib/server/playback.js';
import { activeProcesses, ffmpegAvailable, planSeek } from '../lib/server/ffmpeg.js';
import { closeSession, getSession, touchSession } from '../lib/server/sessions.js';
import { assertFetchableUrl, isPrivateAddress } from '../lib/server/urlGuard.js';
import { search, info, validateQuery, parseIsoDuration, YouTubeError } from '../lib/server/youtube.js';

const HAS_FFMPEG = ffmpegAvailable();
let server, base, originServer, originBase;

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const m = /^\/stream\/([^/]+)$/.exec(u.pathname);
    if (!m) { res.statusCode = 404; return res.end(); }
    handleStream(req, res, { assetId: m[1], sessionId: u.searchParams.get('session'), t: u.searchParams.get('t') ?? undefined });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // A separate "remote" origin standing in for an authorized CDN (outbound internet is not available in CI here).
  originServer = http.createServer((req, res) => {
    const file = path.join(process.cwd(), 'public/media/demo-av.mp4');
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': statSync(file).size });
    createReadStream(file).pipe(res);
  });
  await new Promise(r => originServer.listen(0, '127.0.0.1', r));
  originBase = `http://127.0.0.1:${originServer.address().port}`;
});
after(() => { server.close(); originServer.close(); });

async function fetchAndDemux(url, { abortAfterBytes } = {}) {
  const ac = new AbortController();
  const r = await fetch(url, { signal: ac.signal });
  const out = { status: r.status, headers: r.headers, video: [], audio: [], videoConfig: null, audioConfig: null, bytes: 0 };
  if (!r.ok) { out.body = await r.json(); return out; }
  const d = new TSDemuxer({ onVideo: v => out.video.push(v), onAudio: a => out.audio.push(a), onVideoConfig: c => { out.videoConfig = c; }, onAudioConfig: c => { out.audioConfig = c; } });
  const reader = r.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.bytes += value.length;
      d.push(value);
      if (abortAfterBytes && out.bytes >= abortAfterBytes) { ac.abort(); break; }
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; }
  d.flush();
  return out;
}
const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 25)); } return fn(); };

test('session: catalog asset resolves to the canvas player with probed codecs', { skip: !HAS_FFMPEG }, async () => {
  const s = await createPlaybackSession({ kind: 'catalog', id: 'demo-av' });
  assert.equal(s.player, 'canvas');
  assert.match(s.canvas.streamUrl, /^\/api\/media\/stream\/demo-av\?session=/);
  assert.equal(s.canvas.hasAudio, true);
  assert.equal(s.canvas.startTime, 1.4);
  assert.ok(Math.abs(s.canvas.duration - 10.02) < 0.05);
  assert.deepEqual(s.canvas.transcoding, { video: false, audio: false });
  assert.ok(s.heartbeatIntervalMs >= 5000);
});

test('session: YouTube video without a licensed source is refused (no iframe fallback)', async () => {
  await assert.rejects(createPlaybackSession({ kind: 'youtube', videoId: 'aqz-KE-bpKQ' }),
    e => e instanceof PlaybackError && e.status === 409 && e.code === 'no_authorized_media' && e.extra.videoId === 'aqz-KE-bpKQ');
});

test('session: operator-mapped YouTube id streams its licensed copy via /api/youtube/stream to the canvas player', { skip: !HAS_FFMPEG }, async () => {
  process.env.YOUTUBE_AUTHORIZED_MAP = 'AAAAAAAAAAA=demo-av';
  try {
    const s = await createPlaybackSession({ kind: 'youtube', videoId: 'AAAAAAAAAAA' });
    assert.equal(s.player, 'canvas');
    assert.equal(s.asset.id, 'demo-av');
    assert.match(s.canvas.streamUrl, /^\/api\/youtube\/stream\/AAAAAAAAAAA\?session=/);
    // The route handler delegates to handleStream with the mapped asset; exercise that path directly.
    const r = await fetchAndDemux(`${base}/stream/demo-av?session=${s.sessionId}`);
    assert.equal(r.video.length, 240);
  } finally { delete process.env.YOUTUBE_AUTHORIZED_MAP; }
});

test('session: rejects bad input', async () => {
  await assert.rejects(createPlaybackSession({ kind: 'youtube', videoId: 'https://youtube.com/watch?v=x' }), e => e instanceof PlaybackError && e.code === 'invalid_video_id');
  await assert.rejects(createPlaybackSession({ kind: 'catalog', id: '../../etc/passwd' }), e => e.code === 'unknown_asset');
  await assert.rejects(createPlaybackSession({ kind: 'url', url: 'http://169.254.169.254/' }), e => e.code === 'invalid_source');
  await assert.rejects(createPlaybackSession(null), e => e.code === 'invalid_source');
});

test('stream: full A/V asset is stream-copied into demuxable MPEG-TS', { skip: !HAS_FFMPEG }, async () => {
  const s = await createPlaybackSession({ kind: 'catalog', id: 'demo-av' });
  const r = await fetchAndDemux(base + s.canvas.streamUrl.replace('/api/media', ''));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp2t');
  assert.equal(r.headers.get('x-stream-mode'), 'copy+copy');
  assert.equal(r.video.length, 240);
  assert.equal(r.audio.length, 470);
  // Source packets (ffprobe): audio starts 1.400000 s, video 1.421333 s; -copyts preserves both.
  assert.equal(r.video[0].timestamp, 1_421_333);
  assert.equal(r.audio[0].timestamp, 1_400_000);
  assert.equal(r.audioConfig.codec, 'mp4a.40.2');
});

test('stream: MP4 source is remuxed (not transcoded) to MPEG-TS with Annex B + ADTS', { skip: !HAS_FFMPEG }, async () => {
  const s = await createPlaybackSession({ kind: 'catalog', id: 'demo-av-mp4' });
  const r = await fetchAndDemux(base + s.canvas.streamUrl.replace('/api/media', ''));
  assert.equal(r.headers.get('x-stream-mode'), 'copy+copy');
  assert.equal(r.videoConfig.codec, 'avc1.42C01E');
  assert.equal(r.video.length, 240);
  assert.ok(r.audio.length >= 469);
  assert.equal(r.video[0].type, 'key');
  // MP4 audio has -1024 samples of priming (pts -0.021333); FFmpeg shifts everything non-negative for TS.
  assert.equal(r.video[0].timestamp, 21_333);
});

for (const [id, start] of [['demo-av', 1.4], ['demo-av-mp4', 0]]) {
  test(`seek: ${id} t=5 starts on the preceding keyframe (4.0 s) with source timestamps`, { skip: !HAS_FFMPEG }, async () => {
    const s = await createPlaybackSession({ kind: 'catalog', id });
    const r = await fetchAndDemux(base + s.canvas.streamUrl.replace('/api/media', '') + '&t=5');
    assert.equal(r.status, 200);
    assert.equal(r.video[0].type, 'key');
    assert.ok(Math.abs(r.video[0].timestamp / 1e6 - start - 4.0) < 0.05, `first video at ${r.video[0].timestamp}`);
    assert.ok(r.video.length >= 140 && r.video.length <= 150, `frames ${r.video.length}`);
    assert.ok(r.audio.length > 250);
  });
}

test('seek: beyond duration is rejected; bad t is rejected', { skip: !HAS_FFMPEG }, async () => {
  const s = await createPlaybackSession({ kind: 'catalog', id: 'demo-av' });
  const u = base + s.canvas.streamUrl.replace('/api/media', '');
  assert.equal((await fetch(u + '&t=11')).status, 416);
  assert.equal((await fetch(u + '&t=-1')).status, 400);
  assert.equal((await fetch(u + '&t=abc')).status, 400);
});

test('stream: requires a valid session bound to the same asset', { skip: !HAS_FFMPEG }, async () => {
  const s = await createPlaybackSession({ kind: 'catalog', id: 'demo-av' });
  assert.equal((await fetch(`${base}/stream/demo-av?session=nope`)).status, 403);
  assert.equal((await fetch(`${base}/stream/demo?session=${s.sessionId}`)).status, 403);
  assert.equal((await fetch(`${base}/stream/unknown?session=${s.sessionId}`)).status, 404);
});

test('cancellation: client abort kills the FFmpeg process', { skip: !HAS_FFMPEG }, async () => {
  const s = await createPlaybackSession({ kind: 'catalog', id: 'demo-av-mp4' });
  const before = activeProcesses().size;
  const r = await fetchAndDemux(base + s.canvas.streamUrl.replace('/api/media', ''), { abortAfterBytes: 20_000 });
  assert.ok(r.bytes >= 20_000 && r.bytes < 600_000);
  assert.ok(await waitFor(() => activeProcesses().size === before), 'ffmpeg process still running after abort');
});

test('cancellation: a new request (seek) and session close both abort the running stream', { skip: !HAS_FFMPEG }, async () => {
  process.env.MEDIA_ALLOWED_HOSTS = '127.0.0.1';
  process.env.MEDIA_ALLOW_PRIVATE_NETWORK = '1';
  const s = await createPlaybackSession({ kind: 'catalog', id: 'demo-av' });
  const url = base + s.canvas.streamUrl.replace('/api/media', '');
  // Hold the first stream open without reading so FFmpeg blocks on backpressure.
  const first = await fetch(url);
  assert.equal(first.status, 200);
  await waitFor(() => getSession(s.sessionId).streams.size === 1);
  const second = await fetch(url + '&t=2');
  assert.equal(second.status, 200);
  const firstBody = first.body.getReader();
  let total = 0;
  for (;;) { const { done, value } = await firstBody.read().catch(() => ({ done: true })); if (done) break; total += value.length; }
  assert.ok(total < 751_436, 'first stream should have been cut short by the seek');
  closeSession(s.sessionId);
  await second.body.cancel().catch(() => {});
  assert.ok(await waitFor(() => activeProcesses().size === 0), 'processes left running');
  assert.equal(touchSession(s.sessionId), null);
});

test('authorized remote asset: allow-listed origin is fetched and remuxed by FFmpeg', { skip: !HAS_FFMPEG }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ct-'));
  const file = path.join(dir, 'catalog.json');
  writeFileSync(file, JSON.stringify({ assets: [{ id: 'remote-av', title: 'Remote A/V', source: `${originBase}/demo-av.mp4`, license: 'test origin' }] }));
  Object.assign(process.env, { MEDIA_CATALOG_FILE: file, MEDIA_ALLOWED_HOSTS: '127.0.0.1', MEDIA_ALLOW_PRIVATE_NETWORK: '1' });
  try {
    const s = await createPlaybackSession({ kind: 'catalog', id: 'remote-av' });
    assert.equal(s.canvas.hasAudio, true);
    const r = await fetchAndDemux(base + s.canvas.streamUrl.replace('/api/media', ''));
    assert.equal(r.status, 200);
    assert.equal(r.video.length, 240);
    delete process.env.MEDIA_ALLOW_PRIVATE_NETWORK;
    await assert.rejects(createPlaybackSession({ kind: 'catalog', id: 'remote-av' }), e => e.code === 'source_rejected');
  } finally {
    delete process.env.MEDIA_CATALOG_FILE; delete process.env.MEDIA_ALLOWED_HOSTS; delete process.env.MEDIA_ALLOW_PRIVATE_NETWORK;
  }
});

test('SSRF guard', async () => {
  process.env.MEDIA_ALLOWED_HOSTS = 'cdn.example.com,*.media.example.org';
  const pub = async () => [{ address: '93.184.216.34' }];
  const priv = async () => [{ address: '10.0.0.8' }];
  try {
    await assertFetchableUrl('https://cdn.example.com/a.mp4', { resolve: pub });
    await assertFetchableUrl('https://x.media.example.org/a.mp4', { resolve: pub });
    await assert.rejects(assertFetchableUrl('http://cdn.example.com/a.mp4', { resolve: pub }), /https/);
    await assert.rejects(assertFetchableUrl('https://evil.com/a.mp4', { resolve: pub }), /not in MEDIA_ALLOWED_HOSTS/);
    await assert.rejects(assertFetchableUrl('https://cdn.example.com/a.mp4', { resolve: priv }), /private address/);
    await assert.rejects(assertFetchableUrl('https://u:p@cdn.example.com/a.mp4', { resolve: pub }), /Credentials/);
    await assert.rejects(assertFetchableUrl('file:///etc/passwd', { resolve: pub }), /https/);
  } finally { delete process.env.MEDIA_ALLOWED_HOSTS; }
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1']) assert.ok(!isPrivateAddress(ip), ip);
});

test('seek planner snaps to the prior keyframe', () => {
  assert.deepEqual(planSeek(0, [0, 2, 4]), { ss: 0, keyframe: 0 });
  assert.deepEqual(planSeek(5, [0, 2, 4, 6]), { ss: 3.95, keyframe: 4 });
  assert.deepEqual(planSeek(5, null), { ss: 5, keyframe: null });
});

test('YouTube search: validation, missing key, quota mapping and response shaping', async () => {
  assert.throws(() => validateQuery('   '), e => e.code === 'missing_query');
  assert.throws(() => validateQuery('x'.repeat(101)), e => e.code === 'query_too_long');
  delete process.env.YOUTUBE_API_KEY;
  await assert.rejects(search('cats'), e => e instanceof YouTubeError && e.status === 503 && e.code === 'missing_api_key');
  process.env.YOUTUBE_API_KEY = 'test-key';
  try {
    const quota = async () => new Response(JSON.stringify({ error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }), { status: 403 });
    await assert.rejects(search('quota test', { fetchImpl: quota }), e => e.status === 429 && e.code === 'quota_exceeded');
    let called;
    const ok = async u => { called = new URL(u); return new Response(JSON.stringify({ items: [
      { id: { videoId: 'aqz-KE-bpKQ' }, snippet: { title: 'Big Buck Bunny', channelTitle: 'Blender', thumbnails: { medium: { url: 'https://i.ytimg.com/x.jpg' } } } },
      { id: { videoId: 'bad' }, snippet: {} } ] }), { status: 200 }); };
    const r = await search('  big   buck  ', { fetchImpl: ok });
    assert.equal(called.searchParams.get('q'), 'big buck');
    assert.equal(called.searchParams.get('videoEmbeddable'), 'true');
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].snippet.title, 'Big Buck Bunny');
    const inf = await info('aqz-KE-bpKQ', { fetchImpl: async () => new Response(JSON.stringify({ items: [{ id: 'aqz-KE-bpKQ', snippet: { title: 'BBB' }, contentDetails: { duration: 'PT10M35S' }, status: { embeddable: true } }] })) });
    assert.equal(inf.duration, 635);
    assert.equal(inf.embeddable, true);
  } finally { delete process.env.YOUTUBE_API_KEY; }
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
});
