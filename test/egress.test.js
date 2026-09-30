// Phase 6: outbound egress. CDN media and yt-dlp must use the same configured proxy / rotation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cdnRequest, pickEgress, reportBlocked, egressSummary } from '../lib/server/egress.js';
import { extract, invalidateExtraction } from '../lib/server/ytdlp.js';
import { startFakeCdn, fakeYoutubeEnv } from './helpers/fakeYoutube.js';

let cdn, proxy, proxyUrl;
const tunnels = [];
const tmp = mkdtempSync(path.join(tmpdir(), 'egress-'));

before(async () => {
  cdn = await startFakeCdn();
  Object.assign(process.env, fakeYoutubeEnv(cdn));
  // Minimal authenticated HTTP CONNECT proxy (like a residential proxy endpoint).
  proxy = http.createServer((req, res) => { res.statusCode = 405; res.end(); });
  proxy.on('connect', (req, client, head) => {
    const auth = Buffer.from(String(req.headers['proxy-authorization'] || '').replace(/^Basic /, ''), 'base64').toString();
    tunnels.push({ target: req.url, auth });
    if (auth !== 'user:pass') { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    const [host, port] = req.url.split(':');
    const up = net.connect(Number(port), host, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(client); client.pipe(up); });
    up.on('error', () => client.destroy()); client.on('error', () => up.destroy());
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  proxyUrl = `http://user:pass@127.0.0.1:${proxy.address().port}`;
});
after(async () => { proxy.close(); await cdn.close(); delete process.env.PROXY_URL; delete process.env.PROXY_URLS; });

test('PROXY_URL: extraction passes --proxy to yt-dlp and CDN range requests tunnel through the same proxy', async () => {
  process.env.PROXY_URL = proxyUrl;
  try {
    invalidateExtraction('dQw4w9WgXcQ');
    const x = await extract('dQw4w9WgXcQ');
    assert.equal(x.egress.proxy, proxyUrl);
    assert.equal(x.egress.id, `http://127.0.0.1:${proxy.address().port}`);
    const f = x.formats.find(f => f.itag === 134);
    const res = await cdnRequest(f.url, { egress: x.egress, headers: { Range: 'bytes=0-99' } });
    assert.equal(res.statusCode, 206);
    let n = 0; for await (const b of res) n += b.length;
    assert.equal(n, 100);
    assert.ok(tunnels.some(t => t.target === `127.0.0.1:${cdn.server.address().port}` && t.auth === 'user:pass'), JSON.stringify(tunnels));
  } finally { delete process.env.PROXY_URL; }
});

test('hook module: pick() chooses the egress, onBlocked() hears about blocks; rotate command runs', async () => {
  const hook = path.join(tmp, 'rotator.mjs'), log = path.join(tmp, 'blocked.log'), cmdOut = path.join(tmp, 'rotated.txt');
  writeFileSync(hook, `import { appendFileSync } from 'node:fs';
export function pick({ videoId }) { return videoId === 'HOOKEDVIDEO' ? { localAddress: '127.0.0.1' } : null; }
export function onBlocked({ egress, reason }) { appendFileSync(${JSON.stringify(log)}, egress.id + ' ' + reason + '\\n'); }`);
  Object.assign(process.env, { EGRESS_HOOK_MODULE: hook, EGRESS_ROTATE_COMMAND: `echo "$EGRESS_ID $EGRESS_BLOCK_REASON" > ${cmdOut}` });
  try {
    assert.equal((await pickEgress({ videoId: 'HOOKEDVIDEO' })).id, 'src:127.0.0.1');
    assert.equal((await pickEgress({ videoId: 'OTHERVIDEO0' })).id, 'direct');
    await reportBlocked({ id: 'src:127.0.0.1', localAddress: '127.0.0.1' }, 'bot-check');
    assert.match(readFileSync(log, 'utf8'), /src:127\.0\.0\.1 bot-check/);
    for (let i = 0; i < 40 && !existsSync(cmdOut); i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(readFileSync(cmdOut, 'utf8').trim(), 'src:127.0.0.1 bot-check');
    assert.ok(egressSummary().coolingDown.some(c => c.id === 'src:127.0.0.1'));
    assert.equal(egressSummary().hook, true);
  } finally { delete process.env.EGRESS_HOOK_MODULE; delete process.env.EGRESS_ROTATE_COMMAND; }
});

test('source-address pool: yt-dlp gets --source-address and CDN sockets bind the same local address', async () => {
  process.env.EGRESS_SOURCE_ADDRESSES = '127.0.0.1';
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push(req.socket.remoteAddress); res.end('ok'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const e = await pickEgress();
    assert.equal(e.localAddress, '127.0.0.1');
    const r = await cdnRequest(`http://127.0.0.1:${srv.address().port}/videoplayback`, { egress: e });
    r.resume();
    assert.equal(seen[0], '127.0.0.1');
  } finally { delete process.env.EGRESS_SOURCE_ADDRESSES; srv.close(); }
});
