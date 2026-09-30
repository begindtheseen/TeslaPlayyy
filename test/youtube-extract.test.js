// Phase 1: yt-dlp extraction, error classification, fallback clients, caching, format selection.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extract, invalidateExtraction, classifyYtdlpError, normalizeFormat, extractionStats, buildYtdlpArgs, ExtractError } from '../lib/server/ytdlp.js';
import { pickVideo, pickAudio, planDelivery } from '../lib/server/formats.js';
import { randomIpv6InPrefix, pickEgress, reportBlocked, assertCdnUrl } from '../lib/server/egress.js';
import { startFakeCdn, fakeYoutubeEnv } from './helpers/fakeYoutube.js';

let cdn, log;
const calls = () => { try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };

before(async () => {
  cdn = await startFakeCdn();
  log = path.join(mkdtempSync(path.join(tmpdir(), 'ytlog-')), 'calls.jsonl');
  Object.assign(process.env, fakeYoutubeEnv(cdn, { FAKE_YTDLP_LOG: log }));
});
after(() => cdn.close());
beforeEach(() => { writeFileSync(log, ''); delete process.env.PROXY_URL; delete process.env.YTDLP_CLIENTS; });

test('extract: success returns normalized formats (no manifests/storyboards) and uses android_vr,web_safari first', async () => {
  const x = await extract('dQw4w9WgXcQ');
  assert.equal(x.title, 'Fake video dQw4w9WgXcQ');
  assert.equal(x.duration, 36);
  assert.equal(x.client, 'android_vr,web_safari');
  assert.deepEqual(x.formats.map(f => f.itag).sort((a, b) => a - b), [18, 134, 139, 140, 243, 251]);
  const v = x.formats.find(f => f.itag === 134);
  assert.deepEqual({ w: v.width, h: v.height, hasAudio: v.hasAudio, hasVideo: v.hasVideo, container: v.container }, { w: 640, h: 360, hasAudio: false, hasVideo: true, container: 'mp4' });
  assert.equal(v.mimeType, 'video/mp4; codecs="avc1.640028"');
  assert.ok(v.contentLength > 1e6, 'content length from clen');
  assert.equal(x.formats.find(f => f.itag === 140).mimeType, 'audio/mp4; codecs="mp4a.40.2"');
  assert.ok(x.expiresAt > Date.now());
  const c = calls();
  assert.equal(c.length, 1);
  assert.ok(c[0].args.includes('youtube:player_client=android_vr,web_safari'));
});

test('extract: cached for repeated calls and deduplicated while in flight', async () => {
  invalidateExtraction('CACHEDVID00');
  const [a, b] = await Promise.all([extract('CACHEDVID00'), extract('CACHEDVID00')]);
  const c = await extract('CACHEDVID00');
  assert.equal(calls().length, 1);
  assert.equal(a.cached, false); assert.equal(b.cached, false); assert.equal(c.cached, true);
  await extract('CACHEDVID00', { force: true });
  assert.equal(calls().length, 2);
});

test('extract: permanent errors map to clean status codes without retries', async () => {
  const cases = { PRIVATEVID0: [404, 'private'], REMOVED0000: [404, 'unavailable'], AGEGATED000: [403, 'age_restricted'],
    REGIONLOCK0: [451, 'region_blocked'], MEMBERSONLY: [403, 'members_only'], LIVESTREAM0: [422, 'live_unsupported'] };
  for (const [id, [status, code]] of Object.entries(cases)) {
    writeFileSync(log, '');
    await assert.rejects(extract(id), e => e instanceof ExtractError && e.status === status && e.code === code, id);
    assert.equal(calls().length, 1, `${id} must not be retried with other clients`);
  }
  // Remembered briefly: no second yt-dlp run.
  writeFileSync(log, '');
  await assert.rejects(extract('AGEGATED000'), e => e.status === 403);
  assert.equal(calls().length, 0);
});

test('extract: bot-check block falls back to the next player_client group and cools the egress down', async () => {
  const x = await extract('BOTBLOCKED0');
  assert.equal(x.client, 'tv,ios');
  assert.deepEqual(calls().map(c => c.clients), ['android_vr,web_safari', 'tv,ios']);
  writeFileSync(log, '');
  await assert.rejects(extract('ALWAYSBLOCK'), e => e.status === 429 && e.code === 'blocked' && e.retryable);
  assert.deepEqual(calls().map(c => c.clients), ['android_vr,web_safari', 'tv,ios', 'mweb']);
});

