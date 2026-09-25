// GET /api/youtube/stream/:videoId?session=<id>&t=<seconds>
// Extracts YouTube video via ytdl-core and transcodes to MPEG-TS on-the-fly.
// Falls back to authorized catalog asset if configured (YOUTUBE_AUTHORIZED_MAP).
import { authorizedAssetForYouTube } from '../../../../lib/server/catalog.js';
import { VIDEO_ID_RE, extractYoutubeStream } from '../../../../lib/server/youtube.js';
import { handleStream } from '../../../../lib/server/streamHandler.js';
import { ffmpegAvailable, buildArgs, streamToResponse, activeProcesses } from '../../../../lib/server/ffmpeg.js';
import { getSession, touchSession } from '../../../../lib/server/sessions.js';
import { envInt } from '../../../../lib/server/state.js';

export const config = { api: { responseLimit: false } };

const json = (res, status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };

export default async function handler(req, res) {
  const id = String(req.query.videoId || '');
  if (!VIDEO_ID_RE.test(id)) return json(res, 400, { error: 'Invalid video ID', code: 'invalid_video_id' });
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

  // Try authorized copy first.
  const asset = authorizedAssetForYouTube(id);
  if (asset) return handleStream(req, res, { assetId: asset.id, sessionId: req.query.session, t: req.query.t });

  // No authorized copy: extract from YouTube and transcode on-the-fly.
  if (!ffmpegAvailable()) {
    return json(res, 503, {
      error: 'FFmpeg is required for YouTube streaming but is not installed on the server',
      code: 'ffmpeg_unavailable',
    });
  }

  const session = getSession(req.query.session);
  if (!session || session.youtubeVideoId !== id) {
    return json(res, 403, { error: 'Missing or expired playback session', code: 'invalid_session' });
  }
  touchSession(session.id);

  const seconds = req.query.t === undefined || req.query.t === '' ? 0 : Number(req.query.t);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) {
    return json(res, 400, { error: 'Invalid t', code: 'invalid_seek' });
  }

  if (activeProcesses().size >= envInt('MEDIA_MAX_STREAMS', 8)) {
    return json(res, 503, { error: 'Streaming capacity reached, try again shortly', code: 'capacity' });
  }

  try {
    const extracted = await extractYoutubeStream(id);
    const url = extracted.url;

    for (const ac of session.streams) ac.abort();
    session.streams.clear();
    const ac = new AbortController();
    session.streams.add(ac);

    const reason = await streamToResponse({
      args: buildArgs({ kind: 'remote', url }, { duration: extracted.duration, copyVideo: false, copyAudio: false, audio: true, startTime: 0 }, { ss: seconds }),
      res,
      signal: ac.signal,
      onStart: () => res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Stream-Mode': 'transcode+transcode',
        'X-Media-Start-Time': '0',
      }),
      log: (why, stderr) => {
        if (!['complete', 'client-closed', 'aborted'].includes(why)) {
          console.warn(`[youtube ${id}] ${why}: ${stderr.slice(-300)}`);
        }
      },
    });
    session.streams.delete(ac);
    return reason;
  } catch (e) {
    return json(res, e?.status || 502, { error: e?.message || 'Failed to stream YouTube video', code: e?.code || 'extraction_failed' });
  }
}
