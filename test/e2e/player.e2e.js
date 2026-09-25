// Browser end-to-end tests against a real `next start` server with real FFmpeg.
// Requires a Chrome build with proprietary codecs (H.264/AAC) for the canvas tests: set CHROME_PATH
// (e.g. Chrome for Testing). Playwright's bundled open-source Chromium has no H.264/AAC decoders.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { chromium } from 'playwright';
import { YT_STUB } from './youtube-stub.js';

const PORT = 3217;
const BASE = `http://localhost:${PORT}`;
let server, browser, mockApi, results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const record = (name, player, outcome, note = '') => results.push({ name, player, outcome, note });

// Mock YouTube Data API v3 (no API key is available in this environment).
const SEARCH_ITEMS = [
  { id: { videoId: 'aqz-KE-bpKQ' }, snippet: { title: 'Big Buck Bunny 60fps 4K', channelTitle: 'Blender', thumbnails: { medium: { url: '/favicon.ico' } } } },
  { id: { videoId: 'NOEMBED0001' }, snippet: { title: 'Embedding disabled video', channelTitle: 'Test', thumbnails: { medium: { url: '/favicon.ico' } } } },
  { id: { videoId: 'LICENSED001' }, snippet: { title: 'Operator-licensed video (canvas)', channelTitle: 'Test', thumbnails: { medium: { url: '/favicon.ico' } } } },
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
    env: { ...process.env, YOUTUBE_API_KEY: 'e2e-test-key', YOUTUBE_API_BASE: `http://127.0.0.1:${mockApi.address().port}`, YOUTUBE_AUTHORIZED_MAP: 'LICENSED001=demo-av' },
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

async function newPage({ stubYouTube = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  if (stubYouTube) await page.route('https://www.youtube.com/iframe_api', r => r.fulfill({ contentType: 'text/javascript', body: YT_STUB }));
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
  record('Demo (video-only) plays, frames change, reaches end', 'canvas', 'pass', `presented=${st.stats.presented} dropped=${st.stats.dropped}`);
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
  const sync = await page.evaluate(() => { const e = window.__canvasTube.engines.canvas; return { clock: e.currentTime(), frame: e.lastFrameTime }; });
  assert.ok(Math.abs(sync.clock - sync.frame) < 0.3, `A/V offset ${sync.clock - sync.frame}`);
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
  assert.deepEqual(page.errors, []);
  record('A/V fixture: audible after click, audio-master clock, A/V offset < 300 ms, pause/resume, volume 0', 'canvas', 'pass',
    `rms peak=${peak.toFixed(3)} offset=${(sync.clock - sync.frame).toFixed(3)}s`);
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

test('YouTube: search -> select -> official IFrame player controlled via API (stubbed youtube.com)', async () => {
  const page = await newPage();
  await page.fill('[data-testid=search-input]', 'big buck bunny');
  await page.click('[data-testid=search-btn]');
  await page.locator('[data-testid=result]').first().waitFor();
  assert.equal(await page.locator('[data-testid=result]').count(), 3);
  await page.locator('[data-testid=result]').first().click();
  await waitFor(() => page.getAttribute('[data-testid=player]', 'data-player').then(v => v === 'youtube'));
  await waitFor(() => page.getAttribute('[data-testid=player]', 'data-playing').then(v => v === 'true'));
  assert.equal(await page.locator('[data-testid=yt-host] iframe').count(), 1);
  await page.click('[data-testid=btn-play]'); // pause
  await page.locator('[data-testid=volume]').fill('0.5');
  await page.locator('body').press('ArrowRight');
  const calls = await page.evaluate(() => window.__ytCalls);
  const names = calls.map(c => c[0]);
  assert.deepEqual(calls[0].slice(0, 2), ['new', 'aqz-KE-bpKQ']);
  for (const n of ['playVideo', 'pauseVideo', 'setVolume', 'seekTo']) assert.ok(names.includes(n), `${n} not called: ${names}`);
  assert.ok(calls.some(c => c[0] === 'setVolume' && c[1] === 50));
  assert.match(await page.textContent('[data-testid=player-notice]'), /official YouTube player/);
  assert.deepEqual(page.errors, []);
  record('Search (mock Data API) -> select -> IFrame player: play/pause/volume/seek commands', 'youtube-iframe (stubbed)', 'pass', names.join(','));
  // Embedding disabled -> clear error
  await page.locator('[data-testid=result]').nth(1).click();
  await page.locator('[data-testid=player-error]').waitFor();
  assert.match(await page.textContent('[data-testid=player-error]'), /does not allow this video to be played in embedded players/);
  record('Embedding-disabled video shows a clear error (YT error 150)', 'youtube-iframe (stubbed)', 'pass');
  // Operator-licensed mapping -> canvas player with real media bytes
  await page.locator('[data-testid=result]').nth(2).click();
  await waitFor(() => page.getAttribute('[data-testid=player]', 'data-player').then(v => v === 'canvas'));
  await waitFor(async () => (await engineState(page)).running, { msg: 'licensed canvas playback' });
  assert.equal(await page.locator('[data-testid=yt-host] iframe').count(), 0, 'iframe should be torn down when switching players');
  record('YouTube id mapped to licensed asset (YOUTUBE_AUTHORIZED_MAP) plays in canvas player', 'canvas', 'pass');
  await page.close();
});

test('YouTube: pasted link plays without search', async () => {
  const page = await newPage();
  await page.fill('[data-testid=search-input]', 'https://youtu.be/aqz-KE-bpKQ?si=abc');
  await page.click('[data-testid=search-btn]');
  await waitFor(() => page.getAttribute('[data-testid=player]', 'data-player').then(v => v === 'youtube'));
  const calls = await page.evaluate(() => window.__ytCalls);
  assert.deepEqual(calls[0].slice(0, 2), ['new', 'aqz-KE-bpKQ']);
  record('Pasted youtu.be link opens IFrame player', 'youtube-iframe (stubbed)', 'pass');
  await page.close();
});

test('errors: unreachable youtube.com and missing API key are reported to the user', async () => {
  const page = await newPage({ stubYouTube: false });
  await page.route('https://www.youtube.com/**', r => r.abort('internetdisconnected'));
  await page.fill('[data-testid=search-input]', 'aqz-KE-bpKQ');
  await page.click('[data-testid=search-btn]');
  await page.locator('[data-testid=player-error]').waitFor({ timeout: 20000 });
  assert.match(await page.textContent('[data-testid=player-error]'), /Could not load the YouTube IFrame API/);
  record('youtube.com blocked -> clear error', 'youtube-iframe', 'pass');
  await page.close();
  const r = await fetch(`${BASE}/api/youtube/stream/aqz-KE-bpKQ`);
  assert.equal(r.status, 501);
  assert.equal((await r.json()).code, 'no_authorized_media');
  record('/api/youtube/stream for unlicensed id -> 501 no_authorized_media', 'n/a', 'pass');
});

test('real YouTube reachability (informational)', async () => {
  const ok = await fetch('https://www.youtube.com/iframe_api', { signal: AbortSignal.timeout(8000) }).then(r => r.ok, () => false);
  record('Real youtube.com IFrame playback', 'youtube-iframe', ok ? 'reachable (not asserted)' : 'NOT RUN: youtube.com unreachable from this environment');
});
