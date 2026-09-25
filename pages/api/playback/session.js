// POST /api/playback/session  {source:{kind:'catalog',id} | {kind:'youtube',videoId,prefer?:'canvas'|'iframe',title?}}
// GET  /api/playback/session?videoId=demo|<assetId>|<youtubeId>   (legacy query form, same response shape)
import { createPlaybackSession, sendPlaybackError } from '../../../lib/server/playback.js';
import { getAsset } from '../../../lib/server/catalog.js';
import { rateLimit } from '../../../lib/server/rateLimit.js';

export default async function handler(req, res) {
  let source;
  if (req.method === 'POST') source = req.body?.source;
  else if (req.method === 'GET') {
    const id = String(req.query.videoId || '');
    source = getAsset(id) ? { kind: 'catalog', id } : { kind: 'youtube', videoId: id, prefer: req.query.prefer };
  } else {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!rateLimit(req, res, { name: 'session', limit: 60, windowMs: 60e3 })) return;
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(await createPlaybackSession(source));
  } catch (e) { sendPlaybackError(res, e); }
}
