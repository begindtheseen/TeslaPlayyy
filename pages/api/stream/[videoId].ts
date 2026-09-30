// GET /api/stream/:videoId?itag=<n>&session=<id>  (Range: bytes=a-b)
// Range-aware proxy of one googlevideo format: 206 + Content-Range + Accept-Ranges, streamed with
// backpressure, upstream aborted on client disconnect. Without ?itag -> 307 to /api/muxed (video+audio).
import type { NextApiRequest, NextApiResponse } from 'next';
import { handleYoutubeRange } from '../../../lib/server/youtubeStream.js';

export const config = { api: { responseLimit: false, bodyParser: false }, runtime: 'nodejs' };

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const q = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  return handleYoutubeRange(req, res, { videoId: String(req.query.videoId || ''), itag: req.query.itag as string | undefined, sessionId: req.query.session as string | undefined, query: q });
}
