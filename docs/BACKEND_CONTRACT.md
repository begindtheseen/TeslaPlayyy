# Backend contract (independent implementation)

## GET /api/youtube/search?query=...
Uses YOUTUBE_API_KEY server-side. Returns {items:[{id:{videoId},snippet:{title,channelTitle,thumbnails}}]}. Never expose the key to the browser. Apply query length limits, quotas and rate limiting.

## GET /api/playback/session?videoId=demo
Returns {streamUrl:'/media/demo.ts',mode:'local-demo',audio:false}. A local, licensed synthetic video proves canvas decoding.

## GET /api/playback/session?videoId=<11-char-id>
Currently returns 501. Do not fabricate a YouTube stream URL. A future provider must have rights to deliver the media and must return an HTTPS URL or a same-origin authenticated endpoint serving video/mp2t. Prefer signed short-lived URLs; never allow arbitrary proxy URLs (SSRF).

## Future stream endpoint
GET /api/media/stream/:assetId?t=<seconds> -> 200 video/mp2t; CORS/same-origin; support AbortController; send codec metadata and duration in playback session. For seeking, snap to an available keyframe and return actual starting timestamp. For production: auth, bandwidth quotas, byte caps, origin restrictions, logging without tokens, and rights review.

## Worker message contract
Main -> worker: init {canvas}, open {url}, pause, resume, stop, seek {seconds}.
Worker -> main: status {text}, playing {value}, error {message}. Phase 2: frame {timestamp}, buffer {seconds}, audio {codec,config,data,timestamp}, ended, metadata {duration,width,height}.
