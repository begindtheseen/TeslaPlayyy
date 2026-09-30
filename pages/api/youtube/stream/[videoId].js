// GET /api/youtube/stream/:videoId?session=<id>&t=<seconds>  (legacy URL, kept for existing clients)
// Operator-licensed copies (YOUTUBE_AUTHORIZED_MAP) stream from the catalog; everything else is the
// server-muxed YouTube stream, identical to /api/muxed/:videoId.
import { authorizedAssetForYouTube } from '../../../../lib/server/catalog.js';
import { handleStream } from '../../../../lib/server/streamHandler.js';
import { handleYoutubeMuxed } from '../../../../lib/server/youtubeStream.js';

export const config = { api: { responseLimit: false, bodyParser: false }, runtime: 'nodejs' };

export default function handler(req, res) {
  const id = String(req.query.videoId || '');
  const asset = authorizedAssetForYouTube(id);
  if (asset) return handleStream(req, res, { assetId: asset.id, sessionId: req.query.session, t: req.query.t });
  return handleYoutubeMuxed(req, res, { videoId: id, sessionId: req.query.session, t: req.query.t });
}
