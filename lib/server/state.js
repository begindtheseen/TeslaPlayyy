// Next.js compiles each API route into its own bundle, so module-level singletons are not shared
// between routes. Keep process-wide state on globalThis instead.
export function shared(key, init) {
  const root = (globalThis.__canvasTube ??= {});
  if (!(key in root)) root[key] = init();
  return root[key];
}

export const envInt = (name, fallback) => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
