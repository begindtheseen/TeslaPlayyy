// Canvas playback worker: fetch MPEG-TS -> TSDemuxer -> VideoDecoder -> OffscreenCanvas,
//                                               \-> AudioDecoder -> PCM posted to the main thread (Web Audio).
// The main thread owns the media clock (audio-master) and posts it here; this worker only presents
// video frames whose timestamp is due on that clock.
//
// Main -> worker: init{canvas} open{url,startTime,seekTo,hasAudio} clock{mediaTime,at,rate} stop
// Worker -> main: status tracks videoConfig audioConfig audio{time,duration,sampleRate,planes} buffered{until}
//                 ready{time} buffering{value} frame{time} ended stats error{message,fatal}
import { TSDemuxer } from '../lib/ts/demuxer.js';

const MAX_AHEAD_S = 8;        // stop reading the network once this much media is demuxed ahead of the clock
const MAX_DECODE_QUEUE = 8;   // encoded chunks inside VideoDecoder
const MAX_FRAMES = 12;        // decoded VideoFrames held (each can pin a GPU/video buffer)
const MAX_DECODER_RESTARTS = 5;

let ctx = null;
let gen = 0;                  // generation counter; bumps on open/seek/stop to ignore stale async work
let s = null;                 // per-load state
let clock = { mediaTime: 0, at: 0, rate: 0 };

const post = (type, extra = {}, transfer) => postMessage({ type, gen, ...extra }, transfer || []);
const wallNow = () => performance.timeOrigin + performance.now();
const mediaNow = () => clock.mediaTime + (clock.rate ? (wallNow() - clock.at) / 1000 : 0);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const raf = typeof requestAnimationFrame === 'function' ? cb => requestAnimationFrame(cb) : cb => setTimeout(cb, 10);

function teardown() {
  if (!s) return;
  s.abort.abort();
  for (const f of s.frames) f.close();
  s.frames = [];
  s.pendingVideo = [];
  for (const d of [s.videoDecoder, s.audioDecoder]) { try { if (d && d.state !== 'closed') d.close(); } catch {} }
  s = null;
}

function open({ url, startTime = 0, seekTo = 0, hasAudio = false, duration = null }) {
  teardown();
  const myGen = ++gen;
  clock = { mediaTime: seekTo, at: wallNow(), rate: 0 };
  s = {
    gen: myGen, url, base: startTime * 1e6, target: seekTo, hasAudio, duration,
    lastVideoIn: -Infinity, lastAudioIn: -Infinity, lastFrameOut: -Infinity, reconnects: 0,
    abort: new AbortController(),
    demuxer: null, videoDecoder: null, audioDecoder: null, videoConfig: null, audioConfig: null,
    pendingVideo: [], frames: [], needKey: true,
    demuxedUntil: seekTo, streamDone: false, flushed: false, readySent: false, ended: false,
    buffering: false, starvedSince: 0, lastFramePost: 0, lastPresented: -1,
    stats: { reconnects: 0, lateSumMs: 0, lateMaxMs: 0, decoded: 0, presented: 0, dropped: 0, prerollSkipped: 0, decoderRestarts: 0, audioChunks: 0, bytes: 0 },
  };
  s.demuxer = new TSDemuxer({
    onTracks: t => { post('tracks', { video: t.video?.codec || null, audio: t.audio?.codec || null, unsupported: t.unsupported.map(u => u.codec) });
      if (!t.video) fail('Stream has no H.264 video track' + (t.unsupported.length ? ` (found ${t.unsupported.map(u => u.codec).join(', ')})` : ''), true); },
    onVideoConfig: c => configureVideo(c, myGen),
    onAudioConfig: c => configureAudio(c, myGen),
    onVideo: v => {
      if (myGen !== gen) return;
      // After a reconnect the new stream restarts at a keyframe at/before the cut: keep feeding the
      // decoder from that keyframe, but decoded frames already shown are dropped in the output callback.
      s.pendingVideo.push(v);
      if (v.timestamp > s.lastVideoIn) { s.lastVideoIn = v.timestamp; noteDemuxed(v.timestamp); }
      pump();
    },
    onAudio: a => { if (myGen === gen && a.timestamp > s.lastAudioIn) { s.lastAudioIn = a.timestamp; decodeAudio(a); } },
    onDiscontinuity: d => post('status', { text: `Stream discontinuity on PID ${d.pid} (${d.reason})` }),
  });
  read(myGen).catch(e => { if (myGen === gen && e.name !== 'AbortError') fail(`Network error: ${e.message}`, true); });
  raf(() => render(myGen));
}

