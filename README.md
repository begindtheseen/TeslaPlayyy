# CanvasTube (TeslaPlayyy)

A YouTube player for in-car browsers that renders through its own engine instead of `<video>` or an
iframe: fetch → worker demux → WebCodecs `VideoDecoder` → `OffscreenCanvas`, with AAC → `AudioDecoder`
→ Web Audio as the master clock. Public YouTube videos are extracted server-side with yt-dlp and proxied
through this server. The bundled synthetic demo needs no credentials or network.

## Quick start

```bash
npm install
cp .env.example .env.local      # optional: YOUTUBE_API_KEY for Data API search
npm run dev                     # http://localhost:3000
```

Requirements for YouTube playback: `yt-dlp` and `ffmpeg` on the server's `PATH` (the Dockerfile
installs both). Paste a YouTube link (or search) and it plays on the canvas. **Play demo** works with
neither.

Offline / CI development: `npm run dev:fake-youtube` starts the app against a fake yt-dlp and a fake
googlevideo CDN that serve a synthetic 36 s H.264 + AAC DASH clip for any video id.

Only use in a vehicle while parked.

## How a YouTube video plays

```
paste link ─▶ POST /api/playback/session ─▶ yt-dlp (android_vr,web_safari → fallbacks)
                                   │
          ┌────────────────────────┴───────────────────────────┐
   delivery "muxed" (Intel MCU, ?intel=1)          delivery "dual" (AMD MCU / desktop)
   GET /api/muxed/:id?t=                           GET /api/stream/:id?itag=  (Range)
   FFmpeg -c copy → one MPEG-TS stream             range proxy of DASH video + audio fMP4
          │                                                  │
   worker: TSDemuxer (Annex B + ADTS)              worker: Fmp4Demuxer ×2, sidx byte-range seeking
          └──────────────▶ VideoDecoder → OffscreenCanvas   AudioDecoder → Web Audio (clock) ◀┘
```

- googlevideo URLs are locked to the server's IP, so all media flows through this server; the browser
  never contacts YouTube.
- **Muxed**: FFmpeg reads both DASH streams through a loopback range relay and remuxes them without
  re-encoding into MPEG-TS. One connection and one demuxer for the client. Seek = new request with `?t=`.
- **Dual**: the worker fetches video and audio separately in bounded byte ranges, maps a seek time to a
  byte offset with the `sidx` index, and costs no server CPU.
- The client picks the path with a capability probe (`lib/player/platform.js`): the WebGL renderer
  (Intel HD 505 = MCU2 → muxed at ≤30 fps; AMD Radeon = MCU3 → dual), the Tesla UA and core count.
  Overrides: `?intel=1`, `?intel=0`, `?delivery=muxed|dual`, `?maxHeight=720`, `?maxFps=30`, or the
  Delivery/Quality selectors in the UI.

## API

| Route | Purpose |
|---|---|
| `GET /api/extract/:videoId` | yt-dlp formats `{itag,url,mimeType,width,height,bitrate,hasAudio,hasVideo,container}` + recommended plan. 404 private/removed, 403 age-gated/members/DRM, 451 region, 422 live, 429 blocked. |
| `POST /api/playback/session` | `{source:{kind:'youtube',videoId,delivery?,intel?,maxHeight?,maxFps?}}` → canvas session (muxed `streamUrl` or dual `tracks`). Also catalog assets / the demo. |
| `GET /api/stream/:videoId?itag=&session=` | Range-aware proxy of one format (206, Content-Range, Accept-Ranges). No itag → 307 to `/api/muxed`. |
| `GET /api/muxed/:videoId?session=&t=` | FFmpeg `-c copy` remux of video+audio → `video/mp2t`. |
| `GET /api/health` | ffmpeg/yt-dlp status, extraction success rate (overall, last hour, by error code and client), relay and egress stats. |

Details: `docs/BACKEND_CONTRACT.md`. Rate limits, IP rotation and proxies: `docs/RESILIENCE.md`.

## Tests

```bash
npm test                                   # unit/integration (node:test): demuxers, extraction, proxy, muxer, egress
CHROME_PATH=/path/to/chrome npm run test:e2e   # browser E2E against `next start` (needs Chrome with H.264/AAC)
CHROME_PATH=/path/to/chrome npm run test:perf  # 1080p60 muxed vs dual on 1/2/4 pinned CPU cores
```

Playwright's bundled Chromium has no H.264/AAC decoders; use Chrome or Chrome for Testing. The tests
replace YouTube with the fake yt-dlp and CDN in `test/helpers/`; nothing contacts YouTube.

## Limits

- Live streams, premieres, private/age-gated/members-only/DRM/region-locked videos are refused with a
  clear message. No bypasses.
- H.264 + AAC formats are used as-is. VP9/AV1-only videos (some 4K content) fall back to the muxed path
  with server-side transcoding (CPU heavy).
- Not yet verified on a Tesla MCU. The Intel/AMD choice is based on published hardware and a CPU-pinned
  benchmark in headless Chrome, not on a vehicle.
