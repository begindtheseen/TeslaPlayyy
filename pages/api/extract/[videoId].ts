// GET /api/extract/:videoId -> formats extracted by yt-dlp (Node runtime: spawns a child process).
// 200 {videoId,title,duration,formats:[{itag,url,mimeType,width,height,bitrate,hasAudio,hasVideo,container}],recommended}
// 404 private/removed · 403 age-gated/members-only/DRM · 451 region-locked · 422 live/no formats · 429 blocked
// The CDN URLs are locked to the server's egress IP; browsers play through /api/stream or /api/muxed.
import type { NextApiRequest, NextApiResponse } from 'next';
import { extract, publicExtraction, ExtractError } from '../../../lib/server/ytdlp.js';
import { planDelivery, describeFormat } from '../../../lib/server/formats.js';
import { rateLimit } from '../../../lib/server/rateLimit.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  if (!rateLimit(req, res, { name: 'extract', limit: 20, windowMs: 60e3 })) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    const x = await extract(String(req.query.videoId || ''), { force: req.query.refresh === '1' });
    const plan = planDelivery(x.formats, { delivery: String(req.query.delivery || 'auto'), userAgent: req.headers['user-agent'] });
    res.status(200).json({
      ...publicExtraction(x),
      recommended: plan && { delivery: plan.delivery, reason: plan.reason, transcode: plan.transcode, video: describeFormat(plan.video), audio: describeFormat(plan.audio) },
    });
  } catch (e) {
    if (e instanceof ExtractError) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error('[extract]', e);
    res.status(500).json({ error: 'Unexpected server error', code: 'internal' });
  }
}