function fail(message, fatal = false) { post('error', { message, fatal }); if (fatal && s) s.abort.abort(); }

function noteDemuxed(tsUs) {
  const t = (tsUs - s.base) / 1e6;
  if (t > s.demuxedUntil) { s.demuxedUntil = t; }
}

const MAX_RECONNECTS = 6;

// Reads the stream; if the connection drops or ends before the known duration (network loss,
// serverless time limits), reconnects at the last demuxed position. The server snaps to the
// preceding keyframe and duplicate output is filtered by timestamp.
async function read(myGen) {
  let url = s.url;
  for (;;) {
    let result;
    try { result = await readOnce(myGen, url); }
    catch (e) { if (myGen !== gen || e.name === 'AbortError') return; result = { error: e }; }
    if (myGen !== gen || result.fatal) return;
    const incomplete = result.error || (s.duration && s.demuxedUntil < s.duration - 0.75);
    if (!incomplete) break;
    s.stats.reconnects = s.reconnects + 1;
    if (++s.reconnects > MAX_RECONNECTS) return fail(`Stream interrupted repeatedly${result.error ? `: ${result.error.message}` : ''}`, true);
    post('status', { text: `Stream interrupted at ${s.demuxedUntil.toFixed(1)} s; reconnecting (${s.reconnects}/${MAX_RECONNECTS})` });
    s.demuxer.emitPendingAU();
    s.demuxer.reset();
    await sleep(Math.min(4000, 250 * 2 ** (s.reconnects - 1)));
    if (myGen !== gen) return;
    const u = new URL(s.url, self.location.href);
    u.searchParams.set('t', Math.max(0, s.demuxedUntil - 0.05).toFixed(3));
    url = u.pathname + u.search;
  }
  s.demuxer.flush();
  s.streamDone = true;
  post('buffered', { until: s.demuxedUntil, complete: true });
  pump();
}

async function readOnce(myGen, url) {
  const r = await fetch(url, { signal: s.abort.signal });
  if (!r.ok) {
    let msg = `Stream request failed (HTTP ${r.status})`;
    try { const j = await r.json(); if (j.error) msg = j.error; } catch {}
    if (r.status >= 500 && r.status !== 501 && s.reconnects < MAX_RECONNECTS) return { error: new Error(msg) };
    fail(msg, true);
    return { fatal: true };
  }
  post('status', { text: `Receiving MPEG-TS (${r.headers.get('X-Stream-Mode') || 'direct'})` });
  const reader = r.body.getReader();
  let lastBufferedPost = 0;
  for (;;) {
    // Backpressure: stop pulling bytes while enough media is buffered; TCP flow control then pauses FFmpeg.
    while (myGen === gen && (s.demuxedUntil - Math.max(mediaNow(), s.target) > MAX_AHEAD_S || s.pendingVideo.length > 400)) await sleep(50);
    if (myGen !== gen) { reader.cancel().catch(() => {}); return {}; }
    const { done, value } = await reader.read();
    if (myGen !== gen) return {};
    if (done) return {};
    s.stats.bytes += value.length;
    s.demuxer.push(value);
    if (performance.now() - lastBufferedPost > 250) { lastBufferedPost = performance.now(); post('buffered', { until: s.demuxedUntil }); }
  }
}

async function configureVideo(c, myGen) {
  if (myGen !== gen) return;
  const v = s.videoConfig;
  if (v && v.codec === c.codec && v.codedWidth === c.width && v.codedHeight === c.height && s.videoDecoder?.state === 'configured') return; // same stream after reconnect
  if (typeof VideoDecoder === 'undefined') return fail('WebCodecs VideoDecoder is not available in this browser', true);
  const config = { codec: c.codec, codedWidth: c.width, codedHeight: c.height, optimizeForLatency: true };
  const support = await VideoDecoder.isConfigSupported(config).catch(e => ({ supported: false, error: e }));
  if (myGen !== gen) return;
  if (!support.supported) return fail(`This browser cannot decode ${c.codec} (${c.width}x${c.height}) with WebCodecs`, true);
  s.videoConfig = config;
  if (ctx) { ctx.canvas.width = c.width; ctx.canvas.height = c.height; }
  post('videoConfig', { codec: c.codec, width: c.width, height: c.height });
  createVideoDecoder();
}

