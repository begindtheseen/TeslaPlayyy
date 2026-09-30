// Outbound network identity ("egress") for YouTube extraction and googlevideo CDN fetches.
//
// googlevideo URLs are locked to the IP that extracted them (`ip=` query param), so the SAME egress
// that ran yt-dlp must also fetch the media. Every extraction result carries its egress and every
// CDN request reuses it.
//
// Egress sources, in precedence order (all optional; default is the server's own address):
//   PROXY_URLS / PROXY_URL      http://, https://, socks5://, socks5h:// proxies (comma list = rotation pool)
//   EGRESS_SOURCE_ADDRESSES     local IPs to bind (e.g. several IPv6 addresses on the NIC), comma list
//   EGRESS_IPV6_PREFIX          e.g. 2a01:4f8:c0c:1234::/64 -> a random address per extraction
//                               (needs AnyIP routing, see docs/RESILIENCE.md)
// Blocks (429 / bot check) put the egress in cooldown (EGRESS_COOLDOWN_SECONDS, default 600) and fire
// the rotation hooks:
//   EGRESS_HOOK_MODULE          path to an ES module exporting optional pick(ctx) and onBlocked(ctx)
//   EGRESS_ROTATE_COMMAND       shell command run on a block (e.g. an IPv6 rotator), at most once/minute
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { shared, envInt } from './state.js';

const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

export function egressConfig() {
  return {
    proxies: list(process.env.PROXY_URLS || process.env.PROXY_URL),
    sourceAddresses: list(process.env.EGRESS_SOURCE_ADDRESSES),
    ipv6Prefix: (process.env.EGRESS_IPV6_PREFIX || '').trim() || null,
    cooldownMs: envInt('EGRESS_COOLDOWN_SECONDS', 600) * 1000,
    hookModule: (process.env.EGRESS_HOOK_MODULE || '').trim() || null,
    rotateCommand: (process.env.EGRESS_ROTATE_COMMAND || '').trim() || null,
  };
}

