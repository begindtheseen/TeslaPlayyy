// Playback sessions. Every session targets the independent canvas player (worker demux -> WebCodecs ->
// OffscreenCanvas + Web Audio). Public YouTube videos are extracted with yt-dlp and delivered either as
// one server-muxed MPEG-TS stream (/api/muxed) or as separate DASH video + audio tracks (/api/stream).
import { getAsset, authorizedAssetForYouTube, resolveSource, publicAsset } from './catalog.js';
import { probe, ffmpegAvailable } from './ffmpeg.js';
import { createSession, heartbeatIntervalMs } from './sessions.js';
import { VIDEO_ID_RE, extract, ExtractError } from './ytdlp.js';
import { planDelivery } from './formats.js';
import { assertFetchableUrl } from './urlGuard.js';

export class PlaybackError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

// Fallback metadata for the bundled fixtures so the demo works on hosts without ffprobe.
const FIXTURE_INFO = {
  demo: { duration: 5, startTime: 1.4, video: { codec: 'h264', width: 640, height: 360 }, audio: null, copyVideo: true, copyAudio: false, mpegtsInput: true },
};

async function canvasDescriptor(asset) {
  const src = resolveSource(asset);
  if (src.kind === 'remote') await assertFetchableUrl(src.url).catch(e => { throw new PlaybackError(403, 'source_rejected', e.message); });
  let info;
  if (ffmpegAvailable()) {
    try { info = await probe(src); }
    catch (e) { throw new PlaybackError(502, 'probe_failed', `Could not read media source: ${e.message}`); }
  } else if (FIXTURE_INFO[asset.id]) info = FIXTURE_INFO[asset.id];
  else throw new PlaybackError(503, 'ffmpeg_unavailable', 'FFmpeg/ffprobe is not installed on the server; only the bundled demo can play');
  return {
    duration: info.duration,
    startTime: info.startTime,
    hasAudio: !!info.audio,
    video: info.video,
    audio: info.audio,
    transcoding: { video: !info.copyVideo, audio: !!info.audio && !info.copyAudio },
    seekable: ffmpegAvailable() && !!info.duration,
  };
}

export async function createPlaybackSession(source, ctx = {}) {
  if (!source || typeof source !== 'object') throw new PlaybackError(400, 'invalid_source', 'Body must be {source:{kind,...}}');

  if (source.kind === 'catalog') {
    const asset = getAsset(source.id);
    if (!asset) throw new PlaybackError(404, 'unknown_asset', 'Unknown media asset');
    const canvas = await canvasDescriptor(asset);
    const s = createSession({ player: 'canvas', assetId: asset.id });
    return envelope(s, { title: asset.title, asset: publicAsset(asset), canvas: { ...canvas, streamUrl: streamUrl(asset.id, s.id) }, notice: asset.license ? `Authorized media: ${asset.license}` : null });
  }

  if (source.kind === 'youtube') {
    const videoId = String(source.videoId || '');
    if (!VIDEO_ID_RE.test(videoId)) throw new PlaybackError(400, 'invalid_video_id', 'Invalid video ID');

    // Try authorized copy first; fall back to direct extraction.
    const authorized = authorizedAssetForYouTube(videoId);
    if (authorized) {
      const canvas = await canvasDescriptor(authorized);
      const s = createSession({ player: 'canvas', assetId: authorized.id, youtubeVideoId: videoId });
      return envelope(s, { title: source.title || authorized.title, asset: publicAsset(authorized), youtube: { videoId },
        canvas: { ...canvas, streamUrl: `/api/youtube/stream/${videoId}?session=${encodeURIComponent(s.id)}` },
        notice: 'Streaming a licensed copy of this YouTube video through the canvas player.' });
    }

    return youtubeSession(videoId, source, ctx);
  }

  throw new PlaybackError(400, 'invalid_source', `Unknown source kind: ${String(source.kind).slice(0, 20)}`);
}

