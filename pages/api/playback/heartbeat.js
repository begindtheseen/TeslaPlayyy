// POST /api/playback/heartbeat {sessionId, position?, state?}  state 'closed' ends the session and its streams.
import { touchSession, closeSession } from '../../../lib/server/sessions.js';

export default function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const { sessionId, position, state } = req.body || {};
  if (state === 'closed') return res.status(200).json({ ok: closeSession(String(sessionId)), closed: true });
  const s = touchSession(String(sessionId || ''), { position: Number(position), state });
  if (!s) return res.status(404).json({ error: 'Session expired or unknown', code: 'invalid_session' });
  res.status(200).json({ ok: true, expiresAt: new Date(s.expiresAt).toISOString() });
}