// Credentials never leave this module: ids are safe to log and report.
export function redactProxy(p) {
  try { const u = new URL(p); return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`; } catch { return 'proxy'; }
}

function egressId(e) { return e.proxy ? redactProxy(e.proxy) : e.localAddress ? `src:${e.localAddress}` : 'direct'; }
const make = (e) => ({ proxy: e.proxy || null, localAddress: e.localAddress || null, id: egressId(e) });

// Random host part inside an IPv6 prefix (prefix length must be a multiple of 16 and <= 112).
export function randomIpv6InPrefix(cidr, rand = randomBytes) {
  const [addr, lenStr] = cidr.split('/');
  const len = Number(lenStr);
  if (!net.isIPv6(addr) || !Number.isInteger(len) || len % 16 || len < 16 || len > 112) throw new Error(`Invalid EGRESS_IPV6_PREFIX ${cidr}`);
  const groups = expandIpv6(addr);
  const fixed = len / 16;
  const r = rand(16);
  for (let i = fixed; i < 8; i++) groups[i] = ((r[i * 2] << 8) | r[i * 2 + 1]).toString(16);
  return groups.join(':');
}

function expandIpv6(a) {
  const [head, tail = ''] = a.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const fill = a.includes('::') ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map(g => g || '0');
}

const state = () => shared('egress', () => ({ rr: 0, cooldown: new Map(), lastRotate: 0, hook: null, hookPath: null, stats: new Map() }));

async function loadHook(cfg) {
  const st = state();
  if (!cfg.hookModule) return null;
  if (st.hookPath !== cfg.hookModule) {
    st.hookPath = cfg.hookModule;
    const full = path.resolve(process.cwd(), cfg.hookModule);
    st.hook = import(/* webpackIgnore: true */ pathToFileURL(full).href).catch(e => { console.warn('[egress] hook module failed to load:', e.message); return null; });
  }
  return st.hook;
}

// Picks the egress for a new extraction. Egresses in cooldown are skipped while others remain.
export async function pickEgress({ videoId } = {}) {
  const cfg = egressConfig();
  const hook = await loadHook(cfg);
  if (hook?.pick) {
    const e = await hook.pick({ videoId, config: { ...cfg, proxies: cfg.proxies.map(redactProxy) } });
    if (e) return make(e);
  }
  let pool;
  if (cfg.proxies.length) pool = cfg.proxies.map(proxy => make({ proxy }));
  else if (cfg.sourceAddresses.length) pool = cfg.sourceAddresses.map(localAddress => make({ localAddress }));
  else if (cfg.ipv6Prefix) return make({ localAddress: randomIpv6InPrefix(cfg.ipv6Prefix) });
  else return make({});
  const st = state(), now = Date.now();
  for (let i = 0; i < pool.length; i++) {
    const e = pool[(st.rr + i) % pool.length];
    if ((st.cooldown.get(e.id) || 0) <= now) { st.rr = (st.rr + i + 1) % pool.length; return e; }
  }
  // Everything is cooling down: use whichever recovers first.
  return pool.reduce((a, b) => ((st.cooldown.get(a.id) || 0) <= (st.cooldown.get(b.id) || 0) ? a : b));
}

export async function reportBlocked(egress, reason) {
  const cfg = egressConfig(), st = state();
  st.cooldown.set(egress.id, Date.now() + cfg.cooldownMs);
  noteEgress(egress, 'blocked');
  const hook = await loadHook(cfg);
  try { await hook?.onBlocked?.({ egress: { id: egress.id, localAddress: egress.localAddress }, reason }); }
  catch (e) { console.warn('[egress] onBlocked hook failed:', e.message); }
  if (cfg.rotateCommand && Date.now() - st.lastRotate > 60_000) {
    st.lastRotate = Date.now();
    const p = spawn('/bin/sh', ['-c', cfg.rotateCommand], { stdio: 'ignore', env: { ...process.env, EGRESS_BLOCK_REASON: String(reason), EGRESS_ID: egress.id } });
    const t = setTimeout(() => p.kill('SIGKILL'), 30_000);
    p.on('exit', code => { clearTimeout(t); if (code) console.warn(`[egress] rotate command exited ${code}`); });
    p.on('error', e => { clearTimeout(t); console.warn('[egress] rotate command failed:', e.message); });
  }
}

export function noteEgress(egress, outcome) {
  const s = state().stats;
  const r = s.get(egress.id) || { ok: 0, failed: 0, blocked: 0 };
  r[outcome] = (r[outcome] || 0) + 1;
  s.set(egress.id, r);
}

export function egressSummary() {
  const cfg = egressConfig(), st = state(), now = Date.now();
  return {
    mode: cfg.proxies.length ? 'proxy' : cfg.sourceAddresses.length ? 'source-address' : cfg.ipv6Prefix ? 'ipv6-prefix' : 'direct',
    poolSize: cfg.proxies.length || cfg.sourceAddresses.length || (cfg.ipv6Prefix ? Infinity : 1),
    hook: !!cfg.hookModule, rotateCommand: !!cfg.rotateCommand,
    coolingDown: [...st.cooldown].filter(([, until]) => until > now).map(([id, until]) => ({ id, seconds: Math.ceil((until - now) / 1000) })),
    byEgress: Object.fromEntries(st.stats),
  };
}

// yt-dlp flags that make it use the same egress as our own CDN requests.
export function ytdlpEgressArgs(e) {
  if (e?.proxy) return ['--proxy', e.proxy];
  if (e?.localAddress) return ['--source-address', e.localAddress];
  return [];
}

// ---- CDN requests --------------------------------------------------------------------------------

export function cdnAllowedHosts() {
  return list(process.env.CDN_ALLOWED_HOSTS || '*.googlevideo.com,*.youtube.com,*.ytimg.com,*.googleusercontent.com').map(h => h.toLowerCase());
}

// Media URLs come from yt-dlp, never from clients, but are still pinned to YouTube's CDN hosts.
export function assertCdnUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid CDN URL'); }
  const insecureOk = process.env.MEDIA_ALLOW_PRIVATE_NETWORK === '1';
  if (u.protocol !== 'https:' && !(insecureOk && u.protocol === 'http:')) throw new Error('CDN URL must use https');
  if (u.username || u.password) throw new Error('Credentials in CDN URLs are not allowed');
  const host = u.hostname.toLowerCase();
  if (!cdnAllowedHosts().some(r => host === r || (r.startsWith('*.') && host.endsWith(r.slice(1))))) throw new Error(`CDN host ${host} is not allowed`);
  return u;
}

function agentFor(e, protocol) {
  const cache = shared('egressAgents', () => new Map());
  const key = `${protocol}|${e.proxy || ''}|${e.localAddress || ''}`;
  let a = cache.get(key);
  if (a) return a;
  if (e.proxy) a = /^socks/i.test(e.proxy) ? new SocksProxyAgent(e.proxy, { keepAlive: true }) : new HttpsProxyAgent(e.proxy, { keepAlive: true });
  else {
    const opts = { keepAlive: true, maxSockets: 64, ...(e.localAddress ? { localAddress: e.localAddress, family: net.isIPv6(e.localAddress) ? 6 : 4 } : {}) };
    a = protocol === 'https:' ? new https.Agent(opts) : new http.Agent(opts);
  }
  if (cache.size > 256) { for (const x of cache.values()) x.destroy?.(); cache.clear(); }
  cache.set(key, a);
  return a;
}

export const UPSTREAM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// GET a CDN URL through an egress. Resolves with the IncomingMessage (caller must consume or destroy
// it). Follows up to 5 redirects within the allowed hosts. `signal` aborts the request and body.
export function cdnRequest(url, { egress, headers = {}, signal, timeoutMs = 15000, method = 'GET' } = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = assertCdnUrl(url); } catch (e) { return reject(e); }
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, agent: agentFor(egress || {}, u.protocol), headers: { 'User-Agent': UPSTREAM_UA, Accept: '*/*', ...headers } });
    const onAbort = () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('CDN request timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', e => { signal?.removeEventListener('abort', onAbort); reject(e); });
    req.on('response', res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        signal?.removeEventListener('abort', onAbort);
        if (redirects >= 5) return reject(new Error('Too many CDN redirects'));
        return resolve(cdnRequest(new URL(res.headers.location, u).href, { egress, headers, signal, timeoutMs, method }, redirects + 1));
      }
      res.on('close', () => signal?.removeEventListener('abort', onAbort));
      resolve(res);
    });
    req.end();
  });
}