function createVideoDecoder() {
  const myGen = gen;
  try { if (s.videoDecoder && s.videoDecoder.state !== 'closed') s.videoDecoder.close(); } catch {}
  s.videoDecoder = new VideoDecoder({
    output: frame => {
      if (myGen !== gen || !s) { frame.close(); return; }
      s.stats.decoded++;
      const t = (frame.timestamp - s.base) / 1e6;
      // Seek preroll: frames between the keyframe and the requested position are decoded but not shown.
      if (t < s.target - 0.001 || frame.timestamp <= s.lastFrameOut) { s.stats.prerollSkipped++; frame.close(); return; }
      s.lastFrameOut = frame.timestamp;
      s.frames.push(frame);
      if (s.frames.length > MAX_FRAMES * 2) { s.frames.shift().close(); s.stats.dropped++; }
    },
    error: e => {
      if (myGen !== gen || !s) return;
      s.stats.decoderRestarts++;
      if (s.stats.decoderRestarts > MAX_DECODER_RESTARTS) return fail(`Video decoder failed repeatedly: ${e.message}`, true);
      post('status', { text: `Video decoder error (${e.message}); restarting at next keyframe` });
      createVideoDecoder();
    },
  });
  s.videoDecoder.addEventListener?.('dequeue', pump);
  s.videoDecoder.configure(s.videoConfig);
  s.needKey = true;
  pump();
}

function pump() {
  if (!s || !s.videoDecoder || s.videoDecoder.state !== 'configured') return;
  const d = s.videoDecoder;
  while (s.pendingVideo.length && d.decodeQueueSize < MAX_DECODE_QUEUE && s.frames.length < MAX_FRAMES) {
    const v = s.pendingVideo.shift();
    if (s.needKey) { if (v.type !== 'key') continue; s.needKey = false; }
    try { d.decode(new EncodedVideoChunk({ type: v.type, timestamp: v.timestamp, duration: v.duration, data: v.data })); }
    catch (e) { s.needKey = true; post('status', { text: `Dropped undecodable chunk: ${e.message}` }); }
  }
  if (s.streamDone && !s.pendingVideo.length && !s.flushed && d.decodeQueueSize === 0) {
    s.flushed = true;
    const myGen = gen;
    d.flush().then(() => { if (myGen === gen && s) s.decoderDrained = true; }, () => { if (myGen === gen && s) s.decoderDrained = true; });
  }
}

async function configureAudio(c, myGen) {
  if (myGen !== gen) return;
  const a = s.audioConfig;
  if (a && a.codec === c.codec && a.sampleRate === c.sampleRate && a.numberOfChannels === c.numberOfChannels && s.audioDecoder?.state === 'configured') return;
  if (typeof AudioDecoder === 'undefined') { post('status', { text: 'AudioDecoder unavailable: playing video only' }); return; }
  const config = { codec: c.codec, sampleRate: c.sampleRate, numberOfChannels: c.numberOfChannels, description: c.description };
  const support = await AudioDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (myGen !== gen) return;
  if (!support.supported) { post('status', { text: `Audio codec ${c.codec} unsupported: playing video only` }); return; }
  s.audioConfig = config;
  post('audioConfig', { codec: c.codec, sampleRate: c.sampleRate, channels: c.numberOfChannels });
  createAudioDecoder();
}

function createAudioDecoder() {
  const myGen = gen;
  try { if (s.audioDecoder && s.audioDecoder.state !== 'closed') s.audioDecoder.close(); } catch {}
  s.audioDecoder = new AudioDecoder({
    output: data => {
      if (myGen !== gen || !s) { data.close(); return; }
      const time = (data.timestamp - s.base) / 1e6;
      const duration = data.numberOfFrames / data.sampleRate;
      if (time + duration <= s.target) { data.close(); return; } // seek preroll
      const planes = [];
      for (let ch = 0; ch < data.numberOfChannels; ch++) {
        const p = new Float32Array(data.numberOfFrames);
        data.copyTo(p, { planeIndex: ch, format: 'f32-planar' });
        planes.push(p);
      }
      const sampleRate = data.sampleRate;
      data.close();
      s.stats.audioChunks++;
      post('audio', { time, duration, sampleRate, planes }, planes.map(p => p.buffer));
    },
    error: e => {
      if (myGen !== gen || !s) return;
      post('status', { text: `Audio decoder error (${e.message}); restarting` });
      if (++s.stats.decoderRestarts <= MAX_DECODER_RESTARTS) createAudioDecoder();
    },
  });
  s.audioDecoder.configure(s.audioConfig);
}

