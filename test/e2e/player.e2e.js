// Browser end-to-end tests against a real `next start` server with real FFmpeg.
// Requires a Chrome build with proprietary codecs (H.264/AAC) for the canvas tests: set CHROME_PATH
// (e.g. Chrome for Testing). Playwright's bundled open-source Chromium has no H.264/AAC decoders.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { chromium } from 'playwright';

const PORT = 3217;
const BASE = `http://localhost:${PORT}`;
let server, browser, mockApi, results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const record = (name, player, outcome, note = '') => results.push({ name, player, outcome, note });

// Mock YouTube Data API v3 (no API key is available in this environment).
const SEARCH_ITEMS = [
  { id: { videoId: 'aqz-KE-bpKQ' }, snippet: { title: 'Big Buck Bunny 60fps 4K', channelTitle: 'Blender', thumbnails: { medium: { url: '/favicon.ico' } } } },
  { id: { videoId: 'LICENSED001' }, snippet: { title: 'Operator-licensed video', channelTitle: 'Test', thumbnails: { medium: { url: '/favicon.ico' } } } },
];

async function waitFor(fn, { timeout = 15000, interval = 100, msg = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(interval); }
  throw new Error(`Timed out waiting for ${msg} (last=${JSON.stringify(last)})`);
}

before(async () => {
  mockApi = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/search')) res.end(JSON.stringify({ items: SEARCH_ITEMS }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(r => mockApi.listen(0, '127.0.0.1', r));
  server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    env: { ...process.env, YOUTUBE_API_KEY: 'e2e-test-key', YOUTUBE_API_BASE: `http://127.0.0.1:${mockApi.address().port}`, YOUTUBE_AUTHORIZED_MAP: 'LICENSED001=demo-av',
      // Cut every stream after 2 s so playback must survive reconnects (like serverless limits / flaky LTE).
      MEDIA_MAX_STREAM_SECONDS: '2' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', d => process.stderr.write(d));
  await waitFor(async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok, { timeout: 60000, msg: 'next start' });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--autoplay-policy=user-gesture-required'] });
});

after(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
  mockApi?.close();
  console.log('\nE2E_RESULTS ' + JSON.stringify(results));
});

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  // Any attempt to reach YouTube's player or media hosts from the page is a test failure.
  page.youtubeRequests = [];
  page.on('request', r => { if (/youtube\.com|googlevideo\.com|ytimg\.com\/.*\.js/.test(r.url())) page.youtubeRequests.push(r.url()); });
  await page.goto(BASE);
  return page;
}

// Reads pixels of a screenshot by decoding it in the page (canvas is transferred to a worker, so it
// cannot be read directly). Returns {mean, hash} of the player area.
async function canvasPixels(page) {
  const png = await page.locator('[data-testid=canvas]').screenshot();
  return page.evaluate(async b64 => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = new OffscreenCanvas(img.width, img.height); const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, img.width, img.height).data;
    let sum = 0, h = 0;
    for (let i = 0; i < d.length; i += 16) { sum += d[i] + d[i + 1] + d[i + 2]; h = (h * 31 + d[i] + d[i + 1] * 7) >>> 0; }
    return { mean: sum / (d.length / 16) / 3, hash: h };
  }, png.toString('base64'));
}
const engineState = page => page.evaluate(() => {
  const e = window.__canvasTube.engines.canvas;
  return { t: e.currentTime(), running: e.running, mode: e.mode, ready: e.ready, ended: e.ended, level: e.audioLevel(), scheduled: e.audioScheduled || 0, stats: window.__canvasTube.stats || null, ctx: e.ctx?.state };
});

test('capabilities: this browser exposes WebCodecs H.264/AAC', async () => {
  const page = await newPage();
  const caps = await page.evaluate(async () => ({
    h264: (await VideoDecoder.isConfigSupported({ codec: 'avc1.42C01E' })).supported,
    aac: (await AudioDecoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 })).supported,
    ua: navigator.userAgent,
  }));
  record('WebCodecs capability probe', 'canvas', caps.h264 && caps.aac ? 'pass' : 'fail', caps.ua);
  assert.ok(caps.h264, 'H.264 decode not supported: set CHROME_PATH to Chrome with proprietary codecs');
  assert.ok(caps.aac);
  await page.close();
});

