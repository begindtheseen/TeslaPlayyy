// GET /api/youtube/search?query=... -> metadata only (YouTube Data API v3 search.list, 100 quota units).
import { search, sendYouTubeError } from '../../../lib/server/youtube.js';
import { rateLimit } from '../../../lib/server/rateLimit.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!rateLimit(req, res, { name: 'search', limit: 30, windowMs: 60e3 })) return;
  try { res.status(200).json(await search(req.query.query)); }
  catch (e) { sendYouTubeError(res, e); }
}
