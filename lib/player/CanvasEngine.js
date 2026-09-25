// Main-thread side of the canvas player. Owns the media clock:
//  - audio-master: AudioContext time drives the clock; PCM from the worker is scheduled on it.
//  - wall-clock fallback when the stream has no audio or audio is locked/unsupported.
// Emits: state{playing,buffering,ended,loading}, time{current,duration}, buffered{until}, error{message},
//        info{...}, audio{locked}, stats{...}
import { Heartbeat } from './heartbeat.js';

export function canvasSupport() {
  if (typeof window === 'undefined') return { ok: false, reason: 'server' };
  const missing = [];
  if (!('VideoDecoder' in window)) missing.push('WebCodecs VideoDecoder');
  if (!('OffscreenCanvas' in window) || !HTMLCanvasElement.prototype.transferControlToOffscreen) missing.push('OffscreenCanvas');
  if (!window.isSecureContext) missing.push('secure context (HTTPS or localhost)');
  return { ok: missing.length === 0, missing, audio: 'AudioDecoder' in window && ('AudioContext' in window || 'webkitAudioContext' in window) };
}

const AUDIO_LEAD_S = 0.06; // scheduling headroom when starting the clock

export class CanvasEngine {
  constructor(canvas, emit) {
    this.emit = emit;
    this.gen = 0;
    this.volume = 1;
    this.muted = false;
    this.session = null;
    this.worker = new Worker(new URL('../../workers/player.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = e => this.onWorker(e.data);
    this.worker.onerror = e => this.emit('error', { message: `Worker error: ${e.message || 'failed to start'}`, fatal: true });
    const off = canvas.transferControlToOffscreen();
    this.worker.postMessage({ type: 'init', canvas: off }, [off]);
    this.resetState();
    this.tick = setInterval(() => this.onTick(), 100);
  }

  resetState(position = 0) {
    this.sources?.forEach(src => { try { src.stop(); } catch {} });
    this.clockStarted = false;
    this.sources = new Set();
    this.pendingAudio = [];
    this.position = position;     // media seconds while the clock is stopped
    this.running = false;         // clock advancing
    this.wantPlay = false;        // user intent
    this.ready = false;
    this.ended = false;
    this.buffering = false;
    this.audioEnd = 0;            // media time up to which audio is scheduled
    this.mode = 'wall';
  }

  // ---- audio -------------------------------------------------------------------------------
  // Must be called from a user gesture at least once so the AudioContext is allowed to run.
  unlockAudio() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC({ latencyHint: 'playback' });
      this.gain = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.gain.connect(this.analyser).connect(this.ctx.destination);
      this.applyVolume();
    }
    // A context the user never unlocked (autoplay policy). Paused audio-mode contexts are resumed by release().
    if (this.ctx.state !== 'running' && this.mode !== 'audio') {
      this.ctx.resume().then(() => {
        // Audio became available mid-playback: rebuild the segment with sound from the current position.
        if (this.mode === 'wall' && this.clockStarted && this.audioActive() && this.wantPlay) this.seek(this.currentTime(), true);
      }).catch(() => {});
    }
    return true;
  }

  audioActive() { return !!(this.ctx && this.session?.canvas?.hasAudio && this.hasAudioConfig); }

  applyVolume() { if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume; }

  // ---- clock -------------------------------------------------------------------------------
  currentTime() {
    if (!this.running) return this.position;
    if (this.mode === 'audio') return this.mediaStart + Math.max(0, this.ctx.currentTime - this.ctxStart);
    return this.mediaStart + (performance.now() - this.perfStart) / 1000;
  }

  // Starts the clock for a freshly opened segment at this.position.
  startClock() {
    const at = this.position;
    this.mediaStart = at;
    this.clockStarted = true;
    if (this.audioActive() && this.ctx.state === 'running') {
      this.mode = 'audio';
      this.ctxStart = this.ctx.currentTime + AUDIO_LEAD_S;
      this.audioEnd = at;
      const queued = this.pendingAudio; this.pendingAudio = [];
      queued.forEach(c => this.scheduleAudio(c));
    } else {
      this.mode = 'wall';
      this.perfStart = performance.now();
    }
    this.running = true;
    this.postClock();
    this.emitState();
  }

