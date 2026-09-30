// Deploy script against a fake Hetzner Cloud API (request shapes, idempotency, rendered cloud-init).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, renderCloudInit, firewallRules, siteUrl, client, up, status, destroy } from '../scripts/deploy-hetzner.mjs';

let api, calls = [], servers = [], firewalls = [];
before(async () => {
  api = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const u = new URL(req.url, 'http://x'), json = body ? JSON.parse(body) : null;
    calls.push({ method: req.method, path: u.pathname, auth: req.headers.authorization, body: json });
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const action = { id: 1, status: 'success' };
    if (req.method === 'GET' && u.pathname === '/servers') return send(200, { servers: servers.filter(s => s.name === u.searchParams.get('name')) });
    if (req.method === 'GET' && u.pathname === '/firewalls') return send(200, { firewalls: firewalls.filter(f => f.name === u.searchParams.get('name')) });
    if (req.method === 'GET' && u.pathname === '/ssh_keys') return send(200, { ssh_keys: u.searchParams.get('name') === 'laptop' ? [{ id: 7, name: 'laptop' }] : [] });
    if (req.method === 'POST' && u.pathname === '/firewalls') { const f = { id: 11, ...json }; firewalls.push(f); return send(201, { firewall: f }); }
    if (req.method === 'POST' && u.pathname === '/servers') {
      if (json.server_type === 'nope') return send(422, { error: { code: 'invalid_input', message: 'unknown server type' } });
      const s = { id: 99, name: json.name, status: 'running', public_net: { ipv4: { ip: '203.0.113.9' }, ipv6: { ip: '2a01:4f8:c0c:1234::/64' } } };
      servers.push(s); return send(201, { server: s, action });
    }
    if (req.method === 'DELETE' && u.pathname === '/servers/99') { servers = []; return send(200, { action }); }
    if (req.method === 'DELETE' && u.pathname === '/firewalls/11') { firewalls = []; return send(204, {}); }
    send(404, { error: { code: 'not_found', message: req.url } });
  });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  process.env.HCLOUD_API = `http://127.0.0.1:${api.address().port}`;
});
after(() => api.close());

test('cloud-init: placeholders filled, app env passed safely as base64, valid YAML, bad input rejected', () => {
  const y = renderCloudInit({ repo: 'https://github.com/begindtheseen/TeslaPlayyy.git', branch: 'main', domain: 'tv.example.com', appEnv: 'YOUTUBE_API_KEY=abc"; rm -rf /\nPROXY_URLS=socks5://u:p@h:1\n' });
  assert.ok(!/__[A-Z_]+__/.test(y));
  assert.match(y, /git clone --branch main --depth 1 https:\/\/github.com\/begindtheseen\/TeslaPlayyy.git/);
  assert.match(y, /DOMAIN="tv.example.com"/);
  const b64 = /printf '%s\\n' "([A-Za-z0-9+/=]+)" \| base64 -d/.exec(y)[1];
  assert.equal(Buffer.from(b64, 'base64').toString(), 'YOUTUBE_API_KEY=abc"; rm -rf /\nPROXY_URLS=socks5://u:p@h:1\n');
  const py = spawnSync('python3', ['-c', 'import sys,yaml; d=yaml.safe_load(sys.stdin); assert d["runcmd"] and d["write_files"]; print(len(d["runcmd"]))'], { input: y, encoding: 'utf8' });
  if (py.stderr.includes('No module named')) console.log('PyYAML unavailable; YAML parse skipped');
  else assert.equal(py.status, 0, py.stderr);
  assert.throws(() => renderCloudInit({ repo: 'https://x/y.git; curl evil', branch: 'main' }));
  assert.throws(() => renderCloudInit({ repo: 'https://github.com/a/b.git', branch: 'main && reboot' }));
  assert.throws(() => parseArgs(['up', '--domain', 'bad domain']));
  assert.equal(siteUrl('203.0.113.9'), 'https://203-0-113-9.sslip.io');
  assert.deepEqual(firewallRules({ ssh: false }).map(r => r.port), ['80', '443']);
  assert.deepEqual(firewallRules({ ssh: true }).map(r => r.port), ['80', '443', '22']);
});

test('up: creates firewall + server with IPv4/IPv6 and cloud-init; idempotent; status; destroy needs --yes', async () => {
  const call = client('test-token');
  const log = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'dep-')); const envFile = path.join(dir, '.env.deploy');
  writeFileSync(envFile, 'YOUTUBE_API_KEY=k\n');
  const o = parseArgs(['up', '--no-wait', '--ssh-key', 'laptop', '--app-env', envFile, '--location', 'fsn1']);
  const r = await up(o, call, m => log.push(m));
  assert.equal(r.url, 'https://203-0-113-9.sslip.io');
  const fwPost = calls.find(c => c.method === 'POST' && c.path === '/firewalls');
  assert.deepEqual(fwPost.body.rules.map(x => x.port), ['80', '443', '22']);
  const sPost = calls.find(c => c.method === 'POST' && c.path === '/servers');
  assert.equal(sPost.auth, 'Bearer test-token');
  assert.deepEqual([sPost.body.server_type, sPost.body.location, sPost.body.image], ['cpx31', 'fsn1', 'ubuntu-24.04']);
  assert.deepEqual(sPost.body.public_net, { enable_ipv4: true, enable_ipv6: true });
  assert.deepEqual(sPost.body.ssh_keys, [7]);
  assert.deepEqual(sPost.body.firewalls, [{ firewall: 11 }]);
  assert.match(sPost.body.user_data, /^#cloud-config/);
  const n = calls.length;
  const again = await up(o, call, m => log.push(m));
  assert.equal(again.created, false);
  assert.ok(!calls.slice(n).some(c => c.method === 'POST'), 'second up must not create anything');
  await assert.rejects(up({ ...parseArgs(['up', '--no-wait', '--ssh-key', 'missing', '--name', 'other']) }, call), /SSH key "missing" not found/);
  await assert.rejects(up({ ...parseArgs(['up', '--no-wait', '--type', 'nope', '--name', 'other2']) }, call), /422: invalid_input unknown server type/);
  const st = []; assert.equal((await status(parseArgs(['status']), call, m => st.push(m))).id, 99);
  assert.match(st[0], /canvastube: running/);
  await assert.rejects(destroy(parseArgs(['destroy']), call), /--yes/);
  await destroy(parseArgs(['destroy', '--yes']), call, m => log.push(m));
  assert.deepEqual([servers.length, firewalls.length], [0, 0]);
});
