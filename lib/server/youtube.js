// YouTube Data API v3 (metadata only). The Data API does not return media stream URLs.
import { shared } from './state.js';

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
// Overridable only so tests can point at a mock Data API server.
const API = () => process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3';

export class YouTubeError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function key() {
  const k = process.env.YOUTUBE_API_KEY;
  if (!k || k === 'your_key_here') throw new YouTubeError(503, 'missing_api_key', 'YOUTUBE_API_KEY is not configured on the server');
  return k;
}

function cached(name, id, ttlMs, fn) {
  const cache = shared('yt:' + name, () => new Map());
  const hit = cache.get(id);
  if (hit && hit.exp > Date.now()) return hit.value;
  const value = fn().then(v => v, e => { cache.delete(id); throw e; });
  if (cache.size > 500) cache.clear();
  cache.set(id, { exp: Date.now() + ttlMs, value });
  return value;
}

async function call(path, params, fetchImpl = fetch) {
  const u = new URL(`${API()}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('key', key());
  let r;
  try { r = await fetchImpl(u, { signal: AbortSignal.timeout(10000) }); }
  catch (e) { throw new YouTubeError(502, 'upstream_unreachable', `YouTube API unreachable: ${e.message}`); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const reason = d?.error?.errors?.[0]?.reason || '';
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || reason === 'rateLimitExceeded')
      throw new YouTubeError(429, 'quota_exceeded', 'YouTube API quota exhausted for today. Search resumes after the daily reset (midnight Pacific).');
    if (reason === 'keyInvalid' || r.status === 400 && /API key/i.test(d?.error?.message || ''))
      throw new YouTubeError(503, 'invalid_api_key', 'The configured YOUTUBE_API_KEY was rejected');
    throw new YouTubeError(r.status >= 500 ? 502 : r.status, reason || 'youtube_error', d?.error?.message || `YouTube API error ${r.status}`);
  }
  return d;
}

export function validateQuery(raw) {
  const q = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!q) throw new YouTubeError(400, 'missing_query', 'Missing query');
  if (q.length > 100) throw new YouTubeError(400, 'query_too_long', 'Query must be 100 characters or fewer');
  return q;
}

// search.list costs 100 quota units per call; results are cached for 10 minutes.
export function search(query, { fetchImpl } = {}) {
  const q = validateQuery(query);
  return cached('search', q.toLowerCase(), 10 * 60e3, async () => {
    const d = await call('search', { part: 'snippet', q, type: 'video', maxResults: '12', safeSearch: 'moderate', videoEmbeddable: 'true' }, fetchImpl);
    return {
      items: (d.items || []).filter(i => VIDEO_ID_RE.test(i?.id?.videoId || '')).map(i => ({
        id: { videoId: i.id.videoId },
        snippet: {
          title: i.snippet?.title || '', channelTitle: i.snippet?.channelTitle || '', publishedAt: i.snippet?.publishedAt || null,
          thumbnails: { medium: { url: i.snippet?.thumbnails?.medium?.url || i.snippet?.thumbnails?.default?.url || '' } },
        },
      })),
    };
  });
}

// videos.list costs 1 unit.
export function info(videoId, { fetchImpl } = {}) {
  if (!VIDEO_ID_RE.test(String(videoId))) return Promise.reject(new YouTubeError(400, 'invalid_video_id', 'Invalid video ID'));
  return cached('info', videoId, 30 * 60e3, async () => {
    const d = await call('videos', { part: 'snippet,contentDetails,status', id: videoId }, fetchImpl);
    const v = d.items?.[0];
    if (!v) throw new YouTubeError(404, 'not_found', 'Video not found or private');
    return {
      id: v.id,
      title: v.snippet?.title || '',
      channelTitle: v.snippet?.channelTitle || '',
      thumbnail: v.snippet?.thumbnails?.medium?.url || null,
      duration: parseIsoDuration(v.contentDetails?.duration),
      embeddable: v.status?.embeddable !== false,
      privacyStatus: v.status?.privacyStatus || null,
      live: v.snippet?.liveBroadcastContent && v.snippet.liveBroadcastContent !== 'none' ? v.snippet.liveBroadcastContent : null,
    };
  });
}

export function parseIsoDuration(s) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s || '');
  if (!m) return null;
  return ((+m[1] || 0) * 86400) + ((+m[2] || 0) * 3600) + ((+m[3] || 0) * 60) + (+m[4] || 0);
}

export function sendYouTubeError(res, e) {
  if (e instanceof YouTubeError) return res.status(e.status).json({ error: e.message, code: e.code });
  console.error('[youtube]', e);
  return res.status(500).json({ error: 'Unexpected server error', code: 'internal' });
}
