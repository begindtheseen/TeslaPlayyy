// YouTube extraction via yt-dlp (public videos only).
//
// - Runs yt-dlp as a child process (never blocks the event loop) with an extractor client group, e.g.
//   `--extractor-args youtube:player_client=android_vr,web_safari`.
// - On a block (bot check / 429 / 403 / "try again later") or transient failure it retries with the next
//   client group from YTDLP_CLIENTS and a fresh egress (see egress.js).
// - Permanent conditions (private, removed, age-gated, region-locked, members-only, DRM, live) are
//   classified and returned immediately. Nothing here attempts to bypass them: no cookies, no login,
//   no age-gate workarounds, no DRM handling.
// - Results are cached per video for EXTRACT_CACHE_SECONDS (default 300) and never beyond the CDN URL
//   expiry; permanent errors are cached briefly so a broken link cannot hammer YouTube.
import { spawn } from 'node:child_process';
import { shared, envInt } from './state.js';
import { pickEgress, reportBlocked, noteEgress, ytdlpEgressArgs } from './egress.js';

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
export const DEFAULT_CLIENTS = 'android_vr,web_safari|tv,ios|mweb';

export const ytdlpPath = () => process.env.YTDLP_PATH || 'yt-dlp';
export const clientGroups = () => (process.env.YTDLP_CLIENTS || DEFAULT_CLIENTS).split('|').map(s => s.trim()).filter(Boolean);

export class ExtractError extends Error {
  constructor(status, code, message, { retryable = false, detail = '' } = {}) {
    super(message);
    this.status = status; this.code = code; this.retryable = retryable; this.detail = detail;
  }
}

// Ordered: the first matching rule wins. `blocked` must precede `unavailable` because YouTube's
// temporary IP ban reads "Video unavailable. This content isn't available, try again later".
const RULES = [
  [/unable to connect to proxy|tunnel connection failed|name or service not known|temporary failure in name resolution|network is unreachable|connection refused|connection reset|timed out|getaddrinfo/i,
    502, 'network', 'Could not reach YouTube from the server.', true],
  [/not a bot|http error 429|too many requests|rate.?limit|try again later|http error 403|403: forbidden|po.?token|unusual traffic/i,
    429, 'blocked', 'YouTube is temporarily blocking the server. Try again shortly.', true],
  [/private video|video is private/i, 404, 'private', 'This video is private.', false],
  [/confirm your age|age.?restricted|inappropriate for some users|age.?gate/i, 403, 'age_restricted', 'This video is age-restricted and cannot be played here.', false],
  [/not made this video available in your country|not available in your country|blocked it in your country|geo.?restrict/i,
    451, 'region_blocked', 'This video is not available in the server’s region.', false],
  [/members.only|join this channel|channel.?s members|requires payment|premium members|purchase/i, 403, 'members_only', 'This video requires a membership or purchase.', false],
  [/drm/i, 403, 'drm_protected', 'This video is DRM-protected and cannot be played here.', false],
  [/live event will begin|premieres? in|scheduled|upcoming/i, 409, 'upcoming', 'This video has not premiered yet.', false],
  [/video unavailable|has been removed|does not exist|no longer available|account .*terminated|incomplete youtube id|not a valid url|violat/i,
    404, 'unavailable', 'This video is unavailable (removed or does not exist).', false],
  [/requested format is not available|no video formats found/i, 422, 'no_formats', 'YouTube returned no playable formats for this video.', true],
];

