# Ship plan: no pretending unfinished features work

## Phase 0 — boot (30 min)
- npm install; cp .env.example .env.local; npm run dev
- Visit localhost:3000. Use the local demo button. Confirm WebCodecs/OffscreenCanvas support and visible moving test pattern.
- Confirm YouTube search displays a useful missing-key error when key is absent.

## Phase 1 — productionize video pipeline
- Worker TS parser: PAT/PMT continuity counter, adaptation fields, packet resync, PES spanning chunks, SPS/PPS parsing, access-unit boundaries, B-frame PTS/DTS ordering, discontinuity reset, codec changes.
- H.264 VideoDecoder.isConfigSupported before configure; derive avc1 codec from SPS; handle Annex B and avcC explicitly.
- Use frame queue paced by timestamp, backpressure, decoder flush/reset, visibility handling and reliable stop/abort.
- Add unit tests for chunk splits (1 byte, 187 bytes, 188 bytes, random), corrupted sync, missing PAT, video-only and A/V streams.

## Phase 2 — audio and sync
- Extract AAC ADTS or LATM depending on source; parse AudioSpecificConfig; AudioDecoder.isConfigSupported; decode to AudioData.
- Transfer audio frames to main thread, schedule AudioBufferSourceNodes against AudioContext.currentTime; apply GainNode volume.
- Use audio clock as master, drop late video frames; add autoplay gesture unlock and mute controls.
- On seek: abort current fetch, clear TS/PES/frame/audio queues, reset decoders and timestamps, start server-offset stream, resume at actual keyframe.

## Phase 3 — interface
- YouTube metadata search; thumbnails, skeletons, empty/error states, keyboard shortcuts, mobile gestures, scrubbing, progress, fullscreen webpage, loading spinner, responsive results.
- Keep the play button honest: YouTube results are NOT playable until an authorized media backend is connected. Use a demo-mode badge.

## Phase 4 — backend and deployment
- Add licensed media catalog or another explicitly authorized source. Do not scrape credentials, circumvent access controls or misrepresent YouTube API capabilities.
- Session tokens, rate limits, signed stream URLs, HTTPS, security headers, observability and bandwidth budget.
- Test Chrome, Safari, Tesla browser on a stationary vehicle. Do not claim a Tesla compatibility or driving-lock bypass without real device testing.

## Definition of done
- A local H.264 MPEG-TS demo plays without any HTML video element.
- Audio plays in sync on an authorized A/V fixture; pause/resume/seek work after long playback.
- No unhandled worker errors, leaked VideoFrames or hanging fetches.
- Tests and npm run build pass, and unsupported browsers show a clear fallback.

## YouTube backend (done in this iteration; see README)
- [x] yt-dlp extraction with client fallbacks, caching, error classification (`/api/extract`)
- [x] Range-aware googlevideo proxy (`/api/stream`), chunked upstream, abort, URL refresh, drop resume
- [x] Server-side `-c copy` remux to MPEG-TS (`/api/muxed`) for Intel MCUs
- [x] Worker dual-DASH path (fMP4 demuxer, sidx seeking); delivery chosen by a client GPU probe
- [x] Rebuffer deadlock fix, render-loop watchdog, decoder leak tracking
- [x] Egress proxies / source addresses / IPv6 prefix / rotation hooks; `/api/health` success rate
- [ ] Verify against live YouTube from a deployed server; monitor success rate by client
- [ ] Verify on a stationary Tesla (MCU2 Intel and MCU3 AMD); tune the default quality per MCU
