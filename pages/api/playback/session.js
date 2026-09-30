// POST /api/playback/session  {source:{kind:'catalog',id} | {kind:'youtube',videoId,title?,delivery?:'auto'|'muxed'|'dual',intel?,maxHeight?,maxFps?}}
// GET  /api/playback/session?videoId=demo|<assetId>|<youtubeId>[&intel=1][&delivery=dual][&maxHeight=720]
// YouTube ids resolve to canvas.streamUrl=/api/muxed/:id (delivery 'muxed') or canvas.tracks.{video,audio}
// on /api/stream/:id (delivery 'dual'). Errors: 404 private/removed, 403 age-gated, 451 region, 429 blocked.
import { createPlaybackSession, sendPlaybackError } from '../../../lib/server/playback.js';
import { getAsset } from '../../../lib/server/catalog.js';
import { rateLimit } from '../../../lib/server/rateLimit.js';

export default async function handler(req, res) {
  let source;
  if (req.method === 'POST') source = req.body?.source;
  else if (req.method === 'GET') {
    const id = String(req.query.videoId || '');
    source = getAsset(id) ? { kind: 'catalog', id } : { kind: 'youtube', videoId: id, intel: req.query.intel, delivery: req.query.delivery, maxHeight: req.query.maxHeight, maxFps: req.query.maxFps };
  } else {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!rateLimit(req, res, { name: 'session', limit: 60, windowMs: 60e3 })) return;
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(await createPlaybackSession(source, { userAgent: req.headers['user-agent'] || '' }));
  } catch (e) { sendPlaybackError(res, e); }
}