export function classifyYtdlpError(stderr = '', { exitCode = null, spawnError = null, timedOut = false } = {}) {
  const lines = String(stderr).split('\n').map(l => l.trim()).filter(Boolean);
  const detail = (lines.filter(l => /^ERROR:/.test(l)).pop() || lines.pop() || '').slice(0, 400);
  if (spawnError?.code === 'ENOENT') return new ExtractError(503, 'extractor_missing', 'yt-dlp is not installed on the server (set YTDLP_PATH).', { detail: spawnError.message });
  if (timedOut) return new ExtractError(504, 'timeout', 'YouTube extraction timed out.', { retryable: true, detail });
  // Match against ERROR lines first so an unrelated WARNING cannot decide the class.
  const errors = lines.filter(l => /^ERROR:/.test(l)).join('\n') || lines.join('\n');
  for (const [re, status, code, message, retryable] of RULES) if (re.test(errors)) return new ExtractError(status, code, message, { retryable, detail });
  return new ExtractError(502, 'extraction_failed', 'YouTube extraction failed.', { retryable: true, detail: detail || `yt-dlp exited ${exitCode}` });
}

const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

export function normalizeFormat(f) {
  if (!f || typeof f.url !== 'string' || !/^https?:\/\//.test(f.url)) return null;
  if (f.protocol && !/^https?$/.test(f.protocol)) return null; // HLS/DASH manifests, storyboards (mhtml)
  if (f.has_drm) return null;
  const itag = Number.parseInt(f.format_id, 10);
  if (!Number.isFinite(itag)) return null;
  const hasVideo = !!f.vcodec && f.vcodec !== 'none';
  const hasAudio = !!f.acodec && f.acodec !== 'none';
  if (!hasVideo && !hasAudio) return null;
  const ext = f.ext || 'mp4';
  const container = String(f.container || ext).replace(/_dash$/, '');
  const codecs = [hasVideo && f.vcodec, hasAudio && f.acodec].filter(Boolean).join(', ');
  let clen = null;
  try { clen = num(new URL(f.url).searchParams.get('clen')); } catch {}
  return {
    itag, formatId: String(f.format_id), url: f.url,
    mimeType: `${hasVideo ? 'video' : 'audio'}/${ext === 'm4a' ? 'mp4' : ext}; codecs="${codecs}"`,
    width: num(f.width), height: num(f.height), fps: num(f.fps),
    bitrate: Math.round((num(f.tbr) ?? num(f.vbr) ?? num(f.abr) ?? 0) * 1000),
    hasAudio, hasVideo, container,
    vcodec: hasVideo ? f.vcodec : null, acodec: hasAudio ? f.acodec : null,
    contentLength: num(f.filesize) ?? clen,
    audioSampleRate: num(f.asr), audioChannels: num(f.audio_channels),
    language: f.language || null, languagePreference: num(f.language_preference),
    dynamicRange: f.dynamic_range || null, note: f.format_note || null,
  };
}

export function normalizeInfo(info, videoId) {
  if (info.is_live || info.live_status === 'is_live') throw new ExtractError(422, 'live_unsupported', 'Live streams are not supported yet.');
  if (info.live_status === 'is_upcoming') throw new ExtractError(409, 'upcoming', 'This video has not premiered yet.');
  const formats = (info.formats || []).map(normalizeFormat).filter(Boolean);
  if (!formats.length) {
    if ((info.formats || []).some(f => f.has_drm)) throw new ExtractError(403, 'drm_protected', 'This video is DRM-protected and cannot be played here.');
    throw new ExtractError(422, 'no_formats', 'YouTube returned no playable formats for this video.', { retryable: true });
  }
  let expiresAt = null;
  for (const f of formats) {
    try { const e = Number(new URL(f.url).searchParams.get('expire')); if (e > 0) expiresAt = Math.min(expiresAt ?? Infinity, e * 1000); } catch {}
  }
  return {
    videoId, title: info.title || 'YouTube video', channel: info.channel || info.uploader || null,
    duration: num(info.duration), thumbnail: info.thumbnail || null,
    ageLimit: num(info.age_limit) || 0, availability: info.availability || null,
    formats, expiresAt,
  };
}

function runYtdlp(args, { timeoutMs }) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', done = false, timedOut = false;
    const p = spawn(ytdlpPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    const finish = r => { if (!done) { done = true; clearTimeout(t); resolve({ stdout, stderr, ...r }); } };
    const t = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeoutMs);
    p.stdout.on('data', d => { stdout += d; if (stdout.length > 32e6) p.kill('SIGKILL'); });
    p.stderr.on('data', d => { stderr = (stderr + d).slice(-20000); });
    p.on('error', spawnError => finish({ exitCode: null, spawnError }));
    p.on('close', exitCode => finish({ exitCode, timedOut }));
  });
}

