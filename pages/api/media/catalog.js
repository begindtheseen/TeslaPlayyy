// GET /api/media/catalog -> authorized assets playable by the canvas player.
import { catalog, publicAsset } from '../../../lib/server/catalog.js';

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.status(200).json({ items: [...catalog().values()].map(publicAsset) });
}