test('extract: client groups and outbound proxy are configurable via env', async () => {
  process.env.YTDLP_CLIENTS = 'ios|mweb';
  process.env.PROXY_URL = 'socks5://user:secret@127.0.0.1:1080';
  invalidateExtraction('PROXYTEST00');
  const x = await extract('PROXYTEST00');
  const c = calls()[0];
  assert.equal(c.clients, 'ios');
  assert.deepEqual(c.args.slice(c.args.indexOf('--proxy'), c.args.indexOf('--proxy') + 2), ['--proxy', 'socks5://user:secret@127.0.0.1:1080']);
  assert.equal(x.egress.id, 'socks5://127.0.0.1:1080', 'egress id must not leak credentials');
});

test('extract: missing yt-dlp binary is a clear 503', async () => {
  const prev = process.env.YTDLP_PATH;
  process.env.YTDLP_PATH = '/nonexistent/yt-dlp';
  try { await assert.rejects(extract('NOBINARY000'), e => e.status === 503 && e.code === 'extractor_missing'); }
  finally { process.env.YTDLP_PATH = prev; }
});

test('health stats: success rate counts requests after fallbacks', () => {
  const s = extractionStats();
  assert.ok(s.requests >= 5);
  assert.ok(s.successRate > 0 && s.successRate < 1);
  assert.ok(s.byCode.age_restricted >= 1);
  assert.ok(s.byClient['android_vr,web_safari'].attempts >= 1);
});

test('classifier: real yt-dlp error wording', () => {
  const c = s => classifyYtdlpError(`WARNING: [youtube] x: something\nERROR: [youtube] x: ${s}`).code;
  assert.equal(c('Video unavailable. This content isn’t available, try again later.'), 'blocked');
  assert.equal(c("Sign in to confirm you're not a bot"), 'blocked');
  assert.equal(c('Unable to download API page: HTTP Error 429: Too Many Requests'), 'blocked');
  assert.equal(c('Video unavailable'), 'unavailable');
  assert.equal(c('This video is DRM protected'), 'drm_protected');
  assert.equal(c('This live event will begin in 3 hours.'), 'upcoming');
  assert.equal(c("Unable to download API page: ('Unable to connect to proxy', OSError('Tunnel connection failed: 403 Forbidden'))"), 'network');
  assert.equal(classifyYtdlpError('', { timedOut: true }).status, 504);
  assert.equal(c('something new'), 'extraction_failed');
});

test('yt-dlp args: no credentials can be injected via YTDLP_EXTRA_ARGS', () => {
  process.env.YTDLP_EXTRA_ARGS = '["--cookies","/tmp/c.txt"]';
  try { assert.ok(!buildYtdlpArgs('dQw4w9WgXcQ', 'ios', {}).includes('--cookies')); }
  finally { delete process.env.YTDLP_EXTRA_ARGS; }
  process.env.YTDLP_EXTRA_ARGS = '["--extractor-args","youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416"]';
  try { assert.ok(buildYtdlpArgs('dQw4w9WgXcQ', 'ios', {}).includes('youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416')); }
  finally { delete process.env.YTDLP_EXTRA_ARGS; }
});

