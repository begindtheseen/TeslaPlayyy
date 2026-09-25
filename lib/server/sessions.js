// In-memory playback sessions. Single-process only; use a shared store (Redis etc.) when scaling out.
import { randomBytes } from 'node:crypto';
import { shared, envInt } from './state.js';

const store = () => shared('sessions', () => new Map());
export const ttlMs = () => envInt('SESSION_TTL_SECONDS', 60) * 1000;
export const heartbeatIntervalMs = () => Math.max(5000, Math.floor(ttlMs() / 3));

export function createSession(data) {
  sweep();
  const max = envInt('MAX_SESSIONS', 500);
  if (store().size >= max) throw Object.assign(new Error('Too many active sessions'), { status: 503 });
  const id = randomBytes(18).toString('base64url');
  const now = Date.now();
  const s = { id, createdAt: now, lastSeen: now, expiresAt: now + ttlMs(), position: 0, state: 'created', streams: new Set(), ...data };
  store().set(id, s);
  return s;
}

export function getSession(id) {
  if (typeof id !== 'string' || id.length > 64) return null;
  const s = store().get(id);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { closeSession(id); return null; }
  return s;
}

export function touchSession(id, { position, state } = {}) {
  const s = getSession(id);
  if (!s) return null;
  s.lastSeen = Date.now();
  s.expiresAt = s.lastSeen + ttlMs();
  if (Number.isFinite(position)) s.position = position;
  if (typeof state === 'string') s.state = state.slice(0, 16);
  return s;
}

// Aborts any running FFmpeg streams belonging to the session.
export function closeSession(id) {
  const s = store().get(id);
  if (!s) return false;
  for (const ac of s.streams) ac.abort();
  store().delete(id);
  return true;
}

export function sweep() {
  const now = Date.now();
  for (const [id, s] of store()) if (s.expiresAt < now) closeSession(id);
}

export const sessionCount = () => store().size;

// Background sweep so abandoned sessions release FFmpeg processes even without new traffic.
shared('sessionSweeper', () => { const t = setInterval(sweep, 10000); t.unref?.(); return t; });