const clampInt = (v, lo, hi, dflt) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
const truthy = v => v === true || v === 1 || v === '1' || v === 'true';

async function youtubeSession(videoId, source, { userAgent = '' } = {}) {
  let x;
  try { x = await extract(videoId); }
  catch (e) {
    if (e instanceof ExtractError) throw new PlaybackError(e.status, e.code, e.message, { videoId, retryable: e.retryable });
    throw e;
  }
  // ?intel=1 forces the single-stream server-muxed path; otherwise the client's capability probe decides.
  const delivery = truthy(source.intel) ? 'muxed' : ['muxed', 'dual'].includes(source.delivery) ? source.delivery : 'auto';
  const maxHeight = clampInt(source.maxHeight, 144, 2160, 1080), maxFps = clampInt(source.maxFps, 24, 60, 60);
  let plan = planDelivery(x.formats, { delivery, maxHeight, maxFps, userAgent });
  if (!plan) throw new PlaybackError(422, 'no_formats', 'YouTube returned no playable video formats for this video.', { videoId });
  if (plan.delivery === 'muxed' && !ffmpegAvailable()) {
    const dual = planDelivery(x.formats, { delivery: 'dual', maxHeight, maxFps });
    if (dual?.delivery !== 'dual') throw new PlaybackError(503, 'ffmpeg_unavailable', 'FFmpeg is required to play this video but is not installed on the server.', { videoId });
    plan = { ...dual, reason: 'ffmpeg-unavailable' };
  }
  const v = plan.video, a = plan.audio;
  const s = createSession({ player: 'canvas', youtubeVideoId: videoId, delivery: plan.delivery,
    plan: { video: v.formatId, audio: a?.formatId || null, transcode: plan.transcode } });
  const q = `session=${encodeURIComponent(s.id)}`;
  const track = f => f && { url: `/api/stream/${videoId}?itag=${encodeURIComponent(f.formatId)}&${q}`, itag: f.itag, mimeType: f.mimeType, size: f.contentLength };
  const label = `${v.height ? `${v.height}p${v.fps > 30 ? Math.round(v.fps) : ''}` : 'video'}`;
  return envelope(s, {
    title: source.title || x.title, youtube: { videoId, channel: x.channel, thumbnail: x.thumbnail },
    canvas: {
      delivery: plan.delivery, deliveryReason: plan.reason,
      duration: x.duration, startTime: 0, hasAudio: !!(a || v.hasAudio), seekable: true,
      video: { codec: v.vcodec, width: v.width, height: v.height, fps: v.fps, itag: v.itag },
      audio: a || v.hasAudio ? { codec: (a || v).acodec, itag: a?.itag ?? v.itag } : null,
      transcoding: plan.transcode,
      ...(plan.delivery === 'dual'
        ? { tracks: { video: track(v), audio: track(a) } }
        : { streamUrl: `/api/muxed/${videoId}?${q}` }),
    },
    notice: `YouTube · ${label} · ${plan.delivery === 'dual' ? 'DASH video + audio via range proxy' : `server-muxed MPEG-TS${plan.transcode.video || plan.transcode.audio ? ' (transcoded)' : ''}`}`,
  });
}

const streamUrl = (assetId, sessionId) => `/api/media/stream/${encodeURIComponent(assetId)}?session=${encodeURIComponent(sessionId)}`;

function envelope(s, body) {
  return { sessionId: s.id, player: s.player, expiresAt: new Date(s.expiresAt).toISOString(), heartbeatIntervalMs: heartbeatIntervalMs(), ...body };
}

export function sendPlaybackError(res, e) {
  if (e instanceof PlaybackError || Number.isInteger(e?.status)) return res.status(e.status).json({ error: e.message, code: e.code || 'error', ...(e.extra || {}) });
  console.error('[playback]', e);
  return res.status(500).json({ error: 'Unexpected server error', code: 'internal' });
}
