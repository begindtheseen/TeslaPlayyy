// End-to-end: pasted YouTube link -> /api/playback/session -> (muxed | dual) -> worker -> WebCodecs ->
// OffscreenCanvas + Web Audio, against a real `next start` with real FFmpeg.
// YouTube itself is replaced by the fake yt-dlp + fake googlevideo CDN (test/helpers/fakeYoutube.js)
// serving a 36 s H.264 High + AAC DASH clip; outbound YouTube access is not available in CI.
// Needs a Chrome with proprietary codecs: CHROME_PATH=/path/to/chrome-for-testing/chrome.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { startFakeCdn, fakeYoutubeEnv } from '../helpers/fakeYoutube.js';

const PORT = 3218;
const BASE = `http://localhost:${PORT}`;
const VID = 'dQw4w9WgXcQ';
let server, browser, cdn;
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const record = (name, outcome, note = '') => results.push({ name, outcome, note });

async function waitFor(fn, { timeout = 20000, interval = 100, msg = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(interval); }
  throw new Error(`Timed out waiting for ${msg} (last=${JSON.stringify(last)})`);
}

before(async () => {
  cdn = await startFakeCdn({ maxRangeBytes: 1024 * 1024 });
  // Run next directly (not via npx) so killing `server` stops the actual listener.
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(PORT)], {
    // 512 KiB upstream chunks against a CDN that refuses >1 MiB ranges: exercises chunked relaying.
    env: { ...process.env, ...fakeYoutubeEnv(cdn), CDN_CHUNK_BYTES: String(512 * 1024) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', d => process.stderr.write(d));
  await waitFor(async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok, { timeout: 60000, msg: 'next start' });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--autoplay-policy=user-gesture-required'] });
});

after(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
  await cdn?.close();
  console.log('\nE2E_YOUTUBE_RESULTS ' + JSON.stringify(results, null, 1));
});

async function newPage(query = '') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.blocked = [];
  page.on('request', r => { if (/youtube\.com|googlevideo\.com/.test(r.url())) page.blocked.push(r.url()); });
  await page.goto(BASE + '/' + query);
  return page;
}

const engineState = page => page.evaluate(() => {
  const e = window.__canvasTube.engines.canvas;
  return { t: e.currentTime(), running: e.running, mode: e.mode, ready: e.ready, ended: e.ended, level: e.audioLevel(), ctx: e.ctx?.state,
    delivery: e.session?.canvas?.delivery, stats: window.__canvasTube.stats || null };
});

// Brightness of the fixture's sync box (top-left 160x90 of 640x360) in the on-screen canvas.
async function boxBrightness(page) {
  const box = await page.locator('[data-testid=canvas]').boundingBox();
  const png = await page.screenshot({ clip: { x: box.x + box.width * 0.03, y: box.y + box.height * 0.05, width: box.width * 0.18, height: box.height * 0.15 } });
  return page.evaluate(async b64 => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = new OffscreenCanvas(img.width, img.height); const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, img.width, img.height).data; let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
    return s / (d.length / 4) / 3;
  }, png.toString('base64'));
}

async function canvasHash(page) {
  const png = await page.locator('[data-testid=canvas]').screenshot();
  let h = 0; for (let i = 0; i < png.length; i += 7) h = (h * 31 + png[i]) >>> 0; return h;
}

// Black-box A/V sync: the sync box flashes and the tone beeps during [k, k+0.25) s of media time.
// Sample (media clock, box brightness, audio RMS) and estimate each marker's lag from the phase of the
// media clock at which it is observed: lag = mean(phase while ON) - 0.125 s.
async function measureSync(page, ms = 5000) {
  const on = { video: [], audio: [] };
  const end = Date.now() + ms;
  let n = 0;
  while (Date.now() < end) {
    const a = await engineState(page);
    const bright = await boxBrightness(page);
    const b = await engineState(page);
    if (!a.running || !b.running) continue;
    const phase = (((a.t + b.t) / 2) % 1 + 1) % 1;
    n++;
    if (bright > 200) on.video.push(phase);
    if (Math.max(a.level, b.level) > 0.05) on.audio.push(phase);
  }
  // Phases just after a wrap belong to the previous window's tail only when lag < 0; unwrap >0.75.
  const lag = xs => xs.length ? (xs.map(p => (p > 0.75 ? p - 1 : p)).reduce((s, p) => s + p, 0) / xs.length - 0.125) * 1000 : NaN;
  return { samples: n, videoOn: on.video.length, audioOn: on.audio.length, videoLagMs: lag(on.video), audioLagMs: lag(on.audio), avOffsetMs: lag(on.video) - lag(on.audio) };
}

