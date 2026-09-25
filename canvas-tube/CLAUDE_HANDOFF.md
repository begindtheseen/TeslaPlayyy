# Claude Code: execute this project, don't rewrite it blindly

You are the lead engineer completing CanvasTube, an independent custom canvas video player inspired by observed WebCodecs architecture. Start by reading README.md, docs/IMPLEMENTATION_PLAN.md, docs/BACKEND_CONTRACT.md, and all source files. Use the provided 5-second synthetic H.264 MPEG-TS fixture at public/media/demo.ts to reproduce bugs. Never claim a feature is complete until tested.

## User goal
A polished, touch-friendly YouTube-style search UI and a custom playback engine: fetch MPEG-TS -> worker demux -> WebCodecs VideoDecoder -> OffscreenCanvas; AAC -> AudioDecoder -> Web Audio. The search endpoint uses the official YouTube Data API for metadata. YouTube Data API does not grant media-stream URLs. Implement real playback first against owned/authorized media. Never assume a YouTube watch URL can be fed to HTML video, WebCodecs, or a TS demuxer.

## Immediate actions (do these, not just explain)
1. Run npm install, npm run dev and npm run build. Fix existing errors.
2. Add a prominent "Play demo" button that loads videoId=demo through /api/playback/session; test that actual moving frames render to canvas. Verify the fixture codec with ffprobe if installed.
3. Harden the minimal worker to correctly parse PAT/PMT/PES and H.264 access units across arbitrary fetch chunk boundaries. Add testable pure modules under lib/ts and automated tests using node:test or Vitest. Make video rendering robust and keep frames closed.
4. Generate a second synthetic 10-second MPEG-TS fixture with H.264 baseline + AAC-LC using ffmpeg; build AAC demux/decode and Web Audio scheduling. Verify audible test tone and A/V synchronization.
5. Implement pause/resume/stop and accurate buffered progress. Add seek with a backend endpoint serving keyframe-aligned local fixture segments and an abortable stream reader. Ensure repeated seeks do not leak decoders.
6. Polish dark UI: responsive cards, player overlays, buffering indicators, seekbar, volume, keyboard/touch controls, accessible labels, error states. Do not remove the test/demo mode.
7. Keep /api/youtube/search operational when YOUTUBE_API_KEY is set; add validation, quota-aware error handling and a clear metadata-only notice for YouTube results until a licensed stream provider exists.
8. Add tests, run them, run npm run build, document exact results and remaining limitations. Produce a concise changelog.

## Constraints
- No iframe, no HTML video element in the custom demo playback path.
- OffscreenCanvas + WebCodecs worker decode for video; Web Audio for audio.
- Do not copy TeslaPlay's proprietary code, endpoints, assets or branding.
- No speculative YouTube extraction implementation, credential theft, DRM circumvention, or unsafe driving-mode bypass.
- Preserve an independently testable demo with no API keys.
- If a capability is unavailable in the test environment, report it explicitly; don't silently replace it with an iframe and call it equivalent.

## Engineering standards
Make small working commits per phase. Prefer explicit data contracts and modular parser tests over giant React components. Track decoder lifecycle, stream abort, bounded frame queues and timestamp units carefully (WebCodecs uses microseconds). Explain any browser/codec assumptions. After each phase: what changed, exact commands run, tests passed/failed, what remains.

## Final acceptance
A fresh clone can npm install && npm run dev and play the bundled demo via custom canvas, without credentials. A separate authorized A/V fixture plays with sound, pause and seek. YouTube search works with a valid API key. YouTube result playback is clearly gated until the user supplies a legally authorized streaming backend. No unverified claims about Tesla browser compatibility.
