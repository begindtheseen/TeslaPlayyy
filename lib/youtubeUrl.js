// Extracts a YouTube video id from a pasted link or bare id. Returns null for anything else.
const ID = /^[A-Za-z0-9_-]{11}$/;
export function parseYouTubeInput(raw) {
  const s = String(raw || '').trim();
  if (ID.test(s)) return s;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v') || (/^\/(shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname) || [])[2];
  }
  return id && ID.test(id) ? id : null;
}