  // Pause/buffering hold. In audio mode the AudioContext is suspended, which freezes both its clock
  // and every scheduled buffer, so resuming is sample-accurate with no re-scheduling.
  hold() {
    if (!this.running) return;
    this.position = this.currentTime();
    this.running = false;
    if (this.mode === 'audio') {
      this.ctx.suspend().then(() => {
        // Re-anchor so the frozen context time maps exactly to the pause position.
        if (!this.running && this.mode === 'audio') this.ctxStart = this.ctx.currentTime - (this.position - this.mediaStart);
      }).catch(() => {});
    }
    this.postClock();
    this.emitState();
  }

  release() {
    if (this.running || !this.ready || this.ended) return;
    if (!this.clockStarted) return this.startClock();
    if (this.mode === 'audio') { this.ctx.resume().catch(() => {}); }
    else { this.mediaStart = this.position; this.perfStart = performance.now(); }
    this.running = true;
    this.postClock();
    this.emitState();
  }

  postClock() {
    let mediaTime = this.currentTime(), at = performance.timeOrigin + performance.now();
    if (this.running && this.mode === 'audio' && this.ctx.getOutputTimestamp) {
      // Map the moment audio is actually heard to wall time so video lines up with output latency.
      const ts = this.ctx.getOutputTimestamp();
      if (ts.performanceTime > 0) {
        mediaTime = this.mediaStart + (ts.contextTime - this.ctxStart);
        at = performance.timeOrigin + ts.performanceTime;
      }
    }
    this.worker.postMessage({ type: 'clock', gen: this.gen, mediaTime, at, rate: this.running ? 1 : 0 });
  }

  scheduleAudio(c) {
    const when = this.ctxStart + (c.time - this.mediaStart);
    const now = this.ctx.currentTime;
    if (when + c.duration <= now) return; // late: skip rather than drift
    const buf = this.ctx.createBuffer(c.planes.length, c.planes[0].length, c.sampleRate);
    c.planes.forEach((p, i) => buf.copyToChannel(p, i));
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    const offset = Math.max(0, now - when);
    src.start(Math.max(when, now), offset);
    src.onended = () => this.sources.delete(src);
    this.sources.add(src);
    this.audioEnd = Math.max(this.audioEnd, c.time + c.duration);
    this.audioScheduled = (this.audioScheduled || 0) + 1;
  }

  // ---- public API --------------------------------------------------------------------------
  async load(session, { startAt = 0, autoplay = true } = {}) {
    this.heartbeat?.stop();
    this.session = session;
    this.hasAudioConfig = false;
    this.resetState(startAt);
    this.wantPlay = autoplay;
    this.heartbeat = new Heartbeat(session, () => ({ position: this.currentTime(), state: this.wantPlay ? 'playing' : 'paused' }),
      () => this.emit('error', { message: 'Playback session expired. Reload to continue.', fatal: true }));
    this.emit('info', { player: 'canvas', duration: session.canvas.duration, hasAudio: session.canvas.hasAudio, transcoding: session.canvas.transcoding });
    this.open(startAt);
  }

  open(at) {
    this.gen++;
    this.ready = false;
    this.emit('state', { loading: true, playing: this.wantPlay, buffering: true, ended: false });
    const c = this.session.canvas;
    const url = at > 0 ? `${c.streamUrl}&t=${at.toFixed(3)}` : c.streamUrl;
    this.worker.postMessage({ type: 'open', url, startTime: c.startTime, seekTo: at, hasAudio: c.hasAudio && !!this.ctx });
  }

  play() {
    this.wantPlay = true;
    this.unlockAudio();
    if (this.ended || !this.session) return this.session && this.seek(0, true);
    this.wantPlay = true;
    if (!this.buffering) this.release();
    this.emitState();
  }

