// YouTube media routes: /api/stream/:videoId (range proxy of one format) and /api/muxed/:videoId
// (FFmpeg remux of video+audio into MPEG-TS). Both require a playback session bound to the video,
// so the server is not an open proxy (set STREAM_REQUIRE_SESSION=0 to allow session-less debugging).
import { extract, invalidateExtraction, ExtractError, VIDEO_ID_RE } from './ytdlp.js';
import { relayRange, sendJson } from './cdnRelay.js';
import { getSession, touchSession } from './sessions.js';

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

export function checkSession(res, videoId, sessionId) {
  if (process.env.STREAM_REQUIRE_SESSION === '0' && !sessionId) return {};
  const s = getSession(sessionId);
  if (!s || s.youtubeVideoId !== videoId) { sendJson(res, 403, { error: 'Missing or expired playback session', code: 'invalid_session' }); return null; }
  touchSession(s.id);
  return s;
}

export async function handleYoutubeRange(req, res, { videoId, itag, sessionId, query = '' }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); return sendJson(res, 405, { error: 'Method not allowed' }); }
  if (!VIDEO_ID_RE.test(String(videoId))) return sendJson(res, 400, { error: 'Invalid video ID', code: 'invalid_video_id' });
  // No itag: the default 1080p+audio combo needs both tracks in one stream, which is what /api/muxed is.
  if (itag === undefined || itag === '') { res.writeHead(307, { Location: `/api/muxed/${videoId}${query}` }); return res.end(); }
  if (!/^\d{1,4}(-\w+)?$/.test(String(itag))) return sendJson(res, 400, { error: 'Invalid itag', code: 'invalid_itag' });
  if (!checkSession(res, videoId, sessionId)) return;
  return relayRange(req, res, { resolve: formatResolver(videoId, itag), label: `stream ${videoId}/${itag}` });
}
