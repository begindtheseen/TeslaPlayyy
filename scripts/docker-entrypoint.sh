#!/bin/sh
# Optionally refresh yt-dlp before starting (YouTube-side changes regularly break older releases).
if [ "${YTDLP_UPDATE_ON_START:-0}" = "1" ]; then
  /opt/yt-dlp/bin/pip install --no-cache-dir -q -U "yt-dlp[default]" || echo "[entrypoint] yt-dlp update failed; continuing with $(yt-dlp --version)"
fi
exec "$@"
