// Phase 3: server-side remux of DASH video + audio into one MPEG-TS stream (/api/muxed/:videoId).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { TSDemuxer } from '../lib/ts/demuxer.js';
import { handleYoutubeMuxed, muxArgs } from '../lib/server/youtubeStream.js';
import { createSession } from '../lib/server/sessions.js';
import { activeProcesses, ffmpegAvailable } from '../lib/server/ffmpeg.js';
import { relayStats } from '../lib/server/cdnRelay.js';
import { startFakeCdn, fakeYoutubeEnv } from './helpers/fakeYoutube.js';

const HAS_FFMPEG = ffmpegAvailable();
const VID = 'dQw4w9WgXcQ';
let cdn, server, base;
const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 25)); } return fn(); };

before(async () => {
  cdn = await startFakeCdn({ maxRangeBytes: 10 * 1024 * 1024 });
  Object.assign(process.env, fakeYoutubeEnv(cdn));
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const id = /^\/api\/muxed\/([^/]+)$/.exec(u.pathname)[1];
    handleYoutubeMuxed(req, res, { videoId: id, sessionId: u.searchParams.get('session'), t: u.searchParams.get('t') });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); server.close(); await cdn.close(); });

async function demuxUrl(url, { abortAfterBytes } = {}) {
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
      out.bytes += value.length; d.push(value);
      if (abortAfterBytes && out.bytes >= abortAfterBytes) { ac.abort(); break; }
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; }
  d.flush();
  return out;
}

const plan = { video: '134', audio: '140', transcode: { video: false, audio: false } };

test('mux args: -c copy, both inputs seeked, MPEG-TS to stdout', () => {
  const a = muxArgs({ videoUrl: 'http://127.0.0.1:1/v', audioUrl: 'http://127.0.0.1:1/a', ss: 12.5 });
  assert.deepEqual(a.slice(-8), ['-copyts', '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', 'pipe:1']);
  assert.equal(a.filter(x => x === '-ss').length, 2);
  assert.ok(a.includes('copy') && !a.includes('libx264'));
});

test('muxed: DASH H.264 + AAC become one demuxable MPEG-TS stream (stream copy, no transcode)', { skip: !HAS_FFMPEG }, async () => {
  const s = createSession({ player: 'canvas', youtubeVideoId: VID, plan });
  const r = await demuxUrl(`${base}/api/muxed/${VID}?session=${s.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp2t');
  assert.equal(r.headers.get('x-stream-mode'), 'muxed copy+copy');
  assert.equal(r.headers.get('x-formats'), '134+140');
  assert.equal(r.videoConfig.codec, 'avc1.640028');
  assert.deepEqual([r.videoConfig.width, r.videoConfig.height], [640, 360]);
  assert.equal(r.audioConfig.codec, 'mp4a.40.2');
  assert.equal(r.audioConfig.sampleRate, 44100);
  assert.equal(r.video.length, 36 * 30);
  assert.ok(Math.abs(r.audio.length - 36 * 44100 / 1024) < 5, `audio frames ${r.audio.length}`);
  assert.equal(r.video[0].type, 'key');
  assert.equal(r.video.filter(v => v.type === 'key').length, 18);
  // Media-time timestamps (µs): first frame carries the 2-frame B-frame reorder delay, audio starts at 0.
  assert.ok(Math.abs(r.video[0].timestamp - 66_667) < 2, `video[0] ${r.video[0].timestamp}`);
  assert.ok(Math.abs(r.audio[0].timestamp - r.video[0].timestamp) < 100_000, 'A/V start aligned');
});

test('muxed seek: t=31 starts on the 30 s keyframe with source timestamps and reads by byte range', { skip: !HAS_FFMPEG }, async () => {
  const s = createSession({ player: 'canvas', youtubeVideoId: VID, plan });
  cdn.requests.length = 0;
  const r = await demuxUrl(`${base}/api/muxed/${VID}?session=${s.id}&t=31`);
  assert.equal(r.status, 200);
  assert.equal(r.video[0].type, 'key');
  assert.ok(Math.abs(r.video[0].timestamp / 1e6 - 30.0667) < 0.01, `first video ${r.video[0].timestamp}`);
  assert.ok(r.video.length >= 170 && r.video.length <= 185, `frames ${r.video.length}`);
  assert.ok(r.audio[0].timestamp / 1e6 >= 30.9 && r.audio[0].timestamp / 1e6 <= 31.05, `first audio ${r.audio[0].timestamp}`);
  const starts = cdn.requests.filter(q => q.itag === '134' && q.range).map(q => Number(q.range.slice(6).split('-')[0]));
  assert.ok(starts.some(x => x > 1_500_000), `FFmpeg should have jumped by byte range, saw ${starts}`);
  assert.equal((await fetch(`${base}/api/muxed/${VID}?session=${s.id}&t=40`)).status, 416);
});

test('muxed: progressive-only video (itag 18 style) plays through the same path', { skip: !HAS_FFMPEG }, async () => {
  const s = createSession({ player: 'canvas', youtubeVideoId: 'PROGRESSIV0' });
  const r = await demuxUrl(`${base}/api/muxed/PROGRESSIV0?session=${s.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-formats'), '18');
  assert.equal(r.video.length, 36 * 30);
  assert.ok(r.audio.length > 1500);
});

test('muxed: client abort kills FFmpeg and releases the loopback relay and CDN sockets', { skip: !HAS_FFMPEG }, async () => {
  const s = createSession({ player: 'canvas', youtubeVideoId: VID, plan });
  const r = await demuxUrl(`${base}/api/muxed/${VID}?session=${s.id}`, { abortAfterBytes: 50_000 });
  assert.ok(r.bytes >= 50_000);
  assert.ok(await waitFor(() => activeProcesses().size === 0), 'ffmpeg still running');
  assert.ok(await waitFor(() => relayStats().active === 0), `relays active ${relayStats().active}`);
  assert.ok(await waitFor(() => cdn.open === 0), `CDN sockets open ${cdn.open}`);
});

test('muxed: errors are clean JSON (session, age-gate, bad t)', { skip: !HAS_FFMPEG }, async () => {
  assert.equal((await fetch(`${base}/api/muxed/${VID}`)).status, 403);
  const s = createSession({ player: 'canvas', youtubeVideoId: 'AGEGATED000' });
  const r = await fetch(`${base}/api/muxed/AGEGATED000?session=${s.id}`);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'age_restricted');
  const ok = createSession({ player: 'canvas', youtubeVideoId: VID, plan });
  assert.equal((await fetch(`${base}/api/muxed/${VID}?session=${ok.id}&t=-3`)).status, 400);
});
