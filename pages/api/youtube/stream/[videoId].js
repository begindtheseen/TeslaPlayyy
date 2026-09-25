// GET /api/youtube/stream/:videoId?session=<id>
// Only serves bytes when the operator mapped this video to a licensed catalog asset
// (YOUTUBE_AUTHORIZED_MAP). YouTube itself offers no API for raw media; nothing is extracted from YouTube.
import { authorizedAssetForYouTube } from '../../../../lib/server/catalog.js';
import { VIDEO_ID_RE } from '../../../../lib/server/youtube.js';
import { handleStream } from '../../../../lib/server/streamHandler.js';

export const config = { api: { responseLimit: false } };

export default function handler(req, res) {
  const id = String(req.query.videoId || '');
  if (!VIDEO_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid video ID', code: 'invalid_video_id' });
  const asset = authorizedAssetForYouTube(id);
  if (!asset) {
    return res.status(501).json({
      error: 'No authorized media source for this YouTube video',
      code: 'no_authorized_media',
      detail: 'YouTube does not provide raw audio/video streams to third-party players. Use player "youtube-iframe" from POST /api/playback/session, or map this video to a licensed asset with YOUTUBE_AUTHORIZED_MAP.',
    });
  }
  return handleStream(req, res, { assetId: asset.id, sessionId: req.query.session, t: req.query.t });
}
