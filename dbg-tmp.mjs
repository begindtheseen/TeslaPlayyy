import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { startFakeCdn, fakeYoutubeEnv } from './test/helpers/fakeYoutube.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cdn = await startFakeCdn({ fixture: { width: 1920, height: 1080, fps: 60, seconds: 20, bitrate: '6M' } });
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', '3219'], { env: { ...process.env, ...fakeYoutubeEnv(cdn) }, stdio: ['ignore', 'ignore', 'inherit'] });
for (let i = 0; i < 60; i++) { if ((await fetch('http://localhost:3219/api/health').catch(() => null))?.ok) break; await sleep(500); }
const b = await chromium.launch({ executablePath: '/opt/cft/chrome-linux64/chrome', args: ['--autoplay-policy=user-gesture-required'] });
const p = await b.newPage();
const statuses = [];
p.on('console', m => statuses.push('console ' + m.text()));
await p.exposeFunction('logStatus', t => statuses.push(`${(Date.now() % 100000)} ${t}`));
await p.goto('http://localhost:3219/?intel=1&maxFps=60');
await p.evaluate(() => { const el = document.querySelector('[data-testid=status]'); new MutationObserver(() => window.logStatus(el.textContent)).observe(el, { childList: true, subtree: true, characterData: true }); });
await p.fill('[data-testid=search-input]', 'https://youtu.be/dQw4w9WgXcQ');
await p.click('[data-testid=search-btn]');
for (let i = 0; i < 6; i++) {
  await sleep(1000);
  console.log(JSON.stringify(await p.evaluate(() => { const e = window.__canvasTube.engines.canvas; return { t: e.currentTime().toFixed(2), running: e.running, buffering: e.buffering, s: window.__canvasTube.stats }; })));
}
console.log(statuses.join('\n'));
await b.close(); server.kill(); await cdn.close();
