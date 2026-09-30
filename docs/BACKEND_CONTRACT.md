# Backend contract

All media for the canvas player is same-origin. The browser never contacts YouTube or googlevideo.
Every route that touches yt-dlp or FFmpeg runs on the Node runtime (not edge).

## GET /api/youtube/search?query=...
YouTube Data API v3 when `YOUTUBE_API_KEY` is set, otherwise the public results page. Returns
`{items:[{id:{videoId},snippet:{title,channelTitle,thumbnails}}]}`. Query ≤ 100 chars, rate limited.

## GET /api/extract/:videoId
yt-dlp extraction (cached 5 min, never past the CDN URL expiry).
`200 {videoId,title,channel,duration,thumbnail,extractedAt,expiresAt,client,cached,formats:[{itag,url,mimeType,width,height,fps,bitrate,hasAudio,hasVideo,container,contentLength}],recommended:{delivery,reason,transcode,video,audio}}`.
Errors `{error,code}`: 400 `invalid_video_id`, 404 `private`|`unavailable`, 403 `age_restricted`|`members_only`|`drm_protected`,
451 `region_blocked`, 409 `upcoming`, 422 `live_unsupported`|`no_formats`, 429 `blocked`, 502 `network`|`extraction_failed`,
503 `extractor_missing`, 504 `timeout`. `url` values only work from the server's egress IP.

## POST /api/playback/session
`{source:{kind:'catalog',id}}` or `{source:{kind:'youtube',videoId,title?,delivery?:'auto'|'muxed'|'dual',intel?,maxHeight?,maxFps?}}`.
`GET ?videoId=<id>[&intel=1][&delivery=][&maxHeight=][&maxFps=]` is the same.

YouTube response:
```json
{ "sessionId": "...", "player": "canvas", "expiresAt": "...", "heartbeatIntervalMs": 20000,
  "title": "...", "youtube": {"videoId": "...", "channel": "...", "thumbnail": "..."},
  "canvas": { "delivery": "muxed", "deliveryReason": "requested", "duration": 212, "startTime": 0,
    "hasAudio": true, "seekable": true, "transcoding": {"video": false, "audio": false},
    "video": {"codec": "avc1.640028", "width": 1920, "height": 1080, "fps": 30, "itag": 137},
    "audio": {"codec": "mp4a.40.2", "itag": 140},
    "streamUrl": "/api/muxed/<id>?session=..." },
  "notice": "YouTube · 1080p · server-muxed MPEG-TS" }
```
With `delivery:"dual"`, `canvas.tracks = {video:{url,itag,mimeType,size}, audio:{...}}` replaces `streamUrl`.
`intel` forces `muxed`. `auto` means muxed on a Tesla UA and dual elsewhere; the web client sends its
probe result explicitly. Formats are pinned per session. Extraction errors use the codes above plus `videoId`.

## GET /api/stream/:videoId?itag=<n>&session=<id>
Range proxy of one format. `Range: bytes=a-b | a- | -n` → `206` + `Content-Range` + `Accept-Ranges: bytes`.
No Range → `200`. Past the end → `416 Content-Range: bytes */size`. Streamed with backpressure; a client
disconnect aborts the upstream request. Upstream is fetched in `CDN_CHUNK_BYTES` pieces; a CDN 403/404/410
triggers one re-extraction mid-response; CDN drops are resumed from the exact byte. No `itag` → `307`
to `/api/muxed/:videoId`. Requires a session bound to the video (`403 invalid_session`).

## GET /api/muxed/:videoId?session=<id>&t=<seconds>
`ffmpeg -i <video> -i <audio> -map 0:v:0 -map 1:a:0 -c copy -copyts -f mpegts pipe:1` → chunked `video/mp2t`.
Inputs are the loopback range relay (same egress, chunking and URL refresh), so FFmpeg seeks by byte
range. Timestamps are media time (`X-Media-Start-Time: 0`). One live FFmpeg per session: a new
request (seek/reconnect) cancels the previous one. Headers: `X-Stream-Mode`, `X-Formats`, `X-Seek-Requested`.
`416` past the end, `400` bad `t`, `503` capacity or FFmpeg missing.

## GET /api/media/stream/:assetId?session=&t=  ·  GET /api/youtube/stream/:videoId
Catalog/demo MPEG-TS (unchanged). The legacy YouTube route serves an operator-licensed copy
(`YOUTUBE_AUTHORIZED_MAP`) when mapped, else the same stream as `/api/muxed`.

## GET /api/health
`{ffmpeg, ytdlp:{available,version}, youtubeSearch, sessions, activeStreams, activeRelays,
relay:{total,bytes,urlRefreshes,resumes,upstreamErrors}, extraction:{requests,successRate,lastHour,attempts,
attemptSuccessRate,cacheHits,byCode,byClient,avgMs,recentErrors,clients}, egress:{mode,poolSize,coolingDown,byEgress}}`.
Proxy credentials are never reported.

## Worker message contract
Main → worker: `init {canvas}`, `open {url | dual:{video,audio}, startTime, seekTo, hasAudio, duration}`,
`clock {mediaTime, at, rate}`, `stop`.
Worker → main: `status`, `tracks`, `videoConfig`, `audioConfig`, `audio {time,duration,sampleRate,planes}`,
`buffered {until,complete}`, `ready {time}`, `buffering {value}`, `frame {time}`, `stats`, `ended`,
`error {message,fatal}`. All media timestamps are microseconds.
