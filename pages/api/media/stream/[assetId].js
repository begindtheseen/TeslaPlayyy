// GET /api/media/stream/:assetId?session=<id>&t=<seconds> -> chunked video/mp2t
import { handleStream } from '../../../../lib/server/streamHandler.js';

export const config = { api: { responseLimit: false } };

export default function handler(req, res) {
  return handleStream(req, res, { assetId: req.query.assetId, sessionId: req.query.session, t: req.query.t });
}
