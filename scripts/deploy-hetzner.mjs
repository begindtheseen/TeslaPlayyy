#!/usr/bin/env node
// Deploys CanvasTube to a Hetzner Cloud server using only the Hetzner API (no SSH needed):
// creates a firewall and an Ubuntu 24.04 server whose first boot (deploy/cloud-init.yaml) installs
// Docker, clones this repo and starts the app behind Caddy (HTTPS) with IPv6 source rotation.
//
//   HCLOUD_TOKEN=... node scripts/deploy-hetzner.mjs up [--location ash] [--type cpx31] [--domain tv.example.com]
//                                                     [--ssh-key my-key] [--app-env .env.deploy] [--no-wait]
//   HCLOUD_TOKEN=... node scripts/deploy-hetzner.mjs status
//   HCLOUD_TOKEN=... node scripts/deploy-hetzner.mjs destroy --yes
//
// Without --domain the site is https://<ipv4-with-dashes>.sslip.io (real Let's Encrypt certificate).
// With --domain, point an A record (and AAAA if you like) at the printed IP before or right after `up`.
// --app-env: a local KEY=VALUE file appended to the server's .env.production (e.g. YOUTUBE_API_KEY, PROXY_URLS).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const api = () => process.env.HCLOUD_API || 'https://api.hetzner.cloud/v1';
const DEFAULTS = { name: 'canvastube', type: 'cpx31', location: 'ash', image: 'ubuntu-24.04', repo: 'https://github.com/begindtheseen/TeslaPlayyy.git', branch: 'main' };

