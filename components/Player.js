import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { CanvasEngine, canvasSupport } from '../lib/player/CanvasEngine.js';
import { YouTubeEngine } from '../lib/player/YouTubeEngine.js';

const fmt = s => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(x).padStart(2, '0')}`;
};

const INITIAL = { playing: false, buffering: false, loading: false, ended: false, current: 0, duration: null, bufferedFrom: 0, bufferedUntil: 0, error: null, audioLocked: false, clockMode: null };

// One shell, two engines. The session's `player` field decides which engine renders.
const Player = forwardRef(function Player({ onStatus }, ref) {
  const shell = useRef(null), canvas = useRef(null), ytHost = useRef(null);
  const engines = useRef({ canvas: null, youtube: null });
  const active = useRef(null);
  const [kind, setKind] = useState(null);
  const [st, setSt] = useState(INITIAL);
  const [meta, setMeta] = useState({});
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [scrub, setScrub] = useState(null);
  const [support, setSupport] = useState({ ok: true });
  const lastTap = useRef(0);

  const emit = useCallback(which => (type, d) => {
    if (active.current !== which) return;
    if (type === 'state') setSt(s => ({ ...s, ...d, error: d.loading ? null : s.error }));
    else if (type === 'time') setSt(s => ({ ...s, current: d.current, duration: d.duration ?? s.duration }));
    else if (type === 'buffered') setSt(s => ({ ...s, bufferedFrom: d.from, bufferedUntil: d.until }));
    else if (type === 'error') { setSt(s => ({ ...s, error: d.message, buffering: false, loading: false })); onStatus?.(`Player error: ${d.message}`); }
    else if (type === 'info') setMeta(m => ({ ...m, ...d }));
    else if (type === 'status') onStatus?.(d.text);
    else if (type === 'ended') onStatus?.('Playback ended');
    else if (type === 'stats') window.__canvasTube && (window.__canvasTube.stats = d);
  }, [onStatus]);

  useEffect(() => {
    const sup = canvasSupport();
    setSupport(sup);
    if (sup.ok) engines.current.canvas = new CanvasEngine(canvas.current, emit('canvas'));
    engines.current.youtube = new YouTubeEngine(ytHost.current, emit('youtube'));
    window.__canvasTube = { engines: engines.current, active: () => active.current };
    const e = engines.current;
    return () => { e.canvas?.destroy(); e.youtube?.destroy(); };
  }, [emit]);

  const engine = () => engines.current[active.current];

  useImperativeHandle(ref, () => ({
    // Must be called synchronously inside the click handler so audio can be unlocked by the gesture.
    prepare() { engines.current.canvas?.unlockAudio(); },
    async play(session) {
      const which = session.player === 'canvas' ? 'canvas' : 'youtube';
      if (which === 'canvas' && !engines.current.canvas) {
        const msg = `This browser cannot run the canvas player (missing: ${support.missing?.join(', ')}).`;
        setSt({ ...INITIAL, error: msg }); onStatus?.(msg); return;
      }
      for (const [k, e] of Object.entries(engines.current)) if (k !== which && e?.session) e.stop();
      active.current = which;
      setKind(which);
      setMeta({ title: session.title, notice: session.notice, player: session.player });
      setSt({ ...INITIAL, loading: true, playing: true, duration: session.canvas?.duration ?? null });
      engine().setVolume(volume); engine().setMuted(muted);
      await engine().load(session, { autoplay: true });
    },
    stop() { engine()?.stop(); active.current = null; setKind(null); setSt(INITIAL); },
  }), [volume, muted, support, onStatus]);

  const toggle = useCallback(() => {
    const e = engine(); if (!e) return;
    if (st.playing && !st.ended) e.pause(); else e.play();
  }, [st.playing, st.ended]);
  const seekBy = useCallback(d => { const e = engine(); if (e) e.seek(Math.max(0, (e.currentTime?.() ?? st.current) + d)); }, [st.current]);
  const changeVolume = useCallback(v => { setVolume(v); setMuted(v === 0); engine()?.setVolume(v); engine()?.setMuted(v === 0); }, []);
  const toggleMute = useCallback(() => { setMuted(m => { engine()?.setMuted(!m); return !m; }); }, []);
  const fullscreen = useCallback(() => {
    const el = shell.current;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
  }, []);

  useEffect(() => {
    const onKey = e => {
      if (!active.current || e.target.closest?.('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const map = { ' ': toggle, k: toggle, j: () => seekBy(-10), l: () => seekBy(10), arrowleft: () => seekBy(-5), arrowright: () => seekBy(5),
        m: toggleMute, f: fullscreen, arrowup: () => changeVolume(Math.min(1, volume + 0.1)), arrowdown: () => changeVolume(Math.max(0, volume - 0.1)) };
      if (map[k] && !(k === ' ' && e.target.tagName === 'BUTTON')) { e.preventDefault(); map[k](); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, seekBy, toggleMute, fullscreen, changeVolume, volume]);

  // Touch: tap toggles play, double-tap on the left/right third seeks ±10 s (canvas surface only;
  // the YouTube iframe handles its own gestures).
  const onSurfacePointer = e => {
    if (kind !== 'canvas') return;
    const now = Date.now();
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (now - lastTap.current < 300) { clearTimeout(onSurfacePointer.t); if (x < 0.33) seekBy(-10); else if (x > 0.67) seekBy(10); lastTap.current = 0; }
    else { lastTap.current = now; onSurfacePointer.t = setTimeout(toggle, 300); }
  };

  const dur = st.duration || 0;
  const shown = scrub ?? st.current;
  const pct = v => (dur ? Math.max(0, Math.min(100, (v / dur) * 100)) : 0);
  const badge = kind === 'canvas' ? 'Canvas · WebCodecs' : kind === 'youtube' ? 'YouTube IFrame Player' : null;

  return (
    <div className="player-wrap">
      <div className={`player ${kind || 'idle'}`} ref={shell} data-testid="player" data-player={kind || 'none'}
        data-playing={String(st.playing)} data-buffering={String(st.buffering)} data-ended={String(st.ended)}>
        <canvas ref={canvas} className="surface" hidden={kind !== 'canvas'} aria-label="Video (canvas player)" data-testid="canvas" onPointerUp={onSurfacePointer} />
        <div ref={ytHost} className="yt-host" hidden={kind !== 'youtube'} data-testid="yt-host" />
        {!kind && (
          <div className="overlay idle-msg">
            <p>Search YouTube or pick an authorized stream below.</p>
            {!support.ok && <p className="warn">Canvas player unavailable here: missing {support.missing?.join(', ')}. YouTube playback still works.</p>}
          </div>
        )}
        {kind && (st.loading || st.buffering) && !st.error && <div className="overlay pointer-none" role="status" aria-live="polite"><div className="spinner" aria-hidden /><span className="sr-only">Buffering</span></div>}
        {st.error && (
          <div className="overlay error" role="alert" data-testid="player-error">
            <strong>Can’t play this</strong><p>{st.error}</p>
          </div>
        )}
        {badge && <span className={`badge ${kind}`} data-testid="player-badge">{badge}</span>}
      </div>

      {kind && (
        <div className="controls" role="group" aria-label="Playback controls">
          <button onClick={toggle} aria-label={st.playing && !st.ended ? 'Pause' : 'Play'} data-testid="btn-play">{st.playing && !st.ended ? '❚❚' : st.ended ? '↻' : '▶'}</button>
          <button onClick={() => seekBy(-10)} aria-label="Back 10 seconds">↶10</button>
          <button onClick={() => seekBy(10)} aria-label="Forward 10 seconds">10↷</button>
          <span className="time" data-testid="time">{fmt(shown)} / {dur ? fmt(dur) : '--:--'}</span>
          <div className="seek">
            <div className="seek-buffer" style={{ left: `${pct(st.bufferedFrom)}%`, width: `${Math.max(0, pct(st.bufferedUntil) - pct(st.bufferedFrom))}%` }} />
            <input type="range" min={0} max={dur || 1} step={0.1} value={Math.min(shown, dur || 1)} aria-label="Seek" disabled={!dur} data-testid="seek"
              style={{ '--pct': `${pct(shown)}%` }}
              onChange={e => setScrub(Number(e.target.value))}
              onPointerUp={e => { engine()?.seek(Number(e.target.value)); setScrub(null); }}
              onKeyUp={e => { if (scrub !== null) { engine()?.seek(scrub); setScrub(null); } }} />
          </div>
          <button onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'} data-testid="btn-mute">{muted || volume === 0 ? '🔇' : '🔊'}</button>
          <input className="vol" type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label="Volume" data-testid="volume" onChange={e => changeVolume(Number(e.target.value))} />
          <button onClick={fullscreen} aria-label="Fullscreen">⛶</button>
        </div>
      )}
      {kind && (meta.title || meta.notice) && (
        <div className="now-playing">
          {meta.title && <strong data-testid="now-title">{meta.title}</strong>}
          {meta.notice && <small data-testid="player-notice">{meta.notice}</small>}
          {kind === 'canvas' && st.audioLocked && <small className="warn">Audio is locked by the browser. Press play to enable sound.</small>}
        </div>
      )}
    </div>
  );
});

export default Player;
