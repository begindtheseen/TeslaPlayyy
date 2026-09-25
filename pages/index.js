import { useCallback, useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import Player from '../components/Player.js';
import { parseYouTubeInput } from '../lib/youtubeUrl.js';

async function createSession(source) {
  const r = await fetch('/api/playback/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Session request failed (${r.status})`);
  return d;
}

export default function Home() {
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [status, setStatus] = useState('Ready');
  const [selected, setSelected] = useState(null);
  const player = useRef(null);

  useEffect(() => {
    fetch('/api/media/catalog').then(r => r.json()).then(d => setCatalog(d.items || [])).catch(() => {});
  }, []);

  const onStatus = useCallback(t => setStatus(t), []);

  async function start(source, label) {
    player.current?.prepare(); // unlock Web Audio inside the user gesture
    setSelected(source.kind === 'youtube' ? source.videoId : source.id);
    setStatus(`Opening ${label}…`);
    try {
      const s = await createSession(source);
      setStatus(s.player === 'canvas' ? 'Streaming MPEG-TS into the canvas player' : 'Playing through the official YouTube player');
      await player.current?.play(s);
    } catch (e) { setStatus(e.message); }
  }

  async function search(e) {
    e.preventDefault();
    if (!q.trim()) return;
    // A pasted YouTube link or id plays immediately (no API key needed).
    const id = parseYouTubeInput(q);
    if (id) return start({ kind: 'youtube', videoId: id, prefer: 'canvas' }, 'YouTube video');
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
          <span>YouTube search · official YouTube player · custom WebCodecs canvas player for authorized streams</span>
        </header>

        <Player ref={player} onStatus={onStatus} />
        <div className="status" role="status" aria-live="polite" data-testid="status">{status}</div>

        <form onSubmit={search} role="search">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search YouTube or paste a YouTube link" aria-label="Search YouTube or paste a YouTube link" maxLength={100} data-testid="search-input" />
          <button disabled={searching} data-testid="search-btn">{searching ? 'Searching…' : 'Search'}</button>
        </form>

        {searchError && <div className="notice error" role="alert" data-testid="search-error">{searchError}{/API key|quota/i.test(searchError) && <><br />You can still paste any YouTube link above to play it.</>}</div>}

        <section className="results" aria-busy={searching} data-testid="results">
          {searching && Array.from({ length: 6 }, (_, i) => <div key={i} className="result skeleton" aria-hidden />)}
          {!searching && items.map(v => (
            <button className={`result ${selected === v.id.videoId ? 'selected' : ''}`} key={v.id.videoId} data-testid="result"
              onClick={() => start({ kind: 'youtube', videoId: v.id.videoId, title: v.snippet.title, prefer: 'canvas' }, v.snippet.title)}>
              <img src={v.snippet.thumbnails.medium.url} alt="" loading="lazy" />
              <span>
                <strong>{v.snippet.title}</strong>
                <small>{v.snippet.channelTitle}</small>
                <em className="tag yt">YouTube player</em>
              </span>
            </button>
          ))}
        </section>

        <h2>Authorized streams · canvas player</h2>
        <p className="hint">These play through CanvasTube’s own engine: MPEG-TS → worker demux → WebCodecs → OffscreenCanvas + Web Audio. No &lt;video&gt; element, no iframe.</p>
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
