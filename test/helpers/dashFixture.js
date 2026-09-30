// Generates YouTube-shaped media (original synthetic content) for tests, cached in the OS temp dir:
//  v.mp4 : DASH video-only fMP4 (ftyp, moov, sidx, moof/mdat...) H.264 High 640x360@30, B-frames, GOP 2 s
//  a.m4a : DASH audio-only fMP4 AAC-LC 44.1 kHz stereo, 1 kHz beep for 250 ms at the start of every second
//  p.mp4 : progressive MP4 (both tracks), like itag 18
// Like YouTube's adaptive formats, the first video frame has PTS 0.0667 s (B-frame reorder delay).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const DASH_SECONDS = 36;

export function ensureDashFixture(dir = path.join(tmpdir(), 'canvastube-dash-v1')) {
  const files = { video: path.join(dir, 'v.mp4'), audio: path.join(dir, 'a.m4a'), progressive: path.join(dir, 'p.mp4') };
  if (Object.values(files).every(f => existsSync(f) && statSync(f).size > 1000)) return { dir, files };
  mkdirSync(dir, { recursive: true });
  const src = ['-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${DASH_SECONDS}`, '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=44100:beep_factor=4:duration=${DASH_SECONDS}`];
  const v = ['-c:v', 'libx264', '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-bf', '2', '-b:v', '500k'];
  const a = ['-c:a', 'aac', '-b:a', '96k', '-ac', '2'];
  const run = args => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  };
  run([...src, '-map', '0:v', ...v, '-f', 'mp4', '-movflags', '+dash+global_sidx', files.video]);
  run([...src, '-map', '1:a', ...a, '-f', 'mp4', '-movflags', '+dash+global_sidx', '-frag_duration', '2000000', files.audio]);
  run([...src, '-map', '0:v', '-map', '1:a', ...v, ...a, '-movflags', '+faststart', files.progressive]);
  return { dir, files };
}

// CLI: node test/helpers/dashFixture.js [dir]
if (import.meta.url === `file://${process.argv[1]}`) console.log(ensureDashFixture(process.argv[2]));