export function parseArgs(argv) {
  const [cmd = 'up', ...rest] = argv;
  const o = { cmd, ...DEFAULTS, domain: '', sshKey: '', appEnv: '', wait: true, yes: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => { const v = rest[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--name') o.name = val();
    else if (a === '--type') o.type = val();
    else if (a === '--location') o.location = val();
    else if (a === '--image') o.image = val();
    else if (a === '--domain') o.domain = val();
    else if (a === '--ssh-key') o.sshKey = val();
    else if (a === '--repo') o.repo = val();
    else if (a === '--branch') o.branch = val();
    else if (a === '--app-env') o.appEnv = val();
    else if (a === '--no-wait') o.wait = false;
    else if (a === '--yes') o.yes = true;
    else throw new Error(`Unknown option ${a}`);
  }
  if (!['up', 'status', 'destroy'].includes(o.cmd)) throw new Error(`Unknown command ${o.cmd} (up | status | destroy)`);
  if (o.domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(o.domain)) throw new Error(`Invalid domain ${o.domain}`);
  if (!/^[a-z0-9-]{1,63}$/.test(o.name)) throw new Error('Invalid --name');
  return o;
}

// Fills the cloud-init template. Every value is validated or base64-encoded, so nothing can break the YAML.
export function renderCloudInit({ repo, branch, domain = '', appEnv = '' }, template = readFileSync(new URL('../deploy/cloud-init.yaml', import.meta.url), 'utf8')) {
  if (!/^https:\/\/[\w.\-/]+\.git$/.test(repo)) throw new Error(`Invalid repo URL ${repo}`);
  if (!/^[\w.\-/]+$/.test(branch)) throw new Error(`Invalid branch ${branch}`);
  const out = template
    .replaceAll('__REPO__', repo).replaceAll('__BRANCH__', branch).replaceAll('__DOMAIN__', domain)
    .replaceAll('__EXTRA_ENV_B64__', Buffer.from(appEnv ? appEnv.replace(/\r/g, '').trimEnd() + '\n' : '').toString('base64'));
  if (/__[A-Z0-9_]+__/.test(out)) throw new Error('Unfilled placeholder in cloud-init template');
  if (Buffer.byteLength(out) > 32 * 1024) throw new Error('cloud-init user data exceeds 32 KiB');
  return out;
}

export function siteUrl(ipv4, domain) { return `https://${domain || `${ipv4.replaceAll('.', '-')}.sslip.io`}`; }

export function client(token = process.env.HCLOUD_TOKEN, fetchImpl = fetch) {
  if (!token) throw new Error('HCLOUD_TOKEN is not set (Hetzner Console -> project -> Security -> API tokens, Read & Write)');
  return async function call(method, path, body) {
    const r = await fetchImpl(`${api()}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    const data = text ? JSON.parse(text) : {};
    if (!r.ok) throw new Error(`Hetzner API ${method} ${path} -> ${r.status}: ${data.error?.code || ''} ${data.error?.message || text}`.trim());
    return data;
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function findServer(call, name) { return (await call('GET', `/servers?name=${encodeURIComponent(name)}`)).servers?.[0] || null; }
async function findFirewall(call, name) { return (await call('GET', `/firewalls?name=${encodeURIComponent(name)}`)).firewalls?.[0] || null; }

export function firewallRules({ ssh }) {
  const any = ['0.0.0.0/0', '::/0'];
  const ports = [['80', 'HTTP (ACME + redirect)'], ['443', 'HTTPS'], ...(ssh ? [['22', 'SSH']] : [])];
  return ports.map(([port, description]) => ({ direction: 'in', protocol: 'tcp', port, source_ips: any, description }));
}

async function waitAction(call, action, label) {
  for (let i = 0; i < 180 && action.status === 'running'; i++) { await sleep(2000); action = (await call('GET', `/actions/${action.id}`)).action; }
  if (action.status !== 'success') throw new Error(`${label} failed: ${JSON.stringify(action.error || action.status)}`);
}

async function waitHealthy(url, minutes = 20, log = console.log) {
  const end = Date.now() + minutes * 60e3;
  let last = '';
  while (Date.now() < end) {
    try {
      const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) return r.json();
      last = `HTTP ${r.status}`;
    } catch (e) { last = e.cause?.code || e.message; }
    log(`  waiting for ${url} (${last}) - first boot builds the Docker image, ~5-10 min`);
    await sleep(20000);
  }
  throw new Error(`${url} did not become healthy within ${minutes} min (last: ${last}). On the server: tail -f /var/log/canvastube-setup.log`);
}

export async function up(o, call, log = console.log) {
  const existing = await findServer(call, o.name);
  if (existing) {
    const ip = existing.public_net.ipv4?.ip;
    log(`Server "${o.name}" already exists (id ${existing.id}, ${existing.status}, ${ip}). Nothing created.`);
    return { server: existing, url: siteUrl(ip, o.domain), created: false };
  }
  let sshKeys = [];
  if (o.sshKey) {
    const k = (await call('GET', `/ssh_keys?name=${encodeURIComponent(o.sshKey)}`)).ssh_keys?.[0];
    if (!k) throw new Error(`SSH key "${o.sshKey}" not found in this Hetzner project`);
    sshKeys = [k.id];
  }
  const fwName = `${o.name}-web`;
  let fw = await findFirewall(call, fwName);
  if (!fw) {
    fw = (await call('POST', '/firewalls', { name: fwName, labels: { app: 'canvastube' }, rules: firewallRules({ ssh: sshKeys.length > 0 }) })).firewall;
    log(`Created firewall ${fwName} (ports 80, 443${sshKeys.length ? ', 22' : ''})`);
  }
  const userData = renderCloudInit({ repo: o.repo, branch: o.branch, domain: o.domain, appEnv: o.appEnv ? readFileSync(o.appEnv, 'utf8') : '' });
  const res = await call('POST', '/servers', {
    name: o.name, server_type: o.type, image: o.image, location: o.location,
    user_data: userData, ssh_keys: sshKeys, firewalls: [{ firewall: fw.id }],
    public_net: { enable_ipv4: true, enable_ipv6: true }, labels: { app: 'canvastube' },
  });
  const server = res.server;
  log(`Creating server ${o.name} (${o.type} in ${o.location})...`);
  await waitAction(call, res.action, 'Server creation');
  const ip = server.public_net.ipv4.ip, net6 = server.public_net.ipv6?.ip;
  const url = siteUrl(ip, o.domain);
  log(`Server running: IPv4 ${ip}, IPv6 ${net6}`);
  if (o.domain) log(`DNS: point ${o.domain} A -> ${ip} now (Caddy retries the certificate until it resolves).`);
  log(`Site: ${url}`);
  if (o.wait) { const h = await waitHealthy(url, 20, log); log(`Healthy: ffmpeg=${h.ffmpeg} yt-dlp=${h.ytdlp?.version || 'missing'} egress=${h.egress?.mode}`); }
  return { server, url, created: true };
}

export async function status(o, call, log = console.log) {
  const s = await findServer(call, o.name);
  if (!s) { log(`No server named "${o.name}".`); return null; }
  const url = siteUrl(s.public_net.ipv4.ip, o.domain);
  log(`${s.name}: ${s.status}, ${s.server_type?.name} in ${s.datacenter?.location?.name}, IPv4 ${s.public_net.ipv4.ip}, IPv6 ${s.public_net.ipv6?.ip}`);
  try {
    const h = await (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(10000) })).json();
    log(`${url}: ffmpeg=${h.ffmpeg} yt-dlp=${h.ytdlp?.version} extraction successRate=${h.extraction?.successRate} requests=${h.extraction?.requests} byCode=${JSON.stringify(h.extraction?.byCode)}`);
  } catch (e) { log(`${url}: not reachable (${e.cause?.code || e.message})`); }
  return s;
}

export async function destroy(o, call, log = console.log) {
  if (!o.yes) throw new Error('destroy deletes the server and its firewall; re-run with --yes');
  const s = await findServer(call, o.name);
  if (s) { const r = await call('DELETE', `/servers/${s.id}`); await waitAction(call, r.action, 'Server deletion'); log(`Deleted server ${s.name}`); }
  const fw = await findFirewall(call, `${o.name}-web`);
  if (fw) { await call('DELETE', `/firewalls/${fw.id}`); log(`Deleted firewall ${fw.name}`); }
  if (!s && !fw) log('Nothing to delete.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const call = client();
    await ({ up, status, destroy })[o.cmd](o, call);
  } catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
}