export function buildYtdlpArgs(videoId, clients, egress) {
  let extra = [];
  if (process.env.YTDLP_EXTRA_ARGS) {
    try { extra = JSON.parse(process.env.YTDLP_EXTRA_ARGS); } catch { console.warn('[ytdlp] YTDLP_EXTRA_ARGS must be a JSON array of strings'); }
    if (!Array.isArray(extra) || extra.some(a => typeof a !== 'string' || /^--?(cookies|username|password|netrc|ap-)/.test(a))) extra = []; // public videos only
  }
  return [...extra, '-j', '--no-playlist', '--skip-download', '--no-progress', '--socket-timeout', '15',
    '--extractor-args', `youtube:player_client=${clients}`, ...ytdlpEgressArgs(egress),
    '--', `https://www.youtube.com/watch?v=${videoId}`];
}

// ---- stats (for /api/health) -------------------------------------------------------------------------
const stats = () => shared('extractStats', () => ({ attempts: [], requests: [], cacheHits: 0, startedAt: Date.now() }));
const push = (arr, x) => { arr.push(x); if (arr.length > 1000) arr.splice(0, arr.length - 1000); };

export function extractionStats() {
  const s = stats(), hourAgo = Date.now() - 3600e3;
  const rate = arr => (arr.length ? +(arr.filter(x => x.ok).length / arr.length).toFixed(3) : null);
  const count = (arr, key) => arr.reduce((m, x) => { const k = x[key] ?? 'ok'; m[k] = (m[k] || 0) + 1; return m; }, {});
  const lastHour = s.requests.filter(x => x.t >= hourAgo);
  return {
    // A request = one extract() that reached yt-dlp (after all fallbacks). An attempt = one yt-dlp run.
    requests: s.requests.length, successRate: rate(s.requests),
    lastHour: { requests: lastHour.length, successRate: rate(lastHour) },
    attempts: s.attempts.length, attemptSuccessRate: rate(s.attempts),
    cacheHits: s.cacheHits,
    byCode: count(s.requests, 'code'),
    byClient: Object.fromEntries(Object.entries(s.attempts.reduce((m, a) => { (m[a.client] ||= []).push(a); return m; }, {})).map(([k, v]) => [k, { attempts: v.length, successRate: rate(v) }])),
    avgMs: s.requests.length ? Math.round(s.requests.reduce((x, r) => x + r.ms, 0) / s.requests.length) : null,
    recentErrors: s.requests.filter(r => !r.ok).slice(-5).map(r => ({ at: new Date(r.t).toISOString(), videoId: r.videoId, code: r.code })),
  };
}

// ---- extraction ----------------------------------------------------------------------------------
const cache = () => shared('extractCache', () => new Map());

export function invalidateExtraction(videoId) { cache().delete(videoId); }

