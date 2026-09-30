// Record-only performance comparison of the two YouTube delivery paths under a constrained CPU:
// 1080p60 H.264 High + AAC (20 s), Chrome pinned to N cores with `taskset` (headless = software
// decode, like a Tesla MCU without hardware decode). A proxy for the Intel Atom MCU, not a substitute.
// Run: CHROME_PATH=... PERF_CORES=1,2,4 npm run test:perf
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startFakeCdn, fakeYoutubeEnv } from '../helpers/fakeYoutube.js';

const PORT = 3219, BASE = `http://localhost:${PORT}`;
const CORES = (process.env.PERF_CORES || '1,2').split(',').map(Number);
const PLAY_S = Number(process.env.PERF_SECONDS || 12);
let server, cdn;
const rows = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

before(async () => {
  cdn = await startFakeCdn({ fixture: { width: 1920, height: 1080, fps: 60, seconds: 20, bitrate: '6M' } });
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(PORT)], { env: { ...process.env, ...fakeYoutubeEnv(cdn) }, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let i = 0; i < 120 && !(await fetch(`${BASE}/api/health`).catch(() => null))?.ok; i++) await sleep(500);
});
after(async () => { server?.kill('SIGTERM'); await cdn?.close(); console.log('\nPERF_RESULTS\n' + rows.map(r => JSON.stringify(r)).join('\n')); });

function pinnedChrome(cores) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pin-'));
  const f = path.join(dir, 'chrome');
  writeFileSync(f, `#!/bin/sh\nexec taskset -c 0-${cores - 1} "${process.env.CHROME_PATH}" "$@"\n`);
  chmodSync(f, 0o755);
  return f;
}

for (const cores of CORES) {
  test(`1080p60 on ${cores} CPU core(s): muxed vs dual`, async () => {
    const browser = await chromium.launch({ executablePath: pinnedChrome(cores), args: ['--autoplay-policy=user-gesture-required'] });
    try {
      for (const [delivery, query] of [['muxed', '?intel=1&maxFps=60'], ['dual', '?intel=0']]) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.goto(`${BASE}/${query}`);
        const statuses = [];
        await page.exposeFunction('logStatus', t => statuses.push(t));
        await page.evaluate(() => { const el = document.querySelector('[data-testid=status]'); new MutationObserver(() => window.logStatus(el.textContent)).observe(el, { childList: true, subtree: true, characterData: true }); });
        await page.fill('[data-testid=search-input]', 'https://youtu.be/dQw4w9WgXcQ');
        const t0 = Date.now();
        await page.click('[data-testid=search-btn]');
        await page.waitForFunction(() => window.__canvasTube?.engines.canvas.running, null, { timeout: 60000 });
        const startupMs = Date.now() - t0;
        let bufferingMs = 0, stalls = 0, wasBuffering = false, tick = 0; const timeline = [];
        const end = Date.now() + PLAY_S * 1000;
        while (Date.now() < end) {
          const b = await page.getAttribute('[data-testid=player]', 'data-buffering');
          if (b === 'true') { bufferingMs += 100; if (!wasBuffering) stalls++; }
          wasBuffering = b === 'true';
          if (process.env.PERF_DEBUG && (++tick % 10 === 0)) timeline.push(await page.evaluate(() => { const x = window.__canvasTube.stats || {}; return `${window.__canvasTube.engines.canvas.currentTime().toFixed(1)}s dec=${x.decoded} q=${x.decodeQueue} held=${x.heldFrames} pend=${x.pendingVideo} resc=${x.loopRescues} rebuf=${x.rebuffers} silentMs=${Math.round(performance.now() - (window.__canvasTube.engines.canvas.lastWorkerMessageAt || 0))}`; }));
          await sleep(100);
        }
        const st = await page.evaluate(() => ({ ...window.__canvasTube.stats, t: window.__canvasTube.engines.canvas.currentTime() }));
        if (process.env.PERF_DEBUG) console.log(delivery, cores, JSON.stringify(st), statuses.slice(-6), timeline.join(' | '));
        const total = st.presented + st.dropped;
        rows.push({ cores, delivery, startupMs, mediaSecondsPlayed: +st.t.toFixed(2), presented: st.presented, dropped: st.dropped,
          dropPct: +(100 * st.dropped / Math.max(1, total)).toFixed(1), effectiveFps: +(st.presented / Math.max(0.1, st.t)).toFixed(1),
          avgLateMs: +(st.lateSumMs / Math.max(1, st.presented)).toFixed(1), maxLateMs: +st.lateMaxMs.toFixed(1), stalls, bufferingMs });
        assert.ok(st.presented > 0);
        await page.close();
      }
    } finally { await browser.close(); }
  });
}