async function playPasted(page, url = `https://youtu.be/${VID}`) {
  await page.fill('[data-testid=search-input]', url);
  await page.click('[data-testid=search-btn]');
  await waitFor(async () => (await engineState(page)).running, { msg: 'clock running' });
}

for (const [label, query, delivery] of [['Intel path (?intel=1)', '?intel=1', 'muxed'], ['AMD path (?intel=0)', '?intel=0', 'dual']]) {
  test(`${label}: pasted YouTube link plays on canvas with synced audio, pause/resume, seek, no leaks`, async () => {
    const relayBytes = async () => (await (await fetch(`${BASE}/api/health`)).json()).relay.bytes;
    const bytesAtStart = await relayBytes();
    const page = await newPage(query);
    const t0 = Date.now();
    await playPasted(page);
    const startupMs = Date.now() - t0;
    const s0 = await engineState(page);
    assert.equal(s0.delivery, delivery);
    assert.equal(s0.mode, 'audio', 'audio-master clock');
    assert.equal(s0.ctx, 'running');
    assert.equal(await page.locator('video, iframe').count(), 0, 'no <video>/<iframe> in the custom path');
    assert.match(await page.textContent('[data-testid=player-notice]'), delivery === 'muxed' ? /server-muxed MPEG-TS/ : /DASH video \+ audio/);

    // Moving frames.
    const h1 = await canvasHash(page); await sleep(600); const h2 = await canvasHash(page);
    assert.notEqual(h1, h2, 'canvas not changing');

    // A/V sync, black-box and against the audio clock.
    const sync = await measureSync(page, 5000);
    assert.ok(sync.videoOn >= 3 && sync.audioOn >= 3, `markers not observed ${JSON.stringify(sync)}`);
    assert.ok(Math.abs(sync.avOffsetMs) < 80, `A/V offset ${sync.avOffsetMs.toFixed(1)} ms`);
    const st1 = (await engineState(page)).stats;
    const avgLate = st1.lateSumMs / st1.presented;
    assert.ok(avgLate < 25, `avg video lateness vs audio clock ${avgLate} ms`);

    // Pause freezes clock and picture; resume continues.
    await page.click('[data-testid=btn-play]');
    await sleep(300);
    const p1 = await engineState(page), ph1 = await canvasHash(page); await sleep(800); const p2 = await engineState(page), ph2 = await canvasHash(page);
    assert.equal(p1.running, false);
    assert.ok(Math.abs(p2.t - p1.t) < 0.02, 'clock moved while paused');
    assert.equal(ph1, ph2, 'picture changed while paused');
    await page.click('[data-testid=btn-play]');
    await waitFor(async () => { const s = await engineState(page); return s.running && s.t > p2.t + 0.3; }, { msg: 'resume' });

    // Seek far ahead (byte-range seek), then rapid seeks: decoders and server streams must not leak.
    await page.evaluate(() => window.__canvasTube.engines.canvas.seek(25));
    const seekT0 = Date.now();
    await waitFor(async () => { const s = await engineState(page); return s.running && s.t >= 25 && s.t < 26.5; }, { msg: 'seek to 25 s' });
    const seekMs = Date.now() - seekT0;
    const bytesBefore = await relayBytes();
    for (let i = 0; i < 12; i++) { await page.evaluate(t => window.__canvasTube.engines.canvas.seek(t), (i * 2.7) % 33); await sleep(80); }
    await page.evaluate(() => window.__canvasTube.engines.canvas.seek(10));
    await waitFor(async () => { const s = await engineState(page); return s.running && s.t >= 10 && s.t < 11.5; }, { msg: 'final seek to 10 s' });
    const seekBurstBytes = await relayBytes() - bytesBefore;
    const syncAfterSeek = await measureSync(page, 3000);
    assert.ok(Math.abs(syncAfterSeek.avOffsetMs) < 80, `A/V offset after seeks ${syncAfterSeek.avOffsetMs}`);
    const st2 = (await engineState(page)).stats;
    assert.ok(st2.openDecoders <= 2, `open decoders after 14 seeks: ${st2.openDecoders}`);
    const health = await waitFor(async () => { const h = await (await fetch(`${BASE}/api/health`)).json(); return h.activeStreams <= 1 && h.activeRelays <= (delivery === 'dual' ? 2 : 2) && h; }, { msg: 'server streams released' });

    // Play to the end.
    await page.evaluate(() => window.__canvasTube.engines.canvas.seek(33));
    await waitFor(() => page.getAttribute('[data-testid=player]', 'data-ended').then(v => v === 'true'), { timeout: 15000, msg: 'ended' });
    const totalBytes = await relayBytes() - bytesAtStart;
    assert.deepEqual(page.errors, []);
    assert.deepEqual(page.blocked, [], 'the browser must never contact YouTube/googlevideo directly');
    record(`${label}: plays, A/V sync, pause/resume, seek, 14 rapid seeks, ends`, 'pass',
      `delivery=${delivery} startup=${startupMs}ms seek25=${seekMs}ms avOffset=${sync.avOffsetMs.toFixed(1)}ms (video lag ${sync.videoLagMs.toFixed(1)} / audio lag ${sync.audioLagMs.toFixed(1)}, n=${sync.samples}) afterSeeks=${syncAfterSeek.avOffsetMs.toFixed(1)}ms avgLate=${avgLate.toFixed(1)}ms maxLate=${st1.lateMaxMs.toFixed(1)}ms dropped=${st1.dropped}/${st1.presented + st1.dropped} openDecoders=${st2.openDecoders} activeStreams=${health.activeStreams} activeRelays=${health.activeRelays} relayedMB total=${(totalBytes / 1e6).toFixed(1)} rapidSeeks=${(seekBurstBytes / 1e6).toFixed(1)} (clip ${((cdn.files && 2.7) || 0)} MB)`);
    await page.close();
  });
}

