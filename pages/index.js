import { useCallback, useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import Player from '../components/Player.js';
import { parseYouTubeInput } from '../lib/youtubeUrl.js';
import { detectPlatform } from '../lib/player/platform.js';

async function createSession(source) {
  const r = await fetch('/api/playback/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || `Session request failed (${r.status})`), { code: d.code, retryable: d.retryable || r.status === 429 || r.status >= 500 });
  return d;
}

const DELIVERY_LABEL = { muxed: 'server-muxed MPEG-TS (single stream)', dual: 'DASH video + audio (range proxy)' };
const load = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

export default function Home() {
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [status, setStatus] = useState('Ready');
  const [selected, setSelected] = useState(null);
  const [platform, setPlatform] = useState(null);
  const [delivery, setDelivery] = useState('auto');
  const [quality, setQuality] = useState('auto');
  const [playing, setPlaying] = useState(null); // {source, label, session}
  const player = useRef(null);

  useEffect(() => {
    fetch('/api/media/catalog').then(r => r.json()).then(d => setCatalog(d.items || [])).catch(() => {});
    setPlatform(detectPlatform());
    setDelivery(load('ct.delivery', 'auto')); setQuality(load('ct.quality', 'auto'));
  }, []);

  const onStatus = useCallback(t => setStatus(t), []);

  // YouTube requests carry the delivery choice: user override, else the capability probe.
  function withPrefs(source, d = delivery, qy = quality) {
    if (source.kind !== 'youtube') return source;
    const p = platform || detectPlatform();
    return { ...source, delivery: d === 'auto' ? p.delivery : d, maxHeight: qy === 'auto' ? p.maxHeight : Number(qy), maxFps: p.maxFps };
  }

  async function start(source, label, { startAt = 0, d, qy } = {}) {
    player.current?.prepare(); // unlock Web Audio inside the user gesture
    setSelected(source.kind === 'youtube' ? source.videoId : source.id);
    setStatus(`Opening ${label}…`);
    try {
      const s = await createSession(withPrefs(source, d, qy));
      setPlaying({ source, label, session: s });
      setStatus(s.canvas?.delivery ? `Streaming via ${DELIVERY_LABEL[s.canvas.delivery]}` : 'Streaming MPEG-TS into the canvas player');
      await player.current?.play(s, { startAt });
    } catch (e) {
      setPlaying(null);
      setStatus(e.message);
      player.current?.fail(e.message, source.title || label, { code: e.code, onRetry: e.retryable ? () => start(source, label) : null });
    }
  }

  // Changing delivery/quality while a YouTube video plays restarts it at the same position.
  function changePref(kind, value) {
    if (kind === 'delivery') { setDelivery(value); save('ct.delivery', value); } else { setQuality(value); save('ct.quality', value); }
    if (playing?.source.kind === 'youtube') {
      const at = player.current?.currentTime() || 0;
      start(playing.source, playing.label, { startAt: at, d: kind === 'delivery' ? value : delivery, qy: kind === 'quality' ? value : quality });
    }
  }

  async function search(e) {
    e.preventDefault();
    if (!q.trim()) return;
    // A pasted YouTube link or id plays immediately (no API key needed).
    const id = parseYouTubeInput(q);
    if (id) return start({ kind: 'youtube', videoId: id }, 'YouTube video');
    setSearching(true); setSearchError(null); setStatus('Searching…');
    try {
      const r = await fetch('/api/youtube/search?query=' + encodeURIComponent(q.trim()));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Search failed (${r.status})`);
      setItems(d.items || []);
      setStatus(`${(d.items || []).length} results`);
    } catch (err) { setItems([]); setSearchError(err.message); setStatus(err.message); }
    finally { setSearching(false); }
  }

  return (
    <>
      <Head>
        <title>CanvasTube</title>
        <meta name="viewport" content="width=device-width,initial-scale=1" />
      </Head>
      <main>
        <header>
          <b>CanvasTube</b>
          <span>YouTube search · MPEG-TS → WebCodecs → OffscreenCanvas player</span>
        </header>

        <Player ref={player} onStatus={onStatus} />
        <div className="status" role="status" aria-live="polite" data-testid="status">{status}</div>

        <div className="prefs" role="group" aria-label="YouTube playback settings">
          <label>Delivery
            <select value={delivery} onChange={e => changePref('delivery', e.target.value)} data-testid="pref-delivery">
              <option value="auto">Auto{platform ? ` (${platform.delivery === 'muxed' ? 'muxed' : 'dual'})` : ''}</option>
              <option value="muxed">Muxed · one stream (Intel)</option>
              <option value="dual">Dual · DASH tracks (AMD)</option>
            </select>
          </label>
          <label>Quality
            <select value={quality} onChange={e => changePref('quality', e.target.value)} data-testid="pref-quality">
              <option value="auto">Auto (≤{platform?.maxHeight || 1080}p{platform?.maxFps === 30 ? '30' : ''})</option>
              {[1080, 720, 480, 360].map(h => <option key={h} value={h}>{h}p</option>)}
            </select>
          </label>
          {platform && <small className="probe" data-testid="platform">{platform.reason}{platform.gpu ? ` · ${platform.gpu.slice(0, 48)}` : ''}</small>}
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <button onClick={() => start({ kind: 'catalog', id: 'demo' }, 'Demo video')} data-testid="demo-btn" style={{ padding: '0.5rem 1rem', fontSize: '1rem', marginRight: '0.5rem' }}>
            ▶ Play demo
          </button>
          <span style={{ color: '#999', fontSize: '0.9rem' }}>5s test pattern (H.264 MPEG-TS, canvas-only)</span>
        </div>

        <form onSubmit={search} role="search">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search YouTube or paste a YouTube link" aria-label="Search YouTube or paste a YouTube link" maxLength={100} data-testid="search-input" />
          <button disabled={searching} data-testid="search-btn">{searching ? 'Searching…' : 'Search'}</button>
        </form>

        {searchError && <div className="notice error" role="alert" data-testid="search-error">{searchError}{/API key|quota/i.test(searchError) && <><br />You can still paste any YouTube link above to play it.</>}</div>}

        <section className="results" aria-busy={searching} data-testid="results">
          {searching && Array.from({ length: 6 }, (_, i) => <div key={i} className="result skeleton" aria-hidden />)}
          {!searching && items.map(v => (
            <button className={`result ${selected === v.id.videoId ? 'selected' : ''}`} key={v.id.videoId} data-testid="result"
              onClick={() => start({ kind: 'youtube', videoId: v.id.videoId, title: v.snippet.title }, v.snippet.title)}>
              <img src={v.snippet.thumbnails.medium.url} alt="" loading="lazy" />
              <span>
                <strong>{v.snippet.title}</strong>
                <small>{v.snippet.channelTitle}</small>
                <em className="tag yt">YouTube</em>
              </span>
            </button>
          ))}
        </section>

        <h2>Licensed & test streams</h2>
        <p className="hint">Everything plays through CanvasTube’s own engine: MPEG-TS → worker demux → WebCodecs → OffscreenCanvas + Web Audio. No &lt;video&gt; element, no iframe.</p>
        <section className="results" data-testid="catalog">
          {catalog.map(a => (
            <button className={`result catalog ${selected === a.id ? 'selected' : ''}`} key={a.id} data-testid={`asset-${a.id}`}
              onClick={() => start({ kind: 'catalog', id: a.id }, a.title)}>
              <span className="thumb" aria-hidden>▶</span>
              <span>
                <strong>{a.title}</strong>
                {a.license && <small>{a.license}</small>}
                <em className="tag canvas">Canvas player</em>
              </span>
            </button>
          ))}
        </section>
      </main>
    </>
  );
}
