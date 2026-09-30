// YouTube media routes: /api/stream/:videoId (range proxy of one format) and /api/muxed/:videoId
// (FFmpeg remux of video+audio into MPEG-TS). Both require a playback session bound to the video,
// so the server is not an open proxy (set STREAM_REQUIRE_SESSION=0 to allow session-less debugging).
import { VIDEO_ID_RE, formatResolver, extract, findFormat } from './ytdlp.js';
import { relayRange, sendJson } from './cdnRelay.js';
import { getSession, touchSession } from './sessions.js';
import { planDelivery } from './formats.js';
import { loopbackUrl } from './loopbackRelay.js';
import { ffmpegAvailable, streamToResponse, activeProcesses } from './ffmpeg.js';
import { envInt } from './state.js';

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

// FFmpeg reconnect/timeout options for the loopback HTTP inputs (seekable: the relay answers ranges).
const HTTP_IN = ['-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '4', '-rw_timeout', '20000000'];

// Remux separate DASH video + audio into one MPEG-TS stream. `-c copy` = no re-encode, near-zero CPU.
// -copyts keeps source timestamps so the player maps PTS straight to media time after a seek.
export function muxArgs({ videoUrl, audioUrl, ss = 0, videoHasAudio = false, transcode = { video: false, audio: false } }) {
  const seek = ss > 0 ? ['-ss', ss.toFixed(3)] : [];
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...HTTP_IN, ...seek, '-i', videoUrl];
  if (audioUrl) args.push(...HTTP_IN, ...seek, '-i', audioUrl);
  args.push('-map', '0:v:0');
  if (audioUrl) args.push('-map', '1:a:0'); else if (videoHasAudio) args.push('-map', '0:a:0?');
  if (transcode.video) args.push('-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '60', '-bf', '0');
  else args.push('-c:v', 'copy');
  if (audioUrl || videoHasAudio) {
    if (transcode.audio) args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2'); else args.push('-c:a', 'copy');
  }
  args.push('-copyts', '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', 'pipe:1');
  return args;
}

// GET /api/muxed/:videoId?session=&t=  -> chunked video/mp2t (H.264 + AAC) for the TS worker path.
export async function handleYoutubeMuxed(req, res, { videoId, sessionId, t, videoItag, audioItag }) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return sendJson(res, 405, { error: 'Method not allowed' }); }
  if (!VIDEO_ID_RE.test(String(videoId))) return sendJson(res, 400, { error: 'Invalid video ID', code: 'invalid_video_id' });
  const session = checkSession(res, videoId, sessionId);
  if (!session) return;
  const seconds = t === undefined || t === '' || t === null ? 0 : Number(t);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) return sendJson(res, 400, { error: 'Invalid t', code: 'invalid_seek' });
  if (!ffmpegAvailable()) return sendJson(res, 503, { error: 'FFmpeg is not installed on the server', code: 'ffmpeg_unavailable' });
  if (activeProcesses().size >= envInt('MEDIA_MAX_STREAMS', 8)) return sendJson(res, 503, { error: 'Streaming capacity reached, try again shortly', code: 'capacity' });

  let x;
  try { x = await extract(videoId); } catch (e) { return sendJson(res, e.status || 502, { error: e.message, code: e.code || 'extraction_failed' }); }
  if (x.duration && seconds >= x.duration) return sendJson(res, 416, { error: 'Seek position beyond end of media', code: 'invalid_seek' });

  // The session pins the formats chosen at start so seeks and reconnects stay on the same streams.
  let plan = session.plan;
  if (!plan) {
    const p = planDelivery(x.formats, { delivery: 'muxed', userAgent: req.headers['user-agent'] });
    plan = p && { video: videoItag || p.video.formatId, audio: audioItag || p.audio?.formatId || null, transcode: p.transcode };
  }
  const vf = plan && findFormat(x, plan.video), af = plan?.audio ? findFormat(x, plan.audio) : null;
  if (!vf) return sendJson(res, 422, { error: 'No playable video format', code: 'no_formats' });

  const v = await loopbackUrl(videoId, vf.formatId);
  const a = af ? await loopbackUrl(videoId, af.formatId) : null;
  // One live stream per session: a new request (seek / reconnect) cancels the previous FFmpeg.
  session.streams?.forEach(ac => ac.abort());
  session.streams?.clear();
  const ac = new AbortController();
  session.streams?.add(ac);
  const mode = `${plan.transcode?.video ? 'transcode' : 'copy'}+${af || vf.hasAudio ? (plan.transcode?.audio ? 'transcode' : 'copy') : 'none'}`;
  try {
    return await streamToResponse({
      args: muxArgs({ videoUrl: v.url, audioUrl: a?.url, ss: seconds, videoHasAudio: vf.hasAudio, transcode: plan.transcode }),
      res, signal: ac.signal,
      onStart: () => res.writeHead(200, {
        'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'X-Stream-Mode': `muxed ${mode}`, 'X-Media-Start-Time': '0', 'X-Seek-Requested': String(seconds),
        'X-Formats': `${vf.formatId}${af ? '+' + af.formatId : ''}`,
      }),
      log: (why, stderr) => { if (!['complete', 'client-closed', 'aborted'].includes(why)) console.warn(`[muxed ${videoId}] ${why}: ${stderr.slice(-300)}`); },
    });
  } finally {
    v.revoke(); a?.revoke();
    session.streams?.delete(ac);
  }
}
