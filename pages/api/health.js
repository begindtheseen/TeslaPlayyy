// GET /api/health -> server capabilities (no secrets).
import { ffmpegAvailable, activeProcesses } from '../../lib/server/ffmpeg.js';
import { sessionCount } from '../../lib/server/sessions.js';

export default function handler(req, res) {
  const key = process.env.YOUTUBE_API_KEY;
  res.status(200).json({
    ok: true,
    ffmpeg: ffmpegAvailable(),
    youtubeSearch: !!key && key !== 'your_key_here',
    sessions: sessionCount(),
    activeStreams: activeProcesses().size,
  });
}