export function extract(videoId, { force = false } = {}) {
  if (!VIDEO_ID_RE.test(String(videoId))) return Promise.reject(new ExtractError(400, 'invalid_video_id', 'Invalid video ID'));
  const c = cache(), now = Date.now();
  const hit = c.get(videoId);
  if (hit && !force && (hit.promise || hit.exp > now)) {
    if (!hit.promise) stats().cacheHits++;
    return hit.promise || (hit.error ? Promise.reject(hit.error) : Promise.resolve({ ...hit.value, cached: true }));
  }
  const promise = extractUncached(videoId).then(value => {
    const ttl = envInt('EXTRACT_CACHE_SECONDS', 300) * 1000;
    const exp = Math.min(Date.now() + ttl, value.expiresAt ? value.expiresAt - 60e3 : Infinity);
    c.set(videoId, { value, exp });
    return { ...value, cached: false };
  }, error => {
    // Permanent errors are remembered briefly; transient ones are retried by the next caller.
    if (error instanceof ExtractError && !error.retryable && error.status !== 400 && error.status !== 503) c.set(videoId, { error, exp: Date.now() + 120e3 });
    else c.delete(videoId);
    throw error;
  });
  c.set(videoId, { promise });
  if (c.size > 2000) for (const [k, v] of c) if (!v.promise && v.exp < now) c.delete(k);
  return promise;
}

async function extractUncached(videoId) {
  const started = Date.now();
  const timeoutMs = envInt('YTDLP_TIMEOUT_MS', 45000);
  let last;
  for (const clients of clientGroups()) {
    const egress = await pickEgress({ videoId });
    const t0 = Date.now();
    const r = await runYtdlp(buildYtdlpArgs(videoId, clients, egress), { timeoutMs });
    let result, error;
    if (r.exitCode === 0 && !r.timedOut) {
      try { result = normalizeInfo(JSON.parse(r.stdout.trim().split('\n').pop()), videoId); }
      catch (e) { error = e instanceof ExtractError ? e : new ExtractError(502, 'extraction_failed', 'yt-dlp returned unreadable output', { retryable: true, detail: e.message }); }
    } else error = classifyYtdlpError(r.stderr, r);
    push(stats().attempts, { t: t0, ok: !error, code: error?.code, client: clients, egress: egress.id, ms: Date.now() - t0 });
    if (!error) {
      noteEgress(egress, 'ok');
      push(stats().requests, { t: started, ok: true, videoId, ms: Date.now() - started });
      return { ...result, egress, client: clients, extractedAt: Date.now() };
    }
    last = error;
    if (error.code === 'blocked') await reportBlocked(egress, error.detail || error.code);
    else if (error.retryable) noteEgress(egress, 'failed');
    console.warn(`[ytdlp] ${videoId} client=${clients} egress=${egress.id}: ${error.code}${error.detail ? ` (${error.detail.slice(0, 200)})` : ''}`);
    if (!error.retryable) break;
  }
  push(stats().requests, { t: started, ok: false, code: last.code, videoId, ms: Date.now() - started });
  throw last;
}

export function findFormat(x, itag) {
  return x.formats.find(f => f.formatId === String(itag)) || x.formats.find(f => f.itag === Number(itag)) || null;
}

// Resolver used by the relay: current CDN URL for (video, itag); refresh re-runs extraction.
export function formatResolver(videoId, itag) {
  return async ({ refresh }) => {
    if (refresh) invalidateExtraction(videoId);
    const x = await extract(videoId, { force: refresh });
    const f = findFormat(x, itag);
    if (!f) throw new ExtractError(404, 'unknown_itag', `Format ${itag} is not available for this video`);
    return { url: f.url, egress: x.egress, contentLength: f.contentLength, mimeType: f.mimeType };
  };
}

// Public projection for /api/extract: no egress identity.
export function publicExtraction(x) {
  return {
    videoId: x.videoId, title: x.title, channel: x.channel, duration: x.duration, thumbnail: x.thumbnail,
    extractedAt: new Date(x.extractedAt).toISOString(), expiresAt: x.expiresAt ? new Date(x.expiresAt).toISOString() : null,
    client: x.client, cached: !!x.cached,
    formats: x.formats.map(f => ({ itag: f.itag, url: f.url, mimeType: f.mimeType, width: f.width, height: f.height, fps: f.fps, bitrate: f.bitrate,
      hasAudio: f.hasAudio, hasVideo: f.hasVideo, container: f.container, contentLength: f.contentLength })),
  };
}