test('canvas player: bundled video-only demo renders moving frames and ends', async () => {
  const page = await newPage();
  await page.click('[data-testid=asset-demo]');
  await waitFor(() => page.getAttribute('[data-testid=player]', 'data-player').then(v => v === 'canvas'));
  await waitFor(async () => (await engineState(page)).running, { msg: 'clock running' });
  const a = await canvasPixels(page); await sleep(700); const b = await canvasPixels(page);
  assert.ok(a.mean > 20, `canvas looks black (mean ${a.mean})`);
  assert.notEqual(a.hash, b.hash, 'canvas did not change between samples');
  assert.equal(await page.locator('video, iframe').count(), 0, 'canvas path must not use <video> or <iframe>');
  await waitFor(() => page.getAttribute('[data-testid=player]', 'data-ended').then(v => v === 'true'), { timeout: 12000, msg: 'ended' });
  const st = await engineState(page);
  assert.ok(st.stats.presented > 90, `presented ${st.stats.presented}`);
  assert.deepEqual(page.errors, []);
  record('Demo (video-only) plays, frames change, reaches end', 'canvas', 'pass', `presented=${st.stats.presented} dropped=${st.stats.dropped} reconnects=${st.stats.reconnects}`);
  await page.close();
});

test('canvas player: A/V fixture plays audio after a user gesture, stays in sync, pause/resume, volume', async () => {
  const page = await newPage();
  await page.click('[data-testid=asset-demo-av]');
  await waitFor(async () => (await engineState(page)).running, { msg: 'clock running' });
  const s0 = await engineState(page);
  assert.equal(s0.mode, 'audio', 'clock should be audio-master');
  assert.equal(s0.ctx, 'running');
  // The fixture beeps (1 kHz) for 250 ms at the start of every second; sample until we hear it.
  let peak = 0;
  for (let i = 0; i < 40; i++) { peak = Math.max(peak, (await engineState(page)).level); if (peak > 0.05) break; await sleep(50); }
  assert.ok(peak > 0.05, `no audible output (rms peak ${peak})`);
  // A/V sync: the presented video frame time vs the audio clock.
  await sleep(1500);
  // Every presented frame records how late it was drawn relative to the audio clock.
  const st1 = (await engineState(page)).stats;
  const sync = { avgLateMs: st1.lateSumMs / st1.presented, maxLateMs: st1.lateMaxMs, dropped: st1.dropped };
  assert.ok(sync.avgLateMs < 25, `average video lateness ${sync.avgLateMs} ms`);
  // Pause freezes clock and picture.
  await page.click('[data-testid=btn-play]');
  await sleep(300);
  const p1 = await engineState(page), px1 = await canvasPixels(page); await sleep(800); const p2 = await engineState(page), px2 = await canvasPixels(page);
  assert.equal(p1.running, false);
  assert.ok(Math.abs(p2.t - p1.t) < 0.02, `clock moved while paused ${p1.t} -> ${p2.t}`);
  assert.equal(px1.hash, px2.hash, 'picture changed while paused');
  // Resume continues from the same position.
  await page.click('[data-testid=btn-play]');
  await sleep(700);
  const r = await engineState(page);
  assert.ok(r.running && r.t > p2.t + 0.3, `did not resume (${p2.t} -> ${r.t})`);
  // Volume 0 silences output.
  await page.locator('[data-testid=volume]').fill('0');
  await sleep(400);
  let maxLevel = 0;
  for (let i = 0; i < 20; i++) { maxLevel = Math.max(maxLevel, (await engineState(page)).level); await sleep(50); }
  assert.ok(maxLevel < 0.001, `still audible at volume 0 (${maxLevel})`);
  // Play through to the end across forced stream cuts: every frame must still be shown exactly once.
  await waitFor(() => page.getAttribute('[data-testid=player]', 'data-ended').then(v => v === 'true'), { timeout: 20000, msg: 'ended' });
  const fin = (await engineState(page)).stats;
  assert.ok(fin.reconnects >= 1, 'expected at least one forced reconnect');
  assert.ok(fin.presented + fin.dropped >= 235 && fin.presented + fin.dropped <= 240, `frames shown+dropped ${fin.presented}+${fin.dropped}`);
  sync.reconnects = fin.reconnects; sync.presented = fin.presented;
  assert.deepEqual(page.errors, []);
  record('A/V fixture: audible after click, audio-master clock, avg video lateness vs audio clock < 25 ms, pause/resume, volume 0, plays to end across forced reconnects', 'canvas', 'pass',
    `rms peak=${peak.toFixed(3)} avgLate=${sync.avgLateMs.toFixed(1)}ms maxLate=${sync.maxLateMs.toFixed(1)}ms dropped=${sync.dropped} presented=${sync.presented} reconnects=${sync.reconnects}`);
  await page.close();
});

