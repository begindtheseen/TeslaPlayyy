// Official YouTube IFrame Player API adapter exposing the same interface as CanvasEngine.
// https://developers.google.com/youtube/iframe_api_reference
// YouTube renders and streams the video inside its own iframe; CanvasTube only sends commands.
import { Heartbeat } from './heartbeat.js';

const ERRORS = {
  2: 'Invalid video ID.',
  5: 'This video cannot be played in an HTML5 player.',
  100: 'Video not found, removed, or private.',
  101: 'The owner does not allow this video to be played in embedded players.',
  150: 'The owner does not allow this video to be played in embedded players.',
  153: 'YouTube rejected the embed request (missing referrer/origin).',
};

let apiPromise = null;
export function loadIframeApi(src = 'https://www.youtube.com/iframe_api') {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const tag = document.createElement('script');
    tag.src = src;
    tag.async = true;
    tag.onerror = () => { apiPromise = null; reject(new Error('Could not load the YouTube IFrame API (network or content blocker).')); };
    document.head.appendChild(tag);
    setTimeout(() => { if (!window.YT?.Player) { apiPromise = null; reject(new Error('Timed out loading the YouTube IFrame API.')); } }, 15000);
  });
  return apiPromise;
}

export class YouTubeEngine {
  constructor(host, emit) {
    this.host = host;   // element that the iframe replaces
    this.emit = emit;
    this.volume = 1;
    this.muted = false;
    this.player = null;
    this.session = null;
  }

  async load(session, { startAt = 0, autoplay = true } = {}) {
    this.stop();
    this.session = session;
    const videoId = session.youtube.videoId;
    this.emit('info', { player: 'youtube-iframe', duration: null, hasAudio: true });
    this.emit('state', { loading: true, playing: autoplay, buffering: true, ended: false });
    let YT;
    try { YT = await loadIframeApi(); }
    catch (e) { this.emit('error', { message: e.message, fatal: true }); return; }
    if (this.session !== session) return;
    this.heartbeat = new Heartbeat(session, () => ({ position: this.currentTime(), state: this.lastState || 'loading' }), () => {});
    const mount = document.createElement('div');
    this.host.replaceChildren(mount);
    this.player = new YT.Player(mount, {
      videoId,
      width: '100%', height: '100%',
      playerVars: { autoplay: autoplay ? 1 : 0, playsinline: 1, rel: 0, start: Math.floor(startAt), origin: window.location.origin, enablejsapi: 1 },
      events: {
        onReady: () => {
          if (this.session !== session) return;
          this.applyVolume();
          this.emit('state', { loading: false });
          this.emit('info', { duration: this.player.getDuration?.() || null });
          if (autoplay) this.player.playVideo();
        },
        onStateChange: e => this.onState(e.data),
        onError: e => this.emit('error', { message: ERRORS[e.data] || `YouTube player error ${e.data}`, fatal: true, code: e.data }),
      },
    });
    this.poll = setInterval(() => this.onTick(), 250);
  }

  onState(state) {
    const S = window.YT.PlayerState;
    this.lastState = { [S.PLAYING]: 'playing', [S.PAUSED]: 'paused', [S.BUFFERING]: 'buffering', [S.ENDED]: 'ended', [S.CUED]: 'cued' }[state] || 'unstarted';
    this.emit('state', { loading: false, playing: state === S.PLAYING || state === S.BUFFERING, buffering: state === S.BUFFERING, ended: state === S.ENDED, running: state === S.PLAYING });
    if (state === S.ENDED) this.emit('ended', {});
  }

  onTick() {
    const p = this.player;
    if (!p?.getCurrentTime) return;
    const duration = p.getDuration?.() || null;
    this.emit('time', { current: p.getCurrentTime(), duration });
    const frac = p.getVideoLoadedFraction?.();
    if (duration && Number.isFinite(frac)) this.emit('buffered', { from: 0, until: frac * duration });
  }

  currentTime() { return this.player?.getCurrentTime?.() || 0; }
  unlockAudio() { return true; }
  play() { this.player?.playVideo?.(); }
  pause() { this.player?.pauseVideo?.(); }
  seek(t) { this.player?.seekTo?.(Math.max(0, t), true); }
  setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); this.applyVolume(); }
  setMuted(m) { this.muted = !!m; this.applyVolume(); }
  applyVolume() {
    const p = this.player;
    if (!p?.setVolume) return;
    p.setVolume(Math.round(this.volume * 100));
    this.muted ? p.mute() : p.unMute();
  }

  stop() {
    clearInterval(this.poll);
    this.heartbeat?.stop(true);
    this.heartbeat = null;
    try { this.player?.destroy?.(); } catch {}
    this.player = null;
    this.session = null;
    this.host?.replaceChildren();
  }

  destroy() { this.stop(); }
}