  pause() {
    this.wantPlay = false;
    this.hold();
    this.emitState();
  }

  seek(t, play = this.wantPlay || this.ended) {
    if (!this.session) return;
    const d = this.session.canvas.duration;
    t = Math.max(0, Math.min(Number(t) || 0, d ? d - 0.05 : Infinity));
    this.hold();
    this.ctx?.state === 'suspended' && this.ctx.resume().catch(() => {});
    this.resetState(t);
    this.wantPlay = play;
    this.segmentStart = t;
    this.open(t);
  }

  setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); this.applyVolume(); }
  setMuted(m) { this.muted = !!m; this.applyVolume(); }

  stop() {
    this.heartbeat?.stop(true);
    this.heartbeat = null;
    this.gen++;
    this.worker.postMessage({ type: 'stop' });
    this.hold();
    this.resetState(0);
    this.session = null;
  }

  destroy() {
    this.stop();
    clearInterval(this.tick);
    this.worker.terminate();
    this.ctx?.close().catch(() => {});
  }

  // Root-mean-square level of what is currently being played (for tests / VU meter).
  audioLevel() {
    if (!this.analyser) return 0;
    const a = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(a);
    return Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
  }

  // ---- worker events -----------------------------------------------------------------------
  onWorker(m) {
    if (m.gen !== this.gen) { return; }
    switch (m.type) {
      case 'audioConfig': this.hasAudioConfig = true; this.emit('info', { audio: m }); break;
      case 'videoConfig': this.emit('info', { video: m }); break;
      case 'tracks': this.emit('info', { tracks: m }); break;
      case 'audio':
        if (this.clockStarted && this.mode === 'audio') this.scheduleAudio(m);
        else if (this.ctx) { this.pendingAudio.push(m); if (this.pendingAudio.length > 2000) this.pendingAudio.shift(); }
        break;
      case 'ready':
        this.ready = true;
        this.emit('state', { loading: false });
        if (this.wantPlay) this.startClock(); else this.emitState();
        if (this.ctx?.state === 'suspended' && this.wantPlay) this.ctx.resume().catch(() => {});
        break;
      case 'buffered': this.emit('buffered', { from: this.segmentStart ?? 0, until: m.until, complete: !!m.complete }); break;
      case 'buffering':
        this.setBuffering(m.value);
        break;
      case 'frame': this.lastFrameTime = m.time; break;
      case 'stats': this.stats = m.stats; this.emit('stats', m.stats); break;
      case 'ended':
        this.endedAt = m.time;
        this.onEnded();
        break;
      case 'status': this.emit('status', { text: m.text }); break;
      case 'error': this.emit('error', { message: m.message, fatal: m.fatal }); if (m.fatal) { this.hold(); this.ready = false; } break;
    }
  }

  setBuffering(v) {
    if (v === this.buffering) return;
    this.buffering = v;
    if (v) this.hold();
    else if (this.wantPlay) this.release();
    this.emitState();
  }

  onEnded() {
    // Let scheduled audio finish before reporting the end.
    const wait = this.running && this.mode === 'audio' ? Math.max(0, this.audioEnd - this.currentTime()) * 1000 : 0;
    const g = this.gen;
    setTimeout(() => {
      if (g !== this.gen) return;
      this.hold();
      this.position = this.session?.canvas?.duration ?? this.position;
      this.ended = true;
      this.wantPlay = false;
      this.emitState();
      this.emit('ended', {});
    }, wait);
  }

  onTick() {
    if (!this.session) return;
    if (this.running) this.postClock();
    this.emit('time', { current: this.currentTime(), duration: this.session.canvas.duration });
  }

  emitState() {
    this.emit('state', { playing: this.wantPlay && !this.ended, running: this.running, buffering: this.buffering || (this.wantPlay && !this.ready && !this.ended), ended: this.ended, clockMode: this.mode, audioLocked: !!this.session?.canvas?.hasAudio && this.ctx?.state !== 'running' });
  }
}