function decodeAudio(a) {
  noteDemuxed(a.timestamp);
  const d = s.audioDecoder;
  if (!d || d.state !== 'configured') return;
  try { d.decode(new EncodedAudioChunk({ type: 'key', timestamp: a.timestamp, duration: a.duration, data: a.data })); }
  catch (e) { post('status', { text: `Dropped audio chunk: ${e.message}` }); }
}

const frameTime = f => (f.timestamp - s.base) / 1e6;

function draw(frame) {
  if (!ctx) return;
  if (ctx.canvas.width !== frame.displayWidth || ctx.canvas.height !== frame.displayHeight) {
    ctx.canvas.width = frame.displayWidth; ctx.canvas.height = frame.displayHeight;
  }
  ctx.drawImage(frame, 0, 0, ctx.canvas.width, ctx.canvas.height);
}

function render(myGen) {
  if (myGen !== gen || !s) return;
  pump();
  const frames = s.frames;
  if (!s.readySent) {
    // Show the first frame at/after the target as a poster; the main thread starts the clock on 'ready'.
    const audioReady = !s.hasAudio || !s.audioConfig || s.stats.audioChunks > 5 || s.streamDone;
    if (frames.length && audioReady) {
      draw(frames[0]);
      s.readySent = true;
      post('ready', { time: frameTime(frames[0]) });
    } else if (s.streamDone && s.decoderDrained && !frames.length) {
      s.readySent = true; s.ended = true; post('ended', { reason: 'no-frames' });
    }
  } else if (clock.rate) {
    const now = mediaNow();
    // Drop frames that are already late (a newer frame is also due).
    while (frames.length > 1 && frameTime(frames[1]) <= now) { frames.shift().close(); s.stats.dropped++; }
    if (frames.length && frameTime(frames[0]) <= now + 0.004) {
      const f = frames.shift();
      draw(f);
      s.lastPresented = frameTime(f);
      // Presentation error vs the (audio-master) clock: how late this frame hit the canvas.
      const lateMs = (now - s.lastPresented) * 1000;
      s.stats.lateSumMs += lateMs; s.stats.lateMaxMs = Math.max(s.stats.lateMaxMs, lateMs);
      f.close();
      s.stats.presented++;
      if (performance.now() - s.lastFramePost > 250) { s.lastFramePost = performance.now(); post('frame', { time: s.lastPresented }); post('stats', { stats: s.stats }); }
    }
    const drained = s.streamDone && !s.pendingVideo.length && s.decoderDrained && !frames.length;
    if (drained && !s.ended) { s.ended = true; post('frame', { time: s.lastPresented }); post('stats', { stats: s.stats }); post('ended', { time: s.lastPresented }); }
    // Starvation: nothing decoded to show and the network has not finished.
    const starving = !frames.length && !drained && !s.streamDone;
    if (starving && !s.starvedSince) s.starvedSince = performance.now();
    if (!starving) s.starvedSince = 0;
    const buffering = starving && performance.now() - s.starvedSince > 120;
    if (buffering !== s.buffering) { s.buffering = buffering; post('buffering', { value: buffering }); }
    else if (s.buffering && frames.length >= 3) { s.buffering = false; post('buffering', { value: false }); }
  }
  raf(() => render(myGen));
}

self.onmessage = e => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init': ctx = m.canvas.getContext('2d', { alpha: false, desynchronized: true }); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); break;
      case 'open': open(m); break;
      case 'clock': if (m.gen === gen) clock = { mediaTime: m.mediaTime, at: m.at, rate: m.rate }; break;
      case 'stop': gen++; teardown(); break;
    }
  } catch (err) { fail(String(err?.message || err), true); }
};
