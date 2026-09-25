// Authorized media catalog. Only assets listed here can be streamed to the canvas player.
// Sources: built-in synthetic fixtures + an optional operator JSON file (MEDIA_CATALOG_FILE).
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const MEDIA_DIR = path.join(process.cwd(), 'public', 'media');

const BUILTIN = [
  { id: 'demo', title: 'Synthetic test pattern (video only, 5 s)', source: 'local:demo.ts', license: 'Original synthetic fixture bundled with CanvasTube' },
  { id: 'demo-av', title: 'Synthetic A/V sync test (10 s, 1 kHz beep each second)', source: 'local:demo-av.ts', license: 'Original synthetic fixture bundled with CanvasTube' },
  { id: 'demo-av-mp4', title: 'Synthetic A/V test from MP4 (remuxed to MPEG-TS on the fly)', source: 'local:demo-av.mp4', license: 'Original synthetic fixture bundled with CanvasTube' },
];

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function loadOperatorCatalog() {
  const file = process.env.MEDIA_CATALOG_FILE;
  if (!file) return [];
  const full = path.resolve(process.cwd(), file);
  if (!existsSync(full)) { console.warn(`[catalog] MEDIA_CATALOG_FILE not found: ${full}`); return []; }
  const parsed = JSON.parse(readFileSync(full, 'utf8'));
  const assets = Array.isArray(parsed) ? parsed : parsed.assets || [];
  return assets.filter(a => {
    const ok = a && ID_RE.test(a.id) && typeof a.source === 'string' && typeof a.title === 'string';
    if (!ok) console.warn('[catalog] skipping invalid entry', a?.id);
    return ok;
  });
}

let cache = null, cacheKey = '';
export function catalog() {
  const key = `${process.env.MEDIA_CATALOG_FILE || ''}`;
  if (!cache || key !== cacheKey) {
    cacheKey = key;
    const byId = new Map();
    for (const a of [...BUILTIN, ...loadOperatorCatalog()]) byId.set(a.id, a);
    cache = byId;
  }
  return cache;
}

export function getAsset(id) {
  if (!ID_RE.test(String(id))) return null;
  return catalog().get(String(id)) || null;
}

// YouTube video ids for which the operator holds a separately licensed media file, e.g. the
// creator's own master upload. Format: YOUTUBE_AUTHORIZED_MAP="videoId=assetId,videoId2=assetId2".
export function authorizedAssetForYouTube(videoId) {
  for (const pair of (process.env.YOUTUBE_AUTHORIZED_MAP || '').split(',')) {
    const [vid, asset] = pair.split('=').map(s => s?.trim());
    if (vid && asset && vid === videoId) return getAsset(asset);
  }
  return null;
}

// Resolves a catalog source to something FFmpeg can open. Local paths are confined to public/media.
export function resolveSource(asset) {
  if (asset.source.startsWith('local:')) {
    const rel = asset.source.slice(6);
    const full = path.resolve(MEDIA_DIR, rel);
    if (!full.startsWith(MEDIA_DIR + path.sep)) throw new Error('Local media path escapes public/media');
    return { kind: 'local', path: full };
  }
  if (/^https?:\/\//.test(asset.source)) return { kind: 'remote', url: asset.source };
  throw new Error(`Unsupported media source for ${asset.id}`);
}

export const publicAsset = a => ({ id: a.id, title: a.title, license: a.license || null, thumbnail: a.thumbnail || null });
