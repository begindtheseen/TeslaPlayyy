// GET /api/youtube/info/:videoId -> metadata + which players can play it.
import { info, sendYouTubeError } from '../../../../lib/server/youtube.js';
import { authorizedAssetForYouTube } from '../../../../lib/server/catalog.js';
import { rateLimit } from '../../../../lib/server/rateLimit.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!rateLimit(req, res, { name: 'info', limit: 60, windowMs: 60e3 })) return;
  try {
    const v = await info(req.query.videoId);
    res.status(200).json({ ...v, playback: { iframe: v.embeddable, canvas: !!authorizedAssetForYouTube(v.id) } });
  } catch (e) { sendYouTubeError(res, e); }
}
