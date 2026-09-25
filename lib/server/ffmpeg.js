// FFmpeg/ffprobe integration: probing, keyframe index, and MPEG-TS stream spawning with cleanup.
import { spawn, spawnSync } from 'node:child_process';
import { shared, envInt } from './state.js';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// Cached once found; a failed check is retried after 30 s (e.g. slow first spawn during cold start).
export function ffmpegAvailable() {
  const st = shared('ffmpegCheck', () => ({ ok: false, checkedAt: 0, error: null }));
  if (st.ok || Date.now() - st.checkedAt < 30000) return st.ok;
  st.checkedAt = Date.now();
  const check = cmd => {
    const r = spawnSync(cmd, ['-version'], { timeout: 15000, stdio: ['ignore', 'ignore', 'pipe'] });
    if (r.error || r.status !== 0) throw new Error(`${cmd}: ${r.error?.message || `exit ${r.status} ${r.signal || ''}`}`);
  };
  try { check(FFMPEG); check(FFPROBE); st.ok = true; st.error = null; }
  catch (e) { st.error = e.message; console.warn('[ffmpeg] unavailable:', e.message); }
  return st.ok;
}
export const ffmpegError = () => shared('ffmpegCheck', () => ({})).error || null;

const REMOTE_INPUT_ARGS = ['-rw_timeout', '15000000', '-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '4',
  '-protocol_whitelist', 'https,tls,tcp,http'];

function run(cmd, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.stdout.on('data', d => { out += d; if (out.length > 8e6) p.kill('SIGKILL'); });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `${cmd} exited ${code}`)); });
  });
}

const inputFor = src => (src.kind === 'local' ? src.path : src.url);
const inputArgs = src => (src.kind === 'remote' ? REMOTE_INPUT_ARGS : []);

// Probes codecs/duration and decides whether stream copy is possible.
export async function probe(src) {
  const cache = shared('probeCache', () => new Map());
  const key = inputFor(src);
  if (cache.has(key)) return cache.get(key);
  const json = JSON.parse(await run(FFPROBE, ['-v', 'error', ...inputArgs(src), '-show_format', '-show_streams', '-of', 'json', key]));
  const v = json.streams.find(s => s.codec_type === 'video');
  const a = json.streams.find(s => s.codec_type === 'audio');
  if (!v) throw new Error('Source has no video stream');
  const info = {
    format: json.format.format_name,
    duration: Number(json.format.duration) || null,
    startTime: Number(json.format.start_time) || 0,
    video: { codec: v.codec_name, profile: v.profile || null, width: v.width, height: v.height, pixFmt: v.pix_fmt },
    audio: a ? { codec: a.codec_name, profile: a.profile || null, sampleRate: Number(a.sample_rate), channels: a.channels } : null,
  };
  // WebCodecs H.264 decoders handle 8-bit 4:2:0 Baseline/Main/High. Anything else is transcoded.
  info.copyVideo = v.codec_name === 'h264' && /^(yuv420p|yuvj420p)$/.test(v.pix_fmt || '') &&
    /^(Constrained Baseline|Baseline|Main|High)$/.test(v.profile || '');
  info.copyAudio = !!a && a.codec_name === 'aac' && (a.profile === 'LC' || !a.profile) && a.channels <= 2;
  info.mpegtsInput = /mpegts/.test(info.format);
  if (cache.size > 200) cache.clear();
  cache.set(key, info);
  return info;
}

// MPEG-TS inputs have no seek index, so FFmpeg's -ss can land after the wanted keyframe.
// For local TS files we scan keyframe times once (media time, seconds from start).
export async function keyframeIndex(src, info) {
  if (src.kind !== 'local' || !info.mpegtsInput) return null;
  const cache = shared('keyframeCache', () => new Map());
  if (cache.has(src.path)) return cache.get(src.path);
  const csv = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', src.path], { timeoutMs: 60000 });
  const times = csv.split('\n').filter(l => /K/.test(l)).map(l => Number(l.split(',')[0]) - info.startTime).filter(Number.isFinite).sort((x, y) => x - y);
  cache.set(src.path, times);
  return times;
}

export function planSeek(t, keyframes) {
  if (!(t > 0)) return { ss: 0, keyframe: 0 };
  if (!keyframes?.length) return { ss: t, keyframe: null }; // container-indexed input: FFmpeg snaps to the prior keyframe itself
  let k = keyframes[0];
  for (const x of keyframes) { if (x <= t + 1e-3) k = x; else break; }
  return { ss: Math.max(0, k - 0.05), keyframe: k };
}

export function buildArgs(src, info, { ss = 0 } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...inputArgs(src)];
  if (ss > 0) args.push('-ss', ss.toFixed(3));
  args.push('-i', inputFor(src), '-map', '0:v:0');
  if (info.audio) args.push('-map', '0:a:0');
  if (info.copyVideo) args.push('-c:v', 'copy');
  else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '48', '-bf', '0');
  if (info.audio) {
    if (info.copyAudio) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
  }
  // Keep source timestamps so the player can map PTS to media time (pts - startTime) after seeks.
  args.push('-copyts', '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', 'pipe:1');
  return args;
}

export function activeProcesses() { return shared('ffmpegProcs', () => new Set()); }

// Spawns FFmpeg and pipes stdout to `res` with backpressure. Resolves when the stream ends.
// Kills FFmpeg on client disconnect, stall, startup timeout, max duration, or `signal` abort.
export function streamToResponse({ args, res, signal, onStart, log = () => {} }) {
  const startupMs = envInt('MEDIA_STARTUP_TIMEOUT_MS', 20000);
  const stallMs = envInt('MEDIA_STALL_TIMEOUT_MS', 30000);
  const maxMs = envInt('MEDIA_MAX_STREAM_SECONDS', 4 * 3600) * 1000;
  return new Promise(resolve => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const procs = activeProcesses();
    procs.add(child);
    let started = false, finished = false, lastProgress = Date.now(), stderr = '';
    const began = Date.now();
    const finish = reason => {
      if (finished) return;
      finished = true;
      clearInterval(watchdog);
      procs.delete(child);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (!res.headersSent) {
        res.statusCode = reason === 'startup-timeout' ? 504 : 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Media stream failed', reason, detail: stderr.trim().split('\n').slice(-2).join(' ') }));
      } else if (!res.writableEnded) res.end();
      log(reason, stderr.trim());
      resolve(reason);
    };
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (!started && now - began > startupMs) finish('startup-timeout');
      // Time blocked on client backpressure is not a stall.
      else if (started && !res.writableNeedDrain && now - lastProgress > stallMs) finish('stall-timeout');
      else if (now - began > maxMs) finish('max-duration');
    }, 1000);
    signal?.addEventListener('abort', () => finish('aborted'), { once: true });
    res.on('close', () => finish('client-closed'));
    child.on('error', e => { stderr += e.message; finish('spawn-error'); });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    child.stdout.on('data', chunk => {
      lastProgress = Date.now();
      if (!started) { started = true; onStart?.(); }
      if (!res.write(chunk)) {
        child.stdout.pause();
        res.once('drain', () => { lastProgress = Date.now(); child.stdout.resume(); });
      }
    });
    child.on('close', code => finish(code === 0 ? 'complete' : started ? 'ffmpeg-exit' : 'ffmpeg-failed'));
  });
}
