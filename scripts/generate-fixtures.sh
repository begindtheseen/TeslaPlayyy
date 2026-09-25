#!/usr/bin/env bash
# Regenerates the synthetic, original A/V test fixtures (no third-party content).
# demo-av.ts : 10 s, H.264 Constrained Baseline 640x360@24 (keyframe every 2 s)
#              + AAC-LC 48 kHz stereo; a 1 kHz beep plays at the start of every
#              second while the testsrc frame counter ticks, for A/V sync checks.
# demo-av.mp4: same content in MP4, used to exercise the MP4 -> MPEG-TS remux path.
set -euo pipefail
cd "$(dirname "$0")/../public/media"
common=(-f lavfi -i "testsrc=size=640x360:rate=24:duration=10"
        -f lavfi -i "sine=frequency=1000:sample_rate=48000:beep_factor=4:duration=10"
        -c:v libx264 -profile:v baseline -level 3.0 -pix_fmt yuv420p -g 48 -keyint_min 48 -sc_threshold 0 -b:v 600k
        -c:a aac -b:a 96k -ac 2 -ar 48000 -shortest)
ffmpeg -hide_banner -loglevel error -y "${common[@]}" -f mpegts demo-av.ts
ffmpeg -hide_banner -loglevel error -y "${common[@]}" -movflags +faststart demo-av.mp4
ls -l demo-av.ts demo-av.mp4
