// Shared playback-session interface. Every session resolves to exactly one player:
//   player: 'canvas'         -> authorized H.264/AAC MPEG-TS stream for the WebCodecs/OffscreenCanvas engine
//   player: 'youtube-iframe' -> official YouTube IFrame Player API (YouTube renders and streams the media)
import { getAsset, authorizedAssetForYouTube, resolveSource, publicAsset } from './catalog.js';
import { probe, ffmpegAvailable } from './ffmpeg.js';
import { createSession, heartbeatIntervalMs } from './sessions.js';
import { VIDEO_ID_RE } from './youtube.js';
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

export async function createPlaybackSession(source) {
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
    const authorized = authorizedAssetForYouTube(videoId);
    const wantCanvas = source.prefer === 'canvas';
    if (authorized && wantCanvas) {
      const canvas = await canvasDescriptor(authorized);
      const s = createSession({ player: 'canvas', assetId: authorized.id, youtubeVideoId: videoId });
      return envelope(s, { title: source.title || authorized.title, asset: publicAsset(authorized), youtube: { videoId },
        canvas: { ...canvas, streamUrl: streamUrl(authorized.id, s.id) },
        notice: 'Playing an operator-licensed copy of this video through the canvas player.' });
    }
    const s = createSession({ player: 'youtube-iframe', youtubeVideoId: videoId });
    return envelope(s, {
      title: source.title || null,
      youtube: { videoId, canvasAvailable: !!authorized },
      notice: wantCanvas
        ? 'No authorized raw-media source exists for this YouTube video, so it plays in the official YouTube player instead of the canvas engine.'
        : 'Played by the official YouTube IFrame Player. YouTube does not provide raw video/audio streams to third-party players.',
    });
  }

  throw new PlaybackError(400, 'invalid_source', `Unknown source kind: ${String(source.kind).slice(0, 20)}`);
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
