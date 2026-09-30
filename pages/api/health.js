// GET /api/health -> server capabilities and YouTube extraction health (no secrets, no proxy credentials).
import { ffmpegAvailable, ffmpegError, activeProcesses } from '../../lib/server/ffmpeg.js';
import { sessionCount } from '../../lib/server/sessions.js';
import { extractionStats, ytdlpInfo, clientGroups } from '../../lib/server/ytdlp.js';
import { relayStats } from '../../lib/server/cdnRelay.js';
import { egressSummary } from '../../lib/server/egress.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  const key = process.env.YOUTUBE_API_KEY;
  const ytdlp = await ytdlpInfo();
  const extraction = extractionStats();
  const relay = relayStats();
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    ffmpeg: ffmpegAvailable(),
    ffmpegError: ffmpegError(),
    ytdlp,
    youtubeSearch: !!key && key !== 'your_key_here' ? 'data-api' : 'scraper',
    sessions: sessionCount(),
    activeStreams: activeProcesses().size,   // FFmpeg processes (catalog streams + /api/muxed)
    activeRelays: relay.active,              // open googlevideo range relays (/api/stream + FFmpeg inputs)
    relay: { total: relay.total, bytes: relay.bytes, urlRefreshes: relay.refreshes, resumes: relay.resumes, upstreamErrors: relay.upstreamErrors },
    extraction: { ...extraction, clients: clientGroups() },
    egress: egressSummary(),
  });
}