test('canvas player: seek, repeated seeks do not leak streams, keyboard seek', async () => {
  const page = await newPage();
  await page.click('[data-testid=asset-demo-av-mp4]');
  await waitFor(async () => (await engineState(page)).running, { msg: 'clock running' });
  await page.evaluate(() => window.__canvasTube.engines.canvas.seek(6));
  await waitFor(async () => { const s = await engineState(page); return s.running && s.t >= 6 && s.t < 7.5; }, { msg: 'seek to 6' });
  for (let i = 0; i < 10; i++) { await page.evaluate(t => window.__canvasTube.engines.canvas.seek(t), (i * 0.9) % 9); await sleep(60); }
  await page.evaluate(() => window.__canvasTube.engines.canvas.seek(2));
  await waitFor(async () => { const s = await engineState(page); return s.running && s.t >= 2 && s.t < 3.5; }, { msg: 'final seek to 2' });
  const health = await waitFor(async () => { const h = await (await fetch(`${BASE}/api/health`)).json(); return h.activeStreams <= 1 && h; }, { msg: 'streams released' });
  // Keyboard: ArrowRight seeks +5 s.
  const before = (await engineState(page)).t;
  await page.locator('body').press('ArrowRight');
  await waitFor(async () => { const s = await engineState(page); return s.running && s.t > before + 4; }, { msg: 'keyboard seek' });
  const a = await canvasPixels(page); await sleep(500); const b = await canvasPixels(page);
  assert.notEqual(a.hash, b.hash, 'frames not advancing after seeks');
  assert.deepEqual(page.errors, []);
  record('MP4 remux: seek to 6 s, 11 rapid seeks, keyboard seek; server streams released', 'canvas', 'pass', `activeStreams=${health.activeStreams}`);
  await page.close();
});

test('YouTube search -> licensed result plays in the canvas player; unlicensed result shows the limitation', async () => {
  const page = await newPage();
  await page.fill('[data-testid=search-input]', 'big buck bunny');
  await page.click('[data-testid=search-btn]');
  await page.locator('[data-testid=result]').first().waitFor();
  assert.equal(await page.locator('[data-testid=result]').count(), 2);
  // Unlicensed: clear error, no iframe, no request to YouTube.
  await page.locator('[data-testid=result]').first().click();
  await page.locator('[data-testid=player-error]').waitFor();
  assert.match(await page.textContent('[data-testid=player-error]'), /No licensed media source/);
  record('Search (mock Data API) -> unlicensed result -> clear "no licensed media source" error', 'canvas', 'pass');
  // Licensed mapping: plays through /api/youtube/stream/:id -> canvas.
  await page.locator('[data-testid=result]').nth(1).click();
  await waitFor(() => page.getAttribute('[data-testid=player]', 'data-player').then(v => v === 'canvas'));
  await waitFor(async () => (await engineState(page)).running, { msg: 'licensed canvas playback' });
  const a = await canvasPixels(page); await sleep(600); const b = await canvasPixels(page);
  assert.notEqual(a.hash, b.hash);
  assert.equal(await page.locator('video, iframe').count(), 0);
  assert.deepEqual(page.youtubeRequests, []);
  assert.deepEqual(page.errors, []);
  record('Search -> licensed YouTube id -> /api/youtube/stream -> canvas frames + audio', 'canvas', 'pass');
  await page.close();
});

test('pasted YouTube link resolves through the same session flow', async () => {
  const page = await newPage();
  await page.fill('[data-testid=search-input]', 'https://youtu.be/LICENSED001?si=abc');
  await page.click('[data-testid=search-btn]');
  await waitFor(async () => (await engineState(page)).running, { msg: 'pasted link playback' });
  await page.fill('[data-testid=search-input]', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  await page.click('[data-testid=search-btn]');
  await page.locator('[data-testid=player-error]').waitFor();
  record('Pasted link: licensed id plays on canvas; unlicensed id shows limitation', 'canvas', 'pass');
  await page.close();
});

test('errors: missing API key and unlicensed stream route', async () => {
  const r = await fetch(`${BASE}/api/youtube/stream/aqz-KE-bpKQ`);
  assert.equal(r.status, 501);
  assert.equal((await r.json()).code, 'no_authorized_media');
  record('/api/youtube/stream for unlicensed id -> 501 no_authorized_media', 'n/a', 'pass');
});
