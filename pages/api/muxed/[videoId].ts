// GET /api/muxed/:videoId?session=<id>&t=<seconds>
// Server-side remux (the Intel MCU path): FFmpeg reads the DASH video + audio streams through the
// loopback range relay and copies them (-c copy, no re-encode) into ONE MPEG-TS stream for the
// existing worker demuxer. Seeking = new request with ?t=; FFmpeg seeks both inputs by byte range.
import type { NextApiRequest, NextApiResponse } from 'next';
import { handleYoutubeMuxed } from '../../../lib/server/youtubeStream.js';

export const config = { api: { responseLimit: false, bodyParser: false }, runtime: 'nodejs' };

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const q = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined);
  return handleYoutubeMuxed(req, res, { videoId: String(req.query.videoId || ''), sessionId: q('session'), t: q('t'), videoItag: q('itag'), audioItag: q('audioItag') });
}