test('auto delivery: desktop Chrome probe picks dual; Tesla UA without GPU info picks muxed', async () => {
  const page = await newPage();
  await page.locator('[data-testid=platform]').waitFor();
  assert.match(await page.textContent('[data-testid=platform]'), /desktop-class browser/);
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Tesla/2025.20.6', viewport: { width: 1280, height: 900 } });
  const tp = await ctx.newPage();
  await tp.goto(BASE);
  await tp.fill('[data-testid=search-input]', `https://youtu.be/${VID}`);
  await tp.click('[data-testid=search-btn]');
  await waitFor(async () => (await tp.evaluate(() => window.__canvasTube.engines.canvas.session?.canvas?.delivery)) === 'muxed', { msg: 'Tesla -> muxed' });
  record('Auto delivery: desktop -> dual, Tesla UA (no GPU match) -> muxed @30fps cap', 'pass', await tp.textContent('[data-testid=platform]'));
  await ctx.close(); await page.close();
});

test('error states: private, age-gated, region-locked, removed, live show clear messages (no bypass)', async () => {
  const page = await newPage();
  const cases = { PRIVATEVID0: /Private video/, AGEGATED000: /Age-restricted/, REGIONLOCK0: /Not available in this region/, REMOVED0000: /Video unavailable/, LIVESTREAM0: /Live stream/ };
  for (const [id, title] of Object.entries(cases)) {
    await page.fill('[data-testid=search-input]', `https://www.youtube.com/watch?v=${id}`);
    await page.click('[data-testid=search-btn]');
    await waitFor(async () => title.test((await page.textContent('[data-testid=error-title]').catch(() => '')) || ''), { msg: `${id} error` });
  }
  await page.fill('[data-testid=search-input]', 'https://youtu.be/ALWAYSBLOCK');
  await page.click('[data-testid=search-btn]');
  await waitFor(async () => /rate-limiting/.test((await page.textContent('[data-testid=error-title]').catch(() => '')) || ''), { msg: 'blocked error' });
  assert.equal(await page.locator('[data-testid=btn-retry]').count(), 1, 'blocked is retryable');
  assert.deepEqual(page.errors, []);
  record('Errors: private/age/region/removed/live/blocked -> specific headline + server message; retry offered for blocked', 'pass');
  await page.close();
});

test('health: extraction success rate reported', async () => {
  const h = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(h.ytdlp.available, true);
  assert.ok(h.extraction.requests >= 3);
  assert.equal(typeof h.extraction.successRate, 'number');
  record('Health: /api/health extraction stats', 'pass', JSON.stringify({ requests: h.extraction.requests, successRate: h.extraction.successRate, byCode: h.extraction.byCode, cacheHits: h.extraction.cacheHits }));
});