const F = (itag, o) => normalizeFormat({ format_id: String(itag), protocol: 'https', url: `https://r1.googlevideo.com/videoplayback?itag=${itag}`, ext: 'mp4', container: 'mp4_dash', vcodec: 'none', acodec: 'none', ...o });
const LADDER = [
  F(160, { vcodec: 'avc1.4d400c', width: 256, height: 144, fps: 30, vbr: 100 }),
  F(136, { vcodec: 'avc1.4d401f', width: 1280, height: 720, fps: 30, vbr: 1500 }),
  F(298, { vcodec: 'avc1.4d4020', width: 1280, height: 720, fps: 60, vbr: 2500 }),
  F(137, { vcodec: 'avc1.640028', width: 1920, height: 1080, fps: 30, vbr: 4000 }),
  F(299, { vcodec: 'avc1.64002a', width: 1920, height: 1080, fps: 60, vbr: 6000 }),
  F(248, { vcodec: 'vp9', ext: 'webm', container: 'webm_dash', width: 1920, height: 1080, fps: 30 }),
  F(401, { vcodec: 'av01.0.12M.08', width: 3840, height: 2160, fps: 30 }),
  F(139, { acodec: 'mp4a.40.5', ext: 'm4a', container: 'm4a_dash', abr: 48 }),
  F(140, { acodec: 'mp4a.40.2', ext: 'm4a', container: 'm4a_dash', abr: 129 }),
  F(251, { acodec: 'opus', ext: 'webm', container: 'webm_dash', abr: 140 }),
  F(18, { vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', width: 640, height: 360, container: 'mp4' }),
];

test('formats: 1080p H.264 + AAC-LC by default; fps and height caps respected', () => {
  assert.equal(pickVideo(LADDER).itag, 299);
  assert.equal(pickVideo(LADDER, { maxFps: 30 }).itag, 137);
  assert.equal(pickVideo(LADDER, { maxHeight: 720, maxFps: 30 }).itag, 136);
  assert.equal(pickAudio(LADDER).itag, 140);
  assert.equal(normalizeFormat({ format_id: '96', protocol: 'm3u8_native', url: 'https://x/m.m3u8', vcodec: 'avc1', acodec: 'mp4a.40.2' }), null);
  assert.equal(normalizeFormat({ format_id: '137', protocol: 'https', url: 'https://x/v', vcodec: 'avc1', acodec: 'none', has_drm: true }), null);
});

test('formats: delivery plan (auto = muxed on Tesla UA, dual elsewhere; progressive/transcode fallbacks)', () => {
  const tesla = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Tesla/2025.20.6';
  assert.equal(planDelivery(LADDER, { userAgent: tesla }).delivery, 'muxed');
  assert.equal(planDelivery(LADDER, { userAgent: 'Mozilla/5.0 Chrome/140' }).delivery, 'dual');
  assert.equal(planDelivery(LADDER, { delivery: 'dual', userAgent: tesla }).delivery, 'dual');
  const prog = planDelivery([LADDER.at(-1)]);
  assert.deepEqual([prog.delivery, prog.video.itag, prog.audio, prog.reason], ['muxed', 18, null, 'progressive-only']);
  const vp9 = planDelivery([LADDER[5], LADDER[9]]);
  assert.deepEqual([vp9.delivery, vp9.video.itag, vp9.audio.itag, vp9.transcode], ['muxed', 248, 251, { video: true, audio: true }]);
  assert.equal(planDelivery([LADDER[9]]), null);
});

test('egress: rotation pool skips cooled-down proxies; IPv6 prefix randomizes the host part; CDN host pinning', async () => {
  process.env.PROXY_URLS = 'http://a.example:8080,http://b.example:8080';
  try {
    const first = await pickEgress();
    await reportBlocked(first, 'test');
    for (let i = 0; i < 4; i++) assert.notEqual((await pickEgress()).id, first.id);
  } finally { delete process.env.PROXY_URLS; }
  const a = randomIpv6InPrefix('2a01:4f8:c0c:1234::/64'), b = randomIpv6InPrefix('2a01:4f8:c0c:1234::/64');
  assert.match(a, /^2a01:4f8:c0c:1234(:[0-9a-f]{1,4}){4}$/);
  assert.notEqual(a, b);
  assert.throws(() => randomIpv6InPrefix('10.0.0.0/8'));
  const prev = { h: process.env.CDN_ALLOWED_HOSTS, p: process.env.MEDIA_ALLOW_PRIVATE_NETWORK };
  delete process.env.CDN_ALLOWED_HOSTS; delete process.env.MEDIA_ALLOW_PRIVATE_NETWORK;
  try {
    assertCdnUrl('https://rr3---sn-4g5e6nzz.googlevideo.com/videoplayback?itag=137');
    assert.throws(() => assertCdnUrl('https://evil.example/videoplayback'), /not allowed/);
    assert.throws(() => assertCdnUrl('http://rr3---sn-4g5e6nzz.googlevideo.com/videoplayback'), /https/);
  } finally { process.env.CDN_ALLOWED_HOSTS = prev.h; process.env.MEDIA_ALLOW_PRIVATE_NETWORK = prev.p; }
});
