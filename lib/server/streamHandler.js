// GET /api/media/stream/:assetId?session=<id>&t=<seconds>
// Streams an authorized catalog asset as chunked MPEG-TS (H.264 + AAC-LC), remuxing with FFmpeg
// stream copy when possible and transcoding otherwise.
import { createReadStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { getAsset, resolveSource } from './catalog.js';
import { ffmpegAvailable, probe, keyframeIndex, planSeek, buildArgs, streamToResponse, activeProcesses } from './ffmpeg.js';
import { getSession, touchSession } from './sessions.js';
import { assertFetchableUrl } from './urlGuard.js';
import { envInt } from './state.js';

const json = (res, status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };

export async function handleStream(req, res, { assetId, sessionId, t }) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  const asset = getAsset(assetId);
  if (!asset) return json(res, 404, { error: 'Unknown media asset', code: 'unknown_asset' });
  const session = getSession(sessionId);
  if (!session || session.assetId !== asset.id) return json(res, 403, { error: 'Missing or expired playback session', code: 'invalid_session' });
  touchSession(session.id);

  const seconds = t === undefined || t === '' ? 0 : Number(t);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) return json(res, 400, { error: 'Invalid t', code: 'invalid_seek' });

  let src;
  try {
    src = resolveSource(asset);
    if (src.kind === 'remote') await assertFetchableUrl(src.url);
  } catch (e) { return json(res, 403, { error: e.message, code: 'source_rejected' }); }

  // Without FFmpeg the bundled TS fixture can still be served as-is from the start.
  if (!ffmpegAvailable()) {
    if (src.kind === 'local' && src.path.endsWith('.ts') && seconds === 0) {
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': statSync(src.path).size, 'Cache-Control': 'no-store', 'X-Stream-Mode': 'file' });
      return pipeline(createReadStream(src.path), res).catch(() => {});
    }
    return json(res, 503, { error: 'FFmpeg is not installed on the server', code: 'ffmpeg_unavailable' });
  }

  if (activeProcesses().size >= envInt('MEDIA_MAX_STREAMS', 8)) return json(res, 503, { error: 'Streaming capacity reached, try again shortly', code: 'capacity' });

  let info, plan;
  try {
    info = await probe(src);
    if (info.duration && seconds >= info.duration) return json(res, 416, { error: 'Seek position beyond end of media', code: 'invalid_seek' });
    plan = planSeek(seconds, await keyframeIndex(src, info));
  } catch (e) { return json(res, 502, { error: `Could not read media source: ${e.message}`, code: 'probe_failed' }); }

  // One live stream per session: a new request (seek) cancels the previous FFmpeg process.
  for (const ac of session.streams) ac.abort();
  session.streams.clear();
  const ac = new AbortController();
  session.streams.add(ac);

  const mode = `${info.copyVideo ? 'copy' : 'transcode'}+${info.audio ? (info.copyAudio ? 'copy' : 'transcode') : 'none'}`;
  const reason = await streamToResponse({
    args: buildArgs(src, info, { ss: plan.ss }),
    res,
    signal: ac.signal,
    onStart: () => res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Stream-Mode': mode,
      'X-Media-Start-Time': String(info.startTime),
      'X-Seek-Requested': String(seconds),
      ...(plan.keyframe !== null ? { 'X-Seek-Keyframe': plan.keyframe.toFixed(3) } : {}),
    }),
    log: (why, stderr) => { if (!['complete', 'client-closed', 'aborted'].includes(why)) console.warn(`[stream ${asset.id}] ${why}: ${stderr.slice(-300)}`); },
  });
  session.streams.delete(ac);
  return reason;
}
